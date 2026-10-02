// ============================================================
//  mutation-check.mjs — 變異檢查：故意把排程器弄壞，看指定的測試會不會變紅（手動執行，不進 CI，純 Node）
//
//  做法：把 src／測試複製到暫存資料夾，在複製出來的 humanPerformer.js 套用一個「一行的破壞」，跑測試，檢查
//  「指定的那幾個測試」有沒有失敗。不會動到工作目錄裡的任何檔案。沒有任何指定測試變紅＝這個行為沒有被保護。
//  破壞用的字串必須在原始碼裡剛好出現一次；原始碼改了找不到就會直接報錯，提醒更新這張表。
//
//  用法：node test/tools/mutation-check.mjs [--only=關鍵字]
// ============================================================

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = 'src/midi/humanPerformer.js';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

// edits：[原始碼裡的那一行（或片段）, 換成什麼]。expect：應該變紅的測試名稱關鍵字（任何一個變紅就算抓到）；
// suites：要跑哪些測試檔（預設只跑排程器的單元測試）。
const MUTATIONS = [
  { name: 'FIFO 改回以音高為鍵（同音高的新音蓋掉舊音）', edits: [['queue.push({ endSec: n.endSeconds, legatoTo: n.legatoTo });', 'queue.length = 0; queue.push({ endSec: n.endSeconds, legatoTo: n.legatoTo });']],
    expect: ['同音高重疊（先進先出）', 'canon 完美演奏者'], suites: ['human-performer', 'oracle'] },
  { name: '收音改回「發聲後各自倒數真實秒數」', edits: [
    ['queue.push({ endSec: n.endSeconds, legatoTo: n.legatoTo });', 'queue.push({ endSec: n.durationSeconds, startedMs: this._lastTickMs, legatoTo: n.legatoTo });'],
    ['queue[0].endSec <= this._clockSec + EPS', '(this._lastTickMs - queue[0].startedMs) / 1000 >= queue[0].endSec - EPS']],
    expect: ['收音依樂譜時鐘'] },
  { name: '放行邊界改成含等號（邊界上的音在放行前就發聲）', edits: [['if (n.startSeconds > S + EPS || n.startSeconds >= B) break;', 'if (n.startSeconds > S + EPS || n.startSeconds > B) break;']],
    expect: ['放行邊界是排他的', 'L3 同步'], suites: ['human-performer', 'oracle'] },
  { name: '拿掉追趕（時鐘直接跳到揮手的目標）', edits: [['this._clockSec = Math.min(this._clockSec + dt * this._playbackRate * catchUp, this._frontierSec);', 'this._clockSec = Math.min(Math.max(this._clockSec + dt * this._playbackRate, this._catchUpToSec), this._frontierSec);']],
    expect: ['揮得比樂譜快'] },
  { name: '拿掉停格釋放（停格太久也不收音）', edits: [['if (this._stallSec > this._idleThresholdSec()) this._noteOffAll();', '/* 變異：沒有停格釋放 */']],
    expect: ['停格釋放不分音的種類', '停格超過閒置門檻'] },
  { name: '拿掉相連音撐住（停格等揮手時照編碼收音）', edits: [['return !!successor && entry.legatoTo >= voice.cursor && successor.startSeconds >= this._frontierSec;', 'return false;']],
    expect: ['相連音在時鐘停格等揮手時撐住'] },
  { name: '拿掉每個 tick 的 dt 上限', edits: [['Math.min(MAX_TICK_DT_SEC, (nowMs - this._lastTickMs) / 1000)', '(nowMs - this._lastTickMs) / 1000']],
    expect: ['每個 tick 的時間步長上限'] },
  { name: '拿掉第一次放行不追趕（提早揮手把前奏追成倍速）', edits: [['this._catchUpToSec = first ? this._clockSec : beat.startSeconds;', 'this._catchUpToSec = beat.startSeconds;']],
    expect: ['前奏：第一下揮手不追趕'] },
  { name: '拿掉晚到演奏者的補音（走過就丟）', edits: [['if (n.startSeconds < S - this._followWindowSec() * this._playbackRate) { voice.cursor++; continue; }', 'if (true) { voice.cursor++; continue; }']],
    expect: ['第二位晚 40ms'] },
  { name: '拿掉多人合併窗（晚到的揮手各推一拍）', edits: [['return nowMs - this._lastReleaseMs <= this._followWindowSec() * 1000;', 'return false;']],
    expect: ['多人合併窗', '你晚一點才揮'] },
  { name: '一個 tick 多位演奏者同時揮手就放行兩拍', edits: [['if (release) {', 'if (release) { if (waveSlots.size > 1) this._releaseNextBeat();']],
    expect: ['兩位演奏者同一個 tick 揮手'] },
  { name: '拿掉自動終局', edits: [['if (anyHuman) { this._frontierSec = Infinity; this._autopilotLeftSec = null; }', '/* 變異：沒有終局 */']],
    expect: ['所有指派聲部都沒有更多音符：自動終局'] },
  { name: '收音時不送 noteOff（暫停與停格釋放只清紀錄）', edits: [['for (let i = 0; i < queue.length; i++) {', 'for (let i = 0; i < 0; i++) {']],
    expect: ['暫停會收掉所有還在響的音', '固定種子的整體不變量壓力測試'] },
  { name: '送出 velocity 0 的 noteOn', edits: [['synth?.noteOn(voice.channel, n.note, n.velocity);', 'synth?.noteOn(voice.channel, n.note, 0);']],
    expect: ['canon 完美演奏者', '固定種子的整體不變量壓力測試', '不送 velocity 0 的 noteOn'], suites: ['human-performer', 'oracle'] },
  // ── 速度跟隨 ──
  { name: '速度倍率固定 1（不跟著揮手速度）', edits: [['this._playbackRate = smoothRate(r, sample);', 'this._playbackRate = 1;']],
    expect: ['揮得比樂譜快 26％', '電腦照估計的速度替你走', '終局照最後一次估計'] },
  { name: '速度平滑改成算術平均（不在對數域）', edits: [['return rate ** (1 - RATE_ALPHA) * sample ** RATE_ALPHA;', 'return (1 - RATE_ALPHA) * rate + RATE_ALPHA * sample;']],
    expect: ['速度平滑在對數域'] },
  { name: '取樣不擋範圍外的間隔（停頓也當成速度）', edits: [['return ratio >= RATE_MIN && ratio <= RATE_MAX ? ratio : null;', 'return ratio > 0 ? ratio : null;']],
    expect: ['速度取樣', '停頓不當成速度'] },
  { name: '暫停不清掉上一次揮手（跨過暫停的間隔被取樣）', edits: [['this._lastWave = null; // 暫停的時間不是揮手的間隔', '/* 變異：暫停沒有清掉上一次揮手 */ // 暫停的時間不是揮手的間隔']],
    expect: ['暫停期間的時間不算揮手間隔'] },
  { name: '電腦每一步都等一整拍的原譜秒數（不除以速度倍率）', edits: [['if (byAutopilot) this._autopilotLeftSec = beatSec / this._playbackRate;', 'if (byAutopilot) this._autopilotLeftSec = beatSec;']],
    expect: ['電腦照估計的速度替你走'] },
  { name: '合併窗不除以速度倍率（快的合奏窗太寬）', edits: [['return (FOLLOW_WINDOW_BEATS * this._beatLengthSec()) / this._playbackRate;', 'return FOLLOW_WINDOW_BEATS * this._beatLengthSec();']],
    expect: ['合併窗的長度跟著速度倍率縮短'] },
  { name: '補音範圍不乘速度倍率（拿真實秒數當樂譜秒數比）', edits: [['n.startSeconds < S - this._followWindowSec() * this._playbackRate', 'n.startSeconds < S - this._followWindowSec()']],
    expect: ['晚到演奏者補音的範圍跟著速度倍率走'] },
  { name: '時鐘不照速度倍率前進（永遠原譜速度）', edits: [['this._clockSec + dt * this._playbackRate * catchUp', 'this._clockSec + dt * catchUp']],
    expect: ['揮得比樂譜快 26％', '終局照最後一次估計'] },
  { name: '終局把速度倍率重設回 1（尾奏回到原譜速度）', edits: [['if (anyHuman) { this._frontierSec = Infinity; this._autopilotLeftSec = null; }', 'if (anyHuman) { this._frontierSec = Infinity; this._autopilotLeftSec = null; this._playbackRate = 1; }']],
    expect: ['終局照最後一次估計的速度播完'] },
  { name: '重設不清速度倍率（重播沿用上一輪的估計）', edits: [['    this._playbackRate = 1;\n    this._sampled = false;\n', '    this._sampled = false;\n']],
    expect: ['重設把排程器退回'] },
  // ── 代打補位 ──
  { name: 'τ＝0：電腦在「該揮的時間」就放行，不給你寬限', edits: [['const AUTOPILOT_GRACE_BEATS = 0.2;', 'const AUTOPILOT_GRACE_BEATS = 0;']],
    expect: ['漏揮一拍：', '電腦照估計的速度替你走'] },
  { name: '電腦整個不替你走（回到沒有補位，等你揮手）', edits: [['if (this._frontierSec === Infinity) {\n        this._autopilotLeftSec = null; // 已經沒有東西可放行', 'if (true) {\n        this._autopilotLeftSec = null; // 已經沒有東西可放行']],
    expect: ['漏揮一拍：', '連續漏揮', '完全停手：音樂自己'] },
  { name: '電腦放行之後每步又等 1.2 拍（相位每拍多晚 τ）', edits: [['if (byAutopilot) this._autopilotLeftSec = beatSec / this._playbackRate;', 'if (byAutopilot) this._autopilotLeftSec = (beatSec / this._playbackRate) * (1 + AUTOPILOT_GRACE_BEATS);']],
    expect: ['連續漏揮'] },
  { name: '拿掉遲到揮手歸屬（電腦放行之後你才揮，當成下一拍）', edits: [['if (this._lastReleaseMs == null || this._actedBeat.get(slot) === this._beatIndex) return false;', 'return false;']],
    expect: ['你晚一點才揮', '多人合併窗'] },
  { name: '電腦放行不開窗（窗只從真人放行算起）', edits: [['this._lastReleaseMs = nowMs; // 窗從任何一次放行算起', '/* 變異：電腦放行不開窗 */ // 窗從任何一次放行算起']],
    expect: ['你晚一點才揮'] },
  { name: '拿掉離群暫存（單次離群的取樣直接套用）', edits: [['const isOutlier = (s) => s > r * (1 + RATE_OUTLIER) || s < r * (1 - RATE_OUTLIER);', 'const isOutlier = () => false;']],
    expect: ['同一個動作被偵測成兩次', '漏揮一拍之後準時揮手'] },
  { name: '第一次取樣之前的寬限拿掉（只揮過一次手也只等 1.2 拍）', edits: [['else if (!this._sampled) this._autopilotLeftSec = beatSec * FIRST_SAMPLE_GRACE_BEATS;', 'else if (false) this._autopilotLeftSec = beatSec * FIRST_SAMPLE_GRACE_BEATS;']],
    expect: ['第一次取樣之前'] },
  { name: '前奏期間電腦照樣倒數（提早揮的第一下之後前奏被追趕）', edits: [['if (this._autopilotLeftSec != null && this._clockSec >= this._entrySec - EPS) this._autopilotLeftSec -= dt;', 'if (this._autopilotLeftSec != null) this._autopilotLeftSec -= dt;']],
    expect: ['前奏：只在前奏中揮過一次手'] },
];

function runSuite(dir, suite) {
  const r = spawnSync(process.execPath, ['--no-warnings', `test/unit/${suite}.test.mjs`], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  const failed = [];
  let current = '';
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('=== ')) current = line.replace(/^=== (\[已知差異\] )?/, '').replace(/ ===\s*$/, '');
    else if (line.startsWith('❌')) failed.push(current);
  }
  if (r.error || r.status === null) failed.push(`（${suite} 沒有正常結束：${r.error?.message || r.signal}）`);
  return failed;
}

const tmp = mkdtempSync(join(tmpdir(), 'hf-mutation-'));
try {
  mkdirSync(join(tmp, 'test'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true, filter: (p) => !/GeneralUserGS|pose_landmarker/.test(p) });  // 不複製大檔
  cpSync(join(ROOT, 'test/unit'), join(tmp, 'test/unit'), { recursive: true });
  for (const pkg of ['spessasynth_core', 'stb-vorbis']) cpSync(join(ROOT, 'node_modules', pkg), join(tmp, 'node_modules', pkg), { recursive: true });   // oracle 測試要用 spessasynth_core；複製而不是連結，rmSync 才不會碰到真的 node_modules
  const original = readFileSync(join(ROOT, TARGET), 'utf8').replace(/\r\n/g, '\n');   // 換行統一成 LF：不管 checkout 時是 CRLF 還是 LF，多行的破壞字串都對得上
  let bad = 0;
  for (const m of MUTATIONS.filter((x) => x.name.includes(ONLY))) {
    let mutated = original;
    for (const [find, replace] of m.edits) {
      const count = mutated.split(find).length - 1;
      if (count !== 1) { console.error(`✗ ${m.name}：要破壞的字串在原始碼裡出現 ${count} 次（要剛好 1 次），請更新這張表：\n  ${find}`); process.exit(2); }
      mutated = mutated.replace(find, () => replace);
    }
    writeFileSync(join(tmp, TARGET), mutated);
    const failed = (m.suites || ['human-performer']).flatMap((suite) => runSuite(tmp, suite));
    const caught = m.expect.filter((k) => failed.some((f) => f.includes(k)));
    if (!caught.length) bad++;
    console.log(`${caught.length ? '✓' : '✗'} ${m.name}\n    指定的測試變紅：${caught.length ? caught.join('、') : '沒有！'}；全部變紅的測試 ${failed.length} 個${failed.length ? `：${failed.slice(0, 4).map((f) => f.slice(0, 40)).join('、')}${failed.length > 4 ? '…' : ''}` : ''}`);
  }
  console.log(bad ? `\n有 ${bad} 個變異沒有被指定的測試抓到` : '\n每個變異都被指定的測試抓到');
  process.exitCode = bad ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
