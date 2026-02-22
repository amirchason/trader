/**
 * Session 32: Day×hour interaction + RSI slope + ranging regime expansion
 *
 * Genuinely untested angles:
 * A. Day × hour interaction grid — specific (weekday, hour) combos, not just weekday or hour alone
 *    Session 25 tested day-of-week only. Session E31 tested per-hour MFI. Day×hour not tried.
 * B. RSI slope at BB extreme — RSI7[i] - RSI7[i-3] > X (rising fast into overbought)
 *    "Acceleration into extreme" = sharper reversal
 * C. ADX<20 per-hour sweep — which hours are best when market is ranging?
 *    Might reveal NEW good hours that only appear in ranging conditions
 * D. Pre-good-hour signal — candle at minute 55-59 (last before a GH starts)
 *    The candle immediately before a known good hour
 * E. Expanded hour search with RSI3>90+BB22 (ultra-fast oscillator, not tested per-hour)
 * F. Multiple consecutive signals — did we fire a signal N candles ago? Trade again?
 *    "Signal clustering" — if signal at t-1 was bear and wrong, is t a better trade?
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

function walkForward(candles, signal_fn) {
  const FOLDS = 5;
  const foldSize = Math.floor(candles.length / FOLDS);
  let totalWins = 0, totalTrades = 0;
  const foldResults = [];
  for (let f = 0; f < FOLDS; f++) {
    const start = f * foldSize;
    const end = (f === FOLDS - 1) ? candles.length - 1 : (f + 1) * foldSize;
    let wins = 0, trades = 0;
    for (let i = start + 50; i < end - 1; i++) {
      if (signal_fn(candles, i)) {
        trades++;
        const win = candles[i + 1].c < candles[i].c; // bear exit
        if (win) wins++;
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
  const warn = r.tpd < 0.33 ? ' ⚠️ tpd=' + r.tpd.toFixed(2) : '';
  console.log(`  ${label} | ${coin}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd.toFixed(2)} σ=${(r.sigma * 100).toFixed(1)}%${flag}${warn}`);
  return r;
}

const GOOD_HOURS = {
  ETH: new Set([10, 11, 12, 21]),
  BTC: new Set([1, 12, 13, 16, 20]),
  SOL: new Set([0, 12, 13, 20]),
  XRP: new Set([6, 9, 12, 18])
};

const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
const allCandles = {};
for (const coin of COINS) allCandles[coin] = getCandles(coin);

const winners = [];

// ═══════════════════════════════════════════════════════
// SECTION A: Day × Hour interaction grid
// Test specific (weekday, hour) combos vs RSI7+BB22
// Only combos where n>=10 reported
// ═══════════════════════════════════════════════════════
console.log('\n== Section A: Day × Hour interaction grid ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const bestCombos = [];

  for (let dow = 0; dow < 7; dow++) { // 0=Sun,1=Mon,...,6=Sat
    for (let h = 0; h < 24; h++) {
      let wins = 0, trades = 0;
      for (let i = 30; i < candles.length - 1; i++) {
        const d = new Date(candles[i].t);
        if (d.getUTCDay() !== dow || d.getUTCHours() !== h) continue;
        const bb = calcBB(candles, i);
        if (!bb || candles[i].c <= bb.upper) continue;
        const rsi7 = calcRSI(candles, i, 7);
        if (rsi7 <= 70) continue;
        trades++;
        if (candles[i + 1].c < candles[i].c) wins++;
      }
      if (trades >= 10) {
        const wr = wins / trades;
        bestCombos.push({ dow, h, wr, n: trades });
      }
    }
  }

  // Print top 5 by WR
  bestCombos.sort((a, b) => b.wr - a.wr);
  const top5 = bestCombos.slice(0, 5);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const b of top5) {
    const tpd = b.n / (candles.length * 5 / 60 / 24); // approximate
    const flag = b.wr >= 0.80 ? ' 🔥🔥' : b.wr >= 0.75 ? ' 🔥' : '';
    console.log(`  A_${coin}_${dayNames[b.dow]}h${b.h}_RSI70_BB22: WR=${(b.wr * 100).toFixed(1)}% n=${b.n} (tpd≈${tpd.toFixed(2)})${flag}`);
    if (b.wr >= 0.75 && b.n >= 10 && tpd >= 0.33) {
      winners.push({ label: `A_${coin}_${dayNames[b.dow]}h${b.h}`, wr: b.wr, n: b.n, tpd, sigma: 0 });
    }
  }
}

// ═══════════════════════════════════════════════════════
// SECTION B: RSI slope (acceleration into overbought)
// RSI7[i] - RSI7[i-3] > threshold AND above BB22
// ═══════════════════════════════════════════════════════
console.log('\n== Section B: RSI7 slope at BB extreme ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  const gh = GOOD_HOURS[coin];

  for (const slopeT of [5, 8, 12]) {
    // B1: all hours
    const b1 = walkForward(candles, (c, i) => {
      if (i < 25) return false;
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      const rsi_now = calcRSI(c, i, 7);
      const rsi_3ago = calcRSI(c, i - 3, 7);
      return (rsi_now - rsi_3ago) > slopeT && rsi_now > 65;
    });
    fmt(`B_${coin}_RSIslope${slopeT}_allH`, coin, b1);

    // B2: GH only
    const b2 = walkForward(candles, (c, i) => {
      if (i < 25) return false;
      const bb = calcBB(c, i);
      if (!bb || c[i].c <= bb.upper) return false;
      const hour = new Date(c[i].t).getUTCHours();
      if (!gh.has(hour)) return false;
      const rsi_now = calcRSI(c, i, 7);
      const rsi_3ago = calcRSI(c, i - 3, 7);
      return (rsi_now - rsi_3ago) > slopeT && rsi_now > 65;
    });
    const r = fmt(`B_${coin}_RSIslope${slopeT}_GH`, coin, b2);
    if (r.wr >= 0.75 && r.n >= 10 && r.tpd >= 0.33) winners.push({ label: `B_${coin}_slope${slopeT}`, ...r });
  }
}

// ═══════════════════════════════════════════════════════
// SECTION C: ADX<20 per-hour sweep
// Every UTC hour, test RSI7+ADX<20+BB22 — find NEW hours
// ═══════════════════════════════════════════════════════
console.log('\n== Section C: ADX<20 per-hour sweep (find new good hours) ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  console.log(`  ${coin} — hours with WR>=70% n>=10:`);
  let found = false;

  for (let h = 0; h < 24; h++) {
    let wins = 0, trades = 0;
    for (let i = 50; i < candles.length - 1; i++) {
      if (new Date(candles[i].t).getUTCHours() !== h) continue;
      const bb = calcBB(candles, i);
      if (!bb || candles[i].c <= bb.upper) continue;
      const rsi7 = calcRSI(candles, i, 7);
      if (rsi7 <= 70) continue;
      const adx = calcADX(candles, i);
      if (adx >= 20) continue;
      trades++;
      if (candles[i + 1].c < candles[i].c) wins++;
    }
    if (trades >= 10) {
      const wr = wins / trades;
      const tpd = trades / (candles.length * 5 / 60 / 24);
      if (wr >= 0.70) {
        const isKnown = GOOD_HOURS[coin].has(h);
        const flag = wr >= 0.75 ? ' 🔥' : '';
        console.log(`    h=${h}: WR=${(wr * 100).toFixed(1)}% n=${trades} tpd=${tpd.toFixed(2)}${isKnown ? ' (already good hour)' : ' ← NEW'}${flag}`);
        found = true;
        if (wr >= 0.75 && trades >= 10 && tpd >= 0.33) {
          winners.push({ label: `C_${coin}_ADX20_h${h}`, wr, n: trades, tpd, sigma: 0 });
        }
      }
    }
  }
  if (!found) console.log(`    (none >= 70%)`);
}

// ═══════════════════════════════════════════════════════
// SECTION D: RSI3>90 per-hour sweep
// Ultra-fast RSI3 was proven good at all-hours (strats 83+)
// Find which specific hours hit >=75% WR with RSI3+BB22
// ═══════════════════════════════════════════════════════
console.log('\n== Section D: RSI3>90 per-hour sweep ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  console.log(`  ${coin} — hours with WR>=70% n>=10 (RSI3>90+BB22):`);
  let found = false;

  for (let h = 0; h < 24; h++) {
    let wins = 0, trades = 0;
    for (let i = 20; i < candles.length - 1; i++) {
      if (new Date(candles[i].t).getUTCHours() !== h) continue;
      const bb = calcBB(candles, i);
      if (!bb || candles[i].c <= bb.upper) continue;
      if (calcRSI(candles, i, 3) <= 90) continue;
      trades++;
      if (candles[i + 1].c < candles[i].c) wins++;
    }
    if (trades >= 10) {
      const wr = wins / trades;
      const tpd = trades / (candles.length * 5 / 60 / 24);
      if (wr >= 0.70) {
        const flag = wr >= 0.75 ? ' 🔥' : '';
        console.log(`    h=${h}: WR=${(wr * 100).toFixed(1)}% n=${trades} tpd=${tpd.toFixed(2)}${flag}`);
        found = true;
        if (wr >= 0.75 && trades >= 10 && tpd >= 0.33) {
          winners.push({ label: `D_${coin}_RSI3_h${h}`, wr, n: trades, tpd, sigma: 0 });
        }
      }
    }
  }
  if (!found) console.log(`    (none >= 70%)`);
}

// ═══════════════════════════════════════════════════════
// SECTION E: MFI per-hour with ADX<20 (not tried before)
// ═══════════════════════════════════════════════════════
console.log('\n== Section E: MFI>70+ADX20+BB22 per-hour sweep ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  console.log(`  ${coin} — hours with WR>=70% n>=10 (MFI>70+ADX<20+BB22):`);
  let found = false;

  for (let h = 0; h < 24; h++) {
    let wins = 0, trades = 0;
    for (let i = 50; i < candles.length - 1; i++) {
      if (new Date(candles[i].t).getUTCHours() !== h) continue;
      const bb = calcBB(candles, i);
      if (!bb || candles[i].c <= bb.upper) continue;
      if (calcMFI(candles, i) <= 70) continue;
      if (calcADX(candles, i) >= 20) continue;
      trades++;
      if (candles[i + 1].c < candles[i].c) wins++;
    }
    if (trades >= 10) {
      const wr = wins / trades;
      const tpd = trades / (candles.length * 5 / 60 / 24);
      if (wr >= 0.70) {
        const flag = wr >= 0.75 ? ' 🔥' : '';
        console.log(`    h=${h}: WR=${(wr * 100).toFixed(1)}% n=${trades} tpd=${tpd.toFixed(2)}${flag}`);
        found = true;
        if (wr >= 0.75 && trades >= 10 && tpd >= 0.33) {
          winners.push({ label: `E_${coin}_MFI70ADX20_h${h}`, wr, n: trades, tpd, sigma: 0 });
        }
      }
    }
  }
  if (!found) console.log(`    (none >= 70%)`);
}

// ═══════════════════════════════════════════════════════
// SECTION F: MFI>68+RSI7>70+BB22 per-hour (tried as good-hours subset,
// but NOT per individual hour sweep)
// ═══════════════════════════════════════════════════════
console.log('\n== Section F: MFI>68+RSI7>70+BB22 per-hour sweep ==\n');

for (const coin of COINS) {
  const candles = allCandles[coin];
  console.log(`  ${coin} — hours with WR>=70% n>=10 (MFI>68+RSI7>70+BB22):`);
  let found = false;

  for (let h = 0; h < 24; h++) {
    let wins = 0, trades = 0;
    for (let i = 30; i < candles.length - 1; i++) {
      if (new Date(candles[i].t).getUTCHours() !== h) continue;
      const bb = calcBB(candles, i);
      if (!bb || candles[i].c <= bb.upper) continue;
      if (calcRSI(candles, i, 7) <= 70) continue;
      if (calcMFI(candles, i) <= 68) continue;
      trades++;
      if (candles[i + 1].c < candles[i].c) wins++;
    }
    if (trades >= 10) {
      const wr = wins / trades;
      const tpd = trades / (candles.length * 5 / 60 / 24);
      if (wr >= 0.70) {
        const isKnown = GOOD_HOURS[coin].has(h);
        const flag = wr >= 0.75 ? ' 🔥' : '';
        console.log(`    h=${h}: WR=${(wr * 100).toFixed(1)}% n=${trades} tpd=${tpd.toFixed(2)}${isKnown ? ' (GH)' : ' ← NEW'}${flag}`);
        found = true;
        if (wr >= 0.75 && trades >= 10 && tpd >= 0.33) {
          winners.push({ label: `F_${coin}_MFI68RSI70_h${h}`, wr, n: trades, tpd, sigma: 0 });
        }
      }
    }
  }
  if (!found) console.log(`    (none >= 70%)`);
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
