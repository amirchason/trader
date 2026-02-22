'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

function getCandles(symbol, timeframe) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(symbol, timeframe);
}

function calcBB(closes, period, mult) {
  const bands = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { bands.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    bands.push({ upper: mean + mult * std, lower: mean - mult * std, mid: mean, std });
  }
  return bands;
}

function walkForward(signals, nFolds = 3) {
  const foldSize = Math.floor(signals.length / nFolds);
  const results = [];
  for (let f = 0; f < nFolds; f++) {
    const start = f * foldSize;
    const end = f === nFolds - 1 ? signals.length : start + foldSize;
    const fold = signals.slice(start, end);
    const wins = fold.filter(s => s.win).length;
    results.push({ wr: fold.length > 0 ? wins / fold.length : 0, n: fold.length });
  }
  const wrs = results.map(r => r.wr);
  const avgWR = wrs.reduce((a, b) => a + b, 0) / nFolds;
  const variance = wrs.reduce((a, b) => a + (b - avgWR) ** 2, 0) / nFolds;
  const sigma = Math.sqrt(variance) * 100;
  return { avgWR: avgWR * 100, sigma, folds: results, total: signals.length };
}

function getStreak(candles, idx) {
  let streak = 0;
  const dir = candles[idx].close > candles[idx].open ? 1 : -1;
  for (let i = idx; i >= 0; i--) {
    const d = candles[i].close > candles[i].open ? 1 : -1;
    if (d === dir) streak++;
    else break;
  }
  return { streak, dir };
}

function runConfig(candles5m, candles15m, label, dayFilter, hourFilter, tfLabel, bbPeriod, bbMult, minStreak) {
  const src = tfLabel === '5m' ? candles5m : candles15m;
  const closes = src.map(c => c.close);
  const bb = calcBB(closes, bbPeriod, bbMult);
  const warmup = bbPeriod + 5;
  const signals = [];

  for (let i = warmup; i < src.length - 1; i++) {
    const dt = new Date(src[i].open_time);
    const dow = dt.getUTCDay(); // 0=Sun,1=Mon,...,3=Wed,6=Sat
    const hour = dt.getUTCHours();

    if (!dayFilter(dow)) continue;
    if (hourFilter && !hourFilter(hour)) continue;
    if (!bb[i]) continue;

    const { streak, dir } = getStreak(src, i);
    if (streak < minStreak) continue;

    if (dir === 1 && src[i].close >= bb[i].upper) {
      // BEAR signal
      const win = src[i + 1].close < src[i + 1].open;
      signals.push({ win });
    } else if (dir === -1 && src[i].close <= bb[i].lower) {
      // BULL signal
      const win = src[i + 1].close > src[i + 1].open;
      signals.push({ win });
    }
  }

  if (signals.length < 20) {
    console.log(`${label}: T=${signals.length} (too few)`);
    return;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
  const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
  console.log(`${label}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
}

const candles5m = getCandles('ETH', '5m');
const candles15m = getCandles('ETH', '15m');

const GOOD_HOURS_5M = h => [10, 11, 12, 21].includes(h);
const GOOD_HOURS_15M = h => [10, 11, 12, 21].includes(h);
const ALL_HOURS = null;

console.log('=== ETH Wednesday+Hours Combo ===\n');

// Wednesday only combos on 5m
runConfig(candles5m, candles15m, 'Wed+GoodH+BB(20,2.2)+s≥2 [5m]', d => d === 3, GOOD_HOURS_5M, '5m', 20, 2.2, 2);
runConfig(candles5m, candles15m, 'Wed+AllH+BB(20,2.2)+s≥2 [5m]', d => d === 3, ALL_HOURS, '5m', 20, 2.2, 2);
runConfig(candles5m, candles15m, 'Wed+GoodH+BB(20,2.2)+s≥1 [5m]', d => d === 3, GOOD_HOURS_5M, '5m', 20, 2.2, 1);

// Wed+Sat
runConfig(candles5m, candles15m, 'Wed+Sat+GoodH+BB(20,2.2)+s≥2 [5m]', d => d === 3 || d === 6, GOOD_HOURS_5M, '5m', 20, 2.2, 2);
runConfig(candles5m, candles15m, 'Wed+Sat+AllH+BB(20,2.2)+s≥2 [5m]', d => d === 3 || d === 6, ALL_HOURS, '5m', 20, 2.2, 2);

// Fri+Sat
runConfig(candles5m, candles15m, 'Fri+Sat+GoodH+BB(20,2.2)+s≥2 [5m]', d => d === 5 || d === 6, GOOD_HOURS_5M, '5m', 20, 2.2, 2);
runConfig(candles5m, candles15m, 'Fri+Sat+AllH+BB(20,2.2)+s≥2 [5m]', d => d === 5 || d === 6, ALL_HOURS, '5m', 20, 2.2, 2);

// 15m
runConfig(candles5m, candles15m, 'Wed+GoodH+BB(15,2.2)+s≥2 [15m]', d => d === 3, GOOD_HOURS_15M, '15m', 15, 2.2, 2);
runConfig(candles5m, candles15m, 'Wed+AllH+BB(15,2.2)+s≥2 [15m]', d => d === 3, ALL_HOURS, '15m', 15, 2.2, 2);
runConfig(candles5m, candles15m, 'Fri+Sat+GoodH+BB(15,2.2)+s≥2 [15m]', d => d === 5 || d === 6, GOOD_HOURS_15M, '15m', 15, 2.2, 2);
runConfig(candles5m, candles15m, 'Fri+Sat+AllH+BB(15,2.2)+s≥2 [15m]', d => d === 5 || d === 6, ALL_HOURS, '15m', 15, 2.2, 2);
runConfig(candles5m, candles15m, 'Wed+Sat+AllH+BB(15,2.2)+s≥2 [15m]', d => d === 3 || d === 6, ALL_HOURS, '15m', 15, 2.2, 2);

// Broader day combos
runConfig(candles5m, candles15m, 'Tue+Wed+GoodH+BB(20,2.2)+s≥2 [5m]', d => d === 2 || d === 3, GOOD_HOURS_5M, '5m', 20, 2.2, 2);
runConfig(candles5m, candles15m, 'Wed+Thu+GoodH+BB(20,2.2)+s≥2 [5m]', d => d === 3 || d === 4, GOOD_HOURS_5M, '5m', 20, 2.2, 2);
