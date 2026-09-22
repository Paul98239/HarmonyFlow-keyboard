// ============================================================
//  humanPerformer.js — 事件驅動排程器（純邏輯，無 DOM／CDN）
//
//  沒有背景時鐘：共用拍位只在「有效觸發」發生的那一刻才前進，其他時間完全靜止，沒有觸發
//  就不會自己往前走（曾經試過拍速估計器＋電腦代打的版本，因為沒人揮手曲子也會自己前進而
//  被拿掉，見專案的 git 歷史）。每個聲部有自己的播放頭 `playSec`（真實時間 1:1 前進）與
//  上限 `limitSec`（播放頭不能超過的界線）。
//
//  指派聲部：演奏者在目前拍上還有沒播出的音，觸發就在原地把上限推到拍尾（claim）；沒有的
//  話，把共用拍位固定往前推一拍（`_advanceOneBeat()`，`buildBeatGrid()` 的律動拍，不管這拍
//  本身有沒有音符——沒有音符的空拍要靠對應次數的觸發才走得過去，不會一次跳過），再 claim。
//  被路過的那一拍上，其他被指派聲部若剛好也有音符，這一輪沒被自己的演奏者觸發＝直接靜音
//  丟棄，不會被電腦補（沒有代打），也不會因為共用拍位路過就被誤判成發聲——這是這個排程器
//  最容易出錯的地方，見 `_advanceOneBeat()` 的註解。長音（例如全音符）中間沒被觸發的那幾
//  拍不會被自動跳過，演奏者要嘛多揮幾次手把共用拍位走過去、要嘛等其他演奏者的觸發把它帶
//  過去——這個取捨目前刻意不處理，見 CLAUDE.md「拍子從哪裡來」的 N1。
//
//  音符播放速度直接鎖定 SMF 原速：播放頭前進與正在響的音的剩餘時長（`remain`）都用真實
//  經過秒數 1:1 倒數，不做任何現場拍速估計或縮放（曾經試過依揮手間隔反推拍速、讓播放頭
//  跟音長跟著揮手快慢縮放的版本，使用者實測後認為「手不動時音符被拖長」不可接受，見專案
//  的 git 歷史；改回這個更簡單的模型）。哪一拍在原譜上是幾秒來自 `buildBeatGrid()`，是
//  SMF 規格保證的確定性計算；「一次揮手該推進到哪」才是應用層的假設，不是規格——這是這個
//  排程器裡唯一的假設，其餘全部照規格算出來的數字為準。
//
//  未指派聲部（真正的電腦伴奏）：上限永遠等於 `_frontierSec`（全域值＝目前所有指派演奏者
//  推進最遠的那一位），完全不受自己有沒有觸發影響，任何一次觸發把拍位往前推，伴奏的播放頭
//  也會立刻對齊到新拍起點，跟著反應式播放，不會累積落後。完全沒有人被指派時，`_frontierSec`
//  從 `load()` 就直接設成 `Infinity`，等同整份照真實經過時間連續自動播放。
//
//  正在響的音各自倒數自己的原譜時長，完全獨立於播放頭的跳躍：跳拍不會把它提前掐斷，也不會
//  被它擋住不能出下一個音——新觸發永遠立即出聲，舊音一律照它自己完整的原譜秒數播到底，不會
//  被提早收掉。如果演奏者揮得比原譜快，舊音會跟新音疊在一起響一段時間（疊多久＝超前了多少，
//  這是「新音 0 delay」與「舊音不被提早收掉」兩個都要時，數學上必然的取捨）；跟上或慢於
//  原譜速度則完全不會重疊。velocity 一律用樂譜原值，不套用手勢公式；不重播 CC／pitch-bend，
//  音色只在 load() 時套用一次。
// ============================================================

import { buildBeatGrid } from './midiParser.js';

export const DEFAULT_PERFORMER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
});

const CHANNELS_PER_PORT = 16;

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

    this._handleTriggers(getGestureFor);
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

  // 逐一檢查每個指派聲部有沒有新觸發：有的話，這一拍上這個聲部若還有沒播出的音就地
  // claim；沒有就把共用拍位固定推進一拍，再 claim（這一拍若剛好也是這個聲部的下一個音，
  // 就順便讓它出聲；不是的話這一拍只是被走過，等下一次觸發繼續往前）。
  _handleTriggers(getGestureFor) {
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
      else { this._advanceOneBeat(voice); this._claim(voice); }
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
  // 被前一個還在響的長音卡住（這正是要修的「揮手快於原譜就無限累積延遲」的根因）。
  _claim(voice) {
    voice.claimed = true;
    const beat = this._beats[this._beatIndex];
    voice.playSec = Math.max(voice.playSec, beat.startSeconds);
    voice.limitSec = Math.max(voice.limitSec, beat.endSeconds);
  }

  // 把共用拍位固定推進一拍（`buildBeatGrid()` 的律動拍，不管這拍本身有沒有音符）——使用者
  // 明確要求的「一拍一拍」：一次有效拋物線只走一拍，不會像舊版那樣直接跳到這個聲部下一個
  // 真正有音符的拍。休止符要靠對應次數的觸發才走得過去；長音（例如全音符）中間沒被觸發的
  // 那幾拍也不會被自動跳過——這個取捨這次刻意不處理，見 CLAUDE.md 的 N1。這一拍剛好是不是
  // 這個聲部的下一個音，交給 `_claim()` 之後的 `_emitDueNotes()` 自然判斷（是就出聲，不是
  // 這一拍就只是被走過，不需要在這裡特別分支）。
  //
  // 這裡不能對「所有」指派聲部都把 playSec／limitSec 推到新拍起點——被路過、但沒被自己的
  // 演奏者觸發的聲部，若音符的 startSeconds 剛好等於新拍起點，會被 _emitDueNotes() 誤判成
  // 到期發聲，等於用另一個名字重新做了一次代打。正確做法：被路過的聲部只丟棄游標（沒接手
  // 的音直接靜音丟棄，不會被之後任何觸發「追討」回來），播放頭與上限完全不動；只有真正
  // 觸發這次前進的那個聲部，才會在這個函式之後緊接著呼叫的 _claim() 裡移動播放頭。
  _advanceOneBeat(voice) {
    const nextNote = voice.notes[voice.cursor];
    if (!nextNote) { this._enterFinale(); return; } // 這個聲部沒有更多音符了：終局判斷不變

    this._beatIndex += 1; // 固定推進一拍（舊版是 this._beatIndex = nextNote.beatIndex，跳很多拍）

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
  _releaseDue(voice) {
    const synth = voice.kind === 'human' ? this.humanSynth : this.accompSynth;
    for (const [note, sounding] of [...voice.sounding]) {
      if (sounding.remain > 0) continue;
      try { synth?.noteOff(voice.channel, note); } catch (err) {}
      voice.sounding.delete(note);
    }
  }
}
