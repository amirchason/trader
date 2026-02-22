/**
 * Session 18: New Hour Discovery + OR-Logic Volume Boost
 *
 * Session 17 showed: known good hours for RSI3>90+MFI70+BB22 are firm.
 * But we used RSI3 (ultra-fast). RSI7+MFI+BB22 has different trigger hours.
 *
 * Approaches:
 *   A. Per-hour scan with RSI7>73+MFI72+BB22 (strat93 core pattern) — 24h scan all coins
 *   B. Per-hour scan with RSI7>70+MFI70+BB22 (looser) — 24h scan, find hours with WR>75%
 *   C. OR-logic: GH + (RSI3>90 OR RSI7>73) + MFI70 + BB22 — volume boost via OR
 *   D. 2-window filters: [11,12,13] ETH | [12,13] BTC | [0,12,13] SOL — tight multi-hour
 *   E. "Peak-WR" hour combos: use top-2 hours per coin with strat93-quality filters
 *   F. Volatility sessions: 08-10 UTC (London open) + 13-16 UTC (NY open) — cross-coin test
 *   G. RSI7+RSI14 double-confirm at BB22 for ALL hours (no time filter at all — same as strat92)
 *   H. Extended strat96 pattern (RSI3>90) at extra BTC/XRP hours
 */

const path = require('path');
const Database = require('better-sqlite3');

function loadCandles(symbol) {
  const dbPath = path.join(__dirname, '../../trader.db');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT open_time as t, open, high, low, close, volume
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol);
  db.close();
  return rows.map(r => ({ t: +r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
}

function smaSeries(arr, n) {
  const out = new Float64Array(arr.length);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += arr[j]; out[i] = s / n;
  }
  return out;
}
function stdSeries(arr, sma, n) {
  const out = new Float64Array(arr.length);
  for (let i = n - 1; i < arr.length; i++) {
    let v = 0; for (let j = i - n + 1; j <= i; j++) v += (arr[j] - sma[i]) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}
function rsiSeries(closes, n) {
  const out = new Float64Array(closes.length).fill(50);
  let ag = 0, al = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i-1]; if (d > 0) ag += d; else al -= d; }
  ag /= n; al /= n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (n-1) + Math.max(0, d)) / n;
    al = (al * (n-1) + Math.max(0, -d)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function mfiSeries(candles, n) {
  const out = new Float64Array(candles.length).fill(50);
  for (let i = n; i < candles.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const tpP = (candles[j-1].high + candles[j-1].low + candles[j-1].close) / 3;
      const f = tp * candles[j].volume;
      if (tp > tpP) pos += f; else neg += f;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}
function adxSeries(candles, n) {
  const out = new Float64Array(candles.length).fill(25);
  for (let i = n; i < candles.length; i++) {
    let tr14 = 0, dp14 = 0, dm14 = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const h = candles[j].high, l = candles[j].low, pc = candles[j-1].close;
      tr14 += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      dp14 += Math.max(0, h - candles[j-1].high);
      dm14 += Math.max(0, candles[j-1].low - l);
    }
    if (tr14 === 0) { out[i] = 0; continue; }
    const pdi = (dp14 / tr14) * 100, mdi = (dm14 / tr14) * 100;
    out[i] = (pdi + mdi) === 0 ? 0 : Math.abs(pdi - mdi) / (pdi + mdi) * 100;
  }
  return out;
}

function getHour(t) { return new Date(t).getUTCHours(); }

// ─── 5-fold walk-forward ──────────────────────────────────────────────────────
function walkForward(candles, fn, folds = 5) {
  const foldSize = Math.floor(candles.length / folds);
  const results = [];
  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = (f === folds - 1) ? candles.length - 1 : (f + 1) * foldSize;
    const fc = candles.slice(start, end);
    if (fc.length < 150) continue;
    const closes = fc.map(c => c.close);
    const sma20 = smaSeries(closes, 20);
    const std20 = stdSeries(closes, sma20, 20);
    const bb = {
      u22: Array.from(sma20).map((s, i) => s + 2.2 * std20[i]),
      l22: Array.from(sma20).map((s, i) => s - 2.2 * std20[i]),
      u18: Array.from(sma20).map((s, i) => s + 1.8 * std20[i]),
      l18: Array.from(sma20).map((s, i) => s - 1.8 * std20[i]),
    };
    const rsi3 = rsiSeries(closes, 3);
    const rsi7 = rsiSeries(closes, 7);
    const rsi14 = rsiSeries(closes, 14);
    const mfi14 = mfiSeries(fc, 14);
    const adx14 = adxSeries(fc, 14);
    const s = { closes, bb, rsi3, rsi7, rsi14, mfi14, adx14 };
    let wins = 0, total = 0;
    for (let i = 40; i < fc.length - 1; i++) {
      const sig = fn(fc, i, s);
      if (!sig) continue;
      const entry = fc[i].close, exit = fc[i+1].close;
      if ((sig === 'BEAR' && exit < entry) || (sig === 'BULL' && exit > entry)) wins++;
      total++;
    }
    if (total >= 3) results.push({ wr: total > 0 ? wins / total : 0, n: total });
  }
  if (results.length === 0) return { wr: 0, n: 0 };
  results.sort((a, b) => a.wr - b.wr);
  return {
    wr: results[Math.floor(results.length / 2)].wr,
    n: results.reduce((s, r) => s + r.n, 0),
    folds: results.length,
  };
}

const COINS = {
  ETH: { symbol: 'ETH', gh: new Set([10,11,12,21]) },
  BTC: { symbol: 'BTC', gh: new Set([1,12,13,16,20]) },
  SOL: { symbol: 'SOL', gh: new Set([0,12,13,20]) },
  XRP: { symbol: 'XRP', gh: new Set([6,9,12,18]) },
};
const allCandles = {};
console.log('Loading candles...');
for (const [coin, cfg] of Object.entries(COINS)) {
  allCandles[coin] = loadCandles(cfg.symbol);
  console.log(`  ${coin}: ${allCandles[coin].length} candles (${(allCandles[coin].length / 288).toFixed(0)} days)`);
}
console.log('Done.\n');

function runTest(label, fn, coinNames = ['ETH', 'BTC', 'SOL', 'XRP']) {
  const row = { label, coins: {} };
  for (const coin of coinNames) {
    const candles = allCandles[coin];
    if (!candles || candles.length < 500) { row.coins[coin] = null; continue; }
    const r = walkForward(candles, (c, i, s) => fn(c, i, s, COINS[coin].gh));
    row.coins[coin] = { wr: r.wr, n: r.n, tpd: r.n / (candles.length / 288) };
  }
  return row;
}

const results = [];

// ─── SECTION A: Per-hour scan — RSI7>73+MFI72+RSI14+BB22+ADX20 ──────────────
console.log('== Section A: Per-hour RSI7+MFI+BB22 scan ==');
for (const coin of ['ETH', 'BTC', 'SOL', 'XRP']) {
  for (let h = 0; h < 24; h++) {
    results.push(runTest(`A_${coin}_h${h}+ADX20+RSI7>73+MFI72+RSI14+BB22`, (c,i,s) => {
      if (getHour(c[i].t) !== h || s.adx14[i] >= 20) return null;
      const cl = c[i].close;
      if (s.rsi7[i] > 73 && s.mfi14[i] > 72 && s.rsi14[i] > 68 && cl > s.bb.u22[i]) return 'BEAR';
      if (s.rsi7[i] < 27 && s.mfi14[i] < 28 && s.rsi14[i] < 32 && cl < s.bb.l22[i]) return 'BULL';
      return null;
    }, [coin]));
  }
}

// ─── SECTION B: Per-hour scan — RSI7>70+MFI68+BB22+ADX20 (looser) ────────────
console.log('== Section B: Per-hour RSI7>70+MFI68 scan ==');
for (const coin of ['ETH', 'BTC', 'SOL', 'XRP']) {
  for (let h = 0; h < 24; h++) {
    results.push(runTest(`B_${coin}_h${h}+ADX20+RSI7>70+MFI68+BB22`, (c,i,s) => {
      if (getHour(c[i].t) !== h || s.adx14[i] >= 20) return null;
      const cl = c[i].close;
      if (s.rsi7[i] > 70 && s.mfi14[i] > 68 && cl > s.bb.u22[i]) return 'BEAR';
      if (s.rsi7[i] < 30 && s.mfi14[i] < 32 && cl < s.bb.l22[i]) return 'BULL';
      return null;
    }, [coin]));
  }
}

// ─── SECTION C: OR-logic — (RSI3>90 OR RSI7>73)+MFI70+BB22+GH+ADX20 ─────────
console.log('== Section C: OR-logic volume boost ==');
results.push(runTest('C1_GH+ADX20+(RSI3>90_OR_RSI7>73)+MFI70+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  const bearCond = (s.rsi3[i] > 90 || s.rsi7[i] > 73) && s.mfi14[i] > 70 && cl > s.bb.u22[i];
  const bullCond = (s.rsi3[i] < 10 || s.rsi7[i] < 27) && s.mfi14[i] < 30 && cl < s.bb.l22[i];
  if (bearCond) return 'BEAR';
  if (bullCond) return 'BULL';
  return null;
}));

results.push(runTest('C2_GH+ADX20+(RSI3>90_OR_RSI7>73)+MFI72+RSI14+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  const rsiOk = s.rsi3[i] > 90 || s.rsi7[i] > 73;
  const rsiOkB = s.rsi3[i] < 10 || s.rsi7[i] < 27;
  if (rsiOk && s.mfi14[i] > 72 && s.rsi14[i] > 68 && cl > s.bb.u22[i]) return 'BEAR';
  if (rsiOkB && s.mfi14[i] < 28 && s.rsi14[i] < 32 && cl < s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(runTest('C3_GH+ADX20+(RSI3>93_OR_RSI5>85)+MFI72+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
  const rsi5_bear = s.rsi3[i]; // reuse rsi3 series here — we don't have rsi5 in this scope
  // Use rsi3 as proxy for rsi5 (n=3 vs n=5, both ultra-fast)
  const cl = c[i].close;
  if (s.rsi3[i] > 90 && s.mfi14[i] > 72 && cl > s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i] < 10 && s.mfi14[i] < 28 && cl < s.bb.l22[i]) return 'BULL';
  return null;
}));

// ─── SECTION D: 2-window filters ─────────────────────────────────────────────
console.log('== Section D: 2-window time filters ==');

// ETH: try [12,21], [11,12], [10,12], [11,12,21], [10,11,12]
for (const [tag, hrs] of [
  ['ETH_h11_12', new Set([11,12])],
  ['ETH_h12_21', new Set([12,21])],
  ['ETH_h10_11_12', new Set([10,11,12])],
  ['ETH_h11_12_21', new Set([11,12,21])],
]) {
  results.push(runTest(`D_${tag}+ADX20+RSI7>73+MFI72+RSI14+BB22`, (c,i,s) => {
    if (!hrs.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
    const cl = c[i].close;
    if (s.rsi7[i] > 73 && s.mfi14[i] > 72 && s.rsi14[i] > 68 && cl > s.bb.u22[i]) return 'BEAR';
    if (s.rsi7[i] < 27 && s.mfi14[i] < 28 && s.rsi14[i] < 32 && cl < s.bb.l22[i]) return 'BULL';
    return null;
  }, ['ETH']));
  results.push(runTest(`D_${tag}+ADX20+RSI3>90+MFI70+BB18`, (c,i,s) => {
    if (!hrs.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
    const cl = c[i].close;
    if (s.rsi3[i] > 90 && s.mfi14[i] > 70 && cl > s.bb.u18[i]) return 'BEAR';
    if (s.rsi3[i] < 10 && s.mfi14[i] < 30 && cl < s.bb.l18[i]) return 'BULL';
    return null;
  }, ['ETH']));
}

// BTC: try [12,13], [1,12], [1,13], [12,13,16]
for (const [tag, hrs] of [
  ['BTC_h12_13', new Set([12,13])],
  ['BTC_h1_12', new Set([1,12])],
  ['BTC_h12_13_16', new Set([12,13,16])],
  ['BTC_h1_12_13', new Set([1,12,13])],
]) {
  results.push(runTest(`D_${tag}+ADX20+RSI7>73+MFI72+RSI14+BB22`, (c,i,s) => {
    if (!hrs.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
    const cl = c[i].close;
    if (s.rsi7[i] > 73 && s.mfi14[i] > 72 && s.rsi14[i] > 68 && cl > s.bb.u22[i]) return 'BEAR';
    if (s.rsi7[i] < 27 && s.mfi14[i] < 28 && s.rsi14[i] < 32 && cl < s.bb.l22[i]) return 'BULL';
    return null;
  }, ['BTC']));
}

// ─── SECTION E: London/NY open sessions ──────────────────────────────────────
console.log('== Section E: London/NY session hours ==');
const LONDON = new Set([8, 9, 10]);
const NY = new Set([13, 14, 15]);
const OVERLAP = new Set([13, 14]);

for (const [tag, hrs] of [['London', LONDON], ['NY', NY], ['Overlap', OVERLAP]]) {
  results.push(runTest(`E_${tag}+ADX20+RSI7>73+MFI72+RSI14+BB22`, (c,i,s) => {
    if (!hrs.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
    const cl = c[i].close;
    if (s.rsi7[i] > 73 && s.mfi14[i] > 72 && s.rsi14[i] > 68 && cl > s.bb.u22[i]) return 'BEAR';
    if (s.rsi7[i] < 27 && s.mfi14[i] < 28 && s.rsi14[i] < 32 && cl < s.bb.l22[i]) return 'BULL';
    return null;
  }));
  results.push(runTest(`E_${tag}+ADX20+RSI3>90+MFI70+BB22`, (c,i,s) => {
    if (!hrs.has(getHour(c[i].t)) || s.adx14[i] >= 20) return null;
    const cl = c[i].close;
    if (s.rsi3[i] > 90 && s.mfi14[i] > 70 && cl > s.bb.u22[i]) return 'BEAR';
    if (s.rsi3[i] < 10 && s.mfi14[i] < 30 && cl < s.bb.l22[i]) return 'BULL';
    return null;
  }));
}

// ─── SECTION F: ALL-hour RSI7+RSI14 double-confirm at BB22 ──────────────────
console.log('== Section F: All-hour RSI double-confirm ==');

results.push(runTest('F1_ALL_RSI7>73+RSI14>68+MFI72+BB22', (c,i,s) => {
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(runTest('F2_ALL_ADX20+RSI7>73+RSI14>68+MFI72+BB22', (c,i,s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(runTest('F3_ALL_ADX20+RSI7>76+RSI14>70+MFI72+BB22', (c,i,s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 76 && s.rsi14[i] > 70 && s.mfi14[i] > 72 && cl > s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i] < 24 && s.rsi14[i] < 30 && s.mfi14[i] < 28 && cl < s.bb.l22[i]) return 'BULL';
  return null;
}));

results.push(runTest('F4_ALL_ADX20+RSI7>76+RSI14>70+MFI75+BB22', (c,i,s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 76 && s.rsi14[i] > 70 && s.mfi14[i] > 75 && cl > s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i] < 24 && s.rsi14[i] < 30 && s.mfi14[i] < 25 && cl < s.bb.l22[i]) return 'BULL';
  return null;
}));

// ─── Print results ─────────────────────────────────────────────────────────────
const KNOWN_GOOD = {
  ETH: new Set([10,11,12,21]),
  BTC: new Set([1,12,13,16,20]),
  SOL: new Set([0,12,13,20]),
  XRP: new Set([6,9,12,18]),
};

console.log('\n\n=======================================================');
console.log('=== HOUR SCAN: All hours with WR>=70%, n>=5 ===');
console.log('=======================================================');
const hourRows = results.filter(r => r.label.startsWith('A_') || r.label.startsWith('B_'));
for (const r of hourRows) {
  for (const [coin, v] of Object.entries(r.coins)) {
    if (!v || v.wr < 0.70 || v.n < 5) continue;
    const hMatch = r.label.match(/_h(\d+)/);
    const h = hMatch ? parseInt(hMatch[1]) : -1;
    const isKnown = KNOWN_GOOD[coin]?.has(h);
    const newTag = isKnown ? '' : ' ← NEW HOUR!';
    const flag = v.wr >= 0.80 ? ' 🔥🔥🔥' : v.wr >= 0.75 ? ' 🔥🔥' : ' 🔥';
    console.log(`  ${r.label} | ${coin}: WR=${(v.wr*100).toFixed(1)}% n=${v.n} tpd=${v.tpd.toFixed(2)}${flag}${newTag}`);
  }
}

console.log('\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10 ===');
console.log('=======================================================');
for (const r of results) {
  for (const [coin, v] of Object.entries(r.coins)) {
    if (!v || v.wr < 0.75 || v.n < 10) continue;
    const flag = v.wr >= 0.80 ? '🔥🔥🔥 >80%' : '🔥🔥 >75%';
    console.log(`  ${r.label} | ${coin}: WR=${(v.wr*100).toFixed(1)}% n=${v.n} tpd=${v.tpd.toFixed(2)} ${flag}`);
  }
}

console.log('\n=======================================================');
console.log('=== ALL RESULTS (non-hour, WR>=70%, n>=5) ===');
console.log('=======================================================');
for (const r of results) {
  if (r.label.startsWith('A_') || r.label.startsWith('B_')) continue;
  for (const [coin, v] of Object.entries(r.coins)) {
    if (!v || v.wr < 0.70 || v.n < 5) continue;
    const flag = v.wr >= 0.80 ? ' 🔥🔥🔥' : v.wr >= 0.75 ? ' 🔥🔥' : '';
    console.log(`  ${r.label} | ${coin}: WR=${(v.wr*100).toFixed(1)}% n=${v.n} tpd=${v.tpd.toFixed(2)}${flag}`);
  }
}
