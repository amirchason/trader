/**
 * Session 15: HIGH VOLUME + HIGH WR (5+/day AND >75% WR, aim for 85%)
 *
 * User mandate: minimum 1 trade per 3 days, aim for 5+ trades/day, >75% WR, prefer 85%
 *
 * Key insight from sessions 13-14:
 *   - High WR strategies have very few trades (BTC=85.7% but only n=32 = ~0.5/day)
 *   - Need to find the sweet spot: enough trades AND >75% WR
 *
 * Hypotheses to test:
 *   A. ALL_HOURS + tight thresholds → more signals, but does WR hold?
 *   B. BB(20,1.8) + strict ADX<20 + RSI extremes → more triggers from tighter band
 *   C. RSI3>90 (vs 93) + MFI70 → lower threshold = more trades while still very selective
 *   D. Multi-condition BUT all-hours → remove time filter, compensate with indicator strength
 *   E. Relaxed good-hours (6+ hours) + same indicator stack → more time coverage
 *   F. BB(20,1.0) + ADX<20 + RSI73+MFI72 → ultra-tight band × quality filters
 *   G. RSI extremes cascade: RSI3>90 + RSI7>72 (vs RSI5>82) → more volume
 *   H. 8h good-hours window × CRSI>80 (vs 85) → volume × quality balance
 *   I. ETH-specific: ETH good hours × BB22 × RSI73 × MFI70 → ETH >75%?
 *   J. BB(20,2.0) all-hours + ADX<20 + RSI75+MFI73 → remove time constraint
 */

const fs = require('fs');
const path = require('path');

// ─── Load OHLCV Data ──────────────────────────────────────────────────────────
function loadCandles(symbol) {
  const dbPath = path.join(__dirname, '../../trader.db');
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(
    `SELECT open_time as t, open, high, low, close, volume
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol);
  db.close();
  return rows.map(r => ({ t: r.t, open: +r.open, high: +r.high, low: +r.low, close: +r.close, volume: +r.volume }));
}

// ─── Indicator Helpers ────────────────────────────────────────────────────────
function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += arr[j];
    out[i] = s / n;
  }
  return out;
}

function stdSeries(arr, sma, n) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (arr[j] - sma[i]) ** 2;
    out[i] = Math.sqrt(v / n);
  }
  return out;
}

function rsiSeries(closes, n) {
  const out = new Array(closes.length).fill(50);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += -d;
  }
  avgGain /= n; avgLoss /= n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(0, d)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(0, -d)) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function mfiSeries(candles, n) {
  const out = new Array(candles.length).fill(50);
  for (let i = n; i < candles.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const tpPrev = (candles[j - 1].high + candles[j - 1].low + candles[j - 1].close) / 3;
      const flow = tp * candles[j].volume;
      if (tp > tpPrev) posFlow += flow; else negFlow += flow;
    }
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return out;
}

function adxSeries(candles, n) {
  const out = new Array(candles.length).fill(25);
  const tr = new Array(candles.length).fill(0);
  const dmPlus = new Array(candles.length).fill(0);
  const dmMinus = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    dmPlus[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    dmMinus[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }
  let atr = 0, diP = 0, diM = 0;
  for (let i = 1; i <= n; i++) { atr += tr[i]; diP += dmPlus[i]; diM += dmMinus[i]; }
  const dxArr = [];
  for (let i = n + 1; i < candles.length; i++) {
    atr = atr - atr / n + tr[i];
    diP = diP - diP / n + dmPlus[i];
    diM = diM - diM / n + dmMinus[i];
    const diPct = atr > 0 ? diP / atr * 100 : 0;
    const diMct = atr > 0 ? diM / atr * 100 : 0;
    const dx = (diPct + diMct) > 0 ? Math.abs(diPct - diMct) / (diPct + diMct) * 100 : 0;
    dxArr.push(dx);
    if (dxArr.length >= n) {
      const adxVal = dxArr.slice(-n).reduce((a, b) => a + b, 0) / n;
      out[i] = adxVal;
    }
  }
  return out;
}

function wprSeries(candles, n) {
  const out = new Array(candles.length).fill(-50);
  for (let i = n - 1; i < candles.length; i++) {
    const slice = candles.slice(i - n + 1, i + 1);
    const hi = Math.max(...slice.map(c => c.high));
    const lo = Math.min(...slice.map(c => c.low));
    out[i] = hi === lo ? -50 : -100 * (hi - candles[i].close) / (hi - lo);
  }
  return out;
}

function crsiSeries(closes, n = 100) {
  const rsi3 = rsiSeries(closes, 3);
  // Streak RSI
  const streaks = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) streaks[i] = (streaks[i - 1] > 0 ? streaks[i - 1] : 0) + 1;
    else if (closes[i] < closes[i - 1]) streaks[i] = (streaks[i - 1] < 0 ? streaks[i - 1] : 0) - 1;
    else streaks[i] = 0;
  }
  const streakRsi = rsiSeries(streaks.map(s => s === 0 ? 0.001 : s), 2);
  // Percentile rank
  const out = new Array(closes.length).fill(50);
  for (let i = n; i < closes.length; i++) {
    const window = closes.slice(i - n, i);
    const rank = window.filter(v => v < closes[i]).length / n * 100;
    out[i] = (rsi3[i] + streakRsi[i] + rank) / 3;
  }
  return out;
}

function stochRsiKD(closes, rsiPeriod = 14, stochPeriod = 14, smoothK = 3, smoothD = 3) {
  const rsi = rsiSeries(closes, rsiPeriod);
  const rawK = new Array(closes.length).fill(50);
  for (let i = stochPeriod + rsiPeriod - 1; i < closes.length; i++) {
    const win = rsi.slice(i - stochPeriod + 1, i + 1);
    const lo = Math.min(...win), hi = Math.max(...win);
    rawK[i] = hi === lo ? 50 : (rsi[i] - lo) / (hi - lo) * 100;
  }
  const K = smaSeries(rawK, smoothK);
  const D = smaSeries(K, smoothD);
  return { K, D };
}

function getHourUTC(ts) { return new Date(ts).getUTCHours(); }

// ─── Walk-Forward Validation ──────────────────────────────────────────────────
function walkForward(candles, signalFn, nFolds = 5) {
  const n = candles.length;
  const foldSize = Math.floor(n / nFolds);
  const wrs = [];

  for (let fold = 0; fold < nFolds; fold++) {
    const start = fold * foldSize;
    const end = fold === nFolds - 1 ? n : (fold + 1) * foldSize;
    const foldCandles = candles.slice(start, end);

    // Precompute all series for this fold
    const closes = foldCandles.map(c => c.close);
    const sma20 = smaSeries(closes, 20);
    const std20 = stdSeries(closes, sma20, 20);

    // BB bands (multiple multipliers)
    const bb10Up = sma20.map((s, i) => s + 1.0 * std20[i]);
    const bb10Lo = sma20.map((s, i) => s - 1.0 * std20[i]);
    const bb18Up = sma20.map((s, i) => s + 1.8 * std20[i]);
    const bb18Lo = sma20.map((s, i) => s - 1.8 * std20[i]);
    const bb20Up = sma20.map((s, i) => s + 2.0 * std20[i]);
    const bb20Lo = sma20.map((s, i) => s - 2.0 * std20[i]);
    const bb22Up = sma20.map((s, i) => s + 2.2 * std20[i]);
    const bb22Lo = sma20.map((s, i) => s - 2.2 * std20[i]);

    const rsi3 = rsiSeries(closes, 3);
    const rsi5 = rsiSeries(closes, 5);
    const rsi7 = rsiSeries(closes, 7);
    const rsi14 = rsiSeries(closes, 14);
    const mfi14 = mfiSeries(foldCandles, 14);
    const adx14 = adxSeries(foldCandles, 14);
    const wpr14 = wprSeries(foldCandles, 14);
    const crsi = crsiSeries(closes, 100);
    const { K: stochK, D: stochD } = stochRsiKD(closes);

    let wins = 0, total = 0;
    for (let i = 110; i < foldCandles.length - 1; i++) {
      const signal = signalFn(foldCandles, i, {
        closes, sma20, std20,
        bb10Up, bb10Lo, bb18Up, bb18Lo, bb20Up, bb20Lo, bb22Up, bb22Lo,
        rsi3, rsi5, rsi7, rsi14, mfi14, adx14, wpr14, crsi, stochK, stochD,
      });
      if (!signal) continue;

      // Fixed-expiry binary: close at EXACTLY next candle
      const entry = foldCandles[i].close;
      const exit = foldCandles[i + 1].close;
      const win = signal === 'BEAR' ? exit < entry : exit > entry;
      if (win) wins++;
      total++;
    }
    if (total >= 5) wrs.push({ wr: wins / total, n: total });
  }

  if (wrs.length < 3) return { wr: 0, n: 0, folds: wrs.length };
  wrs.sort((a, b) => a.wr - b.wr);
  const mid = wrs[Math.floor(wrs.length / 2)];
  const totalN = wrs.reduce((s, f) => s + f.n, 0);
  return { wr: mid.wr, n: totalN, folds: wrs.length };
}

// ─── Run All Coins ────────────────────────────────────────────────────────────
const COINS = {
  ETH: { symbol: 'ETH', gh: new Set([10, 11, 12, 21]) },
  BTC: { symbol: 'BTC', gh: new Set([1, 12, 13, 16, 20]) },
  SOL: { symbol: 'SOL', gh: new Set([0, 12, 13, 20]) },
  XRP: { symbol: 'XRP', gh: new Set([6, 9, 12, 18]) },
};

// Extended good hours — 6+ hours per day
const EXTENDED_GH = {
  ETH: new Set([9, 10, 11, 12, 20, 21]),
  BTC: new Set([1, 5, 12, 13, 16, 20]),
  SOL: new Set([0, 8, 12, 13, 20, 22]),
  XRP: new Set([6, 9, 12, 13, 18, 20]),
};

// All hours
const ALL_GH = new Set([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]);

function test(name, fn, results) {
  const lines = [];
  let anyGood = false;
  for (const [coin, cfg] of Object.entries(COINS)) {
    try {
      const candles = loadCandles(cfg.symbol);
      if (candles.length < 500) { lines.push(`  ${coin}: insufficient data`); continue; }
      const r = walkForward(candles, (c, i, s) => fn(c, i, s, cfg.gh, EXTENDED_GH[coin]));
      const tpd = (r.n / (candles.length * 5 / (288))).toFixed(1); // approx trades/day
      const tradesPerDay = r.n / (candles.length / 288); // candles / (288 candles/day)
      const flag = r.wr >= 0.75 && tradesPerDay >= 5 ? '🔥🔥🔥 HIGH-VOL >75%!' :
                   r.wr >= 0.85 ? '🔥🔥🔥🔥 85%+!' :
                   r.wr >= 0.75 ? '🔥🔥🔥 >75%!' :
                   tradesPerDay >= 5 && r.wr >= 0.68 ? '✅ HIGH-VOL' :
                   r.wr >= 0.70 ? '🔥' : '';
      if (r.wr >= 0.75 && tradesPerDay >= 1) anyGood = true;
      lines.push(`  ${coin}: WR=${(r.wr*100).toFixed(1)}% n=${r.n} tpd=${tradesPerDay.toFixed(1)} ${flag}`);
    } catch (e) {
      lines.push(`  ${coin}: ERROR ${e.message}`);
    }
  }
  if (anyGood || lines.some(l => l.includes('HIGH-VOL'))) {
    console.log(`\n${name}`);
    lines.forEach(l => console.log(l));
    results.push({ name, lines });
  } else {
    // Show anyway if any coin had WR≥70%
    const hasGood = lines.some(l => parseFloat(l.match(/WR=(\d+\.\d+)/)?.[1] || '0') >= 70.0);
    if (hasGood) {
      console.log(`\n${name}`);
      lines.forEach(l => console.log(l));
    }
  }
}

const results = [];
console.log('=== Session 15: High-Volume + High-WR Research ===');
console.log('Target: 5+ trades/day AND >75% WR (prefer 85%)');
console.log('='.repeat(60));

// ─── SECTION A: All-Hours + Tight Thresholds ──────────────────────────────────
// Hypothesis: remove time filter, compensate with stricter indicators
console.log('\n\n── SECTION A: All-Hours × Tight Oscillators ──');

test('A1_ALL+ADX20+RSI3>93+RSI5>82+MFI70+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20 || isNaN(s.crsi[i])) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.rsi5[i] > 82 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.rsi5[i] < 18 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('A2_ALL+ADX20+RSI3>90+RSI5>80+MFI70+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 90 && s.rsi5[i] > 80 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 10 && s.rsi5[i] < 20 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('A3_ALL+ADX20+RSI3>90+RSI7>72+MFI72+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 90 && s.rsi7[i] > 72 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 10 && s.rsi7[i] < 28 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('A4_ALL+ADX20+RSI3>93+MFI72+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('A5_ALL+ADX20+CRSI>85+MFI72+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.crsi[i] > 85 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.crsi[i] < 15 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('A6_ALL+ADX20+CRSI>80+MFI70+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.crsi[i] > 80 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.crsi[i] < 20 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('A7_ALL+ADX20+WPR>-8+RSI73+MFI72+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.wpr14[i] > -8 && s.rsi7[i] > 73 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.wpr14[i] < -92 && s.rsi7[i] < 27 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('A8_ALL+ADX20+BB20_2.0+RSI73+MFI72+RSI14', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb20Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb20Lo[i]) return 'BULL';
  return null;
}, results);

// ─── SECTION B: BB(20,1.8) + ADX<20 + Quality ────────────────────────────────
// Tight band triggers more → does WR hold with ADX+oscillator filters?
console.log('\n\n── SECTION B: BB(20,1.8) × ADX<20 × Quality ──');

test('B1_GH+ADX20+RSI7>73+MFI72+BB18', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.mfi14[i] > 72 && cl > s.bb18Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.mfi14[i] < 28 && cl < s.bb18Lo[i]) return 'BULL';
  return null;
}, results);

test('B2_GH+ADX20+RSI73+MFI72+RSI14+BB18', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb18Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb18Lo[i]) return 'BULL';
  return null;
}, results);

test('B3_GH+ADX20+RSI3>90+MFI70+BB18', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 90 && s.mfi14[i] > 70 && cl > s.bb18Up[i]) return 'BEAR';
  if (s.rsi3[i] < 10 && s.mfi14[i] < 30 && cl < s.bb18Lo[i]) return 'BULL';
  return null;
}, results);

test('B4_GH+ADX20+RSI3>90+RSI7>70+MFI70+BB18', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 90 && s.rsi7[i] > 70 && s.mfi14[i] > 70 && cl > s.bb18Up[i]) return 'BEAR';
  if (s.rsi3[i] < 10 && s.rsi7[i] < 30 && s.mfi14[i] < 30 && cl < s.bb18Lo[i]) return 'BULL';
  return null;
}, results);

test('B5_GH+ADX20+CRSI>82+RSI7>68+MFI70+BB18', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.crsi[i] > 82 && s.rsi7[i] > 68 && s.mfi14[i] > 70 && cl > s.bb18Up[i]) return 'BEAR';
  if (s.crsi[i] < 18 && s.rsi7[i] < 32 && s.mfi14[i] < 30 && cl < s.bb18Lo[i]) return 'BULL';
  return null;
}, results);

test('B6_ALL+ADX20+RSI7>73+MFI72+BB18', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.mfi14[i] > 72 && cl > s.bb18Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.mfi14[i] < 28 && cl < s.bb18Lo[i]) return 'BULL';
  return null;
}, results);

test('B7_ALL+ADX20+RSI73+MFI72+RSI14+BB18', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb18Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb18Lo[i]) return 'BULL';
  return null;
}, results);

// ─── SECTION C: Extended Good Hours (6+/day) ──────────────────────────────────
console.log('\n\n── SECTION C: Extended Good Hours (6h/day) × Quality ──');

test('C1_ExtGH+ADX20+RSI73+MFI72+RSI14+BB22', (c, i, s, gh, extGh) => {
  if (!extGh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('C2_ExtGH+ADX20+RSI3>93+RSI5>82+MFI70+BB22', (c, i, s, gh, extGh) => {
  if (!extGh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.rsi5[i] > 82 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.rsi5[i] < 18 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('C3_ExtGH+ADX20+CRSI>85+MFI72+BB22', (c, i, s, gh, extGh) => {
  if (!extGh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.crsi[i] > 85 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.crsi[i] < 15 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('C4_ExtGH+ADX20+WPR>-8+RSI73+MFI72+BB22', (c, i, s, gh, extGh) => {
  if (!extGh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.wpr14[i] > -8 && s.rsi7[i] > 73 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.wpr14[i] < -92 && s.rsi7[i] < 27 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('C5_ExtGH+ADX20+RSI3>90+RSI5>80+MFI70+BB22', (c, i, s, gh, extGh) => {
  if (!extGh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 90 && s.rsi5[i] > 80 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 10 && s.rsi5[i] < 20 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

// ─── SECTION D: BB(20,1.0) + ADX<20 (ultra-tight + ranging) ──────────────────
// BB(1.0) is very tight → many triggers, but ADX<20 + quality filters needed
console.log('\n\n── SECTION D: BB(20,1.0) × ADX<20 × Quality ──');

test('D1_GH+ADX20+RSI7>73+MFI72+BB10', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.mfi14[i] > 72 && cl > s.bb10Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.mfi14[i] < 28 && cl < s.bb10Lo[i]) return 'BULL';
  return null;
}, results);

test('D2_GH+ADX20+RSI7>75+MFI74+BB10', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 75 && s.mfi14[i] > 74 && cl > s.bb10Up[i]) return 'BEAR';
  if (s.rsi7[i] < 25 && s.mfi14[i] < 26 && cl < s.bb10Lo[i]) return 'BULL';
  return null;
}, results);

test('D3_GH+ADX20+RSI73+MFI72+RSI14+BB10', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb10Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb10Lo[i]) return 'BULL';
  return null;
}, results);

test('D4_GH+ADX20+RSI3>90+MFI72+BB10', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 90 && s.mfi14[i] > 72 && cl > s.bb10Up[i]) return 'BEAR';
  if (s.rsi3[i] < 10 && s.mfi14[i] < 28 && cl < s.bb10Lo[i]) return 'BULL';
  return null;
}, results);

test('D5_GH+ADX20+RSI3>93+RSI7>68+BB10', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.rsi7[i] > 68 && cl > s.bb10Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.rsi7[i] < 32 && cl < s.bb10Lo[i]) return 'BULL';
  return null;
}, results);

test('D6_ALL+ADX20+RSI7>75+MFI74+BB10', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 75 && s.mfi14[i] > 74 && cl > s.bb10Up[i]) return 'BEAR';
  if (s.rsi7[i] < 25 && s.mfi14[i] < 26 && cl < s.bb10Lo[i]) return 'BULL';
  return null;
}, results);

test('D7_ALL+ADX20+RSI73+MFI72+RSI14+BB10', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb10Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb10Lo[i]) return 'BULL';
  return null;
}, results);

// ─── SECTION E: StochRSI + ADX<20 ────────────────────────────────────────────
console.log('\n\n── SECTION E: StochRSI K+D extreme × ADX<20 × BB ──');

test('E1_GH+ADX20+StochK>85+D>80+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.stochK[i] > 85 && s.stochD[i] > 80 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.stochK[i] < 15 && s.stochD[i] < 20 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('E2_GH+ADX20+StochK>90+D>85+MFI72+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.stochK[i] > 90 && s.stochD[i] > 85 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.stochK[i] < 10 && s.stochD[i] < 15 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('E3_GH+ADX20+StochK>80+RSI7>70+MFI70+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.stochK[i] > 80 && s.rsi7[i] > 70 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.stochK[i] < 20 && s.rsi7[i] < 30 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('E4_ALL+ADX20+StochK>85+D>80+RSI7>70+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.stochK[i] > 85 && s.stochD[i] > 80 && s.rsi7[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.stochK[i] < 15 && s.stochD[i] < 20 && s.rsi7[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

// ─── SECTION F: ETH-Specific (target ETH >75% WR) ───────────────────────────
// ETH has consistently been ~66-71% — try ETH-specific optimizations
console.log('\n\n── SECTION F: ETH-Specific Optimization ──');
const ETH_ONLY = { ETH: COINS.ETH };

function testETH(name, fn, results) {
  const coin = 'ETH';
  const cfg = COINS[coin];
  try {
    const candles = loadCandles(cfg.symbol);
    const r = walkForward(candles, (c, i, s) => fn(c, i, s, cfg.gh, EXTENDED_GH[coin]));
    const tradesPerDay = r.n / (candles.length / 288);
    const flag = r.wr >= 0.75 && tradesPerDay >= 1 ? '🔥🔥🔥 ETH >75%!!!' :
                 r.wr >= 0.75 ? '🔥🔥🔥 ETH >75%!' :
                 r.wr >= 0.70 ? '🔥🔥 ETH >70%' :
                 r.wr >= 0.65 ? '🔥' : '';
    if (r.wr >= 0.65) {
      console.log(`\n${name}`);
      console.log(`  ETH: WR=${(r.wr*100).toFixed(1)}% n=${r.n} tpd=${tradesPerDay.toFixed(1)} ${flag}`);
      results.push({ name, lines: [`  ETH: WR=${(r.wr*100).toFixed(1)}% n=${r.n} tpd=${tradesPerDay.toFixed(1)} ${flag}`] });
    }
  } catch (e) {
    console.log(`  ETH ERROR: ${e.message}`);
  }
}

testETH('F1_ETH_H12only+ADX20+RSI73+MFI72+RSI14+BB22', (c, i, s, gh) => {
  const h = getHourUTC(c[i].t);
  if (h !== 12 || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

testETH('F2_ETH_GH+ADX20+RSI7>75+MFI74+RSI14>70+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 75 && s.rsi14[i] > 70 && s.mfi14[i] > 74 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 25 && s.rsi14[i] < 30 && s.mfi14[i] < 26 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

testETH('F3_ETH_GH+ADX20+RSI3>93+RSI5>82+MFI70+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.rsi5[i] > 82 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.rsi5[i] < 18 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

testETH('F4_ETH_GH+ADX20+CRSI>85+RSI7>70+MFI72+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.crsi[i] > 85 && s.rsi7[i] > 70 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.crsi[i] < 15 && s.rsi7[i] < 30 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

testETH('F5_ETH_H[10,12,21]+ADX20+RSI73+MFI72+RSI14+BB22', (c, i, s) => {
  const h = getHourUTC(c[i].t);
  if (![10, 12, 21].includes(h) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

testETH('F6_ETH_H[12,21]+ADX20+RSI7>70+MFI70+BB22', (c, i, s) => {
  const h = getHourUTC(c[i].t);
  if (![12, 21].includes(h) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 70 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 30 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

testETH('F7_ETH_ALL+ADX20+RSI3>93+RSI5>82+MFI70+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.rsi5[i] > 82 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.rsi5[i] < 18 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

testETH('F8_ETH_GH+ADX20+StochK>85+D>80+MFI72+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.stochK[i] > 85 && s.stochD[i] > 80 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.stochK[i] < 15 && s.stochD[i] < 20 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

// ─── SECTION G: High Volume Target — ADX<25, looser filters, bigger coverage ─
console.log('\n\n── SECTION G: High-Volume × Moderate WR (aim >68% at 10+/day) ──');

test('G1_ALL+ADX25+RSI7>75+MFI74+BB22', (c, i, s) => {
  if (s.adx14[i] >= 25) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 75 && s.mfi14[i] > 74 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 25 && s.mfi14[i] < 26 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('G2_ALL+ADX25+RSI73+MFI72+RSI14+BB22', (c, i, s) => {
  if (s.adx14[i] >= 25) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('G3_GH+ADX25+RSI3>93+RSI5>82+MFI70+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 25) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.rsi5[i] > 82 && s.mfi14[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.rsi5[i] < 18 && s.mfi14[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('G4_ALL+ADX20+RSI7>70+MFI70+BB20', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 70 && s.mfi14[i] > 70 && cl > s.bb20Up[i]) return 'BEAR';
  if (s.rsi7[i] < 30 && s.mfi14[i] < 30 && cl < s.bb20Lo[i]) return 'BULL';
  return null;
}, results);

test('G5_GH+ADX25+RSI73+MFI72+RSI14+BB22', (c, i, s, gh) => {
  if (!gh.has(getHourUTC(c[i].t)) || s.adx14[i] >= 25) return null;
  const cl = c[i].close;
  if (s.rsi7[i] > 73 && s.rsi14[i] > 68 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi7[i] < 27 && s.rsi14[i] < 32 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

// ─── SECTION H: All-hours + CRSI/WPR at lower thresholds ─────────────────────
console.log('\n\n── SECTION H: All-Hours × CRSI/WPR Cascades ──');

test('H1_ALL+ADX20+CRSI>85+RSI7>70+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.crsi[i] > 85 && s.rsi7[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.crsi[i] < 15 && s.rsi7[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('H2_ALL+ADX20+CRSI>82+MFI72+RSI7>70+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.crsi[i] > 82 && s.mfi14[i] > 72 && s.rsi7[i] > 70 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.crsi[i] < 18 && s.mfi14[i] < 28 && s.rsi7[i] < 30 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('H3_ALL+ADX20+WPR>-10+RSI7>72+MFI72+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.wpr14[i] > -10 && s.rsi7[i] > 72 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.wpr14[i] < -90 && s.rsi7[i] < 28 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('H4_ALL+ADX20+WPR>-5+RSI7>73+MFI72+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.wpr14[i] > -5 && s.rsi7[i] > 73 && s.mfi14[i] > 72 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.wpr14[i] < -95 && s.rsi7[i] < 27 && s.mfi14[i] < 28 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

test('H5_ALL+ADX20+RSI3>93+CRSI>80+BB22', (c, i, s) => {
  if (s.adx14[i] >= 20) return null;
  const cl = c[i].close;
  if (s.rsi3[i] > 93 && s.crsi[i] > 80 && cl > s.bb22Up[i]) return 'BEAR';
  if (s.rsi3[i] < 7 && s.crsi[i] < 20 && cl < s.bb22Lo[i]) return 'BULL';
  return null;
}, results);

// ─── Print Summary ─────────────────────────────────────────────────────────────
console.log('\n\n' + '='.repeat(60));
console.log('=== SUMMARY: Results with WR ≥ 70% ===');
console.log('='.repeat(60));

for (const r of results) {
  const highWr = r.lines.filter(l => {
    const m = l.match(/WR=(\d+\.\d+)%/);
    return m && parseFloat(m[1]) >= 70.0;
  });
  if (highWr.length > 0) {
    console.log(`\n${r.name}`);
    highWr.forEach(l => console.log(l));
  }
}

console.log('\n\n=== HIGH-VOLUME + HIGH-WR WINNERS (tpd>=3 AND WR>=75%) ===');
for (const r of results) {
  const hvhw = r.lines.filter(l => {
    const wrM = l.match(/WR=(\d+\.\d+)%/);
    const tpdM = l.match(/tpd=(\d+\.\d+)/);
    return wrM && tpdM && parseFloat(wrM[1]) >= 75.0 && parseFloat(tpdM[1]) >= 3.0;
  });
  if (hvhw.length > 0) {
    console.log(`\n${r.name}`);
    hvhw.forEach(l => console.log(l));
  }
}
