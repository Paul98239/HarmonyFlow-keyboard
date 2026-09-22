// ============================================================
//  humanPerformer.js — 事件驅動排程器（純邏輯，無 DOM／CDN）
//
//  沒有背景時鐘：共用拍位只在「有效觸發」發生的那一刻才前進，其他時間完全靜止，沒有觸發
//  就不會自己往前走（曾經試過拍速估計器＋電腦代打的版本，因為沒人揮手曲子也會自己前進而
//  被拿掉，見專案的 git 歷史；這裡的拍速估計只影響「已經被揮手推進的範圍」爬多快，不會
//  重新長出自動前進的背景時鐘）。每個聲部有自己的播放頭 `playSec`（依現場拍速前進）與
//  上限 `limitSec`（播放頭不能超過的界線）。
//
//  指派聲部：演奏者在目前拍上還有沒播出的音，觸發就在原地把上限推到拍尾（claim）；沒有的
//  話，把共用拍位直接推到這個聲部「下一個真正有音符的拍」（`_advanceToNextNote()`，可能
//  一次跨過好幾個沒有音符的空拍——全音符只需要一次觸發，不需要對著空拍反覆揮手），再
//  claim。跳過的過程中，其他被指派聲部若剛好也有音符落在被跳過的拍上，這一輪沒被自己的
//  演奏者觸發＝直接靜音丟棄，不會被電腦補（沒有代打），也不會因為共用拍位路過就被誤判成
//  發聲——這是這個排程器最容易出錯的地方，見 `_advanceToNextNote()` 的註解。
//
//  現場拍速：每次推進時，用「這次觸發的真實間隔 ÷ 這次跨過的拍數」量一次「現場每拍幾秒」
//  （`_updateLiveTempo()`），指數平滑後驅動 `_tempoScale()`——播放頭與正在響的音的剩餘
//  時長都依這個比例縮放，讓揮手快慢直接對應音樂快慢。拍位本身的格線（哪一拍在原譜上是
//  幾秒）來自 `buildBeatGrid()`，是 SMF 規格保證的確定性計算；但「一次揮手對應推進到哪、
//  現場拍速怎麼從離散事件反推」全部是應用層假設，不是規格——這幾個假設列在
//  `DEFAULT_PERFORMER_CONFIG` 旁邊的模組常數註解裡。
//
//  未指派聲部（真正的電腦伴奏）：上限永遠等於 `_frontierSec`（全域值＝目前所有指派演奏者
//  推進最遠的那一位），完全不受自己有沒有觸發影響，任何一次觸發把拍位往前推，伴奏的播放頭
//  也會立刻對齊到新拍起點，跟著反應式播放，不會累積落後。完全沒有人被指派時，`_frontierSec`
//  從 `load()` 就直接設成 `Infinity`，等同整份照真實經過時間連續自動播放。
//
//  正在響的音各自倒數自己的原譜時長（依現場拍速縮放的 `remain`，見 `_emitDueNotes()`／
//  `_releaseDue()`），完全獨立於播放頭的跳躍：跳拍不會把它提前掐斷，也不會被它擋住不能出
//  下一個音。velocity 一律用樂譜原值，不套用手勢公式；不重播 CC／pitch-bend，音色只在
//  load() 時套用一次。
// ============================================================

import { buildBeatGrid } from './midiParser.js';

export const DEFAULT_PERFORMER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
});

const CHANNELS_PER_PORT = 16;

/* ═══════════════════════════════════════════
   拍速跟隨的常數（應用層假設，不是規格——規格沒有「揮手」這種東西，見檔頭說明）
   ═══════════════════════════════════════════ */

const TEMPO_SMOOTHING = 0.65;      // 新量到的拍速佔 65%，一次揮手就跟上大半，又擋得住單次誤判
const TEMPO_MIN_INTERVAL_S = 0.05; // 比這更短的間隔當誤觸發，不拿來估拍速
const TEMPO_MAX_INTERVAL_S = 4;    // 比這更長＝中途停下來，不拿來估拍速（沿用上一次量到的值）
const TEMPO_SCALE_MIN = 0.25;      // 播放頭爬的速度相對原譜的下限，避免揮太慢時直接卡死
const TEMPO_SCALE_MAX = 4;         // 上限，避免揮太快時把播放頭甩飛

/* ═══════════════════════════════════════════
   輸出 channel 分配
   ═══════════════════════════════════════════ */

// 這個合成器上可用的旋律輸出 channel＝跳過每個 port 的打擊槽（ch % 16 === drumChannel）。
function melodicChannelsFor(synth, drumChannel) {
  const chans = synth?.midiChannels;
  const total = Array.isArray(chans) && chans.length > 0 ? chans.length : CHANNELS_PER_PORT;
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
    const isDrum = p.percussionKit === true || p.channel === drumChannel;
    if (isDrum) { byPartId.set(p.id, drumChannel); continue; }
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
    cursor: 0,              // 下一個「還沒排程」的音符在 notes 裡的位置
    sounding: new Map(),    // note(音高) → { remain }：還剩幾樂譜秒才該關閉
    playSec: 0,             // 這個聲部的播放頭
    limitSec: 0,            // 播放頭不能超過的界線
    claimed: false,         // 指派聲部是否曾經被自己的演奏者接手過（見 _emitDueNotes 的用法）
    lastSeq: null,          // 上次觀察到的手勢 triggerSeq，null＝還沒對過基準
    lastSlot: undefined,    // 上次觀察到的指派槽位，與現在不同就重新對齊基準（見 _handleTriggers）
  };
}

// 指派聲部只配 humanSynth 的 channel、未指派聲部只配 accompSynth 的 channel——被指派聲部
// 沒接手就是靜音，不需要幫它在 accompSynth 上保留一條代打用的 channel。兩個池子各自獨立
// 配額用完的聲部回報在 unplaced，這一輪不會出聲。
function buildVoices(score, assignments, accompSynth, humanSynth, cfg) {
  const voices = new Map(); // partId → voice
  const unplaced = [];

  const notesByPart = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
  for (const n of score.notes) {
    let list = notesByPart.get(n.partId);
    if (!list) notesByPart.set(n.partId, (list = []));
    list.push(n);
  }

  const assignedParts = score.parts.filter((p) => assignments.has(p.id));
  const accompParts = score.parts.filter((p) => !assignments.has(p.id));

  const { byPartId: humanCh, unplaced: u1 } =
    allocateChannels(assignedParts, melodicChannelsFor(humanSynth, cfg.drumChannel), cfg.drumChannel);
  const { byPartId: accompCh, unplaced: u2 } =
    allocateChannels(accompParts, melodicChannelsFor(accompSynth, cfg.drumChannel), cfg.drumChannel);
  unplaced.push(...u1, ...u2);

  for (const p of assignedParts) {
    const channel = humanCh.get(p.id);
    if (channel === undefined) continue;
    voices.set(p.id, makeVoice(p.id, assignments.get(p.id), notesByPart.get(p.id) || [], 'human', channel));
  }
  for (const p of accompParts) {
    const channel = accompCh.get(p.id);
    if (channel === undefined) continue;
    voices.set(p.id, makeVoice(p.id, null, notesByPart.get(p.id) || [], 'accomp', channel));
  }
  return { voices, unplaced };
}

/* ═══════════════════════════════════════════
   HumanPerformer
   ═══════════════════════════════════════════ */
export class HumanPerformer {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_PERFORMER_CONFIG, ...config };
    this.accompSynth = null;   // 伴奏合成器（未指派聲部）
    this.humanSynth = null;    // 真人聲部合成器（被指派聲部）
    this._score = null;
    this._beats = [];          // buildBeatGrid() 的結果；空陣列＝無法算拍（SMPTE division）
    this._voices = new Map();  // partId → voice
    this._beatIndex = 0;       // 目前共用拍位在 _beats 裡的 index
    this._startBeatIndex = 0;  // load() 算出的起始拍位，stop() 要退回這裡
    this._frontierSec = 0;     // 未指派聲部的播放頭上限＝目前指派演奏者推進最遠的那一位
    this._liveSecPerBeat = null; // 現場量到的「每拍幾秒」，null＝還沒量到、用原譜速度
    this._lastAdvanceMs = null;  // 上一次推進拍位的時刻，量拍速的基準
    this.unplacedPartIds = [];
    this._playing = false;
    this._lastTickMs = null;   // null＝下一次 tick() 不推進播放頭，只記錄基準
  }

  setSynths(accompSynth, humanSynth) {
    this.accompSynth = accompSynth;
    this.humanSynth = humanSynth;
  }

  /**
   * 載入這首歌：建立聲部、套初始音色，準備好共用拍格線與起始拍位。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._beats = score ? buildBeatGrid(score) : [];
    this._voices = new Map();
    this.unplacedPartIds = [];
    if (!score) return;

    const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);
    const partById = new Map(score.parts.map((p) => [p.id, p]));

    const { voices, unplaced } = buildVoices(score, assignMap, this.accompSynth, this.humanSynth, this.cfg);
    this._voices = voices;
    this.unplacedPartIds = unplaced;

    for (const voice of this._voices.values()) {
      const part = partById.get(voice.partId);
      const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
      this._applyInitialPatch(synth, voice.channel, part);
      // CC7 不在「reset all controllers」清單裡（已用 GML-v1 §3.2.5.2 驗證），channel 又是
      // 跨曲重複使用：明確送一次 GM 預設值 100，避免沿用到別的曲子／別的聲部在同一個
      // channel 索引上留下的音量設定。
      try { synth?.controllerChange(voice.channel, 7, 100); } catch (err) {}
    }

    this._tagNotesWithBeat();
    this._startBeatIndex = this._computeStartBeatIndex();
    this._beatIndex = this._startBeatIndex;

    // 完全沒有人被指派、或指派了但完全沒有音符時，永遠不會有觸發，_frontierSec 沒有任何
    // 路徑可以被推進——必須在這裡顯式退回「整份照真實經過時間連續自動播放」，不能指望
    // 一般邏輯自動長出這個特例。
    const hasHumanNotes = [...this._voices.values()].some((v) => v.kind === 'human' && v.notes.length > 0);
    this._frontierSec = hasHumanNotes
      ? this._beats[this._beatIndex].startSeconds // 前奏：未指派聲部先照實時播到第一個真人入場點
      : Infinity;
  }

  // 所有指派聲部裡，最早出現音符的那一拍——拍位的起點，也是 stop() 之後要退回的原點。
  // 沒有指派聲部、或指派了但完全沒有音符時回傳 0（此時 _frontierSec 會是 Infinity，這個
  // 值不會被實際用到，只是給個確定的初始狀態）。
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
    this._lastTickMs = null; // 避免暫停期間累積的時間被當成一次巨大的 dt，把播放頭瞬間推老遠
  }

  // 暫停：收掉還在響的音，播放頭與拍位都保留（下次播放從原處繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    this.silence();
  }

  silence() {
    for (const voice of this._voices.values()) {
      const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
      for (const note of voice.sounding.keys()) {
        try { synth?.noteOff(voice.channel, note); } catch (err) {}
      }
      voice.sounding.clear();
      try { synth?.controllerChange(voice.channel, 123, 0); } catch (err) {} // CC123 All Notes Off 當保險
    }
  }

  // 停止／換歌前的清場：收音＋每個聲部的播放狀態全部歸零，拍速估計也重來。
  stop() {
    this.pause();
    for (const voice of this._voices.values()) {
      voice.cursor = 0;
      voice.playSec = 0;
      voice.limitSec = 0;
      voice.claimed = false;
      voice.lastSeq = null;
      voice.lastSlot = undefined;
    }
    this._liveSecPerBeat = null;
    this._lastAdvanceMs = null;
    this._beatIndex = this._startBeatIndex;
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
   * 目前播放到「樂譜原始時間」的第幾秒（跟 note 的 startSeconds／endSeconds 同一個座標系）。
   * 取所有聲部（含未指派）playSec 的最大值：未指派聲部照現場拍速連續前進、指派聲部只在
   * 自己的演奏者觸發時才跳，取最大值就能用同一個定義同時涵蓋「完全沒人指派＝整份自動播放」
   * 與「有人指派」兩種情境。沒人揮手時這個值會完全停住、有觸發時會一次跳好幾拍——這是
   * 事件驅動的真實狀態，不是要被平滑掉的抖動，畫面不用補間動畫。純讀取、無副作用。
   * @returns {number} 秒，夾在 [0, score.durationSeconds]；沒有樂譜或沒有聲部時 0
   */
  getPositionSeconds() {
    if (!this._score || this._voices.size === 0) return 0;
    let sec = 0;
    for (const voice of this._voices.values()) {
      if (voice.playSec > sec) sec = voice.playSec;
    }
    const total = this._score.durationSeconds;
    return total > 0 ? Math.min(sec, total) : sec; // 曲末 limitSec 變 Infinity，夾住不超過總長
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
    const dt = this._lastTickMs == null ? 0 : (nowMs - this._lastTickMs) / 1000;
    this._lastTickMs = nowMs;

    this._handleTriggers(getGestureFor, nowMs);
    this._advancePlayheads(dt, nowMs);
    this._emitDueNotes();
  }

  // 目前這一拍在原譜上是幾秒——固定拍長，來自規格保證的格線（buildBeatGrid()），不是估計。
  _scoreSecPerBeat() {
    const beat = this._beats[this._beatIndex];
    return beat.endSeconds - beat.startSeconds;
  }

  // 播放頭該用多快的速度爬，相對原譜速度的比例：原譜這一拍幾秒 ÷ 現場量到的每拍幾秒，
  // 夾在上下限之間。還沒量到現場拍速時回 1（＝照原譜速度播）。這是應用層假設（N2／N4），
  // 不是規格資料。
  //
  // 超過 TEMPO_MAX_INTERVAL_S 沒有新觸發（沿用估拍速時「這段間隔太長、不拿來估拍速」的
  // 同一個門檻）也回 1：現場拍速一旦估到、就會被無限期凍結套用在所有還在響的音，直到下次
  // 觸發才會更新——如果剛好估到一個偏慢的拍速、演奏者之後又完全停手，正在響的音會被這個
  // 已經過時的估計值拖得很長（TEMPO_SCALE_MIN=0.25 頂多拖到 4 倍原長，對一顆 1~2 秒的音
  // 就是 4~8 秒），容易被聽成「卡住」。超過這個門檻就不再信任舊估計，這不會提早切斷任何
  // 音符——音符仍然是靠 remain 自己倒數到 0 才關閉（見 _emitDueNotes()／_releaseDue()），
  // 這裡只是校正倒數的速度，不是強制收音。
  _tempoScale(nowMs) {
    if (this._liveSecPerBeat == null) return 1;
    if (nowMs != null && this._lastAdvanceMs != null
        && (nowMs - this._lastAdvanceMs) / 1000 > TEMPO_MAX_INTERVAL_S) {
      return 1;
    }
    const scale = this._scoreSecPerBeat() / this._liveSecPerBeat;
    return Math.min(TEMPO_SCALE_MAX, Math.max(TEMPO_SCALE_MIN, scale));
  }

  _advancePlayheads(dt, nowMs) {
    if (dt <= 0) return;
    const step = dt * this._tempoScale(nowMs);
    for (const voice of this._voices.values()) {
      const limit = voice.kind === 'accomp' ? this._frontierSec : voice.limitSec;
      voice.playSec = Math.min(voice.playSec + step, limit);
      for (const sounding of voice.sounding.values()) sounding.remain -= step;
    }
  }

  // 逐一檢查每個指派聲部有沒有新觸發：有的話，這一拍上這個聲部若還有沒播出的音就地
  // claim；沒有就把共用拍位推到這個聲部下一個真正有音符的拍，再 claim。
  _handleTriggers(getGestureFor, nowMs) {
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human') continue;
      const gesture = getGestureFor(voice.partId);

      if (voice.lastSeq === null) {
        // 首次觀察：只記基準，不算觸發。
        voice.lastSeq = gesture.triggerSeq;
        voice.lastSlot = gesture.slot;
        continue;
      }
      if (gesture.slot !== voice.lastSlot) {
        // 指派的槽位變了（改指派到別的演奏者、或人數變小被動清掉指派）：別的槽位的觸發
        // 計數是另一條獨立的累加序列，直接拿來比會被誤判成一次憑空冒出來的觸發，讓這個
        // 聲部無端前進一步。重新對齊基準，這一刻不算觸發。
        voice.lastSlot = gesture.slot;
        voice.lastSeq = gesture.triggerSeq;
        continue;
      }
      if (gesture.triggerSeq === voice.lastSeq) continue;
      voice.lastSeq = gesture.triggerSeq;

      if (this._hasPendingInCurrentBeat(voice)) this._claim(voice);
      else { this._advanceToNextNote(voice, nowMs); this._claim(voice); }
    }
  }

  _hasPendingInCurrentBeat(voice) {
    const n = voice.notes[voice.cursor];
    return !!n && n.beatIndex === this._beatIndex;
  }

  // claim：只動「這一個」被觸發的聲部——播放頭夾到這一拍起點、上限推到這一拍結束。
  // 拍內若有多顆音符（十六分音符群），會在接下來幾個 tick 依各自原始時間差自然鋪開，不會
  // 被壓成和弦。
  //
  // 上限只到「這一拍結束」就夠了：長音（例如全音符）自己會不會撐超過這一拍的時長，交給
  // _emitDueNotes()／_releaseDue() 用獨立的 remain 倒數處理（見那兩個函式的註解），不需要
  // 在這裡往前掃這一拍裡的音符去延伸 limitSec——這樣新的觸發可以立刻讓下一個音出來，不會
  // 被前一個還在響的長音卡住（這正是這次要修的「揮手快於原譜就無限累積延遲」的根因）。
  _claim(voice) {
    voice.claimed = true;
    const beat = this._beats[this._beatIndex];
    voice.playSec = Math.max(voice.playSec, beat.startSeconds);
    voice.limitSec = Math.max(voice.limitSec, beat.endSeconds);
  }

  // 把共用拍位推到「這個聲部下一個真正有音符的拍」——不是機械化前進一拍，而是直接跳到
  // voice.notes[voice.cursor] 所在的那一拍，可能一次跨過好幾個沒有音符的空拍（全音符只
  // 需要一次觸發，不用對著空拍反覆揮手；四分音符連續進行時效果等同一拍一次，因為下一個
  // 音就在下一拍）。
  //
  // 這裡不能對「所有」指派聲部都把 playSec／limitSec 推到新拍起點——被路過、但沒被自己的
  // 演奏者觸發的聲部，若音符的 startSeconds 剛好等於新拍起點，會被 _emitDueNotes() 誤判成
  // 到期發聲，等於用另一個名字重新做了一次代打。正確做法：被路過的聲部只丟棄游標（沒接手
  // 的音直接靜音丟棄，不會被之後任何觸發「追討」回來），播放頭與上限完全不動；只有真正
  // 觸發這次前進的那個聲部，才會在這個函式之後緊接著呼叫的 _claim() 裡移動播放頭。
  _advanceToNextNote(voice, nowMs) {
    const nextNote = voice.notes[voice.cursor];
    if (!nextNote) { this._enterFinale(); return; }

    const prevBeatIndex = this._beatIndex;
    this._beatIndex = nextNote.beatIndex;
    this._updateLiveTempo(nowMs, Math.max(1, this._beatIndex - prevBeatIndex));

    const beat = this._beats[this._beatIndex];
    for (const other of this._voices.values()) {
      if (other === voice) continue;
      if (other.kind === 'human') {
        while (other.cursor < other.notes.length && other.notes[other.cursor].beatIndex < this._beatIndex) {
          other.cursor++;
        }
      } else if (other.playSec < beat.startSeconds) {
        other.playSec = beat.startSeconds;
        while (other.cursor < other.notes.length && other.notes[other.cursor].startSeconds < beat.startSeconds) {
          other.cursor++;
        }
      }
    }
    this._frontierSec = beat.endSeconds; // 未指派聲部的上限＝目前推進最遠的那一位
  }

  // 用這次推進的真實間隔（除以跨過的拍數，見 _advanceToNextNote()）估計「現場每拍幾秒」，
  // 指數平滑後混進 _liveSecPerBeat。間隔太短（誤觸發）或太長（中途停下來）都不採用，沿用
  // 上一次量到的值——這整套都是應用層假設（N2／N4），假設演奏者揮得平均、不做 swing。
  _updateLiveTempo(nowMs, beatsSpanned) {
    if (this._lastAdvanceMs != null) {
      const secPerBeat = ((nowMs - this._lastAdvanceMs) / 1000) / beatsSpanned;
      if (secPerBeat > TEMPO_MIN_INTERVAL_S && secPerBeat < TEMPO_MAX_INTERVAL_S) {
        this._liveSecPerBeat = this._liveSecPerBeat == null
          ? secPerBeat
          : this._liveSecPerBeat * (1 - TEMPO_SMOOTHING) + secPerBeat * TEMPO_SMOOTHING;
      }
    }
    this._lastAdvanceMs = nowMs;
  }

  // 曲末：沒有下一個音符了，把所有聲部的上限放到無限，讓尾音／尾奏自然播完。
  _enterFinale() {
    for (const voice of this._voices.values()) voice.limitSec = Infinity;
    this._frontierSec = Infinity;
  }

  // 每個聲部：先關掉到期的音，再把新到期的音開出去（同一 startSeconds 的音符＝和弦，
  // 會在同一次呼叫裡一起處理）。
  //
  // 指派聲部在從沒被接手過之前要整個跳過：playSec／limitSec 的初始值都是 0，如果聲部第一顆
  // 音剛好也是從 tick 0 開始，「note.startSeconds(0) <= playSec(0)」在還沒有任何 claim 發生
  // 時就已經成立，會在還沒被觸發前就搶先發聲——一旦這樣，這個聲部的 cursor 提早往前跑，
  // 等真正的觸發來時 _hasPendingInCurrentBeat() 會誤判成「這拍沒東西」而立刻 advance，
  // 反而把原本該完整撐住的音提前切斷。未指派聲部（伴奏）沒有「接手」這個概念，不受影響。
  _emitDueNotes() {
    for (const voice of this._voices.values()) {
      this._releaseDue(voice);
      if (voice.kind === 'human' && !voice.claimed) continue;
      const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
      while (voice.cursor < voice.notes.length && voice.notes[voice.cursor].startSeconds <= voice.playSec) {
        const n = voice.notes[voice.cursor];
        try { synth?.noteOn(voice.channel, n.note, n.velocity); } catch (err) {}
        voice.sounding.set(n.note, { remain: n.durationSeconds });
        voice.cursor++;
      }
    }
  }

  // 關掉這個聲部裡「剩餘時長真的倒數到 0」的音——remain 由 _advancePlayheads() 依現場拍速
  // 每個 tick 扣減，完全獨立於播放頭的跳躍：不會因為共用拍位的跳躍被提前掐斷，也不會被
  // 還沒放完的長音擋住下一個音出不來（這正是這次要修的兩個 bug 的共同解法）。
  _releaseDue(voice) {
    const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
    for (const [note, sounding] of [...voice.sounding]) {
      if (sounding.remain > 0) continue;
      try { synth?.noteOff(voice.channel, note); } catch (err) {}
      voice.sounding.delete(note);
    }
  }
}
