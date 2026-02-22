'use strict';
// SOL RSI Panic + MFI Exhaustion on synth 15m
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

function getCandles(s,tf){return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(s,tf);}
function calcBB(closes,p,m){const b=[];for(let i=0;i<closes.length;i++){if(i<p-1){b.push(null);continue;}const sl=closes.slice(i-p+1,i+1),mn=sl.reduce((a,x)=>a+x,0)/p,std=Math.sqrt(sl.reduce((a,x)=>a+(x-mn)**2,0)/p);b.push({upper:mn+m*std,lower:mn-m*std,mid:mn,std});}return b;}
function calcRSI(closes,p){const r=new Array(closes.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function calcMFI(candles,p){const m=new Array(candles.length).fill(null);for(let i=p;i<candles.length;i++){let pos=0,neg=0;for(let j=i-p+1;j<=i;j++){const tp=(candles[j].high+candles[j].low+candles[j].close)/3,ptp=(candles[j-1].high+candles[j-1].low+candles[j-1].close)/3,rf=tp*candles[j].volume;if(tp>ptp)pos+=rf;else neg+=rf;}m[i]=neg===0?100:100-100/(1+pos/neg);}return m;}
function synth15m(c){const r=[];for(let i=2;i<c.length;i+=3){const g=[c[i-2],c[i-1],c[i]];r.push({open_time:g[0].open_time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[2].close,volume:g.reduce((s,x)=>s+x.volume,0)});}return r;}
function getStreak(candles,i){const dir=candles[i].close>candles[i].open?1:-1;let s=0;for(let j=i;j>=0;j--){if((candles[j].close>candles[j].open?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function walkForward(signals,nFolds=3){const sz=Math.floor(signals.length/nFolds),res=[];for(let f=0;f<nFolds;f++){const fold=signals.slice(f*sz,f===nFolds-1?signals.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nFolds;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nFolds),folds:res,total:signals.length};}

const raw5m = getCandles('SOL','5m');
const candles = synth15m(raw5m);
const closes = candles.map(c=>c.close);
const SOL_GOOD_HOURS = new Set([0,12,13,20]);

console.log('=== SOL/15m synth RSI Panic + MFI Exhaustion ===\n');

// ── RSI Panic ──
console.log('--- SOL RSI Panic (RSI>thresh + body + BB upper → BEAR) ---');
const rsi = calcRSI(closes, 14);
for (const rsiT of [65,70,75]) {
  for (const bodyT of [0.002,0.003,0.004]) {
    for (const [bbP,bbM] of [[20,2.2],[25,2.2]]) {
      for (const goodH of [true,false]) {
        const bb = calcBB(closes, bbP, bbM);
        const signals = [];
        for (let i=bbP+2; i<candles.length-1; i++) {
          const hour = new Date(candles[i].open_time).getUTCHours();
          if (goodH && !SOL_GOOD_HOURS.has(hour)) continue;
          if (!bb[i]||rsi[i]===null) continue;
          const body = Math.abs(candles[i].close-candles[i].open)/candles[i].open;
          if (rsi[i]>=rsiT && candles[i].close>=bb[i].upper && body>=bodyT) {
            signals.push({win:candles[i+1].close<candles[i+1].open});
          }
          // Also BULL side
          if (rsi[i]<=(100-rsiT) && candles[i].close<=bb[i].lower && body>=bodyT) {
            signals.push({win:candles[i+1].close>candles[i+1].open});
          }
        }
        if (signals.length<20) continue;
        const wf=walkForward(signals);
        const fs=wf.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');
        const pass=wf.avg>=65&&wf.sigma<=8;
        if (pass||wf.avg>=62) console.log(`RSI${rsiT} body${(bodyT*100).toFixed(1)}% BB(${bbP},${bbM}) GoodH=${goodH}: WR=${wf.avg.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${fs}]${pass?' *** PASS ***':''}`);
      }
    }
  }
}

// ── MFI Exhaustion ──
console.log('\n--- SOL MFI Exhaustion (MFI>thresh + BB + streak → BEAR/BULL) ---');
const mfi = calcMFI(candles, 10);
for (const mfiT of [75,80,85]) {
  for (const minS of [1,2]) {
    for (const [bbP,bbM] of [[20,2.2],[25,2.2]]) {
      for (const goodH of [true,false]) {
        const bb = calcBB(closes, bbP, bbM);
        const signals = [];
        for (let i=Math.max(10,bbP)+2; i<candles.length-1; i++) {
          const hour = new Date(candles[i].open_time).getUTCHours();
          if (goodH && !SOL_GOOD_HOURS.has(hour)) continue;
          if (!bb[i]||mfi[i]===null) continue;
          const {streak,dir} = getStreak(candles,i);
          if (streak<minS) continue;
          if (mfi[i]>=mfiT && dir===1 && candles[i].close>=bb[i].upper) {
            signals.push({win:candles[i+1].close<candles[i+1].open});
          }
          if (mfi[i]<=(100-mfiT) && dir===-1 && candles[i].close<=bb[i].lower) {
            signals.push({win:candles[i+1].close>candles[i+1].open});
          }
        }
        if (signals.length<20) continue;
        const wf=walkForward(signals);
        const fs=wf.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');
        const pass=wf.avg>=65&&wf.sigma<=8;
        if (pass||wf.avg>=62) console.log(`MFI>${mfiT} s≥${minS} BB(${bbP},${bbM}) GoodH=${goodH}: WR=${wf.avg.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${fs}]${pass?' *** PASS ***':''}`);
      }
    }
  }
}
