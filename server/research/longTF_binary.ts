#!/usr/bin/env node
/**
 * Long-TF Binary Strategy Deep Research — 15m / 1h / 4h Targets
 * ==============================================================
 *
 * Goal: Find strategies with 85%+ WR at longer binary timeframes
 * using multi-timeframe confirmation (1m+5m+15m+1h+4h).
 *
 * Core insight: Longer-expiry binaries are MORE predictable when:
 *   1. Extreme BB deviation (price well outside bands) → strong mean-reversion pull
 *   2. Multi-TF alignment: ALL timeframes agree on overextension
 *   3. Good hours: known high-WR UTC hours per coin
 *   4. Low volatility regime (ATR < avg) → stronger mean-reversion
 *   5. Volume exhaustion: spike then fade on the last candle before signal
 *
 * Strategy tiers (increasing WR, decreasing trades/day):
 *   Tier 1: 55-65% WR, 20+ trades/day  (Strats S1-S3)
 *   Tier 2: 65-75% WR, 10-20 trades/day (Strats S4-S6)
 *   Tier 3: 75-85% WR, 3-10 trades/day  (Strats S7-S9)
 *   Tier 4: 85%+ WR,   1-5 trades/day   (Strats S10-S12) ← TARGET
 *
 * Binary targets:
 *   - 15m binary: predict next 15m candle direction
 *   - 1h binary: predict next 1h candle direction
 *
 * Fee model: Polymarket 2% taker → break-even WR = 51.0%
 * Exit model: AT-EXPIRY (fixed binary payoff at candle close)
 *
 * Run: npx ts-node --project tsconfig.server.json server/research/longTF_binary.ts
 */

import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

const TAKER_FEE = 0.02;
const TRADE_SIZE = 10;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];

// Good hours per coin (validated from prior research)
const GOOD_HOURS: Record<string, number[]> = {
  BTC: [1, 12, 13, 16, 20],
  ETH: [10, 11, 12, 21],
  SOL: [0, 12, 13, 20],
  XRP: [6, 9, 12, 18],
};

// ─── Types ───────────────────────────────────────────────────────────────────
interface Candle { openTime: number; open: number; high: number; low: number; close: number; volume: number; }

// ─── Indicators ──────────────────────────────────────────────────────────────
function rsiArr(closes: number[], p: number): number[] {
  if (closes.length < p + 1) return closes.map(() => 50);
  const ch = closes.slice(1).map((c, i) => c - closes[i]);
  let ag = 0, al = 0;
  for (let i = 0; i < p; i++) { if (ch[i] > 0) ag += ch[i]; else al -= ch[i]; }
  ag /= p; al /= p;
  const r: number[] = new Array(p + 1).fill(50);
  for (let i = p; i < ch.length; i++) {
    if (ch[i] > 0) { ag = (ag * (p - 1) + ch[i]) / p; al = al * (p - 1) / p; }
    else { al = (al * (p - 1) - ch[i]) / p; ag = ag * (p - 1) / p; }
    r.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return r;
}

function bbArr(closes: number[], period: number, mult: number): { pctB: number; outside: number; dev: number; upper: number; lower: number; mid: number }[] {
  const result = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push({ pctB: 0.5, outside: 0, dev: 0, upper: closes[i], lower: closes[i], mid: closes[i] }); continue; }
    const sl = closes.slice(i - period + 1, i + 1);
    const mid = sl.reduce((s, v) => s + v, 0) / period;
    const std = Math.sqrt(sl.reduce((s, v) => s + (v - mid) ** 2, 0) / period);
    const upper = mid + mult * std;
    const lower = mid - mult * std;
    const last = closes[i];
    const pctB = (upper - lower) > 0 ? (last - lower) / (upper - lower) : 0.5;
    const outside = last > upper ? 1 : last < lower ? -1 : 0;
    const dev = outside === 1 ? (last - upper) / upper * 100
              : outside === -1 ? (lower - last) / lower * 100 : 0;
    result.push({ pctB, outside, dev, upper, lower, mid });
  }
  return result;
}

function atrArr(candles: Candle[], period: number): number[] {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  const result: number[] = [];
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = 0; i < candles.length; i++) {
    if (i < period) { result.push(trs[i]); continue; }
    atr = (atr * (period - 1) + trs[i]) / period;
    result.push(atr);
  }
  return result;
}

function emaArr(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) result.push(closes[i] * k + result[i - 1] * (1 - k));
  return result;
}

function mfiArr(candles: Candle[], period: number): number[] {
  const result: number[] = new Array(period).fill(50);
  for (let i = period; i < candles.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (candles[j].high + candles[j].low + candles[j].close) / 3;
      const prevTp = (candles[j - 1].high + candles[j - 1].low + candles[j - 1].close) / 3;
      const mf = tp * candles[j].volume;
      if (tp > prevTp) posFlow += mf; else negFlow += mf;
    }
    result.push(negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow));
  }
  return result;
}

// ─── Data Loading ─────────────────────────────────────────────────────────────
function loadCandles(symbol: string, tf: string): Candle[] {
  const rows = db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time ASC`
  ).all(symbol, tf) as any[];
  return rows.map(r => ({ openTime: r.open_time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

// ─── Strategy Evaluator ───────────────────────────────────────────────────────
type Signal = 'YES' | 'NO' | null;

interface EvalResult {
  trades: number; wins: number; wr: number; tpd: number;
  evPerTrade: number; evPerDay: number;
  yesWR: number; noWR: number; yesTrades: number; noTrades: number;
}

function evalAll(
  signals: Signal[], targets: number[], totalDays: number
): EvalResult {
  let t = 0, w = 0, yt = 0, yw = 0, nt = 0, nw = 0;
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    if (s === null) continue;
    t++;
    const win = s === 'YES' ? targets[i] === 1 : targets[i] === 0;
    if (win) w++;
    if (s === 'YES') { yt++; if (win) yw++; } else { nt++; if (win) nw++; }
  }
  const wr = t > 0 ? w / t : 0;
  const tpd = t / Math.max(1, totalDays);
  const netWin  = TRADE_SIZE * (1 - 0.50 - TAKER_FEE);
  const netLoss = TRADE_SIZE * 0.50;
  const evPerTrade = wr * netWin - (1 - wr) * netLoss;
  const evPerDay   = evPerTrade * tpd;
  return { trades: t, wins: w, wr, tpd, evPerTrade, evPerDay,
           yesWR: yt > 0 ? yw / yt : 0, noWR: nt > 0 ? nw / nt : 0, yesTrades: yt, noTrades: nt };
}

// ─── Walk-Forward ─────────────────────────────────────────────────────────────
function walkForward(signals: Signal[], targets: number[], totalDays: number, nFolds = 5) {
  const foldSize = Math.floor(signals.length / (nFolds + 1));
  const foldWRs: number[] = [];
  for (let fold = 1; fold <= nFolds; fold++) {
    const s = Math.min(fold * foldSize, signals.length - 1);
    const e = Math.min(s + foldSize, signals.length);
    if (e <= s) break;
    const res = evalAll(signals.slice(s, e), targets.slice(s, e), totalDays / (nFolds + 1));
    if (res.trades > 0) foldWRs.push(res.wr);
  }
  const avgWR = foldWRs.length > 0 ? foldWRs.reduce((a, b) => a + b, 0) / foldWRs.length : 0;
  const sigma = foldWRs.length > 1
    ? Math.sqrt(foldWRs.reduce((s, v) => s + (v - avgWR) ** 2, 0) / foldWRs.length) * 100 : 0;
  const full = evalAll(signals, targets, totalDays);
  const netWin  = TRADE_SIZE * (1 - 0.50 - TAKER_FEE);
  const netLoss = TRADE_SIZE * 0.50;
  const evPerTrade = avgWR * netWin - (1 - avgWR) * netLoss;
  return { wr: avgWR, sigma, tpd: full.tpd, ev: evPerTrade * full.tpd, folds: foldWRs };
}

// ─── Format ───────────────────────────────────────────────────────────────────
const pct = (v: number) => (v * 100).toFixed(1) + '%';
const dollar = (v: number) => (v >= 0 ? '+' : '') + '$' + v.toFixed(2);
const flag = (wr: number) => wr >= 0.85 ? ' 🔥🔥' : wr >= 0.75 ? ' ✅✅' : wr >= 0.65 ? ' ✅' : wr >= 0.55 ? ' ⚠️' : ' ❌';

function printRow(name: string, res: { wr: number; sigma: number; tpd: number; ev: number; folds: number[] }) {
  if (res.tpd === 0) { console.log(`  ${name.padEnd(36)} ${'—'.padStart(7)}`); return; }
  const fStr = res.folds.map(f => (f * 100).toFixed(0)).join('/');
  console.log(
    `  ${name.padEnd(36)} ${pct(res.wr).padStart(7)} ${(res.sigma.toFixed(1) + '%').padStart(6)} ` +
    `${res.tpd.toFixed(2).padStart(7)} ${dollar(res.ev).padStart(9)}  [${fStr}]${flag(res.wr)}`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1: 15M BINARY STRATEGIES
// Predict whether next 15m candle is green or red
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(78));
console.log('  PART 1 — 15m Binary Strategies (Predict next 15m candle)');
console.log('  Target: 85%+ WR | Fee-adjusted | At-expiry exit');
console.log('═'.repeat(78));
console.log(`  ${'Strategy'.padEnd(36)} ${'WR'.padStart(7)} ${'σ'.padStart(6)} ${'TPD'.padStart(7)} ${'EV/day'.padStart(9)}  Folds`);
console.log('  ' + '─'.repeat(75));

interface Strat15mResult { name: string; coin: string; wr: number; sigma: number; tpd: number; ev: number; }
const allStrat15m: Strat15mResult[] = [];

for (const coin of COINS) {
  // Load all timeframes
  const c1m  = loadCandles(coin, '1m');
  const c5m  = loadCandles(coin, '5m');
  const c15m = loadCandles(coin, '15m');
  const c1h  = loadCandles(coin, '1h');
  if (c15m.length < 200 || c5m.length < 200) { console.log(`  ${coin}: insufficient data`); continue; }

  const days = (c15m[c15m.length - 1].openTime - c15m[0].openTime) / 86_400_000;
  const goodH = new Set(GOOD_HOURS[coin] || []);

  // Pre-compute indicator arrays
  const closes15m = c15m.map(c => c.close);
  const closes5m  = c5m.map(c => c.close);
  const closes1h  = c1h.map(c => c.close);

  const rsi14_15m_arr = rsiArr(closes15m, 14);
  const rsi7_15m_arr  = rsiArr(closes15m, 7);
  const rsi14_5m_arr  = rsiArr(closes5m, 14);
  const rsi14_1h_arr  = rsiArr(closes1h, 14);
  const mfi14_15m_arr = mfiArr(c15m, 14);

  const bb22_15m_arr  = bbArr(closes15m, 20, 2.2);
  const bb20_15m_arr  = bbArr(closes15m, 20, 2.0);
  const bb18_15m_arr  = bbArr(closes15m, 20, 1.8);
  const bb22_5m_arr   = bbArr(closes5m, 20, 2.2);

  const atr14_15m_arr = atrArr(c15m, 14);
  const ema50_1h_arr  = emaArr(closes1h, 50);

  // Build 5m pointer index for 15m alignment
  let j5m = 0, j1h = 0;

  // Targets
  const targets15m: number[] = [];
  for (let i = 0; i < c15m.length - 1; i++) {
    targets15m.push(c15m[i + 1].close > c15m[i + 1].open ? 1 : 0);
  }

  // Helper: streak on 15m
  function streak15(i: number): number {
    let s = 0;
    for (let k = i; k >= Math.max(0, i - 8); k--) {
      const dir = c15m[k].close > c15m[k].open ? 1 : c15m[k].close < c15m[k].open ? -1 : 0;
      if (dir === 0) break;
      if (s === 0) { s = dir; continue; }
      if (Math.sign(dir) !== Math.sign(s)) break;
      s += dir;
    }
    return s;
  }

  // S1: BB(20,2.2) outside + RSI14>70/<30 + GoodH [Tier 2]
  const sigS1: Signal[] = [];
  for (let i = 50; i < c15m.length - 1; i++) {
    const bb  = bb22_15m_arr[i];
    const rsi = rsi14_15m_arr[i];
    const hr  = new Date(c15m[i].openTime).getUTCHours();
    if (!goodH.has(hr)) { sigS1.push(null); continue; }
    if (bb.outside === 0 || bb.dev < 0.08) { sigS1.push(null); continue; }
    if (bb.outside === 1 && rsi < 65) { sigS1.push(null); continue; }
    if (bb.outside === -1 && rsi > 35) { sigS1.push(null); continue; }
    sigS1.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // S2: BB(20,2.2)+RSI7>80/<20+GoodH+streak≥2 [Tier 3]
  const sigS2: Signal[] = [];
  for (let i = 50; i < c15m.length - 1; i++) {
    const bb   = bb22_15m_arr[i];
    const rsi7 = rsi7_15m_arr[i];
    const st   = streak15(i);
    const hr   = new Date(c15m[i].openTime).getUTCHours();
    if (!goodH.has(hr)) { sigS2.push(null); continue; }
    if (bb.outside === 0 || bb.dev < 0.10) { sigS2.push(null); continue; }
    if (bb.outside === 1 && (rsi7 < 80 || st < 2)) { sigS2.push(null); continue; }
    if (bb.outside === -1 && (rsi7 > 20 || st > -2)) { sigS2.push(null); continue; }
    sigS2.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // S3: MFI>80/<20 + BB(20,2.2) outside + GoodH [Tier 3]
  const sigS3: Signal[] = [];
  for (let i = 50; i < c15m.length - 1; i++) {
    const bb  = bb22_15m_arr[i];
    const mfi = mfi14_15m_arr[i];
    const hr  = new Date(c15m[i].openTime).getUTCHours();
    if (!goodH.has(hr)) { sigS3.push(null); continue; }
    if (bb.outside === 0 || bb.dev < 0.08) { sigS3.push(null); continue; }
    if (bb.outside === 1 && mfi < 75) { sigS3.push(null); continue; }
    if (bb.outside === -1 && mfi > 25) { sigS3.push(null); continue; }
    sigS3.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // S4: BB(20,2.2)+MFI>80+RSI7>80+GoodH+streak≥2+body>0.15% [Tier 4 target]
  const sigS4: Signal[] = [];
  for (let i = 50; i < c15m.length - 1; i++) {
    const bb   = bb22_15m_arr[i];
    const mfi  = mfi14_15m_arr[i];
    const rsi7 = rsi7_15m_arr[i];
    const st   = streak15(i);
    const hr   = new Date(c15m[i].openTime).getUTCHours();
    const c    = c15m[i];
    const body = Math.abs(c.close - c.open) / c.open * 100;
    if (!goodH.has(hr)) { sigS4.push(null); continue; }
    if (bb.outside === 0 || bb.dev < 0.12) { sigS4.push(null); continue; }
    if (body < 0.15) { sigS4.push(null); continue; }
    if (bb.outside === 1 && (mfi < 78 || rsi7 < 78 || st < 2)) { sigS4.push(null); continue; }
    if (bb.outside === -1 && (mfi > 22 || rsi7 > 22 || st > -2)) { sigS4.push(null); continue; }
    sigS4.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // S5: TRIPLE LOCK — BB(20,2.2)+MFI>82+RSI14>72+RSI7>82+GoodH+streak≥3 [Tier 4]
  const sigS5: Signal[] = [];
  for (let i = 50; i < c15m.length - 1; i++) {
    const bb    = bb22_15m_arr[i];
    const mfi   = mfi14_15m_arr[i];
    const rsi14 = rsi14_15m_arr[i];
    const rsi7  = rsi7_15m_arr[i];
    const st    = streak15(i);
    const hr    = new Date(c15m[i].openTime).getUTCHours();
    const c     = c15m[i];
    const body  = Math.abs(c.close - c.open) / c.open * 100;
    if (!goodH.has(hr)) { sigS5.push(null); continue; }
    if (bb.outside === 0 || bb.dev < 0.15) { sigS5.push(null); continue; }
    if (body < 0.20) { sigS5.push(null); continue; }
    if (bb.outside === 1 && (mfi < 80 || rsi14 < 70 || rsi7 < 80 || st < 3)) { sigS5.push(null); continue; }
    if (bb.outside === -1 && (mfi > 20 || rsi14 > 30 || rsi7 > 20 || st > -3)) { sigS5.push(null); continue; }
    sigS5.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // S6: ALL-HOURS BB(20,1.8)+RSI7>75+streak≥1 (high-frequency, lower WR but many trades)
  const sigS6: Signal[] = [];
  for (let i = 20; i < c15m.length - 1; i++) {
    const bb   = bb18_15m_arr[i];
    const rsi7 = rsi7_15m_arr[i];
    const st   = streak15(i);
    if (bb.outside === 0 || bb.dev < 0.05) { sigS6.push(null); continue; }
    if (bb.outside === 1 && (rsi7 < 72 || st < 1)) { sigS6.push(null); continue; }
    if (bb.outside === -1 && (rsi7 > 28 || st > -1)) { sigS6.push(null); continue; }
    sigS6.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // S7: 5m aligned — 5m AND 15m both outside BB22 in same direction + GoodH
  j5m = 0;
  const sigS7: Signal[] = [];
  for (let i = 50; i < c15m.length - 1; i++) {
    const bb15 = bb22_15m_arr[i];
    const hr   = new Date(c15m[i].openTime).getUTCHours();
    if (!goodH.has(hr) || bb15.outside === 0 || bb15.dev < 0.08) { sigS7.push(null); continue; }

    // Find corresponding 5m candle
    while (j5m < c5m.length - 1 && c5m[j5m + 1].openTime <= c15m[i].openTime) j5m++;
    const bb5 = bb22_5m_arr[j5m] ?? { outside: 0, dev: 0 };

    // Both TFs agree
    if (bb5.outside !== bb15.outside || bb5.dev < 0.06) { sigS7.push(null); continue; }
    const rsi14 = rsi14_15m_arr[i];
    if (bb15.outside === 1 && rsi14 < 65) { sigS7.push(null); continue; }
    if (bb15.outside === -1 && rsi14 > 35) { sigS7.push(null); continue; }
    sigS7.push(bb15.outside === 1 ? 'NO' : 'YES');
  }

  // S8: 1h regime aligned + BB22 15m + RSI7>78 + GoodH [Tier 4]
  j1h = 0;
  const sigS8: Signal[] = [];
  for (let i = 60; i < c15m.length - 1; i++) {
    const bb15 = bb22_15m_arr[i];
    const rsi7 = rsi7_15m_arr[i];
    const hr   = new Date(c15m[i].openTime).getUTCHours();
    if (!goodH.has(hr) || bb15.outside === 0 || bb15.dev < 0.12) { sigS8.push(null); continue; }
    if (bb15.outside === 1 && rsi7 < 76) { sigS8.push(null); continue; }
    if (bb15.outside === -1 && rsi7 > 24) { sigS8.push(null); continue; }

    // 1h regime: price > EMA50 on 1h suggests uptrend → better for bearish fade above BB
    while (j1h < c1h.length - 1 && c1h[j1h + 1].openTime <= c15m[i].openTime) j1h++;
    const ema50 = ema50_1h_arr[j1h] ?? closes1h[j1h];
    const aboveEma = closes1h[j1h] > ema50;
    const rsi1h    = rsi14_1h_arr[j1h] ?? 50;

    // Aligned: above EMA + overbought 1h + above BB 15m = strong fade signal
    if (bb15.outside === 1 && (!aboveEma || rsi1h < 55)) { sigS8.push(null); continue; }
    if (bb15.outside === -1 && (aboveEma || rsi1h > 45)) { sigS8.push(null); continue; }
    sigS8.push(bb15.outside === 1 ? 'NO' : 'YES');
  }

  // S9: ULTRA SELECTIVE — ATR contraction + triple lock + 1h aligned [Target 85%+]
  j1h = 0;
  const sigS9: Signal[] = [];
  for (let i = 60; i < c15m.length - 1; i++) {
    const bb15  = bb22_15m_arr[i];
    const mfi   = mfi14_15m_arr[i];
    const rsi14 = rsi14_15m_arr[i];
    const rsi7  = rsi7_15m_arr[i];
    const st    = streak15(i);
    const hr    = new Date(c15m[i].openTime).getUTCHours();
    const c     = c15m[i];
    const body  = Math.abs(c.close - c.open) / c.open * 100;
    // ATR: current vs avg (low volatility = stronger reversion)
    const atr     = atr14_15m_arr[i];
    const avgAtr  = atr14_15m_arr.slice(Math.max(0, i - 20), i).reduce((s, v) => s + v, 0) / 20;
    const lowVol  = atr < avgAtr * 0.85;

    if (!goodH.has(hr)) { sigS9.push(null); continue; }
    if (bb15.outside === 0 || bb15.dev < 0.18) { sigS9.push(null); continue; }
    if (body < 0.20) { sigS9.push(null); continue; }
    if (!lowVol) { sigS9.push(null); continue; } // need volatility contraction

    if (bb15.outside === 1 && (mfi < 80 || rsi14 < 68 || rsi7 < 80 || st < 2)) { sigS9.push(null); continue; }
    if (bb15.outside === -1 && (mfi > 20 || rsi14 > 32 || rsi7 > 20 || st > -2)) { sigS9.push(null); continue; }

    while (j1h < c1h.length - 1 && c1h[j1h + 1].openTime <= c15m[i].openTime) j1h++;
    const ema50 = ema50_1h_arr[j1h] ?? closes1h[j1h];
    const rsi1h = rsi14_1h_arr[j1h] ?? 50;
    const aboveEma = closes1h[j1h] > ema50;
    if (bb15.outside === 1 && (!aboveEma || rsi1h < 58)) { sigS9.push(null); continue; }
    if (bb15.outside === -1 && (aboveEma || rsi1h > 42)) { sigS9.push(null); continue; }

    sigS9.push(bb15.outside === 1 ? 'NO' : 'YES');
  }

  const strategies = [
    { name: `${coin}/15m S1 BB22+RSI+GoodH`,           sigs: sigS1, tgt: targets15m.slice(0, sigS1.length) },
    { name: `${coin}/15m S2 BB22+RSI7>80+streak≥2`,    sigs: sigS2, tgt: targets15m.slice(0, sigS2.length) },
    { name: `${coin}/15m S3 MFI+BB22+GoodH`,           sigs: sigS3, tgt: targets15m.slice(0, sigS3.length) },
    { name: `${coin}/15m S4 MFI+RSI7+BB22+body`,       sigs: sigS4, tgt: targets15m.slice(0, sigS4.length) },
    { name: `${coin}/15m S5 TRIPLE-LOCK+streak≥3`,     sigs: sigS5, tgt: targets15m.slice(0, sigS5.length) },
    { name: `${coin}/15m S6 BB18+RSI7+All-H`,          sigs: sigS6, tgt: targets15m.slice(0, sigS6.length) },
    { name: `${coin}/15m S7 5m+15m dual-BB22`,         sigs: sigS7, tgt: targets15m.slice(0, sigS7.length) },
    { name: `${coin}/15m S8 1h-regime+BB22+RSI7`,      sigs: sigS8, tgt: targets15m.slice(0, sigS8.length) },
    { name: `${coin}/15m S9 ULTRA(ATR+3lock+1h)`,      sigs: sigS9, tgt: targets15m.slice(0, sigS9.length) },
  ];

  for (const { name, sigs, tgt } of strategies) {
    const res = walkForward(sigs, tgt, days);
    printRow(name, res);
    if (res.tpd > 0) allStrat15m.push({ name, coin, ...res });
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2: 1H BINARY STRATEGIES
// Predict whether next 1h candle is green or red
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(78));
console.log('  PART 2 — 1h Binary Strategies (Predict next 1h candle)');
console.log('  Target: 85%+ WR | Multi-TF: 15m+1h+4h confirmation');
console.log('═'.repeat(78));
console.log(`  ${'Strategy'.padEnd(36)} ${'WR'.padStart(7)} ${'σ'.padStart(6)} ${'TPD'.padStart(7)} ${'EV/day'.padStart(9)}  Folds`);
console.log('  ' + '─'.repeat(75));

interface Strat1hResult { name: string; coin: string; wr: number; sigma: number; tpd: number; ev: number; }
const allStrat1h: Strat1hResult[] = [];

for (const coin of COINS) {
  const c15m = loadCandles(coin, '15m');
  const c1h  = loadCandles(coin, '1h');
  if (c1h.length < 200) { console.log(`  ${coin}: insufficient 1h data`); continue; }

  const days = (c1h[c1h.length - 1].openTime - c1h[0].openTime) / 86_400_000;
  const goodH = new Set(GOOD_HOURS[coin] || []);

  const closes1h  = c1h.map(c => c.close);
  const closes15m = c15m.map(c => c.close);

  const rsi14_1h_arr = rsiArr(closes1h, 14);
  const rsi7_1h_arr  = rsiArr(closes1h, 7);
  const mfi14_1h_arr = mfiArr(c1h, 14);
  const bb22_1h_arr  = bbArr(closes1h, 20, 2.2);
  const bb20_1h_arr  = bbArr(closes1h, 20, 2.0);
  const atr14_1h_arr = atrArr(c1h, 14);
  const ema50_1h_arr = emaArr(closes1h, 50);
  const bb22_15m_arr = bbArr(closes15m, 20, 2.2);

  // Targets for 1h: is next 1h candle green?
  const targets1h = c1h.slice(0, -1).map((_, i) => c1h[i + 1].close > c1h[i + 1].open ? 1 : 0);

  function streak1h(i: number): number {
    let s = 0;
    for (let k = i; k >= Math.max(0, i - 8); k--) {
      const dir = c1h[k].close > c1h[k].open ? 1 : c1h[k].close < c1h[k].open ? -1 : 0;
      if (dir === 0) break;
      if (s === 0) { s = dir; continue; }
      if (Math.sign(dir) !== Math.sign(s)) break;
      s += dir;
    }
    return s;
  }

  let j15m = 0;

  // H1: BB22+RSI14+GoodH
  const hSig1: Signal[] = [];
  for (let i = 50; i < c1h.length - 1; i++) {
    const bb  = bb22_1h_arr[i];
    const rsi = rsi14_1h_arr[i];
    const hr  = new Date(c1h[i].openTime).getUTCHours();
    if (!goodH.has(hr) || bb.outside === 0 || bb.dev < 0.12) { hSig1.push(null); continue; }
    if (bb.outside === 1 && rsi < 65) { hSig1.push(null); continue; }
    if (bb.outside === -1 && rsi > 35) { hSig1.push(null); continue; }
    hSig1.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // H2: BB22+MFI>75+RSI7>75+GoodH+streak≥2
  const hSig2: Signal[] = [];
  for (let i = 50; i < c1h.length - 1; i++) {
    const bb   = bb22_1h_arr[i];
    const mfi  = mfi14_1h_arr[i];
    const rsi7 = rsi7_1h_arr[i];
    const st   = streak1h(i);
    const hr   = new Date(c1h[i].openTime).getUTCHours();
    const c    = c1h[i];
    const body = Math.abs(c.close - c.open) / c.open * 100;
    if (!goodH.has(hr) || bb.outside === 0 || bb.dev < 0.15) { hSig2.push(null); continue; }
    if (body < 0.30) { hSig2.push(null); continue; }
    if (bb.outside === 1 && (mfi < 75 || rsi7 < 75 || st < 2)) { hSig2.push(null); continue; }
    if (bb.outside === -1 && (mfi > 25 || rsi7 > 25 || st > -2)) { hSig2.push(null); continue; }
    hSig2.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // H3: ULTRA 1h — all indicators + 15m aligned + ATR contraction [target 85%+]
  j15m = 0;
  const hSig3: Signal[] = [];
  for (let i = 55; i < c1h.length - 1; i++) {
    const bb   = bb22_1h_arr[i];
    const mfi  = mfi14_1h_arr[i];
    const rsi14= rsi14_1h_arr[i];
    const rsi7 = rsi7_1h_arr[i];
    const st   = streak1h(i);
    const hr   = new Date(c1h[i].openTime).getUTCHours();
    const c    = c1h[i];
    const body = Math.abs(c.close - c.open) / c.open * 100;
    const atr    = atr14_1h_arr[i];
    const avgAtr = atr14_1h_arr.slice(Math.max(0, i - 20), i).reduce((s, v) => s + v, 0) / 20;
    const ema50  = ema50_1h_arr[Math.max(0, i - 1)];
    const aboveEma = c1h[i].close > ema50;

    if (!goodH.has(hr) || bb.outside === 0 || bb.dev < 0.20) { hSig3.push(null); continue; }
    if (body < 0.35) { hSig3.push(null); continue; }
    if (atr > avgAtr * 0.9) { hSig3.push(null); continue; } // ATR contraction

    if (bb.outside === 1 && (mfi < 78 || rsi14 < 68 || rsi7 < 78 || st < 2 || !aboveEma)) {
      hSig3.push(null); continue;
    }
    if (bb.outside === -1 && (mfi > 22 || rsi14 > 32 || rsi7 > 22 || st > -2 || aboveEma)) {
      hSig3.push(null); continue;
    }

    // 15m confirmation: also outside BB22 in same direction
    while (j15m < c15m.length - 1 && c15m[j15m + 1].openTime <= c1h[i].openTime) j15m++;
    const bb15 = bb22_15m_arr[j15m] ?? { outside: 0, dev: 0 };
    if (bb15.outside !== bb.outside || bb15.dev < 0.08) { hSig3.push(null); continue; }

    hSig3.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  // H4: All-Hours 1h BB20 + RSI7>72 [high frequency for 1h]
  const hSig4: Signal[] = [];
  for (let i = 20; i < c1h.length - 1; i++) {
    const bb   = bb20_1h_arr[i];
    const rsi7 = rsi7_1h_arr[i];
    const st   = streak1h(i);
    if (bb.outside === 0 || bb.dev < 0.10) { hSig4.push(null); continue; }
    if (bb.outside === 1 && (rsi7 < 70 || st < 1)) { hSig4.push(null); continue; }
    if (bb.outside === -1 && (rsi7 > 30 || st > -1)) { hSig4.push(null); continue; }
    hSig4.push(bb.outside === 1 ? 'NO' : 'YES');
  }

  const strategies = [
    { name: `${coin}/1h H1 BB22+RSI+GoodH`,         sigs: hSig1, tgt: targets1h.slice(0, hSig1.length) },
    { name: `${coin}/1h H2 MFI+RSI7+streak≥2`,      sigs: hSig2, tgt: targets1h.slice(0, hSig2.length) },
    { name: `${coin}/1h H3 ULTRA(3lock+15m+ATR)`,   sigs: hSig3, tgt: targets1h.slice(0, hSig3.length) },
    { name: `${coin}/1h H4 AllH BB20+RSI7`,          sigs: hSig4, tgt: targets1h.slice(0, hSig4.length) },
  ];

  for (const { name, sigs, tgt } of strategies) {
    const res = walkForward(sigs, tgt, days);
    printRow(name, res);
    if (res.tpd > 0) allStrat1h.push({ name, coin, ...res });
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED SUMMARY — TOP PERFORMERS
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(78));
console.log('  COMBINED SUMMARY — ALL TIMEFRAMES — RANKED BY WR');
console.log('═'.repeat(78));

const allResults = [
  ...allStrat15m.map(r => ({ ...r, tf: '15m' })),
  ...allStrat1h.map(r => ({ ...r, tf: '1h' })),
].sort((a, b) => b.wr - a.wr);

console.log(`\n  ${'Strategy'.padEnd(40)} ${'WR'.padStart(7)} ${'σ'.padStart(6)} ${'TPD'.padStart(7)} ${'EV/day'.padStart(9)}`);
console.log('  ' + '─'.repeat(72));

const implementable = allResults.filter(r => r.tpd >= 0.5);
for (const r of implementable.slice(0, 25)) {
  const name = r.name.length > 40 ? r.name.slice(0, 37) + '...' : r.name;
  const f = r.wr >= 0.85 ? ' 🔥🔥' : r.wr >= 0.75 ? ' ✅✅' : r.wr >= 0.65 ? ' ✅' : r.wr >= 0.55 ? ' ⚠️' : ' ❌';
  console.log(`  ${name.padEnd(40)} ${pct(r.wr).padStart(7)} ${(r.sigma.toFixed(1) + '%').padStart(6)} ${r.tpd.toFixed(2).padStart(7)} ${dollar(r.ev).padStart(9)}${f}`);
}

console.log('\n  🔥🔥 = 85%+ WR (ULTRA)  |  ✅✅ = 75%+ WR  |  ✅ = 65%+  |  ⚠️ = 55%+');

// ─── Strategies crossing 85%+ WR ──────────────────────────────────────────────
const ultra = allResults.filter(r => r.wr >= 0.83 && r.tpd >= 0.3);
if (ultra.length > 0) {
  console.log('\n' + '═'.repeat(78));
  console.log('  🔥 ULTRA HIGH-WR STRATEGIES (83%+) — IMPLEMENTATION CANDIDATES 🔥');
  console.log('═'.repeat(78));
  for (const r of ultra) {
    console.log(`\n  ${r.name}`);
    console.log(`  WR: ${pct(r.wr)} | σ: ${r.sigma.toFixed(1)}% | TPD: ${r.tpd.toFixed(2)} | EV/day: ${dollar(r.ev)}`);
    const fStr = (r as any).folds?.map((f: number) => (f * 100).toFixed(0)).join('/') ?? '';
    if (fStr) console.log(`  Walk-forward folds: [${fStr}]`);
  }
} else {
  console.log('\n  No strategies crossed 83%+ WR threshold — highest-WR strategies shown above.');
  console.log('  Tip: Look for coin+hour combinations with ≥75% WR for reliable production use.');
}

console.log('\n' + '═'.repeat(78) + '\n');
db.close();
