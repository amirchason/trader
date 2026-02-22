/**
 * Session 16: Multi-Timeframe Regime + VWAP + 4h Filter Research
 *
 * New territory vs sessions 1-15:
 *   A. 4h ADX regime filter + GoodH + BB22 + RSI extremes (4h data NEVER used before)
 *   B. 30m BB%B extreme + 5m BB22 (30m data NEVER used before)
 *   C. VWAP deviation + BB22 + RSI7 (VWAP-anchor never tested)
 *   D. Ultra-extreme RSI3 (>95) + BB22 + ADX<20 (hyper-rare but potentially >85% WR)
 *   E. 4h BB%B > 0.9 + GoodH + ADX<20 + BB22 (double TF band extremes)
 *   F. 30m RSI14 extreme + GoodH + ADX<20 + 5m BB22
 *   G. 1h BB%B > 1.0 + GoodH + ADX<20 + BB22 + RSI7 (1h-anchored extreme)
 *   H. 4h RSI14 in [40,60] ranging + GoodH + ADX<20 + RSI3>90 + BB22
 *   I. BB(20,1.5) ultra-tight + GoodH + RSI7>70 + MFI (even more signals than BB1.0)
 *   J. 30m+1h double confirmation: both 30m and 1h BB%B > 0.9 + 5m BB22
 *
 * Exit model: CORRECT binary — compare close[i+1] vs close[i]
 * Breakeven WR ≈ 51.5% (Polymarket ~2% fee + spread)
 * Target: >65% WR with 3+ trades/day per coin
 */

'use strict';
const path = require('path');
const Database = require('better-sqlite3');

// ─── Load Candles ─────────────────────────────────────────────────────────────
function loadCandles(symbol, tf) {
  const dbPath = path.join(__dirname, '../../trader.db');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT open_time as t, open, high, low, close, volume
     FROM candles WHERE symbol=? AND timeframe=?
     ORDER BY open_time ASC`
  ).all(symbol, tf);
  db.close();
  return rows.map(r => ({
    t: +r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume
  }));
}

// ─── Build Index: TF candle at time t → find closest prior candle ─────────────
function buildTimeIndex(higherTfCandles) {
  // Returns function: getAtTime(t) → index in higherTfCandles or -1
  return function getAtTime(t) {
    let lo = 0, hi = higherTfCandles.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (higherTfCandles[mid].t <= t) { res = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return res;
  };
}

// ─── Indicator Series ─────────────────────────────────────────────────────────
function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += arr[j];
    out[i] = s / n;
  }
  return out;
}

function stdSeries(arr, sma, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (arr[j] - sma[i]) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}

function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al += -d;
  }
  ag /= n; al /= n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(0, d)) / n;
    al = (al * (n - 1) + Math.max(0, -d)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function mfiSeries(candles, n) {
  const out = new Array(candles.length).fill(50);
  for (let i = n; i < candles.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const tpPrev = (candles[j - 1].high + candles[j - 1].low + candles[j - 1].close) / 3;
      const flow = tp * candles[j].volume;
      if (tp > tpPrev) posFlow += flow; else negFlow += flow;
    }
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return out;
}

function adxSeries(candles, n) {
  const len = candles.length;
  const out = new Array(len).fill(25);
  const trArr = new Array(len).fill(0);
  const dmP = new Array(len).fill(0);
  const dmM = new Array(len).fill(0);
  for (let i = 1; i < len; i++) {
    trArr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    dmP[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    dmM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  let atr = trArr.slice(1, n + 1).reduce((a, b) => a + b, 0);
  let sP = dmP.slice(1, n + 1).reduce((a, b) => a + b, 0);
  let sM = dmM.slice(1, n + 1).reduce((a, b) => a + b, 0);
  const dxArr = new Array(len).fill(0);
  for (let i = n; i < len; i++) {
    if (i > n) {
      atr = atr - atr / n + trArr[i];
      sP = sP - sP / n + dmP[i];
      sM = sM - sM / n + dmM[i];
    }
    const diP = atr > 0 ? 100 * sP / atr : 0;
    const diM = atr > 0 ? 100 * sM / atr : 0;
    const sum = diP + diM;
    dxArr[i] = sum > 0 ? 100 * Math.abs(diP - diM) / sum : 0;
  }
  let adxAccum = dxArr.slice(n, 2 * n).reduce((a, b) => a + b, 0) / n;
  out[2 * n - 1] = adxAccum;
  for (let i = 2 * n; i < len; i++) {
    adxAccum = (adxAccum * (n - 1) + dxArr[i]) / n;
    out[i] = adxAccum;
  }
  return out;
}

function bbSeries(closes, n, mult) {
  const sma = smaSeries(closes, n);
  const std = stdSeries(closes, sma, n);
  return {
    upper: sma.map((m, i) => m + mult * std[i]),
    mid: sma,
    lower: sma.map((m, i) => m - mult * std[i]),
    pctB: closes.map((c, i) => {
      const range = mult * 2 * std[i];
      return range > 0 ? (c - (sma[i] - mult * std[i])) / range : 0.5;
    })
  };
}

function atrSeries(candles, n) {
  const out = new Array(candles.length).fill(0);
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high - c.low,
      Math.abs(c.high - candles[i - 1].close),
      Math.abs(c.low - candles[i - 1].close));
  });
  let atr = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  out[n] = atr;
  for (let i = n + 1; i < candles.length; i++) {
    atr = (atr * (n - 1) + tr[i]) / n;
    out[i] = atr;
  }
  return out;
}

// VWAP: cumulative TP*Vol / cumulative Vol, reset each UTC day
function vwapSeries(candles) {
  const out = new Array(candles.length).fill(NaN);
  let cumTPV = 0, cumVol = 0;
  let lastDay = -1;
  for (let i = 0; i < candles.length; i++) {
    const day = Math.floor(candles[i].t / 86400000);
    if (day !== lastDay) { cumTPV = 0; cumVol = 0; lastDay = day; }
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cumTPV += tp * candles[i].volume;
    cumVol += candles[i].volume;
    out[i] = cumVol > 0 ? cumTPV / cumVol : candles[i].close;
  }
  return out;
}

// ─── Walk-Forward Validation (5 folds) ────────────────────────────────────────
function wfv(candles, stratFn) {
  const n = candles.length;
  const foldSize = Math.floor(n / 5);
  const wrs = [];
  for (let fold = 0; fold < 5; fold++) {
    const start = fold * foldSize;
    const end = fold === 4 ? n - 1 : (fold + 1) * foldSize;
    const foldCandles = candles.slice(start, end);
    let wins = 0, total = 0;
    for (let i = 50; i < foldCandles.length - 1; i++) {
      const signal = stratFn(foldCandles, i);
      if (!signal) continue;
      const entry = foldCandles[i].close;
      const exit = foldCandles[i + 1].close;
      const win = signal === 'BEAR' ? exit < entry : exit > entry;
      if (win) wins++;
      total++;
    }
    if (total >= 5) wrs.push({ wr: wins / total, n: total });
  }
  return wrs;
}

// ─── Backtester: all folds combined for tpd/WR ───────────────────────────────
function backtest(candles, stratFn) {
  let wins = 0, total = 0;
  for (let i = 50; i < candles.length - 1; i++) {
    const signal = stratFn(candles, i);
    if (!signal) continue;
    const entry = candles[i].close;
    const exit = candles[i + 1].close;
    const win = signal === 'BEAR' ? exit < entry : exit > entry;
    if (win) wins++;
    total++;
  }
  const days = (candles[candles.length - 1].t - candles[0].t) / 86400000;
  return { wr: total > 0 ? wins / total : 0, n: total, tpd: total / days };
}

// ─── Main Test Runner ─────────────────────────────────────────────────────────
const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const GOOD_HOURS = {
  ETH: [10, 11, 12, 21],
  BTC: [1, 12, 13, 16, 20],
  SOL: [0, 12, 13, 20],
  XRP: [6, 9, 12, 18]
};

// Pre-load all candle data
console.log('Loading candle data...');
const data = {};
for (const coin of COINS) {
  data[coin] = {
    '5m': loadCandles(coin, '5m'),
    '1h': loadCandles(coin, '1h'),
    '4h': loadCandles(coin, '4h'),
    '30m': loadCandles(coin, '30m'),
    '15m': loadCandles(coin, '15m'),
  };
}
console.log('Data loaded. Running tests...\n');

const results = [];

function test(name, fn) {
  const coinResults = {};
  let anyGood = false;
  for (const coin of COINS) {
    const r = fn(coin);
    coinResults[coin] = r;
    if (r.n >= 10 && r.wr >= 0.60) anyGood = true;
  }

  // Always show if any coin has WR ≥ 60%
  const lines = [`\n=== ${name} ===`];
  for (const coin of COINS) {
    const r = coinResults[coin];
    if (!r) continue;
    const flag = r.wr >= 0.75 ? '🔥🔥🔥' : r.wr >= 0.70 ? '🔥🔥' : r.wr >= 0.65 ? '🔥' : r.wr >= 0.60 ? '✅' : '';
    lines.push(`  ${coin}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd.toFixed(1)} ${flag}`);
  }
  results.push({ name, lines, anyGood, coinResults });
}

// ─── GROUP A: 4h Regime Filters ──────────────────────────────────────────────
// A1: 4h ADX<25 + GoodH + RSI3>90 + MFI70 + BB22
test('A1: 4h ADX<25 + GH + RSI3>90 + MFI70 + BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx4h = adxSeries(c4h, 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 30 || adx4h[idx4h] >= 25) return null;
    if (isNaN(bb.upper[i]) || isNaN(rsi3[i]) || isNaN(mfi[i])) return null;
    const bearSignal = rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// A2: 4h ADX<20 + GoodH + RSI3>90 + MFI70 + BB22 (stricter)
test('A2: 4h ADX<20 + GH + RSI3>90 + MFI70 + BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx4h = adxSeries(c4h, 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 30 || adx4h[idx4h] >= 20) return null;
    if (isNaN(bb.upper[i]) || isNaN(rsi3[i]) || isNaN(mfi[i])) return null;
    const bearSignal = rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// A3: 4h RSI14 in [38,62] (ranging 4h) + GoodH + 5m ADX<20 + BB22 + RSI7>73
test('A3: 4h RSI[38-62] + GH + 5m ADX<20 + BB22 + RSI7>73', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes4h = c4h.map(c => c.close);
  const rsi14_4h = rsiSeries(closes4h, 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 20 || rsi14_4h[idx4h] < 38 || rsi14_4h[idx4h] > 62) return null;
    const bearSignal = rsi7[i] > 73 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 27 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// A4: 4h BB%B > 0.9 + GoodH + 5m ADX<20 + BB22 + RSI7>70
test('A4: 4h BB%B>0.9 + GH + 5m ADX<20 + BB22 + RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes4h = c4h.map(c => c.close);
  const bb4h = bbSeries(closes4h, 20, 2.2);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 25) return null;
    const pctB4h = bb4h.pctB[idx4h];
    const bearSignal = pctB4h > 0.9 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = pctB4h < 0.1 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// A5: 4h ADX<20 + GoodH + RSI7>73 + MFI72 + BB(20,1.8)
test('A5: 4h ADX<20 + GH + RSI7>73 + MFI72 + BB(20,1.8)', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx4h = adxSeries(c4h, 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 30 || adx4h[idx4h] >= 20) return null;
    if (isNaN(bb.upper[i]) || isNaN(rsi7[i]) || isNaN(mfi[i])) return null;
    const bearSignal = rsi7[i] > 73 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 27 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP B: 30m Multi-TF ────────────────────────────────────────────────────
// B1: 30m BB%B > 1.0 + GoodH + 5m ADX<20 + BB22
test('B1: 30m BB%B>1.0 + GH + 5m ADX<20 + BB22 + RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const c30 = data[coin]['30m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes30 = c30.map(c => c.close);
  const bb30 = bbSeries(closes30, 20, 2.2);
  const get30 = buildTimeIndex(c30);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx30 = get30(candles[i].t);
    if (idx30 < 25) return null;
    const pctB30 = bb30.pctB[idx30];
    const bearSignal = pctB30 > 1.0 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = pctB30 < 0.0 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// B2: 30m RSI14 > 72 + GoodH + 5m ADX<20 + BB22 + RSI3>90
test('B2: 30m RSI14>72 + GH + 5m ADX<20 + BB22 + RSI3>90', (coin) => {
  const c5 = data[coin]['5m'];
  const c30 = data[coin]['30m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes30 = c30.map(c => c.close);
  const rsi14_30 = rsiSeries(closes30, 14);
  const get30 = buildTimeIndex(c30);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx30 = get30(candles[i].t);
    if (idx30 < 20) return null;
    const rsi14_30_val = rsi14_30[idx30];
    const bearSignal = rsi14_30_val > 72 && rsi3[i] > 90 && candles[i].close > bb.upper[i];
    const bullSignal = rsi14_30_val < 28 && rsi3[i] < 10 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// B3: 30m RSI14 > 72 + GoodH + 5m ADX<20 + BB22 + RSI7>73
test('B3: 30m RSI14>72 + GH + 5m ADX<20 + BB22 + RSI7>73', (coin) => {
  const c5 = data[coin]['5m'];
  const c30 = data[coin]['30m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes30 = c30.map(c => c.close);
  const rsi14_30 = rsiSeries(closes30, 14);
  const get30 = buildTimeIndex(c30);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx30 = get30(candles[i].t);
    if (idx30 < 20) return null;
    const bearSignal = rsi14_30[idx30] > 72 && rsi7[i] > 73 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi14_30[idx30] < 28 && rsi7[i] < 27 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// B4: 30m+1h double overbought + 5m ADX<20 + BB22
test('B4: 30m RSI>70 + 1h RSI>70 + GH + 5m ADX<20 + BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c30 = data[coin]['30m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const rsi14_30 = rsiSeries(c30.map(c => c.close), 14);
  const rsi14_1h = rsiSeries(c1h.map(c => c.close), 14);
  const get30 = buildTimeIndex(c30);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx30 = get30(candles[i].t);
    const idx1h = get1h(candles[i].t);
    if (idx30 < 20 || idx1h < 20) return null;
    const bearSignal = rsi14_30[idx30] > 70 && rsi14_1h[idx1h] > 70 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi14_30[idx30] < 30 && rsi14_1h[idx1h] < 30 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP C: VWAP Deviation ─────────────────────────────────────────────────
// C1: Price > VWAP + 0.5% + GoodH + ADX<20 + BB22 + RSI7>70
test('C1: VWAP dev>0.5% + GH + ADX<20 + BB22 + RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const vwap = vwapSeries(c5);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20 || isNaN(vwap[i])) return null;
    const vwapDev = (candles[i].close - vwap[i]) / vwap[i] * 100;
    const bearSignal = vwapDev > 0.5 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = vwapDev < -0.5 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// C2: VWAP dev > 0.3% + GoodH + ADX<20 + BB22 + RSI3>90
test('C2: VWAP dev>0.3% + GH + ADX<20 + BB22 + RSI3>90', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const vwap = vwapSeries(c5);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20 || isNaN(vwap[i])) return null;
    const vwapDev = (candles[i].close - vwap[i]) / vwap[i] * 100;
    const bearSignal = vwapDev > 0.3 && rsi3[i] > 90 && mfi[i] > 68 && candles[i].close > bb.upper[i];
    const bullSignal = vwapDev < -0.3 && rsi3[i] < 10 && mfi[i] < 32 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// C3: VWAP dev > 0.4% + GH + ADX<20 + BB(20,1.8) + RSI7>73 + MFI72
test('C3: VWAP dev>0.4% + GH + ADX<20 + BB18 + RSI7>73 + MFI72', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx5 = adxSeries(c5, 14);
  const vwap = vwapSeries(c5);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20 || isNaN(vwap[i])) return null;
    const vwapDev = (candles[i].close - vwap[i]) / vwap[i] * 100;
    const bearSignal = vwapDev > 0.4 && rsi7[i] > 73 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bullSignal = vwapDev < -0.4 && rsi7[i] < 27 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP D: Ultra-Extreme RSI3 ─────────────────────────────────────────────
// D1: RSI3>95 + GoodH + ADX<20 + BB22
test('D1: RSI3>95 + GH + ADX<20 + BB22 (ultra-extreme)', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const bearSignal = rsi3[i] > 95 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 5 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// D2: RSI3>95 + MFI>70 + GoodH + ADX<20 + BB22
test('D2: RSI3>95 + MFI>70 + GH + ADX<20 + BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const bearSignal = rsi3[i] > 95 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 5 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// D3: RSI3>95 + MFI>70 + GH + ADX<20 + BB18
test('D3: RSI3>95 + MFI>70 + GH + ADX<20 + BB18 (more signals)', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx5 = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const bearSignal = rsi3[i] > 95 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 5 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP E: 1h BB%B Extreme ─────────────────────────────────────────────────
// E1: 1h BB%B > 1.0 + GoodH + 5m ADX<20 + BB22 + RSI7>70
test('E1: 1h BB%B>1.0 + GH + 5m ADX<20 + BB22 + RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes1h = c1h.map(c => c.close);
  const bb1h = bbSeries(closes1h, 20, 2.2);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 25) return null;
    const pctB1h = bb1h.pctB[idx1h];
    const bearSignal = pctB1h > 1.0 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = pctB1h < 0.0 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// E2: 1h BB%B > 1.0 + GoodH + 5m ADX<20 + BB22 + RSI3>90
test('E2: 1h BB%B>1.0 + GH + 5m ADX<20 + BB22 + RSI3>90', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes1h = c1h.map(c => c.close);
  const bb1h = bbSeries(closes1h, 20, 2.2);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 25) return null;
    const pctB1h = bb1h.pctB[idx1h];
    const bearSignal = pctB1h > 1.0 && rsi3[i] > 90 && mfi[i] > 68 && candles[i].close > bb.upper[i];
    const bullSignal = pctB1h < 0.0 && rsi3[i] < 10 && mfi[i] < 32 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// E3: 1h BB%B > 1.0 + GoodH + 5m ADX<20 + BB22 + RSI7>73 + MFI72
test('E3: 1h BB%B>1.0 + GH + 5m ADX<20 + BB22 + RSI7>73 + MFI72', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const closes1h = c1h.map(c => c.close);
  const bb1h = bbSeries(closes1h, 20, 2.2);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 25) return null;
    const pctB1h = bb1h.pctB[idx1h];
    const bearSignal = pctB1h > 1.0 && rsi7[i] > 73 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bullSignal = pctB1h < 0.0 && rsi7[i] < 27 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP F: BB(20,1.5) Ultra-tight band ────────────────────────────────────
// F1: GoodH + ADX<20 + RSI7>73 + MFI72 + BB(20,1.5)
test('F1: GH + ADX<20 + RSI7>73 + MFI72 + BB(20,1.5)', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.5);
  const adx5 = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const bearSignal = rsi7[i] > 73 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 27 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// F2: GoodH + ADX<20 + RSI3>90 + MFI70 + BB(20,1.5)
test('F2: GH + ADX<20 + RSI3>90 + MFI70 + BB(20,1.5)', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.5);
  const adx5 = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const bearSignal = rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP G: ATR Climax with 4h context ─────────────────────────────────────
// G1: Big candle (≥1.5×ATR) + 4h ADX<20 + GoodH + BB22
test('G1: 1.5×ATR Climax + 4h ADX<20 + GH + BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const bb = bbSeries(closes, 20, 2.2);
  const rsi7 = rsiSeries(closes, 7);
  const atr = atrSeries(c5, 14);
  const adx4h = adxSeries(c4h, 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || atr[i] <= 0) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 30 || adx4h[idx4h] >= 20) return null;
    const candleSize = Math.abs(candles[i].close - candles[i].open);
    const bigCandle = candleSize >= 1.5 * atr[i];
    if (!bigCandle) return null;
    const bearSignal = rsi7[i] > 68 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 32 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP H: XRP Strat 106 (BTC-specific pattern applied to XRP) ─────────────
// H1: GH + ADX<20 + RSI7>73 + MFI72 + RSI14>68 + BB(20,1.0) — XRP specific
test('H1: GH + ADX<20 + RSI7>73 + MFI72 + RSI14>68 + BB10 (XRP pattern)', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.0);
  const adx5 = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const bearSignal = rsi7[i] > 73 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 27 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// H2: GH + 4h ADX<20 + RSI7>73 + MFI72 + RSI14>68 + BB22 (4h ADX filter)
test('H2: GH + 4h ADX<20 + RSI7>73 + MFI72 + RSI14>68 + BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx4h = adxSeries(c4h, 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i])) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 30 || adx4h[idx4h] >= 20) return null;
    const bearSignal = rsi7[i] > 73 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 27 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// H3: GH + 4h ADX<20 + RSI3>90 + MFI70 + BB22 (replace 5m ADX with 4h)
test('H3: GH + 4h ADX<20 + RSI3>93 + MFI70 + BB22 (4h not 5m ADX)', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx4h = adxSeries(c4h, 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i])) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 30 || adx4h[idx4h] >= 20) return null;
    const bearSignal = rsi3[i] > 93 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 7 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP I: Stacked Multi-TF (4h + 1h + 5m all ranging) ───────────────────
// I1: 4h ADX<20 + 1h ADX<20 + GoodH + BB22 + RSI7>73 + MFI72
test('I1: 4h ADX<20 + 1h ADX<20 + GH + BB22 + RSI7>73 + MFI72', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx1h = adxSeries(c1h, 14);
  const adx4h = adxSeries(c4h, 14);
  const get1h = buildTimeIndex(c1h);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i])) return null;
    const idx1h = get1h(candles[i].t);
    const idx4h = get4h(candles[i].t);
    if (idx1h < 20 || idx4h < 20) return null;
    if (adx1h[idx1h] >= 20 || adx4h[idx4h] >= 25) return null;
    const bearSignal = rsi7[i] > 73 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 27 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// I2: 4h ADX<25 + 1h ADX<20 + GH + RSI3>90 + MFI70 + BB18
test('I2: 4h ADX<25 + 1h ADX<20 + GH + RSI3>90 + MFI70 + BB18', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx1h = adxSeries(c1h, 14);
  const adx4h = adxSeries(c4h, 14);
  const get1h = buildTimeIndex(c1h);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i])) return null;
    const idx1h = get1h(candles[i].t);
    const idx4h = get4h(candles[i].t);
    if (idx1h < 20 || idx4h < 20) return null;
    if (adx1h[idx1h] >= 20 || adx4h[idx4h] >= 25) return null;
    const bearSignal = rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── GROUP J: 30m Volume + 5m BB22 ────────────────────────────────────────────
// J1: 30m volume spike + GoodH + 5m ADX<20 + BB22 + RSI7>70
test('J1: 30m Vol Spike>1.8x + GH + 5m ADX<20 + BB22 + RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const c30 = data[coin]['30m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx5 = adxSeries(c5, 14);
  const vols30 = c30.map(c => c.volume);
  const get30 = buildTimeIndex(c30);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx5[i] >= 20) return null;
    const idx30 = get30(candles[i].t);
    if (idx30 < 22) return null;
    const avgVol = vols30.slice(idx30 - 20, idx30).reduce((a, b) => a + b, 0) / 20;
    const volSpike = avgVol > 0 ? vols30[idx30] / avgVol : 0;
    if (volSpike < 1.8) return null;
    const bearSignal = rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bullSignal = rsi7[i] < 30 && candles[i].close < bb.lower[i];
    if (bearSignal) return 'BEAR';
    if (bullSignal) return 'BULL';
    return null;
  });
});

// ─── FINAL SUMMARY ────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('Session 16: Multi-TF Regime + VWAP + 4h Filter Results');
console.log('══════════════════════════════════════════════════════════════');
console.log('Exit model: close[i+1] vs close[i] (correct Polymarket binary)');
console.log('Target: WR≥65% with tpd≥1.0 | Target Ultra: WR≥75% tpd≥0.5\n');

let bestResults = results.filter(r => r.anyGood).sort((a, b) => {
  const maxA = Math.max(...Object.values(a.coinResults).filter(r => r.n >= 10).map(r => r.wr));
  const maxB = Math.max(...Object.values(b.coinResults).filter(r => r.n >= 10).map(r => r.wr));
  return maxB - maxA;
});

if (bestResults.length === 0) {
  console.log('No strategies with WR≥60% and n≥10 found. Showing all:\n');
  bestResults = results;
}

for (const r of bestResults) {
  r.lines.forEach(l => console.log(l));
}

// Premium summary: WR≥70% all coins
console.log('\n\n══════════════════════ PREMIUM SUMMARY (WR≥70%) ══════════════');
for (const r of results) {
  const premiumLines = r.lines.filter(l => {
    const match = l.match(/WR=(\d+\.\d+)%/);
    return match && parseFloat(match[1]) >= 70.0;
  });
  if (premiumLines.length > 0) {
    console.log(`\n${r.name}`);
    premiumLines.forEach(l => console.log(l));
  }
}

// Volume summary: WR≥60% AND tpd≥2.0
console.log('\n\n══════════════════════ VOLUME SUMMARY (WR≥60%, tpd≥2/day) ═══');
for (const r of results) {
  const volLines = r.lines.filter(l => {
    const wrMatch = l.match(/WR=(\d+\.\d+)%/);
    const tpdMatch = l.match(/tpd=(\d+\.\d+)/);
    return wrMatch && tpdMatch && parseFloat(wrMatch[1]) >= 60.0 && parseFloat(tpdMatch[1]) >= 2.0;
  });
  if (volLines.length > 0) {
    console.log(`\n${r.name}`);
    volLines.forEach(l => console.log(l));
  }
}
