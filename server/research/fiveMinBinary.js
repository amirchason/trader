/**
 * fiveMinBinary.js — 5-minute Polymarket binary options research
 *
 * KEY INSIGHT: 5m Polymarket binary = entry at candle i close, exit at candle i+1 close
 * Exit = EXACTLY 1 candle (5 minutes), NOT 3 candles (15 minutes)!
 *
 * Our previous "correctExitValidation.js" used exit at candle 3 = 15min binary model.
 * This script uses the TRUE 5m binary model: exit at candle +1.
 *
 * Goal: Find 80+/day strategy with profitable WR on true 5m binaries
 * Walk-forward: 5-fold (each fold = ~37 days)
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

// ─── Load Historical Candles ──────────────────────────────────────────────────

function loadCandles(symbol, timeframe, limit = 100000) {
  const rows = db.prepare(`
    SELECT open_time, open, high, low, close, volume
    FROM candles
    WHERE symbol = ? AND timeframe = ?
    ORDER BY open_time ASC
    LIMIT ?
  `).all(symbol, timeframe, limit);
  return rows.map(r => ({
    openTime: r.open_time,
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function calcBB(slice, period, mult) {
  if (slice.length < period) return null;
  const closes = slice.slice(-period).map(c => c.close);
  const sma = closes.reduce((s,v) => s+v, 0) / period;
  const variance = closes.reduce((s,v) => s + (v-sma)**2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = sma + mult * std;
  const lower = sma - mult * std;
  const dev = (slice[slice.length-1].close - sma) / std; // signed deviations
  return { upper, mid: sma, lower, std, dev };
}

function calcRSI(slice, period = 14) {
  if (slice.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = slice.length - period; i < slice.length; i++) {
    const d = slice[i].close - slice[i-1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains/period) / (losses/period));
}

function calcRSI7(slice) { return calcRSI(slice, 7); }

function calcMFI(slice, period = 14) {
  if (slice.length < period + 1) return 50;
  let pos = 0, neg = 0;
  for (let i = slice.length - period; i < slice.length; i++) {
    const tp = (slice[i].high + slice[i].low + slice[i].close) / 3;
    const prevTp = (slice[i-1].high + slice[i-1].low + slice[i-1].close) / 3;
    const f = tp * slice[i].volume;
    if (tp > prevTp) pos += f; else neg += f;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}

function calcStoch(slice, period = 5) {
  if (slice.length < period) return 50;
  const s = slice.slice(-period);
  const lo = Math.min(...s.map(c=>c.low));
  const hi = Math.max(...s.map(c=>c.high));
  if (hi === lo) return 50;
  return (slice[slice.length-1].close - lo) / (hi - lo) * 100;
}

function calcATR(slice, period = 14) {
  if (slice.length < 2) return 0;
  const trs = [];
  for (let i = Math.max(1, slice.length - period); i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low - slice[i-1].close)
    );
    trs.push(tr);
  }
  return trs.reduce((s,v) => s+v, 0) / trs.length;
}

function calcStreak(slice) {
  const last = slice[slice.length-1];
  const isGreen = last.close > last.open;
  let streak = 0;
  for (let i = slice.length-1; i >= 0; i--) {
    if ((slice[i].close > slice[i].open) !== isGreen) break;
    streak++;
  }
  return isGreen ? streak : -streak;
}

function calcEMA(slice, period) {
  if (slice.length < period) return slice[slice.length-1].close;
  const k = 2 / (period + 1);
  let ema = slice[slice.length - period].close;
  for (let i = slice.length - period + 1; i < slice.length; i++) {
    ema = slice[i].close * k + ema * (1 - k);
  }
  return ema;
}

// ─── Core Engine — 5m Binary (exit = candle +1) ───────────────────────────────

function runStrategy(candles, filterFn, numFolds = 5) {
  const foldSize = Math.floor(candles.length / numFolds);
  const foldResults = [];

  for (let fold = 0; fold < numFolds; fold++) {
    const testStart = fold * foldSize;
    const testEnd = testStart + foldSize;
    const test = candles.slice(testStart, testEnd);
    let wins = 0, total = 0;

    for (let i = 60; i < test.length - 1; i++) {  // -1 for exit candle
      const slice = test.slice(Math.max(0, i - 100), i + 1);
      const last = slice[slice.length-1];
      const signal = filterFn(slice, last);
      if (!signal) continue;

      // TRUE 5m binary exit: close of NEXT candle (i+1)
      const exitClose = test[i + 1].close;
      total++;
      if (signal === 'bear' && exitClose < last.close) wins++;
      if (signal === 'bull' && exitClose > last.close) wins++;
    }

    foldResults.push({ wr: total > 0 ? wins/total*100 : 0, total });
  }

  const avgWR = foldResults.reduce((s,f) => s+f.wr, 0) / numFolds;
  const totalT = foldResults.reduce((s,f) => s+f.total, 0);
  const std = Math.sqrt(foldResults.reduce((s,f) => s+(f.wr-avgWR)**2, 0) / numFolds);
  const tpd = totalT / (candles.length / 288);
  const fStr = foldResults.map(f => f.wr.toFixed(1)).join('/');
  return { avgWR, std, totalT, tpd, fStr };
}

// ─── Strategy Definitions ─────────────────────────────────────────────────────

const ETH_GOOD_H = [10,11,12,21];
const BTC_GOOD_H = [1,12,13,16,20];
const SOL_GOOD_H = [0,12,13,20];

function makeConfigs(goodH) {
  return [
    // Section A: Pure BB variants — all hours
    { name: 'ALL-H BB(20,1.0)+s>=1',     fn: (sl,l) => {
      const bb=calcBB(sl,20,1.0), s=calcStreak(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1) return 'bull';
      return null;
    }},
    { name: 'ALL-H BB(20,1.5)+s>=1',     fn: (sl,l) => {
      const bb=calcBB(sl,20,1.5), s=calcStreak(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1) return 'bull';
      return null;
    }},
    { name: 'ALL-H BB(20,1.8)+s>=1',     fn: (sl,l) => {
      const bb=calcBB(sl,20,1.8), s=calcStreak(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1) return 'bull';
      return null;
    }},
    { name: 'ALL-H BB(20,2.2)+s>=1',     fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1) return 'bull';
      return null;
    }},

    // Section B: RSI filter — all hours
    { name: 'ALL-H RSI>70+BB(20,2.2)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30) return 'bull';
      return null;
    }},
    { name: 'ALL-H RSI>70+BB(20,1.8)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,1.8), s=calcStreak(sl), rsi=calcRSI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30) return 'bull';
      return null;
    }},
    { name: 'ALL-H RSI>75+BB(20,2.2)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>75) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<25) return 'bull';
      return null;
    }},
    { name: 'ALL-H RSI7>75+BB(20,2.2)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI7(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>75) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<25) return 'bull';
      return null;
    }},
    { name: 'ALL-H RSI7>75+BB(20,1.8)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,1.8), s=calcStreak(sl), rsi=calcRSI7(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>75) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<25) return 'bull';
      return null;
    }},

    // Section C: MFI filter — all hours
    { name: 'ALL-H MFI>75+BB(20,2.2)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), mfi=calcMFI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && mfi>75) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && mfi<25) return 'bull';
      return null;
    }},
    { name: 'ALL-H MFI>80+BB(20,2.2)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), mfi=calcMFI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && mfi>80) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && mfi<20) return 'bull';
      return null;
    }},
    { name: 'ALL-H MFI>80+BB(20,1.8)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,1.8), s=calcStreak(sl), mfi=calcMFI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && mfi>80) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && mfi<20) return 'bull';
      return null;
    }},

    // Section D: RSI+MFI dual — all hours
    { name: 'ALL-H RSI>70+MFI>70+BB(20,2.2)', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl), mfi=calcMFI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70 && mfi>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30 && mfi<30) return 'bull';
      return null;
    }},
    { name: 'ALL-H RSI>70+MFI>70+BB(20,1.8)', fn: (sl,l) => {
      const bb=calcBB(sl,20,1.8), s=calcStreak(sl), rsi=calcRSI(sl), mfi=calcMFI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70 && mfi>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30 && mfi<30) return 'bull';
      return null;
    }},

    // Section E: Body filter (panic candles)
    { name: 'ALL-H body>=0.3%+RSI>70+BB(20,2.2)', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl);
      const body = Math.abs(l.close-l.open)/l.open;
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70 && body>=0.003) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30 && body>=0.003) return 'bull';
      return null;
    }},
    { name: 'ALL-H body>=0.2%+RSI>70+BB(20,1.8)', fn: (sl,l) => {
      const bb=calcBB(sl,20,1.8), s=calcStreak(sl), rsi=calcRSI(sl);
      const body = Math.abs(l.close-l.open)/l.open;
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70 && body>=0.002) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30 && body>=0.002) return 'bull';
      return null;
    }},

    // Section F: Good Hours filter (validated hours per coin)
    { name: 'GoodH+BB(20,2.2)+s>=2',          fn: (sl,l) => {
      const h=new Date(l.openTime).getUTCHours();
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl);
      if (!goodH.includes(h) || !bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=2) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-2) return 'bull';
      return null;
    }},
    { name: 'GoodH+RSI>70+BB(20,2.2)+s>=1',   fn: (sl,l) => {
      const h=new Date(l.openTime).getUTCHours();
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl);
      if (!goodH.includes(h) || !bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30) return 'bull';
      return null;
    }},
    { name: 'GoodH+RSI>70+body0.3+BB(20,2.2)', fn: (sl,l) => {
      const h=new Date(l.openTime).getUTCHours();
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl);
      const body = Math.abs(l.close-l.open)/l.open;
      if (!goodH.includes(h) || !bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70 && body>=0.003) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30 && body>=0.003) return 'bull';
      return null;
    }},

    // Section G: Stochastic — all hours
    { name: 'ALL-H Stoch>70+BB(20,2.2)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), stoch=calcStoch(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && stoch>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && stoch<30) return 'bull';
      return null;
    }},
    { name: 'ALL-H Stoch>70+BB(20,1.8)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,1.8), s=calcStreak(sl), stoch=calcStoch(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && stoch>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && stoch<30) return 'bull';
      return null;
    }},

    // Section H: EMA extension — price far above EMA
    { name: 'ALL-H EMA50ext+BB(20,2.2)+s>=1', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), ema=calcEMA(sl,50);
      if (!bb || sl.length < 52) return null;
      const emaExt = (l.close - ema) / ema;
      if (l.close>bb.upper && l.close>l.open && s>=1 && emaExt>0.003) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && emaExt<-0.003) return 'bull';
      return null;
    }},

    // Section I: Ultra-tight BB for max volume
    { name: 'ALL-H BB(20,0.8)+s>=1',     fn: (sl,l) => {
      const bb=calcBB(sl,20,0.8), s=calcStreak(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1) return 'bull';
      return null;
    }},
    { name: 'ALL-H BB(20,0.5)+s>=1',     fn: (sl,l) => {
      const bb=calcBB(sl,20,0.5), s=calcStreak(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1) return 'bull';
      return null;
    }},

    // Section J: Bear-only (asymmetric — markets go down faster)
    { name: 'ALL-H BEAR-ONLY RSI>70+BB(20,2.2)', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl);
      if (!bb) return null;
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70) return 'bear';
      return null;
    }},

    // Section K: ATR-filtered — only trade in normal volatility
    { name: 'ALL-H lowATR+RSI>70+BB(20,2.2)', fn: (sl,l) => {
      const bb=calcBB(sl,20,2.2), s=calcStreak(sl), rsi=calcRSI(sl);
      if (!bb || sl.length < 30) return null;
      const atr = calcATR(sl);
      const atrPct = atr / l.close;
      if (atrPct > 0.003) return null; // skip high volatility (>0.3% ATR)
      if (l.close>bb.upper && l.close>l.open && s>=1 && rsi>70) return 'bear';
      if (l.close<bb.lower && l.close<l.open && s<=-1 && rsi<30) return 'bull';
      return null;
    }},
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function printHeader(title) {
  console.log('\n' + '='.repeat(80));
  console.log(title);
  console.log('='.repeat(80));
}

function printResult(r, label) {
  const m = r.avgWR >= 65 ? '🎯' : r.avgWR >= 60 ? '⚡' : r.avgWR >= 57 ? '◆' : r.avgWR >= 55 ? '-' : '❌';
  const freq = r.tpd >= 80 ? '🔥HIGH' : r.tpd >= 40 ? '⚡MED' : r.tpd >= 10 ? '' : '⬇️LOW';
  console.log(`  ${m} ${label.padEnd(45)} WF=${r.avgWR.toFixed(1)}% σ=${r.std.toFixed(1)}% T=${r.totalT} [${r.fStr}] ${r.tpd.toFixed(1)}/d ${freq}`);
}

async function main() {
  console.log('=== 5-Minute Binary Options Research ===');
  console.log('Exit model: TRUE 5m binary = close at candle +1 (NOT +3)');
  console.log('5-fold walk-forward | 6 months data from trader.db\n');

  // Check available data
  const available = db.prepare(`
    SELECT symbol, timeframe, COUNT(*) as cnt,
           datetime(MIN(open_time)/1000, 'unixepoch') as first,
           datetime(MAX(open_time)/1000, 'unixepoch') as last
    FROM candles
    GROUP BY symbol, timeframe
    ORDER BY symbol, timeframe
  `).all();

  console.log('Available historical data:');
  for (const r of available) {
    console.log(`  ${r.symbol}/5m: ${r.cnt} candles (${r.first} → ${r.last})`);
  }
  console.log('');

  const COINS = [
    { symbol: 'ETH', goodH: ETH_GOOD_H },
    { symbol: 'BTC', goodH: BTC_GOOD_H },
    { symbol: 'SOL', goodH: SOL_GOOD_H },
  ];

  const allBestResults = [];

  for (const { symbol, goodH } of COINS) {
    const candles = loadCandles(symbol, '5m');
    if (candles.length < 5000) {
      console.log(`${symbol}: insufficient data (${candles.length} candles), skipping`);
      continue;
    }
    const days = candles.length / 288;
    printHeader(`${symbol} 5m — ${candles.length} candles (${days.toFixed(0)} days) — TRUE 5m exit`);

    const configs = makeConfigs(goodH);
    const results = [];

    for (const cfg of configs) {
      const r = runStrategy(candles, cfg.fn);
      results.push({ name: cfg.name, ...r });
    }

    results.sort((a,b) => b.avgWR - a.avgWR);

    console.log('\n[A] All results sorted by WR:');
    for (const r of results) {
      printResult(r, r.name);
    }

    // High volume results (>40/day)
    const highVol = results.filter(r => r.tpd >= 40);
    if (highVol.length > 0) {
      console.log('\n[B] High-volume results (40+/day):');
      for (const r of highVol.sort((a,b) => b.avgWR - a.avgWR)) {
        printResult(r, r.name);
      }
    }

    // Good WR results (>58%)
    const goodWR = results.filter(r => r.avgWR >= 58);
    if (goodWR.length > 0) {
      console.log('\n[C] Good WR results (58%+):');
      for (const r of goodWR.sort((a,b) => b.tpd - a.tpd)) {
        printResult(r, r.name);
      }
    }

    // Best combo: 80+/day AND profitable?
    const combo80 = results.filter(r => r.tpd >= 80 && r.avgWR >= 55);
    if (combo80.length > 0) {
      console.log('\n[D] ⭐ 80+/day AND profitable!:');
      for (const r of combo80.sort((a,b) => b.avgWR - a.avgWR)) {
        printResult(r, r.name);
      }
    }

    // Push best per coin
    for (const r of results) {
      allBestResults.push({ symbol, ...r });
    }
  }

  // ─── Multi-coin aggregation ────────────────────────────────────────────────
  printHeader('MULTI-COIN AGGREGATION — True 5m Binary Portfolio');

  console.log('\nQuestion: can we hit 80+/day by aggregating ETH+BTC+SOL signals?');
  console.log('Strategy: count distinct (coin, direction, time) signals per strategy type\n');

  // Group by strategy name across coins
  const byStrategy = {};
  for (const r of allBestResults) {
    if (!byStrategy[r.name]) byStrategy[r.name] = { coins: [], totalTpd: 0, wrs: [] };
    byStrategy[r.name].coins.push(r.symbol);
    byStrategy[r.name].totalTpd += r.tpd;
    byStrategy[r.name].wrs.push(r.avgWR);
  }

  const aggregated = Object.entries(byStrategy).map(([name, d]) => ({
    name,
    coins: d.coins.join('+'),
    totalTpd: d.totalTpd,
    avgWR: d.wrs.reduce((s,v)=>s+v,0) / d.wrs.length,
    minWR: Math.min(...d.wrs),
  })).sort((a,b) => b.totalTpd - a.totalTpd);

  console.log('Top 20 strategies by total daily volume (all coins combined):');
  let shown = 0;
  for (const r of aggregated) {
    if (shown++ >= 20) break;
    const m = r.avgWR >= 65 ? '🎯' : r.avgWR >= 60 ? '⚡' : r.avgWR >= 57 ? '◆' : r.avgWR >= 55 ? '-' : '❌';
    const target80 = r.totalTpd >= 80 ? '✅ 80+ !' : r.totalTpd >= 40 ? '⬆️ 40+' : '';
    console.log(`  ${m} ${r.name.padEnd(45)} ${r.totalTpd.toFixed(1)}/d avg=${r.avgWR.toFixed(1)}% min=${r.minWR.toFixed(1)}% coins=${r.coins} ${target80}`);
  }

  // Find any that hits 80/day at >55% WR
  const winners80 = aggregated.filter(r => r.totalTpd >= 80 && r.avgWR >= 55);
  console.log('\n⭐ WINNER strategies (80+/day, avg WR ≥55%):');
  if (winners80.length === 0) {
    console.log('  ❌ None found');
    // Find closest
    const closest = aggregated.filter(r => r.avgWR >= 55).sort((a,b) => b.totalTpd - a.totalTpd)[0];
    if (closest) {
      console.log(`  Closest: ${closest.name}: ${closest.totalTpd.toFixed(1)}/d at ${closest.avgWR.toFixed(1)}% WR (need ${(80-closest.totalTpd).toFixed(0)} more/day)`);
    }
  } else {
    for (const r of winners80) {
      console.log(`  ✅ ${r.name}: ${r.totalTpd.toFixed(1)}/d at avg=${r.avgWR.toFixed(1)}% min=${r.minWR.toFixed(1)}%`);
    }
  }

  // ─── Final verdict ──────────────────────────────────────────────────────────
  printHeader('FINAL VERDICT — True 5m Binary 80+/day Research');

  const best80 = aggregated.filter(r => r.totalTpd >= 60).sort((a,b) => b.avgWR - a.avgWR).slice(0,5);
  console.log('\nTop high-volume strategies with best WR:');
  for (const r of best80) {
    console.log(`  ${r.name}: ${r.totalTpd.toFixed(1)}/d | avg=${r.avgWR.toFixed(1)}% min=${r.minWR.toFixed(1)}%`);
  }

  const profitable80 = aggregated.filter(r => r.totalTpd >= 80 && r.minWR >= 55);
  const profitable60 = aggregated.filter(r => r.totalTpd >= 60 && r.avgWR >= 57);

  console.log(`\n  80+/day at min 55% WR: ${profitable80.length > 0 ? `✅ YES (${profitable80.length} strategies)` : '❌ Not found'}`);
  console.log(`  60+/day at avg 57% WR: ${profitable60.length > 0 ? `✅ YES (${profitable60.length} strategies)` : '❌ Not found'}`);

  if (profitable80.length > 0 || profitable60.length > 0) {
    console.log('\n  🎯 RECOMMENDATION: Implement as new strategies!');
    const toImpl = (profitable80.length > 0 ? profitable80 : profitable60).slice(0,3);
    for (const r of toImpl) {
      console.log(`    → ${r.name}: ${r.totalTpd.toFixed(1)}/d ${r.avgWR.toFixed(1)}% WR`);
    }
  }
}

main();
