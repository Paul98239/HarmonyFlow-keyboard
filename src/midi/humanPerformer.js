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
//    · 真人揮手：放行下一拍。多位演奏者同時揮手、一個人指派多個聲部（左右手）都只放行一拍；另一位剛放行這一拍
//      之後的短暫合併窗（`FOLLOW_WINDOW_MS`）內晚到的揮手，視為跟上同一拍，不另外再推一拍。沒有任何還沒放行
//      的音的聲部（已經演奏完），它的揮手直接忽略。
//    · 代打：停手滿閒置門檻之後，電腦替「揮過手的聲部」走一拍空拍；只要這些聲部在下一拍有自己的音
//      就不走——那顆音要本人揮手。之後每一步等剛走進那一拍要走的真實時間（拍長 ÷ r）。倒數依 tick 的 dt 遞減，
//      暫停期間不算停手。
//  剛載入時放行邊界在起始拍的拍首（所有指派聲部最早的音所在的那一拍）：電腦輔助聲部先播前奏（還沒有取過樣，
//  r＝1＝原譜速度），第一次揮手放行起始拍。沒有人被指派（或沒有拍格線，SMPTE）時 B＝∞，整首照時間連續自動播放。
//
//  發聲：每個 tick 先收掉時鐘走過結尾的音，再放出「已放行、時鐘也走到」的音，最後再收一次（同一個 tick 內起音
//  又結束的短音）。從未被自己的演奏者揮過手的指派聲部維持靜音；揮過手的聲部，別人放行的拍它的音照樣發聲
//  （音量用代打的 CC7，見 `_tagVolumes()`）。
//
//  時鐘怎麼走（`_advanceClock()`）：
//    · 速度：S 每個 tick 前進 dt × r。r 是速度倍率＝演奏者的速度是原譜速度的幾倍：每次「真人」放行一拍，就用
//      「樂譜在這兩拍的起點之間走的秒數 ÷ 兩次揮手之間真實過的秒數」取一次樣，在對數域指數平滑（`rateSample`／
//      `smoothRate`）；還沒取過樣＝1。代打放行與暫停不取樣；代打與終局沿用最後一次估計，不重設。停格與代打的
//      等待門檻、合併窗都是真實秒數，用 拍長 ÷ r 換算。
//    · 追趕：揮手比時鐘早、S 落後最近放行那一拍的起點時，S 再乘上 1＋16×落後量／拍長 倍（上限 6 倍）——不跳、
//      不丟音，拍內剩下的快速音仍依序發聲。第一次放行不追趕：前奏照原速播完才輪到真人的第一個音。
//    · 停格：S 碰到 B 就停格。相連音（結尾到同聲部下一顆音的間隙 ≤ θ）在它的後繼音還沒放行時不收，免得停格
//      那一下出現檔案裡沒有的空白；停格超過閒置門檻就把所有還在響的音收掉，不會無限期掛著。
//    · 每個 tick 的 dt 上限 MAX_TICK_DT_SEC：分頁被節流後恢復時，不會一次吐出一大段。
//  所有指派聲部都沒有還沒放行的音時進入終局：B＝∞，尾奏照最後一次估計的速度播完，不需要多揮一下。
//
//  同音高重疊的音依發聲順序先進先出收音（跟官方合成器對 note-off 的解讀一致），每個 noteOn 都送出一個對應的
//  noteOff。velocity 一律用樂譜原值；不重播 CC／pitch-bend，音色只在 load() 時套用一次。
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
// 「停手多久算閒置」：代打第一步的等待時間，也是時鐘停格超過多久就把還在響的音全部收掉的門檻。
// 實際長度是 max(IDLE_MS, 目前拍長 × IDLE_BEATS ÷ r)，見 _idleThresholdSec()（拍長 ÷ r 是這一拍實際要走的真實
// 時間）。IDLE_MS 吸收揮手動作本身需要的時間與手勢偵測延遲，不是在等某段休止的確切長度。IDLE_BEATS 讓慢曲
// （拍長 > IDLE_MS）或慢的演奏者（r < 1）準時每拍揮一次也不會被代打搶先走一拍——否則他的揮手接著再推一拍，同一拍
// 被算兩次（棘輪效應）；1.5 拍的容忍才不會誤判他停手了。
const IDLE_MS = 800;
const IDLE_BEATS = 1.5;
// 多人合併窗：某位演奏者的揮手落在「另一位剛剛（真人）放行這一拍」之後這麼短的時間內、而且他自己這一拍還沒動作
// 過，視為「跟上這一拍」，不另外再推一拍——多人幾乎同時揮手是常態，各推一拍會讓合奏從第一下起就比最慢的人多走
// 一拍。單人自己連續快揮不受影響（他永遠是這一拍的第一個動作）。窗長取 min(FOLLOW_WINDOW_MS, 拍長 ÷ r ×
// FOLLOW_WINDOW_BEAT_RATIO)，快曲或快的演奏者不會讓窗寬過半拍。
const FOLLOW_WINDOW_MS = 250;
const FOLLOW_WINDOW_BEAT_RATIO = 0.4;
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
// [RATE_MIN, RATE_MAX]（原譜速度的 1/4～4 倍）視為停頓或重複偵測，不採樣。
const RATE_ALPHA = 0.35;
const RATE_MIN = 0.25;
const RATE_MAX = 4;
// 浮點數比較的容差：S 是一路加 dt 累積出來的，跟 startSeconds／endSeconds 比大小時不能要求逐位元相等。
const EPS = 1e-9;
// 代打時這個聲部的 CC7（Channel Volume）：目標是校正到約等於電腦輔助聲部的音量基準（它們沒有掛
// synth.js 的 HUMAN_EMPHASIS_GAIN，等於基準 1.0），真正的「凸顯」完全交給真人揮手時的
// HUMAN_EMPHASIS_GAIN，代打本身不做額外凸顯或壓低。CC7 對音量不是線性關係——已查證 GM2 官方
// 規格 §3.3.6（docs/midi-official-doc/General_MIDI_Level_2_07-2-6_1.2a.txt）明講 Channel
// Volume／Expression 這組音量「數值的平方才正比於音量」，這個專案實際用的 spessasynth_core
// 原始碼（GitHub spessasus/spessasynth_core 的 src/midi/midi_tools/midi_utils.ts）處理
// Master Volume 時也是同一套平方關係（註解明講「it corresponds to CC volume, so volume is
// squared」）。反推公式：HUMAN_EMPHASIS_GAIN × (CC7/100)² = 1.0 → CC7 = 100×√(1/1.4) ≈ 85。
// 這個數字只用來對照 synth.js 的 HUMAN_EMPHASIS_GAIN，改動任一邊都要重算另一邊——兩個檔案
// 之間無法用 import 連動（humanPerformer.js 不能反過來 import synth.js，會形成循環），跟這個
// 專案裡 vision.js 的 EMIT_HEARTBEAT_MS 與 midiPlayer.js 的 GATE_STALE_MS 互相對照的既有寫法
// 一致，只能靠註解手動同步。只調 CC7（音量），不動 note-on velocity（觸鍵力度）——這是兩種
// 不同的 MIDI 概念，velocity 只在 note-on 當下決定一次，CC7 是疊加在已經送出的音符之上的
// 獨立音量調整。
const AUTOPILOT_VOLUME_CC = 85;

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

// 幫一組聲部各自分配一個輸出 channel，避免兩個原本共用同一個原始 channel 的聲部打架。
// 鼓組固定用 drumChannel，其餘依序拿 melodicChannels 裡的號碼；配完就停手，排不進去的
// 聲部回報給呼叫端，不出聲。
function allocateChannels(parts, melodicChannels, drumChannel) {
  const byPartId = new Map();
  const unplaced = [];
  let next = 0;
  for (const p of parts) {
    // percussionKit 已經是 GM2 Bank Select（CC0/32）判定過的結果：channel 9 若明確用
    // Bank 79H(121) 切成旋律通道，這裡就不會被誤送進打擊 channel（見 midiParser.js 的
    // collectParts() 說明）。
    if (p.percussionKit) { byPartId.set(p.id, drumChannel); continue; }
    if (next < melodicChannels.length) { byPartId.set(p.id, melodicChannels[next++]); continue; }
    unplaced.push(p.id);
  }
  return { byPartId, unplaced };
}

/* ═══════════════════════════════════════════
   聲部（voice）建構
   ═══════════════════════════════════════════ */

function makeVoice(partId, slot, notes, kind, channel) {
  return {
    partId, slot, kind, channel, notes,
    cursor: 0,              // 下一個還沒處理（發聲或靜音略過）的音符在 notes 裡的位置
    sounding: new Map(),    // 音高 → [{ endSec, legatoTo }]：正在響的音；同音高重疊時依發聲順序排隊，先進先出收音
    triggered: false,       // 指派聲部的演奏者是否真實揮過手；沒揮過就維持靜音，見 _emitNotes
    lastSeq: null,          // 上次觀察到的手勢 triggerSeq，null＝還沒對過基準
    lastSlot: undefined,    // 上次觀察到的指派槽位，與現在不同就重新對齊基準（見 _arbitrate）
    isAutopilot: false,     // 目前用代打音量（CC7 調低）還是真人音量，驅動 _syncVolume() 的 CC7 切換
    _lastSentCc7: 100,      // 上次送出的 CC7 值，避免重送同一個值
  };
}

// 指派聲部只配 humanSynth 的 channel、未指派聲部只配 assistSynth 的 channel——指派聲部沒被演奏者揮過手就是
// 靜音，不需要幫它在 assistSynth 上保留一條代打用的 channel。兩個池子各自獨立，配額用完的聲部回報在 unplaced，
// 這一輪不會出聲。
function buildVoices(score, assignments, assistSynth, humanSynth, cfg) {
  const voices = new Map(); // partId → voice
  const unplaced = [];

  const notesByPart = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
  for (const n of score.notes) {
    let list = notesByPart.get(n.partId);
    if (!list) notesByPart.set(n.partId, (list = []));
    list.push(n);
  }

  const assignedParts = score.parts.filter((p) => assignments.has(p.id));
  const assistParts = score.parts.filter((p) => !assignments.has(p.id));

  const { byPartId: humanCh, unplaced: u1 } =
    allocateChannels(assignedParts, melodicChannelsFor(humanSynth, cfg.drumChannel), cfg.drumChannel);
  const { byPartId: assistCh, unplaced: u2 } =
    allocateChannels(assistParts, melodicChannelsFor(assistSynth, cfg.drumChannel), cfg.drumChannel);
  unplaced.push(...u1, ...u2);

  for (const p of assignedParts) {
    const channel = humanCh.get(p.id);
    if (channel === undefined) continue;
    voices.set(p.id, makeVoice(p.id, assignments.get(p.id), notesByPart.get(p.id) || [], 'human', channel));
  }
  for (const p of assistParts) {
    const channel = assistCh.get(p.id);
    if (channel === undefined) continue;
    voices.set(p.id, makeVoice(p.id, null, notesByPart.get(p.id) || [], 'assist', channel));
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
    this._voices = new Map();  // partId → voice
    this._clockSec = 0;        // 樂譜時鐘 S
    this._frontierSec = 0;     // 放行邊界 B：音符 startSeconds < B 才算被放行；Infinity＝全部放行
    this._beatIndex = 0;       // 共用拍位：最近放行的那一拍（還沒放行過任何一拍時＝起始拍）
    this._startBeatIndex = 0;  // load() 算出的起始拍位，stop() 要退回這裡
    this._released = false;    // 是否已經放行過任何一拍（第一次放行放的是起始拍本身，不是下一拍）
    this._catchUpToSec = 0;    // 追趕目標：最近放行那一拍的起點
    this._stallSec = 0;        // 時鐘停在放行邊界已經多久
    this._autopilotLeftSec = null; // 合奏層級的代打倒數（秒，依 tick 的 dt 遞減）；null＝沒在倒數
    this._realAdvanceMs = null;    // 最近一次「真人」放行一拍的時刻（合併窗用，代打不算）
    this._playbackRate = 1;        // 速度倍率 r：演奏者的速度是原譜速度的幾倍（還沒取過樣＝1）；時鐘 S 照這個速度前進
    this._lastWave = null;         // 最近一次真人放行的 { ms 揮手時刻, sec 那一拍在樂譜裡的起點 }；取樣用，代打與暫停會清掉
    this._actedBeat = new Map();   // 槽位 → 這位演奏者最近一次動作（放行或跟上）所在的拍
    this.unplacedPartIds = [];
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
    this.unplacedPartIds = [];
    if (score) this._createVoices(score, assignments);
    // 沒有樂譜時 voices 是空的：起始拍 0、放行邊界 Infinity，tick() 空轉不會碰到拍格線。
    this._startBeatIndex = this._computeStartBeatIndex();
    this._beatIndex = this._startBeatIndex;
    this._frontierSec = this._initialFrontierSec();
  }

  // 建立聲部、套初始音色、標記每顆音的拍位與相連後繼音。
  _createVoices(score, assignments) {
    // 沒有拍格線（SMPTE division，A5）：指派聲部的推進全靠拍位，算不出來就退回整首自動播放——忽略指派。
    const assignMap = !this._beats.length ? new Map()
      : assignments instanceof Map ? assignments : new Map(assignments || []);
    const partById = new Map(score.parts.map((p) => [p.id, p]));

    const { voices, unplaced } = buildVoices(score, assignMap, this.assistSynth, this.humanSynth, this.cfg);
    this._voices = voices;
    this.unplacedPartIds = unplaced;

    for (const voice of this._voices.values()) {
      const part = partById.get(voice.partId);
      const synth = this._synthOf(voice);
      this._applyInitialPatch(synth, voice.channel, part);
      // CC7 不在「reset all controllers」清單裡（已用 GML-v1 §3.2.5.2 驗證），channel 又是
      // 跨曲重複使用：明確送一次 GM 預設值 100，避免沿用到別的曲子／別的聲部在同一個
      // channel 索引上留下的音量設定。
      try { synth?.controllerChange(voice.channel, 7, 100); } catch (err) {}
    }

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

  _applyInitialPatch(synth, channel, part) {
    if (!synth) return;
    try {
      synth.controllerChange(channel, 0, part.bank?.msb || 0);
      synth.controllerChange(channel, 32, part.bank?.lsb || 0);
      synth.programChange(channel, part.program || 0);
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
      // CC7 要明確送回基準：代打留下的 85 還在合成器上，而 _lastSentCc7 的去重會擋掉之後的重送。
      voice._lastSentCc7 = 100;
      try { this._synthOf(voice)?.controllerChange(voice.channel, 7, 100); } catch (err) {}
    }
    this._clockSec = 0;
    this._beatIndex = this._startBeatIndex;
    this._released = false;
    this._frontierSec = this._initialFrontierSec();
    this._catchUpToSec = 0;
    this._stallSec = 0;
    this._autopilotLeftSec = null;
    this._realAdvanceMs = null;
    this._playbackRate = 1;
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
    if (this._autopilotLeftSec != null) this._autopilotLeftSec -= dt;

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
      let release = false;
      for (const slot of waveSlots) if (!this._followsCurrentBeat(slot, nowMs)) release = true;
      if (release) {
        this._releaseNextBeat();
        this._realAdvanceMs = nowMs;
        this._observeWave(nowMs);
      }
      for (const slot of waveSlots) this._actedBeat.set(slot, this._beatIndex);
      this._tagVolumes(false);
      this._autopilotLeftSec = this._idleThresholdSec();
      return;
    }

    if (this._autopilotLeftSec != null && this._autopilotLeftSec <= 0) {
      if (this._autopilotMayStep()) {
        this._releaseNextBeat();
        this._realAdvanceMs = null; // 合併窗只從「真人」的放行算起：代打走的那一步不算，演奏者緊接著的準時揮手是他自己的下一拍
        this._lastWave = null;      // 代打放行不取樣；隔著代打的兩次真人揮手也不配成取樣（中間那拍是代打在它自己的時間放行的）
        this._tagVolumes(true);
        // 代打照著估計的速度走：S 走過這一拍要 拍長÷r 的真實時間，下一步等這麼久，跟電腦輔助聲部的節奏對得上
        this._autopilotLeftSec = this._beatLengthSec() / this._playbackRate;
      } else {
        this._autopilotLeftSec = null; // 整批不走：等真人下一次揮手再重新倒數
      }
    }
  }

  // 記下這次真人放行，並跟上一次真人放行配成一次速度取樣：樂譜在這兩拍的起點之間走的秒數 ÷ 兩次揮手之間真實過的
  // 秒數（用起點差而不是「這拍的長度」，樂譜自己變速時才跟得上）。取樣落在合理範圍內才更新速度倍率。
  _observeWave(nowMs) {
    const wave = { ms: nowMs, sec: this._beats[this._beatIndex].startSeconds };
    const last = this._lastWave;
    this._lastWave = wave;
    if (!last) return;
    const sample = rateSample(wave.sec - last.sec, (wave.ms - last.ms) / 1000);
    if (sample !== null) this._playbackRate = smoothRate(this._playbackRate, sample);
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

  // 這位演奏者這次揮手是不是「跟上同一拍」：另一位剛剛（真人）把共用拍位放行到目前這一拍、還在合併窗內，
  // 而且他自己這一拍還沒動作過（見 FOLLOW_WINDOW_MS）。
  _followsCurrentBeat(slot, nowMs) {
    if (this._realAdvanceMs == null || this._actedBeat.get(slot) === this._beatIndex) return false;
    return nowMs - this._realAdvanceMs <= this._followWindowSec() * 1000;
  }

  // 窗長是真實秒數，拍長是樂譜秒數：拍長 ÷ r 才是這一拍實際要走的真實時間。
  _followWindowSec() {
    return Math.min(FOLLOW_WINDOW_MS / 1000, (this._beatLengthSec() / this._playbackRate) * FOLLOW_WINDOW_BEAT_RATIO);
  }

  // 代打這一步能不能走：所有「揮過手、而且還有沒放行的音」的指派聲部，下一顆音都離共用拍位至少兩拍，而且至少有
  // 一個這樣的聲部。只要任何一個在下一拍就有自己的音，整批不走——那顆音要它的演奏者自己揮手，代打不能替他走，
  // 也不能替別人把共用拍位推過去。走一拍保證落在每個聲部下一顆音之前，所以絕不會跳過任何真人該揮的音。
  _autopilotMayStep() {
    let any = false;
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human' || !voice.triggered) continue;
      const next = this._nextUnreleasedNote(voice);
      if (!next) continue;                                  // 沒有更多音符：不需要代打，也不擋別人
      if (next.beatIndex <= this._beatIndex + 1) return false;
      any = true;
    }
    return any;
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

  // 代打與真人揮手共用的音量對比：代打時 CC7 調低，真人揮手時恢復 GM 預設 100，只影響音量、
  // 不影響 note-on velocity（樂譜原值不變）。voice._lastSentCc7 去重，同一個值不重複送。
  _syncVolume(voice) {
    const cc = voice.isAutopilot ? AUTOPILOT_VOLUME_CC : 100;
    if (voice._lastSentCc7 === cc) return;
    voice._lastSentCc7 = cc;
    try { this._synthOf(voice)?.controllerChange(voice.channel, 7, cc); } catch (err) {}
  }

  // 這個聲部有沒有還沒放行的音（最後一顆音的起點 ≥ B）。
  _hasUnreleasedNote(voice) {
    const last = voice.notes[voice.notes.length - 1];
    return !!last && last.startSeconds >= this._frontierSec;
  }

  // 這個聲部游標之後第一顆還沒放行的音；沒有就回傳 null。
  _nextUnreleasedNote(voice) {
    let i = voice.cursor;
    while (i < voice.notes.length && voice.notes[i].startSeconds < this._frontierSec) i++;
    return voice.notes[i] || null;
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
    if (anyHuman) this._frontierSec = Infinity;
  }

  _beatLengthSec() {
    const beat = this._beats[this._beatIndex];
    return beat.endSeconds - beat.startSeconds;
  }

  // 「停手多久算閒置」，見 IDLE_MS。拍長 ÷ r 是這一拍實際要走的真實時間：演奏者慢（r 小）門檻放寬，不搶在他揮手前
  // 代打；演奏者快（r 大）門檻縮短，但不低於 IDLE_MS。
  _idleThresholdSec() {
    return Math.max(IDLE_MS / 1000, (this._beatLengthSec() * IDLE_BEATS) / this._playbackRate);
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
