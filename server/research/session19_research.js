/**
 * Session 19: Near-Miss Relaxation + Triple RSI + RSI5 + Stochastic + Candle Size
 *
 * Building on Session 18 near-misses:
 *   - D2 (MFI>78+StochK>80+RSI14+BB22): BTC=84.2% n=19 — JUST under n≥20 cutoff
 *   - VWAP(288)Dev>0.15%+RSI3>90: BTC=72.1% n=43 (good but needs infra)
 *
 * New hypotheses for Session 19:
 *   A. D2 relaxation: MFI>75/76 variants to push n over 20 while keeping high WR
 *   B. RSI5 sweet spot: 5-period RSI (between RSI3 and RSI7)
 *   C. Triple RSI alignment: RSI3>90 + RSI7>72 + RSI14>68 simultaneously (3 TF)
 *   D. Stochastic oscillator (not StochRSI): Stoch(14,3) K>80 at BB extreme
 *   E. Big candle filter: candle height > 1.5×ATR14 at BB extreme = momentum exhaustion
 *   F. Double StochK: Two consecutive StochK>80 candles = sustained momentum extreme
 *   G. RSI3>90 + RSI14>68 + MFI72 + BB18 (higher-freq variant of triple confirm)
 *   H. SOL-specific: GoodH + ADX<20 + StochK>90 + MFI70 + BB22
 *
 * Exit model: CORRECT binary — compare close[i+1] vs close[i]
 * Target: WR≥70% with n≥20 AND tpd≥0.1
 */

'use strict';
const path = require('path');
const Database = require('better-sqlite3');

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

// ─── Classic Stochastic Oscillator %K ─────────────────────────────────────────
function stochKSeries(candles, n, smooth) {
  const rawK = new Array(candles.length).fill(50);
  for (let i = n - 1; i < candles.length; i++) {
    const highs = candles.slice(i - n + 1, i + 1).map(c => c.high);
    const lows = candles.slice(i - n + 1, i + 1).map(c => c.low);
    const hh = Math.max(...highs), ll = Math.min(...lows);
    rawK[i] = hh > ll ? 100 * (candles[i].close - ll) / (hh - ll) : 50;
  }
  // Smooth %K (3-period SMA)
  return smaSeries(rawK, smooth);
}

// ─── ATR Series ───────────────────────────────────────────────────────────────
function atrSeries(candles, n) {
  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const pc = candles[i - 1].close;
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - pc), Math.abs(candles[i].low - pc));
  }
  const out = new Array(candles.length).fill(NaN);
  let atr = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  out[n] = atr;
  for (let i = n + 1; i < candles.length; i++) {
    atr = (atr * (n - 1) + tr[i]) / n;
    out[i] = atr;
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
      const isWin = signal === 'BEAR' ? candles[i + 1].close < candles[i].close : candles[i + 1].close > candles[i].close;
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

const data = {};
for (const coin of COINS) {
  data[coin] = { '5m': loadCandles(coin, '5m') };
  console.log(`  ${coin} 5m=${data[coin]['5m'].length}`);
}
console.log('');

const results = [];
function test(name, fn) {
  const coinResults = {};
  for (const coin of COINS) {
    try { coinResults[coin] = fn(coin); }
    catch (e) { coinResults[coin] = { wr: 0, totalTrades: 0, sigma: 0 }; }
  }
  results.push({ name, coinResults });
  const parts = COINS.map(coin => {
    const r = coinResults[coin];
    if (!r || r.totalTrades < 10) return `${coin}=skip(n<10)`;
    const star = r.wr >= 0.80 ? ' 🔥🔥🔥' : r.wr >= 0.75 ? ' 🔥🔥' : r.wr >= 0.70 ? ' 🔥' : '';
    return `${coin}=${(r.wr * 100).toFixed(1)}% n=${r.totalTrades} σ=${r.sigma.toFixed(1)}%${star}`;
  });
  console.log(`[${name}]`);
  console.log(`  ${parts.join(' | ')}`);
  console.log('');
}

// ─── GROUP A: D2 Near-Miss Relaxation (BTC=84.2% n=19) ───────────────────────
// Original: MFI>78+StochK>80+RSI14>68+BB22+GH+ADX<20 → BTC=84.2% n=19
test('A1: MFI>76+StochK>80+RSI14>68+BB22+GH+ADX<20', (coin) => {
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
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 76 && stochK[i] > 80 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 24 && stochK[i] < 20 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('A2: MFI>75+StochK>80+RSI14>68+BB22+GH+ADX<20', (coin) => {
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
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 75 && stochK[i] > 80 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 25 && stochK[i] < 20 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A3: MFI>78 + StochK>75 (relax StochK instead)
test('A3: MFI>78+StochK>75+RSI14>68+BB22+GH+ADX<20', (coin) => {
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
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 78 && stochK[i] > 75 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 22 && stochK[i] < 25 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// A4: MFI>76 + StochK>80 + RSI14>68 + BB18 (tighter band = more trades)
test('A4: MFI>76+StochK>80+RSI14>68+BB18+GH+ADX<20', (coin) => {
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
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = mfi[i] > 76 && stochK[i] > 80 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = mfi[i] < 24 && stochK[i] < 20 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP B: RSI5 Sweet Spot ─────────────────────────────────────────────────
test('B1: RSI5>82+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi5 = rsiSeries(closes, 5);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi5[i] > 82 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi5[i] < 18 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('B2: RSI5>82+StochK>75+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi5 = rsiSeries(closes, 5);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi5[i] > 82 && stochK[i] > 75 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi5[i] < 18 && stochK[i] < 25 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('B3: RSI5>82+RSI14>68+MFI72+BB18+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi5 = rsiSeries(closes, 5);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi5[i] > 82 && rsi14[i] > 68 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bull = rsi5[i] < 18 && rsi14[i] < 32 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP C: Triple RSI Alignment ────────────────────────────────────────────
// All three RSI periods (3, 7, 14) simultaneously overbought = maximum alignment
test('C1: RSI3>90+RSI7>72+RSI14>68+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const rsi7 = rsiSeries(closes, 7);
  const rsi14 = rsiSeries(closes, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && rsi7[i] > 72 && rsi14[i] > 68 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && rsi7[i] < 28 && rsi14[i] < 32 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('C2: RSI3>90+RSI7>72+RSI14>68+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const rsi7 = rsiSeries(closes, 7);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && rsi7[i] > 72 && rsi14[i] > 68 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && rsi7[i] < 28 && rsi14[i] < 32 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('C3: RSI3>90+RSI7>72+RSI14>68+MFI70+BB18+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const rsi7 = rsiSeries(closes, 7);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && rsi7[i] > 72 && rsi14[i] > 68 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && rsi7[i] < 28 && rsi14[i] < 32 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// C4: RSI3>93+RSI7>73+RSI14>68+MFI70+BB22+GH+ADX<20 (stricter thresholds)
test('C4: RSI3>93+RSI7>73+RSI14>68+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const rsi7 = rsiSeries(closes, 7);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 93 && rsi7[i] > 73 && rsi14[i] > 68 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 7 && rsi7[i] < 27 && rsi14[i] < 32 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP D: Classic Stochastic Oscillator ───────────────────────────────────
// Classic Stoch(14,3): %K > 80 at BB extreme
test('D1: ClassicStoch(14,3)K>80+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochKSeries(c5, 14, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 80 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 20 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('D2: ClassicStoch(14,3)K>80+RSI7>70+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochKSeries(c5, 14, 3);
  const rsi7 = rsiSeries(closes, 7);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 80 && rsi7[i] > 70 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 20 && rsi7[i] < 30 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('D3: ClassicStoch(14,3)K>85+RSI3>90+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochKSeries(c5, 14, 3);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 85 && rsi3[i] > 90 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 15 && rsi3[i] < 10 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP E: Big Candle (ATR Filter) ─────────────────────────────────────────
// Candle height > 1.5×ATR14 at BB extreme = momentum exhaustion
test('E1: BigCandle>1.5xATR+RSI3>88+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const atr = atrSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || isNaN(atr[i]) || adx[i] >= 20) return null;
    const candleHeight = candles[i].high - candles[i].low;
    const isBigCandle = candleHeight > 1.5 * atr[i];
    const bear = isBigCandle && rsi3[i] > 88 && candles[i].close > bb.upper[i];
    const bull = isBigCandle && rsi3[i] < 12 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('E2: BigCandle>1.2xATR+StochK>80+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  const atr = atrSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || isNaN(atr[i]) || adx[i] >= 20) return null;
    const candleHeight = candles[i].high - candles[i].low;
    const isBigCandle = candleHeight > 1.2 * atr[i];
    const bear = isBigCandle && stochK[i] > 80 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = isBigCandle && stochK[i] < 20 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP F: Double StochK ────────────────────────────────────────────────────
// 2 consecutive candles with StochK>80 at BB extreme = sustained momentum
test('F1: 2Consec StochK>80+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    if (i < 1) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 80 && stochK[i - 1] > 80 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 20 && stochK[i - 1] < 20 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

test('F2: 2Consec StochK>80+RSI3>88+MFI70+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    if (i < 1) return null;
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 80 && stochK[i - 1] > 80 && rsi3[i] > 88 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 20 && stochK[i - 1] < 20 && rsi3[i] < 12 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP G: Triple Confirm BB18 Variants ────────────────────────────────────
// G1: RSI3>90 + MFI72 + RSI14>68 + BB18 + GH + ADX<20 (S16/S17 triple at BB18)
test('G1: RSI3>90+MFI72+RSI14>68+BB18+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && rsi14[i] > 68 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && rsi14[i] < 32 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// G2: RSI3>93 + StochK>80 + MFI72 + RSI14>68 + BB18 (full quad at BB18)
test('G2: RSI3>93+StochK>80+MFI72+RSI14>68+BB18+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 1.8);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 93 && stochK[i] > 80 && rsi14[i] > 68 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 7 && stochK[i] < 20 && rsi14[i] < 32 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// G3: BB%B > 1.0 + RSI3>90 + MFI72 + RSI14>68 + GH + ADX<20 (BB%B filter)
test('G3: BB%B>1.0+RSI3>90+MFI72+RSI14>68+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = bb.pctB[i] > 1.0 && rsi3[i] > 90 && rsi14[i] > 68 && mfi[i] > 72;
    const bull = bb.pctB[i] < 0.0 && rsi3[i] < 10 && rsi14[i] < 32 && mfi[i] < 28;
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── GROUP H: SOL-Specific Patterns ───────────────────────────────────────────
// H1: SOL StochK>85+MFI70+BB22+GH+ADX<20
test('H1: SOL StochK>85+MFI70+BB22+GH+ADX<20', (coin) => {
  if (coin !== 'SOL') {
    const c5 = data[coin]['5m'];
    const gh = GOOD_HOURS[coin];
    const closes = c5.map(c => c.close);
    const stochK = stochRsiKSeries(closes, 14, 14);
    const mfi = mfiSeries(c5, 14);
    const bb = bbSeries(closes, 20, 2.2);
    const adx = adxSeries(c5, 14);
    return backtest(c5, (candles, i) => {
      const hour = new Date(candles[i].t).getUTCHours();
      if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
      const bear = stochK[i] > 85 && mfi[i] > 70 && candles[i].close > bb.upper[i];
      const bull = stochK[i] < 15 && mfi[i] < 30 && candles[i].close < bb.lower[i];
      return bear ? 'BEAR' : bull ? 'BULL' : null;
    });
  }
  // SOL-specific with SOL good hours
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const stochK = stochRsiKSeries(closes, 14, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = stochK[i] > 85 && mfi[i] > 70 && candles[i].close > bb.upper[i];
    const bull = stochK[i] < 15 && mfi[i] < 30 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// H2: SOL RSI3>90+MFI72+RSI14>65+BB22+GH+ADX<20
test('H2: SOL RSI3>90+MFI72+RSI14>65+BB22+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const rsi14 = rsiSeries(closes, 14);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = rsi3[i] > 90 && rsi14[i] > 65 && mfi[i] > 72 && candles[i].close > bb.upper[i];
    const bull = rsi3[i] < 10 && rsi14[i] < 35 && mfi[i] < 28 && candles[i].close < bb.lower[i];
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// H3: SOL BB%B>1.05+RSI3>90+MFI70+GH+ADX<20 (BB%B filter for SOL)
test('H3: SOL BB%B>1.05+RSI3>90+MFI70+GH+ADX<20', (coin) => {
  const c5 = data[coin]['5m'];
  const gh = GOOD_HOURS[coin];
  const closes = c5.map(c => c.close);
  const rsi3 = rsiSeries(closes, 3);
  const mfi = mfiSeries(c5, 14);
  const bb = bbSeries(closes, 20, 2.2);
  const adx = adxSeries(c5, 14);
  return backtest(c5, (candles, i) => {
    const hour = new Date(candles[i].t).getUTCHours();
    if (!gh.includes(hour) || isNaN(bb.upper[i]) || adx[i] >= 20) return null;
    const bear = bb.pctB[i] > 1.05 && rsi3[i] > 90 && mfi[i] > 70;
    const bull = bb.pctB[i] < -0.05 && rsi3[i] < 10 && mfi[i] < 30;
    return bear ? 'BEAR' : bull ? 'BULL' : null;
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n════════════ SESSION 19 SUMMARY ════════════\n');
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
