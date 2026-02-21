/**
 * Timeframe Sweep — Test all available timeframes for mean reversion strength
 * Tests: 5m, 15m, 30m, 1h (skipping 1m - too noisy, skipping 4h - too few trades)
 * Also tests BTC→ETH lead-lag: does BTC streak predict ETH's next candle?
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
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

const BET = 10;

function simStreak(candles: DbCandle[], streakLen: number): { trades: number; wr: number; pnl: number } {
  let wins = 0, total = 0;
  for (let i = streakLen + 1; i < candles.length - 1; i++) {
    let green = 0, red = 0;
    for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
      const c = candles[j];
      if (c.close > c.open) { if (red > 0) break; green++; }
      else if (c.close < c.open) { if (green > 0) break; red++; }
      else break;
    }
    if (green < streakLen && red < streakLen) continue;
    const dir = green >= streakLen ? false : true; // false=BEAR, true=BULL
    const nextUp = candles[i + 1].close > candles[i + 1].open;
    const win = dir === nextUp;
    if (win) wins++;
    total++;
  }
  const wr = total ? wins / total : 0;
  return { trades: total, wr, pnl: wins * BET - (total - wins) * BET };
}

function simBigCandle(candles: DbCandle[], pct: number): { trades: number; wr: number; pnl: number } {
  let wins = 0, total = 0;
  for (let i = 1; i < candles.length - 1; i++) {
    const c = candles[i];
    const change = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
    if (Math.abs(change) < pct) continue;
    const dir = change > 0 ? false : true; // BEAR if green, BULL if red
    const nextUp = candles[i + 1].close > candles[i + 1].open;
    const win = dir === nextUp;
    if (win) wins++;
    total++;
  }
  const wr = total ? wins / total : 0;
  return { trades: total, wr, pnl: wins * BET - (total - wins) * BET };
}

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const TIMEFRAMES = ['5m', '15m', '30m', '1h'];

interface TFResult {
  coin: string;
  tf: string;
  streakBest: { len: number; wr: number; trades: number; pnl: number };
  bigBest: { pct: number; wr: number; trades: number; pnl: number };
  totalCandles: number;
  testCandles: number;
}

const tfResults: TFResult[] = [];

console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 TIMEFRAME SWEEP — All coins × All timeframes');
console.log('══════════════════════════════════════════════════════════════');

for (const coin of COINS) {
  for (const tf of TIMEFRAMES) {
    const allC = queryCandles(coin, tf);
    if (allC.length < 100) continue;
    const splitIdx = Math.floor(allC.length * 0.7);
    const test = allC.slice(splitIdx);

    let bestStreak = { len: 3, wr: 0, trades: 0, pnl: 0 };
    for (const len of [2, 3, 4, 5, 6]) {
      const r = simStreak(test, len);
      if (r.trades >= 20 && r.wr > bestStreak.wr) bestStreak = { len, ...r };
    }

    let bestBig = { pct: 0.5, wr: 0, trades: 0, pnl: 0 };
    for (const pct of [0.3, 0.5, 0.7, 1.0, 1.5, 2.0]) {
      const r = simBigCandle(test, pct);
      if (r.trades >= 20 && r.wr > bestBig.wr) bestBig = { pct, ...r };
    }

    tfResults.push({ coin, tf, streakBest: bestStreak, bigBest: bestBig, totalCandles: allC.length, testCandles: test.length });

    const sWR = (bestStreak.wr * 100).toFixed(1);
    const bWR = (bestBig.wr * 100).toFixed(1);
    console.log(`  ${coin}/${tf.padEnd(4)} candles=${allC.length.toString().padStart(6)}: streak(${bestStreak.len})=${sWR}%(${bestStreak.trades}T) | big(${bestBig.pct}%)=${bWR}%(${bestBig.trades}T)`);
  }
}

// Sort by best overall WR
tfResults.sort((a, b) => Math.max(b.streakBest.wr, b.bigBest.wr) - Math.max(a.streakBest.wr, a.bigBest.wr));
console.log('\n🏆 TOP 10 CONFIGS BY WIN RATE (≥50 trades):');
let shown = 0;
for (const r of tfResults) {
  if (shown >= 10) break;
  const best = r.streakBest.wr >= r.bigBest.wr ? r.streakBest : r.bigBest;
  const type = r.streakBest.wr >= r.bigBest.wr ? `streak(${r.streakBest.len})` : `big(${r.bigBest.pct}%)`;
  if (best.trades < 50) continue;
  console.log(`  ${r.coin}/${r.tf} ${type}: WR=${(best.wr * 100).toFixed(2)}% trades=${best.trades} pnl=$${best.pnl.toFixed(0)}`);
  shown++;
}

// ─── BTC → ETH Lead-Lag Analysis ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔗 BTC → ETH LEAD-LAG ANALYSIS');
console.log('══════════════════════════════════════════════════════════════');
console.log('  Does BTC streak/big-candle predict ETH\'s NEXT candle?\n');

for (const tf of ['5m', '15m', '30m']) {
  const btcC = queryCandles('BTC', tf);
  const ethC = queryCandles('ETH', tf);
  if (btcC.length < 100 || ethC.length < 100) continue;

  const splitMs = btcC[Math.floor(btcC.length * 0.7)].open_time;
  const btcTest = btcC.filter(c => c.open_time >= splitMs);
  const ethTest = ethC.filter(c => c.open_time >= splitMs);

  // Build ETH lookup by time
  const ethByTime = new Map(ethTest.map(c => [c.open_time, c]));

  // Test: BTC streak(3) → predict ETH next candle
  const results: Record<string, { wins: number; total: number }> = {
    btcStreak3_eth: { wins: 0, total: 0 },
    btcBig0p5_eth: { wins: 0, total: 0 },
    btcStreak3_btc: { wins: 0, total: 0 }, // baseline: predicting BTC itself
  };

  const tfMs = tf === '5m' ? 300000 : tf === '15m' ? 900000 : 1800000;

  for (let i = 4; i < btcTest.length - 1; i++) {
    const t = btcTest[i].open_time;

    // BTC streak signal
    let greenStreak = 0, redStreak = 0;
    for (let j = i; j >= Math.max(0, i - 5); j--) {
      const cj = btcTest[j];
      if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
      else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
      else break;
    }

    // ETH at same time
    const ethCurr = ethByTime.get(t);
    const ethNext = ethByTime.get(t + tfMs);
    const btcNext = btcTest[i + 1];

    if (greenStreak >= 3 || redStreak >= 3) {
      const dir = greenStreak >= 3; // true=green→expect BEAR (false=up), red→expect BULL (true=up)
      const btcDir = !dir; // BEAR after green (expect down btc)

      // Predict BTC (baseline)
      if (btcNext) {
        const btcActualUp = btcNext.close > btcNext.open;
        results.btcStreak3_btc.total++;
        if (btcDir === btcActualUp) results.btcStreak3_btc.wins++;
      }

      // Predict ETH using BTC signal
      if (ethNext) {
        const ethActualUp = ethNext.close > ethNext.open;
        results.btcStreak3_eth.total++;
        if (btcDir === ethActualUp) results.btcStreak3_eth.wins++;
      }
    }

    // BTC big candle signal
    const btcC2 = btcTest[i];
    const btcChange = btcC2.open > 0 ? ((btcC2.close - btcC2.open) / btcC2.open) * 100 : 0;
    if (Math.abs(btcChange) >= 0.5) {
      const btcDir = btcChange < 0; // BULL after red
      if (ethNext) {
        const ethActualUp = ethNext.close > ethNext.open;
        results.btcBig0p5_eth.total++;
        if (btcDir === ethActualUp) results.btcBig0p5_eth.wins++;
      }
    }
  }

  console.log(`  ${tf}:`);
  for (const [key, r] of Object.entries(results)) {
    if (r.total < 20) continue;
    const wr = (r.wins / r.total * 100).toFixed(1);
    const baseline = key === 'btcStreak3_btc' ? ' (direct BTC prediction, baseline)' : ' (cross-asset ETH prediction)';
    console.log(`    ${key.padEnd(20)}: ${r.total}T ${wr}%${baseline}`);
  }
}

// ─── RSI Cross-Asset: ETH RSI predicts BTC? ───────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔗 CROSS-ASSET RSI: Does ETH RSI predict BTC direction?');
console.log('══════════════════════════════════════════════════════════════');

function calcRSI(candles: DbCandle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  const closes = candles.slice(-period - 1).map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

for (const tf of ['5m', '15m']) {
  const ethC = queryCandles('ETH', tf);
  const btcC = queryCandles('BTC', tf);
  const solC = queryCandles('SOL', tf);
  if (ethC.length < 200 || btcC.length < 200) continue;

  const splitMs = ethC[Math.floor(ethC.length * 0.7)].open_time;
  const ethTest = ethC.filter(c => c.open_time >= splitMs);
  const btcTest = btcC.filter(c => c.open_time >= splitMs);
  const solTest = solC.filter(c => c.open_time >= splitMs);

  const tfMs = tf === '5m' ? 300000 : 900000;
  const ethByTime = new Map(ethTest.map(c => [c.open_time, c]));
  const solByTime = new Map(solTest.map(c => [c.open_time, c]));

  // ETH RSI>70 → BTC next candle BEAR?
  const results: Record<string, { wins: number; total: number }> = {
    ethRsiOB_btcBear: { wins: 0, total: 0 },
    ethRsiOS_btcBull: { wins: 0, total: 0 },
    solStreak3_eth: { wins: 0, total: 0 },
    btcStreak_sol: { wins: 0, total: 0 },
  };

  for (let i = 20; i < btcTest.length - 1; i++) {
    const t = btcTest[i].open_time;
    const ethCurr = ethByTime.get(t);
    const solCurr = solByTime.get(t);
    const btcNext = btcTest[i + 1];
    const ethNext = ethByTime.get(t + tfMs);
    const solNext = solByTime.get(t + tfMs);

    // ETH RSI overbought → BTC reversal
    if (ethCurr) {
      const ethSlice = ethTest.filter(c => c.open_time <= t).slice(-16);
      const rsi = calcRSI(ethSlice);
      const btcUp = btcNext.close > btcNext.open;
      if (rsi >= 70) {
        results.ethRsiOB_btcBear.total++;
        if (!btcUp) results.ethRsiOB_btcBear.wins++; // expect BEAR
      }
      if (rsi <= 30) {
        results.ethRsiOS_btcBull.total++;
        if (btcUp) results.ethRsiOS_btcBull.wins++; // expect BULL
      }
    }

    // SOL streak → ETH prediction
    if (solCurr && ethNext) {
      let g = 0, r = 0;
      const solPast = solTest.filter(c => c.open_time <= t).slice(-6);
      for (const c of [...solPast].reverse()) {
        if (c.close > c.open) { if (r > 0) break; g++; }
        else if (c.close < c.open) { if (g > 0) break; r++; }
        else break;
      }
      const ethActualUp = ethNext.close > ethNext.open;
      if (g >= 3) {
        results.solStreak3_eth.total++;
        if (!ethActualUp) results.solStreak3_eth.wins++; // expect ETH BEAR after SOL green streak
      } else if (r >= 3) {
        results.solStreak3_eth.total++;
        if (ethActualUp) results.solStreak3_eth.wins++; // expect ETH BULL after SOL red streak
      }
    }

    // BTC streak → SOL prediction
    if (solNext) {
      let g = 0, r = 0;
      const btcPast = btcTest.slice(Math.max(0, i - 5), i + 1);
      for (const c of [...btcPast].reverse()) {
        if (c.close > c.open) { if (r > 0) break; g++; }
        else if (c.close < c.open) { if (g > 0) break; r++; }
        else break;
      }
      const solActualUp = solNext.close > solNext.open;
      if (g >= 3) {
        results.btcStreak_sol.total++;
        if (!solActualUp) results.btcStreak_sol.wins++;
      } else if (r >= 3) {
        results.btcStreak_sol.total++;
        if (solActualUp) results.btcStreak_sol.wins++;
      }
    }
  }

  console.log(`  ${tf}:`);
  for (const [key, r] of Object.entries(results)) {
    if (r.total < 30) continue;
    const wr = (r.wins / r.total * 100).toFixed(2);
    console.log(`    ${key.padEnd(25)}: ${r.total}T ${wr}%`);
  }
}

// ─── Time-of-Day Analysis ─────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('⏰ TIME-OF-DAY: When is mean reversion STRONGEST?');
console.log('══════════════════════════════════════════════════════════════');

const eth15m = queryCandles('ETH', '15m');
const splitMs15m = eth15m[Math.floor(eth15m.length * 0.7)].open_time;
const test15m = eth15m.filter(c => c.open_time >= splitMs15m);

// Group by hour of day (UTC)
const byHour: Record<number, { wins: number; total: number }> = {};
for (let h = 0; h < 24; h++) byHour[h] = { wins: 0, total: 0 };

for (let i = 4; i < test15m.length - 1; i++) {
  const c = test15m[i];
  let g = 0, r = 0;
  for (let j = i; j >= Math.max(0, i - 5); j--) {
    const cj = test15m[j];
    if (cj.close > cj.open) { if (r > 0) break; g++; }
    else if (cj.close < cj.open) { if (g > 0) break; r++; }
    else break;
  }
  if (g < 3 && r < 3) continue;
  const dir = g >= 3; // true=green streak → expect BEAR
  const nextUp = test15m[i + 1].close > test15m[i + 1].open;
  const win = dir !== nextUp; // BEAR = expect !up
  const hour = new Date(c.open_time).getUTCHours();
  byHour[hour].total++;
  if (win) byHour[hour].wins++;
}

const hourResults = Object.entries(byHour)
  .filter(([, r]) => r.total >= 15)
  .map(([h, r]) => ({ hour: parseInt(h), wr: r.wins / r.total, total: r.total }))
  .sort((a, b) => b.wr - a.wr);

console.log('\n  ETH/15m streak(3) WR by hour (UTC):');
console.log('  Hours sorted by win rate:');
for (const r of hourResults.slice(0, 8)) {
  const label = r.hour < 12 ? `${r.hour.toString().padStart(2,'0')}:00 AM` : `${(r.hour-12||12).toString().padStart(2,'0')}:00 PM`;
  const bar = '█'.repeat(Math.round(r.wr * 20));
  console.log(`    ${label} UTC: ${(r.wr*100).toFixed(1)}% (${r.total}T) ${bar}`);
}

console.log('\n  Worst hours:');
for (const r of hourResults.slice(-5)) {
  const label = r.hour < 12 ? `${r.hour.toString().padStart(2,'0')}:00 AM` : `${(r.hour-12||12).toString().padStart(2,'0')}:00 PM`;
  console.log(`    ${label} UTC: ${(r.wr*100).toFixed(1)}% (${r.total}T)`);
}

// Best trading sessions
const sessions: Record<string, number[]> = {
  'Asian (00-08)': Array.from({length: 8}, (_, i) => i),
  'European (08-16)': Array.from({length: 8}, (_, i) => i+8),
  'US (13-21)': Array.from({length: 8}, (_, i) => i+13),
  'US Power (14-17)': [14, 15, 16, 17],
};
console.log('\n  By trading session:');
for (const [session, hours] of Object.entries(sessions)) {
  const relevant = hourResults.filter(r => hours.includes(r.hour));
  if (relevant.length === 0) continue;
  const totalT = relevant.reduce((s, r) => s + r.total, 0);
  const totalW = relevant.reduce((s, r) => s + Math.round(r.wr * r.total), 0);
  const wr = totalT > 0 ? (totalW / totalT * 100).toFixed(1) : '0';
  console.log(`    ${session.padEnd(20)}: ${wr}% (${totalT}T)`);
}

// Save results
const outPath = path.join(__dirname, '../../docs/backtest-research/timeframe-sweep.json');
fs.writeFileSync(outPath, JSON.stringify({ tfResults, hourResults, timestamp: Date.now() }, null, 2));
console.log('\n✅ Results saved to docs/backtest-research/timeframe-sweep.json');
