/**
 * BTC 5m Strategy Research — Find high-WR BTC-specific strategies
 * Tests: RSI+BB, EMA50 extension, MFI, Hour combos, DoW combos
 * Uses 5-fold walk-forward validation on full 6-month dataset
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.cwd(), 'trader.db'), { readonly: true });

function getCandles(symbol, tf, limit) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ?
     ORDER BY open_time DESC LIMIT ?`
  ).all(symbol, tf, limit).reverse();
}

function calcBB(candles, period, mult) {
  if (candles.length < period) return null;
  const closes = candles.map(c => c.close);
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, mid: mean, lower: mean - mult * std };
}

function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff; else losses += -diff;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function calcMFI(candles, period) {
  if (candles.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp > prevTp) posFlow += mf; else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcEMA(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
}

function walkForward(trades, folds) {
  if (!folds) folds = 5;
  if (trades.length < 10) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  trades.sort((a, b) => a.time - b.time);
  const foldSize = Math.floor(trades.length / folds);
  const foldWRs = [];
  for (let f = 0; f < folds; f++) {
    const slice = trades.slice(f * foldSize, (f + 1) * foldSize);
    if (slice.length < 3) { foldWRs.push(50); continue; }
    foldWRs.push(slice.filter(t => t.win).length / slice.length * 100);
  }
  const mean = foldWRs.reduce((a, b) => a + b, 0) / folds;
  const sigma = Math.sqrt(foldWRs.reduce((s, v) => s + (v - mean) ** 2, 0) / folds);
  return { wf: mean, sigma, T: trades.length, foldWRs };
}

function simulateTrade(candles5m, idx) {
  const entry = candles5m[idx].close;
  const isBear = candles5m[idx].close > candles5m[idx].open;
  for (let k = idx + 1; k <= Math.min(idx + 3, candles5m.length - 1); k++) {
    if (isBear && candles5m[k].close < entry) return true;
    if (!isBear && candles5m[k].close > entry) return true;
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

function testBTC5m(label, filterFn) {
  const candles5m = getCandles('BTC', '5m', 53000);
  if (candles5m.length < 100) return { label, wf: 0, sigma: 99, T: 0, foldWRs: [] };
  const trades = [];
  const winSize = 60;
  for (let i = winSize + 1; i < candles5m.length - 3; i++) {
    const window = candles5m.slice(i - winSize, i + 1);
    const sig = filterFn(window, candles5m[i]);
    if (sig) {
      const win = simulateTrade(candles5m, i);
      trades.push({ time: candles5m[i].open_time, win });
    }
  }
  return { label, ...walkForward(trades) };
}

const BTC_GOOD_HOURS = [1, 12, 13, 16, 20];

function hour(c) { return new Date(c.open_time).getUTCHours(); }
function dow(c) { return new Date(c.open_time).getUTCDay(); }

const tests = [
  ['BTC/5m RSI>65+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (rsi === null || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m RSI>65+BB22+GH+s>=2', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (rsi === null || rsi <= 65) return false;
    return streakAt(w) >= 2;
  }],
  ['BTC/5m RSI>67+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (rsi === null || rsi <= 67) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m RSI>70+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (rsi === null || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m RSI>70+BB22+ALL_H+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (rsi === null || rsi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m MFI>70+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (mfi === null || mfi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m MFI>75+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (mfi === null || mfi <= 75) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m MFI>80+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (mfi === null || mfi <= 80) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m MFI>80+BB22+ALL_H+s>=1', (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (mfi === null || mfi <= 80) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m EMA50>=0.5%+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const ema = calcEMA(w, 50); if (!ema) return false;
    const dist = Math.abs(c.close - ema) / ema * 100;
    return dist >= 0.5 && streakAt(w) >= 1;
  }],
  ['BTC/5m EMA50>=0.8%+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const ema = calcEMA(w, 50); if (!ema) return false;
    const dist = Math.abs(c.close - ema) / ema * 100;
    return dist >= 0.8 && streakAt(w) >= 1;
  }],
  ['BTC/5m EMA50>=1.0%+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const ema = calcEMA(w, 50); if (!ema) return false;
    const dist = Math.abs(c.close - ema) / ema * 100;
    return dist >= 1.0 && streakAt(w) >= 1;
  }],
  ['BTC/5m body>=0.3%+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    return bodyPct >= 0.3 && streakAt(w) >= 1;
  }],
  ['BTC/5m body>=0.3%+RSI>65+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    const rsi = calcRSI(w, 14);
    return bodyPct >= 0.3 && rsi !== null && rsi > 65 && streakAt(w) >= 1;
  }],
  ['BTC/5m body>=0.3%+RSI>70+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    const rsi = calcRSI(w, 14);
    return bodyPct >= 0.3 && rsi !== null && rsi > 70 && streakAt(w) >= 1;
  }],
  ['BTC/5m body>=0.3%+MFI>70+BB22+GH+s>=1', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    const mfi = calcMFI(w, 10);
    return bodyPct >= 0.3 && mfi !== null && mfi > 70 && streakAt(w) >= 1;
  }],
  ['BTC/5m DoW[Sat]+ALL_H+BB22+s>=1', (w, c) => {
    if (dow(c) !== 6) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m DoW[Sat]+GH+BB22+s>=1', (w, c) => {
    if (dow(c) !== 6 || !BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m DoW[Wed+Sat]+GH+BB22+s>=1', (w, c) => {
    const d = dow(c); if (d !== 3 && d !== 6) return false;
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m DoW[Sat]+RSI>65+BB22+s>=1', (w, c) => {
    if (dow(c) !== 6) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const rsi = calcRSI(w, 14); if (rsi === null || rsi <= 65) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m DoW[Sat]+MFI>70+BB22+s>=1', (w, c) => {
    if (dow(c) !== 6) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    const mfi = calcMFI(w, 10); if (mfi === null || mfi <= 70) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m GH+BB22+s>=1 (baseline)', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return streakAt(w) >= 1;
  }],
  ['BTC/5m GH+BB22+s>=2 (baseline)', (w, c) => {
    if (!BTC_GOOD_HOURS.includes(hour(c))) return false;
    const bb = calcBB(w, 20, 2.2); if (!bb || c.close <= bb.upper) return false;
    return streakAt(w) >= 2;
  }],
];

console.log('══════════════════════════════════════════════════════════');
console.log('BTC 5m Strategy Research');
console.log('══════════════════════════════════════════════════════════');
console.log();

const results = [];
for (const [label, fn] of tests) {
  process.stdout.write('Testing: ' + label + '... ');
  const r = testBTC5m(label, fn);
  results.push(r);
  const tag = r.wf >= 70 ? '*** IMPLEMENT' : r.wf >= 65 ? '** PROMISING' : r.wf >= 60 ? '* MARGINAL' : '  SKIP';
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  console.log('WF=' + r.wf.toFixed(1) + '% σ=' + r.sigma.toFixed(1) + '% T=' + r.T + ' [' + fStr + '] ' + tag);
}

console.log('\n── Top Results (WF >= 63%, T >= 20) ──');
results.sort((a, b) => b.wf - a.wf)
  .filter(r => r.wf >= 63 && r.T >= 20)
  .forEach(r => {
    const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
    const label = (r.label + '                                                   ').slice(0, 55);
    console.log('  ' + label + ' WF=' + r.wf.toFixed(1) + '% σ=' + r.sigma.toFixed(1) + '% T=' + r.T + ' [' + fStr + ']');
  });

console.log('\nDone.');
