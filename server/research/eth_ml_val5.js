var Database = require("better-sqlite3");
var path = require("path");
var db = new Database(path.join(__dirname, "../../trader.db"));
function gc(sym,tf){return db.prepare("SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC").all(sym,tf);}
function bb(closes,p,m){var b=[];for(var i=0;i<closes.length;i++){if(i<p-1){b.push(null);continue;}var sl=closes.slice(i-p+1,i+1);var mn=sl.reduce(function(a,x){return a+x;},0)/p;var vr=sl.reduce(function(a,x){return a+(x-mn)*(x-mn);},0)/p;b.push({u:mn+m*Math.sqrt(vr),l:mn-m*Math.sqrt(vr)});}return b;}
function mfi(H,L,C,V,p){var m=new Array(C.length).fill(null);var tp=C.map(function(c,i){return(H[i]+L[i]+c)/3;});var mf=tp.map(function(t,i){return t*V[i];});for(var i=p;i<C.length;i++){var pf=0,nf=0;for(var j=i-p+1;j<=i;j++){if(tp[j]>tp[j-1])pf+=mf[j];else nf+=mf[j];}m[i]=nf===0?100:100-100/(1+pf/nf);}return m;}
function sk(op,cl,i){var d=cl[i]>op[i]?1:-1;var s=0;for(var j=i;j>=0;j--){if((cl[j]>op[j]?1:-1)===d)s++;else break;}return{s:s,d:d};}
function wfn(sigs,n){var fs2=Math.floor(sigs.length/n),res=[];for(var f=0;f<n;f++){var st=f*fs2,en=f===n-1?sigs.length:st+fs2;var fold=sigs.slice(st,en);res.push({wr:fold.length>0?fold.filter(function(x){return x.w;}).length/fold.length:0,n:fold.length});}var wrs=res.map(function(r){return r.wr;});var avg=wrs.reduce(function(a,x){return a+x;},0)/n;var vr=wrs.reduce(function(a,x){return a+(x-avg)*(x-avg);},0)/n;return{avg:avg*100,sig:Math.sqrt(vr)*100,folds:res,tot:sigs.length};}
function rep(lbl,sigs){
  [3,5].forEach(function(n){
    if(sigs.length<n*8)return;
    var r=wfn(sigs,n);
    var fs2=r.folds.map(function(f){return(f.wr*100).toFixed(1)+"["+f.n+"]";}).join("/");
    var pass=r.avg>=65&&r.sig<=8&&r.tot>=50;
    console.log(n+"-fold "+lbl+": WR="+r.avg.toFixed(1)+"% sig="+r.sig.toFixed(1)+"% T="+r.tot+" ["+fs2+"] "+(pass?"PASS":""));
  });
}
var GH=new Set([10,11,12,21]);
var GH2=new Set([10,11,12,13,21]);
console.log("=== 5-FOLD FINAL VALIDATION ===");
console.log("C1");
(function(){
  var c=gc("ETH","15m");
  var op=c.map(function(x){return x.open;}),hi=c.map(function(x){return x.high;});
  var lo=c.map(function(x){return x.low;}),cl=c.map(function(x){return x.close;});
  var vo=c.map(function(x){return x.volume;}),ti=c.map(function(x){return x.open_time;});
  var b22=bb(cl,20,2.2),b20=bb(cl,20,2.0),b15=bb(cl,15,2.2);
  var mf=mfi(hi,lo,cl,vo,10);
  function run(lbl,bnd,mfTh,s,hS){
    var sigs=[];
    for(var i=12;i<c.length-1;i++){
      var hr=new Date(ti[i]).getUTCHours();
      if(!hS.has(hr))continue;
      if(!bnd[i]||mf[i]===null)continue;
      var t=sk(op,cl,i);if(t.s<s)continue;
      if(t.d===1&&mf[i]>=mfTh&&cl[i]>=bnd[i].u)sigs.push({w:c[i+1].close<c[i+1].open});
      else if(t.d===-1&&mf[i]<=(100-mfTh)&&cl[i]<=bnd[i].l)sigs.push({w:c[i+1].close>c[i+1].open});
    }
    rep(lbl,sigs);
  }
  run("C1: ETH/15m MFI>80 BB(20,2.2) s>=2 GoodH",b22,80,2,GH);
  run("C1b: ETH/15m MFI>80 BB(20,2) s>=2 GoodH",b20,80,2,GH);
  run("C1c: ETH/15m MFI>80 BB(15,2.2) s>=2 GoodH",b15,80,2,GH);
  run("C1d: ETH/15m MFI>80 BB(20,2.2) s>=2 H+13",b22,80,2,GH2);
  run("C1e: ETH/15m MFI>80 BB(20,2.2) s>=3 GoodH",b22,80,3,GH);
  run("C1f: ETH/15m MFI>75 BB(20,2.2) s>=2 GoodH",b22,75,2,GH);
})();
console.log("C3");
(function(){
  var c=gc("ETH","5m");
  var hi=c.map(function(x){return x.high;}),lo=c.map(function(x){return x.low;});
  var cl=c.map(function(x){return x.close;}),ti=c.map(function(x){return x.open_time;});
  function run(lbl,rl,bm){
    var bnd=bb(cl,20,bm);
    var sigs=[];
    for(var i=rl+20;i<c.length-1;i++){
      var hr=new Date(ti[i]).getUTCHours();
      if(!GH.has(hr))continue;
      if(!bnd[i])continue;
      var rh=-Infinity,rl2=Infinity;
      for(var j=i-rl;j<i;j++){if(hi[j]>rh)rh=hi[j];if(lo[j]<rl2)rl2=lo[j];}
      if(cl[i]>rh&&cl[i]>=bnd[i].u)sigs.push({w:c[i+1].close<c[i+1].open});
      if(cl[i]<rl2&&cl[i]<=bnd[i].l)sigs.push({w:c[i+1].close>c[i+1].open});
    }
    rep(lbl,sigs);
  }
  run("C3a: ETH/5m Range(36)+BB(20,2.5) GoodH",36,2.5);
  run("C3b: ETH/5m Range(48)+BB(20,2.5) GoodH",48,2.5);
  run("C3c: ETH/5m Range(60)+BB(20,2.5) GoodH",60,2.5);
  run("C3d: ETH/5m Range(48)+BB(20,2.2) GoodH",48,2.2);
})();
console.log("C4");
(function(){
  var c=gc("ETH","5m");
  var op=c.map(function(x){return x.open;}),cl=c.map(function(x){return x.close;});
  var ti=c.map(function(x){return x.open_time;});
  function run(lbl,days){
    var dS=new Set(days);
    var bnd=bb(cl,20,2.2);
    var sigs=[];
    for(var i=22;i<c.length-1;i++){
      var dt=new Date(ti[i]);
      if(!dS.has(dt.getUTCDay()))continue;
      if(!GH.has(dt.getUTCHours()))continue;
      if(!bnd[i])continue;
      var t=sk(op,cl,i);if(t.s<2)continue;
      if(t.d===1&&cl[i]>=bnd[i].u)sigs.push({w:c[i+1].close<c[i+1].open});
      else if(t.d===-1&&cl[i]<=bnd[i].l)sigs.push({w:c[i+1].close>c[i+1].open});
    }
    rep(lbl,sigs);
  }
  run("C4a: ETH/5m Wed+Sat GoodH s>=2",[3,6]);
  run("C4b: ETH/5m Wed+Thu GoodH s>=2",[3,4]);
  run("C4c: ETH/5m Sun+Wed+Sat GoodH s>=2",[0,3,6]);
  run("C4d: ETH/5m Tue+Wed+Sat GoodH s>=2",[2,3,6]);
})();
console.log("C5");
(function(){
  var c=gc("ETH","5m");
  var op=c.map(function(x){return x.open;}),cl=c.map(function(x){return x.close;});
  var ti=c.map(function(x){return x.open_time;});
  function run(lbl,es,bm){
    var bnd=bb(cl,20,bm);
    var sigs=[];
    for(var i=25;i<c.length-1;i++){
      var hr=new Date(ti[i]).getUTCHours();
      if(!GH.has(hr))continue;
      if(!bnd[i])continue;
      var t=sk(op,cl,i);if(t.s!==es)continue;
      if(t.d===1&&cl[i]>=bnd[i].u)sigs.push({w:c[i+1].close<c[i+1].open});
      else if(t.d===-1&&cl[i]<=bnd[i].l)sigs.push({w:c[i+1].close>c[i+1].open});
    }
    rep(lbl,sigs);
  }
  run("C5a: ETH/5m s=4 BB(20,2.5) GoodH",4,2.5);
  run("C5b: ETH/5m s=4 BB(20,2.2) GoodH",4,2.2);
  run("C5c: ETH/5m s=4 BB(20,2) GoodH",4,2.0);
})();