/**
 * Session 20: BB Deviation Threshold + Volume Ratio + StochRSI for ETH
 *
 * Goals:
 * A) Test StochRSI-K pattern (strat 110 style) for ETH — was only validated for BTC/XRP
 * B) Min BB deviation filter: require price N% outside band (stronger signal = higher WR)
 * C) Volume ratio patterns: current vol > N * avg_vol (spike = reversal)
 * D) ADX<15 ultra-ranging filter (tighter than <20)
 * E) Combined deviation + volume: the strongest exhaustion signal
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

// StochRSI: K = stochastic of RSI values
function calcStochRSI(candles, rsiPeriod = 14, stochPeriod = 14) {
  if (candles.length < rsiPeriod + stochPeriod + 5) return { k: 50, d: 50 };
  // Build RSI series for the window
  const rsiSeries = [];
  for (let i = rsiPeriod; i < candles.length; i++) {
    const r = calcRSI(candles.slice(0, i + 1), rsiPeriod);
    if (r !== null) rsiSeries.push(r);
  }
  if (rsiSeries.length < stochPeriod) return { k: 50, d: 50 };
  const window = rsiSeries.slice(-stochPeriod);
  const maxRSI = Math.max(...window), minRSI = Math.min(...window);
  if (maxRSI === minRSI) return { k: 50, d: 50 };
  const k = ((rsiSeries[rsiSeries.length - 1] - minRSI) / (maxRSI - minRSI)) * 100;
  // Simplified D as 3-period average of K (need prev K values)
  const kArr = [];
  for (let j = Math.max(0, rsiSeries.length - 3); j < rsiSeries.length; j++) {
    const w = rsiSeries.slice(Math.max(0, j - stochPeriod + 1), j + 1);
    const mx = Math.max(...w), mn = Math.min(...w);
    if (mx === mn) { kArr.push(50); continue; }
    kArr.push(((rsiSeries[j] - mn) / (mx - mn)) * 100);
  }
  const d = kArr.reduce((a, b) => a + b, 0) / kArr.length;
  return { k, d };
}

// Average volume over last N candles
function avgVolume(candles, period = 20) {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + c.volume, 0) / period;
}

// Walk-forward validation - correct tpd formula
function walkForward(candles, signalFn, folds = 5) {
  const step = Math.floor(candles.length / folds);
  const foldWRs = [];
  let totalN = 0;
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
    totalN += total;
    if (total >= 3) foldWRs.push({ wr: wins / total, n: total });
  }
  if (foldWRs.length < 3) return null;
  const medianWR = foldWRs.map(f => f.wr).sort((a, b) => a - b)[Math.floor(foldWRs.length / 2)];
  const totalDays = candles.length * 5 / (60 * 24); // minutes / 1440 min/day
  const tpd = parseFloat((totalN / totalDays).toFixed(2));
  return { wr: medianWR, n: totalN, tpd };
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
// Section A: StochRSI-K for ETH (strat 110 exact pattern)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section A: StochRSI for ETH/SOL ==');

for (const sym of ['ETH', 'SOL']) {
  const { candles, goodHours } = COINS[sym];

  // A1: ETH GH + ADX<20 + StochRSI-K>85 + MFI72 + RSI14>68 + BB22 (strat 110 exact for ETH)
  const statsA1 = walkForward(candles, (slice, i) => {
    if (i < 50) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const srsi = calcStochRSI(slice.slice(Math.max(0, i - 40), i + 1), 14, 14);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    const rsi14 = calcRSI(slice.slice(Math.max(0, i - 18), i + 1), 14);
    if (mfi === null || rsi14 === null) return null;
    const isBear = srsi.k > 85 && mfi > 72 && rsi14 > 68 && c.close > bbNow.upper;
    const isBull = srsi.k < 15 && mfi < 28 && rsi14 < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A1_${sym}_GH+ADX20+StochRSI85+MFI72+RSI14+BB22`, sym, statsA1);

  // A2: ETH GH + ADX<20 + StochRSI-K>85 + MFI72 + RSI14>68 + BB18
  const statsA2 = walkForward(candles, (slice, i) => {
    if (i < 50) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 1.8);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const srsi = calcStochRSI(slice.slice(Math.max(0, i - 40), i + 1), 14, 14);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    const rsi14 = calcRSI(slice.slice(Math.max(0, i - 18), i + 1), 14);
    if (mfi === null || rsi14 === null) return null;
    const isBear = srsi.k > 85 && mfi > 72 && rsi14 > 68 && c.close > bbNow.upper;
    const isBull = srsi.k < 15 && mfi < 28 && rsi14 < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A2_${sym}_GH+ADX20+StochRSI85+MFI72+RSI14+BB18`, sym, statsA2);

  // A3: ETH GH + ADX<20 + StochRSI-K>80 + MFI68 + BB22 (looser)
  const statsA3 = walkForward(candles, (slice, i) => {
    if (i < 50) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const srsi = calcStochRSI(slice.slice(Math.max(0, i - 40), i + 1), 14, 14);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (mfi === null) return null;
    const isBear = srsi.k > 80 && mfi > 68 && c.close > bbNow.upper;
    const isBull = srsi.k < 20 && mfi < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A3_${sym}_GH+ADX20+StochRSI80+MFI68+BB22`, sym, statsA3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B: BB deviation threshold sweep
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section B: Min BB deviation filter ==');

// How much must price be outside the BB band?
// dev% = (close - upper) / upper * 100 for bear signals
const devThresholds = [0.0, 0.05, 0.10, 0.15, 0.20];

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  for (const minDev of devThresholds) {
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
      const bearDev = (c.close - bbNow.upper) / bbNow.upper * 100;
      const bullDev = (bbNow.lower - c.close) / bbNow.lower * 100;
      const isBear = rsi7 > 73 && mfi > 70 && bearDev >= minDev;
      const isBull = rsi7 < 27 && mfi < 30 && bullDev >= minDev;
      if (isBear) return 'bear';
      if (isBull) return 'bull';
      return null;
    });
    addResult(`B_${sym}_GH+ADX20+RSI7+MFI70+BB22_dev>=${minDev}%`, sym, stats);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C: Volume ratio patterns
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section C: Volume ratio (vol spike) ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // C1: GH + ADX<20 + RSI7>73 + MFI70 + BB22 + vol > 1.5x avg
  const statsC1 = walkForward(candles, (slice, i) => {
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
    const avgVol = avgVolume(slice.slice(Math.max(0, i - 21), i), 20);
    if (avgVol === 0) return null;
    const volRatio = c.volume / avgVol;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bbNow.upper && volRatio > 1.5;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bbNow.lower && volRatio > 1.5;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C1_${sym}_GH+ADX20+RSI7+MFI70+BB22+vol1.5x`, sym, statsC1);

  // C2: GH + ADX<20 + RSI7>70 + BB22 + vol > 2.0x avg (strong spike)
  const statsC2 = walkForward(candles, (slice, i) => {
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
    if (rsi7 === null) return null;
    const avgVol = avgVolume(slice.slice(Math.max(0, i - 21), i), 20);
    if (avgVol === 0) return null;
    const volRatio = c.volume / avgVol;
    const isBear = rsi7 > 70 && c.close > bbNow.upper && volRatio > 2.0;
    const isBull = rsi7 < 30 && c.close < bbNow.lower && volRatio > 2.0;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C2_${sym}_GH+ADX20+RSI7+BB22+vol2.0x`, sym, statsC2);

  // C3: All hours + RSI7>73 + MFI70 + BB22 + vol > 2.0x (volume-driven all hours)
  const statsC3 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const avgVol = avgVolume(slice.slice(Math.max(0, i - 21), i), 20);
    if (avgVol === 0) return null;
    const volRatio = c.volume / avgVol;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bbNow.upper && volRatio > 2.0;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bbNow.lower && volRatio > 2.0;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C3_${sym}_AllH+RSI7+MFI70+BB22+vol2.0x`, sym, statsC3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D: ADX<15 ultra-ranging filter
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section D: ADX<15 ultra-ranging ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // D1: GH + ADX<15 + RSI7>73 + MFI70 + BB22
  const statsD1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 15) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`D1_${sym}_GH+ADX15+RSI7+MFI70+BB22`, sym, statsD1);

  // D2: All hours + ADX<15 + RSI7>73 + MFI70 + BB22
  const statsD2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 15) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`D2_${sym}_AllH+ADX15+RSI7+MFI70+BB22`, sym, statsD2);

  // D3: GH + ADX<15 + RSI7>70 + BB22 (looser oscillator for more volume)
  const statsD3 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 15) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    const isBear = rsi7 > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`D3_${sym}_GH+ADX15+RSI7>70+BB22`, sym, statsD3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E: Combined deviation + volume (strongest exhaustion)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section E: Deviation + Volume combined ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // E1: GH + RSI7>70 + MFI68 + BB22 + dev>=0.10% + vol>1.5x
  const statsE1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const avgVol = avgVolume(slice.slice(Math.max(0, i - 21), i), 20);
    if (avgVol === 0) return null;
    const volRatio = c.volume / avgVol;
    const bearDev = (c.close - bbNow.upper) / bbNow.upper * 100;
    const bullDev = (bbNow.lower - c.close) / bbNow.lower * 100;
    const isBear = rsi7 > 70 && mfi > 68 && bearDev >= 0.10 && volRatio > 1.5;
    const isBull = rsi7 < 30 && mfi < 32 && bullDev >= 0.10 && volRatio > 1.5;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`E1_${sym}_GH+RSI7+MFI68+BB22+dev0.1+vol1.5x`, sym, statsE1);

  // E2: GH + ADX<20 + RSI7>70 + MFI68 + BB22 + dev>=0.10%
  const statsE2 = walkForward(candles, (slice, i) => {
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
    const bearDev = (c.close - bbNow.upper) / bbNow.upper * 100;
    const bullDev = (bbNow.lower - c.close) / bbNow.lower * 100;
    const isBear = rsi7 > 70 && mfi > 68 && bearDev >= 0.10;
    const isBull = rsi7 < 30 && mfi < 32 && bullDev >= 0.10;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`E2_${sym}_GH+ADX20+RSI7+MFI68+BB22+dev0.1`, sym, statsE2);

  // E3: GH + ADX<20 + RSI7>70 + MFI68 + BB22 + dev>=0.15%
  const statsE3 = walkForward(candles, (slice, i) => {
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
    const bearDev = (c.close - bbNow.upper) / bbNow.upper * 100;
    const bullDev = (bbNow.lower - c.close) / bbNow.lower * 100;
    const isBear = rsi7 > 70 && mfi > 68 && bearDev >= 0.15;
    const isBull = rsi7 < 30 && mfi < 32 && bullDev >= 0.15;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`E3_${sym}_GH+ADX20+RSI7+MFI68+BB22+dev0.15`, sym, statsE3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F: RSI3 extreme patterns for all coins
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section F: RSI3 extreme patterns ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // F1: GH + ADX<20 + RSI3>95 + MFI68 + BB22
  const statsF1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi3 = calcRSI(slice.slice(Math.max(0, i - 7), i + 1), 3);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi3 === null || mfi === null) return null;
    const isBear = rsi3 > 95 && mfi > 68 && c.close > bbNow.upper;
    const isBull = rsi3 < 5 && mfi < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`F1_${sym}_GH+ADX20+RSI3>95+MFI68+BB22`, sym, statsF1);

  // F2: GH + ADX<20 + RSI3>90 + RSI7>70 + BB22 (double RSI confirm)
  const statsF2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi3 = calcRSI(slice.slice(Math.max(0, i - 7), i + 1), 3);
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi3 === null || rsi7 === null) return null;
    const isBear = rsi3 > 90 && rsi7 > 70 && c.close > bbNow.upper;
    const isBull = rsi3 < 10 && rsi7 < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`F2_${sym}_GH+ADX20+RSI3+RSI7+BB22`, sym, statsF2);

  // F3: All hours + RSI3>95 + MFI72 + BB22 (not just good hours)
  const statsF3 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi3 = calcRSI(slice.slice(Math.max(0, i - 7), i + 1), 3);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi3 === null || mfi === null) return null;
    const isBear = rsi3 > 95 && mfi > 72 && c.close > bbNow.upper;
    const isBull = rsi3 < 5 && mfi < 28 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`F3_${sym}_AllH+RSI3>95+MFI72+BB22`, sym, statsF3);
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
console.log('=== Section B: BB Deviation sweep results ===');
console.log('=======================================================');
for (const sym of ['ETH', 'BTC', 'SOL', 'XRP']) {
  const bResults = results.filter(r => r.label.startsWith(`B_${sym}`));
  if (bResults.length === 0) continue;
  console.log(`\n  ${sym} deviation sweep:`);
  for (const r of bResults) {
    const minDev = r.label.match(/dev>=([\d.]+)/)?.[1] || '?';
    const tag = r.wr >= 0.75 ? ' 🔥' : r.wr >= 0.70 ? ' ✓' : '';
    console.log(`    dev>=${minDev}% | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
  }
}

console.log('\n=======================================================');
console.log('=== Section D: ADX<15 results ===');
console.log('=======================================================');
const dResults = results.filter(r => r.label.includes('ADX15') && r.n >= 5);
dResults.sort((a, b) => b.wr - a.wr);
for (const r of dResults) {
  const tag = r.wr >= 0.75 ? ' 🔥' : r.wr >= 0.70 ? ' ✓' : '';
  console.log(`  ${r.label} | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
}

console.log('\n=======================================================');
console.log('=== ALL: WR>=65%, n>=5 (any) ===');
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
