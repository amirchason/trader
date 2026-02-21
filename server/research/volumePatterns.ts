/**
 * Volume Patterns + EMA Crossover + Round Number Research
 *
 * Tests remaining unexplored signal types:
 * 1. OBV (On-Balance Volume) — does volume predict next candle direction?
 * 2. EMA crossover (9/21) — trend signals on 5m/15m
 * 3. Round number proximity — do price levels near round numbers have edge?
 * 4. RSI divergence — price vs RSI momentum divergence
 * 5. Volume spike patterns with direction (candle color + volume)
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/volumePatterns.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DbCandle } from '../db';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH);
const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');
fs.mkdirSync(RESEARCH_DIR, { recursive: true });

function queryCandles(coin: string, timeframe: string): DbCandle[] {
  return db.prepare(
    'SELECT * FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC'
  ).all(coin, timeframe) as DbCandle[];
}

const BET = 10;

// ── Indicator helpers ─────────────────────────────────────────────────────────

function calcOBV(candles: DbCandle[], i: number, period = 20): number {
  const start = Math.max(0, i - period);
  let obv = 0;
  for (let j = start + 1; j <= i; j++) {
    if (candles[j].close > candles[j - 1].close) obv += candles[j].volume;
    else if (candles[j].close < candles[j - 1].close) obv -= candles[j].volume;
  }
  return obv;
}

function calcEMA(candles: DbCandle[], i: number, period: number): number {
  if (i < period) return candles[i].close;
  const mult = 2 / (period + 1);
  let ema = candles[Math.max(0, i - period * 2)].close;
  for (let j = Math.max(1, i - period * 2); j <= i; j++) {
    ema = (candles[j].close - ema) * mult + ema;
  }
  return ema;
}

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i]; else avgLoss -= changes[i];
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) {
      avgGain = (avgGain * (period - 1) + changes[i]) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - changes[i]) / period;
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

// ── Part 1: OBV Divergence ────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 PART 1: OBV (ON-BALANCE VOLUME) PATTERNS');
console.log('══════════════════════════════════════════════════════════════');
console.log('Hypothesis: Rising price + falling OBV → bearish divergence → BEAR');
console.log('            Falling price + rising OBV → bullish divergence → BULL');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '15m' }, { coin: 'ETH', tf: '5m' }, { coin: 'BTC', tf: '15m' }
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // OBV divergence: price made higher high but OBV made lower high (bear)
  // or price made lower low but OBV made higher low (bull)
  const lookback = 5;
  let totalTrades = 0, wins = 0;
  const signals: { dir: 'BULL' | 'BEAR'; win: boolean }[] = [];

  for (let i = splitIdx + 30; i < allC.length - 1; i++) {
    const c = allC[i];
    // Compare to lookback bars ago
    const past = allC[i - lookback];
    const obvNow = calcOBV(allC, i, 20);
    const obvPast = calcOBV(allC, i - lookback, 20);

    // Bearish divergence: price higher, OBV lower
    const priceMadeHigherHigh = c.close > past.close;
    const obvFell = obvNow < obvPast;
    const bearDiv = priceMadeHigherHigh && obvFell;

    // Bullish divergence: price lower, OBV higher
    const priceMadeLowerLow = c.close < past.close;
    const obvRose = obvNow > obvPast;
    const bullDiv = priceMadeLowerLow && obvRose;

    if (!bearDiv && !bullDiv) continue;

    // Extra filter: require BB position confirmation
    const bb = getBB(allC, i);
    if (!bb) continue;
    const priceAboveBB = c.close > bb.upper;
    const priceBelowBB = c.close < bb.lower;

    let dir: 'BULL' | 'BEAR' | null = null;
    if (bearDiv && priceAboveBB) dir = 'BEAR';
    if (bullDiv && priceBelowBB) dir = 'BULL';
    if (!dir) continue;

    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;
    signals.push({ dir, win });
    totalTrades++;
    if (win) wins++;
  }

  const wr = totalTrades ? wins / totalTrades : 0;
  const pnl = wins * BET - (totalTrades - wins) * BET;
  console.log(`${coin}/${tf}: OBV divergence+BB: WR=${(wr*100).toFixed(1)}% T=${totalTrades} PnL=$${pnl}`);
}

// ── Part 2: EMA Crossover ─────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📈 PART 2: EMA CROSSOVER (9/21)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Testing EMA9 vs EMA21 crossovers — both trend-following and mean-reverting');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '15m' }, { coin: 'ETH', tf: '5m' }, { coin: 'BTC', tf: '15m' }
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Test 1: Trend-following (trade in direction of EMA crossover)
  let trendTrades = 0, trendWins = 0;
  // Test 2: Mean-reverting at extreme EMA divergence
  let revTrades = 0, revWins = 0;

  for (let i = splitIdx + 30; i < allC.length - 1; i++) {
    const ema9 = calcEMA(allC, i, 9);
    const ema9prev = calcEMA(allC, i - 1, 9);
    const ema21 = calcEMA(allC, i, 21);
    const ema21prev = calcEMA(allC, i - 1, 21);

    // Crossover detection
    const justCrossedBullish = ema9prev < ema21prev && ema9 > ema21;
    const justCrossedBearish = ema9prev > ema21prev && ema9 < ema21;

    const nextGreen = allC[i + 1].close > allC[i + 1].open;

    if (justCrossedBullish || justCrossedBearish) {
      const dir: 'BULL' | 'BEAR' = justCrossedBullish ? 'BULL' : 'BEAR';
      const win = dir === 'BULL' ? nextGreen : !nextGreen;
      trendTrades++; if (win) trendWins++;
    }

    // EMA divergence: EMA9 >> EMA21 (overbought) or EMA9 << EMA21 (oversold)
    const emaDivPct = Math.abs(ema9 - ema21) / ema21 * 100;
    if (emaDivPct > 0.5) { // significant divergence
      const dir: 'BULL' | 'BEAR' = ema9 > ema21 ? 'BEAR' : 'BULL'; // mean-revert
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      revTrades++; if (win) revWins++;
    }
  }

  const trendWR = trendTrades ? trendWins / trendTrades : 0;
  const revWR = revTrades ? revWins / revTrades : 0;
  console.log(`${coin}/${tf}: EMA crossover (trend-follow): WR=${(trendWR*100).toFixed(1)}% T=${trendTrades}`);
  console.log(`${coin}/${tf}: EMA divergence>0.5% (mean-rev): WR=${(revWR*100).toFixed(1)}% T=${revTrades}`);
}

// ── Part 3: Round Number Proximity ────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔢 PART 3: ROUND NUMBER PROXIMITY');
console.log('══════════════════════════════════════════════════════════════');
console.log('Hypothesis: Price near round numbers has different behavior');
console.log('Testing: 0.5%, 0.2%, 0.1% proximity to round $100/$1000 levels');

for (const { coin, tf, roundTo } of [
  { coin: 'ETH', tf: '15m', roundTo: 100 },
  { coin: 'ETH', tf: '5m', roundTo: 100 },
  { coin: 'BTC', tf: '15m', roundTo: 1000 },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  for (const threshold of [0.1, 0.2, 0.5]) {
    let nearRound = 0, nearRoundWins = 0;
    let nearRoundAbove = 0, nearRoundAboveWins = 0;
    let nearRoundBelow = 0, nearRoundBelowWins = 0;

    for (let i = splitIdx + 5; i < allC.length - 1; i++) {
      const price = allC[i].close;
      const nearestRound = Math.round(price / roundTo) * roundTo;
      const distPct = Math.abs(price - nearestRound) / price * 100;

      if (distPct > threshold) continue;

      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      nearRound++;
      if (nextGreen) nearRoundWins++;

      // Above vs below the round number
      if (price > nearestRound) {
        nearRoundAbove++;
        if (!nextGreen) nearRoundAboveWins++; // expect rejection (BEAR)
      } else {
        nearRoundBelow++;
        if (nextGreen) nearRoundBelowWins++; // expect bounce (BULL)
      }
    }

    const allWR = nearRound ? nearRoundWins / nearRound : 0;
    const aboveWR = nearRoundAbove ? nearRoundAboveWins / nearRoundAbove : 0;
    const belowWR = nearRoundBelow ? nearRoundBelowWins / nearRoundBelow : 0;

    if (nearRound > 20) {
      console.log(`${coin}/${tf} within ${threshold}% of $${roundTo} level: T=${nearRound} green_WR=${(allWR*100).toFixed(1)}%`);
      if (nearRoundAbove > 5) console.log(`  → Above round (expect bear rejection): WR=${(aboveWR*100).toFixed(1)}% T=${nearRoundAbove}`);
      if (nearRoundBelow > 5) console.log(`  → Below round (expect bull bounce): WR=${(belowWR*100).toFixed(1)}% T=${nearRoundBelow}`);
    }
  }
}

// ── Part 4: Volume Spike + Streak ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 PART 4: VOLUME SPIKE + DIRECTION PATTERNS');
console.log('══════════════════════════════════════════════════════════════');
console.log('High volume green candles after streak → exhaustion (BEAR)');
console.log('High volume red candles after streak → capitulation (BULL)');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '15m' }, { coin: 'ETH', tf: '5m' }, { coin: 'BTC', tf: '15m' }
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  for (const volMult of [2.0, 3.0]) {
    for (const minStreak of [2, 3]) {
      let trades = 0, wins = 0;

      for (let i = splitIdx + 25; i < allC.length - 1; i++) {
        const c = allC[i];
        const streak = getStreak(allC, i);
        if (Math.abs(streak) < minStreak) continue;

        // Calculate average volume over last 20 candles
        const volSlice = allC.slice(Math.max(0, i - 20), i);
        const avgVol = volSlice.reduce((s, c) => s + c.volume, 0) / volSlice.length;

        // Volume spike in direction of streak
        const isSpike = c.volume > avgVol * volMult;
        if (!isSpike) continue;

        // BB confirmation
        const bb = getBB(allC, i);
        if (!bb) continue;

        let dir: 'BULL' | 'BEAR' | null = null;
        // Green candle + streak + high vol above BB → exhaustion BEAR
        if (streak > 0 && c.close > c.open && c.close > bb.upper) dir = 'BEAR';
        // Red candle + streak + high vol below BB → capitulation BULL
        if (streak < 0 && c.close < c.open && c.close < bb.lower) dir = 'BULL';
        if (!dir) continue;

        const nextGreen = allC[i + 1].close > allC[i + 1].open;
        const win = dir === 'BEAR' ? !nextGreen : nextGreen;
        trades++; if (win) wins++;
      }

      const wr = trades ? wins / trades : 0;
      const pnl = wins * BET - (trades - wins) * BET;
      if (trades >= 10) {
        const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
        console.log(`${coin}/${tf} vol>${volMult}x + streak≥${minStreak} + BB: WR=${(wr*100).toFixed(1)}% T=${trades} PnL=$${pnl}${flag}`);
      }
    }
  }
}

// ── Part 5: RSI Divergence ────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📉 PART 5: RSI DIVERGENCE PATTERNS');
console.log('══════════════════════════════════════════════════════════════');
console.log('Price made new high but RSI lower → bearish divergence → BEAR');
console.log('Price made new low but RSI higher → bullish divergence → BULL');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '15m' }, { coin: 'ETH', tf: '5m' }, { coin: 'BTC', tf: '15m' }
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  for (const lookback of [5, 10]) {
    let trades = 0, wins = 0;
    let bearTrades = 0, bearWins = 0;
    let bullTrades = 0, bullWins = 0;

    for (let i = splitIdx + 20; i < allC.length - 1; i++) {
      if (i < lookback + 15) continue;

      const rsiNow = calcRSI(allC.slice(i - 14, i + 1).map(c => c.close));
      const rsiPast = calcRSI(allC.slice(i - lookback - 14, i - lookback + 1).map(c => c.close));
      const priceNow = allC[i].close;
      const pricePast = allC[i - lookback].close;

      // Bearish divergence: price higher, RSI lower
      const bearDiv = priceNow > pricePast && rsiNow < rsiPast && rsiNow > 50;
      // Bullish divergence: price lower, RSI higher
      const bullDiv = priceNow < pricePast && rsiNow > rsiPast && rsiNow < 50;

      if (!bearDiv && !bullDiv) continue;

      // Require BB extremes for confirmation
      const bb = getBB(allC, i);
      if (!bb) continue;
      if (bearDiv && allC[i].close < bb.upper) continue; // only near upper
      if (bullDiv && allC[i].close > bb.lower) continue; // only near lower

      const nextGreen = allC[i + 1].close > allC[i + 1].open;
      const dir: 'BULL' | 'BEAR' = bearDiv ? 'BEAR' : 'BULL';
      const win = dir === 'BEAR' ? !nextGreen : nextGreen;
      trades++; if (win) wins++;
      if (bearDiv) { bearTrades++; if (win) bearWins++; }
      else { bullTrades++; if (win) bullWins++; }
    }

    const wr = trades ? wins / trades : 0;
    if (trades >= 20) {
      const flag = wr >= 0.60 ? ' ⭐' : '';
      console.log(`${coin}/${tf} RSI divergence (lb=${lookback})+BB: WR=${(wr*100).toFixed(1)}% T=${trades}${flag}`);
      if (bearTrades > 5) console.log(`  → Bear div: WR=${((bearTrades ? bearWins/bearTrades : 0)*100).toFixed(1)}% T=${bearTrades}`);
      if (bullTrades > 5) console.log(`  → Bull div: WR=${((bullTrades ? bullWins/bullTrades : 0)*100).toFixed(1)}% T=${bullTrades}`);
    }
  }
}

// ── Part 6: GGG+BB vs ATR regime combined ────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 PART 6: BEST STRATEGY (GGG+BB+bodyATR) vs ATR REGIME');
console.log('══════════════════════════════════════════════════════════════');
console.log('Can ATR regime filter improve even the best strategy further?');

for (const { coin, tf } of [
  { coin: 'ETH', tf: '15m' }, { coin: 'ETH', tf: '5m' },
  { coin: 'BTC', tf: '15m' }, { coin: 'SOL', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Compute ATR percentiles for train set
  const trainATRs: number[] = [];
  for (let i = 15; i < splitIdx; i++) {
    trainATRs.push(calcATR(allC, i));
  }
  trainATRs.sort((a, b) => a - b);
  const atr33 = trainATRs[Math.floor(trainATRs.length * 0.33)];
  const atr66 = trainATRs[Math.floor(trainATRs.length * 0.66)];

  const results: Record<string, { wins: number; total: number }> = {
    all: { wins: 0, total: 0 },
    lowATR: { wins: 0, total: 0 },
    midATR: { wins: 0, total: 0 },
    highATR: { wins: 0, total: 0 },
    skip14: { wins: 0, total: 0 },
  };

  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const c = allC[i];
    const streak = getStreak(allC, i);
    const bb = getBB(allC, i);
    if (!bb) continue;

    const bearSig = streak >= 3 && c.close > bb.upper;
    const bullSig = streak <= -3 && c.close < bb.lower;
    if (!bearSig && !bullSig) continue;

    // Body/ATR filter
    const atr = calcATR(allC, i);
    const body = Math.abs(c.close - c.open);
    if (atr <= 0 || body / atr < 0.9) continue;

    const dir: 'BULL' | 'BEAR' = bearSig ? 'BEAR' : 'BULL';
    const nextGreen = allC[i + 1].close > allC[i + 1].open;
    const win = dir === 'BEAR' ? !nextGreen : nextGreen;

    const currentAtr = calcATR(allC, i);
    const hour = new Date(c.open_time).getUTCHours();

    results.all.total++; if (win) results.all.wins++;
    if (hour !== 14) { results.skip14.total++; if (win) results.skip14.wins++; }
    if (currentAtr <= atr33) { results.lowATR.total++; if (win) results.lowATR.wins++; }
    else if (currentAtr <= atr66) { results.midATR.total++; if (win) results.midATR.wins++; }
    else { results.highATR.total++; if (win) results.highATR.wins++; }
  }

  console.log(`\n${coin}/${tf} GGG+BB+bodyATR≥0.9:`);
  for (const [label, r] of Object.entries(results)) {
    if (r.total < 5) continue;
    const wr = r.wins / r.total;
    const pnl = r.wins * BET - (r.total - r.wins) * BET;
    const flag = wr >= 0.70 ? ' ⭐⭐' : wr >= 0.65 ? ' ⭐' : '';
    console.log(`  ${label.padEnd(8)}: WR=${(wr*100).toFixed(1).padStart(5)}%  T=${r.total.toString().padStart(3)}  PnL=$${pnl.toString().padStart(4)}${flag}`);
  }
}

console.log('\n✅ Done. Research complete.');
