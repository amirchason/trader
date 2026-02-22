// XRP feature correlation analysis + logistic regression
// Find which features best predict XRP reversal at BB extremes
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'), { readonly: true });

function loadCandles(sym, tf) {
  return db.prepare('SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time').all(sym, tf);
}

function calcBB(candles, end, period, mult) {
  if (end < period - 1) return null;
  const sl = candles.slice(end - period + 1, end + 1).map(x => x.close);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: mean + mult * std, lower: mean - mult * std, mid: mean, std };
}

function calcRSI(candles, end, period) {
  if (end < period) return null;
  let gains = 0, losses = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change; else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcMFI(candles, end, period) {
  if (end < period) return null;
  let posMF = 0, negMF = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const tpPrev = (candles[i-1].high + candles[i-1].low + candles[i-1].close) / 3;
    const mf = tp * candles[i].volume;
    if (tp >= tpPrev) posMF += mf; else negMF += mf;
  }
  if (negMF === 0) return 100;
  return 100 - 100 / (1 + posMF / negMF);
}

function calcATR(candles, end, period) {
  if (end < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const h = candles[i].high, l = candles[i].low;
    const pc = candles[i - 1].close;
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return sum / period;
}

function gd(c) { return c.close >= c.open ? 'G' : 'R'; }

function streakLen(candles, i) {
  const d = gd(candles[i]); let n = 1;
  for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
    if (gd(candles[j]) === d) n++; else break;
  }
  return n;
}

function pearsonCorr(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return 0;
  return num / Math.sqrt(dx2 * dy2);
}

// Sigmoid and logistic regression
function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x)))); }

function normalizeFeatures(X) {
  const n = X.length, m = X[0].length;
  const means = Array(m).fill(0), stds = Array(m).fill(1);
  for (let j = 0; j < m; j++) {
    means[j] = X.reduce((s, row) => s + row[j], 0) / n;
    const variance = X.reduce((s, row) => s + Math.pow(row[j] - means[j], 2), 0) / n;
    stds[j] = Math.sqrt(variance) || 1;
  }
  const Xn = X.map(row => row.map((v, j) => (v - means[j]) / stds[j]));
  return { Xn, means, stds };
}

function trainLogReg(X, y, epochs, lr, lambda) {
  const m = X[0].length;
  const w = Array(m).fill(0), b = [0];
  for (let e = 0; e < epochs; e++) {
    let dw = Array(m).fill(0), db = 0;
    for (let i = 0; i < X.length; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], b[0]);
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < m; j++) dw[j] += err * X[i][j];
      db += err;
    }
    for (let j = 0; j < m; j++) w[j] -= lr * (dw[j] / X.length + lambda * w[j]);
    b[0] -= lr * db / X.length;
  }
  return { w, b: b[0] };
}

function predictLogReg(X, w, b) {
  return X.map(row => {
    const z = row.reduce((s, x, j) => s + x * w[j], b);
    return sigmoid(z) >= 0.5 ? 1 : 0;
  });
}

// Build feature dataset
function buildFeatures(sym, tf, goodHours) {
  const ca = loadCandles(sym, tf);
  const data = [];
  const warmup = 30;

  // Precompute ATR percentiles using rolling window
  const atrValues = [];
  for (let i = 1; i < ca.length; i++) {
    const atr = calcATR(ca, i, 14);
    atrValues.push(atr || 0);
  }

  for (let i = warmup; i < ca.length - 1; i++) {
    const x = ca[i];
    const hour = new Date(x.open_time).getUTCHours();
    const dayOfWeek = new Date(x.open_time).getUTCDay();

    // BB features
    const bb20 = calcBB(ca, i, 20, 2.0);
    if (!bb20) continue;
    const bbRange = bb20.upper - bb20.lower;
    if (bbRange === 0) continue;

    const bbPos = (x.close - bb20.lower) / bbRange; // 0=lower, 1=upper
    const bbDistUpper = (x.close - bb20.upper) / bb20.upper * 100; // % above upper
    const bbDistLower = (bb20.lower - x.close) / bb20.lower * 100; // % below lower

    // RSI, MFI
    const rsi = calcRSI(ca, i, 14) || 50;
    const mfi = calcMFI(ca, i, 10) || 50;

    // ATR percentile
    const atr = calcATR(ca, i, 14) || 0;
    const atrSlice = atrValues.slice(Math.max(0, i - 100), i);
    const atrPct = atrSlice.filter(a => a < atr).length / Math.max(atrSlice.length, 1);

    // Volume
    const volAvg = ca.slice(Math.max(0, i - 20), i).reduce((s, c) => s + c.volume, 0) / 20;
    const volRatio = volAvg > 0 ? x.volume / volAvg : 1;

    // Candle structure
    const body = Math.abs(x.close - x.open);
    const range = x.high - x.low;
    const bodyPct = x.open > 0 ? body / x.open * 100 : 0;
    const upperWick = range > 0 ? (x.high - Math.max(x.open, x.close)) / range : 0;
    const lowerWick = range > 0 ? (Math.min(x.open, x.close) - x.low) / range : 0;

    // Streak
    const st = streakLen(ca, i);
    const isGreen = x.close >= x.open ? 1 : 0;

    // BB(25,2.2) — the winning params
    const bb25 = calcBB(ca, i, 25, 2.2);
    const bbPos25 = bb25 ? (x.close - bb25.lower) / (bb25.upper - bb25.lower) : 0.5;
    const isBear25 = bb25 ? (x.close > bb25.upper ? 1 : 0) : 0;
    const isBull25 = bb25 ? (x.close < bb25.lower ? 1 : 0) : 0;

    // Good hours
    const isGoodHour = goodHours.includes(hour) ? 1 : 0;

    // Label: next candle bears (if current is above BB) or bulls (if below BB)
    const nxt = ca[i + 1];
    const isBear20 = x.close > bb20.upper;
    const isBull20 = x.close < bb20.lower;
    if (!isBear20 && !isBull20) continue; // only signal candles
    const label = isBear20 ? (nxt.close < nxt.open ? 1 : 0) : (nxt.close > nxt.open ? 1 : 0);

    // Hour encoding (cyclic)
    const hourSin = Math.sin(2 * Math.PI * hour / 24);
    const hourCos = Math.cos(2 * Math.PI * hour / 24);
    const dowSin = Math.sin(2 * Math.PI * dayOfWeek / 7);
    const dowCos = Math.cos(2 * Math.PI * dayOfWeek / 7);

    data.push({
      features: [
        hourSin, hourCos,           // 0,1: hour (cyclic)
        dowSin, dowCos,             // 2,3: day of week (cyclic)
        bbPos,                       // 4: BB position (0=lower, 1=upper)
        bbDistUpper,                 // 5: % above upper
        bbDistLower,                 // 6: % below lower
        rsi / 100,                   // 7: RSI (normalized)
        mfi / 100,                   // 8: MFI (normalized)
        st,                          // 9: streak length
        isGreen,                     // 10: current candle green
        bodyPct,                     // 11: body %
        volRatio,                    // 12: volume ratio
        upperWick,                   // 13: upper wick ratio
        lowerWick,                   // 14: lower wick ratio
        atrPct,                      // 15: ATR percentile
        bbPos25,                     // 16: BB(25,2.2) position
        isGoodHour,                  // 17: in good hours
      ],
      label,
      hour,
      dayOfWeek,
      isBear: isBear20 ? 1 : 0,
    });
  }
  return data;
}

const FEATURE_NAMES = [
  'hour_sin', 'hour_cos', 'dow_sin', 'dow_cos',
  'bb_pos', 'bb_dist_upper', 'bb_dist_lower',
  'rsi', 'mfi', 'streak', 'is_green', 'body_pct',
  'vol_ratio', 'upper_wick', 'lower_wick', 'atr_pct',
  'bb25_pos', 'is_good_hour',
];

const GOOD_HOURS = [6, 9, 12, 18]; // from sweep results

console.log('=== XRP/15m Feature Correlation Analysis ===');
const data15m = buildFeatures('XRP', '15m', GOOD_HOURS);
console.log(`Dataset size: ${data15m.length} samples (BB-extreme candles only)`);
console.log(`Label distribution: ${data15m.filter(d => d.label === 1).length} wins / ${data15m.length} total = ${(data15m.filter(d => d.label === 1).length / data15m.length * 100).toFixed(1)}%`);

// Pearson correlations
const corrs = FEATURE_NAMES.map((name, j) => {
  const xs = data15m.map(d => d.features[j]);
  const ys = data15m.map(d => d.label);
  return { name, r: pearsonCorr(xs, ys) };
});
corrs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));

console.log('\nFeature correlations with reversal (sorted by |r|):');
corrs.forEach(c => {
  const bar = '█'.repeat(Math.round(Math.abs(c.r) * 100));
  console.log(`  ${c.name.padEnd(20)} r=${c.r >= 0 ? '+' : ''}${c.r.toFixed(3)}  ${bar}`);
});

// Logistic regression walk-forward
console.log('\n=== Logistic Regression Walk-Forward ===');
const n = data15m.length;
const folds = 3, fsz = Math.floor(n / folds);

let totalCorrect = 0, totalSamples = 0;
const foldAccs = [];

for (let f = 0; f < folds; f++) {
  const testStart = f * fsz;
  const testEnd = (f === folds - 1) ? n : (f + 1) * fsz;
  const trainData = [...data15m.slice(0, testStart), ...data15m.slice(testEnd)];
  const testData = data15m.slice(testStart, testEnd);

  if (trainData.length < 50 || testData.length === 0) continue;

  const Xtrain = trainData.map(d => d.features);
  const ytrain = trainData.map(d => d.label);
  const Xtest = testData.map(d => d.features);
  const ytest = testData.map(d => d.label);

  const { Xn: XtrainN, means, stds } = normalizeFeatures(Xtrain);
  const XtestN = Xtest.map(row => row.map((v, j) => (v - means[j]) / stds[j]));

  const { w, b } = trainLogReg(XtrainN, ytrain, 500, 0.1, 0.01);
  const preds = predictLogReg(XtestN, w, b);

  const correct = preds.filter((p, i) => p === ytest[i]).length;
  const acc = correct / ytest.length;
  foldAccs.push(acc);
  totalCorrect += correct;
  totalSamples += ytest.length;

  console.log(`  Fold ${f+1}: accuracy=${(acc*100).toFixed(1)}%  (${correct}/${ytest.length})`);
}
const avgAcc = foldAccs.reduce((a, b) => a + b, 0) / foldAccs.length;
const sigma = Math.sqrt(foldAccs.reduce((s, v) => s + Math.pow(v - avgAcc, 2), 0) / foldAccs.length);
console.log(`  Overall: ${(avgAcc*100).toFixed(1)}% σ=${(sigma*100).toFixed(1)}%`);

// Train final model to get feature weights
const X = data15m.map(d => d.features);
const y = data15m.map(d => d.label);
const { Xn, means, stds } = normalizeFeatures(X);
const { w, b } = trainLogReg(Xn, y, 1000, 0.05, 0.01);

console.log('\nLogistic Regression Feature Weights (sorted by |weight|):');
const weights = FEATURE_NAMES.map((name, j) => ({ name, w: w[j] }));
weights.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
weights.forEach(fw => {
  const bar = '█'.repeat(Math.round(Math.abs(fw.w) * 10));
  console.log(`  ${fw.name.padEnd(20)} w=${fw.w >= 0 ? '+' : ''}${fw.w.toFixed(3)}  ${bar}`);
});

// Key insight: what feature threshold adds the most value?
console.log('\n=== Top Feature Threshold Analysis ===');
// Check hour impact
const goodH = data15m.filter(d => GOOD_HOURS.includes(d.hour));
const badH = data15m.filter(d => !GOOD_HOURS.includes(d.hour));
console.log(`Good hours [${GOOD_HOURS.join(',')}]: ${(goodH.filter(d => d.label===1).length/goodH.length*100).toFixed(1)}% WR (${goodH.length} samples)`);
console.log(`Other hours: ${(badH.filter(d => d.label===1).length/badH.length*100).toFixed(1)}% WR (${badH.length} samples)`);

// RSI threshold
for (const thresh of [60, 65, 70, 75, 80]) {
  const highRSI = data15m.filter(d => d.features[7] * 100 > thresh && d.isBear === 1);
  const wr = highRSI.filter(d => d.label === 1).length / Math.max(highRSI.length, 1);
  if (highRSI.length >= 10) console.log(`RSI>${thresh} bear: ${(wr*100).toFixed(1)}% WR (${highRSI.length} samples)`);
}

// MFI threshold
for (const thresh of [60, 65, 70, 75, 80]) {
  const highMFI = data15m.filter(d => d.features[8] * 100 > thresh && d.isBear === 1);
  const wr = highMFI.filter(d => d.label === 1).length / Math.max(highMFI.length, 1);
  if (highMFI.length >= 10) console.log(`MFI>${thresh} bear: ${(wr*100).toFixed(1)}% WR (${highMFI.length} samples)`);
}

// Streak × hour interaction
for (const minStr of [1, 2, 3]) {
  const streakGoodH = goodH.filter(d => d.features[9] >= minStr);
  const wr = streakGoodH.filter(d => d.label === 1).length / Math.max(streakGoodH.length, 1);
  if (streakGoodH.length >= 10) console.log(`GoodH+streak>=${minStr}: ${(wr*100).toFixed(1)}% WR (${streakGoodH.length} samples)`);
}

// ATR percentile impact
const lowATR = data15m.filter(d => d.features[15] < 0.33);
const highATR = data15m.filter(d => d.features[15] > 0.67);
console.log(`Low ATR (<33pct): ${(lowATR.filter(d=>d.label===1).length/Math.max(lowATR.length,1)*100).toFixed(1)}% WR (${lowATR.length} samples)`);
console.log(`High ATR (>67pct): ${(highATR.filter(d=>d.label===1).length/Math.max(highATR.length,1)*100).toFixed(1)}% WR (${highATR.length} samples)`);

// Volume ratio impact
const highVol = data15m.filter(d => d.features[12] > 1.5);
const lowVol = data15m.filter(d => d.features[12] < 0.8);
console.log(`High vol (>1.5x): ${(highVol.filter(d=>d.label===1).length/Math.max(highVol.length,1)*100).toFixed(1)}% WR (${highVol.length} samples)`);
console.log(`Low vol (<0.8x): ${(lowVol.filter(d=>d.label===1).length/Math.max(lowVol.length,1)*100).toFixed(1)}% WR (${lowVol.length} samples)`);

console.log('\nDone.');
