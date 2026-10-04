# HarmonyFlow

瀏覽器端的 MIDI 演奏應用：觸發來源（目前是電腦鍵盤四排字元鍵＝演奏者 1，攝影機 → MediaPipe 姿勢追蹤＋拋物線手勢暫時沒有接進播放器）每觸發一次，就放行整份總譜的下一個 segment（同一個 tick 上所有聲部的音），你的聲部與電腦輔助的聲部在按下的當下一起立刻發聲、上下對齊；一個演奏者可以同時控制多個聲部。沒被你控制的聲部由電腦輔助，跟你的聲部在同一個 segment 一起發聲；音長照樂譜、隨你的按鍵速度縮放。另有「試聽」鈕，用官方 SpessaSynth Sequencer 播同一份 MIDI 讓你用耳朵對照。純原生 JavaScript（ES module），沒有 build step、沒有後端、沒有 Node 工具鏈。

## 需求

- 桌機瀏覽器（Chrome／Edge／Firefox／Safari 近兩年的版本）＋ 攝影機。
- 需要網路連線：第三方套件（MediaPipe、spessasynth）直接從 CDN 載入，不在本機安裝。

## 本地開發

clone 下來直接用 VS Code 的 Live Server（ritwickdey.liveserver）開：以這個資料夾為工作區根目錄開啟，「Go Live」→ `http://127.0.0.1:5500/`（`.vscode/settings.json` 已設好 port 與忽略清單；它對 `.wasm` 回 `application/wasm`）。ES module 的 `import` 與 `getUserMedia` 都需要 `http(s)://`，不能直接用 `file://` 開 `index.html`。部署＝把資料夾原樣 serve 出去，所以這樣跑起來看到的就是部署後的樣子。

## 資料夾

```
index.html        唯一進入點；完整的靜態 UI markup 都在這裡（HTML-first），preload／modulepreload 也在這裡
src/
  main.js         啟動點（composition root）：initUi(midiPlayer)、接 vision → 播放器的人數監聽與鍵盤 → 播放器的觸發、並行推進兩條啟動軌道
  keyboard.js     鍵盤觸發：四排字元鍵＝演奏者 1 的一次觸發（防呆：按住重複、組合鍵、打字、下拉 type-ahead）
  ui.js           UI 外殼：Store（EventTarget 狀態容器）＋ rafThrottle、uiStore、載入／錯誤遮罩＋inert、--ui-fs、
                  系統控制列、面板開合、事件代理、render 排程
  vision/         攝影機／WebGL／MediaPipe（vision.js）＋ 純邏輯的多人追蹤（tracking.js）與揮手手勢（gesture.js）
  midi/           spessasynth 合成器（synth.js）、播放器狀態＋動作＋畫面（midiPlayer.js）、雲端曲庫 client（midiApi.js）
                  ＋ 純邏輯的 SMF 解析與聲部切分（midiParser.js）、排程器（scheduler.js：每次觸發放行全曲的下一個 segment 並立刻發聲、
                  tick 播放頭管收音與進度）、試聽（previewPlayer.js：官方 Sequencer 的薄包裝）
  styles.css      唯一的樣式檔（@layer base／ui／states）
  assets/         MediaPipe 模型（.task）與 soundfont（.sf3），進 git
```

## 第三方套件

`@mediapipe/tasks-vision`（`src/vision/vision.js`）與 `spessasynth_lib`（`src/midi/synth.js`）都直接寫死完整 CDN 網址（jsDelivr）匯入，版本綁 `@latest`；沒有 import map、沒有本地副本。

## 文件

[`CLAUDE.md`](./CLAUDE.md)：怎麼跑、架構、慣例與禁止事項（給 Claude Code 也給人看）。
