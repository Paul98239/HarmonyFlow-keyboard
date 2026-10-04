# CLAUDE.md

本檔為 Claude Code 在此 repository 中工作時的指引，**只寫「現在的 code 怎麼運作」與規則**。需求會一直變動：每次改變就直接改本檔、刪掉過時的段落，不累積歷史、不留「先前版本怎樣」。程式碼註解同樣只留「現在做什麼／為何這樣寫」。

## 專案簡介

HarmonyFlow 是瀏覽器端的 MIDI 演奏應用：攝影機 → MediaPipe 姿勢追蹤（最多 4 人、身分鎖定）→ 拋物線手勢每揮一次就放行下一拍（一次有效手勢＝共用拍位固定前進一拍，不論這拍本身有沒有音符）；整個合奏——你控制的聲部與電腦輔助的聲部——共用一個樂譜時鐘，照這個時鐘發聲，彼此不會不同步；時鐘的速度跟著你的揮手間隔走，揮得比原譜快或慢，所有聲部一起跟著。一個聲部只要曾經被你真實觸發過一次，之後你沒揮、該揮的時間到了（預期的揮手時間再寬限 0.15 拍），電腦就替你放行那一拍——連有你音符的拍也照譜播出（音量調低區分人／電腦），你一揮手（晚到的算對那一拍的回應，見 N3）就換回真人；你完全停手＝音樂自己照估計速度播到曲末（要停請按 ❚❚）；從未被你觸發過的聲部維持靜音，不會自動代打。其餘聲部固定由「電腦輔助的聲部」播放。相連的音在時鐘停格等你揮手時（只有第一下揮手之前）撐住、不留原譜沒有的空白（停太久就收掉），其餘一律照檔案收音；所有指派聲部的音都放行完，曲子自動收尾，不需要多揮一下。另有「試聽」鈕（♪）：用官方 SpessaSynth Sequencer 播同一份 MIDI（不經過我們的 parser），拿來跟演奏對照聽感，跟演奏互斥。純原生 JavaScript（ES module）、沒有 build step、沒有後端；介面文字與程式碼註解一律繁體中文。

- **版面**：`#app-shell` 置中一個鎖 16:9 的固定比例方框 `#camera-frame`（視窗裝得下的最大 16:9 矩形），攝影機畫面在框內；攝影機畫面永久蓋著黑幕（`#stage-blackout`，純 CSS，沒有任何切換方式，`#webcam` 也永久隱藏），非 16:9 螢幕的黑邊就是 body 的 `#000` 底色。頂端置中疊一欄 `#top-center-stack`（`position:fixed`，在框外，不受 `#camera-frame` 的 `overflow:hidden` 裁切）：播放 pill（`#toolbar-playback`，四顆獨立按鈕 ▶ 播放／❚❚ 暫停／↻ 重播／♪ 試聽（`#btnPlay`／`#btnPause`／`#btnReplay`／`#btnPreview`，包在 `#transport-group`，狀態見下方「播放只由頂端播放列的按鈕觸發」；icon 是 inline SVG、重心對齊按鈕中心，不用字型字元，滑鼠移上去用純 CSS 把 `aria-label` 當提示顯示）＋完整顯示的歌名，`max-width` 直接沿用 `#camera-frame` 的寬度公式、最寬不超過攝影機外框）在上，系統控制／選歌控制列（`.control-row` 底下的 `panel-system`／`panel-song`，純文字按鈕、無 icon）在下——兩者垂直分層、水平都置中，結構上不會互相遮蔽，不需要用任何寬度計算去避免碰撞；兩者各自獨立淡化、互不牽動，純 CSS `:hover`／`:has()`（沒有 JS 計時器）：碰到就顯示、沒碰到立刻淡化；控制列小面板開著時控制列自己強制顯示。還沒有能播放的歌曲之前（播放 pill 帶 `is-empty`：idle／載入中）控制列常駐不淡出——這時候它是唯一的操作入口；選好歌之後控制列回到 hover 才顯示的淡出邏輯，換成播放 pill 常駐不淡出，把畫面重心讓給攝影機與正在播放的資訊，兩條規則共用同一個「有沒有歌可播」判斷、條件互斥。`panel-system`（攝影機開關／現場人數／重置骨架 ID）是常駐區塊，一進頁面就看得到、沒有開合狀態；`panel-song`（選歌＋分譜指派）是觸發鈕＋彈出小面板，彈出面板釘在整排控制列的左下角展開（不是自己觸發鈕下方）。面板內容變多隻會往下撐到 `max-height` 再交給內部捲動——觸發鈕與✕的位置永遠不變，不會因為內容量被推移。這幾個浮動元件都以 `--ui-fs` 為基準字級、內部尺寸一律 `em`；`--ui-fs` 由 `src/ui.js` 的 `applyUiFontSize()` 綁視窗實際像素並除掉瀏覽器縮放倍率（Ctrl +/− 時 UI 視覺大小不變）。歌名優先單行顯示，超長時用 `--song-title-scale` 縮小字級撐住，縮到下限還放不下才退回換行（`src/midi/midiPlayer.js` 的 `fitSongTitle()`）。`#app-shell` 頂端貼邊另有一條獨立的 `#topProgressBar`（跨滿 `#camera-frame` 寬度、不顯示時間文字、純 CSS 對齊不用 JS 量測）：唯讀播放進度，顯示的是樂譜時鐘在原譜的第幾秒（`humanPerformer.getPositionSeconds()`）換算的比例：放行的拍內連續前進、停格時停住，不做補間動畫；第一次出現後就不會再因為換歌而重新收起（換歌時的空窗期維持停在舊值，不是補間，只是還沒有新的比例可以跳過去）；試聽中（♪）改成官方 Sequencer 的 `currentTime／duration`。**不能拖曳／seek**：沒有 seek 功能，要回到開頭用播放列的 ↻ 重播。
- **姿勢偵測不是開頁就跑**：系統控制的「現場人數」沒有預設值，選了 N 之後 MediaPipe 的 `numPoses` 與追蹤槽位數（＝ ID 上限）都設成 N。同一組控制有「攝影機開關」（關閉時串流真的停掉；被拔除／被搶走也視為已關閉，按一下重連）與「重置骨架 ID」，都只能點按鈕觸發——全專案沒有任何鍵盤快捷鍵，所有互動一律靠畫面上的按鈕。
- **選歌＝載入**：本地上傳或雲端曲庫選取後立刻解析、列出每個聲部一個「指派演奏者」下拉（無／演奏者 1~N），不啟動播放。播放靠 `src/midi/humanPerformer.js` 的排程器：整個合奏共用**一個樂譜時鐘 S**（單位：樂譜秒，跟音符的 `startSeconds`／`endSeconds` 同一個座標系），所有聲部——你控制的、電腦輔助的、代打的——的 note-on／note-off 都只看 S，所以彼此不可能不同步。揮手不是讓某個聲部跳到某一拍，而是**放行下一拍**（`buildBeatGrid()` 的律動拍）：放行邊界 B（`_frontierSec`）＝已放行那一拍的拍尾，S 以速度倍率 r 往 B 前進（r＝演奏者的速度是原譜速度的幾倍，由揮手間隔估計，見 N6；還沒取過樣＝1＝原譜速度）、碰到 B 就停格等下一次揮手。**每一拍（包含空拍）都要被放行**：真人揮一次放行一拍，你沒揮、該揮的時間到了則由電腦補位放行（見下「代打補位」）；4/4 一個小節是 4 拍，不會一次跳到這個聲部下一個真正有音符的拍（見下方「拍子從哪裡來」的 N1）。剛載入時 B 停在起始拍（所有指派聲部最早的音所在的那一拍）的拍首：電腦輔助的聲部先播前奏，時鐘離起始拍還有半拍以上時（`PRELUDE_ANTICIPATION_BEATS`，見 N7）你的揮手只標記「你在演奏」並取速度樣本（前奏跟著你打的拍子估出的速度走），不放行拍、不動邊界、不追趕、也不啟動代打；入場前半拍內的第一下揮手才放行起始拍；第一次放行不追趕，所以提早揮手不會把前奏追成倍速，真人的第一個音要等時鐘走到那裡才發聲。共用拍位只在 `_arbitrate()` 這個單一裁決點被改寫、一個 tick 最多放行一拍：多位演奏者同時揮手、一個人指派多個聲部（左右手）都只放行一拍，跟聲部處理順序無關；任何一次放行（真人或電腦）之後的短暫窗內晚到的揮手，視為對這一拍的回應、不另外再推一拍，他的聲部在這一拍已經走過的音會補上（見 N3）。沒有任何還沒放行的音的聲部（已經演奏完），它的揮手直接忽略——不推進拍位、不延後電腦的倒數。**揮手比時鐘早**時，S 在 r 之外再乘上 `1 + 16×落後量／拍長` 倍（最多 6 倍，見 N5）追趕最近放行那一拍的起點，不跳、不丟音，拍內剩下的快速音仍依序發聲，只是間隔被壓縮。揮過手的聲部，別人放行（或代打放行）的拍它的音照樣發聲，所以多人合奏時不會出現「有人的聲部走了、別人的沒走」；從未被自己演奏者揮過手的聲部維持靜音，不會被「別的聲部的觸發」補。音依樂譜時鐘收音（`endSeconds ≤ S` 就 note-off）；同音高重疊的音先進先出，每個 noteOn 都送出一個對應的 noteOff（「成對」以音為單位：原檔把音的結束寫成 Note Off 還是 velocity 0 的 Note On 都一樣，parser 配成同一顆音；排程器絕不送 velocity 0 的 noteOn，合成器會把它當成 note-off）；沒有排隊閘門，新音不會因為同聲部的舊音還在響而延後。拍格線由 `src/midi/midiParser.js` 的 `buildMeasureGrid()`（拍號段落）與 `buildBeatGrid()`（切成拍）依真實的拍號（含 `FF58` 的 `cc`／`bb` 兩個位元組，見下方「拍子從哪裡來」）與 ticksPerQuarter 算出；沒有拍格線（SMPTE division，A5）時忽略指派、整首自動播放。**拋物線手勢**由 `src/vision/gesture.js` 的 `ArcDetector` 偵測手腕＋手掌合併點「先下沉再回升」的形狀（兩軸判斷、不依賴肩膀高度、開口大小方向都不限，純粹是離散的「有效觸發」訊號，不輸出音量），且每個追蹤槽位會自動鎖定先做出有效拋物線的那隻手，之後只認那隻手，避免另一隻閒置手在畫面上飄移湊出假觸發。note-on 一律用樂譜原始 velocity，不套用手勢公式；不做任何音色覆蓋，一律沿用聲部原始 MIDI 音色；不重播 CC／pitch-bend，每個 voice 的初始狀態（bank／program 與混音 CC7／10／91／93）只在載入時套用一次（刻意的簡化）。
- **代打補位（合奏層級）**：整個合奏只有一個倒數（`humanPerformer.js` 的 `_autopilotLeftSec`），任何一位演奏者的任何一次真人動作（放行或跟上）都讓它重新開始，所以只要還有人在揮手，誰都不會被代打。真人動作之後，電腦預期下一次揮手在「這一拍走完」的時候（拍長 ÷ r），再寬限 τ（`AUTOPILOT_GRACE_BEATS`＝0.15 拍，120 BPM 約 75ms）還沒有人揮手，就替「曾被真實觸發過」的指派聲部整批放行這一拍——**連有你音符的拍也放行**：你的聲部照譜發聲，音量用代打的 CC7（voice 原音量 × `AUTOPILOT_VOLUME_RATIO`＝0.845，原音量 100 時是 85，約等於電腦輔助軌的基準）；真人音量配合真人軌整體的 `HUMAN_EMPHASIS_GAIN`（見「兩軌模型」）形成比電腦輔助更大聲的凸顯，只給你揮手放行的拍，只調音量、不影響 note-on velocity（觸鍵力度，兩者是不同的 MIDI 概念）。之後每一步等剛走進那一拍的真實時間（拍長 ÷ r），相位沿用最後一次真人揮手的節拍，不會每拍多晚 τ；電腦放行不取樣、不重設估計。還沒有速度取樣（只揮過一次手）時寬限放寬成 `FIRST_SAMPLE_GRACE_BEATS`（2 拍，原譜速度）。**晚到的揮手**：電腦放行這一拍之後你才揮，而且你自己上一次揮手到現在 ≤ `LATE_RESPONSE_BEATS`（1.7 拍，拍長 ÷ r）——你只是比電腦預期晚，不是漏揮，算你對這一拍的回應；離電腦放行 F（`FOLLOW_WINDOW_BEATS`＝0.3 拍）內的揮手也算（多人幾乎同時揮手）。不多推一拍（避免棘輪），拿來校正速度，你的聲部立刻換回真人音量（GM 預設 100）；隔超過 1.7 拍才揮就是你漏揮了一拍、這下揮的是下一拍（見 N3）。這一拍你的聲部是休止符、你有揮手＝不出音（揮手本身不會讓任何聲部多出一個音）。你完全停手＝音樂自己照估計速度一路播到曲末（要停請按 ❚❚）；時鐘還在前奏（沒走進第一個指派聲部的入場拍）時倒數不開始，前奏照樣播完。倒數依 tick 的 dt 遞減，暫停期間不算停手。從未被真實觸發過的聲部代打不會替它走，維持靜音（見 N2）。
- **相連音撐住與停格釋放**：樂譜時鐘 S 碰到放行邊界 B 就停格。有了代打補位，第一下揮手之後最多只停一小段（寬限 τ、遲到的窗），長時間停格只發生在第一下揮手之前（前奏結尾，等第一下揮手）。MIDI 編碼裡「結尾到同一個聲部下一顆起音的間隙 ≤ θ」（見 N4）的相連音，在它的後繼音還沒放行時不收，後繼音一放行就在它發聲的同一個 tick 先關再開——這不是延音效果，只是不在「時鐘停格等你」那一下提早出現檔案裡沒有的空白；其餘一律照檔案收音（真正的休止、斷奏照原譜長度收；整首自動播放與穩定揮手時每個 note-off 都跟檔案一致，誤差不超過一個排程 tick）。停格超過閒置門檻（`max(IDLE_MS, 目前拍長 × IDLE_BEATS)`）就把所有還在響的音收掉，長音、相連音都不會無限期響著。電腦輔助的聲部一致套用。
- **電腦輔助的聲部與曲末**：沒被指派的聲部跟指派聲部共用同一個樂譜時鐘 S 與放行邊界 B（沒有各自的播放頭），任一次放行都讓它們一起前進，樂譜上同一時刻的音一定在同一個 tick 發聲。電腦輔助的音要等它所在的那一拍被放行才會發聲，放行邊界是排他的：剛好落在拍尾的下一拍第一顆音要等下一次放行。完全沒有人指派任何聲部時 B＝∞，整份照時間連續自動播放。所有指派聲部都沒有還沒放行的音時自動進入終局（`_checkFinale()`）：B＝∞，尾奏照最後一次估計的速度播完，不需要使用者多揮一下。只要還有任何一個指派聲部有音沒放行就不會進終局——演奏者缺席的聲部也一樣：電腦把每一拍放行完，缺席者從未揮過手的聲部只是被路過（靜音）。
- **揮過手的聲部跟著合奏走**：指派聲部出不出聲只看它的演奏者「曾經被真實觸發過」，不看你在不在鏡頭裡：揮過手的聲部，合奏放行的每一拍它的音都發聲（你揮手放行的拍用真人音量、別人或代打放行的拍用代打音量）；從未揮過手的聲部維持靜音，不會被別人補，代打也不會替它起頭；晚進場的演奏者第一下揮手之前已過去的音不補（合併窗內的除外，見 N3）。指派本身是持久設定，不隨追蹤雜訊變動。
- **聲部（part／voice）**：`parseMidi()` 把一個 MuseScore 樂器切成一個 part（可指派的單位，畫面上分譜清單的一列），part 底下有一個以上的 voice（一個譜表 × 一個樂器 channel：鋼琴兩行譜是兩個 voice，弓弦的 pizzicato channel 有音時是另一個 voice；排程、發聲、輸出 channel 以 voice 為單位，指派以 part 為單位）。切分規則只有一條（沒有「是不是 MuseScore 檔」的分支）：MuseScore 一個譜表一條 track，只有樂器最上行譜的 track 在 tick 0 對樂器的每個 channel 寫初始化區塊（CC121、Program Change、CC7／10／91／93），所以依軌序掃描，一條 track 併入「目前這一組」當且僅當它沒有初始化區塊、軌名跟首軌相同（任一方為空也算相同）、音符 channel 全在這組已知的 channel 內；沒有音符的 track（Meta 軌、空軌）不成聲部。聲部名一律 GM 繁中音色名（取主 voice——音符最多者——的 program，打擊用鼓組名；不採信檔案的軌名／樂器名，不放高低音譜／旋律伴奏等推導出來的描述），同名依總譜順序加序號。每個 voice 的初始狀態（program、bank、混音 CC7／10／91／93）取自首軌 tick 0 的初始化區塊（下行譜沿用首軌對同一個 channel 的），沒有就用時間軸查詢的 program 與 GM 預設；音符的 channel 是絕對 channel（軌內 channel 加上 port 偏移，依 port 第一次出現的順序 +16，跟官方 SpessaSynth 一致）。

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
| `src/midi/synth.js` | spessasynth 合成器：兩個合成器（電腦輔助聲部 `synth`／真人聲部 `synthHuman`）、humanGain 閘門＋音量凸顯；演奏不用 Sequencer，直接接收 `humanPerformer.js` 送來的個別 note 事件；試聽才用官方 `Sequencer`（`startPreview()` 等，走 `synth`）；`flushPreviousSong()` 是演奏與試聽共用的清場；兩個合成器模仿官方 Sequencer 依需要補 port（每個 port 16 個 channel，只增不減）：開機補到 `DEFAULT_PORTS`（4 個 port＝64 個 channel），歌曲需要更多時 `load()` 依 `portsNeeded()`（旋律 voice 每個 port 15 個、每種鼓組佔一個 port 的打擊槽）補；每次補完都要 `reset()` 一次——動態新增的 channel 預設是打擊 channel（worklet 回讀實測），不重設的話旋律聲部超過 15 個的歌，channel 16 以上會用鼓組發聲；channel 數只能自己計數（lib 的 `addNewChannel()` 會讓 `midiChannels.length` 雙重 push），常數 `CHANNELS_PER_PORT`／`DEFAULT_PORTS` 的單一來源是 `humanPerformer.js` | ✓ |
| `src/midi/previewPlayer.js` | 試聽：官方 Sequencer 的薄包裝（Sequencer 由 `synth.js` 注入）——等非同步載入結果（同名 songChange／midiError／逾時／被中斷）、暫停／續播／從頭／停止、`loopCount` 關循環 | ✓ |
| `src/midi/midiPlayer.js` | 播放器：`playerStore`、選歌／播放／試聽／指派／人數動作、手勢 hook、兩個 tick ＋ 四段畫面（pill／頂端進度條／曲庫／選檔與分譜） | — |
| `src/midi/midiApi.js` | 遠端 MIDI 曲庫 client（分類／搜尋／下載），純資料 | ✓ |
| `src/midi/midiParser.js` | SMF 解析／重新編碼、GM 繁中命名、聲部切分（part／voice，見「聲部」）、`buildMeasureGrid()`／`buildBeatGrid()` 小節與拍格線 | ✓ |
| `src/midi/humanPerformer.js` | 排程器（以 voice 為單位：parser 的 part 底下一個以上的 voice，指派以 part 為單位、排程發聲與輸出 channel 以 voice 為單位；打擊 voice 依鼓組 program 分到每個 port 的 channel 9（預設 4 個 port＝9／25／41／57）；每個 voice 載入時送 bank／program 與 CC7／10／91／93）：單一樂譜時鐘 S＋放行邊界 B、依揮手（真人或代打）逐拍放行、發聲／收音（先進先出）、相連音撐住與停格釋放、追趕、揮手速度估計（`rateSample()`／`smoothRate()` 兩個純函式）、重設／重播、`getPositionSeconds()` | ✓ |

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
| A4 | 拍號變更處強制斷一條小節線，該段最後一小節可能不完整；全曲最後一小節不截短 |
| A5 | SMPTE division 沒有拍格線，`buildMeasureGrid()` 回空陣列；`humanPerformer.load()` 遇到這種檔案忽略指派、整首自動播放 |
| A7 | 強弱與 swing 完全不推導，每一拍等長、無輕重之分 |
| A8 | part／voice 的 id 不含 program、bank，也不依 port 數值區分：voice id ＝ `t<軌序號>c<絕對 channel>`；`FF21`（port）這個欄位其實不在 RP-001 正式定義的 meta event 清單裡，是業界常見但未被正式標準化的慣例欄位（RP-019 定義的是 `FF09` Device Name，並把它描述成「取代 cable number（即 `FF21`）的更好做法」，隱含同一軌對應一個裝置的假設，但這是慣例推論、不是 RP-019 對 `FF21` 本身的規定）。整條 track 用軌內最後一個 `FF21` 算絕對 channel（跟官方 SpessaSynth 一致），中途切換 port 違反上述慣例，`parseTrack()` 會偵測並警告這種檔案 |
| A9 | voice 的 program 只看 tick 0（首軌初始化區塊裡的 Program Change），沒有初始化區塊時才用時間軸查詢（自己軌優先、再查全曲、預設 0）；之後 tick>0 的 Program Change 被忽略（曲庫 166 首裡 0 首有）。Bank Select 要等 Program Change 才生效（GM2 §3.3.1），voice 的 bank 取初始化區塊的值、沒有就取第一顆音之前最後一次送的、都沒有用 GM2 規格預設（第 10 個 channel 為節奏 bank 120，其餘為旋律 bank 121） |
| A14 | 同一條 track 內的多個 channel 視為同一個樂器的音色層（歸在同一個 part 的不同 voice）：format 0 的多樂器 GM 檔不會被拆成多個 part（曲庫目前沒有） |
| A15 | 軌名只用來判斷「下行譜併入上一組」（相同或任一方為空），不用來命名；CC64 踏板、CC2 動態、CC1、RPN、pitch bend 都不處理（曲庫 8 首用到 CC64，影響鋼琴延音聽感） |
| A13 | `buildMeasureGrid()` 的律動拍長優先採用 `cc` 換算，但 `cc = 24`（MIDI 的內建預設值，多數編曲軟體不論拍號一律照抄）一律視為「檔案沒有表態」而退回拍號分母音符——複拍子（如 6/8）若真的把 `cc` 寫成 24，仍會切成分母音符的拍數，不是實際律動單位 |
| N1 | 一次有效拋物線＝放行下一拍（共用拍位往前走恰好一拍，`buildBeatGrid()` 的律動拍），不管這拍本身有沒有音符，不會跳到觸發者下一個真正有音符的拍；每次有效揮手一律放行下一拍（剛載入時先放行起始拍本身）。這個顆粒度是使用者明確拍板的目標（4/4 一個小節要觸發 4 次）；長音／空拍多時要揮很多次手太累的因應是代打（N2） |
| N2 | 代打補位：電腦替「曾被真實觸發過」的指派聲部放行沒人揮的拍（含有他音符的拍），一次一拍（跟 N1 完全相同的顆粒度）。等待時間：真人動作之後 `(拍長 ÷ r) × (1 + τ)`（τ＝`AUTOPILOT_GRACE_BEATS`，0.15），電腦放行之後每步 `拍長 ÷ r`；還沒有速度取樣時真人動作之後等 `FIRST_SAMPLE_GRACE_BEATS`（2）拍的原譜時間；時鐘還在前奏時不倒數。這些是應用層數字，不是規格，也跟演奏者的揮手間隔無關（只透過 r 間接相關）：τ 太小會讓電腦搶在揮手抖動較大的人前面放行（曲庫實測：τ 0.1 時揮手抖動 ±15％ 就有 14％ 被搶先，0.15 是 4％，0.2 是 1％）；單看「離電腦放行多久」的窗（F）分不開晚到與漏揮：窗大會吞掉漏揮之後準時的下一拍，窗小則揮手一晚就每拍多推一拍，所以另用 N3 的間隔判斷。代價：電腦放行的音比你稍晚的揮手早一點出聲（最多約 τ＋0.3 拍），你晚到的揮手之後時鐘還在追趕；演奏者突然變慢、r 還沒跟上（揮手間隔超過電腦的等待加上遲到窗）時，電腦先放行、你的揮手再推進下一拍，共用拍位就比他數的拍多一兩拍，之後不會自己消失 |
| N3 | 遲到揮手歸屬／多人合併窗：某位演奏者的揮手落在「任何一次放行（真人或電腦）」之後 F（`FOLLOW_WINDOW_BEATS`，0.3）× 拍長 ÷ r 內、而且他自己這一拍還沒動作過，視為對這一拍的回應（跟上同一拍或遲到），不另外再推一拍；另外，電腦放行的拍上，你自己上一次揮手到現在 ≤ `LATE_RESPONSE_BEATS`（1.7）拍（拍長 ÷ r）的揮手同樣算回應（分辨晚到與漏揮：漏揮一拍的下一下揮手離上一次約 2 拍，晚到的連續揮手最晚約 1.3 拍；1.7 是曲庫模擬的折衷，1.5 壓不住抖動 ±30％，2.0 會把漏揮當成晚到）——多人幾乎同時揮手是常態，各推一拍會讓合奏比最慢的人多走一拍；電腦放行之後你才揮，推了就是同一拍被算兩次（棘輪）。電腦放行的拍上你的第一下揮手同時是這一拍的速度取樣。同一個窗也決定晚到的人能補多少音：指派聲部在第一次被揮手之前，最近一個窗內（樂譜時間：窗長 × r）走過的音先留著，他在窗內第一次揮手就補上（不然多人一起開始時慢半拍的人永遠少了第一顆音），過了窗的音丟掉。F 與 τ 都是應用層數字，不是規格 |
| N4 | 相連音的「小間隙」門檻 θ ＝ ticksPerQuarter ÷ `LEGATO_GAP_DIVISOR`（16；480 tpq 時 30 tick）：音符結尾到同一個聲部下一個起音點的間隙 ≤ θ 才算相連音，時鐘停格時它會撐到後繼音放行（見「相連音撐住與停格釋放」）。MuseScore 把相連音符寫成「記譜長度 − 1 tick」（間隙固定 1 tick），真正的最短休止（三十二分休止）≥ 60 tick，θ 落在兩者中間的空檔（曲庫實測 83% 的間隙 ≤ 30 tick）。這是應用層數字，不是規格；用 tick 不用秒，跟速度無關；SMPTE division 沒有 tick 換算，不撐 |
| N5 | 樂譜時鐘的追趕、停格與步長：S 落後最近放行那一拍的起點 L 秒時，在 r 之外再乘上 `1 + CATCHUP_GAIN（16）× L ／ 拍長` 倍前進，最多 `CATCHUP_MAX_SPEED`（6）倍；第一次放行不追趕；S 碰到 B 停格，停格超過閒置門檻（`max(IDLE_MS, 目前拍長 × IDLE_BEATS)`，只擋第一下揮手之前的停格）就把還在響的音全部收掉；每個 tick 的時間步長上限 `MAX_TICK_DT_SEC`（0.1 秒），分頁被節流後恢復時不會一次吐出一大段。都是應用層數字，不是規格 |
| N6 | 速度倍率 r（演奏者的速度是原譜速度的幾倍）的估計：每次真人揮手（放行下一拍，或晚到而算對電腦放行那一拍的回應）取一次樣——上一次真人揮手那一拍的樂譜長度 ÷ 兩次揮手之間真實過的秒數（用上一次揮手那一拍的長度，樂譜自己變速時才對得上時間；中間隔著電腦補位的拍不算進分子，所以漏揮一次是「一拍的長度 ÷ 兩拍的時間」＝慢一半的離群取樣）；在對數域做指數平滑 `r' = r^(1−α)·樣本^α`（`RATE_ALPHA`＝0.35；速度是倍率，快兩倍與慢一半要對稱），樣本落在 `[RATE_MIN, RATE_MAX]`（0.25～4）之外視為停頓、不採樣；比目前估計快或慢超過 `RATE_OUTLIER`（40％）的樣本先暫存，下一個樣本同向且幅度對得上才一起套用（真的變速），對不上（變回正常、方向相反）就丟掉（同一個動作被偵測成兩次、偶爾漏揮）。暫停清掉「上一次揮手」與暫存；電腦放行不取樣；還沒取過樣＝1，重設退回 1。r 決定時鐘的速度、電腦的等待時間與遲到窗的長度；代打與終局沿用最後一次估計。這是應用層的模型與數字，不是規格——規格只保證原譜速度（`tickToSeconds()`） |
| N7 | 前奏提前量：時鐘還沒走進入場拍之前 `PRELUDE_ANTICIPATION_BEATS`（0.5）拍（樂譜時間，用入場拍的長度算）時的揮手，視為你在自己聲部的空白前奏裡打拍子，只標記 `triggered`、取速度樣本，不放行拍、不動邊界 B、不追趕、不啟動代打；之後的揮手才放行起始拍。人通常比拍點早一點揮，所以入場前半拍內的第一下算對入場拍的預先放行。不留提前量就會把你數的前奏拍當成入場拍之後的拍，邊界被推到好幾拍之後，前奏被追趕衝過去（曲庫實測前奏快 4～6 倍）。這是應用層數字，不是規格 |

樂譜時鐘 S 在放行邊界以內以**速度倍率 r** 前進（N6）：r＝1 就是規格保證的原譜速度（`tickToSeconds()` 算出來的秒數）——還沒取過樣、沒有人被指派、整首自動播放時都是 1。r 只由離散事件更新（每次真人放行一拍取一次樣）；代打與終局沿用最後一次估計，音依樂譜時鐘收，沒有「發聲後各自倒數」的機制，所以手停下來時音只會照估計速度走到放行邊界 B 就停格，超過閒置門檻就收掉，不會被拖長。r 之外另有兩個例外也由離散事件決定：揮手比時鐘早時 S 暫時加速追趕（N5，最多 6 倍，落後量歸零就回到 r）；時鐘停格時相連音撐住、停太久收掉。

已知且刻意保留的行為：揮手比時鐘早（演奏者比目前估計的速度快，例如剛加速、估計還沒跟上）時，拍內的音間隔被壓縮——追趕倍率最多 6 倍、通常不到 0.25 拍——而不是丟掉或擠成同一個 tick；代打走過空拍之後演奏者準時揮手，音比揮手晚一點點（N2）；時鐘停格時相連音的撐住與停格釋放是「等你揮手」才有的行為，整首自動播放完全照編碼；排程跑在主執行緒的 12ms tick，同一個 tick 發的音彼此零誤差，tick 與 tick 之間有主執行緒抖動（spessasynth_lib 的 noteOn／noteOff／controllerChange／programChange 接受 `eventOptions.time`——AudioContext 時間，worklet 內依時間排隊，精度是一個 128 取樣的 render quantum——但排程器目前沒用：它沒有取消已排程事件的 API，揮手當下的拍首音也只能立即送。本機無頭軟體算繪實測：鏡頭開著時 tick 平均約 28～30ms，鏡頭關閉是 12.0ms，抖動主因是影像算繪，見 `test/tools/jitter-measure.mjs`）。

## 慣例與禁止事項

- **語言**：介面文字與程式碼註解一律繁體中文。
- **樣式**：JS 不寫 `element.style` 或行內 `style`；顯示／隱藏切原生 `hidden` 屬性（`el.hidden = bool`），其他狀態切 `is-*` class，純呈現寫在 `src/styles.css`；明文例外只有三個連續量：`--ui-fs`、頂端歌名單行縮放用的 `--song-title-scale`、彈出面板高度上限 `--popup-max-height`。`styles.css` 用 `@layer base, ui, states` 三層，新規則一定要放進對應的層（沒包層的規則會贏過所有層）；`states` 層永遠贏，不用 `!important`。
- **HTML-first 與清單**：靜態 UI 一律寫在 `index.html`，JS 不用字串產生 markup、不用 `innerHTML`；重複結構用 `<template>`（目前只有分譜列 `tpl-part-row`）clone，文字用 `textContent`、下拉用 `new Option()`，聲部名等外部字串因此不需要跳脫。
- **事件與狀態**：控制項的行為經 `data-action`（click）／`data-field`（change／input）委派到 `#top-center-stack`，不逐元素 `addEventListener`；狀態放 `playerStore`／`uiStore`，畫面由 `render(snapshot)` 依狀態畫，DOM 不是真相；巢狀物件（Map、library）改動時換新參照。一次性動畫（重置鈕閃黃）例外，handler 直接切 class。
- **版面**：`#camera-frame` 鎖 16:9（F11 穩定性），不要改回滿版；不要用 `max-width/max-height:100% + aspect-ratio`（flex 裡會塌成 0 高）；攝影機容器不能用 JS 在執行期搬動（`vision.js` 模組頂層就抓 DOM）；開機期間擋互動靠 `#app-shell` 的 `inert`，不靠遮罩的 z-index；`#stage-hint` 必須 absolute。`--ui-fs` 必須由 JS 綁視窗實際像素並除掉縮放倍率（混 vw 或純固定 px 都不對）。
- **控制列小面板**（`panel-song`）只能用 ✕、再按觸發鈕關閉，**不做「點外部關閉」**；`panel-system` 是常駐區塊，沒有開合狀態。彈出面板釘在整排控制列左下角、向下展開（不是自己觸發鈕下方，開合狀態是 `uiStore.openPanel`）。控制列與頂端播放 pill 垂直疊在同一欄（`#top-center-stack`）、結構上不會互相遮蔽，不用算誰佔多少水平寬度；歌名完整顯示不截斷；`#midiStatusText` 只放歌名，不寫「解析中／下載中」。全專案沒有任何鍵盤快捷鍵（包含關閉面板）。
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

  **試聽**（`src/midi/previewPlayer.js` 包官方 SpessaSynth `Sequencer`，走電腦輔助那個合成器 `synth`）：位元組原樣交給官方解析、官方在 AudioWorklet 裡自己排程，不經過我們的 parser，所以我們的 parser 解析失敗時試聽仍可用，也能拿來對照聽感。♪ 載入完成就從第一個音（官方 `skipToFirstNoteOn`）開始播，`loopCount` 明確設成 0（官方預設會循環）；頂端進度條在試聽時改顯示官方的 `currentTime／duration`（同樣唯讀、不能拖曳）。**跟演奏互斥**（共用 `synth` 的 channel）：進入試聽＝結束目前演奏進度（`flushPreviousSong()`、`lastPlayedSignature` 清掉），離開試聽（再按 ♪）後演奏回到「已載入、還沒播過」，下次 ▶ 整個重新載入；官方 Sequencer 動過合成器的狀態，離開時 `flushPreviousSong()` 額外做一次完整 `synth.reset()`。突發狀況的處理（`midiPlayer.js` 的 `enterPreview()`／`leavePreview()`／`playPreview()`，`test/browser/smoke-test.mjs` 逐一測）：換歌／退回「請選擇歌曲」／重選同一首由 `beginSourceChange()` 停掉試聽（`flushPreviousSong()` 也中斷載入中的試聽），過期的非同步結果靠 `sourceLoadToken` 作廢；引擎壞了（按下才發現）頂端提示「音源引擎載入失敗」；官方解析器拒絕或沒有回應（對長度 0 的 MIDI 官方不回任何事件，所以有逾時）頂端提示「官方播放器無法解析這首 MIDI」並留下 `console.warn`，失敗都回到演奏「已載入、還沒播過」；試聽中改指派／人數不影響試聽、有手勢觸發被忽略（排程器已停，`humanGain` 關著）；播完由 `uiTick` 偵測官方的 `isFinished`。

  ↻ 與播完後的 ▶ 共用 `humanPerformer._resetPlayback()`（跟 `stop()` 同一個重設函式）：樂譜時鐘、拍位、放行邊界、速度倍率與上一次揮手紀錄、追趕與停格計時、每個聲部的游標／揮手紀錄、代打與合併窗紀錄、CC7 都退回剛載入的樣子，代打要等真人重新揮手過才會啟動。任何新增的排程器狀態欄位都要在 `_resetPlayback()` 重設（單元測試有整體快照比對，忘了會直接失敗）；若指派改過（簽章不同）則走完整重新載入。
- **指派持久**：下拉恆列「現場人數」個 ID，不隨鏡頭當下偵測到幾人增減；某 ID 不在場就是收不到新揮手：揮過手的聲部跟著合奏走（代打音量），從未揮過手的聲部維持靜音（見上「揮過手的聲部跟著合奏走」），指派本身留著、不會被清掉。
- **兩軌模型**：電腦輔助軌固定不動（不掛額外 gain，是音量對比的固定基準），跟指派聲部共用同一個樂譜時鐘與放行邊界；指派聲部固定走真人軌，揮過手才發聲，velocity 一律用樂譜原值，不套用手勢公式；真人軌整體的 `humanGain` 開啟時刻意調到比電腦輔助軌大聲（`synth.js` 的 `HUMAN_EMPHASIS_GAIN`），凸顯使用者控制的聲部；共用拍位只在有效揮手（真實或代打）那一刻才前進一拍；代打放行的拍，揮過手的聲部的 CC7 校正到約等於電腦輔助軌的音量基準（原音量 × `AUTOPILOT_VOLUME_RATIO`——代打當下是電腦在演奏，音量跟電腦輔助的聲部一致，真正的凸顯完全交給真人揮手時的 `HUMAN_EMPHASIS_GAIN`；原音量＝voice 的 `baseVolume`＝檔案 tick 0 的 CC7，沒有就是 GM 預設 100），只調音量、不動 velocity；樂譜時鐘以揮手間隔估計的速度倍率 r 前進（見「拍子從哪裡來」的 N6），不做任何音色覆蓋、不做持續的 CC11 表情覆蓋。
- **在場清單目前只是保留欄位**：`arcTriggerSeqBySlot`／`presentSlots` 仍由 `vision.js` 逐幀送出（心跳 `EMIT_HEARTBEAT_MS` 100ms、`midiPlayer.js` 的斷訊看門狗 `GATE_STALE_MS` 250ms 讓 `presentSlots` 在斷訊後清空），但 `humanPerformer.js` 目前只讀 `triggerSeq`（斷訊時刻意不歸零，避免誤判成一次新觸發）——`present` 沒有驅動任何行為；接手判定靠「有沒有新的 triggerSeq」，不看 `present`，這個欄位是為了將來可能需要更精確依在場狀態調整行為留著的介面。
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
