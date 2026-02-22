/**
 * Session 27: Unexplored structural patterns
 *
 * Genuinely untested angles after 9 null continuation sessions:
 * A. Traditional Stochastic %K/%D (price-range based, DIFFERENT from StochRSI)
 * B. N-bar high/low break at BB extreme ("overbought at new high" → reversal)
 * C. SMA50/100 deviation filter (distance from long-term MA)
 * D. RSI(2) ultra-fast (Connors' other key ingredient, standalone)
 * E. ROC(1) micro-momentum + BB extreme (single-candle % gain at extreme)
 * F. End-of-UTC-hour candle (12th 5m candle = last before new hour)
 * G. Combined best of above with good hours
 *
 * Exit model: CORRECT fixed-expiry binary (next candle close)
 * Minimum threshold: WR >= 75%, n >= 10, tpd >= 0.33
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

function getCandles(symbol) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol).map(r => ({
    t: r.open_time, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume
  }));
}

// BB(20, 2.2)
function calcBB(candles, idx, period=20, mult=2.2) {
  if (idx < period) return null;
  const closes = candles.slice(idx - period, idx).map(c => c.c);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
  return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
}

// RSI
function calcRSI(candles, idx, period=7) {
  if (idx < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = idx - period; i < idx; i++) {
    const d = candles[i].c - candles[i-1].c;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

// MFI
function calcMFI(candles, idx, period=14) {
  if (idx < period + 1) return 50;
  let pos = 0, neg = 0;
  for (let i = idx - period; i < idx; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i-1].h + candles[i-1].l + candles[i-1].c) / 3;
    const mf = tp * candles[i].v;
    if (tp > prevTp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

// ADX
function calcADX(candles, idx, period=14) {
  if (idx < period * 2) return 50;
  let dp = 0, dm = 0, tr = 0;
  for (let i = idx - period; i < idx; i++) {
    const t = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
    const dH = candles[i].h - candles[i-1].h;
    const dL = candles[i-1].l - candles[i].l;
    dp += (dH > dL && dH > 0) ? dH : 0;
    dm += (dL > dH && dL > 0) ? dL : 0;
    tr += t;
  }
  if (tr === 0) return 50;
  const diP = (dp / tr) * 100;
  const diM = (dm / tr) * 100;
  const s = diP + diM;
  return s === 0 ? 0 : Math.abs(diP - diM) / s * 100;
}

// Traditional Stochastic %K (price range based)
// %K = (close - lowest_low_n) / (highest_high_n - lowest_low_n) * 100
function calcStochK(candles, idx, period=14) {
  if (idx < period) return 50;
  const slice = candles.slice(idx - period, idx + 1); // include current
  const lowestLow = Math.min(...slice.map(c => c.l));
  const highestHigh = Math.max(...slice.map(c => c.h));
  if (highestHigh === lowestLow) return 50;
  return (candles[idx].c - lowestLow) / (highestHigh - lowestLow) * 100;
}

// %D = SMA(3) of %K
function calcStochD(candles, idx, period=14, smooth=3) {
  if (idx < period + smooth - 1) return 50;
  let sum = 0;
  for (let i = 0; i < smooth; i++) {
    sum += calcStochK(candles, idx - i, period);
  }
  return sum / smooth;
}

// RSI(2) ultra-fast
function calcRSI2(candles, idx) {
  return calcRSI(candles, idx, 2);
}

// SMA(n)
function calcSMA(candles, idx, period) {
  if (idx < period) return null;
  return candles.slice(idx - period, idx).reduce((s, c) => s + c.c, 0) / period;
}

// ROC(n) = (close - close[n-periods-ago]) / close[n-periods-ago] * 100
function calcROC(candles, idx, period=1) {
  if (idx < period) return 0;
  const prev = candles[idx - period].c;
  return (candles[idx].c - prev) / prev * 100;
}

function getOutcome(candles, i, dir) {
  if (i + 1 >= candles.length) return null;
  const entry = candles[i].c, exit = candles[i+1].c;
  if (dir === 'DOWN') return exit < entry ? 1 : 0;
  return exit > entry ? 1 : 0;
}

function backtest(candles, filterFn, direction) {
  let wins = 0, total = 0;
  for (let i = 50; i < candles.length - 1; i++) {
    if (filterFn(candles, i)) {
      const out = getOutcome(candles, i, direction);
      if (out !== null) { total++; if (out === 1) wins++; }
    }
  }
  if (total < 5) return null;
  const days = candles.length * 5 / (60 * 24);
  return { wr: wins / total, n: total, tpd: total / days };
}

function fmt(label, coin, res, winners) {
  if (!res) return;
  const e = res.wr >= 0.80 ? '🔥🔥🔥' : res.wr >= 0.75 ? '🔥🔥' : res.wr >= 0.70 ? '🔥' : '';
  const w = res.tpd < 0.33 ? ` ⚠️ tpd=${res.tpd.toFixed(2)}` : '';
  console.log(`  ${label} | ${coin}: WR=${(res.wr*100).toFixed(1)}% n=${res.n} tpd=${res.tpd.toFixed(2)} ${e}${w}`);
  if (res.wr >= 0.75 && res.n >= 10 && res.tpd >= 0.33 && winners) winners.push({ label, coin, ...res });
}

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const GH = { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] };

console.log('Loading candles...');
const ALL = {};
for (const c of COINS) {
  ALL[c] = getCandles(c);
  console.log(`  ${c}: ${ALL[c].length} candles (${Math.floor(ALL[c].length * 5 / 1440)} days)`);
}

const winners = [];

// =============================================
// Section A: Traditional Stochastic %K/%D at BB extremes
// =============================================
console.log('\n== Section A: Traditional Stochastic %K/%D at BB extremes ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // A1: StochK>90 + BB upper (all hours)
  fmt(`A1_${coin}_StochK>90_BB22_allH`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcStochK(c, i) > 90;
  }, 'DOWN'), winners);

  // A2: StochK>90 + StochD>80 + BB upper (both %K and %D extreme)
  fmt(`A2_${coin}_StochK>90_D>80_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcStochK(c, i) > 90 && calcStochD(c, i) > 80;
  }, 'DOWN'), winners);

  // A3: StochK>90 + RSI7>70 + BB upper (cross-oscillator)
  fmt(`A3_${coin}_StochK>90_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcStochK(c, i) > 90 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // A4: StochK>90 + good hours
  fmt(`A4_${coin}_StochK>90_BB22_GH`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcStochK(c, i) > 90;
  }, 'DOWN'), winners);

  // A5: StochK>85 + MFI>68 + BB upper
  fmt(`A5_${coin}_StochK>85_MFI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcStochK(c, i) > 85 && calcMFI(c, i) > 68;
  }, 'DOWN'), winners);

  // A6: StochK>80 + ADX<20 (ranging) + BB upper
  fmt(`A6_${coin}_StochK>80_ADX20_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcStochK(c, i) > 80 && calcADX(c, i) < 20;
  }, 'DOWN'), winners);

  // A7: StochK>90 + ADX<20 + good hours (triple filter)
  fmt(`A7_${coin}_StochK>90_ADX20_GH`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcStochK(c, i) > 90 && calcADX(c, i) < 20;
  }, 'DOWN'), winners);

  // A8: StochD (smoothed) > 85 + BB upper — slower signal, less noise
  fmt(`A8_${coin}_StochD>85_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcStochD(c, i) > 85;
  }, 'DOWN'), winners);
}

// =============================================
// Section B: N-bar high/low break at BB extreme
// "Price at new N-bar high WHILE outside BB" = overbought at breakout → reversal
// =============================================
console.log('\n== Section B: N-bar high/low + BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // B1: New 20-bar high close + above BB upper (all hours)
  fmt(`B1_${coin}_20barHigh_BB22_allH`, coin, backtest(cs, (c, i) => {
    if (i < 20) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const maxClose = Math.max(...c.slice(i - 20, i).map(x => x.c));
    return c[i].c >= maxClose; // current close = new 20-bar high
  }, 'DOWN'), winners);

  // B2: New 10-bar high + above BB + RSI7>70
  fmt(`B2_${coin}_10barHigh_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 10) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 70) return false;
    const maxClose = Math.max(...c.slice(i - 10, i).map(x => x.c));
    return c[i].c >= maxClose;
  }, 'DOWN'), winners);

  // B3: New 30-bar high + above BB (stronger signal)
  fmt(`B3_${coin}_30barHigh_BB22_allH`, coin, backtest(cs, (c, i) => {
    if (i < 30) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const maxClose = Math.max(...c.slice(i - 30, i).map(x => x.c));
    return c[i].c >= maxClose;
  }, 'DOWN'), winners);

  // B4: New 20-bar high + good hours + BB
  fmt(`B4_${coin}_20barHigh_BB22_GH`, coin, backtest(cs, (c, i) => {
    if (i < 20) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const maxClose = Math.max(...c.slice(i - 20, i).map(x => x.c));
    return c[i].c >= maxClose;
  }, 'DOWN'), winners);

  // B5: New 20-bar high + ADX<20 + BB (ranging + overbought at new high)
  fmt(`B5_${coin}_20barHigh_ADX20_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 20) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    if (calcADX(c, i) > 20) return false;
    const maxClose = Math.max(...c.slice(i - 20, i).map(x => x.c));
    return c[i].c >= maxClose;
  }, 'DOWN'), winners);

  // B6: Price at new 20-bar HIGH while RSI falling (bearish divergence signal)
  // Proxy: current candle high = 20-bar max AND current RSI < prev RSI
  fmt(`B6_${coin}_20barHigh_RSIdiverg_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 21) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const maxClose = Math.max(...c.slice(i - 20, i).map(x => x.c));
    if (c[i].c < maxClose) return false; // must be new high
    const rsiNow = calcRSI(c, i);
    const rsiPrev = calcRSI(c, i - 1);
    return rsiNow < rsiPrev && rsiNow > 65; // RSI declining but still elevated
  }, 'DOWN'), winners);
}

// =============================================
// Section C: SMA50/100 deviation filter
// Far above long-term SMA = overextension → stronger mean reversion
// =============================================
console.log('\n== Section C: SMA deviation filter ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // C1: Close > SMA50 × 1.01 (1% above 50-bar SMA) + BB upper
  fmt(`C1_${coin}_SMA50dev1pct_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 50) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const sma50 = calcSMA(c, i, 50);
    return sma50 && c[i].c > sma50 * 1.01;
  }, 'DOWN'), winners);

  // C2: Close > SMA100 × 1.005 (0.5% above 100-bar SMA) + BB upper
  fmt(`C2_${coin}_SMA100dev05_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 100) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const sma100 = calcSMA(c, i, 100);
    return sma100 && c[i].c > sma100 * 1.005;
  }, 'DOWN'), winners);

  // C3: SMA50 deviation + RSI7>70 + good hours
  fmt(`C3_${coin}_SMA50dev_RSI70_GH`, coin, backtest(cs, (c, i) => {
    if (i < 50) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const rsi = calcRSI(c, i);
    const sma50 = calcSMA(c, i, 50);
    return rsi > 70 && sma50 && c[i].c > sma50 * 1.008;
  }, 'DOWN'), winners);

  // C4: SMA50 deviation + MFI>68 + ADX<20
  fmt(`C4_${coin}_SMA50dev_MFI68_ADX20`, coin, backtest(cs, (c, i) => {
    if (i < 50) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const sma50 = calcSMA(c, i, 50);
    if (!sma50 || c[i].c <= sma50 * 1.005) return false;
    return calcMFI(c, i) > 68 && calcADX(c, i) < 20;
  }, 'DOWN'), winners);

  // C5: SMA deviation sweep — 0.3% to 1.5% above SMA50
  for (const devPct of [0.3, 0.5, 0.8, 1.0, 1.5]) {
    const res = backtest(cs, (c, i) => {
      if (i < 50) return false;
      const bb = calcBB(c, i);
      if (!bb || c[i].c < bb.upper) return false;
      const sma50 = calcSMA(c, i, 50);
      return sma50 && c[i].c > sma50 * (1 + devPct/100);
    }, 'DOWN');
    if (res && res.wr >= 0.68 && res.n >= 10) {
      fmt(`C5_${coin}_SMA50dev${devPct}pct`, coin, res, winners);
    }
  }
}

// =============================================
// Section D: RSI(2) ultra-fast (Connors' key ingredient)
// RSI(2) >98 = extremely overbought in 2-bar window
// =============================================
console.log('\n== Section D: RSI(2) ultra-fast extremes ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // D1: RSI(2)>97 + BB upper (all hours)
  fmt(`D1_${coin}_RSI2>97_BB22_allH`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcRSI2(c, i) > 97;
  }, 'DOWN'), winners);

  // D2: RSI(2)>95 + RSI7>70 + BB upper
  fmt(`D2_${coin}_RSI2>95_RSI7>70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcRSI2(c, i) > 95 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // D3: RSI(2)>97 + good hours
  fmt(`D3_${coin}_RSI2>97_BB22_GH`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcRSI2(c, i) > 97;
  }, 'DOWN'), winners);

  // D4: RSI(2)>97 + MFI>68 + BB upper
  fmt(`D4_${coin}_RSI2>97_MFI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcRSI2(c, i) > 97 && calcMFI(c, i) > 68;
  }, 'DOWN'), winners);

  // D5: RSI(2) sweep
  for (const thr of [90, 93, 95, 97, 99]) {
    const res = backtest(cs, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c < bb.upper) return false;
      return calcRSI2(c, i) > thr;
    }, 'DOWN');
    if (res && res.wr >= 0.68 && res.n >= 10) {
      fmt(`D5_${coin}_RSI2>${thr}_BB22`, coin, res, winners);
    }
  }
}

// =============================================
// Section E: ROC(1) micro-momentum at BB extreme
// Big single-candle gain while overbought = exhaustion
// =============================================
console.log('\n== Section E: ROC micro-momentum at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // E1: ROC(1)>0.3% (big gain candle) + above BB upper + RSI7>70
  fmt(`E1_${coin}_ROC1>0.3pct_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcROC(c, i, 1) > 0.3 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // E2: ROC(1)>0.5% + above BB upper (strong push while overbought)
  fmt(`E2_${coin}_ROC1>0.5pct_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcROC(c, i, 1) > 0.5;
  }, 'DOWN'), winners);

  // E3: ROC(3)>1.0% + BB upper (3-candle push = momentum)
  fmt(`E3_${coin}_ROC3>1pct_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcROC(c, i, 3) > 1.0;
  }, 'DOWN'), winners);

  // E4: ROC(1)>0.3% + good hours + BB
  fmt(`E4_${coin}_ROC1>0.3pct_GH_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcROC(c, i, 1) > 0.3 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // E5: ROC sweep
  for (const rocThr of [0.2, 0.3, 0.5, 0.8, 1.0]) {
    const res = backtest(cs, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c < bb.upper) return false;
      const rsi = calcRSI(c, i);
      return calcROC(c, i, 1) > rocThr && rsi > 70;
    }, 'DOWN');
    if (res && res.wr >= 0.68 && res.n >= 10) {
      fmt(`E5_${coin}_ROC>${rocThr}_RSI70_BB22`, coin, res, winners);
    }
  }
}

// =============================================
// Section F: End-of-UTC-hour candle
// The 12th 5m candle in an hour (t % 3600 >= 3300) = last candle before hour change
// Hypothesis: liquidity may thin out, making reversals more predictable
// =============================================
console.log('\n== Section F: End-of-hour candle timing ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // F1: Last 5m candle of hour + RSI7>70 + BB upper
  fmt(`F1_${coin}_EndOfHour_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const secInHour = Math.floor(c[i].t / 1000) % 3600;
    if (secInHour < 3300) return false; // last 5 min of hour
    return calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // F2: First 5m candle of hour + RSI7>70 + BB upper
  fmt(`F2_${coin}_StartOfHour_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const secInHour = Math.floor(c[i].t / 1000) % 3600;
    if (secInHour > 300) return false; // first 5 min of hour
    return calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // F3: End-of-hour + good hours
  fmt(`F3_${coin}_EndOfHour_GH_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const secInHour = Math.floor(c[i].t / 1000) % 3600;
    if (secInHour < 3300) return false;
    return calcRSI(c, i) > 70;
  }, 'DOWN'), winners);
}

// =============================================
// Section G: Best combinations — StochK + RSI3 + BB22
// Build on Session 16 strat 110 (StochK>85+MFI72+RSI14+BB22) which had BTC=80%
// Try different StochK thresholds and RSI3 combos
// =============================================
console.log('\n== Section G: StochK threshold × RSI3 grid ==\n');

for (const coin of ['ETH', 'BTC', 'SOL', 'XRP']) {
  const cs = ALL[coin];
  const gh = GH[coin];

  console.log(`  ${coin} StochK×RSI3 grid (GH+BB22):`);
  for (const stochThr of [80, 85, 90, 95]) {
    for (const rsi3Thr of [88, 90, 92, 95]) {
      const res = backtest(cs, (c, i) => {
        const bb = calcBB(c, i);
        if (!bb || c[i].c < bb.upper) return false;
        const h = new Date(c[i].t).getUTCHours();
        if (!gh.includes(h)) return false;
        return calcStochK(c, i) > stochThr && calcRSI(c, i, 3) > rsi3Thr;
      }, 'DOWN');
      if (res && res.wr >= 0.70 && res.n >= 8) {
        const e = res.wr >= 0.80 ? '🔥🔥🔥' : res.wr >= 0.75 ? '🔥🔥' : '🔥';
        const w = res.tpd < 0.33 ? ` ⚠️ tpd=${res.tpd.toFixed(2)}` : '';
        console.log(`    Stoch>${stochThr} RSI3>${rsi3Thr}: WR=${(res.wr*100).toFixed(1)}% n=${res.n} tpd=${res.tpd.toFixed(2)} ${e}${w}`);
        if (res.wr >= 0.75 && res.n >= 10 && res.tpd >= 0.33) winners.push({ label: `G_${coin}_Stoch${stochThr}_RSI3${rsi3Thr}_GH_BB22`, coin, ...res });
      }
    }
  }
}

// =============================================
// SUMMARY
// =============================================
console.log('\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10, tpd>=0.33 ===');
console.log('=======================================================');
if (winners.length === 0) {
  console.log('  (none)');
} else {
  for (const w of winners) {
    console.log(`  ${w.label}: WR=${(w.wr*100).toFixed(1)}% n=${w.n} tpd=${w.tpd.toFixed(2)} 🔥🔥`);
  }
}

// Near-misses (WR>=70%, n>=10, tpd<0.33 or WR<75% with tpd>=0.33)
console.log('\n=== All results >= 70% WR, n >= 10 ===');
console.log('  (see ⚠️ markers above for near-misses)');

db.close();
