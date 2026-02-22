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

function calcMFI(candles, period) {
  const mfi = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const prevTp = (candles[j-1].high + candles[j-1].low + candles[j-1].close) / 3;
      const rawFlow = tp * candles[j].volume;
      if (tp > prevTp) posFlow += rawFlow;
      else negFlow += rawFlow;
    }
    mfi[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return mfi;
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

console.log('=== SOL MFI Exhaustion (sol_ml_mfi) ===');

const goodHours = [0, 12, 13, 20];

function testMFI(candles, label, mfiPeriod, mfiThresh, bbPeriod, bbMult, minStreak, hoursFilter) {
  const bb = calcBB(candles.map(c => c.close), bbPeriod, bbMult);
  const mfi = calcMFI(candles, mfiPeriod);
  const signals = [];

  for (let i = mfiPeriod + 1; i < candles.length - 1; i++) {
    if (!bb[i] || mfi[i] === null) continue;

    if (hoursFilter) {
      const dt = new Date(candles[i].open_time);
      if (!hoursFilter.includes(dt.getUTCHours())) continue;
    }

    const streak = getStreak(candles, i);

    if (mfi[i] > mfiThresh && candles[i].close > bb[i].upper && streak >= minStreak) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close < nc.open });
    }
    if (mfi[i] < (100 - mfiThresh) && candles[i].close < bb[i].lower && streak <= -minStreak) {
      const nc = candles[i + 1];
      signals.push({ win: nc.close > nc.open });
    }
  }

  if (signals.length < 20) {
    console.log(label + ': SKIP T=' + signals.length);
    return null;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(function(f){ return f.wr.toFixed(1) + '(' + f.n + ')'; }).join('/');
  const pass = wf.avg >= 65 && wf.sigma <= 8 && wf.folds.every(function(f){ return f.n >= 15; });
  console.log(label + ': WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
  return wf;
}

const raw5m = getCandles('SOL', '5m');
const candles15m = synth15m(raw5m);

console.log('\n--- SOL/15m Synthetic, no hour filter ---');
const mfiPeriods = [7, 10, 14];
const mfiThresholds = [75, 80, 85];

for (let pi = 0; pi < mfiPeriods.length; pi++) {
  for (let ti = 0; ti < mfiThresholds.length; ti++) {
    const p = mfiPeriods[pi], t = mfiThresholds[ti];
    testMFI(candles15m, 'MFI(' + p + ')>' + t + '+BB(20,2.2)+s>=1/noH', p, t, 20, 2.2, 1, null);
    testMFI(candles15m, 'MFI(' + p + ')>' + t + '+BB(20,2.2)+s>=2/noH', p, t, 20, 2.2, 2, null);
  }
}

console.log('\n--- SOL/15m Synthetic, GoodH filter ---');
for (let pi = 0; pi < mfiPeriods.length; pi++) {
  for (let ti = 0; ti < mfiThresholds.length; ti++) {
    const p = mfiPeriods[pi], t = mfiThresholds[ti];
    testMFI(candles15m, 'MFI(' + p + ')>' + t + '+BB(20,2.2)+s>=1+GoodH', p, t, 20, 2.2, 1, goodHours);
    testMFI(candles15m, 'MFI(' + p + ')>' + t + '+BB(20,2.2)+s>=2+GoodH', p, t, 20, 2.2, 2, goodHours);
  }
}

// Also try MFI alone with BB (no streak)
console.log('\n--- MFI+BB only (no streak filter) ---');
for (let pi = 0; pi < mfiPeriods.length; pi++) {
  for (let ti = 0; ti < mfiThresholds.length; ti++) {
    const p = mfiPeriods[pi], t = mfiThresholds[ti];
    const bb = calcBB(candles15m.map(c => c.close), 20, 2.2);
    const mfi = calcMFI(candles15m, p);
    const signals = [];
    for (let i = p + 1; i < candles15m.length - 1; i++) {
      if (!bb[i] || mfi[i] === null) continue;
      if (mfi[i] > t && candles15m[i].close > bb[i].upper) {
        const nc = candles15m[i + 1];
        signals.push({ win: nc.close < nc.open });
      }
      if (mfi[i] < (100 - t) && candles15m[i].close < bb[i].lower) {
        const nc = candles15m[i + 1];
        signals.push({ win: nc.close > nc.open });
      }
    }
    if (signals.length >= 20) {
      const wf = walkForward(signals);
      const foldStr = wf.folds.map(function(f){ return f.wr.toFixed(1) + '(' + f.n + ')'; }).join('/');
      const pass = wf.avg >= 65 && wf.sigma <= 8;
      console.log('MFI(' + p + ')>' + t + '+BB(20,2.2)/noStreak: WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
    }
  }
}

console.log('\nDONE');
