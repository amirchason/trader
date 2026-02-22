/**
 * SESSION 12 RESEARCH — Advanced Confluence + Market Structure
 *
 * New pattern families targeting higher confidence + more trades:
 *   1. ADX Low + BB22 — ADX<20 (ranging) = ideal mean-reversion env; BB extreme → reversal
 *   2. Rolling N-bar High/Low Reversion — close at 10/15-bar high/low + RSI7 extreme
 *   3. Double RSI Confirmation — RSI(7)>70 AND RSI(14)>65 simultaneously at BB upper
 *   4. VWAP Loose (0.6% dev) — rolling 50-bar VWAP, looser threshold → more trades
 *   5. BB(20,1.5)+RSI7 — tighter bands (more triggers) + RSI7 extreme
 *   6. Pivot-Range Reversal — price at prev 24-candle high/low + RSI7 extreme
 *   7. Price Velocity — 1-candle move >0.3% (sharp spike) at BB extreme = exhaustion
 *   8. MFI Overbought + BB — MFI(14)>80 + price above BB upper = volume exhaustion
 *   9. RSI Divergence 10-bar — price new high + RSI lower high over 10 bars (more trades)
 *  10. BB Width Squeeze Release — BB was narrow (low bw) then expands at extreme = fakeout
 *  11. ROC(5) + RSI7 + BB — 5-bar rate of change extreme + RSI extreme at BB
 *  12. Stochastic BB — Stoch(5,3) overbought + close above BB upper (fast stoch)
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

// ADX series (+DI, -DI, ADX)
function adxSeries(candles, period) {
  const n = candles.length;
  const adx = new Array(n).fill(25);
  if (n < period * 2) return adx;

  const trArr = [];
  const pmDM = []; // +DM
  const nmDM = []; // -DM
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    trArr.push(tr);
    pmDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    nmDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing
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
    if (dx.length >= period) {
      adx[i + 1] = adxSmooth;
    }
  }
  return adx;
}

// MFI (Money Flow Index)
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

// Stochastic K and D
function stochSeries(candles, kPeriod, dPeriod) {
  const n = candles.length;
  const kArr = new Array(n).fill(50);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    kArr[i] = (hi - lo) < 1e-10 ? 50 : (candles[i].close - lo) / (hi - lo) * 100;
  }
  const dArr = smaSeries(kArr, dPeriod);
  return { k: kArr, d: dArr };
}

// Rolling VWAP (50 bars)
function vwapSeries(candles, period) {
  const out = new Array(candles.length).fill(0);
  for (let i = period - 1; i < candles.length; i++) {
    let sumPV = 0, sumV = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      sumPV += tp * candles[j].volume;
      sumV  += candles[j].volume;
    }
    out[i] = sumV > 0 ? sumPV / sumV : candles[i].close;
  }
  return out;
}

// Rate of Change
function rocSeries(closes, period) {
  return closes.map((c, i) =>
    i >= period && closes[i - period] !== 0
      ? (c - closes[i - period]) / closes[i - period] * 100
      : 0
  );
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
    if (total >= 10) results.push({ wr: wins / total, n: total });
  }
  if (results.length === 0) return { wr: 0, tradesPerDay: 0 };
  results.sort((a, b) => a.wr - b.wr);
  const median = results[Math.floor(results.length / 2)];
  const totalTrades = results.reduce((s, r) => s + r.n, 0);
  const totalDays = candles.length / 288;
  return { wr: median.wr, tradesPerDay: totalTrades / totalDays / folds };
}

// ─── Research per coin ────────────────────────────────────────────────────────

function researchCoin(symbol) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${symbol} — Session 12 Research`);
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
  const bb15Up   = sma20.map((s, i) => s + 1.5 * std20[i]); // tighter band
  const bb15Lo   = sma20.map((s, i) => s - 1.5 * std20[i]);
  const bbBw     = std20.map((s, i) => (bb22Up[i] - bb22Lo[i]) / (sma20[i] || 1) * 100); // bandwidth%
  const bbPctB   = closes.map((c, i) => std20[i] > 0 ? (c - bb22Lo[i]) / (bb22Up[i] - bb22Lo[i]) : 0.5);

  const rsi14    = rsiSeries(closes, 14);
  const rsi7     = rsiSeries(closes, 7);
  const rsi3     = rsiSeries(closes, 3);
  const adx14    = adxSeries(candles, 14);
  const mfi14    = mfiSeries(candles, 14);
  const stoch5   = stochSeries(candles, 5, 3);
  const vwap50   = vwapSeries(candles, 50);
  const roc5     = rocSeries(closes, 5);
  const roc3     = rocSeries(closes, 3);
  const atr14    = atrSeries(candles, 14);

  // Vol average (20-bar)
  const vol20 = smaSeries(volumes, 20);

  const results = {};

  // ─────────────────────────────────────────────────────────────
  // 1. ADX Low + BB22 (ranging market + BB extreme)
  // ADX<20 means non-trending = ideal mean reversion environment
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      const adx = adx14[i];
      const cl = closes[i];
      const dev22Hi = (cl - bb22Up[i]) / (bb22Up[i] || 1) * 100;
      const dev22Lo = (bb22Lo[i] - cl) / (bb22Lo[i] || 1) * 100;
      if (adx < 20) {
        if (dev22Hi > 0.04 && rsi7[i] > 65) return 'BEAR';
        if (dev22Lo > 0.04 && rsi7[i] < 35) return 'BULL';
      }
      return null;
    };
    const r = walkForward(candles, sig);
    results['ADX<20+BB22+RSI7'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  ADX<20+BB22+RSI7:          WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Rolling N-bar High/Low Reversion
  // Close at 10-bar high/low + RSI7 extreme = exhaustion reversal
  // ─────────────────────────────────────────────────────────────
  {
    const N = 10;
    const sig = (c, i) => {
      if (i < N + 5) return null;
      let hiN = -Infinity, loN = Infinity;
      for (let j = i - N + 1; j <= i; j++) {
        if (closes[j] > hiN) hiN = closes[j];
        if (closes[j] < loN) loN = closes[j];
      }
      if (closes[i] >= hiN && rsi7[i] > 68) return 'BEAR';
      if (closes[i] <= loN && rsi7[i] < 32) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['10barHL+RSI7'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  10barHL+RSI7:              WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 2b. Rolling 15-bar High/Low Reversion (more selective)
  // ─────────────────────────────────────────────────────────────
  {
    const N = 15;
    const sig = (c, i) => {
      if (i < N + 5) return null;
      let hiN = -Infinity, loN = Infinity;
      for (let j = i - N + 1; j <= i; j++) {
        if (closes[j] > hiN) hiN = closes[j];
        if (closes[j] < loN) loN = closes[j];
      }
      if (closes[i] >= hiN && rsi7[i] > 65) return 'BEAR';
      if (closes[i] <= loN && rsi7[i] < 35) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['15barHL+RSI7'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  15barHL+RSI7:              WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Double RSI Confirmation (RSI7 + RSI14 both extreme)
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      const cl = closes[i];
      if (rsi7[i] > 72 && rsi14[i] > 65 && cl > bb22Up[i]) return 'BEAR';
      if (rsi7[i] < 28 && rsi14[i] < 35 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['DoubleRSI(7+14)+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  DoubleRSI(7+14)+BB22:      WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 4. VWAP Loose Deviation (0.6%) + RSI7 + BB22
  // Looser threshold than S11 to get more trades
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 55) return null;
      const vwap = vwap50[i];
      if (vwap === 0) return null;
      const devPct = (closes[i] - vwap) / vwap * 100;
      const cl = closes[i];
      if (devPct > 0.6 && rsi7[i] > 65 && cl > bb22Up[i]) return 'BEAR';
      if (devPct < -0.6 && rsi7[i] < 35 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['VWAP0.6%Dev+RSI7+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  VWAP0.6%Dev+RSI7+BB22:     WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 4b. VWAP Even Looser (0.4%) + BB22
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 55) return null;
      const vwap = vwap50[i];
      if (vwap === 0) return null;
      const devPct = (closes[i] - vwap) / vwap * 100;
      const cl = closes[i];
      if (devPct > 0.4 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
      if (devPct < -0.4 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['VWAP0.4%Dev+RSI7+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  VWAP0.4%Dev+RSI7+BB22:     WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 5. BB(20,1.5)+RSI7 — tighter bands → more triggers
  // More trades than BB22 with still-valid mean reversion
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      const cl = closes[i];
      const dev15Hi = (cl - bb15Up[i]) / (bb15Up[i] || 1) * 100;
      const dev15Lo = (bb15Lo[i] - cl) / (bb15Lo[i] || 1) * 100;
      if (dev15Hi > 0.04 && rsi7[i] > 65) return 'BEAR';
      if (dev15Lo > 0.04 && rsi7[i] < 35) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['BB15+RSI7'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  BB(20,1.5)+RSI7:           WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 6. MFI Overbought + BB22 (volume-price exhaustion)
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 20) return null;
      const cl = closes[i];
      if (mfi14[i] > 80 && cl > bb22Up[i]) return 'BEAR';
      if (mfi14[i] < 20 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['MFI80+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  MFI(>80/<20)+BB22:         WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 6b. MFI+RSI7+BB22 (triple volume+momentum+price)
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 20) return null;
      const cl = closes[i];
      if (mfi14[i] > 75 && rsi7[i] > 65 && cl > bb22Up[i]) return 'BEAR';
      if (mfi14[i] < 25 && rsi7[i] < 35 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['MFI75+RSI7+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  MFI(75/25)+RSI7+BB22:      WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 7. Price Velocity — single-candle >0.3% move at BB extreme
  // Large single candle spike = exhaustion, reversal follows
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      const cl = closes[i];
      const op = candles[i].open;
      const bodyPct = Math.abs(cl - op) / op * 100;
      const up = cl > op;
      if (up && bodyPct > 0.3 && cl > bb22Up[i] && rsi7[i] > 62) return 'BEAR';
      if (!up && bodyPct > 0.3 && cl < bb22Lo[i] && rsi7[i] < 38) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['PriceVelocity0.3%+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  PriceVelocity(>0.3%)+BB22: WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 7b. Price Velocity 0.2% (more trades)
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      const cl = closes[i];
      const op = candles[i].open;
      const bodyPct = Math.abs(cl - op) / op * 100;
      const up = cl > op;
      if (up && bodyPct > 0.2 && cl > bb22Up[i] && rsi7[i] > 65) return 'BEAR';
      if (!up && bodyPct > 0.2 && cl < bb22Lo[i] && rsi7[i] < 35) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['PriceVelocity0.2%+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  PriceVelocity(>0.2%)+BB22: WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 8. RSI Divergence 10-bar (broader lookback for more trades)
  // Price makes higher high but RSI makes lower high → bearish divergence
  // ─────────────────────────────────────────────────────────────
  {
    const N = 10;
    const sig = (c, i) => {
      if (i < N + 5) return null;
      const cl = closes[i];

      // Bearish: price higher than N bars ago, RSI lower
      const priceHigher = cl > closes[i - N];
      const rsiLower = rsi7[i] < rsi7[i - N];
      if (priceHigher && rsiLower && cl > bb22Up[i] * 0.998 && rsi7[i] > 60) return 'BEAR';

      // Bullish: price lower than N bars ago, RSI higher
      const priceLower = cl < closes[i - N];
      const rsiHigher = rsi7[i] > rsi7[i - N];
      if (priceLower && rsiHigher && cl < bb22Lo[i] * 1.002 && rsi7[i] < 40) return 'BULL';

      return null;
    };
    const r = walkForward(candles, sig);
    results['RSI7Div10bar+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  RSI7Div(10bar)+BB22:       WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 9. BB Bandwidth Squeeze Release
  // BB was very narrow (squeeze) → then expanded → price at extreme = fakeout reversal
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      const cl = closes[i];
      // Squeeze: prev 10-bar avg BW was low (<2%), now BW expanding
      const bwPrev10 = bbBw.slice(i - 10, i).reduce((a, b) => a + b, 0) / 10;
      const bwNow = bbBw[i];
      const wasSqueezed = bwPrev10 < 2.5;
      const nowExpanded = bwNow > bwPrev10 * 1.3;
      if (wasSqueezed && nowExpanded) {
        if (cl > bb22Up[i] && rsi7[i] > 62) return 'BEAR';
        if (cl < bb22Lo[i] && rsi7[i] < 38) return 'BULL';
      }
      return null;
    };
    const r = walkForward(candles, sig);
    results['BBSqueezeRelease+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  BBSqueeze→Release+BB22:    WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 10. ROC(5) Extreme + RSI7 + BB22
  // 5-bar rate of change >0.5% (rapid move) at BB = overextension
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 30) return null;
      const cl = closes[i];
      const roc = roc5[i];
      if (roc > 0.5 && rsi7[i] > 65 && cl > bb22Up[i]) return 'BEAR';
      if (roc < -0.5 && rsi7[i] < 35 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['ROC5_0.5%+RSI7+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  ROC5(>0.5%)+RSI7+BB22:    WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 11. Stochastic(5,3) Extreme + BB22
  // Fast stochastic K>90/<10 at BB extreme = double momentum exhaustion
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 15) return null;
      const cl = closes[i];
      if (stoch5.k[i] > 88 && cl > bb22Up[i]) return 'BEAR';
      if (stoch5.k[i] < 12 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['Stoch5K_88+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  FastStoch(5)>88+BB22:      WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 11b. Stoch(5,3) K+D both extreme + BB22
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 15) return null;
      const cl = closes[i];
      if (stoch5.k[i] > 85 && stoch5.d[i] > 80 && cl > bb22Up[i]) return 'BEAR';
      if (stoch5.k[i] < 15 && stoch5.d[i] < 20 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['FastStochKD+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  FastStoch(5)K+D+BB22:      WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 12. Volume Spike 1.5x + RSI7 + BB22 (looser volume filter)
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      const cl = closes[i];
      const volSpike = vol20[i] > 0 && volumes[i] > 1.5 * vol20[i];
      if (volSpike && rsi7[i] > 65 && cl > bb22Up[i]) return 'BEAR';
      if (volSpike && rsi7[i] < 35 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['VolSpike1.5x+RSI7+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  VolSpike(1.5x)+RSI7+BB22:  WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 13. RSI3 Extreme + BB22 (looser threshold 85 vs 90)
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 10) return null;
      const cl = closes[i];
      if (rsi3[i] > 85 && cl > bb22Up[i]) return 'BEAR';
      if (rsi3[i] < 15 && cl < bb22Lo[i]) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['RSI3_85+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  RSI3(>85/<15)+BB22:        WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 14. BB(20,1.5)+RSI7+VolSpike (tighter band + volume)
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 25) return null;
      const cl = closes[i];
      const volOk = vol20[i] > 0 && volumes[i] > 1.3 * vol20[i];
      const dev15Hi = (cl - bb15Up[i]) / (bb15Up[i] || 1) * 100;
      const dev15Lo = (bb15Lo[i] - cl) / (bb15Lo[i] || 1) * 100;
      if (dev15Hi > 0.03 && rsi7[i] > 67 && volOk) return 'BEAR';
      if (dev15Lo > 0.03 && rsi7[i] < 33 && volOk) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['BB15+RSI7+Vol1.3x'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  BB(20,1.5)+RSI7+Vol1.3x:   WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 15. ATR Body Ratio (wicks dominate = indecision at extreme)
  // Body < 30% of ATR at BB extreme = exhaustion candle
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 20) return null;
      const cl = closes[i];
      const op = candles[i].open;
      const body = Math.abs(cl - op);
      const atr = atr14[i];
      const wickDom = atr > 0 && body < atr * 0.3; // wick-dominated candle
      if (wickDom && cl > bb22Up[i] && rsi7[i] > 62) return 'BEAR';
      if (wickDom && cl < bb22Lo[i] && rsi7[i] < 38) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['WickDom+BB22+RSI7'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  WickDominated+BB22+RSI7:   WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  // ─────────────────────────────────────────────────────────────
  // 16. High Candle Range + BB22 (wide range candle at extreme)
  // Candle range > 1.5×ATR at BB = exhaustion blowoff
  // ─────────────────────────────────────────────────────────────
  {
    const sig = (c, i) => {
      if (i < 20) return null;
      const cl = closes[i];
      const range = candles[i].high - candles[i].low;
      const wideRange = atr14[i] > 0 && range > 1.5 * atr14[i];
      if (wideRange && cl > bb22Up[i] && rsi7[i] > 60) return 'BEAR';
      if (wideRange && cl < bb22Lo[i] && rsi7[i] < 40) return 'BULL';
      return null;
    };
    const r = walkForward(candles, sig);
    results['WideRange1.5xATR+BB22'] = r;
    const flag = r.wr > 0.555 ? '🏆🏆' : r.wr > 0.54 ? '🏆' : '';
    console.log(`  WideRange(1.5×ATR)+BB22:   WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(1)}/day  ${flag}`);
  }

  return results;
}

// ─── Summary across all coins ─────────────────────────────────────────────────

function main() {
  console.log('\n' + '█'.repeat(60));
  console.log('  SESSION 12 RESEARCH — Advanced Confluence Patterns');
  console.log('█'.repeat(60));
  console.log('  Exit model: CORRECT (next candle close, fixed-expiry)');
  console.log('  Breakeven WR with 2% fee: 51.02%');
  console.log('  Validation: 5-fold walk-forward, median WR');

  const coins = ['ETH', 'BTC', 'SOL', 'XRP'];
  const allResults = {};
  for (const coin of coins) {
    allResults[coin] = researchCoin(coin);
  }

  // ─── Cross-coin summary ───────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log('  CROSS-COIN SUMMARY');
  console.log('─'.repeat(60));

  const strategies = Object.keys(allResults['ETH'] || {});
  const summary = [];
  for (const strat of strategies) {
    const wrs = [], tpds = [];
    for (const coin of coins) {
      const r = allResults[coin]?.[strat];
      if (r && r.wr > 0 && r.tradesPerDay > 0.05) {
        wrs.push(r.wr);
        tpds.push(r.tradesPerDay);
      }
    }
    if (wrs.length === 0) continue;
    const avgWr = wrs.reduce((a, b) => a + b, 0) / wrs.length;
    const totalTpd = tpds.reduce((a, b) => a + b, 0);
    summary.push({ strat, avgWr, totalTpd, coinCount: wrs.length });
  }

  summary.sort((a, b) => b.avgWr - a.avgWr);
  console.log('\n  Ranked by avg WR (all coins combined):');
  for (const s of summary) {
    const flag = s.avgWr > 0.555 ? ' 🏆🏆 IMPLEMENT' : s.avgWr > 0.540 ? ' 🏆 CONSIDER' : '';
    console.log(
      `  ${s.strat.padEnd(28)} avgWR=${(s.avgWr*100).toFixed(1)}%  totalTPD=${s.totalTpd.toFixed(1)}/day  coins=${s.coinCount}${flag}`
    );
  }

  console.log('\n  ══ TOP CANDIDATES FOR IMPLEMENTATION ══');
  const topCandidates = summary.filter(s => s.avgWr > 0.540 && s.totalTpd >= 1.0);
  if (topCandidates.length === 0) {
    console.log('  (None above threshold with sufficient trade volume)');
    // Show borderline
    const borderline = summary.filter(s => s.avgWr > 0.525 && s.totalTpd >= 2.0).slice(0, 5);
    if (borderline.length > 0) {
      console.log('  Borderline (may still be worth testing):');
      for (const s of borderline) {
        console.log(`    ${s.strat}: ${(s.avgWr*100).toFixed(1)}% WR, ${s.totalTpd.toFixed(1)}/day`);
      }
    }
  } else {
    for (const s of topCandidates) {
      console.log(`  ✅ ${s.strat}: avg ${(s.avgWr*100).toFixed(1)}% WR, ${s.totalTpd.toFixed(1)}/day total`);
      for (const coin of coins) {
        const r = allResults[coin]?.[s.strat];
        if (r && r.wr > 0 && r.tradesPerDay > 0.05) {
          console.log(`     ${coin}: WR=${(r.wr*100).toFixed(1)}% @ ${r.tradesPerDay.toFixed(1)}/day`);
        }
      }
    }
  }

  db.close();
}

main();
