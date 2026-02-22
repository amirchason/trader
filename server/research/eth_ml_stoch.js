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

function calcStoch(highs, lows, closes, period) {
  const k = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - period + 1, i + 1));
    const ll = Math.min(...lows.slice(i - period + 1, i + 1));
    k[i] = hh === ll ? 50 : 100 * (closes[i] - ll) / (hh - ll);
  }
  return k;
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
const times = candles.map(c => c.open_time);

const GOOD_HOURS = new Set([10, 11, 12, 21]);

const configs = [
  { stochPeriod: 10, kThresh: 75, bbPeriod: 20, bbMult: 2.2 },
  { stochPeriod: 10, kThresh: 80, bbPeriod: 20, bbMult: 2.2 },
  { stochPeriod: 10, kThresh: 85, bbPeriod: 20, bbMult: 2.2 },
  { stochPeriod: 14, kThresh: 75, bbPeriod: 20, bbMult: 2.2 },
  { stochPeriod: 14, kThresh: 80, bbPeriod: 20, bbMult: 2.2 },
  { stochPeriod: 14, kThresh: 85, bbPeriod: 20, bbMult: 2.2 },
  { stochPeriod: 14, kThresh: 80, bbPeriod: 20, bbMult: 2.0 },
  { stochPeriod: 20, kThresh: 80, bbPeriod: 20, bbMult: 2.2 },
];

console.log('=== ETH Stochastic Exhaustion ===\n');

for (const cfg of configs) {
  const bb = calcBB(closes, cfg.bbPeriod, cfg.bbMult);
  const stochK = calcStoch(highs, lows, closes, cfg.stochPeriod);

  const signals = [];
  const warmup = Math.max(cfg.stochPeriod, cfg.bbPeriod) + 1;
  for (let i = warmup; i < candles.length - 1; i++) {
    const hour = new Date(times[i]).getUTCHours();
    if (!GOOD_HOURS.has(hour)) continue;
    if (!bb[i]) continue;
    if (stochK[i] === null) continue;

    // BEAR: stoch overbought + price above BB upper
    if (stochK[i] >= cfg.kThresh && closes[i] >= bb[i].upper) {
      const win = closes[i + 1] < opens[i + 1]; // next candle is red
      signals.push({ win, dir: 'BEAR' });
    }
    // BULL: stoch oversold + price below BB lower
    if (stochK[i] <= (100 - cfg.kThresh) && closes[i] <= bb[i].lower) {
      const win = closes[i + 1] > opens[i + 1]; // next candle is green
      signals.push({ win, dir: 'BULL' });
    }
  }

  if (signals.length < 30) {
    console.log(`stochP=${cfg.stochPeriod} K>=${cfg.kThresh} BB(${cfg.bbPeriod},${cfg.bbMult}): T=${signals.length} (too few)`);
    continue;
  }

  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
  const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.folds.every(f => f.n >= 30);
  console.log(`stochP=${cfg.stochPeriod} K>=${cfg.kThresh} BB(${cfg.bbPeriod},${cfg.bbMult}): WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
}
