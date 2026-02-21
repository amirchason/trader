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
