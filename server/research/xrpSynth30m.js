// XRP synthetic 30m / 60m candles from 15m data
// Also validates the best strategy with larger dataset
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}

function buildSynth(candles15m, groupSize) {
  const synth = [];
  for (let i = 0; i + groupSize - 1 < candles15m.length; i += groupSize) {
    const group = candles15m.slice(i, i + groupSize);
    if (group.length < groupSize) break;
    synth.push({
      open_time: group[0].open_time,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return synth;
}

function calcBB(candles, end, period, mult) {
  if (end < period - 1) return null;
  const sl = candles.slice(end - period + 1, end + 1).map(x => x.close);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, mid: mean };
}

function gd(c) { return c.close >= c.open ? 'G' : 'R'; }

function streakLen(candles, i) {
  const d = gd(candles[i]); let n = 1;
  for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
    if (gd(candles[j]) === d) n++; else break;
  }
  return n;
}

function wf3(ca, hrs, bbP, bbM, minStr) {
  if (ca.length < 200) return null;
  const folds = 3, fsz = Math.floor(ca.length / folds);
  const si = Math.max(bbP + 10, 30);
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

function pr(nm, w) {
  if (!w) { console.log(`  ${nm}: no data`); return; }
  const fs = w.folds.map(v => (v*100).toFixed(1)).join('/');
  const flag = w.wr >= 0.65 && w.sigma <= 0.08 && w.total >= 30 ? ' *** VALIDATED' :
               w.wr >= 0.62 && w.sigma <= 0.10 && w.total >= 20 ? ' ** PROMISING' :
               w.wr >= 0.58 && w.total >= 15 ? ' * MARGINAL' : ' (weak)';
  console.log(`  ${nm.padEnd(65)} WR=${(w.wr*100).toFixed(1)}%  sig=${(w.sigma*100).toFixed(1)}%  T=${w.total}  [${fs}]${flag}`);
}

const ca15m = loadCandles('XRP', '15m');
const ca30m = buildSynth(ca15m, 2); // 2 × 15m = 30m
const ca60m = buildSynth(ca15m, 4); // 4 × 15m = 60m

console.log(`XRP/15m: ${ca15m.length} candles`);
console.log(`XRP/synth30m: ${ca30m.length} candles`);
console.log(`XRP/synth60m: ${ca60m.length} candles`);

const GH15m = [6, 9, 12, 18]; // good hours for 15m
const GH30m = [6, 12];        // 30m candles start at even hours (0,2,4,...) → 6,12 correspond
const GH60m = [4, 8, 12, 20]; // 60m candles: 4h=h4-5, 12h, etc.

console.log('\n=== Synthetic 30m (2×15m) ===');
// All hours
pr('synth30m allH BB(20,2.0) str>=1', wf3(ca30m, null, 20, 2.0, 1));
pr('synth30m allH BB(20,2.2) str>=1', wf3(ca30m, null, 20, 2.2, 1));
pr('synth30m allH BB(25,2.2) str>=1', wf3(ca30m, null, 25, 2.2, 1));
pr('synth30m allH BB(15,2.0) str>=1', wf3(ca30m, null, 15, 2.0, 1));

// Hour filter
pr('synth30m h=[6,12] BB(20,2.0) str>=1', wf3(ca30m, [6,12], 20, 2.0, 1));
pr('synth30m h=[6,12] BB(25,2.2) str>=1', wf3(ca30m, [6,12], 25, 2.2, 1));
pr('synth30m h=[6,12] BB(25,2.2) str>=2', wf3(ca30m, [6,12], 25, 2.2, 2));
pr('synth30m h=[4,6,12,20] BB(25,2.2) str>=1', wf3(ca30m, [4,6,12,20], 25, 2.2, 1));
pr('synth30m h=[0,6,12,18] BB(25,2.2) str>=1', wf3(ca30m, [0,6,12,18], 25, 2.2, 1));
pr('synth30m h=[4,6,10,12,18] BB(25,2.2) str>=1', wf3(ca30m, [4,6,10,12,18], 25, 2.2, 1));

// Exhaustive hour search for 30m
console.log('\nBest single hours for 30m BB(25,2.2) str>=1:');
const h30Scores = [];
for (let h = 0; h < 24; h += 2) { // 30m candles start at even hours
  const r = wf3(ca30m, [h], 25, 2.2, 1);
  if (r && r.total >= 10) h30Scores.push({ h, ...r });
}
h30Scores.sort((a, b) => b.wr - a.wr);
h30Scores.slice(0, 8).forEach(x => {
  const fs = x.folds.map(v => (v*100).toFixed(0)).join('/');
  console.log(`  h=${x.h}: WR=${(x.wr*100).toFixed(1)}% T=${x.total} [${fs}]`);
});

console.log('\n=== Synthetic 60m (4×15m) ===');
pr('synth60m allH BB(20,2.0) str>=1', wf3(ca60m, null, 20, 2.0, 1));
pr('synth60m allH BB(20,2.2) str>=1', wf3(ca60m, null, 20, 2.2, 1));
pr('synth60m h=[4,12] BB(20,2.0) str>=1', wf3(ca60m, [4,12], 20, 2.0, 1));
pr('synth60m h=[4,12] BB(20,2.2) str>=1', wf3(ca60m, [4,12], 20, 2.2, 1));
pr('synth60m h=[4,8,12] BB(20,2.0) str>=1', wf3(ca60m, [4,8,12], 20, 2.0, 1));

// Best hours for 60m
console.log('\nBest single hours for 60m BB(20,2.0) str>=1:');
const h60Scores = [];
for (let h = 0; h < 24; h += 4) { // 60m candles start at 0,4,8,12,16,20
  const r = wf3(ca60m, [h], 20, 2.0, 1);
  if (r && r.total >= 5) h60Scores.push({ h, ...r });
}
h60Scores.sort((a, b) => b.wr - a.wr);
h60Scores.forEach(x => {
  const fs = x.folds.map(v => (v*100).toFixed(0)).join('/');
  console.log(`  h=${x.h}: WR=${(x.wr*100).toFixed(1)}% T=${x.total} [${fs}]`);
});

// The most stable result found so far: confirm it
console.log('\n=== Final validation of best 15m strategies ===');
pr('XRP/15m h=[6,9,12,18] BB(25,2.2) str>=1 [STABLE CHAMP]', wf3(ca15m, [6,9,12,18], 25, 2.2, 1));
pr('XRP/15m h=[6,12] BB(25,2.2) str>=1 [HIGH WR]', wf3(ca15m, [6,12], 25, 2.2, 1));
pr('XRP/15m h=[6,9,12,18] BB(15,2.2) str>=1 [ALT PARAMS]', wf3(ca15m, [6,9,12,18], 15, 2.2, 1));

console.log('\nDone.');
