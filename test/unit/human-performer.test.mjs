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
import { isDeepStrictEqual } from 'node:util';
import { parseMidi, buildBeatGrid } from '../../src/midi/midiParser.js';
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
  hp.setSynths(makeFakeSynth(log, 'assist'), makeFakeSynth(log, 'human'));
  hp.load(score, new Map(assignments));
  hp.play();
  return { hp, log };
}

/* ═══════════════════════════════════════════
   合成測試譜：4/4、120 BPM，拍長 0.5s，方便算精確秒數
   ═══════════════════════════════════════════ */

// 音符用短時值（斷奏，遠短於拍長），這樣快速連續觸發不會撞上「會開新音、舊音又還在響就排隊」的
// 閘門——大部分測試要單獨測「一次一拍」本身，不是要測排隊機制（排隊機制另外有專門的測試）。
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

  const voice = hp._voices.get('p0');
  tick();
  seq = 1; tick(); // 觸發全音符（拍 0，長度 4 拍）
  const triggerMs = nowMs;

  // 代打自動走過拍 1/2/3（都被全音符佔用，視為空拍），停在拍 3——拍 4 已經有新音符，不會自己走最後
  // 一步。走過空拍不會開任何新音，所以不必等全音符放完：走到拍 2（約 1.6s）時全音符（2s）還在響。
  let soundingAtBeat2 = null;
  while (nowMs < triggerMs + 6000 && hp._beatIndex < 3) {
    tick();
    if (hp._beatIndex === 2 && soundingAtBeat2 === null) soundingAtBeat2 = voice.sounding.size;
  }
  assert(hp._beatIndex === 3, `代打應該走到拍 3、在有音符的拍 4 前面停下，實際 ${hp._beatIndex}`);
  assert(soundingAtBeat2 === 1, `代打走到拍 2 時全音符應該還在響（不必等它放完），實際 sounding=${soundingAtBeat2}`);
  while (voice.sounding.size > 0 && nowMs < triggerMs + 6000) tick();
  assert(log.filter((e) => e.t === 'off' && e.note === 60).length === 1, '全音符應該完整播完一次（不被跳拍提前掐斷）');
  assert(Math.abs(nowMs - triggerMs - 2000) <= 30, `全音符應該照原譜 2s 響完，實際 ${nowMs - triggerMs}ms`);

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
  // 拍 0 的 0.6s 長音跨過拍 1 起點；拍 1 的第一顆新音落在拍內 0.2s 處（0.7s）。拍 1 的觸發會開這顆新音、
  // 舊音又還在響，所以要排隊（拍 1 若是空拍就不會排隊，見 Task D 的測試）。
  const tpq = 480, beatSec = 0.5;
  const notes = [
    { partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 60, velocity: 100,
      startTick: 0, endTick: Math.round(0.6 / beatSec * tpq), startSeconds: 0, endSeconds: 0.6, durationSeconds: 0.6 },
    { partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 61, velocity: 100,
      startTick: 672, endTick: 672 + 24, startSeconds: 0.7, endSeconds: 0.725, durationSeconds: 0.025 },
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
  let nowMs = 0, seen = 0;
  const onAt = {}; // 音高 → note-on 的假時間
  function tick() {
    nowMs += 12; hp.tick(nowMs, getGesture);
    for (; seen < log.length; seen++) if (log[seen].t === 'on') onAt[log[seen].note] = nowMs;
  }

  tick();
  seq = 1; tick(); // 觸發 beat 0（音長 0.6s，跨過 beat 1 起點）
  while (nowMs < 500) tick();
  seq = 2; tick(); // 演奏者準時觸發 beat 1，舊音還在響（要到 0.6s 才結束）——這拍有新音，應該排隊
  assert(voice.pendingTrigger === true, '舊音還在響、這次觸發又會開新音，應該被排隊');

  const beatBefore = hp._beatIndex;
  while (voice.pendingTrigger && nowMs < 2000) tick(); // 等舊音放完，排隊自動解除
  assert(voice.pendingTrigger === false, '舊音放完後排隊應該自動解除');
  assert(hp._beatIndex === beatBefore + 1, '排隊解除後應該正確走到下一拍');
  // 理想值＝排隊起點的播放頭 0.5 ＋ 等掉的 ~0.11s ＋ 解除那個 tick 自己的 12ms 前進≈0.62：跟
  // 「觸發當下立刻生效」的時序一致（舊流程的排隊解除發生在播放頭前進之後，少算了那 12ms）。
  // 沒有補償的話會停在 0.5 永久落後一拍，這才是要抓的東西。
  assert(Math.abs(voice.playSec - 0.62) <= 0.02,
    `playSec 應該補回等待掉的時間、接近 0.62，實際 ${voice.playSec.toFixed(3)}`);
  assert(onAt[61] === undefined, '還沒到時間的音不該被排隊補償提早觸發');

  // 行為面：補償的意義是後續的音回到原譜節奏——61 應該落在「第一顆音之後 0.7s」附近（容許一個排程 tick
  // 的量化誤差）；沒有補償的話它會晚將近 0.1s（等掉的那段時間）。
  while (onAt[61] === undefined && nowMs < 3000) tick();
  const gapMs = onAt[61] - onAt[60];
  assert(Math.abs(gapMs - 700) <= 30, `61 應該在 60 之後約 700ms 發聲（原譜間隔），實際 ${gapMs}ms`);
});

/* ═══════════════════════════════════════════
   用真實 canon 檔案跑的既有回歸（音長不被拍速縮放、代打不打斷正在響的音、
   從未觸發過的聲部維持靜音、play() 恢復播放不誤判、CC7 音量對比）
   ═══════════════════════════════════════════ */

const canonScore = parseMidi(new Uint8Array(readFileSync(CANON_PATH)));
const canonCello = canonScore.parts.find((p) => p.name === '大提琴');
const canonViolin = canonScore.parts.find((p) => p.name === '小提琴');

run('單次觸發的音準時播完（不被縮放）＋代打在停手 800ms 準時啟動（走空拍不必等音放完）', () => {
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

  let soundingClearedAtMs = null, autopilotFiredAtMs = null;
  while (nowMs < triggerMs + notatedDurationSec * 1000 + 2000 && (soundingClearedAtMs === null || autopilotFiredAtMs === null)) {
    nowMs += TICK; hp.tick(nowMs, getGesture);
    if (soundingClearedAtMs === null && voice.sounding.size === 0) soundingClearedAtMs = nowMs;
    if (autopilotFiredAtMs === null && voice.isAutopilot) autopilotFiredAtMs = nowMs;
  }
  const actualSoundedMs = soundingClearedAtMs - triggerMs;
  assert(Math.abs(actualSoundedMs - notatedDurationSec * 1000) <= TICK * 2,
    `發聲時長應該等於原譜時長（±1~2 tick），實際差距 ${actualSoundedMs - notatedDurationSec * 1000}ms`);

  // 下一拍是空拍（全音符還佔著）：停手滿 AUTOPILOT_IDLE_MS 就走，不管舊音放完了沒有。
  assert(autopilotFiredAtMs != null, '代打應該要啟動');
  const idleMs = autopilotFiredAtMs - triggerMs;
  assert(idleMs >= 800 && idleMs <= 800 + TICK * 2, `代打應該在停手 800ms 後啟動（±2 tick），實際 ${idleMs}ms`);
  assert(autopilotFiredAtMs < soundingClearedAtMs, '走過空拍不必等舊音放完：代打應該在長音還在響的時候就啟動');
});

run('代打走過空拍絕不提早打斷正在響的音：長音的 noteOff 落在起音＋原譜時長', () => {
  const { hp, log } = makeHp(canonScore, [[canonCello.id, 1]]);
  let seq = 0;
  const getGesture = (partId) => partId === canonCello.id
    ? { present: true, triggerSeq: seq, slot: 1 } : { present: false, triggerSeq: 0, slot: null };
  const voice = hp._voices.get(canonCello.id);
  let nowMs = 0, seen = 0;
  const offAt = {};
  function tick() {
    nowMs += 12; hp.tick(nowMs, getGesture);
    for (; seen < log.length; seen++) if (log[seen].t === 'off') offAt[log[seen].note] = offAt[log[seen].note] ?? nowMs;
  }
  tick();

  let longNoteStartMs = null, longNoteDur = null, longNotePitch = null;
  for (let i = 0; i < 200 && longNoteStartMs == null; i++) {
    seq++; tick();
    for (const [pitch, s] of voice.sounding) if (s.remain >= 1.5) { longNoteStartMs = nowMs; longNoteDur = s.remain; longNotePitch = pitch; break; }
  }
  assert(longNoteStartMs != null, '樣本曲子裡應該找得到一顆夠長的音（測試前提）');

  // 之後完全不揮手：代打會在長音還在響時自己走過空拍（這是預期行為），但絕不能因此切斷或拉長它。
  let sawAutopilotWhileSounding = false;
  while (offAt[longNotePitch] === undefined && nowMs < longNoteStartMs + longNoteDur * 1000 + 2000) {
    tick();
    if (voice.sounding.has(longNotePitch) && voice.isAutopilot) sawAutopilotWhileSounding = true;
  }
  assert(sawAutopilotWhileSounding, '前提：長音期間代打應該有動作，否則這個測試沒有驗證到「代打不打斷」');
  const soundedMs = offAt[longNotePitch] - longNoteStartMs;
  assert(Math.abs(soundedMs - longNoteDur * 1000) <= 24,
    `代打走空拍期間，長音應該照原譜 ${(longNoteDur * 1000).toFixed(0)}ms 響完，實際 ${soundedMs}ms`);
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
  const d = makeDriver(hp, { [canonCello.id]: 1 });
  d.tick(); d.trigger(); d.tick();                    // 真人觸發一次：送 CC7=100，代打倒數開始
  hp.pause();
  d.runMs(5000);                                      // 暫停很久（假時鐘照走）
  hp.play();
  const afterResumeLogStart = log.length;
  d.runMs(600);                                       // 恢復後 600ms：還不到代打的第一步
  const cc7 = log.slice(afterResumeLogStart).filter((e) => e.t === 'cc' && e.cc === 7).map((e) => e.val);
  assert(!cc7.includes(85), `恢復播放後 600ms 內不應該立刻代打（代打會把 CC7 切到 85），實際送出 ${cc7}`);
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

/* ═══════════════════════════════════════════
   重設／重播（Task S1）：stop() 與 restart() 共用同一個重設函式 _resetPlayback()
   ═══════════════════════════════════════════ */

// p0 指派給演奏者 1（拍 0、2、4、6 各一顆短音）、p1 不指派＝電腦輔助（每拍一顆短音）：
// 重設要同時覆蓋「指派聲部」與「電腦輔助聲部」兩條路徑。
function buildTwoPartScore() {
  const tpq = 480, beatSec = 0.5;
  const mk = (partId, note, b) => ({
    partId, trackIndex: partId === 'p0' ? 0 : 1, channel: partId === 'p0' ? 0 : 1, program: 0, note, velocity: 100,
    startTick: b * tpq, endTick: b * tpq + 24,
    startSeconds: b * beatSec, endSeconds: b * beatSec + 0.025, durationSeconds: 0.025,
  });
  const notes = [];
  for (const b of [0, 2, 4, 6]) notes.push(mk('p0', 60 + b / 2, b));
  for (let b = 0; b < 8; b++) notes.push(mk('p1', 72 + b, b));
  notes.sort((a, c) => a.startTick - c.startTick);
  const part = (id, i) => ({ id, trackIndex: i, channel: i, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } });
  return {
    parts: [part('p0', 0), part('p1', 1)],
    notes, durationSeconds: 4, durationTicks: 8 * tpq, ticksPerQuarter: tpq,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    tickToSeconds: (t) => (t / tpq) * (60 / 120),
  };
}

// 剛 load() 完、還沒 play()：makeHp() 會直接 play()，拿不到「剛載入」的狀態快照。
function makeHpUnplayed(score, assignments) {
  const log = [];
  const hp = new HumanPerformer();
  hp.setSynths(makeFakeSynth(log, 'assist'), makeFakeSynth(log, 'human'));
  hp.load(score, new Map(assignments));
  return { hp, log };
}

// 假時鐘＋可腳本化的手勢。slotOf：partId → 演奏者槽位，沒列的當作沒指派。
// trigger(1, 2)＝槽位 1 與 2 的演奏者「同時」各做一次有效手勢（各自的觸發計數 +1）；不帶參數＝槽位 1。
function makeDriver(hp, slotOf = {}) {
  let nowMs = 0;
  const seqs = {};
  const getGesture = (partId) => (partId in slotOf
    ? { present: true, triggerSeq: seqs[slotOf[partId]] ?? 0, slot: slotOf[partId] }
    : { present: false, triggerSeq: 0, slot: null });
  return {
    tick() { nowMs += 12; hp.tick(nowMs, getGesture); },
    runMs(ms) { const end = nowMs + ms; while (nowMs < end) { nowMs += 12; hp.tick(nowMs, getGesture); } },
    trigger(...slots) { for (const s of (slots.length ? slots : [1])) seqs[s] = (seqs[s] ?? 0) + 1; },
    get nowMs() { return nowMs; },
  };
}

// 排程器目前所有「會變」的狀態快照。刻意用「取全部欄位、只排除載入後不變的東西」而不是列舉欄位：
// 之後任何新增的狀態欄位（合奏代打、延長段…）忘了在 _resetPlayback() 重設，比對就會直接抓到。
function stateSnapshot(hp) {
  const state = {};
  for (const [k, v] of Object.entries(hp)) {
    if (k === 'cfg' || k === '_score' || k === '_beats' || k === '_voices' || k === 'unplacedPartIds') continue;
    if (v && typeof v.noteOn === 'function') continue; // 合成器物件
    state[k] = v;
  }
  const voices = {};
  for (const [id, voice] of hp._voices) { const { notes, ...rest } = voice; voices[id] = rest; }
  return structuredClone({ state, voices });
}
function snapshotDiffs(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.state), ...Object.keys(b.state)])) {
    if (!isDeepStrictEqual(a.state[k], b.state[k])) out.push(k);
  }
  for (const id of new Set([...Object.keys(a.voices), ...Object.keys(b.voices)])) {
    for (const k of new Set([...Object.keys(a.voices[id] || {}), ...Object.keys(b.voices[id] || {})])) {
      if (!isDeepStrictEqual(a.voices[id]?.[k], b.voices[id]?.[k])) out.push(`${id}.${k}`);
    }
  }
  return out;
}

run('重設把排程器退回「剛載入」的狀態：播放中／暫停／播完三種情況，stop() 與 restart() 結果都相同', () => {
  const score = buildTwoPartScore();
  // 每個情境都先 tick 一次讓排程器對好手勢計數基準（第一次觀察不算觸發），再開始觸發。
  const scenarios = {
    播放中: (hp, d) => { d.tick(); d.trigger(); d.runMs(1300); },
    暫停: (hp, d) => { d.tick(); d.trigger(); d.runMs(1300); hp.pause(); },
    播完: (hp, d) => { d.tick(); for (let i = 0; i < 40 && !hp.isFinished(); i++) { d.trigger(); d.runMs(500); } },
  };
  const resets = { 'stop()': (hp) => hp.stop(), 'restart()': (hp) => { hp.restart(); hp.pause(); } };
  for (const [sName, dirty] of Object.entries(scenarios)) {
    for (const [rName, reset] of Object.entries(resets)) {
      const { hp } = makeHpUnplayed(score, [['p0', 1]]);
      const fresh = stateSnapshot(hp);
      const d = makeDriver(hp, { p0: 1 });
      hp.play();
      dirty(hp, d);
      const dirtied = snapshotDiffs(fresh, stateSnapshot(hp));
      assert(dirtied.includes('_frontierSec') && dirtied.includes('p0.claimed'),
        `${sName}：前提不成立——共用拍位／claim 根本沒被弄髒（只有 ${dirtied}），這個比對什麼都沒驗證`);
      reset(hp);
      const diffs = snapshotDiffs(fresh, stateSnapshot(hp));
      assert(diffs.length === 0, `${sName}＋${rName}：重設後與剛載入不同的欄位：${diffs.join('、')}`);
    }
  }
});

run('restart()：整首自動播放跑完後重播，每顆音恰好再發聲一次', () => {
  const { hp, log } = makeHp(buildScoreWithGaps(), []);
  const d = makeDriver(hp);
  const onCount = () => log.filter((e) => e.t === 'on').length;
  while (!hp.isFinished() && d.nowMs < 10000) d.tick();
  assert(hp.isFinished(), '前提：第一輪應該播完');
  assert(onCount() === 4, `第一輪 4 顆音都要發聲，實際 ${onCount()}`);
  hp.restart();
  assert(hp.isPlaying() && !hp.isFinished(), 'restart() 之後應該在播放中、而且不是已播完');
  assert(hp.getPositionSeconds() < 0.01, `restart() 之後進度應該回到開頭，實際 ${hp.getPositionSeconds()}`);
  const before = onCount();
  while (!hp.isFinished() && d.nowMs < 20000) d.tick();
  assert(hp.isFinished(), '重播後應該再次播完');
  assert(onCount() - before === 4, `重播後 4 顆音都要再發聲一次（不多不少），實際 ${onCount() - before}`);
});

run('restart() 之後代打要等真人重新觸發過才啟動（不會沿用重播前的觸發紀錄）', () => {
  const { hp, log } = makeHp(buildScoreWithGaps(), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const voice = hp._voices.get('p0');
  d.tick(); d.trigger(); d.tick();            // 觸發拍 0
  d.runMs(2000);
  assert(hp._beatIndex === 1 && voice.isAutopilot, '前提：代打已經把拍位走到空拍 1');
  hp.restart();
  const logStart = log.length;
  d.runMs(3000);                              // 重播後完全不揮手
  assert(hp._beatIndex === 0, `重播後沒人觸發，拍位應該停在 0，實際 ${hp._beatIndex}`);
  assert(voice.lastRealTriggerMs === null && voice.isAutopilot === false, '重播後代打不該啟動');
  assert(!log.slice(logStart).some((e) => e.t === 'on'), '重播後沒人觸發不該有任何音發聲');
  d.trigger(); d.tick();                      // 第一次真人觸發（手勢計數在重播前後是連續的）
  assert(log.slice(logStart).filter((e) => e.t === 'on' && e.note === 60).length === 1,
    '第一次真人觸發應該讓拍 0 的音發聲');
});

run('restart() 把代打留下的 CC7=85 送回 100（否則會殘留到重播後的真人音）', () => {
  const { hp, log } = makeHp(canonScore, [[canonCello.id, 1]]);
  const voice = hp._voices.get(canonCello.id);
  const d = makeDriver(hp, { [canonCello.id]: 1 });
  d.tick(); d.trigger(); d.tick();
  const cc7 = (from = 0) => log.slice(from).filter((e) => e.t === 'cc' && e.cc === 7 && e.label === 'human').map((e) => e.val);
  while (d.nowMs < 5000 && !cc7().includes(85)) d.tick();
  assert(cc7().at(-1) === 85, '前提：代打應該已經把 CC7 切到 85');
  const logStart = log.length;
  hp.restart();
  assert(cc7(logStart).at(-1) === 100, `重播要把 CC7 明確送回 100，實際送出：${cc7(logStart)}`);
  assert(voice._lastSentCc7 === 100, '去重用的 _lastSentCc7 要跟合成器上的實際值一致');
});

run('命名：未指派＝電腦輔助的聲部（assistSynth／kind:assist），指派聲部走 humanSynth／kind:human', () => {
  const { hp } = makeHpUnplayed(buildTwoPartScore(), [['p0', 1]]);
  assert(hp.assistSynth && hp.humanSynth && hp.assistSynth !== hp.humanSynth, '兩個合成器都要設好，而且是不同的兩個');
  assert(hp._voices.get('p0').kind === 'human', `指派聲部的 kind 應該是 human，實際 ${hp._voices.get('p0').kind}`);
  assert(hp._voices.get('p1').kind === 'assist', `未指派聲部（電腦輔助）的 kind 應該是 assist，實際 ${hp._voices.get('p1').kind}`);
});

run('沒有拍格線（SMPTE division，A5）＋有指派聲部：load()／stop() 不丟例外', () => {
  // buildMeasureGrid() 對 SMPTE 回傳空陣列；load() 與重設共用的「未指派聲部初始上限」不能因此讀 undefined。
  const smpte = { ...buildScoreWithGaps(), ticksPerQuarter: null };
  const { hp } = makeHpUnplayed(smpte, [['p0', 1]]);
  hp.stop();
});

/* ═══════════════════════════════════════════
   單一裁決點（Task B）：共用拍位一個 tick 最多前進一拍，跟聲部處理順序、有幾個聲部／演奏者無關
   ═══════════════════════════════════════════ */

// spec：partId → 這個聲部的音符（拍序號，或 { beat, dur 秒 }）。4/4，預設 120 BPM（拍長 0.5s），音符預設 25ms 短音；
// beatSec 可改拍長（例如 1.2 ＝ 50 BPM）。
function buildBeatScore(spec, beatSec = 0.5) {
  const tpq = 480;
  const notes = [], parts = [];
  Object.entries(spec).forEach(([id, items], pi) => {
    parts.push({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } });
    items.forEach((it, ni) => {
      const { beat, dur = 0.025 } = typeof it === 'number' ? { beat: it } : it;
      notes.push({
        partId: id, trackIndex: pi, channel: pi, program: 0, note: 40 + pi * 12 + ni, velocity: 100,
        startTick: beat * tpq, endTick: beat * tpq + Math.round((dur / beatSec) * tpq),
        startSeconds: beat * beatSec, endSeconds: beat * beatSec + dur, durationSeconds: dur,
      });
    });
  });
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  const totalBeats = Math.max(...notes.map((n) => n.startTick / tpq)) + 8;
  return {
    parts, notes, durationSeconds: totalBeats * beatSec, durationTicks: totalBeats * tpq, ticksPerQuarter: tpq,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    tickToSeconds: (t) => (t / tpq) * beatSec,
  };
}
const onNotes = (log) => log.filter((e) => e.t === 'on').map((e) => e.note);

run('一人指派兩個聲部（左右手）：每次揮手共用拍位恰好前進一拍，不是每個聲部各推一拍', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 4], p1: [0, 4] }), [['p0', 1], ['p1', 1]]);
  const d = makeDriver(hp, { p0: 1, p1: 1 });
  d.tick();
  const beats = [];
  for (let i = 0; i < 3; i++) { d.trigger(1); d.runMs(150); beats.push(hp._beatIndex); }
  assert(beats.join() === '0,1,2', `三次揮手後拍位應為 0,1,2，實際 ${beats}`);
});

run('兩位演奏者同一個 tick 揮手：共用拍位只前進一拍', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 4], p1: [0, 4] }), [['p0', 1], ['p1', 2]]);
  const d = makeDriver(hp, { p0: 1, p1: 2 });
  d.tick();
  const beats = [];
  for (let i = 0; i < 3; i++) { d.trigger(1, 2); d.runMs(150); beats.push(hp._beatIndex); }
  assert(beats.join() === '0,1,2', `三輪同時揮手後拍位應為 0,1,2，實際 ${beats}`);
});

run('一位的排隊解除與另一位的新觸發落在同一個 tick：共用拍位只前進一拍', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.6 }, 1], p1: [0, 2] }), [['p0', 1], ['p1', 2]]);
  const d = makeDriver(hp, { p0: 1, p1: 2 });
  const v0 = hp._voices.get('p0');
  d.tick(); d.trigger(1, 2); d.runMs(500);       // 兩人都在拍 0 接手；p0 的 0.6s 長音還在響
  d.trigger(1); d.tick();                        // p0 拍 1 有新音（開新音而舊音還在響）
  assert(v0.pendingTrigger === true, '前提：p0 舊音還在響、這次揮手又會開新音，要排隊');
  const beatBefore = hp._beatIndex;
  // 直接把 p0 舊音的剩餘時間壓到「下一個 tick 剛好放完」，讓排隊解除與 p1 的新觸發撞在同一個 tick。
  for (const s of v0.sounding.values()) s.remain = 0.005;
  d.trigger(2); d.tick();
  assert(v0.pendingTrigger === false, '前提：p0 的排隊要在這個 tick 解除');
  assert(hp._beatIndex === beatBefore + 1, `同一個 tick 內共用拍位只能前進一拍，實際 ${beatBefore} → ${hp._beatIndex}`);
});

run('聲部處理順序無關：parts／assignments 順序對調，拍位序列與發出的音完全相同', () => {
  const runOnce = (spec, assignments) => {
    const { hp, log } = makeHp(buildBeatScore(spec), assignments);
    const d = makeDriver(hp, Object.fromEntries(assignments));
    d.tick();
    const beats = [];
    for (let i = 0; i < 3; i++) { d.trigger(1); d.runMs(150); beats.push(hp._beatIndex); }
    return { beats: beats.join(), notes: onNotes(log).sort((a, b) => a - b).join() };
  };
  const forward = runOnce({ p0: [0, 4], p1: [0, 1, 4] }, [['p0', 1], ['p1', 1]]);
  const reversed = runOnce({ p1: [0, 1, 4], p0: [0, 4] }, [['p1', 1], ['p0', 1]]);
  assert(forward.beats === '0,1,2', `正向順序拍位應為 0,1,2，實際 ${forward.beats}`);
  assert(reversed.beats === forward.beats, `對調順序後拍位應相同：${forward.beats} vs ${reversed.beats}`);
  assert(reversed.notes.split(',').length === forward.notes.split(',').length,
    `對調順序後發出的音數應相同：${forward.notes} vs ${reversed.notes}`);
});

run('代打到期時重新驗證：別人的觸發把拍位推到我有音符的拍，代打不能替我發出那顆音', () => {
  // pA 每拍一顆、pB 只有拍 0 與拍 4。pB 在拍 0 接手後代打武裝（下一拍是空拍）；pA 連揮 4 次把共用拍位
  // 推到拍 4——pB 的真實音符所在。代打到期時，那一拍屬於 pB 自己的觸發，不能被代打搶著發出。
  const { hp, log } = makeHp(buildBeatScore({ pA: [0, 1, 2, 3, 4, 5, 6, 7], pB: [0, 4] }), [['pA', 1], ['pB', 2]]);
  const d = makeDriver(hp, { pA: 1, pB: 2 });
  const vB = hp._voices.get('pB');
  const pBSecondNote = 40 + 12 + 1;
  d.tick(); d.trigger(1, 2); d.tick();
  for (let i = 0; i < 4; i++) { d.runMs(200); d.trigger(1); }
  d.runMs(400);                                  // 越過 pB 代打的到期時間（約 812ms）
  assert(hp._beatIndex === 4, `前提：pA 的四次揮手應該把拍位推到拍 4，實際 ${hp._beatIndex}`);
  assert(!onNotes(log).includes(pBSecondNote), 'pB 拍 4 的音符還沒被 pB 自己觸發，不能被代打發出');
  assert(vB.isAutopilot === false, 'pB 沒有真的被代打（isAutopilot 應為 false）');
  d.trigger(2); d.tick();
  assert(onNotes(log).includes(pBSecondNote), 'pB 自己觸發後，拍 4 的音符應該發聲');
  assert(vB.isAutopilot === false, 'pB 自己觸發的音不該標成代打');
});

run('共用拍位因別人的動作前進後，其他已武裝的代打倒數順延，不會緊接著再推一拍', () => {
  const { hp } = makeHp(buildBeatScore({ pP: [0, 3], pQ: [0, 3] }), [['pP', 1], ['pQ', 2]]);
  const d = makeDriver(hp, { pP: 1, pQ: 2 });
  d.tick(); d.trigger(1, 2); d.tick();           // 兩人在拍 0 接手，各自武裝代打（約 812ms 到期）
  d.runMs(700); d.trigger(1); d.tick();          // 700ms：P 揮手，共用拍位 0→1，Q 的代打倒數要順延
  assert(hp._beatIndex === 1, `前提：P 的揮手應該讓拍位走到 1，實際 ${hp._beatIndex}`);
  d.runMs(700);                                  // 原本 Q 的代打會在 812ms 到期
  assert(hp._beatIndex === 1, `Q 的代打倒數應該被順延，這段時間拍位不該再動，實際 ${hp._beatIndex}`);
  d.runMs(400);                                  // 順延後的到期時間過了：P 與 Q 一起到期，也只走一拍
  assert(hp._beatIndex === 2, `順延到期後兩人的代打合起來只該走一拍，實際 ${hp._beatIndex}`);
});

run('固定種子的隨機壓力測試：4 聲部、2 位演奏者、60 秒，共用拍位每個 tick 只增不減、最多 +1', () => {
  let s = 20260930;                              // mulberry32
  const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const spec = {};
  for (const id of ['p0', 'p1', 'p2', 'p3']) {
    spec[id] = [];
    for (let b = 0; b < 200; b++) if (rand() < 0.3) spec[id].push(b);
  }
  const { hp } = makeHp(buildBeatScore(spec), [['p0', 1], ['p1', 1], ['p2', 2], ['p3', 2]]);
  const d = makeDriver(hp, { p0: 1, p1: 1, p2: 2, p3: 2 });
  d.tick();
  let prev = hp._beatIndex, maxDelta = 0, minDelta = 0, advances = 0;
  for (let i = 0; i < 5000; i++) {
    if (rand() < 0.012) d.trigger(1);
    if (rand() < 0.012) d.trigger(2);
    d.tick();
    const delta = hp._beatIndex - prev;
    maxDelta = Math.max(maxDelta, delta); minDelta = Math.min(minDelta, delta);
    if (delta > 0) advances++;
    prev = hp._beatIndex;
  }
  assert(advances > 20, `前提：60 秒內共用拍位應該真的前進很多次（實際 ${advances} 次），否則這個壓力測試沒有壓到東西`);
  assert(maxDelta <= 1 && minDelta >= 0, `共用拍位每個 tick 只能增加 0 或 1，實際最大增量 ${maxDelta}、最小增量 ${minDelta}`);
});

/* ═══════════════════════════════════════════
   排隊閘門（Task D）：只有「這次觸發真的會開新音、而且舊音還在響」才排隊；走過空拍立即生效
   ═══════════════════════════════════════════ */

run('全音符原速逐拍觸發：大提琴 note-on 準時落在 0／1.78／3.56s，走過長音佔用的空拍不被排隊卡住', () => {
  const { hp, log } = makeHp(canonScore, [[canonCello.id, 1]]);
  const d = makeDriver(hp, { [canonCello.id]: 1 });
  const beatMs = buildBeatGrid(canonScore)[0].endSeconds * 1000;
  const onsets = [];
  let seen = 0;
  const step = () => { d.tick(); for (; seen < log.length; seen++) if (log[seen].t === 'on') onsets.push(d.nowMs); };
  d.tick();
  d.trigger(); step();
  const t0 = onsets[0];
  // 完美演奏者：跟著原譜節奏，每拍（含全音符佔用的空拍）揮一次。
  for (let k = 1; d.nowMs - t0 < 4200;) {
    if (d.nowMs - t0 >= k * beatMs) { d.trigger(); k++; }
    step();
  }
  const rel = onsets.slice(0, 3).map((t) => (t - t0) / 1000);
  const expected = [0, 1.778, 3.556];
  assert(rel.length === 3 && rel.every((r, i) => Math.abs(r - expected[i]) <= 0.05),
    `前三顆全音符應該準時落在 ${expected}s（±0.05），實際 ${rel.map((r) => r.toFixed(2))}`);
});

run('空拍的觸發不排隊：長音還在響時照樣走過空拍，舊音不被切、照原譜長度響完', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 1.2 }, 4] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const v = hp._voices.get('p0');
  d.tick(); d.trigger(); d.tick();                  // 拍 0：1.2s 長音開始
  const startMs = d.nowMs;
  d.runMs(480); d.trigger(); d.tick();              // 約 0.5s：拍 1 對這個聲部是空拍，長音還在響
  assert(v.sounding.size === 1, '前提：長音還在響');
  assert(v.pendingTrigger === false, '走過空拍不會開新音，不該被長音排隊');
  assert(hp._beatIndex === 1, `空拍的觸發應該立刻生效、走到拍 1，實際 ${hp._beatIndex}`);
  while (v.sounding.size > 0 && d.nowMs < startMs + 3000) d.tick();
  assert(Math.abs(d.nowMs - startMs - 1200) <= 30, `長音應該照原譜 1.2s 響完（不被切、不被拉長），實際 ${d.nowMs - startMs}ms`);
});

run('代打走過空拍不必等長音放完：長音還在響時代打照樣推進，舊音不被切', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 1.9 }, 6] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const v = hp._voices.get('p0');
  d.tick(); d.trigger(); d.tick();                  // 拍 0：1.9s 長音開始，之後完全不揮手
  const startMs = d.nowMs;
  d.runMs(900);                                     // 超過 AUTOPILOT_IDLE_MS（800ms），長音還沒響完
  assert(v.sounding.size === 1, '前提：長音還在響');
  assert(hp._beatIndex === 1 && v.isAutopilot, `代打應該已經走過空拍 1（不等長音放完），拍位 ${hp._beatIndex}、代打 ${v.isAutopilot}`);
  while (v.sounding.size > 0 && d.nowMs < startMs + 4000) d.tick();
  assert(Math.abs(d.nowMs - startMs - 1900) <= 30, `代打走過空拍不該動到長音：應該照原譜 1.9s 響完，實際 ${d.nowMs - startMs}ms`);
});

run('目標拍真的有新音、舊音還在響：照樣排隊，新舊音不重疊（閘門只放行空拍）', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.6 }, 1, 4] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const v = hp._voices.get('p0');
  d.tick(); d.trigger(); d.tick();                  // 拍 0：0.6s 的音
  d.runMs(480); d.trigger(); d.tick();              // 約 0.5s：拍 1 有新音，舊音要到 0.6s 才結束
  assert(v.pendingTrigger === true && hp._beatIndex === 0, '拍 1 有新音、舊音還在響：這次觸發要排隊，拍位不動');
  let maxSounding = v.sounding.size;
  while (onNotes(log).length < 2 && d.nowMs < 3000) { d.tick(); maxSounding = Math.max(maxSounding, v.sounding.size); }
  assert(onNotes(log).length === 2, '舊音放完後排隊的觸發應該自動解除，拍 1 的新音發聲');
  assert(maxSounding === 1, `新舊音不能重疊（同一聲部同時最多 1 顆音），實際最多 ${maxSounding} 顆`);
});

run('同一拍內的第二次揮手（這拍還有已接手、尚未發出的音）就地吸收，不被排隊也不多推一拍', () => {
  // 拍 0 有兩顆音：A（拍首、0.4s）與 B（拍內 0.75 拍處）；拍 1 有 C。A 還在響時再揮一次，這次觸發只是
  // 「吸收」（B 早已被拍 0 的接手涵蓋，不會因為它開任何新音）。
  const { hp } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.4 }, 0.75, 1] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const v = hp._voices.get('p0');
  d.tick(); d.trigger(); d.tick();                  // 拍 0：A 開始
  d.runMs(180); d.trigger(); d.tick();              // 約 0.2s：A 還在響，B（0.375s）還沒發聲
  assert(v.sounding.size === 1, '前提：A 還在響');
  assert(v.pendingTrigger === false, '這拍內的第二次揮手不會開新音，不該被排隊');
  assert(hp._beatIndex === 0, `第二次揮手只是被這一拍吸收，拍位應該不動，實際 ${hp._beatIndex}`);
});

run('最後一顆音還在響時再揮手：沒有新音可開，終局立刻開始，尾音照原譜長度響完', () => {
  // p0 只有拍 0 一顆 1.0s 的音；p1（電腦輔助）在拍 2 有音。p0 的第一次觸發讓上限推到拍 0 尾，p1 卡在
  // 那裡；第二次揮手時 p0 沒有更多音符——終局立刻解除 p1 的上限，不必等 p0 的尾音先響完。
  const { hp, log } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 1.0 }], p1: [2, 3] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const v = hp._voices.get('p0');
  let offMs = null, seen = 0;
  const step = () => { d.tick(); for (; seen < log.length; seen++) if (log[seen].t === 'off' && log[seen].label === 'human' && offMs == null) offMs = d.nowMs; };
  d.tick(); d.trigger(); step();
  const startMs = d.nowMs;
  while (d.nowMs < startMs + 480) step();
  d.trigger(); step();                              // 約 0.5s：尾音還在響
  assert(v.sounding.size === 1 && v.pendingTrigger === false, '前提：尾音還在響，而且這次觸發沒被排隊');
  while (d.nowMs < startMs + 1200) step();          // p1 拍 2（1.0s）的音應該已經在原譜時間發出
  assert(onNotes(log).includes(40 + 12), `終局後 p1 拍 2 的音應該依原譜時間發聲，實際發出：${onNotes(log)}`);
  assert(offMs != null && Math.abs(offMs - startMs - 1000) <= 30, `尾音應該照原譜 1.0s 響完，實際 ${offMs == null ? '沒有關' : offMs - startMs}ms`);
});

/* ═══════════════════════════════════════════
   合奏層級代打、多人合併窗與自動終局（Task C）
   ═══════════════════════════════════════════ */

run('多人合併窗（Bug7）：兩位每拍一起揮手、其中一位晚 84ms，共用拍位一拍一拍走，不會各推一拍', () => {
  const { hp } = makeHp(buildBeatScore({ pA: [0, 1, 2, 3, 4, 5, 6], pB: [0, 3, 6] }), [['pA', 1], ['pB', 2]]);
  const d = makeDriver(hp, { pA: 1, pB: 2 });
  d.tick(); d.trigger(1, 2); d.tick();                // 拍 0：兩人一起接手
  const beats = [];
  for (let i = 0; i < 4; i++) {
    d.runMs(400);
    d.trigger(1); d.runMs(84);                        // A 準時；B 晚 84ms（7 個 tick）
    d.trigger(2); d.tick();
    beats.push(hp._beatIndex);
  }
  assert(beats.join() === '1,2,3,4', `四輪揮手後拍位應為 1,2,3,4（晚到的一位跟上同一拍），實際 ${beats}`);
});

run('合併窗不影響單人：自己連續快揮（間隔約 100ms）每一次都前進一拍', () => {
  const { hp } = makeHp(buildBeatScore({ pA: [0, 1, 2, 3, 4, 5] }), [['pA', 1]]);
  const d = makeDriver(hp, { pA: 1 });
  d.tick(); d.trigger(); d.tick();
  const beats = [];
  for (let i = 0; i < 4; i++) { d.runMs(96); d.trigger(); d.tick(); beats.push(hp._beatIndex); }
  assert(beats.join() === '1,2,3,4', `單人快揮每次都要前進一拍，實際 ${beats}`);
});

run('代打走過空拍之後，演奏者準時揮手（落在代打那一步之後 150ms 內）照常前進，不被合併窗吸收', () => {
  // 音符每 2 拍一顆：演奏者靠代打填中間的空拍、只在有音的拍自己揮手。代打在停手 800ms 走一拍，演奏者的
  // 下一次揮手（約 950ms）落在代打那一步之後 150ms——那是他自己的下一拍，不是「跟上代打走到的那一拍」。
  const { hp, log } = makeHp(buildBeatScore({ pA: [0, 2, 4, 6] }), [['pA', 1]]);
  const d = makeDriver(hp, { pA: 1 });
  d.tick(); d.trigger(); d.tick();                    // 拍 0
  const seen = [];
  for (let i = 0; i < 3; i++) { d.runMs(936); d.trigger(); d.tick(); seen.push(hp._beatIndex); }
  assert(seen.join() === '2,4,6', `每次揮手都該走到有音的拍 2,4,6，實際 ${seen}`);
  assert(onNotes(log).length === 4, `4 顆音都該發聲，實際 ${onNotes(log).length}`);
});

run('閒置聲部的代打不吃掉別人的音（Bug8）：另一位下一拍有他的音時，代打整批不走', () => {
  const { hp, log } = makeHp(buildBeatScore({ pIdle: [0, 40], pActive: [0, 1, 2] }), [['pIdle', 1], ['pActive', 2]]);
  const d = makeDriver(hp, { pIdle: 1, pActive: 2 });
  d.tick(); d.trigger(1, 2); d.tick();                // 拍 0：兩人都接手；之後 pIdle 完全閒置
  d.runMs(2500);                                      // pActive 慢了：他拍 1 的音要等他自己揮手
  const activeSecond = 40 + 12 + 1;                   // pActive 拍 1 的音
  assert(hp._beatIndex === 0, `pActive 的下一拍有他的音，代打不該把拍位推走，實際 ${hp._beatIndex}`);
  assert(!onNotes(log).includes(activeSecond), 'pActive 拍 1 的音還沒被他自己觸發，不能被代打吃掉或發出');
  d.trigger(2); d.tick();
  assert(hp._beatIndex === 1 && onNotes(log).includes(activeSecond), 'pActive 自己揮手後，拍 1 的音應該發聲');
});

run('慢速曲（50 BPM）準時每拍揮手：共用拍位一拍一拍走，代打不搶在揮手前面多走一拍（Bug9 棘輪）', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 10] }, 1.2), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  d.tick(); d.trigger(); d.tick();                    // 拍 0
  const beats = [];
  for (let i = 0; i < 5; i++) { d.runMs(1188); d.trigger(); d.tick(); beats.push(hp._beatIndex); }
  assert(beats.join() === '1,2,3,4,5', `每 1.2s 準時揮一次，拍位應為 1,2,3,4,5，實際 ${beats}`);
});

run('代打的步進節奏：第一步等 max(800ms, 1.5 拍)，之後每一步等剛走進那一拍的原譜秒數', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 8] }), [['p0', 1]]); // 120 BPM，拍長 0.5s
  const d = makeDriver(hp, { p0: 1 });
  d.tick(); d.trigger(); d.tick();
  const t0 = d.nowMs;
  const at = (ms) => { d.runMs(t0 + ms - d.nowMs); return hp._beatIndex; };
  assert(at(700) === 0, `第一步要等約 800ms，700ms 時拍位應該還在 0，實際 ${hp._beatIndex}`);
  assert(at(900) === 1, `800ms 後代打走第一步，實際 ${hp._beatIndex}`);
  assert(at(1250) === 1, `第二步要再等一拍（0.5s），1250ms 時應該還在拍 1，實際 ${hp._beatIndex}`);
  assert(at(1450) === 2, `第二步約在 1300ms（不是固定 800ms 之後的 1600ms），1450ms 時應該到拍 2，實際 ${hp._beatIndex}`);
  assert(at(4500) === 7, `之後每拍走一步，在有音的拍 8 前面（拍 7）停下，實際 ${hp._beatIndex}`);
  assert(at(6500) === 7, `拍 8 有音，代打不能自己走進去，實際 ${hp._beatIndex}`);
});

run('某個聲部沒有更多音符後再揮手：不進終局、不推進拍位，別人剩下的音不會被強制自動播完（Bug6）', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [0, 1], p1: [0, 1, 2, 3, 4, 5, 6, 7] }), [['p0', 1], ['p1', 2]]);
  const d = makeDriver(hp, { p0: 1, p1: 2 });
  const p1Sounded = () => onNotes(log).filter((n) => n >= 52).length; // p1 的音高 52..59
  d.tick(); d.trigger(1, 2); d.tick();                // 拍 0
  d.runMs(488); d.trigger(1, 2); d.tick();            // 拍 1：p0 的兩顆音都被接手了（p0 沒有更多音符）
  assert(p1Sounded() === 2, `前提：p1 到這裡發過 2 顆音，實際 ${p1Sounded()}`);
  for (let i = 0; i < 3; i++) { d.runMs(488); d.trigger(1); d.tick(); } // p0 沒有東西可演奏了，還是繼續揮
  d.runMs(1500);
  assert(p1Sounded() === 2, `p1 的演奏者沒揮手，他剩下的音不該被自動播完，實際 ${p1Sounded()} 顆`);
  assert(hp._beatIndex === 1, `沒有音可接手的揮手不該推進共用拍位，實際 ${hp._beatIndex}`);
  d.trigger(2); d.tick();
  assert(p1Sounded() === 3 && hp._beatIndex === 2, `p1 自己揮手後才走到拍 2 並發聲，實際 ${p1Sounded()} 顆、拍 ${hp._beatIndex}`);
});

run('演奏者離開：其他人演奏完之後，缺席聲部剩下的音不會從舊播放頭追趕、自動播出（Bug3）', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [0, 1, 2], p1: [0, 1, 2, 3, 4, 5] }), [['p0', 1], ['p1', 2]]);
  const d = makeDriver(hp, { p0: 1, p1: 2 });
  d.tick(); d.trigger(1, 2); d.tick();                // 拍 0：兩人都接手，之後 p1 的演奏者離開
  for (let i = 0; i < 2; i++) { d.runMs(488); d.trigger(1); d.tick(); } // p0 一個人演奏完拍 1、2
  d.runMs(500); d.trigger(1); d.tick();               // p0 沒有更多音符後多揮一下（舊版會在這裡進終局）
  d.runMs(6000);
  const p1Notes = onNotes(log).filter((n) => n >= 52);
  assert(p1Notes.length === 1, `缺席的 p1 只該發過拍 0 那一顆，實際 ${p1Notes}`);
  assert(!hp.isFinished(), 'p1 還有沒演奏的音，曲子不該算播完');
});

run('所有指派聲部都沒有更多音符：自動終局，電腦輔助聲部的尾奏自己播完，指派聲部的上限不放無限', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [0, 1], a0: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const p0 = hp._voices.get('p0');
  d.tick(); d.trigger(); d.tick();
  d.runMs(488); d.trigger(); d.tick();                // 拍 1：p0 最後一顆音被接手，之後完全不揮手
  d.runMs(5000);
  const assistNotes = onNotes(log).filter((n) => n >= 52);   // a0 的音高 52..57
  assert(assistNotes.length === 6, `p0 演奏完後，電腦輔助的 a0 應該自己把尾奏播完（6 顆），實際 ${assistNotes.length}`);
  assert(hp.isFinished(), '整首應該自動播完，不需要多揮一下');
  assert(p0.limitSec !== Infinity, '指派聲部的上限維持在最後一次接手的位置，不放無限');
});

run('暫停再繼續不消耗代打倒數：暫停期間的時間不算靜止，恢復後照剩餘時間代打', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 8] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  d.tick(); d.trigger(); d.tick();
  d.runMs(300);                                       // 已經靜止約 300ms（距離代打第一步還剩約 500ms）
  hp.pause();
  d.runMs(10000);                                     // 暫停很久：時鐘照走，排程器不 tick
  hp.play();
  d.runMs(400);
  assert(hp._beatIndex === 0, `恢復後只過了 400ms（剩餘約 500ms），代打不該啟動，實際拍位 ${hp._beatIndex}`);
  d.runMs(300);
  assert(hp._beatIndex === 1, `再過 300ms 就滿剩餘時間，代打應該走第一步，實際拍位 ${hp._beatIndex}`);
});

run('load(null) 清掉上一首的狀態：接著 play()／tick() 不丟例外（延音開關不殘留）', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 1, 2] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  d.tick(); d.trigger(); d.tick();
  hp.load(null, []);
  hp.play();
  d.runMs(200);
  assert(hp.isPlaying() && !hp.isFinished(), '沒有樂譜時排程器照常空轉，不算播完');
});

run('沒有拍格線（SMPTE，A5）＋指派聲部：退回整首自動播放，揮手也不丟例外', () => {
  const smpte = { ...buildScoreWithGaps(), ticksPerQuarter: null };
  const { hp, log } = makeHp(smpte, [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  d.tick(); d.trigger(); d.runMs(5000);
  assert(onNotes(log).length === 4, `沒有拍格線就整首自動播放，4 顆音各發聲一次，實際 ${onNotes(log)}`);
  assert(hp.isFinished(), '自動播放應該播完');
});

/* ═══════════════════════════════════════════
   延音（Task E）：相連音符的小間隙不留空白——舊音自然段結束後不關，等這個聲部真正的下一個 note-on 才關
   ═══════════════════════════════════════════ */

// 相連的兩顆音：A 在拍 0、比一拍短 1 tick（MuseScore 匯出「記譜長度 − 1 tick」的樣子），B 在拍 1。
const ONE_TICK_SHORT = 0.5 * 479 / 480;

// 記錄每個事件發生的假時間，方便檢查「舊音在新音 note-on 的同一刻關」。
function stampLog(log, d) {
  const events = [];
  let seen = 0;
  const flush = () => { for (; seen < log.length; seen++) events.push({ ...log[seen], ms: d.nowMs }); };
  return {
    events,
    tick() { d.tick(); flush(); },
    run(ms) { const end = d.nowMs + ms; while (d.nowMs < end) { d.tick(); flush(); } },
  };
}

run('延音：相連音符（間隙 1 tick）的舊音，在演奏者比原譜慢時不關，等下一顆音的 note-on 才關（不留空白）', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const w = stampLog(log, d);
  w.tick(); d.trigger(); w.tick();                   // 拍 0：A（音高 40）開始
  w.run(680);                                        // 0.5s 時 A 自然結束；演奏者慢了，約 0.68s 才揮下一次手
  assert(!w.events.some((e) => e.t === 'off' && e.note === 40), 'A 自然段結束後不該關（間隙只有 1 tick，等下一顆音）');
  d.trigger(); w.tick();
  const onB = w.events.find((e) => e.t === 'on' && e.note === 41);
  const offA = w.events.find((e) => e.t === 'off' && e.note === 40);
  assert(onB && offA, 'B 應該發聲、A 應該關掉');
  assert(offA.ms === onB.ms && w.events.indexOf(offA) < w.events.indexOf(onB), 'A 應該在 B 的 note-on 同一刻、先關再開');
});

run('延音的上限跟代打綁在一起：演奏者停手超過代打第一步的等待時間，延長中的舊音就收掉', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const w = stampLog(log, d);
  w.tick(); d.trigger(); w.tick();
  const t0 = d.nowMs;
  w.run(2000);                                       // 之後完全不揮手
  const offA = w.events.find((e) => e.t === 'off' && e.note === 40);
  assert(offA, '演奏者閒置後延長中的音應該收掉，不能無限期掛著');
  const idleMs = offA.ms - t0;
  assert(Math.abs(idleMs - 800) <= 30, `應該在停手約 800ms（代打第一步的等待時間）收掉，實際 ${idleMs}ms`);
});

run('延音只補小間隙：真正的休止（間隙 120 tick）照原譜長度收，不延音', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.375 }, 1] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const w = stampLog(log, d);
  w.tick(); d.trigger(); w.tick();
  const t0 = d.nowMs;
  w.run(680);                                        // 演奏者慢，0.68s 才揮下一次
  const offA = w.events.find((e) => e.t === 'off' && e.note === 40);
  assert(offA && Math.abs(offA.ms - t0 - 375) <= 24, `真正的休止要保留：A 應該在原譜 0.375s 收，實際 ${offA ? offA.ms - t0 : '沒有收'}ms`);
});

run('延音等的下一顆音被合奏路過丟掉：延長中的舊音在那一刻收掉，不會無限掛著', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1], p1: [0, 1, 2, 3, 4, 5] }), [['p0', 1], ['p1', 2]]);
  const d = makeDriver(hp, { p0: 1, p1: 2 });
  const w = stampLog(log, d);
  w.tick(); d.trigger(1, 2); w.tick();               // 拍 0：兩人都接手；之後只有 p1 繼續揮
  const t0 = d.nowMs;
  w.run(488); d.trigger(2); w.tick();                // 約 0.5s：p1 走到拍 1（p0 的 B 就在這一拍，p0 還沒接手）
  assert(!w.events.some((e) => e.t === 'off' && e.note === 40), '前提：A 還在延長（p0 的 B 還在等）');
  w.run(488); d.trigger(2); w.tick();                // 約 1.0s：p1 走到拍 2，p0 的 B 被路過丟掉
  const offA = w.events.find((e) => e.t === 'off' && e.note === 40);
  assert(offA, 'B 被路過丟掉之後，A 沒有下一顆音可以等，應該收掉');
  assert(Math.abs(offA.ms - t0 - 1000) <= 40, `A 應該在共用拍位越過 B 的那一刻（約 1.0s）收掉，實際 ${offA.ms - t0}ms`);
});

run('延音也套用在電腦輔助的聲部：演奏者比原譜慢一點時，輔助聲部相連的音之間不留空白', () => {
  // p0（指派）每拍一顆；a0（電腦輔助）在拍 3、拍 4 各一顆相連的音（A 比一拍短 1 tick）。演奏者每約 0.7s 揮一次
  // （比原譜的 0.5s 慢），輔助聲部的播放頭跟著共用拍位走，B 要等播放頭追到才發聲；A 自然結束到 B 發聲之間不該有空白。
  const { hp, log } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3, 4, 5, 6, 7], a0: [{ beat: 3, dur: ONE_TICK_SHORT }, 4] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const w = stampLog(log, d);
  w.tick(); d.trigger(); w.tick();
  for (let i = 0; i < 6; i++) { w.run(684); d.trigger(); w.tick(); }
  w.run(1000);
  const onB = w.events.find((e) => e.t === 'on' && e.label === 'assist' && e.note === 53);
  const offA = w.events.find((e) => e.t === 'off' && e.label === 'assist' && e.note === 52);
  assert(onB && offA, `a0 的 A、B 都應該發過聲，實際事件 ${JSON.stringify(w.events.filter((e) => e.label === 'assist'))}`);
  assert(offA.ms === onB.ms && w.events.indexOf(offA) < w.events.indexOf(onB), `A 應該在 B 的 note-on 同一刻收（不留空白），A 收 ${offA.ms}ms、B 開 ${onB.ms}ms`);
});

run('延音只在下一顆音還沒發出的時候延：下一顆音已經先發聲（播放頭跳拍）時，舊音照原譜長度收，不會掛在後面', () => {
  // 演奏者比原譜快（每約 0.2s 揮一次）：電腦輔助聲部的播放頭每次都被共用拍位「瞬間對齊」往前跳，B 在 A 的
  // 自然段（約 0.5s）結束之前就已經發聲。A 自然結束時沒有下一顆音可以等，不能進延長段掛到閒置才收。
  const { hp, log } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3, 4, 5], a0: [{ beat: 1, dur: ONE_TICK_SHORT }, 2] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const w = stampLog(log, d);
  w.tick(); d.trigger(); w.tick();
  for (let i = 0; i < 2; i++) { w.run(192); d.trigger(); w.tick(); }
  w.run(2000);
  const onA = w.events.find((e) => e.t === 'on' && e.label === 'assist' && e.note === 52);
  const onB = w.events.find((e) => e.t === 'on' && e.label === 'assist' && e.note === 53);
  const offA = w.events.find((e) => e.t === 'off' && e.label === 'assist' && e.note === 52);
  assert(onA && onB && offA, `a0 的 A、B 都應該發聲、A 應該收掉，實際 ${JSON.stringify(w.events.filter((e) => e.label === 'assist'))}`);
  assert(onB.ms < onA.ms + 499, `前提：B 應該在 A 自然段結束之前就發聲（A ${onA.ms}ms、B ${onB.ms}ms）`);
  assert(Math.abs(offA.ms - onA.ms - 499) <= 30, `A 沒有下一顆音可以等，應該照原譜 0.499s 收，實際 ${offA.ms - onA.ms}ms`);
});

run('沒有人被指派、整首自動播放：音符照原譜長度收，不延音', () => {
  const { hp, log } = makeHp(buildBeatScore({ a0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), []);
  const d = makeDriver(hp, {});
  const w = stampLog(log, d);
  w.tick(); w.run(1500);
  const onB = w.events.find((e) => e.t === 'on' && e.note === 41);
  const offA = w.events.find((e) => e.t === 'off' && e.note === 40);
  assert(onB && offA, '自動播放：A、B 都該發聲，A 該收掉');
  assert(w.events.indexOf(offA) < w.events.indexOf(onB), '沒有演奏者的自動播放不延音：A 先照原譜長度收、B 再開');
});

run('延音遇到同音高重複：先關舊音再開新音，新音不會被連帶關掉', () => {
  const score = buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] });
  for (const n of score.notes) n.note = 60;
  const { hp, log } = makeHp(score, [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const v = hp._voices.get('p0');
  const w = stampLog(log, d);
  w.tick(); d.trigger(); w.tick();
  w.run(680); d.trigger(); w.tick();
  const seq = w.events.filter((e) => e.t === 'on' || e.t === 'off').map((e) => e.t).join();
  assert(seq === 'on,off,on', `同音高：應該是 開、關、開，實際 ${seq}`);
  assert(v.sounding.has(60), '新音要還在響，不能被延長段的收尾連帶關掉');
});

run('暫停會收掉延長中的音（不留下掛著的音）', () => {
  const { hp, log } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  const d = makeDriver(hp, { p0: 1 });
  const v = hp._voices.get('p0');
  d.tick(); d.trigger(); d.tick();
  d.runMs(600);                                      // A 已經自然結束、正在延長
  assert(v.sounding.size === 1, '前提：A 還在延長中');
  hp.pause();
  assert(v.sounding.size === 0 && log.some((e) => e.t === 'off' && e.note === 40), '暫停要對延長中的音送 noteOff');
});

/* ═══════════════════════════════════════════
   整體不變量壓力測試（Task G1）：固定種子的隨機譜＋隨機揮手、離開、暫停、重播
   ═══════════════════════════════════════════ */

// 每個聲部是一條單音旋律：音長取 MuseScore 風格的「記譜長度 − 1 tick」（相連音間隙 1 tick），偶爾插入休止、
// 偶爾有長音，讓延音、休止、長音、路過丟音都會被壓到。
function buildRandomScore(rand, nParts) {
  const tpq = 480;
  const beatSec = 0.25 + rand() * 1.2;                 // 50~240 BPM
  const totalTicks = (40 + Math.floor(rand() * 40)) * tpq;
  const parts = [], notes = [];
  for (let pi = 0; pi < nParts; pi++) {
    const id = `p${pi}`;
    parts.push({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } });
    let t = 0, idx = 0;
    while (t < totalTicks) {
      const notated = [120, 240, 480, 960, 1920][Math.floor(rand() * 5)];
      if (rand() < 0.15) t += [240, 480, 960][Math.floor(rand() * 3)];
      const startTick = t, endTick = t + notated - 1;
      notes.push({
        partId: id, trackIndex: pi, channel: pi, program: 0, note: 40 + pi * 12 + (idx++ % 12), velocity: 90,
        startTick, endTick, startSeconds: (startTick / tpq) * beatSec, endSeconds: (endTick / tpq) * beatSec,
        durationSeconds: ((endTick - startTick) / tpq) * beatSec,
      });
      t += notated;
    }
  }
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  return {
    parts, notes, durationSeconds: (totalTicks / tpq) * beatSec, durationTicks: totalTicks, ticksPerQuarter: tpq,
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    tickToSeconds: (t) => (t / tpq) * beatSec,
  };
}

run('固定種子的整體不變量壓力測試：隨機譜、3 位演奏者（一位中途離開）、暫停／重播，各 60 秒', () => {
  for (const seed of [11, 22, 33, 44]) {
    let s = seed;                                      // mulberry32
    const rand = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const score = buildRandomScore(rand, 4 + Math.floor(rand() * 2));
    const beatSec = score.tickToSeconds(480);
    const assignments = [['p0', 1], ['p1', 1], ['p2', 2], ['p3', 3]];   // 其餘聲部（若有）是電腦輔助
    const slotOf = Object.fromEntries(assignments);
    const log = [], balance = new Map();
    let hp;
    const fake = (label) => ({
      controllerChange() {}, programChange() {},
      noteOn: (ch, note) => {
        log.push({ t: 'on', label, ch, note });
        const k = `${label}/${ch}/${note}`;
        balance.set(k, (balance.get(k) ?? 0) + 1);
        if (label === 'human') {                        // 指派聲部的音一定在 claim 範圍內才能發聲（終局後也一樣）
          const v = [...hp._voices.values()].find((x) => x.kind === 'human' && x.channel === ch);
          assert(v.claimed && v.notes[v.cursor].startSeconds < v.limitSec, `seed ${seed}：指派聲部 ${v.partId} 在沒有 claim 的範圍發聲`);
        }
      },
      noteOff: (ch, note) => {
        log.push({ t: 'off', label, ch, note });
        const k = `${label}/${ch}/${note}`;
        balance.set(k, (balance.get(k) ?? 0) - 1);
        assert(balance.get(k) >= 0, `seed ${seed}：${k} 沒有對應的 noteOn 就 noteOff`);
      },
    });
    hp = new HumanPerformer();
    hp.setSynths(fake('assist'), fake('human'));
    hp.load(score, new Map(assignments));
    hp.play();
    const seqs = {};
    const getGesture = (pid) => (pid in slotOf
      ? { present: true, triggerSeq: seqs[slotOf[pid]] ?? 0, slot: slotOf[pid] }
      : { present: false, triggerSeq: 0, slot: null });
    const lastBeat = hp._beats.length - 1;
    const pWave = 12 / (beatSec * 1000 * 0.8);         // 平均約 0.8 拍揮一次
    let now = 0, prevBeat = hp._beatIndex, advances = 0, sawExtended = false;
    for (let i = 0; i < 5000; i++) {
      now += 12;
      for (const slot of [1, 2, 3]) {
        if (slot === 3 && i > 1250) continue;           // 演奏者 3 在 15 秒後離開
        if (rand() < pWave) seqs[slot] = (seqs[slot] ?? 0) + 1;
      }
      if (rand() < 0.0008) { hp.pause(); for (let k = 0; k < 150; k++) { now += 12; hp.tick(now, getGesture); } hp.play(); }
      if (rand() < 0.0003) { hp.restart(); prevBeat = hp._beatIndex; }
      hp.tick(now, getGesture);

      const delta = hp._beatIndex - prevBeat;
      assert(delta === 0 || delta === 1, `seed ${seed}：共用拍位每個 tick 只能增加 0 或 1，實際 ${delta}`);
      assert(hp._beatIndex <= lastBeat, `seed ${seed}：共用拍位 ${hp._beatIndex} 超出拍格線（最後一拍 ${lastBeat}）`);
      if (delta > 0) advances++;
      prevBeat = hp._beatIndex;

      const humans = [...hp._voices.values()].filter((v) => v.kind === 'human');
      for (const v of hp._voices.values()) {
        for (const [pitch, e] of v.sounding) {
          if (e.extended) {                             // 延長段：只在允許延音、而且後繼音還在等的時候存在
            sawExtended = true;
            assert(hp._sustainAllowed(), `seed ${seed}：演奏者閒置超過門檻，音 ${pitch} 還在延長（閒置 ${hp._idleSec}s）`);
            assert(e.sustainTo >= v.cursor, `seed ${seed}：延長中的音 ${pitch} 沒有後繼音可以等`);
          } else {
            assert(e.remain > 0, `seed ${seed}：自然段已經倒數完的音 ${pitch} 還留在 sounding`);
          }
        }
      }
      if (hp._frontierSec === Infinity && humans.length) {   // 終局：沒有任何指派聲部還有沒被 claim 的音，上限也沒被放無限
        for (const v of humans) {
          assert(!hp._nextUnclaimedNote(v), `seed ${seed}：終局後指派聲部 ${v.partId} 還有沒被 claim 的音`);
          assert(v.limitSec !== Infinity, `seed ${seed}：終局不該把指派聲部的上限放到無限`);
        }
      }
    }
    assert(advances > 20, `seed ${seed}：前提：60 秒內共用拍位應該真的前進很多次（實際 ${advances} 次）`);
    assert(sawExtended, `seed ${seed}：前提：這個壓力測試應該真的壓到延長段`);
  }
});

// 「真實觸發排隊解決後來源正確標記為真人」這個情境（先前用代打的音還在響、真人觸發撞上排隊）
// 在目前的代打設計下已經不可能發生：代打只會在確認下一拍沒有音符時才啟動、且從不自己 claim
// 有音符的拍，代打本身永遠不會讓 voice.sounding 變成非空——也就是說 pendingIsAutopilot 這個
// 欄位（排隊來源標記）目前只會被寫成 false，沒有任何路徑會寫成 true。這是既有欄位，不是這輪
// 改動造成的死程式碼，這裡不刪，只記錄測試因此拿掉的原因。

console.log('\n全部測試跑完。');
