'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

function getCandles(symbol, timeframe) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(symbol, timeframe);
}

function calcEMA(closes, period) {
  const ema = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);
  ema[period - 1] = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcATR(highs, lows, closes, period) {
  const atr = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
  }
  atr[period] = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    atr[i] = (atr[i-1] * (period - 1) + tr) / period;
  }
  return atr;
}

function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + Math.max(d,0)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(-d,0)) / period;
    rsi[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }
  return rsi;
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
const rsi14 = calcRSI(closes, 14);

const configs = [
  { emaPeriod: 20, atrPeriod: 10, atrMult: 1.5, rsiThresh: 60, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 1.5, rsiThresh: 65, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 1.5, rsiThresh: 70, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 2.0, rsiThresh: 60, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 2.0, rsiThresh: 65, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 2.0, rsiThresh: 70, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 2.5, rsiThresh: 65, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 2.5, rsiThresh: 70, goodH: true },
  { emaPeriod: 20, atrPeriod: 10, atrMult: 2.0, rsiThresh: 65, goodH: false },
  { emaPeriod: 20, atrPeriod: 14, atrMult: 2.0, rsiThresh: 65, goodH: true },
];

console.log('=== ETH Keltner Extreme + RSI (ETH/5m) ===\n');

for (const cfg of configs) {
  const ema = calcEMA(closes, cfg.emaPeriod);
  const atr = calcATR(highs, lows, closes, cfg.atrPeriod);
  const warmup = Math.max(cfg.emaPeriod, cfg.atrPeriod, 14) + 1;

  const signals = [];
  for (let i = warmup; i < candles.length - 1; i++) {
    const hour = new Date(times[i]).getUTCHours();
    if (cfg.goodH && !GOOD_HOURS.has(hour)) continue;
    if (!ema[i] || !atr[i] || rsi14[i] === null) continue;

    const kUpper = ema[i] + cfg.atrMult * atr[i];
    const kLower = ema[i] - cfg.atrMult * atr[i];

    // BEAR: above Keltner upper + RSI overbought
    if (closes[i] >= kUpper && rsi14[i] >= cfg.rsiThresh) {
      const win = candles[i + 1].close < candles[i + 1].open;
      signals.push({ win });
    }
    // BULL: below Keltner lower + RSI oversold
    if (closes[i] <= kLower && rsi14[i] <= (100 - cfg.rsiThresh)) {
      const win = candles[i + 1].close > candles[i + 1].open;
      signals.push({ win });
    }
  }

  if (signals.length < 20) {
    console.log(`EMA(${cfg.emaPeriod})+ATR(${cfg.atrPeriod})x${cfg.atrMult} RSI>=${cfg.rsiThresh} GoodH=${cfg.goodH}: T=${signals.length} (too few)`);
    continue;
  }
  const wf = walkForward(signals);
  const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
  const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
  console.log(`EMA(${cfg.emaPeriod})+ATR(${cfg.atrPeriod})x${cfg.atrMult} RSI>=${cfg.rsiThresh} GoodH=${cfg.goodH}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
}
