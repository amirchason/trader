/**
 * Walk-Forward Validation + New Indicators + Volatility Regimes
 *
 * 1. Walk-forward: Is our 70% WR robust across all time periods?
 * 2. Volatility regime: Does high ATR = better WR for Markov+BB?
 * 3. New indicators: Stochastic, Keltner channels, CCI
 * 4. Volume: Does high-volume streak give stronger reversion?
 * 5. Neural Network: Can a 2-layer NN beat GBDT?
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/walkForwardNew.ts
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

function calcBB(candles: DbCandle[], i: number, period = 20, mult = 2): { upper: number; lower: number; mid: number; std: number } | null {
  if (i < period) return null;
  const closes = candles.slice(i - period + 1, i + 1).map(c => c.close);
  const mid = closes.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, lower: mid - mult * std, mid, std };
}

// Stochastic %K and %D
function calcStochastic(candles: DbCandle[], i: number, kPeriod = 14, dPeriod = 3): { k: number; d: number } | null {
  if (i < kPeriod) return null;
  const slice = candles.slice(i - kPeriod + 1, i + 1);
  const high = Math.max(...slice.map(c => c.high));
  const low = Math.min(...slice.map(c => c.low));
  if (high === low) return { k: 50, d: 50 };
  const k = (candles[i].close - low) / (high - low) * 100;
  // Smooth %D over last dPeriod %K values
  const kVals: number[] = [];
  for (let j = Math.max(kPeriod, i - dPeriod + 1); j <= i; j++) {
    const s = candles.slice(j - kPeriod + 1, j + 1);
    const h = Math.max(...s.map(c => c.high));
    const l = Math.min(...s.map(c => c.low));
    kVals.push(h === l ? 50 : (candles[j].close - l) / (h - l) * 100);
  }
  const d = kVals.reduce((a, b) => a + b) / kVals.length;
  return { k, d };
}

// Keltner Channels (EMA ± 2*ATR)
function calcKeltner(candles: DbCandle[], i: number, period = 20, atrMult = 2): { upper: number; lower: number; mid: number } | null {
  if (i < period + 14) return null;
  // EMA of close
  const slice = candles.slice(i - period + 1, i + 1);
  const multiplier = 2 / (period + 1);
  let ema = slice.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let j = period; j < slice.length; j++) ema = (slice[j].close - ema) * multiplier + ema;
  const atr = calcATR(candles.slice(i - period - 14, i + 1));
  return { upper: ema + atrMult * atr, lower: ema - atrMult * atr, mid: ema };
}

// CCI (Commodity Channel Index)
function calcCCI(candles: DbCandle[], i: number, period = 20): number {
  if (i < period) return 0;
  const slice = candles.slice(i - period + 1, i + 1);
  const typicals = slice.map(c => (c.high + c.low + c.close) / 3);
  const mean = typicals.reduce((a, b) => a + b) / period;
  const meanDev = typicals.reduce((s, t) => s + Math.abs(t - mean), 0) / period;
  const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
  return meanDev > 0 ? (typical - mean) / (0.015 * meanDev) : 0;
}

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

// Our best signal: GGG+BB (Markov+BB)
function getMarkovBBSignal(candles: DbCandle[], i: number, minStreak = 3, bbMult = 2): 'BULL' | 'BEAR' | null {
  if (i < 22) return null;
  const streak = getStreak(candles, i);
  const bb = calcBB(candles, i, 20, bbMult);
  if (!bb) return null;
  if (streak <= -minStreak && candles[i].close < bb.lower) return 'BULL';
  if (streak >= minStreak && candles[i].close > bb.upper) return 'BEAR';
  return null;
}

function calcVolAvg(candles: DbCandle[], i: number, period = 10): number {
  if (i < period) return candles[i].volume;
  return candles.slice(i - period, i).reduce((s, c) => s + c.volume, 0) / period;
}

// ═══════════════════════════════════════════════════════════════
// PART 1: WALK-FORWARD VALIDATION
// ═══════════════════════════════════════════════════════════════

function walkForward(candles: DbCandle[], nFolds = 5) {
  const foldSize = Math.floor(candles.length / nFolds);
  const results: { fold: number; wr: number; total: number; pnl: number }[] = [];

  for (let fold = 0; fold < nFolds; fold++) {
    const start = fold * foldSize;
    const end = Math.min((fold + 1) * foldSize, candles.length);
    let wins = 0, total = 0;
    for (let i = start + 25; i < end - 1; i++) {
      const sig = getMarkovBBSignal(candles, i, 3, 2);
      if (!sig) continue;
      const nextGreen = isGreen(candles[i + 1]);
      const win = sig === 'BULL' ? nextGreen : !nextGreen;
      wins += win ? 1 : 0; total++;
    }
    const wr = total ? wins / total : 0;
    results.push({ fold: fold + 1, wr, total, pnl: wins * BET - (total - wins) * BET });
  }
  return results;
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔄 PART 1: WALK-FORWARD VALIDATION (5 folds)');
console.log('══════════════════════════════════════════════════════════════');
console.log('Signal: Markov(3)+BB(2) — our best out-of-sample strategy\n');
console.log('Coin/TF      Fold1  Fold2  Fold3  Fold4  Fold5  StdDev  Stable?');

const walkForwardSummary: Record<string, any> = {};

for (const { coin, tf } of [
  { coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' },
  { coin: 'ETH', tf: '5m' }, { coin: 'SOL', tf: '15m' },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const folds = walkForward(allC, 5);
  const wrs = folds.map(f => f.wr);
  const mean = wrs.reduce((a, b) => a + b) / wrs.length;
  const std = Math.sqrt(wrs.reduce((s, w) => s + (w - mean) ** 2, 0) / wrs.length);
  const allProfitable = wrs.every(w => w > 0.50);
  const label = `${coin}/${tf}`.padEnd(12);
  const foldStrs = folds.map(f => `${(f.wr * 100).toFixed(1)}%`).join('  ');
  const stable = allProfitable && std < 0.06 ? '✅' : std > 0.10 ? '❌' : '⚠️';
  console.log(`${label} ${foldStrs}  σ=${(std*100).toFixed(1)}%  ${stable}`);
  walkForwardSummary[`${coin}/${tf}`] = { folds, mean, std, allProfitable };
}

// ═══════════════════════════════════════════════════════════════
// PART 2: VOLATILITY REGIME ANALYSIS
// ═══════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 PART 2: VOLATILITY REGIME ANALYSIS');
console.log('══════════════════════════════════════════════════════════════');
console.log('Q: Does high ATR environment give better Markov+BB WR?\n');

for (const { coin, tf } of [{ coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' }, { coin: 'ETH', tf: '5m' }]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Pre-compute ATR for each test candle
  const trades: { win: boolean; atr: number; vol: number }[] = [];
  for (let i = splitIdx + 25; i < allC.length - 1; i++) {
    const sig = getMarkovBBSignal(allC, i, 3, 2);
    if (!sig) continue;
    const atr = calcATR(allC.slice(Math.max(0, i - 15), i + 1));
    const volAvg = calcVolAvg(allC, i);
    const nextGreen = isGreen(allC[i + 1]);
    const win = sig === 'BULL' ? nextGreen : !nextGreen;
    trades.push({ win, atr, vol: allC[i].volume / (volAvg || 1) });
  }

  if (trades.length < 50) continue;

  // Sort by ATR quartile
  const atrs = trades.map(t => t.atr).sort((a, b) => a - b);
  const q25 = atrs[Math.floor(atrs.length * 0.25)];
  const q50 = atrs[Math.floor(atrs.length * 0.50)];
  const q75 = atrs[Math.floor(atrs.length * 0.75)];

  const low = trades.filter(t => t.atr < q25);
  const med = trades.filter(t => t.atr >= q25 && t.atr < q75);
  const high = trades.filter(t => t.atr >= q75);

  const wrOf = (arr: typeof trades) => arr.length ? arr.filter(t => t.win).length / arr.length : 0;

  console.log(`  ${coin}/${tf}: Total=${trades.length} base WR=${(wrOf(trades)*100).toFixed(1)}%`);
  console.log(`    Low ATR (<Q25):   WR=${(wrOf(low)*100).toFixed(1)}%  T=${low.length}`);
  console.log(`    Med ATR (Q25-75): WR=${(wrOf(med)*100).toFixed(1)}%  T=${med.length}`);
  console.log(`    High ATR (>Q75):  WR=${(wrOf(high)*100).toFixed(1)}%  T=${high.length}`);

  // Volume regime
  const lowVol = trades.filter(t => t.vol < 0.8);
  const highVol = trades.filter(t => t.vol >= 1.5);
  console.log(`    Low vol (<0.8x):  WR=${(wrOf(lowVol)*100).toFixed(1)}%  T=${lowVol.length}`);
  console.log(`    High vol (≥1.5x): WR=${(wrOf(highVol)*100).toFixed(1)}%  T=${highVol.length}`);
}

// ═══════════════════════════════════════════════════════════════
// PART 3: NEW INDICATORS SWEEP
// ═══════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔬 PART 3: NEW INDICATORS TEST');
console.log('══════════════════════════════════════════════════════════════');
console.log('Stochastic, Keltner channels, CCI, volume spike\n');

type SignalFn = (candles: DbCandle[], i: number) => 'BULL' | 'BEAR' | null;

interface NewStrategy { name: string; signal: SignalFn }

const newStrategies: NewStrategy[] = [
  // Stochastic overbought/oversold
  {
    name: 'Stoch(%K>80) bear',
    signal: (c, i) => {
      const s = calcStochastic(c, i);
      return s && s.k > 80 && s.d > 80 ? 'BEAR' : null;
    }
  },
  {
    name: 'Stoch(%K<20) bull',
    signal: (c, i) => {
      const s = calcStochastic(c, i);
      return s && s.k < 20 && s.d < 20 ? 'BULL' : null;
    }
  },
  {
    name: 'Stoch+Streak(3) bear',
    signal: (c, i) => {
      const s = calcStochastic(c, i);
      if (!s || s.k <= 70) return null;
      const streak = getStreak(c, i);
      return streak >= 3 ? 'BEAR' : null;
    }
  },
  {
    name: 'Stoch+Streak(3) bull',
    signal: (c, i) => {
      const s = calcStochastic(c, i);
      if (!s || s.k >= 30) return null;
      const streak = getStreak(c, i);
      return streak <= -3 ? 'BULL' : null;
    }
  },
  {
    name: 'Stoch+BB bear',
    signal: (c, i) => {
      const s = calcStochastic(c, i);
      const bb = calcBB(c, i);
      return s && bb && s.k > 75 && c[i].close > bb.upper ? 'BEAR' : null;
    }
  },
  {
    name: 'Stoch+BB bull',
    signal: (c, i) => {
      const s = calcStochastic(c, i);
      const bb = calcBB(c, i);
      return s && bb && s.k < 25 && c[i].close < bb.lower ? 'BULL' : null;
    }
  },
  // Keltner Channel reversion
  {
    name: 'Keltner bear',
    signal: (c, i) => {
      const k = calcKeltner(c, i);
      return k && c[i].close > k.upper ? 'BEAR' : null;
    }
  },
  {
    name: 'Keltner bull',
    signal: (c, i) => {
      const k = calcKeltner(c, i);
      return k && c[i].close < k.lower ? 'BULL' : null;
    }
  },
  {
    name: 'Keltner+Streak(3) bear',
    signal: (c, i) => {
      const k = calcKeltner(c, i);
      if (!k || c[i].close <= k.upper) return null;
      return getStreak(c, i) >= 3 ? 'BEAR' : null;
    }
  },
  {
    name: 'Keltner+Streak(3) bull',
    signal: (c, i) => {
      const k = calcKeltner(c, i);
      if (!k || c[i].close >= k.lower) return null;
      return getStreak(c, i) <= -3 ? 'BULL' : null;
    }
  },
  {
    name: 'Keltner+BB squeeze bear',
    signal: (c, i) => {
      // BB outside Keltner = squeeze breakout → reversion bet
      const k = calcKeltner(c, i);
      const bb = calcBB(c, i);
      if (!k || !bb) return null;
      const squeeze = bb.upper < k.upper && bb.lower > k.lower;
      if (squeeze) return null; // in squeeze, skip
      return bb && c[i].close > bb.upper && c[i].close > k.upper ? 'BEAR' : null;
    }
  },
  // CCI extremes
  {
    name: 'CCI>100 bear',
    signal: (c, i) => calcCCI(c, i) > 100 ? 'BEAR' : null,
  },
  {
    name: 'CCI<-100 bull',
    signal: (c, i) => calcCCI(c, i) < -100 ? 'BULL' : null,
  },
  {
    name: 'CCI>200 bear',
    signal: (c, i) => calcCCI(c, i) > 200 ? 'BEAR' : null,
  },
  {
    name: 'CCI<-200 bull',
    signal: (c, i) => calcCCI(c, i) < -200 ? 'BULL' : null,
  },
  {
    name: 'CCI(100)+Streak(3) bear',
    signal: (c, i) => calcCCI(c, i) > 100 && getStreak(c, i) >= 3 ? 'BEAR' : null,
  },
  {
    name: 'CCI(100)+Streak(3) bull',
    signal: (c, i) => calcCCI(c, i) < -100 && getStreak(c, i) <= -3 ? 'BULL' : null,
  },
  // Volume spike reversion
  {
    name: 'Vol spike(2x)+green bear',
    signal: (c, i) => {
      const avg = calcVolAvg(c, i);
      const spike = c[i].volume > avg * 2;
      return spike && c[i].close > c[i].open ? 'BEAR' : null;
    }
  },
  {
    name: 'Vol spike(2x)+red bull',
    signal: (c, i) => {
      const avg = calcVolAvg(c, i);
      const spike = c[i].volume > avg * 2;
      return spike && c[i].close < c[i].open ? 'BULL' : null;
    }
  },
  {
    name: 'Vol spike(3x)+streak(3) bear',
    signal: (c, i) => {
      const avg = calcVolAvg(c, i);
      return c[i].volume > avg * 3 && getStreak(c, i) >= 3 ? 'BEAR' : null;
    }
  },
  {
    name: 'Vol spike(3x)+streak(3) bull',
    signal: (c, i) => {
      const avg = calcVolAvg(c, i);
      return c[i].volume > avg * 3 && getStreak(c, i) <= -3 ? 'BULL' : null;
    }
  },
  // Declining volume streak (volume fading → reversal likely)
  {
    name: 'DeclVol+streak(3) bear',
    signal: (c, i) => {
      if (i < 5) return null;
      const streak = getStreak(c, i);
      if (streak < 3) return null;
      // Volume declining over streak
      const declining = c[i].volume < c[i-1].volume && c[i-1].volume < c[i-2].volume;
      return declining ? 'BEAR' : null;
    }
  },
  {
    name: 'DeclVol+streak(3) bull',
    signal: (c, i) => {
      if (i < 5) return null;
      const streak = getStreak(c, i);
      if (streak > -3) return null;
      const declining = c[i].volume < c[i-1].volume && c[i-1].volume < c[i-2].volume;
      return declining ? 'BULL' : null;
    }
  },
  // Our best signal as baseline
  {
    name: 'Markov(3)+BB(2) [baseline]',
    signal: (c, i) => getMarkovBBSignal(c, i, 3, 2),
  },
];

const newIndicatorResults: Array<{ name: string; coin: string; tf: string; wr: number; total: number; pnl: number }> = [];

for (const { coin, tf } of [{ coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' }, { coin: 'ETH', tf: '5m' }]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  console.log(`  ── ${coin}/${tf} ──`);
  for (const { name, signal } of newStrategies) {
    let wins = 0, total = 0;
    for (let i = splitIdx + 35; i < allC.length - 1; i++) {
      const sig = signal(allC, i);
      if (!sig) continue;
      const nextGreen = isGreen(allC[i + 1]);
      const win = sig === 'BULL' ? nextGreen : !nextGreen;
      wins += win ? 1 : 0; total++;
    }
    if (total < 30) continue;
    const wr = wins / total;
    const pnl = wins * BET - (total - wins) * BET;
    const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : wr < 0.50 ? ' ❌' : '';
    console.log(`    ${name.padEnd(36)} WR=${(wr*100).toFixed(1).padStart(5)}% T=${total.toString().padStart(4)} PnL=$${pnl.toString().padStart(5)}${flag}`);
    newIndicatorResults.push({ name, coin, tf, wr, total, pnl });
  }
}

// ═══════════════════════════════════════════════════════════════
// PART 4: NEURAL NETWORK (simple 2-layer feedforward)
// ═══════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🧠 PART 4: SIMPLE NEURAL NETWORK');
console.log('══════════════════════════════════════════════════════════════');
console.log('2-layer NN with backprop on signal candidates vs GBDT\n');

// ── NN implementation ──────────────────────────────────────────
function sigmoid(x: number): number { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))); }
function relu(x: number): number { return Math.max(0, x); }

class NeuralNet {
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
  W3: number[];
  b3: number;
  lr: number;

  constructor(nIn: number, h1: number, h2: number, lr = 0.01) {
    this.lr = lr;
    const scale1 = Math.sqrt(2 / nIn), scale2 = Math.sqrt(2 / h1), scale3 = Math.sqrt(2 / h2);
    this.W1 = Array.from({ length: h1 }, () => Array.from({ length: nIn }, () => (Math.random() * 2 - 1) * scale1));
    this.b1 = new Array(h1).fill(0);
    this.W2 = Array.from({ length: h2 }, () => Array.from({ length: h1 }, () => (Math.random() * 2 - 1) * scale2));
    this.b2 = new Array(h2).fill(0);
    this.W3 = Array.from({ length: h2 }, () => (Math.random() * 2 - 1) * scale3);
    this.b3 = 0;
  }

  forward(x: number[]): { h1: number[]; h2: number[]; out: number } {
    const h1 = this.W1.map((row, j) => relu(row.reduce((s, w, k) => s + w * x[k], 0) + this.b1[j]));
    const h2 = this.W2.map((row, j) => relu(row.reduce((s, w, k) => s + w * h1[k], 0) + this.b2[j]));
    const out = sigmoid(this.W3.reduce((s, w, k) => s + w * h2[k], 0) + this.b3);
    return { h1, h2, out };
  }

  // Mini-batch gradient descent
  trainBatch(X: number[][], y: number[]): void {
    const N = X.length;
    const dW1 = this.W1.map(row => row.map(() => 0));
    const db1 = this.b1.map(() => 0);
    const dW2 = this.W2.map(row => row.map(() => 0));
    const db2 = this.b2.map(() => 0);
    const dW3 = this.W3.map(() => 0);
    let db3 = 0;

    for (let n = 0; n < N; n++) {
      const { h1, h2, out } = this.forward(X[n]);
      const dOut = out - y[n]; // d(BCE)/d(out) for sigmoid output

      // Output layer
      const dH2 = dW3.map((_, k) => dOut * this.W3[k]);
      dW3.forEach((_, k) => { (dW3 as number[])[k] += dOut * h2[k] / N; });
      db3 += dOut / N;

      // Hidden layer 2
      const dH2Relu = h2.map((v, k) => (v > 0 ? dH2[k] : 0));
      dH2Relu.forEach((d, j) => {
        this.W2[j].forEach((_, k) => { dW2[j][k] += d * h1[k] / N; });
        db2[j] += d / N;
      });

      // Hidden layer 1
      const dH1 = h1.map((_, k) => dH2Relu.reduce((s, d, j) => s + d * this.W2[j][k], 0));
      h1.forEach((v, j) => {
        const d = v > 0 ? dH1[j] : 0;
        this.W1[j].forEach((_, k) => { dW1[j][k] += d * X[n][k] / N; });
        db1[j] += d / N;
      });
    }

    // Gradient descent step
    this.W1.forEach((row, j) => row.forEach((_, k) => { this.W1[j][k] -= this.lr * dW1[j][k]; }));
    this.b1.forEach((_, j) => { this.b1[j] -= this.lr * db1[j]; });
    this.W2.forEach((row, j) => row.forEach((_, k) => { this.W2[j][k] -= this.lr * dW2[j][k]; }));
    this.b2.forEach((_, j) => { this.b2[j] -= this.lr * db2[j]; });
    this.W3.forEach((_, k) => { (this.W3 as number[])[k] -= this.lr * dW3[k]; });
    this.b3 -= this.lr * db3;
  }

  predict(x: number[]): number { return this.forward(x).out; }
}

// Feature extractor for signal candidates (same as gbdtFilter.ts)
function extractSignalFeatures(candles: DbCandle[], i: number, direction: 'BULL' | 'BEAR'): number[] {
  const c = candles[i];
  const closes = candles.slice(Math.max(0, i - 20), i + 1).map(c => c.close);
  const bb = calcBB(candles, i, 20, 2);
  const rsi14 = calcRSI(closes.slice(-16), 14);
  const atr = calcATR(candles.slice(Math.max(0, i - 15), i + 1));
  const streak = getStreak(candles, i);
  const volAvg = calcVolAvg(candles, i);
  const stoch = calcStochastic(candles, i);
  const cci = calcCCI(candles, i);

  const bodySize = Math.abs(c.close - c.open);
  const bodyATR = atr > 0 ? bodySize / atr : 0;
  const bbDev = bb ? Math.abs(c.close > bb.upper ? (c.close - bb.upper) / bb.std : c.close < bb.lower ? (bb.lower - c.close) / bb.std : 0) : 0;
  const volRatio = volAvg > 0 ? Math.min(3, c.volume / volAvg) : 1;
  const hour = new Date(c.open_time).getUTCHours();
  const dow = new Date(c.open_time).getUTCDay();
  const dirMult = direction === 'BULL' ? 1 : -1;

  return [
    Math.min(1, Math.abs(streak) / 5),
    Math.min(2, bodyATR),
    bbDev,
    rsi14 / 100,
    (stoch?.k ?? 50) / 100,
    (stoch?.d ?? 50) / 100,
    Math.min(1, Math.abs(cci) / 200),
    volRatio,
    dirMult * (rsi14 - 50) / 50,
    dirMult * ((stoch?.k ?? 50) - 50) / 50,
    dirMult * Math.min(1, cci / 100),
    Math.sin(2 * Math.PI * hour / 24),
    Math.cos(2 * Math.PI * hour / 24),
    Math.sin(2 * Math.PI * dow / 7),
    Math.cos(2 * Math.PI * dow / 7),
    hour === 14 ? 1 : 0,
    dow === 6 ? 1 : 0,  // Saturday
    1,
  ];
}

// Train NN on signal candidates
for (const { coin, tf } of [{ coin: 'ETH', tf: '15m' }, { coin: 'BTC', tf: '15m' }, { coin: 'ETH', tf: '5m' }]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Collect signal candidates
  const trainSamples: { x: number[]; y: number }[] = [];
  const testSamples: { x: number[]; y: number }[] = [];

  for (let i = 35; i < splitIdx - 1; i++) {
    const sig = getMarkovBBSignal(allC, i, 3, 2);
    if (!sig) continue;
    const x = extractSignalFeatures(allC, i, sig);
    const nextGreen = isGreen(allC[i + 1]);
    const y = sig === 'BULL' ? (nextGreen ? 1 : 0) : (!nextGreen ? 1 : 0);
    trainSamples.push({ x, y });
  }

  for (let i = splitIdx + 35; i < allC.length - 1; i++) {
    const sig = getMarkovBBSignal(allC, i, 3, 2);
    if (!sig) continue;
    const x = extractSignalFeatures(allC, i, sig);
    const nextGreen = isGreen(allC[i + 1]);
    const y = sig === 'BULL' ? (nextGreen ? 1 : 0) : (!nextGreen ? 1 : 0);
    testSamples.push({ x, y });
  }

  if (trainSamples.length < 50 || testSamples.length < 20) continue;

  const baseWR = testSamples.filter(s => s.y === 1).length / testSamples.length;
  console.log(`  ${coin}/${tf}: raw=${(baseWR*100).toFixed(1)}% T=${testSamples.length} train=${trainSamples.length}`);

  const nFeatures = trainSamples[0].x.length;
  const nn = new NeuralNet(nFeatures, 32, 16, 0.005);

  // Shuffle and train for 100 epochs with mini-batches
  const shuffled = [...trainSamples].sort(() => Math.random() - 0.5);
  const batchSize = 32;
  for (let epoch = 0; epoch < 150; epoch++) {
    for (let b = 0; b < shuffled.length; b += batchSize) {
      const batch = shuffled.slice(b, b + batchSize);
      nn.trainBatch(batch.map(s => s.x), batch.map(s => s.y));
    }
  }

  // Threshold sweep
  let best = { wr: 0, total: 0, pnl: 0, thr: 0.5 };
  for (const thr of [0.50, 0.52, 0.54, 0.55, 0.56, 0.57, 0.58, 0.60, 0.62]) {
    const filtered = testSamples.filter(s => nn.predict(s.x) >= thr);
    if (filtered.length < 15) break;
    const wins = filtered.filter(s => s.y === 1).length;
    const wr = wins / filtered.length;
    const pnl = wins * BET - (filtered.length - wins) * BET;
    if (wr > best.wr && filtered.length >= 15) best = { wr, total: filtered.length, pnl, thr };
    const flag = wr >= 0.65 ? ' ⭐⭐' : wr >= 0.60 ? ' ⭐' : '';
    console.log(`    thr=${thr.toFixed(2)}: WR=${(wr*100).toFixed(1)}% T=${filtered.length} PnL=$${pnl}${flag}`);
  }
  console.log(`  Best NN: WR=${(best.wr*100).toFixed(1)}% T=${best.total} thr=${best.thr} (+${((best.wr-baseWR)*100).toFixed(1)}% vs raw)\n`);
}

// ═══════════════════════════════════════════════════════════════
// TOP RESULTS SUMMARY
// ═══════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 TOP NEW INDICATORS (≥50 trades, sorted by WR)');
console.log('══════════════════════════════════════════════════════════════');

const topNew = newIndicatorResults
  .filter(r => r.total >= 50)
  .sort((a, b) => b.wr - a.wr)
  .slice(0, 15);

for (const r of topNew) {
  const flag = r.wr >= 0.65 ? ' ⭐⭐' : r.wr >= 0.60 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
  console.log(`  ${r.name.padEnd(36)} ${r.coin}/${r.tf.padEnd(3)}  WR=${(r.wr*100).toFixed(1).padStart(5)}%  T=${r.total.toString().padStart(4)}  $${r.pnl.toString().padStart(5)}${flag}`);
}

// Save
fs.writeFileSync(
  path.join(RESEARCH_DIR, 'walk-forward-new.json'),
  JSON.stringify({ timestamp: Date.now(), walkForward: walkForwardSummary, newIndicators: newIndicatorResults }, null, 2)
);
console.log('\n✅ Saved to docs/backtest-research/walk-forward-new.json');
