/**
 * ML Optimization for 5m Polymarket Binary Strategies
 * Goal: maximize WR subject to ≥80 trades/day constraint
 *
 * Approaches:
 * 1. Pareto frontier: find non-dominated (WR, trades/day) configs
 * 2. New indicators: Stochastic %K, Williams %R, CCI
 * 3. Full BB mult grid [0.5-2.0] × RSI thresh × streak
 * 4. Sensitivity analysis: ±20% param perturbation on best configs
 * 5. Ensemble: combine 2 indicators for quality gate at high frequency
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.cwd(), 'trader.db'), { readonly: true });
const DAYS = 184;

// ─── Candle helpers ──────────────────────────────────────────────────────────

function getCandles(symbol, tf, limit) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT ?`
  ).all(symbol, tf, limit || 60000).reverse();
}

function calcBB(candles, period, mult) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map(c => c.close);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return { upper: mean + mult * Math.sqrt(variance), lower: mean - mult * Math.sqrt(variance), mid: mean };
}

function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i-1].close;
    if (d > 0) g += d; else l += -d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g/period / (l/period));
}

function calcMFI(candles, period) {
  if (candles.length < period + 1) return null;
  let pos = 0, neg = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const ptp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp > ptp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

// Stochastic %K: (close - lowest_low) / (highest_high - lowest_low) * 100
function calcStochK(candles, period) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const lowestLow = Math.min(...slice.map(c => c.low));
  const highestHigh = Math.max(...slice.map(c => c.high));
  if (highestHigh === lowestLow) return 50;
  return (candles[candles.length - 1].close - lowestLow) / (highestHigh - lowestLow) * 100;
}

// Williams %R: -100 * (highest_high - close) / (highest_high - lowest_low)
// Overbought: > -20, Oversold: < -80
function calcWilliamsR(candles, period) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const lowestLow = Math.min(...slice.map(c => c.low));
  const highestHigh = Math.max(...slice.map(c => c.high));
  if (highestHigh === lowestLow) return -50;
  return -100 * (highestHigh - candles[candles.length - 1].close) / (highestHigh - lowestLow);
}

// CCI: (typical_price - SMA) / (0.015 * mean_deviation)
// Overbought: > 100, Oversold: < -100
function calcCCI(candles, period) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const tps = slice.map(c => (c.high + c.low + c.close) / 3);
  const sma = tps.reduce((a, b) => a + b, 0) / period;
  const meanDev = tps.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
  if (meanDev === 0) return 0;
  return (tps[tps.length - 1] - sma) / (0.015 * meanDev);
}

// Stochastic %D: SMA(3) of %K
function calcStochD(candles, kPeriod, dPeriod) {
  if (candles.length < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = candles.length - dPeriod; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - kPeriod + 1), i + 1);
    if (slice.length < kPeriod) return null;
    const low = Math.min(...slice.map(c => c.low));
    const high = Math.max(...slice.map(c => c.high));
    kValues.push(high === low ? 50 : (candles[i].close - low) / (high - low) * 100);
  }
  return kValues.reduce((a, b) => a + b, 0) / dPeriod;
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

function simTrade(candles, idx) {
  const entry = candles[idx].close;
  const isBear = candles[idx].close > candles[idx].open;
  for (let k = idx + 1; k <= Math.min(idx + 3, candles.length - 1); k++) {
    if (isBear && candles[k].close < entry) return true;
    if (!isBear && candles[k].close > entry) return true;
  }
  return false;
}

function test5m(coin, filterFn) {
  const candles = getCandles(coin, '5m', 60000);
  if (candles.length < 100) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  const trades = [];
  const ws = 25;
  for (let i = ws + 1; i < candles.length - 3; i++) {
    const w = candles.slice(i - ws, i + 1);
    if (filterFn(w, candles[i])) {
      trades.push({ time: candles[i].open_time, win: simTrade(candles, i) });
    }
  }
  return walkForward(trades, 5);
}

const SEP = '═'.repeat(62);
const sep = '─'.repeat(50);

function show(label, r, minWR, minTPD) {
  const perDay = r.T / DAYS;
  if (r.wf < (minWR || 55) || perDay < (minTPD || 0)) return;
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  let tag;
  if (perDay >= 80 && r.wf >= 65) tag = '🏆 CHAMPION';
  else if (perDay >= 80 && r.wf >= 60) tag = '🚀🚀 80+/d HIT';
  else if (perDay >= 80 && r.wf >= 55) tag = '⚠️ 80+/d MARGINAL';
  else if (r.wf >= 68) tag = '✅✅ ULTRA HIGH WR';
  else if (r.wf >= 63) tag = '✅ HIGH WR';
  else tag = '⚡ PROFITABLE';
  console.log(`  ${tag} ${label}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.T}(${perDay.toFixed(1)}/d) [${fStr}]`);
}

// ════════════════════════════════════════════════════════════════
console.log(SEP);
console.log('ML Optimization: 5m Polymarket Binary Strategies');
console.log('Target: 80+ trades/day at maximum WR (Pareto frontier)');
console.log(SEP);

// ── Section 1: Stochastic oscillator — new indicator ─────────────────────────
console.log('\n' + sep);
console.log('Section 1: Stochastic %K — new indicator (not yet tested!)');
console.log(sep);

const COINS = ['ETH', 'BTC', 'SOL'];
const BB_MULTS = [0.8, 1.0, 1.2, 1.5, 1.8, 2.2];
const STOCH_PERIODS = [5, 14];
const STOCH_THRESHOLDS = [70, 75, 80];

console.log('\n[1.1] Stochastic %K overbought + BB reversion:');
for (const coin of COINS) {
  for (const kPeriod of STOCH_PERIODS) {
    for (const thresh of STOCH_THRESHOLDS) {
      for (const mult of [1.0, 1.5, 1.8, 2.2]) {
        const r = test5m(coin, (w, c) => {
          const bb = calcBB(w, 20, mult);
          if (!bb) return false;
          const stoch = calcStochK(w, kPeriod);
          if (stoch === null) return false;
          const isBear = c.close > bb.upper && c.close > c.open && stoch > thresh;
          const isBull = c.close < bb.lower && c.close < c.open && stoch < (100 - thresh);
          return isBear || isBull;
        });
        show(`${coin} Stoch(${kPeriod})>${thresh}+BB(20,${mult})`, r, 58, 20);
      }
    }
  }
}

console.log('\n[1.2] Stochastic %K + streak + BB (trifecta):');
for (const coin of COINS) {
  for (const kPeriod of [5, 14]) {
    for (const thresh of [75, 80]) {
      for (const mult of [1.0, 1.5, 2.2]) {
        const r = test5m(coin, (w, c) => {
          const bb = calcBB(w, 20, mult);
          if (!bb) return false;
          const stoch = calcStochK(w, kPeriod);
          if (stoch === null) return false;
          const isBear = c.close > bb.upper && c.close > c.open && stoch > thresh;
          const isBull = c.close < bb.lower && c.close < c.open && stoch < (100 - thresh);
          if (!isBear && !isBull) return false;
          return Math.abs(streakAt(w)) >= 1;
        });
        show(`${coin} Stoch(${kPeriod})>${thresh}+BB(20,${mult})+s>=1`, r, 58, 20);
      }
    }
  }
}

// ── Section 2: Williams %R ────────────────────────────────────────────────────
console.log('\n' + sep);
console.log('Section 2: Williams %%R — momentum exhaustion at BB');
console.log(sep);

// Williams %R > -20 = overbought, %R < -80 = oversold
const WR_PERIODS = [14, 20];
const WR_OB_THRESHOLDS = [-10, -15, -20, -25]; // closer to 0 = more extreme overbought

console.log('\n[2.1] Williams %R + BB reversion:');
for (const coin of COINS) {
  for (const wPeriod of WR_PERIODS) {
    for (const obThresh of [-10, -20, -30]) {
      for (const mult of [1.0, 1.5, 2.2]) {
        const r = test5m(coin, (w, c) => {
          const bb = calcBB(w, 20, mult);
          if (!bb) return false;
          const wr = calcWilliamsR(w, wPeriod);
          if (wr === null) return false;
          const isBear = c.close > bb.upper && c.close > c.open && wr > obThresh; // e.g., wr > -20
          const isBull = c.close < bb.lower && c.close < c.open && wr < -(100 + obThresh); // e.g., wr < -80
          return isBear || isBull;
        });
        show(`${coin} WilliamsR(${wPeriod})>=${obThresh}+BB(20,${mult})`, r, 58, 20);
      }
    }
  }
}

// ── Section 3: CCI — Commodity Channel Index ─────────────────────────────────
console.log('\n' + sep);
console.log('Section 3: CCI — Commodity Channel Index (>100 = overbought)');
console.log(sep);

const CCI_PERIODS = [14, 20];
const CCI_THRESHOLDS = [100, 150, 200];

console.log('\n[3.1] CCI extreme + BB reversion:');
for (const coin of COINS) {
  for (const cciPeriod of CCI_PERIODS) {
    for (const thresh of CCI_THRESHOLDS) {
      for (const mult of [1.0, 1.5, 2.2]) {
        const r = test5m(coin, (w, c) => {
          const bb = calcBB(w, 20, mult);
          if (!bb) return false;
          const cci = calcCCI(w, cciPeriod);
          if (cci === null) return false;
          const isBear = c.close > bb.upper && c.close > c.open && cci > thresh;
          const isBull = c.close < bb.lower && c.close < c.open && cci < -thresh;
          return isBear || isBull;
        });
        show(`${coin} CCI(${cciPeriod})>${thresh}+BB(20,${mult})`, r, 58, 20);
      }
    }
  }
}

// ── Section 4: Full Pareto grid on BB mult [0.5–2.0] ────────────────────────
console.log('\n' + sep);
console.log('Section 4: ML Pareto Frontier (BB mult × RSI thresh × streak)');
console.log('Fine-grained grid: mult 0.5–2.0 step 0.1 × RSI 60–80 × streak 0–2');
console.log(sep);

const paretoAll = [];
const RSI_THRESHOLDS = [0, 60, 65, 70, 75, 80]; // 0 = no RSI filter

for (const coin of COINS) {
  for (let mult = 0.5; mult <= 2.01; mult += 0.1) {
    const m = Math.round(mult * 10) / 10;
    for (const rsiThresh of RSI_THRESHOLDS) {
      for (const minStreak of [0, 1, 2]) {
        const r = test5m(coin, (w, c) => {
          const bb = calcBB(w, 20, m);
          if (!bb) return false;
          const isBear = c.close > bb.upper && c.close > c.open;
          const isBull = c.close < bb.lower && c.close < c.open;
          if (!isBear && !isBull) return false;
          if (minStreak > 0 && Math.abs(streakAt(w)) < minStreak) return false;
          if (rsiThresh > 0) {
            const rsi = calcRSI(w, 14);
            if (rsi === null) return false;
            if (isBear && rsi <= rsiThresh) return false;
            if (isBull && rsi >= (100 - rsiThresh)) return false;
          }
          return true;
        });
        const tpd = r.T / DAYS;
        if (r.wf >= 60 && tpd >= 30) {
          paretoAll.push({ coin, mult: m, rsiThresh, minStreak, ...r, tpd });
        }
      }
    }
  }
}

// Pareto frontier: non-dominated configs (no other config dominates in BOTH WR and trades/day)
function isParetoOptimal(candidate, all) {
  return !all.some(other =>
    other !== candidate &&
    other.tpd >= candidate.tpd &&
    other.wf > candidate.wf &&
    other.sigma <= candidate.sigma
  );
}

const pareto = paretoAll.filter(c => isParetoOptimal(c, paretoAll));
pareto.sort((a, b) => b.wf - a.wf);

console.log(`\nPareto frontier (non-dominated configs, WR≥60%, ≥30/day):`);
console.log(`Found ${pareto.length} Pareto-optimal configs (sorted by WR):\n`);
for (const r of pareto.slice(0, 30)) {
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  const tag = r.tpd >= 80 && r.wf >= 65 ? '🏆' :
               r.tpd >= 80 && r.wf >= 60 ? '🚀' : '✅';
  console.log(`  ${tag} ${r.coin} BB(20,${r.mult}) RSI>${r.rsiThresh} s>=${r.minStreak}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${r.tpd.toFixed(1)}/d [${fStr}]`);
}

// Show the 80+/day champions specifically
console.log('\n\n🏆 ALL CONFIGS WITH 80+/day AND WF≥65% (sorted by WR):');
const champions = paretoAll.filter(r => r.tpd >= 80 && r.wf >= 65).sort((a, b) => b.wf - a.wf);
for (const r of champions.slice(0, 15)) {
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  console.log(`  🏆 ${r.coin} BB(20,${r.mult}) RSI>${r.rsiThresh} s>=${r.minStreak}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${r.tpd.toFixed(1)}/d [${fStr}]`);
}

// ── Section 5: Sensitivity analysis on best 5m configs ───────────────────────
console.log('\n' + sep);
console.log('Section 5: Sensitivity Analysis — stability to ±20% param perturbation');
console.log(sep);

// Test our proven Strat 67 (BB 1.8) and Strat 68 (BB 1.0) with perturbations
const sensitivityTests = [
  { label: 'Strat67 (BB 1.8) ETH', coin: 'ETH', bbMult: 1.8, rsi: 0, streak: 1 },
  { label: 'Strat68 (BB 1.0) ETH', coin: 'ETH', bbMult: 1.0, rsi: 0, streak: 1 },
  { label: 'Strat68 (BB 1.0) BTC', coin: 'BTC', bbMult: 1.0, rsi: 0, streak: 1 },
  { label: 'Strat68 (BB 1.0) SOL', coin: 'SOL', bbMult: 1.0, rsi: 0, streak: 1 },
];

for (const base of sensitivityTests) {
  console.log(`\n  ${base.label}:`);
  const perturbations = [-0.2, -0.1, 0, +0.1, +0.2].map(pct => base.bbMult * (1 + pct));
  for (const mult of perturbations) {
    const m = Math.round(mult * 100) / 100;
    const r = test5m(base.coin, (w, c) => {
      const bb = calcBB(w, 20, m);
      if (!bb) return false;
      const isBear = c.close > bb.upper && c.close > c.open;
      const isBull = c.close < bb.lower && c.close < c.open;
      if (!isBear && !isBull) return false;
      return Math.abs(streakAt(w)) >= base.streak;
    });
    const pct = m === base.bbMult ? ' ← BASE' : '';
    console.log(`    BB(20,${m}): WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${(r.T/DAYS).toFixed(1)}/d${pct}`);
  }
}

// ── Section 6: Ensemble — combine indicators at BB(20,1.0) for best WR ───────
console.log('\n' + sep);
console.log('Section 6: Indicator ensembles at BB(20,1.0) — can we push 80+/d WR higher?');
console.log(sep);

console.log('\n[6.1] BB(20,1.0) + RSI filter at various thresholds (WR vs frequency):');
for (const coin of ['ETH', 'BTC']) {
  console.log(`  ${coin}:`);
  for (const rsiT of [0, 55, 60, 65, 70, 75]) {
    const r = test5m(coin, (w, c) => {
      const bb = calcBB(w, 20, 1.0);
      if (!bb) return false;
      const isBear = c.close > bb.upper && c.close > c.open;
      const isBull = c.close < bb.lower && c.close < c.open;
      if (!isBear && !isBull) return false;
      if (Math.abs(streakAt(w)) < 1) return false;
      if (rsiT > 0) {
        const rsi = calcRSI(w, 14);
        if (rsi === null) return false;
        if (isBear && rsi <= rsiT) return false;
        if (isBull && rsi >= (100 - rsiT)) return false;
      }
      return true;
    });
    const tpd = r.T / DAYS;
    const hit80 = tpd >= 80 ? ' ← 80+/d' : '';
    console.log(`    RSI>${rsiT}: WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${tpd.toFixed(1)}/d${hit80}`);
  }
}

console.log('\n[6.2] BB(20,1.0) + Stochastic quality gate:');
for (const coin of ['ETH', 'BTC', 'SOL']) {
  for (const stochThresh of [70, 80]) {
    const r = test5m(coin, (w, c) => {
      const bb = calcBB(w, 20, 1.0);
      if (!bb) return false;
      const stoch = calcStochK(w, 14);
      if (stoch === null) return false;
      const isBear = c.close > bb.upper && c.close > c.open && stoch > stochThresh;
      const isBull = c.close < bb.lower && c.close < c.open && stoch < (100 - stochThresh);
      if (!isBear && !isBull) return false;
      return Math.abs(streakAt(w)) >= 1;
    });
    show(`${coin} BB(20,1.0)+Stoch(14)>${stochThresh}+s>=1`, r, 58, 20);
  }
}

console.log('\n[6.3] BB(20,1.0) + CCI quality gate:');
for (const coin of ['ETH', 'BTC', 'SOL']) {
  for (const cciThresh of [50, 100]) {
    const r = test5m(coin, (w, c) => {
      const bb = calcBB(w, 20, 1.0);
      if (!bb) return false;
      const cci = calcCCI(w, 14);
      if (cci === null) return false;
      const isBear = c.close > bb.upper && c.close > c.open && cci > cciThresh;
      const isBull = c.close < bb.lower && c.close < c.open && cci < -cciThresh;
      if (!isBear && !isBull) return false;
      return Math.abs(streakAt(w)) >= 1;
    });
    show(`${coin} BB(20,1.0)+CCI(14)>${cciThresh}+s>=1`, r, 58, 20);
  }
}

console.log('\n[6.4] BB(20,1.0) + MFI quality gate (best previously found):');
for (const coin of ['ETH', 'BTC', 'SOL']) {
  for (const mfiT of [60, 65, 70]) {
    const r = test5m(coin, (w, c) => {
      const bb = calcBB(w, 20, 1.0);
      if (!bb) return false;
      const mfi = calcMFI(w, 10);
      if (mfi === null) return false;
      const isBear = c.close > bb.upper && c.close > c.open && mfi > mfiT;
      const isBull = c.close < bb.lower && c.close < c.open && mfi < (100 - mfiT);
      if (!isBear && !isBull) return false;
      return Math.abs(streakAt(w)) >= 1;
    });
    show(`${coin} BB(20,1.0)+MFI>${mfiT}+s>=1`, r, 58, 20);
  }
}

// ── Section 7: Adaptive BB period — does period matter? ──────────────────────
console.log('\n' + sep);
console.log('Section 7: Adaptive BB period — period 10, 15, 20, 25 at mult 1.0 and 1.8');
console.log(sep);

for (const coin of ['ETH', 'BTC']) {
  console.log(`\n  ${coin}:`);
  for (const period of [10, 12, 15, 20, 25, 30]) {
    for (const mult of [1.0, 1.8]) {
      const r = test5m(coin, (w, c) => {
        if (w.length < period) return false;
        const bb = calcBB(w, period, mult);
        if (!bb) return false;
        const isBear = c.close > bb.upper && c.close > c.open;
        const isBull = c.close < bb.lower && c.close < c.open;
        if (!isBear && !isBull) return false;
        return Math.abs(streakAt(w)) >= 1;
      });
      const tpd = r.T / DAYS;
      const hit80 = tpd >= 80 ? ' 🚀' : '';
      console.log(`    BB(${period},${mult}): WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${tpd.toFixed(1)}/d${hit80}`);
    }
  }
}

// ─── FINAL SUMMARY ─────────────────────────────────────────────
console.log('\n' + SEP);
console.log('FINAL SUMMARY: Best 80+/day strategies for 5m Polymarket Binary');
console.log(SEP);

const finalCandidates = paretoAll
  .filter(r => r.tpd >= 80)
  .sort((a, b) => b.wf - a.wf)
  .slice(0, 10);

console.log('\nTop 10 configs with 80+/day (by WR):');
for (const r of finalCandidates) {
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  console.log(`  ${r.coin} BB(20,${r.mult}) RSI>${r.rsiThresh} s>=${r.minStreak}`);
  console.log(`    WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${r.tpd.toFixed(1)}/d [${fStr}]`);
}

console.log('\nDone.\n');
db.close();
