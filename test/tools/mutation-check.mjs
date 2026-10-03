// ============================================================
//  mutation-check.mjs — 變異檢查：故意把排程器弄壞，看指定的測試會不會變紅（手動執行，不進 CI，純 Node）
//
//  做法：把 src／測試複製到暫存資料夾，在複製出來的原始檔（預設 humanPerformer.js，也可以用 target 指定別的檔）
//  套用一個「一行的破壞」，跑測試，檢查「指定的那幾個測試」有沒有失敗。不會動到工作目錄裡的任何檔案。沒有任何
//  指定測試變紅＝這個行為沒有被保護。suites 可以含 'smoke'：用同一支瀏覽器測試（test/browser/smoke-test.mjs）
//  跑被破壞的複本（HF_ROOT），每個要一分多鐘，所以只放確實要靠瀏覽器才抓得到的破壞。
//  破壞用的字串必須在原始碼裡剛好出現一次；原始碼改了找不到就會直接報錯，提醒更新這張表。
//
//  用法：node test/tools/mutation-check.mjs [--only=關鍵字] [--skip-smoke | --only-smoke]
// ============================================================

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = 'src/midi/humanPerformer.js'; // 沒有指定 target 的變異破壞這個檔
const PREVIEW = 'src/midi/previewPlayer.js', PLAYER = 'src/midi/midiPlayer.js', SYNTH = 'src/midi/synth.js', PARSER = 'src/midi/midiParser.js';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const SKIP_SMOKE = process.argv.includes('--skip-smoke'); // 只跑單元測試抓得到的變異（快）
const ONLY_SMOKE = process.argv.includes('--only-smoke'); // 只跑要靠瀏覽器測試抓的變異（慢）

// edits：[原始碼裡的那一行（或片段）, 換成什麼]。expect：應該變紅的測試名稱關鍵字（任何一個變紅就算抓到）；
// suites：要跑哪些測試檔（預設只跑排程器的單元測試）；target：破壞哪個檔（預設排程器）。
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
    expect: ['前奏：入場前半拍內'] },
  { name: '拿掉前奏忽略（前奏中的每一下揮手都放行拍，前奏被追趕衝過去）', edits: [['if (this._inPrelude()) {', 'if (false) {']],
    expect: ['前奏：你的聲部開頭有空白', '前奏：前奏中的揮手拿來估速', '前奏：只在前奏中揮過一次手'] },
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
  { name: 'τ＝0：電腦在「該揮的時間」就放行，不給你寬限', edits: [['const AUTOPILOT_GRACE_BEATS = 0.15;', 'const AUTOPILOT_GRACE_BEATS = 0;']],
    expect: ['漏揮一拍：', '電腦照估計的速度替你走'] },
  { name: '電腦整個不替你走（回到沒有補位，等你揮手）', edits: [['if (this._frontierSec === Infinity) {\n        this._autopilotLeftSec = null; // 已經沒有東西可放行', 'if (true) {\n        this._autopilotLeftSec = null; // 已經沒有東西可放行']],
    expect: ['漏揮一拍：', '連續漏揮', '完全停手：音樂自己'] },
  { name: '電腦放行之後每步又等 1.2 拍（相位每拍多晚 τ）', edits: [['if (byAutopilot) this._autopilotLeftSec = beatSec / this._playbackRate;', 'if (byAutopilot) this._autopilotLeftSec = (beatSec / this._playbackRate) * (1 + AUTOPILOT_GRACE_BEATS);']],
    expect: ['連續漏揮'] },
  { name: '拿掉遲到揮手歸屬（電腦放行之後你才揮，當成下一拍）', edits: [['if (this._lastReleaseMs == null || this._actedBeat.get(slot) === this._beatIndex) return false;', 'return false;']],
    expect: ['你晚一點才揮', '多人合併窗'] },
  { name: '電腦放行不開窗（窗只從真人放行算起）', edits: [['this._lastReleaseMs = nowMs; // 窗從任何一次放行算起', '/* 變異：電腦放行不開窗 */ // 窗從任何一次放行算起']],
    expect: ['停手好幾拍後回來'] },
  { name: '拿掉離群暫存（單次離群的取樣直接套用）', edits: [['const isOutlier = (s) => s > r * (1 + RATE_OUTLIER) || s < r * (1 - RATE_OUTLIER);', 'const isOutlier = () => false;']],
    expect: ['同一個動作被偵測成兩次', '漏揮一拍之後準時揮手'] },
  { name: '第一次取樣之前的寬限拿掉（只揮過一次手也只等 1.2 拍）', edits: [['else if (!this._sampled) this._autopilotLeftSec = beatSec * FIRST_SAMPLE_GRACE_BEATS;', 'else if (false) this._autopilotLeftSec = beatSec * FIRST_SAMPLE_GRACE_BEATS;']],
    expect: ['第一次取樣之前'] },
  { name: '拿掉間隔判斷（晚到的揮手只看離電腦放行多久，連續但晚的揮手被當成下一拍而棘輪）', edits: [['if (this._autoBeat === this._beatIndex && lastMs != null', 'if (false && lastMs != null']],
    expect: ['你揮得晚但仍連續'] },
  { name: '間隔門檻放到 9 拍（漏揮也被當成晚到，揮手吞掉一拍）', edits: [['const LATE_RESPONSE_BEATS = 1.7;', 'const LATE_RESPONSE_BEATS = 9;']],
    expect: ['你隔了快 2 拍才揮'] },
  { name: '前奏期間電腦照樣倒數（提早揮的第一下之後前奏被追趕）', edits: [['if (this._autopilotLeftSec != null && this._clockSec >= this._entrySec - EPS) this._autopilotLeftSec -= dt;', 'if (this._autopilotLeftSec != null) this._autopilotLeftSec -= dt;']],
    expect: ['前奏：只在前奏中揮過一次手'] },
  // ── parser：聲部切分（part／voice）與跟官方對齊（單元測試＋差異測試）──
  { name: 'parser：同 tick 的速度衝突改回先出現者生效', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['        last.microsecondsPerQuarter = ev.microsecondsPerQuarter;\n        last.bpm = ev.bpm;\n', '']],
    expect: ['同 tick 的速度衝突'] },
  { name: 'parser：音符 channel 不加 port 偏移', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['    offsets.set(t.index, offsetOfPort.get(port));', '    offsets.set(t.index, 0);']],
    expect: ['port 絕對 channel', '打擊樂器在 port 1'] },
  { name: 'parser：port 偏移用 port 的數值而不是出現順序', target: PARSER, suites: ['midi-parser'], edits: [['    if (!offsetOfPort.has(port)) offsetOfPort.set(port, offsetOfPort.size * 16);', '    if (!offsetOfPort.has(port)) offsetOfPort.set(port, port * 16);']],
    expect: ['port 絕對 channel'] },
  { name: 'parser：沒指定 port 的軌用 0 而不是最小的已指定 port', target: PARSER, suites: ['midi-parser'], edits: [['  const defaultPort = given.length ? Math.min(...given) : 0;', '  const defaultPort = 0;']],
    expect: ['port 絕對 channel'] },
  { name: 'parser：有初始化區塊的 track 也能併入上一組（拿掉 hasInit 條件）', target: PARSER, suites: ['midi-parser'], edits: [['    const canMerge = cur && !s.hasInit\n', '    const canMerge = cur\n']],
    expect: ['兩台鋼琴同名'] },
  { name: 'parser：軌名不同也併入上一組（拿掉軌名條件）', target: PARSER, suites: ['midi-parser'], edits: [['      && (!s.track.name || !cur.first.track.name || s.track.name === cur.first.track.name)\n', '']],
    expect: ['舊檔（沒有初始化區塊'] },
  { name: 'parser：用了別的 channel 也併入上一組（拿掉 channel 子集條件）', target: PARSER, suites: ['midi-parser'], edits: [['      && [...s.noteChannels].every((ch) => cur.knownChannels.has(ch));', ';']],
    expect: ['用的是這組沒有的 channel'] },
  { name: 'parser：單獨的 Program Change 也算初始化區塊（下行譜變成新樂器）', target: PARSER, suites: ['midi-parser'], edits: [["    if (ev.type === 'programChange') {\n      init.program = ev.data1;\n", "    if (ev.type === 'programChange') {\n      init.program = ev.data1;\n      hasInit = true;\n"]],
    expect: ['〈蝸牛與黃鸝鳥〉的結構'] },
  { name: 'parser：下行譜不沿用首軌的初始化', target: PARSER, suites: ['midi-parser'], edits: [['      const fromInit = group.first.initByChannel.get(channel) || null;', '      const fromInit = summary.initByChannel.get(channel) || null;']],
    expect: ['鋼琴兩行譜'] },
  { name: 'parser：有初始化區塊的 voice 不用 tick 0 的 program', target: PARSER, suites: ['midi-parser'], edits: [['      const program = fromInit?.program ?? st.program;', '      const program = st.program;']],
    expect: ['就算在第一顆音之前出現也被忽略'] },
  { name: 'parser：bank 預設不分打擊 channel（一律 121）', target: PARSER, suites: ['midi-parser'], edits: [['      const defaultMsb = vk.channel % 16 === DRUM_CHANNEL ? 120 : 121;', '      const defaultMsb = 121;']],
    expect: ['沒有初始化區塊的 voice', '打擊樂器在 port 1'] },
  { name: 'parser：同音高重疊不警告', target: PARSER, suites: ['midi-parser'], edits: [['      if (st.overlaps) {', '      if (false) {']],
    expect: ['同一個 voice 內同音高重疊'] },
  { name: 'parser：同名 part 不加序號', target: PARSER, suites: ['midi-parser'], edits: [['    if (sameBase(i) === 1) { part.name = bases[i]; return; }', '    if (true) { part.name = bases[i]; return; }']],
    expect: ['兩個小提琴 Part'] },
  { name: 'parser：part 名稱取第一個 voice（不是音符最多的）', target: PARSER, suites: ['midi-parser'], edits: [['    const main = [...part.voices].sort((a, b) => b.noteCount - a.noteCount || a.channel - b.channel)[0];', '    const main = part.voices[0];']],
    expect: ['part 名稱取音符最多的 voice'] },
  // ── 可播放性（嚴格假合成器：初始狀態先於 noteOn、打擊槽、值域、成對、沒有卡音）──
  { name: '可播放性：初始化不送 program（noteOn 之前缺 program）', suites: ['playability'], edits: [['      synth.programChange(channel, voice.program || 0);\n', '']],
    expect: ['整首自動播放可以播放'] },
  { name: '可播放性：打擊 voice 配到旋律 channel', suites: ['playability'], edits: [['    if (v.percussionKit) {\n      if (!kitChannel.has', '    if (false) {\n      if (!kitChannel.has']],
    expect: ['輸出 channel 配置', '整首自動播放可以播放'] },
  { name: '可播放性：收音時不送 noteOff（曲末卡音，嚴格合成器也要抓到）', suites: ['playability'], edits: [['for (let i = 0; i < queue.length; i++) {', 'for (let i = 0; i < 0; i++) {'], ['        try { synth?.noteOff(voice.channel, pitch); } catch (err) {}\n        queue.shift();', '        queue.shift();']],
    expect: ['整首自動播放可以播放', '兩位演奏者'] },
  // ── voice 化（排程器以 voice 為單位）──
  { name: 'voice 化：同一個 part 的 voice 用 partId 當 key（互相覆蓋）', edits: [['voices.set(spec.id, makeVoice(spec, assignments.get(spec.partId), notesByVoice.get(spec.id) || [], \'human\', channel));', 'voices.set(spec.partId, makeVoice(spec, assignments.get(spec.partId), notesByVoice.get(spec.id) || [], \'human\', channel));']],
    expect: ['voice 化：一個 part 兩個 voice'] },
  { name: 'voice 化：音符不依 voiceId 分組（全按 partId）', edits: [['const key = n.voiceId ?? n.partId;', 'const key = n.partId;']],
    expect: ['voice 化：一個 part 兩個 voice'] },
  { name: 'voice 化：不同鼓組全擠在第一個打擊槽', edits: [['kitChannel.set(v.program, drumChannels[kitChannel.size]);', 'kitChannel.set(v.program, drumChannels[0]);']],
    expect: ['打擊 voice：依鼓組 program 分配'] },
  { name: 'voice 化：旋律 voice 可以落在打擊槽', edits: [['if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);', 'out.push(ch);']],
    expect: ['打擊 voice：依鼓組 program 分配'] },
  { name: 'voice 化：輸出 channel 用完的 voice 不回報', edits: [['    else unplaced.push(v.id);\n  }\n  return { byVoiceId, unplaced };', '  }\n  return { byVoiceId, unplaced };']],
    expect: ['輸出 channel 用完'] },
  { name: 'voice 化：初始化不送 CC10／91／93', edits: [['      synth.controllerChange(channel, 10, init?.pan ?? GM_DEFAULT_PAN);\n      synth.controllerChange(channel, 91, init?.reverb ?? GM_DEFAULT_REVERB);\n      synth.controllerChange(channel, 93, init?.chorus ?? GM_DEFAULT_CHORUS);\n', '']],
    expect: ['voice 初始化'] },
  { name: 'voice 化：初始化不送 CC7（原音量）', edits: [['      synth.controllerChange(channel, 7, voice.baseVolume);\n', '']],
    expect: ['voice 初始化', 'baseVolume'] },
  { name: 'voice 化：代打音量不依原音量（固定 85）', edits: [['autopilotVolume: Math.round(baseVolume * AUTOPILOT_VOLUME_RATIO),', 'autopilotVolume: 85,']],
    expect: ['baseVolume'] },
  { name: 'voice 化：重播把 CC7 送回固定 100', edits: [['      voice._lastSentCc7 = voice.baseVolume;\n      try { this._synthOf(voice)?.controllerChange(voice.channel, 7, voice.baseVolume); } catch (err) {}', '      voice._lastSentCc7 = 100;\n      try { this._synthOf(voice)?.controllerChange(voice.channel, 7, 100); } catch (err) {}']],
    expect: ['baseVolume'] },
  // ── 試聽：PreviewPlayer（單元測試）──
  { name: '試聽不關掉官方的循環播放（loopCount 留著預設）', target: PREVIEW, suites: ['preview-player'], edits: [['seq.loopCount = 0; // 官方預設循環播放（-1），試聽播完就該停', '/* 變異：沒有關循環 */']],
    expect: ['loopCount 明確設成 0'] },
  { name: '試聽不比對 songChange 的檔名（舊載入的事件也算數）', target: PREVIEW, suites: ['preview-player'], edits: [['(song) => { if (song?.fileName === name) settle(); }', '() => { settle(); }']],
    expect: ['別次載入晚到的 songChange', '載入中又 start()'] },
  { name: '試聽載入沒有逾時（長度 0 的 MIDI 會永遠卡住）', target: PREVIEW, suites: ['preview-player'], edits: [["timer = setTimeout(() => settle(fail('timeout', '官方播放器沒有回應')), this._timeoutMs);", '/* 變異：沒有逾時 */']],
    expect: ['逾時'] },
  { name: '停止試聽不中斷還在等的載入', target: PREVIEW, suites: ['preview-player'], edits: [["this._abort?.(fail('aborted', '試聽被中斷'));", '/* 變異：不中斷 */']],
    expect: ['載入中 stop()', '載入中又 start()'] },
  { name: '載入結束後不移除官方事件的監聽（累積）', target: PREVIEW, suites: ['preview-player'], edits: [["seq.eventHandler.removeEvent('songChange', EVENT_ID);", '/* 變異：不移除 */']],
    expect: ['監聽都已移除'] },
  { name: '播完後續播不從頭（直接 play）', target: PREVIEW, suites: ['preview-player'], edits: [['if (this._seq.isFinished) this.restart();\n    else this._seq.play();', 'this._seq.play();']],
    expect: ['播完（官方 isFinished）之後 resume()'] },
  { name: '暫停不呼叫官方的 pause（試聽停不下來）', target: PREVIEW, suites: ['preview-player'], edits: [['pause() { if (this._active) this._seq.pause(); }', 'pause() { /* 變異：不暫停 */ }']],
    expect: ['pause()／resume() 交給官方'] },
  { name: '解析失敗不丟錯（當成載入成功）', target: PREVIEW, suites: ['preview-player'], edits: [["(err) => settle(fail('parse', err?.message || '官方解析器拒絕這首 MIDI'))", '() => settle()']],
    expect: ['官方解析器拒絕（midiError）'] },
  { name: '開始新的試聽前不先結束上一次', target: PREVIEW, suites: ['preview-player'], edits: [['this.stop(); // 上一次試聽（包含還在等的載入）先結束', '/* 變異：不先 stop */']],
    expect: ['載入中又 start()'] },
  // ── 試聽：播放列與引擎接線（瀏覽器測試，每個一分多鐘）──
  { name: '換來源時不把播放列切回演奏（試聽 mode 殘留）', target: PLAYER, suites: ['smoke'], edits: [["playerStore.set({ mode: 'perform', transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });", "playerStore.set({ transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });"]],
    expect: ['換歌', '按鈕狀態'] },
  { name: '試聽播完 uiTick 不偵測（永遠停在「播放中」）', target: PLAYER, suites: ['smoke'], edits: [['!playerStore.state.finished && synth.isPreviewFinished()', 'false']],
    expect: ['試聽播完'] },
  { name: '演奏播放中 ♪ 也能按', target: PLAYER, suites: ['smoke'], edits: [['preview: inPreview, // 演奏播放中 ♪ 灰；試聽播放中 ♪ 是「結束試聽」，可按', 'preview: true,']],
    expect: ['演奏播放中 ♪ 是灰的', '64 種狀態組合'] },
  { name: '♪ 的 action 不對狀態表（灰的時候被呼叫也照做）', target: PLAYER, suites: ['smoke'], edits: [["'preview': whenAllowed('preview', () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview())),", "'preview': () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview()),"]],
    expect: ['64 種狀態組合'] },
  { name: '清場不停掉試聽（換歌／離開試聽之後官方還在播）', target: SYNTH, suites: ['smoke'], edits: [['  previewPlayer?.stop();\n  isSongLoaded = false;', '  isSongLoaded = false;']],
    expect: ['離開試聽：官方 Sequencer 已停', '換歌'] },
  { name: '離開試聽不清場（只切畫面）', target: PLAYER, suites: ['smoke'], edits: [['function leavePreview() {\n  synth.flushPreviousSong();\n', 'function leavePreview() {\n']],
    expect: ['離開試聽：官方 Sequencer 已停'] },
  { name: '進入試聽不結束演奏（排程器繼續跑）', target: SYNTH, suites: ['smoke'], edits: [["  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');\n  flushPreviousSong();\n", "  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');\n"]],
    expect: ['進入試聽＝演奏進度歸零'] },
  { name: 'worklet 回讀：初始化的 CC7 沒送到 worklet（只剩 program）', suites: ['smoke'], edits: [['      synth.controllerChange(channel, 7, voice.baseVolume);\n', '']],
    expect: ['worklet 在'] },
  { name: '開機補完 channel 後不重設合成器（channel 16 以上預設是打擊）', target: SYNTH, suites: ['smoke'], edits: [['        s.reset();\n      }', '      }']],
    expect: ['開機後'] },
  { name: '試聽失敗時畫面沒有提示', target: PLAYER, suites: ['smoke'], edits: [["      notice: PREVIEW_NOTICE[err.kind] ?? `試聽失敗：${source.name}`,\n", '']],
    expect: ['試聽錯誤路徑'] },
];

// 瀏覽器測試：用真實 repo 的 test/browser/smoke-test.mjs 跑 dir 這份被破壞的複本（HF_ROOT）。變紅的判斷＝它印出的
// 「✗」行（check／expectTransport 的失敗項）；腳本中途丟錯（例如等不到某個狀態逾時）就以「出錯於<最後一個步驟>」當名稱。
function runSmoke(dir) {
  const r = spawnSync(process.execPath, ['--no-warnings', 'test/browser/smoke-test.mjs', '--duration', '300'], { cwd: ROOT, env: { ...process.env, HF_ROOT: dir }, encoding: 'utf8', timeout: 420000 });
  const failed = [];
  let lastStep = '';
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('▶ ')) lastStep = line.slice(2).trim();
    const m = line.match(/^ {2}✗ (.+)$/);
    if (m) failed.push(m[1]);
  }
  // 腳本中途丟錯（例如等不到某個狀態逾時）：就算前面已經有別的「✗」行也要算，否則會被別的失敗遮住
  if (/測試腳本本身出錯/.test(`${r.stdout}${r.stderr}`)) failed.push(`（smoke 測試出錯於「${lastStep}」）`);
  else if (r.status !== 0 && !failed.length) failed.push(`（smoke 測試沒通過，但沒有印出失敗項，最後的步驟「${lastStep}」）`);
  if (r.error || r.status === null) failed.push(`（smoke 沒有正常結束：${r.error?.message || r.signal}）`);
  return failed;
}

function runSuite(dir, suite) {
  if (suite === 'smoke') return runSmoke(dir);
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
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });   // 連音色庫與姿勢模型一起複製：瀏覽器測試要用
  cpSync(join(ROOT, 'index.html'), join(tmp, 'index.html'));
  cpSync(join(ROOT, 'test/unit'), join(tmp, 'test/unit'), { recursive: true });
  for (const pkg of ['spessasynth_core', 'stb-vorbis']) cpSync(join(ROOT, 'node_modules', pkg), join(tmp, 'node_modules', pkg), { recursive: true });   // oracle 測試要用 spessasynth_core；複製而不是連結，rmSync 才不會碰到真的 node_modules
  // 換行統一成 LF：不管 checkout 時是 CRLF 還是 LF，多行的破壞字串都對得上
  const originals = new Map();
  const originalOf = (target) => {
    if (!originals.has(target)) originals.set(target, readFileSync(join(ROOT, target), 'utf8').replace(/\r\n/g, '\n'));
    return originals.get(target);
  };
  let bad = 0;
  for (const m of MUTATIONS.filter((x) => x.name.includes(ONLY) && !(SKIP_SMOKE && x.suites?.includes('smoke')) && !(ONLY_SMOKE && !x.suites?.includes('smoke')))) {
    const target = m.target || TARGET;
    let mutated = originalOf(target);
    for (const [find, replace] of m.edits) {
      const count = mutated.split(find).length - 1;
      if (count !== 1) { console.error(`✗ ${m.name}：要破壞的字串在原始碼裡出現 ${count} 次（要剛好 1 次），請更新這張表：\n  ${find}`); process.exit(2); }
      mutated = mutated.replace(find, () => replace);
    }
    writeFileSync(join(tmp, target), mutated);
    const failed = (m.suites || ['human-performer']).flatMap((suite) => runSuite(tmp, suite));
    writeFileSync(join(tmp, target), originalOf(target)); // 還原，下一個變異從乾淨的複本開始
    const caught = m.expect.filter((k) => failed.some((f) => f.includes(k)));
    if (!caught.length) bad++;
    console.log(`${caught.length ? '✓' : '✗'} ${m.name}\n    指定的測試變紅：${caught.length ? caught.join('、') : '沒有！'}；全部變紅的測試 ${failed.length} 個${failed.length ? `：${failed.slice(0, 4).map((f) => f.slice(0, 40)).join('、')}${failed.length > 4 ? '…' : ''}` : ''}`);
  }
  console.log(bad ? `\n有 ${bad} 個變異沒有被指定的測試抓到` : '\n每個變異都被指定的測試抓到');
  process.exitCode = bad ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
