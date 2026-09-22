# CLAUDE.md

本檔為 Claude Code 在此 repository 中工作時的指引，**只寫「現在的 code 怎麼運作」與規則**。需求會一直變動：每次改變就直接改本檔、刪掉過時的段落，不累積歷史、不留「先前版本怎樣」。程式碼註解同樣只留「現在做什麼／為何這樣寫」。

## 專案簡介

HarmonyFlow 是瀏覽器端的 MIDI 演奏應用：攝影機 → MediaPipe 姿勢追蹤（最多 4 人、身分鎖定）→ 拋物線手勢推著「指派給你的聲部」前進到下一個真正有音符的拍（可能一次跨過好幾個空拍，全音符只需要一次），沒被接手的拍就是靜音、不會被電腦補，其餘聲部固定由電腦伴奏。純原生 JavaScript（ES module）、沒有 build step、沒有後端；介面文字與程式碼註解一律繁體中文。

- **版面**：`#app-shell` 置中一個鎖 16:9 的固定比例方框 `#camera-frame`（視窗裝得下的最大 16:9 矩形），攝影機畫面在框內；攝影機畫面永久蓋著黑幕（`#stage-blackout`，純 CSS，沒有任何切換方式，`#webcam` 也永久隱藏），非 16:9 螢幕的黑邊就是 body 的 `#000` 底色。頂端置中疊一欄 `#top-center-stack`（`position:fixed`，在框外，不受 `#camera-frame` 的 `overflow:hidden` 裁切）：播放 pill（`#toolbar-playback`，播放／暫停切換鈕＋完整顯示的歌名，`max-width` 直接沿用 `#camera-frame` 的寬度公式、最寬不超過攝影機外框）在上，系統控制／選歌控制列（`.control-row` 底下的 `panel-system`／`panel-song`，純文字按鈕、無 icon）在下——兩者垂直分層、水平都置中，結構上不會互相遮蔽，不需要用任何寬度計算去避免碰撞；兩者各自獨立淡化，純 CSS `:hover`／`:has()`（沒有 JS 計時器）：碰到就顯示、沒碰到立刻淡化；碰到控制列時播放 pill 也會跟著顯示（可以順便看到現在播的是哪首），但碰到播放 pill 不會連帶顯示控制列；控制列小面板開著時兩者都強制顯示。`panel-system`（攝影機開關／現場人數／重置骨架 ID）是常駐區塊，一進頁面就看得到、沒有開合狀態；`panel-song`（選歌＋分譜指派）是觸發鈕＋彈出小面板，彈出面板釘在整排控制列的左下角展開（不是自己觸發鈕下方）。面板內容變多隻會往下撐到 `max-height` 再交給內部捲動——觸發鈕與✕的位置永遠不變，不會因為內容量被推移。這幾個浮動元件都以 `--ui-fs` 為基準字級、內部尺寸一律 `em`；`--ui-fs` 由 `src/ui.js` 的 `applyUiFontSize()` 綁視窗實際像素並除掉瀏覽器縮放倍率（Ctrl +/− 時 UI 視覺大小不變）。歌名優先單行顯示，超長時用 `--song-title-scale` 縮小字級撐住，縮到下限還放不下才退回換行（`src/midi/midiPlayer.js` 的 `fitSongTitle()`）。`#app-shell` 頂端貼邊另有一條獨立的 `#topProgressBar`（跨滿 `#camera-frame` 寬度、不顯示時間文字、純 CSS 對齊不用 JS 量測）：唯讀播放進度，顯示的是播放頭在原譜的第幾秒（＝所有聲部 `playSec` 的最大值，`humanPerformer.getPositionSeconds()`）換算的比例，沒人觸發時停住不動、有觸發時跳，不做補間動畫。**不能拖曳／seek**：憑空跳過的拍要不要補聲音會直接牴觸「沒接手就靜音、沒有代打」。
- **姿勢偵測不是開頁就跑**：系統控制的「現場人數」沒有預設值，選了 N 之後 MediaPipe 的 `numPoses` 與追蹤槽位數（＝ ID 上限）都設成 N。同一組控制有「攝影機開關」（關閉時串流真的停掉；被拔除／被搶走也視為已關閉，按一下重連）與「重置骨架 ID」，都只能點按鈕觸發——全專案沒有任何鍵盤快捷鍵，所有互動一律靠畫面上的按鈕。
- **選歌＝載入**：本地上傳或雲端曲庫選取後立刻解析、列出每個聲部一個「指派演奏者」下拉（無／演奏者 1~N），不啟動播放。播放靠 `src/midi/humanPerformer.js` 的**事件驅動排程器**：沒有背景時鐘，共用拍位只在指派演奏者做出一次有效拋物線手勢的那一刻才前進——推到這個聲部下一個真正有音符的拍（可能一次跨過好幾個沒有音符的空拍）。演奏者在目前拍上還有沒播出的音，觸發就原地接手（claim）；沒有的話就先把共用拍位推到下一個真正有音符的拍再接手。拍格線由 `src/midi/midiParser.js` 的 `buildMeasureGrid()`（拍號段落）與 `buildBeatGrid()`（切成拍）依真實的拍號與 ticksPerQuarter 算出。被路過、但沒被自己演奏者接手的聲部＝那個地方直接靜音，不會被電腦補（沒有代打）。每個正在響的音各自倒數自己的原譜時長（真實經過秒數 1:1，不做任何拍速縮放），跳拍不會把它提前切斷，也不會被它擋住出不了下一個音，見下方「拍子從哪裡來」。**拋物線手勢**由 `src/vision/gesture.js` 的 `ArcDetector` 偵測手腕＋手掌合併點「先下沉再回升」的形狀（兩軸判斷、不依賴肩膀高度、開口大小方向都不限，純粹是離散的「有效觸發」訊號，不輸出音量），且每個追蹤槽位會自動鎖定先做出有效拋物線的那隻手，之後只認那隻手，避免另一隻閒置手在畫面上飄移湊出假觸發。note-on 一律用樂譜原始 velocity，不套用手勢公式；不做任何音色覆蓋，一律沿用聲部原始 MIDI 音色；不重播 CC／pitch-bend，每個聲部的音色只在載入時套用一次 bank／program（刻意的簡化）。**未指派的電腦伴奏**完全不受任何人觸發影響：播放上限永遠等於「目前所有指派演奏者中推進最遠的那一位」，任一次觸發推進拍位時伴奏播放頭立刻對齊到新拍起點，不會累積落後。完全沒有人指派任何聲部時，直接退回整份照真實經過時間連續自動播放。
- **拍級接手，沒接手就靜音**：指派的聲部每一拍都可能被你接手或直接靜音（見上「選歌＝載入」），接手與否只看「這一拍有沒有被自己演奏者的拋物線觸發推進到」，不看你在不在鏡頭裡，沒有電腦代打；指派本身是持久設定，不隨追蹤雜訊變動。
- 聲部名一律 GM 繁中音色名（不採信檔案的軌名／樂器名），並判定高音譜／低音譜、旋律／伴奏來命名。

## 開發／執行

app 執行不需要任何本機安裝，clone 下來直接用 Live Server 開就能跑；沒有 Node 工具鏈、沒有 build step、沒有 CI。

- **VS Code Live Server**：用 VS Code 開啟專案根目錄當工作區，「Go Live」→ `http://127.0.0.1:5500/`（`.vscode/settings.json` 已設 port 與忽略清單）。ES module 與 `getUserMedia` 需要 `http(s)://`，不能用 `file://`；換其他靜態伺服器要對 `.wasm` 回 `application/wasm`。部署＝把資料夾原樣 serve 出去，本地跑起來看到的就是部署後的樣子。
- **第三方套件**：`@mediapipe/tasks-vision`（`src/vision/vision.js`）、`spessasynth_lib`（`src/midi/synth.js`）都直接寫死完整 jsDelivr CDN 網址匯入，沒有 import map、沒有本地副本，執行期需要網路。兩個套件都綁 `@latest`，不手動維護版本號，代價是 jsDelivr 對 `@latest` 有快取（瀏覽器端 7 天／邊緣節點 12 小時），版本可能在快取到期後無預警改變、且不同使用者吃到新版的時間點不一致；`spessasynth_lib` 對 `spessasynth_core`（core 對 `stb-vorbis`）宣告的相依版本本來就是 `latest`，管不到那一層，現在外層也主動浮動，兩層都是刻意選擇。
- 沒有格式化工具、沒有測試；寫新程式照同一個檔案既有的風格。修改後在瀏覽器開頁面檢查 console 與攝影機輸出。
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
| `src/midi/synth.js` | spessasynth 合成器：兩個合成器（伴奏 `synth`／真人聲部 `synthHuman`）、humanGain 閘門；沒有 Sequencer，直接接收 `humanPerformer.js` 送來的個別 note 事件 | ✓ |
| `src/midi/midiPlayer.js` | 播放器：`playerStore`、選歌／播放／指派／人數動作、手勢 hook、兩個 tick ＋ 四段畫面（pill／頂端進度條／曲庫／選檔與分譜） | — |
| `src/midi/midiApi.js` | 遠端 MIDI 曲庫 client（分類／搜尋／下載），純資料 | ✓ |
| `src/midi/midiParser.js` | SMF 解析／重新編碼、GM 命名、clef／role、`buildMeasureGrid()`／`buildBeatGrid()` 小節與拍格線 | ✓ |
| `src/midi/humanPerformer.js` | 事件驅動排程器：建立聲部、依觸發前進到下一個有音符的拍並接手（claim）或靜音、發聲、`getPositionSeconds()` | ✓ |

import 方向：`main.js` → `ui.js`／`midi/midiPlayer.js`／`vision/vision.js`；`midi/midiPlayer.js` → `ui.js`（只拿 `Store`／`rafThrottle`）、
`synth.js`、`midiParser.js`、`midiApi.js`；`ui.js` → `vision/vision.js`；`midi/synth.js` → `humanPerformer.js`；
`midi/humanPerformer.js` → `midiParser.js`（只拿 `buildBeatGrid`）；
`vision/vision.js` → `tracking.js`、`gesture.js`（`ArcDetector`）；
`vision/tracking.js` → `gesture.js`（`clamp01`）。無循環。

## 拍子從哪裡來：規格 vs 假設

SMF 規格保證的是「格線」：`division`／`FF 51`（速度）／`FF 58`（拍號）三樣資料就能把任何一個
tick 精確換算成第幾拍第幾秒，`src/midi/midiParser.js` 的 `buildTempoMap()`／`buildMeasureGrid()`／
`buildBeatGrid()` 是確定性計算，不是推導。格線上的「音樂意義」（小節線本身、弱起、強弱、swing、
複拍子的實際律動）規格沒有寫，只能由應用層推導，而推導必然帶假設——任何宣稱「從 MIDI 讀出拍子」
的功能都要清楚寫出用了哪些假設，不能包裝成規格事實。目前成立的假設列在這裡，之後哪條被實作掉
就直接從清單移走：

| # | 假設 |
|---|---|
| A1 | 弱起拍（anacrusis）不處理，格線一律從 tick 0 起算 |
| A2 | 一拍＝拍號分母那個音符（`buildMeasureGrid()`）：6/8 被切成 6 個八分音符單位，不是實際律動的 2 個附點四分音符 |
| A3 | 同一 tick 有衝突的速度事件，取先出現的那一個 |
| A4 | 拍號變更處強制斷一條小節線，該段最後一小節可能不完整；全曲最後一小節不截短 |
| A5 | SMPTE division 沒有拍格線，`buildMeasureGrid()` 回空陣列 |
| A6 | 高低音譜／旋律・伴奏（`clef`／`role`）是啟發式門檻，不是規格欄位 |
| A7 | 強弱與 swing 完全不推導，每一拍等長、無輕重之分 |
| A8 | 聲部識別（`partId`）不含 port（FF21），同軌內中途切換 port 可能把重複的 channel 號碼誤併成同一聲部 |
| A9 | 聲部識別不含 bank（CC0/32），同 channel＋program 但中途換過 bank 視為同一聲部；Bank Select 本身要等 Program Change 才生效（GM2 §3.3.1），送了 bank select 卻整軌沒有 program change 的邊緣情況會用最後一組 bank 硬猜 |
| A10 | 拍號的 `bb`（三十二分音符換算，FF58 第 4 位元組）沒被拍長公式採用——`bb=8` 時公式結果相同，沒有已知檔案用別的值 |
| A11 | Channel 10／11 的鼓組判定只看 channel 號碼，不看 GM2 允許的 bank 切換（79H/78H） |
| A12 | GM2 底下旋律通道的預設 bank 是 79H/00H（121/0），不是 MSB=0 |
| N1 | 一次有效拋物線＝前進到這個聲部下一個真正有音符的拍（可能跨過好幾個空拍，全音符只需要一次） |

音符播放速度（播放頭前進、音符要響多久）**固定等於它在 SMF 檔案裡的真實原譜秒數**，不受揮手
快慢影響、不做任何現場拍速估計——這不是應用層假設，是直接沿用規格保證的 `tickToSeconds()`
算出來的數字（曾經試過依揮手間隔反推現場拍速、讓播放頭與音長跟著縮放的版本，使用者實測後
認為「手不動時音符被拖長」不可接受，見專案的 git 歷史，改回這個更直接的模型）。

已知且刻意保留的行為：新觸發永遠立即出聲，舊音一律照它自己完整的原譜秒數播到底，不會被提早
收掉——如果演奏者揮得比原譜快，舊音會跟新音疊在一起響一段時間（疊多久＝超前了多少）；跟上
或慢於原譜速度則完全不會重疊。這是「新音 0 delay」與「舊音不被提早收掉」兩個都要時，數學上
必然的取捨，不是 bug。手完全靜止時，正在響的音就是照它自己的原譜秒數播完，沒有任何機制會把
它拉長或卡住。

## 慣例與禁止事項

- **語言**：介面文字與程式碼註解一律繁體中文。
- **樣式**：JS 不寫 `element.style` 或行內 `style`；顯示／隱藏切原生 `hidden` 屬性（`el.hidden = bool`），其他狀態切 `is-*` class，純呈現寫在 `src/styles.css`；明文例外只有三個連續量：`--ui-fs`、頂端歌名單行縮放用的 `--song-title-scale`、彈出面板高度上限 `--popup-max-height`。`styles.css` 用 `@layer base, ui, states` 三層，新規則一定要放進對應的層（沒包層的規則會贏過所有層）；`states` 層永遠贏，不用 `!important`。
- **HTML-first 與清單**：靜態 UI 一律寫在 `index.html`，JS 不用字串產生 markup、不用 `innerHTML`；重複結構用 `<template>`（目前只有分譜列 `tpl-part-row`）clone，文字用 `textContent`、下拉用 `new Option()`，聲部名等外部字串因此不需要跳脫。
- **事件與狀態**：控制項的行為經 `data-action`（click）／`data-field`（change／input）委派到 `#top-center-stack`，不逐元素 `addEventListener`；狀態放 `playerStore`／`uiStore`，畫面由 `render(snapshot)` 依狀態畫，DOM 不是真相；巢狀物件（Map、library）改動時換新參照。一次性動畫（重置鈕閃黃）例外，handler 直接切 class。
- **版面**：`#camera-frame` 鎖 16:9（F11 穩定性），不要改回滿版；不要用 `max-width/max-height:100% + aspect-ratio`（flex 裡會塌成 0 高）；攝影機容器不能用 JS 在執行期搬動（`vision.js` 模組頂層就抓 DOM）；開機期間擋互動靠 `#app-shell` 的 `inert`，不靠遮罩的 z-index；`#stage-hint` 必須 absolute。`--ui-fs` 必須由 JS 綁視窗實際像素並除掉縮放倍率（混 vw 或純固定 px 都不對）。
- **控制列小面板**（`panel-song`）只能用 ✕、再按觸發鈕關閉，**不做「點外部關閉」**；`panel-system` 是常駐區塊，沒有開合狀態。彈出面板釘在整排控制列左下角、向下展開（不是自己觸發鈕下方，開合狀態是 `uiStore.openPanel`）。控制列與頂端播放 pill 垂直疊在同一欄（`#top-center-stack`）、結構上不會互相遮蔽，不用算誰佔多少水平寬度；歌名完整顯示不截斷；`#midiStatusText` 只放歌名，不寫「解析中／下載中」。全專案沒有任何鍵盤快捷鍵（包含關閉面板）。
- **播放只由頂端 `#btnPlayPause` 觸發**：選歌＝載入（雲端曲庫選取即下載）、改指派都不觸發播放，下次按播放時靠簽章比對重新載入。
- **指派持久**：下拉恆列「現場人數」個 ID，不隨鏡頭當下偵測到幾人增減；某 ID 不在場就是收不到新觸發，被路過的拍直接靜音（見上「拍級接手，沒接手就靜音」），指派本身留著、不會被清掉。
- **兩軌模型**：伴奏軌固定不動（不掛額外 gain、不跟隨，反應式跟著指派演奏者推進最遠的進度播放，觸發當下立刻對齊、不落後）；指派聲部固定走真人軌，接手才發聲，velocity 一律用樂譜原值，不套用手勢公式；沒有背景時鐘，共用拍位只在有效觸發那一刻才前進到下一個真正有音符的拍；音符播放速度固定等於原譜真實秒數，不做任何現場拍速估計（見「拍子從哪裡來」），不做任何音色覆蓋、不做持續的 CC11 表情覆蓋。
- **在場清單目前只是保留欄位**：`arcTriggerSeqBySlot`／`presentSlots` 仍由 `vision.js` 逐幀送出（心跳 `EMIT_HEARTBEAT_MS` 100ms、`midiPlayer.js` 的斷訊看門狗 `GATE_STALE_MS` 250ms 讓 `presentSlots` 在斷訊後清空），但 `humanPerformer.js` 目前只讀 `triggerSeq`（斷訊時刻意不歸零，避免誤判成一次新觸發）——`present` 沒有驅動任何行為；接手判定靠「有沒有新的 triggerSeq」，不看 `present`，這個欄位是為了將來可能需要更精確依在場狀態調整行為留著的介面。
- **追蹤層只貼標籤、不動畫面**：不刪、不合併、不替換 MediaPipe 這一幀給的偵測；位置門檻以肩寬為單位、緩衝以毫秒為單位；「同一具身體」只看肩膀中點 < 0.5 肩寬；平滑跟不跟得上動作調 `AdaptivePoseFilter` 的 `PREDICT_MS`，多人站太近骨架互相黏住調 `PersonTracker` 的 `ambiguityFloorRatio`（實測後可能還要繼續調整，目前 0.4）。ID 只是槽位編號的顯示提示，不做身分鎖定／認回：槽位釋放後下一個偵測到的人直接取用空槽位，不使用服裝顏色判斷身分。
- **現場人數**沒選之前不推論；人數同時是 `numPoses` 與追蹤槽位數，改人數等於重置 ID，且隨時可改（播放中也一樣，不需要先暫停）。Pose landmarker 是**單一實例、完全懶惰載入**：開頁不預建任何一份，第一次選人數（或選到還沒建過的人數）才建置，通常要等 1~2 秒；等待期間 `vision.js` 用舊的那份（若有）繼續正常推論，畫面不會凍結。切換成功不顯示任何提示（下拉不鎖，靠防抖＋單飛擋快速連續切換，成功後 `src/ui.js` 只留一行 `console.log` 方便除錯）；只有失敗才用 `#system-note` 顯示錯誤訊息。建好才換手、換手時立刻關掉舊的那份（`requestLandmarker()`），穩定狀態下只有一份 landmarker 活著。模型只用 `lite`，但 `full`／`heavy` 與 `setPoseModel()` 切換機制要保留。
- **MIDI 一律對規格**（SMF 1.0、MIDI 1.0、GM1／GM2）：velocity 1~127、pitch bend 14-bit、CC 編號、Bank Select；聲部名一律 GM 繁中音色名；分譜解析失敗不擋播放。
- **資源載入只用瀏覽器原生機制**（preload／modulepreload）：不加自訂下載器、不用 Service Worker、不加載入進度條。新增 `src/**/*.js` 模組要補一行 modulepreload。`fetchWithTimeout` 只管標頭不管 body。
- **第三方套件**：直接從 CDN（jsDelivr）匯入，版本號寫死在匯入的網址常數裡；不寫本地副本、不用 import map；不用 Git LFS（Pages 不解 pointer）。
- **效能**：骨架用 `Path2D` 批次。追蹤層不做服裝顏色採樣，每幀沒有額外的 `getImageData` 呼叫。
- **防呆**：曲庫 API 回傳的每一筆都當成可能是壞的；清單用 `<template>`＋`textContent`，沒有 `innerHTML`；`synth.js` 的 `initEngine()` 失敗要讓使用者看得到，且失敗時關掉 `AudioContext`。
- **console 只在真的出問題時輸出**（`warn`／`error`）：正常運作（開機成功、攝影機取得的實際解析度⋯）不寫確認性 log；「現場人數」切換成功是唯一的例外，留一行 `console.log` 方便除錯（見上「現場人數」）。
- **不加格式化工具**（Prettier／Biome 等）、不做全面重排；照同一個檔案既有的風格寫。
- **git**：等使用者說「commit」才提交（開分支 → `--ff-only` 合回 `main` → 刪分支）；**不 push**，等使用者之後明確要求才 push。
