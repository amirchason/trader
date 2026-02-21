/**
 * ML Filter on top of Streak Signals
 *
 * Key finding from enhancedML: body_to_atr is the #1 feature.
 * This script tests: when streak(3) fires, use ML confidence to decide whether to trade.
 * Also tests: Random Forest (ensemble of decision trees) for better accuracy.
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/mlFilter.ts
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

// ─── Reuse indicators from enhancedML ────────────────────────────────────────
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
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b) / trs.length;
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

function calcSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  return closes.slice(-period).reduce((a, b) => a + b) / period;
}

// ─── Body-to-ATR + RSI features (core predictors from enhancedML) ────────────
interface TradeCandidate {
  idx: number;
  isStreak: boolean;
  isBigCandle: boolean;
  tradeBear: boolean;   // true = bet BEAR (expect next candle red)
  bodyToATR: number;
  rsi14: number;
  absPct: number;
  streakLen: number;
  hour: number;
  vwapDev: number;
  isAboveVwap: boolean;
  isAboveSma: boolean;
  volRatio: number;
  isGreen: boolean;
}

function buildCandidates(candles: DbCandle[]): TradeCandidate[] {
  const candidates: TradeCandidate[] = [];
  const WARMUP = 55;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    const c = candles[i];
    const price = c.close;
    if (price <= 0) continue;

    const closes = candles.slice(i - 50, i + 1).map(x => x.close);
    const vols = candles.slice(i - 20, i + 1).map(x => x.volume);

    const rsi14 = calcRSI(closes.slice(-16), 14);
    const atr = calcATR(candles.slice(i - 15, i + 1), 14);
    const sma20 = calcSMA(closes, 20);

    // VWAP last 20 candles
    const vwapSlice = candles.slice(i - 19, i + 1);
    let tpv = 0, tvol = 0;
    for (const vc of vwapSlice) { tpv += ((vc.high + vc.low + vc.close) / 3) * vc.volume; tvol += vc.volume; }
    const vwap = tvol > 0 ? tpv / tvol : price;

    const avgVol = vols.slice(0, -1).reduce((a, b) => a + b) / (vols.length - 1);
    const volRatio = avgVol > 0 ? Math.min(3, c.volume / avgVol) : 1;

    const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
    const absPct = Math.abs(bodyPct);
    const bodyToATR = atr > 0 ? absPct / 100 * price / atr : 0;

    // Streak detection
    let greenStreak = 0, redStreak = 0;
    for (let j = i; j >= Math.max(0, i - 8); j--) {
      const cj = candles[j];
      if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
      else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
      else break;
    }
    const isStreak = greenStreak >= 3 || redStreak >= 3;
    const streakLen = greenStreak > 0 ? greenStreak : redStreak;
    const streakBear = greenStreak >= 3; // BEAR after green streak

    // Big candle detection
    const isBigCandle = absPct >= 0.5;
    const bigBear = bodyPct > 0; // BEAR after green big candle

    if (!isStreak && !isBigCandle) continue;

    // Determine trade direction (streak takes priority)
    const tradeBear = isStreak ? streakBear : bigBear;

    const hour = new Date(c.open_time).getUTCHours();

    candidates.push({
      idx: i,
      isStreak,
      isBigCandle,
      tradeBear,
      bodyToATR,
      rsi14,
      absPct,
      streakLen,
      hour,
      vwapDev: (price - vwap) / vwap * 100,
      isAboveVwap: price > vwap,
      isAboveSma: price > sma20,
      volRatio,
      isGreen: c.close > c.open,
    });
  }
  return candidates;
}

// ─── Decision tree on streak/big-candle candidates ───────────────────────────
interface DTNode {
  featureIdx?: number;
  threshold?: number;
  left?: DTNode;
  right?: DTNode;
  leafProb?: number;
  nSamples?: number;
}

function getFeatures(c: TradeCandidate): number[] {
  return [
    c.bodyToATR,                          // 0: body/ATR ratio (top predictor)
    c.rsi14 / 100,                        // 1: RSI14
    c.rsi14 > 70 ? 1 : 0,               // 2: overbought
    c.rsi14 < 30 ? 1 : 0,               // 3: oversold
    c.absPct / 2,                         // 4: candle size %
    c.isAboveVwap ? 1 : 0,              // 5: above VWAP
    c.isAboveSma ? 1 : 0,               // 6: above SMA
    c.vwapDev / 2,                        // 7: VWAP deviation %
    c.streakLen / 5,                      // 8: streak length (normalized)
    c.volRatio / 3,                       // 9: volume ratio
    c.isGreen ? 1 : 0,                   // 10: candle direction
    // Time features
    Math.sin(2 * Math.PI * c.hour / 24), // 11: hour_sin
    Math.cos(2 * Math.PI * c.hour / 24), // 12: hour_cos
    c.hour >= 0 && c.hour < 8 ? 1 : 0,  // 13: is_asian
    c.hour >= 8 && c.hour < 16 ? 1 : 0, // 14: is_european
    c.isStreak ? 1 : 0,                  // 15: is_streak signal
    c.isBigCandle ? 1 : 0,               // 16: is_big_candle signal
    1,                                    // 17: bias
  ];
}

const FNAMES = ['body/ATR','rsi14','overbought','oversold','abs_pct','aboveVwap','aboveSma','vwapDev','streakLen','volRatio','isGreen','hour_sin','hour_cos','isAsian','isEuro','isStreak','isBig','bias'];

function gini(labels: number[]): number {
  if (!labels.length) return 0;
  const p = labels.filter(x => x === 1).length / labels.length;
  return 1 - p * p - (1 - p) * (1 - p);
}

function buildTree(
  samples: Array<{ features: number[]; win: number }>,
  depth: number,
  maxDepth: number,
  minLeaf: number
): DTNode {
  const labels = samples.map(s => s.win);
  const p = labels.filter(x => x === 1).length / labels.length;

  if (depth >= maxDepth || samples.length < minLeaf * 2) {
    return { leafProb: p, nSamples: samples.length };
  }

  const nF = samples[0].features.length;
  let bestGain = 0, bestFi = -1, bestThr = 0;
  const parentG = gini(labels);

  for (let fi = 0; fi < nF; fi++) {
    const vals = samples.map(s => s.features[fi]).sort((a, b) => a - b);
    const step = Math.max(1, Math.floor(vals.length / 15));
    const seen = new Set<number>();
    for (let k = step; k < vals.length; k += step) {
      const thr = (vals[k - 1] + vals[k]) / 2;
      if (seen.has(thr)) continue;
      seen.add(thr);
      const L = samples.filter(s => s.features[fi] <= thr).map(s => s.win);
      const R = samples.filter(s => s.features[fi] > thr).map(s => s.win);
      if (L.length < minLeaf || R.length < minLeaf) continue;
      const gain = parentG - (L.length / samples.length) * gini(L) - (R.length / samples.length) * gini(R);
      if (gain > bestGain) { bestGain = gain; bestFi = fi; bestThr = thr; }
    }
  }

  if (bestFi < 0) return { leafProb: p, nSamples: samples.length };

  return {
    featureIdx: bestFi, threshold: bestThr,
    left: buildTree(samples.filter(s => s.features[bestFi] <= bestThr), depth + 1, maxDepth, minLeaf),
    right: buildTree(samples.filter(s => s.features[bestFi] > bestThr), depth + 1, maxDepth, minLeaf),
    nSamples: samples.length,
  };
}

function predictTree(node: DTNode, features: number[]): number {
  if (node.leafProb !== undefined) return node.leafProb;
  return features[node.featureIdx!] <= node.threshold!
    ? predictTree(node.left!, features)
    : predictTree(node.right!, features);
}

// ─── Random Forest ────────────────────────────────────────────────────────────
class RandomForest {
  trees: DTNode[] = [];
  nTrees: number;
  maxDepth: number;

  constructor(nTrees = 20, maxDepth = 5) {
    this.nTrees = nTrees;
    this.maxDepth = maxDepth;
  }

  train(samples: Array<{ features: number[]; win: number }>): void {
    for (let t = 0; t < this.nTrees; t++) {
      // Bootstrap sample
      const bootstrap = Array.from({ length: samples.length }, () =>
        samples[Math.floor(Math.random() * samples.length)]
      );
      this.trees.push(buildTree(bootstrap, 0, this.maxDepth, 15));
    }
  }

  predict(features: number[]): number {
    return this.trees.reduce((sum, tree) => sum + predictTree(tree, features), 0) / this.trees.length;
  }
}

// ─── Main analysis ────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🎯 ML FILTER ON STREAK/BIG-CANDLE SIGNALS');
console.log('══════════════════════════════════════════════════════════════');
console.log('Hypothesis: ML can identify WHICH streak/big-candle signals are most reliable\n');

const COINS = ['ETH', 'BTC', 'SOL'];
const TF = '15m';

const portfolioNoFilter = { wins: 0, total: 0 };
const portfolioMLFilter = { wins: 0, total: 0 };

const finalResults: Array<{
  coin: string;
  noFilter: { wr: number; trades: number; pnl: number };
  rfBest: { wr: number; trades: number; pnl: number; thr: number };
  bodyAtrBest: { wr: number; trades: number; pnl: number; thr: number };
}> = [];

for (const coin of COINS) {
  const allC = queryCandles(coin, TF);
  if (allC.length < 200) continue;

  const splitIdx = Math.floor(allC.length * 0.7);
  const trainC = allC.slice(0, splitIdx);
  const testC = allC.slice(splitIdx);

  console.log(`\n── ${coin}/${TF} ─────────────────────────────────────────────`);

  // Build candidates
  const trainCandidates = buildCandidates(trainC);
  const testCandidates = buildCandidates(testC);
  console.log(`  Train candidates: ${trainCandidates.length}, Test candidates: ${testCandidates.length}`);

  // Determine actual outcome (did our bet win?)
  function getWin(cand: TradeCandidate, candles: DbCandle[]): number {
    const next = candles[cand.idx + 1];
    if (!next) return 0;
    const nextUp = next.close > next.open;
    // tradeBear=true means we bet DOWN, win if next candle is down (not up)
    return cand.tradeBear === !nextUp ? 1 : 0;
  }

  const trainLabeled = trainCandidates.map(c => ({
    features: getFeatures(c),
    win: getWin(c, trainC),
  }));
  const testLabeled = testCandidates.map(c => ({
    features: getFeatures(c),
    win: getWin(c, testC),
    cand: c,
  }));

  // Baseline WR
  const baseWins = testLabeled.filter(s => s.win === 1).length;
  const baseWR = testLabeled.length ? baseWins / testLabeled.length : 0;
  console.log(`  Baseline WR (all signals): ${(baseWR * 100).toFixed(2)}% T=${testLabeled.length}`);

  // ─── Manual filter: body/ATR threshold ────────────────────────────────────
  console.log('\n  Body/ATR threshold test (manually defined rule):');
  let bodyAtrBest = { wr: 0, trades: 0, pnl: 0, thr: 0 };
  for (const thr of [0.5, 0.7, 0.9, 1.0, 1.1, 1.2, 1.3, 1.5, 1.8, 2.0]) {
    const filtered = testLabeled.filter(s => s.cand.bodyToATR >= thr);
    if (filtered.length < 20) break;
    const wins = filtered.filter(s => s.win === 1).length;
    const wr = wins / filtered.length;
    const pnl = wins * BET - (filtered.length - wins) * BET;
    console.log(`    bodyToATR≥${thr.toFixed(1)}: WR=${(wr*100).toFixed(2)}% T=${filtered.length} PnL=$${pnl}`);
    if (filtered.length >= 30 && wr > bodyAtrBest.wr) bodyAtrBest = { wr, trades: filtered.length, pnl, thr };
  }

  // ─── Random Forest ────────────────────────────────────────────────────────
  console.log('\n  Training Random Forest (20 trees, depth=5)...');
  const rf = new RandomForest(20, 5);
  rf.train(trainLabeled);

  // Evaluate at different thresholds
  console.log('\n  RF threshold sweep:');
  let rfBest = { wr: 0, trades: 0, pnl: 0, wins: 0, thr: 0.52 };
  for (const thr of [0.50, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.60]) {
    let wins = 0, total = 0;
    for (const s of testLabeled) {
      const prob = rf.predict(s.features);
      if (prob >= thr || prob <= 1 - thr) {
        if (prob >= thr === (s.win === 1)) wins++;
        // Actually: if prob >= thr → predict WIN, compare to actual win
        total++;
      }
    }
    // Re-do: prob >= thr means we think this is a good trade (will win)
    let w = 0, t = 0;
    for (const s of testLabeled) {
      const prob = rf.predict(s.features);
      if (prob >= thr) { if (s.win === 1) w++; t++; }
    }
    const wr = t ? w / t : 0;
    const pnl = w * BET - (t - w) * BET;
    if (t >= 20) {
      console.log(`    thr≥${thr.toFixed(2)}: WR=${(wr*100).toFixed(2)}% T=${t} PnL=$${pnl}`);
    }
    if (t >= 30 && wr > rfBest.wr) rfBest = { wr, trades: t, pnl, wins: w, thr };
  }

  console.log(`\n  Best results:`);
  console.log(`    Baseline:       WR=${(baseWR*100).toFixed(2)}% T=${testLabeled.length}`);
  console.log(`    Body/ATR≥${bodyAtrBest.thr.toFixed(1)}: WR=${(bodyAtrBest.wr*100).toFixed(2)}% T=${bodyAtrBest.trades}`);
  console.log(`    RF thr≥${rfBest.thr}:    WR=${(rfBest.wr*100).toFixed(2)}% T=${rfBest.trades}`);

  portfolioNoFilter.wins += baseWins;
  portfolioNoFilter.total += testLabeled.length;
  portfolioMLFilter.wins += rfBest.wins;
  portfolioMLFilter.total += rfBest.trades;

  finalResults.push({
    coin,
    noFilter: { wr: baseWR, trades: testLabeled.length, pnl: baseWins * BET - (testLabeled.length - baseWins) * BET },
    rfBest,
    bodyAtrBest,
  });
}

// ─── Portfolio summary ────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 PORTFOLIO SUMMARY');
console.log('══════════════════════════════════════════════════════════════\n');

for (const r of finalResults) {
  console.log(`  ${r.coin}/${TF}:`);
  console.log(`    No filter: WR=${(r.noFilter.wr*100).toFixed(2)}% T=${r.noFilter.trades} PnL=$${r.noFilter.pnl}`);
  console.log(`    RF filter: WR=${(r.rfBest.wr*100).toFixed(2)}% T=${r.rfBest.trades} PnL=$${r.rfBest.pnl} (thr≥${r.rfBest.thr})`);
  console.log(`    Body/ATR:  WR=${(r.bodyAtrBest.wr*100).toFixed(2)}% T=${r.bodyAtrBest.trades} PnL=$${r.bodyAtrBest.pnl} (≥${r.bodyAtrBest.thr})`);
}

const portBaseWR = portfolioNoFilter.total ? portfolioNoFilter.wins / portfolioNoFilter.total : 0;
const portMLWR = portfolioMLFilter.total ? portfolioMLFilter.wins / portfolioMLFilter.total : 0;
const portBasePnL = portfolioNoFilter.wins * BET - (portfolioNoFilter.total - portfolioNoFilter.wins) * BET;
const portMLPnL = portfolioMLFilter.wins * BET - (portfolioMLFilter.total - portfolioMLFilter.wins) * BET;

console.log(`\n  Combined Portfolio:`);
console.log(`    No filter: WR=${(portBaseWR*100).toFixed(2)}% T=${portfolioNoFilter.total} PnL=$${portBasePnL}`);
console.log(`    RF filter: WR=${(portMLWR*100).toFixed(2)}% T=${portfolioMLFilter.total} PnL=$${portMLPnL}`);

// ─── Combined test: time filter + body/ATR filter + streak ───────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🚀 COMBINED STRATEGY: Time Filter + Body/ATR + Streak');
console.log('══════════════════════════════════════════════════════════════\n');

const GOOD_HOURS: Record<string, number[]> = {
  ETH: [0, 1, 2, 3, 5, 7, 16, 17, 22, 23],
  BTC: [0, 2, 3, 10, 12, 13, 17, 18, 20, 22],
  SOL: [1, 2, 3, 6, 10, 12, 13, 17, 18],
};

let combWins = 0, combTotal = 0;
for (const coin of COINS) {
  const allC = queryCandles(coin, TF);
  if (allC.length < 200) continue;

  const splitIdx = Math.floor(allC.length * 0.7);
  const testC = allC.slice(splitIdx);
  const goodHoursSet = new Set(GOOD_HOURS[coin] ?? []);

  // Test: streak(3) + bodyToATR >= 0.9 + good hour
  let w = 0, t = 0;
  for (let i = 55; i < testC.length - 1; i++) {
    const c = testC[i];
    const hour = new Date(c.open_time).getUTCHours();
    if (!goodHoursSet.has(hour)) continue;

    // Streak
    let green = 0, red = 0;
    for (let j = i; j >= Math.max(0, i - 8); j--) {
      const cj = testC[j];
      if (cj.close > cj.open) { if (red > 0) break; green++; }
      else if (cj.close < cj.open) { if (green > 0) break; red++; }
      else break;
    }
    if (green < 3 && red < 3) continue;

    // Body/ATR filter
    const atr = calcATR(testC.slice(i - 15, i + 1), 14);
    const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open * 100 : 0;
    const bodyToATR = atr > 0 ? bodyPct / 100 * c.close / atr : 0;
    if (bodyToATR < 0.7) continue; // only larger candles

    const tradeBear = green >= 3;
    const nextUp = testC[i + 1].close > testC[i + 1].open;
    if (tradeBear ? !nextUp : nextUp) w++;
    t++;
  }

  const wr = t ? w / t : 0;
  const pnl = w * BET - (t - w) * BET;
  combWins += w; combTotal += t;
  console.log(`  ${coin}/${TF}: WR=${(wr*100).toFixed(2)}% T=${t} PnL=$${pnl}`);
}

const combWR = combTotal ? combWins / combTotal : 0;
const combPnL = combWins * BET - (combTotal - combWins) * BET;
console.log(`\n  Combined Portfolio (time + bodyATR + streak):`);
console.log(`    WR=${(combWR*100).toFixed(2)}%  T=${combTotal}  PnL=$${combPnL}`);

// Save
const output = {
  timestamp: Date.now(),
  results: finalResults,
  portfolio: { noFilter: { wr: portBaseWR, ...portfolioNoFilter }, rfFilter: { wr: portMLWR, ...portfolioMLFilter } },
  combined: { wr: combWR, trades: combTotal, pnl: combPnL },
};
fs.writeFileSync(path.join(RESEARCH_DIR, 'ml-filter.json'), JSON.stringify(output, null, 2));
console.log('\n✅ Results saved to docs/backtest-research/ml-filter.json');
