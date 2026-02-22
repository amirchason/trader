// Session 20: Triple RSI variants + VWAP deviation + BB%B deep + Quad RSI
// Building on Session 19's discovery: triple RSI alignment (σ=2.9% ULTRA STABLE)
// Focus: tighter thresholds, additional filters, VWAP-based, BB%B>1.15
// All using correct binary exit: win if close[i+1] < close[i] for bear signal
// Walk-forward 5-fold validation

const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '../../trader.db'));

// ── Helpers ──────────────────────────────────────────────────────────────────
function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcBB(closes, period = 20, mult = 2.2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, lower: mean - mult * std, mean, std };
}

function calcMFI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  const slice = candles.slice(-period - 1);
  for (let i = 1; i <= period; i++) {
    const tp = (slice[i].high + slice[i].low + slice[i].close) / 3;
    const tpPrev = (slice[i-1].high + slice[i-1].low + slice[i-1].close) / 3;
    const mf = tp * slice[i].volume;
    if (tp > tpPrev) posFlow += mf; else negFlow += mf;
  }
  if (negFlow === 0) return 100;
  return 100 - 100 / (1 + posFlow / negFlow);
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14) {
  const needed = rsiPeriod + stochPeriod + 5;
  if (closes.length < needed) return { k: 50, d: 50 };
  const rsiValues = [];
  for (let i = closes.length - stochPeriod - 5; i < closes.length; i++) {
    const slice = closes.slice(Math.max(0, i - rsiPeriod), i + 1);
    rsiValues.push(calcRSI(slice, Math.min(rsiPeriod, slice.length - 1)) || 50);
  }
  const recent = rsiValues.slice(-stochPeriod);
  const minRSI = Math.min(...recent);
  const maxRSI = Math.max(...recent);
  const k = maxRSI === minRSI ? 50 : ((rsiValues[rsiValues.length - 1] - minRSI) / (maxRSI - minRSI)) * 100;
  return { k };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 50;
  const slice = candles.slice(-period * 2);
  let plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < slice.length; i++) {
    const high = slice[i].high, low = slice[i].low, close = slice[i].close;
    const prevHigh = slice[i-1].high, prevLow = slice[i-1].low, prevClose = slice[i-1].close;
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  const smoothTR = tr.slice(-period).reduce((a, b) => a + b, 0);
  const smoothPlus = plusDM.slice(-period).reduce((a, b) => a + b, 0);
  const smoothMinus = minusDM.slice(-period).reduce((a, b) => a + b, 0);
  if (smoothTR === 0) return 0;
  const diPlus = (smoothPlus / smoothTR) * 100;
  const diMinus = (smoothMinus / smoothTR) * 100;
  const diSum = diPlus + diMinus;
  if (diSum === 0) return 0;
  return (Math.abs(diPlus - diMinus) / diSum) * 100;
}

function calcBBPctB(closes, period = 20, mult = 2.2) {
  const bb = calcBB(closes, period, mult);
  if (!bb) return null;
  const bandWidth = bb.upper - bb.lower;
  if (bandWidth === 0) return 0.5;
  return (closes[closes.length - 1] - bb.lower) / bandWidth;
}

function calcVWAP(candles) {
  // Rolling session VWAP from start of day (UTC midnight)
  const lastCandle = candles[candles.length - 1];
  const dayStart = new Date(lastCandle.closeTime);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    if (c.closeTime >= dayStartMs) {
      const tp = (c.high + c.low + c.close) / 3;
      cumTPV += tp * c.volume;
      cumVol += c.volume;
    }
  }
  return cumVol > 0 ? cumTPV / cumVol : candles[candles.length - 1].close;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1);
  let trSum = 0;
  for (let i = 1; i < slice.length; i++) {
    const h = slice[i].high, l = slice[i].low, pc = slice[i - 1].close;
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return trSum / period;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ── Walk-forward validation ───────────────────────────────────────────────────
function walkForward(candles, signalFn, goodHours, nFolds = 5) {
  const foldSize = Math.floor(candles.length / nFolds);
  const results = [];
  for (let fold = 0; fold < nFolds; fold++) {
    const start = fold * foldSize;
    const end = fold === nFolds - 1 ? candles.length - 1 : (fold + 1) * foldSize;
    let wins = 0, total = 0;
    for (let i = start + 50; i < end - 1; i++) {
      const slice = candles.slice(Math.max(0, i - 100), i + 1);
      const hour = new Date(candles[i].closeTime).getUTCHours();
      if (goodHours.length > 0 && !goodHours.includes(hour)) continue;
      const sig = signalFn(slice, candles[i]);
      if (sig === null) continue;
      const nextClose = candles[i + 1].close;
      const currClose = candles[i].close;
      const win = sig === 'bear' ? nextClose < currClose : nextClose > currClose;
      if (win) wins++;
      total++;
    }
    if (total >= 4) results.push({ wr: total > 0 ? wins / total : 0, n: total });
  }
  if (results.length < 3) return null;
  const wrs = results.map(r => r.wr);
  const mean = wrs.reduce((a, b) => a + b, 0) / wrs.length;
  const std = Math.sqrt(wrs.reduce((a, b) => a + (b - mean) ** 2, 0) / wrs.length);
  const totalN = results.reduce((a, r) => a + r.n, 0);
  return { wr: mean, sigma: std, n: totalN, folds: results.length, perFold: results };
}

// ── Load candles ─────────────────────────────────────────────────────────────
function loadCandles(symbol) {
  return db.prepare(`
    SELECT open_time, open, high, low, close, volume,
           open_time + 300000 as closeTime
    FROM candles WHERE symbol = ? AND timeframe = '5m'
    ORDER BY open_time ASC
  `).all(symbol).map(r => ({
    openTime: r.open_time,
    closeTime: r.closeTime,
    open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────
const TESTS = [
  // ── Group A: Tighter Triple RSI thresholds ─────────────────────────────
  {
    id: 'A1', name: 'TripleRSI_Tight: RSI3>92+RSI7>74+RSI14>70+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null || rsi14 === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 92 && rsi7 > 74 && rsi14 > 70 && last > bb.upper) return 'bear';
      if (rsi3 < 8 && rsi7 < 26 && rsi14 < 30 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'A2', name: 'TripleRSI_Ultra: RSI3>93+RSI7>75+RSI14>70+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null || rsi14 === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 93 && rsi7 > 75 && rsi14 > 70 && last > bb.upper) return 'bear';
      if (rsi3 < 7 && rsi7 < 25 && rsi14 < 30 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group B: Triple RSI + StochK filter ────────────────────────────────
  {
    id: 'B1', name: 'TripleRSI+StochK80: RSI3>90+RSI7>72+RSI14>68+StochK>80+BB22',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const srsi = calcStochRSI(closes, 14, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null || rsi14 === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 90 && rsi7 > 72 && rsi14 > 68 && srsi.k > 80 && last > bb.upper) return 'bear';
      if (rsi3 < 10 && rsi7 < 28 && rsi14 < 32 && srsi.k < 20 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'B2', name: 'TripleRSI+StochK85: RSI3>90+RSI7>72+RSI14>68+StochK>85+BB22',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const srsi = calcStochRSI(closes, 14, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null || rsi14 === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 90 && rsi7 > 72 && rsi14 > 68 && srsi.k > 85 && last > bb.upper) return 'bear';
      if (rsi3 < 10 && rsi7 < 28 && rsi14 < 32 && srsi.k < 15 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group C: Triple RSI + BB%B deep ────────────────────────────────────
  {
    id: 'C1', name: 'TripleRSI+BBpctB1.05: RSI3>90+RSI7>72+RSI14>68+BB%B>1.05+BB22',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bbPctB = calcBBPctB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (rsi3 === null || rsi7 === null || rsi14 === null || bbPctB === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 90 && rsi7 > 72 && rsi14 > 68 && bbPctB > 1.05) return 'bear';
      if (rsi3 < 10 && rsi7 < 28 && rsi14 < 32 && bbPctB < -0.05) return 'bull';
      return null;
    }
  },
  {
    id: 'C2', name: 'TripleRSI+BBpctB1.10: RSI3>90+RSI7>72+RSI14>68+BB%B>1.10+BB22',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bbPctB = calcBBPctB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (rsi3 === null || rsi7 === null || rsi14 === null || bbPctB === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 90 && rsi7 > 72 && rsi14 > 68 && bbPctB > 1.10) return 'bear';
      if (rsi3 < 10 && rsi7 < 28 && rsi14 < 32 && bbPctB < -0.10) return 'bull';
      return null;
    }
  },

  // ── Group D: BB%B deep alone ────────────────────────────────────────────
  {
    id: 'D1', name: 'BBpctB1.15+RSI3>90+MFI70+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const mfi = calcMFI(slice, 14);
      const bbPctB = calcBBPctB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (rsi3 === null || mfi === null || bbPctB === null) return null;
      if (adx >= 20) return null;
      if (bbPctB > 1.15 && rsi3 > 90 && mfi > 70) return 'bear';
      if (bbPctB < -0.15 && rsi3 < 10 && mfi < 30) return 'bull';
      return null;
    }
  },
  {
    id: 'D2', name: 'BBpctB1.20+RSI3>88+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bbPctB = calcBBPctB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (rsi3 === null || bbPctB === null) return null;
      if (adx >= 20) return null;
      if (bbPctB > 1.20 && rsi3 > 88) return 'bear';
      if (bbPctB < -0.20 && rsi3 < 12) return 'bull';
      return null;
    }
  },

  // ── Group E: VWAP deviation ────────────────────────────────────────────
  {
    id: 'E1', name: 'VWAP_dev0.3%+RSI3>90+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const vwap = calcVWAP(slice);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const vwapDev = (last - vwap) / vwap * 100;
      if (vwapDev > 0.3 && rsi3 > 90 && last > bb.upper) return 'bear';
      if (vwapDev < -0.3 && rsi3 < 10 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'E2', name: 'VWAP_dev0.5%+RSI3>88+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const vwap = calcVWAP(slice);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const vwapDev = (last - vwap) / vwap * 100;
      if (vwapDev > 0.5 && rsi3 > 88 && last > bb.upper) return 'bear';
      if (vwapDev < -0.5 && rsi3 < 12 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'E3', name: 'VWAP_dev0.5%+RSI14>62+BB22+GH+ADX20 (no RSI3)',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const vwap = calcVWAP(slice);
      const last = closes[closes.length - 1];
      if (!bb || rsi14 === null) return null;
      if (adx >= 20) return null;
      const vwapDev = (last - vwap) / vwap * 100;
      if (vwapDev > 0.5 && rsi14 > 62 && last > bb.upper) return 'bear';
      if (vwapDev < -0.5 && rsi14 < 38 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group F: Quad RSI (add RSI5) ───────────────────────────────────────
  {
    id: 'F1', name: 'QuadRSI: RSI3>90+RSI5>82+RSI7>72+RSI14>68+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi5 = calcRSI(closes, 5);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi5 === null || rsi7 === null || rsi14 === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 90 && rsi5 > 82 && rsi7 > 72 && rsi14 > 68 && last > bb.upper) return 'bear';
      if (rsi3 < 10 && rsi5 < 18 && rsi7 < 28 && rsi14 < 32 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'F2', name: 'QuadRSI+MFI: RSI3>90+RSI5>82+RSI7>72+RSI14>68+MFI>68+BB22',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi5 = calcRSI(closes, 5);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi5 === null || rsi7 === null || rsi14 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 90 && rsi5 > 82 && rsi7 > 72 && rsi14 > 68 && mfi > 68 && last > bb.upper) return 'bear';
      if (rsi3 < 10 && rsi5 < 18 && rsi7 < 28 && rsi14 < 32 && mfi < 32 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group G: RSI3>95 + RSI7 (ultra-extreme fast) ──────────────────────
  {
    id: 'G1', name: 'UltraExtreme: RSI3>95+RSI7>74+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 95 && rsi7 > 74 && last > bb.upper) return 'bear';
      if (rsi3 < 5 && rsi7 < 26 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'G2', name: 'UltraExtreme+MFI: RSI3>95+RSI7>74+MFI>68+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 95 && rsi7 > 74 && mfi > 68 && last > bb.upper) return 'bear';
      if (rsi3 < 5 && rsi7 < 26 && mfi < 32 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'G3', name: 'RSI3>95+TripleRSI: RSI3>95+RSI7>72+RSI14>68+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null || rsi14 === null) return null;
      if (adx >= 20) return null;
      if (rsi3 > 95 && rsi7 > 72 && rsi14 > 68 && last > bb.upper) return 'bear';
      if (rsi3 < 5 && rsi7 < 28 && rsi14 < 32 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group H: EMA deviation at BB extreme ───────────────────────────────
  {
    id: 'H1', name: 'EMA9_dev+RSI3>90+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const ema9 = calcEMA(closes, 9);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || ema9 === null) return null;
      if (adx >= 20) return null;
      const emaDev = (last - ema9) / ema9 * 100;
      if (emaDev > 0.3 && rsi3 > 90 && last > bb.upper) return 'bear';
      if (emaDev < -0.3 && rsi3 < 10 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'H2', name: 'EMA9_dev0.5%+RSI14>65+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const ema9 = calcEMA(closes, 9);
      const last = closes[closes.length - 1];
      if (!bb || rsi14 === null || ema9 === null) return null;
      if (adx >= 20) return null;
      const emaDev = (last - ema9) / ema9 * 100;
      if (emaDev > 0.5 && rsi14 > 65 && last > bb.upper) return 'bear';
      if (emaDev < -0.5 && rsi14 < 35 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group I: Triple RSI + 4h ADX gate ──────────────────────────────────
  // Note: can't test 4h gating here (no 4h data loaded), skip to deferred

  // ── Group J: MFI extreme bands ─────────────────────────────────────────
  {
    id: 'J1', name: 'MFI>80+RSI3>90+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (mfi > 80 && rsi3 > 90 && last > bb.upper) return 'bear';
      if (mfi < 20 && rsi3 < 10 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'J2', name: 'MFI>80+RSI3>90+RSI14>65+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi14 = calcRSI(closes, 14);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi14 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (mfi > 80 && rsi3 > 90 && rsi14 > 65 && last > bb.upper) return 'bear';
      if (mfi < 20 && rsi3 < 10 && rsi14 < 35 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'J3', name: 'MFI>80+TripleRSI+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const rsi7 = calcRSI(closes, 7);
      const rsi14 = calcRSI(closes, 14);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi3 === null || rsi7 === null || rsi14 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (mfi > 80 && rsi3 > 90 && rsi7 > 72 && rsi14 > 68 && last > bb.upper) return 'bear';
      if (mfi < 20 && rsi3 < 10 && rsi7 < 28 && rsi14 < 32 && last < bb.lower) return 'bull';
      return null;
    }
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────
async function main() {
  const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
  const candleCache = {};
  for (const coin of COINS) {
    candleCache[coin] = loadCandles(coin);
    console.log(`Loaded ${candleCache[coin].length} candles for ${coin}`);
  }

  console.log('\n=== SESSION 20: Triple RSI variants + VWAP + BB%B deep + Quad RSI ===\n');

  const THRESHOLD_WR = 0.70;
  const THRESHOLD_N = 20;
  const winners = [];

  for (const test of TESTS) {
    console.log(`\n── ${test.id}: ${test.name}`);
    const coinResults = {};
    for (const coin of test.coins) {
      const candles = candleCache[coin];
      if (!candles || candles.length < 200) continue;
      const gh = test.goodHours[coin] || [];
      const result = walkForward(candles, (slice) => test.signalFn(slice, coin), gh);
      if (!result) { coinResults[coin] = 'insufficient data'; continue; }
      const wrPct = (result.wr * 100).toFixed(1);
      const sigPct = (result.sigma * 100).toFixed(1);
      const tpd = (result.n / 180).toFixed(2);
      const flag = result.wr >= THRESHOLD_WR && result.n >= THRESHOLD_N ? ' 🔥' : '';
      console.log(`  ${coin}: ${wrPct}% WR, n=${result.n}, σ=${sigPct}%, tpd=${tpd}${flag}`);
      coinResults[coin] = result;
    }
    // Check for winners
    for (const [coin, result] of Object.entries(coinResults)) {
      if (typeof result === 'object' && result.wr >= THRESHOLD_WR && result.n >= THRESHOLD_N) {
        winners.push({ id: test.id, name: test.name, coin, ...result });
      }
    }
  }

  console.log('\n\n=== WINNERS (WR≥70%, n≥20) ===');
  if (winners.length === 0) {
    console.log('No winners found. Consider relaxing thresholds or exploring different patterns.');
  } else {
    winners.sort((a, b) => b.wr - a.wr);
    for (const w of winners) {
      const flag = w.sigma < 0.05 ? ' 🏆 ULTRA STABLE' : w.sigma < 0.10 ? ' ✅ STABLE' : '';
      console.log(`  ${w.id} ${w.coin}: ${(w.wr*100).toFixed(1)}% WR n=${w.n} σ=${(w.sigma*100).toFixed(1)}%${flag}`);
    }
  }

  // Summary table
  console.log('\n=== CANDIDATE SUMMARY (WR≥65%, n≥15) ===');
  for (const test of TESTS) {
    for (const coin of test.coins) {
      const candles = candleCache[coin];
      if (!candles || candles.length < 200) continue;
      const gh = test.goodHours[coin] || [];
      const result = walkForward(candles, (slice) => test.signalFn(slice, coin), gh);
      if (!result) continue;
      if (result.wr >= 0.65 && result.n >= 15) {
        const tpd = (result.n / 180).toFixed(2);
        console.log(`  ${test.id} ${coin}: ${(result.wr*100).toFixed(1)}% n=${result.n} σ=${(result.sigma*100).toFixed(1)}% tpd=${tpd}`);
      }
    }
  }

  db.close();
}

main().catch(console.error);
