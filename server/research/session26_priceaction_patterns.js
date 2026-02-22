/**
 * Session 26: Pure Price Action Candle Patterns at BB Extremes
 *
 * Novel angle: chart patterns (not just indicator levels) — theoretically sound
 * reversal signals that haven't been tested in any prior session.
 *
 * Patterns tested:
 * A. Pin bar (hammer/shooting star) at BB extreme — long wick, small body = rejection
 * B. Engulfing at BB extreme — current body > previous body, opposite direction
 * C. Doji at BB extreme — body < 20% of range = indecision → reversal
 * D. 3-bar exhaustion — 3 consecutive same-direction candles at BB extreme
 * E. Small body (< 0.4×ATR) squeeze at BB extreme — momentum exhaustion
 * F. First-signal enhancement — FirstSignal + RSI7>73 filter (to improve F2=65% from session25)
 * G. Wick vs body ratio sweep — find optimal wick/body ratio for reversals
 *
 * Exit model: CORRECT fixed-expiry binary (close at EXACTLY next candle close)
 * Fee model: 2% spread → breakeven ≈ 51.02%
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
    t: r.open_time,
    o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume
  }));
}

// BB(20, 2.2)
function calcBB(candles, idx, period=20, mult=2.2) {
  if (idx < period) return null;
  const slice = candles.slice(idx - period, idx);
  const closes = slice.map(c => c.c);
  const mean = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { mid: mean, upper: mean + mult * std, lower: mean - mult * std };
}

// RSI
function calcRSI(candles, idx, period=7) {
  if (idx < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = idx - period; i < idx; i++) {
    const diff = candles[i].c - candles[i-1].c;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// MFI
function calcMFI(candles, idx, period=14) {
  if (idx < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = idx - period; i < idx; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    const prevTp = (candles[i-1].h + candles[i-1].l + candles[i-1].c) / 3;
    const rawMF = tp * candles[i].v;
    if (tp > prevTp) posFlow += rawMF; else negFlow += rawMF;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

// ATR
function calcATR(candles, idx, period=14) {
  if (idx < period + 1) return 0;
  let sum = 0;
  for (let i = idx - period; i < idx; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    );
    sum += tr;
  }
  return sum / period;
}

// ADX
function calcADX(candles, idx, period=14) {
  if (idx < period * 2) return 50;
  let dmPlus = 0, dmMinus = 0, trSum = 0;
  for (let i = idx - period; i < idx; i++) {
    const tr = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
    const dpH = candles[i].h - candles[i-1].h;
    const dpL = candles[i-1].l - candles[i].l;
    dmPlus += (dpH > dpL && dpH > 0) ? dpH : 0;
    dmMinus += (dpL > dpH && dpL > 0) ? dpL : 0;
    trSum += tr;
  }
  if (trSum === 0) return 50;
  const diPlus = (dmPlus / trSum) * 100;
  const diMinus = (dmMinus / trSum) * 100;
  const diSum = diPlus + diMinus;
  if (diSum === 0) return 0;
  return Math.abs(diPlus - diMinus) / diSum * 100;
}

// Candle features
function candleFeatures(c) {
  const body = Math.abs(c.c - c.o);
  const range = c.h - c.l;
  const upperWick = c.h - Math.max(c.o, c.c);
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const isBullish = c.c > c.o;
  const isBearish = c.c < c.o;
  return { body, range, upperWick, lowerWick, isBullish, isBearish };
}

// Binary outcome: win if close > entry (for UP bet)
function getOutcome(candles, entryIdx, direction) {
  if (entryIdx + 1 >= candles.length) return null;
  const entry = candles[entryIdx].c;
  const exit = candles[entryIdx + 1].c;
  if (direction === 'UP') return exit > entry ? 1 : 0;
  return exit < entry ? 1 : 0;
}

function backtest(candles, filterFn, direction) {
  let wins = 0, total = 0;
  const warmup = 50;
  for (let i = warmup; i < candles.length - 1; i++) {
    if (filterFn(candles, i)) {
      const outcome = getOutcome(candles, i, direction);
      if (outcome !== null) { total++; if (outcome === 1) wins++; }
    }
  }
  if (total < 5) return null;
  const days = candles.length * 5 / (60 * 24);
  return { wr: wins / total, n: total, tpd: total / days };
}

function fmtResult(label, coin, res) {
  if (!res) return;
  const emoji = res.wr >= 0.80 ? '🔥🔥🔥' : res.wr >= 0.75 ? '🔥🔥' : res.wr >= 0.70 ? '🔥' : '';
  const tpdWarn = res.tpd < 0.33 ? ` ⚠️ tpd too low (${res.tpd.toFixed(2)}/day min=0.33)` : '';
  console.log(`  ${label} | ${coin}: WR=${(res.wr*100).toFixed(1)}% n=${res.n} tpd=${res.tpd.toFixed(2)} ${emoji}${tpdWarn}`);
  return res;
}

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const GOOD_HOURS = {
  ETH: [10, 11, 12, 21], BTC: [1, 12, 13, 16, 20],
  SOL: [0, 12, 13, 20], XRP: [6, 9, 12, 18]
};

console.log('Loading candles...');
const allCandles = {};
for (const coin of COINS) {
  allCandles[coin] = getCandles(coin);
  console.log(`  ${coin}: ${allCandles[coin].length} candles (${Math.floor(allCandles[coin].length * 5 / 1440)} days)`);
}

// =============================================
// Section A: Pin Bar at BB extreme
// Pin bar = wick >= 2x body, wick pointing away from BB extreme
// e.g., shooting star above upper BB: upper wick >= 2x body, close < open (bearish)
// e.g., hammer below lower BB: lower wick >= 2x body, close > open (bullish)
// =============================================
console.log('\n== Section A: Pin Bar at BB extremes ==\n');

const winners = [];

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // A1: Shooting star above BB upper (RSI7 extreme optional)
  const resA1 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const f = candleFeatures(c);
    if (f.range === 0) return false;
    // Price above upper BB
    if (c.c < bb.upper) return false;
    // Body small, upper wick large (shooting star = bearish rejection)
    const bodyRatio = f.body / f.range;
    const wickRatio = f.upperWick / f.range;
    return bodyRatio < 0.3 && wickRatio > 0.5 && f.isBearish;
  }, 'DOWN');
  const r = fmtResult(`A1_${coin}_ShootingStar_BB22`, coin, resA1);
  if (r && r.wr >= 0.75 && r.n >= 10 && r.tpd >= 0.33) winners.push({ label: `A1_${coin}_ShootingStar_BB22`, ...r });

  // A2: Hammer below BB lower
  const resA2 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const f = candleFeatures(c);
    if (f.range === 0) return false;
    if (c.c > bb.lower) return false;
    const bodyRatio = f.body / f.range;
    const wickRatio = f.lowerWick / f.range;
    return bodyRatio < 0.3 && wickRatio > 0.5 && f.isBullish;
  }, 'UP');
  fmtResult(`A2_${coin}_Hammer_BB22`, coin, resA2);
  if (resA2 && resA2.wr >= 0.75 && resA2.n >= 10 && resA2.tpd >= 0.33) winners.push({ label: `A2_${coin}_Hammer_BB22`, ...resA2 });

  // A3: Shooting star above BB upper + good hours
  const resA3 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!gh.includes(h)) return false;
    const f = candleFeatures(c);
    if (f.range === 0) return false;
    if (c.c < bb.upper) return false;
    const bodyRatio = f.body / f.range;
    const wickRatio = f.upperWick / f.range;
    return bodyRatio < 0.3 && wickRatio > 0.5 && f.isBearish;
  }, 'DOWN');
  fmtResult(`A3_${coin}_ShootingStar_BB22_GH`, coin, resA3);
  if (resA3 && resA3.wr >= 0.75 && resA3.n >= 10 && resA3.tpd >= 0.33) winners.push({ label: `A3_${coin}_ShootingStar_BB22_GH`, ...resA3 });

  // A4: Hammer below BB lower + good hours
  const resA4 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!gh.includes(h)) return false;
    const f = candleFeatures(c);
    if (f.range === 0) return false;
    if (c.c > bb.lower) return false;
    const bodyRatio = f.body / f.range;
    const wickRatio = f.lowerWick / f.range;
    return bodyRatio < 0.3 && wickRatio > 0.5 && f.isBullish;
  }, 'UP');
  fmtResult(`A4_${coin}_Hammer_BB22_GH`, coin, resA4);
  if (resA4 && resA4.wr >= 0.75 && resA4.n >= 10 && resA4.tpd >= 0.33) winners.push({ label: `A4_${coin}_Hammer_BB22_GH`, ...resA4 });

  // A5: Any pin bar (either direction) above/below BB22 + RSI7 extreme
  const resA5_up = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const rsi = calcRSI(cs, i);
    const f = candleFeatures(c);
    if (f.range === 0) return false;
    if (c.l > bb.lower) return false; // must touch below lower
    const bodyRatio = f.body / f.range;
    const wickRatio = f.lowerWick / f.range;
    return bodyRatio < 0.35 && wickRatio > 0.45 && rsi > 65;
  }, 'UP');
  fmtResult(`A5_${coin}_PinBar_Lower_RSI>65`, coin, resA5_up);
  if (resA5_up && resA5_up.wr >= 0.75 && resA5_up.n >= 10 && resA5_up.tpd >= 0.33) winners.push({ label: `A5_${coin}_PinBar_Lower_RSI>65`, ...resA5_up });
}

// =============================================
// Section B: Engulfing pattern at BB extreme
// Engulfing = current candle body > previous candle body, opposite direction
// =============================================
console.log('\n== Section B: Engulfing at BB extremes ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // B1: Bearish engulfing above upper BB (sell signal)
  const resB1 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const cur = cs[i], prev = cs[i-1];
    if (cur.c > bb.upper) return false; // close must be near upper BB
    const curBody = Math.abs(cur.c - cur.o);
    const prevBody = Math.abs(prev.c - prev.o);
    // Bearish engulfing: current bearish, body > prev body, opens above prev close
    return cur.o > cur.c && curBody > prevBody * 1.2 && cur.o > prev.c && prev.c > prev.o && cur.h >= bb.upper;
  }, 'DOWN');
  fmtResult(`B1_${coin}_BearishEngulfing_upper_BB22`, coin, resB1);
  if (resB1 && resB1.wr >= 0.75 && resB1.n >= 10 && resB1.tpd >= 0.33) winners.push({ label: `B1_${coin}_BearishEngulfing_upper_BB22`, ...resB1 });

  // B2: Bullish engulfing below lower BB (buy signal)
  const resB2 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const cur = cs[i], prev = cs[i-1];
    if (cur.c < bb.lower) return false;
    const curBody = Math.abs(cur.c - cur.o);
    const prevBody = Math.abs(prev.c - prev.o);
    return cur.c > cur.o && curBody > prevBody * 1.2 && cur.o < prev.c && prev.c < prev.o && cur.l <= bb.lower;
  }, 'UP');
  fmtResult(`B2_${coin}_BullishEngulfing_lower_BB22`, coin, resB2);
  if (resB2 && resB2.wr >= 0.75 && resB2.n >= 10 && resB2.tpd >= 0.33) winners.push({ label: `B2_${coin}_BullishEngulfing_lower_BB22`, ...resB2 });

  // B3: Bearish engulfing above BB + RSI7>65
  const resB3 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const rsi = calcRSI(cs, i);
    if (rsi < 65) return false;
    const cur = cs[i], prev = cs[i-1];
    const curBody = Math.abs(cur.c - cur.o);
    const prevBody = Math.abs(prev.c - prev.o);
    return cur.o > cur.c && curBody > prevBody * 1.1 && cur.o > prev.c && prev.c > prev.o && cur.h >= bb.upper;
  }, 'DOWN');
  fmtResult(`B3_${coin}_BearishEngulfing_BB22_RSI65`, coin, resB3);
  if (resB3 && resB3.wr >= 0.75 && resB3.n >= 10 && resB3.tpd >= 0.33) winners.push({ label: `B3_${coin}_BearishEngulfing_BB22_RSI65`, ...resB3 });

  // B4: Bearish engulfing above BB + good hours
  const resB4 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!gh.includes(h)) return false;
    const prev = cs[i-1];
    const curBody = Math.abs(c.c - c.o);
    const prevBody = Math.abs(prev.c - prev.o);
    return c.o > c.c && curBody > prevBody * 1.1 && c.o > prev.c && prev.c > prev.o && c.h >= bb.upper;
  }, 'DOWN');
  fmtResult(`B4_${coin}_BearishEngulfing_BB22_GH`, coin, resB4);
  if (resB4 && resB4.wr >= 0.75 && resB4.n >= 10 && resB4.tpd >= 0.33) winners.push({ label: `B4_${coin}_BearishEngulfing_BB22_GH`, ...resB4 });
}

// =============================================
// Section C: Doji at BB extreme
// Doji = body < 20% of range = indecision → reversal
// =============================================
console.log('\n== Section C: Doji at BB extremes ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // C1: Doji at upper BB (sell signal)
  const resC1 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const f = candleFeatures(c);
    if (f.range === 0 || f.range < 0.001 * c.c) return false; // ignore flat candles
    const bodyRatio = f.body / f.range;
    return bodyRatio < 0.2 && c.h >= bb.upper;
  }, 'DOWN');
  fmtResult(`C1_${coin}_Doji_upper_BB22`, coin, resC1);

  // C2: Doji at lower BB (buy signal)
  const resC2 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const f = candleFeatures(c);
    if (f.range === 0 || f.range < 0.001 * c.c) return false;
    const bodyRatio = f.body / f.range;
    return bodyRatio < 0.2 && c.l <= bb.lower;
  }, 'UP');
  fmtResult(`C2_${coin}_Doji_lower_BB22`, coin, resC2);

  // C3: Doji at upper BB + RSI7>68
  const resC3 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const rsi = calcRSI(cs, i);
    const f = candleFeatures(c);
    if (f.range === 0 || f.range < 0.001 * c.c) return false;
    const bodyRatio = f.body / f.range;
    return bodyRatio < 0.2 && c.h >= bb.upper && rsi > 68;
  }, 'DOWN');
  fmtResult(`C3_${coin}_Doji_upper_BB22_RSI68`, coin, resC3);
  if (resC3 && resC3.wr >= 0.75 && resC3.n >= 10 && resC3.tpd >= 0.33) winners.push({ label: `C3_${coin}_Doji_upper_BB22_RSI68`, ...resC3 });

  // C4: Doji at upper BB + good hours
  const resC4 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!gh.includes(h)) return false;
    const f = candleFeatures(c);
    if (f.range === 0 || f.range < 0.001 * c.c) return false;
    const bodyRatio = f.body / f.range;
    return bodyRatio < 0.2 && c.h >= bb.upper;
  }, 'DOWN');
  fmtResult(`C4_${coin}_Doji_upper_BB22_GH`, coin, resC4);
  if (resC4 && resC4.wr >= 0.75 && resC4.n >= 10 && resC4.tpd >= 0.33) winners.push({ label: `C4_${coin}_Doji_upper_BB22_GH`, ...resC4 });
}

// =============================================
// Section D: 3-bar exhaustion pattern
// 3 consecutive same-direction candles with RSI extreme at BB extreme
// =============================================
console.log('\n== Section D: 3-bar exhaustion ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // D1: 3 consecutive up candles → mean reversion DOWN (above BB)
  const resD1 = backtest(candles, (cs, i) => {
    if (i < 3) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    if (c.c < bb.upper) return false;
    // Last 3 candles all bullish (close > open)
    return cs[i].c > cs[i].o && cs[i-1].c > cs[i-1].o && cs[i-2].c > cs[i-2].o;
  }, 'DOWN');
  fmtResult(`D1_${coin}_3UPcandles_BB22_upper`, coin, resD1);
  if (resD1 && resD1.wr >= 0.75 && resD1.n >= 10 && resD1.tpd >= 0.33) winners.push({ label: `D1_${coin}_3UPcandles_BB22_upper`, ...resD1 });

  // D2: 3 consecutive down candles → mean reversion UP (below BB)
  const resD2 = backtest(candles, (cs, i) => {
    if (i < 3) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    if (c.c > bb.lower) return false;
    return cs[i].c < cs[i].o && cs[i-1].c < cs[i-1].o && cs[i-2].c < cs[i-2].o;
  }, 'UP');
  fmtResult(`D2_${coin}_3DOWNcandles_BB22_lower`, coin, resD2);

  // D3: 3+ consecutive up candles + RSI7>70 + above BB
  const resD3 = backtest(candles, (cs, i) => {
    if (i < 3) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const rsi = calcRSI(cs, i);
    if (c.c < bb.upper || rsi < 70) return false;
    return cs[i].c > cs[i].o && cs[i-1].c > cs[i-1].o && cs[i-2].c > cs[i-2].o;
  }, 'DOWN');
  fmtResult(`D3_${coin}_3UPcandles_BB22_RSI70`, coin, resD3);
  if (resD3 && resD3.wr >= 0.75 && resD3.n >= 10 && resD3.tpd >= 0.33) winners.push({ label: `D3_${coin}_3UPcandles_BB22_RSI70`, ...resD3 });

  // D4: 4 consecutive up candles + above BB (stronger signal)
  const resD4 = backtest(candles, (cs, i) => {
    if (i < 4) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    if (c.c < bb.upper) return false;
    return cs[i].c > cs[i].o && cs[i-1].c > cs[i-1].o && cs[i-2].c > cs[i-2].o && cs[i-3].c > cs[i-3].o;
  }, 'DOWN');
  fmtResult(`D4_${coin}_4UPcandles_BB22_upper`, coin, resD4);
  if (resD4 && resD4.wr >= 0.75 && resD4.n >= 10 && resD4.tpd >= 0.33) winners.push({ label: `D4_${coin}_4UPcandles_BB22_upper`, ...resD4 });

  // D5: 3+ up candles + good hours + BB
  const resD5 = backtest(candles, (cs, i) => {
    if (i < 3) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!gh.includes(h)) return false;
    if (c.c < bb.upper) return false;
    return cs[i].c > cs[i].o && cs[i-1].c > cs[i-1].o && cs[i-2].c > cs[i-2].o;
  }, 'DOWN');
  fmtResult(`D5_${coin}_3UPcandles_BB22_GH`, coin, resD5);
  if (resD5 && resD5.wr >= 0.75 && resD5.n >= 10 && resD5.tpd >= 0.33) winners.push({ label: `D5_${coin}_3UPcandles_BB22_GH`, ...resD5 });
}

// =============================================
// Section E: Small body (momentum exhaustion) at BB extreme
// Small body < 0.35×ATR = price can't push further = reversal signal
// =============================================
console.log('\n== Section E: Small body momentum exhaustion ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // E1: Small body above upper BB
  const resE1 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    if (c.c < bb.upper) return false;
    const atr = calcATR(cs, i);
    if (atr === 0) return false;
    const body = Math.abs(c.c - c.o);
    return body < atr * 0.35;
  }, 'DOWN');
  fmtResult(`E1_${coin}_SmallBody_upper_BB22`, coin, resE1);
  if (resE1 && resE1.wr >= 0.75 && resE1.n >= 10 && resE1.tpd >= 0.33) winners.push({ label: `E1_${coin}_SmallBody_upper_BB22`, ...resE1 });

  // E2: Small body below lower BB
  const resE2 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    if (c.c > bb.lower) return false;
    const atr = calcATR(cs, i);
    if (atr === 0) return false;
    const body = Math.abs(c.c - c.o);
    return body < atr * 0.35;
  }, 'UP');
  fmtResult(`E2_${coin}_SmallBody_lower_BB22`, coin, resE2);

  // E3: Small body above upper BB + RSI7>68
  const resE3 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const rsi = calcRSI(cs, i);
    if (c.c < bb.upper || rsi < 68) return false;
    const atr = calcATR(cs, i);
    if (atr === 0) return false;
    const body = Math.abs(c.c - c.o);
    return body < atr * 0.4;
  }, 'DOWN');
  fmtResult(`E3_${coin}_SmallBody_upper_BB22_RSI68`, coin, resE3);
  if (resE3 && resE3.wr >= 0.75 && resE3.n >= 10 && resE3.tpd >= 0.33) winners.push({ label: `E3_${coin}_SmallBody_upper_BB22_RSI68`, ...resE3 });

  // E4: Small body above upper BB + good hours
  const resE4 = backtest(candles, (cs, i) => {
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!gh.includes(h)) return false;
    if (c.c < bb.upper) return false;
    const atr = calcATR(cs, i);
    if (atr === 0) return false;
    const body = Math.abs(c.c - c.o);
    return body < atr * 0.4;
  }, 'DOWN');
  fmtResult(`E4_${coin}_SmallBody_upper_BB22_GH`, coin, resE4);
  if (resE4 && resE4.wr >= 0.75 && resE4.n >= 10 && resE4.tpd >= 0.33) winners.push({ label: `E4_${coin}_SmallBody_upper_BB22_GH`, ...resE4 });

  // E5: Small body + streaking (prev 2 candles same direction) above BB
  const resE5 = backtest(candles, (cs, i) => {
    if (i < 2) return false;
    const bb = calcBB(cs, i);
    if (!bb) return false;
    const c = cs[i];
    if (c.c < bb.upper) return false;
    const atr = calcATR(cs, i);
    if (atr === 0) return false;
    const body = Math.abs(c.c - c.o);
    const prevUp1 = cs[i-1].c > cs[i-1].o;
    const prevUp2 = cs[i-2].c > cs[i-2].o;
    return body < atr * 0.4 && prevUp1 && prevUp2;
  }, 'DOWN');
  fmtResult(`E5_${coin}_SmallBody_streak2_upper_BB22`, coin, resE5);
  if (resE5 && resE5.wr >= 0.75 && resE5.n >= 10 && resE5.tpd >= 0.33) winners.push({ label: `E5_${coin}_SmallBody_streak2_upper_BB22`, ...resE5 });
}

// =============================================
// Section F: First-signal enhancement
// Session 25 found: F2_ETH_GH+FirstSignal+BB22 = 65% WR 1.11 tpd
// Try to push WR higher with additional filters
// "First signal" = current candle triggers BUT prev candle did NOT
// =============================================
console.log('\n== Section F: First-signal enhancement ==\n');

// Base signal: RSI7>70 + BB22 outside
function baseSignal(cs, i) {
  const bb = calcBB(cs, i);
  if (!bb) return false;
  const rsi = calcRSI(cs, i);
  return rsi > 70 && cs[i].c > bb.upper;
}

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  // F1: First signal (prev candle didn't trigger) + RSI7>72
  const resF1 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const rsi = calcRSI(cs, i);
    if (rsi < 72) return false;
    const bb = calcBB(cs, i);
    if (!bb || cs[i].c < bb.upper) return false;
    return !baseSignal(cs, i-1); // previous candle did NOT signal
  }, 'DOWN');
  fmtResult(`F1_${coin}_FirstSignal_RSI72_BB22`, coin, resF1);
  if (resF1 && resF1.wr >= 0.75 && resF1.n >= 10 && resF1.tpd >= 0.33) winners.push({ label: `F1_${coin}_FirstSignal_RSI72_BB22`, ...resF1 });

  // F2: First signal + good hours
  const resF2 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const c = cs[i];
    const h = new Date(c.t).getUTCHours();
    if (!gh.includes(h)) return false;
    const bb = calcBB(cs, i);
    if (!bb || c.c < bb.upper) return false;
    const rsi = calcRSI(cs, i);
    if (rsi < 70) return false;
    return !baseSignal(cs, i-1);
  }, 'DOWN');
  fmtResult(`F2_${coin}_FirstSignal_GH_RSI70_BB22`, coin, resF2);
  if (resF2 && resF2.wr >= 0.75 && resF2.n >= 10 && resF2.tpd >= 0.33) winners.push({ label: `F2_${coin}_FirstSignal_GH_RSI70_BB22`, ...resF2 });

  // F3: First signal + MFI>68 + RSI7>70
  const resF3 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const bb = calcBB(cs, i);
    if (!bb || cs[i].c < bb.upper) return false;
    const rsi = calcRSI(cs, i);
    const mfi = calcMFI(cs, i);
    if (rsi < 70 || mfi < 68) return false;
    return !baseSignal(cs, i-1);
  }, 'DOWN');
  fmtResult(`F3_${coin}_FirstSignal_RSI70_MFI68_BB22`, coin, resF3);
  if (resF3 && resF3.wr >= 0.75 && resF3.n >= 10 && resF3.tpd >= 0.33) winners.push({ label: `F3_${coin}_FirstSignal_RSI70_MFI68_BB22`, ...resF3 });

  // F4: First signal + ADX<20 (ranging market only)
  const resF4 = backtest(candles, (cs, i) => {
    if (i < 1) return false;
    const bb = calcBB(cs, i);
    if (!bb || cs[i].c < bb.upper) return false;
    const rsi = calcRSI(cs, i);
    const adx = calcADX(cs, i);
    if (rsi < 70 || adx > 20) return false;
    return !baseSignal(cs, i-1);
  }, 'DOWN');
  fmtResult(`F4_${coin}_FirstSignal_ADX20_RSI70_BB22`, coin, resF4);
  if (resF4 && resF4.wr >= 0.75 && resF4.n >= 10 && resF4.tpd >= 0.33) winners.push({ label: `F4_${coin}_FirstSignal_ADX20_RSI70_BB22`, ...resF4 });
}

// =============================================
// Section G: Wick ratio sweep — find optimal ratio
// Sweep body/range and wick/range thresholds at BB extremes
// =============================================
console.log('\n== Section G: Wick ratio sweep (ETH + BTC only) ==\n');

const wickThresholds = [0.3, 0.4, 0.5, 0.6, 0.7];
const bodyThresholds = [0.15, 0.20, 0.25, 0.30, 0.35];

for (const coin of ['ETH', 'BTC']) {
  const candles = allCandles[coin];
  console.log(`  ${coin} wick sweep (shooting star above BB22):`);
  for (const wt of wickThresholds) {
    for (const bt of bodyThresholds) {
      if (bt >= wt) continue; // body must be smaller than wick
      const res = backtest(candles, (cs, i) => {
        const bb = calcBB(cs, i);
        if (!bb) return false;
        const c = cs[i];
        const f = candleFeatures(c);
        if (f.range === 0) return false;
        if (c.c < bb.upper) return false;
        return f.body / f.range < bt && f.upperWick / f.range > wt && f.isBearish;
      }, 'DOWN');
      if (res && res.wr >= 0.70 && res.n >= 8) {
        const emoji = res.wr >= 0.80 ? '🔥🔥🔥' : res.wr >= 0.75 ? '🔥🔥' : '🔥';
        const tpdWarn = res.tpd < 0.33 ? ` ⚠️ tpd=${res.tpd.toFixed(2)}` : '';
        console.log(`    wick>${(wt*100).toFixed(0)}% body<${(bt*100).toFixed(0)}%: WR=${(res.wr*100).toFixed(1)}% n=${res.n} tpd=${res.tpd.toFixed(2)} ${emoji}${tpdWarn}`);
        if (res.wr >= 0.75 && res.n >= 10 && res.tpd >= 0.33) winners.push({ label: `G_${coin}_wick>${wt}_body<${bt}_BB22`, ...res });
      }
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

console.log('\n=== Near misses (WR>=70%, n>=10, any tpd) ===');
// We'll just note from the output above

db.close();
