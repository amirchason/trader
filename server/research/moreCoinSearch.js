/**
 * moreCoinSearch.js — Test additional coins for BB mean reversion edge
 *
 * Hypothesis: DOGE, MATIC, LINK, AVAX, ADA may show BB mean reversion similar to ETH
 * If any Polymarket-listed coin shows 60%+ WR, it adds to our daily signal count
 *
 * Strategy: Correct at-expiry exit (close at exactly candle 3 = 15min later)
 * Walk-forward: 3 folds (2-month test each)
 */

const https = require('https');

// ─── Data Fetch ───────────────────────────────────────────────────────────────

function fetchKlines(symbol, limit, endTime) {
  return new Promise((resolve, reject) => {
    let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
    if (endTime) url += `&endTime=${endTime}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          if (!Array.isArray(raw)) { resolve([]); return; }
          resolve(raw.map(k => ({
            openTime: +k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
          })));
        } catch(e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

async function fetch6Months(symbol) {
  const batches = [];
  let endTime = undefined;
  for (let i = 0; i < 53; i++) {
    const batch = await fetchKlines(symbol, 1000, endTime);
    if (batch.length === 0) break;
    batches.unshift(batch);
    endTime = batch[0].openTime - 1;
    await new Promise(r => setTimeout(r, 80));
  }
  return batches.flat().sort((a,b) => a.openTime - b.openTime);
}

// ─── Indicators ──────────────────────────────────────────────────────────────

function calcBB(candles, period, mult) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const sma = slice.reduce((s,c) => s + c.close, 0) / period;
  const variance = slice.reduce((s,c) => s + (c.close - sma)**2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + mult * std, mid: sma, lower: sma - mult * std };
}

function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i-1].close;
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / avgLoss));
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const flow = tp * candles[i].volume;
    if (tp > prevTp) posFlow += flow; else negFlow += flow;
  }
  if (negFlow === 0) return 100;
  return 100 - (100 / (1 + posFlow / negFlow));
}

function calcStreak(candles) {
  const last = candles[candles.length - 1];
  const isGreen = last.close > last.open;
  let streak = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if ((c.close > c.open) !== isGreen) break;
    streak++;
  }
  return isGreen ? streak : -streak;
}

// ─── Walk-Forward Research ────────────────────────────────────────────────────

const CONFIGS = [
  { name: 'GoodH+BB(20,2.2)+s>=2',          bbM: 2.2, minS: 2, allH: false, rsi: null, mfi: null, body: null },
  { name: 'GoodH+BB(20,2.2)+s>=1',          bbM: 2.2, minS: 1, allH: false, rsi: null, mfi: null, body: null },
  { name: 'GoodH+RSI>70+BB(20,2.2)+s>=1',   bbM: 2.2, minS: 1, allH: false, rsi: 70,  mfi: null, body: null },
  { name: 'GoodH+MFI>75+BB(20,2.2)+s>=1',   bbM: 2.2, minS: 1, allH: false, rsi: null, mfi: 75,  body: null },
  { name: 'GoodH+BB(20,1.8)+s>=1',          bbM: 1.8, minS: 1, allH: false, rsi: null, mfi: null, body: null },
  { name: 'ALL-H+RSI>70+BB(20,2.2)+s>=1',   bbM: 2.2, minS: 1, allH: true,  rsi: 70,  mfi: null, body: null },
  { name: 'ALL-H+RSI>70+BB(20,1.8)+s>=1',   bbM: 1.8, minS: 1, allH: true,  rsi: 70,  mfi: null, body: null },
  { name: 'GoodH+RSI70+body0.3+BB(20,2.2)', bbM: 2.2, minS: 1, allH: false, rsi: 70,  mfi: null, body: 0.003 },
];

function runWF(candles, goodHours) {
  const foldSize = Math.floor(candles.length / 3);
  const results = [];

  for (const cfg of CONFIGS) {
    const foldWRs = [];

    for (let fold = 0; fold < 3; fold++) {
      const testStart = fold * foldSize;
      const testEnd = testStart + foldSize;
      const test = candles.slice(testStart, testEnd);
      let wins = 0, total = 0;

      for (let i = 30; i < test.length - 3; i++) {
        const slice = test.slice(Math.max(0, i - 60), i + 1); // rolling window
        const last = slice[slice.length - 1];
        const h = new Date(last.openTime).getUTCHours();
        if (!cfg.allH && !goodHours.includes(h)) continue;

        const bb = calcBB(slice, 20, cfg.bbM);
        if (!bb) continue;

        const streak = calcStreak(slice);
        if (Math.abs(streak) < cfg.minS) continue;

        const isBear = last.close > bb.upper && last.close > last.open && streak > 0;
        const isBull = last.close < bb.lower && last.close < last.open && streak < 0;
        if (!isBear && !isBull) continue;

        if (cfg.rsi) {
          const rsi = calcRSI(slice);
          if (isBear && rsi < cfg.rsi) continue;
          if (isBull && rsi > 100 - cfg.rsi) continue;
        }
        if (cfg.mfi) {
          const mfi = calcMFI(slice);
          if (isBear && mfi < cfg.mfi) continue;
          if (isBull && mfi > 100 - cfg.mfi) continue;
        }
        if (cfg.body) {
          const bodyPct = Math.abs(last.close - last.open) / last.open;
          if (bodyPct < cfg.body) continue;
        }

        const exitC = test[i + 3];
        if (!exitC) continue;
        total++;
        if (isBear && exitC.close < last.close) wins++;
        if (isBull && exitC.close > last.close) wins++;
      }

      foldWRs.push({ wr: total > 0 ? wins / total * 100 : 0, total });
    }

    const avgWR = foldWRs.reduce((s,f) => s + f.wr, 0) / 3;
    const totalT = foldWRs.reduce((s,f) => s + f.total, 0);
    const std = Math.sqrt(foldWRs.reduce((s,f) => s + (f.wr - avgWR)**2, 0) / 3);
    const tpd = totalT / (candles.length / 288);
    const fStr = foldWRs.map(f => `${f.wr.toFixed(1)}`).join('/');
    results.push({ ...cfg, avgWR, std, totalT, tpd, fStr });
  }

  return results;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== More Coin Search — BB Mean Reversion on New Coins ===');
  console.log('Correct at-expiry exit | 3-fold walk-forward | 6 months data\n');

  // Reference context
  console.log('ETH Reference (validated):');
  console.log('  GoodH+BB(20,2.2)+s>=2:      WF≈61% σ≈5% 2.0/d');
  console.log('  GoodH+RSI>70+BB22+s>=1:     WF≈64% σ≈3% 2.4/d');
  console.log('  ALL-H+RSI>70+BB22+s>=1:     WF≈76% σ≈3% 5.1/d');
  console.log('');

  const COINS = [
    { symbol: 'DOGEUSDT',  name: 'DOGE', polymarket: true,  goodH: [10,11,12,21] },
    { symbol: 'MATICUSDT', name: 'MATIC', polymarket: true,  goodH: [10,11,12,21] },
    { symbol: 'LINKUSDT',  name: 'LINK',  polymarket: true,  goodH: [10,11,12,21] },
    { symbol: 'AVAXUSDT',  name: 'AVAX',  polymarket: true,  goodH: [10,11,12,21] },
    { symbol: 'ADAUSDT',   name: 'ADA',   polymarket: true,  goodH: [10,11,12,21] },
    { symbol: 'BNBUSDT',   name: 'BNB',   polymarket: false, goodH: [10,11,12,21] },
  ];

  const summary = [];

  for (const coin of COINS) {
    process.stdout.write(`\n[${coin.name}] Fetching 6mo data... `);
    const candles = await fetch6Months(coin.symbol);
    const days = candles.length / 288;
    console.log(`${candles.length} candles (${days.toFixed(0)}d)`);

    if (candles.length < 5000) {
      console.log(`  ⚠️ Too few candles, skipping`);
      continue;
    }

    const results = runWF(candles, coin.goodH);
    results.sort((a,b) => b.avgWR - a.avgWR);

    console.log(`\n${coin.name} (Polymarket: ${coin.polymarket ? '✅' : '❌'}):`);
    let bestWR = 0, bestRow = null;
    for (const r of results) {
      const marker = r.avgWR >= 65 ? '🎯' : r.avgWR >= 60 ? '⚡' : r.avgWR >= 57 ? '◆' : ' ';
      console.log(`  ${marker} ${r.name.padEnd(44)} WF=${r.avgWR.toFixed(1)}% σ=${r.std.toFixed(1)}% T=${r.totalT} [${r.fStr}] ${r.tpd.toFixed(1)}/d`);
      if (r.avgWR > bestWR) { bestWR = r.avgWR; bestRow = r; }
    }
    summary.push({ coin: coin.name, polymarket: coin.polymarket, bestWR, bestRow, days });
  }

  // ─── Final Summary ──────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(80));

  summary.sort((a,b) => b.bestWR - a.bestWR);
  for (const s of summary) {
    const m = s.bestWR >= 65 ? '🎯' : s.bestWR >= 60 ? '⚡' : s.bestWR >= 57 ? '◆' : '❌';
    const pm = s.polymarket ? '✅' : '❌';
    console.log(`  ${m} ${s.coin.padEnd(5)} PM:${pm} bestWR=${s.bestWR.toFixed(1)}% (${s.bestRow?.name ?? '?'})`);
  }

  const viable = summary.filter(s => s.bestWR >= 57 && s.polymarket);
  const extraPerDay = viable.reduce((t,s) => t + (s.bestRow?.tpd ?? 0), 0);

  console.log(`\n  Viable additions (≥57% WR + Polymarket): ${viable.map(s=>s.coin).join(', ') || 'none'}`);
  console.log(`  Extra signals/day from new coins: +${extraPerDay.toFixed(1)}/day`);
  console.log(`  Current ETH+BTC+SOL portfolio: ~47/day`);
  console.log(`  New total: ~${(47 + extraPerDay).toFixed(0)}/day`);
  console.log(`\n  80+/day achievable: ${(47 + extraPerDay) >= 80 ? '✅ YES!' : `❌ No (need +${(80-47-extraPerDay).toFixed(0)} more)`}`);

  // Best candidates for Strategy 71+
  const best = summary.filter(s => s.bestWR >= 60 && s.polymarket);
  if (best.length > 0) {
    console.log('\n  🎯 IMPLEMENT AS NEW STRATEGIES:');
    for (const s of best) {
      console.log(`     Strategy 71+: ${s.coin} ${s.bestRow?.name} → WF=${s.bestWR.toFixed(1)}% σ=${s.bestRow?.std.toFixed(1)}% ${s.bestRow?.tpd.toFixed(1)}/d`);
    }
  }
}

main().catch(console.error);
