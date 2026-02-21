/**
 * Best Hours + MFI Validation
 *
 * CRITICAL FINDING: ETH/5m GGG+BB+bodyATR in hours [10,11,12,21 UTC] = 79.2% WR
 * Need to validate this is NOT test-set overfitting.
 *
 * Validation approach:
 * 1. Walk-forward (5 folds) for the best4hours filter
 * 2. Test on coins/timeframes NOT used for hour identification
 * 3. Full sweep of all 24-hour combinations to see if [10,11,12,21] is real
 * 4. MFI walk-forward validation
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/bestHoursValidation.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import type { DbCandle } from '../db';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH);

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

// GGG+BB+bodyATR signal
function gggBBSignal(candles: DbCandle[], i: number): 'BULL' | 'BEAR' | null {
  const streak = getStreak(candles, i);
  const bb = getBB(candles, i);
  if (!bb) return null;
  if (streak >= 3 && candles[i].close > bb.upper) {
    const atr = calcATR(candles, i);
    if (atr > 0 && Math.abs(candles[i].close - candles[i].open) / atr < 0.9) return null;
    return 'BEAR';
  }
  if (streak <= -3 && candles[i].close < bb.lower) {
    const atr = calcATR(candles, i);
    if (atr > 0 && Math.abs(candles[i].close - candles[i].open) / atr < 0.9) return null;
    return 'BULL';
  }
  return null;
}

// Keltner+BB double confirm signal
function keltnerBBSignal(candles: DbCandle[], i: number): 'BULL' | 'BEAR' | null {
  if (i < 36) return null;
  const bb = getBB(candles, i);
  if (!bb) return null;
  const mult = 2 / 21;
  const slice = candles.slice(i - 20, i + 1);
  let ema = slice[0].close;
  for (let j = 1; j < slice.length; j++) ema = (slice[j].close - ema) * mult + ema;
  const atrVal = calcATR(candles, i);
  const price = candles[i].close;
  const streak = getStreak(candles, i);
  if (price > bb.upper && price > ema + 2 * atrVal && streak >= 3) return 'BEAR';
  if (price < bb.lower && price < ema - 2 * atrVal && streak <= -3) return 'BULL';
  return null;
}

// MFI + Streak + BB signal
function mfiBBSignal(candles: DbCandle[], i: number, mfiThreshold = 80): 'BULL' | 'BEAR' | null {
  const mfi = calcMFI(candles, i, 10);
  const streak = getStreak(candles, i);
  const bb = getBB(candles, i);
  if (!bb) return null;
  if (mfi > mfiThreshold && streak >= 2 && candles[i].close > bb.upper) return 'BEAR';
  if (mfi < (100 - mfiThreshold) && streak <= -2 && candles[i].close < bb.lower) return 'BULL';
  return null;
}

// ── Part 1: Walk-Forward Validation of Best4Hours Filter ─────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ PART 1: WALK-FORWARD VALIDATION OF BEST4HOURS FILTER');
console.log('══════════════════════════════════════════════════════════════');
console.log('Hours tested: [10, 11, 12, 21] UTC (from markovBBTimeFilter.ts research)');
console.log('Strategy: GGG+BB+bodyATR on ETH/5m');
console.log('Walk-forward: 5 non-overlapping folds on test data\n');

const BEST_HOURS = [10, 11, 12, 21];

{
  const allC = queryCandles('ETH', '5m');
  const n = allC.length;
  const testSize = Math.floor(n * 0.1); // 10% per fold
  const startTest = Math.floor(n * 0.7); // start at 70% mark

  console.log('Fold  | Hours (B4H) WR | Hours (B4H) T | All WR | All T | Improvement');
  console.log('------|----------------|---------------|--------|-------|------------');

  let totalWinsB4H = 0, totalTradesB4H = 0;
  let totalWinsAll = 0, totalTradesAll = 0;

  for (let fold = 0; fold < 5; fold++) {
    const foldStart = startTest + fold * testSize;
    const foldEnd = Math.min(foldStart + testSize, n - 1);

    let winsB4H = 0, tradesB4H = 0;
    let winsAll = 0, tradesAll = 0;

    for (let i = foldStart + 25; i < foldEnd; i++) {
      const dir = gggBBSignal(allC, i);
      if (!dir) continue;
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      tradesAll++; if (win) winsAll++;

      const hour = new Date(allC[i].open_time).getUTCHours();
      if (BEST_HOURS.includes(hour)) {
        tradesB4H++; if (win) winsB4H++;
      }
    }

    const wrB4H = tradesB4H ? winsB4H / tradesB4H : 0;
    const wrAll = tradesAll ? winsAll / tradesAll : 0;
    const flagB4H = wrB4H >= 0.70 ? '⭐⭐' : wrB4H >= 0.65 ? '⭐' : wrB4H < 0.50 ? '❌' : '';
    console.log(`Fold${fold + 1} | ${(wrB4H*100).toFixed(1).padStart(5)}% ${flagB4H.padEnd(5)} T=${tradesB4H.toString().padStart(3)} | ${(wrAll*100).toFixed(1).padStart(5)}% T=${tradesAll.toString().padStart(3)} | +${((wrB4H-wrAll)*100).toFixed(1)}%`);

    totalWinsB4H += winsB4H; totalTradesB4H += tradesB4H;
    totalWinsAll += winsAll; totalTradesAll += tradesAll;
  }

  const finalB4H = totalTradesB4H ? totalWinsB4H / totalTradesB4H : 0;
  const finalAll = totalTradesAll ? totalWinsAll / totalTradesAll : 0;
  console.log(`\nTotal | B4H: ${(finalB4H*100).toFixed(1)}% T=${totalTradesB4H} | All: ${(finalAll*100).toFixed(1)}% T=${totalTradesAll} | Improvement: +${((finalB4H-finalAll)*100).toFixed(1)}%`);
  const sigma = Math.sqrt(finalB4H * (1-finalB4H) / totalTradesB4H) * 100;
  console.log(`B4H 95% CI: ${((finalB4H-1.96*sigma/100)*100).toFixed(1)}% - ${((finalB4H+1.96*sigma/100)*100).toFixed(1)}%`);
}

// ── Part 2: Same Hours on BTC/5m (out-of-sample coin) ────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔍 PART 2: TRANSFER TEST — SAME HOURS ON BTC/5m AND SOL/5m');
console.log('══════════════════════════════════════════════════════════════');
console.log('If hours [10,11,12,21] work on different coins, the edge is real\n');

for (const { coin, tf } of [
  { coin: 'BTC', tf: '5m' }, { coin: 'SOL', tf: '5m' }, { coin: 'BTC', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  let winsB4H = 0, tradesB4H = 0;
  let winsAll = 0, tradesAll = 0;

  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const dir = gggBBSignal(allC, i);
    if (!dir) continue;
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    tradesAll++; if (win) winsAll++;
    const hour = new Date(allC[i].open_time).getUTCHours();
    if (BEST_HOURS.includes(hour)) { tradesB4H++; if (win) winsB4H++; }
  }

  const wrB4H = tradesB4H ? winsB4H / tradesB4H : 0;
  const wrAll = tradesAll ? winsAll / tradesAll : 0;
  const flag = wrB4H >= 0.70 ? ' ⭐⭐' : wrB4H >= 0.65 ? ' ⭐' : wrB4H < 0.50 ? ' ❌' : '';
  console.log(`${coin}/${tf}: B4H WR=${(wrB4H*100).toFixed(1)}% T=${tradesB4H}${flag} | All WR=${(wrAll*100).toFixed(1)}% T=${tradesAll} | +${((wrB4H-wrAll)*100).toFixed(1)}%`);
}

// ── Part 3: Hour Sweep — Find All Good Hours ──────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🕐 PART 3: FULL HOUR SWEEP — ETH/5m GGG+BB+bodyATR');
console.log('══════════════════════════════════════════════════════════════');
console.log('Which individual hours have edge > baseline?\n');

{
  const allC = queryCandles('ETH', '5m');
  const splitIdx = Math.floor(allC.length * 0.7);

  const hourStats: Array<{ hour: number; wins: number; total: number }> = [];
  for (let h = 0; h < 24; h++) {
    hourStats.push({ hour: h, wins: 0, total: 0 });
  }
  let totalWins = 0, total = 0;

  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const dir = gggBBSignal(allC, i);
    if (!dir) continue;
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    total++; if (win) totalWins++;
    const hour = new Date(allC[i].open_time).getUTCHours();
    hourStats[hour].total++;
    if (win) hourStats[hour].wins++;
  }

  const baseWR = total ? totalWins / total : 0;
  console.log(`Baseline: WR=${(baseWR*100).toFixed(1)}% T=${total}\n`);

  const validHours = hourStats.filter(h => h.total >= 5);
  validHours.sort((a, b) => (b.wins / b.total) - (a.wins / a.total));

  console.log('Best hours:');
  for (const h of validHours.slice(0, 8)) {
    const wr = h.wins / h.total;
    const pnl = h.wins * BET - (h.total - h.wins) * BET;
    const flag = wr >= 0.75 ? ' ⭐⭐' : wr >= 0.65 ? ' ⭐' : '';
    console.log(`  ${h.hour.toString().padStart(2)}:00 UTC  WR=${(wr*100).toFixed(1)}%  T=${h.total}  PnL=$${pnl}${flag}`);
  }
  console.log('Worst hours:');
  for (const h of validHours.slice(-5).reverse()) {
    const wr = h.wins / h.total;
    const pnl = h.wins * BET - (h.total - h.wins) * BET;
    const flag = wr < 0.40 ? ' ❌❌' : wr < 0.48 ? ' ❌' : '';
    console.log(`  ${h.hour.toString().padStart(2)}:00 UTC  WR=${(wr*100).toFixed(1)}%  T=${h.total}  PnL=$${pnl}${flag}`);
  }

  // Find optimal hour subset greedily
  const sortedHours = [...validHours].sort((a, b) => (b.wins / b.total) - (a.wins / a.total));
  let bestWR = baseWR, bestHours: number[] = [];
  for (let n = 1; n <= Math.min(12, sortedHours.length); n++) {
    const subset = sortedHours.slice(0, n);
    const subWins = subset.reduce((s, h) => s + h.wins, 0);
    const subTotal = subset.reduce((s, h) => s + h.total, 0);
    if (subTotal < 20) continue;
    const wr = subWins / subTotal;
    if (wr > bestWR) { bestWR = wr; bestHours = subset.map(h => h.hour).sort((a, b) => a - b); }
  }
  if (bestHours.length > 0) {
    const bWins = bestHours.reduce((s, h) => s + hourStats[h].wins, 0);
    const bTotal = bestHours.reduce((s, h) => s + hourStats[h].total, 0);
    console.log(`\nOptimal hours (${bestHours.length}h): [${bestHours.join(',')}]`);
    console.log(`  WR=${(bestWR*100).toFixed(1)}% T=${bTotal} PnL=$${bWins * BET - (bTotal - bWins) * BET}`);
  }
}

// ── Part 4: MFI Walk-Forward Validation ──────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 PART 4: MFI WALK-FORWARD VALIDATION');
console.log('══════════════════════════════════════════════════════════════');
console.log('MFI(10)>80+BB BTC/15m = 65.6% WR — is it stable?\n');

for (const { coin, tf } of [
  { coin: 'BTC', tf: '15m' }, { coin: 'ETH', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  const n = allC.length;
  const testSize = Math.floor(n * 0.06);
  const startTest = Math.floor(n * 0.7);

  console.log(`${coin}/${tf} MFI(10)>80+BB walk-forward:`);
  let totalWins = 0, totalTrades = 0;
  const foldWRs: number[] = [];

  for (let fold = 0; fold < 5; fold++) {
    const foldStart = startTest + fold * testSize;
    const foldEnd = Math.min(foldStart + testSize, n - 1);
    let wins = 0, trades = 0;

    for (let i = foldStart + 20; i < foldEnd; i++) {
      const dir = mfiBBSignal(allC, i, 80);
      if (!dir) continue;
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      trades++; if (win) wins++;
    }

    const wr = trades ? wins / trades : 0;
    foldWRs.push(wr);
    const flag = wr >= 0.65 ? ' ⭐' : wr < 0.50 ? ' ❌' : '';
    console.log(`  Fold${fold + 1}: WR=${(wr*100).toFixed(1)}% T=${trades}${flag}`);
    totalWins += wins; totalTrades += trades;
  }

  const finalWR = totalTrades ? totalWins / totalTrades : 0;
  const mean = foldWRs.reduce((a, b) => a + b) / foldWRs.length;
  const variance = foldWRs.reduce((s, x) => s + (x - mean) ** 2, 0) / foldWRs.length;
  const sigma = Math.sqrt(variance) * 100;
  console.log(`  Overall: WR=${(finalWR*100).toFixed(1)}% T=${totalTrades} σ=${sigma.toFixed(1)}%`);
  console.log(`  Stability: ${sigma < 5 ? '✅ Stable' : sigma < 10 ? '⚠️ Moderate' : '❌ Unstable'}`);
  console.log();
}

// ── Part 5: Keltner+BB Walk-Forward in Best4Hours ─────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 PART 5: KELTNER+BB IN BEST4HOURS — WALK-FORWARD');
console.log('══════════════════════════════════════════════════════════════');

{
  const allC = queryCandles('ETH', '5m');
  const n = allC.length;
  const testSize = Math.floor(n * 0.1);
  const startTest = Math.floor(n * 0.7);

  console.log('ETH/5m Keltner+BB in hours [10,11,12,21]:');
  let totalWins = 0, totalTrades = 0;
  const foldWRs: number[] = [];

  for (let fold = 0; fold < 5; fold++) {
    const foldStart = startTest + fold * testSize;
    const foldEnd = Math.min(foldStart + testSize, n - 1);
    let wins = 0, trades = 0;

    for (let i = foldStart + 40; i < foldEnd; i++) {
      const hour = new Date(allC[i].open_time).getUTCHours();
      if (!BEST_HOURS.includes(hour)) continue;
      const dir = keltnerBBSignal(allC, i);
      if (!dir) continue;
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      trades++; if (win) wins++;
    }

    const wr = trades ? wins / trades : 0;
    foldWRs.push(wr);
    const flag = wr >= 0.70 ? ' ⭐⭐' : wr >= 0.65 ? ' ⭐' : wr < 0.50 ? ' ❌' : '';
    console.log(`  Fold${fold + 1}: WR=${(wr*100).toFixed(1)}% T=${trades}${flag}`);
    totalWins += wins; totalTrades += trades;
  }

  const finalWR = totalTrades ? totalWins / totalTrades : 0;
  const mean = foldWRs.reduce((a, b) => a + b) / foldWRs.length;
  const variance = foldWRs.reduce((s, x) => s + (x - mean) ** 2, 0) / foldWRs.length;
  const sigma = Math.sqrt(variance) * 100;
  console.log(`  Overall: WR=${(finalWR*100).toFixed(1)}% T=${totalTrades} σ=${sigma.toFixed(1)}%`);
  const ci = 1.96 * Math.sqrt(finalWR * (1-finalWR) / totalTrades) * 100;
  console.log(`  95% CI: ${((finalWR-ci/100)*100).toFixed(1)}% - ${((finalWR+ci/100)*100).toFixed(1)}%`);
}

console.log('\n✅ Validation complete.');
