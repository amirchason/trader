/**
 * Session 16: Volume × WR Balance
 *
 * Goal: 3-5+ trades/day AND >75% WR (prefer 85%)
 *
 * Session 15 confirmed: removing time filter destroys edge. Time filter is sacred.
 * But we need MORE trades during good hours. Approaches:
 *
 *   A. BB(20,1.5) + tight oscillators → more triggers at 4 good hours
 *   B. BB(20,1.3) + ultra-tight oscillators → even more triggers
 *   C. Extended good hours (6h/day) + strat93-quality filters
 *   D. ADX<22 (slightly looser ranging) + strat93 conditions
 *   E. 8-hour window (loosest time filter feasible) + RSI73+MFI72
 *   F. Good hours + streak >=1 (momentum) + BB(1.5) → trend continuation?
 *   G. BTC extended hours [1,5,12,13,16,20,22] × quality → +1 hour
 *   H. BB(20,1.5) + RSI3>90 + MFI70 → S15 B3 winner with tighter band
 *   I. Double-stacked: GH × ADX<20 × (CRSI>85 OR StochK>85) × BB18 → union
 *   J. BB(20,1.5) + ADX<20 + RSI73 + MFI72 + RSI14 → Session 13 pattern at 1.5x
 */

const path = require('path');

// ─── Load OHLCV ──────────────────────────────────────────────────────────────
function loadCandles(symbol) {
  const dbPath = path.join(__dirname, '../../trader.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT open_time as t, open, high, low, close, volume
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol);
  db.close();
  return rows.map(r => ({ t: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += arr[j];
    out[i] = s / n;
  }
  return out;
}
function stdSeries(arr, sma, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let v = 0; for (let j = i - n + 1; j <= i; j++) v += (arr[j] - sma[i]) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}
function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i-1]; if (d > 0) ag += d; else al -= d; }
  ag /= n; al /= n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (n-1) + Math.max(0, d)) / n;
    al = (al * (n-1) + Math.max(0, -d)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function mfiSeries(candles, n) {
  const out = new Array(candles.length).fill(50);
  for (let i = n; i < candles.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const tpP = (candles[j-1].high + candles[j-1].low + candles[j-1].close) / 3;
      const f = tp * candles[j].volume;
      if (tp > tpP) pos += f; else neg += f;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}
function adxSeries(candles, n) {
  const out = new Array(candles.length).fill(25);
  const tr = new Array(candles.length).fill(0);
  const dp = new Array(candles.length).fill(0);
  const dm = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    tr[i] = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
    const u = candles[i].high - candles[i-1].high, d = candles[i-1].low - candles[i].low;
    dp[i] = u > d && u > 0 ? u : 0; dm[i] = d > u && d > 0 ? d : 0;
  }
  let atr = 0, dip = 0, dim = 0;
  for (let i = 1; i <= n; i++) { atr += tr[i]; dip += dp[i]; dim += dm[i]; }
  const dxArr = [];
  for (let i = n+1; i < candles.length; i++) {
    atr = atr - atr/n + tr[i]; dip = dip - dip/n + dp[i]; dim = dim - dim/n + dm[i];
    const diP = atr>0 ? dip/atr*100 : 0, diM = atr>0 ? dim/atr*100 : 0;
    dxArr.push((diP+diM)>0 ? Math.abs(diP-diM)/(diP+diM)*100 : 0);
    if (dxArr.length >= n) out[i] = dxArr.slice(-n).reduce((a,b)=>a+b,0)/n;
  }
  return out;
}
function crsiSeries(closes, n = 100) {
  const rsi3 = rsiSeries(closes, 3);
  const streaks = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) streaks[i] = Math.max(0, streaks[i-1]) + 1;
    else if (closes[i] < closes[i-1]) streaks[i] = Math.min(0, streaks[i-1]) - 1;
  }
  const sRsi = rsiSeries(streaks.map(s => s||0.001), 2);
  const out = new Array(closes.length).fill(50);
  for (let i = n; i < closes.length; i++) {
    const w = closes.slice(i-n, i);
    const rank = w.filter(v => v < closes[i]).length / n * 100;
    out[i] = (rsi3[i] + sRsi[i] + rank) / 3;
  }
  return out;
}
function stochRsiKD(closes, rsiP=14, stP=14, sK=3, sD=3) {
  const rsi = rsiSeries(closes, rsiP);
  const rawK = new Array(closes.length).fill(50);
  for (let i = stP+rsiP-1; i < closes.length; i++) {
    const w = rsi.slice(i-stP+1, i+1), lo = Math.min(...w), hi = Math.max(...w);
    rawK[i] = hi===lo ? 50 : (rsi[i]-lo)/(hi-lo)*100;
  }
  const K = smaSeries(rawK, sK), D = smaSeries(K, sD);
  return { K, D };
}
function obvSeries(candles) {
  const out = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    out[i] = out[i-1] + (candles[i].close > candles[i-1].close ? candles[i].volume : candles[i].close < candles[i-1].close ? -candles[i].volume : 0);
  }
  return out;
}
function getHour(ts) { return new Date(ts).getUTCHours(); }

// ─── Walk-Forward ─────────────────────────────────────────────────────────────
function walkForward(candles, fn, nFolds = 5) {
  const foldSz = Math.floor(candles.length / nFolds);
  const wrs = [];
  for (let f = 0; f < nFolds; f++) {
    const start = f * foldSz, end = f === nFolds-1 ? candles.length : (f+1)*foldSz;
    const fc = candles.slice(start, end);
    const closes = fc.map(c => c.close);
    const sma20 = smaSeries(closes, 20), std20 = stdSeries(closes, sma20, 20);
    // Pre-compute all BB bands at once
    const bb = {};
    for (const m of [1.0, 1.3, 1.5, 1.8, 2.0, 2.2]) {
      bb[`u${(m*10).toFixed(0)}`] = sma20.map((s,i) => s + m*std20[i]);
      bb[`l${(m*10).toFixed(0)}`] = sma20.map((s,i) => s - m*std20[i]);
    }
    const rsi3 = rsiSeries(closes, 3), rsi7 = rsiSeries(closes, 7), rsi14 = rsiSeries(closes, 14);
    const mfi14 = mfiSeries(fc, 14);
    const adx14 = adxSeries(fc, 14);
    const crsi = crsiSeries(closes, 100);
    const { K: stK, D: stD } = stochRsiKD(closes);
    const obv = obvSeries(fc);
    const obvSma20 = smaSeries(obv, 20);

    let wins = 0, total = 0;
    for (let i = 110; i < fc.length - 1; i++) {
      const sig = fn(fc, i, { closes, sma20, bb, rsi3, rsi7, rsi14, mfi14, adx14, crsi, stK, stD, obv, obvSma20 });
      if (!sig) continue;
      const entry = fc[i].close, exit = fc[i+1].close;
      if ((sig==='BEAR' && exit < entry) || (sig==='BULL' && exit > entry)) wins++;
      total++;
    }
    if (total >= 5) wrs.push({ wr: wins/total, n: total });
  }
  if (wrs.length < 3) return { wr: 0, n: 0 };
  wrs.sort((a,b) => a.wr-b.wr);
  const mid = wrs[Math.floor(wrs.length/2)];
  return { wr: mid.wr, n: wrs.reduce((s,f)=>s+f.n,0), folds: wrs.length };
}

const COINS = {
  ETH: { symbol: 'ETH', gh: new Set([10,11,12,21]),       ext6: new Set([9,10,11,12,20,21]),      ext8: new Set([9,10,11,12,13,14,20,21]) },
  BTC: { symbol: 'BTC', gh: new Set([1,12,13,16,20]),     ext6: new Set([1,5,12,13,16,20]),        ext8: new Set([1,5,11,12,13,16,20,22]) },
  SOL: { symbol: 'SOL', gh: new Set([0,12,13,20]),        ext6: new Set([0,8,12,13,20,22]),        ext8: new Set([0,4,8,12,13,18,20,22]) },
  XRP: { symbol: 'XRP', gh: new Set([6,9,12,18]),         ext6: new Set([6,9,12,13,18,20]),        ext8: new Set([5,6,9,12,13,14,18,20]) },
};

function test(name, fn, minWr = 0.70) {
  const lines = [];
  let anyGood = false;
  for (const [coin, cfg] of Object.entries(COINS)) {
    try {
      const candles = loadCandles(cfg.symbol);
      if (candles.length < 500) { lines.push(`  ${coin}: insufficient data`); continue; }
      const r = walkForward(candles, (c, i, s) => fn(c, i, s, cfg.gh, cfg.ext6, cfg.ext8));
      const tpd = r.n / (candles.length / 288);
      const flags = [];
      if (r.wr >= 0.85) flags.push('85%+ WR!!!');
      else if (r.wr >= 0.75 && tpd >= 3) flags.push('🔥🔥🔥 GOAL MET!');
      else if (r.wr >= 0.75 && tpd >= 1) flags.push('🔥🔥🔥 >75%!');
      else if (r.wr >= 0.75) flags.push('🔥🔥🔥 >75%!');
      else if (tpd >= 3 && r.wr >= 0.68) flags.push('✅ GOOD VOL');
      if (r.wr >= minWr || tpd >= 3) anyGood = true;
      lines.push(`  ${coin}: WR=${(r.wr*100).toFixed(1)}% n=${r.n} tpd=${tpd.toFixed(1)} ${flags.join(' ')}`);
    } catch(e) { lines.push(`  ${coin}: ERR ${e.message.slice(0,50)}`); }
  }
  if (anyGood) { console.log(`\n${name}`); lines.forEach(l=>console.log(l)); }
  return { name, lines };
}

const results = [];
console.log('=== Session 16: Volume × WR Balance ===');
console.log('Goal: 3-5+ tpd AND >75% WR');
console.log('='.repeat(55));

// ─── SECTION A: BB(20,1.5) variants ──────────────────────────────────────────
console.log('\n── SECTION A: BB(20,1.5) × GH × Quality ──');

results.push(test('A1_GH+ADX20+RSI73+MFI72+BB15', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.mfi14[i]>72 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.mfi14[i]<28 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

results.push(test('A2_GH+ADX20+RSI73+MFI72+RSI14+BB15', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

results.push(test('A3_GH+ADX20+RSI3>90+MFI70+BB15', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

results.push(test('A4_GH+ADX20+RSI3>90+RSI7>70+MFI70+BB15', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.rsi7[i]>70 && s.mfi14[i]>70 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.rsi7[i]<30 && s.mfi14[i]<30 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

results.push(test('A5_GH+ADX20+CRSI>85+MFI72+BB15', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.crsi[i]>85 && s.mfi14[i]>72 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.crsi[i]<15 && s.mfi14[i]<28 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

results.push(test('A6_GH+ADX20+RSI3>93+RSI5>80+MFI70+BB15', (c,i,s,gh) => {
  // S14 H3 conditions but at tighter BB
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const rsi5=rsiSeries(c.map(x=>x.close),5);
  if (s.rsi3[i]>93 && rsi5[i]>80 && s.mfi14[i]>70 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.rsi3[i]<7 && rsi5[i]<20 && s.mfi14[i]<30 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

// ─── SECTION B: BB(20,1.3) variants ──────────────────────────────────────────
console.log('\n── SECTION B: BB(20,1.3) × GH × Quality ──');

results.push(test('B1_GH+ADX20+RSI73+MFI72+BB13', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.mfi14[i]>72 && cl>s.bb.u13[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.mfi14[i]<28 && cl<s.bb.l13[i]) return 'BULL';
  return null;
}));

results.push(test('B2_GH+ADX20+RSI73+MFI72+RSI14+BB13', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && cl>s.bb.u13[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && cl<s.bb.l13[i]) return 'BULL';
  return null;
}));

results.push(test('B3_GH+ADX20+RSI3>90+MFI70+BB13', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u13[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l13[i]) return 'BULL';
  return null;
}));

results.push(test('B4_GH+ADX20+CRSI>82+MFI70+BB13', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.crsi[i]>82 && s.mfi14[i]>70 && cl>s.bb.u13[i]) return 'BEAR';
  if (s.crsi[i]<18 && s.mfi14[i]<30 && cl<s.bb.l13[i]) return 'BULL';
  return null;
}));

// ─── SECTION C: Extended 6h Good Hours × Quality ─────────────────────────────
console.log('\n── SECTION C: Extended 6h Good Hours × BB22 Quality ──');

results.push(test('C1_ExtGH6+ADX20+RSI73+MFI72+RSI14+BB22', (c,i,s,gh,ext6) => {
  if (!ext6.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('C2_ExtGH6+ADX20+RSI3>90+MFI70+BB18', (c,i,s,gh,ext6) => {
  if (!ext6.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

results.push(test('C3_ExtGH6+ADX20+RSI3>90+MFI70+BB15', (c,i,s,gh,ext6) => {
  if (!ext6.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

results.push(test('C4_ExtGH6+ADX20+RSI73+MFI72+RSI14+BB18', (c,i,s,gh,ext6) => {
  if (!ext6.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

results.push(test('C5_ExtGH6+ADX20+CRSI>85+MFI72+BB22', (c,i,s,gh,ext6) => {
  if (!ext6.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.crsi[i]>85 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.crsi[i]<15 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('C6_ExtGH6+ADX20+RSI73+MFI72+BB15', (c,i,s,gh,ext6) => {
  if (!ext6.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.mfi14[i]>72 && cl>s.bb.u15[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.mfi14[i]<28 && cl<s.bb.l15[i]) return 'BULL';
  return null;
}));

// ─── SECTION D: ADX<22 (looser) ───────────────────────────────────────────────
console.log('\n── SECTION D: ADX<22 × GH × BB22 Quality ──');

results.push(test('D1_GH+ADX22+RSI73+MFI72+RSI14+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=22) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('D2_GH+ADX22+RSI3>93+RSI5>82+MFI70+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=22) return null;
  const cl=c[i].close;
  const rsi5=rsiSeries(c.map(x=>x.close),5);
  if (s.rsi3[i]>93 && rsi5[i]>82 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<7 && rsi5[i]<18 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('D3_GH+ADX22+RSI73+MFI72+RSI14+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=22) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

results.push(test('D4_GH+ADX22+RSI3>90+MFI70+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=22) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

// ─── SECTION E: 8-hour window × tight quality ────────────────────────────────
console.log('\n── SECTION E: 8h Good-Hours × BB22 ──');

results.push(test('E1_ExtGH8+ADX20+RSI73+MFI72+RSI14+BB22', (c,i,s,gh,ext6,ext8) => {
  if (!ext8.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('E2_ExtGH8+ADX20+RSI3>90+MFI70+BB18', (c,i,s,gh,ext6,ext8) => {
  if (!ext8.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

// ─── SECTION F: OBV trend confirmation at BB extremes ────────────────────────
// OBV is a strong mean-reversion signal: price at BB extreme AGAINST OBV trend = reversion
console.log('\n── SECTION F: OBV Divergence × BB × GH ──');

results.push(test('F1_GH+ADX20+OBVbear+RSI70+BB22', (c,i,s,gh) => {
  if (i < 22 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  // OBV bearish: OBV below its 20-SMA (distribution while price at upper BB)
  const obvBear = s.obv[i] < s.obvSma20[i];
  const obvBull = s.obv[i] > s.obvSma20[i];
  if (s.rsi7[i]>70 && s.mfi14[i]>70 && obvBear && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<30 && s.mfi14[i]<30 && obvBull && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('F2_GH+ADX20+OBVbear+RSI73+MFI72+BB22', (c,i,s,gh) => {
  if (i < 22 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const obvBear = s.obv[i] < s.obvSma20[i];
  const obvBull = s.obv[i] > s.obvSma20[i];
  if (s.rsi7[i]>73 && s.mfi14[i]>72 && obvBear && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.mfi14[i]<28 && obvBull && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('F3_GH+ADX20+OBVbear+RSI73+MFI72+RSI14+BB22', (c,i,s,gh) => {
  if (i < 22 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const obvBear = s.obv[i] < s.obvSma20[i];
  const obvBull = s.obv[i] > s.obvSma20[i];
  if (s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72 && obvBear && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28 && obvBull && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('F4_GH+ADX20+OBVbear+RSI73+MFI72+BB18', (c,i,s,gh) => {
  if (i < 22 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const obvBear = s.obv[i] < s.obvSma20[i];
  const obvBull = s.obv[i] > s.obvSma20[i];
  if (s.rsi7[i]>73 && s.mfi14[i]>72 && obvBear && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.mfi14[i]<28 && obvBull && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

// ─── SECTION G: StochRSI high extreme × BB × GH ──────────────────────────────
console.log('\n── SECTION G: StochRSI Extreme × BB × GH ──');

results.push(test('G1_GH+ADX20+StochK>88+D>82+MFI72+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.stK[i]>88 && s.stD[i]>82 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.stK[i]<12 && s.stD[i]<18 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('G2_GH+ADX20+StochK>85+D>80+RSI7>70+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.stK[i]>85 && s.stD[i]>80 && s.rsi7[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.stK[i]<15 && s.stD[i]<20 && s.rsi7[i]<30 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('G3_GH+ADX20+StochK>85+MFI72+RSI14+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.stK[i]>85 && s.mfi14[i]>72 && s.rsi14[i]>68 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.stK[i]<15 && s.mfi14[i]<28 && s.rsi14[i]<32 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('G4_GH+ADX20+StochK>85+MFI72+RSI14+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.stK[i]>85 && s.mfi14[i]>72 && s.rsi14[i]>68 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.stK[i]<15 && s.mfi14[i]<28 && s.rsi14[i]<32 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

results.push(test('G5_ExtGH6+ADX20+StochK>85+D>80+MFI72+BB22', (c,i,s,gh,ext6) => {
  if (!ext6.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.stK[i]>85 && s.stD[i]>80 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.stK[i]<15 && s.stD[i]<20 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

// ─── SECTION H: Combining multiple strategies as one unified signal ───────────
// "Union" of two confirmed patterns → more volume, does WR blend stay high?
console.log('\n── SECTION H: Union Signals (OR of top patterns) × GH ──');

results.push(test('H1_GH+ADX20+(RSI3_93+RSI5_82+MFI70 OR CRSI85+MFI72)+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const rsi5=rsiSeries(c.map(x=>x.close),5);
  // Pattern 1: triple RSI (strat97 conditions)
  const p1Bear = s.rsi3[i]>93 && rsi5[i]>82 && s.mfi14[i]>70;
  const p1Bull = s.rsi3[i]<7 && rsi5[i]<18 && s.mfi14[i]<30;
  // Pattern 2: CRSI+MFI (strat99 conditions)
  const p2Bear = s.crsi[i]>85 && s.mfi14[i]>72;
  const p2Bull = s.crsi[i]<15 && s.mfi14[i]<28;
  if ((p1Bear||p2Bear) && cl>s.bb.u22[i]) return 'BEAR';
  if ((p1Bull||p2Bull) && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('H2_GH+ADX20+(RSI73+MFI72+RSI14 OR RSI3_93+MFI72)+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const p1Bear = s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72;
  const p1Bull = s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28;
  const p2Bear = s.rsi3[i]>93 && s.mfi14[i]>72;
  const p2Bull = s.rsi3[i]<7 && s.mfi14[i]<28;
  if ((p1Bear||p2Bear) && cl>s.bb.u22[i]) return 'BEAR';
  if ((p1Bull||p2Bull) && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('H3_GH+ADX20+(RSI73+MFI72+RSI14 OR CRSI85+MFI72 OR RSI3_90+MFI70)+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const p1Bear = s.rsi7[i]>73 && s.rsi14[i]>68 && s.mfi14[i]>72;
  const p1Bull = s.rsi7[i]<27 && s.rsi14[i]<32 && s.mfi14[i]<28;
  const p2Bear = s.crsi[i]>85 && s.mfi14[i]>72;
  const p2Bull = s.crsi[i]<15 && s.mfi14[i]<28;
  const p3Bear = s.rsi3[i]>90 && s.mfi14[i]>70;
  const p3Bull = s.rsi3[i]<10 && s.mfi14[i]<30;
  if ((p1Bear||p2Bear||p3Bear) && cl>s.bb.u18[i]) return 'BEAR';
  if ((p1Bull||p2Bull||p3Bull) && cl<s.bb.l18[i]) return 'BULL';
  return null;
}));

// ─── SECTION I: Price velocity / momentum fade ───────────────────────────────
// Large % move in 1-3 candles + oscillator extreme = exhaustion
console.log('\n── SECTION I: Candle Velocity Exhaustion × GH ──');

results.push(test('I1_GH+ADX20+3bar_pct>0.4+RSI7>72+BB22', (c,i,s,gh) => {
  if (i<3 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const move3 = (cl - c[i-3].close) / c[i-3].close * 100;
  if (move3>0.4 && s.rsi7[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (move3<-0.4 && s.rsi7[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('I2_GH+ADX20+3bar_pct>0.4+RSI7>72+MFI72+BB22', (c,i,s,gh) => {
  if (i<3 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const move3 = (cl - c[i-3].close) / c[i-3].close * 100;
  if (move3>0.4 && s.rsi7[i]>72 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (move3<-0.4 && s.rsi7[i]<28 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('I3_GH+ADX20+2bar_pct>0.3+RSI3>90+BB22', (c,i,s,gh) => {
  if (i<2 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const move2 = (cl - c[i-2].close) / c[i-2].close * 100;
  if (move2>0.3 && s.rsi3[i]>90 && cl>s.bb.u22[i]) return 'BEAR';
  if (move2<-0.3 && s.rsi3[i]<10 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

// ─── SECTION J: RSI divergence — price up but RSI flat/down ──────────────────
// Classic divergence: price makes higher high but RSI makes lower high = exhaustion
console.log('\n── SECTION J: RSI Divergence × BB × GH ──');

results.push(test('J1_GH+ADX20+PriceDiv3bar+RSI7+BB22', (c,i,s,gh) => {
  if (i<4 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  // Bearish div: price higher than 3 bars ago, RSI lower → exhaustion
  const priceBull = cl > c[i-3].close;
  const rsiBear  = s.rsi7[i] < s.rsi7[i-3];
  const priceBear = cl < c[i-3].close;
  const rsiBull  = s.rsi7[i] > s.rsi7[i-3];
  if (priceBull && rsiBear && s.rsi7[i]>65 && cl>s.bb.u22[i]) return 'BEAR';
  if (priceBear && rsiBull && s.rsi7[i]<35 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(test('J2_GH+ADX20+PriceDiv3bar+RSI7+MFI72+BB22', (c,i,s,gh) => {
  if (i<4 || !gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  const priceBull = cl > c[i-3].close, rsiBear = s.rsi7[i] < s.rsi7[i-3];
  const priceBear = cl < c[i-3].close, rsiBull = s.rsi7[i] > s.rsi7[i-3];
  if (priceBull && rsiBear && s.rsi7[i]>65 && s.mfi14[i]>72 && cl>s.bb.u22[i]) return 'BEAR';
  if (priceBear && rsiBull && s.rsi7[i]<35 && s.mfi14[i]<28 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}));

// ─── FINAL SUMMARY ────────────────────────────────────────────────────────────
console.log('\n\n' + '='.repeat(55));
console.log('=== WINNERS: WR≥75% OR tpd≥3 ===');
console.log('='.repeat(55));

for (const r of results) {
  const lines = r.lines || [];
  const winners = lines.filter(l => {
    const m = l.match(/WR=(\d+\.\d+)%.*tpd=(\d+\.\d+)/);
    if (!m) return false;
    return parseFloat(m[1]) >= 75 || parseFloat(m[2]) >= 3;
  });
  if (winners.length > 0) {
    console.log(`\n${r.name || r}`);
    winners.forEach(l => console.log(l));
  }
}

console.log('\n=== GOAL MET: tpd>=3 AND WR>=75% ===');
let goalMet = false;
for (const r of results) {
  const lines = r.lines || [];
  const hv = lines.filter(l => {
    const m = l.match(/WR=(\d+\.\d+)%.*tpd=(\d+\.\d+)/);
    return m && parseFloat(m[1]) >= 75 && parseFloat(m[2]) >= 3;
  });
  if (hv.length > 0) {
    console.log(`\n${r.name || r}`);
    hv.forEach(l => console.log(l));
    goalMet = true;
  }
}
if (!goalMet) console.log('No strategy met tpd>=3 AND WR>=75% simultaneously');
