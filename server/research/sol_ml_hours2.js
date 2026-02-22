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

function synth15m(candles5m) {
  const result = [];
  for (let i = 2; i < candles5m.length; i += 3) {
    const c3 = [candles5m[i-2], candles5m[i-1], candles5m[i]];
    result.push({
      open_time: c3[0].open_time,
      open: c3[0].open,
      high: Math.max(...c3.map(c => c.high)),
      low: Math.min(...c3.map(c => c.low)),
      close: c3[2].close,
      volume: c3.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

function walkForward(signals, nFolds) {
  nFolds = nFolds || 3;
  const foldSize = Math.floor(signals.length / nFolds);
  const results = [];
  for (let f = 0; f < nFolds; f++) {
    const start = f * foldSize;
    const end = f === nFolds - 1 ? signals.length : start + foldSize;
    const fold = signals.slice(start, end);
    const wins = fold.filter(s => s.win).length;
    results.push({ wr: fold.length > 0 ? wins / fold.length * 100 : 0, n: fold.length });
  }
  const wrs = results.map(r => r.wr);
  const avg = wrs.reduce((a,b)=>a+b,0)/nFolds;
  const sigma = Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nFolds);
  return { avg: avg, sigma: sigma, folds: results, total: signals.length };
}

function getStreak(candles, i) {
  let streak = 0;
  for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
    const isGreen = candles[j].close > candles[j].open;
    if (j === i - 1) streak = isGreen ? 1 : -1;
    else {
      const prevGreen = candles[j].close > candles[j].open;
      if (streak > 0 && prevGreen) streak++;
      else if (streak < 0 && !prevGreen) streak--;
      else break;
    }
  }
  return streak;
}

const raw5m = getCandles('SOL', '5m');
const candles = synth15m(raw5m);
const closes = candles.map(c => c.close);
const bb = calcBB(closes, 20, 2.2);

console.log('=== SOL Hour Sweep Extended (sol_ml_hours2) ===');
console.log('Total synth15m candles: ' + candles.length);

const allHours = [];
for (let i = 0; i < 24; i++) allHours.push(i);
const hourResults = [];

for (let hi = 0; hi < allHours.length; hi++) {
  const h = allHours[hi];
  const signals = [];
  for (let i = 20; i < candles.length - 1; i++) {
    if (!bb[i]) continue;
    const dt = new Date(candles[i].open_time);
    if (dt.getUTCHours() !== h) continue;

    const streak = getStreak(candles, i);
    const aboveUpper = candles[i].close > bb[i].upper;
    const belowLower = candles[i].close < bb[i].lower;

    if (aboveUpper && streak >= 2) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close < nc.open });
    } else if (belowLower && streak <= -2) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close > nc.open });
    }
  }

  if (signals.length >= 10) {
    const wf = walkForward(signals);
    hourResults.push({ hour: h, avg: wf.avg, sigma: wf.sigma, folds: wf.folds, total: wf.total });
  } else {
    hourResults.push({ hour: h, avg: 0, sigma: 99, total: signals.length, folds: [] });
  }
}

console.log('\n--- Single Hour Results (BB20,2.2 + streak>=2) ---');
const sorted = hourResults.slice().sort(function(a,b){ return b.avg - a.avg; });
for (let i = 0; i < sorted.length; i++) {
  const r = sorted[i];
  const foldStr = r.folds.map(function(f){ return f.wr.toFixed(1); }).join('/');
  const pass = r.avg >= 60 && r.total >= 20;
  console.log('h=' + String(r.hour).padStart(2,'0') + ' UTC: WR=' + r.avg.toFixed(1) + '% sigma=' + r.sigma.toFixed(1) + '% T=' + r.total + ' [' + foldStr + ']' + (pass ? ' <<' : ''));
}

const goodHours = hourResults.filter(function(r){ return r.avg >= 60 && r.total >= 15; }).map(function(r){ return r.hour; });
console.log('\nGood hours (WR>=60%, T>=15): [' + goodHours.join(',') + ']');

const combosToTest = [
  [0, 12], [0, 13], [12, 13], [0, 12, 13], [0, 20],
  [12, 20], [13, 20], [0, 12, 20], [0, 13, 20],
  [12, 13, 20], [0, 12, 13, 20],
  [1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 14],
  [15, 16], [17, 18], [19, 21], [22, 23],
];

const baseSet = [0, 12, 13, 20];
for (let h = 0; h < 24; h++) {
  if (!baseSet.includes(h)) {
    combosToTest.push(baseSet.concat([h]));
  }
}

console.log('\n--- Hour Combination Results (top 25) ---');
const comboResults = [];
for (let ci = 0; ci < combosToTest.length; ci++) {
  const hours = combosToTest[ci];
  const signals = [];
  for (let i = 20; i < candles.length - 1; i++) {
    if (!bb[i]) continue;
    const dt = new Date(candles[i].open_time);
    if (!hours.includes(dt.getUTCHours())) continue;

    const streak = getStreak(candles, i);
    const aboveUpper = candles[i].close > bb[i].upper;
    const belowLower = candles[i].close < bb[i].lower;

    if (aboveUpper && streak >= 2) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close < nc.open });
    } else if (belowLower && streak <= -2) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close > nc.open });
    }
  }

  if (signals.length >= 20) {
    const wf = walkForward(signals);
    comboResults.push({ hours: hours.join(','), avg: wf.avg, sigma: wf.sigma, folds: wf.folds, total: wf.total });
  }
}

comboResults.sort(function(a,b){ return b.avg - a.avg; });
const top = comboResults.slice(0, 25);
for (let i = 0; i < top.length; i++) {
  const r = top[i];
  const foldStr = r.folds.map(function(f){ return f.wr.toFixed(1) + '(' + f.n + ')'; }).join('/');
  const pass = r.avg >= 65 && r.sigma <= 8 && r.folds.every(function(f){ return f.n >= 15; });
  console.log('h=[' + r.hours + ']: WR=' + r.avg.toFixed(1) + '% sigma=' + r.sigma.toFixed(1) + '% T=' + r.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
}

console.log('\nDONE');
