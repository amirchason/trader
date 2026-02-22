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

function calcATR(highs, lows, closes, period) {
  const atr = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  atr[period] = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    atr[i] = (atr[i-1] * (period - 1) + tr) / period;
  }
  return atr;
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

const candles = getCandles('ETH', '5m');
const opens = candles.map(c => c.open);
const highs = candles.map(c => c.high);
const lows = candles.map(c => c.low);
const closes = candles.map(c => c.close);
const times = candles.map(c => c.open_time);

const GOOD_HOURS = new Set([10, 11, 12, 21]);

function getStreak(idx) {
  const dir = closes[idx] > opens[idx] ? 1 : -1;
  let streak = 0;
  for (let i = idx; i >= 0; i--) {
    const d = closes[i] > opens[i] ? 1 : -1;
    if (d === dir) streak++;
    else break;
  }
  return { streak, dir };
}

const configs = [
  { atrPeriod: 10, bodyThresh: 0.2, bbPeriod: 20, bbMult: 2.2, minStreak: 3, goodH: true },
  { atrPeriod: 10, bodyThresh: 0.3, bbPeriod: 20, bbMult: 2.2, minStreak: 3, goodH: true },
  { atrPeriod: 10, bodyThresh: 0.4, bbPeriod: 20, bbMult: 2.2, minStreak: 3, goodH: true },
  { atrPeriod: 14, bodyThresh: 0.2, bbPeriod: 20, bbMult: 2.2, minStreak: 3, goodH: true },
  { atrPeriod: 14, bodyThresh: 0.3, bbPeriod: 20, bbMult: 2.2, minStreak: 3, goodH: true },
  { atrPeriod: 14, bodyThresh: 0.4, bbPeriod: 20, bbMult: 2.2, minStreak: 3, goodH: true },
  { atrPeriod: 10, bodyThresh: 0.3, bbPeriod: 20, bbMult: 2.2, minStreak: 2, goodH: true },
  { atrPeriod: 10, bodyThresh: 0.3, bbPeriod: 20, bbMult: 2.0, minStreak: 3, goodH: true },
  { atrPeriod: 10, bodyThresh: 0.3, bbPeriod: 20, bbMult: 2.2, minStreak: 3, goodH: false },
  { atrPeriod: 14, bodyThresh: 0.3, bbPeriod: 20, bbMult: 2.2, minStreak: 2, goodH: true },
];

console.log('=== ETH Small Body Exhaustion (ETH/5m) ===\n');

for (const cfg of configs) {
  const bb = calcBB(closes, cfg.bbPeriod, cfg.bbMult);
  const atr = calcATR(highs, lows, closes, cfg.atrPeriod);

  const signals = [];
  const warmup = Math.max(cfg.atrPeriod, cfg.bbPeriod) + 5;

  for (let i = warmup; i < candles.length - 1; i++) {
    const hour = new Date(times[i]).getUTCHours();
    if (cfg.goodH && !GOOD_HOURS.has(hour)) continue;
    if (!bb[i] || !atr[i]) continue;

    const { streak, dir } = getStreak(i);
    if (streak < cfg.minStreak) continue;

    const body = Math.abs(closes[i] - opens[i]);
    const bodyRatio = atr[i] > 0 ? body / atr[i] : 1;

    // Small body (exhaustion/indecision candle)
    if (bodyRatio > cfg.bodyThresh) continue;

    if (dir === 1 && closes[i] >= bb[i].upper) {
      const win = candles[i + 1].close < candles[i + 1].open;
      signals.push({ win });
    } else if (dir === -1 && closes[i] <= bb[i].lower) {
      const win = candles[i + 1].close > candles[i + 1].open;
      signals.push({ win });
    }
  }

  if (signals.length < 20) {
    console.log(`ATR(${cfg.atrPeriod}) body<${cfg.bodyThresh} BB(${cfg.bbPeriod},${cfg.bbMult}) s≥${cfg.minStreak} GoodH=${cfg.goodH}: T=${signals.length} (too few)`);
    continue;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
  const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
  console.log(`ATR(${cfg.atrPeriod}) body<${cfg.bodyThresh} BB(${cfg.bbPeriod},${cfg.bbMult}) s≥${cfg.minStreak} GoodH=${cfg.goodH}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
}
