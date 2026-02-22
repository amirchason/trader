/**
 * Session 24: Cross-Coin Confirmation + SOL Synth-15m + Regime Detection
 *
 * New dimensions:
 * A) Cross-coin: ETH signal is stronger when BTC also shows extremes at same time
 *    - If BOTH ETH and BTC are overbought simultaneously, both may revert more reliably
 * B) SOL synth-15m tighter: synthetic 15m RSI confirms 5m signal
 * C) Regime detection: only trade during "optimal volatility" (ATR percentile in sweet spot)
 * D) Close-only 15m candle comparison: what if we only trade when 15m agrees with 5m?
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

// ATR for volatility regime detection
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let atr = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    atr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return (atr / period) / candles[candles.length - 1].close * 100; // As % of price
}

// Synth 15m candle from 3 consecutive 5m candles
function getSynth15m(candles5m, idx) {
  // Group index idx, idx-1, idx-2 → synthetic 15m candle
  if (idx < 2) return null;
  const c0 = candles5m[idx - 2];
  const c1 = candles5m[idx - 1];
  const c2 = candles5m[idx];
  return {
    open: c0.open,
    high: Math.max(c0.high, c1.high, c2.high),
    low: Math.min(c0.low, c1.low, c2.low),
    close: c2.close,
    volume: c0.volume + c1.volume + c2.volume,
    closeTime: c2.closeTime,
  };
}

// Build array of synth-15m candles from 5m array (only every 3rd aligned candle)
function buildSynth15mArr(candles5m) {
  const synth = [];
  for (let i = 2; i < candles5m.length; i += 3) {
    synth.push(getSynth15m(candles5m, i));
  }
  return synth;
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
const COINS_DATA = {
  ETH: { candles: loadCandles('ETH'), goodHours: [10, 11, 12, 21] },
  BTC: { candles: loadCandles('BTC'), goodHours: [1, 12, 13, 16, 20] },
  SOL: { candles: loadCandles('SOL'), goodHours: [0, 12, 13, 20] },
  XRP: { candles: loadCandles('XRP'), goodHours: [6, 9, 12, 18] },
};

// Build a lookup by open_time for cross-coin correlation
const btcByTime = {};
for (const c of COINS_DATA.BTC.candles) btcByTime[c.openTime] = c;
const ethByTime = {};
for (const c of COINS_DATA.ETH.candles) ethByTime[c.openTime] = c;
const solByTime = {};
for (const c of COINS_DATA.SOL.candles) solByTime[c.openTime] = c;

for (const [sym, d] of Object.entries(COINS_DATA)) {
  console.log(`  ${sym}: ${d.candles.length} candles`);
}

const results = [];
function addResult(label, sym, stats) {
  if (!stats) return;
  const emoji = stats.wr >= 0.80 ? '🔥🔥🔥' : stats.wr >= 0.75 ? '🔥🔥' : stats.wr >= 0.70 ? '🔥' : '';
  results.push({ label, sym, wr: stats.wr, n: stats.n, tpd: stats.tpd, emoji });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A: Cross-coin confirmation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section A: Cross-coin confirmation ==');

// A1: ETH signal (GH+ADX20+RSI7>70+MFI68+BB22) CONFIRMED by BTC also overbought (RSI7>65)
const ethCandlesA = COINS_DATA.ETH.candles;
const btcCandlesA = COINS_DATA.BTC.candles;

const statsA1_eth = walkForward(ethCandlesA, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![10, 11, 12, 21].includes(hour)) return null;
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7eth = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7eth === null || mfi === null) return null;
  // Cross-coin: check BTC RSI7 at same time
  const btcCandle = btcByTime[c.openTime];
  if (!btcCandle) return null;
  // Find BTC in the full series around same time
  const btcIdx = btcCandlesA.findIndex(bc => bc.openTime === c.openTime);
  if (btcIdx < 12) return null;
  const rsi7btc = calcRSI(btcCandlesA.slice(Math.max(0, btcIdx - 10), btcIdx + 1), 7);
  if (rsi7btc === null) return null;
  const isBear = rsi7eth > 70 && mfi > 68 && c.close > bb.upper && rsi7btc > 65;
  const isBull = rsi7eth < 30 && mfi < 32 && c.close < bb.lower && rsi7btc < 35;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('A1_ETH_GH+ADX20+RSI7+MFI68+BB22+BTC_RSI7>65', 'ETH', statsA1_eth);

// A2: ETH signal confirmed by BTC RSI7>70 (both extreme)
const statsA2_eth = walkForward(ethCandlesA, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![10, 11, 12, 21].includes(hour)) return null;
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7eth = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7eth === null || mfi === null) return null;
  const btcIdx = btcCandlesA.findIndex(bc => bc.openTime === c.openTime);
  if (btcIdx < 12) return null;
  const rsi7btc = calcRSI(btcCandlesA.slice(Math.max(0, btcIdx - 10), btcIdx + 1), 7);
  if (rsi7btc === null) return null;
  const isBear = rsi7eth > 70 && mfi > 68 && c.close > bb.upper && rsi7btc > 70;
  const isBull = rsi7eth < 30 && mfi < 32 && c.close < bb.lower && rsi7btc < 30;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('A2_ETH_GH+ADX20+RSI7+MFI68+BB22+BTC_RSI7>70', 'ETH', statsA2_eth);

// A3: BTC signal confirmed by ETH also overbought
const statsA3_btc = walkForward(btcCandlesA, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![1, 12, 13, 16, 20].includes(hour)) return null;
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7btc = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7btc === null || mfi === null) return null;
  const ethIdx = ethCandlesA.findIndex(ec => ec.openTime === c.openTime);
  if (ethIdx < 12) return null;
  const rsi7eth = calcRSI(ethCandlesA.slice(Math.max(0, ethIdx - 10), ethIdx + 1), 7);
  if (rsi7eth === null) return null;
  const isBear = rsi7btc > 70 && mfi > 68 && c.close > bb.upper && rsi7eth > 65;
  const isBull = rsi7btc < 30 && mfi < 32 && c.close < bb.lower && rsi7eth < 35;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('A3_BTC_GH+ADX20+RSI7+MFI68+BB22+ETH_RSI7>65', 'BTC', statsA3_btc);

// A4: SOL signal confirmed by ETH overbought (SOL often follows ETH)
const solCandlesA = COINS_DATA.SOL.candles;
const statsA4_sol = walkForward(solCandlesA, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![0, 12, 13, 20].includes(hour)) return null;
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
  if (adx >= 20) return null;
  const rsi7sol = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7sol === null || mfi === null) return null;
  const ethIdx = ethCandlesA.findIndex(ec => ec.openTime === c.openTime);
  if (ethIdx < 12) return null;
  const rsi7eth = calcRSI(ethCandlesA.slice(Math.max(0, ethIdx - 10), ethIdx + 1), 7);
  if (rsi7eth === null) return null;
  const isBear = rsi7sol > 70 && mfi > 68 && c.close > bb.upper && rsi7eth > 65;
  const isBull = rsi7sol < 30 && mfi < 32 && c.close < bb.lower && rsi7eth < 35;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('A4_SOL_GH+ADX20+RSI7+MFI68+BB22+ETH_RSI7>65', 'SOL', statsA4_sol);

// A5: All hours ETH + BTC both extreme (macro overbought)
const statsA5 = walkForward(ethCandlesA, (slice, i) => {
  if (i < 30) return null;
  const c = slice[i];
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const rsi7eth = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7eth === null || mfi === null) return null;
  const btcIdx = btcCandlesA.findIndex(bc => bc.openTime === c.openTime);
  if (btcIdx < 12) return null;
  const rsi7btc = calcRSI(btcCandlesA.slice(Math.max(0, btcIdx - 10), btcIdx + 1), 7);
  if (rsi7btc === null) return null;
  const isBear = rsi7eth > 73 && mfi > 70 && c.close > bb.upper && rsi7btc > 70;
  const isBull = rsi7eth < 27 && mfi < 30 && c.close < bb.lower && rsi7btc < 30;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('A5_ETH_AllH+RSI7>73+MFI70+BB22+BTC_RSI7>70', 'ETH', statsA5);

// ─────────────────────────────────────────────────────────────────────────────
// Section B: SOL synth-15m tighter patterns
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section B: SOL synth-15m patterns ==');

const solCandles = COINS_DATA.SOL.candles;

// Build synth-15m candles (group every 3 consecutive 5m candles into 1 15m)
// For each 5m candle, find its corresponding 15m candle
function get15mContext(candles5m, idx5m) {
  // Which 15m group does this 5m candle belong to?
  // Group: every 3 consecutive 5m candles = 1 15m
  // We look at the most recent completed 15m group (3 candles before current)
  const start = Math.max(0, idx5m - 5);
  const group = candles5m.slice(start, idx5m - 1);
  if (group.length < 3) return null;
  const last3 = group.slice(-3);
  return {
    open: last3[0].open,
    high: Math.max(...last3.map(c => c.high)),
    low: Math.min(...last3.map(c => c.low)),
    close: last3[last3.length - 1].close,
    volume: last3.reduce((s, c) => s + c.volume, 0),
  };
}

// B1: GH + ADX<20 + SOL 5m RSI7>70+MFI70+BB22 + synth-15m RSI7>65 (confirms trend)
const statsB1 = walkForward(solCandles, (slice, i) => {
  if (i < 40) return null;
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
  // Get synth-15m candle
  const candles15m = [];
  for (let k = i - 35; k <= i - 3; k += 3) {
    if (k < 0) continue;
    const g = slice.slice(k, k + 3);
    if (g.length < 3) continue;
    candles15m.push({
      close: g[2].close, high: Math.max(...g.map(c => c.high)),
      low: Math.min(...g.map(c => c.low)), volume: g.reduce((s, c) => s + c.volume, 0),
      openTime: g[0].openTime
    });
  }
  if (candles15m.length < 8) return null;
  const rsi15m = calcRSI(candles15m, 7);
  if (rsi15m === null) return null;
  const isBear = rsi7 > 70 && mfi > 70 && c.close > bb.upper && rsi15m > 65;
  const isBull = rsi7 < 30 && mfi < 30 && c.close < bb.lower && rsi15m < 35;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('B1_SOL_GH+ADX20+RSI7+MFI70+BB22+15mRSI>65', 'SOL', statsB1);

// B2: SOL GH + synth-15m RSI7>70 + 15m BB22 (use 15m exclusively)
const statsB2 = walkForward(solCandles, (slice, i) => {
  if (i < 60) return null;
  const c = slice[i];
  const hour = new Date(c.closeTime).getUTCHours();
  if (![0, 12, 13, 20].includes(hour)) return null;
  // Build synth 15m candles
  const candles15m = [];
  for (let k = i - 59; k <= i; k += 3) {
    if (k + 2 > i) continue;
    const g = slice.slice(k, k + 3);
    if (g.length < 3) continue;
    candles15m.push({
      close: g[2].close,
      high: Math.max(...g.map(c => c.high)),
      low: Math.min(...g.map(c => c.low)),
      volume: g.reduce((s, c) => s + c.volume, 0),
      openTime: g[0].openTime
    });
  }
  if (candles15m.length < 22) return null;
  const bb15m = calcBB(candles15m, 20, 2.2);
  const rsi15m = calcRSI(candles15m.slice(-10), 7);
  const mfi15m = calcMFI(candles15m.slice(-16), 14);
  if (!bb15m || rsi15m === null || mfi15m === null) return null;
  const last15m = candles15m[candles15m.length - 1];
  const isBear = rsi15m > 70 && mfi15m > 68 && last15m.close > bb15m.upper;
  const isBull = rsi15m < 30 && mfi15m < 32 && last15m.close < bb15m.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
});
addResult('B2_SOL_GH+15m_RSI7+MFI68+BB22', 'SOL', statsB2);

// ─────────────────────────────────────────────────────────────────────────────
// Section C: Volatility regime detection (ATR sweet spot)
// ─────────────────────────────────────────────────────────────────────────────
console.log('== Section C: ATR regime filter ==');

// Only trade when ATR(14) as % of price is in the 20th-60th percentile range
// (not too volatile, not too flat — optimal for mean reversion)
for (const [sym, { candles, goodHours }] of Object.entries(COINS_DATA)) {
  // Build ATR percentile reference
  const allATRs = [];
  for (let i = 20; i < candles.length; i++) {
    const a = calcATR(candles.slice(Math.max(0, i - 18), i + 1), 14);
    if (a !== null) allATRs.push(a);
  }
  allATRs.sort((a, b) => a - b);
  const p20 = allATRs[Math.floor(allATRs.length * 0.20)];
  const p60 = allATRs[Math.floor(allATRs.length * 0.60)];
  console.log(`  ${sym} ATR p20=${p20?.toFixed(3)}% p60=${p60?.toFixed(3)}%`);

  // C1: GH + ADX<20 + RSI7>70 + MFI68 + BB22 + ATR in p20-p60 range
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
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const atr = calcATR(slice.slice(Math.max(0, i - 18), i + 1), 14);
    if (atr === null || atr < p20 || atr > p60) return null;
    const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
    const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C1_${sym}_GH+ADX20+RSI7+MFI68+BB22+ATRsweet`, sym, statsC1);

  // C2: GH + RSI7>70 + MFI68 + BB22 + ATR above p40 (moderate-high volatility)
  const p40 = allATRs[Math.floor(allATRs.length * 0.40)];
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
    const atr = calcATR(slice.slice(Math.max(0, i - 18), i + 1), 14);
    if (atr === null || atr < p40) return null;
    const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
    const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`C2_${sym}_GH+RSI7+MFI68+BB22+ATR>p40`, sym, statsC2);
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
