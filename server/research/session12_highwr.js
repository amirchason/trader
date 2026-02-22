/**
 * SESSION 12 HIGH-WR RESEARCH — Targeting >75% Win Rate
 *
 * Strategy: Combine the proven WR multipliers:
 *   A) Good Hours restriction  (+5-10% WR boost proven across sessions)
 *   B) ADX<20 (ranging market) (+7-10% WR — BTC ADX<20+BB22 = 63.1% all-hours!)
 *   C) Deep thresholds (RSI>75 not >70, etc.)
 *   D) Multiple confirmations (4+ conditions)
 *
 * BTC ADX<20+BB22 = 63.1% all-hours → with GoodH could hit 70-75%+
 * ETH/XRP ADX+GoodH combinations → targeting 70%+
 *
 * Good Hours (UTC):
 *   ETH: [10, 11, 12, 21]
 *   BTC: [1, 12, 13, 16, 20]
 *   SOL: [0, 12, 13, 20]
 *   XRP: [6, 9, 12, 18]
 *
 * Correct binary exit: next 5m candle close direction (fixed-expiry)
 * Fee: 2% spread → breakeven WR ≈ 51%
 * 5-fold walk-forward validation, median WR reported
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

const GOOD_HOURS = {
  ETH: new Set([10, 11, 12, 21]),
  BTC: new Set([1, 12, 13, 16, 20]),
  SOL: new Set([0, 12, 13, 20]),
  XRP: new Set([6, 9, 12, 18]),
};

function getHourUTC(ts) {
  return Math.floor(ts / (1000 * 60 * 60)) % 24;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

function loadCandles(symbol, tf = '5m') {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume
     FROM candles WHERE symbol = ? AND timeframe = ?
     ORDER BY open_time ASC`
  ).all(symbol, tf).map(r => ({
    t: r.open_time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

// ─── Indicator series helpers ─────────────────────────────────────────────────

function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return out;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgG += d; else avgL -= d;
  }
  avgG /= period; avgL /= period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(0, d)) / period;
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function smaSeries(arr, period) {
  const out = new Array(arr.length).fill(0);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    out[i] = i >= period - 1 ? sum / period : arr[0];
  }
  return out;
}

function stdSeries(closes, smaArr, period) {
  const out = new Array(closes.length).fill(0);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - smaArr[i]) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
}

function atrSeries(candles, period) {
  const out = new Array(candles.length).fill(0);
  let atr = 0;
  for (let i = 1; i <= period && i < candles.length; i++) {
    atr += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
  }
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

function adxSeries(candles, period) {
  const n = candles.length;
  const adx = new Array(n).fill(25);
  if (n < period * 2) return adx;

  const trArr = [], pmDM = [], nmDM = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    trArr.push(tr);
    pmDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nmDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let sTR = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPM = pmDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sNM = nmDM.slice(0, period).reduce((a, b) => a + b, 0);

  let adxSmooth = 0;
  const dx = [];
  for (let i = period; i < trArr.length; i++) {
    sTR = sTR - sTR / period + trArr[i];
    sPM = sPM - sPM / period + pmDM[i];
    sNM = sNM - sNM / period + nmDM[i];
    const diP = sTR > 0 ? (sPM / sTR) * 100 : 0;
    const diN = sTR > 0 ? (sNM / sTR) * 100 : 0;
    const diSum = diP + diN;
    const dxVal = diSum > 0 ? Math.abs(diP - diN) / diSum * 100 : 0;
    dx.push(dxVal);
    if (dx.length === period) {
      adxSmooth = dx.reduce((a, b) => a + b, 0) / period;
    } else if (dx.length > period) {
      adxSmooth = (adxSmooth * (period - 1) + dxVal) / period;
    }
    if (dx.length >= period) adx[i + 1] = adxSmooth;
  }
  return adx;
}

function mfiSeries(candles, period) {
  const out = new Array(candles.length).fill(50);
  for (let i = period; i < candles.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const tpPrev = (candles[j-1].high + candles[j-1].low + candles[j-1].close) / 3;
      const mf = tp * candles[j].volume;
      if (tp > tpPrev) posFlow += mf; else negFlow += mf;
    }
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return out;
}

// Streak (consecutive up/down candles, synth 15m)
function streakSeries(closes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] > 0 ? out[i - 1] + 1 : 1;
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] < 0 ? out[i - 1] - 1 : -1;
    else out[i] = 0;
  }
  return out;
}

// Connors RSI
function crsiSeries(closes, period = 100) {
  const out = new Array(closes.length).fill(50);
  const rsi3 = rsiSeries(closes, 3);
  const streak = streakSeries(closes);
  const rsiStreak = rsiSeries(streak, 2);
  for (let i = period - 1; i < closes.length; i++) {
    const currRet = closes[i] - closes[i - 1];
    let below = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (closes[j] - closes[j - 1] < currRet) below++;
    }
    out[i] = (rsi3[i] + rsiStreak[i] + (below / period) * 100) / 3;
  }
  return out;
}

// Stochastic K
function stochKSeries(candles, period) {
  return candles.map((c, i) => {
    if (i < period - 1) return 50;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    return (hi - lo) < 1e-10 ? 50 : (c.close - lo) / (hi - lo) * 100;
  });
}

// ─── Walk-Forward Validation ──────────────────────────────────────────────────

function walkForward(candles, signalFn, folds = 5) {
  const n = candles.length;
  const foldSize = Math.floor(n / (folds + 1));
  const results = [];
  for (let f = 0; f < folds; f++) {
    const trainEnd  = (f + 1) * foldSize;
    const testStart = trainEnd;
    const testEnd   = Math.min(trainEnd + foldSize, n - 1);
    let wins = 0, total = 0;
    for (let i = testStart + 1; i < testEnd; i++) {
      const sig = signalFn(candles, i);
      if (!sig) continue;
      const nextClose = candles[i + 1]?.close;
      const currClose = candles[i].close;
      if (!nextClose) continue;
      const actualUp = nextClose > currClose;
      if (sig === 'BULL' ? actualUp : !actualUp) wins++;
      total++;
    }
    if (total >= 5) results.push({ wr: wins / total, n: total });
  }
  if (results.length === 0) return { wr: 0, tradesPerDay: 0, totalTrades: 0 };
  results.sort((a, b) => a.wr - b.wr);
  const median = results[Math.floor(results.length / 2)];
  const totalTrades = results.reduce((s, r) => s + r.n, 0);
  const totalDays = candles.length / 288;
  return { wr: median.wr, tradesPerDay: totalTrades / totalDays / folds, totalTrades };
}

// ─── Research per coin ────────────────────────────────────────────────────────

function researchCoin(symbol) {
  console.log(`\n${'='.repeat(65)}`);
  console.log(`  ${symbol} — Session 12 High-WR Research`);
  console.log('='.repeat(65));

  const candles = loadCandles(symbol, '5m');
  if (candles.length < 500) { console.log('  ⚠️  Insufficient data'); return {}; }
  console.log(`  Loaded ${candles.length} 5m candles (${(candles.length / 288).toFixed(0)} days)`);

  const gh = GOOD_HOURS[symbol] || new Set([10, 12, 13]);

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const sma20    = smaSeries(closes, 20);
  const std20    = stdSeries(closes, sma20, 20);
  const bb22Up   = sma20.map((s, i) => s + 2.2 * std20[i]);
  const bb22Lo   = sma20.map((s, i) => s - 2.2 * std20[i]);
  const bbPctB   = closes.map((c, i) => std20[i] > 0 ? (c - bb22Lo[i]) / (bb22Up[i] - bb22Lo[i]) : 0.5);

  const rsi14    = rsiSeries(closes, 14);
  const rsi7     = rsiSeries(closes, 7);
  const rsi3     = rsiSeries(closes, 3);
  const adx14    = adxSeries(candles, 14);
  const mfi14    = mfiSeries(candles, 14);
  const streak5m = streakSeries(closes);
  const crsi100  = crsiSeries(closes, 100);
  const stochK5  = stochKSeries(candles, 5);
  const atr14    = atrSeries(candles, 14);
  const vol20    = smaSeries(volumes, 20);

  // Synth 15m streak (streak across 3 consecutive 5m candles)
  const streak15m = new Array(closes.length).fill(0);
  for (let i = 3; i < closes.length; i++) {
    const s3 = closes[i] > closes[i-3];
    const s2 = closes[i-1] > closes[i-2];
    const s1 = closes[i-2] > closes[i-3];
    if (s3 && s2 && s1) streak15m[i] = 1;
    else if (!s3 && !s2 && !s1) streak15m[i] = -1;
    else streak15m[i] = 0;
  }

  const results = {};

  // ── SECTION A: GoodH + ADX<20 combinations ───────────────────────────────

  // A1. GoodH + ADX<20 + RSI7>72 + BB22 (refined from S12 base: BTC 63.1% all-hours)
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      if (!gh.has(getHourUTC(c[i].t))) return null;
      const cl = closes[i];
      if (adx14[i] >= 20) return null;
      const devHi = (cl - bb22Up[i]) / (bb22Up[i] || 1) * 100;
      const devLo = (bb22Lo[i] - cl) / (bb22Lo[i] || 1) * 100;
      if (devHi > 0.04 && rsi7[i] > 72) return 'BEAR';
      if (devLo > 0.04 && rsi7[i] < 28) return 'BULL';
      return null;
    };
    const r = walkForward(candles, (c, i) => sig(candles, i));
    results['GH+ADX20+RSI7_72+BB22'] = r;
    console.log(`  GH+ADX<20+RSI7>72+BB22:     WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // A2. GoodH + ADX<20 + RSI7>70 + MFI>75 + BB22 (ADX + volume)
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (adx14[i] >= 20) return null;
      if (mfi14[i] > 75 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
      if (mfi14[i] < 25 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+ADX20+MFI75+RSI7+BB22'] = r;
    console.log(`  GH+ADX<20+MFI75+RSI7+BB22:  WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // A3. GoodH + ADX<20 + Streak≥2 + BB22
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (adx14[i] >= 20) return null;
      if (streak5m[i] >= 2 && cl > bb22Up[i] && rsi7[i] > 65) return 'BEAR';
      if (streak5m[i] <= -2 && cl < bb22Lo[i] && rsi7[i] < 35) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+ADX20+Streak2+BB22'] = r;
    console.log(`  GH+ADX<20+Streak≥2+BB22:    WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // A4. GoodH + ADX<15 (very ranging) + RSI7 + BB22
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (adx14[i] >= 15) return null;
      const devHi = (cl - bb22Up[i]) / (bb22Up[i] || 1) * 100;
      const devLo = (bb22Lo[i] - cl) / (bb22Lo[i] || 1) * 100;
      if (devHi > 0.04 && rsi7[i] > 65) return 'BEAR';
      if (devLo > 0.04 && rsi7[i] < 35) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+ADX15+RSI7+BB22'] = r;
    console.log(`  GH+ADX<15+RSI7+BB22:        WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // ── SECTION B: GoodH alone combinations ──────────────────────────────────

  // B1. GoodH + RSI7>75 (deep) + BB22
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (rsi7[i] > 75 && cl > bb22Up[i]) return 'BEAR';
      if (rsi7[i] < 25 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+RSI7_75+BB22'] = r;
    console.log(`  GH+RSI7>75+BB22:            WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B2. GoodH + RSI7>73 + RSI14>68 (double RSI deep) + BB22
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (rsi7[i] > 73 && rsi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
      if (rsi7[i] < 27 && rsi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+DoubleRSI_deep+BB22'] = r;
    console.log(`  GH+DoubleRSI(73/68)+BB22:   WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B3. GoodH + MFI>80 + RSI7>68 + BB22
  {
    const sig = (c, i) => {
      if (i < 20) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (mfi14[i] > 80 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
      if (mfi14[i] < 20 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+MFI80+RSI7+BB22'] = r;
    console.log(`  GH+MFI>80+RSI7>68+BB22:     WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B4. GoodH + CRSI>85 + BB22 (Connors RSI extreme in good hours)
  {
    const sig = (c, i) => {
      if (i < 105) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (crsi100[i] > 85 && cl > bb22Up[i]) return 'BEAR';
      if (crsi100[i] < 15 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+CRSI85+BB22'] = r;
    console.log(`  GH+CRSI>85+BB22:            WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B5. GoodH + Streak≥2 + RSI7>70 + BB22 (from strat 18 base)
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (streak5m[i] >= 2 && rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
      if (streak5m[i] <= -2 && rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+Streak2+RSI7_70+BB22'] = r;
    console.log(`  GH+Streak≥2+RSI7>70+BB22:   WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B6. GoodH + Streak15m≥1 + RSI7>70 + BB22 (15m streak in good hours)
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (streak15m[i] === 1 && rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
      if (streak15m[i] === -1 && rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+15mStreak+RSI7_70+BB22'] = r;
    console.log(`  GH+15mStreak+RSI7>70+BB22:  WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B7. GoodH + RSI3>92 + BB22 (ultra-fast RSI extreme in good hours)
  {
    const sig = (c, i) => {
      if (i < 10) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (rsi3[i] > 92 && cl > bb22Up[i]) return 'BEAR';
      if (rsi3[i] < 8 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+RSI3_92+BB22'] = r;
    console.log(`  GH+RSI3>92+BB22:            WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B8. GoodH + WideRange(1.5×ATR) + RSI7>68 + BB22
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      const range = candles[i].high - candles[i].low;
      const wideRange = atr14[i] > 0 && range > 1.5 * atr14[i];
      if (wideRange && cl > bb22Up[i] && rsi7[i] > 68) return 'BEAR';
      if (wideRange && cl < bb22Lo[i] && rsi7[i] < 32) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+WideRange1.5ATR+RSI7+BB22'] = r;
    console.log(`  GH+WideRange(1.5ATR)+BB22:  WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B9. GoodH + BB%B>1.05 + RSI7>70 + MFI>72 (triple oscillator in GH)
  {
    const sig = (c, i) => {
      if (i < 20) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      if (bbPctB[i] > 1.05 && rsi7[i] > 70 && mfi14[i] > 72) return 'BEAR';
      if (bbPctB[i] < -0.05 && rsi7[i] < 30 && mfi14[i] < 28) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+PctB105+RSI7+MFI72'] = r;
    console.log(`  GH+BB%B>1.05+RSI7>70+MFI72: WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // B10. GoodH + VolSpike>2x + RSI7>68 + BB22 (big volume surge in GH)
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      const volSpike = vol20[i] > 0 && volumes[i] > 2.0 * vol20[i];
      if (volSpike && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
      if (volSpike && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+VolSpike2x+RSI7+BB22'] = r;
    console.log(`  GH+VolSpike(2x)+RSI7+BB22:  WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // ── SECTION C: Triple/Quad filter strategies for ultra-high WR ───────────

  // C1. GoodH + ADX<20 + RSI7>73 + MFI>72 + BB22 (5 conditions)
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      if (adx14[i] >= 20) return null;
      const cl = closes[i];
      if (mfi14[i] > 72 && rsi7[i] > 73 && cl > bb22Up[i]) return 'BEAR';
      if (mfi14[i] < 28 && rsi7[i] < 27 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+ADX20+RSI73+MFI72+BB22'] = r;
    console.log(`  GH+ADX<20+RSI73+MFI72+BB22: WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // C2. GoodH + ADX<20 + CRSI>82 + BB22 (ADX + ConnorsRSI in GH)
  {
    const sig = (c, i) => {
      if (i < 105) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      if (adx14[i] >= 20) return null;
      const cl = closes[i];
      if (crsi100[i] > 82 && cl > bb22Up[i]) return 'BEAR';
      if (crsi100[i] < 18 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+ADX20+CRSI82+BB22'] = r;
    console.log(`  GH+ADX<20+CRSI>82+BB22:     WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // C3. GoodH + ADX<20 + Stoch5>85 + RSI7>68 + BB22
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      if (adx14[i] >= 20) return null;
      const cl = closes[i];
      if (stochK5[i] > 85 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
      if (stochK5[i] < 15 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+ADX20+Stoch5+RSI7+BB22'] = r;
    console.log(`  GH+ADX<20+Stoch5+RSI7+BB22: WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // C4. GoodH + Streak≥2 + RSI7>73 + MFI>70 + BB22 (deep multi-condition)
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      const cl = closes[i];
      if (streak5m[i] >= 2 && rsi7[i] > 73 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
      if (streak5m[i] <= -2 && rsi7[i] < 27 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+Streak2+RSI73+MFI70+BB22'] = r;
    console.log(`  GH+Streak2+RSI73+MFI70+BB22:WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  // C5. GoodH + BB%B>1.1 (well above) + RSI7>72 + BB22 (very selective high WR)
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      if (!gh.has(getHourUTC(candles[i].t))) return null;
      if (bbPctB[i] > 1.10 && rsi7[i] > 72) return 'BEAR';
      if (bbPctB[i] < -0.10 && rsi7[i] < 28) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['GH+PctB110+RSI7_72'] = r;
    console.log(`  GH+BB%B>1.10+RSI7>72:       WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/day  n=${r.totalTrades} ${r.wr > 0.70 ? '🔥🔥🔥' : r.wr > 0.65 ? '🔥🔥' : r.wr > 0.60 ? '🔥' : ''}`);
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('\n' + '█'.repeat(65));
  console.log('  SESSION 12 HIGH-WR — Targeting >75% Win Rate');
  console.log('█'.repeat(65));
  console.log('  GoodH × ADX<20 × Deep Thresholds × Multi-condition');
  console.log('  Exit: next 5m candle close | Breakeven: 51.02% with 2% fee');
  console.log('  5-fold walk-forward | MINIMUM 5 trades per fold');

  const coins = ['ETH', 'BTC', 'SOL', 'XRP'];
  const allResults = {};
  for (const coin of coins) {
    allResults[coin] = researchCoin(coin);
  }

  // Cross-coin summary
  console.log('\n' + '─'.repeat(65));
  console.log('  HIGH-WR SUMMARY (target: >60% per coin, >65% avg)');
  console.log('─'.repeat(65));

  const strategies = Object.keys(allResults['ETH'] || {});
  const summary = [];
  for (const strat of strategies) {
    const rows = [];
    for (const coin of coins) {
      const r = allResults[coin]?.[strat];
      if (r && r.wr > 0 && r.tradesPerDay > 0.01) {
        rows.push({ coin, wr: r.wr, tpd: r.tradesPerDay, n: r.totalTrades });
      }
    }
    if (rows.length === 0) continue;
    const avgWr = rows.reduce((a, b) => a + b.wr, 0) / rows.length;
    const totalTpd = rows.reduce((a, b) => a + b.tpd, 0);
    summary.push({ strat, avgWr, totalTpd, rows });
  }

  summary.sort((a, b) => b.avgWr - a.avgWr);
  console.log('\n  All strategies ranked by avg WR:');
  for (const s of summary) {
    const fire = s.avgWr > 0.75 ? ' 🔥🔥🔥 HOLY GRAIL!' : s.avgWr > 0.70 ? ' 🔥🔥 >70%!' : s.avgWr > 0.65 ? ' 🔥' : '';
    console.log(`  ${s.strat.padEnd(35)} avg=${(s.avgWr*100).toFixed(1)}%  tpd=${s.totalTpd.toFixed(2)}${fire}`);
    for (const r of s.rows) {
      console.log(`    ${r.coin}: ${(r.wr*100).toFixed(1)}% @ ${r.tpd.toFixed(2)}/day (n=${r.n})`);
    }
  }

  // Best single-coin result
  console.log('\n  BEST PER-COIN RESULTS (any strategy):');
  for (const coin of coins) {
    const coinResults = Object.entries(allResults[coin] || {})
      .filter(([, r]) => r.wr > 0 && r.totalTrades >= 5)
      .sort(([, a], [, b]) => b.wr - a.wr);
    if (coinResults.length === 0) continue;
    const [bestStrat, bestResult] = coinResults[0];
    const fire = bestResult.wr > 0.75 ? '🔥🔥🔥' : bestResult.wr > 0.70 ? '🔥🔥' : bestResult.wr > 0.65 ? '🔥' : '';
    console.log(`  ${coin}: ${(bestResult.wr*100).toFixed(1)}% WR @ ${bestResult.tradesPerDay.toFixed(2)}/day → ${bestStrat} ${fire}`);
  }

  db.close();
}

main();
