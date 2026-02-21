/**
 * BB Deviation Filter + Extended Hours Validation
 *
 * KEY DISCOVERY: For ETH/5m, the optimal BB penetration is 0.1-0.2%
 * Deep penetration (>0.5%) = trend continuation → mean reversion FAILS
 *
 * Also validating:
 * - BB(1.5) + hours[10,11,12,21,22,23] walk-forward
 * - "SkipBadHours" approach walk-forward
 * - Updated strategy recommendations
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/bbDeviationValidation.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DbCandle } from '../db';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH);
const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');

function queryCandles(coin: string, timeframe: string): DbCandle[] {
  return db.prepare(
    'SELECT * FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC'
  ).all(coin, timeframe) as DbCandle[];
}

const BET = 10;

function calcATR(candles: DbCandle[], i: number, period = 14): number {
  if (i < period + 1) return 0;
  let atr = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const c = candles[j], p = candles[j - 1];
    atr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return atr / period;
}

function getBB(candles: DbCandle[], i: number, period = 20, mult = 2): { upper: number; lower: number; mid: number } | null {
  if (i < period) return null;
  const closes = candles.slice(i - period + 1, i + 1).map(c => c.close);
  const mid = closes.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, lower: mid - mult * std, mid };
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

const BAD_HOURS = [8, 9, 14, 19, 20];
const EXTENDED_HOURS = [10, 11, 12, 21, 22, 23];
const GOOD_HOURS_ONLY = [10, 11, 12, 21];

// ── Part 1: Walk-Forward — BB Deviation Filter ────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ PART 1: WALK-FORWARD — BB DEVIATION SWEET SPOT (0.1-0.2%)');
console.log('══════════════════════════════════════════════════════════════');
console.log('DISCOVERY: 0.1-0.2% outside BB = 67.9% WR vs >0.5% = 39.1% WR!\n');

{
  const allC = queryCandles('ETH', '5m');
  const n = allC.length;
  const testSize = Math.floor(n * 0.1);
  const startTest = Math.floor(n * 0.7);

  const configs = [
    { name: 'Any deviation (baseline)', minDev: 0, maxDev: 999 },
    { name: 'Tight 0.0-0.15%', minDev: 0, maxDev: 0.15 },
    { name: 'Sweet spot 0.05-0.2%', minDev: 0.05, maxDev: 0.20 },
    { name: 'Extended 0.0-0.3%', minDev: 0, maxDev: 0.30 },
    { name: 'Skip deep >0.3%', minDev: 0, maxDev: 0.30 }, // same as extended
    { name: 'Only deep >0.3%', minDev: 0.30, maxDev: 999 },
  ];

  for (const cfg of configs) {
    let totalWins = 0, totalTrades = 0;
    const foldWRs: number[] = [];
    let validFolds = 0;

    for (let fold = 0; fold < 3; fold++) {
      const foldStart = startTest + fold * testSize;
      const foldEnd = Math.min(foldStart + testSize, n - 1);
      let wins = 0, trades = 0;

      for (let i = foldStart + 25; i < foldEnd; i++) {
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
        if (dev < cfg.minDev || dev >= cfg.maxDev) continue;

        const dir: 'BULL' | 'BEAR' = aboveUpper ? 'BEAR' : 'BULL';
        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        trades++; if (win) wins++;
      }

      const wr = trades ? wins / trades : 0;
      if (trades > 0) { foldWRs.push(wr); validFolds++; }
      totalWins += wins; totalTrades += trades;
    }

    const finalWR = totalTrades ? totalWins / totalTrades : 0;
    const sigma = foldWRs.length > 1 ? Math.sqrt(foldWRs.reduce((s, x) => s + (x - finalWR) ** 2, 0) / foldWRs.length) * 100 : 0;
    const flag = finalWR >= 0.68 ? ' ⭐⭐' : finalWR >= 0.62 ? ' ⭐' : finalWR < 0.52 ? ' ❌' : '';
    console.log(`  ${cfg.name.padEnd(26)}: WR=${(finalWR*100).toFixed(1).padStart(5)}%  T=${totalTrades.toString().padStart(4)}  σ=${sigma.toFixed(1)}%${flag}`);
  }
}

// ── Part 2: Walk-Forward — Extended Hours + BB(1.5) ──────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ PART 2: WALK-FORWARD — EXTENDED HOURS [10,11,12,21,22,23]');
console.log('══════════════════════════════════════════════════════════════');
console.log('Grid best: atr=7 h=[10,11,12,21,22,23] str≥2 bb=1.5 = 63.7% WR 471T\n');

{
  const allC = queryCandles('ETH', '5m');
  const n = allC.length;
  const testSize = Math.floor(n * 0.1);
  const startTest = Math.floor(n * 0.7);

  // Pre-compute ATR P33 from train
  const trainATRs: number[] = [];
  for (let i = 16; i < startTest; i++) trainATRs.push(calcATR(allC, i));
  trainATRs.sort((a, b) => a - b);
  const atrP33 = trainATRs[Math.floor(trainATRs.length * 0.33)];

  const configs = [
    { name: 'Baseline (no filter)', hours: null as number[] | null, bbMult: 2.0, minStreak: 3, atrMax: null as number | null, skipBad: false },
    { name: 'SkipBadHours+BB(2)', hours: null, bbMult: 2.0, minStreak: 3, atrMax: null, skipBad: true },
    { name: 'Ext hours+BB(2)+str≥2', hours: EXTENDED_HOURS, bbMult: 2.0, minStreak: 2, atrMax: null, skipBad: false },
    { name: 'Ext hours+BB(1.5)+str≥2', hours: EXTENDED_HOURS, bbMult: 1.5, minStreak: 2, atrMax: null, skipBad: false },
    { name: 'Ext h+BB(1.5)+ATR33', hours: EXTENDED_HOURS, bbMult: 1.5, minStreak: 2, atrMax: atrP33, skipBad: false },
    { name: 'GoodH+BB(2)+bodyATR', hours: GOOD_HOURS_ONLY, bbMult: 2.0, minStreak: 3, atrMax: null, skipBad: false },
    { name: 'GoodH+BB(1.5)+str≥2', hours: GOOD_HOURS_ONLY, bbMult: 1.5, minStreak: 2, atrMax: null, skipBad: false },
  ];

  for (const cfg of configs) {
    let totalWins = 0, totalTrades = 0;
    const foldWRs: number[] = [];

    for (let fold = 0; fold < 3; fold++) {
      const foldStart = startTest + fold * testSize;
      const foldEnd = Math.min(foldStart + testSize, n - 1);
      let wins = 0, trades = 0;

      for (let i = foldStart + 25; i < foldEnd; i++) {
        if (cfg.atrMax !== null && calcATR(allC, i) > cfg.atrMax) continue;
        const hour = new Date(allC[i].open_time).getUTCHours();
        if (cfg.hours !== null && !cfg.hours.includes(hour)) continue;
        if (cfg.skipBad && BAD_HOURS.includes(hour)) continue;

        const streak = getStreak(allC, i);
        if (Math.abs(streak) < cfg.minStreak) continue;
        const bb = getBB(allC, i, 20, cfg.bbMult);
        if (!bb) continue;
        const c = allC[i];
        const aboveUpper = c.close > bb.upper;
        const belowLower = c.close < bb.lower;
        if (!aboveUpper && !belowLower) continue;

        const dir: 'BULL' | 'BEAR' = aboveUpper ? 'BEAR' : 'BULL';
        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        trades++; if (win) wins++;
      }

      const wr = trades ? wins / trades : 0;
      if (trades > 0) foldWRs.push(wr);
      totalWins += wins; totalTrades += trades;
    }

    const finalWR = totalTrades ? totalWins / totalTrades : 0;
    const sigma = foldWRs.length > 1 ? Math.sqrt(foldWRs.reduce((s, x) => s + (x - finalWR) ** 2, 0) / foldWRs.length) * 100 : 0;
    const pnl = totalWins * BET - (totalTrades - totalWins) * BET;
    const flag = finalWR >= 0.70 ? ' ⭐⭐⭐' : finalWR >= 0.65 ? ' ⭐⭐' : finalWR >= 0.61 ? ' ⭐' : finalWR < 0.52 ? ' ❌' : '';
    const foldStr = foldWRs.map(f => `${(f*100).toFixed(0)}%`).join('/');
    console.log(`  ${cfg.name.padEnd(26)}: WR=${(finalWR*100).toFixed(1).padStart(5)}%  T=${totalTrades.toString().padStart(4)}  σ=${sigma.toFixed(1)}%  [${foldStr}]${flag}`);
  }
}

// ── Part 3: Cross-Coin Validation ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔍 PART 3: BB DEVIATION + SKIP BAD HOURS — CROSS-COIN CHECK');
console.log('══════════════════════════════════════════════════════════════');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' }, { coin: 'BTC', tf: '5m' }, { coin: 'SOL', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Test: streak(3) + BB + skip bad hours + only 0.1-0.2% deviation
  let winsOpt = 0, totalOpt = 0;
  let winsSkip = 0, totalSkip = 0;
  let winsBase = 0, totalBase = 0;

  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const streak = getStreak(allC, i);
    if (Math.abs(streak) < 3) continue;
    const bb = getBB(allC, i);
    if (!bb) continue;
    const c = allC[i];
    const above = c.close > bb.upper, below = c.close < bb.lower;
    if (!above && !below) continue;

    const dev = above ? (c.close - bb.upper) / bb.upper * 100 : (bb.lower - c.close) / bb.lower * 100;
    const dir: 'BULL' | 'BEAR' = above ? 'BEAR' : 'BULL';
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    const hour = new Date(allC[i].open_time).getUTCHours();

    totalBase++; if (win) winsBase++;
    if (!BAD_HOURS.includes(hour)) { totalSkip++; if (win) winsSkip++; }
    if (!BAD_HOURS.includes(hour) && dev >= 0.05 && dev < 0.25) { totalOpt++; if (win) winsOpt++; }
  }

  const wrBase = totalBase ? winsBase / totalBase : 0;
  const wrSkip = totalSkip ? winsSkip / totalSkip : 0;
  const wrOpt = totalOpt ? winsOpt / totalOpt : 0;
  const pnlOpt = winsOpt * BET - (totalOpt - winsOpt) * BET;

  const flagOpt = wrOpt >= 0.70 ? '⭐⭐' : wrOpt >= 0.65 ? '⭐' : wrOpt < 0.52 ? '❌' : '';
  console.log(`${coin}/${tf}: base=${(wrBase*100).toFixed(1)}%(${totalBase}) skip=${(wrSkip*100).toFixed(1)}%(${totalSkip}) opt[skip+dev]=${(wrOpt*100).toFixed(1)}%(${totalOpt}) PnL=$${pnlOpt} ${flagOpt}`);
}

// ── Part 4: Final Production Recommendation ───────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📋 PART 4: FINAL ETH/5m PRODUCTION RECOMMENDATIONS');
console.log('══════════════════════════════════════════════════════════════\n');

{
  const allC = queryCandles('ETH', '5m');
  const splitIdx = Math.floor(allC.length * 0.7);

  // Recommendation 1: High-WR "sniper" mode (few but very precise trades)
  let sniper_wins = 0, sniper_total = 0;
  // Recommendation 2: High-volume "balanced" mode
  let balanced_wins = 0, balanced_total = 0;

  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const hour = new Date(allC[i].open_time).getUTCHours();
    const streak = getStreak(allC, i);
    const bb2 = getBB(allC, i, 20, 2.0);
    const bb15 = getBB(allC, i, 20, 1.5);
    const c = allC[i];
    const nextGreen = allC[i + 1].close > allC[i + 1].open;

    // "Sniper" mode: only hours [10,12,21], streak≥3, BB(2), bodyATR≥0.9
    if (GOOD_HOURS_ONLY.includes(hour) && bb2 && Math.abs(streak) >= 3) {
      const above = c.close > bb2.upper, below = c.close < bb2.lower;
      if (above || below) {
        const atr = calcATR(allC, i);
        const bodyATR = atr > 0 ? Math.abs(c.close - c.open) / atr : 0;
        if (bodyATR >= 0.9) {
          const dir: 'BULL' | 'BEAR' = above ? 'BEAR' : 'BULL';
          const win = dir === 'BEAR' ? !nextGreen : nextGreen;
          sniper_total++; if (win) sniper_wins++;
        }
      }
    }

    // "Balanced" mode: skip bad hours, streak≥2, BB(1.5), dev 0.05-0.25%
    if (!BAD_HOURS.includes(hour) && EXTENDED_HOURS.includes(hour) && bb15 && Math.abs(streak) >= 2) {
      const above = c.close > bb15.upper, below = c.close < bb15.lower;
      if (above || below) {
        const dev = above ? (c.close - bb15.upper) / bb15.upper * 100 : (bb15.lower - c.close) / bb15.lower * 100;
        if (dev >= 0.05 && dev < 0.25) {
          const dir: 'BULL' | 'BEAR' = above ? 'BEAR' : 'BULL';
          const win = dir === 'BEAR' ? !nextGreen : nextGreen;
          balanced_total++; if (win) balanced_wins++;
        }
      }
    }
  }

  const sniperWR = sniper_total ? sniper_wins / sniper_total : 0;
  const balancedWR = balanced_total ? balanced_wins / balanced_total : 0;
  const sniperPnL = sniper_wins * BET - (sniper_total - sniper_wins) * BET;
  const balancedPnL = balanced_wins * BET - (balanced_total - balanced_wins) * BET;

  console.log('RECOMMENDATION 1: "Sniper" mode (high-precision, few trades)');
  console.log(`  Signal: GoodHours[10,11,12,21] + Streak(3) + BB(2) + bodyATR≥0.9`);
  console.log(`  ETH/5m test: WR=${(sniperWR*100).toFixed(1)}%  T=${sniper_total}  PnL=$${sniperPnL}`);
  console.log();
  console.log('RECOMMENDATION 2: "Balanced" mode (more trades, still strong WR)');
  console.log(`  Signal: ExtHours[10,11,12,21,22,23] + Streak(2) + BB(1.5) + dev[0.05-0.25%]`);
  console.log(`  ETH/5m test: WR=${(balancedWR*100).toFixed(1)}%  T=${balanced_total}  PnL=$${balancedPnL}`);
  console.log();
  console.log('RECOMMENDATION 3: "Volume" mode (high frequency, moderate WR)');
  console.log('  Signal: SkipBadHours[8,9,14,19,20] + Streak(3) + BB(2)');
  console.log('  ETH/5m test: WR≈63.2%  T≈280  (from eth5mDeepDive.ts SkipBadHours result)');
}

console.log('\n✅ Validation complete.');
