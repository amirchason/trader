/**
 * Session 28: Reversal confirmation + ROC enhancement + 1h macro regime
 *
 * Key near-miss from session 27: E4_ETH ROC1>0.3%+GH+RSI68+BB22 = 73.0% WR n=63 tpd=0.34
 * → Focus: push E4 from 73% to 75% with minimal trade loss
 *
 * New angles:
 * A. ROC enhancement — build on session27 near-miss (ETH ROC 73% WR)
 * B. Reversal confirmation — prev candle ALREADY declining while still above BB
 * C. 1h macro BB regime — only trade when 1h price is also above 1h BB
 * D. BB bandwidth percentile — trading only when BB is in "sweet spot" width range
 * E. OBV divergence proxy — cumulative volume declining while price at high
 * F. CMF (Chaikin Money Flow) negative at BB upper = distribution
 * G. Volume declining pattern — consecutive lower volume at BB extreme
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

function calcBB(candles, idx, period=20, mult=2.2) {
  if (idx < period) return null;
  const closes = candles.slice(idx - period, idx).map(c => c.c);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
  return { mid: mean, upper: mean + mult * std, lower: mean - mult * std, std, bw: 2 * mult * std / mean };
}

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

function calcROC(candles, idx, period=1) {
  if (idx < period) return 0;
  const prev = candles[idx - period].c;
  return (candles[idx].c - prev) / prev * 100;
}

// Chaikin Money Flow = sum(MFV * vol, n) / sum(vol, n)
// MFV = ((close - low) - (high - close)) / (high - low) * volume
function calcCMF(candles, idx, period=14) {
  if (idx < period) return 0;
  let mfvSum = 0, volSum = 0;
  for (let i = idx - period; i < idx; i++) {
    const range = candles[i].h - candles[i].l;
    if (range === 0) continue;
    const mfm = ((candles[i].c - candles[i].l) - (candles[i].h - candles[i].c)) / range;
    mfvSum += mfm * candles[i].v;
    volSum += candles[i].v;
  }
  if (volSum === 0) return 0;
  return mfvSum / volSum;
}

// OBV (On-Balance Volume)
function calcOBV(candles, idx, lookback=20) {
  if (idx < lookback + 1) return 0;
  let obv = 0;
  for (let i = idx - lookback; i <= idx; i++) {
    if (candles[i].c > candles[i-1].c) obv += candles[i].v;
    else if (candles[i].c < candles[i-1].c) obv -= candles[i].v;
  }
  return obv;
}

// BB bandwidth percentile over last N bars
function calcBBWidthPercentile(candles, idx, lookback=50) {
  if (idx < lookback + 20) return 50;
  const currentBW = calcBB(candles, idx)?.bw ?? 0;
  const bws = [];
  for (let i = idx - lookback; i < idx; i++) {
    const bb = calcBB(candles, i);
    if (bb) bws.push(bb.bw);
  }
  if (bws.length === 0) return 50;
  bws.sort((a, b) => a - b);
  const rank = bws.filter(x => x <= currentBW).length;
  return rank / bws.length * 100;
}

function getOutcome(candles, i, dir) {
  if (i + 1 >= candles.length) return null;
  const entry = candles[i].c, exit = candles[i+1].c;
  if (dir === 'DOWN') return exit < entry ? 1 : 0;
  return exit > entry ? 1 : 0;
}

function backtest(candles, filterFn, direction) {
  let wins = 0, total = 0;
  for (let i = 60; i < candles.length - 1; i++) {
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
// Section A: ROC enhancement (build on session27 E4 near-miss: ETH 73% WR tpd=0.34)
// Base: ROC(1)>0.3% + GH + RSI7>68 + BB22
// Try to push WR above 75% with minimal n reduction
// =============================================
console.log('\n== Section A: ROC enhancement (building on 73% near-miss) ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // A1: ROC>0.3% + GH + RSI7>70 + MFI>65 + BB22
  fmt(`A1_${coin}_ROC03_GH_RSI70_MFI65_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcROC(c, i, 1) > 0.3 && calcRSI(c, i) > 70 && calcMFI(c, i) > 65;
  }, 'DOWN'), winners);

  // A2: ROC>0.4% + GH + RSI7>68 + BB22 (higher ROC bar)
  fmt(`A2_${coin}_ROC04_GH_RSI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcROC(c, i, 1) > 0.4 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // A3: ROC>0.3% + GH + streak>=1 + BB22 (streak replaces RSI)
  fmt(`A3_${coin}_ROC03_GH_streak1_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const streak = c[i].c > c[i].o && c[i-1].c > c[i-1].o; // prev 2 bullish
    return calcROC(c, i, 1) > 0.3 && streak;
  }, 'DOWN'), winners);

  // A4: ROC>0.3% + GH + ADX<20 + BB22 (ranging regime)
  fmt(`A4_${coin}_ROC03_GH_ADX20_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcROC(c, i, 1) > 0.3 && calcADX(c, i) < 20 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // A5: ROC(2)>0.5% + GH + RSI7>70 + BB22 (2-bar momentum)
  fmt(`A5_${coin}_ROC2>0.5pct_GH_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcROC(c, i, 2) > 0.5 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // A6: ROC>0.3% sweep for ALL coins across all combinations
  for (const rocThr of [0.25, 0.35, 0.45, 0.55]) {
    const res = backtest(cs, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c < bb.upper) return false;
      const h = new Date(c[i].t).getUTCHours();
      if (!gh.includes(h)) return false;
      return calcROC(c, i, 1) > rocThr && calcRSI(c, i) > 68;
    }, 'DOWN');
    if (res && res.wr >= 0.70 && res.n >= 8) {
      fmt(`A6_${coin}_ROC>${rocThr}_GH_RSI68_BB22`, coin, res, winners);
    }
  }
}

// =============================================
// Section B: Reversal confirmation
// Candle[i-1] was ABOVE BB and closed LOWER than its open (bearish candle while overbought)
// Current candle[i] still above BB = confirmation trade
// =============================================
console.log('\n== Section B: Reversal confirmation (prior bearish candle above BB) ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // B1: Prev candle bearish + above BB, curr candle still above BB + RSI7>65
  fmt(`B1_${coin}_PrevBear_currBB22_allH`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    const bbPrev = calcBB(c, i-1);
    if (!bb || !bbPrev) return false;
    // Current still above BB upper
    if (c[i].c < bb.upper) return false;
    // Prev candle was bearish AND above BB (already started reversal)
    const prevBearish = c[i-1].c < c[i-1].o;
    const prevAboveBB = c[i-1].c >= bbPrev.upper || c[i-1].h >= bbPrev.upper;
    return prevBearish && prevAboveBB && calcRSI(c, i) > 65;
  }, 'DOWN'), winners);

  // B2: Prev candle close < open + current close LOWER than prev high (fading)
  fmt(`B2_${coin}_Fading_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 68) return false;
    // Current candle's high is LOWER than previous candle's high (momentum fading)
    return c[i].h < c[i-1].h && c[i-1].h > bb.upper;
  }, 'DOWN'), winners);

  // B3: Prev bearish + current bearish (2 consecutive bearish while still above BB)
  fmt(`B3_${coin}_2ConsecBear_BB22_RSI65`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return c[i].c < c[i].o && c[i-1].c < c[i-1].o && calcRSI(c, i) > 65;
  }, 'DOWN'), winners);

  // B4: Prev bearish + good hours + BB22 + RSI70
  fmt(`B4_${coin}_PrevBear_GH_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    const bbPrev = calcBB(c, i-1);
    if (!bb || !bbPrev) return false;
    if (c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const rsi = calcRSI(c, i);
    return c[i-1].c < c[i-1].o && (c[i-1].c >= bbPrev.upper || c[i-1].h >= bbPrev.upper) && rsi > 70;
  }, 'DOWN'), winners);

  // B5: High of current candle LOWER than high of previous candle (fading momentum) + GH
  fmt(`B5_${coin}_FadingHigh_GH_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return c[i].h < c[i-1].h && c[i-1].h >= bb.upper && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);
}

// =============================================
// Section C: Chaikin Money Flow (CMF) at BB extreme
// CMF < 0 at BB upper = selling pressure despite high price = distribution
// =============================================
console.log('\n== Section C: CMF distribution signal at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // C1: CMF < 0 + BB upper + RSI7>68 (all hours)
  fmt(`C1_${coin}_CMF<0_RSI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcCMF(c, i) < 0 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // C2: CMF < -0.05 + BB upper + RSI7>68 (stronger CMF signal)
  fmt(`C2_${coin}_CMF<-0.05_RSI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcCMF(c, i) < -0.05 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // C3: CMF < 0 + good hours + BB22
  fmt(`C3_${coin}_CMF<0_GH_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcCMF(c, i) < 0 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // C4: CMF < 0 + MFI>68 (CMF disagrees with MFI = confusion state → reversal)
  fmt(`C4_${coin}_CMF<0_MFI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcCMF(c, i) < 0 && calcMFI(c, i) > 68 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);
}

// =============================================
// Section D: BB bandwidth percentile filter
// Trade only when BB width is in "sweet spot" (20th-60th percentile)
// = not too narrow (no signal), not too wide (trending)
// =============================================
console.log('\n== Section D: BB bandwidth percentile filter ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // D1: BB width in 20th-60th percentile + RSI7>70 + BB upper (all hours)
  fmt(`D1_${coin}_BBwidthP20-60_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const pct = calcBBWidthPercentile(c, i);
    return pct >= 20 && pct <= 60 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // D2: BB width in 20th-60th percentile + good hours + RSI70
  fmt(`D2_${coin}_BBwidthP20-60_GH_RSI70`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const pct = calcBBWidthPercentile(c, i);
    return pct >= 20 && pct <= 60 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // D3: BB width 30-70th percentile + MFI>68 + BB upper
  fmt(`D3_${coin}_BBwidthP30-70_MFI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const pct = calcBBWidthPercentile(c, i);
    return pct >= 30 && pct <= 70 && calcMFI(c, i) > 68 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);
}

// =============================================
// Section E: OBV divergence proxy
// Price at new N-bar high but OBV(20) declining = negative divergence
// =============================================
console.log('\n== Section E: OBV divergence at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // E1: OBV(20) at current < OBV(20) at prev peak + BB upper + RSI70
  fmt(`E1_${coin}_OBVdecline_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 25) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 70) return false;
    // OBV(20) should be declining relative to 5 bars ago
    const obvNow = calcOBV(c, i, 20);
    const obvPrev = calcOBV(c, i - 5, 20);
    return obvNow < obvPrev && c[i].c >= c[i-5].c; // price up but OBV down
  }, 'DOWN'), winners);

  // E2: OBV declining + good hours + BB22
  fmt(`E2_${coin}_OBVdecline_GH_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 25) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 68) return false;
    const obvNow = calcOBV(c, i, 20);
    const obvPrev = calcOBV(c, i - 5, 20);
    return obvNow < obvPrev;
  }, 'DOWN'), winners);
}

// =============================================
// Section F: Volume declining pattern
// Decreasing volume during upward push = weakening momentum → reversal
// =============================================
console.log('\n== Section F: Volume declining at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // F1: Vol[i] < Vol[i-1] < Vol[i-2] (3 declining volumes) + BB upper + RSI70
  fmt(`F1_${coin}_3VolDecline_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 2) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return c[i].v < c[i-1].v && c[i-1].v < c[i-2].v && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // F2: Current vol < avg vol (below average) + BB upper + RSI70
  fmt(`F2_${coin}_BelowAvgVol_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 20) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const avgVol = cs.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
    return c[i].v < avgVol * 0.8 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // F3: 3 declining volumes + good hours + BB22
  fmt(`F3_${coin}_3VolDecline_GH_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 2) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return c[i].v < c[i-1].v && c[i-1].v < c[i-2].v && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // F4: Vol spike on prev candle then drop (vol exhaustion) + BB22
  fmt(`F4_${coin}_VolExhaustion_GH_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 3) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const avgVol = cs.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
    // Prev candle had spike (>2x avg), current candle dropped back
    return c[i-1].v > avgVol * 1.8 && c[i].v < c[i-1].v * 0.6 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);
}

// =============================================
// Section G: 1h macro regime — only trade when 5m at BB extreme
// AND 1h candle is also showing extreme (proxy using 12-bar 5m = 1h data)
// Build synthetic 1h from 12 consecutive 5m candles
// =============================================
console.log('\n== Section G: 1h macro regime (synthetic from 5m) ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // Build synthetic 1h candles: every 12 5m candles
  function get1hClose(c, idx) {
    // Find the latest complete 12-candle block
    const blockStart = Math.floor(idx / 12) * 12;
    if (blockStart < 12) return null;
    return c[blockStart - 1].c; // close of most recent complete 1h candle
  }

  function calc1hRSI(c, idx) {
    // Build 1h closes from 5m data
    const h1closes = [];
    for (let j = 0; j <= idx; j += 12) {
      h1closes.push(c[j + 11 < c.length ? j + 11 : c.length - 1].c);
    }
    if (h1closes.length < 8) return 50;
    let g = 0, l = 0;
    for (let k = h1closes.length - 7; k < h1closes.length; k++) {
      const d = h1closes[k] - h1closes[k-1];
      if (d > 0) g += d; else l -= d;
    }
    if (l === 0) return 100;
    return 100 - 100 / (1 + g / l);
  }

  // G1: 5m RSI7>70 + BB22 + synthetic 1h RSI7>62 (both TF elevated) + GH
  fmt(`G1_${coin}_5mBB22_1hRSI62_GH`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const rsi5m = calcRSI(c, i);
    if (rsi5m < 68) return false;
    const rsi1h = calc1hRSI(c, i);
    return rsi1h > 62;
  }, 'DOWN'), winners);

  // G2: 5m RSI7>70 + BB22 + synthetic 1h RSI7>65 + all hours
  fmt(`G2_${coin}_5mBB22_RSI70_1hRSI65_allH`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi5m = calcRSI(c, i);
    if (rsi5m < 70) return false;
    const rsi1h = calc1hRSI(c, i);
    return rsi1h > 65;
  }, 'DOWN'), winners);
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

db.close();
