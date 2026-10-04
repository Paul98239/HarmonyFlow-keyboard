// ============================================================
//  mutation-check.mjs — 變異檢查：故意把排程器弄壞，看指定的測試會不會變紅（手動執行，不進 CI，純 Node）
//
//  做法：把 src／測試複製到暫存資料夾，在複製出來的原始檔（預設 scheduler.js，也可以用 target 指定別的檔）
//  套用一個「一行的破壞」，跑測試，檢查「指定的那幾個測試」有沒有失敗。不會動到工作目錄裡的任何檔案。沒有任何
//  指定測試變紅＝這個行為沒有被保護。suites 可以含 'smoke'：用同一支瀏覽器測試（test/browser/smoke-test.mjs）
//  跑被破壞的複本（HF_ROOT），每個要一分多鐘，所以只放確實要靠瀏覽器才抓得到的破壞。
//  破壞用的字串必須在原始碼裡剛好出現一次；原始碼改了找不到就會直接報錯，提醒更新這張表。
//
//  用法：node test/tools/mutation-check.mjs [--only=關鍵字] [--skip-smoke | --only-smoke]
// ============================================================

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGET = 'src/midi/scheduler.js'; // 沒有指定 target 的變異破壞這個檔
const PREVIEW = 'src/midi/previewPlayer.js', PLAYER = 'src/midi/midiPlayer.js', SYNTH = 'src/midi/synth.js', PARSER = 'src/midi/midiParser.js', KEYBOARD = 'src/keyboard.js';
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const SKIP_SMOKE = process.argv.includes('--skip-smoke'); // 只跑單元測試抓得到的變異（快）
const ONLY_SMOKE = process.argv.includes('--only-smoke'); // 只跑要靠瀏覽器測試抓的變異（慢）

// edits：[原始碼裡的那一行（或片段）, 換成什麼]。expect：應該變紅的測試名稱關鍵字（任何一個變紅就算抓到）；
// suites：要跑哪些測試檔（預設只跑排程器的單元測試）；target：破壞哪個檔（預設排程器）。
const MUTATIONS = [
  // ── 排程器：總譜觸發（一次觸發放行全曲的下一個 segment）、tick 播放頭、收音 ──
  { name: 'FIFO 改回以音高為鍵（同音高的新音蓋掉舊音）', edits: [['queue.push({ endTick: note.endTick, legatoTo: note.legatoTo });', 'queue.length = 0; queue.push({ endTick: note.endTick, legatoTo: note.legatoTo });']],
    expect: ['同音高重疊（先進先出）', 'canon（大提琴指派', '壓力測試'], suites: ['scheduler', 'oracle'] },
  { name: '一次觸發放行兩個 segment', edits: [['const seg = this._segments[this._segIndex++];\n    this._updatePlaybackRate', 'const seg = this._segments[this._segIndex++]; if (this._segIndex < this._segments.length) this._segIndex++;\n    this._updatePlaybackRate']],
    expect: ['一次觸發放行全曲的下一個 segment', '按得再快也不跳過任何一顆音'] },
  { name: 'parser：相同 startTick 的音不併成同一個 segment', target: PARSER, suites: ['midi-parser', 'scheduler'], edits: [['if (last && last.ticks === note.startTick) last.notes.push(note);', 'if (false) last.notes.push(note);']],
    expect: ['segments：相同 startTick', '和弦與多聲部同一個 tick'] },
  { name: '電腦輔助的音晚一個排程 tick 才發聲（上下沒有對齊）', edits: [
    ['try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity); } catch (err) {}', "try { if (staff.kind === 'assist') (this._deferred ??= []).push(() => this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity)); else this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity); } catch (err) {}"],
    ['    this._advancePlayhead(dt);\n    if (this._isAuto())', '    for (const f of this._deferred ?? []) f();\n    this._deferred = [];\n    this._advancePlayhead(dt);\n    if (this._isAuto())']],
    expect: ['同刻發聲', 'L3 同步', 'canon（大提琴指派'], suites: ['scheduler', 'oracle'] },
  { name: '沒在播放也放行（trigger 不檢查 playing）', edits: [['if (!this._playing || !this._assignedSlots.has(slot) ||', 'if (!this._assignedSlots.has(slot) ||']],
    expect: ['沒有放行的情況'] },
  { name: '沒有指派聲部的槽位也能推進全曲（不檢查資格）', edits: [['if (!this._playing || !this._assignedSlots.has(slot) ||', 'if (!this._playing ||']],
    expect: ['沒有放行的情況'] },
  { name: '播放頭可以越過下一個 segment（拿掉停格上限）', edits: [['const cap = !auto && next ? next.ticks : Infinity;', 'const cap = Infinity;']],
    expect: ['最多走到下一個 segment 就停格', '壓力測試'] },
  { name: '有指派時 tick() 也自己放出起音', edits: [['    if (this._isAuto()) this._emitDueSegments();', '    this._emitDueSegments();']],
    expect: ['沒有人觸發就不放出任何起音', '壓力測試'] },
  { name: '還沒有人觸發播放頭就開始走', edits: [['    if (!auto && !this._started) return;', '    void this._started;']],
    expect: ['沒有人觸發就不放出任何起音'] },
  { name: 'playbackRate 不估速（永遠 1×）', edits: [['this.playbackRate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, scoreSec / realSec));', 'this.playbackRate = 1;']],
    expect: ['playbackRate 取自最近兩次觸發的間隔', '音長在 tick 軸上隨 playbackRate 縮放'] },
  { name: 'playbackRate 不夾範圍', edits: [['this.playbackRate = Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, scoreSec / realSec));', 'this.playbackRate = scoreSec / realSec;']],
    expect: ['playbackRate 取自最近兩次觸發的間隔'] },
  { name: '停手超過閒置門檻之後的間隔也拿來估速度', edits: [['if (!prev || this._stallSec > IDLE_MS / 1000) return;', 'if (!prev) return;']],
    expect: ['你停手超過閒置門檻之後再按'] },
  { name: '恢復播放時不清上一次觸發（把暫停當成按鍵間隔）', edits: [['    this._lastTickMs = null;\n    this._lastTrigger = null;\n  }\n\n  // 暫停', '    this._lastTickMs = null;\n  }\n\n  // 暫停']],
    expect: ['暫停會收掉所有還在響的音'] },
  { name: '放行 segment 時先開後收（拿掉開始前的收音）', edits: [['    this._ticks = Math.max(this._ticks, seg.ticks);\n    this._closeDueNotes(seg.ticks);\n    for (const', '    this._ticks = Math.max(this._ticks, seg.ticks);\n    for (const']],
    expect: ['相連音在播放頭停格等你時撐住', '相連音遇到同音高重複', '整首自動播放：每顆音照編碼收'] },
  { name: '零長度的音不在同一次呼叫內收（拿掉放行後的收音）', edits: [['      this._pushSounding(staff, note);\n    }\n    this._closeDueNotes(seg.ticks);', '      this._pushSounding(staff, note);\n    }']],
    expect: ['零長度的音'] },
  { name: '拿掉相連音撐住（停格等你時照編碼收音）', edits: [['return !!successor && successor.startTick > this._lastSegTicks;', 'return false;']],
    expect: ['相連音在播放頭停格等你時撐住', '相連音撐住同樣適用電腦輔助聲部'] },
  { name: '整首自動播放也撐相連音', edits: [['    if (this._isAuto()) return false;\n    const successor', '    const successor']],
    expect: ['整首自動播放：每顆音照編碼收'] },
  { name: '拿掉停格釋放（停格太久也不收還在響的音）', edits: [['if (this._stallSec > IDLE_MS / 1000) this._noteOffAll();', '/* 變異：沒有停格釋放 */']],
    expect: ['停格超過閒置門檻', '相連音撐住也會被閒置收音收掉', '壓力測試'] },
  { name: '拿掉每個 tick 的 dt 上限', edits: [['Math.min(MAX_TICK_DT_SEC, (nowMs - this._lastTickMs) / 1000)', '(nowMs - this._lastTickMs) / 1000']],
    expect: ['每個 tick 的時間步長上限'] },
  { name: '重設不清 segment 游標（重播從上次的位置接著放行）', edits: [['    this._segIndex = 0;\n    this._ticks = 0;', '    this._ticks = 0;']],
    expect: ['重設把排程器退回', 'restart() 之後要重新觸發才會發聲'] },
  { name: '重設不清播放頭', edits: [['    this._ticks = 0;\n    this._lastSegTicks = -1;', '    this._lastSegTicks = -1;']],
    expect: ['重設把排程器退回'] },
  { name: '收音時不送 noteOff（暫停與停格釋放只清紀錄）', edits: [['for (let i = 0; i < queue.length; i++) {', 'for (let i = 0; i < 0; i++) {']],
    expect: ['暫停會收掉所有還在響的音', '壓力測試'] },
  { name: '進度不夾在總長以內', edits: [['return total > 0 ? Math.min(this._ticks, total) : this._ticks;', 'return this._ticks;']],
    expect: ['放行完最後一個 segment 之後'] },
  { name: '還有音在響也算播完', edits: [['      if (staff.sounding.size > 0) return false;\n', '']],
    expect: ['放行完最後一個 segment 之後', 'canon（大提琴指派'] },
  { name: '排不進 channel 的 staff 的音也留在 segment 裡（整個 segment 都排不進也收）', edits: [['      if (items.length) this._segments.push({ ticks: seg.ticks, items });', '      this._segments.push({ ticks: seg.ticks, items });']],
    expect: ['排不進 channel 的 staff 的音不進 segment'] },
  { name: '所有音一律送 velocity 0 的 noteOn', edits: [['try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, note.velocity); } catch (err) {}', 'try { this._synthOf(staff)?.noteOn(staff.channel, note.midiNote, 0); } catch (err) {}']],
    expect: ['canon（大提琴指派', '壓力測試', '不送 velocity 0 的 noteOn'], suites: ['scheduler', 'oracle'] },
  { name: 'portsNeeded 永遠只回預設 port 數（歌曲需要更多也不補）', edits: [['return Math.max(DEFAULT_PORTS, ...pools.map', 'return DEFAULT_PORTS || Math.max(DEFAULT_PORTS, ...pools.map']],
    expect: ['portsNeeded：', 'port 數變多之後'] },
  // ── parser：tick ↔ 秒的反函數、program 查詢、segments ──
  { name: 'parser：secondsToMIDITicks 忘了加區段的起始 tick', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['return seg.ticks + ((seconds - seg.seconds) * 1e6 * tpq) / seg.microsecondsPerQuarter;', 'return ((seconds - seg.seconds) * 1e6 * tpq) / seg.microsecondsPerQuarter;']],
    expect: ['互為反函數', 'L1 反函數'] },
  { name: 'parser：program 的全曲查詢只用軌內 channel（不同 port 的同號 channel 互相汙染）', target: PARSER, suites: ['midi-parser'], edits: [
    ['      const key = absChannel(track.index, ev.channel);', '      const key = ev.channel;'],
    ['      const global = globalLookup(absChannel(currentTrack, channel), ticks);', '      const global = globalLookup(channel, ticks);']],
    expect: ['沒有初始化區塊的 staff 查 program'] },
  // ── parser：聲部切分（part／staff）與跟官方對齊（單元測試＋差異測試）──
  { name: 'parser：同 tick 的速度衝突改回先出現者生效', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['        last.microsecondsPerQuarter = ev.microsecondsPerQuarter;\n        last.bpm = ev.bpm;\n', '']],
    expect: ['同 tick 的速度衝突'] },
  { name: 'parser：同 tick 的拍號／調號改回先出現者生效', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['if (last && last.ticks === ev.ticks) { out[out.length - 1] = decorate(ev); continue; }', 'if (last && last.ticks === ev.ticks) continue;']],
    expect: ['同 tick 的拍號與調號衝突'] },
  { name: 'parser：音符 channel 不加 port 偏移', target: PARSER, suites: ['midi-parser', 'oracle'], edits: [['    offsets.set(t.index, offsetOfPort.get(port));', '    offsets.set(t.index, 0);']],
    expect: ['port 絕對 channel', '打擊樂器在 port 1'] },
  { name: 'parser：port 偏移用 port 的數值而不是出現順序', target: PARSER, suites: ['midi-parser'], edits: [['    if (!offsetOfPort.has(port)) offsetOfPort.set(port, offsetOfPort.size * 16);', '    if (!offsetOfPort.has(port)) offsetOfPort.set(port, port * 16);']],
    expect: ['port 絕對 channel'] },
  { name: 'parser：沒指定 port 的軌用 0 而不是最小的已指定 port', target: PARSER, suites: ['midi-parser'], edits: [['  const defaultPort = given.length ? Math.min(...given) : 0;', '  const defaultPort = 0;']],
    expect: ['port 絕對 channel'] },
  { name: 'parser：有初始化區塊的 track 也能併入上一組（拿掉 hasInit 條件）', target: PARSER, suites: ['midi-parser'], edits: [['    const canMerge = cur && !s.hasInit\n', '    const canMerge = cur\n']],
    expect: ['兩台鋼琴同名'] },
  { name: 'parser：軌名不同也併入上一組（拿掉軌名條件）', target: PARSER, suites: ['midi-parser'], edits: [['      && (!s.track.name || !cur.first.track.name || s.track.name === cur.first.track.name)\n', '']],
    expect: ['舊檔（沒有初始化區塊'] },
  { name: 'parser：用了別的 channel 也併入上一組（拿掉 channel 子集條件）', target: PARSER, suites: ['midi-parser'], edits: [['      && [...s.noteChannels].every((ch) => cur.knownChannels.has(ch));', ';']],
    expect: ['用的是這組沒有的 channel'] },
  { name: 'parser：單獨的 Program Change 也算初始化區塊（下行譜變成新樂器）', target: PARSER, suites: ['midi-parser'], edits: [["    if (ev.type === 'programChange') {\n      init.program = ev.data1;\n", "    if (ev.type === 'programChange') {\n      init.program = ev.data1;\n      hasInit = true;\n"]],
    expect: ['〈蝸牛與黃鸝鳥〉的結構'] },
  { name: 'parser：下行譜不沿用首軌的初始化', target: PARSER, suites: ['midi-parser'], edits: [['      const fromInit = group.first.initByChannel.get(channel) || null;', '      const fromInit = summary.initByChannel.get(channel) || null;']],
    expect: ['鋼琴兩行譜'] },
  { name: 'parser：有初始化區塊的 staff 不用 tick 0 的 program', target: PARSER, suites: ['midi-parser'], edits: [['      const program = fromInit?.program ?? st.program;', '      const program = st.program;']],
    expect: ['就算在第一顆音之前出現也被忽略'] },
  { name: 'parser：bank 預設不分打擊 channel（一律 121）', target: PARSER, suites: ['midi-parser'], edits: [['      const defaultMsb = vk.channel % 16 === DRUM_CHANNEL ? 120 : 121;', '      const defaultMsb = 121;']],
    expect: ['沒有初始化區塊的 staff', '打擊樂器在 port 1'] },
  { name: 'parser：同音高重疊不警告', target: PARSER, suites: ['midi-parser'], edits: [['      if (st.overlaps) {', '      if (false) {']],
    expect: ['同一個 staff 內同音高重疊'] },
  { name: 'parser：同名 part 不加序號', target: PARSER, suites: ['midi-parser'], edits: [['    if (sameBase(i) === 1) { part.name = bases[i]; return; }', '    if (true) { part.name = bases[i]; return; }']],
    expect: ['兩個小提琴 Part'] },
  { name: 'parser：part 名稱取第一個 staff（不是音符最多的）', target: PARSER, suites: ['midi-parser'], edits: [['    const main = [...part.staves].sort((a, b) => b.noteCount - a.noteCount || a.channel - b.channel)[0];', '    const main = part.staves[0];']],
    expect: ['part 名稱取音符最多的 staff'] },
  // ── 可播放性（嚴格假合成器：初始狀態先於 noteOn、打擊槽、值域、成對、沒有卡音）──
  { name: '可播放性：初始化不送 program（noteOn 之前缺 program）', suites: ['playability'], edits: [['      synth.programChange(channel, staff.program || 0);\n', '']],
    expect: ['整首自動播放可以播放'] },
  { name: '可播放性：打擊 staff 配到旋律 channel', suites: ['playability'], edits: [['    if (s.percussionKit) {\n      if (!kitChannel.has', '    if (false) {\n      if (!kitChannel.has']],
    expect: ['輸出 channel 配置', '整首自動播放可以播放'] },
  { name: '可播放性：收音時不送 noteOff（曲末卡音，嚴格合成器也要抓到）', suites: ['playability'], edits: [['for (let i = 0; i < queue.length; i++) {', 'for (let i = 0; i < 0; i++) {'], ['          try { synth?.noteOff(staff.channel, pitch); } catch (err) {}\n          queue.shift();', '          queue.shift();']],
    expect: ['整首自動播放可以播放', '兩位演奏者'] },
  // ── staff 化（排程器以 staff 為單位）──
  { name: 'staff 化：同一個 part 的 staff 用 partId 當 key（互相覆蓋）', edits: [['staves.set(spec.id, makeStaff(spec, assignments.get(spec.partId), notesByStaff.get(spec.id) || [], \'human\', channel));', 'staves.set(spec.partId, makeStaff(spec, assignments.get(spec.partId), notesByStaff.get(spec.id) || [], \'human\', channel));']],
    expect: ['staff 化：一個 part 兩個 staff'] },
  { name: 'staff 化：音符不依 staffId 分組（全按 partId）', edits: [['const staffKeyOf = (note) => note.staffId ?? note.partId;', 'const staffKeyOf = (note) => note.partId;']],
    expect: ['staff 化：一個 part 兩個 staff'] },
  { name: 'staff 化：不同鼓組全擠在第一個打擊槽', edits: [['kitChannel.set(s.program, drumChannels[kitChannel.size]);', 'kitChannel.set(s.program, drumChannels[0]);']],
    expect: ['打擊 staff：依鼓組 program 分配'] },
  { name: 'staff 化：旋律 staff 可以落在打擊槽', edits: [['if (ch % CHANNELS_PER_PORT !== drumChannel) out.push(ch);', 'out.push(ch);']],
    expect: ['打擊 staff：依鼓組 program 分配'] },
  { name: 'staff 化：輸出 channel 用完的 staff 不回報', edits: [['    else unplaced.push(s.id);\n  }\n  return { byStaffId, unplaced };', '  }\n  return { byStaffId, unplaced };']],
    expect: ['輸出 channel 用完'] },
  { name: 'staff 化：初始化不送 CC10／91／93', edits: [['      synth.controllerChange(channel, 10, init?.pan ?? GM_DEFAULT_PAN);\n      synth.controllerChange(channel, 91, init?.reverb ?? GM_DEFAULT_REVERB);\n      synth.controllerChange(channel, 93, init?.chorus ?? GM_DEFAULT_CHORUS);\n', '']],
    expect: ['staff 初始化'] },
  { name: 'staff 化：初始化不送 CC7（原音量）', edits: [['      synth.controllerChange(channel, 7, staff.baseVolume);\n', '']],
    expect: ['staff 初始化', 'baseVolume'] },
  // ── 試聽：PreviewPlayer（單元測試）──
  { name: '試聽不關掉官方的循環播放（loopCount 留著預設）', target: PREVIEW, suites: ['preview-player'], edits: [['seq.loopCount = 0; // 官方預設循環播放（-1），試聽播完就該停', '/* 變異：沒有關循環 */']],
    expect: ['loopCount 明確設成 0'] },
  { name: '試聽不比對 songChange 的檔名（舊載入的事件也算數）', target: PREVIEW, suites: ['preview-player'], edits: [['(song) => { if (song?.fileName === name) settle(); }', '() => { settle(); }']],
    expect: ['別次載入晚到的 songChange', '載入中又 start()'] },
  { name: '試聽載入沒有逾時（長度 0 的 MIDI 會永遠卡住）', target: PREVIEW, suites: ['preview-player'], edits: [["timer = setTimeout(() => settle(fail('timeout', '官方播放器沒有回應')), this._timeoutMs);", '/* 變異：沒有逾時 */']],
    expect: ['逾時'] },
  { name: '停止試聽不中斷還在等的載入', target: PREVIEW, suites: ['preview-player'], edits: [["this._abort?.(fail('aborted', '試聽被中斷'));", '/* 變異：不中斷 */']],
    expect: ['載入中 stop()', '載入中又 start()'] },
  { name: '載入結束後不移除官方事件的監聽（累積）', target: PREVIEW, suites: ['preview-player'], edits: [["seq.eventHandler.removeEvent('songChange', EVENT_ID);", '/* 變異：不移除 */']],
    expect: ['監聽都已移除'] },
  { name: '播完後續播不從頭（直接 play）', target: PREVIEW, suites: ['preview-player'], edits: [['if (this._seq.isFinished) this.restart();\n    else this._seq.play();', 'this._seq.play();']],
    expect: ['播完（官方 isFinished）之後 resume()'] },
  { name: '暫停不呼叫官方的 pause（試聽停不下來）', target: PREVIEW, suites: ['preview-player'], edits: [['pause() { if (this._active) this._seq.pause(); }', 'pause() { /* 變異：不暫停 */ }']],
    expect: ['pause()／resume() 交給官方'] },
  { name: '解析失敗不丟錯（當成載入成功）', target: PREVIEW, suites: ['preview-player'], edits: [["(err) => settle(fail('parse', err?.message || '官方解析器拒絕這首 MIDI'))", '() => settle()']],
    expect: ['官方解析器拒絕（midiError）'] },
  { name: '開始新的試聽前不先結束上一次', target: PREVIEW, suites: ['preview-player'], edits: [['this.stop(); // 上一次試聽（包含還在等的載入）先結束', '/* 變異：不先 stop */']],
    expect: ['載入中又 start()'] },
  // ── 鍵盤觸發（瀏覽器測試）──
  { name: '鍵盤：不擋瀏覽器預設行為（下拉被字母鍵 type-ahead 跳選項）', target: KEYBOARD, suites: ['smoke'], edits: [['    e.preventDefault();\n', '']],
    expect: ['焦點在下拉：type-ahead 被擋掉'] },
  { name: '鍵盤：按住不放的自動重複也算觸發', target: KEYBOARD, suites: ['smoke'], edits: [['if (e.repeat) return;', 'if (false) return;']],
    expect: ['按住不放的自動重複只算一次'] },
  { name: '鍵盤：在搜尋欄打字也觸發', target: KEYBOARD, suites: ['smoke'], edits: [['if (isTyping(document.activeElement)) return;', 'if (false) return;']],
    expect: ['焦點在搜尋欄'] },
  // ── 試聽：播放列與引擎接線（瀏覽器測試，每個一分多鐘）──
  { name: '換來源時不把播放列切回演奏（試聽 mode 殘留）', target: PLAYER, suites: ['smoke'], edits: [["playerStore.set({ mode: 'perform', transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });", "playerStore.set({ transport: 'idle', notice: null, started: false, finished: false, previewDuration: 0 });"]],
    expect: ['換歌', '按鈕狀態'] },
  { name: '試聽播完 uiTick 不偵測（永遠停在「播放中」）', target: PLAYER, suites: ['smoke'], edits: [['!playerStore.state.finished && synth.isPreviewFinished()', 'false']],
    expect: ['試聽播完'] },
  { name: '演奏播放中 ♪ 也能按', target: PLAYER, suites: ['smoke'], edits: [['preview: inPreview, // 演奏播放中 ♪ 灰；試聽播放中 ♪ 是「結束試聽」，可按', 'preview: true,']],
    expect: ['演奏播放中 ♪ 是灰的', '64 種狀態組合'] },
  { name: '♪ 的 action 不對狀態表（灰的時候被呼叫也照做）', target: PLAYER, suites: ['smoke'], edits: [["'preview': whenAllowed('preview', () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview())),", "'preview': () => (playerStore.state.mode === 'preview' ? leavePreview() : enterPreview()),"]],
    expect: ['64 種狀態組合'] },
  { name: '清場不停掉試聽（換歌／離開試聽之後官方還在播）', target: SYNTH, suites: ['smoke'], edits: [['  previewPlayer?.stop();\n  isSongLoaded = false;', '  isSongLoaded = false;']],
    expect: ['離開試聽：官方 Sequencer 已停', '換歌'] },
  { name: '離開試聽不清場（只切畫面）', target: PLAYER, suites: ['smoke'], edits: [['function leavePreview() {\n  synth.flushPreviousSong();\n', 'function leavePreview() {\n']],
    expect: ['離開試聽：官方 Sequencer 已停'] },
  { name: '進入試聽不結束演奏（排程器繼續跑）', target: SYNTH, suites: ['smoke'], edits: [["  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');\n  flushPreviousSong();\n", "  if (!SequencerClass) throw engineError('音源引擎缺少 Sequencer');\n"]],
    expect: ['進入試聽＝演奏進度歸零'] },
  { name: 'worklet 回讀：初始化的 CC7 沒送到 worklet（只剩 program）', suites: ['smoke'], edits: [['      synth.controllerChange(channel, 7, staff.baseVolume);\n', '']],
    expect: ['worklet 在'] },
  { name: '歌曲需要更多 port 時不補 channel（load 不呼叫 ensurePorts）', target: SYNTH, suites: ['smoke'], edits: [['  ensurePorts(portsNeeded(score, assignments));', '  void portsNeeded;']],
    expect: ['62 個旋律 staff'] },
  { name: '開機補完 channel 後不重設合成器（channel 16 以上預設是打擊）', target: SYNTH, suites: ['smoke'], edits: [['        s.reset();\n      }', '      }']],
    expect: ['開機後'] },
  { name: '試聽失敗時畫面沒有提示', target: PLAYER, suites: ['smoke'], edits: [["      notice: PREVIEW_NOTICE[err.kind] ?? `試聽失敗：${source.name}`,\n", '']],
    expect: ['試聽錯誤路徑'] },
];

// 瀏覽器測試：用真實 repo 的 test/browser/smoke-test.mjs 跑 dir 這份被破壞的複本（HF_ROOT）。變紅的判斷＝它印出的
// 「✗」行（check／expectTransport 的失敗項）；腳本中途丟錯（例如等不到某個狀態逾時）就以「出錯於<最後一個步驟>」當名稱。
function runSmoke(dir) {
  const r = spawnSync(process.execPath, ['--no-warnings', 'test/browser/smoke-test.mjs', '--duration', '300'], { cwd: ROOT, env: { ...process.env, HF_ROOT: dir }, encoding: 'utf8', timeout: 420000 });
  const failed = [];
  let lastStep = '';
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('▶ ')) lastStep = line.slice(2).trim();
    const m = line.match(/^ {2}✗ (.+)$/);
    if (m) failed.push(m[1]);
  }
  // 腳本中途丟錯（例如等不到某個狀態逾時）：就算前面已經有別的「✗」行也要算，否則會被別的失敗遮住
  if (/測試腳本本身出錯/.test(`${r.stdout}${r.stderr}`)) failed.push(`（smoke 測試出錯於「${lastStep}」）`);
  else if (r.status !== 0 && !failed.length) failed.push(`（smoke 測試沒通過，但沒有印出失敗項，最後的步驟「${lastStep}」）`);
  if (r.error || r.status === null) failed.push(`（smoke 沒有正常結束：${r.error?.message || r.signal}）`);
  return failed;
}

function runSuite(dir, suite) {
  if (suite === 'smoke') return runSmoke(dir);
  const r = spawnSync(process.execPath, ['--no-warnings', `test/unit/${suite}.test.mjs`], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  const failed = [];
  let current = '';
  for (const line of (r.stdout || '').split('\n')) {
    if (line.startsWith('=== ')) current = line.replace(/^=== (\[已知差異\] )?/, '').replace(/ ===\s*$/, '');
    else if (line.startsWith('❌')) failed.push(current);
  }
  if (r.error || r.status === null) failed.push(`（${suite} 沒有正常結束：${r.error?.message || r.signal}）`);
  return failed;
}

const tmp = mkdtempSync(join(tmpdir(), 'hf-mutation-'));
try {
  mkdirSync(join(tmp, 'test'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(tmp, 'src'), { recursive: true });   // 連音色庫與姿勢模型一起複製：瀏覽器測試要用
  cpSync(join(ROOT, 'index.html'), join(tmp, 'index.html'));
  cpSync(join(ROOT, 'test/unit'), join(tmp, 'test/unit'), { recursive: true });
  for (const pkg of ['spessasynth_core', 'stb-vorbis']) cpSync(join(ROOT, 'node_modules', pkg), join(tmp, 'node_modules', pkg), { recursive: true });   // oracle 測試要用 spessasynth_core；複製而不是連結，rmSync 才不會碰到真的 node_modules
  // 換行統一成 LF：不管 checkout 時是 CRLF 還是 LF，多行的破壞字串都對得上
  const originals = new Map();
  const originalOf = (target) => {
    if (!originals.has(target)) originals.set(target, readFileSync(join(ROOT, target), 'utf8').replace(/\r\n/g, '\n'));
    return originals.get(target);
  };
  let bad = 0;
  for (const m of MUTATIONS.filter((x) => x.name.includes(ONLY) && !(SKIP_SMOKE && x.suites?.includes('smoke')) && !(ONLY_SMOKE && !x.suites?.includes('smoke')))) {
    const target = m.target || TARGET;
    let mutated = originalOf(target);
    for (const [find, replace] of m.edits) {
      const count = mutated.split(find).length - 1;
      if (count !== 1) { console.error(`✗ ${m.name}：要破壞的字串在原始碼裡出現 ${count} 次（要剛好 1 次），請更新這張表：\n  ${find}`); process.exit(2); }
      mutated = mutated.replace(find, () => replace);
    }
    writeFileSync(join(tmp, target), mutated);
    const failed = (m.suites || ['scheduler']).flatMap((suite) => runSuite(tmp, suite));
    writeFileSync(join(tmp, target), originalOf(target)); // 還原，下一個變異從乾淨的複本開始
    const caught = m.expect.filter((k) => failed.some((f) => f.includes(k)));
    if (!caught.length) bad++;
    console.log(`${caught.length ? '✓' : '✗'} ${m.name}\n    指定的測試變紅：${caught.length ? caught.join('、') : '沒有！'}；全部變紅的測試 ${failed.length} 個${failed.length ? `：${failed.slice(0, 4).map((f) => f.slice(0, 40)).join('、')}${failed.length > 4 ? '…' : ''}` : ''}`);
  }
  console.log(bad ? `\n有 ${bad} 個變異沒有被指定的測試抓到` : '\n每個變異都被指定的測試抓到');
  process.exitCode = bad ? 1 : 0;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
