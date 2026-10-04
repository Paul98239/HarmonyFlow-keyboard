// ============================================================
//  midi-parser.test.mjs — src/midi/midiParser.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟 test/browser/smoke-test.mjs 同一套風格：run()／assert() 是整個專案
//  唯一的測試慣例。用法：node test/unit/midi-parser.test.mjs
//
//  聲部切分（Part／voice）的規則見 midiParser.js 的 groupTracks() 說明；這裡的手工檔模仿 MuseScore
//  匯出器的軌佈局：一個譜表一條 track，只有樂器最上行譜的 track 在 tick 0 對樂器的每個 channel 寫初始化區塊
//  （CC121、[Bank]、Program Change、CC7、CC10、CC91、CC93）。
// ============================================================

import { readFileSync } from 'node:fs';
import { parseMidi } from '../../src/midi/midiParser.js';

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── 手工組一個最小 MIDI 檔的工具：header + 一或多軌，每軌是 { deltaTick, bytes } 事件清單 ──
function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function u16(n) { return [(n >>> 8) & 0xff, n & 0xff]; }
function vlq(n) {
  const bytes = [n & 0x7f]; n >>>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>>= 7; }
  return bytes;
}
function track(events) {
  const body = [];
  for (const e of events) { body.push(...vlq(e.deltaTick), ...e.bytes); }
  body.push(...vlq(0), 0xff, 0x2f, 0x00); // End of Track
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]; // "MTrk"
}
function midiFile(tracks, { division = 480, format = 1 } = {}) {
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(format), ...u16(tracks.length), ...u16(division)];
  return new Uint8Array([...header, ...tracks.flat()]);
}

const enc = new TextEncoder();
const nameEv = (s) => { const b = [...enc.encode(s)]; return { deltaTick: 0, bytes: [0xff, 0x03, b.length, ...b] }; };
const tempoEv = (us, deltaTick = 0) => ({ deltaTick, bytes: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
const portEv = (p) => ({ deltaTick: 0, bytes: [0xff, 0x21, 1, p] });
const cc = (ch, n, v, deltaTick = 0) => ({ deltaTick, bytes: [0xb0 | ch, n, v] });
const pc = (ch, program, deltaTick = 0) => ({ deltaTick, bytes: [0xc0 | ch, program] });
// MuseScore 的初始化區塊：只寫在樂器最上行譜的 track，樂器的每個 channel 各一份。
const initBlock = (ch, program, { vol = 100, pan = 64, rev = 0, cho = 0, bank = null } = {}) => [
  cc(ch, 121, 0),
  ...(bank ? [cc(ch, 0, bank[0]), cc(ch, 32, bank[1])] : []),
  pc(ch, program),
  cc(ch, 7, vol), cc(ch, 10, pan), cc(ch, 91, rev), cc(ch, 93, cho),
];
// 依序彈 pitches：每顆 dur tick，首尾相接；start 是第一顆音的起點。
const notes = (ch, pitches, { start = 0, dur = 480 } = {}) => pitches.flatMap((p, i) => [
  { deltaTick: i === 0 ? start : 0, bytes: [0x90 | ch, p, 100] },
  { deltaTick: dur, bytes: [0x80 | ch, p, 0] },
]);

// ── 聲部切分：Part（MuseScore 的樂器）與 voice（一個譜表 × 一個樂器 channel）──

run('鋼琴兩行譜：下行譜沒有初始化區塊、軌名相同、同 channel → 1 個 part、2 個 voice', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), ...initBlock(0, 0), ...notes(0, [60, 62])]), // 上行譜
    track([nameEv('Piano'), ...notes(0, [48, 50])]),                     // 下行譜
  ]));
  assert(parsed.parts.length === 1, `預期 1 個 part，實際 ${parsed.parts.length}：${parsed.parts.map((p) => p.name)}`);
  const part = parsed.parts[0];
  assert(part.name === '大鋼琴', `名稱應為「大鋼琴」，實際「${part.name}」`);
  assert(part.voices.map((v) => v.id).join() === 't0c0,t1c0', `voice 應為 t0c0、t1c0，實際 ${part.voices.map((v) => v.id)}`);
  assert(part.noteCount === 4 && part.voices.every((v) => v.noteCount === 2), `音符數：part 4、每個 voice 2，實際 ${part.noteCount}／${part.voices.map((v) => v.noteCount)}`);
  assert(parsed.notes.every((n) => n.partId === part.id), '每顆音的 partId 都應該是這個 part');
  assert(parsed.notes.filter((n) => n.voiceId === 't1c0').length === 2, '下行譜的音應標 voiceId t1c0');
  assert(part.voices[1].program === 0 && part.voices[1].init?.volume === 100, '下行譜沿用上行譜（首軌）對這個 channel 的初始化');
});

run('弓弦樂器三個 channel（normal／pizzicato／tremolo）：只有 normal 有音符 → 1 個 voice；pizzicato 也有音 → 2 個 voice', () => {
  const init = [...initBlock(0, 40), ...initBlock(1, 45), ...initBlock(2, 44)];
  const onlyNormal = parseMidi(midiFile([track([nameEv('Violin'), ...init, ...notes(0, [67])])]));
  assert(onlyNormal.parts.length === 1 && onlyNormal.parts[0].voices.length === 1, `只有 ch0 有音：預期 1 part 1 voice，實際 ${onlyNormal.parts.length}／${onlyNormal.parts[0]?.voices.length}`);
  const withPizz = parseMidi(midiFile([track([nameEv('Violin'), ...init, ...notes(0, [67, 69]), ...notes(1, [71])])]));
  const part = withPizz.parts[0];
  assert(withPizz.parts.length === 1 && part.voices.length === 2, `pizzicato 有音：預期 1 part 2 voice，實際 ${withPizz.parts.length}／${part.voices.length}`);
  assert(part.voices.map((v) => v.program).join() === '40,45', `兩個 voice 的音色應為 40、45，實際 ${part.voices.map((v) => v.program)}`);
  assert(part.name === '小提琴', `part 名稱取主 voice（音符最多）的音色：預期「小提琴」，實際「${part.name}」`);
});

run('兩個小提琴 Part（各自有初始化區塊）→ 2 個 part，命名「小提琴 1」「小提琴 2」', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Violin 1'), ...initBlock(0, 40), ...notes(0, [67])]),
    track([nameEv('Violin 2'), ...initBlock(1, 40), ...notes(1, [64])]),
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '小提琴 1,小提琴 2', `名稱應依總譜順序加序號，實際 ${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts[0].id !== parsed.parts[1].id, '兩個 part 的 id 不同');
});

run('兩台鋼琴同名、同一個軌內 channel、各自有初始化區塊（第二台在 port 1）→ 2 個 part，不會併成一個', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), portEv(0), ...initBlock(0, 0), ...notes(0, [60])]),
    track([nameEv('Piano'), portEv(1), ...initBlock(0, 0), ...notes(0, [64])]),
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '大鋼琴 1,大鋼琴 2', `有初始化區塊的 track 一定是新樂器的第一行譜，實際 ${parsed.parts.map((p) => p.name)}`);
});

run('軌名是空的、沒有初始化區塊、但用的是這組沒有的 channel → 另成一個 part（不是下行譜）', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Violin'), ...initBlock(0, 40), ...notes(0, [67])]),
    track([nameEv(''), ...notes(5, [48])]),
  ]));
  assert(parsed.parts.length === 2, `下行譜只會用上行譜已知的 channel，實際 ${parsed.parts.length} 個 part：${parsed.parts.map((p) => p.name)}`);
});

run('part 名稱取音符最多的 voice 的音色（不是第一個 voice）：pizzicato channel 音符較多就叫「撥弦弦樂」', () => {
  const init = [...initBlock(0, 40), ...initBlock(1, 45)];
  const parsed = parseMidi(midiFile([track([nameEv('Violin'), ...init, ...notes(0, [67]), ...notes(1, [60, 62, 64])])]));
  assert(parsed.parts[0].voices.length === 2 && parsed.parts[0].name === '撥弦弦樂', `實際「${parsed.parts[0].name}」`);
});

run('基底名稱本身以數字結尾（弦樂合奏 1）：區分用全形括號，不疊成雙重數字', () => {
  const mk = (ch) => track([nameEv(`Strings ${ch}`), ...initBlock(ch, 48), ...notes(ch, [60])]);
  const parsed = parseMidi(midiFile([mk(0), mk(1)]));
  assert(parsed.parts.map((p) => p.name).join() === '弦樂合奏 1（1）,弦樂合奏 1（2）', `實際 ${parsed.parts.map((p) => p.name)}`);
});

run('打擊樂器在 port 1：絕對 channel 25（port 出現順序 +16）、percussionKit、名稱「標準鼓組」', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Piano'), portEv(0), ...initBlock(0, 0), ...notes(0, [60])]),
    track([nameEv('Drumset'), portEv(1), ...initBlock(9, 0), ...notes(9, [36, 38])]),
  ]));
  assert(parsed.parts.length === 2, `預期 2 個 part，實際 ${parsed.parts.length}`);
  const drum = parsed.parts[1];
  assert(drum.name === '標準鼓組', `名稱應為「標準鼓組」，實際「${drum.name}」`);
  const v = drum.voices[0];
  assert(v.channel === 25 && v.percussionKit === true, `打擊 voice 應在絕對 channel 25 且 percussionKit，實際 ${v.channel}／${v.percussionKit}`);
  assert(parsed.notes.filter((n) => n.partId === drum.id).every((n) => n.channel === 25), '打擊 part 的音符 channel 應為 25');
  assert(parsed.notes.find((n) => n.partId === parsed.parts[0].id).channel === 0, 'port 0 的音符 channel 維持 0');
});

run('初始化區塊取出：voice.init＝{volume, pan, reverb, chorus}、program、bank', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Flute'), ...initBlock(0, 73, { vol: 90, pan: 30, rev: 20, cho: 10, bank: [0, 4] }), ...notes(0, [72])]),
  ]));
  const v = parsed.parts[0].voices[0];
  assert(JSON.stringify(v.init) === JSON.stringify({ volume: 90, pan: 30, reverb: 20, chorus: 10 }), `init 實際 ${JSON.stringify(v.init)}`);
  assert(v.program === 73 && v.bank.msb === 0 && v.bank.lsb === 4, `program／bank 實際 ${v.program}／${JSON.stringify(v.bank)}`);
});

run('沒有初始化區塊的 voice：init 為 null；bank 沒送過就用 GM2 規格預設（旋律 121、打擊 channel 9 是 120）', () => {
  const parsed = parseMidi(midiFile([
    track([pc(0, 40), ...notes(0, [60])]),
    track([...notes(9, [36])]),
  ]));
  const [melodic, drum] = parsed.parts.map((p) => p.voices[0]);
  assert(melodic.init === null && melodic.program === 40, `旋律 voice：init 應為 null、program 40，實際 ${JSON.stringify(melodic.init)}／${melodic.program}`);
  assert(melodic.bank.msb === 121 && melodic.bank.lsb === 0 && melodic.percussionKit === false, `旋律 voice 的預設 bank 應為 121／0，實際 ${JSON.stringify(melodic.bank)}`);
  assert(drum.init === null && drum.bank.msb === 120 && drum.percussionKit === true, `channel 9 的預設 bank 應為 120（打擊），實際 ${JSON.stringify(drum.bank)}／${drum.percussionKit}`);
});

// ── 曲庫的佈局變體（全部走同一條規則）──

run('Meta 軌佈局：不含音符的第一軌被忽略，不成為 part', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Meta'), tempoEv(500000)]),
    track([nameEv('Oboe'), ...initBlock(0, 68), ...notes(0, [72])]),
  ]));
  assert(parsed.parts.length === 1 && parsed.parts[0].name === '雙簧管', `預期只有「雙簧管」，實際 ${parsed.parts.map((p) => p.name)}`);
});

run('〈蝸牛與黃鸝鳥〉的結構（使用者用原始 MuseScore 檔確認過）：長笛＋鋼琴（上行譜有初始化區塊、下行譜只有 Program Change）→ 2 個 part，鋼琴 2 個 voice', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Metadata'), tempoEv(500000)]),                                        // 不含音符的 Meta 軌
    track([nameEv(''), ...initBlock(0, 73), ...notes(0, [76, 77])]),                     // 長笛：軌名是空的
    track([nameEv('Piano'), ...initBlock(1, 0), ...notes(1, [60, 64])]),                 // 鋼琴上行譜
    track([nameEv('Piano'), pc(1, 0), ...notes(1, [48, 52])]),                           // 鋼琴下行譜：只有 Program Change
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '長笛,大鋼琴', `應為「長笛、大鋼琴」，實際 ${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts[1].voices.length === 2, `鋼琴應有 2 個 voice（兩個譜表），實際 ${parsed.parts[1].voices.length}`);
});

run('第一個樂器軌名稱是空的、下行譜有名稱：併入同一個 part（任一方軌名為空都算相同）', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Meta'), tempoEv(500000)]),
    track([nameEv(''), ...initBlock(0, 0), ...notes(0, [60])]),
    track([nameEv('Piano'), ...notes(0, [48])]),
  ]));
  assert(parsed.parts.length === 1, `預期 1 個 part，實際 ${parsed.parts.length}：${parsed.parts.map((p) => p.name)}`);
});

run('舊檔（沒有初始化區塊、軌名 Right Hand／Left Hand 不同）：2 個 part，同音色命名「大鋼琴 1」「大鋼琴 2」', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Right Hand'), pc(0, 0), ...notes(0, [72])]),
    track([nameEv('Left Hand'), pc(0, 0), ...notes(0, [48])]),
  ]));
  assert(parsed.parts.map((p) => p.name).join() === '大鋼琴 1,大鋼琴 2', `實際 ${parsed.parts.map((p) => p.name)}`);
});

run('名稱只依 program：不採信軌名、不放高低音譜／旋律伴奏／bank 的任何描述', () => {
  const parsed = parseMidi(midiFile([
    track([nameEv('Bass Guitar'), ...initBlock(0, 24, { bank: [0, 1] }), ...notes(0, [40])]), // 軌名說是貝斯，program 是尼龍弦吉他
  ]));
  assert(parsed.parts[0].name === '尼龍弦吉他', `名稱只依 program，實際「${parsed.parts[0].name}」`);
});

run('canon 金標準：2 個 part（小提琴／大提琴）、各 1 個 voice、513／453 顆音、init＝100／64／0／0、零警告', () => {
  const buf = readFileSync(new URL('../../src/assets/canon-violin-cello.mid', import.meta.url));
  const parsed = parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  assert(parsed.parts.map((p) => p.name).join() === '小提琴,大提琴', `實際 ${parsed.parts.map((p) => p.name)}`);
  assert(parsed.parts.every((p) => p.voices.length === 1), 'canon 每個 part 只有 1 個 voice');
  assert(parsed.parts.map((p) => p.noteCount).join() === '513,453', `音符數應為 513、453，實際 ${parsed.parts.map((p) => p.noteCount)}`);
  for (const p of parsed.parts) {
    assert(JSON.stringify(p.voices[0].init) === JSON.stringify({ volume: 100, pan: 64, reverb: 0, chorus: 0 }), `${p.name} 的 init 實際 ${JSON.stringify(p.voices[0].init)}`);
  }
  assert(parsed.warnings.length === 0, `canon 不該有任何警告，實際 ${parsed.warnings}`);
});

// ── 資料形狀：刪掉的欄位不再出現 ──

run('已刪除的欄位（clef／role／medianNote／trackName…）不再出現在 part、voice、note 上', () => {
  const parsed = parseMidi(midiFile([track([nameEv('Piano'), ...initBlock(0, 0), ...notes(0, [60])])]));
  const gone = ['clef', 'role', 'medianNote', 'polyphonyAvg', 'lowestNote', 'highestNote', 'programs', 'programName', 'trackName', 'instrumentName', 'isDrum'];
  for (const k of gone) assert(!(k in parsed.parts[0]), `part 不該再有 ${k}`);
  for (const k of ['onEvent', 'offVelocity', 'program']) assert(!(k in parsed.notes[0]), `note 不該再有 ${k}`);
});

// ── program／bank 依時間軸查詢（沒有初始化區塊時；不是依軌道處理順序）──
// 修正對象：collectNotes()／collectParts() 曾經把 currentProgram 依「檔案裡的軌序」逐軌
// 處理，讀到的是「前面各軌處理完畢時留下的值」，不是「這顆音那個時間點該有的值」。

run('情境 A：音符在無 PC 的軌、PC 在另一軌——依時間軸查詢，不是依軌序', () => {
  const trackNotes = track([
    { deltaTick: 480, bytes: [0x90, 60, 100] }, // tick 480: note on C4, ch0（無 PC）
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackPC = track([pc(0, 40)]); // tick 0: PC 40, ch0
  const parsed = parseMidi(midiFile([trackNotes, trackPC]));
  assert(parsed.notes.length === 1, `預期 1 顆音符，實際 ${parsed.notes.length}`);
  assert(parsed.parts[0].voices[0].program === 40, `依時間軸查詢應該是 program 40，實際 ${parsed.parts[0].voices[0].program}`);
});

run('情境 B：同一 channel 兩次 PC，音符夾在中間', () => {
  const trackNotes = track([
    { deltaTick: 480, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackPC = track([pc(0, 40), pc(0, 41, 960)]);
  const parsed = parseMidi(midiFile([trackNotes, trackPC]));
  assert(parsed.notes.length === 1, '預期 1 顆音符');
  assert(parsed.parts[0].voices[0].program === 40, `音符落在 PC40 之後、PC41 之前，應該是 40，實際 ${parsed.parts[0].voices[0].program}`);
});

run("情境 B'：自己軌自己送過 PC 時優先採用，不查全曲時間軸", () => {
  const trackA = track([
    pc(0, 5),
    { deltaTick: 480, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ]);
  const trackB = track([pc(0, 99)]); // 同 channel，不該影響 A
  const parsed = parseMidi(midiFile([trackA, trackB]));
  assert(parsed.notes.length === 1, '預期 1 顆音符');
  assert(parsed.parts[0].voices[0].program === 5, `自己軌的 PC5 應該優先，實際 ${parsed.parts[0].voices[0].program}`);
});

run('有初始化區塊的 voice：program 只看 tick 0，之後 tick>0 的 Program Change 被忽略', () => {
  const parsed = parseMidi(midiFile([
    track([...initBlock(0, 40), ...notes(0, [60]), pc(0, 41, 480), ...notes(0, [62])]),
  ]));
  assert(parsed.parts.length === 1 && parsed.parts[0].voices.length === 1, `同一個 (track, channel) 只有 1 個 voice，實際 ${parsed.parts.length}／${parsed.parts[0]?.voices.length}`);
  assert(parsed.parts[0].voices[0].program === 40, `program 應為 tick 0 的 40，實際 ${parsed.parts[0].voices[0].program}`);
});

run('有初始化區塊的 voice：tick>0 的 Program Change 就算在第一顆音之前出現也被忽略', () => {
  const parsed = parseMidi(midiFile([
    track([...initBlock(0, 40), pc(0, 41, 240), ...notes(0, [60], { start: 240 })]), // tick 240 換成 41，第一顆音在 tick 480
  ]));
  assert(parsed.parts[0].voices[0].program === 40, `program 應為 tick 0 的 40，實際 ${parsed.parts[0].voices[0].program}`);
});

// ── 時間軸與 port 的對齊（跟官方 SpessaSynth 一致；差異測試 oracle.test.mjs 另外對照）──

run('同 tick 的速度衝突：後出現者生效（跟官方一致）', () => {
  const parsed = parseMidi(midiFile([
    track([tempoEv(500000), tempoEv(750000, 480), { deltaTick: 480, bytes: [0x90, 60, 100] }, { deltaTick: 480, bytes: [0x80, 60, 0] }]),
    track([tempoEv(1000000, 480)]), // 同樣在 tick 480，後出現（軌序在後）
  ]));
  // tick 0~480 以 120 BPM（0.5s）；tick 480 起後出現的 60 BPM（1s／四分音符）生效，tick 960 起音＝0.5 + 1 = 1.5s
  assert(Math.abs(parsed.notes[0].startSeconds - 1.5) < 1e-9, `起音應為 1.5s（後出現者生效），實際 ${parsed.notes[0].startSeconds}`);
});

run('MuseScore 的空譜表：鋼琴只有一行譜有音、另一行是空的（有初始化區塊或只有軌名），仍是一個 part、一個 voice，初始音量取首軌的', () => {
  const partsOf = (tracks) => parseMidi(midiFile(tracks)).parts;
  // 上行譜只有初始化區塊（空）、下行譜有音：voice 只有下行譜那一個，音量 90 取自首軌（上行譜）的初始化區塊
  const upperEmpty = partsOf([track([nameEv('Piano'), ...initBlock(0, 0, { vol: 90 })]), track([nameEv('Piano'), ...notes(0, [48, 50, 52])])]);
  assert(upperEmpty.length === 1 && upperEmpty[0].voices.length === 1 && upperEmpty[0].voices[0].init?.volume === 90,
    `上行譜空、下行譜有音：1 個 part、1 個 voice、音量 90，實際 ${JSON.stringify(upperEmpty.map((p) => [p.name, p.voices.map((v) => [v.id, v.init?.volume])]))}`);
  // 下行譜整條空軌（只有軌名）：不多出 voice，也不影響後面的長笛
  const lowerEmpty = partsOf([track([nameEv('Piano'), ...initBlock(0, 0, { vol: 90 }), ...notes(0, [72, 74])]), track([nameEv('Piano')]), track([nameEv('Flute'), ...initBlock(1, 73), ...notes(1, [80])])]);
  assert(lowerEmpty.length === 2 && lowerEmpty[0].voices.length === 1 && lowerEmpty[1].voices.length === 1, `鋼琴（一個 voice）＋長笛，實際 ${lowerEmpty.length} 個 part`);
  // 鋼琴兩行譜都空：整個樂器不成 part
  const bothEmpty = partsOf([track([nameEv('Piano'), ...initBlock(0, 0, { vol: 90 })]), track([nameEv('Piano')]), track([nameEv('Flute'), ...initBlock(1, 73), ...notes(1, [80])])]);
  assert(bothEmpty.length === 1 && bothEmpty[0].voices.length === 1, `兩行譜都空的鋼琴不成 part，只剩長笛，實際 ${bothEmpty.length} 個 part`);
});

run('同 tick 的拍號與調號衝突：後出現者生效（跟速度表、官方一致），不重複列出同一個 tick', () => {
  const timeSig = (nn, dd, deltaTick = 0) => ({ deltaTick, bytes: [0xff, 0x58, 4, nn, dd, 24, 8] });
  const keySig = (sf) => ({ deltaTick: 0, bytes: [0xff, 0x59, 2, sf, 0] });
  const parsed = parseMidi(midiFile([
    track([timeSig(4, 2), timeSig(3, 2, 480), keySig(1), { deltaTick: 480, bytes: [0x90, 60, 100] }, { deltaTick: 480, bytes: [0x80, 60, 0] }]),
    track([timeSig(6, 3, 480), keySig(2)]), // tick 480 的拍號與 tick 480 的調號都是這一軌後出現
  ]));
  const at480 = parsed.timeSignatures.filter((t) => t.tick === 480);
  assert(at480.length === 1 && at480[0].numerator === 6 && at480[0].denominator === 8, `tick 480 只該有一筆 6/8（後出現者），實際 ${JSON.stringify(at480)}`);
  assert(parsed.timeSignatures.length === 2, `tick 0 與 tick 480 各一筆，實際 ${parsed.timeSignatures.length} 筆`);
  const keys480 = parsed.keySignatures.filter((k) => k.tick === 480 || k.tick === 0);
  assert(keys480.at(-1).sharpsFlats === 2, `同 tick 的調號後出現者生效（2 個升記號），實際 ${JSON.stringify(parsed.keySignatures)}`);
});

run('port 絕對 channel：依軌序第一次出現的 port 各 +16，沒有指定 port 的軌用最小的已指定 port', () => {
  const parsed = parseMidi(midiFile([
    track([portEv(2), ...initBlock(0, 0), ...notes(0, [60])]),   // 第一個出現的 port（值 2）→ offset 0
    track([portEv(5), ...initBlock(0, 40), ...notes(0, [62])]),  // 第二個 port → offset 16
    track([...initBlock(1, 73), ...notes(1, [64])]),             // 沒指定 port → 最小的已指定 port（2）→ offset 0
  ]));
  const chOf = (name) => parsed.notes.find((n) => n.partId === parsed.parts.find((p) => p.name === name).id).channel;
  assert(chOf('大鋼琴') === 0 && chOf('小提琴') === 16 && chOf('長笛') === 1, `絕對 channel 應為 0／16／1，實際 ${chOf('大鋼琴')}／${chOf('小提琴')}／${chOf('長笛')}`);
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

// ── 警告 ──

run('鼓組非標準 program 的警告不再斷言會退回 Standard Kit', () => {
  const trackDrum = track([
    cc(0, 0, 120),    // ch0 Bank Select MSB=120（節奏 bank）
    pc(0, 1),         // ch0 PC=1（不是 GM_DRUM_KITS 裡的標準編號）
    ...notes(0, [36]),
  ]);
  const parsed = parseMidi(midiFile([trackDrum]));
  const w = parsed.warnings.find((x) => x.includes('鼓組 program'));
  assert(w, '應該要有鼓組相關警告');
  assert(!w.includes('會退回播放 Standard Kit'), `警告不該再斷言「會退回播放 Standard Kit」：${w}`);
  assert(w.includes('取決於載入的 SoundFont'), `警告應該改成中性措辭：${w}`);
});

run('同一個 voice 內同音高重疊會警告（先進先出配對）', () => {
  const parsed = parseMidi(midiFile([track([
    { deltaTick: 0, bytes: [0x90, 60, 100] },
    { deltaTick: 240, bytes: [0x90, 60, 90] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
    { deltaTick: 240, bytes: [0x80, 60, 0] },
  ])]));
  assert(parsed.notes.length === 2, `預期 2 顆音，實際 ${parsed.notes.length}`);
  assert(parsed.warnings.some((w) => w.includes('同音高重疊')), `應該有「同音高重疊」警告，實際 ${parsed.warnings}`);
});

console.log('\n全部測試跑完。');
