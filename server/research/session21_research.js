// Session 21: Candle geometry (wick rejection, body exhaustion) + near-miss revisit
// Untested territory: actual OHLCV shape at BB extremes
// Also revisiting session18 near-miss: MFI>78+StochK>80 was BTC=84.2% n=19 (just below cutoff)
// Correct binary exit: win if close[i+1] < close[i] for bear signal

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
  let avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcBB(closes, period = 20, mult = 2.2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, lower: mean - mult * std, mean, std, bandwidth: 2 * mult * std / mean * 100 };
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
  if (closes.length < needed) return { k: 50 };
  const rsiValues = [];
  for (let i = closes.length - stochPeriod - 5; i < closes.length; i++) {
    const slice = closes.slice(Math.max(0, i - rsiPeriod), i + 1);
    rsiValues.push(calcRSI(slice, Math.min(rsiPeriod, slice.length - 1)) || 50);
  }
  const recent = rsiValues.slice(-stochPeriod);
  const minRSI = Math.min(...recent), maxRSI = Math.max(...recent);
  const k = maxRSI === minRSI ? 50 : ((rsiValues[rsiValues.length - 1] - minRSI) / (maxRSI - minRSI)) * 100;
  return { k };
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2) return 50;
  const slice = candles.slice(-period * 2);
  let plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < slice.length; i++) {
    const { high, low, close } = slice[i];
    const { high: ph, low: pl, close: pc } = slice[i-1];
    const up = high - ph, dn = pl - low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc)));
  }
  const smoothTR = tr.slice(-period).reduce((a, b) => a + b, 0);
  const sp = plusDM.slice(-period).reduce((a, b) => a + b, 0);
  const sm = minusDM.slice(-period).reduce((a, b) => a + b, 0);
  if (smoothTR === 0) return 0;
  const diPlus = sp / smoothTR * 100, diMinus = sm / smoothTR * 100;
  const diSum = diPlus + diMinus;
  return diSum === 0 ? 0 : Math.abs(diPlus - diMinus) / diSum * 100;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-period - 1);
  let trSum = 0;
  for (let i = 1; i < slice.length; i++) {
    const { high: h, low: l, close: c } = slice[i];
    const pc = slice[i-1].close;
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return trSum / period;
}

// ── Candle geometry helpers ───────────────────────────────────────────────────
// upperWick: distance from high to max(open,close)
// lowerWick: distance from min(open,close) to low
// body: abs(close - open)
// range: high - low
function candleGeometry(c) {
  const range = c.high - c.low;
  if (range === 0) return { upperWick: 0, lowerWick: 0, body: 0, range: 0, wickRatio: 0, bodyRatio: 0 };
  const body = Math.abs(c.close - c.open);
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return {
    upperWick, lowerWick, body, range,
    wickRatio: upperWick / range,   // % of range that is upper wick
    bodyRatio: body / range,         // % of range that is body
    lowerWickRatio: lowerWick / range,
  };
}

// Volume trend: is volume declining over last N candles?
function volumeDeclining(candles, n = 3) {
  if (candles.length < n + 1) return false;
  const recent = candles.slice(-n);
  // Check if each bar's volume is < previous
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].volume >= recent[i-1].volume) return false;
  }
  return true;
}

// Walk-forward validation
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
      const win = sig === 'bear' ? candles[i+1].close < candles[i].close : candles[i+1].close > candles[i].close;
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
  return { wr: mean, sigma: std, n: totalN };
}

function loadCandles(symbol) {
  return db.prepare(`
    SELECT open_time, open, high, low, close, volume, open_time + 300000 as closeTime
    FROM candles WHERE symbol = ? AND timeframe = '5m'
    ORDER BY open_time ASC
  `).all(symbol).map(r => ({ ...r, openTime: r.open_time, closeTime: r.closeTime }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────
const TESTS = [
  // ── Group A: Wick rejection at BB extreme ─────────────────────────────────
  // Shooting star: large upper wick (>50% of range) + small body + outside BB
  {
    id: 'A1', name: 'ShootingStar(wick>50%)+RSI3>85+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      // Bear: shooting star at upper band
      if (geo.wickRatio > 0.50 && geo.bodyRatio < 0.35 && rsi3 > 85 && last.close > bb.upper) return 'bear';
      // Bull: inverted shooting star (hammer) at lower band
      if (geo.lowerWickRatio > 0.50 && geo.bodyRatio < 0.35 && rsi3 < 15 && last.close < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'A2', name: 'ShootingStar(wick>60%)+BB22+GH+ADX20 (no RSI filter)',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.wickRatio > 0.60 && geo.bodyRatio < 0.30 && last.close > bb.upper) return 'bear';
      if (geo.lowerWickRatio > 0.60 && geo.bodyRatio < 0.30 && last.close < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'A3', name: 'ShootingStar(wick>55%)+RSI14>65+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi14 === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.wickRatio > 0.55 && geo.bodyRatio < 0.30 && rsi14 > 65 && last.close > bb.upper) return 'bear';
      if (geo.lowerWickRatio > 0.55 && geo.bodyRatio < 0.30 && rsi14 < 35 && last.close < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group B: Large wick (any size) + RSI extreme at BB ────────────────────
  {
    id: 'B1', name: 'LargeWick(wick>40%)+RSI3>90+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.wickRatio > 0.40 && rsi3 > 90 && last.close > bb.upper) return 'bear';
      if (geo.lowerWickRatio > 0.40 && rsi3 < 10 && last.close < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'B2', name: 'LargeWick(wick>40%)+RSI3>90+MFI>70+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null || mfi === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.wickRatio > 0.40 && rsi3 > 90 && mfi > 70 && last.close > bb.upper) return 'bear';
      if (geo.lowerWickRatio > 0.40 && rsi3 < 10 && mfi < 30 && last.close < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group C: Small body (doji-like) = indecision at extreme ──────────────
  {
    id: 'C1', name: 'SmallBody(body<25%)+RSI3>90+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.bodyRatio < 0.25 && rsi3 > 90 && last.close > bb.upper) return 'bear';
      if (geo.bodyRatio < 0.25 && rsi3 < 10 && last.close < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'C2', name: 'SmallBody(body<20%)+RSI14>65+BB22+GH+ADX20 (higher volume)',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi14 === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.bodyRatio < 0.20 && rsi14 > 65 && last.close > bb.upper) return 'bear';
      if (geo.bodyRatio < 0.20 && rsi14 < 35 && last.close < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group D: 3+ consecutive same-direction candles at BB ─────────────────
  {
    id: 'D1', name: '3ConsecUp+RSI3>85+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      if (slice.length < 5) return null;
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const n = slice.length;
      const consec3Up = slice[n-1].close > slice[n-2].close && slice[n-2].close > slice[n-3].close && slice[n-3].close > slice[n-4].close;
      const consec3Dn = slice[n-1].close < slice[n-2].close && slice[n-2].close < slice[n-3].close && slice[n-3].close < slice[n-4].close;
      const last = closes[closes.length - 1];
      if (consec3Up && rsi3 > 85 && last > bb.upper) return 'bear';
      if (consec3Dn && rsi3 < 15 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'D2', name: '4ConsecUp+BB22+GH+ADX20 (more trades)',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      if (slice.length < 6) return null;
      const closes = slice.map(c => c.close);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb) return null;
      if (adx >= 20) return null;
      const n = slice.length;
      const consec4Up = slice[n-1].close > slice[n-2].close && slice[n-2].close > slice[n-3].close
                     && slice[n-3].close > slice[n-4].close && slice[n-4].close > slice[n-5].close;
      const consec4Dn = slice[n-1].close < slice[n-2].close && slice[n-2].close < slice[n-3].close
                     && slice[n-3].close < slice[n-4].close && slice[n-4].close < slice[n-5].close;
      const last = closes[closes.length - 1];
      if (consec4Up && last > bb.upper) return 'bear';
      if (consec4Dn && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'D3', name: '3ConsecUp+RSI3>90+MFI>68+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      if (slice.length < 5) return null;
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null || mfi === null) return null;
      if (adx >= 20) return null;
      const n = slice.length;
      const consec3Up = slice[n-1].close > slice[n-2].close && slice[n-2].close > slice[n-3].close && slice[n-3].close > slice[n-4].close;
      const consec3Dn = slice[n-1].close < slice[n-2].close && slice[n-2].close < slice[n-3].close && slice[n-3].close < slice[n-4].close;
      const last = closes[closes.length - 1];
      if (consec3Up && rsi3 > 90 && mfi > 68 && last > bb.upper) return 'bear';
      if (consec3Dn && rsi3 < 10 && mfi < 32 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group E: Volume declining during extension (exhaustion) ──────────────
  {
    id: 'E1', name: 'VolDeclining3+RSI3>90+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      if (slice.length < 5) return null;
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const last = closes[closes.length - 1];
      const volDecl = volumeDeclining(slice, 3);
      if (volDecl && rsi3 > 90 && last > bb.upper) return 'bear';
      if (volDecl && rsi3 < 10 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'E2', name: 'VolDeclining3+RSI14>65+BB22+GH+ADX20 (more trades)',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      if (slice.length < 5) return null;
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi14 === null) return null;
      if (adx >= 20) return null;
      const last = closes[closes.length - 1];
      const volDecl = volumeDeclining(slice, 3);
      if (volDecl && rsi14 > 65 && last > bb.upper) return 'bear';
      if (volDecl && rsi14 < 35 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'E3', name: 'VolDeclining3+RSI3>90+MFI>70+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      if (slice.length < 5) return null;
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null || mfi === null) return null;
      if (adx >= 20) return null;
      const last = closes[closes.length - 1];
      const volDecl = volumeDeclining(slice, 3);
      if (volDecl && rsi3 > 90 && mfi > 70 && last > bb.upper) return 'bear';
      if (volDecl && rsi3 < 10 && mfi < 30 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group F: Near-miss revisit from Session 18 ───────────────────────────
  // MFI>78+StochK>80 was BTC=84.2% n=19 (just below n=20). Try relaxed thresholds:
  {
    id: 'F1', name: 'NearMiss18: MFI>76+StochK>78+RSI14>65+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const mfi = calcMFI(slice, 14);
      const srsi = calcStochRSI(closes, 14, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi14 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (mfi > 76 && srsi.k > 78 && rsi14 > 65 && last > bb.upper) return 'bear';
      if (mfi < 24 && srsi.k < 22 && rsi14 < 35 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'F2', name: 'NearMiss18: MFI>74+StochK>78+RSI14>65+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const mfi = calcMFI(slice, 14);
      const srsi = calcStochRSI(closes, 14, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi14 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (mfi > 74 && srsi.k > 78 && rsi14 > 65 && last > bb.upper) return 'bear';
      if (mfi < 26 && srsi.k < 22 && rsi14 < 35 && last < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'F3', name: 'NearMiss18: MFI>72+StochK>82+RSI14>65+BB22+GH+ADX20 (StochK tighter)',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice) => {
      const closes = slice.map(c => c.close);
      const rsi14 = calcRSI(closes, 14);
      const mfi = calcMFI(slice, 14);
      const srsi = calcStochRSI(closes, 14, 14);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      const last = closes[closes.length - 1];
      if (!bb || rsi14 === null || mfi === null) return null;
      if (adx >= 20) return null;
      if (mfi > 72 && srsi.k > 82 && rsi14 > 65 && last > bb.upper) return 'bear';
      if (mfi < 28 && srsi.k < 18 && rsi14 < 35 && last < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group G: Large body + RSI extreme (strong trend candle at extreme) ────
  {
    id: 'G1', name: 'LargeBody(>60%)+RSI3>88+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      // Large body bearish candle (close < open, range big) at upper band = blowoff top
      const largeBearBody = geo.bodyRatio > 0.60 && last.close < last.open;
      const largeBullBody = geo.bodyRatio > 0.60 && last.close > last.open;
      if (largeBearBody && rsi3 > 88 && last.close > bb.upper) return 'bear';
      if (largeBullBody && rsi3 < 12 && last.close < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'G2', name: 'LargeBody(>70%)+BB22+GH+ADX20 (pure body filter)',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      const closes = slice.map(c => c.close);
      const bb = calcBB(closes, 20, 2.2);
      const adx = calcADX(slice, 14);
      if (!bb) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.bodyRatio > 0.70 && last.close < last.open && last.close > bb.upper) return 'bear';
      if (geo.bodyRatio > 0.70 && last.close > last.open && last.close < bb.lower) return 'bull';
      return null;
    }
  },

  // ── Group H: ATR-normalized wick (wick size relative to ATR) ─────────────
  {
    id: 'H1', name: 'WickGtATR50%+RSI3>90+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      if (slice.length < 16) return null;
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const bb = calcBB(closes, 20, 2.2);
      const atr = calcATR(slice, 14);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null || atr === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      // Upper wick > 50% of ATR (significant rejection)
      if (geo.upperWick > atr * 0.5 && rsi3 > 90 && last.close > bb.upper) return 'bear';
      if (geo.lowerWick > atr * 0.5 && rsi3 < 10 && last.close < bb.lower) return 'bull';
      return null;
    }
  },
  {
    id: 'H2', name: 'WickGtATR30%+RSI3>90+MFI>70+BB22+GH+ADX20',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    goodHours: { ETH: [10,11,12,21], BTC: [1,12,13,16,20], SOL: [0,12,13,20], XRP: [6,9,12,18] },
    signalFn: (slice, last) => {
      if (slice.length < 16) return null;
      const closes = slice.map(c => c.close);
      const rsi3 = calcRSI(closes, 3);
      const mfi = calcMFI(slice, 14);
      const bb = calcBB(closes, 20, 2.2);
      const atr = calcATR(slice, 14);
      const adx = calcADX(slice, 14);
      if (!bb || rsi3 === null || mfi === null || atr === null) return null;
      if (adx >= 20) return null;
      const geo = candleGeometry(last);
      if (geo.upperWick > atr * 0.3 && rsi3 > 90 && mfi > 70 && last.close > bb.upper) return 'bear';
      if (geo.lowerWick > atr * 0.3 && rsi3 < 10 && mfi < 30 && last.close < bb.lower) return 'bull';
      return null;
    }
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────
async function main() {
  const COINS = ['ETH', 'BTC', 'SOL', 'XRP'];
  const cache = {};
  for (const coin of COINS) {
    cache[coin] = loadCandles(coin);
    console.log(`Loaded ${cache[coin].length} candles for ${coin}`);
  }

  console.log('\n=== SESSION 21: Candle geometry + near-miss revisit ===\n');
  const winners = [];

  for (const test of TESTS) {
    console.log(`\n── ${test.id}: ${test.name}`);
    for (const coin of test.coins) {
      const candles = cache[coin];
      if (!candles || candles.length < 200) continue;
      const gh = test.goodHours[coin] || [];
      const result = walkForward(candles, (slice) => test.signalFn(slice, slice[slice.length - 1]), gh);
      if (!result) continue;
      const wrPct = (result.wr * 100).toFixed(1);
      const sigPct = (result.sigma * 100).toFixed(1);
      const tpd = (result.n / 180).toFixed(2);
      const flag = result.wr >= 0.70 && result.n >= 20 ? ' 🔥' : (result.wr >= 0.65 && result.n >= 15 ? ' ~' : '');
      if (result.n > 0) console.log(`  ${coin}: ${wrPct}% WR, n=${result.n}, σ=${sigPct}%, tpd=${tpd}${flag}`);
      if (result.wr >= 0.70 && result.n >= 20) {
        winners.push({ id: test.id, name: test.name, coin, ...result });
      }
    }
  }

  console.log('\n\n=== WINNERS (WR≥70%, n≥20) ===');
  if (winners.length === 0) {
    console.log('No winners. Research ceiling confirmed for candle geometry patterns.');
  } else {
    winners.sort((a, b) => b.wr - a.wr);
    for (const w of winners) {
      const flag = w.sigma < 0.05 ? ' 🏆 ULTRA STABLE' : w.sigma < 0.10 ? ' ✅ STABLE' : '';
      console.log(`  ${w.id} ${w.coin}: ${(w.wr*100).toFixed(1)}% WR n=${w.n} σ=${(w.sigma*100).toFixed(1)}%${flag}`);
    }
  }

  console.log('\n=== CANDIDATES (WR≥62%, n≥15) ===');
  for (const test of TESTS) {
    for (const coin of test.coins) {
      const candles = cache[coin];
      if (!candles || candles.length < 200) continue;
      const gh = test.goodHours[coin] || [];
      const result = walkForward(candles, (slice) => test.signalFn(slice, slice[slice.length - 1]), gh);
      if (!result || result.n < 15 || result.wr < 0.62) continue;
      const tpd = (result.n / 180).toFixed(2);
      console.log(`  ${test.id} ${coin}: ${(result.wr*100).toFixed(1)}% n=${result.n} σ=${(result.sigma*100).toFixed(1)}% tpd=${tpd}`);
    }
  }

  db.close();
}

main().catch(console.error);
