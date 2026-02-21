import { create } from 'zustand';

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
  interval: '5m' | '15m';
  asset: 'BTC' | 'ETH' | 'SOL' | 'XRP';
  epochEnd: number;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  endDate: string;
}

export interface StrategySignal {
  name: string;
  emoji: string;
  score: number;
  direction: 'bullish' | 'bearish' | 'neutral';
  signal: string;
  confidence: number;
}

export interface StrategyResult {
  strategies: StrategySignal[];
  indicators: {
    rsi14_5m: number | null;
    rsi7_1m: number | null;
    sma20: number | null;
    vwap: number | null;
    macd: { macd: number; signal: string } | null;
    momentum: {
      direction: string;
      strength: number;
      consecutive: number;
      upCandles: number;
      downCandles: number;
    };
    lastPrice: number;
  };
  verdict: {
    direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    bullishScore: number;
    bearishScore: number;
    topStrategy: StrategySignal | null;
    signalCount: number;
  };
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
  funding: {
    current: number;
    annualizedPct: number;
    signal: string;
    strength: string;
  };
  orderBook: {
    pressure: string;
    ratio: number;
  };
}

// ─── Backtest Types ───
export interface BacktestJobSummary {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  config: {
    coins: string[];
    timeframes: string[];
    signalModes: string[];
  };
  createdAt: number;
  completedAt: number | null;
  summary?: {
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    sharpe: number;
    maxDrawdown: number;
  };
}

export interface PlaybackCandle {
  t: number; o: number; h: number; l: number; c: number; v: number;
  indicators?: { rsi?: number | null; vwap?: number | null };
}

export interface PlaybackTrade {
  time: number; coin: string; timeframe: string;
  direction: 'BULL' | 'BEAR'; result: 'WIN' | 'LOSS'; pnl: number;
}

export interface BacktestDbStatus {
  [symbol: string]: {
    [timeframe: string]: { count: number; earliest: number; latest: number };
  };
}

// ─── Paper Trading Types ───
export interface PaperTrade {
  id: string;
  market_id: string;
  market_q: string;
  asset: string;
  direction: 'YES' | 'NO';
  entry_price: number;
  size: number;
  status: 'OPEN' | 'CLOSED' | 'EXPIRED';
  exit_price: number | null;
  pnl: number | null;
  reason: string | null;
  strategy: string | null;
  confidence: number | null;
  created_at: string;
  closed_at: string | null;
}

export interface PnlSummary {
  totalTrades: number;
  openCount: number;
  closedCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  balance: number;
  equity: number;
  startingBalance: number;
  winRate: number;
  wins: number;
  losses: number;
}

export interface ToastNotification {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  createdAt: number;
}

interface Store {
  markets: BinaryMarket[];
  btcData: BtcData | null;
  signals: StrategyResult | null;
  rtdsPrices: Record<string, number>;
  connected: boolean;
  lastUpdate: number;
  selectedMarket: BinaryMarket | null;

  setMarkets: (markets: BinaryMarket[]) => void;
  setBtcData: (data: BtcData) => void;
  setSignals: (signals: StrategyResult) => void;
  setRtdsPrice: (asset: string, price: number) => void;
  setConnected: (connected: boolean) => void;
  setSelectedMarket: (market: BinaryMarket | null) => void;

  // Paper trading state
  paperPositions: PaperTrade[];
  paperPnl: PnlSummary | null;
  setPaperPositions: (positions: PaperTrade[]) => void;
  setPaperPnl: (pnl: PnlSummary) => void;

  // Backtest state
  backtestJobs: BacktestJobSummary[];
  selectedJobId: string | null;
  dbStatus: BacktestDbStatus;
  downloadRunning: boolean;
  playbackCandles: Record<string, PlaybackCandle[]>;
  playbackTrades: Record<string, PlaybackTrade[]>;
  notifications: ToastNotification[];

  setBacktestJobs: (jobs: BacktestJobSummary[]) => void;
  upsertBacktestJob: (job: BacktestJobSummary) => void;
  updateJobProgress: (jobId: string, progress: number) => void;
  setSelectedJobId: (id: string | null) => void;
  setDbStatus: (status: BacktestDbStatus) => void;
  setDownloadRunning: (v: boolean) => void;
  addPlaybackCandle: (jobId: string, candle: PlaybackCandle) => void;
  addPlaybackTrade: (jobId: string, trade: PlaybackTrade) => void;
  clearPlayback: (jobId: string) => void;
  addNotification: (msg: string, type: 'success' | 'error' | 'info') => void;
  dismissNotification: (id: string) => void;
}

export const useStore = create<Store>((set) => ({
  markets: [],
  btcData: null,
  signals: null,
  rtdsPrices: {},
  connected: false,
  lastUpdate: 0,
  selectedMarket: null,

  setMarkets: (markets) => set({ markets, lastUpdate: Date.now() }),
  setBtcData: (btcData) => set({ btcData }),
  setSignals: (signals) => set({ signals }),
  setRtdsPrice: (asset, price) =>
    set((state) => ({ rtdsPrices: { ...state.rtdsPrices, [asset]: price } })),
  setConnected: (connected) => set({ connected }),
  setSelectedMarket: (selectedMarket) => set({ selectedMarket }),

  // Paper trading initial state
  paperPositions: [],
  paperPnl: null,
  setPaperPositions: (paperPositions) => set({ paperPositions }),
  setPaperPnl: (paperPnl) => set({ paperPnl }),

  // Backtest initial state
  backtestJobs: [],
  selectedJobId: null,
  dbStatus: {},
  downloadRunning: false,
  playbackCandles: {},
  playbackTrades: {},
  notifications: [],

  setBacktestJobs: (backtestJobs) => set({ backtestJobs }),
  upsertBacktestJob: (job) => set((state) => {
    const existing = state.backtestJobs.findIndex((j) => j.id === job.id);
    if (existing >= 0) {
      const updated = [...state.backtestJobs];
      updated[existing] = { ...updated[existing], ...job };
      return { backtestJobs: updated };
    }
    return { backtestJobs: [job, ...state.backtestJobs] };
  }),
  updateJobProgress: (jobId, progress) => set((state) => ({
    backtestJobs: state.backtestJobs.map((j) => j.id === jobId ? { ...j, progress } : j),
  })),
  setSelectedJobId: (selectedJobId) => set({ selectedJobId }),
  setDbStatus: (dbStatus) => set({ dbStatus }),
  setDownloadRunning: (downloadRunning) => set({ downloadRunning }),
  addPlaybackCandle: (jobId, candle) => set((state) => ({
    playbackCandles: {
      ...state.playbackCandles,
      [jobId]: [...(state.playbackCandles[jobId] ?? []).slice(-500), candle],
    },
  })),
  addPlaybackTrade: (jobId, trade) => set((state) => ({
    playbackTrades: {
      ...state.playbackTrades,
      [jobId]: [...(state.playbackTrades[jobId] ?? []), trade],
    },
  })),
  clearPlayback: (jobId) => set((state) => ({
    playbackCandles: { ...state.playbackCandles, [jobId]: [] },
    playbackTrades: { ...state.playbackTrades, [jobId]: [] },
  })),
  addNotification: (message, type) => set((state) => ({
    notifications: [
      ...state.notifications,
      { id: `n_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, message, type, createdAt: Date.now() },
    ],
  })),
  dismissNotification: (id) => set((state) => ({
    notifications: state.notifications.filter((n) => n.id !== id),
  })),
}));
