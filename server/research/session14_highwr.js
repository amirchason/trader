/**
 * SESSION 14 HIGH-WR RESEARCH — ETH >75% WR + Higher-Volume >75% Combos
 *
 * Context from Session 13:
 *   Best ETH = 71.4% (G1 TightGH[12,21]+ADX<20+RSI70+MFI68)  ← gap to close
 *   BTC 83.3%, XRP 80.0%, SOL 80.0% (all achieved >75%) ✅
 *   ETH ADX<12+RSI70+BB22 = 83.3% BUT n=11 (too few trades)
 *
 * Session 14 approaches:
 *   A) ETH-specific: hour-12 only + ultra-deep conditions (find the right combo with n≥20)
 *   B) ADX<10 (even tighter ranging) for all coins — test for statistical significance
 *   C) RSI(5) as mid-period supplementary oscillator
 *   D) Williams %R extreme + GH + ADX<20 + BB22 (new oscillator type)
 *   E) MACD histogram extreme + GH + BB22 (trend exhaustion signal)
 *   F) ETH: expanded search — different hour ranges + relaxed thresholds
 *   G) BB(20,2.0) — intermediate BB that fires more than 2.2 but deeper than 1.8
 *   H) Dual ADX condition: ADX<20 AND rising (trend strengthening vs weakening)
 *   I) RSI7 + RSI5 dual extreme (faster confirmation chain)
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

function getHourUTC(ts) { return Math.floor(ts / (1000 * 60 * 60)) % 24; }

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
    const d = closes[i] - closes[i - 1]; if (d > 0) avgG += d; else avgL -= d;
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
    sum += arr[i]; if (i >= period) sum -= arr[i - period];
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

function emaSeries(arr, period) {
  const out = new Array(arr.length).fill(0);
  const k = 2 / (period + 1);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}

function macdHistSeries(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = emaSeries(macdLine, signal);
  return macdLine.map((v, i) => v - signalLine[i]); // histogram
}

function atrSeries(candles, period) {
  const out = new Array(candles.length).fill(0);
  let atr = 0;
  for (let i = 1; i <= period && i < candles.length; i++) {
    atr += Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close));
  }
  atr /= period; out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close));
    atr = (atr * (period - 1) + tr) / period; out[i] = atr;
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
    trArr.push(tr); pmDM.push(up > dn && up > 0 ? up : 0); nmDM.push(dn > up && dn > 0 ? dn : 0);
  }
  let sTR = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPM = pmDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sNM = nmDM.slice(0, period).reduce((a, b) => a + b, 0);
  let adxSmooth = 0; const dx = [];
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
      const tpPrev = (candles[j - 1].high + candles[j - 1].low + candles[j - 1].close) / 3;
      const mf = tp * candles[j].volume;
      if (tp > tpPrev) pos += mf; else neg += mf;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

function wprSeries(candles, period) {
  return candles.map((c, i) => {
    if (i < period - 1) return -50;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    return (hi - lo) < 1e-10 ? -50 : ((hi - c.close) / (hi - lo)) * -100;
  });
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
    const currRet = closes[i] - closes[i - 1]; let below = 0;
    for (let j = i - period + 1; j <= i; j++) if (closes[j] - closes[j - 1] < currRet) below++;
    out[i] = (rsi3[i] + rsiStreak[i] + (below / period) * 100) / 3;
  }
  return out;
}

// ─── Walk-Forward Validation ──────────────────────────────────────────────────

function walkForward(candles, signalFn, folds = 5) {
  const n = candles.length;
  const foldSize = Math.floor(n / (folds + 1));
  const results = [];
  for (let f = 0; f < folds; f++) {
    const testStart = (f + 1) * foldSize;
    const testEnd   = Math.min(testStart + foldSize, n - 1);
    let wins = 0, total = 0;
    for (let i = testStart + 1; i < testEnd; i++) {
      const sig = signalFn(candles, i);
      if (!sig) continue;
      const nextClose = candles[i + 1]?.close, currClose = candles[i].close;
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
  return { wr: median.wr, tradesPerDay: totalTrades / (candles.length / 288) / folds, totalTrades };
}

function log(name, r, threshold = 0.65) {
  const f = r.wr > 0.80 ? '🔥🔥🔥🔥 >80%!' : r.wr > 0.75 ? '🔥🔥🔥 >75%!' : r.wr > 0.70 ? '🔥🔥 >70%!' : r.wr > threshold ? '🔥' : '';
  console.log(`  ${name.padEnd(48)} WR=${(r.wr*100).toFixed(1)}%  ${r.tradesPerDay.toFixed(2)}/d  n=${r.totalTrades} ${f}`);
}

// ─── Research per coin ────────────────────────────────────────────────────────

function researchCoin(symbol) {
  console.log(`\n${'='.repeat(65)}`);
  console.log(`  ${symbol} — Session 14 High-WR Research`);
  console.log('='.repeat(65));

  const candles = loadCandles(symbol, '5m');
  if (candles.length < 500) { console.log('  ⚠️  Insufficient data'); return {}; }
  console.log(`  Loaded ${candles.length} 5m candles (${(candles.length / 288).toFixed(0)} days)`);

  const gh = GOOD_HOURS[symbol];
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const sma20   = smaSeries(closes, 20);
  const std20   = stdSeries(closes, sma20, 20);
  const bb20Up  = sma20.map((s, i) => s + 2.0 * std20[i]); // BB(20,2.0)
  const bb22Up  = sma20.map((s, i) => s + 2.2 * std20[i]); // BB(20,2.2)
  const bb22Lo  = sma20.map((s, i) => s - 2.2 * std20[i]);
  const bb20Lo  = sma20.map((s, i) => s - 2.0 * std20[i]);
  const bbPctB  = closes.map((c, i) => std20[i] > 0 ? (c - bb22Lo[i]) / (bb22Up[i] - bb22Lo[i]) : 0.5);

  const rsi3    = rsiSeries(closes, 3);
  const rsi5    = rsiSeries(closes, 5);
  const rsi7    = rsiSeries(closes, 7);
  const rsi14   = rsiSeries(closes, 14);
  const adx14   = adxSeries(candles, 14);
  const adx7    = adxSeries(candles, 7);  // faster ADX
  const mfi14   = mfiSeries(candles, 14);
  const wpr14   = wprSeries(candles, 14);
  const macdH   = macdHistSeries(closes, 12, 26, 9);
  const streak5 = streakSeries(closes);
  const crsi    = crsiSeries(closes, 100);
  const atr14   = atrSeries(candles, 14);
  const vol20   = smaSeries(volumes, 20);

  const results = {};

  function test(name, fn) {
    const r = walkForward(candles, fn);
    results[name] = r;
    log(name, r);
  }

  // ── SECTION A: ETH Hour-12 Ultra-Selective ────────────────────────────────
  // Hour 12 alone has best mean-reversion for most coins; test with ultra-tight filters

  test('A1_H12+ADX20+RSI7>70+MFI68+BB22', (c, i) => {
    if (i < 30 || getHourUTC(c[i].t) !== 12 || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('A2_H12+ADX20+RSI7>72+MFI70+RSI14>65+BB22', (c, i) => {
    if (i < 30 || getHourUTC(c[i].t) !== 12 || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 72 && rsi14[i] > 65 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 28 && rsi14[i] < 35 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('A3_H12+ADX15+RSI7>70+MFI68+BB22', (c, i) => {
    if (i < 30 || getHourUTC(c[i].t) !== 12 || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('A4_H12_21+ADX20+RSI73+MFI72+RSI14>68+BB22', (c, i) => {
    if (i < 30 || ![12, 21].includes(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && rsi14[i] > 68 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && rsi14[i] < 32 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('A5_H12_21+ADX15+RSI70+MFI68+BB22', (c, i) => {
    if (i < 30 || ![12, 21].includes(getHourUTC(c[i].t)) || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION B: Fast ADX(7) — more responsive ranging filter ──────────────

  test('B1_GH+ADX7<20+RSI7>70+MFI68+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx7[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('B2_GH+ADX7<15+RSI73+MFI72+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx7[i] >= 15) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('B3_GH+ADX7<15+RSI73+MFI72+RSI14>68+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx7[i] >= 15) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && rsi14[i] > 68 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && rsi14[i] < 32 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION C: Williams %R extreme + GH ──────────────────────────────────

  test('C1_GH+WPR>-10+RSI7>68+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (wpr14[i] > -10 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (wpr14[i] < -90 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('C2_GH+WPR>-8+RSI7>70+MFI70+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    if (wpr14[i] > -8 && rsi7[i] > 70 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (wpr14[i] < -92 && rsi7[i] < 30 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('C3_GH+ADX20+WPR>-10+RSI7>68+BB22', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (wpr14[i] > -10 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (wpr14[i] < -90 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('C4_GH+ADX20+WPR>-8+RSI73+MFI72+BB22', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (wpr14[i] > -8 && rsi7[i] > 73 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (wpr14[i] < -92 && rsi7[i] < 27 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION D: RSI5 as mid-period oscillator ─────────────────────────────

  test('D1_GH+ADX20+RSI5>80+RSI7>70+BB22', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi5[i] > 80 && rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi5[i] < 20 && rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('D2_GH+ADX20+RSI5>80+RSI7>70+MFI70+BB22', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi5[i] > 80 && rsi7[i] > 70 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi5[i] < 20 && rsi7[i] < 30 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('D3_GH+ADX20+RSI5>82+RSI7>73+MFI72+BB22', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi5[i] > 82 && rsi7[i] > 73 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (rsi5[i] < 18 && rsi7[i] < 27 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('D4_GH+ADX20+RSI5>85+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi5[i] > 85 && cl > bb22Up[i]) return 'BEAR';
    if (rsi5[i] < 15 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION E: MACD histogram extreme + GH ───────────────────────────────
  // MACD histogram at extreme = trend exhaustion → reversal

  test('E1_GH+MACDhist>0_3pct+BB22', (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t))) return null;
    const cl = closes[i];
    const macdPct = cl > 0 ? macdH[i] / cl * 100 : 0;
    if (macdPct > 0.08 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (macdPct < -0.08 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('E2_GH+ADX20+MACDhist_extreme+RSI7>70+BB22', (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    const macdPct = cl > 0 ? macdH[i] / cl * 100 : 0;
    if (macdPct > 0.06 && rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (macdPct < -0.06 && rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION F: BB(20,2.0) intermediate band ──────────────────────────────
  // More signal than BB22 but less noise than BB18; test in GH context

  test('F1_GH+BB20+RSI7>72+MFI70+ADX20', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 72 && mfi14[i] > 70 && cl > bb20Up[i]) return 'BEAR';
    if (rsi7[i] < 28 && mfi14[i] < 30 && cl < bb20Lo[i]) return 'BULL';
    return null;
  });

  test('F2_GH+BB20+RSI7>73+MFI72+RSI14>68+ADX20', (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi7[i] > 73 && rsi14[i] > 68 && mfi14[i] > 72 && cl > bb20Up[i]) return 'BEAR';
    if (rsi7[i] < 27 && rsi14[i] < 32 && mfi14[i] < 28 && cl < bb20Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION G: ADX<10 ultra-tight ranging ────────────────────────────────

  test('G1_GH+ADX10+RSI7>68+BB22', (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 10) return null;
    const cl = closes[i];
    if (rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('G2_GH+ADX10+RSI7>70+MFI68+BB22', (c, i) => {
    if (i < 30 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 10) return null;
    const cl = closes[i];
    if (rsi7[i] > 70 && mfi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (rsi7[i] < 30 && mfi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION H: Dual RSI chain (RSI3+RSI5+RSI7) ───────────────────────────
  // Triple RSI cascade: all three extreme = maximum oscillator confluence

  test('H1_GH+ADX20+RSI3>90+RSI5>80+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi3[i] > 90 && rsi5[i] > 80 && cl > bb22Up[i]) return 'BEAR';
    if (rsi3[i] < 10 && rsi5[i] < 20 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('H2_GH+ADX20+RSI3>90+RSI5>80+RSI7>70+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi3[i] > 90 && rsi5[i] > 80 && rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi3[i] < 10 && rsi5[i] < 20 && rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('H3_GH+ADX20+RSI3>93+RSI5>82+MFI70+BB22', (c, i) => {
    if (i < 20 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (rsi3[i] > 93 && rsi5[i] > 82 && mfi14[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (rsi3[i] < 7 && rsi5[i] < 18 && mfi14[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION I: BB%B extreme + multiple oscillators ───────────────────────

  test('I1_GH+ADX20+PctB>1.08+RSI7>70+MFI70', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    if (bbPctB[i] > 1.08 && rsi7[i] > 70 && mfi14[i] > 70) return 'BEAR';
    if (bbPctB[i] < -0.08 && rsi7[i] < 30 && mfi14[i] < 30) return 'BULL';
    return null;
  });

  test('I2_GH+ADX20+PctB>1.08+RSI7>72+MFI72+RSI14>67', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    if (bbPctB[i] > 1.08 && rsi7[i] > 72 && rsi14[i] > 67 && mfi14[i] > 72) return 'BEAR';
    if (bbPctB[i] < -0.08 && rsi7[i] < 28 && rsi14[i] < 33 && mfi14[i] < 28) return 'BULL';
    return null;
  });

  // ── SECTION J: Volume exhaustion reversal ────────────────────────────────

  test('J1_GH+ADX20+VolSpike2.5x+RSI7>70+BB22', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    const vs = vol20[i] > 0 && volumes[i] > 2.5 * vol20[i];
    if (vs && rsi7[i] > 70 && cl > bb22Up[i]) return 'BEAR';
    if (vs && rsi7[i] < 30 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('J2_GH+ADX20+VolSpike2x+RSI7>73+MFI72+BB22', (c, i) => {
    if (i < 25 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    const vs = vol20[i] > 0 && volumes[i] > 2.0 * vol20[i];
    if (vs && rsi7[i] > 73 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (vs && rsi7[i] < 27 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  // ── SECTION K: ConnorsRSI expanded search ────────────────────────────────

  test('K1_GH+ADX20+CRSI>82+RSI7>68+BB22', (c, i) => {
    if (i < 105 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (crsi[i] > 82 && rsi7[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (crsi[i] < 18 && rsi7[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('K2_GH+ADX20+CRSI>85+MFI72+BB22', (c, i) => {
    if (i < 105 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 20) return null;
    const cl = closes[i];
    if (crsi[i] > 85 && mfi14[i] > 72 && cl > bb22Up[i]) return 'BEAR';
    if (crsi[i] < 15 && mfi14[i] < 28 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  test('K3_GH+ADX15+CRSI>82+RSI7>68+MFI68+BB22', (c, i) => {
    if (i < 105 || !gh.has(getHourUTC(c[i].t)) || adx14[i] >= 15) return null;
    const cl = closes[i];
    if (crsi[i] > 82 && rsi7[i] > 68 && mfi14[i] > 68 && cl > bb22Up[i]) return 'BEAR';
    if (crsi[i] < 18 && rsi7[i] < 32 && mfi14[i] < 32 && cl < bb22Lo[i]) return 'BULL';
    return null;
  });

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('\n' + '█'.repeat(65));
  console.log('  SESSION 14 HIGH-WR — ETH >75% + More High-Volume >75% Combos');
  console.log('█'.repeat(65));
  console.log('  New: H12-only ETH, ADX7 (fast), WPR, RSI5, MACD-hist, BB20, ADX10, triple-RSI chain');
  console.log('  Exit: next 5m candle close | Breakeven: 51.02% with 2% fee');

  const coins = ['ETH', 'BTC', 'SOL', 'XRP'];
  const allResults = {};
  for (const coin of coins) allResults[coin] = researchCoin(coin);

  // Summary
  console.log('\n' + '─'.repeat(65));
  console.log('  SESSION 14 SUMMARY — ranked by avg WR');
  console.log('─'.repeat(65));

  const strategies = Object.keys(allResults['ETH'] || {});
  const summary = [];
  for (const strat of strategies) {
    const rows = [];
    for (const coin of coins) {
      const r = allResults[coin]?.[strat];
      if (r && r.wr > 0.51 && r.tradesPerDay >= 0.01) rows.push({ coin, wr: r.wr, tpd: r.tradesPerDay, n: r.totalTrades });
    }
    if (rows.length === 0) continue;
    const avgWr = rows.reduce((a, b) => a + b.wr, 0) / rows.length;
    const totalTpd = rows.reduce((a, b) => a + b.tpd, 0);
    summary.push({ strat, avgWr, totalTpd, rows });
  }

  summary.sort((a, b) => b.avgWr - a.avgWr);
  console.log('\n  All strategies ranked by avg WR:');
  for (const s of summary.slice(0, 20)) {
    const f = s.avgWr > 0.80 ? ' 🔥🔥🔥🔥 >80%!' : s.avgWr > 0.75 ? ' 🔥🔥🔥 >75%!' : s.avgWr > 0.70 ? ' 🔥🔥 >70%!' : s.avgWr > 0.65 ? ' 🔥' : '';
    console.log(`  ${s.strat.padEnd(50)} avg=${(s.avgWr*100).toFixed(1)}%  tpd=${s.totalTpd.toFixed(2)}${f}`);
    for (const r of s.rows) console.log(`    ${r.coin}: ${(r.wr*100).toFixed(1)}% @ ${r.tpd.toFixed(2)}/day (n=${r.n})`);
  }

  // >75% per coin
  console.log('\n  BEST PER-COIN (top 3):');
  for (const coin of coins) {
    const coinRes = Object.entries(allResults[coin] || {})
      .filter(([, r]) => r.wr > 0.51 && r.totalTrades >= 5)
      .sort(([, a], [, b]) => b.wr - a.wr).slice(0, 3);
    if (!coinRes.length) continue;
    console.log(`  ${coin}:`);
    for (const [strat, r] of coinRes) {
      const f = r.wr > 0.80 ? '🔥🔥🔥🔥' : r.wr > 0.75 ? '🔥🔥🔥' : r.wr > 0.70 ? '🔥🔥' : r.wr > 0.65 ? '🔥' : '';
      console.log(`    ${(r.wr*100).toFixed(1)}% @ ${r.tradesPerDay.toFixed(2)}/d  → ${strat} ${f}`);
    }
  }

  // Highlight any new >75% with n≥15
  console.log('\n  ═══ NEW >75% WR STRATEGIES (n≥15): ═══');
  let found = false;
  for (const s of summary) {
    for (const r of s.rows) {
      if (r.wr >= 0.75 && r.n >= 15) {
        const known = ['BTC_93', 'BTC_94', 'BTC_95', 'BTC_96', 'XRP_93', 'XRP_94', 'SOL_95'].includes(`${r.coin}_${s.strat.slice(0, 2)}`);
        console.log(`  ${known ? '' : '★ '}🔥🔥🔥 ${r.coin} ${s.strat}: ${(r.wr*100).toFixed(1)}% WR @ ${r.tpd.toFixed(2)}/day (n=${r.n})`);
        found = true;
      }
    }
  }
  if (!found) console.log('  None found at >75% with n≥15. Best shown above.');

  db.close();
}

main();
