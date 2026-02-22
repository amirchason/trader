/**
 * panicRGGGCombo.ts
 *
 * Research: Combine RGGG candle sequence WITH absolute panic candle % move filter
 *
 * Key insight: Our best signals combine candle sequences + BB. From panicCandleAbsolute.ts:
 * >0.5% body + GoodH + BB: 71.8% WR (T=71). But too few trades.
 * >0.3% body + streak≥2 + GoodH + BB: 68.3% WR (T=141)
 *
 * New hypothesis: Require RGGG pattern WHERE the last G candle (the entry candle)
 * has body >= threshold (panic buy). This ensures the entry signal combines:
 * - 3-candle reversal setup (RGGG)
 * - Current candle is a "panic" green candle (large absolute move)
 * - At BB extreme + GoodH
 *
 * Also test: Daily candle regime filter (from Polymarket "serial correlation" finding)
 * When yesterday was a BIG GREEN day, do our 5m bearish signals work better?
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

function calcBB(candles: RawCandle[], end: number, period = 20, mult = 2.0) {
  if (end < period - 1) return null;
  const slice = candles.slice(end - period + 1, end + 1);
  const closes = slice.map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, lower: mean - mult * std, middle: mean, std };
}

function calcRSI(candles: RawCandle[], end: number, period = 14): number {
  if (end < period + 1) return 50;
  let gains = 0; let losses = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcVolSMA(candles: RawCandle[], end: number, period = 20): number {
  if (end < period - 1) return 0;
  return candles.slice(end - period + 1, end + 1).reduce((s, c) => s + c.volume, 0) / period;
}

type CandleDir = 'G' | 'R';
function getDir(c: RawCandle): CandleDir { return c.close >= c.open ? 'G' : 'R'; }

const goodHours = [10, 11, 12, 21];
const extHours = [10, 11, 12, 21, 22, 23];

// Load data
const ethCandles5m = db.prepare(
  'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
).all('ETH', '5m') as RawCandle[];

const ethCandles1d = db.prepare(
  'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
).all('ETH', '1d') as RawCandle[];

console.log(`Loaded ETH/5m: ${ethCandles5m.length} candles, ETH/1d: ${ethCandles1d.length} candles`);

// Build daily candle lookup by date (YYYY-MM-DD string)
const dailyByDate = new Map<string, RawCandle>();
for (const c of ethCandles1d) {
  const d = new Date(c.open_time);
  const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  dailyByDate.set(key, c);
}

function getYesterdayDaily(openTime: number): RawCandle | null {
  const d = new Date(openTime);
  // Go back one day
  const yesterday = new Date(d.getTime() - 86400_000);
  const key = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}-${String(yesterday.getUTCDate()).padStart(2, '0')}`;
  return dailyByDate.get(key) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════');
console.log('PANIC CANDLE + RGGG COMBO + DAILY REGIME RESEARCH');
console.log('══════════════════════════════════════════════════════════════════\n');

interface PanicRGGGConfig {
  name: string;
  bbPeriod: number;
  bbMult: number;
  goodHoursOnly: boolean;
  extHoursOnly: boolean;
  // Pattern: RGGG, GRGG, both, or any streak≥N
  patterns: string[];
  // Panic candle threshold on the LAST (entry) candle
  minPanicPct: number;    // 0 = disabled
  // Panic on ANY G candle in the sequence (not just last)
  anyPanic: boolean;
  // Require streak ≥ N (alternative to RGGG pattern)
  requireStreak: number;
  // RSI filter
  rsiMin: number; // RSI must be > this (for bear setup at BB upper, high RSI = overbought)
  // Volume filter
  minVolRatio: number;
  // Daily regime filter
  dailyGreenFilter: boolean;   // yesterday daily was GREEN by >= dailyGreenPct
  dailyGreenPct: number;       // e.g. 0.005 = 0.5%
}

function runPanicRGGG(cfg: PanicRGGGConfig): { wr: number; trades: number } {
  const wins: number[] = [];

  for (let i = Math.max(cfg.bbPeriod + 14, 30); i < ethCandles5m.length - 1; i++) {
    const c = ethCandles5m[i];
    const hour = new Date(c.open_time).getUTCHours();

    if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
    if (cfg.extHoursOnly && !extHours.includes(hour)) continue;

    const bb = calcBB(ethCandles5m, i, cfg.bbPeriod, cfg.bbMult);
    if (!bb) continue;

    const price = c.close;
    const isBearSetup = price > bb.upper;
    const isBullSetup = price < bb.lower;
    if (!isBearSetup && !isBullSetup) continue;

    // Direction: at BB upper → entry candle must be GREEN (panic buy)
    //            at BB lower → entry candle must be RED (panic sell)
    const entryDir = isBearSetup ? 'G' : 'R';
    if (getDir(c) !== entryDir) continue;

    // Pattern filter
    if (cfg.patterns.length > 0) {
      const seq = [getDir(ethCandles5m[i - 3]), getDir(ethCandles5m[i - 2]), getDir(ethCandles5m[i - 1]), getDir(c)].join('');
      if (!cfg.patterns.includes(seq)) continue;
    }

    // Streak filter (alternative to pattern)
    if (cfg.requireStreak > 0 && cfg.patterns.length === 0) {
      let streak = 1;
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (getDir(ethCandles5m[j]) === entryDir) streak++;
        else break;
      }
      if (streak < cfg.requireStreak) continue;
    }

    // Panic candle % on ENTRY candle
    if (cfg.minPanicPct > 0) {
      const bodyPct = Math.abs(c.close - c.open) / c.open;
      if (bodyPct < cfg.minPanicPct) continue;
    }

    // Panic on ANY G candle in the RGGG sequence
    if (cfg.anyPanic && cfg.minPanicPct > 0) {
      const gCandles = [ethCandles5m[i - 2], ethCandles5m[i - 1], c].filter(x => getDir(x) === entryDir);
      const hasPanic = gCandles.some(x => Math.abs(x.close - x.open) / x.open >= cfg.minPanicPct);
      if (!hasPanic) continue;
    }

    // RSI filter
    if (cfg.rsiMin > 0) {
      const rsi = calcRSI(ethCandles5m, i);
      if (isBearSetup && rsi < cfg.rsiMin) continue;
      if (isBullSetup && rsi > (100 - cfg.rsiMin)) continue;
    }

    // Volume filter
    if (cfg.minVolRatio > 0) {
      const volSMA = calcVolSMA(ethCandles5m, i - 1, 20);
      if (volSMA <= 0 || c.volume / volSMA < cfg.minVolRatio) continue;
    }

    // Daily regime filter: yesterday was a big GREEN day?
    if (cfg.dailyGreenFilter) {
      const yesterday = getYesterdayDaily(c.open_time);
      if (!yesterday) continue;
      const dailyMove = (yesterday.close - yesterday.open) / yesterday.open;
      if (isBearSetup && dailyMove < cfg.dailyGreenPct) continue;
      if (isBullSetup && dailyMove > -cfg.dailyGreenPct) continue;
    }

    const nextCandle = ethCandles5m[i + 1];
    const correct = isBearSetup
      ? nextCandle.close < nextCandle.open
      : nextCandle.close > nextCandle.open;
    wins.push(correct ? 1 : 0);
  }

  const trades = wins.length;
  const wr = trades > 0 ? wins.filter(w => w === 1).length / trades : 0;
  return { wr, trades };
}

function walkForwardPR(cfg: PanicRGGGConfig, folds = 3): { wr: number; sigma: number; foldWRs: number[]; totalTrades: number } {
  const foldSize = Math.floor(ethCandles5m.length / folds);
  const foldWRs: number[] = [];
  let totalTrades = 0;
  let totalWins = 0;

  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = (f === folds - 1) ? ethCandles5m.length - 1 : (f + 1) * foldSize - 1;
    const wins: number[] = [];
    const minI = Math.max(start, Math.max(cfg.bbPeriod + 14, 30));

    for (let i = minI; i < end; i++) {
      const c = ethCandles5m[i];
      const hour = new Date(c.open_time).getUTCHours();

      if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
      if (cfg.extHoursOnly && !extHours.includes(hour)) continue;

      const bb = calcBB(ethCandles5m, i, cfg.bbPeriod, cfg.bbMult);
      if (!bb) continue;

      const price = c.close;
      const isBearSetup = price > bb.upper;
      const isBullSetup = price < bb.lower;
      if (!isBearSetup && !isBullSetup) continue;

      const entryDir = isBearSetup ? 'G' : 'R';
      if (getDir(c) !== entryDir) continue;

      if (cfg.patterns.length > 0) {
        const seq = [getDir(ethCandles5m[i - 3]), getDir(ethCandles5m[i - 2]), getDir(ethCandles5m[i - 1]), getDir(c)].join('');
        if (!cfg.patterns.includes(seq)) continue;
      }

      if (cfg.requireStreak > 0 && cfg.patterns.length === 0) {
        let streak = 1;
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          if (getDir(ethCandles5m[j]) === entryDir) streak++;
          else break;
        }
        if (streak < cfg.requireStreak) continue;
      }

      if (cfg.minPanicPct > 0 && !cfg.anyPanic) {
        const bodyPct = Math.abs(c.close - c.open) / c.open;
        if (bodyPct < cfg.minPanicPct) continue;
      }

      if (cfg.anyPanic && cfg.minPanicPct > 0) {
        const gCandles = [ethCandles5m[i - 2], ethCandles5m[i - 1], c].filter(x => getDir(x) === entryDir);
        const hasPanic = gCandles.some(x => Math.abs(x.close - x.open) / x.open >= cfg.minPanicPct);
        if (!hasPanic) continue;
      }

      if (cfg.rsiMin > 0) {
        const rsi = calcRSI(ethCandles5m, i);
        if (isBearSetup && rsi < cfg.rsiMin) continue;
        if (isBullSetup && rsi > (100 - cfg.rsiMin)) continue;
      }

      if (cfg.minVolRatio > 0) {
        const volSMA = calcVolSMA(ethCandles5m, i - 1, 20);
        if (volSMA <= 0 || c.volume / volSMA < cfg.minVolRatio) continue;
      }

      if (cfg.dailyGreenFilter) {
        const yesterday = getYesterdayDaily(c.open_time);
        if (!yesterday) continue;
        const dailyMove = (yesterday.close - yesterday.open) / yesterday.open;
        if (isBearSetup && dailyMove < cfg.dailyGreenPct) continue;
        if (isBullSetup && dailyMove > -cfg.dailyGreenPct) continue;
      }

      const nextCandle = ethCandles5m[i + 1];
      if (!nextCandle) continue;
      const correct = isBearSetup
        ? nextCandle.close < nextCandle.open
        : nextCandle.close > nextCandle.open;
      wins.push(correct ? 1 : 0);
    }

    const foldWR = wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0;
    foldWRs.push(foldWR);
    totalWins += wins.filter(w => w === 1).length;
    totalTrades += wins.length;
  }

  const mean = foldWRs.reduce((a, b) => a + b, 0) / folds;
  const variance = foldWRs.reduce((sum, wr) => sum + Math.pow(wr - mean, 2), 0) / folds;
  return { wr: mean, sigma: Math.sqrt(variance), foldWRs, totalTrades };
}

function printRow(name: string, wr: number, trades: number) {
  const flag = wr >= 0.74 && trades >= 30 ? ' ⭐⭐⭐' : wr >= 0.70 && trades >= 25 ? ' ⭐⭐' : wr >= 0.67 && trades >= 20 ? ' ⭐' : '';
  console.log(`  ${name.padEnd(60)} WR=${(wr * 100).toFixed(1).padStart(5)}%  T=${String(trades).padStart(3)}${flag}`);
}

// ─── PART 1: RGGG + panic entry candle ───────────────────────────────────────
console.log('PART 1: RGGG/GRGG + panic entry candle (GoodH + BB(20,2.2))');
console.log('─────────────────────────────────────────────────────────────');

const rgggPanicCfgs: PanicRGGGConfig[] = [
  // RGGG baseline (should match ~75.9%)
  { name: 'RGGG/GRGG + GoodH + BB(20,2.2) [baseline]', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  // RGGG + last candle panic ≥0.2%
  { name: 'RGGG/GRGG + panic≥0.2% (last G) + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.002, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RGGG/GRGG + panic≥0.3% (last G) + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.003, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RGGG/GRGG + panic≥0.4% (last G) + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.004, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RGGG/GRGG + panic≥0.5% (last G) + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.005, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  // ANY G in RGGG has panic
  { name: 'RGGG/GRGG + any-G≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.003, anyPanic: true, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RGGG/GRGG + any-G≥0.4% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.004, anyPanic: true, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
];

for (const cfg of rgggPanicCfgs) {
  const r = runPanicRGGG(cfg);
  printRow(cfg.name, r.wr, r.trades);
}

// ─── PART 2: streak≥2 + panic (no specific pattern) ─────────────────────────
console.log('\nPART 2: streak≥2 + panic entry (no RGGG pattern required)');
console.log('─────────────────────────────────────────────────────────────');

const streakPanicCfgs: PanicRGGGConfig[] = [
  { name: 'streak≥2 + panic≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'streak≥2 + panic≥0.4% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.004, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'streak≥2 + panic≥0.5% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.005, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'streak≥3 + panic≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 3, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'streak≥3 + panic≥0.4% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.004, anyPanic: false, requireStreak: 3, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'streak≥2 + panic≥0.3% + ExtH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: true, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'streak≥2 + panic≥0.4% + ExtH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: true, patterns: [], minPanicPct: 0.004, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
];

for (const cfg of streakPanicCfgs) {
  const r = runPanicRGGG(cfg);
  printRow(cfg.name, r.wr, r.trades);
}

// ─── PART 3: RSI filter + panic ───────────────────────────────────────────────
console.log('\nPART 3: RSI overbought + panic (at BB upper, GoodH)');
console.log('─────────────────────────────────────────────────────────────');

const rsiPanicCfgs: PanicRGGGConfig[] = [
  { name: 'RSI>65 + panic≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 0, rsiMin: 65, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RSI>70 + panic≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 0, rsiMin: 70, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RSI>65 + panic≥0.3% + streak≥2 + GoodH + BB', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 2, rsiMin: 65, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RSI>70 + streak≥2 + GoodH + BB(20,2.2) [no panic]', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 70, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RSI>65 + streak≥2 + GoodH + BB(20,2.2) [no panic]', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 65, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
];

for (const cfg of rsiPanicCfgs) {
  const r = runPanicRGGG(cfg);
  printRow(cfg.name, r.wr, r.trades);
}

// ─── PART 4: Daily regime filter ─────────────────────────────────────────────
console.log('\nPART 4: Daily regime filter (from Polymarket serial-correlation finding)');
console.log('─────────────────────────────────────────────────────────────');
console.log('  "58% negative serial correlation after large daily moves"');

const dailyCfgs: PanicRGGGConfig[] = [
  // Baseline: GoodH+BB+streak≥2 with daily filter
  { name: 'GoodH+BB+s≥2 + yesterday GREEN >0.5%', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: true, dailyGreenPct: 0.005 },
  { name: 'GoodH+BB+s≥2 + yesterday GREEN >1.0%', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: true, dailyGreenPct: 0.010 },
  { name: 'GoodH+BB+s≥2 + yesterday GREEN >2.0%', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: true, dailyGreenPct: 0.020 },
  // Daily filter + RGGG
  { name: 'RGGG/GRGG+GoodH+BB + yesterday GREEN >0.5%', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: true, dailyGreenPct: 0.005 },
  { name: 'RGGG/GRGG+GoodH+BB + yesterday GREEN >1.0%', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: true, dailyGreenPct: 0.010 },
  // Daily filter + panic
  { name: 'streak≥2+panic≥0.3%+GoodH+BB + yesterday GREEN >0.5%', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: true, dailyGreenPct: 0.005 },
];

if (ethCandles1d.length === 0) {
  console.log('  ⚠️  No ETH/1d candles found in DB — skipping daily regime tests');
} else {
  for (const cfg of dailyCfgs) {
    const r = runPanicRGGG(cfg);
    printRow(cfg.name, r.wr, r.trades);
  }
}

// ─── PART 5: Walk-Forward Validation of top candidates ────────────────────────
console.log('\nPART 5: Walk-Forward Validation (3-fold) of top candidates');
console.log('─────────────────────────────────────────────────────────────');

const wfCandidates: PanicRGGGConfig[] = [
  // RGGG + various panic thresholds
  { name: 'RGGG/GRGG + panic≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.003, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RGGG/GRGG + panic≥0.4% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.004, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RGGG/GRGG + any-G≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.003, anyPanic: true, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  // streak-based
  { name: 'streak≥2 + panic≥0.4% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.004, anyPanic: false, requireStreak: 2, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'streak≥3 + panic≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 3, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  // RSI-based
  { name: 'RSI>65 + streak≥2 + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 65, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RSI>70 + streak≥2 + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 70, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  // RSI + panic
  { name: 'RSI>65 + panic≥0.3% + streak≥2 + GoodH + BB', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 2, rsiMin: 65, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
];

for (const cfg of wfCandidates) {
  const wf = walkForwardPR(cfg, 3);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.72 && wf.sigma <= 0.05 && wf.totalTrades >= 30 ? ' ⭐⭐⭐'
             : wf.wr >= 0.70 && wf.sigma <= 0.07 && wf.totalTrades >= 20 ? ' ⭐⭐'
             : wf.wr >= 0.67 && wf.totalTrades >= 15 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(52)} WR=${(wf.wr * 100).toFixed(1).padStart(5)}% σ=${(wf.sigma * 100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

// ─── PART 6: 5-fold of absolute best ─────────────────────────────────────────
console.log('\nPART 6: 5-fold Walk-Forward of top performers');
console.log('─────────────────────────────────────────────────────────────');

const best5F: PanicRGGGConfig[] = [
  { name: 'RGGG/GRGG + GoodH + BB(20,2.2) [baseline verify]', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RGGG/GRGG + panic≥0.3% + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], minPanicPct: 0.003, anyPanic: false, requireStreak: 0, rsiMin: 0, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RSI>65 + streak≥2 + GoodH + BB(20,2.2)', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0, anyPanic: false, requireStreak: 2, rsiMin: 65, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
  { name: 'RSI>65 + panic≥0.3% + streak≥2 + GoodH + BB', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: [], minPanicPct: 0.003, anyPanic: false, requireStreak: 2, rsiMin: 65, minVolRatio: 0, dailyGreenFilter: false, dailyGreenPct: 0 },
];

for (const cfg of best5F) {
  const wf = walkForwardPR(cfg, 5);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.72 && wf.sigma <= 0.05 ? ' ⭐⭐⭐'
             : wf.wr >= 0.70 && wf.sigma <= 0.07 ? ' ⭐⭐'
             : wf.wr >= 0.67 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(52)} WR=${(wf.wr * 100).toFixed(1).padStart(5)}% σ=${(wf.sigma * 100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('✅ PANIC + RGGG COMBO RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════════');
