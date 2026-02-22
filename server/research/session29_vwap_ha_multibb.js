/**
 * Session 29: VWAP deviation (extended), Heikin Ashi, multi-BB, fractals
 *
 * Context: Strat 121 (BTC VWAP_dev>0.3%+RSI3>90+BB22 = 72.2% WR n=22) was the
 * last implemented strategy. VWAP for other coins and looser combos not fully tested.
 *
 * New angles:
 * A. VWAP deviation expanded — ETH/SOL/XRP, lower thresholds, GH combinations
 * B. Heikin Ashi at BB extreme — HA candles smooth noise; HA close at BB = cleaner signal
 * C. Multi-BB confirmation — both BB(20,2.2) AND BB(14,2.0) fired simultaneously
 * D. Fractal top pattern — high with 2 lower highs on each side (5-bar fractal)
 * E. VWAP + volume spike — large deviation from VWAP AND volume spike
 * F. VWAP crossing — price just crossed ABOVE VWAP, now at BB extreme (fresh move)
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

function calcADX(candles, idx, period=14) {
  if (idx < period * 2) return 50;
  let dp = 0, dm = 0, tr = 0;
  for (let i = idx - period; i < idx; i++) {
    const t = Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i-1].c), Math.abs(candles[i].l - candles[i-1].c));
    const dH = candles[i].h - candles[i-1].h;
    const dL = candles[i-1].l - candles[i].l;
    dp += (dH > dL && dH > 0) ? dH : 0;
    dm += (dL > dH && dL > 0) ? dL : 0;
    tr += t;
  }
  if (tr === 0) return 50;
  const s = ((dp/tr) + (dm/tr)) * 100;
  return s === 0 ? 0 : Math.abs((dp - dm) / tr) * 100 / (s / 100);
}

// UTC-midnight intraday VWAP
function calcDayVWAP(candles, idx) {
  const t0 = candles[idx].t;
  const utcDay = Math.floor(t0 / (1000 * 86400)) * (1000 * 86400);
  let tpvSum = 0, volSum = 0;
  for (let i = idx; i >= 0; i--) {
    if (candles[i].t < utcDay) break;
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    tpvSum += tp * candles[i].v;
    volSum += candles[i].v;
  }
  if (volSum === 0) return candles[idx].c;
  return tpvSum / volSum;
}

// Heikin Ashi close = (open + high + low + close) / 4
// Heikin Ashi open = (prevHA_open + prevHA_close) / 2
// We build HA array from raw candles
function buildHeikinAshi(candles) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const haClose = (candles[i].o + candles[i].h + candles[i].l + candles[i].c) / 4;
    const haOpen = i === 0
      ? (candles[i].o + candles[i].c) / 2
      : (ha[i-1].o + ha[i-1].c) / 2;
    const haHigh = Math.max(candles[i].h, haOpen, haClose);
    const haLow = Math.min(candles[i].l, haOpen, haClose);
    ha.push({ t: candles[i].t, o: haOpen, h: haHigh, l: haLow, c: haClose, v: candles[i].v });
  }
  return ha;
}

function getOutcome(candles, i, dir) {
  if (i + 1 >= candles.length) return null;
  const entry = candles[i].c, exit = candles[i+1].c;
  if (dir === 'DOWN') return exit < entry ? 1 : 0;
  return exit > entry ? 1 : 0;
}

function backtest(candles, filterFn, direction) {
  let wins = 0, total = 0;
  for (let i = 50; i < candles.length - 1; i++) {
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

console.log('Loading candles...');
const ALL = {};
const ALL_HA = {};
for (const c of COINS) {
  ALL[c] = getCandles(c);
  ALL_HA[c] = buildHeikinAshi(ALL[c]);
  console.log(`  ${c}: ${ALL[c].length} candles (${Math.floor(ALL[c].length * 5 / 1440)} days)`);
}

const winners = [];

// =============================================
// Section A: VWAP deviation expanded
// Strat121 = BTC VWAP_dev>0.3%+RSI3>90+BB22 = 72.2% WR n=22 tpd=0.12
// Try: looser RSI3, different coins, GH filter, RSI7 instead of RSI3
// =============================================
console.log('\n== Section A: VWAP deviation expanded ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // A1: VWAP dev>0.2% + RSI7>70 + BB22 (looser than strat121, uses RSI7 not RSI3)
  fmt(`A1_${coin}_VWAPdev0.2_RSI7>70_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 70) return false;
    const vwap = calcDayVWAP(c, i);
    return (c[i].c - vwap) / vwap * 100 > 0.2;
  }, 'DOWN'), winners);

  // A2: VWAP dev>0.3% + RSI7>68 + BB22 + GH
  fmt(`A2_${coin}_VWAPdev0.3_RSI7>68_GH_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 68) return false;
    const vwap = calcDayVWAP(c, i);
    return (c[i].c - vwap) / vwap * 100 > 0.3;
  }, 'DOWN'), winners);

  // A3: VWAP dev>0.15% + MFI>68 + BB22 + GH (highest volume filter)
  fmt(`A3_${coin}_VWAPdev0.15_MFI68_GH_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const mfi = calcMFI(c, i);
    if (mfi < 68) return false;
    const vwap = calcDayVWAP(c, i);
    return (c[i].c - vwap) / vwap * 100 > 0.15;
  }, 'DOWN'), winners);

  // A4: VWAP dev>0.2% + ADX<20 + RSI7>68 + BB22
  fmt(`A4_${coin}_VWAPdev0.2_ADX20_RSI68_BB22`, coin, backtest(cs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 68) return false;
    if (calcADX(c, i) > 20) return false;
    const vwap = calcDayVWAP(c, i);
    return (c[i].c - vwap) / vwap * 100 > 0.2;
  }, 'DOWN'), winners);

  // A5: VWAP dev sweep
  for (const devThr of [0.10, 0.15, 0.20, 0.25, 0.30, 0.40]) {
    const res = backtest(cs, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c < bb.upper) return false;
      const rsi = calcRSI(c, i);
      if (rsi < 68) return false;
      const vwap = calcDayVWAP(c, i);
      return (c[i].c - vwap) / vwap * 100 > devThr;
    }, 'DOWN');
    if (res && res.wr >= 0.68 && res.n >= 8) {
      fmt(`A5_${coin}_VWAPdev>${devThr}pct_RSI68_BB22`, coin, res, winners);
    }
  }
}

// =============================================
// Section B: Heikin Ashi at BB extreme
// HA candles smooth noise: HA_body direction more reliable than raw candles
// =============================================
console.log('\n== Section B: Heikin Ashi patterns at BB extreme ==\n');

for (const coin of COINS) {
  const rawCs = ALL[coin];
  const ha = ALL_HA[coin];
  const gh = GH[coin];

  // B1: HA bearish (HA close < HA open) + raw price above BB upper + RSI7>68
  fmt(`B1_${coin}_HA_Bear_BB22_RSI68_allH`, coin, backtest(rawCs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return ha[i].c < ha[i].o && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // B2: HA bearish + good hours
  fmt(`B2_${coin}_HA_Bear_BB22_GH`, coin, backtest(rawCs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return ha[i].c < ha[i].o && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // B3: Two consecutive HA bearish candles + BB upper + RSI70
  fmt(`B3_${coin}_2HA_Bear_BB22_RSI70`, coin, backtest(rawCs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return ha[i].c < ha[i].o && ha[i-1].c < ha[i-1].o && calcRSI(c, i) > 70;
  }, 'DOWN'), winners);

  // B4: HA bearish + HA has no lower wick (strong bearish signal) + GH
  fmt(`B4_${coin}_HA_NoLowerWick_GH_BB22`, coin, backtest(rawCs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    // No lower wick = HA close == HA low (strong bearish)
    const noLowerWick = Math.abs(ha[i].c - ha[i].l) < ha[i].c * 0.0001;
    return noLowerWick && ha[i].c < ha[i].o && calcRSI(c, i) > 65;
  }, 'DOWN'), winners);

  // B5: HA bearish + MFI>68 + BB22
  fmt(`B5_${coin}_HA_Bear_MFI68_BB22`, coin, backtest(rawCs, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    return ha[i].c < ha[i].o && calcMFI(c, i) > 68 && calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // B6: HA flip (was bullish, now bearish) at BB upper — confirmation of turn
  fmt(`B6_${coin}_HA_Flip_BB22_allH`, coin, backtest(rawCs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 67) return false;
    // Current HA bearish, previous HA bullish = flip signal
    return ha[i].c < ha[i].o && ha[i-1].c >= ha[i-1].o;
  }, 'DOWN'), winners);
}

// =============================================
// Section C: Multi-BB confirmation
// Both BB(20,2.2) AND BB(14,2.0) triggered simultaneously = double-confirmed extreme
// =============================================
console.log('\n== Section C: Multi-BB double confirmation ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // C1: BB(20,2.2) AND BB(14,2.0) both above upper + RSI7>68 (all hours)
  fmt(`C1_${coin}_BB22+BB14_2.0_RSI68_allH`, coin, backtest(cs, (c, i) => {
    const bb22 = calcBB(c, i, 20, 2.2);
    const bb14 = calcBB(c, i, 14, 2.0);
    if (!bb22 || !bb14) return false;
    if (c[i].c < bb22.upper || c[i].c < bb14.upper) return false;
    return calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // C2: Both BBs triggered + GH
  fmt(`C2_${coin}_BB22+BB14_2.0_GH_RSI68`, coin, backtest(cs, (c, i) => {
    const bb22 = calcBB(c, i, 20, 2.2);
    const bb14 = calcBB(c, i, 14, 2.0);
    if (!bb22 || !bb14) return false;
    if (c[i].c < bb22.upper || c[i].c < bb14.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcRSI(c, i) > 68;
  }, 'DOWN'), winners);

  // C3: BB(20,2.2) AND BB(20,1.5) both above + RSI7>70 + MFI>65
  fmt(`C3_${coin}_BB22+BB15_RSI70_MFI65_allH`, coin, backtest(cs, (c, i) => {
    const bb22 = calcBB(c, i, 20, 2.2);
    const bb15 = calcBB(c, i, 20, 1.5);
    if (!bb22 || !bb15) return false;
    if (c[i].c < bb22.upper || c[i].c < bb15.upper) return false;
    return calcRSI(c, i) > 70 && calcMFI(c, i) > 65;
  }, 'DOWN'), winners);

  // C4: Triple BB confirmation: BB(20,2.2) + BB(14,2.0) + BB(30,2.0) + GH
  fmt(`C4_${coin}_BB22+BB14+BB30_GH`, coin, backtest(cs, (c, i) => {
    const bb22 = calcBB(c, i, 20, 2.2);
    const bb14 = calcBB(c, i, 14, 2.0);
    const bb30 = calcBB(c, i, 30, 2.0);
    if (!bb22 || !bb14 || !bb30) return false;
    if (c[i].c < bb22.upper || c[i].c < bb14.upper || c[i].c < bb30.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    return calcRSI(c, i) > 65;
  }, 'DOWN'), winners);
}

// =============================================
// Section D: Fractal top pattern (5-bar)
// A fractal top = candle[i-2].h is the highest of 5 bars (i-4 to i)
// Price above BB + recent fractal top forming = reversal signal
// =============================================
console.log('\n== Section D: Fractal top pattern at BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // D1: 5-bar fractal top formation beginning (curr is higher than -1, -2 highs)
  fmt(`D1_${coin}_FractalTop_BB22_RSI70`, coin, backtest(cs, (c, i) => {
    if (i < 2) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 70) return false;
    // Current candle's high is lower than previous 2 (fractal top just formed on [i-2])
    // Actually test: current is at the peak (higher than surrounding bars)
    // Simplified: current high > prev 2 highs but RSI starting to fade
    return c[i].h < c[i-1].h && c[i-1].h > c[i-2].h; // [i-1] was fractal top
  }, 'DOWN'), winners);

  // D2: Confirmed fractal top + BB above + GH
  fmt(`D2_${coin}_FractalTop_GH_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 4) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    // Full 5-bar fractal: [i-2].h > all others in [i-4..i]
    const peak = c[i-2].h;
    return peak > c[i-4].h && peak > c[i-3].h && peak > c[i-1].h && peak > c[i].h;
  }, 'DOWN'), winners);

  // D3: Fractal top near BB upper (within 0.1% of BB) + GH + RSI70
  fmt(`D3_${coin}_FractalTop_nearBB_GH_RSI70`, coin, backtest(cs, (c, i) => {
    if (i < 4) return false;
    const bb = calcBB(c, i);
    if (!bb) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 70) return false;
    const peak = c[i-2].h;
    const isFreactal = peak > c[i-4].h && peak > c[i-3].h && peak > c[i-1].h && peak > c[i].h;
    if (!isFreactal) return false;
    // Peak was near BB upper
    return peak >= bb.upper * 0.999;
  }, 'DOWN'), winners);
}

// =============================================
// Section E: VWAP crossing + BB extreme
// Price JUST crossed above VWAP (bullish momentum) while at BB extreme
// = short-term momentum play reversal
// =============================================
console.log('\n== Section E: VWAP fresh cross + BB extreme ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // E1: Prev candle below VWAP, current candle above VWAP AND above BB22 (fresh breakout at extreme)
  fmt(`E1_${coin}_VWAPcross_BB22_allH`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const vwapNow = calcDayVWAP(c, i);
    const vwapPrev = calcDayVWAP(c, i-1);
    return c[i].c > vwapNow && c[i-1].c <= vwapPrev;
  }, 'DOWN'), winners);

  // E2: VWAP cross + RSI7>70 + BB22
  fmt(`E2_${coin}_VWAPcross_RSI70_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 70) return false;
    const vwapNow = calcDayVWAP(c, i);
    const vwapPrev = calcDayVWAP(c, i-1);
    return c[i].c > vwapNow && c[i-1].c <= vwapPrev;
  }, 'DOWN'), winners);

  // E3: VWAP cross + GH + BB22
  fmt(`E3_${coin}_VWAPcross_GH_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 1) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const vwapNow = calcDayVWAP(c, i);
    const vwapPrev = calcDayVWAP(c, i-1);
    return c[i].c > vwapNow && c[i-1].c <= vwapPrev && calcRSI(c, i) > 65;
  }, 'DOWN'), winners);
}

// =============================================
// Section F: VWAP + volume spike combined
// High deviation from VWAP + volume spike = institutional exhaustion
// =============================================
console.log('\n== Section F: VWAP deviation + volume spike ==\n');

for (const coin of COINS) {
  const cs = ALL[coin];
  const gh = GH[coin];

  // F1: VWAP dev>0.15% + vol>1.5x avg + BB22 + RSI68 (institutional push exhaustion)
  fmt(`F1_${coin}_VWAPdev0.15_volSpike_RSI68_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 20) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const rsi = calcRSI(c, i);
    if (rsi < 68) return false;
    const vwap = calcDayVWAP(c, i);
    const dev = (c[i].c - vwap) / vwap * 100;
    if (dev < 0.15) return false;
    const avgVol = cs.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
    return c[i].v > avgVol * 1.5;
  }, 'DOWN'), winners);

  // F2: VWAP dev>0.2% + vol>1.5x + GH + BB22
  fmt(`F2_${coin}_VWAPdev0.2_volSpike_GH_BB22`, coin, backtest(cs, (c, i) => {
    if (i < 20) return false;
    const bb = calcBB(c, i);
    if (!bb || c[i].c < bb.upper) return false;
    const h = new Date(c[i].t).getUTCHours();
    if (!gh.includes(h)) return false;
    const vwap = calcDayVWAP(c, i);
    const dev = (c[i].c - vwap) / vwap * 100;
    if (dev < 0.2) return false;
    const avgVol = cs.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
    return c[i].v > avgVol * 1.5 && calcRSI(c, i) > 65;
  }, 'DOWN'), winners);

  // F3: VWAP dev sweep
  for (const devThr of [0.10, 0.15, 0.20, 0.25]) {
    const res = backtest(cs, (c, i) => {
      if (i < 20) return false;
      const bb = calcBB(c, i);
      if (!bb || c[i].c < bb.upper) return false;
      const h = new Date(c[i].t).getUTCHours();
      if (!gh.includes(h)) return false;
      const vwap = calcDayVWAP(c, i);
      const dev = (c[i].c - vwap) / vwap * 100;
      if (dev < devThr) return false;
      const avgVol = cs.slice(i - 20, i).reduce((s, x) => s + x.v, 0) / 20;
      return c[i].v > avgVol * 1.3 && calcRSI(c, i) > 67;
    }, 'DOWN');
    if (res && res.wr >= 0.68 && res.n >= 8) {
      fmt(`F3_${coin}_VWAPdev>${devThr}_vol1.3x_RSI67_GH`, coin, res, winners);
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

db.close();
