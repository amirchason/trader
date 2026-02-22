/**
 * Parameter Optimization for New Strategies (21-30)
 * Fine-tune BB params, RSI thresholds, body filters, hour sets
 * for strategies found in Session 4
 */

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(symbol, tf) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol=? AND timeframe=? ORDER BY open_time ASC`
  ).all(symbol, tf).map(r => ({
    time: r.open_time, open: +r.open, high: +r.high, low: +r.low,
    close: +r.close, volume: +r.volume,
  }));
}

function bb(candles, period, mult) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map(c => c.close);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, mid: mean, std };
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const changes = candles.slice(1).map((c, i) => c.close - candles[i].close);
  let g = 0, l = 0;
  for (let i = 0; i < period; i++) { if (changes[i] > 0) g += changes[i]; else l -= changes[i]; }
  g /= period; l /= period;
  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) { g = (g * (period - 1) + changes[i]) / period; l = l * (period - 1) / period; }
    else { g = g * (period - 1) / period; l = (l * (period - 1) - changes[i]) / period; }
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function ema(candles, period) {
  if (candles.length < period) return null;
  const k = 2 / (period + 1);
  let e = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) e = candles[i].close * k + e * (1 - k);
  return e;
}

function mfi(candles, period = 10) {
  if (candles.length < period + 1) return null;
  let pos = 0, neg = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const ptp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const mfr = tp * candles[i].volume;
    if (tp >= ptp) pos += mfr; else neg += mfr;
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
}

function synth15m(candles5m) {
  const out = [];
  const aligned = candles5m.length - (candles5m.length % 3);
  for (let i = 0; i < aligned; i += 3) {
    const g = candles5m.slice(i, i + 3);
    out.push({
      time: g[0].time, open: g[0].open,
      high: Math.max(...g.map(c => c.high)), low: Math.min(...g.map(c => c.low)),
      close: g[2].close, volume: g.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

function wfValidate(results, nFolds = 5) {
  const n = results.length;
  const foldSize = Math.floor(n / (nFolds + 1));
  const folds = [];
  for (let f = 0; f < nFolds; f++) {
    const test = results.slice((f + 1) * foldSize, (f + 2) * foldSize);
    if (test.length < 5) continue;
    folds.push(test.filter(r => r.win).length / test.length * 100);
  }
  if (folds.length < 2) return null;
  const mean = folds.reduce((a, b) => a + b, 0) / folds.length;
  const sigma = Math.sqrt(folds.reduce((a, b) => a + (b - mean) ** 2, 0) / folds.length);
  return { mean, sigma, folds: folds.map(x => x.toFixed(1)), T: results.length };
}

function printResult(label, results, minWR = 63, minT = 40) {
  if (results.length < minT) return;
  const wr = results.filter(r => r.win).length / results.length * 100;
  if (wr < minWR) return;
  const wf = wfValidate(results, 5);
  if (!wf || wf.folds.length < 3) return;
  const status = wf.mean > 66 && wf.sigma < 10 ? '*** VALIDATED' :
                 wf.mean > 63 ? '** PROMISING' : '* MARGINAL';
  const days = 184;
  console.log(`  ${label.padEnd(65)} WF=${wf.mean.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${results.length}(${(results.length/days).toFixed(1)}/d) [${wf.folds.join('/')}] ${status}`);
}

const eth5m = loadCandles('ETH', '5m');
const sol5m = loadCandles('SOL', '5m');
const solSynth = synth15m(sol5m);
const days = 184;

console.log('═'.repeat(70));
console.log('PARAMETER OPTIMIZATION — New Strategies 21-30');
console.log('═'.repeat(70));

// ─── Optimize Strategy 21 (DoW Reversion) ─────────────────────────────────
console.log('\n──── Strat 21 DoW Reversion: Hour + DoW Combos ────');

// Test different DoW combos
const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const goodH = [10, 11, 12, 21];

for (const daySet of [[3,6],[3],[6],[3,4],[3,4,6],[2,3,6],[4,6]]) {
  const results = [];
  for (let i = 25; i < eth5m.length - 3; i++) {
    const c = eth5m[i];
    const hist = eth5m.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    const dow = new Date(c.time).getUTCDay();
    if (!goodH.includes(hour) || !daySet.includes(dow)) continue;

    const b = bb(hist, 20, 2.2);
    if (!b) continue;

    const isBear = c.close > b.upper && c.close > c.open;
    const isBull = c.close < b.lower && c.close < c.open;
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (eth5m[k].close > eth5m[k].open && streak >= 0) streak++;
      else if (eth5m[k].close < eth5m[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 2) continue;

    const future = eth5m[i + 3]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult(`ETH DoW[${daySet.map(d=>dowNames[d]).join('+')}]+GH+BB(20,2.2)+str>=2`, results, 63, 30);
}

// ─── Optimize Strategy 22 (EMA50 Extension) ───────────────────────────────
console.log('\n──── Strat 22 EMA50 Extension: Distance Thresholds ────');

for (const dist of [0.3, 0.4, 0.5, 0.6, 0.8, 1.0]) {
  for (const strReq of [1, 2]) {
    const results = [];
    for (let i = 55; i < eth5m.length - 3; i++) {
      const c = eth5m[i];
      const hist = eth5m.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!goodH.includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      const e50 = ema(hist, 50);
      if (!b || !e50) continue;

      const emaDist = Math.abs(c.close - e50) / e50 * 100;
      if (emaDist < dist) continue;

      const isBear = c.close > b.upper && c.close > c.open;
      const isBull = c.close < b.lower && c.close < c.open;
      if (!isBear && !isBull) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (eth5m[k].close > eth5m[k].open && streak >= 0) streak++;
        else if (eth5m[k].close < eth5m[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < strReq) continue;

      const future = eth5m[i + 3]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`ETH EMA50>=${dist}%+GH+BB(20,2.2)+str>=${strReq}`, results);
  }
}

// ─── Optimize Strategy 25 (RSI Bear Streak) ─────────────────────────────
console.log('\n──── Strat 25 RSI Bear Streak: RSI thresh + streak ────');

for (const rsiT of [60, 62, 65, 67, 70]) {
  for (const strReq of [1, 2, 3]) {
    const results = [];
    for (let i = 25; i < eth5m.length - 3; i++) {
      const c = eth5m[i];
      const hist = eth5m.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!goodH.includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      const rsiVal = rsi(hist, 14);
      if (!b || rsiVal === null) continue;
      if (c.close <= b.upper) continue; // bear only: must be above upper BB
      if (c.close <= c.open) continue;  // must be green
      if (rsiVal <= rsiT) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (eth5m[k].close > eth5m[k].open) streak++;
        else break;
      }
      if (streak < strReq) continue;

      const future = eth5m[i + 3]?.close;
      if (!future) continue;
      const win = future < c.close; // bear: price falls
      results.push({ win });
    }
    printResult(`ETH RSI>${rsiT}+aboveBB22+greenStreak>=${strReq}+GH`, results);
  }
}

// ─── Optimize Strategy 26 (SOL DoW Reversion) ──────────────────────────
console.log('\n──── Strat 26 SOL DoW: DoW Combos ────');

const solGoodH = [0, 12, 13, 20];
for (const daySet of [[2,3,4],[3,4],[3,6],[2,3,6],[3],[2,3,4,5]]) {
  const results = [];
  for (let i = 25; i < solSynth.length - 1; i++) {
    const c = solSynth[i];
    const hist = solSynth.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    const dow = new Date(c.time).getUTCDay();
    if (!solGoodH.includes(hour) || !daySet.includes(dow)) continue;

    const b = bb(hist, 20, 2.2);
    if (!b) continue;

    const isBear = c.close > b.upper && c.close > c.open;
    const isBull = c.close < b.lower && c.close < c.open;
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (solSynth[k].close > solSynth[k].open && streak >= 0) streak++;
      else if (solSynth[k].close < solSynth[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 1) continue;

    const future = solSynth[i + 1]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult(`SOL synth-15m DoW[${daySet.map(d=>dowNames[d]).join('+')}]+GH+BB(20,2.2)+str>=1`, results, 63, 25);
}

// ─── Optimize Strategy 28 (SOL Tight BB) ────────────────────────────────
console.log('\n──── Strat 28 SOL Tight BB: BB Params ────');

for (const [period, mult] of [[15,2.0],[15,2.2],[20,2.0],[20,2.2],[10,2.2],[12,2.2]]) {
  for (const strReq of [1, 2, 3]) {
    const results = [];
    for (let i = period + 2; i < solSynth.length - 1; i++) {
      const c = solSynth[i];
      const hist = solSynth.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!solGoodH.includes(hour)) continue;

      const b = bb(hist, period, mult);
      if (!b) continue;

      const isBear = c.close > b.upper && c.close > c.open;
      const isBull = c.close < b.lower && c.close < c.open;
      if (!isBear && !isBull) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (solSynth[k].close > solSynth[k].open && streak >= 0) streak++;
        else if (solSynth[k].close < solSynth[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < strReq) continue;

      const future = solSynth[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`SOL synth-15m GH+BB(${period},${mult})+str>=${strReq}`, results, 63, 30);
  }
}

// ─── Optimize Strategy 30 (SOL EMA Extension) ───────────────────────────
console.log('\n──── Strat 30 SOL EMA Extension: Distance Sweep ────');

for (const dist of [0.2, 0.3, 0.4, 0.5]) {
  for (const strReq of [1, 2]) {
    const results = [];
    for (let i = 55; i < solSynth.length - 1; i++) {
      const c = solSynth[i];
      const hist = solSynth.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!solGoodH.includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      const e50 = ema(hist, 50);
      if (!b || !e50) continue;

      const emaDist = Math.abs(c.close - e50) / e50 * 100;
      if (emaDist < dist) continue;

      const isBear = c.close > b.upper && c.close > c.open;
      const isBull = c.close < b.lower && c.close < c.open;
      if (!isBear && !isBull) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (solSynth[k].close > solSynth[k].open && streak >= 0) streak++;
        else if (solSynth[k].close < solSynth[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < strReq) continue;

      const future = solSynth[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`SOL EMA50>=${dist}%+GH+BB(20,2.2)+str>=${strReq}`, results, 63, 25);
  }
}

// ─── New Search: SOL MFI + RSI combos (unexplored for SOL) ─────────────
console.log('\n──── NEW: SOL MFI + RSI Exhaustion Combos ────');

for (const mfiT of [65, 70, 75]) {
  const results = [];
  for (let i = 15; i < solSynth.length - 1; i++) {
    const c = solSynth[i];
    const hist = solSynth.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (!solGoodH.includes(hour)) continue;

    const b = bb(hist, 20, 2.2);
    const mfiVal = mfi(hist, 10);
    if (!b || mfiVal === null) continue;

    const isBear = c.close > b.upper && c.close > c.open && mfiVal > mfiT;
    const isBull = c.close < b.lower && c.close < c.open && mfiVal < (100 - mfiT);
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (solSynth[k].close > solSynth[k].open && streak >= 0) streak++;
      else if (solSynth[k].close < solSynth[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 1) continue;

    const future = solSynth[i + 1]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult(`SOL synth-15m: GH+BB(20,2.2)+MFI>${mfiT}+streak>=1`, results, 63, 25);
}

// SOL RSI exhaustion
for (const rsiT of [60, 65, 70]) {
  const results = [];
  for (let i = 25; i < solSynth.length - 1; i++) {
    const c = solSynth[i];
    const hist = solSynth.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (!solGoodH.includes(hour)) continue;

    const b = bb(hist, 20, 2.2);
    const rsiVal = rsi(hist, 14);
    if (!b || rsiVal === null) continue;

    const isBear = c.close > b.upper && c.close > c.open && rsiVal > rsiT;
    const isBull = c.close < b.lower && c.close < c.open && rsiVal < (100 - rsiT);
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (solSynth[k].close > solSynth[k].open && streak >= 0) streak++;
      else if (solSynth[k].close < solSynth[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 2) continue;

    const future = solSynth[i + 1]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult(`SOL synth-15m: GH+BB(20,2.2)+RSI>${rsiT}+streak>=2`, results, 63, 25);
}

// ─── New: ETH RSI+MFI dual filter (fresh combo) ─────────────────────────
console.log('\n──── NEW: ETH 5m Synth-15m RSI Panic (applying ETH strat 18 approach to 15m) ────');

const ethSynth = synth15m(eth5m);
for (const rsiT of [65, 68, 70, 72]) {
  for (const bodyT of [0.2, 0.3]) {
    const results = [];
    for (let i = 25; i < ethSynth.length - 1; i++) {
      const c = ethSynth[i];
      const hist = ethSynth.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!goodH.includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      const rsiVal = rsi(hist, 14);
      if (!b || rsiVal === null) continue;

      const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open * 100 : 0;
      if (bodyPct < bodyT) continue;

      const isBear = c.close > b.upper && c.close > c.open && rsiVal > rsiT;
      const isBull = c.close < b.lower && c.close < c.open && rsiVal < (100 - rsiT);
      if (!isBear && !isBull) continue;

      const future = ethSynth[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`ETH synth-15m: GH+BB(20,2.2)+RSI>${rsiT}+body>=${bodyT}%`, results, 63, 30);
  }
}

// ─── New: ETH 5m high-frequency (all GoodH hours, lower filters) ─────────
console.log('\n──── NEW: ETH 5m High-Frequency (relaxed filters for >2/day) ────');

for (const [bbMult, strReq] of [[2.0,1],[2.0,2],[1.8,2],[2.2,1]]) {
  const results = [];
  for (let i = 25; i < eth5m.length - 3; i++) {
    const c = eth5m[i];
    const hist = eth5m.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (!goodH.includes(hour)) continue;

    const b = bb(hist, 20, bbMult);
    if (!b) continue;

    const isBear = c.close > b.upper && c.close > c.open;
    const isBull = c.close < b.lower && c.close < c.open;
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (eth5m[k].close > eth5m[k].open && streak >= 0) streak++;
      else if (eth5m[k].close < eth5m[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < strReq) continue;

    const future = eth5m[i + 3]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult(`ETH/5m: GH+BB(20,${bbMult})+streak>=${strReq} [high-freq]`, results, 60, 50);
}

console.log('\nDone.');
