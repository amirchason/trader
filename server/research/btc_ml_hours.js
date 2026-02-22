'use strict';
// BTC/15m hour sweep — NEVER tested! BTC has different session dynamics
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));
const candles = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('BTC','15m');
const closes = candles.map(c=>c.close), opens = candles.map(c=>c.open);
function calcBB(cls,p,m){return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(cls,p){const r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function calcMFI(h,l,c,v,p){const mfi=new Array(c.length).fill(null);const tp=c.map((x,i)=>(h[i]+l[i]+x)/3);const mf=tp.map((t,i)=>t*v[i]);for(let i=p;i<c.length;i++){let pos=0,neg=0;for(let j=i-p+1;j<=i;j++){if(tp[j]>tp[j-1])pos+=mf[j];else neg+=mf[j];}mfi[i]=neg===0?100:100-100/(1+pos/neg);}return mfi;}
function getStreak(i){const dir=closes[i]>opens[i]?1:-1;let s=0;for(let j=i;j>=0;j--){if((closes[j]>opens[j]?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function wf(sigs,nF=3){const sz=Math.floor(sigs.length/nF),res=[];for(let f=0;f<nF;f++){const fold=sigs.slice(f*sz,f===nF-1?sigs.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:sigs.length};}
function rpt(lbl,sigs){if(sigs.length<20){console.log(lbl+': T='+sigs.length);return null;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));return r;}
const highs=candles.map(c=>c.high),lows=candles.map(c=>c.low),vols=candles.map(c=>c.volume);
const bb15_22=calcBB(closes,15,2.2),bb20_22=calcBB(closes,20,2.2),bb20_20=calcBB(closes,20,2.0);
const rsi14=calcRSI(closes,14),rsi7=calcRSI(closes,7);
const mfi10=calcMFI(highs,lows,closes,vols,10);

console.log('=== BTC/15m Hour Sweep ===\n');
console.log('--- Single hour, BB(15,2.2)+streak>=2 ---');
const hourRes=[];
for(let h=0;h<24;h++){
  const sigs=[];
  for(let i=20;i<candles.length-1;i++){
    if(!bb15_22[i])continue;
    if(new Date(candles[i].open_time).getUTCHours()!==h)continue;
    const{streak,dir}=getStreak(i);if(streak<2)continue;
    if(dir===1&&closes[i]>=bb15_22[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
    if(dir===-1&&closes[i]<=bb15_22[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
  }
  if(sigs.length>=10){const r=wf(sigs);hourRes.push({hour:h,avg:r.avg,sigma:r.sigma,total:r.total,folds:r.folds});
    const pass=r.avg>=62&&r.total>=15;console.log('h='+String(h).padStart(2,'0')+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+r.folds.map(f=>f.wr.toFixed(1)).join('/')+']'+(pass?' <<':''));}
  else console.log('h='+String(h).padStart(2,'0')+': T='+sigs.length);
}
const goodH=hourRes.filter(r=>r.avg>=62&&r.total>=15).map(r=>r.hour).sort((a,b)=>a-b);
console.log('\nGood hours BTC/15m (WR>=62%, T>=15): ['+goodH+']');

console.log('\n--- Top hour combos (pairs+triples from good hours) ---');
const combos=[];
for(let i=0;i<goodH.length;i++)for(let j=i+1;j<goodH.length;j++)combos.push([goodH[i],goodH[j]]);
for(let i=0;i<goodH.length;i++)for(let j=i+1;j<goodH.length;j++)for(let k=j+1;k<goodH.length;k++)combos.push([goodH[i],goodH[j],goodH[k]]);
if(goodH.length>3)combos.push(goodH);
combos.push([5,12,20],[7,12,20],[0,12,20],[9,12,20]); // ETH best hours — test on BTC too
const comboRes=[];
for(const hrs of combos){
  const hset=new Set(hrs);const sigs=[];
  for(let i=20;i<candles.length-1;i++){
    if(!bb15_22[i])continue;
    if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
    const{streak,dir}=getStreak(i);if(streak<2)continue;
    if(dir===1&&closes[i]>=bb15_22[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
    if(dir===-1&&closes[i]<=bb15_22[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
  }
  if(sigs.length>=30){const r=wf(sigs);comboRes.push({hrs,avg:r.avg,sigma:r.sigma,folds:r.folds,total:r.total});}
}
comboRes.sort((a,b)=>b.avg-a.avg);
for(const r of comboRes.slice(0,20)){const pass=r.avg>=65&&r.sigma<=8;console.log('h=['+r.hrs+']: WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/')+']'+(pass?' *** PASS ***':''));}

console.log('\n--- Best BTC/15m hours + RSI14>60 + BB(20,2.2) ---');
const top5=comboRes.slice(0,5);
for(const r of top5){
  const hset=new Set(r.hrs);
  for(const rsiT of [60,65]){
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb20_22[i]||rsi14[i]===null)continue;
      if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const{streak,dir}=getStreak(i);if(streak<2)continue;
      if(dir===1&&closes[i]>=bb20_22[i].upper&&rsi14[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb20_22[i].lower&&rsi14[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt('BTC h=['+r.hrs+']+RSI14>'+rsiT+'+BB(20,2.2)+s>=2',sigs);
  }
}

console.log('\n--- MFI on best BTC hours ---');
for(const r of comboRes.slice(0,3)){
  const hset=new Set(r.hrs);
  for(const mfiT of [75,80]){
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb15_22[i]||mfi10[i]===null)continue;
      if(!hset.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const{streak,dir}=getStreak(i);if(streak<1)continue;
      if(dir===1&&closes[i]>=bb15_22[i].upper&&mfi10[i]>=mfiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb15_22[i].lower&&mfi10[i]<=(100-mfiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt('BTC h=['+r.hrs+']+MFI>'+mfiT+'+BB(15,2.2)+s>=1',sigs);
  }
}
