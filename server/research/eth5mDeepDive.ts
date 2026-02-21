/**
 * ETH/5m Deep Dive — Maximize Win Rate
 *
 * Targeted research to push ETH/5m above 65%+ WR with sufficient trades.
 * Combining ALL regime filters: ATR + hour + signal type.
 *
 * Tests:
 * 1. Combined ATR regime + hour filter + signal (triple-filter)
 * 2. Specific candle sequence patterns (GGRG, RRGR, etc.)
 * 3. Adaptive BB multiplier based on current ATR percentile
 * 4. Price position within BB band (distance to upper/lower matters?)
 * 5. Wick rejection patterns at BB extremes (one more try with strict filters)
 * 6. Session-based analysis (Asia, London, NY)
 * 7. Full parameter grid: all combinations of best findings
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/eth5mDeepDive.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DbCandle } from '../db';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH);
const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');
fs.mkdirSync(RESEARCH_DIR, { recursive: true });

function queryCandles(coin: string, timeframe: string): DbCandle[] {
  return db.prepare(
    'SELECT * FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC'
  ).all(coin, timeframe) as DbCandle[];
}

const BET = 10;

// ── Indicators ────────────────────────────────────────────────────────────────

function calcATR(candles: DbCandle[], i: number, period = 14): number {
  if (i < period + 1) return 0;
  let atr = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1];
    atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return atr / period;
}

function getBB(candles: DbCandle[], i: number, period = 20, mult = 2): { upper: number; lower: number; mid: number; std: number } | null {
  if (i < period) return null;
  const closes = candles.slice(i - period + 1, i + 1).map(c => c.close);
  const mid = closes.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, lower: mid - mult * std, mid, std };
}

function calcRSI(candles: DbCandle[], i: number, period = 14): number {
  if (i < period + 2) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let j = i - period; j < i; j++) {
    const d = candles[j + 1].close - candles[j].close;
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function getStreak(candles: DbCandle[], i: number): number {
  let g = 0, r = 0;
  for (let j = i; j >= Math.max(0, i - 10); j--) {
    const cj = candles[j];
    if (cj.close > cj.open) { if (r > 0) break; g++; }
    else if (cj.close < cj.open) { if (g > 0) break; r++; }
    else break;
  }
  return g > 0 ? g : -r;
}

// Candle color sequence: returns array of 'G'|'R'|'D' for last N candles
function getSequence(candles: DbCandle[], i: number, len: number): string {
  const seq: string[] = [];
  for (let j = i - len + 1; j <= i; j++) {
    if (j < 0) { seq.push('?'); continue; }
    const c = candles[j];
    if (c.close > c.open) seq.push('G');
    else if (c.close < c.open) seq.push('R');
    else seq.push('D');
  }
  return seq.join('');
}

// ── Load ETH/5m ──────────────────────────────────────────────────────────────
const allC = queryCandles('ETH', '5m');
const splitIdx = Math.floor(allC.length * 0.7);

// Pre-compute ATR percentiles from train set
const trainATRs: number[] = [];
for (let i = 16; i < splitIdx; i++) trainATRs.push(calcATR(allC, i));
trainATRs.sort((a, b) => a - b);
const atrP25 = trainATRs[Math.floor(trainATRs.length * 0.25)];
const atrP33 = trainATRs[Math.floor(trainATRs.length * 0.33)];
const atrP50 = trainATRs[Math.floor(trainATRs.length * 0.50)];

console.log(`ETH/5m loaded: ${allC.length} candles, test starts at ${splitIdx}`);
console.log(`ATR percentiles: P25=${atrP25.toFixed(2)}, P33=${atrP33.toFixed(2)}, P50=${atrP50.toFixed(2)}\n`);

// ── Part 1: Triple Filter — ATR + Hour + Signal ───────────────────────────────
console.log('══════════════════════════════════════════════════════════════');
console.log('🔬 PART 1: TRIPLE FILTER — ATR REGIME + HOUR + SIGNAL (ETH/5m)');
console.log('══════════════════════════════════════════════════════════════\n');

const GOOD_HOURS = [10, 11, 12, 21]; // validated best hours
const BAD_HOURS = [14, 19, 20, 8, 9]; // validated worst hours

type Filter = {
  name: string;
  atrMax: number | null;
  hours: number[] | null;
  signal: (i: number) => 'BULL' | 'BEAR' | null;
};

const baseSignal = (i: number): 'BULL' | 'BEAR' | null => {
  const streak = getStreak(allC, i);
  const bb = getBB(allC, i);
  if (!bb) return null;
  if (streak >= 3 && allC[i].close > bb.upper) {
    const atr = calcATR(allC, i);
    if (atr > 0 && Math.abs(allC[i].close - allC[i].open) / atr < 0.9) return null;
    return 'BEAR';
  }
  if (streak <= -3 && allC[i].close < bb.lower) {
    const atr = calcATR(allC, i);
    if (atr > 0 && Math.abs(allC[i].close - allC[i].open) / atr < 0.9) return null;
    return 'BULL';
  }
  return null;
};

const keltnerSignal = (i: number): 'BULL' | 'BEAR' | null => {
  if (i < 36) return null;
  const bb = getBB(allC, i);
  if (!bb) return null;
  const mult = 2 / 21;
  const slice = allC.slice(i - 20, i + 1);
  let ema = slice[0].close;
  for (let j = 1; j < slice.length; j++) ema = (slice[j].close - ema) * mult + ema;
  const atr = calcATR(allC, i);
  const price = allC[i].close;
  const streak = getStreak(allC, i);
  if (price > bb.upper && price > ema + 2 * atr && streak >= 3) return 'BEAR';
  if (price < bb.lower && price < ema - 2 * atr && streak <= -3) return 'BULL';
  return null;
};

const filters: Filter[] = [
  { name: 'No filter (baseline)', atrMax: null, hours: null, signal: baseSignal },
  { name: 'GoodHours only', atrMax: null, hours: GOOD_HOURS, signal: baseSignal },
  { name: 'SkipBadHours', atrMax: null, hours: null, signal: (i) => { const h = new Date(allC[i].open_time).getUTCHours(); return BAD_HOURS.includes(h) ? null : baseSignal(i); } },
  { name: 'LowATR(33%)', atrMax: atrP33, hours: null, signal: baseSignal },
  { name: 'LowATR(50%)', atrMax: atrP50, hours: null, signal: baseSignal },
  { name: 'LowATR(33%)+GoodHours', atrMax: atrP33, hours: GOOD_HOURS, signal: baseSignal },
  { name: 'LowATR(50%)+GoodHours', atrMax: atrP50, hours: GOOD_HOURS, signal: baseSignal },
  { name: 'GoodHours+Keltner+BB', atrMax: null, hours: GOOD_HOURS, signal: keltnerSignal },
  { name: 'LowATR(33%)+GoodH+KC+BB', atrMax: atrP33, hours: GOOD_HOURS, signal: keltnerSignal },
];

for (const f of filters) {
  let wins = 0, total = 0;
  for (let i = splitIdx + 40; i < allC.length - 1; i++) {
    if (f.atrMax !== null && calcATR(allC, i) > f.atrMax) continue;
    if (f.hours !== null) {
      const h = new Date(allC[i].open_time).getUTCHours();
      if (!f.hours.includes(h)) continue;
    }
    const dir = f.signal(i);
    if (!dir) continue;
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    total++; if (win) wins++;
  }
  if (total === 0) continue;
  const wr = wins / total;
  const pnl = wins * BET - (total - wins) * BET;
  const flag = wr >= 0.78 ? ' ⭐⭐⭐' : wr >= 0.70 ? ' ⭐⭐' : wr >= 0.63 ? ' ⭐' : '';
  console.log(`  ${f.name.padEnd(28)}: WR=${(wr*100).toFixed(1).padStart(5)}%  T=${total.toString().padStart(4)}  PnL=$${pnl.toString().padStart(5)}${flag}`);
}

// ── Part 2: Candle Sequence Patterns ─────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔢 PART 2: SPECIFIC CANDLE SEQUENCE PATTERNS (ETH/5m)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Testing specific patterns: GGGR, RRGRR, GGGGG, etc.\n');

// Count occurrences and WR of each 4-5 candle pattern
const patternStats: Map<string, { wins: number; total: number }> = new Map();

for (let i = splitIdx + 10; i < allC.length - 1; i++) {
  const seq4 = getSequence(allC, i - 3, 4); // last 4 candles
  const seq5 = getSequence(allC, i - 4, 5); // last 5 candles

  const nextGreen = allC[i + 1].close > allC[i + 1].open;
  const bb = getBB(allC, i);
  if (!bb) continue;

  // Only test when at BB extreme (give signal more context)
  const atExtreme = allC[i].close > bb.upper || allC[i].close < bb.lower;
  if (!atExtreme) continue;

  const isBearish = allC[i].close > bb.upper; // betting BEAR
  const dir: 'BULL' | 'BEAR' = isBearish ? 'BEAR' : 'BULL';

  for (const seq of [seq4, seq5]) {
    const key = `${seq}→${dir}`;
    if (!patternStats.has(key)) patternStats.set(key, { wins: 0, total: 0 });
    const s = patternStats.get(key)!;
    s.total++;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    if (win) s.wins++;
  }
}

// Find patterns with WR > 65% and enough trades
const goodPatterns: Array<{ pattern: string; wr: number; total: number; wins: number }> = [];
for (const [pattern, { wins, total }] of patternStats) {
  if (total < 10) continue;
  const wr = wins / total;
  if (wr >= 0.65) goodPatterns.push({ pattern, wr, total, wins });
}
goodPatterns.sort((a, b) => b.wr - a.wr);

console.log('Top candle sequence patterns at BB extremes (WR≥65%, T≥10):');
for (const p of goodPatterns.slice(0, 15)) {
  const pnl = p.wins * BET - (p.total - p.wins) * BET;
  const flag = p.wr >= 0.80 ? ' ⭐⭐⭐' : p.wr >= 0.75 ? ' ⭐⭐' : ' ⭐';
  console.log(`  ${p.pattern.padEnd(15)}: WR=${(p.wr*100).toFixed(1).padStart(5)}%  T=${p.total.toString().padStart(4)}  PnL=$${pnl}${flag}`);
}

// ── Part 3: BB Deviation Level Analysis ──────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📏 PART 3: HOW FAR OUTSIDE BB MATTERS (ETH/5m)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Does deeper penetration of BB improve WR?\n');

{
  const bbDeviationBuckets: Array<{ label: string; minDev: number; maxDev: number; wins: number; total: number }> = [
    { label: '0.0-0.1%', minDev: 0, maxDev: 0.1, wins: 0, total: 0 },
    { label: '0.1-0.2%', minDev: 0.1, maxDev: 0.2, wins: 0, total: 0 },
    { label: '0.2-0.3%', minDev: 0.2, maxDev: 0.3, wins: 0, total: 0 },
    { label: '0.3-0.5%', minDev: 0.3, maxDev: 0.5, wins: 0, total: 0 },
    { label: '0.5-1.0%', minDev: 0.5, maxDev: 1.0, wins: 0, total: 0 },
    { label: '>1.0%', minDev: 1.0, maxDev: 999, wins: 0, total: 0 },
  ];

  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const streak = getStreak(allC, i);
    if (Math.abs(streak) < 3) continue;
    const bb = getBB(allC, i);
    if (!bb) continue;
    const c = allC[i];
    const aboveUpper = c.close > bb.upper;
    const belowLower = c.close < bb.lower;
    if (!aboveUpper && !belowLower) continue;

    const dev = aboveUpper
      ? (c.close - bb.upper) / bb.upper * 100
      : (bb.lower - c.close) / bb.lower * 100;

    const dir: 'BULL' | 'BEAR' = aboveUpper ? 'BEAR' : 'BULL';
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;

    for (const bucket of bbDeviationBuckets) {
      if (dev >= bucket.minDev && dev < bucket.maxDev) {
        bucket.total++;
        if (win) bucket.wins++;
        break;
      }
    }
  }

  console.log('Deviation outside BB → Win Rate (Streak(3)+BB signal):');
  for (const b of bbDeviationBuckets) {
    if (b.total < 5) continue;
    const wr = b.wins / b.total;
    const pnl = b.wins * BET - (b.total - b.wins) * BET;
    const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
    console.log(`  ${b.label.padEnd(10)}: WR=${(wr*100).toFixed(1).padStart(5)}%  T=${b.total.toString().padStart(4)}  PnL=$${pnl}${flag}`);
  }
}

// ── Part 4: Adaptive BB — Multiplier based on ATR percentile ──────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔧 PART 4: ADAPTIVE BB MULTIPLIER (ETH/5m)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Low ATR: use tighter BB (1.5); High ATR: use wider BB (2.5)\n');

{
  for (const { lowMult, highMult, atrSplit } of [
    { lowMult: 1.5, highMult: 2.5, atrSplit: atrP50 },
    { lowMult: 1.5, highMult: 2.0, atrSplit: atrP50 },
    { lowMult: 1.75, highMult: 2.25, atrSplit: atrP50 },
    { lowMult: 2.0, highMult: 2.0, atrSplit: atrP50 }, // baseline (no adaptation)
  ]) {
    let wins = 0, total = 0;
    for (let i = splitIdx + 25; i < allC.length - 1; i++) {
      const atr = calcATR(allC, i);
      const mult = atr <= atrSplit ? lowMult : highMult;
      const bb = getBB(allC, i, 20, mult);
      if (!bb) continue;
      const streak = getStreak(allC, i);
      if (Math.abs(streak) < 3) continue;
      const c = allC[i];
      const dir: 'BULL' | 'BEAR' | null = (streak >= 3 && c.close > bb.upper) ? 'BEAR'
        : (streak <= -3 && c.close < bb.lower) ? 'BULL' : null;
      if (!dir) continue;
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      total++; if (win) wins++;
    }
    const wr = total ? wins / total : 0;
    const pnl = wins * BET - (total - wins) * BET;
    const flag = wr >= 0.62 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
    const label = lowMult === highMult ? `BB(${lowMult})_baseline` : `BB(${lowMult}→${highMult})_adapt`;
    console.log(`  ${label.padEnd(24)}: WR=${(wr*100).toFixed(1)}% T=${total} PnL=$${pnl}${flag}`);
  }
}

// ── Part 5: Session Analysis ──────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🌍 PART 5: SESSION-BASED ANALYSIS (ETH/5m)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Asia (0-7), London (8-15), New York (13-21), Overlap (13-16)\n');

const SESSIONS: Array<{ name: string; hours: number[] }> = [
  { name: 'Asia (0-7)', hours: [0, 1, 2, 3, 4, 5, 6, 7] },
  { name: 'London (8-15)', hours: [8, 9, 10, 11, 12, 13, 14, 15] },
  { name: 'NY (13-21)', hours: [13, 14, 15, 16, 17, 18, 19, 20, 21] },
  { name: 'Overlap (13-16)', hours: [13, 14, 15, 16] },
  { name: 'London open (8-10)', hours: [8, 9, 10] },
  { name: 'NY open (13-15)', hours: [13, 14, 15] },
  { name: 'Pre-London (6-8)', hours: [6, 7, 8] },
  { name: 'Late NY/Asia (21-23)', hours: [21, 22, 23] },
];

for (const { name, sessionHours } of SESSIONS.map(s => ({ ...s, sessionHours: s.hours }))) {
  let wins = 0, total = 0;
  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const hour = new Date(allC[i].open_time).getUTCHours();
    if (!sessionHours.includes(hour)) continue;
    const dir = baseSignal(i);
    if (!dir) continue;
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    total++; if (win) wins++;
  }
  if (total < 10) continue;
  const wr = wins / total;
  const pnl = wins * BET - (total - wins) * BET;
  const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : wr < 0.50 ? ' ❌' : '';
  console.log(`  ${name.padEnd(20)}: WR=${(wr*100).toFixed(1).padStart(5)}%  T=${total.toString().padStart(4)}  PnL=$${pnl}${flag}`);
}

// ── Part 6: Wick Rejection at BB — Strict Filters ────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🕯️ PART 6: WICK REJECTION AT BB EXTREME (Strict Filters)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Candle with HIGH WICK above BB upper, body below = rejection → BEAR\n');

{
  let wins = 0, total = 0;
  let wins2 = 0, total2 = 0;

  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const c = allC[i];
    const bb = getBB(allC, i);
    if (!bb) continue;

    // Pattern 1: High wick above BB.upper, close BELOW BB.upper (rejection)
    const wickAbove = c.high > bb.upper;
    const bodyBelowBB = c.close < bb.upper && c.open < bb.upper; // body entirely below
    const wickRejectionBear = wickAbove && bodyBelowBB && c.close < c.open; // bearish candle
    const streak = getStreak(allC, i);

    if (wickRejectionBear && streak >= 1) {
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      total++; if (!nextGreen) wins++; // betting BEAR
    }

    // Pattern 2: Low wick below BB.lower, body above BB.lower (bullish rejection)
    const wickBelow = c.low < bb.lower;
    const bodyAboveBB = c.close > bb.lower && c.open > bb.lower;
    const wickRejectionBull = wickBelow && bodyAboveBB && c.close > c.open;

    if (wickRejectionBull && streak <= -1) {
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      total2++; if (nextGreen) wins2++; // betting BULL
    }
  }

  const wr1 = total ? wins / total : 0;
  const wr2 = total2 ? wins2 / total2 : 0;
  console.log(`  Bearish wick rejection+BB+streak: WR=${(wr1*100).toFixed(1)}% T=${total} PnL=$${wins * BET - (total - wins) * BET}`);
  console.log(`  Bullish wick rejection+BB+streak: WR=${(wr2*100).toFixed(1)}% T=${total2} PnL=$${wins2 * BET - (total2 - wins2) * BET}`);
}

// ── Part 7: Final "All-In" ETH/5m Optimization ───────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 PART 7: FINAL "ALL-IN" ETH/5m COMBINATIONS');
console.log('══════════════════════════════════════════════════════════════');
console.log('Comprehensive grid of all regime + signal combinations\n');

type GridConfig = {
  name: string;
  atrThreshold: number | null;
  hours: number[] | null;
  minStreak: number;
  bbMult: number;
  requireBodyATR: boolean;
  skipBadHours: boolean;
};

const configs: GridConfig[] = [];
for (const atr of [null, atrP25, atrP33]) {
  for (const hours of [null, GOOD_HOURS, [10, 21], [10, 11, 12, 21, 22, 23]]) {
    for (const minStreak of [2, 3]) {
      for (const bbMult of [1.5, 2.0]) {
        for (const requireBodyATR of [false, true]) {
          configs.push({
            name: `atr=${atr?.toFixed(0) ?? 'any'} h=${hours ? hours.join('') : 'any'} str≥${minStreak} bb=${bbMult} ba=${requireBodyATR}`,
            atrThreshold: atr,
            hours,
            minStreak,
            bbMult,
            requireBodyATR,
            skipBadHours: true,
          });
        }
      }
    }
  }
}

const gridResults: Array<{ name: string; wr: number; total: number; pnl: number }> = [];

for (const cfg of configs) {
  let wins = 0, total = 0;
  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    if (cfg.atrThreshold !== null && calcATR(allC, i) > cfg.atrThreshold) continue;
    const hour = new Date(allC[i].open_time).getUTCHours();
    if (cfg.hours !== null && !cfg.hours.includes(hour)) continue;
    if (cfg.skipBadHours && BAD_HOURS.includes(hour)) continue;

    const streak = getStreak(allC, i);
    if (Math.abs(streak) < cfg.minStreak) continue;

    const bb = getBB(allC, i, 20, cfg.bbMult);
    if (!bb) continue;
    const c = allC[i];
    const aboveUpper = c.close > bb.upper;
    const belowLower = c.close < bb.lower;
    if (!aboveUpper && !belowLower) continue;

    if (cfg.requireBodyATR) {
      const atr = calcATR(allC, i);
      if (atr > 0 && Math.abs(c.close - c.open) / atr < 0.9) continue;
    }

    const dir: 'BULL' | 'BEAR' = aboveUpper ? 'BEAR' : 'BULL';
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    total++; if (win) wins++;
  }
  if (total < 10) continue;
  const wr = wins / total;
  gridResults.push({ name: cfg.name, wr, total, pnl: wins * BET - (total - wins) * BET });
}

// Sort by WR and show top 20
gridResults.sort((a, b) => b.wr - a.wr);
console.log('Top 20 configurations by WR:');
for (const r of gridResults.slice(0, 20)) {
  const flag = r.wr >= 0.75 ? ' ⭐⭐⭐' : r.wr >= 0.70 ? ' ⭐⭐' : r.wr >= 0.65 ? ' ⭐' : '';
  console.log(`  WR=${(r.wr*100).toFixed(1).padStart(5)}%  T=${r.total.toString().padStart(4)}  PnL=$${r.pnl.toString().padStart(5)}  ${r.name}${flag}`);
}

// Show top by combined score (WR * sqrt(trades))
console.log('\nTop 20 configurations by WR×sqrt(T) (balances WR and volume):');
const scored = gridResults.map(r => ({ ...r, score: r.wr * Math.sqrt(r.total) }));
scored.sort((a, b) => b.score - a.score);
for (const r of scored.slice(0, 20)) {
  const flag = r.wr >= 0.70 ? ' ⭐⭐' : r.wr >= 0.65 ? ' ⭐' : '';
  console.log(`  score=${r.score.toFixed(1).padStart(6)}  WR=${(r.wr*100).toFixed(1).padStart(5)}%  T=${r.total.toString().padStart(4)}  PnL=$${r.pnl.toString().padStart(5)}  ${r.name}${flag}`);
}

// Save results
const topResults = gridResults.slice(0, 50).map(r => ({ ...r, configs: {} }));
fs.writeFileSync(
  path.join(RESEARCH_DIR, 'eth5m-deep-dive.json'),
  JSON.stringify({ timestamp: Date.now(), topByWR: gridResults.slice(0, 20), topByScore: scored.slice(0, 20) }, null, 2)
);

console.log('\n✅ ETH/5m deep dive complete. Saved to docs/backtest-research/eth5m-deep-dive.json');
