// ============================================================
//  keyboard.js — 鍵盤觸發：電腦鍵盤的四排字元鍵＝演奏者 1 的一次有效觸發（取代揮手，當排程器的標準輸入）
//
//  輸出形狀跟 vision.js 送給播放器的手勢狀態完全一樣（{ arcTriggerSeqBySlot, presentSlots }），
//  所以播放器與排程器不用知道觸發來自鍵盤還是揮手。不 import 任何其他模組。
// ============================================================

// 用 event.code（實體鍵位）不用 event.key：換輸入法或鍵盤配置（注音、Dvorak）時，同一個位置的鍵仍然是同一個鍵。
// 一排：` 1~0 - =；二排：Q~P [ ] \；三排：A~L ; '；四排：Z~M , . /。
// 刻意不含 Space／Enter／Tab（焦點在按鈕上時會「按下」播放列的按鈕或移動焦點）、數字鍵盤、功能鍵。
const TRIGGER_CODES = new Set([
  'Backquote', ...'1234567890'.split('').map((d) => `Digit${d}`), 'Minus', 'Equal',
  ...'QWERTYUIOP'.split('').map((c) => `Key${c}`), 'BracketLeft', 'BracketRight', 'Backslash',
  ...'ASDFGHJKL'.split('').map((c) => `Key${c}`), 'Semicolon', 'Quote',
  ...'ZXCVBNM'.split('').map((c) => `Key${c}`), 'Comma', 'Period', 'Slash',
]);
const KEYBOARD_SLOT = 1; // 目前只有一位演奏者（開發者）

// 焦點在這些元素時，鍵盤是拿來打字的，不是觸發。
const isTyping = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA'
  || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file', 'range'].includes(el.type)));

/**
 * 掛上 keydown 監聽。每次有效按鍵，把累加計數 +1 後交給 onState（排程器只看「計數有沒有變」）。
 * @param {(state: { arcTriggerSeqBySlot: Record<number, number>, presentSlots: number[] }) => void} onState
 */
export function startKeyboardTrigger(onState) {
  let seq = 0; // 累加計數：跟 ArcDetector.triggerSeq 同一種語意，變動＝一次新觸發
  window.addEventListener('keydown', (e) => {
    if (!TRIGGER_CODES.has(e.code)) return;
    if (e.repeat) return;                                // 按住不放的自動重複：一次按下只算一次
    if (e.ctrlKey || e.altKey || e.metaKey) return;      // 組合鍵是瀏覽器／系統快捷鍵（Ctrl+R 等），不攔
    if (isTyping(document.activeElement)) return;        // 搜尋欄打字不觸發
    // 焦點停在 <select>（選歌、分譜指派）時，字母鍵會觸發瀏覽器的 type-ahead 跳選項，選歌下拉一跳就換歌，所以擋掉預設行為
    e.preventDefault();
    seq += 1;
    // presentSlots 給空陣列：這個欄位目前沒有驅動任何行為（見 CLAUDE.md「在場清單目前只是保留欄位」）
    onState({ arcTriggerSeqBySlot: { [KEYBOARD_SLOT]: seq }, presentSlots: [] });
  });
}
