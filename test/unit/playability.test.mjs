// ============================================================
//  playability.test.mjs — 「解析後的檔案能不能給合成器播放」的驗證（純 Node，離線）
//
//  「可以播放」的定義，每一條都有測試：
//    1. parseMidi() 不丟例外，至少 1 個 part。
//    2. 每個 staff 都分到輸出 channel（unplacedStaffIds 空）；打擊 staff 只落在 9／25／41／57，旋律 staff 不落在打擊槽。
//    3. 每個 staff 的初始狀態（bank、program、CC7／10／91／93）在該 channel 的第一個 noteOn 之前送到合成器。
//    4. 整首自動播放（不指派）跑完：每顆解析出來的音恰好一個 noteOn、一個 noteOff，曲末沒有未釋放的音；值域合法
//       （channel 0～63、音高 0～127、力度 1～127、CC 0～127）。
//    5. 指派播放（腳本化觸發，每個 segment 在樂譜時間按一下，兩位演奏者輪流）跑完同樣沒有卡音，而且指派聲部（真人軌）的音
//       只在 trigger() 呼叫內發聲（tick() 不放起音）。
//  第 6 條（worklet 端的 channel 狀態真的等於送出去的值）要真的瀏覽器才看得到，在 test/browser/smoke-test.mjs。
//
//  合成器是「嚴格的假合成器」：違規時只記下來、不丟例外（排程器對合成器的呼叫包在 try／catch 裡，丟例外會被吞掉），
//  跑完再統一檢查。沒有測試框架，跟其他 test/unit 同一套風格：run()／assert()。
//  用法：node test/unit/playability.test.mjs
// ============================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMidi } from '../../src/midi/midiParser.js';
import { Scheduler, CHANNELS_PER_PORT, DEFAULT_PORTS } from '../../src/midi/scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TICK_MS = 12;
const TOTAL_CHANNELS = CHANNELS_PER_PORT * DEFAULT_PORTS; // 合成器開機補到的 channel 數，跟排程器同一個來源
const DRUM_SLOTS = Array.from({ length: DEFAULT_PORTS }, (_, p) => p * CHANNELS_PER_PORT + 9);
const MIXER = [7, 10, 91, 93];

function run(name, fn) {
  console.log(`\n=== ${name} ===`);
  try { fn(); console.log('✅ 通過'); }
  catch (err) { console.log('❌ 失敗:', err.message); process.exitCode = 1; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ═══════════════════════════════════════════
   嚴格的假合成器
   ═══════════════════════════════════════════ */

// 每個 channel 追蹤：收到的 program／bank／混音 CC、正在響的音（音高 → 個數）。違規一律記進 violations。
function makeStrictSynth(label, violations, getHp) {
  const channels = new Map();
  const ch = (n) => {
    if (!channels.has(n)) channels.set(n, { program: null, msb: null, lsb: null, cc: {}, sounding: new Map(), noteOns: 0, initBeforeFirstOn: null });
    return channels.get(n);
  };
  const bad = (msg) => violations.push(`[${label}] ${msg}`);
  const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  return {
    channels,
    controllerChange(c, cc, v) {
      if (!inRange(c, 0, TOTAL_CHANNELS - 1)) return bad(`controllerChange channel ${c} 超出 0～${TOTAL_CHANNELS - 1}`);
      if (!inRange(cc, 0, 127) || !inRange(v, 0, 127)) return bad(`controllerChange ch${c} CC${cc}=${v} 值域不合法`);
      const s = ch(c);
      if (cc === 0) s.msb = v; else if (cc === 32) s.lsb = v; else s.cc[cc] = v;
    },
    programChange(c, p) {
      if (!inRange(c, 0, TOTAL_CHANNELS - 1)) return bad(`programChange channel ${c} 超出範圍`);
      if (!inRange(p, 0, 127)) return bad(`programChange ch${c} program ${p} 值域不合法`);
      ch(c).program = p;
    },
    noteOn(c, key, vel) {
      if (!inRange(c, 0, TOTAL_CHANNELS - 1)) return bad(`noteOn channel ${c} 超出範圍`);
      if (!inRange(key, 0, 127)) return bad(`noteOn ch${c} 音高 ${key} 值域不合法`);
      if (!inRange(vel, 1, 127)) return bad(`noteOn ch${c} 力度 ${vel} 值域不合法（0 會被合成器當成 note-off）`);
      const s = ch(c);
      // 3. 初始狀態要在第一個 noteOn 之前到齊
      if (s.noteOns === 0) {
        const missing = [s.program === null && 'program', s.msb === null && 'bank MSB', s.lsb === null && 'bank LSB', ...MIXER.filter((n) => s.cc[n] === undefined).map((n) => `CC${n}`)].filter(Boolean);
        if (missing.length) bad(`ch${c} 的第一個 noteOn 之前還沒收到：${missing.join('、')}`);
      }
      s.noteOns++;
      s.sounding.set(key, (s.sounding.get(key) || 0) + 1);
      // 2. 打擊槽只給打擊 staff、打擊 staff 只落在打擊槽
      const staves = [...getHp()._staves.values()].filter((v) => v.channel === c);
      const drumSlot = DRUM_SLOTS.includes(c);
      if (drumSlot && staves.some((v) => !v.percussionKit)) bad(`旋律 staff 落在打擊槽 ch${c}`);
      if (!drumSlot && staves.some((v) => v.percussionKit)) bad(`打擊 staff 落在非打擊槽 ch${c}`);
    },
    noteOff(c, key) {
      const s = ch(c), n = s.sounding.get(key) || 0;
      if (n <= 0) return bad(`ch${c} 音高 ${key} 沒有對應的 noteOn 卻收到 noteOff`);
      if (n === 1) s.sounding.delete(key); else s.sounding.set(key, n - 1);
    },
    hanging() { return [...channels].flatMap(([c, s]) => [...s.sounding].map(([k, n]) => `ch${c} 音高 ${k}×${n}`)); },
    totalNoteOns() { return [...channels.values()].reduce((a, s) => a + s.noteOns, 0); },
  };
}

function setup(score, assignments) {
  const violations = [], clock = { ms: 0 };
  const ctx = { inTrigger: false }; // 腳本化觸發在呼叫 trigger() 前後切換，檢查指派聲部是不是在 trigger() 裡發聲
  let hp;
  const assist = makeStrictSynth('assist', violations, () => hp);
  const human = makeStrictSynth('human', violations, () => hp);
  const wrap = (synth, label) => new Proxy(synth, {
    get: (t, k) => (typeof t[k] === 'function' && ['noteOn', 'noteOff'].includes(k)
      ? (...a) => { if (label === 'human' && k === 'noteOn') checkInTrigger(a[0]); return t[k](...a); }
      : t[k]),
  });
  // 5. 指派聲部（真人軌）的音只在 trigger() 呼叫內發聲：tick() 不該放出任何真人軌的起音
  const checkInTrigger = (channel) => {
    if (ctx.inTrigger) return;
    for (const v of hp._staves.values()) if (v.kind === 'human' && v.channel === channel) violations.push(`指派聲部 ${v.id} 不是在 trigger() 裡發聲`);
  };
  hp = new Scheduler();
  hp.setSynths(wrap(assist, 'assist'), wrap(human, 'human'));
  hp.load(score, new Map(assignments));
  return { hp, assist, human, violations, clock, ctx };
}

// 整首自動播放（沒有指派）：跑到播完（或 10 分鐘上限）。
function autoPlay(score) {
  const env = setup(score, []);
  env.hp.play();
  for (let ms = 0; ms < 600000 && !env.hp.isFinished(); ms += TICK_MS) env.hp.tick(ms);
  return env;
}

// 指派播放：每個 segment 在樂譜時間準時觸發一次（模擬完美演奏者），由被指派的演奏者輪流按，觸發到播完。
// assignments：[partId, 槽位][]。
function assignedPlay(score, assignments) {
  const env = setup(score, assignments);
  const slots = [...new Set(assignments.map(([, slot]) => slot))];
  const segs = env.hp._segments;
  env.hp.play();
  let ms = 0, i = 0;
  env.hp.tick(ms);
  for (; ms < 600000 && !env.hp.isFinished(); ms += TICK_MS) {
    while (i < segs.length && ms >= score.midiTicksToSeconds(segs[i].ticks) * 1000) {
      env.ctx.inTrigger = true;
      env.hp.trigger(slots[i % slots.length], ms);
      env.ctx.inTrigger = false;
      i++;
    }
    env.hp.tick(ms);
  }
  return env;
}

/* ═══════════════════════════════════════════
   手工組的 MuseScore 形狀譜（跟 midi-parser.test.mjs 同一套匯出器佈局）
   ═══════════════════════════════════════════ */

const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const vlq = (n) => { const b = [n & 0x7f]; n >>>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>>= 7; } return b; };
const track = (events) => {
  const body = events.flatMap((e) => [...vlq(e.d), ...e.b]).concat([...vlq(0), 0xff, 0x2f, 0x00]);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
};
const midiFile = (tracks) => new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 1, 0, tracks.length, 0x01, 0xe0, ...tracks.flat()]);
const enc = new TextEncoder();
const nameEv = (s) => { const b = [...enc.encode(s)]; return { d: 0, b: [0xff, 0x03, b.length, ...b] }; };
const portEv = (p) => ({ d: 0, b: [0xff, 0x21, 1, p] });
const tempoEv = { d: 0, b: [0xff, 0x51, 3, 0x07, 0xa1, 0x20] };
const cc = (c, n, v) => ({ d: 0, b: [0xb0 | c, n, v] });
const initBlock = (c, program, { vol = 100, pan = 64, rev = 0, cho = 0 } = {}) =>
  [cc(c, 121, 0), { d: 0, b: [0xc0 | c, program] }, cc(c, 7, vol), cc(c, 10, pan), cc(c, 91, rev), cc(c, 93, cho)];
const notes = (c, pitches, { start = 0, dur = 479 } = {}) => pitches.flatMap((p, i) => [
  { d: i === 0 ? start : 1, b: [0x90 | c, p, 90 + i] }, { d: dur, b: [0x80 | c, p, 0] }]); // 每顆 479 tick＋間隙 1 tick（MuseScore 的相連音）

// 鋼琴兩行譜（上行譜有初始化區塊）＋弓弦三個 channel（normal 與 pizzicato 有音）＋port 1 的打擊（channel 9）。
function museScoreShapedScore() {
  const bytes = midiFile([
    track([nameEv('Piano'), tempoEv, ...initBlock(0, 0, { vol: 90 }), ...notes(0, [72, 74, 76, 77, 79, 81, 83, 84])]),
    track([nameEv('Piano'), ...notes(0, [48, 50, 52, 53, 55, 57, 59, 60])]),
    track([nameEv('Violin'), ...initBlock(1, 40), ...initBlock(2, 45, { vol: 80, pan: 30, rev: 20, cho: 10 }), ...initBlock(3, 44),
      ...notes(1, [67, 69, 71, 72]), ...notes(2, [60, 62, 64, 65], { start: 2400 })]),
    track([nameEv('Drumset'), portEv(1), ...initBlock(9, 0), ...notes(9, [36, 38, 36, 38, 36, 38, 36, 38], { dur: 100 })]),
  ]);
  return parseMidi(bytes);
}

const canonScore = (() => {
  const buf = readFileSync(join(__dirname, '../../src/assets/canon-violin-cello.mid'));
  return parseMidi(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
})();

const noteCountOf = (score) => score.notes.length;

/* ═══════════════════════════════════════════
   1～4：整首自動播放
   ═══════════════════════════════════════════ */

for (const [label, score] of [['canon 樣本', canonScore], ['MuseScore 形狀的手工譜（鋼琴兩行譜＋弓弦含 pizzicato＋port 1 打擊）', museScoreShapedScore()]]) {
  run(`${label}：整首自動播放可以播放（初始狀態先於 noteOn、每顆音一個 noteOn 一個 noteOff、沒有卡音、值域合法）`, () => {
    assert(score.parts.length >= 1, `至少 1 個 part，實際 ${score.parts.length}`);
    const { hp, assist, human, violations } = autoPlay(score);
    assert(hp.unplacedStaffIds.length === 0, `不該有排不進輸出 channel 的 staff：${hp.unplacedStaffIds}`);
    assert(hp.isFinished(), '自動播放應該播完');
    assert(violations.length === 0, `嚴格合成器記到違規：\n    ${violations.slice(0, 6).join('\n    ')}`);
    assert(assist.totalNoteOns() === noteCountOf(score), `每顆解析出來的音恰好一個 noteOn：預期 ${noteCountOf(score)}，實際 ${assist.totalNoteOns()}`);
    assert(human.totalNoteOns() === 0, '沒有指派時真人軌不該有任何聲音');
    assert(assist.hanging().length === 0, `曲末不該有未釋放的音：${assist.hanging().slice(0, 5)}`);
  });
}

run('MuseScore 形狀的手工譜：part／staff 結構與輸出 channel 配置（鋼琴 2 staff、弓弦 2 staff、打擊在槽 9）', () => {
  const score = museScoreShapedScore();
  assert(score.parts.map((p) => p.name).join() === '大鋼琴,小提琴,標準鼓組', `part 應為「大鋼琴、小提琴、標準鼓組」，實際 ${score.parts.map((p) => p.name)}`);
  assert(score.parts.map((p) => p.staves.length).join() === '2,2,1', `staff 數應為 2、2、1，實際 ${score.parts.map((p) => p.staves.length)}`);
  const { hp } = setup(score, []);
  const drum = [...hp._staves.values()].find((v) => v.percussionKit);
  assert(drum && drum.channel === 9, `打擊 staff 的輸出 channel 應為 9（它在檔案裡是 port 1 的絕對 channel 25，但輸出槽另外分配），實際 ${drum?.channel}`);
  const melodic = [...hp._staves.values()].filter((v) => !v.percussionKit).map((v) => v.channel);
  assert(melodic.length === 4 && new Set(melodic).size === 4 && melodic.every((c) => c % 16 !== 9), `4 個旋律 staff 各一個非打擊槽的 channel，實際 ${melodic}`);
  const piano = [...hp._staves.values()].find((v) => v.baseVolume === 90);
  assert(piano, '鋼琴 staff 的原音量應取自初始化區塊的 CC7（90）');
});

/* ═══════════════════════════════════════════
   5：指派播放（腳本化觸發）
   ═══════════════════════════════════════════ */

run('MuseScore 形狀的手工譜：兩位演奏者（鋼琴、弓弦）輪流在每個 segment 準時觸發，跑到播完：沒有卡音、指派聲部只在 trigger() 裡發聲', () => {
  const score = museScoreShapedScore();
  const piano = score.parts.find((p) => p.name === '大鋼琴').id, violin = score.parts.find((p) => p.name === '小提琴').id;
  const { hp, assist, human, violations } = assignedPlay(score, [[piano, 1], [violin, 2]]);
  assert(hp.isFinished(), '指派播放應該播完');
  assert(violations.length === 0, `嚴格合成器記到違規：\n    ${violations.slice(0, 6).join('\n    ')}`);
  assert(assist.hanging().length === 0 && human.hanging().length === 0, `曲末不該有未釋放的音：${[...assist.hanging(), ...human.hanging()].slice(0, 5)}`);
  const total = assist.totalNoteOns() + human.totalNoteOns();
  assert(total === noteCountOf(score), `每顆音恰好發聲一次（鋼琴 2 個 staff 都要出聲）：預期 ${noteCountOf(score)}，實際 ${total}`);
  assert(human.totalNoteOns() === score.parts.filter((p) => p.id === piano || p.id === violin).reduce((a, p) => a + p.noteCount, 0), '指派聲部（鋼琴 2 個 staff＋弓弦 2 個 staff）的音都走真人軌');
});

run('canon 樣本：兩位演奏者輪流在每個 segment 準時觸發，跑到播完：沒有卡音、沒有違規', () => {
  const [violin, cello] = [canonScore.parts.find((p) => p.name === '小提琴'), canonScore.parts.find((p) => p.name === '大提琴')];
  const { hp, assist, human, violations } = assignedPlay(canonScore, [[violin.id, 1], [cello.id, 2]]);
  assert(hp.isFinished(), '指派播放應該播完');
  assert(violations.length === 0, `嚴格合成器記到違規：\n    ${violations.slice(0, 6).join('\n    ')}`);
  assert(assist.hanging().length === 0 && human.hanging().length === 0, '曲末不該有未釋放的音');
  assert(human.totalNoteOns() === violin.noteCount + cello.noteCount, `兩個指派聲部的音都走真人軌：預期 ${violin.noteCount + cello.noteCount}，實際 ${human.totalNoteOns()}`);
});

console.log('\n全部測試跑完。');
