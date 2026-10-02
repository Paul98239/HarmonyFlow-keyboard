// ============================================================
//  preview-player.test.mjs — src/midi/previewPlayer.js（試聽：官方 Sequencer 的薄包裝）的回歸測試
//
//  純 Node，不需要瀏覽器：previewPlayer.js 沒有 DOM／CDN 相依，Sequencer 由外面注入，這裡用
//  一個假的 Sequencer 代替，只實作 previewPlayer.js 會碰到的那幾個成員（loadNewSongList／play／pause／
//  currentTime／duration／isFinished／loopCount／eventHandler.addEvent／removeEvent），並提供
//  songChange()／midiError() 讓測試扮演 worklet 回報結果。真正的官方行為由 test/browser/smoke-test.mjs
//  在真的瀏覽器裡驗證。
//  沒有測試框架，跟其他 test/unit 同一套風格：run()／assert()。
//  用法：node test/unit/preview-player.test.mjs
// ============================================================

import { PreviewPlayer } from '../../src/midi/previewPlayer.js';

async function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { await fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

class FakeSequencer {
  constructor() {
    this.listeners = { songChange: new Map(), midiError: new Map() };
    this.eventHandler = {
      addEvent: (name, id, cb) => this.listeners[name].set(id, cb),
      removeEvent: (name, id) => this.listeners[name].delete(id),
    };
    this.calls = [];            // 依序記下對官方 Sequencer 的呼叫
    this.binaries = [];         // loadNewSongList 收到的位元組
    this.loopCount = -1;        // 官方預設是 -1（循環）；previewPlayer 必須明確改成 0
    this.duration = 0;
    this.isFinished = false;
    this._time = 0;
  }
  get currentTime() { return this._time; }
  set currentTime(t) { this.calls.push(`time=${t}`); this._time = t; }
  loadNewSongList(list) { this.calls.push(`load:${list[0].fileName}`); this.binaries.push(list[0].binary); }
  play() { this.calls.push('play'); this.isFinished = false; }
  pause() { this.calls.push('pause'); }
  // 以下是測試用：扮演 worklet 把結果回報給主執行緒
  songChange(fileName, duration = 12) {
    this.duration = duration;
    for (const cb of [...this.listeners.songChange.values()]) cb({ fileName, duration });
  }
  midiError(message) { for (const cb of [...this.listeners.midiError.values()]) cb(new Error(message)); }
  listenerCount() { return this.listeners.songChange.size + this.listeners.midiError.size; }
  lastLoadedName() { return this.calls.filter((c) => c.startsWith('load:')).at(-1).slice(5); }
}

// 建一個 PreviewPlayer；created 記錄 Sequencer 被建了幾次，seq() 取出（第一次 start 之後才有）。
function makePlayer(options) {
  const made = { count: 0, seq: null };
  const player = new PreviewPlayer(() => { made.count++; made.seq = new FakeSequencer(); return made.seq; }, options);
  return { player, made };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
// 把 promise 的結果包成 { state, value }，pending 也看得出來（不會卡住測試）。
function track(promise) {
  const box = { state: 'pending', value: undefined };
  promise.then((v) => { box.state = 'resolved'; box.value = v; }, (e) => { box.state = 'rejected'; box.value = e; });
  return box;
}

await run('沒有 start() 之前：time／duration 是 0、finished／active 是 false，也不會建立 Sequencer', async () => {
  const { player, made } = makePlayer();
  assert(player.time === 0 && player.duration === 0, '還沒載入，time／duration 應為 0');
  assert(player.finished === false && player.active === false, '還沒載入，finished／active 應為 false');
  player.stop(); // 沒東西可停也不能丟例外
  assert(made.count === 0, `沒 start() 就不該建 Sequencer，實際建了 ${made.count} 次`);
});

await run('第一次 start() 才懶建立 Sequencer，且把 loopCount 明確設成 0（官方預設會循環）；之後重用同一個', async () => {
  const { player, made } = makePlayer();
  const first = track(player.start(new ArrayBuffer(4)));
  await tick();
  assert(made.count === 1, `第一次 start() 應建立 1 個 Sequencer，實際 ${made.count}`);
  assert(made.seq.loopCount === 0, `loopCount 應明確設成 0（不循環），實際 ${made.seq.loopCount}`);
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  assert(first.state === 'resolved', `收到同名 songChange 後 start() 應完成，實際 ${first.state}`);
  const second = track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  assert(second.state === 'resolved' && made.count === 1, `第二次 start() 應重用同一個 Sequencer（建了 ${made.count} 個）`);
});

await run('start()：位元組原樣交給官方（不經我們的 parser）；收到同名 songChange 才 play，之後 active／duration 才有值', async () => {
  const { player, made } = makePlayer();
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const p = track(player.start(bytes));
  await tick();
  const seq = made.seq;
  assert(seq.binaries[0] === bytes, '應該把呼叫端給的位元組原樣交給 loadNewSongList');
  assert(!seq.calls.includes('play') && p.state === 'pending', '載入完成之前不該 play、start() 也不該完成');
  assert(player.active === false, '載入完成之前 active 應為 false');
  seq.songChange(seq.lastLoadedName(), 30);
  await tick();
  assert(p.state === 'resolved', `載入完成後 start() 應 resolve，實際 ${p.state}`);
  assert(seq.calls.at(-1) === 'play', `載入完成後應該 play，呼叫順序：${seq.calls}`);
  assert(player.active === true && player.duration === 30, `active 應為 true、duration 應為 30：${player.active}／${player.duration}`);
});

await run('別次載入晚到的 songChange（檔名不同）不算數：不 play、start() 繼續等', async () => {
  const { player, made } = makePlayer();
  const p = track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange('preview-stale-from-an-older-load');
  await tick();
  assert(p.state === 'pending' && !made.seq.calls.includes('play'), '舊載入的 songChange 不能讓這次開始播');
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  assert(p.state === 'resolved', '同名的 songChange 到了才該完成');
});

await run('官方解析器拒絕（midiError）：start() 以 kind=parse 失敗、沒有 play、active 為 false', async () => {
  const { player, made } = makePlayer();
  const p = track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.midiError('Invalid MIDI Header');
  await tick();
  assert(p.state === 'rejected' && p.value.kind === 'parse', `應以 kind=parse 失敗，實際 ${p.state} ${p.value?.kind}`);
  assert(!made.seq.calls.includes('play'), '解析失敗不該 play');
  assert(player.active === false, '解析失敗後 active 應為 false');
});

await run('逾時（官方對長度 0 的 MIDI 不會回任何事件）：start() 以 kind=timeout 失敗，不會永遠卡住', async () => {
  const { player, made } = makePlayer({ loadTimeoutMs: 30 });
  const p = track(player.start(new ArrayBuffer(4)));
  await new Promise((r) => setTimeout(r, 80));
  assert(p.state === 'rejected' && p.value.kind === 'timeout', `應以 kind=timeout 失敗，實際 ${p.state} ${p.value?.kind}`);
  assert(!made.seq.calls.includes('play'), '逾時不該 play');
  // 逾時之後官方才回報也不能把它救活
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  assert(!made.seq.calls.includes('play'), '逾時之後晚到的 songChange 不能觸發 play');
});

await run('載入中 stop()：start() 以 kind=aborted 失敗；之後晚到的 songChange 不會讓它播', async () => {
  const { player, made } = makePlayer();
  const p = track(player.start(new ArrayBuffer(4)));
  await tick();
  const name = made.seq.lastLoadedName();
  player.stop();
  await tick();
  assert(p.state === 'rejected' && p.value.kind === 'aborted', `應以 kind=aborted 失敗，實際 ${p.state} ${p.value?.kind}`);
  made.seq.songChange(name);
  await tick();
  assert(!made.seq.calls.includes('play'), 'stop() 之後晚到的 songChange 不能觸發 play');
  assert(player.active === false, 'stop() 之後 active 應為 false');
});

await run('載入中又 start()（換歌）：前一次 aborted、後一次用新檔名繼續；前一次的 songChange 救不了後一次', async () => {
  const { player, made } = makePlayer();
  const a = track(player.start(new ArrayBuffer(4)));
  await tick();
  const nameA = made.seq.lastLoadedName();
  const b = track(player.start(new ArrayBuffer(8)));
  await tick();
  const nameB = made.seq.lastLoadedName();
  assert(nameA !== nameB, `兩次載入的檔名必須不同才分得出誰是誰：${nameA}／${nameB}`);
  assert(a.state === 'rejected' && a.value.kind === 'aborted', `第一次應 aborted，實際 ${a.state}`);
  made.seq.songChange(nameA);
  await tick();
  assert(b.state === 'pending' && !made.seq.calls.includes('play'), '第一次的 songChange 不能讓第二次開始播');
  made.seq.songChange(nameB);
  await tick();
  assert(b.state === 'resolved', '第二次收到自己的 songChange 才該完成');
});

await run('四種結果（成功／解析失敗／逾時／被中斷）之後，掛在官方 Sequencer 上的監聽都已移除（不累積）', async () => {
  const { player, made } = makePlayer({ loadTimeoutMs: 30 });
  let p = track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  assert(made.seq.listenerCount() === 0, `成功後還有 ${made.seq.listenerCount()} 個監聽沒移除`);
  p = track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.midiError('壞檔');
  await tick();
  assert(made.seq.listenerCount() === 0, `解析失敗後還有 ${made.seq.listenerCount()} 個監聽沒移除`);
  p = track(player.start(new ArrayBuffer(4)));
  await new Promise((r) => setTimeout(r, 80));
  assert(made.seq.listenerCount() === 0, `逾時後還有 ${made.seq.listenerCount()} 個監聽沒移除`);
  p = track(player.start(new ArrayBuffer(4)));
  await tick();
  player.stop();
  await tick();
  assert(made.seq.listenerCount() === 0, `被中斷後還有 ${made.seq.listenerCount()} 個監聽沒移除`);
});

await run('pause()／resume() 交給官方的 pause()／play()', async () => {
  const { player, made } = makePlayer();
  const p = track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  made.seq.calls.length = 0;
  player.pause();
  player.resume();
  assert(made.seq.calls.join() === 'pause,play', `應依序呼叫 pause、play，實際 ${made.seq.calls}`);
});

await run('播完（官方 isFinished）之後 resume() 一律從頭：先把 currentTime 設 0 再 play', async () => {
  const { player, made } = makePlayer();
  track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  made.seq.isFinished = true;
  assert(player.finished === true, '官方 isFinished 為 true 時 finished 應為 true');
  made.seq.calls.length = 0;
  player.resume();
  assert(made.seq.calls.join() === 'time=0,play', `播完後 resume 應先 time=0 再 play，實際 ${made.seq.calls}`);
});

await run('restart()：currentTime 設 0 再 play（暫停中、播放中都一樣）', async () => {
  const { player, made } = makePlayer();
  track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  made.seq.calls.length = 0;
  player.restart();
  assert(made.seq.calls.join() === 'time=0,play', `應依序 time=0、play，實際 ${made.seq.calls}`);
});

await run('stop()：把官方播放器停下來（pause）、active／finished 歸零；再 stop() 一次無害', async () => {
  const { player, made } = makePlayer();
  track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  made.seq.isFinished = true;
  made.seq.calls.length = 0;
  player.stop();
  assert(made.seq.calls.includes('pause'), `stop() 應該呼叫官方 pause，實際 ${made.seq.calls}`);
  assert(player.active === false && player.finished === false, 'stop() 之後 active／finished 應為 false');
  assert(player.time === 0, 'stop() 之後 time 應為 0（沒有在試聽）');
  player.stop();
});

await run('time：試聽中就是官方的 currentTime', async () => {
  const { player, made } = makePlayer();
  track(player.start(new ArrayBuffer(4)));
  await tick();
  made.seq.songChange(made.seq.lastLoadedName());
  await tick();
  made.seq._time = 7.5;
  assert(player.time === 7.5, `time 應等於官方 currentTime 7.5，實際 ${player.time}`);
});

console.log('\n全部測試跑完。');
