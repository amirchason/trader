/**
 * BTC New Strategy Search — Session 4 continuation
 * Searches for new BTC-specific strategies on 5m and 15m
 * Using same approach that found strong ETH/SOL signals
 */

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

// ─── Utilities ──────────────────────────────────────────────────────────────

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
      time: g[0].time,
      open: g[0].open, high: Math.max(...g.map(c => c.high)),
      low: Math.min(...g.map(c => c.low)), close: g[2].close,
      volume: g.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

function wfValidate(results, nFolds = 3) {
  const n = results.length;
  const foldSize = Math.floor(n / (nFolds + 1));
  const folds = [];
  for (let f = 0; f < nFolds; f++) {
    const test = results.slice((f + 1) * foldSize, (f + 2) * foldSize);
    if (test.length === 0) continue;
    folds.push(test.filter(r => r.win).length / test.length * 100);
  }
  if (folds.length === 0) return null;
  const mean = folds.reduce((a, b) => a + b, 0) / folds.length;
  const sigma = Math.sqrt(folds.reduce((a, b) => a + (b - mean) ** 2, 0) / folds.length);
  return { mean, sigma, folds: folds.map(x => x.toFixed(1)), T: results.length };
}

function printResult(label, results, minWR = 62, minT = 30) {
  if (results.length < minT) return;
  const wr = results.filter(r => r.win).length / results.length * 100;
  if (wr < minWR) return;
  const wf = wfValidate(results, 3);
  if (!wf) return;
  const status = wf.mean > 65 && wf.sigma < 12 ? '*** VALIDATED' :
                 wf.mean > 62 ? '** PROMISING' : '* MARGINAL';
  console.log(`  ${label.padEnd(60)} WR=${wr.toFixed(1)}% WF=${wf.mean.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${results.length} [${wf.folds.join('/')}] ${status}`);
}

// ─── BTC/5m Strategies ──────────────────────────────────────────────────────

const btc5m = loadCandles('BTC', '5m');
const btc15mReal = loadCandles('BTC', '15m');
const btc15mSynth = synth15m(btc5m);
const totalDays = btc5m.length > 0
  ? (btc5m[btc5m.length-1].time - btc5m[0].time) / 86400000
  : 180;

console.log('═'.repeat(70));
console.log('BTC NEW STRATEGY SEARCH — 5m + 15m');
console.log(`Dataset: ${btc5m.length} BTC/5m candles, ${totalDays.toFixed(0)} days`);
console.log('═'.repeat(70));

// ─── Test A: BTC Good Hours (what hours work for BTC?) ─────────────────────
console.log('\n──── A: BTC Hour Sweep (finding BTC good hours) ────');

// Sweep all 24 hours
const hourResults = {};
for (let h = 0; h < 24; h++) hourResults[h] = [];

for (let i = 35; i < btc5m.length - 3; i++) {
  const c = btc5m[i];
  const hist = btc5m.slice(0, i + 1);
  const closes = hist.map(x => x.close);

  const b22 = bb(hist, 20, 2.2);
  if (!b22) continue;

  const hour = new Date(c.time).getUTCHours();
  const isBear = c.close > b22.upper && c.close > c.open;
  const isBull = c.close < b22.lower && c.close < c.open;

  if (!isBear && !isBull) continue;

  // Streak
  let streak = 0;
  for (let k = i; k >= 1; k--) {
    const cur = btc5m[k];
    if (cur.close > cur.open && streak >= 0) streak++;
    else if (cur.close < cur.open && streak <= 0) streak--;
    else break;
  }
  if (Math.abs(streak) < 2) continue;

  const future = btc5m[i + 3]?.close;
  if (!future) continue;
  const win = (isBear && future < c.close) || (isBull && future > c.close);
  hourResults[hour].push({ win });
}

const btcGoodHours = [];
for (let h = 0; h < 24; h++) {
  const r = hourResults[h];
  if (r.length < 15) continue;
  const wr = r.filter(x => x.win).length / r.length * 100;
  if (wr >= 60) {
    btcGoodHours.push(h);
    console.log(`  h=${h}: WR=${wr.toFixed(1)}% T=${r.length}`);
  }
}
console.log(`  BTC Good Hours (>=60% WR): [${btcGoodHours.join(', ')}]`);

// ─── Test B: DoW Effect on BTC (which days work?) ───────────────────────────
console.log('\n──── B: BTC Day-of-Week Effect ────');

const btcDowHours = [10, 11, 12, 13, 21, 22]; // use broad hours for BTC initially
const dowResults = {};
for (let d = 0; d < 7; d++) dowResults[d] = [];

for (let i = 35; i < btc5m.length - 3; i++) {
  const c = btc5m[i];
  const hist = btc5m.slice(0, i + 1);
  const hour = new Date(c.time).getUTCHours();
  if (!btcDowHours.includes(hour)) continue;

  const b22 = bb(hist, 20, 2.2);
  if (!b22) continue;

  const dow = new Date(c.time).getUTCDay();
  const isBear = c.close > b22.upper && c.close > c.open;
  const isBull = c.close < b22.lower && c.close < c.open;
  if (!isBear && !isBull) continue;

  let streak = 0;
  for (let k = i; k >= 1; k--) {
    if (btc5m[k].close > btc5m[k].open && streak >= 0) streak++;
    else if (btc5m[k].close < btc5m[k].open && streak <= 0) streak--;
    else break;
  }
  if (Math.abs(streak) < 2) continue;

  const future = btc5m[i + 3]?.close;
  if (!future) continue;
  const win = (isBear && future < c.close) || (isBull && future > c.close);
  dowResults[dow].push({ win });
}

const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const btcGoodDows = [];
for (let d = 0; d < 7; d++) {
  const r = dowResults[d];
  if (r.length < 15) continue;
  const wr = r.filter(x => x.win).length / r.length * 100;
  const label = wr >= 65 ? ' ←GOOD' : '';
  if (wr >= 60) btcGoodDows.push(d);
  console.log(`  ${dowNames[d]}: WR=${wr.toFixed(1)}% T=${r.length}${label}`);
}

// ─── Test C: BTC/15m strategies (real 15m data) ─────────────────────────────
console.log('\n──── C: BTC/15m New Strategies ────');

// Strategy ideas for BTC/15m:
// 1. GoodH + BB(20,2.2) + streak>=2 (like ETH Strat 15 but for BTC)
// 2. DoW + BB
// 3. RSI exhaustion on 15m
// 4. EMA50 distance on 15m

const btc15m = btc15mReal;
console.log(`  BTC/15m: ${btc15m.length} candles`);

// Known BTC good hours from previous research: similar to ETH h=[10,11,12,21]
const btcGoodH15 = [10, 11, 12, 21];

// C1: BTC/15m GoodH + BB(20,2.2) + streak>=2
{
  const results = [];
  for (let i = 25; i < btc15m.length - 1; i++) {
    const c = btc15m[i];
    const hist = btc15m.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (!btcGoodH15.includes(hour)) continue;

    const b = bb(hist, 20, 2.2);
    if (!b) continue;

    const isBear = c.close > b.upper && c.close > c.open;
    const isBull = c.close < b.lower && c.close < c.open;
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (btc15m[k].close > btc15m[k].open && streak >= 0) streak++;
      else if (btc15m[k].close < btc15m[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 2) continue;

    const future = btc15m[i + 1]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult('BTC/15m: GoodH[10,11,12,21]+BB(20,2.2)+streak>=2', results);
}

// C2: BTC/15m GoodH + BB(20,2.0) + streak>=2 (the original Strat 12 params)
{
  const results = [];
  for (let i = 25; i < btc15m.length - 1; i++) {
    const c = btc15m[i];
    const hist = btc15m.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (!btcGoodH15.includes(hour)) continue;

    const b = bb(hist, 20, 2.0);
    if (!b) continue;

    const isBear = c.close > b.upper && c.close > c.open;
    const isBull = c.close < b.lower && c.close < c.open;
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (btc15m[k].close > btc15m[k].open && streak >= 0) streak++;
      else if (btc15m[k].close < btc15m[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 2) continue;

    const future = btc15m[i + 1]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult('BTC/15m: GoodH[10,11,12,21]+BB(20,2.0)+streak>=2', results);
}

// C3: BTC/15m MFI>70 + GoodH + BB + streak (variant of strat 12)
{
  const results = [];
  for (let i = 25; i < btc15m.length - 1; i++) {
    const c = btc15m[i];
    const hist = btc15m.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (!btcGoodH15.includes(hour)) continue;

    const b = bb(hist, 20, 2.2);
    const mfiVal = mfi(hist, 10);
    if (!b || mfiVal === null) continue;

    const isBear = c.close > b.upper && c.close > c.open && mfiVal > 70;
    const isBull = c.close < b.lower && c.close < c.open && mfiVal < 30;
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (btc15m[k].close > btc15m[k].open && streak >= 0) streak++;
      else if (btc15m[k].close < btc15m[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 1) continue;

    const future = btc15m[i + 1]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult('BTC/15m: GoodH+BB(20,2.2)+MFI>70+streak>=1', results);
}

// C4: BTC/15m DoW effect
{
  for (const days of [[3,6], [3], [2,3,4], [3,4,5], [5,6]]) {
    const results = [];
    for (let i = 25; i < btc15m.length - 1; i++) {
      const c = btc15m[i];
      const hist = btc15m.slice(0, i + 1);
      const dow = new Date(c.time).getUTCDay();
      if (!days.includes(dow)) continue;

      const b = bb(hist, 20, 2.2);
      if (!b) continue;

      const isBear = c.close > b.upper && c.close > c.open;
      const isBull = c.close < b.lower && c.close < c.open;
      if (!isBear && !isBull) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (btc15m[k].close > btc15m[k].open && streak >= 0) streak++;
        else if (btc15m[k].close < btc15m[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < 1) continue;

      const future = btc15m[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`BTC/15m: DoW[${days.map(d=>dowNames[d]).join('+')}]+BB(20,2.2)+streak>=1`, results);
  }
}

// C5: BTC/15m EMA50 extension
{
  for (const dist of [0.3, 0.5, 0.8]) {
    const results = [];
    for (let i = 55; i < btc15m.length - 1; i++) {
      const c = btc15m[i];
      const hist = btc15m.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!btcGoodH15.includes(hour)) continue;

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
        if (btc15m[k].close > btc15m[k].open && streak >= 0) streak++;
        else if (btc15m[k].close < btc15m[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < 1) continue;

      const future = btc15m[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`BTC/15m: GoodH+BB(20,2.2)+EMA50dist>=${dist}%+streak>=1`, results);
  }
}

// C6: BTC/15m RSI panic (like ETH strat 18)
{
  for (const rsiThresh of [65, 70, 75]) {
    for (const bodyThresh of [0.2, 0.3]) {
      const results = [];
      for (let i = 25; i < btc15m.length - 1; i++) {
        const c = btc15m[i];
        const hist = btc15m.slice(0, i + 1);
        const hour = new Date(c.time).getUTCHours();
        if (!btcGoodH15.includes(hour)) continue;

        const b = bb(hist, 20, 2.2);
        const rsiVal = rsi(hist, 14);
        if (!b || rsiVal === null) continue;

        const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open * 100 : 0;
        if (bodyPct < bodyThresh) continue;

        const isBear = c.close > b.upper && c.close > c.open && rsiVal > rsiThresh;
        const isBull = c.close < b.lower && c.close < c.open && rsiVal < (100 - rsiThresh);
        if (!isBear && !isBull) continue;

        const future = btc15m[i + 1]?.close;
        if (!future) continue;
        const win = (isBear && future < c.close) || (isBull && future > c.close);
        results.push({ win });
      }
      printResult(`BTC/15m: GoodH+BB(20,2.2)+RSI>${rsiThresh}+body>=${bodyThresh}%`, results);
    }
  }
}

// ─── Test D: ETH Thursday Deep Dive ──────────────────────────────────────────
console.log('\n──── D: ETH Thursday MFI Deep Dive (ML-discovered 75.6% WF!) ────');

const eth5m = loadCandles('ETH', '5m');

// Thursday effect on ETH/5m with various filters
{
  for (const bbMult of [2.0, 2.2, 2.5]) {
    for (const mfiThresh of [65, 70, 75, 80]) {
      const results = [];
      for (let i = 25; i < eth5m.length - 3; i++) {
        const c = eth5m[i];
        const hist = eth5m.slice(0, i + 1);
        const dow = new Date(c.time).getUTCDay();
        if (dow !== 4) continue; // Thursday only

        const b = bb(hist, 20, bbMult);
        const mfiVal = mfi(hist, 10);
        if (!b || mfiVal === null) continue;

        const isBear = c.close > b.upper && c.close > c.open && mfiVal > mfiThresh;
        const isBull = c.close < b.lower && c.close < c.open && mfiVal < (100 - mfiThresh);
        if (!isBear && !isBull) continue;

        const future = eth5m[i + 3]?.close;
        if (!future) continue;
        const win = (isBear && future < c.close) || (isBull && future > c.close);
        results.push({ win });
      }
      printResult(`ETH/5m: Thu+BB(20,${bbMult})+MFI>${mfiThresh}`, results, 60, 25);
    }
  }
}

// Thursday + GoodH combo
{
  const goodH = [10, 11, 12, 21];
  for (const mfiThresh of [65, 70, 75]) {
    const results = [];
    for (let i = 25; i < eth5m.length - 3; i++) {
      const c = eth5m[i];
      const hist = eth5m.slice(0, i + 1);
      const dow = new Date(c.time).getUTCDay();
      const hour = new Date(c.time).getUTCHours();
      if (dow !== 4 || !goodH.includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      const mfiVal = mfi(hist, 10);
      if (!b || mfiVal === null) continue;

      const isBear = c.close > b.upper && c.close > c.open && mfiVal > mfiThresh;
      const isBull = c.close < b.lower && c.close < c.open && mfiVal < (100 - mfiThresh);
      if (!isBear && !isBull) continue;

      const future = eth5m[i + 3]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`ETH/5m: Thu+GoodH+BB(20,2.2)+MFI>${mfiThresh}`, results, 60, 15);
  }
}

// ETH Thursday hour sweep
console.log('\n  ETH Thursday hour-by-hour:');
for (let h = 0; h < 24; h++) {
  const results = [];
  for (let i = 25; i < eth5m.length - 3; i++) {
    const c = eth5m[i];
    const hist = eth5m.slice(0, i + 1);
    if (new Date(c.time).getUTCDay() !== 4) continue;
    if (new Date(c.time).getUTCHours() !== h) continue;

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
    if (Math.abs(streak) < 1) continue;

    const future = eth5m[i + 3]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  if (results.length >= 10) {
    const wr = results.filter(r => r.win).length / results.length * 100;
    const marker = wr >= 68 ? ' *** BEST' : wr >= 62 ? ' *' : '';
    console.log(`    Thu h=${h}: WR=${wr.toFixed(1)}% T=${results.length}${marker}`);
  }
}

// ─── Test E: BTC/5m Synth15m ────────────────────────────────────────────────
console.log('\n──── E: BTC Synth-15m Strategies ────');

const btcSynth = synth15m(btc5m);
console.log(`  BTC synth-15m: ${btcSynth.length} candles`);

// E1: BTC/synth15m GoodH + BB(20,2.2) + streak>=2 (like SOL strat 19)
{
  for (const goodH of [[10,11,12,21], [10,12,21], [11,12]]) {
    const results = [];
    for (let i = 25; i < btcSynth.length - 1; i++) {
      const c = btcSynth[i];
      const hist = btcSynth.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!goodH.includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      if (!b) continue;

      const isBear = c.close > b.upper && c.close > c.open;
      const isBull = c.close < b.lower && c.close < c.open;
      if (!isBear && !isBull) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (btcSynth[k].close > btcSynth[k].open && streak >= 0) streak++;
        else if (btcSynth[k].close < btcSynth[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < 2) continue;

      const future = btcSynth[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`BTC synth-15m: h=[${goodH.join(',')}]+BB(20,2.2)+streak>=2`, results);
  }
}

// E2: BTC/synth15m DoW effect
{
  for (const days of [[3,6], [3], [2,3,4], [3,4]]) {
    const results = [];
    for (let i = 25; i < btcSynth.length - 1; i++) {
      const c = btcSynth[i];
      const hist = btcSynth.slice(0, i + 1);
      const dow = new Date(c.time).getUTCDay();
      if (!days.includes(dow)) continue;

      const b = bb(hist, 20, 2.2);
      if (!b) continue;

      const isBear = c.close > b.upper && c.close > c.open;
      const isBull = c.close < b.lower && c.close < c.open;
      if (!isBear && !isBull) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (btcSynth[k].close > btcSynth[k].open && streak >= 0) streak++;
        else if (btcSynth[k].close < btcSynth[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < 1) continue;

      const future = btcSynth[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`BTC synth-15m: DoW[${days.map(d=>dowNames[d]).join('+')}]+BB(20,2.2)+streak>=1`, results);
  }
}

// E3: BTC/synth15m RSI panic
{
  for (const rsiT of [65, 70]) {
    for (const bodyT of [0.2, 0.3]) {
      const results = [];
      for (let i = 25; i < btcSynth.length - 1; i++) {
        const c = btcSynth[i];
        const hist = btcSynth.slice(0, i + 1);
        const hour = new Date(c.time).getUTCHours();
        if (![10,11,12,21].includes(hour)) continue;

        const b = bb(hist, 20, 2.2);
        const rsiVal = rsi(hist, 14);
        if (!b || rsiVal === null) continue;

        const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open * 100 : 0;
        if (bodyPct < bodyT) continue;

        const isBear = c.close > b.upper && c.close > c.open && rsiVal > rsiT;
        const isBull = c.close < b.lower && c.close < c.open && rsiVal < (100 - rsiT);
        if (!isBear && !isBull) continue;

        const future = btcSynth[i + 1]?.close;
        if (!future) continue;
        const win = (isBear && future < c.close) || (isBull && future > c.close);
        results.push({ win });
      }
      printResult(`BTC synth-15m: GoodH+BB(20,2.2)+RSI>${rsiT}+body>=${bodyT}%`, results);
    }
  }
}

// E4: BTC/synth15m MFI
{
  for (const mfiT of [70, 75, 80]) {
    const results = [];
    for (let i = 15; i < btcSynth.length - 1; i++) {
      const c = btcSynth[i];
      const hist = btcSynth.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (![10,11,12,21].includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      const mfiVal = mfi(hist, 10);
      if (!b || mfiVal === null) continue;

      const isBear = c.close > b.upper && c.close > c.open && mfiVal > mfiT;
      const isBull = c.close < b.lower && c.close < c.open && mfiVal < (100 - mfiT);
      if (!isBear && !isBull) continue;

      let streak = 0;
      for (let k = i; k >= 1; k--) {
        if (btcSynth[k].close > btcSynth[k].open && streak >= 0) streak++;
        else if (btcSynth[k].close < btcSynth[k].open && streak <= 0) streak--;
        else break;
      }
      if (Math.abs(streak) < 1) continue;

      const future = btcSynth[i + 1]?.close;
      if (!future) continue;
      const win = (isBear && future < c.close) || (isBull && future > c.close);
      results.push({ win });
    }
    printResult(`BTC synth-15m: GoodH+BB(20,2.2)+MFI>${mfiT}+streak>=1`, results);
  }
}

// E5: BTC Tight BB Dev filter (0.05-0.25% outside)
{
  const results = [];
  for (let i = 25; i < btcSynth.length - 1; i++) {
    const c = btcSynth[i];
    const hist = btcSynth.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (![10,11,12,21].includes(hour)) continue;

    const b = bb(hist, 20, 2.2);
    if (!b) continue;

    const devPct = c.close > b.upper
      ? (c.close - b.upper) / c.close * 100
      : c.close < b.lower
      ? (b.lower - c.close) / c.close * 100
      : 0;

    if (devPct < 0.05 || devPct > 0.25) continue;

    const isBear = c.close > b.upper && c.close > c.open;
    const isBull = c.close < b.lower && c.close < c.open;
    if (!isBear && !isBull) continue;

    let streak = 0;
    for (let k = i; k >= 1; k--) {
      if (btcSynth[k].close > btcSynth[k].open && streak >= 0) streak++;
      else if (btcSynth[k].close < btcSynth[k].open && streak <= 0) streak--;
      else break;
    }
    if (Math.abs(streak) < 2) continue;

    const future = btcSynth[i + 1]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult('BTC synth-15m: GoodH+tightBBdev(0.05-0.25%)+streak>=2', results);
}

// ─── Test F: ETH additional combos from ML insights ─────────────────────────
console.log('\n──── F: ETH Additional ML-Inspired Combos ────');

// F1: ETH tightBBDev (σ=3.1% SUPER STABLE from ML)
{
  for (const goodH of [[10,11,12,21], [10,12,21]]) {
    const results = [];
    for (let i = 25; i < eth5m.length - 3; i++) {
      const c = eth5m[i];
      const hist = eth5m.slice(0, i + 1);
      const hour = new Date(c.time).getUTCHours();
      if (!goodH.includes(hour)) continue;

      const b = bb(hist, 20, 2.2);
      if (!b) continue;

      const devPct = c.close > b.upper
        ? (c.close - b.upper) / c.close * 100
        : c.close < b.lower
        ? (b.lower - c.close) / c.close * 100
        : 0;
      if (devPct < 0.05 || devPct > 0.25) continue;

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
    printResult(`ETH/5m: h=[${goodH.join(',')}]+tightBBdev(0.05-0.25%)+streak>=2`, results);
  }
}

// F2: ETH MFI + RSI combined (fresh combo)
{
  for (const mfiT of [70, 75]) {
    for (const rsiT of [60, 65]) {
      const goodH = [10, 11, 12, 21];
      const results = [];
      for (let i = 25; i < eth5m.length - 3; i++) {
        const c = eth5m[i];
        const hist = eth5m.slice(0, i + 1);
        const hour = new Date(c.time).getUTCHours();
        if (!goodH.includes(hour)) continue;

        const b = bb(hist, 20, 2.2);
        const mfiVal = mfi(hist, 10);
        const rsiVal = rsi(hist, 14);
        if (!b || mfiVal === null || rsiVal === null) continue;

        const isBear = c.close > b.upper && c.close > c.open && mfiVal > mfiT && rsiVal > rsiT;
        const isBull = c.close < b.lower && c.close < c.open && mfiVal < (100-mfiT) && rsiVal < (100-rsiT);
        if (!isBear && !isBull) continue;

        let streak = 0;
        for (let k = i; k >= 1; k--) {
          if (eth5m[k].close > eth5m[k].open && streak >= 0) streak++;
          else if (eth5m[k].close < eth5m[k].open && streak <= 0) streak--;
          else break;
        }
        if (Math.abs(streak) < 1) continue;

        const future = eth5m[i + 3]?.close;
        if (!future) continue;
        const win = (isBear && future < c.close) || (isBull && future > c.close);
        results.push({ win });
      }
      printResult(`ETH/5m: GoodH+BB(20,2.2)+MFI>${mfiT}+RSI>${rsiT}+streak>=1`, results, 62, 30);
    }
  }
}

// F3: ETH hour expansion (try more hours with RSI filter)
{
  const expandedH = [10, 11, 12, 13, 20, 21, 22, 23]; // expanded from [10,11,12,21]
  const results = [];
  for (let i = 25; i < eth5m.length - 3; i++) {
    const c = eth5m[i];
    const hist = eth5m.slice(0, i + 1);
    const hour = new Date(c.time).getUTCHours();
    if (!expandedH.includes(hour)) continue;

    const b = bb(hist, 20, 2.2);
    const rsiVal = rsi(hist, 14);
    if (!b || rsiVal === null) continue;

    const isBear = c.close > b.upper && c.close > c.open && rsiVal > 65;
    const isBull = c.close < b.lower && c.close < c.open && rsiVal < 35;
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
  printResult(`ETH/5m: h=[10-13,20-23]+BB(20,2.2)+RSI>65+streak>=2`, results);
}

// F4: ETH all hours + very strong RSI filter (>75)
{
  const results = [];
  for (let i = 25; i < eth5m.length - 3; i++) {
    const c = eth5m[i];
    const hist = eth5m.slice(0, i + 1);
    const b = bb(hist, 20, 2.2);
    const rsiVal = rsi(hist, 14);
    if (!b || rsiVal === null) continue;

    const bodyPct = c.open > 0 ? Math.abs(c.close - c.open) / c.open * 100 : 0;
    const isBear = c.close > b.upper && c.close > c.open && rsiVal > 75 && bodyPct >= 0.2;
    const isBull = c.close < b.lower && c.close < c.open && rsiVal < 25 && bodyPct >= 0.2;
    if (!isBear && !isBull) continue;

    const future = eth5m[i + 3]?.close;
    if (!future) continue;
    const win = (isBear && future < c.close) || (isBull && future > c.close);
    results.push({ win });
  }
  printResult('ETH/5m: ALL hours+BB(20,2.2)+RSI>75+body>=0.2%', results, 60, 30);
}

console.log('\nDone.');
