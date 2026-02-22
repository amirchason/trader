/**
 * validateNewStrategies.ts
 *
 * Final validation of top candidates from panicRGGGCombo.ts research.
 * Walk-forward (3-fold + 5-fold) with thorough parameter sweeps.
 */

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

interface RawCandle { open_time: number; open: number; high: number; low: number; close: number; volume: number; }

function calcBB(candles: RawCandle[], end: number, period = 20, mult = 2.0) {
  if (end < period - 1) return null;
  const closes = candles.slice(end - period + 1, end + 1).map(c => c.close);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((sum, c) => sum + (c - mean) ** 2, 0) / period;
  return { upper: mean + mult * Math.sqrt(variance), lower: mean - mult * Math.sqrt(variance), mean };
}

function calcRSI(candles: RawCandle[], end: number, period = 14): number {
  if (end < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const diff = candles[i].close - candles[i-1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function calcVolSMA(candles: RawCandle[], end: number, period = 20) {
  if (end < period - 1) return 0;
  return candles.slice(end - period + 1, end + 1).reduce((s, c) => s + c.volume, 0) / period;
}

function getDir(c: RawCandle) { return c.close >= c.open ? 'G' : 'R'; }

const goodHours = [10, 11, 12, 21];

const ethCandles5m = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all('ETH', '5m') as RawCandle[];
const ethCandles1d = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all('ETH', '1d') as RawCandle[];

// Daily lookup
const dailyByDate = new Map<string, RawCandle>();
for (const c of ethCandles1d) {
  const d = new Date(c.open_time);
  dailyByDate.set(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`, c);
}
function getYesterday(openTime: number): RawCandle | null {
  const d = new Date(openTime - 86400_000);
  return dailyByDate.get(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`) ?? null;
}

interface Cfg {
  name: string;
  bbMult: number;
  minStreak: number;
  minPanicPct: number; // 0 = disabled
  rsiMin: number;      // 0 = disabled
  dailyGreenPct: number; // 0 = disabled
}

function signal(candles: RawCandle[], i: number, cfg: Cfg): boolean {
  const c = candles[i];
  const hour = new Date(c.open_time).getUTCHours();
  if (!goodHours.includes(hour)) return false;

  const bb = calcBB(candles, i, 20, cfg.bbMult);
  if (!bb) return false;

  const isBear = c.close > bb.upper;
  const isBull = c.close < bb.lower;
  if (!isBear && !isBull) return false;

  // Entry candle direction must match setup
  if (isBear && getDir(c) !== 'G') return false;
  if (isBull && getDir(c) !== 'R') return false;

  // Streak filter
  if (cfg.minStreak > 0) {
    const dir = getDir(c);
    let streak = 1;
    for (let j = i-1; j >= Math.max(0, i-6); j--) {
      if (getDir(candles[j]) === dir) streak++;
      else break;
    }
    if (streak < cfg.minStreak) return false;
  }

  // Panic % filter
  if (cfg.minPanicPct > 0) {
    const bodyPct = Math.abs(c.close - c.open) / c.open;
    if (bodyPct < cfg.minPanicPct) return false;
  }

  // RSI filter
  if (cfg.rsiMin > 0) {
    const rsi = calcRSI(candles, i);
    if (isBear && rsi < cfg.rsiMin) return false;
    if (isBull && rsi > (100 - cfg.rsiMin)) return false;
  }

  // Daily regime filter
  if (cfg.dailyGreenPct > 0) {
    const yesterday = getYesterday(c.open_time);
    if (!yesterday) return false;
    const dailyMove = (yesterday.close - yesterday.open) / yesterday.open;
    if (isBear && dailyMove < cfg.dailyGreenPct) return false;
    if (isBull && dailyMove > -cfg.dailyGreenPct) return false;
  }

  return true;
}

function runFull(cfg: Cfg): { wr: number; trades: number } {
  const wins: number[] = [];
  for (let i = 34; i < ethCandles5m.length - 1; i++) {
    if (!signal(ethCandles5m, i, cfg)) continue;
    const c = ethCandles5m[i];
    const next = ethCandles5m[i+1];
    const isBear = c.close > (calcBB(ethCandles5m, i, 20, cfg.bbMult)?.upper ?? Infinity);
    wins.push((isBear ? next.close < next.open : next.close > next.open) ? 1 : 0);
  }
  const trades = wins.length;
  return { wr: trades > 0 ? wins.filter(w => w===1).length / trades : 0, trades };
}

function walkForward(cfg: Cfg, folds = 3): { wr: number; sigma: number; foldWRs: number[]; totalTrades: number } {
  const n = ethCandles5m.length;
  const foldSize = Math.floor(n / folds);
  const foldWRs: number[] = [];
  let totalWins = 0, totalTrades = 0;

  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = (f === folds-1) ? n-1 : (f+1)*foldSize-1;
    const wins: number[] = [];
    for (let i = Math.max(start, 34); i < end; i++) {
      if (!signal(ethCandles5m, i, cfg)) continue;
      const c = ethCandles5m[i];
      const next = ethCandles5m[i+1];
      if (!next) continue;
      const bb = calcBB(ethCandles5m, i, 20, cfg.bbMult);
      if (!bb) continue;
      const isBear = c.close > bb.upper;
      wins.push((isBear ? next.close < next.open : next.close > next.open) ? 1 : 0);
    }
    const foldWR = wins.length > 0 ? wins.filter(w => w===1).length / wins.length : 0;
    foldWRs.push(foldWR);
    totalWins += wins.filter(w => w===1).length;
    totalTrades += wins.length;
  }

  const mean = foldWRs.reduce((a,b) => a+b, 0) / folds;
  const variance = foldWRs.reduce((sum,w) => sum + (w-mean)**2, 0) / folds;
  return { wr: mean, sigma: Math.sqrt(variance), foldWRs, totalTrades };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('══════════════════════════════════════════════════════════════════');
console.log('FINAL VALIDATION — TOP CANDIDATES FROM panicRGGGCombo RESEARCH');
console.log('══════════════════════════════════════════════════════════════════\n');

// ─── 1: RSI + Panic sweep ─────────────────────────────────────────────────────
console.log('SECTION A: RSI > threshold + absolute panic % + GoodH + BB(20, mult)');
console.log('─────────────────────────────────────────────────────────────────────');

const rsiPanicCfgs: Cfg[] = [
  { name: 'RSI>60 + panic≥0.3% + s≥2 + GoodH + BB(20,2.0)', bbMult: 2.0, minStreak: 2, minPanicPct: 0.003, rsiMin: 60, dailyGreenPct: 0 },
  { name: 'RSI>65 + panic≥0.3% + s≥2 + GoodH + BB(20,2.0)', bbMult: 2.0, minStreak: 2, minPanicPct: 0.003, rsiMin: 65, dailyGreenPct: 0 },
  { name: 'RSI>70 + panic≥0.3% + s≥2 + GoodH + BB(20,2.0)', bbMult: 2.0, minStreak: 2, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>65 + panic≥0.3% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 65, dailyGreenPct: 0 },
  { name: 'RSI>70 + panic≥0.3% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>70 + panic≥0.4% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.004, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>70 + panic≥0.3% + s≥0 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 0, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>65 + panic≥0.2% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.002, rsiMin: 65, dailyGreenPct: 0 },
];

for (const cfg of rsiPanicCfgs) {
  const r = runFull(cfg);
  const flag = r.wr >= 0.72 && r.trades >= 50 ? ' ⭐⭐⭐' : r.wr >= 0.70 && r.trades >= 40 ? ' ⭐⭐' : r.wr >= 0.67 && r.trades >= 25 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(55)} WR=${(r.wr*100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}${flag}`);
}

// ─── 2: Daily regime + streak + panic ─────────────────────────────────────────
console.log('\nSECTION B: Daily regime filter + streak + panic (Polymarket serial-correlation)');
console.log('─────────────────────────────────────────────────────────────────────');

const dailyCfgs: Cfg[] = [
  { name: 's≥2 + panic≥0.3% + GoodH + BB(20,2.2) + daily>0.3%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 0, dailyGreenPct: 0.003 },
  { name: 's≥2 + panic≥0.3% + GoodH + BB(20,2.2) + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 0, dailyGreenPct: 0.005 },
  { name: 's≥2 + panic≥0.3% + GoodH + BB(20,2.2) + daily>1.0%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 0, dailyGreenPct: 0.010 },
  { name: 's≥2 + panic≥0.3% + GoodH + BB(20,2.2) + daily>2.0%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 0, dailyGreenPct: 0.020 },
  { name: 's≥2 + panic≥0.4% + GoodH + BB(20,2.2) + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.004, rsiMin: 0, dailyGreenPct: 0.005 },
  { name: 's≥2 + panic≥0.2% + GoodH + BB(20,2.2) + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.002, rsiMin: 0, dailyGreenPct: 0.005 },
  // RSI + daily
  { name: 'RSI>65 + panic≥0.3% + s≥2 + GoodH + BB + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 65, dailyGreenPct: 0.005 },
  { name: 'RSI>70 + panic≥0.3% + s≥2 + GoodH + BB + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0.005 },
];

for (const cfg of dailyCfgs) {
  const r = runFull(cfg);
  const flag = r.wr >= 0.74 && r.trades >= 40 ? ' ⭐⭐⭐' : r.wr >= 0.72 && r.trades >= 30 ? ' ⭐⭐' : r.wr >= 0.68 && r.trades >= 20 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(55)} WR=${(r.wr*100).toFixed(1).padStart(5)}%  T=${String(r.trades).padStart(3)}${flag}`);
}

// ─── 3: 3-fold Walk-Forward of top picks ──────────────────────────────────────
console.log('\nSECTION C: 3-fold Walk-Forward Validation of top candidates');
console.log('─────────────────────────────────────────────────────────────');

const wfCandidates: Cfg[] = [
  { name: 'RSI>70 + panic≥0.3% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>70 + panic≥0.3% + s≥0 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 0, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>65 + panic≥0.3% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 65, dailyGreenPct: 0 },
  { name: 's≥2 + panic≥0.3% + GoodH + BB(20,2.2) + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 0, dailyGreenPct: 0.005 },
  { name: 's≥2 + panic≥0.3% + GoodH + BB(20,2.2) + daily>1.0%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 0, dailyGreenPct: 0.010 },
  { name: 'RSI>65 + panic≥0.3% + s≥2 + GoodH + BB + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 65, dailyGreenPct: 0.005 },
  { name: 'RSI>70 + panic≥0.3% + s≥2 + GoodH + BB + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0.005 },
];

for (const cfg of wfCandidates) {
  const wf = walkForward(cfg, 3);
  const foldStr = wf.foldWRs.map(w => (w*100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.72 && wf.sigma <= 0.05 && wf.totalTrades >= 40 ? ' ⭐⭐⭐'
             : wf.wr >= 0.70 && wf.sigma <= 0.07 && wf.totalTrades >= 25 ? ' ⭐⭐'
             : wf.wr >= 0.67 && wf.totalTrades >= 15 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(52)} WR=${(wf.wr*100).toFixed(1).padStart(5)}% σ=${(wf.sigma*100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

// ─── 4: 5-fold Walk-Forward of absolute best ──────────────────────────────────
console.log('\nSECTION D: 5-fold Walk-Forward of top performers');
console.log('─────────────────────────────────────────────────────────────');

const best5F: Cfg[] = [
  { name: 'RSI>70 + panic≥0.3% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>70 + panic≥0.3% + s≥0 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 0, minPanicPct: 0.003, rsiMin: 70, dailyGreenPct: 0 },
  { name: 'RSI>65 + panic≥0.3% + s≥2 + GoodH + BB(20,2.2)', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 65, dailyGreenPct: 0 },
  { name: 's≥2 + panic≥0.3% + GoodH + BB(20,2.2) + daily>0.5%', bbMult: 2.2, minStreak: 2, minPanicPct: 0.003, rsiMin: 0, dailyGreenPct: 0.005 },
];

for (const cfg of best5F) {
  const wf = walkForward(cfg, 5);
  const foldStr = wf.foldWRs.map(w => (w*100).toFixed(1)).join('/');
  const flag = wf.wr >= 0.72 && wf.sigma <= 0.05 ? ' ⭐⭐⭐'
             : wf.wr >= 0.70 && wf.sigma <= 0.07 ? ' ⭐⭐'
             : wf.wr >= 0.67 ? ' ⭐' : '';
  console.log(`  ${cfg.name.padEnd(52)} WR=${(wf.wr*100).toFixed(1).padStart(5)}% σ=${(wf.sigma*100).toFixed(1).padStart(4)}% T=${String(wf.totalTrades).padStart(3)} [${foldStr}]${flag}`);
}

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('✅ FINAL VALIDATION COMPLETE');
console.log('══════════════════════════════════════════════════════════════════');
