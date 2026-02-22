// 5-fold walk-forward validation of top new ETH and SOL candidates
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}
function calcBB(c, end, p, m) {
  if (end < p - 1) return null;
  const sl = c.slice(end - p + 1, end + 1).map(x => x.close);
  const mean = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / p);
  return { upper: mean + m * std, lower: mean - m * std, mid: mean };
}
function calcRSI(c, end, p) {
  if (end < p) return 50;
  let g = 0, l = 0;
  for (let i = end - p + 1; i <= end; i++) {
    const d = c[i].close - c[i-1].close;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}
function calcMFI(c, end, p) {
  if (end < p) return 50;
  let pos = 0, neg = 0;
  for (let i = end - p + 1; i <= end; i++) {
    const tp = (c[i].high + c[i].low + c[i].close) / 3;
    const tpp = (c[i-1].high + c[i-1].low + c[i-1].close) / 3;
    const mf = tp * c[i].volume;
    if (tp >= tpp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}
function calcEMA(c, end, p) {
  if (end < p - 1) return null;
  const k = 2 / (p + 1);
  let ema = c.slice(Math.max(0, end - p * 3), Math.max(0, end - p * 3) + p).reduce((s, x) => s + x.close, 0) / p;
  for (let i = Math.max(0, end - p * 3) + p; i <= end; i++) ema = c[i].close * k + ema * (1 - k);
  return ema;
}
function gd(c) { return c.close >= c.open ? 'G' : 'R'; }
function streak(c, i) {
  const d = gd(c[i]); let n = 1;
  for (let j = i-1; j >= Math.max(0, i-10); j--) { if (gd(c[j])===d) n++; else break; }
  return n;
}
function getSeq(c, i, len) {
  if (i < len - 1) return null;
  return c.slice(i - len + 1, i + 1).map(gd).join('');
}

function wf5fn(ca, testFn) {
  if (ca.length < 500) return null;
  const folds = 5, fsz = Math.floor(ca.length / folds), si = 100;
  const frs = []; let tw = 0, tt = 0;
  for (let f = 0; f < folds; f++) {
    const fs2 = Math.max(f * fsz, si);
    const fe = (f === folds-1) ? ca.length-1 : (f+1)*fsz-1;
    const fc = ca.slice(0, fe+1); const res = [];
    for (let i = fs2; i < fe; i++) {
      const nxt = fc[i+1]; if (!nxt) continue;
      const sig = testFn(fc, i); if (sig === null) continue;
      res.push(sig === 1 ? (nxt.close > nxt.open ? 1 : 0) : (nxt.close < nxt.open ? 1 : 0));
    }
    const fw = res.filter(v=>v===1).length;
    frs.push(res.length > 0 ? fw/res.length : 0); tw += fw; tt += res.length;
  }
  if (tt < 10) return null;
  const mn = frs.reduce((a,b)=>a+b,0)/folds;
  const sg = Math.sqrt(frs.reduce((s,w)=>s+Math.pow(w-mn,2),0)/folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}

function pr5(nm, w) {
  if (!w) { console.log(`  ${nm.padEnd(65)}: no data`); return; }
  const fs = w.folds.map(v=>(v*100).toFixed(1)).join('/');
  const allPos = w.folds.every(v => v >= 0.55);
  const flag = (w.wr >= 0.65 && w.sigma <= 0.10 && w.total >= 30 && allPos) ? ' *** 5F-VALIDATED' :
               (w.wr >= 0.62 && w.sigma <= 0.12 && w.total >= 20) ? ' ** 5F-PROMISING' :
               (w.wr >= 0.58 && w.total >= 12) ? ' * 5F-MARGINAL' : ' (weak)';
  console.log(`  ${nm.padEnd(65)} WR=${(w.wr*100).toFixed(1)}%  sig=${(w.sigma*100).toFixed(1)}%  T=${w.total}  [${fs}]${flag}`);
}

const ethCA = loadCandles('ETH', '5m');
const eth15CA = loadCandles('ETH', '15m');
const solCA = loadCandles('SOL', '15m');
const GH_ETH = [10,11,12,21];
const GH_SOL = [0,12,13,20];

// ════════════════════════════════════════════════════════════════════
// ETH 5-FOLD VALIDATION
// ════════════════════════════════════════════════════════════════════
console.log('\n════════ ETH NEW STRATEGIES — 5-Fold Validation ════════\n');

// ETH-A: Day-of-week (Wed+Sat) filter
console.log('ETH-A: Day-of-Week (Wed+Sat) + GoodH + BB(20,2.2) + streak>=2');
pr5('DoW[Wed+Sat]+GH+BB(20,2.2)+str>=2', wf5fn(ethCA, (c, i) => {
  const dt = new Date(c[i].open_time);
  if (![3,6].includes(dt.getUTCDay())) return null;
  if (!GH_ETH.includes(dt.getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));
// Also Wed+Thu
pr5('DoW[Wed+Thu]+GH+BB(20,2.2)+str>=2', wf5fn(ethCA, (c, i) => {
  const dt = new Date(c[i].open_time);
  if (![3,4].includes(dt.getUTCDay())) return null;
  if (!GH_ETH.includes(dt.getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));

// ETH-B: EMA50 distance >= 0.5%
console.log('\nETH-B: EMA50 Distance >= 0.5% + GH + BB(20,2.2) + streak>=1');
pr5('EMA50_dist>=0.5%+GH+BB(20,2.2)+str>=1', wf5fn(ethCA, (c, i) => {
  if (!GH_ETH.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const ema = calcEMA(c, i, 50); if (!ema) return null;
  if (Math.abs(c[i].close - ema) / ema < 0.005) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// ETH-C: RSI Bidirectional panic (RSI>65 bear + RSI<35 bull) + body>=0.3% + str>=2
console.log('\nETH-C: RSI Panic Bidirectional (65/35) + body>=0.3% + str>=2');
pr5('RSI_bidir(65)+body>=0.3%+GH+BB(20,2.2)+str>=2', wf5fn(ethCA, (c, i) => {
  if (!GH_ETH.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const rsi = calcRSI(c, i, 14);
  if (isBear && rsi < 65) return null;
  if (isBull && rsi > 35) return null;
  const bodyPct = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
  if (bodyPct < 0.3) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));
// Also streak>=1 version
pr5('RSI_bidir(65)+body>=0.3%+GH+BB(20,2.2)+str>=1', wf5fn(ethCA, (c, i) => {
  if (!GH_ETH.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const rsi = calcRSI(c, i, 14);
  if (isBear && rsi < 65) return null;
  if (isBull && rsi > 35) return null;
  const bodyPct = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
  if (bodyPct < 0.3) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// ETH-D: ETH/15m MFI>70
console.log('\nETH-D: ETH/15m MFI>70 + GoodH + BB(15,2.2) + str>=1');
pr5('ETH/15m MFI>70+GH+BB(15,2.2)+str>=1', wf5fn(eth15CA, (c, i) => {
  if (!GH_ETH.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 15, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const mfi = calcMFI(c, i, 10);
  if (isBear && mfi < 70) return null;
  if (isBull && mfi > 30) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// ETH-E: RSI Panic bidirectional full extension (70 threshold + body>=0.2%)
console.log('\nETH-E: RSI Panic(70) bidir + body>=0.2% + str>=1 [higher freq]');
pr5('RSI_bidir(70)+body>=0.2%+GH+BB(20,2.2)+str>=1', wf5fn(ethCA, (c, i) => {
  if (!GH_ETH.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const rsi = calcRSI(c, i, 14);
  if (isBear && rsi < 70) return null;
  if (isBull && rsi > 30) return null;
  const bodyPct = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
  if (bodyPct < 0.2) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// ════════════════════════════════════════════════════════════════════
// SOL 5-FOLD VALIDATION
// ════════════════════════════════════════════════════════════════════
console.log('\n════════ SOL NEW STRATEGIES — 5-Fold Validation ════════\n');

// SOL-A: Day-of-week (Wed+Thu+Sat) at Good Hours
console.log('SOL-A: Day-of-Week (Wed+Thu+Sat) + GH + BB(20,2.2) + str>=1');
pr5('DoW[Wed+Thu+Sat]+GH+BB(20,2.2)+s>=1', wf5fn(solCA, (c, i) => {
  const dt = new Date(c[i].open_time);
  if (![3,4,6].includes(dt.getUTCDay())) return null;
  if (!GH_SOL.includes(dt.getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));
// Tue+Wed+Thu
pr5('DoW[Tue+Wed+Thu]+GH+BB(20,2.2)+s>=1', wf5fn(solCA, (c, i) => {
  const dt = new Date(c[i].open_time);
  if (![2,3,4].includes(dt.getUTCDay())) return null;
  if (!GH_SOL.includes(dt.getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
  return isBear ? -1 : 1;
}));

// SOL-B: RR Bull Pattern at Good Hours
console.log('\nSOL-B: RR Bull Pattern + GH + BB(20,2.2)');
pr5('bull:RR+GH+BB(20,2.2)', wf5fn(solCA, (c, i) => {
  if (!GH_SOL.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  if (c[i].close >= bb.lower) return null;
  const seq = getSeq(c, i, 2); if (!seq || seq !== 'RR') return null;
  return 1;
}));
// Also GG Bear Pattern
pr5('bear:GG+GH+BB(20,2.2)', wf5fn(solCA, (c, i) => {
  if (!GH_SOL.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  if (c[i].close <= bb.upper) return null;
  const seq = getSeq(c, i, 2); if (!seq || seq !== 'GG') return null;
  return -1;
}));

// SOL-C: BB(15,2.2) tighter params
console.log('\nSOL-C: SOL/15m BB(15,2.2) tighter params + GH + str>=2');
pr5('h=[0,12,13,20]+BB(15,2.2)+s>=2', wf5fn(solCA, (c, i) => {
  if (!GH_SOL.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 15, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));

// SOL-D: Body >= 0.3% filter
console.log('\nSOL-D: Body >= 0.3% + GH + BB(20,2.2) + str>=2');
pr5('body>=0.3%+GH+BB(20,2.2)+s>=2', wf5fn(solCA, (c, i) => {
  if (!GH_SOL.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const bodyPct = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
  if (bodyPct < 0.3) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));

// SOL-E: EMA50 distance >= 0.3%
console.log('\nSOL-E: EMA50 dist>=0.3% + GH + BB(20,2.2) + str>=2');
pr5('EMA50_dist>=0.3%+GH+BB(20,2.2)+s>=2', wf5fn(solCA, (c, i) => {
  if (!GH_SOL.includes(new Date(c[i].open_time).getUTCHours())) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
  if (!isBear && !isBull) return null;
  const k = 2/51;
  let ema = c.slice(Math.max(0, i-150), Math.max(0, i-150)+50).reduce((s, x) => s + x.close, 0) / 50;
  for (let j = Math.max(0, i-150)+50; j <= i; j++) ema = c[j].close * k + ema * (1 - k);
  if (Math.abs(c[i].close - ema) / ema < 0.003) return null;
  const st = streak(c, i);
  if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
  if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
  return isBear ? -1 : 1;
}));

// ════════════════════════════════════════════════════════════════════
// TRADE FREQUENCY ANALYSIS
// ════════════════════════════════════════════════════════════════════
console.log('\n════════ TRADE FREQUENCY ANALYSIS ════════\n');

// How many trades per 60-day fold for key strategies
const candleCount5m = loadCandles('ETH', '5m').length;
const candleCount15m = loadCandles('ETH', '15m').length;
const daysOfData = candleCount5m / 288; // 288 5m candles per day

console.log(`ETH/5m dataset: ${candleCount5m} candles = ${daysOfData.toFixed(0)} days`);
console.log(`ETH/15m dataset: ${candleCount15m} candles`);

// For each strategy, estimate daily trade rate
const strategies = [
  { name: 'ETH Strat15 (Good Hours)', T: 126, days: daysOfData },
  { name: 'ETH Strat16 (Synth15m)', T: 102, days: daysOfData },
  { name: 'ETH Strat17 (Daily Range)', T: 79, days: daysOfData },
  { name: 'ETH Strat18 (RSI Panic)', T: 121, days: daysOfData },
  { name: 'ETH NEW-A (DoW Wed+Sat)', T: 112, days: daysOfData },
  { name: 'ETH NEW-B (EMA50)', T: 292, days: daysOfData },
  { name: 'ETH NEW-C (RSI bidir65)', T: 153, days: daysOfData },
  { name: 'ETH NEW-D (15m MFI70)', T: 112, days: daysOfData },
  { name: 'SOL Strat19 (Good Hours)', T: 226, days: daysOfData },
  { name: 'SOL NEW-A (DoW Wed+Thu+Sat)', T: 76, days: daysOfData },
  { name: 'SOL NEW-B (RR pattern)', T: 93, days: daysOfData },
  { name: 'SOL NEW-C (BB15,2.2)', T: 190, days: daysOfData },
  { name: 'SOL NEW-D (Body 0.3%)', T: 119, days: daysOfData },
  { name: 'SOL NEW-E (EMA50)', T: 157, days: daysOfData },
  { name: 'XRP Strat20 (Good Hours)', T: 192, days: daysOfData },
];
console.log('\nEstimated daily trade rate (T/total_days):');
strategies.forEach(s => {
  const rate = (s.T / s.days).toFixed(2);
  console.log(`  ${s.name.padEnd(40)} ${rate} trades/day (T=${s.T} over ${s.days.toFixed(0)} days)`);
});

// Total across all strategies (ETH + BTC + SOL + XRP combined)
const ethTotal = 126+102+79+121+112+292+153; // current + new ETH strategies
const solTotal = 226+76+93+190+119+157;       // current + new SOL strategies
const xrpTotal = 192;
console.log(`\nEstimated total: ~${((ethTotal+solTotal+xrpTotal)/daysOfData).toFixed(1)} trades/day if all strategies active`);
console.log(`(ETH: ${(ethTotal/daysOfData).toFixed(1)}/day + SOL: ${(solTotal/daysOfData).toFixed(1)}/day + XRP: ${(xrpTotal/daysOfData).toFixed(1)}/day)`);

console.log('\nDone.');
