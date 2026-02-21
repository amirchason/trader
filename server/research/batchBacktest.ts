/**
 * Batch backtest runner — runs 480+ configurations directly against SQLite.
 * No HTTP overhead. Results saved to docs/backtest-research/
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/batchBacktest.ts
 */

import fs from 'fs';
import path from 'path';
import { queryCandles } from '../db';
import { runBacktestForPair, aggregateResults } from '../backtestEngine';
import type { BacktestConfig, SignalMode, StrategyName, Trade } from '../backtestEngine';

// ─── Config ────────────────────────────────────────────────────────────────

const RESEARCH_DIR = path.join(process.cwd(), 'docs/backtest-research');
const RESULTS_FILE = path.join(RESEARCH_DIR, 'batch-results.json');
const SUMMARY_FILE = path.join(RESEARCH_DIR, 'summary.json');
const ML_FEATURES_FILE = path.join(RESEARCH_DIR, 'ml-features.json');

fs.mkdirSync(RESEARCH_DIR, { recursive: true });

const COIN = 'ETH';
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];
const SIGNAL_MODES: SignalMode[] = ['threshold', 'crossover', 'every_candle', 'combined'];
const THRESHOLDS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
const STRATEGIES: StrategyName[] = ['all', 'momentum_burst', 'mean_reversion', 'vwap'];
const INITIAL_CAPITAL = 1000;

// Time range from DB
const FROM_MS = 1754006400000;
const TO_MS   = 1769903700000;

// Train/test split: train on first 70%, validate on last 30%
const SPLIT_MS = FROM_MS + Math.floor((TO_MS - FROM_MS) * 0.7);

// ─── Types ─────────────────────────────────────────────────────────────────

interface RunResult {
  id: string;
  coin: string;
  timeframe: string;
  signalMode: SignalMode;
  strategy: StrategyName;
  threshold: number;
  period: 'train' | 'test' | 'full';
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  sharpe: number;
  maxDrawdown: number;
  profitFactor: number;
  edgePerTrade: number; // pnl / totalTrades (avg gain per trade)
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function runConfig(
  coin: string,
  timeframe: string,
  signalMode: SignalMode,
  strategy: StrategyName,
  threshold: number,
  fromMs: number,
  toMs: number,
  period: 'train' | 'test' | 'full',
): RunResult {
  const dbCandles = queryCandles(coin, timeframe, fromMs, toMs);
  if (dbCandles.length < 50) {
    return {
      id: `${coin}_${timeframe}_${signalMode}_${strategy}_${threshold}_${period}`,
      coin, timeframe, signalMode, strategy, threshold, period,
      totalTrades: 0, winRate: 0, totalPnl: 0, sharpe: 0, maxDrawdown: 0,
      profitFactor: 0, edgePerTrade: 0,
    };
  }

  const config: BacktestConfig = {
    coins: [coin],
    timeframes: [timeframe],
    strategies: [strategy],
    signalModes: [signalMode],
    thresholdMin: threshold,
    initialCapital: INITIAL_CAPITAL,
    fromMs,
    toMs,
  };

  const trades = runBacktestForPair(dbCandles, coin, timeframe, config);
  const result = aggregateResults(trades, config);
  const m = result.summary;

  return {
    id: `${coin}_${timeframe}_${signalMode}_${strategy}_${threshold}_${period}`,
    coin, timeframe, signalMode, strategy, threshold, period,
    totalTrades: m.totalTrades,
    winRate: m.totalTrades > 0 ? Math.round(m.winRate * 10000) / 100 : 0,
    totalPnl: Math.round(m.totalPnl * 100) / 100,
    sharpe: m.sharpe,
    maxDrawdown: Math.round(m.maxDrawdown * 10000) / 100,
    profitFactor: m.profitFactor,
    edgePerTrade: m.totalTrades > 0 ? Math.round((m.totalPnl / m.totalTrades) * 100) / 100 : 0,
  };
}

// ─── Feature extraction for ML ─────────────────────────────────────────────

interface MLSample {
  // Input features
  rsi14: number;
  rsi7: number;
  vwapDev: number;       // (price - vwap) / vwap * 100
  macdVal: number;       // MACD value (normalized by price)
  momentumStrength: number;
  bullishScore: number;
  bearishScore: number;
  scoreDiff: number;     // bullishScore - bearishScore
  // Derived features
  prevWin: number;       // previous trade was win (0/1)
  // Label
  label: number;         // 1 = next candle up, 0 = next candle down
}

function extractMLFeatures(coin: string, timeframe: string, fromMs: number, toMs: number): MLSample[] {
  const dbCandles = queryCandles(coin, timeframe, fromMs, toMs);
  if (dbCandles.length < 50) return [];

  // Re-run with every_candle to get all trades with rawFeatures
  const config: BacktestConfig = {
    coins: [coin],
    timeframes: [timeframe],
    strategies: ['all'],
    signalModes: ['every_candle'],
    thresholdMin: 0,
    initialCapital: INITIAL_CAPITAL,
    fromMs,
    toMs,
  };

  const trades = runBacktestForPair(dbCandles, coin, timeframe, config);
  const samples: MLSample[] = [];
  let prevWin = 0.5;

  for (const t of trades) {
    const vwap = t.rawFeatures.vwap ?? 0;
    const price = vwap; // use vwap as reference price proxy
    const vwapDev = vwap > 0 ? ((price - vwap) / vwap) * 100 : 0;
    const macdNorm = t.rawFeatures.macdVal ? t.rawFeatures.macdVal / (vwap > 0 ? vwap : 1) * 100 : 0;

    samples.push({
      rsi14: (t.rawFeatures.rsi14 ?? 50) / 100,
      rsi7: (t.rawFeatures.rsi7 ?? 50) / 100,
      vwapDev: Math.max(-5, Math.min(5, vwapDev)) / 5,
      macdVal: Math.max(-1, Math.min(1, macdNorm)),
      momentumStrength: Math.min(1, (t.rawFeatures.momentumStrength ?? 0) / 5),
      bullishScore: t.rawFeatures.bullishScore / 20,
      bearishScore: t.rawFeatures.bearishScore / 20,
      scoreDiff: (t.rawFeatures.bullishScore - t.rawFeatures.bearishScore) / 20,
      prevWin,
      label: t.direction === 'BULL' ? (t.result === 'WIN' ? 1 : 0) : (t.result === 'WIN' ? 0 : 1),
    });
    prevWin = t.result === 'WIN' ? 1 : 0;
  }

  return samples;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('🔬 Batch backtest research starting...');
  console.log(`   Coin: ${COIN}`);
  console.log(`   Timeframes: ${TIMEFRAMES.join(', ')}`);
  console.log(`   Signal modes: ${SIGNAL_MODES.join(', ')}`);
  console.log(`   Thresholds: ${THRESHOLDS.join(', ')}`);
  console.log(`   Strategies: ${STRATEGIES.join(', ')}`);
  console.log(`   Train period: ${new Date(FROM_MS).toISOString().slice(0,10)} → ${new Date(SPLIT_MS).toISOString().slice(0,10)}`);
  console.log(`   Test period:  ${new Date(SPLIT_MS).toISOString().slice(0,10)} → ${new Date(TO_MS).toISOString().slice(0,10)}`);
  console.log('');

  const trainResults: RunResult[] = [];
  const testResults: RunResult[] = [];
  const allResults: RunResult[] = [];

  let total = TIMEFRAMES.length * SIGNAL_MODES.length * THRESHOLDS.length * STRATEGIES.length;
  let done = 0;
  const startTime = Date.now();

  for (const tf of TIMEFRAMES) {
    for (const mode of SIGNAL_MODES) {
      for (const strat of STRATEGIES) {
        for (const thresh of THRESHOLDS) {
          // Train period
          const trainR = runConfig(COIN, tf, mode, strat, thresh, FROM_MS, SPLIT_MS, 'train');
          trainResults.push(trainR);
          allResults.push(trainR);

          // Test period
          const testR = runConfig(COIN, tf, mode, strat, thresh, SPLIT_MS, TO_MS, 'test');
          testResults.push(testR);
          allResults.push(testR);

          done++;
          if (done % 20 === 0) {
            const elapsed = (Date.now() - startTime) / 1000;
            const rate = done / elapsed;
            const eta = (total - done) / rate;
            process.stdout.write(`\r   Progress: ${done}/${total} configs (${Math.round(eta)}s remaining)`);
          }
        }
      }
    }
  }

  console.log(`\n\n✅ Completed ${total * 2} runs in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // ─── Analysis ──────────────────────────────────────────────────────────

  // Find best test-period configurations (that also performed well in training)
  const minTrades = 50;
  const validTest = testResults.filter(r => r.totalTrades >= minTrades);

  // Sort by: win rate > 52%, then by Sharpe, then by profit factor
  const profitableTest = validTest.filter(r => r.winRate > 51 && r.totalPnl > 0);
  profitableTest.sort((a, b) => b.sharpe - a.sharpe);

  // Cross-validate: check train performance too
  const crossValidated = profitableTest.filter(r => {
    const trainMatch = trainResults.find(
      t => t.timeframe === r.timeframe && t.signalMode === r.signalMode &&
           t.strategy === r.strategy && t.threshold === r.threshold
    );
    return trainMatch && trainMatch.winRate > 50 && trainMatch.totalTrades >= 100;
  });

  // Top performers by different metrics
  const topBySharpe = [...validTest].sort((a, b) => b.sharpe - a.sharpe).slice(0, 20);
  const topByWinRate = [...validTest].filter(r => r.totalTrades >= 100).sort((a, b) => b.winRate - a.winRate).slice(0, 20);
  const topByPnl = [...validTest].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 20);
  const topByEdge = [...validTest].filter(r => r.totalTrades >= 50).sort((a, b) => b.edgePerTrade - a.edgePerTrade).slice(0, 20);

  // Win rate distribution by mode
  const modeStats: Record<string, { avgWinRate: number; avgSharpe: number; count: number; profitable: number }> = {};
  for (const mode of SIGNAL_MODES) {
    const modeTests = validTest.filter(r => r.signalMode === mode);
    modeStats[mode] = {
      avgWinRate: modeTests.reduce((s, r) => s + r.winRate, 0) / (modeTests.length || 1),
      avgSharpe: modeTests.reduce((s, r) => s + r.sharpe, 0) / (modeTests.length || 1),
      count: modeTests.length,
      profitable: modeTests.filter(r => r.totalPnl > 0 && r.winRate > 52).length,
    };
  }

  // Win rate distribution by timeframe
  const tfStats: Record<string, { avgWinRate: number; avgSharpe: number; count: number; profitable: number }> = {};
  for (const tf of TIMEFRAMES) {
    const tfTests = validTest.filter(r => r.timeframe === tf);
    tfStats[tf] = {
      avgWinRate: tfTests.reduce((s, r) => s + r.winRate, 0) / (tfTests.length || 1),
      avgSharpe: tfTests.reduce((s, r) => s + r.sharpe, 0) / (tfTests.length || 1),
      count: tfTests.length,
      profitable: tfTests.filter(r => r.totalPnl > 0 && r.winRate > 52).length,
    };
  }

  // Threshold analysis
  const threshStats: Record<number, { avgWinRate: number; avgSharpe: number; count: number }> = {};
  for (const thresh of THRESHOLDS) {
    const tTests = validTest.filter(r => r.threshold === thresh);
    threshStats[thresh] = {
      avgWinRate: tTests.reduce((s, r) => s + r.winRate, 0) / (tTests.length || 1),
      avgSharpe: tTests.reduce((s, r) => s + r.sharpe, 0) / (tTests.length || 1),
      count: tTests.length,
    };
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    totalRuns: allResults.length,
    validTestRuns: validTest.length,
    profitableTestRuns: profitableTest.length,
    crossValidatedRuns: crossValidated.length,
    modeStats,
    tfStats,
    threshStats,
    topBySharpe: topBySharpe.slice(0, 10),
    topByWinRate: topByWinRate.slice(0, 10),
    topByPnl: topByPnl.slice(0, 10),
    topByEdge: topByEdge.slice(0, 10),
    crossValidated: crossValidated.slice(0, 20),
  };

  // ─── ML Features ──────────────────────────────────────────────────────

  console.log('\n📊 Extracting ML features from 5m candles...');
  const trainFeatures = extractMLFeatures(COIN, '5m', FROM_MS, SPLIT_MS);
  const testFeatures = extractMLFeatures(COIN, '5m', SPLIT_MS, TO_MS);
  console.log(`   Train samples: ${trainFeatures.length}, Test samples: ${testFeatures.length}`);

  // Simple feature analysis — correlation of each feature with label
  function correlation(features: MLSample[], key: keyof Omit<MLSample, 'label'>): number {
    const xs = features.map(f => f[key] as number);
    const ys = features.map(f => f.label);
    const n = xs.length;
    if (n === 0) return 0;
    const mx = xs.reduce((s, x) => s + x, 0) / n;
    const my = ys.reduce((s, y) => s + y, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) ** 2;
      dy += (ys[i] - my) ** 2;
    }
    return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  }

  const featureKeys: (keyof Omit<MLSample, 'label'>)[] = [
    'rsi14', 'rsi7', 'vwapDev', 'macdVal', 'momentumStrength',
    'bullishScore', 'bearishScore', 'scoreDiff', 'prevWin',
  ];

  const featureCorrelations: Record<string, number> = {};
  for (const key of featureKeys) {
    featureCorrelations[key] = Math.round(correlation(trainFeatures, key) * 10000) / 10000;
  }

  // Base rate (how often is next candle up?)
  const trainUpRate = trainFeatures.length > 0
    ? trainFeatures.filter(f => f.label === 1).length / trainFeatures.length
    : 0.5;
  const testUpRate = testFeatures.length > 0
    ? testFeatures.filter(f => f.label === 1).length / testFeatures.length
    : 0.5;

  const mlAnalysis = {
    generatedAt: new Date().toISOString(),
    trainSamples: trainFeatures.length,
    testSamples: testFeatures.length,
    trainUpRate: Math.round(trainUpRate * 10000) / 100,
    testUpRate: Math.round(testUpRate * 10000) / 100,
    featureCorrelations,
    note: 'Correlations close to 0 = weak predictors. |corr| > 0.05 is meaningful.',
    trainFeaturesSample: trainFeatures.slice(0, 100),
    testFeaturesSample: testFeatures.slice(0, 100),
  };

  // ─── Save results ─────────────────────────────────────────────────────

  console.log('\n💾 Saving results...');
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2));
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  fs.writeFileSync(ML_FEATURES_FILE, JSON.stringify(mlAnalysis, null, 2));
  console.log(`   Saved ${allResults.length} results to ${RESULTS_FILE}`);
  console.log(`   Saved summary to ${SUMMARY_FILE}`);
  console.log(`   Saved ML features to ${ML_FEATURES_FILE}`);

  // ─── Print report ─────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(70));
  console.log('📈 BACKTEST RESEARCH REPORT — ETH Binary Prediction');
  console.log('═'.repeat(70));

  console.log('\n📊 Signal Mode Analysis (test period):');
  console.log('  Mode           | AvgWinRate | AvgSharpe | Profitable');
  console.log('  ' + '-'.repeat(55));
  for (const [mode, s] of Object.entries(modeStats)) {
    console.log(`  ${mode.padEnd(15)}| ${s.avgWinRate.toFixed(2).padStart(9)}% | ${s.avgSharpe.toFixed(3).padStart(9)} | ${s.profitable}`);
  }

  console.log('\n⏱️ Timeframe Analysis (test period):');
  console.log('  TF    | AvgWinRate | AvgSharpe | Profitable');
  console.log('  ' + '-'.repeat(45));
  for (const [tf, s] of Object.entries(tfStats)) {
    console.log(`  ${tf.padEnd(6)}| ${s.avgWinRate.toFixed(2).padStart(9)}% | ${s.avgSharpe.toFixed(3).padStart(9)} | ${s.profitable}`);
  }

  console.log('\n🎯 Threshold Analysis (test period):');
  for (const [thresh, s] of Object.entries(threshStats)) {
    const bar = '█'.repeat(Math.max(0, Math.round((s.avgWinRate - 48) * 5)));
    console.log(`  thresh=${parseFloat(thresh).toFixed(1)}: ${s.avgWinRate.toFixed(2)}% ${bar}`);
  }

  console.log('\n🏆 Top 10 by Sharpe (test, cross-validated):');
  const top10 = crossValidated.slice(0, 10);
  if (top10.length === 0) console.log('  None found — see topBySharpe in summary.json');
  for (const r of top10) {
    console.log(`  ${r.timeframe} | ${r.signalMode} | ${r.strategy} | thresh=${r.threshold} → WR=${r.winRate}% Sharpe=${r.sharpe} PnL=${r.totalPnl}`);
  }

  console.log('\n🧠 ML Feature Correlations with Next-Candle Direction:');
  const sortedCorr = Object.entries(featureCorrelations).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [feat, corr] of sortedCorr) {
    const bar = '█'.repeat(Math.round(Math.abs(corr) * 100));
    const dir = corr > 0 ? '+' : '-';
    console.log(`  ${feat.padEnd(20)}: ${dir}${Math.abs(corr).toFixed(4)} ${bar}`);
  }

  console.log('\n📊 Base Rate Analysis:');
  console.log(`  Train period: next candle UP ${trainUpRate * 100 > 50 ? trainUpRate * 100 - 50 : 50 - trainUpRate * 100}% bias toward ${trainUpRate > 0.5 ? 'bullish' : 'bearish'}`);
  console.log(`  Test period:  next candle UP ${testUpRate * 100 > 50 ? testUpRate * 100 - 50 : 50 - testUpRate * 100}% bias toward ${testUpRate > 0.5 ? 'bullish' : 'bearish'}`);
  console.log(`  Train up rate: ${(trainUpRate * 100).toFixed(2)}% | Test up rate: ${(testUpRate * 100).toFixed(2)}%`);

  console.log('\n' + '═'.repeat(70));
  console.log('Research complete. Results saved to docs/backtest-research/');
  console.log('Next step: implement ML classifier using top features.');
  console.log('═'.repeat(70));
}

main().catch(console.error);
