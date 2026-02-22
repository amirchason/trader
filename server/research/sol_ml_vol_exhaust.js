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

function calcVolAvg(candles, period) {
  const avgs = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period; j < i; j++) sum += candles[j].volume;
    avgs[i] = sum / period;
  }
  return avgs;
}

console.log('=== SOL Volume Exhaustion (sol_ml_vol_exhaust) ===');

const goodHours = [0, 12, 13, 20];
const raw5m = getCandles('SOL', '5m');
const candles15m = synth15m(raw5m);
const candles5m = raw5m;

function testVolExhaust(candles, label, volMult, bbPeriod, bbMult, minStreak, hoursFilter) {
  const closes = candles.map(c => c.close);
  const bb = calcBB(closes, bbPeriod, bbMult);
  const volAvg = calcVolAvg(candles, 20);
  const signals = [];

  for (let i = 25; i < candles.length - 1; i++) {
    if (!bb[i] || !volAvg[i]) continue;

    if (hoursFilter) {
      const dt = new Date(candles[i].open_time);
      if (!hoursFilter.includes(dt.getUTCHours())) continue;
    }

    const streak = getStreak(candles, i);
    const volSpike = candles[i].volume > volMult * volAvg[i];

    if (volSpike && candles[i].close > bb[i].upper && streak >= minStreak) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close < nc.open });
    }
    if (volSpike && candles[i].close < bb[i].lower && streak <= -minStreak) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close > nc.open });
    }
  }

  if (signals.length < 15) {
    console.log(label + ': SKIP T=' + signals.length);
    return null;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(function(f){ return f.wr.toFixed(1) + '(' + f.n + ')'; }).join('/');
  const pass = wf.avg >= 65 && wf.sigma <= 8 && wf.folds.every(function(f){ return f.n >= 10; });
  console.log(label + ': WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
  return wf;
}

const volMults = [2, 3];
const streaks = [1, 2, 3];
const bbConfigs = [[20, 2.2], [20, 2.0]];

console.log('\n--- SOL/15m Synthetic ---');
for (let vi = 0; vi < volMults.length; vi++) {
  for (let si = 0; si < streaks.length; si++) {
    for (let bci = 0; bci < bbConfigs.length; bci++) {
      const vm = volMults[vi], s = streaks[si], bp = bbConfigs[bci][0], bm = bbConfigs[bci][1];
      testVolExhaust(candles15m, 'Vol>' + vm + 'x+BB(' + bp + ',' + bm + ')+s>=' + s + '/15m/noH', vm, bp, bm, s, null);
      testVolExhaust(candles15m, 'Vol>' + vm + 'x+BB(' + bp + ',' + bm + ')+s>=' + s + '/15m/GoodH', vm, bp, bm, s, goodHours);
    }
  }
}

console.log('\n--- SOL/5m ---');
for (let vi = 0; vi < volMults.length; vi++) {
  for (let si = 0; si < streaks.length; si++) {
    testVolExhaust(candles5m, 'Vol>' + volMults[vi] + 'x+BB(20,2.2)+s>=' + streaks[si] + '/5m/noH', volMults[vi], 20, 2.2, streaks[si], null);
    testVolExhaust(candles5m, 'Vol>' + volMults[vi] + 'x+BB(20,2.2)+s>=' + streaks[si] + '/5m/GoodH', volMults[vi], 20, 2.2, streaks[si], goodHours);
  }
}

console.log('\nDONE');
