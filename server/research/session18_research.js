/**
 * Session 18: VWAP Deviation + Wick Rejection + Ultra-Extreme Thresholds + 1h Confluence
 *
 * Building on Session 17 wins (strats 112-114):
 *   - Strat 112 (RSI7>73+StochK>80+MFI72+RSI14+BB18): BTC=75.6% 🔥🔥
 *   - Strat 111 (StochK>85+MFI72+RSI14+BB18): BTC=81.8% 🔥🔥🔥
 *
 * New unexplored hypotheses for Session 18:
 *   A. VWAP deviation: rolling VWAP(288=1 day) overshoot + BB22 + oscillator
 *   B. Wick rejection: long upper wick (≥2×body) at BB22 = seller absorption signal
 *   C. Ultra-extreme StochK>90 (tighter than 85) + MFI72 + RSI14 + BB18/BB22
 *   D. Ultra-extreme MFI>78 (higher than 72) + RSI3>90 + BB22
 *   E. ADX ultra-low (<15) filter — even more ranging = better mean reversion
 *   F. 1h RSI7>72 + ADX<20 + 5m RSI3>90 + MFI70 + BB22 (1h RSI confirms 5m extreme)
 *   G. 4h RSI14>70 + ADX<20 + StochK>80 + MFI70 + BB18 (4h confirms 5m extreme)
 *   H. Bullish candle body (close>open) outside BB22 = trend continuation at extreme = reversal?
 *   I. BB%B > 1.1 (very deep outside) + RSI7>70 + GoodH + ADX<20 (deeper = stronger signal)
 *   J. 4-streak + BB22 + RSI3>88 + MFI68 + ADX<20 (longer streak = exhaustion)
 *
 * Exit model: CORRECT binary — compare close[i+1] vs close[i]
 * Target: WR≥70% with n≥20 AND tpd≥0.2 OR WR≥75% (any tpd)
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
    if (d > 0) ag += d; else al -= d;
  }
  ag /= n; al /= n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function bbSeries(closes, n, mult) {
  const sma = smaSeries(closes, n);
  const std = stdSeries(closes, sma, n);
  return {
    upper: sma.map((m, i) => m + mult * std[i]),
    lower: sma.map((m, i) => m - mult * std[i]),
    mid: sma,
    pctB: closes.map((c, i) => {
      const range = 2 * mult * std[i];
      return range > 0 ? (c - (sma[i] - mult * std[i])) / range : 0.5;
    }),
  };
}

function mfiSeries(candles, n) {
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  const out = new Array(candles.length).fill(50);
  for (let i = n; i < candles.length; i++) {
    let pmf = 0, nmf = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const mf = tp[j] * candles[j].volume;
      if (tp[j] > tp[j - 1]) pmf += mf; else nmf += mf;
    }
    out[i] = nmf === 0 ? 100 : 100 - 100 / (1 + pmf / nmf);
  }
  return out;
}

function adxSeries(candles, n) {
  const out = new Array(candles.length).fill(25);
  const trArr = [], pdmArr = [], ndmArr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, ph = candles[i - 1].high, pl = candles[i - 1].low, pc = candles[i - 1].close;
    trArr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    pdmArr.push(Math.max(h - ph, 0) > Math.max(pl - l, 0) ? Math.max(h - ph, 0) : 0);
    ndmArr.push(Math.max(pl - l, 0) > Math.max(h - ph, 0) ? Math.max(pl - l, 0) : 0);
  }
  let atr = trArr.slice(0, n).reduce((a, b) => a + b, 0);
  let apdm = pdmArr.slice(0, n).reduce((a, b) => a + b, 0);
  let andm = ndmArr.slice(0, n).reduce((a, b) => a + b, 0);
  let adxVal = 0;
  const dxArr = [];
  for (let i = n; i < trArr.length; i++) {
    atr = atr - atr / n + trArr[i];
    apdm = apdm - apdm / n + pdmArr[i];
    andm = andm - andm / n + ndmArr[i];
    const pdi = atr > 0 ? 100 * apdm / atr : 0;
    const ndi = atr > 0 ? 100 * andm / atr : 0;
    const dx = (pdi + ndi) > 0 ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0;
    dxArr.push(dx);
    if (dxArr.length >= n) {
      if (dxArr.length === n) adxVal = dxArr.reduce((a, b) => a + b, 0) / n;
      else adxVal = (adxVal * (n - 1) + dx) / n;
      out[i + 1] = adxVal;
    }
  }
  return out;
}

function stochRsiKSeries(closes, rsiLen, stochLen) {
  const rsi = rsiSeries(closes, rsiLen);
  const k = new Array(closes.length).fill(50);
  for (let i = rsiLen + stochLen; i < closes.length; i++) {
    const window = rsi.slice(i - stochLen + 1, i + 1);
    const minR = Math.min(...window), maxR = Math.max(...window);
    k[i] = maxR > minR ? 100 * (rsi[i] - minR) / (maxR - minR) : 50;
  }
  return k;
}

// ─── VWAP Series (rolling N bars) ─────────────────────────────────────────────
function vwapSeries(candles, n) {
  const out = new Array(candles.length).fill(NaN);
  for (let i = n - 1; i < candles.length; i++) {
    let sumPV = 0, sumV = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      sumPV += tp * candles[j].volume;
      sumV += candles[j].volume;
    }
    out[i] = sumV > 0 ? sumPV / sumV : candles[i].close;
  }
  return out;
}

// ─── CCI Series ───────────────────────────────────────────────────────────────
function cciSeries(candles, n) {
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  const out = new Array(candles.length).fill(0);
  for (let i = n - 1; i < candles.length; i++) {
    const win = tp.slice(i - n + 1, i + 1);
    const avg = win.reduce((a, b) => a + b, 0) / n;
    const md = win.reduce((a, b) => a + Math.abs(b - avg), 0) / n;
    out[i] = md > 0 ? (tp[i] - avg) / (0.015 * md) : 0;
  }
  return out;
}

// ─── Backtest Engine ──────────────────────────────────────────────────────────
function backtest(candles, signalFn) {
  const n = candles.length;
  const foldSize = Math.floor(n / 5);
  const foldResults = [];
  for (let fold = 0; fold < 5; fold++) {
    const start = fold * foldSize;
    const end = fold === 4 ? n - 1 : (fold + 1) * foldSize;
    let wins = 0, total = 0;
    for (let i = start + 50; i < end - 1; i++) {
      const signal = signalFn(candles, i);
      if (!signal) continue;
      const entry = candles[i].close;
      const exit = candles[i + 1].close;
      const isWin = signal === 'BEAR' ? exit < entry : exit > entry;
      if (isWin) wins++;
      total++;
    }
    foldResults.push({ wins, total, wr: total > 0 ? wins / total : 0 });
  }
  const totalTrades = foldResults.reduce((s, f) => s + f.total, 0);
  const totalWins = foldResults.reduce((s, f) => s + f.wins, 0);
  const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
  const wrPct = foldResults.map(f => f.total > 0 ? f.wins / f.total * 100 : 50);
  const sigma = Math.sqrt(wrPct.reduce((s, w) => s + (w - wr * 100) ** 2, 0) / 5);
  return { wr, totalTrades, sigma, foldResults };
}

// ─── Coins & Good Hours ───────────────────────────────────────────────────────
const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const GOOD_HOURS = {
  ETH: [10, 11, 12, 21],
  BTC: [1, 12, 13, 16, 20],
  SOL: [0, 12, 13, 20],
  XRP: [6, 9, 12, 18],
};

// ─── Load All Data ─────────────────────────────────────────────────────────────
const data = {};
for (const coin of COINS) {
  data[coin] = {
    '5m': loadCandles(coin, '5m'),
    '1h': loadCandles(coin, '1h'),
    '4h': loadCandles(coin, '4h'),
  };
  console.log(`  ${coin} 5m=${data[coin]['5m'].length} 1h=${data[coin]['1h'].length} 4h=${data[coin]['4h'].length}`);
}
console.log('');

// ─── Test Runner ─────────────────────────────────────────────────────────────
const results = [];
function test(name, fn) {
  const coinResults = {};
  for (const coin of COINS) {
    try {
      const r = fn(coin);
      coinResults[coin] = r;
    } catch (e) {
      coinResults[coin] = { wr: 0, totalTrades: 0, sigma: 0, error: e.message };
    }
  }
  results.push({ name, coinResults });
  // Print immediately
  const parts = COINS.map(coin => {
    const r = coinResults[coin];
    if (!r || r.totalTrades < 10) return `${coin}=skip(n<10)`;
    const star = r.wr >= 0.75 ? ' 🔥🔥🔥' : r.wr >= 0.70 ? ' 🔥🔥' : r.wr >= 0.65 ? ' 🔥' : '';
    return `${coin}=${(r.wr * 100).toFixed(1)}% n=${r.totalTrades} σ=${r.sigma.toFixed(1)}%${star}`;
  });
  console.log(`[${name}]`);
  console.log(`  ${parts.join(' | ')}`);
  const tpdParts = COINS.map(coin => {
    const r = coinResults[coin];
    const tpd = r ? (r.totalTrades / 180).toFixed(1) : '0';
    return `${coin}=${tpd}/d`;
  });
  console.log(`  tpd: ${tpdParts.join(' | ')}`);
  console.log('');
}

// ─── GROUP A: VWAP Deviation ──────────────────────────────────────────────────
// A1: Rolling VWAP(288) dev > 0.10% + RSI7>70 + GoodH + ADX<20 + BB22
test('A1: VWAP288Dev>0.10%+RSI7>70+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const vwap = vwapSeries(c5, 288);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || isNaN(vwap[i]) || adx[i] >= 20) return null;
    const vwapDevPct = (candles[i].close - vwap[i]) / vwap[i] * 100;
    const bear = vwapDevPct > 0.10 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bull = vwapDevPct < -0.10 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A2: VWAP(288) dev > 0.15% + RSI3>90 + MFI70 + GoodH + ADX<20 + BB22
test('A2: VWAP288Dev>0.15%+RSI3>90+MFI70+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const vwap = vwapSeries(c5, 288);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || isNaN(vwap[i]) || adx[i] >= 20) return null;
    const vwapDevPct = (candles[i].close - vwap[i]) / vwap[i] * 100;
    const bear = vwapDevPct > 0.15 && rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = vwapDevPct < -0.15 && rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A3: VWAP(288) dev > 0.12% + StochK>80 + MFI70 + GoodH + ADX<20 + BB22
test('A3: VWAP288Dev>0.12%+StochK>80+MFI70+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const vwap = vwapSeries(c5, 288);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || isNaN(vwap[i]) || adx[i] >= 20) return null;
    const vwapDevPct = (candles[i].close - vwap[i]) / vwap[i] * 100;
    const bear = vwapDevPct > 0.12 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = vwapDevPct < -0.12 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP B: Wick Rejection Patterns ─────────────────────────────────────────
// B1: Upper wick ≥ 2× body + RSI3>85 + BB22 + GoodH + ADX<20
test('B1: UpperWick>=2xBody+RSI3>85+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const c = candles[i];
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    const bear = upperWick >= 2 * Math.max(body, 0.0001) && rsi3[i] > 85 && c.close > bb.upper[i];
    const bull = lowerWick >= 2 * Math.max(body, 0.0001) && rsi3[i] < 15 && c.close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// B2: Upper wick ≥ 1.5× body + RSI7>70 + MFI70 + BB22 + GoodH + ADX<20
test('B2: UpperWick>=1.5xBody+RSI7>70+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const c = candles[i];
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    const bear = upperWick >= 1.5 * Math.max(body, 0.0001) && rsi7[i] > 70 && mfi[i] > 70 && c.close > bb.upper[i];
    const bull = lowerWick >= 1.5 * Math.max(body, 0.0001) && rsi7[i] < 30 && mfi[i] < 30 && c.close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// B3: Upper wick ≥ body + close in lower half of candle range + RSI3>88 + BB22 + GH + ADX<20
test('B3: UpperWick>=Body+LowerHalf+RSI3>88+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const c = candles[i];
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    const closeInLowerHalf = range > 0 && (c.close - c.low) / range < 0.5;
    const closeInUpperHalf = range > 0 && (c.close - c.low) / range > 0.5;
    const bear = upperWick >= Math.max(body, 0.0001) && closeInLowerHalf && rsi3[i] > 88 && c.close > bb.upper[i];
    const bull = lowerWick >= Math.max(body, 0.0001) && closeInUpperHalf && rsi3[i] < 12 && c.close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP C: Ultra-Extreme StochK>90 ─────────────────────────────────────────
// C1: StochK>90 + MFI72 + RSI14>68 + BB22 + GoodH + ADX<20
test('C1: StochK>90+MFI72+RSI14>68+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 90 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 10 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// C2: StochK>90 + MFI72 + RSI14>68 + BB18 + GoodH + ADX<20 (tighter BB)
test('C2: StochK>90+MFI72+RSI14>68+BB18+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 90 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 10 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// C3: StochK>90 + RSI3>93 + MFI72 + BB22 + GoodH + ADX<20 (max triple)
test('C3: StochK>90+RSI3>93+MFI72+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 90 && rsi3[i] > 93 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 10 && rsi3[i] < 7 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP D: Ultra-Extreme MFI>78 ────────────────────────────────────────────
// D1: MFI>78 + RSI3>90 + BB22 + GoodH + ADX<20
test('D1: MFI>78+RSI3>90+BB22+GH+ADX<20', (coin) => {
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
    const bear = mfi[i] > 78 && rsi3[i] > 90 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 22 && rsi3[i] < 10 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// D2: MFI>78 + StochK>80 + RSI14>68 + BB22 + GoodH + ADX<20
test('D2: MFI>78+StochK>80+RSI14>68+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 78 && stochK[i] > 80 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 22 && stochK[i] < 20 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP E: ADX Ultra-Low (<15) ─────────────────────────────────────────────
// E1: ADX<15 + RSI3>93 + MFI70 + BB22 + GoodH (even tighter ranging filter)
test('E1: ADX<15+RSI3>93+MFI70+BB22+GH', (coin) => {
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
    if (isNaN(bb.upper[i]) || adx[i] >= 15) return null;
    const bear = rsi3[i] > 93 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 7 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// E2: ADX<15 + StochK>85 + MFI72 + RSI14>68 + BB22 + GoodH
test('E2: ADX<15+StochK>85+MFI72+RSI14>68+BB22+GH', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 15) return null;
    const bear = stochK[i] > 85 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 15 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// E3: ADX<15 + RSI7>73 + StochK>80 + MFI72 + RSI14>68 + BB18 + GoodH (strat 112 + ultra-low ADX)
test('E3: ADX<15+RSI7>73+StochK>80+MFI72+RSI14+BB18+GH (S17G2+ultraADX)', (coin) => {
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
    if (isNaN(bb.upper[i]) || adx[i] >= 15) return null;
    const bear = rsi7[i] > 73 && stochK[i] > 80 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = rsi7[i] < 27 && stochK[i] < 20 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP F: 1h Oscillator Confluence ────────────────────────────────────────
// F1: 1h RSI7>72 + ADX<20 + 5m RSI3>90 + MFI70 + BB22 + GoodH
test('F1: 1h RSI7>72+ADX<20+5m RSI3>90+MFI70+BB22+GH', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const rsi7_1h = rsiSeries(c1h.map(c => c.close), 7);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 20) return null;
    const bear = rsi7_1h[idx1h] > 72 && rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi7_1h[idx1h] < 28 && rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// F2: 1h RSI14>70 + ADX<20 + 5m StochK>80 + MFI72 + RSI14>68 + BB22 + GoodH
test('F2: 1h RSI14>70+ADX<20+5m StochK>80+MFI72+RSI14+BB22+GH', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi14 = rsiSeries(closes, 14);
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
    const bear = rsi14_1h[idx1h] > 70 && stochK[i] > 80 && mfi[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = rsi14_1h[idx1h] < 30 && stochK[i] < 20 && mfi[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// F3: 1h CCI>150 + ADX<20 + 5m RSI7>70 + MFI70 + BB22 + GoodH
test('F3: 1h CCI>150+ADX<20+5m RSI7>70+MFI70+BB22+GH', (coin) => {
  const c5 = data[coin]['5m'];
  const c1h = data[coin]['1h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const cci1h = cciSeries(c1h, 20);
  const get1h = buildTimeIndex(c1h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx1h = get1h(candles[i].t);
    if (idx1h < 20) return null;
    const bear = cci1h[idx1h] > 150 && rsi7[i] > 70 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = cci1h[idx1h] < -150 && rsi7[i] < 30 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP G: 4h RSI14 + 5m Extreme ──────────────────────────────────────────
// G1: 4h RSI14>70 + ADX<20 + StochK>80 + MFI70 + GoodH + BB22
test('G1: 4h RSI14>70+ADX<20+StochK>80+MFI70+GH+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
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
    const bear = rsi14_4h[idx4h] > 70 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi14_4h[idx4h] < 30 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// G2: 4h RSI14>68 + ADX<20 + StochK>80 + MFI72 + RSI7>70 + GoodH + BB18
test('G2: 4h RSI14>68+ADX<20+StochK>80+MFI72+RSI7>70+GH+BB18', (coin) => {
  const c5 = data[coin]['5m'];
  const c4h = data[coin]['4h'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);
  const rsi14_4h = rsiSeries(c4h.map(c => c.close), 14);
  const get4h = buildTimeIndex(c4h);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const idx4h = get4h(candles[i].t);
    if (idx4h < 20) return null;
    const bear = rsi14_4h[idx4h] > 68 && stochK[i] > 80 && mfi[i] > 72 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi14_4h[idx4h] < 32 && stochK[i] < 20 && mfi[i] < 28 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP H: BB%B Deep Extreme ───────────────────────────────────────────────
// H1: BB%B > 1.1 (very deep outside 22) + RSI7>70 + GoodH + ADX<20
test('H1: BB%B>1.1+RSI7>70+GH+ADX<20+BB22', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi7 = rsiSeries(closes, 7);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = bb.pctB[i] > 1.1 && rsi7[i] > 70 && candles[i].close > bb.upper[i];
    const bull = bb.pctB[i] < -0.1 && rsi7[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// H2: BB%B > 1.1 + RSI3>90 + MFI70 + GoodH + ADX<20
test('H2: BB%B>1.1+RSI3>90+MFI70+GH+ADX<20', (coin) => {
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
    const bear = bb.pctB[i] > 1.1 && rsi3[i] > 90 && mfi[i] > 70;
    const bull = bb.pctB[i] < -0.1 && rsi3[i] < 10 && mfi[i] < 30;
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP I: 4-Streak Reversal ───────────────────────────────────────────────
// I1: 4+ consecutive same-direction candles + BB22 + RSI3>88 + GoodH + ADX<20
test('I1: Streak>=4+BB22+RSI3>88+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    if (i < 4) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    // Count streak
    let streakUp = 0, streakDown = 0;
    for (let j = i; j >= Math.max(0, i - 7); j--) {
      if (candles[j].close > candles[j].open) { if (streakDown > 0) break; streakUp++; }
      else if (candles[j].close < candles[j].open) { if (streakUp > 0) break; streakDown++; }
      else break;
    }
    const bear = streakUp >= 4 && rsi3[i] > 88 && candles[i].close > bb.upper[i];
    const bull = streakDown >= 4 && rsi3[i] < 12 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// I2: 4+ streak + BB22 + StochK>80 + MFI70 + ADX<20 + GoodH
test('I2: Streak>=4+BB22+StochK>80+MFI70+ADX<20+GH', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);

  return backtest(c5, (candles, i) => {
    if (i < 4) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour)) return null;
    if (isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    let streakUp = 0, streakDown = 0;
    for (let j = i; j >= Math.max(0, i - 7); j--) {
      if (candles[j].close > candles[j].open) { if (streakDown > 0) break; streakUp++; }
      else if (candles[j].close < candles[j].open) { if (streakUp > 0) break; streakDown++; }
      else break;
    }
    const bear = streakUp >= 4 && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = streakDown >= 4 && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n════════════ SESSION 18 SUMMARY ════════════\n');

const TARGET_WR = 0.70;
const MIN_N = 20;

const winners = [];
for (const r of results) {
  for (const coin of COINS) {
    const cr = r.coinResults[coin];
    if (!cr || cr.totalTrades < MIN_N) continue;
    if (cr.wr >= TARGET_WR) {
      winners.push({ test: r.name, coin, wr: cr.wr, n: cr.totalTrades, sigma: cr.sigma, tpd: cr.totalTrades / 180 });
    }
  }
}

if (winners.length === 0) {
  console.log('No winners at WR≥70% with n≥20');
} else {
  winners.sort((a, b) => b.wr - a.wr);
  console.log(`Found ${winners.length} winners at WR≥70% n≥20:`);
  for (const w of winners) {
    const star = w.wr >= 0.80 ? '🔥🔥🔥' : w.wr >= 0.75 ? '🔥🔥' : '🔥';
    console.log(`  ${star} [${w.test}] ${w.coin}: ${(w.wr * 100).toFixed(1)}% n=${w.n} σ=${w.sigma.toFixed(1)}% tpd=${w.tpd.toFixed(1)}`);
  }
}

console.log('\nDone.');
