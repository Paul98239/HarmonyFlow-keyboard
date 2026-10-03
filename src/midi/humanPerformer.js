// ============================================================
//  humanPerformer.js — 排程器（純邏輯，無 DOM／CDN）
//
//  整個合奏共用「一個樂譜時鐘 S」（單位：樂譜秒，跟音符的 startSeconds／endSeconds 同一個座標系）。
//  揮手不是讓某個聲部跳到某一拍，而是「放行下一拍」：放行邊界 B（`_frontierSec`）＝已放行那一拍的拍尾。
//  S 以速度倍率 r（跟著真人揮手的間隔估計，見下）往 B 前進，碰到 B 就停格等下一次揮手；所有聲部——指派的、
//  電腦輔助的、代打的——的 note-on／note-off 都只看 S，所以彼此在結構上不可能不同步，也不會有「某個聲部各自
//  落後」的問題。
//
//  放行（`_arbitrate()` 是唯一改寫共用拍位的地方，一個 tick 最多放行一拍）：
//    · 真人揮手：放行下一拍。多位演奏者同時揮手、一個人指派多個聲部（左右手）都只放行一拍；任何一次放行（真人或
//      代打）之後 `FOLLOW_WINDOW_BEATS` 拍內晚到的揮手，視為對這一拍的回應，不另外再推一拍。沒有任何還沒放行
//      的音的聲部（已經演奏完），它的揮手直接忽略。
//    · 代打補位：真人動作之後，電腦預期下一次揮手在「這一拍走完」（拍長 ÷ r）的時候，再寬限 τ
//      （`AUTOPILOT_GRACE_BEATS`）還沒人揮，就替「揮過手的聲部」放行這一拍——連有他音符的拍也放行，音量用代打的。
//      之後每一步等剛走進那一拍的真實時間（拍長 ÷ r）。倒數依 tick 的 dt 遞減，暫停期間不算停手；時鐘還在前奏時
//      不倒數。你完全停手＝音樂自己照估計速度播到曲末。
//  剛載入時放行邊界在起始拍的拍首（所有指派聲部最早的音所在的那一拍）：電腦輔助聲部先播前奏（還沒有取過樣，
//  r＝1＝原譜速度），時鐘離起始拍還有半拍以上時的揮手只標記「你在演奏」並取速度樣本（見 PRELUDE_ANTICIPATION_BEATS），
//  入場前半拍內的第一下揮手才放行起始拍。沒有人被指派（或沒有拍格線，SMPTE）時 B＝∞，整首照時間連續自動播放。
//
//  發聲：每個 tick 先收掉時鐘走過結尾的音，再放出「已放行、時鐘也走到」的音，最後再收一次（同一個 tick 內起音
//  又結束的短音）。從未被自己的演奏者揮過手的指派聲部維持靜音；揮過手的聲部，別人放行的拍它的音照樣發聲
//  （音量用代打的 CC7，見 `_tagVolumes()`）。
//
//  時鐘怎麼走（`_advanceClock()`）：
//    · 速度：S 每個 tick 前進 dt × r。r 是速度倍率＝演奏者的速度是原譜速度的幾倍：每次真人揮手，就用「上一次
//      揮手那一拍的樂譜長度 ÷ 兩次揮手之間真實過的秒數」取一次樣，在對數域指數平滑（`rateSample`／`smoothRate`），
//      離群的取樣先暫存（`_applySample`）；還沒取過樣＝1。代打放行與暫停不取樣；代打與終局沿用最後一次估計，不重設。
//      代打的等待時間與遲到窗都是真實秒數，用 拍長 ÷ r 換算。
//    · 追趕：揮手比時鐘早、S 落後最近放行那一拍的起點時，S 再乘上 1＋16×落後量／拍長 倍（上限 6 倍）——不跳、
//      不丟音，拍內剩下的快速音仍依序發聲。第一次放行不追趕：前奏照原速播完才輪到真人的第一個音。
//    · 停格：S 碰到 B 就停格。相連音（結尾到同聲部下一顆音的間隙 ≤ θ）在它的後繼音還沒放行時不收，免得停格
//      那一下出現檔案裡沒有的空白；停格超過閒置門檻就把所有還在響的音收掉，不會無限期掛著。
//    · 每個 tick 的 dt 上限 MAX_TICK_DT_SEC：分頁被節流後恢復時，不會一次吐出一大段。
//  所有指派聲部都沒有還沒放行的音時進入終局：B＝∞，尾奏照最後一次估計的速度播完，不需要多揮一下。
//
//  同音高重疊的音依發聲順序先進先出收音（跟官方合成器對 note-off 的解讀一致），每個 noteOn 都送出一個對應的
//  noteOff。velocity 一律用樂譜原值；不重播 CC／pitch-bend，每個 voice 的初始狀態（bank／program 與 CC7／10／91／93）只在
//  load() 時送一次，而且一定在該 channel 的第一個 noteOn 之前。
//
//  聲部單位：parser 把一個 MuseScore 樂器切成 part，part 底下有一個以上的 voice（一個譜表 × 一個樂器 channel，例如鋼琴兩行譜
//  是兩個 voice）。指派（演奏者槽位）以 part 為單位，part 的所有 voice 共用同一個槽位；排程、發聲、輸出 channel 以 voice
//  為單位。沒有 voices 的 part（手工組的舊資料形狀）自動視為單一 voice。
// ============================================================

import { buildBeatGrid } from './midiParser.js';

export const DEFAULT_PERFORMER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
});

const CHANNELS_PER_PORT = 16;
// synth.js 固定把兩個合成器都補到這個數字（見該檔案 channelCountOf() 的註解：呼叫
// addNewChannel() 之後，synth 物件自己回報的 midiChannels.length 已查證不可信任，兩個檔案
// 因此都改成直接用這個寫死的數字，不去讀 synth.midiChannels.length）。humanPerformer.js
// 不能反過來 import synth.js（見檔頭 import 方向，會形成循環），只能靠註解手動同步，跟
// AUTOPILOT_VOLUME_CC／HUMAN_EMPHASIS_GAIN 的既有做法一致。
const TOTAL_CHANNELS = CHANNELS_PER_PORT * 4;

/* ═══════════════════════════════════════════
   應用層常數——不是規格
   ═══════════════════════════════════════════ */
// 「時鐘停格多久就把還在響的音全部收掉」的門檻：max(IDLE_MS, 目前拍長 × IDLE_BEATS)，見 _idleThresholdSec()。相連音
// 撐住與長音只是不在停格那一下提早收，不能無限期響著；有了代打補位，第一下揮手之後停格最多只有一小段，這條只擋
// 「第一下揮手之前」（前奏結尾）的停格。IDLE_MS 吸收手勢偵測延遲，IDLE_BEATS 讓慢曲的前奏結尾不被太快收掉。
const IDLE_MS = 800;
const IDLE_BEATS = 1.5;
// 多人合併窗／遲到揮手歸屬：某位演奏者的揮手落在「任何一次放行（真人或代打）」之後 FOLLOW_WINDOW_BEATS 拍（F，換成
// 真實時間＝拍長 ÷ r × F）內、而且他自己這一拍還沒動作過，視為對這一拍的回應（跟上同一拍／遲到），不另外再推一拍——
// 多人幾乎同時揮手是常態，各推一拍會讓合奏從第一下起就比最慢的人多走一拍；代打放行之後你才揮手，推了就是同一拍被算兩次
// （棘輪）。單人自己連續快揮不受影響（他永遠是這一拍的第一個動作）。AUTOPILOT_GRACE_BEATS＋F＝0.5 拍：晚過頭就是在揮
// 下一拍（取最近的一拍）。
const FOLLOW_WINDOW_BEATS = 0.3;
// 代打補位：真人揮手之後，電腦預期下一次揮手在「這一拍走完」的時候，再寬限 AUTOPILOT_GRACE_BEATS 拍（τ）還沒揮就替他
// 放行這一拍；還沒有速度取樣（只揮過一次手）時改寬限 FIRST_SAMPLE_GRACE_BEATS 拍（原譜速度）。
const AUTOPILOT_GRACE_BEATS = 0.2;
const FIRST_SAMPLE_GRACE_BEATS = 2;
// 前奏提前量：時鐘還沒走進入場拍之前 PRELUDE_ANTICIPATION_BEATS 拍（樂譜時間）時的揮手，視為你在前奏的空白裡打拍子：
// 不放行拍、不動邊界、不追趕，只標記「你在演奏」並取速度樣本。人通常比拍點早一點揮，所以入場前半拍內的揮手才算
// 對入場拍的第一下（預先放行）；再早的揮手若也算，就會把你數的前奏拍當成入場拍之後的拍，邊界被推到好幾拍之後，
// 時鐘用追趕速度把前奏衝過去。
const PRELUDE_ANTICIPATION_BEATS = 0.5;
// 相連音的「小間隙」門檻 θ ＝ ticksPerQuarter / LEGATO_GAP_DIVISOR（480 tpq 時 30 tick）：音符結尾到同一個聲部
// 下一個起音點的間隙 ≤ θ 才算相連的音。MuseScore 把相連音符寫成「記譜長度 − 1 tick」（間隙固定 1 tick），真正的
// 最短休止（三十二分休止）≥ 60 tick，θ 落在兩者中間的空檔；用 tick 不用秒，跟速度無關。
const LEGATO_GAP_DIVISOR = 16;
// 時鐘追趕：S 落後最近放行那一拍的起點 L 秒時，前進速度（r 之外）再乘上 1 + CATCHUP_GAIN × L／拍長 倍，最多
// CATCHUP_MAX_SPEED 倍。
const CATCHUP_GAIN = 16;
const CATCHUP_MAX_SPEED = 6;
// 每個 tick 的時間步長上限：分頁被瀏覽器節流（背景分頁的計時器可能隔好幾秒才醒來）後恢復時，時鐘最多只前進這麼多，
// 不會一次把空窗期的音全部放出來。
const MAX_TICK_DT_SEC = 0.1;
// 速度估計（見 rateSample／smoothRate）：RATE_ALPHA 是新取樣占的權重。曲庫模擬量測：α 在 0.2～0.5 之間揮手→發聲的
// 延遲幾乎沒差，α 愈大每次取樣的雜訊愈直接進時鐘、被追趕壓縮的音愈多（α＝1 時多一倍以上），取 0.35。取樣超出
// [RATE_MIN, RATE_MAX]（原譜速度的 1/4～4 倍）視為停頓或重複偵測，不採樣。RATE_OUTLIER：取樣比目前估計快或慢超過
// 這個比例（±40％）是離群值，先暫存，下一個取樣同向且幅度一致才套用（真的變速），對不上就丟掉（同一個動作被偵測成兩次）。
const RATE_ALPHA = 0.35;
const RATE_MIN = 0.25;
const RATE_MAX = 4;
const RATE_OUTLIER = 0.4;
// 浮點數比較的容差：S 是一路加 dt 累積出來的，跟 startSeconds／endSeconds 比大小時不能要求逐位元相等。
const EPS = 1e-9;
// 代打時這個 voice 的 CC7（Channel Volume）＝它的原音量（baseVolume＝檔案 init 的 CC7，沒有就是 GM 預設 100）乘上這個比例：
// 目標是校正到約等於電腦輔助聲部的音量基準（它們沒有掛 synth.js 的 HUMAN_EMPHASIS_GAIN，等於基準 1.0），真正的「凸顯」
// 完全交給真人揮手時的 HUMAN_EMPHASIS_GAIN，代打本身不做額外凸顯或壓低。CC7 對音量不是線性關係——已查證 GM2 官方
// 規格 §3.3.6（docs/midi-official-doc/General_MIDI_Level_2_07-2-6_1.2a.txt）明講 Channel Volume／Expression 這組音量
// 「數值的平方才正比於音量」，這個專案實際用的 spessasynth_core 原始碼（GitHub spessasus/spessasynth_core 的
// src/midi/midi_tools/midi_utils.ts）處理 Master Volume 時也是同一套平方關係（註解明講「it corresponds to CC volume,
// so volume is squared」）。反推公式：HUMAN_EMPHASIS_GAIN × (比例)² = 1.0 → 比例 = √(1/1.4) ≈ 0.845，原音量 100 時
// 就是 85（改版前寫死的 AUTOPILOT_VOLUME_CC）。這個數字只用來對照 synth.js 的 HUMAN_EMPHASIS_GAIN，改動任一邊都要重算
// 另一邊——兩個檔案之間無法用 import 連動（humanPerformer.js 不能反過來 import synth.js，會形成循環），跟這個專案裡
// vision.js 的 EMIT_HEARTBEAT_MS 與 midiPlayer.js 的 GATE_STALE_MS 互相對照的既有寫法一致，只能靠註解手動同步。只調 CC7
// （音量），不動 note-on velocity（觸鍵力度）——這是兩種不同的 MIDI 概念，velocity 只在 note-on 當下決定一次，CC7 是
// 疊加在已經送出的音符之上的獨立音量調整。
const AUTOPILOT_VOLUME_RATIO = 0.845;
// GM 預設的混音值（CC121 不會重設音量、聲像、Program，見 GML-v1 §3.2.5.2；channel 又是跨曲重複使用，所以沒有 init 的 voice
// 也要明確送一次，避免沿用到別的曲子在同一個 channel 上留下的設定）。
const GM_DEFAULT_VOLUME = 100, GM_DEFAULT_PAN = 64, GM_DEFAULT_REVERB = 0, GM_DEFAULT_CHORUS = 0;

/* ═══════════════════════════════════════════
   速度估計（純函式）：速度倍率 r＝演奏者的速度是原譜速度的幾倍（1＝原譜速度，2＝快一倍）
   ═══════════════════════════════════════════ */

/**
 * 一次取樣：兩次真人揮手之間，樂譜走了幾秒 ÷ 真實過了幾秒。落在 [RATE_MIN, RATE_MAX] 之外回傳 null：
 * 太慢＝停頓（走開、暫停後回來），太快＝同一個動作被偵測成兩次，都不是演奏者的速度。
 */
export function rateSample(scoreSec, realSec) {
  if (!(realSec > 0)) return null;  // 間隔是 0、負的或 NaN 就算不出速度（寫成 !(x > 0) 才會連 NaN 一起擋掉）
  const ratio = scoreSec / realSec;
  return ratio >= RATE_MIN && ratio <= RATE_MAX ? ratio : null;
}

/**
 * 在對數域做指數平滑：r' = r^(1−α) · sample^α，也就是以 (1−α):α 加權的幾何平均。速度倍率是乘法的量，
 * 「快兩倍」與「慢一半」應該互為鏡像，所以平均要在對數域做（算術平均會偏高：2 與 0.5 的算術平均是 1.25，
 * 幾何平均才是 1）；一次離群的取樣最多只把估計拉動 α 的比例。
 */
export function smoothRate(rate, sample) {
  return rate ** (1 - RATE_ALPHA) * sample ** RATE_ALPHA; // ** 是指數運算子（同 Math.pow）
}

/* ═══════════════════════════════════════════
   輸出 channel 分配
   ═══════════════════════════════════════════ */

// 這個合成器上可用的旋律輸出 channel＝跳過每個 port 的打擊槽（ch % 16 === drumChannel）。
function melodicChannelsFor(synth, drumChannel) {
  const total = synth ? TOTAL_CHANNELS : CHANNELS_PER_PORT;
  const out = [];
  for (let ch = 0; ch < total; ch++) {
    if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);
  }
  return out;
}

// 這個合成器上的打擊輸出 channel＝每個 port 的打擊槽（9／25／41／57）：合成器只有一個 port 時只有 drumChannel 一個。
function drumChannelsFor(synth, drumChannel) {
  const ports = synth ? TOTAL_CHANNELS / CHANNELS_PER_PORT : 1;
  return Array.from({ length: ports }, (_, p) => p * CHANNELS_PER_PORT + drumChannel);
}

// 幫一組 voice 各自分配一個輸出 channel，避免兩個原本共用同一個原始 channel 的 voice 打架。旋律 voice 依序拿
// melodicChannels 裡的號碼；打擊 voice 依「不同鼓組 program」各佔一個打擊槽（同一個鼓組共用），鼓組種類超過打擊槽數
// 就排不進去；排不進去的 voice 回報給呼叫端，不出聲。
function allocateChannels(voices, melodicChannels, drumChannels) {
  const byVoiceId = new Map();
  const unplaced = [];
  const kitChannel = new Map(); // 鼓組 program → 輸出 channel
  let next = 0;
  for (const v of voices) {
    // percussionKit 已經是 GM2 Bank Select（CC0/32）判定過的結果：channel 9 若明確用
    // Bank 79H(121) 切成旋律通道，這裡就不會被誤送進打擊 channel（見 midiParser.js 的
    // collectParts() 說明）。
    if (v.percussionKit) {
      if (!kitChannel.has(v.program) && kitChannel.size < drumChannels.length) kitChannel.set(v.program, drumChannels[kitChannel.size]);
      if (kitChannel.has(v.program)) byVoiceId.set(v.id, kitChannel.get(v.program));
      else unplaced.push(v.id);
      continue;
    }
    if (next < melodicChannels.length) byVoiceId.set(v.id, melodicChannels[next++]);
    else unplaced.push(v.id);
  }
  return { byVoiceId, unplaced };
}

/* ═══════════════════════════════════════════
   聲部（voice）建構
   ═══════════════════════════════════════════ */

// 一個 part 底下的 voice 規格：新資料形狀直接用 part.voices；沒有 voices 的 part（手工組的舊資料形狀）視為單一 voice，
// id 沿用 part.id。
function voiceSpecsOf(part) {
  if (part.voices) return part.voices.map((v) => ({ ...v, partId: part.id }));
  return [{ id: part.id, partId: part.id, program: part.program ?? 0, bank: part.bank ?? { msb: 0, lsb: 0 }, percussionKit: !!part.percussionKit, init: null }];
}

function makeVoice(spec, slot, notes, kind, channel) {
  const baseVolume = spec.init?.volume ?? GM_DEFAULT_VOLUME;
  return {
    id: spec.id, partId: spec.partId, slot, kind, channel, notes,
    program: spec.program ?? 0, bank: spec.bank, init: spec.init ?? null, percussionKit: !!spec.percussionKit,
    baseVolume,             // 真人音量＝檔案的原音量（init 的 CC7，沒有就 100）
    autopilotVolume: Math.round(baseVolume * AUTOPILOT_VOLUME_RATIO), // 代打音量，見 AUTOPILOT_VOLUME_RATIO
    cursor: 0,              // 下一個還沒處理（發聲或靜音略過）的音符在 notes 裡的位置
    sounding: new Map(),    // 音高 → [{ endSec, legatoTo }]：正在響的音；同音高重疊時依發聲順序排隊，先進先出收音
    triggered: false,       // 指派聲部的演奏者是否真實揮過手；沒揮過就維持靜音，見 _emitNotes
    lastSeq: null,          // 上次觀察到的手勢 triggerSeq，null＝還沒對過基準
    lastSlot: undefined,    // 上次觀察到的指派槽位，與現在不同就重新對齊基準（見 _arbitrate）
    isAutopilot: false,     // 目前用代打音量（CC7 調低）還是真人音量，驅動 _syncVolume() 的 CC7 切換
    _lastSentCc7: baseVolume, // 上次送出的 CC7 值，避免重送同一個值
  };
}

// 指派聲部只配 humanSynth 的 channel、未指派聲部只配 assistSynth 的 channel——指派聲部沒被演奏者揮過手就是
// 靜音，不需要幫它在 assistSynth 上保留一條代打用的 channel。兩個池子各自獨立，配額用完的聲部回報在 unplaced，
// 這一輪不會出聲。
function buildVoices(score, assignments, assistSynth, humanSynth, cfg) {
  const voices = new Map(); // voiceId → voice
  const unplaced = [];

  const notesByVoice = new Map(); // score.notes 已依 startTick 排序，照順序分組即可；舊資料形狀的音符沒有 voiceId，用 partId
  for (const n of score.notes) {
    const key = n.voiceId ?? n.partId;
    let list = notesByVoice.get(key);
    if (!list) notesByVoice.set(key, (list = []));
    list.push(n);
  }

  const assignedSpecs = [], assistSpecs = [];
  for (const part of score.parts) {
    for (const spec of voiceSpecsOf(part)) (assignments.has(part.id) ? assignedSpecs : assistSpecs).push(spec);
  }

  const { byVoiceId: humanCh, unplaced: u1 } =
    allocateChannels(assignedSpecs, melodicChannelsFor(humanSynth, cfg.drumChannel), drumChannelsFor(humanSynth, cfg.drumChannel));
  const { byVoiceId: assistCh, unplaced: u2 } =
    allocateChannels(assistSpecs, melodicChannelsFor(assistSynth, cfg.drumChannel), drumChannelsFor(assistSynth, cfg.drumChannel));
  unplaced.push(...u1, ...u2);

  for (const spec of assignedSpecs) {
    const channel = humanCh.get(spec.id);
    if (channel === undefined) continue;
    voices.set(spec.id, makeVoice(spec, assignments.get(spec.partId), notesByVoice.get(spec.id) || [], 'human', channel));
  }
  for (const spec of assistSpecs) {
    const channel = assistCh.get(spec.id);
    if (channel === undefined) continue;
    voices.set(spec.id, makeVoice(spec, null, notesByVoice.get(spec.id) || [], 'assist', channel));
  }
  return { voices, unplaced };
}

/* ═══════════════════════════════════════════
   HumanPerformer
   ═══════════════════════════════════════════ */
export class HumanPerformer {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_PERFORMER_CONFIG, ...config };
    this.assistSynth = null;   // 電腦輔助聲部的合成器（未指派聲部）
    this.humanSynth = null;    // 真人聲部合成器（被指派聲部）
    this._score = null;
    this._beats = [];          // buildBeatGrid() 的結果；空陣列＝無法算拍（SMPTE division）
    this._voices = new Map();  // voiceId → voice
    this._clockSec = 0;        // 樂譜時鐘 S
    this._frontierSec = 0;     // 放行邊界 B：音符 startSeconds < B 才算被放行；Infinity＝全部放行
    this._beatIndex = 0;       // 共用拍位：最近放行的那一拍（還沒放行過任何一拍時＝起始拍）
    this._startBeatIndex = 0;  // load() 算出的起始拍位，stop() 要退回這裡
    this._released = false;    // 是否已經放行過任何一拍（第一次放行放的是起始拍本身，不是下一拍）
    this._catchUpToSec = 0;    // 追趕目標：最近放行那一拍的起點
    this._stallSec = 0;        // 時鐘停在放行邊界已經多久
    this._autopilotLeftSec = null; // 合奏層級的代打倒數（秒，依 tick 的 dt 遞減）；null＝沒在倒數
    this._lastReleaseMs = null;    // 最近一次放行一拍（真人或代打）的時刻：合併窗／遲到揮手歸屬從這裡算起
    this._beatHasWave = false;     // 目前這一拍有沒有真人揮過手（代打放行的拍還沒有，晚到的第一下揮手才是這一拍的取樣）
    this._entrySec = 0;            // 第一個指派聲部入場的樂譜秒數（起始拍的起點）；時鐘還在前奏（< 它）時代打不倒數
    this._playbackRate = 1;        // 速度倍率 r：演奏者的速度是原譜速度的幾倍（還沒取過樣＝1）；時鐘 S 照這個速度前進
    this._sampled = false;         // 是否已經取過有效的速度取樣（第二下揮手之後才有）；沒有就不信任 r，代打的寬限放寬
    this._pendingRate = null;      // 暫存的離群速度取樣（見 RATE_OUTLIER）；下一個取樣對得上才套用
    this._lastWave = null;         // 最近一次真人揮手的 { ms 揮手時刻, len 那一拍的樂譜長度 }；取樣用，暫停會清掉
    this._actedBeat = new Map();   // 槽位 → 這位演奏者最近一次動作（放行或跟上）所在的拍
    this.unplacedVoiceIds = []; // 輸出 channel 排不進去（旋律 voice 超過 60 個、鼓組超過 4 種）的 voice，這一輪不出聲
    this._playing = false;
    this._lastTickMs = null;   // null＝下一次 tick() 不推進時鐘，只記錄基準
  }

  setSynths(assistSynth, humanSynth) {
    this.assistSynth = assistSynth;
    this.humanSynth = humanSynth;
  }

  _synthOf(voice) {
    return voice.kind === 'human' ? this.humanSynth : this.assistSynth;
  }

  /**
   * 載入這首歌：建立聲部、套初始音色，準備好共用拍格線與起始拍位。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（每顆音會被標上 beatIndex／
   *        legatoTo，同一份譜重新載入的結果相同；其餘不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._beats = score ? buildBeatGrid(score) : [];
    this._voices = new Map();
    this.unplacedVoiceIds = [];
    if (score) this._createVoices(score, assignments);
    // 沒有樂譜時 voices 是空的：起始拍 0、放行邊界 Infinity，tick() 空轉不會碰到拍格線。
    this._startBeatIndex = this._computeStartBeatIndex();
    this._beatIndex = this._startBeatIndex;
    this._entrySec = this._beats.length ? this._beats[this._startBeatIndex].startSeconds : 0;
    this._frontierSec = this._initialFrontierSec();
  }

  // 建立聲部、套初始音色、標記每顆音的拍位與相連後繼音。
  _createVoices(score, assignments) {
    // 沒有拍格線（SMPTE division，A5）：指派聲部的推進全靠拍位，算不出來就退回整首自動播放——忽略指派。
    const assignMap = !this._beats.length ? new Map()
      : assignments instanceof Map ? assignments : new Map(assignments || []);

    const { voices, unplaced } = buildVoices(score, assignMap, this.assistSynth, this.humanSynth, this.cfg);
    this._voices = voices;
    this.unplacedVoiceIds = unplaced;

    for (const voice of this._voices.values()) this._applyInitialPatch(this._synthOf(voice), voice);

    this._tagNotesWithBeat();
    this._tagLegato();
  }

  // 放行邊界的初值（load() 與 _resetPlayback() 共用）。有指派聲部的音符：邊界停在起始拍的拍首——電腦輔助聲部
  // 先照原速播到第一個真人入場點，之後由揮手放行。完全沒有人被指派、或指派了但完全沒有音符時，永遠不會有揮手，
  // 必須在這裡顯式退回「整份照時間連續自動播放」（Infinity），不能指望一般邏輯自動長出這個特例（沒有拍格線時
  // load() 已經忽略指派，也會走到這裡）。
  _initialFrontierSec() {
    const hasHumanNotes = [...this._voices.values()].some((v) => v.kind === 'human' && v.notes.length > 0);
    return hasHumanNotes ? this._beats[this._beatIndex].startSeconds : Infinity;
  }

  // 所有指派聲部裡，最早出現音符的那一拍——拍位的起點，也是 stop() 之後要退回的原點。
  // 沒有指派聲部、或指派了但完全沒有音符時回傳 0（此時放行邊界會是 Infinity，這個值不會被實際用到，
  // 只是給個確定的初始狀態）。
  _computeStartBeatIndex() {
    let first = Infinity;
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human' || !voice.notes.length) continue;
      if (voice.notes[0].beatIndex < first) first = voice.notes[0].beatIndex;
    }
    return Number.isFinite(first) ? first : 0;
  }

  // 用只前進的游標把每個聲部的 notes（已依 startTick 排序）逐顆標上 beatIndex。
  _tagNotesWithBeat() {
    if (!this._beats.length) {
      for (const voice of this._voices.values()) {
        for (const n of voice.notes) n.beatIndex = 0;
      }
      return;
    }
    for (const voice of this._voices.values()) {
      let bc = 0;
      for (const n of voice.notes) {
        while (bc + 1 < this._beats.length && this._beats[bc + 1].startTick <= n.startTick) bc++;
        n.beatIndex = bc;
      }
    }
  }

  // 標記每顆音的相連後繼音（見檔頭「停格」）：音符結尾到同一個聲部下一個起音點的間隙 ≤ θ（LEGATO_GAP_DIVISOR）
  // 就記下那顆後繼音在聲部 notes 裡的位置（legatoTo），否則 -1。沒有 tick 換算（SMPTE division）一律 -1。
  _tagLegato() {
    const tpq = this._score.ticksPerQuarter;
    const theta = tpq ? Math.round(tpq / LEGATO_GAP_DIVISOR) : -1;
    for (const voice of this._voices.values()) {
      const starts = voice.notes.map((n) => n.startTick); // notes 已依 startTick 排序
      for (const n of voice.notes) {
        let lo = 0, hi = starts.length;                   // 第一個 startTick >= n.endTick 的位置
        while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < n.endTick) lo = mid + 1; else hi = mid; }
        n.legatoTo = theta >= 0 && lo < starts.length && starts[lo] - n.endTick <= theta ? lo : -1;
      }
    }
  }

  // voice 的初始狀態：bank／program，再加上混音 CC7／10／91／93（來源 voice.init＝檔案 tick 0 的值；沒有就明確送 GM 預設，
  // 見 GM_DEFAULT_*）。load() 時送一次，比該 channel 的任何 noteOn 都早。
  _applyInitialPatch(synth, voice) {
    if (!synth) return;
    const { channel, bank, init } = voice;
    try {
      synth.controllerChange(channel, 0, bank?.msb || 0);
      synth.controllerChange(channel, 32, bank?.lsb || 0);
      synth.programChange(channel, voice.program || 0);
      synth.controllerChange(channel, 7, voice.baseVolume);
      synth.controllerChange(channel, 10, init?.pan ?? GM_DEFAULT_PAN);
      synth.controllerChange(channel, 91, init?.reverb ?? GM_DEFAULT_REVERB);
      synth.controllerChange(channel, 93, init?.chorus ?? GM_DEFAULT_CHORUS);
    } catch (err) { /* 初始音色設定失敗不致命 */ }
  }

  play() {
    this._playing = true;
    // 避免暫停期間累積的時間被當成一次巨大的 dt：把時鐘瞬間推老遠，也會把代打倒數（每個 tick 依 dt 遞減，
    // 見 _arbitrate）一口氣扣光、一恢復播放就誤判成早該代打。第一個 tick 的 dt 是 0。
    this._lastTickMs = null;
  }

  // 暫停：收掉還在響的音，時鐘與拍位都保留（下次播放從原處繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    this._lastWave = null; // 暫停的時間不是揮手的間隔：恢復後的第一下揮手不跟暫停前的揮手配成一次取樣
    this._pendingRate = null;
    this.silence();
  }

  silence() {
    this._noteOffAll();
    for (const voice of this._voices.values()) {
      try { this._synthOf(voice)?.controllerChange(voice.channel, 123, 0); } catch (err) {} // CC123 All Notes Off 當保險
    }
  }

  // 把所有還在響的音收掉：每個 noteOn 各送一個 noteOff。
  _noteOffAll() {
    for (const voice of this._voices.values()) {
      const synth = this._synthOf(voice);
      for (const [pitch, queue] of voice.sounding) {
        for (let i = 0; i < queue.length; i++) {
          try { synth?.noteOff(voice.channel, pitch); } catch (err) {}
        }
      }
      voice.sounding.clear();
    }
  }

  // 停止／換歌前的清場：收音＋整個播放狀態退回剛載入的樣子。
  stop() {
    this.pause();
    this._resetPlayback();
  }

  // 從頭重播：收音、退回剛載入的樣子，再接著播放（跟 stop() 共用 _resetPlayback()，只差最後一步）。
  restart() {
    this.pause();
    this._resetPlayback();
    this.play();
  }

  // 把播放狀態整個退回「剛 load() 完」的樣子：stop() 與 restart() 共用這一個函式。之後任何新增的
  // 狀態欄位都要在這裡重設（test/unit/human-performer.test.mjs 有一個整體快照比對，忘了重設會
  // 直接失敗）。呼叫端負責先收音（pause()）與決定要不要接著播放。
  _resetPlayback() {
    for (const voice of this._voices.values()) {
      voice.cursor = 0;
      voice.triggered = false;          // 代打要等真人重新揮手過才會啟動
      voice.lastSeq = null;
      voice.lastSlot = undefined;
      voice.isAutopilot = false;
      // CC7 要明確送回原音量：代打留下的調低值還在合成器上，而 _lastSentCc7 的去重會擋掉之後的重送。
      voice._lastSentCc7 = voice.baseVolume;
      try { this._synthOf(voice)?.controllerChange(voice.channel, 7, voice.baseVolume); } catch (err) {}
    }
    this._clockSec = 0;
    this._beatIndex = this._startBeatIndex;
    this._released = false;
    this._frontierSec = this._initialFrontierSec();
    this._catchUpToSec = 0;
    this._stallSec = 0;
    this._autopilotLeftSec = null;
    this._lastReleaseMs = null;
    this._beatHasWave = false;
    this._playbackRate = 1;
    this._sampled = false;
    this._pendingRate = null;
    this._lastWave = null;
    this._actedBeat = new Map();
    this._lastTickMs = null;
  }

  isPlaying() { return this._playing; }

  isFinished() {
    if (!this._score) return false;
    for (const voice of this._voices.values()) {
      if (voice.cursor < voice.notes.length || voice.sounding.size > 0) return false;
    }
    return true;
  }

  /**
   * 目前播放到「樂譜原始時間」的第幾秒（跟 note 的 startSeconds／endSeconds 同一個座標系），也就是樂譜時鐘 S：
   * 放行的拍內連續前進、停格時停住。唯讀、無副作用。
   * @returns {number} 秒，夾在 [0, score.durationSeconds]；沒有樂譜或沒有聲部時 0
   */
  getPositionSeconds() {
    if (!this._score || this._voices.size === 0) return 0;
    const total = this._score.durationSeconds;
    return total > 0 ? Math.min(this._clockSec, total) : this._clockSec; // 終局後 B＝∞，時鐘會一直往後走，夾住不超過總長
  }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫。
   * @param {number} nowMs  performance.now()
   * @param {(partId:string) => {present:boolean, triggerSeq:number, slot:number|null}} getGestureFor
   *        該聲部指派 ID 目前的手勢狀態：present＝在場、triggerSeq＝拋物線觸發的累加計數、
   *        slot＝目前指派到的演奏者槽位（沒指派是 null）。
   */
  tick(nowMs, getGestureFor) {
    if (!this._playing) return;
    const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_SEC, (nowMs - this._lastTickMs) / 1000);
    this._lastTickMs = nowMs;

    this._arbitrate(nowMs, dt, getGestureFor);
    this._checkFinale();
    this._advanceClock(dt);
    this._emitNotes();
  }

  // ── 單一裁決點 ──
  // 一個 tick 裡「共用拍位要不要動」只在這裡決定，而且最多放行一拍——跟有幾個聲部、幾位演奏者同時動作、聲部被處理的
  // 先後都無關。揮手依演奏者槽位分組（一個人指派多個聲部＝一次意圖，不是每個聲部各推一拍）：任何一位不是「跟上
  // 同一拍」就放行下一拍；有真人揮手的 tick 不看代打。沒有任何揮手的 tick 才輪到代打：合奏層級只有一個倒數
  // （_autopilotLeftSec），任何一次真人揮手都讓它重新開始，所以只要還有人在揮手，誰都不會被代打。
  _arbitrate(nowMs, dt, getGestureFor) {
    // 時鐘還在前奏（沒走進第一個指派聲部的入場拍）時代打不倒數：提早揮的第一下只是預先放行起始拍，前奏照樣播完，
    // 不能在前奏還沒播完就開始替你走拍（走進入場拍之後才給你 FIRST_SAMPLE_GRACE_BEATS 拍的寬限）。
    if (this._autopilotLeftSec != null && this._clockSec >= this._entrySec - EPS) this._autopilotLeftSec -= dt;

    const waveSlots = new Set(); // 這個 tick 有新揮手的演奏者槽位
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human') continue;
      const gesture = getGestureFor(voice.partId);

      if (voice.lastSeq === null) {
        // 首次觀察：只記基準，不算揮手。
        voice.lastSeq = gesture.triggerSeq;
        voice.lastSlot = gesture.slot;
        continue;
      }
      if (gesture.slot !== voice.lastSlot) {
        // 指派的槽位變了（改指派到別的演奏者、或人數變小被動清掉指派）：別的槽位的觸發計數是另一條獨立的
        // 累加序列，直接拿來比會被誤判成一次憑空冒出來的揮手，讓共用拍位無端前進一步。重新對齊基準，這一刻
        // 不算揮手；triggered 不動——這個聲部先前有沒有被真實揮過手，跟指派給哪個槽位是兩件事。
        voice.lastSlot = gesture.slot;
        voice.lastSeq = gesture.triggerSeq;
        continue;
      }
      if (gesture.triggerSeq === voice.lastSeq) continue;
      voice.lastSeq = gesture.triggerSeq;

      // 這個聲部已經沒有任何還沒放行的音：沒有東西可以放行，揮手不推進任何東西。不能讓它推進共用拍位（會把別人
      // 的音路過），也不能讓它觸發終局（會把別人剩下的音強制播完）。
      if (!this._hasUnreleasedNote(voice)) continue;
      voice.triggered = true;
      waveSlots.add(gesture.slot);
    }

    if (waveSlots.size) {
      if (this._inPrelude()) {
        // 前奏的空白裡打拍子：不放行任何拍（見 PRELUDE_ANTICIPATION_BEATS）。voice.triggered 上面已經標過；取樣用「時鐘
        // 現在所在那一拍」的長度（前奏可能跟入場拍不同速），讓前奏之後的速度跟你打的拍子一致。不武裝代打：
        // 沒有第一下真正的放行之前，電腦不替你走拍。
        this._observeWave(nowMs, this._beatLengthAtClockSec());
        return;
      }
      let release = false;
      for (const slot of waveSlots) if (!this._followsCurrentBeat(slot, nowMs)) release = true;
      if (release) {
        this._releaseNextBeat();
        this._lastReleaseMs = nowMs;
        this._beatHasWave = true;
        this._observeWave(nowMs);
      } else if (!this._beatHasWave) {
        // 這一拍是電腦放行的，你在窗內才揮第一下：算你對這一拍的回應（不多推一拍），拿來校正速度。
        this._beatHasWave = true;
        this._observeWave(nowMs);
      }
      for (const slot of waveSlots) this._actedBeat.set(slot, this._beatIndex);
      this._tagVolumes(false);
      this._armAutopilot(false);
      return;
    }

    if (this._autopilotLeftSec != null && this._autopilotLeftSec <= 0) {
      if (this._frontierSec === Infinity) {
        this._autopilotLeftSec = null; // 已經沒有東西可放行（終局或拍格線走完）
      } else {
        // 電腦替沒揮手的人放行這一拍：所有聲部（含揮過手的指派聲部這拍的音符）照樂譜發聲，音量用代打的。
        this._releaseNextBeat();
        this._lastReleaseMs = nowMs; // 窗從任何一次放行算起：你在窗內才揮的手是對這一拍的回應，不是下一拍
        this._beatHasWave = false;
        this._tagVolumes(true);
        this._armAutopilot(true);
      }
    }
  }

  // 重新武裝合奏層級的代打倒數。真人動作之後：預期下一次揮手在「這一拍走完」的時候（拍長 ÷ r），再寬限 τ
  // （AUTOPILOT_GRACE_BEATS 拍）才由電腦替他放行；還沒有速度取樣（只揮過一次手）時 r 還不可信，寬限放寬成
  // FIRST_SAMPLE_GRACE_BEATS 拍（原譜速度）。代打放行之後：下一步就是這一拍走完的時候，相位沿用最後一次真人揮手
  // 的節拍，不會每拍多晚 τ。
  _armAutopilot(byAutopilot) {
    const beatSec = this._beatLengthSec();
    if (byAutopilot) this._autopilotLeftSec = beatSec / this._playbackRate;
    else if (!this._sampled) this._autopilotLeftSec = beatSec * FIRST_SAMPLE_GRACE_BEATS;
    else this._autopilotLeftSec = (beatSec / this._playbackRate) * (1 + AUTOPILOT_GRACE_BEATS);
  }

  // 記下這次真人揮手（對目前這一拍的回應），並跟上一次真人揮手配成一次速度取樣：上一次揮手那一拍的樂譜長度 ÷ 兩次
  // 揮手之間真實過的秒數（＝你走完一拍花的時間；用上一拍的長度，樂譜自己變速時才對得上）。中間若隔著電腦替你放行的
  // 拍，分子不把那幾拍算進去：漏揮一次會變成「一拍的長度 ÷ 兩拍的時間」＝慢一半的離群取樣，由 _applySample 處理，
  // 這樣你真的變慢（連續離群）才學得到，偶爾漏揮不會被當成變慢。代打放行本身不取樣。
  _observeWave(nowMs, lenSec = this._beatLengthSec()) {
    const last = this._lastWave;
    this._lastWave = { ms: nowMs, len: lenSec };
    if (!last) return;
    const sample = rateSample(last.len, (nowMs - last.ms) / 1000);
    if (sample === null) return;
    this._sampled = true;
    this._applySample(sample);
  }

  // 套用一個速度取樣，離群的先暫存：比目前估計快或慢超過 RATE_OUTLIER 的取樣，可能是同一個動作被偵測成兩次（間隔
  // 太短）或漏偵測（間隔太長），也可能是真的變速。下一個取樣同向、而且幅度對得上暫存的那個，才當成真的變速一起套用；
  // 對不上（正常了、或方向相反）就丟掉暫存的那個。
  _applySample(sample) {
    const r = this._playbackRate;
    const isOutlier = (s) => s > r * (1 + RATE_OUTLIER) || s < r * (1 - RATE_OUTLIER);
    const pending = this._pendingRate;
    this._pendingRate = null;
    if (pending !== null && isOutlier(sample) && (pending > r) === (sample > r)
      && Math.abs(Math.log(sample / pending)) <= Math.log(1 + RATE_OUTLIER)) {
      this._playbackRate = smoothRate(smoothRate(r, pending), sample);
    } else if (isOutlier(sample)) {
      this._pendingRate = sample;
    } else {
      this._playbackRate = smoothRate(r, sample);
    }
  }

  // 放行下一拍（還沒放行過任何一拍時放行起始拍本身）：邊界 B 推到那一拍的拍尾，追趕目標設在那一拍的起點。
  // 第一次放行不追趕（目標＝S 自己）：前奏照原速播完，才輪到真人的第一個音，提早揮手的人不會把前奏追成倍速。
  // 拍格線已經走完（只有軌尾收尾的零長度音可能落在格線盡頭之外）就把剩下的全部放行。
  _releaseNextBeat() {
    const first = !this._released;
    if (!first) {
      if (this._beatIndex + 1 >= this._beats.length) { this._frontierSec = Infinity; return; }
      this._beatIndex += 1;
    }
    this._released = true;
    const beat = this._beats[this._beatIndex];
    this._frontierSec = Math.max(this._frontierSec, beat.endSeconds);
    this._catchUpToSec = first ? this._clockSec : beat.startSeconds;
  }

  // 這位演奏者這次揮手是不是「對目前這一拍的回應」（不另外再推一拍）：這一拍剛剛被放行（另一位的揮手或電腦代打）、
  // 還在窗內（見 FOLLOW_WINDOW_BEATS），而且他自己這一拍還沒動作過。
  _followsCurrentBeat(slot, nowMs) {
    if (this._lastReleaseMs == null || this._actedBeat.get(slot) === this._beatIndex) return false;
    return nowMs - this._lastReleaseMs <= this._followWindowSec() * 1000;
  }

  // 窗長是真實秒數，拍長是樂譜秒數：拍長 ÷ r 才是這一拍實際要走的真實時間。
  _followWindowSec() {
    return (FOLLOW_WINDOW_BEATS * this._beatLengthSec()) / this._playbackRate;
  }

  // 放行之後每個揮過手的指派聲部該用真人還是代打音量：代打放行的拍全部用代打音量；揮手放行的拍，這一拍有動作
  // （揮手或跟上）的演奏者用真人音量，沒動作的用代打音量（他的聲部是跟著合奏走過去的）。從未揮過手的聲部不會
  // 出聲，不需要調。
  _tagVolumes(byAutopilot) {
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human' || !voice.triggered) continue;
      voice.isAutopilot = byAutopilot || this._actedBeat.get(voice.lastSlot) !== this._beatIndex;
      this._syncVolume(voice);
    }
  }

  // 代打與真人揮手共用的音量對比：代打時 CC7 調低（原音量 × AUTOPILOT_VOLUME_RATIO），真人揮手時恢復原音量，只影響
  // 音量、不影響 note-on velocity（樂譜原值不變）。voice._lastSentCc7 去重，同一個值不重複送。
  _syncVolume(voice) {
    const cc = voice.isAutopilot ? voice.autopilotVolume : voice.baseVolume;
    if (voice._lastSentCc7 === cc) return;
    voice._lastSentCc7 = cc;
    try { this._synthOf(voice)?.controllerChange(voice.channel, 7, cc); } catch (err) {}
  }

  // 這個聲部有沒有還沒放行的音（最後一顆音的起點 ≥ B）。
  _hasUnreleasedNote(voice) {
    const last = voice.notes[voice.notes.length - 1];
    return !!last && last.startSeconds >= this._frontierSec;
  }

  // 曲末：所有指派聲部都沒有還沒放行的音（沒有東西需要再揮手了）就自動進入——B＝∞，尾奏照時間播完，不需要
  // 使用者多揮一下。只要還有任何一個指派聲部有音沒放行（包含演奏者缺席的聲部），就不會進終局，也不會被誰多揮
  // 一下強制播完。
  _checkFinale() {
    if (this._frontierSec === Infinity) return;
    let anyHuman = false;
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human') continue;
      anyHuman = true;
      if (this._hasUnreleasedNote(voice)) return;
    }
    if (anyHuman) { this._frontierSec = Infinity; this._autopilotLeftSec = null; } // 沒有東西可放行了，代打不必再倒數
  }

  _beatLengthSec() {
    const beat = this._beats[this._beatIndex];
    return beat.endSeconds - beat.startSeconds;
  }

  // 還在前奏：第一下放行還沒發生，而且時鐘離入場拍還有半拍以上（入場拍的長度算，樂譜時間：人提早的是「真實時間半拍」，
  // 時鐘以 r 前進，換成樂譜時間 r 剛好消掉）。
  _inPrelude() {
    return !this._released && this._clockSec < this._entrySec - PRELUDE_ANTICIPATION_BEATS * this._beatLengthSec();
  }

  // 時鐘現在所在那一拍的樂譜長度（只給前奏用；從入場拍往前找，前奏通常不長，找幾步就到）。
  _beatLengthAtClockSec() {
    let i = this._beatIndex;
    while (i > 0 && this._beats[i].startSeconds > this._clockSec + EPS) i--;
    return this._beats[i].endSeconds - this._beats[i].startSeconds;
  }

  // 時鐘停格多久就把還在響的音全部收掉，見 IDLE_MS。有代打補位之後，只有第一下揮手之前（前奏結尾）會停格這麼久，
  // 那時還沒有速度估計（r＝1），所以不用 ÷ r。
  _idleThresholdSec() {
    return Math.max(IDLE_MS / 1000, this._beatLengthSec() * IDLE_BEATS);
  }

  // 時鐘前進一個 tick：落後最近放行那一拍的起點就加速追趕，最多走到放行邊界 B；碰到 B 就停格，停格超過閒置門檻
  // 把還在響的音全部收掉（相連音撐住只是不在停格那一下提早收，不是延音效果，不能讓音無限期掛著）。
  _advanceClock(dt) {
    if (dt <= 0) return;
    const lag = this._catchUpToSec - this._clockSec;
    const catchUp = lag > EPS ? Math.min(CATCHUP_MAX_SPEED, 1 + (CATCHUP_GAIN * lag) / this._beatLengthSec()) : 1;
    this._clockSec = Math.min(this._clockSec + dt * this._playbackRate * catchUp, this._frontierSec);

    if (this._clockSec < this._frontierSec - EPS) { this._stallSec = 0; return; }
    this._stallSec += dt;
    if (this._stallSec > this._idleThresholdSec()) this._noteOffAll();
  }

  // 每個聲部：先收掉時鐘走過結尾的音，再放出已放行、時鐘也走到的音（同一 startSeconds 的音符＝和弦，會在同一次
  // 呼叫裡一起處理），最後再收一次（同一個 tick 內起音又結束的短音）。先收再放保證相連的舊音在後繼音發聲的
  // 同一刻已經關掉；放行邊界是排他的（startSeconds < B）：剛好落在拍尾的下一拍第一顆音要等下一次揮手。
  // noteOn 一律先於 voice.cursor++（測試與差異測試靠這個順序從 cursor 取得剛發聲的是哪一顆音）。
  _emitNotes() {
    const S = this._clockSec, B = this._frontierSec;
    for (const voice of this._voices.values()) {
      const synth = this._synthOf(voice);
      this._closeDueNotes(voice, synth);
      while (voice.cursor < voice.notes.length) {
        const n = voice.notes[voice.cursor];
        if (n.startSeconds > S + EPS || n.startSeconds >= B) break;
        if (voice.kind === 'human' && !voice.triggered) {
          // 還沒被自己的演奏者揮過手的指派聲部不出聲。但最近一個合併窗內走過的音先留著：他只是比別人晚一點才
          // 揮第一下（跟上同一拍），拍首的音要補上，不然多人一起開始時，慢半拍的人永遠少了第一顆音；過了窗就
          // 丟掉（晚進場、或從沒揮過手的演奏者不會憑空出聲，也不會有一串舊音在後來一口氣補出來）。窗長是真實
          // 秒數，這裡比的是樂譜秒數：窗內時鐘走了 窗長 × r 個樂譜秒。
          if (n.startSeconds < S - this._followWindowSec() * this._playbackRate) { voice.cursor++; continue; }
          break;
        }
        try { synth?.noteOn(voice.channel, n.note, n.velocity); } catch (err) {}
        let queue = voice.sounding.get(n.note);
        if (!queue) voice.sounding.set(n.note, (queue = []));
        queue.push({ endSec: n.endSeconds, legatoTo: n.legatoTo });
        voice.cursor++;
      }
      this._closeDueNotes(voice, synth);
    }
  }

  // 收掉樂譜時鐘已經走過結尾的音。同音高重疊時只看佇列最前面那一顆（先進先出）。
  _closeDueNotes(voice, synth) {
    for (const [pitch, queue] of voice.sounding) {
      while (queue.length && queue[0].endSec <= this._clockSec + EPS && !this._isHeld(voice, queue[0])) {
        try { synth?.noteOff(voice.channel, pitch); } catch (err) {}
        queue.shift();
      }
      if (!queue.length) voice.sounding.delete(pitch);
    }
  }

  // 相連音要不要繼續撐：它的後繼音還沒發聲、也還沒被放行（時鐘停格等揮手）。後繼音一放行就不再撐，在後繼音
  // 發聲的同一個 tick 先關再開；整首自動播放（B＝∞）永遠不撐，每個 noteOff 都照檔案。
  _isHeld(voice, entry) {
    const successor = voice.notes[entry.legatoTo];
    return !!successor && entry.legatoTo >= voice.cursor && successor.startSeconds >= this._frontierSec;
  }
}
