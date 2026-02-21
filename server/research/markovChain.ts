/**
 * Markov Chain Candle Transition Analysis
 *
 * Fundamental question: What are the actual transition probabilities?
 *  - P(next=GREEN | prev=GREEN)?
 *  - P(next=GREEN | prev=RED)?
 *  - P(next=GREEN | last3=GGG)?
 *  - And so on for all patterns up to length 5
 *
 * Also tests: multi-timeframe signal voting
 * Also tests: gradient-boosted decision trees (GBDT)
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/markovChain.ts
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

// ─── Part 1: Markov Chain Transition Matrix ───────────────────────────────────
// Map all N-candle patterns → P(next=green)
function buildTransitionMatrix(candles: DbCandle[], patternLen: number): Map<string, { total: number; greens: number; wr: number }> {
  const matrix = new Map<string, { total: number; greens: number }>();
  for (let i = patternLen; i < candles.length - 1; i++) {
    const pattern = candles.slice(i - patternLen, i).map(c => isGreen(c) ? 'G' : 'R').join('');
    const nextGreen = isGreen(candles[i + 1]);
    if (!matrix.has(pattern)) matrix.set(pattern, { total: 0, greens: 0 });
    const entry = matrix.get(pattern)!;
    entry.total++;
    if (nextGreen) entry.greens++;
  }
  const result = new Map<string, { total: number; greens: number; wr: number }>();
  for (const [k, v] of matrix) {
    result.set(k, { total: v.total, greens: v.greens, wr: v.greens / v.total });
  }
  return result;
}

// ─── Part 2: Multi-Timeframe Voting ─────────────────────────────────────────
function calcSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  return closes.slice(-period).reduce((a, b) => a + b) / period;
}
function calcStdDev(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
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
    if (changes[i] > 0) { avgGain = (avgGain * (period - 1) + changes[i]) / period; avgLoss = (avgLoss * (period - 1)) / period; }
    else { avgGain = (avgGain * (period - 1)) / period; avgLoss = (avgLoss * (period - 1) - changes[i]) / period; }
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

// Get mean-reversion signal from a candle array at position i
function getMRSignal(candles: DbCandle[], i: number, streakLen: number, bbMult: number): 'BEAR' | 'BULL' | null {
  if (i < 25) return null;
  const c = candles[i];
  const closes = candles.slice(i - 25, i + 1).map(x => x.close);

  // BB signal
  const sma = calcSMA(closes, 20);
  const std = calcStdDev(closes, 20);
  const upper = sma + bbMult * std;
  const lower = sma - bbMult * std;
  let bbSig: 'BEAR' | 'BULL' | null = null;
  if (c.close > upper) bbSig = 'BEAR';
  else if (c.close < lower) bbSig = 'BULL';

  // Streak signal
  let green = 0, red = 0;
  for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
    const cj = candles[j];
    if (cj.close > cj.open) { if (red > 0) break; green++; }
    else if (cj.close < cj.open) { if (green > 0) break; red++; }
    else break;
  }
  let streakSig: 'BEAR' | 'BULL' | null = null;
  if (green >= streakLen) streakSig = 'BEAR';
  else if (red >= streakLen) streakSig = 'BULL';

  if (bbSig && streakSig && bbSig === streakSig) return bbSig;
  return bbSig ?? streakSig;
}

// ─── Part 3: GBDT (Gradient Boosted Decision Trees) ──────────────────────────
// Pure TypeScript implementation of gradient boosting with log-loss
// Each "booster" is a shallow regression tree
interface GBNode { featureIdx?: number; threshold?: number; left?: GBNode; right?: GBNode; value?: number }

function buildRegTree(X: number[][], residuals: number[], depth: number, maxDepth: number, minLeaf: number): GBNode {
  if (depth >= maxDepth || X.length < minLeaf * 2) {
    return { value: residuals.reduce((a, b) => a + b, 0) / residuals.length };
  }
  const nF = X[0].length;
  let bestGain = 0, bestFi = -1, bestThr = 0;
  const totalMSE = variance(residuals) * residuals.length;

  for (let fi = 0; fi < nF; fi++) {
    const vals = X.map((x, i) => ({ v: x[fi], r: residuals[i] })).sort((a, b) => a.v - b.v);
    const step = Math.max(1, Math.floor(vals.length / 15));
    for (let k = step; k < vals.length - step; k += step) {
      const thr = (vals[k - 1].v + vals[k].v) / 2;
      const L = vals.slice(0, k).map(x => x.r);
      const R = vals.slice(k).map(x => x.r);
      if (L.length < minLeaf || R.length < minLeaf) continue;
      const gain = totalMSE - variance(L) * L.length - variance(R) * R.length;
      if (gain > bestGain) { bestGain = gain; bestFi = fi; bestThr = thr; }
    }
  }

  if (bestFi < 0) return { value: residuals.reduce((a, b) => a + b, 0) / residuals.length };

  const leftIdx = X.map((x, i) => i).filter(i => X[i][bestFi] <= bestThr);
  const rightIdx = X.map((x, i) => i).filter(i => X[i][bestFi] > bestThr);
  return {
    featureIdx: bestFi, threshold: bestThr,
    left: buildRegTree(leftIdx.map(i => X[i]), leftIdx.map(i => residuals[i]), depth + 1, maxDepth, minLeaf),
    right: buildRegTree(rightIdx.map(i => X[i]), rightIdx.map(i => residuals[i]), depth + 1, maxDepth, minLeaf),
  };
}

function variance(arr: number[]): number {
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
  lr: number;
  nTrees: number;
  maxDepth: number;
  initialPred: number = 0;

  constructor(nTrees = 30, lr = 0.1, maxDepth = 4) {
    this.nTrees = nTrees;
    this.lr = lr;
    this.maxDepth = maxDepth;
  }

  train(X: number[][], y: number[]): void {
    const p0 = y.reduce((a, b) => a + b) / y.length;
    this.initialPred = Math.log(p0 / (1 - p0 + 1e-10));
    const preds = new Array(y.length).fill(this.initialPred);

    for (let t = 0; t < this.nTrees; t++) {
      // Compute negative gradient (pseudo-residuals for log-loss)
      const probas = preds.map(p => 1 / (1 + Math.exp(-p)));
      const residuals = y.map((yi, i) => yi - probas[i]);

      const tree = buildRegTree(X, residuals, 0, this.maxDepth, 20);
      this.trees.push(tree);

      for (let i = 0; i < y.length; i++) {
        preds[i] += this.lr * predictRegTree(tree, X[i]);
      }
    }
  }

  predict(x: number[]): number {
    let p = this.initialPred;
    for (const tree of this.trees) p += this.lr * predictRegTree(tree, x);
    return 1 / (1 + Math.exp(-p));
  }
}

// ─── Feature extraction for GBDT ─────────────────────────────────────────────
function extractFeatures(candles: DbCandle[], i: number): number[] | null {
  if (i < 30) return null;
  const c = candles[i];
  const closes = candles.slice(i - 30, i + 1).map(x => x.close);

  const sma20 = calcSMA(closes, 20);
  const std20 = calcStdDev(closes, 20);
  const rsi14 = calcRSI(closes.slice(-16), 14);
  const rsi7 = calcRSI(closes.slice(-9), 7);

  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
  const hlRange = c.high > c.low ? (c.high - c.low) / c.close * 100 : 0;

  const pctB = std20 > 0 ? (c.close - (sma20 - 2 * std20)) / (4 * std20) : 0.5;

  // Streak pattern as features
  let green = 0, red = 0;
  for (let j = i; j >= Math.max(0, i - 8); j--) {
    const cj = candles[j];
    if (cj.close > cj.open) { if (red > 0) break; green++; }
    else if (cj.close < cj.open) { if (green > 0) break; red++; }
    else break;
  }
  const streak = green > 0 ? green : -red;

  // Last 5 candle directions as bits
  const bits = Array.from({ length: 5 }, (_, k) => {
    const idx = i - k;
    return idx >= 0 ? (isGreen(candles[idx]) ? 1 : 0) : 0.5;
  });

  // Time features
  const hour = new Date(c.open_time).getUTCHours();
  const dow = new Date(c.open_time).getUTCDay();

  return [
    Math.max(-1, Math.min(1, streak / 5)),   // streak
    rsi14 / 100,                              // rsi14
    rsi7 / 100,                              // rsi7
    Math.max(0, Math.min(1.5, pctB)),        // BB position
    Math.max(-3, Math.min(3, bodyPct)) / 3,  // body %
    Math.min(1, hlRange / 2),               // HL range
    (c.close - sma20) / (sma20 || 1) * 20,  // price vs SMA
    ...bits,                                  // last 5 candle directions
    Math.sin(2 * Math.PI * hour / 24),      // hour_sin
    Math.cos(2 * Math.PI * hour / 24),      // hour_cos
    Math.sin(2 * Math.PI * dow / 7),        // dow_sin
    Math.cos(2 * Math.PI * dow / 7),        // dow_cos
    hour >= 0 && hour < 8 ? 1 : 0,          // is_asian
    hour >= 8 && hour < 16 ? 1 : 0,         // is_european
    1,                                        // bias
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const COINS_TFS: Array<{ coin: string; tf: string }> = [
  { coin: 'ETH', tf: '5m' },
  { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' },
  { coin: 'SOL', tf: '15m' },
];

console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔬 MARKOV CHAIN CANDLE TRANSITION ANALYSIS');
console.log('══════════════════════════════════════════════════════════════');

// Part 1: Markov chains
for (const { coin, tf } of COINS_TFS) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 200) continue;
  const splitIdx = Math.floor(allC.length * 0.7);
  const testC = allC.slice(splitIdx);

  console.log(`\n── ${coin}/${tf} (${testC.length} test candles) ──────────────────────────`);

  for (const len of [1, 2, 3, 4, 5]) {
    const matrix = buildTransitionMatrix(testC, len);
    const entries = [...matrix.entries()]
      .filter(([, v]) => v.total >= 20)
      .sort((a, b) => Math.abs(b[1].wr - 0.5) - Math.abs(a[1].wr - 0.5));

    if (len === 1) {
      // Show the base case
      const gg = matrix.get('G'); const rr = matrix.get('R');
      console.log(`  Lag-1: P(G|G)=${gg ? (gg.wr*100).toFixed(1)+'%' : 'n/a'} T=${gg?.total ?? 0} | P(G|R)=${rr ? (rr.wr*100).toFixed(1)+'%' : 'n/a'} T=${rr?.total ?? 0}`);
      const baseGreen = testC.slice(0, -1).filter((_, i) => isGreen(testC[i+1])).length / (testC.length - 1);
      console.log(`  Base rate P(G)=${(baseGreen*100).toFixed(1)}%`);
    }

    // Show most extreme patterns
    const extreme = entries.slice(0, 4);
    if (extreme.length > 0 && len >= 2) {
      console.log(`  Top patterns (len=${len}):`);
      for (const [pattern, data] of extreme) {
        const edge = (data.wr - 0.5) * 100;
        const bet = data.wr > 0.5 ? 'BULL' : 'BEAR';
        const flag = Math.abs(edge) >= 5 ? ' ⭐' : '';
        console.log(`    ${pattern} → ${bet} ${(data.wr*100).toFixed(1)}% (edge=${edge > 0 ? '+' : ''}${edge.toFixed(1)}%) T=${data.total}${flag}`);
      }
    }
  }
}

// Part 2: Multi-timeframe voting
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🎯 MULTI-TIMEFRAME SIGNAL VOTING');
console.log('══════════════════════════════════════════════════════════════');
console.log('Hypothesis: When 5m + 15m + 1h all agree → stronger signal\n');

for (const coin of ['ETH', 'BTC']) {
  console.log(`── ${coin} Multi-TF Voting ──────────────────────────────────────`);

  const c5m = queryCandles(coin, '5m');
  const c15m = queryCandles(coin, '15m');
  const c1h = queryCandles(coin, '1h');

  if (c5m.length < 500 || c15m.length < 200) continue;

  // Use test period only
  const splitMs = c5m[Math.floor(c5m.length * 0.7)].open_time;
  const test5m = c5m.filter(c => c.open_time >= splitMs);
  const test15m = c15m.filter(c => c.open_time >= splitMs);
  const test1h = c1h.filter(c => c.open_time >= splitMs);

  const tfMs: Record<string, number> = { '5m': 300000, '15m': 900000, '1h': 3600000 };

  // Build signal maps by time
  const sig15m = new Map<number, 'BEAR' | 'BULL'>();
  for (let i = 30; i < test15m.length - 1; i++) {
    const s = getMRSignal(test15m, i, 3, 2);
    if (s) sig15m.set(test15m[i].open_time, s);
  }

  const sig1h = new Map<number, 'BEAR' | 'BULL'>();
  for (let i = 30; i < test1h.length - 1; i++) {
    const s = getMRSignal(test1h, i, 3, 2);
    if (s) sig1h.set(test1h[i].open_time, s);
  }

  // Test 5m trades: require 5m signal + 15m agreement
  const results: Record<string, { wins: number; total: number }> = {
    '5m_only': { wins: 0, total: 0 },
    '5m_and_15m_agree': { wins: 0, total: 0 },
    '5m_and_1h_agree': { wins: 0, total: 0 },
    '5m_and_15m_and_1h_agree': { wins: 0, total: 0 },
  };

  for (let i = 30; i < test5m.length - 1; i++) {
    const t = test5m[i].open_time;
    const sig5 = getMRSignal(test5m, i, 3, 2);
    if (!sig5) continue;

    const nextUp = isGreen(test5m[i + 1]);
    const win = (sig5 === 'BEAR') ? !nextUp : nextUp;

    results['5m_only'].total++;
    if (win) results['5m_only'].wins++;

    // Find matching 15m candle (the 15m candle that contains this 5m timestamp)
    const t15 = Math.floor(t / tfMs['15m']) * tfMs['15m'];
    const s15 = sig15m.get(t15);
    if (s15 && s15 === sig5) {
      results['5m_and_15m_agree'].total++;
      if (win) results['5m_and_15m_agree'].wins++;
    }

    // Find matching 1h candle
    const t1h = Math.floor(t / tfMs['1h']) * tfMs['1h'];
    const s1h = sig1h.get(t1h);
    if (s1h && s1h === sig5) {
      results['5m_and_1h_agree'].total++;
      if (win) results['5m_and_1h_agree'].wins++;
    }

    if (s15 && s15 === sig5 && s1h && s1h === sig5) {
      results['5m_and_15m_and_1h_agree'].total++;
      if (win) results['5m_and_15m_and_1h_agree'].wins++;
    }
  }

  for (const [label, r] of Object.entries(results)) {
    const wr = r.total ? r.wins / r.total : 0;
    const pnl = r.wins * BET - (r.total - r.wins) * BET;
    const flag = wr >= 0.62 ? ' ⭐⭐' : wr >= 0.58 ? ' ⭐' : '';
    console.log(`  ${label.padEnd(32)} WR=${(wr*100).toFixed(2)}% T=${r.total} PnL=$${pnl}${flag}`);
  }
}

// Part 3: GBDT
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🤖 GRADIENT BOOSTED DECISION TREES (GBDT)');
console.log('══════════════════════════════════════════════════════════════');
console.log('30 trees, depth=4, lr=0.1 — proper gradient boosting\n');

const gbdtResults: Array<{ coin: string; tf: string; wr: number; trades: number; pnl: number; thr: number }> = [];

for (const { coin, tf } of [{ coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' }]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;

  const splitIdx = Math.floor(allC.length * 0.7);
  const trainC = allC.slice(0, splitIdx);
  const testC = allC.slice(splitIdx);

  // Build features
  const trainSamples: { X: number[]; y: number }[] = [];
  for (let i = 30; i < trainC.length - 1; i++) {
    const f = extractFeatures(trainC, i);
    if (!f) continue;
    const label = isGreen(trainC[i + 1]) ? 1 : 0;
    trainSamples.push({ X: f, y: label });
  }

  const testSamples: { X: number[]; y: number }[] = [];
  for (let i = 30; i < testC.length - 1; i++) {
    const f = extractFeatures(testC, i);
    if (!f) continue;
    const label = isGreen(testC[i + 1]) ? 1 : 0;
    testSamples.push({ X: f, y: label });
  }

  console.log(`  ${coin}/${tf}: Training on ${trainSamples.length} samples...`);

  const gbdt = new GBDT(30, 0.1, 4);
  gbdt.train(trainSamples.map(s => s.X), trainSamples.map(s => s.y));

  console.log('  Threshold sweep:');
  let best = { wr: 0, trades: 0, pnl: 0, wins: 0, thr: 0.5 };
  for (const thr of [0.50, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.60, 0.62]) {
    let wins = 0, total = 0;
    for (const s of testSamples) {
      const prob = gbdt.predict(s.X);
      if (prob >= thr) {
        if (s.y === 1) wins++;
        total++;
      } else if (prob <= 1 - thr) {
        if (s.y === 0) wins++;
        total++;
      }
    }
    const wr = total ? wins / total : 0;
    const pnl = wins * BET - (total - wins) * BET;
    if (total >= 50 && wr > best.wr) best = { wr, trades: total, pnl, wins, thr };
    if (total >= 30) console.log(`    thr=${thr.toFixed(2)}: WR=${(wr*100).toFixed(1)}% T=${total} PnL=$${pnl}`);
  }
  console.log(`  Best: WR=${(best.wr*100).toFixed(2)}% T=${best.trades} (thr=${best.thr})\n`);
  gbdtResults.push({ coin, tf, ...best });
}

// Part 4: Best patterns applied as trading rules
console.log('══════════════════════════════════════════════════════════════');
console.log('📌 SPECIFIC PATTERN RULES (best Markov patterns as strategies)');
console.log('══════════════════════════════════════════════════════════════\n');

for (const { coin, tf } of [{ coin: 'ETH', tf: '5m' }, { coin: 'ETH', tf: '15m' }]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 200) continue;
  const splitIdx = Math.floor(allC.length * 0.7);
  const trainC = allC.slice(0, splitIdx);
  const testC = allC.slice(splitIdx);

  // Find best patterns on TRAIN set, apply to TEST
  const patterns: Array<{ pattern: string; bet: 'BULL' | 'BEAR'; trainWR: number; trainN: number }> = [];
  for (const len of [2, 3, 4]) {
    const trainMatrix = buildTransitionMatrix(trainC, len);
    for (const [pattern, data] of trainMatrix) {
      if (data.total < 30) continue;
      if (data.wr >= 0.60) patterns.push({ pattern, bet: 'BULL', trainWR: data.wr, trainN: data.total });
      else if (data.wr <= 0.40) patterns.push({ pattern, bet: 'BEAR', trainWR: 1 - data.wr, trainN: data.total });
    }
  }

  // Sort by edge
  patterns.sort((a, b) => b.trainWR - a.trainWR);
  const topPatterns = patterns.slice(0, 8);

  console.log(`  ${coin}/${tf} — top patterns from TRAIN, tested on TEST:`);
  console.log(`  Pattern   Bet   Train WR   Test WR   Test Trades`);

  for (const p of topPatterns) {
    const testMatrix = buildTransitionMatrix(testC, p.pattern.length);
    const testData = testMatrix.get(p.pattern);
    const testWR = testData ? (p.bet === 'BULL' ? testData.wr : 1 - testData.wr) : null;
    const testN = testData?.total ?? 0;
    const flag = testWR !== null && testWR >= 0.60 ? ' ⭐' : testWR !== null && testWR < 0.50 ? ' ❌' : '';
    console.log(`  ${p.pattern.padEnd(9)} ${p.bet.padEnd(5)} ${(p.trainWR*100).toFixed(1).padStart(5)}%     ${testWR !== null ? (testWR*100).toFixed(1).padStart(5)+'%' : '  n/a'}     ${testN.toString().padStart(4)}${flag}`);
  }
  console.log('');
}

// Save
const output = { timestamp: Date.now(), gbdt: gbdtResults };
fs.writeFileSync(path.join(RESEARCH_DIR, 'markov-chain.json'), JSON.stringify(output, null, 2));
console.log('✅ Saved to docs/backtest-research/markov-chain.json');
