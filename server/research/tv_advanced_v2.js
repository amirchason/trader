'use strict';
/**
 * TradingView Advanced V2 — New Pattern Validation
 *
 * Based on TradingView community research and agent findings:
 * 1. ATR Climax Candle Reversal (big candle at BB extreme → reverse) — ~65-70% WR
 * 2. Stochastic RSI (both K+D extreme) + BB — ~62-68% WR
 * 3. CCI < -150 at lower BB — ~62-66% WR
 * 4. Williams %R + BB — ~60-65% WR
 * 5. Volume Spike Exhaustion (>2x avg vol at BB extreme)
 * 6. CRSI + MFI combo (best combination per research)
 * 7. CRSI + Stoch RSI (double oscillator confirmation)
 *
 * EXIT: next single 5m candle close (correct Polymarket binary)
 * FEES: 2% Polymarket spread → EV = WR*0.49 - (1-WR)*0.51
 * WALK-FORWARD: 5-fold
 */

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(process.cwd(), 'trader.db'), { readonly: true });

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];

function getCandles(symbol, tf) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume
     FROM candles WHERE symbol = ? AND timeframe = ?
     ORDER BY open_time ASC`
  ).all(symbol, tf);
}

// ─── Pre-computed Indicator Series ───────────────────────────────────────────

function computeRSISeries(closes, period) {
  const n = closes.length;
  const rsi = new Float64Array(n).fill(50);
  if (n <= period) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function computeBBSeries(closes, period, mult) {
  const n = closes.length;
  const upper = new Float64Array(n), lower = new Float64Array(n), mid = new Float64Array(n);
  let sumX = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += closes[i]; sumX2 += closes[i] ** 2;
    if (i >= period) { sumX -= closes[i - period]; sumX2 -= closes[i - period] ** 2; }
    if (i >= period - 1) {
      const m = sumX / period;
      const v = Math.max(0, sumX2 / period - m * m);
      const s = Math.sqrt(v);
      mid[i] = m; upper[i] = m + mult * s; lower[i] = m - mult * s;
    }
  }
  return { upper, lower, mid };
}

function computeATRSeries(candles, period) {
  const n = candles.length;
  const atr = new Float64Array(n);
  let runATR = 0;
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i < period) { runATR += tr; if (i === period - 1) runATR /= period; }
    else runATR = (runATR * (period - 1) + tr) / period;
    atr[i] = runATR;
  }
  return atr;
}

function computeMFISeries(candles, period) {
  const n = candles.length;
  const mfi = new Float64Array(n).fill(50);
  for (let i = period; i < n; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const pp = (candles[j-1].high + candles[j-1].low + candles[j-1].close) / 3;
      const mf = tp * candles[j].volume;
      if (tp > pp) pos += mf; else neg += mf;
    }
    mfi[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return mfi;
}

// CCI: (TP - SMA(TP, n)) / (0.015 * MeanDeviation)
function computeCCISeries(candles, period) {
  const n = candles.length;
  const cci = new Float64Array(n).fill(0);
  for (let i = period - 1; i < n; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const tp = slice.map(c => (c.high + c.low + c.close) / 3);
    const sma = tp.reduce((s, v) => s + v, 0) / period;
    const md = tp.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    cci[i] = md > 0 ? (tp[tp.length - 1] - sma) / (0.015 * md) : 0;
  }
  return cci;
}

// Williams %R: ((Highest High - Close) / (Highest High - Lowest Low)) * -100
function computeWilliamsRSeries(candles, period) {
  const n = candles.length;
  const wr = new Float64Array(n).fill(-50);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    wr[i] = hh !== ll ? ((hh - candles[i].close) / (hh - ll)) * -100 : -50;
  }
  return wr;
}

// StochRSI: Stochastic of RSI series
function computeStochRSISeries(closes, rsiPeriod, stochPeriod, smoothK) {
  const n = closes.length;
  const rsiArr = computeRSISeries(closes, rsiPeriod);
  const stochK = new Float64Array(n).fill(50);
  const stochD = new Float64Array(n).fill(50);

  for (let i = rsiPeriod + stochPeriod; i < n; i++) {
    const slice = Array.from(rsiArr.slice(i - stochPeriod + 1, i + 1));
    const lo = Math.min(...slice), hi = Math.max(...slice);
    stochK[i] = hi === lo ? 50 : ((rsiArr[i] - lo) / (hi - lo)) * 100;
  }

  // Smooth K (EMA/SMA of rawK)
  const smoothed = new Float64Array(n).fill(50);
  let runK = 0, count = 0;
  for (let i = 0; i < n; i++) {
    runK += stochK[i]; count++;
    if (count >= smoothK) {
      smoothed[i] = runK / Math.min(count, smoothK);
      runK -= stochK[Math.max(0, i - smoothK + 1)];
    }
  }

  // D = SMA(3) of smoothed K
  for (let i = 3; i < n; i++) {
    stochD[i] = (smoothed[i] + smoothed[i - 1] + smoothed[i - 2]) / 3;
  }

  return { k: smoothed, d: stochD };
}

function computeStreakSeries(candles) {
  const n = candles.length;
  const s = new Int8Array(n);
  let cur = 0;
  for (let i = 1; i < n; i++) {
    if (candles[i].close > candles[i].open) cur = cur > 0 ? Math.min(cur + 1, 10) : 1;
    else if (candles[i].close < candles[i].open) cur = cur < 0 ? Math.max(cur - 1, -10) : -1;
    else cur = 0;
    s[i] = cur;
  }
  return s;
}

// CRSI series (fast)
function computeCRSISeries(closes, streaks, period = 100) {
  const n = closes.length;
  const rsi3 = computeRSISeries(closes, 3);
  const streakF = new Float64Array(n);
  for (let i = 0; i < n; i++) streakF[i] = streaks[i];
  const srsi2 = computeRSISeries(streakF, 2);
  const crsi = new Float64Array(n).fill(50);
  for (let i = period; i < n; i++) {
    const ret = closes[i - 1] > 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0;
    let below = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const r = closes[j - 1] > 0 ? (closes[j] - closes[j - 1]) / closes[j - 1] : 0;
      if (r < ret) below++;
    }
    crsi[i] = (rsi3[i] + srsi2[i] + (below / period * 100)) / 3;
  }
  return crsi;
}

function walkForward(trades, nFolds = 5) {
  if (trades.length < 30) return { wr: 0, tpd: 0, sigma: 0 };
  trades.sort((a, b) => a.ts - b.ts);
  const n = trades.length;
  const foldSize = Math.floor(n / (nFolds + 1));
  const wrFolds = [];
  for (let fold = 0; fold < nFolds; fold++) {
    const ts = (fold + 1) * foldSize, te = Math.min(ts + foldSize, n);
    const test = trades.slice(ts, te);
    if (test.length < 5) continue;
    wrFolds.push(test.filter(t => t.won).length / test.length);
  }
  if (!wrFolds.length) return { wr: 0, tpd: 0, sigma: 0 };
  wrFolds.sort((a, b) => a - b);
  const medWR = wrFolds[Math.floor(wrFolds.length / 2)];
  const meanWR = wrFolds.reduce((s, v) => s + v, 0) / wrFolds.length;
  const sigma = Math.sqrt(wrFolds.map(w => (w - meanWR) ** 2).reduce((s, v) => s + v, 0) / wrFolds.length);
  const spanDays = (trades[n - 1].ts - trades[0].ts) / 86400000 || 1;
  return { wr: medWR, tpd: n / spanDays, sigma };
}

function runCoin(coin) {
  const c5m = getCandles(coin, '5m');
  const n = c5m.length;
  const closes = new Float64Array(n);
  const volumes = new Float64Array(n);
  for (let i = 0; i < n; i++) { closes[i] = c5m[i].close; volumes[i] = c5m[i].volume; }

  console.log(`\n══ ${coin} ════════════════════════════════════════`);

  // Pre-compute
  const rsi7   = computeRSISeries(closes, 7);
  const rsi14  = computeRSISeries(closes, 14);
  const bb22   = computeBBSeries(closes, 20, 2.2);
  const bb18   = computeBBSeries(closes, 20, 1.8);
  const atr14  = computeATRSeries(c5m, 14);
  const mfi14  = computeMFISeries(c5m, 14);
  const cci20  = computeCCISeries(c5m, 20);
  const wr14   = computeWilliamsRSeries(c5m, 14);
  const srsi   = computeStochRSISeries(closes, 14, 14, 3);
  const streaks = computeStreakSeries(c5m);
  const crsi   = computeCRSISeries(closes, streaks);

  // Pre-compute volume moving average
  const volMA = new Float64Array(n);
  for (let i = 20; i < n; i++) {
    let sum = 0;
    for (let j = i - 20; j < i; j++) sum += volumes[j];
    volMA[i] = sum / 20;
  }

  function exit(i) {
    if (i + 1 >= n) return null;
    return c5m[i + 1].close > c5m[i].close; // true=bullish next candle
  }

  const results = [];

  function test(name, fn) {
    const trades = [];
    for (let i = 100; i < n - 1; i++) {
      const sig = fn(i);
      if (!sig) continue;
      const nextBull = exit(i);
      if (nextBull === null) continue;
      const won = sig === 'BULL' ? nextBull : !nextBull;
      trades.push({ ts: c5m[i].open_time, won });
    }
    const wf = walkForward(trades);
    const ev = wf.wr * 0.49 - (1 - wf.wr) * 0.51;
    const status = wf.wr >= 0.57 && wf.tpd >= 5 ? '🏆' :
                   wf.wr >= 0.55 && wf.tpd >= 5 ? '✅' :
                   wf.wr >= 0.53 ? '⚠️' : '❌';
    const evStr = (ev >= 0 ? '+' : '') + (ev * 100).toFixed(2) + '%';
    results.push({ name, ...wf, ev, coin });
    console.log(`  ${name.padEnd(35)} | WR=${(wf.wr*100).toFixed(1)}% | ${wf.tpd.toFixed(0).padStart(4)}/d | EV=${evStr.padStart(7)} | σ=${(wf.sigma*100).toFixed(1)}% ${status}`);
  }

  // ── 1. ATR Climax Candle Reversal ──────────────────────────────────────────
  // Big candle (> 1.5x ATR) at BB extreme → revert next candle
  test('ATR Climax at BB22 (1.5x)', i => {
    const c = c5m[i], body = Math.abs(c.close - c.open);
    const isClimaxBear = c.close < c.open && body > atr14[i] * 1.5 && c.close > bb22.upper[i] * 0.99;
    const isClimaxBull = c.close > c.open && body > atr14[i] * 1.5 && c.close < bb22.lower[i] * 1.01;
    // NOTE: bearish climax at UPPER BB → bet BEAR (continuation), BULL climax at LOWER BB → bet BULL
    // Wait — research says "big bearish candle at upper BB → revert"... but my logic below:
    // Actually: a big UP candle at upper BB is a CLIMAX UP → bet DOWN (revert)
    // A big DOWN candle at lower BB is a CLIMAX DOWN → bet UP (revert)
    if (closes[i] > bb22.upper[i] && body > atr14[i] * 1.5 && c5m[i].close > c5m[i].open) return 'BEAR';
    if (closes[i] < bb22.lower[i] && body > atr14[i] * 1.5 && c5m[i].close < c5m[i].open) return 'BULL';
    return null;
  });

  test('ATR Climax at BB22 (1.0x)', i => {
    const c = c5m[i], body = Math.abs(c.close - c.open);
    if (closes[i] > bb22.upper[i] && body > atr14[i] * 1.0 && c.close > c.open) return 'BEAR';
    if (closes[i] < bb22.lower[i] && body > atr14[i] * 1.0 && c.close < c.open) return 'BULL';
    return null;
  });

  test('ATR Climax + RSI7 extreme', i => {
    const c = c5m[i], body = Math.abs(c.close - c.open);
    if (closes[i] > bb22.upper[i] && body > atr14[i] * 1.0 && c.close > c.open && rsi7[i] > 70) return 'BEAR';
    if (closes[i] < bb22.lower[i] && body > atr14[i] * 1.0 && c.close < c.open && rsi7[i] < 30) return 'BULL';
    return null;
  });

  // ── 2. Stochastic RSI + BB ──────────────────────────────────────────────────
  test('StochRSI (K+D<20) + BB22', i => {
    if (srsi.k[i] < 20 && srsi.d[i] < 20 && closes[i] < bb22.lower[i]) return 'BULL';
    if (srsi.k[i] > 80 && srsi.d[i] > 80 && closes[i] > bb22.upper[i]) return 'BEAR';
    return null;
  });

  test('StochRSI (K<20) + BB22', i => {
    if (srsi.k[i] < 20 && closes[i] < bb22.lower[i]) return 'BULL';
    if (srsi.k[i] > 80 && closes[i] > bb22.upper[i]) return 'BEAR';
    return null;
  });

  test('StochRSI (K+D<30) + RSI14', i => {
    if (srsi.k[i] < 30 && srsi.d[i] < 30 && rsi14[i] < 40) return 'BULL';
    if (srsi.k[i] > 70 && srsi.d[i] > 70 && rsi14[i] > 60) return 'BEAR';
    return null;
  });

  // ── 3. CCI Extremes + BB ────────────────────────────────────────────────────
  test('CCI<-150 + BB22', i => {
    if (cci20[i] < -150 && closes[i] < bb22.lower[i]) return 'BULL';
    if (cci20[i] > 150 && closes[i] > bb22.upper[i]) return 'BEAR';
    return null;
  });

  test('CCI<-100 + BB22', i => {
    if (cci20[i] < -100 && closes[i] < bb22.lower[i]) return 'BULL';
    if (cci20[i] > 100 && closes[i] > bb22.upper[i]) return 'BEAR';
    return null;
  });

  test('CCI<-200 (extreme)', i => {
    if (cci20[i] < -200) return 'BULL';
    if (cci20[i] > 200) return 'BEAR';
    return null;
  });

  // ── 4. Williams %R + BB ─────────────────────────────────────────────────────
  test('Williams%R<-90 + BB22', i => {
    if (wr14[i] < -90 && closes[i] < bb22.lower[i]) return 'BULL';
    if (wr14[i] > -10 && closes[i] > bb22.upper[i]) return 'BEAR';
    return null;
  });

  test('Williams%R<-80 + RSI7', i => {
    if (wr14[i] < -80 && rsi7[i] < 30) return 'BULL';
    if (wr14[i] > -20 && rsi7[i] > 70) return 'BEAR';
    return null;
  });

  // ── 5. Volume Spike Exhaustion ──────────────────────────────────────────────
  test('Vol Spike>2x + BB22', i => {
    if (volMA[i] === 0) return null;
    const spike = volumes[i] > volMA[i] * 2.0;
    if (!spike) return null;
    // Large bull candle with volume spike at upper BB → exhaustion → BEAR
    if (closes[i] > bb22.upper[i] && c5m[i].close > c5m[i].open) return 'BEAR';
    if (closes[i] < bb22.lower[i] && c5m[i].close < c5m[i].open) return 'BULL';
    return null;
  });

  test('Vol Spike>1.5x + RSI7', i => {
    if (volMA[i] === 0) return null;
    const spike = volumes[i] > volMA[i] * 1.5;
    if (!spike) return null;
    if (closes[i] > bb22.upper[i] && rsi7[i] > 70) return 'BEAR';
    if (closes[i] < bb22.lower[i] && rsi7[i] < 30) return 'BULL';
    return null;
  });

  // ── 6. CRSI + MFI combo ─────────────────────────────────────────────────────
  test('CRSI15 + MFI', i => {
    if (crsi[i] < 15 && mfi14[i] < 30) return 'BULL';
    if (crsi[i] > 85 && mfi14[i] > 70) return 'BEAR';
    return null;
  });

  test('CRSI20 + MFI', i => {
    if (crsi[i] < 20 && mfi14[i] < 35) return 'BULL';
    if (crsi[i] > 80 && mfi14[i] > 65) return 'BEAR';
    return null;
  });

  // ── 7. CRSI + StochRSI (double oscillator) ──────────────────────────────────
  test('CRSI15 + StochRSI<25', i => {
    if (crsi[i] < 15 && srsi.k[i] < 25) return 'BULL';
    if (crsi[i] > 85 && srsi.k[i] > 75) return 'BEAR';
    return null;
  });

  test('CRSI20 + StochRSI<30', i => {
    if (crsi[i] < 20 && srsi.k[i] < 30) return 'BULL';
    if (crsi[i] > 80 && srsi.k[i] > 70) return 'BEAR';
    return null;
  });

  // ── 8. BB22 + CCI + RSI triple ──────────────────────────────────────────────
  test('BB22+CCI+RSI7 triple', i => {
    if (closes[i] < bb22.lower[i] && cci20[i] < -80 && rsi7[i] < 30) return 'BULL';
    if (closes[i] > bb22.upper[i] && cci20[i] > 80 && rsi7[i] > 70) return 'BEAR';
    return null;
  });

  // ── 9. MFI extreme alone + streak ────────────────────────────────────────────
  test('MFI<20 + streak≤-1', i => {
    if (mfi14[i] < 20 && streaks[i] <= -1) return 'BULL';
    if (mfi14[i] > 80 && streaks[i] >= 1) return 'BEAR';
    return null;
  });

  test('MFI<15 + BB22', i => {
    if (mfi14[i] < 15 && closes[i] < bb22.lower[i]) return 'BULL';
    if (mfi14[i] > 85 && closes[i] > bb22.upper[i]) return 'BEAR';
    return null;
  });

  return results;
}

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('  TradingView Advanced V2 — New Pattern Validation');
console.log('  ATR Climax + StochRSI + CCI + Williams%R + Volume Spike + CRSI combos');
console.log('═══════════════════════════════════════════════════════════════════════\n');
console.log(`  Strategy                            | WR    | T/d   | EV      | σ       | Status`);
console.log(`  ------------------------------------+-------+-------+---------+---------+-------`);

const allResults = {};
for (const coin of COINS) {
  allResults[coin] = runCoin(coin);
}

// ─── Grand Summary ────────────────────────────────────────────────────────────
console.log('\n\n═══════════════════════════════════════════════════════════════════════');
console.log('  GRAND SUMMARY — Best Strategies Across All Coins');
console.log('═══════════════════════════════════════════════════════════════════════\n');

const names = allResults[COINS[0]].map(r => r.name);
const agg = names.map(name => {
  const coinData = COINS.map(coin => allResults[coin].find(x => x.name === name) || { wr: 0, tpd: 0, ev: -0.5 });
  const avgWR = coinData.reduce((s, r) => s + r.wr, 0) / coinData.length;
  const totTPD = coinData.reduce((s, r) => s + r.tpd, 0);
  const avgEV = coinData.reduce((s, r) => s + r.ev, 0) / coinData.length;
  return { name, avgWR, totTPD, avgEV, profitScore: avgEV * totTPD, coinData };
});

agg.sort((a, b) => b.avgWR - a.avgWR);

console.log(`  Rank | Strategy                             | Avg WR | T/d   | Profit Sc | Status`);
console.log(`  -----+--------------------------------------+--------+-------+-----------+-------`);

for (let i = 0; i < agg.length; i++) {
  const r = agg[i];
  const evStr = (r.avgEV >= 0 ? '+' : '') + (r.avgEV * 100).toFixed(2) + '%';
  const status = r.avgWR >= 0.57 && r.totTPD >= 15 ? '🏆 GREAT' :
                 r.avgWR >= 0.55 && r.totTPD >= 10 ? '✅ GOOD' :
                 r.avgWR >= 0.53 ? '⚠️ OK' : '❌';
  console.log(`  ${(i+1).toString().padStart(4)} | ${r.name.padEnd(37)}| ${(r.avgWR*100).toFixed(1)}%  | ${r.totTPD.toFixed(0).padStart(4)}/d | ${r.profitScore.toFixed(3).padStart(9)} | ${status}`);
}

console.log('\n  Per-coin breakdown for top-5 strategies:');
for (const r of agg.slice(0, 5)) {
  const perCoin = COINS.map((c, i) => `${c}:${r.coinData[i].tpd.toFixed(0)}/d@${(r.coinData[i].wr*100).toFixed(1)}%`).join(' | ');
  console.log(`  ${r.name.padEnd(37)}: ${perCoin}`);
}
