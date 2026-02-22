'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));
const candles = db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all('ETH','5m');
const opens=candles.map(c=>c.open),highs=candles.map(c=>c.high),lows=candles.map(c=>c.low),closes=candles.map(c=>c.close),vols=candles.map(c=>c.volume);
const GOOD_HOURS=new Set([10,11,12,21]);
function calcBB(p,m){return closes.map((_,i)=>{if(i<p-1)return null;const sl=closes.slice(i-p+1,i+1),mn=sl.reduce((a,b)=>a+b,0)/p,std=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/p);return{upper:mn+m*std,lower:mn-m*std,mid:mn,std};});}
function calcATR(p){const a=new Array(candles.length).fill(null);let s=0;for(let i=1;i<candles.length;i++){const tr=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));if(i<p)s+=tr;else if(i===p){s+=tr;a[i]=s/p;}else a[i]=(a[i-1]*(p-1)+tr)/p;}return a;}
function calcRSI(p){const r=new Array(closes.length).fill(null);let ag=0,al=0;for(let i=1;i<=p;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al-=d;}ag/=p;al/=p;r[p]=100-100/(1+(al===0?Infinity:ag/al));for(let i=p+1;i<closes.length;i++){const d=closes[i]-closes[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;r[i]=100-100/(1+(al===0?Infinity:ag/al));}return r;}
function getStreak(i){const dir=closes[i]>opens[i]?1:-1;let s=0;for(let j=i;j>=0;j--){if((closes[j]>opens[j]?1:-1)===dir)s++;else break;}return{streak:s,dir};}
function wf(signals,nF=3){const sz=Math.floor(signals.length/nF),res=[];for(let f=0;f<nF;f++){const fold=signals.slice(f*sz,f===nF-1?signals.length:(f+1)*sz);res.push({wr:fold.filter(s=>s.win).length/fold.length*100,n:fold.length});}const wrs=res.map(r=>r.wr),avg=wrs.reduce((a,b)=>a+b,0)/nF;return{avg,sigma:Math.sqrt(wrs.reduce((a,b)=>a+(b-avg)**2,0)/nF),folds:res,total:signals.length};}
function rpt(lbl,sigs){if(sigs.length<30){console.log(lbl+': T='+sigs.length);return;}const r=wf(sigs);const fs=r.folds.map(f=>f.wr.toFixed(1)+'('+f.n+')').join('/');const pass=r.avg>=65&&r.sigma<=8;console.log(lbl+': WR='+r.avg.toFixed(1)+'% s='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+']'+(pass?' *** PASS ***':''));}
const atr14=calcATR(14),rsi14=calcRSI(14);
function atrPct(i,w=200){if(!atr14[i])return null;const v=atr14.slice(Math.max(14,i-w),i+1).filter(x=>x);return v.filter(x=>x<=atr14[i]).length/v.length;}
const vwapDev=new Array(candles.length).fill(null);
let cTP=0,cVol=0,curD=-1;
for(let i=0;i<candles.length;i++){const d=new Date(candles[i].open_time).getUTCDate();if(d!==curD){cTP=0;cVol=0;curD=d;}const tp=(highs[i]+lows[i]+closes[i])/3;cTP+=tp*vols[i];cVol+=vols[i];if(cVol>0)vwapDev[i]=(closes[i]-(cTP/cVol))/(cTP/cVol);}
console.log('=== ETH/5m Low-ATR Regime + VWAP ===\n');
console.log('--- Low-ATR Regime ---');
for(const pctT of [0.25,0.33,0.40,0.50]){for(const[bbP,bbM] of [[20,2.2],[20,2.0]]){for(const minS of [2,3]){const bb=calcBB(bbP,bbM);const sigs=[];for(let i=200+bbP;i<candles.length-1;i++){const h=new Date(candles[i].open_time).getUTCHours();if(!GOOD_HOURS.has(h))continue;if(!bb[i])continue;const p=atrPct(i);if(p===null||p>pctT)continue;const{streak,dir}=getStreak(i);if(streak<minS)continue;if(dir===1&&closes[i]>=bb[i].upper)sigs.push({win:candles[i+1].close<candles[i+1].open});if(dir===-1&&closes[i]<=bb[i].lower)sigs.push({win:candles[i+1].close>candles[i+1].open});}rpt('LowATR'+(pctT*100).toFixed(0)+'%+BB('+bbP+','+bbM+')+GoodH+s>='+minS,sigs);}}}
console.log('\n--- VWAP Deviation ---');
for(const devT of [0.002,0.003,0.004]){for(const[bbP,bbM] of [[20,2.2],[20,2.0]]){const bb=calcBB(bbP,bbM);const sigs=[];for(let i=bbP+5;i<candles.length-1;i++){const h=new Date(candles[i].open_time).getUTCHours();if(!GOOD_HOURS.has(h))continue;if(!bb[i]||vwapDev[i]===null)continue;const{streak,dir}=getStreak(i);if(streak<2)continue;if(dir===1&&closes[i]>=bb[i].upper&&vwapDev[i]>=devT)sigs.push({win:candles[i+1].close<candles[i+1].open});if(dir===-1&&closes[i]<=bb[i].lower&&vwapDev[i]<=-devT)sigs.push({win:candles[i+1].close>candles[i+1].open});}rpt('VWAP>='+(devT*100).toFixed(1)+'%+BB('+bbP+','+bbM+')+GoodH+s>=2',sigs);}}
console.log('\n--- LowATR + VWAP combined ---');
const bb22=calcBB(20,2.2);for(const pctT of [0.33,0.40]){for(const devT of [0.002,0.003]){const sigs=[];for(let i=200;i<candles.length-1;i++){const h=new Date(candles[i].open_time).getUTCHours();if(!GOOD_HOURS.has(h))continue;if(!bb22[i]||vwapDev[i]===null)continue;const p=atrPct(i);if(p===null||p>pctT)continue;const{streak,dir}=getStreak(i);if(streak<2)continue;if(dir===1&&closes[i]>=bb22[i].upper&&vwapDev[i]>=devT)sigs.push({win:candles[i+1].close<candles[i+1].open});if(dir===-1&&closes[i]<=bb22[i].lower&&vwapDev[i]<=-devT)sigs.push({win:candles[i+1].close>candles[i+1].open});}rpt('LowATR'+(pctT*100).toFixed(0)+'%+VWAP'+(devT*100).toFixed(1)+'%+BB22+GoodH',sigs);}}
