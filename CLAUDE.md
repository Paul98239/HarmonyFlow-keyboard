# CLAUDE.md

本檔為 Claude Code 在此 repository 中工作時的指引，**只寫「現在的 code 怎麼運作」與規則**。需求會一直變動：每次改變就直接改本檔、刪掉過時的段落，不累積歷史、不留「先前版本怎樣」。程式碼註解同樣只留「現在做什麼／為何這樣寫」。

## 專案簡介

HarmonyFlow 是瀏覽器端的 MIDI 演奏應用：攝影機 → MediaPipe 姿勢追蹤（最多 4 人、身分鎖定）→ 拋物線手勢每揮一次就放行下一拍（一次有效手勢＝共用拍位固定前進一拍，不論這拍本身有沒有音符）；整個合奏——你控制的聲部與電腦輔助的聲部——共用一個樂譜時鐘，照這個時鐘發聲，彼此不會不同步；時鐘的速度跟著你的揮手間隔走，揮得比原譜快或慢，所有聲部一起跟著。一個聲部只要曾經被你真實觸發過一次，之後你沒揮、該揮的時間到了（預期的揮手時間再寬限 0.2 拍），電腦就替你放行那一拍——連有你音符的拍也照譜播出（音量調低區分人／電腦），你一揮手（晚到的在 0.3 拍內算對那一拍的回應）就換回真人；你完全停手＝音樂自己照估計速度播到曲末（要停請按 ❚❚）；從未被你觸發過的聲部維持靜音，不會自動代打。其餘聲部固定由「電腦輔助的聲部」播放。相連的音在時鐘停格等你揮手時（只有第一下揮手之前）撐住、不留原譜沒有的空白（停太久就收掉），其餘一律照檔案收音；所有指派聲部的音都放行完，曲子自動收尾，不需要多揮一下。純原生 JavaScript（ES module）、沒有 build step、沒有後端；介面文字與程式碼註解一律繁體中文。

- **版面**：`#app-shell` 置中一個鎖 16:9 的固定比例方框 `#camera-frame`（視窗裝得下的最大 16:9 矩形），攝影機畫面在框內；攝影機畫面永久蓋著黑幕（`#stage-blackout`，純 CSS，沒有任何切換方式，`#webcam` 也永久隱藏），非 16:9 螢幕的黑邊就是 body 的 `#000` 底色。頂端置中疊一欄 `#top-center-stack`（`position:fixed`，在框外，不受 `#camera-frame` 的 `overflow:hidden` 裁切）：播放 pill（`#toolbar-playback`，三顆獨立按鈕 ▶ 播放／❚❚ 暫停／↻ 重播（`#btnPlay`／`#btnPause`／`#btnReplay`，包在 `#transport-group`，狀態見下方「播放只由頂端播放列的按鈕觸發」）＋完整顯示的歌名，`max-width` 直接沿用 `#camera-frame` 的寬度公式、最寬不超過攝影機外框）在上，系統控制／選歌控制列（`.control-row` 底下的 `panel-system`／`panel-song`，純文字按鈕、無 icon）在下——兩者垂直分層、水平都置中，結構上不會互相遮蔽，不需要用任何寬度計算去避免碰撞；兩者各自獨立淡化、互不牽動，純 CSS `:hover`／`:has()`（沒有 JS 計時器）：碰到就顯示、沒碰到立刻淡化；控制列小面板開著時控制列自己強制顯示。還沒有能播放的歌曲之前（播放 pill 帶 `is-empty`：idle／載入中）控制列常駐不淡出——這時候它是唯一的操作入口；選好歌之後控制列回到 hover 才顯示的淡出邏輯，換成播放 pill 常駐不淡出，把畫面重心讓給攝影機與正在播放的資訊，兩條規則共用同一個「有沒有歌可播」判斷、條件互斥。`panel-system`（攝影機開關／現場人數／重置骨架 ID）是常駐區塊，一進頁面就看得到、沒有開合狀態；`panel-song`（選歌＋分譜指派）是觸發鈕＋彈出小面板，彈出面板釘在整排控制列的左下角展開（不是自己觸發鈕下方）。面板內容變多隻會往下撐到 `max-height` 再交給內部捲動——觸發鈕與✕的位置永遠不變，不會因為內容量被推移。這幾個浮動元件都以 `--ui-fs` 為基準字級、內部尺寸一律 `em`；`--ui-fs` 由 `src/ui.js` 的 `applyUiFontSize()` 綁視窗實際像素並除掉瀏覽器縮放倍率（Ctrl +/− 時 UI 視覺大小不變）。歌名優先單行顯示，超長時用 `--song-title-scale` 縮小字級撐住，縮到下限還放不下才退回換行（`src/midi/midiPlayer.js` 的 `fitSongTitle()`）。`#app-shell` 頂端貼邊另有一條獨立的 `#topProgressBar`（跨滿 `#camera-frame` 寬度、不顯示時間文字、純 CSS 對齊不用 JS 量測）：唯讀播放進度，顯示的是樂譜時鐘在原譜的第幾秒（`humanPerformer.getPositionSeconds()`）換算的比例：放行的拍內連續前進、停格時停住，不做補間動畫；第一次出現後就不會再因為換歌而重新收起（換歌時的空窗期維持停在舊值，不是補間，只是還沒有新的比例可以跳過去）。**不能拖曳／seek**：沒有 seek 功能，要回到開頭用播放列的 ↻ 重播。
- **姿勢偵測不是開頁就跑**：系統控制的「現場人數」沒有預設值，選了 N 之後 MediaPipe 的 `numPoses` 與追蹤槽位數（＝ ID 上限）都設成 N。同一組控制有「攝影機開關」（關閉時串流真的停掉；被拔除／被搶走也視為已關閉，按一下重連）與「重置骨架 ID」，都只能點按鈕觸發——全專案沒有任何鍵盤快捷鍵，所有互動一律靠畫面上的按鈕。
- **選歌＝載入**：本地上傳或雲端曲庫選取後立刻解析、列出每個聲部一個「指派演奏者」下拉（無／演奏者 1~N），不啟動播放。播放靠 `src/midi/humanPerformer.js` 的排程器：整個合奏共用**一個樂譜時鐘 S**（單位：樂譜秒，跟音符的 `startSeconds`／`endSeconds` 同一個座標系），所有聲部——你控制的、電腦輔助的、代打的——的 note-on／note-off 都只看 S，所以彼此不可能不同步。揮手不是讓某個聲部跳到某一拍，而是**放行下一拍**（`buildBeatGrid()` 的律動拍）：放行邊界 B（`_frontierSec`）＝已放行那一拍的拍尾，S 以速度倍率 r 往 B 前進（r＝演奏者的速度是原譜速度的幾倍，由揮手間隔估計，見 N6；還沒取過樣＝1＝原譜速度）、碰到 B 就停格等下一次揮手。**每一拍（包含空拍）都要被放行**：真人揮一次放行一拍，你沒揮、該揮的時間到了則由電腦補位放行（見下「代打補位」）；4/4 一個小節是 4 拍，不會一次跳到這個聲部下一個真正有音符的拍（見下方「拍子從哪裡來」的 N1）。剛載入時 B 停在起始拍（所有指派聲部最早的音所在的那一拍）的拍首：電腦輔助的聲部先照原速播前奏，第一次揮手放行起始拍；第一次放行不追趕，所以提早揮手不會把前奏追成倍速，真人的第一個音要等時鐘走到那裡才發聲。共用拍位只在 `_arbitrate()` 這個單一裁決點被改寫、一個 tick 最多放行一拍：多位演奏者同時揮手、一個人指派多個聲部（左右手）都只放行一拍，跟聲部處理順序無關；任何一次放行（真人或電腦）之後的短暫窗內晚到的揮手，視為對這一拍的回應、不另外再推一拍，他的聲部在這一拍已經走過的音會補上（見 N3）。沒有任何還沒放行的音的聲部（已經演奏完），它的揮手直接忽略——不推進拍位、不延後電腦的倒數。**揮手比時鐘早**時，S 在 r 之外再乘上 `1 + 16×落後量／拍長` 倍（最多 6 倍，見 N5）追趕最近放行那一拍的起點，不跳、不丟音，拍內剩下的快速音仍依序發聲，只是間隔被壓縮。揮過手的聲部，別人放行（或代打放行）的拍它的音照樣發聲，所以多人合奏時不會出現「有人的聲部走了、別人的沒走」；從未被自己演奏者揮過手的聲部維持靜音，不會被「別的聲部的觸發」補。音依樂譜時鐘收音（`endSeconds ≤ S` 就 note-off）；同音高重疊的音先進先出，每個 noteOn 都送出一個對應的 noteOff（「成對」以音為單位：原檔把音的結束寫成 Note Off 還是 velocity 0 的 Note On 都一樣，parser 配成同一顆音；排程器絕不送 velocity 0 的 noteOn，合成器會把它當成 note-off）；沒有排隊閘門，新音不會因為同聲部的舊音還在響而延後。拍格線由 `src/midi/midiParser.js` 的 `buildMeasureGrid()`（拍號段落）與 `buildBeatGrid()`（切成拍）依真實的拍號（含 `FF58` 的 `cc`／`bb` 兩個位元組，見下方「拍子從哪裡來」）與 ticksPerQuarter 算出；沒有拍格線（SMPTE division，A5）時忽略指派、整首自動播放。**拋物線手勢**由 `src/vision/gesture.js` 的 `ArcDetector` 偵測手腕＋手掌合併點「先下沉再回升」的形狀（兩軸判斷、不依賴肩膀高度、開口大小方向都不限，純粹是離散的「有效觸發」訊號，不輸出音量），且每個追蹤槽位會自動鎖定先做出有效拋物線的那隻手，之後只認那隻手，避免另一隻閒置手在畫面上飄移湊出假觸發。note-on 一律用樂譜原始 velocity，不套用手勢公式；不做任何音色覆蓋，一律沿用聲部原始 MIDI 音色；不重播 CC／pitch-bend，每個聲部的音色只在載入時套用一次 bank／program（刻意的簡化）。
- **代打補位（合奏層級）**：整個合奏只有一個倒數（`humanPerformer.js` 的 `_autopilotLeftSec`），任何一位演奏者的任何一次真人動作（放行或跟上）都讓它重新開始，所以只要還有人在揮手，誰都不會被代打。真人動作之後，電腦預期下一次揮手在「這一拍走完」的時候（拍長 ÷ r），再寬限 τ（`AUTOPILOT_GRACE_BEATS`＝0.2 拍，120 BPM 約 100ms）還沒有人揮手，就替「曾被真實觸發過」的指派聲部整批放行這一拍——**連有你音符的拍也放行**：你的聲部照譜發聲，音量用代打的 CC7（`AUTOPILOT_VOLUME_CC`＝85，約等於電腦輔助軌的基準）；真人音量配合真人軌整體的 `HUMAN_EMPHASIS_GAIN`（見「兩軌模型」）形成比電腦輔助更大聲的凸顯，只給你揮手放行的拍，只調音量、不影響 note-on velocity（觸鍵力度，兩者是不同的 MIDI 概念）。之後每一步等剛走進那一拍的真實時間（拍長 ÷ r），相位沿用最後一次真人揮手的節拍，不會每拍多晚 τ；電腦放行不取樣、不重設估計。還沒有速度取樣（只揮過一次手）時寬限放寬成 `FIRST_SAMPLE_GRACE_BEATS`（2 拍，原譜速度）。**晚到的揮手**：電腦放行這一拍之後 F（`FOLLOW_WINDOW_BEATS`＝0.3 拍）內你才揮，算你對這一拍的回應——不多推一拍（避免棘輪），拿來校正速度，你的聲部立刻換回真人音量（GM 預設 100）；晚過頭（τ＋F＝0.5 拍）就是你在揮下一拍。這一拍你的聲部是休止符、你有揮手＝不出音（揮手本身不會讓任何聲部多出一個音）。你完全停手＝音樂自己照估計速度一路播到曲末（要停請按 ❚❚）；時鐘還在前奏（沒走進第一個指派聲部的入場拍）時倒數不開始，前奏照樣播完。倒數依 tick 的 dt 遞減，暫停期間不算停手。從未被真實觸發過的聲部代打不會替它走，維持靜音（見 N2）。
- **相連音撐住與停格釋放**：樂譜時鐘 S 碰到放行邊界 B 就停格。有了代打補位，第一下揮手之後最多只停一小段（寬限 τ、遲到的窗），長時間停格只發生在第一下揮手之前（前奏結尾，等第一下揮手）。MIDI 編碼裡「結尾到同一個聲部下一顆起音的間隙 ≤ θ」（見 N4）的相連音，在它的後繼音還沒放行時不收，後繼音一放行就在它發聲的同一個 tick 先關再開——這不是延音效果，只是不在「時鐘停格等你」那一下提早出現檔案裡沒有的空白；其餘一律照檔案收音（真正的休止、斷奏照原譜長度收；整首自動播放與穩定揮手時每個 note-off 都跟檔案一致，誤差不超過一個排程 tick）。停格超過閒置門檻（`max(IDLE_MS, 目前拍長 × IDLE_BEATS)`）就把所有還在響的音收掉，長音、相連音都不會無限期響著。電腦輔助的聲部一致套用。
- **電腦輔助的聲部與曲末**：沒被指派的聲部跟指派聲部共用同一個樂譜時鐘 S 與放行邊界 B（沒有各自的播放頭），任一次放行都讓它們一起前進，樂譜上同一時刻的音一定在同一個 tick 發聲。電腦輔助的音要等它所在的那一拍被放行才會發聲，放行邊界是排他的：剛好落在拍尾的下一拍第一顆音要等下一次放行。完全沒有人指派任何聲部時 B＝∞，整份照時間連續自動播放。所有指派聲部都沒有還沒放行的音時自動進入終局（`_checkFinale()`）：B＝∞，尾奏照最後一次估計的速度播完，不需要使用者多揮一下。只要還有任何一個指派聲部有音沒放行就不會進終局——演奏者缺席的聲部也一樣：電腦把每一拍放行完，缺席者從未揮過手的聲部只是被路過（靜音）。
- **揮過手的聲部跟著合奏走**：指派聲部出不出聲只看它的演奏者「曾經被真實觸發過」，不看你在不在鏡頭裡：揮過手的聲部，合奏放行的每一拍它的音都發聲（你揮手放行的拍用真人音量、別人或代打放行的拍用代打音量）；從未揮過手的聲部維持靜音，不會被別人補，代打也不會替它起頭；晚進場的演奏者第一下揮手之前已過去的音不補（合併窗內的除外，見 N3）。指派本身是持久設定，不隨追蹤雜訊變動。
- 聲部名一律 GM 繁中音色名（不採信檔案的軌名／樂器名），並判定高音譜／低音譜、旋律／伴奏來命名。

## 開發／執行

app 執行不需要任何本機安裝，clone 下來直接用 Live Server 開就能跑；沒有 Node 工具鏈、沒有 build step、沒有 CI。

- **VS Code Live Server**：用 VS Code 開啟專案根目錄當工作區，「Go Live」→ `http://127.0.0.1:5500/`（`.vscode/settings.json` 已設 port 與忽略清單）。ES module 與 `getUserMedia` 需要 `http(s)://`，不能用 `file://`；換其他靜態伺服器要對 `.wasm` 回 `application/wasm`。部署＝把資料夾原樣 serve 出去，本地跑起來看到的就是部署後的樣子。
- **第三方套件**：`@mediapipe/tasks-vision`（`src/vision/vision.js`）、`spessasynth_lib`（`src/midi/synth.js`）都直接寫死完整 jsDelivr CDN 網址匯入，沒有 import map、沒有本地副本，執行期需要網路。兩個套件都綁 `@latest`，不手動維護版本號，代價是 jsDelivr 對 `@latest` 有快取（瀏覽器端 7 天／邊緣節點 12 小時），版本可能在快取到期後無預警改變、且不同使用者吃到新版的時間點不一致；`spessasynth_lib` 對 `spessasynth_core`（core 對 `stb-vorbis`）宣告的相依版本本來就是 `latest`，管不到那一層，現在外層也主動浮動，兩層都是刻意選擇。
- 沒有格式化工具；寫新程式照同一個檔案既有的風格。修改後在瀏覽器開頁面檢查 console 與攝影機輸出。
- **自動化測試**：`playwright` 是 `package.json` 的 devDependency，先 `npm install`；`test/` 底下的腳本只服務開發／測試，不影響 app 本身零建置、直接從 CDN 匯入相依套件的部署方式。兩類測試：
  - `test/browser/smoke-test.mjs`（`node test/browser/smoke-test.mjs` 執行）：用 Playwright 開真的 Chromium＋假攝影機輸入，跑過選人數／載入本地樣本樂譜／指派聲部／按播放、暫停、重播整條流程（含播放列三顆按鈕在各狀態下的灰亮），檢查過程中有沒有非預期的 console error／warning／pageerror。**這個測試看不到 `spessasynth_processor.min.js`（AudioWorkletProcessor，音訊渲染執行緒）丟出的例外**：已實測確認，即使刻意讓 worklet 端丟出 Uncaught TypeError，`page.on('console')`／`page.on('pageerror')` 都收不到任何訊號，測試照樣回報「沒有問題」。牽涉 spessasynth worklet 內部狀態的 bug（例如 channel 配置、bank／program 是否真的送達）不能只靠這個測試「沒有報錯」判斷有沒有解決，要用直接印值驗證（`console.log` 搭配 `setTimeout` 讓非同步的 worklet 訊息先處理完再讀取狀態）。
  - `test/unit/*.test.mjs`（`node test/unit/midi-parser.test.mjs`、`node test/unit/human-performer.test.mjs`、`node test/unit/midi-api.test.mjs`、`node test/unit/oracle.test.mjs` 各自執行，純 Node，不需要瀏覽器）：對 `midiParser.js`／`humanPerformer.js`／`midiApi.js` 這類純邏輯模組直接跑回歸測試，涵蓋 SMF 解析的邊界情況（program 依時間軸查詢、running status 寬鬆讀取、命名）、排程器的核心行為（單一樂譜時鐘與一次放行一拍、揮手比時鐘早的追趕、揮手間隔的速度估計與時鐘／代打／合併窗跟著速度走、前奏、先進先出收音、相連音撐住與停格釋放、dt 上限、多人合併窗與路過的拍、代打補位（含有音符的拍）、遲到揮手歸屬與合奏層級倒數、取樣離群暫存、自動終局、重設／重播、代打音量對比，以及固定種子的整體不變量壓力測試）與雲端下載連結 log。沒有測試框架，跟 smoke-test.mjs 同一套 `run()`／`assert()` 手寫慣例。`oracle.test.mjs` 是**差異測試**：用 devDependency `spessasynth_core`（版本釘住，`npm install` 後可用；app 本身仍走 CDN、不受影響）的官方 `SpessaSynthSequencer` 當標尺，把 processor 的 noteOn／noteOff／programChange／controllerChange 換成記錄器（不載音色庫、不出聲），取得「官方播放器實際送給合成器的事件」，再跟 `parseMidi()`（L1）、排程器整首自動播放與被完美演奏者驅動時發出的音（L2）、以及「同一樂譜時刻的音要同時」的同步不變量（L3）比對。`runKnownDiff()` 標記目前已知有差異的項目（附原因與預計由哪個工作包修），它驗證「差異確實還在」，差異消失時會反過來失敗，提醒改成 `run()`。smoke test 開頭會印出 CDN 上官方套件版本，跟 devDependency 不同時提醒（標尺可能落後於 app 實際載入的版本）。
  - `test/tools/`（手動執行，不進 CI）：`library-scan.mjs` 用整個遠端 MIDI 曲庫驗證排程器——整首自動播放的忠實度、多聲部歌曲 × 3 種揮手風格、多人／晚進場／停手回來／漏揮與速度（×0.7～×1.6、漸快漸慢、突然變速）等情境，另量揮手→發聲的延遲、電腦搶在揮手前放行的比例、漏揮補位的時間差，以及共用拍位有沒有比演奏者數的拍多走（`--download` 把曲庫抓到 `test/tools/library/`，不進 git；`--only=autoplay,perform,scenarios` 選掃描）；`sim.mjs` 是它用的模擬演奏者與量測；`mutation-check.mjs` 在暫存資料夾裡故意把排程器弄壞（一次一行），確認指定的測試會變紅。
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
| `src/midi/humanPerformer.js` | 排程器：單一樂譜時鐘 S＋放行邊界 B、依揮手（真人或代打）逐拍放行、發聲／收音（先進先出）、相連音撐住與停格釋放、追趕、揮手速度估計（`rateSample()`／`smoothRate()` 兩個純函式）、重設／重播、`getPositionSeconds()` | ✓ |

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
| N1 | 一次有效拋物線＝放行下一拍（共用拍位往前走恰好一拍，`buildBeatGrid()` 的律動拍），不管這拍本身有沒有音符，不會跳到觸發者下一個真正有音符的拍；每次有效揮手一律放行下一拍（剛載入時先放行起始拍本身）。這個顆粒度是使用者明確拍板的目標（4/4 一個小節要觸發 4 次）；長音／空拍多時要揮很多次手太累的因應是代打（N2） |
| N2 | 代打補位：電腦替「曾被真實觸發過」的指派聲部放行沒人揮的拍（含有他音符的拍），一次一拍（跟 N1 完全相同的顆粒度）。等待時間：真人動作之後 `(拍長 ÷ r) × (1 + τ)`（τ＝`AUTOPILOT_GRACE_BEATS`，0.2），電腦放行之後每步 `拍長 ÷ r`；還沒有速度取樣時真人動作之後等 `FIRST_SAMPLE_GRACE_BEATS`（2）拍的原譜時間；時鐘還在前奏時不倒數。這些是應用層數字，不是規格，也跟演奏者的揮手間隔無關（只透過 r 間接相關）：τ 太小會讓電腦搶在揮手抖動較大的人前面放行，τ＋F 太接近 1 拍則會把「漏揮之後準時的下一拍」吞掉（算成對上一拍的回應）。代價：電腦放行的音比你稍晚的揮手早一點出聲（最多 τ＋F 拍），你晚到的揮手之後時鐘還在追趕；演奏者突然變慢、r 還沒跟上（揮手間隔超過電腦的等待加上遲到窗）時，電腦先放行、你的揮手再推進下一拍，共用拍位就比他數的拍多一兩拍，之後不會自己消失 |
| N3 | 遲到揮手歸屬／多人合併窗：某位演奏者的揮手落在「任何一次放行（真人或電腦）」之後 F（`FOLLOW_WINDOW_BEATS`，0.3）× 拍長 ÷ r 內、而且他自己這一拍還沒動作過，視為對這一拍的回應（跟上同一拍或遲到），不另外再推一拍——多人幾乎同時揮手是常態，各推一拍會讓合奏比最慢的人多走一拍；電腦放行之後你才揮，推了就是同一拍被算兩次（棘輪）。電腦放行的拍上你的第一下揮手同時是這一拍的速度取樣。同一個窗也決定晚到的人能補多少音：指派聲部在第一次被揮手之前，最近一個窗內（樂譜時間：窗長 × r）走過的音先留著，他在窗內第一次揮手就補上（不然多人一起開始時慢半拍的人永遠少了第一顆音），過了窗的音丟掉。F 與 τ 都是應用層數字，不是規格 |
| N4 | 相連音的「小間隙」門檻 θ ＝ ticksPerQuarter ÷ `LEGATO_GAP_DIVISOR`（16；480 tpq 時 30 tick）：音符結尾到同一個聲部下一個起音點的間隙 ≤ θ 才算相連音，時鐘停格時它會撐到後繼音放行（見「相連音撐住與停格釋放」）。MuseScore 把相連音符寫成「記譜長度 − 1 tick」（間隙固定 1 tick），真正的最短休止（三十二分休止）≥ 60 tick，θ 落在兩者中間的空檔（曲庫實測 83% 的間隙 ≤ 30 tick）。這是應用層數字，不是規格；用 tick 不用秒，跟速度無關；SMPTE division 沒有 tick 換算，不撐 |
| N5 | 樂譜時鐘的追趕、停格與步長：S 落後最近放行那一拍的起點 L 秒時，在 r 之外再乘上 `1 + CATCHUP_GAIN（16）× L ／ 拍長` 倍前進，最多 `CATCHUP_MAX_SPEED`（6）倍；第一次放行不追趕；S 碰到 B 停格，停格超過閒置門檻（`max(IDLE_MS, 目前拍長 × IDLE_BEATS)`，只擋第一下揮手之前的停格）就把還在響的音全部收掉；每個 tick 的時間步長上限 `MAX_TICK_DT_SEC`（0.1 秒），分頁被節流後恢復時不會一次吐出一大段。都是應用層數字，不是規格 |
| N6 | 速度倍率 r（演奏者的速度是原譜速度的幾倍）的估計：每次真人揮手（放行下一拍，或晚到而算對電腦放行那一拍的回應）取一次樣——上一次真人揮手那一拍的樂譜長度 ÷ 兩次揮手之間真實過的秒數（用上一次揮手那一拍的長度，樂譜自己變速時才對得上時間；中間隔著電腦補位的拍不算進分子，所以漏揮一次是「一拍的長度 ÷ 兩拍的時間」＝慢一半的離群取樣）；在對數域做指數平滑 `r' = r^(1−α)·樣本^α`（`RATE_ALPHA`＝0.35；速度是倍率，快兩倍與慢一半要對稱），樣本落在 `[RATE_MIN, RATE_MAX]`（0.25～4）之外視為停頓、不採樣；比目前估計快或慢超過 `RATE_OUTLIER`（40％）的樣本先暫存，下一個樣本同向且幅度對得上才一起套用（真的變速），對不上（變回正常、方向相反）就丟掉（同一個動作被偵測成兩次、偶爾漏揮）。暫停清掉「上一次揮手」與暫存；電腦放行不取樣；還沒取過樣＝1，重設退回 1。r 決定時鐘的速度、電腦的等待時間與遲到窗的長度；代打與終局沿用最後一次估計。這是應用層的模型與數字，不是規格——規格只保證原譜速度（`tickToSeconds()`） |

樂譜時鐘 S 在放行邊界以內以**速度倍率 r** 前進（N6）：r＝1 就是規格保證的原譜速度（`tickToSeconds()` 算出來的秒數）——還沒取過樣、沒有人被指派、整首自動播放時都是 1。r 只由離散事件更新（每次真人放行一拍取一次樣）；代打與終局沿用最後一次估計，音依樂譜時鐘收，沒有「發聲後各自倒數」的機制，所以手停下來時音只會照估計速度走到放行邊界 B 就停格，超過閒置門檻就收掉，不會被拖長。r 之外另有兩個例外也由離散事件決定：揮手比時鐘早時 S 暫時加速追趕（N5，最多 6 倍，落後量歸零就回到 r）；時鐘停格時相連音撐住、停太久收掉。

已知且刻意保留的行為：揮手比時鐘早（演奏者比目前估計的速度快，例如剛加速、估計還沒跟上）時，拍內的音間隔被壓縮——追趕倍率最多 6 倍、通常不到 0.25 拍——而不是丟掉或擠成同一個 tick；代打走過空拍之後演奏者準時揮手，音比揮手晚一點點（N2）；時鐘停格時相連音的撐住與停格釋放是「等你揮手」才有的行為，整首自動播放完全照編碼；排程跑在主執行緒的 12ms tick，同一個 tick 發的音彼此零誤差，tick 與 tick 之間有主執行緒抖動（SpessaSynth 的 noteOn 沒有時間戳，無法消除）。

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

  ↻ 與播完後的 ▶ 共用 `humanPerformer._resetPlayback()`（跟 `stop()` 同一個重設函式）：樂譜時鐘、拍位、放行邊界、速度倍率與上一次揮手紀錄、追趕與停格計時、每個聲部的游標／揮手紀錄、代打與合併窗紀錄、CC7 都退回剛載入的樣子，代打要等真人重新揮手過才會啟動。任何新增的排程器狀態欄位都要在 `_resetPlayback()` 重設（單元測試有整體快照比對，忘了會直接失敗）；若指派改過（簽章不同）則走完整重新載入。
- **指派持久**：下拉恆列「現場人數」個 ID，不隨鏡頭當下偵測到幾人增減；某 ID 不在場就是收不到新揮手：揮過手的聲部跟著合奏走（代打音量），從未揮過手的聲部維持靜音（見上「揮過手的聲部跟著合奏走」），指派本身留著、不會被清掉。
- **兩軌模型**：電腦輔助軌固定不動（不掛額外 gain，是音量對比的固定基準），跟指派聲部共用同一個樂譜時鐘與放行邊界；指派聲部固定走真人軌，揮過手才發聲，velocity 一律用樂譜原值，不套用手勢公式；真人軌整體的 `humanGain` 開啟時刻意調到比電腦輔助軌大聲（`synth.js` 的 `HUMAN_EMPHASIS_GAIN`），凸顯使用者控制的聲部；共用拍位只在有效揮手（真實或代打）那一刻才前進一拍；代打放行的拍，揮過手的聲部的 CC7 校正到約等於電腦輔助軌的音量基準（`AUTOPILOT_VOLUME_CC`——代打當下是電腦在演奏，音量跟電腦輔助的聲部一致，真正的凸顯完全交給真人揮手時的 `HUMAN_EMPHASIS_GAIN`），只調音量、不動 velocity；樂譜時鐘以揮手間隔估計的速度倍率 r 前進（見「拍子從哪裡來」的 N6），不做任何音色覆蓋、不做持續的 CC11 表情覆蓋。
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
