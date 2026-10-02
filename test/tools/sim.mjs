// ============================================================
//  sim.mjs — 排程器的模擬演奏者與量測（給 library-scan.mjs 用；純 Node，不載音色庫、不出聲）
//
//  假合成器記下每顆音實際發聲／收音的假時間；模擬演奏者依「揮手時間表」揮手（每位演奏者一張，單位 ms）。
//  假時間以 12ms 為一個 tick，跟 midiPlayer.js 的排程 tick 一致。「成對」的意思是以音為單位：每個 noteOn
//  都要有一個 noteOff（原檔的結束是 Note Off 還是 velocity 0 的 Note On 不影響，parser 都配成同一顆音），
//  而且絕不送 velocity 0 的 noteOn（合成器會把它當成 note-off）。
// ============================================================

import { HumanPerformer } from '../../src/midi/humanPerformer.js';

export const TICK_MS = 12;

// mulberry32：固定種子的亂數，同一個種子永遠重現同一場模擬。
export function makeRng(seed) {
  let s = seed;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// 假合成器。排程器先 noteOn 再 cursor++，所以 noteOn 當下 voice.notes[voice.cursor] 就是剛發聲的那一顆；
// noteOff 依「同聲部同音高先進先出」配回去（跟官方合成器對 note-off 的解讀一致）。
function makeRecorder(getPerformer, clock) {
  const records = [];                 // 每顆發聲的音：{ label, partId, note, onMs, offMs }
  const pending = new Map();          // `${partId}/${音高}` → 還沒收的 records（先進先出）
  const stats = { strayOff: 0, badVelocity: 0 };
  let byChannel = null;
  // 打擊聲部一律配到同一個 drum channel，同一個 channel 可能不只一個聲部：用「游標指著的音高」或「還沒收的音」分辨。
  const candidates = (ch, label) => {
    byChannel ??= new Map();
    if (!byChannel.size) for (const v of getPerformer()._voices.values()) {
      const k = `${v.kind}/${v.channel}`;
      if (!byChannel.has(k)) byChannel.set(k, []);
      byChannel.get(k).push(v);
    }
    return byChannel.get(`${label}/${ch}`);
  };
  const make = (label) => ({
    controllerChange() {}, programChange() {},
    noteOn: (ch, key, vel) => {
      const list = candidates(ch, label), v = list.find((x) => x.notes[x.cursor]?.note === key) || list[0], note = v.notes[v.cursor];
      if (!(vel >= 1)) stats.badVelocity++;
      const rec = { label, partId: v.partId, note, onMs: clock.ms, offMs: null };
      records.push(rec);
      const k = `${v.partId}/${key}`;
      if (!pending.has(k)) pending.set(k, []);
      pending.get(k).push(rec);
    },
    noteOff: (ch, key) => {
      const list = candidates(ch, label), v = list.find((x) => pending.get(`${x.partId}/${key}`)?.length) || list[0];
      const rec = pending.get(`${v.partId}/${key}`)?.shift();
      if (rec) rec.offMs = clock.ms; else stats.strayOff++;
    },
  });
  return { assist: make('assist'), human: make('human'), records, stats };
}

/**
 * 跑一場模擬。players：[{ partIds: [...], waves: [ms, ...] }]，第 i 位演奏者的槽位是 i+1；players 是空陣列＝
 * 沒有人被指派（整首自動播放）。跑到播完（而且所有揮手都送完）或最後一次揮手之後再多 tailMs。
 */
export function simulate(score, players, { tailMs = 8000, tickMs = TICK_MS } = {}) {
  const clock = { ms: 0 };
  let hp;
  const rec = makeRecorder(() => hp, clock);
  hp = new HumanPerformer();
  hp.setSynths(rec.assist, rec.human);
  const slotOf = new Map();
  players.forEach((p, i) => p.partIds.forEach((id) => slotOf.set(id, i + 1)));
  hp.load(score, slotOf);
  hp.play();
  const seqs = players.map(() => 0), next = players.map(() => 0);
  const beatAtWave = players.map(() => []);           // 每位演奏者每次揮手之後（那個 tick 結束時）的共用拍位，量「有沒有比他數的拍多走」用
  const gesture = (id) => {
    const slot = slotOf.get(id);
    return slot ? { present: true, triggerSeq: seqs[slot - 1], slot } : { present: false, triggerSeq: 0, slot: null };
  };
  const lastWave = Math.max(0, ...players.flatMap((p) => p.waves.filter(Number.isFinite)));
  const endMs = Math.max(lastWave + score.durationSeconds * 300, score.durationSeconds * 1000) + tailMs; // 沒有人揮手（整首自動播放）也要跑完整首
  hp.tick(0, gesture);
  while (clock.ms < endMs) {
    clock.ms += tickMs;
    const delivered = players.map(() => 0);
    players.forEach((p, i) => { while (next[i] < p.waves.length && clock.ms >= p.waves[next[i]]) { seqs[i]++; next[i]++; delivered[i]++; } });
    hp.tick(clock.ms, gesture);
    delivered.forEach((n, i) => { for (let j = 0; j < n; j++) beatAtWave[i].push(hp._beatIndex); });
    if (hp.isFinished() && players.every((p, i) => next[i] >= p.waves.length)) break;
  }
  return { hp, records: rec.records, stats: rec.stats, clock, players, beatAtWave };
}

/* ═══════════════════════════════════════════
   揮手時間表
   ═══════════════════════════════════════════ */

// 非打擊聲部，依音符數由多到少。
export function rankedParts(score) {
  const count = new Map();
  for (const n of score.notes) count.set(n.partId, (count.get(n.partId) || 0) + 1);
  return score.parts.filter((p) => !p.percussionKit && count.get(p.id)).sort((a, b) => count.get(b.id) - count.get(a.id));
}

// 這些聲部最早的音所在的拍（跟排程器的起始拍同一個定義）。
export function startBeatOf(score, beats, partIds) {
  const first = score.notes.find((n) => partIds.includes(n.partId));
  return beats.findIndex((b) => b.endTick > first.startTick);
}

/**
 * 逐拍揮手的時間表：第 k 拍的揮手落在「前一拍的揮手 ＋ 前一拍的樂譜長度 × factor × (1 ± jitter)」。
 * 第一下揮手落在起始拍的樂譜時間（leadMs 可以提早或延後）。factorAt(第幾拍, 總拍數) 可以讓速度隨時間變。
 * skipBeats[a, b)：這幾拍不揮手；pause[beat, ms]：揮完這一拍之後停 ms 毫秒（Infinity＝從此不揮）；
 * fromBeat：從這一拍才開始揮（晚進場）；offsetMs：整張時間表平移；skipProb：第 3 拍起每拍有這個機率漏揮。
 */
export function nominalWaves(beats, b0, { factor = 1, jitter = 0, rnd = Math.random, leadMs = 0, offsetMs = 0, factorAt = null,
  skipBeats = null, pause = null, fromBeat = 0, skipProb = 0 } = {}) {
  const waves = [];
  let t = 12 + Math.max(0, beats[b0].startSeconds * 1000 + leadMs) + offsetMs;
  for (let k = b0; k < beats.length; k++) {
    const rel = k - b0;
    const skipped = (skipBeats && rel >= skipBeats[0] && rel < skipBeats[1]) || rel < fromBeat || (skipProb && rel >= 2 && rnd() < skipProb);
    if (!skipped) waves.push(t);
    const beat = beats[k];
    t += (beat.endSeconds - beat.startSeconds) * 1000 * (factorAt ? factorAt(rel, beats.length - b0) : factor) * (1 + jitter * (rnd() * 2 - 1));
    if (pause && rel === pause[0]) { if (!Number.isFinite(pause[1])) break; t += pause[1]; }
  }
  return waves;
}

/* ═══════════════════════════════════════════
   量測
   ═══════════════════════════════════════════ */

const percentile = (sorted, p) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]) : null);

/**
 * @param {object} opts
 *   exempt(voice, note)：這顆音不要求一定發聲（例如晚進場的演奏者，他揮第一下之前走過的音本來就是靜音）
 *   factor：演奏者相對樂譜的速度倍率（量「壓縮」與相連音空白用，速度會變時不要傳）
 *   waves／b0：單人模擬時，量「揮手→發聲」延遲用（第 k 拍的揮手是 waves[k - b0]）
 */
export function measure(sim, { exempt = () => false, factor = 1, waves = null, b0 = 0 } = {}) {
  const { hp, records, stats } = sim;
  const frontier = hp._frontierSec;
  const sounded = new Set(records.map((r) => r.note));
  let releasedMissing = 0, unreleased = 0, total = 0;
  for (const v of hp._voices.values()) {
    for (const n of v.notes) {
      total++;
      if (n.startSeconds >= frontier) unreleased++;                       // 沒被放行的音（揮手不夠多、演奏者離開）：不算缺音
      else if (!sounded.has(n) && !exempt(v, n)) releasedMissing++;       // 放行了卻沒發聲：真正的缺音
    }
  }
  // 同刻音：樂譜上同一個 startSeconds 的音，實際發聲的時間差（同一個 tick 發的音彼此零誤差）。
  const byStart = new Map();
  for (const r of records) {
    const k = r.note.startSeconds.toFixed(6);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(r.onMs);
  }
  let syncMax = 0;
  for (const list of byStart.values()) if (list.length > 1) syncMax = Math.max(syncMax, Math.max(...list) - Math.min(...list));
  // 壓縮：同一聲部相鄰兩顆起音相差 ≥ 30ms 的音，實際間隔不到應有的一半（追趕造成）；擠成一團＝同一個 tick。
  let adjacent = 0, compressed = 0, bursts = 0, legato = 0, legatoGaps = 0;
  for (const v of hp._voices.values()) {
    const mine = records.filter((r) => r.partId === v.partId).sort((a, b) => a.note.startSeconds - b.note.startSeconds || a.onMs - b.onMs);
    let prev = null;
    for (const r of mine) {
      if (prev && r.note.startSeconds - prev.note.startSeconds >= 0.03) {
        adjacent++;
        const real = r.onMs - prev.onMs, expect = (r.note.startSeconds - prev.note.startSeconds) * 1000 * factor;
        if (real < 6) bursts++; else if (real < expect * 0.5 - TICK_MS) compressed++;
      }
      if (!prev || r.note.startSeconds > prev.note.startSeconds) prev = r;
    }
    // 相連音空白：舊音收音到後繼音發聲的時間，比檔案編碼的間隙多出 30ms 以上。
    const byNote = new Map(records.filter((r) => r.partId === v.partId).map((r) => [r.note, r]));
    for (const r of mine) {
      const succ = v.notes[r.note.legatoTo], so = succ && byNote.get(succ);
      if (!so || r.offMs == null) continue;
      legato++;
      if (so.onMs - r.offMs - (succ.startSeconds - r.note.endSeconds) * 1000 * factor > 30) legatoGaps++;
    }
  }
  const lag = waves
    ? records.filter((r) => r.label === 'human' && Math.abs(r.note.startSeconds - hp._beats[r.note.beatIndex].startSeconds) < 1e-6 && waves[r.note.beatIndex - b0] != null)
      .map((r) => r.onMs - waves[r.note.beatIndex - b0]).sort((a, b) => a - b)
    : [];
  // 棘輪：演奏者每拍揮一次（waves 與 b0 給了才量）時，第 k 次揮手之後共用拍位應該剛好是 b0 + k；多出來的拍是代打搶在
  // 他揮手前走掉的。
  const ahead = waves ? sim.beatAtWave[0].map((b, k) => b - (b0 + k)).filter((x) => x > 0) : [];
  return {
    ratchetWaves: ahead.length, ratchetMax: ahead.length ? Math.max(...ahead) : 0,
    total, sounded: records.length, releasedMissing, unreleased,
    unpaired: records.filter((r) => r.offMs == null).length, strayOff: stats.strayOff, badVelocity: stats.badVelocity,
    syncMax: Math.round(syncMax), adjacent, compressed, bursts, legato, legatoGaps,
    lagP50: percentile(lag, 0.5), lagP99: percentile(lag, 0.99), lagMax: lag.length ? Math.round(lag.at(-1)) : null,
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
  const total = [...hp._voices.values()].reduce((a, v) => a + v.notes.length, 0);
  return {
    finished: hp.isFinished(), total, sounded: records.length, unpaired: records.filter((r) => r.offMs == null).length,
    strayOff: stats.strayOff, badVelocity: stats.badVelocity, onErr, offErr, unplaced: hp.unplacedPartIds.length,
  };
}

