import { scoreStrategies, calculateRSI } from './indicators';
import type { Candle, FundingData, BinanceOrderBook } from './types';
import type { DbCandle } from './db';

export type SignalMode = 'threshold' | 'crossover' | 'every_candle' | 'combined' | 'mtf_reversion' | 'streak_reversion' | 'big_candle' | 'streak_rsi';
export type StrategyName = 'momentum_burst' | 'mean_reversion' | 'funding_squeeze' | 'order_book' | 'vwap' | 'all' | 'combined';

export interface BacktestConfig {
  coins: string[];
  timeframes: string[];
  strategies: StrategyName[];
  signalModes: SignalMode[];
  thresholdMin: number;
  initialCapital: number;
  fromMs: number;
  toMs: number;
  // Optional MTF context — required for 'mtf_reversion' signal mode
  mtfCandles?: {
    candles1h: DbCandle[];
    candles4h: DbCandle[];
  };
}

export interface Trade {
  time: number;
  coin: string;
  timeframe: string;
  strategy: string;
  signalMode: SignalMode;
  direction: 'BULL' | 'BEAR';
  result: 'WIN' | 'LOSS';
  pnl: number;
  equity: number;
  rawFeatures: {
    rsi14?: number | null;
    rsi7?: number | null;
    vwap?: number | null;
    macdVal?: number | null;
    momentumStrength?: number;
    bullishScore: number;
    bearishScore: number;
  };
}

export interface StrategyMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  sharpe: number;
  profitFactor: number;
  equityCurve: { time: number; equity: number }[];
}

export interface BacktestResult {
  config: BacktestConfig;
  summary: StrategyMetrics;
  byStrategy: Record<string, StrategyMetrics>;
  byCoin: Record<string, StrategyMetrics>;
  byTimeframe: Record<string, StrategyMetrics>;
  byCoinTimeframe: Record<string, StrategyMetrics>;
  trades: Trade[];
  completedAt: number;
}

function toCandle(c: DbCandle): Candle {
  return {
    openTime: c.open_time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    closeTime: c.open_time + 60000,
    quoteVolume: 0,
    trades: 0,
  };
}

const STUB_FUNDING: FundingData = {
  current: 0,
  annualizedPct: 0,
  signal: 'neutral',
  strength: 'normal',
  history: [],
};

const STUB_ORDER_BOOK: BinanceOrderBook = {
  bids: [],
  asks: [],
  bidTotal: 0,
  askTotal: 0,
  ratio: 1,
  pressure: 'neutral',
};

function computeMetrics(trades: Trade[], initialCapital: number): StrategyMetrics {
  if (trades.length === 0) {
    return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, maxDrawdown: 0, sharpe: 0, profitFactor: 0, equityCurve: [] };
  }

  const wins = trades.filter((t) => t.result === 'WIN').length;
  const losses = trades.length - wins;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  const equityCurve: { time: number; equity: number }[] = [{ time: trades[0].time, equity }];

  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));

  for (const trade of trades) {
    equity += trade.pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equityCurve.push({ time: trade.time, equity });
  }

  const returns = trades.map((t) => t.pnl / initialCapital);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const sharpe = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRate: wins / trades.length,
    totalPnl,
    maxDrawdown,
    sharpe: Math.round(sharpe * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? 99 : 0,
    equityCurve,
  };
}

export interface CandleEvent {
  type: 'candle';
  candle: { t: number; o: number; h: number; l: number; c: number; v: number };
  indicators: { rsi?: number | null; vwap?: number | null };
}

export interface TradeEvent {
  type: 'trade';
  trade: Trade;
}

export interface ProgressEvent {
  type: 'progress';
  processed: number;
  total: number;
  percent: number;
}

export type BacktestEvent = CandleEvent | TradeEvent | ProgressEvent;

export function runBacktestForPair(
  dbCandles: DbCandle[],
  coin: string,
  timeframe: string,
  config: BacktestConfig,
  onEvent?: (e: BacktestEvent) => void,
): Trade[] {
  const candles = dbCandles.map(toCandle);
  const total = candles.length;
  const trades: Trade[] = [];
  const betSize = config.initialCapital / 100;
  let equity = config.initialCapital;

  const WARMUP = 26;
  let prevVerdict: string | null = null;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    if (i % 100 === 0) {
      onEvent?.({ type: 'progress', processed: i, total, percent: Math.round((i / total) * 100) });
    }

    if (i % 50 === 0) {
      const c = candles[i];
      onEvent?.({
        type: 'candle',
        candle: { t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume },
        indicators: {},
      });
    }

    const slice5m = candles.slice(Math.max(0, i - 99), i + 1);
    const slice1m = candles.slice(Math.max(0, i - 19), i + 1);

    const result = scoreStrategies(slice5m, slice1m, STUB_FUNDING, STUB_ORDER_BOOK);
    const { verdict, indicators } = result;

    const bullishScore = verdict.bullishScore;
    const bearishScore = verdict.bearishScore;
    const direction = verdict.direction;

    const nextCandle = candles[i + 1];
    const actualUp = nextCandle.close > nextCandle.open;

    const rawFeatures = {
      rsi14: indicators.rsi14_5m,
      rsi7: indicators.rsi7_1m,
      vwap: indicators.vwap,
      macdVal: indicators.macd?.macd ?? null,
      momentumStrength: indicators.momentum.strength,
      bullishScore,
      bearishScore,
    };

    for (const mode of config.signalModes) {
      let shouldTrade = false;
      let tradingDirection: 'BULL' | 'BEAR' | null = null;

      if (mode === 'every_candle') {
        shouldTrade = direction !== 'NEUTRAL';
        tradingDirection = direction === 'BULLISH' ? 'BULL' : direction === 'BEARISH' ? 'BEAR' : null;
      } else if (mode === 'threshold') {
        if (bullishScore >= config.thresholdMin) { shouldTrade = true; tradingDirection = 'BULL'; }
        else if (bearishScore >= config.thresholdMin) { shouldTrade = true; tradingDirection = 'BEAR'; }
      } else if (mode === 'crossover') {
        const curVerdict = direction;
        if (prevVerdict !== null && prevVerdict !== curVerdict && curVerdict !== 'NEUTRAL') {
          shouldTrade = true;
          tradingDirection = curVerdict === 'BULLISH' ? 'BULL' : 'BEAR';
        }
      } else if (mode === 'combined') {
        const combinedScore = bullishScore - bearishScore;
        if (Math.abs(combinedScore) >= config.thresholdMin) {
          shouldTrade = true;
          tradingDirection = combinedScore > 0 ? 'BULL' : 'BEAR';
        }
      } else if (mode === 'mtf_reversion') {
        // Multi-timeframe mean reversion — best performing strategy (58.82% WR on test)
        // When higher TF trending up + 5m overbought → bet BEAR (and vice versa)
        const rsi5m = indicators.rsi14_5m ?? 50;
        const mtf = config.mtfCandles;
        if (mtf) {
          const t = candles[i].openTime;
          const cur1hStart = t - (t % 3600000);
          const cur4hStart = t - (t % 14400000);
          const hist1h = mtf.candles1h.filter(c => c.open_time < cur1hStart).slice(-30).map(toCandle);
          const hist4h = mtf.candles4h.filter(c => c.open_time < cur4hStart).slice(-20).map(toCandle);
          const rsi1h = hist1h.length >= 14 ? (calculateRSI(hist1h, 14) ?? 50) : 50;
          const rsi4h = hist4h.length >= 14 ? (calculateRSI(hist4h, 14) ?? 50) : 50;
          const avgHTFRsi = (rsi1h + rsi4h) / 2;
          const htfBull = avgHTFRsi > 55;
          const htfBear = avgHTFRsi < 45;
          const rsiThresh = config.thresholdMin > 0 ? config.thresholdMin : 70;
          if (htfBull && rsi5m >= rsiThresh) { shouldTrade = true; tradingDirection = 'BEAR'; }
          else if (htfBear && rsi5m <= (100 - rsiThresh)) { shouldTrade = true; tradingDirection = 'BULL'; }
        }
      } else if (mode === 'streak_reversion') {
        // Bet against streak of 3+ consecutive same-direction candles
        const streakLen = config.thresholdMin > 0 ? Math.floor(config.thresholdMin) : 3;
        let greenStreak = 0, redStreak = 0;
        for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
          const cj = candles[j];
          if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
          else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
          else break;
        }
        if (greenStreak >= streakLen) { shouldTrade = true; tradingDirection = 'BEAR'; }
        else if (redStreak >= streakLen) { shouldTrade = true; tradingDirection = 'BULL'; }
      } else if (mode === 'big_candle') {
        // Bet against large candle body — mean reversion (6-9% edge)
        const minChangePct = config.thresholdMin > 0 ? config.thresholdMin : 0.5;
        const c = candles[i];
        const candleChangePct = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
        if (candleChangePct >= minChangePct) { shouldTrade = true; tradingDirection = 'BEAR'; }
        else if (candleChangePct <= -minChangePct) { shouldTrade = true; tradingDirection = 'BULL'; }
      } else if (mode === 'streak_rsi') {
        // Streak reversion + RSI confirmation — best WR config (65%+ on 15m)
        // thresholdMin = RSI threshold (default 55), streak length fixed at 3
        // Only enter BEAR after 3 green candles IF RSI > threshold (overbought confirmation)
        const rsiThresh = config.thresholdMin > 0 ? config.thresholdMin : 55;
        const streakLen = 3;
        let greenStreak = 0, redStreak = 0;
        for (let j = i; j >= Math.max(0, i - (streakLen + 2)); j--) {
          const cj = candles[j];
          if (cj.close > cj.open) { if (redStreak > 0) break; greenStreak++; }
          else if (cj.close < cj.open) { if (greenStreak > 0) break; redStreak++; }
          else break;
        }
        const rsiSlice = candles.slice(Math.max(0, i - 15), i + 1);
        const rsi5m = calculateRSI(rsiSlice, 14) ?? 50;
        if (greenStreak >= streakLen && rsi5m >= rsiThresh) { shouldTrade = true; tradingDirection = 'BEAR'; }
        else if (redStreak >= streakLen && rsi5m <= (100 - rsiThresh)) { shouldTrade = true; tradingDirection = 'BULL'; }
      }

      if (!shouldTrade || !tradingDirection) continue;

      const predictedUp = tradingDirection === 'BULL';
      const win = predictedUp === actualUp;
      const pnl = win ? betSize : -betSize;
      equity += pnl;

      const trade: Trade = {
        time: candles[i].openTime,
        coin,
        timeframe,
        strategy: config.strategies.includes('all') ? 'all' : config.strategies[0],
        signalMode: mode,
        direction: tradingDirection,
        result: win ? 'WIN' : 'LOSS',
        pnl,
        equity,
        rawFeatures,
      };

      trades.push(trade);
      onEvent?.({ type: 'trade', trade });
    }

    prevVerdict = direction;
  }

  return trades;
}

export function aggregateResults(
  allTrades: Trade[],
  config: BacktestConfig,
): BacktestResult {
  const summary = computeMetrics(allTrades, config.initialCapital);

  const byStrategy: Record<string, StrategyMetrics> = {};
  const strategies = [...new Set(allTrades.map((t) => t.strategy))];
  for (const s of strategies) {
    byStrategy[s] = computeMetrics(allTrades.filter((t) => t.strategy === s), config.initialCapital);
  }

  const byCoin: Record<string, StrategyMetrics> = {};
  for (const coin of config.coins) {
    byCoin[coin] = computeMetrics(allTrades.filter((t) => t.coin === coin), config.initialCapital);
  }

  const byTimeframe: Record<string, StrategyMetrics> = {};
  for (const tf of config.timeframes) {
    byTimeframe[tf] = computeMetrics(allTrades.filter((t) => t.timeframe === tf), config.initialCapital);
  }

  const byCoinTimeframe: Record<string, StrategyMetrics> = {};
  for (const coin of config.coins) {
    for (const tf of config.timeframes) {
      const key = `${coin}_${tf}`;
      byCoinTimeframe[key] = computeMetrics(
        allTrades.filter((t) => t.coin === coin && t.timeframe === tf),
        config.initialCapital,
      );
    }
  }

  return {
    config,
    summary,
    byStrategy,
    byCoin,
    byTimeframe,
    byCoinTimeframe,
    trades: allTrades,
    completedAt: Date.now(),
  };
}
