'use strict';
// ETH RSI Bull (complement to RSI Panic): RSI<30 + BB lower + GoodH → BULL
// Also test ETH/15m RSI Panic
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

function getCandles(symbol, timeframe) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(symbol, timeframe);
}
function calcBB(closes, period, mult) {
  const bands = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { bands.push(null); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    bands.push({ upper: mean + mult * std, lower: mean - mult * std, mid: mean, std });
  }
  return bands;
}
function calcRSI(closes, period) {
  const rsi = new Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d=closes[i]-closes[i-1]; if(d>0)ag+=d; else al-=d; }
  ag/=period; al/=period;
  rsi[period]=100-100/(1+(al===0?Infinity:ag/al));
  for (let i=period+1; i<closes.length; i++) {
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+Math.max(d,0))/period; al=(al*(period-1)+Math.max(-d,0))/period;
    rsi[i]=100-100/(1+(al===0?Infinity:ag/al));
  }
  return rsi;
}
function synth15m(c5) {
  const r=[];
  for (let i=2;i<c5.length;i+=3) {
    const g=[c5[i-2],c5[i-1],c5[i]];
    r.push({open_time:g[0].open_time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[2].close,volume:g.reduce((s,x)=>s+x.volume,0)});
  }
  return r;
}
function walkForward(signals, nFolds=3) {
  const sz=Math.floor(signals.length/nFolds), res=[];
  for (let f=0;f<nFolds;f++) {
    const fold=signals.slice(f*sz,f===nFolds-1?signals.length:(f+1)*sz);
    res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});
  }
  const wrs=res.map(r=>r.wr), avg=wrs.reduce((a,b)=>a+b,0)/nFolds;
  return {avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nFolds),folds:res,total:signals.length};
}

const GOOD_HOURS_5M = new Set([10,11,12,21]);
const GOOD_HOURS_15M = new Set([10,11,12,21]);

// ── 5m BULL (RSI oversold) ──
const candles5m = getCandles('ETH','5m');
const closes5m = candles5m.map(c=>c.close);
console.log('=== ETH RSI Bull + Panic (5m + 15m synth) ===\n');
console.log('--- ETH/5m RSI < threshold + BB lower + GoodH → BULL ---');
const rsi5 = calcRSI(closes5m, 14);
for (const thresh of [30, 35, 40]) {
  for (const [bbP, bbM] of [[20,2.2],[20,2.0]]) {
    for (const goodH of [true, false]) {
      const bb = calcBB(closes5m, bbP, bbM);
      const signals = [];
      for (let i=bbP+2; i<candles5m.length-1; i++) {
        const hour = new Date(candles5m[i].open_time).getUTCHours();
        if (goodH && !GOOD_HOURS_5M.has(hour)) continue;
        if (!bb[i] || rsi5[i]===null) continue;
        const body = Math.abs(candles5m[i].close - candles5m[i].open) / candles5m[i].open;
        if (rsi5[i] <= thresh && candles5m[i].close <= bb[i].lower && body >= 0.003) {
          signals.push({ win: candles5m[i+1].close > candles5m[i+1].open });
        }
      }
      if (signals.length<20) { console.log(`RSI<${thresh} BB(${bbP},${bbM}) body≥0.3% GoodH=${goodH}: T=${signals.length} (too few)`); continue; }
      const wf = walkForward(signals);
      const fs = wf.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');
      const pass = wf.avg>=65 && wf.sigma<=8;
      console.log(`RSI<${thresh} BB(${bbP},${bbM}) body≥0.3% GoodH=${goodH}: WR=${wf.avg.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${fs}]${pass?' *** PASS ***':''}`);
    }
  }
}

// ── 15m synth RSI Panic (bear) ──
console.log('\n--- ETH/15m synth RSI Panic (BEAR) + BB(15,2.2) ---');
const raw5m = getCandles('ETH','5m');
const candles15m = synth15m(raw5m);
const closes15m = candles15m.map(c=>c.close);
const rsi15 = calcRSI(closes15m, 14);
for (const rsiT of [65,70,75]) {
  for (const bodyT of [0.002,0.003,0.004]) {
    for (const [bbP,bbM] of [[15,2.2],[20,2.2]]) {
      for (const goodH of [true,false]) {
        const bb = calcBB(closes15m, bbP, bbM);
        const signals = [];
        for (let i=bbP+2; i<candles15m.length-1; i++) {
          const hour = new Date(candles15m[i].open_time).getUTCHours();
          if (goodH && !GOOD_HOURS_15M.has(hour)) continue;
          if (!bb[i] || rsi15[i]===null) continue;
          const body = Math.abs(candles15m[i].close - candles15m[i].open) / candles15m[i].open;
          if (rsi15[i] >= rsiT && candles15m[i].close >= bb[i].upper && body >= bodyT) {
            signals.push({ win: candles15m[i+1].close < candles15m[i+1].open });
          }
        }
        if (signals.length<20) continue;
        const wf = walkForward(signals);
        const fs = wf.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');
        const pass = wf.avg>=65 && wf.sigma<=8;
        if (pass || wf.avg>=62) console.log(`15m RSI>${rsiT} body≥${(bodyT*100).toFixed(1)}% BB(${bbP},${bbM}) GoodH=${goodH}: WR=${wf.avg.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${fs}]${pass?' *** PASS ***':''}`);
      }
    }
  }
}
