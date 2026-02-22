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

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + Math.max(d,0)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(-d,0)) / period;
    rsi[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }
  return rsi;
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

console.log('=== SOL RSI Panic Exhaustion (sol_ml_rsi_panic) ===');

const goodHours = [0, 12, 13, 20];

function testRSIPanic(candles, label, rsiThresh, bodyThresh, bbPeriod, bbMult, hoursFilter) {
  const closes = candles.map(c => c.close);
  const bb = calcBB(closes, bbPeriod, bbMult);
  const rsi = calcRSI(closes, 14);
  const signals = [];

  for (let i = 20; i < candles.length - 1; i++) {
    if (!bb[i] || rsi[i] === null) continue;

    if (hoursFilter) {
      const dt = new Date(candles[i].open_time);
      if (!hoursFilter.includes(dt.getUTCHours())) continue;
    }

    const body = Math.abs(candles[i].close - candles[i].open) / candles[i].open * 100;

    // BEAR: RSI overbought + big body candle + at BB upper
    if (rsi[i] > rsiThresh && body >= bodyThresh && candles[i].close > bb[i].upper) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close < nc.open, dir: 'BEAR' });
    }
    // BULL: RSI oversold + big body candle + at BB lower
    if (rsi[i] < (100 - rsiThresh) && body >= bodyThresh && candles[i].close < bb[i].lower) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close > nc.open, dir: 'BULL' });
    }
  }

  if (signals.length < 20) {
    console.log(label + ': SKIP T=' + signals.length + ' (too few)');
    return null;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(function(f){ return f.wr.toFixed(1) + '(' + f.n + ')'; }).join('/');
  const pass = wf.avg >= 65 && wf.sigma <= 8 && wf.folds.every(function(f){ return f.n >= 15; });
  console.log(label + ': WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
  return wf;
}

// SOL/15m synthetic
const raw5m = getCandles('SOL', '5m');
const candles15m = synth15m(raw5m);

console.log('\n--- SOL/15m Synthetic ---');
const rsiThresholds = [65, 70, 75];
const bodyThresholds = [0.2, 0.3, 0.4];
const bbConfigs = [[20, 2.2], [20, 2.0]];

for (let ri = 0; ri < rsiThresholds.length; ri++) {
  for (let bi = 0; bi < bodyThresholds.length; bi++) {
    for (let bci = 0; bci < bbConfigs.length; bci++) {
      const rsiT = rsiThresholds[ri];
      const bodyT = bodyThresholds[bi];
      const bbP = bbConfigs[bci][0], bbM = bbConfigs[bci][1];
      const label = 'RSI>' + rsiT + '+body>=' + bodyT + '%+BB(' + bbP + ',' + bbM + ')+noHourFilter/15m';
      testRSIPanic(candles15m, label, rsiT, bodyT, bbP, bbM, null);
      const label2 = 'RSI>' + rsiT + '+body>=' + bodyT + '%+BB(' + bbP + ',' + bbM + ')+GoodH/15m';
      testRSIPanic(candles15m, label2, rsiT, bodyT, bbP, bbM, goodHours);
    }
  }
}

// SOL/5m
console.log('\n--- SOL/5m ---');
const candles5m = getCandles('SOL', '5m');
const ethGoodH = [10, 11, 12, 21];

for (let ri = 0; ri < rsiThresholds.length; ri++) {
  for (let bi = 0; bi < bodyThresholds.length; bi++) {
    const rsiT = rsiThresholds[ri];
    const bodyT = bodyThresholds[bi];
    testRSIPanic(candles5m, 'RSI>' + rsiT + '+body>=' + bodyT + '%+BB(20,2.2)+noH/5m', rsiT, bodyT, 20, 2.2, null);
    testRSIPanic(candles5m, 'RSI>' + rsiT + '+body>=' + bodyT + '%+BB(20,2.2)+SOLgoodH/5m', rsiT, bodyT, 20, 2.2, goodHours);
    testRSIPanic(candles5m, 'RSI>' + rsiT + '+body>=' + bodyT + '%+BB(20,2.2)+ETHgoodH/5m', rsiT, bodyT, 20, 2.2, ethGoodH);
  }
}

console.log('\nDONE');
