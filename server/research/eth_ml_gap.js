'use strict';
// Reframed: "Range Extension Reversion" - price extends far beyond recent range, reversion expected
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

const candles = getCandles('ETH', '5m');
const opens = candles.map(c => c.open);
const highs = candles.map(c => c.high);
const lows = candles.map(c => c.low);
const closes = candles.map(c => c.close);
const times = candles.map(c => c.open_time);

const GOOD_HOURS = new Set([10, 11, 12, 21]);
const bb = calcBB(closes, 20, 2.2);

console.log('=== ETH Range Extension Reversion (ETH/5m) ===\n');

// Test 1: Up-thrust / down-thrust bar
console.log('--- Up-thrust / Down-thrust bars ---');
for (const goodH of [true, false]) {
  const signals = [];
  for (let i = 21; i < candles.length - 1; i++) {
    const hour = new Date(times[i]).getUTCHours();
    if (goodH && !GOOD_HOURS.has(hour)) continue;
    if (!bb[i]) continue;

    const range = highs[i] - lows[i];
    if (range === 0) continue;
    const midBar = lows[i] + range / 2;

    if (opens[i] >= closes[i - 1] && closes[i] < midBar && opens[i] >= bb[i].upper) {
      const win = candles[i + 1].close < candles[i + 1].open;
      signals.push({ win });
    }
    if (opens[i] <= closes[i - 1] && closes[i] > midBar && opens[i] <= bb[i].lower) {
      const win = candles[i + 1].close > candles[i + 1].open;
      signals.push({ win });
    }
  }
  if (signals.length < 10) { console.log('Up/Down thrust GoodH=' + goodH + ': T=' + signals.length + ' (too few)'); continue; }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => (f.wr * 100).toFixed(1) + '%[' + f.n + ']').join('/');
  const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
  console.log('Up/Down thrust GoodH=' + goodH + ': WR=' + wf.avgWR.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + '] ' + (pass ? '*** PASS ***' : ''));
}

// Test 2: Price closes outside recent N-bar range (range breakout => reversion)
console.log('\n--- Range breakout reversion ---');
for (const rangeLen of [12, 24, 36, 48]) {
  for (const goodH of [true, false]) {
    const signals = [];
    for (let i = rangeLen + 20; i < candles.length - 1; i++) {
      const hour = new Date(times[i]).getUTCHours();
      if (goodH && !GOOD_HOURS.has(hour)) continue;
      if (!bb[i]) continue;

      let rangeHigh = -Infinity, rangeLow = Infinity;
      for (let j = i - rangeLen; j < i; j++) {
        if (highs[j] > rangeHigh) rangeHigh = highs[j];
        if (lows[j] < rangeLow) rangeLow = lows[j];
      }

      if (closes[i] > rangeHigh && closes[i] >= bb[i].upper) {
        const win = candles[i + 1].close < candles[i + 1].open;
        signals.push({ win });
      }
      if (closes[i] < rangeLow && closes[i] <= bb[i].lower) {
        const win = candles[i + 1].close > candles[i + 1].open;
        signals.push({ win });
      }
    }
    if (signals.length < 20) continue;
    const wf = walkForward(signals);
    const foldStr = wf.folds.map(f => (f.wr * 100).toFixed(1) + '%[' + f.n + ']').join('/');
    const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
    if (pass || wf.avgWR >= 60) {
      console.log('Range(' + rangeLen + ')+BB GoodH=' + goodH + ': WR=' + wf.avgWR.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + '] ' + (pass ? '*** PASS ***' : ''));
    }
  }
}

// Test 3: Streak 2+ at BB, look at first bar of each good hour
console.log('\n--- First bar of hour + streak + BB ---');
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

for (const minStreak of [2, 3]) {
  for (const bbMult of [2.0, 2.2]) {
    const bbv = calcBB(closes, 20, bbMult);
    const signals = [];
    for (let i = 21; i < candles.length - 1; i++) {
      const dt = new Date(times[i]);
      const min = dt.getUTCMinutes();
      if (min !== 0) continue;
      const hour = dt.getUTCHours();
      if (!GOOD_HOURS.has(hour)) continue;
      if (!bbv[i]) continue;

      const { streak, dir } = getStreak(i);
      if (streak < minStreak) continue;

      if (dir === 1 && closes[i] >= bbv[i].upper) {
        const win = candles[i + 1].close < candles[i + 1].open;
        signals.push({ win });
      } else if (dir === -1 && closes[i] <= bbv[i].lower) {
        const win = candles[i + 1].close > candles[i + 1].open;
        signals.push({ win });
      }
    }
    if (signals.length < 10) { console.log('HourFirst s>=' + minStreak + ' BB(20,' + bbMult + '): T=' + signals.length + ' (too few)'); continue; }
    const wf = walkForward(signals);
    const foldStr = wf.folds.map(f => (f.wr * 100).toFixed(1) + '%[' + f.n + ']').join('/');
    const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
    console.log('HourFirst s>=' + minStreak + ' BB(20,' + bbMult + '): WR=' + wf.avgWR.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + '] ' + (pass ? '*** PASS ***' : ''));
  }
}
