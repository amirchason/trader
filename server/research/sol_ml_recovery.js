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

function isGreen(c) { return c.close > c.open; }
function isRed(c) { return c.close < c.open; }

console.log('=== SOL Recovery Rally Exhaustion (sol_ml_recovery) ===');

const goodHours = [0, 12, 13, 20];

function testPattern(candles, label, patternCheck, bbPeriod, bbMult, hoursFilter) {
  const bb = calcBB(candles.map(c => c.close), bbPeriod, bbMult);
  const signals = [];

  for (let i = 4; i < candles.length - 1; i++) {
    if (!bb[i]) continue;

    if (hoursFilter) {
      const dt = new Date(candles[i].open_time);
      if (!hoursFilter.includes(dt.getUTCHours())) continue;
    }

    const result = patternCheck(candles, bb, i);
    if (result !== null) {
      const nc = candles[i + 1];
      const win = result === 'BEAR' ? nc.close < nc.open : nc.close > nc.open;
      signals.push({ win: win, dir: result });
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

// RGGG at BB upper -> BEAR (ETH strat 14)
const rgggBear = function(c, bb, i) {
  if (i < 4) return null;
  if (isRed(c[i-3]) && isGreen(c[i-2]) && isGreen(c[i-1]) && isGreen(c[i]) && c[i].close > bb[i].upper) return 'BEAR';
  return null;
};

// GRGG at BB upper -> BEAR
const grggBear = function(c, bb, i) {
  if (i < 4) return null;
  if (isGreen(c[i-3]) && isRed(c[i-2]) && isGreen(c[i-1]) && isGreen(c[i]) && c[i].close > bb[i].upper) return 'BEAR';
  return null;
};

// RRRG at BB lower -> BULL
const rrrg = function(c, bb, i) {
  if (i < 4) return null;
  if (isRed(c[i-3]) && isRed(c[i-2]) && isRed(c[i-1]) && isGreen(c[i]) && c[i].close < bb[i].lower) return 'BULL';
  return null;
};

// GRRR at BB lower -> BULL
const grrr = function(c, bb, i) {
  if (i < 4) return null;
  if (isGreen(c[i-3]) && isRed(c[i-2]) && isRed(c[i-1]) && isRed(c[i]) && c[i].close < bb[i].lower) return 'BULL';
  return null;
};

// GGG at BB upper (only 3 candles)
const ggg = function(c, bb, i) {
  if (i < 3) return null;
  if (isGreen(c[i-2]) && isGreen(c[i-1]) && isGreen(c[i]) && c[i].close > bb[i].upper) return 'BEAR';
  return null;
};

// RRR at BB lower
const rrr = function(c, bb, i) {
  if (i < 3) return null;
  if (isRed(c[i-2]) && isRed(c[i-1]) && isRed(c[i]) && c[i].close < bb[i].lower) return 'BULL';
  return null;
};

// RGGG or GRGG combined
const rgggOrGrgg = function(c, bb, i) {
  if (i < 4) return null;
  const a = (isRed(c[i-3]) && isGreen(c[i-2]) && isGreen(c[i-1]) && isGreen(c[i]) && c[i].close > bb[i].upper);
  const b = (isGreen(c[i-3]) && isRed(c[i-2]) && isGreen(c[i-1]) && isGreen(c[i]) && c[i].close > bb[i].upper);
  if (a || b) return 'BEAR';
  return null;
};

// Combine BEAR + BULL patterns
const allPatterns = function(c, bb, i) {
  if (i < 4) return null;
  const rggg = (isRed(c[i-3]) && isGreen(c[i-2]) && isGreen(c[i-1]) && isGreen(c[i]) && c[i].close > bb[i].upper);
  const grgg = (isGreen(c[i-3]) && isRed(c[i-2]) && isGreen(c[i-1]) && isGreen(c[i]) && c[i].close > bb[i].upper);
  const rrrg = (isRed(c[i-3]) && isRed(c[i-2]) && isRed(c[i-1]) && isGreen(c[i]) && c[i].close < bb[i].lower);
  if (rggg || grgg) return 'BEAR';
  if (rrrg) return 'BULL';
  return null;
};

const bbConfigs = [[20, 2.2], [15, 2.2], [20, 2.0]];

console.log('\n--- SOL/15m Synthetic patterns ---');
for (let bci = 0; bci < bbConfigs.length; bci++) {
  const bp = bbConfigs[bci][0], bm = bbConfigs[bci][1];
  const suffix = 'BB(' + bp + ',' + bm + ')';
  testPattern(candles15m, 'RGGG+' + suffix + '/noH', rgggBear, bp, bm, null);
  testPattern(candles15m, 'RGGG+' + suffix + '/GoodH', rgggBear, bp, bm, goodHours);
  testPattern(candles15m, 'GRGG+' + suffix + '/noH', grggBear, bp, bm, null);
  testPattern(candles15m, 'GRGG+' + suffix + '/GoodH', grggBear, bp, bm, goodHours);
  testPattern(candles15m, 'RRRG+' + suffix + '/noH', rrrg, bp, bm, null);
  testPattern(candles15m, 'GRRR+' + suffix + '/noH', grrr, bp, bm, null);
  testPattern(candles15m, 'GGG+' + suffix + '/noH', ggg, bp, bm, null);
  testPattern(candles15m, 'RRR+' + suffix + '/noH', rrr, bp, bm, null);
  testPattern(candles15m, 'RGGG+GRGG+' + suffix + '/noH', rgggOrGrgg, bp, bm, null);
  testPattern(candles15m, 'RGGG+GRGG+' + suffix + '/GoodH', rgggOrGrgg, bp, bm, goodHours);
  testPattern(candles15m, 'AllPatterns+' + suffix + '/noH', allPatterns, bp, bm, null);
  testPattern(candles15m, 'AllPatterns+' + suffix + '/GoodH', allPatterns, bp, bm, goodHours);
}

console.log('\nDONE');
