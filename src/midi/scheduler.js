// ============================================================
//  scheduler.js — 排程器（純邏輯，無 DOM／CDN）
//
//  時間單位：整份總譜只有一條時間軸，單位是 MIDI tick（SMF 規格唯一的時間單位；秒只是用速度表換算出來的衍生值）。
//  所有比較（起音、收音、相連音）都在 tick 上做，跟 note 的 startTick／endTick 同一個座標系。
//
//  總譜觸發：parser 把全曲所有音依 startTick 分成 segment（同一個 tick 上所有聲部、所有譜表的音，借自 MuseScore 的
//  Segment）。一次觸發（`trigger(slot, nowMs)`，鍵盤或日後的手勢）放行「全曲的下一個 segment」：這個 segment 裡所有音——
//  你的聲部與電腦輔助的聲部——在這次呼叫內立刻 noteOn。上下對齊由結構保證（同一個 tick 的音一定在同一次呼叫裡出聲），
//  不靠兩條時鐘去對時；下一個 segment 就是全曲緊接著的下一個起音 tick，所以任何速度下都不會跳過任何一顆音。
//  指派（演奏者槽位）只決定兩件事：哪些聲部走真人合成器（`humanSynth`，音量凸顯）、哪些槽位有資格推進全曲；
//  電腦輔助聲部＝沒被指派的聲部（`assistSynth`）。
//
//  播放頭（playhead，`_ticks`）：兩次觸發之間以 `playbackRate`（模仿官方 Sequencer 的命名：樂譜秒 ÷ 真實秒）往前走，
//  最多走到下一個 segment 的 tick 就停格等你；它只負責收音與進度條，永遠不會自己放出起音。`playbackRate` 取自你最近
//  兩次觸發的間隔（夾在 [MIN, MAX]），你按快，休止與音長照比例變短；你按慢，音照檔案收，停格等你。
//  沒有任何指派（或指派的聲部都沒有音符）時整首自動播放：播放頭以 1× 連續前進，走到的 segment 自動放行。
//
//  收音：音的 endTick ≤ 播放頭才收（同音高重疊依發聲順序先進先出，跟官方合成器對 note-off 的解讀一致，每個 noteOn 都送出
//  一個對應的 noteOff）。相連音（結尾到同一個譜表下一顆起音的間隙 ≤ θ）在後繼音還沒放行時撐住，免得停格那一下出現檔案裡沒有的
//  空白；停格超過 IDLE_MS 就把所有還在響的音收掉，不會無限期掛著。放行一個 segment 時先收再放：相連的舊音在後繼音發聲的
//  同一刻已經關掉。
//
//  velocity 一律用樂譜原值；不重播 CC／pitch-bend，每個 staff 的初始狀態（bank／program 與 CC7／10／91／93）只在
//  load() 時送一次，而且一定在該 channel 的第一個 noteOn 之前。
//
//  聲部單位：parser 把一個 MuseScore 樂器切成 part，part 底下有一個以上的 staff（一個譜表 × 一個樂器 channel，例如鋼琴
//  兩行譜是兩個 staff）。指派以 part 為單位，part 的所有 staff 共用同一個槽位；發聲與輸出 channel 以 staff 為單位。
//  沒有 staves 的 part（手工組的舊資料形狀）自動視為單一 staff。
// ============================================================

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  drumChannel: 9, // MIDI 規格：第 10 個 channel（索引 9）是打擊
});

// channel 的單一來源（synth.js 也從這裡 import，不再各寫一份）。模仿官方 SpessaSynth Sequencer：一個 port 16 個 channel，
// 依需要的 port 數往上補、只增不減（官方 assignMIDIPort／addNewMIDIPort），每個 port 的 channel 9 是打擊。DEFAULT_PORTS 是
// 合成器開機就補到的 port 數；歌曲需要更多時由 synth.js 的 load() 依 portsNeeded() 補，再用 setPortCount() 告訴排程器。
// 不能讀 synth.midiChannels.length 當 channel 數（lib 的 addNewChannel() 會雙重 push，見 synth.js），所以數字只由這裡與
// synth.js 自己計數。
export const CHANNELS_PER_PORT = 16;
export const DEFAULT_PORTS = 4;

/* ═══════════════════════════════════════════
   應用層常數——不是規格
   ═══════════════════════════════════════════ */
// 「播放頭停在下一個 segment 多久就把還在響的音全部收掉」的門檻：相連音撐住與長音只是不在停格那一下提早收，不能無限期響著。
// 800ms 吸收你按鍵的停頓；你完全停手時播放頭停在原地，超過這個時間就安靜下來。
const IDLE_MS = 800;
// 相連音的「小間隙」門檻 θ ＝ timeDivision / LEGATO_GAP_DIVISOR（480 tpq 時 30 tick）：音符結尾到同一個譜表
// 下一個起音點的間隙 ≤ θ 才算相連的音。MuseScore 把相連音符寫成「記譜長度 − 1 tick」（間隙固定 1 tick），真正的
// 最短休止（三十二分休止）≥ 60 tick，θ 落在兩者中間的空檔；用 tick 不用秒，跟速度無關。
const LEGATO_GAP_DIVISOR = 16;
// 每個 tick 的時間步長上限：分頁被瀏覽器節流（背景分頁的計時器可能隔好幾秒才醒來）後恢復時，播放頭最多只前進這麼多，
// 不會一次把空窗期的音全部收掉（自動播放時也不會一次放出一大段）。
const MAX_TICK_DT_SEC = 0.1;
// 播放頭是一路換算（tick → 秒 → 加 dt → tick）累積出來的浮點數，跟整數 tick 比大小時不能要求逐位元相等。
const EPS_TICKS = 1e-6;
// playbackRate 的合理範圍：你連按兩下幾乎同時（估出極大的速度）或隔很久才按（估出趨近 0），都夾在這個範圍內，
// 免得播放頭瞬間衝到下一個 segment、或幾乎不動。
const MIN_PLAYBACK_RATE = 0.25;
const MAX_PLAYBACK_RATE = 4;
// GM 預設的混音值（CC121 不會重設音量、聲像、Program，見 GML-v1 §3.2.5.2；channel 又是跨曲重複使用，所以沒有 init 的 staff
// 也要明確送一次，避免沿用到別的曲子在同一個 channel 上留下的設定）。
const GM_DEFAULT_VOLUME = 100, GM_DEFAULT_PAN = 64, GM_DEFAULT_REVERB = 0, GM_DEFAULT_CHORUS = 0;

/* ═══════════════════════════════════════════
   輸出 channel 分配
   ═══════════════════════════════════════════ */

// 這個合成器上可用的旋律輸出 channel＝跳過每個 port 的打擊槽（ch % 16 === drumChannel）。
function melodicChannelsFor(synth, drumChannel, ports) {
  const total = synth ? ports * CHANNELS_PER_PORT : CHANNELS_PER_PORT;
  const out = [];
  for (let ch = 0; ch < total; ch++) {
    if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);
  }
  return out;
}

// 這個合成器上的打擊輸出 channel＝每個 port 的打擊槽（9／25／41／57）：合成器只有一個 port 時只有 drumChannel 一個。
function drumChannelsFor(synth, drumChannel, ports) {
  const n = synth ? ports : 1;
  return Array.from({ length: n }, (_, p) => p * CHANNELS_PER_PORT + drumChannel);
}

// 幫一組 staff 各自分配一個輸出 channel，避免兩個原本共用同一個原始 channel 的 staff 打架。旋律 staff 依序拿
// melodicChannels 裡的號碼；打擊 staff 依「不同鼓組 program」各佔一個打擊槽（同一個鼓組共用），鼓組種類超過打擊槽數
// 就排不進去；排不進去的 staff 回報給呼叫端，不出聲。
function allocateChannels(staves, melodicChannels, drumChannels) {
  const byStaffId = new Map();
  const unplaced = [];
  const kitChannel = new Map(); // 鼓組 program → 輸出 channel
  let next = 0;
  for (const s of staves) {
    // percussionKit 已經是 GM2 Bank Select（CC0/32）判定過的結果：channel 9 若明確用
    // Bank 79H(121) 切成旋律通道，這裡就不會被誤送進打擊 channel（見 midiParser.js 的
    // collectParts() 說明）。
    if (s.percussionKit) {
      if (!kitChannel.has(s.program) && kitChannel.size < drumChannels.length) kitChannel.set(s.program, drumChannels[kitChannel.size]);
      if (kitChannel.has(s.program)) byStaffId.set(s.id, kitChannel.get(s.program));
      else unplaced.push(s.id);
      continue;
    }
    if (next < melodicChannels.length) byStaffId.set(s.id, melodicChannels[next++]);
    else unplaced.push(s.id);
  }
  return { byStaffId, unplaced };
}

/* ═══════════════════════════════════════════
   譜表（staff）建構
   ═══════════════════════════════════════════ */

// 一個 part 底下的 staff 規格：新資料形狀直接用 part.staves；沒有 staves 的 part（手工組的舊資料形狀）視為單一 staff，
// id 沿用 part.id。
function staffSpecsOf(part) {
  if (part.staves) return part.staves.map((s) => ({ ...s, partId: part.id }));
  return [{ id: part.id, partId: part.id, program: part.program ?? 0, bank: part.bank ?? { msb: 0, lsb: 0 }, percussionKit: !!part.percussionKit, init: null }];
}

// 音符屬於哪個 staff：新資料形狀有 staffId；舊資料形狀的音符沒有，用 partId（跟 staffSpecsOf 的單一 staff id 一致）。
const staffKeyOf = (note) => note.staffId ?? note.partId;

function makeStaff(spec, slot, notes, kind, channel) {
  return {
    id: spec.id, partId: spec.partId, slot, kind, channel, notes,
    program: spec.program ?? 0, bank: spec.bank, init: spec.init ?? null, percussionKit: !!spec.percussionKit,
    baseVolume: spec.init?.volume ?? GM_DEFAULT_VOLUME, // 檔案 tick 0 的 CC7，沒有就是 GM 預設 100；載入時送一次
    sounding: new Map(),    // 音高 → [{ endTick, legatoTo }]：正在響的音；同音高重疊時依發聲順序排隊，先進先出收音
  };
}

// 這首歌至少需要幾個 port 的 channel（不低於 DEFAULT_PORTS）：旋律 staff 每個 port 有 15 個、打擊 staff 每種鼓組 program 佔一個
// port 的打擊槽，指派與未指派兩個池子（兩個合成器）各自算，取較大的。assignments 同 load()：Map 或 [partId, 槽位][]。
export function portsNeeded(score, assignments) {
  const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);
  const pools = [{ melodic: 0, kits: new Set() }, { melodic: 0, kits: new Set() }]; // [指派, 未指派]
  for (const part of score?.parts || []) {
    const pool = pools[assignMap.has(part.id) ? 0 : 1];
    for (const spec of staffSpecsOf(part)) {
      if (spec.percussionKit) pool.kits.add(spec.program); else pool.melodic++;
    }
  }
  const melodicPerPort = CHANNELS_PER_PORT - 1; // 每個 port 扣掉打擊槽
  return Math.max(DEFAULT_PORTS, ...pools.map((p) => Math.max(Math.ceil(p.melodic / melodicPerPort), p.kits.size)));
}

// 指派聲部只配 humanSynth 的 channel、未指派聲部只配 assistSynth 的 channel——兩個池子各自獨立，配額用完的 staff 回報在
// unplaced，這一輪不會出聲。
function buildStaves(score, assignments, assistSynth, humanSynth, cfg, ports) {
  const staves = new Map(); // staffId → staff
  const unplaced = [];

  const notesByStaff = new Map(); // score.notes 已依 startTick 排序，照順序分組即可
  for (const n of score.notes) {
    const key = staffKeyOf(n);
    let list = notesByStaff.get(key);
    if (!list) notesByStaff.set(key, (list = []));
    list.push(n);
  }

  const assignedSpecs = [], assistSpecs = [];
  for (const part of score.parts) {
    for (const spec of staffSpecsOf(part)) (assignments.has(part.id) ? assignedSpecs : assistSpecs).push(spec);
  }

  const { byStaffId: humanCh, unplaced: u1 } =
    allocateChannels(assignedSpecs, melodicChannelsFor(humanSynth, cfg.drumChannel, ports), drumChannelsFor(humanSynth, cfg.drumChannel, ports));
  const { byStaffId: assistCh, unplaced: u2 } =
    allocateChannels(assistSpecs, melodicChannelsFor(assistSynth, cfg.drumChannel, ports), drumChannelsFor(assistSynth, cfg.drumChannel, ports));
  unplaced.push(...u1, ...u2);

  for (const spec of assignedSpecs) {
    const channel = humanCh.get(spec.id);
    if (channel === undefined) continue;
    staves.set(spec.id, makeStaff(spec, assignments.get(spec.partId), notesByStaff.get(spec.id) || [], 'human', channel));
  }
  for (const spec of assistSpecs) {
    const channel = assistCh.get(spec.id);
    if (channel === undefined) continue;
    staves.set(spec.id, makeStaff(spec, null, notesByStaff.get(spec.id) || [], 'assist', channel));
  }
  return { staves, unplaced };
}

/* ═══════════════════════════════════════════
   Scheduler
   ═══════════════════════════════════════════ */
export class Scheduler {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.assistSynth = null;   // 電腦輔助聲部的合成器（未指派聲部）
    this.humanSynth = null;    // 真人聲部合成器（被指派聲部）
    this.ports = DEFAULT_PORTS; // 合成器目前有幾個 port（每個 16 個 channel）；synth.js 補 channel 之後用 setPortCount() 更新
    this.playbackRate = 1;     // 播放頭的速度（樂譜秒 ÷ 真實秒），命名同官方 Sequencer；每次觸發依你的按鍵間隔更新
    this._score = null;
    this._staves = new Map();  // staffId → staff
    this._segments = [];       // 全曲的垂直切片：[{ ticks, items: [{ staff, note }] }]，只含有輸出 channel 的 staff 的音
    this._assignedSlots = new Set(); // 有資格觸發的演奏者槽位（指派了有音符的聲部）；空＝整首自動播放
    this._segIndex = 0;        // 下一個要放行的 segment（同官方 Sequencer 的 index）
    this._ticks = 0;           // 播放頭（可為小數 tick）
    this._lastSegTicks = -1;   // 最近放行的 segment 的 tick：起音 tick ≤ 它的音都已經發聲（相連音撐住的判斷用）
    this._lastTrigger = null;  // { ticks, ms }：上一次觸發的 segment tick 與時刻（估 playbackRate 用）
    this._started = false;     // 重設後有沒有被觸發過：沒有就不推進播放頭（沒人開始，進度停在 0）
    this._stallSec = 0;        // 播放頭停在下一個 segment 已經多久（真實秒）
    this.unplacedStaffIds = []; // 輸出 channel 排不進去（旋律 staff 超過 60 個、鼓組超過 4 種）的 staff，這一輪不出聲
    this._playing = false;
    this._lastTickMs = null;   // null＝下一次 tick() 不推進播放頭，只記錄基準
  }

  setSynths(assistSynth, humanSynth) {
    this.assistSynth = assistSynth;
    this.humanSynth = humanSynth;
  }

  setPortCount(ports) {
    this.ports = ports;
  }

  _synthOf(staff) {
    return staff.kind === 'human' ? this.humanSynth : this.assistSynth;
  }

  // 沒有任何有資格觸發的槽位：整首自動播放（播放頭 1× 連續前進，走到的 segment 自動放行）。
  _isAuto() {
    return this._assignedSlots.size === 0;
  }

  /**
   * 載入這首歌：建立 staff、套初始音色，把 parser 的 segment 配上各自的 staff。
   * @param {import('./midiParser.js').ParsedMidi} score  parseMidi() 的結果（每顆音會被標上 legatoTo，同一份譜重新載入的
   *        結果相同；其餘不會被修改）
   * @param {Map<string,number>|[string,number][]} assignments  partId → 演奏者槽位
   */
  load(score, assignments) {
    this.stop();
    this._score = score || null;
    this._staves = new Map();
    this._segments = [];
    this._assignedSlots = new Set();
    this.unplacedStaffIds = [];
    if (score) this._createStaves(score, assignments);
    // 沒有樂譜時 staves 與 segments 都是空的：tick() 空轉。
  }

  // 建立 staff、套初始音色、標記每顆音的相連後繼音、把全曲的 segment 配上 staff。
  _createStaves(score, assignments) {
    const assignMap = assignments instanceof Map ? assignments : new Map(assignments || []);

    const { staves, unplaced } = buildStaves(score, assignMap, this.assistSynth, this.humanSynth, this.cfg, this.ports);
    this._staves = staves;
    this.unplacedStaffIds = unplaced;

    for (const staff of this._staves.values()) this._applyInitialPatch(this._synthOf(staff), staff);

    this._tagLegato();
    this._buildSegments();
  }

  // parser 的 segment（全曲同一個 startTick 的所有音）→ 排程用的 segment：每顆音換成 { staff, note }。沒有輸出 channel 的
  // staff 的音被丟掉；整個 segment 都被丟光就不收（一次觸發不該只推進一個不會響的 segment）。
  _buildSegments() {
    for (const seg of this._score.segments) {
      const items = [];
      for (const note of seg.notes) {
        const staff = this._staves.get(staffKeyOf(note));
        if (staff) items.push({ staff, note });
      }
      if (items.length) this._segments.push({ ticks: seg.ticks, items });
    }
    // 指派了有音符的 staff 的槽位才有資格觸發；指派了但完全沒有音符（或都排不進 channel）的槽位不算，
    // 全都不算就是自動播放。
    for (const staff of this._staves.values()) {
      if (staff.kind === 'human' && staff.notes.length) this._assignedSlots.add(staff.slot);
    }
  }

  // 標記每顆音的相連後繼音（見檔頭「收音」）：音符結尾到同一個譜表下一個起音點的間隙 ≤ θ（LEGATO_GAP_DIVISOR）
  // 就記下那顆後繼音在 staff.notes 裡的位置（legatoTo），否則 -1。沒有 tick 換算（SMPTE division）一律 -1。
  _tagLegato() {
    const tpq = this._score.timeDivision;
    const theta = tpq ? Math.round(tpq / LEGATO_GAP_DIVISOR) : -1;
    for (const staff of this._staves.values()) {
      const starts = staff.notes.map((n) => n.startTick); // notes 已依 startTick 排序
      for (const n of staff.notes) {
        let lo = 0, hi = starts.length;                   // 第一個 startTick >= n.endTick 的位置（二分搜尋）
        while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid] < n.endTick) lo = mid + 1; else hi = mid; }
        n.legatoTo = theta >= 0 && lo < starts.length && starts[lo] - n.endTick <= theta ? lo : -1;
      }
    }
  }

  // staff 的初始狀態：bank／program，再加上混音 CC7／10／91／93（來源 staff.init＝檔案 tick 0 的值；沒有就明確送 GM 預設，
  // 見 GM_DEFAULT_*）。load() 時送一次，比該 channel 的任何 noteOn 都早。
  _applyInitialPatch(synth, staff) {
    if (!synth) return;
    const { channel, bank, init } = staff;
    try {
      synth.controllerChange(channel, 0, bank?.msb || 0);
      synth.controllerChange(channel, 32, bank?.lsb || 0);
      synth.programChange(channel, staff.program || 0);
      synth.controllerChange(channel, 7, staff.baseVolume);
      synth.controllerChange(channel, 10, init?.pan ?? GM_DEFAULT_PAN);
      synth.controllerChange(channel, 91, init?.reverb ?? GM_DEFAULT_REVERB);
      synth.controllerChange(channel, 93, init?.chorus ?? GM_DEFAULT_CHORUS);
    } catch (err) { /* 初始音色設定失敗不致命 */ }
  }

  play() {
    this._playing = true;
    // 避免暫停期間累積的時間被當成一次巨大的 dt，也不能把暫停那段當成兩次觸發的間隔去估速度。第一個 tick 的 dt 是 0。
    this._lastTickMs = null;
    this._lastTrigger = null;
  }

  // 暫停：收掉還在響的音，播放頭與 segment 游標都保留（下次播放從原處繼續）。
  pause() {
    this._playing = false;
    this._lastTickMs = null;
    this.silence();
  }

  silence() {
    this._noteOffAll();
    for (const staff of this._staves.values()) {
      try { this._synthOf(staff)?.controllerChange(staff.channel, 123, 0); } catch (err) {} // CC123 All Notes Off 當保險
    }
  }

  // 把所有還在響的音收掉：每個 noteOn 各送一個 noteOff。
  _noteOffAll() {
    for (const staff of this._staves.values()) {
      const synth = this._synthOf(staff);
      for (const [pitch, queue] of staff.sounding) {
        for (let i = 0; i < queue.length; i++) {
          try { synth?.noteOff(staff.channel, pitch); } catch (err) {}
        }
      }
      staff.sounding.clear();
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
  // 狀態欄位都要在這裡重設（test/unit/scheduler.test.mjs 有一個整體快照比對，忘了重設會
  // 直接失敗）。呼叫端負責先收音（pause()）與決定要不要接著播放。
  _resetPlayback() {
    this._segIndex = 0;
    this._ticks = 0;
    this._lastSegTicks = -1;
    this._lastTrigger = null;
    this._started = false;
    this._stallSec = 0;
    this.playbackRate = 1;
    this._lastTickMs = null;
  }

  isPlaying() { return this._playing; }

  // 播完：所有 segment 都放行完而且沒有還在響的音。有指派聲部但還沒有人觸發過，segment 一個都還沒放行，不算播完（還在等你開始）。
  isFinished() {
    if (!this._score) return false;
    if (this._segIndex < this._segments.length) return false;
    for (const staff of this._staves.values()) {
      if (staff.sounding.size > 0) return false;
    }
    return true;
  }

  /**
   * 播放頭目前在第幾個 tick（跟 note 的 startTick／endTick 同一個座標系）。唯讀、無副作用。
   * @returns {number} tick（可為小數），夾在 [0, score.durationTicks]；沒有樂譜或沒有 staff 時 0
   */
  getPositionTicks() {
    if (!this._score || this._staves.size === 0) return 0;
    const total = this._score.durationTicks;
    return total > 0 ? Math.min(this._ticks, total) : this._ticks; // 放行完最後一個 segment 後播放頭不再受限，夾住不超過總長
  }

  /**
   * 觸發一次：放行全曲的下一個 segment，裡面所有 staff（你的與電腦輔助的）的音在這次呼叫內立刻 noteOn（不等 tick）。
   * @param {number} slot   演奏者槽位（要有指派聲部才有資格推進全曲）
   * @param {number} nowMs  performance.now()：用來估 playbackRate
   * @returns {boolean} 有沒有放行（沒在播放、槽位沒有指派聲部、整首自動播放中、segment 都放行完了都回 false）
   */
  trigger(slot, nowMs) {
    if (!this._playing || !this._assignedSlots.has(slot) || this._segIndex >= this._segments.length) return false;
    const seg = this._segments[this._segIndex++];
    this._updatePlaybackRate(seg.ticks, nowMs);
    this._emitSegment(seg);
    this._started = true;
    this._stallSec = 0;
    return true;
  }

  // 依「這次與上一次觸發」的樂譜秒數差 ÷ 真實秒數差估 playbackRate，夾在合理範圍。第一次觸發沒有間隔可估；你停手超過閒置門檻
  // 代表中斷了，那一段不當成演奏速度，維持原本的值。
  _updatePlaybackRate(ticks, nowMs) {
    const prev = this._lastTrigger;
    this._lastTrigger = { ticks, ms: nowMs };
    if (!prev || this._stallSec > IDLE_MS / 1000) return;
    const scoreSec = this._score.midiTicksToSeconds(ticks) - this._score.midiTicksToSeconds(prev.ticks);
    const realSec = Math.max(1e-3, (nowMs - prev.ms) / 1000); // 兩次觸發同一毫秒時避免除以 0
    this.playbackRate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, scoreSec / realSec));
  }

  // 放行一個 segment：播放頭到這個 segment 的 tick（只往前），先收掉 endTick ≤ 它的音，再讓裡面所有音 noteOn，最後再收一次
  // （同一個 tick 內起音又結束的零長度音）。先收再放保證相連的舊音在後繼音發聲的同一刻已經關掉。
  // trigger() 與自動播放共用；自動播放時播放頭可能已經超過這個 segment 的 tick（一個 tick 步長涵蓋好幾個 segment），所以收音
  // 的基準用 segment 自己的 tick，不用播放頭。
  _emitSegment(seg) {
    this._lastSegTicks = seg.ticks; // 先更新：這個 segment 裡的音是被撐住的相連音的後繼音，要先解除撐住才收得掉
    this._ticks = Math.max(this._ticks, seg.ticks);
    this._closeDueNotes(seg.ticks);
    for (const { staff, note } of seg.items) {
      try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity); } catch (err) {}
      this._pushSounding(staff, note);
    }
    this._closeDueNotes(seg.ticks);
  }

  /**
   * 由 midiPlayer.js 的排程 tick（~12ms）每次呼叫：推進播放頭、（自動播放時）放出走到的 segment、收掉到期的音。
   * 有指派聲部時這裡永遠不會放出起音，起音只來自 trigger()。
   * @param {number} nowMs  performance.now()
   */
  tick(nowMs) {
    if (!this._playing || !this._score) return; // 沒有樂譜（load(null)）時空轉
    const dt = this._lastTickMs == null ? 0 : Math.min(MAX_TICK_DT_SEC, (nowMs - this._lastTickMs) / 1000);
    this._lastTickMs = nowMs;
    this._advancePlayhead(dt);
    if (this._isAuto()) this._emitDueSegments();
    this._closeDueNotes(this._ticks);
  }

  // 播放頭前進 dt 真實秒：速度是 playbackRate（自動播放固定 1×），換算成 tick 的做法是 tick → 秒 → 加 dt × 速度 → tick
  // （速度表在 tick ↔ 秒之間是分段線性，不能直接把 dt 乘上固定的 tick／秒），最多走到下一個 segment 的 tick（有指派時）。
  // 碰到上限就停格，停格超過閒置門檻把所有還在響的音收掉（相連音撐住只是不在停格那一下提早收，不是延音效果）。
  _advancePlayhead(dt) {
    if (dt <= 0) return;
    const auto = this._isAuto();
    if (!auto && !this._started) return; // 還沒有人觸發：沒人開始，播放頭停在 0
    const next = this._segments[this._segIndex];
    const cap = !auto && next ? next.ticks : Infinity;
    const rate = auto ? 1 : this.playbackRate;
    const score = this._score;
    const target = score.secondsToMIDITicks(score.midiTicksToSeconds(this._ticks) + dt * rate);
    // 外層 Math.max：播放頭只前進、不倒退
    this._ticks = Math.max(this._ticks, Math.min(target, cap));

    if (cap !== Infinity && this._ticks >= cap - EPS_TICKS) {
      this._stallSec += dt;
      if (this._stallSec > IDLE_MS / 1000) this._noteOffAll();
    } else {
      this._stallSec = 0;
    }
  }

  // 自動播放：放出所有起音 tick ≤ 播放頭的 segment（同一個 tick 步長可能涵蓋好幾個，依序放）。
  _emitDueSegments() {
    while (this._segIndex < this._segments.length && this._segments[this._segIndex].ticks <= this._ticks + EPS_TICKS) {
      this._emitSegment(this._segments[this._segIndex++]);
    }
  }

  _pushSounding(staff, note) {
    let queue = staff.sounding.get(note.midiNote);
    if (!queue) staff.sounding.set(note.midiNote, (queue = []));
    queue.push({ endTick: note.endTick, legatoTo: note.legatoTo });
  }

  // 收掉到期的音（endTick ≤ ticks，沒被撐住）。同音高重疊時只看佇列最前面那一顆（先進先出）。
  _closeDueNotes(ticks) {
    for (const staff of this._staves.values()) {
      const synth = this._synthOf(staff);
      for (const [pitch, queue] of staff.sounding) {
        while (queue.length && queue[0].endTick <= ticks + EPS_TICKS && !this._isHeld(staff, queue[0])) {
          try { synth?.noteOff(staff.channel, pitch); } catch (err) {}
          queue.shift();
        }
        if (!queue.length) staff.sounding.delete(pitch);
      }
    }
  }

  // 相連音要不要繼續撐：它的後繼音還沒放行（起音 tick 在最近放行的 segment 之後）。後繼音一放行就不再撐，在後繼音
  // 發聲的同一刻先關再開；整首自動播放永遠不撐，每個 noteOff 都照檔案。
  _isHeld(staff, entry) {
    if (this._isAuto()) return false;
    const successor = staff.notes[entry.legatoTo]; // legatoTo ＝ -1 時是 undefined
    return !!successor && successor.startTick > this._lastSegTicks;
  }
}
