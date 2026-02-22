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

function walkForward(signals, nFolds = 3) {
  const foldSize = Math.floor(signals.length / nFolds);
  const results = [];
  for (let f = 0; f < nFolds; f++) {
    const start = f * foldSize;
    const end = f === nFolds - 1 ? signals.length : start + foldSize;
    const fold = signals.slice(start, end);
    const wins = fold.filter(s => s.win).length;
    results.push({ wr: fold.length > 0 ? wins / fold.length : 0, n: fold.length });
  }
  const wrs = results.map(r => r.wr);
  const avgWR = wrs.reduce((a, b) => a + b, 0) / nFolds;
  const variance = wrs.reduce((a, b) => a + (b - avgWR) ** 2, 0) / nFolds;
  const sigma = Math.sqrt(variance) * 100;
  return { avgWR: avgWR * 100, sigma, folds: results, total: signals.length };
}

const candles = getCandles('ETH', '5m');
const opens = candles.map(c => c.open);
const highs = candles.map(c => c.high);
const lows = candles.map(c => c.low);
const closes = candles.map(c => c.close);
const volumes = candles.map(c => c.volume);
const times = candles.map(c => c.open_time);

// Compute daily session VWAP (reset at UTC midnight)
const vwap = new Array(candles.length).fill(null);
let cumTP = 0, cumVol = 0;
let lastDay = -1;
for (let i = 0; i < candles.length; i++) {
  const dt = new Date(times[i]);
  const day = dt.getUTCDate();
  if (day !== lastDay) {
    cumTP = 0; cumVol = 0; lastDay = day;
  }
  const tp = (highs[i] + lows[i] + closes[i]) / 3;
  cumTP += tp * volumes[i];
  cumVol += volumes[i];
  vwap[i] = cumVol > 0 ? cumTP / cumVol : null;
}

const bb20_22 = calcBB(closes, 20, 2.2);
const GOOD_HOURS = new Set([10, 11, 12, 21]);

const thresholds = [0.002, 0.003, 0.004, 0.005];

console.log('=== ETH VWAP Exhaustion (ETH/5m) ===\n');

for (const thresh of thresholds) {
  const cfgs = [
    { goodH: true, bbConfirm: true, label: `VWAP dev>${thresh*100}% BB GoodH` },
    { goodH: false, bbConfirm: true, label: `VWAP dev>${thresh*100}% BB AllH` },
    { goodH: true, bbConfirm: false, label: `VWAP dev>${thresh*100}% noBB GoodH` },
  ];

  for (const cfg of cfgs) {
    const signals = [];
    for (let i = 21; i < candles.length - 1; i++) {
      const hour = new Date(times[i]).getUTCHours();
      if (cfg.goodH && !GOOD_HOURS.has(hour)) continue;
      if (!vwap[i] || !bb20_22[i]) continue;

      const dev = (closes[i] - vwap[i]) / vwap[i];

      if (dev >= thresh) {
        // Price far above VWAP → BEAR
        if (cfg.bbConfirm && closes[i] < bb20_22[i].upper) continue;
        const win = candles[i + 1].close < candles[i + 1].open;
        signals.push({ win });
      } else if (dev <= -thresh) {
        // Price far below VWAP → BULL
        if (cfg.bbConfirm && closes[i] > bb20_22[i].lower) continue;
        const win = candles[i + 1].close > candles[i + 1].open;
        signals.push({ win });
      }
    }

    if (signals.length < 20) {
      console.log(`${cfg.label}: T=${signals.length} (too few)`);
      continue;
    }
    const wf = walkForward(signals);
    const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
    const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
    console.log(`${cfg.label}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
  }
}

// Larger thresholds to explore
for (const thresh of [0.006, 0.008, 0.01]) {
  const signals = [];
  for (let i = 21; i < candles.length - 1; i++) {
    const hour = new Date(times[i]).getUTCHours();
    if (!GOOD_HOURS.has(hour)) continue;
    if (!vwap[i] || !bb20_22[i]) continue;
    const dev = (closes[i] - vwap[i]) / vwap[i];
    if (dev >= thresh) {
      const win = candles[i + 1].close < candles[i + 1].open;
      signals.push({ win });
    } else if (dev <= -thresh) {
      const win = candles[i + 1].close > candles[i + 1].open;
      signals.push({ win });
    }
  }
  if (signals.length < 10) { console.log(`VWAP dev>${thresh*100}% GoodH noBB: T=${signals.length} (too few)`); continue; }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
  console.log(`VWAP dev>${thresh*100}% GoodH noBB: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}]`);
}
