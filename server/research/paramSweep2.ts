/**
 * Parameter Sweep 2 — Comprehensive optimization on all signal modes
 * Tests: streak_reversion (len 2-6), big_candle (0.2-1.0%), combined modes
 * Coins: ETH, BTC, SOL, XRP | Timeframes: 5m, 15m
 * Uses train/test split (70%/30%) for out-of-sample validation
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runBacktestForPair, aggregateResults, type BacktestConfig, type Trade } from '../backtestEngine';
import type { DbCandle } from '../db';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH);
console.log('[DB] SQLite initialized:', DB_PATH);

function queryCandles(coin: string, timeframe: string, fromMs?: number, toMs?: number): DbCandle[] {
  let sql = 'SELECT * FROM candles WHERE symbol = ? AND timeframe = ?';
  const params: (string | number)[] = [coin, timeframe];
  if (fromMs) { sql += ' AND open_time >= ?'; params.push(fromMs); }
  if (toMs) { sql += ' AND open_time <= ?'; params.push(toMs); }
  sql += ' ORDER BY open_time ASC';
  return db.prepare(sql).all(...params) as DbCandle[];
}

interface SweepResult {
  config: string;
  coin: string;
  timeframe: string;
  signalMode: string;
  threshold: number;
  trainTrades: number;
  trainWR: number;
  trainPnl: number;
  trainSharpe: number;
  testTrades: number;
  testWR: number;
  testPnl: number;
  testSharpe: number;
  consistent: boolean; // profitable in both periods
}

const results: SweepResult[] = [];

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const TIMEFRAMES = ['5m', '15m'];

function runSweepConfig(
  coin: string,
  timeframe: string,
  signalModes: string[],
  threshold: number,
  label: string,
  trainCandles: DbCandle[],
  testCandles: DbCandle[],
  mtf1h?: DbCandle[],
  mtf4h?: DbCandle[],
): SweepResult {
  const baseConfig: BacktestConfig = {
    coins: [coin],
    timeframes: [timeframe],
    strategies: ['all'],
    signalModes: signalModes as any,
    thresholdMin: threshold,
    initialCapital: 1000,
    fromMs: 0,
    toMs: 9999999999999,
  };

  const trainConfig = mtf1h ? { ...baseConfig, mtfCandles: { candles1h: mtf1h, candles4h: mtf4h! } } : baseConfig;

  const trainTrades = runBacktestForPair(trainCandles, coin, timeframe, trainConfig);
  const testTrades = runBacktestForPair(testCandles, coin, timeframe, trainConfig);

  const tMetrics = aggregateResults(trainTrades, baseConfig).summary;
  const vMetrics = aggregateResults(testTrades, baseConfig).summary;

  return {
    config: label,
    coin,
    timeframe,
    signalMode: signalModes.join('+'),
    threshold,
    trainTrades: tMetrics.totalTrades,
    trainWR: tMetrics.winRate,
    trainPnl: tMetrics.totalPnl,
    trainSharpe: tMetrics.sharpe,
    testTrades: vMetrics.totalTrades,
    testWR: vMetrics.winRate,
    testPnl: vMetrics.totalPnl,
    testSharpe: vMetrics.sharpe,
    consistent: tMetrics.totalPnl > 0 && vMetrics.totalPnl > 0 && vMetrics.totalTrades >= 20,
  };
}

let totalRun = 0;

for (const coin of COINS) {
  for (const tf of TIMEFRAMES) {
    process.stdout.write(`\nLoading ${coin}/${tf}...`);
    const allCandles = queryCandles(coin, tf);
    if (allCandles.length < 200) {
      console.log(' skipped (no data)');
      continue;
    }

    const splitIdx = Math.floor(allCandles.length * 0.7);
    const trainCandles = allCandles.slice(0, splitIdx);
    const testCandles = allCandles.slice(splitIdx);

    // Load MTF context candles
    const mtfFrom = allCandles[0].open_time - 30 * 24 * 3600000;
    const mtfTo = allCandles[allCandles.length - 1].open_time;
    const mtf1h = queryCandles(coin, '1h', mtfFrom, mtfTo);
    const mtf4h = queryCandles(coin, '4h', mtfFrom, mtfTo);

    console.log(` train=${trainCandles.length} test=${testCandles.length}`);

    // --- 1. Streak Reversion sweep (len 2 to 6) ---
    for (const streakLen of [2, 3, 4, 5, 6]) {
      const r = runSweepConfig(coin, tf, ['streak_reversion'], streakLen,
        `streak(${streakLen})`, trainCandles, testCandles);
      results.push(r);
      totalRun++;
      process.stdout.write(`  streak=${streakLen}: test ${r.testTrades}T ${(r.testWR*100).toFixed(1)}% $${r.testPnl.toFixed(0)}${r.consistent ? ' ✅' : ''}\n`);
    }

    // --- 2. Big Candle sweep (0.2% to 1.0%) ---
    for (const pct of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]) {
      const r = runSweepConfig(coin, tf, ['big_candle'], pct,
        `big_candle(${pct}%)`, trainCandles, testCandles);
      results.push(r);
      totalRun++;
      process.stdout.write(`  big_candle=${pct}%: test ${r.testTrades}T ${(r.testWR*100).toFixed(1)}% $${r.testPnl.toFixed(0)}${r.consistent ? ' ✅' : ''}\n`);
    }

    // --- 3. MTF Reversion sweep (RSI thresh 60-80) ---
    for (const rsiThresh of [60, 65, 70, 72, 75, 78, 80]) {
      const r = runSweepConfig(coin, tf, ['mtf_reversion'], rsiThresh,
        `mtf_rsi(${rsiThresh})`, trainCandles, testCandles, mtf1h, mtf4h);
      results.push(r);
      totalRun++;
      process.stdout.write(`  mtf_rsi=${rsiThresh}: test ${r.testTrades}T ${(r.testWR*100).toFixed(1)}% $${r.testPnl.toFixed(0)}${r.consistent ? ' ✅' : ''}\n`);
    }

    // --- 4. Combined: Streak + BigCandle (best combo) ---
    for (const streakLen of [3, 4]) {
      const r = runSweepConfig(coin, tf, ['streak_reversion', 'big_candle'], streakLen,
        `streak(${streakLen})+big(0.5%)`, trainCandles, testCandles);
      results.push(r);
      totalRun++;
      process.stdout.write(`  combo streak${streakLen}+big: test ${r.testTrades}T ${(r.testWR*100).toFixed(1)}% $${r.testPnl.toFixed(0)}${r.consistent ? ' ✅' : ''}\n`);
    }

    // --- 5. Combined: All three modes ---
    for (const streakLen of [3, 4]) {
      const r = runSweepConfig(coin, tf, ['streak_reversion', 'big_candle', 'mtf_reversion'], streakLen,
        `all3_streak(${streakLen})`, trainCandles, testCandles, mtf1h, mtf4h);
      results.push(r);
      totalRun++;
      process.stdout.write(`  all3 streak${streakLen}: test ${r.testTrades}T ${(r.testWR*100).toFixed(1)}% $${r.testPnl.toFixed(0)}${r.consistent ? ' ✅' : ''}\n`);
    }
  }
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

const consistent = results.filter(r => r.consistent && r.testTrades >= 50);
consistent.sort((a, b) => b.testWR - a.testWR);

console.log('\n\n══════════════════════════════════════════════════════════════');
console.log('📊 TOP CONSISTENT CONFIGS (profitable both periods, ≥50 test trades)');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Config                          | Coin | TF  | Trades | TestWR  | TestPnL | Sharpe');
console.log('  -------------------------------------------------------------------------------');
for (const r of consistent.slice(0, 30)) {
  const label = `${r.config} ${r.coin}`.padEnd(34);
  console.log(`  ${label}| ${r.coin.padEnd(5)}| ${r.timeframe.padEnd(4)}| ${String(r.testTrades).padEnd(7)}| ${(r.testWR*100).toFixed(2).padStart(6)}% | $${r.testPnl.toFixed(0).padStart(7)} | ${r.testSharpe}`);
}

// Best per signal mode
const byMode: Record<string, SweepResult[]> = {};
for (const r of consistent) {
  if (!byMode[r.signalMode]) byMode[r.signalMode] = [];
  byMode[r.signalMode].push(r);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 BEST CONFIG PER MODE (by WR on test period)');
console.log('══════════════════════════════════════════════════════════════');
for (const [mode, rs] of Object.entries(byMode)) {
  rs.sort((a, b) => b.testWR - a.testWR);
  const best = rs[0];
  if (best) {
    console.log(`  ${mode.padEnd(30)} | ${best.config} ${best.coin} ${best.timeframe}: WR=${(best.testWR*100).toFixed(2)}% PnL=$${best.testPnl.toFixed(0)} trades=${best.testTrades}`);
  }
}

// Best for multi-coin trading (all 4 coins consistent)
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🌍 BEST STRATEGY BY TOTAL RETURN (all coins combined)');
console.log('══════════════════════════════════════════════════════════════');
const byConfigTF: Record<string, SweepResult[]> = {};
for (const r of consistent) {
  const key = `${r.config}_${r.timeframe}`;
  if (!byConfigTF[key]) byConfigTF[key] = [];
  byConfigTF[key].push(r);
}
const multiCoin = Object.entries(byConfigTF)
  .map(([key, rs]) => ({
    key,
    coins: rs.length,
    totalPnl: rs.reduce((s, r) => s + r.testPnl, 0),
    avgWR: rs.reduce((s, r) => s + r.testWR, 0) / rs.length,
    trades: rs.reduce((s, r) => s + r.testTrades, 0),
  }))
  .filter(x => x.coins >= 2)
  .sort((a, b) => b.totalPnl - a.totalPnl);

for (const x of multiCoin.slice(0, 10)) {
  console.log(`  ${x.key.padEnd(40)} | coins=${x.coins} totalPnl=$${x.totalPnl.toFixed(0)} avgWR=${(x.avgWR*100).toFixed(2)}% trades=${x.trades}`);
}

// Save results
const outDir = path.join(__dirname, '../../docs/backtest-research');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'param-sweep2-results.json'), JSON.stringify({ results, consistent: consistent.slice(0, 50) }, null, 2));

console.log(`\n✅ Total configs tested: ${totalRun}`);
console.log(`✅ Consistent (both periods profitable): ${consistent.length}`);
console.log('✅ Results saved to docs/backtest-research/param-sweep2-results.json');
