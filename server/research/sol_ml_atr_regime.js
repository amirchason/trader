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

function getRollingPercentile(atrValues, windowSize, pct) {
  const result = new Array(atrValues.length).fill(null);
  for (let i = windowSize; i < atrValues.length; i++) {
    const win = [];
    for (let j = i - windowSize; j <= i; j++) {
      if (atrValues[j] !== null) win.push(atrValues[j]);
    }
    win.sort(function(a, b) { return a - b; });
    const threshold = win[Math.floor(win.length * pct / 100)];
    result[i] = { threshold: threshold, current: atrValues[i] };
  }
  return result;
}

console.log('=== SOL ATR Regime (sol_ml_atr_regime) ===');

const goodHours = [0, 12, 13, 20];
const raw5m = getCandles('SOL', '5m');
const candles15m = synth15m(raw5m);

const atr14 = calcATR(candles15m, 14);
const bb = calcBB(candles15m.map(c => c.close), 20, 2.2);

const pctThresholds = [25, 33, 40, 50];
const rollingWindow = 200;

console.log('\n--- Low ATR Regime ---');

for (let pi = 0; pi < pctThresholds.length; pi++) {
  const pct = pctThresholds[pi];
  const rollingAtr = getRollingPercentile(atr14, rollingWindow, pct);

  for (let si = 1; si <= 2; si++) {
    for (let hoursIdx = 0; hoursIdx < 2; hoursIdx++) {
      const useHours = hoursIdx === 0 ? null : goodHours;
      const signals = [];

      for (let i = rollingWindow + 15; i < candles15m.length - 1; i++) {
        if (!bb[i] || !rollingAtr[i]) continue;
        if (useHours) {
          const dt = new Date(candles15m[i].open_time);
          if (!useHours.includes(dt.getUTCHours())) continue;
        }
        if (rollingAtr[i].current > rollingAtr[i].threshold) continue;
        const streak = getStreak(candles15m, i);
        if (candles15m[i].close > bb[i].upper && streak >= si) {
          const nc = candles15m[i + 1];
          signals.push({ win: nc.close < nc.open });
        }
        if (candles15m[i].close < bb[i].lower && streak <= -si) {
          const nc = candles15m[i + 1];
          signals.push({ win: nc.close > nc.open });
        }
      }

      const hourStr = useHours ? 'GoodH' : 'noH';
      const label = 'LowATR<' + pct + 'pct+BB(20,2.2)+s>=' + si + '/' + hourStr;
      if (signals.length < 15) { console.log(label + ': SKIP T=' + signals.length); continue; }
      const wf = walkForward(signals);
      const foldStr = wf.folds.map(function(f){ return f.wr.toFixed(1) + '(' + f.n + ')'; }).join('/');
      const pass = wf.avg >= 65 && wf.sigma <= 8 && wf.folds.every(function(f){ return f.n >= 10; });
      console.log(label + ': WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
    }
  }
}

console.log('\n--- High ATR Regime ---');
for (let pi = 0; pi < pctThresholds.length; pi++) {
  const pct = pctThresholds[pi];
  const rollingAtr = getRollingPercentile(atr14, rollingWindow, 100 - pct);
  const signals = [];
  for (let i = rollingWindow + 15; i < candles15m.length - 1; i++) {
    if (!bb[i] || !rollingAtr[i]) continue;
    if (rollingAtr[i].current < rollingAtr[i].threshold) continue;
    const streak = getStreak(candles15m, i);
    if (candles15m[i].close > bb[i].upper && streak >= 2) {
      const nc = candles15m[i + 1]; signals.push({ win: nc.close < nc.open });
    }
    if (candles15m[i].close < bb[i].lower && streak <= -2) {
      const nc = candles15m[i + 1]; signals.push({ win: nc.close > nc.open });
    }
  }
  if (signals.length >= 15) {
    const wf = walkForward(signals);
    const foldStr = wf.folds.map(function(f){ return f.wr.toFixed(1) + '(' + f.n + ')'; }).join('/');
    const pass = wf.avg >= 65 && wf.sigma <= 8;
    console.log('HighATR>' + (100-pct) + 'pct+BB(20,2.2)+s>=2: WR=' + wf.avg.toFixed(1) + '% sigma=' + wf.sigma.toFixed(1) + '% T=' + wf.total + ' [' + foldStr + ']' + (pass ? ' *** PASS ***' : ''));
  }
}

const baseSignals = [];
for (let i = 20; i < candles15m.length - 1; i++) {
  if (!bb[i]) continue;
  const streak = getStreak(candles15m, i);
  if (candles15m[i].close > bb[i].upper && streak >= 2) {
    const nc = candles15m[i + 1]; baseSignals.push({ win: nc.close < nc.open });
  }
  if (candles15m[i].close < bb[i].lower && streak <= -2) {
    const nc = candles15m[i + 1]; baseSignals.push({ win: nc.close > nc.open });
  }
}
const baseWf = walkForward(baseSignals);
console.log('\nBaseline (no ATR filter): WR=' + baseWf.avg.toFixed(1) + '% sigma=' + baseWf.sigma.toFixed(1) + '% T=' + baseWf.total + ' [' + baseWf.folds.map(function(f){ return f.wr.toFixed(1); }).join('/') + ']');

console.log('\nDONE');
