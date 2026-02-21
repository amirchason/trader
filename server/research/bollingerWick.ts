/**
 * Bollinger Band + Candle Wick Pattern Analysis
 *
 * New strategies to test:
 * 1. Bollinger Band reversion: price at/outside BB → expect reversion
 * 2. Candle wick patterns: hammer, shooting star, doji → reversal signals
 * 3. Engulfing patterns: big candle engulfs previous → reversal
 * 4. Combined: wick + BB + streak for ETH 5m
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/bollingerWick.ts
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
    'SELECT * FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC'
  ).all(coin, timeframe) as DbCandle[];
}

const BET = 10;

// ─── Indicator helpers ────────────────────────────────────────────────────────
function calcSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  return closes.slice(-period).reduce((a, b) => a + b) / period;
}

function calcStdDev(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

function calcATR(candles: DbCandle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b) / trs.length;
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

function calcRSI(closes: number[], period: number): number {
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

interface TestResult {
  label: string;
  trades: number;
  wins: number;
  wr: number;
  pnl: number;
}

function sim(
  candles: DbCandle[],
  signalFn: (i: number, candles: DbCandle[]) => 'BULL' | 'BEAR' | null
): TestResult & { label: string } {
  let wins = 0, total = 0;
  const WARMUP = 30;
  for (let i = WARMUP; i < candles.length - 1; i++) {
    const sig = signalFn(i, candles);
    if (!sig) continue;
    const nextUp = candles[i + 1].close > candles[i + 1].open;
    const win = sig === 'BULL' ? nextUp : !nextUp;
    if (win) wins++;
    total++;
  }
  const wr = total ? wins / total : 0;
  return { label: '', trades: total, wins, wr, pnl: wins * BET - (total - wins) * BET };
}

// ─── Strategy 1: Bollinger Band Reversion ────────────────────────────────────
// When price closes outside BB → expect next candle to revert
function bbReversion(period: number, mult: number) {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    if (i < period + 1) return null;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const sma = calcSMA(closes, period);
    const std = calcStdDev(closes, period);
    const upper = sma + mult * std;
    const lower = sma - mult * std;
    const c = candles[i];
    if (c.close > upper) return 'BEAR'; // above BB → revert down
    if (c.close < lower) return 'BULL'; // below BB → revert up
    return null;
  };
}

// ─── Strategy 2: BB + RSI confirmation ───────────────────────────────────────
function bbRSI(period: number, mult: number, rsiThresh: number) {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    if (i < Math.max(period + 1, 16)) return null;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const sma = calcSMA(closes, period);
    const std = calcStdDev(closes, period);
    const upper = sma + mult * std;
    const lower = sma - mult * std;
    const rsi = calcRSI(closes.slice(-16), 14);
    const c = candles[i];
    if (c.close > upper && rsi > rsiThresh) return 'BEAR';
    if (c.close < lower && rsi < (100 - rsiThresh)) return 'BULL';
    return null;
  };
}

// ─── Strategy 3: BB %B (price position within BB) ────────────────────────────
// When %B > 1 (above upper) or < 0 (below lower) → reversion
function bbPercentB(period: number, mult: number, extremeB: number) {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    if (i < period + 1) return null;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const sma = calcSMA(closes, period);
    const std = calcStdDev(closes, period);
    if (std === 0) return null;
    const upper = sma + mult * std;
    const lower = sma - mult * std;
    const pctB = (closes[closes.length - 1] - lower) / (upper - lower);
    if (pctB > extremeB) return 'BEAR';
    if (pctB < (1 - extremeB)) return 'BULL';
    return null;
  };
}

// ─── Strategy 4: Candle Wick Patterns ────────────────────────────────────────
// Shooting star: small body, large upper wick → BEAR
// Hammer: small body, large lower wick → BULL
function wickPattern(minWickRatio: number, maxBodyRatio: number) {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    const c = candles[i];
    const hlRange = c.high - c.low;
    if (hlRange <= 0) return null;
    const bodySize = Math.abs(c.close - c.open);
    const bodyRatio = bodySize / hlRange;
    if (bodyRatio > maxBodyRatio) return null; // body too large → not a wick pattern

    const upperWick = c.close > c.open
      ? (c.high - c.close) / hlRange
      : (c.high - c.open) / hlRange;
    const lowerWick = c.close > c.open
      ? (c.open - c.low) / hlRange
      : (c.close - c.low) / hlRange;

    if (upperWick > minWickRatio) return 'BEAR'; // shooting star
    if (lowerWick > minWickRatio) return 'BULL'; // hammer
    return null;
  };
}

// ─── Strategy 5: Doji pattern ────────────────────────────────────────────────
// Very small body (indecision) → mean reversion against prior trend
function dojiReversion(maxBodyPct: number) {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    if (i < 3) return null;
    const c = candles[i];
    if (c.open <= 0) return null;
    const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
    if (bodyPct > maxBodyPct) return null; // not a doji

    // Determine prior trend (last 3 candles)
    let upCount = 0;
    for (let j = i - 3; j < i; j++) {
      if (candles[j].close > candles[j].open) upCount++;
    }
    if (upCount >= 2) return 'BEAR'; // prior uptrend → doji = reversal
    if (upCount <= 1) return 'BULL'; // prior downtrend → doji = reversal
    return null;
  };
}

// ─── Strategy 6: Engulfing pattern ───────────────────────────────────────────
// Current candle body engulfs previous → continuation of current direction
// (Actually: big engulfing candle → REVERSION of that candle!)
function engulfingReversion() {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    if (i < 1) return null;
    const curr = candles[i];
    const prev = candles[i - 1];

    // Engulfing: current body fully contains previous body
    const currHigh = Math.max(curr.open, curr.close);
    const currLow = Math.min(curr.open, curr.close);
    const prevHigh = Math.max(prev.open, prev.close);
    const prevLow = Math.min(prev.open, prev.close);

    if (currHigh > prevHigh && currLow < prevLow) {
      // Current engulfs previous → bet opposite (reversal of current momentum)
      const currGreen = curr.close > curr.open;
      return currGreen ? 'BEAR' : 'BULL';
    }
    return null;
  };
}

// ─── Strategy 7: Streak + BB combined ────────────────────────────────────────
function streakBB(streakLen: number, bbPeriod: number, bbMult: number) {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    if (i < Math.max(streakLen + 3, bbPeriod + 1)) return null;

    // Streak signal
    let green = 0, red = 0;
    for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
      const cj = candles[j];
      if (cj.close > cj.open) { if (red > 0) break; green++; }
      else if (cj.close < cj.open) { if (green > 0) break; red++; }
      else break;
    }
    if (green < streakLen && red < streakLen) return null;
    const streakBear = green >= streakLen;

    // BB confirmation: price above/below band confirms streak reversal
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const sma = calcSMA(closes, bbPeriod);
    const std = calcStdDev(closes, bbPeriod);
    const upper = sma + bbMult * std;
    const lower = sma - bbMult * std;
    const price = candles[i].close;

    if (streakBear && price > upper) return 'BEAR'; // streak + above BB → strong BEAR
    if (!streakBear && price < lower) return 'BULL'; // streak + below BB → strong BULL
    return null; // only trade when BB confirms
  };
}

// ─── Strategy 8: BB width filter (avoid trading in high volatility) ───────────
function bbVolFilter(period: number, mult: number, maxWidthPct: number) {
  return (i: number, candles: DbCandle[]): 'BULL' | 'BEAR' | null => {
    if (i < period + 1) return null;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    const sma = calcSMA(closes, period);
    const std = calcStdDev(closes, period);
    const upper = sma + mult * std;
    const lower = sma - mult * std;
    const widthPct = (upper - lower) / sma * 100;

    // Only trade when BB is not too wide (normal volatility regime)
    if (widthPct > maxWidthPct) return null;

    const c = candles[i];
    if (c.close > upper) return 'BEAR';
    if (c.close < lower) return 'BULL';
    return null;
  };
}

// ─── Run tests ────────────────────────────────────────────────────────────────
const COINS_TFS: Array<{ coin: string; tf: string }> = [
  { coin: 'ETH', tf: '5m' },
  { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' },
  { coin: 'SOL', tf: '15m' },
];

const allResults: Array<{ coin: string; tf: string; strategy: string; result: TestResult }> = [];

console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 BOLLINGER BAND + CANDLE WICK PATTERN ANALYSIS');
console.log('══════════════════════════════════════════════════════════════');
console.log('Methodology: 70% train / 30% test (out-of-sample)\n');

for (const { coin, tf } of COINS_TFS) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 200) continue;
  const splitIdx = Math.floor(allC.length * 0.7);
  const testC = allC.slice(splitIdx);

  console.log(`\n── ${coin}/${tf} (${testC.length} test candles) ──────────────────────────`);

  const strategies: Array<{ name: string; fn: (i: number, c: DbCandle[]) => 'BULL' | 'BEAR' | null }> = [
    // Bollinger Band reversion
    { name: 'BB(20,2) reversion', fn: bbReversion(20, 2) },
    { name: 'BB(20,1.5) reversion', fn: bbReversion(20, 1.5) },
    { name: 'BB(10,2) reversion', fn: bbReversion(10, 2) },
    { name: 'BB(20,2.5) reversion', fn: bbReversion(20, 2.5) },
    // BB + RSI
    { name: 'BB(20,2)+RSI65', fn: bbRSI(20, 2, 65) },
    { name: 'BB(20,1.5)+RSI60', fn: bbRSI(20, 1.5, 60) },
    { name: 'BB(20,2)+RSI70', fn: bbRSI(20, 2, 70) },
    // BB %B
    { name: 'BB%B>1.1 reversion', fn: bbPercentB(20, 2, 1.1) },
    { name: 'BB%B>1.0 reversion', fn: bbPercentB(20, 2, 1.0) },
    // Wick patterns
    { name: 'Wick(50%,30%) pattern', fn: wickPattern(0.50, 0.30) },
    { name: 'Wick(60%,25%) pattern', fn: wickPattern(0.60, 0.25) },
    { name: 'Wick(65%,20%) pattern', fn: wickPattern(0.65, 0.20) },
    { name: 'Wick(70%,25%) pattern', fn: wickPattern(0.70, 0.25) },
    // Doji
    { name: 'Doji(<0.05%) reversion', fn: dojiReversion(0.05) },
    { name: 'Doji(<0.1%) reversion', fn: dojiReversion(0.10) },
    { name: 'Doji(<0.15%) reversion', fn: dojiReversion(0.15) },
    // Engulfing
    { name: 'Engulfing reversion', fn: engulfingReversion() },
    // Streak + BB combined
    { name: 'Streak(3)+BB(20,1.5)', fn: streakBB(3, 20, 1.5) },
    { name: 'Streak(3)+BB(20,2)', fn: streakBB(3, 20, 2) },
    { name: 'Streak(2)+BB(20,1.5)', fn: streakBB(2, 20, 1.5) },
    // BB with vol filter
    { name: 'BB(20,2)+maxWidth5%', fn: bbVolFilter(20, 2, 5) },
    { name: 'BB(20,2)+maxWidth3%', fn: bbVolFilter(20, 2, 3) },
  ];

  const results: Array<{ name: string } & TestResult> = [];
  for (const s of strategies) {
    const r = sim(testC, s.fn);
    r.label = s.name;
    results.push({ name: s.name, ...r });
    allResults.push({ coin, tf, strategy: s.name, result: r });
  }

  // Sort by WR for display
  results.sort((a, b) => b.wr - a.wr);

  console.log('  Strategy                        WR      Trades  PnL');
  for (const r of results) {
    if (r.trades < 10) continue;
    const flag = r.wr >= 0.62 ? ' ⭐⭐' : r.wr >= 0.58 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
    console.log(`  ${r.name.padEnd(32)} ${(r.wr * 100).toFixed(2).padStart(5)}%  ${r.trades.toString().padStart(6)}  $${r.pnl.toFixed(0).padStart(6)}${flag}`);
  }
}

// ─── Top results across all coins/TFs ─────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 TOP 15 RESULTS (≥30 trades, sorted by WR)');
console.log('══════════════════════════════════════════════════════════════');

allResults
  .filter(r => r.result.trades >= 30)
  .sort((a, b) => b.result.wr - a.result.wr)
  .slice(0, 15)
  .forEach(r => {
    console.log(`  ${r.coin}/${r.tf} ${r.strategy.padEnd(34)} WR=${(r.result.wr * 100).toFixed(2)}% T=${r.result.trades} PnL=$${r.result.pnl.toFixed(0)}`);
  });

// ─── Specifically: ETH/5m BB vs streak comparison ────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📌 ETH/5m DEEP DIVE: BB vs Streak vs Combined');
console.log('══════════════════════════════════════════════════════════════\n');

const eth5m = queryCandles('ETH', '5m');
const eth5mSplit = Math.floor(eth5m.length * 0.7);
const eth5mTest = eth5m.slice(eth5mSplit);

const eth5mStrategies: Array<{ name: string; fn: (i: number, c: DbCandle[]) => 'BULL' | 'BEAR' | null }> = [
  // Baselines
  { name: 'Streak(3) baseline', fn: (i, c) => {
    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i-5); j--) {
      if (c[j].close > c[j].open) { if (r > 0) break; g++; }
      else if (c[j].close < c[j].open) { if (g > 0) break; r++; }
      else break;
    }
    if (g >= 3) return 'BEAR';
    if (r >= 3) return 'BULL';
    return null;
  }},
  { name: 'BigCandle(0.5%) baseline', fn: (i, c) => {
    const chg = c[i].open > 0 ? (c[i].close - c[i].open) / c[i].open * 100 : 0;
    if (chg >= 0.5) return 'BEAR';
    if (chg <= -0.5) return 'BULL';
    return null;
  }},
  // BB variants
  { name: 'BB(20,2)', fn: bbReversion(20, 2) },
  { name: 'BB(20,1.5)', fn: bbReversion(20, 1.5) },
  { name: 'BB(10,2)', fn: bbReversion(10, 2) },
  { name: 'BB(20,2)+RSI65', fn: bbRSI(20, 2, 65) },
  { name: 'BB(20,1.5)+RSI60', fn: bbRSI(20, 1.5, 60) },
  // Wick patterns for 5m
  { name: 'Wick(60%,25%)', fn: wickPattern(0.60, 0.25) },
  { name: 'Wick(65%,20%)', fn: wickPattern(0.65, 0.20) },
  // Combined: streak + BB
  { name: 'Streak(3)+BB(20,1.5)', fn: streakBB(3, 20, 1.5) },
  { name: 'Streak(3)+BB(20,2)', fn: streakBB(3, 20, 2) },
  // Combined: streak + body/ATR ≥ 0.9
  { name: 'Streak+BodyATR≥0.9', fn: (i, c) => {
    if (i < 20) return null;
    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i-5); j--) {
      if (c[j].close > c[j].open) { if (r > 0) break; g++; }
      else if (c[j].close < c[j].open) { if (g > 0) break; r++; }
      else break;
    }
    if (g < 3 && r < 3) return null;
    const atr = calcATR(c.slice(i-14, i+1), 14);
    const bodyPct = c[i].open > 0 ? Math.abs(c[i].close-c[i].open)/c[i].open*100 : 0;
    const bodyATR = atr > 0 ? bodyPct/100*c[i].close/atr : 0;
    if (bodyATR < 0.9) return null;
    return g >= 3 ? 'BEAR' : 'BULL';
  }},
  // Streak + RSI confirm
  { name: 'Streak+RSI≥55', fn: (i, c) => {
    if (i < 16) return null;
    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i-5); j--) {
      if (c[j].close > c[j].open) { if (r > 0) break; g++; }
      else if (c[j].close < c[j].open) { if (g > 0) break; r++; }
      else break;
    }
    if (g < 3 && r < 3) return null;
    const rsi = calcRSI(c.slice(i-15, i+1).map(x => x.close), 14);
    if (g >= 3 && rsi >= 55) return 'BEAR';
    if (r >= 3 && rsi <= 45) return 'BULL';
    return null;
  }},
  // TRIPLE COMBO: streak + bodyATR + RSI
  { name: 'Streak+BodyATR+RSI55', fn: (i, c) => {
    if (i < 20) return null;
    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i-5); j--) {
      if (c[j].close > c[j].open) { if (r > 0) break; g++; }
      else if (c[j].close < c[j].open) { if (g > 0) break; r++; }
      else break;
    }
    if (g < 3 && r < 3) return null;
    const rsi = calcRSI(c.slice(i-15, i+1).map(x => x.close), 14);
    const atr = calcATR(c.slice(i-14, i+1), 14);
    const bodyPct = c[i].open > 0 ? Math.abs(c[i].close-c[i].open)/c[i].open*100 : 0;
    const bodyATR = atr > 0 ? bodyPct/100*c[i].close/atr : 0;
    if (bodyATR < 0.7) return null;
    if (g >= 3 && rsi >= 55) return 'BEAR';
    if (r >= 3 && rsi <= 45) return 'BULL';
    return null;
  }},
  // Streak + BB outright
  { name: 'Streak+BigCandle+BB', fn: (i, c) => {
    if (i < 25) return null;
    // Streak or big candle
    let g = 0, r = 0;
    for (let j = i; j >= Math.max(0, i-5); j--) {
      if (c[j].close > c[j].open) { if (r > 0) break; g++; }
      else if (c[j].close < c[j].open) { if (g > 0) break; r++; }
      else break;
    }
    const chg = c[i].open > 0 ? (c[i].close - c[i].open) / c[i].open * 100 : 0;
    const isBig = Math.abs(chg) >= 0.5;
    const isStreak = g >= 3 || r >= 3;
    if (!isStreak && !isBig) return null;
    // BB position
    const closes = c.slice(0, i+1).map(x => x.close);
    const sma = calcSMA(closes, 20);
    const std = calcStdDev(closes, 20);
    const upper = sma + 2 * std;
    const lower = sma - 2 * std;
    const price = c[i].close;
    if (price > upper) return 'BEAR';
    if (price < lower) return 'BULL';
    return null;
  }},
];

console.log('  ETH/5m strategies (test: last 30% of data):');
console.log('  Strategy                          WR      Trades  PnL      Improvement');
const eth5mBase = sim(eth5mTest, eth5mStrategies[0].fn);
for (const s of eth5mStrategies) {
  const r = sim(eth5mTest, s.fn);
  if (r.trades < 10) continue;
  const delta = (r.wr - eth5mBase.wr) * 100;
  const imp = delta !== 0 ? ` Δ=${delta > 0 ? '+' : ''}${delta.toFixed(1)}%` : '';
  const flag = r.wr >= 0.62 ? ' ⭐⭐' : r.wr >= 0.58 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
  console.log(`  ${s.name.padEnd(34)} ${(r.wr*100).toFixed(2).padStart(5)}%  ${r.trades.toString().padStart(6)}  $${r.pnl.toFixed(0).padStart(6)}${imp}${flag}`);
}

// Save results
const output = {
  timestamp: Date.now(),
  allResults: allResults.filter(r => r.result.trades >= 10).map(r => ({
    coin: r.coin, tf: r.tf, strategy: r.strategy,
    wr: r.result.wr, trades: r.result.trades, pnl: r.result.pnl
  })),
};
fs.writeFileSync(path.join(RESEARCH_DIR, 'bollinger-wick.json'), JSON.stringify(output, null, 2));
console.log('\n✅ Results saved to docs/backtest-research/bollinger-wick.json');
