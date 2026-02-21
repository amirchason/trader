/**
 * Multi-Timeframe (MTF) Analysis
 *
 * Hypothesis: When 4h/1h trends align, 5m binary prediction improves.
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/mtfAnalysis.ts
 */

import fs from 'fs';
import path from 'path';
import { queryCandles } from '../db';
import { calculateRSI, calculateSMA, calculateMACD } from '../indicators';
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

type Trend = 'bullish' | 'bearish' | 'neutral';
type Strength = 'strong' | 'moderate' | 'weak' | 'neutral';

interface HTFState {
  rsi14: number | null;
  trend: Trend;
  strength: Strength;
}

function calcHTFState(candles: Candle[]): HTFState {
  if (candles.length < 20) return { rsi14: null, trend: 'neutral', strength: 'neutral' };

  const rsi14 = calculateRSI(candles, 14);
  const sma20 = calculateSMA(candles, 20);
  const macd = calculateMACD(candles);
  const lastPrice = candles[candles.length - 1].close;

  const priceAboveSma = sma20 !== null && lastPrice > sma20;
  const recent5 = candles.slice(-5);
  const greenCount = recent5.filter(c => c.close > c.open).length;
  const recentBias = (greenCount / 5) * 2 - 1;

  let bull = 0;
  let bear = 0;

  if (rsi14 !== null) {
    if (rsi14 > 55) bull += 2; else if (rsi14 > 50) bull += 1;
    if (rsi14 < 45) bear += 2; else if (rsi14 < 50) bear += 1;
  }
  if (priceAboveSma) bull += 2; else bear += 2;
  if (macd !== null && macd.macd > 0) bull += 1; else if (macd !== null && macd.macd < 0) bear += 1;
  if (recentBias > 0.2) bull += 1; else if (recentBias < -0.2) bear += 1;

  let trend: Trend;
  let strength: Strength;

  if (bull > bear + 2) { trend = 'bullish'; strength = bull >= 5 ? 'strong' : 'moderate'; }
  else if (bear > bull + 2) { trend = 'bearish'; strength = bear >= 5 ? 'strong' : 'moderate'; }
  else if (bull > bear) { trend = 'bullish'; strength = 'weak'; }
  else if (bear > bull) { trend = 'bearish'; strength = 'weak'; }
  else { trend = 'neutral'; strength = 'neutral'; }

  return { rsi14, trend, strength };
}

interface MTFSample {
  time: number;
  nextCandleUp: boolean;
  trend1h: Trend;
  trend4h: Trend;
  strength1h: Strength;
  strength4h: Strength;
  rsi1h: number | null;
  rsi4h: number | null;
  rsi5m: number | null;
  prevGreen: boolean;
  volumeSpike: boolean;
}

function buildMTFSamples(coin: string, fromMs: number, toMs: number): MTFSample[] {
  console.log(`  Loading candles for ${coin}...`);
  const db5m = queryCandles(coin, '5m', fromMs - 24 * 3600000, toMs);
  const db1h = queryCandles(coin, '1h', fromMs - 7 * 24 * 3600000, toMs);
  const db4h = queryCandles(coin, '4h', fromMs - 30 * 24 * 3600000, toMs);
  console.log(`  5m: ${db5m.length}, 1h: ${db1h.length}, 4h: ${db4h.length}`);

  const c5m = db5m.map(toCandle);
  const c1h = db1h.map(toCandle);
  const c4h = db4h.map(toCandle);

  const samples: MTFSample[] = [];
  const WARMUP = 30;

  for (let i = WARMUP; i < c5m.length - 1; i++) {
    const t = c5m[i].openTime;
    if (t < fromMs) continue;

    const nextCandleUp = c5m[i + 1].close > c5m[i + 1].open;

    // Use only completed 1h/4h candles (open_time < start of current period)
    const cur1hStart = t - (t % 3600000);
    const cur4hStart = t - (t % 14400000);

    const hist1h = c1h.filter(c => c.openTime < cur1hStart).slice(-40);
    const hist4h = c4h.filter(c => c.openTime < cur4hStart).slice(-40);

    if (hist1h.length < 20 || hist4h.length < 10) continue;

    const state1h = calcHTFState(hist1h);
    const state4h = calcHTFState(hist4h);

    const slice5m = c5m.slice(Math.max(0, i - 49), i + 1);
    const rsi5m = calculateRSI(slice5m, 14);

    const vols = slice5m.slice(-21);
    const avgVol = vols.slice(0, -1).reduce((s, c) => s + c.volume, 0) / Math.max(1, vols.length - 1);
    const volumeSpike = vols.length > 1 && vols[vols.length - 1].volume > avgVol * 2;

    samples.push({
      time: t,
      nextCandleUp,
      trend1h: state1h.trend,
      trend4h: state4h.trend,
      strength1h: state1h.strength,
      strength4h: state4h.strength,
      rsi1h: state1h.rsi14,
      rsi4h: state4h.rsi14,
      rsi5m,
      prevGreen: c5m[i].close > c5m[i].open,
      volumeSpike,
    });
  }

  return samples;
}

interface FilterResult {
  label: string;
  total: number;
  selected: number;
  pct: number;
  winRate: number;
  edge: number;
}

function analyzeFilter(
  samples: MTFSample[],
  filter: (s: MTFSample) => boolean,
  betDir: (s: MTFSample) => 'bull' | 'bear' | 'skip',
  label: string,
): FilterResult {
  const sel = samples.filter(filter);
  if (sel.length === 0) return { label, total: samples.length, selected: 0, pct: 0, winRate: 50, edge: 0 };

  let wins = 0, bets = 0;
  for (const s of sel) {
    const d = betDir(s);
    if (d === 'skip') continue;
    bets++;
    if ((d === 'bull') === s.nextCandleUp) wins++;
  }

  const winRate = bets > 0 ? (wins / bets) * 100 : 50;
  return {
    label,
    total: samples.length,
    selected: sel.length,
    pct: Math.round((sel.length / samples.length) * 1000) / 10,
    winRate: Math.round(winRate * 100) / 100,
    edge: Math.round((winRate - 50) * 100) / 100,
  };
}

function runFilters(samples: MTFSample[]): FilterResult[] {
  return [
    // Always-bull baseline
    analyzeFilter(samples, () => true, () => 'bull', 'Baseline: always bet BULL'),
    // 1h trend
    analyzeFilter(samples, s => s.trend1h === 'bullish', () => 'bull', '1h BULLISH → bet BULL'),
    analyzeFilter(samples, s => s.trend1h === 'bearish', () => 'bear', '1h BEARISH → bet BEAR'),
    analyzeFilter(samples, s => s.trend1h !== 'neutral', s => s.trend1h === 'bullish' ? 'bull' : 'bear', '1h has direction → follow 1h'),
    analyzeFilter(samples, s => s.strength1h === 'strong', s => s.trend1h === 'bullish' ? 'bull' : s.trend1h === 'bearish' ? 'bear' : 'skip', '1h STRONG → follow 1h'),
    // 4h trend
    analyzeFilter(samples, s => s.trend4h === 'bullish', () => 'bull', '4h BULLISH → bet BULL'),
    analyzeFilter(samples, s => s.trend4h === 'bearish', () => 'bear', '4h BEARISH → bet BEAR'),
    analyzeFilter(samples, s => s.trend4h !== 'neutral', s => s.trend4h === 'bullish' ? 'bull' : 'bear', '4h has direction → follow 4h'),
    analyzeFilter(samples, s => s.strength4h === 'strong', s => s.trend4h === 'bullish' ? 'bull' : s.trend4h === 'bearish' ? 'bear' : 'skip', '4h STRONG → follow 4h'),
    // Both aligned
    analyzeFilter(samples, s => s.trend1h === 'bullish' && s.trend4h === 'bullish', () => 'bull', '1h+4h BOTH BULLISH → BULL'),
    analyzeFilter(samples, s => s.trend1h === 'bearish' && s.trend4h === 'bearish', () => 'bear', '1h+4h BOTH BEARISH → BEAR'),
    analyzeFilter(samples, s => s.trend1h === s.trend4h && s.trend1h !== 'neutral', s => s.trend1h === 'bullish' ? 'bull' : 'bear', '1h+4h agree (any) → follow'),
    analyzeFilter(samples, s => s.trend1h === s.trend4h && s.strength1h === 'strong' && s.strength4h === 'strong', s => s.trend1h === 'bullish' ? 'bull' : s.trend1h === 'bearish' ? 'bear' : 'skip', '1h+4h BOTH STRONG → follow'),
    // RSI based
    analyzeFilter(samples, s => (s.rsi1h ?? 50) > 60 && (s.rsi4h ?? 50) > 60, () => 'bull', 'RSI 1h>60 AND 4h>60 → BULL'),
    analyzeFilter(samples, s => (s.rsi1h ?? 50) < 40 && (s.rsi4h ?? 50) < 40, () => 'bear', 'RSI 1h<40 AND 4h<40 → BEAR'),
    analyzeFilter(samples, s => { const r1 = s.rsi1h ?? 50, r4 = s.rsi4h ?? 50; return (r1 > 60 && r4 > 60) || (r1 < 40 && r4 < 40); },
      s => { const r1 = s.rsi1h ?? 50, r4 = s.rsi4h ?? 50; return r1 > 60 && r4 > 60 ? 'bull' : 'bear'; },
      'RSI both extreme same side'),
    // Counter-trend / mean reversion
    analyzeFilter(samples, s => s.trend1h === 'bearish' && s.trend4h === 'bearish' && (s.rsi5m ?? 50) < 30, () => 'bull', 'Downtrend + 5m RSI<30 → BULL (reversion)'),
    analyzeFilter(samples, s => s.trend1h === 'bullish' && s.trend4h === 'bullish' && (s.rsi5m ?? 50) > 70, () => 'bear', 'Uptrend + 5m RSI>70 → BEAR (reversion)'),
    // Volume
    analyzeFilter(samples, s => s.volumeSpike && s.trend1h !== 'neutral', s => s.trend1h === 'bullish' ? 'bull' : 'bear', 'Volume spike + 1h trend → follow'),
    // Previous candle
    analyzeFilter(samples, s => s.prevGreen && s.trend1h === 'bullish', () => 'bull', 'Prev green + 1h bull → BULL'),
    analyzeFilter(samples, s => !s.prevGreen && s.trend1h === 'bearish', () => 'bear', 'Prev red + 1h bear → BEAR'),
  ];
}

function printResults(results: FilterResult[], label: string) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`${label}`);
  console.log(`${'─'.repeat(80)}`);
  console.log('  Strategy                                      |   N  |  Pct  | WinRate |  Edge');
  console.log('  ' + '-'.repeat(76));

  const sorted = [...results].sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  for (const r of sorted) {
    const edgeStr = `${r.edge >= 0 ? '+' : ''}${r.edge.toFixed(2)}%`;
    const bar = '█'.repeat(Math.min(8, Math.max(0, Math.round(Math.abs(r.edge)))));
    console.log(
      `  ${r.label.substring(0, 46).padEnd(46)}| ${r.selected.toString().padStart(5)}| ${r.pct.toFixed(1).padStart(5)}%| ${r.winRate.toFixed(2).padStart(7)}%|${edgeStr.padStart(7)} ${bar}`
    );
  }
  return sorted;
}

async function main() {
  console.log('📊 Multi-Timeframe Analysis — ETH 5m Binary Prediction');
  console.log('Hypothesis: 4h/1h trend alignment improves 5m win rate');
  console.log('═'.repeat(80));

  const COIN = 'ETH';
  const FROM_MS = 1754006400000;
  const TO_MS   = 1769903700000;
  const SPLIT_MS = FROM_MS + Math.floor((TO_MS - FROM_MS) * 0.7);

  console.log('\n1. Building MTF samples...');
  const allSamples = buildMTFSamples(COIN, FROM_MS, TO_MS);
  const trainSamples = allSamples.filter(s => s.time < SPLIT_MS);
  const testSamples = allSamples.filter(s => s.time >= SPLIT_MS);

  console.log(`   Total: ${allSamples.length} | Train: ${trainSamples.length} | Test: ${testSamples.length}`);

  const baseUpTrain = trainSamples.filter(s => s.nextCandleUp).length / trainSamples.length;
  const baseUpTest = testSamples.filter(s => s.nextCandleUp).length / testSamples.length;
  console.log(`   Base up rate — Train: ${(baseUpTrain * 100).toFixed(2)}% | Test: ${(baseUpTest * 100).toFixed(2)}%`);

  console.log('\n2. Running filter analysis...');
  const trainResults = runFilters(trainSamples);
  const testResults = runFilters(testSamples);

  printResults(trainResults, '📚 TRAINING (Aug-Dec 2025)');
  printResults(testResults, '🎯 TEST (Dec 2025-Jan 2026)');

  // Cross-validation
  console.log('\n' + '═'.repeat(80));
  console.log('📊 CROSS-VALIDATION — which strategies hold up out-of-sample?');
  console.log('═'.repeat(80));
  console.log('  Strategy                                | Train Edge | Test Edge | Verdict');
  console.log('  ' + '-'.repeat(76));

  const trainSorted = [...trainResults].sort((a, b) => b.edge - a.edge);
  for (const tr of trainSorted) {
    const te = testResults.find(r => r.label === tr.label);
    if (!te) continue;
    const sameDir = (tr.edge > 0) === (te.edge > 0);
    const verdict = !sameDir ? '❌ FLIPPED' : Math.abs(te.edge) < 0.5 ? '🟡 MARGINAL' : Math.abs(te.edge) < 1.5 ? '🟢 MODEST' : '✅ STRONG';
    const tEdge = `${tr.edge >= 0 ? '+' : ''}${tr.edge.toFixed(2)}%`;
    const teEdge = `${te.edge >= 0 ? '+' : ''}${te.edge.toFixed(2)}%`;
    console.log(`  ${tr.label.substring(0, 40).padEnd(40)}|${tEdge.padStart(11)} |${teEdge.padStart(10)} | ${verdict}`);
  }

  // Simulate best strategies on test
  console.log('\n' + '═'.repeat(80));
  console.log('💰 PROFIT SIMULATION on TEST period (bet $10/trade, flat):');
  console.log('═'.repeat(80));

  const goodStrategies = testResults
    .filter(r => r.selected >= 50 && r.edge > 0.5)
    .sort((a, b) => b.edge - a.edge);

  for (const s of goodStrategies.slice(0, 5)) {
    const wins = Math.round(s.selected * s.winRate / 100);
    const losses = s.selected - wins;
    const pnl = (wins - losses) * 10;
    const roi = (pnl / (s.selected * 10)) * 100;
    console.log(`  "${s.label}"`);
    console.log(`    ${s.selected} trades, WR=${s.winRate}%, PnL=$${pnl.toFixed(0)}, ROI=${roi.toFixed(1)}%`);
  }

  // Save
  const output = {
    generatedAt: new Date().toISOString(),
    hypothesis: 'MTF alignment improves 5m binary prediction',
    coin: COIN, baseUpRateTrain: baseUpTrain * 100, baseUpRateTest: baseUpTest * 100,
    testResults, trainResults,
    goodStrategies: goodStrategies.map(s => ({
      strategy: s.label, edge: s.edge, winRate: s.winRate, n: s.selected
    })),
  };

  fs.writeFileSync(path.join(RESEARCH_DIR, 'mtf-results.json'), JSON.stringify(output, null, 2));

  console.log('\n✅ MTF analysis saved to docs/backtest-research/mtf-results.json');
  console.log('\n' + '═'.repeat(80));
  console.log('KEY FINDING: See above. MTF trend alignment edge measured empirically.');
  console.log('Next step: integrate best MTF filter into backtestEngine for precise trading.');
  console.log('═'.repeat(80));
}

main().catch(console.error);
