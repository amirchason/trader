/**
 * candleSequences.ts
 * Deep research: candle sequence patterns at BB extremes — beyond simple streaks
 *
 * Tests specific multi-candle "fingerprints" (GRGRR, RRGG, etc.) combined with BB
 * Also tests: candle body ratios, wick patterns, doji sequences, momentum exhaustion
 * Goal: find reliable 4-5 candle patterns that predict reversal
 */

import { getDb } from '../db';

const db = getDb();

// ── local BB calc (avoids Candle type mismatch) ───────────────────────────────

function calcBB(candles: RawCandle[], end: number, period = 20, mult = 2): { upper: number; lower: number; mid: number } | null {
  if (end < period - 1) return null;
  const slice = candles.slice(end - period + 1, end + 1);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, lower: mid - mult * std, mid };
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface RawCandle { open_time: number; open: number; high: number; low: number; close: number; volume: number; }

function getCandles(symbol: string, timeframe: string): RawCandle[] {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume
     FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time`
  ).all(symbol, timeframe) as RawCandle[];
}

function isGreen(c: RawCandle) { return c.close > c.open; }
function isRed(c: RawCandle) { return c.close < c.open; }

// Encode last N candles as string: G=green, R=red, D=doji (|body|<20% range)
function encodeSequence(candles: RawCandle[], n: number): string {
  const slice = candles.slice(-n);
  return slice.map(c => {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range > 0 && body / range < 0.2) return 'D';
    return c.close > c.open ? 'G' : 'R';
  }).join('');
}

// Body size relative to ATR
function bodyATR(c: RawCandle, atr: number): number {
  return atr > 0 ? Math.abs(c.close - c.open) / atr : 0;
}

// Upper wick ratio: upper_wick / range
function upperWickRatio(c: RawCandle): number {
  const range = c.high - c.low;
  return range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0;
}

// Lower wick ratio: lower_wick / range
function lowerWickRatio(c: RawCandle): number {
  const range = c.high - c.low;
  return range > 0 ? (Math.min(c.open, c.close) - c.low) / range : 0;
}

// ATR14
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

// ── stats helper ─────────────────────────────────────────────────────────────

interface Stats { wins: number; total: number; }

function wr(s: Stats) { return s.total > 0 ? ((s.wins / s.total) * 100).toFixed(1) : 'n/a'; }

// ── Part 1: Enumerated sequence patterns at BB extremes ────────────────────

function testSequencePatterns(symbol: string, timeframe: string, seqLen: number) {
  const candles = getCandles(symbol, timeframe);
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  const patterns: Record<string, Stats> = {};

  for (let i = seqLen + 19; i < test.length - 1; i++) {
    const bb = calcBB(test, i, 20, 2);
    if (!bb) continue;
    const price = test[i].close;
    const bearish = price > bb.upper;
    const bullish = price < bb.lower;
    if (!bearish && !bullish) continue;

    const seq = encodeSequence(test.slice(i - seqLen + 1, i + 1), seqLen);
    const key = `${seq}_${bearish ? 'BEAR' : 'BULL'}`;
    if (!patterns[key]) patterns[key] = { wins: 0, total: 0 };
    patterns[key].total++;
    const next = test[i + 1];
    const win = bearish ? (next.close < next.open) : (next.close > next.open);
    if (win) patterns[key].wins++;
  }

  // Filter: ≥15 trades, WR >= 62%
  const good = Object.entries(patterns)
    .filter(([_, s]) => s.total >= 15 && s.wins / s.total >= 0.62)
    .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total));

  return good.map(([k, s]) => ({
    pattern: k.split('_')[0],
    dir: k.split('_')[1],
    wr: (s.wins / s.total * 100).toFixed(1),
    trades: s.total,
    wins: s.wins,
  }));
}

// ── Part 2: Wick exhaustion patterns ─────────────────────────────────────────

function testWickExhaustion(symbol: string, timeframe: string) {
  const candles = getCandles(symbol, timeframe);
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  // Hypothesis: large upper wick on green candle AT BB upper → exhaustion BEAR signal
  // Hypothesis: large lower wick on red candle AT BB lower → exhaustion BULL signal

  interface CandidateStats {
    longUpperWick: Stats;     // upper wick > 40% of range, above BB upper
    longLowerWick: Stats;     // lower wick > 40% of range, below BB lower
    topWick3G: Stats;         // 3 greens, last has big upper wick, above BB
    botWick3R: Stats;         // 3 reds, last has big lower wick, below BB
  }

  const stats: CandidateStats = {
    longUpperWick: { wins: 0, total: 0 },
    longLowerWick: { wins: 0, total: 0 },
    topWick3G: { wins: 0, total: 0 },
    botWick3R: { wins: 0, total: 0 },
  };

  for (let i = 20; i < test.length - 1; i++) {
    const bb = calcBB(test, i, 20, 2);
    if (!bb) continue;
    const c = test[i];
    const price = c.close;

    // Long upper wick at BB upper
    if (price > bb.upper && upperWickRatio(c) > 0.4) {
      stats.longUpperWick.total++;
      if (test[i + 1].close < test[i + 1].open) stats.longUpperWick.wins++;
    }

    // Long lower wick at BB lower
    if (price < bb.lower && lowerWickRatio(c) > 0.4) {
      stats.longLowerWick.total++;
      if (test[i + 1].close > test[i + 1].open) stats.longLowerWick.wins++;
    }

    // 3 greens with top wick, above BB
    if (i >= 22 && price > bb.upper && upperWickRatio(c) > 0.35) {
      const prev3 = [test[i - 2], test[i - 1], test[i]];
      if (prev3.every(isGreen)) {
        stats.topWick3G.total++;
        if (test[i + 1].close < test[i + 1].open) stats.topWick3G.wins++;
      }
    }

    // 3 reds with lower wick, below BB
    if (i >= 22 && price < bb.lower && lowerWickRatio(c) > 0.35) {
      const prev3 = [test[i - 2], test[i - 1], test[i]];
      if (prev3.every(isRed)) {
        stats.botWick3R.total++;
        if (test[i + 1].close > test[i + 1].open) stats.botWick3R.wins++;
      }
    }
  }

  return stats;
}

// ── Part 3: Momentum exhaustion — diminishing body sizes ────────────────────

function testDiminishingMomentum(symbol: string, timeframe: string) {
  const candles = getCandles(symbol, timeframe);
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  // Hypothesis: GGG where each green is SMALLER than previous (exhaustion) → BEAR
  // Hypothesis: RRR where each red is SMALLER than previous (exhaustion) → BULL

  const diminGGG: Stats = { wins: 0, total: 0 };
  const diminRRR: Stats = { wins: 0, total: 0 };
  const growingGGG: Stats = { wins: 0, total: 0 };  // accelerating momentum
  const growingRRR: Stats = { wins: 0, total: 0 };
  const gggBBDimin: Stats = { wins: 0, total: 0 };  // GGG + BB + diminishing
  const rrrBBDimin: Stats = { wins: 0, total: 0 };

  for (let i = 21; i < test.length - 1; i++) {
    if (i < 2) continue;
    const c0 = test[i - 2], c1 = test[i - 1], c2 = test[i];
    const body0 = Math.abs(c0.close - c0.open);
    const body1 = Math.abs(c1.close - c1.open);
    const body2 = Math.abs(c2.close - c2.open);

    const allGreen = isGreen(c0) && isGreen(c1) && isGreen(c2);
    const allRed = isRed(c0) && isRed(c1) && isRed(c2);
    const diminishing = body2 < body1 && body1 < body0;  // bodies shrinking
    const growing = body2 > body1 && body1 > body0;       // bodies growing

    const bb = calcBB(test, i, 20, 2);
    const price = c2.close;

    if (allGreen) {
      if (diminishing) {
        diminGGG.total++;
        if (test[i + 1].close < test[i + 1].open) diminGGG.wins++;
        if (bb && price > bb.upper) {
          gggBBDimin.total++;
          if (test[i + 1].close < test[i + 1].open) gggBBDimin.wins++;
        }
      }
      if (growing) {
        growingGGG.total++;
        if (test[i + 1].close < test[i + 1].open) growingGGG.wins++;
      }
    }

    if (allRed) {
      if (diminishing) {
        diminRRR.total++;
        if (test[i + 1].close > test[i + 1].open) diminRRR.wins++;
        if (bb && price < bb.lower) {
          rrrBBDimin.total++;
          if (test[i + 1].close > test[i + 1].open) rrrBBDimin.wins++;
        }
      }
      if (growing) {
        growingRRR.total++;
        if (test[i + 1].close > test[i + 1].open) growingRRR.wins++;
      }
    }
  }

  return { diminGGG, diminRRR, growingGGG, growingRRR, gggBBDimin, rrrBBDimin };
}

// ── Part 4: Fractal pattern analysis — N-candle reversals ────────────────────

function testFractalReversal(symbol: string, timeframe: string) {
  const candles = getCandles(symbol, timeframe);
  const splitIdx = Math.floor(candles.length * 0.7);
  const test = candles.slice(splitIdx);

  // Fractal reversal: candle[i-2]<candle[i-1]>candle[i] (top fractal) at BB upper → bear
  // Williams fractal: top = c[-2].high < c[-1].high > c[0].high

  const topFractalBB: Stats = { wins: 0, total: 0 };
  const botFractalBB: Stats = { wins: 0, total: 0 };
  const topFractalStreak: Stats = { wins: 0, total: 0 };  // top fractal + green streak
  const botFractalStreak: Stats = { wins: 0, total: 0 };

  // Also test: engulfing patterns (next candle engulfs previous)
  const bearEngulfBB: Stats = { wins: 0, total: 0 };  // red candle engulfs green, at BB upper
  const bullEngulfBB: Stats = { wins: 0, total: 0 };  // green candle engulfs red, at BB lower

  for (let i = 22; i < test.length - 1; i++) {
    const c_2 = test[i - 2], c_1 = test[i - 1], c0 = test[i];
    const bb = calcBB(test, i, 20, 2);
    if (!bb) continue;
    const price = c0.close;

    // Top fractal: c[-2].high < c[-1].high > c[0].high
    const isTopFractal = c_2.high < c_1.high && c_1.high > c0.high;
    // Bottom fractal: c[-2].low > c[-1].low < c[0].low
    const isBotFractal = c_2.low > c_1.low && c_1.low < c0.low;

    if (isTopFractal && price > bb.upper) {
      topFractalBB.total++;
      if (test[i + 1].close < test[i + 1].open) topFractalBB.wins++;
    }
    if (isBotFractal && price < bb.lower) {
      botFractalBB.total++;
      if (test[i + 1].close > test[i + 1].open) botFractalBB.wins++;
    }

    // Top fractal + green streak
    if (isTopFractal && price > bb.upper) {
      const streak3Green = isGreen(test[i - 2]) && isGreen(test[i - 1]) && isGreen(test[i]);
      if (streak3Green) {
        topFractalStreak.total++;
        if (test[i + 1].close < test[i + 1].open) topFractalStreak.wins++;
      }
    }
    if (isBotFractal && price < bb.lower) {
      const streak3Red = isRed(test[i - 2]) && isRed(test[i - 1]) && isRed(test[i]);
      if (streak3Red) {
        botFractalStreak.total++;
        if (test[i + 1].close > test[i + 1].open) botFractalStreak.wins++;
      }
    }

    // Bearish engulfing at BB upper (c0 is red, engulfs c_1 green)
    if (isRed(c0) && isGreen(c_1) && price > bb.upper) {
      const engulfs = c0.open >= c_1.close && c0.close <= c_1.open;
      if (engulfs) {
        bearEngulfBB.total++;
        if (test[i + 1].close < test[i + 1].open) bearEngulfBB.wins++;
      }
    }
    // Bullish engulfing at BB lower
    if (isGreen(c0) && isRed(c_1) && price < bb.lower) {
      const engulfs = c0.open <= c_1.close && c0.close >= c_1.open;
      if (engulfs) {
        bullEngulfBB.total++;
        if (test[i + 1].close > test[i + 1].open) bullEngulfBB.wins++;
      }
    }
  }

  return { topFractalBB, botFractalBB, topFractalStreak, botFractalStreak, bearEngulfBB, bullEngulfBB };
}

// ── Part 5: Combined best patterns — walk-forward ─────────────────────────────

function walkForwardBestPatterns(symbol: string, timeframe: string) {
  const candles = getCandles(symbol, timeframe);
  // 3 non-overlapping folds on the test 30%
  const trainEnd = Math.floor(candles.length * 0.7);
  const testLen = candles.length - trainEnd;
  const foldSize = Math.floor(testLen / 3);

  const results: Array<{ fold: number; wr: string; trades: number }> = [];

  for (let fold = 0; fold < 3; fold++) {
    const foldStart = trainEnd + fold * foldSize;
    const foldEnd = fold < 2 ? foldStart + foldSize : candles.length - 1;
    const foldData = candles.slice(foldStart - 30, foldEnd); // need 30 warmup
    const warmup = 30;

    let wins = 0, total = 0;

    for (let i = warmup + 2; i < foldData.length - 1; i++) {
      const bb = calcBB(foldData, i, 20, 2);
      if (!bb) continue;
      const c_2 = foldData[i - 2], c_1 = foldData[i - 1], c0 = foldData[i];
      const price = c0.close;

      // Composite: GGG + top fractal + at BB upper
      const ggg = isGreen(c_2) && isGreen(c_1) && isGreen(c0);
      const topFrac = c_2.high < c_1.high && c_1.high > c0.high;
      const aboveBB = price > bb.upper;

      if (ggg && topFrac && aboveBB) {
        total++;
        if (foldData[i + 1].close < foldData[i + 1].open) wins++;
      }
    }

    results.push({ fold: fold + 1, wr: total > 0 ? (wins / total * 100).toFixed(1) : 'n/a', trades: total });
  }

  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('══════════════════════════════════════════════════════════════');
console.log('🕯️  CANDLE SEQUENCE PATTERN RESEARCH');
console.log('══════════════════════════════════════════════════════════════');
console.log('Goal: Find reliable multi-candle fingerprints at BB extremes');
console.log('Rule: Use 30% out-of-sample test period (strict no future-leak)\n');

// ── Part 1: All 3-4 candle sequences at BB extremes ───────────────────────

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m'], ['BTC', '15m']]) {
  console.log(`\n══ Part 1: Sequence patterns — ${sym}/${tf} (seqLen=4) ══`);
  const pats = testSequencePatterns(sym, tf, 4);
  if (pats.length === 0) {
    console.log('  No patterns with T≥15 and WR≥62% found');
  } else {
    pats.slice(0, 12).forEach(p => {
      console.log(`  ${p.pattern} → ${p.dir}: WR=${p.wr}%  T=${p.trades}`);
    });
  }
}

// ── Part 2: Wick exhaustion ───────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ PART 2: WICK EXHAUSTION PATTERNS');
console.log('══════════════════════════════════════════════════════════════');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m'], ['BTC', '15m']]) {
  console.log(`\n${sym}/${tf}:`);
  const s = testWickExhaustion(sym, tf);
  console.log(`  Long upper wick at BB upper: WR=${wr(s.longUpperWick)}%  T=${s.longUpperWick.total}`);
  console.log(`  Long lower wick at BB lower: WR=${wr(s.longLowerWick)}%  T=${s.longLowerWick.total}`);
  console.log(`  3G + top wick > BB upper:    WR=${wr(s.topWick3G)}%  T=${s.topWick3G.total}`);
  console.log(`  3R + bot wick < BB lower:    WR=${wr(s.botWick3R)}%  T=${s.botWick3R.total}`);
}

// ── Part 3: Diminishing momentum ─────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ PART 3: DIMINISHING MOMENTUM (body size trend)');
console.log('══════════════════════════════════════════════════════════════');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m'], ['BTC', '15m']]) {
  console.log(`\n${sym}/${tf}:`);
  const s = testDiminishingMomentum(sym, tf);
  console.log(`  Diminishing GGG (standalone):  WR=${wr(s.diminGGG)}%  T=${s.diminGGG.total}`);
  console.log(`  Growing GGG (standalone):       WR=${wr(s.growingGGG)}%  T=${s.growingGGG.total}`);
  console.log(`  Diminishing RRR (standalone):  WR=${wr(s.diminRRR)}%  T=${s.diminRRR.total}`);
  console.log(`  Growing RRR (standalone):       WR=${wr(s.growingRRR)}%  T=${s.growingRRR.total}`);
  console.log(`  GGG+BB+diminishing (bear):     WR=${wr(s.gggBBDimin)}%  T=${s.gggBBDimin.total}`);
  console.log(`  RRR+BB+diminishing (bull):     WR=${wr(s.rrrBBDimin)}%  T=${s.rrrBBDimin.total}`);
}

// ── Part 4: Fractals & engulfing ─────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ PART 4: FRACTAL & ENGULFING PATTERNS');
console.log('══════════════════════════════════════════════════════════════');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m']]) {
  console.log(`\n${sym}/${tf}:`);
  const s = testFractalReversal(sym, tf);
  console.log(`  Top fractal at BB upper:       WR=${wr(s.topFractalBB)}%  T=${s.topFractalBB.total}`);
  console.log(`  Bot fractal at BB lower:       WR=${wr(s.botFractalBB)}%  T=${s.botFractalBB.total}`);
  console.log(`  GGG + top fractal at BB:       WR=${wr(s.topFractalStreak)}%  T=${s.topFractalStreak.total}`);
  console.log(`  RRR + bot fractal at BB:       WR=${wr(s.botFractalStreak)}%  T=${s.botFractalStreak.total}`);
  console.log(`  Bearish engulfing at BB upper: WR=${wr(s.bearEngulfBB)}%  T=${s.bearEngulfBB.total}`);
  console.log(`  Bullish engulfing at BB lower: WR=${wr(s.bullEngulfBB)}%  T=${s.bullEngulfBB.total}`);
}

// ── Part 5: Walk-forward best composite pattern ───────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ PART 5: WALK-FORWARD — GGG + TOP FRACTAL + BB UPPER');
console.log('══════════════════════════════════════════════════════════════');

for (const [sym, tf] of [['ETH', '5m'], ['ETH', '15m']]) {
  console.log(`\n${sym}/${tf}:`);
  const folds = walkForwardBestPatterns(sym, tf);
  folds.forEach(f => console.log(`  Fold ${f.fold}: WR=${f.wr}%  T=${f.trades}`));
  const validFolds = folds.filter(f => f.trades >= 5);
  if (validFolds.length > 0) {
    const avgWR = validFolds.reduce((s, f) => s + parseFloat(f.wr === 'n/a' ? '0' : f.wr), 0) / validFolds.length;
    console.log(`  Avg: WR=${avgWR.toFixed(1)}%`);
  }
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ CANDLE SEQUENCE RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
console.log('\nKey to look for:');
console.log('  - Any pattern with T≥15 and WR≥65% is a candidate strategy');
console.log('  - GGG+fractal walk-forward: all 3 folds must be > 55% to be valid');
console.log('  - Wick patterns have historically failed — look for 60%+ to flip the story');
