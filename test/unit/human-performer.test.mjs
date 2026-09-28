// ============================================================
//  human-performer.test.mjs — src/midi/humanPerformer.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟 test/browser/smoke-test.mjs 同一套風格：run()／assert() 是整個專案
//  唯一的測試慣例。假 synth 只實作 controllerChange／programChange／noteOn／noteOff，
//  每 12ms 呼叫一次 tick()，跟 midiPlayer.js 的排程 tick 一致。
//
//  用法：node test/unit/human-performer.test.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { HumanPerformer } from '../../src/midi/humanPerformer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANON_PATH = join(__dirname, '../../src/assets/canon-violin-cello.mid');

function makeFakeSynth(log, label) {
  return {
    controllerChange: (ch, cc, val) => log.push({ t: 'cc', label, ch, cc, val }),
    programChange: () => {},
    noteOn: (ch, note, vel) => log.push({ t: 'on', label, ch, note, vel }),
    noteOff: (ch, note) => log.push({ t: 'off', label, ch, note }),
  };
}
function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

function makeHp(score, assignments) {
  const log = [];
  const hp = new HumanPerformer();
  hp.setSynths(makeFakeSynth(log, 'accomp'), makeFakeSynth(log, 'human'));
  hp.load(score, new Map(assignments));
  hp.play();
  return { hp, log };
}

/* ═══════════════════════════════════════════
   合成測試譜：4/4、120 BPM，拍長 0.5s，方便算精確秒數
   ═══════════════════════════════════════════ */

// 音符用短時值（斷奏，遠短於拍長），這樣快速連續觸發不會撞上「有音在響就排隊」的閘門
// ——大部分測試要單獨測「一次一拍」本身，不是要測排隊機制（排隊機制另外有專門的測試）。
function buildScoreWithGaps() {
  const tpq = 480;
  const beatSec = 0.5;
  const notesSpec = [0, 2, 4, 6]; // beatIndex，1/3/5/7 是空拍
  const notes = notesSpec.map((b, i) => ({
    partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 60 + i, velocity: 100,
    startTick: b * tpq, endTick: b * tpq + 24,
    startSeconds: b * beatSec, endSeconds: b * beatSec + 0.025, durationSeconds: 0.025,
  }));
  return {
    parts: [{ id: 'p0', trackIndex: 0, channel: 0, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } }],
    notes, durationSeconds: 4, durationTicks: 8 * tpq, ticksPerQuarter: tpq,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    tickToSeconds: (t) => (t / tpq) * (60 / 120),
  };
}

// 一顆全音符（4 拍長，橫跨拍 0~3），之後拍 4 又有一顆短音符。
function buildScoreWithLongNote() {
  const tpq = 480;
  const beatSec = 0.5;
  const notes = [
    { partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 60, velocity: 100,
      startTick: 0, endTick: 4 * tpq, startSeconds: 0, endSeconds: 4 * beatSec, durationSeconds: 4 * beatSec },
    { partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 62, velocity: 100,
      startTick: 4 * tpq, endTick: 4 * tpq + 24,
      startSeconds: 4 * beatSec, endSeconds: 4 * beatSec + 0.025, durationSeconds: 0.025 },
  ];
  return {
    parts: [{ id: 'p0', trackIndex: 0, channel: 0, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } }],
    notes, durationSeconds: 4, durationTicks: 8 * tpq, ticksPerQuarter: tpq,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    tickToSeconds: (t) => (t / tpq) * (60 / 120),
  };
}

/* ═══════════════════════════════════════════
   核心模型：一次觸發只走一拍（取代舊版跳到下一個有音符的拍）
   ═══════════════════════════════════════════ */

run('完美演奏者每拍揮手一次（含空拍）：共用拍位一拍一拍走，不會跳過任何拍', () => {
  const score = buildScoreWithGaps();
  const { hp, log } = makeHp(score, [['p0', 1]]);
  let seq = 0;
  const getGesture = () => ({ present: true, triggerSeq: seq, slot: 1 });
  let nowMs = 0;
  const TICK = 12;
  function tick() { nowMs += TICK; hp.tick(nowMs, getGesture); }
  // 每次觸發之間先讓真實時間走完一整拍，模擬演奏者跟上原譜節奏——這樣上一顆音（25ms 就
  // 放完）早就放完了，不會撞上排隊閘門。
  function gestureOnce() { seq++; tick(); while (nowMs < seq * 500 + 100) tick(); }

  tick(); // 基準 tick，不算觸發
  // 樂譜只有 4 顆音符（beatIndex 0/2/4/6），走到最後一顆恰好需要 7 次觸發（第 1 次就地
  // claim 拍 0，之後每次都只走一拍）。
  const beatIndexesSeen = [];
  for (let b = 0; b < 7; b++) { gestureOnce(); beatIndexesSeen.push(hp._beatIndex); }
  for (let i = 0; i < beatIndexesSeen.length; i++) {
    assert(beatIndexesSeen[i] === i, `第 ${i + 1} 次觸發後 _beatIndex 應該是 ${i}，實際 ${beatIndexesSeen[i]}`);
  }
  assert(log.filter((e) => e.t === 'on').length === 4, '4 顆音符應該全部發聲');

  // 沒有更多音符時，多觸發一次應該正確進入終局，_beatIndex 停在最後一次合法的拍。
  gestureOnce();
  assert(hp._beatIndex === 6, `沒有更多音符時 _beatIndex 應該停在 6，實際 ${hp._beatIndex}`);
});

run('完全不揮手：代打一拍一拍走過空拍，到有音符的拍就停下等真人', () => {
  const score = buildScoreWithGaps();
  const { hp, log } = makeHp(score, [['p0', 1]]);
  const voice = hp._voices.get('p0');
  let seq = 0;
  const getGesture = () => ({ present: true, triggerSeq: seq, slot: 1 });
  let nowMs = 0;
  const TICK = 12;
  function tick() { nowMs += TICK; hp.tick(nowMs, getGesture); }

  tick();
  seq = 1; tick(); // 觸發拍 0，之後完全不揮手
  assert(hp._beatIndex === 0, '觸發拍 0 之後應該在拍 0');

  while (nowMs < 2000 && hp._beatIndex < 1) tick();
  assert(hp._beatIndex === 1, `代打應該自動走到拍 1（空拍），實際停在 ${hp._beatIndex}`);
  assert(voice.isAutopilot === true, '走過空拍時應該標記為代打來源');

  // 拍 2 有音符：代打不該再自動往前走。
  const startWaitMs = nowMs;
  while (nowMs < startWaitMs + 3000) tick();
  assert(hp._beatIndex === 1, `拍 2 有音符，代打不該自己往前走，實際變成 ${hp._beatIndex}`);
  assert(log.filter((e) => e.t === 'on' && e.note === 61).length === 0, '拍 2 的音符不該被代打自動觸發');

  seq = 2; tick(); // 真人觸發
  assert(hp._beatIndex === 2, `真人觸發後應該走到拍 2，實際 ${hp._beatIndex}`);
  assert(log.filter((e) => e.t === 'on' && e.note === 61).length === 1, '真人觸發後拍 2 的音符應該發聲');
  assert(voice.isAutopilot === false, '真人觸發後應該標記為真人來源');
});

run('全音符只需要觸發一次，佔用的後續拍被代打當空拍自動走過', () => {
  const score = buildScoreWithLongNote();
  const { hp, log } = makeHp(score, [['p0', 1]]);
  let seq = 0;
  const getGesture = () => ({ present: true, triggerSeq: seq, slot: 1 });
  let nowMs = 0;
  const TICK = 12;
  function tick() { nowMs += TICK; hp.tick(nowMs, getGesture); }

  tick();
  seq = 1; tick(); // 觸發全音符（拍 0，長度 4 拍）
  const triggerMs = nowMs;

  // 代打要等全音符真的放完（2s）才可能啟動，之後自動走過拍 1/2/3（都被全音符佔用，視為
  // 空拍），停在拍 3——拍 4 已經有新音符，不會自己走最後一步。
  while (nowMs < triggerMs + 6000 && hp._beatIndex < 3) tick();
  assert(hp._beatIndex === 3, `代打應該走到拍 3、在有音符的拍 4 前面停下，實際 ${hp._beatIndex}`);
  assert(log.filter((e) => e.t === 'off' && e.note === 60).length === 1, '全音符應該完整播完一次（不被跳拍提前掐斷）');

  const waitFrom = nowMs;
  while (nowMs < waitFrom + 3000) tick();
  assert(hp._beatIndex === 3, '代打不該自己走進拍 4');
  assert(log.filter((e) => e.t === 'on' && e.note === 62).length === 0, '拍 4 的音符不該被代打自動觸發');

  seq = 2; tick();
  assert(hp._beatIndex === 4, `真人觸發後應該走到拍 4，實際 ${hp._beatIndex}`);
  assert(log.filter((e) => e.t === 'on' && e.note === 62).length === 1, '真人觸發後拍 4 的音符應該發聲');
});

run('音符已放完後在同一拍多揮一次手：正確前進一拍，不會誤判、不會重複觸發', () => {
  const tpq = 480, beatSec = 0.5;
  const notes = [0, 3].map((b, i) => ({
    partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 60 + i, velocity: 100,
    startTick: b * tpq, endTick: b * tpq + 24,
    startSeconds: b * beatSec, endSeconds: b * beatSec + 0.025, durationSeconds: 0.025,
  }));
  const score = {
    parts: [{ id: 'p0', trackIndex: 0, channel: 0, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } }],
    notes, durationSeconds: 4, durationTicks: 8 * tpq, ticksPerQuarter: tpq,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    tickToSeconds: (t) => (t / tpq) * (60 / 120),
  };
  const { hp, log } = makeHp(score, [['p0', 1]]);
  const voice = hp._voices.get('p0');
  let seq = 0;
  const getGesture = () => ({ present: true, triggerSeq: seq, slot: 1 });
  let nowMs = 0;
  function tick() { nowMs += 12; hp.tick(nowMs, getGesture); }

  tick();
  seq = 1; tick();
  while (nowMs < 200) tick(); // 讓音確實放完
  assert(hp._beatIndex === 0 && voice.sounding.size === 0, '第一次觸發後應該在拍 0、音已放完');

  // 這一拍的音已經放完，「多揮一次」應該正確前進到空拍 1，而不是被誤判成「這拍還有事」
  // 原地不動（舊模型「跳到下一個有音符的拍」才有的空 claim 問題，見計畫檔）。
  seq = 2; tick();
  assert(hp._beatIndex === 1, `多揮一次應該前進到拍 1，實際 ${hp._beatIndex}`);
  seq = 3; tick();
  seq = 4; tick();
  assert(hp._beatIndex === 3, `連續觸發應該依序走到拍 3，實際 ${hp._beatIndex}`);
  assert(log.filter((e) => e.t === 'on').length === 2, '全程應該只發過 2 次音（拍 0、拍 3 各一次）');
});

run('canon 雙人：一位休止、一位正常演奏，_beatIndex 每次最多前進 1（不會出現大跳誤判）', () => {
  const cscore = parseMidi(new Uint8Array(readFileSync(CANON_PATH)));
  const violin = cscore.parts.find((p) => p.name === '小提琴');
  const cello = cscore.parts.find((p) => p.name === '大提琴');
  const { hp } = makeHp(cscore, [[violin.id, 1], [cello.id, 2]]);

  let violinSeq = 0, celloSeq = 0;
  const getGesture = (partId) => {
    if (partId === violin.id) return { present: true, triggerSeq: violinSeq, slot: 1 };
    if (partId === cello.id) return { present: true, triggerSeq: celloSeq, slot: 2 };
    return { present: false, triggerSeq: 0, slot: null };
  };
  let nowMs = 0;
  function tick() { nowMs += 12; hp.tick(nowMs, getGesture); }

  tick();
  let prevBeatIndex = hp._beatIndex, maxJump = 0;
  for (let i = 0; i < 400; i++) {
    if (i % 5 === 0) celloSeq++; // 大提琴頻繁觸發，小提琴完全不揮手
    tick();
    maxJump = Math.max(maxJump, hp._beatIndex - prevBeatIndex);
    prevBeatIndex = hp._beatIndex;
  }
  assert(maxJump <= 1, `_beatIndex 每次最多只能前進 1，實際量到最大跳幅 ${maxJump}`);
});

/* ═══════════════════════════════════════════
   排隊機制：新舊音不重疊、排隊解除時補回等待掉的時間
   ═══════════════════════════════════════════ */

run('排隊解除時補回等待掉的播放時間，不會永久落後一拍', () => {
  const tpq = 480, beatSec = 0.5;
  const notes = [
    { partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 60, velocity: 100,
      startTick: 0, endTick: Math.round(0.6 / beatSec * tpq), startSeconds: 0, endSeconds: 0.6, durationSeconds: 0.6 },
    { partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 61, velocity: 100,
      startTick: 4 * tpq, endTick: 4 * tpq + 24, startSeconds: 2.0, endSeconds: 2.025, durationSeconds: 0.025 },
  ];
  const score = {
    parts: [{ id: 'p0', trackIndex: 0, channel: 0, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } }],
    notes, durationSeconds: 4, durationTicks: 8 * tpq, ticksPerQuarter: tpq,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    tickToSeconds: (t) => (t / tpq) * (60 / 120),
  };
  const { hp, log } = makeHp(score, [['p0', 1]]);
  const voice = hp._voices.get('p0');
  let seq = 0;
  const getGesture = () => ({ present: true, triggerSeq: seq, slot: 1 });
  let nowMs = 0;
  function tick() { nowMs += 12; hp.tick(nowMs, getGesture); }

  tick();
  seq = 1; tick(); // 觸發 beat 0（音長 0.6s，跨過 beat 1 起點）
  while (nowMs < 500) tick();
  seq = 2; tick(); // 演奏者準時觸發 beat 1，舊音還在響（要到 0.6s 才結束）——應該排隊
  assert(voice.pendingTrigger === true, '舊音還在響時，這次觸發應該被排隊');

  const beatBefore = hp._beatIndex;
  while (voice.pendingTrigger && nowMs < 2000) tick(); // 等舊音放完，排隊自動解除
  assert(voice.pendingTrigger === false, '舊音放完後排隊應該自動解除');
  assert(hp._beatIndex === beatBefore + 1, '排隊解除後應該正確走到下一拍');
  assert(voice.playSec > 0.55 && voice.playSec <= 0.61,
    `playSec 應該補回等待掉的時間、接近 0.6，實際 ${voice.playSec.toFixed(3)}`);
  assert(log.filter((e) => e.t === 'on' && e.note === 61).length === 0, '遠處的音不該被排隊補償提早觸發');
});

/* ═══════════════════════════════════════════
   用真實 canon 檔案跑的既有回歸（音長不被拍速縮放、代打不打斷正在響的音、
   從未觸發過的聲部維持靜音、play() 恢復播放不誤判、CC7 音量對比）
   ═══════════════════════════════════════════ */

const canonScore = parseMidi(new Uint8Array(readFileSync(CANON_PATH)));
const canonCello = canonScore.parts.find((p) => p.name === '大提琴');
const canonViolin = canonScore.parts.find((p) => p.name === '小提琴');

run('單次觸發的音準時播完（不被縮放）＋之後代打在 800ms 準時啟動', () => {
  const { hp, log } = makeHp(canonScore, [[canonCello.id, 1]]);
  let seq = 0;
  const getGesture = (partId) => partId === canonCello.id
    ? { present: true, triggerSeq: seq, slot: 1 } : { present: false, triggerSeq: 0, slot: null };
  const voice = hp._voices.get(canonCello.id);
  let nowMs = 0;
  const TICK = 12;
  function tick(ms) { for (let t = 0; t < ms; t += TICK) { nowMs += TICK; hp.tick(nowMs, getGesture); } }

  tick(TICK);
  seq = 1; tick(TICK);
  const triggerMs = nowMs;
  assert(voice.sounding.size > 0, '觸發後這個聲部應該立刻有音在響');
  const [, firstSounding] = [...voice.sounding][0];
  const notatedDurationSec = firstSounding.remain;

  let soundingClearedAtMs = null;
  while (nowMs < triggerMs + notatedDurationSec * 1000 + 2000) {
    nowMs += TICK; hp.tick(nowMs, getGesture);
    if (voice.sounding.size === 0) { soundingClearedAtMs = nowMs; break; }
  }
  const actualSoundedMs = soundingClearedAtMs - triggerMs;
  assert(Math.abs(actualSoundedMs - notatedDurationSec * 1000) <= TICK * 2,
    `發聲時長應該等於原譜時長（±1~2 tick），實際差距 ${actualSoundedMs - notatedDurationSec * 1000}ms`);

  let autopilotFiredAtMs = null;
  while (nowMs < triggerMs + notatedDurationSec * 1000 + 5000) {
    nowMs += TICK; hp.tick(nowMs, getGesture);
    if (voice.isAutopilot) { autopilotFiredAtMs = nowMs; break; }
  }
  assert(autopilotFiredAtMs != null, '代打應該要啟動');
  assert(autopilotFiredAtMs >= soundingClearedAtMs, '代打不該在音放完之前就啟動');
});

run('代打絕不提早打斷正在響的音', () => {
  const { hp } = makeHp(canonScore, [[canonCello.id, 1]]);
  let seq = 0;
  const getGesture = (partId) => partId === canonCello.id
    ? { present: true, triggerSeq: seq, slot: 1 } : { present: false, triggerSeq: 0, slot: null };
  const voice = hp._voices.get(canonCello.id);
  let nowMs = 0;
  function tick() { nowMs += 12; hp.tick(nowMs, getGesture); }
  tick();

  let longNoteStartMs = null, longNoteDur = null;
  for (let i = 0; i < 200 && longNoteStartMs == null; i++) {
    seq++; tick();
    for (const [, s] of voice.sounding) if (s.remain >= 1.5) { longNoteStartMs = nowMs; longNoteDur = s.remain; break; }
  }
  assert(longNoteStartMs != null, '樣本曲子裡應該找得到一顆夠長的音（測試前提）');

  let sawAutopilotWhileSounding = false;
  while (nowMs < longNoteStartMs + longNoteDur * 1000 - 20) {
    tick();
    if (voice.sounding.size > 0 && voice.isAutopilot) { sawAutopilotWhileSounding = true; break; }
  }
  assert(!sawAutopilotWhileSounding, '正在響的長音期間不應該出現代打（會等於提早打斷）');
});

run('從未觸發過的聲部不會自動代打', () => {
  const { hp, log } = makeHp(canonScore, [[canonCello.id, 1], [canonViolin.id, 2]]);
  const getGesture = (partId) => {
    if (partId === canonCello.id) return { present: false, triggerSeq: 0, slot: 1 };
    if (partId === canonViolin.id) return { present: false, triggerSeq: 0, slot: 2 };
    return { present: false, triggerSeq: 0, slot: null };
  };
  let nowMs = 0;
  for (let i = 0; i < 500; i++) { nowMs += 12; hp.tick(nowMs, getGesture); } // 模擬 6 秒
  assert(log.filter((e) => e.t === 'on' && e.label === 'human').length === 0, '從未觸發過的聲部應該完全靜音');
});

run('play() 恢復播放時重新武裝靜止計時，不會立刻誤判代打', () => {
  const { hp, log } = makeHp(canonScore, [[canonCello.id, 1]]);
  let seq = 0;
  const getGesture = (partId) => partId === canonCello.id
    ? { present: true, triggerSeq: seq, slot: 1 } : { present: false, triggerSeq: 0, slot: null };
  let nowMs = 0;
  nowMs += 12; hp.tick(nowMs, getGesture);
  seq++; nowMs += 500; hp.tick(nowMs, getGesture);
  hp.pause();
  hp.play();
  const afterResumeLogStart = log.length;
  let resumeNowMs = performance.now();
  for (let i = 0; i < 50; i++) { resumeNowMs += 12; hp.tick(resumeNowMs, getGesture); } // 600ms
  assert(!log.slice(afterResumeLogStart).some((e) => e.t === 'cc' && e.val === 64), '恢復播放後 600ms 內不應該立刻代打');
});

run('AUTOPILOT_VOLUME_CC 是 85：真人觸發送 CC7=100，代打送 CC7=85', () => {
  const { hp, log } = makeHp(canonScore, [[canonCello.id, 1]]);
  let seq = 0;
  const getGesture = (partId) => partId === canonCello.id
    ? { present: true, triggerSeq: seq, slot: 1 } : { present: false, triggerSeq: 0, slot: null };
  let nowMs = 0;
  function tick() { nowMs += 12; hp.tick(nowMs, getGesture); }
  tick();
  seq = 1; tick();
  const cc7 = () => log.filter((e) => e.t === 'cc' && e.cc === 7 && e.label === 'human').map((e) => e.val);
  assert(cc7().includes(100), '真實觸發應該送過 CC7=100');
  while (nowMs < 5000) tick();
  assert(cc7().includes(85), `代打應該送 CC7=85，實際送過：${[...new Set(cc7())]}`);
});

// 「真實觸發排隊解決後來源正確標記為真人」這個情境（先前用代打的音還在響、真人觸發撞上排隊）
// 在目前的代打設計下已經不可能發生：代打只會在確認下一拍沒有音符時才啟動、且從不自己 claim
// 有音符的拍，代打本身永遠不會讓 voice.sounding 變成非空——也就是說 pendingIsAutopilot 這個
// 欄位（排隊來源標記）目前只會被寫成 false，沒有任何路徑會寫成 true。這是既有欄位，不是這輪
// 改動造成的死程式碼，這裡不刪，只記錄測試因此拿掉的原因。

console.log('\n全部測試跑完。');
