/**
 * ML Decision Tree Rule Learner for ETH + SOL strategies
 * Implements ID3/C4.5-style rule extraction from candle features
 * Finds optimal feature splits that maximize WR
 */

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

// ─── Utility ───────────────────────────────────────────────────────────────

function calcBB(closes, period, mult) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, mid: mean, lower: mean - mult * std, std, mean };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcMFI(candles, period = 10) {
  if (candles.length < period + 1) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const rawMF = tp * candles[i].volume;
    if (tp > prevTp) posFlow += rawMF; else negFlow += rawMF;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// ─── Load Candles ──────────────────────────────────────────────────────────

function loadCandles(symbol, tf) {
  const rows = db.prepare(
    `SELECT open_time, open, high, low, close, volume FROM candles
     WHERE symbol=? AND timeframe=? ORDER BY open_time ASC`
  ).all(symbol, tf);
  return rows.map(r => ({
    time: r.open_time,
    open: parseFloat(r.open), high: parseFloat(r.high),
    low: parseFloat(r.low), close: parseFloat(r.close),
    volume: parseFloat(r.volume),
  }));
}

// ─── Feature Extraction ────────────────────────────────────────────────────

function extractFeatures(candles5m, idx) {
  if (idx < 30) return null;
  const c = candles5m[idx];
  const history = candles5m.slice(0, idx + 1);
  const closes = history.map(x => x.close);

  const bb20_22 = calcBB(closes, 20, 2.2);
  const bb20_2  = calcBB(closes, 20, 2.0);
  const bb15_22 = calcBB(closes, 15, 2.2);
  if (!bb20_22) return null;

  const rsi14 = calcRSI(closes, 14);
  const rsi7  = calcRSI(closes, 7);
  const ema50 = calcEMA(closes, 50);
  const ema20 = calcEMA(closes, 20);
  const mfi10 = calcMFI(history.slice(-11), 10);
  const atr14 = calcATR(history.slice(-15), 14);

  // Candle body
  const body = Math.abs(c.close - c.open);
  const bodyPct = c.open > 0 ? body / c.open * 100 : 0;
  const isGreen = c.close > c.open;
  const isRed   = c.close < c.open;

  // Streak
  let streak = 0;
  for (let k = idx; k >= 1; k--) {
    const cur = candles5m[k];
    if (cur.close > cur.open && streak >= 0) streak++;
    else if (cur.close < cur.open && streak <= 0) streak--;
    else break;
  }
  const streakLen = Math.abs(streak);
  const streakDir = streak > 0 ? 1 : streak < 0 ? -1 : 0;

  // BB position
  const bbDev20_22 = (c.close - bb20_22.mid) / (bb20_22.std || 1);
  const bbDev20_2  = (c.close - (bb20_2?.mid || bb20_22.mid)) / (bb20_2?.std || bb20_22.std || 1);
  const aboveBB22  = c.close > bb20_22.upper;
  const belowBB22  = c.close < bb20_22.lower;
  const outsideBB  = aboveBB22 || belowBB22;
  const bbDevPct22 = aboveBB22
    ? (c.close - bb20_22.upper) / c.close * 100
    : belowBB22
    ? (bb20_22.lower - c.close) / c.close * 100
    : 0;

  const aboveBB15  = bb15_22 ? c.close > bb15_22.upper : false;
  const belowBB15  = bb15_22 ? c.close < bb15_22.lower : false;

  // EMA distance
  const emaDist50 = ema50 > 0 ? Math.abs(c.close - ema50) / ema50 * 100 : 0;
  const emaDist20 = ema20 > 0 ? Math.abs(c.close - ema20) / ema20 * 100 : 0;
  const priceAboveEMA50 = c.close > ema50;

  // Hour + day
  const date = new Date(c.time);
  const hour = date.getUTCHours();
  const dow  = date.getUTCDay(); // 0=Sun

  // Good hours
  const ethGoodH   = [10, 11, 12, 21].includes(hour);
  const solGoodH   = [0, 12, 13, 20].includes(hour);

  // Previous candle patterns
  const prev1 = candles5m[idx - 1];
  const prev2 = idx >= 2 ? candles5m[idx - 2] : null;
  const prev3 = idx >= 3 ? candles5m[idx - 3] : null;

  // Volume ratio
  const recentVols = history.slice(-21, -1).map(x => x.volume);
  const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 1;
  const volRatio = avgVol > 0 ? c.volume / avgVol : 1;

  // Daily range position
  const dayStart = new Date(c.time);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayCandles = history.filter(x => x.time >= dayStart.getTime());
  const dayHigh = Math.max(...dayCandles.map(x => x.high));
  const dayLow  = Math.min(...dayCandles.map(x => x.low));
  const dayRange = dayHigh - dayLow;
  const dayRangePct = dayRange > 0 ? (c.close - dayLow) / dayRange : 0.5;
  const inTopDayRange = dayRangePct > 0.7 && isGreen;
  const inBotDayRange = dayRangePct < 0.3 && isRed;

  return {
    // Temporal
    hour, dow, ethGoodH, solGoodH,
    // Price action
    isGreen, isRed, bodyPct,
    streakLen, streakDir, streakBull: streak > 0, streakBear: streak < 0,
    // BB
    aboveBB22, belowBB22, outsideBB, bbDevPct22,
    aboveBB15, belowBB15,
    bbDev20_22: Math.abs(bbDev20_22),
    tightBBDev: bbDevPct22 > 0.05 && bbDevPct22 < 0.25,
    // Indicators
    rsi14, rsi7, mfi10, volRatio,
    rsiOverbought70: rsi14 > 70, rsiOversold30: rsi14 < 30,
    rsiOverbought65: rsi14 > 65, rsiOversold35: rsi14 < 35,
    mfiOverbought80: mfi10 > 80, mfiOversold20: mfi10 < 20,
    mfiOverbought70: mfi10 > 70, mfiOversold30: mfi10 < 30,
    highVol: volRatio > 2.0,
    lowVol: volRatio < 0.5,
    // EMA
    emaDist50, emaDist20, priceAboveEMA50,
    farFromEMA50: emaDist50 > 0.5,
    farFromEMA50_03: emaDist50 > 0.3,
    // Day/time
    isWed: dow === 3, isSat: dow === 6, isTue: dow === 2, isThu: dow === 4, isFri: dow === 5,
    isWeekend: dow === 0 || dow === 6,
    // Day range
    dayRangePct, inTopDayRange, inBotDayRange,
    topDayRange30: dayRangePct > 0.7,
    botDayRange30: dayRangePct < 0.3,
  };
}

// ─── Build ML Dataset ──────────────────────────────────────────────────────

function buildDataset(symbol, tf5m) {
  const candles5m = loadCandles(symbol, tf5m);
  const dataset = [];

  for (let i = 35; i < candles5m.length - 3; i++) {
    const feats = extractFeatures(candles5m, i);
    if (!feats) continue;

    // Outcome: did price go DOWN in next 15min? (3 candles)
    // Bear reversion signal (price above BB → expect down)
    const currentClose = candles5m[i].close;
    const futureClose3 = candles5m[i + 3]?.close;
    if (!futureClose3) continue;

    const outcome = futureClose3 < currentClose ? 1 : 0; // 1=bear win, 0=bear loss

    dataset.push({ feats, outcome, idx: i, close: currentClose });
  }

  return { dataset, candles5m };
}

// ─── Decision Tree Rule Learner ────────────────────────────────────────────

function gini(items) {
  if (items.length === 0) return 0;
  const pos = items.filter(x => x.outcome === 1).length;
  const p = pos / items.length;
  return 2 * p * (1 - p);
}

function gain(left, right) {
  const n = left.length + right.length;
  return -(left.length / n) * gini(left) - (right.length / n) * gini(right);
}

function winRate(items) {
  if (items.length === 0) return 0;
  return items.filter(x => x.outcome === 1).length / items.length;
}

// Find best binary split for all boolean features
function findBestRules(dataset, minTrades = 30) {
  const boolFeatures = [
    'ethGoodH', 'solGoodH', 'isGreen', 'isRed',
    'aboveBB22', 'belowBB22', 'outsideBB',
    'aboveBB15', 'belowBB15', 'tightBBDev',
    'rsiOverbought70', 'rsiOversold30', 'rsiOverbought65', 'rsiOversold35',
    'mfiOverbought80', 'mfiOversold20', 'mfiOverbought70', 'mfiOversold30',
    'highVol', 'lowVol',
    'farFromEMA50', 'farFromEMA50_03',
    'streakBull', 'streakBear',
    'isWed', 'isSat', 'isTue', 'isThu', 'isFri', 'isWeekend',
    'inTopDayRange', 'inBotDayRange', 'topDayRange30', 'botDayRange30',
    'priceAboveEMA50',
  ];

  const results = [];

  // Single feature rules
  for (const f of boolFeatures) {
    const matched = dataset.filter(x => x.feats[f]);
    if (matched.length < minTrades) continue;
    const wr = winRate(matched);
    if (wr > 0.60) {
      results.push({ rule: f, T: matched.length, wr, depth: 1, combo: [f] });
    }
  }

  // Two-feature combinations (only with high-value base features)
  const baseFeatures = ['ethGoodH', 'solGoodH', 'aboveBB22', 'belowBB22', 'outsideBB'];
  for (const bf of baseFeatures) {
    const base = dataset.filter(x => x.feats[bf]);
    if (base.length < minTrades) continue;

    for (const f of boolFeatures) {
      if (f === bf) continue;
      const matched = base.filter(x => x.feats[f]);
      if (matched.length < minTrades) continue;
      const wr = winRate(matched);
      if (wr > 0.62) {
        results.push({
          rule: `${bf} AND ${f}`,
          T: matched.length, wr, depth: 2,
          combo: [bf, f],
        });
      }
    }
  }

  // Three-feature combos (only on best 2-feature results)
  const top2 = results.filter(r => r.depth === 2 && r.wr > 0.64).slice(0, 10);
  for (const r2 of top2) {
    const base2 = dataset.filter(x => r2.combo.every(f => x.feats[f]));
    for (const f of boolFeatures) {
      if (r2.combo.includes(f)) continue;
      const matched = base2.filter(x => x.feats[f]);
      if (matched.length < minTrades) continue;
      const wr = winRate(matched);
      if (wr > 0.65) {
        results.push({
          rule: r2.combo.concat(f).join(' AND '),
          T: matched.length, wr, depth: 3,
          combo: r2.combo.concat(f),
        });
      }
    }
  }

  return results.sort((a, b) => b.wr - a.wr);
}

// ─── Walk-Forward Validation ────────────────────────────────────────────────

function walkForwardValidate(dataset, combo, folds = 3) {
  const n = dataset.length;
  const foldSize = Math.floor(n / (folds + 1));
  const foldResults = [];

  for (let f = 0; f < folds; f++) {
    const testStart = (f + 1) * foldSize;
    const testEnd   = testStart + foldSize;
    const test = dataset.slice(testStart, testEnd);
    const matched = test.filter(x => combo.every(feat => x.feats[feat]));
    if (matched.length < 5) { foldResults.push(null); continue; }
    foldResults.push(winRate(matched));
  }

  const valid = foldResults.filter(x => x !== null);
  if (valid.length === 0) return null;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sigma = Math.sqrt(valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length) * 100;

  return { folds: valid.map(x => (x * 100).toFixed(1)), meanWR: mean * 100, sigma };
}

// ─── Numeric Feature Threshold Search ──────────────────────────────────────

function thresholdSearch(dataset, feature, goodHourFilter, minTrades = 30) {
  const vals = dataset
    .filter(x => !goodHourFilter || x.feats.ethGoodH)
    .filter(x => x.feats.outsideBB)
    .map(x => x.feats[feature])
    .sort((a, b) => a - b);

  if (vals.length < minTrades) return null;

  const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.8, 1.0, 1.5, 2.0];
  const results = [];

  for (const t of thresholds) {
    // High threshold
    const matchedHigh = dataset
      .filter(x => !goodHourFilter || x.feats.ethGoodH)
      .filter(x => x.feats.outsideBB)
      .filter(x => x.feats[feature] > t);
    if (matchedHigh.length >= minTrades) {
      results.push({ threshold: `>${t}`, T: matchedHigh.length, wr: winRate(matchedHigh) });
    }
  }

  return results.sort((a, b) => b.wr - a.wr)[0];
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.log('═'.repeat(60));
console.log('ML RULE LEARNER — ETH + SOL Feature Mining');
console.log('═'.repeat(60));

// ETH/5m
console.log('\n──── ETH/5m Dataset ────');
const { dataset: ethDS } = buildDataset('ETH', '5m');
console.log(`Total examples: ${ethDS.length}`);
console.log(`Bear wins: ${ethDS.filter(x => x.outcome === 1).length} (${(ethDS.filter(x => x.outcome === 1).length / ethDS.length * 100).toFixed(1)}%)`);

const ethRules = findBestRules(ethDS, 30);
console.log(`\nTop ETH rules found (wr > 60%):`);
const top10Eth = ethRules.filter(r => r.T >= 30).slice(0, 20);
for (const r of top10Eth) {
  console.log(`  ${r.rule.padEnd(60)} WR=${(r.wr * 100).toFixed(1)}%  T=${r.T}  depth=${r.depth}`);
}

// Validate top ETH rules
console.log('\n──── ETH Top Rule Validation (3-fold) ────');
const topEthValidate = ethRules.filter(r => r.wr > 0.64 && r.T >= 40).slice(0, 15);
for (const r of topEthValidate) {
  const wf = walkForwardValidate(ethDS, r.combo, 3);
  if (!wf) continue;
  const minFold = Math.min(...wf.folds.map(Number));
  const status = wf.meanWR > 64 && minFold > 55 ? '*** VALIDATED' :
                 wf.meanWR > 60 ? '** PROMISING' : '* MARGINAL';
  console.log(`  ${r.rule.padEnd(60)} WF=${wf.meanWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${r.T} [${wf.folds.join('/')}] ${status}`);
}

// Numeric threshold search
console.log('\n──── ETH Numeric Feature Thresholds ────');
const numFeatures = ['rsi14', 'rsi7', 'mfi10', 'emaDist50', 'emaDist20', 'bodyPct', 'bbDevPct22', 'volRatio'];
for (const feat of numFeatures) {
  const best = thresholdSearch(ethDS, feat, true, 30);
  if (best && best.wr > 0.62) {
    console.log(`  ETH/5m: ethGoodH+outsideBB+${feat}${best.threshold}: WR=${(best.wr*100).toFixed(1)}% T=${best.T}`);
  }
}

// SOL/5m (use as proxy for 15m via synth)
console.log('\n\n──── SOL/5m Dataset ────');
const { dataset: solDS } = buildDataset('SOL', '5m');
console.log(`Total examples: ${solDS.length}`);

// For SOL, replace ethGoodH with solGoodH
const solDS_adapted = solDS.map(d => ({
  ...d,
  feats: { ...d.feats, ethGoodH: d.feats.solGoodH }, // remap for same rule finder
}));

const solRules = findBestRules(solDS_adapted, 25);
console.log(`\nTop SOL rules found (wr > 60%):`);
const top10Sol = solRules.filter(r => r.T >= 25).slice(0, 20);
for (const r of top10Sol) {
  const ruleDisplay = r.rule.replace(/ethGoodH/g, 'solGoodH');
  console.log(`  ${ruleDisplay.padEnd(60)} WR=${(r.wr * 100).toFixed(1)}%  T=${r.T}  depth=${r.depth}`);
}

// Validate top SOL rules
console.log('\n──── SOL Top Rule Validation (3-fold) ────');
const topSolValidate = solRules.filter(r => r.wr > 0.62 && r.T >= 30).slice(0, 15);
for (const r of topSolValidate) {
  const wf = walkForwardValidate(solDS_adapted, r.combo, 3);
  if (!wf) continue;
  const ruleDisplay = r.rule.replace(/ethGoodH/g, 'solGoodH');
  const minFold = Math.min(...wf.folds.map(Number));
  const status = wf.meanWR > 64 && minFold > 55 ? '*** VALIDATED' :
                 wf.meanWR > 60 ? '** PROMISING' : '* MARGINAL';
  console.log(`  ${ruleDisplay.padEnd(60)} WF=${wf.meanWR.toFixed(1)}% σ=${wf.sigma.toFixed(1)}% T=${r.T} [${wf.folds.join('/')}] ${status}`);
}

// SOL numeric thresholds
console.log('\n──── SOL Numeric Feature Thresholds ────');
for (const feat of numFeatures) {
  const best = thresholdSearch(solDS_adapted, feat, true, 25);
  if (best && best.wr > 0.62) {
    console.log(`  SOL/5m: solGoodH+outsideBB+${feat}${best.threshold}: WR=${(best.wr*100).toFixed(1)}% T=${best.T}`);
  }
}

// ─── Combined Strategy Ideas ──────────────────────────────────────────────
console.log('\n\n═'.repeat(60));
console.log('NOVEL COMBO IDEAS (ML-derived)');
console.log('═'.repeat(60));

// Test specific combos that ML suggests
const combosToTest = [
  // ETH ideas
  { label: 'ETH: GoodH+aboveBB22+streakBull+rsiOverbought65', feats: ['ethGoodH','aboveBB22','streakBull','rsiOverbought65'], ds: ethDS },
  { label: 'ETH: GoodH+outsideBB+isWed', feats: ['ethGoodH','outsideBB','isWed'], ds: ethDS },
  { label: 'ETH: GoodH+outsideBB+isWed+streakBear', feats: ['ethGoodH','outsideBB','isWed','streakBear'], ds: ethDS },
  { label: 'ETH: GoodH+outsideBB+isSat', feats: ['ethGoodH','outsideBB','isSat'], ds: ethDS },
  { label: 'ETH: GoodH+aboveBB22+farFromEMA50', feats: ['ethGoodH','aboveBB22','farFromEMA50'], ds: ethDS },
  { label: 'ETH: GoodH+outsideBB+mfiOverbought70', feats: ['ethGoodH','outsideBB','mfiOverbought70'], ds: ethDS },
  { label: 'ETH: GoodH+outsideBB+highVol', feats: ['ethGoodH','outsideBB','highVol'], ds: ethDS },
  { label: 'ETH: GoodH+belowBB22+rsiOversold35', feats: ['ethGoodH','belowBB22','rsiOversold35'], ds: ethDS },
  { label: 'ETH: GoodH+belowBB22+streakBear+isWed', feats: ['ethGoodH','belowBB22','streakBear','isWed'], ds: ethDS },
  { label: 'ETH: GoodH+aboveBB22+topDayRange30', feats: ['ethGoodH','aboveBB22','topDayRange30'], ds: ethDS },
  // SOL ideas (using solGoodH)
  { label: 'SOL: solGoodH+aboveBB22+streakBull', feats: ['solGoodH','aboveBB22','streakBull'], ds: solDS },
  { label: 'SOL: solGoodH+outsideBB+isWed', feats: ['solGoodH','outsideBB','isWed'], ds: solDS },
  { label: 'SOL: solGoodH+outsideBB+isSat', feats: ['solGoodH','outsideBB','isSat'], ds: solDS },
  { label: 'SOL: solGoodH+outsideBB+isThu', feats: ['solGoodH','outsideBB','isThu'], ds: solDS },
  { label: 'SOL: solGoodH+aboveBB22+rsiOverbought65', feats: ['solGoodH','aboveBB22','rsiOverbought65'], ds: solDS },
  { label: 'SOL: solGoodH+outsideBB+mfiOverbought70', feats: ['solGoodH','outsideBB','mfiOverbought70'], ds: solDS },
  { label: 'SOL: solGoodH+outsideBB+highVol', feats: ['solGoodH','outsideBB','highVol'], ds: solDS },
  { label: 'SOL: solGoodH+aboveBB22+farFromEMA50_03', feats: ['solGoodH','aboveBB22','farFromEMA50_03'], ds: solDS },
  { label: 'SOL: solGoodH+outsideBB+streakBull+isWed', feats: ['solGoodH','outsideBB','streakBull','isWed'], ds: solDS },
  { label: 'SOL: solGoodH+belowBB22+streakBear+isThu', feats: ['solGoodH','belowBB22','streakBear','isThu'], ds: solDS },
];

for (const c of combosToTest) {
  const matched = c.ds.filter(x => c.feats.every(f => x.feats[f]));
  if (matched.length < 20) continue;
  const wr = winRate(matched);
  if (wr < 0.60) continue;

  // Quick 3-fold validation
  const n = c.ds.length;
  const foldSize = Math.floor(n / 4);
  const foldWRs = [];
  for (let f = 0; f < 3; f++) {
    const test = c.ds.slice((f+1)*foldSize, (f+2)*foldSize);
    const m = test.filter(x => c.feats.every(feat => x.feats[feat]));
    if (m.length >= 5) foldWRs.push(winRate(m) * 100);
  }
  const meanWF = foldWRs.length > 0 ? foldWRs.reduce((a,b) => a+b,0)/foldWRs.length : 0;
  const sigmaWF = foldWRs.length > 1
    ? Math.sqrt(foldWRs.reduce((a,b) => a+(b-meanWF)**2,0)/foldWRs.length)
    : 99;

  const status = meanWF > 64 && sigmaWF < 12 ? '*** VALIDATED' :
                 meanWF > 60 ? '** PROMISING' : '* MARGINAL';

  console.log(`  ${c.label.padEnd(55)} WF=${meanWF.toFixed(1)}% σ=${sigmaWF.toFixed(1)}% T=${matched.length} [${foldWRs.map(x=>x.toFixed(1)).join('/')}] ${status}`);
}

console.log('\nDone.');
