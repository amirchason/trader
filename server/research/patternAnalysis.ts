/**
 * Simple Candle Pattern Analysis
 * "What does history say about what comes next?"
 *
 * Tests pure price/candle patterns without any complex indicators:
 *  - Streak patterns (N consecutive green/red → next?)
 *  - Candle size patterns (big candle → small reversion?)
 *  - Time-of-day patterns
 *  - Hour-of-week patterns
 *  - Support/resistance based on round numbers
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/patternAnalysis.ts
 */

import fs from 'fs';
import path from 'path';
import { queryCandles } from '../db';
import type { DbCandle } from '../db';

const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');
fs.mkdirSync(RESEARCH_DIR, { recursive: true });

const COIN = 'ETH';
const FROM_MS = 1754006400000;
const TO_MS   = 1769903700000;
const SPLIT_MS = FROM_MS + Math.floor((TO_MS - FROM_MS) * 0.7);

// ─── Pattern Test Framework ────────────────────────────────────────────────

interface PatternResult {
  name: string;
  description: string;
  n: number;           // sample count
  winRate: number;     // % correct predictions
  edge: number;        // winRate - 50%
  betDir: 'bull' | 'bear' | 'varies';
}

function testPattern(
  candles: DbCandle[],
  windowSize: number,
  filter: (window: DbCandle[]) => boolean,
  predict: (window: DbCandle[]) => 'bull' | 'bear',
  name: string,
  description: string,
): PatternResult {
  let wins = 0, total = 0;

  for (let i = windowSize; i < candles.length - 1; i++) {
    const window = candles.slice(i - windowSize, i + 1);
    if (!filter(window)) continue;

    const next = candles[i + 1];
    const nextUp = next.close > next.open;
    const pred = predict(window);
    total++;
    if ((pred === 'bull') === nextUp) wins++;
  }

  const winRate = total > 0 ? (wins / total) * 100 : 50;
  const pred = wins > 0 ? (wins > total / 2 ? 'bull' : 'bear') : 'bull';

  return {
    name,
    description,
    n: total,
    winRate: Math.round(winRate * 100) / 100,
    edge: Math.round((winRate - 50) * 100) / 100,
    betDir: pred as 'bull' | 'bear' | 'varies',
  };
}

function isGreen(c: DbCandle) { return c.close > c.open; }
function isRed(c: DbCandle) { return c.close < c.open; }
function bodySize(c: DbCandle) { return Math.abs(c.close - c.open); }
function rangeSize(c: DbCandle) { return c.high - c.low; }
function candleChange(c: DbCandle) { return (c.close - c.open) / c.open * 100; }

async function main() {
  console.log('🕯️  Candle Pattern Analysis — ETH 5m');
  console.log('What does history say about what comes next?');
  console.log('═'.repeat(70));

  const trainCandles = queryCandles(COIN, '5m', FROM_MS, SPLIT_MS);
  const testCandles = queryCandles(COIN, '5m', SPLIT_MS, TO_MS);
  console.log(`\n  Train: ${trainCandles.length} candles | Test: ${testCandles.length} candles`);

  const baseUpTrain = trainCandles.filter(isGreen).length / trainCandles.length;
  const baseUpTest = testCandles.filter(isGreen).length / testCandles.length;
  console.log(`  Base up rate — Train: ${(baseUpTrain * 100).toFixed(2)}% | Test: ${(baseUpTest * 100).toFixed(2)}%`);

  // ─── Patterns to test ─────────────────────────────────────────────────

  const patterns: Array<() => PatternResult> = [

    // ─── Streak patterns ─────────────────────────────────────────────────
    () => testPattern(trainCandles, 2, w => isGreen(w[1]) && isGreen(w[2]), () => 'bull',
      '2 green → green', 'After 2 consecutive green candles, next is green'),
    () => testPattern(trainCandles, 2, w => isRed(w[1]) && isRed(w[2]), () => 'bear',
      '2 red → red', 'After 2 consecutive red candles, next is red'),
    () => testPattern(trainCandles, 2, w => isGreen(w[1]) && isGreen(w[2]), () => 'bear',
      '2 green → reversion', 'After 2 green, expect red (mean reversion)'),
    () => testPattern(trainCandles, 2, w => isRed(w[1]) && isRed(w[2]), () => 'bull',
      '2 red → reversion', 'After 2 red, expect green'),
    () => testPattern(trainCandles, 3, w => [1,2,3].every(j => isGreen(w[j])), () => 'bear',
      '3 green → reversion', '3 green → expect red'),
    () => testPattern(trainCandles, 3, w => [1,2,3].every(j => isRed(w[j])), () => 'bull',
      '3 red → reversion', '3 red → expect green'),
    () => testPattern(trainCandles, 4, w => [1,2,3,4].every(j => isGreen(w[j])), () => 'bear',
      '4+ green → reversion', '4 green streak → expect red'),
    () => testPattern(trainCandles, 4, w => [1,2,3,4].every(j => isRed(w[j])), () => 'bull',
      '4+ red → reversion', '4 red streak → expect green'),
    () => testPattern(trainCandles, 1, w => isGreen(w[1]), () => 'bull',
      'Prev green → green (momentum)', 'Simple momentum: green follows green'),
    () => testPattern(trainCandles, 1, w => isRed(w[1]), () => 'bear',
      'Prev red → red (momentum)', 'Simple momentum: red follows red'),

    // ─── Size patterns ────────────────────────────────────────────────────
    () => testPattern(trainCandles, 5,
      w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) > avg * 2.5; },
      () => 'bear',
      'Big candle → reversion', 'Candle body > 2.5x avg → next is opposite'),
    () => testPattern(trainCandles, 5,
      w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) > avg * 2.5 && isGreen(w[5]); },
      () => 'bear',
      'Big GREEN candle → red', 'Large green spike → red reversion'),
    () => testPattern(trainCandles, 5,
      w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) > avg * 2.5 && isRed(w[5]); },
      () => 'bull',
      'Big RED candle → green', 'Large red spike → green reversion'),
    () => testPattern(trainCandles, 5,
      w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) < avg * 0.3; },
      w => isGreen(w[4]) ? 'bull' : 'bear',
      'Tiny candle (doji) → follow trend', 'Tiny body doji → continue prior direction'),
    () => testPattern(trainCandles, 1,
      w => { const ratio = bodySize(w[1]) / rangeSize(w[1]); return ratio < 0.2; }, // doji: tiny body vs range
      () => 'bull',
      'Doji (wick dominant) → bull', 'When wicks >> body → bullish'),

    // ─── Candle change % patterns ─────────────────────────────────────────
    () => testPattern(trainCandles, 1,
      w => candleChange(w[1]) > 0.5, () => 'bear',
      'Strong green (+0.5%) → red', 'Big green candle (>0.5%) → red next'),
    () => testPattern(trainCandles, 1,
      w => candleChange(w[1]) < -0.5, () => 'bull',
      'Strong red (-0.5%) → green', 'Big red candle (>0.5%) → green next'),
    () => testPattern(trainCandles, 1,
      w => candleChange(w[1]) > 1.0, () => 'bear',
      'Very strong green (>1%) → red', 'Very large up move → reversal'),
    () => testPattern(trainCandles, 1,
      w => candleChange(w[1]) < -1.0, () => 'bull',
      'Very strong red (>1%) → green', 'Very large down move → bounce'),

    // ─── Volume patterns ──────────────────────────────────────────────────
    () => testPattern(trainCandles, 20,
      w => w[20].volume > w.slice(0,20).reduce((s,c) => s + c.volume, 0) / 20 * 3,
      w => isGreen(w[20]) ? 'bull' : 'bear',
      'Volume spike (3x) → follow direction', 'High volume confirms direction'),
    () => testPattern(trainCandles, 20,
      w => w[20].volume < w.slice(0,20).reduce((s,c) => s + c.volume, 0) / 20 * 0.3,
      () => 'bull',
      'Very low volume → expect move up', 'Quiet period → breakout bullish?'),

    // ─── Time patterns ────────────────────────────────────────────────────
    () => testPattern(trainCandles, 1,
      w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 8 && h < 10; },
      () => 'bull',
      'Europe open (8-10 UTC) → bull', 'European session open tends bullish'),
    () => testPattern(trainCandles, 1,
      w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 13 && h < 15; },
      () => 'bull',
      'US open (13-15 UTC) → bull', 'NY session open tends bullish'),
    () => testPattern(trainCandles, 1,
      w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 0 && h < 4; },
      () => 'bear',
      'Asian dead zone (0-4 UTC) → bear', 'Low activity session tends bearish'),
    () => testPattern(trainCandles, 1,
      w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 14 && h < 16; },
      () => 'bull',
      'NY power hour (14-16 UTC) → bull', 'Peak US liquidity = bullish'),
    () => testPattern(trainCandles, 1,
      w => { const d = new Date(w[1].open_time).getUTCDay(); return d === 1; },
      () => 'bull',
      'Monday candle → bull', 'Monday tends to be bullish'),
    () => testPattern(trainCandles, 1,
      w => { const d = new Date(w[1].open_time).getUTCDay(); return d === 5; },
      () => 'bear',
      'Friday candle → bear', 'Friday tends to have profit taking'),

    // ─── Pattern combinations ─────────────────────────────────────────────
    () => testPattern(trainCandles, 5,
      w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return isGreen(w[5]) && bodySize(w[5]) > avg * 2 && isRed(w[4]); },
      () => 'bear',
      'Engulfing green (after red) → red', 'Bearish engulfing → red'),
    () => testPattern(trainCandles, 5,
      w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return isRed(w[5]) && bodySize(w[5]) > avg * 2 && isGreen(w[4]); },
      () => 'bull',
      'Engulfing red (after green) → green', 'Bullish engulfing → green'),
    () => testPattern(trainCandles, 3,
      w => isGreen(w[1]) && isRed(w[2]) && isGreen(w[3]) && w[3].close > w[1].high,
      () => 'bull',
      'Morning star pattern → bull', 'Green-Red-Larger Green = strong bull signal'),
    () => testPattern(trainCandles, 3,
      w => isRed(w[1]) && isGreen(w[2]) && isRed(w[3]) && w[3].close < w[1].low,
      () => 'bear',
      'Evening star pattern → bear', 'Red-Green-Larger Red = strong bear signal'),
  ];

  // Run all patterns on training data
  const trainResults = patterns.map(p => p());

  // Now test on test data
  const testCandles2 = testCandles;
  const testPatterns: Array<() => PatternResult> = [
    () => testPattern(testCandles2, 2, w => isGreen(w[1]) && isGreen(w[2]), () => 'bull', '2 green → green', ''),
    () => testPattern(testCandles2, 2, w => isRed(w[1]) && isRed(w[2]), () => 'bear', '2 red → red', ''),
    () => testPattern(testCandles2, 2, w => isGreen(w[1]) && isGreen(w[2]), () => 'bear', '2 green → reversion', ''),
    () => testPattern(testCandles2, 2, w => isRed(w[1]) && isRed(w[2]), () => 'bull', '2 red → reversion', ''),
    () => testPattern(testCandles2, 3, w => [1,2,3].every(j => isGreen(w[j])), () => 'bear', '3 green → reversion', ''),
    () => testPattern(testCandles2, 3, w => [1,2,3].every(j => isRed(w[j])), () => 'bull', '3 red → reversion', ''),
    () => testPattern(testCandles2, 4, w => [1,2,3,4].every(j => isGreen(w[j])), () => 'bear', '4+ green → reversion', ''),
    () => testPattern(testCandles2, 4, w => [1,2,3,4].every(j => isRed(w[j])), () => 'bull', '4+ red → reversion', ''),
    () => testPattern(testCandles2, 1, w => isGreen(w[1]), () => 'bull', 'Prev green → green (momentum)', ''),
    () => testPattern(testCandles2, 1, w => isRed(w[1]), () => 'bear', 'Prev red → red (momentum)', ''),
    () => testPattern(testCandles2, 5, w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) > avg * 2.5; }, () => 'bear', 'Big candle → reversion', ''),
    () => testPattern(testCandles2, 5, w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) > avg * 2.5 && isGreen(w[5]); }, () => 'bear', 'Big GREEN candle → red', ''),
    () => testPattern(testCandles2, 5, w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) > avg * 2.5 && isRed(w[5]); }, () => 'bull', 'Big RED candle → green', ''),
    () => testPattern(testCandles2, 5, w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return bodySize(w[5]) < avg * 0.3; }, w => isGreen(w[4]) ? 'bull' : 'bear', 'Tiny candle (doji) → follow trend', ''),
    () => testPattern(testCandles2, 1, w => candleChange(w[1]) > 0.5, () => 'bear', 'Strong green (+0.5%) → red', ''),
    () => testPattern(testCandles2, 1, w => candleChange(w[1]) < -0.5, () => 'bull', 'Strong red (-0.5%) → green', ''),
    () => testPattern(testCandles2, 1, w => candleChange(w[1]) > 1.0, () => 'bear', 'Very strong green (>1%) → red', ''),
    () => testPattern(testCandles2, 1, w => candleChange(w[1]) < -1.0, () => 'bull', 'Very strong red (>1%) → green', ''),
    () => testPattern(testCandles2, 20, w => w[20].volume > w.slice(0,20).reduce((s,c) => s + c.volume, 0) / 20 * 3, w => isGreen(w[20]) ? 'bull' : 'bear', 'Volume spike (3x) → follow direction', ''),
    () => testPattern(testCandles2, 1, w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 8 && h < 10; }, () => 'bull', 'Europe open (8-10 UTC) → bull', ''),
    () => testPattern(testCandles2, 1, w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 13 && h < 15; }, () => 'bull', 'US open (13-15 UTC) → bull', ''),
    () => testPattern(testCandles2, 1, w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 0 && h < 4; }, () => 'bear', 'Asian dead zone (0-4 UTC) → bear', ''),
    () => testPattern(testCandles2, 1, w => { const h = new Date(w[1].open_time).getUTCHours(); return h >= 14 && h < 16; }, () => 'bull', 'NY power hour (14-16 UTC) → bull', ''),
    () => testPattern(testCandles2, 1, w => { const d = new Date(w[1].open_time).getUTCDay(); return d === 1; }, () => 'bull', 'Monday candle → bull', ''),
    () => testPattern(testCandles2, 1, w => { const d = new Date(w[1].open_time).getUTCDay(); return d === 5; }, () => 'bear', 'Friday candle → bear', ''),
    () => testPattern(testCandles2, 5, w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return isGreen(w[5]) && bodySize(w[5]) > avg * 2 && isRed(w[4]); }, () => 'bear', 'Engulfing green (after red) → red', ''),
    () => testPattern(testCandles2, 5, w => { const avg = w.slice(0,5).reduce((s,c) => s + bodySize(c), 0) / 5; return isRed(w[5]) && bodySize(w[5]) > avg * 2 && isGreen(w[4]); }, () => 'bull', 'Engulfing red (after green) → green', ''),
  ];

  const testResults = testPatterns.map(p => p());

  // ─── Print results ────────────────────────────────────────────────────

  function printTable(results: PatternResult[], label: string) {
    console.log(`\n${'─'.repeat(75)}`);
    console.log(label);
    console.log(`${'─'.repeat(75)}`);
    console.log('  Pattern                              |   N   | WinRate |  Edge');
    console.log('  ' + '-'.repeat(63));

    const sorted = [...results].filter(r => r.n >= 20).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
    for (const r of sorted) {
      const edgeStr = `${r.edge >= 0 ? '+' : ''}${r.edge.toFixed(2)}%`;
      const bar = '█'.repeat(Math.min(10, Math.max(0, Math.round(Math.abs(r.edge)))));
      console.log(
        `  ${r.name.substring(0, 38).padEnd(38)}| ${r.n.toString().padStart(6)}| ${r.winRate.toFixed(2).padStart(7)}% |${edgeStr.padStart(7)} ${bar}`
      );
    }
    return sorted;
  }

  const trainSorted = printTable(trainResults, '📚 TRAINING PERIOD — Pattern Analysis');
  const testSorted = printTable(testResults, '🎯 TEST PERIOD — Pattern Analysis');

  // Cross-validate
  console.log('\n' + '═'.repeat(75));
  console.log('📊 CROSS-VALIDATION: Patterns that held in both periods');
  console.log('═'.repeat(75));

  const consistent: Array<{ name: string; trainEdge: number; testEdge: number }> = [];
  for (const tr of trainSorted) {
    const te = testSorted.find(r => r.name === tr.name);
    if (!te) continue;
    const sameDir = (tr.edge >= 0) === (te.edge >= 0);
    if (sameDir && Math.abs(te.edge) >= 0.5 && te.n >= 50) {
      consistent.push({ name: tr.name, trainEdge: tr.edge, testEdge: te.edge });
    }
  }

  if (consistent.length === 0) {
    console.log('  No patterns with consistent edge >= 0.5% found in both periods.');
  } else {
    for (const c of consistent.sort((a, b) => b.testEdge - a.testEdge)) {
      console.log(`  ✅ "${c.name}"`);
      console.log(`     Train: ${c.trainEdge >= 0 ? '+' : ''}${c.trainEdge.toFixed(2)}% | Test: ${c.testEdge >= 0 ? '+' : ''}${c.testEdge.toFixed(2)}%`);
    }
  }

  // ─── Candle pattern matrix ────────────────────────────────────────────

  console.log('\n' + '═'.repeat(75));
  console.log('📊 CANDLE SEQUENCE MATRIX (what follows GGG, GGR, GRG, etc.?)');
  console.log('═'.repeat(75));

  const allCandles = [...trainCandles, ...testCandles];
  const seqMap: Record<string, { up: number; down: number }> = {};

  for (let i = 3; i < allCandles.length - 1; i++) {
    const seq = [
      isGreen(allCandles[i-2]) ? 'G' : 'R',
      isGreen(allCandles[i-1]) ? 'G' : 'R',
      isGreen(allCandles[i]) ? 'G' : 'R',
    ].join('');

    const next = allCandles[i + 1];
    const nextUp = next.close > next.open;

    if (!seqMap[seq]) seqMap[seq] = { up: 0, down: 0 };
    if (nextUp) seqMap[seq].up++; else seqMap[seq].down++;
  }

  console.log('  Sequence | Up  | Down | Total | Next Up%  | Edge');
  console.log('  ' + '-'.repeat(55));
  for (const [seq, counts] of Object.entries(seqMap).sort((a, b) => {
    const totalA = a[1].up + a[1].down;
    const totalB = b[1].up + b[1].down;
    const pctA = a[1].up / totalA;
    const pctB = b[1].up / totalB;
    return Math.abs(pctB - 0.5) - Math.abs(pctA - 0.5);
  })) {
    const total = counts.up + counts.down;
    const upPct = counts.up / total * 100;
    const edge = upPct - 50;
    const edgeStr = `${edge >= 0 ? '+' : ''}${edge.toFixed(2)}%`;
    const bet = edge > 0 ? '→ BULL' : '→ BEAR';
    console.log(
      `  ${seq.padEnd(9)}| ${counts.up.toString().padStart(4)}| ${counts.down.toString().padStart(5)}| ${total.toString().padStart(6)}| ${upPct.toFixed(2).padStart(8)}% |${edgeStr.padStart(7)} ${bet}`
    );
  }

  // ─── Save ─────────────────────────────────────────────────────────────

  const output = {
    generatedAt: new Date().toISOString(),
    baseRates: { train: baseUpTrain * 100, test: baseUpTest * 100 },
    trainResults, testResults,
    consistentPatterns: consistent,
    candleSequenceMatrix: Object.fromEntries(
      Object.entries(seqMap).map(([seq, c]) => [seq, {
        up: c.up, down: c.down, total: c.up + c.down,
        upPct: Math.round(c.up / (c.up + c.down) * 10000) / 100,
        edge: Math.round((c.up / (c.up + c.down) - 0.5) * 10000) / 100,
      }])
    ),
  };

  fs.writeFileSync(path.join(RESEARCH_DIR, 'pattern-results.json'), JSON.stringify(output, null, 2));
  console.log('\n✅ Pattern analysis saved to docs/backtest-research/pattern-results.json');
}

main().catch(console.error);
