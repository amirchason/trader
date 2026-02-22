// ETH New Strategy Search — 10+ new ideas not in current indicators.ts
// Focus: Day-of-week, VWAP, MFI/5m, ATR-squeeze, bull-RSI, EMA distance, etc.
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}

// ── Technical indicators ──────────────────────────────────────────────
function calcBB(c, end, p, m) {
  if (end < p - 1) return null;
  const sl = c.slice(end - p + 1, end + 1).map(x => x.close);
  const mean = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / p);
  return { upper: mean + m * std, lower: mean - m * std, mid: mean, std, width: (2 * m * std) / mean };
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
    const h = c[i].high, l = c[i].low, pc = c[i-1].close;
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / p;
}
function calcEMA(c, end, p) {
  if (end < p - 1) return null;
  const k = 2 / (p + 1);
  let ema = c.slice(Math.max(0, end - p * 3), end + 1)
    .slice(0, p).reduce((s, x) => s + x.close, 0) / p;
  for (let i = end - p * 2 + 1; i <= end; i++) {
    if (i >= 0) ema = c[i].close * k + ema * (1 - k);
  }
  return ema;
}
function calcVWAP(c, start, end) {
  let tpv = 0, vol = 0;
  for (let i = start; i <= end; i++) {
    const tp = (c[i].high + c[i].low + c[i].close) / 3;
    tpv += tp * c[i].volume;
    vol += c[i].volume;
  }
  return vol > 0 ? tpv / vol : c[end].close;
}
function gd(c) { return c.close >= c.open ? 'G' : 'R'; }
function streak(c, i) {
  const d = gd(c[i]); let n = 1;
  for (let j = i-1; j >= Math.max(0, i-10); j--) { if (gd(c[j])===d) n++; else break; }
  return n;
}
function atrPct(c, i) {
  const atr = calcATR(c, i, 14); if (!atr) return 0.5;
  const hist = [];
  for (let j = Math.max(1, i-100); j < i; j++) { const a = calcATR(c, j, 14); if (a) hist.push(a); }
  return hist.filter(a => a < atr).length / Math.max(hist.length, 1);
}
function bbWidthPct(c, i) {
  const hist = [];
  for (let j = Math.max(20, i-100); j < i; j++) {
    const bb = calcBB(c, j, 20, 2.0); if (bb) hist.push(bb.width);
  }
  const bb = calcBB(c, i, 20, 2.0); if (!bb || !hist.length) return 0.5;
  return hist.filter(w => w < bb.width).length / hist.length;
}

// ── Walk-forward engine ──────────────────────────────────────────────
function wf3fn(sym, tf, testFn) {
  const ca = loadCandles(sym, tf);
  if (ca.length < 500) return null;
  const folds = 3, fsz = Math.floor(ca.length / folds), si = 120;
  const frs = [];
  let tw = 0, tt = 0;
  for (let f = 0; f < folds; f++) {
    const fs2 = Math.max(f * fsz, si);
    const fe = (f === folds-1) ? ca.length-1 : (f+1)*fsz-1;
    const fc = ca.slice(0, fe+1);
    const res = [];
    for (let i = fs2; i < fe; i++) {
      const nxt = fc[i+1]; if (!nxt) continue;
      const sig = testFn(fc, i);
      if (sig === null) continue;
      res.push(sig === 1 ? (nxt.close > nxt.open ? 1 : 0) : (nxt.close < nxt.open ? 1 : 0));
    }
    const fw = res.filter(v => v===1).length;
    frs.push(res.length > 0 ? fw/res.length : 0);
    tw += fw; tt += res.length;
  }
  if (tt < 15) return null;
  const mn = frs.reduce((a,b)=>a+b,0)/folds;
  const sg = Math.sqrt(frs.reduce((s,w)=>s+Math.pow(w-mn,2),0)/folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}

// 5-fold for final validation
function wf5fn(sym, tf, testFn) {
  const ca = loadCandles(sym, tf);
  if (ca.length < 500) return null;
  const folds = 5, fsz = Math.floor(ca.length / folds), si = 120;
  const frs = [];
  let tw = 0, tt = 0;
  for (let f = 0; f < folds; f++) {
    const fs2 = Math.max(f * fsz, si);
    const fe = (f === folds-1) ? ca.length-1 : (f+1)*fsz-1;
    const fc = ca.slice(0, fe+1);
    const res = [];
    for (let i = fs2; i < fe; i++) {
      const nxt = fc[i+1]; if (!nxt) continue;
      const sig = testFn(fc, i);
      if (sig === null) continue;
      res.push(sig === 1 ? (nxt.close > nxt.open ? 1 : 0) : (nxt.close < nxt.open ? 1 : 0));
    }
    const fw = res.filter(v => v===1).length;
    frs.push(res.length > 0 ? fw/res.length : 0);
    tw += fw; tt += res.length;
  }
  if (tt < 15) return null;
  const mn = frs.reduce((a,b)=>a+b,0)/folds;
  const sg = Math.sqrt(frs.reduce((s,w)=>s+Math.pow(w-mn,2),0)/folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}

function pr(nm, w, validated) {
  if (!w) { console.log(`  ${nm}: no data`); return false; }
  const fs = w.folds.map(v=>(v*100).toFixed(1)).join('/');
  const flag = w.wr >= 0.65 && w.sigma <= 0.08 && w.total >= 30 ? ' *** VALIDATED' :
               w.wr >= 0.62 && w.sigma <= 0.10 && w.total >= 20 ? ' ** PROMISING' :
               w.wr >= 0.58 && w.total >= 15 ? ' * MARGINAL' : '';
  if (!flag && !validated) return false;
  console.log(`  ${nm.padEnd(65)} WR=${(w.wr*100).toFixed(1)}%  sig=${(w.sigma*100).toFixed(1)}%  T=${w.total}  [${fs}]${flag}`);
  return flag.includes('VALIDATED') || flag.includes('PROMISING');
}

const GH = [10,11,12,21]; // ETH good hours

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 1: Day-of-week filter (Wednesday + Good Hours)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: Day-of-Week × Good Hours ===');
// Wed=3, Sat=6 showed strongest WR in prior analysis
for (const [days, label] of [
  [[3], 'Wednesday only'],
  [[6], 'Saturday only'],
  [[3,6], 'Wed+Sat'],
  [[3,4], 'Wed+Thu'],
  [[1,3], 'Mon+Wed'],
  [[2,3,4], 'Tue+Wed+Thu'],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const dt = new Date(c[i].open_time);
    if (!days.includes(dt.getUTCDay())) return null;
    const h = dt.getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
    return isBear ? -1 : 1;
  });
  pr(`DoW[${label}]+GH+BB(20,2.2)+str>=2`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 2: MFI exhaustion on ETH/5m (only tested on BTC/15m before)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: MFI Exhaustion at Good Hours ===');
for (const [mfiT, bbP, bbM, minStr] of [
  [70, 20, 2.2, 1], [70, 20, 2.2, 2], [75, 20, 2.2, 1],
  [75, 20, 2.2, 2], [80, 20, 2.2, 1], [65, 20, 2.2, 2],
  [70, 25, 2.2, 1], [75, 25, 2.2, 1],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const mfi = calcMFI(c, i, 10);
    if (isBear && mfi < mfiT) return null;
    if (isBull && mfi > 100 - mfiT) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`MFI>${mfiT}+GH+BB(${bbP},${bbM})+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 3: Bull-RSI (RSI<30 + below BB + good hours) — opposite of RSI Panic
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: Bull RSI Exhaustion (oversold + below BB) ===');
for (const [rsiT, bbP, bbM, minStr] of [
  [30, 20, 2.2, 1], [35, 20, 2.2, 1], [30, 20, 2.2, 2],
  [35, 20, 2.2, 2], [30, 20, 2.0, 1], [40, 20, 2.2, 1],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    // Only bull signals (below lower BB)
    if (c[i].close >= bb.lower) return null;
    const rsi = calcRSI(c, i, 14);
    if (rsi > rsiT) return null; // only oversold
    const st = streak(c, i);
    if (gd(c[i]) !== 'R' || st < minStr) return null;
    return 1; // predict bull
  });
  pr(`BullRSI<${rsiT}+GH+BB(${bbP},${bbM})+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 4: ATR squeeze (low BB width = tight market) + reversion
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: ATR/BB Width Filter ===');
for (const [atrMax, widthFilter, label] of [
  [0.33, false, 'lowATR(<33pct)'],
  [0.50, false, 'lowATR(<50pct)'],
  [null, true,  'narrowBB(<33pct)'],
]) {
  for (const minStr of [1, 2]) {
    const r = wf3fn('ETH', '5m', (c, i) => {
      const h = new Date(c[i].open_time).getUTCHours();
      if (!GH.includes(h)) return null;
      const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
      const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
      if (!isBear && !isBull) return null;
      if (atrMax !== null) { const p = atrPct(c, i); if (p > atrMax) return null; }
      if (widthFilter) { const p = bbWidthPct(c, i); if (p > 0.33) return null; }
      const st = streak(c, i);
      if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
      if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
      return isBear ? -1 : 1;
    });
    pr(`${label}+GH+BB(20,2.2)+str>=${minStr}`, r);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 5: VWAP deviation + BB (daily VWAP computed from candles)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: VWAP Distance × BB ===');
// Compute rolling 24h VWAP (288 × 5m candles = 24h)
for (const [vwapMin, minStr] of [[0.003, 1], [0.005, 1], [0.003, 2], [0.005, 2]]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    // 24h VWAP
    const vwapStart = Math.max(0, i - 287);
    const vwap = calcVWAP(c, vwapStart, i);
    const dist = Math.abs(c[i].close - vwap) / vwap;
    if (dist < vwapMin) return null; // only trade when far from VWAP
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`VWAP_dist>=${(vwapMin*100).toFixed(1)}%+GH+BB(20,2.2)+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 6: EMA distance (price far from EMA50 + at BB)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: EMA Distance + BB ===');
for (const [emaPeriod, emaMin, minStr] of [
  [50, 0.003, 1], [50, 0.005, 1], [50, 0.003, 2],
  [20, 0.003, 1], [100, 0.003, 1],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const ema = calcEMA(c, i, emaPeriod); if (!ema) return null;
    const dist = Math.abs(c[i].close - ema) / ema;
    if (dist < emaMin) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`EMA${emaPeriod}_dist>=${(emaMin*100).toFixed(1)}%+GH+BB(20,2.2)+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 7: RSI gradient (RSI declining while overbought = stronger bear)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: RSI Gradient + BB ===');
for (const [minStr] of [[1], [2]]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    if (i < 3) return null;
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const rsiNow = calcRSI(c, i, 14);
    const rsiPrev = calcRSI(c, i-2, 14);
    // Bear: RSI was higher 2 candles ago (RSI declining while overbought)
    if (isBear && (rsiNow >= 70 || rsiPrev <= rsiNow)) return null;
    // Bull: RSI was lower 2 candles ago (RSI rising while oversold)
    if (isBull && (rsiNow <= 30 || rsiPrev >= rsiNow)) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`RSI_declining+GH+BB(20,2.2)+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 8: BB touch repeat (price touches BB 2nd time = stronger)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: BB Double Touch ===');
for (const [lookback, minStr] of [[3, 1], [5, 1], [3, 2], [5, 2]]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    // Check if price touched same side of BB in the last N candles
    let prevTouch = false;
    for (let j = i - 1; j >= Math.max(0, i - lookback); j--) {
      const bbPrev = calcBB(c, j, 20, 2.2); if (!bbPrev) continue;
      if (isBear && c[j].close > bbPrev.upper) { prevTouch = true; break; }
      if (isBull && c[j].close < bbPrev.lower) { prevTouch = true; break; }
    }
    if (!prevTouch) return null; // only 2nd+ touch
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`BB_double_touch(${lookback})+GH+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 9: Price above daily open (bias filter)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: Daily Open Bias ===');
// "Daily open" = price of the 00:00 UTC candle of the current day
for (const [aboveForBear, minStr] of [[true, 1], [true, 2], [false, 1]]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    // Find daily open (00:00 UTC candle)
    const today = new Date(c[i].open_time);
    today.setUTCHours(0, 0, 0, 0);
    const todayTs = today.getTime();
    let dailyOpen = null;
    for (let j = i - 1; j >= Math.max(0, i - 300); j--) {
      if (c[j].open_time <= todayTs && c[j].open_time > todayTs - 15*60*1000) {
        dailyOpen = c[j].open; break;
      }
    }
    if (!dailyOpen) return null;
    const aboveDailyOpen = c[i].close > dailyOpen;
    // Bear trades only when above daily open (trend agrees with signal)
    if (isBear && aboveForBear && !aboveDailyOpen) return null;
    if (isBear && !aboveForBear && aboveDailyOpen) return null;
    if (isBull) return null; // only test bear signals here
    const st = streak(c, i);
    if (gd(c[i]) !== 'G' || st < minStr) return null;
    return -1;
  });
  pr(`Bear+${aboveForBear ? 'above' : 'below'}_daily_open+GH+BB(20,2.2)+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 10: RSI Panic BULL side (RSI overbought → bear AND RSI oversold → bull)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: RSI Panic (bidirectional) ===');
for (const [rsiT, bodyMin, minStr] of [
  [65, 0.2, 1], [65, 0.3, 1], [65, 0.3, 2],
  [70, 0.2, 1], [70, 0.3, 1],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const rsi = calcRSI(c, i, 14);
    if (isBear && rsi < rsiT) return null; // bear: RSI overbought
    if (isBull && rsi > 100-rsiT) return null; // bull: RSI oversold
    const bodyPct = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
    if (bodyPct < bodyMin) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`RSI_panic_bidir(${rsiT})+body>=${bodyMin}%+GH+BB(20,2.2)+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 11: ETH/15m with new hour combinations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/15m: New hour combinations ===');
const GH15m = [10,11,12,21]; // Standard good hours

// Test new 15m patterns
for (const [hrs, label] of [
  [[10,11,12,21], 'standard GH'],
  [[10,12,21], '10+12+21'],
  [[11,12,21], '11+12+21'],
  [[10,11,21], '10+11+21'],
  [[10,11,12], '10+11+12'],
  [[12,21], '12+21'],
  [[10,21], '10+21'],
]) {
  const r = wf3fn('ETH', '15m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!hrs.includes(h)) return null;
    const bb = calcBB(c, i, 15, 2.2); if (!bb) return null; // 15m uses BB(15,2.2)
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
    return isBear ? -1 : 1;
  });
  pr(`ETH/15m h=[${label}] BB(15,2.2) str>=2`, r);
}

// MFI on 15m
for (const mfiT of [65, 70, 75]) {
  const r = wf3fn('ETH', '15m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH15m.includes(h)) return null;
    const bb = calcBB(c, i, 15, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const mfi = calcMFI(c, i, 10);
    if (isBear && mfi < mfiT) return null;
    if (isBull && mfi > 100-mfiT) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 1)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 1)) return null;
    return isBear ? -1 : 1;
  });
  pr(`ETH/15m MFI>${mfiT}+GH+BB(15,2.2)+str>=1`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 12: BB Deviation Zone (0.05-0.25% outside BB = sweet spot)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: BB Deviation Zone (sweet spot filter) ===');
for (const [minDev, maxDev, minStr] of [
  [0.0003, 0.0025, 1], [0.0003, 0.0025, 2],
  [0.0005, 0.003, 1],  [0.0003, 0.002, 2],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const dev = isBear
      ? (c[i].close - bb.upper) / bb.upper
      : (bb.lower - c[i].close) / bb.lower;
    if (dev < minDev || dev > maxDev) return null; // sweet spot only
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`BB_dev[${(minDev*100).toFixed(2)}-${(maxDev*100).toFixed(2)}%]+GH+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 13: Volume climax (very high volume = exhaustion)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: Volume Climax Exhaustion ===');
for (const [volMult, minStr, bbP, bbM] of [
  [2.0, 1, 20, 2.2], [2.0, 2, 20, 2.2], [1.5, 2, 20, 2.2],
  [2.5, 1, 20, 2.2], [2.0, 1, 20, 2.0],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const h = new Date(c[i].open_time).getUTCHours();
    if (!GH.includes(h)) return null;
    const bb = calcBB(c, i, bbP, bbM); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const volAvg = c.slice(Math.max(0, i-20), i).reduce((s, x) => s + x.volume, 0) / 20;
    if (c[i].volume < volMult * volAvg) return null; // high volume candle
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < minStr)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < minStr)) return null;
    return isBear ? -1 : 1;
  });
  pr(`VolClimax(>${volMult}x)+GH+BB(${bbP},${bbM})+str>=${minStr}`, r);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// NEW STRATEGY 14: Good minutes within good hours (best 15min windows)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
console.log('\n=== ETH/5m: Good Minute-Slots within Good Hours ===');
// 5m candles: minutes 0,5,10,15,20,25,30,35,40,45,50,55
// Which 5m slots within good hours are best?
for (const [mins, label] of [
  [[0,5,10], 'first15min'],
  [[0,5,10,15,20,25], 'first30min'],
  [[30,35,40,45,50,55], 'last30min'],
  [[45,50,55], 'last15min'],
]) {
  const r = wf3fn('ETH', '5m', (c, i) => {
    const dt = new Date(c[i].open_time);
    const h = dt.getUTCHours(), m = dt.getUTCMinutes();
    if (!GH.includes(h)) return null;
    if (!mins.includes(m)) return null;
    const bb = calcBB(c, i, 20, 2.2); if (!bb) return null;
    const isBear = c[i].close > bb.upper, isBull = c[i].close < bb.lower;
    if (!isBear && !isBull) return null;
    const st = streak(c, i);
    if (isBear && (gd(c[i]) !== 'G' || st < 2)) return null;
    if (isBull && (gd(c[i]) !== 'R' || st < 2)) return null;
    return isBear ? -1 : 1;
  });
  pr(`GH+${label}+BB(20,2.2)+str>=2`, r);
}

console.log('\n\nDone searching ETH strategies.');
