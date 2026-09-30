// ============================================================
//  midi-api.test.mjs — src/midi/midiApi.js 的回歸測試（純 Node，無瀏覽器）
//
//  沒有測試框架，跟其他 test/unit 同一套風格：run()／assert()。midiApi.js 沒有 DOM 相依，
//  只用 fetch／AbortController／Blob，所以直接把全域 fetch 換成假的即可。
//  用法：node test/unit/midi-api.test.mjs
// ============================================================

import { downloadMidiFile } from '../../src/midi/midiApi.js';

async function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { await fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// 跑 fn 期間把 console.log／console.error 收起來（不印到畫面），回傳兩者各自收到的訊息。
async function captureConsole(fn) {
  const logs = [], errors = [];
  const realLog = console.log, realError = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errors.push(a.join(' '));
  try { await fn(); } catch (err) { errors.push(`拋出：${err.message}`); }
  finally { console.log = realLog; console.error = realError; }
  return { logs, errors };
}

const realFetch = globalThis.fetch;
const fakeFetch = (ok, status = ok ? 200 : 404) => async () => ({
  ok, status, arrayBuffer: async () => new ArrayBuffer(32),
});

await run('雲端曲目下載時，console 印一行 ID＋URL（CLAUDE.md console 規則的兩個確認性 log 之一）', async () => {
  globalThis.fetch = fakeFetch(true);
  try {
    const { logs, errors } = await captureConsole(() => downloadMidiFile('abc-123'));
    assert(errors.length === 0, `成功下載不該有錯誤訊息：${errors}`);
    assert(logs.length === 1, `成功下載應該恰好印一行 log，實際 ${logs.length} 行：${logs}`);
    assert(/^\[雲端下載\] ID: abc-123 \| URL: https:\/\/.+\/midis\/abc-123\/download$/.test(logs[0]),
      `log 格式不符（要有 ID 與可以直接貼到瀏覽器的下載連結）：${logs[0]}`);
  } finally { globalThis.fetch = realFetch; }
});

await run('下載失敗（HTTP 404）時連結 log 仍在，方便拿連結追查；錯誤照舊走 console.error 並丟出例外', async () => {
  globalThis.fetch = fakeFetch(false);
  try {
    const { logs, errors } = await captureConsole(() => downloadMidiFile('gone'));
    assert(logs.length === 1 && logs[0].includes('ID: gone'), `失敗時也該有連結 log：${logs}`);
    assert(errors.some((e) => e.includes('下載 MIDI 錯誤')), `失敗應該走 console.error：${errors}`);
    assert(errors.some((e) => e.startsWith('拋出：')), '失敗應該把例外丟給呼叫端');
  } finally { globalThis.fetch = realFetch; }
});

console.log('\n全部測試跑完。');
