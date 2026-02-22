'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

// === FEATURE IMPORTANCE via Mutual Information ===
// Computes MI of 30+ features vs next-candle direction for ETH/5m, ETH/15m synth, SOL/5m, SOL/15m synth

function getCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(sym, tf);
}
function calcBB(closes, period, mult) {
  const bands = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { bands.push(null); continue; }
    const sl = closes.slice(i - period + 1, i + 1);
    const mean = sl.reduce((a, b) => a + b, 0) / period;
    const variance = sl.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    bands.push({ upper: mean + mult * std, lower: mean - mult * std, mid: mean, std });
  }
  return bands;
}
function calcRSI(closes, period) {
  if (!period) period = 14;
  const rsi = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) gains += d; else losses -= d; }
  let ag = gains / period, al = losses / period;
  rsi[period] = 100 - 100 / (1 + (al === 0 ? Infinity : ag / al));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = 100 - 100 / (1 + (al === 0 ? Infinity : ag / al));
  }
  return rsi;
}
function calcATR(candles, period) {
  if (!period) period = 14;
  const atr = new Array(candles.length).fill(null); let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
    if (i < period) sum += tr;
    else if (i === period) { sum += tr; atr[i] = sum / period; }
    else atr[i] = (atr[i-1] * (period - 1) + tr) / period;
  }
  return atr;
}
function calcStochK(candles, period) {
  if (!period) period = 14;
  const k = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { hh = Math.max(hh, candles[j].high); ll = Math.min(ll, candles[j].low); }
    const rng = hh - ll;
    k[i] = rng === 0 ? 50 : (candles[i].close - ll) / rng * 100;
  }
  return k;
}
function calcCCI(candles, period) {
  if (!period) period = 14;
  const cci = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let tpSum = 0; const tps = [];
    for (let j = i - period + 1; j <= i; j++) { const tp2 = (candles[j].high + candles[j].low + candles[j].close) / 3; tps.push(tp2); tpSum += tp2; }
    const mean = tpSum / period;
    const mad = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    const ctp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    cci[i] = mad === 0 ? 0 : (ctp - mean) / (0.015 * mad);
  }
  return cci;
}
function synth15m(c5) {
  const r = [];
  for (let i = 2; i < c5.length; i += 3) {
    const c0 = c5[i-2], c1 = c5[i-1], c2 = c5[i];
    r.push({ open_time: c0.open_time, open: c0.open, high: Math.max(c0.high,c1.high,c2.high), low: Math.min(c0.low,c1.low,c2.low), close: c2.close, volume: c0.volume+c1.volume+c2.volume });
  }
  return r;
}
function mutualInfo(feature, labels, bins) {
  if (!bins) bins = 10;
  const vi = [];
  for (let i = 0; i < feature.length; i++) { if (feature[i] !== null && !isNaN(feature[i]) && labels[i] !== null) vi.push(i); }
  if (vi.length === 0) return 0;
  const f = vi.map(i => feature[i]), l = vi.map(i => labels[i]);
  const mn = Math.min(...f), mx = Math.max(...f), rng = mx - mn || 1;
  const bf = v => Math.min(bins - 1, Math.floor((v - mn) / rng * bins));
  const n = f.length, pxy = {}, px = {}, py = {};
  for (let i = 0; i < n; i++) { const x = bf(f[i]), y = l[i], key = x + '_' + y; pxy[key] = (pxy[key] || 0) + 1/n; px[x] = (px[x] || 0) + 1/n; py[y] = (py[y] || 0) + 1/n; }
  let mi = 0;
  for (const key of Object.keys(pxy)) { const pt = key.split('_'); const joint = pxy[key], mX = px[pt[0]], mY = py[pt[1]]; if (joint > 0) mi += joint * Math.log2(joint / (mX * mY)); }
  return mi;
}
function buildFeatures(candles) {
  const closes = candles.map(c => c.close), opens = candles.map(c => c.open);
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low), vols = candles.map(c => c.volume);
  const rsi14 = calcRSI(closes, 14), rsi7 = calcRSI(closes, 7), rsi21 = calcRSI(closes, 21);
  const atr14 = calcATR(candles, 14), atr10 = calcATR(candles, 10);
  const bb2020 = calcBB(closes, 20, 2.0), bb2022 = calcBB(closes, 20, 2.2), bb1522 = calcBB(closes, 15, 2.2);
  const stochK = calcStochK(candles, 14), cci14 = calcCCI(candles, 14);
  const va = new Array(candles.length).fill(null);
  for (let i = 19; i < candles.length; i++) { let s = 0; for (let j = i-19; j <= i; j++) s += vols[j]; va[i] = s / 20; }
  const vwap = new Array(candles.length).fill(null);
  let vn = 0, vd = 0, ld = -1;
  for (let i = 0; i < candles.length; i++) {
    const day = Math.floor(candles[i].open_time / 86400000);
    if (day !== ld) { vn = 0; vd = 0; ld = day; }
    const tp = (highs[i] + lows[i] + closes[i]) / 3; vn += tp * vols[i]; vd += vols[i]; vwap[i] = vd > 0 ? vn / vd : closes[i];
  }
  const streak = new Array(candles.length).fill(0);
  streak[0] = closes[0] > opens[0] ? 1 : -1;
  for (let i = 1; i < candles.length; i++) { const g = closes[i] > opens[i], pg = closes[i-1] > opens[i-1]; streak[i] = (g === pg) ? (g ? streak[i-1]+1 : streak[i-1]-1) : (g ? 1 : -1); }
  const pat3 = new Array(candles.length).fill(null);
  for (let i = 2; i < candles.length; i++) { const g0=closes[i]>opens[i]?1:0, g1=closes[i-1]>opens[i-1]?1:0, g2=closes[i-2]>opens[i-2]?1:0; pat3[i]=g2*4+g1*2+g0; }
  const dH = {}, dL = {};
  for (let i = 0; i < candles.length; i++) { const d=Math.floor(candles[i].open_time/86400000); if (!dH[d]) {dH[d]=candles[i].high;dL[d]=candles[i].low;} else {dH[d]=Math.max(dH[d],candles[i].high);dL[d]=Math.min(dL[d],candles[i].low);} }
  const features = [];
  for (let i = 0; i < candles.length; i++) {
    const body = Math.abs(closes[i]-opens[i]), bR = opens[i]>0?body/opens[i]:0;
    const uw = highs[i]-Math.max(opens[i],closes[i]), lw = Math.min(opens[i],closes[i])-lows[i];
    const wru = body>0?uw/body:0, wrl = body>0?lw/body:0, isG = closes[i]>opens[i]?1:0;
    const hour = new Date(candles[i].open_time).getUTCHours(), dow = new Date(candles[i].open_time).getUTCDay();
    const b20=bb2020[i],b22=bb2022[i],b15=bb1522[i];
    const bw20=b20?b20.upper-b20.lower:0;
    const bP20=b20&&bw20>0?(closes[i]-b20.lower)/bw20:null;
    const bP22=b22&&(b22.upper-b22.lower)>0?(closes[i]-b22.lower)/(b22.upper-b22.lower):null;
    const bP15=b15&&(b15.upper-b15.lower)>0?(closes[i]-b15.lower)/(b15.upper-b15.lower):null;
    const bDu20=b20&&closes[i]>b20.upper?(closes[i]-b20.upper)/b20.upper:0;
    const bDl20=b20&&closes[i]<b20.lower?(b20.lower-closes[i])/b20.lower:0;
    const bDu22=b22&&closes[i]>b22.upper?(closes[i]-b22.upper)/b22.upper:0;
    const bW20=b20&&b20.mid>0?bw20/b20.mid:null;
    const na14=atr14[i]&&closes[i]>0?atr14[i]/closes[i]:null;
    const na10=atr10[i]&&closes[i]>0?atr10[i]/closes[i]:null;
    const bar=atr14[i]&&atr14[i]>0?body/atr14[i]:null;
    const vr=va[i]&&va[i]>0?vols[i]/va[i]:null;
    const vd2=vwap[i]&&vwap[i]>0?(closes[i]-vwap[i])/vwap[i]:null;
    const d2=Math.floor(candles[i].open_time/86400000),dr=dH[d2]-dL[d2],drP=dr>0?(closes[i]-dL[d2])/dr:0.5;
    features.push({ rsi14:rsi14[i],rsi7:rsi7[i],rsi21:rsi21[i],stochK:stochK[i],cci14:cci14[i],
      bbPos2020:bP20,bbPos2022:bP22,bbPos1522:bP15,bbDev2020up:bDu20,bbDev2020dn:bDl20,bbDev2022up:bDu22,
      bbWidth2020:bW20,normAtr14:na14,normAtr10:na10,bodyAtrRatio:bar,bodyRatio:bR,
      upperWick:wru,lowerWick:wrl,volRatio:vr,vwapDist:vd2,hour:hour,dow:dow,isGreen:isG,
      streakAbs:Math.abs(streak[i]),streakSign:streak[i]>0?1:-1,pattern3:pat3[i],dailyRangePos:drP });
  }
  return features;
}
function analyzeDataset(candles, label) {
  const sep = "=".repeat(60);
  console.log("");
  console.log(sep);
  console.log('FEATURE IMPORTANCE: ' + label);
  console.log(sep);
  console.log('Total candles: ' + candles.length);
  const features = buildFeatures(candles);
  const closes = candles.map(c => c.close), opens = candles.map(c => c.open);
  const labels = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length-1; i++) labels[i] = closes[i+1]>opens[i+1]?1:0;
  const miScores = {};
  for (const fname of Object.keys(features[0])) miScores[fname] = mutualInfo(features.map(f => f[fname]), labels.slice(0, features.length));
  const sorted = Object.entries(miScores).sort((a, b) => b[1] - a[1]);
  console.log('Top 20 features by Mutual Information:');
  console.log('Rank  Feature                MI Score');
  console.log('-'.repeat(50));
  sorted.slice(0, 20).forEach(([name, mi], rank) => { console.log('  '+String(rank+1).padStart(2)+'  '+name.padEnd(23)+'  '+mi.toFixed(6)); });
  console.log('Correlation of top 10 features with next-candle direction:');
  sorted.slice(0, 10).forEach(([name]) => {
    const pairs = [];
    for (let i = 0; i < features.length; i++) { const v = features[i][name]; if (v!==null && !isNaN(v) && labels[i]!==null) pairs.push([v, labels[i]]); }
    const n = pairs.length, mf = pairs.reduce((s,p)=>s+p[0],0)/n, ml2 = pairs.reduce((s,p)=>s+p[1],0)/n;
    let cov=0,vf=0,vl2=0;
    for (const [f2,l2] of pairs) { cov+=(f2-mf)*(l2-ml2); vf+=(f2-mf)**2; vl2+=(l2-ml2)**2; }
    const corr = vf*vl2>0 ? cov/Math.sqrt(vf*vl2) : 0;
    console.log('  '+name.padEnd(23)+': corr='+corr.toFixed(4)+' ('+(corr>0?'pos':'neg')+')'); 
  });
  return { sorted, features, labels };
}
const results = {};
const eth5m = getCandles('ETH','5m');
results['ETH/5m'] = analyzeDataset(eth5m, 'ETH/5m');
const eth15 = synth15m(eth5m);
results['ETH/15m synth'] = analyzeDataset(eth15, 'ETH/15m synth');
const sol5m = getCandles('SOL','5m');
results['SOL/5m'] = analyzeDataset(sol5m, 'SOL/5m');
const sol15 = synth15m(sol5m);
results['SOL/15m synth'] = analyzeDataset(sol15, 'SOL/15m synth');
const allF = {};
for (const r of Object.values(results)) r.sorted.slice(0,15).forEach(([n]) => { allF[n]=true; });
const dsNames = Object.keys(results);
const avgRanks = Object.keys(allF).map(fname => {
  let tot=0; const ranks={};
  for (const ds of dsNames) { const idx=results[ds].sorted.findIndex(([n])=>n===fname); ranks[ds]=idx>=0?idx+1:99; tot+=ranks[ds]; }
  return { name:fname, avgRank:tot/dsNames.length, ranks };
}).sort((a,b)=>a.avgRank-b.avgRank);
const sep2 = "=".repeat(70);
console.log(sep2);
console.log('CROSS-DATASET TOP FEATURE SUMMARY');
console.log(sep2);
console.log('Feature                | AvgR | ETH/5m | ETH/15ms | SOL/5m | SOL/15ms');
console.log('-'.repeat(75));
avgRanks.slice(0, 20).forEach(({name, avgRank, ranks}) => {
  const r = ranks;
  const e5=String(r['ETH/5m']||'-').padEnd(7),e15=String(r['ETH/15m synth']||'-').padEnd(9),s5=String(r['SOL/5m']||'-').padEnd(7),s15=String(r['SOL/15m synth']||'-');
  console.log(name.padEnd(23)+'| '+avgRank.toFixed(1).padEnd(4)+'| '+e5+'| '+e15+'| '+s5+'| '+s15);
});
db.close();