// ============================================================
//  count-check.mjs — 單一檔案的音符數量對照（手動執行，純 Node，不載音色庫、不出聲）
//
//  三層對照，數字對不上就是哪一層出了問題：
//    1. 原檔：官方 spessasynth_core（devDependency）解析出的 note-on／結尾事件（note-off 或 velocity 0 的 note-on）個數，
//       每條軌各一列。這一層跟我們的 parser 完全無關。
//    2. parseMidi()：notes 總數與每個 part 的音數；同 part 同音高同 startTick 的重複音、零長度的音。
//    3. 排程器：指派某個 part 給演奏者 1 之後，driver segment 數（＝你要按的次數）、driver 音與 follower 音的分配、前奏，
//       以及「電腦音遲到」（window.__stats()）個數的上限——follower 裡跟 driver 同 tick 的音是在按鍵呼叫內發聲的，不計入，
//       其餘由 tick 放出；早按時落在兩個 tick 之間、被按鍵呼叫順手放出的音也不計入，所以實測個數會略少於這個上限。
//
//  用法：node test/tools/count-check.mjs <檔案.mid | 曲庫 ID> [指派的 part 名稱，例如 "小提琴 1"]
//        曲庫 ID（UUID）會從遠端曲庫下載；part 名稱可只寫開頭。對不上時 exit code 為 1。
// ============================================================

import { readFileSync } from 'node:fs';
import { BasicMIDI } from 'spessasynth_core';
import { parseMidi } from '../../src/midi/midiParser.js';
import { Scheduler } from '../../src/midi/scheduler.js';

const MIDI_LIBRARY_API = 'https://imuse.ncnu.edu.tw/Midi-library/api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
const [source, assignName] = process.argv.slice(2);
if (!source) { console.log('用法：node test/tools/count-check.mjs <檔案.mid | 曲庫 ID> [指派的 part 名稱]'); return 1; }

let ab;
if (UUID.test(source)) {
  const res = await fetch(`${MIDI_LIBRARY_API}/midis/${encodeURIComponent(source)}/download`);
  if (!res.ok) { console.log(`下載失敗：HTTP ${res.status}`); return 1; }
  ab = await res.arrayBuffer();
} else {
  const buf = readFileSync(source);
  ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); // Buffer 可能是共用池的一段，只取自己那一段
}

let ok = true;
const check = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) ok = false; };

// ── 1. 原檔 ──
const midi = BasicMIDI.fromArrayBuffer(ab);
let noteOn = 0, noteOnVel0 = 0, noteOff = 0;
const perTrack = [];
midi.tracks.forEach((track, index) => {
  let on = 0, on0 = 0, off = 0;
  const channels = new Set();
  for (const e of track.events) {
    const type = e.statusByte & 0xf0;
    if (type === 0x90) { channels.add(e.statusByte & 0x0f); if ((e.data?.[1] ?? 0) > 0) on++; else on0++; }
    else if (type === 0x80) { channels.add(e.statusByte & 0x0f); off++; }
  }
  noteOn += on; noteOnVel0 += on0; noteOff += off;
  if (on || on0 || off) perTrack.push({ 軌: index, channel: [...channels].join(','), noteOn: on, 'noteOn(vel0)': on0, noteOff: off });
});
console.log(`\n── 原檔：format ${midi.format}、${midi.tracks.length} 條軌、timeDivision ${midi.timeDivision}、官方算出的長度 ${midi.duration.toFixed(2)}s ──`);
console.table(perTrack);
console.log(`合計：note-on（vel>0）${noteOn}、note-on（vel=0，等於 note-off）${noteOnVel0}、note-off ${noteOff}`);
check(noteOn === noteOnVel0 + noteOff, `note-on ${noteOn} 與結尾事件 ${noteOnVel0 + noteOff} 一一對應`);

// ── 2. 我們的 parser ──
const score = parseMidi(ab);
console.log(`\n── parseMidi：notes ${score.notes.length}、segments ${score.segments.length}、警告 ${score.warnings.length} 則 ──`);
if (score.warnings.length) console.log(score.warnings.join('\n'));
const perPart = new Map();
for (const n of score.notes) perPart.set(n.partId, (perPart.get(n.partId) || 0) + 1);
console.table(score.parts.map((p) => ({ id: p.id, 名稱: p.name, staff數: p.staves?.length, notes: perPart.get(p.id) || 0 })));
check(score.notes.length === noteOn, `parser notes ${score.notes.length} ＝ 原檔 note-on ${noteOn}`);
const keyCount = new Map();
for (const n of score.notes) { const k = `${n.partId}/${n.midiNote}/${n.startTick}`; keyCount.set(k, (keyCount.get(k) || 0) + 1); }
const dup = [...keyCount.values()].filter((v) => v > 1).length, zero = score.notes.filter((n) => n.endTick <= n.startTick).length;
console.log(`同 part 同音高同 startTick 的重複音 ${dup} 組；零長度的音 ${zero} 顆（兩者都不是錯，只是這類音會讓上面的數字不容易一眼對上）`);

// ── 3. 排程器 ──
if (!assignName) { console.log('\n沒有指定 part 名稱，略過排程器分配（用法的第二個參數）'); return ok ? 0 : 1; }
const part = score.parts.find((p) => p.name === assignName) || score.parts.find((p) => p.name.startsWith(assignName));
if (!part) { console.log(`\n找不到 part「${assignName}」，可用的有：${score.parts.map((p) => p.name).join('、')}`); return 1; }
const stub = { controllerChange() {}, programChange() {}, noteOn() {}, noteOff() {} };
const hp = new Scheduler();
hp.setSynths(stub, stub);
hp.load(score, new Map([[part.id, 1]]));
const driverTicks = new Set(hp._driverSegs.map((s) => s.ticks));
const driverNotes = hp._driverSegs.reduce((a, s) => a + s.items.length, 0);
const sameTick = hp._followers.filter((f) => driverTicks.has(f.note.startTick)).length;
const preludeCount = hp._sliceFirst[1] - hp._sliceFirst[0];
console.log(`\n── 排程器：指派「${part.name}」(${part.id}) 給演奏者 1 ──`);
console.log(`driver segment ${hp._driverSegs.length} 個（你要按的次數）、driver 音 ${driverNotes} 顆、follower 音 ${hp._followers.length} 顆`);
check(driverNotes + hp._followers.length === hp._totalNotes && hp._totalNotes === score.notes.length, `driver ${driverNotes} ＋ follower ${hp._followers.length} ＝ 排程器總音數 ${hp._totalNotes} ＝ parser notes ${score.notes.length}（沒有音因為排不進 channel 被丟掉）`);
console.log(`前奏：${hp._hasPrelude ? `有（前奏 follower ${preludeCount} 顆，你的第一個起音在 ${score.midiTicksToSeconds(hp._driverSegs[0].ticks).toFixed(2)}s，前奏播完之前按鍵不放行）` : '沒有'}`);
console.log(`follower 與 driver 同 tick（按鍵呼叫內發聲，不計入「電腦音遲到」）${sameTick} 顆；由 tick 放出的電腦音最多 ${hp._followers.length - sameTick} 顆（__stats() 的「電腦音遲到ms」count 的上限）`);

return ok ? 0 : 1;
}

process.exitCode = await main();
