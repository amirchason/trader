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

// Build daily high/low map from 5m candles
function buildDailyRange(candles5m) {
  const dayMap = {};
  for (let i = 0; i < candles5m.length; i++) {
    const dt = new Date(candles5m[i].open_time);
    const day = dt.getUTCFullYear() + '-' + dt.getUTCMonth() + '-' + dt.getUTCDate();
    if (!dayMap[day]) dayMap[day] = { high: candles5m[i].high, low: candles5m[i].low };
    else {
      if (candles5m[i].high > dayMap[day].high) dayMap[day].high = candles5m[i].high;
      if (candles5m[i].low < dayMap[day].low) dayMap[day].low = candles5m[i].low;
    }
  }
  return dayMap;
}

function getDayKey(ts) {
  const dt = new Date(ts);
  return dt.getUTCFullYear() + '-' + dt.getUTCMonth() + '-' + dt.getUTCDate();
}

console.log('=== SOL Daily Range Extreme (sol_ml_daily_range) ===');

const goodHours = [0, 12, 13, 20];
const raw5m = getCandles('SOL', '5m');
const dayMap = buildDailyRange(raw5m);
const candles15m = synth15m(raw5m);

const bb20_22 = calcBB(candles15m.map(c => c.close), 20, 2.2);

const percentiles = [20, 25, 30, 35];

function testDailyRange(candles, bb, label, pct, minStreak, hoursFilter) {
  const threshold = pct / 100;
  const signals = [];

  for (let i = 20; i < candles.length - 1; i++) {
    if (!bb[i]) continue;

    if (hoursFilter) {
      const dt = new Date(candles[i].open_time);
      if (!hoursFilter.includes(dt.getUTCHours())) continue;
    }

    const dayKey = getDayKey(candles[i].open_time);
    const day = dayMap[dayKey];
    if (!day) continue;

    const dayRange = day.high - day.low;
    if (dayRange === 0) continue;

    const pricePos = (candles[i].close - day.low) / dayRange;
    const streak = getStreak(candles, i);

    // Top X% of daily range + BB upper -> BEAR
    if (pricePos >= (1 - threshold) && candles[i].close > bb[i].upper && streak >= minStreak) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close < nc.open });
    }
    // Bottom X% of daily range + BB lower -> BULL
    if (pricePos <= threshold && candles[i].close < bb[i].lower && streak <= -minStreak) {
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

console.log('\n--- SOL/15m Synth: Daily Range Top% + BB(20,2.2) ---');
for (let pi = 0; pi < percentiles.length; pi++) {
  const pct = percentiles[pi];
  testDailyRange(candles15m, bb20_22, 'Top' + pct + '%+BB(20,2.2)+s>=1/noH', pct, 1, null);
  testDailyRange(candles15m, bb20_22, 'Top' + pct + '%+BB(20,2.2)+s>=1/GoodH', pct, 1, goodHours);
  testDailyRange(candles15m, bb20_22, 'Top' + pct + '%+BB(20,2.2)+s>=2/noH', pct, 2, null);
  testDailyRange(candles15m, bb20_22, 'Top' + pct + '%+BB(20,2.2)+s>=2/GoodH', pct, 2, goodHours);
}

// Also test with BB(25,2.0)
const bb25_20 = calcBB(candles15m.map(c => c.close), 25, 2.0);
console.log('\n--- With BB(25,2.0) ---');
for (let pi = 0; pi < percentiles.length; pi++) {
  const pct = percentiles[pi];
  testDailyRange(candles15m, bb25_20, 'Top' + pct + '%+BB(25,2.0)+s>=1/noH', pct, 1, null);
  testDailyRange(candles15m, bb25_20, 'Top' + pct + '%+BB(25,2.0)+s>=1/GoodH', pct, 1, goodHours);
  testDailyRange(candles15m, bb25_20, 'Top' + pct + '%+BB(25,2.0)+s>=2/noH', pct, 2, null);
  testDailyRange(candles15m, bb25_20, 'Top' + pct + '%+BB(25,2.0)+s>=2/GoodH', pct, 2, goodHours);
}

console.log('\nDONE');
