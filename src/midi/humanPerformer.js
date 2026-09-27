// ============================================================
//  humanPerformer.js — 事件驅動排程器（純邏輯，無 DOM／CDN）
//
//  共用拍位只在「有效觸發」發生的那一刻才前進，其他時間完全靜止。「有效觸發」除了真人揮手，
//  也包含代打（autopilot，見下）：一個聲部只要曾經被真人觸發過一次，之後只要靜止超過
//  `AUTOPILOT_IDLE_MS` 就視同它自己剛觸發了一次，讓音樂繼續往前走；從未被真人觸發過的聲部
//  完全不受影響，維持原地不動（見 `_handleTriggers()` 的說明）。每個聲部有自己的播放頭
//  `playSec`（真實時間 1:1 前進）與上限 `limitSec`（播放頭不能超過的界線）。
//
//  指派聲部：演奏者（或代打）在目前拍上還有沒播出的音，觸發就在原地把上限推到拍尾（claim）；
//  沒有的話，把共用拍位直接推到這個聲部自己下一個真正有音符的拍（`_advanceToNextNote()`，
//  可能一次跨過好幾個沒有音符的空拍——全音符或連續休止只需要一次觸發，不需要對著空拍反覆
//  揮手），再 claim。跳過的過程中，其他被指派聲部若剛好也有音符落在被跳過的拍上，這一輪沒被
//  自己的演奏者（或代打）觸發＝直接靜音丟棄，不會因為共用拍位路過就被誤判成發聲——這是這個
//  排程器最容易出錯的地方，見 `_advanceToNextNote()` 的註解。
//
//  但這一切要先過一道閘門：這個聲部現在還有沒有音在響（`voice.sounding`）。有的話，這次
//  觸發不會立刻生效，只記成「排隊中」（`voice.pendingTrigger`），等舊音自然響完才自動補上，
//  見下面「正在響的音」那段的說明——這是為了不讓新舊音重疊，真人觸發跟代打觸發共用同一套
//  排隊機制。
//
//  代打（`_handleTriggers()` 裡沒有偵測到新的真實觸發時的分支）：只讓「已經觸發過的那個
//  聲部自己」在靜止時繼續前進，不是重新引入一個驅動全體的背景時鐘——共用拍位 `_beatIndex`
//  能不能動，永遠只看有沒有聲部（不論真人還是代打）觸發，跟舊版被拿掉的「電腦代打＋拍速
//  估計器」模型不同：那個版本是所有聲部預設由電腦代打、真人揮手才接手，沒人揮手曲子也會
//  自己前進，讓人覺得不受控（見專案的 git 歷史）；這裡反過來，代打只是「同一個聲部自己的
//  觸發」的延伸，沒被真人觸發過的聲部代打不會啟動。代打的推進間隔目前固定＝目前拍的樂譜
//  原始拍長（之後會改成依這個聲部演奏者剛剛的揮手節奏估計，屆時只會影響「排程下一次代打
//  的時間點」這一件事，不會動到下面「音符播放速度」這段講的 1:1 真實時間倒數）。代打與
//  真人觸發在音量上刻意不同（`_syncVolume()` 把 CC7 調低），方便用耳朵分辨目前是誰在演奏；
//  note-on velocity 完全不受影響，兩者都用樂譜原值。
//
//  音符播放速度直接鎖定 SMF 原速：播放頭前進與正在響的音的剩餘時長（`remain`）都用真實
//  經過秒數 1:1 倒數，不做任何縮放（曾經試過依揮手間隔反推拍速、讓播放頭跟音長跟著揮手
//  快慢縮放的版本，使用者實測後認為「手不動時音符被拖長」不可接受，見專案的 git 歷史；
//  改回這個更簡單的模型——這條規則不受代打影響，代打只決定「何時該視同一次新觸發」，
//  不縮放任何已經在倒數的 `remain`）。哪一拍在原譜上是幾秒來自 `buildBeatGrid()`，是
//  SMF 規格保證的確定性計算；「一次觸發該推進到哪」才是應用層的假設，不是規格。
//
//  未指派聲部（真正的電腦伴奏）：上限永遠等於 `_frontierSec`（全域值＝目前所有指派演奏者
//  推進最遠的那一位），完全不受自己有沒有觸發影響，任何一次觸發把拍位往前推，伴奏的播放頭
//  也會立刻對齊到新拍起點，跟著反應式播放，不會累積落後——這個「瞬間對齊」是刻意的：如果
//  只推上限、放著伴奏播放頭依真實經過時間慢慢爬過去，演奏者揮得比原譜快時，上限每次觸發
//  都被瞬間推遠，伴奏卻只能照真實時間慢慢追，永遠追不上、越差越多（曾經是真的 bug，見
//  專案的 git 歷史）。完全沒有人被指派時，`_frontierSec` 從 `load()` 就直接設成 `Infinity`，
//  等同整份照真實經過時間連續自動播放。
//
//  正在響的音各自倒數自己的原譜時長，完全獨立於播放頭的跳躍：跳拍不會把它提前掐斷，也不會
//  被還沒放完的長音本身的計時邏輯卡住。但「新觸發什麼時候真正生效」會先看同一個聲部現在
//  還有沒有音在響：沒有就立即生效；有的話，觸發先排隊（`voice.pendingTrigger`，只記
//  「有沒有」，不記次數——排隊期間多揮幾次也只補一次），舊音繼續完整響到底，一響完
//  （`sounding` 變空）就自動處理排隊中的那次觸發，不用使用者再揮一次。這樣新舊音保證不會
//  重疊，取捨是新音不再保證 0 delay：如果演奏者揮得比原譜快，新音要等舊音放完才出聲，會感覺
//  比揮手慢半拍；跟上或慢於原譜速度則完全感覺不到延遲。這裡刻意不去估計任何「現場拍速」拿來
//  縮放舊音的剩餘時長、逼它提早結束（那是已經因為「手不動時音符被拖長」出過包、拿掉的機制，
//  見專案的 git 歷史）——排隊只是離散事件的先後順序調整，不涉及任何連續數值的估計或縮放。
//  velocity 一律用樂譜原值，不套用手勢公式；不重播 CC／pitch-bend，音色只在 load() 時套用一次。
// ============================================================

import { buildBeatGrid } from './midiParser.js';

export const DEFAULT_PERFORMER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
});

const CHANNELS_PER_PORT = 16;

/* ═══════════════════════════════════════════
   代打（autopilot）常數——應用層行為，不是規格
   ═══════════════════════════════════════════ */
const AUTOPILOT_IDLE_MS = 800;  // 距這個聲部最近一次真實觸發超過這麼久 → 視同它自己剛觸發了一次
const AUTOPILOT_VOLUME_CC = 64; // 代打時這個聲部的 CC7（GM 預設 100，約 −6dB），方便用耳朵分辨
                                 // 目前是代打還是真人在演奏；只調音量，不動 note-on velocity

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
    cursor: 0,              // 下一個「還沒排程」的音符在 notes 裡的位置
    sounding: new Map(),    // note(音高) → { remain }：還剩幾樂譜秒才該關閉
    playSec: 0,             // 這個聲部的播放頭
    limitSec: 0,            // 播放頭不能超過的界線
    claimed: false,         // 指派聲部是否曾經被自己的演奏者接手過（見 _emitDueNotes 的用法）
    lastSeq: null,          // 上次觀察到的手勢 triggerSeq，null＝還沒對過基準
    lastSlot: undefined,    // 上次觀察到的指派槽位，與現在不同就重新對齊基準（見 _handleTriggers）
    pendingTrigger: false,  // 觸發時這個聲部還有音在響，先排隊，見 _handleTriggers／_releaseDue
    lastRealTriggerMs: null, // 這個聲部最近一次「真實」觸發的時刻；null＝還沒發生過任何真實觸發，
                              // 代打不會啟動（見 _handleTriggers）
    autopilotDueMs: null,    // 下一次代打該發生的時刻；null＝目前不在代打倒數中
    isAutopilot: false,      // 最近一次 claim 是代打還是真人觸發，驅動 _syncVolume() 的 CC7 切換
    _lastSentCc7: 100,       // 上次送出的 CC7 值，避免重送同一個值
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
    // 同理，暫停期間經過的真實時間不該被算成「這個聲部靜止了這麼久」，否則一恢復播放就會對
    // 已經觸發過的聲部誤判成早該代打；只重置「已經觸發過」的聲部，還沒被真實觸發過的維持
    // null（代打不啟動，見 _handleTriggers）。
    const nowMs = performance.now();
    for (const voice of this._voices.values()) {
      if (voice.lastRealTriggerMs != null) voice.lastRealTriggerMs = nowMs;
    }
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

  // 停止／換歌前的清場：收音＋每個聲部的播放狀態全部歸零。
  stop() {
    this.pause();
    for (const voice of this._voices.values()) {
      voice.cursor = 0;
      voice.playSec = 0;
      voice.limitSec = 0;
      voice.claimed = false;
      voice.lastSeq = null;
      voice.lastSlot = undefined;
      voice.pendingTrigger = false;
      voice.lastRealTriggerMs = null;
      voice.autopilotDueMs = null;
      voice.isAutopilot = false;
      voice._lastSentCc7 = 100;
    }
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
   * 取所有聲部（含未指派）playSec 的最大值：未指派聲部照真實經過時間連續前進、指派聲部只在
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

    this._handleTriggers(nowMs, getGestureFor);
    this._advancePlayheads(dt);
    this._emitDueNotes();
  }

  _advancePlayheads(dt) {
    if (dt <= 0) return;
    for (const voice of this._voices.values()) {
      const limit = voice.kind === 'accomp' ? this._frontierSec : voice.limitSec;
      voice.playSec = Math.min(voice.playSec + dt, limit);
      for (const sounding of voice.sounding.values()) sounding.remain -= dt;
    }
  }

  // 逐一檢查每個指派聲部有沒有新的真實觸發：有的話，這一拍上這個聲部若還有沒播出的音就地
  // claim；沒有就把共用拍位固定推進一拍，再 claim（這一拍若剛好也是這個聲部的下一個音，
  // 就順便讓它出聲；不是的話這一拍只是被走過，等下一次觸發繼續往前）。沒有新的真實觸發時，
  // 改檢查這個聲部該不該視同代打（見檔頭「代打」段落）。
  _handleTriggers(nowMs, getGestureFor) {
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
        // 聲部無端前進一步。重新對齊基準，這一刻不算觸發；lastRealTriggerMs 不動——這個
        // 聲部先前有沒有被真實觸發過，跟指派給哪個槽位是兩件事。
        voice.lastSlot = gesture.slot;
        voice.lastSeq = gesture.triggerSeq;
        continue;
      }

      if (gesture.triggerSeq === voice.lastSeq) {
        // 沒有新的真實觸發：檢查這個聲部該不該視同自己剛觸發了一次（代打）。
        if (voice.lastRealTriggerMs == null) continue;       // 從沒被真實觸發過，代打不啟動
        if (voice.cursor >= voice.notes.length) continue;     // 沒有更多音符可代打
        if (voice.sounding.size > 0) continue;                // 有音在響，交給 _releaseDue() 處理
        if (voice.autopilotDueMs == null || nowMs < voice.autopilotDueMs) continue;
        const beat = this._beats[this._beatIndex];
        voice.autopilotDueMs = nowMs + (beat.endSeconds - beat.startSeconds) * 1000; // 目前固定樂譜原速
        voice.isAutopilot = true;
        this._claimOrAdvance(voice);
        this._syncVolume(voice);
        continue;
      }
      voice.lastSeq = gesture.triggerSeq;
      voice.lastRealTriggerMs = nowMs;
      voice.autopilotDueMs = nowMs + AUTOPILOT_IDLE_MS; // 每次真實觸發都重新武裝代打倒數

      // 這個聲部現在還有音在響：不立刻生效，排隊，等 _releaseDue() 發現音響完了再補上
      // （見檔頭「正在響的音」的說明）——不會重疊，代價是這次觸發不是 0 delay。這裡刻意不動
      // voice.isAutopilot：若排隊中的音正好是代打觸發的，交還時的音量標記暫時會沿用代打的
      // 舊值（已知的暫時限制，之後會補上排隊來源標記來修正）。
      if (voice.sounding.size > 0) { voice.pendingTrigger = true; continue; }
      voice.isAutopilot = false;
      this._claimOrAdvance(voice);
      this._syncVolume(voice);
    }
  }

  // 代打與真人觸發共用的音量對比：代打時 CC7 調低，真人觸發時恢復 GM 預設 100，只影響音量、
  // 不影響 note-on velocity（樂譜原值不變）。voice._lastSentCc7 去重，同一個值不重複送。
  _syncVolume(voice) {
    const cc = voice.isAutopilot ? AUTOPILOT_VOLUME_CC : 100;
    if (voice._lastSentCc7 === cc) return;
    voice._lastSentCc7 = cc;
    const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
    try { synth?.controllerChange(voice.channel, 7, cc); } catch (err) {}
  }

  _hasPendingInCurrentBeat(voice) {
    const n = voice.notes[voice.cursor];
    return !!n && n.beatIndex === this._beatIndex;
  }

  // 觸發真正生效時要做的事：這一拍上這個聲部若還有沒播出的音就地 claim；沒有就把共用拍位
  // 推到這個聲部下一個真正有音符的拍，再 claim。_handleTriggers() 觸發當下沒有音在響時
  // 直接呼叫；音還在響時由 _releaseDue() 在音響完的那一刻補呼叫，兩處共用同一份邏輯。
  _claimOrAdvance(voice) {
    if (this._hasPendingInCurrentBeat(voice)) this._claim(voice);
    else { this._advanceToNextNote(voice); this._claim(voice); }
  }

  // claim：只動「這一個」被觸發的聲部——播放頭夾到這一拍起點、上限推到這一拍結束。
  // 拍內若有多顆音符（十六分音符群），會在接下來幾個 tick 依各自原始時間差自然鋪開，不會
  // 被壓成和弦。
  //
  // 上限只到「這一拍結束」就夠了：長音（例如全音符）自己會不會撐超過這一拍的時長，交給
  // _emitDueNotes()／_releaseDue() 用獨立的 remain 倒數處理（見那兩個函式的註解），不需要
  // 在這裡往前掃這一拍裡的音符去延伸 limitSec——這樣新的觸發可以立刻讓下一個音出來，不會
  // 被前一個還在響的長音卡住（這正是要修的「揮手快於原譜就無限累積延遲」的根因）。
  _claim(voice) {
    voice.claimed = true;
    const beat = this._beats[this._beatIndex];
    voice.playSec = Math.max(voice.playSec, beat.startSeconds);
    voice.limitSec = Math.max(voice.limitSec, beat.endSeconds);
  }

  // 把共用拍位推到「觸發這次前進的聲部」自己下一個真正有音符的拍——不是機械化前進一拍，
  // 而是直接跳到 voice.notes[voice.cursor] 所在的那一拍，可能一次跨過好幾個沒有音符的空拍
  // （全音符或連續休止只需要一次觸發，不用對著空拍反覆揮手；四分音符連續進行時效果等同一
  // 拍一次，因為下一個音就在下一拍）。
  //
  // 這裡不能對「所有」指派聲部都把 playSec／limitSec 推到新拍起點——被路過、但沒被自己的
  // 演奏者觸發的聲部，若音符的 startSeconds 剛好等於新拍起點，會被 _emitDueNotes() 誤判成
  // 到期發聲，等於用另一個名字重新做了一次代打。正確做法：被路過的聲部只丟棄游標（沒接手
  // 的音直接靜音丟棄，不會被之後任何觸發「追討」回來），播放頭與上限完全不動；只有真正
  // 觸發這次前進的那個聲部，才會在這個函式之後緊接著呼叫的 _claim() 裡移動播放頭。
  //
  // 這個「路過的聲部只丟游標、不動播放頭」的規則同時保證了 this._beatIndex 只會前進不會
  // 倒退：任何聲部的 cursor 永遠停在「beatIndex >= 目前共用拍位」的音符上（不管是被這個函式
  // 的迴圈路過丟棄、還是被 _emitDueNotes() 正常吐出），所以 voice.notes[voice.cursor] 的
  // beatIndex 不可能小於呼叫這個函式當下的 this._beatIndex。
  _advanceToNextNote(voice) {
    const nextNote = voice.notes[voice.cursor];
    if (!nextNote) { this._enterFinale(); return; } // 這個聲部沒有更多音符了：終局判斷不變

    this._beatIndex = nextNote.beatIndex;

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

  // 關掉這個聲部裡「剩餘時長真的倒數到 0」的音——remain 由 _advancePlayheads() 每個 tick
  // 依真實經過秒數扣減，完全獨立於播放頭的跳躍：不會因為共用拍位的跳躍被提前掐斷，也不會
  // 被還沒放完的長音擋住下一個音出不來。
  //
  // 收完之後如果這個聲部完全沒有音在響了、又有一次觸發正在排隊（見 _handleTriggers()），
  // 立刻補做那次觸發該做的事——這正是「不重疊」的另一半：舊音自然響完的這一刻，就是
  // 排隊中的新音可以出聲的最早時機，不用使用者再揮一次。
  _releaseDue(voice) {
    const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
    for (const [note, sounding] of [...voice.sounding]) {
      if (sounding.remain > 0) continue;
      try { synth?.noteOff(voice.channel, note); } catch (err) {}
      voice.sounding.delete(note);
    }
    if (voice.pendingTrigger && voice.sounding.size === 0) {
      voice.pendingTrigger = false;
      this._claimOrAdvance(voice);
      this._syncVolume(voice);
    }
  }
}
