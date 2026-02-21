/**
 * finalSweep.ts
 * Final comprehensive optimization sweep — combining all research findings
 *
 * Tests all combinations of validated best components:
 * - GoodHours [10,11,12,21] + various signals
 * - BB(20,2.2) vs BB(20,2) — adaptive multiplier upgrade
 * - BB deviation filter (0.05-0.25% sweet spot)
 * - RGGG/GRGG candle sequence + BB
 * - BB(15,2.2) for ETH/15m
 * - ETH/5m vs ETH/15m cross-timeframe comparison
 *
 * Goal: Identify the top 5 production-ready configurations with highest WR × volume
 */

import { getDb } from '../db';

const db = getDb();

interface RawCandle { open_time: number; open: number; high: number; low: number; close: number; volume: number; }

function getCandles(symbol: string, timeframe: string): RawCandle[] {
  return db.prepare(
    'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
  ).all(symbol, timeframe) as RawCandle[];
}

function calcBB(candles: RawCandle[], end: number, period: number, mult: number) {
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
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
    sum += tr;
  }
  return sum / period;
}

function isGreen(c: RawCandle) { return c.close > c.open; }
function isRed(c: RawCandle) { return c.close < c.open; }

interface Signal { bear: boolean; bull: boolean; }

// ── Signal generator: configurable combination ────────────────────────────────

interface Config {
  goodHoursOnly?: boolean;           // [10,11,12,21]
  extHours?: boolean;                // [10,11,12,21,22,23]
  badHoursSkip?: boolean;            // skip [8,9,14,19,20]
  bbPeriod: number;
  bbMult: number;
  streakMin: number;                 // min streak length (2 or 3)
  requireBodyATR?: boolean;          // body/ATR >= 0.9
  requireDevSweetSpot?: boolean;     // BB deviation 0.05-0.25%
  rggPattern?: boolean;              // RGGG/GRGG pattern instead of plain streak
  skipHour14?: boolean;              // skip 14:00 UTC
}

function runConfig(candles: RawCandle[], cfg: Config): { wins: number; total: number } {
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);
  const warmup = cfg.bbPeriod + 15;
  const goodHours = [10, 11, 12, 21];
  const extHoursArr = [10, 11, 12, 21, 22, 23];
  const badHours = [8, 9, 14, 19, 20];

  let wins = 0, total = 0;

  for (let i = warmup + 4; i < test.length - 1; i++) {
    const c = test[i];
    const price = c.close;
    const hour = new Date(c.open_time).getUTCHours();

    // Hour filters
    if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
    if (cfg.extHours && !extHoursArr.includes(hour)) continue;
    if (cfg.badHoursSkip && badHours.includes(hour)) continue;
    if (cfg.skipHour14 && hour === 14) continue;

    const bb = calcBB(test, i, cfg.bbPeriod, cfg.bbMult);
    if (!bb) continue;

    const aboveBB = price > bb.upper;
    const belowBB = price < bb.lower;
    if (!aboveBB && !belowBB) continue;

    // BB deviation filter
    if (cfg.requireDevSweetSpot) {
      const dev = aboveBB ? (price - bb.upper) / bb.upper * 100 : (bb.lower - price) / bb.lower * 100;
      if (dev < 0.05 || dev > 0.25) continue;
    }

    let signal = false;

    if (cfg.rggPattern) {
      // RGGG/GRGG → BEAR pattern (or mirror for bull)
      if (i < 4) continue;
      const c3 = test[i - 3], c2 = test[i - 2], c1 = test[i - 1], c0 = test[i];
      if (aboveBB) {
        signal = (isRed(c3) && isGreen(c2) && isGreen(c1) && isGreen(c0)) ||
                 (isGreen(c3) && isRed(c2) && isGreen(c1) && isGreen(c0));
      } else {
        signal = (isGreen(c3) && isRed(c2) && isRed(c1) && isRed(c0)) ||
                 (isRed(c3) && isGreen(c2) && isRed(c1) && isRed(c0));
      }
    } else {
      // Plain streak
      let green = 0, red = 0;
      for (let j = i; j >= Math.max(0, i - 7); j--) {
        const cj = test[j];
        if (isGreen(cj)) { if (red > 0) break; green++; }
        else if (isRed(cj)) { if (green > 0) break; red++; }
        else break;
      }
      if (aboveBB && green >= cfg.streakMin) signal = true;
      if (belowBB && red >= cfg.streakMin) signal = true;
    }

    if (!signal) continue;

    // Body/ATR quality filter
    if (cfg.requireBodyATR) {
      const atr = calcATR(test, i);
      if (atr > 0) {
        const bodyRatio = Math.abs(c.close - c.open) / atr;
        if (bodyRatio < 0.9) continue;
      }
    }

    total++;
    const isBear = aboveBB;
    const win = isBear ? test[i + 1].close < test[i + 1].open : test[i + 1].close > test[i + 1].open;
    if (win) wins++;
  }

  return { wins, total };
}

// ── Walk-forward runner ───────────────────────────────────────────────────────

function walkForward(candles: RawCandle[], cfg: Config, nFolds = 3): { wr: number; sigma: number; trades: number; folds: string[] } {
  const trainEnd = Math.floor(candles.length * 0.7);
  const testLen = candles.length - trainEnd;
  const foldSize = Math.floor(testLen / nFolds);
  const goodHours = [10, 11, 12, 21];
  const extHoursArr = [10, 11, 12, 21, 22, 23];
  const badHours = [8, 9, 14, 19, 20];
  const warmup = cfg.bbPeriod + 15;

  const foldResults: number[] = [];
  let totalWins = 0, totalTrades = 0;

  for (let fold = 0; fold < nFolds; fold++) {
    const foldStart = trainEnd + fold * foldSize;
    const foldEnd = fold < nFolds - 1 ? foldStart + foldSize : candles.length - 1;
    const foldData = candles.slice(Math.max(0, foldStart - warmup - 5), foldEnd);
    const wm = warmup + 5;

    let wins = 0, total = 0;

    for (let i = wm + 4; i < foldData.length - 1; i++) {
      const c = foldData[i];
      const price = c.close;
      const hour = new Date(c.open_time).getUTCHours();

      if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
      if (cfg.extHours && !extHoursArr.includes(hour)) continue;
      if (cfg.badHoursSkip && badHours.includes(hour)) continue;
      if (cfg.skipHour14 && hour === 14) continue;

      const bb = calcBB(foldData, i, cfg.bbPeriod, cfg.bbMult);
      if (!bb) continue;

      const aboveBB = price > bb.upper;
      const belowBB = price < bb.lower;
      if (!aboveBB && !belowBB) continue;

      if (cfg.requireDevSweetSpot) {
        const dev = aboveBB ? (price - bb.upper) / bb.upper * 100 : (bb.lower - price) / bb.lower * 100;
        if (dev < 0.05 || dev > 0.25) continue;
      }

      let signal = false;
      if (cfg.rggPattern) {
        if (i >= 3) {
          const c3 = foldData[i-3], c2 = foldData[i-2], c1 = foldData[i-1], c0 = foldData[i];
          if (aboveBB) signal = (isRed(c3) && isGreen(c2) && isGreen(c1) && isGreen(c0)) || (isGreen(c3) && isRed(c2) && isGreen(c1) && isGreen(c0));
          else signal = (isGreen(c3) && isRed(c2) && isRed(c1) && isRed(c0)) || (isRed(c3) && isGreen(c2) && isRed(c1) && isRed(c0));
        }
      } else {
        let green = 0, red = 0;
        for (let j = i; j >= Math.max(0, i - 7); j--) {
          const cj = foldData[j];
          if (isGreen(cj)) { if (red > 0) break; green++; }
          else if (isRed(cj)) { if (green > 0) break; red++; }
          else break;
        }
        if (aboveBB && green >= cfg.streakMin) signal = true;
        if (belowBB && red >= cfg.streakMin) signal = true;
      }
      if (!signal) continue;

      if (cfg.requireBodyATR) {
        const atr = calcATR(foldData, i);
        if (atr > 0 && Math.abs(c.close - c.open) / atr < 0.9) continue;
      }

      total++;
      const isBear = aboveBB;
      const win = isBear ? foldData[i+1].close < foldData[i+1].open : foldData[i+1].close > foldData[i+1].open;
      if (win) wins++;
    }

    const fwr = total > 0 ? wins / total * 100 : 0;
    foldResults.push(fwr);
    totalWins += wins;
    totalTrades += total;
  }

  const avg = foldResults.reduce((s, w) => s + w, 0) / nFolds;
  const sigma = Math.sqrt(foldResults.reduce((s, w) => s + (w - avg) ** 2, 0) / nFolds);
  return {
    wr: totalTrades > 0 ? totalWins / totalTrades * 100 : 0,
    sigma,
    trades: totalTrades,
    folds: foldResults.map(w => w.toFixed(1)),
  };
}

// ── Main: test all combinations ───────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════');
console.log('🏆 FINAL COMPREHENSIVE OPTIMIZATION SWEEP');
console.log('══════════════════════════════════════════════════════════════');
console.log('Testing all combinations of validated best components\n');

const ethCandles5m = getCandles('ETH', '5m');
const ethCandles15m = getCandles('ETH', '15m');
const btcCandles15m = getCandles('BTC', '15m');

// ── ETH/5m comprehensive grid ─────────────────────────────────────────────────

console.log('═══ ETH/5m — COMPREHENSIVE GRID (walk-forward, 3 folds)');
console.log('   Sorting by WR × (trades/100) score to balance precision and volume\n');

type CfgEntry = { label: string; cfg: Config };
const configs5m: CfgEntry[] = [
  // Baselines
  { label: 'Baseline GGG+BB(20,2) streak≥3', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3 } },
  { label: 'Skip14 GGG+BB(20,2)', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3, skipHour14: true } },
  // Hour filters
  { label: 'GoodH+GGG+BB(20,2) streak≥3', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.0, streakMin: 3 } },
  { label: 'GoodH+GGG+BB(20,2)+bodyATR', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.0, streakMin: 3, requireBodyATR: true } },
  { label: 'ExtH+BB(20,2)+streak≥2', cfg: { extHours: true, bbPeriod: 20, bbMult: 2.0, streakMin: 2 } },
  { label: 'ExtH+BB(1.5)+streak≥2', cfg: { extHours: true, bbPeriod: 20, bbMult: 1.5, streakMin: 2 } },
  { label: 'ExtH+BB(2)+streak≥2+devFilter', cfg: { extHours: true, bbPeriod: 20, bbMult: 2.0, streakMin: 2, requireDevSweetSpot: true } },
  { label: 'SkipBad+BB(20,2) streak≥3', cfg: { badHoursSkip: true, bbPeriod: 20, bbMult: 2.0, streakMin: 3 } },
  // BB param upgrades
  { label: 'GoodH+GGG+BB(20,2.2)+bodyATR', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.2, streakMin: 3, requireBodyATR: true } },
  { label: 'GoodH+BB(15,2.2)+streak≥3', cfg: { goodHoursOnly: true, bbPeriod: 15, bbMult: 2.2, streakMin: 3 } },
  { label: 'BB(20,2.2) streak≥3', cfg: { bbPeriod: 20, bbMult: 2.2, streakMin: 3 } },
  // Dev filter combinations
  { label: 'BB(20,2)+devFilter streak≥3', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3, requireDevSweetSpot: true } },
  { label: 'GoodH+BB(20,2)+devFilter', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.0, streakMin: 3, requireDevSweetSpot: true } },
  // RGGG pattern
  { label: 'RGGG/GRGG+BB(20,2)', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3, rggPattern: true } },
  { label: 'GoodH+RGGG/GRGG+BB(20,2)', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.0, streakMin: 3, rggPattern: true } },
  { label: 'GoodH+RGGG/GRGG+BB(20,2.2)', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.2, streakMin: 3, rggPattern: true } },
  // Steak length 2
  { label: 'GoodH+BB(20,2) streak≥2', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.0, streakMin: 2 } },
  { label: 'GoodH+BB(20,2.2) streak≥2', cfg: { goodHoursOnly: true, bbPeriod: 20, bbMult: 2.2, streakMin: 2 } },
];

interface Result { label: string; wr: number; sigma: number; trades: number; folds: string[]; score: number; }
const results5m: Result[] = [];

for (const { label, cfg } of configs5m) {
  const r = walkForward(ethCandles5m, cfg, 3);
  const score = r.wr * Math.sqrt(r.trades / 50); // balance WR and volume
  results5m.push({ label, wr: r.wr, sigma: r.sigma, trades: r.trades, folds: r.folds, score });
}

results5m.sort((a, b) => b.score - a.score);
results5m.slice(0, 12).forEach(r => {
  const star = r.wr >= 70 ? ' ⭐⭐⭐' : r.wr >= 65 ? ' ⭐⭐' : r.wr >= 62 ? ' ⭐' : '';
  console.log(`  WR=${r.wr.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.trades} [${r.folds.join('/')}] | ${r.label}${star}`);
});

// ── ETH/15m comprehensive grid ────────────────────────────────────────────────

console.log('\n═══ ETH/15m — COMPREHENSIVE GRID (walk-forward, 3 folds)\n');

const configs15m: CfgEntry[] = [
  { label: 'Baseline GGG+BB(20,2)', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3 } },
  { label: 'GGG+BB(20,2)+bodyATR+skip14', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3, requireBodyATR: true, skipHour14: true } },
  { label: 'GGG+BB(15,2.2)', cfg: { bbPeriod: 15, bbMult: 2.2, streakMin: 3 } },
  { label: 'GGG+BB(20,2.2)', cfg: { bbPeriod: 20, bbMult: 2.2, streakMin: 3 } },
  { label: 'GGG+BB(15,2.2)+bodyATR', cfg: { bbPeriod: 15, bbMult: 2.2, streakMin: 3, requireBodyATR: true } },
  { label: 'GGG+BB(20,2.5)', cfg: { bbPeriod: 20, bbMult: 2.5, streakMin: 3 } },
  { label: 'RGGG/GRGG+BB(20,2)', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3, rggPattern: true } },
  { label: 'RGGG/GRGG+BB(20,2.2)', cfg: { bbPeriod: 20, bbMult: 2.2, streakMin: 3, rggPattern: true } },
  { label: 'RGGG/GRGG+BB(15,2.2)', cfg: { bbPeriod: 15, bbMult: 2.2, streakMin: 3, rggPattern: true } },
  { label: 'GGG+BB(15,2)+bodyATR+skip14', cfg: { bbPeriod: 15, bbMult: 2.0, streakMin: 3, requireBodyATR: true, skipHour14: true } },
];

const results15m: Result[] = [];
for (const { label, cfg } of configs15m) {
  const r = walkForward(ethCandles15m, cfg, 3);
  const score = r.wr * Math.sqrt(r.trades / 30);
  results15m.push({ label, wr: r.wr, sigma: r.sigma, trades: r.trades, folds: r.folds, score });
}

results15m.sort((a, b) => b.score - a.score);
results15m.slice(0, 8).forEach(r => {
  const star = r.wr >= 70 ? ' ⭐⭐⭐' : r.wr >= 65 ? ' ⭐⭐' : r.wr >= 62 ? ' ⭐' : '';
  console.log(`  WR=${r.wr.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.trades} [${r.folds.join('/')}] | ${r.label}${star}`);
});

// ── BTC/15m grid ──────────────────────────────────────────────────────────────

console.log('\n═══ BTC/15m — TOP CONFIGS (walk-forward, 3 folds)\n');

const configsBTC: CfgEntry[] = [
  { label: 'GGG+BB(20,2)', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3 } },
  { label: 'GGG+BB(20,2.2)', cfg: { bbPeriod: 20, bbMult: 2.2, streakMin: 3 } },
  { label: 'RGGG/GRGG+BB(20,2)', cfg: { bbPeriod: 20, bbMult: 2.0, streakMin: 3, rggPattern: true } },
  { label: 'RGGG/GRGG+BB(20,2.2)', cfg: { bbPeriod: 20, bbMult: 2.2, streakMin: 3, rggPattern: true } },
  { label: 'GGG+BB(15,2.2)+bodyATR', cfg: { bbPeriod: 15, bbMult: 2.2, streakMin: 3, requireBodyATR: true } },
];

const resultsBTC: Result[] = [];
for (const { label, cfg } of configsBTC) {
  const r = walkForward(btcCandles15m, cfg, 3);
  const score = r.wr * Math.sqrt(r.trades / 30);
  resultsBTC.push({ label, wr: r.wr, sigma: r.sigma, trades: r.trades, folds: r.folds, score });
}
resultsBTC.sort((a, b) => b.score - a.score);
resultsBTC.forEach(r => {
  const star = r.wr >= 70 ? ' ⭐⭐⭐' : r.wr >= 65 ? ' ⭐⭐' : r.wr >= 62 ? ' ⭐' : '';
  console.log(`  WR=${r.wr.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.trades} [${r.folds.join('/')}] | ${r.label}${star}`);
});

// ── FINAL TOP 5 ACROSS ALL TIMEFRAMES ────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 FINAL TOP 5 PRODUCTION CONFIGURATIONS');
console.log('══════════════════════════════════════════════════════════════\n');

const allResults = [
  ...results5m.map(r => ({ ...r, coin: 'ETH/5m' })),
  ...results15m.map(r => ({ ...r, coin: 'ETH/15m' })),
  ...resultsBTC.map(r => ({ ...r, coin: 'BTC/15m' })),
];
allResults.sort((a, b) => b.score - a.score);

console.log('Ranked by score = WR × sqrt(trades/N):\n');
allResults.slice(0, 10).forEach((r, i) => {
  console.log(`  ${i + 1}. [${r.coin}] WR=${r.wr.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.trades}`);
  console.log(`     Folds: [${r.folds.join('/')}]`);
  console.log(`     Config: ${r.label}`);
});

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ FINAL SWEEP COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
