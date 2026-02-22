/**
 * crossCoinConfirm.ts
 *
 * Research: BTC/15m as leading indicator / confirmation for ETH/5m trades
 *
 * Inspired by Polymarket research: "Smart money detection" — large traders in
 * correlated markets often signal before smaller markets catch up. Also:
 * "Cross-platform correlation" — logically correlated assets must be consistent.
 *
 * Hypothesis 1 — BTC Regime Filter:
 *   When BTC/15m is ALSO at BB extreme AND shows streak ≥ 2 at the SAME time as
 *   ETH/5m, the ETH signal is stronger (dual confirmation = higher WR).
 *
 * Hypothesis 2 — BTC Lead (delayed):
 *   When BTC/15m had a GGG streak 1-3 candles ago AND is now at BB upper,
 *   ETH/5m next candle is more bearish than without this signal.
 *
 * Hypothesis 3 — Cross-coin divergence:
 *   When BTC/15m is GREEN (trending up) AND ETH/5m is at BB UPPER with our signal,
 *   the divergence (ETH overbought vs BTC trend) = stronger reversion.
 *
 * NOTE: Multi-TF on SAME coin fails (49%). Cross-COIN might differ because
 *       BTC and ETH have genuine lead-lag relationships due to market dynamics.
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

type CandleDir = 'G' | 'R';
function getDir(c: RawCandle): CandleDir {
  return c.close >= c.open ? 'G' : 'R';
}

function getStreak(candles: RawCandle[], end: number): number {
  const dir = getDir(candles[end]);
  let streak = 1;
  for (let i = end - 1; i >= Math.max(0, end - 6); i--) {
    if (getDir(candles[i]) === dir) streak++;
    else break;
  }
  return streak;
}

const goodHours = [10, 11, 12, 21];

// Load all candles once
const ethCandles5m = db.prepare(
  'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
).all('ETH', '5m') as RawCandle[];

const btcCandles15m = db.prepare(
  'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
).all('BTC', '15m') as RawCandle[];

console.log(`Loaded ETH/5m: ${ethCandles5m.length} candles, BTC/15m: ${btcCandles15m.length} candles`);

// Build fast BTC 15m lookup: open_time → index
const btcTimeToIdx = new Map<number, number>();
btcCandles15m.forEach((c, i) => btcTimeToIdx.set(c.open_time, i));

// For each ETH/5m candle, find the most recent closed BTC/15m candle
// A BTC/15m candle starting at T covers [T, T+900000). The ETH/5m candle
// at time T_eth belongs to the BTC/15m candle where btc_open <= T_eth < btc_open + 15min.
// We want the PREVIOUS completed BTC/15m candle (not the one currently forming).
function findBtcCandleForEth(ethOpenTime: number): number {
  // BTC 15m interval = 15 * 60 * 1000 = 900000ms
  const interval = 900_000;
  // The BTC 15m candle that was LAST COMPLETED before this ETH candle
  const btcSlotStart = Math.floor((ethOpenTime - 1) / interval) * interval;
  // Find the previous one (completed = not still forming)
  // Subtract one interval to get the last fully closed 15m candle
  const prevBtcStart = btcSlotStart - interval;
  return btcTimeToIdx.get(prevBtcStart) ?? -1;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════════');
console.log('CROSS-COIN BTC/15m → ETH/5m CONFIRMATION RESEARCH');
console.log('══════════════════════════════════════════════════════════════════\n');

interface CrossCoinConfig {
  name: string;
  // ETH/5m conditions
  ethBBPeriod: number;
  ethBBMult: number;
  ethGoodHours: boolean;
  ethMinStreak: number;
  // BTC/15m conditions
  btcRequireBBExtreme: boolean;  // BTC also outside BB?
  btcBBPeriod: number;
  btcBBMult: number;
  btcRequireStreak: number;     // BTC streak direction (matching ETH direction)
  btcRequireGreen: boolean;     // BTC must be green? (for ETH bearish = divergence)
  btcLagCandles: number;        // 0 = same time, 1 = use 1 candle ago BTC state
}

function runCrossTest(cfg: CrossCoinConfig): { wr: number; trades: number; baseline: number; baselineTrades: number } {
  if (ethCandles5m.length < 100 || btcCandles15m.length < 50) return { wr: 0, trades: 0, baseline: 0, baselineTrades: 0 };

  const wins: number[] = [];
  const baselineWins: number[] = []; // ETH-only baseline (no BTC filter)

  for (let i = Math.max(cfg.ethBBPeriod + 14, 30); i < ethCandles5m.length - 1; i++) {
    const c = ethCandles5m[i];
    const hour = new Date(c.open_time).getUTCHours();

    if (cfg.ethGoodHours && !goodHours.includes(hour)) continue;

    const ethBB = calcBB(ethCandles5m, i, cfg.ethBBPeriod, cfg.ethBBMult);
    if (!ethBB) continue;

    const price = c.close;
    const isBearSetup = price > ethBB.upper;
    const isBullSetup = price < ethBB.lower;
    if (!isBearSetup && !isBullSetup) continue;

    // ETH streak filter
    if (cfg.ethMinStreak > 0) {
      const streak = getStreak(ethCandles5m, i);
      if (streak < cfg.ethMinStreak) continue;
    }

    // ETH baseline: record result without BTC filter
    const nextEth = ethCandles5m[i + 1];
    const baselineCorrect = isBearSetup
      ? nextEth.close < nextEth.open
      : nextEth.close > nextEth.open;
    baselineWins.push(baselineCorrect ? 1 : 0);

    // ── Now apply BTC filter ──────────────────────────────────────────────

    // Find corresponding BTC/15m candle
    let btcIdx = findBtcCandleForEth(c.open_time);
    if (cfg.btcLagCandles > 0) btcIdx -= cfg.btcLagCandles;
    if (btcIdx < cfg.btcBBPeriod + 2 || btcIdx < 0) continue;
    if (btcIdx >= btcCandles15m.length) continue;

    const btcCandle = btcCandles15m[btcIdx];

    if (cfg.btcRequireBBExtreme) {
      const btcBB = calcBB(btcCandles15m, btcIdx, cfg.btcBBPeriod, cfg.btcBBMult);
      if (!btcBB) continue;

      const btcPrice = btcCandle.close;
      const btcBear = btcPrice > btcBB.upper;
      const btcBull = btcPrice < btcBB.lower;

      // BTC must be at same type of extreme as ETH
      if (isBearSetup && !btcBear) continue;
      if (isBullSetup && !btcBull) continue;
    }

    if (cfg.btcRequireStreak > 0) {
      const btcStreak = getStreak(btcCandles15m, btcIdx);
      const btcDir = getDir(btcCandle);
      const ethDir = getDir(c);
      // For bearish ETH: BTC must also show green streak (=same bullish exhaust)
      // For bullish ETH: BTC must also show red streak
      if (isBearSetup && btcDir !== 'G') continue;
      if (isBullSetup && btcDir !== 'R') continue;
      if (btcStreak < cfg.btcRequireStreak) continue;
    }

    if (cfg.btcRequireGreen) {
      // Divergence mode: BTC is green (bullish trend) but ETH is overbought → short ETH
      if (isBearSetup && getDir(btcCandle) !== 'G') continue;
      if (isBullSetup && getDir(btcCandle) !== 'R') continue;
    }

    const correct = isBearSetup
      ? nextEth.close < nextEth.open
      : nextEth.close > nextEth.open;
    wins.push(correct ? 1 : 0);
  }

  const trades = wins.length;
  const wr = trades > 0 ? wins.filter(w => w === 1).length / trades : 0;
  const baseline = baselineWins.length > 0 ? baselineWins.filter(w => w === 1).length / baselineWins.length : 0;
  return { wr, trades, baseline, baselineTrades: baselineWins.length };
}

function walkForwardCross(cfg: CrossCoinConfig, folds = 3): { wr: number; sigma: number; foldWRs: number[]; totalTrades: number } {
  if (ethCandles5m.length < 200 || btcCandles15m.length < 50) return { wr: 0, sigma: 99, foldWRs: [], totalTrades: 0 };

  const foldSize = Math.floor(ethCandles5m.length / folds);
  const foldWRs: number[] = [];
  let totalWins = 0;
  let totalTrades = 0;

  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = (f === folds - 1) ? ethCandles5m.length - 1 : (f + 1) * foldSize - 1;
    const wins: number[] = [];
    const minI = Math.max(start, Math.max(cfg.ethBBPeriod + 14, 30));

    for (let i = minI; i < end; i++) {
      const c = ethCandles5m[i];
      const hour = new Date(c.open_time).getUTCHours();

      if (cfg.ethGoodHours && !goodHours.includes(hour)) continue;

      const ethBB = calcBB(ethCandles5m, i, cfg.ethBBPeriod, cfg.ethBBMult);
      if (!ethBB) continue;

      const price = c.close;
      const isBearSetup = price > ethBB.upper;
      const isBullSetup = price < ethBB.lower;
      if (!isBearSetup && !isBullSetup) continue;

      if (cfg.ethMinStreak > 0) {
        const streak = getStreak(ethCandles5m, i);
        if (streak < cfg.ethMinStreak) continue;
      }

      let btcIdx = findBtcCandleForEth(c.open_time);
      if (cfg.btcLagCandles > 0) btcIdx -= cfg.btcLagCandles;
      if (btcIdx < cfg.btcBBPeriod + 2 || btcIdx < 0) continue;
      if (btcIdx >= btcCandles15m.length) continue;

      const btcCandle = btcCandles15m[btcIdx];

      if (cfg.btcRequireBBExtreme) {
        const btcBB = calcBB(btcCandles15m, btcIdx, cfg.btcBBPeriod, cfg.btcBBMult);
        if (!btcBB) continue;
        const btcPrice = btcCandle.close;
        if (isBearSetup && btcPrice <= btcBB.upper) continue;
        if (isBullSetup && btcPrice >= btcBB.lower) continue;
      }

      if (cfg.btcRequireStreak > 0) {
        const btcStreak = getStreak(btcCandles15m, btcIdx);
        const btcDir = getDir(btcCandle);
        if (isBearSetup && btcDir !== 'G') continue;
        if (isBullSetup && btcDir !== 'R') continue;
        if (btcStreak < cfg.btcRequireStreak) continue;
      }

      if (cfg.btcRequireGreen) {
        if (isBearSetup && getDir(btcCandle) !== 'G') continue;
        if (isBullSetup && getDir(btcCandle) !== 'R') continue;
      }

      const nextEth = ethCandles5m[i + 1];
      if (!nextEth) continue;
      const correct = isBearSetup
        ? nextEth.close < nextEth.open
        : nextEth.close > nextEth.open;
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

// ─── PART 1: Baseline (ETH/5m GoodH+BB+streak≥2) ────────────────────────────
console.log('PART 1: Baseline ETH/5m (no BTC filter) — reference point');
console.log('─────────────────────────────────────────────────────────────');

const baseline = runCrossTest({
  name: 'ETH/5m GoodH+BB(20,2.2)+streak≥2 [baseline]',
  ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2,
  btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 0,
  btcRequireGreen: false, btcLagCandles: 0,
});
console.log(`  Baseline: WR=${(baseline.baseline * 100).toFixed(1)}%  T=${baseline.baselineTrades}`);

// ─── PART 2: BTC/15m at BB extreme confirmation ──────────────────────────────
console.log('\nPART 2: ETH/5m + BTC/15m ALSO at BB extreme (dual BB)');
console.log('─────────────────────────────────────────────────────────────');

const dualBBConfigs: CrossCoinConfig[] = [
  // BTC also outside BB (any mult) + ETH GoodH+streak
  { name: 'Dual BB: ETH GoodH+s≥2+BB(20,2.2) + BTC BB(20,2.0)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 0, btcRequireGreen: false, btcLagCandles: 0 },
  { name: 'Dual BB: ETH GoodH+s≥2+BB(20,2.2) + BTC BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.2, btcRequireStreak: 0, btcRequireGreen: false, btcLagCandles: 0 },
  // No hour filter on ETH but BTC confirms
  { name: 'Dual BB: ETH no-hour+s≥2+BB(20,2.2) + BTC BB(20,2.0)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: false, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 0, btcRequireGreen: false, btcLagCandles: 0 },
  // BTC BB lagged by 1 candle (15m candle before)
  { name: 'Dual BB lag-1: ETH GoodH+s≥2 + BTC BB(20,2.0) prev', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 0, btcRequireGreen: false, btcLagCandles: 1 },
];

for (const cfg of dualBBConfigs) {
  const r = runCrossTest(cfg);
  const lift = r.trades > 0 ? (r.wr - r.baseline) * 100 : 0;
  const flag = r.wr >= 0.72 && r.trades >= 25 ? ' ⭐⭐⭐' : r.wr >= 0.68 && r.trades >= 20 ? ' ⭐⭐' : r.wr >= 0.65 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(58)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}  lift=${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%${flag}`);
}

// ─── PART 3: BTC streak confirmation ─────────────────────────────────────────
console.log('\nPART 3: ETH/5m GoodH+BB + BTC streak confirmation');
console.log('─────────────────────────────────────────────────────────────');

const btcStreakConfigs: CrossCoinConfig[] = [
  { name: 'BTC s≥2 same dir: ETH GoodH+s≥2+BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 2, btcRequireGreen: false, btcLagCandles: 0 },
  { name: 'BTC s≥3 same dir: ETH GoodH+s≥2+BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 3, btcRequireGreen: false, btcLagCandles: 0 },
  { name: 'BTC s≥2 + BTC BB: ETH GoodH+s≥2+BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 2, btcRequireGreen: false, btcLagCandles: 0 },
  { name: 'BTC s≥2: ETH no-hour+s≥2+BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: false, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 2, btcRequireGreen: false, btcLagCandles: 0 },
  // No ETH streak — just BTC confirms
  { name: 'BTC s≥3: ETH GoodH+s≥0+BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 0, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 3, btcRequireGreen: false, btcLagCandles: 0 },
];

for (const cfg of btcStreakConfigs) {
  const r = runCrossTest(cfg);
  const lift = r.trades > 0 ? (r.wr - r.baseline) * 100 : 0;
  const flag = r.wr >= 0.72 && r.trades >= 25 ? ' ⭐⭐⭐' : r.wr >= 0.68 && r.trades >= 20 ? ' ⭐⭐' : r.wr >= 0.65 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(58)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}  lift=${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%${flag}`);
}

// ─── PART 4: Divergence (BTC bullish but ETH overbought) ─────────────────────
console.log('\nPART 4: Divergence — BTC green streak + ETH bearish signal');
console.log('─────────────────────────────────────────────────────────────');
console.log('  (ETH overbought vs BTC trending up = "catch-up reversion")');

const divergenceConfigs: CrossCoinConfig[] = [
  { name: 'Diverge: ETH GoodH+s≥2+BB(20,2.2) + BTC green', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 0, btcRequireGreen: true, btcLagCandles: 0 },
  { name: 'Diverge: ETH GoodH+s≥2+BB(20,2.2) + BTC green s≥2', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 2, btcRequireGreen: true, btcLagCandles: 0 },
  { name: 'Diverge: ETH GoodH+s≥2+BB(20,2.2) + BTC green s≥3', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 3, btcRequireGreen: true, btcLagCandles: 0 },
  { name: 'Diverge no-hour: ETH s≥2+BB(20,2.2) + BTC green s≥2', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: false, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 2, btcRequireGreen: true, btcLagCandles: 0 },
];

for (const cfg of divergenceConfigs) {
  const r = runCrossTest(cfg);
  const lift = r.trades > 0 ? (r.wr - r.baseline) * 100 : 0;
  const flag = r.wr >= 0.72 && r.trades >= 25 ? ' ⭐⭐⭐' : r.wr >= 0.68 && r.trades >= 20 ? ' ⭐⭐' : r.wr >= 0.65 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(58)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}  lift=${lift >= 0 ? '+' : ''}${lift.toFixed(1)}%${flag}`);
}

// ─── PART 5: Walk-Forward Validation of top cross-coin configs ───────────────
console.log('\nPART 5: Walk-Forward (3-fold) of best cross-coin candidates');
console.log('─────────────────────────────────────────────────────────────');

const wfCrossConfigs: CrossCoinConfig[] = [
  { name: 'Dual BB: ETH GoodH+s≥2+BB(20,2.2) + BTC BB(20,2.0)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 0, btcRequireGreen: false, btcLagCandles: 0 },
  { name: 'Dual BB: ETH GoodH+s≥2+BB(20,2.2) + BTC BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.2, btcRequireStreak: 0, btcRequireGreen: false, btcLagCandles: 0 },
  { name: 'BTC s≥2 + BTC BB: ETH GoodH+s≥2+BB(20,2.2)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 2, btcRequireGreen: false, btcLagCandles: 0 },
  { name: 'Diverge: ETH GoodH+s≥2+BB(20,2.2) + BTC green s≥2', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 2, btcRequireGreen: true, btcLagCandles: 0 },
  { name: 'Diverge: ETH GoodH+s≥2+BB(20,2.2) + BTC green s≥3', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: true, ethMinStreak: 2, btcRequireBBExtreme: false, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 3, btcRequireGreen: true, btcLagCandles: 0 },
  // No-hour with strong BTC signal
  { name: 'Dual BB no-hour: ETH s≥2+BB(20,2.2) + BTC BB(20,2.0)', ethBBPeriod: 20, ethBBMult: 2.2, ethGoodHours: false, ethMinStreak: 2, btcRequireBBExtreme: true, btcBBPeriod: 20, btcBBMult: 2.0, btcRequireStreak: 0, btcRequireGreen: false, btcLagCandles: 0 },
];

for (const cfg of wfCrossConfigs) {
  const wf = walkForwardCross(cfg, 3);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.70 && wf.sigma <= 0.06 && wf.totalTrades >= 25 ? ' ⭐⭐⭐'
             : wf.wr >= 0.67 && wf.sigma <= 0.08 && wf.totalTrades >= 15 ? ' ⭐⭐'
             : wf.wr >= 0.63 && wf.totalTrades >= 10 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(58)} WR=${(wf.wr * 100).toFixed(1).padStart(5)}% σ=${(wf.sigma * 100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('✅ CROSS-COIN CONFIRMATION RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════════');
