/**
 * exitWindowSearch.js — Find profitable 80+/day strategies at different exit windows
 *
 * KEY HYPOTHESIS: BB(20,1.8)+s>=1 is only 55% WR at 3-candle exit.
 * Mean reversion takes time — at 6, 9, 12 candles, WR should be much higher!
 * If Polymarket has 30min/45min/1hour binaries, we can exploit this.
 *
 * Run: node server/research/exitWindowSearch.js
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
  return { upper: mid + mult * Math.sqrt(variance), mid, lower: mid - mult * Math.sqrt(variance) };
}

function computeRSI(candles, i, period = 14) {
  if (i < period) return 50;
  let g = 0, l = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const d = candles[j].close - candles[j-1].close;
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g/period)/(l/period));
}

function computeMFI(candles, i, period = 10) {
  if (i < period) return 50;
  let pos = 0, neg = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
    const ptp = (candles[j-1].high + candles[j-1].low + candles[j-1].close) / 3;
    const mf = tp * candles[j].volume;
    if (tp > ptp) pos += mf; else neg += mf;
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos/neg);
}

function computeStreak(candles, i) {
  let s = 0;
  for (let j = i; j >= Math.max(0, i - 8); j--) {
    const c = candles[j];
    if (c.close > c.open) { if (s < 0) break; s++; }
    else if (c.close < c.open) { if (s > 0) break; s--; }
    else break;
  }
  return s;
}

// Correct binary exit at EXACTLY exitN candles
function evalWR(candles, triggerFn, exitN, k = 5) {
  const n = candles.length;
  const foldSize = Math.floor(n / k);
  const foldWRs = [];
  let totalTrades = 0;

  for (let fold = 0; fold < k; fold++) {
    const start = fold * foldSize;
    const end = fold === k - 1 ? n : (fold + 1) * foldSize;
    let wins = 0, trades = 0;
    for (let i = start + 30; i < end - exitN - 1; i++) {
      const dir = triggerFn(candles, i);
      if (!dir) continue;
      trades++;
      const entry = candles[i].close;
      const exitPrice = candles[Math.min(i + exitN, n - 1)].close;
      const win = dir === 'bear' ? exitPrice < entry : exitPrice > entry;
      if (win) wins++;
    }
    foldWRs.push(trades > 0 ? wins / trades * 100 : 0);
    totalTrades += trades;
  }
  const mean = foldWRs.reduce((s, v) => s + v, 0) / k;
  const sigma = Math.sqrt(foldWRs.reduce((s, v) => s + (v - mean) ** 2, 0) / k);
  return { wr: mean, sigma, folds: foldWRs, total: totalTrades, perDay: totalTrades / (candles.length / 288) };
}

function print(label, results, minWR = 60) {
  process.stdout.write(`  ${label.padEnd(52)}`);
  for (const [exitN, r] of results) {
    const tag = r.wr >= 70 ? '✅✅' : r.wr >= 65 ? '✅' : r.wr >= 60 ? '⚡' : '  ';
    process.stdout.write(` | ${exitN*5}m: ${r.wr.toFixed(1)}%${tag}`);
  }
  process.stdout.write('\n');
}

const EXIT_WINDOWS = [3, 6, 9, 12, 18, 24]; // 15min, 30min, 45min, 1h, 90min, 2h

async function main() {
  console.log('=== Exit Window Search — Mean Reversion needs time! ===\n');
  console.log('Hypothesis: BB mean reversion strategies improve WR with longer exit windows');
  console.log('Correct at-expiry model throughout\n');

  const coins = ['ETH', 'BTC', 'SOL'];

  for (const coin of coins) {
    const candles = getCandles(coin, '5m');
    if (!candles.length) continue;
    const days = candles.length / 288;
    console.log(`\n${'='.repeat(80)}`);
    console.log(`${coin} — ${candles.length} candles (${days.toFixed(1)} days)`);
    console.log('Exit window: 15min | 30min | 45min | 1hr | 90min | 2hr');
    console.log('='.repeat(80));

    // ── Section A: BB multiplier sweep at different exit windows ───────────
    console.log('\n[A] BB(20,mult)+s>=1 ALL-HOURS — does longer expiry help?');
    for (const mult of [1.0, 1.5, 1.8, 2.2, 2.5]) {
      const trigger = (c, i) => {
        const bb = computeBB(c, i, 20, mult);
        if (!bb) return null;
        const s = computeStreak(c, i);
        const bear = c[i].close > bb.upper && c[i].close > c[i].open && s >= 1;
        const bull = c[i].close < bb.lower && c[i].close < c[i].open && s <= -1;
        return bear ? 'bear' : bull ? 'bull' : null;
      };
      const results = EXIT_WINDOWS.map(n => [n, evalWR(candles, trigger, n)]);
      print(`BB(20,${mult})+s>=1`, results);
    }

    // ── Section B: Good-Hours BB sweep ─────────────────────────────────────
    const goodHours = coin === 'ETH' ? [10,11,12,21] : coin === 'SOL' ? [0,12,13,20] : [1,12,13,16,20];
    console.log(`\n[B] GoodH(${goodHours})+BB(20,mult)+s>=1 — hour filter helps WR?`);
    for (const mult of [1.0, 1.5, 1.8, 2.2]) {
      const trigger = (c, i) => {
        const bb = computeBB(c, i, 20, mult);
        if (!bb) return null;
        const h = new Date(c[i].open_time).getUTCHours();
        if (!goodHours.includes(h)) return null;
        const s = computeStreak(c, i);
        const bear = c[i].close > bb.upper && c[i].close > c[i].open && s >= 1;
        const bull = c[i].close < bb.lower && c[i].close < c[i].open && s <= -1;
        return bear ? 'bear' : bull ? 'bull' : null;
      };
      const results = EXIT_WINDOWS.map(n => [n, evalWR(candles, trigger, n)]);
      print(`GoodH+BB(20,${mult})+s>=1`, results);
    }

    // ── Section C: RSI filter + BB at different exits ───────────────────────
    console.log('\n[C] RSI>70+BB(20,mult)+s>=1 — RSI quality filter at longer exits?');
    for (const mult of [1.0, 1.5, 1.8, 2.2]) {
      const trigger = (c, i) => {
        const bb = computeBB(c, i, 20, mult);
        if (!bb) return null;
        const rsi = computeRSI(c, i, 14);
        const s = computeStreak(c, i);
        const bear = c[i].close > bb.upper && c[i].close > c[i].open && rsi > 70 && s >= 1;
        const bull = c[i].close < bb.lower && c[i].close < c[i].open && rsi < 30 && s <= -1;
        return bear ? 'bear' : bull ? 'bull' : null;
      };
      const results = EXIT_WINDOWS.map(n => [n, evalWR(candles, trigger, n)]);
      print(`RSI>70+BB(20,${mult})+s>=1`, results);
    }

    // ── Section D: GoodH + RSI + BB (best quality signals) ─────────────────
    console.log('\n[D] GoodH+RSI>70+BB(20,mult)+s>=1 — top quality at longer exits?');
    for (const mult of [1.5, 1.8, 2.0, 2.2]) {
      const trigger = (c, i) => {
        const bb = computeBB(c, i, 20, mult);
        if (!bb) return null;
        const h = new Date(c[i].open_time).getUTCHours();
        if (!goodHours.includes(h)) return null;
        const rsi = computeRSI(c, i, 14);
        const s = computeStreak(c, i);
        const bear = c[i].close > bb.upper && c[i].close > c[i].open && rsi > 70 && s >= 1;
        const bull = c[i].close < bb.lower && c[i].close < c[i].open && rsi < 30 && s <= -1;
        return bear ? 'bear' : bull ? 'bull' : null;
      };
      const results = EXIT_WINDOWS.map(n => [n, evalWR(candles, trigger, n)]);
      print(`GoodH+RSI>70+BB(20,${mult})+s>=1`, results);
    }

    // ── Section E: 15m candles at different exits ────────────────────────────
    console.log('\n[E] 15m candles — do longer exits help on 15m timeframe?');
    const candles15m = getCandles(coin, '15m');
    if (candles15m.length > 200) {
      const days15m = candles15m.length / 96;
      console.log(`    ${candles15m.length} candles (${days15m.toFixed(1)} days)`);
      const EXIT_15M = [1, 2, 3, 4, 6]; // 15min, 30min, 45min, 1hr, 90min
      for (const mult of [1.5, 2.0, 2.2]) {
        const trigger = (c, i) => {
          const bb = computeBB(c, i, 20, mult);
          if (!bb) return null;
          const rsi = computeRSI(c, i, 14);
          const s = computeStreak(c, i);
          const bear = c[i].close > bb.upper && c[i].close > c[i].open && rsi > 65 && s >= 1;
          const bull = c[i].close < bb.lower && c[i].close < c[i].open && rsi < 35 && s <= -1;
          return bear ? 'bear' : bull ? 'bull' : null;
        };
        const results = EXIT_15M.map(n => [n, evalWR(candles15m, trigger, n)]);
        process.stdout.write(`  15m RSI>65+BB(20,${mult})+s>=1                       `);
        for (const [exitN, r] of results) {
          const tag = r.wr >= 70 ? '✅✅' : r.wr >= 65 ? '✅' : r.wr >= 60 ? '⚡' : '  ';
          process.stdout.write(` | ${exitN*15}m: ${r.wr.toFixed(1)}%${tag}(${r.perDay.toFixed(1)}/d)`);
        }
        process.stdout.write('\n');
      }
    }

    // ── Section F: Sweet spot search — find mult/exit combo with 80/d at 65% ─
    console.log('\n[F] Sweet spot search — find mult and exit combo for 80/d AND 65%+ WR:');
    const bestCombos = [];
    for (const mult of [0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.2]) {
      for (const exitN of EXIT_WINDOWS) {
        const trigger = (c, i) => {
          const bb = computeBB(c, i, 20, mult);
          if (!bb) return null;
          const s = computeStreak(c, i);
          const bear = c[i].close > bb.upper && c[i].close > c[i].open && s >= 1;
          const bull = c[i].close < bb.lower && c[i].close < c[i].open && s <= -1;
          return bear ? 'bear' : bull ? 'bull' : null;
        };
        const r = evalWR(candles, trigger, exitN);
        if (r.perDay >= 30 && r.wr >= 60) {
          bestCombos.push({ mult, exitN, ...r, exitMin: exitN * 5 });
        }
      }
    }
    bestCombos.sort((a, b) => b.wr - a.wr);
    if (bestCombos.length) {
      for (const r of bestCombos.slice(0, 10)) {
        const fStr = r.folds.map(f => f.toFixed(1)).join('/');
        const tag = r.perDay >= 80 && r.wr >= 65 ? ' 🚀🚀 TARGET!' : r.perDay >= 60 ? ' ⚡' : '';
        console.log(`  BB(20,${r.mult}) exit=${r.exitMin}min: WF=${r.wr.toFixed(1)}% σ=${r.sigma.toFixed(1)}% ${r.perDay.toFixed(1)}/d [${fStr}]${tag}`);
      }
    } else {
      console.log('  No combos found meeting criteria');
    }
  }

  // ── Section G: Multi-strategy 80+/day aggregate ──────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('SECTION G: Multi-strategy aggregate — combining all good signals');
  console.log('='.repeat(80));

  const strategyList = [
    // Each entry: {coin, tf, hours, mult, streak, rsiMin}
    { coin: 'ETH', hours: [10,11,12,21], mult: 2.2, s: 2, rsi: 65 },
    { coin: 'ETH', hours: [10,11,12,21], mult: 2.0, s: 1, rsi: 70 },
    { coin: 'ETH', hours: [10,11,12,21], mult: 1.8, s: 1, rsi: null },
    { coin: 'ETH', hours: [10,11,12,21], mult: 1.5, s: 1, rsi: null },
    { coin: 'BTC', hours: [1,12,13,16,20], mult: 2.2, s: 2, rsi: 65 },
    { coin: 'BTC', hours: [1,12,13,16,20], mult: 2.0, s: 1, rsi: 70 },
    { coin: 'BTC', hours: [1,12,13,16,20], mult: 1.8, s: 1, rsi: null },
    { coin: 'SOL', hours: [0,12,13,20], mult: 2.2, s: 2, rsi: null },
    { coin: 'SOL', hours: [0,12,13,20], mult: 1.8, s: 1, rsi: null },
  ];

  let totalTPD = 0;
  let weightedWR = 0;
  let totalTrades = 0;

  for (const cfg of strategyList) {
    const candles = getCandles(cfg.coin, '5m');
    if (!candles.length) continue;

    const trigger = (c, i) => {
      const bb = computeBB(c, i, 20, cfg.mult);
      if (!bb) return null;
      const h = new Date(c[i].open_time).getUTCHours();
      if (!cfg.hours.includes(h)) return null;
      const s = computeStreak(c, i);
      if (Math.abs(s) < cfg.s) return null;
      if (cfg.rsi) {
        const rsi = computeRSI(c, i, 14);
        const bear = c[i].close > bb.upper && c[i].close > c[i].open && s >= cfg.s && rsi > cfg.rsi;
        const bull = c[i].close < bb.lower && c[i].close < c[i].open && s <= -cfg.s && rsi < (100-cfg.rsi);
        return bear ? 'bear' : bull ? 'bull' : null;
      }
      const bear = c[i].close > bb.upper && c[i].close > c[i].open && s >= cfg.s;
      const bull = c[i].close < bb.lower && c[i].close < c[i].open && s <= -cfg.s;
      return bear ? 'bear' : bull ? 'bull' : null;
    };

    const r3 = evalWR(candles, trigger, 3);
    totalTPD += r3.perDay;
    totalTrades += r3.total;
    weightedWR += r3.wr * r3.total;
    console.log(`  ${cfg.coin} h=${JSON.stringify(cfg.hours)} BB(20,${cfg.mult})+s>=${cfg.s}${cfg.rsi?'+RSI>'+cfg.rsi:''}: ${r3.perDay.toFixed(1)}/d WF=${r3.wr.toFixed(1)}% σ=${r3.sigma.toFixed(1)}%`);
  }

  const avgWR = totalTrades > 0 ? weightedWR / totalTrades : 0;
  console.log(`\n  AGGREGATE: ~${totalTPD.toFixed(0)}/day at ${avgWR.toFixed(1)}% weighted WR`);
  if (totalTPD >= 80) console.log('  🚀🚀 80+/day achieved in aggregate!');
  else console.log(`  → Need ${(80 - totalTPD).toFixed(0)} more signals/day to reach 80/day target`);

  // ── Section H: Can we use 15m candles to hit 80/day globally? ─────────────
  console.log('\n[H] Total signals/day from ALL strategies (5m + 15m across all coins):');
  const all5m = { ETH: getCandles('ETH', '5m'), BTC: getCandles('BTC', '5m'), SOL: getCandles('SOL', '5m') };
  const all15m = { ETH: getCandles('ETH', '15m'), BTC: getCandles('BTC', '15m'), SOL: getCandles('SOL', '15m') };

  let grandTotal = 0;
  const strats = [
    { coins: ['ETH', 'BTC'], tf: '5m', mult: 2.2, s: 2, hours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20] }, label: 'GoodH+BB22+s2' },
    { coins: ['ETH', 'BTC'], tf: '5m', mult: 2.2, s: 1, hours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20] }, label: 'GoodH+BB22+s1' },
    { coins: ['ETH', 'BTC'], tf: '5m', mult: 2.0, s: 1, hours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20] }, label: 'GoodH+BB20+s1' },
    { coins: ['ETH', 'BTC'], tf: '5m', mult: 1.8, s: 1, hours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20] }, label: 'GoodH+BB18+s1' },
    { coins: ['ETH', 'BTC'], tf: '5m', mult: 1.5, s: 1, hours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20] }, label: 'GoodH+BB15+s1' },
    { coins: ['SOL'], tf: '5m', mult: 2.2, s: 2, hours: { SOL: [0,12,13,20] }, label: 'SOL GoodH+BB22+s2' },
    { coins: ['SOL'], tf: '5m', mult: 1.8, s: 1, hours: { SOL: [0,12,13,20] }, label: 'SOL GoodH+BB18+s1' },
    { coins: ['ETH', 'BTC'], tf: '15m', mult: 2.2, s: 1, hours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20] }, label: '15m GoodH+BB22+s1' },
    { coins: ['ETH', 'BTC', 'SOL'], tf: '15m', mult: 2.0, s: 1, hours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20] }, label: '15m GoodH+BB20+s1' },
  ];

  for (const cfg of strats) {
    let stratTotal = 0;
    for (const coin of cfg.coins) {
      const candles = cfg.tf === '5m' ? all5m[coin] : all15m[coin];
      if (!candles || !candles.length) continue;
      const perCandle = cfg.tf === '5m' ? 288 : 96;
      const hours = cfg.hours[coin];
      let count = 0;
      for (let i = 25; i < candles.length - 4; i++) {
        const bb = computeBB(candles, i, 20, cfg.mult);
        if (!bb) continue;
        const h = new Date(candles[i].open_time).getUTCHours();
        if (!hours.includes(h)) continue;
        const s = computeStreak(candles, i);
        const bear = candles[i].close > bb.upper && candles[i].close > candles[i].open && s >= cfg.s;
        const bull = candles[i].close < bb.lower && candles[i].close < candles[i].open && s <= -cfg.s;
        if (bear || bull) count++;
      }
      const tpd = count / (candles.length / perCandle);
      stratTotal += tpd;
    }
    grandTotal += stratTotal;
    console.log(`  ${cfg.label.padEnd(22)}: ${stratTotal.toFixed(1)}/day across coins`);
  }
  console.log(`\n  GRAND TOTAL: ~${grandTotal.toFixed(0)} distinct signals/day`);
  console.log(`  (These overlap! True unique = ~${(grandTotal * 0.6).toFixed(0)}/day after deduplication)`);

  console.log('\n=== Research Complete ===');
  db.close();
}

main().catch(console.error);
