/**
 * SESSION 13 HIGH-WR RESEARCH — Push ETH/SOL/XRP to >75% WR
 *
 * Context:
 *   Strat 92 achieved BTC=76.2% WR with: GH[BTC]+ADX<20+RSI7>73+MFI>72+BB22
 *   Remaining gaps: ETH=60%, SOL~58%, XRP=72.7%
 *
 * New approaches:
 *   A) Ultra-tight ADX (<15, <12) × GH — stricter ranging filter
 *   B) BB(20,1.8) + GH — high-freq base known to give 72-76% all-hours
 *   C) 6-condition ultra-selective (strat92 + extra filter)
 *   D) StochRSI (K of RSI series) — new oscillator type
 *   E) Deep RSI3 in GH (<5 or >95)
 *   F) CCI extremes in GH
 *   G) Expanded good hours (try BTC hours for ETH, etc.)
 *   H) ADX<20 + volume spike in GH
 *
 * Correct binary exit: next 5m candle close (fixed-expiry)
 * Fee: 2% spread → breakeven ≈ 51.02%
 * 5-fold walk-forward validation | median WR | min 5 trades/fold
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

// Alternate hour sets to test
const ALT_HOURS = {
  ETH_TIGHT: new Set([12, 21]),          // ETH 2 best hours
  ETH_BTC_UNION: new Set([1, 10, 11, 12, 13, 16, 20, 21]), // ETH ∪ BTC
  ETH_BTC_INTER: new Set([12]),           // ETH ∩ BTC = only hour 12
  SOL_TIGHT: new Set([12, 13]),           // SOL 2 best hours
  XRP_TIGHT: new Set([12, 18]),           // XRP 2 best hours
  SOL_EXPANDED: new Set([0, 12, 13, 16, 20]), // SOL + BTC-style hours
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
    const up = c.high - p.high, dn = p.low - c.low;
    trArr.push(tr);
    pmDM.push(up > dn && up > 0 ? up : 0);
    nmDM.push(dn > up && dn > 0 ? dn : 0);
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
    if (dx.length === period) adxSmooth = dx.reduce((a, b) => a + b, 0) / period;
    else if (dx.length > period) adxSmooth = (adxSmooth * (period - 1) + dxVal) / period;
    if (dx.length >= period) adx[i + 1] = adxSmooth;
  }
  return adx;
}

function mfiSeries(candles, period) {
  const out = new Array(candles.length).fill(50);
  for (let i = period; i < candles.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const tpPrev = (candles[j-1].high + candles[j-1].low + candles[j-1].close) / 3;
      const mf = tp * candles[j].volume;
      if (tp > tpPrev) pos += mf; else neg += mf;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

function streakSeries(closes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] > 0 ? out[i - 1] + 1 : 1;
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] < 0 ? out[i - 1] - 1 : -1;
    else out[i] = 0;
  }
  return out;
}

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

// StochRSI: K line of RSI series (RSI of RSI)
function stochRsiSeries(closes, rsiPeriod = 14, stochPeriod = 14) {
  const rsiArr = rsiSeries(closes, rsiPeriod);
  return rsiArr.map((r, i) => {
    if (i < stochPeriod - 1) return 50;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsiArr[j] > hi) hi = rsiArr[j];
      if (rsiArr[j] < lo) lo = rsiArr[j];
    }
    return (hi - lo) < 1e-10 ? 50 : (r - lo) / (hi - lo) * 100;
  });
}

// CCI = (price - sma) / (0.015 * meanDev)
function cciSeries(candles, period = 20) {
  const out = new Array(candles.length).fill(0);
  const typPrices = candles.map(c => (c.high + c.low + c.close) / 3);
  const smaArr = smaSeries(typPrices, period);
  for (let i = period - 1; i < candles.length; i++) {
    let meanDev = 0;
    for (let j = i - period + 1; j <= i; j++) meanDev += Math.abs(typPrices[j] - smaArr[i]);
    meanDev /= period;
    out[i] = meanDev < 1e-10 ? 0 : (typPrices[i] - smaArr[i]) / (0.015 * meanDev);
  }
  return out;
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

function pct(r) { return `${(r.wr*100).toFixed(1)}%`; }
function fire(wr) { return wr > 0.75 ? '🔥🔥🔥 >75%!' : wr > 0.70 ? '🔥🔥 >70%!' : wr > 0.65 ? '🔥 >65%' : ''; }

// ─── Research per coin ────────────────────────────────────────────────────────

function researchCoin(symbol) {
  console.log(`\n${'='.repeat(65)}`);
  console.log(`  ${symbol} — Session 13 High-WR Research`);
  console.log('='.repeat(65));

  const candles = loadCandles(symbol, '5m');
  if (candles.length < 500) { console.log('  ⚠️  Insufficient data'); return {}; }
  console.log(`  Loaded ${candles.length} 5m candles (${(candles.length / 288).toFixed(0)} days)`);

  const gh = GOOD_HOURS[symbol] || new Set([10, 12, 13]);

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  // ─── Indicator series ─────────────────────────────────────────────────────
  const sma20    = smaSeries(closes, 20);
  const std20    = stdSeries(closes, sma20, 20);
  // BB(20, 2.2) — standard
  const bb22Up   = sma20.map((s, i) => s + 2.2 * std20[i]);
  const bb22Lo   = sma20.map((s, i) => s - 2.2 * std20[i]);
  // BB(20, 1.8) — tighter, fires more often
  const bb18Up   = sma20.map((s, i) => s + 1.8 * std20[i]);
  const bb18Lo   = sma20.map((s, i) => s - 1.8 * std20[i]);
  // BB(20, 2.5) — deeper, fewer signals
  const bb25Up   = sma20.map((s, i) => s + 2.5 * std20[i]);
  const bb25Lo   = sma20.map((s, i) => s - 2.5 * std20[i]);
  // BB%B (20,2.2)
  const bbPctB   = closes.map((c, i) => std20[i] > 0 ? (c - bb22Lo[i]) / (bb22Up[i] - bb22Lo[i]) : 0.5);

  const rsi3     = rsiSeries(closes, 3);
  const rsi5     = rsiSeries(closes, 5);
  const rsi7     = rsiSeries(closes, 7);
  const rsi14    = rsiSeries(closes, 14);
  const adx14    = adxSeries(candles, 14);
  const mfi14    = mfiSeries(candles, 14);
  const streak5m = streakSeries(closes);
  const crsi100  = crsiSeries(closes, 100);
  const stochK5  = stochKSeries(candles, 5);
  const stochRsi14 = stochRsiSeries(closes, 14, 14);
  const cci20    = cciSeries(candles, 20);
  const atr14    = atrSeries(candles, 14);
  const vol20    = smaSeries(volumes, 20);

  const results = {};

  const log = (name, r) => {
    results[name] = r;
    console.log(`  ${name.padEnd(40)} WR=${pct(r).padEnd(7)} ${r.tradesPerDay.toFixed(2)}/d  n=${r.totalTrades} ${fire(r.wr)}`);
  };

  // ── SECTION A: Ultra-tight ADX × GH ──────────────────────────────────────

  // A1. GH + ADX<15 + RSI7>73 + MFI>72 + BB22 (strat92 but ADX stricter)
  log('A1_GH+ADX15+RSI73+MFI72+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // A2. GH + ADX<15 + RSI7>72 + BB22 (fewer conditions, tighter ADX)
  log('A2_GH+ADX15+RSI72+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (rsi7[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // A3. GH + ADX<12 + RSI7>70 + BB22 (extremely tight ADX = very low trend)
  log('A3_GH+ADX12+RSI70+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 12) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // A4. GH + ADX<15 + CRSI>80 + BB22 (tight ADX + ConnorsRSI)
  log('A4_GH+ADX15+CRSI80+BB22', walkForward(candles, (c, i) => {
    if (i < 105 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (crsi100[i] > 80 && cl > bb22Up[i]) return 'BEAR';
    if (crsi100[i] < 20 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // A5. GH + ADX<15 + RSI7>70 + MFI>70 + BB22 (looser thresholds than A1)
  log('A5_GH+ADX15+RSI70+MFI70+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION B: BB(20,1.8) + GH ───────────────────────────────────────────
  // BB(20,1.8) fires more often; known 72-76% WR all-hours; test with GH filter

  // B1. GH + BB(20,1.8) + RSI7>70 (tighter band + good hours + RSI)
  log('B1_GH+BB18+RSI70', walkForward(candles, (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && cl > bb18Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && cl < bb18Lo[i]) return 'BULL';
    return null;
  }));

  // B2. GH + BB(20,1.8) + RSI7>72 + MFI>68 (BB18 + dual oscillator)
  log('B2_GH+BB18+RSI72+MFI68', walkForward(candles, (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (rsi7[i] > 72 && mfi14[i] > 68 && cl > bb18Up[i]) return 'BEAR';
    if (rsi7[i] < 28 && mfi14[i] < 32 && cl < bb18Lo[i]) return 'BULL';
    return null;
  }));

  // B3. GH + BB(20,1.8) + ADX<20 + RSI7>68 (BB18 + ranging market)
  log('B3_GH+BB18+ADX20+RSI68', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 68 && cl > bb18Up[i]) return 'BEAR';
    if (rsi7[i] < 32 && cl < bb18Lo[i]) return 'BULL';
    return null;
  }));

  // B4. GH + BB(20,1.8) + ADX<20 + RSI7>70 + MFI>68 (4 conditions + BB18)
  log('B4_GH+BB18+ADX20+RSI70+MFI68', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 68 && cl > bb18Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 32 && cl < bb18Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION C: 6-condition ultra-selective ────────────────────────────────

  // C1. GH + ADX<20 + RSI7>73 + MFI>72 + Streak>=1 + BB22 (strat92 + streak)
  log('C1_GH+ADX20+RSI73+MFI72+Streak1+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (streak5m[i] >= 1 && rsi7[i] > 73 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (streak5m[i] <= -1 && rsi7[i] < 27 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // C2. GH + ADX<20 + RSI7>73 + MFI>72 + RSI14>68 + BB22 (strat92 + RSI14 confirm)
  log('C2_GH+ADX20+RSI73+MFI72+RSI14+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && rsi14[i] > 68 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && rsi14[i] < 32 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // C3. GH + ADX<15 + RSI7>70 + MFI>70 + CRSI>78 + BB22 (ADX15 + CRSI)
  log('C3_GH+ADX15+RSI70+MFI70+CRSI78+BB22', walkForward(candles, (c, i) => {
    if (i < 105 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (crsi100[i] > 78 && rsi7[i] > 70 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (crsi100[i] < 22 && rsi7[i] < 30 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // C4. GH + ADX<20 + RSI7>73 + MFI>72 + RSI5>78 + BB22 (add RSI5 to strat92)
  log('C4_GH+ADX20+RSI73+MFI72+RSI5_78+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && rsi5[i] > 78 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && rsi5[i] < 22 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // C5. GH + ADX<20 + RSI7>76 + MFI>75 + BB22 (strat92 with deeper thresholds)
  log('C5_GH+ADX20+RSI76+MFI75+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 76 && mfi14[i] > 75 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 24 && mfi14[i] < 25 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION D: StochRSI in GH ─────────────────────────────────────────────

  // D1. GH + StochRSI>85 + BB22 (K of RSI extreme in good hours)
  log('D1_GH+StochRSI85+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (stochRsi14[i] > 85 && cl > bb22Up[i]) return 'BEAR';
    if (stochRsi14[i] < 15 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // D2. GH + StochRSI>85 + RSI7>68 + BB22 (double-confirm)
  log('D2_GH+StochRSI85+RSI68+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (stochRsi14[i] > 85 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (stochRsi14[i] < 15 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // D3. GH + ADX<20 + StochRSI>85 + RSI7>68 + BB22 (ADX + StochRSI)
  log('D3_GH+ADX20+StochRSI85+RSI68+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (stochRsi14[i] > 85 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (stochRsi14[i] < 15 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION E: CCI extremes in GH ────────────────────────────────────────

  // E1. GH + CCI>150 + RSI7>68 + BB22 (CCI extreme = over-extended)
  log('E1_GH+CCI150+RSI68+BB22', walkForward(candles, (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (cci20[i] > 150 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (cci20[i] < -150 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // E2. GH + ADX<20 + CCI>130 + RSI7>68 + BB22 (ranging + CCI)
  log('E2_GH+ADX20+CCI130+RSI68+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (cci20[i] > 130 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (cci20[i] < -130 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION F: RSI3 extremes in GH ───────────────────────────────────────

  // F1. GH + RSI3>95 + RSI7>70 + BB22 (ultra-extreme RSI3)
  log('F1_GH+RSI3_95+RSI7_70+BB22', walkForward(candles, (c, i) => {
    if (i < 15 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (rsi3[i] > 95 && rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi3[i] < 5 && rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // F2. GH + ADX<20 + RSI3>93 + BB22 (ranging + extreme RSI3)
  log('F2_GH+ADX20+RSI3_93+BB22', walkForward(candles, (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi3[i] > 93 && cl > bb22Up[i]) return 'BEAR';
    if (rsi3[i] < 7 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION G: Alternate hour sets ────────────────────────────────────────

  const altHours = symbol === 'ETH' ? ALT_HOURS.ETH_TIGHT :
                   symbol === 'SOL' ? ALT_HOURS.SOL_TIGHT :
                   symbol === 'XRP' ? ALT_HOURS.XRP_TIGHT : gh;

  // G1. Tight GH (2 best hours only) + ADX<20 + RSI7>70 + MFI>68 + BB22
  log('G1_TightGH+ADX20+RSI70+MFI68+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !altHours.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // G2. Tight GH + ADX<20 + RSI7>73 + MFI>72 + BB22 (strat92 with 2-hour filter)
  log('G2_TightGH+ADX20+RSI73+MFI72+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !altHours.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // G3. Hour 12 only (shared peak hour all coins) + ADX<20 + RSI7>70 + MFI>70 + BB22
  const hour12Only = new Set([12]);
  log('G3_H12only+ADX20+RSI70+MFI70+BB22', walkForward(candles, (c, i) => {
    if (i < 30 || !hour12Only.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION H: BB(20,2.5) deep extremes ──────────────────────────────────

  // H1. GH + BB(20,2.5) + RSI7>68 (deeper BB deviation → stronger mean-rev)
  log('H1_GH+BB25+RSI68', walkForward(candles, (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (rsi7[i] > 68 && cl > bb25Up[i]) return 'BEAR';
    if (rsi7[i] < 32 && cl < bb25Lo[i]) return 'BULL';
    return null;
  }));

  // H2. GH + BB(20,2.5) + RSI7>70 + MFI>70 + ADX<20 (4 conditions + deeper BB)
  log('H2_GH+BB25+RSI70+MFI70+ADX20', walkForward(candles, (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 70 && cl > bb25Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 30 && cl < bb25Lo[i]) return 'BULL';
    return null;
  }));

  // ── SECTION I: Volume patterns in GH ─────────────────────────────────────

  // I1. GH + VolSpike3x + RSI7>68 + BB22 (very large volume surge)
  log('I1_GH+VolSpike3x+RSI68+BB22', walkForward(candles, (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    const volSpike = vol20[i] > 0 && volumes[i] > 3.0 * vol20[i];
    if (volSpike && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (volSpike && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  // I2. GH + ADX<20 + VolSpike2x + RSI7>68 + BB22 (ranging + vol surge)
  log('I2_GH+ADX20+VolSpike2x+RSI68+BB22', walkForward(candles, (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    const volSpike = vol20[i] > 0 && volumes[i] > 2.0 * vol20[i];
    if (volSpike && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (volSpike && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  }));

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('\n' + '█'.repeat(65));
  console.log('  SESSION 13 HIGH-WR — Pushing ETH/SOL/XRP to >75%');
  console.log('█'.repeat(65));
  console.log('  New approaches: ultra-ADX, BB18+GH, 6-condition, StochRSI, CCI, ALT_HOURS');
  console.log('  Exit: next 5m candle close | Breakeven: 51.02% with 2% fee');
  console.log('  5-fold walk-forward | MINIMUM 5 trades per fold');

  const coins = ['ETH', 'BTC', 'SOL', 'XRP'];
  const allResults = {};
  for (const coin of coins) {
    allResults[coin] = researchCoin(coin);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(65));
  console.log('  SESSION 13 SUMMARY — ranked by avg WR across coins');
  console.log('─'.repeat(65));

  const strategies = Object.keys(allResults['ETH'] || {});
  const summary = [];
  for (const strat of strategies) {
    const rows = [];
    for (const coin of coins) {
      const r = allResults[coin]?.[strat];
      if (r && r.wr > 0.51 && r.tradesPerDay >= 0.01) {
        rows.push({ coin, wr: r.wr, tpd: r.tradesPerDay, n: r.totalTrades });
      }
    }
    if (rows.length === 0) continue;
    const avgWr = rows.reduce((a, b) => a + b.wr, 0) / rows.length;
    const totalTpd = rows.reduce((a, b) => a + b.tpd, 0);
    summary.push({ strat, avgWr, totalTpd, rows });
  }

  summary.sort((a, b) => b.avgWr - a.avgWr);
  console.log('\n  All strategies ranked by avg WR (profitable coins only):');
  for (const s of summary) {
    const f = s.avgWr > 0.75 ? ' 🔥🔥🔥 HOLY GRAIL!' :
              s.avgWr > 0.70 ? ' 🔥🔥 >70%!' :
              s.avgWr > 0.65 ? ' 🔥 >65%' : '';
    console.log(`  ${s.strat.padEnd(45)} avg=${(s.avgWr*100).toFixed(1)}%  tpd=${s.totalTpd.toFixed(2)}${f}`);
    for (const r of s.rows) {
      console.log(`    ${r.coin}: ${(r.wr*100).toFixed(1)}% @ ${r.tpd.toFixed(2)}/day (n=${r.n})`);
    }
  }

  // Best single-coin
  console.log('\n  BEST PER-COIN (any strategy, top 3):');
  for (const coin of coins) {
    const coinRes = Object.entries(allResults[coin] || {})
      .filter(([, r]) => r.wr > 0.51 && r.totalTrades >= 5)
      .sort(([, a], [, b]) => b.wr - a.wr)
      .slice(0, 3);
    if (coinRes.length === 0) { console.log(`  ${coin}: no profitable strategies`); continue; }
    console.log(`  ${coin}:`);
    for (const [strat, r] of coinRes) {
      const f = r.wr > 0.75 ? '🔥🔥🔥' : r.wr > 0.70 ? '🔥🔥' : r.wr > 0.65 ? '🔥' : '';
      console.log(`    ${(r.wr*100).toFixed(1)}% @ ${r.tradesPerDay.toFixed(2)}/d  → ${strat} ${f}`);
    }
  }

  // >75% WR strategies specifically
  console.log('\n  ═══ >75% WR STRATEGIES (the holy grail): ═══');
  let found75 = false;
  for (const s of summary) {
    for (const r of s.rows) {
      if (r.wr >= 0.75 && r.n >= 10) {
        console.log(`  🔥🔥🔥 ${r.coin} ${s.strat}: ${(r.wr*100).toFixed(1)}% WR @ ${r.tpd.toFixed(2)}/day (n=${r.n})`);
        found75 = true;
      }
    }
  }
  if (!found75) console.log('  None found at >75% with n≥10. Best results listed above.');

  db.close();
}

main();
