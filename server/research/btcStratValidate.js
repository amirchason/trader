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
  return 100 - 100 / (1 + (gains / period) / (losses / period));
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
  for (let j = candles.length - 1; j >= Math.max(0, candles.length - 8); j--) {
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
  return { current, pct: (sorted.filter(v => v <= current).length / sorted.length) * 100 };
}

// BTC good hours (from btcNewSearch.js hour sweep): [1, 12, 13, 16, 20]
const BTC_GOOD = [1, 12, 13, 16, 20];
const BTC_BEST = [1, 12, 20]; // top 3 only

function makeSignal(candles, idx, hourFilter, bbPeriod, bbMult, minStreak, extraFn) {
  if (idx < bbPeriod + 5) return null;
  const c = candles.slice(0, idx + 1);
  const last = c[c.length - 1];
  const hour = new Date(last.closeTime).getUTCHours();
  if (!hourFilter.includes(hour)) return null;
  const bb = calcBB(c, bbPeriod, bbMult);
  if (!bb) return null;
  const p = last.close;
  const isBear = p > bb.upper && last.close > last.open;
  const isBull = p < bb.lower && last.close < last.open;
  if (!isBear && !isBull) return null;
  if (extraFn && !extraFn(c, isBear, isBull)) return null;
  const streak = getStreak(c);
  if (isBear && streak < minStreak) return null;
  if (isBull && streak > -minStreak) return null;
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
  return {
    wr: signals.filter(s => s.correct).length / signals.length * 100,
    wf: wfMean, sigma: wfSigma, T: signals.length,
    folds: foldWRs.map(v => Math.round(v * 10) / 10),
  };
}

const btc5m = getCandles('BTC', '5m');
const btcSynth = makeSynth15m(btc5m);

console.log('='.repeat(65));
console.log('BTC STRATEGY VALIDATION — Synth-15m with correct good hours');
console.log('BTC 5m: ' + btc5m.length + '  BTC synth-15m: ' + btcSynth.length);
console.log('BTC good hours: [1, 12, 13, 16, 20] | Best 3: [1, 12, 20]');
console.log('='.repeat(65));

const configs = [
  // --- Basic BB sweeps with BTC good hours ---
  { name: 'BTC-A1: GoodH[1,12,20]+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 2, null) },
  { name: 'BTC-A2: GoodH[1,12,13,16,20]+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_GOOD, 15, 2.2, 2, null) },
  { name: 'BTC-A3: GoodH[1,12,20]+BB(20,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 20, 2.2, 2, null) },
  { name: 'BTC-A4: GoodH[1,12,20]+BB(15,2.0)+s>=1',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.0, 1, null) },
  { name: 'BTC-A5: GoodH[1,12,20]+BB(20,2.0)+s>=1',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 20, 2.0, 1, null) },
  // --- With RSI ---
  { name: 'BTC-B1: GoodH[1,12,20]+RSI7>65+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 2,
      (cs, ib, ibull) => { const r = calcRSI(cs, 7); return r!==null && ((ib && r>65)||(ibull && r<35)); }) },
  { name: 'BTC-B2: GoodH[1,12,20]+RSI14>60+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 2,
      (cs, ib, ibull) => { const r = calcRSI(cs, 14); return r!==null && ((ib && r>60)||(ibull && r<40)); }) },
  { name: 'BTC-B3: GoodH[1,12,13]+RSI7>65+BB(15,2.2)+s>=1',
    fn: (c,i) => makeSignal(c,i, [1,12,13], 15, 2.2, 1,
      (cs, ib, ibull) => { const r = calcRSI(cs, 7); return r!==null && ((ib && r>65)||(ibull && r<35)); }) },
  // --- With MFI ---
  { name: 'BTC-C1: GoodH[1,12,20]+MFI>70+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 2,
      (cs, ib, ibull) => { const m = calcMFI(cs, 10); return m!==null && ((ib && m>70)||(ibull && m<30)); }) },
  { name: 'BTC-C2: GoodH[1,12,20]+MFI>75+BB(20,2.2)+s>=1',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 20, 2.2, 1,
      (cs, ib, ibull) => { const m = calcMFI(cs, 10); return m!==null && ((ib && m>75)||(ibull && m<25)); }) },
  { name: 'BTC-C3: GoodH[1,12,13,16,20]+MFI>70+BB(15,2.2)+s>=1',
    fn: (c,i) => makeSignal(c,i, BTC_GOOD, 15, 2.2, 1,
      (cs, ib, ibull) => { const m = calcMFI(cs, 10); return m!==null && ((ib && m>70)||(ibull && m<30)); }) },
  // --- With body filter ---
  { name: 'BTC-D1: GoodH[1,12,20]+body>=0.3%+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 2,
      (cs, ib, ibull) => { const last=cs[cs.length-1]; return last.open>0 && Math.abs(last.close-last.open)/last.open*100>=0.3; }) },
  { name: 'BTC-D2: GoodH[1,12,20]+body>=0.3%+RSI7>65+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 2,
      (cs, ib, ibull) => {
        const last=cs[cs.length-1]; const bodyOk = last.open>0 && Math.abs(last.close-last.open)/last.open*100>=0.3;
        const r = calcRSI(cs, 7); const rsiOk = r!==null && ((ib && r>65)||(ibull && r<35));
        return bodyOk && rsiOk;
      }) },
  { name: 'BTC-D3: GoodH[1,12,20]+body/ATR>=0.5+RSI7>65+BB(15,2.2)+s>=2',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 2,
      (cs, ib, ibull) => {
        const last=cs[cs.length-1], prev=cs[cs.length-2];
        if (!prev) return false;
        const atr = Math.max(last.high-last.low, Math.abs(last.high-prev.close), Math.abs(last.low-prev.close));
        const bodyATR = atr>0 ? Math.abs(last.close-last.open)/atr : 0;
        const r = calcRSI(cs, 7); const rsiOk = r!==null && ((ib && r>65)||(ibull && r<35));
        return bodyATR>=0.5 && rsiOk;
      }) },
  // --- With ATR regime filter ---
  { name: 'BTC-E1: LowATR33+GoodH[1,12,20]+BB(15,2.2)+s>=1',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 1,
      (cs) => { const atr = computeATRPct(cs, 100); return atr.pct <= 33; }) },
  { name: 'BTC-E2: LowATR33+GoodH[1,12,20]+MFI>65+BB(15,2.2)+s>=1',
    fn: (c,i) => makeSignal(c,i, BTC_BEST, 15, 2.2, 1,
      (cs, ib, ibull) => {
        const atr = computeATRPct(cs, 100); if (atr.pct > 33) return false;
        const m = calcMFI(cs, 10); return m!==null && ((ib && m>65)||(ibull && m<35));
      }) },
  // --- Saturday special ---
  { name: 'BTC-F1: Saturday+BB(15,2.2)+s>=1',
    fn: (c,i) => {
      if (i < 20) return null;
      const cs = c.slice(0, i+1);
      const last = cs[cs.length-1];
      if (new Date(last.closeTime).getUTCDay() !== 6) return null; // Saturday
      const bb = calcBB(cs, 15, 2.2); if (!bb) return null;
      const p = last.close;
      const isBear = p > bb.upper && last.close > last.open;
      const isBull = p < bb.lower && last.close < last.open;
      if (!isBear && !isBull) return null;
      const s = getStreak(cs);
      if (isBear && s < 1) return null;
      if (isBull && s > -1) return null;
      return isBear ? 'bear' : 'bull';
    }},
  { name: 'BTC-F2: Sat+GoodH[1,12,20]+BB(15,2.2)+s>=1',
    fn: (c,i) => {
      if (i < 20) return null;
      const cs = c.slice(0, i+1);
      const last = cs[cs.length-1];
      const hour = new Date(last.closeTime).getUTCHours();
      if (new Date(last.closeTime).getUTCDay() !== 6) return null;
      if (!BTC_BEST.includes(hour)) return null;
      const bb = calcBB(cs, 15, 2.2); if (!bb) return null;
      const p = last.close;
      const isBear = p > bb.upper && last.close > last.open;
      const isBull = p < bb.lower && last.close < last.open;
      if (!isBear && !isBull) return null;
      const s = getStreak(cs);
      if (isBear && s < 1) return null;
      if (isBull && s > -1) return null;
      return isBear ? 'bear' : 'bull';
    }},
];

console.log('\n--- 3-FOLD Walk-Forward (BTC synth-15m) ---');
const validated = [];
for (const cfg of configs) {
  const r = walkForward(btcSynth, cfg.fn, 3);
  if (!r) { console.log('  ' + cfg.name.padEnd(58) + ' SKIP: T<10'); continue; }
  const tag = r.wf >= 68 && r.sigma <= 12 ? '*** IMPLEMENT' : r.wf >= 63 ? '** VALIDATE' : '* MARGINAL';
  console.log('  ' + cfg.name.padEnd(58) + ' WF=' + r.wf.toFixed(1) + '% s=' + r.sigma.toFixed(1) + '% T=' + r.T + ' [' + r.folds.join('/') + '] ' + tag);
  if (r.wf >= 63) validated.push({ name: cfg.name, fn: cfg.fn, result: r });
}

if (validated.length > 0) {
  console.log('\n--- 5-FOLD for promising candidates ---');
  for (const cfg of validated.filter(c => c.result.wf >= 65)) {
    const r5 = walkForward(btcSynth, cfg.fn, 5);
    if (!r5) continue;
    const go = r5.wf >= 65 && r5.sigma <= 12 ? 'IMPLEMENT' : r5.wf >= 60 ? 'BORDERLINE' : 'SKIP';
    console.log('  ' + cfg.name.slice(0,58).padEnd(58) + ' WF=' + r5.wf.toFixed(1) + '% s=' + r5.sigma.toFixed(1) + '% T=' + r5.T + ' [' + r5.folds.join('/') + '] ' + go);
  }
}

console.log('\nDone.');
