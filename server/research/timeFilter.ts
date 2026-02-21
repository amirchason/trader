/**
 * Time-Filtered Strategy Test
 * Tests whether restricting trades to high-WR UTC hours significantly improves performance
 *
 * Key findings from timeframeSweep:
 * - 16:00 UTC: 72.1% WR (peak)
 * - 05:00 UTC: 69.4% WR
 * - Asian (00-08 UTC): 60.7% avg
 * - European (08-16 UTC): 54.4% avg (worst)
 * - 14:00 UTC: 44.4% WR (LOSES money!)
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DbCandle } from '../db';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH);

function queryCandles(coin: string, timeframe: string): DbCandle[] {
  return db.prepare(
    'SELECT * FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC'
  ).all(coin, timeframe) as DbCandle[];
}

const BET = 10;

function getHour(openTimeMs: number): number {
  return new Date(openTimeMs).getUTCHours();
}

interface FilterResult {
  label: string;
  trades: number;
  wins: number;
  wr: number;
  pnl: number;
}

function simWithFilter(
  candles: DbCandle[],
  streakLen: number,
  bigPct: number | null,
  allowedHours: number[] | null // null = all hours
): FilterResult {
  let wins = 0, total = 0;

  for (let i = streakLen + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const hour = getHour(c.open_time);

    // Time filter
    if (allowedHours && !allowedHours.includes(hour)) continue;

    // Streak signal
    let greenStreak = 0, redStreak = 0;
    for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
      const cj = candles[j];
      if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
      else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
      else break;
    }

    let tradeBear: boolean | null = null;

    if (greenStreak >= streakLen) tradeBear = true;   // BEAR
    else if (redStreak >= streakLen) tradeBear = false; // BULL

    // Big candle override / fallback
    if (bigPct !== null && tradeBear === null) {
      const change = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
      if (Math.abs(change) >= bigPct) {
        tradeBear = change > 0; // BEAR if green big candle
      }
    }

    if (tradeBear === null) continue;

    const nextUp = candles[i + 1].close > candles[i + 1].open;
    const win = tradeBear ? !nextUp : nextUp; // BEAR wins if next is red
    if (win) wins++;
    total++;
  }

  const wr = total ? wins / total : 0;
  return {
    label: allowedHours ? `hours=[${allowedHours.join(',')}]` : 'all_hours',
    trades: total, wins, wr,
    pnl: wins * BET - (total - wins) * BET
  };
}

// ─── Per-hour breakdown ───────────────────────────────────────────────────────
function hourlyBreakdown(candles: DbCandle[], streakLen: number): void {
  const byHour: Record<number, { wins: number; total: number }> = {};
  for (let h = 0; h < 24; h++) byHour[h] = { wins: 0, total: 0 };

  for (let i = streakLen + 1; i < candles.length - 1; i++) {
    const c = candles[i];
    let greenStreak = 0, redStreak = 0;
    for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
      const cj = candles[j];
      if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
      else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
      else break;
    }
    if (greenStreak < streakLen && redStreak < streakLen) continue;

    const tradeBear = greenStreak >= streakLen;
    const nextUp = candles[i + 1].close > candles[i + 1].open;
    const win = tradeBear ? !nextUp : nextUp;
    const hour = getHour(c.open_time);
    byHour[hour].total++;
    if (win) byHour[hour].wins++;
  }

  console.log('  Per-hour breakdown (hours with ≥10 trades):');
  const rows: Array<{ hour: number; wr: number; total: number; pnl: number }> = [];
  for (let h = 0; h < 24; h++) {
    const { wins: w, total: t } = byHour[h];
    if (t >= 10) rows.push({ hour: h, wr: w / t, total: t, pnl: w * BET - (t - w) * BET });
  }
  rows.sort((a, b) => b.wr - a.wr);
  for (const r of rows) {
    const bar = '█'.repeat(Math.round(r.wr * 20));
    const flag = r.wr >= 0.62 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
    console.log(`    ${r.hour.toString().padStart(2, '0')}:00 UTC  WR=${(r.wr * 100).toFixed(1)}%  T=${r.total.toString().padStart(4)}  PnL=$${r.pnl.toFixed(0).padStart(6)}  ${bar}${flag}`);
  }
}

// ─── Main test matrix ─────────────────────────────────────────────────────────
const COINS = ['ETH', 'BTC', 'SOL'];
const TF = '15m';

// Time filter windows to test
const WINDOWS: Array<{ label: string; hours: number[] }> = [
  { label: 'Asian (00-08)', hours: [0,1,2,3,4,5,6,7] },
  { label: 'US-Open (13-17)', hours: [13,14,15,16,17] },
  { label: 'Best-6 (0,1,2,3,16,17)', hours: [0,1,2,3,16,17] },
  { label: 'Top8h (0,1,2,4,5,16,17,22)', hours: [0,1,2,4,5,16,17,22] },
  { label: 'No-Euro (skip 08-15)', hours: [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23] },
  { label: 'All hours', hours: Array.from({length:24},(_,i)=>i) },
];

const allResults: Array<{
  coin: string;
  streakLen: number;
  windowLabel: string;
  result: FilterResult;
}> = [];

console.log('\n══════════════════════════════════════════════════════════════');
console.log('⏰ TIME-FILTERED STRATEGY TEST — 15m timeframe');
console.log('══════════════════════════════════════════════════════════════');
console.log('Strategy: Streak Reversion (bet against consecutive candles)');
console.log('Methodology: 70/30 train/test split — results are OUT-OF-SAMPLE\n');

for (const coin of COINS) {
  const allC = queryCandles(coin, TF);
  if (allC.length < 200) { console.log(`  ${coin}/${TF}: insufficient data`); continue; }

  const splitIdx = Math.floor(allC.length * 0.7);
  const test = allC.slice(splitIdx);

  console.log(`\n── ${coin}/${TF} (${test.length} test candles) ──────────────────────────`);

  // Per-hour breakdown first
  hourlyBreakdown(test, 3);

  console.log('');
  console.log('  Time-window comparison (streak=3):');
  for (const w of WINDOWS) {
    const r = simWithFilter(test, 3, null, w.hours.length === 24 ? null : w.hours);
    allResults.push({ coin, streakLen: 3, windowLabel: w.label, result: r });
    if (r.trades < 5) { console.log(`    ${w.label.padEnd(32)} — too few trades`); continue; }
    const improvement = r.wr - (allResults.find(x => x.coin === coin && x.windowLabel === 'All hours')?.result.wr ?? 0);
    const impStr = improvement > 0 ? `+${(improvement * 100).toFixed(1)}%` : `${(improvement * 100).toFixed(1)}%`;
    console.log(`    ${w.label.padEnd(32)} WR=${(r.wr * 100).toFixed(2)}%  T=${r.trades.toString().padStart(5)}  PnL=$${r.pnl.toFixed(0).padStart(7)}  Δ=${impStr}`);
  }
}

// ─── Combined: streak + big candle with best time filter ──────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 STREAK + BIG CANDLE COMBINED with time filter');
console.log('══════════════════════════════════════════════════════════════\n');

const BEST_WINDOW = [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23]; // No-Euro

const portfolioStats = { wins: 0, total: 0, pnl: 0 };

for (const coin of COINS) {
  const allC = queryCandles(coin, TF);
  if (allC.length < 200) continue;

  const splitIdx = Math.floor(allC.length * 0.7);
  const test = allC.slice(splitIdx);

  const rFiltered = simWithFilter(test, 3, 0.5, BEST_WINDOW);
  const rUnfiltered = simWithFilter(test, 3, 0.5, null);

  portfolioStats.wins += rFiltered.wins;
  portfolioStats.total += rFiltered.trades;
  portfolioStats.pnl += rFiltered.pnl;

  console.log(`  ${coin}/${TF}:`);
  console.log(`    No filter:   WR=${(rUnfiltered.wr * 100).toFixed(2)}%  T=${rUnfiltered.trades}  PnL=$${rUnfiltered.pnl.toFixed(0)}`);
  console.log(`    No-Euro:     WR=${(rFiltered.wr * 100).toFixed(2)}%  T=${rFiltered.trades}  PnL=$${rFiltered.pnl.toFixed(0)}`);
  const delta = (rFiltered.wr - rUnfiltered.wr) * 100;
  console.log(`    Δ WR:        ${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`);
}

const portWR = portfolioStats.total ? portfolioStats.wins / portfolioStats.total : 0;
console.log(`\n  Portfolio (ETH+BTC+SOL combined):`);
console.log(`    WR=${(portWR * 100).toFixed(2)}%  T=${portfolioStats.total}  PnL=$${portfolioStats.pnl.toFixed(0)}`);

// ─── Find the globally optimal time window ───────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔍 OPTIMAL TIME WINDOW SEARCH');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Testing all combinations of ≥3 hour blocks for ETH/15m...\n');

const ethC = queryCandles('ETH', '15m');
const ethSplit = Math.floor(ethC.length * 0.7);
const ethTest = ethC.slice(ethSplit);

// Score each individual hour first
const hourScores: Array<{ hour: number; wr: number; total: number }> = [];
for (let h = 0; h < 24; h++) {
  const r = simWithFilter(ethTest, 3, null, [h]);
  if (r.trades >= 8) hourScores.push({ hour: h, wr: r.wr, total: r.trades });
}
hourScores.sort((a, b) => b.wr - a.wr);

console.log('  Individual hour ranking (≥8 trades):');
for (const h of hourScores.slice(0, 12)) {
  const flag = h.wr >= 0.65 ? ' ⭐⭐' : h.wr >= 0.60 ? ' ⭐' : '';
  console.log(`    ${h.hour.toString().padStart(2,'0')}:00 UTC  WR=${(h.wr * 100).toFixed(1)}%  T=${h.total}${flag}`);
}

// Top hours: pick hours with WR >= 0.58
const topHours = hourScores.filter(h => h.wr >= 0.58).map(h => h.hour);
console.log(`\n  Hours with WR≥58%: [${topHours.join(', ')}]`);

if (topHours.length >= 3) {
  const rTop = simWithFilter(ethTest, 3, null, topHours);
  const rAll = simWithFilter(ethTest, 3, null, null);
  console.log(`  ETH/15m streak(3) using only WR≥58% hours:`);
  console.log(`    Filtered:   WR=${(rTop.wr * 100).toFixed(2)}%  T=${rTop.trades}  PnL=$${rTop.pnl.toFixed(0)}`);
  console.log(`    Unfiltered: WR=${(rAll.wr * 100).toFixed(2)}%  T=${rAll.trades}  PnL=$${rAll.pnl.toFixed(0)}`);
  console.log(`    Trade count reduction: ${(100 * (1 - rTop.trades / rAll.trades)).toFixed(1)}%`);
  console.log(`    WR improvement: +${((rTop.wr - rAll.wr) * 100).toFixed(2)}%`);
}

// Save results
const output = {
  timestamp: Date.now(),
  coin_results: COINS.map(coin => {
    const coinR = allResults.filter(r => r.coin === coin);
    return { coin, results: coinR.map(r => ({ window: r.windowLabel, ...r.result })) };
  }),
  top_hours_eth15m: hourScores.slice(0, 8),
  portfolio_no_euro: {
    wr: portWR,
    trades: portfolioStats.total,
    pnl: portfolioStats.pnl
  }
};
fs.writeFileSync(
  path.join(__dirname, '../../docs/backtest-research/time-filter.json'),
  JSON.stringify(output, null, 2)
);
console.log('\n✅ Results saved to docs/backtest-research/time-filter.json');
