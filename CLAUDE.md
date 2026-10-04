# CLAUDE.md

本檔為 Claude Code 在此 repository 中工作時的指引，**只寫「現在的 code 怎麼運作」與規則**。需求會一直變動：每次改變就直接改本檔、刪掉過時的段落，不累積歷史、不留「先前版本怎樣」。程式碼註解同樣只留「現在做什麼／為何這樣寫」。

## 專案簡介

HarmonyFlow 是瀏覽器端的 MIDI 演奏應用：攝影機 → MediaPipe 姿勢追蹤（最多 4 人、身分鎖定）＋拋物線手勢偵測，以及電腦鍵盤，都是「觸發」的來源（目前只接鍵盤，見下「觸發來源」）；**一次觸發＝放行整份總譜的下一個 segment（同一個 tick 上所有聲部、所有譜表的音），你的聲部與電腦輔助的聲部在觸發當下的同一次呼叫內一起立刻發聲**（0ms，不等計時器），上下對齊由結構保證，任何按鍵速度都不會跳過任何一顆音。整份總譜只有一條以 MIDI tick 為單位的時間軸；指派（把哪些聲部交給哪位演奏者）只決定哪些聲部走真人合成器（音量凸顯）、哪些演奏者有資格觸發，一個演奏者可以被指派多個聲部（左右手）。沒被指派的聲部是「電腦輔助的聲部」，跟你的聲部在同一個 segment 一起發聲。播放頭在兩次觸發之間以 `playbackRate`（依你的按鍵間隔估）前進、最多走到下一個 segment 就停格，只管收音與進度、永遠不會自己放出起音；音長照樂譜、隨 playbackRate 縮放。沒有自動代打：你停手＝播放頭停格（停太久還在響的音收掉，要停請按 ❚❚）。沒有任何人被指派時整首照時間連續自動播放。另有「試聽」鈕（♪）：用官方 SpessaSynth Sequencer 播同一份 MIDI（不經過我們的 parser），拿來跟演奏對照聽感，跟演奏互斥。純原生 JavaScript（ES module）、沒有 build step、沒有後端；介面文字與程式碼註解一律繁體中文。

- **觸發來源目前是電腦鍵盤，揮手暫時關閉**：為了給 parser／排程器一個確定、可重複的標準輸入，`src/keyboard.js` 把鍵盤四排字元鍵（用 `event.code`：`` ` `` 1~0 - =、Q~P [ ] \、A~L ; '、Z~M , . /）的任何一個當作**演奏者 1** 的一次觸發：`keydown` 事件裡同步呼叫 `midiPlayer.triggerSlot(1)`（→ `scheduler.trigger(1, performance.now())`），沒有計數器、沒有計時器，音在這次呼叫內就送進合成器。`main.js` 不再把 `vision.js` 的手勢接進播放器（攝影機、骨架、現場人數照常，現場人數仍決定分譜下拉列幾位演奏者，要先選人數、把聲部指派給演奏者 1；一個人可以被指派多個聲部；任何有指派聲部的演奏者按一下都推進全曲）。防呆：按住不放的自動重複（`event.repeat`）、帶 Ctrl／Alt／Meta 的組合鍵、焦點在文字輸入欄（搜尋欄）都不觸發；焦點在下拉（選歌、分譜指派）時 `preventDefault()` 擋掉瀏覽器的 type-ahead（不然字母鍵會跳選項、選歌下拉一跳就換歌）。不含 Space／Enter／Tab（焦點在按鈕上時會按下播放列的按鈕或移動焦點）。手勢接回時由 `main.js` 在觸發序號變動時呼叫 `triggerSlot(slot)`（見「手勢輸出目前沒有接收者」）。

- **版面**：`#app-shell` 置中一個鎖 16:9 的固定比例方框 `#camera-frame`（視窗裝得下的最大 16:9 矩形），攝影機畫面在框內；攝影機畫面永久蓋著黑幕（`#stage-blackout`，純 CSS，沒有任何切換方式，`#webcam` 也永久隱藏），非 16:9 螢幕的黑邊就是 body 的 `#000` 底色。頂端置中疊一欄 `#top-center-stack`（`position:fixed`，在框外，不受 `#camera-frame` 的 `overflow:hidden` 裁切）：播放 pill（`#toolbar-playback`，四顆獨立按鈕 ▶ 播放／❚❚ 暫停／↻ 重播／♪ 試聽（`#btnPlay`／`#btnPause`／`#btnReplay`／`#btnPreview`，包在 `#transport-group`，狀態見下方「播放只由頂端播放列的按鈕觸發」；icon 是 inline SVG、重心對齊按鈕中心，不用字型字元，滑鼠移上去用純 CSS 把 `aria-label` 當提示顯示）＋完整顯示的歌名，`max-width` 直接沿用 `#camera-frame` 的寬度公式、最寬不超過攝影機外框）在上，系統控制／選歌控制列（`.control-row` 底下的 `panel-system`／`panel-song`，純文字按鈕、無 icon）在下——兩者垂直分層、水平都置中，結構上不會互相遮蔽，不需要用任何寬度計算去避免碰撞；兩者各自獨立淡化、互不牽動，純 CSS `:hover`／`:has()`（沒有 JS 計時器）：碰到就顯示、沒碰到立刻淡化；控制列小面板開著時控制列自己強制顯示。還沒有能播放的歌曲之前（播放 pill 帶 `is-empty`：idle／載入中）控制列常駐不淡出——這時候它是唯一的操作入口；選好歌之後控制列回到 hover 才顯示的淡出邏輯，換成播放 pill 常駐不淡出，把畫面重心讓給攝影機與正在播放的資訊，兩條規則共用同一個「有沒有歌可播」判斷、條件互斥。`panel-system`（攝影機開關／現場人數／重置骨架 ID）是常駐區塊，一進頁面就看得到、沒有開合狀態；`panel-song`（選歌＋分譜指派）是觸發鈕＋彈出小面板，彈出面板釘在整排控制列的左下角展開（不是自己觸發鈕下方）。面板內容變多隻會往下撐到 `max-height` 再交給內部捲動——觸發鈕與✕的位置永遠不變，不會因為內容量被推移。這幾個浮動元件都以 `--ui-fs` 為基準字級、內部尺寸一律 `em`；`--ui-fs` 由 `src/ui.js` 的 `applyUiFontSize()` 綁視窗實際像素並除掉瀏覽器縮放倍率（Ctrl +/− 時 UI 視覺大小不變）。歌名優先單行顯示，超長時用 `--song-title-scale` 縮小字級撐住，縮到下限還放不下才退回換行（`src/midi/midiPlayer.js` 的 `fitSongTitle()`）。`#app-shell` 頂端貼邊另有一條獨立的 `#topProgressBar`（跨滿 `#camera-frame` 寬度、不顯示時間文字、純 CSS 對齊不用 JS 量測）：唯讀播放進度，顯示的是 tick 播放頭（`scheduler.getPositionTicks()`，用 `score.midiTicksToSeconds()` 換算成原譜秒數）佔總長的比例：兩次觸發之間依 playbackRate 連續前進、停格時停住，每放行一個 segment 就跳到它的 tick，不做補間動畫；第一次出現後就不會再因為換歌而重新收起（換歌時的空窗期維持停在舊值，不是補間，只是還沒有新的比例可以跳過去）；試聽中（♪）改成官方 Sequencer 的 `currentTime／duration`。**不能拖曳／seek**：沒有 seek 功能，要回到開頭用播放列的 ↻ 重播。
- **姿勢偵測不是開頁就跑**：系統控制的「現場人數」沒有預設值，選了 N 之後 MediaPipe 的 `numPoses` 與追蹤槽位數（＝ ID 上限）都設成 N。同一組控制有「攝影機開關」（關閉時串流真的停掉；被拔除／被搶走也視為已關閉，按一下重連）與「重置骨架 ID」，都只能點按鈕觸發——控制項沒有任何鍵盤快捷鍵，所有互動一律靠畫面上的按鈕；唯一的鍵盤輸入是演奏觸發鍵（見上「觸發來源」）。
- **選歌＝載入**：本地上傳或雲端曲庫選取後立刻解析、列出每個聲部一個「指派演奏者」下拉（無／演奏者 1~N），不啟動播放。播放靠 `src/midi/scheduler.js` 的排程器（單位是 tick，以 staff 為單位發聲）：`parseMidi()` 把全曲所有音依 `startTick` 分成 **segment**（`parsed.segments`：同一個 tick 上所有聲部、所有譜表的音，借自 MuseScore 的 Segment），排程器把每個 segment 配上各自的 staff（沒有輸出 channel 的 staff 的音被丟掉，整個 segment 丟光就不收）。`trigger(slot, nowMs)` 放行全曲的下一個 segment：裡面所有音（指派聲部走 `synthHuman`、其餘走 `synth`）在這次呼叫內立刻 noteOn（velocity 用樂譜原值），而且先收掉 `endTick ≤ 這個 segment 的 tick` 的音再開新音（相連的舊音在後繼音發聲的同一刻已經關掉）；暫停中、試聽中、還沒載入、槽位沒有指派聲部（含整首自動播放）、segment 放行完時 `trigger()` 都回傳 false、不發聲。**播放頭**（`_ticks`，單位 tick，可為小數）在兩次觸發之間以 `playbackRate` 前進（tick → 秒 → 加 dt × 速度 → tick：速度表在 tick 與秒之間是分段線性，所以用 `midiTicksToSeconds()`／反函數 `secondsToMIDITicks()`），最多走到下一個 segment 的 tick 就停格；它只負責收音（音的 `endTick ≤ 播放頭` 才收，同音高重疊先進先出）與進度，永遠不會自己放出起音；還沒有人觸發過時不推進（進度停在 0）。`playbackRate`（命名同官方 Sequencer：樂譜秒 ÷ 真實秒）取自最近兩次觸發的間隔，夾在 [0.25, 4]，第一次觸發前為 1；你停手超過閒置門檻之後再按的那一段、暫停那段時間都不拿來估速度。沒有任何人被指派（或指派的聲部都沒有音符）時整首自動播放：播放頭以 1× 前進，走到的 segment 自動放行（見 N1、N2）。由 `src/vision/gesture.js` 的 `ArcDetector` 偵測手腕＋手掌合併點「先下沉再回升」的形狀（兩軸判斷、不依賴肩膀高度、開口大小方向都不限，純粹是離散的「有效觸發」訊號，不輸出音量），且每個追蹤槽位會自動鎖定先做出有效拋物線的那隻手，之後只認那隻手，避免另一隻閒置手在畫面上飄移湊出假觸發（目前沒有接進播放器）。note-on 一律用樂譜原始 velocity，不套用手勢公式；不做任何音色覆蓋，一律沿用聲部原始 MIDI 音色；不重播 CC／pitch-bend，每個 staff 的初始狀態（bank／program 與混音 CC7／10／91／93）只在載入時套用一次（刻意的簡化）。
- **相連音撐住與停格釋放**（所有 staff，只在有指派、手動觸發時）：播放頭停在下一個 segment 等你。MIDI 編碼裡「結尾到同一個譜表下一顆起音的間隙 ≤ θ」（見 N4）的相連音，在它的後繼音還沒放行時不收，後繼音一放行就在你按下的那一刻先關再開——這不是延音效果，只是不在「播放頭停格等你」那一下提早出現檔案裡沒有的空白；其餘一律照檔案收音。播放頭停格超過閒置門檻（`IDLE_MS`＝800ms，見 N5）就把所有還在響的音收掉，長音、相連音都不會無限期響著。你完全停手＝播放頭停在下一個 segment、800ms 後安靜下來；要接著演奏就繼續按，要重來按 ↻。整首自動播放不撐相連音，每個 noteOff 都照檔案。
- **曲末**：所有 segment 都放行完之後播放頭不再受限（以 playbackRate 繼續走、進度夾在總長以內），尾音照時值收完；`isFinished()` 要 segment 放行完而且沒有任何音在響才為 true；有指派聲部但還完全沒有人觸發過時不算播完（還在等你開始）。
- **指派與觸發**：指派本身是持久設定，不隨追蹤雜訊變動，也不看你在不在鏡頭裡。任何有指派聲部的演奏者按一下，都推進同一條全曲 segment 序列（共用指揮）；多位演奏者怎麼分工（例如一個 segment 只認那個 tick 有起音的演奏者）等手勢接回時再定，是已知待決事項。沒有「從未被觸發的演奏者靜音」這種規則：全曲由觸發推進，指派聲部一律在真人軌發聲。
- **聲部（part／staff）**：`parseMidi()` 把一個 MuseScore 樂器切成一個 part（可指派的單位，畫面上分譜清單的一列），part 底下有一個以上的 staff（一個譜表 × 一個樂器 channel，對應 MuseScore 的 Part → Staff：鋼琴兩行譜是兩個 staff，弓弦的 pizzicato channel 有音時同一行譜拆成另一個 staff 單位；發聲與輸出 channel 以 staff 為單位，指派以 part 為單位）。MuseScore 匯出時一個樂器的所有譜表共用同一個 MIDI channel、用 track 區分（不是用 tick 區分），所以左右手常在同一個 tick 起音、落在同一個 segment。這個 staff 不是 MuseScore 的 voice（同一行譜裡的聲部 1～4）：那個資訊匯出成 MIDI 後不在檔案裡。切分規則只有一條（沒有「是不是 MuseScore 檔」的分支）：MuseScore 一個譜表一條 track，只有樂器最上行譜的 track 在 tick 0 對樂器的每個 channel 寫初始化區塊（CC121、Program Change、CC7／10／91／93），所以依軌序掃描，一條 track 併入「目前這一組」當且僅當它沒有初始化區塊、軌名跟首軌相同（任一方為空也算相同）、音符 channel 全在這組已知的 channel 內；沒有音符的 track（Meta 軌、空軌）不成聲部。聲部名一律 GM 繁中音色名（取主 staff——音符最多者——的 program，打擊用鼓組名；不採信檔案的軌名／樂器名，不放高低音譜／旋律伴奏等推導出來的描述），同名依總譜順序加序號。每個 staff 的初始狀態（program、bank、混音 CC7／10／91／93）取自首軌 tick 0 的初始化區塊（下行譜沿用首軌對同一個 channel 的），沒有就用時間軸查詢的 program 與 GM 預設；音符的 channel 是絕對 channel（軌內 channel 加上 port 偏移，依 port 第一次出現的順序 +16，跟官方 SpessaSynth 一致）。 解析結果另有 `segments`（全曲的垂直切片，見「選歌＝載入」）。命名模仿官方 SpessaSynth／MuseScore：`timeDivision`（每四分音符 tick 數，SMPTE 時為 null；`division` 物件保留原始資料）、`midiTicksToSeconds()`／`secondsToMIDITicks()`、事件與速度表的 `ticks`、音符的 `midiNote`；`tempoMap` 與 `startTick`／`endTick` 維持原名（SpessaSynth 的 `tempoChanges` 是由後往前排序、欄位也不同，同名反而誤導）。

## 開發／執行

app 執行不需要任何本機安裝，clone 下來直接用 Live Server 開就能跑；沒有 Node 工具鏈、沒有 build step、沒有 CI。

- **VS Code Live Server**：用 VS Code 開啟專案根目錄當工作區，「Go Live」→ `http://127.0.0.1:5500/`（`.vscode/settings.json` 已設 port 與忽略清單）。ES module 與 `getUserMedia` 需要 `http(s)://`，不能用 `file://`；換其他靜態伺服器要對 `.wasm` 回 `application/wasm`。部署＝把資料夾原樣 serve 出去，本地跑起來看到的就是部署後的樣子。
- **第三方套件**：`@mediapipe/tasks-vision`（`src/vision/vision.js`）、`spessasynth_lib`（`src/midi/synth.js`）都直接寫死完整 jsDelivr CDN 網址匯入，沒有 import map、沒有本地副本，執行期需要網路。兩個套件都綁 `@latest`，不手動維護版本號，代價是 jsDelivr 對 `@latest` 有快取（瀏覽器端 7 天／邊緣節點 12 小時），版本可能在快取到期後無預警改變、且不同使用者吃到新版的時間點不一致；`spessasynth_lib` 對 `spessasynth_core`（core 對 `stb-vorbis`）宣告的相依版本本來就是 `latest`，管不到那一層，現在外層也主動浮動，兩層都是刻意選擇。
- 沒有格式化工具；寫新程式照同一個檔案既有的風格。修改後在瀏覽器開頁面檢查 console 與攝影機輸出。
- **自動化測試**：細節見 `test/CLAUDE.md`（處理 `test/` 底下的檔案時才載入）。跑法：先 `npm install`，`node test/browser/smoke-test.mjs`（瀏覽器）與 `node test/unit/*.test.mjs`（純 Node，各檔各自執行）。
- 只有一個進入點：`index.html` → `src/main.js`。

## 部署狀態（會變動，動手前用 `gh api repos/Paul98239/HarmonyFlow` 與 `git ls-remote` 重查）

- 專案結構照 Pages 設計（`.nojekyll`、資源全走相對路徑），不要因為改動就破壞這點。Pages 會把整個 branch 原樣 serve 出去，`index.html` 真正用到的是 `src/`（ES module、`styles.css`、`assets/` 的模型＋soundfont）；第三方套件直接連 CDN，不進 git。
- **push／部署**：等使用者明確要求才 push（`commit` 這個字只代表本機提交，不含 push）；之後每次要推新版上線，直接 `git push origin main` 即可，Pages 會自動重新 build。

## 架構（index.html → src/main.js）

`index.html` 是 HTML-first：全部靜態 UI markup 都在這裡（含唯一的 `<template id="tpl-part-row">`），JS 不產生 markup。
`main.js` 是 composition root：`midiPlayer.startPlayer()` 起播放器的兩個 tick → `initUi(midiPlayer)` 掛畫面（同步；`ui.js` 不 import
播放器，由這裡交進去）→ `setPoseCountListener(midiPlayer.setPlayerCount)` → `await Promise.all([startVision({ onStatus, onError }),
midiPlayer.warmUpMidiEngine()])` 並行推進視覺與音源兩條軌道 → `startKeyboardTrigger(midiPlayer.triggerSlot)`
接鍵盤觸發（`vision.js` 的 `setPerformanceStateListener` 目前不接，手勢暫時關閉）→ 兩邊都好才 `dismissLoading()`（淡出載入畫面、解除 `#app-shell` 的 `inert`）。功能之間不互相 import，vision → 播放器的
人數資料流與鍵盤 → 播放器的觸發資料流都由 `main.js` 接。

**單向資料流**：使用者操作 → `#top-center-stack` 上的三個委派監聽（click／change／input，依 `data-action`／`data-field` 分派給
各區塊的 `actions`／`fields`／`inputs`）→ 動作函式改 store（`ui.js` 的 `Store extends EventTarget`；兩個實例：`ui.js` 的 `uiStore`
與 `midi/midiPlayer.js` 的 `playerStore`）或呼叫 vision API → store 的 `'change'`（microtask 合併）→ `scheduleRender()` → 各區塊的
`render(snapshot)` 只在值不同時寫 DOM。DOM 不是真相：播放中看 `player.transport`、面板開著看 `ui.openPanel`、分譜看
`player.parts`／`player.assignments`、人數看 `getPoseCount()`。區塊模組統一形狀 `{ actions?, fields?, inputs?, mount?, render? }`
（`ui.js` 內有系統控制列與面板開合兩個，`midi/midiPlayer.js` 檔尾把四段畫面合成一個）。

| 檔案 | 職責 | 純邏輯（無 DOM） |
|---|---|---|
| `src/main.js` | 啟動、接線 | — |
| `src/keyboard.js` | 鍵盤觸發（四排字元鍵＝演奏者 1 的一次觸發，keydown 內同步呼叫 `onTrigger(slot)`；防呆見「觸發來源」） | — |
| `src/ui.js` | `Store`＋`rafThrottle`、`uiStore`、載入／錯誤遮罩＋`inert`、`--ui-fs`／`--popup-max-height`、系統控制列、面板開合、事件代理、render 排程、`initUi(player)` | — |
| `src/styles.css` | 唯一的樣式來源（`@layer base, ui, states`） | — |
| `src/vision/vision.js` | 攝影機狀態機、WebGL、MediaPipe、繪製、手勢接線、舞台提示、`setPoseCountListener` | — |
| `src/vision/tracking.js` | `PersonTracker`（槽位配對，純依位置）、`AdaptivePoseFilter`、`buildDetection` | ✓ |
| `src/vision/gesture.js` | `ArcDetector`（拋物線手勢 → 離散的有效觸發訊號）、`clamp01` | ✓ |
| `src/midi/synth.js` | spessasynth 合成器：兩個合成器（電腦輔助聲部 `synth`／真人聲部 `synthHuman`）、humanGain 閘門＋音量凸顯；演奏不用 Sequencer，直接接收 `scheduler.js` 送來的個別 note 事件；試聽才用官方 `Sequencer`（`startPreview()` 等，走 `synth`）；`flushPreviousSong()` 是演奏與試聽共用的清場；兩個合成器模仿官方 Sequencer 依需要補 port（每個 port 16 個 channel，只增不減）：開機補到 `DEFAULT_PORTS`（4 個 port＝64 個 channel），歌曲需要更多時 `load()` 依 `portsNeeded()`（旋律 staff 每個 port 15 個、每種鼓組佔一個 port 的打擊槽）補；每次補完都要 `reset()` 一次——動態新增的 channel 預設是打擊 channel（worklet 回讀實測），不重設的話旋律聲部超過 15 個的歌，channel 16 以上會用鼓組發聲；channel 數只能自己計數（lib 的 `addNewChannel()` 會讓 `midiChannels.length` 雙重 push），常數 `CHANNELS_PER_PORT`／`DEFAULT_PORTS` 的單一來源是 `scheduler.js` | ✓ |
| `src/midi/previewPlayer.js` | 試聽：官方 Sequencer 的薄包裝（Sequencer 由 `synth.js` 注入）——等非同步載入結果（同名 songChange／midiError／逾時／被中斷）、暫停／續播／從頭／停止、`loopCount` 關循環 | ✓ |
| `src/midi/midiPlayer.js` | 播放器：`playerStore`、選歌／播放／試聽／指派／人數動作、觸發入口 `triggerSlot()`、兩個 tick ＋ 四段畫面（pill／頂端進度條／曲庫／選檔與分譜） | — |
| `src/midi/midiApi.js` | 遠端 MIDI 曲庫 client（分類／搜尋／下載），純資料 | ✓ |
| `src/midi/midiParser.js` | SMF 解析／重新編碼、GM 繁中命名、聲部切分（part／staff，見「聲部」）、`segments`（全曲垂直切片）、`midiTicksToSeconds()`／`secondsToMIDITicks()`（tick ↔ 秒，分段線性）、`buildMeasureGrid()`／`buildBeatGrid()` 小節與拍格線 | ✓ |
| `src/midi/scheduler.js` | 排程器（單位 tick；以 staff 為單位：parser 的 part 底下一個以上的 staff，指派以 part 為單位、發聲與輸出 channel 以 staff 為單位；打擊 staff 依鼓組 program 分到每個 port 的 channel 9（預設 4 個 port＝9／25／41／57）；每個 staff 載入時送 bank／program 與 CC7／10／91／93）：全曲 segment 序列與游標、`trigger()` 放行下一個 segment 並在呼叫內立刻發聲（先收再放）、tick 播放頭與 `playbackRate`、先進先出收音、相連音撐住與閒置收音、整首自動播放（沒有指派時）、重設／重播、`getPositionTicks()` | ✓ |

## 拍子從哪裡來：規格 vs 假設

SMF 規格保證的是「格線」：`division`／`FF 51`（速度）／`FF 58`（拍號，含 `nn dd cc bb` 四個
位元組）這幾樣資料就能把任何一個 tick 精確換算成第幾拍第幾秒——`FF 58` 的 `cc`（節拍器每響
一次隔幾個 MIDI clock）其實是規格明訂的律動拍長、`bb`（一個 MIDI 四分音符等於幾個記譜
三十二分音符）決定記譜拍長，兩者都是確定性計算，`buildMeasureGrid()`／`buildBeatGrid()`
現在照這兩個欄位算，不是只靠拍號分母去猜。格線上規格真的沒有寫的「音樂意義」（小節線本身、
弱起、強弱、swing）仍然只能由應用層推導，而推導必然帶假設——任何宣稱「從 MIDI 讀出拍子」
的功能都要清楚寫出用了哪些假設，不能包裝成規格事實。目前成立的假設列在這裡，之後哪條被實作掉
就直接從清單移走。排程器（總譜觸發）目前不用拍格線，只看 `startTick`（segment）；`buildMeasureGrid()`／`buildBeatGrid()` 仍由 parser 提供、有測試，A 開頭的假設描述的是它們：

| # | 假設 |
|---|---|
| A1 | 弱起拍（anacrusis）不處理，格線一律從 tick 0 起算 |
| A4 | 拍號變更處強制斷一條小節線，該段最後一小節可能不完整；全曲最後一小節不截短 |
| A5 | SMPTE division 沒有拍格線，`buildMeasureGrid()` 回空陣列；排程器不用拍格線；SMPTE 的 tick 仍可換算成秒（直接乘 `ticksPerSecond`），逐 segment 放行照常運作，只是 `timeDivision` 是 null 而不判相連音（見 N4） |
| A7 | 強弱與 swing 完全不推導，每一拍等長、無輕重之分 |
| A8 | part／staff 的 id 不含 program、bank，也不依 port 數值區分：staff id ＝ `t<軌序號>c<絕對 channel>`；`FF21`（port）這個欄位其實不在 RP-001 正式定義的 meta event 清單裡，是業界常見但未被正式標準化的慣例欄位（RP-019 定義的是 `FF09` Device Name，並把它描述成「取代 cable number（即 `FF21`）的更好做法」，隱含同一軌對應一個裝置的假設，但這是慣例推論、不是 RP-019 對 `FF21` 本身的規定）。整條 track 用軌內最後一個 `FF21` 算絕對 channel（跟官方 SpessaSynth 一致），中途切換 port 違反上述慣例，`parseTrack()` 會偵測並警告這種檔案 |
| A9 | staff 的 program 只看 tick 0（首軌初始化區塊裡的 Program Change），沒有初始化區塊時才用時間軸查詢（自己軌優先、再查全曲同一個絕對 channel、預設 0）；之後 tick>0 的 Program Change 被忽略（曲庫 166 首裡 0 首有）。Bank Select 要等 Program Change 才生效（GM2 §3.3.1），staff 的 bank 取初始化區塊的值、沒有就取第一顆音之前最後一次送的、都沒有用 GM2 規格預設（第 10 個 channel 為節奏 bank 120，其餘為旋律 bank 121） |
| A14 | 同一條 track 內的多個 channel 視為同一個樂器的音色層（歸在同一個 part 的不同 staff）：format 0 的多樂器 GM 檔不會被拆成多個 part（曲庫目前沒有） |
| A15 | 軌名只用來判斷「下行譜併入上一組」（相同或任一方為空），不用來命名；CC64 踏板、CC2 動態、CC1、RPN、pitch bend 都不處理（曲庫 8 首用到 CC64，影響鋼琴延音聽感） |
| A13 | `buildMeasureGrid()` 的律動拍長優先採用 `cc` 換算，但 `cc = 24`（MIDI 的內建預設值，多數編曲軟體不論拍號一律照抄）一律視為「檔案沒有表態」而退回拍號分母音符——複拍子（如 6/8）若真的把 `cc` 寫成 24，仍會切成分母音符的拍數，不是實際律動單位 |
| N1 | 一次觸發＝放行全曲的下一個 segment（`startTick` 相同的所有音，跨聲部、跨譜表），不管有幾顆音、有沒有拍、有沒有休止、是誰的音；segment 裡的音在 `trigger()` 這次呼叫內發聲。你的聲部休止時也要按（按鍵推進的是整份總譜，不是你的聲部），代價是按鍵數＝全曲 segment 數（曲庫 166 首實測：每首中位 199 個、最多 4924 個；原速平均每秒要按中位 2.1 下、最大 6.3 下；最忙的 1 秒中位 5 下、最多 29 下，`test/tools/library-scan.mjs` 的 `parse` 會印）。好處：上下對齊由結構保證，任何速度都不跳音、不需要補延音 |
| N2 | 播放頭速度 `playbackRate`＝你最近兩次觸發的「樂譜秒 ÷ 真實秒」，夾在 [0.25, 4]（`MIN_PLAYBACK_RATE`／`MAX_PLAYBACK_RATE`）；只用最近一個間隔、沒有平滑，按鍵時間抖動會讓音長（真實時間）跟著抖（可優化：指數移動平均）。它只影響收音與進度，不影響起音，所以估不準不會造成上下錯位。整首自動播放固定 1× |
| N3 | 音長：音的 `endTick ≤ 播放頭` 才收，所以你按快，音長（真實時間）照比例變短；你按慢，音照檔案收、播放頭停格等你。不看 keyup。同音高重疊依先進先出收音，所以同音高的音被你按得太近時，較短的音會被前一顆較長的音拖住到它收音 |
| N4 | 相連音的「小間隙」門檻 θ ＝ `timeDivision` ÷ `LEGATO_GAP_DIVISOR`（16；480 tpq 時 30 tick）：音符結尾到同一個譜表下一個起音點的間隙 ≤ θ 才算相連音，播放頭停格時它會撐到後繼音放行（見「相連音撐住與停格釋放」；整首自動播放不撐）。MuseScore 把相連音符寫成「記譜長度 − 1 tick」（間隙固定 1 tick），真正的最短休止（三十二分休止）≥ 60 tick，θ 落在兩者中間的空檔（曲庫實測 83% 的間隙 ≤ 30 tick）。這是應用層數字，不是規格；用 tick 不用秒，跟速度無關；SMPTE division 沒有 tick 換算，不撐 |
| N5 | 播放頭的停格與步長：播放頭單調不減、最多走到下一個 segment 的 tick 就停格；停格超過 `IDLE_MS`（800ms）就把所有還在響的音全部收掉；每個 tick 的時間步長上限 `MAX_TICK_DT_SEC`（0.1 秒），分頁被節流後恢復時不會一次收掉或放出一大段。都是應用層數字，不是規格 |

播放頭只服務收音與進度：兩次觸發之間以 `playbackRate` 前進（`midiTicksToSeconds()`／`secondsToMIDITicks()` 做 tick ↔ 秒），最多走到下一個 segment 的 tick；起音永遠來自 `trigger()`（整首自動播放除外）。

已知且刻意保留的行為／待決：沒有自動代打，你停手播放頭就停在下一個 segment；同音高重疊依先進先出收音（N3）；多位演奏者目前共用同一條 segment 序列（任何人按一下都推進），分工方式等手勢接回時再定；`playbackRate` 沒有平滑（N2）；排程 tick 是主執行緒的 12ms `setInterval`，只管播放頭推進與到期收音，抖動會讓收音晚幾十 ms（本機無頭軟體算繪實測：鏡頭開著 tick 平均約 28～30ms，鏡頭關閉 12.0ms，抖動主因是影像算繪，見 `test/tools/jitter-measure.mjs`）；**起音在 `trigger()` 內送進合成器，不經過 tick**，但音訊本身仍有 worklet 的一個 render quantum 與瀏覽器輸出延遲（spessasynth_lib 的 noteOn／noteOff／controllerChange／programChange 接受 `eventOptions.time`——AudioContext 時間，worklet 內依時間排隊，精度是一個 128 取樣的 render quantum——但排程器目前沒用：它沒有取消已排程事件的 API）。

## 慣例與禁止事項

- **語言**：介面文字與程式碼註解一律繁體中文。
- **樣式**：JS 不寫 `element.style` 或行內 `style`；顯示／隱藏切原生 `hidden` 屬性（`el.hidden = bool`），其他狀態切 `is-*` class，純呈現寫在 `src/styles.css`；明文例外只有三個連續量：`--ui-fs`、頂端歌名單行縮放用的 `--song-title-scale`、彈出面板高度上限 `--popup-max-height`。`styles.css` 用 `@layer base, ui, states` 三層，新規則一定要放進對應的層（沒包層的規則會贏過所有層）；`states` 層永遠贏，不用 `!important`。
- **HTML-first 與清單**：靜態 UI 一律寫在 `index.html`，JS 不用字串產生 markup、不用 `innerHTML`；重複結構用 `<template>`（目前只有分譜列 `tpl-part-row`）clone，文字用 `textContent`、下拉用 `new Option()`，聲部名等外部字串因此不需要跳脫。
- **事件與狀態**：控制項的行為經 `data-action`（click）／`data-field`（change／input）委派到 `#top-center-stack`，不逐元素 `addEventListener`；狀態放 `playerStore`／`uiStore`，畫面由 `render(snapshot)` 依狀態畫，DOM 不是真相；巢狀物件（Map、library）改動時換新參照。一次性動畫（重置鈕閃黃）例外，handler 直接切 class。
- **版面**：`#camera-frame` 鎖 16:9（F11 穩定性），不要改回滿版；不要用 `max-width/max-height:100% + aspect-ratio`（flex 裡會塌成 0 高）；攝影機容器不能用 JS 在執行期搬動（`vision.js` 模組頂層就抓 DOM）；開機期間擋互動靠 `#app-shell` 的 `inert`，不靠遮罩的 z-index；`#stage-hint` 必須 absolute。`--ui-fs` 必須由 JS 綁視窗實際像素並除掉縮放倍率（混 vw 或純固定 px 都不對）。
- **控制列小面板**（`panel-song`）只能用 ✕、再按觸發鈕關閉，**不做「點外部關閉」**；`panel-system` 是常駐區塊，沒有開合狀態。彈出面板釘在整排控制列左下角、向下展開（不是自己觸發鈕下方，開合狀態是 `uiStore.openPanel`）。控制列與頂端播放 pill 垂直疊在同一欄（`#top-center-stack`）、結構上不會互相遮蔽，不用算誰佔多少水平寬度；歌名完整顯示不截斷；`#midiStatusText` 只放歌名，不寫「解析中／下載中」。控制項沒有任何鍵盤快捷鍵（包含關閉面板）；唯一的鍵盤輸入是演奏觸發鍵。
- **播放只由頂端播放列的按鈕觸發**：▶ 播放（`#btnPlay`）、❚❚ 暫停（`#btnPause`）、↻ 重播（`#btnReplay`）、♪ 試聽（`#btnPreview`）四顆獨立按鈕。選歌＝載入（雲端曲庫選取即下載）、改指派都不觸發播放，下次按播放時靠簽章比對重新載入。四顆按鈕互相防呆：狀態由 `midiPlayer.js` 的 `transportButtonState()` 依 store 推導（灰＝`disabled`），`data-action` 進來時再對一次表（連按、程式呼叫都繞不過去）；載入／續播／重播／進入試聽處理中（`busy`）四顆立即全灰。store 的 `mode` 區分播放列現在作用在哪裡：`'perform'`＝演奏，`'preview'`＝試聽（▶ ❚❚ ↻ 作用在官方 Sequencer，♪ 恆黃底）；下表上半是演奏、下半是試聽。

  | 狀態 | ▶ 播放 | ❚❚ 暫停 | ↻ 重播 | ♪ 試聽 |
  |---|---|---|---|---|
  | 沒有歌（idle）／載入中 | 灰 | 灰 | 灰 | 灰 |
  | 演奏：已載入、還沒播過 | 可按 | 灰 | 灰（已經在開頭） | 可按（開始試聽） |
  | 演奏：播放中 | 灰 | 可按（accent 黃底 `is-current`） | 灰 | **灰**（要先暫停，免得打斷演奏） |
  | 演奏：暫停（播到一半） | 可按（續播） | 灰 | 可按 | 可按（會結束目前的演奏進度） |
  | 演奏：播完 | 可按（從頭播） | 灰 | 可按 | 可按 |
  | 試聽：載入中（`busy`） | 灰 | 灰 | 灰 | 灰 |
  | 試聽：播放中 | 灰 | 可按（黃底） | 灰 | 可按・黃底（結束試聽） |
  | 試聽：暫停 | 可按（續播） | 灰 | 可按 | 可按・黃底 |
  | 試聽：播完 | 可按（從頭播） | 灰 | 可按 | 可按・黃底 |

  **試聽**（`src/midi/previewPlayer.js` 包官方 SpessaSynth `Sequencer`，走電腦輔助那個合成器 `synth`）：位元組原樣交給官方解析、官方在 AudioWorklet 裡自己排程，不經過我們的 parser，所以我們的 parser 解析失敗時試聽仍可用，也能拿來對照聽感。♪ 載入完成就從第一個音（官方 `skipToFirstNoteOn`）開始播，`loopCount` 明確設成 0（官方預設會循環）；頂端進度條在試聽時改顯示官方的 `currentTime／duration`（同樣唯讀、不能拖曳）。**跟演奏互斥**（共用 `synth` 的 channel）：進入試聽＝結束目前演奏進度（`flushPreviousSong()`、`lastPlayedSignature` 清掉），離開試聽（再按 ♪）後演奏回到「已載入、還沒播過」，下次 ▶ 整個重新載入；官方 Sequencer 動過合成器的狀態，離開時 `flushPreviousSong()` 額外做一次完整 `synth.reset()`。突發狀況的處理（`midiPlayer.js` 的 `enterPreview()`／`leavePreview()`／`playPreview()`，`test/browser/smoke-test.mjs` 逐一測）：換歌／退回「請選擇歌曲」／重選同一首由 `beginSourceChange()` 停掉試聽（`flushPreviousSong()` 也中斷載入中的試聽），過期的非同步結果靠 `sourceLoadToken` 作廢；引擎壞了（按下才發現）頂端提示「音源引擎載入失敗」；官方解析器拒絕或沒有回應（對長度 0 的 MIDI 官方不回任何事件，所以有逾時）頂端提示「官方播放器無法解析這首 MIDI」並留下 `console.warn`，失敗都回到演奏「已載入、還沒播過」；試聽中改指派／人數不影響試聽、有觸發被忽略（排程器已停，`humanGain` 關著）；播完由 `uiTick` 偵測官方的 `isFinished`。

  ↻ 與播完後的 ▶ 共用 `scheduler._resetPlayback()`（跟 `stop()` 同一個重設函式）：播放頭、segment 游標、`playbackRate`、上一次觸發與「是否被觸發過」都退回剛載入的樣子，要重新觸發才會發聲。任何新增的排程器狀態欄位都要在 `_resetPlayback()` 重設（單元測試有整體快照比對，忘了會直接失敗）；若指派改過（簽章不同）則走完整重新載入。
- **指派持久**：下拉恆列「現場人數」個 ID，不隨鏡頭當下偵測到幾人增減；指派本身留著、不會被清掉，（見上「指派與觸發」）。
- **兩軌模型**：電腦輔助軌固定不動（不掛額外 gain，是音量對比的固定基準），跟你的聲部在同一個 segment 一起發聲；指派聲部固定走真人軌，velocity 一律用樂譜原值，不套用手勢公式；真人軌整體的 `humanGain` 開啟時刻意調到比電腦輔助軌大聲（`synth.js` 的 `HUMAN_EMPHASIS_GAIN`），凸顯使用者控制的聲部；不調 CC7（沒有代打音量）、不做任何音色覆蓋、不做持續的 CC11 表情覆蓋。
- **手勢輸出目前沒有接收者**：`vision.js` 仍逐幀算出 `{ arcTriggerSeqBySlot, presentSlots }`（心跳 `EMIT_HEARTBEAT_MS` 100ms），只是沒有人用 `setPerformanceStateListener` 註冊；接回手勢＝在 `main.js` 註冊一個回呼，各槽位的觸發序號變動時呼叫 `midiPlayer.triggerSlot(slot)`（接收端若要斷訊看門狗，門檻必須大於心跳間隔）。
- **追蹤層只貼標籤、不動畫面**：不刪、不合併、不替換 MediaPipe 這一幀給的偵測；位置門檻以肩寬為單位、緩衝以毫秒為單位；「同一具身體」只看肩膀中點 < 0.5 肩寬；平滑跟不跟得上動作調 `AdaptivePoseFilter` 的 `PREDICT_MS`，多人站太近骨架互相黏住調 `PersonTracker` 的 `ambiguityFloorRatio`（實測後可能還要繼續調整，目前 0.4）。ID 只是槽位編號的顯示提示，不做身分鎖定／認回：槽位釋放後下一個偵測到的人直接取用空槽位，不使用服裝顏色判斷身分。
- **現場人數**沒選之前不推論；人數同時是 `numPoses` 與追蹤槽位數，改人數等於重置 ID，且隨時可改（播放中也一樣，不需要先暫停）。Pose landmarker 是**單一實例、完全懶惰載入**：開頁不預建任何一份，第一次選人數（或選到還沒建過的人數）才建置，通常要等 1~2 秒；等待期間 `vision.js` 用舊的那份（若有）繼續正常推論，畫面不會凍結。切換成功不顯示任何提示（下拉不鎖，靠防抖＋單飛擋快速連續切換，成功後 `src/ui.js` 只留一行 `console.log` 方便除錯）；只有失敗才用 `#system-note` 顯示錯誤訊息。建好才換手、換手時立刻關掉舊的那份（`requestLandmarker()`），穩定狀態下只有一份 landmarker 活著。只有 `lite` 一種模型，沒有切換機制（`full`／`heavy` 模型檔與 `setPoseModel()` 已移除）。
- **MIDI 一律對規格**（SMF 1.0、MIDI 1.0、GM1／GM2）：velocity 1~127、pitch bend 14-bit、CC 編號、Bank Select；聲部名一律 GM 繁中音色名（見「聲部」）；分譜解析失敗不擋播放。
- **資源載入只用瀏覽器原生機制**（preload／modulepreload）：不加自訂下載器、不用 Service Worker、不加載入進度條。新增 `src/**/*.js` 模組要補一行 modulepreload。`fetchWithTimeout` 只管標頭不管 body。
- **第三方套件**：直接從 CDN（jsDelivr）匯入，版本號寫死在匯入的網址常數裡；不寫本地副本、不用 import map；不用 Git LFS（Pages 不解 pointer）。
- **效能**：骨架用 `Path2D` 批次。追蹤層不做服裝顏色採樣，每幀沒有額外的 `getImageData` 呼叫。
- **防呆**：曲庫 API 回傳的每一筆都當成可能是壞的；清單用 `<template>`＋`textContent`，沒有 `innerHTML`；`synth.js` 的 `initEngine()` 失敗要讓使用者看得到，且失敗時關掉 `AudioContext`。
- **console 只在真的出問題時輸出**（`warn`／`error`）：正常運作（開機成功、攝影機取得的實際解析度⋯）不寫確認性 log；兩個例外各留一行 `console.log` 方便除錯：「現場人數」切換成功（見上「現場人數」），與雲端曲庫下載前的連結（`midiApi.js` 的 `downloadMidiFile()`：`[雲端下載] ID: … | URL: …`，下載失敗時也先有這一行，方便拿連結追查）。
- **不加格式化工具**（Prettier／Biome 等）、不做全面重排；照同一個檔案既有的風格寫。
- **git**：等使用者說「commit」才提交（開分支 → `--ff-only` 合回 `main` → 刪分支）；**不 push**，等使用者之後明確要求才 push。
