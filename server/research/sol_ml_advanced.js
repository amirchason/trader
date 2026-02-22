'use strict';
// SOL Advanced: h17 stabilization, synth30m context, ATR regime, double-confirm
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

const raw5m = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('SOL','5m');

function synth15m(c){const r=[];for(let i=2;i<c.length;i+=3){const g=[c[i-2],c[i-1],c[i]];r.push({open_time:g[0].open_time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[2].close,volume:g.reduce((s,x)=>s+x.volume,0)});}return r;}
function synth30m(c){const r=[];for(let i=5;i<c.length;i+=6){const g=c.slice(i-5,i+1);r.push({open_time:g[0].open_time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[5].close,volume:g.reduce((s,x)=>s+x.volume,0)});}return r;}
function calcBB(candles,p,m){const cls=candles.map(c=>c.close);return cls.map((_,i)=>{if(i<p-1)return null;const sl=cls.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcRSI(candles,p){const cls=candles.map(c=>c.close),r=new Array(cls.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=cls[i]-cls[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<cls.length;i++){const d=cls[i]-cls[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function calcATR(candles,p){const a=new Array(candles.length).fill(null);let s=0;for(let i=1;i<candles.length;i++){const tr=Math.max(candles[i].high-candles[i].low,Math.abs(candles[i].high-candles[i-1].close),Math.abs(candles[i].low-candles[i-1].close));if(i<p)s+=tr;else if(i===p){s+=tr;a[i]=s/p;}else a[i]=(a[i-1]*(p-1)+tr)/p;}return a;}
function getStreak(candles,i){const dir=candles[i].close>candles[i].open?1:-1;let s=0;for(let j=i;j>=0;j--){if((candles[j].close>candles[j].open?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function wf(signals,nF=3){const sz=Math.floor(signals.length/nF),res=[];for(let f=0;f<nF;f++){const fold=signals.slice(f*sz,f===nF-1?signals.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:signals.length};}
function rpt(lbl,sigs){if(sigs.length<20){console.log(`${lbl}: T=${sigs.length} (too few)`);return;}const r=wf(sigs);const fs=r.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(`${lbl}: WR=${r.avg.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.total} [${fs}]${pass?' *** PASS ***':''}`);}

const c15 = synth15m(raw5m);
const c30 = synth30m(raw5m);
const SOL_GOOD = new Set([0,12,13,20]);

console.log('=== SOL Advanced Research ===\n');

// ── Hour 17 Stabilization ──
console.log('--- SOL Hour 17 Stabilization (add RSI/ATR filters) ---');
const bb15_22 = calcBB(c15, 20, 2.2);
const rsi15 = calcRSI(c15, 14);
const atr15 = calcATR(c15, 14);

// ATR percentile for 15m
function atrPct(i,window=100){if(!atr15[i])return null;const vals=atr15.slice(Math.max(14,i-window),i+1).filter(v=>v);return vals.filter(v=>v<=atr15[i]).length/vals.length;}

for(const rsiT of [60,65,70,75]){
  const sigs=[];
  for(let i=20;i<c15.length-1;i++){
    if(!bb15_22[i]||rsi15[i]===null)continue;
    if(new Date(c15[i].open_time).getUTCHours()!==17)continue;
    const{streak,dir}=getStreak(c15,i);if(streak<1)continue;
    if(dir===1&&c15[i].close>=bb15_22[i].upper&&rsi15[i]>=rsiT)sigs.push({win:c15[i+1].close<c15[i+1].open});
    if(dir===-1&&c15[i].close<=bb15_22[i].lower&&rsi15[i]<=(100-rsiT))sigs.push({win:c15[i+1].close>c15[i+1].open});
  }
  rpt(`h=17+RSI${rsiT}+BB(20,2.2)+s≥1`,sigs);
}

// ── Synth 30m Context Filter ──
console.log('\n--- SOL Synth30m as context filter for 15m signals ---');
const bb30 = calcBB(c30, 20, 2.2);

// Map each 15m bar to nearest 30m bar
function get30mContext(ts15) {
  // Find the 30m bar that contains this 15m timestamp
  for(let i=c30.length-1;i>=0;i--){
    if(c30[i].open_time<=ts15)return i;
  }
  return -1;
}

for(const hrs of [[0,12,13,20],[0,12,13,20,17]]){
  const hset=new Set(hrs);
  // Only trade when 30m is also at BB extreme (same direction)
  const sigs=[];
  for(let i=20;i<c15.length-1;i++){
    if(!bb15_22[i])continue;
    if(!hset.has(new Date(c15[i].open_time).getUTCHours()))continue;
    const{streak,dir}=getStreak(c15,i);if(streak<2)continue;
    const j=get30mContext(c15[i].open_time);if(j<0||!bb30[j])continue;
    // 30m context: price direction same as signal
    const above30m=c30[j].close>=bb30[j].upper, below30m=c30[j].close<=bb30[j].lower;
    if(dir===1&&c15[i].close>=bb15_22[i].upper&&above30m)sigs.push({win:c15[i+1].close<c15[i+1].open});
    if(dir===-1&&c15[i].close<=bb15_22[i].lower&&below30m)sigs.push({win:c15[i+1].close>c15[i+1].open});
  }
  rpt(`SOL h=[${hrs}]+15m BB+s≥2+30m_BB_confirm`,sigs);
}

// ── ATR Regime on SOL/15m ──
console.log('\n--- SOL Low-ATR Regime ---');
for(const pctT of [0.33,0.40,0.50]){
  for(const hrs of [[0,12,13,20],[0,12,13,20,17]]){
    const hset=new Set(hrs);
    for(const minS of [1,2]){
      const sigs=[];
      for(let i=100;i<c15.length-1;i++){
        if(!bb15_22[i])continue;
        if(!hset.has(new Date(c15[i].open_time).getUTCHours()))continue;
        const pct=atrPct(i);if(pct===null||pct>pctT)continue;
        const{streak,dir}=getStreak(c15,i);if(streak<minS)continue;
        if(dir===1&&c15[i].close>=bb15_22[i].upper)sigs.push({win:c15[i+1].close<c15[i+1].open});
        if(dir===-1&&c15[i].close<=bb15_22[i].lower)sigs.push({win:c15[i+1].close>c15[i+1].open});
      }
      rpt(`SOL LowATR${(pctT*100).toFixed(0)}% h=[${hrs}]+BB+s≥${minS}`,sigs);
    }
  }
}

// ── Double Confirm: RSI + MFI both extreme ──
console.log('\n--- SOL Double Oscillator (RSI + MFI both extreme) ---');
function calcMFI(candles,p){const m=new Array(candles.length).fill(null);for(let i=p;i<candles.length;i++){let pos=0,neg=0;for(let j=i-p+1;j<=i;j++){const tp=(candles[j].high+candles[j].low+candles[j].close)/3,ptp=(candles[j-1].high+candles[j-1].low+candles[j-1].close)/3,rf=tp*candles[j].volume;if(tp>ptp)pos+=rf;else neg+=rf;}m[i]=neg===0?100:100-100/(1+pos/neg);}return m;}
const mfi15=calcMFI(c15,10);
for(const [rsiT,mfiT] of [[65,75],[65,80],[70,75],[70,80]]){
  const sigs=[];
  for(let i=20;i<c15.length-1;i++){
    if(!bb15_22[i]||rsi15[i]===null||mfi15[i]===null)continue;
    if(!SOL_GOOD.has(new Date(c15[i].open_time).getUTCHours()))continue;
    const{streak,dir}=getStreak(c15,i);if(streak<1)continue;
    if(dir===1&&c15[i].close>=bb15_22[i].upper&&rsi15[i]>=rsiT&&mfi15[i]>=mfiT)sigs.push({win:c15[i+1].close<c15[i+1].open});
    if(dir===-1&&c15[i].close<=bb15_22[i].lower&&rsi15[i]<=(100-rsiT)&&mfi15[i]<=(100-mfiT))sigs.push({win:c15[i+1].close>c15[i+1].open});
  }
  rpt(`SOL RSI>${rsiT}+MFI>${mfiT}+BB(20,2.2)+GoodH+s≥1`,sigs);
}

// ── SOL/30m native patterns ──
console.log('\n--- SOL Synth30m native BB patterns ---');
const bb30_20 = calcBB(c30, 20, 2.2);
const rsi30 = calcRSI(c30, 14);
for(const minS of [1,2,3]){
  for(const hrs of [null,[0,6,12,18]]){
    const sigs=[];
    for(let i=20;i<c30.length-1;i++){
      if(!bb30_20[i])continue;
      if(hrs&&!new Set(hrs).has(new Date(c30[i].open_time).getUTCHours()))continue;
      const{streak,dir}=getStreak(c30,i);if(streak<minS)continue;
      if(dir===1&&c30[i].close>=bb30_20[i].upper)sigs.push({win:c30[i+1].close<c30[i+1].open});
      if(dir===-1&&c30[i].close<=bb30_20[i].lower)sigs.push({win:c30[i+1].close>c30[i+1].open});
    }
    rpt(`SOL synth30m BB(20,2.2) s≥${minS}${hrs?` h=[${hrs}]`:' AllH'}`,sigs);
  }
}
