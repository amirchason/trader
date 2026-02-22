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

function calcEMA(closes, period) {
  const ema = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  ema[period - 1] = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i-1] * (1 - k);
  }
  return ema;
}

function calcATR(candles, period) {
  const atr = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
    if (i < period) { sum += tr; }
    else if (i === period) { sum += tr; atr[i] = sum / period; }
    else { atr[i] = (atr[i-1] * (period-1) + tr) / period; }
  }
  return atr;
}

function calcKeltner(candles, emaPeriod, atrPeriod, mult) {
  const closes = candles.map(c => c.close);
  const ema = calcEMA(closes, emaPeriod);
  const atr = calcATR(candles, atrPeriod);
  const kc = [];
  for (let i = 0; i < candles.length; i++) {
    if (ema[i] === null || atr[i] === null) { kc.push(null); continue; }
    kc.push({ upper: ema[i] + mult * atr[i], lower: ema[i] - mult * atr[i], mid: ema[i] });
  }
  return kc;
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

console.log('=== SOL Keltner+BB (sol_ml_keltner) ===');

const goodHours = [0, 12, 13, 20];

function testKeltnerBB(candles, label, kcMult, bbPeriod, bbMult, minStreak, hoursFilter) {
  const closes = candles.map(c => c.close);
  const bb = calcBB(closes, bbPeriod, bbMult);
  const kc = calcKeltner(candles, 20, 10, kcMult);
  const signals = [];

  for (let i = 25; i < candles.length - 1; i++) {
    if (!bb[i] || !kc[i]) continue;

    if (hoursFilter) {
      const dt = new Date(candles[i].open_time);
      if (!hoursFilter.includes(dt.getUTCHours())) continue;
    }

    const streak = getStreak(candles, i);
    const price = candles[i].close;

    // BEAR: outside both upper bands
    if (price > bb[i].upper && price > kc[i].upper && streak >= minStreak) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close < nc.open });
    }
    // BULL: outside both lower bands
    if (price < bb[i].lower && price < kc[i].lower && streak <= -minStreak) {
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

const raw5m = getCandles('SOL', '5m');
const candles15m = synth15m(raw5m);
const candles5m = getCandles('SOL', '5m');

const kcMults = [1.5, 2.0];
const bbConfigs = [[20, 2.2], [25, 2.0]];
const streaks = [1, 2];

console.log('\n--- SOL/15m Synthetic ---');
for (let ki = 0; ki < kcMults.length; ki++) {
  for (let bci = 0; bci < bbConfigs.length; bci++) {
    for (let si = 0; si < streaks.length; si++) {
      const km = kcMults[ki], bp = bbConfigs[bci][0], bm = bbConfigs[bci][1], s = streaks[si];
      const label = 'KC(' + km + ')+BB(' + bp + ',' + bm + ')+s>=' + s;
      testKeltnerBB(candles15m, label + '/15m/noH', km, bp, bm, s, null);
      testKeltnerBB(candles15m, label + '/15m/GoodH', km, bp, bm, s, goodHours);
    }
  }
}

console.log('\n--- SOL/5m ---');
for (let ki = 0; ki < kcMults.length; ki++) {
  for (let bci = 0; bci < bbConfigs.length; bci++) {
    for (let si = 0; si < streaks.length; si++) {
      const km = kcMults[ki], bp = bbConfigs[bci][0], bm = bbConfigs[bci][1], s = streaks[si];
      const label = 'KC(' + km + ')+BB(' + bp + ',' + bm + ')+s>=' + s;
      testKeltnerBB(candles5m, label + '/5m/noH', km, bp, bm, s, null);
      testKeltnerBB(candles5m, label + '/5m/GoodH', km, bp, bm, s, goodHours);
    }
  }
}

console.log('\nDONE');
