/**
 * Session 17: Double Oscillator Combos + 4h BB%B + Consecutive BB Extremes
 *
 * Building on Session 16 wins (strats 107-111):
 *   - Strat 111 (StochK>85+MFI72+RSI14+BB18): BTC=81.8% 🔥🔥🔥
 *   - Strat 108 (RSI3>95+MFI70+BB22): XRP=80.0% 🔥🔥🔥
 *
 * New hypotheses for Session 17:
 *   A. RSI3>90 + StochK>80 dual oscillator (combine both S16 winners)
 *   B. RSI3>93 + StochK>80 + MFI70 (triple oscillator confluence)
 *   C. 4h BB%B > 1.0 + GoodH + ADX<20 + BB22 (4h band overextension)
 *   D. 1h RSI14 > 72 + ADX<20 + GoodH + BB22 (1h overbought)
 *   E. Consecutive BB breaks: close above BB22 for 2 consecutive candles
 *   F. MFI > 75 + RSI3>90 + GoodH + ADX<20 + BB22 (higher MFI bar)
 *   G. RSI3>90 + StochK>75 + MFI70 + GoodH + ADX<20 + BB18 (relaxed for volume)
 *   H. RSI3>90 + RSI7>72 + StochK>75 + ADX<20 + GoodH + BB22
 *   I. BB Bandwidth narrowing: recent bandwidth < 50% of 20-bar avg = squeeze
 *   J. 4h RSI14 > 68 + GoodH + 5m ADX<20 + RSI7>73 + BB22
 *   K. RSI3>95 + StochK>85 + MFI72 (max confluence, very rare but potentially >85% WR)
 *   L. GoodH + ADX<20 + RSI3>90 + StochK>80 + MFI70 + BB22 (full stack)
 *
 * Exit model: CORRECT binary — compare close[i+1] vs close[i]
 * Target: WR≥70% with tpd≥0.3 OR WR≥80% (any tpd)
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

function buildTimeIndex(higherTfCandles) {
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
    const up = candles[i].high - candles[i - 1].high;
    const dn = candles[i - 1].low - candles[i].low;
    dmP[i] = up > dn && up > 0 ? up : 0;
    dmM[i] = dn > up && dn > 0 ? dn : 0;
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
    lower: sma.map((m, i) => m - mult * std[i]),
    bw: std.map((s, i) => isNaN(sma[i]) ? NaN : 2 * mult * s / sma[i]),  // bandwidth %
    pctB: closes.map((c, i) => {
      const range = mult * 2 * std[i];
      return range > 0 ? (c - (sma[i] - mult * std[i])) / range : 0.5;
    })
  };
}

// StochRSI K line (14-period RSI smoothed 14 bars)
function stochRsiKSeries(closes, rsiPeriod, stochPeriod) {
  const rsi = rsiSeries(closes, rsiPeriod);
  const k = new Array(closes.length).fill(50);
  for (let i = rsiPeriod + stochPeriod - 1; i < closes.length; i++) {
    const window = rsi.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...window), hi = Math.max(...window);
    k[i] = hi > lo ? ((rsi[i] - lo) / (hi - lo)) * 100 : 50;
  }
  return k;
}

// ─── Walk-Forward Backtester ──────────────────────────────────────────────────
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

// ─── Main Setup ───────────────────────────────────────────────────────────────
const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const GOOD_HOURS = {
  ETH: [10, 11, 12, 21],
  BTC: [1, 12, 13, 16, 20],
  SOL: [0, 12, 13, 20],
  XRP: [6, 9, 12, 18]
};

console.log('Loading candle data...');
const data = {};
for (const coin of COINS) {
  data[coin] = {
    '5m': loadCandles(coin, '5m'),
    '1h': loadCandles(coin, '1h'),
    '4h': loadCandles(coin, '4h'),
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
  const lines = [`\n=== ${name} ===`];
  for (const coin of COINS) {
    const r = coinResults[coin];
    if (!r) continue;
    const flag = r.wr >= 0.80 ? '🔥🔥🔥' : r.wr >= 0.75 ? '🔥🔥' : r.wr >= 0.70 ? '🔥' : r.wr >= 0.60 ? '✅' : '';
    lines.push(`  ${coin}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd.toFixed(2)} ${flag}`);
  }
  results.push({ name, lines, anyGood, coinResults });
}

// ─── GROUP A: RSI3 + StochK Double Oscillator ────────────────────────────────
// A1: GH + ADX<20 + RSI3>90 + StochK>80 + BB22
test('A1: GH+ADX<20+RSI3>90+StochK>80+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && stochK[i] > 80 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && stochK[i] < 20 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A2: GH + ADX<20 + RSI3>90 + StochK>80 + MFI70 + BB22
test('A2: GH+ADX<20+RSI3>90+StochK>80+MFI70+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A3: GH + ADX<20 + RSI3>90 + StochK>80 + MFI70 + BB18
test('A3: GH+ADX<20+RSI3>90+StochK>80+MFI70+BB18', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A4: GH + ADX<20 + RSI3>93 + StochK>80 + MFI70 + BB22 (RSI3>93 stricter)
test('A4: GH+ADX<20+RSI3>93+StochK>80+MFI70+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 93 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 7 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A5: RSI3>90 + StochK>75 + MFI70 + GH + ADX<20 + BB18 (relaxed StochK for volume)
test('A5: GH+ADX<20+RSI3>90+StochK>75+MFI70+BB18', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && stochK[i] > 75 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && stochK[i] < 25 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP B: RSI3>95 + StochK (max confluence) ──────────────────────────────
// K: RSI3>95 + StochK>85 + MFI72 + GH + ADX<20 + BB22 (max confluence)
test('B1: GH+ADX<20+RSI3>95+StochK>85+MFI70+BB22 (max)', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 95 && stochK[i] > 85 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 5 && stochK[i] < 15 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// B2: RSI3>95 + StochK>80 + MFI70 + BB18
test('B2: GH+ADX<20+RSI3>95+StochK>80+MFI70+BB18', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 95 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 5 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP C: 4h BB%B Extreme ─────────────────────────────────────────────────
// C1: 4h BB%B > 1.0 + GoodH + ADX<20 + BB22 + RSI7>70
test('C1: 4h BB%B>1.0+GH+ADX<20+BB22+RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const closes4h = c4h.map(c => c.close);
  const bb4h = bbSeries(closes4h, 20, 2.2);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 25 || isNaN(bb4h.upper[idx4h])) return null;
    const pctB4h = bb4h.pctB[idx4h];
    const bear = pctB4h > 1.0 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bull = pctB4h < 0.0 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// C2: 4h BB%B > 1.0 + GoodH + ADX<20 + BB22 + RSI3>90 + MFI70
test('C2: 4h BB%B>1.0+GH+ADX<20+BB22+RSI3>90+MFI70', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const closes4h = c4h.map(c => c.close);
  const bb4h = bbSeries(closes4h, 20, 2.2);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 25 || isNaN(bb4h.upper[idx4h])) return null;
    const pctB4h = bb4h.pctB[idx4h];
    const bear = pctB4h > 1.0 && rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = pctB4h < 0.0 && rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// C3: 4h BB%B > 0.9 (price near upper) + GoodH + ADX<20 + StochK>80 + BB22
test('C3: 4h BB%B>0.9+GH+ADX<20+StochK>80+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const closes4h = c4h.map(c => c.close);
  const bb4h = bbSeries(closes4h, 20, 2.2);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 25 || isNaN(bb4h.upper[idx4h])) return null;
    const pctB4h = bb4h.pctB[idx4h];
    const bear = pctB4h > 0.9 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = pctB4h < 0.1 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP D: 1h RSI14 Extreme ────────────────────────────────────────────────
// D1: 1h RSI14 > 72 + GoodH + ADX<20 + BB22 + RSI7>70
test('D1: 1h RSI14>72+GH+ADX<20+BB22+RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const rsi14_1h = rsiSeries(c1h.map(c => c.close), 14);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 20) return null;
    const bear = rsi14_1h[idx1h] > 72 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi14_1h[idx1h] < 28 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// D2: 1h RSI14 > 72 + GoodH + ADX<20 + BB22 + RSI3>90 + MFI70
test('D2: 1h RSI14>72+GH+ADX<20+BB22+RSI3>90+MFI70', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const rsi14_1h = rsiSeries(c1h.map(c => c.close), 14);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 20) return null;
    const bear = rsi14_1h[idx1h] > 72 && rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi14_1h[idx1h] < 28 && rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// D3: 1h RSI14 > 68 + ADX<20 + GoodH + StochK>80 + MFI72 + BB22
test('D3: 1h RSI14>68+GH+ADX<20+StochK>80+MFI72+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const rsi14_1h = rsiSeries(c1h.map(c => c.close), 14);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 20) return null;
    const bear = rsi14_1h[idx1h] > 68 && stochK[i] > 80 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bull = rsi14_1h[idx1h] < 32 && stochK[i] < 20 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP E: Consecutive BB Breaks ──────────────────────────────────────────
// E1: 2 consecutive candles above BB22 + RSI7>70 + GoodH + ADX<20
test('E1: 2 consec above BB22+GH+ADX<20+RSI7>70', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    if (i < 1) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || isNaN(bb.upper[i - 1]) || adx[i] >= 20) return null;
    const consec2Bear = candles[i].close > bb.upper[i] && candles[i - 1].close > bb.upper[i - 1];
    const consec2Bull = candles[i].close < bb.lower[i] && candles[i - 1].close < bb.lower[i - 1];
    if (consec2Bear && rsi7[i] > 70) return 'BEAR';
    if (consec2Bull && rsi7[i] < 30) return 'BULL';
    return null;
  });
});

// E2: 2 consecutive candles above BB22 + RSI3>90 + GoodH + ADX<20 + MFI68
test('E2: 2 consec above BB22+GH+ADX<20+RSI3>90+MFI68', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    if (i < 1) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || isNaN(bb.upper[i - 1]) || adx[i] >= 20) return null;
    const consec2Bear = candles[i].close > bb.upper[i] && candles[i - 1].close > bb.upper[i - 1];
    const consec2Bull = candles[i].close < bb.lower[i] && candles[i - 1].close < bb.lower[i - 1];
    if (consec2Bear && rsi3[i] > 90 && mfi[i] > 68) return 'BEAR';
    if (consec2Bull && rsi3[i] < 10 && mfi[i] < 32) return 'BULL';
    return null;
  });
});

// E3: 2 consecutive closes above BB18 + GoodH + ADX<20 + RSI3>85
test('E3: 2 consec above BB18+GH+ADX<20+RSI3>85', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    if (i < 1) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || isNaN(bb.upper[i - 1]) || adx[i] >= 20) return null;
    const consec2Bear = candles[i].close > bb.upper[i] && candles[i - 1].close > bb.upper[i - 1];
    const consec2Bull = candles[i].close < bb.lower[i] && candles[i - 1].close < bb.lower[i - 1];
    if (consec2Bear && rsi3[i] > 85) return 'BEAR';
    if (consec2Bull && rsi3[i] < 15) return 'BULL';
    return null;
  });
});

// ─── GROUP F: Higher MFI Threshold ───────────────────────────────────────────
// F1: MFI > 75 + RSI3>90 + GoodH + ADX<20 + BB22
test('F1: MFI>75+RSI3>90+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 75 && rsi3[i] > 90 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 25 && rsi3[i] < 10 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// F2: MFI > 75 + StochK>80 + GoodH + ADX<20 + BB22
test('F2: MFI>75+StochK>80+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 75 && stochK[i] > 80 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 25 && stochK[i] < 20 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// F3: MFI > 75 + RSI3>90 + StochK>75 + GoodH + ADX<20 + BB22
test('F3: MFI>75+RSI3>90+StochK>75+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 75 && rsi3[i] > 90 && stochK[i] > 75 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 25 && rsi3[i] < 10 && stochK[i] < 25 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP G: RSI7 + RSI3 + StochK Triple ────────────────────────────────────
// G1: RSI7>72 + RSI3>90 + StochK>75 + GoodH + ADX<20 + BB22
test('G1: RSI7>72+RSI3>90+StochK>75+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi7[i] > 72 && rsi3[i] > 90 && stochK[i] > 75 && candles[i].close > bb.upper[i];
    const bull = rsi7[i] < 28 && rsi3[i] < 10 && stochK[i] < 25 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// G2: RSI7>73 + StochK>80 + MFI72 + RSI14>68 + GH + ADX<20 + BB18
test('G2: RSI7>73+StochK>80+MFI72+RSI14>68+GH+ADX<20+BB18', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const rsi14 = rsiSeries(closes, 14);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi7[i] > 73 && stochK[i] > 80 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = rsi7[i] < 27 && stochK[i] < 20 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP H: 4h RSI14 Extreme ────────────────────────────────────────────────
// H1: 4h RSI14 > 68 + GoodH + ADX<20 + RSI7>73 + BB22
test('H1: 4h RSI14>68+GH+ADX<20+RSI7>73+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const rsi14_4h = rsiSeries(c4h.map(c => c.close), 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 20) return null;
    const bear = rsi14_4h[idx4h] > 68 && rsi7[i] > 73 && candles[i].close > bb.upper[i];
    const bull = rsi14_4h[idx4h] < 32 && rsi7[i] < 27 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// H2: 4h RSI14 > 65 + GoodH + ADX<20 + RSI3>90 + MFI70 + BB22
test('H2: 4h RSI14>65+GH+ADX<20+RSI3>90+MFI70+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const rsi14_4h = rsiSeries(c4h.map(c => c.close), 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 20) return null;
    const bear = rsi14_4h[idx4h] > 65 && rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi14_4h[idx4h] < 35 && rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP I: BB Bandwidth Squeeze ────────────────────────────────────────────
// I1: BB bandwidth < 60% of 20-bar avg + GoodH + ADX<20 + RSI3>90 + BB22
test('I1: BB Squeeze (bw<60% avg)+GH+ADX<20+RSI3>90+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const bwSma = smaSeries(bb.bw, 20);

  return backtest(c5, (candles, i) => {
    if (i < 25) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20 || isNaN(bwSma[i]) || bwSma[i] <= 0) return null;
    const bwRatio = bb.bw[i] / bwSma[i];
    if (bwRatio >= 0.6) return null; // require bandwidth below 60% of avg
    const bear = rsi3[i] > 90 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP J: Extended Good Hours ─────────────────────────────────────────────
// Test if slightly relaxed good hours with tighter indicators work
// J1: All-hours BUT ADX<15 (very tight ranging) + RSI3>93 + MFI70 + BB22
test('J1: ALL-H+ADX<15+RSI3>93+MFI70+BB22 (extra tight)', (coin) => {
  const c5 = data[coin]['5m'];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    if (isNaN(bb.upper[i]) || adx[i] >= 15) return null;
    const bear = rsi3[i] > 93 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 7 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// J2: ALL-H + ADX<15 + StochK>85 + MFI72 + RSI14>68 + BB22
test('J2: ALL-H+ADX<15+StochK>85+MFI72+RSI14>68+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const rsi14 = rsiSeries(closes, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    if (isNaN(bb.upper[i]) || adx[i] >= 15) return null;
    const bear = stochK[i] > 85 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 15 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── FINAL SUMMARY ────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('Session 17: Double Oscillator + 4h BB%B + Consecutive BB Breaks');
console.log('══════════════════════════════════════════════════════════════');
console.log('Exit model: close[i+1] vs close[i] (correct Polymarket binary)');
console.log('Target: WR≥70% with tpd≥0.3 OR WR≥80% (any tpd)\n');

let good = results.filter(r => r.anyGood).sort((a, b) => {
  const maxA = Math.max(...Object.values(a.coinResults).filter(r => r.n >= 10).map(r => r.wr), 0);
  const maxB = Math.max(...Object.values(b.coinResults).filter(r => r.n >= 10).map(r => r.wr), 0);
  return maxB - maxA;
});

if (good.length === 0) { console.log('No WR≥60% results. Showing all:'); good = results; }

for (const r of good) r.lines.forEach(l => console.log(l));

// Premium: WR≥70%
console.log('\n══════════ PREMIUM (WR≥70%, n≥10) ══════════');
for (const r of results) {
  const lines = r.lines.filter(l => {
    const m = l.match(/WR=(\d+\.\d+)%.*n=(\d+)/);
    return m && parseFloat(m[1]) >= 70 && parseInt(m[2]) >= 10;
  });
  if (lines.length) { console.log('\n' + r.name); lines.forEach(l => console.log(l)); }
}

// Ultra-premium: WR≥75%
console.log('\n══════════ ULTRA-PREMIUM (WR≥75%) ══════════');
for (const r of results) {
  const lines = r.lines.filter(l => {
    const m = l.match(/WR=(\d+\.\d+)%/);
    return m && parseFloat(m[1]) >= 75;
  });
  if (lines.length) { console.log('\n' + r.name); lines.forEach(l => console.log(l)); }
}
