/**
 * adaptiveBB.ts
 * Research: Adaptive/Optimized Bollinger Band parameters
 *
 * Tests:
 * 1. BB period sweep (10, 15, 20, 25, 30) — which period best fits ETH/BTC mean reversion?
 * 2. BB multiplier sweep (1.5, 1.7, 1.8, 2.0, 2.2, 2.5) — sweet spot for signals
 * 3. Dynamic period: short period (15) in low-vol, long period (25) in high-vol
 * 4. Combo: RGGG/GRGG + best BB params — cross-coin validation
 * 5. Best parameter set walk-forward on ETH/5m and ETH/15m
 */

import { getDb } from '../db';

const db = getDb();

interface RawCandle { open_time: number; open: number; high: number; low: number; close: number; volume: number; }

function getCandles(symbol: string, timeframe: string): RawCandle[] {
  return db.prepare(
    'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
  ).all(symbol, timeframe) as RawCandle[];
}

function calcBB(candles: RawCandle[], end: number, period: number, mult: number): { upper: number; lower: number; mid: number; std: number } | null {
  if (end < period - 1) return null;
  const slice = candles.slice(end - period + 1, end + 1);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, lower: mid - mult * std, mid, std };
}

function calcATR(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 0;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function isGreen(c: RawCandle) { return c.close > c.open; }
function isRed(c: RawCandle) { return c.close < c.open; }

// ── Part 1: Period sweep — GGG+BB signal ──────────────────────────────────────

function testBBPeriod(symbol: string, timeframe: string, period: number, mult: number, streakLen: number) {
  const candles = getCandles(symbol, timeframe);
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);
  const warmup = period + 5;

  let bullW = 0, bullT = 0, bearW = 0, bearT = 0;

  for (let i = warmup + streakLen - 1; i < test.length - 1; i++) {
    const bb = calcBB(test, i, period, mult);
    if (!bb) continue;
    const price = test[i].close;

    // Count streak
    let green = 0, red = 0;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      const c = test[j];
      if (isGreen(c)) { if (red > 0) break; green++; }
      else if (isRed(c)) { if (green > 0) break; red++; }
      else break;
    }

    if (green >= streakLen && price > bb.upper) {
      bearT++;
      if (test[i + 1].close < test[i + 1].open) bearW++;
    }
    if (red >= streakLen && price < bb.lower) {
      bullT++;
      if (test[i + 1].close > test[i + 1].open) bullW++;
    }
  }

  const total = bullT + bearT;
  const wins = bullW + bearW;
  return { wr: total > 0 ? wins / total * 100 : 0, trades: total, bullWR: bullT > 0 ? bullW/bullT*100 : 0, bearWR: bearT > 0 ? bearW/bearT*100 : 0 };
}

// ── Part 2: Adaptive period — low-vol uses shorter period, high-vol uses longer ──────────

function testAdaptivePeriod(symbol: string, timeframe: string) {
  const candles = getCandles(symbol, timeframe);
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  // Compute ATR percentile thresholds on test data
  const atrs: number[] = [];
  for (let i = 14; i < test.length; i++) atrs.push(calcATR(test, i, 14));
  atrs.sort((a, b) => a - b);
  const atr33 = atrs[Math.floor(atrs.length * 0.33)];
  const atr66 = atrs[Math.floor(atrs.length * 0.66)];

  interface Regime { wins: number; trades: number; }
  const results: Record<string, Regime> = {
    lowATR_short: { wins: 0, trades: 0 },  // ATR<33th, period=15, mult=2
    lowATR_long: { wins: 0, trades: 0 },   // ATR<33th, period=25, mult=2
    highATR_short: { wins: 0, trades: 0 }, // ATR>66th, period=15, mult=2
    highATR_long: { wins: 0, trades: 0 },  // ATR>66th, period=25, mult=2
    adaptive: { wins: 0, trades: 0 },      // adaptive: lowATR→period=15, highATR→period=25
    fixed20: { wins: 0, trades: 0 },       // baseline: period=20
  };

  for (let i = 26; i < test.length - 1; i++) {
    const atr = calcATR(test, i, 14);
    const regime = atr < atr33 ? 'low' : atr > atr66 ? 'high' : 'mid';
    if (regime === 'mid') continue; // skip middle regime for cleaner comparison

    const price = test[i].close;

    // Count streak
    let green = 0, red = 0;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      const c = test[j];
      if (isGreen(c)) { if (red > 0) break; green++; }
      else if (isRed(c)) { if (green > 0) break; red++; }
      else break;
    }

    const streak = Math.max(green, red);
    if (streak < 3) continue;
    const isBear = green >= 3;

    const nextIsWin = isBear
      ? (test[i + 1].close < test[i + 1].open)
      : (test[i + 1].close > test[i + 1].open);

    // Test each configuration
    const configs = [
      { key: regime === 'low' ? 'lowATR_short' : 'highATR_short', bb: calcBB(test, i, 15, 2) },
      { key: regime === 'low' ? 'lowATR_long' : 'highATR_long', bb: calcBB(test, i, 25, 2) },
      { key: 'adaptive', bb: calcBB(test, i, regime === 'low' ? 15 : 25, 2) },
      { key: 'fixed20', bb: calcBB(test, i, 20, 2) },
    ];

    for (const { key, bb } of configs) {
      if (!bb) continue;
      const outside = isBear ? price > bb.upper : price < bb.lower;
      if (outside) {
        results[key].trades++;
        if (nextIsWin) results[key].wins++;
      }
    }
  }

  return results;
}

// ── Part 3: Best params for RGGG pattern ─────────────────────────────────────

function testRGGGWithParams(symbol: string, timeframe: string, period: number, mult: number) {
  const candles = getCandles(symbol, timeframe);
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);
  const warmup = period + 5;

  let wins = 0, total = 0;

  for (let i = warmup + 3; i < test.length - 1; i++) {
    const c3 = test[i - 3], c2 = test[i - 2], c1 = test[i - 1], c0 = test[i];
    const bb = calcBB(test, i, period, mult);
    if (!bb) continue;
    const price = c0.close;

    // RGGG → BEAR
    const rggg = isRed(c3) && isGreen(c2) && isGreen(c1) && isGreen(c0) && price > bb.upper;
    // GRGG → BEAR
    const grgg = isGreen(c3) && isRed(c2) && isGreen(c1) && isGreen(c0) && price > bb.upper;
    // Mirror: GRRR/RGRR → BULL
    const grrr = isGreen(c3) && isRed(c2) && isRed(c1) && isRed(c0) && price < bb.lower;
    const rgrr = isRed(c3) && isGreen(c2) && isRed(c1) && isRed(c0) && price < bb.lower;

    if (rggg || grgg || grrr || rgrr) {
      total++;
      const isBear = rggg || grgg;
      const win = isBear ? test[i + 1].close < test[i + 1].open : test[i + 1].close > test[i + 1].open;
      if (win) wins++;
    }
  }

  return { wr: total > 0 ? wins / total * 100 : 0, trades: total };
}

// ── Part 4: Walk-forward of best BB params ───────────────────────────────────

function walkForwardParams(symbol: string, timeframe: string, period: number, mult: number) {
  const candles = getCandles(symbol, timeframe);
  const trainEnd = Math.floor(candles.length * 0.7);
  const testLen = candles.length - trainEnd;
  const foldSize = Math.floor(testLen / 5);

  const folds: Array<{ wins: number; total: number }> = [];

  for (let fold = 0; fold < 5; fold++) {
    const foldStart = trainEnd + fold * foldSize;
    const foldEnd = fold < 4 ? foldStart + foldSize : candles.length - 1;
    const foldData = candles.slice(Math.max(0, foldStart - period - 10), foldEnd);
    const warmup = period + 10;

    let wins = 0, total = 0;

    for (let i = warmup; i < foldData.length - 1; i++) {
      const bb = calcBB(foldData, i, period, mult);
      if (!bb) continue;
      const price = foldData[i].close;

      // GGG+BB
      let green = 0, red = 0;
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        const c = foldData[j];
        if (isGreen(c)) { if (red > 0) break; green++; }
        else if (isRed(c)) { if (green > 0) break; red++; }
        else break;
      }

      if (green >= 3 && price > bb.upper) {
        total++;
        if (foldData[i + 1].close < foldData[i + 1].open) wins++;
      }
      if (red >= 3 && price < bb.lower) {
        total++;
        if (foldData[i + 1].close > foldData[i + 1].open) wins++;
      }
    }

    folds.push({ wins, total });
  }

  const allWins = folds.reduce((s, f) => s + f.wins, 0);
  const allTotal = folds.reduce((s, f) => s + f.total, 0);
  const wrs = folds.map(f => f.total > 0 ? f.wins / f.total * 100 : 0);
  const avg = wrs.reduce((s, w) => s + w, 0) / wrs.length;
  const sigma = Math.sqrt(wrs.reduce((s, w) => s + (w - avg) ** 2, 0) / wrs.length);

  return {
    overallWR: allTotal > 0 ? allWins / allTotal * 100 : 0,
    foldWRs: wrs.map(w => w.toFixed(1)),
    sigma: sigma.toFixed(1),
    totalTrades: allTotal,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════');
console.log('📊 ADAPTIVE BB THRESHOLD RESEARCH');
console.log('══════════════════════════════════════════════════════════════\n');

// ── Part 1: Period × Multiplier grid ─────────────────────────────────────────

console.log('═══ PART 1: BB PERIOD × MULTIPLIER GRID (GGG+BB, streak≥3)');
console.log('   ETH/5m out-of-sample test period\n');

const periods = [10, 15, 20, 25, 30];
const mults = [1.5, 1.8, 2.0, 2.2, 2.5];

console.log('   Period |   1.5    1.8    2.0    2.2    2.5');
console.log('   --------|-------------------------------');
for (const p of periods) {
  const row = mults.map(m => {
    const r = testBBPeriod('ETH', '5m', p, m, 3);
    return `${r.wr.toFixed(0)}%(${r.trades})`.padStart(9);
  }).join(' ');
  console.log(`   ${String(p).padStart(6)}  | ${row}`);
}

console.log('\n   ETH/15m out-of-sample:');
console.log('   Period |   1.5    1.8    2.0    2.2    2.5');
console.log('   --------|-------------------------------');
for (const p of periods) {
  const row = mults.map(m => {
    const r = testBBPeriod('ETH', '15m', p, m, 3);
    return `${r.wr.toFixed(0)}%(${r.trades})`.padStart(9);
  }).join(' ');
  console.log(`   ${String(p).padStart(6)}  | ${row}`);
}

// ── Part 2: Adaptive period (regime-dependent) ──────────────────────────────

console.log('\n═══ PART 2: ADAPTIVE PERIOD (low-vol=short period, high-vol=long period)');
console.log('   Comparing fixed BB(20,2) vs adaptive period based on ATR regime\n');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m'], ['BTC', '15m']] as const) {
  console.log(`${sym}/${tf}:`);
  const r = testAdaptivePeriod(sym, tf);
  const fmt = (k: string) => {
    const v = r[k];
    return `WR=${(v.trades > 0 ? v.wins/v.trades*100 : 0).toFixed(1)}% T=${v.trades}`;
  };
  console.log(`  Low-ATR BB(15,2):   ${fmt('lowATR_short')}`);
  console.log(`  Low-ATR BB(25,2):   ${fmt('lowATR_long')}`);
  console.log(`  High-ATR BB(15,2):  ${fmt('highATR_short')}`);
  console.log(`  High-ATR BB(25,2):  ${fmt('highATR_long')}`);
  console.log(`  Adaptive (15/25):   ${fmt('adaptive')} ← auto-select based on regime`);
  console.log(`  Fixed BB(20,2):     ${fmt('fixed20')} ← baseline`);
}

// ── Part 3: RGGG pattern with different BB params ─────────────────────────────

console.log('\n═══ PART 3: RGGG/GRGG/GRRR PATTERN — BB PARAMETER SWEEP');
console.log('   Finding best BB params for Recovery Rally Exhaustion strategy\n');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m'], ['BTC', '15m']] as const) {
  console.log(`${sym}/${tf}:`);
  const configs = [[15, 1.8], [15, 2.0], [20, 1.8], [20, 2.0], [20, 2.2], [25, 2.0]];
  for (const [p, m] of configs) {
    const r = testRGGGWithParams(sym, tf, p, m);
    const star = r.wr >= 70 ? ' ⭐' : r.wr >= 65 ? ' ✓' : '';
    console.log(`  BB(${p},${m}): WR=${r.wr.toFixed(1)}% T=${r.trades}${star}`);
  }
}

// ── Part 4: Walk-forward best 2 BB configs ───────────────────────────────────

console.log('\n═══ PART 4: WALK-FORWARD (5 FOLDS) — GGG+BB ON ETH/5m');
console.log('   Comparing best candidate parameters\n');

for (const [p, m] of [[15, 2.0], [20, 1.5], [20, 2.0], [25, 2.0], [20, 2.2]] as const) {
  const r = walkForwardParams('ETH', '5m', p, m);
  const star = parseFloat(r.sigma) < 4 && r.overallWR > 60 ? ' ⭐' : '';
  console.log(`  BB(${p},${m}): WR=${r.overallWR.toFixed(1)}% T=${r.totalTrades} σ=${r.sigma}% folds=[${r.foldWRs.join('/')}]${star}`);
}

console.log('\n   ETH/15m:');
for (const [p, m] of [[15, 2.0], [20, 2.0], [25, 2.0]] as const) {
  const r = walkForwardParams('ETH', '15m', p, m);
  const star = parseFloat(r.sigma) < 5 && r.overallWR > 62 ? ' ⭐' : '';
  console.log(`  BB(${p},${m}): WR=${r.overallWR.toFixed(1)}% T=${r.totalTrades} σ=${r.sigma}% folds=[${r.foldWRs.join('/')}]${star}`);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ ADAPTIVE BB RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
console.log('\nKey questions answered:');
console.log('  - Is BB(20,2) optimal, or would a different period/mult improve WR?');
console.log('  - Does regime-adaptive period selection add value?');
console.log('  - What are the best params for the new RGGG/GRGG pattern?');
