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

function calcMFI(highs, lows, closes, volumes, period) {
  const mfi = new Array(closes.length).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const mf = tp.map((t, i) => t * volumes[i]);

  for (let i = period; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) posFlow += mf[j];
      else negFlow += mf[j];
    }
    if (negFlow === 0) mfi[i] = 100;
    else mfi[i] = 100 - 100 / (1 + posFlow / negFlow);
  }
  return mfi;
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

function getStreak(opens, closes, idx) {
  const dir = closes[idx] > opens[idx] ? 1 : -1;
  let streak = 0;
  for (let i = idx; i >= 0; i--) {
    const d = closes[i] > opens[i] ? 1 : -1;
    if (d === dir) streak++;
    else break;
  }
  return { streak, dir };
}

