/**
 * Session 19: Candle Patterns, CCI, BB Deviation Boost
 *
 * New dimensions not fully explored:
 * A) Candle wick rejection patterns at BB extremes (long wick = price rejection)
 * B) Multi-candle BB extension (2+ consecutive closes outside BB = exhaustion)
 * C) CCI(20) extremes > 150 / < -150 at BB22
 * D) BB(20,2.5) ultra-high deviation for max WR
 * E) Sequential oscillator count (N of last 5 candles with RSI7>70)
 * F) Candle body trend exhaustion (body shrinking = momentum dying)
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

// ─── helpers ──────────────────────────────────────────────────────────────────
function loadCandles(symbol) {
  return db.prepare(
    `SELECT open_time as openTime, open, high, low, close, volume,
            (open_time + 300000) as closeTime
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol);
}

function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += arr[j];
    out[i] = s / n;
  }
  return out;
}

function calcBB(candles, period = 20, mult = 2.2) {
  const closes = candles.map(c => c.close);
  const result = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mid = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mid) ** 2;
    const std = Math.sqrt(variance / period);
    result.push({ upper: mid + mult * std, lower: mid - mult * std, mid, std });
  }
  return result;
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcRSIArr(candles, period = 14) {
  const closes = candles.map(c => c.close);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const mf = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) posFlow += mf; else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 50;
  const len = candles.length;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = len - period; i < len; i++) {
    const high = candles[i].high, low = candles[i].low;
    const prevHigh = candles[i - 1].high, prevLow = candles[i - 1].low, prevClose = candles[i - 1].close;
    const upMove = high - prevHigh, downMove = prevLow - low;
    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;
    tr += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  if (plusDI + minusDI === 0) return 0;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
}

// CCI = (Typical Price - SMA(TP, n)) / (0.015 * Mean Deviation)
function calcCCI(candles, period = 20) {
  if (candles.length < period) return null;
  const tp = candles.slice(-period).map(c => (c.high + c.low + c.close) / 3);
  const mean = tp.reduce((a, b) => a + b, 0) / period;
  const meanDev = tp.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return (tp[tp.length - 1] - mean) / (0.015 * meanDev);
}

// Stochastic K line
function calcStochK(candles, period = 14) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const highestHigh = Math.max(...slice.map(c => c.high));
  const lowestLow = Math.min(...slice.map(c => c.low));
  if (highestHigh === lowestLow) return 50;
  return ((slice[slice.length - 1].close - lowestLow) / (highestHigh - lowestLow)) * 100;
}

// Count how many of the last N candles have RSI7 > threshold (or < threshold)
function calcRecentOB(rsiArr, endIdx, lookback, threshold, direction) {
  let count = 0;
  for (let i = Math.max(0, endIdx - lookback + 1); i <= endIdx; i++) {
    if (rsiArr[i] === null) continue;
    if (direction === 'above' && rsiArr[i] > threshold) count++;
    if (direction === 'below' && rsiArr[i] < threshold) count++;
  }
  return count;
}

// ─── Walk-forward validation ───────────────────────────────────────────────
function walkForward(candles, signalFn, folds = 5) {
  const step = Math.floor(candles.length / folds);
  const foldWRs = [];
  for (let f = 0; f < folds; f++) {
    const start = f * step;
    const end = f === folds - 1 ? candles.length : (f + 1) * step;
    const slice = candles.slice(start, end);
    let wins = 0, total = 0;
    for (let i = 50; i < slice.length - 1; i++) {
      const signal = signalFn(slice, i);
      if (!signal) continue;
      total++;
      const entry = slice[i].close;
      const exit = slice[i + 1].close;
      const win = signal === 'bear' ? exit < entry : exit > entry;
      if (win) wins++;
    }
    if (total >= 3) foldWRs.push({ wr: wins / total, n: total });
  }
  if (foldWRs.length < 3) return null;
  const medianWR = foldWRs.map(f => f.wr).sort((a, b) => a - b)[Math.floor(foldWRs.length / 2)];
  const totalN = foldWRs.reduce((s, f) => s + f.n, 0);
  const tpd = totalN / (candles.length * 5 / 1440 / 60);
  return { wr: medianWR, n: totalN, tpd: parseFloat(tpd.toFixed(2)) };
}

// ─── Data ─────────────────────────────────────────────────────────────────────
console.log('Loading candles...');
const COINS = {
  ETH: { candles: loadCandles('ETH'), goodHours: [10, 11, 12, 21] },
  BTC: { candles: loadCandles('BTC'), goodHours: [1, 12, 13, 16, 20] },
  SOL: { candles: loadCandles('SOL'), goodHours: [0, 12, 13, 20] },
  XRP: { candles: loadCandles('XRP'), goodHours: [6, 9, 12, 18] },
};
for (const [sym, d] of Object.entries(COINS)) {
  console.log(`  ${sym}: ${d.candles.length} candles`);
}

const results = [];

function addResult(label, sym, stats) {
  if (!stats) return;
  const emoji = stats.wr >= 0.80 ? '🔥🔥🔥' : stats.wr >= 0.75 ? '🔥🔥' : stats.wr >= 0.70 ? '🔥' : '';
  results.push({ label, sym, wr: stats.wr, n: stats.n, tpd: stats.tpd, emoji });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A: Candle wick rejection at BB extremes
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section A: Wick rejection at BB extremes ==');

// A1: Long upper wick at BB22 upper (bearish rejection) | long lower wick at BB lower (bullish)
// Pattern: wick > 2x body size
for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // Pre-compute BB22
  const bb22 = calcBB(candles, 20, 2.2);
  const rsi7arr = calcRSIArr(candles, 7);

  // A1: GoodH + ADX<20 + RSI7>70 + BB22 + long wick rejection
  const statsA1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = bb22[i]; // note: bb22 is indexed to full candles, but slice starts at 0...
    // We need to recompute BB for the slice context
    // Actually we need to use local BB calculation here
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    // Wick size
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.close, c.open);
    const lowerWick = Math.min(c.close, c.open) - c.low;
    const isBear = rsi7 > 70 && c.close > bbNow.upper && upperWick > body * 1.5 && upperWick > (c.high - c.low) * 0.4;
    const isBull = rsi7 < 30 && c.close < bbNow.lower && lowerWick > body * 1.5 && lowerWick > (c.high - c.low) * 0.4;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('A1_GH+ADX20+RSI7+BB22+WickRejection', sym, statsA1);

  // A2: Same but with MFI confirmation
  const statsA2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.close, c.open);
    const lowerWick = Math.min(c.close, c.open) - c.low;
    const isBear = rsi7 > 70 && mfi > 68 && c.close > bbNow.upper && upperWick > body * 1.5;
    const isBull = rsi7 < 30 && mfi < 32 && c.close < bbNow.lower && lowerWick > body * 1.5;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('A2_GH+ADX20+RSI7+MFI68+BB22+WickRej', sym, statsA2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B: Multi-candle extension (2+ closes outside BB)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section B: Multi-candle BB extension ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // B1: GH + 2 consecutive closes above BB22 + RSI7>70
  const statsB1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const prev = slice[i - 1];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const localBBprev = calcBB(slice.slice(Math.max(0, i - 31), i), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    const bbPrev = localBBprev[localBBprev.length - 1];
    if (!bbNow || !bbPrev) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    const isBear = rsi7 > 70 && c.close > bbNow.upper && prev.close > bbPrev.upper;
    const isBull = rsi7 < 30 && c.close < bbNow.lower && prev.close < bbPrev.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('B1_GH+ADX20+RSI7+2x_OutsideBB22', sym, statsB1);

  // B2: Same + MFI70
  const statsB2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const prev = slice[i - 1];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const localBBprev = calcBB(slice.slice(Math.max(0, i - 31), i), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    const bbPrev = localBBprev[localBBprev.length - 1];
    if (!bbNow || !bbPrev) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 70 && mfi > 70 && c.close > bbNow.upper && prev.close > bbPrev.upper;
    const isBull = rsi7 < 30 && mfi < 30 && c.close < bbNow.lower && prev.close < bbPrev.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('B2_GH+ADX20+RSI7+MFI70+2x_OutsideBB22', sym, statsB2);

  // B3: No ADX filter, 2x outside BB22 + RSI7>73 + MFI68 (all hours)
  const statsB3 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const prev = slice[i - 1];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const localBBprev = calcBB(slice.slice(Math.max(0, i - 31), i), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    const bbPrev = localBBprev[localBBprev.length - 1];
    if (!bbNow || !bbPrev) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 68 && c.close > bbNow.upper && prev.close > bbPrev.upper;
    const isBull = rsi7 < 27 && mfi < 32 && c.close < bbNow.lower && prev.close < bbPrev.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('B3_AllH+RSI7+MFI68+2x_OutsideBB22', sym, statsB3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C: CCI extremes + BB22
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section C: CCI extremes ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // C1: GH + ADX<20 + CCI>150 + BB22
  const statsC1 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const cci = calcCCI(slice.slice(Math.max(0, i - 25), i + 1), 20);
    if (cci === null) return null;
    const isBear = cci > 150 && c.close > bbNow.upper;
    const isBull = cci < -150 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('C1_GH+ADX20+CCI150+BB22', sym, statsC1);

  // C2: GH + ADX<20 + CCI>150 + RSI7>68 + BB22
  const statsC2 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const cci = calcCCI(slice.slice(Math.max(0, i - 25), i + 1), 20);
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (cci === null || rsi7 === null) return null;
    const isBear = cci > 150 && rsi7 > 68 && c.close > bbNow.upper;
    const isBull = cci < -150 && rsi7 < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('C2_GH+ADX20+CCI150+RSI7+BB22', sym, statsC2);

  // C3: GH + CCI>200 (ultra-extreme) + BB22 (no ADX)
  const statsC3 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const cci = calcCCI(slice.slice(Math.max(0, i - 25), i + 1), 20);
    if (cci === null) return null;
    const isBear = cci > 200 && c.close > bbNow.upper;
    const isBull = cci < -200 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('C3_GH+CCI200+BB22', sym, statsC3);

  // C4: All hours + CCI>150 + RSI7>70 + MFI68 + BB22 (volume boost)
  const statsC4 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const cci = calcCCI(slice.slice(Math.max(0, i - 25), i + 1), 20);
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (cci === null || rsi7 === null || mfi === null) return null;
    const isBear = cci > 150 && rsi7 > 70 && mfi > 68 && c.close > bbNow.upper;
    const isBull = cci < -150 && rsi7 < 30 && mfi < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('C4_AllH+CCI150+RSI7+MFI68+BB22', sym, statsC4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D: BB(20,2.5) ultra-deviation
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section D: BB(20,2.5) ultra-deviation ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // D1: GH + BB25 + RSI7>70 (no ADX - more trades)
  const statsD1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.5);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    const isBear = rsi7 > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('D1_GH+RSI7+BB25', sym, statsD1);

  // D2: GH + ADX<20 + RSI7>70 + MFI70 + BB25
  const statsD2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.5);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 70 && mfi > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < 30 && mfi < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('D2_GH+ADX20+RSI7+MFI70+BB25', sym, statsD2);

  // D3: All hours + BB25 + RSI7>73 + MFI70 (volume boost strat 64 variant)
  const statsD3 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.5);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('D3_AllH+RSI7+MFI70+BB25', sym, statsD3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E: Sequential RSI count (N of last 5 candles overbought/oversold)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section E: Sequential RSI count ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // Pre-compute RSI7 array for the whole series
  const rsi7AllArr = calcRSIArr(candles, 7);

  // E1: GH + ≥3 of last 5 candles RSI7>68 + currently at BB22
  const statsE1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    // Count RSI7>68 in last 5
    let obCount = 0, osCount = 0;
    for (let k = i - 4; k <= i; k++) {
      if (k < 0) continue;
      const r = calcRSI(slice.slice(Math.max(0, k - 10), k + 1), 7);
      if (r !== null && r > 68) obCount++;
      if (r !== null && r < 32) osCount++;
    }
    const isBear = obCount >= 3 && c.close > bbNow.upper;
    const isBull = osCount >= 3 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('E1_GH+3of5_RSI7>68+BB22', sym, statsE1);

  // E2: All hours + ≥3 of last 5 RSI7>68 + MFI68 + BB22
  const statsE2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (mfi === null) return null;
    let obCount = 0, osCount = 0;
    for (let k = i - 4; k <= i; k++) {
      if (k < 0) continue;
      const r = calcRSI(slice.slice(Math.max(0, k - 10), k + 1), 7);
      if (r !== null && r > 68) obCount++;
      if (r !== null && r < 32) osCount++;
    }
    const isBear = obCount >= 3 && mfi > 68 && c.close > bbNow.upper;
    const isBull = osCount >= 3 && mfi < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('E2_AllH+3of5_RSI7>68+MFI68+BB22', sym, statsE2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F: Candle body exhaustion (shrinking body at BB extreme)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section F: Candle body exhaustion ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // F1: GH + ADX<20 + RSI7>70 + current body < 60% of previous body + at BB22
  const statsF1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const prev = slice[i - 1];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    const currBody = Math.abs(c.close - c.open);
    const prevBody = Math.abs(prev.close - prev.open);
    if (prevBody < 0.0001) return null; // avoid div by zero on doji
    const bodyRatio = currBody / prevBody;
    const isBear = rsi7 > 70 && bodyRatio < 0.6 && c.close > bbNow.upper;
    const isBull = rsi7 < 30 && bodyRatio < 0.6 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('F1_GH+ADX20+RSI7+ShrinkBody+BB22', sym, statsF1);

  // F2: All hours + RSI7>73 + MFI70 + current body < prev body + at BB22
  const statsF2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const prev = slice[i - 1];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const currBody = Math.abs(c.close - c.open);
    const prevBody = Math.abs(prev.close - prev.open);
    if (prevBody < 0.0001) return null;
    const isBear = rsi7 > 73 && mfi > 70 && currBody < prevBody && c.close > bbNow.upper;
    const isBull = rsi7 < 27 && mfi < 30 && currBody < prevBody && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('F2_AllH+RSI7+MFI70+ShrinkBody+BB22', sym, statsF2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section G: Stoch % extremes + BB22 (Stoch-K without RSI dependency)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section G: Stoch-K extremes ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // G1: GH + ADX<20 + StochK>80 + MFI70 + BB22
  const statsG1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const stochK = calcStochK(slice.slice(Math.max(0, i - 16), i + 1), 14);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (stochK === null || mfi === null) return null;
    const isBear = stochK > 80 && mfi > 70 && c.close > bbNow.upper;
    const isBull = stochK < 20 && mfi < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('G1_GH+ADX20+StochK80+MFI70+BB22', sym, statsG1);

  // G2: GH + ADX<20 + StochK>85 + RSI7>68 + BB22 (high-threshold Stoch)
  const statsG2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const stochK = calcStochK(slice.slice(Math.max(0, i - 16), i + 1), 14);
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (stochK === null || rsi7 === null) return null;
    const isBear = stochK > 85 && rsi7 > 68 && c.close > bbNow.upper;
    const isBull = stochK < 15 && rsi7 < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('G2_GH+ADX20+StochK85+RSI7+BB22', sym, statsG2);

  // G3: All hours + StochK>80 + RSI7>70 + MFI68 + BB22 (volume boost)
  const statsG3 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const stochK = calcStochK(slice.slice(Math.max(0, i - 16), i + 1), 14);
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (stochK === null || rsi7 === null || mfi === null) return null;
    const isBear = stochK > 80 && rsi7 > 70 && mfi > 68 && c.close > bbNow.upper;
    const isBull = stochK < 20 && rsi7 < 30 && mfi < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult('G3_AllH+StochK80+RSI7+MFI68+BB22', sym, statsG3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section H: Extended good hours for top performers
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section H: Extended good hours for top strats ==');

// Test strat 64 variant with extended hours
const extHoursTests = [
  { sym: 'ETH', name: 'ETH_extH_[9,10,11,12,13,21]', hours: [9, 10, 11, 12, 13, 21] },
  { sym: 'ETH', name: 'ETH_extH_[8,10,11,12,21,22]', hours: [8, 10, 11, 12, 21, 22] },
  { sym: 'BTC', name: 'BTC_extH_[0,1,12,13,16,20]',  hours: [0, 1, 12, 13, 16, 20] },
  { sym: 'BTC', name: 'BTC_extH_[1,2,12,13,14,16,20]', hours: [1, 2, 12, 13, 14, 16, 20] },
  { sym: 'SOL', name: 'SOL_extH_[0,1,12,13,20,21]',  hours: [0, 1, 12, 13, 20, 21] },
  { sym: 'XRP', name: 'XRP_extH_[5,6,9,12,13,18]',   hours: [5, 6, 9, 12, 13, 18] },
];

for (const test of extHoursTests) {
  const { candles } = COINS[test.sym];
  const stats = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!test.hours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(test.name, test.sym, stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section I: RSI7 threshold sweep (66-73) for max WR at GH
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section I: RSI7 threshold sweep ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  for (const rsiThresh of [65, 68, 70, 73, 75]) {
    const stats = walkForward(candles, (slice, i) => {
      if (i < 25) return null;
      const c = slice[i];
      const hour = new Date(c.closeTime).getUTCHours();
      if (!goodHours.includes(hour)) return null;
      const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
      const bbNow = localBB[localBB.length - 1];
      if (!bbNow) return null;
      const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
      if (adx >= 20) return null;
      const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
      const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
      if (rsi7 === null || mfi === null) return null;
      const isBear = rsi7 > rsiThresh && mfi > 68 && c.close > bbNow.upper;
      const isBull = rsi7 < (100 - rsiThresh) && mfi < 32 && c.close < bbNow.lower;
      if (isBear) return 'bear';
      if (isBull) return 'bull';
      return null;
    });
    addResult(`I_${sym}_RSI7>${rsiThresh}+MFI68+BB22`, sym, stats);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10 ===');
console.log('=======================================================');
const winners = results.filter(r => r.wr >= 0.75 && r.n >= 10).sort((a, b) => b.wr - a.wr);
if (winners.length === 0) {
  console.log('  (none)');
} else {
  for (const r of winners) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

console.log('\n=======================================================');
console.log('=== GOOD: WR>=70%, n>=10 ===');
console.log('=======================================================');
const good = results.filter(r => r.wr >= 0.70 && r.n >= 10 && r.wr < 0.75).sort((a, b) => b.wr - a.wr);
if (good.length === 0) {
  console.log('  (none)');
} else {
  for (const r of good) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

console.log('\n=======================================================');
console.log('=== ALL: WR>=65%, n>=5 ===');
console.log('=======================================================');
const all = results.filter(r => r.wr >= 0.65 && r.n >= 5).sort((a, b) => b.wr - a.wr);
if (all.length === 0) {
  console.log('  (none)');
} else {
  for (const r of all) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

console.log('\n=======================================================');
console.log('=== SECTION I: RSI7 threshold sweep summary ===');
console.log('=======================================================');
const sweepResults = results.filter(r => r.label.startsWith('I_'));
// Sort by coin then by threshold
const byCoin = {};
for (const r of sweepResults) {
  if (!byCoin[r.sym]) byCoin[r.sym] = [];
  byCoin[r.sym].push(r);
}
for (const [sym, rs] of Object.entries(byCoin)) {
  console.log(`\n  ${sym}:`);
  for (const r of rs) {
    const tag = r.wr >= 0.75 ? ' 🔥' : r.wr >= 0.70 ? ' ✓' : '';
    console.log(`    ${r.label} | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
  }
}

db.close();
