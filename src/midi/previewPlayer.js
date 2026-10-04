// ============================================================
//  previewPlayer.js — 試聽：官方 SpessaSynth Sequencer 的薄包裝。純邏輯：無 DOM、不 import CDN。
//
//  試聽不經過我們的 parser（midiParser.js），位元組原樣交給官方 Sequencer 自己解析、自己排程，播放
//  整個在 AudioWorklet 裡進行，不走 scheduler.js 的主執行緒 tick——所以即使我們的 parser 解析失敗
//  試聽仍可用，聽感也能拿來跟演奏對照。這裡只做三件事：
//   1) 官方載入是非同步的，等結果（songChange／midiError／逾時／被中斷）；
//   2) 提供播放列需要的最小控制（暫停／續播／從頭／停止）與狀態（時間／長度／播完）；
//   3) 官方的 loopCount 預設會循環播放，明確關掉。
//  Sequencer 由 synth.js 注入（跟 WorkletSynthesizer 同一個 CDN 套件），所以這裡可以在 Node 用假的測試。
// ============================================================

const LOAD_TIMEOUT_MS = 8000;
const EVENT_ID = 'harmonyflow-preview';

// 失敗一律帶 kind，呼叫端靠它分流：'parse'＝官方解析器拒絕、'timeout'＝官方沒有回應、'aborted'＝被
// stop()／下一次 start() 中斷（呼叫端通常靜默處理）。
const fail = (kind, message) => Object.assign(new Error(message), { kind });

export class PreviewPlayer {
  /**
   * @param {() => object} createSequencer  回傳一個新的官方 Sequencer（第一次 start() 才呼叫）
   * @param {{ loadTimeoutMs?: number }} [options]
   */
  constructor(createSequencer, { loadTimeoutMs = LOAD_TIMEOUT_MS } = {}) {
    this._create = createSequencer;
    this._timeoutMs = loadTimeoutMs;
    this._seq = null;
    this._loadCount = 0;
    this._abort = null;     // 正在等的那次載入的中斷函式；沒有在等就是 null
    this._active = false;   // 已載入並開始播放、還沒 stop()
  }

  get active() { return this._active; }
  get time() { return this._active ? this._seq.currentTime : 0; }
  get duration() { return this._active ? this._seq.duration : 0; }
  get finished() { return this._active && this._seq.isFinished; }

  // 載入並從頭播放。resolve 時已經開始播；失敗丟 kind＝parse／timeout／aborted 的 Error。
  async start(bytes) {
    this.stop(); // 上一次試聽（包含還在等的載入）先結束
    const seq = (this._seq ??= this._createSequencer());
    // 每次載入用不同的檔名當識別：官方的 songChange 事件帶著檔名，晚到的舊事件靠它擋掉
    // （midiError 沒有檔名可比對，但解析失敗幾毫秒內就回來，不會拖到使用者換歌再重按）。
    const name = `preview-${++this._loadCount}`;
    // 先掛監聽、再送出載入：官方的結果事件可能一送出就回來。
    const loaded = this._waitLoaded(seq, name);
    try {
      seq.loadNewSongList([{ binary: bytes, fileName: name }]);
    } catch (err) {
      this._abort(fail('parse', err.message)); // 連送出都失敗（位元組不能被複製等），當成解析失敗
    }
    await loaded;
    seq.play();
    this._active = true;
  }

  pause() { if (this._active) this._seq.pause(); }

  // 播完之後續播＝從頭（官方 Sequencer 自己也會這樣，這裡明講不依賴它）。
  resume() {
    if (!this._active) return;
    if (this._seq.isFinished) this.restart();
    else this._seq.play();
  }

  // 先設時間再 play：不論現在是暫停或播放中，官方都從第一個音（skipToFirstNoteOn）重新開始。
  restart() {
    if (!this._active) return;
    this._seq.currentTime = 0;
    this._seq.play();
  }

  // 停止：中斷還在等的載入、讓官方播放器暫停（它會把所有發聲中的音收掉）。可重複呼叫。
  stop() {
    this._abort?.(fail('aborted', '試聽被中斷'));
    this._seq?.pause();
    this._active = false;
  }

  _createSequencer() {
    const seq = this._create();
    seq.loopCount = 0; // 官方預設循環播放（-1），試聽播完就該停
    return seq;
  }

  _waitLoaded(seq, name) {
    return new Promise((resolve, reject) => {
      let timer = null;
      // 結束這次等待：只會有一個結果（promise 本身只認第一次 resolve／reject），並把監聽與計時器清掉。
      const settle = (err) => {
        clearTimeout(timer);
        seq.eventHandler.removeEvent('songChange', EVENT_ID);
        seq.eventHandler.removeEvent('midiError', EVENT_ID);
        if (this._abort === settle) this._abort = null;
        if (err) reject(err); else resolve();
      };
      seq.eventHandler.addEvent('songChange', EVENT_ID, (song) => { if (song?.fileName === name) settle(); });
      seq.eventHandler.addEvent('midiError', EVENT_ID, (err) => settle(fail('parse', err?.message || '官方解析器拒絕這首 MIDI')));
      // 官方對「長度 0 秒」的 MIDI 既不回 songChange 也不回 midiError，沒有逾時會永遠卡在載入中。
      timer = setTimeout(() => settle(fail('timeout', '官方播放器沒有回應')), this._timeoutMs);
      this._abort = settle;
    });
  }
}
