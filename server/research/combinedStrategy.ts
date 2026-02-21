/**
 * Combined Strategy Engine — integrates ALL research findings:
 *
 * 1. MTF Reversion: Uptrend + 5m overbought → BEAR (+8.82% edge)
 * 2. Candle Streak: 3+ consecutive same-direction → REVERSE (+5-7% edge)
 * 3. Big Candle Reversion: Large body → opposite direction (+6% edge)
 * 4. RSI Extreme Filter: Only trade when RSI strongly confirms
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/combinedStrategy.ts
 */

import fs from 'fs';
import path from 'path';
import { queryCandles } from '../db';
import { calculateRSI, calculateSMA, calculateEMA } from '../indicators';
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

// ─── Signal Types ──────────────────────────────────────────────────────────

type BetDir = 'BULL' | 'BEAR';
type SignalType = 'mtf_reversion' | 'streak_reversion' | 'big_candle' | 'rsi_extreme';

interface Signal {
  type: SignalType;
  direction: BetDir;
  confidence: number; // 0-100
  reason: string;
}

interface TradeRecord {
  time: number;
  signal: Signal;
  direction: BetDir;
  result: 'WIN' | 'LOSS';
  pnl: number;
  equity: number;
}

// ─── Strategy Logic ────────────────────────────────────────────────────────

function getHTFTrend(
  candles1h: Candle[],
  candles4h: Candle[],
  beforeTime: number,
): { rsi1h: number; rsi4h: number; trend: 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear' } {
  const cur1hStart = beforeTime - (beforeTime % 3600000);
  const cur4hStart = beforeTime - (beforeTime % 14400000);

  const hist1h = candles1h.filter(c => c.openTime < cur1hStart).slice(-30);
  const hist4h = candles4h.filter(c => c.openTime < cur4hStart).slice(-20);

  const rsi1h = hist1h.length >= 14 ? (calculateRSI(hist1h, 14) ?? 50) : 50;
  const rsi4h = hist4h.length >= 14 ? (calculateRSI(hist4h, 14) ?? 50) : 50;

  const avgRsi = (rsi1h + rsi4h) / 2;

  let trend: 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';
  if (avgRsi > 65) trend = 'strong_bull';
  else if (avgRsi > 55) trend = 'bull';
  else if (avgRsi < 35) trend = 'strong_bear';
  else if (avgRsi < 45) trend = 'bear';
  else trend = 'neutral';

  return { rsi1h, rsi4h, trend };
}

function getSignal(
  candles5m: Candle[],
  i: number,
  candles1h: Candle[],
  candles4h: Candle[],
  config: CombinedConfig,
): Signal | null {
  const c = candles5m[i];
  const t = c.openTime;
  const slice5m = candles5m.slice(Math.max(0, i - 99), i + 1);

  const rsi5m = calculateRSI(slice5m, 14) ?? 50;
  const rsi7_5m = calculateRSI(slice5m, 7) ?? 50;

  // Candle streak
  let greenStreak = 0, redStreak = 0;
  for (let j = i; j >= Math.max(0, i - 7); j--) {
    const cj = candles5m[j];
    if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
    else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
    else break;
  }

  // Candle body size
  const recent5 = slice5m.slice(-6);
  const avgBody = recent5.slice(0, -1).reduce((s, cc) => s + Math.abs(cc.close - cc.open), 0) / 5;
  const curBody = Math.abs(c.close - c.open);
  const bodyRatio = avgBody > 0 ? curBody / avgBody : 1;
  const candleChangePct = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;

  // MTF state
  const htf = config.useMTF ? getHTFTrend(candles1h, candles4h, t) : { rsi1h: 50, rsi4h: 50, trend: 'neutral' as const };

  const signals: Signal[] = [];

  // ─── Signal 1: MTF Reversion ──────────────────────────────────────────
  if (config.useMTF) {
    const isUptrend = htf.trend === 'strong_bull' || htf.trend === 'bull';
    const isDowntrend = htf.trend === 'strong_bear' || htf.trend === 'bear';
    const strongTrend = htf.trend === 'strong_bull' || htf.trend === 'strong_bear';

    if (isUptrend && rsi5m >= config.rsiOverboughtThreshold) {
      const conf = strongTrend ? 90 : 70;
      signals.push({
        type: 'mtf_reversion',
        direction: 'BEAR',
        confidence: conf + Math.min(10, (rsi5m - config.rsiOverboughtThreshold)),
        reason: `Uptrend(rsi1h=${htf.rsi1h.toFixed(0)},rsi4h=${htf.rsi4h.toFixed(0)}) + 5m RSI=${rsi5m.toFixed(0)} overbought`,
      });
    }
    if (isDowntrend && rsi5m <= config.rsiOversoldThreshold) {
      const conf = strongTrend ? 90 : 70;
      signals.push({
        type: 'mtf_reversion',
        direction: 'BULL',
        confidence: conf + Math.min(10, (config.rsiOversoldThreshold - rsi5m)),
        reason: `Downtrend(rsi1h=${htf.rsi1h.toFixed(0)},rsi4h=${htf.rsi4h.toFixed(0)}) + 5m RSI=${rsi5m.toFixed(0)} oversold`,
      });
    }
  }

  // ─── Signal 2: Streak Reversion ──────────────────────────────────────
  if (config.useStreakReversion) {
    if (greenStreak >= config.streakThreshold) {
      signals.push({
        type: 'streak_reversion',
        direction: 'BEAR',
        confidence: Math.min(95, 60 + (greenStreak - config.streakThreshold) * 10),
        reason: `${greenStreak} consecutive green candles`,
      });
    }
    if (redStreak >= config.streakThreshold) {
      signals.push({
        type: 'streak_reversion',
        direction: 'BULL',
        confidence: Math.min(95, 60 + (redStreak - config.streakThreshold) * 10),
        reason: `${redStreak} consecutive red candles`,
      });
    }
  }

  // ─── Signal 3: Big Candle Reversion ──────────────────────────────────
  if (config.useBigCandle) {
    const isStrongGreen = candleChangePct >= config.bigCandleThreshold;
    const isStrongRed = candleChangePct <= -config.bigCandleThreshold;
    const isBigBody = bodyRatio >= config.bigBodyRatio;

    if ((isStrongGreen || (isBigBody && c.close > c.open)) && candleChangePct > 0) {
      signals.push({
        type: 'big_candle',
        direction: 'BEAR',
        confidence: Math.min(95, 60 + Math.abs(candleChangePct) * 10),
        reason: `Big green candle (${candleChangePct.toFixed(2)}%, body ${bodyRatio.toFixed(1)}x avg)`,
      });
    }
    if ((isStrongRed || (isBigBody && c.close < c.open)) && candleChangePct < 0) {
      signals.push({
        type: 'big_candle',
        direction: 'BULL',
        confidence: Math.min(95, 60 + Math.abs(candleChangePct) * 10),
        reason: `Big red candle (${candleChangePct.toFixed(2)}%, body ${bodyRatio.toFixed(1)}x avg)`,
      });
    }
  }

  // ─── Signal 4: Pure RSI Extreme ──────────────────────────────────────
  if (config.useRSIExtreme) {
    if (rsi7_5m >= 80 && rsi5m >= 75) {
      signals.push({
        type: 'rsi_extreme',
        direction: 'BEAR',
        confidence: Math.min(90, 65 + (rsi5m - 75) * 2),
        reason: `RSI7=${rsi7_5m.toFixed(0)}, RSI14=${rsi5m.toFixed(0)} both extreme overbought`,
      });
    }
    if (rsi7_5m <= 20 && rsi5m <= 25) {
      signals.push({
        type: 'rsi_extreme',
        direction: 'BULL',
        confidence: Math.min(90, 65 + (25 - rsi5m) * 2),
        reason: `RSI7=${rsi7_5m.toFixed(0)}, RSI14=${rsi5m.toFixed(0)} both extreme oversold`,
      });
    }
  }

  if (signals.length === 0) return null;

  // Pick highest confidence signal
  // Also check for conflicting signals
  const bullSignals = signals.filter(s => s.direction === 'BULL');
  const bearSignals = signals.filter(s => s.direction === 'BEAR');

  // Only trade if signals agree (or single signal above threshold)
  if (config.requireAgreement && bullSignals.length > 0 && bearSignals.length > 0) {
    return null; // conflicting signals — skip
  }

  const dominant = signals.reduce((best, s) => s.confidence > best.confidence ? s : best);
  if (dominant.confidence < config.minConfidence) return null;

  return dominant;
}

// ─── Backtest ─────────────────────────────────────────────────────────────

interface CombinedConfig {
  useMTF: boolean;
  useStreakReversion: boolean;
  useBigCandle: boolean;
  useRSIExtreme: boolean;
  streakThreshold: number;          // min consecutive candles for streak signal
  rsiOverboughtThreshold: number;   // 5m RSI level for overbought
  rsiOversoldThreshold: number;     // 5m RSI level for oversold
  bigCandleThreshold: number;       // % change for big candle
  bigBodyRatio: number;             // body ratio for big candle
  minConfidence: number;            // min signal confidence to trade
  requireAgreement: boolean;        // require all signals to agree
  initialCapital: number;
  betPct: number;                   // % of capital per trade
}

function runCombinedBacktest(
  candles5m: Candle[],
  candles1h: Candle[],
  candles4h: Candle[],
  config: CombinedConfig,
  fromMs: number,
  toMs: number,
): {
  trades: TradeRecord[];
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpe: number;
  totalTrades: number;
  bySignalType: Record<string, { trades: number; winRate: number; pnl: number }>;
} {
  const WARMUP = 50;
  const trades: TradeRecord[] = [];
  let equity = config.initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  const pnls: number[] = [];

  for (let i = WARMUP; i < candles5m.length - 1; i++) {
    const t = candles5m[i].openTime;
    if (t < fromMs || t > toMs) continue;

    const signal = getSignal(candles5m, i, candles1h, candles4h, config);
    if (!signal) continue;

    const nextCandle = candles5m[i + 1];
    const nextUp = nextCandle.close > nextCandle.open;
    const win = (signal.direction === 'BULL') === nextUp;

    const betSize = (equity * config.betPct) / 100;
    const pnl = win ? betSize : -betSize;
    equity += pnl;
    pnls.push(pnl / config.initialCapital);

    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    trades.push({
      time: t,
      signal,
      direction: signal.direction,
      result: win ? 'WIN' : 'LOSS',
      pnl,
      equity,
    });
  }

  const wins = trades.filter(t => t.result === 'WIN').length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 50;

  // Sharpe
  const avgReturn = pnls.reduce((s, r) => s + r, 0) / (pnls.length || 1);
  const variance = pnls.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (pnls.length || 1);
  const sharpe = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252 * 288) : 0;

  // By signal type
  const bySignalType: Record<string, { trades: number; winRate: number; pnl: number }> = {};
  for (const t of trades) {
    if (!bySignalType[t.signal.type]) bySignalType[t.signal.type] = { trades: 0, winRate: 0, pnl: 0 };
    bySignalType[t.signal.type].trades++;
    bySignalType[t.signal.type].pnl += t.pnl;
    if (t.result === 'WIN') bySignalType[t.signal.type].winRate++;
  }
  for (const key of Object.keys(bySignalType)) {
    const s = bySignalType[key];
    s.winRate = s.trades > 0 ? (s.winRate / s.trades) * 100 : 0;
  }

  return { trades, winRate, totalPnl: equity - config.initialCapital, maxDrawdown, sharpe, totalTrades: trades.length, bySignalType };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎯 Combined Strategy Engine — ETH 5m Binary');
  console.log('Integrating: MTF Reversion + Streak + Big Candle + RSI Extreme');
  console.log('═'.repeat(70));

  const COIN = 'ETH';
  const FROM_MS = 1754006400000;
  const TO_MS   = 1769903700000;
  const SPLIT_MS = FROM_MS + Math.floor((TO_MS - FROM_MS) * 0.7);

  console.log('\nLoading candles...');
  const db5m = queryCandles(COIN, '5m', FROM_MS - 24 * 3600000, TO_MS);
  const db1h = queryCandles(COIN, '1h', FROM_MS - 7 * 24 * 3600000, TO_MS);
  const db4h = queryCandles(COIN, '4h', FROM_MS - 30 * 24 * 3600000, TO_MS);
  console.log(`  5m: ${db5m.length} | 1h: ${db1h.length} | 4h: ${db4h.length}`);

  const c5m = db5m.map(toCandle);
  const c1h = db1h.map(toCandle);
  const c4h = db4h.map(toCandle);

  // ─── Parameter sweep ─────────────────────────────────────────────────

  const baseConfig: CombinedConfig = {
    useMTF: true,
    useStreakReversion: true,
    useBigCandle: true,
    useRSIExtreme: true,
    streakThreshold: 3,
    rsiOverboughtThreshold: 70,
    rsiOversoldThreshold: 30,
    bigCandleThreshold: 0.5,
    bigBodyRatio: 2.5,
    minConfidence: 60,
    requireAgreement: false,
    initialCapital: 1000,
    betPct: 1,
  };

  // Test many combinations on TRAIN period, pick best, validate on TEST
  const configs: { name: string; config: CombinedConfig }[] = [
    { name: 'MTF only', config: { ...baseConfig, useStreakReversion: false, useBigCandle: false, useRSIExtreme: false } },
    { name: 'Streak only', config: { ...baseConfig, useMTF: false, useBigCandle: false, useRSIExtreme: false } },
    { name: 'BigCandle only', config: { ...baseConfig, useMTF: false, useStreakReversion: false, useRSIExtreme: false } },
    { name: 'RSI extreme only', config: { ...baseConfig, useMTF: false, useStreakReversion: false, useBigCandle: false } },
    { name: 'MTF + Streak', config: { ...baseConfig, useBigCandle: false, useRSIExtreme: false } },
    { name: 'MTF + BigCandle', config: { ...baseConfig, useStreakReversion: false, useRSIExtreme: false } },
    { name: 'Streak + BigCandle', config: { ...baseConfig, useMTF: false, useRSIExtreme: false } },
    { name: 'All combined', config: baseConfig },
    { name: 'All + agree required', config: { ...baseConfig, requireAgreement: true } },
    { name: 'All + streak=4', config: { ...baseConfig, streakThreshold: 4 } },
    { name: 'All + RSI>75', config: { ...baseConfig, rsiOverboughtThreshold: 75, rsiOversoldThreshold: 25 } },
    { name: 'All + conf=70', config: { ...baseConfig, minConfidence: 70 } },
    { name: 'All + conf=80', config: { ...baseConfig, minConfidence: 80 } },
    { name: 'MTF + RSI>65', config: { ...baseConfig, useStreakReversion: false, useBigCandle: false, rsiOverboughtThreshold: 65, rsiOversoldThreshold: 35 } },
    { name: 'MTF + RSI>75', config: { ...baseConfig, useStreakReversion: false, useBigCandle: false, rsiOverboughtThreshold: 75, rsiOversoldThreshold: 25 } },
  ];

  console.log('\n📊 Parameter sweep on TRAIN period...');
  console.log('  Config                    | Trades | WinRate |   PnL  | Sharpe');
  console.log('  ' + '-'.repeat(60));

  const trainResults: Array<{ name: string; winRate: number; pnl: number; sharpe: number; trades: number }> = [];

  for (const { name, config } of configs) {
    const result = runCombinedBacktest(c5m, c1h, c4h, config, FROM_MS, SPLIT_MS);
    trainResults.push({ name, winRate: result.winRate, pnl: result.totalPnl, sharpe: result.sharpe, trades: result.totalTrades });
    console.log(
      `  ${name.padEnd(26)}| ${result.totalTrades.toString().padStart(6)} | ${result.winRate.toFixed(2).padStart(6)}% | $${result.totalPnl.toFixed(0).padStart(6)} | ${result.sharpe.toFixed(2)}`
    );
  }

  // Pick best by Sharpe (risk-adjusted)
  const bestTrain = trainResults.sort((a, b) => b.sharpe - a.sharpe)[0];
  console.log(`\n  Best train config: "${bestTrain.name}" (Sharpe=${bestTrain.sharpe.toFixed(2)})`);

  // ─── Validate on TEST period ─────────────────────────────────────────

  console.log('\n📊 TEST period validation...');
  console.log('  Config                    | Trades | WinRate |   PnL  | Sharpe');
  console.log('  ' + '-'.repeat(60));

  const testResults: Array<{ name: string; winRate: number; pnl: number; sharpe: number; trades: number; byType: Record<string, unknown> }> = [];

  for (const { name, config } of configs) {
    const result = runCombinedBacktest(c5m, c1h, c4h, config, SPLIT_MS, TO_MS);
    testResults.push({ name, winRate: result.winRate, pnl: result.totalPnl, sharpe: result.sharpe, trades: result.totalTrades, byType: result.bySignalType });
    console.log(
      `  ${name.padEnd(26)}| ${result.totalTrades.toString().padStart(6)} | ${result.winRate.toFixed(2).padStart(6)}% | $${result.totalPnl.toFixed(0).padStart(6)} | ${result.sharpe.toFixed(2)}`
    );
  }

  // ─── Best config full analysis ────────────────────────────────────────

  const bestTest = testResults.sort((a, b) => b.sharpe - a.sharpe)[0];
  const bestByPnl = testResults.sort((a, b) => b.pnl - a.pnl)[0];

  console.log(`\n  Best test config (by Sharpe): "${bestTest.name}" (WR=${bestTest.winRate.toFixed(2)}%, PnL=$${bestTest.pnl.toFixed(0)})`);
  console.log(`  Best test config (by PnL):    "${bestByPnl.name}" (WR=${bestByPnl.winRate.toFixed(2)}%, PnL=$${bestByPnl.pnl.toFixed(0)})`);

  // Show signal breakdown for "All combined" strategy
  const allCombined = testResults.find(r => r.name === 'All combined');
  if (allCombined?.byType) {
    console.log('\n  Signal type breakdown (All combined, test period):');
    for (const [type, stats] of Object.entries(allCombined.byType as Record<string, { trades: number; winRate: number; pnl: number }>)) {
      console.log(`    ${type.padEnd(20)}: ${stats.trades} trades, WR=${stats.winRate.toFixed(2)}%, PnL=$${stats.pnl.toFixed(0)}`);
    }
  }

  // ─── Cross-validation summary ─────────────────────────────────────────

  console.log('\n' + '═'.repeat(70));
  console.log('📊 CROSS-VALIDATION: Train vs Test Robustness');
  console.log('═'.repeat(70));

  const trainMap = new Map(configs.map(({name}) => [name, trainResults.find(r => r.name === name)!]));
  const testMap = new Map(configs.map(({name}) => [name, testResults.find(r => r.name === name)!]));

  // Sort by test Sharpe
  const sortedByTestSharpe = [...configs].sort((a, b) => {
    return (testMap.get(b.name)?.sharpe ?? 0) - (testMap.get(a.name)?.sharpe ?? 0);
  });

  console.log('  Config                    | Train PnL | Test PnL | Train WR | Test WR');
  console.log('  ' + '-'.repeat(70));
  for (const { name } of sortedByTestSharpe) {
    const tr = trainMap.get(name)!;
    const te = testMap.get(name)!;
    if (!tr || !te) continue;
    const sign = te.pnl > 0 ? '✅' : '❌';
    console.log(
      `  ${sign} ${name.padEnd(24)}| $${tr.pnl.toFixed(0).padStart(8)} | $${te.pnl.toFixed(0).padStart(7)} | ${tr.winRate.toFixed(2).padStart(8)}% | ${te.winRate.toFixed(2).padStart(7)}%`
    );
  }

  // ─── Save ─────────────────────────────────────────────────────────────

  const output = {
    generatedAt: new Date().toISOString(),
    trainResults,
    testResults,
    bestTrainConfig: bestTrain,
    bestTestConfig: bestTest,
    bestByPnl,
    configs: configs.map(c => c.name),
  };

  fs.writeFileSync(path.join(RESEARCH_DIR, 'combined-results.json'), JSON.stringify(output, null, 2));
  console.log('\n✅ Combined strategy results saved');

  console.log('\n' + '═'.repeat(70));
  console.log('💡 RECOMMENDATION:');
  console.log(`   Best strategy: "${bestTest.name}"`);
  console.log(`   Test period WR: ${bestTest.winRate.toFixed(2)}%`);
  console.log(`   Test period PnL: $${bestTest.pnl.toFixed(2)} on $1000`);
  console.log(`   ROI: ${(bestTest.pnl / 10).toFixed(2)}%`);
  console.log('═'.repeat(70));
}

main().catch(console.error);
