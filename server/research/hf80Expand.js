/**
 * hf80Expand.js — Deep expansion of 80+/day HF strategies
 * Tests Williams %R, CCI, Adaptive BB, Hour-of-day optimization,
 * and multi-indicator combos on ETH/BTC/SOL 5m data
 * Run: node server/research/hf80Expand.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../trader.db'));

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCandles(symbol, tf) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC`
  ).all(symbol, tf);
}

function computeBB(candles, i, period, mult) {
  if (i < period - 1) return null;
  const slice = candles.slice(i - period + 1, i + 1);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

function computeRSI(candles, i, period = 14) {
  if (i < period) return 50;
  let gains = 0, losses = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const d = candles[j].close - candles[j - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function computeStoch(candles, i, period = 5) {
  if (i < period - 1) return 50;
  const slice = candles.slice(i - period + 1, i + 1);
  const low = Math.min(...slice.map(c => c.low));
  const high = Math.max(...slice.map(c => c.high));
  return high === low ? 50 : (candles[i].close - low) / (high - low) * 100;
}

function computeWilliamsR(candles, i, period = 14) {
  if (i < period - 1) return -50;
  const slice = candles.slice(i - period + 1, i + 1);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  const range = high - low;
  return range === 0 ? -50 : -100 * (high - candles[i].close) / range;
}

function computeCCI(candles, i, period = 14) {
  if (i < period - 1) return 0;
  const slice = candles.slice(i - period + 1, i + 1);
  const tps = slice.map(c => (c.high + c.low + c.close) / 3);
  const sma = tps.reduce((s, v) => s + v, 0) / period;
  const tp = tps[tps.length - 1];
  const meanDev = tps.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
  return meanDev === 0 ? 0 : (tp - sma) / (0.015 * meanDev);
}

function computeStreak(candles, i) {
  let streak = 0;
  for (let j = i; j >= Math.max(0, i - 8); j--) {
    const c = candles[j];
    if (c.close > c.open) { if (streak < 0) break; streak++; }
    else if (c.close < c.open) { if (streak > 0) break; streak--; }
    else break;
  }
  return streak;
}

// Walk-forward validation (k folds)
function walkForward(candles, triggerFn, exitCandles = 3, k = 5) {
  const foldSize = Math.floor(candles.length / k);
  const foldResults = [];
  for (let fold = 0; fold < k; fold++) {
    const start = fold * foldSize;
    const end = fold === k - 1 ? candles.length : (fold + 1) * foldSize;
    let wins = 0, total = 0;
    for (let i = start + 30; i < end - exitCandles; i++) {
      const dir = triggerFn(candles, i);
      if (!dir) continue;
      total++;
      const entry = candles[i].close;
      const exitIdx = Math.min(i + exitCandles, candles.length - 1);
      const exitPrice = candles[exitIdx].close;
      const win = dir === 'bear' ? exitPrice < entry : exitPrice > entry;
      if (win) wins++;
    }
    foldResults.push(total > 0 ? wins / total * 100 : 0);
  }
  const mean = foldResults.reduce((s, v) => s + v, 0) / k;
  const variance = foldResults.reduce((s, v) => s + (v - mean) ** 2, 0) / k;
  const tradesPerDay = foldResults.reduce((_, __, ___, arr) => {
    // compute from full dataset
    return 0;
  }, 0);
  return { mean, sigma: Math.sqrt(variance), folds: foldResults };
}

function countTrades(candles, triggerFn) {
  let total = 0;
  for (let i = 30; i < candles.length - 3; i++) {
    if (triggerFn(candles, i)) total++;
  }
  const days = candles.length / 288; // 288 5m candles/day
  return { total, perDay: total / days };
}

function evaluate(candles, triggerFn, label, exitCandles = 3, k = 5) {
  const { total, perDay } = countTrades(candles, triggerFn);
  if (total < 50) return null;
  const { mean, sigma, folds } = walkForward(candles, triggerFn, exitCandles, k);
  return { label, total, perDay, wr: mean, sigma, folds };
}

function printResult(r) {
  if (!r) return;
  const foldsStr = r.folds.map(f => f.toFixed(1)).join('/');
  const marker = r.wr >= 70 && r.perDay >= 80 ? ' 🏆🏆' : r.wr >= 70 ? ' ✅' : r.perDay >= 80 ? ' ⚡' : '';
  console.log(`  ${r.label.padEnd(50)} WF=${r.wr.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.total}(${r.perDay.toFixed(1)}/d) [${foldsStr}]${marker}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HF80 Strategy Expansion Research ===\n');

  const coins = [
    { sym: 'ETH', db: 'ETH', label: 'ETH' },
    { sym: 'BTC', db: 'BTC', label: 'BTC' },
    { sym: 'SOL', db: 'SOL', label: 'SOL' },
  ];

  for (const { sym, db: dbSym, label } of coins) {
    const candles = getCandles(dbSym, '5m');
    if (!candles.length) { console.log(`No data for ${sym}`); continue; }
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${label} — ${candles.length} candles (${(candles.length/288).toFixed(1)} days)`);
    console.log('='.repeat(70));

    // ── Section 1: Williams %R variants ─────────────────────────────────────
    console.log('\n[1] Williams %R + BB(20,1.0)');
    for (const wrPeriod of [5, 8, 10, 14]) {
      for (const wrThresh of [10, 20, 30]) {
        for (const minStreak of [1, 2]) {
          const r = evaluate(candles, (c, i) => {
            const bb = computeBB(c, i, 20, 1.0);
            if (!bb) return null;
            const wr = computeWilliamsR(c, i, wrPeriod);
            const streak = computeStreak(c, i);
            const isBear = c[i].close > bb.upper && c[i].close > c[i].open && wr > -(wrThresh) && Math.abs(streak) >= minStreak && streak > 0;
            const isBull = c[i].close < bb.lower && c[i].close < c[i].open && wr < -(100 - wrThresh) && Math.abs(streak) >= minStreak && streak < 0;
            return isBear ? 'bear' : isBull ? 'bull' : null;
          }, `WR(${wrPeriod})>${-(wrThresh)}&BB10 s>=${minStreak}`);
          printResult(r);
        }
      }
    }

    // ── Section 2: CCI variants ──────────────────────────────────────────────
    console.log('\n[2] CCI + BB(20,1.0)');
    for (const cciPeriod of [5, 8, 10, 14]) {
      for (const cciThresh of [50, 75, 100]) {
        for (const minStreak of [1, 2]) {
          const r = evaluate(candles, (c, i) => {
            const bb = computeBB(c, i, 20, 1.0);
            if (!bb) return null;
            const cci = computeCCI(c, i, cciPeriod);
            const streak = computeStreak(c, i);
            const isBear = c[i].close > bb.upper && c[i].close > c[i].open && cci > cciThresh && Math.abs(streak) >= minStreak && streak > 0;
            const isBull = c[i].close < bb.lower && c[i].close < c[i].open && cci < -cciThresh && Math.abs(streak) >= minStreak && streak < 0;
            return isBear ? 'bear' : isBull ? 'bull' : null;
          }, `CCI(${cciPeriod})>${cciThresh}&BB10 s>=${minStreak}`);
          printResult(r);
        }
      }
    }

    // ── Section 3: RSI + Stoch dual confirm ──────────────────────────────────
    console.log('\n[3] RSI+Stoch dual confirm + BB(20,1.0)');
    for (const rsiT of [60, 65, 70]) {
      for (const stochT of [60, 70, 75]) {
        const r = evaluate(candles, (c, i) => {
          const bb = computeBB(c, i, 20, 1.0);
          if (!bb) return null;
          const rsi = computeRSI(c, i, 14);
          const stoch = computeStoch(c, i, 5);
          const streak = computeStreak(c, i);
          const isBear = c[i].close > bb.upper && c[i].close > c[i].open && rsi > rsiT && stoch > stochT && Math.abs(streak) >= 1;
          const isBull = c[i].close < bb.lower && c[i].close < c[i].open && rsi < (100-rsiT) && stoch < (100-stochT) && Math.abs(streak) >= 1;
          return isBear ? 'bear' : isBull ? 'bull' : null;
        }, `RSI>${rsiT}+Stoch>${stochT}+BB10 s>=1`);
        printResult(r);
      }
    }

    // ── Section 4: Hour-of-day optimization for HF80 ─────────────────────────
    console.log('\n[4] Hour-filter on HF80 (BB(20,1.0)) — top hours');
    const hourResults = [];
    for (let h = 0; h < 24; h++) {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.0);
        if (!bb) return null;
        const hour = new Date(c[i].open_time).getUTCHours();
        if (hour !== h) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && Math.abs(streak) >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && Math.abs(streak) >= 1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `BB10 h=${h}`);
      if (r) hourResults.push({ ...r, hour: h });
    }
    hourResults.sort((a, b) => b.wr - a.wr);
    hourResults.slice(0, 8).forEach(r => printResult(r));

    // ── Section 5: Best hour combos for HF80 ─────────────────────────────────
    console.log('\n[5] Best hour combos for HF80 (BB(20,1.0))');
    const topHours = hourResults.slice(0, 6).map(r => r.hour);
    // test combos of 3-5 hours
    for (let n = 3; n <= 6; n++) {
      // try the top N hours
      const hours = topHours.slice(0, n);
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.0);
        if (!bb) return null;
        const hour = new Date(c[i].open_time).getUTCHours();
        if (!hours.includes(hour)) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && Math.abs(streak) >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && Math.abs(streak) >= 1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `BB10 h=[${hours.join(',')}]`);
      printResult(r);
    }
    // all hours
    const rAll = evaluate(candles, (c, i) => {
      const bb = computeBB(c, i, 20, 1.0);
      if (!bb) return null;
      const streak = computeStreak(c, i);
      const isBear = c[i].close > bb.upper && c[i].close > c[i].open && Math.abs(streak) >= 1;
      const isBull = c[i].close < bb.lower && c[i].close < c[i].open && Math.abs(streak) >= 1;
      return isBear ? 'bear' : isBull ? 'bull' : null;
    }, `BB10 ALL-H (baseline)`);
    printResult(rAll);

    // ── Section 6: Adaptive BB period based on ATR regime ────────────────────
    console.log('\n[6] Adaptive BB period + 1.0 mult');
    for (const period of [10, 15, 20, 25, 30]) {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, period, 1.0);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && Math.abs(streak) >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && Math.abs(streak) >= 1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `BB(${period},1.0) ALL-H`);
      printResult(r);
    }

    // ── Section 7: Bear-only asymmetry test ──────────────────────────────────
    console.log('\n[7] Bear-only vs Bull-only asymmetry (BB(20,1.0))');
    {
      const rBear = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.0);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && Math.abs(streak) >= 1;
        return isBear ? 'bear' : null;
      }, `BB10 BEAR-only s>=1`);
      printResult(rBear);

      const rBull = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.0);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && Math.abs(streak) >= 1;
        return isBull ? 'bull' : null;
      }, `BB10 BULL-only s>=1`);
      printResult(rBull);

      // Bear + streak>=2
      const rBear2 = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.0);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && streak >= 2;
        return isBear ? 'bear' : null;
      }, `BB10 BEAR-only s>=2`);
      printResult(rBear2);
    }

    // ── Section 8: Body size filter for HF80 ─────────────────────────────────
    console.log('\n[8] Body filter on BB(20,1.0)');
    for (const bodyPct of [0.05, 0.1, 0.15, 0.2]) {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.0);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const body = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
        if (body < bodyPct) return null;
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && Math.abs(streak) >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && Math.abs(streak) >= 1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `BB10+body>=${bodyPct}% s>=1`);
      printResult(r);
    }

    // ── Section 9: Stoch period variants ─────────────────────────────────────
    console.log('\n[9] Stoch period sweep + BB(20,1.0)');
    for (const stochPeriod of [3, 5, 7, 10, 14]) {
      for (const stochT of [65, 70, 75, 80]) {
        const r = evaluate(candles, (c, i) => {
          const bb = computeBB(c, i, 20, 1.0);
          if (!bb) return null;
          const stoch = computeStoch(c, i, stochPeriod);
          const streak = computeStreak(c, i);
          const isBear = c[i].close > bb.upper && c[i].close > c[i].open && stoch > stochT && Math.abs(streak) >= 1;
          const isBull = c[i].close < bb.lower && c[i].close < c[i].open && stoch < (100-stochT) && Math.abs(streak) >= 1;
          return isBear ? 'bear' : isBull ? 'bull' : null;
        }, `Stoch(${stochPeriod})>${stochT}+BB10 s>=1`);
        printResult(r);
      }
    }
  }

  console.log('\n=== Research Complete ===');
  db.close();
}

main().catch(console.error);
