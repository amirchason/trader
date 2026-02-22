'use strict';
// ETH/15m RGGG/GRGG at new good hours [5,12,20]+[7,12,20] + body filter + 4-streak
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));
const candles = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('ETH','15m');
const closes = candles.map(c=>c.close), opens = candles.map(c=>c.open);
function calcBB(cls,p,m){return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(cls,p){const r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function getStreak(i){const dir=closes[i]>opens[i]?1:-1;let s=0;for(let j=i;j>=0;j--){if((closes[j]>opens[j]?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function calcATR(can,p){const a=new Array(can.length).fill(null);let s=0;for(let i=1;i<can.length;i++){const tr=Math.max(can[i].high-can[i].low,Math.abs(can[i].high-can[i-1].close),Math.abs(can[i].low-can[i-1].close));if(i<p)s+=tr;else if(i===p){s+=tr;a[i]=s/p;}else a[i]=(a[i-1]*(p-1)+tr)/p;}return a;}
function wf(sigs,nF=3){const sz=Math.floor(sigs.length/nF),res=[];for(let f=0;f<nF;f++){const fold=sigs.slice(f*sz,f===nF-1?sigs.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:sigs.length};}
function rpt(lbl,sigs){if(sigs.length<20){console.log(lbl+': T='+sigs.length);return;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% σ='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));}

const bb15_22=calcBB(closes,15,2.2);
const bb20_22=calcBB(closes,20,2.2);
const rsi14=calcRSI(closes,14);
const atr14=calcATR(candles,14);

console.log('=== ETH/15m: RGGG/GRGG + new hours + body filter + streak>=4 ===\n');

const NEW_HOURS_A=new Set([5,12,20]);
const NEW_HOURS_B=new Set([7,12,20]);
const OLD_HOURS=new Set([10,11,12,21]);
const ALL_HOURS=null;
const HOURS_LIST=[[NEW_HOURS_A,'h=[5,12,20]'],[NEW_HOURS_B,'h=[7,12,20]'],[OLD_HOURS,'h=[10,11,12,21]'],[ALL_HOURS,'AllH']];

// RGGG / GRGG patterns at different hour sets
console.log('--- RGGG→BEAR, GRGG→BEAR at different hours ---');
function isGreen(i){return closes[i]>opens[i];}
function isRed(i){return closes[i]<opens[i];}
for(const[hrs,hLabel] of HOURS_LIST){
  for(const[bb,bLabel] of [[bb15_22,'BB(15,2.2)'],[bb20_22,'BB(20,2.2)']]) {
    const rggg=[], grgg=[], rrrg=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb[i])continue;
      if(hrs&&!hrs.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const h=new Date(candles[i].open_time).getUTCHours();
      if(isRed(i-3)&&isGreen(i-2)&&isGreen(i-1)&&isGreen(i)&&closes[i]>=bb[i].upper)
        rggg.push({win:candles[i+1].close<candles[i+1].open});
      if(isGreen(i-3)&&isRed(i-2)&&isGreen(i-1)&&isGreen(i)&&closes[i]>=bb[i].upper)
        grgg.push({win:candles[i+1].close<candles[i+1].open});
      if(isRed(i-3)&&isRed(i-2)&&isRed(i-1)&&isGreen(i)&&closes[i]<=bb[i].lower)
        rrrg.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt('RGGG→BEAR '+hLabel+'+'+bLabel,rggg);
    rpt('GRGG→BEAR '+hLabel+'+'+bLabel,grgg);
    rpt('RRRG→BULL '+hLabel+'+'+bLabel,rrrg);
  }
}

// 4-streak (extra strong) at new hours
console.log('\n--- 4-streak exhaustion at new hours ---');
for(const[hrs,hLabel] of [[NEW_HOURS_A,'h=[5,12,20]'],[NEW_HOURS_B,'h=[7,12,20]']]) {
  for(const minS of [3,4]) {
    for(const[bb,bLabel] of [[bb15_22,'BB(15,2.2)'],[bb20_22,'BB(20,2.2)']]) {
      const sigs=[];
      for(let i=20;i<candles.length-1;i++){
        if(!bb[i])continue;
        if(!hrs.has(new Date(candles[i].open_time).getUTCHours()))continue;
        const{streak,dir}=getStreak(i);if(streak<minS)continue;
        if(dir===1&&closes[i]>=bb[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(hLabel+'+'+bLabel+'+s>='+minS,sigs);
    }
  }
}

// Body% filter at new hours (Panic candle style)
console.log('\n--- Body % filter at new ETH/15m hours ---');
for(const[hrs,hLabel] of [[NEW_HOURS_A,'h=[5,12,20]'],[NEW_HOURS_B,'h=[7,12,20]']]) {
  for(const bodyPct of [0.003,0.005,0.008]) {
    for(const[bb,bLabel] of [[bb15_22,'BB(15,2.2)'],[bb20_22,'BB(20,2.2)']]) {
      const sigs=[];
      for(let i=20;i<candles.length-1;i++){
        if(!bb[i])continue;
        if(!hrs.has(new Date(candles[i].open_time).getUTCHours()))continue;
        const bPct=Math.abs(closes[i]-opens[i])/opens[i];
        if(bPct<bodyPct)continue;
        const{streak,dir}=getStreak(i);if(streak<2)continue;
        if(dir===1&&closes[i]>=bb[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
        if(dir===-1&&closes[i]<=bb[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
      }
      rpt(hLabel+'+body>='+((bodyPct*100).toFixed(1))+'%+'+bLabel+'+s>=2',sigs);
    }
  }
}

// Body/ATR ratio filter (quality candle)
console.log('\n--- Body/ATR quality filter at new hours ---');
for(const[hrs,hLabel] of [[NEW_HOURS_A,'h=[5,12,20]'],[NEW_HOURS_B,'h=[7,12,20]']]) {
  for(const ratio of [0.3,0.4,0.5]) {
    const sigs=[];
    for(let i=20;i<candles.length-1;i++){
      if(!bb15_22[i]||!atr14[i])continue;
      if(!hrs.has(new Date(candles[i].open_time).getUTCHours()))continue;
      const bodyAtr=Math.abs(closes[i]-opens[i])/atr14[i];
      if(bodyAtr<ratio)continue;
      const{streak,dir}=getStreak(i);if(streak<2)continue;
      if(dir===1&&closes[i]>=bb15_22[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});
      if(dir===-1&&closes[i]<=bb15_22[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});
    }
    rpt(hLabel+'+body/ATR>='+ratio+'+BB(15,2.2)+s>=2',sigs);
  }
}
