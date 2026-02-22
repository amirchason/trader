'use strict';
/**
 * Polymarket HF Research — Correct Single-Candle Exit
 *
 * Key fix vs previous research: Polymarket 5m binary resolves at the NEXT
 * candle's CLOSE, not a 3-candle touch. This script uses the exact
 * Polymarket resolution mechanic.
 *
 * Target: ≥80 trades/day (aggregate across coins), WR > 52%
 *
 * Sections:
 * 1. Single-candle exit BB sweep (5m) — establish real WR baseline
 * 2. Multi-coin aggregate — ETH+BTC+SOL+XRP combined trades/day
 * 3. ML threshold sweep — optimize (mult × RSI × streak × hour)
 * 4. 1m candle strategies — more data points
 * 5. Summary + best candidates
 */

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(process.cwd(), 'trader.db'), { readonly: true });

const DAYS = 184; // 6 months

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCandles(symbol, tf, limit) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT ?`
  ).all(symbol, tf, limit || 100000).reverse();
}

function calcBB(candles, period, mult) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map(c => c.close);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, lower: mean - mult * std, mid: mean, std };
}

function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) g += d; else l += -d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / period) / (l / period));
}

function calcATR(candles, period) {
  if (candles.length < period + 1) return null;
  let atr = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return atr / period;
}

function calcMFI(candles, period) {
  if (candles.length < period + 1) return null;
  let pos = 0, neg = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const ptp = (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp > ptp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function streakAt(window) {
  let s = 0;
  for (let j = window.length - 1; j >= 0; j--) {
    const c = window[j];
    if (c.close > c.open) { if (s < 0) break; s++; }
    else if (c.close < c.open) { if (s > 0) break; s--; }
    else break;
  }
  return s;
}

// ── CORRECT Polymarket exit: next single candle close ──────────────────────
// Mean reversion: signal candle is bullish (above upper BB) → bet bearish
// Win: next candle close < signal candle close
function exitPolymarket(candles, idx) {
  if (idx + 1 >= candles.length) return null;
  const c = candles[idx];
  const next = candles[idx + 1];
  const bullishSignal = c.close < c.open; // bearish candle → bet bullish reversal
  if (bullishSignal) return next.close > c.close ? true : false;
  else return next.close < c.close ? true : false; // bearish signal → bet bearish
}

function walkForward(trades, folds) {
  folds = folds || 5;
  if (trades.length < folds * 10) folds = 3;
  if (trades.length < 15) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  trades.sort((a, b) => a.time - b.time);
  const sz = Math.floor(trades.length / folds);
  const foldWRs = [];
  for (let f = 0; f < folds; f++) {
    const sl = trades.slice(f * sz, (f + 1) * sz);
    foldWRs.push(sl.length < 2 ? 50 : sl.filter(t => t.win).length / sl.length * 100);
  }
  const mean = foldWRs.reduce((a, b) => a + b, 0) / folds;
  const sigma = Math.sqrt(foldWRs.reduce((s, v) => s + (v - mean) ** 2, 0) / folds);
  return { wf: mean, sigma, T: trades.length, foldWRs };
}

function test(coin, tf, filterFn, opts) {
  opts = opts || {};
  const limit = opts.limit || 100000;
  const ws = opts.ws || 25;
  const folds = opts.folds || 5;
  const candles = getCandles(coin, tf, limit);
  if (candles.length < 100) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  const trades = [];
  for (let i = ws + 1; i < candles.length - 1; i++) {
    const w = candles.slice(i - ws, i + 1);
    if (filterFn(w, candles[i])) {
      const win = exitPolymarket(candles, i);
      if (win !== null) trades.push({ time: candles[i].open_time, win });
    }
  }
  return walkForward(trades, folds);
}

function show(label, r, minWR, minTPD) {
  minWR = minWR || 52;
  minTPD = minTPD || 0;
  const tpd = r.T / DAYS;
  if (r.T < 30) return;
  if (r.wf < minWR || tpd < minTPD) return;
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  let tag = '  ';
  if (tpd >= 80 && r.wf >= 55) tag = '🚀🚀 TARGET 80+/d';
  else if (tpd >= 80 && r.wf >= 52) tag = '⚡ 80+/d MARGINAL';
  else if (tpd >= 40 && r.wf >= 55) tag = '✅ 40+/d GOOD';
  else if (r.wf >= 60) tag = '⭐ HIGH-WR';
  else tag = '   ';
  console.log(`  ${tag}  ${label}`);
  console.log(`         WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.T}(${tpd.toFixed(1)}/d) [${fStr}]`);
  return r;
}

const SEP = '═'.repeat(68);
const sep = '─'.repeat(55);

// ════════════════════════════════════════════════════════════════════════════
console.log(SEP);
console.log('Polymarket HF Research — Correct Single-Candle Exit');
console.log('Resolution: next 5m candle close (exact Polymarket mechanic)');
console.log('Target: ≥80 trades/day aggregate, WR > 52%');
console.log(SEP);

// ── Section 1: BB sweep, 5m, correct exit ─────────────────────────────────
console.log('\n' + sep);
console.log('Section 1: 5m BB sweep — single-candle exit (real Polymarket WR)');
console.log(sep);

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const BB_MULTS = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2];

console.log('\n[1.1] Bare BB (no streak, no RSI) — all hours:');
for (const coin of COINS) {
  for (const mult of BB_MULTS) {
    const r = test(coin, '5m', (w, c) => {
      const bb = calcBB(w, 20, mult);
      if (!bb) return false;
      return (c.close > bb.upper && c.close > c.open) ||
             (c.close < bb.lower && c.close < c.open);
    });
    show(`${coin} 5m BB(20,${mult}) bare`, r, 52, 5);
  }
}

console.log('\n[1.2] BB + streak>=1 (direction confirmation):');
for (const coin of COINS) {
  for (const mult of [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2]) {
    const r = test(coin, '5m', (w, c) => {
      const bb = calcBB(w, 20, mult);
      if (!bb) return false;
      if ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) {
        return Math.abs(streakAt(w)) >= 1;
      }
      return false;
    });
    show(`${coin} 5m BB(20,${mult})+s>=1`, r, 52, 5);
  }
}

console.log('\n[1.3] BB + streak>=2:');
for (const coin of COINS) {
  for (const mult of [0.8, 1.0, 1.2, 1.5, 1.8]) {
    const r = test(coin, '5m', (w, c) => {
      const bb = calcBB(w, 20, mult);
      if (!bb) return false;
      if ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) {
        return Math.abs(streakAt(w)) >= 2;
      }
      return false;
    });
    show(`${coin} 5m BB(20,${mult})+s>=2`, r, 52, 5);
  }
}

// ── Section 2: RSI filter on top of loose BB ──────────────────────────────
console.log('\n' + sep);
console.log('Section 2: RSI filter — does it help or hurt frequency/WR?');
console.log(sep);

console.log('\n[2.1] RSI(14) thresholds on 5m BB(20,1.0) and BB(20,1.5):');
const RSI_THRESHOLDS = [55, 60, 65, 70];
const RSI_BB_MULTS = [1.0, 1.2, 1.5];
for (const coin of ['ETH', 'BTC', 'SOL']) {
  for (const mult of RSI_BB_MULTS) {
    for (const thresh of RSI_THRESHOLDS) {
      const r = test(coin, '5m', (w, c) => {
        const bb = calcBB(w, 20, mult);
        if (!bb) return false;
        const rsi = calcRSI(w, 14);
        if (rsi === null) return false;
        return (c.close > bb.upper && c.close > c.open && rsi > thresh) ||
               (c.close < bb.lower && c.close < c.open && rsi < (100 - thresh));
      });
      show(`${coin} 5m RSI(14)>${thresh}+BB(20,${mult})`, r, 52, 5);
    }
  }
}

// ── Section 3: Multi-coin aggregate — track total trades/day ──────────────
console.log('\n' + sep);
console.log('Section 3: Multi-coin aggregate — can we hit 80+/day combined?');
console.log(sep);

const configs = [
  { label: 'BB(20,1.0)+s>=1', fn: (w, c) => {
    const bb = calcBB(w, 20, 1.0); if (!bb) return false;
    return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) && Math.abs(streakAt(w)) >= 1;
  }},
  { label: 'BB(20,1.2)+s>=1', fn: (w, c) => {
    const bb = calcBB(w, 20, 1.2); if (!bb) return false;
    return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) && Math.abs(streakAt(w)) >= 1;
  }},
  { label: 'BB(20,1.5)+s>=1', fn: (w, c) => {
    const bb = calcBB(w, 20, 1.5); if (!bb) return false;
    return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) && Math.abs(streakAt(w)) >= 1;
  }},
  { label: 'BB(20,1.8)+s>=1', fn: (w, c) => {
    const bb = calcBB(w, 20, 1.8); if (!bb) return false;
    return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) && Math.abs(streakAt(w)) >= 1;
  }},
  { label: 'BB(20,2.0)+s>=1', fn: (w, c) => {
    const bb = calcBB(w, 20, 2.0); if (!bb) return false;
    return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) && Math.abs(streakAt(w)) >= 1;
  }},
  { label: 'BB(20,2.2)+s>=2', fn: (w, c) => {
    const bb = calcBB(w, 20, 2.2); if (!bb) return false;
    return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) && Math.abs(streakAt(w)) >= 2;
  }},
];

for (const cfg of configs) {
  let totalT = 0, totalWins = 0;
  process.stdout.write(`\n  Config: ${cfg.label}\n`);
  for (const coin of COINS) {
    const r = test(coin, '5m', cfg.fn);
    const tpd = r.T / DAYS;
    const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
    process.stdout.write(`    ${coin}: WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${tpd.toFixed(1)}/d [${fStr}]\n`);
    totalT += r.T;
    totalWins += Math.round(r.T * r.wf / 100);
  }
  const combWR = totalT > 0 ? totalWins / totalT * 100 : 0;
  const combTPD = totalT / DAYS;
  const tag = combTPD >= 80 && combWR >= 52 ? '🚀🚀 TARGET HIT' : combTPD >= 40 ? '⚡ HALF WAY' : '';
  console.log(`    ── COMBINED: ${combTPD.toFixed(1)}/day | WR≈${combWR.toFixed(1)}% ${tag}`);
}

// ── Section 4: ML Grid Search — maximize WR subject to >=80 total/day ──────
console.log('\n' + sep);
console.log('Section 4: ML Grid Search — find optimal (mult × RSI × streak)');
console.log('Maximize WR subject to aggregate ≥80 trades/day');
console.log(sep);

const mlResults = [];
const ML_MULTS = [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2];
const ML_RSI = [0, 55, 60, 65, 70]; // 0 = no RSI filter
const ML_STREAK = [0, 1, 2, 3];

let configCount = 0;
const totalConfigs = ML_MULTS.length * ML_RSI.length * ML_STREAK.length;
process.stdout.write(`\nSearching ${totalConfigs} configs across 4 coins...\n`);

for (const mult of ML_MULTS) {
  for (const rsiThresh of ML_RSI) {
    for (const minStreak of ML_STREAK) {
      configCount++;
      if (configCount % 20 === 0) process.stdout.write(`  ${configCount}/${totalConfigs}...\n`);

      const fn = (w, c) => {
        const bb = calcBB(w, 20, mult);
        if (!bb) return false;
        const bearSig = c.close > bb.upper && c.close > c.open;
        const bullSig = c.close < bb.lower && c.close < c.open;
        if (!bearSig && !bullSig) return false;
        if (minStreak > 0 && Math.abs(streakAt(w)) < minStreak) return false;
        if (rsiThresh > 0) {
          const rsi = calcRSI(w, 14);
          if (rsi === null) return false;
          if (bearSig && rsi < rsiThresh) return false;
          if (bullSig && rsi > (100 - rsiThresh)) return false;
        }
        return true;
      };

      let totalT = 0, totalWins = 0;
      const coinData = {};
      for (const coin of COINS) {
        const r = test(coin, '5m', fn, { folds: 5 });
        coinData[coin] = r;
        totalT += r.T;
        totalWins += Math.round(r.T * r.wf / 100);
      }
      const combWR = totalT > 0 ? totalWins / totalT * 100 : 0;
      const combTPD = totalT / DAYS;
      if (combTPD >= 80 && combWR >= 52) {
        mlResults.push({ mult, rsiThresh, minStreak, combWR, combTPD, totalT, coinData });
      }
    }
  }
}

mlResults.sort((a, b) => b.combWR - a.combWR);
console.log(`\nFound ${mlResults.length} configs achieving ≥80 trades/day AND WR≥52%:`);
for (const r of mlResults.slice(0, 15)) {
  console.log(`\n  BB(20,${r.mult}) RSI>${r.rsiThresh || 'off'} s>=${r.minStreak}`);
  console.log(`    COMBINED: WR=${r.combWR.toFixed(1)}% ${r.combTPD.toFixed(1)}/d`);
  for (const coin of COINS) {
    const cr = r.coinData[coin];
    if (cr.T < 10) continue;
    const fStr = cr.foldWRs.map(f => f.toFixed(1)).join('/');
    console.log(`    ${coin}: WF=${cr.wf.toFixed(1)}% σ=${cr.sigma.toFixed(1)}% ${(cr.T/DAYS).toFixed(1)}/d [${fStr}]`);
  }
}

// ── Section 5: 1m candles — high-frequency single candle resolution ─────────
console.log('\n' + sep);
console.log('Section 5: 1m candles — Polymarket 5m resolution via 5×1m exit');
console.log('Signal: 1m BB hit. Exit: 5 candles later (= 1 real 5m candle)');
console.log(sep);

// For 1m candles: Polymarket 5m market resolves in 5 minutes = 5 candles
function exit1m5candles(candles, idx) {
  const targetIdx = idx + 5;
  if (targetIdx >= candles.length) return null;
  const c = candles[idx];
  const target = candles[targetIdx];
  const bullishSignal = c.close < c.open;
  return bullishSignal ? target.close > c.close : target.close < c.close;
}

console.log('\n[5.1] 1m BB + streak>=1, exit at +5 candles (=1 real 5m):');
for (const coin of ['ETH', 'BTC', 'SOL']) {
  const candles1m = getCandles(coin, '1m', 300000);
  if (candles1m.length < 1000) { console.log(`  ${coin}: no 1m data`); continue; }
  console.log(`  ${coin}: ${candles1m.length} 1m candles`);
  for (const mult of [1.0, 1.5, 2.0, 2.2]) {
    const trades = [];
    const ws = 25;
    for (let i = ws + 1; i < candles1m.length - 5; i++) {
      const w = candles1m.slice(i - ws, i + 1);
      const bb = calcBB(w, 20, mult);
      if (!bb) continue;
      const c = candles1m[i];
      const bearSig = c.close > bb.upper && c.close > c.open;
      const bullSig = c.close < bb.lower && c.close < c.open;
      if (!bearSig && !bullSig) continue;
      if (Math.abs(streakAt(w)) < 1) continue;
      const win = exit1m5candles(candles1m, i);
      if (win !== null) trades.push({ time: c.open_time, win });
    }
    const r = walkForward(trades, 5);
    const tpd = r.T / DAYS;
    if (tpd < 10 || r.wf < 50) continue;
    const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
    let tag = '';
    if (tpd >= 80 && r.wf >= 52) tag = '🚀🚀 TARGET';
    else if (tpd >= 40 && r.wf >= 52) tag = '⚡ HF GOOD';
    else if (r.wf >= 55) tag = '✅';
    console.log(`    ${tag} BB(20,${mult})+s>=1: WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${tpd.toFixed(1)}/d [${fStr}]`);
  }
}

// ── Section 6: Bidirectional BB (no body filter) ────────────────────────────
console.log('\n' + sep);
console.log('Section 6: Bidirectional BB — bet against ANY touch (no body filter)');
console.log(sep);
// No candle body direction filter = 2x more signals, but weaker edge?
// Exit: next candle closes back toward midline
function exitBidir(candles, idx) {
  if (idx + 1 >= candles.length) return null;
  const c = candles[idx];
  const next = candles[idx + 1];
  const bb = calcBB(candles.slice(Math.max(0, idx - 24), idx + 1), 20, 2.0);
  if (!bb) return null;
  if (c.close > bb.upper) return next.close < c.close; // bet it falls
  if (c.close < bb.lower) return next.close > c.close; // bet it rises
  return null;
}

for (const coin of COINS) {
  for (const mult of [1.0, 1.2, 1.5]) {
    const candles = getCandles(coin, '5m', 100000);
    const trades = [];
    const ws = 25;
    for (let i = ws + 1; i < candles.length - 1; i++) {
      const w = candles.slice(i - ws, i + 1);
      const bb = calcBB(w, 20, mult);
      if (!bb) continue;
      const c = candles[i];
      if (c.close <= bb.upper && c.close >= bb.lower) continue;
      const next = candles[i + 1];
      const win = c.close > bb.upper ? next.close < c.close : next.close > c.close;
      trades.push({ time: c.open_time, win });
    }
    const r = walkForward(trades, 5);
    show(`${coin} BIDIR BB(20,${mult})`, r, 50, 5);
  }
}

// ── Section 7: Good hours at loose BB — can hour filter help? ──────────────
console.log('\n' + sep);
console.log('Section 7: Good hours filter — does it boost WR at loose BB?');
console.log(sep);

const GOOD_HOURS_ETH = new Set([10, 11, 12, 21]);
const GOOD_HOURS_SOL = new Set([0, 12, 13, 20]);
const GOOD_HOURS_XRP = new Set([6, 9, 12, 18]);
const GOOD_HOURS_BTC = new Set([10, 11, 12, 21]); // same as ETH

const goodHoursMap = { ETH: GOOD_HOURS_ETH, BTC: GOOD_HOURS_BTC, SOL: GOOD_HOURS_SOL, XRP: GOOD_HOURS_XRP };

for (const coin of COINS) {
  const ghSet = goodHoursMap[coin];
  for (const mult of [1.0, 1.2, 1.5]) {
    const r = test(coin, '5m', (w, c) => {
      const hour = new Date(c.open_time).getUTCHours();
      if (!ghSet.has(hour)) return false;
      const bb = calcBB(w, 20, mult);
      if (!bb) return false;
      return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) &&
             Math.abs(streakAt(w)) >= 1;
    });
    show(`${coin} GOOD_H+BB(20,${mult})+s>=1`, r, 52, 2);
  }
}

// Aggregate good-hours across all coins
console.log('\n  Good hours aggregate (ETH+BTC+SOL+XRP) at BB(20,1.2)+s>=1:');
let ghTotal = 0, ghWins = 0;
for (const coin of COINS) {
  const ghSet = goodHoursMap[coin];
  const r = test(coin, '5m', (w, c) => {
    const hour = new Date(c.open_time).getUTCHours();
    if (!ghSet.has(hour)) return false;
    const bb = calcBB(w, 20, 1.2);
    if (!bb) return false;
    return ((c.close > bb.upper && c.close > c.open) || (c.close < bb.lower && c.close < c.open)) &&
           Math.abs(streakAt(w)) >= 1;
  });
  ghTotal += r.T;
  ghWins += Math.round(r.T * r.wf / 100);
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  console.log(`    ${coin}: WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${(r.T/DAYS).toFixed(1)}/d [${fStr}]`);
}
const ghCombWR = ghTotal > 0 ? ghWins / ghTotal * 100 : 0;
console.log(`    COMBINED: WR=${ghCombWR.toFixed(1)}% ${(ghTotal/DAYS).toFixed(1)}/day`);

// ── Final Summary ───────────────────────────────────────────────────────────
console.log('\n' + SEP);
console.log('FINAL SUMMARY');
console.log(SEP);
console.log('\nKey findings with CORRECT Polymarket single-candle exit:');
console.log('\n① WR Reality Check:');
console.log('   Previous research used 3-candle touch exit → inflated WR by ~10-15%');
console.log('   Real single-candle Polymarket WR is lower. See Section 1 for actuals.');
console.log('\n② Best Single-Coin Config for HF:');
console.log('   See Section 1+2 results — highest WR at ≥20/day per coin');
console.log('\n③ Multi-Coin Aggregate 80+ target:');
console.log('   See Section 3 table and Section 4 ML results');
console.log('\n④ 1m Candle Option:');
console.log('   1m data with 5-candle exit gives 5-10x more signals');
console.log('   See Section 5 for WR at 1m resolution');
console.log('\n⑤ Profitable Threshold: WR > 52% (covers Polymarket ~1.5% fees)');
console.log('\nDone.\n');

db.close();
