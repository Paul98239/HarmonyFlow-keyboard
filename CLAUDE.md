# CLAUDE.md

本檔為 Claude Code 在此 repository 中工作時的指引，**只寫「現在的 code 怎麼運作」與規則**。需求會一直變動：每次改變就直接改本檔、刪掉過時的段落，不累積歷史、不留「先前版本怎樣」。程式碼註解同樣只留「現在做什麼／為何這樣寫」。

## 專案簡介

HarmonyFlow 是瀏覽器端的 MIDI 演奏應用：攝影機 → MediaPipe 姿勢追蹤（最多 4 人、身分鎖定）→ 拋物線手勢推著「指派給你的聲部」逐拍前進（一次有效手勢＝共用拍位固定前進一拍，不論這拍本身有沒有音符）。一個聲部只要曾經被你真實觸發過一次，之後全場停手超過短暫門檻，電腦會暫時替它代打、只走空拍（音量調低區分人／電腦），有音符的拍一定要你自己揮手，你一恢復揮手就立刻換回真人；從未被你觸發過的聲部維持靜音，不會自動代打。其餘聲部固定由「電腦輔助的聲部」播放。演奏者比原譜慢時，相連的音會延音到下一顆音，不留原譜沒有的空白；所有指派聲部都演奏完，曲子自動收尾，不需要多揮一下。純原生 JavaScript（ES module）、沒有 build step、沒有後端；介面文字與程式碼註解一律繁體中文。

- **版面**：`#app-shell` 置中一個鎖 16:9 的固定比例方框 `#camera-frame`（視窗裝得下的最大 16:9 矩形），攝影機畫面在框內；攝影機畫面永久蓋著黑幕（`#stage-blackout`，純 CSS，沒有任何切換方式，`#webcam` 也永久隱藏），非 16:9 螢幕的黑邊就是 body 的 `#000` 底色。頂端置中疊一欄 `#top-center-stack`（`position:fixed`，在框外，不受 `#camera-frame` 的 `overflow:hidden` 裁切）：播放 pill（`#toolbar-playback`，三顆獨立按鈕 ▶ 播放／❚❚ 暫停／↻ 重播（`#btnPlay`／`#btnPause`／`#btnReplay`，包在 `#transport-group`，狀態見下方「播放只由頂端播放列的按鈕觸發」）＋完整顯示的歌名，`max-width` 直接沿用 `#camera-frame` 的寬度公式、最寬不超過攝影機外框）在上，系統控制／選歌控制列（`.control-row` 底下的 `panel-system`／`panel-song`，純文字按鈕、無 icon）在下——兩者垂直分層、水平都置中，結構上不會互相遮蔽，不需要用任何寬度計算去避免碰撞；兩者各自獨立淡化、互不牽動，純 CSS `:hover`／`:has()`（沒有 JS 計時器）：碰到就顯示、沒碰到立刻淡化；控制列小面板開著時控制列自己強制顯示。還沒有能播放的歌曲之前（播放 pill 帶 `is-empty`：idle／載入中）控制列常駐不淡出——這時候它是唯一的操作入口；選好歌之後控制列回到 hover 才顯示的淡出邏輯，換成播放 pill 常駐不淡出，把畫面重心讓給攝影機與正在播放的資訊，兩條規則共用同一個「有沒有歌可播」判斷、條件互斥。`panel-system`（攝影機開關／現場人數／重置骨架 ID）是常駐區塊，一進頁面就看得到、沒有開合狀態；`panel-song`（選歌＋分譜指派）是觸發鈕＋彈出小面板，彈出面板釘在整排控制列的左下角展開（不是自己觸發鈕下方）。面板內容變多隻會往下撐到 `max-height` 再交給內部捲動——觸發鈕與✕的位置永遠不變，不會因為內容量被推移。這幾個浮動元件都以 `--ui-fs` 為基準字級、內部尺寸一律 `em`；`--ui-fs` 由 `src/ui.js` 的 `applyUiFontSize()` 綁視窗實際像素並除掉瀏覽器縮放倍率（Ctrl +/− 時 UI 視覺大小不變）。歌名優先單行顯示，超長時用 `--song-title-scale` 縮小字級撐住，縮到下限還放不下才退回換行（`src/midi/midiPlayer.js` 的 `fitSongTitle()`）。`#app-shell` 頂端貼邊另有一條獨立的 `#topProgressBar`（跨滿 `#camera-frame` 寬度、不顯示時間文字、純 CSS 對齊不用 JS 量測）：唯讀播放進度，顯示的是播放頭在原譜的第幾秒（＝所有聲部 `playSec` 的最大值，`humanPerformer.getPositionSeconds()`）換算的比例，沒人觸發時停住不動、有觸發時跳，不做補間動畫；第一次出現後就不會再因為換歌而重新收起（換歌時的空窗期維持停在舊值，不是補間，只是還沒有新的比例可以跳過去）。**不能拖曳／seek**：沒有 seek 功能，要回到開頭用播放列的 ↻ 重播。
- **姿勢偵測不是開頁就跑**：系統控制的「現場人數」沒有預設值，選了 N 之後 MediaPipe 的 `numPoses` 與追蹤槽位數（＝ ID 上限）都設成 N。同一組控制有「攝影機開關」（關閉時串流真的停掉；被拔除／被搶走也視為已關閉，按一下重連）與「重置骨架 ID」，都只能點按鈕觸發——全專案沒有任何鍵盤快捷鍵，所有互動一律靠畫面上的按鈕。
- **選歌＝載入**：本地上傳或雲端曲庫選取後立刻解析、列出每個聲部一個「指派演奏者」下拉（無／演奏者 1~N），不啟動播放。播放靠 `src/midi/humanPerformer.js` 的**事件驅動排程器**：沒有背景時鐘，共用拍位只在指派演奏者做出一次有效拋物線手勢的那一刻才前進（`buildBeatGrid()` 的律動拍）。演奏者在目前拍上還有沒播出的音，觸發就原地接手（claim）；沒有的話就把共用拍位往前走恰好一拍再接手——**每一拍（包含空拍）都需要真人自己做一次有效觸發才能往前走**，4/4 一個小節就是要觸發 4 次，不會一次跳到這個聲部下一個真正有音符的拍（見下方「拍子從哪裡來」的 N1；BPM 快、空拍多時的因應是代打，見下）。共用拍位只在 `_arbitrate()` 這個單一裁決點被改寫、一個 tick 最多前進一拍：多位演奏者同時揮手、一個人指派多個聲部（左右手）、排隊解除撞上別人的新觸發，都只前進一拍，跟聲部處理順序無關；另一位剛把拍位推到這一拍之後的短暫合併窗內晚到的揮手，視為跟上同一拍、不另外再推一拍（見 N3）。沒有任何還沒被 claim 的音的聲部（已經演奏完），它的揮手直接忽略——不推進拍位，也不會讓全曲進終局。被推進到、但沒被自己演奏者接手的那一拍＝直接靜音，不會被「別的聲部的觸發」補（跨聲部沒有代打；代打只替曾被自己演奏者真實觸發過的聲部走空拍，見下一段與「拍級接手，靜止時電腦短暫代打」）——因為任何一次觸發最多只會讓共用拍位前進一拍，這個「靜音」影響的範圍也最多只有一拍。新觸發只在「會替這個聲部開新音、而且舊音還在自然段」時才排隊，等舊音自然響完才自動補上，避免新舊音重疊，且會把排隊等掉的真實時間補回播放頭、不會因此永久落後一拍；單純走過空拍的觸發立即生效（見下方「已知且刻意保留的行為」）。拍格線由 `src/midi/midiParser.js` 的 `buildMeasureGrid()`（拍號段落）與 `buildBeatGrid()`（切成拍）依真實的拍號（含 `FF58` 的 `cc`／`bb` 兩個位元組，見下方「拍子從哪裡來」）與 ticksPerQuarter 算出；沒有拍格線（SMPTE division，A5）時忽略指派、整首自動播放。每個正在響的音各自倒數自己的原譜時長（真實經過秒數 1:1，不做任何拍速縮放），跳拍不會把它提前切斷，見下方「拍子從哪裡來」。**拋物線手勢**由 `src/vision/gesture.js` 的 `ArcDetector` 偵測手腕＋手掌合併點「先下沉再回升」的形狀（兩軸判斷、不依賴肩膀高度、開口大小方向都不限，純粹是離散的「有效觸發」訊號，不輸出音量），且每個追蹤槽位會自動鎖定先做出有效拋物線的那隻手，之後只認那隻手，避免另一隻閒置手在畫面上飄移湊出假觸發。note-on 一律用樂譜原始 velocity，不套用手勢公式；不做任何音色覆蓋，一律沿用聲部原始 MIDI 音色；不重播 CC／pitch-bend，每個聲部的音色只在載入時套用一次 bank／program（刻意的簡化）。
- **靜止代打（合奏層級）**：整個合奏只有一個倒數（`humanPerformer.js` 的 `_autopilotLeftSec`），任何一位演奏者的任何一次真人動作都讓它重新開始——所以只要還有人在揮手，誰都不會被代打。停手滿第一步門檻（`max(AUTOPILOT_IDLE_MS（800ms）, 目前拍長 × AUTOPILOT_IDLE_BEATS（1.5）)`）之後，電腦替「曾被真實觸發過」的指派聲部整批走一拍，之後每一步等剛走進那一拍的原譜秒數（代打照著原譜的速度走，跟電腦輔助的聲部對得上拍；見 N2）。只要這些聲部裡任何一個在目前拍或下一拍還有自己的音（`_autopilotBatch()`），整批不走：那顆音要它的演奏者自己觸發，代打不能替他走、也不能替別人把共用拍位推過去——空拍不用管、代打會自動一拍一拍走過去，有音符的地方一定要自己揮手。代打只走空拍、絕不開新音，所以不被舊音擋住、也不排隊；長音（例如全音符）不受影響：一顆音只在它起始的那一拍算「有音符」，後續佔用的幾拍會被代打當空拍自動走過，不需要重複觸發。倒數依 tick 的 dt 遞減，暫停期間不算靜止。代打時這個聲部的 CC7 校正到 `AUTOPILOT_VOLUME_CC`（85）——約等於電腦輔助軌的音量基準，代打當下是電腦在演奏、聽起來跟電腦輔助的聲部一致；真實觸發恢復 GM 預設 100，配合真人軌整體的 `HUMAN_EMPHASIS_GAIN`（見「兩軌模型」）形成比電腦輔助更大聲的凸顯，只調音量、不影響 note-on velocity（觸鍵力度，兩者是不同的 MIDI 概念）；從未被真實觸發過的聲部代打不會替它走，維持靜音。
- **延音**：演奏者比原譜慢時，相連的音（音符結尾到同一個聲部下一個起音點的間隙 ≤ θ，見 N4）之間會出現原譜沒有的空白，所以這種音的自然段（原譜秒數）倒數完後不送 noteOff、進入延長段，等這個聲部真正的下一個 note-on 那一刻才關（先關再開）；真正的休止（間隙 > θ）照原譜長度收，保留斷奏與休止。延長段不算「舊音還在響」（不擋新觸發），也不新增獨立的上限常數：演奏者停手超過代打第一步的等待時間、下一顆音被合奏路過丟掉、暫停／停止，延長段就結束。只在有指派聲部時才延音（整首自動播放照原譜長度收）；最後一顆音、後繼音已經先發聲的音都照原譜長度收。電腦輔助的聲部一致套用，不然同一首歌裡你控制的聲部有延音、電腦輔助的聲部卻有空白，聽起來不一致。
- **電腦輔助的聲部與曲末**：沒被指派的聲部完全不受任何人觸發影響：播放上限永遠等於「目前所有指派演奏者中推進最遠的那一位」，任一次觸發推進拍位時播放頭立刻對齊到新拍終點（`_frontierSec`），不會累積落後——因為每次最多只推進一拍，這個對齊動作也最多只會跳一拍。完全沒有人指派任何聲部時，直接退回整份照真實經過時間連續自動播放。所有指派聲部都沒有還沒被 claim 的音時自動進入終局（`_checkFinale()`）：只解除電腦輔助聲部的上限、讓尾奏照真實時間播完，不需要使用者多揮一下；指派聲部的上限不動（只有已 claim 未發聲的音會播完），不會把早就沒人揮手的聲部從舊播放頭往前追趕。只要還有任何一個指派聲部有音沒被 claim（包含演奏者缺席的聲部），就不會進終局，也不會被誰多揮一下強制播完。
- **拍級接手，靜止時電腦短暫代打**：指派的聲部每一拍都可能被你接手、由代打銜接、或直接靜音（見上「選歌＝載入」），接手與否只看「這一拍有沒有被自己演奏者的拋物線觸發、或代打推進到」，不看你在不在鏡頭裡；代打只替曾被自己演奏者真實觸發過的聲部走空拍，不會幫別的聲部補、也不會幫從未觸發過的聲部起頭。指派本身是持久設定，不隨追蹤雜訊變動。
- 聲部名一律 GM 繁中音色名（不採信檔案的軌名／樂器名），並判定高音譜／低音譜、旋律／伴奏來命名。

## 開發／執行

app 執行不需要任何本機安裝，clone 下來直接用 Live Server 開就能跑；沒有 Node 工具鏈、沒有 build step、沒有 CI。

- **VS Code Live Server**：用 VS Code 開啟專案根目錄當工作區，「Go Live」→ `http://127.0.0.1:5500/`（`.vscode/settings.json` 已設 port 與忽略清單）。ES module 與 `getUserMedia` 需要 `http(s)://`，不能用 `file://`；換其他靜態伺服器要對 `.wasm` 回 `application/wasm`。部署＝把資料夾原樣 serve 出去，本地跑起來看到的就是部署後的樣子。
- **第三方套件**：`@mediapipe/tasks-vision`（`src/vision/vision.js`）、`spessasynth_lib`（`src/midi/synth.js`）都直接寫死完整 jsDelivr CDN 網址匯入，沒有 import map、沒有本地副本，執行期需要網路。兩個套件都綁 `@latest`，不手動維護版本號，代價是 jsDelivr 對 `@latest` 有快取（瀏覽器端 7 天／邊緣節點 12 小時），版本可能在快取到期後無預警改變、且不同使用者吃到新版的時間點不一致；`spessasynth_lib` 對 `spessasynth_core`（core 對 `stb-vorbis`）宣告的相依版本本來就是 `latest`，管不到那一層，現在外層也主動浮動，兩層都是刻意選擇。
- 沒有格式化工具；寫新程式照同一個檔案既有的風格。修改後在瀏覽器開頁面檢查 console 與攝影機輸出。
- **自動化測試**：`playwright` 是 `package.json` 的 devDependency，先 `npm install`；`test/` 底下的腳本只服務開發／測試，不影響 app 本身零建置、直接從 CDN 匯入相依套件的部署方式。兩類測試：
  - `test/browser/smoke-test.mjs`（`node test/browser/smoke-test.mjs` 執行）：用 Playwright 開真的 Chromium＋假攝影機輸入，跑過選人數／載入本地樣本樂譜／指派聲部／按播放、暫停、重播整條流程（含播放列三顆按鈕在各狀態下的灰亮），檢查過程中有沒有非預期的 console error／warning／pageerror。**這個測試看不到 `spessasynth_processor.min.js`（AudioWorkletProcessor，音訊渲染執行緒）丟出的例外**：已實測確認，即使刻意讓 worklet 端丟出 Uncaught TypeError，`page.on('console')`／`page.on('pageerror')` 都收不到任何訊號，測試照樣回報「沒有問題」。牽涉 spessasynth worklet 內部狀態的 bug（例如 channel 配置、bank／program 是否真的送達）不能只靠這個測試「沒有報錯」判斷有沒有解決，要用直接印值驗證（`console.log` 搭配 `setTimeout` 讓非同步的 worklet 訊息先處理完再讀取狀態）。
  - `test/unit/*.test.mjs`（`node test/unit/midi-parser.test.mjs`、`node test/unit/human-performer.test.mjs`、`node test/unit/midi-api.test.mjs` 各自執行，純 Node，不需要瀏覽器）：對 `midiParser.js`／`humanPerformer.js`／`midiApi.js` 這類純邏輯模組直接跑回歸測試，涵蓋 SMF 解析的邊界情況（program 依時間軸查詢、running status 寬鬆讀取、命名）、排程器的核心行為（一次一拍、單一裁決點、多人合併窗、代打只填空拍與合奏層級倒數、排隊閘門與補償、延音、自動終局、重設／重播、代打音量對比，以及固定種子的整體不變量壓力測試）與雲端下載連結 log。沒有測試框架，跟 smoke-test.mjs 同一套 `run()`／`assert()` 手寫慣例。
- 只有一個進入點：`index.html` → `src/main.js`。

## 部署狀態（會變動，動手前用 `gh api repos/Paul98239/HarmonyFlow` 與 `git ls-remote` 重查）

- **`origin` 指向 `https://github.com/Paul98239/HarmonyFlow.git`**（public），`main` 分支已推上去。GitHub Pages 已啟用（來源 `main` 分支、根目錄），網址 `https://paul98239.github.io/HarmonyFlow/`。
- 專案結構照 Pages 設計（`.nojekyll`、資源全走相對路徑），不要因為改動就破壞這點。Pages 會把整個 branch 原樣 serve 出去，`index.html` 真正用到的是 `src/`（ES module、`styles.css`、`assets/` 的模型＋soundfont）；第三方套件直接連 CDN，不進 git。
- 版本快照以 annotated tag 記錄（`v0.1.0`～`v0.3.0`、`v1.0.0`）。
- **push／部署**：等使用者明確要求才 push（`commit` 這個字只代表本機提交，不含 push）；之後每次要推新版上線，直接 `git push origin main` 即可，Pages 會自動重新 build。

## 架構（index.html → src/main.js）

`index.html` 是 HTML-first：全部靜態 UI markup 都在這裡（含唯一的 `<template id="tpl-part-row">`），JS 不產生 markup。
`main.js` 是 composition root：`midiPlayer.startPlayer()` 起播放器的兩個 tick → `initUi(midiPlayer)` 掛畫面（同步；`ui.js` 不 import
播放器，由這裡交進去）→ `setPoseCountListener(midiPlayer.setPlayerCount)` → `await Promise.all([startVision({ onStatus, onError }),
midiPlayer.warmUpMidiEngine()])` 並行推進視覺與音源兩條軌道 → `setPerformanceStateListener(midiPlayer.setGesturePerformanceState)`
接手勢 → 兩邊都好才 `dismissLoading()`（淡出載入畫面、解除 `#app-shell` 的 `inert`）。功能之間不互相 import，vision → 播放器的
兩條資料流（人數、手勢）都由 `main.js` 接。

**單向資料流**：使用者操作 → `#top-center-stack` 上的三個委派監聽（click／change／input，依 `data-action`／`data-field` 分派給
各區塊的 `actions`／`fields`／`inputs`）→ 動作函式改 store（`ui.js` 的 `Store extends EventTarget`；兩個實例：`ui.js` 的 `uiStore`
與 `midi/midiPlayer.js` 的 `playerStore`）或呼叫 vision API → store 的 `'change'`（microtask 合併）→ `scheduleRender()` → 各區塊的
`render(snapshot)` 只在值不同時寫 DOM。DOM 不是真相：播放中看 `player.transport`、面板開著看 `ui.openPanel`、分譜看
`player.parts`／`player.assignments`、人數看 `getPoseCount()`。區塊模組統一形狀 `{ actions?, fields?, inputs?, mount?, render? }`
（`ui.js` 內有系統控制列與面板開合兩個，`midi/midiPlayer.js` 檔尾把四段畫面合成一個）。

| 檔案 | 職責 | 純邏輯（無 DOM） |
|---|---|---|
| `src/main.js` | 啟動、接線 | — |
| `src/ui.js` | `Store`＋`rafThrottle`、`uiStore`、載入／錯誤遮罩＋`inert`、`--ui-fs`／`--popup-max-height`、系統控制列、面板開合、事件代理、render 排程、`initUi(player)` | — |
| `src/styles.css` | 唯一的樣式來源（`@layer base, ui, states`） | — |
| `src/vision/vision.js` | 攝影機狀態機、WebGL、MediaPipe、繪製、手勢接線、舞台提示、`setPoseCountListener` | — |
| `src/vision/tracking.js` | `PersonTracker`（槽位配對，純依位置）、`AdaptivePoseFilter`、`buildDetection` | ✓ |
| `src/vision/gesture.js` | `ArcDetector`（拋物線手勢 → 離散的有效觸發訊號）、`clamp01` | ✓ |
| `src/midi/synth.js` | spessasynth 合成器：兩個合成器（電腦輔助聲部 `synth`／真人聲部 `synthHuman`）、humanGain 閘門＋音量凸顯；沒有 Sequencer，直接接收 `humanPerformer.js` 送來的個別 note 事件 | ✓ |
| `src/midi/midiPlayer.js` | 播放器：`playerStore`、選歌／播放／指派／人數動作、手勢 hook、兩個 tick ＋ 四段畫面（pill／頂端進度條／曲庫／選檔與分譜） | — |
| `src/midi/midiApi.js` | 遠端 MIDI 曲庫 client（分類／搜尋／下載），純資料 | ✓ |
| `src/midi/midiParser.js` | SMF 解析／重新編碼、GM 命名、clef／role、`buildMeasureGrid()`／`buildBeatGrid()` 小節與拍格線 | ✓ |
| `src/midi/humanPerformer.js` | 事件驅動排程器：建立聲部、依觸發（真人或代打）逐拍前進並接手（claim）或靜音、延音、發聲、重設／重播、`getPositionSeconds()` | ✓ |

import 方向：`main.js` → `ui.js`／`midi/midiPlayer.js`／`vision/vision.js`；`midi/midiPlayer.js` → `ui.js`（只拿 `Store`／`rafThrottle`）、
`synth.js`、`midiParser.js`、`midiApi.js`；`ui.js` → `vision/vision.js`；`midi/synth.js` → `humanPerformer.js`；
`midi/humanPerformer.js` → `midiParser.js`（只拿 `buildBeatGrid`）；
`vision/vision.js` → `tracking.js`、`gesture.js`（`ArcDetector`）；
`vision/tracking.js` → `gesture.js`（`clamp01`）。無循環。

## 拍子從哪裡來：規格 vs 假設

SMF 規格保證的是「格線」：`division`／`FF 51`（速度）／`FF 58`（拍號，含 `nn dd cc bb` 四個
位元組）這幾樣資料就能把任何一個 tick 精確換算成第幾拍第幾秒——`FF 58` 的 `cc`（節拍器每響
一次隔幾個 MIDI clock）其實是規格明訂的律動拍長、`bb`（一個 MIDI 四分音符等於幾個記譜
三十二分音符）決定記譜拍長，兩者都是確定性計算，`buildMeasureGrid()`／`buildBeatGrid()`
現在照這兩個欄位算，不是只靠拍號分母去猜。格線上規格真的沒有寫的「音樂意義」（小節線本身、
弱起、強弱、swing）仍然只能由應用層推導，而推導必然帶假設——任何宣稱「從 MIDI 讀出拍子」
的功能都要清楚寫出用了哪些假設，不能包裝成規格事實。目前成立的假設列在這裡，之後哪條被實作掉
就直接從清單移走：

| # | 假設 |
|---|---|
| A1 | 弱起拍（anacrusis）不處理，格線一律從 tick 0 起算 |
| A3 | 同一 tick 有衝突的速度事件，取先出現的那一個 |
| A4 | 拍號變更處強制斷一條小節線，該段最後一小節可能不完整；全曲最後一小節不截短 |
| A5 | SMPTE division 沒有拍格線，`buildMeasureGrid()` 回空陣列；`humanPerformer.load()` 遇到這種檔案忽略指派、整首自動播放 |
| A6 | 高低音譜／旋律・伴奏（`clef`／`role`）是啟發式門檻，不是規格欄位 |
| A7 | 強弱與 swing 完全不推導，每一拍等長、無輕重之分 |
| A8 | 聲部識別（`partId`）不含 port（`FF21`——這個欄位其實不在 RP-001 正式定義的 meta event 清單裡，是業界常見但未被正式標準化的慣例欄位；RP-019 定義的是 `FF09` Device Name，並把它描述成「取代 cable number（即 `FF21`）的更好做法」，隱含同一軌對應一個裝置的假設，但這是慣例推論、不是 RP-019 對 `FF21` 本身的規定）：同軌內中途切換 port 違反這個慣例，`parseTrack()` 會偵測並警告這種檔案，但 partId 不會因此自動修正，重複的 channel 號碼仍可能被誤併成同一聲部 |
| A9 | 聲部識別不含 bank（CC0/32），同 channel＋program 但中途換過 bank 視為同一聲部；Bank Select 本身要等 Program Change 才生效（GM2 §3.3.1），送了 bank select 卻整軌沒有 program change 的邊緣情況會用最後一組 bank 硬猜 |
| A13 | `buildMeasureGrid()` 的律動拍長優先採用 `cc` 換算，但 `cc = 24`（MIDI 的內建預設值，多數編曲軟體不論拍號一律照抄）一律視為「檔案沒有表態」而退回拍號分母音符——複拍子（如 6/8）若真的把 `cc` 寫成 24，仍會切成分母音符的拍數，不是實際律動單位 |
| N1 | 一次有效拋物線＝共用拍位往前走恰好一拍（`buildBeatGrid()` 的律動拍），不管這拍本身有沒有音符，不會跳到觸發者下一個真正有音符的拍；已經有音符在目前拍等待播出時，觸發直接原地 claim、不額外前進。這個顆粒度是使用者明確拍板的目標（4/4 一個小節要觸發 4 次）：`7a21261`／`10e58f9` 兩個歷史 commit 之間曾經換過來又換回去——`7a21261` 試過同一個一拍一拍走的做法，`10e58f9` 因為長音／長休止要揮很多次手太累而改回跳拍；這次使用者衡量過疲勞問題後決定改回一拍一拍走，改用代打（N2）處理空拍不用管的部分 |
| N2 | 靜止代打只替「曾被真實觸發過」的指派聲部整批走空拍：`_autopilotBatch()` 檢查這些聲部下一顆還沒被 claim 的音（`_nextUnclaimedNote()`）是不是都離共用拍位至少還有兩拍——只要任何一個在目前拍或下一拍還有自己的音，整批不走，必須真人觸發；一次只走一拍（跟 N1 完全相同的顆粒度，絕不會自己跳過真的有音符的拍）。等待時間：第一步 `max(AUTOPILOT_IDLE_MS, 目前拍長 × AUTOPILOT_IDLE_BEATS)`（慢曲準時每拍揮一次的演奏者不會被搶先走一拍），之後每一步等剛走進那一拍的原譜秒數——這些是應用層數字，不是規格，跟演奏者的揮手間隔完全無關。這個等待時間只決定「下一次何時該視同觸發」這一個排程時間點，絕不用來縮放任何正在響的音的剩餘時長——這是避開舊版拍速估計器 bug（`85c6913` 撤銷的機制）的關鍵邊界。曾經試過改成「對演奏者過去的真實觸發間隔取指數平滑」來估計代打節奏、一次跳過一整段休止，實測發現正常演奏遇到合法的長休止時，代打會在休止途中提早觸發、演奏者準時的下一次觸發又被排隊補一次，等於同一段音樂被算兩次（棘輪效應）；改成現在這個「一次一拍、有音符就不走」的做法後，代打在架構上就不可能再跳過任何真人該觸發的音符 |
| N3 | 多人合併窗：某位演奏者的揮手落在「另一位剛把共用拍位推到這一拍」之後 `min(FOLLOW_WINDOW_MS（250ms）, 拍長 × FOLLOW_WINDOW_BEAT_RATIO（0.4）)` 內、而且他自己這一拍還沒動作過，視為跟上同一拍、不另外再推一拍——多人幾乎同時揮手是常態，各推一拍會讓合奏從第一下起就比最慢的人多走一拍。窗只從「真人」的前進算起，代打走的那一步不開窗（演奏者靠代打填空拍、緊接著準時揮手，是他自己的下一拍，不能被吸收）。兩個數字都是應用層數字，不是規格 |
| N4 | 延音的「小間隙」門檻 θ ＝ ticksPerQuarter ÷ `SUSTAIN_GAP_DIVISOR`（16；480 tpq 時 30 tick）：MuseScore 把相連音符寫成「記譜長度 − 1 tick」（間隙固定 1 tick），真正的最短休止（三十二分休止）≥ 60 tick，θ 落在兩者中間的空檔（曲庫實測 83% 的間隙 ≤ 30 tick）。這是應用層數字，不是規格；用 tick 不用秒，跟速度無關；SMPTE division 沒有 tick 換算，不延音 |

音符播放速度（播放頭前進、音符要響多久）**固定等於它在 SMF 檔案裡的真實原譜秒數**，不受揮手
快慢影響、不做任何現場拍速估計——這不是應用層假設，是直接沿用規格保證的 `tickToSeconds()`
算出來的數字（曾經試過依揮手間隔反推現場拍速、讓播放頭與音長跟著縮放的版本，使用者實測後
認為「手不動時音符被拖長」不可接受，見專案的 git 歷史，改回這個更直接的模型）。唯一的例外是延音：相連的音
（N4）自然段結束後會撐到這個聲部下一顆音真正開出去為止，但結束的時刻由離散事件決定（下一個 note-on、演奏者
閒置門檻、下一顆音被路過丟掉），不涉及任何拍速估計或縮放；手完全不動時，超過門檻就照原譜秒數收。

已知且刻意保留的行為：新觸發（真人）只在「會替這個聲部開新音、而且舊音還在自然段（原譜秒數還沒倒數完）」時才排隊
（`humanPerformer.js` 的 `_isBlocked()`；`pendingTrigger`／`pendingIsAutopilot` 記錄排隊當下的來源），等舊音自然響完才自動補上——
新舊音保證不重疊，代價是演奏者揮得比原譜快時，新音要等舊音放完才出聲，不是 0 delay；跟上或慢於原譜速度則完全感覺不到延遲。
單純走過空拍（沒有新音可開）的觸發、代打（只走空拍）、以及吸收同一拍內多揮的一次手，都不排隊、立即生效，所以全音符響著的
那幾拍不會卡住揮手。排隊解除的那一刻會把等待掉的真實時間補回播放頭（上限卡在這一拍第一顆還沒發聲的音的起點，避免補過頭），
這個聲部不會因為排過一次隊就從此永久落後一拍。舊音一律照它自己完整的原譜秒數播完（相連的音另有延音，見「延音」），不會被
跳拍或代打提早切掉；演奏者停手超過代打門檻之後，延長中的音收掉、之後一律照原譜秒數，沒有任何機制會把音符拉長超過這個限度
或卡住。音放完之後，若這個聲部先前已經被真實觸發過，會由代打接手繼續走空拍（見上「靜止代打」），從未被觸發過的聲部則維持靜音。

## 慣例與禁止事項

- **語言**：介面文字與程式碼註解一律繁體中文。
- **樣式**：JS 不寫 `element.style` 或行內 `style`；顯示／隱藏切原生 `hidden` 屬性（`el.hidden = bool`），其他狀態切 `is-*` class，純呈現寫在 `src/styles.css`；明文例外只有三個連續量：`--ui-fs`、頂端歌名單行縮放用的 `--song-title-scale`、彈出面板高度上限 `--popup-max-height`。`styles.css` 用 `@layer base, ui, states` 三層，新規則一定要放進對應的層（沒包層的規則會贏過所有層）；`states` 層永遠贏，不用 `!important`。
- **HTML-first 與清單**：靜態 UI 一律寫在 `index.html`，JS 不用字串產生 markup、不用 `innerHTML`；重複結構用 `<template>`（目前只有分譜列 `tpl-part-row`）clone，文字用 `textContent`、下拉用 `new Option()`，聲部名等外部字串因此不需要跳脫。
- **事件與狀態**：控制項的行為經 `data-action`（click）／`data-field`（change／input）委派到 `#top-center-stack`，不逐元素 `addEventListener`；狀態放 `playerStore`／`uiStore`，畫面由 `render(snapshot)` 依狀態畫，DOM 不是真相；巢狀物件（Map、library）改動時換新參照。一次性動畫（重置鈕閃黃）例外，handler 直接切 class。
- **版面**：`#camera-frame` 鎖 16:9（F11 穩定性），不要改回滿版；不要用 `max-width/max-height:100% + aspect-ratio`（flex 裡會塌成 0 高）；攝影機容器不能用 JS 在執行期搬動（`vision.js` 模組頂層就抓 DOM）；開機期間擋互動靠 `#app-shell` 的 `inert`，不靠遮罩的 z-index；`#stage-hint` 必須 absolute。`--ui-fs` 必須由 JS 綁視窗實際像素並除掉縮放倍率（混 vw 或純固定 px 都不對）。
- **控制列小面板**（`panel-song`）只能用 ✕、再按觸發鈕關閉，**不做「點外部關閉」**；`panel-system` 是常駐區塊，沒有開合狀態。彈出面板釘在整排控制列左下角、向下展開（不是自己觸發鈕下方，開合狀態是 `uiStore.openPanel`）。控制列與頂端播放 pill 垂直疊在同一欄（`#top-center-stack`）、結構上不會互相遮蔽，不用算誰佔多少水平寬度；歌名完整顯示不截斷；`#midiStatusText` 只放歌名，不寫「解析中／下載中」。全專案沒有任何鍵盤快捷鍵（包含關閉面板）。
- **播放只由頂端播放列的按鈕觸發**：▶ 播放（`#btnPlay`）、❚❚ 暫停（`#btnPause`）、↻ 重播（`#btnReplay`）三顆獨立按鈕。選歌＝載入（雲端曲庫選取即下載）、改指派都不觸發播放，下次按播放時靠簽章比對重新載入。三顆按鈕互相防呆：狀態由 `midiPlayer.js` 的 `transportButtonState()` 依 store 推導（灰＝`disabled`），`data-action` 進來時再對一次表（連按、程式呼叫都繞不過去）；載入中（`busy`）三顆立即全灰。

  | 狀態 | ▶ 播放 | ❚❚ 暫停 | ↻ 重播 |
  |---|---|---|---|
  | 沒有歌（idle）／載入中 | 灰 | 灰 | 灰 |
  | 已載入、還沒播過 | 可按 | 灰 | 灰（已經在開頭） |
  | 播放中 | 灰 | 可按（accent 黃底 `is-current`） | 灰 |
  | 暫停（播到一半） | 可按（續播） | 灰 | 可按 |
  | 播完 | 可按（從頭播） | 灰 | 可按 |

  ↻ 與播完後的 ▶ 共用 `humanPerformer._resetPlayback()`（跟 `stop()` 同一個重設函式）：拍位、共用上限、每個聲部的游標／播放頭／claim／排隊、代打與合併窗紀錄、閒置計時、CC7 都退回剛載入的樣子，代打要等真人重新觸發過才會啟動。任何新增的排程器狀態欄位都要在 `_resetPlayback()` 重設（單元測試有整體快照比對，忘了會直接失敗）；若指派改過（簽章不同）則走完整重新載入。
- **指派持久**：下拉恆列「現場人數」個 ID，不隨鏡頭當下偵測到幾人增減；某 ID 不在場就是收不到新觸發，被路過的拍直接靜音（見上「拍級接手，沒接手就靜音」），指派本身留著、不會被清掉。
- **兩軌模型**：電腦輔助軌固定不動（不掛額外 gain、不跟隨，反應式跟著指派演奏者推進最遠的進度播放，觸發當下立刻對齊、不落後），是音量對比的固定基準；指派聲部固定走真人軌，接手（真實觸發或代打）才發聲，velocity 一律用樂譜原值，不套用手勢公式；真人軌整體的 `humanGain` 開啟時刻意調到比電腦輔助軌大聲（`synth.js` 的 `HUMAN_EMPHASIS_GAIN`），凸顯使用者控制的聲部；沒有背景時鐘，共用拍位只在有效觸發（真實或代打）那一刻才前進一拍；代打時這個聲部的 CC7 校正到約等於電腦輔助軌的音量基準（`AUTOPILOT_VOLUME_CC`——代打當下是電腦在演奏，音量跟電腦輔助的聲部一致，真正的凸顯完全交給真人觸發時的 `HUMAN_EMPHASIS_GAIN`），只調音量、不動 velocity；音符播放速度固定等於原譜真實秒數，不做任何現場拍速估計（見「拍子從哪裡來」），不做任何音色覆蓋、不做持續的 CC11 表情覆蓋。
- **在場清單目前只是保留欄位**：`arcTriggerSeqBySlot`／`presentSlots` 仍由 `vision.js` 逐幀送出（心跳 `EMIT_HEARTBEAT_MS` 100ms、`midiPlayer.js` 的斷訊看門狗 `GATE_STALE_MS` 250ms 讓 `presentSlots` 在斷訊後清空），但 `humanPerformer.js` 目前只讀 `triggerSeq`（斷訊時刻意不歸零，避免誤判成一次新觸發）——`present` 沒有驅動任何行為；接手判定靠「有沒有新的 triggerSeq」，不看 `present`，這個欄位是為了將來可能需要更精確依在場狀態調整行為留著的介面。
- **追蹤層只貼標籤、不動畫面**：不刪、不合併、不替換 MediaPipe 這一幀給的偵測；位置門檻以肩寬為單位、緩衝以毫秒為單位；「同一具身體」只看肩膀中點 < 0.5 肩寬；平滑跟不跟得上動作調 `AdaptivePoseFilter` 的 `PREDICT_MS`，多人站太近骨架互相黏住調 `PersonTracker` 的 `ambiguityFloorRatio`（實測後可能還要繼續調整，目前 0.4）。ID 只是槽位編號的顯示提示，不做身分鎖定／認回：槽位釋放後下一個偵測到的人直接取用空槽位，不使用服裝顏色判斷身分。
- **現場人數**沒選之前不推論；人數同時是 `numPoses` 與追蹤槽位數，改人數等於重置 ID，且隨時可改（播放中也一樣，不需要先暫停）。Pose landmarker 是**單一實例、完全懶惰載入**：開頁不預建任何一份，第一次選人數（或選到還沒建過的人數）才建置，通常要等 1~2 秒；等待期間 `vision.js` 用舊的那份（若有）繼續正常推論，畫面不會凍結。切換成功不顯示任何提示（下拉不鎖，靠防抖＋單飛擋快速連續切換，成功後 `src/ui.js` 只留一行 `console.log` 方便除錯）；只有失敗才用 `#system-note` 顯示錯誤訊息。建好才換手、換手時立刻關掉舊的那份（`requestLandmarker()`），穩定狀態下只有一份 landmarker 活著。只有 `lite` 一種模型，沒有切換機制（`full`／`heavy` 模型檔與 `setPoseModel()` 已移除）。
- **MIDI 一律對規格**（SMF 1.0、MIDI 1.0、GM1／GM2）：velocity 1~127、pitch bend 14-bit、CC 編號、Bank Select；聲部名一律 GM 繁中音色名；分譜解析失敗不擋播放。
- **資源載入只用瀏覽器原生機制**（preload／modulepreload）：不加自訂下載器、不用 Service Worker、不加載入進度條。新增 `src/**/*.js` 模組要補一行 modulepreload。`fetchWithTimeout` 只管標頭不管 body。
- **第三方套件**：直接從 CDN（jsDelivr）匯入，版本號寫死在匯入的網址常數裡；不寫本地副本、不用 import map；不用 Git LFS（Pages 不解 pointer）。
- **效能**：骨架用 `Path2D` 批次。追蹤層不做服裝顏色採樣，每幀沒有額外的 `getImageData` 呼叫。
- **防呆**：曲庫 API 回傳的每一筆都當成可能是壞的；清單用 `<template>`＋`textContent`，沒有 `innerHTML`；`synth.js` 的 `initEngine()` 失敗要讓使用者看得到，且失敗時關掉 `AudioContext`。
- **console 只在真的出問題時輸出**（`warn`／`error`）：正常運作（開機成功、攝影機取得的實際解析度⋯）不寫確認性 log；兩個例外各留一行 `console.log` 方便除錯：「現場人數」切換成功（見上「現場人數」），與雲端曲庫下載前的連結（`midiApi.js` 的 `downloadMidiFile()`：`[雲端下載] ID: … | URL: …`，下載失敗時也先有這一行，方便拿連結追查）。
- **不加格式化工具**（Prettier／Biome 等）、不做全面重排；照同一個檔案既有的風格寫。
- **git**：等使用者說「commit」才提交（開分支 → `--ff-only` 合回 `main` → 刪分支）；**不 push**，等使用者之後明確要求才 push。
