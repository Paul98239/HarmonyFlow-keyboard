// ============================================================
//  oracle.test.mjs — 用官方 SpessaSynth（spessasynth_core，devDependency）當標尺的差異測試
//  純 Node，不需要瀏覽器、不載音色庫、不出聲。
//
//  標尺的取得方式：把官方 SpessaSynthSequencer 接到一個 SpessaSynthProcessor，把 processor 的
//  noteOn／noteOff／programChange／controllerChange 換成「記錄器」（不呼叫原本的實作，所以不需要音色庫），
//  再用官方 README 的離線渲染迴圈（processTick ＋ process）把整首跑完。記錄到的就是官方播放器
//  「實際送給合成器的事件」：已經套用 MIDI port 的 channel offset、velocity 0 轉 note-off、同 tick 的
//  軌序，時間用官方 BasicMIDI.midiTicksToSeconds（不是我們的 tickToSeconds）。
//
//  三層比對：
//    L1 解析：parseMidi() 解出來的音，跟官方播放器送出的音一致嗎？
//    L2 播放：整首自動播放、以及被「完美演奏者」逐拍驅動時，排程器發出的音跟官方一致嗎？
//    L3 同步：不靠官方，直接檢查「樂譜上同一時刻的音，不論指派或電腦輔助，實際發聲要同時」。
//
//  run()         ＝ 應該一致，不一致就是失敗。
//  runKnownDiff() ＝ 目前已知有差異（附原因與預計由哪個工作包修），測試在驗證「差異確實還在」；差異消失
//                   （被修好）時它會反過來失敗，提醒把它改成 run()。這樣套件保持綠燈，又不會讓已知差異被遺忘。
//
//  用法：node test/unit/oracle.test.mjs
// ============================================================

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BasicMIDI, SpessaLog, SpessaSynthProcessor, SpessaSynthSequencer } from 'spessasynth_core';
import { parseMidi } from '../../src/midi/midiParser.js';
import { HumanPerformer } from '../../src/midi/humanPerformer.js';

// 官方函式庫在沒有音色庫時會對每個 channel 印「No preset found」，這裡用不到音色庫，關掉雜訊。
SpessaLog.setLogLevel(false, false, false);

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/assets');

async function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { await fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
async function runKnownDiff(name, why, fn) {
  console.log(`\n=== [已知差異] ${name} ===`);
  try { await fn(); } catch (err) { console.log(`🟡 已知差異（${why}）：${err.message}`); return; }
  console.log('❌ 失敗: 這個差異已經不存在了——把它改成 run()，並刪掉「已知差異」的說明');
  process.exitCode = 1;
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ═══════════════════════════════════════════
   標尺：官方播放器送給合成器的事件
   ═══════════════════════════════════════════ */

const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const readAsset = (name) => toArrayBuffer(readFileSync(join(ASSET_DIR, name)));

// 回傳 { midi, events }：events 依官方送出的順序，每筆 { kind, ch, key|program|cc, vel|value, sec }。
async function officialPlayback(ab) {
  const midi = BasicMIDI.fromArrayBuffer(ab);
  const synth = new SpessaSynthProcessor(48000, { eventsEnabled: false, effectsEnabled: false });
  await synth.processorInitialized;
  const events = [];
  let current = null; // 正在處理的那個 MIDI 事件；sequencer 自己的重設／清音呼叫發生在事件之外，不記
  const rec = (kind, fields) => { if (current) events.push({ kind, ...fields, sec: midi.midiTicksToSeconds(current.ticks) }); };
  synth.noteOn = (ch, key, vel) => rec('noteOn', { ch, key, vel });
  synth.noteOff = (ch, key) => rec('noteOff', { ch, key });
  synth.programChange = (ch, program) => rec('program', { ch, program });
  synth.controllerChange = (ch, cc, value) => rec('cc', { ch, cc, value });
  synth.pitchWheel = synth.polyPressure = synth.channelPressure = synth.systemExclusive = () => {};
  const seq = new SpessaSynthSequencer(synth);
  seq.skipToFirstNoteOn = false; // 要跟排程器同一個時間原點（樂譜時間 0）
  seq.preload = false;
  const processEvent = seq.processEvent;
  seq.processEvent = (event, trackIndex) => { current = event; processEvent.call(seq, event, trackIndex); current = null; };
  seq.loadNewSongList([midi]);
  seq.play();
  const left = new Float32Array(128), right = new Float32Array(128);
  for (let guard = 0; !seq.isFinished && guard < 4e6; guard++) { seq.processTick(); synth.process(left, right, 0, 128); }
  assert(seq.isFinished, '官方播放器沒有在合理步數內播完');
  return { midi, events };
}

// note-on／note-off 依「同 channel 同音高先進先出」配對（官方合成器的語意）。官方在處理到最後一個
// voice event 時就收掉整首，同一 tick 之後的 note-off 不會被送出——配不到 note-off 的音 end＝null，
// 比對時只比起音。
function pairOfficialNotes(events) {
  const pending = new Map(), notes = [];
  for (const e of events) {
    const k = e.ch * 128 + e.key;
    if (e.kind === 'noteOn') {
      const note = { ch: e.ch, key: e.key, vel: e.vel, start: e.sec, end: null };
      notes.push(note);
      if (!pending.has(k)) pending.set(k, []);
      pending.get(k).push(note);
    } else if (e.kind === 'noteOff') {
      const queue = pending.get(k);
      if (queue?.length) queue.shift().end = e.sec;
    }
  }
  return notes;
}

const ourNotesOf = (score) => score.notes.map((n) => ({ ch: n.channel, key: n.note, vel: n.velocity, start: n.startSeconds, end: n.endSeconds }));

// 兩組音逐組比對：依 (channel, 音高, 力度) 分組、組內依起音時間排序後一一配對。
// channelOf(note) 決定 channel 怎麼比（預設用原值）。回傳差異摘要，沒有差異時 problems 是空陣列。
function compareNotes(official, ours, { tolStartMs = 1.5, tolEndMs = 1.5, channelOf = (n) => n.ch } = {}) {
  const group = (notes) => {
    const m = new Map();
    for (const n of notes) {
      const k = `${channelOf(n)}|${n.key}|${n.vel}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(n);
    }
    for (const list of m.values()) list.sort((a, b) => a.start - b.start);
    return m;
  };
  const A = group(official), B = group(ours), problems = [];
  let maxStart = 0, maxEnd = 0, onlyOfficial = 0, onlyOurs = 0;
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(k) || [], b = B.get(k) || [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (!a[i]) { onlyOurs++; if (problems.length < 5) problems.push(`只有我們有：ch|音高|力度=${k} 起音 ${b[i].start.toFixed(3)}s`); continue; }
      if (!b[i]) { onlyOfficial++; if (problems.length < 5) problems.push(`只有官方有：ch|音高|力度=${k} 起音 ${a[i].start.toFixed(3)}s`); continue; }
      const ds = Math.abs(a[i].start - b[i].start) * 1000;
      maxStart = Math.max(maxStart, ds);
      if (ds > tolStartMs && problems.length < 5) problems.push(`起音差 ${ds.toFixed(1)}ms：${k} 官方 ${a[i].start.toFixed(3)}s／我們 ${b[i].start.toFixed(3)}s`);
      if (a[i].end != null) {
        const de = Math.abs(a[i].end - b[i].end) * 1000;
        maxEnd = Math.max(maxEnd, de);
        if (de > tolEndMs && problems.length < 5) problems.push(`收音差 ${de.toFixed(1)}ms：${k} 官方 ${a[i].end.toFixed(3)}s／我們 ${b[i].end.toFixed(3)}s`);
      }
    }
  }
  const bad = onlyOfficial + onlyOurs > 0 || maxStart > tolStartMs || maxEnd > tolEndMs;
  return { bad, onlyOfficial, onlyOurs, maxStart, maxEnd, problems, summary: `官方 ${official.length} 顆／我們 ${ours.length} 顆；只有官方 ${onlyOfficial}、只有我們 ${onlyOurs}；最大起音差 ${maxStart.toFixed(2)}ms、收音差 ${maxEnd.toFixed(2)}ms` };
}
function assertNotesMatch(official, ours, opts) {
  const r = compareNotes(official, ours, opts);
  assert(!r.bad, `${r.summary}\n    ${r.problems.join('\n    ')}`);
}

/* ═══════════════════════════════════════════
   手工組的 SMF（邊界情況）
   ═══════════════════════════════════════════ */

const vlq = (n) => { const bytes = [n & 0x7f]; while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80); return bytes; };
const ev = (delta, ...bytes) => [...vlq(delta), ...bytes];
const tempoEv = (delta, us) => ev(delta, 0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255);
const portEv = (delta, port) => ev(delta, 0xff, 0x21, 0x01, port);
function mtrk(...events) {
  const body = [...events.flat(), ...ev(0, 0xff, 0x2f, 0x00)];
  return [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...body];
}
function smf(format, division, ...tracks) {
  return toArrayBuffer(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, format, 0, tracks.length, division >> 8, division & 255, ...tracks.flat()]));
}

const FIXTURES = {
  // 第一個 note-on 之後用 running status 省略狀態位元組，並用「力度 0 的 note-on」當 note-off。
  'running status 與力度 0 的 note-off': smf(1, 480, mtrk(tempoEv(0, 500000),
    ev(0, 0x90, 60, 100), ev(480, 60, 0), ev(0, 62, 90), ev(480, 62, 0), ev(0, 64, 80), ev(480, 64, 0))),
  // 同音高重疊：官方與解析層都是先進先出，(0→480)、(240→720)。
  '同音高重疊（先進先出）': smf(1, 480, mtrk(tempoEv(0, 500000),
    ev(0, 0x90, 60, 100), ev(240, 0x90, 60, 90), ev(240, 0x80, 60, 0), ev(240, 0x80, 60, 0))),
  // 速度中途改變（480 tick 處從 120 變 60 BPM）。
  '速度中途改變': smf(1, 480, mtrk(tempoEv(0, 500000), tempoEv(480, 1000000),
    ev(0, 0x90, 60, 100), ev(480, 0x80, 60, 0), ev(0, 0x90, 62, 100), ev(480, 0x80, 62, 0))),
  // 兩個 track 在 480 tick 各給一個不同的速度（80 BPM 與 60 BPM）；官方取後出現者，
  // 我們取先出現者（A3）。音符在 960 tick，速度決定它的起音秒數。
  '同 tick 的速度衝突': smf(1, 480,
    mtrk(tempoEv(0, 500000), tempoEv(480, 750000), ev(960, 0x90, 60, 100), ev(480, 0x80, 60, 0)),
    mtrk(tempoEv(480, 1000000), ev(960, 0x90, 64, 100), ev(480, 0x80, 64, 0))),
  // 兩個 port：第二個 track 用 FF21 指定 port 1，官方把它的 channel 0 放到 16。
  '兩個 MIDI port': smf(1, 480,
    mtrk(tempoEv(0, 500000), portEv(0, 0), ev(0, 0x90, 60, 100), ev(480, 0x80, 60, 0)),
    mtrk(portEv(0, 1), ev(0, 0x90, 67, 100), ev(480, 0x80, 67, 0))),
};

/* ═══════════════════════════════════════════
   L1 解析對照
   ═══════════════════════════════════════════ */

const sampleAssets = readdirSync(ASSET_DIR).filter((n) => /\.mid$/i.test(n));

for (const name of sampleAssets) {
  await run(`L1 解析：${name} 的每顆音（channel、音高、力度、起訖時間）跟官方播放器送出的一致`, async () => {
    const ab = readAsset(name);
    const { events } = await officialPlayback(ab);
    assertNotesMatch(pairOfficialNotes(events), ourNotesOf(parseMidi(ab)));
  });
}

await run('L1 速度表：抽樣 tick 換算的秒數與官方 midiTicksToSeconds 一致（含速度中途改變）', async () => {
  for (const [label, ab] of [['canon', readAsset('canon-violin-cello.mid')], ['速度中途改變', FIXTURES['速度中途改變']]]) {
    const midi = BasicMIDI.fromArrayBuffer(ab), score = parseMidi(ab);
    for (let tick = 0; tick <= score.durationTicks; tick += Math.max(1, Math.floor(score.durationTicks / 97))) {
      const diff = Math.abs(midi.midiTicksToSeconds(tick) - score.tickToSeconds(tick)) * 1000;
      assert(diff < 0.5, `${label}：tick ${tick} 官方 ${midi.midiTicksToSeconds(tick).toFixed(4)}s／我們 ${score.tickToSeconds(tick).toFixed(4)}s，差 ${diff.toFixed(2)}ms`);
    }
  }
});

await run('L1 總長：durationSeconds 跟官方 duration 差不到 2ms', async () => {
  for (const name of sampleAssets) {
    const ab = readAsset(name);
    const diff = Math.abs(BasicMIDI.fromArrayBuffer(ab).duration - parseMidi(ab).durationSeconds) * 1000;
    assert(diff < 2, `${name} 差 ${diff.toFixed(2)}ms`);
  }
});

for (const name of ['running status 與力度 0 的 note-off', '同音高重疊（先進先出）', '速度中途改變']) {
  await run(`L1 邊界：${name}`, async () => {
    const ab = FIXTURES[name];
    const { events } = await officialPlayback(ab);
    assertNotesMatch(pairOfficialNotes(events), ourNotesOf(parseMidi(ab)));
  });
}

await runKnownDiff('L1 邊界：同 tick 的速度衝突', 'A3 取先出現者、官方取後出現者；WP-4 的 P 改成後者', async () => {
  const ab = FIXTURES['同 tick 的速度衝突'];
  const { events } = await officialPlayback(ab);
  assertNotesMatch(pairOfficialNotes(events), ourNotesOf(parseMidi(ab)));
});

await run('L1 邊界：兩個 MIDI port——音高、力度、時間一致（channel 取 0～15 那一段比）', async () => {
  const ab = FIXTURES['兩個 MIDI port'];
  const { events } = await officialPlayback(ab);
  assertNotesMatch(pairOfficialNotes(events), ourNotesOf(parseMidi(ab)), { channelOf: (n) => n.ch % 16 });
});

await runKnownDiff('L1 邊界：兩個 MIDI port——絕對 channel', 'parser 不算 port offset（A8）；官方依 port 出現順序 +16；WP-4 的 P／P2 對齊', async () => {
  const ab = FIXTURES['兩個 MIDI port'];
  const { events } = await officialPlayback(ab);
  assertNotesMatch(pairOfficialNotes(events), ourNotesOf(parseMidi(ab)));
});

/* ═══════════════════════════════════════════
   L2 播放對照：排程器發出的音 vs 官方
   ═══════════════════════════════════════════ */

// 假合成器：記下排程器送出的事件與「當下的假時間」。noteOn 發生的那一刻 voice.cursor 還指在這顆音上
// （humanPerformer.js 先 noteOn 再 cursor++），所以能直接記下它對應樂譜裡的哪一顆音。
function makeRecordingSynths(clock, getPerformer) {
  const log = [];
  const make = (label) => ({
    noteOn: (ch, key, vel) => {
      const voice = [...getPerformer()._voices.values()].find((v) => v.channel === ch && (label === 'human') === (v.kind === 'human'));
      log.push({ kind: 'noteOn', label, ch, key, vel, sec: clock.now / 1000, note: voice.notes[voice.cursor] });
    },
    noteOff: (ch, key) => log.push({ kind: 'noteOff', label, ch, key, sec: clock.now / 1000 }),
    programChange: (ch, program) => log.push({ kind: 'program', label, ch, program, sec: clock.now / 1000 }),
    controllerChange: (ch, cc, value) => log.push({ kind: 'cc', label, ch, cc, value, sec: clock.now / 1000 }),
  });
  return { log, assist: make('assist'), human: make('human') };
}

// 排程器整首自動播放（沒有指派）。
function autoPlay(score) {
  const clock = { now: 0 };
  let hp;
  const { log, assist, human } = makeRecordingSynths(clock, () => hp);
  hp = new HumanPerformer();
  hp.setSynths(assist, human);
  hp.load(score, new Map());
  hp.play();
  const none = () => ({ present: false, triggerSeq: 0, slot: null });
  hp.tick(0, none);
  while (!hp.isFinished() && clock.now < (score.durationSeconds + 5) * 1000) { clock.now += 12; hp.tick(clock.now, none); }
  assert(hp.isFinished(), '自動播放沒有播完');
  return log;
}

// 排程器被「完美演奏者」驅動：slot 1 指派 assignedPartIds，每一拍依樂譜秒數 × speed 準時揮一次。
function perform(score, assignedPartIds, speed) {
  const clock = { now: 0 };
  let hp;
  const { log, assist, human } = makeRecordingSynths(clock, () => hp);
  hp = new HumanPerformer();
  hp.setSynths(assist, human);
  hp.load(score, new Map(assignedPartIds.map((id) => [id, 1])));
  hp.play();
  let seq = 0;
  const gesture = (id) => (assignedPartIds.includes(id) ? { present: true, triggerSeq: seq, slot: 1 } : { present: false, triggerSeq: 0, slot: null });
  const b0 = hp._startBeatIndex, beats = hp._beats;
  const waveAt = (k) => 12 + (beats[k].startSeconds - beats[b0].startSeconds) * 1000 * speed;
  let nextBeat = b0;
  hp.tick(0, gesture);
  const endMs = waveAt(beats.length - 1) + 4000 + score.durationSeconds * 1000 * Math.max(0, speed - 1);
  while (clock.now < endMs) {
    clock.now += 12;
    if (nextBeat < beats.length && clock.now >= waveAt(nextBeat)) { seq++; nextBeat++; }
    hp.tick(clock.now, gesture);
  }
  return { log, waveAt };
}

// 把排程器的事件串配成音（同 channel 同音高先進先出，跟官方合成器的語意一致）。
function notesOfLog(log) {
  const pending = new Map(), notes = [];
  for (const e of log) {
    const k = `${e.label}|${e.ch}|${e.key}`;
    if (e.kind === 'noteOn') { const n = { ch: e.ch, key: e.key, vel: e.vel, start: e.sec, end: null, label: e.label, note: e.note }; notes.push(n); if (!pending.has(k)) pending.set(k, []); pending.get(k).push(n); }
    if (e.kind === 'noteOff') { const q = pending.get(k); if (q?.length) q.shift().end = e.sec; }
  }
  return notes;
}
const withoutEnds = (notes) => notes.map((n) => ({ ...n, end: null }));
// 輸出 channel 是排程器自己分配的，跟官方的 channel 號碼無關：只比音高、力度、時間。
const ignoreChannel = () => 0;

for (const name of sampleAssets) {
  await run(`L2 整首自動播放：${name} 的每顆音在官方起音時間之後 12ms（一個排程 tick）內發聲，音高、力度一致`, async () => {
    const ab = readAsset(name);
    const { events } = await officialPlayback(ab);
    const ours = notesOfLog(autoPlay(parseMidi(ab)));
    assertNotesMatch(withoutEnds(pairOfficialNotes(events)), withoutEnds(ours), { channelOf: ignoreChannel, tolStartMs: 12.5 });
  });
}

await runKnownDiff('L2 整首自動播放：每個 note-on 都有一個 note-off（官方合成器對同音高重疊是先進先出，少一個就會卡音）',
  '排程器的 sounding 以音高為鍵＋自己的 tick 量化，讓同音高的下一顆在前一顆 note-off 之前發聲、note-off 遺失；WP-2 改成每音高 FIFO 佇列', async () => {
    const ab = readAsset('canon-violin-cello.mid');
    const log = autoPlay(parseMidi(ab));
    const on = log.filter((e) => e.kind === 'noteOn').length, off = log.filter((e) => e.kind === 'noteOff').length;
    assert(on === off, `note-on ${on} 個、note-off ${off} 個（少 ${on - off} 個＝官方合成器裡會卡住的音）`);
  });

await runKnownDiff('L2 整首自動播放：收音時間跟官方一致（容許兩個 tick＝25ms）',
  '同上：note-off 遺失使配對錯位；WP-2 修正後改成 run()', async () => {
    const ab = readAsset('canon-violin-cello.mid');
    const { events } = await officialPlayback(ab);
    assertNotesMatch(pairOfficialNotes(events), notesOfLog(autoPlay(parseMidi(ab))), { channelOf: ignoreChannel, tolStartMs: 12.5, tolEndMs: 25 });
  });

await run('L2 音色狀態：每顆音發聲當下，它的 channel 上的 program 與 CC7／10／91／93 跟官方一致（canon 的 CC 都是預設值）', async () => {
  const ab = readAsset('canon-violin-cello.mid');
  const { events } = await officialPlayback(ab);
  const ourLog = autoPlay(parseMidi(ab));
  const DEFAULTS = { program: 0, 7: 100, 10: 64, 91: 0, 93: 0 };
  const stateAt = (log, ch, sec, label) => {
    const s = { ...DEFAULTS };
    for (const e of log) {
      if (e.sec > sec + 1e-9) break;
      if (e.ch !== ch || (label && e.label !== label)) continue;
      if (e.kind === 'program') s.program = e.program;
      if (e.kind === 'cc' && e.cc in DEFAULTS) s[e.cc] = e.value;
    }
    return s;
  };
  const sortKey = (a, b) => a.key - b.key || a.vel - b.vel || a.sec - b.sec;
  const theirs = events.filter((e) => e.kind === 'noteOn').sort(sortKey);
  const ours = ourLog.filter((e) => e.kind === 'noteOn').sort(sortKey);
  assert(theirs.length === ours.length, `音數不同：官方 ${theirs.length}／我們 ${ours.length}`);
  const diffs = [];
  for (let i = 0; i < theirs.length; i++) {
    const sa = stateAt(events, theirs[i].ch, theirs[i].sec), sb = stateAt(ourLog, ours[i].ch, ours[i].sec, ours[i].label);
    for (const k of Object.keys(DEFAULTS)) if (sa[k] !== sb[k] && diffs.length < 5) diffs.push(`音高 ${theirs[i].key} @${theirs[i].sec.toFixed(2)}s：${k} 官方 ${sa[k]}／我們 ${sb[k]}`);
  }
  assert(!diffs.length, `音色狀態不一致：\n    ${diffs.join('\n    ')}`);
});

// 完美演奏者（×1）：大提琴指派、小提琴電腦輔助，每一拍依樂譜秒數準時揮手。
const canonPerformer = () => {
  const score = parseMidi(readAsset('canon-violin-cello.mid'));
  return { score, cello: score.parts.find((p) => p.name === '大提琴'), violin: score.parts.find((p) => p.name === '小提琴') };
};

await run('L2 完美演奏者（×1）：音高、力度、顆數跟官方一致（不比時間）', async () => {
  const { events } = await officialPlayback(readAsset('canon-violin-cello.mid'));
  const { score, cello } = canonPerformer();
  assertNotesMatch(withoutEnds(pairOfficialNotes(events)).map((n) => ({ ...n, start: 0 })), withoutEnds(notesOfLog(perform(score, [cello.id], 1).log)).map((n) => ({ ...n, start: 0 })), { channelOf: ignoreChannel });
});

await runKnownDiff('L2 完美演奏者（×1）：每顆音都在官方時間之後 0～26ms 內發聲',
  '指派聲部的相連音要等前一顆音「自然收音」才能發聲，而自然收音是從發聲那一刻起算、又被 12ms tick 量化，每個全音符多 ~10ms，整個合奏越拖越晚（最多約 170ms）；WP-2 讓相連音不擋觸發', async () => {
    const { events } = await officialPlayback(readAsset('canon-violin-cello.mid'));
    const { score, cello } = canonPerformer();
    // 第一次揮手落在第 12ms，各拍再加一個 tick 的量化，所以整體比官方晚 12～26ms。
    const official = pairOfficialNotes(events).map((n) => ({ ...n, start: n.start + 0.012, end: null }));
    assertNotesMatch(official, withoutEnds(notesOfLog(perform(score, [cello.id], 1).log)), { channelOf: ignoreChannel, tolStartMs: 14.5 });
  });

/* ═══════════════════════════════════════════
   L3 同步不變量（不靠官方）
   ═══════════════════════════════════════════ */

// 樂譜上同一時刻（startSeconds 相同）的「電腦輔助小提琴」與「指派大提琴」音，實際發聲時間差。
function simultaneityReport(speed) {
  const { score, cello, violin } = canonPerformer();
  const { log, waveAt } = perform(score, [cello.id], speed);
  const onsets = log.filter((e) => e.kind === 'noteOn').map((e) => ({ label: e.label, note: e.note, ms: e.sec * 1000 }));
  const pairs = [];
  for (const v of onsets.filter((o) => o.note.partId === violin.id)) {
    const c = onsets.find((o) => o.note.partId === cello.id && Math.abs(o.note.startSeconds - v.note.startSeconds) < 1e-6);
    if (c) pairs.push(v.ms - c.ms);
  }
  const earlyAssist = onsets.filter((o) => o.label === 'assist' && o.ms < waveAt(o.note.beatIndex) - 1).length;
  return { pairs: pairs.length, maxAbs: Math.max(...pairs.map(Math.abs)), earlyAssist };
}

for (const speed of [1, 1.3, 0.8]) {
  await runKnownDiff(`L3 同步：演奏者速度 ×${speed}，同一樂譜時刻的指派音與電腦輔助音實際發聲差 ≤ 12ms，且輔助音不早於該拍揮手`,
    '①電腦輔助聲部用含等號的邊界先響下一拍的第一顆音（慢的演奏者）②指派聲部的相連音排隊鏈讓它越來越晚（準時的演奏者也會）；WP-2 修正後改成 run()', async () => {
      const r = simultaneityReport(speed);
      assert(r.pairs > 30, `前提：要有足夠的配對（實際 ${r.pairs} 對）`);
      assert(r.maxAbs <= 12.5 && r.earlyAssist === 0, `${r.pairs} 對中最大發聲差 ${r.maxAbs.toFixed(0)}ms；${r.earlyAssist} 顆輔助音比該拍揮手早出聲`);
    });
}

console.log('\n全部測試跑完。');
