/**
 * eth15mStability.ts
 * Research: Stabilize ETH/15m strategies (currently σ=7.8% which is high)
 *
 * Tests:
 * 1. Hour filter on ETH/15m (which hours work best?)
 * 2. Volume regime filter on ETH/15m (high-vol vs low-vol regime)
 * 3. Combined: BB(15,2.2) + best hour filter
 * 4. Day-of-week filter on ETH/15m
 * 5. Walk-forward stability of best combo
 */

import { getDb } from '../db';

const db = getDb();

interface RawCandle { open_time: number; open: number; high: number; low: number; close: number; volume: number; }

function getCandles(symbol: string, timeframe: string): RawCandle[] {
  return db.prepare('SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(symbol, timeframe) as RawCandle[];
}

function calcBB(candles: RawCandle[], end: number, period: number, mult: number) {
  if (end < period - 1) return null;
  const slice = candles.slice(end - period + 1, end + 1);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, lower: mid - mult * std, mid };
}

function calcATR(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 0;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    sum += Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
  }
  return sum / period;
}

function calcVolAvg(candles: RawCandle[], end: number, period = 20): number {
  if (end < period) return 0;
  return candles.slice(end - period + 1, end + 1).reduce((s, c) => s + c.volume, 0) / period;
}

function isGreen(c: RawCandle) { return c.close > c.open; }
function isRed(c: RawCandle) { return c.close < c.open; }

// ── Part 1: Hour sweep on ETH/15m ─────────────────────────────────────────────

function hourSweep15m() {
  const candles = getCandles('ETH', '15m');
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  const hourStats: Record<number, { wins: number; total: number }> = {};
  for (let h = 0; h < 24; h++) hourStats[h] = { wins: 0, total: 0 };

  for (let i = 20; i < test.length - 1; i++) {
    const bb = calcBB(test, i, 15, 2.2);
    if (!bb) continue;
    const price = test[i].close;
    if (price <= bb.upper && price >= bb.lower) continue;

    // Count streak ≥ 3
    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      const c = test[j];
      if (isGreen(c)) { if (r > 0) break; g++; }
      else if (isRed(c)) { if (g > 0) break; r++; }
      else break;
    }
    if (g < 3 && r < 3) continue;

    const hour = new Date(test[i].open_time).getUTCHours();
    const win = price > bb.upper ? test[i + 1].close < test[i + 1].open : test[i + 1].close > test[i + 1].open;
    hourStats[hour].total++;
    if (win) hourStats[hour].wins++;
  }

  return hourStats;
}

// ── Part 2: Volume regime filter on ETH/15m ───────────────────────────────────

function volumeRegime15m() {
  const candles = getCandles('ETH', '15m');
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  const results = {
    highVol: { wins: 0, total: 0 },
    lowVol: { wins: 0, total: 0 },
    all: { wins: 0, total: 0 },
  };

  for (let i = 20; i < test.length - 1; i++) {
    const bb = calcBB(test, i, 15, 2.2);
    if (!bb) continue;
    const price = test[i].close;
    if (price <= bb.upper && price >= bb.lower) continue;

    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      const c = test[j];
      if (isGreen(c)) { if (r > 0) break; g++; }
      else if (isRed(c)) { if (g > 0) break; r++; }
      else break;
    }
    if (g < 3 && r < 3) continue;

    const volAvg = calcVolAvg(test, i, 20);
    const isHighVol = volAvg > 0 && test[i].volume > volAvg * 1.5;
    const isLowVol = volAvg > 0 && test[i].volume < volAvg * 0.7;

    const win = price > bb.upper ? test[i + 1].close < test[i + 1].open : test[i + 1].close > test[i + 1].open;

    results.all.total++;
    if (win) results.all.wins++;

    if (isHighVol) {
      results.highVol.total++;
      if (win) results.highVol.wins++;
    } else if (isLowVol) {
      results.lowVol.total++;
      if (win) results.lowVol.wins++;
    }
  }

  return results;
}

// ── Part 3: Combined BB(15,2.2) + hour filter walk-forward ───────────────────

function walkForwardBBHour(period: number, mult: number, goodHours: number[]) {
  const candles = getCandles('ETH', '15m');
  const trainEnd = Math.floor(candles.length * 0.7);
  const testLen = candles.length - trainEnd;
  const foldSize = Math.floor(testLen / 5);
  const warmup = period + 5;

  const foldResults: number[] = [];
  let totalWins = 0, totalTrades = 0;

  for (let fold = 0; fold < 5; fold++) {
    const foldStart = trainEnd + fold * foldSize;
    const foldEnd = fold < 4 ? foldStart + foldSize : candles.length - 1;
    const foldData = candles.slice(Math.max(0, foldStart - warmup - 5), foldEnd);
    const wm = warmup + 5;

    let wins = 0, total = 0;

    for (let i = wm; i < foldData.length - 1; i++) {
      const hour = new Date(foldData[i].open_time).getUTCHours();
      if (goodHours.length > 0 && !goodHours.includes(hour)) continue;

      const bb = calcBB(foldData, i, period, mult);
      if (!bb) continue;
      const price = foldData[i].close;
      if (price <= bb.upper && price >= bb.lower) continue;

      let g = 0, r = 0;
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        const c = foldData[j];
        if (isGreen(c)) { if (r > 0) break; g++; }
        else if (isRed(c)) { if (g > 0) break; r++; }
        else break;
      }
      if (g < 3 && r < 3) continue;

      // Optional: body/ATR filter
      const atr = calcATR(foldData, i);
      if (atr > 0 && Math.abs(foldData[i].close - foldData[i].open) / atr < 0.9) continue;

      total++;
      const win = price > bb.upper ? foldData[i + 1].close < foldData[i + 1].open : foldData[i + 1].close > foldData[i + 1].open;
      if (win) wins++;
    }

    const fwr = total > 0 ? wins / total * 100 : 0;
    foldResults.push(fwr);
    totalWins += wins;
    totalTrades += total;
  }

  const avg = foldResults.reduce((s, w) => s + w, 0) / 5;
  const sigma = Math.sqrt(foldResults.reduce((s, w) => s + (w - avg) ** 2, 0) / 5);
  return {
    wr: totalTrades > 0 ? totalWins / totalTrades * 100 : 0,
    sigma,
    trades: totalTrades,
    folds: foldResults.map(w => w.toFixed(1)),
  };
}

// ── Part 4: Day-of-week analysis ──────────────────────────────────────────────

function dayOfWeekSweep() {
  const candles = getCandles('ETH', '15m');
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  const dayStats: Record<number, { wins: number; total: number }> = {};
  for (let d = 0; d < 7; d++) dayStats[d] = { wins: 0, total: 0 };

  for (let i = 20; i < test.length - 1; i++) {
    const bb = calcBB(test, i, 15, 2.2);
    if (!bb) continue;
    const price = test[i].close;
    if (price <= bb.upper && price >= bb.lower) continue;

    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      const c = test[j];
      if (isGreen(c)) { if (r > 0) break; g++; }
      else if (isRed(c)) { if (g > 0) break; r++; }
      else break;
    }
    if (g < 3 && r < 3) continue;

    const day = new Date(test[i].open_time).getUTCDay();
    const win = price > bb.upper ? test[i + 1].close < test[i + 1].open : test[i + 1].close > test[i + 1].open;
    dayStats[day].total++;
    if (win) dayStats[day].wins++;
  }

  return dayStats;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════');
console.log('📊 ETH/15m STABILITY RESEARCH — BB(15,2.2) OPTIMIZATION');
console.log('══════════════════════════════════════════════════════════════\n');

// Part 1: Hour sweep
console.log('═══ PART 1: HOUR-OF-DAY ANALYSIS (ETH/15m BB(15,2.2)+GGG)');
const hourStats = hourSweep15m();
const sortedHours = Object.entries(hourStats)
  .filter(([_, s]) => s.total >= 5)
  .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total));

console.log('\n  Hour | WR    | Trades');
sortedHours.forEach(([h, s]) => {
  const wr = (s.wins / s.total * 100).toFixed(1);
  const star = parseFloat(wr) >= 75 ? ' ⭐⭐' : parseFloat(wr) >= 70 ? ' ⭐' : parseFloat(wr) < 55 ? ' ❌' : '';
  console.log(`  ${String(h).padStart(4)} | ${wr.padStart(5)}% | ${s.total}${star}`);
});

// Part 2: Volume regime
console.log('\n═══ PART 2: VOLUME REGIME FILTER (ETH/15m BB(15,2.2)+GGG)');
const volRes = volumeRegime15m();
const fmtVol = (r: { wins: number; total: number }) =>
  r.total > 0 ? `WR=${(r.wins/r.total*100).toFixed(1)}% T=${r.total}` : 'no data';
console.log(`  All signals:  ${fmtVol(volRes.all)}`);
console.log(`  High volume:  ${fmtVol(volRes.highVol)}`);
console.log(`  Low volume:   ${fmtVol(volRes.lowVol)}`);

// Part 3: Walk-forward with various hour filters
console.log('\n═══ PART 3: WALK-FORWARD (5 FOLDS) — BB(15,2.2)+bodyATR+HOUR FILTERS');
console.log('   Testing different hour subsets to find most stable ETH/15m config\n');

const hourCombos = [
  { label: 'All hours (baseline)', hours: [] as number[] },
  { label: 'Skip 14:00 UTC', hours: Array.from({length: 24}, (_, i) => i).filter(h => h !== 14) },
  { label: 'Best 6h [0,3,10,12,21,22]', hours: [0, 3, 10, 12, 21, 22] },
  { label: 'Good 4h [10,11,12,21]', hours: [10, 11, 12, 21] },
  { label: 'Skip bad [8,9,14,19,20]', hours: Array.from({length: 24}, (_, i) => i).filter(h => ![8,9,14,19,20].includes(h)) },
  { label: 'EU+US open [8,9,14,15,16]', hours: [8, 9, 14, 15, 16] },
  { label: 'Asia+London [0,1,2,3,8,9,10]', hours: [0, 1, 2, 3, 8, 9, 10] },
  { label: 'Night [20,21,22,23,0,1,2]', hours: [20, 21, 22, 23, 0, 1, 2] },
];

for (const { label, hours } of hourCombos) {
  const r = walkForwardBBHour(15, 2.2, hours);
  const star = r.sigma < 5 && r.wr > 65 ? ' ⭐⭐' : r.sigma < 6 && r.wr > 63 ? ' ⭐' : '';
  console.log(`  WR=${r.wr.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.trades} [${r.folds.join('/')}]${star}`);
  console.log(`    └ ${label}`);
}

// Part 4: Day-of-week
console.log('\n═══ PART 4: DAY-OF-WEEK (ETH/15m BB(15,2.2)+GGG)');
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayStats = dayOfWeekSweep();
Object.entries(dayStats)
  .filter(([_, s]) => s.total >= 5)
  .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))
  .forEach(([d, s]) => {
    const wr = (s.wins / s.total * 100).toFixed(1);
    const star = parseFloat(wr) >= 73 ? ' ⭐' : parseFloat(wr) < 55 ? ' ❌' : '';
    console.log(`  ${dayNames[parseInt(d)]}: WR=${wr}% T=${s.total}${star}`);
  });

// Part 5: Best combined config walk-forward
console.log('\n═══ PART 5: BEST COMBINED CONFIG — SKIP BAD HOURS + BB(15,2.2) + bodyATR');
console.log('   Skip [8,9,14,19,20] reduces noise while keeping enough trades\n');

{
  const skipBad = walkForwardBBHour(15, 2.2, Array.from({length: 24}, (_, i) => i).filter(h => ![8,9,14,19,20].includes(h)));
  const allH = walkForwardBBHour(15, 2.2, []);
  const skip14 = walkForwardBBHour(15, 2.2, Array.from({length: 24}, (_, i) => i).filter(h => h !== 14));

  console.log(`  All hours:         WR=${allH.wr.toFixed(1)}% σ=${allH.sigma.toFixed(1)}% T=${allH.trades}`);
  console.log(`  Skip 14:00:        WR=${skip14.wr.toFixed(1)}% σ=${skip14.sigma.toFixed(1)}% T=${skip14.trades}`);
  console.log(`  Skip bad hours:    WR=${skipBad.wr.toFixed(1)}% σ=${skipBad.sigma.toFixed(1)}% T=${skipBad.trades}`);

  // Also test BB(20,2.5) with skip-bad
  const bb20_25_skipBad = (() => {
    const candles = getCandles('ETH', '15m');
    const trainEnd = Math.floor(candles.length * 0.7);
    const testLen = candles.length - trainEnd;
    const foldSize = Math.floor(testLen / 5);
    const badH = [8, 9, 14, 19, 20];
    const warmup = 25;
    const foldResults: number[] = [];
    let tw = 0, tt = 0;
    for (let fold = 0; fold < 5; fold++) {
      const foldStart = trainEnd + fold * foldSize;
      const foldEnd = fold < 4 ? foldStart + foldSize : candles.length - 1;
      const foldData = candles.slice(Math.max(0, foldStart - warmup - 5), foldEnd);
      let wins = 0, total = 0;
      for (let i = warmup + 5; i < foldData.length - 1; i++) {
        const hour = new Date(foldData[i].open_time).getUTCHours();
        if (badH.includes(hour)) continue;
        const bb = calcBB(foldData, i, 20, 2.5);
        if (!bb) continue;
        const price = foldData[i].close;
        if (price <= bb.upper && price >= bb.lower) continue;
        let g = 0, r2 = 0;
        for (let j = i; j >= Math.max(0, i - 6); j--) {
          const c = foldData[j];
          if (isGreen(c)) { if (r2 > 0) break; g++; }
          else if (isRed(c)) { if (g > 0) break; r2++; }
          else break;
        }
        if (g < 3 && r2 < 3) continue;
        const atr = calcATR(foldData, i);
        if (atr > 0 && Math.abs(foldData[i].close - foldData[i].open) / atr < 0.9) continue;
        total++;
        const win = price > bb.upper ? foldData[i+1].close < foldData[i+1].open : foldData[i+1].close > foldData[i+1].open;
        if (win) wins++;
      }
      const fwr = total > 0 ? wins/total*100 : 0;
      foldResults.push(fwr);
      tw += wins; tt += total;
    }
    const avg = foldResults.reduce((s, w) => s + w, 0) / 5;
    const sigma = Math.sqrt(foldResults.reduce((s, w) => s + (w - avg) ** 2, 0) / 5);
    return { wr: tt > 0 ? tw/tt*100 : 0, sigma, trades: tt, folds: foldResults.map(w => w.toFixed(1)) };
  })();
  console.log(`  BB(20,2.5)+skipBad: WR=${bb20_25_skipBad.wr.toFixed(1)}% σ=${bb20_25_skipBad.sigma.toFixed(1)}% T=${bb20_25_skipBad.trades} [${bb20_25_skipBad.folds.join('/')}]`);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ ETH/15m STABILITY RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
