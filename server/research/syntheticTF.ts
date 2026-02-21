/**
 * syntheticTF.ts
 *
 * Research: Use 5m candles to synthesize higher timeframe signals
 *
 * Key problem: Best signals found on ETH/15m (73.1% WR σ=3.6% for A+B ensemble),
 * but the live system only has 5m candles.
 *
 * Approach 1: Aggregate 5m → 15m on-the-fly by grouping every 3 candles
 * Approach 2: Use longer-period lookbacks on 5m (streak≥6 ≈ streak≥2 on 15m)
 * Approach 3: Use day-of-week filter (Saturday best for ETH/15m = 79.2%)
 *
 * Tests:
 * 1. Synthetic 15m from 5m candles: full A+B ensemble
 * 2. Longer streak on 5m to approximate 15m patterns
 * 3. Day-of-week × hour filter combinations
 * 4. Weekend filter specifically (Saturday effect)
 * 5. Pivot-style daily range filter: is price near daily high/low?
 * 6. Walk-forward of best synthetic approaches
 */

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

interface RawCandle {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SynthCandle {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Aggregate N 5m candles into 1 synthetic Nm candle
function aggregateCandles(candles5m: RawCandle[], n: number): SynthCandle[] {
  const result: SynthCandle[] = [];
  for (let i = 0; i + n <= candles5m.length; i += n) {
    const slice = candles5m.slice(i, i + n);
    result.push({
      open_time: slice[0].open_time,
      open: slice[0].open,
      high: Math.max(...slice.map(c => c.high)),
      low: Math.min(...slice.map(c => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

function calcBB(candles: { close: number }[], end: number, period = 20, mult = 2.0) {
  if (end < period - 1) return null;
  const slice = candles.slice(end - period + 1, end + 1);
  const closes = slice.map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, lower: mean - mult * std, middle: mean, std };
}

function calcATR(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 0;
  let atrSum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    atrSum += tr;
  }
  return atrSum / period;
}

function calcMFI(candles: RawCandle[], end: number, period = 10): number {
  if (end < period) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = i > 0 ? (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3 : tp;
    const mf = tp * candles[i].volume;
    if (tp > prevTp) posFlow += mf;
    else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

type Dir = 'G' | 'R';
function getDir(c: { open: number; close: number }): Dir { return c.close >= c.open ? 'G' : 'R'; }

const GOOD_HOURS = [10, 11, 12, 21];
const EXT_HOURS = [10, 11, 12, 21, 22, 23];

// ─── PART 1: Synthetic 15m from ETH/5m — A+B ensemble ───────────────────
console.log('══════════════════════════════════════════════════════════════');
console.log('SYNTHETIC TIMEFRAME RESEARCH');
console.log('══════════════════════════════════════════════════════════════\n');

console.log('PART 1: Synthetic 15m candles from ETH/5m — A+B ensemble');
console.log('─────────────────────────────────────────────────');

const eth5m = db.prepare(
  'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
).all('ETH', '5m') as RawCandle[];

const synth15m = aggregateCandles(eth5m, 3);
console.log(`  ETH/5m candles: ${eth5m.length}  →  Synth 15m: ${synth15m.length}`);

// Test A+B on synthetic 15m
// Signal A: GoodH[10,11,12,21] + BB(20,2.2) + streak≥2
// Signal B: streak≥3 + BB(20,2.0)
{
  const wins: number[] = [];
  for (let i = 22; i < synth15m.length - 1; i++) {
    const c = synth15m[i];
    const hour = new Date(c.open_time).getUTCHours();
    const bb22 = calcBB(synth15m, i, 20, 2.2);
    const bb20 = calcBB(synth15m, i, 20, 2.0);
    if (!bb22 || !bb20) continue;

    const price = c.close;
    const isBearBB22 = price > bb22.upper;
    const isBullBB22 = price < bb22.lower;
    const isBearBB20 = price > bb20.upper;
    const isBullBB20 = price < bb20.lower;

    // Streak
    let streakLen = 1;
    const dir = getDir(c);
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      if (getDir(synth15m[j]) === dir) streakLen++;
      else break;
    }

    // Signal A (bear or bull)
    const sigA_bear = GOOD_HOURS.includes(hour) && isBearBB22 && dir === 'G' && streakLen >= 2;
    const sigA_bull = GOOD_HOURS.includes(hour) && isBullBB22 && dir === 'R' && streakLen >= 2;
    // Signal B
    const sigB_bear = dir === 'G' && streakLen >= 3 && isBearBB20;
    const sigB_bull = dir === 'R' && streakLen >= 3 && isBullBB20;

    const abBear = sigA_bear && sigB_bear;
    const abBull = sigA_bull && sigB_bull;
    if (!abBear && !abBull) continue;

    const nextC = synth15m[i + 1];
    const correct = abBear ? nextC.close < nextC.open : nextC.close > nextC.open;
    wins.push(correct ? 1 : 0);
  }
  const wr = wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0;
  console.log(`  Synth 15m A+B ensemble (GoodH+BB22+s≥2 AND s≥3+BB20)    WR=${(wr*100).toFixed(1)}%  T=${wins.length}`);
}

// Compare: SigA alone on synth 15m
{
  const wins: number[] = [];
  for (let i = 22; i < synth15m.length - 1; i++) {
    const c = synth15m[i];
    const hour = new Date(c.open_time).getUTCHours();
    const bb22 = calcBB(synth15m, i, 20, 2.2);
    if (!bb22) continue;
    const price = c.close;
    let streakLen = 1;
    const dir = getDir(c);
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      if (getDir(synth15m[j]) === dir) streakLen++;
      else break;
    }
    const sigBear = GOOD_HOURS.includes(hour) && price > bb22.upper && dir === 'G' && streakLen >= 2;
    const sigBull = GOOD_HOURS.includes(hour) && price < bb22.lower && dir === 'R' && streakLen >= 2;
    if (!sigBear && !sigBull) continue;
    const nextC = synth15m[i + 1];
    const correct = sigBear ? nextC.close < nextC.open : nextC.close > nextC.open;
    wins.push(correct ? 1 : 0);
  }
  const wr = wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0;
  console.log(`  Synth 15m SigA alone (GoodH+BB22+streak≥2)                WR=${(wr*100).toFixed(1)}%  T=${wins.length}`);
}

// Also test Synth 15m RGGG/GRGG+GoodH+BB(15,2.2) — the 81% result
{
  const wins: number[] = [];
  for (let i = 17; i < synth15m.length - 1; i++) {
    const c = synth15m[i];
    const hour = new Date(c.open_time).getUTCHours();
    const bb = calcBB(synth15m, i, 15, 2.2);
    if (!bb) continue;
    const price = c.close;
    const isBear = price > bb.upper;
    const isBull = price < bb.lower;
    if (!isBear && !isBull) continue;
    if (!GOOD_HOURS.includes(hour)) continue;
    if (i < 3) continue;
    const seq = [getDir(synth15m[i-3]), getDir(synth15m[i-2]), getDir(synth15m[i-1]), getDir(c)].join('');
    const match = (isBear && (seq === 'RGGG' || seq === 'GRGG')) || (isBull && (seq === 'RRRG' || seq === 'GRRR'));
    if (!match) continue;
    const nextC = synth15m[i + 1];
    const correct = isBear ? nextC.close < nextC.open : nextC.close > nextC.open;
    wins.push(correct ? 1 : 0);
  }
  const wr = wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0;
  console.log(`  Synth 15m RGGG/GRGG+GoodH+BB(15,2.2)                     WR=${(wr*100).toFixed(1)}%  T=${wins.length}`);
}

// ─── PART 2: Day-of-Week Filter ──────────────────────────────────────────
console.log('\nPART 2: Day-of-Week Filter (ETH/5m)');
console.log('─────────────────────────────────────────────────');

const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function testDayFilter(candles: RawCandle[], dayFilter: number[] | null, hourFilter: number[] | null, bbPeriod: number, bbMult: number, streakMin: number) {
  const wins: number[] = [];
  for (let i = bbPeriod + 4; i < candles.length - 1; i++) {
    const c = candles[i];
    const dt = new Date(c.open_time);
    const hour = dt.getUTCHours();
    const day = dt.getUTCDay();
    if (dayFilter && !dayFilter.includes(day)) continue;
    if (hourFilter && !hourFilter.includes(hour)) continue;
    const bb = calcBB(candles, i, bbPeriod, bbMult);
    if (!bb) continue;
    const price = c.close;
    const isBear = price > bb.upper;
    const isBull = price < bb.lower;
    if (!isBear && !isBull) continue;
    let streakLen = 1;
    const dir = getDir(c);
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      if (getDir(candles[j]) === dir) streakLen++;
      else break;
    }
    if (streakLen < streakMin) continue;
    const nextC = candles[i + 1];
    const correct = isBear ? nextC.close < nextC.open : nextC.close > nextC.open;
    wins.push(correct ? 1 : 0);
  }
  return { wr: wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0, trades: wins.length };
}

// Day × GoodH breakdown
for (let d = 0; d < 7; d++) {
  const r = testDayFilter(eth5m, [d], GOOD_HOURS, 20, 2.2, 2);
  const flag = r.wr >= 0.73 && r.trades >= 15 ? ' ⭐⭐⭐' : r.wr >= 0.70 && r.trades >= 10 ? ' ⭐⭐' : r.wr >= 0.67 && r.trades >= 8 ? ' ⭐' : '';
  console.log(`  Day=${days[d]} + GoodH + BB(20,2.2) + streak≥2  WR=${(r.wr*100).toFixed(1)}%  T=${r.trades}${flag}`);
}

// Combine best days
const weekdays = [1, 2, 3, 4]; // Mon-Thu
const weekend = [0, 6]; // Sun+Sat
const midWeek = [2, 3]; // Tue+Wed

for (const [label, dayFilter] of [['Weekdays(1-4)', weekdays], ['Weekend(0,6)', weekend], ['Tue+Wed', midWeek], ['Sat only', [6]], ['Sun only', [0]], ['Tue+Wed+Sat', [2,3,6]]] as [string, number[]][]) {
  const r = testDayFilter(eth5m, dayFilter, GOOD_HOURS, 20, 2.2, 2);
  const flag = r.wr >= 0.73 && r.trades >= 20 ? ' ⭐⭐⭐' : r.wr >= 0.70 && r.trades >= 15 ? ' ⭐⭐' : r.wr >= 0.67 && r.trades >= 10 ? ' ⭐' : '';
  console.log(`  ${label.padEnd(20)} + GoodH + BB(20,2.2) + streak≥2  WR=${(r.wr*100).toFixed(1)}%  T=${r.trades}${flag}`);
}

// ─── PART 3: ETH/15m Day-of-Week ─────────────────────────────────────────
console.log('\nPART 3: Day-of-Week Filter (ETH/15m)');
console.log('─────────────────────────────────────────────────');

const eth15m = db.prepare(
  'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
).all('ETH', '15m') as RawCandle[];

for (let d = 0; d < 7; d++) {
  const r = testDayFilter(eth15m, [d], GOOD_HOURS, 20, 2.2, 2);
  const flag = r.wr >= 0.75 && r.trades >= 10 ? ' ⭐⭐⭐' : r.wr >= 0.70 && r.trades >= 8 ? ' ⭐⭐' : r.wr >= 0.65 && r.trades >= 5 ? ' ⭐' : '';
  console.log(`  ETH/15m Day=${days[d]} + GoodH + BB(20,2.2) + streak≥2  WR=${(r.wr*100).toFixed(1)}%  T=${r.trades}${flag}`);
}

// Best day combos on 15m
for (const [label, dayFilter] of [['Sat+Fri', [5,6]], ['Sat only', [6]], ['Fri+Sat+Sun', [5,6,0]], ['Tue+Wed+Thu', [2,3,4]]] as [string, number[]][]) {
  const r = testDayFilter(eth15m, dayFilter, GOOD_HOURS, 20, 2.2, 2);
  const flag = r.wr >= 0.78 && r.trades >= 12 ? ' ⭐⭐⭐' : r.wr >= 0.73 && r.trades >= 8 ? ' ⭐⭐' : r.wr >= 0.68 && r.trades >= 5 ? ' ⭐' : '';
  console.log(`  ETH/15m ${label.padEnd(16)} + GoodH + BB(20,2.2)  WR=${(r.wr*100).toFixed(1)}%  T=${r.trades}${flag}`);
}

// ─── PART 4: Streak≥6 on 5m as proxy for 15m streak≥2 ──────────────────
console.log('\nPART 4: Long streak on 5m as 15m proxy');
console.log('─────────────────────────────────────────────────');

function testStreakProxy(candles: RawCandle[], minStreak: number, bbPeriod: number, bbMult: number, hourFilter: number[] | null) {
  const wins: number[] = [];
  for (let i = bbPeriod + 4; i < candles.length - 1; i++) {
    const c = candles[i];
    const hour = new Date(c.open_time).getUTCHours();
    if (hourFilter && !hourFilter.includes(hour)) continue;
    const bb = calcBB(candles, i, bbPeriod, bbMult);
    if (!bb) continue;
    const price = c.close;
    const isBear = price > bb.upper;
    const isBull = price < bb.lower;
    if (!isBear && !isBull) continue;
    let streakLen = 1;
    const dir = getDir(c);
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      if (getDir(candles[j]) === dir) streakLen++;
      else break;
    }
    if (streakLen < minStreak) continue;
    const nextC = candles[i + 1];
    const correct = isBear ? nextC.close < nextC.open : nextC.close > nextC.open;
    wins.push(correct ? 1 : 0);
  }
  return { wr: wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0, trades: wins.length };
}

for (const minStr of [3, 4, 5, 6, 7, 8]) {
  const goodH = testStreakProxy(eth5m, minStr, 20, 2.2, GOOD_HOURS);
  const extH = testStreakProxy(eth5m, minStr, 20, 2.2, EXT_HOURS);
  const noH = testStreakProxy(eth5m, minStr, 20, 2.2, null);
  console.log(`  streak≥${minStr} ETH/5m: noH WR=${(noH.wr*100).toFixed(1)}% T=${noH.trades} | extH WR=${(extH.wr*100).toFixed(1)}% T=${extH.trades} | goodH WR=${(goodH.wr*100).toFixed(1)}% T=${goodH.trades}`);
}

// ─── PART 5: Daily range position filter ────────────────────────────────
console.log('\nPART 5: Daily range position filter + GoodH + BB');
console.log('─────────────────────────────────────────────────');
// Filter: is price in bottom/top 25% of today's range?
function testDailyRangeFilter(candles: RawCandle[], rangePos: 'top' | 'bottom', bbPeriod: number, bbMult: number, hourFilter: number[] | null, streakMin: number) {
  const wins: number[] = [];

  // First build a map of daily ranges
  const dailyRanges: Map<string, { high: number; low: number }> = new Map();
  for (const c of candles) {
    const dt = new Date(c.open_time);
    const dateKey = `${dt.getUTCFullYear()}-${dt.getUTCMonth()}-${dt.getUTCDate()}`;
    const existing = dailyRanges.get(dateKey);
    if (!existing) {
      dailyRanges.set(dateKey, { high: c.high, low: c.low });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
    }
  }

  for (let i = bbPeriod + 4; i < candles.length - 1; i++) {
    const c = candles[i];
    const hour = new Date(c.open_time).getUTCHours();
    if (hourFilter && !hourFilter.includes(hour)) continue;
    const bb = calcBB(candles, i, bbPeriod, bbMult);
    if (!bb) continue;
    const price = c.close;
    const isBear = price > bb.upper;
    const isBull = price < bb.lower;
    if (!isBear && !isBull) continue;
    // Check range position
    const dt = new Date(c.open_time);
    const dateKey = `${dt.getUTCFullYear()}-${dt.getUTCMonth()}-${dt.getUTCDate()}`;
    const dr = dailyRanges.get(dateKey);
    if (!dr) continue;
    const rangeWidth = dr.high - dr.low;
    if (rangeWidth === 0) continue;
    const posInRange = (price - dr.low) / rangeWidth; // 0=bottom, 1=top
    if (rangePos === 'top' && posInRange < 0.7) continue; // not in top 30%
    if (rangePos === 'bottom' && posInRange > 0.3) continue; // not in bottom 30%
    // Range position aligns with direction?
    if (rangePos === 'top' && !isBear) continue; // at top, expect bear
    if (rangePos === 'bottom' && !isBull) continue;
    // Streak
    let streakLen = 1;
    const dir = getDir(c);
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
      if (getDir(candles[j]) === dir) streakLen++;
      else break;
    }
    if (streakLen < streakMin) continue;
    const nextC = candles[i + 1];
    const correct = isBear ? nextC.close < nextC.open : nextC.close > nextC.open;
    wins.push(correct ? 1 : 0);
  }
  return { wr: wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0, trades: wins.length };
}

for (const [label, pos, hours] of [
  ['Top 30% daily range + GoodH + BB(20,2.2)', 'top', GOOD_HOURS],
  ['Bottom 30% daily range + GoodH + BB(20,2.2)', 'bottom', GOOD_HOURS],
  ['Top 30% daily range + ExtH + BB(20,2.2)', 'top', EXT_HOURS],
  ['Top 30% daily range + no hour + BB(20,2.2)', 'top', null],
] as [string, 'top' | 'bottom', number[] | null][]) {
  const r = testDailyRangeFilter(eth5m, pos, 20, 2.2, hours, 2);
  const flag = r.wr >= 0.73 && r.trades >= 20 ? ' ⭐⭐⭐' : r.wr >= 0.70 && r.trades >= 15 ? ' ⭐⭐' : r.wr >= 0.67 && r.trades >= 10 ? ' ⭐' : '';
  console.log(`  ${label.padEnd(50)} WR=${(r.wr*100).toFixed(1)}%  T=${r.trades}${flag}`);
}

// ─── PART 6: Walk-Forward of Synthetic 15m approaches ───────────────────
console.log('\nPART 6: Walk-Forward (3 folds) of best synthetic approaches');
console.log('─────────────────────────────────────────────────');

function walkForwardSynth(
  candles: RawCandle[],
  testFn: (c: RawCandle[], i: number) => { fire: boolean; dir: 'bear' | 'bull' } | null,
  folds = 3
) {
  const foldSize = Math.floor(candles.length / folds);
  const foldWRs: number[] = [];
  let totalTrades = 0;

  for (let f = 0; f < folds; f++) {
    const start = Math.max(30, f * foldSize);
    const end = (f === folds - 1) ? candles.length - 1 : (f + 1) * foldSize - 1;
    const foldC = candles.slice(0, end + 1);
    const wins: number[] = [];

    for (let i = start; i < end; i++) {
      const result = testFn(foldC, i);
      if (!result || !result.fire) continue;
      const nextC = foldC[i + 1];
      if (!nextC) continue;
      const correct = result.dir === 'bear'
        ? nextC.close < nextC.open
        : nextC.close > nextC.open;
      wins.push(correct ? 1 : 0);
    }
    foldWRs.push(wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0);
    totalTrades += wins.length;
  }

  const mean = foldWRs.reduce((a, b) => a + b, 0) / folds;
  const sigma = Math.sqrt(foldWRs.reduce((s, w) => s + Math.pow(w - mean, 2), 0) / folds);
  return { wr: mean, sigma, foldWRs, totalTrades };
}

// A+B ensemble on synth 15m
const synthTests = [
  {
    name: 'Synth15m A+B ensemble',
    candles: synth15m as unknown as RawCandle[],
    fn: (c: typeof synth15m, i: number) => {
      if (i < 22) return null;
      const curr = c[i];
      const hour = new Date(curr.open_time).getUTCHours();
      const bb22 = calcBB(c, i, 20, 2.2);
      const bb20 = calcBB(c, i, 20, 2.0);
      if (!bb22 || !bb20) return null;
      const price = curr.close;
      let streakLen = 1;
      const dir = getDir(curr);
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        if (getDir(c[j]) === dir) streakLen++;
        else break;
      }
      const sigA_bear = GOOD_HOURS.includes(hour) && price > bb22.upper && dir === 'G' && streakLen >= 2;
      const sigA_bull = GOOD_HOURS.includes(hour) && price < bb22.lower && dir === 'R' && streakLen >= 2;
      const sigB_bear = dir === 'G' && streakLen >= 3 && price > bb20.upper;
      const sigB_bull = dir === 'R' && streakLen >= 3 && price < bb20.lower;
      if (sigA_bear && sigB_bear) return { fire: true, dir: 'bear' as const };
      if (sigA_bull && sigB_bull) return { fire: true, dir: 'bull' as const };
      return null;
    }
  },
  {
    name: 'ETH/5m streak≥5+GoodH+BB(20,2.2)',
    candles: eth5m,
    fn: (c: RawCandle[], i: number) => {
      if (i < 22) return null;
      const curr = c[i];
      const hour = new Date(curr.open_time).getUTCHours();
      if (!GOOD_HOURS.includes(hour)) return null;
      const bb = calcBB(c, i, 20, 2.2);
      if (!bb) return null;
      const price = curr.close;
      let streakLen = 1;
      const dir = getDir(curr);
      for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
        if (getDir(c[j]) === dir) streakLen++;
        else break;
      }
      if (streakLen < 5) return null;
      if (price > bb.upper && dir === 'G') return { fire: true, dir: 'bear' as const };
      if (price < bb.lower && dir === 'R') return { fire: true, dir: 'bull' as const };
      return null;
    }
  },
  {
    name: 'ETH/5m Sat+Sun+GoodH+BB(20,2.2)+s≥2',
    candles: eth5m,
    fn: (c: RawCandle[], i: number) => {
      if (i < 22) return null;
      const curr = c[i];
      const dt = new Date(curr.open_time);
      const hour = dt.getUTCHours();
      const day = dt.getUTCDay();
      if (![0, 6].includes(day)) return null;
      if (!GOOD_HOURS.includes(hour)) return null;
      const bb = calcBB(c, i, 20, 2.2);
      if (!bb) return null;
      const price = curr.close;
      let streakLen = 1;
      const dir = getDir(curr);
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        if (getDir(c[j]) === dir) streakLen++;
        else break;
      }
      if (streakLen < 2) return null;
      if (price > bb.upper && dir === 'G') return { fire: true, dir: 'bear' as const };
      if (price < bb.lower && dir === 'R') return { fire: true, dir: 'bull' as const };
      return null;
    }
  },
  {
    name: 'ETH/5m Sat only+GoodH+BB(20,2.2)+s≥2',
    candles: eth5m,
    fn: (c: RawCandle[], i: number) => {
      if (i < 22) return null;
      const curr = c[i];
      const dt = new Date(curr.open_time);
      const hour = dt.getUTCHours();
      const day = dt.getUTCDay();
      if (day !== 6) return null;
      if (!GOOD_HOURS.includes(hour)) return null;
      const bb = calcBB(c, i, 20, 2.2);
      if (!bb) return null;
      const price = curr.close;
      let streakLen = 1;
      const dir = getDir(curr);
      for (let j = i - 1; j >= Math.max(0, i - 8); j--) {
        if (getDir(c[j]) === dir) streakLen++;
        else break;
      }
      if (streakLen < 2) return null;
      if (price > bb.upper && dir === 'G') return { fire: true, dir: 'bear' as const };
      if (price < bb.lower && dir === 'R') return { fire: true, dir: 'bull' as const };
      return null;
    }
  },
];

for (const t of synthTests) {
  const wf = walkForwardSynth(t.candles as RawCandle[], t.fn as any, 3);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.70 && wf.sigma <= 0.06 && wf.totalTrades >= 20 ? ' ⭐⭐⭐'
             : wf.wr >= 0.67 && wf.sigma <= 0.08 && wf.totalTrades >= 15 ? ' ⭐⭐'
             : wf.wr >= 0.64 && wf.totalTrades >= 10 ? ' ⭐' : '';
  console.log(`  ${t.name.padEnd(42)} WR=${(wf.wr*100).toFixed(1)}% σ=${(wf.sigma*100).toFixed(1)}% T=${wf.totalTrades} [${foldStr}]${flag}`);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ SYNTHETIC TF RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
