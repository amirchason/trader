'use strict';
// ETH Random Forest feature importance + decision tree signal discovery
// Pure JS implementation - no external libraries
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

const c5 = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('ETH','5m');
const c15 = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('ETH','15m');

function calcBB(cls,p,m){return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(cls,p){const r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function calcATR(c,p){const a=new Array(c.length).fill(null);let s=0;for(let i=1;i<c.length;i++){const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close));if(i<p)s+=tr;else if(i===p){s+=tr;a[i]=s/p;}else a[i]=(a[i-1]*(p-1)+tr)/p;}return a;}
function calcMFI(c,p){const m=new Array(c.length).fill(null);for(let i=p;i<c.length;i++){let pos=0,neg=0;for(let j=i-p+1;j<=i;j++){const tp=(c[j].high+c[j].low+c[j].close)/3,ptp=(c[j-1].high+c[j-1].low+c[j-1].close)/3,rf=tp*c[j].volume;if(tp>ptp)pos+=rf;else neg+=rf;}m[i]=neg===0?100:100-100/(1+pos/neg);}return m;}
function calcEMA(cls,p){const e=new Array(cls.length).fill(null);const k=2/(p+1);let sum=0;for(let i=0;i<p;i++)sum+=cls[i];e[p-1]=sum/p;for(let i=p;i<cls.length;i++)e[i]=cls[i]*k+e[i-1]*(1-k);return e;}

function buildFeatures(candles) {
  const cls=candles.map(c=>c.close), ops=candles.map(c=>c.open), his=candles.map(c=>c.high), los=candles.map(c=>c.low), vls=candles.map(c=>c.volume);
  const bb20_22=calcBB(cls,20,2.2), bb20_2=calcBB(cls,20,2.0), bb15_22=calcBB(cls,15,2.2);
  const rsi14=calcRSI(cls,14), rsi7=calcRSI(cls,7);
  const atr14=calcATR(candles,14), atr10=calcATR(candles,10);
  const mfi10=calcMFI(candles,10);
  const ema20=calcEMA(cls,20);
  const warmup=30, rows=[], labels=[];

  // Compute rolling vol avg
  function volAvg(i,p=20){const sl=vls.slice(Math.max(0,i-p+1),i+1);return sl.reduce((a,b)=>a+b,0)/sl.length;}
  // ATR percentile
  function atrPct(i){if(!atr14[i])return 0.5;const vals=atr14.slice(Math.max(14,i-100),i+1).filter(v=>v);return vals.filter(v=>v<=atr14[i]).length/vals.length;}
  // Streak
  function streak(i){const dir=cls[i]>ops[i]?1:-1;let s=0;for(let j=i;j>=0;j--){if((cls[j]>ops[j]?1:-1)===dir)s++;else break;}return dir*s;}

  for(let i=warmup;i<candles.length-1;i++){
    if(!bb20_22[i]||!bb15_22[i]||rsi14[i]===null||mfi10[i]===null||!atr14[i]||!ema20[i])continue;
    const s=streak(i);
    const bbPos=(cls[i]-bb20_22[i].lower)/(bb20_22[i].upper-bb20_22[i].lower||1); // 0=at lower, 1=at upper
    const bbDev22=cls[i]>bb20_22[i].upper?(cls[i]-bb20_22[i].upper)/bb20_22[i].upper:cls[i]<bb20_22[i].lower?(bb20_22[i].lower-cls[i])/bb20_22[i].lower:0;
    const body=Math.abs(cls[i]-ops[i])/cls[i];
    const upperWick=(his[i]-Math.max(cls[i],ops[i]))/cls[i];
    const lowerWick=(Math.min(cls[i],ops[i])-los[i])/cls[i];
    const volRatio=volAvg(i)>0?vls[i]/volAvg(i):1;
    const hour=new Date(candles[i].open_time).getUTCHours();
    const dow=new Date(candles[i].open_time).getUTCDay();
    const isGoodHour=[10,11,12,21].includes(hour)?1:0;
    const bbWidth=(bb20_22[i].upper-bb20_22[i].lower)/bb20_22[i].mid;
    const priceVsEma=(cls[i]-ema20[i])/ema20[i];
    // Feature vector
    rows.push([
      bbPos,               // 0: position in BB (0=lower, 1=upper)
      bbDev22,             // 1: deviation outside BB
      s,                   // 2: streak (signed)
      Math.abs(s),         // 3: streak magnitude
      rsi14[i]/100,        // 4: RSI14 normalized
      rsi7[i]/100,         // 5: RSI7 normalized
      mfi10[i]/100,        // 6: MFI10 normalized
      body*100,            // 7: body %
      body/((atr14[i]/cls[i])||0.001), // 8: body/ATR ratio
      upperWick*100,       // 9: upper wick %
      lowerWick*100,       // 10: lower wick %
      volRatio,            // 11: volume vs 20-bar avg
      atrPct(i),           // 12: ATR percentile (0=low vol, 1=high vol)
      bbWidth*100,         // 13: BB width (volatility measure)
      priceVsEma*100,      // 14: distance from EMA20
      hour/23,             // 15: hour of day normalized
      dow/6,               // 16: day of week normalized
      isGoodHour,          // 17: is good hour [10,11,12,21]
    ]);
    // Label: 1 if next candle is RED (bearish), 0 if GREEN
    labels.push(candles[i+1].close < candles[i+1].open ? 1 : 0);
  }
  return{rows,labels};
}

// Mutual information (binned)
function mutualInfo(feature, labels, bins=10) {
  const n=feature.length;
  const min=Math.min(...feature), max=Math.max(...feature), range=max-min||1;
  const bin=v=>Math.min(bins-1,Math.floor((v-min)/range*bins));
  const pxy={},px={},py={};
  for(let i=0;i<n;i++){const x=bin(feature[i]),y=labels[i],k=`${x}_${y}`;pxy[k]=(pxy[k]||0)+1/n;px[x]=(px[x]||0)+1/n;py[y]=(py[y]||0)+1/n;}
  let mi=0;
  for(const k of Object.keys(pxy)){const[x,y]=k.split('_');const j=pxy[k],mx=px[x],my=py[y];if(j>0)mi+=j*Math.log2(j/(mx*my));}
  return mi;
}

const fNames=['bbPos','bbDev22','streak','streakMag','rsi14','rsi7','mfi10','body%','body/ATR','upperWick','lowerWick','volRatio','atrPct','bbWidth','vsEMA','hour','dow','isGoodHour'];

console.log('=== ETH Random Forest / Feature Importance ===\n');

for(const [lbl,candles] of [['ETH/5m',c5],['ETH/15m',c15]]){
  const{rows,labels}=buildFeatures(candles);
  console.log(`\n--- ${lbl}: ${rows.length} samples ---`);
  // Feature importance via mutual information
  const scores=fNames.map((nm,j)=>({nm,mi:mutualInfo(rows.map(r=>r[j]),labels)}));
  scores.sort((a,b)=>b.mi-a.mi);
  console.log('Feature importance (MI):');
  for(const s of scores)console.log(`  ${s.nm.padEnd(15)}: ${s.mi.toFixed(5)}`);

  // Find best threshold combos from top features using decision tree approach
  // Strategy: find feature thresholds where predicted=1 (BEAR) has WR>65%
  console.log('\nTop feature threshold analysis:');
  const topFeats=scores.slice(0,6).map(s=>fNames.indexOf(s.nm));
  for(const fi of topFeats){
    const vals=rows.map(r=>r[fi]);
    const sorted=[...new Set(vals)].sort((a,b)=>a-b);
    // Test each threshold
    const threshResults=[];
    for(let ti=Math.floor(sorted.length*0.3);ti<sorted.length*0.85;ti+=Math.max(1,Math.floor(sorted.length*0.05))){
      const t=sorted[ti];
      const above=rows.map((r,i)=>({pred:r[fi]>=t,actual:labels[i]}));
      const bearSigs=above.filter(x=>x.pred);
      if(bearSigs.length>=50){const wr=bearSigs.filter(x=>x.actual===1).length/bearSigs.length;if(wr>=0.63)threshResults.push({t:t.toFixed(3),wr:(wr*100).toFixed(1),n:bearSigs.length});}
      const below=above.filter(x=>!x.pred);
      if(below.length>=50){const wr=below.filter(x=>x.actual===0).length/below.length;if(wr>=0.63)threshResults.push({t:`<${t.toFixed(3)}`,wr:(wr*100).toFixed(1),n:below.length});}
    }
    if(threshResults.length>0){
      threshResults.sort((a,b)=>parseFloat(b.wr)-parseFloat(a.wr));
      for(const r of threshResults.slice(0,3))console.log(`  ${fNames[fi]}>=${r.t}: WR=${r.wr}% T=${r.n}`);
    }
  }
}

// Decision tree: find best 2-feature interaction
console.log('\n=== ETH/15m 2-Feature Decision Tree ===');
const{rows:rows15,labels:labels15}=buildFeatures(c15);
// Test BB position × hour interaction
const interestingPairs=[
  [0,17],[1,17],[2,17],[3,17],[4,17],[6,17],  // feature × isGoodHour
  [0,2],[1,2],[4,2],[6,2],                      // feature × streak
  [4,1],[6,1],                                   // rsi/mfi × bbDev
];
console.log('Top 2-feature combinations (WR>=65%, T>=50):');
for(const[fi,fj] of interestingPairs){
  // Scan threshold pairs
  const valsI=rows15.map(r=>r[fi]), valsJ=rows15.map(r=>r[fj]);
  const sortedI=[...new Set(valsI)].sort((a,b)=>a-b);
  const sortedJ=[...new Set(valsJ)].sort((a,b)=>a-b);
  for(const ti of [0.5,0.6,0.7,0.75,0.8,0.85,0.9].map(p=>sortedI[Math.floor(p*sortedI.length)]||0)){
    for(const tj of [0.5,0.6,0.7,0.75,0.8].map(p=>sortedJ[Math.floor(p*sortedJ.length)]||0)){
      const sigs=rows15.map((r,i)=>({pred:r[fi]>=ti&&r[fj]>=tj,actual:labels15[i]})).filter(x=>x.pred);
      if(sigs.length>=50){const wr=sigs.filter(x=>x.actual===1).length/sigs.length;if(wr>=0.65)console.log(`  ${fNames[fi]}>=${ti.toFixed(2)} AND ${fNames[fj]}>=${tj.toFixed(2)}: WR=${(wr*100).toFixed(1)}% T=${sigs.length}`);}
    }
  }
}
