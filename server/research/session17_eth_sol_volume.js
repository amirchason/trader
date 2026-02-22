/**
 * Session 17: Boost ETH/SOL volume while keeping WR >75%
 *
 * Key findings so far:
 *   - ETH best: 75.0% at tpd=0.6 (strat105: BB18+RSI3>90+MFI70+GH 4h)
 *   - SOL best: 80.0% at tpd=0.1 (strat95: TightGH+ADX20+RSI7>76+MFI75+BB22)
 *   - BTC champion: 85.7% at tpd=0.03 (strat97)
 *   - XRP champion: 80.0% at tpd=0.2 (strat108/110)
 *
 * Session 16 confirmed:
 *   - session16 G3 (StochRSI+BB22): BTC=80.0% n=44, XRP=80.0% n=37
 *   - session16 G4 (StochRSI+BB18): BTC=81.8% n=60
 *
 * This session targets:
 *   A. ETH extended good hours — add hour 13 to [10,11,12,21]
 *   B. ETH relaxed RSI3 (>85 not >90) — more volume
 *   C. SOL relaxed RSI3 (>85) at standard hours
 *   D. SOL extended hours (add 1 to [0,12,13,20])
 *   E. BTC/XRP new hour discovery — per-hour WR scan
 *   F. ETH new hour discovery — per-hour WR scan
 *   G. RSI7>73+MFI72+RSI14 at extended hours (strat106 pattern with more hours)
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

// ─── Indicator helpers ─────────────────────────────────────────────────────────
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

// ─── 5-fold walk-forward validation ──────────────────────────────────────────
function walkForward(candles, fn, folds = 5) {
  const n = candles.length;
  const foldSize = Math.floor(n / folds);
  const results = [];
  for (let f = 0; f < folds; f++) {
    const start = f * foldSize;
    const end = (f === folds - 1) ? n - 1 : (f + 1) * foldSize;
    const fc = candles.slice(start, end);
    if (fc.length < 200) continue;
    const closes = fc.map(c => c.close);
    const sma20 = smaSeries(closes, 20);
    const std20 = stdSeries(closes, sma20, 20);
    const bb = {
      u22: sma20.map((s, i) => s + 2.2 * std20[i]),
      l22: sma20.map((s, i) => s - 2.2 * std20[i]),
      u20: sma20.map((s, i) => s + 2.0 * std20[i]),
      l20: sma20.map((s, i) => s - 2.0 * std20[i]),
      u18: sma20.map((s, i) => s + 1.8 * std20[i]),
      l18: sma20.map((s, i) => s - 1.8 * std20[i]),
    };
    const rsi3 = rsiSeries(closes, 3);
    const rsi7 = rsiSeries(closes, 7);
    const rsi14 = rsiSeries(closes, 14);
    const mfi14 = mfiSeries(fc, 14);
    const adx14 = adxSeries(fc, 14);
    const s = { closes, sma20, bb, rsi3, rsi7, rsi14, mfi14, adx14 };
    let wins = 0, total = 0;
    for (let i = 50; i < fc.length - 1; i++) {
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
  const mid = results[Math.floor(results.length / 2)];
  const totalN = results.reduce((s, r) => s + r.n, 0);
  return { wr: mid.wr, n: totalN, folds: results.length };
}

const COINS = {
  ETH: { symbol: 'ETH', gh: new Set([10,11,12,21]) },
  BTC: { symbol: 'BTC', gh: new Set([1,12,13,16,20]) },
  SOL: { symbol: 'SOL', gh: new Set([0,12,13,20]) },
  XRP: { symbol: 'XRP', gh: new Set([6,9,12,18]) },
};

const allCandlesCache = {};
function getCandles(sym) {
  if (!allCandlesCache[sym]) allCandlesCache[sym] = loadCandles(sym);
  return allCandlesCache[sym];
}

function test(name, fn, coinNames = ['ETH', 'BTC', 'SOL', 'XRP']) {
  const result = { name, coins: {} };
  for (const coin of coinNames) {
    const cfg = COINS[coin];
    if (!cfg) continue;
    const candles = getCandles(cfg.symbol);
    if (candles.length < 500) { result.coins[coin] = null; continue; }
    const r = walkForward(candles, (c, i, s) => fn(c, i, s, cfg.gh));
    const days = candles.length / 288;
    result.coins[coin] = { wr: r.wr, n: r.n, tpd: r.n / days };
  }
  return result;
}

const results = [];

// ─── PRE-CACHE all candles ────────────────────────────────────────────────────
console.log('Loading candle data...');
for (const cfg of Object.values(COINS)) getCandles(cfg.symbol);
console.log('Done. Running tests...\n');

// ── SECTION A: ETH/BTC extended good hours ────────────────────────────────────
console.log('── SECTION A: Extended Hours ──');

// A1: ETH add hour 13 → [10,11,12,13,21]
const ETH_EXT = new Set([10,11,12,13,21]);
results.push(test('A1_EthExt_h13+ADX20+RSI3>90+MFI70+BB22', (c,i,s) => {
  if (!ETH_EXT.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['ETH']));

results.push(test('A2_EthExt_h13+ADX20+RSI3>90+MFI70+BB18', (c,i,s) => {
  if (!ETH_EXT.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}, ['ETH']));

results.push(test('A3_EthExt_h13+ADX20+RSI7>73+MFI72+RSI14+BB22', (c,i,s) => {
  if (!ETH_EXT.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.mfi14[i]>72 && s.rsi14[i]>68 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.mfi14[i]<28 && s.rsi14[i]<32 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['ETH']));

// A4: BTC add hour 11 → [1,11,12,13,16,20]
const BTC_EXT = new Set([1,11,12,13,16,20]);
results.push(test('A4_BtcExt_h11+ADX20+RSI3>90+MFI70+BB22', (c,i,s) => {
  if (!BTC_EXT.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['BTC']));

results.push(test('A5_BtcExt_h11+ADX20+RSI7>73+MFI72+RSI14+BB22', (c,i,s) => {
  if (!BTC_EXT.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi7[i]>73 && s.mfi14[i]>72 && s.rsi14[i]>68 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi7[i]<27 && s.mfi14[i]<28 && s.rsi14[i]<32 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['BTC']));

// ── SECTION B: Relaxed RSI3 threshold (>85 instead of >90) ───────────────────
console.log('── SECTION B: Relaxed RSI3 Threshold ──');

results.push(test('B1_GH+ADX20+RSI3>85+MFI70+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>85 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<15 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['ETH', 'BTC', 'SOL', 'XRP']));

results.push(test('B2_GH+ADX20+RSI3>85+MFI70+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>85 && s.mfi14[i]>70 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<15 && s.mfi14[i]<30 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}, ['ETH', 'BTC', 'SOL', 'XRP']));

results.push(test('B3_GH+ADX20+RSI3>88+MFI70+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>88 && s.mfi14[i]>70 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<12 && s.mfi14[i]<30 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}, ['ETH', 'BTC', 'SOL', 'XRP']));

results.push(test('B4_GH+ADX20+RSI3>85+MFI68+RSI14>65+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>85 && s.mfi14[i]>68 && s.rsi14[i]>65 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<15 && s.mfi14[i]<32 && s.rsi14[i]<35 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['ETH', 'BTC', 'SOL', 'XRP']));

results.push(test('B5_GH+ADX20+RSI3>85+MFI68+RSI14>65+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>85 && s.mfi14[i]>68 && s.rsi14[i]>65 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<15 && s.mfi14[i]<32 && s.rsi14[i]<35 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}, ['ETH', 'BTC', 'SOL', 'XRP']));

// ── SECTION C: SOL extended hours ─────────────────────────────────────────────
console.log('── SECTION C: SOL Extended Hours ──');

const SOL_EXT1 = new Set([0, 1, 12, 13, 20]);  // add hour 1
const SOL_EXT2 = new Set([0, 12, 13, 20, 21]); // add hour 21

results.push(test('C1_SolExt1+ADX20+RSI3>90+MFI70+BB22', (c,i,s) => {
  if (!SOL_EXT1.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['SOL']));

results.push(test('C2_SolExt1+ADX20+RSI3>90+MFI70+BB18', (c,i,s) => {
  if (!SOL_EXT1.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}, ['SOL']));

results.push(test('C3_SolExt2+ADX20+RSI3>90+MFI70+BB22', (c,i,s) => {
  if (!SOL_EXT2.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['SOL']));

results.push(test('C4_Sol+ADX20+RSI3>85+MFI68+BB22', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>85 && s.mfi14[i]>68 && cl>s.bb.u22[i]) return 'BEAR';
  if (s.rsi3[i]<15 && s.mfi14[i]<32 && cl<s.bb.l22[i]) return 'BULL';
  return null;
}, ['SOL']));

results.push(test('C5_Sol+ADX20+RSI3>85+MFI68+BB18', (c,i,s,gh) => {
  if (!gh.has(getHour(c[i].t)) || s.adx14[i]>=20) return null;
  const cl=c[i].close;
  if (s.rsi3[i]>85 && s.mfi14[i]>68 && cl>s.bb.u18[i]) return 'BEAR';
  if (s.rsi3[i]<15 && s.mfi14[i]<32 && cl<s.bb.l18[i]) return 'BULL';
  return null;
}, ['SOL']));

// ── SECTION D: Per-hour WR discovery ─────────────────────────────────────────
console.log('── SECTION D: Hour Discovery ──');

for (const h of Array.from({length: 24}, (_, i) => i)) {
  results.push(test(`D_ETH_h${h}+ADX20+RSI3>90+MFI70+BB22`, (c,i,s) => {
    if (getHour(c[i].t) !== h || s.adx14[i]>=20) return null;
    const cl=c[i].close;
    if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
    if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
    return null;
  }, ['ETH']));
}
for (const h of Array.from({length: 24}, (_, i) => i)) {
  results.push(test(`D_BTC_h${h}+ADX20+RSI3>90+MFI70+BB22`, (c,i,s) => {
    if (getHour(c[i].t) !== h || s.adx14[i]>=20) return null;
    const cl=c[i].close;
    if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
    if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
    return null;
  }, ['BTC']));
}
for (const h of Array.from({length: 24}, (_, i) => i)) {
  results.push(test(`D_SOL_h${h}+ADX20+RSI3>90+MFI70+BB22`, (c,i,s) => {
    if (getHour(c[i].t) !== h || s.adx14[i]>=20) return null;
    const cl=c[i].close;
    if (s.rsi3[i]>90 && s.mfi14[i]>70 && cl>s.bb.u22[i]) return 'BEAR';
    if (s.rsi3[i]<10 && s.mfi14[i]<30 && cl<s.bb.l22[i]) return 'BULL';
    return null;
  }, ['SOL']));
}

// ─── Print results ─────────────────────────────────────────────────────────────
console.log('\n=======================================================');
console.log('=== HOUR DISCOVERY: New good hours (WR>=70%) ===');
console.log('=======================================================');
for (const r of results) {
  if (!r.name.startsWith('D_')) continue;
  for (const [coin, v] of Object.entries(r.coins)) {
    if (!v || v.n < 5 || v.wr < 0.70) continue;
    const isKnown = (coin === 'ETH' && [10,11,12,21].includes(+r.name.match(/h(\d+)/)[1]))
                 || (coin === 'BTC' && [1,12,13,16,20].includes(+r.name.match(/h(\d+)/)[1]))
                 || (coin === 'SOL' && [0,12,13,20].includes(+r.name.match(/h(\d+)/)[1]));
    const tag = isKnown ? '' : ' ← NEW!';
    const flag = v.wr >= 0.80 ? ' 🔥🔥🔥' : v.wr >= 0.75 ? ' 🔥🔥' : ' 🔥';
    console.log(`  ${r.name}: ${coin} WR=${(v.wr*100).toFixed(1)}% n=${v.n} tpd=${v.tpd.toFixed(2)}${flag}${tag}`);
  }
}

console.log('\n=======================================================');
console.log('=== WINNERS: WR>=75% ===');
console.log('=======================================================');
for (const r of results) {
  for (const [coin, v] of Object.entries(r.coins)) {
    if (!v || v.wr < 0.75 || v.n < 5) continue;
    const flag = v.wr >= 0.80 ? '🔥🔥🔥 >80%' : '🔥🔥 >75%';
    console.log(`  ${r.name} | ${coin}: WR=${(v.wr*100).toFixed(1)}% n=${v.n} tpd=${v.tpd.toFixed(2)} ${flag}`);
  }
}

console.log('\n=======================================================');
console.log('=== ALL RESULTS (WR>=70%, n>=5) ===');
console.log('=======================================================');
for (const r of results) {
  if (r.name.startsWith('D_')) continue; // show per-hour separately
  for (const [coin, v] of Object.entries(r.coins)) {
    if (!v || v.wr < 0.70 || v.n < 5) continue;
    const flag = v.wr >= 0.80 ? ' 🔥🔥🔥' : v.wr >= 0.75 ? ' 🔥🔥' : '';
    console.log(`  ${r.name} | ${coin}: WR=${(v.wr*100).toFixed(1)}% n=${v.n} tpd=${v.tpd.toFixed(2)}${flag}`);
  }
}
