// ============================================================
//  midi-parser.test.mjs — src/midi/midiParser.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟 test/browser/smoke-test.mjs 同一套風格：run()／assert() 是整個專案
//  唯一的測試慣例。用法：node test/unit/midi-parser.test.mjs
// ============================================================

import { parseMidi } from '../../src/midi/midiParser.js';

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── 手工組一個最小 MIDI 檔的工具：header + 一或多軌，每軌是 [tick, bytes...] 事件清單 ──
function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function u16(n) { return [(n >>> 8) & 0xff, n & 0xff]; }
function vlq(n) {
  const bytes = [n & 0x7f]; n >>>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>>= 7; }
  return bytes;
}
function track(events) {
  const body = [];
  for (const e of events) { body.push(...vlq(e.deltaTick)); body.push(...e.bytes); }
  body.push(...vlq(0), 0xff, 0x2f, 0x00); // End of Track
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]; // "MTrk"
}
function midiFile(tracks, { division = 480, format = 1 } = {}) {
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division)];
  return new Uint8Array([...header, ...tracks.flat()]);
}

// ── program／bank 依時間軸查詢（不是依軌道處理順序）──
// 修正對象：collectNotes()／collectParts() 曾經把 currentProgram 依「檔案裡的軌序」逐軌
// 處理，讀到的是「前面各軌處理完畢時留下的值」，不是「這顆音那個時間點該有的值」。

run('情境 A：音符在無 PC 的軌、PC 在另一軌——依時間軸查詢，不是依軌序', () => {
  const trackNotes = track([
    { deltaTick: 480, bytes: [0x90, 60, 100] }, // tick 480: note on C4, ch0（無 PC）
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackPC = track([{ deltaTick: 0, bytes: [0xc0, 40] }]); // tick 0: PC 40, ch0
  const parsed = parseMidi(midiFile([trackNotes, trackPC]));
  assert(parsed.notes.length === 1, `預期 1 顆音符，實際 ${parsed.notes.length}`);
  assert(parsed.notes[0].program === 40, `依時間軸查詢應該是 program 40，實際 ${parsed.notes[0].program}`);
});

run('情境 B：同一 channel 兩次 PC，音符夾在中間', () => {
  const trackNotes = track([
    { deltaTick: 480, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackPC = track([
    { deltaTick: 0, bytes: [0xc0, 40] },
    { deltaTick: 960, bytes: [0xc0, 41] },
  ]);
  const parsed = parseMidi(midiFile([trackNotes, trackPC]));
  assert(parsed.notes.length === 1, `預期 1 顆音符`);
  assert(parsed.notes[0].program === 40, `音符落在 PC40 之後、PC41 之前，應該是 40，實際 ${parsed.notes[0].program}`);
});

run("情境 B'：自己軌自己送過 PC 時優先採用，不查全曲時間軸", () => {
  const trackA = track([
    { deltaTick: 0, bytes: [0xc0, 5] },
    { deltaTick: 480, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackB = track([{ deltaTick: 0, bytes: [0xc0, 99] }]); // 同 channel，不該影響 A
  const parsed = parseMidi(midiFile([trackA, trackB]));
  assert(parsed.notes.length === 1, '預期 1 顆音符');
  assert(parsed.notes[0].program === 5, `自己軌的 PC5 應該優先，實際 ${parsed.notes[0].program}`);
});

// ── running status 寬鬆讀取 ──
// 修正對象：parseTrack() 曾經在遇到 meta／SysEx 事件後把 runningStatus 清成 0，
// 導致緊接著沿用 running status 的檔案被整軌截斷。

run('情境 C：running status 跨過 meta 事件仍能正確讀取，不再截斷整軌', () => {
  const trackNotes = track([
    { deltaTick: 0, bytes: [0x90, 60, 100] },
    { deltaTick: 10, bytes: [0xff, 0x01, 0x03, 0x61, 0x62, 0x63] }, // FF01 文字事件
    { deltaTick: 10, bytes: [62, 100] },  // note on D4，沿用 running status
    { deltaTick: 480, bytes: [60, 0] },   // note off C4，沿用 running status
    { deltaTick: 0, bytes: [62, 0] },     // note off D4，沿用 running status
  ]);
  const parsed = parseMidi(midiFile([trackNotes]));
  assert(parsed.notes.length === 2, `預期 2 顆音符（C4、D4），實際 ${parsed.notes.length}`);
  const pitches = parsed.notes.map((n) => n.note).sort();
  assert(pitches[0] === 60 && pitches[1] === 62, `音高應該是 60、62，實際 ${pitches}`);
  const hasWarning = parsed.warnings.some((w) => w.includes('running status 沿用跨過了'));
  assert(hasWarning, '應該要有一則「running status 沿用跨過了 meta／SysEx」的警告');
  const warnCount = parsed.warnings.filter((w) => w.includes('running status 沿用跨過了')).length;
  assert(warnCount === 1, `這則警告每軌只該出現一次，實際 ${warnCount} 次`);
});

run('情境 D：一般 running status 沿用（沒有穿過 meta）不會誤發警告', () => {
  const trackNotes = track([
    { deltaTick: 0, bytes: [0x90, 60, 100] },
    { deltaTick: 480, bytes: [60, 0] },
    { deltaTick: 0, bytes: [62, 100] },
    { deltaTick: 480, bytes: [62, 0] },
  ]);
  const parsed = parseMidi(midiFile([trackNotes]));
  assert(parsed.notes.length === 2, '預期 2 顆音符');
  assert(!parsed.warnings.some((w) => w.includes('running status 沿用跨過了')), '正常沿用不該觸發警告');
});

// ── 鼓組退回警告：不再斷言一定會退回 Standard Kit ──

run('鼓組非標準 program 的警告不再斷言會退回 Standard Kit', () => {
  const trackDrum = track([
    { deltaTick: 0, bytes: [0xb0, 0, 120] }, // ch0 Bank Select MSB=120（節奏 bank）
    { deltaTick: 0, bytes: [0xc0, 1] },      // ch0 PC=1（不是 GM_DRUM_KITS 裡的標準編號）
    { deltaTick: 0, bytes: [0x90, 36, 100] },
    { deltaTick: 480, bytes: [36, 0] },
  ]);
  const parsed = parseMidi(midiFile([trackDrum]));
  const w = parsed.warnings.find((x) => x.includes('鼓組 program'));
  assert(w, '應該要有鼓組相關警告');
  assert(!w.includes('會退回播放 Standard Kit'), `警告不該再斷言「會退回播放 Standard Kit」：${w}`);
  assert(w.includes('取決於載入的 SoundFont'), `警告應該改成中性措辭：${w}`);
});

// ── 雙重數字尾碼：基底名稱本身以數字結尾時不再疊加成雙重數字 ──

run('基底名稱本身以數字結尾時，區分尾碼不再疊成雙重數字', () => {
  // program 48 = 弦樂合奏 1（GM 中文表本身就帶數字）。兩軌同 program，clef/role 判定會
  // 一樣，逼出「描述子不足以區分、退回數字尾碼」的路徑。
  const mkTrack = (ch) => track([
    { deltaTick: 0, bytes: [0xc0 | ch, 48] },
    { deltaTick: 0, bytes: [0x90 | ch, 60, 100] },
    { deltaTick: 480, bytes: [0x80 | ch, 60, 0] },
  ]);
  const parsed = parseMidi(midiFile([mkTrack(0), mkTrack(1)]));
  assert(parsed.parts.length === 2, `預期 2 個聲部，實際 ${parsed.parts.length}`);
  for (const p of parsed.parts) {
    assert(!/\d \d/.test(p.name), `不該出現「數字 空白 數字」的雙重編號：${p.name}`);
  }
});

console.log('\n全部測試跑完。');
