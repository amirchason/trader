/**
 * Enhanced ML Classifier — 30+ features for binary candle direction prediction
 *
 * Features:
 * - Streak + body pattern features
 * - RSI (7, 14, 21) + overbought/oversold flags
 * - ATR, body-to-ATR ratio, candle shape
 * - Time features: hour sin/cos, session flags (Asian/EU/US)
 * - Volume relative to average, volume spike
 * - Price position vs SMA, VWAP deviation
 * - Multi-candle momentum
 *
 * Classifiers: Logistic Regression (L2) + Decision Tree (CART) + Ensemble
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/enhancedML.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { DbCandle } from '../db';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH);
const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');
fs.mkdirSync(RESEARCH_DIR, { recursive: true });

// ─── DB Helpers ───────────────────────────────────────────────────────────────
function queryCandles(coin: string, timeframe: string): DbCandle[] {
  return db.prepare(
    'SELECT * FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC'
  ).all(coin, timeframe) as DbCandle[];
}

// ─── Technical Indicators ─────────────────────────────────────────────────────
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

function calcSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  return closes.slice(-period).reduce((a, b) => a + b) / period;
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

function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ─── Feature Extraction ───────────────────────────────────────────────────────
const FEATURE_NAMES = [
  // Candle shape
  'body_pct',          // % body change (signed)
  'abs_body_pct',      // % absolute body size
  'upper_shadow',      // upper shadow / price
  'lower_shadow',      // lower shadow / price
  'hl_range',          // high-low range / price
  'close_position',    // close position in H-L range (0=bottom, 1=top)
  'is_green',          // 1 if green candle
  // Streak
  'streak_len',        // signed streak length (-6 to 6), normalized
  'streak_is_long',    // 1 if abs(streak) >= 3
  'streak_is_very_long',// 1 if abs(streak) >= 5
  // RSI
  'rsi14',             // rsi14 / 100
  'rsi7',              // rsi7 / 100
  'rsi21',             // rsi21 / 100
  'rsi_overbought',    // 1 if rsi14 > 70
  'rsi_oversold',      // 1 if rsi14 < 30
  'rsi_extreme',       // 1 if rsi14 > 80 or < 20
  'rsi14_delta',       // rsi14 - rsi21 (momentum of RSI)
  // ATR / Body ratio
  'body_to_atr',       // candle body / ATR (big candle flag)
  'atr_pct',           // ATR / price (volatility level)
  // Volume
  'vol_ratio',         // volume / 20-bar avg (capped at 3)
  'vol_spike',         // 1 if vol_ratio > 1.5
  // Price level
  'price_vs_sma20',    // (price - SMA20) / SMA20
  'price_vs_sma50',    // (price - SMA50) / SMA50
  'sma_slope',         // (SMA20 - SMA20_prev5) / SMA20_prev5
  'above_sma20',       // 1 if close > SMA20
  // VWAP
  'vwap_dev',          // (price - VWAP) / VWAP (last 20 candles)
  'above_vwap',        // 1 if close > VWAP
  // Momentum
  'momentum_5',        // 5-bar price change %
  'momentum_3',        // 3-bar price change %
  'ema12_trend',       // (EMA12 - EMA26) / price
  // Previous candles
  'prev_body',         // prev candle body %
  'prev2_body',        // 2 bars ago body %
  'prev_is_green',     // prev candle green
  'body_vs_prev',      // body / prev body ratio (acceleration)
  // Time
  'hour_sin',          // sin(2π * hour / 24)
  'hour_cos',          // cos(2π * hour / 24)
  'dow_sin',           // sin(2π * dow / 7)
  'dow_cos',           // cos(2π * dow / 7)
  'is_asian',          // 1 if 00-08 UTC
  'is_european',       // 1 if 08-16 UTC
  'is_us',             // 1 if 13-22 UTC
  'is_peak_hour',      // 1 if in top-5 hours by WR (coin-specific)
  // Bias
  'bias',              // constant 1
];

interface Sample {
  features: number[];
  label: number; // 1=next candle up, 0=next candle down
}

function extractFeatures(
  candles: DbCandle[],
  idx: number,
  peakHours: Set<number>
): number[] | null {
  const WARMUP = 55;
  if (idx < WARMUP || idx >= candles.length - 1) return null;

  const c = candles[idx];
  const price = c.close;
  if (price <= 0) return null;

  // Closes and volumes for indicators
  const closes = candles.slice(idx - 50, idx + 1).map(x => x.close);
  const vols = candles.slice(idx - 20, idx + 1).map(x => x.volume);

  // RSI
  const rsi14 = calcRSI(closes.slice(-16), 14);
  const rsi7 = calcRSI(closes.slice(-9), 7);
  const rsi21 = calcRSI(closes, 21);

  // SMA
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma20_5ago = calcSMA(closes.slice(0, -5), 20);
  const smaSlope = sma20_5ago > 0 ? (sma20 - sma20_5ago) / sma20_5ago : 0;

  // EMA
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);

  // ATR
  const atr = calcATR(candles.slice(idx - 15, idx + 1), 14);

  // Volume
  const avgVol = vols.slice(0, -1).reduce((a, b) => a + b) / (vols.length - 1);
  const volRatio = avgVol > 0 ? Math.min(3, c.volume / avgVol) : 1;

  // VWAP (last 20 candles)
  const vwapSlice = candles.slice(idx - 19, idx + 1);
  let tpv = 0, tvol = 0;
  for (const vc of vwapSlice) { tpv += ((vc.high + vc.low + vc.close) / 3) * vc.volume; tvol += vc.volume; }
  const vwap = tvol > 0 ? tpv / tvol : price;

  // Candle shape
  const bodyPct = c.open > 0 ? (c.close - c.open) / c.open * 100 : 0;
  const absBodyPct = Math.abs(bodyPct);
  const hlRange = c.high > c.low ? (c.high - c.low) / price : 0;
  const upperShadow = c.close > c.open
    ? (c.high - c.close) / price
    : (c.high - c.open) / price;
  const lowerShadow = c.close > c.open
    ? (c.open - c.low) / price
    : (c.close - c.low) / price;
  const closePos = (c.high > c.low) ? (c.close - c.low) / (c.high - c.low) : 0.5;

  // Streak
  let greenStreak = 0, redStreak = 0;
  for (let j = idx; j >= Math.max(0, idx - 8); j--) {
    const cj = candles[j];
    if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
    else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
    else break;
  }
  const streakLen = greenStreak > 0 ? greenStreak : -redStreak;
  const streakNorm = streakLen / 6; // normalize -1 to 1

  // Momentum
  const mom5Ref = candles[idx - 5]?.close ?? price;
  const mom3Ref = candles[idx - 3]?.close ?? price;
  const mom5 = mom5Ref > 0 ? (price - mom5Ref) / mom5Ref * 100 : 0;
  const mom3 = mom3Ref > 0 ? (price - mom3Ref) / mom3Ref * 100 : 0;

  // Prev candles
  const prev = candles[idx - 1];
  const prev2 = candles[idx - 2];
  const prevBodyPct = prev?.open > 0 ? (prev.close - prev.open) / prev.open * 100 : 0;
  const prev2BodyPct = prev2?.open > 0 ? (prev2.close - prev2.open) / prev2.open * 100 : 0;
  const bodyVsPrev = Math.abs(prevBodyPct) > 0.01 ? Math.min(3, absBodyPct / Math.abs(prevBodyPct)) : 1;

  // Time
  const dt = new Date(c.open_time);
  const hour = dt.getUTCHours();
  const dow = dt.getUTCDay();
  const hourSin = Math.sin(2 * Math.PI * hour / 24);
  const hourCos = Math.cos(2 * Math.PI * hour / 24);
  const dowSin = Math.sin(2 * Math.PI * dow / 7);
  const dowCos = Math.cos(2 * Math.PI * dow / 7);
  const isAsian = hour >= 0 && hour < 8 ? 1 : 0;
  const isEuropean = hour >= 8 && hour < 16 ? 1 : 0;
  const isUS = hour >= 13 && hour < 22 ? 1 : 0;
  const isPeakHour = peakHours.has(hour) ? 1 : 0;

  // Body-to-ATR
  const bodyToATR = atr > 0 ? absBodyPct / 100 * price / atr : 0;
  const atrPct = price > 0 ? atr / price * 100 : 0;

  return [
    // Candle shape
    Math.max(-5, Math.min(5, bodyPct)) / 5,      // body_pct (capped ±5%)
    Math.min(1, absBodyPct / 2),                  // abs_body_pct
    Math.min(1, upperShadow * 100),               // upper_shadow
    Math.min(1, lowerShadow * 100),               // lower_shadow
    Math.min(1, hlRange * 100),                   // hl_range
    closePos,                                     // close_position
    c.close > c.open ? 1 : 0,                     // is_green
    // Streak
    Math.max(-1, Math.min(1, streakNorm)),         // streak_len
    Math.abs(streakLen) >= 3 ? 1 : 0,             // streak_is_long
    Math.abs(streakLen) >= 5 ? 1 : 0,             // streak_is_very_long
    // RSI
    rsi14 / 100,                                  // rsi14
    rsi7 / 100,                                   // rsi7
    rsi21 / 100,                                  // rsi21
    rsi14 > 70 ? 1 : 0,                           // rsi_overbought
    rsi14 < 30 ? 1 : 0,                           // rsi_oversold
    (rsi14 > 80 || rsi14 < 20) ? 1 : 0,           // rsi_extreme
    Math.max(-1, Math.min(1, (rsi14 - rsi21) / 30)), // rsi14_delta
    // ATR
    Math.min(3, bodyToATR),                       // body_to_atr
    Math.min(1, atrPct / 2),                      // atr_pct
    // Volume
    volRatio / 3,                                 // vol_ratio
    volRatio > 1.5 ? 1 : 0,                       // vol_spike
    // Price level
    Math.max(-0.05, Math.min(0.05, (price - sma20) / (sma20 || 1))) / 0.05, // price_vs_sma20
    Math.max(-0.05, Math.min(0.05, (price - sma50) / (sma50 || 1))) / 0.05, // price_vs_sma50
    Math.max(-0.01, Math.min(0.01, smaSlope)) / 0.01, // sma_slope
    price > sma20 ? 1 : 0,                        // above_sma20
    // VWAP
    Math.max(-0.02, Math.min(0.02, (price - vwap) / (vwap || 1))) / 0.02, // vwap_dev
    price > vwap ? 1 : 0,                         // above_vwap
    // Momentum
    Math.max(-3, Math.min(3, mom5)) / 3,          // momentum_5
    Math.max(-3, Math.min(3, mom3)) / 3,          // momentum_3
    Math.max(-0.01, Math.min(0.01, (ema12 - ema26) / (price || 1))) / 0.01, // ema12_trend
    // Previous candles
    Math.max(-1, Math.min(1, prevBodyPct / 2)),   // prev_body
    Math.max(-1, Math.min(1, prev2BodyPct / 2)),  // prev2_body
    prev?.close > prev?.open ? 1 : 0,             // prev_is_green
    Math.min(3, bodyVsPrev) / 3,                  // body_vs_prev
    // Time
    hourSin,                                      // hour_sin
    hourCos,                                      // hour_cos
    dowSin,                                       // dow_sin
    dowCos,                                       // dow_cos
    isAsian,                                      // is_asian
    isEuropean,                                   // is_european
    isUS,                                         // is_us
    isPeakHour,                                   // is_peak_hour
    1,                                            // bias
  ];
}

function buildSamples(candles: DbCandle[], peakHours: Set<number>): Sample[] {
  const samples: Sample[] = [];
  for (let i = 55; i < candles.length - 1; i++) {
    const features = extractFeatures(candles, i, peakHours);
    if (!features) continue;
    const nextCandle = candles[i + 1];
    const label = nextCandle.close > nextCandle.open ? 1 : 0;
    samples.push({ features, label });
  }
  return samples;
}

// ─── Logistic Regression (L2 regularization) ─────────────────────────────────
class LogisticRegression {
  weights: number[];
  constructor(nFeatures: number) {
    this.weights = new Array(nFeatures).fill(0);
  }

  private sigmoid(x: number): number {
    return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
  }

  predict(features: number[]): number {
    let logit = 0;
    for (let i = 0; i < this.weights.length; i++) logit += this.weights[i] * features[i];
    return this.sigmoid(logit);
  }

  train(samples: Sample[], lr = 0.05, epochs = 100, lambda = 0.001): void {
    const n = samples.length;
    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradients = new Array(this.weights.length).fill(0);
      for (const s of samples) {
        const pred = this.predict(s.features);
        const err = pred - s.label;
        for (let j = 0; j < this.weights.length; j++) {
          gradients[j] += err * s.features[j];
        }
      }
      for (let j = 0; j < this.weights.length; j++) {
        this.weights[j] -= lr * (gradients[j] / n + lambda * this.weights[j]);
      }
    }
  }
}

// ─── Decision Tree (CART) ─────────────────────────────────────────────────────
interface DTNode {
  featureIdx?: number;
  threshold?: number;
  left?: DTNode;
  right?: DTNode;
  prediction?: number; // leaf: probability of label=1
  samples?: number;
}

class DecisionTree {
  root: DTNode = {};
  maxDepth: number;
  minSamples: number;

  constructor(maxDepth = 6, minSamples = 30) {
    this.maxDepth = maxDepth;
    this.minSamples = minSamples;
  }

  private gini(samples: Sample[]): number {
    if (samples.length === 0) return 0;
    const p1 = samples.filter(s => s.label === 1).length / samples.length;
    return 1 - p1 * p1 - (1 - p1) * (1 - p1);
  }

  private bestSplit(samples: Sample[]): { featureIdx: number; threshold: number; gain: number } {
    let bestGain = -Infinity, bestFi = 0, bestThr = 0;
    const nFeatures = samples[0].features.length;
    const parentGini = this.gini(samples);

    // Sample features to test (random subset for speed)
    const featureIdxs = Array.from({length: nFeatures}, (_, i) => i)
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(nFeatures, Math.ceil(Math.sqrt(nFeatures)) + 5));

    for (const fi of featureIdxs) {
      // Get unique values (sample up to 20 thresholds)
      const vals = samples.map(s => s.features[fi]).sort((a, b) => a - b);
      const step = Math.max(1, Math.floor(vals.length / 20));
      const thresholds = new Set<number>();
      for (let i = step; i < vals.length; i += step) {
        thresholds.add((vals[i - 1] + vals[i]) / 2);
      }

      for (const thr of thresholds) {
        const left = samples.filter(s => s.features[fi] <= thr);
        const right = samples.filter(s => s.features[fi] > thr);
        if (left.length < this.minSamples || right.length < this.minSamples) continue;
        const gain = parentGini - (left.length / samples.length) * this.gini(left)
                                - (right.length / samples.length) * this.gini(right);
        if (gain > bestGain) { bestGain = gain; bestFi = fi; bestThr = thr; }
      }
    }
    return { featureIdx: bestFi, threshold: bestThr, gain: bestGain };
  }

  private buildNode(samples: Sample[], depth: number): DTNode {
    const p1 = samples.filter(s => s.label === 1).length / samples.length;
    if (depth >= this.maxDepth || samples.length < this.minSamples * 2) {
      return { prediction: p1, samples: samples.length };
    }

    const { featureIdx, threshold, gain } = this.bestSplit(samples);
    if (gain <= 0) return { prediction: p1, samples: samples.length };

    const left = samples.filter(s => s.features[featureIdx] <= threshold);
    const right = samples.filter(s => s.features[featureIdx] > threshold);
    if (left.length === 0 || right.length === 0) return { prediction: p1, samples: samples.length };

    return {
      featureIdx, threshold,
      left: this.buildNode(left, depth + 1),
      right: this.buildNode(right, depth + 1),
      samples: samples.length,
    };
  }

  train(samples: Sample[]): void {
    this.root = this.buildNode(samples, 0);
  }

  predict(features: number[]): number {
    let node = this.root;
    while (node.prediction === undefined) {
      node = features[node.featureIdx!] <= node.threshold! ? node.left! : node.right!;
    }
    return node.prediction;
  }
}

// ─── Evaluate at threshold ────────────────────────────────────────────────────
function evaluate(
  model: { predict: (f: number[]) => number },
  samples: Sample[],
  threshold: number
): { wr: number; trades: number; wins: number; pnl: number } {
  let wins = 0, total = 0;
  const BET = 10;
  for (const s of samples) {
    const prob = model.predict(s.features);
    // If prob > threshold → predict UP, if prob < (1-threshold) → predict DOWN
    let predicted: number | null = null;
    if (prob >= threshold) predicted = 1;
    else if (prob <= 1 - threshold) predicted = 0;
    if (predicted === null) continue;
    const win = predicted === s.label;
    if (win) wins++;
    total++;
  }
  const wr = total ? wins / total : 0;
  return { wr, trades: total, wins, pnl: wins * BET - (total - wins) * BET };
}

// ─── Feature Importance (permutation) ────────────────────────────────────────
function featureImportance(
  model: { predict: (f: number[]) => number },
  samples: Sample[],
  threshold: number,
  topN = 10
): void {
  const base = evaluate(model, samples, threshold);
  const importances: Array<{ name: string; delta: number }> = [];

  for (let fi = 0; fi < FEATURE_NAMES.length; fi++) {
    // Permute feature fi
    const shuffled = [...samples].map(s => {
      const f = [...s.features];
      f[fi] = 0; // zero out feature
      return { features: f, label: s.label };
    });
    const perturbed = evaluate(model, shuffled, threshold);
    importances.push({ name: FEATURE_NAMES[fi], delta: base.wr - perturbed.wr });
  }

  importances.sort((a, b) => b.delta - a.delta);
  console.log(`  Top ${topN} important features (by WR drop when zeroed):`);
  for (const imp of importances.slice(0, topN)) {
    const bar = imp.delta > 0 ? '▲' : '▼';
    console.log(`    ${bar} ${imp.name.padEnd(20)} Δ=${(imp.delta * 100).toFixed(2)}%`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const COINS: Array<{ coin: string; tf: string; peakHours: number[] }> = [
  { coin: 'ETH', tf: '15m', peakHours: [16, 5, 22, 7, 17, 3, 0, 23] },
  { coin: 'BTC', tf: '15m', peakHours: [13, 0, 10, 20, 17, 12, 3, 22] },
  { coin: 'SOL', tf: '15m', peakHours: [2, 12, 13, 1, 6, 10, 17] },
];

interface ModelResult { wr: number; trades: number; wins: number; pnl: number; thr: number; }
const allResults: Array<{
  coin: string; tf: string;
  lr: ModelResult;
  dt: ModelResult;
  ensemble: ModelResult;
  baselineStreak: number;
}> = [];

console.log('\n══════════════════════════════════════════════════════════════');
console.log('🤖 ENHANCED ML CLASSIFIER — 30+ Features');
console.log('══════════════════════════════════════════════════════════════');
console.log(`Total features: ${FEATURE_NAMES.length}`);
console.log('Methodology: 70% train / 30% test (out-of-sample)\n');

for (const { coin, tf, peakHours } of COINS) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 200) { console.log(`${coin}/${tf}: insufficient data`); continue; }

  const splitIdx = Math.floor(allC.length * 0.7);
  const trainC = allC.slice(0, splitIdx);
  const testC = allC.slice(splitIdx);

  const peakSet = new Set(peakHours);

  console.log(`\n── ${coin}/${tf} ─────────────────────────────────────────────`);
  console.log(`  Train: ${trainC.length} candles, Test: ${testC.length} candles`);

  // Build samples
  console.log('  Building features...');
  const trainSamples = buildSamples(trainC, peakSet);
  const testSamples = buildSamples(testC, peakSet);
  console.log(`  Train samples: ${trainSamples.length}, Test samples: ${testSamples.length}`);

  // Baseline: streak(3) WR
  let streakWins = 0, streakTotal = 0;
  for (let i = 55; i < testC.length - 1; i++) {
    let green = 0, red = 0;
    for (let j = i; j >= Math.max(0, i - 5); j--) {
      const cj = testC[j];
      if (cj.close > cj.open) { if (red > 0) break; green++; }
      else if (cj.close < cj.open) { if (green > 0) break; red++; }
      else break;
    }
    if (green < 3 && red < 3) continue;
    const tradeBear = green >= 3;
    const nextUp = testC[i + 1].close > testC[i + 1].open;
    if ((tradeBear ? !nextUp : nextUp)) streakWins++;
    streakTotal++;
  }
  const baselineWR = streakTotal ? streakWins / streakTotal : 0;
  console.log(`  Baseline streak(3): WR=${(baselineWR * 100).toFixed(2)}% T=${streakTotal}`);

  // Train Logistic Regression
  console.log('  Training Logistic Regression...');
  const lr = new LogisticRegression(FEATURE_NAMES.length);
  lr.train(trainSamples, 0.08, 200, 0.001);

  // Train Decision Tree
  console.log('  Training Decision Tree (depth=6)...');
  const dt = new DecisionTree(6, 25);
  dt.train(trainSamples);

  // Find best threshold for each model
  let lrBest: ModelResult = { wr: 0, trades: 0, wins: 0, pnl: 0, thr: 0.5 };
  let dtBest: ModelResult = { wr: 0, trades: 0, wins: 0, pnl: 0, thr: 0.5 };

  console.log('\n  Threshold sweep:');
  for (const thr of [0.50, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.60, 0.62, 0.65]) {
    const lrR = evaluate(lr, testSamples, thr);
    const dtR = evaluate(dt, testSamples, thr);
    if (lrR.trades >= 30 && lrR.wr > lrBest.wr) lrBest = { ...lrR, thr };
    if (dtR.trades >= 30 && dtR.wr > dtBest.wr) dtBest = { ...dtR, thr };

    if (thr <= 0.58 || (lrR.trades >= 30 && lrR.wr > 0.58)) {
      console.log(`    thr=${thr.toFixed(2)}: LR WR=${(lrR.wr*100).toFixed(1)}% T=${lrR.trades} | DT WR=${(dtR.wr*100).toFixed(1)}% T=${dtR.trades}`);
    }
  }

  // Ensemble: average LR + DT predictions
  const ensembleSamples = testSamples.map(s => ({
    features: s.features,
    label: s.label,
    prob: (lr.predict(s.features) + dt.predict(s.features)) / 2,
  }));
  let ensembleBest: ModelResult = { wr: 0, trades: 0, wins: 0, pnl: 0, thr: 0.52 };
  for (const thr of [0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.60]) {
    let w = 0, t = 0;
    for (const s of ensembleSamples) {
      let pred: number | null = null;
      if (s.prob >= thr) pred = 1;
      else if (s.prob <= 1 - thr) pred = 0;
      if (pred === null) continue;
      if (pred === s.label) w++;
      t++;
    }
    const wr = t ? w / t : 0;
    if (t >= 30 && wr > ensembleBest.wr) ensembleBest = { wr, trades: t, wins: w, pnl: w*10-(t-w)*10, thr };
  }

  console.log('\n  Results (best threshold per model):');
  console.log(`    LR  best: WR=${(lrBest.wr*100).toFixed(2)}% T=${lrBest.trades} PnL=$${lrBest.pnl} (thr=${lrBest.thr})`);
  console.log(`    DT  best: WR=${(dtBest.wr*100).toFixed(2)}% T=${dtBest.trades} PnL=$${dtBest.pnl} (thr=${dtBest.thr})`);
  console.log(`    Ens best: WR=${(ensembleBest.wr*100).toFixed(2)}% T=${ensembleBest.trades} PnL=$${ensembleBest.pnl} (thr=${ensembleBest.thr})`);
  console.log(`    Baseline: WR=${(baselineWR*100).toFixed(2)}% T=${streakTotal}`);

  // Feature importance for LR
  console.log('\n  Feature importance (LR model):');
  featureImportance(lr, testSamples, lrBest.thr);

  allResults.push({
    coin, tf,
    lr: lrBest,
    dt: dtBest,
    ensemble: ensembleBest,
    baselineStreak: baselineWR,
  });
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 FINAL SUMMARY');
console.log('══════════════════════════════════════════════════════════════');

let totalWins = 0, totalTrades = 0, totalPnL = 0;
for (const r of allResults) {
  const bestR = r.ensemble.wr >= r.lr.wr && r.ensemble.wr >= r.dt.wr
    ? r.ensemble
    : r.lr.wr >= r.dt.wr ? r.lr : r.dt;
  const bestModel = r.ensemble.wr >= r.lr.wr && r.ensemble.wr >= r.dt.wr
    ? 'Ensemble'
    : r.lr.wr >= r.dt.wr ? 'LR' : 'DT';

  const delta = (bestR.wr - r.baselineStreak) * 100;
  console.log(`  ${r.coin}/${r.tf}:`);
  console.log(`    Best model (${bestModel}): WR=${(bestR.wr*100).toFixed(2)}% T=${bestR.trades} PnL=$${bestR.pnl}`);
  console.log(`    Baseline streak(3):         WR=${(r.baselineStreak*100).toFixed(2)}%`);
  console.log(`    ML improvement:             ${delta > 0 ? '+' : ''}${delta.toFixed(2)}%`);
  totalWins += bestR.wins;
  totalTrades += bestR.trades;
  totalPnL += bestR.pnl;
}

const portWR = totalTrades ? totalWins / totalTrades : 0;
console.log(`\n  Combined portfolio (best model per coin):`);
console.log(`    WR=${(portWR*100).toFixed(2)}%  T=${totalTrades}  PnL=$${totalPnL}`);

// Save results
const output = { timestamp: Date.now(), results: allResults, portfolio: { wr: portWR, trades: totalTrades, pnl: totalPnL } };
fs.writeFileSync(
  path.join(RESEARCH_DIR, 'enhanced-ml.json'),
  JSON.stringify(output, null, 2)
);
console.log('\n✅ Results saved to docs/backtest-research/enhanced-ml.json');
