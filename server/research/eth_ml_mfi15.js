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

function calcMFI(highs, lows, closes, volumes, period) {
  const mfi = new Array(closes.length).fill(null);
  const tp = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const mf = tp.map((t, i) => t * volumes[i]);

  for (let i = period; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (tp[j] > tp[j - 1]) posFlow += mf[j];
      else negFlow += mf[j];
    }
    if (negFlow === 0) mfi[i] = 100;
    else mfi[i] = 100 - 100 / (1 + posFlow / negFlow);
  }
  return mfi;
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

function getStreak(opens, closes, idx) {
  const dir = closes[idx] > opens[idx] ? 1 : -1;
  let streak = 0;
  for (let i = idx; i >= 0; i--) {
    const d = closes[i] > opens[i] ? 1 : -1;
    if (d === dir) streak++;
    else break;
  }
  return { streak, dir };
}

// Test ETH/15m with MFI (like BTC/15m which got 70.4%)
const candles15 = getCandles('ETH', '15m');
const opens15 = candles15.map(c => c.open);
const highs15 = candles15.map(c => c.high);
const lows15 = candles15.map(c => c.low);
const closes15 = candles15.map(c => c.close);
const vols15 = candles15.map(c => c.volume);
const times15 = candles15.map(c => c.open_time);

const GOOD_HOURS = new Set([10, 11, 12, 21]);

const configs = [
  { mfiPeriod: 10, mfiThresh: 80, bbPeriod: 15, bbMult: 2.2, minStreak: 2, goodH: true },
  { mfiPeriod: 10, mfiThresh: 75, bbPeriod: 15, bbMult: 2.2, minStreak: 2, goodH: true },
  { mfiPeriod: 10, mfiThresh: 85, bbPeriod: 15, bbMult: 2.2, minStreak: 2, goodH: true },
  { mfiPeriod: 10, mfiThresh: 80, bbPeriod: 20, bbMult: 2.0, minStreak: 2, goodH: true },
  { mfiPeriod: 10, mfiThresh: 80, bbPeriod: 20, bbMult: 2.2, minStreak: 2, goodH: true },
  { mfiPeriod: 14, mfiThresh: 80, bbPeriod: 15, bbMult: 2.2, minStreak: 2, goodH: true },
  { mfiPeriod: 14, mfiThresh: 75, bbPeriod: 15, bbMult: 2.2, minStreak: 2, goodH: true },
  { mfiPeriod: 10, mfiThresh: 80, bbPeriod: 15, bbMult: 2.2, minStreak: 1, goodH: true },
  { mfiPeriod: 10, mfiThresh: 80, bbPeriod: 15, bbMult: 2.2, minStreak: 2, goodH: false },
  { mfiPeriod: 10, mfiThresh: 80, bbPeriod: 15, bbMult: 2.0, minStreak: 2, goodH: true },
  { mfiPeriod: 10, mfiThresh: 80, bbPeriod: 15, bbMult: 2.2, minStreak: 3, goodH: true },
];

console.log('=== ETH/15m MFI Exhaustion ===\n');

for (const cfg of configs) {
  const bb = calcBB(closes15, cfg.bbPeriod, cfg.bbMult);
  const mfi = calcMFI(highs15, lows15, closes15, vols15, cfg.mfiPeriod);
  const warmup = Math.max(cfg.mfiPeriod, cfg.bbPeriod) + 2;

  const signals = [];
  for (let i = warmup; i < candles15.length - 1; i++) {
    const hour = new Date(times15[i]).getUTCHours();
    if (cfg.goodH && !GOOD_HOURS.has(hour)) continue;
    if (!bb[i] || mfi[i] === null) continue;

    const { streak, dir } = getStreak(opens15, closes15, i);
    if (streak < cfg.minStreak) continue;

    if (dir === 1 && mfi[i] >= cfg.mfiThresh && closes15[i] >= bb[i].upper) {
      const win = candles15[i + 1].close < candles15[i + 1].open;
      signals.push({ win });
    } else if (dir === -1 && mfi[i] <= (100 - cfg.mfiThresh) && closes15[i] <= bb[i].lower) {
      const win = candles15[i + 1].close > candles15[i + 1].open;
      signals.push({ win });
    }
  }

  if (signals.length < 15) {
    console.log(`MFI(${cfg.mfiPeriod})>${cfg.mfiThresh} BB(${cfg.bbPeriod},${cfg.bbMult}) s≥${cfg.minStreak} GoodH=${cfg.goodH}: T=${signals.length} (too few)`);
    continue;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
  const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
  console.log(`MFI(${cfg.mfiPeriod})>${cfg.mfiThresh} BB(${cfg.bbPeriod},${cfg.bbMult}) s≥${cfg.minStreak} GoodH=${cfg.goodH}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
}
