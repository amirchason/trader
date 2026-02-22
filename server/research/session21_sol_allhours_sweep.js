/**
 * Session 21: SOL All-Hours Push + BTC Streak Variants + Per-Coin Deep Sweep
 *
 * Session 7 found SOL ALL_H+RSI7>75+BB22 at 73.2% WR, 7.2/day — just below 75%
 * Goals:
 * A) SOL all-hours condition sweep: find what pushes WR to 75%+ while keeping ≥5/day
 * B) BTC all-hours variants (streak, RSI thresholds) to complement strat 65
 * C) ETH all-hours variants (can we get more volume at 75%+?)
 * D) Full RSI7 × MFI grid for all coins (sweeping many combinations at all hours)
 * E) CRSI (ConnorsRSI) all-hours variants (strat 72 was 52-56%, can we tighten?)
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

// Streak: count consecutive closes in same direction
// Returns positive for up streak, negative for down streak at current candle
function calcStreak(candles, i) {
  if (i < 1) return 0;
  const dir = candles[i].close > candles[i - 1].close ? 1 : -1;
  let streak = 0;
  for (let j = i; j >= 1; j--) {
    const d = candles[j].close > candles[j - 1].close ? 1 : -1;
    if (d === dir) streak++;
    else break;
  }
  return dir * streak;
}

// Percentile rank for ConnorsRSI
function percentileRank(arr, val) {
  const below = arr.filter(v => v < val).length;
  return (below / arr.length) * 100;
}

// Connors RSI = (RSI(3) + RSI(streak,2) + percentileRank(100)) / 3
function calcCRSI(candles, period = 100) {
  const len = candles.length;
  if (len < period + 5) return null;
  // RSI(3)
  const rsi3 = calcRSI(candles.slice(-6), 3);
  if (rsi3 === null) return null;
  // Streak RSI(2)
  let stk = 0;
  for (let j = len - 1; j >= 1; j--) {
    const d = candles[j].close > candles[j - 1].close ? 1 : -1;
    const prev = candles[j - 1].close > (j >= 2 ? candles[j - 2].close : candles[j - 1].close) ? 1 : -1;
    if (d === prev) stk += d;
    else { stk = d; break; }
  }
  const streakRSI = calcRSI([
    { close: 0 }, { close: Math.abs(stk) > 0 ? 1 : 0 }, { close: Math.abs(stk) }
  ], 2);
  // Percent rank of last 100 returns
  const returns = [];
  for (let j = len - period; j < len; j++) {
    returns.push((candles[j].close - candles[j - 1].close) / candles[j - 1].close * 100);
  }
  const lastReturn = returns[returns.length - 1];
  const pRank = percentileRank(returns, lastReturn);
  if (streakRSI === null) return rsi3; // fallback
  return (rsi3 + streakRSI + pRank) / 3;
}

// Walk-forward validation with correct tpd
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
  const totalDays = candles.length * 5 / (60 * 24);
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
// Section A: SOL all-hours condition sweep
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section A: SOL all-hours sweeps ==');
const solCandles = COINS.SOL.candles;

// A1: All hours RSI7>N + BB22 (sweep N=70,73,75,77,80)
for (const rsiThresh of [68, 70, 72, 73, 74, 75, 77, 80]) {
  const stats = walkForward(solCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    const isBear = rsi7 > rsiThresh && c.close > bbNow.upper;
    const isBull = rsi7 < (100 - rsiThresh) && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A1_SOL_AllH+RSI7>${rsiThresh}+BB22`, 'SOL', stats);
}

// A2: All hours RSI7>73 + MFI>N + BB22 (MFI sweep)
for (const mfiThresh of [60, 63, 65, 68, 70, 72, 75]) {
  const stats = walkForward(solCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > mfiThresh && c.close > bbNow.upper;
    const isBull = rsi7 < 27 && mfi < (100 - mfiThresh) && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A2_SOL_AllH+RSI7>73+MFI>${mfiThresh}+BB22`, 'SOL', stats);
}

// A3: All hours RSI7>73 + MFI>70 + streak>=1 + BB22 (add streak)
for (const streakMin of [1, 2]) {
  const stats = walkForward(solCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const streak = calcStreak(slice, i);
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bbNow.upper && streak <= -streakMin;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bbNow.lower && streak >= streakMin;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A3_SOL_AllH+RSI7>73+MFI>70+s>=${streakMin}+BB22`, 'SOL', stats);
}

// A4: All hours RSI7>73 + ADX<20 + BB22
const statsA4 = walkForward(solCandles, (slice, i) => {
  if (i < 25) return null;
  const c = slice[i];
  const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
  const bbNow = localBB[localBB.length - 1];
  if (!bbNow) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  if (rsi7 === null) return null;
  const isBear = rsi7 > 73 && c.close > bbNow.upper;
  const isBull = rsi7 < 27 && c.close < bbNow.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('A4_SOL_AllH+ADX20+RSI7>73+BB22', 'SOL', statsA4);

// A5: All hours RSI7>70 + MFI>68 + ADX<20 + BB22
const statsA5 = walkForward(solCandles, (slice, i) => {
  if (i < 25) return null;
  const c = slice[i];
  const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
  const bbNow = localBB[localBB.length - 1];
  if (!bbNow) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7 === null || mfi === null) return null;
  const isBear = rsi7 > 70 && mfi > 68 && c.close > bbNow.upper;
  const isBull = rsi7 < 30 && mfi < 32 && c.close < bbNow.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('A5_SOL_AllH+ADX20+RSI7>70+MFI68+BB22', 'SOL', statsA5);

// A6: SOL + BB(20,1.8) all hours
for (const rsiThresh of [70, 73, 75]) {
  const stats = walkForward(solCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 1.8);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > rsiThresh && mfi > 65 && c.close > bbNow.upper;
    const isBull = rsi7 < (100 - rsiThresh) && mfi < 35 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`A6_SOL_AllH+RSI7>${rsiThresh}+MFI65+BB18`, 'SOL', stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B: BTC all-hours sweep
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section B: BTC all-hours sweep ==');
const btcCandles = COINS.BTC.candles;

// B1: BTC all hours RSI7>N + MFI>70 + BB22 sweep
for (const rsiThresh of [70, 73, 75, 77]) {
  const stats = walkForward(btcCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > rsiThresh && mfi > 70 && c.close > bbNow.upper;
    const isBull = rsi7 < (100 - rsiThresh) && mfi < 30 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B1_BTC_AllH+RSI7>${rsiThresh}+MFI70+BB22`, 'BTC', stats);
}

// B2: BTC all hours + streak>=1 + RSI7>70 + BB22 (strat 65 type with streak)
for (const streakMin of [1, 2]) {
  const stats = walkForward(btcCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    const streak = calcStreak(slice, i);
    const isBear = rsi7 > 70 && c.close > bbNow.upper && streak <= -streakMin;
    const isBull = rsi7 < 30 && c.close < bbNow.lower && streak >= streakMin;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B2_BTC_AllH+RSI7>70+s>=${streakMin}+BB22`, 'BTC', stats);
}

// B3: BTC all hours ADX<20 + RSI7>70 + MFI68 + BB22
const statsB3 = walkForward(btcCandles, (slice, i) => {
  if (i < 25) return null;
  const c = slice[i];
  const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
  const bbNow = localBB[localBB.length - 1];
  if (!bbNow) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7 === null || mfi === null) return null;
  const isBear = rsi7 > 70 && mfi > 68 && c.close > bbNow.upper;
  const isBull = rsi7 < 30 && mfi < 32 && c.close < bbNow.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('B3_BTC_AllH+ADX20+RSI7>70+MFI68+BB22', 'BTC', statsB3);

// ─────────────────────────────────────────────────────────────────────────────
// Section C: ETH all-hours additional variants
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section C: ETH all-hours variants ==');
const ethCandles = COINS.ETH.candles;

// C1: ETH all hours RSI7>N + MFI>65 + BB22 sweep
for (const rsiThresh of [70, 72, 73, 75, 77]) {
  const stats = walkForward(ethCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > rsiThresh && mfi > 65 && c.close > bbNow.upper;
    const isBull = rsi7 < (100 - rsiThresh) && mfi < 35 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C1_ETH_AllH+RSI7>${rsiThresh}+MFI65+BB22`, 'ETH', stats);
}

// C2: ETH all hours + streak>=1 + MFI>68 + BB22 (like strat 64 but with MFI)
for (const streakMin of [1, 2]) {
  const stats = walkForward(ethCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const streak = calcStreak(slice, i);
    const isBear = rsi7 > 70 && mfi > 68 && c.close > bbNow.upper && streak <= -streakMin;
    const isBull = rsi7 < 30 && mfi < 32 && c.close < bbNow.lower && streak >= streakMin;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C2_ETH_AllH+RSI7>70+MFI68+s>=${streakMin}+BB22`, 'ETH', stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D: Full RSI7 × MFI grid for all coins (all hours)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section D: RSI7 x MFI grid (all hours, BB22) ==');

const rsiGrid = [68, 70, 72, 73, 75];
const mfiGrid = [62, 65, 68, 70, 72];

for (const [sym, { candles }] of Object.entries(COINS)) {
  let bestWR = 0, bestN = 0, bestLabel = '';
  for (const rsiT of rsiGrid) {
    for (const mfiT of mfiGrid) {
      const stats = walkForward(candles, (slice, i) => {
        if (i < 25) return null;
        const c = slice[i];
        const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
        const bbNow = localBB[localBB.length - 1];
        if (!bbNow) return null;
        const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
        const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
        if (rsi7 === null || mfi === null) return null;
        const isBear = rsi7 > rsiT && mfi > mfiT && c.close > bbNow.upper;
        const isBull = rsi7 < (100 - rsiT) && mfi < (100 - mfiT) && c.close < bbNow.lower;
        if (isBear) return 'bear';
        if (isBull) return 'bull';
        return null;
      });
      if (stats && stats.wr >= 0.75 && stats.n >= 10) {
        addResult(`D_${sym}_AllH+RSI7>${rsiT}+MFI>${mfiT}+BB22`, sym, stats);
      }
      if (stats && stats.wr > bestWR && stats.n >= 10) {
        bestWR = stats.wr; bestN = stats.n;
        bestLabel = `RSI7>${rsiT}+MFI>${mfiT}`;
      }
    }
  }
  console.log(`  ${sym} best in grid: ${bestLabel} WR=${(bestWR * 100).toFixed(1)}% n=${bestN}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E: XRP all-hours sweep
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section E: XRP all-hours sweep ==');
const xrpCandles = COINS.XRP.candles;

for (const rsiThresh of [68, 70, 72, 73, 75, 77]) {
  for (const mfiThresh of [65, 68, 70, 72]) {
    const stats = walkForward(xrpCandles, (slice, i) => {
      if (i < 25) return null;
      const c = slice[i];
      const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
      const bbNow = localBB[localBB.length - 1];
      if (!bbNow) return null;
      const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
      const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
      if (rsi7 === null || mfi === null) return null;
      const isBear = rsi7 > rsiThresh && mfi > mfiThresh && c.close > bbNow.upper;
      const isBull = rsi7 < (100 - rsiThresh) && mfi < (100 - mfiThresh) && c.close < bbNow.lower;
      if (isBear) return 'bear';
      if (isBull) return 'bull';
      return null;
    });
    if (stats && stats.wr >= 0.75 && stats.n >= 10) {
      addResult(`E_XRP_AllH+RSI7>${rsiThresh}+MFI>${mfiThresh}+BB22`, 'XRP', stats);
    }
  }
}

// E2: XRP BB(25,2.2) all hours sweep (XRP best BB params)
for (const rsiThresh of [70, 73, 75]) {
  const stats = walkForward(xrpCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const localBB = calcBB(slice.slice(Math.max(0, i - 30), i + 1), 25, 2.2);
    const bbNow = localBB[localBB.length - 1];
    if (!bbNow) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > rsiThresh && mfi > 68 && c.close > bbNow.upper;
    const isBull = rsi7 < (100 - rsiThresh) && mfi < 32 && c.close < bbNow.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`E2_XRP_AllH+RSI7>${rsiThresh}+MFI68+BB25`, 'XRP', stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10, tpd>=0.3 ===');
console.log('=======================================================');
const winners = results.filter(r => r.wr >= 0.75 && r.n >= 10 && r.tpd >= 0.3).sort((a, b) => b.wr - a.wr);
if (winners.length === 0) {
  console.log('  (none with tpd>=0.3)');
  const winnersLow = results.filter(r => r.wr >= 0.75 && r.n >= 10).sort((a, b) => b.wr - a.wr);
  if (winnersLow.length > 0) {
    console.log('  But WR>=75% n>=10 (any tpd):');
    for (const r of winnersLow) {
      console.log(`    ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
    }
  }
} else {
  for (const r of winners) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

console.log('\n=======================================================');
console.log('=== Section A: SOL all-hours sweep ===');
console.log('=======================================================');
const aResults = results.filter(r => r.label.startsWith('A'));
for (const r of aResults.sort((a, b) => b.wr - a.wr).slice(0, 15)) {
  const tag = r.wr >= 0.75 ? ' 🔥' : r.wr >= 0.70 ? ' ✓' : '';
  console.log(`  ${r.label} | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
}

console.log('\n=======================================================');
console.log('=== Section B/C: BTC/ETH all-hours sweep ===');
console.log('=======================================================');
const bcResults = results.filter(r => r.label.startsWith('B') || r.label.startsWith('C'));
for (const r of bcResults.sort((a, b) => b.wr - a.wr).slice(0, 10)) {
  const tag = r.wr >= 0.75 ? ' 🔥' : r.wr >= 0.70 ? ' ✓' : '';
  console.log(`  ${r.label} | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
}

console.log('\n=======================================================');
console.log('=== ALL >= 70% WR, n>=10 ===');
console.log('=======================================================');
const allGood = results.filter(r => r.wr >= 0.70 && r.n >= 10).sort((a, b) => b.wr - a.wr);
if (allGood.length === 0) {
  console.log('  (none)');
} else {
  for (const r of allGood) {
    const tag = r.wr >= 0.75 ? ' 🔥🔥' : '✓';
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${tag}`);
  }
}

db.close();
