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

function calcCCI(highs, lows, closes, period) {
  const cci = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const typical = [];
    for (let j = i - period + 1; j <= i; j++) {
      typical.push((highs[j] + lows[j] + closes[j]) / 3);
    }
    const mean = typical.reduce((a, b) => a + b, 0) / period;
    const mad = typical.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    cci[i] = mad === 0 ? 0 : (typical[typical.length - 1] - mean) / (0.015 * mad);
  }
  return cci;
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
const highs = candles.map(c => c.high);
const lows = candles.map(c => c.low);
const closes = candles.map(c => c.close);
const times = candles.map(c => c.open_time);

const GOOD_HOURS = new Set([10, 11, 12, 21]);

const configs = [
  { cciPeriod: 14, cciThresh: 100, bbPeriod: 20, bbMult: 2.2, goodH: true },
  { cciPeriod: 14, cciThresh: 120, bbPeriod: 20, bbMult: 2.2, goodH: true },
  { cciPeriod: 14, cciThresh: 150, bbPeriod: 20, bbMult: 2.2, goodH: true },
  { cciPeriod: 20, cciThresh: 100, bbPeriod: 20, bbMult: 2.2, goodH: true },
  { cciPeriod: 20, cciThresh: 120, bbPeriod: 20, bbMult: 2.2, goodH: true },
  { cciPeriod: 14, cciThresh: 100, bbPeriod: 20, bbMult: 2.2, goodH: false },
  { cciPeriod: 14, cciThresh: 120, bbPeriod: 20, bbMult: 2.2, goodH: false },
  { cciPeriod: 14, cciThresh: 100, bbPeriod: 20, bbMult: 2.0, goodH: true },
  { cciPeriod: 10, cciThresh: 100, bbPeriod: 20, bbMult: 2.2, goodH: true },
  { cciPeriod: 10, cciThresh: 120, bbPeriod: 20, bbMult: 2.2, goodH: true },
];

console.log('=== ETH CCI Extremes (ETH/5m) ===\n');

for (const cfg of configs) {
  const bb = calcBB(closes, cfg.bbPeriod, cfg.bbMult);
  const cci = calcCCI(highs, lows, closes, cfg.cciPeriod);

  const signals = [];
  const warmup = Math.max(cfg.cciPeriod, cfg.bbPeriod) + 1;

  for (let i = warmup; i < candles.length - 1; i++) {
    const hour = new Date(times[i]).getUTCHours();
    if (cfg.goodH && !GOOD_HOURS.has(hour)) continue;
    if (!bb[i] || cci[i] === null) continue;

    // BEAR: CCI overbought + above BB upper
    if (cci[i] >= cfg.cciThresh && closes[i] >= bb[i].upper) {
      const win = candles[i + 1].close < candles[i + 1].open;
      signals.push({ win });
    }
    // BULL: CCI oversold + below BB lower
    if (cci[i] <= -cfg.cciThresh && closes[i] <= bb[i].lower) {
      const win = candles[i + 1].close > candles[i + 1].open;
      signals.push({ win });
    }
  }

  if (signals.length < 20) {
    console.log(`CCI(${cfg.cciPeriod})>${cfg.cciThresh} BB(${cfg.bbPeriod},${cfg.bbMult}) GoodH=${cfg.goodH}: T=${signals.length} (too few)`);
    continue;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
  const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
  console.log(`CCI(${cfg.cciPeriod})>${cfg.cciThresh} BB(${cfg.bbPeriod},${cfg.bbMult}) GoodH=${cfg.goodH}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
}
