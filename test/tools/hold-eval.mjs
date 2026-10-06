// ============================================================
//  hold-eval.mjs — 跨過你起音的電腦音「延長到你按下去」的上限（holdMaxMs）掃值：模擬評估（手動執行，不進 CI，純 Node）
//
//  落音＝電腦音「要等你按到」的起音（時間範圍跨過它，或結尾接著它，見 scheduler.js 的 _holdSegOf()），你按那個起音的時候它已經收了（sim.mjs 的
//  earlyOffGaps()）。電腦靜音＝相鄰電腦音之間的空白（sim.mjs 的 silenceStats()，含檔案本身的休止與你的停頓，只拿來比較同一份按鍵的不同設定）。
//  holdMaxMs＝0 時沒有 hold（只剩按下時的重新對時），等於舊行為，當作對照。
//
//  用法：
//    node test/tools/hold-eval.mjs                         卡農，你控制小提琴，內建三種模擬演奏者
//    node test/tools/hold-eval.mjs --rec=記錄.json [--midi=檔案]   用真人記錄（window.__pressLog() 匯出的 JSON）重放
//    --holds=0,400,800,1200   要掃的 holdMaxMs（預設 0,400,800,1200）；--part=聲部 id（沒有 --rec 時你控制哪個聲部，預設音符最多的）
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { simulate, driverSecs, onsetPresses, makeRng, earlyOffGaps, silenceStats, rankedParts } from './sim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const HOLDS = (args.holds || '0,400,800,1200').split(',').map(Number);
const buf = readFileSync(resolve(args.midi || join(ROOT, 'src/assets/canon-violin-cello.mid')));
const score = parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const pct = (a, q) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : NaN);

function report(label, players) {
  console.log(`\n${label}`);
  for (const holdMaxMs of HOLDS) {
    const sim = simulate(score, players, { config: { holdMaxMs } });
    const gaps = earlyOffGaps(sim);
    const sil = silenceStats(sim), over = gaps.filter((g) => g > 100).length, blocked = sim.pressLog.filter((p) => !p.released).length;
    console.log(`  holdMaxMs=${String(holdMaxMs).padStart(4)}：速度倍率終值 ${sim.hp.playbackRate.toFixed(2)}｜跨過你起音的電腦音 ${gaps.length} 顆｜落音 >100ms ${((100 * over) / Math.max(1, gaps.length)).toFixed(1)}%｜電腦靜音 >100ms ${sil.over100} 次、>300ms ${sil.over300} 次共 ${sil.over300Sec.toFixed(1)} 秒｜被去抖擋掉 ${blocked} 次｜p50 ${Math.round(pct(gaps, 0.5))}ms p90 ${Math.round(pct(gaps, 0.9))}ms`);
  }
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
  const performer = (factor, reading, seed) => [{ partIds: [partId], presses: onsetPresses(secs, { factor, jitter: 0.1, rnd: makeRng(seed), reading }), keepGoing: true, retryBlocked: true }];   // 被去抖擋掉的按鍵會重按（不然時間表錯位、尾端變連按，稀釋統計）
  report('0.49× 穩定（手抖 10%）', performer(2.04, 0, 1));
  report('0.49× 看譜起伏 σ=0.25', performer(2.04, 0.25, 2));
  report('0.8× 看譜起伏 σ=0.25', performer(1.25, 0.25, 4));
  report('0.49× 看譜起伏 σ=0.5（很不規則）', performer(2.04, 0.5, 3));
}
