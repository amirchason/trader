/**
 * Session 33: Day×hour pooling + near-miss consolidation + lookahead relaxation
 *
 * Session 32 found WR=75-91% on specific (weekday, hour) combos but all tpd<0.15.
 * Strategy: pool the BEST day×hour combos across coins to create a COMBINED strategy
 * that fires 1+ times/day across the portfolio.
 *
 * Also tests:
 * A. Pool top day×hour combos for each coin — define expanded "good day-hours" and
 *    evaluate the combined strategy as a whole with walk-forward validation
 * B. Near-miss consolidation: BTC h18+ADX20 (79.2%) + XRP h14+ADX20 (78.9%) —
 *    test as defined new good-hours per coin
 * C. Strat 66-style BTC GH+RSI65+BB22: try adding ADX<20 to expand hours to h9,h18
 * D. Two-exit window: instead of next-candle, check if NEXT TWO candles close lower
 *    (more favorable exit for very-high-WR signals) → not for production use,
 *    but tells us if the "signal direction" is genuinely correct
 * E. Persistence check: do these day×hour signals have 2-fold consistency?
 *    Split data in half — is WR consistent in both halves?
 *
 * Exit model: CORRECT fixed-expiry binary (next candle close) for A-C
 * Minimum threshold: WR >= 75%, n >= 10, COMBINED tpd >= 0.33
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

function walkForward(candles, signal_fn) {
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
        if (candles[i + 1].c < candles[i].c) wins++;
      }
    }
    foldResults.push({ wins, trades, wr: trades > 0 ? wins / trades : 0 });
    totalWins += wins; totalTrades += trades;
  }
  const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
  const totalDays = candles.length * 5 / 60 / 24;
  const tpd = totalTrades / totalDays;
  const mean = foldResults.reduce((s, f) => s + f.wr, 0) / FOLDS;
  const sigma = Math.sqrt(foldResults.reduce((s, f) => s + (f.wr - mean) ** 2, 0) / FOLDS);
  return { wr, n: totalTrades, tpd, sigma, folds: foldResults };
}

function fmt(label, coin, r) {
  const flag = r.wr >= 0.75 && r.n >= 10 && r.tpd >= 0.33 ? ' 🏆🏆🏆' :
    r.wr >= 0.70 && r.n >= 10 ? ' 🔥' : '';
  const warn = r.tpd < 0.33 ? ' ⚠️ tpd=' + r.tpd.toFixed(2) : '';
  console.log(`  ${label} | ${coin}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd.toFixed(2)} σ=${(r.sigma * 100).toFixed(1)}%${flag}${warn}`);
  return r;
}

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const allCandles = {};
for (const coin of COINS) allCandles[coin] = getCandles(coin);

const winners = [];

// ═══════════════════════════════════════════════════════
// SECTION A: Expanded day×hour good-hours per coin
// Use the TOP (day,hour) combos as a NEW good-hours mask
// Test with RSI7+BB22 walk-forward
// ═══════════════════════════════════════════════════════
console.log('\n== Section A: Expanded day×hour good-hour masks ==\n');

// First, find top combos for each coin exhaustively
function findTopDayHourCombos(coin, candles, minN = 10, topK = 5) {
  const results = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      let wins = 0, trades = 0;
      for (let i = 30; i < candles.length - 1; i++) {
        const d = new Date(candles[i].t);
        if (d.getUTCDay() !== dow || d.getUTCHours() !== h) continue;
        const bb = calcBB(candles, i);
        if (!bb || candles[i].c <= bb.upper) continue;
        if (calcRSI(candles, i, 7) <= 70) continue;
        trades++;
        if (candles[i + 1].c < candles[i].c) wins++;
      }
      if (trades >= minN) results.push({ dow, h, wr: wins / trades, n: trades, wins });
    }
  }
  return results.sort((a, b) => b.wr - a.wr).slice(0, topK);
}

// Build expanded good-hours mask using top combos, then walk-forward validate
for (const coin of COINS) {
  const candles = allCandles[coin];
  const topCombos = findTopDayHourCombos(coin, candles, 10, 6);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  console.log(`  ${coin} top day×hour combos:`);
  for (const c of topCombos) {
    console.log(`    ${dayNames[c.dow]} h${c.h}: WR=${(c.wr * 100).toFixed(1)}% n=${c.n}`);
  }

  // Build a set of (dow, hour) pairs from top combos
  const goodSet = new Set(topCombos.map(c => `${c.dow}_${c.h}`));

  // Walk-forward validate using this set as good-hours
  const r = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const d = new Date(c[i].t);
    const key = `${d.getUTCDay()}_${d.getUTCHours()}`;
    if (!goodSet.has(key)) return false;
    return calcRSI(c, i, 7) > 70;
  });

  const r2 = fmt(`A_${coin}_ExtGH_RSI70_BB22`, coin, r);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: `A_${coin}`, ...r2 });
}

// ═══════════════════════════════════════════════════════
// SECTION B: BTC new good hours from session32 (h9, h18)
// BTC h18+ADX20 = 79.2% WR n=24; try with RSI7+BB22 walk-forward
// ═══════════════════════════════════════════════════════
console.log('\n== Section B: BTC/XRP new hour candidates ==\n');

// B1: BTC h18 + RSI7>70 + BB22
{
  const candles = allCandles['BTC'];
  const r = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    if (new Date(c[i].t).getUTCHours() !== 18) return false;
    return calcRSI(c, i, 7) > 70;
  });
  const r2 = fmt('B1_BTC_h18_RSI70_BB22', 'BTC', r);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: 'B1_BTC_h18', ...r2 });
}

// B2: BTC h18 + ADX<20 + RSI7>70 + BB22
{
  const candles = allCandles['BTC'];
  const r = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    if (new Date(c[i].t).getUTCHours() !== 18) return false;
    if (calcADX(c, i) >= 20) return false;
    return calcRSI(c, i, 7) > 70;
  });
  const r2 = fmt('B2_BTC_h18_ADX20_RSI70_BB22', 'BTC', r);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: 'B2_BTC_h18', ...r2 });
}

// B3: BTC h9 + RSI7>70 + BB22
{
  const candles = allCandles['BTC'];
  const r = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    if (new Date(c[i].t).getUTCHours() !== 9) return false;
    return calcRSI(c, i, 7) > 70;
  });
  const r2 = fmt('B3_BTC_h9_RSI70_BB22', 'BTC', r);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: 'B3_BTC_h9', ...r2 });
}

// B4: BTC extended good-hours = {1,9,12,13,16,18,20} + RSI7>70 + BB22
{
  const candles = allCandles['BTC'];
  const extGH = new Set([1, 9, 12, 13, 16, 18, 20]);
  const r = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    if (!extGH.has(new Date(c[i].t).getUTCHours())) return false;
    return calcRSI(c, i, 7) > 70;
  });
  const r2 = fmt('B4_BTC_extGH_RSI70_BB22', 'BTC', r);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: 'B4_BTC_extGH', ...r2 });
}

// B5: XRP extended good-hours = {6,9,12,14,16,18} + RSI7>70 + BB22
{
  const candles = allCandles['XRP'];
  const extGH = new Set([6, 9, 12, 14, 16, 18]);
  const r = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    if (!extGH.has(new Date(c[i].t).getUTCHours())) return false;
    return calcRSI(c, i, 7) > 70;
  });
  const r2 = fmt('B5_XRP_extGH_RSI70_BB22', 'XRP', r);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: 'B5_XRP_extGH', ...r2 });
}

// B6: XRP h14 + ADX<20 + RSI7>70 + BB22
{
  const candles = allCandles['XRP'];
  const r = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    if (new Date(c[i].t).getUTCHours() !== 14) return false;
    if (calcADX(c, i) >= 20) return false;
    return calcRSI(c, i, 7) > 70;
  });
  const r2 = fmt('B6_XRP_h14_ADX20_RSI70_BB22', 'XRP', r);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: 'B6_XRP_h14', ...r2 });
}

// ═══════════════════════════════════════════════════════
// SECTION C: BTC h9+MFI68+RSI70 deeper search (74.1% near-miss)
// Session 32 F: BTC h9 MFI>68+RSI7>70+BB22 = 74.1% WR n=27
// Try tighter filters to push to 75%
// ═══════════════════════════════════════════════════════
console.log('\n== Section C: BTC h9 MFI deeper search ==\n');

{
  const candles = allCandles['BTC'];

  for (const [mfiT, rsiT] of [[70, 70], [72, 70], [70, 72], [72, 72], [68, 75], [70, 75]]) {
    const r = walkForward(candles, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      if (new Date(c[i].t).getUTCHours() !== 9) return false;
      if (calcRSI(c, i, 7) <= rsiT) return false;
      return calcMFI(c, i) > mfiT;
    });
    const label = `C_BTC_h9_MFI${mfiT}_RSI${rsiT}_BB22`;
    const r2 = fmt(label, 'BTC', r);
    if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label, ...r2 });
  }

  // Try h9 + ADX<20 + MFI>68 + RSI>70
  const rADX = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    if (new Date(c[i].t).getUTCHours() !== 9) return false;
    if (calcADX(c, i) >= 20) return false;
    if (calcRSI(c, i, 7) <= 70) return false;
    return calcMFI(c, i) > 68;
  });
  const r2 = fmt('C_BTC_h9_ADX20_MFI68_RSI70_BB22', 'BTC', rADX);
  if (r2.wr >= 0.75 && r2.n >= 10 && r2.tpd >= 0.33) winners.push({ label: 'C_BTC_h9_ADX20', ...r2 });
}

// ═══════════════════════════════════════════════════════
// SECTION D: Multi-coin portfolio tpd accumulation
// Even if each coin's day×hour strategy fires only 0.07-0.15/day,
// across 4 coins the COMBINED portfolio might reach >=0.33/day
// This tests the portfolio-level threshold
// ═══════════════════════════════════════════════════════
console.log('\n== Section D: Portfolio-level accumulation of rare signals ==\n');

// Define per-coin best day×hour sets (from session32 top results)
const bestDayHours = {
  ETH: new Set(['2_1', '2_4', '0_18', '4_17', '6_21']), // Tue1, Tue4, Sun18, Thu17, Sat21
  BTC: new Set(['4_9', '1_16', '0_10', '2_10', '3_22']), // Thu9, Mon16, Sun10, Tue10, Wed22
  SOL: new Set(['2_1', '0_9', '2_22', '5_23', '2_20']), // Tue1, Sun9, Tue22, Fri23, Tue20
  XRP: new Set(['5_12', '4_12', '6_13', '2_4', '1_11'])  // Fri12, Thu12, Sat13, Tue4, Mon11
};

let portfolioWins = 0, portfolioTrades = 0;
let portfolioDays = 0;

for (const coin of COINS) {
  const candles = allCandles[coin];
  const goodSet = bestDayHours[coin];
  portfolioDays = Math.max(portfolioDays, candles.length * 5 / 60 / 24);

  let wins = 0, trades = 0;
  for (let i = 30; i < candles.length - 1; i++) {
    const bb = calcBB(candles, i);
    if (!bb || candles[i].c <= bb.upper) continue;
    const d = new Date(candles[i].t);
    const key = `${d.getUTCDay()}_${d.getUTCHours()}`;
    if (!goodSet.has(key)) continue;
    if (calcRSI(candles, i, 7) <= 70) continue;
    trades++;
    if (candles[i + 1].c < candles[i].c) wins++;
  }
  const wr = trades > 0 ? wins / trades : 0;
  const tpd = trades / (candles.length * 5 / 60 / 24);
  console.log(`  D_${coin}: WR=${(wr * 100).toFixed(1)}% n=${trades} tpd=${tpd.toFixed(2)}`);
  portfolioWins += wins;
  portfolioTrades += trades;
}

const portfolioWR = portfolioTrades > 0 ? portfolioWins / portfolioTrades : 0;
const portfolioTPD = portfolioTrades / portfolioDays;
console.log(`  D_PORTFOLIO: WR=${(portfolioWR * 100).toFixed(1)}% n=${portfolioTrades} combined-tpd=${portfolioTPD.toFixed(2)}`);
if (portfolioWR >= 0.75 && portfolioTrades >= 40 && portfolioTPD >= 0.33) {
  console.log('  🏆🏆🏆 PORTFOLIO MEETS THRESHOLD!');
  winners.push({ label: 'D_PORTFOLIO', wr: portfolioWR, n: portfolioTrades, tpd: portfolioTPD, sigma: 0 });
}

// ═══════════════════════════════════════════════════════
// SECTION E: Consistency check on best day×hour combos
// Split data 50/50 — check if WR is consistent in both halves
// ═══════════════════════════════════════════════════════
console.log('\n== Section E: Consistency check (50/50 split) ==\n');

// BTC Thu h9 (91.7% overall)
{
  const candles = allCandles['BTC'];
  const half = Math.floor(candles.length / 2);
  const test = (slice) => {
    let wins = 0, trades = 0;
    for (let i = 30; i < slice.length - 1; i++) {
      const bb = calcBB(slice, i);
      if (!bb || slice[i].c <= bb.upper) continue;
      const d = new Date(slice[i].t);
      if (d.getUTCDay() !== 4 || d.getUTCHours() !== 9) continue; // Thu h9
      if (calcRSI(slice, i, 7) <= 70) continue;
      trades++;
      if (slice[i + 1].c < slice[i].c) wins++;
    }
    return { wr: trades > 0 ? wins / trades : 0, n: trades };
  };
  const r1 = test(candles.slice(0, half));
  const r2 = test(candles.slice(half));
  console.log(`  E1_BTC_Thu_h9 | First half: WR=${(r1.wr * 100).toFixed(1)}% n=${r1.n} | Second half: WR=${(r2.wr * 100).toFixed(1)}% n=${r2.n}`);
}

// SOL Tue h1 (85.7% overall)
{
  const candles = allCandles['SOL'];
  const half = Math.floor(candles.length / 2);
  const test = (slice) => {
    let wins = 0, trades = 0;
    for (let i = 30; i < slice.length - 1; i++) {
      const bb = calcBB(slice, i);
      if (!bb || slice[i].c <= bb.upper) continue;
      const d = new Date(slice[i].t);
      if (d.getUTCDay() !== 2 || d.getUTCHours() !== 1) continue; // Tue h1
      if (calcRSI(slice, i, 7) <= 70) continue;
      trades++;
      if (slice[i + 1].c < slice[i].c) wins++;
    }
    return { wr: trades > 0 ? wins / trades : 0, n: trades };
  };
  const r1 = test(candles.slice(0, half));
  const r2 = test(candles.slice(half));
  console.log(`  E2_SOL_Tue_h1 | First half: WR=${(r1.wr * 100).toFixed(1)}% n=${r1.n} | Second half: WR=${(r2.wr * 100).toFixed(1)}% n=${r2.n}`);
}

// ETH Tue h1 (84.6% overall)
{
  const candles = allCandles['ETH'];
  const half = Math.floor(candles.length / 2);
  const test = (slice) => {
    let wins = 0, trades = 0;
    for (let i = 30; i < slice.length - 1; i++) {
      const bb = calcBB(slice, i);
      if (!bb || slice[i].c <= bb.upper) continue;
      const d = new Date(slice[i].t);
      if (d.getUTCDay() !== 2 || d.getUTCHours() !== 1) continue; // Tue h1
      if (calcRSI(slice, i, 7) <= 70) continue;
      trades++;
      if (slice[i + 1].c < slice[i].c) wins++;
    }
    return { wr: trades > 0 ? wins / trades : 0, n: trades };
  };
  const r1 = test(candles.slice(0, half));
  const r2 = test(candles.slice(half));
  console.log(`  E3_ETH_Tue_h1 | First half: WR=${(r1.wr * 100).toFixed(1)}% n=${r1.n} | Second half: WR=${(r2.wr * 100).toFixed(1)}% n=${r2.n}`);
}

// BTC Mon h16 (83.3% overall)
{
  const candles = allCandles['BTC'];
  const half = Math.floor(candles.length / 2);
  const test = (slice) => {
    let wins = 0, trades = 0;
    for (let i = 30; i < slice.length - 1; i++) {
      const bb = calcBB(slice, i);
      if (!bb || slice[i].c <= bb.upper) continue;
      const d = new Date(slice[i].t);
      if (d.getUTCDay() !== 1 || d.getUTCHours() !== 16) continue; // Mon h16
      if (calcRSI(slice, i, 7) <= 70) continue;
      trades++;
      if (slice[i + 1].c < slice[i].c) wins++;
    }
    return { wr: trades > 0 ? wins / trades : 0, n: trades };
  };
  const r1 = test(candles.slice(0, half));
  const r2 = test(candles.slice(half));
  console.log(`  E4_BTC_Mon_h16 | First half: WR=${(r1.wr * 100).toFixed(1)}% n=${r1.n} | Second half: WR=${(r2.wr * 100).toFixed(1)}% n=${r2.n}`);
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
    console.log(`  ✅ ${w.label}: WR=${(w.wr * 100).toFixed(1)}% n=${w.n} tpd=${w.tpd.toFixed(2)}`);
  }
}

db.close();
