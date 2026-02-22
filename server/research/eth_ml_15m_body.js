'use strict';
// ETH/15m body filter + RSI at new hours — body>=0.3% hits 79.4%, push further
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));
const candles = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('ETH','15m');
const closes = candles.map(c=>c.close), opens = candles.map(c=>c.open);
function calcBB(cls,p,m){return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(cls,p){const r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function calcMFI(h,l,c,v,p){const m=new Array(c.length).fill(null);const tp=c.map((x,i)=>(h[i]+l[i]+x)/3);const mf=tp.map((t,i)=>t*v[i]);for(let i=p;i<c.length;i++){let pos=0,neg=0;for(let j=i-p+1;j<=i;j++){if(tp[j]>tp[j-1])pos+=mf[j];else neg+=mf[j];}m[i]=neg===0?100:100-100/(1+pos/neg);}return m;}
function calcATR(can,p){const a=new Array(can.length).fill(null);let s=0;for(let i=1;i<can.length;i++){const tr=Math.max(can[i].high-can[i].low,Math.abs(can[i].high-can[i-1].close),Math.abs(can[i].low-can[i-1].close));if(i<p)s+=tr;else if(i===p){s+=tr;a[i]=s/p;}else a[i]=(a[i-1]*(p-1)+tr)/p;}return a;}
function getStreak(i){const dir=closes[i]>opens[i]?1:-1;let s=0;for(let j=i;j>=0;j--){if((closes[j]>opens[j]?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function wf(sigs,nF=3){const sz=Math.floor(sigs.length/nF),res=[];for(let f=0;f<nF;f++){const fold=sigs.slice(f*sz,f===nF-1?sigs.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:sigs.length};}
function rpt(lbl,sigs){if(sigs.length<20){console.log(lbl+': T='+sigs.length);return;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));}
const bb15_22=calcBB(closes,15,2.2), bb20_22=calcBB(closes,20,2.2);
const rsi14=calcRSI(closes,14), rsi7=calcRSI(closes,7);
const atr14=calcATR(candles,14);
const highs=candles.map(c=>c.high),lows=candles.map(c=>c.low),vols=candles.map(c=>c.volume);
const mfi10=calcMFI(highs,lows,closes,vols,10);
const H_A=new Set([5,12,20]), H_B=new Set([7,12,20]);

console.log('=== ETH/15m Body + RSI/MFI at New Hours ===\n');

console.log('--- Body>=0.3% + RSI confirm at h=[7,12,20] (best stability) ---');
for(const rsiT of [55,60,65,70]){
  for(const[rsi,rLabel] of [[rsi7,'RSI7'],[rsi14,'RSI14']]) {
    for(const[bb,bLabel] of [[bb15_22,'BB(15,2.2)'],[bb20_22,'BB(20,2.2)']]) {
      const sigs=[];
      for(let i=20;i<candles.length-1;i++){
        if(!bb[i]||rsi[i]===null)continue;
        if(!H_B.has(new Date(candles[i].open_time).getUTCHours()))continue;
        const bPct=Math.abs(closes[i]-opens[i])/opens[i];if(bPct<0.003)continue;
        const{streak,dir}=getStreak(i);if(streak<2)continue;
        if(dir===1&&closes[i]>=bb[i].upper&&rsi[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[i].lower&&rsi[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(`h=[7,12,20]+body>=0.3%+${rLabel}>${rsiT}+${bLabel}+s>=2`,sigs);
    }
  }
}

console.log('\n--- Body>=0.3% + RSI at h=[5,12,20] ---');
for(const rsiT of [55,60,65,70]){
  for(const[bb,bLabel] of [[bb15_22,'BB(15,2.2)'],[bb20_22,'BB(20,2.2)']]) {
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb[i]||rsi14[i]===null)continue;
      if(!H_A.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const bPct=Math.abs(closes[i]-opens[i])/opens[i];if(bPct<0.003)continue;
      const{streak,dir}=getStreak(i);if(streak<2)continue;
      if(dir===1&&closes[i]>=bb[i].upper&&rsi14[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb[i].lower&&rsi14[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt(`h=[5,12,20]+body>=0.3%+RSI14>${rsiT}+${bLabel}+s>=2`,sigs);
  }
}

console.log('\n--- MFI at new hours (strongest overall indicator) ---');
for(const mfiT of [65,70,75,80]){
  for(const[hrs,hLabel] of [[H_A,'h=[5,12,20]'],[H_B,'h=[7,12,20]']]) {
    for(const[bb,bLabel] of [[bb15_22,'BB(15,2.2)'],[bb20_22,'BB(20,2.2)']]) {
      for(const minS of [1,2]) {
        const sigs=[];
        for(let i=20;i<candles.length-1;i++){
          if(!bb[i]||mfi10[i]===null)continue;
          if(!hrs.has(new Date(candles[i].open_time).getUTCHours()))continue;
          const{streak,dir}=getStreak(i);if(streak<minS)continue;
          if(dir===1&&closes[i]>=bb[i].upper&&mfi10[i]>=mfiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
          if(dir===-1&&closes[i]<=bb[i].lower&&mfi10[i]<=(100-mfiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
        }
        rpt(`${hLabel}+MFI>${mfiT}+${bLabel}+s>=${minS}`,sigs);
      }
    }
  }
}

console.log('\n--- body/ATR>=0.5 + RSI7 (dual quality filter) ---');
for(const rsiT of [60,65,70]){
  for(const[hrs,hLabel] of [[H_A,'h=[5,12,20]'],[H_B,'h=[7,12,20]']]) {
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb15_22[i]||rsi7[i]===null||!atr14[i])continue;
      if(!hrs.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const bodyAtr=Math.abs(closes[i]-opens[i])/atr14[i];if(bodyAtr<0.5)continue;
      const{streak,dir}=getStreak(i);if(streak<2)continue;
      if(dir===1&&closes[i]>=bb15_22[i].upper&&rsi7[i]>=rsiT)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb15_22[i].lower&&rsi7[i]<=(100-rsiT))sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt(`${hLabel}+body/ATR>=0.5+RSI7>${rsiT}+BB(15,2.2)+s>=2`,sigs);
  }
}
