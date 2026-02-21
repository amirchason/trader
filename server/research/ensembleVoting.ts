/**
 * ensembleVoting.ts
 *
 * Research: Multi-signal ensemble using ONLY validated profitable signals
 *
 * Previous multi-TF voting = 49% (WORSE than random) — but that used ALL signals.
 * This tests ensembles of ONLY the validated signals:
 *   A: GoodH + BB(20,2.2) + streak≥2       (69.8% σ=1.1%)
 *   B: GGG/RRR + BB (Markov-style)          (~67% WR)
 *   C: RGGG/GRGG at BB                      (~65% WR ETH/5m)
 *   D: MFI(10)>80 + BB                      (BTC/15m 70.4%)
 *   E: RGGG/GRGG + GoodH + BB(15,2.2)/15m   (~81% WR)
 *
 * Ensemble approaches:
 * 1. Require 2+ signals agree (AND of A+C, A+B, B+C etc.)
 * 2. Require all 3 of A+B+C agree
 * 3. Score voting: fire if 2+ of 3 validated signals triggered
 * 4. Check if single strongest signal beats ensemble
 * 5. Test ensemble on multiple symbols/timeframes
 */

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

interface RawCandle {
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function calcBB(candles: RawCandle[], end: number, period = 20, mult = 2.0) {
  if (end < period - 1) return null;
  const slice = candles.slice(end - period + 1, end + 1);
  const closes = slice.map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, lower: mean - mult * std, middle: mean, std };
}

function calcATR(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 0;
  let atrSum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
    atrSum += tr;
  }
  return atrSum / period;
}

function calcMFI(candles: RawCandle[], end: number, period = 10): number {
  if (end < period) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = i > 0 ? (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3 : tp;
    const mf = tp * candles[i].volume;
    if (tp > prevTp) posFlow += mf;
    else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  const ratio = posFlow / negFlow;
  return 100 - 100 / (1 + ratio);
}

function calcRSI(candles: RawCandle[], end: number, period = 14): number {
  if (end < period) return 50;
  let gains = 0, losses = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

type Dir = 'G' | 'R';
function getDir(c: RawCandle): Dir { return c.close >= c.open ? 'G' : 'R'; }

function getStreak(candles: RawCandle[], i: number): { dir: Dir; len: number } {
  const dir = getDir(candles[i]);
  let len = 1;
  for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
    if (getDir(candles[j]) === dir) len++;
    else break;
  }
  return { dir, len };
}

// ─── Signal detectors ────────────────────────────────────────────────────
const GOOD_HOURS = [10, 11, 12, 21];
const EXT_HOURS = [10, 11, 12, 21, 22, 23];

interface Signals {
  hour: number;
  direction: 'bear' | 'bull' | null; // agreed direction from signal
  sigA: boolean; // GoodH + BB(20,2.2) + streak≥2
  sigB: boolean; // GGG/RRR streak≥3 at BB (Markov-style)
  sigC: boolean; // RGGG/GRGG at BB(20,2.2) + GoodH
  sigD: boolean; // MFI(10)>80 + BB + streak
  sigE: boolean; // Low ATR regime + BB + streak≥2
}

function getSignals(candles: RawCandle[], i: number): Signals | null {
  if (i < 25) return null;
  const c = candles[i];
  const hour = new Date(c.open_time).getUTCHours();
  const bb22 = calcBB(candles, i, 20, 2.2);
  const bb20 = calcBB(candles, i, 20, 2.0);
  if (!bb22 || !bb20) return null;

  const price = c.close;
  const isBearBB22 = price > bb22.upper;
  const isBullBB22 = price < bb22.lower;
  const isBearBB20 = price > bb20.upper;
  const isBullBB20 = price < bb20.lower;

  const streak = getStreak(candles, i);
  const mfi = calcMFI(candles, i, 10);
  const atr = calcATR(candles, i, 14);

  // ATR percentile (look back 50 candles)
  const atrHistory: number[] = [];
  for (let j = Math.max(0, i - 50); j <= i; j++) {
    atrHistory.push(calcATR(candles, j, 14));
  }
  atrHistory.sort((a, b) => a - b);
  const atrPct = atrHistory.indexOf(atr) / atrHistory.length;

  // Seq for sigC
  const seq = i >= 3 ? [getDir(candles[i-3]), getDir(candles[i-2]), getDir(candles[i-1]), getDir(c)].join('') : '';

  // Signal A: GoodH + BB(20,2.2) + streak≥2
  const sigA_bear = GOOD_HOURS.includes(hour) && isBearBB22 && streak.dir === 'G' && streak.len >= 2;
  const sigA_bull = GOOD_HOURS.includes(hour) && isBullBB22 && streak.dir === 'R' && streak.len >= 2;

  // Signal B: streak≥3 at BB (Markov = GGG bear / RRR bull)
  const sigB_bear = streak.dir === 'G' && streak.len >= 3 && isBearBB20;
  const sigB_bull = streak.dir === 'R' && streak.len >= 3 && isBullBB20;

  // Signal C: RGGG or GRGG at BB(20,2.2) + GoodH
  const sigC_bear = GOOD_HOURS.includes(hour) && isBearBB22 && (seq === 'RGGG' || seq === 'GRGG');
  const sigC_bull = GOOD_HOURS.includes(hour) && isBullBB22 && (seq === 'RRRG' || seq === 'GRRR');

  // Signal D: MFI > 80 + BB + streak≥2
  const sigD_bear = mfi > 80 && isBearBB20 && streak.dir === 'G' && streak.len >= 2;
  const sigD_bull = mfi < 20 && isBullBB20 && streak.dir === 'R' && streak.len >= 2;

  // Signal E: Low ATR regime + BB(20,2.2) + streak≥2
  const sigE_bear = atrPct < 0.4 && isBearBB22 && streak.dir === 'G' && streak.len >= 2;
  const sigE_bull = atrPct < 0.4 && isBullBB22 && streak.dir === 'R' && streak.len >= 2;

  // Determine agreed direction
  let direction: 'bear' | 'bull' | null = null;
  const bearCount = [sigA_bear, sigB_bear, sigC_bear, sigD_bear, sigE_bear].filter(Boolean).length;
  const bullCount = [sigA_bull, sigB_bull, sigC_bull, sigD_bull, sigE_bull].filter(Boolean).length;
  if (bearCount > 0 && bullCount === 0) direction = 'bear';
  if (bullCount > 0 && bearCount === 0) direction = 'bull';

  return {
    hour,
    direction,
    sigA: sigA_bear || sigA_bull,
    sigB: sigB_bear || sigB_bull,
    sigC: sigC_bear || sigC_bull,
    sigD: sigD_bear || sigD_bull,
    sigE: sigE_bear || sigE_bull,
  };
}

function testEnsemble(
  candles: RawCandle[],
  condition: (sigs: Signals) => { fire: boolean; dir: 'bear' | 'bull' }
): { wr: number; trades: number } {
  const wins: number[] = [];
  for (let i = 25; i < candles.length - 1; i++) {
    const sigs = getSignals(candles, i);
    if (!sigs) continue;
    const { fire, dir } = condition(sigs);
    if (!fire) continue;

    const nextCandle = candles[i + 1];
    const correct = dir === 'bear'
      ? nextCandle.close < nextCandle.open
      : nextCandle.close > nextCandle.open;
    wins.push(correct ? 1 : 0);
  }
  const trades = wins.length;
  const wr = trades > 0 ? wins.filter(w => w === 1).length / trades : 0;
  return { wr, trades };
}

function testEnsembleWF(
  candles: RawCandle[],
  condition: (sigs: Signals) => { fire: boolean; dir: 'bear' | 'bull' },
  folds = 3
): { wr: number; sigma: number; foldWRs: number[]; totalTrades: number } {
  const foldSize = Math.floor(candles.length / folds);
  const foldWRs: number[] = [];
  let totalWins = 0, totalTrades = 0;

  for (let f = 0; f < folds; f++) {
    const start = Math.max(25, f * foldSize);
    const end = (f === folds - 1) ? candles.length - 1 : (f + 1) * foldSize - 1;
    const foldCandles = candles.slice(0, end + 1);
    const wins: number[] = [];

    for (let i = start; i < end; i++) {
      const sigs = getSignals(foldCandles, i);
      if (!sigs) continue;
      const { fire, dir } = condition(sigs);
      if (!fire) continue;
      const nextCandle = foldCandles[i + 1];
      if (!nextCandle) continue;
      const correct = dir === 'bear'
        ? nextCandle.close < nextCandle.open
        : nextCandle.close > nextCandle.open;
      wins.push(correct ? 1 : 0);
    }
    const foldWR = wins.length > 0 ? wins.filter(w => w === 1).length / wins.length : 0;
    foldWRs.push(foldWR);
    totalWins += wins.filter(w => w === 1).length;
    totalTrades += wins.length;
  }

  const mean = foldWRs.reduce((a, b) => a + b, 0) / folds;
  const variance = foldWRs.reduce((sum, wr) => sum + Math.pow(wr - mean, 2), 0) / folds;
  return { wr: mean, sigma: Math.sqrt(variance), foldWRs, totalTrades };
}

console.log('══════════════════════════════════════════════════════════════');
console.log('ENSEMBLE VOTING RESEARCH — Validated Signals Only');
console.log('══════════════════════════════════════════════════════════════\n');

const symbols = ['ETH', 'BTC', 'SOL'];
const timeframes = ['5m', '15m'];

for (const symbol of symbols) {
  for (const tf of timeframes) {
    const candles = db.prepare(
      'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
    ).all(symbol, tf) as RawCandle[];

    if (candles.length < 200) {
      console.log(`  ${symbol}/${tf}: insufficient data`);
      continue;
    }

    console.log(`\n─── ${symbol}/${tf} (${candles.length} candles) ───────────────────────────`);

    // Individual signals first
    const indivTests = [
      { name: 'SigA alone (GoodH+BB22+streak≥2)', fn: (s: Signals) => ({ fire: s.sigA && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'SigB alone (streak≥3+BB20)', fn: (s: Signals) => ({ fire: s.sigB && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'SigC alone (RGGG/GRGG+GoodH+BB22)', fn: (s: Signals) => ({ fire: s.sigC && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'SigD alone (MFI>80+BB+streak)', fn: (s: Signals) => ({ fire: s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'SigE alone (LowATR+BB22+streak)', fn: (s: Signals) => ({ fire: s.sigE && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
    ];

    for (const t of indivTests) {
      const r = testEnsemble(candles, t.fn);
      const flag = r.wr >= 0.70 && r.trades >= 30 ? ' ⭐⭐⭐' : r.wr >= 0.65 && r.trades >= 20 ? ' ⭐⭐' : r.wr >= 0.60 && r.trades >= 15 ? ' ⭐' : '';
      console.log(`  ${t.name.padEnd(45)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}${flag}`);
    }

    // Pairwise ensembles
    const ensembleTests = [
      { name: 'A+B agree (2-signal)', fn: (s: Signals) => ({ fire: s.sigA && s.sigB && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'A+C agree (2-signal)', fn: (s: Signals) => ({ fire: s.sigA && s.sigC && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'A+D agree (2-signal)', fn: (s: Signals) => ({ fire: s.sigA && s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'B+C agree (2-signal)', fn: (s: Signals) => ({ fire: s.sigB && s.sigC && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'B+D agree (2-signal)', fn: (s: Signals) => ({ fire: s.sigB && s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'C+D agree (2-signal)', fn: (s: Signals) => ({ fire: s.sigC && s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: 'A+E agree (2-signal)', fn: (s: Signals) => ({ fire: s.sigA && s.sigE && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
      { name: '2-of-3 (A|B|C) voting', fn: (s: Signals) => {
        const cnt = [s.sigA, s.sigB, s.sigC].filter(Boolean).length;
        return { fire: cnt >= 2 && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' };
      }},
      { name: '2-of-5 (any two) voting', fn: (s: Signals) => {
        const cnt = [s.sigA, s.sigB, s.sigC, s.sigD, s.sigE].filter(Boolean).length;
        return { fire: cnt >= 2 && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' };
      }},
      { name: '3+ of 5 voting', fn: (s: Signals) => {
        const cnt = [s.sigA, s.sigB, s.sigC, s.sigD, s.sigE].filter(Boolean).length;
        return { fire: cnt >= 3 && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' };
      }},
      { name: 'A+B+C all agree (3-signal)', fn: (s: Signals) => ({ fire: s.sigA && s.sigB && s.sigC && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
    ];

    for (const t of ensembleTests) {
      const r = testEnsemble(candles, t.fn);
      const flag = r.wr >= 0.72 && r.trades >= 20 ? ' ⭐⭐⭐' : r.wr >= 0.68 && r.trades >= 15 ? ' ⭐⭐' : r.wr >= 0.64 && r.trades >= 10 ? ' ⭐' : '';
      console.log(`  ${t.name.padEnd(45)} WR=${(r.wr * 100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}${flag}`);
    }
  }
}

// ─── Walk-forward on best ensembles ─────────────────────────────────────
console.log('\n\n══════════════════════════════════════════════════════════════');
console.log('WALK-FORWARD VALIDATION (3-fold) — top ensemble candidates');
console.log('══════════════════════════════════════════════════════════════');

const wfEnsembles = [
  { symbol: 'ETH', tf: '5m',  name: 'SigA alone (ETH/5m)',    fn: (s: Signals) => ({ fire: s.sigA && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'ETH', tf: '5m',  name: 'A+B (ETH/5m)',           fn: (s: Signals) => ({ fire: s.sigA && s.sigB && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'ETH', tf: '5m',  name: 'A+C (ETH/5m)',           fn: (s: Signals) => ({ fire: s.sigA && s.sigC && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'ETH', tf: '5m',  name: 'A+D (ETH/5m)',           fn: (s: Signals) => ({ fire: s.sigA && s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'ETH', tf: '5m',  name: '2-of-3 (A|B|C) ETH/5m', fn: (s: Signals) => { const cnt = [s.sigA,s.sigB,s.sigC].filter(Boolean).length; return { fire: cnt >= 2 && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }; } },
  { symbol: 'ETH', tf: '15m', name: 'SigA alone (ETH/15m)',   fn: (s: Signals) => ({ fire: s.sigA && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'ETH', tf: '15m', name: 'A+B (ETH/15m)',          fn: (s: Signals) => ({ fire: s.sigA && s.sigB && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'BTC', tf: '15m', name: 'SigD alone (BTC/15m)',   fn: (s: Signals) => ({ fire: s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'BTC', tf: '15m', name: 'A+D (BTC/15m)',          fn: (s: Signals) => ({ fire: s.sigA && s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
  { symbol: 'BTC', tf: '15m', name: 'B+D (BTC/15m)',          fn: (s: Signals) => ({ fire: s.sigB && s.sigD && !!s.direction, dir: (s.direction || 'bear') as 'bear' | 'bull' }) },
];

for (const t of wfEnsembles) {
  const candles = db.prepare(
    'SELECT open_time, open, high, low, close, volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
  ).all(t.symbol, t.tf) as RawCandle[];
  if (candles.length < 200) continue;

  const wf = testEnsembleWF(candles, t.fn, 3);
  const foldStr = wf.foldWRs.map(w => (w * 100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.70 && wf.sigma <= 0.06 && wf.totalTrades >= 30 ? ' ⭐⭐⭐'
             : wf.wr >= 0.67 && wf.sigma <= 0.08 && wf.totalTrades >= 20 ? ' ⭐⭐'
             : wf.wr >= 0.64 && wf.totalTrades >= 15 ? ' ⭐' : '';
  console.log(`  ${t.name.padEnd(32)} WR=${(wf.wr * 100).toFixed(1).padStart(5)}% σ=${(wf.sigma * 100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('✅ ENSEMBLE VOTING RESEARCH COMPLETE');
console.log('══════════════════════════════════════════════════════════════');
