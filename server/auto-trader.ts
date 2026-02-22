import { getBinanceCandles } from './prices';
import { scoreStrategies, scoreSolStrategies, scoreXrpStrategies } from './indicators';
import { openTrade, getOpenPositions, PaperTrade } from './paper-trading';
import { getStrategyConfig, computeTradeSize, getMinConfidence } from './strategy-config';
import type { Candle, BinaryMarket, StrategyResult, FundingData, BinanceOrderBook } from './types';

// ─────────────────── Constants ───────────────────

const SCORE_THRESHOLD = 6;

const TOP_STRATEGIES = [
  { strategyId: 18, nameSubstr: 'RSI Panic',      coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 15, nameSubstr: 'Good Hours',      coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 16, nameSubstr: 'Synth15m',        coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 17, nameSubstr: 'Daily Range',     coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 13, nameSubstr: 'Balanced BB',     coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 14, nameSubstr: 'Recovery Rally',  coins: ['ETH', 'BTC'], interval: '15m' as const },
  { strategyId: 12, nameSubstr: 'MFI',             coins: ['BTC'],         interval: '15m' as const },
  { strategyId: 10, nameSubstr: 'Keltner',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 9,  nameSubstr: 'Markov',          coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 19, nameSubstr: 'SOL Good Hours',       coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 20, nameSubstr: 'XRP Good Hours',       coins: ['XRP'],  interval: '5m' as const },
  // New ETH strategies (21-25) — Session 4 ML-optimized
  { strategyId: 21, nameSubstr: 'DoW Reversion',        coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 22, nameSubstr: 'EMA50 Extension',      coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 23, nameSubstr: 'RSI Bidir Exhaustion', coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 24, nameSubstr: 'ETH 15m MFI',          coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 25, nameSubstr: 'RSI Bear Streak',      coins: ['ETH'],  interval: '5m' as const },
  // New SOL strategies (26-30) — Session 4 ML-optimized
  { strategyId: 26, nameSubstr: 'SOL DoW Reversion',    coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 27, nameSubstr: 'SOL Pattern Exhaustion', coins: ['SOL'], interval: '5m' as const },
  { strategyId: 28, nameSubstr: 'SOL Tight BB',         coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 29, nameSubstr: 'SOL Panic Body',       coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 30, nameSubstr: 'SOL EMA Extension',    coins: ['SOL'],  interval: '5m' as const },
  // New ETH strategies (31-32, 35) — Session 5 (best ever WR)
  { strategyId: 31, nameSubstr: 'ETH Synth-15m RSI Panic', coins: ['ETH'], interval: '5m' as const },
  { strategyId: 32, nameSubstr: 'ETH 15m Discovery',    coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 35, nameSubstr: 'ETH Tight BB Zone',    coins: ['ETH'],  interval: '5m' as const },
  // New SOL strategies (33-34) — Session 5 (ultra stable)
  { strategyId: 33, nameSubstr: 'SOL Daily Range Extreme', coins: ['SOL'], interval: '5m' as const },
  { strategyId: 34, nameSubstr: 'SOL Low-ATR BB',       coins: ['SOL'],  interval: '5m' as const },
  // New ETH/15m strategies (36-38) — Session 6 Wave 3 (ultra stable 73-78% WR)
  { strategyId: 36, nameSubstr: 'ETH 15m Body RSI7',    coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 37, nameSubstr: 'ETH 15m MFI Confirm',  coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 38, nameSubstr: 'ETH 15m ATR Panic',    coins: ['ETH'],  interval: '5m' as const },
  // New XRP strategies (39-40) — Session 6 validated (near-perfect stability)
  { strategyId: 39, nameSubstr: 'XRP MFI75 Exhaustion', coins: ['XRP'],  interval: '5m' as const },
  { strategyId: 40, nameSubstr: 'XRP BB15 Reversion',   coins: ['XRP'],  interval: '5m' as const },
  // Strategy 41: Saturday BB — BTC WF=69.1%, also valid for ETH Saturday
  { strategyId: 41, nameSubstr: 'Saturday BB Reversion', coins: ['BTC', 'ETH'], interval: '5m' as const },
  // Strategy 42: SOL RSI Streak BB — ULTRA STABLE WF=67.1% σ=2.9% (paramOptimize)
  { strategyId: 42, nameSubstr: 'SOL RSI Streak BB',     coins: ['SOL'],         interval: '5m' as const },
  // BTC 5m strategies (43-46) — BTC h=[1,12,13,16,20] is strongly mean-reverting above BB
  { strategyId: 43, nameSubstr: 'BTC MFI BB',            coins: ['BTC'],         interval: '5m' as const },
  { strategyId: 44, nameSubstr: 'BTC RSI BB',            coins: ['BTC'],         interval: '5m' as const },
  { strategyId: 45, nameSubstr: 'BTC GH BB Streak',      coins: ['BTC'],         interval: '5m' as const },
  { strategyId: 46, nameSubstr: 'BTC RSI70 BB',          coins: ['BTC'],         interval: '5m' as const },
  // All-Hours High-Frequency strategies (56-58) — no hour filter, 2-5 trades/day, 75-76% WR
  { strategyId: 56, nameSubstr: 'ALL-H RSI Panic BB',    coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 57, nameSubstr: 'ALL-H MFI80 BB',        coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 58, nameSubstr: 'ALL-H MFI85 BB',        coins: ['ETH', 'BTC'], interval: '5m' as const },
  // SOL All-Hours HF (59-60) — 4.8-7.2 trades/day, 73% WR ULTRA STABLE
  { strategyId: 59, nameSubstr: 'SOL ALL-H RSI Panic',   coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 60, nameSubstr: 'SOL ALL-H RSI7 Panic',  coins: ['SOL'],        interval: '5m' as const },
  // BTC Synth-15m (61-62) — HIGHEST WR 86.3%
  { strategyId: 61, nameSubstr: 'BTC Synth15m GH RSI',   coins: ['BTC'],        interval: '5m' as const },
  { strategyId: 62, nameSubstr: 'BTC Synth15m ALL-H RSI',coins: ['BTC'],        interval: '5m' as const },
  // Enhanced all-hours (64-65) — ULTRA STABLE σ<3%
  { strategyId: 64, nameSubstr: 'ALL-H Dual RSI+MFI BB', coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 65, nameSubstr: 'ALL-H RSI Dev Filter BB', coins: ['ETH', 'BTC'], interval: '5m' as const },
  // BTC GoodH body filter (66) — WF=79.2% σ=2.6% ULTRA STABLE
  { strategyId: 66, nameSubstr: 'BTC GH Body RSI BB',    coins: ['BTC'],        interval: '5m' as const },
  // Ultra High-Frequency Testing Strategy (67) — BB(20,1.8) 40+/day
  { strategyId: 67, nameSubstr: 'ALL-H BB18 HF',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 67, nameSubstr: 'SOL ALL-H BB18 HF',     coins: ['SOL'],        interval: '5m' as const },
];

const DEFAULT_FUNDING: FundingData = {
  current: 0, annualizedPct: 0, signal: 'neutral', strength: 'normal', history: [],
};

const DEFAULT_ORDERBOOK: BinanceOrderBook = {
  bids: [], asks: [], bidTotal: 0, askTotal: 0, ratio: 1, pressure: 'neutral',
};

// ─────────────────── ETH Data Fetch ───────────────────

export async function fetchEthData(): Promise<{
  signals: StrategyResult;
  candles5m: Candle[];
  candles15m: Candle[];
}> {
  const [candles5m, candles15m] = await Promise.all([
    getBinanceCandles('ETHUSDT', '5m', 65),
    getBinanceCandles('ETHUSDT', '15m', 50),
  ]);
  const signals = scoreStrategies(candles5m, [], DEFAULT_FUNDING, DEFAULT_ORDERBOOK);
  return { signals, candles5m, candles15m };
}

export async function fetchEthSignals(): Promise<StrategyResult> {
  return (await fetchEthData()).signals;
}

// ─────────────────── SOL Data Fetch ───────────────────

export async function fetchSolData(): Promise<{
  signals: StrategyResult;
  candles5m: Candle[];
}> {
  const candles5m = await getBinanceCandles('SOLUSDT', '5m', 65);
  const signals = scoreSolStrategies(candles5m);
  return { signals, candles5m };
}

export async function fetchSolSignals(): Promise<StrategyResult> {
  return (await fetchSolData()).signals;
}

// ─────────────────── XRP Data Fetch ───────────────────

export async function fetchXrpData(): Promise<{
  signals: StrategyResult;
  candles5m: Candle[];
}> {
  const candles5m = await getBinanceCandles('XRPUSDT', '5m', 80);
  const signals = scoreXrpStrategies(candles5m);
  return { signals, candles5m };
}

export async function fetchXrpSignals(): Promise<StrategyResult> {
  return (await fetchXrpData()).signals;
}

// ─────────────────── Auto Trade Check ───────────────────

export function checkAndAutoTrade(
  coin: string,
  signals: StrategyResult,
  markets: BinaryMarket[],
  currentSpot?: number,
): PaperTrade[] {
  const placed: PaperTrade[] = [];

  // Build dupe set: don't open a second trade for same strategy+coin if one is already open
  const openPositions = getOpenPositions();
  const dupeSet = new Set(openPositions.map(p => `${p.strategy ?? ''}_${p.asset}`));

  for (const strat of TOP_STRATEGIES) {
    if (!strat.coins.includes(coin)) continue;

    // Find signal by name substring match
    const sig = signals.strategies.find(s => s.name.includes(strat.nameSubstr));
    if (!sig) continue;

    // Check if enabled in DB
    const config = getStrategyConfig(strat.strategyId, coin);
    if (!config?.enabled) continue;

    // Signal threshold
    if (sig.direction === 'neutral') continue;
    if (sig.confidence < getMinConfidence()) continue;
    if (sig.score < SCORE_THRESHOLD) continue;

    // No open dupe
    if (dupeSet.has(`${sig.name}_${coin}`)) continue;

    // Find matching Polymarket binary market
    const market = markets.find(
      m => m.asset === coin && m.interval === strat.interval && m.active && !m.closed
    );

    const direction: 'YES' | 'NO' = sig.direction === 'bearish' ? 'NO' : 'YES';
    const entryPrice = market
      ? (direction === 'NO' ? market.noPrice : market.yesPrice)
      : 0.50;
    const marketId = market?.conditionId ?? 'synthetic';
    const marketQ = market?.question ?? `Auto-trade ${coin}/${strat.interval}`;

    try {
      const trade = openTrade({
        market_id: marketId,
        market_q: marketQ,
        asset: coin,
        direction,
        entry_price: entryPrice,
        size: computeTradeSize(),
        strategy: sig.name,
        confidence: sig.confidence,
        reason: `Auto: ${sig.signal}`,
        entry_spot: currentSpot,
        interval_m: strat.interval === '15m' ? 15 : 5,
      });
      placed.push(trade);
      // Add to dupe set so we don't place a second one this cycle
      dupeSet.add(`${sig.name}_${coin}`);
      console.log(`[AutoTrade] ${coin} ${sig.name} → ${direction} @ ${entryPrice.toFixed(3)} (conf=${sig.confidence}%)`);
    } catch (e) {
      console.error('[AutoTrade] openTrade error:', e);
    }
  }

  return placed;
}
