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
    result.push({ open_time: c3[0].open_time, open: c3[0].open,
      high: Math.max(...c3.map(c => c.high)), low: Math.min(...c3.map(c => c.low)),
      close: c3[2].close, volume: c3.reduce((s, c) => s + c.volume, 0) });
  }
  return result;
}

function synth30m(candles5m) {
  const result = [];
  for (let i = 5; i < candles5m.length; i += 6) {
    const c6 = candles5m.slice(i-5, i+1);
    result.push({ open_time: c6[0].open_time, open: c6[0].open,
      high: Math.max(...c6.map(c => c.high)), low: Math.min(...c6.map(c => c.low)),
      close: c6[5].close, volume: c6.reduce((s, c) => s + c.volume, 0) });
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
  return { avg, sigma, folds: results, total: signals.length };
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

console.log('=== SOL Synth30m (sol_ml_synth30m) ===');

const goodHours = [0, 12, 13, 20];
const raw5m = getCandles('SOL', '5m');
const c30m = synth30m(raw5m);
const c15m = synth15m(raw5m);
console.log('synth30m candles: ' + c30m.length);

function testBBStreak(candles, label, bbPeriod, bbMult, minStreak, hoursFilter) {
  const bb = calcBB(candles.map(c => c.close), bbPeriod, bbMult);
  const signals = [];
  for (let i = bbPeriod; i < candles.length - 1; i++) {
    if (!bb[i]) continue;
    if (hoursFilter) {
      const dt = new Date(candles[i].open_time);
      if (!hoursFilter.includes(dt.getUTCHours())) continue;
    }
    const streak = getStreak(candles, i);
    if (candles[i].close > bb[i].upper && streak >= minStreak) {
      const nc = candles[i+1]; signals.push({ win: nc.close < nc.open });
    }
    if (candles[i].close < bb[i].lower && streak <= -minStreak) {
      const nc = candles[i+1]; signals.push({ win: nc.close > nc.open });
    }
  }
  if (signals.length < 15) { console.log(label + ': SKIP T=' + signals.length); return null; }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => f.wr.toFixed(1) + '(' + f.n + ')').join('/');
  const pass = wf.avg >= 65 && wf.sigma <= 8 && wf.folds.every(f => f.n >= 10);
  console.log(label + ': WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
  return wf;
}

console.log('--- SOL/30m Synthetic BB sweep ---');
[[20,2.2],[20,2.0],[15,2.2],[25,2.0]].forEach(([bp,bm]) => {
  [1,2,3].forEach(s => {
    testBBStreak(c30m, 'BB('+bp+','+bm+')+s>='+s+'/30m/noH', bp, bm, s, null);
    testBBStreak(c30m, 'BB('+bp+','+bm+')+s>='+s+'/30m/GoodH', bp, bm, s, goodHours);
  });
});

console.log('--- 15m + 30m BB context filter ---');
const bb30 = calcBB(c30m.map(c => c.close), 20, 2.2);
const bb15 = calcBB(c15m.map(c => c.close), 20, 2.2);
const map30 = {};
c30m.forEach((c,i) => { map30[c.open_time] = i; });

function get30mTs(ts) {
  const dt = new Date(ts);
  const min = dt.getUTCMinutes();
  dt.setUTCMinutes(min < 30 ? 0 : 30, 0, 0);
  return dt.getTime();
}

function runCtxFilter(useHours, label) {
  const signals = [];
  for (let i = 20; i < c15m.length - 1; i++) {
    if (!bb15[i]) continue;
    if (useHours) { const dt = new Date(c15m[i].open_time); if (!useHours.includes(dt.getUTCHours())) continue; }
    const t30 = get30mTs(c15m[i].open_time);
    const idx30 = map30[t30];
    if (idx30 === undefined || !bb30[idx30]) continue;
    const streak = getStreak(c15m, i);
    const p = c15m[i].close;
    if (p > bb15[i].upper && streak >= 2 && c30m[idx30].close > bb30[idx30].mid) {
      const nc = c15m[i+1]; signals.push({ win: nc.close < nc.open });
    }
    if (p < bb15[i].lower && streak <= -2 && c30m[idx30].close < bb30[idx30].mid) {
      const nc = c15m[i+1]; signals.push({ win: nc.close > nc.open });
    }
  }
  if (signals.length < 15) { console.log(label + ': SKIP T=' + signals.length); return; }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => f.wr.toFixed(1) + '(' + f.n + ')').join('/');
  const pass = wf.avg >= 65 && wf.sigma <= 8;
  console.log(label + ': WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
}

runCtxFilter(null, '15m+30mCtx+s>=2/noH');
runCtxFilter(goodHours, '15m+30mCtx+s>=2/GoodH');

console.log('DONE');