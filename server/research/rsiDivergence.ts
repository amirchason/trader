/**
 * RSI Divergence Deep Dive + Final Production Comparison
 *
 * RSI divergence (lb=5)+BB on ETH/5m = 64.7% WR (119 trades) — promising
 * Can we improve it with additional filters?
 * Also: final comparison of all strategies across all coins/timeframes
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/rsiDivergence.ts
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

function calcRSI(candles: DbCandle[], i: number, period = 14): number {
  if (i < period + 1) return 50;
  const start = i - period - 1;
  let avgGain = 0, avgLoss = 0;
  for (let j = start + 1; j <= start + period; j++) {
    const d = candles[j].close - candles[j - 1].close;
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let j = start + period + 1; j <= i; j++) {
    const d = candles[j].close - candles[j - 1].close;
    if (d > 0) {
      avgGain = (avgGain * (period - 1) + d) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - d) / period;
    }
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

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

// ── Part 1: RSI Divergence parameter sweep ───────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📉 PART 1: RSI DIVERGENCE DEEP DIVE');
console.log('══════════════════════════════════════════════════════════════');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' }, { coin: 'BTC', tf: '5m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  console.log(`\n── ${coin}/${tf} ──`);

  for (const lookback of [3, 5, 7, 10]) {
    for (const bbFilter of [false, true]) {
      for (const requireBBExtreme of [false, true]) {
        let wins = 0, total = 0;
        let bearWins = 0, bearTotal = 0;
        let bullWins = 0, bullTotal = 0;

        for (let i = splitIdx + 20; i < allC.length - 1; i++) {
          if (i < lookback + 15) continue;

          const rsiNow = calcRSI(allC, i, 14);
          const rsiPast = calcRSI(allC, i - lookback, 14);
          const priceNow = allC[i].close;
          const pricePast = allC[i - lookback].close;

          // Bearish divergence: price higher, RSI lower, RSI was above 50
          const bearDiv = priceNow > pricePast && rsiNow < rsiPast && rsiNow > 50;
          // Bullish divergence: price lower, RSI higher, RSI was below 50
          const bullDiv = priceNow < pricePast && rsiNow > rsiPast && rsiNow < 50;

          if (!bearDiv && !bullDiv) continue;

          const bb = getBB(allC, i);

          if (bbFilter && bb) {
            // Require current RSI divergence at BB extreme
            if (requireBBExtreme) {
              if (bearDiv && priceNow < bb.upper) continue;
              if (bullDiv && priceNow > bb.lower) continue;
            } else {
              // BB on same side (above mid for bear, below mid for bull)
              if (bearDiv && priceNow < bb.mid) continue;
              if (bullDiv && priceNow > bb.mid) continue;
            }
          }

          const nextGreen = allC[i + 1].close > allC[i + 1].open;
          const dir: 'BULL' | 'BEAR' = bearDiv ? 'BEAR' : 'BULL';
          const win = dir === 'BEAR' ? !nextGreen : nextGreen;
          total++; if (win) wins++;
          if (bearDiv) { bearTotal++; if (win) bearWins++; }
          else { bullTotal++; if (win) bullWins++; }
        }

        const wr = total ? wins / total : 0;
        const filterLabel = !bbFilter ? 'raw' : (requireBBExtreme ? '+BB_extreme' : '+BB_mid');
        if (total >= 30 && wr >= 0.60) {
          const flag = wr >= 0.68 ? ' ⭐⭐' : wr >= 0.64 ? ' ⭐' : '';
          const pnl = wins * BET - (total - wins) * BET;
          console.log(`  lb=${lookback} ${filterLabel}: WR=${(wr*100).toFixed(1)}% T=${total} PnL=$${pnl}${flag}`);
          if (bearTotal > 10 && bearTotal !== total) console.log(`    bear: ${(bearWins/bearTotal*100).toFixed(1)}% (${bearTotal})`);
          if (bullTotal > 10 && bullTotal !== total) console.log(`    bull: ${(bullWins/bullTotal*100).toFixed(1)}% (${bullTotal})`);
        }
      }
    }
  }
}

// ── Part 2: Final Comprehensive Strategy Comparison ──────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 PART 2: FINAL PRODUCTION STRATEGY COMPARISON (all discovered)');
console.log('══════════════════════════════════════════════════════════════');
console.log('All strategies tested on same out-of-sample (30%) test period\n');

type StratResult = { name: string; wr: number; trades: number; pnl: number };

for (const { coin, tf } of [
  { coin: 'ETH', tf: '15m' }, { coin: 'ETH', tf: '5m' },
  { coin: 'BTC', tf: '15m' }, { coin: 'SOL', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);
  const results: StratResult[] = [];

  function testStrategy(name: string, signalFn: (i: number) => 'BULL' | 'BEAR' | null) {
    let wins = 0, total = 0;
    for (let i = splitIdx + 25; i < allC.length - 1; i++) {
      const dir = signalFn(i);
      if (!dir) continue;
      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      total++; if (win) wins++;
    }
    if (total >= 10) {
      results.push({ name, wr: wins / total, trades: total, pnl: wins * BET - (total - wins) * BET });
    }
  }

  // Strategy: Streak(3)+BB
  testStrategy('Streak(3)+BB', (i) => {
    const streak = getStreak(allC, i);
    const bb = getBB(allC, i);
    if (!bb) return null;
    if (streak >= 3 && allC[i].close > bb.upper) return 'BEAR';
    if (streak <= -3 && allC[i].close < bb.lower) return 'BULL';
    return null;
  });

  // Strategy: GGG+BB+bodyATR
  testStrategy('GGG+BB+bodyATR', (i) => {
    const streak = getStreak(allC, i);
    const bb = getBB(allC, i);
    if (!bb) return null;
    if (streak >= 3 && allC[i].close > bb.upper) {
      const atr = calcATR(allC, i);
      if (atr > 0 && Math.abs(allC[i].close - allC[i].open) / atr < 0.9) return null;
      return 'BEAR';
    }
    if (streak <= -3 && allC[i].close < bb.lower) {
      const atr = calcATR(allC, i);
      if (atr > 0 && Math.abs(allC[i].close - allC[i].open) / atr < 0.9) return null;
      return 'BULL';
    }
    return null;
  });

  // Strategy: GGG+BB+bodyATR+skip14
  testStrategy('GGG+BB+bodyATR+skip14', (i) => {
    const hour = new Date(allC[i].open_time).getUTCHours();
    if (hour === 14) return null;
    const streak = getStreak(allC, i);
    const bb = getBB(allC, i);
    if (!bb) return null;
    if (streak >= 3 && allC[i].close > bb.upper) {
      const atr = calcATR(allC, i);
      if (atr > 0 && Math.abs(allC[i].close - allC[i].open) / atr < 0.9) return null;
      return 'BEAR';
    }
    if (streak <= -3 && allC[i].close < bb.lower) {
      const atr = calcATR(allC, i);
      if (atr > 0 && Math.abs(allC[i].close - allC[i].open) / atr < 0.9) return null;
      return 'BULL';
    }
    return null;
  });

  // Strategy: Volume Spike(3x)+Streak(3)+BB
  testStrategy('VolSpike(3x)+Streak(3)+BB', (i) => {
    const c = allC[i];
    const streak = getStreak(allC, i);
    const bb = getBB(allC, i);
    if (!bb) return null;
    if (Math.abs(streak) < 3) return null;
    const volSlice = allC.slice(Math.max(0, i - 20), i);
    const avgVol = volSlice.reduce((s, c) => s + c.volume, 0) / volSlice.length;
    if (c.volume < avgVol * 3) return null;
    if (streak >= 3 && c.close > bb.upper && c.close > c.open) return 'BEAR';
    if (streak <= -3 && c.close < bb.lower && c.close < c.open) return 'BULL';
    return null;
  });

  // Strategy: RSI divergence (lb=5)+BB_extreme
  testStrategy('RSI_div(lb=5)+BB', (i) => {
    if (i < 20) return null;
    const rsiNow = calcRSI(allC, i, 14);
    const rsiPast = calcRSI(allC, i - 5, 14);
    const priceNow = allC[i].close, pricePast = allC[i - 5].close;
    const bb = getBB(allC, i);
    if (!bb) return null;
    if (priceNow > pricePast && rsiNow < rsiPast && rsiNow > 50 && priceNow > bb.upper) return 'BEAR';
    if (priceNow < pricePast && rsiNow > rsiPast && rsiNow < 50 && priceNow < bb.lower) return 'BULL';
    return null;
  });

  // Strategy: Keltner+BB double confirm
  testStrategy('Keltner+BB_dbl', (i) => {
    if (i < 35) return null;
    const bb = getBB(allC, i);
    if (!bb) return null;
    // Keltner (EMA20 ± 2*ATR14)
    const mult = 2 / 21;
    const slice = allC.slice(i - 20, i + 1);
    let ema = slice[0].close;
    for (let j = 1; j < slice.length; j++) ema = (slice[j].close - ema) * mult + ema;
    const atr = calcATR(allC, i);
    const kcUpper = ema + 2 * atr;
    const kcLower = ema - 2 * atr;
    const price = allC[i].close;
    const streak = getStreak(allC, i);
    const hour = new Date(allC[i].open_time).getUTCHours();
    if (hour === 14) return null;
    if (price > bb.upper && price > kcUpper && streak >= 3) return 'BEAR';
    if (price < bb.lower && price < kcLower && streak <= -3) return 'BULL';
    return null;
  });

  // Sort by WR and display
  results.sort((a, b) => b.wr - a.wr);
  console.log(`${coin}/${tf}:`);
  for (const r of results) {
    const flag = r.wr >= 0.70 ? ' ⭐⭐⭐' : r.wr >= 0.65 ? ' ⭐⭐' : r.wr >= 0.60 ? ' ⭐' : '';
    console.log(`  ${r.name.padEnd(30)} WR=${(r.wr*100).toFixed(1).padStart(5)}%  T=${r.trades.toString().padStart(4)}  PnL=$${r.pnl.toString().padStart(5)}${flag}`);
  }
  console.log();
}

console.log('\n✅ RSI Divergence + Final comparison complete.');
