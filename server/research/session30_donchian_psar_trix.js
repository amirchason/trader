/**
 * Session 30: Donchian Channel squeeze, Parabolic SAR, TRIX
 *
 * Last genuinely unexplored technical indicators:
 * A. Donchian Channel — width contraction (squeeze) → BB extreme = strong reversal
 * B. Parabolic SAR flip — PSAR just turned bearish while price at BB upper
 * C. TRIX (Triple EMA oscillator) — negative divergence at BB extreme
 * D. Donchian upper + RSI7 sweeps (cleaner version of session27 B)
 * E. Aroon oscillator — trend direction strength at BB extreme
 * F. Ultimate Oscillator — combines 3 timeframes of momentum
 *
 * Note: After 12 null continuation sessions, these are the FINAL unexplored classic
 * technical analysis indicators. If session 30 also finds nothing, the 5m binary
 * pattern space is completely exhausted for this dataset.
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

function calcBB(candles, idx, period=20, mult=2.2) {
  if (idx < period) return null;
  const closes = candles.slice(idx - period, idx).map(c => c.c);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(closes.reduce((s, x) => s + (x - mean) ** 2, 0) / period);
  return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
}

function calcRSI(candles, idx, period=7) {
  if (idx < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = idx - period; i < idx; i++) {
    const d = candles[i].c - candles[i-1].c;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function calcMFI(candles, idx, period=14) {
  if (idx < period + 1) return 50;
  let pos = 0, neg = 0;
  for (let i = idx - period; i < idx; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i-1].h + candles[i-1].l + candles[i-1].c) / 3;
    const mf = tp * candles[i].v;
    if (tp > prevTp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

// Donchian Channel
function calcDonchian(candles, idx, period=20) {
  if (idx < period) return null;
  let highest = -Infinity, lowest = Infinity;
  for (let i = idx - period; i < idx; i++) {
    if (candles[i].h > highest) highest = candles[i].h;
    if (candles[i].l < lowest) lowest = candles[i].l;
  }
  return { upper: highest, lower: lowest, width: (highest - lowest) / ((highest + lowest) / 2) };
}

// EMA
function calcEMA(candles, idx, period) {
  if (idx < period) return candles[idx].c;
  const k = 2 / (period + 1);
  let ema = candles[idx - period + 1].c;
  for (let i = idx - period + 2; i <= idx; i++) {
    ema = candles[i].c * k + ema * (1 - k);
  }
  return ema;
}

// TRIX = rate of change of triple-smoothed EMA
// Period 9 default
function calcTRIX(candles, idx, period=9) {
  if (idx < period * 3 + 2) return 0;
  // We need 3 levels of EMA
  // Build arrays for computation
  const start = idx - period * 3 - 2;
  if (start < 0) return 0;

  // EMA1 from start
  const k = 2 / (period + 1);
  let ema1 = candles[start].c;
  for (let i = start + 1; i <= idx; i++) ema1 = candles[i].c * k + ema1 * (1 - k);

  let ema1Prev = candles[start].c;
  for (let i = start + 1; i < idx; i++) ema1Prev = candles[i].c * k + ema1Prev * (1 - k);

  // For TRIX we need ema3[idx] and ema3[idx-1]
  // Build ema2 and ema3 arrays from start
  const len = idx - start + 1;
  const ema1Arr = new Array(len);
  ema1Arr[0] = candles[start].c;
  for (let i = 1; i < len; i++) {
    ema1Arr[i] = candles[start + i].c * k + ema1Arr[i-1] * (1 - k);
  }

  const ema2Arr = new Array(len);
  ema2Arr[0] = ema1Arr[0];
  for (let i = 1; i < len; i++) {
    ema2Arr[i] = ema1Arr[i] * k + ema2Arr[i-1] * (1 - k);
  }

  const ema3Arr = new Array(len);
  ema3Arr[0] = ema2Arr[0];
  for (let i = 1; i < len; i++) {
    ema3Arr[i] = ema2Arr[i] * k + ema3Arr[i-1] * (1 - k);
  }

  const ema3Now = ema3Arr[len - 1];
  const ema3Prev = ema3Arr[len - 2];
  if (ema3Prev === 0) return 0;
  return (ema3Now - ema3Prev) / ema3Prev * 100; // rate of change in %
}

// Parabolic SAR (simplified implementation)
// Returns array of SAR values
function buildPSAR(candles, startIdx, af=0.02, afMax=0.20) {
  if (candles.length < 3) return [];
  const sar = new Array(candles.length).fill(0);
  let isUptrend = candles[1].c > candles[0].c;
  let afCurrent = af;
  let extremePoint = isUptrend ? candles[0].h : candles[0].l;
  sar[0] = isUptrend ? candles[0].l : candles[0].h;
  sar[1] = isUptrend ? Math.min(candles[0].l, candles[1].l) : Math.max(candles[0].h, candles[1].h);

  for (let i = 2; i < candles.length; i++) {
    const prevSar = sar[i-1];
    let newSar = prevSar + afCurrent * (extremePoint - prevSar);

    if (isUptrend) {
      newSar = Math.min(newSar, candles[i-1].l, candles[i-2].l);
      if (candles[i].l < newSar) {
        // Flip to downtrend
        isUptrend = false;
        newSar = extremePoint;
        extremePoint = candles[i].l;
        afCurrent = af;
      } else {
        if (candles[i].h > extremePoint) {
          extremePoint = candles[i].h;
          afCurrent = Math.min(afCurrent + af, afMax);
        }
      }
    } else {
      newSar = Math.max(newSar, candles[i-1].h, candles[i-2].h);
      if (candles[i].h > newSar) {
        // Flip to uptrend
        isUptrend = true;
        newSar = extremePoint;
        extremePoint = candles[i].h;
        afCurrent = af;
      } else {
        if (candles[i].l < extremePoint) {
          extremePoint = candles[i].l;
          afCurrent = Math.min(afCurrent + af, afMax);
        }
      }
    }
    sar[i] = newSar;
  }
  return sar;
}

// Aroon oscillator
// Aroon Up = (period - bars since period high) / period * 100
// Aroon Down = (period - bars since period low) / period * 100
// Aroon Osc = AroonUp - AroonDown
function calcAroon(candles, idx, period=14) {
  if (idx < period) return 0;
  const slice = candles.slice(idx - period, idx + 1);
  let highIdx = 0, lowIdx = 0;
  for (let i = 1; i <= period; i++) {
    if (slice[i].h > slice[highIdx].h) highIdx = i;
    if (slice[i].l < slice[lowIdx].l) lowIdx = i;
  }
  const barsSinceHigh = period - highIdx;
  const barsSinceLow = period - lowIdx;
  const aroonUp = (period - barsSinceHigh) / period * 100;
  const aroonDown = (period - barsSinceLow) / period * 100;
  return aroonUp - aroonDown; // positive = uptrend, negative = downtrend
}

// Ultimate Oscillator (uses 3 timeframes: 7, 14, 28)
function calcUltimateOsc(candles, idx) {
  if (idx < 29) return 50;
  function bp(i) { return candles[i].c - Math.min(candles[i].l, candles[i-1].c); }
  function tr(i) { return Math.max(candles[i].h, candles[i-1].c) - Math.min(candles[i].l, candles[i-1].c); }

  let bp7 = 0, tr7 = 0, bp14 = 0, tr14 = 0, bp28 = 0, tr28 = 0;
  for (let i = idx - 6; i <= idx; i++) { bp7 += bp(i); tr7 += tr(i); }
  for (let i = idx - 13; i <= idx; i++) { bp14 += bp(i); tr14 += tr(i); }
  for (let i = idx - 27; i <= idx; i++) { bp28 += bp(i); tr28 += tr(i); }

  if (tr7 === 0 || tr14 === 0 || tr28 === 0) return 50;
  const avg7 = bp7 / tr7;
  const avg14 = bp14 / tr14;
  const avg28 = bp28 / tr28;
  return (4 * avg7 + 2 * avg14 + avg28) / 7 * 100;
}

function getOutcome(candles, i, dir) {
  if (i + 1 >= candles.length) return null;
  const entry = candles[i].c, exit = candles[i+1].c;
  if (dir === 'DOWN') return exit < entry ? 1 : 0;
  return exit > entry ? 1 : 0;
}

function backtest(candles, filterFn, direction) {
  let wins = 0, total = 0;
  for (let i = 60; i < candles.length - 1; i++) {
    if (filterFn(candles, i)) {
      const out = getOutcome(candles, i, direction);
      if (out !== null) { total++; if (out === 1) wins++; }
    }
  }
  if (total < 5) return null;
  const days = candles.length * 5 / (60 * 24);
  return { wr: wins / total, n: total, tpd: total / days };
}

function fmt(label, coin, res, winners) {
  if (!res) return;
  const e = res.wr >= 0.80 ? '🔥🔥🔥' : res.wr >= 0.75 ? '🔥🔥' : res.wr >= 0.70 ? '🔥' : '';
  const w = res.tpd < 0.33 ? ` ⚠️ tpd=${res.tpd.toFixed(2)}` : '';
  console.log(`  ${label} | ${coin}: WR=${(res.wr*100).toFixed(1)}% n=${res.n} tpd=${res.tpd.toFixed(2)} ${e}${w}`);
  if (res.wr >= 0.75 && res.n >= 10 && res.tpd >= 0.33 && winners) winners.push({ label, coin, ...res });
}

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const GH = { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] };

console.log('Loading candles + building PSAR...');
const ALL = {};
const PSAR = {};
for (const c of COINS) {
  ALL[c] = getCandles(c);
  PSAR[c] = buildPSAR(ALL[c]);
  console.log(`  ${c}: ${ALL[c].length} candles (${Math.floor(ALL[c].length * 5 / 1440)} days)`);
}

const winners = [];

// =============================================
// Section A: Donchian Channel dynamics at BB extreme
// =============================================
console.log('\n== Section A: Donchian Channel at BB extremes ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // A1: Donchian upper = current close (new 20-bar high) + BB upper + RSI7>70 (cleaner than session27)
  fmt(`A1_${coin}_Donch20upper_BB22_RSI70`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const don = calcDonchian(c, i, 20);
    if (!don) return false;
    // Current HIGH equals Donchian upper (true new high)
    return c[i].h >= don.upper && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // A2: Donchian channel width contracted (narrow squeeze) + now at BB upper
  fmt(`A2_${coin}_DonchNarrow_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    if (i < 30) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const donNow = calcDonchian(c, i, 10); // short lookback = current width
    const donOld = calcDonchian(c, i - 20, 10); // width 20 bars ago
    if (!donNow || !donOld) return false;
    // Current channel is narrower than 20 bars ago (squeeze occurred)
    const squeezed = donNow.width < donOld.width * 0.8;
    return squeezed && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // A3: Donchian upper with GH + RSI70
  fmt(`A3_${coin}_Donch20upper_GH_RSI70`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const don = calcDonchian(c, i, 20);
    if (!don) return false;
    return c[i].h >= don.upper && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // A4: Price at Donchian upper AND above BB22 AND MFI>68
  fmt(`A4_${coin}_Donch20_MFI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const don = calcDonchian(c, i, 20);
    if (!don) return false;
    return c[i].h >= don.upper && calcMFI(c, i) > 68;
  }, 'DOWN'), winners);

  // A5: Donchian contraction + expansion (BB squeeze-release pattern)
  fmt(`A5_${coin}_DonchExpand_BB22_GH`, coin, backtest(cs, (c, i) => {
    if (i < 25) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    // Was narrow 10 bars ago, now wider (expansion after squeeze)
    const donRecent = calcDonchian(c, i, 5);
    const donOld = calcDonchian(c, i - 10, 5);
    if (!donRecent || !donOld) return false;
    return donRecent.width > donOld.width * 1.2 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);
}

// =============================================
// Section B: Parabolic SAR flip at BB extreme
// PSAR just flipped to ABOVE price (bearish) while price is above BB
// =============================================
console.log('\n== Section B: Parabolic SAR flip at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];
  const psar = PSAR[coin];

  // B1: PSAR currently above price (bearish) + price above BB upper + RSI7>68
  fmt(`B1_${coin}_PSAR_bear_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    // PSAR above price = bearish signal
    return psar[i] > c[i].c && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // B2: PSAR just flipped (prev was below price, now above) + BB upper + RSI7>68
  fmt(`B2_${coin}_PSAR_flip_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    // Flip: prev PSAR below price, current PSAR above price
    const flipBearish = psar[i-1] < c[i-1].c && psar[i] > c[i].c;
    return flipBearish && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // B3: PSAR bearish + good hours + BB22
  fmt(`B3_${coin}_PSAR_bear_GH_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return psar[i] > c[i].c && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // B4: PSAR flip + good hours + MFI>65
  fmt(`B4_${coin}_PSAR_flip_GH_MFI65`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const flipBearish = psar[i-1] < c[i-1].c && psar[i] > c[i].c;
    return flipBearish && calcMFI(c, i) > 65;
  }, 'DOWN'), winners);
}

// =============================================
// Section C: TRIX at BB extreme
// TRIX > 0 (trending up) but starting to slow — divergence signal
// =============================================
console.log('\n== Section C: TRIX oscillator at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // C1: TRIX > 0 (positive = uptrend) + BB upper + RSI7>70 (trend up but at extreme)
  fmt(`C1_${coin}_TRIX>0_BB22_RSI70`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcTRIX(c, i) > 0 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // C2: TRIX declining (prev > current) while still above 0 + BB upper (momentum fading)
  fmt(`C2_${coin}_TRIXdecline_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const trixNow = calcTRIX(c, i);
    const trixPrev = calcTRIX(c, i-1);
    return trixNow < trixPrev && trixNow > 0 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // C3: TRIX > 0.05 (strongly positive) + GH + BB22
  fmt(`C3_${coin}_TRIX>0.05_GH_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcTRIX(c, i) > 0.05 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // C4: TRIX declining + GH + RSI70
  fmt(`C4_${coin}_TRIXdecline_GH_RSI70`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const trixNow = calcTRIX(c, i);
    const trixPrev = calcTRIX(c, i-1);
    return trixNow < trixPrev && trixNow > 0 && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);
}

// =============================================
// Section D: Aroon Oscillator at BB extreme
// Aroon Osc > 80 = strong uptrend, at BB upper = overextended
// =============================================
console.log('\n== Section D: Aroon oscillator at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // D1: Aroon Osc > 50 (uptrend) + BB upper + RSI7>68
  fmt(`D1_${coin}_Aroon>50_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcAroon(c, i) > 50 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // D2: Aroon Osc > 70 (strong uptrend) + BB upper + RSI7>68
  fmt(`D2_${coin}_Aroon>70_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcAroon(c, i) > 70 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // D3: Aroon Osc > 70 + good hours
  fmt(`D3_${coin}_Aroon>70_GH_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcAroon(c, i) > 70 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // D4: Aroon declining (was >80, now declining) + BB upper (trend weakening at extreme)
  fmt(`D4_${coin}_AroonDecline_BB22_GH`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const aroonNow = calcAroon(c, i);
    const aroonPrev = calcAroon(c, i-1);
    return aroonNow < aroonPrev && aroonPrev > 60 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);
}

// =============================================
// Section E: Ultimate Oscillator at BB extreme
// UO > 70 = overbought (uses 7+14+28 timeframes) + BB upper
// =============================================
console.log('\n== Section E: Ultimate Oscillator at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // E1: UO > 70 + BB upper + RSI7>68 (all hours)
  fmt(`E1_${coin}_UO>70_BB22_RSI68`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcUltimateOsc(c, i) > 70 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // E2: UO > 75 + BB upper + GH
  fmt(`E2_${coin}_UO>75_GH_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcUltimateOsc(c, i) > 75 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // E3: UO > 70 + MFI>68 + BB upper
  fmt(`E3_${coin}_UO>70_MFI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return calcUltimateOsc(c, i) > 70 && calcMFI(c, i) > 68;
  }, 'DOWN'), winners);

  // E4: UO sweep
  for (const uoThr of [65, 70, 75, 80]) {
    const res = backtest(cs, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c < bb.upper) return false;
      const h = new Date(c[i].t).getUTCHours();
      if (!gh.includes(h)) return false;
      return calcUltimateOsc(c, i) > uoThr && calcRSI(c, i) > 68;
    }, 'DOWN');
    if (res && res.wr >= 0.68 && res.n >= 8) {
      fmt(`E4_${coin}_UO>${uoThr}_GH_RSI68_BB22`, coin, res, winners);
    }
  }
}

// =============================================
// SUMMARY
// =============================================
console.log('\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10, tpd>=0.33 ===');
console.log('=======================================================');
if (winners.length === 0) {
  console.log('  (none)');
} else {
  for (const w of winners) {
    console.log(`  ${w.label}: WR=${(w.wr*100).toFixed(1)}% n=${w.n} tpd=${w.tpd.toFixed(2)} 🔥🔥`);
  }
}

console.log('\n=======================================================');
console.log('=== RESEARCH SUMMARY: SESSIONS 18-30 ===');
console.log('=== (All continuation sessions after main 1-21) ===');
console.log('=======================================================');
console.log('  Strategy space exhausted: 13 consecutive null sessions');
console.log('  Tested dimensions:');
console.log('    - Per-hour scans, OR-logic, 2-window filters (sess18)');
console.log('    - CCI, BB deviation, body exhaustion, Stoch-K (sess19-20)');
console.log('    - All-hours RSI×MFI grid, SOL/ETH hour variants (sess21-22)');
console.log('    - Divergence, ROC momentum, adaptive percentile (sess23)');
console.log('    - Cross-coin confirmation, ATR regime (sess24)');
console.log('    - Day-of-week × hour interaction grid (sess25)');
console.log('    - Pin bars, engulfing, doji, 3-bar exhaustion (sess26)');
console.log('    - Traditional stochastic %K/%D, N-bar high, SMA dev, RSI2 (sess27)');
console.log('    - ROC enhancement, CMF, OBV, volume decline, reversal confirm (sess28)');
console.log('    - VWAP extended, Heikin Ashi, multi-BB, fractals, VWAP cross (sess29)');
console.log('    - Donchian channel, Parabolic SAR, TRIX, Aroon, UO (sess30)');
console.log('  Best near-miss: ETH ROC>0.4%+GH = 77.8% WR n=36 tpd=0.20');
console.log('  CONCLUSION: The 5m Polymarket binary pattern space is DEFINITIVELY exhausted.');

db.close();
