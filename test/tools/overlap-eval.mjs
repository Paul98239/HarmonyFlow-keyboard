// ============================================================
//  overlap-eval.mjs — 鍵盤模式下「音長」與「疊音」比檔案多多少：量測（手動執行，不進 CI，純 Node，不出聲）
//
//  原則：所有聲部的音長是 MIDI 的 tick 長度（跟試聽一樣），整體只乘一個時間比例（你的速度）；垂直對應只靠 tick 差。
//  所以每顆音理想上該滿足：實際音長＝檔案音長 × factor（factor＝你的按鍵間隔是樂譜間隔的幾倍），同一個譜表的相鄰兩顆音，
//  前一顆「超過下一顆起音多少」也要等於檔案裡的值 × factor。這支工具量排程器偏離這兩個理想多少（用 sim.mjs 的假合成器，
//  假時間 12ms 一個 tick）：
//    音長多出＝實際音長 − 檔案音長 × factor（正＝比理想長）；
//    多疊＝max(0, 前一顆實際收音 − 後一顆實際起音) − max(0, 檔案裡的同一個差 × factor)：正＝比檔案疊得更多。兩邊都先取 max(0, ·)：
//    檔案裡本來就有空隙（舊音在新音起音之前結束）時，實際重疊是 0 也不算「多疊」。
//  每個譜表的音依實際發聲時間排序後取相鄰一對（同譜表＝同一個樂器的同一行譜，疊在一起就是同一個聲音裡兩顆音糊在一起）。
//  報：每千顆音中「多疊 > 30ms」「多疊 > 100ms」的次數、音長多出的 p50／p90／p99、「音長被縮短 > 30ms」的次數（收尾規則的代價：
//  舊音被新音的起音截短，音長就少於 MIDI 音長 × 速度）。你的聲部與電腦聲部分開報。
//  情境：完美（1.0×、手抖 15%）／慢 1.4×／快 0.7×／猶豫（每 12 下停 1.2 秒，其餘 1.0×、手抖 15%）。
//
//  用法：node test/tools/overlap-eval.mjs [--dir=資料夾（預設：src/assets 加上 test/tools/library 前 --limit 首）] [--limit=20] [--exclude=檔名片段]
//        只量音符最多的聲部當你的聲部、其餘當電腦聲部（跟 note-length-eval 同一組）；少於 2 個聲部的歌不算（沒有電腦聲部可比）
// ============================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { simulate, rankedParts, driverSecs, onsetPresses, makeRng } from './sim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const limit = Number(args.limit ?? 20);
const listMid = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.mid') && !f.includes('-Violin') && !f.includes('-Violoncello')).map((f) => join(d, f)) : []);
const allFiles = args.dir ? listMid(resolve(args.dir)) : [...listMid(join(ROOT, 'src/assets')), ...listMid(join(ROOT, 'test/tools/library')).slice(0, limit)];
const files = typeof args.exclude === 'string' ? allFiles.filter((f) => !f.includes(args.exclude)) : allFiles;

const SCENARIOS = [
  { name: '完美：1.0×、手抖 15%', factor: 1, jitter: 0.15 },
  { name: '慢 1.4×、手抖 15%', factor: 1.4, jitter: 0.15 },
  { name: '快 0.7×、手抖 15%', factor: 0.7, jitter: 0.15 },
  { name: '猶豫：每 12 下停 1.2 秒、1.0×、手抖 15%', factor: 1, jitter: 0.15, every: 12, pauseMs: 1200 },
];
const quantile = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const r0 = (x) => (Number.isFinite(x) ? String(Math.round(x)).padStart(5) : '    -');

const acc = SCENARIOS.map(() => ({ human: { ext: [], ovl: [], notes: 0 }, assist: { ext: [], ovl: [], notes: 0 } }));
let songs = 0;
for (const f of files) {
  const b = readFileSync(f);
  let score;
  try { score = parseMidi(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { continue; }
  const ranked = rankedParts(score);
  if (ranked.length < 2) continue;
  const secs = driverSecs(score, [ranked[0].id]);
  if (secs.length < 60) continue;
  songs++;
  SCENARIOS.forEach((sc, i) => {
    let presses = onsetPresses(secs, { factor: sc.factor, jitter: sc.jitter, rnd: makeRng(1234 + songs) });
    if (sc.every) presses = presses.map((t, k) => t + Math.floor(k / sc.every) * sc.pauseMs); // 每 every 下之後整體往後挪 pauseMs
    const sim = simulate(score, [{ partIds: [ranked[0].id], presses, keepGoing: true }]);
    const byStaff = new Map();
    for (const r of sim.records) {
      if (r.offMs == null) continue;
      const k = `${r.label}/${r.staffId}`;
      if (!byStaff.has(k)) byStaff.set(k, []);
      byStaff.get(k).push(r);
    }
    for (const [k, list] of byStaff) {
      const a = acc[i][k.split('/')[0]];
      list.sort((x, y) => x.onMs - y.onMs);
      for (let j = 0; j < list.length; j++) {
        const r = list[j], fileMs = (r.note.endSeconds - r.note.startSeconds) * 1000;
        if (fileMs <= 0) continue;
        a.notes++;
        a.ext.push(r.offMs - r.onMs - fileMs * sc.factor);
        if (j + 1 < list.length) {
          const nx = list[j + 1];
          const fileOvl = (r.note.endSeconds - nx.note.startSeconds) * 1000; // 檔案裡：前一顆結束 − 後一顆起音（正＝疊、負＝斷）
          a.ovl.push(Math.max(0, r.offMs - nx.onMs) - Math.max(0, fileOvl * sc.factor));
        }
      }
    }
  });
}
console.log(`曲數（≥ 2 個聲部、主聲部起音 ≥ 60 個）：${songs}；單位 ms，正＝比理想長／比檔案更疊\n`);
for (const [i, sc] of SCENARIOS.entries()) {
  console.log(`■ ${sc.name}`);
  console.log('  種類    音數   音長多出 p50  p90  p99 ｜ 多疊 >30ms（每千顆） >100ms（每千顆）  多疊 p99 ｜ 音長縮短 >30ms（每千顆）');
  for (const [label, title] of [['human', '你的'], ['assist', '電腦']]) {
    const a = acc[i][label];
    const per = (n) => (a.notes ? ((1000 * n) / a.notes).toFixed(1).padStart(6) : '     -');
    console.log(`  ${title}  ${String(a.notes).padStart(6)}   ${r0(quantile(a.ext, 0.5))} ${r0(quantile(a.ext, 0.9))} ${r0(quantile(a.ext, 0.99))} ｜ ${per(a.ovl.filter((x) => x > 30).length)}        ${per(a.ovl.filter((x) => x > 100).length)}          ${r0(quantile(a.ovl, 0.99))} ｜ ${per(a.ext.filter((x) => x < -30).length)}`);
  }
}
