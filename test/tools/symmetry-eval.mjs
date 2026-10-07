// ============================================================
//  symmetry-eval.mjs — 你的音與電腦音的音長是否對稱、安靜落在哪裡：模擬評估（手動執行，不進 CI，純 Node）
//
//  原則：你的音與電腦音照同一條時間軸收、都不撐住（CLAUDE.md N3）。起訖 tick 完全相同的兩顆音（一顆你的、一顆電腦的），實際收音時刻
//  應該相同；電腦音比較長＝你的聲部已經停了、電腦還在響（聽起來「電腦聲部一定拉長一點」）。量：
//    同起訖配對：電腦收音 − 你收音（ms），報 >30ms 的對數（電腦較長／較短）與 p50／p90／最大；
//    跨過你起音的電腦音（N10 的重新對時管的那些）vs 同一個 tick 結束的你的音：同樣的收音差（電腦較短＝長音比你先收）；
//    從你的第一個音到最後一次放行的按鍵之間：電腦在響而你的聲部已停、你在響而電腦已停、兩邊都安靜的總秒數；
//    電腦靜音 >100ms 的次數（sim.mjs 的 silenceStats()）。後兩項含檔案本身的休止與你的停頓，只拿來比較同一份按鍵的不同版本。
//
//  用法：
//    node test/tools/symmetry-eval.mjs                                卡農，你控制音符最多的聲部，內建四種模擬演奏者
//    node test/tools/symmetry-eval.mjs --rec=記錄.json [--midi=檔案]  用真人記錄（window.__pressLog() 匯出的 JSON）重放
//    --part=聲部 id（沒有 --rec 時你控制哪個聲部）
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { simulate, driverSecs, onsetPresses, makeRng, silenceStats, rankedParts } from './sim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const buf = readFileSync(resolve(args.midi || join(ROOT, 'src/assets/canon-violin-cello.mid')));
const score = parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const pct = (a, q) => (a.length ? Math.round([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))]) : NaN);
const sec = (ms) => (ms / 1000).toFixed(1);

function report(label, players) {
  const sim = simulate(score, players);
  const mine = new Map();                                        // `startTick/endTick` → 你的音的紀錄
  for (const r of sim.records) if (r.label === 'human' && r.offMs != null) mine.set(`${r.note.startTick}/${r.note.endTick}`, r);
  const diffs = [];
  for (const r of sim.records) {
    const m = r.label === 'assist' && r.offMs != null && mine.get(`${r.note.startTick}/${r.note.endTick}`);
    if (m) diffs.push(r.offMs - m.offMs);
  }
  // 跨過你起音的電腦音（重新對時管的那些，_retimeCrossing）vs 同一個 tick 結束的你的音（取最晚收的那顆）：收音差＝電腦 − 你
  const mineOffByEnd = new Map();
  for (const r of sim.records) if (r.label === 'human' && r.offMs != null) mineOffByEnd.set(r.note.endTick, Math.max(mineOffByEnd.get(r.note.endTick) ?? -Infinity, r.offMs));
  const cross = [];
  for (const r of sim.records) {
    if (r.label !== 'assist' || r.offMs == null || !mineOffByEnd.has(r.note.endTick)) continue;
    // _sliceOfTick(t)＝起音 tick ≤ t 的 driver segment 有幾個：兩者不同＝(startTick, endTick − 1] 之間有你的起音（嚴格跨過）
    if (sim.hp._sliceOfTick(r.note.endTick - 1) > sim.hp._sliceOfTick(r.note.startTick)) cross.push(r.offMs - mineOffByEnd.get(r.note.endTick));
  }
  // 以 1ms 為一格標出哪些時刻有音在響。範圍從你的第一個音（有前奏時是入場那一刻）到最後一次放行的按鍵（之後電腦自己放完，不能比）
  const t0 = Math.min(...sim.records.filter((r) => r.label === 'human').map((r) => r.onMs));
  const span = Math.ceil(Math.max(...sim.pressLog.filter((p) => p.released).map((p) => p.ms)) - t0) + 1;
  const busy = (label) => {
    const a = new Uint8Array(span);
    for (const r of sim.records) {
      if (r.label !== label || r.offMs == null) continue;
      // 範圍外的音要先跳過：TypedArray 的 fill() 把負的索引當成「從尾端往回算」，t0 之前就收的音（前奏）會被填滿整段
      const from = Math.max(0, Math.ceil(r.onMs - t0)), to = Math.min(span, Math.ceil(r.offMs - t0));
      if (to > from) a.fill(1, from, to);
    }
    return a;
  };
  const h = busy('human'), c = busy('assist');
  let compOnly = 0, mineOnly = 0, both = 0;
  for (let i = 0; i < span; i++) { if (c[i] && !h[i]) compOnly++; else if (h[i] && !c[i]) mineOnly++; else if (!c[i] && !h[i]) both++; }
  console.log(`\n${label}（速度倍率終值 ${sim.hp.playbackRate.toFixed(2)}）`);
  console.log(`  同起訖配對 ${diffs.length} 對：電腦較長 >30ms ${diffs.filter((x) => x > 30).length}、較短 <−30ms ${diffs.filter((x) => x < -30).length}｜p50 ${pct(diffs, 0.5)} p90 ${pct(diffs, 0.9)} 最大 ${diffs.length ? Math.round(Math.max(...diffs)) : NaN}ms`);
  console.log(`  跨過你起音的電腦音 vs 同 tick 結束的你的音 ${cross.length} 對：電腦較長 >30ms ${cross.filter((x) => x > 30).length}、較短 <−30ms ${cross.filter((x) => x < -30).length}｜p10 ${pct(cross, 0.1)} p90 ${pct(cross, 0.9)}ms`);
  console.log(`  ${sec(span)} 秒裡：電腦在響、你已停 ${sec(compOnly)}s｜你在響、電腦已停 ${sec(mineOnly)}s｜兩邊都安靜 ${sec(both)}s｜電腦靜音 >100ms ${silenceStats(sim).over100} 次`);
}

if (args.rec) {
  const rec = JSON.parse(readFileSync(resolve(args.rec), 'utf8'));
  const bySlot = new Map();                                      // 槽位 → { partIds, presses }；sim 的第 i 位演奏者是槽位 i+1，鍵盤只有槽位 1
  for (const [partId, slot] of rec.assignments) {
    if (!bySlot.has(slot)) bySlot.set(slot, { partIds: [], presses: [] });
    bySlot.get(slot).partIds.push(partId);
  }
  for (const p of rec.presses) bySlot.get(p.slot)?.presses.push(p.clockMs);
  report(`真人記錄 ${args.rec}（${rec.presses.length} 次按鍵嘗試）`, [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v));
} else {
  const partId = args.part || rankedParts(score)[0].id;
  const secs = driverSecs(score, [partId]);
  const performer = (factor, reading, seed) => [{ partIds: [partId], presses: onsetPresses(secs, { factor, jitter: 0.1, rnd: makeRng(seed), reading }), keepGoing: true, retryBlocked: true }];   // 被去抖擋掉的按鍵會重按（不然時間表錯位、尾端變連按）
  report('等自己的音收完、再過 250ms 才按下一下（聽完整音符才按，每一下都比預測晚）', [{ partIds: [partId], presses: [12], waitEndMs: 250 }]);
  report('0.49× 穩定（手抖 10%）', performer(2.04, 0, 1));
  report('0.49× 看譜起伏 σ=0.25', performer(2.04, 0.25, 2));
  report('0.8× 看譜起伏 σ=0.25', performer(1.25, 0.25, 4));
}
