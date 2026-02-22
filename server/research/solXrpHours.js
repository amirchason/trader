const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}
function calcBB(c, end, p, m) {
  p = p || 20; m = m || 2.0;
  if (end < p-1) return null;
  const sl = c.slice(end-p+1, end+1).map(x => x.close);
  const mean = sl.reduce((a, b) => a+b, 0)/p;
  const std = Math.sqrt(sl.reduce((s, v) => s+Math.pow(v-mean, 2), 0)/p);
  return { upper: mean+m*std, lower: mean-m*std };
}
function gd(c) { return c.close >= c.open ? 'G' : 'R'; }
function streak(c, i) {
  const d = gd(c[i]); let n = 1;
  for (let j = i-1; j >= Math.max(0, i-8); j--) { if (gd(c[j]) === d) n++; else break; }
  return n;
}
function wf3(sym, tf, hrs, bbP, bbM, minStr) {
  bbP = bbP || 20; bbM = bbM || 2.0; minStr = minStr !== undefined ? minStr : 2;
  const ca = loadCandles(sym, tf);
  if (ca.length < 300) return { wr: 0, sigma: 99, total: 0, folds: [] };
  const folds = 3, fsz = Math.floor(ca.length/folds), si = Math.max(bbP+14, 25), frs = [];
  let tw = 0, tt = 0;
  for (let f = 0; f < folds; f++) {
    const fs2 = Math.max(f*fsz, si), fe = (f === folds-1) ? ca.length-1 : (f+1)*fsz-1;
    const fc = ca.slice(0, fe+1), res = [];
    for (let i = fs2; i < fe; i++) {
      const x = fc[i], h = new Date(x.open_time).getUTCHours();
      if (hrs !== null && hrs.indexOf(h) === -1) continue;
      const bb = calcBB(fc, i, bbP, bbM); if (!bb) continue;
      const p = x.close, isBear = p > bb.upper, isBull = p < bb.lower;
      if (!isBear && !isBull) continue;
      if (minStr > 0) {
        const d = gd(x), st = streak(fc, i);
        if (isBear && (d !== 'G' || st < minStr)) continue;
        if (isBull && (d !== 'R' || st < minStr)) continue;
      }
      const nxt = fc[i+1]; if (!nxt) continue;
      res.push((isBear ? nxt.close < nxt.open : nxt.close > nxt.open) ? 1 : 0);
    }
    const fw = res.filter(v => v === 1).length;
    frs.push(res.length > 0 ? fw/res.length : 0); tw += fw; tt += res.length;
  }
  const mn = frs.reduce((a, b) => a+b, 0)/folds;
  const sg = Math.sqrt(frs.reduce((s, w) => s+Math.pow(w-mn, 2), 0)/folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}
function pr(nm, w) {
  const fs = w.folds.map(v => (v*100).toFixed(1)).join('/');
  const flag = w.wr >= 0.67 && w.sigma <= 0.07 && w.total >= 20 ? ' *** VALIDATED' :
               w.wr >= 0.63 && w.sigma <= 0.10 && w.total >= 12 ? ' ** PROMISING' :
               w.wr >= 0.58 && w.total >= 8 ? ' * MARGINAL' : ' (weak)';
  console.log('  ' + nm.padEnd(50) + ' WR=' + (w.wr*100).toFixed(1).padStart(5) + '%  sig=' + (w.sigma*100).toFixed(1).padStart(4) + '%  T=' + String(w.total).padStart(4) + '  [' + fs + ']' + flag);
}

console.log('SOL/15m combined hour sets:');
pr('SOL/15m h=[12]',                wf3('SOL','15m',[12]));
pr('SOL/15m h=[0,12]',              wf3('SOL','15m',[0,12]));
pr('SOL/15m h=[0,12,13,20]',        wf3('SOL','15m',[0,12,13,20]));
pr('SOL/15m h=[0,2,12,13,17,20]',   wf3('SOL','15m',[0,2,12,13,17,20]));
pr('SOL/15m h=null (all)',           wf3('SOL','15m',null));

console.log('XRP/15m combined hour sets:');
pr('XRP/15m h=[9]',                 wf3('XRP','15m',[9]));
pr('XRP/15m h=[9,12]',              wf3('XRP','15m',[9,12]));
pr('XRP/15m h=[9,12,21,22]',        wf3('XRP','15m',[9,12,21,22]));

const sol5 = db.prepare('SELECT count(*) as n, min(open_time) as mn, max(open_time) as mx FROM candles WHERE symbol=? AND timeframe=?').get('SOL','5m');
const eth5 = db.prepare('SELECT count(*) as n, min(open_time) as mn, max(open_time) as mx FROM candles WHERE symbol=? AND timeframe=?').get('ETH','5m');
console.log('SOL/5m: ' + sol5.n + ' candles ' + new Date(sol5.mn).toISOString().slice(0,10) + ' to ' + new Date(sol5.mx).toISOString().slice(0,10));
console.log('ETH/5m: ' + eth5.n + ' candles ' + new Date(eth5.mn).toISOString().slice(0,10) + ' to ' + new Date(eth5.mx).toISOString().slice(0,10));
