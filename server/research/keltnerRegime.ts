/**
 * Keltner Channel + Volatility/Volume Regime Optimization
 *
 * Key discoveries from walkForwardNew.ts:
 * - Keltner+Streak(3) bear ETH/15m = 68.0% WR (beats BB)
 * - ETH/5m: LOW ATR = 65.1% WR vs HIGH ATR = 53.5%
 * - ETH/5m: LOW volume = 66.7% WR vs HIGH volume = 57.1%
 *
 * Now: combine Keltner with ATR/volume regime filters
 *
 * Run: npx ts-node -P tsconfig.server.json server/research/keltnerRegime.ts
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

function calcATR(candles: DbCandle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
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

function calcBB(candles: DbCandle[], i: number, period = 20, mult = 2): { upper: number; lower: number; mid: number; std: number } | null {
  if (i < period) return null;
  const closes = candles.slice(i - period + 1, i + 1).map(c => c.close);
  const mid = closes.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mid) ** 2, 0) / period);
  return { upper: mid + mult * std, lower: mid - mult * std, mid, std };
}

function calcKeltner(candles: DbCandle[], i: number, period = 20, atrMult = 2): { upper: number; lower: number; mid: number; atr: number } | null {
  if (i < period + 14) return null;
  const slice = candles.slice(i - period + 1, i + 1);
  const multiplier = 2 / (period + 1);
  let ema = slice[0].close;
  for (let j = 1; j < slice.length; j++) ema = (slice[j].close - ema) * multiplier + ema;
  const atr = calcATR(candles.slice(Math.max(0, i - 28), i + 1));
  return { upper: ema + atrMult * atr, lower: ema - atrMult * atr, mid: ema, atr };
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

function calcVolAvg(candles: DbCandle[], i: number, period = 20): number {
  if (i < period) return candles[i].volume;
  return candles.slice(i - period, i).reduce((s, c) => s + c.volume, 0) / period;
}

// Long-period ATR for volatility regime detection (50-period)
function calcLongATR(candles: DbCandle[], i: number, period = 50): number {
  return calcATR(candles.slice(Math.max(0, i - period - 1), i + 1), Math.min(period, i));
}

// ─── Strategy building blocks ─────────────────────────────────────────────────
function getKeltnerSignal(candles: DbCandle[], i: number, streakLen = 3, atrMult = 2): 'BULL' | 'BEAR' | null {
  const k = calcKeltner(candles, i, 20, atrMult);
  if (!k) return null;
  const streak = getStreak(candles, i);
  const c = candles[i];
  if (streak >= streakLen && c.close > k.upper) return 'BEAR';
  if (streak <= -streakLen && c.close < k.lower) return 'BULL';
  return null;
}

function getMarkovBBSignal(candles: DbCandle[], i: number, streakLen = 3, bbMult = 2): 'BULL' | 'BEAR' | null {
  const bb = calcBB(candles, i, 20, bbMult);
  if (!bb) return null;
  const streak = getStreak(candles, i);
  const c = candles[i];
  if (streak >= streakLen && c.close > bb.upper) return 'BEAR';
  if (streak <= -streakLen && c.close < bb.lower) return 'BULL';
  return null;
}

type FilterFn = (candles: DbCandle[], i: number, dir: 'BULL' | 'BEAR') => boolean;
const PASS: FilterFn = () => true;

function testConfig(
  candles: DbCandle[],
  splitIdx: number,
  signal: (c: DbCandle[], i: number) => 'BULL' | 'BEAR' | null,
  ...filters: FilterFn[]
): { wins: number; total: number; wr: number; pnl: number } {
  let wins = 0, total = 0;
  for (let i = splitIdx + 35; i < candles.length - 1; i++) {
    const dir = signal(candles, i);
    if (!dir) continue;
    if (!filters.every(f => f(candles, i, dir))) continue;
    const nextGreen = isGreen(candles[i + 1]);
    const win = dir === 'BULL' ? nextGreen : !nextGreen;
    wins += win ? 1 : 0; total++;
  }
  const wr = total ? wins / total : 0;
  return { wins, total, wr, pnl: wins * BET - (total - wins) * BET };
}

// ─── Filters ──────────────────────────────────────────────────────────────────
const skipHour14: FilterFn = (c, i) => new Date(c[i].open_time).getUTCHours() !== 14;

const bodyATRFilter = (minRatio: number): FilterFn => (candles, i) => {
  const atr = calcATR(candles.slice(Math.max(0, i - 15), i + 1));
  const body = Math.abs(candles[i].close - candles[i].open);
  return atr <= 0 || body / atr >= minRatio;
};

const rsiFilter = (bullMax: number, bearMin: number): FilterFn => (candles, i, dir) => {
  const closes = candles.slice(Math.max(0, i - 16), i + 1).map(c => c.close);
  const rsi = calcRSI(closes, 14);
  return dir === 'BULL' ? rsi <= bullMax : rsi >= bearMin;
};

// ATR regime: low ATR = current ATR below Nth percentile of recent ATRs
// NOTE: for 15m → prefer HIGH ATR; for 5m → prefer LOW ATR
const atrRegimeFilter = (mode: 'low' | 'high', threshold = 0.75): FilterFn => (candles, i) => {
  // Compute ATR percentile over last 200 candles
  const lookback = Math.min(200, i);
  const recentATRs: number[] = [];
  for (let j = i - lookback + 14; j <= i; j += 5) {
    recentATRs.push(calcATR(candles.slice(Math.max(0, j - 15), j + 1)));
  }
  if (recentATRs.length < 5) return true;
  recentATRs.sort((a, b) => a - b);
  const pctThr = recentATRs[Math.floor(recentATRs.length * threshold)];
  const currentATR = calcATR(candles.slice(Math.max(0, i - 15), i + 1));
  return mode === 'low' ? currentATR < pctThr : currentATR > pctThr;
};

// Volume regime: low volume = current volume below average
const volRegimeFilter = (mode: 'low' | 'high', multiplier = 1.0): FilterFn => (candles, i) => {
  const avg = calcVolAvg(candles, i);
  const ratio = avg > 0 ? candles[i].volume / avg : 1;
  return mode === 'low' ? ratio < multiplier : ratio >= multiplier;
};

// ── MAIN ──────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🌊 KELTNER + REGIME FILTERS OPTIMIZATION');
console.log('══════════════════════════════════════════════════════════════');
console.log('Keltner beats BB? + ATR/Volume regime filtering\n');

const targets = [
  { coin: 'ETH', tf: '15m' },
  { coin: 'BTC', tf: '15m' },
  { coin: 'SOL', tf: '15m' },
  { coin: 'ETH', tf: '5m' },
];

type ResultRow = { name: string; coin: string; tf: string; wr: number; total: number; pnl: number };
const allResults: ResultRow[] = [];

for (const { coin, tf } of targets) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);
  console.log(`\n── ${coin}/${tf} ──────────────────────────────────────────────────`);
  console.log('Strategy                                   WR       T      PnL');

  const configs: Array<{ name: string; signal: (c: DbCandle[], i: number) => 'BULL'|'BEAR'|null; filters: FilterFn[] }> = [
    // Baselines
    { name: 'Keltner+Streak(3) [baseline]', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [] },
    { name: 'Markov+BB(2) [baseline]', signal: (c,i) => getMarkovBBSignal(c,i,3,2), filters: [] },

    // Keltner with standard filters
    { name: 'Keltner+skip14', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [skipHour14] },
    { name: 'Keltner+bodyATR(0.8)', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [bodyATRFilter(0.8)] },
    { name: 'Keltner+bodyATR(0.9)', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [bodyATRFilter(0.9)] },
    { name: 'Keltner+RSI65', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [rsiFilter(35,65)] },

    // Keltner with ATR regime (15m: prefer high ATR)
    { name: 'Keltner+highATR(75th)', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [atrRegimeFilter('high', 0.75)] },
    { name: 'Keltner+lowATR(25th)', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [atrRegimeFilter('low', 0.25)] },

    // Keltner with volume regime (ETH/5m: prefer low volume)
    { name: 'Keltner+lowVol(<0.8x)', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [volRegimeFilter('low', 0.8)] },
    { name: 'Keltner+highVol(>1.5x)', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [volRegimeFilter('high', 1.5)] },

    // Combined best filters
    { name: 'Keltner+ALL(ATR+RSI+skip14)', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [bodyATRFilter(0.8), rsiFilter(35,65), skipHour14] },
    { name: 'Keltner+ALL+lowVol', signal: (c,i) => getKeltnerSignal(c,i,3,2), filters: [bodyATRFilter(0.8), rsiFilter(35,65), skipHour14, volRegimeFilter('low', 1.0)] },

    // Keltner ATR multipliers
    { name: 'Keltner(1.5x)', signal: (c,i) => getKeltnerSignal(c,i,3,1.5), filters: [] },
    { name: 'Keltner(2.5x)', signal: (c,i) => getKeltnerSignal(c,i,3,2.5), filters: [] },
    { name: 'Keltner(4)+Streak(4)', signal: (c,i) => getKeltnerSignal(c,i,4,2), filters: [] },

    // Keltner bear only (GGG direction — we know bear > bull)
    { name: 'Keltner+ALL (BEAR only)', signal: (c,i) => {
        const s = getKeltnerSignal(c,i,3,2);
        return s === 'BEAR' ? s : null;
      }, filters: [bodyATRFilter(0.8), rsiFilter(35,65), skipHour14] },

    // Keltner + GGG pattern only (most specific)
    { name: 'Keltner+GGG(bear)+bodyATR', signal: (c,i) => {
        const k = calcKeltner(c,i,20,2);
        if (!k || c[i].close <= k.upper) return null;
        const streak = getStreak(c, i);
        return streak >= 3 ? 'BEAR' : null;
      }, filters: [bodyATRFilter(0.9)] },

    // Keltner+BB agree (price outside BOTH Keltner and BB)
    { name: 'Keltner AND BB agree', signal: (c,i) => {
        const k = getKeltnerSignal(c,i,3,2);
        const bb = getMarkovBBSignal(c,i,3,2);
        return k && bb && k === bb ? k : null;
      }, filters: [] },

    { name: 'Keltner AND BB agree+filters', signal: (c,i) => {
        const k = getKeltnerSignal(c,i,3,2);
        const bb = getMarkovBBSignal(c,i,3,2);
        return k && bb && k === bb ? k : null;
      }, filters: [bodyATRFilter(0.8), skipHour14] },
  ];

  for (const { name, signal, filters } of configs) {
    const r = testConfig(allC, splitIdx, signal, ...filters);
    if (r.total < 20) continue;
    const flag = r.wr >= 0.68 ? ' ⭐⭐' : r.wr >= 0.63 ? ' ⭐' : r.wr < 0.50 ? ' ❌' : '';
    console.log(`  ${name.padEnd(40)} ${(r.wr*100).toFixed(1).padStart(5)}% ${r.total.toString().padStart(4)}  $${r.pnl.toString().padStart(5)}${flag}`);
    allResults.push({ name, coin, tf, ...r });
  }
}

// ── Top results across all coins ──────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🏆 TOP 20 KELTNER RESULTS (≥40 trades, sorted by WR)');
console.log('══════════════════════════════════════════════════════════════');
const top = allResults.filter(r => r.total >= 40).sort((a, b) => b.wr - a.wr).slice(0, 20);
for (const r of top) {
  const flag = r.wr >= 0.68 ? ' ⭐⭐' : r.wr >= 0.63 ? ' ⭐' : '';
  console.log(`  ${r.name.padEnd(40)} ${r.coin}/${r.tf.padEnd(3)} ${(r.wr*100).toFixed(1).padStart(5)}%  T=${r.total.toString().padStart(4)}  $${r.pnl.toString().padStart(5)}${flag}`);
}

// ── Walk-forward for Keltner ──────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('🔄 KELTNER WALK-FORWARD STABILITY CHECK (5 folds)');
console.log('══════════════════════════════════════════════════════════════');
for (const { coin, tf } of [{ coin: 'ETH', tf: '15m' }, { coin: 'ETH', tf: '5m' }]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const foldSize = Math.floor(allC.length / 5);
  const wrs: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const start = fold * foldSize;
    const end = Math.min((fold + 1) * foldSize, allC.length);
    let wins = 0, total = 0;
    for (let i = start + 35; i < end - 1; i++) {
      const sig = getKeltnerSignal(allC, i, 3, 2);
      if (!sig) continue;
      const nextGreen = isGreen(allC[i + 1]);
      const win = sig === 'BULL' ? nextGreen : !nextGreen;
      wins += win ? 1 : 0; total++;
    }
    wrs.push(total ? wins / total : 0);
  }
  const mean = wrs.reduce((a, b) => a + b) / wrs.length;
  const std = Math.sqrt(wrs.reduce((s, w) => s + (w - mean) ** 2, 0) / wrs.length);
  const stable = wrs.every(w => w > 0.50) && std < 0.06 ? '✅' : '⚠️';
  console.log(`  Keltner ${coin}/${tf}: ${wrs.map(w => `${(w*100).toFixed(1)}%`).join(' | ')} σ=${(std*100).toFixed(1)}% ${stable}`);
}

// ── ATR/Volume regime deeper analysis ────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════');
console.log('📊 ATR + VOLUME REGIME: BEST COMBINATION');
console.log('══════════════════════════════════════════════════════════════');
console.log('ETH/5m: Low ATR=65.1%WR | ETH/15m: High ATR=65.6%WR\n');

for (const { coin, tf, mode } of [
  { coin: 'ETH', tf: '5m', mode: 'low' as const },
  { coin: 'ETH', tf: '15m', mode: 'high' as const },
  { coin: 'BTC', tf: '15m', mode: 'high' as const },
]) {
  const allC = queryCandles(coin, tf);
  if (allC.length < 500) continue;
  const splitIdx = Math.floor(allC.length * 0.7);

  // Test ATR percentile thresholds
  console.log(`  ${coin}/${tf} (prefer ${mode} ATR):`);
  for (const pct of [0.25, 0.33, 0.50, 0.67, 0.75]) {
    const r = testConfig(allC, splitIdx, (c,i) => getKeltnerSignal(c,i,3,2), atrRegimeFilter(mode, mode === 'low' ? pct : 1-pct));
    if (r.total < 30) continue;
    const flag = r.wr >= 0.65 ? ' ⭐⭐' : r.wr >= 0.60 ? ' ⭐' : '';
    console.log(`    ATR ${mode}(${Math.round(pct*100)}th%): WR=${(r.wr*100).toFixed(1)}% T=${r.total} PnL=$${r.pnl}${flag}`);
  }

  // Test volume thresholds
  for (const volMult of [0.5, 0.8, 1.0]) {
    const r = testConfig(allC, splitIdx, (c,i) => getKeltnerSignal(c,i,3,2), volRegimeFilter(mode === 'low' ? 'low' : 'high', volMult));
    if (r.total < 30) continue;
    const flag = r.wr >= 0.65 ? ' ⭐⭐' : r.wr >= 0.60 ? ' ⭐' : '';
    console.log(`    Vol ${mode}(<${volMult}x):  WR=${(r.wr*100).toFixed(1)}% T=${r.total} PnL=$${r.pnl}${flag}`);
  }
}

// Save
fs.writeFileSync(
  path.join(RESEARCH_DIR, 'keltner-regime.json'),
  JSON.stringify({ timestamp: Date.now(), results: allResults }, null, 2)
);
console.log('\n✅ Saved to docs/backtest-research/keltner-regime.json');
