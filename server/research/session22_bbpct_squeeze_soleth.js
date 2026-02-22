/**
 * Session 22: BB %B Position + BB Squeeze + SOL with ETH Hours
 *
 * New angles not yet explored:
 * A) BB %B position filter: %B = (close-lower)/(upper-lower); >1.2 = 20% beyond band
 *    — more selective than just "close > upper", should give higher WR
 * B) BB Bandwidth squeeze + breakout reversion
 *    — BB was narrow N candles ago (squeeze), now price broke out (overextended) → fade
 * C) SOL with ETH good hours [10,11,12,21] — SOL often moves with ETH
 * D) XRP expanded hours: h=[6,9,12,14,18] (adding h=14 from session18 hint)
 * E) Systematic 2-hour combos for SOL: find the top 3-4 hour pairs at WR>=70%
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

function calcBBFull(candles, period = 20, mult = 2.2) {
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
    const upper = mid + mult * std;
    const lower = mid - mult * std;
    const bw = (upper - lower) / mid; // bandwidth as fraction of mid
    const pctB = (closes[i] - lower) / (upper - lower); // %B
    result.push({ upper, lower, mid, std, bw, pctB });
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
// Section A: BB %B position filter
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section A: BB %B position filter ==');

// %B > 1.0 = outside upper band (same as our existing trigger)
// %B > 1.1 = 10% beyond upper band
// %B > 1.2 = 20% beyond upper band (more extreme = higher WR?)
// %B > 1.5 = 50% beyond upper band (very extreme, rare)

const pctBThresholds = [1.0, 1.1, 1.15, 1.2, 1.3, 1.5];

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  for (const pctBThresh of pctBThresholds) {
    // GH + ADX<20 + RSI7>70 + %B > thresh
    const stats = walkForward(candles, (slice, i) => {
      if (i < 30) return null;
      const c = slice[i];
      const hour = new Date(c.closeTime).getUTCHours();
      if (!goodHours.includes(hour)) return null;
      const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
      const bb = localBB[localBB.length - 1];
      if (!bb) return null;
      const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
      if (adx >= 20) return null;
      const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
      const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
      if (rsi7 === null || mfi === null) return null;
      const isBear = rsi7 > 70 && mfi > 68 && bb.pctB > pctBThresh;
      const isBull = rsi7 < 30 && mfi < 32 && (1 - bb.pctB) > (pctBThresh - 1.0); // symmetric for lower band
      if (isBear) return 'bear';
      if (isBull) return 'bull';
      return null;
    });
    addResult(`A_${sym}_GH+ADX20+RSI7+MFI68+pctB>${pctBThresh}`, sym, stats);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B: BB Bandwidth squeeze + breakout reversion
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section B: BB Bandwidth squeeze + reversion ==');

// Strategy: bandwidth N candles ago was < squeeze_threshold (tight bands)
// Now price is outside the band = breakout after squeeze = expect fade

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // B1: GH + BB was narrow 5 candles ago (bw < 0.005 = 0.5% of price) + now outside band + RSI7>70
  const statsB1 = walkForward(candles, (slice, i) => {
    if (i < 35) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    // Compute BB for current candle
    const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bb = localBB[localBB.length - 1];
    if (!bb) return null;
    // Compute BB bandwidth 8 candles ago
    const oldBB = calcBBFull(slice.slice(Math.max(0, i - 38), i - 7), 20, 2.2);
    const bbOld = oldBB[oldBB.length - 1];
    if (!bbOld) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    if (rsi7 === null) return null;
    // Was there a squeeze? (bandwidth < 0.5% of price)
    const hadSqueeze = bbOld.bw < 0.005;
    const isBear = hadSqueeze && rsi7 > 70 && c.close > bb.upper;
    const isBull = hadSqueeze && rsi7 < 30 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B1_${sym}_GH+Squeeze5ago+RSI7+BB22`, sym, statsB1);

  // B2: Same + MFI confirmation + no ADX filter (squeeze already means ranging)
  const statsB2 = walkForward(candles, (slice, i) => {
    if (i < 35) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bb = localBB[localBB.length - 1];
    if (!bb) return null;
    // Squeeze: bandwidth minimum over last 10-5 candles
    let minBW = Infinity;
    for (let k = i - 10; k <= i - 5; k++) {
      if (k < 25) continue;
      const kBB = calcBBFull(slice.slice(Math.max(0, k - 25), k + 1), 20, 2.2);
      const bk = kBB[kBB.length - 1];
      if (bk && bk.bw < minBW) minBW = bk.bw;
    }
    if (minBW > 0.006) return null; // No squeeze
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
    const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B2_${sym}_GH+Squeeze10ago+RSI7+MFI68+BB22`, sym, statsB2);

  // B3: All hours + squeeze + RSI7>73 + MFI70 + BB22 (higher thresholds to compensate for no hour filter)
  const statsB3 = walkForward(candles, (slice, i) => {
    if (i < 35) return null;
    const c = slice[i];
    const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bb = localBB[localBB.length - 1];
    if (!bb) return null;
    let minBW = Infinity;
    for (let k = i - 10; k <= i - 3; k++) {
      if (k < 25) continue;
      const kBB = calcBBFull(slice.slice(Math.max(0, k - 25), k + 1), 20, 2.2);
      const bk = kBB[kBB.length - 1];
      if (bk && bk.bw < minBW) minBW = bk.bw;
    }
    if (minBW > 0.006) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bb.upper;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`B3_${sym}_AllH+Squeeze+RSI7>73+MFI70+BB22`, sym, statsB3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C: SOL with ETH good hours [10,11,12,21]
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section C: SOL with alternative good hours ==');

const solCandles = COINS.SOL.candles;
const ethGoodHours = [10, 11, 12, 21];
const btcGoodHours = [1, 12, 13, 16, 20];
const combinedHours = [0, 1, 10, 11, 12, 13, 20, 21]; // merge ETH+SOL+BTC

const hourTests = [
  { name: 'ETH_hours[10,11,12,21]', hours: [10, 11, 12, 21] },
  { name: 'BTC_hours[1,12,13,16,20]', hours: [1, 12, 13, 16, 20] },
  { name: 'Combined_hours[0,1,10,11,12,13,20,21]', hours: [0, 1, 10, 11, 12, 13, 20, 21] },
  { name: 'US_EU_overlap[12,13,14]', hours: [12, 13, 14] },
  { name: 'Asia_open[0,1,2]', hours: [0, 1, 2] },
  { name: 'EU_open[7,8,9]', hours: [7, 8, 9] },
  { name: 'Lunch_dip[11,12,13]', hours: [11, 12, 13] },
  { name: 'NY_pm[19,20,21]', hours: [19, 20, 21] },
];

for (const test of hourTests) {
  // Base RSI7+MFI+BB22 with the test hours
  const stats = walkForward(solCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!test.hours.includes(hour)) return null;
    const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bb = localBB[localBB.length - 1];
    if (!bb) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bb.upper;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C_SOL_${test.name}+ADX20+RSI7>73+MFI70+BB22`, 'SOL', stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D: XRP expanded hours (adding h=14 from session 18 hint)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section D: XRP expanded/alternative hours ==');

const xrpCandles = COINS.XRP.candles;
const xrpHourTests = [
  { name: 'XRP_[6,9,12,14,18]', hours: [6, 9, 12, 14, 18] },
  { name: 'XRP_[6,9,12,13,18]', hours: [6, 9, 12, 13, 18] },
  { name: 'XRP_[5,6,9,12,18,19]', hours: [5, 6, 9, 12, 18, 19] },
  { name: 'XRP_[h14only]', hours: [14] },
  { name: 'XRP_[13,14,15]', hours: [13, 14, 15] },
  { name: 'XRP_[US_hours_12-20]', hours: [12, 13, 14, 15, 16, 17, 18, 19, 20] },
  { name: 'XRP_AllH', hours: Array.from({length: 24}, (_, i) => i) },
];

for (const test of xrpHourTests) {
  const stats = walkForward(xrpCandles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!test.hours.includes(hour)) return null;
    const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 25, 2.2);
    const bb = localBB[localBB.length - 1];
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
  addResult(`D_${test.name}+ADX20+RSI7>70+MFI68+BB25`, 'XRP', stats);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E: Systematic 2-hour combo scan for SOL + XRP
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section E: 2-hour combo scan for SOL+XRP ==');

// Test all C(12, 2) = 66 "active hour" pairs from the top 12 hours (by volume typically)
const topHours = [0, 1, 8, 9, 10, 11, 12, 13, 14, 16, 20, 21];

for (const sym of ['SOL', 'XRP']) {
  const { candles } = COINS[sym];
  const bbMult = sym === 'XRP' ? 2.2 : 2.2;
  let topResults = [];

  for (let a = 0; a < topHours.length; a++) {
    for (let b = a + 1; b < topHours.length; b++) {
      const hours = [topHours[a], topHours[b]];
      const stats = walkForward(candles, (slice, i) => {
        if (i < 25) return null;
        const c = slice[i];
        const hour = new Date(c.closeTime).getUTCHours();
        if (!hours.includes(hour)) return null;
        const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 20, bbMult);
        const bb = localBB[localBB.length - 1];
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
      if (stats && stats.n >= 5) {
        topResults.push({ hours, wr: stats.wr, n: stats.n, tpd: stats.tpd });
      }
    }
  }
  topResults.sort((a, b) => b.wr - a.wr);
  const top5 = topResults.slice(0, 5);
  console.log(`\n  ${sym} top 2-hour pairs:`);
  for (const r of top5) {
    const tag = r.wr >= 0.75 ? ' 🔥🔥' : r.wr >= 0.70 ? ' 🔥' : '';
    console.log(`    h=[${r.hours}] | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
    if (r.wr >= 0.70) {
      addResult(`E_${sym}_h=[${r.hours}]+ADX20+RSI7+MFI68+BB22`, sym, { wr: r.wr, n: r.n, tpd: r.tpd });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F: BB %B + Squeeze combined (the ultimate exhaustion filter)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section F: BB pctB + squeeze combined ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // F1: GH + squeeze within 10 candles + %B > 1.15 + RSI7>70 + MFI68
  const statsF1 = walkForward(candles, (slice, i) => {
    if (i < 40) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const localBB = calcBBFull(slice.slice(Math.max(0, i - 30), i + 1), 20, 2.2);
    const bb = localBB[localBB.length - 1];
    if (!bb) return null;
    // Check for recent squeeze
    let hadSqueeze = false;
    for (let k = i - 12; k <= i - 4; k++) {
      if (k < 25) continue;
      const kBB = calcBBFull(slice.slice(Math.max(0, k - 25), k + 1), 20, 2.2);
      const bk = kBB[kBB.length - 1];
      if (bk && bk.bw < 0.007) { hadSqueeze = true; break; }
    }
    if (!hadSqueeze) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    // %B > 1.15 means 15% beyond upper band
    const isBear = rsi7 > 70 && mfi > 68 && bb.pctB > 1.15;
    const isBull = rsi7 < 30 && mfi < 32 && (1 - bb.pctB) > 0.15;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`F1_${sym}_GH+Squeeze+pctB1.15+RSI7+MFI68`, sym, statsF1);
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
console.log('=== Section A: BB %B results ===');
console.log('=======================================================');
const aResults = results.filter(r => r.label.startsWith('A_'));
for (const r of aResults.sort((a, b) => b.wr - a.wr).slice(0, 12)) {
  const tag = r.wr >= 0.75 ? ' 🔥🔥' : r.wr >= 0.70 ? ' 🔥' : '';
  console.log(`  ${r.label} | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
}

console.log('\n=======================================================');
console.log('=== Section C: SOL alternative hours ===');
console.log('=======================================================');
const cResults = results.filter(r => r.label.startsWith('C_'));
for (const r of cResults.sort((a, b) => b.wr - a.wr)) {
  const tag = r.wr >= 0.75 ? ' 🔥🔥' : r.wr >= 0.70 ? ' 🔥' : '';
  console.log(`  ${r.label} | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
}

console.log('\n=======================================================');
console.log('=== Section D: XRP alternative hours ===');
console.log('=======================================================');
const dResults = results.filter(r => r.label.startsWith('D_'));
for (const r of dResults.sort((a, b) => b.wr - a.wr)) {
  const tag = r.wr >= 0.75 ? ' 🔥🔥' : r.wr >= 0.70 ? ' 🔥' : '';
  console.log(`  ${r.label} | WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd}${tag}`);
}

console.log('\n=======================================================');
console.log('=== ALL: WR>=68%, n>=8 ===');
console.log('=======================================================');
const all = results.filter(r => r.wr >= 0.68 && r.n >= 8).sort((a, b) => b.wr - a.wr);
if (all.length === 0) {
  console.log('  (none)');
} else {
  for (const r of all) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

db.close();
