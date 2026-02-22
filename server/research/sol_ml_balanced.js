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

function getDevPct(price, band) {
  if (price > band.upper) return (price - band.upper) / price * 100;
  if (price < band.lower) return (band.lower - price) / price * 100;
  return 0;
}

console.log('=== SOL Balanced BB Hours+Dev (sol_ml_balanced) ===');

const goodHours = [0, 12, 13, 20];
const raw5m = getCandles('SOL', '5m');
const candles = synth15m(raw5m);
const closes = candles.map(c => c.close);

function testBalanced(label, bbPeriod, bbMult, devMin, devMax, minStreak, hoursFilter) {
  const bb = calcBB(closes, bbPeriod, bbMult);
  const signals = [];
  for (let i = bbPeriod; i < candles.length - 1; i++) {
    if (!bb[i]) continue;
    if (hoursFilter) { const dt = new Date(candles[i].open_time); if (!hoursFilter.includes(dt.getUTCHours())) continue; }
    const price = candles[i].close;
    const aboveUpper = price > bb[i].upper;
    const belowLower = price < bb[i].lower;
    if (!aboveUpper && !belowLower) continue;
    const dev = getDevPct(price, bb[i]);
    if (dev < devMin || dev > devMax) continue;
    const streak = getStreak(candles, i);
    if (aboveUpper && streak >= minStreak) { const nc = candles[i+1]; signals.push({ win: nc.close < nc.open }); }
    if (belowLower && streak <= -minStreak) { const nc = candles[i+1]; signals.push({ win: nc.close > nc.open }); }
  }
  if (signals.length < 15) { console.log(label + ': SKIP T=' + signals.length); return null; }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => f.wr.toFixed(1) + '(' + f.n + ')').join('/');
  const pass = wf.avg >= 65 && wf.sigma <= 8 && wf.folds.every(f => f.n >= 10);
  console.log(label + ': WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
  return wf;
}

const devRanges = [[0.03,0.2],[0.05,0.25],[0.05,0.3],[0.05,0.4],[0.0,0.25],[0.1,0.3]];
const bbConfigs = [[20,2.2],[20,2.0],[25,2.0]];
const streaks = [1,2];

console.log('BB Deviation Sweet Spot Tests');
for (const [bp,bm] of bbConfigs) {
  for (const [dmin,dmax] of devRanges) {
    for (const s of streaks) {
      testBalanced('BB('+bp+','+bm+')+dev['+dmin+'-'+dmax+'%]+s>='+s+'/noH', bp, bm, dmin, dmax, s, null);
      testBalanced('BB('+bp+','+bm+')+dev['+dmin+'-'+dmax+'%]+s>='+s+'/GoodH', bp, bm, dmin, dmax, s, goodHours);
    }
  }
}

console.log('Unrestricted BB for comparison');
for (const [bp,bm] of [[20,2.2],[20,2.0]]) {
  for (const s of [1,2]) {
    testBalanced('BB('+bp+','+bm+')+dev[0-999]+s>='+s+'/noH', bp, bm, 0, 999, s, null);
    testBalanced('BB('+bp+','+bm+')+dev[0-999]+s>='+s+'/GoodH', bp, bm, 0, 999, s, goodHours);
  }
}

console.log('Deep BB only (dev>0.5%)');
testBalanced('BB(20,2.2)+dev>0.5%+s>=1/noH', 20, 2.2, 0.5, 999, 1, null);
testBalanced('BB(20,2.2)+dev>0.5%+s>=2/noH', 20, 2.2, 0.5, 999, 2, null);

console.log('DONE');