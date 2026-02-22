'use strict';
// SOL Low-ATR: Best new finding (68.9% σ=1.2%) — optimize BB params + RSI confirm
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
function rpt(lbl,sigs){if(sigs.length<30){console.log(lbl+': T='+sigs.length);return;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));}

const atr14=calcATR(candles,14);
const rsi7=calcRSI(closes,7);
const rsi14=calcRSI(closes,14);
function atrPct(i,w=100){if(!atr14[i])return null;const v=atr14.slice(Math.max(14,i-w),i+1).filter(x=>x);return v.filter(x=>x<=atr14[i]).length/v.length;}

console.log('=== SOL Low-ATR Strategy Optimization ===\n');

console.log('--- ATR threshold x BB params x streak ---');
for(const pctT of [0.25,0.33,0.40,0.50]){
  for(const[bbP,bbM] of [[20,2.2],[25,2.2],[20,2.0],[15,2.2]]){
    const bb=calcBB(closes,bbP,bbM);
    for(const minS of [1,2]){
      for(const hrs of [SOL_GOOD,new Set([0,12,13,20,17])]){
        const sigs=[];
        for(let i=100;i<candles.length-1;i++){
          if(!bb[i])continue;
          const h=new Date(candles[i].open_time).getUTCHours();
          if(!hrs.has(h))continue;
          const p=atrPct(i);if(p===null||p>pctT)continue;
          const{streak,dir}=getStreak(i);if(streak<minS)continue;
          if(dir===1&&closes[i]>=bb[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
          if(dir===-1&&closes[i]<=bb[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
        }
        const hLabel=hrs.size===4?'h4':'h5';
        rpt(`LowATR${(pctT*100).toFixed(0)}%+BB(${bbP},${bbM})+${hLabel}+s>=${minS}`,sigs);
      }
    }
  }
}

console.log('\n--- Best config + RSI confirms ---');
// LowATR40% h=[0,12,13,20]+BB+s>=1 was 68.9% σ=1.2% — add RSI
const bb_20_22=calcBB(closes,20,2.2);
const bb_25_22=calcBB(closes,25,2.2);
for(const bb of [[bb_20_22,'BB(20,2.2)'],[bb_25_22,'BB(25,2.2)']]) {
  for(const pctT of [0.33,0.40]) {
    for(const rsiT of [60,65,70]) {
      const sigs=[];
      for(let i=100;i<candles.length-1;i++){
        if(!bb[0][i]||rsi14[i]===null)continue;
        const h=new Date(candles[i].open_time).getUTCHours();
        if(!SOL_GOOD.has(h))continue;
        const p=atrPct(i);if(p===null||p>pctT)continue;
        const{streak,dir}=getStreak(i);if(streak<1)continue;
        if(dir===1&&closes[i]>=bb[0][i].upper&&rsi14[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[0][i].lower&&rsi14[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(`LowATR${(pctT*100).toFixed(0)}%+RSI14>${rsiT}+${bb[1]}+GoodH+s>=1`,sigs);
    }
    for(const rsiT of [55,60,65]) {
      const sigs=[];
      for(let i=100;i<candles.length-1;i++){
        if(!bb[0][i]||rsi7[i]===null)continue;
        const h=new Date(candles[i].open_time).getUTCHours();
        if(!SOL_GOOD.has(h))continue;
        const p=atrPct(i);if(p===null||p>pctT)continue;
        const{streak,dir}=getStreak(i);if(streak<1)continue;
        if(dir===1&&closes[i]>=bb[0][i].upper&&rsi7[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[0][i].lower&&rsi7[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(`LowATR${(pctT*100).toFixed(0)}%+RSI7>${rsiT}+${bb[1]}+GoodH+s>=1`,sigs);
    }
  }
}
