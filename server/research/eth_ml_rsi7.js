'use strict';
// ETH RSI7 deep dive — MI analysis shows RSI7 strongest predictor on 5m AND 15m
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));
const GOOD_HOURS=new Set([10,11,12,21]);

function getCandles(s,tf){return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(s,tf);}
function calcBB(cls,p,m){return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(cls,p){const r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function getStreak(opens,closes,i){const dir=closes[i]>opens[i]?1:-1;let s=0;for(let j=i;j>=0;j--){if((closes[j]>opens[j]?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function wf(sigs,nF=3){const sz=Math.floor(sigs.length/nF),res=[];for(let f=0;f<nF;f++){const fold=sigs.slice(f*sz,f===nF-1?sigs.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:sigs.length};}
function rpt(lbl,sigs){if(sigs.length<30){console.log(lbl+': T='+sigs.length);return;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));}

console.log('=== ETH RSI7 Strategy (top MI predictor) ===\n');

// ETH/5m
const c5=getCandles('ETH','5m');
const cls5=c5.map(c=>c.close),opn5=c5.map(c=>c.open);
const rsi7_5=calcRSI(cls5,7),rsi14_5=calcRSI(cls5,14);
const bb22_5=calcBB(cls5,20,2.2),bb20_5=calcBB(cls5,20,2.0);

console.log('--- ETH/5m RSI7 exhaustion ---');
for(const[bb,lbl] of [[bb22_5,'BB(20,2.2)'],[bb20_5,'BB(20,2)']]) {
  for(const rsiT of [60,65,70,75]) {
    for(const minS of [1,2]) {
      const sigs=[];
      for(let i=20;i<c5.length-1;i++){
        if(!bb[i]||rsi7_5[i]===null)continue;
        const h=new Date(c5[i].open_time).getUTCHours();
        if(!GOOD_HOURS.has(h))continue;
        const{streak,dir}=getStreak(opn5,cls5,i);if(streak<minS)continue;
        if(dir===1&&cls5[i]>=bb[i].upper&&rsi7_5[i]>=rsiT)sigs.push({win:c5[i+1].close<c5[i+1].open});
        if(dir===-1&&cls5[i]<=bb[i].lower&&rsi7_5[i]<=(100-rsiT))sigs.push({win:c5[i+1].close>c5[i+1].open});
      }
      rpt(`5m RSI7>${rsiT}+GoodH+${lbl}+s>=${minS}`,sigs);
    }
  }
}

// RSI7 vs RSI14 comparison on 5m
console.log('\n--- RSI7 vs RSI14 head-to-head on ETH/5m (same config as Strat 18) ---');
for(const[rsi,label] of [[rsi7_5,'RSI7'],[rsi14_5,'RSI14']]) {
  for(const rsiT of [65,70]) {
    const sigs=[];
    for(let i=20;i<c5.length-1;i++){
      if(!bb22_5[i]||rsi[i]===null)continue;
      const h=new Date(c5[i].open_time).getUTCHours();
      if(!GOOD_HOURS.has(h))continue;
      const{streak,dir}=getStreak(opn5,cls5,i);if(streak<1)continue;
      const bodyPct=Math.abs(cls5[i]-opn5[i])/opn5[i];
      if(bodyPct<0.003)continue;
      if(dir===1&&cls5[i]>=bb22_5[i].upper&&rsi[i]>=rsiT)sigs.push({win:c5[i+1].close<c5[i+1].open});
      if(dir===-1&&cls5[i]<=bb22_5[i].lower&&rsi[i]<=(100-rsiT))sigs.push({win:c5[i+1].close>c5[i+1].open});
    }
    rpt(`5m ${label}>${rsiT}+body>=0.3%+GoodH+BB22+s>=1`,sigs);
  }
}

// ETH/15m RSI7
const c15=getCandles('ETH','15m');
const cls15=c15.map(c=>c.close),opn15=c15.map(c=>c.open);
const rsi7_15=calcRSI(cls15,7),rsi14_15=calcRSI(cls15,14);
const bb15_22=calcBB(cls15,15,2.2),bb20_22_15=calcBB(cls15,20,2.2);
const NEW_HOURS_15=new Set([5,12,20]);
const NEW_HOURS_15B=new Set([7,12,20]);

console.log('\n--- ETH/15m RSI7 + new hours [5,12,20] and [7,12,20] ---');
for(const[hrs,hLabel] of [[NEW_HOURS_15,'h[5,12,20]'],[NEW_HOURS_15B,'h[7,12,20]']]) {
  for(const[bb,bLabel] of [[bb15_22,'BB(15,2.2)'],[bb20_22_15,'BB(20,2.2)']]) {
    for(const rsiT of [60,65,70]) {
      for(const rsiVersion of [[rsi7_15,'RSI7'],[rsi14_15,'RSI14']]) {
        const sigs=[];
        for(let i=20;i<c15.length-1;i++){
          if(!bb[i]||rsiVersion[0][i]===null)continue;
          if(!hrs.has(new Date(c15[i].open_time).getUTCHours()))continue;
          const{streak,dir}=getStreak(opn15,cls15,i);if(streak<2)continue;
          if(dir===1&&cls15[i]>=bb[i].upper&&rsiVersion[0][i]>=rsiT)sigs.push({win:c15[i+1].close<c15[i+1].open});
          if(dir===-1&&cls15[i]<=bb[i].lower&&rsiVersion[0][i]<=(100-rsiT))sigs.push({win:c15[i+1].close>c15[i+1].open});
        }
        rpt(`15m ${hLabel}+${rsiVersion[1]}>${rsiT}+${bLabel}+s>=2`,sigs);
      }
    }
  }
}
