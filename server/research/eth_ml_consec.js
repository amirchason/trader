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
const times = candles.map(c => c.open_time);

const GOOD_HOURS = new Set([10, 11, 12, 21]);

function getExactStreak(idx) {
  const dir = closes[idx] > opens[idx] ? 1 : -1;
  let streak = 0;
  for (let i = idx; i >= 0; i--) {
    const d = closes[i] > opens[i] ? 1 : -1;
    if (d === dir) streak++;
    else break;
  }
  return { streak, dir };
}

// Check specific candle sequence pattern (last N candles)
function matchPattern(idx, pattern) {
  // pattern: array of 'G' or 'R' from oldest to newest, idx = newest
  for (let j = 0; j < pattern.length; j++) {
    const ci = idx - (pattern.length - 1 - j);
    if (ci < 0) return false;
    const isGreen = closes[ci] > opens[ci];
    if (pattern[j] === 'G' && !isGreen) return false;
    if (pattern[j] === 'R' && isGreen) return false;
  }
  return true;
}

console.log('=== ETH Consecutive Candle Counts + Patterns (ETH/5m) ===\n');

const bbConfigs = [
  { period: 20, mult: 2.2 },
  { period: 20, mult: 2.0 },
];

for (const bbc of bbConfigs) {
  const bb = calcBB(closes, bbc.period, bbc.mult);
  const warmup = bbc.period + 5;

  // Test exact streak counts
  for (const minStreak of [3, 4, 5, 6]) {
    for (const maxStreak of [minStreak, minStreak + 2, 99]) {
      for (const goodH of [true, false]) {
        const signals = [];
        for (let i = warmup; i < candles.length - 1; i++) {
          const hour = new Date(times[i]).getUTCHours();
          if (goodH && !GOOD_HOURS.has(hour)) continue;
          if (!bb[i]) continue;

          const { streak, dir } = getExactStreak(i);
          if (streak < minStreak || streak > maxStreak) continue;

          if (dir === 1 && closes[i] >= bb[i].upper) {
            const win = candles[i + 1].close < candles[i + 1].open;
            signals.push({ win });
          } else if (dir === -1 && closes[i] <= bb[i].lower) {
            const win = candles[i + 1].close > candles[i + 1].open;
            signals.push({ win });
          }
        }
        if (signals.length < 20) continue;
        const wf = walkForward(signals);
        const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
        const streakLabel = maxStreak === minStreak ? `s=${minStreak}` : maxStreak === 99 ? `s≥${minStreak}` : `s=${minStreak}-${maxStreak}`;
        const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
        if (pass || wf.avgWR >= 60) {
          console.log(`BB(${bbc.period},${bbc.mult}) ${streakLabel} GoodH=${goodH}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
        }
      }
    }
  }

  // GGGR pattern: 3 greens then 1 red, expect further reversal (reversion continuing)
  // Actually test: after GGGR (streak broken), what's the WR of next bar?
  console.log(`\n--- Mixed sequence patterns BB(${bbc.period},${bbc.mult}) ---`);
  const patterns = [
    { seq: ['G','G','G','R'], dir: -1, label: 'GGGR→expect more RED (continuation)' },
    { seq: ['R','R','R','G'], dir: 1, label: 'RRRG→expect more GREEN (continuation)' },
    { seq: ['G','G','R','G'], dir: 1, label: 'GGRG→at BB upper, BEAR (pullback failed)' },
    { seq: ['R','R','G','R'], dir: -1, label: 'RRGR→at BB lower, BULL' },
    { seq: ['G','G','G','G','R'], dir: -1, label: 'GGGGR→more red' },
    { seq: ['G','G','R','R'], dir: -1, label: 'GGRR→already reversed, BEAR' },
  ];

  for (const p of patterns) {
    for (const goodH of [true, false]) {
      const signals = [];
      for (let i = p.seq.length - 1 + warmup; i < candles.length - 1; i++) {
        const hour = new Date(times[i]).getUTCHours();
        if (goodH && !GOOD_HOURS.has(hour)) continue;
        if (!bb[i]) continue;
        if (!matchPattern(i, p.seq)) continue;

        // For BEAR patterns: check at BB upper
        if (p.dir === -1 && closes[i] >= bb[i].upper) {
          const win = candles[i + 1].close < candles[i + 1].open;
          signals.push({ win });
        } else if (p.dir === 1 && closes[i] <= bb[i].lower) {
          const win = candles[i + 1].close > candles[i + 1].open;
          signals.push({ win });
        }
      }
      if (signals.length < 15) continue;
      const wf = walkForward(signals);
      const foldStr = wf.folds.map(f => `${(f.wr * 100).toFixed(1)}%[${f.n}]`).join('/');
      const pass = wf.avgWR >= 65 && wf.sigma <= 8 && wf.total >= 50;
      if (pass || wf.avgWR >= 62) {
        console.log(`${p.label} GoodH=${goodH}: WR=${wf.avgWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${foldStr}] ${pass ? '*** PASS ***' : ''}`);
      }
    }
  }
}
