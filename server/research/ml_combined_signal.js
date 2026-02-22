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
function kmeans(data, k, maxIter) {
  if (!maxIter) maxIter = 150;
  const n = data.length, m = data[0].length;
  // k-means++ initialization: spread centroids apart
  const step = Math.floor(n / (k + 1));
  let centroids = [];
  for (let c = 0; c < k; c++) centroids.push([...data[step * (c + 1)]]);
  let assignments = new Array(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity, best = 0;
      for (let c = 0; c < k; c++) {
        const dist = data[i].reduce((s, x, j) => s + (x - centroids[c][j]) ** 2, 0);
        if (dist < minDist) { minDist = dist; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    if (!changed) break;
    for (let c = 0; c < k; c++) {
      const pts = [];
      for (let i = 0; i < n; i++) if (assignments[i] === c) pts.push(data[i]);
      if (pts.length) for (let j = 0; j < m; j++) centroids[c][j] = pts.reduce((s, p) => s + p[j], 0) / pts.length;
    }
  }
  return { assignments, centroids };
}
function zNorm1D(arr) {
  const vals = arr.filter(v => v !== null && !isNaN(v) && isFinite(v));
  if (!vals.length) return arr.map(() => 0);
  const mean = vals.reduce((a,b)=>a+b,0)/vals.length;
  const std = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/vals.length) || 1;
  return arr.map(v => (v===null||isNaN(v)||!isFinite(v)) ? 0 : (v-mean)/std);
}
function walkForward(signals, nFolds) {
  if (!nFolds) nFolds = 3;
  const sz = Math.floor(signals.length / nFolds), results = [];
  for (let f = 0; f < nFolds; f++) {
    const s = f * sz, e = (f === nFolds - 1) ? signals.length : s + sz;
    const fold = signals.slice(s, e);
    results.push({ wr: fold.filter(x => x.win).length / fold.length * 100, n: fold.length });
  }
  const wrs = results.map(r => r.wr), avg = wrs.reduce((a, b) => a + b, 0) / nFolds;
  const sigma = Math.sqrt(wrs.reduce((a, b) => a + (b - avg) ** 2, 0) / nFolds);
  const foldStr = results.map(r => r.wr.toFixed(1)+"-T"+r.n).join("/");
  return { avg, sigma, total: signals.length, str: "WR="+avg.toFixed(1)+"% sg="+sigma.toFixed(1)+"% T="+signals.length+" ["+foldStr+"]" };
}
function calcMFI(c,period){if(!period)period=14;const mfi=new Array(c.length).fill(null);const tp=c.map(x=>(x.high+x.low+x.close)/3);for(let i=period;i<c.length;i++){let pF=0,nF=0;for(let j=i-period+1;j<=i;j++){const fl=tp[j]*c[j].volume;if(tp[j]>tp[j-1])pF+=fl;else nF+=fl;}mfi[i]=nF===0?100:100-100/(1+pF/nF);}return mfi;}
function runCombined(candles,label,gH){
  const sep='='.repeat(65);
  console.log(sep);
  console.log('COMBINED ML STRATEGIES: '+label);
  console.log(sep);
  const features=buildFeatures(candles);
  const closes=candles.map(c=>c.close),opens=candles.map(c=>c.open);
  const bb22=calcBB(closes,20,2.2);
  const r14=calcRSI(closes,14),r7=calcRSI(closes,7);
  const sk=calcStochK(candles,14);
  const cci=calcCCI(candles,14);
  const mfi=calcMFI(candles,10);
  const atr=calcATR(candles,14);
  const str=[closes[0]>opens[0]?1:-1];
  for(let i=1;i<candles.length;i++){const g=closes[i]>opens[i],pg=closes[i-1]>opens[i-1];str.push((g===pg)?(g?str[i-1]+1:str[i-1]-1):(g?1:-1));}
  const dH={},dL={};
  for(let i=0;i<candles.length;i++){const d=Math.floor(candles[i].open_time/86400000);if(!dH[d]){dH[d]=candles[i].high;dL[d]=candles[i].low;}else{dH[d]=Math.max(dH[d],candles[i].high);dL[d]=Math.min(dL[d],candles[i].low);}}
  const aVals=atr.filter(v=>v!==null).sort((a,b)=>a-b);
  const aP33=aVals[Math.floor(aVals.length*0.33)];
  const aP67=aVals[Math.floor(aVals.length*0.67)];
  function applyStrat(name,filter){
    const sigs=[];
    for(let i=1;i<candles.length-1;i++){
      const hour=new Date(candles[i].open_time).getUTCHours();
      if(!gH.includes(hour))continue;
      const bb=bb22[i];if(!bb)continue;
      const sig=filter(i,bb);
      if(sig)sigs.push(sig);
    }
    if(sigs.length>=20){const wf=walkForward(sigs);console.log(name+": "+wf.str);}
    else if(sigs.length>=5){const wr=sigs.filter(s=>s.win).length/sigs.length*100;console.log(name+": WR="+wr.toFixed(1)+"% T="+sigs.length+" (no WF)");}
    else console.log(name+": T="+sigs.length+" (too few)");
    return sigs;
  }
  applyStrat("StratA RSI+Stoch+BB",(i,bb)=>{const r=r14[i],s2=sk[i];if(r===null||s2===null)return null;if(r>65&&s2>70&&closes[i]>bb.upper)return{win:closes[i+1]<opens[i+1],dir:"BEAR"};if(r<35&&s2<30&&closes[i]<bb.lower)return{win:closes[i+1]>opens[i+1],dir:"BULL"};return null;});
  applyStrat("StratB LowATR+CCI+BB",(i,bb)=>{const ci=cci[i],ai=atr[i];if(ci===null||ai===null)return null;if(ai<=aP33&&ci>100&&closes[i]>bb.upper)return{win:closes[i+1]<opens[i+1],dir:"BEAR"};if(ai<=aP33&&ci<-100&&closes[i]<bb.lower)return{win:closes[i+1]>opens[i+1],dir:"BULL"};return null;});
  applyStrat("StratC DailyRange+RSI7+BB",(i,bb)=>{const r=r7[i];if(r===null)return null;const d2=Math.floor(candles[i].open_time/86400000);const dr=dH[d2]-dL[d2];if(dr<=0)return null;const drP=(closes[i]-dL[d2])/dr;if(drP>=0.7&&r>65&&closes[i]>bb.upper)return{win:closes[i+1]<opens[i+1],dir:"BEAR"};if(drP<=0.3&&r<35&&closes[i]<bb.lower)return{win:closes[i+1]>opens[i+1],dir:"BULL"};return null;});
  applyStrat("StratD MFI+RSI7+s>=2+BB",(i,bb)=>{const m=mfi[i],r=r7[i];if(m===null||r===null)return null;if(Math.abs(str[i])<2)return null;if(m>80&&r>65&&closes[i]>bb.upper)return{win:closes[i+1]<opens[i+1],dir:"BEAR"};if(m<20&&r<35&&closes[i]<bb.lower)return{win:closes[i+1]>opens[i+1],dir:"BULL"};return null;});
  applyStrat("StratE RSI7+Stoch+s>=3 sniper",(i,bb)=>{const r=r7[i],s2=sk[i];if(r===null||s2===null)return null;if(Math.abs(str[i])<3)return null;if(r>70&&s2>75&&closes[i]>bb.upper)return{win:closes[i+1]<opens[i+1],dir:"BEAR"};if(r<30&&s2<25&&closes[i]<bb.lower)return{win:closes[i+1]>opens[i+1],dir:"BULL"};return null;});
  applyStrat("StratF VWAP+RSI14+BB",(i,bb)=>{const r=r14[i],feat=features[i];if(r===null||feat.vwapDist===null)return null;if(feat.vwapDist>0.002&&r>65&&closes[i]>bb.upper)return{win:closes[i+1]<opens[i+1],dir:"BEAR"};if(feat.vwapDist<-0.002&&r<35&&closes[i]<bb.lower)return{win:closes[i+1]>opens[i+1],dir:"BULL"};return null;});
  applyStrat("StratG HighVol+RSI7+BB",(i,bb)=>{const r=r7[i],ai=atr[i];if(r===null||ai===null)return null;if(ai>=aP67&&r>70&&closes[i]>bb.upper)return{win:closes[i+1]<opens[i+1],dir:"BEAR"};if(ai>=aP67&&r<30&&closes[i]<bb.lower)return{win:closes[i+1]>opens[i+1],dir:"BULL"};return null;});
}
const eth5m=getCandles('ETH','5m');
runCombined(eth5m,'ETH/5m',[10,11,12,21]);
const eth15=synth15m(eth5m);
runCombined(eth15,'ETH/15m synth',[10,11,12,21]);
const sol5m=getCandles('SOL','5m');
runCombined(sol5m,'SOL/5m',[0,12,13,20]);
const sol15=synth15m(sol5m);
runCombined(sol15,'SOL/15m synth',[0,12,13,20]);
db.close();