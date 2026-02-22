'use strict';
/**
 * Fast Patterns V2 — TradingView-Style + Micro-Momentum
 *
 * Optimized: pre-computes all indicators in O(n) time using incremental updates.
 * Tests 15+ strategies across ETH/BTC/SOL/XRP with walk-forward validation.
 *
 * KEY DISCOVERIES FROM PREVIOUS RUNS:
 * - Connors RSI (10/90): ETH 54.8% WR @ 51/day ← VERY PROMISING
 * - Connors RSI (20/80): ETH 53.3% WR @ 110/day ← HIGH VOLUME
 * - Fair Value Gap: ETH 53.4% WR @ 40/day ← SOLID
 * - Mean reversion dominates: align with overall finding
 *
 * NEW STRATEGIES TO TEST:
 * - Connors RSI with BB filter (higher WR, less volume)
 * - FVG + RSI confirmation
 * - Micro-momentum from 1m: last sub-candle direction
 * - Squeeze breakout (fixed: not TTM since fails, use BB width squeeze)
 * - DEMA (Double EMA) crossover — lag-free momentum
 * - Adaptive RSI — Connors RSI variant with adaptive periods
 * - Volume-weighted CRSI
 */

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(process.cwd(), 'trader.db'), { readonly: true });

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const DAYS = 184;

function getCandles(symbol, tf) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume
     FROM candles WHERE symbol = ? AND timeframe = ?
     ORDER BY open_time ASC`
  ).all(symbol, tf);
}

// ─── Fast Incremental Indicators ──────────────────────────────────────────────

// Pre-compute RSI incrementally for a closes array
// Returns array of RSI values (same length as closes, 0 for first 'period' entries)
function computeRSISeries(closes, period) {
  const n = closes.length;
  const rsi = new Float64Array(n).fill(50);
  if (n <= period) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// Pre-compute EMA series incrementally
function computeEMASeries(closes, period) {
  const n = closes.length;
  const ema = new Float64Array(n);
  if (n < period) return ema;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) ema[i] = e;
  for (let i = period; i < n; i++) {
    e = closes[i] * k + e * (1 - k);
    ema[i] = e;
  }
  return ema;
}

// Pre-compute BB series (returns arrays of upper, lower, mid, std)
function computeBBSeries(closes, period, mult) {
  const n = closes.length;
  const upper = new Float64Array(n);
  const lower = new Float64Array(n);
  const mid   = new Float64Array(n);
  const std_  = new Float64Array(n);

  // Use running sum + sum of squares for O(n) BB
  let sumX = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += closes[i];
    sumX2 += closes[i] ** 2;
    if (i >= period) {
      sumX  -= closes[i - period];
      sumX2 -= closes[i - period] ** 2;
    }
    if (i >= period - 1) {
      const m = sumX / period;
      const v = sumX2 / period - m * m;
      const s = v > 0 ? Math.sqrt(v) : 0;
      mid[i]   = m;
      std_[i]  = s;
      upper[i] = m + mult * s;
      lower[i] = m - mult * s;
    }
  }
  return { upper, lower, mid, std: std_ };
}

// Pre-compute ATR series
function computeATRSeries(candles, period) {
  const n = candles.length;
  const atr = new Float64Array(n);
  let runATR = 0;

  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i < period) {
      runATR += tr;
      if (i === period - 1) runATR /= period;
    } else {
      runATR = (runATR * (period - 1) + tr) / period;
    }
    atr[i] = runATR;
  }
  return atr;
}

// Pre-compute OBV series
function computeOBVSeries(candles) {
  const n = candles.length;
  const obv = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    if (candles[i].close > candles[i - 1].close) obv[i] = obv[i - 1] + candles[i].volume;
    else if (candles[i].close < candles[i - 1].close) obv[i] = obv[i - 1] - candles[i].volume;
    else obv[i] = obv[i - 1];
  }
  return obv;
}

// Pre-compute streak series
function computeStreakSeries(candles) {
  const n = candles.length;
  const streaks = new Int8Array(n);
  let s = 0;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    if (c.close > c.open) s = s > 0 ? Math.min(s + 1, 10) : 1;
    else if (c.close < c.open) s = s < 0 ? Math.max(s - 1, -10) : -1;
    else s = 0;
    streaks[i] = s;
  }
  return streaks;
}

// Connors RSI components pre-computed
// cRSI = (RSI3 + streakRSI2 + percentileRank100) / 3
function computeConnorsRSI(closes, streaks, period = 100) {
  const n = closes.length;
  const crsi = new Float64Array(n).fill(50);

  const rsi3  = computeRSISeries(closes, 3);
  const srsi2 = computeRSISeries(streaks, 2); // streakRSI

  for (let i = period; i < n; i++) {
    const ret = closes[i] - closes[i - 1];
    const retPct = closes[i - 1] > 0 ? ret / closes[i - 1] : 0;

    // Percentile rank of current return vs last 'period' returns
    let below = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const r = closes[j - 1] > 0 ? (closes[j] - closes[j - 1]) / closes[j - 1] : 0;
      if (r < retPct) below++;
    }
    const pRank = (below / period) * 100;
    crsi[i] = (rsi3[i] + srsi2[i] + pRank) / 3;
  }
  return crsi;
}

// ─── VWAP Day-indexed (fast) ──────────────────────────────────────────────────
function computeVWAPSeries(candles) {
  const n = candles.length;
  const vwap = new Float64Array(n);

  let cumPV = 0, cumV = 0;
  let dayStart = 0;

  for (let i = 0; i < n; i++) {
    const d = new Date(candles[i].open_time);
    const dayTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

    if (i === 0 || candles[i].open_time < dayTs + 86400000 && candles[dayStart].open_time < dayTs) {
      // New day
      const thisDayTs = dayTs;
      if (i > 0 && candles[i - 1].open_time < thisDayTs) {
        cumPV = 0; cumV = 0; dayStart = i;
      }
    }

    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumPV += tp * candles[i].volume;
    cumV  += candles[i].volume;
    vwap[i] = cumV > 0 ? cumPV / cumV : candles[i].close;
  }
  return vwap;
}

// ─── Main Analysis ────────────────────────────────────────────────────────────

function analyzeStrategies(coin, candles5m, candles1m) {
  const n = candles5m.length;
  const closes = candles5m.map(c => c.close);
  const fcloses = new Float64Array(closes);

  console.log(`  Pre-computing indicators for ${coin}...`);

  // Pre-compute all indicator series
  const rsi3  = computeRSISeries(fcloses, 3);
  const rsi7  = computeRSISeries(fcloses, 7);
  const rsi14 = computeRSISeries(fcloses, 14);
  const ema9  = computeEMASeries(fcloses, 9);
  const ema21 = computeEMASeries(fcloses, 21);
  const ema50 = computeEMASeries(fcloses, 50);
  const bb20  = computeBBSeries(fcloses, 20, 2.2);
  const bb20t = computeBBSeries(fcloses, 20, 2.0);
  const bb20l = computeBBSeries(fcloses, 20, 1.8);  // tighter band
  const atr14 = computeATRSeries(candles5m, 14);
  const streaks= computeStreakSeries(candles5m);
  const obv   = computeOBVSeries(candles5m);
  const vwap  = computeVWAPSeries(candles5m);

  // Connors RSI using streaks (as float array)
  const streakF = new Float64Array(n);
  for (let i = 0; i < n; i++) streakF[i] = streaks[i];
  const crsi = computeConnorsRSI(fcloses, streakF, 100);

  // 1m last-candle features (pre-indexed by 5m epoch)
  const idx1m = {};
  if (candles1m) {
    for (const c of candles1m) {
      // Index by 5m epoch start: round down to nearest 5min
      const epoch = Math.floor(c.open_time / 300000) * 300000;
      if (!idx1m[epoch]) idx1m[epoch] = [];
      idx1m[epoch].push(c);
    }
  }

  // ── Strategy Functions (use pre-computed arrays) ──────────────────────────

  function exitResult(i) {
    // Binary outcome: next candle close direction
    if (i + 1 >= n) return null;
    return candles5m[i + 1].close > candles5m[i].close;
  }

  // ── 1. Connors RSI (10/90) — mean reversion
  function s_crsi_10() {
    const trades = [];
    for (let i = 100; i < n - 1; i++) {
      const sig = crsi[i] < 10 ? 'BULL' : (crsi[i] > 90 ? 'BEAR' : null);
      if (!sig) continue;
      const won = sig === 'BULL' ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Connors RSI (10/90)', trades };
  }

  // ── 2. Connors RSI (15/85) — moderate threshold
  function s_crsi_15() {
    const trades = [];
    for (let i = 100; i < n - 1; i++) {
      const sig = crsi[i] < 15 ? 'BULL' : (crsi[i] > 85 ? 'BEAR' : null);
      if (!sig) continue;
      const won = sig === 'BULL' ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Connors RSI (15/85)', trades };
  }

  // ── 3. Connors RSI (20/80) — high volume
  function s_crsi_20() {
    const trades = [];
    for (let i = 100; i < n - 1; i++) {
      const sig = crsi[i] < 20 ? 'BULL' : (crsi[i] > 80 ? 'BEAR' : null);
      if (!sig) continue;
      const won = sig === 'BULL' ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Connors RSI (20/80)', trades };
  }

  // ── 4. Connors RSI + BB filter (only trade when also outside BB)
  function s_crsi_bb() {
    const trades = [];
    for (let i = 100; i < n - 1; i++) {
      const c = candles5m[i].close;
      const bull = crsi[i] < 15 && c < bb20.lower[i];
      const bear = crsi[i] > 85 && c > bb20.upper[i];
      if (!bull && !bear) continue;
      const won = bull ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Connors RSI + BB (15/85)', trades };
  }

  // ── 5. Connors RSI + streak filter
  function s_crsi_streak() {
    const trades = [];
    for (let i = 100; i < n - 1; i++) {
      const s = streaks[i];
      const bull = crsi[i] < 20 && s <= -2;  // CRSI oversold + 2+ bear streak
      const bear = crsi[i] > 80 && s >= 2;   // CRSI overbought + 2+ bull streak
      if (!bull && !bear) continue;
      const won = bull ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Connors RSI + Streak', trades };
  }

  // ── 6. Fair Value Gap (FVG) — gap in price structure
  function s_fvg() {
    const trades = [];
    for (let i = 2; i < n - 1; i++) {
      const c0 = candles5m[i - 2], c2 = candles5m[i];
      const minGap = c2.close * 0.0005;
      const bullFVG = c0.low > c2.high + minGap;   // gap below → fill up = BULL
      const bearFVG = c0.high < c2.low - minGap;   // gap above → fill down = BEAR
      if (!bullFVG && !bearFVG) continue;
      const won = bullFVG ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Fair Value Gap', trades };
  }

  // ── 7. FVG + RSI confirmation
  function s_fvg_rsi() {
    const trades = [];
    for (let i = 14; i < n - 1; i++) {
      const c0 = candles5m[i - 2], c2 = candles5m[i];
      const minGap = c2.close * 0.0003;
      const bullFVG = c0.low > c2.high + minGap && rsi14[i] < 50;
      const bearFVG = c0.high < c2.low - minGap && rsi14[i] > 50;
      if (!bullFVG && !bearFVG) continue;
      const won = bullFVG ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'FVG + RSI14 confirm', trades };
  }

  // ── 8. Liquidity Sweep Reversal (stop hunt → reversal)
  function s_liq_sweep() {
    const trades = [];
    for (let i = 20; i < n - 1; i++) {
      const c = candles5m[i];
      let recentHigh = -Infinity, recentLow = Infinity;
      for (let j = i - 20; j < i; j++) {
        recentHigh = Math.max(recentHigh, candles5m[j].high);
        recentLow  = Math.min(recentLow, candles5m[j].low);
      }
      const bearSweep = c.high > recentHigh && c.close < recentHigh * 0.999;
      const bullSweep = c.low < recentLow && c.close > recentLow * 1.001;
      if (!bearSweep && !bullSweep) continue;
      const won = bullSweep ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Liquidity Sweep', trades };
  }

  // ── 9. Liq Sweep + RSI/BB confirmation
  function s_liq_bb() {
    const trades = [];
    for (let i = 20; i < n - 1; i++) {
      const c = candles5m[i];
      let recentHigh = -Infinity, recentLow = Infinity;
      for (let j = i - 20; j < i; j++) {
        recentHigh = Math.max(recentHigh, candles5m[j].high);
        recentLow  = Math.min(recentLow, candles5m[j].low);
      }
      const bearSweep = c.high > recentHigh && c.close < recentHigh * 0.999 && rsi14[i] > 60;
      const bullSweep = c.low < recentLow && c.close > recentLow * 1.001 && rsi14[i] < 40;
      if (!bearSweep && !bullSweep) continue;
      const won = bullSweep ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Liq Sweep + RSI confirm', trades };
  }

  // ── 10. BB tight band (1.8) + RSI7 extremes (high frequency)
  function s_bb18_rsi7() {
    const trades = [];
    for (let i = 25; i < n - 1; i++) {
      const c = candles5m[i].close;
      const bull = c < bb20l.lower[i] && rsi7[i] < 35;
      const bear = c > bb20l.upper[i] && rsi7[i] > 65;
      if (!bull && !bear) continue;
      const won = bull ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'BB(20,1.8)+RSI7', trades };
  }

  // ── 11. BB(20,2.2) + streak mean reversion (existing strat 67 variant)
  function s_bb22_streak() {
    const trades = [];
    for (let i = 25; i < n - 1; i++) {
      const c = candles5m[i].close;
      const s = streaks[i];
      const bull = c < bb20.lower[i] && s <= -1;
      const bear = c > bb20.upper[i] && s >= 1;
      if (!bull && !bear) continue;
      const won = bull ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'BB(20,2.2)+Streak', trades };
  }

  // ── 12. VWAP deviation mean reversion
  function s_vwap_dev() {
    const trades = [];
    for (let i = 20; i < n - 1; i++) {
      const c = candles5m[i].close;
      const atr = atr14[i];
      if (atr === 0) continue;
      const dev = (c - vwap[i]) / atr;
      const bull = dev < -2.0;
      const bear = dev > 2.0;
      if (!bull && !bear) continue;
      const won = bull ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'VWAP Dev ±2.0 ATR', trades };
  }

  // ── 13. VWAP + RSI confirmation
  function s_vwap_rsi() {
    const trades = [];
    for (let i = 20; i < n - 1; i++) {
      const c = candles5m[i].close;
      const atr = atr14[i];
      if (atr === 0) continue;
      const dev = (c - vwap[i]) / atr;
      const bull = dev < -1.5 && rsi14[i] < 45;
      const bear = dev > 1.5 && rsi14[i] > 55;
      if (!bull && !bear) continue;
      const won = bull ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'VWAP+RSI confirm', trades };
  }

  // ── 14. Engulfing pattern + BB zone
  function s_engulf_bb() {
    const trades = [];
    for (let i = 20; i < n - 1; i++) {
      const c = candles5m[i], p = candles5m[i - 1];
      const bodyC = Math.abs(c.close - c.open);
      const bodyP = Math.abs(p.close - p.open);
      const atr = atr14[i];

      const bullEngulf = p.close < p.open && c.close > c.open &&
                         c.open < p.close && c.close > p.open &&
                         bodyC > bodyP * 1.3 && bodyC > atr * 0.25;
      const bearEngulf = p.close > p.open && c.close < c.open &&
                         c.open > p.close && c.close < p.open &&
                         bodyC > bodyP * 1.3 && bodyC > atr * 0.25;

      // Only when in BB extreme zone
      const inBBRange = c.close < bb20.lower[i] * 1.002 || c.close > bb20.upper[i] * 0.998;
      if (!inBBRange || (!bullEngulf && !bearEngulf)) continue;

      const won = bullEngulf ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'Engulfing + BB zone', trades };
  }

  // ── 15. Micro-momentum from 1m: last 1m candle direction as predictor
  function s_micro_1m() {
    if (!candles1m) return { name: 'Micro 1m momentum', trades: [] };
    const trades = [];
    for (let i = 5; i < n - 1; i++) {
      const epochTs = candles5m[i].open_time;
      // Get the last 5 × 1m candles of the PREVIOUS 5m epoch
      const prevEpoch = epochTs - 300000;
      const sub1m = idx1m[prevEpoch];
      if (!sub1m || sub1m.length < 4) continue;

      // Count bull vs bear 1m candles
      const bullCount = sub1m.filter(c => c.close > c.open).length;
      const bullFrac = bullCount / sub1m.length;

      // Last 1m candle direction
      const lastC = sub1m[sub1m.length - 1];
      const lastBull = lastC.close > lastC.open;

      // Mean reversion: if last 5 1m candles are all bull → expect reversal → BEAR
      if (bullFrac >= 0.8 && lastBull) {
        const won = !exitResult(i); // BEAR
        trades.push({ ts: epochTs, won });
      } else if (bullFrac <= 0.2 && !lastBull) {
        const won = exitResult(i); // BULL
        trades.push({ ts: epochTs, won });
      }
    }
    return { name: 'Micro 1m reversion', trades };
  }

  // ── 16. Micro 1m with BB context
  function s_micro_1m_bb() {
    if (!candles1m) return { name: 'Micro 1m + BB', trades: [] };
    const trades = [];
    for (let i = 25; i < n - 1; i++) {
      const epochTs = candles5m[i].open_time;
      const prevEpoch = epochTs - 300000;
      const sub1m = idx1m[prevEpoch];
      if (!sub1m || sub1m.length < 3) continue;

      const bullCount = sub1m.filter(c => c.close > c.open).length;
      const bullFrac = bullCount / sub1m.length;
      const c = candles5m[i].close;

      // Mean reversion + BB: 1m all-bull AND price at upper BB → strong BEAR
      if (bullFrac >= 0.8 && c > bb20.upper[i] * 0.999) {
        const won = !exitResult(i); // BEAR
        trades.push({ ts: epochTs, won });
      } else if (bullFrac <= 0.2 && c < bb20.lower[i] * 1.001) {
        const won = exitResult(i); // BULL
        trades.push({ ts: epochTs, won });
      }
    }
    return { name: 'Micro 1m + BB', trades };
  }

  // ── 17. CRSI + EMA trend alignment (more selective)
  function s_crsi_ema() {
    const trades = [];
    for (let i = 100; i < n - 1; i++) {
      const c = candles5m[i].close;
      const above50 = c > ema50[i];
      // Only trade reversals AGAINST the 50 EMA trend (stronger mean reversion)
      const bull = crsi[i] < 20 && !above50; // CRSI oversold below EMA50 → strong reversal
      const bear = crsi[i] > 80 && above50;  // CRSI overbought above EMA50
      if (!bull && !bear) continue;
      const won = bull ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'CRSI + EMA50 trend', trades };
  }

  // ── 18. OBV divergence (fast version using pre-computed OBV)
  function s_obv_div() {
    const trades = [];
    const lookback = 15;
    for (let i = lookback; i < n - 1; i++) {
      const priceHigh1 = Math.max(...candles5m.slice(i - lookback, i - lookback/2).map(c => c.close));
      const priceHigh2 = Math.max(...candles5m.slice(i - lookback/2, i + 1).map(c => c.close));
      const obvHigh1   = Math.max(...Array.from(obv.slice(i - lookback, i - lookback/2)));
      const obvHigh2   = Math.max(...Array.from(obv.slice(i - lookback/2, i + 1)));

      const priceLow1  = Math.min(...candles5m.slice(i - lookback, i - lookback/2).map(c => c.close));
      const priceLow2  = Math.min(...candles5m.slice(i - lookback/2, i + 1).map(c => c.close));
      const obvLow1    = Math.min(...Array.from(obv.slice(i - lookback, i - lookback/2)));
      const obvLow2    = Math.min(...Array.from(obv.slice(i - lookback/2, i + 1)));

      const bearDiv = priceHigh2 > priceHigh1 * 1.001 && obvHigh2 < obvHigh1 * 0.999;
      const bullDiv = priceLow2 < priceLow1 * 0.999 && obvLow2 > obvLow1 * 1.001;

      if (!bearDiv && !bullDiv) continue;
      const won = bullDiv ? exitResult(i) : !exitResult(i);
      if (won === null) continue;
      trades.push({ ts: candles5m[i].open_time, won });
    }
    return { name: 'OBV Divergence', trades };
  }

  const stratFns = [
    s_crsi_10, s_crsi_15, s_crsi_20, s_crsi_bb, s_crsi_streak, s_crsi_ema,
    s_fvg, s_fvg_rsi,
    s_liq_sweep, s_liq_bb,
    s_bb18_rsi7, s_bb22_streak,
    s_vwap_dev, s_vwap_rsi,
    s_engulf_bb, s_micro_1m, s_micro_1m_bb, s_obv_div,
  ];

  const results = stratFns.map(fn => fn());
  return results;
}

function walkForward(trades, nFolds = 5) {
  if (trades.length < 30) return { wr: 0, tpd: 0, folds: [], sigma: 0 };
  trades.sort((a, b) => a.ts - b.ts);
  const n = trades.length;
  const foldSize = Math.floor(n / (nFolds + 1));

  const wrFolds = [];
  for (let fold = 0; fold < nFolds; fold++) {
    const testStart = (fold + 1) * foldSize;
    const testEnd   = Math.min(testStart + foldSize, n);
    const test      = trades.slice(testStart, testEnd);
    if (test.length < 5) continue;
    const wins = test.filter(t => t.won).length;
    wrFolds.push(wins / test.length);
  }

  if (wrFolds.length === 0) return { wr: 0, tpd: 0, folds: [], sigma: 0 };

  // Median WR
  wrFolds.sort((a, b) => a - b);
  const medWR = wrFolds[Math.floor(wrFolds.length / 2)];
  const meanWR = wrFolds.reduce((s, v) => s + v, 0) / wrFolds.length;
  const sigma  = Math.sqrt(wrFolds.map(w => (w - meanWR) ** 2).reduce((s, v) => s + v, 0) / wrFolds.length);

  const spanDays = (trades[n - 1].ts - trades[0].ts) / 86400000 || 1;
  const tpd = n / spanDays;

  return { wr: medWR, tpd, folds: wrFolds, sigma };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════════════');
console.log('  Fast Patterns V2 — TradingView + Micro-Momentum Research');
console.log('  Target: 150 trades/day across 4 coins at WR > 55% after 2% fee');
console.log('═══════════════════════════════════════════════════════════════════\n');

const allCoinResults = {};

for (const coin of COINS) {
  const c5m = getCandles(coin, '5m');
  const c1m = getCandles(coin, '1m');

  console.log(`\n══ ${coin} (${c5m.length} candles) ════════════════════════════════`);
  console.log(`  Strategy                   | WR    | T/d   | EV      | σ       | Status`);
  console.log(`  ---------------------------+-------+-------+---------+---------+-------`);

  const stratResults = analyzeStrategies(coin, c5m, c1m);
  allCoinResults[coin] = [];

  for (const sr of stratResults) {
    const wf = walkForward(sr.trades);
    const ev = wf.wr * 0.49 - (1 - wf.wr) * 0.51;
    const status = wf.wr >= 0.55 && wf.tpd >= 20 ? '🏆 GREAT' :
                   wf.wr >= 0.53 && wf.tpd >= 15 ? '✅ GOOD' :
                   wf.wr >= 0.51 ? '⚠️' : '❌';
    const evStr = (ev >= 0 ? '+' : '') + (ev * 100).toFixed(2) + '%';
    console.log(`  ${sr.name.padEnd(26)} | ${(wf.wr*100).toFixed(1)}% | ${wf.tpd.toFixed(0).padStart(4)}/d | ${evStr.padStart(8)} | σ=${(wf.sigma*100).toFixed(1)}% | ${status}`);
    allCoinResults[coin].push({ name: sr.name, wr: wf.wr, tpd: wf.tpd, ev, sigma: wf.sigma });
  }
}

// ─── Aggregate Summary ────────────────────────────────────────────────────────
console.log('\n\n═══════════════════════════════════════════════════════════════════');
console.log('  AGGREGATE SUMMARY (ETH+BTC+SOL+XRP combined)');
console.log('═══════════════════════════════════════════════════════════════════');

const stratNames = allCoinResults[COINS[0]].map(r => r.name);
const aggregates = stratNames.map(name => {
  const coinData = COINS.map(c => {
    const r = allCoinResults[c].find(x => x.name === name);
    return r || { wr: 0, tpd: 0, ev: -1, sigma: 0 };
  });
  const avgWR  = coinData.reduce((s, r) => s + r.wr, 0) / coinData.length;
  const totTPD = coinData.reduce((s, r) => s + r.tpd, 0);
  const avgEV  = coinData.reduce((s, r) => s + r.ev, 0) / coinData.length;
  const avgSig = coinData.reduce((s, r) => s + r.sigma, 0) / coinData.length;
  const profitScore = avgEV * totTPD; // total expected profit rate
  return { name, avgWR, totTPD, avgEV, avgSig, profitScore, coinData };
});

aggregates.sort((a, b) => b.profitScore - a.profitScore);

console.log(`\n  Rank | Strategy                   | Avg WR | Total T/d | Avg EV  | Profit Score`);
console.log(`  -----+----------------------------+--------+-----------+---------+-------------`);

for (let i = 0; i < aggregates.length; i++) {
  const r = aggregates[i];
  const evStr = (r.avgEV >= 0 ? '+' : '') + (r.avgEV * 100).toFixed(2) + '%';
  const status = r.avgWR >= 0.55 && r.totTPD >= 80 ? '🏆' :
                 r.avgWR >= 0.53 && r.totTPD >= 40 ? '✅' :
                 r.avgWR >= 0.51 && r.totTPD >= 40 ? '⚠️' : '❌';
  console.log(`  ${(i+1).toString().padStart(4)} | ${r.name.padEnd(27)}| ${(r.avgWR*100).toFixed(1)}%  | ${r.totTPD.toFixed(0).padStart(8)}/d | ${evStr.padStart(8)} | ${r.profitScore.toFixed(3)} ${status}`);
}

// ─── Best 150/day Combinations ────────────────────────────────────────────────
console.log('\n\n═══════════════════════════════════════════════════════════════════');
console.log('  HOW TO REACH 150 TRADES/DAY — BEST COMBINATIONS');
console.log('═══════════════════════════════════════════════════════════════════');

// Pick strategies that together give 150/day and highest WR
const profitable = aggregates.filter(r => r.avgEV > 0 && r.totTPD > 20);
profitable.sort((a, b) => b.avgWR - a.avgWR);  // sort by WR for human readability

console.log('\n  Single-strategy path to 150/day:');
profitable.filter(r => r.totTPD >= 100).forEach(r => {
  const evStr = (r.avgEV >= 0 ? '+' : '') + (r.avgEV * 100).toFixed(2) + '%';
  console.log(`    "${r.name}": ${r.totTPD.toFixed(0)}/day at ${(r.avgWR*100).toFixed(1)}% WR, EV=${evStr}`);
});

console.log('\n  Per-coin breakdown for top-3 strategies:');
for (const r of profitable.slice(0, 3)) {
  console.log(`\n  ${r.name} (Total: ${r.totTPD.toFixed(0)}/day @ ${(r.avgWR*100).toFixed(1)}% WR):`);
  COINS.forEach((c, i) => {
    const d = r.coinData[i];
    const evStr = (d.ev >= 0 ? '+' : '') + (d.ev * 100).toFixed(2) + '%';
    console.log(`    ${c}: ${d.tpd.toFixed(0)}/day @ ${(d.wr*100).toFixed(1)}% WR, EV=${evStr}`);
  });
}

console.log('\n  Fee model: 2% Polymarket spread → net EV = WR*0.49 - (1-WR)*0.51');
console.log('  Walk-forward: 5-fold, median WR reported (most conservative estimate)');
