// ============================================================
//  smoke-test.mjs — 開發用瀏覽器自動化測試（Task 0）
//
//  比照 Antigravity 這類 agent IDE「直接開真的 Chrome 做內部測試」的做法：用 Playwright 啟動
//  Chromium，帶假攝影機輸入（見下），開啟 app、選人數、載入本地樣本 MIDI、指派一個聲部、按
//  播放，監聽 console／pageerror，跑一段時間後斷言沒有非預期的錯誤或警告。這支腳本只服務
//  開發／測試，不是 app 本身的一部分，也不會被 push 進 GitHub Pages（app 仍然零建置、直接從
//  CDN 匯入相依套件，見 package.json 的說明）。
//
//  假攝影機用 Chrome 專屬的三個啟動旗標（Safari 不支援、Firefox 不能指定檔案）：
//  --use-fake-ui-for-media-stream（跳過權限詢問對話框）、--use-fake-device-for-media-stream
//  （讓 getUserMedia() 吃假輸入）、--use-file-for-fake-video-capture=<path>.y4m（指定一個
//  .y4m 檔當輸入內容；不指定就是 Chrome 內建的合成測試圖案）。
//
//  MediaPipe 姿勢偵測需要畫面裡真的有人形才會產生 landmark，合成測試圖案偵測不到任何姿勢——
//  沒有 --video 參數時，這支腳本能驗證「選人數／載入樂譜／指派聲部／按播放」整條流程沒有拋出
//  非預期的錯誤，但測不到代打／手勢觸發的實際行為。要測那些，需要一段真人比出拋物線手勢＋
//  一段停頓的 .y4m 影片，用 --video <path> 帶進來。
//
//  用法：node test/browser/smoke-test.mjs [--video <path-to.y4m>] [--duration <ms，預設 8000>]
// ============================================================

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORT = 5599; // 刻意跟 VS Code Live Server 常用的 5500 錯開，兩者可以同時開著不互相干擾
const SAMPLE_MIDI = join(REPO_ROOT, 'src/assets/canon-violin-cello.mid');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm', // CLAUDE.md 明講：其他靜態伺服器要對 .wasm 回這個 type
};

// Chromium／驅動層本身的雜訊（不是這個 app 自己 console.warn／error 出來的東西），跟 CLAUDE.md
// 「console 只在真的出問題時輸出」講的是 app 自己的 console 紀律，這幾種不算違反那條規則：
const BENIGN_PATTERNS = [
  /\.cc:\d+\]/,                          // MediaPipe／ANGLE 原生 C++ 診斷訊息固定格式「檔名.cc:行號]」，
                                          // app 自己的 JS console.warn／error 不會長這樣，用格式辨識
                                          // 比列舉每一種訊息內容更不容易漏
  /GL Driver Message/i,                  // 軟體／虛擬 GPU 算繪管線常見的效能提示，非 app 邏輯錯誤
  /was preloaded using link preload but not used/i, // headcount 還沒選之前 pose 模型本來就不會被用到
];
const isBenign = (text) => BENIGN_PATTERNS.some((re) => re.test(text));

function parseArgs(argv) {
  const args = { duration: 8000, video: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--video') args.video = argv[++i];
    else if (argv[i] === '--duration') args.duration = Number(argv[++i]) || args.duration;
  }
  return args;
}

// 極簡靜態檔案伺服器：只服務這個 repo 底下的檔案，不做任何快取／壓縮邏輯（開發用，夠用就好）。
function startStaticServer(root, port) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const rel = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = normalize(join(root, rel));
      if (!filePath.startsWith(normalize(root))) { res.writeHead(403); res.end(); return; }
      const info = await stat(filePath);
      if (!info.isFile()) { res.writeHead(404); res.end(); return; }
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// 選人數 → 開選歌面板 → 上傳本地樣本 MIDI → 等分譜列出來 → 把第一個聲部指派給演奏者 1 → 按播放。
// 跟真實使用者操作路徑一致（見 index.html 的 data-field／data-action），不繞過 UI 直接呼叫內部函式。
async function driveAppToPlaying(page) {
  console.log('▶ 選現場人數＝1…');
  await page.selectOption('#poseCountSelect', '1');

  console.log('▶ 開啟選歌面板、上傳本地樣本 MIDI…');
  await page.click('#song-toggle');
  await page.setInputFiles('#localMidiInput', SAMPLE_MIDI);

  console.log('▶ 等待分譜列出來…');
  await page.waitForSelector('.score-part-id', { timeout: 10000 });

  console.log('▶ 把第一個聲部指派給演奏者 1…');
  await page.locator('.score-part-id').first().selectOption('1');

  console.log('▶ 按下播放…');
  await page.click('#btnPlayPause');
  await page.waitForSelector('#btnPlayPause.is-playing, #btnPlayPause[class*="playing"]', { timeout: 10000 })
    .catch(() => console.log('  （沒抓到明確的播放中 class，繼續往下——用 console 有沒有錯誤當主要判斷依據）'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`▶ 啟動靜態伺服器 http://127.0.0.1:${PORT}/ （根目錄：${REPO_ROOT}）`);
  const server = await startStaticServer(REPO_ROOT, PORT);

  const launchArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
  if (args.video) {
    launchArgs.push(`--use-file-for-fake-video-capture=${args.video}`);
    console.log(`▶ 使用真實手勢影片：${args.video}`);
  } else {
    console.log('▶ 沒有指定 --video，攝影機輸入是 Chrome 內建的合成圖案（測不到姿勢／手勢，只做流程 smoke test）');
  }

  const browser = await chromium.launch({ args: launchArgs });
  const page = await browser.newPage();

  const problems = [];
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (isBenign(text)) return; // 不印、不計入——瀏覽器/驅動層雜訊，不是這個 app 的訊號
    console.log(`  [console.${type}] ${text}`);
    if (type === 'error' || type === 'warning') problems.push(`console.${type}: ${text}`);
  });
  page.on('pageerror', (err) => {
    console.log(`  [pageerror] ${err.message}`);
    problems.push(`pageerror: ${err.message}`);
  });

  try {
    console.log('▶ 開啟頁面…');
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

    // 開機流程會先跑載入畫面（見 src/main.js 的 dismissLoading()），等 #app-shell 解除 inert
    // 代表視覺與音源兩條軌道都就緒——用這個當「app 已經可互動」的訊號，比固定 sleep 精確。
    console.log('▶ 等待載入完成（#app-shell 解除 inert）…');
    await page.waitForFunction(() => !document.getElementById('app-shell')?.inert, { timeout: 20000 });
    console.log('▶ 載入完成，app 已可互動');

    await driveAppToPlaying(page);

    console.log(`▶ 靜置觀察 ${args.duration}ms，收集 console 訊息…`);
    await page.waitForTimeout(args.duration);
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== 結果 ===');
  if (problems.length === 0) {
    console.log('✅ 沒有非預期的 console error／warning／pageerror');
    process.exit(0);
  } else {
    console.log(`❌ 發現 ${problems.length} 筆問題：`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ 測試腳本本身出錯：', err);
  process.exit(1);
});
