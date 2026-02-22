'use strict';
// ETH/15m v2: New good hours [5,12,20] + [7,12,20] + RSI7 (top MI predictor)
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));
const candles = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('ETH','15m');
const closes = candles.map(c=>c.close), opens = candles.map(c=>c.open);
function calcBB(cls,p,m){return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(cls,p){const r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function getStreak(i){const dir=closes[i]>opens[i]?1:-1;let s=0;for(let j=i;j>=0;j--){if((closes[j]>opens[j]?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function wf(sigs,nF=3){const sz=Math.floor(sigs.length/nF),res=[];for(let f=0;f<nF;f++){const fold=sigs.slice(f*sz,f===nF-1?sigs.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:sigs.length};}
function rpt(lbl,sigs){if(sigs.length<30){console.log(lbl+': T='+sigs.length);return;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));}

const rsi14=calcRSI(closes,14);
const rsi7=calcRSI(closes,7);
const bb_15_22=calcBB(closes,15,2.2);
const bb_20_22=calcBB(closes,20,2.2);
const bb_20_20=calcBB(closes,20,2.0);

console.log('=== ETH/15m New Hours Optimization ===\n');

const TOP_HOURS = [
  [5,12,20], [7,12,20], [0,12,20], [5,12], [7,12], [9,12,20],
  [5,12,20,21], [7,12,20,21], [0,7,12,20]
];

console.log('--- New good hours + different BB params (s>=2) ---');
for(const hrs of TOP_HOURS){
  const hset=new Set(hrs);
  for(const[bb,label] of [[bb_15_22,'BB(15,2.2)'],[bb_20_22,'BB(20,2.2)'],[bb_20_20,'BB(20,2)']]) {
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb[i])continue;
      if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const{streak,dir}=getStreak(i);if(streak<2)continue;
      if(dir===1&&closes[i]>=bb[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt(`h=[${hrs}]+${label}+s>=2`,sigs);
  }
}

console.log('\n--- RSI7 confirm (top MI predictor) on ETH/15m ---');
for(const hrs of [[5,12,20],[7,12,20],[0,12,20],[5,12],[7,12]]) {
  const hset=new Set(hrs);
  for(const rsiT of [60,65,70]) {
    for(const bb of [[bb_15_22,'BB(15,2.2)'],[bb_20_22,'BB(20,2.2)']]) {
      const sigs=[];
      for(let i=20;i<candles.length-1;i++){
        if(!bb[0][i]||rsi7[i]===null)continue;
        if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
        const{streak,dir}=getStreak(i);if(streak<2)continue;
        if(dir===1&&closes[i]>=bb[0][i].upper&&rsi7[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[0][i].lower&&rsi7[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(`h=[${hrs}]+RSI7>${rsiT}+${bb[1]}+s>=2`,sigs);
    }
  }
}

console.log('\n--- RSI14 confirm on best new hours ---');
for(const hrs of [[5,12,20],[7,12,20],[0,12,20]]) {
  const hset=new Set(hrs);
  for(const rsiT of [65,70]) {
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb_20_22[i]||rsi14[i]===null)continue;
      if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const{streak,dir}=getStreak(i);if(streak<2)continue;
      if(dir===1&&closes[i]>=bb_20_22[i].upper&&rsi14[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb_20_22[i].lower&&rsi14[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt(`h=[${hrs}]+RSI14>${rsiT}+BB(20,2.2)+s>=2`,sigs);
  }
}

console.log('\n--- streak>=1 on best ETH/15m hours ---');
for(const hrs of [[5,12,20],[7,12,20],[0,12,20]]) {
  const hset=new Set(hrs);
  const sigs=[];
  for(let i=15;i<candles.length-1;i++){
    if(!bb_15_22[i])continue;
    if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
    const{streak,dir}=getStreak(i);if(streak<1)continue;
    if(dir===1&&closes[i]>=bb_15_22[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
    if(dir===-1&&closes[i]<=bb_15_22[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
  }
  rpt(`h=[${hrs}]+BB(15,2.2)+s>=1`,sigs);
}
