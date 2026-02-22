/**
 * SESSION 10 RESEARCH — Fisher Transform, CCI, Williams %R, Keltner Squeeze
 *
 * Tests new TradingView-inspired patterns NOT yet implemented:
 *   1. Fisher Transform (10/5) extremes at BB22 — adaptive price oscillator
 *   2. CCI (20) extremes + BB22 — commodity channel index as mean-reversion signal
 *   3. Williams %R (14) + BB22 — momentum/reversal at extremes
 *   4. CRSI (20/80) — higher-volume CRSI variant (already validated as ~53.8% avg)
 *   5. Keltner Squeeze — price inside KC but outside BB = volatility expansion signal
 *   6. Heikin-Ashi reversal at BB — HA candles at extreme = confirmation signal
 *
 * Correct binary exit: next 5m candle close direction (fixed-expiry)
 * Fee model: Polymarket 2% spread → breakeven WR ≈ 51%
 * All-hours, 5-fold walk-forward validation
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

// ─── Data loading ───────────────────────────────────────────────────────────

function loadCandles(symbol, tf = '5m') {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume
     FROM candles WHERE symbol = ? AND timeframe = ?
     ORDER BY open_time ASC`
  ).all(symbol, tf).map(r => ({
    t: r.open_time,
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

// ─── Indicator helpers (all O(n) pre-computed series) ────────────────────────

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
  const out = new Array(arr.length).fill(arr[0] || 0);
  let sum = 0;
  for (let i = 0; i < period && i < arr.length; i++) sum += arr[i];
  for (let i = period - 1; i < arr.length; i++) {
    if (i >= period) sum += arr[i] - arr[i - period];
    out[i] = sum / period;
  }
  return out;
}

function emaSeries(arr, period) {
  const k = 2 / (period + 1);
  const out = new Array(arr.length).fill(0);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    out[i] = arr[i] * k + out[i - 1] * (1 - k);
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
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    atr += tr;
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

// Fisher Transform: FT = 0.5 * ln((1+x)/(1-x)), x = 2*(price-loN)/(hiN-loN) - 1
function fisherSeries(closes, highs, lows, period = 10) {
  const out = new Array(closes.length).fill(0);
  for (let i = period - 1; i < closes.length; i++) {
    let loN = Infinity, hiN = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hiN) hiN = highs[j];
      if (lows[j] < loN) loN = lows[j];
    }
    const range = hiN - loN;
    if (range < 1e-10) { out[i] = out[i - 1] || 0; continue; }
    let x = 2 * ((closes[i] - loN) / range) - 1;
    x = Math.max(-0.999, Math.min(0.999, x));
    out[i] = 0.5 * Math.log((1 + x) / (1 - x));
  }
  return out;
}

// CCI = (price - SMA) / (0.015 * meanDeviation)
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

// Williams %R = (highN - close) / (highN - lowN) * -100
function williamsSeries(closes, highs, lows, period = 14) {
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

// Connors RSI: (RSI(3) + streakRSI(2) + percentileRank(100)) / 3
function crsiSeries(closes, period = 100) {
  const out = new Array(closes.length).fill(50);
  const rsi3 = rsiSeries(closes, 3);
  // streak
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
    const pct = (below / period) * 100;
    out[i] = (rsi3[i] + rsiStreak[i] + pct) / 3;
  }
  return out;
}

// Stochastic RSI
function stochRSISeries(closes, rsiPeriod = 14, stochPeriod = 14, dPeriod = 3) {
  const rsiArr = rsiSeries(closes, rsiPeriod);
  const kArr = new Array(closes.length).fill(50);
  for (let i = rsiPeriod + stochPeriod - 2; i < closes.length; i++) {
    let loR = Infinity, hiR = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsiArr[j] > hiR) hiR = rsiArr[j];
      if (rsiArr[j] < loR) loR = rsiArr[j];
    }
    const range = hiR - loR;
    kArr[i] = range < 1e-10 ? 50 : (rsiArr[i] - loR) / range * 100;
  }
  const dArr = smaSeries(kArr, dPeriod);
  return { k: kArr, d: dArr };
}

// Heikin-Ashi: compute HA candles from standard OHLCV
function haSeries(candles) {
  const ha = [];
  let prevHAOpen = (candles[0].open + candles[0].close) / 2;
  let prevHAClose = (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4;
  for (let i = 0; i < candles.length; i++) {
    const haClose = (candles[i].open + candles[i].high + candles[i].low + candles[i].close) / 4;
    const haOpen = (prevHAOpen + prevHAClose) / 2;
    const haHigh = Math.max(candles[i].high, haOpen, haClose);
    const haLow = Math.min(candles[i].low, haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
    prevHAOpen = haOpen;
    prevHAClose = haClose;
  }
  return ha;
}

// ─── Walk-Forward Validation ─────────────────────────────────────────────────

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
      const win = sig === 'BULL' ? actualUp : !actualUp;
      if (win) wins++;
      total++;
    }
    if (total >= 10) results.push({ wr: wins / total, n: total });
  }
  if (results.length === 0) return { wr: 0, tradesPerDay: 0, folds: 0 };
  results.sort((a, b) => a.wr - b.wr);
  const median = results[Math.floor(results.length / 2)];
  // candles per day: 288 per day for 5m
  const totalCandles = candles.length;
  const totalDays = totalCandles / 288;
  const totalTrades = results.reduce((s, r) => s + r.n, 0);
  const tradesPerDay = totalTrades / totalDays / folds;
  return { wr: median.wr, tradesPerDay, folds: results.length };
}

// ─── Strategy Factories ───────────────────────────────────────────────────────

function makeFisherBB22(ftPeriod, threshold) {
  return function(candles, i) {
    // Need: fisher series + BB22
    // We compute on-the-fly for the signal function (series pre-computed outside)
    return null; // placeholder — real implementation uses pre-computed series
  };
}

// ─── Main Research Function ───────────────────────────────────────────────────

function researchCoin(symbol) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${symbol} — Session 10 Strategy Research`);
  console.log('='.repeat(60));

  const candles = loadCandles(symbol, '5m');
  if (candles.length < 500) {
    console.log(`  ⚠️  Insufficient data: ${candles.length} candles`);
    return {};
  }
  console.log(`  Loaded ${candles.length} 5m candles (${(candles.length / 288).toFixed(0)} days)`);

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  // Pre-compute all indicator series
  const sma20  = smaSeries(closes, 20);
  const std20  = stdSeries(closes, sma20, 20);
  const sma14  = smaSeries(closes, 14);
  const atr14  = atrSeries(candles, 14);
  const rsi7   = rsiSeries(closes, 7);
  const rsi14  = rsiSeries(closes, 14);

  const ft10   = fisherSeries(closes, highs, lows, 10);
  const ft5    = fisherSeries(closes, highs, lows, 5);
  const cci20  = cciSeries(closes, sma20, 20);
  const cci14  = cciSeries(closes, sma14, 14);
  const wpr14  = williamsSeries(closes, highs, lows, 14);
  const wpr5   = williamsSeries(closes, highs, lows, 5);
  const crsi20 = crsiSeries(closes, 100); // CRSI with 100-period percentile
  const stochK = stochRSISeries(closes, 14, 14, 3).k;
  const stochD = stochRSISeries(closes, 14, 14, 3).d;
  const haCandles = haSeries(candles);

  // BB(20,2.2) — upper and lower
  const bb22Upper = sma20.map((s, i) => s + 2.2 * std20[i]);
  const bb22Lower = sma20.map((s, i) => s - 2.2 * std20[i]);
  // BB(20,1.8) — tighter
  const bb18Upper = sma20.map((s, i) => s + 1.8 * std20[i]);
  const bb18Lower = sma20.map((s, i) => s - 1.8 * std20[i]);

  // EMA(20) for Keltner
  const ema20  = emaSeries(closes, 20);
  const kcUpper = ema20.map((e, i) => e + 2.0 * atr14[i]);
  const kcLower = ema20.map((e, i) => e - 2.0 * atr14[i]);

  const results = {};

  // ─── Strategy definitions ───────────────────────────────────────────────────

  const strategies = [
    // 1. Fisher Transform (10) > 1.5 at BB22 extreme
    {
      name: 'Fisher>1.5 + BB22',
      fn: (i) => {
        const ft = ft10[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (ft > 1.5 && cl > up) return 'BEAR';
        if (ft < -1.5 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 2. Fisher Transform (10) > 2.0 (extreme)
    {
      name: 'Fisher>2.0 + BB22',
      fn: (i) => {
        const ft = ft10[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (ft > 2.0 && cl > up) return 'BEAR';
        if (ft < -2.0 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 3. Fisher (5) > 1.5 — faster signal
    {
      name: 'Fisher5>1.5 + BB22',
      fn: (i) => {
        const ft = ft5[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (ft > 1.5 && cl > up) return 'BEAR';
        if (ft < -1.5 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 4. Fisher + RSI7 confirmation
    {
      name: 'Fisher + RSI7 + BB22',
      fn: (i) => {
        const ft = ft10[i], rsi = rsi7[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (ft > 1.2 && rsi > 68 && cl > up) return 'BEAR';
        if (ft < -1.2 && rsi < 32 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 5. CCI (20) > 150 at BB22
    {
      name: 'CCI>150 + BB22',
      fn: (i) => {
        const cci = cci20[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (cci > 150 && cl > up) return 'BEAR';
        if (cci < -150 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 6. CCI (20) > 100 at BB22
    {
      name: 'CCI>100 + BB22',
      fn: (i) => {
        const cci = cci20[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (cci > 100 && cl > up) return 'BEAR';
        if (cci < -100 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 7. CCI (20) > 200 — extreme signal, fewer trades but higher WR
    {
      name: 'CCI>200 + BB22',
      fn: (i) => {
        const cci = cci20[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (cci > 200 && cl > up) return 'BEAR';
        if (cci < -200 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 8. CCI (14) + RSI7 confirmation
    {
      name: 'CCI14>120 + RSI7 + BB22',
      fn: (i) => {
        const cci = cci14[i], rsi = rsi7[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (cci > 120 && rsi > 68 && cl > up) return 'BEAR';
        if (cci < -120 && rsi < 32 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 9. Williams %R (14) < -80 + BB22 lower (oversold)
    {
      name: 'WPR14<-80 + BB22',
      fn: (i) => {
        const wr = wpr14[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (wr > -20 && cl > up) return 'BEAR';  // WPR > -20 = overbought
        if (wr < -80 && cl < lo) return 'BULL';  // WPR < -80 = oversold
        return null;
      }
    },
    // 10. Williams %R (14) extreme + RSI7
    {
      name: 'WPR14 + RSI7 + BB22',
      fn: (i) => {
        const wr = wpr14[i], rsi = rsi7[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (wr > -15 && rsi > 70 && cl > up) return 'BEAR';
        if (wr < -85 && rsi < 30 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 11. Williams %R (5) — fast 5-period
    {
      name: 'WPR5<-80 + BB22',
      fn: (i) => {
        const wr = wpr5[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (wr > -20 && cl > up) return 'BEAR';
        if (wr < -80 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 12. Williams %R (14) standalone (no BB filter) — high volume
    {
      name: 'WPR14<-80 (no BB)',
      fn: (i) => {
        const wr = wpr14[i];
        if (wr > -15) return 'BEAR';
        if (wr < -85) return 'BULL';
        return null;
      }
    },
    // 13. CRSI (20/80) — wider thresholds for more trades
    {
      name: 'CRSI (20/80)',
      fn: (i) => {
        const crsi = crsi20[i];
        if (crsi > 80) return 'BEAR';
        if (crsi < 20) return 'BULL';
        return null;
      }
    },
    // 14. CRSI (25/75) — even more trades
    {
      name: 'CRSI (25/75)',
      fn: (i) => {
        const crsi = crsi20[i];
        if (crsi > 75) return 'BEAR';
        if (crsi < 25) return 'BULL';
        return null;
      }
    },
    // 15. CRSI (20/80) + BB22 confirmation
    {
      name: 'CRSI (20/80) + BB22',
      fn: (i) => {
        const crsi = crsi20[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (crsi > 80 && cl > up) return 'BEAR';
        if (crsi < 20 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 16. Keltner Squeeze: BB outside KC = volatility expansion = continue; BB inside KC = squeeze building
    //     Actually for REVERSAL: price outside BB + inside KC (near KC boundary) = exhaustion signal
    {
      name: 'Keltner Reversal (BB in KC)',
      fn: (i) => {
        const cl = closes[i], up22 = bb22Upper[i], lo22 = bb22Lower[i];
        const kcU = kcUpper[i], kcL = kcLower[i];
        // Price outside BB22 but inside KC: moderate extreme
        if (cl > up22 && cl < kcU) return 'BEAR';
        if (cl < lo22 && cl > kcL) return 'BULL';
        return null;
      }
    },
    // 17. Keltner Outer: price outside BOTH BB22 and KC = extreme overextension = strong reversal
    {
      name: 'Keltner Outer (> KC)',
      fn: (i) => {
        const cl = closes[i], kcU = kcUpper[i], kcL = kcLower[i];
        if (cl > kcU) return 'BEAR';
        if (cl < kcL) return 'BULL';
        return null;
      }
    },
    // 18. Heikin-Ashi reversal at BB22
    //     When HA candle switches from bullish to bearish (no lower wick) at upper BB = exhaustion
    {
      name: 'Heikin-Ashi Rev + BB22',
      fn: (i) => {
        if (i < 2) return null;
        const ha = haCandles[i], haPrev = haCandles[i - 1];
        const cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        // Previous HA bullish, current HA bearish at upper BB
        if (haPrev.close > haPrev.open && ha.close < ha.open && cl > up) return 'BEAR';
        // Previous HA bearish, current HA bullish at lower BB
        if (haPrev.close < haPrev.open && ha.close > ha.open && cl < lo) return 'BULL';
        return null;
      }
    },
    // 19. Fisher + CRSI combo — dual mean-reversion confirmation
    {
      name: 'Fisher + CRSI + BB22',
      fn: (i) => {
        const ft = ft10[i], crsi = crsi20[i], cl = closes[i], up = bb22Upper[i], lo = bb22Lower[i];
        if (ft > 1.2 && crsi > 75 && cl > up) return 'BEAR';
        if (ft < -1.2 && crsi < 25 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 20. BB(20,1.8) + Williams %R — tight band for high volume
    {
      name: 'WPR14<-80 + BB18',
      fn: (i) => {
        const wr = wpr14[i], cl = closes[i], up = bb18Upper[i], lo = bb18Lower[i];
        if (wr > -20 && cl > up) return 'BEAR';
        if (wr < -80 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 21. StochRSI extreme + BB18 (wider signal set than BB22)
    {
      name: 'StochRSI<20 + BB18',
      fn: (i) => {
        const k = stochK[i], d = stochD[i], cl = closes[i];
        const up = bb18Upper[i], lo = bb18Lower[i];
        if (k > 80 && d > 80 && cl > up) return 'BEAR';
        if (k < 20 && d < 20 && cl < lo) return 'BULL';
        return null;
      }
    },
    // 22. Fisher (10) standalone — no BB filter — high volume
    {
      name: 'Fisher10>1.5 (no BB)',
      fn: (i) => {
        const ft = ft10[i];
        if (ft > 1.5) return 'BEAR';
        if (ft < -1.5) return 'BULL';
        return null;
      }
    },
    // 23. CCI standalone (no BB) — very high volume
    {
      name: 'CCI20>100 (no BB)',
      fn: (i) => {
        const cci = cci20[i];
        if (cci > 100) return 'BEAR';
        if (cci < -100) return 'BULL';
        return null;
      }
    },
  ];

  const minIdx = Math.max(200, Math.floor(candles.length * 0.2));

  for (const strat of strategies) {
    const wfResult = walkForward(
      candles,
      (c, i) => i >= minIdx ? strat.fn(i) : null,
      5
    );

    const ev = wfResult.wr * 0.49 - (1 - wfResult.wr) * 0.51;
    const flag = wfResult.wr >= 0.57 ? '🏆🏆' : wfResult.wr >= 0.54 ? '🏆' : wfResult.wr >= 0.52 ? '✅' : wfResult.wr >= 0.51 ? '💰' : '❌';

    results[strat.name] = { wr: wfResult.wr, tpd: wfResult.tradesPerDay, ev };
    console.log(`  ${flag} ${strat.name.padEnd(30)} WR=${(wfResult.wr * 100).toFixed(1)}% @${wfResult.tradesPerDay.toFixed(0)}/day  EV=${(ev * 100).toFixed(2)}%`);
  }

  return results;
}

// ─── Run all coins and summarize ─────────────────────────────────────────────

const coins = ['ETH', 'BTC', 'SOL', 'XRP'];
const allResults = {};

for (const symbol of coins) {
  allResults[symbol] = researchCoin(symbol);
}

// ─── Summary: best strategies across all coins ───────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  SUMMARY: Best Multi-Coin Strategies (>51% WR, >5 trades/day)');
console.log('='.repeat(70));

const stratNames = Object.keys(allResults['ETH'] || {});
for (const sn of stratNames) {
  const wrArr = coins.map(c => allResults[c]?.[sn]?.wr || 0);
  const tpdArr = coins.map(c => allResults[c]?.[sn]?.tpd || 0);
  const avgWR = wrArr.reduce((a, b) => a + b, 0) / wrArr.length;
  const totalTPD = tpdArr.reduce((a, b) => a + b, 0);
  const allProfitable = wrArr.every(w => w > 0.51);
  if (avgWR >= 0.53 && totalTPD >= 5) {
    const flag = avgWR >= 0.57 ? '🏆🏆' : avgWR >= 0.55 ? '🏆' : avgWR >= 0.53 ? '✅' : '';
    const perCoin = coins.map((c, i) => `${c}:${(wrArr[i]*100).toFixed(1)}%`).join('  ');
    console.log(`${flag} ${sn.padEnd(30)} avg=${(avgWR*100).toFixed(1)}%  total=${totalTPD.toFixed(0)}/day`);
    console.log(`   ${perCoin}`);
  }
}

console.log('\n✅ Session 10 Research Complete!');
db.close();
