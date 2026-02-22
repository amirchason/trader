/**
 * Session 23: RSI Divergence + OR-Logic + ROC Exhaustion + Retracing Extreme
 *
 * Genuinely new concepts not yet tested:
 * A) RSI7 divergence: price at new 20-period high, RSI7 below previous peak = bearish divergence
 * B) OR-logic oscillators: any 2 of (RSI7>70, MFI>68, CCI>150) = more volume
 * C) ROC(3) momentum exhaustion: big 3-candle move + at BB extreme + overbought
 * D) Retracing from extreme: price outside BB but prev close > current close (peak reached)
 * E) Adaptive RSI percentile: RSI7 is in top 5% of its recent range = normalized signal
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

function loadCandles(symbol) {
  return db.prepare(
    `SELECT open_time as openTime, open, high, low, close, volume,
            (open_time + 300000) as closeTime
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol);
}

function calcBB(candles, period = 20, mult = 2.2) {
  if (candles.length < period) return null;
  const closes = candles.map(c => c.close);
  let sum = 0;
  for (let j = candles.length - period; j < candles.length; j++) sum += closes[j];
  const mid = sum / period;
  let variance = 0;
  for (let j = candles.length - period; j < candles.length; j++) variance += (closes[j] - mid) ** 2;
  const std = Math.sqrt(variance / period);
  return { upper: mid + mult * std, lower: mid - mult * std, mid, std };
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

function calcCCI(candles, period = 20) {
  if (candles.length < period) return null;
  const tp = candles.slice(-period).map(c => (c.high + c.low + c.close) / 3);
  const mean = tp.reduce((a, b) => a + b, 0) / period;
  const meanDev = tp.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return (tp[tp.length - 1] - mean) / (0.015 * meanDev);
}

// RSI7 array for divergence detection
function buildRSI7Arr(slice, lookback = 30) {
  const arr = [];
  for (let j = Math.max(0, slice.length - lookback); j < slice.length; j++) {
    const r = calcRSI(slice.slice(Math.max(0, j - 10), j + 1), 7);
    arr.push(r);
  }
  return arr;
}

// Percentile rank of val in arr
function pctRank(arr, val) {
  const nonNull = arr.filter(v => v !== null);
  if (nonNull.length === 0) return 50;
  return (nonNull.filter(v => v < val).length / nonNull.length) * 100;
}

function walkForward(candles, signalFn, folds = 5) {
  const step = Math.floor(candles.length / folds);
  const foldWRs = [];
  let totalN = 0;
  for (let f = 0; f < folds; f++) {
    const start = f * step;
    const end = f === folds - 1 ? candles.length : (f + 1) * step;
    const slice = candles.slice(start, end);
    let wins = 0, total = 0;
    for (let i = 60; i < slice.length - 1; i++) {
      const signal = signalFn(slice, i);
      if (!signal) continue;
      total++;
      const entry = slice[i].close;
      const exit = slice[i + 1].close;
      const win = signal === 'bear' ? exit < entry : exit > entry;
      if (win) wins++;
    }
    totalN += total;
    if (total >= 3) foldWRs.push({ wr: wins / total, n: total });
  }
  if (foldWRs.length < 3) return null;
  const sorted = foldWRs.map(f => f.wr).sort((a, b) => a - b);
  const medianWR = sorted[Math.floor(foldWRs.length / 2)];
  const totalDays = candles.length * 5 / (60 * 24);
  return { wr: medianWR, n: totalN, tpd: parseFloat((totalN / totalDays).toFixed(2)) };
}

console.log('Loading candles...');
const COINS = {
  ETH: { candles: loadCandles('ETH'), goodHours: [10, 11, 12, 21] },
  BTC: { candles: loadCandles('BTC'), goodHours: [1, 12, 13, 16, 20] },
  SOL: { candles: loadCandles('SOL'), goodHours: [0, 12, 13, 20] },
  XRP: { candles: loadCandles('XRP'), goodHours: [6, 9, 12, 18] },
};
for (const [sym, d] of Object.entries(COINS)) {
  console.log(`  ${sym}: ${d.candles.length} candles (${(d.candles.length * 5 / 1440).toFixed(0)} days)`);
}

const results = [];
function addResult(label, sym, stats) {
  if (!stats) return;
  const emoji = stats.wr >= 0.80 ? '🔥🔥🔥' : stats.wr >= 0.75 ? '🔥🔥' : stats.wr >= 0.70 ? '🔥' : '';
  results.push({ label, sym, wr: stats.wr, n: stats.n, tpd: stats.tpd, emoji });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A: RSI7 Divergence + BB22
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section A: RSI7 divergence at BB extreme ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // A1: GH + bearish div: price at 20-bar high, RSI7 below its level 5 bars ago + outside BB + RSI7>65
  const statsA1 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const rsi7now = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const rsi7prev = calcRSI(slice.slice(Math.max(0, i - 15), i - 4), 7);
    if (rsi7now === null || rsi7prev === null) return null;
    // Find 20-period high/low
    const hi20 = Math.max(...slice.slice(Math.max(0, i - 19), i + 1).map(c => c.high));
    const lo20 = Math.min(...slice.slice(Math.max(0, i - 19), i + 1).map(c => c.low));
    // Bearish divergence: price at 20-bar high, RSI7 lower than 5 bars ago
    const isBear = c.high >= hi20 * 0.999 && rsi7now > 65 && rsi7now < rsi7prev && c.close > bb.upper;
    // Bullish divergence: price at 20-bar low, RSI7 higher than 5 bars ago
    const isBull = c.low <= lo20 * 1.001 && rsi7now < 35 && rsi7now > rsi7prev && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A1_${sym}_GH+RSI7div+BB22`, sym, statsA1);

  // A2: Same but all hours (no good-hour filter) — divergence is a universal signal
  const statsA2 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const rsi7now = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const rsi7prev = calcRSI(slice.slice(Math.max(0, i - 15), i - 4), 7);
    if (rsi7now === null || rsi7prev === null) return null;
    const hi20 = Math.max(...slice.slice(Math.max(0, i - 19), i + 1).map(c => c.high));
    const lo20 = Math.min(...slice.slice(Math.max(0, i - 19), i + 1).map(c => c.low));
    const isBear = c.high >= hi20 * 0.999 && rsi7now > 65 && rsi7now < rsi7prev && c.close > bb.upper;
    const isBull = c.low <= lo20 * 1.001 && rsi7now < 35 && rsi7now > rsi7prev && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A2_${sym}_AllH+RSI7div+BB22`, sym, statsA2);

  // A3: GH + ADX<20 + RSI7 divergence (strict: RSI7 now is 5+ points below previous)
  const statsA3 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7now = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const rsi7prev = calcRSI(slice.slice(Math.max(0, i - 15), i - 4), 7);
    if (rsi7now === null || rsi7prev === null) return null;
    const hi20 = Math.max(...slice.slice(Math.max(0, i - 19), i + 1).map(c => c.high));
    const lo20 = Math.min(...slice.slice(Math.max(0, i - 19), i + 1).map(c => c.low));
    const isBear = c.high >= hi20 * 0.999 && rsi7now > 65 && (rsi7prev - rsi7now) >= 5 && c.close > bb.upper;
    const isBull = c.low <= lo20 * 1.001 && rsi7now < 35 && (rsi7now - rsi7prev) >= 5 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A3_${sym}_GH+ADX20+RSI7div5pt+BB22`, sym, statsA3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B: OR-logic oscillators (2 of 3 required)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section B: OR-logic oscillators ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // B1: GH + ADX<20 + BB22 + at least 2 of (RSI7>70, MFI>68, CCI>150) = consensus signal
  const statsB1 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    const cci = calcCCI(slice.slice(Math.max(0, i - 25), i + 1), 20);
    if (rsi7 === null || mfi === null || cci === null) return null;
    const bearCount = (rsi7 > 70 ? 1 : 0) + (mfi > 68 ? 1 : 0) + (cci > 150 ? 1 : 0);
    const bullCount = (rsi7 < 30 ? 1 : 0) + (mfi < 32 ? 1 : 0) + (cci < -150 ? 1 : 0);
    const isBear = bearCount >= 2 && c.close > bb.upper;
    const isBull = bullCount >= 2 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B1_${sym}_GH+ADX20+2of3(RSI7,MFI,CCI)+BB22`, sym, statsB1);

  // B2: All hours + BB22 + at least 2 of (RSI7>73, MFI>70, CCI>150) = stronger threshold
  const statsB2 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    const cci = calcCCI(slice.slice(Math.max(0, i - 25), i + 1), 20);
    if (rsi7 === null || mfi === null || cci === null) return null;
    const bearCount = (rsi7 > 73 ? 1 : 0) + (mfi > 70 ? 1 : 0) + (cci > 150 ? 1 : 0);
    const bullCount = (rsi7 < 27 ? 1 : 0) + (mfi < 30 ? 1 : 0) + (cci < -150 ? 1 : 0);
    const isBear = bearCount >= 2 && c.close > bb.upper;
    const isBull = bullCount >= 2 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B2_${sym}_AllH+2of3(RSI7>73,MFI70,CCI150)+BB22`, sym, statsB2);

  // B3: GH + ADX<20 + all 3 required but CCI lowered to 100 (more inclusive)
  const statsB3 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    const cci = calcCCI(slice.slice(Math.max(0, i - 25), i + 1), 20);
    if (rsi7 === null || mfi === null || cci === null) return null;
    const isBear = rsi7 > 70 && mfi > 68 && cci > 100 && c.close > bb.upper;
    const isBull = rsi7 < 30 && mfi < 32 && cci < -100 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B3_${sym}_GH+ADX20+RSI7+MFI68+CCI100+BB22`, sym, statsB3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C: ROC(3) momentum exhaustion
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section C: ROC momentum exhaustion ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // C1: GH + ADX<20 + ROC(3)>0.3% + RSI7>70 + BB22
  // ROC(3) = big 3-candle bullish move = overextended = reversion candidate
  const statsC1 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    const roc3Bear = (c.close - slice[i - 3].close) / slice[i - 3].close * 100;
    const roc3Bull = (slice[i - 3].close - c.close) / slice[i - 3].close * 100;
    const isBear = roc3Bear > 0.3 && rsi7 > 70 && c.close > bb.upper;
    const isBull = roc3Bull > 0.3 && rsi7 < 30 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C1_${sym}_GH+ADX20+ROC3+RSI7+BB22`, sym, statsC1);

  // C2: GH + ROC(3)>0.4% + RSI7>70 + MFI>68 + BB22 (no ADX, stronger ROC)
  const statsC2 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const roc3Bear = (c.close - slice[i - 3].close) / slice[i - 3].close * 100;
    const roc3Bull = (slice[i - 3].close - c.close) / slice[i - 3].close * 100;
    const isBear = roc3Bear > 0.4 && rsi7 > 70 && mfi > 68 && c.close > bb.upper;
    const isBull = roc3Bull > 0.4 && rsi7 < 30 && mfi < 32 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C2_${sym}_GH+ROC0.4+RSI7+MFI68+BB22`, sym, statsC2);

  // C3: All hours + ROC(5)>0.5% + RSI7>73 + MFI70 + BB22 (big 5-candle move)
  const statsC3 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const roc5Bear = (c.close - slice[i - 5].close) / slice[i - 5].close * 100;
    const roc5Bull = (slice[i - 5].close - c.close) / slice[i - 5].close * 100;
    const isBear = roc5Bear > 0.5 && rsi7 > 73 && mfi > 70 && c.close > bb.upper;
    const isBull = roc5Bull > 0.5 && rsi7 < 27 && mfi < 30 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C3_${sym}_AllH+ROC5+0.5+RSI7+MFI70+BB22`, sym, statsC3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D: Retracing from extreme (prev close > curr close, still outside BB)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section D: Retracing from extreme ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // D1: GH + ADX<20 + RSI7>70 + prev close > curr close + both outside BB (peak reached)
  const statsD1 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const prev = slice[i - 1];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    const bbPrev = calcBB(slice.slice(Math.max(0, i - 26), i), 20, 2.2);
    if (!bb || !bbPrev) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    // Bearish: both above upper BB, but current close < previous close (peak in, now retracing)
    const isBear = c.close > bb.upper && prev.close > bbPrev.upper && c.close < prev.close && rsi7 > 70;
    const isBull = c.close < bb.lower && prev.close < bbPrev.lower && c.close > prev.close && rsi7 < 30;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`D1_${sym}_GH+ADX20+RSI7+RetraceFromExtreme+BB22`, sym, statsD1);

  // D2: All hours + same pattern + MFI confirmation
  const statsD2 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const prev = slice[i - 1];
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    const bbPrev = calcBB(slice.slice(Math.max(0, i - 26), i), 20, 2.2);
    if (!bb || !bbPrev) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = c.close > bb.upper && prev.close > bbPrev.upper && c.close < prev.close && rsi7 > 70 && mfi > 68;
    const isBull = c.close < bb.lower && prev.close < bbPrev.lower && c.close > prev.close && rsi7 < 30 && mfi < 32;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`D2_${sym}_AllH+RSI7+MFI68+RetraceFromExtreme+BB22`, sym, statsD2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E: Adaptive RSI percentile (normalized extreme)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section E: Adaptive RSI percentile ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // E1: GH + ADX<20 + RSI7 in top 5% of its 50-period range + at BB22
  const statsE1 = walkForward(candles, (slice, i) => {
    if (i < 70) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    // Build 50-bar RSI7 series for percentile rank
    const rsiHistory = [];
    for (let k = i - 50; k <= i; k++) {
      const r = calcRSI(slice.slice(Math.max(0, k - 10), k + 1), 7);
      rsiHistory.push(r);
    }
    const rsi7now = rsiHistory[rsiHistory.length - 1];
    if (rsi7now === null) return null;
    const rank = pctRank(rsiHistory.filter(v => v !== null), rsi7now);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (mfi === null) return null;
    const isBear = rank > 95 && mfi > 68 && c.close > bb.upper;
    const isBull = rank < 5 && mfi < 32 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`E1_${sym}_GH+ADX20+RSI7pct95+MFI68+BB22`, sym, statsE1);

  // E2: All hours + RSI7 percentile > 90% + MFI70 + BB22
  const statsE2 = walkForward(candles, (slice, i) => {
    if (i < 70) return null;
    const c = slice[i];
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const rsiHistory = [];
    for (let k = i - 50; k <= i; k++) {
      const r = calcRSI(slice.slice(Math.max(0, k - 10), k + 1), 7);
      rsiHistory.push(r);
    }
    const rsi7now = rsiHistory[rsiHistory.length - 1];
    if (rsi7now === null) return null;
    const rank = pctRank(rsiHistory.filter(v => v !== null), rsi7now);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (mfi === null) return null;
    const isBear = rank > 90 && mfi > 70 && c.close > bb.upper;
    const isBull = rank < 10 && mfi < 30 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`E2_${sym}_AllH+RSI7pct90+MFI70+BB22`, sym, statsE2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F: New hour combos for specific coins
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section F: Targeted hour combos ==');

// F1: ETH with h=[10,11,12] only (tighter 3-hour window)
const ethCandles = COINS.ETH.candles;
const statsF1 = walkForward(ethCandles, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![10, 11, 12].includes(hour)) return null;
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7 === null || mfi === null) return null;
  const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
  const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('F1_ETH_h=[10,11,12]+ADX20+RSI7+MFI68+BB22', 'ETH', statsF1);

// F2: BTC with h=[12,13] only (peak US/EU overlap)
const btcCandles = COINS.BTC.candles;
const statsF2 = walkForward(btcCandles, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![12, 13].includes(hour)) return null;
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7 === null || mfi === null) return null;
  const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
  const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('F2_BTC_h=[12,13]+ADX20+RSI7+MFI68+BB22', 'BTC', statsF2);

// F3: SOL with h=[0,12,13,20] + looser RSI7>68 + MFI65 (existing good hours but lower thresholds)
const solCandles = COINS.SOL.candles;
const statsF3 = walkForward(solCandles, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![0, 12, 13, 20].includes(hour)) return null;
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7 === null || mfi === null) return null;
  const isBear = rsi7 > 68 && mfi > 65 && c.close > bb.upper;
  const isBull = rsi7 < 32 && mfi < 35 && c.close < bb.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('F3_SOL_GH+ADX20+RSI7>68+MFI65+BB22', 'SOL', statsF3);

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
console.log('=== GOOD: WR>=70%, n>=8 ===');
console.log('=======================================================');
const good = results.filter(r => r.wr >= 0.70 && r.n >= 8).sort((a, b) => b.wr - a.wr);
if (good.length === 0) {
  console.log('  (none)');
} else {
  for (const r of good) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

console.log('\n=======================================================');
console.log('=== ALL >= 65%, n>=5 ===');
console.log('=======================================================');
const all = results.filter(r => r.wr >= 0.65 && r.n >= 5).sort((a, b) => b.wr - a.wr);
if (all.length === 0) {
  console.log('  (none)');
} else {
  for (const r of all) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

db.close();
