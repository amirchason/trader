'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function getCandles(symbol, tf) {
  return db.prepare(
    'SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time'
  ).all(symbol, tf).map(r => ({
    openTime: r.open_time, closeTime: r.open_time + (tf === '5m' ? 300000 : 900000) - 1,
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    quoteVolume: 0, trades: 0,
  }));
}

function makeSynth15m(c5m) {
  const out = [];
  const aligned = c5m.length - (c5m.length % 3);
  for (let i = 0; i < aligned; i += 3) {
    const g = c5m.slice(i, i + 3);
    out.push({
      openTime: g[0].openTime, closeTime: g[2].closeTime,
      open: g[0].open, high: Math.max(...g.map(c => c.high)),
      low: Math.min(...g.map(c => c.low)), close: g[2].close,
      volume: g.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

function calcBB(candles, period, mult) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const mean = slice.reduce((s, c) => s + c.close, 0) / period;
  const std = Math.sqrt(slice.reduce((s, c) => s + (c.close - mean) ** 2, 0) / period);
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std };
}

function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function calcMFI(candles, period) {
  if (candles.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const rawMF = tp * candles[i].volume;
    if (tp >= prevTp) posFlow += rawMF; else negFlow += rawMF;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function getStreak(candles) {
  let s = 0;
  for (let j = candles.length - 1; j >= Math.max(0, candles.length - 7); j--) {
    const c = candles[j];
    if (c.close > c.open) { if (s < 0) break; s++; }
    else if (c.close < c.open) { if (s > 0) break; s--; }
    else break;
  }
  return s;
}

function computeATRPct(candles, lookback) {
  const win = candles.slice(-lookback);
  const atrs = [];
  for (let i = 1; i < win.length; i++) {
    const p = win[i-1], c = win[i];
    atrs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (atrs.length < 20) return { current: 0, pct: 50 };
  const current = atrs[atrs.length - 1];
  const sorted = [...atrs].sort((a, b) => a - b);
  const rank = sorted.filter(v => v <= current).length;
  return { current, pct: (rank / sorted.length) * 100 };
}

// ETH-I: h=[7,12,20]+body>=0.3%+RSI7>65+BB(15,2.2)+s>=2
function sigEthI(candles, idx) {
  if (idx < 20) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (![7, 12, 20].includes(hour)) return null;
  const bb = calcBB(c, 15, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const bodyPct = last.open > 0 ? Math.abs(last.close - last.open) / last.open * 100 : 0;
  if (bodyPct < 0.3) return null;
  const rsi7 = calcRSI(c, 7);
  if (rsi7 === null) return null;
  if (isBear && rsi7 <= 65) return null;
  if (isBull && rsi7 >= 35) return null;
  const streak = getStreak(c);
  if (isBear && streak < 2) return null;
  if (isBull && streak > -2) return null;
  return isBear ? 'bear' : 'bull';
}

// ETH-K: h=[5,12,20]+MFI>70+BB(15,2.2)+s>=2
function sigEthK(candles, idx) {
  if (idx < 20) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (![5, 12, 20].includes(hour)) return null;
  const bb = calcBB(c, 15, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const mfi = calcMFI(c, 10);
  if (mfi === null) return null;
  if (isBear && mfi <= 70) return null;
  if (isBull && mfi >= 30) return null;
  const streak = getStreak(c);
  if (isBear && streak < 2) return null;
  if (isBull && streak > -2) return null;
  return isBear ? 'bear' : 'bull';
}

// ETH-L: h=[5,12,20]+bodyATR>=0.5+RSI7>70+BB(15,2.2)+s>=2
function sigEthL(candles, idx) {
  if (idx < 20) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (![5, 12, 20].includes(hour)) return null;
  const bb = calcBB(c, 15, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const rsi7 = calcRSI(c, 7);
  if (rsi7 === null) return null;
  if (isBear && rsi7 <= 70) return null;
  if (isBull && rsi7 >= 30) return null;
  const prev = c[c.length - 2];
  const atr = Math.max(last.high - last.low, Math.abs(last.high - prev.close), Math.abs(last.low - prev.close));
  const body = Math.abs(last.close - last.open);
  if (atr === 0 || body / atr < 0.5) return null;
  const streak = getStreak(c);
  if (isBear && streak < 2) return null;
  if (isBull && streak > -2) return null;
  return isBear ? 'bear' : 'bull';
}

// ETH-NEW: GoodH+RSI14>70+BB(20,2.2) no body, no streak
function sigEthRsi70BB(candles, idx) {
  if (idx < 22) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (![10, 11, 12, 21].includes(hour)) return null;
  const bb = calcBB(c, 20, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const rsi14 = calcRSI(c, 14);
  if (rsi14 === null) return null;
  if (isBear && rsi14 <= 70) return null;
  if (isBull && rsi14 >= 30) return null;
  return isBear ? 'bear' : 'bull';
}

const XRP_GOOD = [6, 9, 12, 18];

// XRP-A: LowATR33%+RSI7>65+BB(15,2.2)+GoodH+s>=1
function sigXrpA(candles, idx) {
  if (idx < 50) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (!XRP_GOOD.includes(hour)) return null;
  const bb = calcBB(c, 15, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const rsi7 = calcRSI(c, 7);
  if (rsi7 === null) return null;
  if (isBear && rsi7 <= 65) return null;
  if (isBull && rsi7 >= 35) return null;
  const streak = getStreak(c);
  if (isBear && streak < 1) return null;
  if (isBull && streak > -1) return null;
  const atrData = computeATRPct(c, 100);
  if (atrData.pct > 33) return null;
  return isBear ? 'bear' : 'bull';
}

// XRP-B: LowATR33%+BB(25,2.2)+GoodH+s>=2
function sigXrpB(candles, idx) {
  if (idx < 55) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (!XRP_GOOD.includes(hour)) return null;
  const bb = calcBB(c, 25, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const streak = getStreak(c);
  if (isBear && streak < 2) return null;
  if (isBull && streak > -2) return null;
  const atrData = computeATRPct(c, 100);
  if (atrData.pct > 33) return null;
  return isBear ? 'bear' : 'bull';
}

// XRP-C: LowATR40%+MFI>65+BB(25,2.2)+GoodH+s>=1
function sigXrpC(candles, idx) {
  if (idx < 55) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (!XRP_GOOD.includes(hour)) return null;
  const bb = calcBB(c, 25, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const mfi = calcMFI(c, 10);
  if (mfi === null) return null;
  if (isBear && mfi <= 65) return null;
  if (isBull && mfi >= 35) return null;
  const streak = getStreak(c);
  if (isBear && streak < 1) return null;
  if (isBull && streak > -1) return null;
  const atrData = computeATRPct(c, 100);
  if (atrData.pct > 40) return null;
  return isBear ? 'bear' : 'bull';
}

// XRP-D: MFI>75+BB(25,2.2)+GoodH+s>=1
function sigXrpD(candles, idx) {
  if (idx < 55) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (!XRP_GOOD.includes(hour)) return null;
  const bb = calcBB(c, 25, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const mfi = calcMFI(c, 10);
  if (mfi === null) return null;
  if (isBear && mfi <= 75) return null;
  if (isBull && mfi >= 25) return null;
  const streak = getStreak(c);
  if (isBear && streak < 1) return null;
  if (isBull && streak > -1) return null;
  return isBear ? 'bear' : 'bull';
}

// XRP-E: BB(15,2.2)+GoodH+s>=1
function sigXrpE(candles, idx) {
  if (idx < 30) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (!XRP_GOOD.includes(hour)) return null;
  const bb = calcBB(c, 15, 2.2);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper;
  const isBull = p < bb.lower;
  if (!isBear && !isBull) return null;
  const streak = getStreak(c);
  if (isBear && streak < 1) return null;
  if (isBull && streak > -1) return null;
  return isBear ? 'bear' : 'bull';
}

function getOutcome(candles, idx) {
  if (idx + 1 >= candles.length) return null;
  const entry = candles[idx].close;
  const exit = candles[idx + 1].close;
  return exit < entry ? 'bear' : exit > entry ? 'bull' : null;
}

function walkForward(candles, sigFn, folds) {
  const signals = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const sig = sigFn(candles, i);
    if (!sig) continue;
    const outcome = getOutcome(candles, i);
    if (!outcome) continue;
    signals.push({ sig, outcome, correct: sig === outcome });
  }
  if (signals.length < 10) return null;
  const foldSize = Math.floor(signals.length / folds);
  const foldWRs = [];
  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = f === folds - 1 ? signals.length : (f + 1) * foldSize;
    const fold = signals.slice(start, end);
    if (fold.length === 0) continue;
    foldWRs.push(fold.filter(s => s.correct).length / fold.length * 100);
  }
  const wfMean = foldWRs.reduce((a, b) => a + b, 0) / foldWRs.length;
  const wfSigma = Math.sqrt(foldWRs.reduce((s, v) => s + (v - wfMean) ** 2, 0) / foldWRs.length);
  const totalWR = signals.filter(s => s.correct).length / signals.length * 100;
  return { wr: totalWR, wf: wfMean, sigma: wfSigma, T: signals.length, folds: foldWRs.map(v => Math.round(v * 10) / 10) };
}

const eth5m = getCandles('ETH', '5m');
const xrp5m = getCandles('XRP', '5m');
const ethSynth = makeSynth15m(eth5m);
const xrpSynth = makeSynth15m(xrp5m);

console.log('='.repeat(60));
console.log('SESSION 6 VALIDATION — ETH/15m Wave3 + XRP Strategies');
console.log('ETH 5m: ' + eth5m.length + '  ETH synth-15m: ' + ethSynth.length);
console.log('XRP 5m: ' + xrp5m.length + '  XRP synth-15m: ' + xrpSynth.length);
console.log('='.repeat(60));

const configs = [
  { name: 'ETH-I: h=[7,12,20]+body>=0.3%+RSI7>65+BB(15,2.2)+s>=2', fn: sigEthI, candles: ethSynth, expected: '74.1% s=0.0%' },
  { name: 'ETH-K: h=[5,12,20]+MFI>70+BB(15,2.2)+s>=2',             fn: sigEthK, candles: ethSynth, expected: '76.7% s=1.8%' },
  { name: 'ETH-L: h=[5,12,20]+bodyATR>=0.5+RSI7>70+BB(15,2.2)+s>=2',fn: sigEthL, candles: ethSynth, expected: '77.2% s=3.2%' },
  { name: 'ETH-NEW: GoodH+RSI14>70+BB(20,2.2) no body/streak',     fn: sigEthRsi70BB, candles: eth5m, expected: '71.8% s=2.8%' },
  { name: 'XRP-A: LowATR33+RSI7>65+BB(15,2.2)+GoodH+s>=1',        fn: sigXrpA, candles: xrpSynth, expected: '72.0% s=0.0%' },
  { name: 'XRP-B: LowATR33+BB(25,2.2)+GoodH+s>=2',                 fn: sigXrpB, candles: xrpSynth, expected: '75.4% s=1.1%' },
  { name: 'XRP-C: LowATR40+MFI>65+BB(25,2.2)+GoodH+s>=1',         fn: sigXrpC, candles: xrpSynth, expected: '76.4% s=2.8%' },
  { name: 'XRP-D: MFI>75+BB(25,2.2)+GoodH+s>=1',                   fn: sigXrpD, candles: xrpSynth, expected: '68.1% s=0.4%' },
  { name: 'XRP-E: BB(15,2.2)+GoodH+s>=1 high-vol',                  fn: sigXrpE, candles: xrpSynth, expected: '67.7% s=1.6%' },
];

console.log('\n--- 3-FOLD Walk-Forward ---');
const validated = [];
for (const cfg of configs) {
  const r = walkForward(cfg.candles, cfg.fn, 3);
  if (!r) { console.log('  ' + cfg.name + '  SKIP: T<10'); continue; }
  const tag = r.wf >= 68 && r.sigma <= 12 ? '*** IMPLEMENT' : r.wf >= 63 ? '** VALIDATE' : '* MARGINAL';
  console.log('  ' + cfg.name);
  console.log('    WF=' + r.wf.toFixed(1) + '% s=' + r.sigma.toFixed(1) + '% T=' + r.T + ' [' + r.folds.join('/') + '] ' + tag);
  if (r.wf >= 63) validated.push({ name: cfg.name, fn: cfg.fn, candles: cfg.candles, result: r });
}

console.log('\n--- 5-FOLD for top candidates ---');
for (const cfg of validated.filter(c => c.result.wf >= 66)) {
  const r5 = walkForward(cfg.candles, cfg.fn, 5);
  if (!r5) continue;
  const go = r5.wf >= 65 && r5.sigma <= 12 ? 'IMPLEMENT' : r5.wf >= 60 ? 'BORDERLINE' : 'SKIP';
  console.log('  ' + cfg.name.slice(0,55).padEnd(55) + '  WF=' + r5.wf.toFixed(1) + '% s=' + r5.sigma.toFixed(1) + '% T=' + r5.T + ' [' + r5.folds.join('/') + '] ' + go);
}

console.log('\nDone.');
