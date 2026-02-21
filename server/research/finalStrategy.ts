/**
 * Final Comprehensive Strategy — ETH 5m (and multi-coin 15m)
 *
 * Combines ALL discovered edges:
 * 1. Bollinger Band reversion (BB(20,2)+RSI65 = 58.63% WR ETH/5m)
 * 2. Streak reversion + BB confirmation (streak(3)+BB(20,2) = 58.78%)
 * 3. Time filter (avoid 14:00 UTC for ETH, use known good hours)
 * 4. Body/ATR quality filter (≥0.9 boosts WR +3-4%)
 * 5. RSI confirmation (≥55 for BEAR, ≤45 for BULL)
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/finalStrategy.ts
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
    'SELECT * FROM candles WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC'
  ).all(coin, timeframe) as DbCandle[];
}

const BET = 10;

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcSMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  return closes.slice(-period).reduce((a, b) => a + b) / period;
}
function calcStdDev(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b) / period;
  return Math.sqrt(slice.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
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

interface Result { trades: number; wins: number; wr: number; pnl: number }

function runStrategy(
  candles: DbCandle[],
  fn: (i: number) => 'BULL' | 'BEAR' | null,
  WARMUP = 25
): Result {
  let wins = 0, total = 0;
  for (let i = WARMUP; i < candles.length - 1; i++) {
    const sig = fn(i);
    if (!sig) continue;
    const nextUp = candles[i + 1].close > candles[i + 1].open;
    if ((sig === 'BULL') === nextUp) wins++;
    total++;
  }
  const wr = total ? wins / total : 0;
  return { trades: total, wins, wr, pnl: wins * BET - (total - wins) * BET };
}

// ─── Signal functions (reusable) ──────────────────────────────────────────────
function getSignal(candles: DbCandle[], i: number, opts: {
  useStreak?: boolean;
  useBB?: boolean;
  useBodyATR?: boolean;
  useRSI?: boolean;
  useTimeFilter?: boolean;
  badHours?: number[];
  goodHours?: number[] | null;
  streakLen?: number;
  bbPeriod?: number;
  bbMult?: number;
  rsiThresh?: number;
  bodyATRMin?: number;
  useBigCandle?: boolean;
  bigCandlePct?: number;
}): 'BULL' | 'BEAR' | null {
  const {
    useStreak = true, useBB = false, useBodyATR = false, useRSI = false,
    useTimeFilter = false, badHours = [14], goodHours = null,
    streakLen = 3, bbPeriod = 20, bbMult = 2, rsiThresh = 55,
    bodyATRMin = 0.9, useBigCandle = false, bigCandlePct = 0.5,
  } = opts;

  const c = candles[i];

  // Time filter
  if (useTimeFilter) {
    const hour = new Date(c.open_time).getUTCHours();
    if (badHours.includes(hour)) return null;
    if (goodHours && !goodHours.includes(hour)) return null;
  }

  // Get closes for indicators
  const closes = candles.slice(Math.max(0, i - 55), i + 1).map(x => x.close);

  // BB signal
  let bbSignal: 'BULL' | 'BEAR' | null = null;
  if (useBB && closes.length >= bbPeriod + 1) {
    const sma = calcSMA(closes, bbPeriod);
    const std = calcStdDev(closes, bbPeriod);
    if (std > 0) {
      const upper = sma + bbMult * std;
      const lower = sma - bbMult * std;
      if (c.close > upper) bbSignal = 'BEAR';
      else if (c.close < lower) bbSignal = 'BULL';
    }
  }

  // Streak signal
  let streakSignal: 'BULL' | 'BEAR' | null = null;
  if (useStreak) {
    let green = 0, red = 0;
    for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
      const cj = candles[j];
      if (cj.close > cj.open) { if (red > 0) break; green++; }
      else if (cj.close < cj.open) { if (green > 0) break; red++; }
      else break;
    }
    if (green >= streakLen) streakSignal = 'BEAR';
    else if (red >= streakLen) streakSignal = 'BULL';
  }

  // Big candle signal
  let bigSignal: 'BULL' | 'BEAR' | null = null;
  if (useBigCandle && c.open > 0) {
    const chg = (c.close - c.open) / c.open * 100;
    if (chg >= bigCandlePct) bigSignal = 'BEAR';
    else if (chg <= -bigCandlePct) bigSignal = 'BULL';
  }

  // Determine combined signal
  let signal: 'BULL' | 'BEAR' | null = null;
  if (useBB && useBigCandle && useStreak) {
    // Triple: all three must agree or any two
    const signals = [bbSignal, streakSignal, bigSignal].filter(s => s !== null);
    if (signals.length >= 2) {
      const bearVotes = signals.filter(s => s === 'BEAR').length;
      const bullVotes = signals.filter(s => s === 'BULL').length;
      if (bearVotes >= 2) signal = 'BEAR';
      else if (bullVotes >= 2) signal = 'BULL';
    }
  } else if (useBB && useStreak) {
    // Both must agree
    if (bbSignal && streakSignal && bbSignal === streakSignal) signal = bbSignal;
  } else if (useBB) {
    signal = bbSignal;
  } else if (useStreak) {
    signal = streakSignal;
  } else if (useBigCandle) {
    signal = bigSignal;
  }

  if (!signal) return null;

  // RSI confirmation
  if (useRSI && closes.length >= 15) {
    const rsi = calcRSI(closes.slice(-16), 14);
    if (signal === 'BEAR' && rsi < rsiThresh) return null;
    if (signal === 'BULL' && rsi > (100 - rsiThresh)) return null;
  }

  // Body/ATR quality filter
  if (useBodyATR) {
    const atr = calcATR(candles.slice(Math.max(0, i - 14), i + 1), 14);
    if (atr > 0 && c.open > 0) {
      const bodyPct = Math.abs(c.close - c.open) / c.open * 100;
      const bodyATR = bodyPct / 100 * c.close / atr;
      if (bodyATR < bodyATRMin) return null;
    }
  }

  return signal;
}

// ─── ETH/5m comprehensive test ────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🚀 FINAL COMPREHENSIVE STRATEGY — ETH/5m');
console.log('══════════════════════════════════════════════════════════════');
console.log('Testing all combinations of discovered edges\n');

const eth5m = queryCandles('ETH', '5m');
const eth5mSplit = Math.floor(eth5m.length * 0.7);
const eth5mTrain = eth5m.slice(0, eth5mSplit);
const eth5mTest = eth5m.slice(eth5mSplit);
console.log(`Train: ${eth5mTrain.length} candles, Test: ${eth5mTest.length} candles (${new Date(eth5mTest[0].open_time).toISOString().slice(0,10)} → ${new Date(eth5mTest[eth5mTest.length-1].open_time).toISOString().slice(0,10)})\n`);

// ETH 5m best hours from analysis (avoid 14:00, use top performers)
const ETH5M_BAD_HOURS = [14]; // confirmed loser
const ETH5M_GOOD_HOURS = [0,1,2,3,4,5,6,7,16,17,18,19,20,21,22,23]; // no-euro

const configs5m: Array<{ name: string; opts: Parameters<typeof getSignal>[2] }> = [
  // Baselines
  { name: 'Streak(3) — baseline', opts: { useStreak: true } },
  { name: 'BB(20,2) — baseline', opts: { useBB: true, bbMult: 2 } },
  // Filters added one at a time
  { name: 'Streak + RSI55', opts: { useStreak: true, useRSI: true, rsiThresh: 55 } },
  { name: 'Streak + BodyATR0.9', opts: { useStreak: true, useBodyATR: true, bodyATRMin: 0.9 } },
  { name: 'Streak + noEuro', opts: { useStreak: true, useTimeFilter: true, goodHours: ETH5M_GOOD_HOURS } },
  { name: 'Streak + skip14', opts: { useStreak: true, useTimeFilter: true, badHours: ETH5M_BAD_HOURS } },
  { name: 'BB(20,2) + RSI65', opts: { useBB: true, bbMult: 2, useRSI: true, rsiThresh: 65 } },
  { name: 'BB(20,2) + skip14', opts: { useBB: true, bbMult: 2, useTimeFilter: true, badHours: ETH5M_BAD_HOURS } },
  { name: 'BB(20,2) + noEuro', opts: { useBB: true, bbMult: 2, useTimeFilter: true, goodHours: ETH5M_GOOD_HOURS } },
  // BB+Streak combo
  { name: 'Streak+BB(20,2)', opts: { useStreak: true, useBB: true, bbMult: 2 } },
  { name: 'Streak+BB(20,1.5)', opts: { useStreak: true, useBB: true, bbMult: 1.5 } },
  { name: 'Streak+BB+RSI55', opts: { useStreak: true, useBB: true, bbMult: 2, useRSI: true, rsiThresh: 55 } },
  { name: 'Streak+BB+BodyATR0.9', opts: { useStreak: true, useBB: true, bbMult: 2, useBodyATR: true, bodyATRMin: 0.9 } },
  { name: 'Streak+BB+skip14', opts: { useStreak: true, useBB: true, bbMult: 2, useTimeFilter: true, badHours: ETH5M_BAD_HOURS } },
  // Full combos
  { name: 'BB+RSI65+skip14', opts: { useBB: true, bbMult: 2, useRSI: true, rsiThresh: 65, useTimeFilter: true, badHours: ETH5M_BAD_HOURS } },
  { name: 'Streak+BB+RSI55+skip14', opts: { useStreak: true, useBB: true, bbMult: 2, useRSI: true, rsiThresh: 55, useTimeFilter: true, badHours: ETH5M_BAD_HOURS } },
  { name: 'Streak+BB+RSI55+noEuro', opts: { useStreak: true, useBB: true, bbMult: 2, useRSI: true, rsiThresh: 55, useTimeFilter: true, goodHours: ETH5M_GOOD_HOURS } },
  { name: 'Streak+BB+Body+RSI55', opts: { useStreak: true, useBB: true, bbMult: 2, useBodyATR: true, bodyATRMin: 0.9, useRSI: true, rsiThresh: 55 } },
  { name: 'Streak+BB+Body+RSI+noEuro', opts: { useStreak: true, useBB: true, bbMult: 2, useBodyATR: true, bodyATRMin: 0.9, useRSI: true, rsiThresh: 55, useTimeFilter: true, goodHours: ETH5M_GOOD_HOURS } },
  // BigCandle combos
  { name: 'BigCandle+BB(20,2)', opts: { useBigCandle: true, bigCandlePct: 0.5, useBB: true, bbMult: 2 } },
  { name: 'Streak+Big+BB', opts: { useStreak: true, useBigCandle: true, useBB: true, bbMult: 2 } },
  { name: 'Streak+Big+BB+RSI55+noEuro', opts: { useStreak: true, useBigCandle: true, useBB: true, bbMult: 2, useRSI: true, rsiThresh: 55, useTimeFilter: true, goodHours: ETH5M_GOOD_HOURS } },
];

const eth5mResults: Array<{ name: string } & Result> = [];
for (const cfg of configs5m) {
  const r = runStrategy(eth5mTest, (i) => getSignal(eth5mTest, i, cfg.opts));
  eth5mResults.push({ name: cfg.name, ...r });
}

// Sort by WR
eth5mResults.sort((a, b) => b.wr - a.wr);
const baselineWR = eth5mResults.find(r => r.name.includes('baseline') && r.name.includes('Streak'))?.wr ?? 0.555;

console.log('  Config                              WR       T      PnL      vs Streak(3)');
for (const r of eth5mResults) {
  if (r.trades < 30) continue;
  const delta = (r.wr - baselineWR) * 100;
  const imp = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
  const flag = r.wr >= 0.62 ? ' ⭐⭐' : r.wr >= 0.59 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
  console.log(`  ${r.name.padEnd(36)} ${(r.wr*100).toFixed(2).padStart(5)}%  ${r.trades.toString().padStart(5)}  $${r.pnl.toFixed(0).padStart(6)}  ${imp}${flag}`);
}

// ─── ETH/15m comprehensive test ───────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 FINAL STRATEGY — ETH/15m (confirmation)');
console.log('══════════════════════════════════════════════════════════════\n');

const eth15m = queryCandles('ETH', '15m');
const eth15mSplit = Math.floor(eth15m.length * 0.7);
const eth15mTest = eth15m.slice(eth15mSplit);

const ETH15M_GOOD_HOURS = [0,1,2,3,5,7,16,17,22,23]; // top-10 performing hours

const configs15m: Array<{ name: string; opts: Parameters<typeof getSignal>[2] }> = [
  { name: 'Streak(3) — baseline', opts: { useStreak: true } },
  { name: 'BB(20,2) — baseline', opts: { useBB: true, bbMult: 2 } },
  { name: 'BB(20,2.5)', opts: { useBB: true, bbMult: 2.5 } },
  { name: 'Streak+BB(20,2)', opts: { useStreak: true, useBB: true, bbMult: 2 } },
  { name: 'BB(20,2)+RSI65+skip14', opts: { useBB: true, bbMult: 2, useRSI: true, rsiThresh: 65, useTimeFilter: true, badHours: [14] } },
  { name: 'Streak+BB(20,2)+BodyATR', opts: { useStreak: true, useBB: true, bbMult: 2, useBodyATR: true, bodyATRMin: 0.9 } },
  { name: 'Streak+BB+Body+RSI55+topHours', opts: { useStreak: true, useBB: true, bbMult: 2, useBodyATR: true, bodyATRMin: 0.9, useRSI: true, rsiThresh: 55, useTimeFilter: true, goodHours: ETH15M_GOOD_HOURS } },
  { name: 'Streak+BB+Body+topHours', opts: { useStreak: true, useBB: true, bbMult: 2, useBodyATR: true, bodyATRMin: 0.9, useTimeFilter: true, goodHours: ETH15M_GOOD_HOURS } },
  { name: 'BB(20,2.5)+RSI70+topHours', opts: { useBB: true, bbMult: 2.5, useRSI: true, rsiThresh: 70, useTimeFilter: true, goodHours: ETH15M_GOOD_HOURS } },
];

const eth15mResults: Array<{ name: string } & Result> = [];
for (const cfg of configs15m) {
  const r = runStrategy(eth15mTest, (i) => getSignal(eth15mTest, i, cfg.opts));
  eth15mResults.push({ name: cfg.name, ...r });
}
eth15mResults.sort((a, b) => b.wr - a.wr);
const base15m = eth15mResults.find(r => r.name.includes('Streak') && r.name.includes('baseline'))?.wr ?? 0.59;
for (const r of eth15mResults) {
  if (r.trades < 20) continue;
  const delta = (r.wr - base15m) * 100;
  const flag = r.wr >= 0.64 ? ' ⭐⭐' : r.wr >= 0.60 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
  console.log(`  ${r.name.padEnd(40)} WR=${(r.wr*100).toFixed(2)}%  T=${r.trades}  PnL=$${r.pnl.toFixed(0)}  ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%${flag}`);
}

// ─── Multi-coin 15m portfolio ─────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📈 MULTI-COIN 15m PORTFOLIO — Best Strategies');
console.log('══════════════════════════════════════════════════════════════\n');

const COIN_CONFIGS: Array<{
  coin: string;
  opts: Parameters<typeof getSignal>[2];
  goodHours: number[];
}> = [
  { coin: 'ETH', goodHours: [0,1,2,3,5,7,16,17,22,23],
    opts: { useStreak: true, useBB: true, bbMult: 2, useBodyATR: true, bodyATRMin: 0.9 } },
  { coin: 'BTC', goodHours: [0,2,3,10,12,13,17,18,20,22],
    opts: { useBB: true, bbMult: 2, useRSI: true, rsiThresh: 65 } },
  { coin: 'SOL', goodHours: [1,2,3,6,10,12,13,17,18],
    opts: { useStreak: true, useBB: true, bbMult: 2 } },
  { coin: 'XRP', goodHours: Array.from({length:24},(_,i)=>i), // all hours
    opts: { useStreak: true, useBB: true, bbMult: 2 } },
];

let portWins = 0, portTotal = 0, portPnL = 0;
for (const { coin, goodHours, opts } of COIN_CONFIGS) {
  const allC = queryCandles(coin, '15m');
  if (allC.length < 200) continue;
  const testC = allC.slice(Math.floor(allC.length * 0.7));

  // With time filter
  const rFiltered = runStrategy(testC, (i) => getSignal(testC, i, { ...opts, useTimeFilter: true, goodHours }));
  // Without time filter
  const rAll = runStrategy(testC, (i) => getSignal(testC, i, opts));

  portWins += rFiltered.wins;
  portTotal += rFiltered.trades;
  portPnL += rFiltered.pnl;

  console.log(`  ${coin}/15m (top hours):`);
  console.log(`    No filter:  WR=${(rAll.wr*100).toFixed(2)}%  T=${rAll.trades}  PnL=$${rAll.pnl.toFixed(0)}`);
  console.log(`    Top hours:  WR=${(rFiltered.wr*100).toFixed(2)}%  T=${rFiltered.trades}  PnL=$${rFiltered.pnl.toFixed(0)}`);
}

const portWR = portTotal ? portWins / portTotal : 0;
console.log(`\n  Portfolio (4-coin 15m, top hours, best strategy per coin):`);
console.log(`    WR=${(portWR*100).toFixed(2)}%  T=${portTotal}  PnL=$${portPnL.toFixed(0)}`);

// ─── FINAL SUMMARY ────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 ULTIMATE BEST CONFIGS (production-ready)');
console.log('══════════════════════════════════════════════════════════════\n');

// Find best ETH/5m config with decent trade count
const bestEth5m = eth5mResults.filter(r => r.trades >= 100).sort((a, b) => b.wr - a.wr)[0];
const bestEth5mHighVol = eth5mResults.filter(r => r.trades >= 500).sort((a, b) => b.wr - a.wr)[0];
const bestEth15m = eth15mResults.filter(r => r.trades >= 100).sort((a, b) => b.wr - a.wr)[0];

console.log('  ETH/5m (≥100 trades):', bestEth5m?.name);
console.log(`    WR=${(bestEth5m?.wr*100).toFixed(2)}%  T=${bestEth5m?.trades}  PnL=$${bestEth5m?.pnl.toFixed(0)}`);

console.log('  ETH/5m (≥500 trades):', bestEth5mHighVol?.name);
console.log(`    WR=${(bestEth5mHighVol?.wr*100).toFixed(2)}%  T=${bestEth5mHighVol?.trades}  PnL=$${bestEth5mHighVol?.pnl.toFixed(0)}`);

console.log('  ETH/15m (≥100 trades):', bestEth15m?.name);
console.log(`    WR=${(bestEth15m?.wr*100).toFixed(2)}%  T=${bestEth15m?.trades}  PnL=$${bestEth15m?.pnl.toFixed(0)}`);

// Save
const output = {
  timestamp: Date.now(),
  eth5m: eth5mResults.filter(r => r.trades >= 30),
  eth15m: eth15mResults,
  portfolio: { wr: portWR, trades: portTotal, pnl: portPnL },
};
fs.writeFileSync(path.join(RESEARCH_DIR, 'final-strategy.json'), JSON.stringify(output, null, 2));
console.log('\n✅ Saved to docs/backtest-research/final-strategy.json');
