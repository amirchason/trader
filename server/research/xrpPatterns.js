// XRP pattern analysis: RGGG/GRGG sequences, MFI/RSI exhaustion, ATR filter
// All tested at good hours h=[6,9,12,18] with BB(25,2.2)
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}

function calcBB(candles, end, period, mult) {
  if (end < period - 1) return null;
  const sl = candles.slice(end - period + 1, end + 1).map(x => x.close);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, mid: mean, std };
}

function calcRSI(candles, end, period) {
  if (end < period) return null;
  let gains = 0, losses = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change; else losses -= change;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function calcMFI(candles, end, period) {
  if (end < period) return null;
  let posMF = 0, negMF = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const tpPrev = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp >= tpPrev) posMF += mf; else negMF += mf;
  }
  if (negMF === 0) return 100;
  return 100 - 100 / (1 + posMF / negMF);
}

function calcATR(candles, end, period) {
  if (end < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

function gd(c) { return c.close >= c.open ? 'G' : 'R'; }

function getSeq(candles, i, len) {
  if (i < len - 1) return null;
  return candles.slice(i - len + 1, i + 1).map(gd).join('');
}

function streakLen(candles, i) {
  const d = gd(candles[i]); let n = 1;
  for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
    if (gd(candles[j]) === d) n++; else break;
  }
  return n;
}

function wf3generic(sym, tf, testFn) {
  const ca = loadCandles(sym, tf);
  if (ca.length < 300) return null;
  const folds = 3, fsz = Math.floor(ca.length / folds);
  const si = 50;
  const frs = [];
  let tw = 0, tt = 0;
  for (let f = 0; f < folds; f++) {
    const fs2 = Math.max(f * fsz, si);
    const fe = (f === folds - 1) ? ca.length - 1 : (f + 1) * fsz - 1;
    const fc = ca.slice(0, fe + 1);
    const res = [];
    for (let i = fs2; i < fe; i++) {
      const nxt = fc[i + 1];
      if (!nxt) continue;
      const signal = testFn(fc, i);
      if (signal === null) continue;
      // signal: +1 = bull, -1 = bear
      const correct = signal === 1 ? (nxt.close > nxt.open ? 1 : 0) : (nxt.close < nxt.open ? 1 : 0);
      res.push(correct);
    }
    const fw = res.filter(v => v === 1).length;
    frs.push(res.length > 0 ? fw / res.length : 0);
    tw += fw; tt += res.length;
  }
  if (tt === 0) return null;
  const mn = frs.reduce((a, b) => a + b, 0) / folds;
  const sg = Math.sqrt(frs.reduce((s, w) => s + Math.pow(w - mn, 2), 0) / folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}

function pr(nm, w) {
  if (!w) { console.log(`  ${nm}: no data`); return; }
  const fs = w.folds.map(v => (v*100).toFixed(1)).join('/');
  const flag = w.wr >= 0.65 && w.sigma <= 0.08 && w.total >= 30 ? ' *** VALIDATED' :
               w.wr >= 0.62 && w.sigma <= 0.10 && w.total >= 20 ? ' ** PROMISING' :
               w.wr >= 0.58 && w.total >= 15 ? ' * MARGINAL' : ' (weak)';
  console.log(`  ${nm.padEnd(60)} WR=${(w.wr*100).toFixed(1)}%  sig=${(w.sigma*100).toFixed(1)}%  T=${w.total}  [${fs}]${flag}`);
}

const GH = [6, 9, 12, 18]; // good hours from sweep

// ============= BASE: confirm BB(25,2.2) h=[6,12] results =============
console.log('\n=== XRP/15m: BB param confirmation at h=[6,12,9,18] ===');

// Baseline: GoodH + BB(25,2.2) + streak>=1
pr('h=[6,12,9,18] BB(25,2.2) streak>=1', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// With streak>=2
pr('h=[6,12,9,18] BB(25,2.2) streak>=2', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));

// Tighter hours [6,12] only
pr('h=[6,12] BB(25,2.2) streak>=1', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (![6,12].includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// ============= PATTERN ANALYSIS =============
console.log('\n=== XRP/15m: Candle sequence patterns at GoodH + BB(25,2.2) ===');

const patterns = ['GGG', 'RGGG', 'GRGG', 'GG', 'RGG', 'GRG', 'RG'];
for (const pat of patterns) {
  const len = pat.length;
  pr(`bear: ${pat} at GoodH + BB(25,2.2)`, wf3generic('XRP', '15m', (ca, i) => {
    const h = new Date(ca[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
    if (ca[i].close <= bb.upper) return null; // only bear signals
    const seq = getSeq(ca, i, len); if (!seq) return null;
    if (seq !== pat) return null;
    return -1; // predict bear
  }));
}

// Bull patterns (below lower BB)
for (const pat of ['RRR', 'GRRR', 'RGRR', 'RR', 'GRR']) {
  const len = pat.length;
  pr(`bull: ${pat} at GoodH + BB(25,2.2)`, wf3generic('XRP', '15m', (ca, i) => {
    const h = new Date(ca[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
    if (ca[i].close >= bb.lower) return null; // only bull signals
    const seq = getSeq(ca, i, len); if (!seq) return null;
    if (seq !== pat) return null;
    return 1; // predict bull
  }));
}

// ============= RSI + MFI EXHAUSTION =============
console.log('\n=== XRP/15m: RSI+MFI exhaustion at GoodH + BB(25,2.2) ===');

for (const rsiThresh of [60, 65, 70, 75]) {
  pr(`RSI>${rsiThresh} + GoodH + BB(25,2.2) + str>=1`, wf3generic('XRP', '15m', (ca, i) => {
    const h = new Date(ca[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
    const isBear = ca[i].close > bb.upper;
    const isBull = ca[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const rsi = calcRSI(ca, i, 14); if (rsi === null) return null;
    if (isBear && rsi < rsiThresh) return null;
    if (isBull && rsi > (100 - rsiThresh)) return null;
    const st = streakLen(ca, i);
    if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  }));
}

for (const mfiThresh of [60, 65, 70, 75]) {
  pr(`MFI>${mfiThresh} + GoodH + BB(25,2.2) + str>=1`, wf3generic('XRP', '15m', (ca, i) => {
    const h = new Date(ca[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
    const isBear = ca[i].close > bb.upper;
    const isBull = ca[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const mfi = calcMFI(ca, i, 10); if (mfi === null) return null;
    if (isBear && mfi < mfiThresh) return null;
    if (isBull && mfi > (100 - mfiThresh)) return null;
    const st = streakLen(ca, i);
    if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  }));
}

// ============= LOW ATR FILTER =============
console.log('\n=== XRP/15m: ATR filter at GoodH + BB(25,2.2) ===');
// Low ATR showed better WR in feature analysis

pr('LowATR(<50pct) + GoodH + BB(25,2.2) + str>=1', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  // ATR percentile
  const atr = calcATR(ca, i, 14); if (!atr) return null;
  const atrSlice = [];
  for (let j = Math.max(0, i - 100); j < i; j++) {
    const a = calcATR(ca, j, 14);
    if (a) atrSlice.push(a);
  }
  const pct = atrSlice.filter(a => a < atr).length / Math.max(atrSlice.length, 1);
  if (pct > 0.50) return null; // skip high ATR
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

pr('HighATR(>50pct) + GoodH + BB(25,2.2) + str>=1', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const atr = calcATR(ca, i, 14); if (!atr) return null;
  const atrSlice = [];
  for (let j = Math.max(0, i - 100); j < i; j++) {
    const a = calcATR(ca, j, 14);
    if (a) atrSlice.push(a);
  }
  const pct = atrSlice.filter(a => a < atr).length / Math.max(atrSlice.length, 1);
  if (pct <= 0.50) return null; // skip low ATR
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// ============= BODY FILTER =============
console.log('\n=== XRP/15m: Body size filter at GoodH + BB(25,2.2) ===');

for (const minBody of [0.1, 0.2, 0.3, 0.4]) {
  pr(`body>=${minBody}% + GoodH + BB(25,2.2) + str>=1`, wf3generic('XRP', '15m', (ca, i) => {
    const h = new Date(ca[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
    const isBear = ca[i].close > bb.upper;
    const isBull = ca[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const bodyPct = Math.abs(ca[i].close - ca[i].open) / ca[i].open * 100;
    if (bodyPct < minBody) return null;
    const st = streakLen(ca, i);
    if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  }));
}

// ============= COMBINED: Best features together =============
console.log('\n=== XRP/15m: Combined filters (best candidates) ===');

// Best from sweep: h=[6,12] BB(25,2.2) str>=1 + no lower wick (feature corr showed negative)
pr('h=[6,12] BB(25,2.2) str>=1 + noLowerWick', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (![6,12].includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  // No significant lower wick on bear candle
  const range = ca[i].high - ca[i].low;
  if (range > 0 && isBear) {
    const lowerWick = (Math.min(ca[i].open, ca[i].close) - ca[i].low) / range;
    if (lowerWick > 0.3) return null; // skip if significant lower wick
  }
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// h=[6,12,9,18] BB(25,2.2) str>=1 with body filter
pr('h=[6,12,9,18] BB(25,2.2) str>=1 + body>=0.1%', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const bodyPct = Math.abs(ca[i].close - ca[i].open) / ca[i].open * 100;
  if (bodyPct < 0.1) return null;
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// Ultra combo: h=[6,12] + BB(25,2.2) + streak>=2 + body>=0.1%
pr('h=[6,12] BB(25,2.2) str>=2 + body>=0.1%', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (![6,12].includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const bodyPct = Math.abs(ca[i].close - ca[i].open) / ca[i].open * 100;
  if (bodyPct < 0.1) return null;
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));

// MFI + GoodH + BB (already validated on BTC/15m)
pr('MFI>65 + h=[6,12,9,18] BB(25,2.2) + str>=1', wf3generic('XRP', '15m', (ca, i) => {
  const h = new Date(ca[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(ca, i, 25, 2.2); if (!bb) return null;
  const isBear = ca[i].close > bb.upper;
  const isBull = ca[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const mfi = calcMFI(ca, i, 10); if (mfi === null) return null;
  if (isBear && mfi < 65) return null;
  if (isBull && mfi > 35) return null;
  const st = streakLen(ca, i);
  if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// ============= XRP/5m at h=[12] (best 5m hour) =============
console.log('\n=== XRP/5m: Best hour h=12 with various BB params ===');
for (const [bbP, bbM] of [[20,2.0],[25,2.2],[15,2.0],[10,2.5]]) {
  pr(`XRP/5m h=[12] BB(${bbP},${bbM}) str>=1`, wf3generic('XRP', '5m', (ca, i) => {
    const h = new Date(ca[i].open_time).getUTCHours();
    if (h !== 12) return null;
    const bb = calcBB(ca, i, bbP, bbM); if (!bb) return null;
    const isBear = ca[i].close > bb.upper;
    const isBull = ca[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streakLen(ca, i);
    if (isBear && (gd(ca[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(ca[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  }));
}

console.log('\nDone.');
