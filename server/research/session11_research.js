/**
 * SESSION 11 RESEARCH — VWAP, Pinbar, RSI Divergence, BB Bandwidth, Composite
 *
 * New pattern families never tested before in this project:
 *   1. VWAP Deviation — rolling 50-bar VWAP, price far above/below = mean reversion
 *   2. Pinbar / Hammer at BB — candlestick body-wick patterns at BB extremes
 *   3. RSI Divergence — price new high + RSI lower → bearish (and vice versa)
 *   4. BB Bandwidth Extreme — very wide BB (high stddev) + price at extremes
 *   5. Rate of Change (ROC) Extreme — rapid price move % at BB extreme
 *   6. Composite Oscillator — blend CCI + WPR + CRSI into single score
 *   7. Volume Exhaustion — high-volume candle at BB extreme = climax reversal
 *   8. Doji at BB — tiny body candle = indecision → reversal signal
 *   9. Consecutive RSI Extreme — RSI extreme for N bars in a row → reversal
 *  10. BB %B + RSI combo — %B > 1.0 (above upper) + RSI > 65 = combined signal
 *
 * Correct binary exit: next 5m candle close direction (fixed-expiry)
 * Fee: 2% spread → breakeven WR ≈ 51%
 * 5-fold walk-forward validation, median WR reported
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

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

// ─── Indicator helpers ────────────────────────────────────────────────────────

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

function emaSeries(arr, period) {
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
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

// Connors RSI
function crsiSeries(closes, period = 100) {
  const out = new Array(closes.length).fill(50);
  const rsi3 = rsiSeries(closes, 3);
  const streak = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) streak[i] = streak[i - 1] > 0 ? streak[i - 1] + 1 : 1;
    else if (closes[i] < closes[i - 1]) streak[i] = streak[i - 1] < 0 ? streak[i - 1] - 1 : -1;
    else streak[i] = 0;
  }
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

// CCI
function cciSeries(closes, smaArr, period) {
  const out = new Array(closes.length).fill(0);
  for (let i = period - 1; i < closes.length; i++) {
    const sma = smaArr[i];
    let meanDev = 0;
    for (let j = i - period + 1; j <= i; j++) meanDev += Math.abs(closes[j] - sma);
    meanDev /= period;
    out[i] = meanDev < 1e-10 ? 0 : (closes[i] - sma) / (0.015 * meanDev);
  }
  return out;
}

// Williams %R
function wprSeries(closes, highs, lows, period) {
  const out = new Array(closes.length).fill(-50);
  for (let i = period - 1; i < closes.length; i++) {
    let hiN = -Infinity, loN = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hiN) hiN = highs[j];
      if (lows[j] < loN) loN = lows[j];
    }
    const range = hiN - loN;
    out[i] = range < 1e-10 ? -50 : (hiN - closes[i]) / range * -100;
  }
  return out;
}

// ─── Walk-Forward Validation ──────────────────────────────────────────────────

function walkForward(candles, signalFn, folds = 5) {
  const n = candles.length;
  const foldSize = Math.floor(n / (folds + 1));
  const results = [];
  for (let f = 0; f < folds; f++) {
    const trainEnd = (f + 1) * foldSize;
    const testStart = trainEnd;
    const testEnd = Math.min(trainEnd + foldSize, n - 1);
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
    if (total >= 10) results.push({ wr: wins / total, n: total });
  }
  if (results.length === 0) return { wr: 0, tradesPerDay: 0 };
  results.sort((a, b) => a.wr - b.wr);
  const median = results[Math.floor(results.length / 2)];
  const totalTrades = results.reduce((s, r) => s + r.n, 0);
  const totalDays = candles.length / 288;
  return { wr: median.wr, tradesPerDay: totalTrades / totalDays / folds };
}

// ─── Main Research ────────────────────────────────────────────────────────────

function researchCoin(symbol) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${symbol} — Session 11 Research`);
  console.log('='.repeat(60));

  const candles = loadCandles(symbol, '5m');
  if (candles.length < 500) { console.log('  ⚠️  Insufficient data'); return {}; }
  console.log(`  Loaded ${candles.length} 5m candles (${(candles.length / 288).toFixed(0)} days)`);

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  // Pre-compute indicator series
  const sma20    = smaSeries(closes, 20);
  const std20    = stdSeries(closes, sma20, 20);
  const bb22Up   = sma20.map((s, i) => s + 2.2 * std20[i]);
  const bb22Lo   = sma20.map((s, i) => s - 2.2 * std20[i]);
  const bb22Bw   = std20.map((s, i) => (bb22Up[i] - bb22Lo[i]) / sma20[i] * 100); // bandwidth %
  const bbPctB   = closes.map((c, i) => std20[i] > 0 ? (c - bb22Lo[i]) / (bb22Up[i] - bb22Lo[i]) : 0.5);

  const rsi14    = rsiSeries(closes, 14);
  const rsi7     = rsiSeries(closes, 7);
  const rsi3     = rsiSeries(closes, 3);
  const ema20    = emaSeries(closes, 20);
  const atr14    = atrSeries(candles, 14);
  const cciArr   = cciSeries(closes, sma20, 20);
  const wprArr   = wprSeries(closes, highs, lows, 14);
  const crsiArr  = crsiSeries(closes, 100);

  // Rolling VWAP (50 bars = ~4 hours of 5m data)
  const vwapArr = new Array(closes.length).fill(0);
  for (let i = 49; i < closes.length; i++) {
    let sumTP = 0, sumVol = 0;
    for (let j = i - 49; j <= i; j++) {
      const tp = (highs[j] + lows[j] + closes[j]) / 3;
      sumTP  += tp * volumes[j];
      sumVol += volumes[j];
    }
    vwapArr[i] = sumVol > 0 ? sumTP / sumVol : closes[i];
  }

  // Volume SMA(20) for volume exhaustion
  const volSma20 = smaSeries(volumes, 20);

  // BB bandwidth SMA(20) for bandwidth regime
  const bwSma20 = smaSeries(bb22Bw, 20);

  const results = {};
  const minIdx = Math.max(200, Math.floor(candles.length * 0.2));

  const strategies = [
    // ── VWAP Deviation ──────────────────────────────────────────────────────────
    {
      name: 'VWAP Dev>1% + BB22',
      fn: (i) => {
        if (i < 50) return null;
        const cl = closes[i], vwap = vwapArr[i];
        const devPct = (cl - vwap) / vwap * 100;
        if (devPct > 1.0 && cl > bb22Up[i]) return 'BEAR';
        if (devPct < -1.0 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'VWAP Dev>0.5% + BB22',
      fn: (i) => {
        if (i < 50) return null;
        const cl = closes[i], vwap = vwapArr[i];
        const devPct = (cl - vwap) / vwap * 100;
        if (devPct > 0.5 && cl > bb22Up[i]) return 'BEAR';
        if (devPct < -0.5 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'VWAP Dev>0.5% (no BB)',
      fn: (i) => {
        if (i < 50) return null;
        const cl = closes[i], vwap = vwapArr[i];
        const devPct = (cl - vwap) / vwap * 100;
        if (devPct > 1.5) return 'BEAR';
        if (devPct < -1.5) return 'BULL';
        return null;
      }
    },
    // ── Pinbar / Hammer at BB ────────────────────────────────────────────────────
    {
      name: 'Pinbar at BB22',
      fn: (i) => {
        const c = candles[i];
        const range = c.high - c.low;
        if (range < 1e-10) return null;
        const body = Math.abs(c.close - c.open);
        const upperWick = c.high - Math.max(c.close, c.open);
        const lowerWick = Math.min(c.close, c.open) - c.low;
        const bodyRatio = body / range;
        // Bearish pinbar: tiny body + big upper wick at BB22 upper
        if (bodyRatio < 0.35 && upperWick > 2 * body && c.high > bb22Up[i]) return 'BEAR';
        // Bullish pinbar: tiny body + big lower wick at BB22 lower
        if (bodyRatio < 0.35 && lowerWick > 2 * body && c.low < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'Pinbar at BB22 + RSI7',
      fn: (i) => {
        const c = candles[i];
        const range = c.high - c.low;
        if (range < 1e-10) return null;
        const body = Math.abs(c.close - c.open);
        const upperWick = c.high - Math.max(c.close, c.open);
        const lowerWick = Math.min(c.close, c.open) - c.low;
        const bodyRatio = body / range;
        const rsi = rsi7[i];
        if (bodyRatio < 0.35 && upperWick > 1.5 * body && c.high > bb22Up[i] && rsi > 65) return 'BEAR';
        if (bodyRatio < 0.35 && lowerWick > 1.5 * body && c.low < bb22Lo[i] && rsi < 35) return 'BULL';
        return null;
      }
    },
    // ── Doji at BB ───────────────────────────────────────────────────────────────
    {
      name: 'Doji at BB22',
      fn: (i) => {
        const c = candles[i];
        const range = c.high - c.low;
        if (range < 1e-10) return null;
        const body = Math.abs(c.close - c.open);
        // Doji: body < 15% of range
        if (body / range > 0.15) return null;
        if (c.close > bb22Up[i]) return 'BEAR';
        if (c.close < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    // ── RSI Divergence ───────────────────────────────────────────────────────────
    // Look back N bars: if price higher but RSI lower → bearish divergence
    {
      name: 'RSI14 Div (5-bar)',
      fn: (i) => {
        if (i < 7) return null;
        const n = 5; // bars to look back
        // Find recent peak/trough in price
        const prevClose = closes[i - n];
        const prevRSI   = rsi14[i - n];
        const currClose = closes[i];
        const currRSI   = rsi14[i];
        // Bearish: price higher now, RSI lower now + at upper BB
        if (currClose > prevClose && currRSI < prevRSI && closes[i] > bb22Up[i] && currRSI > 55) return 'BEAR';
        // Bullish: price lower now, RSI higher now + at lower BB
        if (currClose < prevClose && currRSI > prevRSI && closes[i] < bb22Lo[i] && currRSI < 45) return 'BULL';
        return null;
      }
    },
    {
      name: 'RSI7 Div (5-bar)',
      fn: (i) => {
        if (i < 7) return null;
        const n = 5;
        const prevClose = closes[i - n], currClose = closes[i];
        const prevRSI = rsi7[i - n], currRSI = rsi7[i];
        if (currClose > prevClose && currRSI < prevRSI && closes[i] > bb22Up[i] && currRSI > 58) return 'BEAR';
        if (currClose < prevClose && currRSI > prevRSI && closes[i] < bb22Lo[i] && currRSI < 42) return 'BULL';
        return null;
      }
    },
    {
      name: 'RSI7 Div (3-bar)',
      fn: (i) => {
        if (i < 5) return null;
        const n = 3;
        const prevClose = closes[i - n], currClose = closes[i];
        const prevRSI = rsi7[i - n], currRSI = rsi7[i];
        if (currClose > prevClose && currRSI < prevRSI && closes[i] > bb22Up[i] && currRSI > 60) return 'BEAR';
        if (currClose < prevClose && currRSI > prevRSI && closes[i] < bb22Lo[i] && currRSI < 40) return 'BULL';
        return null;
      }
    },
    // ── BB Bandwidth Extremes ─────────────────────────────────────────────────────
    // Wide bandwidth = high volatility regime → mean reversion likely at extremes
    {
      name: 'BB Bandwidth Wide + BB22',
      fn: (i) => {
        if (i < 30) return null;
        // bandwidth > 150% of its 20-bar average = very wide
        if (bb22Bw[i] < bwSma20[i] * 1.5) return null;
        const cl = closes[i];
        if (cl > bb22Up[i]) return 'BEAR';
        if (cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'BB %B > 1.0 + RSI7',
      fn: (i) => {
        // %B > 1.0 means price above upper BB, < 0 means below lower
        const pctb = bbPctB[i], rsi = rsi7[i];
        if (pctb > 1.05 && rsi > 65) return 'BEAR';
        if (pctb < -0.05 && rsi < 35) return 'BULL';
        return null;
      }
    },
    {
      name: 'BB %B > 1.1 + CRSI',
      fn: (i) => {
        if (i < 105) return null;
        const pctb = bbPctB[i], crsi = crsiArr[i];
        if (pctb > 1.1 && crsi > 75) return 'BEAR';
        if (pctb < -0.1 && crsi < 25) return 'BULL';
        return null;
      }
    },
    // ── Rate of Change Extremes ───────────────────────────────────────────────────
    {
      name: 'ROC5 > 1% + BB22',
      fn: (i) => {
        if (i < 7) return null;
        const roc = (closes[i] - closes[i - 5]) / closes[i - 5] * 100;
        const cl = closes[i];
        if (roc > 1.0 && cl > bb22Up[i]) return 'BEAR';
        if (roc < -1.0 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'ROC3 > 0.5% + BB22',
      fn: (i) => {
        if (i < 5) return null;
        const roc = (closes[i] - closes[i - 3]) / closes[i - 3] * 100;
        const cl = closes[i];
        if (roc > 0.5 && cl > bb22Up[i]) return 'BEAR';
        if (roc < -0.5 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    // ── Composite Oscillator ──────────────────────────────────────────────────────
    // Blend normalized CCI + WPR + CRSI → single 0-100 score
    {
      name: 'Composite (CCI+WPR+CRSI)',
      fn: (i) => {
        if (i < 105) return null;
        // Normalize each to 0-100 (100 = overbought, 0 = oversold)
        const cciN  = Math.min(100, Math.max(0, (cciArr[i] + 300) / 6)); // CCI -300 to +300 → 0-100
        const wprN  = Math.min(100, Math.max(0, (wprArr[i] + 100)));      // WPR -100 to 0 → 0 to 100
        const crsiN = crsiArr[i];                                           // already 0-100
        const composite = (cciN + wprN + crsiN) / 3;
        const cl = closes[i];
        if (composite > 72 && cl > bb22Up[i]) return 'BEAR';
        if (composite < 28 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'Composite > 78 (tighter)',
      fn: (i) => {
        if (i < 105) return null;
        const cciN  = Math.min(100, Math.max(0, (cciArr[i] + 300) / 6));
        const wprN  = Math.min(100, Math.max(0, (wprArr[i] + 100)));
        const crsiN = crsiArr[i];
        const composite = (cciN + wprN + crsiN) / 3;
        const cl = closes[i];
        if (composite > 78 && cl > bb22Up[i]) return 'BEAR';
        if (composite < 22 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    // ── Volume Exhaustion at BB ───────────────────────────────────────────────────
    {
      name: 'Volume Spike 2x + BB22',
      fn: (i) => {
        if (i < 22) return null;
        const volAvg = volSma20[i];
        // Volume spike: current volume > 2x average = climax signal
        if (volumes[i] < volAvg * 2.0) return null;
        const cl = closes[i];
        if (cl > bb22Up[i]) return 'BEAR'; // volume climax at upper BB → reversal
        if (cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'Volume Spike 1.5x + BB22 + RSI7',
      fn: (i) => {
        if (i < 22) return null;
        const volAvg = volSma20[i];
        if (volumes[i] < volAvg * 1.5) return null;
        const cl = closes[i], rsi = rsi7[i];
        if (cl > bb22Up[i] && rsi > 65) return 'BEAR';
        if (cl < bb22Lo[i] && rsi < 35) return 'BULL';
        return null;
      }
    },
    // ── Consecutive RSI Extreme ───────────────────────────────────────────────────
    // RSI extreme for multiple consecutive bars = sustained overextension → reversal
    {
      name: 'RSI7>70 consec 2 + BB22',
      fn: (i) => {
        if (i < 3) return null;
        const cl = closes[i];
        // Two consecutive bars with RSI7>70 at upper BB → reversal
        if (rsi7[i] > 70 && rsi7[i - 1] > 70 && cl > bb22Up[i]) return 'BEAR';
        if (rsi7[i] < 30 && rsi7[i - 1] < 30 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'RSI14>68 consec 2 + BB22',
      fn: (i) => {
        if (i < 3) return null;
        const cl = closes[i];
        if (rsi14[i] > 68 && rsi14[i - 1] > 68 && cl > bb22Up[i]) return 'BEAR';
        if (rsi14[i] < 32 && rsi14[i - 1] < 32 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    // ── EMA Divergence ────────────────────────────────────────────────────────────
    // Price far from EMA(20) = overextended = mean reversion
    {
      name: 'EMA20 Dev>1% + BB22',
      fn: (i) => {
        if (i < 22) return null;
        const devPct = (closes[i] - ema20[i]) / ema20[i] * 100;
        const cl = closes[i];
        if (devPct > 1.0 && cl > bb22Up[i]) return 'BEAR';
        if (devPct < -1.0 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'EMA20 Dev>0.5% + RSI7 + BB22',
      fn: (i) => {
        if (i < 22) return null;
        const devPct = (closes[i] - ema20[i]) / ema20[i] * 100;
        const cl = closes[i], rsi = rsi7[i];
        if (devPct > 0.5 && cl > bb22Up[i] && rsi > 67) return 'BEAR';
        if (devPct < -0.5 && cl < bb22Lo[i] && rsi < 33) return 'BULL';
        return null;
      }
    },
    // ── RSI(3) Extreme — ultra-fast oscillator ────────────────────────────────────
    {
      name: 'RSI3>90 + BB22',
      fn: (i) => {
        const cl = closes[i], rsi = rsi3[i];
        if (rsi > 90 && cl > bb22Up[i]) return 'BEAR';
        if (rsi < 10 && cl < bb22Lo[i]) return 'BULL';
        return null;
      }
    },
    {
      name: 'RSI3>85 (no BB)',
      fn: (i) => {
        const rsi = rsi3[i];
        if (rsi > 90) return 'BEAR';
        if (rsi < 10) return 'BULL';
        return null;
      }
    },
    // ── Keltner Inner (BB outside KC — expansion signal) ─────────────────────────
    // OPPOSITE of Keltner Outer: BB bands squeeze inside KC = low volatility/squeeze
    // When price pierces inside BB (not at extreme) while KC is wider = different regime
    {
      name: 'BB%B+CCI+WPR combo',
      fn: (i) => {
        if (i < 105) return null;
        const pctb = bbPctB[i];
        const cci  = cciArr[i];
        const wpr  = wprArr[i];
        // Triple convergence: all 3 pointing to overbought
        if (pctb > 1.0 && cci > 100 && wpr > -20) return 'BEAR';
        if (pctb < 0.0 && cci < -100 && wpr < -80) return 'BULL';
        return null;
      }
    },
  ];

  for (const strat of strategies) {
    const wfResult = walkForward(candles, (c, i) => i >= minIdx ? strat.fn(i) : null, 5);
    const ev = wfResult.wr * 0.49 - (1 - wfResult.wr) * 0.51;
    const flag = wfResult.wr >= 0.57 ? '🏆🏆' : wfResult.wr >= 0.54 ? '🏆' : wfResult.wr >= 0.52 ? '✅' : wfResult.wr >= 0.51 ? '💰' : '❌';
    results[strat.name] = { wr: wfResult.wr, tpd: wfResult.tradesPerDay, ev };
    console.log(`  ${flag} ${strat.name.padEnd(34)} WR=${(wfResult.wr * 100).toFixed(1)}% @${wfResult.tradesPerDay.toFixed(1)}/day  EV=${(ev * 100).toFixed(2)}%`);
  }

  return results;
}

// ─── Run all coins ────────────────────────────────────────────────────────────

const coins = ['ETH', 'BTC', 'SOL', 'XRP'];
const allResults = {};
for (const symbol of coins) {
  allResults[symbol] = researchCoin(symbol);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  SUMMARY: Best Multi-Coin Strategies (avg WR ≥ 53%, ≥ 5 total/day)');
console.log('='.repeat(70));

const stratNames = Object.keys(allResults['ETH'] || {});
for (const sn of stratNames) {
  const wrArr  = coins.map(c => allResults[c]?.[sn]?.wr || 0);
  const tpdArr = coins.map(c => allResults[c]?.[sn]?.tpd || 0);
  const avgWR  = wrArr.reduce((a, b) => a + b, 0) / wrArr.length;
  const totalTPD = tpdArr.reduce((a, b) => a + b, 0);
  if (avgWR >= 0.53 && totalTPD >= 5) {
    const flag = avgWR >= 0.57 ? '🏆🏆' : avgWR >= 0.55 ? '🏆' : '✅';
    const perCoin = coins.map((c, i) => `${c}:${(wrArr[i]*100).toFixed(1)}%`).join('  ');
    console.log(`${flag} ${sn.padEnd(34)} avg=${(avgWR*100).toFixed(1)}% total=${totalTPD.toFixed(0)}/day`);
    console.log(`   ${perCoin}`);
  }
}

console.log('\n✅ Session 11 Research Complete!');
db.close();
