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

  // ─── Ultra High-Frequency Strategy (67) — BB(20,1.8) 40+ trades/day ────────
  // Discovered: highFreqSearch40.js — GAME CHANGER for position testing
  // ETH BB(20,1.8)+s>=1: WF=73.1% σ=0.7% T=7768 (42.2/day!) ULTRA STABLE
  // BTC BB(20,1.8)+s>=1: WF=73.4% σ=0.7% T=7745 (42.1/day!) ULTRA STABLE
  // SOL BB(20,1.8)+s>=1: WF=71.7% σ=0.4% T=7995 (43.5/day!) MOST STABLE EVER
  // Fundamental finding: BB mean-reversion works at ALL band widths (1.0-2.2)
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
        // ETH: 73.1% WR σ=0.7% | BTC: 73.4% σ=0.7% | SOL: 71.7% σ=0.4%
        strategies.push({
          name: 'ALL-H BB18 HF',
          emoji: '⚡🔁',
          score: Math.round(Math.min(10, 5.8 + (Math.abs(streak_hf) - 1) * 0.3 + dev_hf * 9) * 10) / 10,
          direction: (isBear_hf ? 'bearish' : 'bullish') as Direction,
          signal: `ALL-H BB(20,1.8) ${isBear_hf ? 'upper' : 'lower'} streak=${Math.abs(streak_hf)} dev=${dev_hf.toFixed(3)}% (73% WR σ=0.7% 42/day ULTRA STABLE)`,
          confidence: Math.round(Math.min(86, 60 + dev_hf * 12 + (Math.abs(streak_hf) - 1) * 2)),
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
export function scoreSolStrategies(candles5m: Candle[]): StrategyResult {
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
              confidence: Math.round(Math.min(87, 63 + dev_sol_allh * 10 + (Math.abs(streak_sol_allh) - 1) * 2)),
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
              confidence: Math.round(Math.min(87, 63 + dev_sol_allh * 10 + (Math.abs(streak_sol_allh) - 1) * 2)),
            });
          }
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
          score: Math.round(Math.min(10, 5.6 + (Math.abs(streak_sol_hf) - 1) * 0.3 + dev_sol_hf * 9) * 10) / 10,
          direction: (isBear_sol_hf ? 'bearish' : 'bullish') as Direction,
          signal: `SOL ALL-H BB(20,1.8) ${isBear_sol_hf ? 'upper' : 'lower'} streak=${Math.abs(streak_sol_hf)} dev=${dev_sol_hf.toFixed(3)}% (71.7% WR σ=0.4% 43/day MOST STABLE!)`,
          confidence: Math.round(Math.min(84, 58 + dev_sol_hf * 12 + (Math.abs(streak_sol_hf) - 1) * 2)),
        });
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
export function scoreXrpStrategies(candles5m: Candle[]): StrategyResult {
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
