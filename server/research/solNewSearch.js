// SOL New Strategy Search — tests 10+ new ideas not in current indicators.ts
// Current SOL: h=[0,12,13,20]+BB(20,2.2)+s≥2 = 68.7% WR (Strategy 19)
// New targets: RR pattern, RSI/MFI exhaustion, ATR, DoW, expanded hours
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}
function buildSynth15m(ca5m) {
  const s = [];
  const aligned = ca5m.length - (ca5m.length % 3);
  for (let i = 0; i < aligned; i += 3) {
    const g = ca5m.slice(i, i + 3);
    s.push({
      open_time: g[0].open_time, open: g[0].open,
      high: Math.max(...g.map(c => c.high)), low: Math.min(...g.map(c => c.low)),
      close: g[2].close, volume: g.reduce((s, c) => s + c.volume, 0),
    });
  }
  return s;
}

function calcBB(c, end, p, m) {
  if (end < p - 1) return null;
  const sl = c.slice(end - p + 1, end + 1).map(x => x.close);
  const mean = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / p);
  return { upper: mean + m * std, lower: mean - m * std, mid: mean, std };
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
function calcATR(c, end, p) {
  if (end < p) return null;
  let s = 0;
  for (let i = end - p + 1; i <= end; i++) {
    s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close));
  }
  return s / p;
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
function atrPct(c, i) {
  const atr = calcATR(c, i, 14); if (!atr) return 0.5;
  const hist = [];
  for (let j = Math.max(1, i-100); j < i; j++) { const a = calcATR(c, j, 14); if (a) hist.push(a); }
  return hist.filter(a => a < atr).length / Math.max(hist.length, 1);
}

function wf3fn(ca, testFn) {
  if (ca.length < 300) return null;
  const folds = 3, fsz = Math.floor(ca.length / folds), si = 60;
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
  if (tt < 15) return null;
  const mn = frs.reduce((a,b)=>a+b,0)/folds;
  const sg = Math.sqrt(frs.reduce((s,w)=>s+Math.pow(w-mn,2),0)/folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}

function pr(nm, w) {
  if (!w) return;
  const fs = w.folds.map(v=>(v*100).toFixed(1)).join('/');
  const flag = w.wr >= 0.65 && w.sigma <= 0.08 && w.total >= 30 ? ' *** VALIDATED' :
               w.wr >= 0.62 && w.sigma <= 0.10 && w.total >= 20 ? ' ** PROMISING' :
               w.wr >= 0.58 && w.total >= 15 ? ' * MARGINAL' : '';
  if (!flag) return;
  console.log(`  ${nm.padEnd(65)} WR=${(w.wr*100).toFixed(1)}%  sig=${(w.sigma*100).toFixed(1)}%  T=${w.total}  [${fs}]${flag}`);
}

const ca5m = loadCandles('SOL', '5m');
const ca15m = loadCandles('SOL', '15m');
const synth15m = buildSynth15m(ca5m);

console.log(`SOL/5m: ${ca5m.length} candles | SOL/15m: ${ca15m.length} candles | Synth15m: ${synth15m.length}`);

const GH = [0, 12, 13, 20]; // current SOL good hours

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. BASELINE: Confirm current strategy on real 15m data
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: Baseline confirmation ===');
for (const minStr of [1, 2, 3]) {
  pr(`baseline h=[0,12,13,20]+BB(20,2.2)+s>=${minStr}`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. NEW: RR Bull Pattern (2 reds below lower BB) — worked for XRP at 73.7%
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: RR/GGG Pattern at Good Hours ===');
for (const [pat, bbP, bbM, label] of [
  ['RR', 20, 2.2, 'bull'], ['RRR', 20, 2.2, 'bull'],
  ['GG', 20, 2.2, 'bear'], ['GGG', 20, 2.2, 'bear'],
  ['RGGG', 20, 2.2, 'bear'], ['GRGG', 20, 2.2, 'bear'],
  ['GRRR', 20, 2.2, 'bull'], ['RGRR', 20, 2.2, 'bull'],
]) {
  const len = pat.length;
  const isBullPat = label === 'bull';
  pr(`${label}:${pat}+GH+BB(${bbP},${bbM})`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    if (isBullPat && c[i].close >= bb.lower) return null;
    if (!isBullPat && c[i].close <= bb.upper) return null;
    const seq = getSeq(c, i, len); if (!seq || seq !== pat) return null;
    return isBullPat ? 1 : -1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. NEW: RSI Exhaustion on SOL/15m (never tested)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: RSI Exhaustion at Good Hours ===');
for (const [rsiT, minStr, bbP, bbM] of [
  [65, 1, 20, 2.2], [65, 2, 20, 2.2],
  [70, 1, 20, 2.2], [70, 2, 20, 2.2],
  [75, 1, 20, 2.2], [60, 2, 20, 2.2],
]) {
  pr(`RSI>${rsiT}+GH+BB(${bbP},${bbM})+s>=${minStr}`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const rsi = calcRSI(c, i, 14);
    if (isBear && rsi < rsiT) return null;
    if (isBull && rsi > 100 - rsiT) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. NEW: MFI Exhaustion on SOL/15m
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: MFI Exhaustion at Good Hours ===');
for (const [mfiT, minStr] of [
  [60, 1], [60, 2], [65, 1], [65, 2], [70, 1], [70, 2], [75, 1], [75, 2], [80, 1],
]) {
  pr(`MFI>${mfiT}+GH+BB(20,2.2)+s>=${minStr}`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const mfi = calcMFI(c, i, 10);
    if (isBear && mfi < mfiT) return null;
    if (isBull && mfi > 100 - mfiT) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. NEW: ATR Regime on SOL/15m
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: ATR Regime at Good Hours ===');
for (const [maxPct, minStr, label] of [
  [0.33, 1, 'lowATR(<33pct)'], [0.33, 2, 'lowATR(<33pct)'],
  [0.50, 1, 'lowATR(<50pct)'], [0.50, 2, 'lowATR(<50pct)'],
]) {
  pr(`${label}+GH+BB(20,2.2)+s>=${minStr}`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    if (atrPct(c, i) > maxPct) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. NEW: Day-of-Week on SOL/15m
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: Day-of-Week × Good Hours ===');
// First, find best single days
for (let dow = 0; dow < 7; dow++) {
  const r = wf3fn(ca15m, (c, i) => {
    const dt = new Date(c[i].open_time);
    if (dt.getUTCDay() !== dow) return null;
    const h = dt.getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  });
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  pr(`DoW[${days[dow]}]+GH+BB(20,2.2)+s>=1`, r);
}

// Best day combos
for (const [days, label] of [
  [[3,6], 'Wed+Sat'], [[3,4], 'Wed+Thu'], [[0,6], 'Sun+Sat'],
  [[2,3,4], 'Tue+Wed+Thu'], [[3,4,6], 'Wed+Thu+Sat'],
]) {
  pr(`DoW[${label}]+GH+BB(20,2.2)+s>=1`, wf3fn(ca15m, (c, i) => {
    const dt = new Date(c[i].open_time);
    if (!days.includes(dt.getUTCDay())) return null;
    const h = dt.getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. NEW: Body filter on SOL/15m (strong bodied candle = stronger exhaustion)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: Body Filter at Good Hours ===');
for (const [minBody, minStr] of [
  [0.1, 1], [0.2, 1], [0.3, 1], [0.3, 2], [0.5, 1],
]) {
  pr(`body>=${minBody}%+GH+BB(20,2.2)+s>=${minStr}`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const bodyPct = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
    if (bodyPct < minBody) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. NEW: Expanded hour search for SOL/15m (more hours = more trades)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: Expanded/Alternative Hour Sets ===');
// From prior sweep: h=12 was best, h=0,13,20 also strong
// Try combining more hours for higher trade frequency
for (const [hrs, label] of [
  [[0,12,13,20], 'current'],
  [[0,6,12,13,20], '+h=6'],
  [[0,9,12,13,20], '+h=9'],
  [[0,12,13,18,20], '+h=18'],
  [[0,12,13,20,21], '+h=21'],
  [[0,6,9,12,13,20], '+h=6+9'],
  [[0,3,12,13,20], '+h=3'],
  [[0,12,13,16,20], '+h=16'],
  [[0,12,13,20,23], '+h=23'],
  [[0,4,12,13,20], '+h=4'],
]) {
  pr(`h=[${label}]+BB(20,2.2)+s>=2`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!hrs.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. NEW: Different BB params for SOL/15m
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: BB Parameter Variations ===');
for (const [bbP, bbM, minStr] of [
  [15, 2.0, 2], [15, 2.2, 2], [25, 2.0, 1], [25, 2.2, 1],
  [20, 2.5, 1], [10, 2.0, 2], [20, 2.0, 2],
]) {
  pr(`h=[0,12,13,20]+BB(${bbP},${bbM})+s>=${minStr}`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 10. NEW: SOL/15m - bear-only vs bull-only signals
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: Direction-specific signals ===');
// Bear only (above BB upper)
pr('bear_only+GH+BB(20,2.2)+s>=2', wf3fn(ca15m, (c, i) => {
  const h = new Date(c[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  if (c[i].close <= bb.upper) return null;
  const st = streak(c, i);
  if (gd(c[i]) !== 'G' || st < 2) return null;
  return -1;
}));
// Bull only (below BB lower)
pr('bull_only+GH+BB(20,2.2)+s>=2', wf3fn(ca15m, (c, i) => {
  const h = new Date(c[i].open_time).getUTCHours();
  if (!GH.includes(h)) return null;
  const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
  if (c[i].close >= bb.lower) return null;
  const st = streak(c, i);
  if (gd(c[i]) !== 'R' || st < 2) return null;
  return 1;
}));

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 11. NEW: SOL/5m at single best hours (h=12 was best 5m hour for SOL)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/5m: Targeting best hours ===');
for (const [hrs, bbP, bbM, minStr] of [
  [[12], 20, 2.0, 2], [[12], 20, 2.2, 2], [[12], 25, 2.2, 1],
  [[12], 15, 2.0, 2], [[0,12], 20, 2.2, 2], [[12,13], 20, 2.2, 2],
  [[12,20], 20, 2.2, 2], [[0,12,13], 20, 2.2, 2],
]) {
  pr(`SOL/5m h=[${hrs.join(',')}]+BB(${bbP},${bbM})+s>=${minStr}`, wf3fn(ca5m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!hrs.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 12. NEW: SOL EMA distance (like ETH EMA50 which showed 65.3%)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: EMA Distance + BB ===');
function calcEMA(c, end, p) {
  if (end < p - 1) return null;
  const k = 2 / (p + 1);
  const startSlice = Math.max(0, end - p * 3);
  let ema = c.slice(startSlice, startSlice + p).reduce((s, x) => s + x.close, 0) / p;
  for (let i = startSlice + p; i <= end; i++) ema = c[i].close * k + ema * (1 - k);
  return ema;
}
for (const [emaPer, emaMin, minStr] of [
  [50, 0.003, 1], [50, 0.005, 1], [20, 0.005, 1],
  [50, 0.003, 2], [50, 0.005, 2],
]) {
  pr(`EMA${emaPer}_dist>=${(emaMin*100).toFixed(1)}%+GH+BB(20,2.2)+s>=${minStr}`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const ema = calcEMA(c, i, emaPer); if (!ema) return null;
    if (Math.abs(c[i].close - ema) / ema < emaMin) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 13. NEW: Exhaustive single-hour sweep for SOL/15m with RSI+BB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: Full hour sweep with RSI>65 filter ===');
const hourScores = [];
for (let h = 0; h < 24; h++) {
  const r = wf3fn(ca15m, (c, i) => {
    if (new Date(c[i].open_time).getUTCHours() !== h) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const rsi = calcRSI(c, i, 14);
    if (isBear && rsi < 65) return null;
    if (isBull && rsi > 35) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  });
  if (r && r.total >= 10) hourScores.push({ h, ...r });
}
hourScores.sort((a, b) => b.wr - a.wr);
console.log('Best hours with RSI>65 filter:');
hourScores.slice(0, 8).forEach(x => {
  const fs = x.folds.map(v=>(v*100).toFixed(1)).join('/');
  const flag = x.wr >= 0.65 && x.sigma <= 0.08 && x.total >= 20 ? ' *** VALIDATED' :
               x.wr >= 0.62 && x.sigma <= 0.10 && x.total >= 12 ? ' ** PROMISING' : '';
  if (flag || x.wr >= 0.60) console.log(`  h=${x.h}: WR=${(x.wr*100).toFixed(1)}% sig=${(x.sigma*100).toFixed(1)}% T=${x.total} [${fs}]${flag}`);
});

// Try hour combos with high-scoring hours
const topHours = hourScores.slice(0, 4).map(x => x.h);
console.log(`\nTop 4 hours for RSI>65: [${topHours.join(',')}]`);
for (const [hrs, label] of [
  [topHours, 'top4'],
  [topHours.slice(0,2), 'top2'],
  [[...GH, ...topHours].filter((v,i,a)=>a.indexOf(v)===i), 'current+top4'],
]) {
  pr(`RSI>65+h=[${label}]+BB(20,2.2)+s>=1`, wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!hrs.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const rsi = calcRSI(c, i, 14);
    if (isBear && rsi < 65) return null;
    if (isBull && rsi > 35) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  }));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 14. Combining best features for higher trade count
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== SOL/15m: High-frequency variants (target 5+ trades/day) ===');
// Note: 60 days/fold × 5 trades/day = 300 per fold = 900 total
for (const [hrs, bbP, bbM, minStr, label] of [
  [[0,6,9,12,13,18,20], 20, 2.2, 1, 'h=[0,6,9,12,13,18,20]'],
  [[0,6,12,13,18,20,21], 20, 2.2, 1, 'h=[0,6,12,13,18,20,21]'],
  [[0,12,13,20], 20, 2.2, 1, 'current_s>=1'],
  [[0,3,6,12,13,20,23], 20, 2.2, 1, 'every6h'],
]) {
  const r = wf3fn(ca15m, (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!hrs.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(label+`+BB(${bbP},${bbM})+s>=${minStr}`, r);
}

console.log('\nDone searching SOL strategies.');
