/**
 * correctExitValidation.js — Re-validate key strategies with CORRECT binary exit
 *
 * Correct binary option exit: price at EXACTLY candle N (fixed expiry)
 * NOT: "any touch within N candles" (inflates WR)
 *
 * Run: node server/research/correctExitValidation.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../trader.db'));

function getCandles(symbol, tf) {
  return db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC`
  ).all(symbol, tf);
}

function computeBB(candles, i, period, mult) {
  if (i < period - 1) return null;
  const slice = candles.slice(i - period + 1, i + 1);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

function computeRSI(candles, i, period = 14) {
  if (i < period) return 50;
  let gains = 0, losses = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const d = candles[j].close - candles[j - 1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function computeMFI(candles, i, period = 10) {
  if (i < period) return 50;
  let pos = 0, neg = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
    const ptp = (candles[j - 1].high + candles[j - 1].low + candles[j - 1].close) / 3;
    const mf = tp * candles[j].volume;
    if (tp > ptp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function computeStreak(candles, i) {
  let streak = 0;
  for (let j = i; j >= Math.max(0, i - 8); j--) {
    const c = candles[j];
    if (c.close > c.open) { if (streak < 0) break; streak++; }
    else if (c.close < c.open) { if (streak > 0) break; streak--; }
    else break;
  }
  return streak;
}

// CORRECT exit: close at exactly exitN candles after signal
function exitCorrect(candles, i, exitN) {
  const exitIdx = Math.min(i + exitN, candles.length - 1);
  return candles[exitIdx].close;
}

// WRONG exit: any touch within N candles (the ultraHF80.js bug)
function exitAnyTouch(candles, i, exitN, isBear) {
  const entry = candles[i].close;
  for (let k = i + 1; k <= Math.min(i + exitN, candles.length - 1); k++) {
    if (isBear && candles[k].close < entry) return candles[k].close;  // "wins"
    if (!isBear && candles[k].close > entry) return candles[k].close; // "wins"
  }
  return candles[Math.min(i + exitN, candles.length - 1)].close; // held to expiry
}

function walkForward(candles, triggerFn, exitN = 3, k = 5, useWrongExit = false) {
  const foldSize = Math.floor(candles.length / k);
  const foldResults = [];
  for (let fold = 0; fold < k; fold++) {
    const start = fold * foldSize;
    const end = fold === k - 1 ? candles.length : (fold + 1) * foldSize;
    let wins = 0, total = 0;
    for (let i = start + 30; i < end - exitN - 1; i++) {
      const dir = triggerFn(candles, i);
      if (!dir) continue;
      total++;
      const entry = candles[i].close;
      const isBear = dir === 'bear';

      let exitPrice;
      if (useWrongExit) {
        exitPrice = exitAnyTouch(candles, i, exitN, isBear);
      } else {
        exitPrice = exitCorrect(candles, i, exitN);
      }
      const win = isBear ? exitPrice < entry : exitPrice > entry;
      if (win) wins++;
    }
    foldResults.push(total > 0 ? wins / total * 100 : 0);
  }
  const mean = foldResults.reduce((s, v) => s + v, 0) / k;
  const variance = foldResults.reduce((s, v) => s + (v - mean) ** 2, 0) / k;
  const days = candles.length / 288;
  const total = foldResults.reduce((s, v, i) => {
    // count trades in each fold
    return s;
  }, 0);
  return { mean, sigma: Math.sqrt(variance), folds: foldResults };
}

function countTrades(candles, triggerFn) {
  let total = 0;
  for (let i = 30; i < candles.length - 4; i++) {
    if (triggerFn(candles, i)) total++;
  }
  const days = candles.length / 288;
  return { total, perDay: total / days };
}

function evaluate(candles, triggerFn, label) {
  const { total, perDay } = countTrades(candles, triggerFn);
  if (total < 20) return null;
  const correct = walkForward(candles, triggerFn, 3, 5, false);
  const wrong = walkForward(candles, triggerFn, 3, 5, true);
  return { label, total, perDay, correct, wrong };
}

function print(r) {
  if (!r) return;
  const cFolds = r.correct.folds.map(f => f.toFixed(1)).join('/');
  const wFolds = r.wrong.folds.map(f => f.toFixed(1)).join('/');
  const profitable = r.correct.mean >= 60 ? ' ✅' : r.correct.mean >= 55 ? ' ⚠️' : ' ❌';
  console.log(`  ${r.label.padEnd(55)} T=${r.total}(${r.perDay.toFixed(1)}/d)`);
  console.log(`    CORRECT (at-expiry): WF=${r.correct.mean.toFixed(1)}% σ=${r.correct.sigma.toFixed(1)}% [${cFolds}]${profitable}`);
  console.log(`    WRONG (any-touch):   WF=${r.wrong.mean.toFixed(1)}% σ=${r.wrong.sigma.toFixed(1)}% [${wFolds}]`);
}

async function main() {
  console.log('=== Correct vs Wrong Exit Model Comparison ===\n');
  console.log('CORRECT: price close at exactly candle 3 (binary option at expiry)');
  console.log('WRONG:   any close below entry within 3 candles (inflated)\n');

  const coins = ['ETH', 'BTC', 'SOL'];

  for (const coin of coins) {
    const candles = getCandles(coin, '5m');
    if (!candles.length) continue;
    const days = candles.length / 288;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${coin} — ${candles.length} candles (${days.toFixed(1)} days)`);
    console.log('='.repeat(70));

    // ── Strat 67: HF40 BB(20,1.8)+s>=1 ────────────────────────────────────
    console.log('\n[A] Strat 67 — HF40 BB(20,1.8)+s>=1 (was claimed 71-73% WR):');
    {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.8);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && streak >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && streak <= -1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `${coin} BB(20,1.8)+s>=1`);
      print(r);
    }

    // ── Strat 68: HF80 BB(20,1.0)+s>=1 ────────────────────────────────────
    console.log('\n[B] Strat 68 — HF80 BB(20,1.0)+s>=1 (was claimed 71-72% WR):');
    {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.0);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && streak >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && streak <= -1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `${coin} BB(20,1.0)+s>=1`);
      print(r);
    }

    // ── Good strategies for comparison (TypeScript-validated) ───────────────
    console.log('\n[C] Good-Hours BB(20,2.2)+s>=2 (TypeScript validated ~61-67% WR):');
    {
      const goodHours = coin === 'ETH' ? [10,11,12,21] : coin === 'SOL' ? [0,12,13,20] : [1,12,13,16,20];
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 2.2);
        if (!bb) return null;
        const hour = new Date(c[i].open_time).getUTCHours();
        if (!goodHours.includes(hour)) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && streak >= 2;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && streak <= -2;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `${coin} GoodH+BB(20,2.2)+s>=2`);
      print(r);
    }

    // ── RSI Panic BB(20,2.2): TypeScript-validated ~71% WR ─────────────────
    if (coin === 'ETH') {
      console.log('\n[D] Strat 18 — RSI Panic BB(20,2.2) (TS validated 71.1% WR):');
      const goodHours = [10,11,12,21];
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 2.2);
        if (!bb) return null;
        const hour = new Date(c[i].open_time).getUTCHours();
        if (!goodHours.includes(hour)) return null;
        const rsi = computeRSI(c, i, 14);
        const body = Math.abs(c[i].close - c[i].open) / c[i].open * 100;
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && rsi > 70 && body >= 0.3;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && rsi < 30 && body >= 0.3;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `ETH RSI>70+body>=0.3%+GoodH+BB22`);
      print(r);
    }

    // ── BTC MFI Exhaustion: TypeScript-validated 70.4% WR ──────────────────
    if (coin === 'BTC') {
      console.log('\n[D] Strat 12 — BTC/15m MFI(10)>80+BB (TS validated 70.4% WR):');
      const c15m = getCandles('BTC', '15m');
      if (c15m.length) {
        const r = evaluate(c15m, (c, i) => {
          const bb = computeBB(c, i, 20, 2.0);
          if (!bb) return null;
          const mfi = computeMFI(c, i, 10);
          const streak = computeStreak(c, i);
          const isBear = c[i].close > bb.upper && c[i].close > c[i].open && mfi > 80 && streak >= 1;
          const isBull = c[i].close < bb.lower && c[i].close < c[i].open && mfi < 20 && streak <= -1;
          return isBear ? 'bear' : isBull ? 'bull' : null;
        }, `BTC/15m MFI>80+BB(20,2.0)+s>=1`);
        print(r);
      }
    }

    // ── BB(20,2.2) all-hours: baseline for comparison ──────────────────────
    console.log('\n[E] BB(20,2.2) all-hours baseline:');
    {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 2.2);
        if (!bb) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && streak >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && streak <= -1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `${coin} BB(20,2.2)+s>=1 all-hours`);
      print(r);
    }

    // ── NEW: BB(20,1.8) with hour filter — best of both worlds? ────────────
    console.log('\n[F] BB(20,1.8) + hour filter (can we get 80/d AND 60%+ WR?):');
    const goodHoursMap = { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20] };
    const gh = goodHoursMap[coin];
    {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.8);
        if (!bb) return null;
        const hour = new Date(c[i].open_time).getUTCHours();
        if (!gh.includes(hour)) return null;
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && streak >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && streak <= -1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `${coin} GoodH+BB(20,1.8)+s>=1`);
      print(r);
    }

    // ── NEW: RSI threshold on BB(20,1.8) — quality gate ───────────────────
    console.log('\n[G] BB(20,1.8) + RSI quality gate (multi-threshold search):');
    for (const rsiT of [60, 65, 70]) {
      const r = evaluate(candles, (c, i) => {
        const bb = computeBB(c, i, 20, 1.8);
        if (!bb) return null;
        const rsi = computeRSI(c, i, 14);
        const streak = computeStreak(c, i);
        const isBear = c[i].close > bb.upper && c[i].close > c[i].open && rsi > rsiT && streak >= 1;
        const isBull = c[i].close < bb.lower && c[i].close < c[i].open && rsi < (100-rsiT) && streak <= -1;
        return isBear ? 'bear' : isBull ? 'bull' : null;
      }, `${coin} RSI>${rsiT}+BB(20,1.8)+s>=1`);
      print(r);
    }

    // ── NEW: Correct 80+/day target — explore BB 1.0-1.5 at top-3 hours ──
    console.log('\n[H] NEW SEARCH — BB(1.0-1.5) at top-3 hours (highest WR per trade freq):');
    for (const mult of [1.0, 1.2, 1.5]) {
      for (const hours of [[12], [12,11,10], [12,11,10,13]]) {
        const r = evaluate(candles, (c, i) => {
          const bb = computeBB(c, i, 20, mult);
          if (!bb) return null;
          const hour = new Date(c[i].open_time).getUTCHours();
          if (!hours.includes(hour)) return null;
          const streak = computeStreak(c, i);
          const isBear = c[i].close > bb.upper && c[i].close > c[i].open && streak >= 1;
          const isBull = c[i].close < bb.lower && c[i].close < c[i].open && streak <= -1;
          return isBear ? 'bear' : isBull ? 'bull' : null;
        }, `${coin} h=[${hours}] BB(20,${mult})+s>=1`);
        print(r);
      }
    }
  }

  // ── Multi-coin aggregate summary ────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('MULTI-COIN AGGREGATE — All good strategies combined');
  console.log('='.repeat(70));
  console.log('\nEstimating total trades/day across all active strategies:');
  let totalTPD = 0;
  const stratSummary = [
    { coin: 'ETH', tf: '5m', name: 'GoodH+BB22+s>=2', mult: 2.2, hours: [10,11,12,21], s: 2 },
    { coin: 'ETH', tf: '5m', name: 'RSI18+GoodH+BB22', mult: 2.2, hours: [10,11,12,21], s: 1 },
    { coin: 'BTC', tf: '5m', name: 'GoodH+BB22+s>=1', mult: 2.2, hours: [1,12,13,16,20], s: 1 },
    { coin: 'SOL', tf: '5m', name: 'GoodH+BB22+s>=2', mult: 2.2, hours: [0,12,13,20], s: 2 },
  ];
  for (const cfg of stratSummary) {
    const c = getCandles(cfg.coin, cfg.tf);
    if (!c.length) continue;
    const { total, perDay } = countTrades(c, (candles, i) => {
      const bb = computeBB(candles, i, 20, cfg.mult);
      if (!bb) return null;
      const hour = new Date(candles[i].open_time).getUTCHours();
      if (!cfg.hours.includes(hour)) return null;
      const streak = computeStreak(candles, i);
      const isBear = candles[i].close > bb.upper && candles[i].close > candles[i].open && streak >= cfg.s;
      const isBull = candles[i].close < bb.lower && candles[i].close < candles[i].open && streak <= -cfg.s;
      return isBear ? 'bear' : isBull ? 'bull' : null;
    });
    totalTPD += perDay;
    console.log(`  ${cfg.coin} ${cfg.name}: ${perDay.toFixed(1)}/day`);
  }
  console.log(`  TOTAL GOOD STRATEGIES: ~${totalTPD.toFixed(0)} signals/day`);
  console.log(`  → For true 80+/day at good WR: need multi-coin multi-strategy aggregate`);

  console.log('\n=== Validation Complete ===');
  db.close();
}

main().catch(console.error);
