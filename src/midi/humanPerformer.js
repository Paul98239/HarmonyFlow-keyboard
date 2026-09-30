// ============================================================
//  humanPerformer.js — 事件驅動排程器（純邏輯，無 DOM／CDN）
//
//  共用拍位只在「有效觸發」發生的那一刻才前進，其他時間完全靜止。「有效觸發」除了真人揮手，
//  也包含代打（autopilot，見下）：一個聲部只要曾經被真人觸發過一次，之後整個合奏只要停手超過
//  短暫門檻，電腦就替這些聲部走一拍，讓音樂繼續往前走；從未被真人觸發過的聲部完全不受影響，
//  維持原地不動（見 `_arbitrate()` 的說明）。每個聲部有自己的播放頭 `playSec`（真實時間 1:1
//  前進）與上限 `limitSec`（播放頭不能超過的界線）。
//
//  指派聲部：演奏者（或代打）在目前拍上還有沒播出的音，觸發就在原地把上限推到拍尾（claim）；
//  沒有的話，把共用拍位往前走恰好一拍（`_advanceOneBeat()`，不管這一拍本身有沒有音符），
//  再 claim——這是使用者明確拍板的目標：每一拍（包含空拍）都需要真人自己揮一次手才能往前走，
//  4/4 一個小節就是要揮 4 次，不會一次跳過好幾拍。走過的過程中，其他被指派聲部若剛好也有
//  音符落在被走過的拍上，這一輪沒被自己的演奏者（或代打）觸發＝直接靜音丟棄，不會因為共用
//  拍位路過就被誤判成發聲——這是這個排程器最容易出錯的地方，見 `_advanceOneBeat()` 的註解。
//
//  共用拍位 `_beatIndex` 只在 `_arbitrate()` 這個單一裁決點被改寫，而且一個 tick 最多前進一拍：
//  多位演奏者同時揮手、一個人指派多個聲部（例如左右手）、排隊解除撞上別人的新觸發，都只前進一拍
//  ——每位演奏者只有一個意圖（這一拍他的聲部還有沒播出的音就原地 claim，沒有才前進），跟聲部
//  被處理的先後無關。像樂團一樣，同一拍不管幾個人一起下弓，樂曲位置只往前一拍：幾乎同時、但不在
//  同一個 tick 的揮手也一樣——另一位剛把拍位推到這一拍之後的短暫合併窗（`FOLLOW_WINDOW_MS`）內，
//  晚到的一位視為跟上同一拍，不另外再推一拍（單人自己連續快揮不受影響）。
//
//  但這一切要先過一道閘門（`_isBlocked()`）：這次觸發會不會替這個聲部開一顆新音、而且它還有舊音
//  在響（`voice.sounding`）。是的話，這次觸發不會立刻生效，只記成「排隊中」（`voice.pendingTrigger`），
//  等舊音自然響完才自動補上，見下面「正在響的音」那段的說明——這是為了不讓新舊音重疊。單純走過空拍
//  （沒有新音可開）的觸發不受舊音影響、立即生效：全音符響著的那幾拍，跟著原速每拍揮一次的演奏者
//  不會被卡住；代打只走空拍，所以也從不排隊。
//
//  代打（`_arbitrate()` 在沒有任何真人／排隊動作的 tick 才會看）：合奏層級只有一個倒數
//  （`_autopilotLeftSec`），不是每個聲部各倒各的。任何一位演奏者的任何一次真人動作都讓它重新開始，
//  所以只要還有人在揮手，誰都不會被代打；停手滿第一步門檻（`max(AUTOPILOT_IDLE_MS, 目前拍長 ×
//  AUTOPILOT_IDLE_BEATS)`——慢曲準時每拍揮一次的演奏者不會被搶先走一拍）就替「曾被真人觸發過」的
//  指派聲部整批走一拍，之後每一步等剛走進那一拍的原譜秒數：代打照著原譜的速度走，跟電腦輔助聲部對得上
//  拍。**代打只負責填空拍，絕不會幫使用者觸發任何真的有音符的拍**：到期當下檢查這些聲部下一顆還沒被
//  claim 的音（`_nextUnclaimedNote()`），只要任何一個聲部在目前拍或下一拍還有自己的音，整批不走
//  （`_autopilotBatch()`）——那顆音要它的演奏者自己觸發，而且不能替別人把共用拍位推過去（閒置聲部的
//  代打不會吃掉還在正常演奏的另一位的音）；全部通過才走一拍，這些聲部一起在新拍 claim、標記代打
//  （跟真人觸發共用同一個裁決點，只是來源標記不同）。這不是重新引入驅動全體的背景時鐘：共用拍位能不能
//  動，永遠要先有人真人觸發過，沒被真人觸發過的聲部代打不會替它走。倒數依 tick 的 dt 遞減而不是絕對
//  時間戳，暫停期間不會被當成「靜止」。這個等待時間只用來決定「下一次何時該走」這一個排程時間點，
//  完全不會動到下面「音符播放速度」這段講的 1:1 真實時間倒數。代打與真人觸發在音量上刻意不同
//  （`_syncVolume()` 讓代打的 CC7 貼齊電腦輔助聲部的基準、真人觸發時整體再被 `HUMAN_EMPHASIS_GAIN`
//  凸顯，見 `synth.js`），方便用耳朵分辨目前是誰在演奏；note-on velocity 完全不受影響，兩者都用
//  樂譜原值。**這裡曾經試過「一次觸發跳到下一個真正有音符的拍」（`_beatIndex` 直接跳過空拍，
//  不是固定走一拍），也曾經試過代打改用揮手節奏的指數平滑估計去猜一整段休止該等多久；前者
//  在使用者實際使用後被要求改回「每一拍都要真人自己觸發」，後者則是因為正常演奏遇到合法長
//  休止時，代打會在休止途中提早觸發、等演奏者準時觸發時那次觸發又被排隊補一次，等於同一段
//  音樂被算兩次（棘輪效應，多聲部合奏下會讓其他聲部大量丟音），見專案的 git 歷史，改回這裡
//  描述的「每次只走一拍、代打只填空拍」模型才解決。**
//
//  音符播放速度直接鎖定 SMF 原速：播放頭前進與正在響的音的剩餘時長（`remain`）都用真實
//  經過秒數 1:1 倒數，不做任何縮放（曾經試過依揮手間隔反推拍速、讓播放頭跟音長跟著揮手
//  快慢縮放的版本，使用者實測後認為「手不動時音符被拖長」不可接受，見專案的 git 歷史；
//  改回這個更簡單的模型——這條規則不受代打影響，代打只決定「何時該視同一次新觸發」，
//  不縮放任何已經在倒數的 `remain`）。哪一拍在原譜上是幾秒來自 `buildBeatGrid()`，是
//  SMF 規格保證的確定性計算；「一次觸發該推進到哪」才是應用層的假設，不是規格。
//
//  未指派聲部（電腦輔助的聲部）：上限永遠等於 `_frontierSec`（全域值＝目前所有指派演奏者
//  推進最遠的那一位），完全不受自己有沒有觸發影響，任何一次觸發把拍位往前推，電腦輔助聲部的
//  播放頭也會立刻對齊到新拍起點，跟著反應式播放，不會累積落後——這個「瞬間對齊」是刻意的：如果
//  只推上限、放著它的播放頭依真實經過時間慢慢爬過去，演奏者揮得比原譜快時，上限每次觸發
//  都被瞬間推遠，它卻只能照真實時間慢慢追，永遠追不上、越差越多（曾經是真的 bug，見
//  專案的 git 歷史）。完全沒有人被指派時，`_frontierSec` 從 `load()` 就直接設成 `Infinity`，
//  等同整份照真實經過時間連續自動播放。曲末也是同一個開關：所有指派聲部都沒有還沒被 claim 的音時自動
//  進入終局（`_checkFinale()`），只解除電腦輔助聲部的上限、讓尾奏播完——不需要使用者多揮一下，也不會把
//  指派聲部（包含演奏者缺席的）的上限放到無限、讓它們從舊播放頭往前追趕；只要還有任何一個指派聲部
//  有音沒被 claim，就不會進終局，也不會被誰多揮一下強制播完。沒有任何還沒被 claim 的音的聲部，它的
//  揮手直接忽略（不推進拍位）。
//
//  正在響的音各自倒數自己的原譜時長，完全獨立於播放頭的跳躍：跳拍不會把它提前掐斷，也不會
//  被還沒放完的長音本身的計時邏輯卡住。但「新觸發什麼時候真正生效」要看它會不會替同一個聲部
//  開新音（`_isBlocked()`）：不會（走過空拍、或這拍只是吸收一次多揮的手）就立即生效，舊音照舊
//  倒數、完全不受影響；會、而且這個聲部還有舊音在響，觸發先排隊（`voice.pendingTrigger`，只記
//  「有沒有」，不記次數——排隊期間多揮幾次也只補一次），舊音繼續完整響到底，一響完
//  （`sounding` 變空）就自動處理排隊中的那次觸發，不用使用者再揮一次。這樣新舊音保證不會
//  重疊，取捨是新音不再保證 0 delay：如果演奏者揮得比原譜快，新音要等舊音放完才出聲，會感覺
//  比揮手慢半拍；跟上或慢於原譜速度則完全感覺不到延遲。這裡刻意不去估計任何「現場拍速」拿來
//  縮放舊音的剩餘時長、逼它提早結束（那是已經因為「手不動時音符被拖長」出過包、拿掉的機制，
//  見專案的 git 歷史）——排隊只是離散事件的先後順序調整，不涉及任何連續數值的估計或縮放。
//
//  延音：演奏者比原譜慢時，相連的音（音符結尾到同一個聲部下一個起音點的間隙 ≤ θ，見
//  `SUSTAIN_GAP_DIVISOR`）之間會出現原譜沒有的空白。所以這種音自然段（原譜長度）倒數完後不關，進入
//  延長段，等這個聲部真正的下一個 note-on 那一刻才關（先關再開）；真正的休止（間隙 > θ）照原譜長度
//  收，保留斷奏與休止。延長段不算「舊音還在響」（不擋新觸發），也不新增獨立的上限常數：演奏者閒置超過
//  代打第一步的等待時間、下一顆音被路過丟掉、暫停／停止，延長段就結束；整首自動播放（沒有指派聲部）、
//  最後一顆音、或後繼音已經先發聲的音，都照原譜長度收。電腦輔助聲部一致套用，不然同一首歌裡「你控制的
//  聲部」有延音、電腦輔助的聲部卻有空白，聽起來不一致。
//  velocity 一律用樂譜原值，不套用手勢公式；不重播 CC／pitch-bend，音色只在 load() 時套用一次。
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
   代打（autopilot）常數——應用層行為，不是規格
   ═══════════════════════════════════════════ */
// 代打第一步的最短等待：真人最後一次動作之後，至少停手這麼久才可能開始代打——吸收揮手動作本身需要
// 的時間與手勢偵測延遲用的緩衝，不是在等某段休止的確切長度。實際等待是
// max(這個值, 目前拍長 × AUTOPILOT_IDLE_BEATS)，見 _armAutopilot()。
const AUTOPILOT_IDLE_MS = 800;
// 第一步等待的拍數下限：慢曲（拍長 > AUTOPILOT_IDLE_MS）時，準時每拍揮一次的演奏者兩次揮手之間隔一整
// 拍，等待若只有 800ms，代打會搶在他下一次準時揮手之前先走一拍、他的揮手接著再推一拍——同一拍被算
// 兩次（棘輪效應）。給 1.5 拍的容忍才不會誤判他停手了。
const AUTOPILOT_IDLE_BEATS = 1.5;
// 多人合併窗：某位演奏者的揮手落在「另一位剛剛（真人）把共用拍位推到這一拍」之後這麼短的時間內、而且他自己
// 這一拍還沒動作過，視為「跟上這一拍」，不另外再推一拍——多人幾乎同時揮手是常態，各推一拍會讓合奏
// 從第一下起就比最慢的人多走一拍。單人自己連續快揮不受影響（他永遠是這一拍的第一個動作）。窗長取
// min(FOLLOW_WINDOW_MS, 拍長 × FOLLOW_WINDOW_BEAT_RATIO)，快曲時不會寬過半拍。
const FOLLOW_WINDOW_MS = 250;
const FOLLOW_WINDOW_BEAT_RATIO = 0.4;
// 延音的「小間隙」門檻 θ ＝ ticksPerQuarter / SUSTAIN_GAP_DIVISOR（480 tpq 時 30 tick）：音符結尾到同一個
// 聲部下一個起音點的間隙 ≤ θ 才算相連的音。MuseScore 把相連音符寫成「記譜長度 − 1 tick」（間隙固定 1 tick），
// 真正的最短休止（三十二分休止）≥ 60 tick，θ 落在兩者中間的空檔；用 tick 不用秒，跟速度無關。
const SUSTAIN_GAP_DIVISOR = 16;
// 代打時這個聲部的 CC7（Channel Volume）：目標是校正到約等於電腦輔助聲部的音量基準（它們沒有掛
// synth.js 的 HUMAN_EMPHASIS_GAIN，等於基準 1.0），真正的「凸顯」完全交給真人觸發時的
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
    cursor: 0,              // 下一個「還沒排程」的音符在 notes 裡的位置
    sounding: new Map(),    // note(音高) → { remain, sustainTo, extended }：自然段還剩幾樂譜秒；sustainTo＝
                            // 延音要等的後繼音在 notes 裡的位置（-1＝不延音）；extended＝已進入延長段
    playSec: 0,             // 這個聲部的播放頭
    limitSec: 0,            // 播放頭不能超過的界線
    claimed: false,         // 指派聲部是否曾經被自己的演奏者接手過（見 _emitDueNotes 的用法）
    lastSeq: null,          // 上次觀察到的手勢 triggerSeq，null＝還沒對過基準
    lastSlot: undefined,    // 上次觀察到的指派槽位，與現在不同就重新對齊基準（見 _arbitrate）
    pendingTrigger: false,  // 觸發會開新音、但這個聲部還有舊音在響，先排隊，見 _isBlocked／_arbitrate
    pendingIsAutopilot: false, // 排隊中的觸發是代打還是真人來源；_settle() 交還時靠這個
                               // 欄位正確標記 isAutopilot，見 _arbitrate 的排隊分支
    pendingSinceMs: null,   // 排隊開始的時刻；_settle() 解除排隊時用來算「等了多久」，
                             // 把這段真實時間補回播放頭（見該函式的說明），null＝目前沒在排隊

    lastRealTriggerMs: null, // 這個聲部最近一次「真實」觸發的時刻；null＝還沒發生過任何真實觸發，
                              // 代打不會替它走（見 _autopilotBatch）
    isAutopilot: false,      // 最近一次 claim 是代打還是真人觸發，驅動 _syncVolume() 的 CC7 切換
    _lastSentCc7: 100,       // 上次送出的 CC7 值，避免重送同一個值
  };
}

// 指派聲部只配 humanSynth 的 channel、未指派聲部只配 assistSynth 的 channel——被指派聲部
// 沒接手就是靜音，不需要幫它在 assistSynth 上保留一條代打用的 channel。兩個池子各自獨立
// 配額用完的聲部回報在 unplaced，這一輪不會出聲。
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
    this._beatIndex = 0;       // 目前共用拍位在 _beats 裡的 index
    this._startBeatIndex = 0;  // load() 算出的起始拍位，stop() 要退回這裡
    this._frontierSec = 0;     // 未指派聲部的播放頭上限＝目前指派演奏者推進最遠的那一位
    this._sustainEnabled = false;  // 有指派聲部（有演奏者可能比原譜慢）才延音；load() 決定，不隨播放變動
    this._idleSec = 0;             // 距離上一次「有音可接手的真人揮手」過了幾秒（延音跟代打綁在一起的計時）
    this._autopilotLeftSec = null; // 合奏層級的代打倒數（秒，依 tick 的 dt 遞減）；null＝沒在倒數
    this._realAdvanceMs = null;    // 最近一次「真人」把共用拍位推進一拍的時刻（合併窗用，代打不算）
    this._actedBeat = new Map();   // 槽位 → 這位演奏者最近一次動作（接手或前進）所在的拍
    this.unplacedPartIds = [];
    this._playing = false;
    this._lastTickMs = null;   // null＝下一次 tick() 不推進播放頭，只記錄基準
  }

  setSynths(assistSynth, humanSynth) {
    this.assistSynth = assistSynth;
    this.humanSynth = humanSynth;
  }

  /**
   * 載入這首歌：建立聲部、套初始音色，準備好共用拍格線與起始拍位。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（每顆音會被標上 beatIndex／
   *        sustainTo，同一份譜重新載入的結果相同；其餘不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._beats = score ? buildBeatGrid(score) : [];
    this._voices = new Map();
    this.unplacedPartIds = [];
    this._sustainEnabled = false;
    if (!score) return;

    // 沒有拍格線（SMPTE division，A5）：指派聲部的推進全靠拍位，算不出來就退回整首自動播放——忽略指派。
    const assignMap = !this._beats.length ? new Map()
      : assignments instanceof Map ? assignments : new Map(assignments || []);
    const partById = new Map(score.parts.map((p) => [p.id, p]));

    const { voices, unplaced } = buildVoices(score, assignMap, this.assistSynth, this.humanSynth, this.cfg);
    this._voices = voices;
    this.unplacedPartIds = unplaced;

    for (const voice of this._voices.values()) {
      const part = partById.get(voice.partId);
      const synth = voice.kind === 'human' ? this.humanSynth : this.assistSynth;
      this._applyInitialPatch(synth, voice.channel, part);
      // CC7 不在「reset all controllers」清單裡（已用 GML-v1 §3.2.5.2 驗證），channel 又是
      // 跨曲重複使用：明確送一次 GM 預設值 100，避免沿用到別的曲子／別的聲部在同一個
      // channel 索引上留下的音量設定。
      try { synth?.controllerChange(voice.channel, 7, 100); } catch (err) {}
    }

    this._tagNotesWithBeat();
    this._tagLegato();
    this._sustainEnabled = [...this._voices.values()].some((v) => v.kind === 'human' && v.notes.length > 0);
    this._startBeatIndex = this._computeStartBeatIndex();
    this._beatIndex = this._startBeatIndex;

    this._frontierSec = this._initialFrontierSec();
  }

  // 未指派聲部的播放頭上限初值（load() 與 _resetPlayback() 共用）。
  // 有指派聲部的音符：前奏——未指派聲部先照實時播到第一個真人入場點，之後由觸發推進。
  // 完全沒有人被指派、或指派了但完全沒有音符時，永遠不會有觸發，_frontierSec 沒有任何路徑可以
  // 被推進——必須在這裡顯式退回「整份照真實經過時間連續自動播放」（Infinity），不能指望一般
  // 邏輯自動長出這個特例（沒有拍格線時 load() 已經忽略指派，也會走到這裡）。
  _initialFrontierSec() {
    const hasHumanNotes = [...this._voices.values()].some((v) => v.kind === 'human' && v.notes.length > 0);
    return hasHumanNotes ? this._beats[this._beatIndex].startSeconds : Infinity;
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

  // 標記每顆音延音要等的後繼音（見檔頭「正在響的音」）：音符結尾到同一個聲部下一個起音點的間隙 ≤ θ
  // （SUSTAIN_GAP_DIVISOR）就記下那顆後繼音在聲部 notes 裡的位置（sustainTo），否則 -1。沒有 tick
  // 換算（SMPTE division）一律 -1。
  _tagLegato() {
    const tpq = this._score.ticksPerQuarter;
    const theta = tpq ? Math.round(tpq / SUSTAIN_GAP_DIVISOR) : -1;
    for (const voice of this._voices.values()) {
      const starts = voice.notes.map((n) => n.startTick); // notes 已依 startTick 排序
      for (const n of voice.notes) {
        let lo = 0, hi = starts.length;                   // 第一個 startTick >= n.endTick 的位置
        while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < n.endTick) lo = mid + 1; else hi = mid; }
        n.sustainTo = theta >= 0 && lo < starts.length && starts[lo] - n.endTick <= theta ? lo : -1;
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
    // 避免暫停期間累積的時間被當成一次巨大的 dt：把播放頭瞬間推老遠，也會把代打倒數（每個 tick 依
    // dt 遞減，見 _arbitrate）一口氣扣光、一恢復播放就誤判成早該代打。第一個 tick 的 dt 是 0。
    this._lastTickMs = null;
  }

  // 暫停：收掉還在響的音，播放頭與拍位都保留（下次播放從原處繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    this.silence();
  }

  silence() {
    for (const voice of this._voices.values()) {
      const synth = voice.kind === 'human' ? this.humanSynth : this.assistSynth;
      for (const note of voice.sounding.keys()) {
        try { synth?.noteOff(voice.channel, note); } catch (err) {}
      }
      voice.sounding.clear();
      try { synth?.controllerChange(voice.channel, 123, 0); } catch (err) {} // CC123 All Notes Off 當保險
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
      voice.playSec = 0;
      voice.limitSec = 0;
      voice.claimed = false;
      voice.lastSeq = null;
      voice.lastSlot = undefined;
      voice.pendingTrigger = false;
      voice.pendingIsAutopilot = false;
      voice.pendingSinceMs = null;
      voice.lastRealTriggerMs = null;   // 代打要等真人重新觸發過才會啟動
      voice.isAutopilot = false;
      // CC7 要明確送回基準：代打留下的 85 還在合成器上，而 _lastSentCc7 的去重會擋掉之後的重送。
      voice._lastSentCc7 = 100;
      const synth = voice.kind === 'human' ? this.humanSynth : this.assistSynth;
      try { synth?.controllerChange(voice.channel, 7, 100); } catch (err) {}
    }
    this._beatIndex = this._startBeatIndex;
    this._frontierSec = this._initialFrontierSec();
    this._idleSec = 0;
    this._autopilotLeftSec = null;
    this._realAdvanceMs = null;
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
    return total > 0 ? Math.min(sec, total) : sec; // 電腦輔助聲部的上限在終局變 Infinity，播放頭會一直往後走，夾住不超過總長
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

    this._idleSec += dt;
    this._elapseNotes(dt);
    this._arbitrate(nowMs, dt, getGestureFor);
    this._checkFinale();
    this._advancePlayheads(dt);
    this._emitDueNotes();
  }

  // 正在響的音分兩段：自然段各自倒數自己的原譜時長（remain 依真實經過秒數扣減，完全獨立於播放頭的跳躍：
  // 不會因為共用拍位的跳躍被提前掐斷，也不會被還沒放完的長音擋住下一個音出不來）；倒數到 0 之後，
  // 相連的音（間隙 ≤ θ）在還允許延音、而且後繼音還沒發出（也沒被丟掉）時不關，進入延長段——演奏者比
  // 原譜慢時，相連的音之間才不會出現原譜沒有的空白；後繼音若已經先發聲（例如電腦輔助聲部的播放頭跳拍），
  // 就沒有東西可等，不能延（會掛到閒置才收）——其餘照原樣關掉。延長段由這個聲部真正的下一個 note-on（_emitDueNotes）、
  // 演奏者閒置過久（_sustainAllowed）、下一顆音被路過丟掉（_advanceOneBeat）或暫停收掉。放在裁決之前：
  // 這個 tick 剛放完的音，這個 tick 的裁決就已經看得到（排隊的觸發在舊音響完的那一刻解除）。
  _elapseNotes(dt) {
    const sustain = this._sustainAllowed();
    for (const voice of this._voices.values()) {
      const synth = voice.kind === 'human' ? this.humanSynth : this.assistSynth;
      for (const [note, sounding] of [...voice.sounding]) {
        if (!sounding.extended) {
          sounding.remain -= dt;
          if (sounding.remain > 0) continue;
          if (sustain && sounding.sustainTo >= voice.cursor) { sounding.extended = true; continue; }
        } else if (sustain) continue;
        try { synth?.noteOff(voice.channel, note); } catch (err) {}
        voice.sounding.delete(note);
      }
    }
  }

  // 現在還允許延音嗎：只有有演奏者的時候才需要（整首自動播放照原譜長度收），而且演奏者閒置超過代打第一步的
  // 等待時間就不再延——延音的上限跟代打綁在一起，不另外發明一個延音上限常數。
  _sustainAllowed() {
    return this._sustainEnabled && this._idleSec < this._firstStepWaitSec();
  }

  // 收掉這個聲部延長中的音（先關，呼叫端再開新音，同音高重複時新音才不會被連帶關掉）。
  _endExtended(voice) {
    const synth = voice.kind === 'human' ? this.humanSynth : this.assistSynth;
    for (const [note, sounding] of [...voice.sounding]) {
      if (!sounding.extended) continue;
      try { synth?.noteOff(voice.channel, note); } catch (err) {}
      voice.sounding.delete(note);
    }
  }

  _advancePlayheads(dt) {
    if (dt <= 0) return;
    for (const voice of this._voices.values()) {
      const limit = voice.kind === 'assist' ? this._frontierSec : voice.limitSec;
      voice.playSec = Math.min(voice.playSec + dt, limit);
    }
  }

  // ── 單一裁決點 ──
  // 一個 tick 裡「共用拍位 _beatIndex 要不要動」只在這裡決定，而且最多前進一拍——跟有幾個聲部、
  // 幾位演奏者同時動作、聲部被處理的先後都無關。真人觸發、排隊解除、代打三種來源先收集起來，依
  // 演奏者槽位分組後才一起裁決（一個人指派多個聲部＝一次意圖，不是每個聲部各推一拍）：
  //   1. 觀察：誰有新的真實觸發、誰的排隊可以解除（舊音放完了）；被舊音擋住的觸發只記成排隊。沒有任何
  //      還沒被 claim 的音的聲部沒有東西可以接手，它的揮手直接忽略——不推進拍位，也不會讓全曲進終局。
  //   2. 裁決：每個槽位的意圖只有一個——他這一拍的聲部還有沒播出的音、或這次揮手落在別人剛把拍位推進的
  //      合併窗內（跟上同一拍，見 _followsCurrentBeat），就原地 claim（stay），否則前進（advance）。stay
  //      的先 claim（把上限推到拍尾，才不會被接下來的前進當成「路過」丟掉）；有任何 advance 就把共用
  //      拍位前進恰好一拍，advance 的一起在新拍 claim。
  //   3. 沒有任何真人／排隊動作的 tick 才輪到代打：合奏層級只有一個倒數（_autopilotLeftSec），任何真人
  //      動作都讓它重新開始，所以只要有人還在揮手，誰都不會被代打；到期時整批一起走（_autopilotBatch）。
  _arbitrate(nowMs, dt, getGestureFor) {
    if (this._autopilotLeftSec != null) this._autopilotLeftSec -= dt;

    const actors = []; // 這個 tick 要動作、而且沒被舊音擋住的指派聲部
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

      const isNewTrigger = gesture.triggerSeq !== voice.lastSeq;
      if (isNewTrigger) {
        voice.lastSeq = gesture.triggerSeq;
        voice.lastRealTriggerMs = nowMs;
      }
      if (!isNewTrigger && !voice.pendingTrigger) continue;

      if (!this._nextUnclaimedNote(voice)) {
        // 這個聲部已經沒有任何還沒被 claim 的音：沒有東西可以接手，揮手不推進任何東西。不能讓它推進
        // 共用拍位（會把別人的音路過丟掉），也不能讓它觸發終局（會把別人剩下的音強制播完）。
        voice.pendingTrigger = false;
        voice.pendingSinceMs = null;
        continue;
      }

      if (isNewTrigger) this._idleSec = 0;

      const follows = this._followsCurrentBeat(gesture.slot, nowMs);
      if (this._isBlocked(voice, follows)) {
        // 這次觸發會開新音、但這個聲部還有舊音在響：不立刻生效，排隊，等舊音響完的那個 tick 再一起
        // 裁決（見檔頭「正在響的音」的說明）——不會重疊，代價是這次觸發不是 0 delay。真實觸發永遠
        // 把排隊來源覆蓋成 pendingIsAutopilot=false：即使排隊中的觸發原本是代打，真人一觸發就
        // 直接升級成人為來源，這是「即時介入」在排隊情境下的具體實作——不打斷正在響的音，但
        // 確保它放完後接手的音量是真人身分，不會停留在代打的音量。
        if (isNewTrigger) {
          voice.pendingTrigger = true;
          voice.pendingIsAutopilot = false;
          voice.pendingSinceMs = nowMs; // 排隊等了多久，_settle() 解除時要補回播放頭
        }
        continue;
      }
      // 沒被擋住：新的觸發，或排隊中的觸發現在可以解除（兩者同一個 tick 撞在一起就合成一次）。
      actors.push({ voice, slot: gesture.slot, real: isNewTrigger, fromPending: voice.pendingTrigger, follows });
    }

    let autopilots = [];
    if (!actors.length && this._autopilotLeftSec != null && this._autopilotLeftSec <= 0) {
      autopilots = this._autopilotBatch();
      if (!autopilots.length) this._autopilotLeftSec = null; // 整批不走：等真人下一次動作再重新倒數
    }
    if (!actors.length && !autopilots.length) return;

    const slots = new Map(); // 槽位 → 這個演奏者這個 tick 動作的聲部
    for (const a of actors) {
      if (!slots.has(a.slot)) slots.set(a.slot, []);
      slots.get(a.slot).push(a);
    }
    const stayers = [], advancers = [];
    for (const group of slots.values()) {
      (group.some((a) => a.follows || this._hasPendingInCurrentBeat(a.voice)) ? stayers : advancers).push(...group);
    }
    for (const voice of autopilots) advancers.push({ voice, autopilot: true });

    for (const a of stayers) this._claim(a.voice);
    for (const a of stayers) this._actedBeat.set(a.slot, this._beatIndex);
    if (advancers.length) this._advanceOneBeat(advancers.map((a) => a.voice));
    for (const a of advancers) this._claim(a.voice);
    if (advancers.length) {
      // 合併窗只從「真人」的前進算起：代打走的那一步不算——演奏者緊接著的準時揮手是他自己的下一拍，
      // 不是「跟上代打走到的那一拍」，被合併窗吸收就會讓他的音晚一拍。
      const real = advancers.filter((a) => !a.autopilot);
      this._realAdvanceMs = real.length ? nowMs : null;
      for (const a of real) this._actedBeat.set(a.slot, this._beatIndex);
    }
    // 未指派聲部的上限＝目前推進最遠的拍尾；用 Math.max 而不是直接指定，這樣「就地 claim」
    // （沒有前進，例如演奏者剛入場的第一次接手）也會一併推進，不會漏掉——這是先前查出的既有
    // bug（第一次 claim 不會推進 frontier，造成入場當下電腦輔助聲部也跟著卡住一拍）；用 Math.max 也能
    // 保證不會蓋掉 _checkFinale() 已經設成的 Infinity。
    this._frontierSec = Math.max(this._frontierSec, this._beats[this._beatIndex].endSeconds);

    for (const a of [...stayers, ...advancers]) this._settle(a, nowMs);
    this._armAutopilot(actors.length > 0);
  }

  // 這次觸發現在能不能生效：只有「會替這個聲部開一顆新音、而且舊音還在響」才擋（新舊音不重疊，見
  // 檔頭「正在響的音」）。目標拍＝這個聲部目前拍還有沒播出的音、或這次揮手是跟上同一拍（follows），
  // 就是原地接手（目前拍），否則前進到下一拍；目標拍裡還沒被 claim 涵蓋的音才算「會開的新音」。單純
  // 走過空拍（沒有新音可開）、或這拍只是吸收一次多揮的手（剩下的音早已被 claim 涵蓋、會自己依原譜
  // 時間發聲），不會多出任何聲音，立即生效——不然全音符響著的那幾拍，每次揮手都被卡住、合併成一次，
  // 聲部從此落後好幾拍。
  _isBlocked(voice, follows) {
    if (!this._isSoundingNaturally(voice)) return false;
    const next = this._nextUnclaimedNote(voice);
    return !!next && next.beatIndex <= this._beatIndex + (follows || this._hasPendingInCurrentBeat(voice) ? 0 : 1);
  }

  // 這個聲部有沒有音還在自然段（原譜長度還沒倒數完）：延長段的音是「已經自然結束、只是還沒關」，新音本來就
  // 該接在它後面（延音的意義），不算重疊，也不能擋住觸發（不然觸發等舊音、舊音等新音，互相等死）。
  _isSoundingNaturally(voice) {
    for (const s of voice.sounding.values()) if (!s.extended) return true;
    return false;
  }

  // 這位演奏者這次揮手是不是「跟上同一拍」：另一位剛剛（真人）把共用拍位推到目前這一拍、還在合併窗內，
  // 而且他自己這一拍還沒動作過（見 FOLLOW_WINDOW_MS）。
  _followsCurrentBeat(slot, nowMs) {
    if (this._realAdvanceMs == null || this._actedBeat.get(slot) === this._beatIndex) return false;
    const beat = this._beats[this._beatIndex];
    const windowMs = Math.min(FOLLOW_WINDOW_MS, (beat.endSeconds - beat.startSeconds) * 1000 * FOLLOW_WINDOW_BEAT_RATIO);
    return nowMs - this._realAdvanceMs <= windowMs;
  }

  // 代打這一步要替哪些聲部走一拍：所有「曾被真實觸發過、而且還有沒被 claim 的音」的指派聲部。只要其中
  // 任何一個在目前拍或下一拍還有自己的音，整批不走（回傳空陣列）——那顆音要它的演奏者自己觸發，代打
  // 不能替他走過去，也不能替別人把共用拍位推過去（閒置聲部的代打不會吃掉還在正常演奏的另一位的音）。
  // 走一拍保證落在每個聲部下一顆音之前，所以絕不會開任何新音，也不會跳過任何拍。
  _autopilotBatch() {
    const batch = [];
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human' || voice.lastRealTriggerMs == null) continue;
      const next = this._nextUnclaimedNote(voice);
      if (!next) continue;                                  // 沒有更多音符：不需要代打，也不擋別人
      if (next.beatIndex <= this._beatIndex + 1) return [];
      batch.push(voice);
    }
    return batch;
  }

  // 重新武裝合奏層級的代打倒數。真人動作之後：至少等 AUTOPILOT_IDLE_MS、也至少等 AUTOPILOT_IDLE_BEATS
  // 拍，才算他停手了；代打走過一步之後：下一步等剛走進的那一拍的原譜秒數——代打照著原譜的速度走，跟
  // 電腦輔助聲部的節奏對得上（固定間隔在慢曲會跟準時的揮手重複計拍）。這個時間只決定「下一次何時該
  // 走」這一個排程時間點，絕不縮放任何正在響的音的剩餘時長。
  _armAutopilot(afterReal) {
    const beat = this._beats[this._beatIndex];
    this._autopilotLeftSec = afterReal ? this._firstStepWaitSec() : beat.endSeconds - beat.startSeconds;
  }

  // 「演奏者停手多久算閒置」：代打第一步的等待時間，也是延音的上限（見 _sustainAllowed）。
  _firstStepWaitSec() {
    const beat = this._beats[this._beatIndex];
    return Math.max(AUTOPILOT_IDLE_MS / 1000, (beat.endSeconds - beat.startSeconds) * AUTOPILOT_IDLE_BEATS);
  }

  // 曲末：所有指派聲部都沒有還沒被 claim 的音（沒有東西需要再觸發了）就自動進入——不需要使用者多揮一下。
  // 只解除電腦輔助聲部的上限，讓尾奏照真實時間播完；指派聲部的上限不動（只有已 claim 未發聲的音會播完），
  // 不會把早就沒人揮手的聲部從舊播放頭往前追趕。只要還有任何一個指派聲部有音沒被 claim（包含演奏者缺席
  // 的聲部），就不會進終局。
  _checkFinale() {
    if (this._frontierSec === Infinity) return;
    let anyHuman = false;
    for (const voice of this._voices.values()) {
      if (voice.kind !== 'human') continue;
      anyHuman = true;
      if (this._nextUnclaimedNote(voice)) return;
    }
    if (anyHuman) this._frontierSec = Infinity;
  }

  // 裁決完成後、每個動作過的聲部收尾：標記來源（決定 CC7 音量）、補償排隊等掉的時間、送音量。
  _settle({ voice, real, autopilot, fromPending }, nowMs) {
    // 代打＝代打身分；真實觸發＝真人身分；純粹的排隊解除＝排隊當下記錄的來源（交還時才正確標記）。
    voice.isAutopilot = autopilot ? true : real ? false : voice.pendingIsAutopilot;
    if (fromPending) {
      // 手勢發生到排隊解除之間流逝的真實時間，_claim() 的 Math.max() 只保證播放頭不倒退，
      // 不會自動補回來——不補的話，這一拍的時間軸要等到「排隊解除的這一刻」才開始算，會讓
      // 這個聲部從此永遠落後一拍。這裡把等掉的時間補回播放頭，但夾在「這一拍第一顆還沒發聲
      // 的音」的起點以內（voice.cursor 這時候還沒被這次 tick 的 _emitDueNotes 動過，正好是
      // 「還沒發聲」的那一顆），避免補過頭讓還沒到時間的音提早出聲。
      const waitedSec = voice.pendingSinceMs != null ? Math.max(0, (nowMs - voice.pendingSinceMs) / 1000) : 0;
      voice.pendingTrigger = false;
      voice.pendingSinceMs = null;
      if (waitedSec > 0) {
        const nextNote = voice.notes[voice.cursor];
        const ceiling = nextNote ? nextNote.startSeconds : voice.limitSec;
        voice.playSec = Math.min(voice.playSec + waitedSec, ceiling);
      }
    }
    this._syncVolume(voice);
  }

  // 這個聲部「目前這次 claim 涵蓋範圍之後」的下一顆音——刻意不是直接看
  // voice.notes[voice.cursor]：這個方法在 _arbitrate() 的 claim 剛執行完、_emitDueNotes()
  // 這個 tick 還沒機會把 cursor 推過剛接手的那顆音之前就可能被呼叫（見 _checkFinale），這時候
  // cursor 還停在「剛被接手的音」本身，要往後掃到第一顆「還沒被目前這次 claim 涵蓋」
  // （startSeconds >= voice.limitSec）的音才對。一次 claim 通常只涵蓋一拍份的音符，這個迴圈的實際
  // 跑動次數很小。沒有下一顆音了就回傳 null。
  _nextUnclaimedNote(voice) {
    let i = voice.cursor;
    while (i < voice.notes.length && voice.notes[i].startSeconds < voice.limitSec) i++;
    return voice.notes[i] || null;
  }

  // 代打與真人觸發共用的音量對比：代打時 CC7 調低，真人觸發時恢復 GM 預設 100，只影響音量、
  // 不影響 note-on velocity（樂譜原值不變）。voice._lastSentCc7 去重，同一個值不重複送。
  _syncVolume(voice) {
    const cc = voice.isAutopilot ? AUTOPILOT_VOLUME_CC : 100;
    if (voice._lastSentCc7 === cc) return;
    voice._lastSentCc7 = cc;
    const synth = voice.kind === 'human' ? this.humanSynth : this.assistSynth;
    try { synth?.controllerChange(voice.channel, 7, cc); } catch (err) {}
  }

  _hasPendingInCurrentBeat(voice) {
    const n = voice.notes[voice.cursor];
    return !!n && n.beatIndex === this._beatIndex;
  }

  // claim：只動「這一個」被觸發的聲部——播放頭夾到這一拍起點、上限推到這一拍結束（就算這一拍對
  // 這個聲部來說是空拍也照樣 claim——claim 只是「把我的播放範圍延伸到這一拍」，這一拍沒有音符
  // 就是沒有音符可以發聲，不會憑空冒出聲音；使用者明確要求每一拍都要真人自己揮手才能往前走，
  // 所以不能像舊版那樣直接跳到這個聲部下一個真正有音符的拍）。拍內若有多顆音符（十六分音符群），
  // 會在接下來幾個 tick 依各自原始時間差自然鋪開，不會被壓成和弦。
  //
  // 上限只到「這一拍結束」就夠了：長音（例如全音符）自己會不會撐超過這一拍的時長，交給
  // _elapseNotes() 用獨立的 remain 倒數處理，不需要在這裡往前掃這一拍裡的音符去延伸
  // limitSec——這樣新的觸發可以立刻讓下一個音出來，不會被前一個還在響的長音卡住（這正是要修的
  // 「揮手快於原譜就無限累積延遲」的根因）。
  _claim(voice) {
    voice.claimed = true;
    const beat = this._beats[this._beatIndex];
    voice.playSec = Math.max(voice.playSec, beat.startSeconds);
    voice.limitSec = Math.max(voice.limitSec, beat.endSeconds);
  }

  // 把共用拍位往前走恰好一拍（使用者明確拍板的目標：每一拍都需要真人自己揮一次手，包含
  // 空拍——4/4 一個小節就是要揮 4 次，不會像舊版那樣一次跳到這個聲部下一個真正有音符的拍）。
  // advancers 是這個 tick 要前進的所有聲部（一次裁決只會呼叫一次，見 _arbitrate()）；這一拍剛好
  // 是不是其中某個聲部自己的下一個音，交給 _claim() 之後的 _emitDueNotes() 自然判斷；不是的話
  // 這一拍對那個聲部而言就只是被走過，不需要在這裡特別分支。呼叫端保證前進的聲部在目前拍之後還有
  // 沒被 claim 的音（真人動作：見 _arbitrate 對沒有音可接手的聲部的忽略；代打：見 _autopilotBatch），
  // 所以共用拍位不會走出拍格線。
  //
  // 這裡不能對「所有」指派聲部都把 playSec／limitSec 推到新拍起點——被路過、但沒被自己的
  // 演奏者觸發的聲部，若音符的 startSeconds 剛好等於新拍起點，會被 _emitDueNotes() 誤判成
  // 到期發聲，等於用另一個名字重新做了一次代打。正確做法：被路過、且真的沒被接手過的音直接
  // 丟棄游標（不會被之後任何觸發「追討」回來），播放頭與上限完全不動；已經合法接手、只是
  // 播放頭還沒走到的音則保留 cursor 原地不動、留給 _emitDueNotes() 自然吐出（見下方迴圈裡
  // `startSeconds >= other.limitSec` 那個條件——這是先前查出的既有 bug：舊版不分青紅皂白
  // 一律丟棄，已合法接手的音也被誤丟）。只有真正要前進的那些聲部，才會在這個函式之後緊接著
  // 呼叫的 _claim() 裡移動播放頭。
  //
  // 改成「只走一拍」之後，舊版曾經記錄過的一個邊界案例（this._beatIndex 可能因為「保留已
  // 接手音的游標」這個機制短暫倒退）已經不會發生：_beatIndex 現在永遠只用 += 1 往前挪，
  // 不會再有「直接跳到某個目標拍」的動作，也就不存在「目標拍剛好比目前位置更早」這種可能。
  _advanceOneBeat(advancers) {
    this._beatIndex += 1;

    const beat = this._beats[this._beatIndex];
    for (const other of this._voices.values()) {
      if (advancers.includes(other)) continue;
      if (other.kind === 'human') {
        // 只丟真的沒被接手過的音（startSeconds >= other.limitSec）；已經合法接手、只是
        // 播放頭還沒走到的音（startSeconds < limitSec）留給 _emitDueNotes() 自然吐出，
        // 不能因為共用拍位被別的聲部推遠就連帶被這裡誤丟——這是先前查出的既有 bug。
        const before = other.cursor;
        while (other.cursor < other.notes.length
               && other.notes[other.cursor].beatIndex < this._beatIndex
               && other.notes[other.cursor].startSeconds >= other.limitSec) {
          other.cursor++;
        }
        if (other.cursor > before) this._endExtended(other); // 延長中的音在等的下一顆音沒了，不用再等
      } else if (other.playSec < beat.startSeconds) {
        other.playSec = beat.startSeconds;
        const before = other.cursor;
        while (other.cursor < other.notes.length && other.notes[other.cursor].startSeconds < beat.startSeconds) {
          other.cursor++;
        }
        if (other.cursor > before) this._endExtended(other);
      }
    }
  }

  // 每個聲部把新到期的音開出去（同一 startSeconds 的音符＝和弦，會在同一次呼叫裡一起處理）。
  //
  // 指派聲部在從沒被接手過之前要整個跳過：playSec／limitSec 的初始值都是 0，如果聲部第一顆
  // 音剛好也是從 tick 0 開始，「note.startSeconds(0) <= playSec(0)」在還沒有任何 claim 發生
  // 時就已經成立，會在還沒被觸發前就搶先發聲——一旦這樣，這個聲部的 cursor 提早往前跑，
  // 等真正的觸發來時 _hasPendingInCurrentBeat() 會誤判成「這拍沒東西」而立刻 advance，
  // 反而把原本該完整撐住的音提前切斷。未指派聲部（電腦輔助）沒有「接手」這個概念，不受影響。
  _emitDueNotes() {
    for (const voice of this._voices.values()) {
      if (voice.kind === 'human' && !voice.claimed) continue;
      const synth = voice.kind === 'human' ? this.humanSynth : this.assistSynth;
      // 指派聲部（human）額外要求 startSeconds < voice.limitSec：voice.playSec 會被
      // _advancePlayheads() 依真實時間自然爬升、夾在 voice.limitSec（＝目前已經 claim 到的
      // 拍尾）；beat.endSeconds 精確等於下一拍的 beat.startSeconds，如果只比對
      // startSeconds <= playSec，一旦真實時間單純流逝到 playSec 追上這個邊界，下一拍第一顆
      // 音會在完全沒有被 claim 的情況下「自己」發聲——一次一拍模型下每一次 claim 的範圍剛好
      // 卡在下一拍起點，這個邊界問題因此變得每拍都會撞到，不能沿用舊版「只在特定情況才明顯」
      // 的判斷。電腦輔助聲部（assist）沒有這條額外限制：它本來就該在 _frontierSec 範圍內反應式
      // 連續播放，不需要逐拍觸發。
      const limit = voice.kind === 'human' ? voice.limitSec : Infinity;
      while (voice.cursor < voice.notes.length
             && voice.notes[voice.cursor].startSeconds <= voice.playSec
             && voice.notes[voice.cursor].startSeconds < limit) {
        const n = voice.notes[voice.cursor];
        this._endExtended(voice); // 這個聲部真正的下一個 note-on：延長中的舊音在同一刻收掉（先關再開）
        try { synth?.noteOn(voice.channel, n.note, n.velocity); } catch (err) {}
        voice.sounding.set(n.note, { remain: n.durationSeconds, sustainTo: n.sustainTo, extended: false });
        voice.cursor++;
      }
    }
  }

}
