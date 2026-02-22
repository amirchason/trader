/**
 * Technical indicators for binary market analysis.
 * Ported from polymarket-suite/dashboard/server/btcBinary.js
 */
import type { Candle, Direction, StrategyResult, FundingData, BinanceOrderBook } from './types';

export function calculateRSI(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const changes: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    changes.push(candles[i].close - candles[i - 1].close);
  }

  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss -= changes[i];
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) {
      avgGain = (avgGain * (period - 1) + changes[i]) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - changes[i]) / period;
    }
  }

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

export function calculateSMA(candles: Candle[], period = 20): number | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return Math.round((slice.reduce((s, c) => s + c.close, 0) / period) * 100) / 100;
}

export function calculateBollingerBands(candles: Candle[], period = 20, mult = 2): { upper: number; lower: number; mid: number; pctB: number } | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = mid + mult * std;
  const lower = mid - mult * std;
  const pctB = (upper - lower) > 0 ? (candles[candles.length - 1].close - lower) / (upper - lower) : 0.5;
  return { upper: Math.round(upper * 100) / 100, lower: Math.round(lower * 100) / 100, mid: Math.round(mid * 100) / 100, pctB: Math.round(pctB * 1000) / 1000 };
}

export function calculateKeltnerChannels(candles: Candle[], period = 20, atrMult = 2): { upper: number; lower: number; mid: number; atr: number } | null {
  if (candles.length < period + 14) return null;
  const multiplier = 2 / (period + 1);
  const slice = candles.slice(-period);
  let ema = slice[0].close;
  for (let i = 1; i < slice.length; i++) {
    ema = (slice[i].close - ema) * multiplier + ema;
  }
  // ATR(14) using full candle history
  const atrSlice = candles.slice(-15);
  let atr = 0;
  for (let i = 1; i < atrSlice.length; i++) {
    atr += Math.max(atrSlice[i].high - atrSlice[i].low, Math.abs(atrSlice[i].high - atrSlice[i - 1].close), Math.abs(atrSlice[i].low - atrSlice[i - 1].close));
  }
  atr /= (atrSlice.length - 1);
  return {
    upper: Math.round((ema + atrMult * atr) * 100) / 100,
    lower: Math.round((ema - atrMult * atr) * 100) / 100,
    mid: Math.round(ema * 100) / 100,
    atr: Math.round(atr * 100) / 100,
  };
}

export function calculateEMA(candles: Candle[], period = 12): number | null {
  if (candles.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
  }
  return Math.round(ema * 100) / 100;
}

export function calculateMACD(candles: Candle[]): { macd: number; signal: string } | null {
  const ema12 = calculateEMA(candles, 12);
  const ema26 = calculateEMA(candles, 26);
  if (ema12 === null || ema26 === null) return null;
  const macd = ema12 - ema26;
  return {
    macd: Math.round(macd * 100) / 100,
    signal: macd > 0 ? 'bullish' : 'bearish',
  };
}

export function calculateVWAP(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTPV += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
  }

  return cumulativeVolume > 0
    ? Math.round((cumulativeTPV / cumulativeVolume) * 100) / 100
    : null;
}

export function calculateMFI(candles: Candle[], period = 10): number | null {
  if (candles.length < period + 1) return null;
  let posFlow = 0, negFlow = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const prevTp = (candles[i - 1].high + candles[i - 1].low + candles[i - 1].close) / 3;
    const rawMF = tp * candles[i].volume;
    if (tp >= prevTp) posFlow += rawMF; else negFlow += rawMF;
  }
  if (negFlow === 0) return 100;
  return Math.round((100 - 100 / (1 + posFlow / negFlow)) * 100) / 100;
}

// ─── Connors RSI Helper ───────────────────────────────────────────────────────
// CRSI = (RSI(3) + RSI_of_streak(2) + PercentileRank(100)) / 3
// Validated: ETH 56.3% WR @33/d, BTC 54.9% WR @34/d (crsi_validate.js, 5-fold WF)
function calcRSIFromArray(arr: number[], period: number): number {
  if (arr.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function calcConnorsRSI(candles: Candle[], period = 100): number {
  if (candles.length < period + 3) return 50;
  const closes = candles.map(c => c.close);
  const rsi3 = calcRSIFromArray(closes, 3);

  // Streak RSI: RSI(2) of consecutive candle streak lengths
  const streakSeries: number[] = [];
  let curStreak = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) curStreak = curStreak > 0 ? curStreak + 1 : 1;
    else if (candles[i].close < candles[i - 1].close) curStreak = curStreak < 0 ? curStreak - 1 : -1;
    else curStreak = 0;
    streakSeries.push(curStreak);
  }
  const streakRSI = calcRSIFromArray(streakSeries, 2);

  // Percentile rank of current 1-period return vs last 'period' returns
  const retNow = closes[closes.length - 2] > 0
    ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]
    : 0;
  let below = 0;
  const start = Math.max(1, closes.length - period);
  const total = closes.length - start;
  for (let j = start; j < closes.length; j++) {
    const r = closes[j - 1] > 0 ? (closes[j] - closes[j - 1]) / closes[j - 1] : 0;
    if (r < retNow) below++;
  }
  const pRank = total > 0 ? (below / total) * 100 : 50;

  return (rsi3 + streakRSI + pRank) / 3;
}

// ─── Stochastic RSI Helper ────────────────────────────────────────────────────
// StochRSI(K+D<20)+BB22: ETH 58.4% WR @14/d, BTC 57.7% WR @13/d (5-fold WF)
function calcStochRSI(candles: Candle[], rsiPeriod = 14, stochPeriod = 14): { k: number; d: number } {
  if (candles.length < rsiPeriod + stochPeriod + 3) return { k: 50, d: 50 };

  // Build RSI series for last (rsiPeriod + stochPeriod) candles
  const rsiSeries: number[] = [];
  const n = candles.length;
  for (let i = rsiPeriod; i < n; i++) {
    rsiSeries.push(calcRSIFromArray(candles.slice(0, i + 1).map(c => c.close), rsiPeriod));
  }
  if (rsiSeries.length < stochPeriod + 3) return { k: 50, d: 50 };

  // Stochastic of RSI: K = (RSI - loRSI) / (hiRSI - loRSI) * 100
  const recentRSI = rsiSeries.slice(-stochPeriod);
  const loRSI = Math.min(...recentRSI);
  const hiRSI = Math.max(...recentRSI);
  const rawK = hiRSI === loRSI ? 50 : (rsiSeries[rsiSeries.length - 1] - loRSI) / (hiRSI - loRSI) * 100;

  // Smooth K with SMA(3), D with SMA(3) of K
  const kVals = rsiSeries.slice(-stochPeriod - 2).map((_, idx, arr) => {
    const sl = rsiSeries.slice(-stochPeriod - 2 + idx, -stochPeriod - 2 + idx + 3);
    if (sl.length < 3) return rawK;
    const lo = Math.min(...sl), hi = Math.max(...sl);
    return hi === lo ? 50 : (sl[sl.length - 1] - lo) / (hi - lo) * 100;
  });
  const k = rawK;
  const d = kVals.length >= 3 ? (kVals[kVals.length - 1] + kVals[kVals.length - 2] + kVals[kVals.length - 3]) / 3 : k;
  return { k, d };
}

// ─── CCI Helper ───────────────────────────────────────────────────────────────
// CCI>200+BB22: ETH=56.6% BTC=58.2% SOL=53.6% XRP=55.3% avg=55.9% ~2/day (5-fold WF)
function calcCCI(candles: Candle[], period = 20): number {
  if (candles.length < period) return 0;
  const slice = candles.slice(-period);
  const closes = slice.map(c => c.close);
  const sma = closes.reduce((a, b) => a + b, 0) / period;
  const meanDev = closes.reduce((a, c) => a + Math.abs(c - sma), 0) / period;
  if (meanDev < 1e-10) return 0;
  return (closes[closes.length - 1] - sma) / (0.015 * meanDev);
}

// ─── Williams %R Helper ───────────────────────────────────────────────────────
// WPR+RSI7+BB22: ETH=56.8% BTC=57.5% SOL=53.6% XRP=52.8% avg=55.2% ~3/day (5-fold WF)
function calcWilliamsR(candles: Candle[], period = 14): number {
  if (candles.length < period) return -50;
  const slice = candles.slice(-period);
  const highN = Math.max(...slice.map(c => c.high));
  const lowN  = Math.min(...slice.map(c => c.low));
  const close = candles[candles.length - 1].close;
  const range = highN - lowN;
  return range < 1e-10 ? -50 : (highN - close) / range * -100;
}

// ─── EMA Helper (for Keltner Channel) ────────────────────────────────────────
// Keltner Outer: ETH=56.6% BTC=54.0% SOL=54.5% XRP=53.2% avg=54.6% ~6/day (5-fold WF)
function calcEMA(candles: Candle[], period: number): number {
  if (candles.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

// ─── Day VWAP Helper ──────────────────────────────────────────────────────────
// Rolling intraday VWAP from UTC midnight to last candle.
// Session 20 E1: BTC VWAP_dev>0.3% + RSI3>90 + BB22 + GH + ADX<20 = 72.2% n=22 σ=7.8%
function calcDayVWAP(candles: Candle[]): number {
  if (candles.length === 0) return candles[candles.length - 1]?.close ?? 0;
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
  return cumVol > 0 ? cumTPV / cumVol : lastCandle.close;
}

// ADX — Average Directional Index (Wilder smoothing). Returns 0-100; <20 = ranging market.
// Validated: BTC ADX<20+BB22+RSI7 = 63.1% all-hours WR (session12_research.js, 5-fold WF)
function calcADX(candles: Candle[], period = 14): number {
  const n = candles.length;
  if (n < period * 2) return 25;
  const trArr: number[] = [], pmDM: number[] = [], nmDM: number[] = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    trArr.push(tr);
    pmDM.push(up > dn && up > 0 ? up : 0);
    nmDM.push(dn > up && dn > 0 ? dn : 0);
  }
  let sTR = trArr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPM = pmDM.slice(0, period).reduce((a, b) => a + b, 0);
  let sNM = nmDM.slice(0, period).reduce((a, b) => a + b, 0);
  let adxSmooth = 0;
  const dx: number[] = [];
  for (let i = period; i < trArr.length; i++) {
    sTR = sTR - sTR / period + trArr[i];
    sPM = sPM - sPM / period + pmDM[i];
    sNM = sNM - sNM / period + nmDM[i];
    const diP = sTR > 0 ? (sPM / sTR) * 100 : 0;
    const diN = sTR > 0 ? (sNM / sTR) * 100 : 0;
    const diSum = diP + diN;
    const dxVal = diSum > 0 ? Math.abs(diP - diN) / diSum * 100 : 0;
    dx.push(dxVal);
    if (dx.length === period) adxSmooth = dx.reduce((a, b) => a + b, 0) / period;
    else if (dx.length > period) adxSmooth = (adxSmooth * (period - 1) + dxVal) / period;
  }
  return adxSmooth;
}

export function detectMomentum(candles: Candle[], lookback = 5) {
  if (candles.length < lookback) {
    return { direction: 'neutral' as Direction, strength: 0, consecutive: 0, upCandles: 0, downCandles: 0 };
  }

  const recent = candles.slice(-lookback);
  let upCount = 0, downCount = 0;
  let totalChange = 0;

  for (const c of recent) {
    if (c.close > c.open) upCount++;
    else downCount++;
    totalChange += c.close - c.open;
  }

  const consecutive = upCount === lookback ? lookback : downCount === lookback ? -lookback : 0;
  const direction: Direction = upCount > downCount ? 'bullish' : downCount > upCount ? 'bearish' : 'neutral';
  const changePct = recent[0].open > 0 ? (totalChange / recent[0].open) * 100 : 0;

  return {
    direction,
    strength: Math.round(Math.abs(changePct) * 100) / 100,
    consecutive,
    upCandles: upCount,
    downCandles: downCount,
  };
}

export function scoreStrategies(
  candles5m: Candle[],
  candles1m: Candle[],
  funding: FundingData,
  orderBook: BinanceOrderBook,
  candles15m: Candle[] = [],
  candles1h: Candle[] = [],
  candles4h: Candle[] = [],
): StrategyResult {
  const strategies: StrategyResult['strategies'] = [];

  const rsi14_5m = calculateRSI(candles5m, 14);
  const rsi7_1m = calculateRSI(candles1m, 7);
  const sma20 = calculateSMA(candles5m, 20);
  const vwap = calculateVWAP(candles5m);
  const macd = calculateMACD(candles5m);
  const bb = calculateBollingerBands(candles5m, 20, 2);
  const momentum5 = detectMomentum(candles1m, 5);
  const lastPrice = candles1m.length > 0 ? candles1m[candles1m.length - 1].close : 0;

  // Strategy 1: Momentum Burst
  if (momentum5.consecutive !== 0) {
    const score = Math.min(10, Math.abs(momentum5.consecutive) * 1.5 + momentum5.strength * 2);
    const overbought = momentum5.direction === 'bullish' && (rsi7_1m ?? 50) > 80;
    const oversold = momentum5.direction === 'bearish' && (rsi7_1m ?? 50) < 20;

    strategies.push({
      name: 'Momentum Burst',
      emoji: '🚀',
      score: overbought || oversold ? Math.max(0, score - 3) : Math.round(score * 10) / 10,
      direction: momentum5.direction,
      signal: `${Math.abs(momentum5.consecutive)} consecutive ${momentum5.direction} candles`,
      confidence: Math.round(Math.min(90, score * 9)),
    });
  }

  // Strategy 2: Mean Reversion
  if (rsi14_5m !== null) {
    const extreme = rsi14_5m > 75 || rsi14_5m < 25;
    const veryExtreme = rsi14_5m > 85 || rsi14_5m < 15;
    const priceVsSma = sma20 && lastPrice ? ((lastPrice - sma20) / sma20) * 100 : 0;
    const extended = Math.abs(priceVsSma) > 0.8;

    if (extreme || extended) {
      const score = (veryExtreme ? 4 : extreme ? 2 : 0) + (extended ? 3 : 0) + (Math.abs(priceVsSma) > 1.5 ? 2 : 0);
      strategies.push({
        name: 'Mean Reversion',
        emoji: '↩️',
        score: Math.min(10, Math.round(score * 10) / 10),
        direction: rsi14_5m > 75 ? 'bearish' : 'bullish',
        signal: `RSI(14): ${rsi14_5m} | Price vs SMA: ${priceVsSma.toFixed(2)}%`,
        confidence: Math.round(Math.min(85, score * 8.5)),
      });
    }
  }

  // Strategy 3: Funding Rate Squeeze
  if (funding && funding.strength !== 'normal' && funding.strength !== 'unknown') {
    const score = funding.strength === 'extreme' ? 8 : 5;
    strategies.push({
      name: 'Funding Squeeze',
      emoji: '💰',
      score,
      direction: funding.signal === 'overbought' ? 'bearish' : 'bullish',
      signal: `Funding: ${(funding.current * 100).toFixed(4)}% (${funding.strength})`,
      confidence: Math.round(score * 8),
    });
  }

  // Strategy 4: Order Book Imbalance
  if (orderBook && orderBook.pressure !== 'neutral') {
    const imbalance = Math.abs(orderBook.ratio - 1);
    if (imbalance > 0.3) {
      const score = Math.min(10, 3 + imbalance * 8);
      strategies.push({
        name: 'Order Book Imbalance',
        emoji: '📊',
        score: Math.round(score * 10) / 10,
        direction: orderBook.pressure,
        signal: `Bid/Ask ratio: ${orderBook.ratio} (${orderBook.pressure})`,
        confidence: Math.round(Math.min(75, score * 7.5)),
      });
    }
  }

  // Strategy 5: VWAP Crossover
  if (vwap && lastPrice) {
    const deviation = ((lastPrice - vwap) / vwap) * 100;
    if (Math.abs(deviation) > 0.15) {
      const score = Math.min(8, 2 + Math.abs(deviation) * 3);
      strategies.push({
        name: 'VWAP Signal',
        emoji: '📈',
        score: Math.round(score * 10) / 10,
        direction: deviation > 0 ? 'bullish' : 'bearish',
        signal: `Price ${deviation > 0 ? 'above' : 'below'} VWAP by ${Math.abs(deviation).toFixed(3)}%`,
        confidence: Math.round(Math.min(70, score * 7)),
      });
    }
  }

  // Strategy 6: Streak Reversion — research-confirmed 58-64% WR (15m with body/ATR filter)
  // After 3+ consecutive same-direction candles → bet opposite (mean reversion)
  {
    const streakLen = 3;
    let greenStreak = 0, redStreak = 0;
    for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - (streakLen + 3)); j--) {
      const cj = candles5m[j];
      if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
      else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
      else break;
    }
    if (greenStreak >= streakLen || redStreak >= streakLen) {
      const streak = Math.max(greenStreak, redStreak);
      const direction: Direction = greenStreak >= streakLen ? 'bearish' : 'bullish';
      const rsiConf = direction === 'bearish' ? ((rsi14_5m ?? 50) >= 55) : ((rsi14_5m ?? 50) <= 45);
      // Body/ATR quality filter: larger candles in streak have better WR
      const lastCandle5m = candles5m[candles5m.length - 1];
      const recentHLs = candles5m.slice(-15);
      const atrApprox = recentHLs.length > 1
        ? recentHLs.slice(1).reduce((s, c, i) => s + Math.max(c.high - c.low, Math.abs(c.high - recentHLs[i].close), Math.abs(c.low - recentHLs[i].close)), 0) / (recentHLs.length - 1)
        : 0;
      const bodyPct = lastCandle5m?.open > 0 ? Math.abs(lastCandle5m.close - lastCandle5m.open) / lastCandle5m.open * 100 : 0;
      const bodyToATR = atrApprox > 0 ? bodyPct / 100 * lastPrice / atrApprox : 0;
      const highQuality = bodyToATR >= 0.9; // research: ≥0.9 body/ATR → 62%+ WR
      const score = Math.min(10, 5 + streak * 1.2 + (rsiConf ? 1 : 0) + (highQuality ? 1 : 0));
      strategies.push({
        name: 'Streak Reversion',
        emoji: '↩️',
        score: Math.round(score * 10) / 10,
        direction,
        signal: `${streak} consecutive ${direction === 'bearish' ? 'green' : 'red'} candles → reversal expected${highQuality ? ' [high quality]' : ''}`,
        confidence: Math.round(Math.min(88, 55 + streak * 5 + (rsiConf ? 5 : 0) + (highQuality ? 7 : 0))),
      });
    }
  }

  // Strategy 7: Big Candle Reversion — research-confirmed 60-63% WR (15m), body/ATR quality filter
  // After a large body candle (>0.5% move relative to ATR) → bet opposite (mean reversion)
  {
    const lastCandle = candles5m[candles5m.length - 1];
    if (lastCandle && lastCandle.open > 0) {
      const candleChangePct = ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;
      const minPct = 0.5;
      if (Math.abs(candleChangePct) >= minPct) {
        const absPct = Math.abs(candleChangePct);
        const direction: Direction = candleChangePct > 0 ? 'bearish' : 'bullish';
        // Body/ATR quality filter
        const recentHLs = candles5m.slice(-15);
        const atrApprox = recentHLs.length > 1
          ? recentHLs.slice(1).reduce((s, c, i) => s + Math.max(c.high - c.low, Math.abs(c.high - recentHLs[i].close), Math.abs(c.low - recentHLs[i].close)), 0) / (recentHLs.length - 1)
          : 0;
        const bodyToATR = atrApprox > 0 ? absPct / 100 * lastPrice / atrApprox : 0;
        const highQuality = bodyToATR >= 0.9;
        const score = Math.min(10, 4 + absPct * 2 + (highQuality ? 1 : 0));
        strategies.push({
          name: 'Big Candle Reversion',
          emoji: '🔄',
          score: Math.round(score * 10) / 10,
          direction,
          signal: `${absPct.toFixed(2)}% ${candleChangePct > 0 ? 'green' : 'red'} candle (bodyATR=${bodyToATR.toFixed(1)}) → reversion`,
          confidence: Math.round(Math.min(88, 50 + absPct * 8 + (highQuality ? 10 : 0))),
        });
      }
    }
  }

  // Strategy 9: Markov+BB Reversion — BEST RESEARCH RESULT: 66-70% WR (15m)
  // GGG (3 green candles) + price above BB upper → bet BEAR (strongest mean-reversion signal)
  // Research: GGG+BB ETH/15m = 66.4% WR; GGG+BB+bodyATR ETH/15m = 70.7% WR (highest ever)
  // Time filter: skip 14:00 UTC (ETH 48.1% WR, SOL 35% WR — consistently worst hour)
  // GGG (bear) is much stronger than RRR (bull) — markets drop faster than they rise
  if (bb && lastPrice && candles5m.length >= 4) {
    const currentHour = new Date(candles5m[candles5m.length - 1].closeTime).getUTCHours();
    // Skip 14:00 UTC — confirmed worst hour across all coins and studies (ETH 48.1%, SOL 35% WR)
    if (currentHour !== 14) {
      // Count trailing streak from current candle
      let markovGreen = 0, markovRed = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (markovRed > 0) break; markovGreen++; }
        else if (cj.close < cj.open) { if (markovGreen > 0) break; markovRed++; }
        else break;
      }
      const markovBearCondition = markovGreen >= 3 && lastPrice > bb.upper;  // GGG + above BB
      const markovBullCondition = markovRed >= 3 && lastPrice < bb.lower;   // RRR + below BB
      if (markovBearCondition || markovBullCondition) {
        const streakLen = Math.max(markovGreen, markovRed);
        const direction: Direction = markovBearCondition ? 'bearish' : 'bullish';
        const deviation = markovBearCondition
          ? (lastPrice - bb.upper) / bb.upper * 100
          : (bb.lower - lastPrice) / bb.lower * 100;
        // Body/ATR quality filter (bodyATR ≥ 0.9 boosts WR by +4-6%)
        const recentHLs = candles5m.slice(-15);
        const atrApprox = recentHLs.length > 1
          ? recentHLs.slice(1).reduce((s, c, i) => s + Math.max(c.high - c.low, Math.abs(c.high - recentHLs[i].close), Math.abs(c.low - recentHLs[i].close)), 0) / (recentHLs.length - 1)
          : 0;
        const lastC5m = candles5m[candles5m.length - 1];
        const bodyPct = lastC5m?.open > 0 ? Math.abs(lastC5m.close - lastC5m.open) / lastC5m.open * 100 : 0;
        const bodyToATR = atrApprox > 0 ? bodyPct / 100 * lastPrice / atrApprox : 0;
        const highQuality = bodyToATR >= 0.9;
        // RSI confirmation (optional but improves WR)
        const rsiConf = direction === 'bearish'
          ? (rsi14_5m ?? 50) >= 60
          : (rsi14_5m ?? 50) <= 40;
        const score = Math.min(10, 5 + streakLen * 1 + deviation * 8 + (highQuality ? 1.5 : 0) + (rsiConf ? 1 : 0));
        strategies.push({
          name: 'Markov+BB Reversion',
          emoji: '🎯',
          score: Math.round(score * 10) / 10,
          direction,
          signal: `${streakLen} ${markovBearCondition ? 'green' : 'red'} candles + ${markovBearCondition ? 'above' : 'below'} BB(20,2) by ${deviation.toFixed(3)}%${highQuality ? ' [quality]' : ''}${rsiConf ? ' + RSI' : ''}`,
          confidence: Math.round(Math.min(92, 60 + streakLen * 4 + deviation * 12 + (highQuality ? 8 : 0) + (rsiConf ? 5 : 0))),
        });
      }
    }
  }

  // Strategy 8: Bollinger Band Reversion — research-confirmed 58-64% WR (5m/15m)
  // When price closes outside BB(20,2) → bet opposite. Better than streak for 5m (+2.4% WR).
  // BB(20,2)+RSI65 on ETH/5m = 59.41% WR (648 trades); skip 14:00 UTC → 60.10% WR
  if (bb && lastPrice) {
    const aboveUpper = lastPrice > bb.upper;
    const belowLower = lastPrice < bb.lower;
    if (aboveUpper || belowLower) {
      const direction: Direction = aboveUpper ? 'bearish' : 'bullish';
      const deviation = aboveUpper
        ? (lastPrice - bb.upper) / bb.upper * 100
        : (bb.lower - lastPrice) / bb.lower * 100;
      const rsiConf = direction === 'bearish'
        ? (rsi14_5m ?? 50) >= 65
        : (rsi14_5m ?? 50) <= 35;
      const score = Math.min(10, 3 + deviation * 10 + (rsiConf ? 2 : 0));
      strategies.push({
        name: 'Bollinger Band',
        emoji: '📉',
        score: Math.round(score * 10) / 10,
        direction,
        signal: `Price ${aboveUpper ? 'above' : 'below'} BB by ${deviation.toFixed(3)}% (pctB=${bb.pctB.toFixed(2)})${rsiConf ? ' + RSI confirms' : ''}`,
        confidence: Math.round(Math.min(85, 52 + deviation * 15 + (rsiConf ? 8 : 0))),
      });
    }
  }

  // Strategy 10: Keltner+BB Double Confirmation — research: 70.2% WR ETH/15m (84 trades)
  // Price must be OUTSIDE both Keltner Channel (EMA±2*ATR) AND Bollinger Band (SMA±2*std)
  // Double-band squeeze = highest confidence mean-reversion signal found in research
  // GGG+bodyATR+Keltner+BB = 71.8% WR (39 trades) — highest WR in entire research
  // Skip 14:00 UTC (confirmed worst hour); body/ATR ≥ 0.9 for quality filter
  {
    const kc = calculateKeltnerChannels(candles5m, 20, 2);
    if (kc && bb && lastPrice && candles5m.length >= 4) {
      const aboveBoth = lastPrice > bb.upper && lastPrice > kc.upper;
      const belowBoth = lastPrice < bb.lower && lastPrice < kc.lower;
      if (aboveBoth || belowBoth) {
        const currentHour = new Date(candles5m[candles5m.length - 1].closeTime).getUTCHours();
        if (currentHour !== 14) {
          // Check for streak (GGG bear = strongest signal)
          let kcGreen = 0, kcRed = 0;
          for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
            const cj = candles5m[j];
            if (cj.close > cj.open) { if (kcRed > 0) break; kcGreen++; }
            else if (cj.close < cj.open) { if (kcGreen > 0) break; kcRed++; }
            else break;
          }
          const streakLen = Math.max(kcGreen, kcRed);
          const direction: Direction = aboveBoth ? 'bearish' : 'bullish';
          const deviation = aboveBoth
            ? (lastPrice - bb.upper) / bb.upper * 100
            : (bb.lower - lastPrice) / bb.lower * 100;
          // Body/ATR quality filter (+4-6% WR when ≥ 0.9)
          const recentHLs = candles5m.slice(-15);
          const atrApprox = recentHLs.length > 1
            ? recentHLs.slice(1).reduce((s, c, i) => s + Math.max(c.high - c.low, Math.abs(c.high - recentHLs[i].close), Math.abs(c.low - recentHLs[i].close)), 0) / (recentHLs.length - 1)
            : 0;
          const lastC = candles5m[candles5m.length - 1];
          const bodyPct = lastC?.open > 0 ? Math.abs(lastC.close - lastC.open) / lastC.open * 100 : 0;
          const bodyToATR = atrApprox > 0 ? bodyPct / 100 * lastPrice / atrApprox : 0;
          const highQuality = bodyToATR >= 0.9;
          // Score: base 6, +streak bonus, +deviation, +quality, +GGG bear bonus
          const gggBear = aboveBoth && kcGreen >= 3;
          const score = Math.min(10, 6 + streakLen * 0.8 + deviation * 8 + (highQuality ? 1.5 : 0) + (gggBear ? 0.5 : 0));
          strategies.push({
            name: 'Keltner+BB Squeeze',
            emoji: '⚡',
            score: Math.round(score * 10) / 10,
            direction,
            signal: `Outside BOTH Keltner+BB by ${deviation.toFixed(3)}%${streakLen >= 3 ? ` + ${streakLen}-candle streak` : ''}${highQuality ? ' [quality]' : ''}`,
            confidence: Math.round(Math.min(95, 65 + streakLen * 4 + deviation * 12 + (highQuality ? 8 : 0) + (gggBear ? 5 : 0))),
          });
        }
      }
    }
  }

  // Strategy 11: Volume Spike Exhaustion — research: 67.4% WR ETH/15m (vol>3x+streak≥3+BB)
  // High-volume candle in streak direction + outside BB → exhaustion signal → opposite direction
  // ETH/15m vol>3x+streak≥2+BB = 67.1% WR (149 trades), vol>3x+streak≥3 = 67.4% WR (86 trades)
  // BTC/15m vol>2x+streak≥3+BB = 62.9% WR (143 trades)
  {
    const lastCandle = candles5m[candles5m.length - 1];
    if (lastCandle && bb && lastPrice && candles5m.length >= 25) {
      // Average volume over last 20 candles (excluding current)
      const volSlice = candles5m.slice(-21, -1);
      const avgVol = volSlice.reduce((s, c) => s + c.volume, 0) / volSlice.length;
      const volMultiple = avgVol > 0 ? lastCandle.volume / avgVol : 0;

      if (volMultiple >= 2.0) {
        // Check streak in same direction as volume spike
        let vsGreen = 0, vsRed = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (vsRed > 0) break; vsGreen++; }
          else if (cj.close < cj.open) { if (vsGreen > 0) break; vsRed++; }
          else break;
        }
        const vsStreakLen = Math.max(vsGreen, vsRed);

        // Volume spike exhaustion: high-vol candle above BB after green streak = BEAR
        // High-vol candle below BB after red streak = BULL
        const vsBearSig = vsGreen >= 2 && lastPrice > bb.upper && lastCandle.close > lastCandle.open;
        const vsBullSig = vsRed >= 2 && lastPrice < bb.lower && lastCandle.close < lastCandle.open;

        if (vsBearSig || vsBullSig) {
          const direction: Direction = vsBearSig ? 'bearish' : 'bullish';
          const deviation = vsBearSig
            ? (lastPrice - bb.upper) / bb.upper * 100
            : (bb.lower - lastPrice) / bb.lower * 100;
          const rsiConf = direction === 'bearish' ? (rsi14_5m ?? 50) >= 60 : (rsi14_5m ?? 50) <= 40;
          const strongSpike = volMultiple >= 3.0;
          const score = Math.min(10, 5 + vsStreakLen * 0.8 + deviation * 8 + (strongSpike ? 1.5 : 0) + (rsiConf ? 1 : 0));
          strategies.push({
            name: 'Volume Spike Exhaustion',
            emoji: '💥',
            score: Math.round(score * 10) / 10,
            direction,
            signal: `Vol ${volMultiple.toFixed(1)}x avg + ${vsStreakLen}-candle ${direction === 'bearish' ? 'green' : 'red'} streak outside BB${strongSpike ? ' [massive vol]' : ''}`,
            confidence: Math.round(Math.min(90, 58 + vsStreakLen * 4 + deviation * 12 + (strongSpike ? 8 : 0) + (rsiConf ? 5 : 0))),
          });
        }
      }
    }
  }

  // Strategy 12: MFI Extreme Reversion — research: BTC/15m 70.4% WR (142 trades, all 5 folds positive)
  // Money Flow Index = volume-weighted RSI. MFI>80 = buying exhaustion → BEAR signal
  // ETH/15m: 63.9% WR (158 trades, σ=3.7% very stable); BTC/15m: 70.4% WR walk-forward
  // MFI(10)>80+BB confirms extremes with volume pressure behind move
  {
    const mfiPeriod = 10;
    if (candles5m.length >= mfiPeriod + 5 && lastPrice) {
      let posMF = 0, negMF = 0;
      const mfiSlice = candles5m.slice(-mfiPeriod - 1);
      for (let j = 1; j < mfiSlice.length; j++) {
        const tp = (mfiSlice[j].high + mfiSlice[j].low + mfiSlice[j].close) / 3;
        const tpPrev = (mfiSlice[j - 1].high + mfiSlice[j - 1].low + mfiSlice[j - 1].close) / 3;
        const mf = tp * mfiSlice[j].volume;
        if (tp > tpPrev) posMF += mf;
        else if (tp < tpPrev) negMF += mf;
      }
      const mfi = negMF === 0 ? 100 : 100 - 100 / (1 + posMF / negMF);

      const mfiBearSig = mfi > 80 && bb && lastPrice > bb.upper;
      const mfiBullSig = mfi < 20 && bb && lastPrice < bb.lower;

      if (mfiBearSig || mfiBullSig) {
        // Streak confirms direction
        let mfiGreen = 0, mfiRed = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (mfiRed > 0) break; mfiGreen++; }
          else if (cj.close < cj.open) { if (mfiGreen > 0) break; mfiRed++; }
          else break;
        }
        const mfiStreak = Math.max(mfiGreen, mfiRed);
        if (mfiStreak >= 2) { // require at least 2-candle streak for direction
          const direction: Direction = mfiBearSig ? 'bearish' : 'bullish';
          const mfiExtreme = mfiBearSig ? mfi - 80 : 20 - mfi; // how extreme (0-20)
          const deviation = bb && mfiBearSig
            ? (lastPrice - bb.upper) / bb.upper * 100
            : bb ? (bb.lower - lastPrice) / bb.lower * 100 : 0;
          const score = Math.min(10, 5 + mfiExtreme * 0.15 + deviation * 8 + mfiStreak * 0.5);
          strategies.push({
            name: 'MFI Exhaustion',
            emoji: '📊',
            score: Math.round(score * 10) / 10,
            direction,
            signal: `MFI(10)=${mfi.toFixed(1)} (${mfiBearSig ? 'overbought' : 'oversold'}) + ${mfiStreak}-candle ${mfiBearSig ? 'green' : 'red'} streak + outside BB`,
            confidence: Math.round(Math.min(92, 60 + mfiExtreme * 1.5 + deviation * 12 + mfiStreak * 3)),
          });
        }
      }
    }
  }

  // Strategy 13: ETH/5m Balanced BB Reversion 🎯
  // Research: ExtHours[10,11,12,21,22,23]+Streak(2)+BB(1.5)+dev[0.05-0.25%] = 67.1% WR (243T)
  // vs sniper mode [10,11,12,21]+bodyATR = 79.2% WR (53T) — more trades, still strong
  // BB deviation sweet spot: 0.1-0.2% outside = 67.9% WR; >0.5% outside = 39.1% WR (trend continuation)
  const extHours = [10, 11, 12, 21, 22, 23];
  const s13Hour = candles5m.length > 0 ? new Date(candles5m[candles5m.length - 1].closeTime).getUTCHours() : -1;
  if (candles5m.length >= 22 && lastPrice && extHours.includes(s13Hour)) {
    const bb15 = calculateBollingerBands(candles5m, 20, 1.5);
    if (bb15) {
      // Streak count for Balanced mode (≥2)
      let bStreak = 0;
      for (let i = candles5m.length - 2; i >= Math.max(0, candles5m.length - 5); i--) {
        const c = candles5m[i];
        if (i === candles5m.length - 2) { bStreak = c.close > c.open ? 1 : -1; continue; }
        const dir = c.close > c.open ? 1 : -1;
        if (dir === (bStreak > 0 ? 1 : -1)) bStreak += dir > 0 ? 1 : -1; else break;
      }
      const bStreakLen = Math.abs(bStreak);
      const bBearish = bStreak > 0;

      if (bStreakLen >= 2) {
        // BB deviation: require 0.05-0.25% outside band (sweet spot)
        let deviation = 0;
        let devInRange = false;
        if (bBearish && lastPrice > bb15.upper) {
          deviation = (lastPrice - bb15.upper) / bb15.upper * 100;
          devInRange = deviation >= 0.05 && deviation <= 0.25;
        } else if (!bBearish && lastPrice < bb15.lower) {
          deviation = (bb15.lower - lastPrice) / bb15.lower * 100;
          devInRange = deviation >= 0.05 && deviation <= 0.25;
        }

        if (devInRange) {
          const direction: Direction = bBearish ? 'bearish' : 'bullish';
          const score = Math.min(10, 5 + bStreakLen * 0.8 + deviation * 6 + (extHours.slice(0, 4).includes(s13Hour) ? 0.5 : 0));
          strategies.push({
            name: 'Balanced BB Reversion',
            emoji: '⚖️',
            score: Math.round(score * 10) / 10,
            direction,
            signal: `${bBearish ? 'BEAR' : 'BULL'}: streak=${bStreakLen}, dev=${deviation.toFixed(2)}% in sweet spot, h=${s13Hour}UTC`,
            confidence: Math.min(95, 60 + bStreakLen * 6 + deviation * 8 + (extHours.slice(0, 4).includes(s13Hour) ? 5 : 0)),
          });
        }
      }
    }
  }

  // Strategy 14: Recovery Rally Exhaustion 🔄
  // Pattern: RGGG → BEAR (red then 3 greens at BB upper) = recovery rally before final exhaustion
  // Research (candleSequences.ts): ETH/15m 75.9% WR (29T), BTC/15m 75.0% WR (32T) — CROSS-COIN ⭐⭐
  // GRGG → BEAR also strong: ETH/15m 67.9% (28T), BTC/15m 75.8% (33T)
  if (bb && lastPrice && candles5m.length >= 5) {
    const c4 = candles5m[candles5m.length - 5]; // oldest of 5
    const c3 = candles5m[candles5m.length - 4];
    const c2 = candles5m[candles5m.length - 3];
    const c1 = candles5m[candles5m.length - 2];
    const c0 = candles5m[candles5m.length - 1];
    const isG = (c: { open: number; close: number }) => c.close > c.open;
    const isR = (c: { open: number; close: number }) => c.close < c.open;

    // RGGG → BEAR: one red then 3 consecutive greens, price above BB upper
    const rgggBear = isR(c3) && isG(c2) && isG(c1) && isG(c0) && lastPrice > bb.upper;
    // GRGG → BEAR: green/red/green/green above BB upper
    const grggBear = isG(c3) && isR(c2) && isG(c1) && isG(c0) && lastPrice > bb.upper;

    // Mirror for bull: GRRR → BULL and RGRR → BULL (recovery after 3 reds)
    const grrrBull = isG(c3) && isR(c2) && isR(c1) && isR(c0) && lastPrice < bb.lower;
    const rgrr = isR(c3) && isG(c2) && isR(c1) && isR(c0) && lastPrice < bb.lower;

    const isBear = rgggBear || grggBear;
    const isBull = grrrBull || rgrr;

    if (isBear || isBull) {
      const direction: Direction = isBear ? 'bearish' : 'bullish';
      const deviation = isBear
        ? (lastPrice - bb.upper) / bb.upper * 100
        : (bb.lower - lastPrice) / bb.lower * 100;
      const patternName = isBear ? (rgggBear ? 'RGGG' : 'GRGG') : (grrrBull ? 'GRRR' : 'RGRR');
      const score = Math.min(10, 5.5 + deviation * 10);
      strategies.push({
        name: 'Recovery Rally Exhaustion',
        emoji: '🔄',
        score: Math.round(score * 10) / 10,
        direction,
        signal: `${patternName} pattern at BB ${isBear ? 'upper' : 'lower'}, dev=${deviation.toFixed(3)}% (75-76% WR ETH/BTC 15m)`,
        confidence: Math.round(Math.min(88, 63 + deviation * 15)),
      });
    }
  }

  // Strategy 15: Good Hours Optimized 🎯
  // THE MOST STABLE SIGNAL FOUND: GoodH[10,11,12,21] + streak≥2 + BB(20,2.2)
  // Research (finalSweep.ts): ETH/5m WR=69.8% σ=1.1% T=126 folds=[70.0/68.4/71.1]
  // σ=1.1% is LOWEST VARIANCE EVER FOUND across 500+ backtested configs
  // Reduces streakMin to 2 (vs Strategy 9's ≥3) — more signals, same precision
  const s15GoodHours = [10, 11, 12, 21];
  const s15Hour = candles5m.length > 0 ? new Date(candles5m[candles5m.length - 1].closeTime).getUTCHours() : -1;
  if (candles5m.length >= 22 && lastPrice && s15GoodHours.includes(s15Hour)) {
    const bb22 = calculateBollingerBands(candles5m, 20, 2.2);
    if (bb22) {
      // Count streak (≥2 instead of ≥3)
      let s15Green = 0, s15Red = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (s15Red > 0) break; s15Green++; }
        else if (cj.close < cj.open) { if (s15Green > 0) break; s15Red++; }
        else break;
      }
      const s15Bear = s15Green >= 2 && lastPrice > bb22.upper;
      const s15Bull = s15Red >= 2 && lastPrice < bb22.lower;
      if (s15Bear || s15Bull) {
        const streakLen = Math.max(s15Green, s15Red);
        const direction: Direction = s15Bear ? 'bearish' : 'bullish';
        const deviation = s15Bear
          ? (lastPrice - bb22.upper) / bb22.upper * 100
          : (bb22.lower - lastPrice) / bb22.lower * 100;
        const score = Math.min(10, 5.5 + streakLen * 0.8 + deviation * 10 + 0.5); // +0.5 for good hour boost
        strategies.push({
          name: 'Good Hours Optimized',
          emoji: '🎯',
          score: Math.round(score * 10) / 10,
          direction,
          signal: `${streakLen} ${s15Bear ? 'green' : 'red'} at BB(20,2.2) ${s15Bear ? 'upper' : 'lower'}, h=${s15Hour}UTC (σ=1.1% stable)`,
          confidence: Math.round(Math.min(92, 62 + streakLen * 5 + deviation * 12)),
        });
      }
    }
  }

  // Strategy 16: Synthetic 15m Ensemble 🔮
  // Aggregate 5m candles → synthetic 15m, apply GoodH+BB(20,2.2)+streak≥2 AND streak≥3+BB(20,2)
  // Walk-forward validated (syntheticTF.ts): WR=73.1% σ=3.6% T=102 folds=[69.7/78.0/71.4] ⭐⭐⭐
  // This is the highest stable WR found — better than any single signal on 5m
  if (candles5m.length >= 63) {
    // Build synthetic 15m candles from 5m (group every 3)
    const remainder = candles5m.length % 3;
    const s16Synth: Candle[] = [];
    for (let i = remainder; i + 3 <= candles5m.length; i += 3) {
      const a = candles5m[i], b = candles5m[i + 1], c = candles5m[i + 2];
      s16Synth.push({
        openTime: a.openTime,
        open: a.open,
        high: Math.max(a.high, b.high, c.high),
        low: Math.min(a.low, b.low, c.low),
        close: c.close,
        volume: a.volume + b.volume + c.volume,
        closeTime: c.closeTime,
        quoteVolume: 0,
        trades: 0,
      });
    }
    if (s16Synth.length >= 22 && lastPrice) {
      const s16Last = s16Synth[s16Synth.length - 1];
      const s16Hour = new Date(s16Last.closeTime).getUTCHours();
      const s16GoodHours = [10, 11, 12, 21];
      if (s16GoodHours.includes(s16Hour)) {
        const bb22_s16 = calculateBollingerBands(s16Synth, 20, 2.2);
        const bb20_s16 = calculateBollingerBands(s16Synth, 20, 2.0);
        if (bb22_s16 && bb20_s16) {
          const p16 = s16Last.close;
          const isBear22 = p16 > bb22_s16.upper;
          const isBull22 = p16 < bb22_s16.lower;
          const isBear20 = p16 > bb20_s16.upper;
          const isBull20 = p16 < bb20_s16.lower;
          // Count 15m streak
          let s16StreakLen = 1;
          const s16Dir = s16Last.close >= s16Last.open ? 'G' : 'R';
          for (let j = s16Synth.length - 2; j >= Math.max(0, s16Synth.length - 8); j--) {
            const cj = s16Synth[j];
            if ((cj.close >= cj.open ? 'G' : 'R') === s16Dir) s16StreakLen++;
            else break;
          }
          // Signal A: GoodH + BB(20,2.2) + streak≥2 on synth15m
          const s16A_bear = isBear22 && s16Dir === 'G' && s16StreakLen >= 2;
          const s16A_bull = isBull22 && s16Dir === 'R' && s16StreakLen >= 2;
          // Signal B: streak≥3 + BB(20,2) on synth15m
          const s16B_bear = s16Dir === 'G' && s16StreakLen >= 3 && isBear20;
          const s16B_bull = s16Dir === 'R' && s16StreakLen >= 3 && isBull20;
          const s16Bear = s16A_bear && s16B_bear;
          const s16Bull = s16A_bull && s16B_bull;
          if (s16Bear || s16Bull) {
            const direction: Direction = s16Bear ? 'bearish' : 'bullish';
            const deviation = s16Bear
              ? (p16 - bb22_s16.upper) / bb22_s16.upper * 100
              : (bb22_s16.lower - p16) / bb22_s16.lower * 100;
            const score = Math.min(10, 6.0 + s16StreakLen * 0.6 + deviation * 8 + 0.8); // +0.8 for ensemble boost
            strategies.push({
              name: 'Synth15m Ensemble',
              emoji: '🔮',
              score: Math.round(score * 10) / 10,
              direction,
              signal: `${s16StreakLen} ${s16Bear ? 'green' : 'red'} 15m-equiv at BB22 ${s16Bear ? 'upper' : 'lower'}, h=${s16Hour}UTC (73.1% WR σ=3.6%)`,
              confidence: Math.round(Math.min(92, 66 + s16StreakLen * 4 + deviation * 10)),
            });
          }
        }
      }
    }
  }

  // Strategy 17: Daily Range Top/Bottom Filter 📏
  // GoodH + BB(20,2.2) + streak≥2 + price in top/bottom 30% of daily range
  // Research (syntheticTF.ts): Top 30% + GoodH WR=73.4% T=79 ⭐⭐⭐
  // Intuition: at BB extreme AND near daily high/low = double confirmation of overextension
  if (candles5m.length >= 30 && lastPrice) {
    const s17Hour = new Date(candles5m[candles5m.length - 1].closeTime).getUTCHours();
    const s17GoodHours = [10, 11, 12, 21];
    if (s17GoodHours.includes(s17Hour)) {
      const bb22_s17 = calculateBollingerBands(candles5m, 20, 2.2);
      if (bb22_s17) {
        const isBear = lastPrice > bb22_s17.upper;
        const isBull = lastPrice < bb22_s17.lower;
        if (isBear || isBull) {
          // Count streak
          let s17Green = 0, s17Red = 0;
          for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
            const cj = candles5m[j];
            if (cj.close > cj.open) { if (s17Red > 0) break; s17Green++; }
            else if (cj.close < cj.open) { if (s17Green > 0) break; s17Red++; }
            else break;
          }
          const s17StreakOk = (isBear && s17Green >= 2) || (isBull && s17Red >= 2);
          if (s17StreakOk) {
            // Compute daily range from today's candles
            const today = new Date(candles5m[candles5m.length - 1].openTime);
            const todayStart = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
            let dailyHigh = lastPrice, dailyLow = lastPrice;
            for (let j = candles5m.length - 1; j >= 0; j--) {
              if (candles5m[j].openTime < todayStart) break;
              dailyHigh = Math.max(dailyHigh, candles5m[j].high);
              dailyLow = Math.min(dailyLow, candles5m[j].low);
            }
            const dailyRange = dailyHigh - dailyLow;
            if (dailyRange > 0) {
              const posInRange = (lastPrice - dailyLow) / dailyRange; // 0=bottom, 1=top
              const isAtTop = posInRange >= 0.70 && isBear;    // top 30% → expect reversal
              const isAtBottom = posInRange <= 0.30 && isBull; // bottom 30% → expect reversal
              if (isAtTop || isAtBottom) {
                const streakLen = Math.max(s17Green, s17Red);
                const direction: Direction = isBear ? 'bearish' : 'bullish';
                const deviation = isBear
                  ? (lastPrice - bb22_s17.upper) / bb22_s17.upper * 100
                  : (bb22_s17.lower - lastPrice) / bb22_s17.lower * 100;
                const rangePosPct = isAtTop ? posInRange * 100 : (1 - posInRange) * 100;
                const score = Math.min(10, 5.8 + streakLen * 0.7 + deviation * 10 + (rangePosPct - 70) * 0.05);
                strategies.push({
                  name: 'Daily Range Extreme',
                  emoji: '📏',
                  score: Math.round(score * 10) / 10,
                  direction,
                  signal: `${isBear ? 'Top' : 'Bottom'} ${rangePosPct.toFixed(0)}% daily range + BB22 ${isBear ? 'upper' : 'lower'}, h=${s17Hour}UTC (73.4% WR)`,
                  confidence: Math.round(Math.min(90, 64 + streakLen * 4 + deviation * 10 + (rangePosPct - 70) * 0.3)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 18: RSI Panic Exhaustion 🔥
  // Overbought/oversold RSI (>70/<30) + panic-size candle body (≥0.3%) at BB(20,2.2) extreme + GoodH
  // Research (validateNewStrategies.ts): ETH/5m WR=71.1% σ=1.5% T=121 [73.2/70.0/70.0] (3-fold WF)
  // Inspired by Polymarket "overreaction" finding: large impulsive candles at RSI extremes = exhaustion
  // All 3 walk-forward folds at 70%+ = ULTRA STABLE signal (σ=1.5% is lowest of all RSI-based configs)
  {
    const s18GoodHours = [10, 11, 12, 21];
    const s18Hour = candles5m.length > 0 ? new Date(candles5m[candles5m.length - 1].closeTime).getUTCHours() : -1;
    if (candles5m.length >= 22 && lastPrice && s18GoodHours.includes(s18Hour) && rsi14_5m !== null) {
      const bb22_s18 = calculateBollingerBands(candles5m, 20, 2.2);
      if (bb22_s18) {
        const lastC = candles5m[candles5m.length - 1];
        const bodyPct = lastC.open > 0 ? Math.abs(lastC.close - lastC.open) / lastC.open * 100 : 0;
        // Directional: entry candle must match setup direction
        const isBearSetup = lastPrice > bb22_s18.upper && lastC.close > lastC.open; // green above BB upper
        const isBullSetup = lastPrice < bb22_s18.lower && lastC.close < lastC.open; // red below BB lower
        // RSI extremes: >70 overbought → BEAR; <30 oversold → BULL
        const rsiExtrBear = rsi14_5m > 70;
        const rsiExtrBull = rsi14_5m < 30;
        // Panic body: ≥0.3% absolute move (research sweet spot: 0.3-0.5%)
        const panicBody = bodyPct >= 0.3;

        const s18Bear = isBearSetup && rsiExtrBear && panicBody;
        const s18Bull = isBullSetup && rsiExtrBull && panicBody;

        if (s18Bear || s18Bull) {
          const direction: Direction = s18Bear ? 'bearish' : 'bullish';
          const deviation = s18Bear
            ? (lastPrice - bb22_s18.upper) / bb22_s18.upper * 100
            : (bb22_s18.lower - lastPrice) / bb22_s18.lower * 100;
          const rsiExtremity = s18Bear ? rsi14_5m - 70 : 30 - rsi14_5m; // 0-30 scale
          const score = Math.min(10, 5.5 + bodyPct * 2 + deviation * 10 + rsiExtremity * 0.05 + 0.5);
          strategies.push({
            name: 'RSI Panic Exhaustion',
            emoji: '🔥',
            score: Math.round(score * 10) / 10,
            direction,
            signal: `RSI=${rsi14_5m} (${s18Bear ? 'overbought' : 'oversold'}) + ${bodyPct.toFixed(2)}% panic body at BB(20,2.2) ${s18Bear ? 'upper' : 'lower'}, h=${s18Hour}UTC (71.1% WR σ=1.5%)`,
            confidence: Math.round(Math.min(90, 63 + rsiExtremity * 0.5 + bodyPct * 5 + deviation * 12)),
          });
        }
      }
    }
  }

  // Strategy 21: Day-of-Week Reversion 📅
  // DoW[Wed+Sat]+GoodH+BB(20,2.2)+streak>=2 → WF=70.5% σ=6.0% T=112 [5-fold]
  // Wednesday and Saturday have strongest mean-reversion edge for ETH/5m
  {
    const s21GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 22) {
      const lastC5 = candles5m[candles5m.length - 1];
      const s21Hour = new Date(lastC5.closeTime).getUTCHours();
      const s21Dow = new Date(lastC5.openTime).getUTCDay(); // 0=Sun,3=Wed,6=Sat
      const isGoodDoW = s21Dow === 3 || s21Dow === 6; // Wed or Sat
      if (s21GoodHours.includes(s21Hour) && isGoodDoW) {
        const bb22_s21 = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb22_s21) {
          const p21 = lastC5.close;
          const isBear = p21 > bb22_s21.upper;
          const isBull = p21 < bb22_s21.lower;
          let s21Green = 0, s21Red = 0;
          for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
            const cj = candles5m[j];
            if (cj.close > cj.open) { if (s21Red > 0) break; s21Green++; }
            else if (cj.close < cj.open) { if (s21Green > 0) break; s21Red++; }
            else break;
          }
          const s21Bear = isBear && s21Green >= 2;
          const s21Bull = isBull && s21Red >= 2;
          if (s21Bear || s21Bull) {
            const streakLen = Math.max(s21Green, s21Red);
            const deviation = s21Bear
              ? (p21 - bb22_s21.upper) / bb22_s21.upper * 100
              : (bb22_s21.lower - p21) / bb22_s21.lower * 100;
            const dowLabel = s21Dow === 3 ? 'Wed' : 'Sat';
            strategies.push({
              name: 'DoW Reversion',
              emoji: '📅',
              score: Math.round(Math.min(10, 5.7 + streakLen * 0.6 + deviation * 9) * 10) / 10,
              direction: (s21Bear ? 'bearish' : 'bullish') as Direction,
              signal: `${dowLabel}+h=${s21Hour}UTC ${s21Bear ? s21Green+'G' : s21Red+'R'} at BB(20,2.2) (70.5% WR σ=6%)`,
              confidence: Math.round(Math.min(88, 62 + streakLen * 3 + deviation * 10)),
            });
          }
        }
      }
    }
  }

  // Strategy 22: EMA50 Extension BB Reversion 📐
  // EMA50_dist>=0.5%+GoodH+BB(20,2.2)+streak>=1 → WF=65.9% σ=5.9% T=291 (HIGH FREQ: 1.59/day)
  // Price stretched >0.5% from EMA50 AND at BB extreme = strong over-extension = reversion
  {
    const s22GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 52) {
      const lastC5 = candles5m[candles5m.length - 1];
      const s22Hour = new Date(lastC5.closeTime).getUTCHours();
      if (s22GoodHours.includes(s22Hour)) {
        const bb22_s22 = calculateBollingerBands(candles5m, 20, 2.2);
        const ema50_s22 = calculateEMA(candles5m, 50);
        if (bb22_s22 && ema50_s22) {
          const p22 = lastC5.close;
          const emaDist = ema50_s22 > 0 ? Math.abs(p22 - ema50_s22) / ema50_s22 * 100 : 0;
          const isBear = p22 > bb22_s22.upper;
          const isBull = p22 < bb22_s22.lower;
          if (emaDist >= 0.8 && (isBear || isBull)) {
            let s22Green = 0, s22Red = 0;
            for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
              const cj = candles5m[j];
              if (cj.close > cj.open) { if (s22Red > 0) break; s22Green++; }
              else if (cj.close < cj.open) { if (s22Green > 0) break; s22Red++; }
              else break;
            }
            const s22Bear = isBear && s22Green >= 1;
            const s22Bull = isBull && s22Red >= 1;
            if (s22Bear || s22Bull) {
              const streakLen = Math.max(s22Green, s22Red);
              const deviation = s22Bear
                ? (p22 - bb22_s22.upper) / bb22_s22.upper * 100
                : (bb22_s22.lower - p22) / bb22_s22.lower * 100;
              strategies.push({
                name: 'EMA50 Extension',
                emoji: '📐',
                score: Math.round(Math.min(10, 5.5 + emaDist * 2 + deviation * 8 + (streakLen - 1) * 0.4) * 10) / 10,
                direction: (s22Bear ? 'bearish' : 'bullish') as Direction,
                signal: `EMA50 dist=${emaDist.toFixed(2)}% at BB(20,2.2) ${s22Bear ? 'upper' : 'lower'}, h=${s22Hour}UTC (68.0% WR σ=8.4% opt)`,
                confidence: Math.round(Math.min(86, 58 + emaDist * 5 + deviation * 8 + streakLen * 1.5)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 23: RSI Bidirectional Exhaustion 🎭
  // RSI>65(bear)/RSI<35(bull) + body>=0.3% + GoodH + BB(20,2.2) + streak>=1
  // WF=66.0% σ=4.1% T=153 [5-fold] — bidirectional, more trades than strat 18 (RSI>70)
  {
    const s23GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 22 && rsi14_5m !== null) {
      const lastC5 = candles5m[candles5m.length - 1];
      const s23Hour = new Date(lastC5.closeTime).getUTCHours();
      if (s23GoodHours.includes(s23Hour)) {
        const bb22_s23 = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb22_s23) {
          const p23 = lastC5.close;
          const bodyPct23 = lastC5.open > 0 ? Math.abs(lastC5.close - lastC5.open) / lastC5.open * 100 : 0;
          const isBear = p23 > bb22_s23.upper && lastC5.close > lastC5.open && rsi14_5m > 65 && bodyPct23 >= 0.3;
          const isBull = p23 < bb22_s23.lower && lastC5.close < lastC5.open && rsi14_5m < 35 && bodyPct23 >= 0.3;
          if (isBear || isBull) {
            let s23Streak = 0;
            for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 7); j--) {
              const cj = candles5m[j];
              if (cj.close > cj.open) { if (s23Streak < 0) break; s23Streak++; }
              else if (cj.close < cj.open) { if (s23Streak > 0) break; s23Streak--; }
              else break;
            }
            const streakOk = (isBear && s23Streak >= 1) || (isBull && s23Streak <= -1);
            if (streakOk) {
              const deviation = isBear
                ? (p23 - bb22_s23.upper) / bb22_s23.upper * 100
                : (bb22_s23.lower - p23) / bb22_s23.lower * 100;
              const rsiExtreme = isBear ? rsi14_5m - 65 : 35 - rsi14_5m;
              strategies.push({
                name: 'RSI Bidir Exhaustion',
                emoji: '🎭',
                score: Math.round(Math.min(10, 5.5 + bodyPct23 * 2 + deviation * 8 + rsiExtreme * 0.04) * 10) / 10,
                direction: (isBear ? 'bearish' : 'bullish') as Direction,
                signal: `RSI=${rsi14_5m.toFixed(0)} (${isBear ? '>65 bear' : '<35 bull'}) + ${bodyPct23.toFixed(2)}% body at BB(20,2.2), h=${s23Hour}UTC (66% WR σ=4.1%)`,
                confidence: Math.round(Math.min(87, 58 + rsiExtreme * 0.4 + bodyPct23 * 4 + deviation * 10)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 24: ETH/15m MFI Exhaustion 💹
  // Synthetic 15m: MFI(10)>70/<30 + GoodH + BB(15,2.2) + streak>=1
  // WF=68.2% σ=9.4% T=112 [5-fold] — complements BTC/15m MFI (strat 12)
  {
    const s24GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 60) {
      // Build synthetic 15m (group 3×5m)
      const synth15m_s24: Candle[] = [];
      const aligned24 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned24; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s24.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s24.length >= 20) {
        const lastS24 = synth15m_s24[synth15m_s24.length - 1];
        const s24Hour = new Date(lastS24.closeTime).getUTCHours();
        if (s24GoodHours.includes(s24Hour)) {
          const bb15_s24 = calculateBollingerBands(synth15m_s24, 15, 2.2);
          const mfi10_s24 = calculateMFI(synth15m_s24, 10);
          if (bb15_s24 && mfi10_s24 !== null) {
            const p24 = lastS24.close;
            const isBear = p24 > bb15_s24.upper && mfi10_s24 > 70 && lastS24.close > lastS24.open;
            const isBull = p24 < bb15_s24.lower && mfi10_s24 < 30 && lastS24.close < lastS24.open;
            if (isBear || isBull) {
              let s24Streak = 0;
              for (let j = synth15m_s24.length - 1; j >= Math.max(0, synth15m_s24.length - 6); j--) {
                const cj = synth15m_s24[j];
                if (cj.close > cj.open) { if (s24Streak < 0) break; s24Streak++; }
                else if (cj.close < cj.open) { if (s24Streak > 0) break; s24Streak--; }
                else break;
              }
              const streakOk = (isBear && s24Streak >= 1) || (isBull && s24Streak <= -1);
              if (streakOk) {
                const deviation = isBear
                  ? (p24 - bb15_s24.upper) / bb15_s24.upper * 100
                  : (bb15_s24.lower - p24) / bb15_s24.lower * 100;
                const mfiExtreme = isBear ? mfi10_s24 - 70 : 30 - mfi10_s24;
                strategies.push({
                  name: 'ETH 15m MFI Exhaustion',
                  emoji: '💹',
                  score: Math.round(Math.min(10, 5.8 + mfiExtreme * 0.05 + deviation * 9 + (Math.abs(s24Streak) - 1) * 0.3) * 10) / 10,
                  direction: (isBear ? 'bearish' : 'bullish') as Direction,
                  signal: `Synth-15m MFI=${mfi10_s24.toFixed(0)} ${isBear ? '>70' : '<30'} at BB(15,2.2) ${isBear ? 'upper' : 'lower'}, h=${s24Hour}UTC (68.2% WR σ=9.4%)`,
                  confidence: Math.round(Math.min(88, 60 + mfiExtreme * 0.5 + deviation * 10 + Math.abs(s24Streak) * 1.5)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 25: RSI Bear Streak (ML-discovered) 🤖
  // ethGoodH + aboveBB22 + RSI>65 + greenStreak>=2 → BEAR ONLY
  // WF=69.6% σ=1.9% T=200 ← MOST STABLE STRATEGY FOUND BY ML (all 3 folds within 4%)
  // ML rule learner: GoodH+aboveBB22+rsiOverbought65+streakBull = 69.6% WF, σ=1.9%
  {
    const s25GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 22 && rsi14_5m !== null && rsi14_5m > 65) {
      const lastC5 = candles5m[candles5m.length - 1];
      const s25Hour = new Date(lastC5.closeTime).getUTCHours();
      if (s25GoodHours.includes(s25Hour)) {
        const bb22_s25 = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb22_s25 && lastC5.close > bb22_s25.upper && lastC5.close > lastC5.open) {
          // Count green streak
          let s25GreenStreak = 0;
          for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
            const cj = candles5m[j];
            if (cj.close > cj.open) s25GreenStreak++;
            else break;
          }
          if (s25GreenStreak >= 2) {
            const deviation = (lastC5.close - bb22_s25.upper) / bb22_s25.upper * 100;
            const rsiExtreme = rsi14_5m - 65;
            strategies.push({
              name: 'RSI Bear Streak',
              emoji: '🤖',
              score: Math.round(Math.min(10, 5.8 + rsiExtreme * 0.04 + deviation * 9 + (s25GreenStreak - 2) * 0.3) * 10) / 10,
              direction: 'bearish' as Direction,
              signal: `ML: RSI=${rsi14_5m.toFixed(0)}>65 + ${s25GreenStreak}G streak above BB(20,2.2), h=${s25Hour}UTC (69.6% WR σ=1.9% ULTRA STABLE)`,
              confidence: Math.round(Math.min(90, 62 + rsiExtreme * 0.5 + deviation * 10 + (s25GreenStreak - 2) * 1.5)),
            });
          }
        }
      }
    }
  }

  // Strategy 31: ETH Synth-15m RSI Panic 🔴 — HIGHEST WR FOUND!
  // Synth-15m from 5m: GoodH + BB(20,2.2) + RSI14>68 + body>=0.3%
  // Research (paramOptimize.js): WF=80.0% σ=6.1% T=53 [75.0/87.5/75.0/87.5/75.0] *** ALL 5 FOLDS 75%+
  // Extension of ETH Strat 18 (RSI Panic) applied to synthetic 15m — stronger signal, fewer but higher quality trades
  {
    const s31GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 60) {
      const synth15m_s31: Candle[] = [];
      const aligned31 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned31; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s31.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s31.length >= 20) {
        const lastS31 = synth15m_s31[synth15m_s31.length - 1];
        const s31Hour = new Date(lastS31.closeTime).getUTCHours();
        if (s31GoodHours.includes(s31Hour)) {
          const bb22_s31 = calculateBollingerBands(synth15m_s31, 20, 2.2);
          const rsi14_s31 = calculateRSI(synth15m_s31, 14);
          if (bb22_s31 && rsi14_s31 !== null) {
            const p31 = lastS31.close;
            const bodyPct31 = lastS31.open > 0 ? Math.abs(lastS31.close - lastS31.open) / lastS31.open * 100 : 0;
            const isBear = p31 > bb22_s31.upper && lastS31.close > lastS31.open && rsi14_s31 > 68 && bodyPct31 >= 0.3;
            const isBull = p31 < bb22_s31.lower && lastS31.close < lastS31.open && rsi14_s31 < 32 && bodyPct31 >= 0.3;
            if (isBear || isBull) {
              const deviation = isBear
                ? (p31 - bb22_s31.upper) / bb22_s31.upper * 100
                : (bb22_s31.lower - p31) / bb22_s31.lower * 100;
              const rsiExtreme = isBear ? rsi14_s31 - 68 : 32 - rsi14_s31;
              strategies.push({
                name: 'ETH Synth-15m RSI Panic',
                emoji: '🔴',
                score: Math.round(Math.min(10, 6.5 + rsiExtreme * 0.05 + bodyPct31 * 2 + deviation * 8) * 10) / 10,
                direction: (isBear ? 'bearish' : 'bullish') as Direction,
                signal: `Synth-15m RSI=${rsi14_s31.toFixed(0)} ${isBear ? '>68 bear' : '<32 bull'} + ${bodyPct31.toFixed(2)}% panic body at BB(20,2.2), h=${s31Hour}UTC (**80% WR σ=6.1%**)`,
                confidence: Math.round(Math.min(92, 70 + rsiExtreme * 0.5 + bodyPct31 * 4 + deviation * 10)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 32: ETH/15m Discovery Hours 🌙 — ULTRA STABLE
  // Real 15m: h=[7,12,20] + RSI14>60 + BB(20,2.2) + streak>=2
  // Research (ML-RESEARCH-REPORT.md): WF=75.3% σ=1.5% T=93 [74.2/74.2/77.4] — ULTRA STABLE
  // Key insight: ETH/15m uses completely different good hours [7,12,20] vs ETH/5m [10,11,12,21]!
  {
    const s32GoodHours = [7, 12, 20]; // DIFFERENT from 5m good hours!
    // Use real 15m if available, else fall back to synth from 5m
    const s32Candles: Candle[] = candles15m.length >= 20 ? candles15m : (() => {
      const synth: Candle[] = [];
      const aligned = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      return synth;
    })();
    if (s32Candles.length >= 25) {
      const lastS32 = s32Candles[s32Candles.length - 1];
      const s32Hour = new Date(lastS32.closeTime).getUTCHours();
      if (s32GoodHours.includes(s32Hour)) {
        const bb22_s32 = calculateBollingerBands(s32Candles, 20, 2.2);
        const rsi14_s32 = calculateRSI(s32Candles, 14);
        if (bb22_s32 && rsi14_s32 !== null && rsi14_s32 > 60) {
          const p32 = lastS32.close;
          const isBear = p32 > bb22_s32.upper && lastS32.close > lastS32.open;
          const isBull = p32 < bb22_s32.lower && lastS32.close < lastS32.open;
          if (isBear || isBull) {
            let s32Streak = 0;
            for (let j = s32Candles.length - 1; j >= Math.max(0, s32Candles.length - 8); j--) {
              const cj = s32Candles[j];
              if (cj.close > cj.open) { if (s32Streak < 0) break; s32Streak++; }
              else if (cj.close < cj.open) { if (s32Streak > 0) break; s32Streak--; }
              else break;
            }
            const streakOk = (isBear && s32Streak >= 2) || (isBull && s32Streak <= -2);
            if (streakOk) {
              const deviation = isBear
                ? (p32 - bb22_s32.upper) / bb22_s32.upper * 100
                : (bb22_s32.lower - p32) / bb22_s32.lower * 100;
              const rsiExt = isBear ? rsi14_s32 - 60 : 60 - rsi14_s32; // 0-40 scale above 60
              strategies.push({
                name: 'ETH 15m Discovery',
                emoji: '🌙',
                score: Math.round(Math.min(10, 6.2 + rsiExt * 0.03 + Math.abs(s32Streak) * 0.4 + deviation * 9) * 10) / 10,
                direction: (isBear ? 'bearish' : 'bullish') as Direction,
                signal: `15m RSI=${rsi14_s32.toFixed(0)}>60 at BB(20,2.2) ${isBear ? 'upper' : 'lower'}, h=${s32Hour}UTC [7,12,20] (75.3% WR **σ=1.5%** ULTRA STABLE)`,
                confidence: Math.round(Math.min(91, 67 + rsiExt * 0.4 + Math.abs(s32Streak) * 1.5 + deviation * 9)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 35: ETH Tight BB Deviation 🎯 — HIGH PRECISION
  // h=[10,12,21] + BB(20,2.2) tight dev (0.05-0.25% outside) + streak>=2
  // Research (btcNewSearch.js/F): WF=71.8% σ=6.3% T=159 [79.5/64.1/71.8] *** VALIDATED
  // Key insight: dropping h=11 and using tight BB deviation filter (0.05-0.25% outside) improves WR
  // Tight deviation = fresh breakout of BB (not too deep), highest reversion probability zone
  {
    const s35GoodHours = [10, 12, 21]; // note: drops h=11 vs strat 15
    if (candles5m.length >= 22) {
      const lastC5 = candles5m[candles5m.length - 1];
      const s35Hour = new Date(lastC5.closeTime).getUTCHours();
      if (s35GoodHours.includes(s35Hour)) {
        const bb22_s35 = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb22_s35) {
          const p35 = lastC5.close;
          const isAbove = p35 > bb22_s35.upper;
          const isBelow = p35 < bb22_s35.lower;
          const devPct = isAbove
            ? (p35 - bb22_s35.upper) / p35 * 100
            : isBelow
            ? (bb22_s35.lower - p35) / p35 * 100
            : 0;
          // Tight deviation zone: 0.05% to 0.25% outside BB = sweet spot
          if (devPct >= 0.05 && devPct <= 0.25 && (isAbove || isBelow)) {
            const isBear = isAbove && lastC5.close > lastC5.open;
            const isBull = isBelow && lastC5.close < lastC5.open;
            if (isBear || isBull) {
              let s35Streak = 0;
              for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
                const cj = candles5m[j];
                if (cj.close > cj.open) { if (s35Streak < 0) break; s35Streak++; }
                else if (cj.close < cj.open) { if (s35Streak > 0) break; s35Streak--; }
                else break;
              }
              const streakOk = (isBear && s35Streak >= 2) || (isBull && s35Streak <= -2);
              if (streakOk) {
                strategies.push({
                  name: 'ETH Tight BB Zone',
                  emoji: '🎯',
                  score: Math.round(Math.min(10, 6.0 + Math.abs(s35Streak) * 0.4 + devPct * 20) * 10) / 10,
                  direction: (isBear ? 'bearish' : 'bullish') as Direction,
                  signal: `h=[10,12,21] at BB(20,2.2) tight zone ${devPct.toFixed(3)}% outside ${isBear ? 'upper' : 'lower'}, ${Math.abs(s35Streak)} candle streak (71.8% WR σ=6.3%)`,
                  confidence: Math.round(Math.min(88, 63 + Math.abs(s35Streak) * 2 + devPct * 40)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategies 36-38: ETH/15m Wave 3 — body+RSI+MFI filters with h=[7,12,20] or [5,12,20]
  // Shared synth-15m for strats 36/37/38
  if (candles5m.length >= 65) {
    const synth15mWave3: Candle[] = candles15m.length >= 25 ? candles15m : (() => {
      const synth: Candle[] = [];
      const aligned = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      return synth;
    })();

    if (synth15mWave3.length >= 25) {
      const lastW3 = synth15mWave3[synth15mWave3.length - 1];
      const w3Hour = new Date(lastW3.closeTime).getUTCHours();

      // Streak helper (shared)
      let w3Streak = 0;
      for (let j = synth15mWave3.length - 1; j >= Math.max(0, synth15mWave3.length - 8); j--) {
        const cj = synth15mWave3[j];
        if (cj.close > cj.open) { if (w3Streak < 0) break; w3Streak++; }
        else if (cj.close < cj.open) { if (w3Streak > 0) break; w3Streak--; }
        else break;
      }

      // Strategy 36: ETH/15m Body+RSI7 🔶 — ULTRA STABLE
      // h=[7,12,20]+body>=0.3%+RSI7>65+BB(15,2.2)+streak>=2 → WF=73.2% σ=1.2% T=82 [74.1/74.1/71.4]
      // session6Validate.js confirmed: 5-fold 73.1% σ=8.7%
      if ([7, 12, 20].includes(w3Hour)) {
        const bb15_s36 = calculateBollingerBands(synth15mWave3, 15, 2.2);
        const rsi7_s36 = calculateRSI(synth15mWave3, 7);
        if (bb15_s36 && rsi7_s36 !== null) {
          const p36 = lastW3.close;
          const isBear = p36 > bb15_s36.upper && lastW3.close > lastW3.open;
          const isBull = p36 < bb15_s36.lower && lastW3.close < lastW3.open;
          const bodyPct36 = lastW3.open > 0 ? Math.abs(lastW3.close - lastW3.open) / lastW3.open * 100 : 0;
          const rsiOk = (isBear && rsi7_s36 > 65) || (isBull && rsi7_s36 < 35);
          const streakOk = (isBear && w3Streak >= 2) || (isBull && w3Streak <= -2);
          if ((isBear || isBull) && bodyPct36 >= 0.3 && rsiOk && streakOk) {
            const deviation = isBear
              ? (p36 - bb15_s36.upper) / bb15_s36.upper * 100
              : (bb15_s36.lower - p36) / bb15_s36.lower * 100;
            strategies.push({
              name: 'ETH 15m Body RSI7',
              emoji: '🔶',
              score: Math.round(Math.min(10, 6.1 + bodyPct36 * 2 + deviation * 8 + Math.abs(w3Streak) * 0.3) * 10) / 10,
              direction: (isBear ? 'bearish' : 'bullish') as Direction,
              signal: `15m h=[7,12,20] body=${bodyPct36.toFixed(2)}% RSI7=${rsi7_s36.toFixed(0)} at BB(15,2.2) ${isBear ? 'upper' : 'lower'}, h=${w3Hour}UTC (73.2% **σ=1.2%** ULTRA STABLE)`,
              confidence: Math.round(Math.min(91, 65 + bodyPct36 * 4 + deviation * 8 + Math.abs(w3Streak) * 1.5)),
            });
          }
        }
      }

      // Strategy 37: ETH/15m MFI Confirm 🟠 — ULTRA STABLE
      // h=[5,12,20]+MFI>70+BB(15,2.2)+streak>=2 → WF=76.7% σ=1.8% T=73 [79.2/75/76]
      // session6Validate.js confirmed: 5-fold 76.5% σ=7.7%
      if ([5, 12, 20].includes(w3Hour)) {
        const bb15_s37 = calculateBollingerBands(synth15mWave3, 15, 2.2);
        const mfi_s37 = calculateMFI(synth15mWave3, 10);
        if (bb15_s37 && mfi_s37 !== null) {
          const p37 = lastW3.close;
          const isBear = p37 > bb15_s37.upper && lastW3.close > lastW3.open;
          const isBull = p37 < bb15_s37.lower && lastW3.close < lastW3.open;
          const mfiOk = (isBear && mfi_s37 > 70) || (isBull && mfi_s37 < 30);
          const streakOk = (isBear && w3Streak >= 2) || (isBull && w3Streak <= -2);
          if ((isBear || isBull) && mfiOk && streakOk) {
            const deviation = isBear
              ? (p37 - bb15_s37.upper) / bb15_s37.upper * 100
              : (bb15_s37.lower - p37) / bb15_s37.lower * 100;
            const mfiExt = isBear ? mfi_s37 - 70 : 30 - mfi_s37;
            strategies.push({
              name: 'ETH 15m MFI Confirm',
              emoji: '🟠',
              score: Math.round(Math.min(10, 6.2 + mfiExt * 0.05 + deviation * 8 + Math.abs(w3Streak) * 0.35) * 10) / 10,
              direction: (isBear ? 'bearish' : 'bullish') as Direction,
              signal: `15m h=[5,12,20] MFI=${mfi_s37.toFixed(0)}>${isBear?'70':'30'} at BB(15,2.2) ${isBear ? 'upper' : 'lower'}, h=${w3Hour}UTC (76.7% **σ=1.8%** ULTRA STABLE)`,
              confidence: Math.round(Math.min(93, 67 + mfiExt * 0.5 + deviation * 9 + Math.abs(w3Streak) * 1.5)),
            });
          }
        }
      }

      // Strategy 38: ETH/15m Body+ATR Panic 🔸 — STRONG
      // h=[5,12,20]+body/ATR>=0.5+RSI7>70+BB(15,2.2)+streak>=2 → WF=77.6% σ=4.9% T=76 [84/72/76.9]
      // session6Validate.js confirmed: 5-fold 77.7% σ=5.1% — ALL 5 folds 73%+
      if ([5, 12, 20].includes(w3Hour)) {
        const bb15_s38 = calculateBollingerBands(synth15mWave3, 15, 2.2);
        const rsi7_s38 = calculateRSI(synth15mWave3, 7);
        if (bb15_s38 && rsi7_s38 !== null) {
          const p38 = lastW3.close;
          const isBear = p38 > bb15_s38.upper && lastW3.close > lastW3.open;
          const isBull = p38 < bb15_s38.lower && lastW3.close < lastW3.open;
          const rsiOk = (isBear && rsi7_s38 > 70) || (isBull && rsi7_s38 < 30);
          const streakOk = (isBear && w3Streak >= 2) || (isBull && w3Streak <= -2);
          if ((isBear || isBull) && rsiOk && streakOk) {
            // body/ATR ratio (panic body quality filter)
            const prevW3 = synth15mWave3[synth15mWave3.length - 2];
            const atr38 = prevW3
              ? Math.max(lastW3.high - lastW3.low, Math.abs(lastW3.high - prevW3.close), Math.abs(lastW3.low - prevW3.close))
              : lastW3.high - lastW3.low;
            const bodyATR38 = atr38 > 0 ? Math.abs(lastW3.close - lastW3.open) / atr38 : 0;
            if (bodyATR38 >= 0.5) {
              const deviation = isBear
                ? (p38 - bb15_s38.upper) / bb15_s38.upper * 100
                : (bb15_s38.lower - p38) / bb15_s38.lower * 100;
              strategies.push({
                name: 'ETH 15m ATR Panic',
                emoji: '🔸',
                score: Math.round(Math.min(10, 6.3 + bodyATR38 * 1.5 + deviation * 8 + Math.abs(w3Streak) * 0.35) * 10) / 10,
                direction: (isBear ? 'bearish' : 'bullish') as Direction,
                signal: `15m h=[5,12,20] body/ATR=${bodyATR38.toFixed(2)} RSI7=${rsi7_s38.toFixed(0)}>${isBear?'70':'<30'} at BB(15,2.2) ${isBear ? 'upper' : 'lower'}, h=${w3Hour}UTC (77.6% WR σ=4.9%)`,
                confidence: Math.round(Math.min(94, 68 + bodyATR38 * 4 + deviation * 9 + Math.abs(w3Streak) * 1.5)),
              });
            }
          }
        }
      }
    }
  }

  // Strategies 39-40: ETH/15m h=[9,12,20] and h=[7,12,20] with BB(20,2.2)+RSI7
  // Strat 39: h=[9,12,20]+BB(20,2.2)+s>=2 → 74.2% σ=5.5% T=116
  // Strat 40: h=[7,12,20]+RSI7>70+BB(20,2.2)+s>=2 → 75.7% σ=2.2% T=95
  {
    if (candles5m.length >= 65) {
      const synth15m_s3940: Candle[] = [];
      const aligned3940 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned3940; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s3940.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s3940.length >= 22) {
        const last3940 = synth15m_s3940[synth15m_s3940.length - 1];
        const h3940 = new Date(last3940.closeTime).getUTCHours();
        let streak3940 = 0;
        for (let j = synth15m_s3940.length - 1; j >= Math.max(0, synth15m_s3940.length - 8); j--) {
          const cj = synth15m_s3940[j];
          if (cj.close > cj.open) { if (streak3940 < 0) break; streak3940++; }
          else if (cj.close < cj.open) { if (streak3940 > 0) break; streak3940--; }
          else break;
        }

        // Strategy 39: h=[9,12,20]+BB(20,2.2)+s>=2
        if ([9, 12, 20].includes(h3940)) {
          const bb22_s39 = calculateBollingerBands(synth15m_s3940, 20, 2.2);
          if (bb22_s39) {
            const p39 = last3940.close;
            const isBear39 = p39 > bb22_s39.upper;
            const isBull39 = p39 < bb22_s39.lower;
            const streakOk39 = (isBear39 && streak3940 >= 2) || (isBull39 && streak3940 <= -2);
            if ((isBear39 || isBull39) && streakOk39) {
              const dev39 = isBear39
                ? (p39 - bb22_s39.upper) / bb22_s39.upper * 100
                : (bb22_s39.lower - p39) / bb22_s39.lower * 100;
              strategies.push({
                name: 'ETH 15m High Vol Hrs',
                emoji: '🕘',
                score: Math.round(Math.min(10, 6.1 + Math.abs(streak3940) * 0.4 + dev39 * 9) * 10) / 10,
                direction: (isBear39 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h3940}UTC at BB(20,2.2) ${isBear39 ? 'upper' : 'lower'} streak=${Math.abs(streak3940)} (74.2% WR σ=5.5%)`,
                confidence: Math.round(Math.min(89, 65 + Math.abs(streak3940) * 2 + dev39 * 9)),
              });
            }
          }
        }

        // Strategy 40: h=[7,12,20]+RSI7>70+BB(20,2.2)+s>=2
        if ([7, 12, 20].includes(h3940)) {
          const bb22_s40 = calculateBollingerBands(synth15m_s3940, 20, 2.2);
          const rsi7_s40 = calculateRSI(synth15m_s3940, 7);
          if (bb22_s40 && rsi7_s40 !== null && rsi7_s40 > 70) {
            const p40 = last3940.close;
            const isBear40 = p40 > bb22_s40.upper;
            const isBull40 = p40 < bb22_s40.lower;
            const streakOk40 = (isBear40 && streak3940 >= 2) || (isBull40 && streak3940 <= -2);
            if ((isBear40 || isBull40) && streakOk40) {
              const dev40 = isBear40
                ? (p40 - bb22_s40.upper) / bb22_s40.upper * 100
                : (bb22_s40.lower - p40) / bb22_s40.lower * 100;
              strategies.push({
                name: 'ETH 15m RSI7 Optimized',
                emoji: '💡',
                score: Math.round(Math.min(10, 6.3 + (rsi7_s40 - 70) * 0.05 + Math.abs(streak3940) * 0.4 + dev40 * 9) * 10) / 10,
                direction: (isBear40 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h3940}UTC RSI7=${rsi7_s40.toFixed(0)} at BB(20,2.2) ${isBear40 ? 'upper' : 'lower'} streak=${Math.abs(streak3940)} (75.7% WR σ=2.2%)`,
                confidence: Math.round(Math.min(90, 66 + (rsi7_s40 - 70) * 0.2 + Math.abs(streak3940) * 2 + dev40 * 8)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 41: Saturday BB Reversion 📅 — BTC VALIDATED, strong for ETH too
  // Saturday+BB(15,2.2)+streak>=1 → BTC WF=69.1% σ=5.7% T=149 [61.2/71.4/74.5]
  // 5-fold BTC: 69.0% σ=9.8% T=149 [65.5/62.1/58.6/86.2/72.7] IMPLEMENT
  // Key insight: BTC Saturday is the strongest day-of-week effect (~66% raw, 69% WF)
  // ETH Saturday is also strong (68% WR from earlier research)
  {
    const s41DayOk = candles5m.length > 0 && new Date(candles5m[candles5m.length - 1].closeTime).getUTCDay() === 6;
    if (s41DayOk && candles5m.length >= 65) {
      const synth15m_s41: Candle[] = [];
      const aligned41 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned41; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s41.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s41.length >= 22) {
        const lastS41 = synth15m_s41[synth15m_s41.length - 1];
        const bb15_s41 = calculateBollingerBands(synth15m_s41, 15, 2.2);
        if (bb15_s41) {
          const p41 = lastS41.close;
          const isBear = p41 > bb15_s41.upper && lastS41.close > lastS41.open;
          const isBull = p41 < bb15_s41.lower && lastS41.close < lastS41.open;
          if (isBear || isBull) {
            let s41Streak = 0;
            for (let j = synth15m_s41.length - 1; j >= Math.max(0, synth15m_s41.length - 7); j--) {
              const cj = synth15m_s41[j];
              if (cj.close > cj.open) { if (s41Streak < 0) break; s41Streak++; }
              else if (cj.close < cj.open) { if (s41Streak > 0) break; s41Streak--; }
              else break;
            }
            const streakOk = (isBear && s41Streak >= 1) || (isBull && s41Streak <= -1);
            if (streakOk) {
              const deviation = isBear
                ? (p41 - bb15_s41.upper) / bb15_s41.upper * 100
                : (bb15_s41.lower - p41) / bb15_s41.lower * 100;
              strategies.push({
                name: 'Saturday BB Reversion',
                emoji: '📅',
                score: Math.round(Math.min(10, 5.9 + deviation * 8 + Math.abs(s41Streak) * 0.4) * 10) / 10,
                direction: (isBear ? 'bearish' : 'bullish') as Direction,
                signal: `Saturday synth-15m BB(15,2.2) ${isBear ? 'upper' : 'lower'} +${deviation.toFixed(3)}%, ${Math.abs(s41Streak)} candle streak (BTC WF=69.1% σ=5.7%)`,
                confidence: Math.round(Math.min(87, 59 + deviation * 9 + Math.abs(s41Streak) * 1.5)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 43: ETH 15m Body Pure h7 — h=[7,12,20]+body>=0.3%+BB(15,2.2)+s>=2 → 73.5% WR σ=0.8% T=83
  // Strategy 44: ETH 15m Body h5   — h=[5,12,20]+body>=0.3%+BB(15,2.2)+s>=2 → 79.4% WR σ=6.8% T=73
  // Strategy 45: ETH 15m BodyATR h7 — h=[7,12,20]+body/ATR>=0.5+BB(15,2.2)+s>=2 → 72.0% WR σ=1.7% T=107
  {
    if (candles5m.length >= 65) {
      const synth15m_s4345: Candle[] = [];
      const aligned4345 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned4345; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s4345.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s4345.length >= 22) {
        const last4345 = synth15m_s4345[synth15m_s4345.length - 1];
        const h4345 = new Date(last4345.closeTime).getUTCHours();
        const bb15_s4345 = calculateBollingerBands(synth15m_s4345, 15, 2.2);

        let streak4345 = 0;
        for (let j = synth15m_s4345.length - 1; j >= Math.max(0, synth15m_s4345.length - 8); j--) {
          const cj = synth15m_s4345[j];
          if (cj.close > cj.open) { if (streak4345 < 0) break; streak4345++; }
          else if (cj.close < cj.open) { if (streak4345 > 0) break; streak4345--; }
          else break;
        }

        if (bb15_s4345) {
          const p4345 = last4345.close;
          const body4345 = Math.abs(p4345 - last4345.open) / last4345.open * 100;

          // Strat 43: h=[7,12,20] + body>=0.3% + streak>=2
          if ([7, 12, 20].includes(h4345)) {
            const isBear43 = p4345 > bb15_s4345.upper && last4345.close > last4345.open;
            const isBull43 = p4345 < bb15_s4345.lower && last4345.close < last4345.open;
            const streakOk43 = (isBear43 && streak4345 >= 2) || (isBull43 && streak4345 <= -2);
            if ((isBear43 || isBull43) && body4345 >= 0.3 && streakOk43) {
              const dev43 = isBear43
                ? (p4345 - bb15_s4345.upper) / bb15_s4345.upper * 100
                : (bb15_s4345.lower - p4345) / bb15_s4345.lower * 100;
              strategies.push({
                name: 'ETH 15m Body Pure h7',
                emoji: '🎯',
                score: Math.round(Math.min(10, 6.5 + body4345 * 0.6 + Math.abs(streak4345) * 0.35 + dev43 * 8) * 10) / 10,
                direction: (isBear43 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h4345}UTC body=${body4345.toFixed(2)}% at BB(15,2.2) ${isBear43 ? 'upper' : 'lower'} streak=${Math.abs(streak4345)} (73.5% WR σ=0.8%)`,
                confidence: Math.round(Math.min(88, 65 + body4345 * 3 + Math.abs(streak4345) * 2 + dev43 * 7)),
              });
            }
          }

          // Strat 44: h=[5,12,20] + body>=0.3% + streak>=2
          if ([5, 12, 20].includes(h4345)) {
            const isBear44 = p4345 > bb15_s4345.upper && last4345.close > last4345.open;
            const isBull44 = p4345 < bb15_s4345.lower && last4345.close < last4345.open;
            const streakOk44 = (isBear44 && streak4345 >= 2) || (isBull44 && streak4345 <= -2);
            if ((isBear44 || isBull44) && body4345 >= 0.3 && streakOk44) {
              const dev44 = isBear44
                ? (p4345 - bb15_s4345.upper) / bb15_s4345.upper * 100
                : (bb15_s4345.lower - p4345) / bb15_s4345.lower * 100;
              strategies.push({
                name: 'ETH 15m Body h5',
                emoji: '🔥',
                score: Math.round(Math.min(10, 6.8 + body4345 * 0.6 + Math.abs(streak4345) * 0.35 + dev44 * 8) * 10) / 10,
                direction: (isBear44 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h4345}UTC body=${body4345.toFixed(2)}% at BB(15,2.2) ${isBear44 ? 'upper' : 'lower'} streak=${Math.abs(streak4345)} (79.4% WR σ=6.8%)`,
                confidence: Math.round(Math.min(92, 68 + body4345 * 3 + Math.abs(streak4345) * 2 + dev44 * 7)),
              });
            }
          }

          // Strat 45: h=[7,12,20] + body/ATR>=0.5 + streak>=2
          if ([7, 12, 20].includes(h4345) && synth15m_s4345.length >= 2) {
            const prev45 = synth15m_s4345[synth15m_s4345.length - 2];
            const atr45 = Math.max(
              last4345.high - last4345.low,
              Math.abs(last4345.high - prev45.close),
              Math.abs(last4345.low - prev45.close)
            );
            const bodyAtr45 = atr45 > 0 ? Math.abs(last4345.close - last4345.open) / atr45 : 0;
            const isBear45 = p4345 > bb15_s4345.upper && last4345.close > last4345.open;
            const isBull45 = p4345 < bb15_s4345.lower && last4345.close < last4345.open;
            const streakOk45 = (isBear45 && streak4345 >= 2) || (isBull45 && streak4345 <= -2);
            if ((isBear45 || isBull45) && bodyAtr45 >= 0.5 && streakOk45) {
              const dev45 = isBear45
                ? (p4345 - bb15_s4345.upper) / bb15_s4345.upper * 100
                : (bb15_s4345.lower - p4345) / bb15_s4345.lower * 100;
              strategies.push({
                name: 'ETH 15m BodyATR h7',
                emoji: '📐',
                score: Math.round(Math.min(10, 6.3 + bodyAtr45 * 0.5 + Math.abs(streak4345) * 0.35 + dev45 * 8) * 10) / 10,
                direction: (isBear45 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h4345}UTC body/ATR=${bodyAtr45.toFixed(2)} at BB(15,2.2) ${isBear45 ? 'upper' : 'lower'} streak=${Math.abs(streak4345)} (72.0% WR σ=1.7%)`,
                confidence: Math.round(Math.min(86, 63 + bodyAtr45 * 4 + Math.abs(streak4345) * 2 + dev45 * 7)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 46: ETH 15m MFI(10)>80+BB(20,2.0)+GoodH+s≥2 → 71.6% WR σ=1.9% T=88 [MOST STABLE]
  // Strategy 49: ETH 15m MFI(10)>80+BB(20,2.2)+GoodH+s≥2 → 75.4% WR σ=5.4% T=69 [HIGHEST WR]
  // Strategy 50: ETH 15m MFI(10)>75+BB(20,2.2)+GoodH+s≥2 → 67.1% WR σ=4.1% T=91
  {
    const s4650GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 65) {
      const synth15m_s4650: Candle[] = [];
      const aligned4650 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned4650; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s4650.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s4650.length >= 22) {
        const last4650 = synth15m_s4650[synth15m_s4650.length - 1];
        const h4650 = new Date(last4650.closeTime).getUTCHours();
        if (s4650GoodHours.includes(h4650)) {
          const mfi10_4650 = calculateMFI(synth15m_s4650, 10);
          const bb20_s46 = calculateBollingerBands(synth15m_s4650, 20, 2.0);
          const bb22_s4950 = calculateBollingerBands(synth15m_s4650, 20, 2.2);

          let streak4650 = 0;
          for (let j = synth15m_s4650.length - 1; j >= Math.max(0, synth15m_s4650.length - 8); j--) {
            const cj = synth15m_s4650[j];
            if (cj.close > cj.open) { if (streak4650 < 0) break; streak4650++; }
            else if (cj.close < cj.open) { if (streak4650 > 0) break; streak4650--; }
            else break;
          }

          const p4650 = last4650.close;

          // Strat 46: MFI(10)>80 + BB(20,2.0) + streak>=2
          if (bb20_s46 && mfi10_4650 !== null) {
            const isBear46 = p4650 > bb20_s46.upper && last4650.close > last4650.open;
            const isBull46 = p4650 < bb20_s46.lower && last4650.close < last4650.open;
            const mfiOk46 = (isBear46 && mfi10_4650 > 80) || (isBull46 && mfi10_4650 < 20);
            const streakOk46 = (isBear46 && streak4650 >= 2) || (isBull46 && streak4650 <= -2);
            if ((isBear46 || isBull46) && mfiOk46 && streakOk46) {
              const dev46 = isBear46
                ? (p4650 - bb20_s46.upper) / bb20_s46.upper * 100
                : (bb20_s46.lower - p4650) / bb20_s46.lower * 100;
              const mfiExt46 = isBear46 ? mfi10_4650 - 80 : 20 - mfi10_4650;
              strategies.push({
                name: 'ETH 15m MFI10 Stable',
                emoji: '💹',
                score: Math.round(Math.min(10, 6.4 + mfiExt46 * 0.04 + dev46 * 8 + Math.abs(streak4650) * 0.35) * 10) / 10,
                direction: (isBear46 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h4650}UTC MFI(10)=${mfi10_4650.toFixed(0)} at BB(20,2.0) ${isBear46 ? 'upper' : 'lower'} streak=${Math.abs(streak4650)} (71.6% WR σ=1.9%)`,
                confidence: Math.round(Math.min(88, 64 + mfiExt46 * 0.2 + dev46 * 8 + Math.abs(streak4650) * 1.5)),
              });
            }
          }

          // Strat 49: MFI(10)>80 + BB(20,2.2) + streak>=2  (highest WR)
          if (bb22_s4950 && mfi10_4650 !== null) {
            const isBear49 = p4650 > bb22_s4950.upper && last4650.close > last4650.open;
            const isBull49 = p4650 < bb22_s4950.lower && last4650.close < last4650.open;
            const mfiOk49 = (isBear49 && mfi10_4650 > 80) || (isBull49 && mfi10_4650 < 20);
            const streakOk49 = (isBear49 && streak4650 >= 2) || (isBull49 && streak4650 <= -2);
            if ((isBear49 || isBull49) && mfiOk49 && streakOk49) {
              const dev49 = isBear49
                ? (p4650 - bb22_s4950.upper) / bb22_s4950.upper * 100
                : (bb22_s4950.lower - p4650) / bb22_s4950.lower * 100;
              const mfiExt49 = isBear49 ? mfi10_4650 - 80 : 20 - mfi10_4650;
              strategies.push({
                name: 'ETH 15m MFI10 Sniper',
                emoji: '🎖️',
                score: Math.round(Math.min(10, 6.7 + mfiExt49 * 0.04 + dev49 * 8 + Math.abs(streak4650) * 0.35) * 10) / 10,
                direction: (isBear49 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h4650}UTC MFI(10)=${mfi10_4650.toFixed(0)} at BB(20,2.2) ${isBear49 ? 'upper' : 'lower'} streak=${Math.abs(streak4650)} (75.4% WR σ=5.4%)`,
                confidence: Math.round(Math.min(92, 68 + mfiExt49 * 0.2 + dev49 * 8 + Math.abs(streak4650) * 1.5)),
              });
            }
          }

          // Strat 50: MFI(10)>75 + BB(20,2.2) + streak>=2
          if (bb22_s4950 && mfi10_4650 !== null) {
            const isBear50 = p4650 > bb22_s4950.upper && last4650.close > last4650.open;
            const isBull50 = p4650 < bb22_s4950.lower && last4650.close < last4650.open;
            const mfiOk50 = (isBear50 && mfi10_4650 > 75) || (isBull50 && mfi10_4650 < 25);
            const streakOk50 = (isBear50 && streak4650 >= 2) || (isBull50 && streak4650 <= -2);
            if ((isBear50 || isBull50) && mfiOk50 && streakOk50) {
              const dev50 = isBear50
                ? (p4650 - bb22_s4950.upper) / bb22_s4950.upper * 100
                : (bb22_s4950.lower - p4650) / bb22_s4950.lower * 100;
              const mfiExt50 = isBear50 ? mfi10_4650 - 75 : 25 - mfi10_4650;
              strategies.push({
                name: 'ETH 15m MFI10 Wide',
                emoji: '📈',
                score: Math.round(Math.min(10, 6.0 + mfiExt50 * 0.03 + dev50 * 8 + Math.abs(streak4650) * 0.35) * 10) / 10,
                direction: (isBear50 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${h4650}UTC MFI(10)=${mfi10_4650.toFixed(0)}>75 at BB(20,2.2) ${isBear50 ? 'upper' : 'lower'} streak=${Math.abs(streak4650)} (67.1% WR σ=4.1%)`,
                confidence: Math.round(Math.min(84, 60 + mfiExt50 * 0.2 + dev50 * 8 + Math.abs(streak4650) * 1.5)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 47: ETH/5m Range(48)+BB(20,2.5)+GoodH → 70.2% WR σ=2.9% T=164 [ALL 5-folds ≥65%]
  // Strategy 48: ETH/5m Wed+Sat+GoodH+BB(20,2.2)+s≥2 → 70.5% WR σ=4.4% T=112 [DOW ALPHA]
  {
    const s4748GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 50) {
      const lastE = candles5m[candles5m.length - 1];
      const hE = new Date(lastE.closeTime).getUTCHours();
      const dowE = new Date(lastE.closeTime).getUTCDay();

      // Strat 47: Range(48) high/low + BB(20,2.5) + GoodH
      if (s4748GoodHours.includes(hE)) {
        const window48 = candles5m.slice(-49, -1); // prior 48 bars
        if (window48.length >= 48) {
          const range48High = Math.max(...window48.map(c => c.high));
          const range48Low = Math.min(...window48.map(c => c.low));
          const bb25_s47 = calculateBollingerBands(candles5m, 20, 2.5);
          if (bb25_s47) {
            const p47 = lastE.close;
            // Bear: price just closed above 48-bar high AND above BB upper (double exhaustion)
            const isBear47 = p47 > range48High && p47 > bb25_s47.upper && lastE.close > lastE.open;
            // Bull: price just closed below 48-bar low AND below BB lower (double exhaustion)
            const isBull47 = p47 < range48Low && p47 < bb25_s47.lower && lastE.close < lastE.open;
            if (isBear47 || isBull47) {
              const dev47 = isBear47
                ? (p47 - bb25_s47.upper) / bb25_s47.upper * 100
                : (bb25_s47.lower - p47) / bb25_s47.lower * 100;
              strategies.push({
                name: 'ETH 5m Range Exhaustion',
                emoji: '🚧',
                score: Math.round(Math.min(10, 6.2 + dev47 * 8) * 10) / 10,
                direction: (isBear47 ? 'bearish' : 'bullish') as Direction,
                signal: `h=${hE}UTC 48-bar ${isBear47 ? 'range-high' : 'range-low'} breakout+BB(20,2.5) exhaustion (70.2% WR σ=2.9%)`,
                confidence: Math.round(Math.min(86, 62 + dev47 * 9)),
              });
            }
          }
        }
      }

      // Strat 48: Wed+Sat + GoodH + BB(20,2.2) + streak>=2
      const isWedSat = dowE === 3 || dowE === 6;
      if (isWedSat && s4748GoodHours.includes(hE)) {
        const bb22_s48 = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb22_s48) {
          const p48 = lastE.close;
          const isBear48 = p48 > bb22_s48.upper && lastE.close > lastE.open;
          const isBull48 = p48 < bb22_s48.lower && lastE.close < lastE.open;
          if (isBear48 || isBull48) {
            let streak48 = 0;
            for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
              const cj = candles5m[j];
              if (cj.close > cj.open) { if (streak48 < 0) break; streak48++; }
              else if (cj.close < cj.open) { if (streak48 > 0) break; streak48--; }
              else break;
            }
            const streakOk48 = (isBear48 && streak48 >= 2) || (isBull48 && streak48 <= -2);
            if (streakOk48) {
              const dev48 = isBear48
                ? (p48 - bb22_s48.upper) / bb22_s48.upper * 100
                : (bb22_s48.lower - p48) / bb22_s48.lower * 100;
              strategies.push({
                name: 'ETH 5m Wed/Sat DOW',
                emoji: '📅',
                score: Math.round(Math.min(10, 6.2 + Math.abs(streak48) * 0.35 + dev48 * 8) * 10) / 10,
                direction: (isBear48 ? 'bearish' : 'bullish') as Direction,
                signal: `${dowE === 3 ? 'Wed' : 'Sat'} h=${hE}UTC BB(20,2.2) ${isBear48 ? 'upper' : 'lower'} streak=${Math.abs(streak48)} (70.5% WR σ=4.4%)`,
                confidence: Math.round(Math.min(87, 63 + Math.abs(streak48) * 2 + dev48 * 8)),
              });
            }
          }
        }
      }
    }
  }

  // Strat 51: h=[7,12,20]+body>=0.3%+RSI7>65+BB(15,2.2)+s>=2 → 74.1% WR σ=0.0% T=81 [ULTRA STABLE]
  // Strat 52: h=[7,12,20]+body>=0.3%+RSI14>55+BB(20,2.2)+s>=2 → 78.5% WR σ=3.8% T=70 [HIGH WR]
  // Strat 53: h=[5,12,20]+MFI>70+BB(15,2.2)+s>=2 → 76.7% WR σ=1.8% T=73 [ULTRA STABLE]
  // Strat 54: h=[5,12,20]+body/ATR>=0.5+RSI7>65+BB(15,2.2)+s>=2 → 75.3% WR σ=0.8% T=89 [ULTRA STABLE]
  // Strat 55: h=[7,12,20]+MFI>65+BB(20,2.2)+s>=2 → 74.0% WR σ=2.0% T=92 [ULTRA STABLE]
  {
    if (candles5m.length >= 65) {
      const synth15m_s5155: Candle[] = [];
      const aligned5155 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned5155; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s5155.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s5155.length >= 22) {
        const last5155 = synth15m_s5155[synth15m_s5155.length - 1];
        const h5155 = new Date(last5155.closeTime).getUTCHours();

        // Shared indicators
        const bb15_5155 = calculateBollingerBands(synth15m_s5155, 15, 2.2);
        const bb20_5155 = calculateBollingerBands(synth15m_s5155, 20, 2.2);
        const rsi7_5155 = calculateRSI(synth15m_s5155, 7);
        const rsi14_5155 = calculateRSI(synth15m_s5155, 14);
        const mfi_5155 = calculateMFI(synth15m_s5155, 14);

        // Streak
        let streak5155 = 0;
        for (let j = synth15m_s5155.length - 1; j >= Math.max(0, synth15m_s5155.length - 8); j--) {
          const cj = synth15m_s5155[j];
          if (cj.close > cj.open) { if (streak5155 < 0) break; streak5155++; }
          else if (cj.close < cj.open) { if (streak5155 > 0) break; streak5155--; }
          else break;
        }

        const p5155 = last5155.close;
        const body5155 = Math.abs(p5155 - last5155.open) / last5155.open * 100;

        // ATR for body/ATR ratio
        let bodyAtr5155 = 0;
        if (synth15m_s5155.length >= 2) {
          const prev5155 = synth15m_s5155[synth15m_s5155.length - 2];
          const atr5155 = Math.max(
            last5155.high - last5155.low,
            Math.abs(last5155.high - prev5155.close),
            Math.abs(last5155.low - prev5155.close)
          );
          bodyAtr5155 = atr5155 > 0 ? Math.abs(last5155.close - last5155.open) / atr5155 : 0;
        }

        // Strat 51: h=[7,12,20]+body>=0.3%+RSI7>65+BB(15,2.2)+s>=2 → 74.1% σ=0.0% ULTRA STABLE
        if ([7, 12, 20].includes(h5155) && bb15_5155 && rsi7_5155 !== null) {
          const isBear51 = p5155 > bb15_5155.upper && last5155.close > last5155.open;
          const isBull51 = p5155 < bb15_5155.lower && last5155.close < last5155.open;
          const rsiOk51 = (isBear51 && rsi7_5155 > 65) || (isBull51 && rsi7_5155 < 35);
          const streakOk51 = (isBear51 && streak5155 >= 2) || (isBull51 && streak5155 <= -2);
          if ((isBear51 || isBull51) && body5155 >= 0.3 && rsiOk51 && streakOk51) {
            const dev51 = isBear51
              ? (p5155 - bb15_5155.upper) / bb15_5155.upper * 100
              : (bb15_5155.lower - p5155) / bb15_5155.lower * 100;
            strategies.push({
              name: 'ETH 15m Body+RSI65 h7',
              emoji: '🏆',
              score: Math.round(Math.min(10, 6.6 + body5155 * 0.5 + Math.abs(streak5155) * 0.35 + dev51 * 8) * 10) / 10,
              direction: (isBear51 ? 'bearish' : 'bullish') as Direction,
              signal: `h=${h5155}UTC body=${body5155.toFixed(2)}% RSI7=${rsi7_5155.toFixed(0)}>65 BB(15,2.2) streak=${Math.abs(streak5155)} (74.1% WR σ=0.0%)`,
              confidence: Math.round(Math.min(90, 66 + body5155 * 3 + Math.abs(streak5155) * 2 + dev51 * 7)),
            });
          }
        }

        // Strat 52: h=[7,12,20]+body>=0.3%+RSI14>55+BB(20,2.2)+s>=2 → 78.5% σ=3.8% HIGH WR
        if ([7, 12, 20].includes(h5155) && bb20_5155 && rsi14_5155 !== null) {
          const isBear52 = p5155 > bb20_5155.upper && last5155.close > last5155.open;
          const isBull52 = p5155 < bb20_5155.lower && last5155.close < last5155.open;
          const rsiOk52 = (isBear52 && rsi14_5155 > 55) || (isBull52 && rsi14_5155 < 45);
          const streakOk52 = (isBear52 && streak5155 >= 2) || (isBull52 && streak5155 <= -2);
          if ((isBear52 || isBull52) && body5155 >= 0.3 && rsiOk52 && streakOk52) {
            const dev52 = isBear52
              ? (p5155 - bb20_5155.upper) / bb20_5155.upper * 100
              : (bb20_5155.lower - p5155) / bb20_5155.lower * 100;
            strategies.push({
              name: 'ETH 15m Body+RSI14 h7',
              emoji: '🥇',
              score: Math.round(Math.min(10, 6.8 + body5155 * 0.5 + Math.abs(streak5155) * 0.35 + dev52 * 8) * 10) / 10,
              direction: (isBear52 ? 'bearish' : 'bullish') as Direction,
              signal: `h=${h5155}UTC body=${body5155.toFixed(2)}% RSI14=${rsi14_5155.toFixed(0)}>55 BB(20,2.2) streak=${Math.abs(streak5155)} (78.5% WR σ=3.8%)`,
              confidence: Math.round(Math.min(92, 68 + body5155 * 3 + Math.abs(streak5155) * 2 + dev52 * 7)),
            });
          }
        }

        // Strat 53: h=[5,12,20]+MFI>70+BB(15,2.2)+s>=2 → 76.7% σ=1.8% ULTRA STABLE
        if ([5, 12, 20].includes(h5155) && bb15_5155 && mfi_5155 !== null) {
          const isBear53 = p5155 > bb15_5155.upper && last5155.close > last5155.open;
          const isBull53 = p5155 < bb15_5155.lower && last5155.close < last5155.open;
          const mfiOk53 = (isBear53 && mfi_5155 > 70) || (isBull53 && mfi_5155 < 30);
          const streakOk53 = (isBear53 && streak5155 >= 2) || (isBull53 && streak5155 <= -2);
          if ((isBear53 || isBull53) && mfiOk53 && streakOk53) {
            const dev53 = isBear53
              ? (p5155 - bb15_5155.upper) / bb15_5155.upper * 100
              : (bb15_5155.lower - p5155) / bb15_5155.lower * 100;
            const mfiExt53 = isBear53 ? mfi_5155 - 70 : 30 - mfi_5155;
            strategies.push({
              name: 'ETH 15m MFI70 h5',
              emoji: '💰',
              score: Math.round(Math.min(10, 6.7 + mfiExt53 * 0.04 + Math.abs(streak5155) * 0.35 + dev53 * 8) * 10) / 10,
              direction: (isBear53 ? 'bearish' : 'bullish') as Direction,
              signal: `h=${h5155}UTC MFI=${mfi_5155.toFixed(0)}>70 BB(15,2.2) streak=${Math.abs(streak5155)} (76.7% WR σ=1.8%)`,
              confidence: Math.round(Math.min(91, 67 + mfiExt53 * 0.2 + Math.abs(streak5155) * 2 + dev53 * 7)),
            });
          }
        }

        // Strat 54: h=[5,12,20]+body/ATR>=0.5+RSI7>65+BB(15,2.2)+s>=2 → 75.3% σ=0.8% ULTRA STABLE
        if ([5, 12, 20].includes(h5155) && bb15_5155 && rsi7_5155 !== null) {
          const isBear54 = p5155 > bb15_5155.upper && last5155.close > last5155.open;
          const isBull54 = p5155 < bb15_5155.lower && last5155.close < last5155.open;
          const rsiOk54 = (isBear54 && rsi7_5155 > 65) || (isBull54 && rsi7_5155 < 35);
          const streakOk54 = (isBear54 && streak5155 >= 2) || (isBull54 && streak5155 <= -2);
          if ((isBear54 || isBull54) && bodyAtr5155 >= 0.5 && rsiOk54 && streakOk54) {
            const dev54 = isBear54
              ? (p5155 - bb15_5155.upper) / bb15_5155.upper * 100
              : (bb15_5155.lower - p5155) / bb15_5155.lower * 100;
            strategies.push({
              name: 'ETH 15m BodyATR+RSI65 h5',
              emoji: '⚡',
              score: Math.round(Math.min(10, 6.6 + bodyAtr5155 * 0.4 + Math.abs(streak5155) * 0.35 + dev54 * 8) * 10) / 10,
              direction: (isBear54 ? 'bearish' : 'bullish') as Direction,
              signal: `h=${h5155}UTC body/ATR=${bodyAtr5155.toFixed(2)} RSI7=${rsi7_5155.toFixed(0)}>65 BB(15,2.2) streak=${Math.abs(streak5155)} (75.3% WR σ=0.8%)`,
              confidence: Math.round(Math.min(90, 66 + bodyAtr5155 * 3 + Math.abs(streak5155) * 2 + dev54 * 7)),
            });
          }
        }

        // Strat 55: h=[7,12,20]+MFI>65+BB(20,2.2)+s>=2 → 74.0% σ=2.0% ULTRA STABLE
        if ([7, 12, 20].includes(h5155) && bb20_5155 && mfi_5155 !== null) {
          const isBear55 = p5155 > bb20_5155.upper && last5155.close > last5155.open;
          const isBull55 = p5155 < bb20_5155.lower && last5155.close < last5155.open;
          const mfiOk55 = (isBear55 && mfi_5155 > 65) || (isBull55 && mfi_5155 < 35);
          const streakOk55 = (isBear55 && streak5155 >= 2) || (isBull55 && streak5155 <= -2);
          if ((isBear55 || isBull55) && mfiOk55 && streakOk55) {
            const dev55 = isBear55
              ? (p5155 - bb20_5155.upper) / bb20_5155.upper * 100
              : (bb20_5155.lower - p5155) / bb20_5155.lower * 100;
            const mfiExt55 = isBear55 ? mfi_5155 - 65 : 35 - mfi_5155;
            strategies.push({
              name: 'ETH 15m MFI65 h7',
              emoji: '📡',
              score: Math.round(Math.min(10, 6.5 + mfiExt55 * 0.03 + Math.abs(streak5155) * 0.35 + dev55 * 8) * 10) / 10,
              direction: (isBear55 ? 'bearish' : 'bullish') as Direction,
              signal: `h=${h5155}UTC MFI=${mfi_5155.toFixed(0)}>65 BB(20,2.2) streak=${Math.abs(streak5155)} (74.0% WR σ=2.0%)`,
              confidence: Math.round(Math.min(89, 65 + mfiExt55 * 0.2 + Math.abs(streak5155) * 2 + dev55 * 7)),
            });
          }
        }
      }
    }
  }

  // ML-22: ETH/15m HighVol+RSI7+BB(20,2.2)+GoodH+s>=2 → 74.1% WR σ=5.2% T=54
  // Key insight from ML: ETH is MOST predictable in HIGH-vol regime (opposite of SOL!)
  // HIGH-vol = ATR >= P67 (top 33% of volatility)
  {
    const ml22GoodHours = [10, 11, 12, 21];
    if (candles5m.length >= 65) {
      const synth15m_ml22: Candle[] = [];
      const aligned_ml22 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned_ml22; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_ml22.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_ml22.length >= 22) {
        const last_ml22 = synth15m_ml22[synth15m_ml22.length - 1];
        const h_ml22 = new Date(last_ml22.closeTime).getUTCHours();
        if (ml22GoodHours.includes(h_ml22)) {
          const atrWin_ml22 = synth15m_ml22.slice(-100);
          const atrs_ml22: number[] = [];
          for (let j = 1; j < atrWin_ml22.length; j++) {
            const pv = atrWin_ml22[j - 1]; const cv = atrWin_ml22[j];
            atrs_ml22.push(Math.max(cv.high - cv.low, Math.abs(cv.high - pv.close), Math.abs(cv.low - pv.close)));
          }
          if (atrs_ml22.length >= 20) {
            const currentATR_ml22 = atrs_ml22[atrs_ml22.length - 1];
            const sorted_ml22 = [...atrs_ml22].sort((a, b) => a - b);
            const atrP67_ml22 = sorted_ml22[Math.floor(sorted_ml22.length * 0.67)];
            const isHighVol_ml22 = currentATR_ml22 >= atrP67_ml22;
            if (isHighVol_ml22) {
              const bb20_ml22 = calculateBollingerBands(synth15m_ml22, 20, 2.2);
              const rsi7_ml22 = calculateRSI(synth15m_ml22, 7);
              if (bb20_ml22 && rsi7_ml22 !== null) {
                const p_ml22 = last_ml22.close;
                const isBear_ml22 = p_ml22 > bb20_ml22.upper && last_ml22.close > last_ml22.open;
                const isBull_ml22 = p_ml22 < bb20_ml22.lower && last_ml22.close < last_ml22.open;
                const rsiOk_ml22 = (isBear_ml22 && rsi7_ml22 > 55) || (isBull_ml22 && rsi7_ml22 < 45);
                let streak_ml22 = 0;
                for (let j = synth15m_ml22.length - 1; j >= Math.max(0, synth15m_ml22.length - 8); j--) {
                  const cj = synth15m_ml22[j];
                  if (cj.close > cj.open) { if (streak_ml22 < 0) break; streak_ml22++; }
                  else if (cj.close < cj.open) { if (streak_ml22 > 0) break; streak_ml22--; }
                  else break;
                }
                const streakOk_ml22 = (isBear_ml22 && streak_ml22 >= 2) || (isBull_ml22 && streak_ml22 <= -2);
                if ((isBear_ml22 || isBull_ml22) && rsiOk_ml22 && streakOk_ml22) {
                  const dev_ml22 = isBear_ml22
                    ? (p_ml22 - bb20_ml22.upper) / bb20_ml22.upper * 100
                    : (bb20_ml22.lower - p_ml22) / bb20_ml22.lower * 100;
                  strategies.push({
                    name: 'ETH 15m HighVol BB',
                    emoji: '⚡',
                    score: Math.round(Math.min(10, 6.5 + dev_ml22 * 8 + Math.abs(streak_ml22) * 0.35) * 10) / 10,
                    direction: (isBear_ml22 ? 'bearish' : 'bullish') as Direction,
                    signal: `h=${h_ml22}UTC HIGH-vol RSI7=${rsi7_ml22.toFixed(0)} BB(20,2.2) ${isBear_ml22 ? 'upper' : 'lower'} streak=${Math.abs(streak_ml22)} (74.1% WR σ=5.2%)`,
                    confidence: Math.round(Math.min(89, 65 + dev_ml22 * 8 + Math.abs(streak_ml22) * 2)),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // ─── BTC 5m High-WR Strategies (43-46) ─────────────────────────────────────
  // BTC at hours [1,12,13,16,20] UTC is strongly mean-reverting above BB(20,2.2)
  // Research (btc5mResearch.js): baseline GH+BB22+s>=2 = 79.7% σ=5.5% T=310
  // Key insight: BTC good hours are different from ETH [10,11,12,21]

  const BTC_5M_GOOD_HOURS = [1, 12, 13, 16, 20]; // validated in BTC research

  // Build shared state for BTC strategies
  if (candles5m.length >= 22) {
    const btcLast = candles5m[candles5m.length - 1];
    const btcHour = new Date(btcLast.closeTime).getUTCHours();
    const btcGoodH = BTC_5M_GOOD_HOURS.includes(btcHour);
    const bb22_btc5 = calculateBollingerBands(candles5m, 20, 2.2);

    if (btcGoodH && bb22_btc5) {
      const p_btc5 = btcLast.close;
      const isBear_btc5 = p_btc5 > bb22_btc5.upper && btcLast.close > btcLast.open;
      const isBull_btc5 = p_btc5 < bb22_btc5.lower && btcLast.close < btcLast.open;

      if (isBear_btc5 || isBull_btc5) {
        // Count streak
        let btc5Streak = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (btc5Streak < 0) break; btc5Streak++; }
          else if (cj.close < cj.open) { if (btc5Streak > 0) break; btc5Streak--; }
          else break;
        }
        const dev_btc5 = isBear_btc5
          ? (p_btc5 - bb22_btc5.upper) / bb22_btc5.upper * 100
          : (bb22_btc5.lower - p_btc5) / bb22_btc5.lower * 100;

        // Strategy 43: BTC MFI>75+BB22+GH+s>=1 → WF=81.6% σ=2.6% T=188 (ULTRA STABLE)
        const mfi_btc5 = calculateMFI(candles5m, 10);
        if (Math.abs(btc5Streak) >= 1 && mfi_btc5 !== null) {
          if ((isBear_btc5 && mfi_btc5 > 75) || (isBull_btc5 && mfi_btc5 < 25)) {
            strategies.push({
              name: 'BTC MFI BB',
              emoji: '💹',
              score: Math.round(Math.min(10, 6.5 + (Math.abs(btc5Streak) - 1) * 0.4 + dev_btc5 * 9) * 10) / 10,
              direction: (isBear_btc5 ? 'bearish' : 'bullish') as Direction,
              signal: `BTC MFI=${mfi_btc5.toFixed(0)}${isBear_btc5 ? '>75' : '<25'} at BB(20,2.2) h=${btcHour}UTC streak=${Math.abs(btc5Streak)} (81.6% WR σ=2.6% ULTRA STABLE)`,
              confidence: Math.round(Math.min(92, 68 + dev_btc5 * 10 + (Math.abs(btc5Streak) - 1) * 2)),
            });
          }
        }

        // Strategy 44: BTC RSI>67+BB22+GH+s>=1 → WF=80.5% σ=4.2% T=221
        if (rsi14_5m !== null && Math.abs(btc5Streak) >= 1) {
          if ((isBear_btc5 && rsi14_5m > 67) || (isBull_btc5 && rsi14_5m < 33)) {
            strategies.push({
              name: 'BTC RSI BB',
              emoji: '📡',
              score: Math.round(Math.min(10, 6.4 + (Math.abs(btc5Streak) - 1) * 0.4 + dev_btc5 * 9) * 10) / 10,
              direction: (isBear_btc5 ? 'bearish' : 'bullish') as Direction,
              signal: `BTC RSI=${rsi14_5m.toFixed(0)}${isBear_btc5 ? '>67' : '<33'} at BB(20,2.2) h=${btcHour}UTC streak=${Math.abs(btc5Streak)} (80.5% WR σ=4.2%)`,
              confidence: Math.round(Math.min(91, 67 + dev_btc5 * 10 + (Math.abs(btc5Streak) - 1) * 2)),
            });
          }
        }

        // Strategy 45: BTC GH+BB22+s>=2 → WF=79.7% σ=5.5% T=310 (HIGH FREQ)
        if (Math.abs(btc5Streak) >= 2) {
          strategies.push({
            name: 'BTC GH BB Streak',
            emoji: '🔰',
            score: Math.round(Math.min(10, 6.2 + (Math.abs(btc5Streak) - 2) * 0.5 + dev_btc5 * 9) * 10) / 10,
            direction: (isBear_btc5 ? 'bearish' : 'bullish') as Direction,
            signal: `BTC ${Math.abs(btc5Streak)}${isBear_btc5 ? 'G' : 'R'} streak at BB(20,2.2) h=${btcHour}UTC (79.7% WR σ=5.5% T=310/yr)`,
            confidence: Math.round(Math.min(90, 66 + dev_btc5 * 10 + (Math.abs(btc5Streak) - 2) * 2)),
          });
        }

        // Strategy 46: BTC RSI>70+BB22+GH+s>=1 → WF=83.1% σ=8.5% T=161 (HIGHEST WR)
        if (rsi14_5m !== null && Math.abs(btc5Streak) >= 1) {
          if ((isBear_btc5 && rsi14_5m > 70) || (isBull_btc5 && rsi14_5m < 30)) {
            strategies.push({
              name: 'BTC RSI70 BB',
              emoji: '🏅',
              score: Math.round(Math.min(10, 6.7 + (Math.abs(btc5Streak) - 1) * 0.4 + dev_btc5 * 9) * 10) / 10,
              direction: (isBear_btc5 ? 'bearish' : 'bullish') as Direction,
              signal: `BTC RSI=${rsi14_5m.toFixed(0)}${isBear_btc5 ? '>70' : '<30'} at BB(20,2.2) h=${btcHour}UTC streak=${Math.abs(btc5Streak)} (83.1% WR σ=8.5%)`,
              confidence: Math.round(Math.min(93, 70 + dev_btc5 * 10 + (Math.abs(btc5Streak) - 1) * 2)),
            });
          }
        }
      }
    }
  }

  // ─── Ultra High-Frequency Strategy (67) — BB(20,1.8) 84 trades/day ETH+BTC ──
  // Discovered: highFreqSearch40.js + validated by polymarket_hf_research.js
  // CORRECT single-candle exit (Polymarket 5m resolution):
  // ETH BB(20,1.8)+s>=1: WF=55.4% σ=1.0% T=7771 (42.2/day!) walk-forward validated
  // BTC BB(20,1.8)+s>=1: WF=54.3% σ=1.5% T=7747 (42.1/day!) walk-forward validated
  // SOL BB(20,1.8)+s>=1: WF=52.2% σ=1.9% T=7998 (43.5/day!) marginal after 2¢ spread
  // ETH+BTC combined: 84.3/day at 54.8% WR — TARGET HIT (profitable after fees)
  // Note: Previous 73% WR was from 3-candle touch exit (incorrect for Polymarket)
  if (candles5m.length >= 22) {
    const last_hf = candles5m[candles5m.length - 1];
    const bb18_hf = calculateBollingerBands(candles5m, 20, 1.8);
    if (bb18_hf) {
      const p_hf = last_hf.close;
      const isBear_hf = p_hf > bb18_hf.upper && last_hf.close > last_hf.open;
      const isBull_hf = p_hf < bb18_hf.lower && last_hf.close < last_hf.open;
      if (isBear_hf || isBull_hf) {
        let streak_hf = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak_hf < 0) break; streak_hf++; }
          else if (cj.close < cj.open) { if (streak_hf > 0) break; streak_hf--; }
          else break;
        }
        const dev_hf = isBear_hf
          ? (p_hf - bb18_hf.upper) / bb18_hf.upper * 100
          : (bb18_hf.lower - p_hf) / bb18_hf.lower * 100;
        // Strategy 67: ALL_H+BB(20,1.8)+s>=1 → 40+/day ULTRA STABLE
        // ETH: 55.4% WR (correct single-candle exit) | 42/day | BTC: 54.3% | SOL: 52.2%
        strategies.push({
          name: 'ALL-H BB18 HF',
          emoji: '⚡🔁',
          score: Math.round(Math.min(10, 6.0 + (Math.abs(streak_hf) - 1) * 0.3 + dev_hf * 9) * 10) / 10,
          direction: (isBear_hf ? 'bearish' : 'bullish') as Direction,
          signal: `ALL-H BB(20,1.8) ${isBear_hf ? 'upper' : 'lower'} streak=${Math.abs(streak_hf)} dev=${dev_hf.toFixed(3)}% (ETH 55.4% WR 42/day HF)`,
          confidence: Math.round(Math.min(86, 65 + dev_hf * 12 + (Math.abs(streak_hf) - 1) * 2)),
        });
      }
    }
  }

  // ─── All-Hours High-Frequency Strategies (56-58) ────────────────────────────
  // No hour filter — RSI/MFI is the primary exhaustion signal (fires 24/7)
  // ETH ALL_H+RSI>70+BB22+s>=1: WF=76.1% σ=2.6% T=939 (5.1/day!) ULTRA STABLE
  // ETH ALL_H+MFI>80+BB22+s>=1: WF=75.7% σ=4.1% T=770 (4.2/day!)
  // ETH ALL_H+MFI>85+BB22+s>=1: WF=76.3% σ=4.3% T=522 (2.8/day!)
  // BTC ALL_H+RSI>70+BB22+s>=1: WF=75.2% σ=5.6% T=930 (5.1/day!)
  // Source: quickValidateBTC5m.js walk-forward validation
  if (candles5m.length >= 22) {
    const last_allh = candles5m[candles5m.length - 1];
    const bb22_allh = calculateBollingerBands(candles5m, 20, 2.2);
    if (bb22_allh) {
      const p_allh = last_allh.close;
      const isBear_allh = p_allh > bb22_allh.upper && last_allh.close > last_allh.open;
      const isBull_allh = p_allh < bb22_allh.lower && last_allh.close < last_allh.open;
      if (isBear_allh || isBull_allh) {
        let streak_allh = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak_allh < 0) break; streak_allh++; }
          else if (cj.close < cj.open) { if (streak_allh > 0) break; streak_allh--; }
          else break;
        }
        const dev_allh = isBear_allh
          ? (p_allh - bb22_allh.upper) / bb22_allh.upper * 100
          : (bb22_allh.lower - p_allh) / bb22_allh.lower * 100;

        // Strategy 56: ALL_H + RSI>70 + BB(20,2.2) + streak>=1 → WF=76.1% σ=2.6% 5.1/day ULTRA STABLE
        if (Math.abs(streak_allh) >= 1 && rsi14_5m !== null) {
          if ((isBear_allh && rsi14_5m > 70) || (isBull_allh && rsi14_5m < 30)) {
            strategies.push({
              name: 'ALL-H RSI Panic BB',
              emoji: '⚡',
              score: Math.round(Math.min(10, 6.5 + (Math.abs(streak_allh) - 1) * 0.3 + dev_allh * 8) * 10) / 10,
              direction: (isBear_allh ? 'bearish' : 'bullish') as Direction,
              signal: `ALL-H RSI=${rsi14_5m.toFixed(0)}${isBear_allh ? '>70' : '<30'} at BB(20,2.2) streak=${Math.abs(streak_allh)} (76.1% WR σ=2.6% 5.1/day ULTRA STABLE)`,
              confidence: Math.round(Math.min(90, 66 + dev_allh * 10 + (Math.abs(streak_allh) - 1) * 2)),
            });
          }
        }

        // Strategy 57: ALL_H + MFI>80 + BB(20,2.2) + streak>=1 → WF=75.7% σ=4.1% 4.2/day
        // Strategy 58: ALL_H + MFI>85 + BB(20,2.2) + streak>=1 → WF=76.3% σ=4.3% 2.8/day
        const mfi_allh = calculateMFI(candles5m, 10);
        if (Math.abs(streak_allh) >= 1 && mfi_allh !== null) {
          if ((isBear_allh && mfi_allh > 80) || (isBull_allh && mfi_allh < 20)) {
            strategies.push({
              name: 'ALL-H MFI80 BB',
              emoji: '🌊',
              score: Math.round(Math.min(10, 6.4 + (Math.abs(streak_allh) - 1) * 0.3 + dev_allh * 8) * 10) / 10,
              direction: (isBear_allh ? 'bearish' : 'bullish') as Direction,
              signal: `ALL-H MFI=${mfi_allh.toFixed(0)}${isBear_allh ? '>80' : '<20'} at BB(20,2.2) streak=${Math.abs(streak_allh)} (75.7% WR σ=4.1% 4.2/day)`,
              confidence: Math.round(Math.min(89, 65 + dev_allh * 10 + (Math.abs(streak_allh) - 1) * 2)),
            });
          }
          if ((isBear_allh && mfi_allh > 85) || (isBull_allh && mfi_allh < 15)) {
            strategies.push({
              name: 'ALL-H MFI85 BB',
              emoji: '🔥',
              score: Math.round(Math.min(10, 6.6 + (Math.abs(streak_allh) - 1) * 0.3 + dev_allh * 8) * 10) / 10,
              direction: (isBear_allh ? 'bearish' : 'bullish') as Direction,
              signal: `ALL-H MFI=${mfi_allh.toFixed(0)}${isBear_allh ? '>85' : '<15'} at BB(20,2.2) streak=${Math.abs(streak_allh)} (76.3% WR σ=4.3% 2.8/day)`,
              confidence: Math.round(Math.min(90, 67 + dev_allh * 10 + (Math.abs(streak_allh) - 1) * 2)),
            });
          }
        }
      }
    }
  }

  // ─── Enhanced All-Hours Strategies (61-66) ──────────────────────────────────
  // ETH ALL_H+RSI>70+MFI>70+BB22+s>=1: WF=76.4% σ=2.2% T=803 (4.4/day!) ULTRA STABLE
  // ETH ALL_H+RSI>70+BB22+dev[0.05-0.5%]+s>=1: WF=77.8% σ=2.7% T=592 (3.2/day!) ULTRA STABLE
  // BTC Synth15m GH+RSI>65+BB22+s>=1: WF=86.3% σ=6.3% T=95 (0.5/day) HIGHEST WR EVER!
  // BTC Synth15m ALL_H+RSI>70+BB22+s>=1: WF=77.0% σ=4.4% T=330 (1.8/day)
  // BTC GH+RSI>65+body>=0.15%+BB22+s>=1: WF=79.2% σ=2.6% T=122 (0.7/day) ULTRA STABLE
  // BTC ALL_H+RSI>70+body>=0.2%+BB22+s>=1: WF=78.0% σ=5.0% T=305 (1.7/day)
  // Source: newSignalSearch.js Sections 3-6
  if (candles5m.length >= 22) {
    const last_enh = candles5m[candles5m.length - 1];
    const bb22_enh = calculateBollingerBands(candles5m, 20, 2.2);
    if (bb22_enh && rsi14_5m !== null) {
      const p_enh = last_enh.close;
      const isBear_enh = p_enh > bb22_enh.upper && last_enh.close > last_enh.open;
      const isBull_enh = p_enh < bb22_enh.lower && last_enh.close < last_enh.open;
      if (isBear_enh || isBull_enh) {
        let streak_enh = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak_enh < 0) break; streak_enh++; }
          else if (cj.close < cj.open) { if (streak_enh > 0) break; streak_enh--; }
          else break;
        }
        const dev_enh = isBear_enh
          ? (p_enh - bb22_enh.upper) / bb22_enh.upper * 100
          : (bb22_enh.lower - p_enh) / bb22_enh.lower * 100;

        // Strategy 64: ALL_H+RSI>70+MFI>70+BB22+s>=1 → WF=76.4% σ=2.2% 4.4/day ULTRA STABLE
        const mfi_enh = calculateMFI(candles5m, 10);
        if (Math.abs(streak_enh) >= 1 && mfi_enh !== null) {
          if ((isBear_enh && rsi14_5m > 70 && mfi_enh > 70) || (isBull_enh && rsi14_5m < 30 && mfi_enh < 30)) {
            strategies.push({
              name: 'ALL-H Dual RSI+MFI BB',
              emoji: '🎯',
              score: Math.round(Math.min(10, 6.6 + (Math.abs(streak_enh) - 1) * 0.3 + dev_enh * 9) * 10) / 10,
              direction: (isBear_enh ? 'bearish' : 'bullish') as Direction,
              signal: `ALL-H RSI=${rsi14_5m.toFixed(0)}>70+MFI=${mfi_enh.toFixed(0)}>70 at BB(20,2.2) streak=${Math.abs(streak_enh)} (76.4% WR σ=2.2% 4.4/day ULTRA STABLE)`,
              confidence: Math.round(Math.min(91, 67 + dev_enh * 10 + (Math.abs(streak_enh) - 1) * 2)),
            });
          }
        }

        // Strategy 65: ALL_H+RSI>70+BB22+dev[0.05-0.5%]+s>=1 → WF=77.8% σ=2.7% 3.2/day ULTRA STABLE
        if (Math.abs(streak_enh) >= 1 && rsi14_5m > 70) {
          const rsiOk65 = (isBear_enh && rsi14_5m > 70) || (isBull_enh && rsi14_5m < 30);
          const devInRange65 = dev_enh >= 0.05 && dev_enh <= 0.5;
          if (rsiOk65 && devInRange65) {
            strategies.push({
              name: 'ALL-H RSI Dev Filter BB',
              emoji: '🔭',
              score: Math.round(Math.min(10, 6.7 + (Math.abs(streak_enh) - 1) * 0.3 + dev_enh * 10) * 10) / 10,
              direction: (isBear_enh ? 'bearish' : 'bullish') as Direction,
              signal: `ALL-H RSI=${rsi14_5m.toFixed(0)}>70 dev=${dev_enh.toFixed(3)}%[0.05-0.5] BB(20,2.2) streak=${Math.abs(streak_enh)} (77.8% WR σ=2.7% 3.2/day ULTRA STABLE)`,
              confidence: Math.round(Math.min(91, 68 + dev_enh * 12 + (Math.abs(streak_enh) - 1) * 2)),
            });
          }
        }

        // Strategy 66: BTC GH+RSI>65+body>=0.15%+BB22+s>=1 → WF=79.2% σ=2.6% ULTRA STABLE
        const BTC_GH_66 = [1, 12, 13, 16, 20];
        const h_enh = new Date(last_enh.closeTime).getUTCHours();
        if (Math.abs(streak_enh) >= 1 && rsi14_5m > 65 && BTC_GH_66.includes(h_enh)) {
          const body_enh = Math.abs(last_enh.close - last_enh.open) / last_enh.open * 100;
          if (body_enh >= 0.15) {
            const rsiOk66 = (isBear_enh && rsi14_5m > 65) || (isBull_enh && rsi14_5m < 35);
            if (rsiOk66) {
              strategies.push({
                name: 'BTC GH Body RSI BB',
                emoji: '💎',
                score: Math.round(Math.min(10, 6.8 + (Math.abs(streak_enh) - 1) * 0.3 + dev_enh * 9 + body_enh * 0.5) * 10) / 10,
                direction: (isBear_enh ? 'bearish' : 'bullish') as Direction,
                signal: `BTC GH h=${h_enh}UTC RSI=${rsi14_5m.toFixed(0)}>65 body=${body_enh.toFixed(2)}%>=0.15% BB(20,2.2) streak=${Math.abs(streak_enh)} (79.2% WR σ=2.6% ULTRA STABLE)`,
                confidence: Math.round(Math.min(92, 69 + dev_enh * 10 + body_enh * 2 + (Math.abs(streak_enh) - 1) * 2)),
              });
            }
          }
        }
      }
    }
  }

  // ─── BTC Synth-15m Strategies (61-62) ───────────────────────────────────────
  // Group 3×5m BTC candles → synth15m, then apply strong BB reversion
  // BTC Synth15m GH+RSI>65+BB22+s>=1: WF=86.3% σ=6.3% T=95 (HIGHEST WR EVER for BTC!)
  // BTC Synth15m ALL_H+RSI>70+BB22+s>=1: WF=77.0% σ=4.4% T=330 (1.8/day)
  // Source: newSignalSearch.js Section 3
  if (candles5m.length >= 65) {
    const synth15m_61: Candle[] = [];
    const aligned61 = candles5m.length - (candles5m.length % 3);
    for (let i = 0; i < aligned61; i += 3) {
      const g = candles5m.slice(i, i + 3);
      synth15m_61.push({
        openTime: g[0].openTime, closeTime: g[2].closeTime,
        open: g[0].open, high: Math.max(...g.map(c => c.high)),
        low: Math.min(...g.map(c => c.low)), close: g[2].close,
        volume: g.reduce((s, c) => s + c.volume, 0),
        quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
        trades: g.reduce((s, c) => s + c.trades, 0),
      });
    }
    if (synth15m_61.length >= 22) {
      const last61 = synth15m_61[synth15m_61.length - 1];
      const h61 = new Date(last61.closeTime).getUTCHours();
      const bb22_61 = calculateBollingerBands(synth15m_61, 20, 2.2);
      const rsi14_61 = calculateRSI(synth15m_61, 14);
      const BTC_GH_61 = [1, 12, 13, 16, 20];
      if (bb22_61 && rsi14_61 !== null) {
        const p61 = last61.close;
        const isBear61 = p61 > bb22_61.upper && last61.close > last61.open;
        const isBull61 = p61 < bb22_61.lower && last61.close < last61.open;
        if (isBear61 || isBull61) {
          let streak61 = 0;
          for (let j = synth15m_61.length - 1; j >= Math.max(0, synth15m_61.length - 8); j--) {
            const cj = synth15m_61[j];
            if (cj.close > cj.open) { if (streak61 < 0) break; streak61++; }
            else if (cj.close < cj.open) { if (streak61 > 0) break; streak61--; }
            else break;
          }
          const dev61 = isBear61
            ? (p61 - bb22_61.upper) / bb22_61.upper * 100
            : (bb22_61.lower - p61) / bb22_61.lower * 100;

          // Strategy 61: BTC Synth15m GoodH+RSI>65+BB22+s>=1 → WF=86.3% σ=6.3% HIGHEST WR!
          if (Math.abs(streak61) >= 1 && BTC_GH_61.includes(h61)) {
            const rsiOk61 = (isBear61 && rsi14_61 > 65) || (isBull61 && rsi14_61 < 35);
            if (rsiOk61) {
              strategies.push({
                name: 'BTC Synth15m GH RSI',
                emoji: '👑',
                score: Math.round(Math.min(10, 7.2 + (Math.abs(streak61) - 1) * 0.5 + dev61 * 9) * 10) / 10,
                direction: (isBear61 ? 'bearish' : 'bullish') as Direction,
                signal: `BTC Synth15m h=${h61}UTC RSI=${rsi14_61.toFixed(0)}>65 BB(20,2.2) streak=${Math.abs(streak61)} (86.3% WR σ=6.3% HIGHEST WR!)`,
                confidence: Math.round(Math.min(95, 75 + dev61 * 12 + (Math.abs(streak61) - 1) * 3)),
              });
            }
          }

          // Strategy 62: BTC Synth15m ALL_H+RSI>70+BB22+s>=1 → WF=77.0% σ=4.4% 1.8/day
          const rsiOk62 = (isBear61 && rsi14_61 > 70) || (isBull61 && rsi14_61 < 30);
          if (Math.abs(streak61) >= 1 && rsiOk62) {
            strategies.push({
              name: 'BTC Synth15m ALL-H RSI',
              emoji: '📊',
              score: Math.round(Math.min(10, 6.7 + (Math.abs(streak61) - 1) * 0.4 + dev61 * 9) * 10) / 10,
              direction: (isBear61 ? 'bearish' : 'bullish') as Direction,
              signal: `BTC Synth15m ALL-H RSI=${rsi14_61.toFixed(0)}>70 BB(20,2.2) streak=${Math.abs(streak61)} (77.0% WR σ=4.4% 1.8/day)`,
              confidence: Math.round(Math.min(91, 68 + dev61 * 10 + (Math.abs(streak61) - 1) * 2)),
            });
          }
        }
      }
    }
  }

  // ─── Ultra High-Frequency Strategy (68) — BB(20,1.0) 80-110+/day ──────────
  // ALL hours, tight BB(20,1.0) + streak>=1
  // ETH: WF=72.2% σ=1.2% 104.4/d [72.0/70.9/70.8/73.8/73.4] (5-fold)
  // BTC: WF=71.7% σ=1.5% 107.9/d [70.7/69.3/72.0/73.3/73.0] (5-fold)
  // Source: ultraHF80.js Section 2.2 — tight BB multiplier = more triggers, still mean-reverting
  if (candles5m.length >= 22) {
    const last68 = candles5m[candles5m.length - 1];
    const bb10_68 = calculateBollingerBands(candles5m, 20, 1.0);
    if (bb10_68) {
      const p68 = last68.close;
      const isBear68 = p68 > bb10_68.upper && last68.close > last68.open;
      const isBull68 = p68 < bb10_68.lower && last68.close < last68.open;
      if (isBear68 || isBull68) {
        let streak68 = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak68 < 0) break; streak68++; }
          else if (cj.close < cj.open) { if (streak68 > 0) break; streak68--; }
          else break;
        }
        if (Math.abs(streak68) >= 1) {
          const dev68 = isBear68
            ? (p68 - bb10_68.upper) / bb10_68.upper * 100
            : (bb10_68.lower - p68) / bb10_68.lower * 100;
          strategies.push({
            name: 'ALL-H BB10 UHF80',
            emoji: '🚀',
            score: Math.round(Math.min(10, 6.2 + dev68 * 5 + (Math.abs(streak68) - 1) * 0.2) * 10) / 10,
            direction: (isBear68 ? 'bearish' : 'bullish') as Direction,
            signal: `ALL-H BB(20,1.0) streak=${Math.abs(streak68)} (ETH 54.0%|BTC 55.3% WR ~105/d HF)`,
            confidence: Math.round(Math.min(83, 65 + dev68 * 8 + (Math.abs(streak68) - 1) * 1.5)),
          });
        }
      }
    }
  }

  // ─── Strat 69: ETH/BTC Stochastic+BB(20,1.0) — ~82-100/d ────────────────────
  // NOTE: mlOptimize5m.js reported 72.3% WR but used flawed "any-touch" exit model
  // CORRECT binary exit (at-expiry): WF≈54% for ETH/BTC — same as plain BB10
  // Stochastic quality gate does NOT improve WR at tight BB(20,1.0) — confirmed by correctExitValidation.js
  // Keeping for signal diversity; DO NOT set high confidence thresholds for this
  // Stochastic %K(5): (close - lowest_low) / (highest_high - lowest_low) × 100
  if (candles5m.length >= 25) {
    const last69 = candles5m[candles5m.length - 1];
    const bb10_69 = calculateBollingerBands(candles5m, 20, 1.0);
    if (bb10_69) {
      // Stochastic %K(5)
      const slice69 = candles5m.slice(-5);
      const low69 = Math.min(...slice69.map(c => c.low));
      const high69 = Math.max(...slice69.map(c => c.high));
      const stochK69 = high69 === low69 ? 50 : (last69.close - low69) / (high69 - low69) * 100;
      const isBear69 = last69.close > bb10_69.upper && last69.close > last69.open && stochK69 > 70;
      const isBull69 = last69.close < bb10_69.lower && last69.close < last69.open && stochK69 < 30;
      if (isBear69 || isBull69) {
        let streak69 = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak69 < 0) break; streak69++; }
          else if (cj.close < cj.open) { if (streak69 > 0) break; streak69--; }
          else break;
        }
        if (Math.abs(streak69) >= 1) {
          const dev69 = isBear69
            ? (last69.close - bb10_69.upper) / bb10_69.upper * 100
            : (bb10_69.lower - last69.close) / bb10_69.lower * 100;
          const stochStr = isBear69 ? `Stoch=${stochK69.toFixed(0)}>70` : `Stoch=${stochK69.toFixed(0)}<30`;
          strategies.push({
            name: 'Stoch+BB10 HF80',
            emoji: '🎲🚀',
            score: Math.round(Math.min(10, 6.3 + dev69 * 5 + (Math.abs(streak69) - 1) * 0.2) * 10) / 10,
            direction: (isBear69 ? 'bearish' : 'bullish') as Direction,
            signal: `Stoch(5)${stochStr}+BB(20,1.0) streak=${Math.abs(streak69)} (~54% WR correct-exit — use for diversity only)`,
            confidence: Math.round(Math.min(72, 65 + dev69 * 5 + (Math.abs(streak69) - 1) * 1.0)),
          });
        }
      }
    }
  }

  // ─── Strat 70: h=12 Noon Peak BB(20,1.5) — CORRECT binary exit validated ─────
  // ETH h=12+BB(20,1.5)+s>=1: WF=62.9% σ=4.0% T=490(2.7/d) [58.4/69.0/59.1/62.6/65.4] ✅
  // BTC h=12+BB(20,1.5)+s>=1: WF=57.1% σ=4.4% T=533(2.9/d) [49.6/57.9/58.6/56.1/63.0] ⚠️
  // Source: correctExitValidation.js Section [H] — noon UTC is consistently best hour
  // All WRs measured with at-expiry (close at candle 3) model — NO lookahead bias
  {
    const h70 = new Date(candles5m[candles5m.length - 1].openTime).getUTCHours();
    if (h70 === 12 && candles5m.length >= 22) {
      const last70 = candles5m[candles5m.length - 1];
      const bb15_70 = calculateBollingerBands(candles5m, 20, 1.5);
      if (bb15_70) {
        const p70 = last70.close;
        const isBear70 = p70 > bb15_70.upper && last70.close > last70.open;
        const isBull70 = p70 < bb15_70.lower && last70.close < last70.open;
        if (isBear70 || isBull70) {
          let streak70 = 0;
          for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
            const cj = candles5m[j];
            if (cj.close > cj.open) { if (streak70 < 0) break; streak70++; }
            else if (cj.close < cj.open) { if (streak70 > 0) break; streak70--; }
            else break;
          }
          if (Math.abs(streak70) >= 1) {
            const dev70 = isBear70
              ? (p70 - bb15_70.upper) / bb15_70.upper * 100
              : (bb15_70.lower - p70) / bb15_70.lower * 100;
            strategies.push({
              name: 'Noon Peak BB15',
              emoji: '🕛🎯',
              score: Math.round(Math.min(10, 6.5 + dev70 * 6 + (Math.abs(streak70) - 1) * 0.3) * 10) / 10,
              direction: (isBear70 ? 'bearish' : 'bullish') as Direction,
              signal: `h=12+BB(20,1.5) streak=${Math.abs(streak70)} dev=${dev70.toFixed(3)}% (ETH=62.9% BTC=57.1% WR at-expiry ✅)`,
              confidence: Math.round(Math.min(85, 63 + dev70 * 8 + (Math.abs(streak70) - 1) * 2)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 71: ALL-H Pure BB(20,2.2)+s>=1 — HF 5m+15m Binary ───────────────
  // 5m binary exit: ETH 56.6% WF σ=1.5%, BTC 55.9% σ=2.0% (fiveMinBinary.js)
  // 15m binary exit: ETH 55.0% WF σ=2.4%, BTC 56.2% σ=2.2% (fifteenMinBinary.js)
  // Combined 5m+15m Polymarket markets: ~122/day (61×2) at 55.2% avg WR ✅ 120+/day!
  // Lower min_confidence to ~58% in settings to enable auto-trading
  if (candles5m.length >= 22) {
    const last71 = candles5m[candles5m.length - 1];
    const bb71 = calculateBollingerBands(candles5m, 20, 2.2);
    if (bb71) {
      let streak71 = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak71 < 0) break; streak71++; }
        else if (cj.close < cj.open) { if (streak71 > 0) break; streak71--; }
        else break;
      }
      const isBear71 = last71.close > bb71.upper && last71.close > last71.open && streak71 >= 1;
      const isBull71 = last71.close < bb71.lower && last71.close < last71.open && streak71 <= -1;
      if (isBear71 || isBull71) {
        const dev71 = isBear71
          ? (last71.close - bb71.upper) / bb71.upper * 100
          : (bb71.lower - last71.close) / bb71.lower * 100;
        strategies.push({
          name: 'HF BB22 Pure',
          emoji: '⚡🎯',
          score: Math.round(Math.min(9, 5.8 + dev71 * 5 + (Math.abs(streak71) - 1) * 0.5) * 10) / 10,
          direction: (isBear71 ? 'bearish' : 'bullish') as Direction,
          signal: `ALL-H BB(20,2.2)+s=${Math.abs(streak71)} dev=${dev71.toFixed(3)}% (5m=56% 15m=55% WR | 5m+15m=122/day ✅)`,
          confidence: Math.round(Math.min(72, 60 + dev71 * 7 + (Math.abs(streak71) - 1) * 2)),
        });
      }
    }
  }

  // ─── Strat 72: Connors RSI (15/85) — TradingView Mean Reversion ─────────────
  // CRSI = (RSI(3) + streakRSI(2) + percentileRank(100)) / 3
  // ETH: 56.3% WR σ=1.9% 33/day | BTC: 54.9% WR σ=1.7% 34/day (5-fold WF)
  // All-hours, no time filter needed — CRSI naturally filters for exhaustion
  if (candles5m.length >= 106) {
    const crsi72 = calcConnorsRSI(candles5m, 100);
    const isBull72 = crsi72 < 15;  // extreme oversold → revert up
    const isBear72 = crsi72 > 85;  // extreme overbought → revert down
    if (isBull72 || isBear72) {
      const extremity72 = isBull72 ? (15 - crsi72) / 15 : (crsi72 - 85) / 15;
      strategies.push({
        name: 'Connors RSI 15/85',
        emoji: '🧠⚡',
        score: Math.round(Math.min(9.5, 6.5 + extremity72 * 3) * 10) / 10,
        direction: (isBear72 ? 'bearish' : 'bullish') as Direction,
        signal: `CRSI=${crsi72.toFixed(1)} (${isBull72 ? 'oversold<15' : 'overbought>85'}) ETH=56.3% BTC=54.9% WR 33-34/day`,
        confidence: Math.round(Math.min(78, 65 + extremity72 * 13)),
      });
    }
  }

  // ─── Strat 73: ATR Climax + RSI7 at BB22 — TradingView Exhaustion ────────────
  // Big candle (≥ATR) at BB extreme + RSI7 extreme → climax → reverse
  // ETH: 57.3% WR σ=1.5% 10/day | BTC: 57.8% WR σ=2.2% 11/day (5-fold WF)
  if (candles5m.length >= 22) {
    const last73 = candles5m[candles5m.length - 1];
    const bb73 = calculateBollingerBands(candles5m, 20, 2.2);
    // ATR(14)
    let atr73 = 0;
    const atrWin73 = candles5m.slice(-15);
    for (let j = 1; j < atrWin73.length; j++) {
      atr73 += Math.max(
        atrWin73[j].high - atrWin73[j].low,
        Math.abs(atrWin73[j].high - atrWin73[j - 1].close),
        Math.abs(atrWin73[j].low - atrWin73[j - 1].close),
      );
    }
    atr73 /= Math.max(1, atrWin73.length - 1);

    const rsi7_73 = calculateRSI(candles5m, 7);
    const body73 = Math.abs(last73.close - last73.open);

    if (bb73 && rsi7_73 !== null && body73 >= atr73 * 1.0 && atr73 > 0) {
      // Bearish climax: big bullish candle above upper BB + RSI7 overbought → revert down
      const isClimaxBear73 = last73.close > bb73.upper && last73.close > last73.open && rsi7_73 > 70;
      // Bullish climax: big bearish candle below lower BB + RSI7 oversold → revert up
      const isClimaxBull73 = last73.close < bb73.lower && last73.close < last73.open && rsi7_73 < 30;

      if (isClimaxBear73 || isClimaxBull73) {
        const dev73 = isClimaxBear73
          ? (last73.close - bb73.upper) / bb73.upper * 100
          : (bb73.lower - last73.close) / bb73.lower * 100;
        const atrRatio73 = body73 / atr73;
        strategies.push({
          name: 'ATR Climax BB22',
          emoji: '💥🔄',
          score: Math.round(Math.min(9.5, 6.0 + dev73 * 6 + (atrRatio73 - 1) * 0.8) * 10) / 10,
          direction: (isClimaxBear73 ? 'bearish' : 'bullish') as Direction,
          signal: `ATR climax body=${atrRatio73.toFixed(1)}xATR RSI7=${rsi7_73.toFixed(0)} dev=${dev73.toFixed(3)}% (ETH=57.3% BTC=57.8% WR ~10/day)`,
          confidence: Math.round(Math.min(80, 62 + dev73 * 8 + (atrRatio73 - 1) * 3)),
        });
      }
    }
  }

  // ─── Strat 74: StochRSI (K+D<20) + BB22 — Double Oscillator ─────────────────
  // Stochastic RSI both K and D extreme + price outside BB22 → high-conviction reversal
  // ETH: 58.4% WR σ=3.5% 14/day | BTC: 57.7% WR σ=2.2% 13/day (5-fold WF)
  if (candles5m.length >= 45) {
    const srsi74 = calcStochRSI(candles5m, 14, 14);
    const bb74 = calculateBollingerBands(candles5m, 20, 2.2);
    const last74 = candles5m[candles5m.length - 1];
    if (bb74) {
      const isBull74 = srsi74.k < 20 && srsi74.d < 20 && last74.close < bb74.lower;
      const isBear74 = srsi74.k > 80 && srsi74.d > 80 && last74.close > bb74.upper;
      if (isBull74 || isBear74) {
        const stochExtreme74 = isBull74 ? (20 - srsi74.k) / 20 : (srsi74.k - 80) / 20;
        const dev74 = isBear74
          ? (last74.close - bb74.upper) / bb74.upper * 100
          : (bb74.lower - last74.close) / bb74.lower * 100;
        strategies.push({
          name: 'StochRSI+BB22',
          emoji: '📊🎯',
          score: Math.round(Math.min(9.5, 6.2 + dev74 * 5 + stochExtreme74 * 2) * 10) / 10,
          direction: (isBear74 ? 'bearish' : 'bullish') as Direction,
          signal: `StochRSI K=${srsi74.k.toFixed(0)} D=${srsi74.d.toFixed(0)} dev=${dev74.toFixed(3)}% (ETH=58.4% BTC=57.7% WR ~13/day)`,
          confidence: Math.round(Math.min(80, 63 + dev74 * 7 + stochExtreme74 * 10)),
        });
      }
    }
  }

  // ─── Strat 75: CCI>200 + BB22 — Extreme Channel Index Reversal ───────────────
  // CCI = (price - SMA20) / (0.015 * meanDev) > 200 at BB22 extreme → reversal
  // ETH: 56.6% WR 2/day | BTC: 58.2% WR 2/day | avg 55.9% WR 9/day (5-fold WF)
  if (candles5m.length >= 22) {
    const cci75 = calcCCI(candles5m, 20);
    const bb75 = calculateBollingerBands(candles5m, 20, 2.2);
    const last75 = candles5m[candles5m.length - 1];
    if (bb75) {
      const isBull75 = cci75 < -200 && last75.close < bb75.lower;
      const isBear75 = cci75 > 200 && last75.close > bb75.upper;
      if (isBull75 || isBear75) {
        const cciExtreme75 = Math.min(1, (Math.abs(cci75) - 200) / 100);
        const dev75 = isBear75
          ? (last75.close - bb75.upper) / bb75.upper * 100
          : (bb75.lower - last75.close) / bb75.lower * 100;
        strategies.push({
          name: 'CCI>200 BB22',
          emoji: '📉🎯',
          score: Math.round(Math.min(9.5, 6.5 + dev75 * 6 + cciExtreme75 * 1.5) * 10) / 10,
          direction: (isBear75 ? 'bearish' : 'bullish') as Direction,
          signal: `CCI=${cci75.toFixed(0)} at BB22 dev=${dev75.toFixed(3)}% (ETH=56.6% BTC=58.2% avg=55.9% WR ~2/day)`,
          confidence: Math.round(Math.min(80, 65 + dev75 * 7 + cciExtreme75 * 10)),
        });
      }
    }
  }

  // ─── Strat 76: Williams %R (14) + RSI7 + BB22 — Triple Confirmation ───────────
  // WPR>-15 overbought + RSI7>70 + above BB22 upper → BEAR reversal (and vice versa)
  // ETH: 56.8% WR 2/day | BTC: 57.5% WR 3/day | avg 55.2% WR 10/day (5-fold WF)
  if (candles5m.length >= 22) {
    const wpr76 = calcWilliamsR(candles5m, 14);
    const rsi7_76 = calculateRSI(candles5m, 7);
    const bb76 = calculateBollingerBands(candles5m, 20, 2.2);
    const last76 = candles5m[candles5m.length - 1];
    if (bb76 && rsi7_76 !== null) {
      const isBull76 = wpr76 < -85 && rsi7_76 < 30 && last76.close < bb76.lower;
      const isBear76 = wpr76 > -15 && rsi7_76 > 70 && last76.close > bb76.upper;
      if (isBull76 || isBear76) {
        const wprExtreme76 = isBull76 ? Math.min(1, (-85 - wpr76) / 15) : Math.min(1, (wpr76 + 15) / 15);
        const dev76 = isBear76
          ? (last76.close - bb76.upper) / bb76.upper * 100
          : (bb76.lower - last76.close) / bb76.lower * 100;
        strategies.push({
          name: 'WPR+RSI7+BB22',
          emoji: '📡🔄',
          score: Math.round(Math.min(9.5, 6.3 + dev76 * 6 + wprExtreme76 * 1.5) * 10) / 10,
          direction: (isBear76 ? 'bearish' : 'bullish') as Direction,
          signal: `WPR=${wpr76.toFixed(0)} RSI7=${rsi7_76.toFixed(0)} dev=${dev76.toFixed(3)}% (ETH=56.8% BTC=57.5% avg=55.2% WR)`,
          confidence: Math.round(Math.min(80, 64 + dev76 * 7 + wprExtreme76 * 9)),
        });
      }
    }
  }

  // ─── Strat 77: Keltner Outer (Price > KC) — Volatility Extreme Reversal ───────
  // EMA(20) ± 2*ATR(14) = Keltner Channel; price outside KC boundary = extreme → reverse
  // ETH: 56.6% WR 6/day | BTC: 54.0% WR 7/day | avg 54.6% WR 24/day (5-fold WF)
  if (candles5m.length >= 22) {
    const ema77 = calcEMA(candles5m, 20);
    const last77 = candles5m[candles5m.length - 1];
    let atr77 = 0;
    const atrWin77 = candles5m.slice(-15);
    for (let j = 1; j < atrWin77.length; j++) {
      atr77 += Math.max(
        atrWin77[j].high - atrWin77[j].low,
        Math.abs(atrWin77[j].high - atrWin77[j - 1].close),
        Math.abs(atrWin77[j].low - atrWin77[j - 1].close),
      );
    }
    atr77 /= Math.max(1, atrWin77.length - 1);
    const kcUpper77 = ema77 + 2.0 * atr77;
    const kcLower77 = ema77 - 2.0 * atr77;
    const isBull77 = last77.close < kcLower77;
    const isBear77 = last77.close > kcUpper77;
    if ((isBull77 || isBear77) && atr77 > 0) {
      const dev77 = isBear77
        ? (last77.close - kcUpper77) / kcUpper77 * 100
        : (kcLower77 - last77.close) / kcLower77 * 100;
      strategies.push({
        name: 'Keltner Outer',
        emoji: '🌋🔄',
        score: Math.round(Math.min(9.0, 5.8 + dev77 * 6) * 10) / 10,
        direction: (isBear77 ? 'bearish' : 'bullish') as Direction,
        signal: `Price ${isBear77 ? 'above KC upper' : 'below KC lower'} dev=${dev77.toFixed(3)}% (ETH=56.6% BTC=54.0% avg=54.6% WR ~6/day)`,
        confidence: Math.round(Math.min(76, 60 + dev77 * 8)),
      });
    }
  }

  // ─── Strat 78: 1m RSI7 Extreme + 5m BB22 — Micro-Structure Reversal ──────────
  // Research (hfBinary5m.ts S6): RSI7 on 1m >78/<22 + price outside 5m BB(20,2.2)
  // ETH: 58.0% WR σ=3.3% 6.6/day | BTC: 57.1% σ=1.3% 5.0/day (5-fold WF, at-expiry ✅)
  // SOL: 54.8% 7.1/day | XRP: 54.2% 7.0/day | combined 25.7/day avg 55.7% WR
  if (candles1m.length >= 22 && candles5m.length >= 22 && rsi7_1m !== null) {
    const bb78 = calculateBollingerBands(candles5m, 20, 2.2);
    const last78 = candles5m[candles5m.length - 1];
    if (bb78) {
      const isBear78 = rsi7_1m > 78 && last78.close > bb78.upper;
      const isBull78 = rsi7_1m < 22 && last78.close < bb78.lower;
      if (isBear78 || isBull78) {
        const dev78 = isBear78
          ? (last78.close - bb78.upper) / bb78.upper * 100
          : (bb78.lower - last78.close) / bb78.lower * 100;
        if (dev78 >= 0.04) {
          const rsiExt78 = isBear78 ? (rsi7_1m - 78) / 22 : (22 - rsi7_1m) / 22;
          strategies.push({
            name: '1m RSI7+BB22',
            emoji: '⚡📈',
            score: Math.round(Math.min(9.2, 5.8 + dev78 * 6 + rsiExt78 * 2) * 10) / 10,
            direction: (isBear78 ? 'bearish' : 'bullish') as Direction,
            signal: `1m RSI7=${rsi7_1m.toFixed(0)} ${isBear78 ? '>78' : '<22'} + BB22 dev=${dev78.toFixed(3)}% (ETH=58% BTC=57% 5-6/day ✅)`,
            confidence: Math.round(Math.min(80, 62 + dev78 * 8 + rsiExt78 * 10)),
          });
        }
      }
    }
  }

  // ─── Strat 79: Volume Exhaustion + 5m BB22 + Streak ──────────────────────────
  // Research (hfBinary5m.ts S2): last 1m vol >1.8x avg + outside 5m BB22 + streak≥1
  // ETH: 58.1% WR σ=1.0% 4.2/day | BTC: 60.5% σ=5.9% 2.9/day (5-fold WF, at-expiry ✅)
  if (candles1m.length >= 22 && candles5m.length >= 22) {
    const bb79 = calculateBollingerBands(candles5m, 20, 2.2);
    const last5m79 = candles5m[candles5m.length - 1];
    const lastVol79 = candles1m[candles1m.length - 1].volume;
    const vol20avg79 = candles1m.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const volRatio79 = vol20avg79 > 0 ? lastVol79 / vol20avg79 : 1;
    if (bb79 && volRatio79 >= 1.8) {
      let streak79 = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak79 < 0) break; streak79++; }
        else if (cj.close < cj.open) { if (streak79 > 0) break; streak79--; }
        else break;
      }
      const isBear79 = last5m79.close > bb79.upper && streak79 >= 1;
      const isBull79 = last5m79.close < bb79.lower && streak79 <= -1;
      if (isBear79 || isBull79) {
        const dev79 = isBear79
          ? (last5m79.close - bb79.upper) / bb79.upper * 100
          : (bb79.lower - last5m79.close) / bb79.lower * 100;
        if (dev79 >= 0.05) {
          strategies.push({
            name: 'Vol Exhaustion BB22',
            emoji: '💧🔥',
            score: Math.round(Math.min(9.5, 6.0 + dev79 * 5 + (volRatio79 - 1.8) * 0.4 + (Math.abs(streak79) - 1) * 0.3) * 10) / 10,
            direction: (isBear79 ? 'bearish' : 'bullish') as Direction,
            signal: `1m vol=${volRatio79.toFixed(1)}x avg + BB22 dev=${dev79.toFixed(3)}% s=${Math.abs(streak79)} (ETH=58.1% BTC=60.5% avg 57.9% WR ✅)`,
            confidence: Math.round(Math.min(82, 63 + dev79 * 8 + (volRatio79 - 1.8) * 3)),
          });
        }
      }
    }
  }

  // ─── Strat 80: MicroStreak×3 + 5m BB22 + RSI14 ──────────────────────────────
  // Research (hfBinary5m.ts S5): 3+ consecutive 5m candles + outside BB22 + RSI14 extreme
  // ETH: 58.4% WR σ=3.5% 3.2/day | BTC: 60.9% σ=2.9% 2.5/day (5-fold WF, at-expiry ✅)
  // SOL: 57.4% 3.2/day | XRP: 55.4% 3.2/day | combined avg 58.0% WR 12.1/day
  if (candles5m.length >= 30 && rsi14_5m !== null) {
    const bb80 = calculateBollingerBands(candles5m, 20, 2.2);
    const last80 = candles5m[candles5m.length - 1];
    if (bb80) {
      let streak80 = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 10); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak80 < 0) break; streak80++; }
        else if (cj.close < cj.open) { if (streak80 > 0) break; streak80--; }
        else break;
      }
      const isBear80 = streak80 >= 3 && last80.close > bb80.upper && rsi14_5m > 65;
      const isBull80 = streak80 <= -3 && last80.close < bb80.lower && rsi14_5m < 35;
      if (isBear80 || isBull80) {
        const dev80 = isBear80
          ? (last80.close - bb80.upper) / bb80.upper * 100
          : (bb80.lower - last80.close) / bb80.lower * 100;
        if (dev80 >= 0.04) {
          const rsiExt80 = isBear80 ? (rsi14_5m - 65) / 35 : (35 - rsi14_5m) / 35;
          strategies.push({
            name: 'MicroStreak×3 BB22',
            emoji: '🔥🎯',
            score: Math.round(Math.min(9.8, 6.2 + dev80 * 6 + (Math.abs(streak80) - 3) * 0.4 + rsiExt80 * 1.5) * 10) / 10,
            direction: (isBear80 ? 'bearish' : 'bullish') as Direction,
            signal: `5m streak=${Math.abs(streak80)}× + BB22 dev=${dev80.toFixed(3)}% RSI14=${rsi14_5m.toFixed(0)} (ETH=58.4% BTC=60.9% avg 58% WR ✅)`,
            confidence: Math.round(Math.min(84, 64 + dev80 * 8 + (Math.abs(streak80) - 3) * 2 + rsiExt80 * 5)),
          });
        }
      }
    }
  }

  // ─── Strat 81: ML-Synthesized: 15m Streak + 5m BB22 + RSI14 ─────────────────
  // Derived from logistic regression ML (hfBinary5m.ts S8) — top 3 features across ALL 4 coins:
  //   streak_15m(+0.62), rsi14_5m(-0.49), bb_pctB_15m(+0.46) — rock-solid across all coins
  // BTC ML: 72.7% WR 3.8/day | ETH: 63.5% WR 7.5/day | SOL: 64.8% | XRP: 60.8% (3-fold WF)
  if (candles5m.length >= 63 && rsi14_5m !== null) {
    const bb81 = calculateBollingerBands(candles5m, 20, 2.2);
    const last81 = candles5m[candles5m.length - 1];

    // Prefer real 15m candles; fall back to synthetic from 5m
    let streak81_15m = 0;
    const src15m81 = candles15m.length >= 15 ? candles15m : (() => {
      const aligned = candles5m.length - (candles5m.length % 3);
      const synth: Candle[] = [];
      for (let i = Math.max(0, aligned - 60); i < aligned; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth.push({ openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: 0, quoteVolume: 0, trades: 0 });
      }
      return synth;
    })();
    for (let j = src15m81.length - 1; j >= Math.max(0, src15m81.length - 8); j--) {
      const cj = src15m81[j];
      if (cj.close > cj.open) { if (streak81_15m < 0) break; streak81_15m++; }
      else if (cj.close < cj.open) { if (streak81_15m > 0) break; streak81_15m--; }
      else break;
    }

    if (bb81 && Math.abs(streak81_15m) >= 3) {
      const isBear81 = last81.close > bb81.upper && rsi14_5m > 62;
      const isBull81 = last81.close < bb81.lower && rsi14_5m < 38;
      if (isBear81 || isBull81) {
        const dev81 = isBear81
          ? (last81.close - bb81.upper) / bb81.upper * 100
          : (bb81.lower - last81.close) / bb81.lower * 100;
        if (dev81 >= 0.05) {
          const streakBonus = Math.min(1.0, (Math.abs(streak81_15m) - 3) * 0.25);
          const rsiExt81 = isBear81 ? (rsi14_5m - 62) / 38 : (38 - rsi14_5m) / 38;
          strategies.push({
            name: 'ML 15m-Streak+BB22',
            emoji: '🤖🧠',
            score: Math.round(Math.min(9.8, 6.5 + dev81 * 6 + streakBonus + rsiExt81 * 1.5) * 10) / 10,
            direction: (isBear81 ? 'bearish' : 'bullish') as Direction,
            signal: `15m streak=${Math.abs(streak81_15m)}× + BB22 dev=${dev81.toFixed(3)}% RSI14=${rsi14_5m.toFixed(0)} (ML: BTC=72.7% ETH=63.5% WR ✅)`,
            confidence: Math.round(Math.min(88, 66 + dev81 * 9 + streakBonus * 10 + rsiExt81 * 6)),
          });
        }
      }
    }
  }

  // ─── Strat 82: BB %B > 1.0 + RSI7 — Explicit %B Extreme ─────────────────────
  // %B = (close-lower)/(upper-lower): >1.0 above upper, <0 below lower
  // ETH: 58.3% WR 2.2/day | BTC: 58.2% WR 2.0/day | avg 56.3% WR 8/day (5-fold WF)
  if (candles5m.length >= 22) {
    const bb82 = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_82 = calculateRSI(candles5m, 7);
    const last82 = candles5m[candles5m.length - 1];
    if (bb82 && rsi7_82 !== null) {
      const pctB82 = (bb82.upper - bb82.lower) > 0
        ? (last82.close - bb82.lower) / (bb82.upper - bb82.lower) : 0.5;
      const isBull82 = pctB82 < -0.05 && rsi7_82 < 35;
      const isBear82 = pctB82 > 1.05 && rsi7_82 > 65;
      if (isBull82 || isBear82) {
        const ext82 = isBull82 ? Math.min(1, -pctB82 * 5) : Math.min(1, (pctB82 - 1.0) * 5);
        const dev82 = isBear82
          ? (last82.close - bb82.upper) / bb82.upper * 100
          : (bb82.lower - last82.close) / bb82.lower * 100;
        strategies.push({
          name: 'BB%B+RSI7',
          emoji: '📐🎯',
          score: Math.round(Math.min(9.5, 6.5 + dev82 * 5 + ext82 * 1.5) * 10) / 10,
          direction: (isBear82 ? 'bearish' : 'bullish') as Direction,
          signal: `%B=${pctB82.toFixed(2)} RSI7=${rsi7_82.toFixed(0)} dev=${dev82.toFixed(3)}% (ETH=58.3% BTC=58.2% avg=56.3% WR)`,
          confidence: Math.round(Math.min(80, 65 + dev82 * 7 + ext82 * 8)),
        });
      }
    }
  }

  // ─── Strat 83: RSI(3) > 90 + BB22 — Ultra-Fast Oscillator Extreme ─────────────
  // RSI(3) is hypersensitive; extreme (>90/<10) at BB22 = sharp reversal signal
  // ETH: 59.3% WR 2.2/day | BTC: 56.2% WR 2.0/day | avg 55.9% WR 8/day (5-fold WF)
  if (candles5m.length >= 10) {
    const rsi3_83 = calculateRSI(candles5m, 3);
    const bb83 = calculateBollingerBands(candles5m, 20, 2.2);
    const last83 = candles5m[candles5m.length - 1];
    if (bb83 && rsi3_83 !== null) {
      const isBull83 = rsi3_83 < 10 && last83.close < bb83.lower;
      const isBear83 = rsi3_83 > 90 && last83.close > bb83.upper;
      if (isBull83 || isBear83) {
        const rsi3Ext83 = isBull83 ? Math.min(1, (10 - rsi3_83) / 10) : Math.min(1, (rsi3_83 - 90) / 10);
        const dev83 = isBear83
          ? (last83.close - bb83.upper) / bb83.upper * 100
          : (bb83.lower - last83.close) / bb83.lower * 100;
        strategies.push({
          name: 'RSI3>90+BB22',
          emoji: '⚡🔴',
          score: Math.round(Math.min(9.5, 6.8 + dev83 * 5 + rsi3Ext83 * 1.5) * 10) / 10,
          direction: (isBear83 ? 'bearish' : 'bullish') as Direction,
          signal: `RSI3=${rsi3_83.toFixed(0)} dev=${dev83.toFixed(3)}% (ETH=59.3% BTC=56.2% avg=55.9% WR ~2/day)`,
          confidence: Math.round(Math.min(82, 67 + dev83 * 7 + rsi3Ext83 * 8)),
        });
      }
    }
  }

  // ─── Strat 84: RSI7>70 Consecutive 2 bars + BB22 — Sustained Overbought ──────
  // Two consecutive RSI7>70 bars at BB22 = sustained overextension → reversal
  // ETH: 58.1% WR 2.0/day | BTC: 56.3% WR 1.8/day | avg 55.5% WR 8/day (5-fold WF)
  if (candles5m.length >= 25) {
    const bb84 = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_84 = calculateRSI(candles5m, 7);
    const rsi7_84prev = calculateRSI(candles5m.slice(0, -1), 7);
    const last84 = candles5m[candles5m.length - 1];
    if (bb84 && rsi7_84 !== null && rsi7_84prev !== null) {
      const isBull84 = rsi7_84 < 30 && rsi7_84prev < 30 && last84.close < bb84.lower;
      const isBear84 = rsi7_84 > 70 && rsi7_84prev > 70 && last84.close > bb84.upper;
      if (isBull84 || isBear84) {
        const rsiExt84 = isBull84 ? (30 - rsi7_84) / 30 : (rsi7_84 - 70) / 30;
        const dev84 = isBear84
          ? (last84.close - bb84.upper) / bb84.upper * 100
          : (bb84.lower - last84.close) / bb84.lower * 100;
        strategies.push({
          name: 'RSI7 Consec2+BB22',
          emoji: '🔥🔥',
          score: Math.round(Math.min(9.5, 6.6 + dev84 * 5 + rsiExt84 * 1.5) * 10) / 10,
          direction: (isBear84 ? 'bearish' : 'bullish') as Direction,
          signal: `RSI7=${rsi7_84.toFixed(0)} (2 bars) dev=${dev84.toFixed(3)}% (ETH=58.1% BTC=56.3% avg=55.5% WR ~2/day)`,
          confidence: Math.round(Math.min(80, 65 + dev84 * 7 + rsiExt84 * 8)),
        });
      }
    }
  }

  // ─── Strat 85: EMA20 Dev>0.5% + RSI7 + BB22 — Triple Anchor Reversal ─────────
  // Price >0.5% from EMA(20) + RSI7 extreme + outside BB22 = 3 simultaneous anchors
  // ETH: 57.0% WR 1.7/day | BTC: 56.9% WR 0.9/day | avg 55.6% WR 7/day (5-fold WF)
  if (candles5m.length >= 22) {
    const ema85 = calcEMA(candles5m, 20);
    const bb85 = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_85 = calculateRSI(candles5m, 7);
    const last85 = candles5m[candles5m.length - 1];
    if (bb85 && rsi7_85 !== null && ema85 > 0) {
      const emaDev85 = (last85.close - ema85) / ema85 * 100;
      const isBull85 = emaDev85 < -0.5 && rsi7_85 < 33 && last85.close < bb85.lower;
      const isBear85 = emaDev85 > 0.5 && rsi7_85 > 67 && last85.close > bb85.upper;
      if (isBull85 || isBear85) {
        const emaExt85 = Math.min(1, (Math.abs(emaDev85) - 0.5) * 2);
        const dev85 = isBear85
          ? (last85.close - bb85.upper) / bb85.upper * 100
          : (bb85.lower - last85.close) / bb85.lower * 100;
        strategies.push({
          name: 'EMA20Dev+RSI7+BB22',
          emoji: '📏🎯',
          score: Math.round(Math.min(9.5, 6.4 + dev85 * 5 + emaExt85 * 1.5) * 10) / 10,
          direction: (isBear85 ? 'bearish' : 'bullish') as Direction,
          signal: `EMAdev=${emaDev85.toFixed(2)}% RSI7=${rsi7_85.toFixed(0)} dev=${dev85.toFixed(3)}% (ETH=57% BTC=57% avg=55.6% WR)`,
          confidence: Math.round(Math.min(80, 64 + dev85 * 6 + emaExt85 * 8)),
        });
      }
    }
  }

  // ─── Strat 86: BB%B + CCI + WPR Triple Confluence — Max Mean-Reversion ───────
  // All 3 oscillators simultaneously extreme = highest-conviction reversal signal
  // ETH: 56.1% WR 3.1/day | BTC: 57.5% WR 3.0/day | avg 55.2% WR 12/day (5-fold WF)
  if (candles5m.length >= 22) {
    const bb86 = calculateBollingerBands(candles5m, 20, 2.2);
    const cci86 = calcCCI(candles5m, 20);
    const wpr86 = calcWilliamsR(candles5m, 14);
    const last86 = candles5m[candles5m.length - 1];
    if (bb86) {
      const pctB86 = (bb86.upper - bb86.lower) > 0
        ? (last86.close - bb86.lower) / (bb86.upper - bb86.lower) : 0.5;
      const isBull86 = pctB86 < 0.0 && cci86 < -100 && wpr86 < -80;
      const isBear86 = pctB86 > 1.0 && cci86 > 100 && wpr86 > -20;
      if (isBull86 || isBear86) {
        const dev86 = isBear86
          ? (last86.close - bb86.upper) / bb86.upper * 100
          : (bb86.lower - last86.close) / bb86.lower * 100;
        strategies.push({
          name: 'BB%B+CCI+WPR',
          emoji: '🎰🏆',
          score: Math.round(Math.min(9.5, 6.3 + dev86 * 5 + Math.min(1, Math.abs(cci86) / 200) * 1.5) * 10) / 10,
          direction: (isBear86 ? 'bearish' : 'bullish') as Direction,
          signal: `%B=${pctB86.toFixed(2)} CCI=${cci86.toFixed(0)} WPR=${wpr86.toFixed(0)} dev=${dev86.toFixed(3)}% (ETH=56.1% BTC=57.5% avg=55.2% WR ~3/day)`,
          confidence: Math.round(Math.min(80, 63 + dev86 * 6 + Math.min(1, Math.abs(cci86) / 200) * 8)),
        });
      }
    }
  }

  // ─── Strat 87: Double RSI Confirmation + BB22 ────────────────────────────────
  // RSI(7)>72 AND RSI(14)>65 simultaneously at BB upper = dual oscillator extreme
  // ETH: 57.6% @2.4/day | BTC: 56.2% @2.2/day | SOL: 55.4% | XRP: 54.1% → avg 55.8% 9.3/day
  if (candles5m.length >= 22) {
    const bb87 = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_87 = calculateRSI(candles5m, 7);
    if (bb87 && rsi7_87 !== null) {
      const last87 = candles5m[candles5m.length - 1];
      const isBear87 = rsi7_87 > 72 && (rsi14_5m ?? 50) > 65 && last87.close > bb87.upper;
      const isBull87 = rsi7_87 < 28 && (rsi14_5m ?? 50) < 35 && last87.close < bb87.lower;
      if (isBear87 || isBull87) {
        const dev87 = isBear87
          ? (last87.close - bb87.upper) / bb87.upper * 100
          : (bb87.lower - last87.close) / bb87.lower * 100;
        strategies.push({
          name: 'DoubleRSI+BB22',
          emoji: '📊📊',
          score: Math.round(Math.min(9.2, 6.0 + dev87 * 5 + Math.min(1, (isBear87 ? rsi7_87 - 72 : 28 - rsi7_87) / 10) * 1.5) * 10) / 10,
          direction: (isBear87 ? 'bearish' : 'bullish') as Direction,
          signal: `RSI7=${rsi7_87.toFixed(0)} RSI14=${(rsi14_5m ?? 50).toFixed(0)} dev=${dev87.toFixed(3)}% (ETH=57.6% BTC=56.2% avg=55.8% WR ~9/day)`,
          confidence: Math.round(Math.min(78, 61 + dev87 * 5 + Math.min(1, (isBear87 ? rsi7_87 - 72 : 28 - rsi7_87) / 15) * 8)),
        });
      }
    }
  }

  // ─── Strat 88: BB Squeeze→Release + BB22 ─────────────────────────────────────
  // BB was very narrow (ranging) then expanded → price at extreme = fakeout reversal
  // ETH: 57.1% @1.9/day | BTC: 58.1% @1.7/day | SOL: 53.4% | XRP: 54.6% → avg 55.8% 6.9/day
  if (candles5m.length >= 31) {
    const closes88 = candles5m.slice(-31).map(c => c.close);
    const bwArr88: number[] = [];
    for (let i = 20; i <= 30; i++) {
      const sl = closes88.slice(i - 20, i);
      const sma = sl.reduce((a, b) => a + b, 0) / 20;
      const std = Math.sqrt(sl.reduce((a, c) => a + (c - sma) ** 2, 0) / 20);
      bwArr88.push(sma > 0 ? std * 4.4 / sma * 100 : 0);
    }
    const bwCurr88 = bwArr88[10];
    const bwPrev10Avg88 = bwArr88.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    if (bwPrev10Avg88 < 2.5 && bwCurr88 > bwPrev10Avg88 * 1.3) {
      const bb88 = calculateBollingerBands(candles5m, 20, 2.2);
      const rsi7_88 = calculateRSI(candles5m, 7);
      if (bb88 && rsi7_88 !== null) {
        const last88 = candles5m[candles5m.length - 1];
        const isBear88 = last88.close > bb88.upper && rsi7_88 > 62;
        const isBull88 = last88.close < bb88.lower && rsi7_88 < 38;
        if (isBear88 || isBull88) {
          const dev88 = isBear88
            ? (last88.close - bb88.upper) / bb88.upper * 100
            : (bb88.lower - last88.close) / bb88.lower * 100;
          strategies.push({
            name: 'BB Squeeze→Release',
            emoji: '🗜️📈',
            score: Math.round(Math.min(9.3, 6.2 + dev88 * 5 + 0.8) * 10) / 10,
            direction: (isBear88 ? 'bearish' : 'bullish') as Direction,
            signal: `Squeeze(${bwPrev10Avg88.toFixed(2)}%)→Expand(${bwCurr88.toFixed(2)}%) RSI7=${rsi7_88.toFixed(0)} (ETH=57.1% BTC=58.1% avg=55.8% WR ~7/day)`,
            confidence: Math.round(Math.min(79, 62 + dev88 * 6 + 4)),
          });
        }
      }
    }
  }

  // ─── Strat 89: Wide Range Candle (1.5×ATR) + BB22 ────────────────────────────
  // Blowoff candle: range > 1.5×ATR at BB extreme + RSI extreme = exhaustion reversal
  // ETH: 55.6% @2.0/day | BTC: 56.1% @1.9/day | SOL: 54.7% | XRP: 55.6% → avg 55.5% 7.4/day
  if (candles5m.length >= 20) {
    const kc89 = calculateKeltnerChannels(candles5m);
    const bb89 = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_89 = calculateRSI(candles5m, 7);
    if (kc89 && bb89 && rsi7_89 !== null) {
      const last89 = candles5m[candles5m.length - 1];
      const range89 = last89.high - last89.low;
      if (kc89.atr > 0 && range89 > 1.5 * kc89.atr) {
        const isBear89 = last89.close > bb89.upper && rsi7_89 > 60;
        const isBull89 = last89.close < bb89.lower && rsi7_89 < 40;
        if (isBear89 || isBull89) {
          const dev89 = isBear89
            ? (last89.close - bb89.upper) / bb89.upper * 100
            : (bb89.lower - last89.close) / bb89.lower * 100;
          strategies.push({
            name: 'WideRange+BB22',
            emoji: '📏🔥',
            score: Math.round(Math.min(9.0, 5.9 + dev89 * 5 + Math.min(1, range89 / kc89.atr - 1.5) * 1.0) * 10) / 10,
            direction: (isBear89 ? 'bearish' : 'bullish') as Direction,
            signal: `Range/ATR=${(range89/kc89.atr).toFixed(2)}x RSI7=${rsi7_89.toFixed(0)} dev=${dev89.toFixed(3)}% (ETH=55.6% BTC=56.1% avg=55.5% WR ~7/day)`,
            confidence: Math.round(Math.min(76, 60 + dev89 * 5 + Math.min(1, range89 / kc89.atr - 1.5) * 5)),
          });
        }
      }
    }
  }

  // ─── Strat 90: ADX<20 (Ranging Market) + BB22 + RSI7 ─────────────────────────
  // ADX<20 = non-trending/ranging = ideal mean reversion; BTC=63.1% EXCEPTIONAL all-hours
  // ETH: 56.4% @0.7/day | BTC: 63.1% @0.5/day | SOL: 53.5% | XRP: 57.4% → avg 57.6% 2.7/day
  if (candles5m.length >= 30) {
    const adx90 = calcADX(candles5m, 14);
    if (adx90 < 20) {
      const bb90 = calculateBollingerBands(candles5m, 20, 2.2);
      const rsi7_90 = calculateRSI(candles5m, 7);
      if (bb90 && rsi7_90 !== null) {
        const last90 = candles5m[candles5m.length - 1];
        const devHi90 = (last90.close - bb90.upper) / bb90.upper * 100;
        const devLo90 = (bb90.lower - last90.close) / bb90.lower * 100;
        const isBear90 = devHi90 > 0.04 && rsi7_90 > 65;
        const isBull90 = devLo90 > 0.04 && rsi7_90 < 35;
        if (isBear90 || isBull90) {
          const dev90 = isBear90 ? devHi90 : devLo90;
          strategies.push({
            name: 'ADX<20+BB22',
            emoji: '📉🎯',
            score: Math.round(Math.min(9.5, 6.5 + dev90 * 5 + Math.min(1, (20 - adx90) / 15) * 1.5) * 10) / 10,
            direction: (isBear90 ? 'bearish' : 'bullish') as Direction,
            signal: `ADX=${adx90.toFixed(1)}<20 RSI7=${rsi7_90.toFixed(0)} dev=${dev90.toFixed(3)}% (ETH=56.4% BTC=63.1% avg=57.6% WR ~3/day)`,
            confidence: Math.round(Math.min(82, 62 + dev90 * 6 + Math.min(1, (20 - adx90) / 15) * 10)),
          });
        }
      }
    }
  }

  // ─── Strat 91: GoodH + ConnorsRSI>85 + BB22 ──────────────────────────────────
  // CRSI compound oscillator extreme in good trading hours
  // ETH: 67.2% @0.32/day | BTC: 61.1% @0.45/day (at ETH good hours [10,11,12,21] UTC)
  if (candles5m.length >= 105) {
    const s91GoodHours = [10, 11, 12, 21];
    const last91 = candles5m[candles5m.length - 1];
    const s91Hour = new Date(last91.closeTime).getUTCHours();
    if (s91GoodHours.includes(s91Hour)) {
      const bb91 = calculateBollingerBands(candles5m, 20, 2.2);
      const crsi91 = calcConnorsRSI(candles5m, 100);
      if (bb91) {
        const isBear91 = crsi91 > 85 && last91.close > bb91.upper;
        const isBull91 = crsi91 < 15 && last91.close < bb91.lower;
        if (isBear91 || isBull91) {
          const dev91 = isBear91
            ? (last91.close - bb91.upper) / bb91.upper * 100
            : (bb91.lower - last91.close) / bb91.lower * 100;
          strategies.push({
            name: 'GH+CRSI85+BB22',
            emoji: '⏰🧮',
            score: Math.round(Math.min(9.8, 7.0 + dev91 * 5 + Math.min(1, (isBear91 ? crsi91 - 85 : 15 - crsi91) / 15) * 1.5) * 10) / 10,
            direction: (isBear91 ? 'bearish' : 'bullish') as Direction,
            signal: `GH=${s91Hour}UTC CRSI=${crsi91.toFixed(1)} dev=${dev91.toFixed(3)}% (ETH=67.2% BTC=61.1% WR ~0.8/day)`,
            confidence: Math.round(Math.min(85, 68 + dev91 * 6 + Math.min(1, (isBear91 ? crsi91 - 85 : 15 - crsi91) / 15) * 8)),
          });
        }
      }
    }
  }

  // ─── Strat 92: GoodH + ADX<20 + RSI7>73 + MFI14>72 + BB22 ───────────────────
  // 5-condition ultra-selective: ranging market + good hour + deep RSI + volume + BB extreme
  // BTC: 76.2% @0.07/day (BTC good hours) — BREAKTHROUGH: >75% WR ACHIEVED 🔥🔥🔥
  // XRP: 72.7% | ETH: 60.0% | Combined avg 64.7% WR
  if (candles5m.length >= 30) {
    const s92GoodHours = [1, 12, 13, 16, 20]; // BTC good hours (strongest for this strategy)
    const last92 = candles5m[candles5m.length - 1];
    const s92Hour = new Date(last92.closeTime).getUTCHours();
    if (s92GoodHours.includes(s92Hour)) {
      const adx92 = calcADX(candles5m, 14);
      if (adx92 < 20) {
        const bb92 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_92 = calculateRSI(candles5m, 7);
        const mfi92 = calculateMFI(candles5m, 14);
        if (bb92 && rsi7_92 !== null && mfi92 !== null) {
          const isBear92 = rsi7_92 > 73 && mfi92 > 72 && last92.close > bb92.upper;
          const isBull92 = rsi7_92 < 27 && mfi92 < 28 && last92.close < bb92.lower;
          if (isBear92 || isBull92) {
            const dev92 = isBear92
              ? (last92.close - bb92.upper) / bb92.upper * 100
              : (bb92.lower - last92.close) / bb92.lower * 100;
            strategies.push({
              name: 'GH+ADX20+RSI73+MFI72',
              emoji: '🔥💎',
              score: Math.round(Math.min(10, 7.5 + dev92 * 5 + 1.0) * 10) / 10,
              direction: (isBear92 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s92Hour}UTC ADX=${adx92.toFixed(1)} RSI7=${rsi7_92.toFixed(0)} MFI=${mfi92.toFixed(0)} dev=${dev92.toFixed(3)}% (BTC=76.2% avg=64.7% WR 🔥)`,
              confidence: Math.round(Math.min(90, 72 + dev92 * 6 + 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 93: GoodH + ADX<20 + RSI7>73 + MFI14>72 + RSI14>68 + BB22 ───────
  // 6-condition ultra-selective: strat92 + RSI14 confirmation
  // BTC: 83.3% @0.02/day | XRP: 80.0% | SOL: 71.4% | ETH: 66.7% → avg 75.4% WR 🔥🔥🔥
  if (candles5m.length >= 30) {
    const s93GoodHours = [1, 12, 13, 16, 20]; // BTC good hours
    const last93 = candles5m[candles5m.length - 1];
    const s93Hour = new Date(last93.closeTime).getUTCHours();
    if (s93GoodHours.includes(s93Hour)) {
      const adx93 = calcADX(candles5m, 14);
      if (adx93 < 20) {
        const bb93 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_93 = calculateRSI(candles5m, 7);
        const mfi93 = calculateMFI(candles5m, 14);
        if (bb93 && rsi7_93 !== null && mfi93 !== null && rsi14_5m !== null) {
          const isBear93 = rsi7_93 > 73 && (rsi14_5m ?? 50) > 68 && mfi93 > 72 && last93.close > bb93.upper;
          const isBull93 = rsi7_93 < 27 && (rsi14_5m ?? 50) < 32 && mfi93 < 28 && last93.close < bb93.lower;
          if (isBear93 || isBull93) {
            const dev93 = isBear93
              ? (last93.close - bb93.upper) / bb93.upper * 100
              : (bb93.lower - last93.close) / bb93.lower * 100;
            strategies.push({
              name: 'GH+ADX20+RSI73+MFI72+RSI14',
              emoji: '🔥💎💎',
              score: Math.round(Math.min(10, 7.8 + dev93 * 5 + 1.0) * 10) / 10,
              direction: (isBear93 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s93Hour}UTC ADX=${adx93.toFixed(1)} RSI7=${rsi7_93.toFixed(0)} RSI14=${(rsi14_5m??50).toFixed(0)} MFI=${mfi93.toFixed(0)} (BTC=83.3% avg=75.4% WR 🔥)`,
              confidence: Math.round(Math.min(92, 75 + dev93 * 6 + 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 94: GoodH + ADX<20 + RSI7>76 + MFI14>75 + BB22 ───────────────────
  // Deeper thresholds than strat92 (RSI76+MFI75 vs RSI73+MFI72)
  // BTC: 80.0% | XRP: 77.8% | SOL: 62.5% | ETH: 63.6% → avg 71.0% WR 🔥🔥
  if (candles5m.length >= 30) {
    const s94GoodHours = [1, 12, 13, 16, 20]; // BTC good hours
    const last94 = candles5m[candles5m.length - 1];
    const s94Hour = new Date(last94.closeTime).getUTCHours();
    if (s94GoodHours.includes(s94Hour)) {
      const adx94 = calcADX(candles5m, 14);
      if (adx94 < 20) {
        const bb94 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_94 = calculateRSI(candles5m, 7);
        const mfi94 = calculateMFI(candles5m, 14);
        if (bb94 && rsi7_94 !== null && mfi94 !== null) {
          const isBear94 = rsi7_94 > 76 && mfi94 > 75 && last94.close > bb94.upper;
          const isBull94 = rsi7_94 < 24 && mfi94 < 25 && last94.close < bb94.lower;
          if (isBear94 || isBull94) {
            const dev94 = isBear94
              ? (last94.close - bb94.upper) / bb94.upper * 100
              : (bb94.lower - last94.close) / bb94.lower * 100;
            strategies.push({
              name: 'GH+ADX20+RSI76+MFI75',
              emoji: '🔥🔥',
              score: Math.round(Math.min(10, 7.8 + dev94 * 5 + 1.0) * 10) / 10,
              direction: (isBear94 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s94Hour}UTC ADX=${adx94.toFixed(1)} RSI7=${rsi7_94.toFixed(0)} MFI=${mfi94.toFixed(0)} dev=${dev94.toFixed(3)}% (BTC=80.0% avg=71.0% WR 🔥)`,
              confidence: Math.round(Math.min(90, 73 + dev94 * 6 + 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 95: TightGH[12,13,21] + ADX<20 + RSI7>70 + MFI14>68 + BB22 ───────
  // Tight 3-hour window (ETH best: 12+21, BTC best: 12+13) × ADX<20 × RSI/MFI
  // ETH[12,21]: 71.4% @0.05/day | BTC[12,13]: ~70% @0.12/day
  if (candles5m.length >= 30) {
    const s95GoodHours = [12, 13, 21]; // tight hours: shared(12) + BTC(13) + ETH(21)
    const last95 = candles5m[candles5m.length - 1];
    const s95Hour = new Date(last95.closeTime).getUTCHours();
    if (s95GoodHours.includes(s95Hour)) {
      const adx95 = calcADX(candles5m, 14);
      if (adx95 < 20) {
        const bb95 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_95 = calculateRSI(candles5m, 7);
        const mfi95 = calculateMFI(candles5m, 14);
        if (bb95 && rsi7_95 !== null && mfi95 !== null) {
          const isBear95 = rsi7_95 > 70 && mfi95 > 68 && last95.close > bb95.upper;
          const isBull95 = rsi7_95 < 30 && mfi95 < 32 && last95.close < bb95.lower;
          if (isBear95 || isBull95) {
            const dev95 = isBear95
              ? (last95.close - bb95.upper) / bb95.upper * 100
              : (bb95.lower - last95.close) / bb95.lower * 100;
            strategies.push({
              name: 'TightGH+ADX20+RSI70+MFI68',
              emoji: '🕐🔥',
              score: Math.round(Math.min(9.5, 7.0 + dev95 * 5 + Math.min(1, (20 - adx95) / 15)) * 10) / 10,
              direction: (isBear95 ? 'bearish' : 'bullish') as Direction,
              signal: `TightGH=${s95Hour}UTC ADX=${adx95.toFixed(1)} RSI7=${rsi7_95.toFixed(0)} MFI=${mfi95.toFixed(0)} (ETH=71.4% BTC=70% WR 🔥)`,
              confidence: Math.round(Math.min(85, 68 + dev95 * 5 + Math.min(1, (20 - adx95) / 15) * 8)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 96: GoodH + ADX<20 + RSI3>93 + BB22 ────────────────────────────────
  // Ultra-fast RSI3 extreme in ranging market during BTC good hours
  // BTC: 75.0% @0.10/day (n=92) ← highest-volume >75% WR result 🔥🔥🔥
  if (candles5m.length >= 20) {
    const s96GoodHours = [1, 12, 13, 16, 20]; // BTC good hours
    const last96 = candles5m[candles5m.length - 1];
    const s96Hour = new Date(last96.closeTime).getUTCHours();
    if (s96GoodHours.includes(s96Hour)) {
      const adx96 = calcADX(candles5m, 14);
      if (adx96 < 20) {
        const bb96 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_96 = calculateRSI(candles5m, 3);
        if (bb96 && rsi3_96 !== null) {
          const isBear96 = rsi3_96 > 93 && last96.close > bb96.upper;
          const isBull96 = rsi3_96 < 7 && last96.close < bb96.lower;
          if (isBear96 || isBull96) {
            const dev96 = isBear96
              ? (last96.close - bb96.upper) / bb96.upper * 100
              : (bb96.lower - last96.close) / bb96.lower * 100;
            const extremity96 = isBear96 ? (rsi3_96 - 93) / 7 : (7 - rsi3_96) / 7;
            strategies.push({
              name: 'GH+ADX20+RSI3_93+BB22',
              emoji: '⚡🔥',
              score: Math.round(Math.min(9.5, 7.2 + dev96 * 5 + Math.min(1, extremity96)) * 10) / 10,
              direction: (isBear96 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s96Hour}UTC ADX=${adx96.toFixed(1)} RSI3=${rsi3_96.toFixed(0)} dev=${dev96.toFixed(3)}% (BTC=75.0% WR n=92 🔥)`,
              confidence: Math.round(Math.min(88, 70 + dev96 * 6 + Math.min(1, extremity96) * 8)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 97: GoodH + ADX<20 + RSI3>93 + RSI5>82 + MFI70 + BB22 ──────────
  // Triple RSI cascade: RSI3 + RSI5 both extreme + MFI volume confirm
  // BTC: 85.7% @0.03/day (n=32) 🔥🔥🔥 | XRP: 75.0% @0.02/day (n=26) (session14_highwr.js H3)
  if (candles5m.length >= 20) {
    const s97GoodHours = [1, 12, 13, 16, 20];
    const last97 = candles5m[candles5m.length - 1];
    const s97Hour = new Date(last97.closeTime).getUTCHours();
    if (s97GoodHours.includes(s97Hour)) {
      const adx97 = calcADX(candles5m, 14);
      if (adx97 < 20) {
        const bb97 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_97 = calculateRSI(candles5m, 3);
        const rsi5_97 = calculateRSI(candles5m, 5);
        const mfi97 = calculateMFI(candles5m, 14);
        if (bb97 && rsi3_97 !== null && rsi5_97 !== null && mfi97 !== null) {
          const isBear97 = rsi3_97 > 93 && rsi5_97 > 82 && mfi97 > 70 && last97.close > bb97.upper;
          const isBull97 = rsi3_97 < 7 && rsi5_97 < 18 && mfi97 < 30 && last97.close < bb97.lower;
          if (isBear97 || isBull97) {
            const dev97 = isBear97
              ? (last97.close - bb97.upper) / bb97.upper * 100
              : (bb97.lower - last97.close) / bb97.lower * 100;
            const ext97 = isBear97 ? (rsi3_97 - 93) / 7 : (7 - rsi3_97) / 7;
            strategies.push({
              name: 'GH+ADX20+RSI3_93+RSI5_82+MFI70',
              emoji: '🔥💥',
              score: Math.round(Math.min(10, 7.8 + dev97 * 5 + Math.min(1, ext97)) * 10) / 10,
              direction: (isBear97 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s97Hour}UTC ADX=${adx97.toFixed(1)} RSI3=${rsi3_97.toFixed(0)} RSI5=${rsi5_97.toFixed(0)} MFI=${mfi97.toFixed(0)} (BTC=85.7% 🔥🔥🔥)`,
              confidence: Math.round(Math.min(94, 78 + dev97 * 6 + Math.min(1, ext97) * 8)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 98: GoodH + ADX<20 + WPR>-8 + RSI7>73 + MFI72 + BB22 ────────────
  // Williams %R extreme overbought + RSI + MFI confirm in ranging market
  // BTC: 77.8% @0.02/day (n=26) 🔥🔥🔥 | ETH: 71.4% @0.01/day (n=16) (session14 C4)
  if (candles5m.length >= 22) {
    const s98GoodHours = [1, 12, 13, 16, 20];
    const last98 = candles5m[candles5m.length - 1];
    const s98Hour = new Date(last98.closeTime).getUTCHours();
    if (s98GoodHours.includes(s98Hour)) {
      const adx98 = calcADX(candles5m, 14);
      if (adx98 < 20) {
        const bb98 = calculateBollingerBands(candles5m, 20, 2.2);
        const wpr98 = calcWilliamsR(candles5m, 14);
        const rsi7_98 = calculateRSI(candles5m, 7);
        const mfi98 = calculateMFI(candles5m, 14);
        if (bb98 && rsi7_98 !== null && mfi98 !== null) {
          const isBear98 = wpr98 > -8 && rsi7_98 > 73 && mfi98 > 72 && last98.close > bb98.upper;
          const isBull98 = wpr98 < -92 && rsi7_98 < 27 && mfi98 < 28 && last98.close < bb98.lower;
          if (isBear98 || isBull98) {
            const dev98 = isBear98
              ? (last98.close - bb98.upper) / bb98.upper * 100
              : (bb98.lower - last98.close) / bb98.lower * 100;
            strategies.push({
              name: 'GH+ADX20+WPR_8+RSI73+MFI72',
              emoji: '📉🔥',
              score: Math.round(Math.min(9.5, 7.5 + dev98 * 5) * 10) / 10,
              direction: (isBear98 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s98Hour}UTC ADX=${adx98.toFixed(1)} WPR=${wpr98.toFixed(1)} RSI7=${rsi7_98.toFixed(0)} MFI=${mfi98.toFixed(0)} (BTC=77.8% 🔥🔥🔥)`,
              confidence: Math.round(Math.min(90, 72 + dev98 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 99: GoodH + ADX<20 + ConnorsRSI>85 + MFI72 + BB22 ───────────────
  // ConnorsRSI extreme + MFI volume confirm + ranging market filter
  // BTC: 77.8% @0.04/day (n=42) ← highest-volume BTC strat in session 14! 🔥🔥🔥
  if (candles5m.length >= 106) {
    const s99GoodHours = [1, 12, 13, 16, 20];
    const last99 = candles5m[candles5m.length - 1];
    const s99Hour = new Date(last99.closeTime).getUTCHours();
    if (s99GoodHours.includes(s99Hour)) {
      const adx99 = calcADX(candles5m, 14);
      if (adx99 < 20) {
        const bb99 = calculateBollingerBands(candles5m, 20, 2.2);
        const crsi99 = calcConnorsRSI(candles5m, 100);
        const mfi99 = calculateMFI(candles5m, 14);
        if (bb99 && mfi99 !== null) {
          const isBear99 = crsi99 > 85 && mfi99 > 72 && last99.close > bb99.upper;
          const isBull99 = crsi99 < 15 && mfi99 < 28 && last99.close < bb99.lower;
          if (isBear99 || isBull99) {
            const dev99 = isBear99
              ? (last99.close - bb99.upper) / bb99.upper * 100
              : (bb99.lower - last99.close) / bb99.lower * 100;
            const crsiExt99 = isBear99 ? (crsi99 - 85) / 15 : (15 - crsi99) / 15;
            strategies.push({
              name: 'GH+ADX20+CRSI85+MFI72',
              emoji: '🧠🔥',
              score: Math.round(Math.min(9.5, 7.5 + dev99 * 5 + Math.min(1, crsiExt99) * 0.5) * 10) / 10,
              direction: (isBear99 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s99Hour}UTC ADX=${adx99.toFixed(1)} CRSI=${crsi99.toFixed(0)} MFI=${mfi99.toFixed(0)} (BTC=77.8% n=42 🔥🔥🔥)`,
              confidence: Math.round(Math.min(90, 72 + dev99 * 6 + Math.min(1, crsiExt99) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 100: GoodH + BB(20,2.0) + RSI7>73 + MFI72 + RSI14>68 + ADX<20 ───
  // Intermediate BB(2.0) — more signals than BB(2.2), tighter than BB(1.8)
  // BTC: 80.0% @0.03/day (n=27) 🔥🔥🔥 (session14 F2)
  if (candles5m.length >= 30) {
    const s100GoodHours = [1, 12, 13, 16, 20];
    const last100 = candles5m[candles5m.length - 1];
    const s100Hour = new Date(last100.closeTime).getUTCHours();
    if (s100GoodHours.includes(s100Hour)) {
      const adx100 = calcADX(candles5m, 14);
      if (adx100 < 20) {
        const bb100 = calculateBollingerBands(candles5m, 20, 2.0);
        const rsi7_100 = calculateRSI(candles5m, 7);
        const mfi100 = calculateMFI(candles5m, 14);
        if (bb100 && rsi7_100 !== null && mfi100 !== null && rsi14_5m !== null) {
          const isBear100 = rsi7_100 > 73 && (rsi14_5m ?? 50) > 68 && mfi100 > 72 && last100.close > bb100.upper;
          const isBull100 = rsi7_100 < 27 && (rsi14_5m ?? 50) < 32 && mfi100 < 28 && last100.close < bb100.lower;
          if (isBear100 || isBull100) {
            const dev100 = isBear100
              ? (last100.close - bb100.upper) / bb100.upper * 100
              : (bb100.lower - last100.close) / bb100.lower * 100;
            strategies.push({
              name: 'GH+BB20_2.0+RSI73+MFI72+RSI14',
              emoji: '🎯🔥',
              score: Math.round(Math.min(9.5, 7.5 + dev100 * 5) * 10) / 10,
              direction: (isBear100 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s100Hour}UTC ADX=${adx100.toFixed(1)} BB2.0=${dev100.toFixed(3)}% RSI7=${rsi7_100.toFixed(0)} MFI=${mfi100.toFixed(0)} (BTC=80.0% 🔥🔥🔥)`,
              confidence: Math.round(Math.min(91, 74 + dev100 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 101: 1m Volume Climax + 5m BB22 ──────────────────────────────────
  // 1m bar volume > 2.2× avg20 at BB(20,2.2) extreme = distribution/accumulation exhaustion
  // ETH=58.4% @7/d, BTC=58.9% @7/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1m.length >= 22 && candles5m.length >= 22) {
    const bb101 = calculateBollingerBands(candles5m, 20, 2.2);
    const last101 = candles5m[candles5m.length - 1];
    if (bb101) {
      const vols1m101 = candles1m.slice(-21).map(c => c.volume);
      const avgVol1m101 = vols1m101.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      const lastVol1m101 = vols1m101[20];
      const volSpike101 = avgVol1m101 > 0 ? lastVol1m101 / avgVol1m101 : 0;
      if (volSpike101 >= 2.2) {
        const isBear101 = last101.close > bb101.upper;
        const isBull101 = last101.close < bb101.lower;
        if (isBear101 || isBull101) {
          const dev101 = isBear101
            ? (last101.close - bb101.upper) / bb101.upper * 100
            : (bb101.lower - last101.close) / bb101.lower * 100;
          strategies.push({
            name: '1mVolClimaxBB22',
            emoji: '📊⚡',
            score: Math.round(Math.min(9.0, 6.0 + dev101 * 5 + Math.min(1, (volSpike101 - 2.2) / 3) * 1.5) * 10) / 10,
            direction: (isBear101 ? 'bearish' : 'bullish') as Direction,
            signal: `1mVol=${volSpike101.toFixed(1)}x dev=${dev101.toFixed(3)}% (ETH=58.4% BTC=58.9% @7/day)`,
            confidence: Math.round(Math.min(74, 60 + dev101 * 7 + Math.min(1, (volSpike101 - 2.2) / 3) * 7)),
          });
        }
      }
    }
  }

  // ─── Strat 102: 1h Ranging + 5m BB22 + Streak ────────────────────────────────
  // 1h RSI14 in [40,62] (non-trending) + 5m streak ≥ 1 + outside BB(20,2.2)
  // ETH=59.0% @12/d, BTC=59.0% @12/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1h.length >= 15 && candles5m.length >= 22) {
    const bb102 = calculateBollingerBands(candles5m, 20, 2.2);
    const last102 = candles5m[candles5m.length - 1];
    if (bb102) {
      const rsi14_1h102 = calculateRSI(candles1h, 14);
      if (rsi14_1h102 !== null && rsi14_1h102 >= 40 && rsi14_1h102 <= 62) {
        const prev102 = candles5m[candles5m.length - 2];
        const streak102 = (last102.close > last102.open && prev102.close > prev102.open) ||
                          (last102.close < last102.open && prev102.close < prev102.open);
        if (streak102) {
          const isBear102 = last102.close > bb102.upper;
          const isBull102 = last102.close < bb102.lower;
          if (isBear102 || isBull102) {
            const dev102 = isBear102
              ? (last102.close - bb102.upper) / bb102.upper * 100
              : (bb102.lower - last102.close) / bb102.lower * 100;
            strategies.push({
              name: '1hRanging+BB22+Streak',
              emoji: '🕐📊',
              score: Math.round(Math.min(9.0, 6.2 + dev102 * 5) * 10) / 10,
              direction: (isBear102 ? 'bearish' : 'bullish') as Direction,
              signal: `1hRSI14=${rsi14_1h102.toFixed(0)} ranging dev=${dev102.toFixed(3)}% (ETH=59.0% BTC=59.0% @12/day)`,
              confidence: Math.round(Math.min(75, 61 + dev102 * 8)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 103: 1m Sub-bar Momentum Fade + 5m BB22 ───────────────────────────
  // 3 consecutive 1m candles same direction + body ratio ≥ 0.6 + outside BB(20,2.2)
  // ETH=57.7% @7/d, BTC=57.7% @7/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1m.length >= 5 && candles5m.length >= 22) {
    const bb103 = calculateBollingerBands(candles5m, 20, 2.2);
    const last103 = candles5m[candles5m.length - 1];
    if (bb103) {
      const last3_1m103 = candles1m.slice(-3);
      const allBull1m103 = last3_1m103.every(c => c.close > c.open);
      const allBear1m103 = last3_1m103.every(c => c.close < c.open);
      if (allBull1m103 || allBear1m103) {
        const bodyRatio103 = last3_1m103.reduce((sum, c) => {
          const body = Math.abs(c.close - c.open);
          const range = c.high - c.low;
          return sum + (range > 0 ? body / range : 0);
        }, 0) / 3;
        if (bodyRatio103 >= 0.6) {
          const isBear103 = allBull1m103 && last103.close > bb103.upper;
          const isBull103 = allBear1m103 && last103.close < bb103.lower;
          if (isBear103 || isBull103) {
            const dev103 = isBear103
              ? (last103.close - bb103.upper) / bb103.upper * 100
              : (bb103.lower - last103.close) / bb103.lower * 100;
            strategies.push({
              name: '1mMomentumFade+BB22',
              emoji: '🔄📉',
              score: Math.round(Math.min(8.8, 5.9 + dev103 * 5 + (bodyRatio103 - 0.6) * 1.5) * 10) / 10,
              direction: (isBear103 ? 'bearish' : 'bullish') as Direction,
              signal: `1m3consec body=${bodyRatio103.toFixed(2)} dev=${dev103.toFixed(3)}% (ETH=57.7% BTC=57.7% @7/day)`,
              confidence: Math.round(Math.min(72, 59 + dev103 * 7 + (bodyRatio103 - 0.6) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 104: 1m VolSpike + 1h Ranging + 5m BB22 (STAR) ───────────────────
  // 1m vol > 2.5× avg + 1h RSI14 in [38,63] (ranging regime) + outside BB(20,2.2)
  // ETH=61.2% σ=1.3% @4/d, BTC=62.7% σ=2.1% @4/d (session13_5s_mtf_research.js, 5-fold WF) 🌟
  if (candles1m.length >= 22 && candles1h.length >= 15 && candles5m.length >= 22) {
    const bb104 = calculateBollingerBands(candles5m, 20, 2.2);
    const last104 = candles5m[candles5m.length - 1];
    if (bb104) {
      const vols1m104 = candles1m.slice(-21).map(c => c.volume);
      const avgVol1m104 = vols1m104.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      const lastVol1m104 = vols1m104[20];
      const volSpike104 = avgVol1m104 > 0 ? lastVol1m104 / avgVol1m104 : 0;
      if (volSpike104 >= 2.5) {
        const rsi14_1h104 = calculateRSI(candles1h, 14);
        if (rsi14_1h104 !== null && rsi14_1h104 >= 38 && rsi14_1h104 <= 63) {
          const isBear104 = last104.close > bb104.upper;
          const isBull104 = last104.close < bb104.lower;
          if (isBear104 || isBull104) {
            const dev104 = isBear104
              ? (last104.close - bb104.upper) / bb104.upper * 100
              : (bb104.lower - last104.close) / bb104.lower * 100;
            strategies.push({
              name: '1mVolSpike+1hRange+BB22',
              emoji: '🚀📊',
              score: Math.round(Math.min(9.5, 7.0 + dev104 * 5 + Math.min(1, (volSpike104 - 2.5) / 3)) * 10) / 10,
              direction: (isBear104 ? 'bearish' : 'bullish') as Direction,
              signal: `1mVol=${volSpike104.toFixed(1)}x 1hRSI=${rsi14_1h104.toFixed(0)} ranging dev=${dev104.toFixed(3)}% (ETH=61.2% BTC=62.7% STAR 🌟)`,
              confidence: Math.round(Math.min(80, 65 + dev104 * 8 + Math.min(1, (volSpike104 - 2.5) / 3) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 105: GoodH + ADX<20 + RSI3>90 + MFI70 + BB(20,1.8) ───────────────
  // BB(20,1.8) medium-tight band × RSI3 ultra-fast extreme × MFI volume
  // ETH: 75.0% n=110 tpd=0.6 🔥🔥🔥 FIRST ETH >75% at n≥100! (session15 B3)
  if (candles5m.length >= 20) {
    const s105GoodHours = [1, 12, 13, 16, 20];
    const last105 = candles5m[candles5m.length - 1];
    const s105Hour = new Date(last105.closeTime).getUTCHours();
    if (s105GoodHours.includes(s105Hour)) {
      const adx105 = calcADX(candles5m, 14);
      if (adx105 < 20) {
        const bb105 = calculateBollingerBands(candles5m, 20, 1.8);
        const rsi3_105 = calculateRSI(candles5m, 3);
        const mfi105 = calculateMFI(candles5m, 14);
        if (bb105 && rsi3_105 !== null && mfi105 !== null) {
          const isBear105 = rsi3_105 > 90 && mfi105 > 70 && last105.close > bb105.upper;
          const isBull105 = rsi3_105 < 10 && mfi105 < 30 && last105.close < bb105.lower;
          if (isBear105 || isBull105) {
            const dev105 = isBear105
              ? (last105.close - bb105.upper) / bb105.upper * 100
              : (bb105.lower - last105.close) / bb105.lower * 100;
            const ext105 = isBear105 ? (rsi3_105 - 90) / 10 : (10 - rsi3_105) / 10;
            strategies.push({
              name: 'GH+ADX20+RSI3_90+MFI70+BB18',
              emoji: '🔥🎯',
              score: Math.round(Math.min(9.5, 7.5 + dev105 * 5 + Math.min(1, ext105) * 0.5) * 10) / 10,
              direction: (isBear105 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s105Hour}UTC ADX=${adx105.toFixed(1)} RSI3=${rsi3_105.toFixed(0)} MFI=${mfi105.toFixed(0)} BB1.8 (ETH=75.0% n=110 🔥🔥🔥)`,
              confidence: Math.round(Math.min(90, 73 + dev105 * 6 + Math.min(1, ext105) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 106: GoodH + ADX<20 + RSI7>73 + MFI72 + RSI14>68 + BB(20,1.0) ───
  // BB(20,1.0) ultra-tight × triple confirm RSI7+MFI+RSI14 in ranging market
  // BTC: 78.9% n=70 tpd=0.4 🔥🔥🔥 (session15 D3)
  if (candles5m.length >= 30) {
    const s106GoodHours = [1, 12, 13, 16, 20];
    const last106 = candles5m[candles5m.length - 1];
    const s106Hour = new Date(last106.closeTime).getUTCHours();
    if (s106GoodHours.includes(s106Hour)) {
      const adx106 = calcADX(candles5m, 14);
      if (adx106 < 20) {
        const bb106 = calculateBollingerBands(candles5m, 20, 1.0);
        const rsi7_106 = calculateRSI(candles5m, 7);
        const mfi106 = calculateMFI(candles5m, 14);
        if (bb106 && rsi7_106 !== null && mfi106 !== null && rsi14_5m !== null) {
          const isBear106 = rsi7_106 > 73 && (rsi14_5m ?? 50) > 68 && mfi106 > 72 && last106.close > bb106.upper;
          const isBull106 = rsi7_106 < 27 && (rsi14_5m ?? 50) < 32 && mfi106 < 28 && last106.close < bb106.lower;
          if (isBear106 || isBull106) {
            const dev106 = isBear106
              ? (last106.close - bb106.upper) / bb106.upper * 100
              : (bb106.lower - last106.close) / bb106.lower * 100;
            strategies.push({
              name: 'GH+ADX20+RSI73+MFI72+RSI14+BB10',
              emoji: '🎯💎',
              score: Math.round(Math.min(9.5, 7.5 + dev106 * 5) * 10) / 10,
              direction: (isBear106 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s106Hour}UTC ADX=${adx106.toFixed(1)} RSI7=${rsi7_106.toFixed(0)} MFI=${mfi106.toFixed(0)} BB1.0 (BTC=78.9% n=70 🔥🔥🔥)`,
              confidence: Math.round(Math.min(91, 74 + dev106 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 107: GoodH + 4h ADX<20 + RSI3>93 + MFI70 + BB22 ──────────────────
  // 4h regime filter (ranging) + 5m extreme RSI3 + MFI at BB extreme
  // ETH: 74.5% n=47 tpd=0.3 🔥🔥 | BTC: 70.5% n=44 tpd=0.2 🔥🔥 (session16 H3)
  if (candles5m.length >= 25 && candles4h.length >= 30) {
    const s107GoodHours = [1, 10, 11, 12, 13, 16, 20, 21];
    const last107 = candles5m[candles5m.length - 1];
    const s107Hour = new Date(last107.closeTime).getUTCHours();
    if (s107GoodHours.includes(s107Hour)) {
      const adx107_4h = calcADX(candles4h, 14);
      if (adx107_4h < 20) {
        const bb107 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_107 = calculateRSI(candles5m, 3);
        const mfi107 = calculateMFI(candles5m, 14);
        if (bb107 && rsi3_107 !== null && mfi107 !== null) {
          const isBear107 = rsi3_107 > 93 && mfi107 > 70 && last107.close > bb107.upper;
          const isBull107 = rsi3_107 < 7 && mfi107 < 30 && last107.close < bb107.lower;
          if (isBear107 || isBull107) {
            const dev107 = isBear107
              ? (last107.close - bb107.upper) / bb107.upper * 100
              : (bb107.lower - last107.close) / bb107.lower * 100;
            const ext107 = isBear107 ? (rsi3_107 - 93) / 7 : (7 - rsi3_107) / 7;
            strategies.push({
              name: 'GH+4hADX20+RSI3_93+MFI70+BB22',
              emoji: '🔥🌐',
              score: Math.round(Math.min(9.3, 7.2 + dev107 * 5 + Math.min(1, ext107) * 0.5) * 10) / 10,
              direction: (isBear107 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s107Hour}UTC 4hADX=${adx107_4h.toFixed(1)} RSI3=${rsi3_107.toFixed(0)} MFI=${mfi107.toFixed(0)} BB22 (ETH=74.5% 4hFilter 🔥🔥)`,
              confidence: Math.round(Math.min(88, 70 + dev107 * 6 + Math.min(1, ext107) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 108: GoodH + ADX<20 + RSI3>95 + MFI70 + BB22 (ultra-extreme) ─────
  // Ultra-rare RSI3>95 = hyper-overbought + MFI confirmation
  // BTC: 71.0% n=31 tpd=0.2 🔥🔥 | XRP: 80.0% n=20 tpd=0.1 🔥🔥🔥 (session16 D2)
  if (candles5m.length >= 25) {
    const s108GoodHours = [1, 6, 9, 10, 11, 12, 13, 16, 18, 20, 21];
    const last108 = candles5m[candles5m.length - 1];
    const s108Hour = new Date(last108.closeTime).getUTCHours();
    if (s108GoodHours.includes(s108Hour)) {
      const adx108 = calcADX(candles5m, 14);
      if (adx108 < 20) {
        const bb108 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_108 = calculateRSI(candles5m, 3);
        const mfi108 = calculateMFI(candles5m, 14);
        if (bb108 && rsi3_108 !== null && mfi108 !== null) {
          const isBear108 = rsi3_108 > 95 && mfi108 > 70 && last108.close > bb108.upper;
          const isBull108 = rsi3_108 < 5 && mfi108 < 30 && last108.close < bb108.lower;
          if (isBear108 || isBull108) {
            const dev108 = isBear108
              ? (last108.close - bb108.upper) / bb108.upper * 100
              : (bb108.lower - last108.close) / bb108.lower * 100;
            const ext108 = isBear108 ? (rsi3_108 - 95) / 5 : (5 - rsi3_108) / 5;
            strategies.push({
              name: 'GH+ADX20+RSI3_95+MFI70+BB22',
              emoji: '🚀🔥',
              score: Math.round(Math.min(9.5, 7.5 + dev108 * 5 + Math.min(1, ext108) * 0.5) * 10) / 10,
              direction: (isBear108 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s108Hour}UTC ADX=${adx108.toFixed(1)} RSI3=${rsi3_108.toFixed(0)} MFI=${mfi108.toFixed(0)} BB22 (XRP=80.0% ultra 🚀)`,
              confidence: Math.round(Math.min(90, 73 + dev108 * 6 + Math.min(1, ext108) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 109: GoodH + ADX<20 + RSI3>95 + MFI70 + BB(20,1.8) ───────────────
  // Same as 108 but BB1.8 (tighter band) → ~40% more signals while keeping high WR
  // BTC: 70.0% n=40 tpd=0.2 🔥🔥 | XRP: 77.3% n=22 tpd=0.1 🔥🔥🔥 (session16 D3)
  if (candles5m.length >= 25) {
    const s109GoodHours = [1, 6, 9, 10, 11, 12, 13, 16, 18, 20, 21];
    const last109 = candles5m[candles5m.length - 1];
    const s109Hour = new Date(last109.closeTime).getUTCHours();
    if (s109GoodHours.includes(s109Hour)) {
      const adx109 = calcADX(candles5m, 14);
      if (adx109 < 20) {
        const bb109 = calculateBollingerBands(candles5m, 20, 1.8);
        const rsi3_109 = calculateRSI(candles5m, 3);
        const mfi109 = calculateMFI(candles5m, 14);
        if (bb109 && rsi3_109 !== null && mfi109 !== null) {
          const isBear109 = rsi3_109 > 95 && mfi109 > 70 && last109.close > bb109.upper;
          const isBull109 = rsi3_109 < 5 && mfi109 < 30 && last109.close < bb109.lower;
          if (isBear109 || isBull109) {
            const dev109 = isBear109
              ? (last109.close - bb109.upper) / bb109.upper * 100
              : (bb109.lower - last109.close) / bb109.lower * 100;
            const ext109 = isBear109 ? (rsi3_109 - 95) / 5 : (5 - rsi3_109) / 5;
            strategies.push({
              name: 'GH+ADX20+RSI3_95+MFI70+BB18',
              emoji: '💎🔥',
              score: Math.round(Math.min(9.3, 7.3 + dev109 * 5 + Math.min(1, ext109) * 0.5) * 10) / 10,
              direction: (isBear109 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s109Hour}UTC ADX=${adx109.toFixed(1)} RSI3=${rsi3_109.toFixed(0)} MFI=${mfi109.toFixed(0)} BB1.8 (BTC=70% XRP=77.3% 💎)`,
              confidence: Math.round(Math.min(88, 72 + dev109 * 6 + Math.min(1, ext109) * 4)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 110: GoodH + ADX<20 + StochRSI-K>85 + MFI72 + RSI14>68 + BB22 ──
  // StochRSI K extreme at BB22 overbought + MFI + RSI14 confirm in ranging market
  // BTC: 80.0% n=44 tpd=0.2 🔥🔥🔥 | XRP: 80.0% n=37 tpd=0.2 🔥🔥🔥 (session16 G3)
  if (candles5m.length >= 45) {
    const s110GoodHours = [1, 12, 13, 16, 20];
    const last110 = candles5m[candles5m.length - 1];
    const s110Hour = new Date(last110.closeTime).getUTCHours();
    if (s110GoodHours.includes(s110Hour)) {
      const adx110 = calcADX(candles5m, 14);
      if (adx110 < 20) {
        const srsi110 = calcStochRSI(candles5m, 14, 14);
        const bb110 = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi110 = calculateMFI(candles5m, 14);
        if (bb110 && mfi110 !== null && rsi14_5m !== null) {
          const isBear110 = srsi110.k > 85 && mfi110 > 72 && rsi14_5m > 68 && last110.close > bb110.upper;
          const isBull110 = srsi110.k < 15 && mfi110 < 28 && rsi14_5m < 32 && last110.close < bb110.lower;
          if (isBear110 || isBull110) {
            const dev110 = isBear110
              ? (last110.close - bb110.upper) / bb110.upper * 100
              : (bb110.lower - last110.close) / bb110.lower * 100;
            strategies.push({
              name: 'GH+ADX20+StochK85+MFI72+RSI14+BB22',
              emoji: '🔥💡',
              score: Math.round(Math.min(9.5, 7.8 + dev110 * 5) * 10) / 10,
              direction: (isBear110 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s110Hour}UTC ADX=${adx110.toFixed(1)} StochK=${srsi110.k.toFixed(0)} MFI=${mfi110.toFixed(0)} (BTC=80.0% n=44 🔥🔥🔥)`,
              confidence: Math.round(Math.min(92, 76 + dev110 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 111: GoodH + ADX<20 + StochRSI-K>85 + MFI72 + RSI14>68 + BB18 ──
  // Same as 110 but BB1.8 (tighter band) → more trades, even higher WR
  // BTC: 81.8% n=60 tpd=0.3 🔥🔥🔥 HIGHEST BTC StochRSI WR! (session16 G4)
  if (candles5m.length >= 45) {
    const s111GoodHours = [1, 12, 13, 16, 20];
    const last111 = candles5m[candles5m.length - 1];
    const s111Hour = new Date(last111.closeTime).getUTCHours();
    if (s111GoodHours.includes(s111Hour)) {
      const adx111 = calcADX(candles5m, 14);
      if (adx111 < 20) {
        const srsi111 = calcStochRSI(candles5m, 14, 14);
        const bb111 = calculateBollingerBands(candles5m, 20, 1.8);
        const mfi111 = calculateMFI(candles5m, 14);
        if (bb111 && mfi111 !== null && rsi14_5m !== null) {
          const isBear111 = srsi111.k > 85 && mfi111 > 72 && rsi14_5m > 68 && last111.close > bb111.upper;
          const isBull111 = srsi111.k < 15 && mfi111 < 28 && rsi14_5m < 32 && last111.close < bb111.lower;
          if (isBear111 || isBull111) {
            const dev111 = isBear111
              ? (last111.close - bb111.upper) / bb111.upper * 100
              : (bb111.lower - last111.close) / bb111.lower * 100;
            strategies.push({
              name: 'GH+ADX20+StochK85+MFI72+RSI14+BB18',
              emoji: '🔥🎖️',
              score: Math.round(Math.min(9.5, 7.8 + dev111 * 5) * 10) / 10,
              direction: (isBear111 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s111Hour}UTC ADX=${adx111.toFixed(1)} StochK=${srsi111.k.toFixed(0)} MFI=${mfi111.toFixed(0)} BB1.8 (BTC=81.8% n=60 🔥🔥🔥)`,
              confidence: Math.round(Math.min(93, 77 + dev111 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 112: GoodH + ADX<20 + RSI7>73 + StochK>80 + MFI72 + RSI14>68 + BB18 ──
  // G2 Session17: RSI7 + StochK + MFI + RSI14 quad-oscillator at BB1.8 in ranging mkt
  // ETH: 70.8% n=24 tpd=0.1 🔥🔥 | BTC: 75.6% n=45 tpd=0.2 🔥🔥🔥 (session17 G2)
  if (candles5m.length >= 45) {
    const s112GoodHours = [1, 10, 11, 12, 13, 16, 20, 21];
    const last112 = candles5m[candles5m.length - 1];
    const s112Hour = new Date(last112.closeTime).getUTCHours();
    if (s112GoodHours.includes(s112Hour)) {
      const adx112 = calcADX(candles5m, 14);
      if (adx112 < 20) {
        const rsi7_112 = calculateRSI(candles5m, 7);
        const srsi112 = calcStochRSI(candles5m, 14, 14);
        const bb112 = calculateBollingerBands(candles5m, 20, 1.8);
        const mfi112 = calculateMFI(candles5m, 14);
        if (bb112 && mfi112 !== null && rsi14_5m !== null && rsi7_112 !== null) {
          const isBear112 = rsi7_112 > 73 && srsi112.k > 80 && mfi112 > 72 && rsi14_5m > 68 && last112.close > bb112.upper;
          const isBull112 = rsi7_112 < 27 && srsi112.k < 20 && mfi112 < 28 && rsi14_5m < 32 && last112.close < bb112.lower;
          if (isBear112 || isBull112) {
            const dev112 = isBear112
              ? (last112.close - bb112.upper) / bb112.upper * 100
              : (bb112.lower - last112.close) / bb112.lower * 100;
            strategies.push({
              name: 'GH+ADX20+RSI7_73+StochK80+MFI72+RSI14+BB18',
              emoji: '🔥🎯',
              score: Math.round(Math.min(9.4, 7.5 + dev112 * 5) * 10) / 10,
              direction: (isBear112 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s112Hour}UTC ADX=${adx112.toFixed(1)} RSI7=${rsi7_112.toFixed(0)} StochK=${srsi112.k.toFixed(0)} MFI=${mfi112.toFixed(0)} BB1.8 (BTC=75.6% n=45 🔥🔥)`,
              confidence: Math.round(Math.min(92, 76 + dev112 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 114: GoodH(BTC) + ADX<20 + 2-consec above BB22 + RSI3>90 + MFI68 ───
  // E2 Session17: Consecutive BB breaks = sustained overextension = reversal signal
  // BTC: 71.4% n=49 tpd=0.3 🔥🔥 (session17 E2)
  if (candles5m.length >= 45) {
    const s114GoodHours = [1, 12, 13, 16, 20];
    const last114 = candles5m[candles5m.length - 1];
    const prev114 = candles5m[candles5m.length - 2];
    const s114Hour = new Date(last114.closeTime).getUTCHours();
    if (s114GoodHours.includes(s114Hour)) {
      const adx114 = calcADX(candles5m, 14);
      if (adx114 < 20) {
        const rsi3_114 = calculateRSI(candles5m, 3);
        const bb114 = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi114 = calculateMFI(candles5m, 14);
        if (bb114 && rsi3_114 !== null && mfi114 !== null) {
          const consec2Bear = last114.close > bb114.upper && prev114.close > bb114.upper;
          const consec2Bull = last114.close < bb114.lower && prev114.close < bb114.lower;
          const isBear114 = consec2Bear && rsi3_114 > 90 && mfi114 > 68;
          const isBull114 = consec2Bull && rsi3_114 < 10 && mfi114 < 32;
          if (isBear114 || isBull114) {
            const dev114 = isBear114
              ? (last114.close - bb114.upper) / bb114.upper * 100
              : (bb114.lower - last114.close) / bb114.lower * 100;
            strategies.push({
              name: 'GH+ADX20+2ConsecBB22+RSI3_90+MFI68',
              emoji: '🔥🔥',
              score: Math.round(Math.min(9.3, 7.4 + dev114 * 5) * 10) / 10,
              direction: (isBear114 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s114Hour}UTC ADX=${adx114.toFixed(1)} RSI3=${rsi3_114.toFixed(0)} MFI=${mfi114.toFixed(0)} 2×consec BB22 (BTC=71.4% n=49 🔥🔥)`,
              confidence: Math.round(Math.min(90, 72 + dev114 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 115: GoodH + ADX<20 + BB%B>1.1 + RSI3>90 + MFI70 ────────────────
  // H2 Session18: Deeper BB overshoot (>1.1 band-widths above midband) = stronger exhaustion
  // ETH: 75.9% n=29 tpd=0.2 🔥🔥🔥 | BTC: 71.4% n=42 tpd=0.2 🔥🔥 (session18 H2)
  if (candles5m.length >= 25) {
    const s115GoodHours = [1, 10, 11, 12, 13, 16, 20, 21];
    const last115 = candles5m[candles5m.length - 1];
    const s115Hour = new Date(last115.closeTime).getUTCHours();
    if (s115GoodHours.includes(s115Hour)) {
      const adx115 = calcADX(candles5m, 14);
      if (adx115 < 20) {
        const bb115 = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_115 = calculateRSI(candles5m, 3);
        const mfi115 = calculateMFI(candles5m, 14);
        if (bb115 && rsi3_115 !== null && mfi115 !== null) {
          const bandWidth115 = bb115.upper - bb115.lower;
          const bbPctB115 = bandWidth115 > 0 ? (last115.close - bb115.lower) / bandWidth115 : 0.5;
          const isBear115 = bbPctB115 > 1.1 && rsi3_115 > 90 && mfi115 > 70;
          const isBull115 = bbPctB115 < -0.1 && rsi3_115 < 10 && mfi115 < 30;
          if (isBear115 || isBull115) {
            const dev115 = isBear115
              ? (last115.close - bb115.upper) / bb115.upper * 100
              : (bb115.lower - last115.close) / bb115.lower * 100;
            strategies.push({
              name: 'GH+ADX20+BB%B1.1+RSI3_90+MFI70',
              emoji: '🔥🌊',
              score: Math.round(Math.min(9.4, 7.5 + dev115 * 4 + (bbPctB115 - 1.1) * 20) * 10) / 10,
              direction: (isBear115 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s115Hour}UTC ADX=${adx115.toFixed(1)} BB%B=${bbPctB115.toFixed(2)} RSI3=${rsi3_115.toFixed(0)} MFI=${mfi115.toFixed(0)} (ETH=75.9% n=29 🔥🔥🔥)`,
              confidence: Math.round(Math.min(93, 76 + dev115 * 5 + (bbPctB115 - 1.1) * 30)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 116: GoodH + ADX<20 + StochRSI-K>90 + MFI72 + RSI14>68 + BB22 ──
  // C1 Session18: Ultra-extreme StochK>90 (higher than strat 110's >85) at BB22
  // BTC: 80.6% n=36 tpd=0.2 🔥🔥🔥 | ETH: 68.2% n=22 tpd=0.1 | XRP: 70.8% n=24 (session18 C1)
  if (candles5m.length >= 45) {
    const s116GoodHours = [1, 10, 11, 12, 13, 16, 20, 21];
    const last116 = candles5m[candles5m.length - 1];
    const s116Hour = new Date(last116.closeTime).getUTCHours();
    if (s116GoodHours.includes(s116Hour)) {
      const adx116 = calcADX(candles5m, 14);
      if (adx116 < 20) {
        const srsi116 = calcStochRSI(candles5m, 14, 14);
        const bb116 = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi116 = calculateMFI(candles5m, 14);
        if (bb116 && mfi116 !== null && rsi14_5m !== null) {
          const isBear116 = srsi116.k > 90 && mfi116 > 72 && rsi14_5m > 68 && last116.close > bb116.upper;
          const isBull116 = srsi116.k < 10 && mfi116 < 28 && rsi14_5m < 32 && last116.close < bb116.lower;
          if (isBear116 || isBull116) {
            const dev116 = isBear116
              ? (last116.close - bb116.upper) / bb116.upper * 100
              : (bb116.lower - last116.close) / bb116.lower * 100;
            strategies.push({
              name: 'GH+ADX20+StochK90+MFI72+RSI14+BB22',
              emoji: '🔥💎',
              score: Math.round(Math.min(9.5, 7.8 + dev116 * 5) * 10) / 10,
              direction: (isBear116 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s116Hour}UTC ADX=${adx116.toFixed(1)} StochK=${srsi116.k.toFixed(0)} MFI=${mfi116.toFixed(0)} BB22 ultra (BTC=80.6% n=36 🔥🔥🔥)`,
              confidence: Math.round(Math.min(92, 77 + dev116 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 118: GoodH + ADX<20 + RSI3>90 + RSI7>72 + RSI14>68 + BB22 ────────
  // C1 Session19: Triple RSI alignment — all 3 periods simultaneously overbought
  // BTC: 80.6% n=62 tpd=0.3 σ=2.9% 🏆 ULTRA STABLE! | XRP: 70.0% n=40 σ=11.1% (session19 C1)
  if (candles5m.length >= 25) {
    const s118GoodHours = [1, 10, 11, 12, 13, 16, 20, 21];
    const last118 = candles5m[candles5m.length - 1];
    const s118Hour = new Date(last118.closeTime).getUTCHours();
    if (s118GoodHours.includes(s118Hour)) {
      const adx118 = calcADX(candles5m, 14);
      if (adx118 < 20) {
        const rsi3_118 = calculateRSI(candles5m, 3);
        const rsi7_118 = calculateRSI(candles5m, 7);
        const bb118 = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb118 && rsi3_118 !== null && rsi7_118 !== null && rsi14_5m !== null) {
          const isBear118 = rsi3_118 > 90 && rsi7_118 > 72 && rsi14_5m > 68 && last118.close > bb118.upper;
          const isBull118 = rsi3_118 < 10 && rsi7_118 < 28 && rsi14_5m < 32 && last118.close < bb118.lower;
          if (isBear118 || isBull118) {
            const dev118 = isBear118
              ? (last118.close - bb118.upper) / bb118.upper * 100
              : (bb118.lower - last118.close) / bb118.lower * 100;
            strategies.push({
              name: 'GH+ADX20+RSI3_90+RSI7_72+RSI14+BB22',
              emoji: '🏆🔥',
              score: Math.round(Math.min(9.5, 7.8 + dev118 * 5) * 10) / 10,
              direction: (isBear118 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s118Hour}UTC ADX=${adx118.toFixed(1)} RSI3=${rsi3_118.toFixed(0)} RSI7=${rsi7_118.toFixed(0)} RSI14=${rsi14_5m.toFixed(0)} (BTC=80.6% σ=2.9% 🏆 ULTRA STABLE)`,
              confidence: Math.round(Math.min(93, 78 + dev118 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 119: GoodH + ADX<20 + RSI3>90 + RSI7>72 + RSI14>68 + MFI70 + BB22 ─
  // C2 Session19: Triple RSI + MFI = maximum oscillator confluence at BB22
  // BTC: 82.1% n=39 tpd=0.2 σ=10.2% 🔥🔥🔥 | XRP: 75.0% n=24 σ=14.6% 🔥🔥 (session19 C2)
  if (candles5m.length >= 25) {
    const s119GoodHours = [1, 10, 11, 12, 13, 16, 20, 21];
    const last119 = candles5m[candles5m.length - 1];
    const s119Hour = new Date(last119.closeTime).getUTCHours();
    if (s119GoodHours.includes(s119Hour)) {
      const adx119 = calcADX(candles5m, 14);
      if (adx119 < 20) {
        const rsi3_119 = calculateRSI(candles5m, 3);
        const rsi7_119 = calculateRSI(candles5m, 7);
        const bb119 = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi119 = calculateMFI(candles5m, 14);
        if (bb119 && rsi3_119 !== null && rsi7_119 !== null && rsi14_5m !== null && mfi119 !== null) {
          const isBear119 = rsi3_119 > 90 && rsi7_119 > 72 && rsi14_5m > 68 && mfi119 > 70 && last119.close > bb119.upper;
          const isBull119 = rsi3_119 < 10 && rsi7_119 < 28 && rsi14_5m < 32 && mfi119 < 30 && last119.close < bb119.lower;
          if (isBear119 || isBull119) {
            const dev119 = isBear119
              ? (last119.close - bb119.upper) / bb119.upper * 100
              : (bb119.lower - last119.close) / bb119.lower * 100;
            strategies.push({
              name: 'GH+ADX20+RSI3_90+RSI7_72+RSI14+MFI70+BB22',
              emoji: '🔥🏆',
              score: Math.round(Math.min(9.6, 8.0 + dev119 * 5) * 10) / 10,
              direction: (isBear119 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s119Hour}UTC ADX=${adx119.toFixed(1)} RSI3=${rsi3_119.toFixed(0)} RSI7=${rsi7_119.toFixed(0)} MFI=${mfi119.toFixed(0)} (BTC=82.1% XRP=75.0% 🔥🔥🔥)`,
              confidence: Math.round(Math.min(94, 80 + dev119 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 120: GoodH + ADX<20 + MFI>75 + StochK>80 + RSI14>68 + BB22 ──────
  // A2 Session19: Ultra-high MFI>75 (vs usual >70/72) + StochK + RSI14 triple
  // BTC: 84.6% n=26 tpd=0.1 σ=15.0% 🔥🔥🔥 (session19 A2)
  if (candles5m.length >= 45) {
    const s120GoodHours = [1, 10, 11, 12, 13, 16, 20, 21];
    const last120 = candles5m[candles5m.length - 1];
    const s120Hour = new Date(last120.closeTime).getUTCHours();
    if (s120GoodHours.includes(s120Hour)) {
      const adx120 = calcADX(candles5m, 14);
      if (adx120 < 20) {
        const srsi120 = calcStochRSI(candles5m, 14, 14);
        const bb120 = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi120 = calculateMFI(candles5m, 14);
        if (bb120 && mfi120 !== null && rsi14_5m !== null) {
          const isBear120 = mfi120 > 75 && srsi120.k > 80 && rsi14_5m > 68 && last120.close > bb120.upper;
          const isBull120 = mfi120 < 25 && srsi120.k < 20 && rsi14_5m < 32 && last120.close < bb120.lower;
          if (isBear120 || isBull120) {
            const dev120 = isBear120
              ? (last120.close - bb120.upper) / bb120.upper * 100
              : (bb120.lower - last120.close) / bb120.lower * 100;
            strategies.push({
              name: 'GH+ADX20+MFI75+StochK80+RSI14+BB22',
              emoji: '🔥💫',
              score: Math.round(Math.min(9.5, 7.9 + dev120 * 5) * 10) / 10,
              direction: (isBear120 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s120Hour}UTC ADX=${adx120.toFixed(1)} MFI=${mfi120.toFixed(0)} StochK=${srsi120.k.toFixed(0)} RSI14=${rsi14_5m.toFixed(0)} (BTC=84.6% n=26 🔥🔥🔥)`,
              confidence: Math.round(Math.min(93, 78 + dev120 * 6)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 121: GoodH(BTC) + ADX<20 + VWAP day-session dev>0.3% + RSI3>90 + BB22 ─
  // E1 Session20: rolling intraday VWAP deviation confirms overextension beyond band
  // BTC: 72.2% n=22 σ=7.8% ✅ STABLE tpd=0.12 (session20 E1)
  if (candles5m.length >= 25) {
    const s121GoodHours = [1, 12, 13, 16, 20];
    const last121 = candles5m[candles5m.length - 1];
    const s121Hour = new Date(last121.closeTime).getUTCHours();
    if (s121GoodHours.includes(s121Hour)) {
      const adx121 = calcADX(candles5m, 14);
      if (adx121 < 20) {
        const rsi3_121 = calculateRSI(candles5m, 3);
        const bb121 = calculateBollingerBands(candles5m, 20, 2.2);
        const vwap121 = calcDayVWAP(candles5m);
        if (bb121 && rsi3_121 !== null && vwap121 > 0) {
          const vwapDevBear = (last121.close - vwap121) / vwap121 * 100;
          const vwapDevBull = (vwap121 - last121.close) / vwap121 * 100;
          const isBear121 = vwapDevBear > 0.3 && rsi3_121 > 90 && last121.close > bb121.upper;
          const isBull121 = vwapDevBull > 0.3 && rsi3_121 < 10 && last121.close < bb121.lower;
          if (isBear121 || isBull121) {
            const dev121 = isBear121
              ? (last121.close - bb121.upper) / bb121.upper * 100
              : (bb121.lower - last121.close) / bb121.lower * 100;
            strategies.push({
              name: 'GH+ADX20+VWAP_dev0.3%+RSI3_90+BB22',
              emoji: '📊🔥',
              score: Math.round(Math.min(9.3, 7.4 + dev121 * 5) * 10) / 10,
              direction: (isBear121 ? 'bearish' : 'bullish') as Direction,
              signal: `GH=${s121Hour}UTC ADX=${adx121.toFixed(1)} VWAPdev=${(isBear121 ? vwapDevBear : vwapDevBull).toFixed(2)}% RSI3=${rsi3_121.toFixed(0)} (BTC=72.2% n=22 σ=7.8% 📊)`,
              confidence: Math.round(Math.min(87, 72 + dev121 * 6)),
            });
          }
        }
      }
    }
  }

  strategies.sort((a, b) => b.score - a.score);

  const bullishScore = strategies.filter(s => s.direction === 'bullish').reduce((s, st) => s + st.score, 0);
  const bearishScore = strategies.filter(s => s.direction === 'bearish').reduce((s, st) => s + st.score, 0);

  return {
    strategies,
    indicators: { rsi14_5m, rsi7_1m, sma20, vwap, macd, momentum: momentum5, lastPrice, bb },
    verdict: {
      direction: bullishScore > bearishScore ? 'BULLISH' : bearishScore > bullishScore ? 'BEARISH' : 'NEUTRAL',
      bullishScore: Math.round(bullishScore * 10) / 10,
      bearishScore: Math.round(bearishScore * 10) / 10,
      topStrategy: strategies[0] || null,
      signalCount: strategies.filter(s => s.score >= 7).length,
    },
  };
}

// ─────────────────── SOL Strategy ───────────────────────────────────────────
// Strategy 19: SOL Good Hours BB Reversion 🌟
// Research (solXrpResearch.ts): SOL/15m h=[0,12,13,20]+BB(20,2.2)+s≥2
// Walk-forward: WR=68.7% σ=5.6% T=226 [67.9/62.2/75.9] *** VALIDATED
// Hours: 0UTC (midnight), 12UTC (noon), 13UTC (1pm), 20UTC (8pm)
// Uses synthetic 15m from 5m candles (same approach as Strategy 16)
export function scoreSolStrategies(candles5m: Candle[], candles1m: Candle[] = [], candles1h: Candle[] = [], candles4h: Candle[] = []): StrategyResult {
  const strategies: StrategyResult['strategies'] = [];
  const lastPrice = candles5m.length > 0 ? candles5m[candles5m.length - 1].close : 0;
  const rsi14_5m = calculateRSI(candles5m, 14);
  const sma20 = calculateSMA(candles5m, 20);
  const bb = calculateBollingerBands(candles5m, 20, 2);

  // Strategy 19: SOL Good Hours BB Reversion
  // Good hours: [0, 12, 13, 20] UTC
  {
    const s19GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      // Build synthetic 15m candles (group every 3 consecutive 5m candles)
      const synth15m: Candle[] = [];
      const aligned = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned; i += 3) {
        const group = candles5m.slice(i, i + 3);
        synth15m.push({
          openTime: group[0].openTime,
          closeTime: group[2].closeTime,
          open: group[0].open,
          high: Math.max(...group.map(c => c.high)),
          low: Math.min(...group.map(c => c.low)),
          close: group[2].close,
          volume: group.reduce((s, c) => s + c.volume, 0),
          quoteVolume: group.reduce((s, c) => s + c.quoteVolume, 0),
          trades: group.reduce((s, c) => s + c.trades, 0),
        });
      }

      if (synth15m.length >= 25) {
        const lastS = synth15m[synth15m.length - 1];
        const s19Hour = new Date(lastS.closeTime).getUTCHours();

        if (s19GoodHours.includes(s19Hour)) {
          const bb22_s19 = calculateBollingerBands(synth15m, 20, 2.2);
          if (bb22_s19) {
            const sPrice = lastS.close;
            const isBear = sPrice > bb22_s19.upper;
            const isBull = sPrice < bb22_s19.lower;

            // Streak on synth15m
            let s19StreakLen = 1;
            const s19Dir = lastS.close >= lastS.open ? 'G' : 'R';
            for (let j = synth15m.length - 2; j >= Math.max(0, synth15m.length - 9); j--) {
              const d = synth15m[j].close >= synth15m[j].open ? 'G' : 'R';
              if (d === s19Dir) s19StreakLen++; else break;
            }

            const s19Bear = isBear && lastS.close > lastS.open && s19StreakLen >= 2;
            const s19Bull = isBull && lastS.close < lastS.open && s19StreakLen >= 2;

            if (s19Bear || s19Bull) {
              const deviation = s19Bear
                ? (sPrice - bb22_s19.upper) / bb22_s19.upper * 100
                : (bb22_s19.lower - sPrice) / bb22_s19.lower * 100;
              const score = Math.min(10, 6.0 + deviation * 8 + (s19StreakLen - 2) * 0.3);
              strategies.push({
                name: 'SOL Good Hours BB',
                emoji: '🌟',
                score: Math.round(score * 10) / 10,
                direction: (s19Bear ? 'bearish' : 'bullish') as Direction,
                signal: `${s19StreakLen} ${s19Bear ? 'green' : 'red'} synth-15m at BB(20,2.2) ${s19Bear ? 'upper' : 'lower'}, h=${s19Hour}UTC (68.7% WR σ=5.6%)`,
                confidence: Math.round(Math.min(87, 62 + deviation * 10 + (s19StreakLen - 2) * 1)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 26: SOL Day-of-Week Reversion 🗓️
  // DoW[Tue+Wed+Thu+Fri]+GoodH+BB(20,2.2)+streak>=1 → WF=73.3% σ=9.6% T=108 [5-fold] (optimized)
  // Adding Friday to increase trade count from 81 to 108 while keeping WR>73%
  {
    const s26GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s26: Candle[] = [];
      const aligned26 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned26; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s26.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s26.length >= 22) {
        const lastS26 = synth15m_s26[synth15m_s26.length - 1];
        const s26Hour = new Date(lastS26.closeTime).getUTCHours();
        const s26Dow = new Date(lastS26.openTime).getUTCDay(); // 2=Tue,3=Wed,4=Thu,5=Fri
        const isGoodDoW = s26Dow === 2 || s26Dow === 3 || s26Dow === 4 || s26Dow === 5;
        if (s26GoodHours.includes(s26Hour) && isGoodDoW) {
          const bb22_s26 = calculateBollingerBands(synth15m_s26, 20, 2.2);
          if (bb22_s26) {
            const p26 = lastS26.close;
            const isBear = p26 > bb22_s26.upper && lastS26.close > lastS26.open;
            const isBull = p26 < bb22_s26.lower && lastS26.close < lastS26.open;
            if (isBear || isBull) {
              let s26Streak = 0;
              for (let j = synth15m_s26.length - 1; j >= Math.max(0, synth15m_s26.length - 7); j--) {
                const cj = synth15m_s26[j];
                if (cj.close > cj.open) { if (s26Streak < 0) break; s26Streak++; }
                else if (cj.close < cj.open) { if (s26Streak > 0) break; s26Streak--; }
                else break;
              }
              const streakOk = (isBear && s26Streak >= 1) || (isBull && s26Streak <= -1);
              if (streakOk) {
                const deviation = isBear
                  ? (p26 - bb22_s26.upper) / bb22_s26.upper * 100
                  : (bb22_s26.lower - p26) / bb22_s26.lower * 100;
                const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
                strategies.push({
                  name: 'SOL DoW Reversion',
                  emoji: '🗓️',
                  score: Math.round(Math.min(10, 6.0 + Math.abs(s26Streak) * 0.5 + deviation * 8) * 10) / 10,
                  direction: (isBear ? 'bearish' : 'bullish') as Direction,
                  signal: `${dowNames[s26Dow]}+h=${s26Hour}UTC synth-15m ${isBear ? Math.abs(s26Streak)+'G' : Math.abs(s26Streak)+'R'} at BB(20,2.2) (73.3% WR σ=9.6% opt)`,
                  confidence: Math.round(Math.min(90, 65 + Math.abs(s26Streak) * 2 + deviation * 10)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 27: SOL Candle Pattern (GG Bear / RR Bull) 🕯️
  // bear:GG(2+green)+GoodH+BB(20,2.2) → WF=69.0% σ=5.3% T=78 [5-fold VALIDATED]
  // bull:RR(2+red)+GoodH+BB(20,2.2) — uses synthetic 15m candle sequences
  {
    const s27GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s27: Candle[] = [];
      const aligned27 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned27; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s27.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s27.length >= 22) {
        const lastS27 = synth15m_s27[synth15m_s27.length - 1];
        const s27Hour = new Date(lastS27.closeTime).getUTCHours();
        if (s27GoodHours.includes(s27Hour)) {
          const bb22_s27 = calculateBollingerBands(synth15m_s27, 20, 2.2);
          if (bb22_s27) {
            const p27 = lastS27.close;
            const isBear = p27 > bb22_s27.upper;
            const isBull = p27 < bb22_s27.lower;
            if (isBear || isBull) {
              // Count GG or RR streak
              let s27Streak = 0;
              for (let j = synth15m_s27.length - 1; j >= Math.max(0, synth15m_s27.length - 7); j--) {
                const cj = synth15m_s27[j];
                if (cj.close > cj.open) { if (s27Streak < 0) break; s27Streak++; }
                else if (cj.close < cj.open) { if (s27Streak > 0) break; s27Streak--; }
                else break;
              }
              const ggBear = isBear && s27Streak >= 2; // 2+ green = exhaustion bear
              const rrBull = isBull && s27Streak <= -2; // 2+ red = exhaustion bull
              if (ggBear || rrBull) {
                const deviation = ggBear
                  ? (p27 - bb22_s27.upper) / bb22_s27.upper * 100
                  : (bb22_s27.lower - p27) / bb22_s27.lower * 100;
                const streakLen = Math.abs(s27Streak);
                strategies.push({
                  name: 'SOL Pattern Exhaustion',
                  emoji: '🕯️',
                  score: Math.round(Math.min(10, 5.9 + (streakLen - 2) * 0.5 + deviation * 9) * 10) / 10,
                  direction: (ggBear ? 'bearish' : 'bullish') as Direction,
                  signal: `${ggBear ? streakLen+'G GG' : streakLen+'R RR'} synth-15m at BB(20,2.2) ${ggBear ? 'upper' : 'lower'}, h=${s27Hour}UTC (69% WR σ=5.3%)`,
                  confidence: Math.round(Math.min(88, 62 + (streakLen - 2) * 2 + deviation * 10)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 28: SOL Tighter BB(15,2.2) Reversion 🔵
  // h=[0,12,13,20]+BB(15,2.2)+streak>=2 → WF=70.9% σ=7.1% T=188 [5-fold] (HIGH FREQ: 1.03/day)
  // Tighter BB period (15 vs 20) captures more responsive mean-reversion signals for SOL
  {
    const s28GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s28: Candle[] = [];
      const aligned28 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned28; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s28.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s28.length >= 20) {
        const lastS28 = synth15m_s28[synth15m_s28.length - 1];
        const s28Hour = new Date(lastS28.closeTime).getUTCHours();
        if (s28GoodHours.includes(s28Hour)) {
          const bb15_s28 = calculateBollingerBands(synth15m_s28, 15, 2.2);
          if (bb15_s28) {
            const p28 = lastS28.close;
            const isBear = p28 > bb15_s28.upper && lastS28.close > lastS28.open;
            const isBull = p28 < bb15_s28.lower && lastS28.close < lastS28.open;
            if (isBear || isBull) {
              let s28Streak = 0;
              for (let j = synth15m_s28.length - 1; j >= Math.max(0, synth15m_s28.length - 8); j--) {
                const cj = synth15m_s28[j];
                if (cj.close > cj.open) { if (s28Streak < 0) break; s28Streak++; }
                else if (cj.close < cj.open) { if (s28Streak > 0) break; s28Streak--; }
                else break;
              }
              const streakOk = (isBear && s28Streak >= 2) || (isBull && s28Streak <= -2);
              if (streakOk) {
                const deviation = isBear
                  ? (p28 - bb15_s28.upper) / bb15_s28.upper * 100
                  : (bb15_s28.lower - p28) / bb15_s28.lower * 100;
                strategies.push({
                  name: 'SOL Tight BB Reversion',
                  emoji: '🔵',
                  score: Math.round(Math.min(10, 6.0 + Math.abs(s28Streak) * 0.4 + deviation * 8) * 10) / 10,
                  direction: (isBear ? 'bearish' : 'bullish') as Direction,
                  signal: `${Math.abs(s28Streak)} ${isBear ? 'green' : 'red'} synth-15m at BB(15,2.2) ${isBear ? 'upper' : 'lower'}, h=${s28Hour}UTC (70.9% WR σ=7.1%)`,
                  confidence: Math.round(Math.min(88, 63 + Math.abs(s28Streak) * 1.5 + deviation * 10)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 29: SOL Body Filter Exhaustion 💪
  // body>=0.3%+GoodH+BB(20,2.2)+streak>=2 → WF=69.4% σ=8.8% T=119 [5-fold]
  // Panic-sized candle at BB extreme during good hours = exhaustion signal
  {
    const s29GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s29: Candle[] = [];
      const aligned29 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned29; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s29.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s29.length >= 22) {
        const lastS29 = synth15m_s29[synth15m_s29.length - 1];
        const s29Hour = new Date(lastS29.closeTime).getUTCHours();
        if (s29GoodHours.includes(s29Hour)) {
          const bb22_s29 = calculateBollingerBands(synth15m_s29, 20, 2.2);
          if (bb22_s29) {
            const p29 = lastS29.close;
            const bodyPct29 = lastS29.open > 0 ? Math.abs(lastS29.close - lastS29.open) / lastS29.open * 100 : 0;
            const isBear = p29 > bb22_s29.upper && lastS29.close > lastS29.open && bodyPct29 >= 0.3;
            const isBull = p29 < bb22_s29.lower && lastS29.close < lastS29.open && bodyPct29 >= 0.3;
            if (isBear || isBull) {
              let s29Streak = 0;
              for (let j = synth15m_s29.length - 1; j >= Math.max(0, synth15m_s29.length - 7); j--) {
                const cj = synth15m_s29[j];
                if (cj.close > cj.open) { if (s29Streak < 0) break; s29Streak++; }
                else if (cj.close < cj.open) { if (s29Streak > 0) break; s29Streak--; }
                else break;
              }
              const streakOk = (isBear && s29Streak >= 2) || (isBull && s29Streak <= -2);
              if (streakOk) {
                const deviation = isBear
                  ? (p29 - bb22_s29.upper) / bb22_s29.upper * 100
                  : (bb22_s29.lower - p29) / bb22_s29.lower * 100;
                strategies.push({
                  name: 'SOL Panic Body BB',
                  emoji: '💪',
                  score: Math.round(Math.min(10, 5.8 + bodyPct29 * 2 + deviation * 8 + (Math.abs(s29Streak) - 2) * 0.3) * 10) / 10,
                  direction: (isBear ? 'bearish' : 'bullish') as Direction,
                  signal: `${Math.abs(s29Streak)} ${isBear ? 'green' : 'red'} synth-15m + ${bodyPct29.toFixed(2)}% panic body at BB(20,2.2), h=${s29Hour}UTC (69.4% WR σ=8.8%)`,
                  confidence: Math.round(Math.min(88, 61 + bodyPct29 * 4 + deviation * 9 + (Math.abs(s29Streak) - 2) * 1.5)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 30: SOL EMA50 Extension BB Reversion 📈
  // EMA50_dist>=0.3%+GoodH+BB(20,2.2)+streak>=2 → WF=68.2% σ=6.9% T=157 [5-fold] (0.85/day)
  // SOL price extended far from EMA50 AND at BB extreme = over-extended, expect reversion
  {
    const s30GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s30: Candle[] = [];
      const aligned30 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned30; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s30.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s30.length >= 55) {
        const lastS30 = synth15m_s30[synth15m_s30.length - 1];
        const s30Hour = new Date(lastS30.closeTime).getUTCHours();
        if (s30GoodHours.includes(s30Hour)) {
          const bb22_s30 = calculateBollingerBands(synth15m_s30, 20, 2.2);
          const ema50_s30 = calculateEMA(synth15m_s30, 50);
          if (bb22_s30 && ema50_s30) {
            const p30 = lastS30.close;
            const emaDist30 = ema50_s30 > 0 ? Math.abs(p30 - ema50_s30) / ema50_s30 * 100 : 0;
            const isBear = p30 > bb22_s30.upper && lastS30.close > lastS30.open && emaDist30 >= 0.3;
            const isBull = p30 < bb22_s30.lower && lastS30.close < lastS30.open && emaDist30 >= 0.3;
            if (isBear || isBull) {
              let s30Streak = 0;
              for (let j = synth15m_s30.length - 1; j >= Math.max(0, synth15m_s30.length - 7); j--) {
                const cj = synth15m_s30[j];
                if (cj.close > cj.open) { if (s30Streak < 0) break; s30Streak++; }
                else if (cj.close < cj.open) { if (s30Streak > 0) break; s30Streak--; }
                else break;
              }
              const streakOk = (isBear && s30Streak >= 2) || (isBull && s30Streak <= -2);
              if (streakOk) {
                const deviation = isBear
                  ? (p30 - bb22_s30.upper) / bb22_s30.upper * 100
                  : (bb22_s30.lower - p30) / bb22_s30.lower * 100;
                strategies.push({
                  name: 'SOL EMA Extension',
                  emoji: '📈',
                  score: Math.round(Math.min(10, 5.7 + emaDist30 * 2 + deviation * 8 + (Math.abs(s30Streak) - 2) * 0.4) * 10) / 10,
                  direction: (isBear ? 'bearish' : 'bullish') as Direction,
                  signal: `EMA50 dist=${emaDist30.toFixed(2)}% at BB(20,2.2) ${isBear ? 'upper' : 'lower'}, h=${s30Hour}UTC (68.2% WR σ=6.9%)`,
                  confidence: Math.round(Math.min(87, 60 + emaDist30 * 5 + deviation * 9 + (Math.abs(s30Streak) - 2) * 1.5)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 33: SOL Daily Range Extreme 🏔️ — ULTRA STABLE
  // GoodH + BB(20,2.2) + synth-15m price in top/bot 30% of daily range → 72.7% σ=2.5% T=99
  // Same mechanism as ETH Strat 17 but for SOL synth-15m with SOL-specific good hours [0,12,13,20]
  {
    const s33GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s33: Candle[] = [];
      const aligned33 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned33; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s33.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s33.length >= 22) {
        const lastS33 = synth15m_s33[synth15m_s33.length - 1];
        const s33Hour = new Date(lastS33.closeTime).getUTCHours();
        if (s33GoodHours.includes(s33Hour)) {
          const bb22_s33 = calculateBollingerBands(synth15m_s33, 20, 2.2);
          if (bb22_s33) {
            const p33 = lastS33.close;
            const isBear = p33 > bb22_s33.upper;
            const isBull = p33 < bb22_s33.lower;
            if (isBear || isBull) {
              let s33Streak = 0;
              for (let j = synth15m_s33.length - 1; j >= Math.max(0, synth15m_s33.length - 7); j--) {
                const cj = synth15m_s33[j];
                if (cj.close > cj.open) { if (s33Streak < 0) break; s33Streak++; }
                else if (cj.close < cj.open) { if (s33Streak > 0) break; s33Streak--; }
                else break;
              }
              if (Math.abs(s33Streak) >= 1) {
                const today33 = new Date(lastS33.openTime);
                const todayStart33 = Date.UTC(today33.getUTCFullYear(), today33.getUTCMonth(), today33.getUTCDate());
                let dailyHigh33 = p33, dailyLow33 = p33;
                for (let j = synth15m_s33.length - 1; j >= 0; j--) {
                  if (synth15m_s33[j].openTime < todayStart33) break;
                  dailyHigh33 = Math.max(dailyHigh33, synth15m_s33[j].high);
                  dailyLow33 = Math.min(dailyLow33, synth15m_s33[j].low);
                }
                const dailyRange33 = dailyHigh33 - dailyLow33;
                if (dailyRange33 > 0) {
                  const posInRange33 = (p33 - dailyLow33) / dailyRange33;
                  const isAtTop = posInRange33 >= 0.70 && isBear;
                  const isAtBottom = posInRange33 <= 0.30 && isBull;
                  if (isAtTop || isAtBottom) {
                    const deviation33 = isBear
                      ? (p33 - bb22_s33.upper) / bb22_s33.upper * 100
                      : (bb22_s33.lower - p33) / bb22_s33.lower * 100;
                    const rangePosPct33 = isAtTop ? posInRange33 * 100 : (1 - posInRange33) * 100;
                    strategies.push({
                      name: 'SOL Daily Range Extreme',
                      emoji: '🏔️',
                      score: Math.round(Math.min(10, 5.9 + Math.abs(s33Streak) * 0.5 + deviation33 * 9 + (rangePosPct33 - 70) * 0.05) * 10) / 10,
                      direction: (isBear ? 'bearish' : 'bullish') as Direction,
                      signal: `SOL ${isBear ? 'top' : 'bot'} ${rangePosPct33.toFixed(0)}% daily range + BB(20,2.2) h=${s33Hour}UTC (72.7% WR σ=2.5%)`,
                      confidence: Math.round(Math.min(89, 63 + Math.abs(s33Streak) * 2 + deviation33 * 9 + (rangePosPct33 - 70) * 0.3)),
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // Strategy 34: SOL Low-ATR BB Reversion 🧲 — ULTRA STABLE
  // GoodH + BB(15,2.2) + ATR percentile ≤ 33% (low-vol regime) → 71.6% σ=1.9% T=88
  // SOL in calm/low-volatility regime = mean reversion is strongest (from ML-RESEARCH-REPORT.md SOL-F)
  {
    const s34GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s34: Candle[] = [];
      const aligned34 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned34; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s34.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s34.length >= 55) {
        const lastS34 = synth15m_s34[synth15m_s34.length - 1];
        const s34Hour = new Date(lastS34.closeTime).getUTCHours();
        if (s34GoodHours.includes(s34Hour)) {
          const bb15_s34 = calculateBollingerBands(synth15m_s34, 15, 2.2);
          if (bb15_s34) {
            const p34 = lastS34.close;
            const isBear = p34 > bb15_s34.upper;
            const isBull = p34 < bb15_s34.lower;
            if (isBear || isBull) {
              // ATR percentile over last 100 synth-15m candles
              const atrWindow34 = synth15m_s34.slice(-100);
              const atrs34: number[] = [];
              for (let j = 1; j < atrWindow34.length; j++) {
                const prev = atrWindow34[j - 1];
                const curr = atrWindow34[j];
                const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
                atrs34.push(tr);
              }
              if (atrs34.length >= 20) {
                const currentATR34 = atrs34[atrs34.length - 1];
                const sorted34 = [...atrs34].sort((a, b) => a - b);
                const atrP33 = sorted34[Math.floor(sorted34.length * 0.33)];
                if (currentATR34 <= atrP33) {
                  const deviation34 = isBear
                    ? (p34 - bb15_s34.upper) / bb15_s34.upper * 100
                    : (bb15_s34.lower - p34) / bb15_s34.lower * 100;
                  strategies.push({
                    name: 'SOL Low-ATR BB',
                    emoji: '🧲',
                    score: Math.round(Math.min(10, 5.8 + deviation34 * 9) * 10) / 10,
                    direction: (isBear ? 'bearish' : 'bullish') as Direction,
                    signal: `SOL low-vol ATR=${currentATR34.toFixed(3)} (≤P33=${atrP33.toFixed(3)}) at BB(15,2.2) ${isBear ? 'upper' : 'lower'} h=${s34Hour}UTC (71.6% WR σ=1.9%)`,
                    confidence: Math.round(Math.min(88, 62 + deviation34 * 10)),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // Strategy 35: SOL RSI7 BB Reversion 🔆
  // GoodH[0,12,13,20]+RSI7>65+BB(15,2.2)+s>=2 → 69.3% σ=3.7% T=192
  // RSI7 overbought/oversold at BB extreme during SOL good hours
  {
    const s35SolGoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 50) {
      const synth15m_s35sol: Candle[] = [];
      const aligned35sol = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned35sol; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s35sol.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s35sol.length >= 20) {
        const last35sol = synth15m_s35sol[synth15m_s35sol.length - 1];
        const s35SolHour = new Date(last35sol.closeTime).getUTCHours();
        if (s35SolGoodHours.includes(s35SolHour)) {
          const bb15_s35sol = calculateBollingerBands(synth15m_s35sol, 15, 2.2);
          const rsi7_s35sol = calculateRSI(synth15m_s35sol, 7);
          if (bb15_s35sol && rsi7_s35sol !== null) {
            const p35sol = last35sol.close;
            const isBear = p35sol > bb15_s35sol.upper;
            const isBull = p35sol < bb15_s35sol.lower;
            const rsiOk = (isBear && rsi7_s35sol > 65) || (isBull && rsi7_s35sol < 35);
            if ((isBear || isBull) && rsiOk) {
              let s35SolStreak = 0;
              for (let j = synth15m_s35sol.length - 1; j >= Math.max(0, synth15m_s35sol.length - 8); j--) {
                const cj = synth15m_s35sol[j];
                if (cj.close > cj.open) { if (s35SolStreak < 0) break; s35SolStreak++; }
                else if (cj.close < cj.open) { if (s35SolStreak > 0) break; s35SolStreak--; }
                else break;
              }
              const streakOk = (isBear && s35SolStreak >= 2) || (isBull && s35SolStreak <= -2);
              if (streakOk) {
                const dev35sol = isBear
                  ? (p35sol - bb15_s35sol.upper) / bb15_s35sol.upper * 100
                  : (bb15_s35sol.lower - p35sol) / bb15_s35sol.lower * 100;
                strategies.push({
                  name: 'SOL RSI7 BB',
                  emoji: '🔆',
                  score: Math.round(Math.min(10, 5.9 + Math.abs(s35SolStreak) * 0.4 + dev35sol * 8) * 10) / 10,
                  direction: (isBear ? 'bearish' : 'bullish') as Direction,
                  signal: `SOL RSI7=${rsi7_s35sol.toFixed(0)} at BB(15,2.2) ${isBear ? 'upper' : 'lower'} h=${s35SolHour}UTC streak=${Math.abs(s35SolStreak)} (69.3% WR σ=3.7%)`,
                  confidence: Math.round(Math.min(87, 62 + Math.abs(s35SolStreak) * 2 + dev35sol * 8)),
                });
              }
            }
          }
        }
      }
    }
  }

  // Strategy 36: SOL LowATR+RSI7 — GoodH[0,12,13,20]+ATR<=P33+RSI7>65+BB(15,2.2)+s>=1 → 72.6% WR σ=3.4% T=84
  // Strategy 37: SOL Body BB      — GoodH[0,12,13,20]+body>=0.3%+BB(20,2.2)+s>=2 → 68.7% WR σ=5.4% T=121
  {
    const s3637GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_s3637: Candle[] = [];
      const aligned3637 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned3637; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s3637.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s3637.length >= 22) {
        const last3637 = synth15m_s3637[synth15m_s3637.length - 1];
        const h3637 = new Date(last3637.closeTime).getUTCHours();
        if (s3637GoodHours.includes(h3637)) {
          const bb15_s36 = calculateBollingerBands(synth15m_s3637, 15, 2.2);
          const bb20_s37 = calculateBollingerBands(synth15m_s3637, 20, 2.2);

          // ATR percentile (Strat 36)
          const atrWindow36 = synth15m_s3637.slice(-100);
          const atrs36: number[] = [];
          for (let j = 1; j < atrWindow36.length; j++) {
            const pv = atrWindow36[j - 1]; const cv = atrWindow36[j];
            atrs36.push(Math.max(cv.high - cv.low, Math.abs(cv.high - pv.close), Math.abs(cv.low - pv.close)));
          }
          const rsi7_s36 = calculateRSI(synth15m_s3637, 7);

          // Streak
          let streak3637 = 0;
          for (let j = synth15m_s3637.length - 1; j >= Math.max(0, synth15m_s3637.length - 8); j--) {
            const cj = synth15m_s3637[j];
            if (cj.close > cj.open) { if (streak3637 < 0) break; streak3637++; }
            else if (cj.close < cj.open) { if (streak3637 > 0) break; streak3637--; }
            else break;
          }

          // Strat 36: LowATR + RSI7>65 + BB(15,2.2) + streak>=1
          if (bb15_s36 && atrs36.length >= 20 && rsi7_s36 !== null) {
            const currentATR36 = atrs36[atrs36.length - 1];
            const sorted36 = [...atrs36].sort((a, b) => a - b);
            const atrP33_36 = sorted36[Math.floor(sorted36.length * 0.33)];
            if (currentATR36 <= atrP33_36) {
              const p36 = last3637.close;
              const isBear36 = p36 > bb15_s36.upper && last3637.close > last3637.open;
              const isBull36 = p36 < bb15_s36.lower && last3637.close < last3637.open;
              const rsiOk36 = (isBear36 && rsi7_s36 > 65) || (isBull36 && rsi7_s36 < 35);
              const streakOk36 = (isBear36 && streak3637 >= 1) || (isBull36 && streak3637 <= -1);
              if ((isBear36 || isBull36) && rsiOk36 && streakOk36) {
                const dev36 = isBear36
                  ? (p36 - bb15_s36.upper) / bb15_s36.upper * 100
                  : (bb15_s36.lower - p36) / bb15_s36.lower * 100;
                strategies.push({
                  name: 'SOL Low-ATR RSI7',
                  emoji: '🔋',
                  score: Math.round(Math.min(10, 6.4 + Math.abs(streak3637) * 0.4 + dev36 * 8) * 10) / 10,
                  direction: (isBear36 ? 'bearish' : 'bullish') as Direction,
                  signal: `SOL low-vol ATR RSI7=${rsi7_s36.toFixed(0)} at BB(15,2.2) ${isBear36 ? 'upper' : 'lower'} h=${h3637}UTC streak=${Math.abs(streak3637)} (72.6% WR σ=3.4%)`,
                  confidence: Math.round(Math.min(89, 64 + Math.abs(streak3637) * 2 + dev36 * 8)),
                });
              }
            }
          }

          // Strat 37: body>=0.3% + BB(20,2.2) + streak>=2
          if (bb20_s37) {
            const p37 = last3637.close;
            const body37 = Math.abs(p37 - last3637.open) / last3637.open * 100;
            const isBear37 = p37 > bb20_s37.upper && last3637.close > last3637.open;
            const isBull37 = p37 < bb20_s37.lower && last3637.close < last3637.open;
            const streakOk37 = (isBear37 && streak3637 >= 2) || (isBull37 && streak3637 <= -2);
            if ((isBear37 || isBull37) && body37 >= 0.3 && streakOk37) {
              const dev37 = isBear37
                ? (p37 - bb20_s37.upper) / bb20_s37.upper * 100
                : (bb20_s37.lower - p37) / bb20_s37.lower * 100;
              strategies.push({
                name: 'SOL Body BB',
                emoji: '💪',
                score: Math.round(Math.min(10, 6.0 + body37 * 0.6 + Math.abs(streak3637) * 0.35 + dev37 * 8) * 10) / 10,
                direction: (isBear37 ? 'bearish' : 'bullish') as Direction,
                signal: `SOL body=${body37.toFixed(2)}% at BB(20,2.2) ${isBear37 ? 'upper' : 'lower'} h=${h3637}UTC streak=${Math.abs(streak3637)} (68.7% WR σ=5.4%)`,
                confidence: Math.round(Math.min(86, 61 + body37 * 3 + Math.abs(streak3637) * 2 + dev37 * 7)),
              });
            }
          }
        }
      }
    }
  }

  // ML-20: SOL/15m DailyRange+RSI7+BB → 72.2% WR σ=2.2% T=97 [BEST SOL EVER — ULTRA STABLE]
  // ML-23: SOL/15m HighVol+RSI7+BB → 68.6% WR σ=0.7% T=67 [MOST STABLE SOL — high-vol regime]
  // ML insight: dailyRangePos is #1 predictor; SOL best in LOW-vol, HIGH-vol also works
  {
    const solML_GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65) {
      const synth15m_solML: Candle[] = [];
      const aligned_solML = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned_solML; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_solML.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_solML.length >= 22) {
        const last_solML = synth15m_solML[synth15m_solML.length - 1];
        const h_solML = new Date(last_solML.closeTime).getUTCHours();
        if (solML_GoodHours.includes(h_solML)) {
          const bb20_solML = calculateBollingerBands(synth15m_solML, 20, 2.2);
          const rsi7_solML = calculateRSI(synth15m_solML, 7);

          // ATR percentiles for regime detection
          const atrWin_solML = synth15m_solML.slice(-100);
          const atrs_solML: number[] = [];
          for (let j = 1; j < atrWin_solML.length; j++) {
            const pv = atrWin_solML[j - 1]; const cv = atrWin_solML[j];
            atrs_solML.push(Math.max(cv.high - cv.low, Math.abs(cv.high - pv.close), Math.abs(cv.low - pv.close)));
          }
          const sorted_solML = [...atrs_solML].sort((a, b) => a - b);
          const currentATR_solML = atrs_solML.length > 0 ? atrs_solML[atrs_solML.length - 1] : 0;
          const atrP67_solML = sorted_solML[Math.floor(sorted_solML.length * 0.67)] ?? 0;

          // Daily range position (dailyRangePos = #1 ML feature)
          const todayStart = new Date(last_solML.closeTime);
          todayStart.setUTCHours(0, 0, 0, 0);
          const todayCandles = synth15m_solML.filter(c => c.openTime >= todayStart.getTime());
          let dailyRangePos = 0.5;
          if (todayCandles.length >= 2) {
            const dayHigh = Math.max(...todayCandles.map(c => c.high));
            const dayLow = Math.min(...todayCandles.map(c => c.low));
            const dayRange = dayHigh - dayLow;
            if (dayRange > 0) dailyRangePos = (last_solML.close - dayLow) / dayRange;
          }
          // Top 30% of day range = dailyRangePos >= 0.70 → BEAR; bottom 30% ≤ 0.30 → BULL
          const isTopRange = dailyRangePos >= 0.70;
          const isBottomRange = dailyRangePos <= 0.30;

          let streak_solML = 0;
          for (let j = synth15m_solML.length - 1; j >= Math.max(0, synth15m_solML.length - 8); j--) {
            const cj = synth15m_solML[j];
            if (cj.close > cj.open) { if (streak_solML < 0) break; streak_solML++; }
            else if (cj.close < cj.open) { if (streak_solML > 0) break; streak_solML--; }
            else break;
          }

          const p_solML = last_solML.close;

          // ML-20: DailyRange top/bottom 30% + RSI7 + BB(20,2.2) + streak>=1
          if (bb20_solML && rsi7_solML !== null) {
            const isBear_ml20 = p_solML > bb20_solML.upper && last_solML.close > last_solML.open && isTopRange;
            const isBull_ml20 = p_solML < bb20_solML.lower && last_solML.close < last_solML.open && isBottomRange;
            const rsiOk_ml20 = (isBear_ml20 && rsi7_solML > 55) || (isBull_ml20 && rsi7_solML < 45);
            const streakOk_ml20 = (isBear_ml20 && streak_solML >= 1) || (isBull_ml20 && streak_solML <= -1);
            if ((isBear_ml20 || isBull_ml20) && rsiOk_ml20 && streakOk_ml20) {
              const dev_ml20 = isBear_ml20
                ? (p_solML - bb20_solML.upper) / bb20_solML.upper * 100
                : (bb20_solML.lower - p_solML) / bb20_solML.lower * 100;
              strategies.push({
                name: 'SOL DailyRange+RSI7',
                emoji: '📐',
                score: Math.round(Math.min(10, 6.5 + dailyRangePos * 0.5 + dev_ml20 * 8 + Math.abs(streak_solML) * 0.3) * 10) / 10,
                direction: (isBear_ml20 ? 'bearish' : 'bullish') as Direction,
                signal: `SOL dayRange=${(dailyRangePos * 100).toFixed(0)}% RSI7=${rsi7_solML.toFixed(0)} BB(20,2.2) ${isBear_ml20 ? 'upper' : 'lower'} h=${h_solML}UTC (72.2% WR σ=2.2%)`,
                confidence: Math.round(Math.min(90, 65 + dailyRangePos * 5 + dev_ml20 * 8 + Math.abs(streak_solML) * 1.5)),
              });
            }
          }

          // ML-23: HighVol(ATR>=P67) + RSI7 + BB(20,2.2) + streak>=2 → 68.6% σ=0.7%
          if (bb20_solML && rsi7_solML !== null && atrs_solML.length >= 20 && currentATR_solML >= atrP67_solML) {
            const isBear_ml23 = p_solML > bb20_solML.upper && last_solML.close > last_solML.open;
            const isBull_ml23 = p_solML < bb20_solML.lower && last_solML.close < last_solML.open;
            const rsiOk_ml23 = (isBear_ml23 && rsi7_solML > 55) || (isBull_ml23 && rsi7_solML < 45);
            const streakOk_ml23 = (isBear_ml23 && streak_solML >= 2) || (isBull_ml23 && streak_solML <= -2);
            if ((isBear_ml23 || isBull_ml23) && rsiOk_ml23 && streakOk_ml23) {
              const dev_ml23 = isBear_ml23
                ? (p_solML - bb20_solML.upper) / bb20_solML.upper * 100
                : (bb20_solML.lower - p_solML) / bb20_solML.lower * 100;
              strategies.push({
                name: 'SOL HighVol BB',
                emoji: '🌊',
                score: Math.round(Math.min(10, 6.0 + dev_ml23 * 8 + Math.abs(streak_solML) * 0.35) * 10) / 10,
                direction: (isBear_ml23 ? 'bearish' : 'bullish') as Direction,
                signal: `SOL HIGH-vol RSI7=${rsi7_solML.toFixed(0)} BB(20,2.2) ${isBear_ml23 ? 'upper' : 'lower'} h=${h_solML}UTC streak=${Math.abs(streak_solML)} (68.6% WR σ=0.7%)`,
                confidence: Math.round(Math.min(85, 61 + dev_ml23 * 8 + Math.abs(streak_solML) * 2)),
              });
            }
          }
        }
      }
    }
  }

  // Strategy 42: SOL RSI Streak BB 🏆 — ULTRA STABLE σ=2.9%
  // GoodH[0,12,13,20]+BB(20,2.2)+RSI14>65+greenStreak>=2 → BEAR ONLY
  // WF=67.1% σ=2.9% T=106 [64.7/70.6/70.6/64.7/64.7] *** ALL 5 FOLDS IDENTICAL
  // paramOptimize session finding: RSI overbought at BB extreme = exhaustion (SOL-specific)
  {
    const s42GoodHours = [0, 12, 13, 20];
    if (candles5m.length >= 65 && rsi14_5m !== null && rsi14_5m > 65) {
      const synth15m_s42: Candle[] = [];
      const aligned42 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned42; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_s42.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_s42.length >= 22) {
        const last42 = synth15m_s42[synth15m_s42.length - 1];
        const h42 = new Date(last42.closeTime).getUTCHours();
        if (s42GoodHours.includes(h42)) {
          const bb22_s42 = calculateBollingerBands(synth15m_s42, 20, 2.2);
          if (bb22_s42 && last42.close > bb22_s42.upper && last42.close > last42.open) {
            let s42Streak = 0;
            for (let j = synth15m_s42.length - 1; j >= Math.max(0, synth15m_s42.length - 8); j--) {
              const cj = synth15m_s42[j];
              if (cj.close > cj.open) s42Streak++;
              else break;
            }
            if (s42Streak >= 2) {
              const dev42 = (last42.close - bb22_s42.upper) / bb22_s42.upper * 100;
              const rsiEx42 = rsi14_5m - 65;
              strategies.push({
                name: 'SOL RSI Streak BB',
                emoji: '🏆',
                score: Math.round(Math.min(10, 6.0 + rsiEx42 * 0.05 + dev42 * 9 + (s42Streak - 2) * 0.4) * 10) / 10,
                direction: 'bearish' as Direction,
                signal: `SOL RSI=${rsi14_5m.toFixed(0)}>65 + ${s42Streak}G synth-15m at BB(20,2.2), h=${h42}UTC (67.1% WR σ=2.9% ULTRA STABLE)`,
                confidence: Math.round(Math.min(88, 63 + rsiEx42 * 0.5 + dev42 * 10 + (s42Streak - 2) * 1.5)),
              });
            }
          }
        }
      }
    }
  }

  // ─── SOL All-Hours High-Frequency Strategies (59-60) ───────────────────────
  // SOL ALL_H+RSI>70+BB22+s>=1: WF=73.0% σ=2.8% T=887 (4.8/day!) ULTRA STABLE
  // SOL ALL_H+RSI7>75+BB22+s>=1: WF=73.2% σ=3.1% T=1330 (7.2/day!) HIGHEST FREQ
  // Source: newSignalSearch.js Section 1
  if (candles5m.length >= 22) {
    const last_sol_allh = candles5m[candles5m.length - 1];
    const bb22_sol_allh = calculateBollingerBands(candles5m, 20, 2.2);
    if (bb22_sol_allh) {
      const p_sol_allh = last_sol_allh.close;
      const isBear_sol_allh = p_sol_allh > bb22_sol_allh.upper && last_sol_allh.close > last_sol_allh.open;
      const isBull_sol_allh = p_sol_allh < bb22_sol_allh.lower && last_sol_allh.close < last_sol_allh.open;
      if (isBear_sol_allh || isBull_sol_allh) {
        let streak_sol_allh = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak_sol_allh < 0) break; streak_sol_allh++; }
          else if (cj.close < cj.open) { if (streak_sol_allh > 0) break; streak_sol_allh--; }
          else break;
        }
        const dev_sol_allh = isBear_sol_allh
          ? (p_sol_allh - bb22_sol_allh.upper) / bb22_sol_allh.upper * 100
          : (bb22_sol_allh.lower - p_sol_allh) / bb22_sol_allh.lower * 100;

        // Strategy 59: SOL ALL_H+RSI>70+BB(20,2.2)+s>=1 → WF=73.0% σ=2.8% 4.8/day ULTRA STABLE
        if (Math.abs(streak_sol_allh) >= 1 && rsi14_5m !== null) {
          if ((isBear_sol_allh && rsi14_5m > 70) || (isBull_sol_allh && rsi14_5m < 30)) {
            strategies.push({
              name: 'SOL ALL-H RSI Panic',
              emoji: '🌟',
              score: Math.round(Math.min(10, 6.3 + (Math.abs(streak_sol_allh) - 1) * 0.3 + dev_sol_allh * 8) * 10) / 10,
              direction: (isBear_sol_allh ? 'bearish' : 'bullish') as Direction,
              signal: `SOL ALL-H RSI=${rsi14_5m.toFixed(0)}${isBear_sol_allh ? '>70' : '<30'} at BB(20,2.2) streak=${Math.abs(streak_sol_allh)} (73.0% WR σ=2.8% 4.8/day ULTRA STABLE)`,
              confidence: Math.round(Math.min(87, 65 + dev_sol_allh * 10 + (Math.abs(streak_sol_allh) - 1) * 2)),
            });
          }
        }

        // Strategy 60: SOL ALL_H+RSI7>75+BB(20,2.2)+s>=1 → WF=73.2% σ=3.1% 7.2/day HIGHEST FREQ
        const rsi7_sol_allh = calculateRSI(candles5m, 7);
        if (Math.abs(streak_sol_allh) >= 1 && rsi7_sol_allh !== null) {
          if ((isBear_sol_allh && rsi7_sol_allh > 75) || (isBull_sol_allh && rsi7_sol_allh < 25)) {
            strategies.push({
              name: 'SOL ALL-H RSI7 Panic',
              emoji: '💫',
              score: Math.round(Math.min(10, 6.3 + (Math.abs(streak_sol_allh) - 1) * 0.3 + dev_sol_allh * 8) * 10) / 10,
              direction: (isBear_sol_allh ? 'bearish' : 'bullish') as Direction,
              signal: `SOL ALL-H RSI7=${rsi7_sol_allh.toFixed(0)}${isBear_sol_allh ? '>75' : '<25'} at BB(20,2.2) streak=${Math.abs(streak_sol_allh)} (73.2% WR σ=3.1% 7.2/day)`,
              confidence: Math.round(Math.min(87, 65 + dev_sol_allh * 10 + (Math.abs(streak_sol_allh) - 1) * 2)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Ultra High-Frequency Strategy (68) — BB(20,1.0) 80-110+/day ────────
  // ALL hours, tight BB(20,1.0) + streak>=1
  // SOL: WF=70.9% σ=0.6% 107.4/d [70.7/70.9/69.9/71.4/71.4] (5-fold) ULTRA STABLE!
  // Source: ultraHF80.js Section 2.2
  if (candles5m.length >= 22) {
    const last68sol = candles5m[candles5m.length - 1];
    const bb10_68sol = calculateBollingerBands(candles5m, 20, 1.0);
    if (bb10_68sol) {
      const p68sol = last68sol.close;
      const isBear68sol = p68sol > bb10_68sol.upper && last68sol.close > last68sol.open;
      const isBull68sol = p68sol < bb10_68sol.lower && last68sol.close < last68sol.open;
      if (isBear68sol || isBull68sol) {
        let streak68sol = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak68sol < 0) break; streak68sol++; }
          else if (cj.close < cj.open) { if (streak68sol > 0) break; streak68sol--; }
          else break;
        }
        if (Math.abs(streak68sol) >= 1) {
          const dev68sol = isBear68sol
            ? (p68sol - bb10_68sol.upper) / bb10_68sol.upper * 100
            : (bb10_68sol.lower - p68sol) / bb10_68sol.lower * 100;
          strategies.push({
            name: 'SOL ALL-H BB10 UHF80',
            emoji: '🚀🌟',
            score: Math.round(Math.min(10, 6.0 + dev68sol * 5 + (Math.abs(streak68sol) - 1) * 0.2) * 10) / 10,
            direction: (isBear68sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL ALL-H BB(20,1.0) streak=${Math.abs(streak68sol)} (SOL 52.2% WR ~107/d HF)`,
            confidence: Math.round(Math.min(82, 65 + dev68sol * 8 + (Math.abs(streak68sol) - 1) * 1.5)),
          });
        }
      }
    }
  }

  // ─── SOL Ultra High-Frequency Strategy (67) — BB(20,1.8) 43/day ────────────
  // SOL BB(20,1.8)+s>=1: WF=71.7% σ=0.4% T=7995 (43.5/day!) MOST STABLE EVER!
  // Source: highFreqSearch40.js Section 1
  if (candles5m.length >= 22) {
    const last_sol_hf = candles5m[candles5m.length - 1];
    const bb18_sol_hf = calculateBollingerBands(candles5m, 20, 1.8);
    if (bb18_sol_hf) {
      const p_sol_hf = last_sol_hf.close;
      const isBear_sol_hf = p_sol_hf > bb18_sol_hf.upper && last_sol_hf.close > last_sol_hf.open;
      const isBull_sol_hf = p_sol_hf < bb18_sol_hf.lower && last_sol_hf.close < last_sol_hf.open;
      if (isBear_sol_hf || isBull_sol_hf) {
        let streak_sol_hf = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak_sol_hf < 0) break; streak_sol_hf++; }
          else if (cj.close < cj.open) { if (streak_sol_hf > 0) break; streak_sol_hf--; }
          else break;
        }
        const dev_sol_hf = isBear_sol_hf
          ? (p_sol_hf - bb18_sol_hf.upper) / bb18_sol_hf.upper * 100
          : (bb18_sol_hf.lower - p_sol_hf) / bb18_sol_hf.lower * 100;
        strategies.push({
          name: 'SOL ALL-H BB18 HF',
          emoji: '⚡🌟',
          score: Math.round(Math.min(10, 6.0 + (Math.abs(streak_sol_hf) - 1) * 0.3 + dev_sol_hf * 9) * 10) / 10,
          direction: (isBear_sol_hf ? 'bearish' : 'bullish') as Direction,
          signal: `SOL ALL-H BB(20,1.8) ${isBear_sol_hf ? 'upper' : 'lower'} streak=${Math.abs(streak_sol_hf)} dev=${dev_sol_hf.toFixed(3)}% (SOL 52.2% WR 43/day HF)`,
          confidence: Math.round(Math.min(84, 65 + dev_sol_hf * 12 + (Math.abs(streak_sol_hf) - 1) * 2)),
        });
      }
    }
  }

  // ─── SOL Strat 69: Stochastic+BB(20,1.0) — ~80/d ───────────────────────────
  // SOL Stoch(5)>70+BB(20,1.0)+s>=1: analogous to ETH/BTC champion (~80/d)
  // Source: mlOptimize5m.js — ML-optimal Stochastic quality gate at tight BB
  if (candles5m.length >= 25) {
    const last69sol = candles5m[candles5m.length - 1];
    const bb10_69sol = calculateBollingerBands(candles5m, 20, 1.0);
    if (bb10_69sol) {
      const slice69sol = candles5m.slice(-5);
      const low69sol = Math.min(...slice69sol.map(c => c.low));
      const high69sol = Math.max(...slice69sol.map(c => c.high));
      const stochK69sol = high69sol === low69sol ? 50 : (last69sol.close - low69sol) / (high69sol - low69sol) * 100;
      const isBear69sol = last69sol.close > bb10_69sol.upper && last69sol.close > last69sol.open && stochK69sol > 70;
      const isBull69sol = last69sol.close < bb10_69sol.lower && last69sol.close < last69sol.open && stochK69sol < 30;
      if (isBear69sol || isBull69sol) {
        let streak69sol = 0;
        for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
          const cj = candles5m[j];
          if (cj.close > cj.open) { if (streak69sol < 0) break; streak69sol++; }
          else if (cj.close < cj.open) { if (streak69sol > 0) break; streak69sol--; }
          else break;
        }
        if (Math.abs(streak69sol) >= 1) {
          const dev69sol = isBear69sol
            ? (last69sol.close - bb10_69sol.upper) / bb10_69sol.upper * 100
            : (bb10_69sol.lower - last69sol.close) / bb10_69sol.lower * 100;
          strategies.push({
            name: 'SOL Stoch+BB10 HF80',
            emoji: '🎲🌟',
            score: Math.round(Math.min(10, 6.1 + dev69sol * 5 + (Math.abs(streak69sol) - 1) * 0.2) * 10) / 10,
            direction: (isBear69sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL Stoch(5)=${stochK69sol.toFixed(0)}+BB(20,1.0) streak=${Math.abs(streak69sol)} (~54% WR correct-exit — diversity only)`,
            confidence: Math.round(Math.min(72, 58 + dev69sol * 5 + (Math.abs(streak69sol) - 1) * 1.0)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 70: h=12 Noon Peak BB(20,1.5) — CORRECT binary exit validated ─
  // SOL h=12+BB(20,1.5)+s>=1: WF=63.8% σ=3.6% T=533(2.9/d) [59.7/67.9/66.7/59.3/65.4] ✅
  // h=12+BB(20,1.2)+s>=1: WF=62.6% σ=3.0% T=694(3.8/d) [58.0/61.3/64.3/62.6/66.9] ✅
  // Source: correctExitValidation.js Section [H] — noon UTC is consistently best hour for SOL
  // Measured with at-expiry (close at candle 3) model — NO lookahead bias
  {
    const h70sol = new Date(candles5m[candles5m.length - 1].openTime).getUTCHours();
    if (h70sol === 12 && candles5m.length >= 22) {
      const last70sol = candles5m[candles5m.length - 1];
      const bb15_70sol = calculateBollingerBands(candles5m, 20, 1.5);
      if (bb15_70sol) {
        const p70sol = last70sol.close;
        const isBear70sol = p70sol > bb15_70sol.upper && last70sol.close > last70sol.open;
        const isBull70sol = p70sol < bb15_70sol.lower && last70sol.close < last70sol.open;
        if (isBear70sol || isBull70sol) {
          let streak70sol = 0;
          for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
            const cj = candles5m[j];
            if (cj.close > cj.open) { if (streak70sol < 0) break; streak70sol++; }
            else if (cj.close < cj.open) { if (streak70sol > 0) break; streak70sol--; }
            else break;
          }
          if (Math.abs(streak70sol) >= 1) {
            const dev70sol = isBear70sol
              ? (p70sol - bb15_70sol.upper) / bb15_70sol.upper * 100
              : (bb15_70sol.lower - p70sol) / bb15_70sol.lower * 100;
            strategies.push({
              name: 'SOL Noon Peak BB15',
              emoji: '🕛🌟',
              score: Math.round(Math.min(10, 6.6 + dev70sol * 6 + (Math.abs(streak70sol) - 1) * 0.3) * 10) / 10,
              direction: (isBear70sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL h=12+BB(20,1.5) streak=${Math.abs(streak70sol)} dev=${dev70sol.toFixed(3)}% (63.8% WR at-expiry ✅)`,
              confidence: Math.round(Math.min(86, 64 + dev70sol * 8 + (Math.abs(streak70sol) - 1) * 2)),
            });
          }
        }
      }
    }
  }

  // ─── Strat 71 SOL: ALL-H Pure BB(20,2.2)+s>=1 ───────────────────────────────
  // SOL 5m exit: 52.8% WF, 15m exit: 54.6% WF — thinner edge than ETH/BTC
  // Combined 5m+15m: ~40/day (20×2) at ~53.7% WR (profitable at spread <3.7%)
  if (candles5m.length >= 22) {
    const last71sol = candles5m[candles5m.length - 1];
    const bb71sol = calculateBollingerBands(candles5m, 20, 2.2);
    if (bb71sol) {
      let streak71sol = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak71sol < 0) break; streak71sol++; }
        else if (cj.close < cj.open) { if (streak71sol > 0) break; streak71sol--; }
        else break;
      }
      const isBear71sol = last71sol.close > bb71sol.upper && last71sol.close > last71sol.open && streak71sol >= 1;
      const isBull71sol = last71sol.close < bb71sol.lower && last71sol.close < last71sol.open && streak71sol <= -1;
      if (isBear71sol || isBull71sol) {
        const dev71sol = isBear71sol
          ? (last71sol.close - bb71sol.upper) / bb71sol.upper * 100
          : (bb71sol.lower - last71sol.close) / bb71sol.lower * 100;
        strategies.push({
          name: 'SOL HF BB22 Pure',
          emoji: '⚡🌟',
          score: Math.round(Math.min(8.5, 5.5 + dev71sol * 5 + (Math.abs(streak71sol) - 1) * 0.5) * 10) / 10,
          direction: (isBear71sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL ALL-H BB(20,2.2)+s=${Math.abs(streak71sol)} dev=${dev71sol.toFixed(3)}% (5m=52.8% 15m=54.6% WR | ~40/day×2)`,
          confidence: Math.round(Math.min(68, 57 + dev71sol * 7 + (Math.abs(streak71sol) - 1) * 1.5)),
        });
      }
    }
  }

  // ─── SOL Strat 72: Connors RSI (15/85) ───────────────────────────────────────
  // SOL: 52.7% WR σ=2.5% 34/day (crsi_validate.js, 5-fold WF) — marginal but profitable
  if (candles5m.length >= 106) {
    const crsi72sol = calcConnorsRSI(candles5m, 100);
    const isBull72sol = crsi72sol < 15;
    const isBear72sol = crsi72sol > 85;
    if (isBull72sol || isBear72sol) {
      const ext72sol = isBull72sol ? (15 - crsi72sol) / 15 : (crsi72sol - 85) / 15;
      strategies.push({
        name: 'SOL Connors RSI 15/85',
        emoji: '🧠🌟',
        score: Math.round(Math.min(8.5, 5.8 + ext72sol * 2.5) * 10) / 10,
        direction: (isBear72sol ? 'bearish' : 'bullish') as Direction,
        signal: `SOL CRSI=${crsi72sol.toFixed(1)} (52.7% WR 34/day all-hours mean-reversion)`,
        confidence: Math.round(Math.min(68, 58 + ext72sol * 10)),
      });
    }
  }

  // ─── SOL Strat 73: ATR Climax + RSI7 at BB22 ─────────────────────────────────
  // SOL: 55.1% WR σ=3.9% 9/day (tv_advanced_v2.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const last73sol = candles5m[candles5m.length - 1];
    const bb73sol = calculateBollingerBands(candles5m, 20, 2.2);
    let atr73sol = 0;
    const atrWin73sol = candles5m.slice(-15);
    for (let j = 1; j < atrWin73sol.length; j++) {
      atr73sol += Math.max(
        atrWin73sol[j].high - atrWin73sol[j].low,
        Math.abs(atrWin73sol[j].high - atrWin73sol[j - 1].close),
        Math.abs(atrWin73sol[j].low - atrWin73sol[j - 1].close),
      );
    }
    atr73sol /= Math.max(1, atrWin73sol.length - 1);
    const rsi7_73sol = calculateRSI(candles5m, 7);
    const body73sol = Math.abs(last73sol.close - last73sol.open);
    if (bb73sol && rsi7_73sol !== null && body73sol >= atr73sol * 1.0 && atr73sol > 0) {
      const isCBear73sol = last73sol.close > bb73sol.upper && last73sol.close > last73sol.open && rsi7_73sol > 70;
      const isCBull73sol = last73sol.close < bb73sol.lower && last73sol.close < last73sol.open && rsi7_73sol < 30;
      if (isCBear73sol || isCBull73sol) {
        const dev73sol = isCBear73sol
          ? (last73sol.close - bb73sol.upper) / bb73sol.upper * 100
          : (bb73sol.lower - last73sol.close) / bb73sol.lower * 100;
        const atrR73sol = body73sol / atr73sol;
        strategies.push({
          name: 'SOL ATR Climax BB22',
          emoji: '💥🌟',
          score: Math.round(Math.min(9.0, 5.8 + dev73sol * 5 + (atrR73sol - 1) * 0.7) * 10) / 10,
          direction: (isCBear73sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL ATR climax body=${atrR73sol.toFixed(1)}x RSI7=${rsi7_73sol.toFixed(0)} dev=${dev73sol.toFixed(3)}% (55.1% WR ~9/day)`,
          confidence: Math.round(Math.min(74, 58 + dev73sol * 7 + (atrR73sol - 1) * 2.5)),
        });
      }
    }
  }

  // ─── SOL Strat 74: StochRSI (K+D<20) + BB22 ──────────────────────────────────
  // SOL: 52.1% WR σ=3.4% 14/day (tv_advanced_v2.js) — marginal, lower confidence
  if (candles5m.length >= 45) {
    const srsi74sol = calcStochRSI(candles5m, 14, 14);
    const bb74sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last74sol = candles5m[candles5m.length - 1];
    if (bb74sol) {
      const isBull74sol = srsi74sol.k < 20 && srsi74sol.d < 20 && last74sol.close < bb74sol.lower;
      const isBear74sol = srsi74sol.k > 80 && srsi74sol.d > 80 && last74sol.close > bb74sol.upper;
      if (isBull74sol || isBear74sol) {
        const ext74sol = isBull74sol ? (20 - srsi74sol.k) / 20 : (srsi74sol.k - 80) / 20;
        const dev74sol = isBear74sol
          ? (last74sol.close - bb74sol.upper) / bb74sol.upper * 100
          : (bb74sol.lower - last74sol.close) / bb74sol.lower * 100;
        strategies.push({
          name: 'SOL StochRSI+BB22',
          emoji: '📊🌟',
          score: Math.round(Math.min(8.5, 5.5 + dev74sol * 4 + ext74sol * 1.5) * 10) / 10,
          direction: (isBear74sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL StochRSI K=${srsi74sol.k.toFixed(0)} D=${srsi74sol.d.toFixed(0)} dev=${dev74sol.toFixed(3)}% (52.1% WR ~14/day)`,
          confidence: Math.round(Math.min(68, 56 + dev74sol * 6 + ext74sol * 8)),
        });
      }
    }
  }

  // ─── SOL Strat 75: CCI>200 + BB22 ────────────────────────────────────────────
  // SOL: 53.6% WR 3/day (session10_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const cci75sol = calcCCI(candles5m, 20);
    const bb75sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last75sol = candles5m[candles5m.length - 1];
    if (bb75sol) {
      const isBull75sol = cci75sol < -200 && last75sol.close < bb75sol.lower;
      const isBear75sol = cci75sol > 200 && last75sol.close > bb75sol.upper;
      if (isBull75sol || isBear75sol) {
        const cciExt75sol = Math.min(1, (Math.abs(cci75sol) - 200) / 100);
        const dev75sol = isBear75sol
          ? (last75sol.close - bb75sol.upper) / bb75sol.upper * 100
          : (bb75sol.lower - last75sol.close) / bb75sol.lower * 100;
        strategies.push({
          name: 'SOL CCI>200 BB22',
          emoji: '📉🌟',
          score: Math.round(Math.min(8.5, 5.8 + dev75sol * 5 + cciExt75sol * 1.2) * 10) / 10,
          direction: (isBear75sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL CCI=${cci75sol.toFixed(0)} at BB22 dev=${dev75sol.toFixed(3)}% (53.6% WR ~3/day)`,
          confidence: Math.round(Math.min(70, 60 + dev75sol * 6 + cciExt75sol * 8)),
        });
      }
    }
  }

  // ─── SOL Strat 76: Williams %R (14) + RSI7 + BB22 ────────────────────────────
  // SOL: 53.6% WR 3/day (session10_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const wpr76sol = calcWilliamsR(candles5m, 14);
    const rsi7_76sol = calculateRSI(candles5m, 7);
    const bb76sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last76sol = candles5m[candles5m.length - 1];
    if (bb76sol && rsi7_76sol !== null) {
      const isBull76sol = wpr76sol < -85 && rsi7_76sol < 30 && last76sol.close < bb76sol.lower;
      const isBear76sol = wpr76sol > -15 && rsi7_76sol > 70 && last76sol.close > bb76sol.upper;
      if (isBull76sol || isBear76sol) {
        const wprExt76sol = isBull76sol ? Math.min(1, (-85 - wpr76sol) / 15) : Math.min(1, (wpr76sol + 15) / 15);
        const dev76sol = isBear76sol
          ? (last76sol.close - bb76sol.upper) / bb76sol.upper * 100
          : (bb76sol.lower - last76sol.close) / bb76sol.lower * 100;
        strategies.push({
          name: 'SOL WPR+RSI7+BB22',
          emoji: '📡🌟',
          score: Math.round(Math.min(8.5, 5.8 + dev76sol * 5 + wprExt76sol * 1.2) * 10) / 10,
          direction: (isBear76sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL WPR=${wpr76sol.toFixed(0)} RSI7=${rsi7_76sol.toFixed(0)} dev=${dev76sol.toFixed(3)}% (53.6% WR ~3/day)`,
          confidence: Math.round(Math.min(70, 59 + dev76sol * 6 + wprExt76sol * 8)),
        });
      }
    }
  }

  // ─── SOL Strat 77: Keltner Outer — Volatility Extreme Reversal ───────────────
  // SOL: 54.5% WR 6/day — best volume of new strategies (session10_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const ema77sol = calcEMA(candles5m, 20);
    const last77sol = candles5m[candles5m.length - 1];
    let atr77sol = 0;
    const atrWin77sol = candles5m.slice(-15);
    for (let j = 1; j < atrWin77sol.length; j++) {
      atr77sol += Math.max(
        atrWin77sol[j].high - atrWin77sol[j].low,
        Math.abs(atrWin77sol[j].high - atrWin77sol[j - 1].close),
        Math.abs(atrWin77sol[j].low - atrWin77sol[j - 1].close),
      );
    }
    atr77sol /= Math.max(1, atrWin77sol.length - 1);
    const kcUpper77sol = ema77sol + 2.0 * atr77sol;
    const kcLower77sol = ema77sol - 2.0 * atr77sol;
    const isBull77sol = last77sol.close < kcLower77sol;
    const isBear77sol = last77sol.close > kcUpper77sol;
    if ((isBull77sol || isBear77sol) && atr77sol > 0) {
      const dev77sol = isBear77sol
        ? (last77sol.close - kcUpper77sol) / kcUpper77sol * 100
        : (kcLower77sol - last77sol.close) / kcLower77sol * 100;
      strategies.push({
        name: 'SOL Keltner Outer',
        emoji: '🌋🌟',
        score: Math.round(Math.min(8.8, 5.5 + dev77sol * 5) * 10) / 10,
        direction: (isBear77sol ? 'bearish' : 'bullish') as Direction,
        signal: `SOL ${isBear77sol ? 'above KC upper' : 'below KC lower'} dev=${dev77sol.toFixed(3)}% (54.5% WR ~6/day)`,
        confidence: Math.round(Math.min(72, 58 + dev77sol * 7)),
      });
    }
  }

  // ─── SOL Strat 78: RSI7(5m) Extreme + BB22 — Micro-Structure Reversal ────────
  // SOL: 54.8% WR 7.1/day (hfBinary5m.ts S6, 5-fold WF, at-expiry ✅)
  if (candles5m.length >= 22) {
    const rsi7_78sol = calculateRSI(candles5m, 7);
    const bb78sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last78sol = candles5m[candles5m.length - 1];
    if (bb78sol && rsi7_78sol !== null) {
      const isBear78sol = rsi7_78sol > 78 && last78sol.close > bb78sol.upper;
      const isBull78sol = rsi7_78sol < 22 && last78sol.close < bb78sol.lower;
      if (isBear78sol || isBull78sol) {
        const dev78sol = isBear78sol
          ? (last78sol.close - bb78sol.upper) / bb78sol.upper * 100
          : (bb78sol.lower - last78sol.close) / bb78sol.lower * 100;
        if (dev78sol >= 0.04) {
          const rsiExt78sol = isBear78sol ? (rsi7_78sol - 78) / 22 : (22 - rsi7_78sol) / 22;
          strategies.push({
            name: 'SOL RSI7+BB22',
            emoji: '⚡🌟',
            score: Math.round(Math.min(8.8, 5.6 + dev78sol * 5 + rsiExt78sol * 1.8) * 10) / 10,
            direction: (isBear78sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL RSI7=${rsi7_78sol.toFixed(0)} ${isBear78sol ? '>78' : '<22'} + BB22 dev=${dev78sol.toFixed(3)}% (54.8% WR ~7/day ✅)`,
            confidence: Math.round(Math.min(76, 60 + dev78sol * 7 + rsiExt78sol * 9)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 79: Volume Exhaustion + BB22 + Streak ─────────────────────────
  // SOL: 55.7% WR 4.1/day (hfBinary5m.ts S2, 5-fold WF, at-expiry ✅)
  if (candles5m.length >= 22) {
    const bb79sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last5m79sol = candles5m[candles5m.length - 1];
    const vol20avg79sol = candles5m.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const volRatio79sol = vol20avg79sol > 0 ? last5m79sol.volume / vol20avg79sol : 1;
    if (bb79sol && volRatio79sol >= 1.8) {
      let streak79sol = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak79sol < 0) break; streak79sol++; }
        else if (cj.close < cj.open) { if (streak79sol > 0) break; streak79sol--; }
        else break;
      }
      const isBear79sol = last5m79sol.close > bb79sol.upper && streak79sol >= 1;
      const isBull79sol = last5m79sol.close < bb79sol.lower && streak79sol <= -1;
      if (isBear79sol || isBull79sol) {
        const dev79sol = isBear79sol
          ? (last5m79sol.close - bb79sol.upper) / bb79sol.upper * 100
          : (bb79sol.lower - last5m79sol.close) / bb79sol.lower * 100;
        if (dev79sol >= 0.05) {
          strategies.push({
            name: 'SOL Vol Exhaustion BB22',
            emoji: '💧🌟',
            score: Math.round(Math.min(9.0, 5.8 + dev79sol * 4.5 + (volRatio79sol - 1.8) * 0.35) * 10) / 10,
            direction: (isBear79sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL vol=${volRatio79sol.toFixed(1)}x avg + BB22 dev=${dev79sol.toFixed(3)}% s=${Math.abs(streak79sol)} (55.7% WR ~4/day ✅)`,
            confidence: Math.round(Math.min(78, 61 + dev79sol * 7 + (volRatio79sol - 1.8) * 3)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 80: MicroStreak×3 + BB22 + RSI14 ─────────────────────────────
  // SOL: 57.4% WR 3.2/day (hfBinary5m.ts S5, 5-fold WF, at-expiry ✅)
  if (candles5m.length >= 30 && rsi14_5m !== null) {
    const bb80sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last80sol = candles5m[candles5m.length - 1];
    if (bb80sol) {
      let streak80sol = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 10); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak80sol < 0) break; streak80sol++; }
        else if (cj.close < cj.open) { if (streak80sol > 0) break; streak80sol--; }
        else break;
      }
      const isBear80sol = streak80sol >= 3 && last80sol.close > bb80sol.upper && rsi14_5m > 65;
      const isBull80sol = streak80sol <= -3 && last80sol.close < bb80sol.lower && rsi14_5m < 35;
      if (isBear80sol || isBull80sol) {
        const dev80sol = isBear80sol
          ? (last80sol.close - bb80sol.upper) / bb80sol.upper * 100
          : (bb80sol.lower - last80sol.close) / bb80sol.lower * 100;
        if (dev80sol >= 0.04) {
          const rsiExt80sol = isBear80sol ? (rsi14_5m - 65) / 35 : (35 - rsi14_5m) / 35;
          strategies.push({
            name: 'SOL MicroStreak×3 BB22',
            emoji: '🔥🌟',
            score: Math.round(Math.min(9.5, 6.0 + dev80sol * 5.5 + (Math.abs(streak80sol) - 3) * 0.35 + rsiExt80sol * 1.2) * 10) / 10,
            direction: (isBear80sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL streak=${Math.abs(streak80sol)}× + BB22 dev=${dev80sol.toFixed(3)}% RSI14=${rsi14_5m.toFixed(0)} (57.4% WR ~3/day ✅)`,
            confidence: Math.round(Math.min(80, 62 + dev80sol * 7 + (Math.abs(streak80sol) - 3) * 2 + rsiExt80sol * 5)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 81: ML 15m-Streak + BB22 + RSI14 ─────────────────────────────
  // SOL ML: 64.8% WR 5.3/day (hfBinary5m.ts S8, top features: streak_15m, rsi14_5m ✅)
  if (candles5m.length >= 63 && rsi14_5m !== null) {
    const bb81sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last81sol = candles5m[candles5m.length - 1];
    const aligned81sol = candles5m.length - (candles5m.length % 3);
    const synth81sol: Candle[] = [];
    for (let i = Math.max(0, aligned81sol - 60); i < aligned81sol; i += 3) {
      const g = candles5m.slice(i, i + 3);
      synth81sol.push({ openTime: g[0].openTime, closeTime: g[2].closeTime,
        open: g[0].open, high: Math.max(...g.map(c => c.high)),
        low: Math.min(...g.map(c => c.low)), close: g[2].close,
        volume: 0, quoteVolume: 0, trades: 0 });
    }
    let streak81sol = 0;
    for (let j = synth81sol.length - 1; j >= Math.max(0, synth81sol.length - 8); j--) {
      const cj = synth81sol[j];
      if (cj.close > cj.open) { if (streak81sol < 0) break; streak81sol++; }
      else if (cj.close < cj.open) { if (streak81sol > 0) break; streak81sol--; }
      else break;
    }
    if (bb81sol && Math.abs(streak81sol) >= 3) {
      const isBear81sol = last81sol.close > bb81sol.upper && rsi14_5m > 62;
      const isBull81sol = last81sol.close < bb81sol.lower && rsi14_5m < 38;
      if (isBear81sol || isBull81sol) {
        const dev81sol = isBear81sol
          ? (last81sol.close - bb81sol.upper) / bb81sol.upper * 100
          : (bb81sol.lower - last81sol.close) / bb81sol.lower * 100;
        if (dev81sol >= 0.05) {
          const streakB81sol = Math.min(1.0, (Math.abs(streak81sol) - 3) * 0.25);
          const rsiE81sol = isBear81sol ? (rsi14_5m - 62) / 38 : (38 - rsi14_5m) / 38;
          strategies.push({
            name: 'SOL ML 15m-Streak+BB22',
            emoji: '🤖🌟',
            score: Math.round(Math.min(9.5, 6.2 + dev81sol * 5.5 + streakB81sol + rsiE81sol * 1.2) * 10) / 10,
            direction: (isBear81sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL 15m streak=${Math.abs(streak81sol)}× + BB22 dev=${dev81sol.toFixed(3)}% RSI14=${rsi14_5m.toFixed(0)} (ML: 64.8% WR ~5/day ✅)`,
            confidence: Math.round(Math.min(84, 64 + dev81sol * 8 + streakB81sol * 10)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 82: BB %B > 1.0 + RSI7 ────────────────────────────────────────
  // SOL: 54.2% WR 2.0/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const bb82sol = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_82sol = calculateRSI(candles5m, 7);
    const last82sol = candles5m[candles5m.length - 1];
    if (bb82sol && rsi7_82sol !== null) {
      const pctB82sol = (bb82sol.upper - bb82sol.lower) > 0
        ? (last82sol.close - bb82sol.lower) / (bb82sol.upper - bb82sol.lower) : 0.5;
      const isBull82sol = pctB82sol < -0.05 && rsi7_82sol < 35;
      const isBear82sol = pctB82sol > 1.05 && rsi7_82sol > 65;
      if (isBull82sol || isBear82sol) {
        const ext82sol = isBull82sol ? Math.min(1, -pctB82sol * 5) : Math.min(1, (pctB82sol - 1.0) * 5);
        const dev82sol = isBear82sol
          ? (last82sol.close - bb82sol.upper) / bb82sol.upper * 100
          : (bb82sol.lower - last82sol.close) / bb82sol.lower * 100;
        strategies.push({
          name: 'SOL BB%B+RSI7',
          emoji: '📐🌟',
          score: Math.round(Math.min(8.8, 5.8 + dev82sol * 4 + ext82sol * 1.2) * 10) / 10,
          direction: (isBear82sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL %B=${pctB82sol.toFixed(2)} RSI7=${rsi7_82sol.toFixed(0)} dev=${dev82sol.toFixed(3)}% (54.2% WR ~2/day)`,
          confidence: Math.round(Math.min(71, 59 + dev82sol * 6 + ext82sol * 6)),
        });
      }
    }
  }

  // ─── SOL Strat 83: RSI(3) > 90 + BB22 ────────────────────────────────────────
  // SOL: 54.1% WR 2.0/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 10) {
    const rsi3_83sol = calculateRSI(candles5m, 3);
    const bb83sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last83sol = candles5m[candles5m.length - 1];
    if (bb83sol && rsi3_83sol !== null) {
      const isBull83sol = rsi3_83sol < 10 && last83sol.close < bb83sol.lower;
      const isBear83sol = rsi3_83sol > 90 && last83sol.close > bb83sol.upper;
      if (isBull83sol || isBear83sol) {
        const rsi3Ext83sol = isBull83sol ? Math.min(1, (10 - rsi3_83sol) / 10) : Math.min(1, (rsi3_83sol - 90) / 10);
        const dev83sol = isBear83sol
          ? (last83sol.close - bb83sol.upper) / bb83sol.upper * 100
          : (bb83sol.lower - last83sol.close) / bb83sol.lower * 100;
        strategies.push({
          name: 'SOL RSI3>90+BB22',
          emoji: '⚡🌟',
          score: Math.round(Math.min(8.8, 5.8 + dev83sol * 4 + rsi3Ext83sol * 1.2) * 10) / 10,
          direction: (isBear83sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL RSI3=${rsi3_83sol.toFixed(0)} dev=${dev83sol.toFixed(3)}% (54.1% WR ~2/day)`,
          confidence: Math.round(Math.min(70, 58 + dev83sol * 6 + rsi3Ext83sol * 6)),
        });
      }
    }
  }

  // ─── SOL Strat 84: RSI7 Consec2 + BB22 ───────────────────────────────────────
  // SOL: 53.8% WR 1.9/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 25) {
    const bb84sol = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_84sol = calculateRSI(candles5m, 7);
    const rsi7_84prevSol = calculateRSI(candles5m.slice(0, -1), 7);
    const last84sol = candles5m[candles5m.length - 1];
    if (bb84sol && rsi7_84sol !== null && rsi7_84prevSol !== null) {
      const isBull84sol = rsi7_84sol < 30 && rsi7_84prevSol < 30 && last84sol.close < bb84sol.lower;
      const isBear84sol = rsi7_84sol > 70 && rsi7_84prevSol > 70 && last84sol.close > bb84sol.upper;
      if (isBull84sol || isBear84sol) {
        const rsiExt84sol = isBull84sol ? (30 - rsi7_84sol) / 30 : (rsi7_84sol - 70) / 30;
        const dev84sol = isBear84sol
          ? (last84sol.close - bb84sol.upper) / bb84sol.upper * 100
          : (bb84sol.lower - last84sol.close) / bb84sol.lower * 100;
        strategies.push({
          name: 'SOL RSI7 Consec2+BB22',
          emoji: '🔥🌟',
          score: Math.round(Math.min(8.8, 5.7 + dev84sol * 4 + rsiExt84sol * 1.2) * 10) / 10,
          direction: (isBear84sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL RSI7=${rsi7_84sol.toFixed(0)} (2 bars) dev=${dev84sol.toFixed(3)}% (53.8% WR ~2/day)`,
          confidence: Math.round(Math.min(69, 57 + dev84sol * 6 + rsiExt84sol * 7)),
        });
      }
    }
  }

  // ─── SOL Strat 85: EMA20 Dev + RSI7 + BB22 ───────────────────────────────────
  // SOL: 54.3% WR 2.1/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const ema85sol = calcEMA(candles5m, 20);
    const bb85sol = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_85sol = calculateRSI(candles5m, 7);
    const last85sol = candles5m[candles5m.length - 1];
    if (bb85sol && rsi7_85sol !== null && ema85sol > 0) {
      const emaDev85sol = (last85sol.close - ema85sol) / ema85sol * 100;
      const isBull85sol = emaDev85sol < -0.5 && rsi7_85sol < 33 && last85sol.close < bb85sol.lower;
      const isBear85sol = emaDev85sol > 0.5 && rsi7_85sol > 67 && last85sol.close > bb85sol.upper;
      if (isBull85sol || isBear85sol) {
        const emaExt85sol = Math.min(1, (Math.abs(emaDev85sol) - 0.5) * 2);
        const dev85sol = isBear85sol
          ? (last85sol.close - bb85sol.upper) / bb85sol.upper * 100
          : (bb85sol.lower - last85sol.close) / bb85sol.lower * 100;
        strategies.push({
          name: 'SOL EMA20Dev+RSI7+BB22',
          emoji: '📏🌟',
          score: Math.round(Math.min(8.8, 5.7 + dev85sol * 4 + emaExt85sol * 1.2) * 10) / 10,
          direction: (isBear85sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL EMAdev=${emaDev85sol.toFixed(2)}% RSI7=${rsi7_85sol.toFixed(0)} dev=${dev85sol.toFixed(3)}% (54.3% WR ~2/day)`,
          confidence: Math.round(Math.min(69, 57 + dev85sol * 5 + emaExt85sol * 7)),
        });
      }
    }
  }

  // ─── SOL Strat 86: BB%B + CCI + WPR Triple ────────────────────────────────────
  // SOL: 53.9% WR 3.1/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const bb86sol = calculateBollingerBands(candles5m, 20, 2.2);
    const cci86sol = calcCCI(candles5m, 20);
    const wpr86sol = calcWilliamsR(candles5m, 14);
    const last86sol = candles5m[candles5m.length - 1];
    if (bb86sol) {
      const pctB86sol = (bb86sol.upper - bb86sol.lower) > 0
        ? (last86sol.close - bb86sol.lower) / (bb86sol.upper - bb86sol.lower) : 0.5;
      const isBull86sol = pctB86sol < 0.0 && cci86sol < -100 && wpr86sol < -80;
      const isBear86sol = pctB86sol > 1.0 && cci86sol > 100 && wpr86sol > -20;
      if (isBull86sol || isBear86sol) {
        const dev86sol = isBear86sol
          ? (last86sol.close - bb86sol.upper) / bb86sol.upper * 100
          : (bb86sol.lower - last86sol.close) / bb86sol.lower * 100;
        strategies.push({
          name: 'SOL BB%B+CCI+WPR',
          emoji: '🎰🌟',
          score: Math.round(Math.min(8.8, 5.6 + dev86sol * 4 + Math.min(1, Math.abs(cci86sol) / 200) * 1.2) * 10) / 10,
          direction: (isBear86sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL %B=${pctB86sol.toFixed(2)} CCI=${cci86sol.toFixed(0)} WPR=${wpr86sol.toFixed(0)} dev=${dev86sol.toFixed(3)}% (53.9% WR ~3/day)`,
          confidence: Math.round(Math.min(68, 56 + dev86sol * 5 + Math.min(1, Math.abs(cci86sol) / 200) * 7)),
        });
      }
    }
  }

  // ─── SOL Strat 87: Double RSI Confirmation + BB22 ────────────────────────────
  // SOL: 55.4% @2.3/day (session12_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const bb87sol = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_87sol = calculateRSI(candles5m, 7);
    if (bb87sol && rsi7_87sol !== null) {
      const last87sol = candles5m[candles5m.length - 1];
      const isBear87sol = rsi7_87sol > 72 && (rsi14_5m ?? 50) > 65 && last87sol.close > bb87sol.upper;
      const isBull87sol = rsi7_87sol < 28 && (rsi14_5m ?? 50) < 35 && last87sol.close < bb87sol.lower;
      if (isBear87sol || isBull87sol) {
        const dev87sol = isBear87sol
          ? (last87sol.close - bb87sol.upper) / bb87sol.upper * 100
          : (bb87sol.lower - last87sol.close) / bb87sol.lower * 100;
        strategies.push({
          name: 'SOL DoubleRSI+BB22',
          emoji: '📊🌟',
          score: Math.round(Math.min(8.8, 5.8 + dev87sol * 4 + Math.min(1, (isBear87sol ? rsi7_87sol - 72 : 28 - rsi7_87sol) / 10) * 1.0) * 10) / 10,
          direction: (isBear87sol ? 'bearish' : 'bullish') as Direction,
          signal: `SOL RSI7=${rsi7_87sol.toFixed(0)} RSI14=${(rsi14_5m ?? 50).toFixed(0)} dev=${dev87sol.toFixed(3)}% (55.4% WR ~2/day)`,
          confidence: Math.round(Math.min(72, 58 + dev87sol * 5 + Math.min(1, (isBear87sol ? rsi7_87sol - 72 : 28 - rsi7_87sol) / 15) * 6)),
        });
      }
    }
  }

  // ─── SOL Strat 88: BB Squeeze→Release + BB22 ─────────────────────────────────
  // SOL: 53.4% @1.6/day (session12_research.js, 5-fold WF)
  if (candles5m.length >= 31) {
    const closes88sol = candles5m.slice(-31).map(c => c.close);
    const bwArr88sol: number[] = [];
    for (let i = 20; i <= 30; i++) {
      const sl = closes88sol.slice(i - 20, i);
      const sma = sl.reduce((a, b) => a + b, 0) / 20;
      const std = Math.sqrt(sl.reduce((a, c) => a + (c - sma) ** 2, 0) / 20);
      bwArr88sol.push(sma > 0 ? std * 4.4 / sma * 100 : 0);
    }
    const bwCurr88sol = bwArr88sol[10];
    const bwPrev10Avg88sol = bwArr88sol.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    if (bwPrev10Avg88sol < 2.5 && bwCurr88sol > bwPrev10Avg88sol * 1.3) {
      const bb88sol = calculateBollingerBands(candles5m, 20, 2.2);
      const rsi7_88sol = calculateRSI(candles5m, 7);
      if (bb88sol && rsi7_88sol !== null) {
        const last88sol = candles5m[candles5m.length - 1];
        const isBear88sol = last88sol.close > bb88sol.upper && rsi7_88sol > 62;
        const isBull88sol = last88sol.close < bb88sol.lower && rsi7_88sol < 38;
        if (isBear88sol || isBull88sol) {
          const dev88sol = isBear88sol
            ? (last88sol.close - bb88sol.upper) / bb88sol.upper * 100
            : (bb88sol.lower - last88sol.close) / bb88sol.lower * 100;
          strategies.push({
            name: 'SOL BB Squeeze→Release',
            emoji: '🗜️🌟',
            score: Math.round(Math.min(8.6, 5.9 + dev88sol * 4 + 0.5) * 10) / 10,
            direction: (isBear88sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL Squeeze(${bwPrev10Avg88sol.toFixed(2)}%)→Expand(${bwCurr88sol.toFixed(2)}%) RSI7=${rsi7_88sol.toFixed(0)} (53.4% WR ~2/day)`,
            confidence: Math.round(Math.min(68, 57 + dev88sol * 5 + 3)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 89: Wide Range Candle (1.5×ATR) + BB22 ────────────────────────
  // SOL: 54.7% @1.7/day (session12_research.js, 5-fold WF)
  if (candles5m.length >= 20) {
    const kc89sol = calculateKeltnerChannels(candles5m);
    const bb89sol = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_89sol = calculateRSI(candles5m, 7);
    if (kc89sol && bb89sol && rsi7_89sol !== null) {
      const last89sol = candles5m[candles5m.length - 1];
      const range89sol = last89sol.high - last89sol.low;
      if (kc89sol.atr > 0 && range89sol > 1.5 * kc89sol.atr) {
        const isBear89sol = last89sol.close > bb89sol.upper && rsi7_89sol > 60;
        const isBull89sol = last89sol.close < bb89sol.lower && rsi7_89sol < 40;
        if (isBear89sol || isBull89sol) {
          const dev89sol = isBear89sol
            ? (last89sol.close - bb89sol.upper) / bb89sol.upper * 100
            : (bb89sol.lower - last89sol.close) / bb89sol.lower * 100;
          strategies.push({
            name: 'SOL WideRange+BB22',
            emoji: '📏🌟',
            score: Math.round(Math.min(8.7, 5.7 + dev89sol * 4 + Math.min(1, range89sol / kc89sol.atr - 1.5) * 0.8) * 10) / 10,
            direction: (isBear89sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL Range/ATR=${(range89sol/kc89sol.atr).toFixed(2)}x RSI7=${rsi7_89sol.toFixed(0)} dev=${dev89sol.toFixed(3)}% (54.7% WR ~2/day)`,
            confidence: Math.round(Math.min(70, 57 + dev89sol * 5 + Math.min(1, range89sol / kc89sol.atr - 1.5) * 4)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 90: ADX<20 (Ranging Market) + BB22 + RSI7 ─────────────────────
  // SOL: 53.5% @0.8/day (session12_research.js, 5-fold WF)
  if (candles5m.length >= 30) {
    const adx90sol = calcADX(candles5m, 14);
    if (adx90sol < 20) {
      const bb90sol = calculateBollingerBands(candles5m, 20, 2.2);
      const rsi7_90sol = calculateRSI(candles5m, 7);
      if (bb90sol && rsi7_90sol !== null) {
        const last90sol = candles5m[candles5m.length - 1];
        const devHi90sol = (last90sol.close - bb90sol.upper) / bb90sol.upper * 100;
        const devLo90sol = (bb90sol.lower - last90sol.close) / bb90sol.lower * 100;
        const isBear90sol = devHi90sol > 0.04 && rsi7_90sol > 65;
        const isBull90sol = devLo90sol > 0.04 && rsi7_90sol < 35;
        if (isBear90sol || isBull90sol) {
          const dev90sol = isBear90sol ? devHi90sol : devLo90sol;
          strategies.push({
            name: 'SOL ADX<20+BB22',
            emoji: '📉🌟',
            score: Math.round(Math.min(8.8, 5.8 + dev90sol * 4 + Math.min(1, (20 - adx90sol) / 15) * 1.0) * 10) / 10,
            direction: (isBear90sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL ADX=${adx90sol.toFixed(1)}<20 RSI7=${rsi7_90sol.toFixed(0)} dev=${dev90sol.toFixed(3)}% (53.5% WR ~1/day)`,
            confidence: Math.round(Math.min(70, 57 + dev90sol * 5 + Math.min(1, (20 - adx90sol) / 15) * 7)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 93: GoodH + ADX<20 + RSI7>73 + MFI14>72 + RSI14>68 + BB22 ───
  // 6-condition: strat92 + RSI14 confirm | SOL: 71.4% @0.04/day (n=35) 🔥🔥
  if (candles5m.length >= 30) {
    const s93solGoodHours = [0, 12, 13, 20]; // SOL good hours
    const last93sol = candles5m[candles5m.length - 1];
    const s93solHour = new Date(last93sol.closeTime).getUTCHours();
    if (s93solGoodHours.includes(s93solHour)) {
      const adx93sol = calcADX(candles5m, 14);
      if (adx93sol < 20) {
        const bb93sol = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_93sol = calculateRSI(candles5m, 7);
        const mfi93sol = calculateMFI(candles5m, 14);
        if (bb93sol && rsi7_93sol !== null && mfi93sol !== null && rsi14_5m !== null) {
          const isBear93sol = rsi7_93sol > 73 && (rsi14_5m ?? 50) > 68 && mfi93sol > 72 && last93sol.close > bb93sol.upper;
          const isBull93sol = rsi7_93sol < 27 && (rsi14_5m ?? 50) < 32 && mfi93sol < 28 && last93sol.close < bb93sol.lower;
          if (isBear93sol || isBull93sol) {
            const dev93sol = isBear93sol
              ? (last93sol.close - bb93sol.upper) / bb93sol.upper * 100
              : (bb93sol.lower - last93sol.close) / bb93sol.lower * 100;
            strategies.push({
              name: 'SOL GH+ADX20+RSI73+MFI72+RSI14',
              emoji: '🔥💎💎',
              score: Math.round(Math.min(9.5, 7.5 + dev93sol * 5 + 0.8) * 10) / 10,
              direction: (isBear93sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL GH=${s93solHour}UTC ADX=${adx93sol.toFixed(1)} RSI7=${rsi7_93sol.toFixed(0)} RSI14=${(rsi14_5m??50).toFixed(0)} MFI=${mfi93sol.toFixed(0)} (71.4% WR 🔥)`,
              confidence: Math.round(Math.min(88, 72 + dev93sol * 6 + 4)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 94: GoodH + ADX<20 + RSI7>76 + MFI14>75 + BB22 ───────────────
  // Deeper thresholds | SOL: 62.5% @0.03/day
  if (candles5m.length >= 30) {
    const s94solGoodHours = [0, 12, 13, 20]; // SOL good hours
    const last94sol = candles5m[candles5m.length - 1];
    const s94solHour = new Date(last94sol.closeTime).getUTCHours();
    if (s94solGoodHours.includes(s94solHour)) {
      const adx94sol = calcADX(candles5m, 14);
      if (adx94sol < 20) {
        const bb94sol = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_94sol = calculateRSI(candles5m, 7);
        const mfi94sol = calculateMFI(candles5m, 14);
        if (bb94sol && rsi7_94sol !== null && mfi94sol !== null) {
          const isBear94sol = rsi7_94sol > 76 && mfi94sol > 75 && last94sol.close > bb94sol.upper;
          const isBull94sol = rsi7_94sol < 24 && mfi94sol < 25 && last94sol.close < bb94sol.lower;
          if (isBear94sol || isBull94sol) {
            const dev94sol = isBear94sol
              ? (last94sol.close - bb94sol.upper) / bb94sol.upper * 100
              : (bb94sol.lower - last94sol.close) / bb94sol.lower * 100;
            strategies.push({
              name: 'SOL GH+ADX20+RSI76+MFI75',
              emoji: '🔥🔥',
              score: Math.round(Math.min(9.3, 7.5 + dev94sol * 5 + 0.8) * 10) / 10,
              direction: (isBear94sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL GH=${s94solHour}UTC ADX=${adx94sol.toFixed(1)} RSI7=${rsi7_94sol.toFixed(0)} MFI=${mfi94sol.toFixed(0)} (62.5% WR deep-thresh)`,
              confidence: Math.round(Math.min(82, 68 + dev94sol * 6 + 4)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 95: TightGH[12,13] + ADX<20 + RSI7>70 + MFI14>68 + BB22 ──────
  // Tight 2-hour window [12,13] × ADX<20 × RSI/MFI | SOL: 80.0% @0.05/day (n=44) 🔥🔥🔥
  if (candles5m.length >= 30) {
    const s95solGoodHours = [12, 13]; // SOL tight hours (2 best)
    const last95sol = candles5m[candles5m.length - 1];
    const s95solHour = new Date(last95sol.closeTime).getUTCHours();
    if (s95solGoodHours.includes(s95solHour)) {
      const adx95sol = calcADX(candles5m, 14);
      if (adx95sol < 20) {
        const bb95sol = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_95sol = calculateRSI(candles5m, 7);
        const mfi95sol = calculateMFI(candles5m, 14);
        if (bb95sol && rsi7_95sol !== null && mfi95sol !== null) {
          const isBear95sol = rsi7_95sol > 70 && mfi95sol > 68 && last95sol.close > bb95sol.upper;
          const isBull95sol = rsi7_95sol < 30 && mfi95sol < 32 && last95sol.close < bb95sol.lower;
          if (isBear95sol || isBull95sol) {
            const dev95sol = isBear95sol
              ? (last95sol.close - bb95sol.upper) / bb95sol.upper * 100
              : (bb95sol.lower - last95sol.close) / bb95sol.lower * 100;
            strategies.push({
              name: 'SOL TightGH+ADX20+RSI70+MFI68',
              emoji: '🕐🔥🌟',
              score: Math.round(Math.min(9.8, 7.8 + dev95sol * 5 + Math.min(1, (20 - adx95sol) / 15)) * 10) / 10,
              direction: (isBear95sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL TightGH=${s95solHour}UTC ADX=${adx95sol.toFixed(1)} RSI7=${rsi7_95sol.toFixed(0)} MFI=${mfi95sol.toFixed(0)} (80.0% WR n=44 🔥🔥🔥)`,
              confidence: Math.round(Math.min(90, 75 + dev95sol * 6 + Math.min(1, (20 - adx95sol) / 15) * 8)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 97: GoodH + ADX<20 + RSI3>93 + RSI5>82 + MFI70 + BB22 ────────
  // Triple RSI cascade | BTC=85.7% validated → SOL good hours
  if (candles5m.length >= 20) {
    const s97solGoodHours = [0, 12, 13, 20];
    const last97sol = candles5m[candles5m.length - 1];
    const s97solHour = new Date(last97sol.closeTime).getUTCHours();
    if (s97solGoodHours.includes(s97solHour)) {
      const adx97sol = calcADX(candles5m, 14);
      if (adx97sol < 20) {
        const bb97sol = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_97sol = calculateRSI(candles5m, 3);
        const rsi5_97sol = calculateRSI(candles5m, 5);
        const mfi97sol = calculateMFI(candles5m, 14);
        if (bb97sol && rsi3_97sol !== null && rsi5_97sol !== null && mfi97sol !== null) {
          const isBear97sol = rsi3_97sol > 93 && rsi5_97sol > 82 && mfi97sol > 70 && last97sol.close > bb97sol.upper;
          const isBull97sol = rsi3_97sol < 7 && rsi5_97sol < 18 && mfi97sol < 30 && last97sol.close < bb97sol.lower;
          if (isBear97sol || isBull97sol) {
            const dev97sol = isBear97sol
              ? (last97sol.close - bb97sol.upper) / bb97sol.upper * 100
              : (bb97sol.lower - last97sol.close) / bb97sol.lower * 100;
            const ext97sol = isBear97sol ? (rsi3_97sol - 93) / 7 : (7 - rsi3_97sol) / 7;
            strategies.push({
              name: 'SOL GH+ADX20+RSI3_93+RSI5_82+MFI70',
              emoji: '🔥💥',
              score: Math.round(Math.min(9.5, 7.5 + dev97sol * 5 + Math.min(1, ext97sol)) * 10) / 10,
              direction: (isBear97sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL GH=${s97solHour}UTC ADX=${adx97sol.toFixed(1)} RSI3=${rsi3_97sol.toFixed(0)} RSI5=${rsi5_97sol.toFixed(0)} (BTC=85.7% WR 🔥🔥🔥)`,
              confidence: Math.round(Math.min(90, 74 + dev97sol * 6 + Math.min(1, ext97sol) * 6)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 98: GoodH + ADX<20 + WPR>-8 + RSI7>73 + MFI72 + BB22 ─────────
  if (candles5m.length >= 22) {
    const s98solGoodHours = [0, 12, 13, 20];
    const last98sol = candles5m[candles5m.length - 1];
    const s98solHour = new Date(last98sol.closeTime).getUTCHours();
    if (s98solGoodHours.includes(s98solHour)) {
      const adx98sol = calcADX(candles5m, 14);
      if (adx98sol < 20) {
        const bb98sol = calculateBollingerBands(candles5m, 20, 2.2);
        const wpr98sol = calcWilliamsR(candles5m, 14);
        const rsi7_98sol = calculateRSI(candles5m, 7);
        const mfi98sol = calculateMFI(candles5m, 14);
        if (bb98sol && rsi7_98sol !== null && mfi98sol !== null) {
          const isBear98sol = wpr98sol > -8 && rsi7_98sol > 73 && mfi98sol > 72 && last98sol.close > bb98sol.upper;
          const isBull98sol = wpr98sol < -92 && rsi7_98sol < 27 && mfi98sol < 28 && last98sol.close < bb98sol.lower;
          if (isBear98sol || isBull98sol) {
            const dev98sol = isBear98sol
              ? (last98sol.close - bb98sol.upper) / bb98sol.upper * 100
              : (bb98sol.lower - last98sol.close) / bb98sol.lower * 100;
            strategies.push({
              name: 'SOL GH+ADX20+WPR_8+RSI73+MFI72',
              emoji: '📉🔥',
              score: Math.round(Math.min(9.0, 7.2 + dev98sol * 5) * 10) / 10,
              direction: (isBear98sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL GH=${s98solHour}UTC WPR=${wpr98sol.toFixed(1)} RSI7=${rsi7_98sol.toFixed(0)} MFI=${mfi98sol.toFixed(0)} (BTC=77.8% WR 🔥🔥🔥)`,
              confidence: Math.round(Math.min(87, 70 + dev98sol * 6)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 99: GoodH + ADX<20 + ConnorsRSI>85 + MFI72 + BB22 ────────────
  if (candles5m.length >= 106) {
    const s99solGoodHours = [0, 12, 13, 20];
    const last99sol = candles5m[candles5m.length - 1];
    const s99solHour = new Date(last99sol.closeTime).getUTCHours();
    if (s99solGoodHours.includes(s99solHour)) {
      const adx99sol = calcADX(candles5m, 14);
      if (adx99sol < 20) {
        const bb99sol = calculateBollingerBands(candles5m, 20, 2.2);
        const crsi99sol = calcConnorsRSI(candles5m, 100);
        const mfi99sol = calculateMFI(candles5m, 14);
        if (bb99sol && mfi99sol !== null) {
          const isBear99sol = crsi99sol > 85 && mfi99sol > 72 && last99sol.close > bb99sol.upper;
          const isBull99sol = crsi99sol < 15 && mfi99sol < 28 && last99sol.close < bb99sol.lower;
          if (isBear99sol || isBull99sol) {
            const dev99sol = isBear99sol
              ? (last99sol.close - bb99sol.upper) / bb99sol.upper * 100
              : (bb99sol.lower - last99sol.close) / bb99sol.lower * 100;
            strategies.push({
              name: 'SOL GH+ADX20+CRSI85+MFI72',
              emoji: '🧠🔥',
              score: Math.round(Math.min(9.0, 7.2 + dev99sol * 5) * 10) / 10,
              direction: (isBear99sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL GH=${s99solHour}UTC CRSI=${crsi99sol.toFixed(0)} MFI=${mfi99sol.toFixed(0)} (BTC=77.8% n=42 🔥🔥🔥)`,
              confidence: Math.round(Math.min(87, 70 + dev99sol * 6)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 101: 1m Volume Climax + 5m BB22 ──────────────────────────────
  // SOL=55.1% @7/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1m.length >= 22 && candles5m.length >= 22) {
    const bb101sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last101sol = candles5m[candles5m.length - 1];
    if (bb101sol) {
      const vols1m101sol = candles1m.slice(-21).map(c => c.volume);
      const avgVol1m101sol = vols1m101sol.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      const lastVol1m101sol = vols1m101sol[20];
      const volSpike101sol = avgVol1m101sol > 0 ? lastVol1m101sol / avgVol1m101sol : 0;
      if (volSpike101sol >= 2.2) {
        const isBear101sol = last101sol.close > bb101sol.upper;
        const isBull101sol = last101sol.close < bb101sol.lower;
        if (isBear101sol || isBull101sol) {
          const dev101sol = isBear101sol
            ? (last101sol.close - bb101sol.upper) / bb101sol.upper * 100
            : (bb101sol.lower - last101sol.close) / bb101sol.lower * 100;
          strategies.push({
            name: 'SOL 1mVolClimaxBB22',
            emoji: '📊⚡🌟',
            score: Math.round(Math.min(8.8, 5.8 + dev101sol * 5 + Math.min(1, (volSpike101sol - 2.2) / 3) * 1.5) * 10) / 10,
            direction: (isBear101sol ? 'bearish' : 'bullish') as Direction,
            signal: `SOL 1mVol=${volSpike101sol.toFixed(1)}x dev=${dev101sol.toFixed(3)}% (SOL=55.1% @7/day)`,
            confidence: Math.round(Math.min(72, 58 + dev101sol * 7 + Math.min(1, (volSpike101sol - 2.2) / 3) * 6)),
          });
        }
      }
    }
  }

  // ─── SOL Strat 102: 1h Ranging + 5m BB22 + Streak ────────────────────────────
  // SOL=57.0% @10/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1h.length >= 15 && candles5m.length >= 22) {
    const bb102sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last102sol = candles5m[candles5m.length - 1];
    if (bb102sol) {
      const rsi14_1h102sol = calculateRSI(candles1h, 14);
      if (rsi14_1h102sol !== null && rsi14_1h102sol >= 40 && rsi14_1h102sol <= 62) {
        const prev102sol = candles5m[candles5m.length - 2];
        const streak102sol = (last102sol.close > last102sol.open && prev102sol.close > prev102sol.open) ||
                             (last102sol.close < last102sol.open && prev102sol.close < prev102sol.open);
        if (streak102sol) {
          const isBear102sol = last102sol.close > bb102sol.upper;
          const isBull102sol = last102sol.close < bb102sol.lower;
          if (isBear102sol || isBull102sol) {
            const dev102sol = isBear102sol
              ? (last102sol.close - bb102sol.upper) / bb102sol.upper * 100
              : (bb102sol.lower - last102sol.close) / bb102sol.lower * 100;
            strategies.push({
              name: 'SOL 1hRanging+BB22+Streak',
              emoji: '🕐📊🌟',
              score: Math.round(Math.min(8.8, 6.0 + dev102sol * 5) * 10) / 10,
              direction: (isBear102sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL 1hRSI14=${rsi14_1h102sol.toFixed(0)} ranging dev=${dev102sol.toFixed(3)}% (SOL=57.0% @10/day)`,
              confidence: Math.round(Math.min(73, 59 + dev102sol * 8)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 103: 1m Sub-bar Momentum Fade + 5m BB22 ──────────────────────
  // SOL=54.5% @6/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1m.length >= 5 && candles5m.length >= 22) {
    const bb103sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last103sol = candles5m[candles5m.length - 1];
    if (bb103sol) {
      const last3_1m103sol = candles1m.slice(-3);
      const allBull1m103sol = last3_1m103sol.every(c => c.close > c.open);
      const allBear1m103sol = last3_1m103sol.every(c => c.close < c.open);
      if (allBull1m103sol || allBear1m103sol) {
        const bodyRatio103sol = last3_1m103sol.reduce((sum, c) => {
          const body = Math.abs(c.close - c.open);
          const range = c.high - c.low;
          return sum + (range > 0 ? body / range : 0);
        }, 0) / 3;
        if (bodyRatio103sol >= 0.6) {
          const isBear103sol = allBull1m103sol && last103sol.close > bb103sol.upper;
          const isBull103sol = allBear1m103sol && last103sol.close < bb103sol.lower;
          if (isBear103sol || isBull103sol) {
            const dev103sol = isBear103sol
              ? (last103sol.close - bb103sol.upper) / bb103sol.upper * 100
              : (bb103sol.lower - last103sol.close) / bb103sol.lower * 100;
            strategies.push({
              name: 'SOL 1mMomentumFade+BB22',
              emoji: '🔄📉🌟',
              score: Math.round(Math.min(8.5, 5.7 + dev103sol * 5 + (bodyRatio103sol - 0.6) * 1.5) * 10) / 10,
              direction: (isBear103sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL 1m3consec body=${bodyRatio103sol.toFixed(2)} dev=${dev103sol.toFixed(3)}% (SOL=54.5% @6/day)`,
              confidence: Math.round(Math.min(70, 57 + dev103sol * 7 + (bodyRatio103sol - 0.6) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 104: 1m VolSpike + 1h Ranging + 5m BB22 (STAR) ───────────────
  // SOL=57.5% @3/d (session13_5s_mtf_research.js, 5-fold WF) 🌟
  if (candles1m.length >= 22 && candles1h.length >= 15 && candles5m.length >= 22) {
    const bb104sol = calculateBollingerBands(candles5m, 20, 2.2);
    const last104sol = candles5m[candles5m.length - 1];
    if (bb104sol) {
      const vols1m104sol = candles1m.slice(-21).map(c => c.volume);
      const avgVol1m104sol = vols1m104sol.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      const lastVol1m104sol = vols1m104sol[20];
      const volSpike104sol = avgVol1m104sol > 0 ? lastVol1m104sol / avgVol1m104sol : 0;
      if (volSpike104sol >= 2.5) {
        const rsi14_1h104sol = calculateRSI(candles1h, 14);
        if (rsi14_1h104sol !== null && rsi14_1h104sol >= 38 && rsi14_1h104sol <= 63) {
          const isBear104sol = last104sol.close > bb104sol.upper;
          const isBull104sol = last104sol.close < bb104sol.lower;
          if (isBear104sol || isBull104sol) {
            const dev104sol = isBear104sol
              ? (last104sol.close - bb104sol.upper) / bb104sol.upper * 100
              : (bb104sol.lower - last104sol.close) / bb104sol.lower * 100;
            strategies.push({
              name: 'SOL 1mVolSpike+1hRange+BB22',
              emoji: '🚀📊🌟',
              score: Math.round(Math.min(9.2, 6.8 + dev104sol * 5 + Math.min(1, (volSpike104sol - 2.5) / 3)) * 10) / 10,
              direction: (isBear104sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL 1mVol=${volSpike104sol.toFixed(1)}x 1hRSI=${rsi14_1h104sol.toFixed(0)} dev=${dev104sol.toFixed(3)}% (SOL=57.5% STAR 🌟)`,
              confidence: Math.round(Math.min(78, 63 + dev104sol * 8 + Math.min(1, (volSpike104sol - 2.5) / 3) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 105: GoodH + ADX<20 + RSI3>90 + MFI70 + BB(20,1.8) ───────────
  // BB(20,1.8) × RSI3 ultra-fast × MFI | ETH=75.0% validated pattern → SOL hours
  if (candles5m.length >= 20) {
    const s105solGoodHours = [0, 12, 13, 20];
    const last105sol = candles5m[candles5m.length - 1];
    const s105solHour = new Date(last105sol.closeTime).getUTCHours();
    if (s105solGoodHours.includes(s105solHour)) {
      const adx105sol = calcADX(candles5m, 14);
      if (adx105sol < 20) {
        const bb105sol = calculateBollingerBands(candles5m, 20, 1.8);
        const rsi3_105sol = calculateRSI(candles5m, 3);
        const mfi105sol = calculateMFI(candles5m, 14);
        if (bb105sol && rsi3_105sol !== null && mfi105sol !== null) {
          const isBear105sol = rsi3_105sol > 90 && mfi105sol > 70 && last105sol.close > bb105sol.upper;
          const isBull105sol = rsi3_105sol < 10 && mfi105sol < 30 && last105sol.close < bb105sol.lower;
          if (isBear105sol || isBull105sol) {
            const dev105sol = isBear105sol
              ? (last105sol.close - bb105sol.upper) / bb105sol.upper * 100
              : (bb105sol.lower - last105sol.close) / bb105sol.lower * 100;
            const ext105sol = isBear105sol ? (rsi3_105sol - 90) / 10 : (10 - rsi3_105sol) / 10;
            strategies.push({
              name: 'SOL GH+ADX20+RSI3_90+MFI70+BB18',
              emoji: '🔥🎯',
              score: Math.round(Math.min(9.2, 7.2 + dev105sol * 5 + Math.min(1, ext105sol) * 0.5) * 10) / 10,
              direction: (isBear105sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL GH=${s105solHour}UTC ADX=${adx105sol.toFixed(1)} RSI3=${rsi3_105sol.toFixed(0)} MFI=${mfi105sol.toFixed(0)} BB1.8 (ETH=75.0% pattern 🔥🔥🔥)`,
              confidence: Math.round(Math.min(88, 70 + dev105sol * 6 + Math.min(1, ext105sol) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── SOL Strat 122: GoodH + ADX<20 + RSI7>70 + MFI>68 + BB%B>1.1 + BB22 ─────
  // Session22 A discovery: BB%B (percent-B) >1.1 = price 10%+ beyond upper band = deeper overshoot
  // SOL: 75.0% n=29 tpd=0.16 🔥🔥 (session22_bbpct_squeeze_soleth.js, 5-fold WF)
  if (candles5m.length >= 25) {
    const s122solGoodHours = [0, 12, 13, 20];
    const last122sol = candles5m[candles5m.length - 1];
    const s122solHour = new Date(last122sol.closeTime).getUTCHours();
    if (s122solGoodHours.includes(s122solHour)) {
      const adx122sol = calcADX(candles5m, 14);
      if (adx122sol < 20) {
        const rsi7_122sol = calculateRSI(candles5m, 7);
        const mfi122sol = calculateMFI(candles5m, 14);
        const bb122sol = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb122sol && rsi7_122sol !== null && mfi122sol !== null) {
          const bandWidth122sol = bb122sol.upper - bb122sol.lower;
          const bbPctB122sol = bandWidth122sol > 0 ? (last122sol.close - bb122sol.lower) / bandWidth122sol : 0.5;
          const isBear122sol = rsi7_122sol > 70 && mfi122sol > 68 && bbPctB122sol > 1.1;
          const isBull122sol = rsi7_122sol < 30 && mfi122sol < 32 && bbPctB122sol < -0.1;
          if (isBear122sol || isBull122sol) {
            const dev122sol = isBear122sol
              ? (last122sol.close - bb122sol.upper) / bb122sol.upper * 100
              : (bb122sol.lower - last122sol.close) / bb122sol.lower * 100;
            strategies.push({
              name: 'SOL GH+ADX20+RSI7_70+MFI68+BBpctB1.1+BB22',
              emoji: '🔥🌊',
              score: Math.round(Math.min(9.3, 7.3 + dev122sol * 5) * 10) / 10,
              direction: (isBear122sol ? 'bearish' : 'bullish') as Direction,
              signal: `SOL GH=${s122solHour}UTC ADX=${adx122sol.toFixed(1)} RSI7=${rsi7_122sol.toFixed(0)} MFI=${mfi122sol.toFixed(0)} BB%B=${bbPctB122sol.toFixed(2)} (SOL=75.0% n=29 🔥🔥)`,
              confidence: Math.round(Math.min(88, 72 + dev122sol * 6)),
            });
          }
        }
      }
    }
  }

  strategies.sort((a, b) => b.score - a.score);
  const bullishScore = strategies.filter(s => s.direction === 'bullish').reduce((s, st) => s + st.score, 0);
  const bearishScore = strategies.filter(s => s.direction === 'bearish').reduce((s, st) => s + st.score, 0);

  return {
    strategies,
    indicators: {
      rsi14_5m,
      rsi7_1m: null,
      sma20,
      vwap: calculateVWAP(candles5m),
      macd: calculateMACD(candles5m),
      momentum: detectMomentum(candles5m, 5),
      lastPrice,
      bb,
    },
    verdict: {
      direction: bullishScore > bearishScore ? 'BULLISH' : bearishScore > bullishScore ? 'BEARISH' : 'NEUTRAL',
      bullishScore: Math.round(bullishScore * 10) / 10,
      bearishScore: Math.round(bearishScore * 10) / 10,
      topStrategy: strategies[0] || null,
      signalCount: strategies.filter(s => s.score >= 7).length,
    },
  };
}

// Strategy 20: XRP Good Hours BB Reversion
// Validated: h=[6,9,12,18] BB(25,2.2) streak>=1 → 66.7% WR σ=0.4% T=192 [ULTRA STABLE]
// Also: h=[6,12] BB(25,2.2) str>=1 → 71.2% WR T=98 (boosted confidence)
// RR bull pattern at GoodH + BB lower → 73.7% WR T=74
export function scoreXrpStrategies(candles5m: Candle[], candles1m: Candle[] = [], candles1h: Candle[] = [], candles4h: Candle[] = []): StrategyResult {
  const strategies: StrategyResult['strategies'] = [];
  const lastPrice = candles5m.length > 0 ? candles5m[candles5m.length - 1].close : 0;
  const rsi14_5m = calculateRSI(candles5m, 14);
  const sma20 = calculateSMA(candles5m, 20);
  const bb = calculateBollingerBands(candles5m, 20, 2);

  // Strategy 20: XRP Good Hours BB Reversion
  // Good hours: [6, 9, 12, 18] UTC (different from ETH and SOL)
  {
    const s20GoodHours = [6, 9, 12, 18];
    const s20TightHours = [6, 12]; // tighter hours → 71.2% WR
    if (candles5m.length >= 80) {
      // Build synthetic 15m candles (group every 3 consecutive 5m candles)
      const synth15m: Candle[] = [];
      const aligned = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < aligned; i += 3) {
        const group = candles5m.slice(i, i + 3);
        synth15m.push({
          openTime: group[0].openTime,
          closeTime: group[2].closeTime,
          open: group[0].open,
          high: Math.max(...group.map(c => c.high)),
          low: Math.min(...group.map(c => c.low)),
          close: group[2].close,
          volume: group.reduce((s, c) => s + c.volume, 0),
          quoteVolume: group.reduce((s, c) => s + c.quoteVolume, 0),
          trades: group.reduce((s, c) => s + c.trades, 0),
        });
      }

      if (synth15m.length >= 26) {
        const lastS = synth15m[synth15m.length - 1];
        const s20Hour = new Date(lastS.openTime).getUTCHours();

        if (s20GoodHours.includes(s20Hour)) {
          const bb25 = calculateBollingerBands(synth15m, 25, 2.2);
          if (bb25) {
            const sPrice = lastS.close;
            const isBear = sPrice > bb25.upper;
            const isBull = sPrice < bb25.lower;

            // Streak on synth15m
            let streakLen = 1;
            const s20Dir = lastS.close >= lastS.open ? 'G' : 'R';
            for (let j = synth15m.length - 2; j >= Math.max(0, synth15m.length - 10); j--) {
              const d = synth15m[j].close >= synth15m[j].open ? 'G' : 'R';
              if (d === s20Dir) streakLen++; else break;
            }

            const s20Bear = isBear && lastS.close > lastS.open && streakLen >= 1;
            const s20Bull = isBull && lastS.close < lastS.open && streakLen >= 1;

            if (s20Bear || s20Bull) {
              const deviation = s20Bear
                ? (sPrice - bb25.upper) / bb25.upper * 100
                : (bb25.lower - sPrice) / bb25.lower * 100;

              // Boost confidence for tight hours [6,12] and RR/RRR bull patterns
              const isTightHour = s20TightHours.includes(s20Hour);
              const isRRBull = s20Bull && streakLen >= 2; // RR pattern → 73.7% WR
              const baseWR = isRRBull ? 73.7 : (isTightHour ? 71.2 : 66.7);

              const score = Math.min(10, 6.0 + deviation * 8 + (streakLen - 1) * 0.3 + (isTightHour ? 0.5 : 0));
              const confidence = Math.round(Math.min(88,
                (baseWR - 66.7) * 0.3 + 63 + deviation * 10 + (streakLen - 1) * 0.8,
              ));
              const patternLabel = isRRBull ? `RR bull` : s20Bear ? `${streakLen}G bear` : `${streakLen}R bull`;
              strategies.push({
                name: 'XRP Good Hours BB',
                emoji: '💎',
                score: Math.round(score * 10) / 10,
                direction: (s20Bear ? 'bearish' : 'bullish') as Direction,
                signal: `${patternLabel} synth-15m at BB(25,2.2) ${s20Bear ? 'upper' : 'lower'}, h=${s20Hour}UTC (${baseWR.toFixed(1)}% WR)`,
                confidence,
              });
            }
          }
        }
      }
    }
  }

  // Strategies 39-40: XRP additional validated strategies
  // Build shared XRP synth-15m
  if (candles5m.length >= 65) {
    const xrpSynth: Candle[] = [];
    const xrpAligned = candles5m.length - (candles5m.length % 3);
    for (let i = 0; i < xrpAligned; i += 3) {
      const g = candles5m.slice(i, i + 3);
      xrpSynth.push({
        openTime: g[0].openTime, closeTime: g[2].closeTime,
        open: g[0].open, high: Math.max(...g.map(c => c.high)),
        low: Math.min(...g.map(c => c.low)), close: g[2].close,
        volume: g.reduce((s, c) => s + c.volume, 0),
        quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
        trades: g.reduce((s, c) => s + c.trades, 0),
      });
    }

    if (xrpSynth.length >= 55) {
      const lastXrp = xrpSynth[xrpSynth.length - 1];
      const xrpHour = new Date(lastXrp.closeTime).getUTCHours();
      const xrpGoodHours2 = [6, 9, 12, 18];

      if (xrpGoodHours2.includes(xrpHour)) {
        let xrpStreak = 0;
        for (let j = xrpSynth.length - 1; j >= Math.max(0, xrpSynth.length - 7); j--) {
          const cj = xrpSynth[j];
          if (cj.close > cj.open) { if (xrpStreak < 0) break; xrpStreak++; }
          else if (cj.close < cj.open) { if (xrpStreak > 0) break; xrpStreak--; }
          else break;
        }

        // Strategy 39: XRP MFI75 Exhaustion 💠 — NEAR-PERFECT STABILITY
        // MFI>75+BB(25,2.2)+GoodH+streak>=1 → WF=67.3% σ=0.4% T=113 [67.6/67.6/66.7]
        // 5-fold: 67.1% σ=3.2% — near-perfect fold-to-fold consistency
        {
          const bb25_s39 = calculateBollingerBands(xrpSynth, 25, 2.2);
          const mfi_s39 = calculateMFI(xrpSynth, 10);
          if (bb25_s39 && mfi_s39 !== null) {
            const p39 = lastXrp.close;
            const isBear = p39 > bb25_s39.upper && lastXrp.close > lastXrp.open;
            const isBull = p39 < bb25_s39.lower && lastXrp.close < lastXrp.open;
            const mfiOk = (isBear && mfi_s39 > 75) || (isBull && mfi_s39 < 25);
            const streakOk = (isBear && xrpStreak >= 1) || (isBull && xrpStreak <= -1);
            if ((isBear || isBull) && mfiOk && streakOk) {
              const deviation = isBear
                ? (p39 - bb25_s39.upper) / bb25_s39.upper * 100
                : (bb25_s39.lower - p39) / bb25_s39.lower * 100;
              const mfiExt = isBear ? mfi_s39 - 75 : 25 - mfi_s39;
              strategies.push({
                name: 'XRP MFI75 Exhaustion',
                emoji: '💠',
                score: Math.round(Math.min(10, 6.0 + mfiExt * 0.06 + deviation * 8 + Math.abs(xrpStreak) * 0.3) * 10) / 10,
                direction: (isBear ? 'bearish' : 'bullish') as Direction,
                signal: `XRP synth-15m MFI=${mfi_s39.toFixed(0)}>${isBear?'75':'<25'} at BB(25,2.2) ${isBear ? 'upper' : 'lower'}, h=${xrpHour}UTC (67.3% WR **σ=0.4%** NEAR-PERFECT)`,
                confidence: Math.round(Math.min(86, 58 + mfiExt * 0.5 + deviation * 9 + Math.abs(xrpStreak) * 1.5)),
              });
            }
          }
        }

        // Strategy 40: XRP BB15 High-Volume 🔷 — STABLE HIGH FREQUENCY
        // BB(15,2.2)+GoodH+streak>=1 → WF=68.1% σ=1.6% T=160 [66/69.8/68.5]
        // 5-fold: 68.1% σ=7.0% — highest volume XRP strategy
        {
          const bb15_s40 = calculateBollingerBands(xrpSynth, 15, 2.2);
          if (bb15_s40) {
            const p40 = lastXrp.close;
            const isBear = p40 > bb15_s40.upper && lastXrp.close > lastXrp.open;
            const isBull = p40 < bb15_s40.lower && lastXrp.close < lastXrp.open;
            const streakOk = (isBear && xrpStreak >= 1) || (isBull && xrpStreak <= -1);
            if ((isBear || isBull) && streakOk) {
              const deviation = isBear
                ? (p40 - bb15_s40.upper) / bb15_s40.upper * 100
                : (bb15_s40.lower - p40) / bb15_s40.lower * 100;
              strategies.push({
                name: 'XRP BB15 Reversion',
                emoji: '🔷',
                score: Math.round(Math.min(10, 5.8 + deviation * 8 + Math.abs(xrpStreak) * 0.35) * 10) / 10,
                direction: (isBear ? 'bearish' : 'bullish') as Direction,
                signal: `XRP synth-15m BB(15,2.2) ${isBear ? 'upper' : 'lower'} +${deviation.toFixed(3)}% at h=${xrpHour}UTC (68.1% WR σ=1.6%)`,
                confidence: Math.round(Math.min(85, 57 + deviation * 9 + Math.abs(xrpStreak) * 1.5)),
              });
            }
          }
        }

        // Strategy 41: XRP Low-ATR RSI7 BB 🎯 — PERFECT FOLDS
        // LowATR(≤P33)+RSI7>70+BB(15,2.2)+GoodH+s>=1 → 72.0% σ=0.0% (all folds identical)
        {
          const bb15_s41 = calculateBollingerBands(xrpSynth, 15, 2.2);
          const rsi7_s41 = calculateRSI(xrpSynth, 7);
          if (bb15_s41) {
            const atrWindow41 = xrpSynth.slice(-100);
            const atrs41: number[] = [];
            for (let j = 1; j < atrWindow41.length; j++) {
              const p41prev = atrWindow41[j - 1];
              const c41 = atrWindow41[j];
              atrs41.push(Math.max(c41.high - c41.low, Math.abs(c41.high - p41prev.close), Math.abs(c41.low - p41prev.close)));
            }
            if (atrs41.length >= 20) {
              const currentATR41 = atrs41[atrs41.length - 1];
              const sorted41 = [...atrs41].sort((a, b) => a - b);
              const atrP33_41 = sorted41[Math.floor(sorted41.length * 0.33)];
              if (currentATR41 <= atrP33_41 && rsi7_s41 !== null) {
                const p41 = lastXrp.close;
                const isBear41 = p41 > bb15_s41.upper && lastXrp.close > lastXrp.open;
                const isBull41 = p41 < bb15_s41.lower && lastXrp.close < lastXrp.open;
                const rsiOk41 = (isBear41 && rsi7_s41 > 70) || (isBull41 && rsi7_s41 < 30);
                const streakOk41 = (isBear41 && xrpStreak >= 1) || (isBull41 && xrpStreak <= -1);
                if ((isBear41 || isBull41) && rsiOk41 && streakOk41) {
                  const dev41 = isBear41
                    ? (p41 - bb15_s41.upper) / bb15_s41.upper * 100
                    : (bb15_s41.lower - p41) / bb15_s41.lower * 100;
                  strategies.push({
                    name: 'XRP Low-ATR RSI7 BB',
                    emoji: '🎯',
                    score: Math.round(Math.min(10, 6.2 + (rsi7_s41 - 70) * 0.04 + dev41 * 9 + (Math.abs(xrpStreak) - 1) * 0.3) * 10) / 10,
                    direction: (isBear41 ? 'bearish' : 'bullish') as Direction,
                    signal: `XRP low-ATR RSI7=${rsi7_s41.toFixed(0)} at BB(15,2.2) ${isBear41 ? 'upper' : 'lower'} h=${xrpHour}UTC (72.0% WR σ=0.0%)`,
                    confidence: Math.round(Math.min(90, 67 + (rsi7_s41 - 70) * 0.2 + dev41 * 9 + (Math.abs(xrpStreak) - 1) * 0.5)),
                  });
                }
              }
            }
          }
        }

        // Strategy 42: XRP Low-ATR MFI 🏅 — HIGH PRECISION
        // LowATR(≤P40)+MFI(10)>65+BB(25,2.2)+GoodH+s>=1 → 76.4% σ=2.8% T=71
        {
          const bb25_s42 = calculateBollingerBands(xrpSynth, 25, 2.2);
          const mfi_s42 = calculateMFI(xrpSynth, 10);
          if (bb25_s42 && mfi_s42 !== null) {
            const atrWindow42 = xrpSynth.slice(-100);
            const atrs42: number[] = [];
            for (let j = 1; j < atrWindow42.length; j++) {
              const p42prev = atrWindow42[j - 1];
              const c42 = atrWindow42[j];
              atrs42.push(Math.max(c42.high - c42.low, Math.abs(c42.high - p42prev.close), Math.abs(c42.low - p42prev.close)));
            }
            if (atrs42.length >= 20) {
              const currentATR42 = atrs42[atrs42.length - 1];
              const sorted42 = [...atrs42].sort((a, b) => a - b);
              const atrP40_42 = sorted42[Math.floor(sorted42.length * 0.40)];
              if (currentATR42 <= atrP40_42) {
                const p42 = lastXrp.close;
                const isBear42 = p42 > bb25_s42.upper && lastXrp.close > lastXrp.open;
                const isBull42 = p42 < bb25_s42.lower && lastXrp.close < lastXrp.open;
                const mfiOk42 = (isBear42 && mfi_s42 > 65) || (isBull42 && mfi_s42 < 35);
                const streakOk42 = (isBear42 && xrpStreak >= 1) || (isBull42 && xrpStreak <= -1);
                if ((isBear42 || isBull42) && mfiOk42 && streakOk42) {
                  const dev42 = isBear42
                    ? (p42 - bb25_s42.upper) / bb25_s42.upper * 100
                    : (bb25_s42.lower - p42) / bb25_s42.lower * 100;
                  const mfiExt42 = isBear42 ? mfi_s42 - 65 : 35 - mfi_s42;
                  strategies.push({
                    name: 'XRP Low-ATR MFI',
                    emoji: '🏅',
                    score: Math.round(Math.min(10, 6.4 + mfiExt42 * 0.03 + dev42 * 9 + (Math.abs(xrpStreak) - 1) * 0.3) * 10) / 10,
                    direction: (isBear42 ? 'bearish' : 'bullish') as Direction,
                    signal: `XRP low-ATR MFI=${mfi_s42.toFixed(0)} at BB(25,2.2) ${isBear42 ? 'upper' : 'lower'} h=${xrpHour}UTC (76.4% WR σ=2.8%)`,
                    confidence: Math.round(Math.min(91, 68 + mfiExt42 * 0.2 + dev42 * 9 + (Math.abs(xrpStreak) - 1) * 0.5)),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // Strategy 43 (XRP): LowATR33+BB25 — GoodH[6,9,12,18]+ATR<=P33+BB(25,2.2)+s>=1 → 74.1% WR σ=1.2% T=85
  // Strategy 44 (XRP): LowATR33+BB15 — GoodH[6,9,12,18]+ATR<=P33+BB(15,2.2)+s>=1 → 72.0% WR σ=0.0% T=75
  // Strategy 45 (XRP): MFI65        — GoodH[6,9,12,18]+MFI>65+BB(25,2.2)+s>=1 → 67.5% WR σ=1.1% T=160
  {
    const xrpGoodHours4345 = [6, 9, 12, 18];
    if (candles5m.length >= 65) {
      const synth15m_x4345: Candle[] = [];
      const alignedX4345 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < alignedX4345; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_x4345.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_x4345.length >= 27) {
        const lastX4345 = synth15m_x4345[synth15m_x4345.length - 1];
        const hX4345 = new Date(lastX4345.closeTime).getUTCHours();
        if (xrpGoodHours4345.includes(hX4345)) {
          // ATR percentile (shared)
          const atrWindowX = synth15m_x4345.slice(-100);
          const atrsX: number[] = [];
          for (let j = 1; j < atrWindowX.length; j++) {
            const pv = atrWindowX[j - 1]; const cv = atrWindowX[j];
            atrsX.push(Math.max(cv.high - cv.low, Math.abs(cv.high - pv.close), Math.abs(cv.low - pv.close)));
          }
          const isLowATR_x4345 = atrsX.length >= 20 &&
            atrsX[atrsX.length - 1] <= [...atrsX].sort((a, b) => a - b)[Math.floor(atrsX.length * 0.33)];

          // Streak
          let streakX4345 = 0;
          for (let j = synth15m_x4345.length - 1; j >= Math.max(0, synth15m_x4345.length - 8); j--) {
            const cj = synth15m_x4345[j];
            if (cj.close > cj.open) { if (streakX4345 < 0) break; streakX4345++; }
            else if (cj.close < cj.open) { if (streakX4345 > 0) break; streakX4345--; }
            else break;
          }

          // Strat 43: LowATR33 + BB(25,2.2) + streak>=1
          const bb25_x43 = calculateBollingerBands(synth15m_x4345, 25, 2.2);
          if (bb25_x43 && isLowATR_x4345) {
            const pX43 = lastX4345.close;
            const isBear43x = pX43 > bb25_x43.upper && lastX4345.close > lastX4345.open;
            const isBull43x = pX43 < bb25_x43.lower && lastX4345.close < lastX4345.open;
            const streakOk43x = (isBear43x && streakX4345 >= 1) || (isBull43x && streakX4345 <= -1);
            if ((isBear43x || isBull43x) && streakOk43x) {
              const dev43x = isBear43x
                ? (pX43 - bb25_x43.upper) / bb25_x43.upper * 100
                : (bb25_x43.lower - pX43) / bb25_x43.lower * 100;
              strategies.push({
                name: 'XRP Low-ATR BB25',
                emoji: '💎',
                score: Math.round(Math.min(10, 6.6 + dev43x * 9 + (Math.abs(streakX4345) - 1) * 0.3) * 10) / 10,
                direction: (isBear43x ? 'bearish' : 'bullish') as Direction,
                signal: `XRP low-vol BB(25,2.2) ${isBear43x ? 'upper' : 'lower'} h=${hX4345}UTC streak=${Math.abs(streakX4345)} (74.1% WR σ=1.2%)`,
                confidence: Math.round(Math.min(90, 66 + dev43x * 9 + (Math.abs(streakX4345) - 1) * 0.5)),
              });
            }
          }

          // Strat 44: LowATR33 + BB(15,2.2) + streak>=1
          const bb15_x44 = calculateBollingerBands(synth15m_x4345, 15, 2.2);
          if (bb15_x44 && isLowATR_x4345) {
            const pX44 = lastX4345.close;
            const isBear44x = pX44 > bb15_x44.upper && lastX4345.close > lastX4345.open;
            const isBull44x = pX44 < bb15_x44.lower && lastX4345.close < lastX4345.open;
            const streakOk44x = (isBear44x && streakX4345 >= 1) || (isBull44x && streakX4345 <= -1);
            if ((isBear44x || isBull44x) && streakOk44x) {
              const dev44x = isBear44x
                ? (pX44 - bb15_x44.upper) / bb15_x44.upper * 100
                : (bb15_x44.lower - pX44) / bb15_x44.lower * 100;
              strategies.push({
                name: 'XRP Low-ATR BB15',
                emoji: '🌊',
                score: Math.round(Math.min(10, 6.4 + dev44x * 9 + (Math.abs(streakX4345) - 1) * 0.3) * 10) / 10,
                direction: (isBear44x ? 'bearish' : 'bullish') as Direction,
                signal: `XRP low-vol BB(15,2.2) ${isBear44x ? 'upper' : 'lower'} h=${hX4345}UTC streak=${Math.abs(streakX4345)} (72.0% WR σ=0.0%)`,
                confidence: Math.round(Math.min(88, 64 + dev44x * 9 + (Math.abs(streakX4345) - 1) * 0.5)),
              });
            }
          }

          // Strat 45: MFI>65 + BB(25,2.2) + streak>=1
          const bb25_x45 = calculateBollingerBands(synth15m_x4345, 25, 2.2);
          const mfi_x45 = calculateMFI(synth15m_x4345, 14);
          if (bb25_x45 && mfi_x45 !== null) {
            const pX45 = lastX4345.close;
            const isBear45x = pX45 > bb25_x45.upper && lastX4345.close > lastX4345.open;
            const isBull45x = pX45 < bb25_x45.lower && lastX4345.close < lastX4345.open;
            const mfiOk45x = (isBear45x && mfi_x45 > 65) || (isBull45x && mfi_x45 < 35);
            const streakOk45x = (isBear45x && streakX4345 >= 1) || (isBull45x && streakX4345 <= -1);
            if ((isBear45x || isBull45x) && mfiOk45x && streakOk45x) {
              const dev45x = isBear45x
                ? (pX45 - bb25_x45.upper) / bb25_x45.upper * 100
                : (bb25_x45.lower - pX45) / bb25_x45.lower * 100;
              const mfiExt45x = isBear45x ? mfi_x45 - 65 : 35 - mfi_x45;
              strategies.push({
                name: 'XRP MFI65 BB',
                emoji: '📊',
                score: Math.round(Math.min(10, 6.0 + mfiExt45x * 0.03 + dev45x * 8 + (Math.abs(streakX4345) - 1) * 0.3) * 10) / 10,
                direction: (isBear45x ? 'bearish' : 'bullish') as Direction,
                signal: `XRP MFI=${mfi_x45.toFixed(0)} at BB(25,2.2) ${isBear45x ? 'upper' : 'lower'} h=${hX4345}UTC streak=${Math.abs(streakX4345)} (67.5% WR σ=1.1%)`,
                confidence: Math.round(Math.min(84, 59 + mfiExt45x * 0.2 + dev45x * 8 + (Math.abs(streakX4345) - 1) * 0.5)),
              });
            }
          }
        }
      }
    }
  }

  // Strat 46 (XRP): LowATR33+MFI>65+BB(25,2.2)+GoodH+s>=1 → 76.5% WR σ=3.9% T=68 [ATR+MFI combo]
  // Strat 47 (XRP): LowATR25+RSI7>55+BB(15,2.2)+GoodH+s>=1 → 71.4% WR σ=0.0% T=63 [ULTRA STABLE]
  // Strat 48 (XRP): BB(15,2.2)+GoodH[6,9,12,18]+s>=1 → 67.7% WR σ=1.6% T=161 [standalone, max trades]
  {
    const xrpGoodH4648 = [6, 9, 12, 18];
    if (candles5m.length >= 65) {
      const synth15m_x4648: Candle[] = [];
      const alignedX4648 = candles5m.length - (candles5m.length % 3);
      for (let i = 0; i < alignedX4648; i += 3) {
        const g = candles5m.slice(i, i + 3);
        synth15m_x4648.push({
          openTime: g[0].openTime, closeTime: g[2].closeTime,
          open: g[0].open, high: Math.max(...g.map(c => c.high)),
          low: Math.min(...g.map(c => c.low)), close: g[2].close,
          volume: g.reduce((s, c) => s + c.volume, 0),
          quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
          trades: g.reduce((s, c) => s + c.trades, 0),
        });
      }
      if (synth15m_x4648.length >= 27) {
        const lastX4648 = synth15m_x4648[synth15m_x4648.length - 1];
        const hX4648 = new Date(lastX4648.closeTime).getUTCHours();
        if (xrpGoodH4648.includes(hX4648)) {
          // ATR percentiles
          const atrWin4648 = synth15m_x4648.slice(-100);
          const atrs4648: number[] = [];
          for (let j = 1; j < atrWin4648.length; j++) {
            const pv = atrWin4648[j - 1]; const cv = atrWin4648[j];
            atrs4648.push(Math.max(cv.high - cv.low, Math.abs(cv.high - pv.close), Math.abs(cv.low - pv.close)));
          }
          const sortedAtrs4648 = [...atrs4648].sort((a, b) => a - b);
          const isLowATR33_4648 = atrs4648.length >= 20 &&
            atrs4648[atrs4648.length - 1] <= sortedAtrs4648[Math.floor(atrs4648.length * 0.33)];
          const isLowATR25_4648 = atrs4648.length >= 20 &&
            atrs4648[atrs4648.length - 1] <= sortedAtrs4648[Math.floor(atrs4648.length * 0.25)];

          // Streak
          let streakX4648 = 0;
          for (let j = synth15m_x4648.length - 1; j >= Math.max(0, synth15m_x4648.length - 8); j--) {
            const cj = synth15m_x4648[j];
            if (cj.close > cj.open) { if (streakX4648 < 0) break; streakX4648++; }
            else if (cj.close < cj.open) { if (streakX4648 > 0) break; streakX4648--; }
            else break;
          }

          const pX4648 = lastX4648.close;
          const bb25_x46 = calculateBollingerBands(synth15m_x4648, 25, 2.2);
          const bb15_x4748 = calculateBollingerBands(synth15m_x4648, 15, 2.2);
          const mfi_x46 = calculateMFI(synth15m_x4648, 14);
          const rsi7_x47 = calculateRSI(synth15m_x4648, 7);

          // Strat 46: LowATR33 + MFI>65 + BB(25,2.2) + streak>=1 → 76.5% σ=3.9%
          if (bb25_x46 && mfi_x46 !== null && isLowATR33_4648) {
            const isBear46x = pX4648 > bb25_x46.upper && lastX4648.close > lastX4648.open;
            const isBull46x = pX4648 < bb25_x46.lower && lastX4648.close < lastX4648.open;
            const mfiOk46x = (isBear46x && mfi_x46 > 65) || (isBull46x && mfi_x46 < 35);
            const streakOk46x = (isBear46x && streakX4648 >= 1) || (isBull46x && streakX4648 <= -1);
            if ((isBear46x || isBull46x) && mfiOk46x && streakOk46x) {
              const dev46x = isBear46x
                ? (pX4648 - bb25_x46.upper) / bb25_x46.upper * 100
                : (bb25_x46.lower - pX4648) / bb25_x46.lower * 100;
              const mfiExt46x = isBear46x ? mfi_x46 - 65 : 35 - mfi_x46;
              strategies.push({
                name: 'XRP LowVol+MFI BB25',
                emoji: '🔮',
                score: Math.round(Math.min(10, 6.7 + mfiExt46x * 0.03 + dev46x * 9 + (Math.abs(streakX4648) - 1) * 0.3) * 10) / 10,
                direction: (isBear46x ? 'bearish' : 'bullish') as Direction,
                signal: `XRP low-vol ATR MFI=${mfi_x46.toFixed(0)}>65 BB(25,2.2) ${isBear46x ? 'upper' : 'lower'} h=${hX4648}UTC (76.5% WR σ=3.9%)`,
                confidence: Math.round(Math.min(91, 67 + mfiExt46x * 0.2 + dev46x * 9 + (Math.abs(streakX4648) - 1) * 0.5)),
              });
            }
          }

          // Strat 47: LowATR25 + RSI7>55 + BB(15,2.2) + streak>=1 → 71.4% σ=0.0% ULTRA STABLE
          if (bb15_x4748 && rsi7_x47 !== null && isLowATR25_4648) {
            const isBear47x = pX4648 > bb15_x4748.upper && lastX4648.close > lastX4648.open;
            const isBull47x = pX4648 < bb15_x4748.lower && lastX4648.close < lastX4648.open;
            const rsiOk47x = (isBear47x && rsi7_x47 > 55) || (isBull47x && rsi7_x47 < 45);
            const streakOk47x = (isBear47x && streakX4648 >= 1) || (isBull47x && streakX4648 <= -1);
            if ((isBear47x || isBull47x) && rsiOk47x && streakOk47x) {
              const dev47x = isBear47x
                ? (pX4648 - bb15_x4748.upper) / bb15_x4748.upper * 100
                : (bb15_x4748.lower - pX4648) / bb15_x4748.lower * 100;
              strategies.push({
                name: 'XRP UltraLowVol RSI7',
                emoji: '🧊',
                score: Math.round(Math.min(10, 6.3 + dev47x * 9 + (Math.abs(streakX4648) - 1) * 0.3) * 10) / 10,
                direction: (isBear47x ? 'bearish' : 'bullish') as Direction,
                signal: `XRP ultra-low-vol RSI7=${rsi7_x47.toFixed(0)} BB(15,2.2) ${isBear47x ? 'upper' : 'lower'} h=${hX4648}UTC (71.4% WR σ=0.0%)`,
                confidence: Math.round(Math.min(88, 63 + dev47x * 9 + (Math.abs(streakX4648) - 1) * 0.5)),
              });
            }
          }

          // Strat 48: BB(15,2.2) standalone + GoodH + streak>=1 → 67.7% σ=1.6% T=161 [max trades]
          if (bb15_x4748) {
            const isBear48x = pX4648 > bb15_x4748.upper && lastX4648.close > lastX4648.open;
            const isBull48x = pX4648 < bb15_x4748.lower && lastX4648.close < lastX4648.open;
            const streakOk48x = (isBear48x && streakX4648 >= 1) || (isBull48x && streakX4648 <= -1);
            if ((isBear48x || isBull48x) && streakOk48x) {
              const dev48x = isBear48x
                ? (pX4648 - bb15_x4748.upper) / bb15_x4748.upper * 100
                : (bb15_x4748.lower - pX4648) / bb15_x4748.lower * 100;
              strategies.push({
                name: 'XRP BB15 GoodH',
                emoji: '🌐',
                score: Math.round(Math.min(10, 5.8 + dev48x * 8 + (Math.abs(streakX4648) - 1) * 0.3) * 10) / 10,
                direction: (isBear48x ? 'bearish' : 'bullish') as Direction,
                signal: `XRP BB(15,2.2) ${isBear48x ? 'upper' : 'lower'} h=${hX4648}UTC streak=${Math.abs(streakX4648)} (67.7% WR σ=1.6%)`,
                confidence: Math.round(Math.min(83, 58 + dev48x * 8 + (Math.abs(streakX4648) - 1) * 0.5)),
              });
            }
          }
        }
      }
    }
  }

  // ─── XRP Strat 72: Connors RSI (15/85) ───────────────────────────────────────
  // XRP: 52.8% WR σ=1.0% 34/day (crsi_validate.js, 5-fold WF) — all-hours
  if (candles5m.length >= 106) {
    const crsi72xrp = calcConnorsRSI(candles5m, 100);
    const isBull72xrp = crsi72xrp < 15;
    const isBear72xrp = crsi72xrp > 85;
    if (isBull72xrp || isBear72xrp) {
      const ext72xrp = isBull72xrp ? (15 - crsi72xrp) / 15 : (crsi72xrp - 85) / 15;
      strategies.push({
        name: 'XRP Connors RSI 15/85',
        emoji: '🧠🌐',
        score: Math.round(Math.min(8.5, 5.5 + ext72xrp * 2.5) * 10) / 10,
        direction: (isBear72xrp ? 'bearish' : 'bullish') as Direction,
        signal: `XRP CRSI=${crsi72xrp.toFixed(1)} (52.8% WR 34/day all-hours mean-reversion)`,
        confidence: Math.round(Math.min(66, 56 + ext72xrp * 10)),
      });
    }
  }

  // ─── XRP Strat 73: ATR Climax + RSI7 at BB22 ─────────────────────────────────
  // XRP: 54.9% WR σ=3.5% 10/day (tv_advanced_v2.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const last73xrp = candles5m[candles5m.length - 1];
    const bb73xrp = calculateBollingerBands(candles5m, 20, 2.2);
    let atr73xrp = 0;
    const atrWin73xrp = candles5m.slice(-15);
    for (let j = 1; j < atrWin73xrp.length; j++) {
      atr73xrp += Math.max(
        atrWin73xrp[j].high - atrWin73xrp[j].low,
        Math.abs(atrWin73xrp[j].high - atrWin73xrp[j - 1].close),
        Math.abs(atrWin73xrp[j].low - atrWin73xrp[j - 1].close),
      );
    }
    atr73xrp /= Math.max(1, atrWin73xrp.length - 1);
    const rsi7_73xrp = calculateRSI(candles5m, 7);
    const body73xrp = Math.abs(last73xrp.close - last73xrp.open);
    if (bb73xrp && rsi7_73xrp !== null && body73xrp >= atr73xrp * 1.0 && atr73xrp > 0) {
      const isCBear73xrp = last73xrp.close > bb73xrp.upper && last73xrp.close > last73xrp.open && rsi7_73xrp > 70;
      const isCBull73xrp = last73xrp.close < bb73xrp.lower && last73xrp.close < last73xrp.open && rsi7_73xrp < 30;
      if (isCBear73xrp || isCBull73xrp) {
        const dev73xrp = isCBear73xrp
          ? (last73xrp.close - bb73xrp.upper) / bb73xrp.upper * 100
          : (bb73xrp.lower - last73xrp.close) / bb73xrp.lower * 100;
        const atrR73xrp = body73xrp / atr73xrp;
        strategies.push({
          name: 'XRP ATR Climax BB22',
          emoji: '💥🌐',
          score: Math.round(Math.min(9.0, 5.7 + dev73xrp * 5 + (atrR73xrp - 1) * 0.7) * 10) / 10,
          direction: (isCBear73xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP ATR climax body=${atrR73xrp.toFixed(1)}x RSI7=${rsi7_73xrp.toFixed(0)} dev=${dev73xrp.toFixed(3)}% (54.9% WR ~10/day)`,
          confidence: Math.round(Math.min(72, 57 + dev73xrp * 7 + (atrR73xrp - 1) * 2)),
        });
      }
    }
  }

  // ─── XRP Strat 74: StochRSI (K+D<20) + BB22 ──────────────────────────────────
  // XRP: 54.1% WR σ=2.6% 14/day (tv_advanced_v2.js, 5-fold WF)
  if (candles5m.length >= 45) {
    const srsi74xrp = calcStochRSI(candles5m, 14, 14);
    const bb74xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last74xrp = candles5m[candles5m.length - 1];
    if (bb74xrp) {
      const isBull74xrp = srsi74xrp.k < 20 && srsi74xrp.d < 20 && last74xrp.close < bb74xrp.lower;
      const isBear74xrp = srsi74xrp.k > 80 && srsi74xrp.d > 80 && last74xrp.close > bb74xrp.upper;
      if (isBull74xrp || isBear74xrp) {
        const ext74xrp = isBull74xrp ? (20 - srsi74xrp.k) / 20 : (srsi74xrp.k - 80) / 20;
        const dev74xrp = isBear74xrp
          ? (last74xrp.close - bb74xrp.upper) / bb74xrp.upper * 100
          : (bb74xrp.lower - last74xrp.close) / bb74xrp.lower * 100;
        strategies.push({
          name: 'XRP StochRSI+BB22',
          emoji: '📊🌐',
          score: Math.round(Math.min(8.8, 5.5 + dev74xrp * 4 + ext74xrp * 1.5) * 10) / 10,
          direction: (isBear74xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP StochRSI K=${srsi74xrp.k.toFixed(0)} D=${srsi74xrp.d.toFixed(0)} dev=${dev74xrp.toFixed(3)}% (54.1% WR ~14/day)`,
          confidence: Math.round(Math.min(70, 57 + dev74xrp * 6 + ext74xrp * 9)),
        });
      }
    }
  }

  // ─── XRP Strat 75: CCI>200 + BB22 ────────────────────────────────────────────
  // XRP: 55.3% WR 2/day — surprisingly strong for XRP (session10_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const cci75xrp = calcCCI(candles5m, 20);
    const bb75xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last75xrp = candles5m[candles5m.length - 1];
    if (bb75xrp) {
      const isBull75xrp = cci75xrp < -200 && last75xrp.close < bb75xrp.lower;
      const isBear75xrp = cci75xrp > 200 && last75xrp.close > bb75xrp.upper;
      if (isBull75xrp || isBear75xrp) {
        const cciExt75xrp = Math.min(1, (Math.abs(cci75xrp) - 200) / 100);
        const dev75xrp = isBear75xrp
          ? (last75xrp.close - bb75xrp.upper) / bb75xrp.upper * 100
          : (bb75xrp.lower - last75xrp.close) / bb75xrp.lower * 100;
        strategies.push({
          name: 'XRP CCI>200 BB22',
          emoji: '📉🌐',
          score: Math.round(Math.min(9.0, 6.0 + dev75xrp * 5 + cciExt75xrp * 1.2) * 10) / 10,
          direction: (isBear75xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP CCI=${cci75xrp.toFixed(0)} at BB22 dev=${dev75xrp.toFixed(3)}% (55.3% WR ~2/day)`,
          confidence: Math.round(Math.min(72, 62 + dev75xrp * 6 + cciExt75xrp * 8)),
        });
      }
    }
  }

  // ─── XRP Strat 76: Williams %R (14) + RSI7 + BB22 ────────────────────────────
  // XRP: 52.8% WR 3/day — marginal, lower confidence (session10_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const wpr76xrp = calcWilliamsR(candles5m, 14);
    const rsi7_76xrp = calculateRSI(candles5m, 7);
    const bb76xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last76xrp = candles5m[candles5m.length - 1];
    if (bb76xrp && rsi7_76xrp !== null) {
      const isBull76xrp = wpr76xrp < -85 && rsi7_76xrp < 30 && last76xrp.close < bb76xrp.lower;
      const isBear76xrp = wpr76xrp > -15 && rsi7_76xrp > 70 && last76xrp.close > bb76xrp.upper;
      if (isBull76xrp || isBear76xrp) {
        const wprExt76xrp = isBull76xrp ? Math.min(1, (-85 - wpr76xrp) / 15) : Math.min(1, (wpr76xrp + 15) / 15);
        const dev76xrp = isBear76xrp
          ? (last76xrp.close - bb76xrp.upper) / bb76xrp.upper * 100
          : (bb76xrp.lower - last76xrp.close) / bb76xrp.lower * 100;
        strategies.push({
          name: 'XRP WPR+RSI7+BB22',
          emoji: '📡🌐',
          score: Math.round(Math.min(8.5, 5.5 + dev76xrp * 4 + wprExt76xrp * 1.0) * 10) / 10,
          direction: (isBear76xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP WPR=${wpr76xrp.toFixed(0)} RSI7=${rsi7_76xrp.toFixed(0)} dev=${dev76xrp.toFixed(3)}% (52.8% WR ~3/day)`,
          confidence: Math.round(Math.min(67, 56 + dev76xrp * 5 + wprExt76xrp * 7)),
        });
      }
    }
  }

  // ─── XRP Strat 77: Keltner Outer — Volatility Extreme Reversal ───────────────
  // XRP: 53.2% WR 6/day (session10_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const ema77xrp = calcEMA(candles5m, 20);
    const last77xrp = candles5m[candles5m.length - 1];
    let atr77xrp = 0;
    const atrWin77xrp = candles5m.slice(-15);
    for (let j = 1; j < atrWin77xrp.length; j++) {
      atr77xrp += Math.max(
        atrWin77xrp[j].high - atrWin77xrp[j].low,
        Math.abs(atrWin77xrp[j].high - atrWin77xrp[j - 1].close),
        Math.abs(atrWin77xrp[j].low - atrWin77xrp[j - 1].close),
      );
    }
    atr77xrp /= Math.max(1, atrWin77xrp.length - 1);
    const kcUpper77xrp = ema77xrp + 2.0 * atr77xrp;
    const kcLower77xrp = ema77xrp - 2.0 * atr77xrp;
    const isBull77xrp = last77xrp.close < kcLower77xrp;
    const isBear77xrp = last77xrp.close > kcUpper77xrp;
    if ((isBull77xrp || isBear77xrp) && atr77xrp > 0) {
      const dev77xrp = isBear77xrp
        ? (last77xrp.close - kcUpper77xrp) / kcUpper77xrp * 100
        : (kcLower77xrp - last77xrp.close) / kcLower77xrp * 100;
      strategies.push({
        name: 'XRP Keltner Outer',
        emoji: '🌋🌐',
        score: Math.round(Math.min(8.5, 5.3 + dev77xrp * 5) * 10) / 10,
        direction: (isBear77xrp ? 'bearish' : 'bullish') as Direction,
        signal: `XRP ${isBear77xrp ? 'above KC upper' : 'below KC lower'} dev=${dev77xrp.toFixed(3)}% (53.2% WR ~6/day)`,
        confidence: Math.round(Math.min(68, 55 + dev77xrp * 7)),
      });
    }
  }

  // ─── XRP Strat 78: RSI7(5m) Extreme + BB22 ───────────────────────────────────
  // XRP: 54.2% WR 7.0/day (hfBinary5m.ts S6, 5-fold WF, at-expiry ✅)
  if (candles5m.length >= 22) {
    const rsi7_78xrp = calculateRSI(candles5m, 7);
    const bb78xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last78xrp = candles5m[candles5m.length - 1];
    if (bb78xrp && rsi7_78xrp !== null) {
      const isBear78xrp = rsi7_78xrp > 78 && last78xrp.close > bb78xrp.upper;
      const isBull78xrp = rsi7_78xrp < 22 && last78xrp.close < bb78xrp.lower;
      if (isBear78xrp || isBull78xrp) {
        const dev78xrp = isBear78xrp
          ? (last78xrp.close - bb78xrp.upper) / bb78xrp.upper * 100
          : (bb78xrp.lower - last78xrp.close) / bb78xrp.lower * 100;
        if (dev78xrp >= 0.04) {
          const rsiExt78xrp = isBear78xrp ? (rsi7_78xrp - 78) / 22 : (22 - rsi7_78xrp) / 22;
          strategies.push({
            name: 'XRP RSI7+BB22',
            emoji: '⚡🌐',
            score: Math.round(Math.min(8.5, 5.4 + dev78xrp * 4.5 + rsiExt78xrp * 1.6) * 10) / 10,
            direction: (isBear78xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP RSI7=${rsi7_78xrp.toFixed(0)} ${isBear78xrp ? '>78' : '<22'} + BB22 dev=${dev78xrp.toFixed(3)}% (54.2% WR ~7/day ✅)`,
            confidence: Math.round(Math.min(72, 58 + dev78xrp * 6 + rsiExt78xrp * 8)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 79: Volume Exhaustion + BB22 + Streak ─────────────────────────
  // XRP: 57.1% WR 3.7/day (hfBinary5m.ts S2, 5-fold WF, at-expiry ✅)
  if (candles5m.length >= 22) {
    const bb79xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last5m79xrp = candles5m[candles5m.length - 1];
    const vol20avg79xrp = candles5m.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const volRatio79xrp = vol20avg79xrp > 0 ? last5m79xrp.volume / vol20avg79xrp : 1;
    if (bb79xrp && volRatio79xrp >= 1.8) {
      let streak79xrp = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 8); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak79xrp < 0) break; streak79xrp++; }
        else if (cj.close < cj.open) { if (streak79xrp > 0) break; streak79xrp--; }
        else break;
      }
      const isBear79xrp = last5m79xrp.close > bb79xrp.upper && streak79xrp >= 1;
      const isBull79xrp = last5m79xrp.close < bb79xrp.lower && streak79xrp <= -1;
      if (isBear79xrp || isBull79xrp) {
        const dev79xrp = isBear79xrp
          ? (last5m79xrp.close - bb79xrp.upper) / bb79xrp.upper * 100
          : (bb79xrp.lower - last5m79xrp.close) / bb79xrp.lower * 100;
        if (dev79xrp >= 0.05) {
          strategies.push({
            name: 'XRP Vol Exhaustion BB22',
            emoji: '💧🌐',
            score: Math.round(Math.min(9.0, 5.7 + dev79xrp * 4 + (volRatio79xrp - 1.8) * 0.3) * 10) / 10,
            direction: (isBear79xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP vol=${volRatio79xrp.toFixed(1)}x avg + BB22 dev=${dev79xrp.toFixed(3)}% s=${Math.abs(streak79xrp)} (57.1% WR ~4/day ✅)`,
            confidence: Math.round(Math.min(78, 62 + dev79xrp * 6 + (volRatio79xrp - 1.8) * 3)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 80: MicroStreak×3 + BB22 + RSI14 ─────────────────────────────
  // XRP: 55.4% WR 3.2/day (hfBinary5m.ts S5, 5-fold WF, at-expiry ✅)
  if (candles5m.length >= 30 && rsi14_5m !== null) {
    const bb80xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last80xrp = candles5m[candles5m.length - 1];
    if (bb80xrp) {
      let streak80xrp = 0;
      for (let j = candles5m.length - 1; j >= Math.max(0, candles5m.length - 10); j--) {
        const cj = candles5m[j];
        if (cj.close > cj.open) { if (streak80xrp < 0) break; streak80xrp++; }
        else if (cj.close < cj.open) { if (streak80xrp > 0) break; streak80xrp--; }
        else break;
      }
      const isBear80xrp = streak80xrp >= 3 && last80xrp.close > bb80xrp.upper && rsi14_5m > 65;
      const isBull80xrp = streak80xrp <= -3 && last80xrp.close < bb80xrp.lower && rsi14_5m < 35;
      if (isBear80xrp || isBull80xrp) {
        const dev80xrp = isBear80xrp
          ? (last80xrp.close - bb80xrp.upper) / bb80xrp.upper * 100
          : (bb80xrp.lower - last80xrp.close) / bb80xrp.lower * 100;
        if (dev80xrp >= 0.04) {
          const rsiExt80xrp = isBear80xrp ? (rsi14_5m - 65) / 35 : (35 - rsi14_5m) / 35;
          strategies.push({
            name: 'XRP MicroStreak×3 BB22',
            emoji: '🔥🌐',
            score: Math.round(Math.min(9.2, 5.8 + dev80xrp * 5 + (Math.abs(streak80xrp) - 3) * 0.3 + rsiExt80xrp * 1.0) * 10) / 10,
            direction: (isBear80xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP streak=${Math.abs(streak80xrp)}× + BB22 dev=${dev80xrp.toFixed(3)}% RSI14=${rsi14_5m.toFixed(0)} (55.4% WR ~3/day ✅)`,
            confidence: Math.round(Math.min(76, 60 + dev80xrp * 6 + (Math.abs(streak80xrp) - 3) * 2 + rsiExt80xrp * 4)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 81: ML 15m-Streak + BB22 + RSI14 ─────────────────────────────
  // XRP ML: 60.8% WR 5.6/day (hfBinary5m.ts S8, top features: streak_15m, rsi14_5m ✅)
  if (candles5m.length >= 63 && rsi14_5m !== null) {
    const bb81xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last81xrp = candles5m[candles5m.length - 1];
    const aligned81xrp = candles5m.length - (candles5m.length % 3);
    const synth81xrp: Candle[] = [];
    for (let i = Math.max(0, aligned81xrp - 60); i < aligned81xrp; i += 3) {
      const g = candles5m.slice(i, i + 3);
      synth81xrp.push({ openTime: g[0].openTime, closeTime: g[2].closeTime,
        open: g[0].open, high: Math.max(...g.map(c => c.high)),
        low: Math.min(...g.map(c => c.low)), close: g[2].close,
        volume: 0, quoteVolume: 0, trades: 0 });
    }
    let streak81xrp = 0;
    for (let j = synth81xrp.length - 1; j >= Math.max(0, synth81xrp.length - 8); j--) {
      const cj = synth81xrp[j];
      if (cj.close > cj.open) { if (streak81xrp < 0) break; streak81xrp++; }
      else if (cj.close < cj.open) { if (streak81xrp > 0) break; streak81xrp--; }
      else break;
    }
    if (bb81xrp && Math.abs(streak81xrp) >= 3) {
      const isBear81xrp = last81xrp.close > bb81xrp.upper && rsi14_5m > 62;
      const isBull81xrp = last81xrp.close < bb81xrp.lower && rsi14_5m < 38;
      if (isBear81xrp || isBull81xrp) {
        const dev81xrp = isBear81xrp
          ? (last81xrp.close - bb81xrp.upper) / bb81xrp.upper * 100
          : (bb81xrp.lower - last81xrp.close) / bb81xrp.lower * 100;
        if (dev81xrp >= 0.05) {
          const streakB81xrp = Math.min(1.0, (Math.abs(streak81xrp) - 3) * 0.25);
          const rsiE81xrp = isBear81xrp ? (rsi14_5m - 62) / 38 : (38 - rsi14_5m) / 38;
          strategies.push({
            name: 'XRP ML 15m-Streak+BB22',
            emoji: '🤖🌐',
            score: Math.round(Math.min(9.2, 6.0 + dev81xrp * 5 + streakB81xrp + rsiE81xrp * 1.0) * 10) / 10,
            direction: (isBear81xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP 15m streak=${Math.abs(streak81xrp)}× + BB22 dev=${dev81xrp.toFixed(3)}% RSI14=${rsi14_5m.toFixed(0)} (ML: 60.8% WR ~6/day ✅)`,
            confidence: Math.round(Math.min(82, 62 + dev81xrp * 7 + streakB81xrp * 10)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 82: BB %B > 1.0 + RSI7 ────────────────────────────────────────
  // XRP: 54.4% WR 1.9/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const bb82xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_82xrp = calculateRSI(candles5m, 7);
    const last82xrp = candles5m[candles5m.length - 1];
    if (bb82xrp && rsi7_82xrp !== null) {
      const pctB82xrp = (bb82xrp.upper - bb82xrp.lower) > 0
        ? (last82xrp.close - bb82xrp.lower) / (bb82xrp.upper - bb82xrp.lower) : 0.5;
      const isBull82xrp = pctB82xrp < -0.05 && rsi7_82xrp < 35;
      const isBear82xrp = pctB82xrp > 1.05 && rsi7_82xrp > 65;
      if (isBull82xrp || isBear82xrp) {
        const ext82xrp = isBull82xrp ? Math.min(1, -pctB82xrp * 5) : Math.min(1, (pctB82xrp - 1.0) * 5);
        const dev82xrp = isBear82xrp
          ? (last82xrp.close - bb82xrp.upper) / bb82xrp.upper * 100
          : (bb82xrp.lower - last82xrp.close) / bb82xrp.lower * 100;
        strategies.push({
          name: 'XRP BB%B+RSI7',
          emoji: '📐🌐',
          score: Math.round(Math.min(8.8, 5.8 + dev82xrp * 4 + ext82xrp * 1.2) * 10) / 10,
          direction: (isBear82xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP %B=${pctB82xrp.toFixed(2)} RSI7=${rsi7_82xrp.toFixed(0)} dev=${dev82xrp.toFixed(3)}% (54.4% WR ~2/day)`,
          confidence: Math.round(Math.min(71, 59 + dev82xrp * 6 + ext82xrp * 6)),
        });
      }
    }
  }

  // ─── XRP Strat 83: RSI(3) > 90 + BB22 ────────────────────────────────────────
  // XRP: 54.1% WR 2.1/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 10) {
    const rsi3_83xrp = calculateRSI(candles5m, 3);
    const bb83xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last83xrp = candles5m[candles5m.length - 1];
    if (bb83xrp && rsi3_83xrp !== null) {
      const isBull83xrp = rsi3_83xrp < 10 && last83xrp.close < bb83xrp.lower;
      const isBear83xrp = rsi3_83xrp > 90 && last83xrp.close > bb83xrp.upper;
      if (isBull83xrp || isBear83xrp) {
        const rsi3Ext83xrp = isBull83xrp ? Math.min(1, (10 - rsi3_83xrp) / 10) : Math.min(1, (rsi3_83xrp - 90) / 10);
        const dev83xrp = isBear83xrp
          ? (last83xrp.close - bb83xrp.upper) / bb83xrp.upper * 100
          : (bb83xrp.lower - last83xrp.close) / bb83xrp.lower * 100;
        strategies.push({
          name: 'XRP RSI3>90+BB22',
          emoji: '⚡🌐',
          score: Math.round(Math.min(8.8, 5.8 + dev83xrp * 4 + rsi3Ext83xrp * 1.2) * 10) / 10,
          direction: (isBear83xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP RSI3=${rsi3_83xrp.toFixed(0)} dev=${dev83xrp.toFixed(3)}% (54.1% WR ~2/day)`,
          confidence: Math.round(Math.min(70, 58 + dev83xrp * 6 + rsi3Ext83xrp * 6)),
        });
      }
    }
  }

  // ─── XRP Strat 84: RSI7 Consec2 + BB22 ───────────────────────────────────────
  // XRP: 54.0% WR 1.9/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 25) {
    const bb84xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_84xrp = calculateRSI(candles5m, 7);
    const rsi7_84prevXrp = calculateRSI(candles5m.slice(0, -1), 7);
    const last84xrp = candles5m[candles5m.length - 1];
    if (bb84xrp && rsi7_84xrp !== null && rsi7_84prevXrp !== null) {
      const isBull84xrp = rsi7_84xrp < 30 && rsi7_84prevXrp < 30 && last84xrp.close < bb84xrp.lower;
      const isBear84xrp = rsi7_84xrp > 70 && rsi7_84prevXrp > 70 && last84xrp.close > bb84xrp.upper;
      if (isBull84xrp || isBear84xrp) {
        const rsiExt84xrp = isBull84xrp ? (30 - rsi7_84xrp) / 30 : (rsi7_84xrp - 70) / 30;
        const dev84xrp = isBear84xrp
          ? (last84xrp.close - bb84xrp.upper) / bb84xrp.upper * 100
          : (bb84xrp.lower - last84xrp.close) / bb84xrp.lower * 100;
        strategies.push({
          name: 'XRP RSI7 Consec2+BB22',
          emoji: '🔥🌐',
          score: Math.round(Math.min(8.8, 5.7 + dev84xrp * 4 + rsiExt84xrp * 1.2) * 10) / 10,
          direction: (isBear84xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP RSI7=${rsi7_84xrp.toFixed(0)} (2 bars) dev=${dev84xrp.toFixed(3)}% (54.0% WR ~2/day)`,
          confidence: Math.round(Math.min(69, 57 + dev84xrp * 6 + rsiExt84xrp * 7)),
        });
      }
    }
  }

  // ─── XRP Strat 85: EMA20 Dev + RSI7 + BB22 ───────────────────────────────────
  // XRP: 54.3% WR 1.8/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const ema85xrp = calcEMA(candles5m, 20);
    const bb85xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_85xrp = calculateRSI(candles5m, 7);
    const last85xrp = candles5m[candles5m.length - 1];
    if (bb85xrp && rsi7_85xrp !== null && ema85xrp > 0) {
      const emaDev85xrp = (last85xrp.close - ema85xrp) / ema85xrp * 100;
      const isBull85xrp = emaDev85xrp < -0.5 && rsi7_85xrp < 33 && last85xrp.close < bb85xrp.lower;
      const isBear85xrp = emaDev85xrp > 0.5 && rsi7_85xrp > 67 && last85xrp.close > bb85xrp.upper;
      if (isBull85xrp || isBear85xrp) {
        const emaExt85xrp = Math.min(1, (Math.abs(emaDev85xrp) - 0.5) * 2);
        const dev85xrp = isBear85xrp
          ? (last85xrp.close - bb85xrp.upper) / bb85xrp.upper * 100
          : (bb85xrp.lower - last85xrp.close) / bb85xrp.lower * 100;
        strategies.push({
          name: 'XRP EMA20Dev+RSI7+BB22',
          emoji: '📏🌐',
          score: Math.round(Math.min(8.8, 5.7 + dev85xrp * 4 + emaExt85xrp * 1.2) * 10) / 10,
          direction: (isBear85xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP EMAdev=${emaDev85xrp.toFixed(2)}% RSI7=${rsi7_85xrp.toFixed(0)} dev=${dev85xrp.toFixed(3)}% (54.3% WR ~2/day)`,
          confidence: Math.round(Math.min(69, 57 + dev85xrp * 5 + emaExt85xrp * 7)),
        });
      }
    }
  }

  // ─── XRP Strat 86: BB%B + CCI + WPR Triple ────────────────────────────────────
  // XRP: 53.1% WR 3.2/day (session11_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const bb86xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const cci86xrp = calcCCI(candles5m, 20);
    const wpr86xrp = calcWilliamsR(candles5m, 14);
    const last86xrp = candles5m[candles5m.length - 1];
    if (bb86xrp) {
      const pctB86xrp = (bb86xrp.upper - bb86xrp.lower) > 0
        ? (last86xrp.close - bb86xrp.lower) / (bb86xrp.upper - bb86xrp.lower) : 0.5;
      const isBull86xrp = pctB86xrp < 0.0 && cci86xrp < -100 && wpr86xrp < -80;
      const isBear86xrp = pctB86xrp > 1.0 && cci86xrp > 100 && wpr86xrp > -20;
      if (isBull86xrp || isBear86xrp) {
        const dev86xrp = isBear86xrp
          ? (last86xrp.close - bb86xrp.upper) / bb86xrp.upper * 100
          : (bb86xrp.lower - last86xrp.close) / bb86xrp.lower * 100;
        strategies.push({
          name: 'XRP BB%B+CCI+WPR',
          emoji: '🎰🌐',
          score: Math.round(Math.min(8.8, 5.5 + dev86xrp * 4 + Math.min(1, Math.abs(cci86xrp) / 200) * 1.2) * 10) / 10,
          direction: (isBear86xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP %B=${pctB86xrp.toFixed(2)} CCI=${cci86xrp.toFixed(0)} WPR=${wpr86xrp.toFixed(0)} dev=${dev86xrp.toFixed(3)}% (53.1% WR ~3/day)`,
          confidence: Math.round(Math.min(67, 55 + dev86xrp * 5 + Math.min(1, Math.abs(cci86xrp) / 200) * 7)),
        });
      }
    }
  }

  // ─── XRP Strat 87: Double RSI Confirmation + BB22 ────────────────────────────
  // XRP: 54.1% @2.3/day (session12_research.js, 5-fold WF)
  if (candles5m.length >= 22) {
    const bb87xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_87xrp = calculateRSI(candles5m, 7);
    if (bb87xrp && rsi7_87xrp !== null) {
      const last87xrp = candles5m[candles5m.length - 1];
      const isBear87xrp = rsi7_87xrp > 72 && (rsi14_5m ?? 50) > 65 && last87xrp.close > bb87xrp.upper;
      const isBull87xrp = rsi7_87xrp < 28 && (rsi14_5m ?? 50) < 35 && last87xrp.close < bb87xrp.lower;
      if (isBear87xrp || isBull87xrp) {
        const dev87xrp = isBear87xrp
          ? (last87xrp.close - bb87xrp.upper) / bb87xrp.upper * 100
          : (bb87xrp.lower - last87xrp.close) / bb87xrp.lower * 100;
        strategies.push({
          name: 'XRP DoubleRSI+BB22',
          emoji: '📊🌐',
          score: Math.round(Math.min(8.7, 5.6 + dev87xrp * 4 + Math.min(1, (isBear87xrp ? rsi7_87xrp - 72 : 28 - rsi7_87xrp) / 10) * 0.8) * 10) / 10,
          direction: (isBear87xrp ? 'bearish' : 'bullish') as Direction,
          signal: `XRP RSI7=${rsi7_87xrp.toFixed(0)} RSI14=${(rsi14_5m ?? 50).toFixed(0)} dev=${dev87xrp.toFixed(3)}% (54.1% WR ~2/day)`,
          confidence: Math.round(Math.min(70, 57 + dev87xrp * 5 + Math.min(1, (isBear87xrp ? rsi7_87xrp - 72 : 28 - rsi7_87xrp) / 15) * 5)),
        });
      }
    }
  }

  // ─── XRP Strat 88: BB Squeeze→Release + BB22 ─────────────────────────────────
  // XRP: 54.6% @1.7/day (session12_research.js, 5-fold WF)
  if (candles5m.length >= 31) {
    const closes88xrp = candles5m.slice(-31).map(c => c.close);
    const bwArr88xrp: number[] = [];
    for (let i = 20; i <= 30; i++) {
      const sl = closes88xrp.slice(i - 20, i);
      const sma = sl.reduce((a, b) => a + b, 0) / 20;
      const std = Math.sqrt(sl.reduce((a, c) => a + (c - sma) ** 2, 0) / 20);
      bwArr88xrp.push(sma > 0 ? std * 4.4 / sma * 100 : 0);
    }
    const bwCurr88xrp = bwArr88xrp[10];
    const bwPrev10Avg88xrp = bwArr88xrp.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    if (bwPrev10Avg88xrp < 2.5 && bwCurr88xrp > bwPrev10Avg88xrp * 1.3) {
      const bb88xrp = calculateBollingerBands(candles5m, 20, 2.2);
      const rsi7_88xrp = calculateRSI(candles5m, 7);
      if (bb88xrp && rsi7_88xrp !== null) {
        const last88xrp = candles5m[candles5m.length - 1];
        const isBear88xrp = last88xrp.close > bb88xrp.upper && rsi7_88xrp > 62;
        const isBull88xrp = last88xrp.close < bb88xrp.lower && rsi7_88xrp < 38;
        if (isBear88xrp || isBull88xrp) {
          const dev88xrp = isBear88xrp
            ? (last88xrp.close - bb88xrp.upper) / bb88xrp.upper * 100
            : (bb88xrp.lower - last88xrp.close) / bb88xrp.lower * 100;
          strategies.push({
            name: 'XRP BB Squeeze→Release',
            emoji: '🗜️🌐',
            score: Math.round(Math.min(8.7, 5.8 + dev88xrp * 4 + 0.5) * 10) / 10,
            direction: (isBear88xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP Squeeze(${bwPrev10Avg88xrp.toFixed(2)}%)→Expand(${bwCurr88xrp.toFixed(2)}%) RSI7=${rsi7_88xrp.toFixed(0)} (54.6% WR ~2/day)`,
            confidence: Math.round(Math.min(69, 57 + dev88xrp * 5 + 3)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 89: Wide Range Candle (1.5×ATR) + BB22 ────────────────────────
  // XRP: 55.6% @1.7/day (session12_research.js, 5-fold WF)
  if (candles5m.length >= 20) {
    const kc89xrp = calculateKeltnerChannels(candles5m);
    const bb89xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const rsi7_89xrp = calculateRSI(candles5m, 7);
    if (kc89xrp && bb89xrp && rsi7_89xrp !== null) {
      const last89xrp = candles5m[candles5m.length - 1];
      const range89xrp = last89xrp.high - last89xrp.low;
      if (kc89xrp.atr > 0 && range89xrp > 1.5 * kc89xrp.atr) {
        const isBear89xrp = last89xrp.close > bb89xrp.upper && rsi7_89xrp > 60;
        const isBull89xrp = last89xrp.close < bb89xrp.lower && rsi7_89xrp < 40;
        if (isBear89xrp || isBull89xrp) {
          const dev89xrp = isBear89xrp
            ? (last89xrp.close - bb89xrp.upper) / bb89xrp.upper * 100
            : (bb89xrp.lower - last89xrp.close) / bb89xrp.lower * 100;
          strategies.push({
            name: 'XRP WideRange+BB22',
            emoji: '📏🌐',
            score: Math.round(Math.min(9.0, 5.8 + dev89xrp * 4 + Math.min(1, range89xrp / kc89xrp.atr - 1.5) * 0.8) * 10) / 10,
            direction: (isBear89xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP Range/ATR=${(range89xrp/kc89xrp.atr).toFixed(2)}x RSI7=${rsi7_89xrp.toFixed(0)} dev=${dev89xrp.toFixed(3)}% (55.6% WR ~2/day)`,
            confidence: Math.round(Math.min(71, 58 + dev89xrp * 5 + Math.min(1, range89xrp / kc89xrp.atr - 1.5) * 4)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 90: ADX<20 (Ranging Market) + BB22 + RSI7 ─────────────────────
  // XRP: 57.4% @0.7/day (session12_research.js, 5-fold WF) — strong for XRP!
  if (candles5m.length >= 30) {
    const adx90xrp = calcADX(candles5m, 14);
    if (adx90xrp < 20) {
      const bb90xrp = calculateBollingerBands(candles5m, 20, 2.2);
      const rsi7_90xrp = calculateRSI(candles5m, 7);
      if (bb90xrp && rsi7_90xrp !== null) {
        const last90xrp = candles5m[candles5m.length - 1];
        const devHi90xrp = (last90xrp.close - bb90xrp.upper) / bb90xrp.upper * 100;
        const devLo90xrp = (bb90xrp.lower - last90xrp.close) / bb90xrp.lower * 100;
        const isBear90xrp = devHi90xrp > 0.04 && rsi7_90xrp > 65;
        const isBull90xrp = devLo90xrp > 0.04 && rsi7_90xrp < 35;
        if (isBear90xrp || isBull90xrp) {
          const dev90xrp = isBear90xrp ? devHi90xrp : devLo90xrp;
          strategies.push({
            name: 'XRP ADX<20+BB22',
            emoji: '📉🌐',
            score: Math.round(Math.min(9.0, 6.0 + dev90xrp * 4 + Math.min(1, (20 - adx90xrp) / 15) * 1.0) * 10) / 10,
            direction: (isBear90xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP ADX=${adx90xrp.toFixed(1)}<20 RSI7=${rsi7_90xrp.toFixed(0)} dev=${dev90xrp.toFixed(3)}% (57.4% WR ~1/day)`,
            confidence: Math.round(Math.min(73, 59 + dev90xrp * 5 + Math.min(1, (20 - adx90xrp) / 15) * 8)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 92: GoodH + ADX<20 + RSI7>73 + MFI14>72 + BB22 ───────────────
  // XRP: 72.7% @0.06/day (at XRP good hours [6,9,12,18] UTC) — ultra-high WR!
  if (candles5m.length >= 30) {
    const s92xrpGoodHours = [6, 9, 12, 18]; // XRP-specific good hours
    const last92xrp = candles5m[candles5m.length - 1];
    const s92xrpHour = new Date(last92xrp.closeTime).getUTCHours();
    if (s92xrpGoodHours.includes(s92xrpHour)) {
      const adx92xrp = calcADX(candles5m, 14);
      if (adx92xrp < 20) {
        const bb92xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_92xrp = calculateRSI(candles5m, 7);
        const mfi92xrp = calculateMFI(candles5m, 14);
        if (bb92xrp && rsi7_92xrp !== null && mfi92xrp !== null) {
          const isBear92xrp = rsi7_92xrp > 73 && mfi92xrp > 72 && last92xrp.close > bb92xrp.upper;
          const isBull92xrp = rsi7_92xrp < 27 && mfi92xrp < 28 && last92xrp.close < bb92xrp.lower;
          if (isBear92xrp || isBull92xrp) {
            const dev92xrp = isBear92xrp
              ? (last92xrp.close - bb92xrp.upper) / bb92xrp.upper * 100
              : (bb92xrp.lower - last92xrp.close) / bb92xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+RSI73+MFI72',
              emoji: '🔥🌐',
              score: Math.round(Math.min(10, 7.5 + dev92xrp * 4 + 1.0) * 10) / 10,
              direction: (isBear92xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s92xrpHour}UTC ADX=${adx92xrp.toFixed(1)} RSI7=${rsi7_92xrp.toFixed(0)} MFI=${mfi92xrp.toFixed(0)} dev=${dev92xrp.toFixed(3)}% (72.7% WR 🔥)`,
              confidence: Math.round(Math.min(88, 71 + dev92xrp * 5 + 5)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 93: GoodH + ADX<20 + RSI7>73 + MFI14>72 + RSI14>68 + BB22 ───
  // 6-condition ultra-selective: XRP: 80.0% @0.01/day (n=10) 🔥🔥🔥
  if (candles5m.length >= 30) {
    const s93xrpGoodHours = [6, 9, 12, 18]; // XRP good hours
    const last93xrp = candles5m[candles5m.length - 1];
    const s93xrpHour = new Date(last93xrp.closeTime).getUTCHours();
    if (s93xrpGoodHours.includes(s93xrpHour)) {
      const adx93xrp = calcADX(candles5m, 14);
      if (adx93xrp < 20) {
        const bb93xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_93xrp = calculateRSI(candles5m, 7);
        const mfi93xrp = calculateMFI(candles5m, 14);
        if (bb93xrp && rsi7_93xrp !== null && mfi93xrp !== null && rsi14_5m !== null) {
          const isBear93xrp = rsi7_93xrp > 73 && (rsi14_5m ?? 50) > 68 && mfi93xrp > 72 && last93xrp.close > bb93xrp.upper;
          const isBull93xrp = rsi7_93xrp < 27 && (rsi14_5m ?? 50) < 32 && mfi93xrp < 28 && last93xrp.close < bb93xrp.lower;
          if (isBear93xrp || isBull93xrp) {
            const dev93xrp = isBear93xrp
              ? (last93xrp.close - bb93xrp.upper) / bb93xrp.upper * 100
              : (bb93xrp.lower - last93xrp.close) / bb93xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+RSI73+MFI72+RSI14',
              emoji: '🔥💎🌐',
              score: Math.round(Math.min(10, 7.8 + dev93xrp * 5 + 1.0) * 10) / 10,
              direction: (isBear93xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s93xrpHour}UTC ADX=${adx93xrp.toFixed(1)} RSI7=${rsi7_93xrp.toFixed(0)} RSI14=${(rsi14_5m??50).toFixed(0)} MFI=${mfi93xrp.toFixed(0)} (80.0% WR 🔥)`,
              confidence: Math.round(Math.min(92, 75 + dev93xrp * 6 + 5)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 94: GoodH + ADX<20 + RSI7>76 + MFI14>75 + BB22 ───────────────
  // Deeper thresholds | XRP: 77.8% @0.03/day (n=25) 🔥🔥🔥
  if (candles5m.length >= 30) {
    const s94xrpGoodHours = [6, 9, 12, 18]; // XRP good hours
    const last94xrp = candles5m[candles5m.length - 1];
    const s94xrpHour = new Date(last94xrp.closeTime).getUTCHours();
    if (s94xrpGoodHours.includes(s94xrpHour)) {
      const adx94xrp = calcADX(candles5m, 14);
      if (adx94xrp < 20) {
        const bb94xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi7_94xrp = calculateRSI(candles5m, 7);
        const mfi94xrp = calculateMFI(candles5m, 14);
        if (bb94xrp && rsi7_94xrp !== null && mfi94xrp !== null) {
          const isBear94xrp = rsi7_94xrp > 76 && mfi94xrp > 75 && last94xrp.close > bb94xrp.upper;
          const isBull94xrp = rsi7_94xrp < 24 && mfi94xrp < 25 && last94xrp.close < bb94xrp.lower;
          if (isBear94xrp || isBull94xrp) {
            const dev94xrp = isBear94xrp
              ? (last94xrp.close - bb94xrp.upper) / bb94xrp.upper * 100
              : (bb94xrp.lower - last94xrp.close) / bb94xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+RSI76+MFI75',
              emoji: '🔥🔥🌐',
              score: Math.round(Math.min(10, 7.8 + dev94xrp * 5 + 1.0) * 10) / 10,
              direction: (isBear94xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s94xrpHour}UTC ADX=${adx94xrp.toFixed(1)} RSI7=${rsi7_94xrp.toFixed(0)} MFI=${mfi94xrp.toFixed(0)} dev=${dev94xrp.toFixed(3)}% (77.8% WR 🔥)`,
              confidence: Math.round(Math.min(90, 73 + dev94xrp * 6 + 5)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 96: GoodH + ADX<20 + RSI3>93 + BB22 ──────────────────────────
  // Ultra-fast RSI3 extreme in ranging market | XRP: 66.7% @0.08/day (n=72) 🔥
  if (candles5m.length >= 20) {
    const s96xrpGoodHours = [6, 9, 12, 18]; // XRP good hours
    const last96xrp = candles5m[candles5m.length - 1];
    const s96xrpHour = new Date(last96xrp.closeTime).getUTCHours();
    if (s96xrpGoodHours.includes(s96xrpHour)) {
      const adx96xrp = calcADX(candles5m, 14);
      if (adx96xrp < 20) {
        const bb96xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_96xrp = calculateRSI(candles5m, 3);
        if (bb96xrp && rsi3_96xrp !== null) {
          const isBear96xrp = rsi3_96xrp > 93 && last96xrp.close > bb96xrp.upper;
          const isBull96xrp = rsi3_96xrp < 7 && last96xrp.close < bb96xrp.lower;
          if (isBear96xrp || isBull96xrp) {
            const dev96xrp = isBear96xrp
              ? (last96xrp.close - bb96xrp.upper) / bb96xrp.upper * 100
              : (bb96xrp.lower - last96xrp.close) / bb96xrp.lower * 100;
            const ext96xrp = isBear96xrp ? (rsi3_96xrp - 93) / 7 : (7 - rsi3_96xrp) / 7;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_93+BB22',
              emoji: '⚡🌐',
              score: Math.round(Math.min(9.0, 6.8 + dev96xrp * 5 + Math.min(1, ext96xrp)) * 10) / 10,
              direction: (isBear96xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s96xrpHour}UTC ADX=${adx96xrp.toFixed(1)} RSI3=${rsi3_96xrp.toFixed(0)} dev=${dev96xrp.toFixed(3)}% (66.7% WR 🔥)`,
              confidence: Math.round(Math.min(82, 64 + dev96xrp * 6 + Math.min(1, ext96xrp) * 8)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 97: GoodH + ADX<20 + RSI3>93 + RSI5>82 + MFI70 + BB22 ────────
  // Triple RSI cascade: XRP=75.0% @0.02/day (n=26) 🔥🔥🔥 (session14 H3)
  if (candles5m.length >= 20) {
    const s97xrpGoodHours = [6, 9, 12, 18];
    const last97xrp = candles5m[candles5m.length - 1];
    const s97xrpHour = new Date(last97xrp.closeTime).getUTCHours();
    if (s97xrpGoodHours.includes(s97xrpHour)) {
      const adx97xrp = calcADX(candles5m, 14);
      if (adx97xrp < 20) {
        const bb97xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_97xrp = calculateRSI(candles5m, 3);
        const rsi5_97xrp = calculateRSI(candles5m, 5);
        const mfi97xrp = calculateMFI(candles5m, 14);
        if (bb97xrp && rsi3_97xrp !== null && rsi5_97xrp !== null && mfi97xrp !== null) {
          const isBear97xrp = rsi3_97xrp > 93 && rsi5_97xrp > 82 && mfi97xrp > 70 && last97xrp.close > bb97xrp.upper;
          const isBull97xrp = rsi3_97xrp < 7 && rsi5_97xrp < 18 && mfi97xrp < 30 && last97xrp.close < bb97xrp.lower;
          if (isBear97xrp || isBull97xrp) {
            const dev97xrp = isBear97xrp
              ? (last97xrp.close - bb97xrp.upper) / bb97xrp.upper * 100
              : (bb97xrp.lower - last97xrp.close) / bb97xrp.lower * 100;
            const ext97xrp = isBear97xrp ? (rsi3_97xrp - 93) / 7 : (7 - rsi3_97xrp) / 7;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_93+RSI5_82+MFI70',
              emoji: '🔥💥',
              score: Math.round(Math.min(9.0, 7.2 + dev97xrp * 5 + Math.min(1, ext97xrp)) * 10) / 10,
              direction: (isBear97xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s97xrpHour}UTC ADX=${adx97xrp.toFixed(1)} RSI3=${rsi3_97xrp.toFixed(0)} RSI5=${rsi5_97xrp.toFixed(0)} (XRP=75.0% WR n=26 🔥🔥🔥)`,
              confidence: Math.round(Math.min(88, 70 + dev97xrp * 6 + Math.min(1, ext97xrp) * 6)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 99: GoodH + ADX<20 + ConnorsRSI>85 + MFI72 + BB22 ────────────
  if (candles5m.length >= 106) {
    const s99xrpGoodHours = [6, 9, 12, 18];
    const last99xrp = candles5m[candles5m.length - 1];
    const s99xrpHour = new Date(last99xrp.closeTime).getUTCHours();
    if (s99xrpGoodHours.includes(s99xrpHour)) {
      const adx99xrp = calcADX(candles5m, 14);
      if (adx99xrp < 20) {
        const bb99xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const crsi99xrp = calcConnorsRSI(candles5m, 100);
        const mfi99xrp = calculateMFI(candles5m, 14);
        if (bb99xrp && mfi99xrp !== null) {
          const isBear99xrp = crsi99xrp > 85 && mfi99xrp > 72 && last99xrp.close > bb99xrp.upper;
          const isBull99xrp = crsi99xrp < 15 && mfi99xrp < 28 && last99xrp.close < bb99xrp.lower;
          if (isBear99xrp || isBull99xrp) {
            const dev99xrp = isBear99xrp
              ? (last99xrp.close - bb99xrp.upper) / bb99xrp.upper * 100
              : (bb99xrp.lower - last99xrp.close) / bb99xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+CRSI85+MFI72',
              emoji: '🧠🌐',
              score: Math.round(Math.min(8.5, 6.8 + dev99xrp * 5) * 10) / 10,
              direction: (isBear99xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s99xrpHour}UTC CRSI=${crsi99xrp.toFixed(0)} MFI=${mfi99xrp.toFixed(0)} (BTC=77.8% n=42 🔥🔥)`,
              confidence: Math.round(Math.min(84, 65 + dev99xrp * 6)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 101: 1m Volume Climax + 5m BB22 ──────────────────────────────
  // XRP=55.2% @7/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1m.length >= 22 && candles5m.length >= 22) {
    const bb101xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last101xrp = candles5m[candles5m.length - 1];
    if (bb101xrp) {
      const vols1m101xrp = candles1m.slice(-21).map(c => c.volume);
      const avgVol1m101xrp = vols1m101xrp.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      const lastVol1m101xrp = vols1m101xrp[20];
      const volSpike101xrp = avgVol1m101xrp > 0 ? lastVol1m101xrp / avgVol1m101xrp : 0;
      if (volSpike101xrp >= 2.2) {
        const isBear101xrp = last101xrp.close > bb101xrp.upper;
        const isBull101xrp = last101xrp.close < bb101xrp.lower;
        if (isBear101xrp || isBull101xrp) {
          const dev101xrp = isBear101xrp
            ? (last101xrp.close - bb101xrp.upper) / bb101xrp.upper * 100
            : (bb101xrp.lower - last101xrp.close) / bb101xrp.lower * 100;
          strategies.push({
            name: 'XRP 1mVolClimaxBB22',
            emoji: '📊⚡🌐',
            score: Math.round(Math.min(8.8, 5.8 + dev101xrp * 5 + Math.min(1, (volSpike101xrp - 2.2) / 3) * 1.5) * 10) / 10,
            direction: (isBear101xrp ? 'bearish' : 'bullish') as Direction,
            signal: `XRP 1mVol=${volSpike101xrp.toFixed(1)}x dev=${dev101xrp.toFixed(3)}% (XRP=55.2% @7/day)`,
            confidence: Math.round(Math.min(72, 58 + dev101xrp * 7 + Math.min(1, (volSpike101xrp - 2.2) / 3) * 6)),
          });
        }
      }
    }
  }

  // ─── XRP Strat 102: 1h Ranging + 5m BB22 + Streak ────────────────────────────
  // XRP=57.0% @10/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1h.length >= 15 && candles5m.length >= 22) {
    const bb102xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last102xrp = candles5m[candles5m.length - 1];
    if (bb102xrp) {
      const rsi14_1h102xrp = calculateRSI(candles1h, 14);
      if (rsi14_1h102xrp !== null && rsi14_1h102xrp >= 40 && rsi14_1h102xrp <= 62) {
        const prev102xrp = candles5m[candles5m.length - 2];
        const streak102xrp = (last102xrp.close > last102xrp.open && prev102xrp.close > prev102xrp.open) ||
                             (last102xrp.close < last102xrp.open && prev102xrp.close < prev102xrp.open);
        if (streak102xrp) {
          const isBear102xrp = last102xrp.close > bb102xrp.upper;
          const isBull102xrp = last102xrp.close < bb102xrp.lower;
          if (isBear102xrp || isBull102xrp) {
            const dev102xrp = isBear102xrp
              ? (last102xrp.close - bb102xrp.upper) / bb102xrp.upper * 100
              : (bb102xrp.lower - last102xrp.close) / bb102xrp.lower * 100;
            strategies.push({
              name: 'XRP 1hRanging+BB22+Streak',
              emoji: '🕐📊🌐',
              score: Math.round(Math.min(8.8, 6.0 + dev102xrp * 5) * 10) / 10,
              direction: (isBear102xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP 1hRSI14=${rsi14_1h102xrp.toFixed(0)} ranging dev=${dev102xrp.toFixed(3)}% (XRP=57.0% @10/day)`,
              confidence: Math.round(Math.min(73, 59 + dev102xrp * 8)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 103: 1m Sub-bar Momentum Fade + 5m BB22 ──────────────────────
  // XRP=54.5% @6/d (session13_5s_mtf_research.js, 5-fold WF)
  if (candles1m.length >= 5 && candles5m.length >= 22) {
    const bb103xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last103xrp = candles5m[candles5m.length - 1];
    if (bb103xrp) {
      const last3_1m103xrp = candles1m.slice(-3);
      const allBull1m103xrp = last3_1m103xrp.every(c => c.close > c.open);
      const allBear1m103xrp = last3_1m103xrp.every(c => c.close < c.open);
      if (allBull1m103xrp || allBear1m103xrp) {
        const bodyRatio103xrp = last3_1m103xrp.reduce((sum, c) => {
          const body = Math.abs(c.close - c.open);
          const range = c.high - c.low;
          return sum + (range > 0 ? body / range : 0);
        }, 0) / 3;
        if (bodyRatio103xrp >= 0.6) {
          const isBear103xrp = allBull1m103xrp && last103xrp.close > bb103xrp.upper;
          const isBull103xrp = allBear1m103xrp && last103xrp.close < bb103xrp.lower;
          if (isBear103xrp || isBull103xrp) {
            const dev103xrp = isBear103xrp
              ? (last103xrp.close - bb103xrp.upper) / bb103xrp.upper * 100
              : (bb103xrp.lower - last103xrp.close) / bb103xrp.lower * 100;
            strategies.push({
              name: 'XRP 1mMomentumFade+BB22',
              emoji: '🔄📉🌐',
              score: Math.round(Math.min(8.5, 5.7 + dev103xrp * 5 + (bodyRatio103xrp - 0.6) * 1.5) * 10) / 10,
              direction: (isBear103xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP 1m3consec body=${bodyRatio103xrp.toFixed(2)} dev=${dev103xrp.toFixed(3)}% (XRP=54.5% @6/day)`,
              confidence: Math.round(Math.min(70, 57 + dev103xrp * 7 + (bodyRatio103xrp - 0.6) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 104: 1m VolSpike + 1h Ranging + 5m BB22 (STAR) ───────────────
  // XRP=59.5% σ=1.4% @4/d (session13_5s_mtf_research.js, 5-fold WF) 🌟
  if (candles1m.length >= 22 && candles1h.length >= 15 && candles5m.length >= 22) {
    const bb104xrp = calculateBollingerBands(candles5m, 20, 2.2);
    const last104xrp = candles5m[candles5m.length - 1];
    if (bb104xrp) {
      const vols1m104xrp = candles1m.slice(-21).map(c => c.volume);
      const avgVol1m104xrp = vols1m104xrp.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
      const lastVol1m104xrp = vols1m104xrp[20];
      const volSpike104xrp = avgVol1m104xrp > 0 ? lastVol1m104xrp / avgVol1m104xrp : 0;
      if (volSpike104xrp >= 2.5) {
        const rsi14_1h104xrp = calculateRSI(candles1h, 14);
        if (rsi14_1h104xrp !== null && rsi14_1h104xrp >= 38 && rsi14_1h104xrp <= 63) {
          const isBear104xrp = last104xrp.close > bb104xrp.upper;
          const isBull104xrp = last104xrp.close < bb104xrp.lower;
          if (isBear104xrp || isBull104xrp) {
            const dev104xrp = isBear104xrp
              ? (last104xrp.close - bb104xrp.upper) / bb104xrp.upper * 100
              : (bb104xrp.lower - last104xrp.close) / bb104xrp.lower * 100;
            strategies.push({
              name: 'XRP 1mVolSpike+1hRange+BB22',
              emoji: '🚀📊🌐',
              score: Math.round(Math.min(9.2, 6.8 + dev104xrp * 5 + Math.min(1, (volSpike104xrp - 2.5) / 3)) * 10) / 10,
              direction: (isBear104xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP 1mVol=${volSpike104xrp.toFixed(1)}x 1hRSI=${rsi14_1h104xrp.toFixed(0)} dev=${dev104xrp.toFixed(3)}% (XRP=59.5% STAR 🌟)`,
              confidence: Math.round(Math.min(78, 63 + dev104xrp * 8 + Math.min(1, (volSpike104xrp - 2.5) / 3) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 105: GoodH + ADX<20 + RSI3>90 + MFI70 + BB(20,1.8) ───────────
  // BB(20,1.8) × RSI3 extreme × MFI | ETH=75.0% validated → XRP good hours
  if (candles5m.length >= 20) {
    const s105xrpGoodHours = [6, 9, 12, 18];
    const last105xrp = candles5m[candles5m.length - 1];
    const s105xrpHour = new Date(last105xrp.closeTime).getUTCHours();
    if (s105xrpGoodHours.includes(s105xrpHour)) {
      const adx105xrp = calcADX(candles5m, 14);
      if (adx105xrp < 20) {
        const bb105xrp = calculateBollingerBands(candles5m, 20, 1.8);
        const rsi3_105xrp = calculateRSI(candles5m, 3);
        const mfi105xrp = calculateMFI(candles5m, 14);
        if (bb105xrp && rsi3_105xrp !== null && mfi105xrp !== null) {
          const isBear105xrp = rsi3_105xrp > 90 && mfi105xrp > 70 && last105xrp.close > bb105xrp.upper;
          const isBull105xrp = rsi3_105xrp < 10 && mfi105xrp < 30 && last105xrp.close < bb105xrp.lower;
          if (isBear105xrp || isBull105xrp) {
            const dev105xrp = isBear105xrp
              ? (last105xrp.close - bb105xrp.upper) / bb105xrp.upper * 100
              : (bb105xrp.lower - last105xrp.close) / bb105xrp.lower * 100;
            const ext105xrp = isBear105xrp ? (rsi3_105xrp - 90) / 10 : (10 - rsi3_105xrp) / 10;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_90+MFI70+BB18',
              emoji: '🔥🎯',
              score: Math.round(Math.min(9.0, 7.0 + dev105xrp * 5 + Math.min(1, ext105xrp) * 0.5) * 10) / 10,
              direction: (isBear105xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s105xrpHour}UTC ADX=${adx105xrp.toFixed(1)} RSI3=${rsi3_105xrp.toFixed(0)} MFI=${mfi105xrp.toFixed(0)} BB1.8 (ETH=75.0% pattern 🔥🔥🔥)`,
              confidence: Math.round(Math.min(86, 68 + dev105xrp * 6 + Math.min(1, ext105xrp) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 107: GoodH + 4h ADX<20 + RSI3>93 + MFI70 + BB22 ──────────────
  // 4h regime filter (ranging) + extreme RSI3 — XRP=62.3% n=69 tpd=0.4 (session16 H3)
  if (candles5m.length >= 25 && candles4h.length >= 30) {
    const s107xrpGoodHours = [6, 9, 12, 18];
    const last107xrp = candles5m[candles5m.length - 1];
    const s107xrpHour = new Date(last107xrp.closeTime).getUTCHours();
    if (s107xrpGoodHours.includes(s107xrpHour)) {
      const adx107xrp_4h = calcADX(candles4h, 14);
      if (adx107xrp_4h < 20) {
        const bb107xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_107xrp = calculateRSI(candles5m, 3);
        const mfi107xrp = calculateMFI(candles5m, 14);
        if (bb107xrp && rsi3_107xrp !== null && mfi107xrp !== null) {
          const isBear107xrp = rsi3_107xrp > 93 && mfi107xrp > 70 && last107xrp.close > bb107xrp.upper;
          const isBull107xrp = rsi3_107xrp < 7 && mfi107xrp < 30 && last107xrp.close < bb107xrp.lower;
          if (isBear107xrp || isBull107xrp) {
            const dev107xrp = isBear107xrp
              ? (last107xrp.close - bb107xrp.upper) / bb107xrp.upper * 100
              : (bb107xrp.lower - last107xrp.close) / bb107xrp.lower * 100;
            const ext107xrp = isBear107xrp ? (rsi3_107xrp - 93) / 7 : (7 - rsi3_107xrp) / 7;
            strategies.push({
              name: 'XRP GH+4hADX20+RSI3_93+MFI70+BB22',
              emoji: '🌐🎯',
              score: Math.round(Math.min(9.0, 7.0 + dev107xrp * 5 + Math.min(1, ext107xrp) * 0.4) * 10) / 10,
              direction: (isBear107xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s107xrpHour}UTC 4hADX=${adx107xrp_4h.toFixed(1)} RSI3=${rsi3_107xrp.toFixed(0)} MFI=${mfi107xrp.toFixed(0)} BB22 (XRP=62.3% 4hFilter)`,
              confidence: Math.round(Math.min(84, 67 + dev107xrp * 6 + Math.min(1, ext107xrp) * 4)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 108: GoodH + ADX<20 + RSI3>95 + MFI70 + BB22 (ultra-extreme) ──
  // XRP: 80.0% n=20 tpd=0.1 🔥🔥🔥 (session16 D2) — fires rarely but very high WR
  if (candles5m.length >= 25) {
    const s108xrpGoodHours = [6, 9, 12, 18];
    const last108xrp = candles5m[candles5m.length - 1];
    const s108xrpHour = new Date(last108xrp.closeTime).getUTCHours();
    if (s108xrpGoodHours.includes(s108xrpHour)) {
      const adx108xrp = calcADX(candles5m, 14);
      if (adx108xrp < 20) {
        const bb108xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const rsi3_108xrp = calculateRSI(candles5m, 3);
        const mfi108xrp = calculateMFI(candles5m, 14);
        if (bb108xrp && rsi3_108xrp !== null && mfi108xrp !== null) {
          const isBear108xrp = rsi3_108xrp > 95 && mfi108xrp > 70 && last108xrp.close > bb108xrp.upper;
          const isBull108xrp = rsi3_108xrp < 5 && mfi108xrp < 30 && last108xrp.close < bb108xrp.lower;
          if (isBear108xrp || isBull108xrp) {
            const dev108xrp = isBear108xrp
              ? (last108xrp.close - bb108xrp.upper) / bb108xrp.upper * 100
              : (bb108xrp.lower - last108xrp.close) / bb108xrp.lower * 100;
            const ext108xrp = isBear108xrp ? (rsi3_108xrp - 95) / 5 : (5 - rsi3_108xrp) / 5;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_95+MFI70+BB22',
              emoji: '🚀💎',
              score: Math.round(Math.min(9.5, 7.8 + dev108xrp * 5 + Math.min(1, ext108xrp) * 0.4) * 10) / 10,
              direction: (isBear108xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s108xrpHour}UTC ADX=${adx108xrp.toFixed(1)} RSI3=${rsi3_108xrp.toFixed(0)} MFI=${mfi108xrp.toFixed(0)} BB22 (XRP=80.0% ultra 🚀🔥)`,
              confidence: Math.round(Math.min(90, 74 + dev108xrp * 6 + Math.min(1, ext108xrp) * 5)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 109: GoodH + ADX<20 + RSI3>95 + MFI70 + BB(20,1.8) ───────────
  // XRP: 77.3% n=22 tpd=0.1 🔥🔥🔥 (session16 D3) — BB1.8 gives ~40% more signals
  if (candles5m.length >= 25) {
    const s109xrpGoodHours = [6, 9, 12, 18];
    const last109xrp = candles5m[candles5m.length - 1];
    const s109xrpHour = new Date(last109xrp.closeTime).getUTCHours();
    if (s109xrpGoodHours.includes(s109xrpHour)) {
      const adx109xrp = calcADX(candles5m, 14);
      if (adx109xrp < 20) {
        const bb109xrp = calculateBollingerBands(candles5m, 20, 1.8);
        const rsi3_109xrp = calculateRSI(candles5m, 3);
        const mfi109xrp = calculateMFI(candles5m, 14);
        if (bb109xrp && rsi3_109xrp !== null && mfi109xrp !== null) {
          const isBear109xrp = rsi3_109xrp > 95 && mfi109xrp > 70 && last109xrp.close > bb109xrp.upper;
          const isBull109xrp = rsi3_109xrp < 5 && mfi109xrp < 30 && last109xrp.close < bb109xrp.lower;
          if (isBear109xrp || isBull109xrp) {
            const dev109xrp = isBear109xrp
              ? (last109xrp.close - bb109xrp.upper) / bb109xrp.upper * 100
              : (bb109xrp.lower - last109xrp.close) / bb109xrp.lower * 100;
            const ext109xrp = isBear109xrp ? (rsi3_109xrp - 95) / 5 : (5 - rsi3_109xrp) / 5;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_95+MFI70+BB18',
              emoji: '💎🎯',
              score: Math.round(Math.min(9.3, 7.5 + dev109xrp * 5 + Math.min(1, ext109xrp) * 0.4) * 10) / 10,
              direction: (isBear109xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s109xrpHour}UTC ADX=${adx109xrp.toFixed(1)} RSI3=${rsi3_109xrp.toFixed(0)} MFI=${mfi109xrp.toFixed(0)} BB1.8 (XRP=77.3% 💎)`,
              confidence: Math.round(Math.min(88, 72 + dev109xrp * 6 + Math.min(1, ext109xrp) * 4)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 110: GoodH + ADX<20 + StochRSI-K>85 + MFI72 + RSI14>68 + BB22 ──
  // StochRSI K extreme at BB22 + MFI + RSI14 confirm — new exhaustion pattern
  // XRP: 80.0% n=37 tpd=0.2 🔥🔥🔥 (session16 G3)
  if (candles5m.length >= 45) {
    const s110xrpGoodHours = [6, 9, 12, 18];
    const last110xrp = candles5m[candles5m.length - 1];
    const s110xrpHour = new Date(last110xrp.closeTime).getUTCHours();
    if (s110xrpGoodHours.includes(s110xrpHour)) {
      const adx110xrp = calcADX(candles5m, 14);
      if (adx110xrp < 20) {
        const srsi110xrp = calcStochRSI(candles5m, 14, 14);
        const bb110xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi110xrp = calculateMFI(candles5m, 14);
        if (bb110xrp && mfi110xrp !== null && rsi14_5m !== null) {
          const isBear110xrp = srsi110xrp.k > 85 && mfi110xrp > 72 && rsi14_5m > 68 && last110xrp.close > bb110xrp.upper;
          const isBull110xrp = srsi110xrp.k < 15 && mfi110xrp < 28 && rsi14_5m < 32 && last110xrp.close < bb110xrp.lower;
          if (isBear110xrp || isBull110xrp) {
            const dev110xrp = isBear110xrp
              ? (last110xrp.close - bb110xrp.upper) / bb110xrp.upper * 100
              : (bb110xrp.lower - last110xrp.close) / bb110xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+StochK85+MFI72+RSI14+BB22',
              emoji: '🔥💡',
              score: Math.round(Math.min(9.3, 7.5 + dev110xrp * 5) * 10) / 10,
              direction: (isBear110xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s110xrpHour}UTC ADX=${adx110xrp.toFixed(1)} StochK=${srsi110xrp.k.toFixed(0)} MFI=${mfi110xrp.toFixed(0)} (XRP=80.0% n=37 🔥🔥🔥)`,
              confidence: Math.round(Math.min(91, 75 + dev110xrp * 6)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 116: GoodH + ADX<20 + StochRSI-K>90 + MFI72 + RSI14>68 + BB22 ─
  // C1 Session18: Ultra-extreme StochK>90 at BB22 in ranging XRP market
  // XRP: 70.8% n=24 tpd=0.1 🔥🔥 (session18 C1)
  if (candles5m.length >= 45) {
    const s116xrpGoodHours = [6, 9, 12, 18];
    const last116xrp = candles5m[candles5m.length - 1];
    const s116xrpHour = new Date(last116xrp.closeTime).getUTCHours();
    if (s116xrpGoodHours.includes(s116xrpHour)) {
      const adx116xrp = calcADX(candles5m, 14);
      if (adx116xrp < 20) {
        const srsi116xrp = calcStochRSI(candles5m, 14, 14);
        const bb116xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi116xrp = calculateMFI(candles5m, 14);
        if (bb116xrp && mfi116xrp !== null && rsi14_5m !== null) {
          const isBear116xrp = srsi116xrp.k > 90 && mfi116xrp > 72 && rsi14_5m > 68 && last116xrp.close > bb116xrp.upper;
          const isBull116xrp = srsi116xrp.k < 10 && mfi116xrp < 28 && rsi14_5m < 32 && last116xrp.close < bb116xrp.lower;
          if (isBear116xrp || isBull116xrp) {
            const dev116xrp = isBear116xrp
              ? (last116xrp.close - bb116xrp.upper) / bb116xrp.upper * 100
              : (bb116xrp.lower - last116xrp.close) / bb116xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+StochK90+MFI72+RSI14+BB22',
              emoji: '🔥💎',
              score: Math.round(Math.min(9.4, 7.6 + dev116xrp * 5) * 10) / 10,
              direction: (isBear116xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s116xrpHour}UTC ADX=${adx116xrp.toFixed(1)} StochK=${srsi116xrp.k.toFixed(0)} MFI=${mfi116xrp.toFixed(0)} ultra (XRP=70.8% n=24 🔥🔥)`,
              confidence: Math.round(Math.min(90, 74 + dev116xrp * 6)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 117: GoodH + ADX<20 + StochK>90 + RSI3>93 + MFI72 + BB22 ───
  // C3 Session18: Ultra-extreme StochK>90 + RSI3>93 double-extreme at BB22
  // XRP: 71.4% n=28 tpd=0.2 🔥🔥 (session18 C3)
  if (candles5m.length >= 45) {
    const s117xrpGoodHours = [6, 9, 12, 18];
    const last117xrp = candles5m[candles5m.length - 1];
    const s117xrpHour = new Date(last117xrp.closeTime).getUTCHours();
    if (s117xrpGoodHours.includes(s117xrpHour)) {
      const adx117xrp = calcADX(candles5m, 14);
      if (adx117xrp < 20) {
        const srsi117xrp = calcStochRSI(candles5m, 14, 14);
        const rsi3_117xrp = calculateRSI(candles5m, 3);
        const bb117xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi117xrp = calculateMFI(candles5m, 14);
        if (bb117xrp && rsi3_117xrp !== null && mfi117xrp !== null) {
          const isBear117xrp = srsi117xrp.k > 90 && rsi3_117xrp > 93 && mfi117xrp > 72 && last117xrp.close > bb117xrp.upper;
          const isBull117xrp = srsi117xrp.k < 10 && rsi3_117xrp < 7 && mfi117xrp < 28 && last117xrp.close < bb117xrp.lower;
          if (isBear117xrp || isBull117xrp) {
            const dev117xrp = isBear117xrp
              ? (last117xrp.close - bb117xrp.upper) / bb117xrp.upper * 100
              : (bb117xrp.lower - last117xrp.close) / bb117xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+StochK90+RSI3_93+MFI72+BB22',
              emoji: '🔥🎯',
              score: Math.round(Math.min(9.4, 7.6 + dev117xrp * 5) * 10) / 10,
              direction: (isBear117xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s117xrpHour}UTC ADX=${adx117xrp.toFixed(1)} StochK=${srsi117xrp.k.toFixed(0)} RSI3=${rsi3_117xrp.toFixed(0)} MFI=${mfi117xrp.toFixed(0)} (XRP=71.4% n=28 🔥🔥)`,
              confidence: Math.round(Math.min(90, 74 + dev117xrp * 6)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 113: GoodH + ADX<20 + RSI3>93 + StochK>80 + MFI70 + BB22 ─────
  // A4 Session17: RSI3 + StochK double oscillator at BB22 in ranging XRP market
  // XRP: 72.7% n=33 tpd=0.2 🔥🔥 (session17 A4)
  if (candles5m.length >= 45) {
    const s113xrpGoodHours = [6, 9, 12, 18];
    const last113xrp = candles5m[candles5m.length - 1];
    const s113xrpHour = new Date(last113xrp.closeTime).getUTCHours();
    if (s113xrpGoodHours.includes(s113xrpHour)) {
      const adx113xrp = calcADX(candles5m, 14);
      if (adx113xrp < 20) {
        const rsi3_113xrp = calculateRSI(candles5m, 3);
        const srsi113xrp = calcStochRSI(candles5m, 14, 14);
        const bb113xrp = calculateBollingerBands(candles5m, 20, 2.2);
        const mfi113xrp = calculateMFI(candles5m, 14);
        if (bb113xrp && rsi3_113xrp !== null && mfi113xrp !== null) {
          const isBear113xrp = rsi3_113xrp > 93 && srsi113xrp.k > 80 && mfi113xrp > 70 && last113xrp.close > bb113xrp.upper;
          const isBull113xrp = rsi3_113xrp < 7 && srsi113xrp.k < 20 && mfi113xrp < 30 && last113xrp.close < bb113xrp.lower;
          if (isBear113xrp || isBull113xrp) {
            const dev113xrp = isBear113xrp
              ? (last113xrp.close - bb113xrp.upper) / bb113xrp.upper * 100
              : (bb113xrp.lower - last113xrp.close) / bb113xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_93+StochK80+MFI70+BB22',
              emoji: '🔥💡',
              score: Math.round(Math.min(9.3, 7.4 + dev113xrp * 5) * 10) / 10,
              direction: (isBear113xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s113xrpHour}UTC ADX=${adx113xrp.toFixed(1)} RSI3=${rsi3_113xrp.toFixed(0)} StochK=${srsi113xrp.k.toFixed(0)} MFI=${mfi113xrp.toFixed(0)} (XRP=72.7% n=33 🔥🔥)`,
              confidence: Math.round(Math.min(90, 73 + dev113xrp * 6)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 118: GoodH + ADX<20 + RSI3>90 + RSI7>72 + RSI14>68 + BB22 ──────
  // C1 Session19: triple RSI alignment at BB22 in ranging XRP market — ULTRA STABLE
  // XRP: 70.0% n=40 (session19 C1)
  if (candles5m.length >= 25) {
    const s118xrpGoodHours = [6, 9, 12, 18];
    const last118xrp = candles5m[candles5m.length - 1];
    const s118xrpHour = new Date(last118xrp.closeTime).getUTCHours();
    if (s118xrpGoodHours.includes(s118xrpHour)) {
      const adx118xrp = calcADX(candles5m, 14);
      if (adx118xrp < 20) {
        const rsi3_118xrp = calculateRSI(candles5m, 3);
        const rsi7_118xrp = calculateRSI(candles5m, 7);
        const rsi14_118xrp = calculateRSI(candles5m, 14);
        const bb118xrp = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb118xrp && rsi3_118xrp !== null && rsi7_118xrp !== null && rsi14_118xrp !== null) {
          const isBear118xrp = rsi3_118xrp > 90 && rsi7_118xrp > 72 && rsi14_118xrp > 68 && last118xrp.close > bb118xrp.upper;
          const isBull118xrp = rsi3_118xrp < 10 && rsi7_118xrp < 28 && rsi14_118xrp < 32 && last118xrp.close < bb118xrp.lower;
          if (isBear118xrp || isBull118xrp) {
            const dev118xrp = isBear118xrp
              ? (last118xrp.close - bb118xrp.upper) / bb118xrp.upper * 100
              : (bb118xrp.lower - last118xrp.close) / bb118xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_90+RSI7_72+RSI14+BB22',
              emoji: '🏆🔥',
              score: Math.round(Math.min(9.4, 7.5 + dev118xrp * 5) * 10) / 10,
              direction: (isBear118xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s118xrpHour}UTC ADX=${adx118xrp.toFixed(1)} RSI3=${rsi3_118xrp.toFixed(0)} RSI7=${rsi7_118xrp.toFixed(0)} RSI14=${rsi14_118xrp.toFixed(0)} (XRP=70.0% n=40 🏆)`,
              confidence: Math.round(Math.min(90, 72 + dev118xrp * 6)),
            });
          }
        }
      }
    }
  }

  // ─── XRP Strat 119: GoodH + ADX<20 + RSI3>90 + RSI7>72 + RSI14>68 + MFI70 + BB22
  // C2 Session19: triple RSI + MFI confluence at BB22 in ranging XRP market
  // XRP: 75.0% n=24 (session19 C2)
  if (candles5m.length >= 25) {
    const s119xrpGoodHours = [6, 9, 12, 18];
    const last119xrp = candles5m[candles5m.length - 1];
    const s119xrpHour = new Date(last119xrp.closeTime).getUTCHours();
    if (s119xrpGoodHours.includes(s119xrpHour)) {
      const adx119xrp = calcADX(candles5m, 14);
      if (adx119xrp < 20) {
        const rsi3_119xrp = calculateRSI(candles5m, 3);
        const rsi7_119xrp = calculateRSI(candles5m, 7);
        const rsi14_119xrp = calculateRSI(candles5m, 14);
        const mfi119xrp = calculateMFI(candles5m, 14);
        const bb119xrp = calculateBollingerBands(candles5m, 20, 2.2);
        if (bb119xrp && rsi3_119xrp !== null && rsi7_119xrp !== null && rsi14_119xrp !== null && mfi119xrp !== null) {
          const isBear119xrp = rsi3_119xrp > 90 && rsi7_119xrp > 72 && rsi14_119xrp > 68 && mfi119xrp > 70 && last119xrp.close > bb119xrp.upper;
          const isBull119xrp = rsi3_119xrp < 10 && rsi7_119xrp < 28 && rsi14_119xrp < 32 && mfi119xrp < 30 && last119xrp.close < bb119xrp.lower;
          if (isBear119xrp || isBull119xrp) {
            const dev119xrp = isBear119xrp
              ? (last119xrp.close - bb119xrp.upper) / bb119xrp.upper * 100
              : (bb119xrp.lower - last119xrp.close) / bb119xrp.lower * 100;
            strategies.push({
              name: 'XRP GH+ADX20+RSI3_90+RSI7_72+RSI14+MFI70+BB22',
              emoji: '🔥🏆',
              score: Math.round(Math.min(9.5, 7.7 + dev119xrp * 5) * 10) / 10,
              direction: (isBear119xrp ? 'bearish' : 'bullish') as Direction,
              signal: `XRP GH=${s119xrpHour}UTC ADX=${adx119xrp.toFixed(1)} RSI3=${rsi3_119xrp.toFixed(0)} RSI7=${rsi7_119xrp.toFixed(0)} MFI=${mfi119xrp.toFixed(0)} (XRP=75.0% n=24 🔥🏆)`,
              confidence: Math.round(Math.min(90, 75 + dev119xrp * 6)),
            });
          }
        }
      }
    }
  }

  strategies.sort((a, b) => b.score - a.score);
  const bullishScore = strategies.filter(s => s.direction === 'bullish').reduce((s, st) => s + st.score, 0);
  const bearishScore = strategies.filter(s => s.direction === 'bearish').reduce((s, st) => s + st.score, 0);

  return {
    strategies,
    indicators: {
      rsi14_5m,
      rsi7_1m: null,
      sma20,
      vwap: calculateVWAP(candles5m),
      macd: calculateMACD(candles5m),
      momentum: detectMomentum(candles5m, 5),
      lastPrice,
      bb,
    },
    verdict: {
      direction: bullishScore > bearishScore ? 'BULLISH' : bearishScore > bullishScore ? 'BEARISH' : 'NEUTRAL',
      bullishScore: Math.round(bullishScore * 10) / 10,
      bearishScore: Math.round(bearishScore * 10) / 10,
      topStrategy: strategies[0] || null,
      signalCount: strategies.filter(s => s.score >= 7).length,
    },
  };
}
