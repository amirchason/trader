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
function logisticRegression(X, y, lr, epochs) {
  if (!lr) lr = 0.01; if (!epochs) epochs = 500;
  const n = X.length, m = X[0].length;
  const w = new Array(m).fill(0); let bias = 0;
  const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
  for (let e = 0; e < epochs; e++) {
    let db = 0; const dw = new Array(m).fill(0);
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], bias);
      const pred = sigmoid(z), err = pred - y[i];
      db += err;
      for (let j = 0; j < m; j++) dw[j] += err * X[i][j];
    }
    bias -= lr * db / n;
    for (let j = 0; j < m; j++) w[j] -= lr * dw[j] / n;
  }
  return { weights: w, bias, sigmoid };
}
function zNormalize(X) {
  const m = X[0].length;
  const means = new Array(m).fill(0), stds = new Array(m).fill(1);
  for (let j = 0; j < m; j++) {
    const vals = X.map(row => row[j]).filter(v => !isNaN(v) && isFinite(v));
    if (!vals.length) continue;
    means[j] = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - means[j]) ** 2, 0) / vals.length;
    stds[j] = Math.sqrt(variance) || 1;
  }
  const Xnorm = X.map(row => row.map((v, j) => (isNaN(v) || !isFinite(v)) ? 0 : (v - means[j]) / stds[j]));
  return { Xnorm, means, stds };
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
  const foldStr = results.map(r => r.wr.toFixed(1)+"["+ r.n+"]").join("/");
  return { avg, sigma, folds: results, total: signals.length, str: "WR="+avg.toFixed(1)+"% σ="+sigma.toFixed(1)+"% T="+signals.length+" ["+foldStr+"]" };
}
function runLogisticAnalysis(candles, label) {
  const sep = "=".repeat(60);
  console.log(sep);
  console.log('LOGISTIC REGRESSION: ' + label);
  console.log(sep);
  const featureNames = ["rsi7","rsi14","rsi21","stochK","cci14","bbPos2020","bbPos1522","bbDev2020up","bbDev2020dn","bbWidth2020","normAtr14","bodyAtrRatio","bodyRatio","volRatio","vwapDist","streakAbs","streakSign","isGreen","pattern3","dailyRangePos"];
  const features = buildFeatures(candles);
  const closes = candles.map(c => c.close), opens = candles.map(c => c.open);
  const labels = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length-1; i++) labels[i] = closes[i+1]>opens[i+1]?1:0;
  const X = [], y = [];
  for (let i = 0; i < features.length - 1; i++) {
    if (labels[i] === null) continue;
    const row = featureNames.map(fn => { const v = features[i][fn]; return (v===null||isNaN(v)) ? 0 : v; });
    X.push(row); y.push(labels[i]);
  }
  const splitIdx = Math.floor(X.length * 0.7);
  const Xtrain = X.slice(0, splitIdx), ytrain = y.slice(0, splitIdx);
  const Xtest = X.slice(splitIdx), ytest = y.slice(splitIdx);
  const { Xnorm: XtrainN, means, stds } = zNormalize(Xtrain);
  const XtestN = Xtest.map(row => row.map((v, j) => (v - means[j]) / stds[j]));
  const model = logisticRegression(XtrainN, ytrain, 0.05, 300);
  const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
  const probs = XtestN.map(row => { const z = row.reduce((s, x, j) => s + x * model.weights[j], model.bias); return sigmoid(z); });
  const sorted = model.weights.map((w, j) => ({ name: featureNames[j], w })).sort((a,b) => Math.abs(b.w) - Math.abs(a.w));
  console.log('Top feature weights (sorted by |weight|):');
  sorted.slice(0, 10).forEach(({name, w}) => {
    console.log('  '+name.padEnd(20)+': '+w.toFixed(4)+' ('+(w>0?'BULL bias':'BEAR bias')+')'); 
  });
  const thresholds = [0.58, 0.60, 0.62, 0.65];
  for (const thresh of thresholds) {
    const bearThresh = 1 - thresh;
    const signals = [];
    for (let i = 0; i < probs.length; i++) {
      if (probs[i] >= thresh) { signals.push({ win: ytest[i] === 1, dir: "BULL", prob: probs[i] }); }
      else if (probs[i] <= bearThresh) { signals.push({ win: ytest[i] === 0, dir: "BEAR", prob: probs[i] }); }
    }
    if (signals.length < 20) continue;
    const wf = walkForward(signals);
    console.log('Threshold='+thresh+': '+wf.str);
  }
  const GOOD_HOURS_ETH = [10, 11, 12, 21];
  const goodHourSignals = [];
  const allIdxs = [];
  for (let i = splitIdx; i < features.length - 1; i++) allIdxs.push(i - splitIdx);
  for (let i = 0; i < probs.length; i++) {
    const origIdx = splitIdx + i;
    if (origIdx >= candles.length - 1) continue;
    const hour = new Date(candles[origIdx].open_time).getUTCHours();
    const isGoodHour = label.includes("ETH") ? GOOD_HOURS_ETH.includes(hour) : [0,12,13,20].includes(hour);
    if (probs[i] >= 0.60 && isGoodHour) goodHourSignals.push({ win: ytest[i] === 1, dir: "BULL" });
    else if (probs[i] <= 0.40 && isGoodHour) goodHourSignals.push({ win: ytest[i] === 0, dir: "BEAR" });
  }
  if (goodHourSignals.length >= 20) {
    const wf2 = walkForward(goodHourSignals);
    console.log('GoodHour+LR(0.60/0.40): '+wf2.str);
  } else {
    console.log('GoodHour+LR: insufficient signals (' + goodHourSignals.length + ')');
  }
  return { model, probs, means, stds, featureNames };
}

const eth5m = getCandles('ETH','5m');
console.log('--- ETH/5m ---');
runLogisticAnalysis(eth5m, 'ETH/5m');
const eth15 = synth15m(eth5m);
console.log('--- ETH/15m synth ---');
runLogisticAnalysis(eth15, 'ETH/15m synth');
const sol5m = getCandles('SOL','5m');
console.log('--- SOL/5m ---');
runLogisticAnalysis(sol5m, 'SOL/5m');
const sol15 = synth15m(sol5m);
console.log('--- SOL/15m synth ---');
runLogisticAnalysis(sol15, 'SOL/15m synth');
db.close();