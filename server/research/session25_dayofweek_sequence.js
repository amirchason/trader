/**
 * Session 25: Day-of-Week Effects + Signal Sequence Patterns
 *
 * New dimensions genuinely not yet explored:
 * A) Day-of-week: which weekdays have highest WR for each coin's base pattern?
 *    - Crypto has known calendar effects (Mon/weekend different from Thu/Fri)
 *    - Weekend markets: thinner liquidity = larger overreactions = better mean reversion?
 * B) Hour+Day interaction: h=12 on Monday vs h=12 on Friday — same hour, different edge?
 * C) Signal sequence: consecutive signals (same direction, same strategy) — does streaking
 *    the SIGNAL (not the price) indicate higher or lower follow-through probability?
 * D) Best day subset: find the top 2-3 weekdays per coin where WR is highest
 * E) Weekend filter: Sat/Sun only — thin liquidity may produce more extreme moves
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

function loadCandles(symbol) {
  return db.prepare(
    `SELECT open_time as openTime, open, high, low, close, volume,
            (open_time + 300000) as closeTime
     FROM candles WHERE symbol=? AND timeframe='5m'
     ORDER BY open_time ASC`
  ).all(symbol);
}

function calcBB(candles, period = 20, mult = 2.2) {
  if (candles.length < period) return null;
  const closes = candles.map(c => c.close);
  let sum = 0;
  for (let j = candles.length - period; j < candles.length; j++) sum += closes[j];
  const mid = sum / period;
  let variance = 0;
  for (let j = candles.length - period; j < candles.length; j++) variance += (closes[j] - mid) ** 2;
  const std = Math.sqrt(variance / period);
  return { upper: mid + mult * std, lower: mid - mult * std, mid, std };
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const tp = candles.map(c => (c.high + c.low + c.close) / 3);
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const mf = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) posFlow += mf; else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 50;
  const len = candles.length;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = len - period; i < len; i++) {
    const high = candles[i].high, low = candles[i].low;
    const prevHigh = candles[i - 1].high, prevLow = candles[i - 1].low, prevClose = candles[i - 1].close;
    const upMove = high - prevHigh, downMove = prevLow - low;
    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;
    tr += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  if (plusDI + minusDI === 0) return 0;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
}

// Base signal function: the proven strat 64/65 pattern
function baseSignal(slice, i, rsiThresh = 73, mfiThresh = 70) {
  if (i < 25) return null;
  const c = slice[i];
  const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
  if (!bb) return null;
  const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
  const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
  if (rsi7 === null || mfi === null) return null;
  const isBear = rsi7 > rsiThresh && mfi > mfiThresh && c.close > bb.upper;
  const isBull = rsi7 < (100 - rsiThresh) && mfi < (100 - mfiThresh) && c.close < bb.lower;
  if (isBear) return 'bear';
  if (isBull) return 'bull';
  return null;
}

// Walk-forward validation
function walkForward(candles, signalFn, folds = 5) {
  const step = Math.floor(candles.length / folds);
  const foldWRs = [];
  let totalN = 0;
  for (let f = 0; f < folds; f++) {
    const start = f * step;
    const end = f === folds - 1 ? candles.length : (f + 1) * step;
    const slice = candles.slice(start, end);
    let wins = 0, total = 0;
    for (let i = 50; i < slice.length - 1; i++) {
      const signal = signalFn(slice, i);
      if (!signal) continue;
      total++;
      const entry = slice[i].close;
      const exit = slice[i + 1].close;
      const win = signal === 'bear' ? exit < entry : exit > entry;
      if (win) wins++;
    }
    totalN += total;
    if (total >= 3) foldWRs.push({ wr: wins / total, n: total });
  }
  if (foldWRs.length < 3) return null;
  const sorted = foldWRs.map(f => f.wr).sort((a, b) => a - b);
  const medianWR = sorted[Math.floor(foldWRs.length / 2)];
  const totalDays = candles.length * 5 / (60 * 24);
  return { wr: medianWR, n: totalN, tpd: parseFloat((totalN / totalDays).toFixed(2)) };
}

console.log('Loading candles...');
const COINS = {
  ETH: { candles: loadCandles('ETH'), goodHours: [10, 11, 12, 21] },
  BTC: { candles: loadCandles('BTC'), goodHours: [1, 12, 13, 16, 20] },
  SOL: { candles: loadCandles('SOL'), goodHours: [0, 12, 13, 20] },
  XRP: { candles: loadCandles('XRP'), goodHours: [6, 9, 12, 18] },
};
for (const [sym, d] of Object.entries(COINS)) {
  console.log(`  ${sym}: ${d.candles.length} candles (${(d.candles.length * 5 / 1440).toFixed(0)} days)`);
}

const results = [];
function addResult(label, sym, stats) {
  if (!stats) return;
  const emoji = stats.wr >= 0.80 ? '🔥🔥🔥' : stats.wr >= 0.75 ? '🔥🔥' : stats.wr >= 0.70 ? '🔥' : '';
  results.push({ label, sym, wr: stats.wr, n: stats.n, tpd: stats.tpd, emoji });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section A: Day-of-week sweep (all hours, base pattern)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section A: Day-of-week sweep (all hours) ==');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

for (const [sym, { candles }] of Object.entries(COINS)) {
  const dayStats = [];
  for (let dow = 0; dow <= 6; dow++) {
    const stats = walkForward(candles, (slice, i) => {
      if (i < 25) return null;
      const c = slice[i];
      const day = new Date(c.closeTime).getUTCDay();
      if (day !== dow) return null;
      return baseSignal(slice, i);
    });
    if (stats && stats.n >= 5) {
      dayStats.push({ dow, name: DAY_NAMES[dow], wr: stats.wr, n: stats.n, tpd: stats.tpd });
    }
  }
  dayStats.sort((a, b) => b.wr - a.wr);
  console.log(`\n  ${sym} by day:`);
  for (const d of dayStats) {
    const tag = d.wr >= 0.75 ? ' 🔥🔥' : d.wr >= 0.70 ? ' 🔥' : '';
    console.log(`    ${d.name} (${d.dow}): WR=${(d.wr * 100).toFixed(1)}% n=${d.n} tpd=${d.tpd}${tag}`);
    if (d.wr >= 0.70) addResult(`A_${sym}_dow=${d.name}+RSI7+MFI70+BB22`, sym, { wr: d.wr, n: d.n, tpd: d.tpd });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section B: Good hours + best days combined
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section B: Good hours + best days ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  const dayStats = [];
  for (let dow = 0; dow <= 6; dow++) {
    const stats = walkForward(candles, (slice, i) => {
      if (i < 25) return null;
      const c = slice[i];
      const day = new Date(c.closeTime).getUTCDay();
      if (day !== dow) return null;
      const hour = new Date(c.closeTime).getUTCHours();
      if (!goodHours.includes(hour)) return null;
      const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
      if (!bb) return null;
      const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
      if (adx >= 20) return null;
      const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
      const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
      if (rsi7 === null || mfi === null) return null;
      const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
      const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
      if (isBear) return 'bear';
      if (isBull) return 'bull';
      return null;
    });
    if (stats && stats.n >= 5) {
      dayStats.push({ dow, name: DAY_NAMES[dow], wr: stats.wr, n: stats.n, tpd: stats.tpd });
    }
  }
  dayStats.sort((a, b) => b.wr - a.wr);
  console.log(`\n  ${sym} GH+ADX20+RSI7+MFI68+BB22 by day:`);
  for (const d of dayStats) {
    const tag = d.wr >= 0.75 ? ' 🔥🔥' : d.wr >= 0.70 ? ' 🔥' : '';
    console.log(`    ${d.name}: WR=${(d.wr * 100).toFixed(1)}% n=${d.n} tpd=${d.tpd}${tag}`);
    if (d.wr >= 0.70) addResult(`B_${sym}_GH+ADX20+RSI7+MFI68+BB22_dow=${d.name}`, sym, { wr: d.wr, n: d.n, tpd: d.tpd });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section C: Weekday subsets (best 2-3 days combined)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section C: Best day subsets ==');

const daySubsets = [
  { name: 'Weekend[0,6]', days: [0, 6] },
  { name: 'Weekday[1,2,3,4,5]', days: [1, 2, 3, 4, 5] },
  { name: 'MonWed[1,3]', days: [1, 3] },
  { name: 'TueThuFri[2,4,5]', days: [2, 4, 5] },
  { name: 'MonThuFri[1,4,5]', days: [1, 4, 5] },
  { name: 'WedThuFri[3,4,5]', days: [3, 4, 5] },
  { name: 'MonTueWed[1,2,3]', days: [1, 2, 3] },
];

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  for (const subset of daySubsets) {
    const stats = walkForward(candles, (slice, i) => {
      if (i < 25) return null;
      const c = slice[i];
      const day = new Date(c.closeTime).getUTCDay();
      if (!subset.days.includes(day)) return null;
      const hour = new Date(c.closeTime).getUTCHours();
      if (!goodHours.includes(hour)) return null;
      const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
      if (!bb) return null;
      const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
      if (adx >= 20) return null;
      const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
      const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
      if (rsi7 === null || mfi === null) return null;
      const isBear = rsi7 > 73 && mfi > 70 && c.close > bb.upper;
      const isBull = rsi7 < 27 && mfi < 30 && c.close < bb.lower;
      if (isBear) return 'bear';
      if (isBull) return 'bull';
      return null;
    });
    if (stats && stats.n >= 10 && stats.wr >= 0.75) {
      addResult(`C_${sym}_GH+ADX20+RSI7>73+MFI70+BB22_${subset.name}`, sym, stats);
      console.log(`  ${sym} ${subset.name}: WR=${(stats.wr * 100).toFixed(1)}% n=${stats.n} tpd=${stats.tpd} 🔥🔥`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section D: Weekend-only patterns (Sat+Sun — thin liquidity, larger swings)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section D: Weekend-only patterns ==');

for (const [sym, { candles }] of Object.entries(COINS)) {
  // D1: Weekend + all hours + RSI7>73 + MFI70 + BB22 (no good hours — weekend may have different hours)
  const statsD1 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const day = new Date(c.closeTime).getUTCDay();
    if (day !== 0 && day !== 6) return null; // Weekend only
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 73 && mfi > 70 && c.close > bb.upper;
    const isBull = rsi7 < 27 && mfi < 30 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`D1_${sym}_Weekend+AllH+RSI7+MFI70+BB22`, sym, statsD1);

  // D2: Weekend + ADX<20 + RSI7>70 + MFI68 + BB22
  const statsD2 = walkForward(candles, (slice, i) => {
    if (i < 25) return null;
    const c = slice[i];
    const day = new Date(c.closeTime).getUTCDay();
    if (day !== 0 && day !== 6) return null;
    const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
    if (!bb) return null;
    const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
    if (adx >= 20) return null;
    const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
    const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
    if (rsi7 === null || mfi === null) return null;
    const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
    const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
    if (isBear) return 'bear';
    if (isBull) return 'bull';
    return null;
  });
  addResult(`D2_${sym}_Weekend+ADX20+RSI7+MFI68+BB22`, sym, statsD2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section E: Hour×Day interaction — best (hour, day) pairs
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section E: Hour×Day interaction ==');

for (const [sym, { candles }] of Object.entries(COINS)) {
  let bestResult = { wr: 0, n: 0, label: '' };
  const interactionResults = [];

  for (let dow = 0; dow <= 6; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const stats = walkForward(candles, (slice, i) => {
        if (i < 25) return null;
        const c = slice[i];
        const day = new Date(c.closeTime).getUTCDay();
        const h = new Date(c.closeTime).getUTCHours();
        if (day !== dow || h !== hour) return null;
        const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
        if (!bb) return null;
        const adx = calcADX(slice.slice(Math.max(0, i - 28), i + 1), 14);
        if (adx >= 20) return null;
        const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
        const mfi = calcMFI(slice.slice(Math.max(0, i - 17), i + 1), 14);
        if (rsi7 === null || mfi === null) return null;
        const isBear = rsi7 > 70 && mfi > 68 && c.close > bb.upper;
        const isBull = rsi7 < 30 && mfi < 32 && c.close < bb.lower;
        if (isBear) return 'bear';
        if (isBull) return 'bull';
        return null;
      });
      if (stats && stats.n >= 5) {
        interactionResults.push({ dow, hour, wr: stats.wr, n: stats.n, tpd: stats.tpd });
        if (stats.wr >= 0.75) {
          addResult(`E_${sym}_${DAY_NAMES[dow]}h${hour}+ADX20+RSI7+MFI68+BB22`, sym, stats);
        }
        if (stats.wr > bestResult.wr) {
          bestResult = { wr: stats.wr, n: stats.n, label: `${DAY_NAMES[dow]} h=${hour}` };
        }
      }
    }
  }

  // Show top 5 hour×day combinations
  interactionResults.sort((a, b) => b.wr - a.wr);
  const top5 = interactionResults.slice(0, 5);
  console.log(`\n  ${sym} top hour×day combos:`);
  for (const r of top5) {
    const tag = r.wr >= 0.75 ? ' 🔥🔥' : r.wr >= 0.70 ? ' 🔥' : '';
    console.log(`    ${DAY_NAMES[r.dow]} h=${r.hour}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n}${tag}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section F: Signal sequence — consecutive signals (momentum in signals)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section F: Signal sequence patterns ==');

for (const [sym, { candles, goodHours }] of Object.entries(COINS)) {
  // F1: Only trade when PREVIOUS candle also had a signal in SAME direction
  // (signal is persisting = more confident)
  const statsF1 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const currentSig = baseSignal(slice, i);
    if (!currentSig) return null;
    // Check if prev candle also had same signal
    const prevSig = baseSignal(slice, i - 1);
    if (prevSig !== currentSig) return null; // Same direction required
    return currentSig;
  });
  addResult(`F1_${sym}_GH+ConsecSignal+BB22`, sym, statsF1);

  // F2: Only trade when previous candle did NOT have a signal (first appearance)
  const statsF2 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const c = slice[i];
    const hour = new Date(c.closeTime).getUTCHours();
    if (!goodHours.includes(hour)) return null;
    const currentSig = baseSignal(slice, i);
    if (!currentSig) return null;
    const prevSig = baseSignal(slice, i - 1);
    if (prevSig !== null) return null; // First appearance required
    return currentSig;
  });
  addResult(`F2_${sym}_GH+FirstSignal+BB22`, sym, statsF2);

  // F3: All hours — only trade when prev signal was OPPOSITE (mean reversion after push)
  // Pattern: price was oversold 1 candle ago, now it's overbought = crossed the midline
  const statsF3 = walkForward(candles, (slice, i) => {
    if (i < 30) return null;
    const currentSig = baseSignal(slice, i, 70, 65);
    if (!currentSig) return null;
    // No time filter — this is a market structure signal
    return currentSig;
  });
  addResult(`F3_${sym}_AllH+BaseSignal_looser`, sym, statsF3);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section G: Specific day sweeps with the PROVEN strat 64/65 conditions
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n== Section G: All-hours strat 64/65 by day ==');

// Strat 64/65 = ALL_H + RSI7>70 + BB22 + streak>=1
function calcStreak(slice, i) {
  if (i < 1) return 0;
  const dir = slice[i].close > slice[i - 1].close ? 1 : -1;
  let s = 0;
  for (let j = i; j >= 1; j--) {
    const d = slice[j].close > slice[j - 1].close ? 1 : -1;
    if (d === dir) s++; else break;
  }
  return dir * s;
}

for (const [sym, { candles }] of Object.entries(COINS)) {
  const dayStats = [];
  for (let dow = 0; dow <= 6; dow++) {
    const stats = walkForward(candles, (slice, i) => {
      if (i < 25) return null;
      const c = slice[i];
      const day = new Date(c.closeTime).getUTCDay();
      if (day !== dow) return null;
      const bb = calcBB(slice.slice(Math.max(0, i - 25), i + 1), 20, 2.2);
      if (!bb) return null;
      const rsi7 = calcRSI(slice.slice(Math.max(0, i - 10), i + 1), 7);
      if (rsi7 === null) return null;
      const streak = calcStreak(slice, i);
      const isBear = rsi7 > 70 && c.close > bb.upper && streak <= -1;
      const isBull = rsi7 < 30 && c.close < bb.lower && streak >= 1;
      if (isBear) return 'bear';
      if (isBull) return 'bull';
      return null;
    });
    if (stats && stats.n >= 5) dayStats.push({ dow, name: DAY_NAMES[dow], ...stats });
  }
  dayStats.sort((a, b) => b.wr - a.wr);
  console.log(`\n  ${sym} strat64-style by day:`);
  for (const d of dayStats) {
    const tag = d.wr >= 0.75 ? ' 🔥🔥' : d.wr >= 0.70 ? ' 🔥' : '';
    console.log(`    ${d.name}: WR=${(d.wr * 100).toFixed(1)}% n=${d.n} tpd=${d.tpd}${tag}`);
    if (d.wr >= 0.75) addResult(`G_${sym}_AllH+RSI7>70+s>=1+BB22_${d.name}`, sym, { wr: d.wr, n: d.n, tpd: d.tpd });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n\n=======================================================');
console.log('=== WINNERS: WR>=75%, n>=10 ===');
console.log('=======================================================');
const winners = results.filter(r => r.wr >= 0.75 && r.n >= 10).sort((a, b) => b.wr - a.wr);
if (winners.length === 0) {
  console.log('  (none)');
} else {
  for (const r of winners) {
    const tpdStr = r.tpd < 0.33 ? ` ⚠️ tpd too low (${r.tpd}/day min=0.33)` : '';
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}${tpdStr}`);
  }
}

console.log('\n=======================================================');
console.log('=== GOOD: WR>=70%, n>=10 ===');
console.log('=======================================================');
const good = results.filter(r => r.wr >= 0.70 && r.n >= 10 && r.wr < 0.75).sort((a, b) => b.wr - a.wr);
if (good.length === 0) {
  console.log('  (none)');
} else {
  for (const r of good) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

console.log('\n=======================================================');
console.log('=== ALL >= 65%, n>=5 ===');
console.log('=======================================================');
const all = results.filter(r => r.wr >= 0.65 && r.n >= 5).sort((a, b) => b.wr - a.wr);
if (all.length === 0) {
  console.log('  (none)');
} else {
  for (const r of all) {
    console.log(`  ${r.label} | ${r.sym}: WR=${(r.wr * 100).toFixed(1)}% n=${r.n} tpd=${r.tpd} ${r.emoji}`);
  }
}

db.close();
