// XRP exhaustive hour + BB parameter sweep
// Tests all 24 hours, multiple BB params, 5m and 15m
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}

function calcBB(candles, end, period, mult) {
  if (end < period - 1) return null;
  const sl = candles.slice(end - period + 1, end + 1).map(x => x.close);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, mid: mean, std };
}

function gd(c) { return c.close >= c.open ? 'G' : 'R'; }

function streakLen(candles, i) {
  const d = gd(candles[i]); let n = 1;
  for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
    if (gd(candles[j]) === d) n++; else break;
  }
  return n;
}

function wf3(sym, tf, hrs, bbP, bbM, minStr) {
  const ca = loadCandles(sym, tf);
  if (ca.length < 300) return null;
  const folds = 3, fsz = Math.floor(ca.length / folds);
  const si = Math.max(bbP + 20, 30);
  const frs = [];
  let tw = 0, tt = 0;
  for (let f = 0; f < folds; f++) {
    const fs2 = Math.max(f * fsz, si);
    const fe = (f === folds - 1) ? ca.length - 1 : (f + 1) * fsz - 1;
    const fc = ca.slice(0, fe + 1);
    const res = [];
    for (let i = fs2; i < fe; i++) {
      const x = fc[i];
      const h = new Date(x.open_time).getUTCHours();
      if (hrs !== null && hrs.indexOf(h) === -1) continue;
      const bb = calcBB(fc, i, bbP, bbM);
      if (!bb) continue;
      const isBear = x.close > bb.upper;
      const isBull = x.close < bb.lower;
      if (!isBear && !isBull) continue;
      if (minStr > 0) {
        const d = gd(x), st = streakLen(fc, i);
        if (isBear && (d !== 'G' || st < minStr)) continue;
        if (isBull && (d !== 'R' || st < minStr)) continue;
      }
      const nxt = fc[i + 1];
      if (!nxt) continue;
      res.push((isBear ? nxt.close < nxt.open : nxt.close > nxt.open) ? 1 : 0);
    }
    const fw = res.filter(v => v === 1).length;
    frs.push(res.length > 0 ? fw / res.length : 0);
    tw += fw; tt += res.length;
  }
  if (tt === 0) return null;
  const mn = frs.reduce((a, b) => a + b, 0) / folds;
  const sg = Math.sqrt(frs.reduce((s, w) => s + Math.pow(w - mn, 2), 0) / folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}

function flag(w) {
  if (w.wr >= 0.65 && w.sigma <= 0.08 && w.total >= 30) return ' *** VALIDATED';
  if (w.wr >= 0.62 && w.sigma <= 0.10 && w.total >= 20) return ' ** PROMISING';
  if (w.wr >= 0.58 && w.total >= 15) return ' * MARGINAL';
  return '';
}

const periods = [10, 15, 20, 25];
const mults = [1.2, 1.5, 1.8, 2.0, 2.2, 2.5];
const minStrs = [0, 1, 2];
const tfs = ['5m', '15m'];

// First: find best single-hour results
console.log('\n=== XRP: Single-hour sweep (BB(20,2.0), streak>=1) ===');
const hourWRs5m = [], hourWRs15m = [];
for (let h = 0; h < 24; h++) {
  const r5 = wf3('XRP', '5m', [h], 20, 2.0, 1);
  const r15 = wf3('XRP', '15m', [h], 20, 2.0, 1);
  if (r5 && r5.total >= 5) hourWRs5m.push({ h, ...r5 });
  if (r15 && r15.total >= 5) hourWRs15m.push({ h, ...r15 });
}
hourWRs5m.sort((a, b) => b.wr - a.wr);
hourWRs15m.sort((a, b) => b.wr - a.wr);

console.log('XRP/5m top hours:');
hourWRs5m.slice(0, 8).forEach(x => {
  const fl = flag(x);
  if (fl || x.wr >= 0.56) console.log(`  h=${x.h}: WR=${(x.wr*100).toFixed(1)}% T=${x.total} [${x.folds.map(v=>(v*100).toFixed(0)).join('/')}]${fl}`);
});
console.log('XRP/15m top hours:');
hourWRs15m.slice(0, 8).forEach(x => {
  const fl = flag(x);
  if (fl || x.wr >= 0.56) console.log(`  h=${x.h}: WR=${(x.wr*100).toFixed(1)}% T=${x.total} [${x.folds.map(v=>(v*100).toFixed(0)).join('/')}]${fl}`);
});

// Build top hour sets from best hours
const top5mHours = hourWRs5m.slice(0, 4).map(x => x.h);
const top15mHours = hourWRs15m.slice(0, 4).map(x => x.h);
console.log(`\nTop 5m hours: [${top5mHours.join(',')}]`);
console.log(`Top 15m hours: [${top15mHours.join(',')}]`);

// Grid search on BB params with best hours
console.log('\n=== XRP: BB parameter grid search with top hours ===');
const promising = [];
for (const tf of tfs) {
  const topHours = tf === '5m' ? top5mHours : top15mHours;
  const allHourSets = [
    null,               // all hours
    topHours,           // top 4
    topHours.slice(0, 2), // top 2
  ];
  for (const hrs of allHourSets) {
    for (const bbP of periods) {
      for (const bbM of mults) {
        for (const minStr of minStrs) {
          const r = wf3('XRP', tf, hrs, bbP, bbM, minStr);
          if (!r || r.total < 15) continue;
          if (r.wr >= 0.58) {
            const fl = flag(r);
            const hLabel = hrs === null ? 'allH' : `h=[${hrs.join(',')}]`;
            const label = `XRP/${tf} ${hLabel} BB(${bbP},${bbM}) str>=${minStr}`;
            promising.push({ label, ...r, fl });
          }
        }
      }
    }
  }
}
promising.sort((a, b) => b.wr - a.wr);
promising.slice(0, 30).forEach(x => {
  const fs = x.folds.map(v => (v*100).toFixed(1)).join('/');
  console.log(`  ${x.label.padEnd(55)} WR=${(x.wr*100).toFixed(1)}%  sig=${(x.sigma*100).toFixed(1)}%  T=${x.total}  [${fs}]${x.fl}`);
});

if (promising.length === 0) {
  console.log('  No combos above 58% WR with T>=15');
}

// Exhaustive: all 24 hours combined 2-by-2 for best BB params
console.log('\n=== XRP/15m: 2-hour combo sweep (BB(20,2.0), streak>=1) ===');
const best2h = [];
for (let h1 = 0; h1 < 24; h1++) {
  for (let h2 = h1 + 1; h2 < 24; h2++) {
    const r = wf3('XRP', '15m', [h1, h2], 20, 2.0, 1);
    if (r && r.total >= 20 && r.wr >= 0.60) {
      best2h.push({ hrs: [h1, h2], ...r });
    }
  }
}
best2h.sort((a, b) => b.wr - a.wr);
best2h.slice(0, 15).forEach(x => {
  const fs = x.folds.map(v => (v*100).toFixed(1)).join('/');
  const fl = flag(x);
  console.log(`  h=[${x.hrs.join(',')}] WR=${(x.wr*100).toFixed(1)}%  sig=${(x.sigma*100).toFixed(1)}%  T=${x.total}  [${fs}]${fl}`);
});
if (best2h.length === 0) console.log('  No 2-hour combos above 60% WR with T>=20');

// Same for 5m
console.log('\n=== XRP/5m: 2-hour combo sweep (BB(20,2.0), streak>=1) ===');
const best2h5m = [];
for (let h1 = 0; h1 < 24; h1++) {
  for (let h2 = h1 + 1; h2 < 24; h2++) {
    const r = wf3('XRP', '5m', [h1, h2], 20, 2.0, 1);
    if (r && r.total >= 20 && r.wr >= 0.60) {
      best2h5m.push({ hrs: [h1, h2], ...r });
    }
  }
}
best2h5m.sort((a, b) => b.wr - a.wr);
best2h5m.slice(0, 15).forEach(x => {
  const fs = x.folds.map(v => (v*100).toFixed(1)).join('/');
  const fl = flag(x);
  console.log(`  h=[${x.hrs.join(',')}] WR=${(x.wr*100).toFixed(1)}%  sig=${(x.sigma*100).toFixed(1)}%  T=${x.total}  [${fs}]${fl}`);
});
if (best2h5m.length === 0) console.log('  No 2-hour combos above 60% WR with T>=20');

console.log('\nDone.');
