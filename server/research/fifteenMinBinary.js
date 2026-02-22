/**
 * fifteenMinBinary.js — 15-minute Polymarket binary options research
 * Exit model: candle +3 (15 minutes = 3x5m candles)
 * SEPARATE Polymarket market from 5m binary — independent trade opportunity!
 * 5-fold walk-forward | 6 months data from trader.db
 */
const Database = require('better-sqlite3');
const path = require('path');
const DB_PATH = path.join(__dirname, '../../trader.db');
const db = new Database(DB_PATH, { readonly: true });

function loadCandles(symbol) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time ASC LIMIT 100000')
    .all(symbol, '5m')
    .map(r => ({ openTime: r.open_time, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

function BB(sl, p, m) {
  if (sl.length < p) return null;
  const cl = sl.slice(-p).map(c => c.close);
  const sma = cl.reduce((s, v) => s + v, 0) / p;
  const std = Math.sqrt(cl.reduce((s, v) => s + (v - sma) ** 2, 0) / p);
  return { upper: sma + m * std, lower: sma - m * std };
}
function RSI(sl, p = 14) {
  if (sl.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = sl.length - p; i < sl.length; i++) { const d = sl[i].close - sl[i-1].close; if (d > 0) g += d; else l -= d; }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g / p) / (l / p));
}
function RSI7(sl) { return RSI(sl, 7); }
function MFI(sl, p = 14) {
  if (sl.length < p + 1) return 50;
  let pos = 0, neg = 0;
  for (let i = sl.length - p; i < sl.length; i++) {
    const tp = (sl[i].high + sl[i].low + sl[i].close) / 3;
    const pt = (sl[i-1].high + sl[i-1].low + sl[i-1].close) / 3;
    const f = tp * sl[i].volume;
    if (tp > pt) pos += f; else neg += f;
  }
  if (neg === 0) return 100;
  return 100 - 100 / (1 + pos / neg);
}
function Stoch(sl, p = 5) {
  if (sl.length < p) return 50;
  const s = sl.slice(-p);
  const lo = Math.min(...s.map(c => c.low)), hi = Math.max(...s.map(c => c.high));
  if (hi === lo) return 50;
  return (sl[sl.length-1].close - lo) / (hi - lo) * 100;
}
function ATR(sl, p = 14) {
  if (sl.length < 2) return 0;
  const trs = [];
  for (let i = Math.max(1, sl.length - p); i < sl.length; i++) {
    trs.push(Math.max(sl[i].high - sl[i].low, Math.abs(sl[i].high - sl[i-1].close), Math.abs(sl[i].low - sl[i-1].close)));
  }
  return trs.reduce((s, v) => s + v, 0) / trs.length;
}
function streak(sl) {
  const last = sl[sl.length-1], isG = last.close > last.open;
  let s = 0;
  for (let i = sl.length - 1; i >= 0; i--) { if ((sl[i].close > sl[i].open) !== isG) break; s++; }
  return isG ? s : -s;
}

const EXIT = 3; // 15m binary: exit at candle +3

function runWF(candles, filterFn) {
  const sz = Math.floor(candles.length / 5);
  const folds = [];
  for (let f = 0; f < 5; f++) {
    const t = candles.slice(f * sz, (f + 1) * sz);
    let wins = 0, total = 0;
    for (let i = 60; i < t.length - EXIT; i++) {
      const sl = t.slice(Math.max(0, i - 100), i + 1);
      const last = sl[sl.length-1];
      const sig = filterFn(sl, last);
      if (!sig) continue;
      const ex = t[i + EXIT].close;
      total++;
      if (sig === 'bear' && ex < last.close) wins++;
      if (sig === 'bull' && ex > last.close) wins++;
    }
    folds.push({ wr: total > 0 ? wins / total * 100 : 0, total });
  }
  const avgWR = folds.reduce((s, f) => s + f.wr, 0) / 5;
  const totalT = folds.reduce((s, f) => s + f.total, 0);
  const std = Math.sqrt(folds.reduce((s, f) => s + (f.wr - avgWR) ** 2, 0) / 5);
  return { avgWR, std, totalT, tpd: totalT / (candles.length / 288), fStr: folds.map(f => f.wr.toFixed(1)).join('/') };
}

function configs(goodH) {
  return [
    { n: 'ALL-H BB(20,1.0)+s>=1',           fn: (sl, l) => { const bb = BB(sl,20,1.0), s = streak(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1) return 'bull'; return null; } },
    { n: 'ALL-H BB(20,1.5)+s>=1',           fn: (sl, l) => { const bb = BB(sl,20,1.5), s = streak(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1) return 'bull'; return null; } },
    { n: 'ALL-H BB(20,1.8)+s>=1',           fn: (sl, l) => { const bb = BB(sl,20,1.8), s = streak(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1) return 'bull'; return null; } },
    { n: 'ALL-H BB(20,2.2)+s>=1',           fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1) return 'bull'; return null; } },
    { n: 'ALL-H RSI>70+BB(20,2.2)+s>=1',   fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), rsi = RSI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 30) return 'bull'; return null; } },
    { n: 'ALL-H RSI>70+BB(20,1.8)+s>=1',   fn: (sl, l) => { const bb = BB(sl,20,1.8), s = streak(sl), rsi = RSI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 30) return 'bull'; return null; } },
    { n: 'ALL-H RSI7>75+BB(20,2.2)+s>=1',  fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), rsi = RSI7(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 75) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 25) return 'bull'; return null; } },
    { n: 'ALL-H RSI7>75+BB(20,1.8)+s>=1',  fn: (sl, l) => { const bb = BB(sl,20,1.8), s = streak(sl), rsi = RSI7(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 75) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 25) return 'bull'; return null; } },
    { n: 'ALL-H MFI>75+BB(20,2.2)+s>=1',   fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), mfi = MFI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && mfi > 75) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && mfi < 25) return 'bull'; return null; } },
    { n: 'ALL-H MFI>80+BB(20,2.2)+s>=1',   fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), mfi = MFI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && mfi > 80) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && mfi < 20) return 'bull'; return null; } },
    { n: 'ALL-H MFI>80+BB(20,1.8)+s>=1',   fn: (sl, l) => { const bb = BB(sl,20,1.8), s = streak(sl), mfi = MFI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && mfi > 80) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && mfi < 20) return 'bull'; return null; } },
    { n: 'ALL-H RSI+MFI>70+BB(20,2.2)',    fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), rsi = RSI(sl), mfi = MFI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70 && mfi > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 30 && mfi < 30) return 'bull'; return null; } },
    { n: 'ALL-H RSI+MFI>70+BB(20,1.8)',    fn: (sl, l) => { const bb = BB(sl,20,1.8), s = streak(sl), rsi = RSI(sl), mfi = MFI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70 && mfi > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 30 && mfi < 30) return 'bull'; return null; } },
    { n: 'ALL-H Stoch>70+BB(20,2.2)+s>=1', fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), stoch = Stoch(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && stoch > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && stoch < 30) return 'bull'; return null; } },
    { n: 'ALL-H Stoch>70+BB(20,1.8)+s>=1', fn: (sl, l) => { const bb = BB(sl,20,1.8), s = streak(sl), stoch = Stoch(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && stoch > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && stoch < 30) return 'bull'; return null; } },
    { n: 'ALL-H lowATR+RSI>70+BB(20,2.2)', fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), rsi = RSI(sl), atr = ATR(sl); if (!bb || sl.length < 30) return null; if (atr / l.close > 0.003) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 30) return 'bull'; return null; } },
    { n: 'GoodH+BB(20,2.2)+s>=2',           fn: (sl, l) => { const h = new Date(l.openTime).getUTCHours(), bb = BB(sl,20,2.2), s = streak(sl); if (!goodH.includes(h) || !bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 2) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -2) return 'bull'; return null; } },
    { n: 'GoodH+RSI>70+BB(20,2.2)+s>=1',   fn: (sl, l) => { const h = new Date(l.openTime).getUTCHours(), bb = BB(sl,20,2.2), s = streak(sl), rsi = RSI(sl); if (!goodH.includes(h) || !bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 30) return 'bull'; return null; } },
    { n: 'ALL-H BEAR-ONLY RSI>70+BB(20,2.2)', fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), rsi = RSI(sl); if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70) return 'bear'; return null; } },
    { n: 'ALL-H body>=0.3%+RSI>70+BB(20,2.2)', fn: (sl, l) => { const bb = BB(sl,20,2.2), s = streak(sl), rsi = RSI(sl), body = Math.abs(l.close - l.open) / l.open; if (!bb) return null; if (l.close > bb.upper && l.close > l.open && s >= 1 && rsi > 70 && body >= 0.003) return 'bear'; if (l.close < bb.lower && l.close < l.open && s <= -1 && rsi < 30 && body >= 0.003) return 'bull'; return null; } },
  ];
}

function main() {
  console.log('=== 15-Minute Binary Research (candle +3 exit) ===');
  console.log('Separate from 5m binary = 2x trade opportunities per signal!\n');

  const COINS = [
    { symbol: 'ETH', goodH: [10, 11, 12, 21] },
    { symbol: 'BTC', goodH: [1, 12, 13, 16, 20] },
    { symbol: 'SOL', goodH: [0, 12, 13, 20] },
  ];

  const allResults = [];

  for (const { symbol, goodH } of COINS) {
    const candles = loadCandles(symbol);
    if (candles.length < 5000) continue;
    const days = candles.length / 288;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${symbol} — ${candles.length} candles (${days.toFixed(0)}d) — 15m binary (candle+3 exit)`);
    console.log('='.repeat(70));

    const cfgs = configs(goodH);
    const results = cfgs.map(cfg => ({ name: cfg.n, ...runWF(candles, cfg.fn) })).sort((a, b) => b.avgWR - a.avgWR);

    for (const r of results) {
      const m = r.avgWR >= 65 ? '🎯' : r.avgWR >= 60 ? '⚡' : r.avgWR >= 57 ? '◆' : r.avgWR >= 55 ? '-' : '❌';
      const freq = r.tpd >= 80 ? '🔥HIGH' : r.tpd >= 40 ? '⚡MED' : r.tpd >= 10 ? '' : ' LOW';
      console.log(`  ${m} ${r.name.padEnd(42)} WF=${r.avgWR.toFixed(1)}% σ=${r.std.toFixed(1)}% [${r.fStr}] ${r.tpd.toFixed(1)}/d ${freq}`);
    }
    for (const r of results) allResults.push({ symbol, ...r });
  }

  // ─── Multi-coin aggregation ────────────────────────────────────────────────
  console.log('\n\n=== 15m MULTI-COIN AGGREGATION ===');
  const byStrat = {};
  for (const r of allResults) {
    if (!byStrat[r.name]) byStrat[r.name] = { coins: [], tpd: 0, wrs: [] };
    byStrat[r.name].coins.push(r.symbol);
    byStrat[r.name].tpd += r.tpd;
    byStrat[r.name].wrs.push(r.avgWR);
  }
  const agg = Object.entries(byStrat).map(([n, d]) => ({
    name: n, coins: d.coins.join('+'), tpd: d.tpd,
    avgWR: d.wrs.reduce((s, v) => s + v, 0) / d.wrs.length,
    minWR: Math.min(...d.wrs),
  })).sort((a, b) => b.tpd - a.tpd);

  console.log('Top strategies by daily volume (15m binary only):');
  for (const r of agg.slice(0, 15)) {
    const m = r.avgWR >= 60 ? '⚡' : r.avgWR >= 57 ? '◆' : r.avgWR >= 55 ? '-' : '❌';
    const t = r.tpd >= 80 ? '✅80+!' : r.tpd >= 40 ? '⬆️40+' : '';
    console.log(`  ${m} ${r.name.padEnd(42)} ${r.tpd.toFixed(1)}/d avg=${r.avgWR.toFixed(1)}% min=${r.minWR.toFixed(1)}% ${t}`);
  }

  // ─── Combined 5m+15m total ─────────────────────────────────────────────────
  console.log('\n=== COMBINED 5m+15m GRAND TOTAL ===');
  console.log('(5m results from fiveMinBinary.js; 15m results from this run)');
  console.log('These are SEPARATE Polymarket markets — both can be traded simultaneously\n');

  // From fiveMinBinary.js run:
  const fiveM = {
    'ALL-H RSI7>75+BB(20,1.8)+s>=1':  { tpd: 89.8, wr: 54.6 },
    'ALL-H BB(20,1.8)+s>=1':           { tpd: 127.1, wr: 54.0 },
    'ALL-H Stoch>70+BB(20,1.8)+s>=1': { tpd: 120.2, wr: 54.1 },
    'ALL-H BB(20,2.2)+s>=1':           { tpd: 60.9, wr: 55.1 },
    'ALL-H RSI>70+BB(20,2.2)+s>=1':   { tpd: 32.4, wr: 55.7 },
    'ALL-H lowATR+RSI>70+BB(20,2.2)': { tpd: 23.6, wr: 56.4 },
  };

  console.log('  Strategy'.padEnd(46) + '5m/d   15m/d  Total  WR    Target');
  console.log('  ' + '-'.repeat(70));

  const rows = [];
  for (const [name, fm] of Object.entries(fiveM)) {
    const r15 = agg.find(r => r.name === name);
    const tpd15 = r15?.tpd ?? 0;
    const wr15 = r15?.avgWR ?? fm.wr;
    const totalTpd = fm.tpd + tpd15;
    const blendedWR = (fm.wr * fm.tpd + wr15 * tpd15) / (fm.tpd + tpd15) || fm.wr;
    const hit = totalTpd >= 120 ? '✅120+!' : totalTpd >= 80 ? '⬆️80+' : '❌';
    rows.push({ name, tpd5: fm.tpd, tpd15, totalTpd, blendedWR, hit });
    console.log(`  ${name.padEnd(44)} ${fm.tpd.toFixed(0).padStart(4)}   ${tpd15.toFixed(0).padStart(5)}  ${totalTpd.toFixed(0).padStart(5)}  ${blendedWR.toFixed(1)}%  ${hit}`);
  }

  rows.sort((a, b) => b.totalTpd - a.totalTpd);
  const winner = rows.find(r => r.totalTpd >= 120);
  console.log('\n=== VERDICT ===');
  if (winner) {
    console.log(`  ✅ 120+/day ACHIEVABLE with: ${winner.name}`);
    console.log(`     Total: ${winner.totalTpd.toFixed(0)}/day (${winner.tpd5.toFixed(0)} on 5m + ${winner.tpd15.toFixed(0)} on 15m binaries)`);
    console.log(`     Blended WR: ${winner.blendedWR.toFixed(1)}% → profitable if Polymarket spread <${(winner.blendedWR - 50).toFixed(1)}%`);
  } else {
    console.log(`  ❌ 120+/day not achieved on ETH+BTC+SOL alone`);
    console.log(`  Best: ${rows[0].name} at ${rows[0].totalTpd.toFixed(0)}/day (${rows[0].blendedWR.toFixed(1)}% WR)`);
    console.log(`  → Adding new coins (DOGE/MATIC/LINK/AVAX/ADA) can bridge the gap`);
  }
}

main();
