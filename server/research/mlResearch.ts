/**
 * mlResearch.ts
 * Machine learning research — using all validated features as ML inputs
 *
 * Pure TypeScript implementation:
 * 1. Feature engineering from all validated research findings
 * 2. Logistic Regression (gradient descent)
 * 3. Gradient Boosted Decision Trees (simplified GBDT)
 * 4. Walk-forward validation (strict out-of-sample)
 * 5. Feature importance analysis
 *
 * Features: streak, BB deviation, hour, bodyATR, MFI, ATR regime,
 *           candle sequence, BB mult, day-of-week, volume ratio
 */

import { getDb } from '../db';

const db = getDb();

interface RawCandle {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function getCandles(symbol: string, timeframe: string): RawCandle[] {
  return db
    .prepare(
      'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
    )
    .all(symbol, timeframe) as RawCandle[];
}

// ── Technical indicators ───────────────────────────────────────────────────────

function calcBB(candles: RawCandle[], end: number, period: number, mult: number) {
  if (end < period - 1) return null;
  const slice = candles.slice(end - period + 1, end + 1);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, lower: mid - mult * std, mid, std };
}

function calcATR(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 0;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function calcMFI(candles: RawCandle[], end: number, period = 10): number {
  if (end < period) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const tpPrev = (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp > tpPrev) posFlow += mf;
    else if (tp < tpPrev) negFlow += mf;
  }
  return negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
}

function calcRSI(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const chg = candles[i].close - candles[i - 1].close;
    if (chg > 0) avgGain += chg;
    else avgLoss -= chg;
  }
  avgGain /= period;
  avgLoss /= period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVolAvg(candles: RawCandle[], end: number, period = 20): number {
  if (end < period) return 0;
  return candles.slice(end - period + 1, end + 1).reduce((s, c) => s + c.volume, 0) / period;
}

// ── Feature extractor ──────────────────────────────────────────────────────────

interface Sample {
  features: number[];
  label: number; // 1 = signal direction wins, 0 = loses
}

const FEATURE_NAMES = [
  'streak_len',        // 0: streak length (1-7, normalized)
  'streak_dir',        // 1: 1=green streak, -1=red streak
  'bb_deviation_pct',  // 2: % outside BB (signed: + = above upper, - = below lower)
  'bb_pctB',           // 3: %B position (0-1 range normalized)
  'hour_good',         // 4: 1 if hour in [10,11,12,21]
  'hour_bad',          // 5: 1 if hour in [8,9,14,19,20]
  'hour_sin',          // 6: sin(hour * 2π/24) for cyclical encoding
  'hour_cos',          // 7: cos(hour * 2π/24) for cyclical encoding
  'body_atr_ratio',    // 8: |candle body| / ATR14
  'mfi',               // 9: MFI(10) normalized to 0-1
  'rsi',               // 10: RSI(14) normalized to 0-1
  'atr_percentile',    // 11: ATR vs trailing 100-period ATR (0=low, 1=high)
  'vol_ratio',         // 12: current volume / 20-period avg volume
  'is_rggg',           // 13: 1 if RGGG/GRGG bear pattern at BB upper (or mirror bull)
  'upper_wick',        // 14: upper wick ratio of last candle
  'lower_wick',        // 15: lower wick ratio of last candle
  'day_sin',           // 16: sin(dayOfWeek * 2π/7) cyclical
  'day_cos',           // 17: cos(dayOfWeek * 2π/7) cyclical
  'body_dir',          // 18: 1=green, -1=red, 0=doji for last candle
  'prev_body_atr',     // 19: body/ATR for previous candle
];

function extractFeatures(
  candles: RawCandle[],
  i: number,
  bb20_2: { upper: number; lower: number; mid: number; std: number } | null,
  atr: number,
  atrPercentile: number
): number[] | null {
  if (!bb20_2) return null;
  const c = candles[i];
  const price = c.close;

  // 1. Streak
  let green = 0, red = 0;
  for (let j = i; j >= Math.max(0, i - 7); j--) {
    const cj = candles[j];
    if (cj.close > cj.open) { if (red > 0) break; green++; }
    else if (cj.close < cj.open) { if (green > 0) break; red++; }
    else break;
  }
  const streakLen = Math.max(green, red);
  const streakDir = green > 0 ? 1 : (red > 0 ? -1 : 0);

  // 2. BB metrics
  const aboveBB = price > bb20_2.upper;
  const belowBB = price < bb20_2.lower;
  const bbDeviation = aboveBB
    ? (price - bb20_2.upper) / (bb20_2.std + 1e-10)
    : belowBB
    ? -(bb20_2.lower - price) / (bb20_2.std + 1e-10)
    : 0;
  const bbPctB = bb20_2.std > 0 ? (price - bb20_2.lower) / (bb20_2.upper - bb20_2.lower) : 0.5;

  // 3. Time features
  const date = new Date(c.open_time);
  const hour = date.getUTCHours();
  const dayOfWeek = date.getUTCDay();
  const goodHours = [10, 11, 12, 21];
  const badHours = [8, 9, 14, 19, 20];

  // 4. Body/ATR
  const bodyATR = atr > 0 ? Math.abs(c.close - c.open) / atr : 0;
  const prevBodyATR = i > 0 && atr > 0 ? Math.abs(candles[i-1].close - candles[i-1].open) / atr : 0;

  // 5. MFI, RSI
  const mfi = calcMFI(candles, i, 10) / 100;
  const rsi = calcRSI(candles, i, 14) / 100;

  // 6. Volume
  const volAvg = calcVolAvg(candles, i, 20);
  const volRatio = volAvg > 0 ? Math.min(5, c.volume / volAvg) : 1;

  // 7. RGGG pattern
  let isRGGG = 0;
  if (i >= 3) {
    const c3 = candles[i - 3], c2 = candles[i - 2], c1 = candles[i - 1];
    const isG = (x: RawCandle) => x.close > x.open;
    const isR = (x: RawCandle) => x.close < x.open;
    if (aboveBB && ((isR(c3) && isG(c2) && isG(c1) && isG(c)) || (isG(c3) && isR(c2) && isG(c1) && isG(c)))) isRGGG = 1;
    if (belowBB && ((isG(c3) && isR(c2) && isR(c1) && isR(c)) || (isR(c3) && isG(c2) && isR(c1) && isR(c)))) isRGGG = 1;
  }

  // 8. Wicks
  const range = c.high - c.low;
  const upperWick = range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0;
  const lowerWick = range > 0 ? (Math.min(c.open, c.close) - c.low) / range : 0;

  // 9. Body direction
  const bodyDir = c.close > c.open ? 1 : (c.close < c.open ? -1 : 0);

  return [
    streakLen / 7,
    streakDir,
    bbDeviation,
    bbPctB,
    goodHours.includes(hour) ? 1 : 0,
    badHours.includes(hour) ? 1 : 0,
    Math.sin(hour * 2 * Math.PI / 24),
    Math.cos(hour * 2 * Math.PI / 24),
    Math.min(3, bodyATR),
    mfi,
    rsi,
    atrPercentile,
    volRatio,
    isRGGG,
    upperWick,
    lowerWick,
    Math.sin(dayOfWeek * 2 * Math.PI / 7),
    Math.cos(dayOfWeek * 2 * Math.PI / 7),
    bodyDir,
    Math.min(3, prevBodyATR),
  ];
}

// ── Build dataset (only when price is outside BB — our signal filter) ────────

function buildDataset(candles: RawCandle[], startIdx: number, endIdx: number): Sample[] {
  const samples: Sample[] = [];
  const warmup = 30;

  // Pre-compute ATR percentiles
  const atrs: number[] = [];
  for (let i = 14; i < endIdx; i++) atrs.push(calcATR(candles, i));

  for (let i = Math.max(startIdx, warmup); i < endIdx - 1; i++) {
    const bb = calcBB(candles, i, 20, 2);
    if (!bb) continue;

    const price = candles[i].close;
    const aboveBB = price > bb.upper;
    const belowBB = price < bb.lower;
    if (!aboveBB && !belowBB) continue; // only include signal candidates

    const atr = calcATR(candles, i);
    // ATR percentile in rolling 100-period window
    const windowAtrs = atrs.slice(Math.max(0, i - 100), i);
    windowAtrs.sort((a, b) => a - b);
    const atrPct = windowAtrs.length > 0
      ? windowAtrs.filter(a => a <= atr).length / windowAtrs.length
      : 0.5;

    const features = extractFeatures(candles, i, bb, atr, atrPct);
    if (!features) continue;

    // Label: does the next candle go in the direction of mean reversion?
    const nextCandle = candles[i + 1];
    const win = aboveBB
      ? nextCandle.close < nextCandle.open  // above BB → expect red next
      : nextCandle.close > nextCandle.open; // below BB → expect green next

    samples.push({ features, label: win ? 1 : 0 });
  }

  return samples;
}

// ── Logistic Regression ───────────────────────────────────────────────────────

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, x))));
}

function trainLogisticRegression(
  samples: Sample[],
  epochs = 200,
  lr = 0.1,
  l2 = 0.01
): number[] {
  const nFeatures = FEATURE_NAMES.length;
  const weights = new Array(nFeatures + 1).fill(0); // +1 for bias

  for (let epoch = 0; epoch < epochs; epoch++) {
    let totalGrad = new Array(nFeatures + 1).fill(0);

    for (const { features, label } of samples) {
      const logit = weights[0] + features.reduce((s, f, j) => s + f * weights[j + 1], 0);
      const pred = sigmoid(logit);
      const err = pred - label;

      totalGrad[0] += err;
      for (let j = 0; j < nFeatures; j++) {
        totalGrad[j + 1] += err * features[j];
      }
    }

    const n = samples.length;
    for (let j = 0; j <= nFeatures; j++) {
      const l2Penalty = j === 0 ? 0 : l2 * weights[j];
      weights[j] -= lr * (totalGrad[j] / n + l2Penalty);
    }
  }

  return weights;
}

function predictLR(weights: number[], features: number[]): number {
  const logit = weights[0] + features.reduce((s, f, j) => s + f * weights[j + 1], 0);
  return sigmoid(logit);
}

// ── Decision Stump ───────────────────────────────────────────────────────────

interface Stump {
  featureIdx: number;
  threshold: number;
  leftPred: number;
  rightPred: number;
}

function fitStump(samples: Sample[], weights: number[]): Stump {
  const nFeatures = FEATURE_NAMES.length;
  let bestGini = Infinity;
  let bestStump: Stump = { featureIdx: 0, threshold: 0, leftPred: 0.5, rightPred: 0.5 };

  for (let fi = 0; fi < nFeatures; fi++) {
    // Get unique thresholds
    const vals = samples.map(s => s.features[fi]);
    const sorted = [...new Set(vals)].sort((a, b) => a - b);
    const thresholds = sorted.slice(0, -1).map((v, i) => (v + sorted[i + 1]) / 2);

    for (const thr of thresholds.slice(0, 20)) { // limit thresholds for speed
      let leftW = 0, leftPos = 0, rightW = 0, rightPos = 0;
      for (let si = 0; si < samples.length; si++) {
        const w = weights[si];
        const pos = samples[si].label;
        if (samples[si].features[fi] <= thr) {
          leftW += w;
          leftPos += w * pos;
        } else {
          rightW += w;
          rightPos += w * pos;
        }
      }
      const leftP = leftW > 0 ? leftPos / leftW : 0.5;
      const rightP = rightW > 0 ? rightPos / rightW : 0.5;
      const leftGini = leftW * leftP * (1 - leftP);
      const rightGini = rightW * rightP * (1 - rightP);
      const gini = leftGini + rightGini;
      if (gini < bestGini) {
        bestGini = gini;
        bestStump = { featureIdx: fi, threshold: thr, leftPred: leftP, rightPred: rightP };
      }
    }
  }
  return bestStump;
}

// ── AdaBoost ─────────────────────────────────────────────────────────────────

interface WeakLearner {
  stump: Stump;
  alpha: number;
}

function trainAdaBoost(samples: Sample[], nEstimators = 50): WeakLearner[] {
  const n = samples.length;
  let sampleWeights = new Array(n).fill(1 / n);
  const learners: WeakLearner[] = [];

  for (let t = 0; t < nEstimators; t++) {
    const stump = fitStump(samples, sampleWeights);

    // Calculate error
    let error = 0;
    for (let i = 0; i < n; i++) {
      const pred = samples[i].features[stump.featureIdx] <= stump.threshold
        ? stump.leftPred >= 0.5 ? 1 : 0
        : stump.rightPred >= 0.5 ? 1 : 0;
      if (pred !== samples[i].label) error += sampleWeights[i];
    }

    error = Math.max(1e-10, Math.min(1 - 1e-10, error));
    const alpha = 0.5 * Math.log((1 - error) / error);

    // Update weights
    let wSum = 0;
    for (let i = 0; i < n; i++) {
      const pred = samples[i].features[stump.featureIdx] <= stump.threshold
        ? stump.leftPred >= 0.5 ? 1 : 0
        : stump.rightPred >= 0.5 ? 1 : 0;
      sampleWeights[i] *= Math.exp(-alpha * (samples[i].label === 1 ? 1 : -1) * (pred === 1 ? 1 : -1));
      wSum += sampleWeights[i];
    }
    sampleWeights = sampleWeights.map(w => w / wSum);

    learners.push({ stump, alpha });
    if (error < 0.01) break; // perfect classifier
  }

  return learners;
}

function predictAdaBoost(learners: WeakLearner[], features: number[]): number {
  let score = 0;
  for (const { stump, alpha } of learners) {
    const pred = features[stump.featureIdx] <= stump.threshold
      ? stump.leftPred >= 0.5 ? 1 : -1
      : stump.rightPred >= 0.5 ? 1 : -1;
    score += alpha * pred;
  }
  return score > 0 ? 1 : 0;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function evaluate(
  testSamples: Sample[],
  predict: (features: number[]) => number,
  threshold = 0.5
): { wr: number; trades: number } {
  let wins = 0;
  for (const s of testSamples) {
    const p = predict(s.features);
    const pred = typeof p === 'number' && p <= 1 ? (p >= threshold ? 1 : 0) : p;
    if (pred === s.label) wins++;
  }
  return { wr: testSamples.length > 0 ? wins / testSamples.length * 100 : 0, trades: testSamples.length };
}

// ── Feature importance (for LR — by |weight|) ────────────────────────────────

function featureImportance(weights: number[]): Array<{ name: string; weight: number }> {
  return FEATURE_NAMES
    .map((name, i) => ({ name, weight: Math.abs(weights[i + 1]) }))
    .sort((a, b) => b.weight - a.weight);
}

// ── Walk-forward ML evaluation ────────────────────────────────────────────────

function walkForwardML(symbol: string, timeframe: string) {
  const candles = getCandles(symbol, timeframe);
  const trainEnd = Math.floor(candles.length * 0.7);
  const testLen = candles.length - trainEnd;
  const foldSize = Math.floor(testLen / 3);

  const results: Array<{ fold: number; lr: number; ada: number; trades: number; baseline: number }> = [];

  for (let fold = 0; fold < 3; fold++) {
    const foldStart = trainEnd + fold * foldSize;
    const foldEnd = fold < 2 ? foldStart + foldSize : candles.length - 1;

    // Train on all data BEFORE this fold (walk-forward)
    const trainSamples = buildDataset(candles, 30, foldStart);
    const testSamples = buildDataset(candles, foldStart, foldEnd);

    if (trainSamples.length < 50 || testSamples.length < 10) {
      results.push({ fold: fold + 1, lr: 0, ada: 0, trades: 0, baseline: 0 });
      continue;
    }

    // Train LR
    const lrWeights = trainLogisticRegression(trainSamples, 200, 0.1, 0.01);

    // Train AdaBoost
    const adaLearners = trainAdaBoost(trainSamples, 30);

    // Evaluate
    const baseline = testSamples.filter(s => s.label === 1).length / testSamples.length * 100;

    // LR with threshold tuning (use 0.55 for higher precision)
    const lrResult = evaluate(testSamples, f => predictLR(lrWeights, f), 0.55);

    // AdaBoost
    const adaResult = evaluate(testSamples, f => predictAdaBoost(adaLearners, f) as number);

    results.push({
      fold: fold + 1,
      lr: lrResult.wr,
      ada: adaResult.wr,
      trades: lrResult.trades,
      baseline,
    });
  }

  return results;
}

// ── High-confidence filter: only predict when model is very confident ─────────

function walkForwardHighConf(symbol: string, timeframe: string, threshold: number) {
  const candles = getCandles(symbol, timeframe);
  const trainEnd = Math.floor(candles.length * 0.7);
  const testLen = candles.length - trainEnd;
  const foldSize = Math.floor(testLen / 3);

  let totalWins = 0, totalTrades = 0;

  for (let fold = 0; fold < 3; fold++) {
    const foldStart = trainEnd + fold * foldSize;
    const foldEnd = fold < 2 ? foldStart + foldSize : candles.length - 1;

    const trainSamples = buildDataset(candles, 30, foldStart);
    const testSamples = buildDataset(candles, foldStart, foldEnd);

    if (trainSamples.length < 50) continue;

    const weights = trainLogisticRegression(trainSamples, 300, 0.05, 0.01);

    for (const s of testSamples) {
      const prob = predictLR(weights, s.features);
      if (prob >= threshold) {
        totalTrades++;
        if (s.label === 1) totalWins++;
      }
    }
  }

  return {
    wr: totalTrades > 0 ? totalWins / totalTrades * 100 : 0,
    trades: totalTrades,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════');
console.log('🤖 ML RESEARCH — FEATURE-ENGINEERED MODELS');
console.log('══════════════════════════════════════════════════════════════');
console.log(`Features (${FEATURE_NAMES.length}): ${FEATURE_NAMES.join(', ')}\n`);

// ── Part 1: Walk-forward ML comparison ───────────────────────────────────────

console.log('═══ PART 1: WALK-FORWARD ML COMPARISON (3 folds)');
console.log('   Training on expanding window, testing on next fold');
console.log('   Only using signal candidates (price outside BB) as input\n');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m'], ['BTC', '15m']] as const) {
  console.log(`${sym}/${tf}:`);
  const res = walkForwardML(sym, tf);
  console.log(`  Fold | LR@0.55 | AdaBoost | Trades | Baseline`);
  for (const r of res) {
    const lrStar = r.lr > 65 ? ' ⭐' : r.lr > 60 ? ' ✓' : '';
    const adaStar = r.ada > 65 ? ' ⭐' : r.ada > 60 ? ' ✓' : '';
    console.log(`  F${r.fold}   | ${r.lr.toFixed(1)}%${lrStar.padEnd(3)} | ${r.ada.toFixed(1)}%${adaStar.padEnd(3)} | ${r.trades}   | ${r.baseline.toFixed(1)}%`);
  }
}

// ── Part 2: High-confidence prediction filter ─────────────────────────────────

console.log('\n═══ PART 2: HIGH-CONFIDENCE FILTER (LR probability threshold)');
console.log('   Only trade when model is very confident\n');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m'], ['BTC', '15m']] as const) {
  console.log(`${sym}/${tf}:`);
  for (const thr of [0.55, 0.60, 0.65, 0.70]) {
    const r = walkForwardHighConf(sym, tf, thr);
    const star = r.wr > 70 ? ' ⭐⭐' : r.wr > 65 ? ' ⭐' : '';
    console.log(`  thr=${thr}: WR=${r.wr.toFixed(1)}% T=${r.trades}${star}`);
  }
}

// ── Part 3: Feature importance ────────────────────────────────────────────────

console.log('\n═══ PART 3: FEATURE IMPORTANCE (ETH/5m LR weights)');
console.log('   Absolute weight magnitude = importance\n');

{
  const candles = getCandles('ETH', '5m');
  const trainEnd = Math.floor(candles.length * 0.7);
  const samples = buildDataset(candles, 30, trainEnd);
  console.log(`  Training samples: ${samples.length}`);
  const weights = trainLogisticRegression(samples, 300, 0.05, 0.01);
  const importance = featureImportance(weights);
  importance.slice(0, 12).forEach((f, i) => {
    const bar = '█'.repeat(Math.round(f.weight * 20 / importance[0].weight));
    console.log(`  ${(i + 1).toString().padStart(2)}. ${f.name.padEnd(20)} ${bar} (${f.weight.toFixed(4)})`);
  });
}

// ── Part 4: Combining ML with hour filter ─────────────────────────────────────

console.log('\n═══ PART 4: ML FILTERED WITH HOUR FILTER [10,11,12,21]');
console.log('   Only apply ML model during good hours\n');

{
  const candles = getCandles('ETH', '5m');
  const trainEnd = Math.floor(candles.length * 0.7);
  const testLen = candles.length - trainEnd;
  const foldSize = Math.floor(testLen / 3);
  const goodHours = [10, 11, 12, 21];

  let totalWins = 0, totalTrades = 0;
  let baseWins = 0, baseTrades = 0;

  for (let fold = 0; fold < 3; fold++) {
    const foldStart = trainEnd + fold * foldSize;
    const foldEnd = fold < 2 ? foldStart + foldSize : candles.length - 1;

    const trainSamples = buildDataset(candles, 30, foldStart);
    const testSamples = buildDataset(candles, foldStart, foldEnd);

    if (trainSamples.length < 50) continue;
    const weights = trainLogisticRegression(trainSamples, 200, 0.1, 0.01);

    for (let i = foldStart; i < foldEnd - 1; i++) {
      const c = candles[i];
      const hour = new Date(c.open_time).getUTCHours();
      if (!goodHours.includes(hour)) continue;

      const bb = calcBB(candles, i, 20, 2.2); // BB(20,2.2) for good hours
      if (!bb) continue;
      const price = c.close;
      if (price <= bb.upper && price >= bb.lower) continue;

      // Count streak ≥ 2
      let g = 0, r = 0;
      for (let j = i; j >= Math.max(0, i - 5); j--) {
        const cj = candles[j];
        if (cj.close > cj.open) { if (r > 0) break; g++; }
        else if (cj.close < cj.open) { if (g > 0) break; r++; }
        else break;
      }
      if (g < 2 && r < 2) continue;

      // Base (no ML)
      const nextC = candles[i + 1];
      const baseWin = price > bb.upper ? nextC.close < nextC.open : nextC.close > nextC.open;
      baseTrades++;
      if (baseWin) baseWins++;

      // With ML filter
      const atr = calcATR(candles, i);
      const bb20_2 = calcBB(candles, i, 20, 2);
      if (!bb20_2) continue;

      const atrs: number[] = [];
      for (let k = Math.max(0, i - 100); k <= i; k++) atrs.push(calcATR(candles, k));
      atrs.sort((a, b) => a - b);
      const atrPct = atrs.filter(a => a <= atr).length / atrs.length;

      const features = extractFeatures(candles, i, bb20_2, atr, atrPct);
      if (!features) continue;

      const prob = predictLR(weights, features);
      if (prob >= 0.58) { // moderate confidence threshold for good hours
        totalTrades++;
        if (baseWin) totalWins++;
      }
    }
  }

  console.log(`  Base (GoodH+BB(20,2.2)+streak≥2): WR=${(baseTrades > 0 ? baseWins/baseTrades*100 : 0).toFixed(1)}% T=${baseTrades}`);
  console.log(`  ML filtered (thr=0.58): WR=${(totalTrades > 0 ? totalWins/totalTrades*100 : 0).toFixed(1)}% T=${totalTrades}`);
  console.log('  → Does adding ML filter improve our best signal?');
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ ML RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
console.log('\nKey takeaways:');
console.log('  - LR >60%: ML adds value over pure signal count');
console.log('  - High confidence filter: fewer trades but higher WR?');
console.log('  - Feature importance: which indicators truly drive the edge?');
console.log('  - GoodHour+ML: stacking ML on top of our best signal?');
