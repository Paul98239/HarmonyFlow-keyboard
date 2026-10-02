// ============================================================
//  human-performer.test.mjs — src/midi/humanPerformer.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟 test/browser/smoke-test.mjs 同一套風格：run()／assert() 是整個專案
//  唯一的測試慣例。假 synth 只實作 controllerChange／programChange／noteOn／noteOff，並替每個
//  事件蓋上當下的假時間；每 12ms 呼叫一次 tick()，跟 midiPlayer.js 的排程 tick 一致。
//
//  時間數字都是照模型手算的（樂譜時鐘 S 在揮手那個 tick 前進一個 dt、碰到放行邊界 B 就停格…），
//  不是跑出來再抄回去；容許誤差以一個排程 tick（12ms）為單位。
//
//  「note-on／note-off 成對」的意思是以「音」為單位：每顆音有一個起點與一個終點（原檔的終點可能是
//  Note Off，也可能是 velocity 0 的 Note On，parser 都配成同一顆音）；排程器送給合成器的 noteOn 與
//  noteOff 次數要相同、一一對應，而且絕不送 velocity 0 的 noteOn（合成器會把它當成 note-off）。
//
//  用法：node test/unit/human-performer.test.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseMidi } from '../../src/midi/midiParser.js';
import { HumanPerformer, rateSample, smoothRate } from '../../src/midi/humanPerformer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANON_PATH = join(__dirname, '../../src/assets/canon-violin-cello.mid');
const TICK_MS = 12;

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ═══════════════════════════════════════════
   測試工具：假合成器、假時鐘＋可腳本化的手勢、譜面產生器
   ═══════════════════════════════════════════ */

function makeFakeSynth(log, label, clock) {
  return {
    controllerChange: (ch, cc, val) => log.push({ t: 'cc', label, ch, cc, val, ms: clock.ms }),
    programChange: () => {},
    noteOn: (ch, note, vel) => log.push({ t: 'on', label, ch, note, vel, ms: clock.ms }),
    noteOff: (ch, note) => log.push({ t: 'off', label, ch, note, ms: clock.ms }),
  };
}

// slotOf：partId → 演奏者槽位，沒列的當作沒指派。wave(1, 2)＝槽位 1 與 2 的演奏者「同一個 tick」各揮一次手，
// 回傳這個 tick 的假時間；不帶參數＝槽位 1。gap(ms)＝兩個 tick 之間隔了很久（背景分頁被節流）。
function makeDriver(hp, slotOf, clock) {
  const seqs = {};
  const getGesture = (partId) => (partId in slotOf
    ? { present: true, triggerSeq: seqs[slotOf[partId]] ?? 0, slot: slotOf[partId] }
    : { present: false, triggerSeq: 0, slot: null });
  const tick = () => { clock.ms += TICK_MS; hp.tick(clock.ms, getGesture); };
  return {
    tick,
    runMs(ms) { const end = clock.ms + ms; while (clock.ms < end) tick(); },
    trigger(...slots) { for (const s of (slots.length ? slots : [1])) seqs[s] = (seqs[s] ?? 0) + 1; },
    wave(...slots) { this.trigger(...slots); tick(); return clock.ms; },
    gap(ms) { clock.ms += ms; hp.tick(clock.ms, getGesture); },
    get nowMs() { return clock.ms; },
  };
}

function makeHp(score, assignments, { play = true } = {}) {
  const log = [], clock = { ms: 0 };
  const hp = new HumanPerformer();
  hp.setSynths(makeFakeSynth(log, 'assist', clock), makeFakeSynth(log, 'human', clock));
  hp.load(score, new Map(assignments));
  const d = makeDriver(hp, Object.fromEntries(assignments), clock);
  if (play) hp.play();
  return { hp, log, d };
}

const onNotes = (log, label) => log.filter((e) => e.t === 'on' && (!label || e.label === label)).map((e) => e.note);
const eventMs = (log, t, note, label) => log.find((e) => e.t === t && e.note === note && (!label || e.label === label))?.ms;
const onMs = (log, note, label) => eventMs(log, 'on', note, label);
const offMs = (log, note, label) => eventMs(log, 'off', note, label);
const cc7Of = (log, ch) => log.filter((e) => e.t === 'cc' && e.cc === 7 && e.ch === ch).map((e) => e.val);

// spec：partId → 這個聲部的音符（拍序號，或 { beat, dur 秒, note 音高 }）。4/4，預設 120 BPM（拍長 0.5s），
// 音符預設 25ms 短音；音高預設 40＋聲部序號×12＋這顆音在聲部裡的序號。beatSec 可改拍長（例如 1.2 ＝ 50 BPM）。
function buildBeatScore(spec, beatSec = 0.5) {
  const tpq = 480;
  const notes = [], parts = [];
  Object.entries(spec).forEach(([id, items], pi) => {
    parts.push({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } });
    items.forEach((it, ni) => {
      const { beat, dur = 0.025, note = 40 + pi * 12 + ni } = typeof it === 'number' ? { beat: it } : it;
      notes.push({
        partId: id, trackIndex: pi, channel: pi, program: 0, note, velocity: 100,
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

// MuseScore 匯出相連音符的樣子：記譜長度 − 1 tick（0.5s 的拍少 1 tick），下一顆音在下一拍的拍首。
const ONE_TICK_SHORT = 0.5 * 479 / 480;

/* ═══════════════════════════════════════════
   單一樂譜時鐘：揮手放行下一拍，音只看時鐘 S
   ═══════════════════════════════════════════ */

run('完美演奏者每拍揮手一次（含空拍）：共用拍位一拍一拍走，每顆音在它那一拍的揮手 tick 發聲', () => {
  // 音符落在拍 0/2/4/6，1/3/5 是空拍。第 1 次揮手放行起始拍（拍 0），之後每次一拍：走到最後一顆音要 7 次。
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4, 6] }), [['p0', 1]]);
  d.tick();                                         // 基準 tick，不算揮手
  const beats = [], waveMs = [];
  for (let i = 0; i < 7; i++) { waveMs.push(d.wave()); d.runMs(488); beats.push(hp._beatIndex); }
  assert(beats.join() === '0,1,2,3,4,5,6', `七次揮手後拍位應為 0..6，實際 ${beats}`);
  [0, 2, 4, 6].forEach((b, i) => assert(onMs(log, 40 + i) === waveMs[b],
    `拍 ${b} 的音應該在揮手那個 tick（${waveMs[b]}ms）發聲，實際 ${onMs(log, 40 + i)}ms`));
  d.wave();
  assert(hp._beatIndex === 6, `沒有更多音符時多揮一次不該再前進，實際 ${hp._beatIndex}`);
});

run('長音還在響時，下一拍的新音照樣在揮手那一刻發聲（沒有排隊閘門，不會永久落後）', () => {
  // 鋼琴這類帶長音的聲部：拍 0 一顆 2.0s 的長音，拍 1~3 各一顆短音；演奏者準時每拍揮手。
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 2.0 }, 1, 2, 3] }), [['p0', 1]]);
  d.tick();
  const waveMs = [];
  for (let b = 0; b < 4; b++) { waveMs.push(d.wave()); d.runMs(488); }
  for (let b = 1; b < 4; b++) {
    assert(onMs(log, 40 + b) === waveMs[b], `拍 ${b} 的音應該在揮手那個 tick（${waveMs[b]}ms）發聲，實際 ${onMs(log, 40 + b)}ms`);
  }
});

run('樂譜時鐘在放行的拍尾停格：沒有下一次揮手就不往前走，揮手後立刻接著走', () => {
  // p0 在拍 1 也有音，所以代打不會替他走；時鐘只會停在拍 0 的拍尾（0.5s）等。
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1] }), [['p0', 1]]);
  d.tick(); d.wave();
  d.runMs(1500);
  assert(Math.abs(hp.getPositionSeconds() - 0.5) < 1e-9, `沒有揮手時時鐘應該停在拍尾 0.5s，實際 ${hp.getPositionSeconds()}`);
  d.runMs(1000);
  assert(Math.abs(hp.getPositionSeconds() - 0.5) < 1e-9, '停格期間時鐘不該再動');
  assert(onNotes(log).join() === '40', `停格期間下一拍的音不該發聲，實際發出 ${onNotes(log)}`);
  const t = d.wave();
  assert(onMs(log, 41) === t, `揮手後下一拍的第一顆音應該在那個 tick 發聲，實際 ${onMs(log, 41)}ms`);
  d.runMs(100);
  assert(hp.getPositionSeconds() > 0.55 && hp.getPositionSeconds() < 0.7, `揮手後時鐘應該接著往前走，實際 ${hp.getPositionSeconds()}`);
});

run('揮得比樂譜快：時鐘追趕，每顆音恰好一次、依序、不擠成同一個 tick', () => {
  // p0 每拍一顆；a0（電腦輔助）每拍 4 顆十六分音符（共 24 顆）。演奏者每 96ms 揮一次，樂譜每拍 500ms。
  const sixteenths = Array.from({ length: 24 }, (_, i) => i / 4);
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3, 4, 5], a0: sixteenths }), [['p0', 1]]);
  d.tick();
  for (let b = 0; b < 6; b++) { d.wave(); d.runMs(84); }
  d.runMs(1500);
  const assist = log.filter((e) => e.t === 'on' && e.label === 'assist');
  assert(assist.map((e) => e.note).join() === Array.from({ length: 24 }, (_, i) => 52 + i).join(),
    `電腦輔助聲部的 24 顆音應該各發聲一次、依序，實際 ${assist.map((e) => e.note)}`);
  for (let i = 1; i < assist.length; i++) {
    assert(assist[i].ms > assist[i - 1].ms, `第 ${i} 與第 ${i + 1} 顆音被擠在同一個 tick（${assist[i].ms}ms）`);
  }
  assert(onNotes(log, 'human').length === 6, `指派聲部的 6 顆音都該發聲，實際 ${onNotes(log, 'human').length}`);
});

run('前奏：第一下揮手不追趕——電腦輔助照原速播完前奏，真人的第一個音等樂譜時鐘走到那裡才發聲', () => {
  // a0 每拍一顆；p0 的第一個音在拍 4（2.0s）。演奏者 0.3s 就提早揮手。
  const { log, d } = makeHp(buildBeatScore({ p0: [4, 5], a0: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]);
  d.tick(); d.runMs(276); d.wave();
  d.runMs(2500);
  for (let b = 0; b < 4; b++) {
    assert(Math.abs(onMs(log, 52 + b, 'assist') - (b * 500 + 12)) <= TICK_MS,
      `前奏第 ${b} 拍應該照原速在 ${b * 500 + 12}ms 發聲（不被提早的揮手追趕），實際 ${onMs(log, 52 + b, 'assist')}ms`);
  }
  const human = onMs(log, 40, 'human');
  assert(human >= 2000 && human <= 2040, `真人的第一個音要等時鐘走到 2.0s 才發聲，實際 ${human}ms`);
  assert(onMs(log, 56, 'assist') === human, '同一個樂譜時刻的電腦輔助音與真人音要在同一個 tick');
});

run('收音依樂譜時鐘：慢的演奏者每次停格，長音也跟著時鐘等，不是發聲後各自倒數', () => {
  // 拍 0 的 2.0s 長音（後面 1 拍以上才有下一顆音，不是相連音）。演奏者每 744ms 揮一次（樂譜每拍 500ms，每拍停格一段）：
  // 第 4 次揮手（2256ms）才放行拍 3，時鐘最早在那之後才走得到 2.0s；發聲後倒數 2.0s 的做法會在 2036ms 左右就收掉。
  // 時鐘走多快取決於速度估計，所以不寫死絕對時間，只要求「長音恰好在時鐘走到結尾的那個 tick 收」。
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 2.0 }, { beat: 5 }] }), [['p0', 1]]);
  let reached = null;                               // 時鐘第一次走到 2.0s 的 tick
  const step = () => { d.tick(); if (reached === null && hp.getPositionSeconds() >= 2.0 - 1e-9) reached = d.nowMs; };
  step();
  for (let k = 0; k < 4; k++) { d.trigger(); step(); for (let i = 1; i < 62; i++) step(); }
  for (let i = 0; i < 100; i++) step();
  assert(reached !== null && reached > 2256, `時鐘最早在第 4 次揮手（2256ms）之後才走得到 2.0s，實際 ${reached}ms`);
  assert(offMs(log, 40) === reached, `長音應該在時鐘走到結尾的那個 tick（${reached}ms）收，實際 ${offMs(log, 40)}ms`);
});

run('同音高重疊（先進先出）：兩顆同音高的重疊音各送一次 note-off，不留卡音', () => {
  // 同一個聲部同音高 60：A 0→1.0s、B 0.5→1.5s（重疊）。沒有人被指派＝整首自動播放。
  const { log, d } = makeHp(buildBeatScore({ a0: [{ beat: 0, dur: 1.0, note: 60 }, { beat: 1, dur: 1.0, note: 60 }] }), []);
  d.tick(); d.runMs(2500);
  const ons = log.filter((e) => e.t === 'on').map((e) => e.ms), offs = log.filter((e) => e.t === 'off').map((e) => e.ms);
  assert(ons.length === 2 && offs.length === 2, `兩顆音要各一個 note-on／note-off，實際 on ${ons.length}、off ${offs.length}`);
  assert(offs[0] - 1000 >= 0 && offs[0] - 1000 <= 2 * TICK_MS && offs[1] - 1500 >= 0 && offs[1] - 1500 <= 2 * TICK_MS,
    `兩次收音應該在 1.0s 與 1.5s（各晚一個 tick 以內），實際 ${offs}`);
});

run('放行邊界是排他的：時鐘停在拍尾時，剛好落在邊界上的音（真人與電腦輔助）都要等下一次揮手', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 1], a0: [0, 1] }), [['p0', 1]]);
  d.tick(); d.wave();
  d.runMs(3000);                                    // 完全不揮手，時鐘早已停在拍尾 0.5s
  assert(onNotes(log).sort().join() === '40,52', `停格期間只該有拍 0 的兩顆音，實際 ${onNotes(log)}`);
  const t = d.wave();
  assert(onMs(log, 41) === t && onMs(log, 53) === t, `下一次揮手那個 tick，拍 1 的兩顆音一起發聲，實際 ${onMs(log, 41)}／${onMs(log, 53)}ms`);
});

run('每個 tick 的時間步長上限 100ms：分頁被節流後恢復，不會一次吐出一大段音', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ a0: [0, 2, 4, 6] }), []);   // 整首自動播放
  d.tick();                                         // 第一顆音
  d.gap(5000);                                      // 背景分頁 5 秒沒有 tick
  assert(onNotes(log).length === 1, `5 秒的空窗不該把後面的音一次放出來，實際 ${onNotes(log)}`);
  assert(Math.abs(hp.getPositionSeconds() - 0.1) < 1e-9, `時鐘最多只前進 100ms，實際 ${hp.getPositionSeconds()}`);
});

run('單一時鐘：慢的演奏者（每 744ms 揮一次）下，真人與電腦輔助的同刻音在同一個 tick 發聲，輔助音不早於該拍揮手', () => {
  const beats = [0, 1, 2, 3, 4, 5];
  const { log, d } = makeHp(buildBeatScore({ p0: beats, a0: beats }), [['p0', 1]]);
  d.tick();
  const waveMs = [];
  for (let b = 0; b < 6; b++) { waveMs.push(d.wave()); d.runMs(732); }
  for (const b of beats) {
    const human = onMs(log, 40 + b, 'human'), assist = onMs(log, 52 + b, 'assist');
    assert(human === assist, `拍 ${b}：真人 ${human}ms、電腦輔助 ${assist}ms 要在同一個 tick`);
    assert(assist >= waveMs[b], `拍 ${b} 的輔助音（${assist}ms）不該比該拍的揮手（${waveMs[b]}ms）早`);
  }
});

/* ═══════════════════════════════════════════
   停格：相連音等揮手時撐住、停格太久就釋放
   ═══════════════════════════════════════════ */

run('相連音在時鐘停格等揮手時撐住：後繼音放行的那個 tick 先關舊音再開新音，中間沒有空白', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  d.tick(); d.wave();
  d.runMs(660);                                     // 演奏者慢了：A 的編碼結尾（0.499s）早就過了，後繼音還沒放行
  assert(!log.some((e) => e.t === 'off'), 'A 編碼上已經結束，但它的後繼音還沒被放行，不該收');
  const t = d.wave();
  const offA = log.find((e) => e.t === 'off' && e.note === 40), onB = log.find((e) => e.t === 'on' && e.note === 41);
  assert(offA && onB && offA.ms === t && onB.ms === t && log.indexOf(offA) < log.indexOf(onB),
    `A 應該在 B 發聲的同一個 tick（${t}ms）先關再開，實際 off ${offA?.ms}、on ${onB?.ms}`);
});

run('停格超過閒置門檻：撐住的相連音收掉，不能無限期掛著', () => {
  // 時鐘在 0.5s（約 512ms）停格；閒置門檻 max(800ms, 1.5 拍＝750ms) ＝ 800ms。
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  d.tick(); d.wave(); d.runMs(2000);
  assert(Math.abs(offMs(log, 40) - 1312) <= 2 * TICK_MS, `停格 800ms 後應該收掉（約 1312ms），實際 ${offMs(log, 40)}ms`);
});

run('停格釋放不分音的種類：連不相連的長音也一起收掉，不會無限期響著', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 2.0 }, 1] }), [['p0', 1]]);
  d.tick(); d.wave(); d.runMs(3000);
  assert(Math.abs(offMs(log, 40) - 1312) <= 2 * TICK_MS, `時鐘停格 800ms 後，2.0s 的長音也要收掉（約 1312ms），實際 ${offMs(log, 40)}ms`);
  assert(onNotes(log).length === 1 && log.filter((e) => e.t === 'off').length === 1, '收掉就是收掉：不重發、不多收');
});

run('不相連的音（間隙 120 tick 的休止）停格時照原譜長度收，不撐', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0.375 }, 1] }), [['p0', 1]]);
  d.tick(); d.wave(); d.runMs(660);
  assert(Math.abs(offMs(log, 40) - 387) <= 2 * TICK_MS, `休止要保留：A 應該在原譜 0.375s（約 387ms）收，實際 ${offMs(log, 40)}ms`);
});

run('相連音撐住也套用在電腦輔助的聲部：演奏者慢時，輔助聲部相連的音之間不留空白', () => {
  // a0 在拍 3、拍 4 各一顆相連的音。演奏者每 684ms 揮一次（比原譜慢），時鐘每拍都停格。
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3, 4, 5, 6, 7], a0: [{ beat: 3, dur: ONE_TICK_SHORT }, 4] }), [['p0', 1]]);
  d.tick();
  for (let i = 0; i < 6; i++) { d.wave(); d.runMs(672); }
  d.runMs(1000);
  const on = log.find((e) => e.t === 'on' && e.label === 'assist' && e.note === 53);
  const off = log.find((e) => e.t === 'off' && e.label === 'assist' && e.note === 52);
  assert(on && off && off.ms === on.ms && log.indexOf(off) < log.indexOf(on),
    `A 應該在 B 的 note-on 同一刻先收，實際 A 收 ${off?.ms}ms、B 開 ${on?.ms}ms`);
});

run('整首自動播放（沒有指派）：每顆音照編碼收，不撐——相連音先關舊音、再開新音', () => {
  const { log, d } = makeHp(buildBeatScore({ a0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), []);
  d.tick(); d.runMs(1500);
  const offA = log.find((e) => e.t === 'off' && e.note === 40), onB = log.find((e) => e.t === 'on' && e.note === 41);
  assert(offA && onB && log.indexOf(offA) < log.indexOf(onB), 'A 先收、B 再開');
  assert(offA.ms - 499 >= 0 && offA.ms - 499 <= 2 * TICK_MS, `A 應該在編碼的 0.499s 收，實際 ${offA.ms}ms`);
});

run('相連音遇到同音高重複：先關舊音再開新音，新音不會被連帶關掉', () => {
  const score = buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT, note: 60 }, { beat: 1, dur: 0.4, note: 60 }] });
  const { log, d } = makeHp(score, [['p0', 1]]);
  d.tick(); d.wave(); d.runMs(680); d.wave();
  const seq = log.filter((e) => e.t === 'on' || e.t === 'off').map((e) => e.t).join();
  assert(seq === 'on,off,on', `同音高：應該是 開、關、開，實際 ${seq}`);
  d.runMs(1000);
  assert(log.filter((e) => e.t === 'off').length === 2, '第二顆音自己的 note-off 也要送出（先進先出的第二筆）');
});

run('暫停會收掉所有還在響的音（含撐住的），不留下掛著的音', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  d.tick(); d.wave(); d.runMs(600);                 // A 編碼上已結束、正被撐住
  assert(!log.some((e) => e.t === 'off'), '前提：A 還被撐著');
  hp.pause();
  assert(log.filter((e) => e.t === 'off' && e.note === 40).length === 1, '暫停要對撐住的音送 noteOff');
});

/* ═══════════════════════════════════════════
   速度跟隨：兩次真人揮手的間隔 → 速度倍率 r（演奏者的速度是原譜速度的幾倍），樂譜時鐘照 r 前進
   ═══════════════════════════════════════════ */

const near = (a, b, tol) => Math.abs(a - b) <= tol;

run('速度取樣：兩次揮手之間樂譜走的秒數 ÷ 真實經過的秒數；範圍外（停頓、同一個動作偵測成兩次）不當速度', () => {
  // [樂譜秒, 真實秒, 預期]，手算。範圍是原譜速度的 0.25～4 倍，邊界含在內。
  const cases = [
    [0.5, 0.5, 1], [0.5, 0.4, 1.25], [0.5, 0.8, 0.625],
    [0.5, 2.0, 0.25], [2.0, 0.5, 4],                                    // 剛好在範圍邊界
    [0.5, 2.5, null], [0.5, 0.1, null],                                 // 0.2 倍（停頓）、5 倍（重複偵測）
    [0.5, 0, null], [0.5, -1, null], [0, 0.5, null],                    // 零或負的間隔、樂譜沒有往前走
  ];
  for (const [scoreSec, realSec, want] of cases) {
    const got = rateSample(scoreSec, realSec);
    assert(want === null ? got === null : got !== null && near(got, want, 1e-9),
      `rateSample(${scoreSec}, ${realSec}) 應為 ${want}，實際 ${got}`);
  }
});

run('速度平滑在對數域：快兩倍與慢一半對稱、取樣等於估計時不動、持續的新速度幾次就跟上', () => {
  // 手算：2^0.35 = 1.2746（算術平均會是 1.35，把「快兩倍」估得比「慢一半」更極端）。
  assert(near(smoothRate(1, 2), 1.2746, 1e-3), `smoothRate(1, 2) 應為 1.2746，實際 ${smoothRate(1, 2)}`);
  assert(near(smoothRate(1, 2) * smoothRate(1, 0.5), 1, 1e-9), '加倍與減半要對稱（乘起來回到 1）');
  assert(near(smoothRate(1.3, 1.3), 1.3, 1e-12), '取樣等於目前估計時，估計不動');
  let r = 1;
  for (let i = 0; i < 5; i++) r = smoothRate(r, 2);                     // 2^(1 − 0.65^5) = 1.845
  assert(near(r, 1.845, 5e-3), `連續 5 次取樣 2，估計應該到 1.845，實際 ${r}`);
});

// 每拍都有音的聲部：代打不會替他走（下一拍就有他的音），所以下面這些測試只受「揮手 → 估計 → 時鐘速度」影響。
const everyBeat = (n) => Array.from({ length: n }, (_, i) => i);
// 揮 count 次手，每次間隔 intervalTicks 個 tick（12ms）；回傳每次揮手的假時間。
function waveSteadily(d, count, intervalTicks) {
  const times = [];
  for (let k = 0; k < count; k++) { times.push(d.wave()); for (let i = 1; i < intervalTicks; i++) d.tick(); }
  return times;
}

run('揮得比樂譜快 26％（每 33 個 tick＝396ms 一次，樂譜每拍 500ms）：估計跟上，之後每顆音都在揮手那個 tick 發聲', () => {
  // 沒有估計時時鐘每拍落後約 100ms、要靠追趕補，音晚約 50ms 才發聲；估計到位後，時鐘剛好在下一次揮手時走到拍尾。
  const { hp, log, d } = makeHp(buildBeatScore({ p0: everyBeat(20) }), [['p0', 1]]);
  d.tick();
  const waveMs = waveSteadily(d, 16, 33);
  const want = 0.5 / 0.396;                                             // 手算：1.2626
  assert(near(hp._playbackRate, want, want * 0.02), `速度倍率應該到 ${want.toFixed(3)} 左右，實際 ${hp._playbackRate}`);
  for (let k = 8; k < 16; k++) {
    const late = onMs(log, 40 + k) - waveMs[k];
    assert(late <= TICK_MS, `第 ${k} 拍的音應該在揮手那個 tick 發聲（估計早已到位），實際晚 ${late}ms`);
  }
});

run('停頓不當成速度：幾秒沒揮手之後的第一下揮手，估計不被拉走；之後的取樣照常', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: everyBeat(30) }), [['p0', 1]]);
  d.tick();
  waveSteadily(d, 10, 33);
  const trained = hp._playbackRate;
  assert(near(trained, 500 / 396, 0.03), `前提：估計應該已經到 1.26 左右，實際 ${trained}`);
  d.runMs(3000); d.wave();                                              // 停 3 秒再揮：0.5s ÷ 3.4s ≈ 0.15 倍，低於 0.25
  assert(near(hp._playbackRate, trained, trained * 0.005), `停頓的間隔不該被當成速度，估計從 ${trained} 變成 ${hp._playbackRate}`);
  waveSteadily(d, 5, 33);                                               // 回來之後的正常間隔照常取樣
  assert(near(hp._playbackRate, 500 / 396, 0.03), `回來之後應該繼續追蹤速度，實際 ${hp._playbackRate}`);
});

run('暫停期間的時間不算揮手間隔：暫停前後各一次揮手，不會被當成一次很慢的取樣', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: everyBeat(30) }), [['p0', 1]]);
  d.tick();
  waveSteadily(d, 10, 33);
  const trained = hp._playbackRate;
  d.wave(); hp.pause(); d.runMs(444); hp.play();                        // 揮完手暫停 444ms，恢復後馬上再揮
  d.wave();                                                             // 中間隔 456ms：落在範圍內（0.5 ÷ 0.456 ≈ 1.10），不擋掉就會被取樣
  assert(near(hp._playbackRate, trained, trained * 0.005), `跨過暫停的間隔不該取樣，估計從 ${trained} 變成 ${hp._playbackRate}`);
});

run('慢的演奏者（每 83 個 tick＝996ms 一拍，樂譜每拍 500ms）：估計變慢後代打的門檻跟著放寬，不搶在揮手前走拍（棘輪）', () => {
  // p0 前 6 拍每拍有音（代打不能走），之後每 2 拍一顆音（中間的空拍代打可以走）；演奏者每拍都揮手，含空拍。
  // 沒有放寬時代打第一步等 max(800ms, 1.5 拍＝750ms)＝800ms，比他的間隔 996ms 短：代打先走一拍空拍，他緊接著的
  // 揮手再推一拍，共用拍位就比他數的拍多一拍。估計到 0.54 倍之後門檻是 1.5 拍 ÷ 0.54 ＝ 1.4s，不會搶先。
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3, 4, 5, 8, 10, 12, 14, 16, 18] }), [['p0', 1]]);
  d.tick();
  const beats = [];
  for (let k = 0; k <= 18; k++) { d.wave(); beats.push(hp._beatIndex); for (let i = 1; i < 83; i++) d.tick(); }
  assert(beats.join() === everyBeat(19).join(), `每次揮手共用拍位都該剛好前進一拍（0..18），實際 ${beats}`);
});

run('代打照估計的速度走：手停下後第一步等 max(800ms, 1.5 拍 ÷ r)、之後每步等一拍 ÷ r；代打放行不取樣、也不讓揮手跟它配成取樣', () => {
  // 演奏者每 21 個 tick＝252ms 揮一次（樂譜每拍 500ms，約 2 倍速），揮完拍 0..13 就停；p0 下一個音在拍 60，中間全是空拍。
  // r ≈ 1.98：第一步 800ms（1.5 拍 ÷ r ＝ 380ms 比 800ms 短），之後每步 0.5s ÷ 1.98 ＝ 253ms（tick 量化成 264ms）：
  // 手停後 804、1068、1332、1596、1860ms 各一步，2124ms 才有下一步。沒有 ÷ r 時每步 504ms，同一段時間只走 3 步。
  const { hp, d } = makeHp(buildBeatScore({ p0: [...everyBeat(14), 60] }), [['p0', 1]]);
  d.tick();
  const lastWave = waveSteadily(d, 14, 21).at(-1);
  const trained = hp._playbackRate;
  assert(near(trained, 500 / 252, 0.05), `前提：估計應該到 1.98 左右，實際 ${trained}`);
  d.runMs(lastWave + 2000 - d.nowMs);
  assert(hp._beatIndex === 13 + 5, `手停後 2 秒內代打應該走 5 拍（到拍 18），實際到拍 ${hp._beatIndex}`);
  assert(near(hp._playbackRate, trained, trained * 0.005), `代打放行不該取樣，估計應維持 ${trained}，實際 ${hp._playbackRate}`);
  d.wave();                                                             // 演奏者回來：跟 2 秒前的揮手隔著代打，不能配成一次取樣（否則會取到 1.3 倍）
  assert(near(hp._playbackRate, trained, trained * 0.005), `隔著代打的兩次揮手不該配成取樣，估計從 ${trained} 變成 ${hp._playbackRate}`);
});

run('終局照最後一次估計的速度播完：指派聲部的最後一個音放行後，電腦輔助的尾奏不回到原譜速度', () => {
  // p0 拍 0..13，演奏者每 252ms 揮一次（約 2 倍速）；a0 每拍一顆到拍 30。拍 13 放行後沒有指派音了，B＝∞，尾奏（拍 14..30）
  // 照估計速度走：每拍 0.5s ÷ 1.98 ＝ 253ms；回到原譜速度的話是 500ms。
  const { log, d } = makeHp(buildBeatScore({ p0: everyBeat(14), a0: everyBeat(31) }), [['p0', 1]]);
  d.tick();
  waveSteadily(d, 14, 21);
  d.runMs(6000);
  const tail = log.filter((e) => e.t === 'on' && e.label === 'assist' && e.note >= 52 + 15).map((e) => e.ms);   // 拍 15..30
  assert(tail.length === 16, `尾奏拍 15..30 共 16 顆音都該發聲，實際 ${tail.length}`);
  const mean = (tail.at(-1) - tail[0]) / (tail.length - 1);
  assert(near(mean, 253, 12), `尾奏每拍的間隔應該約 253ms（照估計速度），實際平均 ${mean.toFixed(0)}ms`);
});

run('合併窗的長度跟著速度倍率縮短：快的合奏（每拍約 132ms）裡，晚 96ms 才揮的另一位揮的是下一拍，不是跟上同一拍', () => {
  // A 每 11 個 tick＝132ms 揮一次（樂譜每拍 500ms，約 3.8 倍速），窗長 min(250ms, 0.5s ÷ 3.8 × 0.4 ＝ 53ms)；
  // B（從沒揮過）在 A 之後 96ms 才揮，已經過了窗。窗長若不除以速度倍率會是 200ms，96ms 就被當成跟上同一拍。
  const { hp, d } = makeHp(buildBeatScore({ pA: everyBeat(40), pB: everyBeat(40) }), [['pA', 1], ['pB', 2]]);
  d.tick();
  waveSteadily(d, 17, 11);
  d.wave(1);                                                            // A 的第 18 次揮手，間隔跟前面一樣是 132ms
  const before = hp._beatIndex;
  d.runMs(84); d.wave(2);                                               // B 在 A 之後 96ms 揮手
  assert(hp._beatIndex === before + 1, `B 的揮手已經過了合併窗，應該放行下一拍（${before} → ${before + 1}），實際 ${hp._beatIndex}`);
});

run('晚到演奏者補音的範圍跟著速度倍率走：快的合奏（約 2 倍速）裡，晚 72ms 才揮第一下的人，他拍首的音仍然補上', () => {
  // A 每 21 個 tick＝252ms 揮一次（約 2 倍速），窗長 min(250ms, 0.5s ÷ 1.98 × 0.4 ＝ 101ms)；B 從沒揮過，在 A 的第 16 次
  // 揮手之後 72ms 第一次揮手（在窗內，跟上同一拍）。這 72ms 裡時鐘走了約 150ms 的樂譜（2 倍速），B 拍首的音已經是 150ms
  // 前的事：「最近一個窗內走過的音先留著」要用樂譜時間算（窗長 × r ≈ 200ms），用窗長本身（101ms）會把它丟掉。
  const { hp, log, d } = makeHp(buildBeatScore({ pA: everyBeat(40), pB: everyBeat(40) }), [['pA', 1], ['pB', 2]]);
  d.tick();
  waveSteadily(d, 15, 21);
  d.wave(1);                                                            // A 的第 16 次揮手（放行拍 15），間隔跟前面一樣
  d.runMs(60);
  const tB = d.wave(2);                                                 // B 在 A 之後 72ms 第一次揮手
  assert(hp._beatIndex === 15, `前提：B 在合併窗內，是跟上同一拍，實際拍位 ${hp._beatIndex}`);
  assert(onMs(log, 52 + 15, 'human') === tB, `B 拍 15 的音要在他揮手那個 tick（${tB}ms）補上，實際 ${onMs(log, 52 + 15, 'human')}ms`);
});

/* ═══════════════════════════════════════════
   多人：一個時鐘、一次放行一拍；路過的拍自動播放
   ═══════════════════════════════════════════ */

run('一人指派兩個聲部（左右手）：每次揮手共用拍位恰好前進一拍，不是每個聲部各推一拍', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 4], p1: [0, 4] }), [['p0', 1], ['p1', 1]]);
  d.tick();
  const beats = [];
  for (let i = 0; i < 3; i++) { d.trigger(1); d.runMs(150); beats.push(hp._beatIndex); }
  assert(beats.join() === '0,1,2', `三次揮手後拍位應為 0,1,2，實際 ${beats}`);
});

run('兩位演奏者同一個 tick 揮手：共用拍位只前進一拍', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 4], p1: [0, 4] }), [['p0', 1], ['p1', 2]]);
  d.tick();
  const beats = [];
  for (let i = 0; i < 3; i++) { d.trigger(1, 2); d.runMs(150); beats.push(hp._beatIndex); }
  assert(beats.join() === '0,1,2', `三輪同時揮手後拍位應為 0,1,2，實際 ${beats}`);
});

run('聲部處理順序無關：parts／assignments 順序對調，拍位序列與發出的音數完全相同', () => {
  const runOnce = (spec, assignments) => {
    const { hp, log, d } = makeHp(buildBeatScore(spec), assignments);
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

run('多人合併窗：兩位每拍一起揮手、其中一位晚 84ms，共用拍位一拍一拍走，不會各推一拍', () => {
  const { hp, d } = makeHp(buildBeatScore({ pA: [0, 1, 2, 3, 4, 5, 6], pB: [0, 3, 6] }), [['pA', 1], ['pB', 2]]);
  d.tick(); d.wave(1, 2);                           // 拍 0：兩人一起
  const beats = [];
  for (let i = 0; i < 4; i++) {
    d.runMs(400);
    d.trigger(1); d.runMs(84);                      // A 準時；B 晚 84ms（7 個 tick）
    d.wave(2);
    beats.push(hp._beatIndex);
  }
  assert(beats.join() === '1,2,3,4', `四輪揮手後拍位應為 1,2,3,4（晚到的一位跟上同一拍），實際 ${beats}`);
});

run('兩位演奏者一起開始、第二位晚 40ms 才揮第一下：他起始拍已經走過的音要補上（不丟音、不多推一拍）', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ pA: [0, 1, 2], pB: [0, 1, 2] }), [['pA', 1], ['pB', 2]]);
  d.tick();
  const tA = d.wave(1);                             // A 先揮：放行起始拍，時鐘走過拍首（B 還沒揮過手）
  d.runMs(36);
  const tB = d.wave(2);                             // B 晚 ~40ms：在合併窗內，跟上同一拍
  assert(hp._beatIndex === 0, `B 是跟上同一拍，不該多推一拍，實際 ${hp._beatIndex}`);
  assert(onMs(log, 40, 'human') === tA, `A 的第一顆音在他揮手那個 tick（${tA}ms）發聲，實際 ${onMs(log, 40, 'human')}ms`);
  assert(onMs(log, 52, 'human') === tB, `B 拍首的音在他揮手那個 tick（${tB}ms）補上，實際 ${onMs(log, 52, 'human')}ms`);
  d.runMs(480); const t1 = d.wave(1);
  assert(onMs(log, 41, 'human') === t1 && onMs(log, 53, 'human') === t1, '之後兩人的音都跟著時鐘，同一個 tick 發聲');
});

run('晚太久才揮第一下（超過合併窗）：他拍首已經走過的音不補，丟掉；從未揮過手的聲部不會把音一直留著', () => {
  // 拍長 0.5s，合併窗 200ms；B 在 A 之後 400ms 才第一次揮手，這時 B 拍 0 的音（0s）已經是 0.4s 前的事。
  const { log, d } = makeHp(buildBeatScore({ pA: [0, 1, 2, 3], pB: [0, 1, 2, 3], pC: [0, 1, 2, 3] }), [['pA', 1], ['pB', 2], ['pC', 3]]);
  d.tick(); d.wave(1);
  d.runMs(396); d.wave(2);                          // B 晚 ~400ms：不是跟上，是下一拍的揮手
  d.runMs(1500);
  assert(onMs(log, 52, 'human') === undefined, `B 拍 0 的音太舊了不補，實際 ${onMs(log, 52, 'human')}ms 發聲`);
  assert(onMs(log, 53, 'human') !== undefined, 'B 之後的音正常跟著時鐘');
  assert(onNotes(log, 'human').filter((n) => n >= 64).length === 0, 'C 從沒揮過手，不能憑空出聲（也不會等到後來才補出來）');
});

run('合併窗不影響單人：自己連續快揮（間隔約 100ms）每一次都前進一拍', () => {
  const { hp, d } = makeHp(buildBeatScore({ pA: [0, 1, 2, 3, 4, 5] }), [['pA', 1]]);
  d.tick(); d.wave();
  const beats = [];
  for (let i = 0; i < 4; i++) { d.runMs(96); d.wave(); beats.push(hp._beatIndex); }
  assert(beats.join() === '1,2,3,4', `單人快揮每次都要前進一拍，實際 ${beats}`);
});

run('路過的拍自動播放：揮過手的聲部，別人放行的拍它的音照樣發聲（代打音量）；從未揮過手的聲部維持靜音', () => {
  // 三位演奏者各一個每拍一顆的聲部（音高 40／52／64 起）。A、B 在拍 0 一起揮手，之後只有 A 揮；C 從沒揮過。
  const every = [0, 1, 2, 3, 4, 5];
  const { log, d } = makeHp(buildBeatScore({ pA: every, pB: every, pC: every }), [['pA', 1], ['pB', 2], ['pC', 3]]);
  d.tick(); d.wave(1, 2);
  for (let b = 1; b <= 4; b++) { d.runMs(492); d.wave(1); }
  d.runMs(600);
  assert(onNotes(log).filter((n) => n >= 40 && n < 52).length === 5, 'A 揮了 5 次，拍 0~4 的 5 顆音都該發聲');
  assert(onNotes(log).filter((n) => n >= 52 && n < 64).join() === '52,53,54,55,56',
    `B 只在拍 0 揮過手，但拍 1~4 是合奏走過的拍，他的音也要照樣發聲，實際 ${onNotes(log).filter((n) => n >= 52 && n < 64)}`);
  assert(onNotes(log).filter((n) => n >= 64).length === 0, 'C 從沒揮過手，不能憑空出聲');
  assert(cc7Of(log, 0).every((v) => v === 100), `A 每一拍都自己揮手，音量一直是真人的 100，實際 ${cc7Of(log, 0)}`);
  assert(cc7Of(log, 1).at(-1) === 85, `B 沒揮手的拍用代打音量（CC7 85），實際 ${cc7Of(log, 1)}`);
  d.wave(2);
  assert(cc7Of(log, 1).at(-1) === 100, 'B 自己再揮手，音量立刻換回真人的 100');
});

run('某個聲部沒有更多音符後再揮手：不進終局、不推進拍位，別人剩下的音不會被強制自動播完', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1], p1: [0, 1, 2, 3, 4, 5, 6, 7] }), [['p0', 1], ['p1', 2]]);
  const p1Sounded = () => onNotes(log).filter((n) => n >= 52).length; // p1 的音高 52..59
  d.tick(); d.wave(1, 2);                           // 拍 0
  d.runMs(488); d.wave(1, 2);                       // 拍 1：p0 的兩顆音都放行了（p0 沒有更多音符）
  assert(p1Sounded() === 2, `前提：p1 到這裡發過 2 顆音，實際 ${p1Sounded()}`);
  for (let i = 0; i < 3; i++) { d.runMs(488); d.wave(1); } // p0 沒有東西可演奏了，還是繼續揮
  d.runMs(1500);
  assert(p1Sounded() === 2, `p1 的演奏者沒揮手，他剩下的音不該被自動播完，實際 ${p1Sounded()} 顆`);
  assert(hp._beatIndex === 1, `沒有音可放行的揮手不該推進共用拍位，實際 ${hp._beatIndex}`);
  d.wave(2);
  assert(p1Sounded() === 3 && hp._beatIndex === 2, `p1 自己揮手後才走到拍 2 並發聲，實際 ${p1Sounded()} 顆、拍 ${hp._beatIndex}`);
});

run('演奏者離開：缺席聲部跟著合奏走過的拍照樣發聲，但剩下沒放行的音不會自己播出，曲子不算播完', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1, 2], p1: [0, 1, 2, 3, 4, 5] }), [['p0', 1], ['p1', 2]]);
  d.tick(); d.wave(1, 2);                           // 拍 0：兩人都揮，之後 p1 的演奏者離開
  for (let i = 0; i < 2; i++) { d.runMs(488); d.wave(1); } // p0 一個人放行拍 1、2
  d.runMs(500); d.wave(1);                          // p0 沒有更多音符後多揮一下
  d.runMs(6000);
  const p1Notes = onNotes(log).filter((n) => n >= 52);
  assert(p1Notes.join() === '52,53,54', `缺席的 p1 只該發拍 0~2 這三顆（合奏放行過的拍），實際 ${p1Notes}`);
  assert(!hp.isFinished(), 'p1 還有沒放行的音，曲子不該算播完');
});

run('所有指派聲部都沒有更多音符：自動終局，電腦輔助聲部的尾奏照真實時間自己播完', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 1], a0: [0, 1, 2, 3, 4, 5] }), [['p0', 1]]);
  d.tick(); d.wave();
  d.runMs(488); d.wave();                           // 拍 1：p0 最後一顆音放行，之後完全不揮手
  d.runMs(5000);
  const assistNotes = onNotes(log).filter((n) => n >= 52);  // a0 的音高 52..57
  assert(assistNotes.length === 6, `p0 演奏完後，電腦輔助的 a0 應該自己把尾奏播完（6 顆），實際 ${assistNotes.length}`);
  assert(hp.isFinished(), '整首應該自動播完，不需要多揮一下');
});

/* ═══════════════════════════════════════════
   代打：停手後只替「揮過手的聲部」走空拍，有音符的拍要本人揮手
   ═══════════════════════════════════════════ */

run('完全不揮手：代打一拍一拍走過空拍，到有音符的拍就停下等真人', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4, 6] }), [['p0', 1]]);
  const voice = hp._voices.get('p0');
  d.tick(); d.wave();                               // 觸發拍 0，之後完全不揮手
  assert(hp._beatIndex === 0, '揮手拍 0 之後應該在拍 0');
  while (d.nowMs < 2000 && hp._beatIndex < 1) d.tick();
  assert(hp._beatIndex === 1, `代打應該自動走到拍 1（空拍），實際停在 ${hp._beatIndex}`);
  assert(voice.isAutopilot === true, '走過空拍時應該標記為代打來源');
  d.runMs(3000);                                    // 拍 2 有音符：代打不該再自動往前走
  assert(hp._beatIndex === 1, `拍 2 有音符，代打不該自己往前走，實際變成 ${hp._beatIndex}`);
  assert(!onNotes(log).includes(41), '拍 2 的音符不該被代打自動發出');
  d.wave();
  assert(hp._beatIndex === 2 && onNotes(log).includes(41), '真人揮手後拍 2 的音符應該發聲');
  assert(voice.isAutopilot === false, '真人揮手後應該標記為真人來源');
});

run('全音符只需要揮一次：後面佔用的拍被代打當空拍走過，時鐘走完長音才收，且不自己走進有音符的拍', () => {
  // 拍 0 一顆 4 拍長（2.0s）的全音符，下一顆在拍 5。代打 828ms 走拍 1、之後每 504ms 一拍（拍 2、3、4）；
  // 拍 3 的拍尾是 2.0s——時鐘在 2328ms 走到，長音在那時才收。
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 2.0 }, 5] }), [['p0', 1]]);
  d.tick(); d.wave();
  d.runMs(4000);
  assert(hp._beatIndex === 4, `代打應該走到拍 4、在有音符的拍 5 前面停下，實際 ${hp._beatIndex}`);
  assert(Math.abs(offMs(log, 40) - 2328) <= 2 * TICK_MS, `長音應該在時鐘走完 2.0s（約 2328ms）才收，實際 ${offMs(log, 40)}ms`);
  assert(!onNotes(log).includes(41), '拍 5 的音符不該被代打發出');
  d.wave();
  assert(hp._beatIndex === 5 && onNotes(log).includes(41), '真人揮手後拍 5 的音符應該發聲');
});

run('長音緊接下一顆音（相連）：時鐘停在長音結尾等揮手，下一顆音一放行就接上；沒人揮就在停格門檻收掉', () => {
  // 全音符 0~2.0s、下一顆在拍 4（2.0s）——長音是相連音，代打走完拍 1~3 之後時鐘停在 2.0s（約 2328ms）。
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 2.0 }, 4] }), [['p0', 1]]);
  d.tick(); d.wave();
  d.runMs(2600);
  assert(hp._beatIndex === 3 && offMs(log, 40) === undefined, `代打停在拍 3，長音（相連）要撐著等拍 4 的音，實際拍 ${hp._beatIndex}、收音 ${offMs(log, 40)}`);
  const t = d.wave();
  assert(offMs(log, 40) === t && onMs(log, 41) === t, `拍 4 一放行，長音就在同一個 tick 收、新音發聲，實際收 ${offMs(log, 40)}ms、開 ${onMs(log, 41)}ms`);
  const { log: log2, d: d2 } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 2.0 }, 4] }), [['p0', 1]]);
  d2.tick(); d2.wave(); d2.runMs(5000);
  assert(Math.abs(offMs(log2, 40) - 3128) <= 2 * TICK_MS, `沒人揮手：時鐘停格 800ms 後（約 3128ms）收掉，實際 ${offMs(log2, 40)}ms`);
});

run('代打的步進節奏：第一步等 max(800ms, 1.5 拍)，之後每一步等剛走進那一拍的原譜秒數', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 8] }), [['p0', 1]]); // 120 BPM，拍長 0.5s
  d.tick(); d.wave();
  const t0 = d.nowMs;
  const at = (ms) => { d.runMs(t0 + ms - d.nowMs); return hp._beatIndex; };
  assert(at(700) === 0, `第一步要等約 800ms，700ms 時拍位應該還在 0，實際 ${hp._beatIndex}`);
  assert(at(900) === 1, `800ms 後代打走第一步，實際 ${hp._beatIndex}`);
  assert(at(1250) === 1, `第二步要再等一拍（0.5s），1250ms 時應該還在拍 1，實際 ${hp._beatIndex}`);
  assert(at(1450) === 2, `第二步約在 1300ms（不是固定 800ms 之後的 1600ms），1450ms 時應該到拍 2，實際 ${hp._beatIndex}`);
  assert(at(4500) === 7, `之後每拍走一步，在有音的拍 8 前面（拍 7）停下，實際 ${hp._beatIndex}`);
  assert(at(6500) === 7, `拍 8 有音，代打不能自己走進去，實際 ${hp._beatIndex}`);
});

run('慢速曲（50 BPM）準時每拍揮手：共用拍位一拍一拍走，代打不搶在揮手前面多走一拍（棘輪）', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 10] }, 1.2), [['p0', 1]]);
  d.tick(); d.wave();
  const beats = [];
  for (let i = 0; i < 5; i++) { d.runMs(1188); d.wave(); beats.push(hp._beatIndex); }
  assert(beats.join() === '1,2,3,4,5', `每 1.2s 準時揮一次，拍位應為 1,2,3,4,5，實際 ${beats}`);
});

run('代打走過空拍之後，演奏者準時揮手（落在代打那一步之後 150ms 內）照常前進，不被合併窗吸收', () => {
  // 音符每 2 拍一顆：演奏者靠代打填中間的空拍、只在有音的拍自己揮手。代打第一步比一拍晚（800ms），
  // 揮手時時鐘還落後該拍的起點一小段，追趕之後音才發聲：揮手後 100ms 內。
  const { hp, log, d } = makeHp(buildBeatScore({ pA: [0, 2, 4, 6] }), [['pA', 1]]);
  d.tick(); const waveMs = [d.wave()];
  const seen = [];
  for (let i = 0; i < 3; i++) { d.runMs(936); waveMs.push(d.wave()); seen.push(hp._beatIndex); }
  d.runMs(300);
  assert(seen.join() === '2,4,6', `每次揮手都該走到有音的拍 2,4,6，實際 ${seen}`);
  assert(onNotes(log).length === 4, `4 顆音都該發聲，實際 ${onNotes(log).length}`);
  waveMs.forEach((w, i) => assert(onMs(log, 40 + i) - w <= 100, `第 ${i + 1} 顆音應該在揮手後 100ms 內發聲，實際晚 ${onMs(log, 40 + i) - w}ms`));
});

run('閒置聲部的代打不吃掉別人的音：另一位下一拍有他的音時，代打整批不走', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ pIdle: [0, 40], pActive: [0, 1, 2] }), [['pIdle', 1], ['pActive', 2]]);
  d.tick(); d.wave(1, 2);                           // 拍 0：兩人都揮；之後 pIdle 完全閒置
  d.runMs(2500);                                    // pActive 慢了：他拍 1 的音要等他自己揮手
  const activeSecond = 40 + 12 + 1;
  assert(hp._beatIndex === 0, `pActive 的下一拍有他的音，代打不該把拍位推走，實際 ${hp._beatIndex}`);
  assert(!onNotes(log).includes(activeSecond), 'pActive 拍 1 的音還沒被他自己揮手放行，不能被代打發出');
  d.wave(2);
  assert(hp._beatIndex === 1 && onNotes(log).includes(activeSecond), 'pActive 自己揮手後，拍 1 的音應該發聲');
});

run('共用拍位因別人的動作前進後，合奏的代打倒數順延，不會緊接著再推一拍', () => {
  const { hp, d } = makeHp(buildBeatScore({ pP: [0, 3], pQ: [0, 3] }), [['pP', 1], ['pQ', 2]]);
  d.tick(); d.wave(1, 2);                           // 兩人在拍 0 一起揮手，代打武裝（約 828ms 到期）
  d.runMs(700); d.wave(1);                          // 700ms：P 揮手，共用拍位 0→1，代打倒數重新開始
  assert(hp._beatIndex === 1, `前提：P 的揮手應該讓拍位走到 1，實際 ${hp._beatIndex}`);
  d.runMs(700);                                     // 原本會在 828ms 到期
  assert(hp._beatIndex === 1, `代打倒數應該被順延，這段時間拍位不該再動，實際 ${hp._beatIndex}`);
  d.runMs(400);                                     // 順延後的到期時間過了：P 與 Q 一起到期，也只走一拍
  assert(hp._beatIndex === 2, `順延到期後兩人的代打合起來只該走一拍，實際 ${hp._beatIndex}`);
});

run('暫停再繼續不消耗代打倒數：暫停期間的時間不算靜止，恢復後照剩餘時間代打', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 8] }), [['p0', 1]]);
  d.tick(); d.wave();
  d.runMs(300);                                     // 已經靜止約 300ms（距離代打第一步還剩約 500ms）
  hp.pause();
  d.runMs(10000);                                   // 暫停很久：時鐘照走，排程器不 tick
  hp.play();
  d.runMs(400);
  assert(hp._beatIndex === 0, `恢復後只過了 400ms（剩餘約 500ms），代打不該啟動，實際拍位 ${hp._beatIndex}`);
  d.runMs(300);
  assert(hp._beatIndex === 1, `再過 300ms 就滿剩餘時間，代打應該走第一步，實際拍位 ${hp._beatIndex}`);
});

/* ═══════════════════════════════════════════
   真實樂譜（canon）：音量對比、從未揮手的聲部、整首收音成對
   ═══════════════════════════════════════════ */

const canonScore = parseMidi(new Uint8Array(readFileSync(CANON_PATH)));
const canonCello = canonScore.parts.find((p) => p.name === '大提琴');
const canonViolin = canonScore.parts.find((p) => p.name === '小提琴');

run('canon 雙人：一位休止、一位正常演奏，共用拍位每個 tick 最多前進 1（不會出現大跳）', () => {
  const { hp, d } = makeHp(canonScore, [[canonViolin.id, 1], [canonCello.id, 2]]);
  d.tick();
  let prev = hp._beatIndex, maxJump = 0;
  for (let i = 0; i < 400; i++) {
    if (i % 5 === 0) d.trigger(2);                  // 大提琴頻繁揮手，小提琴完全不揮手
    d.tick();
    maxJump = Math.max(maxJump, hp._beatIndex - prev);
    prev = hp._beatIndex;
  }
  assert(maxJump <= 1, `_beatIndex 每次最多只能前進 1，實際量到最大跳幅 ${maxJump}`);
});

run('從未揮過手的聲部不會自動出聲，也不會被代打', () => {
  const { log, d } = makeHp(canonScore, [[canonCello.id, 1], [canonViolin.id, 2]]);
  d.tick(); d.runMs(6000);                          // 兩位都在場、從沒揮手
  assert(onNotes(log, 'human').length === 0, '從未揮過手的聲部應該完全靜音');
});

run('play() 恢復播放時重新武裝靜止計時，不會立刻誤判代打', () => {
  const { hp, log, d } = makeHp(canonScore, [[canonCello.id, 1]]);
  d.tick(); d.wave();                               // 揮一次：送 CC7=100，代打倒數開始
  hp.pause();
  d.runMs(5000);                                    // 暫停很久（假時鐘照走）
  hp.play();
  const from = log.length;
  d.runMs(600);                                     // 恢復後 600ms：還不到代打的第一步
  const cc7 = log.slice(from).filter((e) => e.t === 'cc' && e.cc === 7).map((e) => e.val);
  assert(!cc7.includes(85), `恢復播放後 600ms 內不應該立刻代打（代打會把 CC7 切到 85），實際送出 ${cc7}`);
});

run('AUTOPILOT_VOLUME_CC 是 85：真人揮手送 CC7=100，代打送 CC7=85', () => {
  const { log, d } = makeHp(canonScore, [[canonCello.id, 1]]);
  d.tick(); d.wave();
  const cc7 = () => log.filter((e) => e.t === 'cc' && e.cc === 7 && e.label === 'human').map((e) => e.val);
  assert(cc7().includes(100), '真人揮手應該送過 CC7=100');
  d.runMs(5000);
  assert(cc7().includes(85), `代打應該送 CC7=85，實際送過：${[...new Set(cc7())]}`);
});

run('canon 完美演奏者（每拍準時揮手）：每顆音發聲一次，note-on 與 note-off 次數相同（一一對應）', () => {
  const { hp, log, d } = makeHp(canonScore, [[canonCello.id, 1]]);
  d.tick();
  const beats = hp._beats, b0 = hp._startBeatIndex, t0 = d.nowMs;
  for (let k = b0; k < beats.length; k++) {
    while (d.nowMs + TICK_MS < t0 + (beats[k].startSeconds - beats[b0].startSeconds) * 1000) d.tick();
    d.wave();
  }
  d.runMs(4000);
  const ons = log.filter((e) => e.t === 'on'), offs = log.filter((e) => e.t === 'off');
  assert(ons.length === canonScore.notes.length, `每顆音恰好發聲一次：樂譜 ${canonScore.notes.length} 顆、實際 ${ons.length}`);
  assert(offs.length === ons.length, `note-on ${ons.length} 個、note-off ${offs.length} 個：每個 note-on 都要有一個 note-off`);
  assert(ons.every((e) => e.vel >= 1), '不能送 velocity 0 的 noteOn（合成器會把它當 note-off）');
});

/* ═══════════════════════════════════════════
   重設／重播：stop() 與 restart() 共用同一個重設函式 _resetPlayback()
   ═══════════════════════════════════════════ */

// 排程器目前所有「會變」的狀態快照。刻意用「取全部欄位、只排除載入後不變的東西」而不是列舉欄位：
// 之後任何新增的狀態欄位忘了在 _resetPlayback() 重設，比對就會直接抓到。
function stateSnapshot(hp) {
  const state = {};
  for (const [k, v] of Object.entries(hp)) {
    if (k === 'cfg' || k === '_score' || k === '_beats' || k === '_voices' || k === 'unplacedPartIds') continue;
    if (typeof v === 'function' || (v && typeof v.noteOn === 'function')) continue; // 函式、合成器物件
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

// p0 指派給演奏者 1（拍 0、2、4、6 各一顆短音）、a1 不指派＝電腦輔助（每拍一顆短音）：
// 重設要同時覆蓋「指派聲部」與「電腦輔助聲部」兩條路徑。
const twoPartScore = () => buildBeatScore({ p0: [0, 2, 4, 6], a1: [0, 1, 2, 3, 4, 5, 6, 7] });

run('重設把排程器退回「剛載入」的狀態：播放中／暫停／播完三種情況，stop() 與 restart() 結果都相同', () => {
  const scenarios = {
    播放中: (hp, d) => { d.tick(); d.wave(); d.runMs(480); d.wave(); d.runMs(400); },   // 兩次靠近的揮手（中間沒有代打）：速度估計與上一次揮手的紀錄也要弄髒
    暫停: (hp, d) => { d.tick(); d.wave(); d.runMs(480); d.wave(); d.runMs(400); hp.pause(); },
    播完: (hp, d) => { d.tick(); for (let i = 0; i < 40 && !hp.isFinished(); i++) { d.wave(); d.runMs(500); } },
  };
  const resets = { 'stop()': (hp) => hp.stop(), 'restart()': (hp) => { hp.restart(); hp.pause(); } };
  for (const [sName, dirty] of Object.entries(scenarios)) {
    for (const [rName, reset] of Object.entries(resets)) {
      const { hp, d } = makeHp(twoPartScore(), [['p0', 1]], { play: false });
      const fresh = stateSnapshot(hp);
      hp.play();
      dirty(hp, d);
      const dirtied = snapshotDiffs(fresh, stateSnapshot(hp));
      assert(dirtied.includes('_frontierSec') && dirtied.includes('_clockSec') && dirtied.includes('p0.triggered') && dirtied.includes('_playbackRate'),
        `${sName}：前提不成立——放行邊界／時鐘／揮手紀錄／速度估計根本沒被弄髒（只有 ${dirtied}），這個比對什麼都沒驗證`);
      reset(hp);
      const diffs = snapshotDiffs(fresh, stateSnapshot(hp));
      assert(diffs.length === 0, `${sName}＋${rName}：重設後與剛載入不同的欄位：${diffs.join('、')}`);
    }
  }
});

run('restart()：整首自動播放跑完後重播，每顆音恰好再發聲一次', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4, 6] }), []);
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

run('restart() 之後代打要等真人重新揮手過才啟動（不會沿用重播前的紀錄）', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4, 6] }), [['p0', 1]]);
  const voice = hp._voices.get('p0');
  d.tick(); d.wave();
  d.runMs(2000);
  assert(hp._beatIndex === 1 && voice.isAutopilot, '前提：代打已經把拍位走到空拍 1');
  hp.restart();
  const from = log.length;
  d.runMs(3000);                                    // 重播後完全不揮手
  assert(hp._beatIndex === 0, `重播後沒人揮手，拍位應該停在 0，實際 ${hp._beatIndex}`);
  assert(voice.triggered === false && voice.isAutopilot === false, '重播後代打不該啟動');
  assert(!log.slice(from).some((e) => e.t === 'on'), '重播後沒人揮手不該有任何音發聲');
  d.wave();                                         // 第一次真人揮手（手勢計數在重播前後是連續的）
  assert(log.slice(from).filter((e) => e.t === 'on' && e.note === 40).length === 1, '第一次真人揮手應該讓拍 0 的音發聲');
});

run('restart() 把代打留下的 CC7=85 送回 100（否則會殘留到重播後的真人音）', () => {
  const { hp, log, d } = makeHp(canonScore, [[canonCello.id, 1]]);
  const voice = hp._voices.get(canonCello.id);
  d.tick(); d.wave();
  const cc7 = (from = 0) => log.slice(from).filter((e) => e.t === 'cc' && e.cc === 7 && e.label === 'human').map((e) => e.val);
  while (d.nowMs < 5000 && !cc7().includes(85)) d.tick();
  assert(cc7().at(-1) === 85, '前提：代打應該已經把 CC7 切到 85');
  const from = log.length;
  hp.restart();
  assert(cc7(from).at(-1) === 100, `重播要把 CC7 明確送回 100，實際送出：${cc7(from)}`);
  assert(voice._lastSentCc7 === 100, '去重用的 _lastSentCc7 要跟合成器上的實際值一致');
});

run('命名：未指派＝電腦輔助的聲部（assistSynth／kind:assist），指派聲部走 humanSynth／kind:human', () => {
  const { hp } = makeHp(twoPartScore(), [['p0', 1]], { play: false });
  assert(hp.assistSynth && hp.humanSynth && hp.assistSynth !== hp.humanSynth, '兩個合成器都要設好，而且是不同的兩個');
  assert(hp._voices.get('p0').kind === 'human', `指派聲部的 kind 應該是 human，實際 ${hp._voices.get('p0').kind}`);
  assert(hp._voices.get('a1').kind === 'assist', `未指派聲部（電腦輔助）的 kind 應該是 assist，實際 ${hp._voices.get('a1').kind}`);
});

run('沒有拍格線（SMPTE division，A5）＋有指派聲部：load()／stop() 不丟例外', () => {
  const smpte = { ...buildBeatScore({ p0: [0, 2, 4, 6] }), ticksPerQuarter: null };
  const { hp } = makeHp(smpte, [['p0', 1]], { play: false });
  hp.stop();
});

run('沒有拍格線（SMPTE，A5）＋指派聲部：退回整首自動播放，揮手也不丟例外', () => {
  const smpte = { ...buildBeatScore({ p0: [0, 2, 4, 6] }), ticksPerQuarter: null };
  const { hp, log, d } = makeHp(smpte, [['p0', 1]]);
  d.tick(); d.wave(); d.runMs(5000);
  assert(onNotes(log).length === 4, `沒有拍格線就整首自動播放，4 顆音各發聲一次，實際 ${onNotes(log)}`);
  assert(hp.isFinished(), '自動播放應該播完');
});

run('load(null) 清掉上一首的狀態：接著 play()／tick() 不丟例外', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2] }), [['p0', 1]]);
  d.tick(); d.wave();
  hp.load(null, []);
  hp.play();
  d.runMs(200);
  assert(hp.isPlaying() && !hp.isFinished(), '沒有樂譜時排程器照常空轉，不算播完');
});

run('放行邊界走出拍格線（軌尾收尾的零長度音落在格線盡頭）：不丟例外、不卡死，音照樣放出來', () => {
  // 整份樂譜只有 4 小節…：拍格線的最後一拍結束在 durationTicks，一顆起點剛好落在那裡的音（note-on 沒有
  // note-off、被 parser 在軌尾收尾）沒有「下一拍」可以放行。
  const score = buildBeatScore({ p0: [0] });
  score.notes.push({
    partId: 'p0', trackIndex: 0, channel: 0, program: 0, note: 99, velocity: 100,
    startTick: score.durationTicks, endTick: score.durationTicks,
    startSeconds: score.tickToSeconds(score.durationTicks), endSeconds: score.tickToSeconds(score.durationTicks), durationSeconds: 0,
  });
  const { hp, log, d } = makeHp(score, [['p0', 1]]);
  d.tick();
  for (let i = 0; i < 12; i++) { d.wave(); d.runMs(84); }   // 比最後一拍（拍 7）還多揮幾次
  d.runMs(1000);
  assert(onNotes(log).join() === '40,99', `兩顆音都該發聲，實際 ${onNotes(log)}`);
  assert(hp.isFinished(), '放完之後應該算播完');
});

/* ═══════════════════════════════════════════
   整體不變量壓力測試：固定種子的隨機譜＋隨機揮手、離開、暫停、重播
   ═══════════════════════════════════════════ */

// 每個聲部是一條單音旋律：音長取 MuseScore 風格的「記譜長度 − 1 tick」（相連音間隙 1 tick），偶爾插入休止、
// 偶爾有長音、偶爾疊一顆同音高的重疊音（檔案裡是先進先出配對），讓相連音、休止、長音、同音高重疊都會被壓到。
function buildRandomScore(rand, nParts) {
  const tpq = 480;
  const beatSec = 0.25 + rand() * 1.2;                 // 50~240 BPM
  const totalTicks = (40 + Math.floor(rand() * 40)) * tpq;
  const parts = [], notes = [];
  for (let pi = 0; pi < nParts; pi++) {
    const id = `p${pi}`;
    parts.push({ id, trackIndex: pi, channel: pi, program: 0, percussionKit: false, bank: { msb: 0, lsb: 0 } });
    const mk = (note, startTick, endTick) => ({
      partId: id, trackIndex: pi, channel: pi, program: 0, note, velocity: 90,
      startTick, endTick, startSeconds: (startTick / tpq) * beatSec, endSeconds: (endTick / tpq) * beatSec,
      durationSeconds: ((endTick - startTick) / tpq) * beatSec,
    });
    let t = 0, idx = 0;
    while (t < totalTicks) {
      const notated = [120, 240, 480, 960, 1920][Math.floor(rand() * 5)];
      if (rand() < 0.15) t += [240, 480, 960][Math.floor(rand() * 3)];
      const pitch = 40 + pi * 12 + (idx++ % 12);
      notes.push(mk(pitch, t, t + notated - 1));
      if (rand() < 0.1) notes.push(mk(pitch, t + (notated >> 1), t + notated - 1 + (notated >> 1)));
      t += notated;
    }
  }
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  const durationTicks = Math.max(...notes.map((n) => n.endTick));   // 跟 parser 一樣：譜面長度＝最晚的音符結尾
  return {
    parts, notes, durationSeconds: (durationTicks / tpq) * beatSec, durationTicks, ticksPerQuarter: tpq,
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
    const seqs = {}, balance = new Map(), emitted = new Set(), problems = [];
    let hp, maxSimultaneous = 0;
    const sounding = () => [...balance.values()].reduce((a, b) => a + b, 0);
    // 排程器用 try/catch 包住每一次 synth 呼叫（音源掛掉不能拖垮排程），假 synth 裡丟的例外會被吞掉：
    // 違規只記下來，每次呼叫排程器之後再檢查。
    const check = (cond, msg) => { if (!cond) problems.push(`seed ${seed}：${msg}`); };
    const flush = () => assert(!problems.length, problems[0]);
    const fake = (label) => ({
      controllerChange() {}, programChange() {},
      // noteOn 發生的那一刻 voice.cursor 還指在這顆音上（排程器先 noteOn 再 cursor++）。
      noteOn: (ch, note, vel) => {
        const v = [...hp._voices.values()].find((x) => x.channel === ch && (label === 'human') === (x.kind === 'human'));
        const n = v.notes[v.cursor], id = `${v.partId}#${v.cursor}`;
        check(vel >= 1, `送了 velocity 0 的 noteOn（合成器會把它當成 note-off）`);
        check(!emitted.has(id), `${id} 發聲了兩次`);
        emitted.add(id);
        check(n.startSeconds < hp._frontierSec, `${id} 還沒被放行就發聲（起音 ${n.startSeconds}s、放行邊界 ${hp._frontierSec}s）`);
        check(n.startSeconds <= hp.getPositionSeconds() + 1e-9, `${id} 時鐘還沒走到就發聲`);
        if (label === 'human') check((seqs[slotOf[v.partId]] ?? 0) > 0, `從未揮過手的聲部 ${v.partId} 發了聲`);
        const k = `${label}/${ch}/${note}`;
        balance.set(k, (balance.get(k) ?? 0) + 1);
        maxSimultaneous = Math.max(maxSimultaneous, balance.get(k));
      },
      noteOff: (ch, note) => {
        const k = `${label}/${ch}/${note}`;
        balance.set(k, (balance.get(k) ?? 0) - 1);
        check(balance.get(k) >= 0, `${k} 沒有對應的 noteOn 就 noteOff`);
      },
    });
    hp = new HumanPerformer();
    hp.setSynths(fake('assist'), fake('human'));
    hp.load(score, new Map(assignments));
    hp.play();
    const getGesture = (pid) => (pid in slotOf
      ? { present: true, triggerSeq: seqs[slotOf[pid]] ?? 0, slot: slotOf[pid] }
      : { present: false, triggerSeq: 0, slot: null });
    const lastBeat = hp._beats.length - 1;
    const pWave = 12 / (beatSec * 1000 * 0.8);         // 平均約 0.8 拍揮一次
    let now = 0, prevBeat = hp._beatIndex, prevPos = 0, advances = 0, stallReleases = 0, quietUntil = 0, minRate = Infinity, maxRate = 0;
    for (let i = 0; i < 5000; i++) {
      now += 12;
      if (i >= quietUntil && rand() < 0.002) quietUntil = i + 100 + Math.floor(rand() * 150); // 全體停手 1.2~3 秒：壓到停格
      for (const slot of [1, 2, 3]) {
        if (slot === 3 && i > 1250) continue;           // 演奏者 3 在 15 秒後離開
        if (i >= quietUntil && rand() < pWave) seqs[slot] = (seqs[slot] ?? 0) + 1;
      }
      if (rand() < 0.0008) { hp.pause(); for (let k = 0; k < 150; k++) { now += 12; hp.tick(now, getGesture); } hp.play(); }
      if (rand() < 0.0003) { hp.restart(); prevBeat = hp._beatIndex; prevPos = 0; emitted.clear(); }
      hp.tick(now, getGesture);
      flush();

      const delta = hp._beatIndex - prevBeat;
      assert(delta === 0 || delta === 1, `seed ${seed}：共用拍位每個 tick 只能增加 0 或 1，實際 ${delta}`);
      assert(hp._beatIndex <= lastBeat, `seed ${seed}：共用拍位 ${hp._beatIndex} 超出拍格線（最後一拍 ${lastBeat}）`);
      if (delta > 0) advances++;
      prevBeat = hp._beatIndex;

      const pos = hp.getPositionSeconds();
      assert(pos >= prevPos - 1e-12, `seed ${seed}：樂譜時鐘倒退了（${prevPos} → ${pos}）`);
      assert(pos <= hp._frontierSec + 1e-9, `seed ${seed}：樂譜時鐘 ${pos}s 超過放行邊界 ${hp._frontierSec}s`);
      prevPos = pos;
      assert(hp._playbackRate >= 0.25 - 1e-12 && hp._playbackRate <= 4 + 1e-12,
        `seed ${seed}：速度倍率 ${hp._playbackRate} 超出範圍 [0.25, 4]（隨機揮手、離開、暫停都不該把估計推出去）`);
      minRate = Math.min(minRate, hp._playbackRate); maxRate = Math.max(maxRate, hp._playbackRate);

      for (const v of hp._voices.values()) {            // 放行了、時鐘也走到的音，不會被留在後面沒發聲
        const n = v.notes[v.cursor];
        if (v.kind === 'human' && !v.triggered && n) {  // 還沒揮過手的聲部：只留得住最近一個合併窗內（樂譜時間：窗長 × r）走過的音
          assert(n.startSeconds >= pos - hp._followWindowSec() * hp._playbackRate - 1e-9, `seed ${seed}：${v.partId} 還沒揮過手，卻留著 ${pos - n.startSeconds}s 前的舊音`);
          continue;
        }
        assert(!n || n.startSeconds > pos + 1e-9 || n.startSeconds >= hp._frontierSec,
          `seed ${seed}：${v.partId} 的第 ${v.cursor} 顆音（${n?.startSeconds}s）已放行、時鐘（${pos}s）也走到了，卻沒發聲`);
      }
      if (hp._stallSec > hp._idleThresholdSec()) {      // 停格超過閒置門檻：沒有任何音還在響
        stallReleases++;
        assert(sounding() === 0, `seed ${seed}：停格 ${hp._stallSec}s 超過門檻，還有 ${sounding()} 個音在響`);
      }
    }
    assert(advances > 20, `seed ${seed}：前提：60 秒內共用拍位應該真的前進很多次（實際 ${advances} 次）`);
    assert(stallReleases > 0, `seed ${seed}：前提：這個壓力測試應該真的壓到停格釋放`);
    assert(maxSimultaneous >= 2, `seed ${seed}：前提：這個壓力測試應該真的壓到同音高重疊`);
    assert(maxRate - minRate > 0.1, `seed ${seed}：前提：這個壓力測試應該真的讓速度倍率動起來（實際 ${minRate.toFixed(2)}～${maxRate.toFixed(2)}）`);
    hp.pause();                                         // 收掉還在響的音之後，每個 noteOn 都剛好有一個 noteOff
    flush();
    for (const [k, v] of balance) assert(v === 0, `seed ${seed}：${k} 的 noteOn 與 noteOff 差了 ${v} 個`);
  }
});

console.log('\n全部測試跑完。');
