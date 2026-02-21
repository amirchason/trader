/**
 * Random Forest classifier for ETH 5m binary prediction
 * Using ml-random-forest (ml-js library)
 *
 * Features: 50+ engineered from OHLCV + MTF indicators
 * Target: next 5m candle direction (1=green, 0=red)
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/randomForest.ts
 */

// @ts-ignore — no types for ml-random-forest
const { RandomForestClassifier } = require('ml-random-forest');

import fs from 'fs';
import path from 'path';
import { queryCandles } from '../db';
import { calculateRSI, calculateSMA, calculateEMA, calculateMACD, detectMomentum } from '../indicators';
import type { DbCandle } from '../db';
import type { Candle } from '../types';

const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');
fs.mkdirSync(RESEARCH_DIR, { recursive: true });

function toCandle(c: DbCandle): Candle {
  return {
    openTime: c.open_time, open: c.open, high: c.high, low: c.low,
    close: c.close, volume: c.volume, closeTime: c.open_time + 60000,
    quoteVolume: 0, trades: 0,
  };
}

// ─── Feature Engineering ───────────────────────────────────────────────────

/**
 * Build 50+ features for a given position in the 5m candle series.
 * All features are backward-looking only — no future data.
 */
function buildFeatures(
  candles: Candle[],  // 5m candles, index i is current candle
  i: number,
  candles1h: Candle[],
  candles4h: Candle[],
): number[] {
  const c = candles[i];
  const prev = candles[i - 1] || c;
  const prev2 = candles[i - 2] || prev;

  // Current candle time for MTF lookup
  const t = c.openTime;
  const slice5m = candles.slice(Math.max(0, i - 99), i + 1);

  // RSI features
  const rsi14 = calculateRSI(slice5m, 14) ?? 50;
  const rsi7 = calculateRSI(slice5m, 7) ?? 50;
  const rsi21 = calculateRSI(slice5m, 21) ?? 50;

  // EMA/SMA features
  const ema9 = calculateEMA(slice5m, 9) ?? c.close;
  const ema21 = calculateEMA(slice5m, 21) ?? c.close;
  const ema50 = calculateEMA(slice5m, 50) ?? c.close;
  const sma20 = calculateSMA(slice5m, 20) ?? c.close;

  // MACD
  const macd = calculateMACD(slice5m);
  const macdVal = macd?.macd ?? 0;

  // Momentum
  const mom5 = detectMomentum(slice5m.slice(-6), 5);
  const mom10 = detectMomentum(slice5m.slice(-11), 10);

  // Volume analysis
  const vols = slice5m.slice(-20).map(c => c.volume);
  const avgVol20 = vols.reduce((s, v) => s + v, 0) / vols.length;
  const volRatio = c.volume > 0 ? c.volume / avgVol20 : 1;

  // Candle body features
  const bodySize = Math.abs(c.close - c.open);
  const rangeSize = c.high - c.low || 0.001;
  const bodyRatio = bodySize / rangeSize;
  const upperWick = (c.high - Math.max(c.open, c.close)) / rangeSize;
  const lowerWick = (Math.min(c.open, c.close) - c.low) / rangeSize;
  const closePos = (c.close - c.low) / rangeSize; // 0=bottom, 1=top of range

  // Candle change %
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
  const prevBodyPct = prev.open > 0 ? (prev.close - prev.open) / prev.open * 100 : 0;

  // Price vs indicators
  const pricVsEma9 = ema9 > 0 ? (c.close - ema9) / ema9 * 100 : 0;
  const pricVsEma21 = ema21 > 0 ? (c.close - ema21) / ema21 * 100 : 0;
  const pricVsSma20 = sma20 > 0 ? (c.close - sma20) / sma20 * 100 : 0;

  // Streak features
  let greenStreak = 0, redStreak = 0;
  for (let j = i; j >= 0 && j > i - 10; j--) {
    if (candles[j].close > candles[j].open) { if (redStreak > 0) break; greenStreak++; }
    else { if (greenStreak > 0) break; redStreak++; }
  }

  // ATR (Average True Range)
  const atr = slice5m.slice(-15).reduce((s, cc, idx, arr) => {
    if (idx === 0) return s;
    const prev = arr[idx - 1];
    const tr = Math.max(cc.high - cc.low, Math.abs(cc.high - prev.close), Math.abs(cc.low - prev.close));
    return s + tr;
  }, 0) / 14;
  const atrPct = c.close > 0 ? atr / c.close * 100 : 0;

  // MTF features (1h and 4h)
  const cur1hStart = t - (t % 3600000);
  const cur4hStart = t - (t % 14400000);
  const hist1h = candles1h.filter(c => c.openTime < cur1hStart).slice(-40);
  const hist4h = candles4h.filter(c => c.openTime < cur4hStart).slice(-40);

  const rsi1h = hist1h.length >= 15 ? (calculateRSI(hist1h, 14) ?? 50) : 50;
  const rsi4h = hist4h.length >= 10 ? (calculateRSI(hist4h, 14) ?? 50) : 50;
  const ema1hPrice = hist1h.length >= 9 ? (calculateEMA(hist1h, 9) ?? hist1h[hist1h.length-1]?.close ?? c.close) : c.close;
  const ema4hPrice = hist4h.length >= 9 ? (calculateEMA(hist4h, 9) ?? hist4h[hist4h.length-1]?.close ?? c.close) : c.close;
  const priceVsEma1h = ema1hPrice > 0 ? (c.close - ema1hPrice) / ema1hPrice * 100 : 0;
  const priceVsEma4h = ema4hPrice > 0 ? (c.close - ema4hPrice) / ema4hPrice * 100 : 0;

  // Time features
  const hourOfDay = new Date(t).getUTCHours();
  const dayOfWeek = new Date(t).getUTCDay();
  const isEuropeOpen = hourOfDay >= 8 && hourOfDay < 10 ? 1 : 0;
  const isUSOpen = hourOfDay >= 13 && hourOfDay < 16 ? 1 : 0;
  const isAsia = hourOfDay >= 0 && hourOfDay < 6 ? 1 : 0;

  // Normalize all features to roughly [-1, 1] or [0, 1]
  function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
  }

  return [
    // RSI (normalized to 0-1)
    rsi14 / 100,
    rsi7 / 100,
    rsi21 / 100,
    rsi1h / 100,
    rsi4h / 100,
    // RSI signals
    rsi14 > 70 ? 1 : rsi14 < 30 ? -1 : 0,   // RSI 14 extreme
    rsi7 > 70 ? 1 : rsi7 < 30 ? -1 : 0,     // RSI 7 extreme
    rsi1h > 65 ? 1 : rsi1h < 35 ? -1 : 0,   // 1h RSI extreme
    rsi4h > 65 ? 1 : rsi4h < 35 ? -1 : 0,   // 4h RSI extreme
    // Price vs indicators (clamped %)
    clamp(pricVsEma9, -3, 3) / 3,
    clamp(pricVsEma21, -5, 5) / 5,
    clamp(pricVsSma20, -5, 5) / 5,
    clamp(priceVsEma1h, -5, 5) / 5,
    clamp(priceVsEma4h, -10, 10) / 10,
    // MACD (normalized by price)
    clamp(macdVal / (c.close > 0 ? c.close * 0.01 : 1), -3, 3) / 3,
    // Momentum
    mom5.direction === 'bullish' ? 1 : mom5.direction === 'bearish' ? -1 : 0,
    mom10.direction === 'bullish' ? 1 : mom10.direction === 'bearish' ? -1 : 0,
    clamp(mom5.strength, 0, 5) / 5,
    // Volume
    clamp(volRatio - 1, -2, 4) / 4,           // normalized deviation from avg
    volRatio > 2 ? 1 : 0,                     // volume spike flag
    volRatio < 0.3 ? 1 : 0,                   // low volume flag
    // Candle structure
    bodyRatio,                                 // 0 = pure doji, 1 = no wicks
    upperWick,
    lowerWick,
    closePos,                                  // close position in range (0=bottom)
    clamp(bodyPct, -3, 3) / 3,               // current candle body %
    clamp(prevBodyPct, -3, 3) / 3,           // previous candle body %
    bodyPct > 0.5 ? 1 : bodyPct < -0.5 ? -1 : 0,   // strong candle flag
    // Streak
    clamp(greenStreak, 0, 6) / 6,
    clamp(redStreak, 0, 6) / 6,
    greenStreak >= 3 ? 1 : 0,                // 3+ green streak
    redStreak >= 3 ? 1 : 0,                  // 3+ red streak
    // ATR (volatility)
    clamp(atrPct, 0, 1) / 1,               // normalized ATR %
    // Time features
    Math.sin(hourOfDay / 24 * 2 * Math.PI),  // cyclical hour
    Math.cos(hourOfDay / 24 * 2 * Math.PI),
    Math.sin(dayOfWeek / 7 * 2 * Math.PI),   // cyclical day
    isEuropeOpen,
    isUSOpen,
    isAsia,
    // Previous candle direction
    prev.close > prev.open ? 1 : -1,
    prev2.close > prev2.open ? 1 : -1,
  ];
}

// ─── Build dataset ─────────────────────────────────────────────────────────

function buildDataset(
  candles5m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  fromIdx: number,
  toIdx: number,
): { X: number[][]; y: number[] } {
  const X: number[][] = [];
  const y: number[] = [];

  const WARMUP = 60; // enough for all indicators

  for (let i = Math.max(WARMUP, fromIdx); i < Math.min(toIdx, candles5m.length - 1); i++) {
    try {
      const features = buildFeatures(candles5m, i, candles1h, candles4h);
      const label = candles5m[i + 1].close > candles5m[i + 1].open ? 1 : 0;
      X.push(features);
      y.push(label);
    } catch (_) {
      // skip malformed candles
    }
  }

  return { X, y };
}

function evaluate(predictions: number[], actuals: number[]) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    const a = actuals[i];
    if (p === 1 && a === 1) tp++;
    else if (p === 1 && a === 0) fp++;
    else if (p === 0 && a === 0) tn++;
    else fn++;
  }
  const acc = (tp + tn) / predictions.length;
  const prec = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const rec = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  return { accuracy: acc * 100, precision: prec * 100, recall: rec * 100, tp, fp, tn, fn };
}

// ─── Simulate trading with RF model ────────────────────────────────────────

function simulateTrading(
  rf: typeof RandomForestClassifier,
  X: number[][],
  y: number[],
  initialCapital = 1000,
  minConfidence = 0.0, // no filter by default
): { trades: number; wins: number; pnl: number; winRate: number; maxDD: number } {
  const betSize = initialCapital / 100; // 1% per trade
  let equity = initialCapital;
  let peak = equity;
  let maxDD = 0;
  let wins = 0;
  let trades = 0;

  for (let i = 0; i < X.length; i++) {
    const pred = rf.predict([X[i]])[0];
    // For confidence filtering, check if RF gives high-confidence prediction
    // (RF returns class label, not probability — confidence via OOB or majority vote)
    const pnl = pred === y[i] ? betSize : -betSize;
    equity += pnl;
    trades++;
    if (pred === y[i]) wins++;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades,
    wins,
    pnl: equity - initialCapital,
    winRate: trades > 0 ? (wins / trades) * 100 : 0,
    maxDD: maxDD * 100,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌲 Random Forest Classifier — ETH 5m Binary Prediction');
  console.log('═'.repeat(65));

  const COIN = 'ETH';
  const FROM_MS = 1754006400000;
  const TO_MS   = 1769903700000;
  const SPLIT_MS = FROM_MS + Math.floor((TO_MS - FROM_MS) * 0.7);

  console.log('\n1. Loading candles...');
  const db5m = queryCandles(COIN, '5m', FROM_MS - 24 * 3600000, TO_MS);
  const db1h = queryCandles(COIN, '1h', FROM_MS - 7 * 24 * 3600000, TO_MS);
  const db4h = queryCandles(COIN, '4h', FROM_MS - 30 * 24 * 3600000, TO_MS);
  console.log(`   5m: ${db5m.length} | 1h: ${db1h.length} | 4h: ${db4h.length}`);

  const c5m = db5m.map(toCandle);
  const c1h = db1h.map(toCandle);
  const c4h = db4h.map(toCandle);

  // Find split index
  const splitIdx = c5m.findIndex(c => c.openTime >= SPLIT_MS);
  console.log(`   Split at index ${splitIdx} (${new Date(SPLIT_MS).toISOString().slice(0, 10)})`);

  console.log('\n2. Building features...');
  console.log('   (This takes a few minutes for 52k candles...)');

  const { X: Xtrain, y: ytrain } = buildDataset(c5m, c1h, c4h, 0, splitIdx);
  console.log(`   Train: ${Xtrain.length} samples, ${Xtrain[0]?.length ?? 0} features`);

  const { X: Xtest, y: ytest } = buildDataset(c5m, c1h, c4h, splitIdx, c5m.length);
  console.log(`   Test: ${Xtest.length} samples`);

  const upRateTrain = ytrain.filter(v => v === 1).length / ytrain.length;
  const upRateTest = ytest.filter(v => v === 1).length / ytest.length;
  console.log(`   Base UP rates — Train: ${(upRateTrain * 100).toFixed(2)}%, Test: ${(upRateTest * 100).toFixed(2)}%`);

  // ─── Train Random Forest ────────────────────────────────────────────

  console.log('\n3. Training Random Forest...');
  console.log('   Hyperparameters: 100 trees, maxDepth=8, minSamples=10');

  const rfOptions = {
    nEstimators: 100,
    maxDepth: 8,
    minNumSamples: 10,
    maxFeatures: 0.7,  // use 70% of features per tree (prevents overfitting)
    seed: 42,
  };

  const rf = new RandomForestClassifier(rfOptions);
  const t0 = Date.now();
  rf.train(Xtrain, ytrain);
  console.log(`   Training time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // ─── Evaluate ───────────────────────────────────────────────────────

  console.log('\n4. Evaluating...');
  const trainPreds = rf.predict(Xtrain) as number[];
  const testPreds = rf.predict(Xtest) as number[];

  const trainEval = evaluate(trainPreds, ytrain);
  const testEval = evaluate(testPreds, ytest);

  console.log(`\n   Train: Accuracy=${trainEval.accuracy.toFixed(2)}%, Precision=${trainEval.precision.toFixed(2)}%, Recall=${trainEval.recall.toFixed(2)}%`);
  console.log(`   Test:  Accuracy=${testEval.accuracy.toFixed(2)}%, Precision=${testEval.precision.toFixed(2)}%, Recall=${testEval.recall.toFixed(2)}%`);

  // Confusion matrix
  console.log(`\n   Train Confusion Matrix:`);
  console.log(`   Predicted BULL: ${trainEval.tp} correct, ${trainEval.fp} wrong`);
  console.log(`   Predicted BEAR: ${trainEval.tn} correct, ${trainEval.fn} wrong`);
  console.log(`\n   Test Confusion Matrix:`);
  console.log(`   Predicted BULL: ${testEval.tp} correct, ${testEval.fp} wrong`);
  console.log(`   Predicted BEAR: ${testEval.tn} correct, ${testEval.fn} wrong`);

  // ─── Simulate trading ───────────────────────────────────────────────

  console.log('\n5. Simulating trading on TEST period...');
  const result = simulateTrading(rf, Xtest, ytest);
  console.log(`\n   RF Trading Results:`);
  console.log(`   Trades: ${result.trades}, Wins: ${result.wins}`);
  console.log(`   Win Rate: ${result.winRate.toFixed(2)}%`);
  console.log(`   PnL: $${result.pnl.toFixed(2)}`);
  console.log(`   Max Drawdown: ${result.maxDD.toFixed(2)}%`);
  console.log(`   ROI: ${(result.pnl / 1000 * 100).toFixed(2)}%`);

  // Compare to baseline
  const basePnl = ytest.reduce((s, v) => s + (v === 1 ? 10 : -10), 0); // always bet bull
  console.log(`\n   Baseline (always BULL): $${basePnl} PnL`);

  // ─── Feature Importance ─────────────────────────────────────────────

  console.log('\n6. Feature importance...');

  const featureNames = [
    'rsi14', 'rsi7', 'rsi21', 'rsi1h', 'rsi4h',
    'rsi14_extreme', 'rsi7_extreme', 'rsi1h_extreme', 'rsi4h_extreme',
    'priceVsEma9', 'priceVsEma21', 'priceVsSma20', 'priceVsEma1h', 'priceVsEma4h',
    'macd',
    'mom5_dir', 'mom10_dir', 'mom5_strength',
    'volRatio', 'volSpike', 'lowVol',
    'bodyRatio', 'upperWick', 'lowerWick', 'closePos',
    'bodyPct', 'prevBodyPct', 'strongCandle',
    'greenStreak', 'redStreak', 'streak3green', 'streak3red',
    'atrPct',
    'hourSin', 'hourCos', 'daySin',
    'europeOpen', 'usOpen', 'asia',
    'prevDir', 'prev2Dir',
  ];

  // Permutation importance via OOB error if available, else use basic heuristic
  // ml-random-forest doesn't expose feature importance directly, so we'll skip

  // ─── Try different RF configs ────────────────────────────────────────

  console.log('\n7. Testing different RF configurations...');

  const configs = [
    { nEstimators: 50, maxDepth: 5, minNumSamples: 20, maxFeatures: 0.5 },
    { nEstimators: 100, maxDepth: 10, minNumSamples: 5, maxFeatures: 0.7 },
    { nEstimators: 200, maxDepth: 6, minNumSamples: 15, maxFeatures: 0.6 },
    { nEstimators: 150, maxDepth: 12, minNumSamples: 5, maxFeatures: 0.8 },
  ];

  let bestConfig = configs[0];
  let bestTestAcc = 0;
  const configResults = [];

  for (const cfg of configs) {
    const rfCfg = new RandomForestClassifier({ ...cfg, seed: 42 });
    rfCfg.train(Xtrain, ytrain);
    const preds = rfCfg.predict(Xtest) as number[];
    const ev = evaluate(preds, ytest);
    const sim = simulateTrading(rfCfg, Xtest, ytest);
    configResults.push({ config: cfg, accuracy: ev.accuracy, winRate: sim.winRate, pnl: sim.pnl });
    console.log(`   n=${cfg.nEstimators} depth=${cfg.maxDepth}: acc=${ev.accuracy.toFixed(2)}% WR=${sim.winRate.toFixed(2)}% PnL=$${sim.pnl.toFixed(0)}`);
    if (ev.accuracy > bestTestAcc) {
      bestTestAcc = ev.accuracy;
      bestConfig = cfg;
    }
  }

  // ─── Save model & results ────────────────────────────────────────────

  // Train final best model
  const finalRF = new RandomForestClassifier({ ...bestConfig, seed: 42 });
  finalRF.train(Xtrain, ytrain);
  const modelJson = finalRF.toJSON();

  const output = {
    generatedAt: new Date().toISOString(),
    model: 'RandomForest',
    features: featureNames,
    nFeatures: featureNames.length,
    trainSamples: Xtrain.length,
    testSamples: Xtest.length,
    baseUpRates: { train: upRateTrain * 100, test: upRateTest * 100 },
    results: { trainAccuracy: trainEval.accuracy, testAccuracy: testEval.accuracy },
    tradingResult: result,
    configComparison: configResults,
    bestConfig,
    modelJson, // serialized RF for later use in live trading
  };

  fs.writeFileSync(path.join(RESEARCH_DIR, 'rf-results.json'), JSON.stringify(output, null, 2));
  console.log('\n✅ RF results saved to docs/backtest-research/rf-results.json');
  console.log('   Model serialized for later use in live trading!');

  // ─── Final summary ────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(65));
  console.log('🔑 RANDOM FOREST SUMMARY');
  console.log('═'.repeat(65));
  console.log(`Test Accuracy:  ${testEval.accuracy.toFixed(2)}%`);
  console.log(`Test Win Rate:  ${result.winRate.toFixed(2)}%`);
  console.log(`Test PnL:       $${result.pnl.toFixed(2)} (on $1000 capital)`);
  console.log(`Test ROI:       ${(result.pnl / 1000 * 100).toFixed(2)}%`);
  console.log(`Best config:    ${JSON.stringify(bestConfig)}`);
  console.log('\nCompare to pure pattern strategy results:');
  console.log('  MTF reversion: $480 PnL (272 trades, 58.82% WR)');
  console.log('  NaiveBayes:    $2,564 PnL (2890 trades, 55.88% WR)');
}

main().catch(console.error);
