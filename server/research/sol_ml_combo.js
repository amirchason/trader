'use strict';
// SOL combo: Low-ATR + Daily Range combined + RSI7 + panic body
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));
const raw5m = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('SOL','5m');
function synth15m(c){const r=[];for(let i=2;i<c.length;i+=3){const g=[c[i-2],c[i-1],c[i]];r.push({open_time:g[0].open_time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[2].close,volume:g.reduce((s,x)=>s+x.volume,0)});}return r;}
const candles=synth15m(raw5m);
const closes=candles.map(c=>c.close);
const SOL_GOOD=new Set([0,12,13,20]);
function calcBB(cls,p,m){return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(cls,p){const r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function calcATR(can,p){const a=new Array(can.length).fill(null);let s=0;for(let i=1;i<can.length;i++){const tr=Math.max(can[i].high-can[i].low,Math.abs(can[i].high-can[i-1].close),Math.abs(can[i].low-can[i-1].close));if(i<p)s+=tr;else if(i===p){s+=tr;a[i]=s/p;}else a[i]=(a[i-1]*(p-1)+tr)/p;}return a;}
function getStreak(i){const dir=closes[i]>candles[i].open?1:-1;let s=0;for(let j=i;j>=0;j--){if((closes[j]>candles[j].open?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function wf(sigs,nF=3){const sz=Math.floor(sigs.length/nF),res=[];for(let f=0;f<nF;f++){const fold=sigs.slice(f*sz,f===nF-1?sigs.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:sigs.length};}
function rpt(lbl,sigs){if(sigs.length<20){console.log(lbl+': T='+sigs.length);return;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));}

const atr14=calcATR(candles,14);
const rsi7=calcRSI(closes,7);
const rsi14=calcRSI(closes,14);
const bb20_22=calcBB(closes,20,2.2);
const bb15_22=calcBB(closes,15,2.2);
const bb25_22=calcBB(closes,25,2.2);

function atrPct(i,w=100){if(!atr14[i])return null;const v=atr14.slice(Math.max(14,i-w),i+1).filter(x=>x);return v.filter(x=>x<=atr14[i]).length/v.length;}

// Daily range
const byDay={};
for(let i=0;i<candles.length;i++){const d=new Date(candles[i].open_time);const key=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;if(!byDay[key])byDay[key]={high:-Infinity,low:Infinity};if(candles[i].high>byDay[key].high)byDay[key].high=candles[i].high;if(candles[i].low<byDay[key].low)byDay[key].low=candles[i].low;}

console.log('=== SOL Combo Strategies ===\n');

console.log('--- Low-ATR + Daily Range COMBINED ---');
for(const pctT of [0.33,0.40]){
  for(const rangePct of [0.25,0.30]){
    const sigs=[];
    for(let i=100;i<candles.length-1;i++){
      if(!bb20_22[i])continue;
      const h=new Date(candles[i].open_time).getUTCHours();if(!SOL_GOOD.has(h))continue;
      const p=atrPct(i);if(p===null||p>pctT)continue;
      const d=new Date(candles[i].open_time);const key=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      const dayInfo=byDay[key];if(!dayInfo)continue;
      const range=dayInfo.high-dayInfo.low;if(range===0)continue;
      const pos=(closes[i]-dayInfo.low)/range;
      const{streak,dir}=getStreak(i);if(streak<1)continue;
      if(dir===1&&closes[i]>=bb20_22[i].upper&&pos>=(1-rangePct))sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb20_22[i].lower&&pos<=rangePct)sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt(`SOL LowATR${(pctT*100).toFixed(0)}%+Range${(rangePct*100).toFixed(0)}%+BB+GoodH`,sigs);
  }
}

console.log('\n--- SOL RSI7 Exhaustion ---');
for(const[bb,bLabel] of [[bb20_22,'BB(20,2.2)'],[bb15_22,'BB(15,2.2)'],[bb25_22,'BB(25,2.2)']]) {
  for(const rsiT of [55,60,65]) {
    for(const minS of [1,2]) {
      const sigs=[];
      for(let i=20;i<candles.length-1;i++){
        if(!bb[i]||rsi7[i]===null)continue;
        if(!SOL_GOOD.has(new Date(candles[i].open_time).getUTCHours()))continue;
        const{streak,dir}=getStreak(i);if(streak<minS)continue;
        if(dir===1&&closes[i]>=bb[i].upper&&rsi7[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[i].lower&&rsi7[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(`SOL RSI7>${rsiT}+${bLabel}+GoodH+s>=${minS}`,sigs);
    }
  }
}

console.log('\n--- SOL Panic Body BB (like ETH Strat 18 but SOL) ---');
for(const bodyPct of [0.003,0.005,0.008]){
  for(const[bb,bLabel] of [[bb20_22,'BB(20,2.2)'],[bb25_22,'BB(25,2.2)']]) {
    for(const minS of [1,2]) {
      const sigs=[];
      for(let i=20;i<candles.length-1;i++){
        if(!bb[i])continue;
        if(!SOL_GOOD.has(new Date(candles[i].open_time).getUTCHours()))continue;
        const bP=Math.abs(closes[i]-candles[i].open)/candles[i].open;
        if(bP<bodyPct)continue;
        const{streak,dir}=getStreak(i);if(streak<minS)continue;
        if(dir===1&&closes[i]>=bb[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(`SOL body>=${(bodyPct*100).toFixed(1)}%+${bLabel}+GoodH+s>=${minS}`,sigs);
    }
  }
}

console.log('\n--- SOL Low-ATR + RSI7 combo ---');
for(const pctT of [0.33,0.40]){
  for(const rsiT of [55,60,65]) {
    const sigs=[];
    for(let i=100;i<candles.length-1;i++){
      if(!bb15_22[i]||rsi7[i]===null)continue;
      if(!SOL_GOOD.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const p=atrPct(i);if(p===null||p>pctT)continue;
      const{streak,dir}=getStreak(i);if(streak<1)continue;
      if(dir===1&&closes[i]>=bb15_22[i].upper&&rsi7[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb15_22[i].lower&&rsi7[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt(`SOL LowATR${(pctT*100).toFixed(0)}%+RSI7>${rsiT}+BB(15,2.2)+GoodH+s>=1`,sigs);
  }
}
