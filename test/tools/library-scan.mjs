// ============================================================
//  library-scan.mjs — 曲庫全掃：用整個遠端 MIDI 曲庫驗證排程器（手動執行，不進 CI，純 Node）
//
//  三種掃描（--only=autoplay,perform,scenarios，預設全跑）：
//    autoplay   每首歌整首自動播放（沒有人被指派）：每顆音都發聲、每個 noteOn 一個 noteOff（「成對」以音為單位，
//               原檔用 Note Off 還是 velocity 0 的 Note On 結束都一樣）、起訖時間誤差 ≤ 一個排程 tick（12ms）。
//    perform    多聲部歌曲 × 3 種揮手風格（準時／慢 25％＋抖動 15％／快 20％＋抖動 20％），指派音符最多的聲部：
//               放行了的音都要發聲、不卡音、同刻音在同一個 tick 發聲；另外量揮手→發聲的延遲與追趕造成的壓縮。
//    scenarios  情境掃描：前奏提早揮手、一人兩聲部、多人（2～4 位）、晚進場、中途停手（不再回來／回來）、休止期間不揮、
//               停手 0.6／2／8 秒——每個情境都用同一組不變量判定通過與否。
//
//  曲庫：預設放在 test/tools/library/（不進 git）。第一次先 `--download` 從遠端曲庫抓下來（單連線＋間隔，已有的
//  檔案會略過）；也可以用 --dir 指到別的資料夾。--limit=N 只掃前 N 首。
//
//  用法：node test/tools/library-scan.mjs --download
//        node test/tools/library-scan.mjs [--dir=資料夾] [--only=autoplay,perform,scenarios] [--limit=N]
// ============================================================

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseMidi, buildBeatGrid } from '../../src/midi/midiParser.js';
import { autoPlayStats, makeRng, measure, nominalWaves, rankedParts, simulate, startBeatOf } from './sim.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v = true] = a.replace(/^--/, '').split('='); return [k, v]; }));
const DIR = resolve(args.dir || join(dirname(fileURLToPath(import.meta.url)), 'library'));
const ONLY = new Set(String(args.only || 'autoplay,perform,scenarios').split(','));
const LIMIT = Number(args.limit) || Infinity;
const TICK_TOL_MS = 12.5;                          // 一個排程 tick（12ms）加浮點容差
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════════════════════════
   曲庫：下載、載入
   ═══════════════════════════════════════════ */

async function download() {
  // 直接用 app 的曲庫 client（midiApi.js），不另外維護一份 API 網址與回傳格式；它每首會印一行下載連結。
  const { searchSongs, downloadMidiFile } = await import('../../src/midi/midiApi.js');
  mkdirSync(DIR, { recursive: true });
  const { items: all } = await searchSongs({});
  const items = all.slice(0, LIMIT);
  const titles = Object.fromEntries(items.map((it) => [it.id, String(it.title || it.name || '')]));
  writeFileSync(join(DIR, 'titles.json'), JSON.stringify(titles, null, 1));
  console.log(`曲庫共 ${all.length} 首，下載 ${items.length} 首到 ${DIR}`);
  for (const item of items) {
    const file = join(DIR, `${item.id}.mid`);
    if (existsSync(file)) continue;
    for (let attempt = 1; ; attempt++) {
      try { writeFileSync(file, Buffer.from(await (await downloadMidiFile(item.id)).arrayBuffer())); break; }
      catch (err) {
        if (attempt >= 6) { console.error(`下載失敗，略過：${item.id}`); break; }
        await sleep(1500 * attempt);
      }
    }
    await sleep(450);                              // 單連線＋間隔，不要灌爆別人的伺服器
  }
}

function loadLibrary() {
  if (!existsSync(DIR)) { console.error(`找不到曲庫資料夾 ${DIR}：先執行 --download，或用 --dir 指到放 .mid 的資料夾`); process.exit(1); }
  const titlesFile = join(DIR, 'titles.json');
  const titles = existsSync(titlesFile) ? JSON.parse(readFileSync(titlesFile, 'utf8')) : {};
  const songs = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.mid')).slice(0, LIMIT)) {
    const buf = readFileSync(join(DIR, f)), id = f.replace(/\.mid$/, '');
    try { songs.push({ id, title: (titles[id] || id).slice(0, 24), score: parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) }); }
    catch (err) { console.warn(`解析失敗，略過：${id}（${err.message}）`); }
  }
  return songs;
}

/* ═══════════════════════════════════════════
   掃描 1：整首自動播放
   ═══════════════════════════════════════════ */

// 原檔裡用「velocity 0 的 Note On」當 Note Off 的事件數（parser 已經把它們配成跟 Note Off 一樣的音）。
const velocity0NoteOffs = (score) => score.tracks.reduce((a, t) => a + t.events.filter((e) => e.kind === 'channel' && e.type === 'noteOn' && e.data2 === 0).length, 0);

function scanAutoplay(songs) {
  const rows = songs.map((s) => ({ s, r: autoPlayStats(s.score), v0: velocity0NoteOffs(s.score) }));
  const count = (f) => rows.filter(f).length, sum = (f) => rows.reduce((a, row) => a + f(row), 0);
  console.log(`\n=== 整首自動播放（沒有人被指派），共 ${rows.length} 首 ===`);
  console.log(`沒播完：${count((x) => !x.r.finished)} 首；缺音（樂譜有、沒發聲）：${sum((x) => x.r.total - x.r.sounded)} 顆；放不下的聲部：${count((x) => x.r.unplaced)} 首`);
  console.log(`每個 noteOn 一個 noteOff：沒收的音 ${sum((x) => x.r.unpaired)} 個、多餘的 noteOff ${sum((x) => x.r.strayOff)} 個（有問題的歌 ${count((x) => x.r.unpaired || x.r.strayOff)} 首）；velocity 0 的 noteOn：${sum((x) => x.r.badVelocity)} 個`);
  console.log(`起音誤差 > ${TICK_TOL_MS}ms 的歌：${count((x) => x.r.onErr > TICK_TOL_MS)} 首（最大 ${Math.round(Math.max(...rows.map((x) => x.r.onErr)))}ms）；收音誤差 > ${TICK_TOL_MS}ms 的歌：${count((x) => x.r.offErr > TICK_TOL_MS)} 首（最大 ${Math.round(Math.max(...rows.map((x) => x.r.offErr)))}ms）`);
  console.log(`資訊：用 velocity 0 的 Note On 當 Note Off 的檔案 ${count((x) => x.v0 > 0)} 首（共 ${sum((x) => x.v0)} 個事件，parser 都配成正常的音）`);
  const bad = rows.filter((x) => !x.r.finished || x.r.total !== x.r.sounded || x.r.unpaired || x.r.strayOff || x.r.badVelocity || x.r.onErr > TICK_TOL_MS || x.r.offErr > TICK_TOL_MS);
  for (const x of bad.slice(0, 8)) console.log('  ✗', x.s.title, JSON.stringify(x.r));
  return bad.length;
}

/* ═══════════════════════════════════════════
   掃描 2：多聲部歌曲 × 3 種揮手風格
   ═══════════════════════════════════════════ */

const STYLES = [['準時', 1, 0], ['慢 25％＋抖動 15％', 1.25, 0.15], ['快 20％＋抖動 20％', 0.8, 0.2]];
const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

function scanPerform(songs) {
  const multi = songs.filter((s) => s.score.parts.length >= 2 && rankedParts(s.score).length);
  const rows = [];
  for (const s of multi) {
    const beats = buildBeatGrid(s.score), main = rankedParts(s.score)[0], b0 = startBeatOf(s.score, beats, [main.id]);
    for (const [styleName, factor, jitter] of STYLES) {
      const waves = nominalWaves(beats, b0, { factor, jitter, rnd: makeRng(21) });
      const m = measure(simulate(s.score, [{ partIds: [main.id], waves }]), { factor, waves, b0 });
      rows.push({ s, main, styleName, m });
    }
  }
  const sum = (key) => rows.reduce((a, r) => a + r.m[key], 0), count = (f) => rows.filter((r) => f(r.m)).length;
  console.log(`\n=== 多聲部歌曲 ${multi.length} 首 × ${STYLES.length} 種揮手風格 ＝ ${rows.length} 次模擬（各指派音符最多的聲部）===`);
  console.log(`放行了卻沒發聲的音：${sum('releasedMissing')} 顆（${count((m) => m.releasedMissing)} 次模擬）；沒被放行的音（揮手不夠多）：${sum('unreleased')} 顆`);
  console.log(`每個 noteOn 一個 noteOff：沒收的音 ${sum('unpaired')} 個（${count((m) => m.unpaired)} 次）、多餘的 noteOff ${sum('strayOff')} 個、velocity 0 的 noteOn ${sum('badVelocity')} 個`);
  console.log(`同刻音發聲差 > ${TICK_TOL_MS}ms：${count((m) => m.syncMax > TICK_TOL_MS)} 次模擬（最大 ${Math.max(...rows.map((r) => r.m.syncMax))}ms）`);
  console.log(`揮手→發聲 p50 中位數 ${median(rows.map((r) => r.m.lagP50))}ms、p99 中位數 ${median(rows.map((r) => r.m.lagP99))}ms（最差一次的 p99 ${Math.max(...rows.map((r) => r.m.lagP99 ?? 0))}ms）`);
  console.log(`追趕造成的壓縮：相鄰音間隔被壓到不到一半 ${sum('compressed')}／${sum('adjacent')}，擠在同一個 tick ${sum('bursts')}；相連音接點多出 >30ms 空白 ${sum('legatoGaps')}／${sum('legato')}`);
  console.log(`共用拍位比演奏者數的拍多走（代打搶在揮手前走拍）：${count((m) => m.ratchetWaves)} 次模擬（最多 ${Math.max(...rows.map((r) => r.m.ratchetMax))} 拍）`);
  for (const style of STYLES.map((x) => x[0])) {
    const sub = rows.filter((r) => r.styleName === style);
    console.log(`  ${style}：揮手→發聲 p50 中位 ${median(sub.map((r) => r.m.lagP50))}ms、p99 中位 ${median(sub.map((r) => r.m.lagP99))}ms、被壓縮 ${sub.reduce((a, r) => a + r.m.compressed, 0)}／${sub.reduce((a, r) => a + r.m.adjacent, 0)}`);
  }
  const bad = rows.filter((r) => r.m.releasedMissing || r.m.unpaired || r.m.strayOff || r.m.badVelocity || r.m.syncMax > TICK_TOL_MS);
  for (const r of bad.slice(0, 8)) console.log('  ✗', r.s.title, r.main.name, r.styleName, JSON.stringify(r.m));
  return bad.length;
}

/* ═══════════════════════════════════════════
   掃描 3：情境
   ═══════════════════════════════════════════ */

// 每個情境：players（每位演奏者的聲部與揮手時間表）＋ exempt（哪些音不要求一定發聲）。第一位演奏者永遠揮到曲末
// （錨點），所以整首的每一拍都會被放行；其他人揮手的樣子由情境決定。
function buildScenarios(score, rnd) {
  const beats = buildBeatGrid(score), [A, B, C, D] = rankedParts(score).map((p) => p.id);
  const b0Of = (ids) => startBeatOf(score, beats, ids);
  const waves = (b0, o = {}) => nominalWaves(beats, b0, { rnd, ...o });
  const out = [];
  // syncTolMs：同刻音發聲差的容許值。演奏者之間錯開的情境，晚幾十 ms 才揮第一下的人，他拍首的音是補上的（見
  // humanPerformer.js 的合併窗），所以容許值要加上最大的錯開量。
  // track：單人每拍揮一次、沒有漏揮的情境，另外量揮手→發聲的延遲與共用拍位有沒有比演奏者多走。
  const add = (name, ids, players, { exempt, syncTolMs = TICK_TOL_MS, track = false } = {}) => out.push({ name, players, exempt, syncTolMs, track });
  const solo = (name, o, track = false) => add(name, [A], [{ partIds: [A], waves: waves(b0Of([A]), o) }], { track });

  if (beats[b0Of([A])].startSeconds >= 2) solo('前奏提早揮手（第一下揮手落在前奏 30％處）', { leadMs: -beats[b0Of([A])].startSeconds * 700 });
  if (B) {
    const ids = [A, B], b0 = b0Of(ids);
    add('一人兩個聲部', ids, [{ partIds: ids, waves: waves(b0, { jitter: 0.1 }) }]);
    add('兩位演奏者（錯開 40ms、抖動）', ids, [{ partIds: [A], waves: waves(b0, { jitter: 0.1 }) }, { partIds: [B], waves: waves(b0, { jitter: 0.15, offsetMs: 40 }) }],
      { syncTolMs: TICK_TOL_MS + 40 });
    add('一人晚進場（第 8 拍才開始揮）', ids, [{ partIds: [A], waves: waves(b0) }, { partIds: [B], waves: waves(b0, { fromBeat: 8 }) }],
      { exempt: (v, n) => v.partId === B && n.beatIndex <= b0 + 9 });   // 他第一下揮手之前走過的拍，他的聲部本來就是靜音
    add('一人中途停手（第 10 拍之後不再揮）', ids, [{ partIds: [A], waves: waves(b0) }, { partIds: [B], waves: waves(b0, { pause: [9, Infinity] }) }]);
    add('一人停手 6 秒後回來（第 10 拍之後）', ids, [{ partIds: [A], waves: waves(b0) }, { partIds: [B], waves: waves(b0, { pause: [9, 6000] }) }]);
  }
  if (C) {
    const ids = [A, B, C, D].filter(Boolean), b0 = b0Of(ids);
    const players = [{ partIds: [A], waves: waves(b0) }, { partIds: [B], waves: waves(b0, { jitter: 0.1, offsetMs: 30 }) },
      { partIds: [C], waves: waves(b0, { jitter: 0.15, offsetMs: 70, skipProb: 0.1 }) }];
    if (D) players.push({ partIds: [D], waves: waves(b0, { jitter: 0.2, offsetMs: 110 }) });
    add(`${players.length} 位演奏者（錯開、抖動、其中一位隨機漏揮 10％）`, ids, players, { syncTolMs: TICK_TOL_MS + 110 });
  }
  solo('休止期間不揮手（單人，連續 4 拍不揮）', { skipBeats: [6, 10] });
  for (const sec of [0.6, 2, 8]) solo(`停手 ${sec} 秒後回來（單人，第 11 拍）`, { pause: [10, sec * 1000] });
  // 速度跟隨：factor＝揮手間隔是樂譜拍長的幾倍（<1 快、>1 慢），jitter＝每次間隔隨機偏差的比例（±）。
  for (const factor of [0.7, 1, 1.25, 1.6]) for (const jitter of [0.15, 0.3]) solo(`穩定揮手 ×${factor}、抖動 ±${jitter * 100}％（單人）`, { factor, jitter }, true);
  solo('漸快（單人，揮手間隔從 ×1.4 漸漸縮到 ×0.6）', { factorAt: (k, n) => 1.4 - (0.8 * k) / n }, true);
  solo('漸慢（單人，揮手間隔從 ×0.6 漸漸拉長到 ×1.4）', { factorAt: (k, n) => 0.6 + (0.8 * k) / n }, true);
  solo('突然變快（單人，第 20 拍起揮手間隔從 ×1 變 ×0.5）', { factorAt: (k) => (k < 20 ? 1 : 0.5) }, true);
  solo('突然變慢（單人，第 20 拍起揮手間隔從 ×1 變 ×2）', { factorAt: (k) => (k < 20 ? 1 : 2) }, true);
  // 漏揮：電腦在「該揮的時間＋τ」替你放行，你下一次準時的揮手不該多推一拍。
  for (const p of [0.1, 0.3]) solo(`隨機漏揮 ${p * 100}％（單人，抖動 ±10％）`, { skipProb: p, jitter: 0.1 }, true);
  solo('連續漏 3 拍（單人，第 9～11 拍）', { skipBeats: [8, 11] }, true);
  solo('每 4 拍漏 1 拍（單人）', { skipEvery: 4 }, true);
  // 完全停手 N 拍後回來（錯過的拍全由電腦走）。
  for (const n of [2, 8, 30]) solo(`停手 ${n} 拍後回來（單人，第 11 拍起）`, { skipBeats: [10, 10 + n] }, true);
  return out.map((sc) => ({ ...sc, b0: b0Of(sc.players.flatMap((p) => p.partIds)) }));
}

function scanScenarios(songs) {
  const byName = new Map();
  for (const s of songs.filter((x) => rankedParts(x.score).length >= 1)) {
    for (const sc of buildScenarios(s.score, makeRng(7))) {
      const m = measure(simulate(s.score, sc.players), { exempt: sc.exempt, ...(sc.track ? { waves: sc.players[0].waves, b0: sc.b0 } : {}) });
      if (!byName.has(sc.name)) byName.set(sc.name, []);
      byName.get(sc.name).push({ s, m, tol: sc.syncTolMs, track: sc.track });
    }
  }
  console.log(`\n=== 情境掃描（每個情境的不變量：放行了的音都發聲、每個 noteOn 一個 noteOff、同刻音同一個 tick）===`);
  let failures = 0;
  for (const [name, runs] of byName) {
    const sum = (key) => runs.reduce((a, r) => a + r.m[key], 0);
    const bad = runs.filter((r) => r.m.releasedMissing || r.m.unpaired || r.m.strayOff || r.m.badVelocity || r.m.syncMax > r.tol);
    failures += bad.length;
    let line = `${bad.length ? '✗' : '✓'} ${name}：${runs.length} 首；放行了卻沒發聲 ${sum('releasedMissing')}、沒收的音 ${sum('unpaired')}、同刻音差最大 ${Math.max(...runs.map((r) => r.m.syncMax))}ms；曲末沒被放行的音 ${sum('unreleased')} 顆（${runs.filter((r) => r.m.unreleased).length} 首）`;
    if (runs[0].track) {
      const pre = sum('preempted'), waves = sum('waveCount');
      line += `\n    揮手→發聲 p50 中位 ${median(runs.map((r) => r.m.lagP50))}ms、p99 中位 ${median(runs.map((r) => r.m.lagP99))}ms（最差一首 p99 ${Math.max(...runs.map((r) => r.m.lagP99 ?? 0))}ms）；`
        + `電腦搶在揮手前放行 ${(100 * pre / waves).toFixed(1)}％（${pre}／${waves} 次揮手）；共用拍位比演奏者數的拍多走：${runs.filter((r) => r.m.ratchetWaves).length} 首（最多 ${Math.max(...runs.map((r) => r.m.ratchetMax))} 拍）；被壓縮 ${sum('compressed')}／${sum('adjacent')}`;
      const missLag = median(runs.map((r) => r.m.missLagMed));
      if (missLag != null) line += `；漏揮的拍由電腦補位，比他本來該揮的時間晚拍長的 ${missLag}`;
    }
    console.log(line);
    for (const r of bad.slice(0, 3)) console.log('    ', r.s.title, JSON.stringify(r.m));
  }
  return failures;
}

/* ═══════════════════════════════════════════
   主程式
   ═══════════════════════════════════════════ */

if (args.download) await download();
const started = Date.now();
const songs = loadLibrary();
console.log(`曲庫 ${DIR}：${songs.length} 首`);
let problems = 0;
if (ONLY.has('autoplay')) problems += scanAutoplay(songs);
if (ONLY.has('perform')) problems += scanPerform(songs);
if (ONLY.has('scenarios')) problems += scanScenarios(songs);
console.log(`\n${problems ? `有 ${problems} 筆不符合` : '全部符合'}（${((Date.now() - started) / 1000).toFixed(0)} 秒）`);
process.exitCode = problems ? 1 : 0;
