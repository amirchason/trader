/**
 * Session 34: Proper out-of-sample validation of day×hour combos
 *
 * Session 33 found strong day×hour results (76-83% WR) but potential overfitting:
 * combos were selected on the SAME data used for walk-forward validation.
 *
 * This session uses TRUE out-of-sample methodology:
 * - TRAIN: first 92 days (candles[0..52992/2])
 * - TEST:  last 92 days (candles[52992/2..end])
 *
 * Approach:
 * A. Train on first half → find top (weekday, hour) combos per coin
 *    → apply to second half → if WR still >=75% & n>=5, genuine signal
 * B. Validate BTC h9 (strat 126): does it hold up in OOS half?
 * C. Test "ANY good day×hour" as a combined good-hours mask applied OOS
 * D. Find per-coin optimal single new hours (not day-specific) from first half
 *    → validate in second half
 * E. NEW: hour × MFI threshold grid trained on first half, tested on second
 *
 * Exit model: CORRECT fixed-expiry binary (next candle close)
 * OOS threshold: WR >= 75%, n >= 5 (smaller due to half-dataset)
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

function calcADX(candles, idx, period = 14) {
  if (idx < period * 2) return 50;
  const trueRanges = [], plusDMs = [], minusDMs = [];
  for (let i = idx - period * 2 + 1; i <= idx; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    trueRanges.push(tr);
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDI = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  const dxArr = [];
  for (let i = period; i < period * 2; i++) {
    atr = atr - atr / period + trueRanges[i];
    plusDI = plusDI - plusDI / period + plusDMs[i];
    minusDI = minusDI - minusDI / period + minusDMs[i];
    const di_sum = (plusDI + minusDI) / atr;
    if (di_sum === 0) { dxArr.push(0); continue; }
    dxArr.push(Math.abs((plusDI - minusDI) / atr) / di_sum * 100);
  }
  return dxArr.reduce((a, b) => a + b, 0) / dxArr.length;
}

// Simple backtest on a candle slice
function backtest(slice, signal_fn, startIdx = 30) {
  let wins = 0, trades = 0;
  for (let i = startIdx; i < slice.length - 1; i++) {
    if (signal_fn(slice, i)) {
      trades++;
      if (slice[i + 1].c < slice[i].c) wins++;
    }
  }
  return { wins, trades, wr: trades > 0 ? wins / trades : 0, n: trades };
}

const GOOD_HOURS = {
  ETH: new Set([10, 11, 12, 21]),
  BTC: new Set([1, 9, 12, 13, 16, 20]), // 9 added by strat 126
  SOL: new Set([0, 12, 13, 20]),
  XRP: new Set([6, 9, 12, 18])
};

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const allCandles = {};
for (const coin of COINS) allCandles[coin] = getCandles(coin);

const winners = [];
const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ═══════════════════════════════════════════════════════
// SECTION A: True OOS validation of day×hour combos
// Train: first half → select top (dow, h) combos
// Test: second half → apply those combos
// ═══════════════════════════════════════════════════════
console.log('\n== Section A: OOS day×hour combo validation ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const half = Math.floor(candles.length / 2);
  const train = candles.slice(0, half);
  const test = candles.slice(half);

  // Find top combos in TRAINING data
  const trainResults = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      const r = backtest(train, (c, i) => {
        const bb = calcBB(c, i);
        if (!bb || c[i].c <= bb.upper) return false;
        const d = new Date(c[i].t);
        return d.getUTCDay() === dow && d.getUTCHours() === h && calcRSI(c, i, 7) > 70;
      });
      if (r.n >= 5) trainResults.push({ dow, h, ...r });
    }
  }
  trainResults.sort((a, b) => b.wr - a.wr);
  const topTrain = trainResults.slice(0, 6);

  console.log(`  ${coin} — top train combos → OOS validation:`);
  let oosTotalWins = 0, oosTotalTrades = 0;
  const goodSet = new Set(topTrain.map(c => `${c.dow}_${c.h}`));

  for (const combo of topTrain) {
    // Apply to TEST data
    const oosR = backtest(test, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      const d = new Date(c[i].t);
      return d.getUTCDay() === combo.dow && d.getUTCHours() === combo.h && calcRSI(c, i, 7) > 70;
    });
    const trainWR = (combo.wr * 100).toFixed(1);
    const oosWR = oosR.n > 0 ? (oosR.wr * 100).toFixed(1) : 'n/a';
    const flag = oosR.n >= 5 && oosR.wr >= 0.75 ? ' ✅' : oosR.n >= 5 && oosR.wr >= 0.65 ? ' 🔥' : '';
    console.log(`    ${dayNames[combo.dow]} h${combo.h}: train=${trainWR}% n=${combo.n} | OOS=${oosWR}% n=${oosR.n}${flag}`);
    oosTotalWins += oosR.wins;
    oosTotalTrades += oosR.trades;
  }

  // Combined OOS result
  const oosPoolWR = oosTotalTrades > 0 ? oosTotalWins / oosTotalTrades : 0;
  const oosDays = test.length * 5 / 60 / 24;
  const oosTPD = oosTotalTrades / oosDays;
  const flag = oosPoolWR >= 0.75 && oosTotalTrades >= 10 && oosTPD >= 0.33 ? ' 🏆🏆🏆' : oosPoolWR >= 0.70 ? ' 🔥' : '';
  console.log(`    → OOS POOL: WR=${(oosPoolWR * 100).toFixed(1)}% n=${oosTotalTrades} tpd=${oosTPD.toFixed(2)}${flag}`);

  if (oosPoolWR >= 0.75 && oosTotalTrades >= 10 && oosTPD >= 0.33) {
    winners.push({ label: `A_${coin}_OOS_DayHour_Pool`, wr: oosPoolWR, n: oosTotalTrades, tpd: oosTPD });
    console.log(`    ✅ GENUINE OOS WINNER for ${coin}!`);
  }
}

// ═══════════════════════════════════════════════════════
// SECTION B: OOS validation of BTC h9 (strat 126)
// Already committed — verify it holds in second half
// ═══════════════════════════════════════════════════════
console.log('\n== Section B: BTC h9 OOS verification ==\n');

{
  const candles = allCandles['BTC'];
  const half = Math.floor(candles.length / 2);
  const train = candles.slice(0, half);
  const test = candles.slice(half);

  const trainR = backtest(train, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    return new Date(c[i].t).getUTCHours() === 9 && calcRSI(c, i, 7) > 70;
  });
  const testR = backtest(test, (c, i) => {
    const bb = calcBB(c, i);
    if (!bb || c[i].c <= bb.upper) return false;
    return new Date(c[i].t).getUTCHours() === 9 && calcRSI(c, i, 7) > 70;
  });

  console.log(`  B_BTC_h9_RSI70_BB22:`);
  console.log(`    Train (first 92d): WR=${(trainR.wr * 100).toFixed(1)}% n=${trainR.n}`);
  console.log(`    Test  (last  92d): WR=${(testR.wr * 100).toFixed(1)}% n=${testR.n}${testR.wr >= 0.75 ? ' ✅' : testR.wr >= 0.65 ? ' 🔥' : ''}`);
}

// ═══════════════════════════════════════════════════════
// SECTION C: OOS single-hour validation per coin
// Train: find which single hours have >=70% WR in first half
// Test: do those hours hold in second half?
// ═══════════════════════════════════════════════════════
console.log('\n== Section C: OOS per-hour validation ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const half = Math.floor(candles.length / 2);
  const train = candles.slice(0, half);
  const test = candles.slice(half);

  console.log(`  ${coin} — hours with train WR>=70% n>=8 → OOS result:`);
  let found = false;

  for (let h = 0; h < 24; h++) {
    const trainR = backtest(train, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      return new Date(c[i].t).getUTCHours() === h && calcRSI(c, i, 7) > 70;
    });
    if (trainR.n >= 8 && trainR.wr >= 0.70) {
      const testR = backtest(test, (c, i) => {
        const bb = calcBB(c, i);
        if (!bb || c[i].c <= bb.upper) return false;
        return new Date(c[i].t).getUTCHours() === h && calcRSI(c, i, 7) > 70;
      });
      const isKnown = GOOD_HOURS[coin].has(h);
      const oosFlag = testR.n >= 5 && testR.wr >= 0.75 ? ' ✅ OOS WINNER' : testR.n >= 5 && testR.wr >= 0.65 ? ' 🔥' : '';
      console.log(`    h${h}: train=${(trainR.wr * 100).toFixed(1)}% n=${trainR.n} | OOS=${testR.n > 0 ? (testR.wr * 100).toFixed(1) + '%' : 'n/a'} n=${testR.n}${isKnown ? ' (known GH)' : ' ← NEW'}${oosFlag}`);
      found = true;

      const tpd = testR.n / (test.length * 5 / 60 / 24);
      if (!isKnown && testR.n >= 5 && testR.wr >= 0.75 && tpd >= 0.33) {
        winners.push({ label: `C_${coin}_h${h}_OOS`, wr: testR.wr, n: testR.n, tpd });
      }
    }
  }
  if (!found) console.log(`    (none)`);
}

// ═══════════════════════════════════════════════════════
// SECTION D: OOS MFI+RSI7+BB22 per hour
// Train on first half to find best MFI threshold per hour
// Test on second half
// ═══════════════════════════════════════════════════════
console.log('\n== Section D: OOS MFI+RSI7+BB22 per-hour ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const half = Math.floor(candles.length / 2);
  const train = candles.slice(0, half);
  const test = candles.slice(half);

  console.log(`  ${coin} — hours with MFI>68+RSI7>70+BB22 train WR>=70% n>=8:`);
  let found = false;

  for (let h = 0; h < 24; h++) {
    const trainR = backtest(train, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      if (new Date(c[i].t).getUTCHours() !== h) return false;
      return calcRSI(c, i, 7) > 70 && calcMFI(c, i) > 68;
    });
    if (trainR.n >= 8 && trainR.wr >= 0.70) {
      const testR = backtest(test, (c, i) => {
        const bb = calcBB(c, i);
        if (!bb || c[i].c <= bb.upper) return false;
        if (new Date(c[i].t).getUTCHours() !== h) return false;
        return calcRSI(c, i, 7) > 70 && calcMFI(c, i) > 68;
      });
      const isKnown = GOOD_HOURS[coin].has(h);
      const oosFlag = testR.n >= 5 && testR.wr >= 0.75 ? ' ✅ OOS WINNER' : testR.n >= 5 && testR.wr >= 0.65 ? ' 🔥' : '';
      console.log(`    h${h}: train=${(trainR.wr * 100).toFixed(1)}% n=${trainR.n} | OOS=${testR.n > 0 ? (testR.wr * 100).toFixed(1) + '%' : 'n/a'} n=${testR.n}${isKnown ? ' (GH)' : ' ← NEW'}${oosFlag}`);
      found = true;

      const tpd = testR.n / (test.length * 5 / 60 / 24);
      if (!isKnown && testR.n >= 5 && testR.wr >= 0.75 && tpd >= 0.33) {
        winners.push({ label: `D_${coin}_h${h}_MFI68_OOS`, wr: testR.wr, n: testR.n, tpd });
      }
    }
  }
  if (!found) console.log(`    (none)`);
}

// ═══════════════════════════════════════════════════════
// SECTION E: Extended good-hours OOS validation
// Use train to find top 3 NEW hours per coin (beyond existing GH)
// Validate those new hours on test set
// ═══════════════════════════════════════════════════════
console.log('\n== Section E: New good-hours OOS (not day-specific) ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const half = Math.floor(candles.length / 2);
  const train = candles.slice(0, half);
  const test = candles.slice(half);
  const existingGH = GOOD_HOURS[coin];

  // Find new hours (not in existing GH) with best train WR
  const hourResults = [];
  for (let h = 0; h < 24; h++) {
    if (existingGH.has(h)) continue; // skip known good hours
    const trainR = backtest(train, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      return new Date(c[i].t).getUTCHours() === h && calcRSI(c, i, 7) > 70;
    });
    if (trainR.n >= 8) hourResults.push({ h, ...trainR });
  }
  hourResults.sort((a, b) => b.wr - a.wr);
  const top3 = hourResults.slice(0, 3);

  console.log(`  ${coin} — top 3 NEW hours from train → OOS test:`);
  let oosWins = 0, oosTrades = 0;
  for (const hr of top3) {
    const testR = backtest(test, (c, i) => {
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      return new Date(c[i].t).getUTCHours() === hr.h && calcRSI(c, i, 7) > 70;
    });
    const flag = testR.n >= 5 && testR.wr >= 0.75 ? ' ✅' : testR.n >= 5 && testR.wr >= 0.65 ? ' 🔥' : '';
    console.log(`    h${hr.h}: train=${(hr.wr * 100).toFixed(1)}% n=${hr.n} | OOS=${testR.n > 0 ? (testR.wr * 100).toFixed(1) + '%' : 'n/a'} n=${testR.n}${flag}`);
    oosWins += testR.wins;
    oosTrades += testR.trades;
  }
  if (top3.length > 0) {
    const poolWR = oosTrades > 0 ? oosWins / oosTrades : 0;
    const poolTPD = oosTrades / (test.length * 5 / 60 / 24);
    const flag = poolWR >= 0.75 && oosTrades >= 10 && poolTPD >= 0.33 ? ' 🏆🏆🏆' : poolWR >= 0.65 ? ' 🔥' : '';
    console.log(`    → Pool WR=${(poolWR * 100).toFixed(1)}% n=${oosTrades} tpd=${poolTPD.toFixed(2)}${flag}`);
    if (poolWR >= 0.75 && oosTrades >= 10 && poolTPD >= 0.33) {
      winners.push({ label: `E_${coin}_NewHours_Pool_OOS`, wr: poolWR, n: oosTrades, tpd: poolTPD });
    }
  }
}

// ═══════════════════════════════════════════════════════
// SECTION F: ETH strat-66-style analog
// Strat 66 = BTC GH+RSI65+body+BB22 = 79.2% WR
// Try ETH with RSI65 (looser) at ETH good hours
// ═══════════════════════════════════════════════════════
console.log('\n== Section F: ETH strat-66-style (RSI>65+body+BB22+GH) ==\n');

{
  const candles = allCandles['ETH'];
  const ethGH = new Set([10, 11, 12, 21]);

  // F1: ETH GH + RSI7>65 + body>0 + BB22 (loosened from RSI7>70)
  const f1 = (() => {
    let wins = 0, trades = 0;
    const foldResults = [];
    const FOLDS = 5;
    const foldSize = Math.floor(candles.length / FOLDS);
    for (let f = 0; f < FOLDS; f++) {
      const start = f * foldSize;
      const end = (f === FOLDS - 1) ? candles.length - 1 : (f + 1) * foldSize;
      let fw = 0, ft = 0;
      for (let i = start + 30; i < end - 1; i++) {
        const bb = calcBB(candles, i);
        if (!bb || candles[i].c <= bb.upper) continue;
        const h = new Date(candles[i].t).getUTCHours();
        if (!ethGH.has(h)) continue;
        const rsi7 = calcRSI(candles, i, 7);
        if (rsi7 <= 65) continue;
        const body = Math.abs(candles[i].c - candles[i].o);
        const range = candles[i].h - candles[i].l;
        if (range === 0 || body / range < 0.3) continue; // body > 30% of range
        ft++; if (candles[i + 1].c < candles[i].c) fw++;
      }
      foldResults.push({ wr: ft > 0 ? fw / ft : 0, n: ft });
      wins += fw; trades += ft;
    }
    const wr = trades > 0 ? wins / trades : 0;
    const tpd = trades / (candles.length * 5 / 60 / 24);
    const mean = foldResults.reduce((s, f) => s + f.wr, 0) / FOLDS;
    const sigma = Math.sqrt(foldResults.reduce((s, f) => s + (f.wr - mean) ** 2, 0) / FOLDS);
    return { wr, n: trades, tpd, sigma };
  })();
  const flag = f1.wr >= 0.75 && f1.n >= 10 && f1.tpd >= 0.33 ? ' 🏆🏆🏆' : f1.wr >= 0.70 ? ' 🔥' : '';
  const warn = f1.tpd < 0.33 ? ` ⚠️ tpd=${f1.tpd.toFixed(2)}` : '';
  console.log(`  F1_ETH_GH_RSI65_body_BB22: WR=${(f1.wr * 100).toFixed(1)}% n=${f1.n} tpd=${f1.tpd.toFixed(2)} σ=${(f1.sigma * 100).toFixed(1)}%${flag}${warn}`);
  if (f1.wr >= 0.75 && f1.n >= 10 && f1.tpd >= 0.33) winners.push({ label: 'F1_ETH_GH_RSI65_body', ...f1 });

  // F2: ETH GH + RSI7>68 + body>0 + BB22
  const f2 = (() => {
    let wins = 0, trades = 0;
    const foldResults = [];
    const FOLDS = 5;
    const foldSize = Math.floor(candles.length / FOLDS);
    for (let f = 0; f < FOLDS; f++) {
      const start = f * foldSize;
      const end = (f === FOLDS - 1) ? candles.length - 1 : (f + 1) * foldSize;
      let fw = 0, ft = 0;
      for (let i = start + 30; i < end - 1; i++) {
        const bb = calcBB(candles, i);
        if (!bb || candles[i].c <= bb.upper) continue;
        const h = new Date(candles[i].t).getUTCHours();
        if (!ethGH.has(h)) continue;
        const rsi7 = calcRSI(candles, i, 7);
        if (rsi7 <= 68) continue;
        const body = Math.abs(candles[i].c - candles[i].o);
        const range = candles[i].h - candles[i].l;
        if (range === 0 || body / range < 0.3) continue;
        ft++; if (candles[i + 1].c < candles[i].c) fw++;
      }
      foldResults.push({ wr: ft > 0 ? fw / ft : 0, n: ft });
      wins += fw; trades += ft;
    }
    const wr = trades > 0 ? wins / trades : 0;
    const tpd = trades / (candles.length * 5 / 60 / 24);
    const mean = foldResults.reduce((s, f) => s + f.wr, 0) / FOLDS;
    const sigma = Math.sqrt(foldResults.reduce((s, f) => s + (f.wr - mean) ** 2, 0) / FOLDS);
    return { wr, n: trades, tpd, sigma };
  })();
  const flag2 = f2.wr >= 0.75 && f2.n >= 10 && f2.tpd >= 0.33 ? ' 🏆🏆🏆' : f2.wr >= 0.70 ? ' 🔥' : '';
  const warn2 = f2.tpd < 0.33 ? ` ⚠️ tpd=${f2.tpd.toFixed(2)}` : '';
  console.log(`  F2_ETH_GH_RSI68_body_BB22: WR=${(f2.wr * 100).toFixed(1)}% n=${f2.n} tpd=${f2.tpd.toFixed(2)} σ=${(f2.sigma * 100).toFixed(1)}%${flag2}${warn2}`);
  if (f2.wr >= 0.75 && f2.n >= 10 && f2.tpd >= 0.33) winners.push({ label: 'F2_ETH_GH_RSI68_body', ...f2 });

  // F3: ETH GH + RSI14>65 + RSI7>70 + body + BB22
  const f3 = (() => {
    let wins = 0, trades = 0;
    const foldResults = [];
    const FOLDS = 5;
    const foldSize = Math.floor(candles.length / FOLDS);
    for (let f = 0; f < FOLDS; f++) {
      const start = f * foldSize;
      const end = (f === FOLDS - 1) ? candles.length - 1 : (f + 1) * foldSize;
      let fw = 0, ft = 0;
      for (let i = start + 30; i < end - 1; i++) {
        const bb = calcBB(candles, i);
        if (!bb || candles[i].c <= bb.upper) continue;
        const h = new Date(candles[i].t).getUTCHours();
        if (!ethGH.has(h)) continue;
        if (calcRSI(candles, i, 7) <= 70) continue;
        if (calcRSI(candles, i, 14) <= 65) continue;
        const body = Math.abs(candles[i].c - candles[i].o);
        const range = candles[i].h - candles[i].l;
        if (range === 0 || body / range < 0.3) continue;
        ft++; if (candles[i + 1].c < candles[i].c) fw++;
      }
      foldResults.push({ wr: ft > 0 ? fw / ft : 0, n: ft });
      wins += fw; trades += ft;
    }
    const wr = trades > 0 ? wins / trades : 0;
    const tpd = trades / (candles.length * 5 / 60 / 24);
    const mean = foldResults.reduce((s, f) => s + f.wr, 0) / FOLDS;
    const sigma = Math.sqrt(foldResults.reduce((s, f) => s + (f.wr - mean) ** 2, 0) / FOLDS);
    return { wr, n: trades, tpd, sigma };
  })();
  const flag3 = f3.wr >= 0.75 && f3.n >= 10 && f3.tpd >= 0.33 ? ' 🏆🏆🏆' : f3.wr >= 0.70 ? ' 🔥' : '';
  const warn3 = f3.tpd < 0.33 ? ` ⚠️ tpd=${f3.tpd.toFixed(2)}` : '';
  console.log(`  F3_ETH_GH_RSI14_65+RSI7_70_body_BB22: WR=${(f3.wr * 100).toFixed(1)}% n=${f3.n} tpd=${f3.tpd.toFixed(2)} σ=${(f3.sigma * 100).toFixed(1)}%${flag3}${warn3}`);
  if (f3.wr >= 0.75 && f3.n >= 10 && f3.tpd >= 0.33) winners.push({ label: 'F3_ETH_GH_RSI14_RSI7_body', ...f3 });
}

// ═══════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════
console.log('\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10 (or n>=5 for OOS), tpd>=0.33 ===');
console.log('=======================================================');
if (winners.length === 0) {
  console.log('  (none)');
} else {
  for (const w of winners) {
    console.log(`  ✅ ${w.label}: WR=${(w.wr * 100).toFixed(1)}% n=${w.n} tpd=${w.tpd.toFixed(2)}`);
  }
}

db.close();
