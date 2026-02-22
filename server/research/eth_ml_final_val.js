var Database = require('better-sqlite3');
var path = require('path');
var db = new Database(path.join(__dirname, '../../trader.db'));
function getCandles(sym,tf){return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC').all(sym,tf);}
function calcBB(closes,p,m){var b=[];for(var i=0;i<closes.length;i++){if(i<p-1){b.push(null);continue;}var sl=closes.slice(i-p+1,i+1);var mn=sl.reduce(function(a,b){return a+b;},0)/p;var vr=sl.reduce(function(a,b){return a+(b-mn)*(b-mn);},0)/p;var s=Math.sqrt(vr);b.push({upper:mn+m*s,lower:mn-m*s});}return b;}
function calcMFI(H,L,C,V,p){var m=new Array(C.length).fill(null);var tp=C.map(function(c,i){return(H[i]+L[i]+c)/3;});var mf=tp.map(function(t,i){return t*V[i];});for(var i=p;i<C.length;i++){var pf=0,nf=0;for(var j=i-p+1;j<=i;j++){if(tp[j]>tp[j-1])pf+=mf[j];else nf+=mf[j];}m[i]=nf===0?100:100-100/(1+pf/nf);}return m;}
function wf(sigs){var n=3,fs=Math.floor(sigs.length/n),res=[];for(var f=0;f<n;f++){var st=f*fs,en=f===n-1?sigs.length:st+fs;var fold=sigs.slice(st,en);res.push({wr:fold.length>0?fold.filter(function(s){return s.win;}).length/fold.length:0,n:fold.length});}var wrs=res.map(function(r){return r.wr;});var avg=wrs.reduce(function(a,b){return a+b;},0)/n;var vr=wrs.reduce(function(a,b){return a+(b-avg)*(b-avg);},0)/n;return{avgWR:avg*100,sigma:Math.sqrt(vr)*100,folds:res,total:sigs.length};}
function sk(op,cl,i){var d=cl[i]>op[i]?1:-1;var s=0;for(var j=i;j>=0;j--){if((cl[j]>op[j]?1:-1)===d)s++;else break;}return{streak:s,dir:d};}
function rep(lbl,sigs){if(sigs.length<20){console.log(lbl+': T='+sigs.length+' (too few)');return;}var r=wf(sigs);var fs=r.folds.map(function(f){return(f.wr*100).toFixed(1)+'%['+f.n+']';}).join('/');var p=r.avgWR>=65&&r.sigma<=8&&r.total>=50;console.log(lbl+': WR='+r.avgWR.toFixed(1)+'% sigma='+r.sigma.toFixed(1)+'% T='+r.total+' ['+fs+'] '+(p?'*** PASS ***':''));}

function calcMFI(H,L,C,V,p){var m=new Array(C.length).fill(null);var tp=C.map(function(c,i){return(H[i]+L[i]+c)/3;});var mf=tp.map(function(t,i){return t*V[i];});for(var i=p;i<C.length;i++){var pf=0,nf=0;for(var j=i-p+1;j<=i;j++){if(tp[j]>tp[j-1])pf+=mf[j];else nf+=mf[j];}m[i]=nf===0?100:100-100/(1+pf/nf);}return m;}
function wfN(sigs,nFolds){var fs2=Math.floor(sigs.length/nFolds),res=[];for(var f=0;f<nFolds;f++){var st=f*fs2,en=f===nFolds-1?sigs.length:st+fs2;var fold=sigs.slice(st,en);res.push({wr:fold.length>0?fold.filter(function(s){return s.win;}).length/fold.length:0,n:fold.length});}var wrs=res.map(function(r){return r.wr;});var avg=wrs.reduce(function(a,b){return a+b;},0)/nFolds;var vr=wrs.reduce(function(a,b){return a+(b-avg)*(b-avg);},0)/nFolds;return{avgWR:avg*100,sigma:Math.sqrt(vr)*100,folds:res,total:sigs.length};}
function sk(op,cl,i){var d=cl[i]>op[i]?1:-1;var s=0;for(var j=i;j>=0;j--){if((cl[j]>op[j]?1:-1)===d)s++;else break;}return{streak:s,dir:d};}
var GH=new Set([10,11,12,21]);
var PASS_MSG = "*** PASS ***";
function rep(lbl,sigs){
  [3,5].forEach(function(n){
    if(sigs.length < n*8) return;
    var r=wfN(sigs,n);
    var fStr=r.folds.map(function(f){return (f.wr*100).toFixed(1)+"%["+f.n+"]";}).join("/");
    var pass=r.avgWR>=65&&r.sigma<=8&&r.total>=50;
    console.log(n+"-fold "+lbl+": WR="+r.avgWR.toFixed(1)+"% sigma="+r.sigma.toFixed(1)+"% T="+r.total+" ["+fStr+"] "+(pass?PASS_MSG:""));
  });
}

console.log("=== 5-FOLD FINAL VALIDATION ===");