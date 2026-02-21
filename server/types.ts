export type Asset = 'BTC' | 'ETH' | 'SOL' | 'XRP';
export type Interval = '5m' | '15m';
export type Direction = 'bullish' | 'bearish' | 'neutral';
export type Verdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
}

export interface BinaryMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  interval: Interval;
  asset: Asset;
  epochEnd: number;           // Unix timestamp (seconds) when market resolves
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;           // 0–1
  noPrice: number;            // 0–1
  volume24h: number;
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  endDate: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  tokenId: string;
}

export interface BinanceOrderBook {
  bids: { price: number; qty: number; total: number }[];
  asks: { price: number; qty: number; total: number }[];
  bidTotal: number;
  askTotal: number;
  ratio: number;
  pressure: Direction;
}

export interface FundingData {
  current: number;
  annualizedPct: number;
  signal: 'overbought' | 'oversold' | 'neutral' | 'unknown';
  strength: 'extreme' | 'elevated' | 'normal' | 'unknown';
  history: { rate: number; time: number }[];
}

export interface BtcData {
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  candles10s: Candle[];
  candles30s: Candle[];
  candles1m: Candle[];
  candles5m: Candle[];
  candles15m: Candle[];
  candles1h: Candle[];
  candles4h: Candle[];
  candles1d: Candle[];
  funding: FundingData;
  orderBook: BinanceOrderBook;
}

export interface StrategySignal {
  name: string;
  emoji: string;
  score: number;              // 0–10
  direction: Direction;
  signal: string;
  confidence: number;         // 0–100
}

export interface Indicators {
  rsi14_5m: number | null;
  rsi7_1m: number | null;
  sma20: number | null;
  vwap: number | null;
  macd: { macd: number; signal: string } | null;
  momentum: {
    direction: Direction;
    strength: number;
    consecutive: number;
    upCandles: number;
    downCandles: number;
  };
  lastPrice: number;
  bb: { upper: number; lower: number; mid: number; pctB: number } | null;
}

export interface StrategyResult {
  strategies: StrategySignal[];
  indicators: Indicators;
  verdict: {
    direction: Verdict;
    bullishScore: number;
    bearishScore: number;
    topStrategy: StrategySignal | null;
    signalCount: number;
  };
}

export interface SSEPayload {
  type: 'markets' | 'btc' | 'signals' | 'book' | 'rtds'
      | 'backtest_job_update' | 'backtest_progress' | 'backtest_candle'
      | 'backtest_trade' | 'backtest_complete';
  data: any;
  timestamp: number;
}
