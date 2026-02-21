/**
 * GBDT Signal Filter + Markov Pattern Strategies
 *
 * Key hypotheses:
 * 1. GBDT trained ONLY on streak+BB signal candidates → higher WR than GBDT on all candles
 * 2. Specific Markov patterns (RRRR, GRRRR, GGGGG) as production trading rules
 * 3. Markov pattern + BB outside bands = even higher WR?
 * 4. Portfolio of best strategies across coins
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/gbdtFilter.ts
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
function isGreen(c: DbCandle) { return c.close > c.open; }

// ─── Technical indicators ─────────────────────────────────────────────────────
function calcSMA(arr: number[], period: number): number {
  if (arr.length < period) return arr[arr.length - 1] ?? 0;
  return arr.slice(-period).reduce((a, b) => a + b) / period;
}

function calcStdDev(arr: number[], period: number): number {
  if (arr.length < period) return 0;
  const slice = arr.slice(-period);
  const mean = slice.reduce((a, b) => a + b) / period;
  return Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
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

function calcATR(candles: DbCandle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

// Count streak length
function getStreak(candles: DbCandle[], i: number): number {
  let green = 0, red = 0;
  for (let j = i; j >= Math.max(0, i - 10); j--) {
    const cj = candles[j];
    if (cj.close > cj.open) { if (red > 0) break; green++; }
    else if (cj.close < cj.open) { if (green > 0) break; red++; }
    else break;
  }
  return green > 0 ? green : -red;
}

// Get N-candle direction pattern (e.g., "RRRG")
function getPattern(candles: DbCandle[], i: number, len: number): string {
  if (i < len) return '';
  return candles.slice(i - len + 1, i + 1).map(c => isGreen(c) ? 'G' : 'R').join('');
}

// Get BB signal and data
interface BBData { upper: number; lower: number; mid: number; pctB: number; std: number }
function getBB(candles: DbCandle[], i: number, period = 20, mult = 2): BBData | null {
  if (i < period) return null;
  const closes = candles.slice(i - period + 1, i + 1).map(c => c.close);
  const mid = closes.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mid) ** 2, 0) / period);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const pctB = std > 0 ? (candles[i].close - lower) / (upper - lower) : 0.5;
  return { upper, lower, mid, pctB, std };
}

// ─── Streak+BB signal ─────────────────────────────────────────────────────────
interface SignalResult { direction: 'BULL' | 'BEAR'; reason: string }
function getStreakBBSignal(
  candles: DbCandle[], i: number,
  streakLen = 3, bbMult = 2
): SignalResult | null {
  if (i < 25) return null;
  const streak = getStreak(candles, i);
  const bb = getBB(candles, i, 20, bbMult);

  const streakBull = streak <= -streakLen;
  const streakBear = streak >= streakLen;
  const bbBull = bb ? candles[i].close < bb.lower : false;
  const bbBear = bb ? candles[i].close > bb.upper : false;

  // Strong: both agree
  if (streakBull && bbBull) return { direction: 'BULL', reason: 'streak+bb' };
  if (streakBear && bbBear) return { direction: 'BEAR', reason: 'streak+bb' };
  // Moderate: either
  if (bbBull) return { direction: 'BULL', reason: 'bb_only' };
  if (bbBear) return { direction: 'BEAR', reason: 'bb_only' };
  if (streakBull) return { direction: 'BULL', reason: 'streak_only' };
  if (streakBear) return { direction: 'BEAR', reason: 'streak_only' };
  return null;
}

// ─── GBDT implementation (reused from markovChain.ts) ─────────────────────────
interface GBNode { featureIdx?: number; threshold?: number; left?: GBNode; right?: GBNode; value?: number }

function buildRegTree(X: number[][], residuals: number[], depth: number, maxDepth: number, minLeaf: number): GBNode {
  if (depth >= maxDepth || X.length < minLeaf * 2) {
    return { value: residuals.reduce((a, b) => a + b, 0) / (residuals.length || 1) };
  }
  const nF = X[0].length;
  let bestGain = 0, bestFi = -1, bestThr = 0;
  const totalMSE = varFunc(residuals) * residuals.length;

  for (let fi = 0; fi < nF; fi++) {
    const vals = X.map((x, i) => ({ v: x[fi], r: residuals[i] })).sort((a, b) => a.v - b.v);
    const step = Math.max(1, Math.floor(vals.length / 15));
    for (let k = step; k < vals.length - step; k += step) {
      const thr = (vals[k - 1].v + vals[k].v) / 2;
      const L = vals.slice(0, k).map(x => x.r);
      const R = vals.slice(k).map(x => x.r);
      if (L.length < minLeaf || R.length < minLeaf) continue;
      const gain = totalMSE - varFunc(L) * L.length - varFunc(R) * R.length;
      if (gain > bestGain) { bestGain = gain; bestFi = fi; bestThr = thr; }
    }
  }

  if (bestFi < 0) return { value: residuals.reduce((a, b) => a + b, 0) / residuals.length };

  const leftIdx = X.map((_, i) => i).filter(i => X[i][bestFi] <= bestThr);
  const rightIdx = X.map((_, i) => i).filter(i => X[i][bestFi] > bestThr);
  return {
    featureIdx: bestFi, threshold: bestThr,
    left: buildRegTree(leftIdx.map(i => X[i]), leftIdx.map(i => residuals[i]), depth + 1, maxDepth, minLeaf),
    right: buildRegTree(rightIdx.map(i => X[i]), rightIdx.map(i => residuals[i]), depth + 1, maxDepth, minLeaf),
  };
}

function varFunc(arr: number[]): number {
  if (!arr.length) return 0;
  const m = arr.reduce((a, b) => a + b) / arr.length;
  return arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
}

function predictRegTree(node: GBNode, x: number[]): number {
  if (node.value !== undefined) return node.value;
  return x[node.featureIdx!] <= node.threshold!
    ? predictRegTree(node.left!, x)
    : predictRegTree(node.right!, x);
}

class GBDT {
  trees: GBNode[] = [];
  lr: number; nTrees: number; maxDepth: number;
  initialPred = 0;
  constructor(nTrees = 30, lr = 0.1, maxDepth = 4) {
    this.nTrees = nTrees; this.lr = lr; this.maxDepth = maxDepth;
  }
  train(X: number[][], y: number[]): void {
    const p0 = y.reduce((a, b) => a + b) / y.length;
    this.initialPred = Math.log(p0 / (1 - p0 + 1e-10));
    const preds = new Array(y.length).fill(this.initialPred);
    for (let t = 0; t < this.nTrees; t++) {
      const probas = preds.map(p => 1 / (1 + Math.exp(-p)));
      const residuals = y.map((yi, i) => yi - probas[i]);
      const tree = buildRegTree(X, residuals, 0, this.maxDepth, 15);
      this.trees.push(tree);
      for (let i = 0; i < y.length; i++) preds[i] += this.lr * predictRegTree(tree, X[i]);
    }
  }
  predict(x: number[]): number {
    let p = this.initialPred;
    for (const tree of this.trees) p += this.lr * predictRegTree(tree, x);
    return 1 / (1 + Math.exp(-p));
  }
}

// ─── Feature vector for signal candidates ────────────────────────────────────
// When we have a signal, extract rich features about WHY the signal fired
interface SignalSample {
  features: number[];
  label: number; // 1 = signal was correct, 0 = signal was wrong
}

function extractSignalFeatures(
  candles: DbCandle[], i: number,
  signal: SignalResult
): number[] {
  const c = candles[i];
  const closes = candles.slice(Math.max(0, i - 30), i + 1).map(x => x.close);
  const vols = candles.slice(Math.max(0, i - 20), i + 1).map(x => x.volume);

  const bb2 = getBB(candles, i, 20, 2)!;
  const bb15 = getBB(candles, i, 20, 1.5);
  const bb25 = getBB(candles, i, 20, 2.5);
  const rsi14 = calcRSI(closes.slice(-16), 14);
  const rsi7 = calcRSI(closes.slice(-9), 7);
  const atr = calcATR(candles.slice(Math.max(0, i - 15), i + 1));

  const streak = getStreak(candles, i);
  const pattern5 = getPattern(candles, i, 5);

  // Body/ATR quality
  const bodySize = Math.abs(c.close - c.open);
  const bodyATR = atr > 0 ? bodySize / atr : 0;

  // Price deviation from BB
  const bbPctB = bb2 ? bb2.pctB : 0.5;
  const aboveUpper2 = bb2 ? (c.close > bb2.upper ? (c.close - bb2.upper) / bb2.std : 0) : 0;
  const belowLower2 = bb2 ? (c.close < bb2.lower ? (bb2.lower - c.close) / bb2.std : 0) : 0;
  const bbDeviation = aboveUpper2 + belowLower2; // how far outside BB

  // Volume features
  const avgVol = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const volRatio = avgVol > 0 ? c.volume / avgVol : 1;

  // Candle shape
  const hlRange = c.high - c.low;
  const upperWick = hlRange > 0 ? (c.high - Math.max(c.open, c.close)) / hlRange : 0;
  const lowerWick = hlRange > 0 ? (Math.min(c.open, c.close) - c.low) / hlRange : 0;

  // Markov pattern encoded as integers
  const p4 = pattern5.slice(0, 4);
  const nGreens4 = (p4.match(/G/g) || []).length;
  const isRRRR = p4 === 'RRRR' ? 1 : 0;
  const isGGGG = p4 === 'GGGG' ? 1 : 0;

  const hour = new Date(c.open_time).getUTCHours();
  const dow = new Date(c.open_time).getUTCDay();

  // Signal direction context (normalize to "bullish side")
  // For BULL signals: high RSI = bad, high pctB = bad (price already up)
  // For BEAR signals: low RSI = bad, low pctB = bad (price already down)
  const dirMult = signal.direction === 'BULL' ? 1 : -1;
  const rsiNorm = signal.direction === 'BULL' ? (50 - rsi14) / 50 : (rsi14 - 50) / 50;
  const streakMag = Math.abs(streak);

  // is streak+bb combo (stronger signal)
  const isCombo = signal.reason === 'streak+bb' ? 1 : 0;
  const isStreakOnly = signal.reason === 'streak_only' ? 1 : 0;
  const isBBOnly = signal.reason === 'bb_only' ? 1 : 0;

  return [
    // Streak features
    streakMag / 5,                          // streak length (normalized)
    Math.min(1, streakMag / 3),             // streak ≥ 3?
    isCombo,                                // streak+BB combo
    isStreakOnly,
    isBBOnly,

    // BB features (always from signal's perspective)
    bbDeviation,                            // how far outside BB
    Math.abs(bbPctB - 0.5) * 2,            // distance from midpoint
    bbPctB,                                 // raw pctB

    // Alternative BB bandwidths
    bb15 ? (signal.direction === 'BULL' ? (bb15.lower - c.close) / (bb15.std || 1) : (c.close - bb15.upper) / (bb15.std || 1)) : 0,
    bb25 ? (signal.direction === 'BULL' ? (bb25.lower - c.close) / (bb25.std || 1) : (c.close - bb25.upper) / (bb25.std || 1)) : 0,

    // RSI (from signal's perspective)
    rsiNorm,
    rsi14 / 100,
    rsi7 / 100,

    // Candle quality
    Math.min(2, bodyATR),                   // body/ATR quality
    Math.min(1, bodySize / (c.close || 1) * 100), // body %

    // Volume
    Math.min(3, volRatio),                  // volume spike

    // Candle shape
    upperWick,
    lowerWick,

    // Markov features
    nGreens4 / 4,                           // ratio of greens in last 4
    isRRRR,
    isGGGG,
    dirMult * (nGreens4 / 4 - 0.5),        // alignment: BULL signal + many reds = good

    // Time features
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * dow / 7),
    Math.cos(2 * Math.PI * dow / 7),
    hour >= 0 && hour < 8 ? 1 : 0,         // asian
    hour >= 8 && hour < 16 ? 1 : 0,        // european
    hour === 14 ? 1 : 0,                    // bad hour (14 UTC)
    hour === 16 || hour === 5 ? 1 : 0,     // good hours

    // Body vs SMA
    (c.close - (bb2?.mid ?? c.close)) / (c.close || 1) * 100 * dirMult,

    1, // bias
  ];
}

// ─── Part 1: Markov Pattern Strategies ───────────────────────────────────────
const MARKOV_PATTERNS: Array<{ pattern: string; bet: 'BULL' | 'BEAR'; desc: string }> = [
  { pattern: 'RRRR', bet: 'BULL', desc: '4 reds → bet green' },
  { pattern: 'GGGG', bet: 'BEAR', desc: '4 greens → bet red' },
  { pattern: 'GRRRR', bet: 'BULL', desc: '4 reds after green → bet green' },
  { pattern: 'GGGGG', bet: 'BEAR', desc: '5 greens → bet red' },
  { pattern: 'RRRRR', bet: 'BULL', desc: '5 reds → bet green' },
  { pattern: 'RRR', bet: 'BULL', desc: '3 reds → bet green' },
  { pattern: 'GGG', bet: 'BEAR', desc: '3 greens → bet red' },
  { pattern: 'GGRGG', bet: 'BEAR', desc: 'GGRGG → bet red (15m pattern)' },
  { pattern: 'RGGRG', bet: 'BULL', desc: 'RGGRG → bet green (15m pattern)' },
];

function testMarkovPattern(
  candles: DbCandle[],
  pattern: string,
  bet: 'BULL' | 'BEAR',
  startIdx: number,
  endIdx: number
): { wins: number; total: number; pnl: number } {
  let wins = 0, total = 0;
  const len = pattern.length;
  for (let i = startIdx + len; i < endIdx - 1; i++) {
    const p = getPattern(candles, i, len);
    if (p !== pattern) continue;
    const nextGreen = isGreen(candles[i + 1]);
    const win = (bet === 'BULL') ? nextGreen : !nextGreen;
    wins += win ? 1 : 0;
    total++;
  }
  return { wins, total, pnl: wins * BET - (total - wins) * BET };
}

// ─── Part 2: Markov + BB combined ────────────────────────────────────────────
function testMarkovBBCombined(
  candles: DbCandle[],
  pattern: string,
  bet: 'BULL' | 'BEAR',
  bbMult: number,
  startIdx: number,
  endIdx: number
): { wins: number; total: number; pnl: number } {
  let wins = 0, total = 0;
  const len = pattern.length;
  for (let i = startIdx + Math.max(len, 20); i < endIdx - 1; i++) {
    const p = getPattern(candles, i, len);
    if (p !== pattern) continue;
    const bb = getBB(candles, i, 20, bbMult);
    if (!bb) continue;
    const c = candles[i];
    const bbBull = c.close < bb.lower;
    const bbBear = c.close > bb.upper;
    // Require BB to confirm streak direction
    if (bet === 'BULL' && !bbBull) continue;
    if (bet === 'BEAR' && !bbBear) continue;
    const nextGreen = isGreen(candles[i + 1]);
    const win = (bet === 'BULL') ? nextGreen : !nextGreen;
    wins += win ? 1 : 0;
    total++;
  }
  return { wins, total, pnl: wins * BET - (total - wins) * BET };
}

// ─── Part 3: GBDT signal filter ───────────────────────────────────────────────
function buildSignalSamples(
  candles: DbCandle[],
  startIdx: number,
  endIdx: number,
  streakLen = 3,
  bbMult = 2
): SignalSample[] {
  const samples: SignalSample[] = [];
  for (let i = startIdx; i < endIdx - 1; i++) {
    const sig = getStreakBBSignal(candles, i, streakLen, bbMult);
    if (!sig) continue;
    const features = extractSignalFeatures(candles, i, sig);
    const nextGreen = isGreen(candles[i + 1]);
    const label = (sig.direction === 'BULL') ? (nextGreen ? 1 : 0) : (!nextGreen ? 1 : 0);
    samples.push({ features, label });
  }
  return samples;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 GBDT SIGNAL FILTER + MARKOV PATTERN STRATEGIES');
console.log('══════════════════════════════════════════════════════════════');
console.log('Strategy: GBDT trained ONLY on streak+BB signal candidates\n');

const COINS_TFS: Array<{ coin: string; tf: string }> = [
  { coin: 'ETH', tf: '5m' },
  { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' },
  { coin: 'SOL', tf: '15m' },
];

// === PART 1: Pure Markov Pattern Strategies ===
console.log('══════════════════════════════════════════════════════════════');
console.log('📌 PART 1: MARKOV PATTERN STRATEGIES (train→test validation)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Pattern   Bet    Coin/TF    TrainWR   TestWR   TestT   PnL      Flag');

const markovSummary: Array<{
  pattern: string; bet: string; coin: string; tf: string;
  trainWR: number; testWR: number; testT: number; pnl: number
}> = [];

for (const { coin, tf } of COINS_TFS) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  for (const { pattern, bet, desc } of MARKOV_PATTERNS) {
    if (pattern.length > 4 && tf === '5m') continue; // skip rare patterns on 5m except for known ones
    const train = testMarkovPattern(allC, pattern, bet, 0, splitIdx);
    const test = testMarkovPattern(allC, pattern, bet, splitIdx, allC.length);
    if (test.total < 30) continue;
    const trainWR = train.total ? train.wins / train.total : 0;
    const testWR = test.total ? test.wins / test.total : 0;
    const flag = testWR >= 0.60 ? '⭐⭐' : testWR >= 0.57 ? '⭐' : testWR < 0.50 ? '❌' : '';
    console.log(`${pattern.padEnd(9)} ${bet.padEnd(6)} ${coin}/${tf.padEnd(3)}   ${(trainWR*100).toFixed(1).padStart(5)}%   ${(testWR*100).toFixed(1).padStart(5)}%   ${test.total.toString().padStart(4)}  $${test.pnl.toString().padStart(5)}  ${flag}`);
    markovSummary.push({ pattern, bet, coin, tf, trainWR, testWR, testT: test.total, pnl: test.pnl });
  }
}

// === PART 2: Markov + BB combined ===
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📌 PART 2: MARKOV PATTERN + BB COMBINED (does BB confirm boost WR?)');
console.log('══════════════════════════════════════════════════════════════');

const bbMults = [1.5, 2.0, 2.5];
const testCombos: Array<{ pattern: string; bet: 'BULL' | 'BEAR'; bbMult: number; coin: string; tf: string }> = [
  { pattern: 'RRRR', bet: 'BULL', bbMult: 2.0, coin: 'ETH', tf: '5m' },
  { pattern: 'GGGG', bet: 'BEAR', bbMult: 2.0, coin: 'ETH', tf: '5m' },
  { pattern: 'RRRR', bet: 'BULL', bbMult: 1.5, coin: 'ETH', tf: '5m' },
  { pattern: 'RRR', bet: 'BULL', bbMult: 2.0, coin: 'ETH', tf: '5m' },
  { pattern: 'GGG', bet: 'BEAR', bbMult: 2.0, coin: 'ETH', tf: '5m' },
  { pattern: 'RRR', bet: 'BULL', bbMult: 2.0, coin: 'ETH', tf: '15m' },
  { pattern: 'GGG', bet: 'BEAR', bbMult: 2.0, coin: 'ETH', tf: '15m' },
  { pattern: 'RRRR', bet: 'BULL', bbMult: 2.0, coin: 'ETH', tf: '15m' },
  { pattern: 'RRRR', bet: 'BULL', bbMult: 2.0, coin: 'BTC', tf: '15m' },
  { pattern: 'GGGG', bet: 'BEAR', bbMult: 2.0, coin: 'BTC', tf: '15m' },
];

console.log('Combo                             TrainWR  TestWR  T     PnL     Flag');
for (const { pattern, bet, bbMult, coin, tf } of testCombos) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Baseline (pattern only)
  const baseTest = testMarkovPattern(allC, pattern, bet, splitIdx, allC.length);
  // With BB filter
  const comboTrain = testMarkovBBCombined(allC, pattern, bet, bbMult, 0, splitIdx);
  const comboTest = testMarkovBBCombined(allC, pattern, bet, bbMult, splitIdx, allC.length);
  if (comboTest.total < 15) continue;

  const trainWR = comboTrain.total ? comboTrain.wins / comboTrain.total : 0;
  const testWR = comboTest.total ? comboTest.wins / comboTest.total : 0;
  const baseWR = baseTest.total ? baseTest.wins / baseTest.total : 0;
  const delta = (testWR - baseWR) * 100;
  const label = `${pattern}+BB(${bbMult}) ${bet} ${coin}/${tf}`;
  const flag = testWR >= 0.65 ? '⭐⭐' : testWR >= 0.60 ? '⭐' : testWR < 0.50 ? '❌' : '';
  console.log(`${label.padEnd(33)} ${(trainWR*100).toFixed(1).padStart(5)}%  ${(testWR*100).toFixed(1).padStart(5)}%  ${comboTest.total.toString().padStart(4)}  $${comboTest.pnl.toString().padStart(5)}  ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%  ${flag}`);
}

// === PART 3: GBDT trained on signal candidates ===
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🤖 PART 3: GBDT ON SIGNAL CANDIDATES (not all candles)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Hypothesis: GBDT trained only on streak+BB candidates → higher WR\n');

interface GBDTResult {
  coin: string; tf: string; streakLen: number; bbMult: number;
  rawWR: number; rawT: number;
  gbdtWR: number; gbdtT: number; gbdtPnl: number; thr: number;
}
const gbdtResults: GBDTResult[] = [];

const configs = [
  { coin: 'ETH', tf: '5m', streakLen: 3, bbMult: 2.0 },
  { coin: 'ETH', tf: '5m', streakLen: 3, bbMult: 1.5 },
  { coin: 'ETH', tf: '15m', streakLen: 3, bbMult: 2.0 },
  { coin: 'BTC', tf: '15m', streakLen: 3, bbMult: 2.0 },
  { coin: 'SOL', tf: '15m', streakLen: 3, bbMult: 2.0 },
];

for (const { coin, tf, streakLen, bbMult } of configs) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  const trainSamples = buildSignalSamples(allC, 30, splitIdx, streakLen, bbMult);
  const testSamples = buildSignalSamples(allC, splitIdx, allC.length - 1, streakLen, bbMult);

  if (trainSamples.length < 100 || testSamples.length < 30) {
    console.log(`  ${coin}/${tf}: insufficient signal candidates (train=${trainSamples.length}, test=${testSamples.length})`);
    continue;
  }

  // Raw signal WR (without GBDT filter)
  const rawWR = testSamples.filter(s => s.label === 1).length / testSamples.length;

  console.log(`\n  ${coin}/${tf} Streak(${streakLen})+BB(${bbMult}):`);
  console.log(`    Raw signal: WR=${(rawWR*100).toFixed(2)}% T=${testSamples.length}`);
  console.log(`    Training GBDT on ${trainSamples.length} signal candidates...`);

  const gbdt = new GBDT(50, 0.08, 5);
  gbdt.train(trainSamples.map(s => s.features), trainSamples.map(s => s.label));

  console.log('    Threshold sweep:');
  let best: GBDTResult = { coin, tf, streakLen, bbMult, rawWR, rawT: testSamples.length, gbdtWR: 0, gbdtT: 0, gbdtPnl: 0, thr: 0.5 };

  for (const thr of [0.50, 0.52, 0.54, 0.55, 0.56, 0.57, 0.58, 0.60, 0.62, 0.65]) {
    const filtered = testSamples.filter(s => gbdt.predict(s.features) >= thr);
    if (filtered.length < 20) break;
    const wins = filtered.filter(s => s.label === 1).length;
    const total = filtered.length;
    const wr = wins / total;
    const pnl = wins * BET - (total - wins) * BET;
    const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
    console.log(`      thr=${thr.toFixed(2)}: WR=${(wr*100).toFixed(2)}% T=${total} PnL=$${pnl}${flag}`);
    if (wr > best.gbdtWR && total >= 25) best = { ...best, gbdtWR: wr, gbdtT: total, gbdtPnl: pnl, thr };
  }
  gbdtResults.push(best);

  const improvement = (best.gbdtWR - rawWR) * 100;
  console.log(`    Best: WR=${(best.gbdtWR*100).toFixed(2)}% T=${best.gbdtT} thr=${best.thr} (${improvement >= 0 ? '+' : ''}${improvement.toFixed(1)}% vs raw)`);
}

// === PART 4: Best strategy portfolio ===
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 PART 4: BEST STRATEGY PORTFOLIO SUMMARY');
console.log('══════════════════════════════════════════════════════════════');

// Test the best configs from all research in a unified portfolio
const portfolioConfigs: Array<{
  name: string; coin: string; tf: string;
  fn: (candles: DbCandle[], i: number, splitIdx: number, endIdx: number) => { wins: number; total: number }
}> = [];

// BB(20,2)+RSI65 on ETH/5m
function bbRSI65(candles: DbCandle[], i: number): boolean {
  if (i < 25) return false;
  const bb = getBB(candles, i, 20, 2);
  if (!bb) return false;
  const closes = candles.slice(i - 16, i + 1).map(c => c.close);
  const rsi = calcRSI(closes, 14);
  return (candles[i].close > bb.upper && rsi >= 65) || (candles[i].close < bb.lower && rsi <= 35);
}

// All coins: streak(3)+BB(20,2) no time filter
// All coins: streak(3)+BB(20,2) with time filter (skip 14UTC)
const unifiedCoins: Array<{ coin: string; tf: string }> = [
  { coin: 'ETH', tf: '5m' },
  { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' },
  { coin: 'SOL', tf: '15m' },
];

console.log('\n  Strategy                        Coin/TF    WR       T      PnL');

type ResultRow = { name: string; coinTf: string; wr: number; total: number; pnl: number };
const allResults: ResultRow[] = [];

for (const { coin, tf } of unifiedCoins) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // A) Streak(3)+BB(20,2) baseline
  {
    let wins = 0, total = 0;
    for (let i = splitIdx + 30; i < allC.length - 1; i++) {
      const sig = getStreakBBSignal(allC, i, 3, 2.0);
      if (!sig) continue;
      const nextGreen = isGreen(allC[i + 1]);
      const win = sig.direction === 'BULL' ? nextGreen : !nextGreen;
      wins += win ? 1 : 0; total++;
    }
    const wr = total ? wins / total : 0;
    const pnl = wins * BET - (total - wins) * BET;
    allResults.push({ name: 'Streak(3)+BB(2)', coinTf: `${coin}/${tf}`, wr, total, pnl });
  }

  // B) Streak(3)+BB(20,2)+skip14UTC
  {
    let wins = 0, total = 0;
    for (let i = splitIdx + 30; i < allC.length - 1; i++) {
      const hour = new Date(allC[i].open_time).getUTCHours();
      if (hour === 14) continue;
      const sig = getStreakBBSignal(allC, i, 3, 2.0);
      if (!sig) continue;
      const nextGreen = isGreen(allC[i + 1]);
      const win = sig.direction === 'BULL' ? nextGreen : !nextGreen;
      wins += win ? 1 : 0; total++;
    }
    const wr = total ? wins / total : 0;
    const pnl = wins * BET - (total - wins) * BET;
    allResults.push({ name: 'Streak(3)+BB(2)+skip14', coinTf: `${coin}/${tf}`, wr, total, pnl });
  }

  // C) Streak(3)+BB(20,2)+bodyATR≥0.9
  {
    let wins = 0, total = 0;
    for (let i = splitIdx + 30; i < allC.length - 1; i++) {
      const sig = getStreakBBSignal(allC, i, 3, 2.0);
      if (!sig) continue;
      const atr = calcATR(allC.slice(Math.max(0, i - 15), i + 1));
      const bodySize = Math.abs(allC[i].close - allC[i].open);
      if (atr > 0 && bodySize / atr < 0.9) continue;
      const nextGreen = isGreen(allC[i + 1]);
      const win = sig.direction === 'BULL' ? nextGreen : !nextGreen;
      wins += win ? 1 : 0; total++;
    }
    const wr = total ? wins / total : 0;
    const pnl = wins * BET - (total - wins) * BET;
    allResults.push({ name: 'Streak(3)+BB(2)+bodyATR', coinTf: `${coin}/${tf}`, wr, total, pnl });
  }

  // D) Streak(3)+BB(20,2)+RSI65+bodyATR+skip14
  {
    let wins = 0, total = 0;
    for (let i = splitIdx + 30; i < allC.length - 1; i++) {
      const hour = new Date(allC[i].open_time).getUTCHours();
      if (hour === 14) continue;
      const sig = getStreakBBSignal(allC, i, 3, 2.0);
      if (!sig) continue;
      const atr = calcATR(allC.slice(Math.max(0, i - 15), i + 1));
      const bodySize = Math.abs(allC[i].close - allC[i].open);
      if (atr > 0 && bodySize / atr < 0.8) continue;
      const closes = allC.slice(Math.max(0, i - 16), i + 1).map(c => c.close);
      const rsi = calcRSI(closes, 14);
      if (sig.direction === 'BULL' && rsi > 40) continue;
      if (sig.direction === 'BEAR' && rsi < 60) continue;
      const nextGreen = isGreen(allC[i + 1]);
      const win = sig.direction === 'BULL' ? nextGreen : !nextGreen;
      wins += win ? 1 : 0; total++;
    }
    const wr = total ? wins / total : 0;
    const pnl = wins * BET - (total - wins) * BET;
    allResults.push({ name: 'FullFilter(BB+RSI+ATR+t)', coinTf: `${coin}/${tf}`, wr, total, pnl });
  }
}

allResults.sort((a, b) => b.wr - a.wr);

for (const r of allResults) {
  if (r.total < 30) continue;
  const flag = r.wr >= 0.65 ? ' ⭐⭐' : r.wr >= 0.60 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
  console.log(`  ${r.name.padEnd(31)} ${r.coinTf.padEnd(8)} ${(r.wr*100).toFixed(2).padStart(6)}% ${r.total.toString().padStart(5)} $${r.pnl.toString().padStart(6)}${flag}`);
}

// Portfolio totals
console.log('\n  ── COMBINED PORTFOLIO (all coins, best per strategy) ──');
for (const stratName of ['Streak(3)+BB(2)', 'Streak(3)+BB(2)+skip14', 'Streak(3)+BB(2)+bodyATR', 'FullFilter(BB+RSI+ATR+t)']) {
  const rows = allResults.filter(r => r.name === stratName);
  const totalTrades = rows.reduce((s, r) => s + r.total, 0);
  const totalWins = rows.reduce((s, r) => s + Math.round(r.wr * r.total), 0);
  const totalPnl = rows.reduce((s, r) => s + r.pnl, 0);
  const portWR = totalTrades ? totalWins / totalTrades : 0;
  console.log(`  ${stratName.padEnd(31)} ALL      ${(portWR*100).toFixed(2).padStart(6)}% ${totalTrades.toString().padStart(5)} $${totalPnl.toString().padStart(6)}`);
}

// === Summary ===
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📋 KEY FINDINGS SUMMARY');
console.log('══════════════════════════════════════════════════════════════');

const topMarkov = markovSummary.filter(m => m.testWR >= 0.57 && m.testT >= 50)
  .sort((a, b) => b.testWR - a.testWR).slice(0, 5);
console.log('\nTop Markov patterns:');
for (const m of topMarkov) {
  console.log(`  ${m.pattern} → ${m.bet} | ${m.coin}/${m.tf} | TestWR=${(m.testWR*100).toFixed(1)}% T=${m.testT}`);
}

console.log('\nGBDT filter results:');
for (const g of gbdtResults) {
  const imp = (g.gbdtWR - g.rawWR) * 100;
  console.log(`  ${g.coin}/${g.tf}: Raw=${(g.rawWR*100).toFixed(1)}% → GBDT=${(g.gbdtWR*100).toFixed(1)}% (${imp >= 0 ? '+' : ''}${imp.toFixed(1)}%) T=${g.gbdtT} thr=${g.thr}`);
}

// Save
const output = {
  timestamp: Date.now(),
  markovPatterns: markovSummary,
  gbdtFilter: gbdtResults,
};
fs.writeFileSync(path.join(RESEARCH_DIR, 'gbdt-filter.json'), JSON.stringify(output, null, 2));
console.log('\n✅ Saved to docs/backtest-research/gbdt-filter.json');
