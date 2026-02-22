/**
 * New Signal Search — Session 7
 * Goals:
 * 1. SOL all-hours RSI/MFI (can we get 5+ trades/day like ETH?)
 * 2. BTC 15m synth strategies (group 3×5m BTC → synth15m)
 * 3. ETH tighter RSI filters (RSI>72,74,75 — higher WR but fewer trades)
 * 4. BTC good-hours body filter (ETH-style panic body >=0.3%)
 * 5. SOL synth15m all-hours (does synth15m improve SOL signals?)
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.cwd(), 'trader.db'), { readonly: true });

function getCandles(symbol, tf, limit) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT ?`
  ).all(symbol, tf, limit).reverse();
}

function calcBB(candles, period, mult) {
  if (candles.length < period) return null;
  const closes = candles.map(c => c.close);
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return { upper: mean + mult * Math.sqrt(variance), lower: mean - mult * Math.sqrt(variance), mid: mean };
}

function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i-1].close;
    if (d > 0) g += d; else l += -d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g/period / (l/period));
}

function calcMFI(candles, period) {
  if (candles.length < period + 1) return null;
  let pos = 0, neg = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const ptp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp > ptp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function calcRSI7(candles) { return calcRSI(candles, 7); }

function walkForward(trades, folds) {
  folds = folds || 5;
  if (trades.length < folds * 2) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  trades.sort((a, b) => a.time - b.time);
  const sz = Math.floor(trades.length / folds);
  const foldWRs = [];
  for (let f = 0; f < folds; f++) {
    const sl = trades.slice(f * sz, (f + 1) * sz);
    foldWRs.push(sl.length < 2 ? 50 : sl.filter(t => t.win).length / sl.length * 100);
  }
  const mean = foldWRs.reduce((a, b) => a + b, 0) / folds;
  const sigma = Math.sqrt(foldWRs.reduce((s, v) => s + (v - mean) ** 2, 0) / folds);
  return { wf: mean, sigma, T: trades.length, foldWRs };
}

function simTrade(candles, idx) {
  const entry = candles[idx].close;
  const isBear = candles[idx].close > candles[idx].open;
  for (let k = idx + 1; k <= Math.min(idx + 3, candles.length - 1); k++) {
    if (isBear && candles[k].close < entry) return true;
    if (!isBear && candles[k].close > entry) return true;
  }
  return false;
}

function streakAt(window) {
  let s = 0;
  for (let j = window.length - 1; j >= 0; j--) {
    const c = window[j];
    if (c.close > c.open) { if (s < 0) break; s++; }
    else if (c.close < c.open) { if (s > 0) break; s--; }
    else break;
  }
  return s;
}

// Make synth15m candles from 5m
function makeSynth15m(candles5m) {
  const synth = [];
  const aligned = candles5m.length - (candles5m.length % 3);
  for (let i = 0; i < aligned; i += 3) {
    const g = candles5m.slice(i, i + 3);
    synth.push({
      open_time: g[0].open_time,
      open: g[0].open,
      high: Math.max(...g.map(c => c.high)),
      low: Math.min(...g.map(c => c.low)),
      close: g[2].close,
      volume: g.reduce((s, c) => s + c.volume, 0),
    });
  }
  return synth;
}

function test5m(coin, filterFn, limit) {
  const candles = getCandles(coin, '5m', limit || 53000);
  if (candles.length < 100) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  const trades = [];
  const ws = 60;
  for (let i = ws + 1; i < candles.length - 3; i++) {
    const w = candles.slice(i - ws, i + 1);
    if (filterFn(w, candles[i])) {
      trades.push({ time: candles[i].open_time, win: simTrade(candles, i) });
    }
  }
  return walkForward(trades);
}

function testSynth15m(coin, filterFn, limit) {
  const candles5m = getCandles(coin, '5m', limit || 53000);
  const synth = makeSynth15m(candles5m);
  if (synth.length < 100) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  const trades = [];
  const ws = 60;
  for (let i = ws + 1; i < synth.length - 3; i++) {
    const w = synth.slice(i - ws, i + 1);
    if (filterFn(w, synth[i])) {
      trades.push({ time: synth[i].open_time, win: simTrade(synth, i) });
    }
  }
  return walkForward(trades);
}

function hour(c) { return new Date(c.open_time).getUTCHours(); }
function dow(c) { return new Date(c.open_time).getUTCDay(); } // 0=Sun

const DAYS = 184; // ~6 months of trading days

function tag(r) {
  if (r.wf >= 76) return '🏆 EXCELLENT';
  if (r.wf >= 72) return '✅ GOOD';
  if (r.wf >= 68) return '⚠️ OK';
  return '❌';
}

function show(label, r) {
  const perDay = (r.T / DAYS).toFixed(1);
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  console.log(`  ${tag(r)} ${label}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.T}(${perDay}/d) [${fStr}]`);
}

const SOL_GH = [0, 12, 13, 20];
const BTC_GH = [1, 12, 13, 16, 20];

console.log('═══════════════════════════════════════════════════════════');
console.log('New Signal Search — Session 7');
console.log('═══════════════════════════════════════════════════════════\n');

// ── Section 1: SOL All-Hours RSI/MFI ────────────────────────────────────────
console.log('── Section 1: SOL All-Hours RSI/MFI (5m) ──');
const solAllHTests = [
  ['SOL ALL_H+RSI>70+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL ALL_H+MFI>80+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 80) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL ALL_H+RSI>75+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL ALL_H+MFI>75+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL GoodH+RSI>70+BB22+s>=1', (w, c) => {
    if (!SOL_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL ALL_H+RSI7>75+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi7 = calcRSI7(w); if (!rsi7 || rsi7 <= 75) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of solAllHTests) {
  show(label, test5m('SOL', fn));
}

// ── Section 2: SOL Synth-15m All-Hours ──────────────────────────────────────
console.log('\n── Section 2: SOL Synth-15m Extended Hours ──');
const solSynth15mTests = [
  ['SOL Synth15m ALL_H+RSI>70+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL Synth15m ALL_H+MFI>80+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 80) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL Synth15m GH+BB22+s>=2 (baseline)', (w, c) => {
    if (!SOL_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 2;
  }],
  ['SOL Synth15m GH+RSI>65+BB22+s>=2', (w, c) => {
    if (!SOL_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 65) return false;
    return Math.abs(streakAt(w)) >= 2;
  }],
  ['SOL Synth15m h=[0,12]+RSI>70+BB22+s>=1', (w, c) => {
    if (![0, 12].includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL Synth15m h=[12,13]+MFI>80+BB22+s>=1', (w, c) => {
    if (![12, 13].includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 80) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of solSynth15mTests) {
  show(label, testSynth15m('SOL', fn));
}

// ── Section 3: BTC Synth-15m New Strategies ─────────────────────────────────
console.log('\n── Section 3: BTC Synth-15m (group 3×5m) ──');
const btcSynth15mTests = [
  ['BTC Synth15m GH+BB22+s>=2 (baseline)', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 2;
  }],
  ['BTC Synth15m GH+RSI>65+BB22+s>=1', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC Synth15m GH+MFI>75+BB22+s>=1', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC Synth15m ALL_H+RSI>70+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC Synth15m ALL_H+MFI>80+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 80) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of btcSynth15mTests) {
  show(label, testSynth15m('BTC', fn));
}

// ── Section 4: ETH tighter RSI filters ──────────────────────────────────────
console.log('\n── Section 4: ETH Tighter RSI/MFI (5m ALL hours) ──');
const ethTighterTests = [
  ['ETH ALL_H+RSI>72+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 72) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+RSI>74+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 74) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+RSI>75+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+RSI>77+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 77) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+MFI>85+RSI>65+BB22+s>=1 (combo)', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 85) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+RSI>70+MFI>70+BB22+s>=1 (dual)', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 70) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of ethTighterTests) {
  show(label, test5m('ETH', fn));
}

// ── Section 5: BTC panic body filter ────────────────────────────────────────
console.log('\n── Section 5: BTC 5m Panic Body Filter (GoodH) ──');
const btcBodyTests = [
  ['BTC GH+body>=0.3%+BB22+s>=1', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const body = Math.abs(c.close - c.open) / c.open * 100;
    if (body < 0.3) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC GH+body>=0.2%+RSI>65+BB22+s>=1', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const body = Math.abs(c.close - c.open) / c.open * 100;
    if (body < 0.2) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC GH+RSI>65+body>=0.15%+BB22+s>=1', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const body = Math.abs(c.close - c.open) / c.open * 100;
    if (body < 0.15) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC ALL_H+RSI>70+body>=0.2%+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const body = Math.abs(c.close - c.open) / c.open * 100;
    if (body < 0.2) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of btcBodyTests) {
  show(label, test5m('BTC', fn));
}

// ── Section 6: ETH/BTC BB outer-band deviation sweet spot ───────────────────
console.log('\n── Section 6: ETH+BTC Dev filter (0.05-0.4% outside BB) ALL hours ──');
function devOutside(c, bb) {
  if (c.close > bb.upper) return (c.close - bb.upper) / bb.upper * 100;
  if (c.close < bb.lower) return (bb.lower - c.close) / bb.lower * 100;
  return 0;
}
const devTests = [
  ['ETH ALL_H+RSI>70+BB22+dev[0.05-0.5%]+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const dev = devOutside(c, bb);
    if (dev < 0.05 || dev > 0.5) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+RSI>70+BB22+dev[0.05-0.3%]+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const dev = devOutside(c, bb);
    if (dev < 0.05 || dev > 0.3) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC ALL_H+RSI>70+BB22+dev[0.05-0.4%]+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const dev = devOutside(c, bb);
    if (dev < 0.05 || dev > 0.4) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH GH+RSI>70+BB22+dev[0.05-0.3%]+s>=1', (w, c) => {
    if (![10,11,12,21].includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const dev = devOutside(c, bb);
    if (dev < 0.05 || dev > 0.3) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of devTests) {
  const coin = label.startsWith('BTC') ? 'BTC' : 'ETH';
  show(label, test5m(coin, fn));
}

// ── Section 7: SOL new hour combos ──────────────────────────────────────────
console.log('\n── Section 7: SOL New Hour Combos (5m) ──');
const solHourTests = [
  ['SOL h=[0,6,12,13,20]+BB22+s>=2 (extended)', (w, c) => {
    if (![0, 6, 12, 13, 20].includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 2;
  }],
  ['SOL h=[0,12,18,20]+BB22+s>=2 (12-offset)', (w, c) => {
    if (![0, 12, 18, 20].includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 2;
  }],
  ['SOL h=[0,12,13]+MFI>75+BB22+s>=1', (w, c) => {
    if (![0, 12, 13].includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL h=[12,20]+RSI>70+BB22+s>=1', (w, c) => {
    if (![12, 20].includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL h=[12]+RSI>65+BB22+s>=1 (single hour)', (w, c) => {
    if (hour(c) !== 12) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['SOL GH+RSI7>65+BB22+s>=1', (w, c) => {
    if (!SOL_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi7 = calcRSI7(w); if (!rsi7 || rsi7 <= 65) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of solHourTests) {
  show(label, test5m('SOL', fn));
}

console.log('\nDone.');
db.close();
