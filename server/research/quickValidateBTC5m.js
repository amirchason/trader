/**
 * Quick sanity check + high-frequency ETH research
 * Goal: find strategies giving >5 trades/day with >70% WR
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

function test(coin, filterFn) {
  const candles = getCandles(coin, '5m', 53000);
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

const ETH_GH = [10, 11, 12, 21];
const BTC_GH = [1, 12, 13, 16, 20];
function hour(c) { return new Date(c.open_time).getUTCHours(); }

console.log('═══════════════════════════════════════════════════════════');
console.log('High-Frequency Strategy Search (>5 trades/day, >65% WR)');
console.log('═══════════════════════════════════════════════════════════\n');

// ── Section 1: BTC validation (strats 43-46) ──
console.log('── Section 1: BTC 5m Strategies Validation ──');
const btcTests = [
  ['BTC MFI>75+BB22+GH+s>=1 (Strat43)', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC RSI>67+BB22+GH+s>=1 (Strat44)', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 67) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC GH+BB22+s>=2 (Strat45)', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 2;
  }],
  ['BTC RSI>70+BB22+GH+s>=1 (Strat46)', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of btcTests) {
  const r = test('BTC', fn);
  const perDay = (r.T / 184).toFixed(1);
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  const tag = r.wf >= 75 ? '✅ EXCELLENT' : r.wf >= 70 ? '✅ GOOD' : '⚠️';
  console.log(`  ${tag} ${label}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.T}(${perDay}/d) [${fStr}]`);
}

// ── Section 2: High-freq ETH (relaxed filters, more trades) ──
console.log('\n── Section 2: ETH High-Frequency (Extended Hours) ──');
const ETH_EXT_H = [10, 11, 12, 13, 21, 22];
const ethHFTests = [
  ['ETH ExtH[10-13,21-22]+BB22+s>=1', (w, c) => {
    if (!ETH_EXT_H.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 1;
  }],
  ['ETH ExtH+RSI>60+BB22+s>=1', (w, c) => {
    if (!ETH_EXT_H.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 60) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ExtH+RSI>65+BB22+s>=1', (w, c) => {
    if (!ETH_EXT_H.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH GH[10-12,21]+BB22+s>=1 (baseline)', (w, c) => {
    if (!ETH_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 1;
  }],
  ['ETH ALL_H+RSI>70+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+MFI>80+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 80) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+RSI>75+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['ETH ALL_H+MFI>85+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 85) return false;
    return streakAt(w) >= 1;
  }],
];
for (const [label, fn] of ethHFTests) {
  const r = test('ETH', fn);
  const perDay = (r.T / 184).toFixed(1);
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  const tag = r.wf >= 75 ? '✅ EXCELLENT' : r.wf >= 70 ? '✅ GOOD' : r.wf >= 65 ? '⚠️ OK' : '❌';
  console.log(`  ${tag} ${label}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.T}(${perDay}/d) [${fStr}]`);
}

// ── Section 3: BTC high-frequency (all hours with strong filters) ──
console.log('\n── Section 3: BTC Extended Hours High-Freq ──');
const btcHFTests = [
  ['BTC ALL_H+RSI>70+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 70) return false;
    return Math.abs(streakAt(w)) >= 1;
  }],
  ['BTC ALL_H+MFI>80+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 80) return false;
    return Math.abs(streakAt(w)) >= 1;
  }],
  ['BTC ALL_H+RSI>75+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (!rsi || rsi <= 75) return false;
    return Math.abs(streakAt(w)) >= 1;
  }],
  ['BTC ALL_H+MFI>85+BB22+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (!mfi || mfi <= 85) return false;
    return Math.abs(streakAt(w)) >= 1;
  }],
  ['BTC GH+BB22+s>=1 (all GH)', (w, c) => {
    if (!BTC_GH.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return Math.abs(streakAt(w)) >= 1;
  }],
];
for (const [label, fn] of btcHFTests) {
  const r = test('BTC', fn);
  const perDay = (r.T / 184).toFixed(1);
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  const tag = r.wf >= 75 ? '✅ EXCELLENT' : r.wf >= 70 ? '✅ GOOD' : r.wf >= 65 ? '⚠️ OK' : '❌';
  console.log(`  ${tag} ${label}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.T}(${perDay}/d) [${fStr}]`);
}

console.log('\nDone.');
