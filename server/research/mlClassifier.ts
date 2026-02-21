/**
 * Simple ML classifiers for binary candle direction prediction.
 * No external libraries — pure TypeScript implementations.
 *
 * Classifiers implemented:
 *  1. Logistic Regression (gradient descent)
 *  2. Naive Bayes (Gaussian)
 *  3. Threshold voting ensemble
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/mlClassifier.ts
 */

import fs from 'fs';
import path from 'path';
import { queryCandles } from '../db';
import { runBacktestForPair } from '../backtestEngine';
import type { BacktestConfig, Trade } from '../backtestEngine';

const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');
fs.mkdirSync(RESEARCH_DIR, { recursive: true });

// ─── Feature Vector ────────────────────────────────────────────────────────

interface Sample {
  features: number[]; // normalized [0,1] or [-1,1]
  label: number;      // 1 = bullish next candle, 0 = bearish
}

const FEATURE_NAMES = [
  'rsi14',        // 0-1
  'rsi7',         // 0-1
  'rsiOverbought',// 1 if rsi14 > 0.7
  'rsiOversold',  // 1 if rsi14 < 0.3
  'macdBullish',  // 1 if macd > 0
  'bullishScore', // 0-1
  'bearishScore', // 0-1
  'scoreDiff',    // -1 to 1
  'momentumStr',  // 0-1
  'prevWin',      // 0 or 1
  'prevWin2',     // 2 trades ago
  'bias1',        // const 1 (bias term)
];

function tradesToSamples(trades: Trade[]): Sample[] {
  const samples: Sample[] = [];
  let prevWin = 0.5;
  let prevWin2 = 0.5;

  for (const t of trades) {
    const rsi14 = (t.rawFeatures.rsi14 ?? 50) / 100;
    const rsi7 = (t.rawFeatures.rsi7 ?? 50) / 100;
    const bullScore = Math.min(1, t.rawFeatures.bullishScore / 15);
    const bearScore = Math.min(1, t.rawFeatures.bearishScore / 15);
    const macdVal = t.rawFeatures.macdVal ?? 0;
    const momStr = Math.min(1, (t.rawFeatures.momentumStrength ?? 0) / 5);

    const features = [
      rsi14,
      rsi7,
      rsi14 > 0.7 ? 1 : 0,
      rsi14 < 0.3 ? 1 : 0,
      macdVal > 0 ? 1 : 0,
      bullScore,
      bearScore,
      (bullScore - bearScore),     // -1 to 1
      momStr,
      prevWin,
      prevWin2,
      1,                           // bias
    ];

    // Label = actual next candle direction (not just our prediction)
    // direction=BULL & WIN → next candle was up → label=1
    // direction=BULL & LOSS → next candle was down → label=0
    // direction=BEAR & WIN → next candle was down → label=0
    // direction=BEAR & LOSS → next candle was up → label=1
    const label = (t.direction === 'BULL') === (t.result === 'WIN') ? 1 : 0;

    samples.push({ features, label });
    prevWin2 = prevWin;
    prevWin = t.result === 'WIN' ? 1 : 0;
  }
  return samples;
}

// ─── Logistic Regression ───────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

class LogisticRegression {
  weights: number[];

  constructor(nFeatures: number) {
    this.weights = new Array(nFeatures).fill(0).map(() => (Math.random() - 0.5) * 0.01);
  }

  predict(features: number[]): number {
    let z = 0;
    for (let i = 0; i < this.weights.length; i++) z += this.weights[i] * features[i];
    return sigmoid(z);
  }

  train(samples: Sample[], epochs = 500, lr = 0.01, l2 = 0.001): number[] {
    const losses: number[] = [];
    const n = samples.length;
    const nFeat = this.weights.length;

    for (let epoch = 0; epoch < epochs; epoch++) {
      let totalLoss = 0;
      const grad = new Array(nFeat).fill(0);

      for (const s of samples) {
        const p = this.predict(s.features);
        const err = p - s.label;
        totalLoss += -(s.label * Math.log(p + 1e-15) + (1 - s.label) * Math.log(1 - p + 1e-15));
        for (let i = 0; i < nFeat; i++) grad[i] += err * s.features[i];
      }

      for (let i = 0; i < nFeat; i++) {
        this.weights[i] -= lr * (grad[i] / n + l2 * this.weights[i]);
      }

      if (epoch % 100 === 0) losses.push(totalLoss / n);
    }
    return losses;
  }

  evaluate(samples: Sample[], threshold = 0.5): {
    accuracy: number; precision: number; recall: number;
    tp: number; fp: number; tn: number; fn: number;
    highConfidencyAccuracy: number; highConfidenceCount: number;
  } {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    let hcRight = 0, hcTotal = 0;

    for (const s of samples) {
      const p = this.predict(s.features);
      const pred = p >= threshold ? 1 : 0;
      const highConf = p > 0.6 || p < 0.4;

      if (pred === 1 && s.label === 1) tp++;
      else if (pred === 1 && s.label === 0) fp++;
      else if (pred === 0 && s.label === 0) tn++;
      else fn++;

      if (highConf) {
        hcTotal++;
        if (pred === s.label) hcRight++;
      }
    }

    const n = samples.length;
    return {
      accuracy: (tp + tn) / n,
      precision: (tp + fp) > 0 ? tp / (tp + fp) : 0,
      recall: (tp + fn) > 0 ? tp / (tp + fn) : 0,
      tp, fp, tn, fn,
      highConfidencyAccuracy: hcTotal > 0 ? hcRight / hcTotal : 0,
      highConfidenceCount: hcTotal,
    };
  }
}

// ─── Gaussian Naive Bayes ──────────────────────────────────────────────────

class GaussianNaiveBayes {
  private means: number[][] = [[], []]; // [class][feature]
  private vars: number[][] = [[], []];
  private priors: number[] = [0.5, 0.5];

  train(samples: Sample[]): void {
    const nFeat = samples[0].features.length;
    const classes = [0, 1];

    for (const c of classes) {
      const classSamples = samples.filter(s => s.label === c);
      this.priors[c] = classSamples.length / samples.length;
      this.means[c] = new Array(nFeat).fill(0);
      this.vars[c] = new Array(nFeat).fill(0);

      for (const s of classSamples) {
        for (let f = 0; f < nFeat; f++) this.means[c][f] += s.features[f];
      }
      for (let f = 0; f < nFeat; f++) this.means[c][f] /= classSamples.length;

      for (const s of classSamples) {
        for (let f = 0; f < nFeat; f++) {
          this.vars[c][f] += (s.features[f] - this.means[c][f]) ** 2;
        }
      }
      for (let f = 0; f < nFeat; f++) {
        this.vars[c][f] = this.vars[c][f] / classSamples.length + 1e-9;
      }
    }
  }

  predictProb(features: number[]): number {
    const logProbs = [0, 1].map(c => {
      let lp = Math.log(this.priors[c]);
      for (let f = 0; f < features.length; f++) {
        const diff = features[f] - this.means[c][f];
        lp -= 0.5 * Math.log(2 * Math.PI * this.vars[c][f]);
        lp -= (diff * diff) / (2 * this.vars[c][f]);
      }
      return lp;
    });

    // Normalize to get P(class=1)
    const maxLP = Math.max(...logProbs);
    const exp0 = Math.exp(logProbs[0] - maxLP);
    const exp1 = Math.exp(logProbs[1] - maxLP);
    return exp1 / (exp0 + exp1);
  }

  evaluate(samples: Sample[], threshold = 0.5) {
    let correct = 0, hcRight = 0, hcTotal = 0;
    for (const s of samples) {
      const p = this.predictProb(s.features);
      const pred = p >= threshold ? 1 : 0;
      if (pred === s.label) correct++;
      if (p > 0.6 || p < 0.4) {
        hcTotal++;
        if (pred === s.label) hcRight++;
      }
    }
    return {
      accuracy: correct / samples.length,
      highConfidencyAccuracy: hcTotal > 0 ? hcRight / hcTotal : 0,
      highConfidenceCount: hcTotal,
    };
  }
}

// ─── Simulate ML-based trading ─────────────────────────────────────────────

function simulateMLTrading(
  model: LogisticRegression | GaussianNaiveBayes,
  samples: Sample[],
  trades: Trade[],
  confidenceThreshold = 0.6,
  initialCapital = 1000,
): {
  totalTrades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
} {
  const betSize = initialCapital / 100;
  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let wins = 0;
  let totalTrades = 0;

  for (let i = 0; i < Math.min(samples.length, trades.length); i++) {
    const s = samples[i];
    const t = trades[i];

    let prob: number;
    if (model instanceof LogisticRegression) {
      prob = model.predict(s.features);
    } else {
      prob = model.predictProb(s.features);
    }

    // Only trade when confident
    const isHighConf = prob > confidenceThreshold || prob < (1 - confidenceThreshold);
    if (!isHighConf) continue;

    const predictBull = prob > 0.5;
    // Actual direction was the one that would have won
    const actualUp = (t.direction === 'BULL') === (t.result === 'WIN');
    const win = predictBull === actualUp;

    // Scale bet by confidence
    const confidence = Math.abs(prob - 0.5) * 2; // 0-1
    const bet = betSize * (0.5 + confidence * 0.5); // betSize * 0.5 to 1.0

    const pnl = win ? bet : -bet;
    equity += pnl;
    totalTrades++;
    if (win) wins++;

    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    totalTrades,
    wins,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    totalPnl: equity - initialCapital,
    maxDrawdown: maxDrawdown * 100,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('🤖 ML Classifier Training for ETH 5m binary prediction');
  console.log('═'.repeat(60));

  const COIN = 'ETH';
  const TF = '5m';
  const FROM_MS = 1754006400000;
  const TO_MS = 1769903700000;
  const SPLIT_MS = FROM_MS + Math.floor((TO_MS - FROM_MS) * 0.7);

  // Get all trades using every_candle mode (no filter, just raw signals)
  console.log('\n1. Loading candles and extracting trades...');
  const trainCandles = queryCandles(COIN, TF, FROM_MS, SPLIT_MS);
  const testCandles = queryCandles(COIN, TF, SPLIT_MS, TO_MS);
  console.log(`   Train candles: ${trainCandles.length}, Test candles: ${testCandles.length}`);

  const config: BacktestConfig = {
    coins: [COIN], timeframes: [TF], strategies: ['all'],
    signalModes: ['every_candle'], thresholdMin: 0,
    initialCapital: 1000, fromMs: FROM_MS, toMs: TO_MS,
  };

  const allTrades = runBacktestForPair(
    [...trainCandles, ...testCandles], COIN, TF,
    { ...config, fromMs: FROM_MS, toMs: TO_MS }
  );

  const splitIdx = allTrades.findIndex(t => t.time >= SPLIT_MS);
  const trainTrades = splitIdx > 0 ? allTrades.slice(0, splitIdx) : allTrades.slice(0, Math.floor(allTrades.length * 0.7));
  const testTrades = splitIdx > 0 ? allTrades.slice(splitIdx) : allTrades.slice(Math.floor(allTrades.length * 0.7));

  console.log(`   Train trades: ${trainTrades.length}, Test trades: ${testTrades.length}`);

  const trainSamples = tradesToSamples(trainTrades);
  const testSamples = tradesToSamples(testTrades);

  // Base rate
  const trainUpRate = trainSamples.filter(s => s.label === 1).length / trainSamples.length;
  const testUpRate = testSamples.filter(s => s.label === 1).length / testSamples.length;
  console.log(`\n   Base rates — Train UP: ${(trainUpRate * 100).toFixed(2)}%, Test UP: ${(testUpRate * 100).toFixed(2)}%`);

  // ─── Logistic Regression ────────────────────────────────────────────────

  console.log('\n2. Training Logistic Regression...');
  const lr = new LogisticRegression(FEATURE_NAMES.length);
  const losses = lr.train(trainSamples, 1000, 0.05, 0.001);
  console.log(`   Loss: ${losses[0]?.toFixed(4)} → ${losses[losses.length - 1]?.toFixed(4)}`);

  const lrTrain = lr.evaluate(trainSamples);
  const lrTest = lr.evaluate(testSamples);
  console.log(`   Train accuracy: ${(lrTrain.accuracy * 100).toFixed(2)}% | Test accuracy: ${(lrTest.accuracy * 100).toFixed(2)}%`);
  console.log(`   Train HC accuracy: ${(lrTrain.highConfidencyAccuracy * 100).toFixed(2)}% (${lrTrain.highConfidenceCount} samples)`);
  console.log(`   Test HC accuracy:  ${(lrTest.highConfidencyAccuracy * 100).toFixed(2)}% (${lrTest.highConfidenceCount} samples)`);

  // Feature importance (weights)
  console.log('\n   Feature weights:');
  const weightedFeatures = FEATURE_NAMES.map((name, i) => ({ name, weight: lr.weights[i] }));
  weightedFeatures.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  for (const { name, weight } of weightedFeatures.slice(0, 8)) {
    const bar = '█'.repeat(Math.min(20, Math.round(Math.abs(weight) * 10)));
    console.log(`   ${name.padEnd(16)}: ${weight > 0 ? '+' : '-'}${Math.abs(weight).toFixed(4)} ${bar}`);
  }

  // ─── Naive Bayes ────────────────────────────────────────────────────────

  console.log('\n3. Training Gaussian Naive Bayes...');
  const nb = new GaussianNaiveBayes();
  nb.train(trainSamples);
  const nbTrain = nb.evaluate(trainSamples);
  const nbTest = nb.evaluate(testSamples);
  console.log(`   Train accuracy: ${(nbTrain.accuracy * 100).toFixed(2)}% | Test accuracy: ${(nbTest.accuracy * 100).toFixed(2)}%`);
  console.log(`   Train HC accuracy: ${(nbTrain.highConfidencyAccuracy * 100).toFixed(2)}% (${nbTrain.highConfidenceCount} samples)`);
  console.log(`   Test HC accuracy:  ${(nbTest.highConfidencyAccuracy * 100).toFixed(2)}% (${nbTest.highConfidenceCount} samples)`);

  // ─── Simulate ML-based trading ──────────────────────────────────────────

  console.log('\n4. Simulating ML-based trading on TEST period...');
  console.log('   (Only trading when model confidence > threshold)');
  console.log('');

  const thresholds = [0.52, 0.55, 0.58, 0.60, 0.62, 0.65];
  const mlResults: Record<string, unknown>[] = [];

  for (const thresh of thresholds) {
    const lrResult = simulateMLTrading(lr, testSamples, testTrades, thresh);
    const nbResult = simulateMLTrading(nb, testSamples, testTrades, thresh);

    console.log(`   Threshold ${thresh.toFixed(2)}:`);
    console.log(`     LR:  trades=${lrResult.totalTrades}, WR=${lrResult.winRate.toFixed(2)}%, PnL=${lrResult.totalPnl.toFixed(2)}, MaxDD=${lrResult.maxDrawdown.toFixed(2)}%`);
    console.log(`     NB:  trades=${nbResult.totalTrades}, WR=${nbResult.winRate.toFixed(2)}%, PnL=${nbResult.totalPnl.toFixed(2)}, MaxDD=${nbResult.maxDrawdown.toFixed(2)}%`);

    mlResults.push({
      threshold: thresh,
      lr: lrResult,
      nb: nbResult,
    });
  }

  // ─── Compare vs baseline ────────────────────────────────────────────────

  console.log('\n5. Baseline comparison (no ML, threshold=2 every_candle on 5m):');
  const baseConfig: BacktestConfig = {
    coins: [COIN], timeframes: [TF], strategies: ['all'],
    signalModes: ['every_candle'], thresholdMin: 2,
    initialCapital: 1000, fromMs: SPLIT_MS, toMs: TO_MS,
  };
  const baseTrades = runBacktestForPair(testCandles, COIN, TF, baseConfig);
  const basePnl = baseTrades.reduce((s, t) => s + t.pnl, 0);
  const baseWR = baseTrades.length > 0 ? baseTrades.filter(t => t.result === 'WIN').length / baseTrades.length * 100 : 0;
  console.log(`   Baseline: ${baseTrades.length} trades, WR=${baseWR.toFixed(2)}%, PnL=${basePnl.toFixed(2)}`);

  // ─── Save ML results ─────────────────────────────────────────────────

  const mlOutput = {
    generatedAt: new Date().toISOString(),
    coin: COIN,
    timeframe: TF,
    trainPeriod: { fromMs: FROM_MS, toMs: SPLIT_MS },
    testPeriod: { fromMs: SPLIT_MS, toMs: TO_MS },
    baseRates: { trainUpRate: trainUpRate * 100, testUpRate: testUpRate * 100 },
    logisticRegression: {
      train: lrTrain,
      test: lrTest,
      weights: weightedFeatures,
      finalWeights: lr.weights,
    },
    naiveBayes: {
      train: nbTrain,
      test: nbTest,
    },
    mlTradingSimulation: mlResults,
    baseline: { trades: baseTrades.length, winRate: baseWR, totalPnl: basePnl },
    featureNames: FEATURE_NAMES,
  };

  fs.writeFileSync(
    path.join(RESEARCH_DIR, 'ml-results.json'),
    JSON.stringify(mlOutput, null, 2)
  );

  console.log('\n✅ ML analysis complete. Results saved to docs/backtest-research/ml-results.json');

  // ─── Print key insights ─────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(60));
  console.log('🔑 KEY INSIGHTS:');
  console.log('═'.repeat(60));
  console.log(`\n1. Baseline win rate (5m ETH, every_candle): ${baseWR.toFixed(2)}%`);
  console.log(`2. Next candle UP rate in test period: ${(testUpRate * 100).toFixed(2)}%`);
  console.log(`3. LR model test accuracy: ${(lrTest.accuracy * 100).toFixed(2)}%`);
  console.log(`4. Top features by weight:`);
  for (const { name, weight } of weightedFeatures.slice(0, 4)) {
    console.log(`   - ${name}: ${weight > 0 ? 'bullish predictor' : 'bearish predictor'} (|${Math.abs(weight).toFixed(4)}|)`);
  }

  const bestLR = thresholds.map(thresh => simulateMLTrading(lr, testSamples, testTrades, thresh))
    .sort((a, b) => b.totalPnl - a.totalPnl)[0];
  console.log(`\n5. Best ML trading result (LR):`);
  console.log(`   Trades: ${bestLR.totalTrades}, WR: ${bestLR.winRate.toFixed(2)}%, PnL: ${bestLR.totalPnl.toFixed(2)}`);
}

main().catch(console.error);
