'use strict';
// ETH/15m hour sweep — never tested on REAL 15m data
// Previous research focused on 5m. 15m may have completely different good hours.
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

const candles = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('ETH', '15m');
const closes = candles.map(c => c.close);

function calcBB(cls, p, m) {
  return cls.map((_, i) => {
    if (i < p - 1) return null;
    const sl = cls.slice(i - p + 1, i + 1), mn = sl.reduce((a,b)=>a+b,0)/p;
    const std = Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);
    return { upper: mn+m*std, lower: mn-m*std, mid: mn, std };
  });
}
function calcRSI(cls, p) {
  const r = new Array(cls.length).fill(null);
  let ag=0,al=0;
  for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}
  ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));
  for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}
  return r;
}
function getStreak(i) {
  const dir = closes[i]>candles[i].open?1:-1; let s=0;
  for(let j=i;j>=0;j--){if((closes[j]>candles[j].open?1:-1)===dir)s++;else break;}
  return{streak:s,dir};
}
function wf(signals,nF=3){
  const sz=Math.floor(signals.length/nF),res=[];
  for(let f=0;f<nF;f++){const fold=signals.slice(f*sz,f===nF-1?signals.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}
  const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;
  return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:signals.length};
}
function rpt(lbl,sigs){
  if(sigs.length<30){console.log(`${lbl}: T=${sigs.length} (too few)`);return null;}
  const r=wf(sigs);const fs=r.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');
  const pass=r.avg>=65&&r.sigma<=8;
  console.log(`${lbl}: WR=${r.avg.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.total} [${fs}]${pass?' *** PASS ***':''}`);
  return r;
}

const bb = calcBB(closes, 15, 2.2);
const rsi = calcRSI(closes, 14);

console.log('=== ETH/15m Real Candles — Hour Sweep ===\n');
console.log('--- Single hour, BB(15,2.2)+streak>=2 ---');

const hourResults = [];
for (let h = 0; h < 24; h++) {
  const sigs = [];
  for (let i=20; i<candles.length-1; i++) {
    if (!bb[i]) continue;
    if (new Date(candles[i].open_time).getUTCHours() !== h) continue;
    const {streak,dir} = getStreak(i);
    if (streak<2) continue;
    if (dir===1&&closes[i]>=bb[i].upper) sigs.push({win:candles[i+1].close<candles[i+1].open});
    if (dir===-1&&closes[i]<=bb[i].lower) sigs.push({win:candles[i+1].close>candles[i+1].open});
  }
  if (sigs.length>=10) {
    const r=wf(sigs);
    hourResults.push({hour:h,avg:r.avg,sigma:r.sigma,folds:r.folds,total:r.total});
    const pass=r.avg>=60&&r.total>=15;
    console.log(`h=${String(h).padStart(2,'0')}: WR=${r.avg.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.total} [${r.folds.map(f=>f.wr.toFixed(1)).join('/')}]${pass?' <<':''}`);
  } else {
    console.log(`h=${String(h).padStart(2,'0')}: T=${sigs.length} (too few)`);
  }
}

const goodH15 = hourResults.filter(r=>r.avg>=62&&r.total>=15).map(r=>r.hour).sort((a,b)=>a-b);
console.log(`\nGood hours on ETH/15m (WR>=62%, T>=15): [${goodH15}]`);

// Test top hour combos
console.log('\n--- Hour Combo Results (BB(15,2.2)+s>=2) ---');
const combos = [];
// All pairs from good hours
for (let i=0;i<goodH15.length;i++) for(let j=i+1;j<goodH15.length;j++) combos.push([goodH15[i],goodH15[j]]);
// All triples
for (let i=0;i<goodH15.length;i++) for(let j=i+1;j<goodH15.length;j++) for(let k=j+1;k<goodH15.length;k++) combos.push([goodH15[i],goodH15[j],goodH15[k]]);
// Full good hour set
if (goodH15.length>3) combos.push(goodH15);
// Known 5m good hours on 15m
combos.push([10,11,12,21]);

const comboResults = [];
for (const hrs of combos) {
  const hset = new Set(hrs);
  const sigs=[];
  for(let i=20;i<candles.length-1;i++){
    if(!bb[i])continue;
    if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
    const{streak,dir}=getStreak(i);if(streak<2)continue;
    if(dir===1&&closes[i]>=bb[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
    if(dir===-1&&closes[i]<=bb[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
  }
  if(sigs.length>=30){const r=wf(sigs);comboResults.push({hrs,avg:r.avg,sigma:r.sigma,folds:r.folds,total:r.total});}
}
comboResults.sort((a,b)=>b.avg-a.avg);
for(const r of comboResults.slice(0,20)){
  const pass=r.avg>=65&&r.sigma<=8;
  console.log(`h=[${r.hrs}]: WR=${r.avg.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.total} [${r.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/')}]${pass?' *** PASS ***':''}`);
}

// Also test with RSI confirm + BB(20,2.2) for best hour combos
console.log('\n--- Top combos + RSI confirm ---');
const bb20 = calcBB(closes, 20, 2.2);
for(const r of comboResults.slice(0,5)){
  const hset=new Set(r.hrs);
  for(const rsiT of [65,70]){
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb20[i]||rsi[i]===null)continue;
      if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const{streak,dir}=getStreak(i);if(streak<2)continue;
      if(dir===1&&closes[i]>=bb20[i].upper&&rsi[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb20[i].lower&&rsi[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    if(sigs.length>=20){const r2=wf(sigs);const pass=r2.avg>=65&&r2.sigma<=8;if(pass||r2.avg>=63)console.log(`h=[${r.hrs}]+RSI${rsiT}+BB(20,2.2): WR=${r2.avg.toFixed(1)}% σ=${r2.sigma.toFixed(1)}% T=${r2.total} [${r2.folds.map(f=>f.wr.toFixed(1)).join('/')}]${pass?' *** PASS ***':''}`);}
  }
}
