/**
 * Advanced Signals Research — ETH/5m Focus
 *
 * Testing indicators not yet covered:
 * 1. Donchian Channels (N-period high/low breakout reversal)
 * 2. MFI (Money Flow Index — volume-weighted RSI)
 * 3. Williams %R (overbought/oversold oscillator)
 * 4. Price Rate of Change (ROC) at extremes
 * 5. Ensemble voting — multiple independent signal types
 * 6. Low-ATR regime + all best signals for ETH/5m
 * 7. Adaptive BB with ATR-based threshold
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/advancedSignals.ts
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

// ── Indicator helpers ─────────────────────────────────────────────────────────

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

// Donchian Channel: N-period high/low
function getDonchian(candles: DbCandle[], i: number, period = 20): { upper: number; lower: number; mid: number } | null {
  if (i < period) return null;
  const slice = candles.slice(i - period + 1, i + 1);
  const upper = Math.max(...slice.map(c => c.high));
  const lower = Math.min(...slice.map(c => c.low));
  return { upper, lower, mid: (upper + lower) / 2 };
}

// Money Flow Index (volume-weighted RSI)
function calcMFI(candles: DbCandle[], i: number, period = 14): number {
  if (i < period + 1) return 50;
  let posMF = 0, negMF = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
    const tpPrev = (candles[j - 1].high + candles[j - 1].low + candles[j - 1].close) / 3;
    const mf = tp * candles[j].volume;
    if (tp > tpPrev) posMF += mf;
    else if (tp < tpPrev) negMF += mf;
  }
  return negMF === 0 ? 100 : 100 - 100 / (1 + posMF / negMF);
}

// Williams %R
function calcWilliamsR(candles: DbCandle[], i: number, period = 14): number {
  if (i < period) return -50;
  const slice = candles.slice(i - period + 1, i + 1);
  const highestHigh = Math.max(...slice.map(c => c.high));
  const lowestLow = Math.min(...slice.map(c => c.low));
  const close = candles[i].close;
  if (highestHigh === lowestLow) return -50;
  return ((highestHigh - close) / (highestHigh - lowestLow)) * -100;
}

// Rate of Change (%)
function calcROC(candles: DbCandle[], i: number, period = 10): number {
  if (i < period) return 0;
  const past = candles[i - period].close;
  return past > 0 ? (candles[i].close - past) / past * 100 : 0;
}

// Keltner Channel
function getKeltner(candles: DbCandle[], i: number, period = 20, atrMult = 2): { upper: number; lower: number } | null {
  if (i < period + 15) return null;
  const mult = 2 / (period + 1);
  const slice = candles.slice(i - period, i + 1);
  let ema = slice[0].close;
  for (let j = 1; j < slice.length; j++) ema = (slice[j].close - ema) * mult + ema;
  const atr = calcATR(candles, i);
  return { upper: ema + atrMult * atr, lower: ema - atrMult * atr };
}

// ── Part 1: Donchian Channel Breakout Reversal ────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 PART 1: DONCHIAN CHANNEL BREAKOUT REVERSAL');
console.log('══════════════════════════════════════════════════════════════');
console.log('Price breaks N-period high/low → bet on mean reversion\n');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' }, { coin: 'BTC', tf: '5m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  console.log(`── ${coin}/${tf} ──`);
  for (const period of [10, 15, 20, 30]) {
    for (const requireStreak of [false, true]) {
      let wins = 0, total = 0;
      for (let i = splitIdx + period + 5; i < allC.length - 1; i++) {
        const dc = getDonchian(allC, i, period);
        if (!dc) continue;
        const c = allC[i];
        const aboveUpper = c.close >= dc.upper;
        const belowLower = c.close <= dc.lower;
        if (!aboveUpper && !belowLower) continue;
        if (requireStreak) {
          const streak = getStreak(allC, i);
          if (aboveUpper && streak < 2) continue;
          if (belowLower && streak > -2) continue;
        }
        const dir: 'BULL' | 'BEAR' = aboveUpper ? 'BEAR' : 'BULL';
        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        total++; if (win) wins++;
      }
      const wr = total ? wins / total : 0;
      const label = `DC(${period})${requireStreak ? '+streak' : ''}`;
      if (total >= 30 && wr >= 0.58) {
        const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
        const pnl = wins * BET - (total - wins) * BET;
        console.log(`  ${label.padEnd(16)}: WR=${(wr*100).toFixed(1)}% T=${total} PnL=$${pnl}${flag}`);
      }
    }
  }
}

// ── Part 2: MFI (Money Flow Index) ───────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('💰 PART 2: MONEY FLOW INDEX (MFI) — VOLUME-WEIGHTED RSI');
console.log('══════════════════════════════════════════════════════════════');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  console.log(`── ${coin}/${tf} ──`);
  for (const period of [10, 14]) {
    for (const threshold of [75, 80, 85]) {
      let wins = 0, total = 0;
      for (let i = splitIdx + period + 5; i < allC.length - 1; i++) {
        const mfi = calcMFI(allC, i, period);
        const overbought = mfi > threshold;
        const oversold = mfi < (100 - threshold);
        if (!overbought && !oversold) continue;
        const dir: 'BULL' | 'BEAR' = overbought ? 'BEAR' : 'BULL';
        // BB confirmation
        const bb = getBB(allC, i);
        if (bb && overbought && allC[i].close < bb.upper) continue;
        if (bb && oversold && allC[i].close > bb.lower) continue;
        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        total++; if (win) wins++;
      }
      const wr = total ? wins / total : 0;
      if (total >= 20 && wr >= 0.58) {
        const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
        const pnl = wins * BET - (total - wins) * BET;
        console.log(`  MFI(${period})>${threshold}+BB: WR=${(wr*100).toFixed(1)}% T=${total} PnL=$${pnl}${flag}`);
      }
    }
  }
}

// ── Part 3: Williams %R ───────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📉 PART 3: WILLIAMS %R EXTREMES');
console.log('══════════════════════════════════════════════════════════════');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  console.log(`── ${coin}/${tf} ──`);
  for (const period of [14, 21]) {
    for (const threshold of [80, 90, 95]) {
      let wins = 0, total = 0;
      for (let i = splitIdx + period + 5; i < allC.length - 1; i++) {
        const wr = calcWilliamsR(allC, i, period);
        const overbought = wr > -10; // near -0 = overbought
        const oversold = wr < -(100 - threshold); // near -100 = oversold
        if (!overbought && !oversold) continue;
        const dir: 'BULL' | 'BEAR' = overbought ? 'BEAR' : 'BULL';
        // Streak confirmation
        const streak = getStreak(allC, i);
        if (overbought && streak < 2) continue;
        if (oversold && streak > -2) continue;
        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        total++; if (win) wins++;
      }
      const winRate = total ? wins / total : 0;
      if (total >= 20 && winRate >= 0.58) {
        const flag = winRate >= 0.65 ? ' ⭐⭐' : winRate >= 0.60 ? ' ⭐' : '';
        const pnl = wins * BET - (total - wins) * BET;
        console.log(`  W%R(${period}) thr=${threshold}+streak: WR=${(winRate*100).toFixed(1)}% T=${total} PnL=$${pnl}${flag}`);
      }
    }
  }
}

// ── Part 4: Rate of Change Extremes ──────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🚀 PART 4: RATE OF CHANGE (ROC) EXTREMES');
console.log('══════════════════════════════════════════════════════════════');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Compute ROC percentiles from train set
  const trainROCs: number[] = [];
  for (let i = splitIdx - 200; i < splitIdx; i++) {
    if (i < 10) continue;
    trainROCs.push(Math.abs(calcROC(allC, i, 10)));
  }
  trainROCs.sort((a, b) => a - b);
  const p90 = trainROCs[Math.floor(trainROCs.length * 0.90)];

  console.log(`── ${coin}/${tf} (ROC90th pctile = ${p90.toFixed(3)}%) ──`);
  for (const period of [5, 10]) {
    let wins = 0, total = 0;
    for (let i = splitIdx + period + 5; i < allC.length - 1; i++) {
      const roc = calcROC(allC, i, period);
      const extreme = Math.abs(roc) >= p90;
      if (!extreme) continue;
      const dir: 'BULL' | 'BEAR' = roc > 0 ? 'BEAR' : 'BULL'; // mean-revert after extreme move
      const bb = getBB(allC, i);
      if (bb && dir === 'BEAR' && allC[i].close < bb.upper) continue;
      if (bb && dir === 'BULL' && allC[i].close > bb.lower) continue;
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      total++; if (win) wins++;
    }
    const wr = total ? wins / total : 0;
    if (total >= 20) {
      const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
      const pnl = wins * BET - (total - wins) * BET;
      console.log(`  ROC(${period})>90th+BB: WR=${(wr*100).toFixed(1)}% T=${total} PnL=$${pnl}${flag}`);
    }
  }
}

// ── Part 5: Ensemble — Multiple Independent Signals ───────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🎯 PART 5: ENSEMBLE VOTING — MULTIPLE INDEPENDENT SIGNAL TYPES');
console.log('══════════════════════════════════════════════════════════════');
console.log('Unlike multi-TF (same signal type), these are DIFFERENT indicators');
console.log('Testing: Streak + RSI + MFI + Williams%R all agree → high confidence\n');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  console.log(`── ${coin}/${tf} ──`);

  // For each bar, collect vote from each indicator type
  for (const minVotes of [2, 3, 4]) {
    for (const requireBB of [false, true]) {
      let wins = 0, total = 0;

      for (let i = splitIdx + 25; i < allC.length - 1; i++) {
        const c = allC[i];
        const bb = getBB(allC, i);
        const rsi = calcRSI(allC, i, 14);
        const mfi = calcMFI(allC, i, 14);
        const wpr = calcWilliamsR(allC, i, 14);
        const streak = getStreak(allC, i);

        let bearVotes = 0, bullVotes = 0;

        // Signal 1: Streak direction
        if (streak >= 3) bearVotes++;
        else if (streak <= -3) bullVotes++;

        // Signal 2: RSI extreme
        if (rsi >= 65) bearVotes++;
        else if (rsi <= 35) bullVotes++;

        // Signal 3: MFI extreme (volume-weighted RSI)
        if (mfi >= 75) bearVotes++;
        else if (mfi <= 25) bullVotes++;

        // Signal 4: Williams %R
        if (wpr > -10) bearVotes++; // near 0 = overbought
        else if (wpr < -90) bullVotes++; // near -100 = oversold

        // Signal 5: BB position
        if (bb && c.close > bb.upper) bearVotes++;
        else if (bb && c.close < bb.lower) bullVotes++;

        const totalVotes = bearVotes + bullVotes;
        if (Math.max(bearVotes, bullVotes) < minVotes) continue;
        if (bearVotes > 0 && bullVotes > 0 && requireBB) continue; // require consensus

        const dir: 'BULL' | 'BEAR' = bearVotes > bullVotes ? 'BEAR' : 'BULL';

        // Extra: require BB confirmation if set
        if (requireBB && bb) {
          if (dir === 'BEAR' && c.close < bb.upper) continue;
          if (dir === 'BULL' && c.close > bb.lower) continue;
        }

        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        total++; if (win) wins++;
      }

      const wr = total ? wins / total : 0;
      const bbLabel = requireBB ? '+BB' : '';
      if (total >= 20 && wr >= 0.58) {
        const flag = wr >= 0.68 ? ' ⭐⭐⭐' : wr >= 0.64 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
        const pnl = wins * BET - (total - wins) * BET;
        console.log(`  ${minVotes}+ votes${bbLabel}: WR=${(wr*100).toFixed(1)}% T=${total} PnL=$${pnl}${flag}`);
      }
    }
  }
}

// ── Part 6: Low-ATR Regime + Best Signals on ETH/5m ─────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔬 PART 6: LOW-ATR REGIME — OPTIMIZED FOR ETH/5m');
console.log('══════════════════════════════════════════════════════════════');
console.log('ETH/5m works better in LOW volatility — test all signals in that regime\n');

const ethC5m = queryCandles('ETH', '5m');
const splitIdx5m = Math.floor(ethC5m.length * 0.7);

// Compute ATR percentile threshold from train set
const trainATRs: number[] = [];
for (let i = 16; i < splitIdx5m; i++) {
  trainATRs.push(calcATR(ethC5m, i));
}
trainATRs.sort((a, b) => a - b);
const atrP33 = trainATRs[Math.floor(trainATRs.length * 0.33)];
const atrP50 = trainATRs[Math.floor(trainATRs.length * 0.50)];
console.log(`ETH/5m ATR thresholds: 33rd=${atrP33.toFixed(2)}, 50th=${atrP50.toFixed(2)}`);

for (const atrThreshold of [atrP33, atrP50]) {
  const label = atrThreshold === atrP33 ? 'lowATR(33%)' : 'lowATR(50%)';
  console.log(`\n  [${label}] — signals that fire in low-ATR regime only:`);

  // Test each signal type in low-ATR only
  const signals: Array<{ name: string; fn: (i: number) => 'BULL' | 'BEAR' | null }> = [
    {
      name: 'Streak(3)+BB',
      fn: (i) => {
        const streak = getStreak(ethC5m, i);
        const bb = getBB(ethC5m, i);
        if (!bb) return null;
        if (streak >= 3 && ethC5m[i].close > bb.upper) return 'BEAR';
        if (streak <= -3 && ethC5m[i].close < bb.lower) return 'BULL';
        return null;
      }
    },
    {
      name: 'GGG+BB+bodyATR',
      fn: (i) => {
        const streak = getStreak(ethC5m, i);
        const bb = getBB(ethC5m, i);
        if (!bb) return null;
        if (streak >= 3 && ethC5m[i].close > bb.upper) {
          const atr = calcATR(ethC5m, i);
          if (atr > 0 && Math.abs(ethC5m[i].close - ethC5m[i].open) / atr < 0.9) return null;
          return 'BEAR';
        }
        if (streak <= -3 && ethC5m[i].close < bb.lower) {
          const atr = calcATR(ethC5m, i);
          if (atr > 0 && Math.abs(ethC5m[i].close - ethC5m[i].open) / atr < 0.9) return null;
          return 'BULL';
        }
        return null;
      }
    },
    {
      name: 'Keltner+BB_dbl+streak',
      fn: (i) => {
        if (i < 36) return null;
        const bb = getBB(ethC5m, i);
        if (!bb) return null;
        const mult = 2 / 21;
        const slice = ethC5m.slice(i - 20, i + 1);
        let ema = slice[0].close;
        for (let j = 1; j < slice.length; j++) ema = (slice[j].close - ema) * mult + ema;
        const atrVal = calcATR(ethC5m, i);
        const kcUpper = ema + 2 * atrVal;
        const kcLower = ema - 2 * atrVal;
        const price = ethC5m[i].close;
        const streak = getStreak(ethC5m, i);
        if (price > bb.upper && price > kcUpper && streak >= 3) return 'BEAR';
        if (price < bb.lower && price < kcLower && streak <= -3) return 'BULL';
        return null;
      }
    },
    {
      name: 'MFI(80)+streak+BB',
      fn: (i) => {
        const mfi = calcMFI(ethC5m, i, 14);
        const streak = getStreak(ethC5m, i);
        const bb = getBB(ethC5m, i);
        if (!bb) return null;
        if (mfi > 80 && streak >= 2 && ethC5m[i].close > bb.upper) return 'BEAR';
        if (mfi < 20 && streak <= -2 && ethC5m[i].close < bb.lower) return 'BULL';
        return null;
      }
    },
    {
      name: 'Ensemble(3+votes)',
      fn: (i) => {
        const bb = getBB(ethC5m, i);
        const rsi = calcRSI(ethC5m, i, 14);
        const mfi = calcMFI(ethC5m, i, 14);
        const streak = getStreak(ethC5m, i);
        let bearV = 0, bullV = 0;
        if (streak >= 3) bearV++;
        if (streak <= -3) bullV++;
        if (rsi >= 65) bearV++;
        if (rsi <= 35) bullV++;
        if (mfi >= 75) bearV++;
        if (mfi <= 25) bullV++;
        if (bb && ethC5m[i].close > bb.upper) bearV++;
        if (bb && ethC5m[i].close < bb.lower) bullV++;
        if (Math.max(bearV, bullV) < 3) return null;
        if (bearV > bullV && bb && ethC5m[i].close > bb.upper) return 'BEAR';
        if (bullV > bearV && bb && ethC5m[i].close < bb.lower) return 'BULL';
        return null;
      }
    },
  ];

  for (const { name, fn } of signals) {
    let wins = 0, total = 0;
    for (let i = splitIdx5m + 25; i < ethC5m.length - 1; i++) {
      const curATR = calcATR(ethC5m, i);
      if (curATR > atrThreshold) continue; // only in low-ATR regime
      const dir = fn(i);
      if (!dir) continue;
      const nextGreen = ethC5m[i + 1].close > ethC5m[i + 1].open;
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      total++; if (win) wins++;
    }
    if (total >= 10) {
      const wr = wins / total;
      const pnl = wins * BET - (total - wins) * BET;
      const flag = wr >= 0.68 ? ' ⭐⭐⭐' : wr >= 0.64 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
      console.log(`    ${name.padEnd(25)}: WR=${(wr*100).toFixed(1).padStart(5)}%  T=${total.toString().padStart(4)}  PnL=$${pnl.toString().padStart(5)}${flag}`);
    }
  }
}

// ── Part 7: Skip bad hours + Best Strategy ETH/5m comprehensive ──────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('⏰ PART 7: HOUR-FILTERED SIGNALS FOR ETH/5m');
console.log('══════════════════════════════════════════════════════════════');
console.log('Best hours for ETH/5m: 21:00, 12:00, 11:00, 10:00 UTC\n');

{
  const allC = ethC5m;
  const splitIdx = splitIdx5m;

  // Best hours from markovBBTimeFilter.ts research
  const goodHours = [10, 11, 12, 21]; // Best 4 hours found previously
  const badHours = [14]; // Universally worst

  for (const { filter, label } of [
    { filter: (h: number) => true, label: 'no_hour_filter' },
    { filter: (h: number) => !badHours.includes(h), label: 'skip14' },
    { filter: (h: number) => goodHours.includes(h), label: 'best4hours' },
  ]) {
    console.log(`  [${label}]:`);

    const signals: Array<{ name: string; fn: (i: number) => 'BULL' | 'BEAR' | null }> = [
      {
        name: 'Streak(3)+BB',
        fn: (i) => {
          const streak = getStreak(allC, i);
          const bb = getBB(allC, i);
          if (!bb) return null;
          if (streak >= 3 && allC[i].close > bb.upper) return 'BEAR';
          if (streak <= -3 && allC[i].close < bb.lower) return 'BULL';
          return null;
        }
      },
      {
        name: 'GGG+BB+bodyATR',
        fn: (i) => {
          const streak = getStreak(allC, i);
          const bb = getBB(allC, i);
          if (!bb) return null;
          if (Math.abs(streak) < 3) return null;
          const atr = calcATR(allC, i);
          if (atr > 0 && Math.abs(allC[i].close - allC[i].open) / atr < 0.9) return null;
          if (streak >= 3 && allC[i].close > bb.upper) return 'BEAR';
          if (streak <= -3 && allC[i].close < bb.lower) return 'BULL';
          return null;
        }
      },
      {
        name: 'Keltner+BB_dbl',
        fn: (i) => {
          if (i < 36) return null;
          const bb = getBB(allC, i);
          if (!bb) return null;
          const mult = 2 / 21;
          const slice = allC.slice(i - 20, i + 1);
          let ema = slice[0].close;
          for (let j = 1; j < slice.length; j++) ema = (slice[j].close - ema) * mult + ema;
          const atrVal = calcATR(allC, i);
          const price = allC[i].close;
          const streak = getStreak(allC, i);
          if (price > bb.upper && price > ema + 2 * atrVal && streak >= 3) return 'BEAR';
          if (price < bb.lower && price < ema - 2 * atrVal && streak <= -3) return 'BULL';
          return null;
        }
      },
    ];

    for (const { name, fn } of signals) {
      let wins = 0, total = 0;
      for (let i = splitIdx + 25; i < allC.length - 1; i++) {
        const hour = new Date(allC[i].open_time).getUTCHours();
        if (!filter(hour)) continue;
        const dir = fn(i);
        if (!dir) continue;
        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        total++; if (win) wins++;
      }
      if (total >= 10) {
        const wr = wins / total;
        const pnl = wins * BET - (total - wins) * BET;
        const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
        console.log(`    ${name.padEnd(20)}: WR=${(wr*100).toFixed(1).padStart(5)}%  T=${total.toString().padStart(4)}  PnL=$${pnl.toString().padStart(5)}${flag}`);
      }
    }
  }
}

console.log('\n✅ Advanced signals research complete.');
