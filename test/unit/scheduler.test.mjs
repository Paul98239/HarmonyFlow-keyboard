// ============================================================
//  scheduler.test.mjs — src/midi/scheduler.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟 test/browser/smoke-test.mjs 同一套風格：run()／assert() 是整個專案
//  唯一的測試慣例。假 synth 只實作 controllerChange／programChange／noteOn／noteOff，並替每個
//  事件蓋上當下的假時間；每 12ms 呼叫一次 tick()，跟 midiPlayer.js 的排程 tick 一致。
//  觸發（press／pressAt）直接呼叫 trigger(slot, 假時間)，不經過 tick——一個 segment 的所有音要在這次呼叫內發聲。
//
//  模型（見 scheduler.js 檔頭）：全曲依 startTick 分成 segment，一次觸發放行下一個 segment（你的聲部與電腦輔助的聲部
//  一起發聲）；播放頭在兩次觸發之間以 playbackRate 前進、最多到下一個 segment 就停格，只管收音與進度。時間數字都是
//  照模型手算的，不是跑出來再抄回去；容許誤差以一個排程 tick（12ms）為單位。
//
//  「note-on／note-off 成對」的意思是以「音」為單位：每顆音有一個起點與一個終點（原檔的終點可能是
//  Note Off，也可能是 velocity 0 的 Note On，parser 都配成同一顆音）；排程器送給合成器的 noteOn 與
//  noteOff 次數要相同、一一對應，而且絕不送 velocity 0 的 noteOn（合成器會把它當成 note-off）。
//
//  用法：node test/unit/scheduler.test.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseMidi, buildSegments } from '../../src/midi/midiParser.js';
import { Scheduler, DEFAULT_PORTS, portsNeeded } from '../../src/midi/scheduler.js';

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
   測試工具：假合成器、假時鐘＋觸發、譜面產生器
   ═══════════════════════════════════════════ */

function makeFakeSynth(log, label, clock) {
  return {
    controllerChange: (ch, cc, val) => log.push({ t: 'cc', label, ch, cc, val, ms: clock.ms }),
    programChange: () => {},
    noteOn: (ch, note, vel) => log.push({ t: 'on', label, ch, note, vel, ms: clock.ms }),
    noteOff: (ch, note) => log.push({ t: 'off', label, ch, note, ms: clock.ms }),
  };
}

// press(slot)＝在目前的假時間觸發一次（不跑 tick，回傳有沒有放行）；pressAt(ms)＝先跑 tick 到 ms 之前，再在剛好 ms 觸發；
// gap(ms)＝兩個 tick 之間隔了很久（背景分頁被節流）。
function makeDriver(hp, clock) {
  const tick = () => { clock.ms += TICK_MS; hp.tick(clock.ms); };
  return {
    tick,
    runMs(ms) { const end = clock.ms + ms; while (clock.ms < end) tick(); },
    press(slot = 1) { return hp.trigger(slot, clock.ms); },
    pressAt(ms, slot = 1) { while (clock.ms + TICK_MS <= ms) tick(); clock.ms = ms; return hp.trigger(slot, ms); },
    gap(ms) { clock.ms += ms; hp.tick(clock.ms); },
    get nowMs() { return clock.ms; },
  };
}

function makeHp(score, assignments, { play = true } = {}) {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeFakeSynth(log, 'assist', clock), makeFakeSynth(log, 'human', clock));
  hp.load(score, new Map(assignments));
  const d = makeDriver(hp, clock);
  if (play) hp.play();
  return { hp, log, d };
}

const onNotes = (log, label) => log.filter((e) => e.t === 'on' && (!label || e.label === label)).map((e) => e.note);
const eventMs = (log, t, note, label) => log.find((e) => e.t === t && e.note === note && (!label || e.label === label))?.ms;
const onMs = (log, note, label) => eventMs(log, 'on', note, label);
const offMs = (log, note, label) => eventMs(log, 'off', note, label);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const count = (log, t, note) => log.filter((e) => e.t === t && (note === undefined || e.note === note)).length;
// 按一下之後新出現的 noteOn（回傳那一次呼叫裡發聲的所有音）。
function pressAndCollect(d, log, slot = 1) {
  const from = log.length;
  const ok = d.press(slot);
  return { ok, ons: log.slice(from).filter((e) => e.t === 'on') };
}

// 手工譜共用的尾巴：4/4、一律 480 tpq、固定速度（拍長 beatSec 秒）。tick ↔ 秒是線性的，反函數也是。
function scoreTail(notes, parts, beatSec, durationTicks) {
  const tpq = 480;
  return {
    parts, notes, segments: buildSegments(notes),
    durationSeconds: (durationTicks / tpq) * beatSec, durationTicks, timeDivision: tpq,
    timeSignatures: [{ ticks: 0, numerator: 4, denominator: 4, clocksPerClick: 24, thirtySecondNotesPer24Clocks: 8 }],
    midiTicksToSeconds: (t) => (t / tpq) * beatSec,
    secondsToMIDITicks: (s) => (s / beatSec) * tpq,
  };
}

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
        partId: id, trackIndex: pi, channel: pi, program: 0, midiNote: note, velocity: 100,
        startTick: beat * tpq, endTick: beat * tpq + Math.round((dur / beatSec) * tpq),
        startSeconds: beat * beatSec, endSeconds: beat * beatSec + dur, durationSeconds: dur,
      });
    });
  });
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  const totalBeats = Math.max(...notes.map((n) => n.startTick / tpq)) + 8;
  return scoreTail(notes, parts, beatSec, totalBeats * tpq);
}

// MuseScore 匯出相連音符的樣子：記譜長度 − 1 tick（0.5s 的拍少 1 tick），下一顆音在下一拍的拍首。
const ONE_TICK_SHORT = 0.5 * 479 / 480;

/* ═══════════════════════════════════════════
   總譜觸發：一次觸發放行全曲的下一個 segment，所有聲部的音在這次呼叫內同刻發聲（0ms）
   ═══════════════════════════════════════════ */

run('一次觸發放行全曲的下一個 segment：你的聲部與電腦輔助的聲部在 trigger() 這次呼叫內同刻發聲，放行完之後再按沒有反應', () => {
  // p0（指派）在拍 0、2、4，a1（電腦輔助）每拍一顆：全曲 5 個 segment＝拍 0～4。音高：p0 40～42、a1 52～56。
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4], a1: [0, 1, 2, 3, 4] }), [['p0', 1]]);
  d.tick();
  const want = [[40, 52], [53], [41, 54], [55], [42, 56]];
  for (let i = 0; i < want.length; i++) {
    d.runMs(100);
    const stamp = d.nowMs;
    const { ok, ons } = pressAndCollect(d, log);
    assert(ok === true, `第 ${i + 1} 次按下應該放行`);
    assert(ons.map((e) => e.note).sort().join() === want[i].join(), `第 ${i + 1} 次按下只該放出這個 segment 的音 ${want[i]}，實際 ${ons.map((e) => e.note)}`);
    assert(ons.every((e) => e.ms === stamp), `這個 segment 的所有音要在按下的那一刻（${stamp}ms）發聲，實際 ${ons.map((e) => `${e.note}@${e.ms}`)}`);
    assert(ons.every((e) => e.label === (e.note < 50 ? 'human' : 'assist')), '指派聲部走 human 合成器、電腦輔助走 assist 合成器');
  }
  const from = log.length;
  assert(d.press() === false && log.length === from, 'segment 都放行完了，再按不該有任何反應');
});

run('按得再快也不跳過任何一顆音：同一毫秒連按五下，全曲每顆音依序各發聲一次', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4], a1: [0, 1, 2, 3, 4] }), [['p0', 1]]);
  d.tick();
  for (let i = 0; i < 5; i++) assert(d.press() === true, `第 ${i + 1} 下應該放行`);
  assert(onNotes(log).join() === '40,52,53,41,54,55,42,56', `全曲 8 顆音依 segment 順序發聲，實際 ${onNotes(log)}`);
  assert(d.press() === false, '放行完');
});

run('和弦與多聲部同一個 tick 起音＝同一個 segment：一次觸發全部發聲，下一次才換下一個', () => {
  const { log, d } = makeHp(buildBeatScore({
    p0: [{ beat: 0, note: 60 }, { beat: 0, note: 64 }, { beat: 0, note: 67 }, { beat: 1, note: 72 }],
    a1: [{ beat: 0, note: 36 }],
  }), [['p0', 1]]);
  d.tick(); d.runMs(50);
  const t = d.nowMs;
  assert(d.press() === true, '第一次按下');
  assert(onNotes(log).sort().join() === '36,60,64,67' && [36, 60, 64, 67].every((n) => onMs(log, n) === t), `和弦三顆音與電腦輔助的低音要在同一刻發聲，實際 ${onNotes(log)}`);
  assert(d.press() === true && onNotes(log).includes(72), '第二次按下才放出下一個 segment 的音');
});

run('聲部開頭有空白小節（卡農式）：你的聲部還在休止時，按鍵照樣一顆顆推進電腦輔助聲部，輪到你時兩邊同刻', () => {
  // p0（指派）從拍 4 才進來，a1 從拍 0 就開始：前四下只放電腦輔助的音，第五下 p0 與 a1 同刻。
  const { log, d } = makeHp(buildBeatScore({ p0: [4, 5, 6], a1: [0, 1, 2, 3, 4, 5, 6] }), [['p0', 1]]);
  d.tick();
  for (let i = 0; i < 4; i++) {
    const stamp = d.nowMs + 10;
    d.runMs(10);
    const { ok, ons } = pressAndCollect(d, log);
    assert(ok && ons.length === 1 && ons[0].label === 'assist' && ons[0].note === 52 + i && ons[0].ms === d.nowMs && stamp <= d.nowMs, `第 ${i + 1} 下：只放出電腦輔助的第 ${i + 1} 顆音，實際 ${JSON.stringify(ons)}`);
  }
  assert(onNotes(log, 'human').length === 0, '你的聲部還在休止，不該有音');
  const { ons } = pressAndCollect(d, log);
  assert(ons.length === 2 && ons.some((e) => e.label === 'human' && e.note === 40) && ons.some((e) => e.label === 'assist' && e.note === 56) && ons[0].ms === ons[1].ms,
    `第五下：你的第一顆音與電腦輔助的音同刻，實際 ${JSON.stringify(ons)}`);
});

run('沒有放行的情況：沒在播放、槽位沒有指派聲部、暫停中、整首自動播放、載入空樂譜，trigger() 都回傳 false 而且不發聲', () => {
  const score = buildBeatScore({ p0: [0, 2], a1: [0, 1] });
  const stopped = makeHp(score, [['p0', 1]], { play: false });
  assert(stopped.d.press() === false, '還沒 play()');
  const { hp, log, d } = makeHp(score, [['p0', 1]]);
  assert(d.press(2) === false, '槽位 2 沒有指派任何聲部，沒有資格推進全曲');
  hp.pause();
  assert(d.press() === false, '暫停中');
  const auto = makeHp(score, []);
  assert(auto.d.press() === false, '沒有人被指派＝整首自動播放，不接受觸發');
  const empty = new Scheduler();
  empty.load(null, []);
  empty.play();
  assert(empty.trigger(1, 0) === false, '沒有樂譜');
  assert(onNotes(log).length === 0 && onNotes(stopped.log).length === 0 && onNotes(auto.log).length === 0, '這些情況都不該發聲');
});

run('零長度的音（起點＝終點，軌尾收尾的音）：照樣發聲、收音，每個 noteOn 一個 noteOff', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 0, note: 99 }] }), [['p0', 1]]);
  d.tick(); d.press();
  assert(count(log, 'on', 99) === 1 && count(log, 'off', 99) === 1, `一個 noteOn、一個 noteOff，實際 ${count(log, 'on', 99)}／${count(log, 'off', 99)}`);
  assert(offMs(log, 99) === onMs(log, 99), '零長度的音在同一次呼叫內收掉');
  assert(hp.isFinished(), '放行完而且沒有音在響＝播完');
});

run('沒有 tick 換算的檔案（SMPTE division，timeDivision＝null）也能逐段觸發：不丟例外，相連音不撐', () => {
  const smpte = { ...buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), timeDivision: null };
  const { log, d } = makeHp(smpte, [['p0', 1]]);
  d.tick(); d.press(); d.runMs(700);
  assert(count(log, 'off', 40) === 1, '沒有 tick 換算就沒有相連音判斷：照檔案收音，不撐');
  d.press();
  assert(count(log, 'on', 41) === 1, '照常放行下一個 segment');
});

/* ═══════════════════════════════════════════
   播放頭：兩次觸發之間只管收音與進度，永遠不自己放出起音
   ═══════════════════════════════════════════ */

run('沒有人觸發就不放出任何起音：有指派時 tick() 空跑 10 秒，電腦輔助聲部也不出聲，進度停在 0', () => {
  // 第一個 segment 在拍 2（tick 960）：如果播放頭在沒人觸發時就開始走，10 秒內會走到 960，進度就不是 0。
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [2, 4], a1: [2, 3] }), [['p0', 1]]);
  d.runMs(10000);
  assert(onNotes(log).length === 0, `不該有任何音，實際 ${onNotes(log)}`);
  assert(hp.getPositionTicks() === 0 && !hp.isFinished(), `進度停在 0、不算播完（還在等你開始），實際 ${hp.getPositionTicks()}`);
});

run('兩次觸發之間播放頭照 playbackRate 前進，最多走到下一個 segment 就停格，不會自己放起音', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 4] }), [['p0', 1]]); // segment：tick 0、1920
  d.tick(); d.press();
  assert(hp.getPositionTicks() === 0, '剛放行 segment 0，播放頭在它的 tick（0）');
  d.runMs(1000);
  assert(near(hp.getPositionTicks(), 960, 30), `第一次觸發後速度是 1×，1 秒＝2 拍＝960 tick，實際 ${hp.getPositionTicks()}`);
  d.runMs(3000);
  assert(near(hp.getPositionTicks(), 1920, 1e-6), `停格在下一個 segment（tick 1920），不會越過，實際 ${hp.getPositionTicks()}`);
  assert(onNotes(log).join() === '40', '一直沒按，第二個 segment 的音不會自己放出來');
});

run('playbackRate 取自最近兩次觸發的間隔（樂譜秒 ÷ 真實秒），夾在 [0.25, 4]；第一次觸發前後都是 1', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2, 3] }), [['p0', 1]]);
  d.tick();
  assert(hp.playbackRate === 1, '還沒觸發：1');
  const t0 = d.nowMs;
  d.press();
  assert(hp.playbackRate === 1, '第一次觸發沒有間隔可估，維持 1');
  d.pressAt(t0 + 250);
  assert(near(hp.playbackRate, 2, 1e-9), `一拍（0.5s）在 0.25s 內按完＝2×，實際 ${hp.playbackRate}`);
  d.pressAt(t0 + 250);
  assert(hp.playbackRate === 4, `同一毫秒連按（估出趨近無限大）夾在上限 4，實際 ${hp.playbackRate}`);
  const slow = makeHp(buildBeatScore({ p0: [0, 1] }), [['p0', 1]]);
  slow.d.tick(); slow.d.press(); slow.d.gap(30000); slow.d.press();
  assert(slow.hp.playbackRate === 0.25, `隔很久才按（估出趨近 0）夾在下限 0.25，實際 ${slow.hp.playbackRate}`);
});

run('你停手超過閒置門檻之後再按：那一段不當成演奏速度，playbackRate 維持原本的值', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2] }), [['p0', 1]]);
  d.tick(); const t0 = d.nowMs;
  d.press(); d.pressAt(t0 + 250);               // rate ＝ 2
  d.runMs(3000);                                // 播放頭停在下一個 segment，停格 > 800ms
  d.press();
  assert(near(hp.playbackRate, 2, 1e-9), `停手 3 秒不該把速度拉到 0.25，實際 ${hp.playbackRate}`);
});

run('音長在 tick 軸上隨 playbackRate 縮放：你按快（2×），0.4s 的音真實只響 0.2s；按慢則照檔案收', () => {
  const dur = 0.4;                               // 384 tick
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur }, { beat: 1, dur }, { beat: 2, dur }] }), [['p0', 1]]);
  d.tick(); const t0 = d.nowMs;
  d.press(); d.pressAt(t0 + 250);               // rate ＝ 2；播放頭跳到 tick 480
  const t1 = d.nowMs;
  assert(offMs(log, 40) === t1, '第二次按下時第一顆音（結尾 tick 384 ≤ 480）已到期：先收再放，在按下的那一刻收掉');
  d.runMs(600);
  assert(near(offMs(log, 41) - t1, 200, 30), `第二顆音（384 tick）在 2× 下真實約 200ms 收掉，實際 ${offMs(log, 41) - t1}ms`);
});

run('同音高重疊（先進先出）：兩顆同音高的重疊音各自在自己的 tick 收，不留卡音', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 1.0, note: 60 }, { beat: 1, dur: 1.0, note: 60 }] }), [['p0', 1]]);
  d.tick(); const t0 = d.nowMs;
  d.press(); d.pressAt(t0 + 500);               // 準時按（速度 1×）
  d.runMs(2500);
  const offs = log.filter((e) => e.t === 'off' && e.note === 60).map((e) => e.ms);
  assert(count(log, 'on', 60) === 2 && offs.length === 2, `兩個 noteOn、兩個 noteOff，實際 ${count(log, 'on', 60)}／${offs.length}`);
  assert(near(offs[0] - t0, 1000, 30) && near(offs[1] - t0, 1500, 30), `先進先出：第一顆在樂譜 1.0s、第二顆在 1.5s 收，實際 ${offs.map((m) => m - t0)}`);
  assert(hp.isFinished(), '全部放行、收音之後算播完');
});

run('停格超過閒置門檻（800ms）：還在響的長音收掉，不能無限期掛著；之後照常往下按', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 5 }, 1] }), [['p0', 1]]); // 長音 5s，下一個 segment 在 0.5s
  d.tick(); const t0 = d.nowMs;
  d.press();
  d.runMs(1100);                                 // 播放頭 0.5s 到達下一個 segment 停格，停格約 600ms：還沒到門檻
  assert(count(log, 'off', 40) === 0, '停格還沒超過 800ms，長音還在響');
  d.runMs(500);
  assert(count(log, 'off', 40) === 1 && near(offMs(log, 40) - t0, 500 + 800, 40), `停格超過 800ms 收掉，實際在 ${offMs(log, 40) - t0}ms`);
  d.press();
  assert(count(log, 'on', 41) === 1 && count(log, 'off', 40) === 1, '之後照常放行，長音不會再收第二次');
});

run('相連音在播放頭停格等你時撐住：後繼音放行的那一刻先關舊音再開新音，中間沒有空白（你的聲部）', () => {
  // 第一顆音比下一拍短 1 tick（MuseScore 的相連音寫法）：播放頭走到 tick 479 它到期，但後繼音還沒放行，撐住。
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, { beat: 1, dur: 0.4 }] }), [['p0', 1]]);
  d.tick(); d.press();
  d.runMs(700);                                  // 停格約 200ms，未超過閒置門檻
  assert(count(log, 'off', 40) === 0, '後繼音還沒放行，相連音撐住不收');
  d.press();
  const iOff = log.findIndex((e) => e.t === 'off' && e.note === 40), iOn = log.findIndex((e) => e.t === 'on' && e.note === 41);
  assert(iOff !== -1 && iOff < iOn && log[iOff].ms === log[iOn].ms, `後繼音放行的同一刻：先關舊音、再開新音，實際 off#${iOff}@${log[iOff]?.ms} on#${iOn}@${log[iOn]?.ms}`);
});

run('相連音撐住同樣適用電腦輔助聲部：你按下一個 segment 的那一刻它才關', () => {
  const { log, d } = makeHp(buildBeatScore({ p1: [0, 1], a0: [{ beat: 0, dur: ONE_TICK_SHORT }, { beat: 1, dur: 0.4 }] }), [['p1', 1]]);
  d.tick(); d.press();
  d.runMs(700);
  assert(count(log, 'off', 52) === 0, '電腦輔助的相連音在你還沒按時撐住');
  d.press();
  assert(offMs(log, 52, 'assist') === onMs(log, 53, 'assist') && log.findIndex((e) => e.t === 'off' && e.note === 52) < log.findIndex((e) => e.t === 'on' && e.note === 53), '你按下的那一刻先關舊音再開新音');
});

run('相連音撐住也會被閒置收音收掉（停格超過 800ms），不能無限期掛著', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  d.tick(); d.press();
  d.runMs(2000);
  assert(count(log, 'off', 40) === 1, `停格超過門檻，撐住的相連音收掉，實際 ${count(log, 'off', 40)} 個 noteOff`);
});

run('相連音遇到同音高重複：先關舊音再開新音，新音不會被連帶關掉', () => {
  const { log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: ONE_TICK_SHORT, note: 60 }, { beat: 1, dur: 0.4, note: 60 }] }), [['p0', 1]]);
  d.tick(); d.press(); d.runMs(300); d.press(); d.runMs(1000);
  const seq = log.filter((e) => e.note === 60 && (e.t === 'on' || e.t === 'off')).map((e) => e.t).join();
  assert(seq === 'on,off,on,off', `應為 on,off,on,off，實際 ${seq}`);
});

run('每個 tick 的時間步長上限 100ms：分頁被節流後恢復，播放頭不會一次衝過一大段（手動、自動播放都一樣）', () => {
  const manual = makeHp(buildBeatScore({ p0: [0, 8] }), [['p0', 1]]);
  manual.d.tick(); manual.d.press(); manual.d.tick();
  manual.d.gap(5000);
  assert(manual.hp.getPositionTicks() < 120, `隔 5 秒才醒來，播放頭最多多走 0.1s（96 tick），實際 ${manual.hp.getPositionTicks()}`);
  const auto = makeHp(buildBeatScore({ a0: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), []);
  auto.d.tick();
  auto.d.gap(5000);
  assert(onNotes(auto.log).length === 1, `自動播放隔 5 秒才醒來，不會一次吐出一大段音，實際 ${onNotes(auto.log).length} 顆`);
});

run('暫停會收掉所有還在響的音（你的音、撐住的輔助音），恢復播放後不重複收，也不把暫停當成兩次觸發的間隔', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 3 }, 1], a1: [{ beat: 0, dur: ONE_TICK_SHORT }, 1] }), [['p0', 1]]);
  d.tick(); d.press(); d.runMs(100);
  const posBefore = hp.getPositionTicks();
  hp.pause();
  assert(count(log, 'off', 40) === 1 && count(log, 'off', 52) === 1, '暫停對你的長音與撐住的輔助音各送一個 noteOff');
  assert(log.some((e) => e.t === 'cc' && e.cc === 123), '另外送 CC123 當保險');
  d.gap(5000);                                   // 暫停期間時間照樣過（tick 不處理），恢復後第一次按鍵距離上一次按鍵 5 秒
  hp.play(); d.runMs(36);
  assert(count(log, 'off', 40) === 1 && count(log, 'off', 52) === 1, '恢復播放後不再重複收');
  assert(hp.getPositionTicks() >= posBefore, '播放頭與 segment 游標都保留');
  d.press();
  assert(count(log, 'on', 41) === 1 && hp.playbackRate === 1, `從原處繼續放行下一個 segment；暫停那 5 秒不拿來估速度，實際 ${hp.playbackRate}`);
});

run('放行完最後一個 segment 之後：播放頭不再受限，尾音照時值收完才算播完', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [{ beat: 0, dur: 1.5 }] }), [['p0', 1]]);
  d.tick();
  assert(!hp.isFinished(), '還沒觸發，不算播完');
  d.press();
  assert(!hp.isFinished(), '放行完了但音還在響，不算播完');
  d.runMs(6000);                                 // 播放頭不再受限，繼續走過整首的總長（8 拍＝3840 tick）
  assert(hp.isFinished(), '尾音收完＝播完');
  assert(hp.getPositionTicks() === hp._score.durationTicks, `進度夾在總長（${hp._score.durationTicks} tick），實際 ${hp.getPositionTicks()}`);
});

/* ═══════════════════════════════════════════
   整首自動播放（沒有指派）：播放頭 1× 連續前進，走到的 segment 自動放行
   ═══════════════════════════════════════════ */

run('整首自動播放（沒有指派）：每顆音在樂譜時間發聲（誤差在兩個 tick 內），每個 noteOn 一個 noteOff，跑完算播完', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ a0: [0, 2, 4, 6], a1: [1, 3] }), []);
  d.tick();
  const base = d.nowMs;
  while (!hp.isFinished() && d.nowMs < 10000) d.tick();
  assert(hp.isFinished(), '應該自己播完');
  const want = [[40, 0], [52, 1], [41, 2], [53, 3], [42, 4], [43, 6]];
  for (const [note, beat] of want) {
    const ms = onMs(log, note);
    assert(ms !== undefined && ms - (base + beat * 500) >= 0 && ms - (base + beat * 500) <= 2 * TICK_MS, `音高 ${note} 應在樂譜拍 ${beat}（${base + beat * 500}ms）後 ${2 * TICK_MS}ms 內發聲，實際 ${ms}`);
  }
  assert(count(log, 'on') === 6 && count(log, 'off') === 6, `6 個 noteOn、6 個 noteOff，實際 ${count(log, 'on')}／${count(log, 'off')}`);
});

run('整首自動播放：每顆音照編碼收，不撐——舊音在檔案寫的結尾收，再開新音', () => {
  // 第一顆音比下一拍短 20 tick（小於相連音門檻 30 tick）：手動演奏時它會被撐住等你按，自動播放不撐，照檔案在 tick 460 收。
  const { hp, log, d } = makeHp(buildBeatScore({ a0: [{ beat: 0, dur: 0.5 * 460 / 480 }, { beat: 1, dur: 0.4 }] }), []);
  while (!hp.isFinished() && d.nowMs < 5000) d.tick();
  const iOff = log.findIndex((e) => e.t === 'off' && e.note === 40), iOn = log.findIndex((e) => e.t === 'on' && e.note === 41);
  assert(iOff !== -1 && iOff < iOn, `先關舊音、再開新音，實際 off#${iOff}@${log[iOff]?.ms} on#${iOn}@${log[iOn]?.ms}`);
  const gap = log[iOn].ms - log[iOff].ms;
  assert(gap >= TICK_MS && gap <= 3 * TICK_MS, `不撐：舊音在 tick 460 收，比新音早約 20 tick（≈21ms），不是等到新音才收；實際相差 ${gap}ms`);
});

/* ═══════════════════════════════════════════
   canon 實際樂譜：任何按鍵速度下，上下對齊（同一個 segment 的音同刻）、不跳音、每個 noteOn 一個 noteOff
   ═══════════════════════════════════════════ */

const canonScore = parseMidi(readFileSync(CANON_PATH));
const canonCello = canonScore.parts.find((p) => p.name === '大提琴');
const canonViolin = canonScore.parts.find((p) => p.name === '小提琴');

const canonStyles = [
  { name: '準時（每個 segment 在樂譜時間按）', k: 1, jitter: 0 },
  { name: '比原譜快 2 倍', k: 0.5, jitter: 0 },
  { name: '比原譜慢 2 倍（常常停手超過閒置門檻）', k: 2, jitter: 0 },
  { name: '連珠炮（快 7 倍）', k: 0.15, jitter: 0 },
  { name: '慢 25％＋抖動', k: 1.25, jitter: 40 },
];
for (const style of canonStyles) {
  run(`canon（大提琴指派、小提琴輔助）${style.name}：每次按下的 segment 裡所有音在這次呼叫內同刻發聲，全曲每顆音恰好一次`, () => {
    const { hp, log, d } = makeHp(canonScore, [[canonCello.id, 1]]);
    d.tick();
    const base = d.nowMs;
    let prevMs = base;
    canonScore.segments.forEach((seg, i) => {
      const ms = Math.max(prevMs + 1, base + canonScore.midiTicksToSeconds(seg.ticks) * 1000 * style.k + ((i * 7) % 5) * (style.jitter / 4));
      prevMs = ms;
      d.pressAt(ms);
      // pressAt 回傳 trigger 的結果，但這裡要看那一次呼叫放出的音：用 log 裡蓋著 ms 這個時間戳的 noteOn 數量
      const ons = log.filter((e) => e.t === 'on' && e.ms === ms);
      assert(ons.length === seg.notes.length, `第 ${i} 個 segment（tick ${seg.ticks}）應在按下的那一刻放出 ${seg.notes.length} 顆音，實際 ${ons.length} 顆`);
      assert(ons.map((e) => e.note).sort().join() === seg.notes.map((n) => n.midiNote).sort().join(), `第 ${i} 個 segment 的音高不符`);
      assert(ons.filter((e) => e.label === 'human').length === seg.notes.filter((n) => n.partId === canonCello.id).length, `第 ${i} 個 segment 裡大提琴的音要走真人合成器、小提琴的音走電腦輔助`);
    });
    assert(d.press() === false, '全部放行完');
    while (!hp.isFinished() && d.nowMs < prevMs + 60000) d.tick();
    const ons = log.filter((e) => e.t === 'on'), offs = log.filter((e) => e.t === 'off');
    assert(ons.length === canonScore.notes.length, `每顆音恰好發聲一次：樂譜 ${canonScore.notes.length} 顆、實際 ${ons.length}`);
    assert(offs.length === ons.length, `note-on ${ons.length} 個、note-off ${offs.length} 個：每個 note-on 都要有一個 note-off`);
    assert(ons.every((e) => e.vel >= 1), '不能送 velocity 0 的 noteOn（合成器會把它當 note-off）');
    assert(hp.isFinished(), '全部放行、收音之後算播完');
  });
}

/* ═══════════════════════════════════════════
   重設／重播：stop() 與 restart() 共用同一個重設函式 _resetPlayback()
   ═══════════════════════════════════════════ */

// 排程器目前所有「會變」的狀態快照。刻意用「取全部欄位、只排除載入後不變的東西」而不是列舉欄位：
// 之後任何新增的狀態欄位忘了在 _resetPlayback() 重設，比對就會直接抓到。
function stateSnapshot(hp) {
  const state = {};
  for (const [k, v] of Object.entries(hp)) {
    if (k === 'cfg' || k === '_score' || k === '_staves' || k === '_segments' || k === 'unplacedStaffIds') continue;
    if (typeof v === 'function' || (v && typeof v.noteOn === 'function')) continue; // 函式、合成器物件
    state[k] = v;
  }
  const staves = {};
  for (const [id, staff] of hp._staves) { const { notes, ...rest } = staff; staves[id] = rest; }
  return structuredClone({ state, staves });
}
function snapshotDiffs(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.state), ...Object.keys(b.state)])) {
    if (!isDeepStrictEqual(a.state[k], b.state[k])) out.push(k);
  }
  for (const id of new Set([...Object.keys(a.staves), ...Object.keys(b.staves)])) {
    for (const k of new Set([...Object.keys(a.staves[id] || {}), ...Object.keys(b.staves[id] || {})])) {
      if (!isDeepStrictEqual(a.staves[id]?.[k], b.staves[id]?.[k])) out.push(`${id}.${k}`);
    }
  }
  return out;
}

// p0 指派給演奏者 1（拍 0、2、4、6 各一顆短音）、a1 不指派＝電腦輔助（每拍一顆短音）：
// 重設要同時覆蓋「指派聲部」與「電腦輔助聲部」兩條路徑。
const twoPartScore = () => buildBeatScore({ p0: [0, 2, 4, 6], a1: [0, 1, 2, 3, 4, 5, 6, 7] });

run('重設把排程器退回「剛載入」的狀態：播放中／暫停／播完三種情況，stop() 與 restart() 結果都相同', () => {
  const scenarios = {
    播放中: (hp, d) => { d.tick(); d.press(); d.runMs(480); d.press(); d.runMs(400); },
    暫停: (hp, d) => { d.tick(); d.press(); d.runMs(480); d.press(); d.runMs(400); hp.pause(); },
    播完: (hp, d) => { d.tick(); for (let i = 0; i < 8; i++) d.press(); d.runMs(6000); },
  };
  const resets = { 'stop()': (hp) => hp.stop(), 'restart()': (hp) => { hp.restart(); hp.pause(); } };
  for (const [sName, dirty] of Object.entries(scenarios)) {
    for (const [rName, reset] of Object.entries(resets)) {
      const { hp, d } = makeHp(twoPartScore(), [['p0', 1]], { play: false });
      const fresh = stateSnapshot(hp);
      hp.play();
      dirty(hp, d);
      const dirtied = snapshotDiffs(fresh, stateSnapshot(hp));
      for (const k of ['_segIndex', '_ticks', '_lastSegTicks', '_started', '_lastTrigger', 'playbackRate']) {
        assert(dirtied.includes(k), `${sName}：前提不成立——${k} 根本沒被弄髒（只有 ${dirtied}），這個比對什麼都沒驗證`);
      }
      reset(hp);
      const diffs = snapshotDiffs(fresh, stateSnapshot(hp));
      assert(diffs.length === 0, `${sName}＋${rName}：重設後與剛載入不同的欄位：${diffs.join('、')}`);
    }
  }
});

run('restart()：整首自動播放跑完後重播，每顆音恰好再發聲一次', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ a0: [0, 2, 4, 6] }), []);
  const onCount = () => log.filter((e) => e.t === 'on').length;
  while (!hp.isFinished() && d.nowMs < 10000) d.tick();
  assert(hp.isFinished(), '前提：第一輪應該播完');
  assert(onCount() === 4, `第一輪 4 顆音都要發聲，實際 ${onCount()}`);
  hp.restart();
  assert(hp.isPlaying() && !hp.isFinished(), 'restart() 之後應該在播放中、而且不是已播完');
  assert(hp.getPositionTicks() < 5, `restart() 之後進度應該回到開頭，實際 ${hp.getPositionTicks()}`);
  const before = onCount();
  while (!hp.isFinished() && d.nowMs < 20000) d.tick();
  assert(hp.isFinished(), '重播後應該再次播完');
  assert(onCount() - before === 4, `重播後 4 顆音都要再發聲一次（不多不少），實際 ${onCount() - before}`);
});

run('restart() 之後要重新觸發才會發聲：segment 游標回到第一個，不沿用重播前的紀錄', () => {
  const { hp, log, d } = makeHp(buildBeatScore({ p0: [0, 2, 4, 6] }), [['p0', 1]]);
  d.tick(); d.press(); d.press();
  hp.restart();
  const from = log.length;
  d.runMs(3000);                                     // 重播後完全不按
  assert(!log.slice(from).some((e) => e.t === 'on'), '重播後沒按鍵，不該有任何音發聲');
  assert(!hp.isFinished() && hp.getPositionTicks() === 0, '還沒有人觸發，不算播完，進度停在 0');
  d.press();
  assert(log.slice(from).filter((e) => e.t === 'on' && e.note === 40).length === 1, '重播後第一次觸發應該是第一個 segment（音高 40）');
});

run('命名：未指派＝電腦輔助的聲部（assistSynth／kind:assist），指派聲部走 humanSynth／kind:human', () => {
  const { hp } = makeHp(twoPartScore(), [['p0', 1]], { play: false });
  assert(hp.assistSynth && hp.humanSynth && hp.assistSynth !== hp.humanSynth, '兩個合成器都要設好，而且是不同的兩個');
  assert(hp._staves.get('p0').kind === 'human', `指派聲部的 kind 應該是 human，實際 ${hp._staves.get('p0').kind}`);
  assert(hp._staves.get('a1').kind === 'assist', `未指派聲部（電腦輔助）的 kind 應該是 assist，實際 ${hp._staves.get('a1').kind}`);
});

run('load(null) 清掉上一首的狀態：接著 play()／tick() 不丟例外', () => {
  const { hp, d } = makeHp(buildBeatScore({ p0: [0, 1, 2] }), [['p0', 1]]);
  d.tick(); d.press();
  hp.load(null, []);
  hp.play();
  d.runMs(200);
  assert(hp.isPlaying() && !hp.isFinished(), '沒有樂譜時排程器照常空轉，不算播完');
});

/* ═══════════════════════════════════════════
   staff 化：一個 part 底下有多個 staff（鋼琴兩行譜、弓弦的 pizzicato channel）、打擊 channel 分配、
   初始 CC、baseVolume。part.staves 是新資料形狀；沒有 staves 的 part 是舊形狀，視為單一 staff。
   ═══════════════════════════════════════════ */

// 假合成器：記下 program 與每個 CC，順序就是送出的順序（初始化要在第一個 noteOn 之前）。
function makeLoggingSynth(log, label, clock) {
  return {
    controllerChange: (ch, cc, val) => log.push({ t: 'cc', label, ch, cc, val, ms: clock.ms }),
    programChange: (ch, program) => log.push({ t: 'pc', label, ch, program, ms: clock.ms }),
    noteOn: (ch, note, vel) => log.push({ t: 'on', label, ch, note, vel, ms: clock.ms }),
    noteOff: (ch, note) => log.push({ t: 'off', label, ch, note, ms: clock.ms }),
  };
}
function makeStaffHp(score, assignments, { play = true } = {}) {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeLoggingSynth(log, 'assist', clock), makeLoggingSynth(log, 'human', clock));
  hp.load(score, new Map(assignments));
  const d = makeDriver(hp, clock);
  if (play) hp.play();
  return { hp, log, d };
}

// spec：[{ id, staves: [{ id, program?, kit?（鼓組 program）, init?, bank?, notes: [拍序號…] }] }]。每個 staff 一條單音旋律。
function buildStaffScore(spec, beatSec = 0.5) {
  const tpq = 480, notes = [], parts = [];
  spec.forEach((p, pi) => {
    const staves = p.staves.map((v, vi) => {
      const staff = {
        id: v.id, partId: p.id, trackIndex: pi, channel: v.channel ?? pi * 4 + vi,
        program: v.program ?? v.kit ?? 0, bank: v.bank ?? { msb: v.kit !== undefined ? 120 : 121, lsb: 0 },
        percussionKit: v.kit !== undefined, init: v.init ?? null, noteCount: v.notes.length,
      };
      v.notes.forEach((beat, ni) => {
        notes.push({
          partId: p.id, staffId: v.id, trackIndex: pi, channel: staff.channel, midiNote: v.pitch ?? 40 + parts.length * 12 + vi * 6 + ni, velocity: 100,
          startTick: beat * tpq, endTick: beat * tpq + 12, startSeconds: beat * beatSec, endSeconds: beat * beatSec + 0.025, durationSeconds: 0.025,
        });
      });
      return staff;
    });
    parts.push({ id: p.id, name: p.id, noteCount: staves.reduce((s, v) => s + v.noteCount, 0), staves });
  });
  notes.sort((a, b) => a.startTick - b.startTick || a.trackIndex - b.trackIndex);
  const totalBeats = Math.max(...notes.map((n) => n.startTick / tpq)) + 8;
  return scoreTail(notes, parts, beatSec, totalBeats * tpq);
}

run('staff 化：一個 part 兩個 staff（鋼琴兩行譜）各拿一個輸出 channel、都走真人軌、共用同一個指派槽位；音符依 staffId 分給各自的 staff；一次觸發兩個譜表一起發聲', () => {
  const score = buildStaffScore([
    { id: 'piano', staves: [{ id: 't1c0', notes: [0, 2], pitch: 72 }, { id: 't2c0', notes: [0, 2], pitch: 48 }] },
    { id: 'flute', staves: [{ id: 't3c1', notes: [0, 2], pitch: 80 }] },
  ]);
  const { hp, log, d } = makeStaffHp(score, [['piano', 1]]);
  assert(hp._staves.size === 3, `3 個 staff（鋼琴 2、長笛 1），實際 ${hp._staves.size}`);
  const upper = hp._staves.get('t1c0'), lower = hp._staves.get('t2c0'), flute = hp._staves.get('t3c1');
  assert(upper && lower && flute, `staff 要用 staffId 當 key，實際 ${[...hp._staves.keys()]}`);
  assert(upper.kind === 'human' && lower.kind === 'human' && flute.kind === 'assist', '鋼琴的兩個 staff 都走真人軌，長笛走電腦輔助');
  assert(upper.slot === 1 && lower.slot === 1 && upper.partId === 'piano' && lower.partId === 'piano', '兩個 staff 共用 part 的指派槽位、partId 保留');
  assert(upper.channel !== lower.channel, `兩個 staff 輸出 channel 不同，實際 ${upper.channel}／${lower.channel}`);
  assert(upper.notes.length === 2 && upper.notes.every((n) => n.midiNote === 72) && lower.notes.every((n) => n.midiNote === 48), '音符依 staffId 分組');
  d.tick(); d.press();
  const ons = log.filter((e) => e.t === 'on');
  assert(ons.map((e) => e.note).sort().join() === '48,72,80' && new Set(ons.map((e) => e.ms)).size === 1, `一次觸發：兩個譜表與長笛同刻發聲，實際 ${ons.map((e) => `${e.note}@${e.ms}`)}`);
  const humanOn = ons.filter((e) => e.label === 'human');
  assert(humanOn.map((e) => e.note).sort().join() === '48,72' && new Set(humanOn.map((e) => e.ch)).size === 2, '鋼琴兩個音走真人合成器、在不同的輸出 channel');
});

run('staff 初始化：bank／program 之外，CC7／10／91／93 在該 channel 第一個 noteOn 之前送出；沒有 init 用 GM 預設 100／64／0／0', () => {
  const score = buildStaffScore([
    { id: 'a', staves: [{ id: 'a0', program: 73, init: { volume: 90, pan: 30, reverb: 20, chorus: 10 }, bank: { msb: 0, lsb: 4 }, notes: [0] }] },
    { id: 'b', staves: [{ id: 'b0', program: 40, notes: [0] }] },
  ]);
  const { hp, log, d } = makeStaffHp(score, []);
  d.runMs(100);
  const initOf = (staffId) => {
    const ch = hp._staves.get(staffId).channel;
    const before = log.slice(0, log.findIndex((e) => e.t === 'on' && e.ch === ch));
    const mine = before.filter((e) => e.ch === ch);
    return { pc: mine.find((e) => e.t === 'pc')?.program, cc: Object.fromEntries(mine.filter((e) => e.t === 'cc').map((e) => [e.cc, e.val])) };
  };
  const a = initOf('a0'), b = initOf('b0');
  assert(a.pc === 73 && a.cc[0] === 0 && a.cc[32] === 4 && a.cc[7] === 90 && a.cc[10] === 30 && a.cc[91] === 20 && a.cc[93] === 10,
    `a0 的初始化（program、bank、CC7／10／91／93）要在第一個 noteOn 之前送出，實際 ${JSON.stringify(a)}`);
  assert(b.pc === 40 && b.cc[7] === 100 && b.cc[10] === 64 && b.cc[91] === 0 && b.cc[93] === 0,
    `沒有 init 的 staff 明確送 GM 預設 100／64／0／0，實際 ${JSON.stringify(b)}`);
});

run('指派聲部的 CC7 只在載入時送一次（原音量），觸發與重播都不再動它', () => {
  const score = buildStaffScore([
    { id: 'p0', staves: [{ id: 'p0v', init: { volume: 90, pan: 64, reverb: 0, chorus: 0 }, notes: [0, 1, 2, 3] }] },
    { id: 'a0', staves: [{ id: 'a0v', notes: [0, 1, 2, 3] }] },
  ]);
  const { hp, log, d } = makeStaffHp(score, [['p0', 1]]);
  const ch = hp._staves.get('p0v').channel;
  const cc7 = () => log.filter((e) => e.t === 'cc' && e.cc === 7 && e.ch === ch && e.label === 'human').map((e) => e.val);
  assert(cc7().join() === '90', `載入時送 init 的音量 90，實際 ${cc7()}`);
  d.tick(); d.press(); d.runMs(600); d.press();
  hp.restart();
  assert(cc7().join() === '90', `觸發與重播都不該再送 CC7（沒有代打音量），實際 ${cc7()}`);
});

run('打擊 staff：依鼓組 program 分配到 9／25／41／57，同一個鼓組共用；第 5 種鼓組回報 unplaced；旋律 staff 不會落在打擊槽', () => {
  const kits = [0, 8, 16, 24, 32];
  const score = buildStaffScore([
    ...kits.map((kit, i) => ({ id: `k${i}`, staves: [{ id: `kit${i}`, kit, notes: [0] }] })),
    { id: 'k0b', staves: [{ id: 'kit0b', kit: 0, notes: [1] }] },                                       // 第二個標準鼓組：跟第一個共用 channel
    ...Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, staves: [{ id: `mel${i}`, program: i, notes: [0] }] })),
  ]);
  const { hp } = makeStaffHp(score, []);
  const ch = (id) => hp._staves.get(id)?.channel;
  assert([ch('kit0'), ch('kit1'), ch('kit2'), ch('kit3')].join() === '9,25,41,57', `前四種鼓組應依序在 9／25／41／57，實際 ${[ch('kit0'), ch('kit1'), ch('kit2'), ch('kit3')]}`);
  assert(ch('kit0b') === 9, `同一種鼓組共用 channel，實際 ${ch('kit0b')}`);
  assert(ch('kit4') === undefined && hp.unplacedStaffIds.join() === 'kit4', `第 5 種鼓組沒有打擊槽可用，應回報 unplaced，實際 ${hp.unplacedStaffIds}`);
  const melodic = [...hp._staves.values()].filter((v) => v.id.startsWith('mel')).map((v) => v.channel);
  assert(melodic.length === 20 && new Set(melodic).size === 20, `20 個旋律 staff 各一個 channel，實際 ${melodic}`);
  assert(melodic.every((c) => c % 16 !== 9), `旋律 staff 不能落在任何 port 的打擊槽（9／25／41／57），實際 ${melodic}`);
});

run('輸出 channel 用完：多出來的 staff 回報在 unplacedStaffIds（列 staff，不是 part）', () => {
  const score = buildStaffScore(Array.from({ length: 62 }, (_, i) => ({ id: `p${i}`, staves: [{ id: `v${i}`, notes: [0] }] })));
  const { hp } = makeStaffHp(score, [], { play: false });
  assert(hp._staves.size === 60 && hp.unplacedStaffIds.join() === 'v60,v61', `64 個 channel 扣掉 4 個打擊槽剩 60 個，實際 ${hp._staves.size} 個、unplaced ${hp.unplacedStaffIds}`);
});

run('排不進 channel 的 staff 的音不進 segment；整個 segment 都排不進就不收（一次觸發不會只推進一個不會響的 segment）', () => {
  // 62 個旋律 staff：v60、v61 排不進 channel。把它們的音放在獨立的拍 5（只有它們）：這個 segment 應被丟掉。
  const spec = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, staves: [{ id: `v${i}`, notes: [0] }] }));
  spec.push({ id: 'p60', staves: [{ id: 'v60', notes: [5] }] }, { id: 'p61', staves: [{ id: 'v61', notes: [5] }] });
  const { hp, log, d } = makeStaffHp(buildStaffScore(spec), [], { play: false });
  assert(hp.unplacedStaffIds.join() === 'v60,v61', `前提：v60、v61 排不進，實際 ${hp.unplacedStaffIds}`);
  assert(hp._segments.length === 1 && hp._segments[0].ticks === 0 && hp._segments[0].items.length === 60, `只剩拍 0 那個 segment（60 顆音），實際 ${hp._segments.map((s) => `${s.ticks}:${s.items.length}`)}`);
  assert(onNotes(log).length === 0, '載入不發聲');
});

run('portsNeeded：旋律 staff 每個 port 15 個、每種鼓組佔一個 port 的打擊槽，指派與未指派兩個池子各自算，不低於預設 4 個 port', () => {
  const melodic = (n, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, staves: [{ id: `${prefix}v${i}`, notes: [0] }] }));
  const kits = (n) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, staves: [{ id: `kit${i}`, kit: i * 8, notes: [0] }] }));
  assert(DEFAULT_PORTS === 4, `預設 port 數是 4（開機補的），實際 ${DEFAULT_PORTS}`);
  assert(portsNeeded(buildStaffScore(melodic(60)), []) === 4, '60 個旋律 staff 剛好 4 個 port');
  assert(portsNeeded(buildStaffScore(melodic(61)), []) === 5, '61 個旋律 staff 要 5 個 port');
  assert(portsNeeded(buildStaffScore(melodic(150)), []) === 10, '150 個旋律 staff 要 10 個 port');
  assert(portsNeeded(buildStaffScore([...kits(6), ...melodic(3)]), []) === 6, '6 種鼓組要 6 個 port（每個 port 只有一個打擊槽）');
  const two = buildStaffScore(melodic(40));
  assert(portsNeeded(two, new Map(two.parts.slice(0, 20).map((p) => [p.id, 1]))) === 4, '20 個指派＋20 個未指派分在兩個合成器，各用不到 4 個 port');
  assert(portsNeeded(null, []) === 4 && portsNeeded(buildStaffScore(melodic(1)), []) === 4, '沒有樂譜或很簡單的樂譜也是預設 4 個 port');
});

run('port 數變多之後（setPortCount）：62 個旋律 staff 全部分得到輸出 channel，最多用到第 5 個 port，都不落在打擊槽', () => {
  const log = [], clock = { ms: 0 };
  const hp = new Scheduler();
  hp.setSynths(makeFakeSynth(log, 'assist', clock), makeFakeSynth(log, 'human', clock));
  const score = buildStaffScore(Array.from({ length: 62 }, (_, i) => ({ id: `p${i}`, staves: [{ id: `v${i}`, notes: [0] }] })));
  hp.setPortCount(portsNeeded(score, []));
  hp.load(score, new Map());
  const channels = [...hp._staves.values()].map((v) => v.channel);
  assert(hp._staves.size === 62 && hp.unplacedStaffIds.length === 0, `5 個 port 放得下 62 個旋律 staff，實際 ${hp._staves.size} 個、unplaced ${hp.unplacedStaffIds}`);
  assert(new Set(channels).size === 62 && Math.max(...channels) < 80 && Math.max(...channels) >= 64, `channel 各不相同、用到第 5 個 port（64～79），實際最大 ${Math.max(...channels)}`);
  assert(channels.every((c) => c % 16 !== 9), '旋律 staff 不落在任何 port 的打擊槽');
});

run('舊資料形狀（part 沒有 staves，手工譜）：視為單一 staff，id 沿用 part.id，行為照舊', () => {
  const { hp } = makeHp(buildBeatScore({ p0: [0, 2], a1: [1] }), [['p0', 1]], { play: false });
  const v = hp._staves.get('p0');
  assert(v && v.partId === 'p0' && v.kind === 'human' && v.slot === 1, `舊形狀的 part 就是一個 staff（id＝part.id），實際 ${JSON.stringify([...hp._staves.keys()])}`);
  assert(hp._staves.get('a1').kind === 'assist', '未指派的舊形狀 part 照常是電腦輔助');
});

/* ═══════════════════════════════════════════
   整體不變量壓力測試：固定種子的隨機譜＋隨機觸發、停手、暫停、重播
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
      partId: id, trackIndex: pi, channel: pi, program: 0, midiNote: note, velocity: 90,
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
  return scoreTail(notes, parts, beatSec, durationTicks);
}

const mulberry32 = (seed) => {
  let s = seed;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};

// 假合成器＋不變量檢查，壓力測試（手動／自動播放）共用。排程器用 try/catch 包住每一次 synth 呼叫（音源掛掉不能拖垮排程），
// 假 synth 裡丟的例外會被吞掉：違規只記下來，每次呼叫排程器之後再檢查。
function makeInvariantRig(seed) {
  const state = {
    hp: null, now: 0, silencing: false, inTick: false, inTrigger: false, triggerOns: 0, maxSimultaneous: 0,
    balance: new Map(), pending: new Map(), emittedCount: new Map(), problems: [],
  };
  const check = (cond, msg) => { if (!cond) state.problems.push(`seed ${seed}：${msg}`); };
  state.flush = () => assert(!state.problems.length, state.problems[0]);
  state.check = check;
  state.fake = (label) => ({
    controllerChange() {}, programChange() {},
    noteOn: (ch, note, vel) => {
      const hp = state.hp;
      const v = [...hp._staves.values()].find((x) => x.channel === ch && (label === 'human') === (x.kind === 'human'));
      const n = state.emittedCount.get(v.id) ?? 0;
      state.emittedCount.set(v.id, n + 1);
      const note0 = v.notes[n];
      check(vel >= 1, '送了 velocity 0 的 noteOn（合成器會把它當成 note-off）');
      check(note0 && note0.midiNote === note, `${v.id} 第 ${n} 顆音應為音高 ${note0?.midiNote}，實際 ${note}（發聲順序不是樂譜順序，或發了第二次）`);
      const seg = hp._segments[hp._segIndex - 1];
      check(seg && seg.items.some((it) => it.staff === v && it.note === note0), `${v.id}#${n} 不在剛放行的 segment 裡`);
      check(!(state.inTick && !hp._isAuto()), `有指派時 tick() 放出了起音（${v.id}#${n}）：起音只能來自 trigger()`);
      const k = `${label}/${ch}/${note}`;
      if (!state.pending.has(k)) state.pending.set(k, []);
      state.pending.get(k).push(note0?.endTick);
      state.balance.set(k, (state.balance.get(k) ?? 0) + 1);
      state.maxSimultaneous = Math.max(state.maxSimultaneous, state.balance.get(k));
      if (state.inTrigger) state.triggerOns++;
    },
    noteOff: (ch, note) => {
      const hp = state.hp;
      const k = `${label}/${ch}/${note}`;
      state.balance.set(k, (state.balance.get(k) ?? 0) - 1);
      check(state.balance.get(k) >= 0, `${k} 沒有對應的 noteOn 就 noteOff`);
      const endTick = state.pending.get(k)?.shift();
      // 收音只有三個理由：音到期（播放頭 ≥ endTick）、停格超過閒置門檻、暫停／重播的清場
      if (!state.silencing) check(endTick !== undefined && (hp._ticks + 1e-6 >= endTick || hp._stallSec > 0.8), `${k} 提早收音（結尾 tick ${endTick}，播放頭 ${hp._ticks}）`);
    },
  });
  return state;
}

run('固定種子的整體不變量壓力測試：隨機譜、3 位演奏者、隨機停手／暫停／重播，各 60 秒', () => {
  for (const seed of [11, 22, 33, 44]) {
    const rand = mulberry32(seed);
    const score = buildRandomScore(rand, 5 + Math.floor(rand() * 2));
    const beatSec = score.midiTicksToSeconds(480);
    const assignments = [['p0', 1], ['p1', 1], ['p2', 2], ['p3', 3]];   // p4（、p5）是電腦輔助
    const rig = makeInvariantRig(seed);
    const hp = rig.hp = new Scheduler();
    hp.setSynths(rig.fake('assist'), rig.fake('human'));
    hp.load(score, new Map(assignments));
    hp.play();
    const pPress = 12 / (beatSec * 1000 * 0.5);          // 平均約 0.5 拍按一次
    // 一開始全體先不按 3.8 秒（播放頭沒開始），之後隨機全體停手 1.2~3 秒（壓到停格釋放）。
    let prevPos = 0, presses = 0, stallReleases = 0, quietUntil = 320;
    for (let i = 0; i < 5000; i++) {
      rig.now += 12;
      if (i >= quietUntil && rand() < 0.002) quietUntil = i + 100 + Math.floor(rand() * 150);
      for (const slot of [1, 2, 3]) {
        if (slot === 3 && i > 1250) continue;           // 演奏者 3 在 15 秒後離開
        if (i >= quietUntil && rand() < pPress) {
          const before = hp._segIndex;
          rig.triggerOns = 0; rig.inTrigger = true;
          const ok = hp.trigger(slot, rig.now);
          rig.inTrigger = false;
          rig.flush();
          rig.check(hp._segIndex === before + (ok ? 1 : 0), `trigger 回傳 ${ok}，segment 游標卻從 ${before} 變成 ${hp._segIndex}（一次觸發只能放行一個 segment）`);
          if (ok) {
            presses++;
            rig.check(rig.triggerOns === hp._segments[before].items.length, `一次觸發要讓 segment 的 ${hp._segments[before].items.length} 顆音全部在這次呼叫內發聲，實際 ${rig.triggerOns} 顆`);
          }
        }
      }
      if (rand() < 0.0008) { rig.silencing = true; hp.pause(); rig.silencing = false; for (let k = 0; k < 150; k++) { rig.now += 12; hp.tick(rig.now); } hp.play(); }
      if (rand() < 0.0003) { rig.silencing = true; hp.restart(); rig.silencing = false; prevPos = 0; rig.emittedCount.clear(); rig.pending.clear(); }
      rig.inTick = true; hp.tick(rig.now); rig.inTick = false;
      rig.flush();

      const pos = hp.getPositionTicks();
      assert(pos >= prevPos - 1e-9, `seed ${seed}：進度倒退了（${prevPos} → ${pos}）`);
      prevPos = pos;
      const next = hp._segments[hp._segIndex];
      assert(!next || hp._ticks <= next.ticks + 1e-6, `seed ${seed}：播放頭 ${hp._ticks} 越過下一個 segment（tick ${next?.ticks}）`);

      if (hp._stallSec > 0.8 + 1e-9) {                   // 停格超過閒置門檻：沒有任何音還在響
        stallReleases++;
        const sounding = [...hp._staves.values()].reduce((a, v) => a + [...v.sounding.values()].reduce((b, q) => b + q.length, 0), 0);
        assert(sounding === 0, `seed ${seed}：停格 ${hp._stallSec}s 超過門檻，還有 ${sounding} 個音在響`);
      }
    }
    assert(presses > 50, `seed ${seed}：前提：60 秒內應該真的放行很多個 segment（實際 ${presses} 次）`);
    assert(stallReleases > 0, `seed ${seed}：前提：這個壓力測試應該真的壓到停格釋放`);
    assert(rig.maxSimultaneous >= 2, `seed ${seed}：前提：這個壓力測試應該真的壓到同音高重疊`);
    rig.silencing = true; hp.pause(); rig.silencing = false;    // 收掉還在響的音之後，每個 noteOn 都剛好有一個 noteOff
    rig.flush();
    for (const [k, v] of rig.balance) assert(v === 0, `seed ${seed}：${k} 的 noteOn 與 noteOff 差了 ${v} 個`);
  }
});

run('固定種子的自動播放壓力測試：隨機譜整首自動播放，每顆音恰好發聲一次、在樂譜時間（一個 tick 步長內）、每個 noteOn 一個 noteOff', () => {
  for (const seed of [11, 22, 33, 44]) {
    const rand = mulberry32(seed);
    const score = buildRandomScore(rand, 4 + Math.floor(rand() * 3));
    const stepTicks = (12 / (score.midiTicksToSeconds(480) * 1000)) * 480 + 1e-6; // 一個排程 tick 在 1× 下走多少 tick
    const rig = makeInvariantRig(seed);
    const hp = rig.hp = new Scheduler();
    // 自動播放（沒有指派）時：起音必須在播放頭剛走到它的那個 tick（≤ 一個步長）
    const fake = rig.fake('assist');
    const origOn = fake.noteOn;
    fake.noteOn = (ch, note, vel) => {
      origOn(ch, note, vel);
      const seg = hp._segments[hp._segIndex - 1];
      rig.check(hp._ticks - seg.ticks >= -1e-6 && hp._ticks - seg.ticks <= stepTicks, `起音 tick ${seg.ticks} 在播放頭 ${hp._ticks} 才發聲（落後超過一個步長 ${stepTicks}）`);
    };
    hp.setSynths(fake, rig.fake('human'));
    hp.load(score, new Map());
    hp.play();
    let guard = 0;
    while (!hp.isFinished() && guard++ < 20000) { rig.now += 12; rig.inTick = true; hp.tick(rig.now); rig.inTick = false; rig.flush(); }
    assert(hp.isFinished(), `seed ${seed}：自動播放應該自己播完`);
    for (const v of hp._staves.values()) assert(rig.emittedCount.get(v.id) === v.notes.length, `seed ${seed}：${v.id} 應發聲 ${v.notes.length} 次，實際 ${rig.emittedCount.get(v.id)}`);
    for (const [k, v] of rig.balance) assert(v === 0, `seed ${seed}：${k} 的 noteOn 與 noteOff 差了 ${v} 個`);
  }
});

console.log('\n全部測試跑完。');
