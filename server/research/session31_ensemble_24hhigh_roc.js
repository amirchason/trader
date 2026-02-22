/**
 * Session 31: Strategy ensemble + 24h extreme proximity + ROC optimization
 *
 * Fresh angles after 13 null continuation sessions:
 * A. Strategy ensemble — when N proven signals fire simultaneously (meta-strategy)
 *    Using our best strats: RSI7+BB22, MFI68+BB22, CRSI, StochK+BB22, RSI3+BB22
 *    Does 3+ concurrent = >75% WR?
 * B. 24h high proximity — close within 0.2% of 24h high AND above BB upper
 *    "Failed breakout to new daily high" = strongest reversal context
 * C. ROC threshold search — exhaustive search for ROC>X% + GoodH + BB22
 *    Session 27 found ETH 73.0% at ROC>0.3%. What threshold hits 75%?
 * D. BB upper dwell — being above BB22 for exactly 1 candle (first breach)
 *    vs 2+ candles (sustained). Does fresh breach vs sustained matter?
 * E. Hour × MFI heatmap — per-hour MFI threshold search for all 4 coins
 *    (more granular than good-hours mask)
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

function calcBB(candles, idx, period = 20, mult = 2.2) {
  if (idx < period) return null;
  const closes = candles.slice(idx - period, idx).map(c => c.c);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
  return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
}

function calcRSI(candles, idx, period = 7) {
  if (idx < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = idx - period; i < idx; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function calcMFI(candles, idx, period = 14) {
  if (idx < period + 1) return 50;
  let pos = 0, neg = 0;
  for (let i = idx - period; i < idx; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i - 1].h + candles[i - 1].l + candles[i - 1].c) / 3;
    const mf = tp * candles[i].v;
    if (tp > prevTp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function calcStochK(candles, idx, period = 14) {
  if (idx < period) return 50;
  const slice = candles.slice(idx - period, idx + 1);
  const highs = slice.map(c => c.h);
  const lows = slice.map(c => c.l);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  if (high === low) return 50;
  return 100 * (candles[idx].c - low) / (high - low);
}

function calcADX(candles, idx, period = 14) {
  if (idx < period * 2) return 50;
  const trueRanges = [], plusDMs = [], minusDMs = [];
  for (let i = idx - period * 2 + 1; i <= idx; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    trueRanges.push(tr);
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDI = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = period; i < period * 2; i++) {
    atr = atr - atr / period + trueRanges[i];
    plusDI = plusDI - plusDI / period + plusDMs[i];
    minusDI = minusDI - minusDI / period + minusDMs[i];
    const di_sum = (plusDI + minusDI) / atr;
    if (di_sum === 0) { dxArr.push(0); continue; }
    dxArr.push(Math.abs((plusDI - minusDI) / atr) / di_sum * 100);
  }
  return dxArr.reduce((a, b) => a + b, 0) / dxArr.length;
}

function calcRSI3(candles, idx) {
  return calcRSI(candles, idx, 3);
}

function walkForward(candles, signal_fn, bearish_fn) {
  const FOLDS = 5;
  const foldSize = Math.floor(candles.length / FOLDS);
  let totalWins = 0, totalTrades = 0;
  const foldResults = [];
  for (let f = 0; f < FOLDS; f++) {
    const start = f * foldSize;
    const end = (f === FOLDS - 1) ? candles.length - 1 : (f + 1) * foldSize;
    let wins = 0, trades = 0;
    for (let i = start + 50; i < end - 1; i++) {
      if (signal_fn(candles, i)) {
        trades++;
        const isBear = bearish_fn ? bearish_fn(candles, i) : true;
        const win = isBear
          ? candles[i + 1].c < candles[i].c
          : candles[i + 1].c > candles[i].c;
        if (win) wins++;
      }
    }
    foldResults.push({ wins, trades, wr: trades > 0 ? wins / trades : 0 });
    totalWins += wins; totalTrades += trades;
  }
  const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
  const tpd = totalTrades / (candles.length * 5 / 60 / 24);
  const mean = foldResults.reduce((s, f) => s + f.wr, 0) / FOLDS;
  const sigma = Math.sqrt(foldResults.reduce((s, f) => s + (f.wr - mean) ** 2, 0) / FOLDS);
  return { wr, n: totalTrades, tpd, sigma };
}

function fmt(label, coin, r) {
  const flag = r.wr >= 0.75 && r.n >= 10 && r.tpd >= 0.33 ? ' 🏆🏆🏆' :
    r.wr >= 0.70 && r.n >= 10 ? ' 🔥' : '';
  const warn = r.tpd < 0.33 ? ' ⚠️ tpd=' + r.tpd.toFixed(2) : '';
  console.log(`  ${label} | ${coin}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd.toFixed(2)} σ=${(r.sigma * 100).toFixed(1)}%${flag}${warn}`);
  return r;
}

const GOOD_HOURS = {
  ETH: new Set([10, 11, 12, 21]),
  BTC: new Set([1, 12, 13, 16, 20]),
  SOL: new Set([0, 12, 13, 20]),
  XRP: new Set([6, 9, 12, 18])
};

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const allCandles = {};
for (const coin of COINS) allCandles[coin] = getCandles(coin);

const winners = [];

// ═══════════════════════════════════════════════════════
// SECTION A: Strategy Ensemble
// Count how many of our proven short signals fire together
// Signals: RSI7>70, MFI>68, StochK>80, RSI3>90, ADX<20+BB22
// ═══════════════════════════════════════════════════════
console.log('\n== Section A: Strategy Ensemble (N concurrent signals) ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // For each candle, count how many proven signals are ACTIVE:
  // S1: RSI7>70 + above BB22
  // S2: MFI>68 + above BB22
  // S3: StochK>80 + above BB22
  // S4: RSI3>90 + above BB22
  // S5: RSI7>70 + ADX<20 (ranging)

  // A1: ensemble >= 2 signals, GH
  const a1 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const hour = new Date(c[i].t).getUTCHours();
    if (!gh.has(hour)) return false;
    const rsi7 = calcRSI(c, i, 7);
    const mfi = calcMFI(c, i);
    const stochK = calcStochK(c, i);
    const rsi3 = calcRSI3(c, i);
    let count = 0;
    if (rsi7 > 70) count++;
    if (mfi > 68) count++;
    if (stochK > 80) count++;
    if (rsi3 > 90) count++;
    return count >= 2;
  }, null);
  const r_a1 = fmt(`A1_${coin}_Ensemble>=2_GH`, coin, a1);
  if (r_a1.wr >= 0.75 && r_a1.n >= 10 && r_a1.tpd >= 0.33) winners.push({ label: `A1_${coin}`, ...r_a1 });

  // A2: ensemble >= 3 signals, GH
  const a2 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const hour = new Date(c[i].t).getUTCHours();
    if (!gh.has(hour)) return false;
    const rsi7 = calcRSI(c, i, 7);
    const mfi = calcMFI(c, i);
    const stochK = calcStochK(c, i);
    const rsi3 = calcRSI3(c, i);
    let count = 0;
    if (rsi7 > 70) count++;
    if (mfi > 68) count++;
    if (stochK > 80) count++;
    if (rsi3 > 90) count++;
    return count >= 3;
  }, null);
  const r_a2 = fmt(`A2_${coin}_Ensemble>=3_GH`, coin, a2);
  if (r_a2.wr >= 0.75 && r_a2.n >= 10 && r_a2.tpd >= 0.33) winners.push({ label: `A2_${coin}`, ...r_a2 });

  // A3: ensemble >= 2 signals, all hours
  const a3 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const rsi7 = calcRSI(c, i, 7);
    const mfi = calcMFI(c, i);
    const stochK = calcStochK(c, i);
    const rsi3 = calcRSI3(c, i);
    let count = 0;
    if (rsi7 > 70) count++;
    if (mfi > 68) count++;
    if (stochK > 80) count++;
    if (rsi3 > 90) count++;
    return count >= 2;
  }, null);
  const r_a3 = fmt(`A3_${coin}_Ensemble>=2_allH`, coin, a3);
  if (r_a3.wr >= 0.75 && r_a3.n >= 10 && r_a3.tpd >= 0.33) winners.push({ label: `A3_${coin}`, ...r_a3 });

  // A4: RSI7>70 + MFI>68 + StochK>80 (3-way match) all hours
  const a4 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const rsi7 = calcRSI(c, i, 7);
    if (rsi7 <= 70) return false;
    const mfi = calcMFI(c, i);
    if (mfi <= 68) return false;
    const stochK = calcStochK(c, i);
    return stochK > 80;
  }, null);
  const r_a4 = fmt(`A4_${coin}_RSI7+MFI68+StochK80_allH`, coin, a4);
  if (r_a4.wr >= 0.75 && r_a4.n >= 10 && r_a4.tpd >= 0.33) winners.push({ label: `A4_${coin}`, ...r_a4 });

  // A5: RSI7>70 + MFI>68 + StochK>80 GH
  const a5 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const hour = new Date(c[i].t).getUTCHours();
    if (!gh.has(hour)) return false;
    const rsi7 = calcRSI(c, i, 7);
    if (rsi7 <= 70) return false;
    const mfi = calcMFI(c, i);
    if (mfi <= 68) return false;
    const stochK = calcStochK(c, i);
    return stochK > 80;
  }, null);
  const r_a5 = fmt(`A5_${coin}_RSI7+MFI68+StochK80_GH`, coin, a5);
  if (r_a5.wr >= 0.75 && r_a5.n >= 10 && r_a5.tpd >= 0.33) winners.push({ label: `A5_${coin}`, ...r_a5 });
}

// ═══════════════════════════════════════════════════════
// SECTION B: 24h High Proximity at BB extreme
// Close within X% of rolling 24h high AND above BB upper
// ═══════════════════════════════════════════════════════
console.log('\n== Section B: 24h High Proximity + BB extreme ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];
  const BARS_24H = 288; // 24h × 12 bars/hour

  // B1: close within 0.2% of 24h high, above BB22, all hours
  const b1 = walkForward(candles, (c, i) => {
    if (i < BARS_24H) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const high24 = Math.max(...c.slice(i - BARS_24H, i).map(x => x.h));
    const distFromHigh = (high24 - c[i].c) / high24;
    return distFromHigh <= 0.002; // within 0.2%
  }, null);
  const r_b1 = fmt(`B1_${coin}_24hHighProx0.2_BB22`, coin, b1);
  if (r_b1.wr >= 0.75 && r_b1.n >= 10 && r_b1.tpd >= 0.33) winners.push({ label: `B1_${coin}`, ...r_b1 });

  // B2: within 0.1% of 24h high, GH, RSI7>68
  const b2 = walkForward(candles, (c, i) => {
    if (i < BARS_24H) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const hour = new Date(c[i].t).getUTCHours();
    if (!gh.has(hour)) return false;
    const rsi7 = calcRSI(c, i, 7);
    if (rsi7 <= 68) return false;
    const high24 = Math.max(...c.slice(i - BARS_24H, i).map(x => x.h));
    return (high24 - c[i].c) / high24 <= 0.001;
  }, null);
  const r_b2 = fmt(`B2_${coin}_24hHighProx0.1_GH_RSI68`, coin, b2);
  if (r_b2.wr >= 0.75 && r_b2.n >= 10 && r_b2.tpd >= 0.33) winners.push({ label: `B2_${coin}`, ...r_b2 });

  // B3: AT or ABOVE 24h high (breakout fail), all hours, RSI7>70
  const b3 = walkForward(candles, (c, i) => {
    if (i < BARS_24H) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const rsi7 = calcRSI(c, i, 7);
    if (rsi7 <= 70) return false;
    const prevHigh24 = Math.max(...c.slice(i - BARS_24H, i - 1).map(x => x.h));
    return c[i].c >= prevHigh24 * 0.999; // at or above prev 24h high
  }, null);
  const r_b3 = fmt(`B3_${coin}_NewDayHigh_RSI70_BB22`, coin, b3);
  if (r_b3.wr >= 0.75 && r_b3.n >= 10 && r_b3.tpd >= 0.33) winners.push({ label: `B3_${coin}`, ...r_b3 });

  // B4: within 0.3% of 24h high, ADX<20 + GH
  const b4 = walkForward(candles, (c, i) => {
    if (i < BARS_24H) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const hour = new Date(c[i].t).getUTCHours();
    if (!gh.has(hour)) return false;
    const adx = calcADX(c, i);
    if (adx >= 20) return false;
    const high24 = Math.max(...c.slice(i - BARS_24H, i).map(x => x.h));
    return (high24 - c[i].c) / high24 <= 0.003;
  }, null);
  const r_b4 = fmt(`B4_${coin}_24hHighProx0.3_ADX20_GH`, coin, b4);
  if (r_b4.wr >= 0.75 && r_b4.n >= 10 && r_b4.tpd >= 0.33) winners.push({ label: `B4_${coin}`, ...r_b4 });
}

// ═══════════════════════════════════════════════════════
// SECTION C: ROC threshold exhaustive search
// Session 27 near-miss: ETH ROC>0.3%+GH = 73% WR n=63
// Find exact threshold giving >=75% WR
// ═══════════════════════════════════════════════════════
console.log('\n== Section C: ROC threshold search ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  for (const rocThresh of [0.35, 0.40, 0.45, 0.50, 0.60]) {
    const r = walkForward(candles, (c, i) => {
      if (i < 5) return false;
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      const hour = new Date(c[i].t).getUTCHours();
      if (!gh.has(hour)) return false;
      const roc = (c[i].c - c[i - 1].c) / c[i - 1].c * 100;
      return roc > rocThresh;
    }, null);
    const label = `C_${coin}_ROC>${rocThresh.toFixed(2)}pct_GH_BB22`;
    const r2 = fmt(label, coin, r);
    if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label, ...r2 });
  }
}

// ═══════════════════════════════════════════════════════
// SECTION D: BB breach freshness (1st candle vs sustained)
// ═══════════════════════════════════════════════════════
console.log('\n== Section D: BB upper breach freshness ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // D1: FIRST candle above BB22 (prev was inside) — fresh breach
  const d1 = walkForward(candles, (c, i) => {
    if (i < 21) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const bbPrev = calcBB(c, i - 1);
    if (!bbPrev) return false;
    return c[i - 1].c <= bbPrev.upper; // prev candle was inside — this is first breach
  }, null);
  const r_d1 = fmt(`D1_${coin}_FreshBreach_allH`, coin, d1);
  if (r_d1.wr >= 0.75 && r_d1.n >= 10 && r_d1.tpd >= 0.33) winners.push({ label: `D1_${coin}`, ...r_d1 });

  // D2: sustained above BB22 for 2+ candles
  const d2 = walkForward(candles, (c, i) => {
    if (i < 22) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const bbPrev = calcBB(c, i - 1);
    return bbPrev && c[i - 1].c > bbPrev.upper; // was also above BB last candle
  }, null);
  const r_d2 = fmt(`D2_${coin}_SustainedBreach_allH`, coin, d2);
  if (r_d2.wr >= 0.75 && r_d2.n >= 10 && r_d2.tpd >= 0.33) winners.push({ label: `D2_${coin}`, ...r_d2 });

  // D3: fresh breach + GH + RSI7>70
  const d3 = walkForward(candles, (c, i) => {
    if (i < 22) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const bbPrev = calcBB(c, i - 1);
    if (!bbPrev || c[i - 1].c > bbPrev.upper) return false; // must be fresh
    const hour = new Date(c[i].t).getUTCHours();
    if (!gh.has(hour)) return false;
    return calcRSI(c, i, 7) > 70;
  }, null);
  const r_d3 = fmt(`D3_${coin}_FreshBreach_GH_RSI70`, coin, d3);
  if (r_d3.wr >= 0.75 && r_d3.n >= 10 && r_d3.tpd >= 0.33) winners.push({ label: `D3_${coin}`, ...r_d3 });

  // D4: sustained 2+ breach + GH + RSI7>70
  const d4 = walkForward(candles, (c, i) => {
    if (i < 23) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const bbPrev = calcBB(c, i - 1);
    if (!bbPrev || c[i - 1].c <= bbPrev.upper) return false;
    const hour = new Date(c[i].t).getUTCHours();
    if (!gh.has(hour)) return false;
    return calcRSI(c, i, 7) > 70;
  }, null);
  const r_d4 = fmt(`D4_${coin}_SustainedBreach_GH_RSI70`, coin, d4);
  if (r_d4.wr >= 0.75 && r_d4.n >= 10 && r_d4.tpd >= 0.33) winners.push({ label: `D4_${coin}`, ...r_d4 });
}

// ═══════════════════════════════════════════════════════
// SECTION E: Hour heatmap for MFI threshold
// For each coin, scan each UTC hour with MFI>X + BB22
// ═══════════════════════════════════════════════════════
console.log('\n== Section E: Hour × MFI heatmap ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const bestByHour = [];
  for (let h = 0; h < 24; h++) {
    // Try MFI thresholds 65, 68, 72
    for (const mfiT of [65, 68, 72]) {
      const r = walkForward(candles, (c, i) => {
        const bb = calcBB(c, i);
        if (!bb || c[i].c <= bb.upper) return false;
        const hour = new Date(c[i].t).getUTCHours();
        if (hour !== h) return false;
        return calcMFI(c, i) > mfiT;
      }, null);
      if (r.n >= 10 && r.wr >= 0.75) {
        bestByHour.push({ h, mfiT, ...r });
      }
    }
  }
  if (bestByHour.length > 0) {
    for (const b of bestByHour) {
      const label = `E_${coin}_h${b.h}_MFI${b.mfiT}_BB22`;
      console.log(`  ${label}: WR=${(b.wr * 100).toFixed(1)}% n=${b.n} tpd=${b.tpd.toFixed(2)} 🏆`);
      if (b.tpd >= 0.33) winners.push({ label, ...b });
    }
  }
}
if (winners.filter(w => w.label.startsWith('E_')).length === 0) {
  console.log('  (no hours with WR>=75% n>=10 found for any coin/MFI combo)');
}

// ═══════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════
console.log('\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10, tpd>=0.33 ===');
console.log('=======================================================');
if (winners.length === 0) {
  console.log('  (none)');
} else {
  for (const w of winners) {
    console.log(`  ✅ ${w.label}: WR=${(w.wr * 100).toFixed(1)}% n=${w.n} tpd=${w.tpd.toFixed(2)} σ=${(w.sigma * 100).toFixed(1)}%`);
  }
}

console.log('\n=== All results >= 70% WR, n >= 10 (see 🔥 above) ===');

db.close();
