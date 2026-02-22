/**
 * panicCandleAbsolute.ts
 *
 * Research: Panic candle with ABSOLUTE % price move threshold (not relative ATR)
 *
 * Inspired by Polymarket research: "Overreaction to news events creates 30-60 second
 * windows where prices deviate significantly from equilibrium." & "Status quo bias" —
 * large discrete moves tend to revert.
 *
 * Hypothesis: When a single 5m/15m candle shows an absolute % price move exceeding
 * a threshold AND is at a BB extreme, the next candle is more likely to revert.
 * This is different from body/ATR ratio (strats 6,7) — it tests RAW MOVE SIZE.
 *
 * Configs tested:
 * 1. ETH/5m absolute move >0.2/0.3/0.4/0.5% at BB upper + GoodH
 * 2. ETH/5m absolute move at BB upper + open body (not just close direction)
 * 3. ETH/15m absolute move thresholds
 * 4. BTC/15m absolute move thresholds
 * 5. Walk-forward validation of winners
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

function calcATR(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 0;
  let atrSum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close)
    );
    atrSum += tr;
  }
  return atrSum / period;
}

function calcVolSMA(candles: RawCandle[], end: number, period = 20): number {
  if (end < period - 1) return 0;
  return candles.slice(end - period + 1, end + 1).reduce((s, c) => s + c.volume, 0) / period;
}

type CandleDir = 'G' | 'R';
function getDir(c: RawCandle): CandleDir {
  return c.close >= c.open ? 'G' : 'R';
}

interface TestConfig {
  name: string;
  symbol: string;
  timeframe: string;
  bbPeriod: number;
  bbMult: number;
  goodHoursOnly: boolean;
  extHoursOnly: boolean;
  // Absolute % move of the trigger candle (close vs open)
  minBodyPct: number;    // minimum absolute body % (e.g. 0.003 = 0.3%)
  maxBodyPct: number;    // max body % (0 = no limit)
  // Streak filter
  requireStreak: number; // 0 = disabled
  // Volume filter
  minVolRatio: number;   // 0 = disabled, e.g. 1.5 = vol must be 1.5x SMA
  // BB deviation
  devMin: number;
  devMax: number;
}

const goodHours = [10, 11, 12, 21];
const extHours = [10, 11, 12, 21, 22, 23];

function runTest(cfg: TestConfig): { wr: number; trades: number } {
  const candles = db.prepare(
    'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
  ).all(cfg.symbol, cfg.timeframe) as RawCandle[];

  if (candles.length < 100) return { wr: 0, trades: 0 };

  const wins: number[] = [];

  for (let i = Math.max(cfg.bbPeriod + 14, 30); i < candles.length - 1; i++) {
    const c = candles[i];
    const hour = new Date(c.open_time).getUTCHours();

    if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
    if (cfg.extHoursOnly && !extHours.includes(hour)) continue;

    const bb = calcBB(candles, i, cfg.bbPeriod, cfg.bbMult);
    if (!bb) continue;

    const price = c.close;
    const isBearSetup = price > bb.upper;
    const isBullSetup = price < bb.lower;
    if (!isBearSetup && !isBullSetup) continue;

    // Absolute body % move filter
    const bodyPct = Math.abs(c.close - c.open) / c.open;
    if (bodyPct < cfg.minBodyPct) continue;
    if (cfg.maxBodyPct > 0 && bodyPct > cfg.maxBodyPct) continue;

    // Direction must match: at BB upper → candle must be GREEN (panic buy)
    //                       at BB lower → candle must be RED (panic sell)
    if (isBearSetup && getDir(c) !== 'G') continue;
    if (isBullSetup && getDir(c) !== 'R') continue;

    // BB deviation filter
    if (cfg.devMin > 0 || cfg.devMax < 1) {
      const devPct = isBearSetup
        ? (price - bb.upper) / bb.upper
        : (bb.lower - price) / bb.lower;
      if (devPct < cfg.devMin) continue;
      if (cfg.devMax < 1 && devPct > cfg.devMax) continue;
    }

    // Streak filter
    if (cfg.requireStreak > 0) {
      let streakLen = 1;
      const dir = getDir(c);
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (getDir(candles[j]) === dir) streakLen++;
        else break;
      }
      if (streakLen < cfg.requireStreak) continue;
    }

    // Volume filter
    if (cfg.minVolRatio > 0) {
      const volSMA = calcVolSMA(candles, i - 1, 20);
      if (volSMA <= 0 || c.volume / volSMA < cfg.minVolRatio) continue;
    }

    const nextCandle = candles[i + 1];
    const correct = isBearSetup
      ? nextCandle.close < nextCandle.open
      : nextCandle.close > nextCandle.open;
    wins.push(correct ? 1 : 0);
  }

  const trades = wins.length;
  const wr = trades > 0 ? wins.filter(w => w === 1).length / trades : 0;
  return { wr, trades };
}

function walkForward(cfg: TestConfig, folds = 3): { wr: number; sigma: number; foldWRs: number[]; totalTrades: number } {
  const candles = db.prepare(
    'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
  ).all(cfg.symbol, cfg.timeframe) as RawCandle[];

  if (candles.length < 200) return { wr: 0, sigma: 99, foldWRs: [], totalTrades: 0 };

  const foldSize = Math.floor(candles.length / folds);
  const foldWRs: number[] = [];
  let totalWins = 0;
  let totalTrades = 0;

  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = (f === folds - 1) ? candles.length - 1 : (f + 1) * foldSize - 1;
    const wins: number[] = [];
    const minI = Math.max(start, Math.max(cfg.bbPeriod + 14, 30));

    for (let i = minI; i < end; i++) {
      const c = candles[i];
      const hour = new Date(c.open_time).getUTCHours();

      if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
      if (cfg.extHoursOnly && !extHours.includes(hour)) continue;

      const bb = calcBB(candles, i, cfg.bbPeriod, cfg.bbMult);
      if (!bb) continue;

      const price = c.close;
      const isBearSetup = price > bb.upper;
      const isBullSetup = price < bb.lower;
      if (!isBearSetup && !isBullSetup) continue;

      const bodyPct = Math.abs(c.close - c.open) / c.open;
      if (bodyPct < cfg.minBodyPct) continue;
      if (cfg.maxBodyPct > 0 && bodyPct > cfg.maxBodyPct) continue;

      if (isBearSetup && getDir(c) !== 'G') continue;
      if (isBullSetup && getDir(c) !== 'R') continue;

      if (cfg.devMin > 0 || cfg.devMax < 1) {
        const devPct = isBearSetup
          ? (price - bb.upper) / bb.upper
          : (bb.lower - price) / bb.lower;
        if (devPct < cfg.devMin) continue;
        if (cfg.devMax < 1 && devPct > cfg.devMax) continue;
      }

      if (cfg.requireStreak > 0) {
        let streakLen = 1;
        const dir = getDir(c);
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          if (getDir(candles[j]) === dir) streakLen++;
          else break;
        }
        if (streakLen < cfg.requireStreak) continue;
      }

      if (cfg.minVolRatio > 0) {
        const volSMA = calcVolSMA(candles, i - 1, 20);
        if (volSMA <= 0 || c.volume / volSMA < cfg.minVolRatio) continue;
      }

      const nextCandle = candles[i + 1];
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
  const sigma = Math.sqrt(variance);

  return { wr: mean, sigma, foldWRs, totalTrades };
}

function printRow(name: string, wr: number, trades: number, minT = 30, minWR = 0.68) {
  const flag = wr >= 0.72 && trades >= minT ? ' ⭐⭐⭐' : wr >= minWR && trades >= minT ? ' ⭐⭐' : wr >= 0.65 && trades >= 20 ? ' ⭐' : '';
  console.log(`  ${name.padEnd(58)} WR=${(wr * 100).toFixed(1).padStart(5)}%  T=${String(trades).padStart(3)}${flag}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('══════════════════════════════════════════════════════════════════');
console.log('PANIC CANDLE ABSOLUTE % MOVE REVERSION RESEARCH');
console.log('Inspired by Polymarket "overreaction" + "status quo bias" findings');
console.log('══════════════════════════════════════════════════════════════════\n');

// ─── PART 1: ETH/5m absolute body % threshold sweep ──────────────────────────
console.log('PART 1: ETH/5m — Absolute body % sweep (at BB upper, GoodH)');
console.log('─────────────────────────────────────────────────────────────');

const eth5mThresholds = [
  { minBodyPct: 0.001, maxBodyPct: 0, name: '>0.1% body' },
  { minBodyPct: 0.002, maxBodyPct: 0, name: '>0.2% body' },
  { minBodyPct: 0.003, maxBodyPct: 0, name: '>0.3% body' },
  { minBodyPct: 0.004, maxBodyPct: 0, name: '>0.4% body' },
  { minBodyPct: 0.005, maxBodyPct: 0, name: '>0.5% body' },
  { minBodyPct: 0.002, maxBodyPct: 0.004, name: '0.2-0.4% body' },
  { minBodyPct: 0.002, maxBodyPct: 0.006, name: '0.2-0.6% body' },
  { minBodyPct: 0.003, maxBodyPct: 0.008, name: '0.3-0.8% body' },
];

for (const thresh of eth5mThresholds) {
  const cfg: TestConfig = {
    name: `ETH/5m ${thresh.name} + BB(20,2.2) + GoodH`,
    symbol: 'ETH', timeframe: '5m',
    bbPeriod: 20, bbMult: 2.2,
    goodHoursOnly: true, extHoursOnly: false,
    minBodyPct: thresh.minBodyPct, maxBodyPct: thresh.maxBodyPct,
    requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1,
  };
  const r = runTest(cfg);
  printRow(cfg.name, r.wr, r.trades);
}

// ─── PART 2: ETH/5m + streak filter ─────────────────────────────────────────
console.log('\nPART 2: ETH/5m — Absolute body % + streak filter');
console.log('─────────────────────────────────────────────────');

const eth5mStreakCfgs: TestConfig[] = [
  { name: 'ETH/5m >0.2% + streak≥2 + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.002, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.3% + streak≥2 + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.2% + streak≥3 + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.002, maxBodyPct: 0, requireStreak: 3, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.3% + streak≥3 + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 3, minVolRatio: 0, devMin: 0, devMax: 1 },
  // Without GoodH — more trades but lower WR?
  { name: 'ETH/5m >0.3% + streak≥2 + BB(20,2.2) no hour', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.3% + streak≥2 + BB(20,2.2) + ExtH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: true, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
];

for (const cfg of eth5mStreakCfgs) {
  const r = runTest(cfg);
  printRow(cfg.name, r.wr, r.trades);
}

// ─── PART 3: ETH/5m + volume filter ─────────────────────────────────────────
console.log('\nPART 3: ETH/5m — Volume surge + absolute move');
console.log('─────────────────────────────────────────────────');

const eth5mVolCfgs: TestConfig[] = [
  { name: 'ETH/5m >0.2% + vol>1.5x + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.002, maxBodyPct: 0, requireStreak: 0, minVolRatio: 1.5, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.2% + vol>2.0x + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.002, maxBodyPct: 0, requireStreak: 0, minVolRatio: 2.0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.3% + vol>2.0x + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 0, minVolRatio: 2.0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.2% + vol>1.5x + streak≥2 + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.002, maxBodyPct: 0, requireStreak: 2, minVolRatio: 1.5, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.3% + vol>1.5x + streak≥2 + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 2, minVolRatio: 1.5, devMin: 0, devMax: 1 },
];

for (const cfg of eth5mVolCfgs) {
  const r = runTest(cfg);
  printRow(cfg.name, r.wr, r.trades);
}

// ─── PART 4: ETH/15m — absolute body % ──────────────────────────────────────
console.log('\nPART 4: ETH/15m — Absolute body % sweep');
console.log('─────────────────────────────────────────────────');

const eth15mCfgs: TestConfig[] = [
  { name: 'ETH/15m >0.3% body + BB(15,2.2) no hour', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m >0.5% body + BB(15,2.2) no hour', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m >0.3% body + BB(15,2.2) + GoodH', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m >0.5% body + BB(15,2.2) + GoodH', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m >0.3% body + streak≥2 + BB(15,2.2)', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m >0.5% body + streak≥2 + BB(15,2.2)', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
];

for (const cfg of eth15mCfgs) {
  const r = runTest(cfg);
  printRow(cfg.name, r.wr, r.trades, 20);
}

// ─── PART 5: BTC/15m — absolute body % ──────────────────────────────────────
console.log('\nPART 5: BTC/15m — Absolute body % sweep');
console.log('─────────────────────────────────────────────────');

const btc15mCfgs: TestConfig[] = [
  { name: 'BTC/15m >0.3% body + BB(20,2.0) no hour', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m >0.5% body + BB(20,2.0) no hour', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m >0.3% body + streak≥2 + BB(20,2.0)', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m >0.5% body + streak≥2 + BB(20,2.0)', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m >0.3% body + GoodH + BB(20,2.0)', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
];

for (const cfg of btc15mCfgs) {
  const r = runTest(cfg);
  printRow(cfg.name, r.wr, r.trades, 20);
}

// ─── PART 6: Walk-Forward of top results ─────────────────────────────────────
console.log('\nPART 6: Walk-Forward Validation (3-fold) of top candidates');
console.log('─────────────────────────────────────────────────────────────');

// Run all configs + flag those with WR >= 0.67 for walk-forward
const allCfgsForWF: TestConfig[] = [
  // ETH/5m candidates
  { name: 'ETH/5m >0.2% + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.002, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.3% + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.3% + streak≥2 + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.003, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m >0.2% + vol>1.5x + BB(20,2.2) + GoodH', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, minBodyPct: 0.002, maxBodyPct: 0, requireStreak: 0, minVolRatio: 1.5, devMin: 0, devMax: 1 },
  // ETH/15m candidates
  { name: 'ETH/15m >0.5% + BB(15,2.2) no hour', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m >0.5% + streak≥2 + BB(15,2.2)', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
  // BTC/15m candidates
  { name: 'BTC/15m >0.5% + BB(20,2.0) no hour', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 0, minVolRatio: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m >0.5% + streak≥2 + BB(20,2.0)', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, minBodyPct: 0.005, maxBodyPct: 0, requireStreak: 2, minVolRatio: 0, devMin: 0, devMax: 1 },
];

for (const cfg of allCfgsForWF) {
  const wf = walkForward(cfg, 3);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.70 && wf.sigma <= 0.06 && wf.totalTrades >= 30 ? ' ⭐⭐⭐'
             : wf.wr >= 0.67 && wf.sigma <= 0.08 && wf.totalTrades >= 20 ? ' ⭐⭐'
             : wf.wr >= 0.63 && wf.totalTrades >= 15 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(50)} WR=${(wf.wr * 100).toFixed(1).padStart(5)}% σ=${(wf.sigma * 100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('✅ PANIC CANDLE RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════════');
