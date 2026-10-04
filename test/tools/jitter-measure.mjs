// ============================================================
//  jitter-measure.mjs — 量主執行緒排程器的抖動（手動執行，不進 CI，需要 playwright）
//
//  排程器（scheduler.js）在主執行緒用 setInterval(12ms) 逐音呼叫合成器，而主執行緒同時要跑 MediaPipe 姿勢偵測。
//  這支腳本在真的 Chromium 裡量兩件事，分別在「還沒選現場人數（MediaPipe 沒在推論）」與「現場人數＝1（每一幀都推論）」兩個階段：
//    1. tick 間隔：scheduler.tick 兩次被呼叫的間隔（設計是 12ms；超過 25／50／100ms 的比例）。
//       排程器每個 tick 的時間步長上限是 100ms（MAX_TICK_DT_SEC），間隔超過 12ms 代表時鐘那一刻前進得比理想的多、
//       這一段內該發的音被擠在同一個 tick。
//    2. noteOn 來回延遲：主執行緒呼叫 synth.noteOn 到 worklet 回報 noteOn 事件的時間（含 postMessage 去、worklet 處理、
//       postMessage 回，所以是「去＋回」的上限，不是單趟）。
//  第三階段把鏡頭關掉（MediaPipe 與影像算繪都停），用來分辨抖動來自影像算繪還是姿勢推論。另外記錄主執行緒的長任務（> 50ms）。
//  用法：node test/tools/jitter-measure.mjs [--seconds=10] [--midi=檔案]（預設 canon 範例；音符愈密，來回延遲的樣本愈多）
//
//  限制：無頭 Chromium、軟體算繪、假攝影機（合成圖案，MediaPipe 偵測不到人但每一幀仍會推論）。數字是這台機器的量測，
//  不能直接當成使用者機器的數字；要比較就在同一台機器、同一份程式上前後各量一次。
// ============================================================

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const SECONDS = Number(args.seconds) || 10;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 5598; // 跟 smoke test 的 5599、Live Server 的 5500 錯開
const SAMPLE_MIDI = args.midi && args.midi !== true ? String(args.midi) : join(ROOT, 'src/assets/canon-violin-cello.mid');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' };

function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = normalize(join(ROOT, rel === '/' ? '/index.html' : rel));
      if (!file.startsWith(normalize(ROOT)) || !(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null);
const fmt = (x) => (x == null ? '-' : x.toFixed(1));

function report(label, { dts, echo, longTasks }) {
  const d = [...dts].sort((a, b) => a - b), e = [...echo].sort((a, b) => a - b);
  const over = (ms) => `${((100 * dts.filter((x) => x > ms).length) / Math.max(1, dts.length)).toFixed(2)}％`;
  console.log(`\n=== ${label} ===`);
  console.log(`tick 間隔（設計 12ms）：${dts.length} 次；平均 ${fmt(dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length))}ms；p50 ${fmt(pct(d, 0.5))}、p95 ${fmt(pct(d, 0.95))}、p99 ${fmt(pct(d, 0.99))}、最大 ${fmt(d.at(-1))}ms`);
  console.log(`  超過 25ms ${over(25)}、超過 50ms ${over(50)}、超過 100ms（時鐘步長被截斷）${over(100)}`);
  console.log(`主執行緒長任務（>50ms）：${longTasks.length} 個；總長 ${fmt(longTasks.reduce((a, b) => a + b, 0))}ms；最長 ${fmt(Math.max(0, ...longTasks))}ms`);
  console.log(`noteOn 來回延遲（去＋回）：${echo.length} 個；p50 ${fmt(pct(e, 0.5))}、p95 ${fmt(pct(e, 0.95))}、p99 ${fmt(pct(e, 0.99))}、最大 ${fmt(e.at(-1))}ms`);
}

const server = await startStaticServer();
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('app-shell').inert, null, { timeout: 60000 });
  await page.click('#song-toggle');
  await page.setInputFiles('#localMidiInput', SAMPLE_MIDI);
  await page.waitForSelector('#btnPlay:not([disabled])', { timeout: 15000 });

  // 在頁面內掛量測：包住 scheduler.tick（只在播放中記錄）與 assistSynth.noteOn（送出時刻）＋worklet 回報的 noteOn 事件。
  await page.evaluate(async () => {
    const { scheduler } = await import('/src/midi/synth.js');
    const J = (window.__jit = { dts: [], echo: [], longTasks: [], last: null, sent: new Map() });
    new PerformanceObserver((list) => { for (const e of list.getEntries()) J.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: false });
    const origTick = scheduler.tick.bind(scheduler);
    scheduler.tick = (nowMs, g) => {
      if (scheduler._playing) { if (J.last != null) J.dts.push(nowMs - J.last); J.last = nowMs; } else J.last = null;
      return origTick(nowMs, g);
    };
    const syn = scheduler.assistSynth, origOn = syn.noteOn.bind(syn);
    syn.noteOn = (ch, key, vel, o) => {
      const k = `${ch}:${key}`;
      if (!J.sent.has(k)) J.sent.set(k, []);
      J.sent.get(k).push(performance.now());
      return origOn(ch, key, vel, o);
    };
    syn.eventHandler.addEvent('noteOn', 'jit', (e) => {
      const q = J.sent.get(`${e.channel}:${e.midiNote}`);
      if (q?.length) J.echo.push(performance.now() - q.shift());
    });
  });

  const runPhase = async (label) => {
    await page.evaluate(() => { const J = window.__jit; J.dts = []; J.echo = []; J.longTasks = []; J.last = null; J.sent.clear(); });
    await page.click('#btnPlay');
    await page.waitForTimeout(SECONDS * 1000);
    const got = await page.evaluate(() => ({ dts: window.__jit.dts, echo: window.__jit.echo, longTasks: window.__jit.longTasks }));
    await page.click('#btnPause');
    await page.waitForSelector('#btnPlay:not([disabled])');
    report(label, got);
  };

  console.log(`▶ 每階段量 ${SECONDS} 秒（${SAMPLE_MIDI.split(/[\\/]/).pop()}，沒有指派聲部，整首自動播放）`);
  await runPhase('階段 A：還沒選現場人數（MediaPipe 沒在推論）');

  console.log('\n▶ 選現場人數＝1，等 MediaPipe 建好…');
  await page.selectOption('#poseCountSelect', '1');
  await page.waitForFunction(async () => (await import('/src/vision/vision.js')).getPoseCount() === 1, null, { timeout: 60000, polling: 500 });
  await page.waitForTimeout(2000); // 讓推論跑順
  await page.click('#btnReplay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])');
  await runPhase('階段 B：現場人數＝1（MediaPipe 每一幀都推論）');

  console.log('\n▶ 關掉鏡頭（影像算繪與姿勢推論都停）…');
  await page.click('#btn-camera-toggle');
  await page.waitForTimeout(1500);
  await page.click('#btnReplay');
  await page.waitForSelector('#btnPause.is-current', { timeout: 10000 });
  await page.click('#btnPause');
  await page.waitForSelector('#btnPlay:not([disabled])');
  await runPhase('階段 C：鏡頭關閉');
} finally {
  await browser.close();
  server.close();
}
