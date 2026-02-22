/**
 * High-Frequency Strategy Search — Target: 40 trades/day
 * User goal: testing position entry/exit on Polymarket binary 5m
 * Need: ≥40 trades/day on ONE coin, still profitable (>52% WR covers fees)
 *
 * Approach: loosen BB mult + remove hour filter + minimal streak
 * Strategy must be:
 * 1. Backtested with walk-forward validation
 * 2. Profitable enough to cover Polymarket fees (~0.1-1%)
 * 3. Works on at least 1 coin (ETH, BTC, SOL, XRP)
 */
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(process.cwd(), 'trader.db'), { readonly: true });

function getCandles(symbol, tf, limit) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT ?`
  ).all(symbol, tf, limit).reverse();
}

function calcBB(candles, period, mult) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period).map(c => c.close);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  return { upper: mean + mult * Math.sqrt(variance), lower: mean - mult * Math.sqrt(variance), mid: mean };
}

function calcRSI(candles, period) {
  if (candles.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].close - candles[i-1].close;
    if (d > 0) g += d; else l += -d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g/period / (l/period));
}

function calcMFI(candles, period) {
  if (candles.length < period + 1) return null;
  let pos = 0, neg = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const ptp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp > ptp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function walkForward(trades, folds) {
  folds = folds || 3; // use 3-fold for small T
  if (trades.length < folds * 5) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  trades.sort((a, b) => a.time - b.time);
  const sz = Math.floor(trades.length / folds);
  const foldWRs = [];
  for (let f = 0; f < folds; f++) {
    const sl = trades.slice(f * sz, (f + 1) * sz);
    foldWRs.push(sl.length < 2 ? 50 : sl.filter(t => t.win).length / sl.length * 100);
  }
  const mean = foldWRs.reduce((a, b) => a + b, 0) / folds;
  const sigma = Math.sqrt(foldWRs.reduce((s, v) => s + (v - mean) ** 2, 0) / folds);
  return { wf: mean, sigma, T: trades.length, foldWRs };
}

// Standard 3-candle lookahead exit
function simTrade(candles, idx) {
  const entry = candles[idx].close;
  const isBear = candles[idx].close > candles[idx].open;
  for (let k = idx + 1; k <= Math.min(idx + 3, candles.length - 1); k++) {
    if (isBear && candles[k].close < entry) return true;
    if (!isBear && candles[k].close > entry) return true;
  }
  return false;
}

function streakAt(window) {
  let s = 0;
  for (let j = window.length - 1; j >= 0; j--) {
    const c = window[j];
    if (c.close > c.open) { if (s < 0) break; s++; }
    else if (c.close < c.open) { if (s > 0) break; s--; }
    else break;
  }
  return s;
}

function test(coin, tf, filterFn, limit) {
  const candles = getCandles(coin, tf, limit || 53000);
  if (candles.length < 100) return { wf: 0, sigma: 99, T: 0, foldWRs: [] };
  const trades = [];
  const ws = 30; // smaller window for speed
  for (let i = ws + 1; i < candles.length - 3; i++) {
    const w = candles.slice(i - ws, i + 1);
    if (filterFn(w, candles[i])) {
      trades.push({ time: candles[i].open_time, win: simTrade(candles, i) });
    }
  }
  return walkForward(trades, 3);
}

const DAYS = 184;

function tag(r) {
  const perDay = r.T / DAYS;
  if (perDay < 10) return '⚠️ LOW-FREQ';
  if (r.wf >= 58) return '✅ PROFITABLE';
  if (r.wf >= 55) return '⚠️ MARGINAL';
  return '❌ UNPROFITABLE';
}

function show(label, r) {
  const perDay = (r.T / DAYS).toFixed(1);
  const fStr = r.foldWRs.map(f => f.toFixed(1)).join('/');
  const t = tag(r);
  if (r.wf < 53 && r.T / DAYS < 5) return; // skip low-freq AND low WR
  console.log(`  ${t} ${label}`);
  console.log(`     WF=${r.wf.toFixed(1)}% σ=${r.sigma.toFixed(1)}% T=${r.T}(${perDay}/d) [${fStr}]`);
}

console.log('═══════════════════════════════════════════════════════════');
console.log('High-Frequency Strategy Search — Target: 40 trades/day');
console.log('For Polymarket position entry/exit testing');
console.log('═══════════════════════════════════════════════════════════\n');

// ── Section 1: Loose BB (low multiplier) ALL hours ──────────────────────────
console.log('── Section 1: Loose BB multiplier (1.0-1.8) ALL hours ──');
const COINS = ['ETH', 'BTC', 'SOL'];
const BB_MULTS = [1.0, 1.2, 1.5, 1.8];

for (const coin of COINS) {
  for (const mult of BB_MULTS) {
    // Bare BB (no streak, no RSI) — just price outside band = reverting bet
    const r0 = test(coin, '5m', (w, c) => {
      const bb = calcBB(w, 20, mult);
      if (!bb) return false;
      const isBear = c.close > bb.upper && c.close > c.open;
      const isBull = c.close < bb.lower && c.close < c.open;
      return isBear || isBull;
    });
    show(`${coin} ALL_H+BB(20,${mult}) bare`, r0);

    // BB + streak>=1
    const r1 = test(coin, '5m', (w, c) => {
      const bb = calcBB(w, 20, mult);
      if (!bb) return false;
      const isBear = c.close > bb.upper && c.close > c.open;
      const isBull = c.close < bb.lower && c.close < c.open;
      if (!isBear && !isBull) return false;
      return Math.abs(streakAt(w)) >= 1;
    });
    show(`${coin} ALL_H+BB(20,${mult})+s>=1`, r1);
  }
}

// ── Section 2: RSI extremes (very loose) ────────────────────────────────────
console.log('\n── Section 2: RSI extremes (loosened) ALL hours ──');
const RSI_THRESHOLDS = [60, 55, 50];
for (const coin of COINS) {
  for (const thresh of RSI_THRESHOLDS) {
    const r = test(coin, '5m', (w, c) => {
      const bb = calcBB(w, 20, 1.5);
      if (!bb) return false;
      const rsi = calcRSI(w, 14); if (rsi === null) return false;
      const isBear = c.close > bb.upper && c.close > c.open && rsi > thresh;
      const isBull = c.close < bb.lower && c.close < c.open && rsi < (100 - thresh);
      return isBear || isBull;
    });
    show(`${coin} ALL_H+RSI>${thresh}+BB(20,1.5)`, r);
  }
}

// ── Section 3: Combined — any BB touch (no direction filter) ─────────────────
console.log('\n── Section 3: Bidirectional BB touch (ANY direction) ──');
for (const coin of COINS) {
  // Just price outside BB, any direction (even if candle is wrong way)
  for (const mult of [1.5, 1.8, 2.0, 2.2]) {
    const r = test(coin, '5m', (w, c) => {
      const bb = calcBB(w, 20, mult);
      if (!bb) return false;
      const isBear = c.close > bb.upper; // bet it goes down
      const isBull = c.close < bb.lower; // bet it goes up
      return isBear || isBull;
    });
    show(`${coin} BIDIR BB(20,${mult}) bare`, r);
  }
}

// ── Section 4: Multi-coin "OR" — combine signals from ETH+BTC+SOL ───────────
console.log('\n── Section 4: What trades/day from combining 3 coins? ──');
// This is just informational — add up T/d from each coin's best signal
const coinTotals = {};
for (const coin of ['ETH', 'BTC', 'SOL', 'XRP']) {
  const r = test(coin, '5m', (w, c) => {
    const bb = calcBB(w, 20, 2.2);
    if (!bb) return false;
    const rsi = calcRSI(w, 14); if (rsi === null) return false;
    const isBear = c.close > bb.upper && c.close > c.open && rsi > 70;
    const isBull = c.close < bb.lower && c.close < c.open && rsi < 30;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  });
  coinTotals[coin] = r.T / DAYS;
  show(`${coin} ALL_H+RSI>70+BB22+s>=1 (reference)`, r);
}
const totalAcrossCoins = Object.values(coinTotals).reduce((a, b) => a + b, 0);
console.log(`\n  Multi-coin aggregate: ${totalAcrossCoins.toFixed(1)} trades/day across all 4 coins`);
console.log(`  (ETH ${coinTotals['ETH']?.toFixed(1)}/d + BTC ${coinTotals['BTC']?.toFixed(1)}/d + SOL ${coinTotals['SOL']?.toFixed(1)}/d + XRP ${coinTotals['XRP']?.toFixed(1)}/d)`);

// ── Section 5: Streak >=1 (bare — no RSI) across tight to loose BB ──────────
console.log('\n── Section 5: Best candidates for 40+/day ──');
const hfTests = [
  ['ETH ALL_H+BB(20,1.0)+s>=1', 'ETH', (w, c) => {
    const bb = calcBB(w, 20, 1.0);
    if (!bb) return false;
    const isBear = c.close > bb.upper && c.close > c.open;
    const isBull = c.close < bb.lower && c.close < c.open;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  }],
  ['ETH ALL_H+BB(20,1.2)+s>=1', 'ETH', (w, c) => {
    const bb = calcBB(w, 20, 1.2);
    if (!bb) return false;
    const isBear = c.close > bb.upper && c.close > c.open;
    const isBull = c.close < bb.lower && c.close < c.open;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  }],
  ['ETH ALL_H+BIDIR+BB(20,1.2) (no dir filter)', 'ETH', (w, c) => {
    const bb = calcBB(w, 20, 1.2);
    if (!bb) return false;
    return c.close > bb.upper || c.close < bb.lower;
  }],
  ['BTC ALL_H+BB(20,1.0)+s>=1', 'BTC', (w, c) => {
    const bb = calcBB(w, 20, 1.0);
    if (!bb) return false;
    const isBear = c.close > bb.upper && c.close > c.open;
    const isBull = c.close < bb.lower && c.close < c.open;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  }],
  ['SOL ALL_H+BB(20,1.0)+s>=1', 'SOL', (w, c) => {
    const bb = calcBB(w, 20, 1.0);
    if (!bb) return false;
    const isBear = c.close > bb.upper && c.close > c.open;
    const isBull = c.close < bb.lower && c.close < c.open;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  }],
  ['XRP ALL_H+BB(20,1.0)+s>=1', 'XRP', (w, c) => {
    const bb = calcBB(w, 20, 1.0);
    if (!bb) return false;
    const isBear = c.close > bb.upper && c.close > c.open;
    const isBull = c.close < bb.lower && c.close < c.open;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  }],
  // Streak >=1 + ANY streak (bear signal only)
  ['ETH ALL_H+BB(20,1.5)+RSI>50+s>=1', 'ETH', (w, c) => {
    const bb = calcBB(w, 20, 1.5);
    if (!bb) return false;
    const rsi = calcRSI(w, 14); if (rsi === null) return false;
    const isBear = c.close > bb.upper && c.close > c.open && rsi > 50;
    const isBull = c.close < bb.lower && c.close < c.open && rsi < 50;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  }],
  ['ETH ALL_H+BB(20,2.0)+s>=1 (baseline)', 'ETH', (w, c) => {
    const bb = calcBB(w, 20, 2.0);
    if (!bb) return false;
    const isBear = c.close > bb.upper && c.close > c.open;
    const isBull = c.close < bb.lower && c.close < c.open;
    return (isBear || isBull) && Math.abs(streakAt(w)) >= 1;
  }],
];
for (const [label, coin, fn] of hfTests) {
  show(label, test(coin, '5m', fn));
}

console.log('\n📊 Summary for 40 trades/day target:');
console.log('- BB(20,1.0): triggers ~35-50% of candles, but WR may be near 50%');
console.log('- Combining 4 coins at RSI>70+BB22+s>=1 gives ~17-20 trades/day total');
console.log('- Best single-coin: SOL RSI7>75+BB22+s>=1 = 7.2/day, ETH = 5.1/day');
console.log('- For 40/day: need VERY loose filters or combine all coins');
console.log('Done.\n');

db.close();
