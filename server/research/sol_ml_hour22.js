'use strict';
// SOL hour 22 deep-dive — try to reduce sigma from 8.2% to <=8%
// Also test new hour combos with h=22 and h=17
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

function getCandles(s,tf){return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(s,tf);}
function calcBB(closes,p,m){const b=[];for(let i=0;i<closes.length;i++){if(i<p-1){b.push(null);continue;}const sl=closes.slice(i-p+1,i+1),mn=sl.reduce((a,x)=>a+x,0)/p,std=Math.sqrt(sl.reduce((a,x)=>a+(x-mn)**2,0)/p);b.push({upper:mn+m*std,lower:mn-m*std,mid:mn,std});}return b;}
function calcRSI(closes,p){const r=new Array(closes.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function synth15m(c){const r=[];for(let i=2;i<c.length;i+=3){const g=[c[i-2],c[i-1],c[i]];r.push({open_time:g[0].open_time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[2].close,volume:g.reduce((s,x)=>s+x.volume,0)});}return r;}
function getStreak(candles,i){const dir=candles[i].close>candles[i].open?1:-1;let s=0;for(let j=i;j>=0;j--){if((candles[j].close>candles[j].open?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function walkForward(signals,nFolds=3){const sz=Math.floor(signals.length/nFolds),res=[];for(let f=0;f<nFolds;f++){const fold=signals.slice(f*sz,f===nFolds-1?signals.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nFolds;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nFolds),folds:res,total:signals.length};}
function report(label,signals){if(signals.length<15){console.log(`${label}: T=${signals.length} (too few)`);return;}const wf=walkForward(signals);const fs=wf.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');const pass=wf.avg>=65&&wf.sigma<=8;console.log(`${label}: WR=${wf.avg.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${fs}]${pass?' *** PASS ***':''}`);}

const raw5m = getCandles('SOL','5m');
const candles = synth15m(raw5m);
const closes = candles.map(c=>c.close);
const rsi = calcRSI(closes, 14);

console.log('=== SOL Hour 22 Deep Dive + New Hour Combos ===\n');

// Hour 22 alone with additional filters
const bb22 = calcBB(closes, 20, 2.2);
const combos = [
  {hours:[22],label:'h=22'},
  {hours:[0,22],label:'h=[0,22]'},
  {hours:[0,12,22],label:'h=[0,12,22]'},
  {hours:[0,12,13,20,22],label:'h=[0,12,13,20,22]'},
  {hours:[0,12,13,22],label:'h=[0,12,13,22]'},
  {hours:[0,13,20,22],label:'h=[0,13,20,22]'},
  {hours:[0,12,13,20,17],label:'h=[0,12,13,20,17]'},  // from hours2 pass
  {hours:[0,13,20],label:'h=[0,13,20]'},               // from hours2 pass
];

for (const combo of combos) {
  const hset = new Set(combo.hours);
  // Basic BB+streak
  for (const minS of [1,2]) {
    for (const [bbP,bbM] of [[20,2.2],[25,2.2]]) {
      const bb = calcBB(closes, bbP, bbM);
      const signals=[];
      for (let i=bbP+2;i<candles.length-1;i++) {
        if (!bb[i]) continue;
        const hour=new Date(candles[i].open_time).getUTCHours();
        if (!hset.has(hour)) continue;
        const {streak,dir}=getStreak(candles,i);
        if (streak<minS) continue;
        if (dir===1&&candles[i].close>=bb[i].upper) signals.push({win:candles[i+1].close<candles[i+1].open});
        if (dir===-1&&candles[i].close<=bb[i].lower) signals.push({win:candles[i+1].close>candles[i+1].open});
      }
      report(`${combo.label}+BB(${bbP},${bbM})+s≥${minS}`,signals);
    }
  }
}

// h=22 with BB deviation filter (0.05-0.25% sweet spot)
console.log('\n--- h=22 with BB deviation filter ---');
const bb = calcBB(closes, 20, 2.2);
for (const [devMin,devMax] of [[0.0005,0.0025],[0.0003,0.003],[0.001,0.003]]) {
  const signals=[];
  for (let i=22;i<candles.length-1;i++) {
    if (!bb[i]) continue;
    const hour=new Date(candles[i].open_time).getUTCHours();
    if (hour!==22) continue;
    const {streak,dir}=getStreak(candles,i);
    if (streak<1) continue;
    if (dir===1&&candles[i].close>=bb[i].upper) {
      const dev=(candles[i].close-bb[i].upper)/bb[i].upper;
      if (dev>=devMin&&dev<=devMax) signals.push({win:candles[i+1].close<candles[i+1].open});
    }
    if (dir===-1&&candles[i].close<=bb[i].lower) {
      const dev=(bb[i].lower-candles[i].close)/bb[i].lower;
      if (dev>=devMin&&dev<=devMax) signals.push({win:candles[i+1].close>candles[i+1].open});
    }
  }
  report(`h=22+BB(20,2.2)+dev[${(devMin*100).toFixed(2)}-${(devMax*100).toFixed(2)}%]`,signals);
}

// RSI confirmation on h=22
console.log('\n--- h=22 with RSI confirmation ---');
for (const rsiT of [60,65,70]) {
  const signals=[];
  for (let i=22;i<candles.length-1;i++) {
    if (!bb[i]||rsi[i]===null) continue;
    const hour=new Date(candles[i].open_time).getUTCHours();
    if (hour!==22) continue;
    const {streak,dir}=getStreak(candles,i);
    if (streak<1) continue;
    if (dir===1&&candles[i].close>=bb[i].upper&&rsi[i]>=rsiT) signals.push({win:candles[i+1].close<candles[i+1].open});
    if (dir===-1&&candles[i].close<=bb[i].lower&&rsi[i]<=(100-rsiT)) signals.push({win:candles[i+1].close>candles[i+1].open});
  }
  report(`h=22+BB(20,2.2)+RSI${rsiT}`,signals);
}
