/**
 * Session 35: Pivot points, round numbers, previous-day high/low, overnight move
 *
 * Genuinely unexplored price-level based signals:
 * A. Daily pivot points — classic S1/P/R1 computed from yesterday's OHLC
 *    Price at R1 + RSI7>70 + BB22 = classic pivot resistance reversal
 * B. Round number proximity — price within 0.2% of a round number ($100, $50, etc)
 *    + BB22 + RSI7>70 = round number rejection
 * C. Previous day's high proximity — price near prev-day high + BB22
 *    (more precise than 24h rolling high from sess31)
 * D. Day open proximity — price far above today's UTC midnight open + BB22
 *    "Extended from open" = stretched mean-reversion context
 * E. Gap detection — today opened above prev-day high + now at BB extreme
 *    "Gap fill" is a classic pattern
 *
 * Exit model: CORRECT fixed-expiry binary (next candle close)
 * Minimum threshold: WR >= 75%, n >= 10, tpd >= 0.33
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

function getCandles(symbol) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol).map(r => ({
    t: r.open_time, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume
  }));
}

function calcBB(candles, idx, period = 20, mult = 2.2) {
  if (idx < period) return null;
  const closes = candles.slice(idx - period, idx).map(c => c.c);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
  return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
}

function calcRSI(candles, idx, period = 7) {
  if (idx < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = idx - period; i < idx; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function calcMFI(candles, idx, period = 14) {
  if (idx < period + 1) return 50;
  let pos = 0, neg = 0;
  for (let i = idx - period; i < idx; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i - 1].h + candles[i - 1].l + candles[i - 1].c) / 3;
    const mf = tp * candles[i].v;
    if (tp > prevTp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

// Get previous day OHLC (UTC midnight boundaries)
function getPrevDayOHLC(candles, idx) {
  const ts = candles[idx].t;
  const d = new Date(ts);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  const prevDayStart = todayStart - 86400000;

  let o = null, h = -Infinity, l = Infinity, c = null;
  for (let i = idx - 1; i >= 0; i--) {
    const ct = candles[i].t;
    if (ct < prevDayStart) break;
    if (ct >= todayStart) continue; // skip today's candles
    if (c === null) c = candles[i].c; // most recent = yesterday's last close
    if (o === null || ct <= prevDayStart + 300000) o = candles[i].o; // approximate yesterday's open
    h = Math.max(h, candles[i].h);
    l = Math.min(l, candles[i].l);
  }
  if (h === -Infinity || l === Infinity || o === null || c === null) return null;
  return { o, h, l, c };
}

// Classic pivot points: P = (H+L+C)/3, R1 = 2P-L, S1 = 2P-H
function calcPivots(prevDay) {
  const p = (prevDay.h + prevDay.l + prevDay.c) / 3;
  return {
    p,
    r1: 2 * p - prevDay.l,
    r2: p + (prevDay.h - prevDay.l),
    s1: 2 * p - prevDay.h,
    s2: p - (prevDay.h - prevDay.l),
  };
}

// Get today's open (first candle of UTC day)
function getTodayOpen(candles, idx) {
  const ts = candles[idx].t;
  const d = new Date(ts);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  for (let i = idx - 1; i >= 0; i--) {
    if (candles[i].t < todayStart) break;
    if (candles[i].t >= todayStart && (i === 0 || candles[i - 1].t < todayStart)) {
      return candles[i].o;
    }
  }
  // fallback: search forward from idx toward day start
  for (let i = idx; i >= 0; i--) {
    if (candles[i].t >= todayStart && (i === 0 || candles[i - 1].t < todayStart)) {
      return candles[i].o;
    }
  }
  return null;
}

// Round number detection — is price within pct% of a round number?
function nearRoundNumber(price, pct = 0.002) {
  // Round numbers: multiples of 100, 500, 1000 depending on price magnitude
  const magnitude = Math.pow(10, Math.floor(Math.log10(price)));
  const roundings = [magnitude / 10, magnitude / 2, magnitude, magnitude * 2];
  for (const step of roundings) {
    const nearest = Math.round(price / step) * step;
    if (Math.abs(price - nearest) / price <= pct) return true;
  }
  return false;
}

function walkForward(candles, signal_fn) {
  const FOLDS = 5;
  const foldSize = Math.floor(candles.length / FOLDS);
  let totalWins = 0, totalTrades = 0;
  const foldResults = [];
  for (let f = 0; f < FOLDS; f++) {
    const start = f * foldSize;
    const end = (f === FOLDS - 1) ? candles.length - 1 : (f + 1) * foldSize;
    let wins = 0, trades = 0;
    for (let i = start + 400; i < end - 1; i++) { // 400 bars warmup for prev-day calc
      if (signal_fn(candles, i)) {
        trades++;
        if (candles[i + 1].c < candles[i].c) wins++;
      }
    }
    foldResults.push({ wins, trades, wr: trades > 0 ? wins / trades : 0 });
    totalWins += wins; totalTrades += trades;
  }
  const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
  const totalDays = candles.length * 5 / 60 / 24;
  const tpd = totalTrades / totalDays;
  const mean = foldResults.reduce((s, f) => s + f.wr, 0) / FOLDS;
  const sigma = Math.sqrt(foldResults.reduce((s, f) => s + (f.wr - mean) ** 2, 0) / FOLDS);
  return { wr, n: totalTrades, tpd, sigma };
}

function fmt(label, coin, r) {
  const flag = r.wr >= 0.75 && r.n >= 10 && r.tpd >= 0.33 ? ' 🏆🏆🏆' :
    r.wr >= 0.70 && r.n >= 10 ? ' 🔥' : '';
  const warn = r.tpd < 0.33 ? ` ⚠️ tpd=${r.tpd.toFixed(2)}` : '';
  console.log(`  ${label} | ${coin}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd.toFixed(2)} σ=${(r.sigma * 100).toFixed(1)}%${flag}${warn}`);
  return r;
}

const GOOD_HOURS = {
  ETH: new Set([10, 11, 12, 21]),
  BTC: new Set([1, 9, 12, 13, 16, 20]),
  SOL: new Set([0, 12, 13, 20]),
  XRP: new Set([6, 9, 12, 18])
};

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const allCandles = {};
for (const coin of COINS) allCandles[coin] = getCandles(coin);

const winners = [];

// ═══════════════════════════════════════════════════════
// SECTION A: Pivot point R1/R2 + BB22
// Price at or above yesterday's R1 while above BB22
// ═══════════════════════════════════════════════════════
console.log('\n== Section A: Pivot point R1/R2 at BB extreme ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // A1: near R1 (within 0.3%) + BB22 + RSI7>68, all hours
  const a1 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    const pivots = calcPivots(prev);
    const distR1 = Math.abs(c[i].c - pivots.r1) / pivots.r1;
    return distR1 <= 0.003 && calcRSI(c, i, 7) > 68;
  });
  const r_a1 = fmt(`A1_${coin}_nearR1_RSI68_BB22`, coin, a1);
  if (r_a1.wr >= 0.75 && r_a1.n >= 10 && r_a1.tpd >= 0.33) winners.push({ label: `A1_${coin}`, ...r_a1 });

  // A2: above R1 (breakout failed) + BB22 + RSI7>68, all hours
  const a2 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    const pivots = calcPivots(prev);
    return c[i].c >= pivots.r1 * 0.999 && calcRSI(c, i, 7) > 68;
  });
  const r_a2 = fmt(`A2_${coin}_aboveR1_RSI68_BB22`, coin, a2);
  if (r_a2.wr >= 0.75 && r_a2.n >= 10 && r_a2.tpd >= 0.33) winners.push({ label: `A2_${coin}`, ...r_a2 });

  // A3: at R1 + GH + RSI7>70
  const a3 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.has(h)) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    const pivots = calcPivots(prev);
    const distR1 = Math.abs(c[i].c - pivots.r1) / pivots.r1;
    return distR1 <= 0.005 && calcRSI(c, i, 7) > 70;
  });
  const r_a3 = fmt(`A3_${coin}_nearR1_GH_RSI70_BB22`, coin, a3);
  if (r_a3.wr >= 0.75 && r_a3.n >= 10 && r_a3.tpd >= 0.33) winners.push({ label: `A3_${coin}`, ...r_a3 });

  // A4: near R2 (0.5%) + BB22 + RSI7>68
  const a4 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    const pivots = calcPivots(prev);
    const distR2 = Math.abs(c[i].c - pivots.r2) / pivots.r2;
    return distR2 <= 0.005 && calcRSI(c, i, 7) > 68;
  });
  const r_a4 = fmt(`A4_${coin}_nearR2_RSI68_BB22`, coin, a4);
  if (r_a4.wr >= 0.75 && r_a4.n >= 10 && r_a4.tpd >= 0.33) winners.push({ label: `A4_${coin}`, ...r_a4 });
}

// ═══════════════════════════════════════════════════════
// SECTION B: Round number proximity
// ═══════════════════════════════════════════════════════
console.log('\n== Section B: Round number proximity + BB22 ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // B1: near round number (0.2%) + above BB22 + RSI7>68, all hours
  const b1 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    return nearRoundNumber(c[i].c, 0.002) && calcRSI(c, i, 7) > 68;
  });
  const r_b1 = fmt(`B1_${coin}_RoundNum0.2_RSI68_BB22`, coin, b1);
  if (r_b1.wr >= 0.75 && r_b1.n >= 10 && r_b1.tpd >= 0.33) winners.push({ label: `B1_${coin}`, ...r_b1 });

  // B2: near round number + GH + RSI7>70
  const b2 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.has(h)) return false;
    return nearRoundNumber(c[i].c, 0.003) && calcRSI(c, i, 7) > 70;
  });
  const r_b2 = fmt(`B2_${coin}_RoundNum0.3_GH_RSI70_BB22`, coin, b2);
  if (r_b2.wr >= 0.75 && r_b2.n >= 10 && r_b2.tpd >= 0.33) winners.push({ label: `B2_${coin}`, ...r_b2 });

  // B3: near round number + MFI>68 + BB22 all hours
  const b3 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    return nearRoundNumber(c[i].c, 0.002) && calcMFI(c, i) > 68;
  });
  const r_b3 = fmt(`B3_${coin}_RoundNum_MFI68_BB22`, coin, b3);
  if (r_b3.wr >= 0.75 && r_b3.n >= 10 && r_b3.tpd >= 0.33) winners.push({ label: `B3_${coin}`, ...r_b3 });
}

// ═══════════════════════════════════════════════════════
// SECTION C: Previous day's high proximity
// More precise than 24h rolling: exact prev UTC day boundary
// ═══════════════════════════════════════════════════════
console.log('\n== Section C: Previous day high proximity + BB22 ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // C1: price within 0.2% of prev day high + BB22 + RSI7>68
  const c1 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    return Math.abs(c[i].c - prev.h) / prev.h <= 0.002 && calcRSI(c, i, 7) > 68;
  });
  const r_c1 = fmt(`C1_${coin}_prevDayH0.2_RSI68_BB22`, coin, c1);
  if (r_c1.wr >= 0.75 && r_c1.n >= 10 && r_c1.tpd >= 0.33) winners.push({ label: `C1_${coin}`, ...r_c1 });

  // C2: above prev day high (new day high) + BB22 + RSI7>70
  const c2 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    return c[i].c >= prev.h * 0.999 && calcRSI(c, i, 7) > 70;
  });
  const r_c2 = fmt(`C2_${coin}_abovePrevDayH_RSI70_BB22`, coin, c2);
  if (r_c2.wr >= 0.75 && r_c2.n >= 10 && r_c2.tpd >= 0.33) winners.push({ label: `C2_${coin}`, ...r_c2 });

  // C3: near prev day high + GH + MFI>65
  const c3 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.has(h)) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    return Math.abs(c[i].c - prev.h) / prev.h <= 0.003 && calcMFI(c, i) > 65;
  });
  const r_c3 = fmt(`C3_${coin}_prevDayH_GH_MFI65_BB22`, coin, c3);
  if (r_c3.wr >= 0.75 && r_c3.n >= 10 && r_c3.tpd >= 0.33) winners.push({ label: `C3_${coin}`, ...r_c3 });
}

// ═══════════════════════════════════════════════════════
// SECTION D: Day open deviation
// Price far above today's UTC midnight open + BB22
// ═══════════════════════════════════════════════════════
console.log('\n== Section D: Day open deviation + BB22 ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // D1: price > 0.5% above today's open + above BB22 + RSI7>68, all hours
  const d1 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const dayOpen = getTodayOpen(c, i);
    if (!dayOpen) return false;
    const dev = (c[i].c - dayOpen) / dayOpen * 100;
    return dev > 0.5 && calcRSI(c, i, 7) > 68;
  });
  const r_d1 = fmt(`D1_${coin}_DayDev0.5pct_RSI68_BB22`, coin, d1);
  if (r_d1.wr >= 0.75 && r_d1.n >= 10 && r_d1.tpd >= 0.33) winners.push({ label: `D1_${coin}`, ...r_d1 });

  // D2: price > 1% above today's open + BB22 + RSI7>68
  const d2 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const dayOpen = getTodayOpen(c, i);
    if (!dayOpen) return false;
    return (c[i].c - dayOpen) / dayOpen * 100 > 1.0 && calcRSI(c, i, 7) > 68;
  });
  const r_d2 = fmt(`D2_${coin}_DayDev1pct_RSI68_BB22`, coin, d2);
  if (r_d2.wr >= 0.75 && r_d2.n >= 10 && r_d2.tpd >= 0.33) winners.push({ label: `D2_${coin}`, ...r_d2 });

  // D3: price > 0.5% above open + GH + MFI>65 + BB22
  const d3 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.has(h)) return false;
    const dayOpen = getTodayOpen(c, i);
    if (!dayOpen) return false;
    return (c[i].c - dayOpen) / dayOpen * 100 > 0.5 && calcMFI(c, i) > 65;
  });
  const r_d3 = fmt(`D3_${coin}_DayDev0.5_GH_MFI65_BB22`, coin, d3);
  if (r_d3.wr >= 0.75 && r_d3.n >= 10 && r_d3.tpd >= 0.33) winners.push({ label: `D3_${coin}`, ...r_d3 });
}

// ═══════════════════════════════════════════════════════
// SECTION E: Gap detection (today opened above prev day high)
// "Gap-up then at BB extreme" = strong reversal candidate
// ═══════════════════════════════════════════════════════
console.log('\n== Section E: Gap-up + BB extreme ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // E1: today gapped up (open > prev high) + BB22 + RSI7>68
  const e1 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const dayOpen = getTodayOpen(c, i);
    if (!dayOpen) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    return dayOpen > prev.h * 1.001 && calcRSI(c, i, 7) > 68; // gapped above prev high
  });
  const r_e1 = fmt(`E1_${coin}_GapUp_RSI68_BB22`, coin, e1);
  if (r_e1.wr >= 0.75 && r_e1.n >= 10 && r_e1.tpd >= 0.33) winners.push({ label: `E1_${coin}`, ...r_e1 });

  // E2: gapped up + GH + RSI7>70
  const e2 = walkForward(candles, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.has(h)) return false;
    const dayOpen = getTodayOpen(c, i);
    if (!dayOpen) return false;
    const prev = getPrevDayOHLC(c, i);
    if (!prev) return false;
    return dayOpen > prev.h * 1.001 && calcRSI(c, i, 7) > 70;
  });
  const r_e2 = fmt(`E2_${coin}_GapUp_GH_RSI70_BB22`, coin, e2);
  if (r_e2.wr >= 0.75 && r_e2.n >= 10 && r_e2.tpd >= 0.33) winners.push({ label: `E2_${coin}`, ...r_e2 });
}

// ═══════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════
console.log('\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10, tpd>=0.33 ===');
console.log('=======================================================');
if (winners.length === 0) {
  console.log('  (none)');
} else {
  for (const w of winners) {
    console.log(`  ✅ ${w.label}: WR=${(w.wr * 100).toFixed(1)}% n=${w.n} tpd=${w.tpd.toFixed(2)}`);
  }
}

db.close();
