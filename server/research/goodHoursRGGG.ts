/**
 * goodHoursRGGG.ts
 *
 * Research: Combine GoodH[10,11,12,21] + BB(20,2.2) + RGGG/GRGG candle sequences
 *
 * Hypothesis: The two best independent signals (GoodH+BB = 69.8% σ=1.1%,
 * RGGG at BB = 75.9%) should combine to create a very high-precision sniper.
 *
 * Configs tested:
 * 1. GoodH + BB(20,2.2) + RGGG/GRGG (strict)
 * 2. GoodH + BB(20,2.2) + RGGG/GRGG + streak≥2
 * 3. GoodH + BB(20,2.5) + RGGG/GRGG (wider band)
 * 4. GoodH + BB(20,2.2) + RGGG only (single pattern)
 * 5. ExtH[10-12,21-23] + BB(20,2.2) + RGGG/GRGG (more trades)
 * 6. GoodH + BB(15,2.2) + RGGG/GRGG (ETH/15m)
 * 7. Walk-forward validation of best combo
 * 8. BTC/15m RGGG/GRGG + GoodH equivalent
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
  patterns: string[]; // e.g. ['RGGG', 'GRGG'] or ['RGGG'] etc.
  requireStreak: number; // min streak in direction (0 = disabled)
  devMin: number; // min % outside BB (0 = disabled)
  devMax: number; // max % outside BB (0 = disabled, 1 = any)
}

function runTest(cfg: TestConfig): { wr: number; trades: number; results: number[] } {
  const candles = db.prepare(
    'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
  ).all(cfg.symbol, cfg.timeframe) as RawCandle[];

  if (candles.length < 100) return { wr: 0, trades: 0, results: [] };

  const goodHours = [10, 11, 12, 21];
  const extHours = [10, 11, 12, 21, 22, 23];

  const wins: number[] = [];

  for (let i = Math.max(cfg.bbPeriod + 4, 20); i < candles.length - 1; i++) {
    const c = candles[i];
    const hour = new Date(c.open_time).getUTCHours();

    // Hour filter
    if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
    if (cfg.extHoursOnly && !extHours.includes(hour)) continue;

    // BB check
    const bb = calcBB(candles, i, cfg.bbPeriod, cfg.bbMult);
    if (!bb) continue;

    const price = c.close;
    const isBearSetup = price > bb.upper;
    const isBullSetup = price < bb.lower;
    if (!isBearSetup && !isBullSetup) continue;

    // BB deviation filter
    if (cfg.devMin > 0 || cfg.devMax < 1) {
      const devPct = isBearSetup
        ? (price - bb.upper) / bb.upper
        : (bb.lower - price) / bb.lower;
      if (devPct < cfg.devMin) continue;
      if (cfg.devMax < 1 && devPct > cfg.devMax) continue;
    }

    // Candle sequence pattern check (look at last 4 candles ending at i)
    // Pattern is direction of candles[i-3], [i-2], [i-1], [i]
    if (cfg.patterns.length > 0) {
      const seq = [
        getDir(candles[i - 3]),
        getDir(candles[i - 2]),
        getDir(candles[i - 1]),
        getDir(candles[i]),
      ].join('');
      if (!cfg.patterns.includes(seq)) continue;
    }

    // Optional streak check (count consecutive same-direction candles ending at i)
    if (cfg.requireStreak > 0) {
      let streakLen = 1;
      const dir = getDir(c);
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (getDir(candles[j]) === dir) streakLen++;
        else break;
      }
      if (streakLen < cfg.requireStreak) continue;
    }

    // Predict: expect reversion
    const nextCandle = candles[i + 1];
    let correct: boolean;
    if (isBearSetup) {
      // expect bear (next close < next open)
      correct = nextCandle.close < nextCandle.open;
    } else {
      // expect bull (next close > next open)
      correct = nextCandle.close > nextCandle.open;
    }
    wins.push(correct ? 1 : 0);
  }

  const trades = wins.length;
  const wr = trades > 0 ? wins.filter(w => w === 1).length / trades : 0;
  return { wr, trades, results: wins };
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

  const goodHours = [10, 11, 12, 21];
  const extHours = [10, 11, 12, 21, 22, 23];

  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = (f === folds - 1) ? candles.length - 1 : (f + 1) * foldSize - 1;
    const foldCandles = candles.slice(0, end + 1); // simulate not knowing future
    const wins: number[] = [];

    const minI = Math.max(start, Math.max(cfg.bbPeriod + 4, 20));
    for (let i = minI; i < end; i++) {
      const c = foldCandles[i];
      const hour = new Date(c.open_time).getUTCHours();

      if (cfg.goodHoursOnly && !goodHours.includes(hour)) continue;
      if (cfg.extHoursOnly && !extHours.includes(hour)) continue;

      const bb = calcBB(foldCandles, i, cfg.bbPeriod, cfg.bbMult);
      if (!bb) continue;

      const price = c.close;
      const isBearSetup = price > bb.upper;
      const isBullSetup = price < bb.lower;
      if (!isBearSetup && !isBullSetup) continue;

      if (cfg.devMin > 0 || cfg.devMax < 1) {
        const devPct = isBearSetup
          ? (price - bb.upper) / bb.upper
          : (bb.lower - price) / bb.lower;
        if (devPct < cfg.devMin) continue;
        if (cfg.devMax < 1 && devPct > cfg.devMax) continue;
      }

      if (cfg.patterns.length > 0) {
        const seq = [
          getDir(foldCandles[i - 3]),
          getDir(foldCandles[i - 2]),
          getDir(foldCandles[i - 1]),
          getDir(foldCandles[i]),
        ].join('');
        if (!cfg.patterns.includes(seq)) continue;
      }

      if (cfg.requireStreak > 0) {
        let streakLen = 1;
        const dir = getDir(c);
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          if (getDir(foldCandles[j]) === dir) streakLen++;
          else break;
        }
        if (streakLen < cfg.requireStreak) continue;
      }

      const nextCandle = foldCandles[i + 1];
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

console.log('══════════════════════════════════════════════════════════════');
console.log('GoodH + BB + RGGG/GRGG COMBO RESEARCH');
console.log('══════════════════════════════════════════════════════════════\n');

// ─── PART 1: ETH/5m — all RGGG/GRGG pattern variants ───────────────────────
console.log('PART 1: ETH/5m Pattern × Hour × BB combinations');
console.log('─────────────────────────────────────────────────');

const eth5mConfigs: TestConfig[] = [
  // Baseline: just RGGG/GRGG at BB (no hour filter)
  { name: 'RGGG/GRGG at BB(20,2) no hour', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // RGGG/GRGG at BB(20,2) + GoodH
  { name: 'RGGG/GRGG + GoodH + BB(20,2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // RGGG/GRGG at BB(20,2.2) + GoodH
  { name: 'RGGG/GRGG + GoodH + BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // RGGG/GRGG at BB(20,2.5) + GoodH
  { name: 'RGGG/GRGG + GoodH + BB(20,2.5)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.5, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // RGGG only + GoodH + BB(20,2.2) — RGGG is stronger (75.9%)
  { name: 'RGGG only + GoodH + BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // GRGG only + GoodH + BB(20,2.2)
  { name: 'GRGG only + GoodH + BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // RGGG/GRGG + ExtH + BB(20,2.2) — more trades
  { name: 'RGGG/GRGG + ExtH + BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: true, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // RGGG/GRGG + GoodH + BB(20,2.2) + devFilter
  { name: 'RGGG/GRGG + GoodH + BB(20,2.2) + dev[0.05-0.25%]', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0.0005, devMax: 0.0025 },
  // Wider variety: GGGG or RRRR (4-same)
  { name: 'GGGG/RRRR at BB + GoodH + BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['GGGG', 'RRRR'], requireStreak: 0, devMin: 0, devMax: 1 },
  // GGG_ at BB (3G in last 4, last is trigger) = GGGR or GGGG
  { name: 'GGGR/RRRG at BB + GoodH + BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['GGGR', 'RRRG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // Any 3-green in sequence
  { name: 'Any 3G in last 4 + GoodH + BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['GGGG', 'RGGG', 'GRGG', 'GGRG'], requireStreak: 0, devMin: 0, devMax: 1 },
];

for (const cfg of eth5mConfigs) {
  const r = runTest(cfg);
  const flag = r.wr >= 0.68 && r.trades >= 30 ? ' ⭐⭐⭐' : r.wr >= 0.65 && r.trades >= 25 ? ' ⭐⭐' : r.wr >= 0.62 && r.trades >= 20 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(52)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}${flag}`);
}

// ─── PART 2: ETH/15m — RGGG/GRGG + BB combos ─────────────────────────────
console.log('\nPART 2: ETH/15m Pattern × BB combinations');
console.log('─────────────────────────────────────────────────');

const eth15mConfigs: TestConfig[] = [
  // Baseline RGGG/GRGG (known ~75% WR on 15m)
  { name: 'RGGG/GRGG at BB(20,2) ETH/15m', symbol: 'ETH', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // Best 15m BB params: BB(15,2.2)
  { name: 'RGGG/GRGG at BB(15,2.2) ETH/15m', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // With GoodH filter on 15m
  { name: 'RGGG/GRGG + GoodH + BB(15,2.2) ETH/15m', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // ExtH on 15m
  { name: 'RGGG/GRGG + ExtH + BB(15,2.2) ETH/15m', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: true, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  // BB(20,2.5) ETH/15m (previously tested, high WR)
  { name: 'RGGG/GRGG + BB(20,2.5) ETH/15m', symbol: 'ETH', timeframe: '15m', bbPeriod: 20, bbMult: 2.5, goodHoursOnly: false, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
];

for (const cfg of eth15mConfigs) {
  const r = runTest(cfg);
  const flag = r.wr >= 0.72 && r.trades >= 30 ? ' ⭐⭐⭐' : r.wr >= 0.68 && r.trades >= 25 ? ' ⭐⭐' : r.wr >= 0.64 && r.trades >= 20 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(52)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}${flag}`);
}

// ─── PART 3: BTC/15m — RGGG/GRGG + GoodH combos ─────────────────────────
console.log('\nPART 3: BTC/15m Pattern × BB combinations');
console.log('─────────────────────────────────────────────────');

const btc15mConfigs: TestConfig[] = [
  { name: 'RGGG/GRGG at BB(20,2) BTC/15m', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'RGGG/GRGG + GoodH + BB(20,2) BTC/15m', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'RGGG/GRGG + GoodH + BB(20,2.2) BTC/15m', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'RGGG/GRGG + ExtH + BB(20,2) BTC/15m', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: false, extHoursOnly: true, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'RGGG only + GoodH + BB(20,2) BTC/15m', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'GRGG only + GoodH + BB(20,2) BTC/15m', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, patterns: ['GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
];

for (const cfg of btc15mConfigs) {
  const r = runTest(cfg);
  const flag = r.wr >= 0.72 && r.trades >= 25 ? ' ⭐⭐⭐' : r.wr >= 0.68 && r.trades >= 20 ? ' ⭐⭐' : r.wr >= 0.64 && r.trades >= 15 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(52)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}${flag}`);
}

// ─── PART 4: Walk-Forward Validation of top combos ───────────────────────
console.log('\nPART 4: Walk-Forward Validation (3 folds) of top combos');
console.log('─────────────────────────────────────────────────');

const wfConfigs: TestConfig[] = [
  // The candidate combos to validate
  { name: 'ETH/5m RGGG/GRGG+GoodH+BB(20,2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m RGGG/GRGG+GoodH+BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m RGGG/GRGG+ExtH+BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: true, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m RGGG/GRGG+BB(15,2.2)', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m RGGG/GRGG+GoodH+BB(15,2.2)', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m RGGG/GRGG+GoodH+BB(20,2)', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m RGGG/GRGG+GoodH+BB(20,2.2)', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
];

for (const cfg of wfConfigs) {
  const wf = walkForward(cfg, 3);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.68 && wf.sigma <= 0.06 && wf.totalTrades >= 30 ? ' ⭐⭐⭐'
             : wf.wr >= 0.65 && wf.sigma <= 0.08 && wf.totalTrades >= 20 ? ' ⭐⭐'
             : wf.wr >= 0.62 && wf.totalTrades >= 15 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(46)} WR=${(wf.wr * 100).toFixed(1).padStart(5)}% σ=${(wf.sigma * 100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

// ─── PART 5: 5-fold walk-forward of absolute best from above ─────────────
console.log('\nPART 5: 5-fold Walk-Forward of absolute best combos');
console.log('─────────────────────────────────────────────────');

const best5Fold: TestConfig[] = [
  { name: 'ETH/5m RGGG/GRGG+GoodH+BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/5m RGGG only+GoodH+BB(20,2.2)', symbol: 'ETH', timeframe: '5m', bbPeriod: 20, bbMult: 2.2, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'ETH/15m RGGG/GRGG+BB(15,2.2)', symbol: 'ETH', timeframe: '15m', bbPeriod: 15, bbMult: 2.2, goodHoursOnly: false, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
  { name: 'BTC/15m RGGG/GRGG+GoodH+BB(20,2)', symbol: 'BTC', timeframe: '15m', bbPeriod: 20, bbMult: 2.0, goodHoursOnly: true, extHoursOnly: false, patterns: ['RGGG', 'GRGG'], requireStreak: 0, devMin: 0, devMax: 1 },
];

for (const cfg of best5Fold) {
  const wf = walkForward(cfg, 5);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.68 && wf.sigma <= 0.06 ? ' ⭐⭐⭐'
             : wf.wr >= 0.65 && wf.sigma <= 0.08 ? ' ⭐⭐'
             : wf.wr >= 0.62 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(46)} WR=${(wf.wr * 100).toFixed(1).padStart(5)}% σ=${(wf.sigma * 100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ GOOD HOURS + RGGG RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
