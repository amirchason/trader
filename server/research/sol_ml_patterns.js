'use strict';
// SOL candle sequence patterns + Keltner+BB + Daily Range
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

function getCandles(s,tf){return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(s,tf);}
function calcBB(closes,p,m){const b=[];for(let i=0;i<closes.length;i++){if(i<p-1){b.push(null);continue;}const sl=closes.slice(i-p+1,i+1),mn=sl.reduce((a,x)=>a+x,0)/p,std=Math.sqrt(sl.reduce((a,x)=>a+(x-mn)**2,0)/p);b.push({upper:mn+m*std,lower:mn-m*std,mid:mn,std});}return b;}
function calcEMA(closes,p){const e=new Array(closes.length).fill(null);const k=2/(p+1);e[p-1]=closes.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<closes.length;i++)e[i]=closes[i]*k+e[i-1]*(1-k);return e;}
function calcATR(candles,p){const a=new Array(candles.length).fill(null);let s=0;for(let i=1;i<candles.length;i++){const tr=Math.max(candles[i].high-candles[i].low,Math.abs(candles[i].high-candles[i-1].close),Math.abs(candles[i].low-candles[i-1].close));if(i<p)s+=tr;else if(i===p){s+=tr;a[i]=s/p;}else a[i]=(a[i-1]*(p-1)+tr)/p;}return a;}
function synth15m(c){const r=[];for(let i=2;i<c.length;i+=3){const g=[c[i-2],c[i-1],c[i]];r.push({open_time:g[0].open_time,open:g[0].open,high:Math.max(...g.map(x=>x.high)),low:Math.min(...g.map(x=>x.low)),close:g[2].close,volume:g.reduce((s,x)=>s+x.volume,0)});}return r;}
function walkForward(signals,nFolds=3){const sz=Math.floor(signals.length/nFolds),res=[];for(let f=0;f<nFolds;f++){const fold=signals.slice(f*sz,f===nFolds-1?signals.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nFolds;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nFolds),folds:res,total:signals.length};}
function report(label,signals){if(signals.length<20){console.log(`${label}: T=${signals.length} (too few)`);return;}const wf=walkForward(signals);const fs=wf.folds.map(f=>`${f.wr.toFixed(1)}(${f.n})`).join('/');const pass=wf.avg>=65&&wf.sigma<=8;console.log(`${label}: WR=${wf.avg.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${wf.total} [${fs}]${pass?' *** PASS ***':''}`);}

const raw5m = getCandles('SOL','5m');
const candles = synth15m(raw5m);
const closes = candles.map(c=>c.close);
const SOL_GOOD_HOURS = new Set([0,12,13,20]);

// ── Candle Sequence Patterns ──
console.log('=== SOL Candle Sequence Patterns ===\n');
function isGreen(c){return c.close>c.open;}
function isRed(c){return c.close<c.open;}

for (const [bbP,bbM] of [[20,2.2],[25,2.2]]) {
  const bb = calcBB(closes, bbP, bbM);
  const warmup = bbP+4;

  // RGGG → BEAR (at BB upper)
  const rggg=[]; const grgg=[]; const rrrg=[];
  const rggr=[]; const gggr_bull=[];
  for (let i=warmup; i<candles.length-1; i++) {
    if (!bb[i]) continue;
    const [c0,c1,c2,c3]=[candles[i-3],candles[i-2],candles[i-1],candles[i]];
    if (isRed(c0)&&isGreen(c1)&&isGreen(c2)&&isGreen(c3)&&c3.close>=bb[i].upper)
      rggg.push({win:candles[i+1].close<candles[i+1].open});
    if (isGreen(c0)&&isRed(c1)&&isGreen(c2)&&isGreen(c3)&&c3.close>=bb[i].upper)
      grgg.push({win:candles[i+1].close<candles[i+1].open});
    if (isRed(c0)&&isRed(c1)&&isRed(c2)&&isGreen(c3)&&c3.close<=bb[i].lower)
      rrrg.push({win:candles[i+1].close>candles[i+1].open});
    if (isRed(c0)&&isGreen(c1)&&isGreen(c2)&&isRed(c3)&&c3.close>=bb[i].upper)
      rggr.push({win:candles[i+1].close<candles[i+1].open});
    if (isGreen(c0)&&isGreen(c1)&&isGreen(c2)&&isRed(c3)&&c3.close>=bb[i].upper)
      gggr_bull.push({win:candles[i+1].close<candles[i+1].open});
  }
  report(`SOL RGGG→BEAR BB(${bbP},${bbM})`,rggg);
  report(`SOL GRGG→BEAR BB(${bbP},${bbM})`,grgg);
  report(`SOL RRRG→BULL BB(${bbP},${bbM})`,rrrg);
  report(`SOL RGGR→BEAR BB(${bbP},${bbM})`,rggr);
  report(`SOL GGGR→BEAR BB(${bbP},${bbM})`,gggr_bull);
}

// ── Keltner+BB Squeeze ──
console.log('\n=== SOL Keltner+BB Squeeze ===');
const ema20 = calcEMA(closes, 20);
const atr10 = calcATR(candles, 10);
for (const [kMult, bbP, bbM] of [[1.5,20,2.2],[2.0,20,2.2],[1.5,25,2.2],[2.0,25,2.2]]) {
  const bb = calcBB(closes, bbP, bbM);
  const signals = [];
  for (let i=25; i<candles.length-1; i++) {
    if (!bb[i]||!ema20[i]||!atr10[i]) continue;
    const hour = new Date(candles[i].open_time).getUTCHours();
    if (!SOL_GOOD_HOURS.has(hour)) continue;
    const kUpper = ema20[i]+kMult*atr10[i];
    const kLower = ema20[i]-kMult*atr10[i];
    if (candles[i].close>kUpper&&candles[i].close>bb[i].upper)
      signals.push({win:candles[i+1].close<candles[i+1].open});
    if (candles[i].close<kLower&&candles[i].close<bb[i].lower)
      signals.push({win:candles[i+1].close>candles[i+1].open});
  }
  report(`SOL Keltner(20,${kMult})+BB(${bbP},${bbM}) GoodH`,signals);
}

// ── Daily Range Extreme ──
console.log('\n=== SOL Daily Range Extreme ===');
for (const pct of [0.25,0.30,0.35]) {
  const bb = calcBB(closes, 20, 2.2);
  // Group by day
  const byDay = {};
  for (let i=0;i<candles.length;i++) {
    const d=new Date(candles[i].open_time); const key=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    if(!byDay[key])byDay[key]={high:-Infinity,low:Infinity};
    if(candles[i].high>byDay[key].high)byDay[key].high=candles[i].high;
    if(candles[i].low<byDay[key].low)byDay[key].low=candles[i].low;
  }
  const signals=[];
  for (let i=20;i<candles.length-1;i++) {
    if(!bb[i])continue;
    const hour=new Date(candles[i].open_time).getUTCHours();
    if(!SOL_GOOD_HOURS.has(hour))continue;
    const d=new Date(candles[i].open_time); const key=`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
    const dayInfo=byDay[key]; if(!dayInfo)continue;
    const range=dayInfo.high-dayInfo.low; if(range===0)continue;
    const posInRange=(candles[i].close-dayInfo.low)/range;
    if(posInRange>=(1-pct)&&candles[i].close>=bb[i].upper)
      signals.push({win:candles[i+1].close<candles[i+1].open});
    if(posInRange<=pct&&candles[i].close<=bb[i].lower)
      signals.push({win:candles[i+1].close>candles[i+1].open});
  }
  report(`SOL DailyRange top/bot ${(pct*100).toFixed(0)}%+BB(20,2.2) GoodH`,signals);
}
