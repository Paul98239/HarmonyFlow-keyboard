// ============================================================
//  synth.js — spessasynth 合成器：兩個合成器（電腦輔助聲部 synth／真人聲部 synthHuman）、humanGain
//  閘門＋音量凸顯。純引擎：不知道「分譜」「指派」是什麼，也不碰 DOM。
//
//  沒有 Sequencer：兩個合成器都只接收 humanPerformer.js（排程器）送來的個別
//  noteOn／noteOff／初始 program 設定，見 humanPerformer.js 檔頭說明。
//
//  兩軌（bus）模型：被指派聲部固定走 synthHuman，velocity 一律用樂譜原值；沒被自己的演奏者
//  揮過手的聲部就是靜音（見 humanPerformer.js 的說明）。沒被指派的聲部固定走 synth，跟指派
//  聲部共用同一個樂譜時鐘，同一刻的音同時發聲。humanGain 開啟時的目標值刻意設在 1.0 以上
//  （`HUMAN_EMPHASIS_GAIN`），讓使用者控制的聲部整體比電腦輔助的聲部更突出；電腦輔助那一軌
//  固定不掛額外 gain，是這個音量對比的基準，不會跟著被調小聲。
// ============================================================

import { HumanPerformer } from './humanPerformer.js';

/* ═══════════════════════════════════════════
   常數
   ═══════════════════════════════════════════ */
const SOUNDFONT_URL = './src/assets/GeneralUserGS.sf3';
const FETCH_TIMEOUT_MS = 15000;

// spessasynth_lib 直接從 CDN 匯入（不經 import map）：jsDelivr 的 +esm 端點把 CJS/UMD
// 套件轉成瀏覽器能 import 的 ESM。AudioWorklet 處理器跟套件入口在同一個套件目錄下，
// 直接拼路徑，不用 import.meta.resolve（+esm 端點不是真實目錄，相對路徑推不出正確位置）。
// 版本綁 @latest：不手動維護版本號，代價是 jsDelivr 對 @latest 有快取（瀏覽器端 7 天／
// 邊緣節點 12 小時），版本可能在快取到期後無預警改變。spessasynth_lib 自己對
// spessasynth_core（core 對 stb-vorbis）宣告的相依版本本來就是 latest，管不到那一層——
// 現在外層也主動浮動，兩層都是刻意選擇，不是意外落差。
const LIB_ESM_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@latest/+esm`;
const WORKLET_URL = `https://cdn.jsdelivr.net/npm/spessasynth_lib@latest/dist/spessasynth_processor.min.js`;

const CC_BANK_SELECT_MSB = 0;
const CC_BANK_SELECT_LSB = 32;
const CC_ALL_SOUND_OFF = 120;
const CC_RESET_ALL_CONTROLLERS = 121;
const CC_ALL_NOTES_OFF = 123;
const CHANNELS_PER_PORT = 16;
const DRUM_CHANNEL_OFFSET = 9;
// WorkletSynthesizer 預設只建 16 個 channel（1 個 MIDI port）；總譜聲部數超過這個數字時，
// 多出來的聲部會完全分不到輸出 channel、整段靜音（已用國旗歌 24 個旋律聲部實測重現）。
// spessasynth_lib 支援用 addNewChannel() 動態加開，對應 MIDI 多 port 的慣例——這裡固定
// 補到 4 個 port 份（64 個 channel），對真實總譜的複雜度留足夠的餘裕，不用依每首歌動態調整。
const TOTAL_CHANNELS = CHANNELS_PER_PORT * 4;

const GATE_RAMP_TC = 0.03;   // humanGain on/off 的 setTargetAtTime 時間常數（防 click）
const HUMAN_EMPHASIS_GAIN = 1.4; // humanGain 開啟時的目標值（電腦輔助軌固定是 1.0 基準，沒有額外
                                  // gain）：使用者控制的聲部整體調大聲，凸顯真人正在演奏的部分；
                                  // 實測後可能還要繼續調整。改這個值時，humanPerformer.js 的
                                  // AUTOPILOT_VOLUME_CC 要重算（該檔案的常數註解有完整公式）——
                                  // 兩個檔案不能互相 import 形成循環，只能靠這兩則註解手動同步。

/* ═══════════════════════════════════════════
   引擎狀態
   ═══════════════════════════════════════════ */
let audioCtx, synth, masterGain;
// 真人聲部：獨立的第二個合成器 synthHuman，經一顆 humanGain（總開關，播放器決定開關、這裡只負責
// 平滑切換）接到同一個 compressor。
let synthHuman, humanGain;
let isReady = false;
let initPromise = null;
let isSongLoaded = false;
let isProcessingPlay = false;
let lastGateTarget = -1;

// 拍級事件驅動排程器（humanPerformer.js）：驅動 synth（未指派聲部，反應式播放）與
// synthHuman（指派聲部，接手才發聲），由播放器的 12ms 排程 tick 呼叫 tick()。
export const humanPerformer = new HumanPerformer();

/* ═══════════════════════════════════════════
   MIDI 引擎核心
   ═══════════════════════════════════════════ */
// 不能讀 s.midiChannels.length 決定實際 channel 數：已查證 spessasynth_lib 原始碼
// （GitHub spessasus/spessasynth_lib 的 basic_synthesizer.ts）確認 addNewChannel() 會
// 同時（1）在主執行緒本地立刻 push 一筆到這個陣列，（2）worklet 端真的建好 channel 後，又
// 透過內部的 channelAdded 事件非同步回呼同一段程式碼、再 push 一次——每呼叫一次
// addNewChannel()，這個陣列的 length 最終會多算成兩筆，跟 worklet 端真正建立的 channel 數
// 對不上（實測：呼叫 48 次後 length 變成 112，不是 64；對只存在 64 個的 worklet 端送出
// channel ≥64 的 controllerChange 會讓 worklet 丟出 Uncaught TypeError，因為它自己的
// channel 陣列裡那個索引是 undefined）。兩個合成器一律固定補到 TOTAL_CHANNELS，這裡直接
// 回傳這個數字即可，不必也不能信任 s.midiChannels.length。
function channelCountOf(s) {
  return s ? TOTAL_CHANNELS : CHANNELS_PER_PORT;
}
function isDrumChannelIndex(ch) {
  return ch % CHANNELS_PER_PORT === DRUM_CHANNEL_OFFSET;
}

// 逾時只涵蓋「收到回應標頭」：`await fetch()` 在標頭到達時就 resolve、clearTimeout 也在那一刻
// 執行，所以 ms 不限制 body 要下載多久。soundfont 有 10.6MB，慢速連線花一兩分鐘是正常的；
// 不要把 `res.arrayBuffer()` 之類的 body 讀取搬進這個函式裡。
async function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal }); }
  finally { clearTimeout(t); }
}

export async function initEngine() {
  if (isReady) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { WorkletSynthesizer } = await import(/* @vite-ignore */ LIB_ESM_URL);
      if (!WorkletSynthesizer) throw new Error('缺少必要匯出');

      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await audioCtx.audioWorklet.addModule(WORKLET_URL);

      // 建構子第二個參數可傳 SynthConfig（oneOutput／audioNodeCreators／eventsEnabled），
      // 刻意不傳：兩個合成器都用標準 Web Audio API 節點（沒用 standardized-audio-context
      // 之類的包裝），也沒有監聽 spessasynth 內建的事件系統，全部吃函式庫預設值即可。
      synth = new WorkletSynthesizer(audioCtx);
      // 真人聲部的第二個合成器。走 humanGain（預設靜音，開啟時刻意比電腦輔助軌大聲，見
      // HUMAN_EMPHASIS_GAIN）→ 同一個 compressor，跟電腦輔助軌共用同一段動態處理。
      synthHuman = new WorkletSynthesizer(audioCtx);
      humanPerformer.setSynths(synth, synthHuman);
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 6;
      compressor.ratio.value = 2;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.1;
      masterGain = audioCtx.createGain();
      // 音量固定在 2.0，不提供面板拉桿——要調大小聲請直接調電腦本機的音量。
      masterGain.gain.value = 2.0;
      humanGain = audioCtx.createGain();
      humanGain.gain.value = 0; // 預設靜音，播放中且有指派才由 updateHumanGain 拉起來
      // 電腦輔助的那一軌不掛額外的 gain：它是「我的聲部」音量的比較基準，必須固定不動。
      synth.connect(compressor);
      synthHuman.connect(humanGain);
      humanGain.connect(compressor);
      compressor.connect(masterGain);
      masterGain.connect(audioCtx.destination);

      const res = await fetchWithTimeout(SOUNDFONT_URL);
      if (!res.ok) throw new Error(`SoundFont 失敗 HTTP ${res.status}`);
      const sfBuf = await res.arrayBuffer();
      // addSoundBank 可能把 ArrayBuffer transfer 進 worklet 而 detach 掉，所以先複製一份
      // 給第二個合成器，不能在第一次 add 之後才 slice。
      const sfBufHuman = sfBuf.slice(0);
      await synth.soundBankManager.addSoundBank(sfBuf, 'main');
      await synthHuman.soundBankManager.addSoundBank(sfBufHuman, 'main');
      if (synth.isReady) await synth.isReady;
      if (synthHuman.isReady) await synthHuman.isReady;

      // 兩個合成器都補到 TOTAL_CHANNELS，見上方常數註解＋channelCountOf() 的註解（呼叫過
      // addNewChannel() 之後，s.midiChannels.length 已查證不可信任，所以這裡固定呼叫
      // TOTAL_CHANNELS - CHANNELS_PER_PORT 次，不去讀那個 length）。刻意放在 soundBank 載入
      // 完成之後才呼叫：spessasynth_core 對每個動態新增的 channel 會自動先設成打擊 channel
      // 並立刻查一次預設音色（見 createMIDIChannel() 原始碼），這個查詢在 soundBank 還沒
      // 載入時一定查不到，會在 console 噴「No preset found for DRUM:0! Did you forget to
      // add a sound bank?」的警告——已查證 spessasynth_core 原始碼（GitHub
      // spessasus/spessasynth_core 的 src/synthesizer/processor.ts）確認這正是這串警告字面
      // 唯一的來源：找不到音色時呼叫的預設 onMissingPreset handler，只要 program change 當下
      // 還沒有任何 soundBank 就一定會觸發。這則警告本身不影響功能（每個聲部實際的音色仍然是
      // _applyInitialPatch() 之後另外送的 bank／program 決定），純粹是時機問題，把
      // addNewChannel() 挪到 soundBank 載入完成之後即可避開。
      for (const s of [synth, synthHuman]) {
        for (let i = CHANNELS_PER_PORT; i < TOTAL_CHANNELS; i++) s.addNewChannel();
      }

      isReady = true;
      return true;
    } catch (err) {
      console.error('❌ MIDI 引擎初始化失敗', err);
      // 這次失敗留下的 AudioContext 一定要收掉：按播放時會重試、每次重試都 new 一個新的，
      // 瀏覽器對同時存在的 AudioContext 數量有上限（Chrome 約 6 個）。
      try { await audioCtx?.close(); } catch (e) { /* 已經關掉或根本沒建起來 */ }
      audioCtx = undefined;
      synth = undefined;
      synthHuman = undefined;
      humanPerformer.setSynths(null, null);
      masterGain = undefined;
      humanGain = undefined;
      isReady = false;
      return false;
    } finally { initPromise = null; }
  })();
  return initPromise;
}

// 換歌／換指派前的清場：收掉排程器與殘響，bank／program 歸零（鼓組 channel 跳過：那裡的
// program 是鼓組編號，不是旋律音色）。
export function flushPreviousSong() {
  humanPerformer.stop();
  isSongLoaded = false;
  for (const s of [synth, synthHuman]) {
    if (!s) continue;
    for (let ch = 0; ch < channelCountOf(s); ch++) {
      if (isDrumChannelIndex(ch)) continue;
      try {
        s.controllerChange(ch, CC_BANK_SELECT_MSB, 0);
        s.controllerChange(ch, CC_BANK_SELECT_LSB, 0);
        s.controllerChange(ch, CC_ALL_SOUND_OFF, 0);
        s.controllerChange(ch, CC_RESET_ALL_CONTROLLERS, 0);
        s.controllerChange(ch, CC_ALL_NOTES_OFF, 0);
      } catch (e) {}
    }
  }
}

// 載入這首歌：確保引擎就緒、清掉上一首的殘留，再把樂譜交給排程器建立聲部（不會發出聲音，
// 播放要另外呼叫 play()）。assignments 是 [partId, 演奏者槽位][] 快照。
export async function load(score, assignments) {
  if (!isReady) {
    const ok = await initEngine();
    if (!ok) throw new Error('音源庫載入失敗');
  }
  flushPreviousSong();
  humanPerformer.load(score, assignments);
  isSongLoaded = true;
}

export async function play() {
  if (isProcessingPlay || !isSongLoaded) return;
  isProcessingPlay = true;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    humanPerformer.play();
  } finally { isProcessingPlay = false; }
}
// 從頭重播（重播鍵、播完後按 ▶）：跟 play() 一樣先確保 AudioContext 已恢復（使用者手勢），
// 再交給排程器重設並接著播——重設的內容見 humanPerformer.js 的 _resetPlayback()。
export async function restart() {
  if (isProcessingPlay || !isSongLoaded) return;
  isProcessingPlay = true;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    humanPerformer.restart();
  } finally { isProcessingPlay = false; }
}
export function pause() {
  humanPerformer.pause(); // 收掉所有正在響的音；每個聲部的播放進度都保留，下次播放從原處繼續
}
export function isLoaded() { return isSongLoaded; }
export function isPaused() { return !isSongLoaded || !humanPerformer.isPlaying(); }
export function isFinished() { return isSongLoaded && humanPerformer.isFinished(); }

// humanGain 是總開關兼音量凸顯：播放器算好「該不該開」（播放中、沒播完、真的有指派），這裡
// 只負責平滑地切上去（到 HUMAN_EMPHASIS_GAIN，比電腦輔助軌的固定基準大聲）／切下來（到 0）；
// target 去重，同一個值不重複送。
export function setHumanGate(on) {
  if (!audioCtx || !humanGain) return;
  const target = on ? HUMAN_EMPHASIS_GAIN : 0;
  if (target === lastGateTarget) return;
  lastGateTarget = target;
  try { humanGain.gain.setTargetAtTime(target, audioCtx.currentTime, GATE_RAMP_TC); } catch (e) {}
}
