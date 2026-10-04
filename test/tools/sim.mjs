// ============================================================
//  sim.mjs — 排程器的模擬演奏者與量測（給 library-scan.mjs 用；純 Node，不載音色庫、不出聲）
//
//  假合成器記下每顆音實際發聲／收音的假時間；模擬演奏者依「觸發時間表」逐 segment 觸發（每位演奏者一張，單位 ms，
//  每一個時間點＝按一下鍵＝放行全曲的下一個 segment，不管是哪位演奏者按的）。假時間以 12ms 為一個 tick，跟 midiPlayer.js 的排程 tick 一致；
//  觸發在 tick 之間直接呼叫 trigger()，跟鍵盤事件一樣同步。「成對」的意思是以音為單位：每個 noteOn 都要有一個
//  noteOff（原檔的結束是 Note Off 還是 velocity 0 的 Note On 不影響，parser 都配成同一顆音），而且絕不送 velocity 0 的
//  noteOn（合成器會把它當成 note-off）。
// ============================================================

import { Scheduler } from '../../src/midi/scheduler.js';

export const TICK_MS = 12;
const ORIGIN_MS = 12; // 樂譜時間 0 對應的假時間：跟排程器第一個有 dt 的 tick 同一個原點

// mulberry32：固定種子的亂數，同一個種子永遠重現同一場模擬。
export function makeRng(seed) {
  let s = seed;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// 假合成器。每個 staff 的音依樂譜順序放行，所以第 n 次 noteOn 就是 staff.notes[n]；
// noteOff 依「同 staff 同音高先進先出」配回去（跟官方合成器對 note-off 的解讀一致）。
function makeRecorder(getPerformer, clock) {
  const records = [];                 // 每顆發聲的音：{ label, partId, staffId, note, onMs, offMs }
  const pending = new Map();          // `${staffId}/${音高}` → 還沒收的 records（先進先出；一個 part 底下的 staff 各有各的輸出 channel）
  const stats = { strayOff: 0, badVelocity: 0 };
  let byChannel = null;
  const emitted = new Map();          // staffId → 已發聲幾顆（＝下一顆音在 staff.notes 裡的位置）
  // 打擊聲部一律配到同一個 drum channel，同一個 channel 可能不只一個聲部：用「下一顆音的音高」或「還沒收的音」分辨。
  const candidates = (ch, label) => {
    byChannel ??= new Map();
    if (!byChannel.size) for (const v of getPerformer()._staves.values()) {
      const k = `${v.kind}/${v.channel}`;
      if (!byChannel.has(k)) byChannel.set(k, []);
      byChannel.get(k).push(v);
    }
    return byChannel.get(`${label}/${ch}`);
  };
  const make = (label) => ({
    controllerChange() {}, programChange() {},
    noteOn: (ch, key, vel) => {
      const list = candidates(ch, label), v = list.find((x) => x.notes[emitted.get(x.id) ?? 0]?.midiNote === key) || list[0];
      const n = emitted.get(v.id) ?? 0, note = v.notes[n];
      emitted.set(v.id, n + 1);
      if (!(vel >= 1)) stats.badVelocity++;
      const rec = { label, partId: v.partId, staffId: v.id, note, onMs: clock.ms, offMs: null };
      records.push(rec);
      const k = `${v.id}/${key}`;
      if (!pending.has(k)) pending.set(k, []);
      pending.get(k).push(rec);
    },
    noteOff: (ch, key) => {
      const list = candidates(ch, label), v = list.find((x) => pending.get(`${x.id}/${key}`)?.length) || list[0];
      const rec = pending.get(`${v.id}/${key}`)?.shift();
      if (rec) rec.offMs = clock.ms; else stats.strayOff++;
    },
  });
  return { assist: make('assist'), human: make('human'), records, stats };
}

/**
 * 跑一場模擬。players：[{ partIds: [...], presses: [ms, ...] }]，第 i 位演奏者的槽位是 i+1，任何一位按一下都放行全曲的
 * 下一個 segment；players 是空陣列＝沒有人被指派（整首自動播放）。跑到播完（而且所有觸發都送完）或最後一次觸發之後再多 tailMs。
 * pressLog：每次觸發的 { slot, ms, released }（released＝trigger() 的回傳值）。
 */
export function simulate(score, players, { tailMs = 8000, tickMs = TICK_MS } = {}) {
  const clock = { ms: 0 };
  let hp;
  const rec = makeRecorder(() => hp, clock);
  hp = new Scheduler();
  hp.setSynths(rec.assist, rec.human);
  const slotOf = new Map();
  players.forEach((p, i) => p.partIds.forEach((id) => slotOf.set(id, i + 1)));
  hp.load(score, slotOf);
  hp.play();
  const next = players.map(() => 0);
  const pressLog = [];
  const lastPress = Math.max(0, ...players.flatMap((p) => p.presses.filter(Number.isFinite)));
  const endMs = Math.max(lastPress + score.durationSeconds * 300, score.durationSeconds * 1000) + tailMs; // 沒有人觸發（整首自動播放）也要跑完整首
  hp.tick(0);
  while (clock.ms < endMs) {
    clock.ms += tickMs;
    const tickNow = clock.ms;
    // 落在這個 tick 之前的觸發：照時間順序、在它自己的時刻呼叫（跟鍵盤事件一樣在 tick 之間），不早於上一個 tick
    const due = [];
    players.forEach((p, i) => { while (next[i] < p.presses.length && p.presses[next[i]] <= tickNow) due.push({ slot: i + 1, ms: Math.max(p.presses[next[i]++], tickNow - tickMs) }); });
    due.sort((a, b) => a.ms - b.ms);
    for (const d of due) { clock.ms = d.ms; pressLog.push({ slot: d.slot, ms: d.ms, released: hp.trigger(d.slot, d.ms) }); }
    clock.ms = tickNow;
    hp.tick(tickNow);
    if (hp.isFinished() && players.every((p, i) => next[i] >= p.presses.length)) break;
  }
  return { hp, records: rec.records, stats: rec.stats, clock, players, pressLog };
}

/* ═══════════════════════════════════════════
   觸發時間表
   ═══════════════════════════════════════════ */

// 非打擊聲部（part 底下至少有一個旋律 staff），依音符數由多到少。
export function rankedParts(score) {
  const count = new Map();
  for (const n of score.notes) count.set(n.partId, (count.get(n.partId) || 0) + 1);
  return score.parts.filter((p) => !p.staves.every((v) => v.percussionKit) && count.get(p.id)).sort((a, b) => count.get(b.id) - count.get(a.id));
}

// 全曲每個 segment（startTick 相同的所有音）的樂譜時間，由早到晚：一次觸發放行一個 segment，觸發時間表照這張排。
export function segmentSecs(score) {
  return score.segments.map((seg) => score.midiTicksToSeconds(seg.ticks));
}

// 按鍵負擔：segment 總數、原速（樂譜速度）下平均每秒要按幾下、最忙的 1 秒內要按幾下。
export function pressLoad(score) {
  const secs = segmentSecs(score);
  let peak = 0;
  for (let i = 0, j = 0; i < secs.length; i++) {
    while (secs[i] - secs[j] > 1) j++;                       // 滑動視窗：secs[j..i] 都落在 1 秒內
    peak = Math.max(peak, i - j + 1);
  }
  const span = secs.length ? secs[secs.length - 1] - secs[0] : 0;
  return { segments: secs.length, perSecAvg: span > 0 ? secs.length / span : 0, perSecPeak: peak };
}

/**
 * 逐 segment 觸發的時間表：第一個 segment 落在樂譜時間（leadMs 可以提早或延後），之後每個 segment 的觸發落在「前一個 segment 的觸發
 * ＋樂譜間隔 × factor × (1 ± jitter)」。factor＝按鍵間隔是樂譜間隔的幾倍（<1 快、>1 慢）。
 * skipFrom／skipCount：從第 skipFrom 個 segment 起連續 skipCount 個不按（停手後回來，之後照原本的時間表繼續）；
 * pause[index, ms]：按完第 index 個之後停 ms 毫秒（Infinity＝從此不按）；fromIndex：從這個 segment 才開始按（晚進場）；
 * offsetMs：整張時間表平移；burst＝true：每個觸發間隔 24ms（連按，比樂譜快很多）。
 */
export function onsetPresses(secs, { factor = 1, jitter = 0, rnd = Math.random, leadMs = 0, offsetMs = 0, skipFrom = -1, skipCount = 0,
  pause = null, fromIndex = 0, burst = false } = {}) {
  const presses = [];
  let t = ORIGIN_MS + Math.max(0, secs[0] * 1000 + leadMs) + offsetMs;
  for (let k = 0; k < secs.length; k++) {
    if (k >= fromIndex && !(k >= skipFrom && k < skipFrom + skipCount)) presses.push(burst ? ORIGIN_MS + offsetMs + k * 24 : t);
    if (k + 1 < secs.length) t += (secs[k + 1] - secs[k]) * 1000 * factor * (1 + jitter * (rnd() * 2 - 1));
    if (pause && k === pause[0]) { if (!Number.isFinite(pause[1])) break; t += pause[1]; }
  }
  return presses;
}

/* ═══════════════════════════════════════════
   量測
   ═══════════════════════════════════════════ */

/**
 * 不變量（任何按鍵速度、任何人數都該成立）：該放行的音都發聲（releasedMissing＝0）、每個 noteOn 一個 noteOff、每顆音都在放行它的
 * 那一次觸發當下發聲（offTrigger＝0，你的與電腦輔助的都一樣，所以同一個 tick 的音同刻，syncMax＝0）。
 * notReleased：曲末還沒被放行的音（按得不夠多、中途停手）——不是違規，由情境決定要不要求完整放行。
 */
export function measure(sim) {
  const { hp, records, stats, pressLog } = sim;
  const sounded = new Set(records.map((r) => r.note));
  // 每顆音屬於第幾個 segment：游標（hp._segIndex）之前的 segment 已經放行過。
  const segOf = new Map();
  hp._segments.forEach((seg, i) => seg.items.forEach((it) => segOf.set(it.note, i)));
  let notReleased = 0, releasedMissing = 0, total = 0;
  for (const v of hp._staves.values()) {
    for (const n of v.notes) {
      total++;
      if (sounded.has(n)) continue;
      if (segOf.get(n) >= hp._segIndex) notReleased++;                       // 還沒被放行到
      else releasedMissing++;                                                // 該放行卻沒發聲：真正的缺音
    }
  }
  // 同刻音：樂譜上同一個 startTick 的音，實際發聲的時間差（同一次觸發的音彼此零誤差）。
  const byStart = new Map();
  for (const r of records) {
    if (!byStart.has(r.note.startTick)) byStart.set(r.note.startTick, []);
    byStart.get(r.note.startTick).push(r.onMs);
  }
  let syncMax = 0;
  for (const list of byStart.values()) if (list.length > 1) syncMax = Math.max(syncMax, Math.max(...list) - Math.min(...list));
  // 觸發→發聲：每顆音（你的與電腦輔助的）都該在某一次成功觸發的那一刻發聲（0ms）。整首自動播放沒有觸發，不檢查。
  const pressedMs = new Set(pressLog.filter((p) => p.released).map((p) => p.ms));
  const offTrigger = pressLog.length ? records.filter((r) => !pressedMs.has(r.onMs)).length : 0;
  return {
    total, sounded: records.length, releasedMissing, notReleased,
    unpaired: records.filter((r) => r.offMs == null).length, strayOff: stats.strayOff, badVelocity: stats.badVelocity,
    syncMax: Math.round(syncMax), offTrigger,
    pressCount: pressLog.length, released: pressLog.filter((p) => p.released).length,
    finished: hp.isFinished(),
  };
}

// 整首自動播放（沒有人被指派）對檔案編碼的忠實度：每顆音都發聲、每個 noteOn 一個 noteOff、起訖時間誤差。
export function autoPlayStats(score) {
  const sim = simulate(score, []);
  const { hp, records, stats } = sim;
  let onErr = 0, offErr = 0;
  for (const r of records) {
    onErr = Math.max(onErr, Math.abs(r.onMs - r.note.startSeconds * 1000));
    if (r.offMs != null) offErr = Math.max(offErr, Math.abs(r.offMs - r.note.endSeconds * 1000));
  }
  const total = [...hp._staves.values()].reduce((a, v) => a + v.notes.length, 0);
  return {
    finished: hp.isFinished(), total, sounded: records.length, unpaired: records.filter((r) => r.offMs == null).length,
    strayOff: stats.strayOff, badVelocity: stats.badVelocity, onErr, offErr, unplaced: hp.unplacedStaffIds.length,
  };
}
