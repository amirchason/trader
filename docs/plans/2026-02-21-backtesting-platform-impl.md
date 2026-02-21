# Backtesting Platform Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a full Backtesting tab to the Polymarket trading dashboard — downloads 6-month OHLCV data from Binance, runs multiple background backtest jobs in parallel using worker threads, streams real-time candle playback, and shows a rich analytics dashboard.

**Architecture:** SQLite (`better-sqlite3`) stores all historical candles and job metadata. A custom SQLite-backed job queue dispatches jobs to a `worker_threads` pool (one worker per CPU core). The existing SSE stream at `/api/stream` is extended with `backtest_*` event types. The frontend gains a new Backtesting tab with Data Manager, Job Form, Job Queue panel, and Results Dashboard.

**Tech Stack:** `better-sqlite3` (SQLite), `unzipper` + `csv-parse` (ZIP/CSV parsing), `p-limit` (concurrency), Node.js `worker_threads`, React + Zustand + Tailwind + `lightweight-charts`

---

## Before You Start

Read these files to understand integration points:
- `server/index.ts` — SSE `broadcast()` function, Express app setup
- `server/types.ts` — `Candle`, `Asset`, `SSEPayload` types
- `server/indicators.ts` — `scoreStrategies()`, all indicator functions
- `src/store.ts` — Zustand store shape
- `src/services/api.ts` — `connectSSE()`, SSE message switch
- `src/App.tsx` — current layout (no tabs)
- `package.json` — existing dependencies

**Run the app first to see the current state:**
```bash
npm run dev
```
Open http://localhost:5174

---

## Phase 1: Install Dependencies + SQLite Setup

### Task 1: Install new server dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install packages**

```bash
npm install better-sqlite3 unzipper csv-parse p-limit
npm install --save-dev @types/better-sqlite3 @types/unzipper
```

**Step 2: Verify install**

```bash
npm ls better-sqlite3 unzipper csv-parse p-limit
```
Expected: all 4 listed under `dependencies`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3, unzipper, csv-parse, p-limit"
```

---

### Task 2: Create SQLite database module

**Files:**
- Create: `server/db.ts`

**Step 1: Create the file**

```typescript
// server/db.ts
import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'trader.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);

  // Performance: WAL mode allows concurrent reads + writes
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -64000'); // 64MB cache
  _db.pragma('temp_store = MEMORY');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol    TEXT    NOT NULL,
      timeframe TEXT    NOT NULL,
      open_time INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      PRIMARY KEY (symbol, timeframe, open_time)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_candle_range
      ON candles(symbol, timeframe, open_time);

    CREATE TABLE IF NOT EXISTS backtest_jobs (
      id           TEXT    PRIMARY KEY,
      config       TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      progress     INTEGER NOT NULL DEFAULT 0,
      result       TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_created
      ON backtest_jobs(created_at DESC);
  `);

  console.log('[DB] SQLite initialized:', DB_PATH);
  return _db;
}

export interface DbCandle {
  symbol: string;
  timeframe: string;
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function bulkInsertCandles(candles: DbCandle[]): number {
  const db = getDb();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO candles
      (symbol, timeframe, open_time, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows: DbCandle[]) => {
    for (const c of rows) {
      insert.run(c.symbol, c.timeframe, c.open_time, c.open, c.high, c.low, c.close, c.volume);
    }
    return rows.length;
  });

  return insertMany(candles) as number;
}

export function queryCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
): DbCandle[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT symbol, timeframe, open_time, open, high, low, close, volume
    FROM candles
    WHERE symbol = ? AND timeframe = ?
      AND open_time >= ? AND open_time <= ?
    ORDER BY open_time ASC
  `);
  return stmt.all(symbol, timeframe, startMs, endMs) as DbCandle[];
}

export function getDbStatus(): Record<string, Record<string, { count: number; earliest: number; latest: number }>> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT symbol, timeframe,
           COUNT(*) as count,
           MIN(open_time) as earliest,
           MAX(open_time) as latest
    FROM candles
    GROUP BY symbol, timeframe
  `).all() as { symbol: string; timeframe: string; count: number; earliest: number; latest: number }[];

  const result: Record<string, Record<string, { count: number; earliest: number; latest: number }>> = {};
  for (const row of rows) {
    if (!result[row.symbol]) result[row.symbol] = {};
    result[row.symbol][row.timeframe] = { count: row.count, earliest: row.earliest, latest: row.latest };
  }
  return result;
}

export function getLatestCandleTime(symbol: string, timeframe: string): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(open_time) as latest FROM candles
    WHERE symbol = ? AND timeframe = ?
  `).get(symbol, timeframe) as { latest: number | null };
  return row.latest;
}
```

**Step 2: Verify TypeScript compiles**

```bash
npx ts-node --project tsconfig.server.json -e "import { getDb } from './server/db'; getDb(); console.log('DB OK')"
```
Expected: `[DB] SQLite initialized: ...trader.db` then `DB OK`

**Step 3: Commit**

```bash
git add server/db.ts
git commit -m "feat(db): add SQLite module with candles + backtest_jobs schema"
```

---

## Phase 2: Historical Data Downloader

### Task 3: Create the historical data fetcher

**Files:**
- Create: `server/historical.ts`

**Step 1: Create the file**

```typescript
// server/historical.ts
import axios from 'axios';
import pLimit from 'p-limit';
import { Writable } from 'stream';
import { bulkInsertCandles, getLatestCandleTime, type DbCandle } from './db';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type BinanceSymbol = typeof SYMBOLS[number];
export type Timeframe = typeof TIMEFRAMES[number];

// Strip USDT suffix for storage
export function symbolToAsset(s: BinanceSymbol): string {
  return s.replace('USDT', '');
}

// ─────────────────── Stage 1: Bulk ZIP Download ───────────────────

async function downloadMonthlyZip(
  symbol: BinanceSymbol,
  interval: Timeframe,
  year: number,
  month: number,
  onProgress?: (msg: string) => void,
): Promise<DbCandle[]> {
  const monthStr = String(month).padStart(2, '0');
  const filename = `${symbol}-${interval}-${year}-${monthStr}`;
  const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/${interval}/${filename}.zip`;

  onProgress?.(`Downloading ${filename}.zip`);

  let buffer: Buffer;
  try {
    const res = await axios.get<Buffer>(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    });
    buffer = Buffer.from(res.data);
  } catch (err: any) {
    // 404 = month not yet available (current month)
    if (err?.response?.status === 404) return [];
    throw err;
  }

  // Parse ZIP → CSV → DbCandle[]
  const candles = await parseZipBuffer(buffer, symbol, interval);
  onProgress?.(`Parsed ${candles.length} candles from ${filename}`);
  return candles;
}

async function parseZipBuffer(
  buffer: Buffer,
  symbol: BinanceSymbol,
  interval: Timeframe,
): Promise<DbCandle[]> {
  // Dynamic import to avoid TS issues with unzipper streams
  const unzipper = await import('unzipper');
  const { parse } = await import('csv-parse');

  return new Promise((resolve, reject) => {
    const candles: DbCandle[] = [];
    const asset = symbolToAsset(symbol);

    const bufferStream = require('stream').Readable.from(buffer);

    bufferStream
      .pipe(unzipper.Parse())
      .on('entry', (entry: any) => {
        if (!entry.path.endsWith('.csv')) {
          entry.autodrain();
          return;
        }

        const parser = parse({ columns: false, skip_empty_lines: true });

        parser.on('data', (row: string[]) => {
          // Skip header row if present
          if (row[0] === 'open_time') return;
          const openTime = parseInt(row[0], 10);
          if (isNaN(openTime)) return;

          candles.push({
            symbol: asset,
            timeframe: interval,
            open_time: openTime,
            open: parseFloat(row[1]),
            high: parseFloat(row[2]),
            low: parseFloat(row[3]),
            close: parseFloat(row[4]),
            volume: parseFloat(row[5]),
          });
        });

        parser.on('error', reject);

        entry.pipe(parser);
      })
      .on('finish', () => resolve(candles))
      .on('error', reject);
  });
}

// ─────────────────── Stage 2: REST API Fill ───────────────────

const BINANCE_API = 'https://api.binance.com/api/v3';

async function fetchKlinesPage(
  symbol: BinanceSymbol,
  interval: Timeframe,
  startTime: number,
  limit = 1000,
): Promise<DbCandle[]> {
  const res = await axios.get(`${BINANCE_API}/klines`, {
    params: { symbol, interval, startTime, limit },
    timeout: 10_000,
  });

  const asset = symbolToAsset(symbol);
  return (res.data as any[][]).map((c) => ({
    symbol: asset,
    timeframe: interval,
    open_time: c[0] as number,
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

async function fillGapFromApi(
  symbol: BinanceSymbol,
  interval: Timeframe,
  fromMs: number,
  onProgress?: (msg: string) => void,
): Promise<number> {
  let startTime = fromMs;
  let totalInserted = 0;
  const now = Date.now();

  while (startTime < now) {
    const candles = await fetchKlinesPage(symbol, interval, startTime);
    if (candles.length === 0) break;

    const inserted = bulkInsertCandles(candles);
    totalInserted += inserted;

    startTime = candles[candles.length - 1].open_time + 1;
    onProgress?.(`${symbolToAsset(symbol)} ${interval}: fetched ${totalInserted} candles via API`);

    // Rate limit: 200ms between requests (safe for 6000 weight/min)
    await new Promise((r) => setTimeout(r, 200));
  }

  return totalInserted;
}

// ─────────────────── Orchestrator ───────────────────

export interface DownloadProgress {
  symbol: string;
  timeframe: string;
  phase: 'zip' | 'api' | 'done';
  message: string;
  inserted: number;
}

export async function downloadAllHistoricalData(
  symbols: BinanceSymbol[] = [...SYMBOLS],
  timeframes: Timeframe[] = [...TIMEFRAMES],
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const limit = pLimit(5); // 5 parallel ZIP downloads

  const now = new Date();
  // Last 6 complete months + current partial month
  const months: { year: number; month: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  // Stage 1: Bulk ZIP
  const zipTasks: Promise<void>[] = [];

  for (const sym of symbols) {
    for (const tf of timeframes) {
      for (const { year, month } of months) {
        zipTasks.push(
          limit(async () => {
            const candles = await downloadMonthlyZip(sym, tf, year, month, (msg) => {
              onProgress?.({ symbol: symbolToAsset(sym), timeframe: tf, phase: 'zip', message: msg, inserted: 0 });
            });

            if (candles.length > 0) {
              const inserted = bulkInsertCandles(candles);
              onProgress?.({
                symbol: symbolToAsset(sym), timeframe: tf, phase: 'zip',
                message: `Stored ${inserted} candles`, inserted,
              });
            }
          }),
        );
      }
    }
  }

  await Promise.allSettled(zipTasks);

  // Stage 2: Fill gaps with REST API
  for (const sym of symbols) {
    for (const tf of timeframes) {
      const asset = symbolToAsset(sym);
      const latest = getLatestCandleTime(asset, tf);
      const fromMs = latest ? latest + 1 : Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;

      const inserted = await fillGapFromApi(sym, tf, fromMs, (msg) => {
        onProgress?.({ symbol: asset, timeframe: tf, phase: 'api', message: msg, inserted: 0 });
      });

      onProgress?.({ symbol: asset, timeframe: tf, phase: 'done', message: `Complete. ${inserted} new via API`, inserted });
    }
  }
}
```

**Step 2: Verify TypeScript**

```bash
npx tsc --project tsconfig.server.json --noEmit
```
Expected: no errors

**Step 3: Commit**

```bash
git add server/historical.ts
git commit -m "feat(historical): add Binance ZIP bulk downloader + REST API fill"
```

---

## Phase 3: Backtesting Engine

### Task 4: Create the backtesting engine

**Files:**
- Create: `server/backtestEngine.ts`

**Step 1: Create the engine**

```typescript
// server/backtestEngine.ts
/**
 * Core backtesting engine.
 * Uses the existing scoreStrategies() from indicators.ts to generate signals
 * at each historical candle, then evaluates against the next candle's movement.
 */
import { scoreStrategies, calculateRSI, calculateVWAP, calculateMACD, detectMomentum } from './indicators';
import type { Candle, FundingData, BinanceOrderBook } from './types';
import type { DbCandle } from './db';

export type SignalMode = 'threshold' | 'crossover' | 'every_candle' | 'combined';
export type StrategyName = 'momentum_burst' | 'mean_reversion' | 'funding_squeeze' | 'order_book' | 'vwap' | 'all' | 'combined';

export interface BacktestConfig {
  coins: string[];        // e.g. ['BTC', 'ETH']
  timeframes: string[];   // e.g. ['5m', '15m']
  strategies: StrategyName[];
  signalModes: SignalMode[];
  thresholdMin: number;   // 0-10, used for 'threshold' mode
  initialCapital: number;
  fromMs: number;
  toMs: number;
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
  byCoinTimeframe: Record<string, StrategyMetrics>; // e.g. 'BTC_5m'
  trades: Trade[];
  completedAt: number;
}

// Convert DbCandle to server Candle type (compatible with indicators.ts)
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

// Stub funding + orderbook (not available in historical data)
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

  // Equity curve
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

  // Sharpe (simplified daily returns)
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

/**
 * Run backtest for a single coin × timeframe combination.
 * Calls onEvent for real-time streaming.
 */
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
  const betSize = config.initialCapital / 100; // 1% of capital per trade
  let equity = config.initialCapital;

  // Minimum warmup periods for indicators
  const WARMUP = 26;
  let prevVerdict: string | null = null;

  for (let i = WARMUP; i < candles.length - 1; i++) {
    // Progress event every 100 candles
    if (i % 100 === 0) {
      onEvent?.({ type: 'progress', processed: i, total, percent: Math.round((i / total) * 100) });
    }

    // Stream candle event every 50 candles for playback
    if (i % 50 === 0) {
      const c = candles[i];
      const rsi = calculateRSI(candles.slice(0, i + 1), 14);
      const vwap = calculateVWAP(candles.slice(Math.max(0, i - 99), i + 1));
      onEvent?.({
        type: 'candle',
        candle: { t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume },
        indicators: { rsi, vwap },
      });
    }

    const slice5m = candles.slice(Math.max(0, i - 99), i + 1); // last 100 candles
    const slice1m = candles.slice(Math.max(0, i - 19), i + 1); // last 20 candles

    const result = scoreStrategies(slice5m, slice1m, STUB_FUNDING, STUB_ORDER_BOOK);
    const { verdict, indicators } = result;

    const bullishScore = verdict.bullishScore;
    const bearishScore = verdict.bearishScore;
    const direction = verdict.direction;

    // Next candle direction (what actually happened)
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

/**
 * Aggregate trades into a BacktestResult.
 */
export function aggregateResults(
  allTrades: Trade[],
  config: BacktestConfig,
): BacktestResult {
  const summary = computeMetrics(allTrades, config.initialCapital);

  // By strategy
  const byStrategy: Record<string, StrategyMetrics> = {};
  const strategies = [...new Set(allTrades.map((t) => t.strategy))];
  for (const s of strategies) {
    byStrategy[s] = computeMetrics(allTrades.filter((t) => t.strategy === s), config.initialCapital);
  }

  // By coin
  const byCoin: Record<string, StrategyMetrics> = {};
  for (const coin of config.coins) {
    byCoin[coin] = computeMetrics(allTrades.filter((t) => t.coin === coin), config.initialCapital);
  }

  // By timeframe
  const byTimeframe: Record<string, StrategyMetrics> = {};
  for (const tf of config.timeframes) {
    byTimeframe[tf] = computeMetrics(allTrades.filter((t) => t.timeframe === tf), config.initialCapital);
  }

  // By coin × timeframe (for heatmap)
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
```

**Step 2: Verify TypeScript**

```bash
npx tsc --project tsconfig.server.json --noEmit
```
Expected: no errors

**Step 3: Commit**

```bash
git add server/backtestEngine.ts
git commit -m "feat(backtest): add backtesting engine with all strategies, signal modes, metrics"
```

---

## Phase 4: Worker Thread + Job Queue

### Task 5: Create the worker thread script

**Files:**
- Create: `server/backtestWorker.ts`

**Step 1: Create the worker**

```typescript
// server/backtestWorker.ts
/**
 * Worker thread entry point for backtesting.
 * Receives job config, queries SQLite, runs engine, streams events back.
 */
import { workerData, parentPort } from 'worker_threads';
import { getDb, queryCandles } from './db';
import { runBacktestForPair, aggregateResults, type BacktestConfig, type BacktestEvent } from './backtestEngine';

interface WorkerInput {
  jobId: string;
  config: BacktestConfig;
}

async function main() {
  const { jobId, config } = workerData as WorkerInput;

  if (!parentPort) throw new Error('No parentPort');

  const pairs: { coin: string; timeframe: string }[] = [];
  for (const coin of config.coins) {
    for (const timeframe of config.timeframes) {
      pairs.push({ coin, timeframe });
    }
  }

  const allTrades: any[] = [];
  let processedPairs = 0;

  for (const { coin, timeframe } of pairs) {
    const dbCandles = queryCandles(coin, timeframe, config.fromMs, config.toMs);

    if (dbCandles.length === 0) {
      processedPairs++;
      continue;
    }

    const pairTrades = runBacktestForPair(
      dbCandles,
      coin,
      timeframe,
      config,
      (event: BacktestEvent) => {
        // Stream events back to main thread
        parentPort!.postMessage({ jobId, event });
      },
    );

    allTrades.push(...pairTrades);
    processedPairs++;

    // Pair-level progress
    parentPort.postMessage({
      jobId,
      event: {
        type: 'progress',
        processed: processedPairs,
        total: pairs.length,
        percent: Math.round((processedPairs / pairs.length) * 100),
      },
    });
  }

  const result = aggregateResults(allTrades, config);

  // Send final result
  parentPort.postMessage({ jobId, event: { type: 'complete', result } });
}

main().catch((err) => {
  parentPort?.postMessage({ jobId: workerData?.jobId, event: { type: 'error', error: String(err) } });
});
```

**Step 2: Commit**

```bash
git add server/backtestWorker.ts
git commit -m "feat(worker): add backtesting worker thread"
```

---

### Task 6: Create the job queue

**Files:**
- Create: `server/jobQueue.ts`

**Step 1: Create the job queue**

```typescript
// server/jobQueue.ts
import { Worker } from 'worker_threads';
import path from 'path';
import os from 'os';
import { getDb } from './db';
import type { BacktestConfig, BacktestResult } from './backtestEngine';

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface BacktestJob {
  id: string;
  config: BacktestConfig;
  status: JobStatus;
  progress: number;
  result: BacktestResult | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

// SSE broadcast callback — set by server/index.ts
type BroadcastFn = (payload: object) => void;
let _broadcast: BroadcastFn = () => {};

export function setBroadcast(fn: BroadcastFn) {
  _broadcast = fn;
}

// ─────────────────── Job CRUD ───────────────────

function generateId(): string {
  return `bt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createJob(config: BacktestConfig): string {
  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO backtest_jobs (id, config, status, progress, created_at)
    VALUES (?, ?, 'pending', 0, ?)
  `).run(id, JSON.stringify(config), Date.now());

  scheduleWorker();
  return id;
}

export function getJob(id: string): BacktestJob | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM backtest_jobs WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    config: JSON.parse(row.config),
    status: row.status,
    progress: row.progress,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function listJobs(): BacktestJob[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM backtest_jobs ORDER BY created_at DESC LIMIT 50').all() as any[];
  return rows.map((row) => ({
    id: row.id,
    config: JSON.parse(row.config),
    status: row.status,
    progress: row.progress,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

export function deleteJob(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM backtest_jobs WHERE id = ? AND status != ?').run(id, 'running');
  return (result.changes as number) > 0;
}

// ─────────────────── Worker Pool ───────────────────

const MAX_CONCURRENT = Math.max(1, Math.min(3, os.cpus().length - 1));
let runningWorkers = 0;

// Resolve the worker script path (works with ts-node)
function getWorkerPath(): string {
  // In ts-node, we run TypeScript directly
  return path.join(__dirname, 'backtestWorker.ts');
}

function scheduleWorker() {
  if (runningWorkers >= MAX_CONCURRENT) return;

  const db = getDb();
  const nextJob = db.prepare(`
    SELECT id, config FROM backtest_jobs
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `).get() as { id: string; config: string } | undefined;

  if (!nextJob) return;

  // Mark as running
  db.prepare(`
    UPDATE backtest_jobs SET status = 'running', started_at = ? WHERE id = ?
  `).run(Date.now(), nextJob.id);

  runningWorkers++;

  _broadcast({ type: 'backtest_job_update', data: { jobId: nextJob.id, status: 'running', progress: 0 }, timestamp: Date.now() });

  // Spawn worker (ts-node registers TSX/TS loaders)
  const worker = new Worker(getWorkerPath(), {
    workerData: { jobId: nextJob.id, config: JSON.parse(nextJob.config) },
    // Required for ts-node worker threads:
    execArgv: ['--require', 'ts-node/register'],
  });

  worker.on('message', (msg: { jobId: string; event: any }) => {
    const { jobId, event } = msg;

    if (event.type === 'progress') {
      db.prepare('UPDATE backtest_jobs SET progress = ? WHERE id = ?').run(event.percent, jobId);
      _broadcast({ type: 'backtest_progress', data: { jobId, percent: event.percent }, timestamp: Date.now() });
    }

    if (event.type === 'candle') {
      _broadcast({ type: 'backtest_candle', data: { jobId, candle: event.candle, indicators: event.indicators }, timestamp: Date.now() });
    }

    if (event.type === 'trade') {
      _broadcast({ type: 'backtest_trade', data: { jobId, trade: event.trade }, timestamp: Date.now() });
    }

    if (event.type === 'complete') {
      // Store result (truncate trades array for storage — keep max 10k trades)
      const resultToStore = {
        ...event.result,
        trades: (event.result.trades as any[]).slice(0, 10_000),
      };

      db.prepare(`
        UPDATE backtest_jobs
        SET status = 'completed', progress = 100, result = ?, completed_at = ?
        WHERE id = ?
      `).run(JSON.stringify(resultToStore), Date.now(), jobId);

      runningWorkers--;
      _broadcast({ type: 'backtest_complete', data: { jobId, result: event.result.summary }, timestamp: Date.now() });
      scheduleWorker(); // pick up next pending job
    }

    if (event.type === 'error') {
      db.prepare(`
        UPDATE backtest_jobs
        SET status = 'failed', error = ?, completed_at = ?
        WHERE id = ?
      `).run(event.error, Date.now(), jobId);

      runningWorkers--;
      _broadcast({ type: 'backtest_job_update', data: { jobId, status: 'failed', error: event.error }, timestamp: Date.now() });
      scheduleWorker();
    }
  });

  worker.on('error', (err) => {
    db.prepare(`UPDATE backtest_jobs SET status = 'failed', error = ? WHERE id = ?`)
      .run(String(err), nextJob.id);
    runningWorkers--;
    scheduleWorker();
  });
}

// Resume any pending jobs that were running when server restarted
export function resumePendingJobs() {
  const db = getDb();
  // Reset any stuck 'running' jobs back to 'pending'
  db.prepare(`UPDATE backtest_jobs SET status = 'pending', progress = 0 WHERE status = 'running'`).run();

  // Schedule pending jobs
  const pending = db.prepare(`SELECT COUNT(*) as c FROM backtest_jobs WHERE status = 'pending'`).get() as { c: number };
  for (let i = 0; i < Math.min(pending.c, MAX_CONCURRENT); i++) {
    scheduleWorker();
  }
}
```

**Step 2: Commit**

```bash
git add server/jobQueue.ts
git commit -m "feat(jobQueue): add SQLite-backed job queue with worker_threads pool"
```

---

## Phase 5: Server Routes

### Task 7: Add backtesting routes to server/index.ts

**Files:**
- Modify: `server/index.ts`

**Step 1: Add imports after existing imports (line 7)**

```typescript
// Add after existing imports:
import { getDb, getDbStatus } from './db';
import { downloadAllHistoricalData } from './historical';
import { createJob, getJob, listJobs, deleteJob, resumePendingJobs, setBroadcast } from './jobQueue';
```

**Step 2: Update SSEPayload type in types.ts to include backtest event types**

In `server/types.ts`, change line 122:
```typescript
// Old:
export interface SSEPayload {
  type: 'markets' | 'btc' | 'signals' | 'book' | 'rtds';

// New:
export interface SSEPayload {
  type: 'markets' | 'btc' | 'signals' | 'book' | 'rtds'
    | 'backtest_job_update' | 'backtest_progress' | 'backtest_candle'
    | 'backtest_trade' | 'backtest_complete';
```

**Step 3: Wire broadcast to job queue (after the broadcast function, ~line 34)**

```typescript
// Add after the broadcast() function definition:
setBroadcast(broadcast);
```

**Step 4: Add download state tracking (after the state block, ~line 20)**

```typescript
// Download progress state
let downloadRunning = false;
const downloadProgress: Record<string, any> = {};
```

**Step 5: Add backtesting API routes (before the polling loops section, ~line 98)**

```typescript
// ─────────────────── Backtest Routes ───────────────────

app.get('/api/backtest/db-status', (_req: Request, res: Response) => {
  try {
    const status = getDbStatus();
    res.json({ status, downloadRunning });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/backtest/download', async (req: Request, res: Response) => {
  if (downloadRunning) {
    return res.status(409).json({ error: 'Download already in progress' });
  }

  const { coins, timeframes } = req.body as {
    coins?: string[];
    timeframes?: string[];
  };

  downloadRunning = true;
  res.json({ started: true });

  const symbols = (coins ?? ['BTC', 'ETH', 'SOL', 'XRP']).map((c) => `${c}USDT` as any);
  const tfs = (timeframes ?? ['1m', '5m', '15m', '1h', '4h', '1d']) as any[];

  downloadAllHistoricalData(symbols, tfs, (progress) => {
    downloadProgress[`${progress.symbol}_${progress.timeframe}`] = progress;
    broadcast({ type: 'backtest_job_update', data: { type: 'download_progress', ...progress }, timestamp: Date.now() });
  })
    .catch((err) => console.error('[Download] Error:', err))
    .finally(() => { downloadRunning = false; });
});

app.post('/api/backtest/run', (req: Request, res: Response) => {
  try {
    const config = req.body;
    if (!config.coins?.length || !config.timeframes?.length) {
      return res.status(400).json({ error: 'coins and timeframes required' });
    }

    config.fromMs = config.fromMs ?? Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;
    config.toMs = config.toMs ?? Date.now();
    config.initialCapital = config.initialCapital ?? 100;
    config.thresholdMin = config.thresholdMin ?? 7;
    config.strategies = config.strategies ?? ['all'];
    config.signalModes = config.signalModes ?? ['threshold'];

    const jobId = createJob(config);
    res.json({ jobId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/backtest/jobs', (_req: Request, res: Response) => {
  try {
    const jobs = listJobs();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/backtest/jobs/:id', (req: Request, res: Response) => {
  try {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/backtest/jobs/:id', (req: Request, res: Response) => {
  try {
    const deleted = deleteJob(req.params.id);
    if (!deleted) return res.status(409).json({ error: 'Cannot delete running job or not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/backtest/export/:id', (req: Request, res: Response) => {
  try {
    const job = getJob(req.params.id);
    if (!job || !job.result) return res.status(404).json({ error: 'Job result not found' });

    const format = req.query.format as string ?? 'json';
    if (format === 'csv') {
      const trades = job.result.trades;
      const headers = ['time', 'coin', 'timeframe', 'strategy', 'signalMode', 'direction', 'result', 'pnl', 'equity',
        'rsi14', 'rsi7', 'vwap', 'macdVal', 'momentumStrength', 'bullishScore', 'bearishScore'];
      const rows = trades.map((t: any) => [
        t.time, t.coin, t.timeframe, t.strategy, t.signalMode, t.direction, t.result, t.pnl, t.equity,
        t.rawFeatures?.rsi14 ?? '', t.rawFeatures?.rsi7 ?? '', t.rawFeatures?.vwap ?? '',
        t.rawFeatures?.macdVal ?? '', t.rawFeatures?.momentumStrength ?? '',
        t.rawFeatures?.bullishScore ?? '', t.rawFeatures?.bearishScore ?? '',
      ]);
      const csv = [headers.join(','), ...rows.map((r: any[]) => r.join(','))].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="backtest_${req.params.id}.csv"`);
      res.send(csv);
    } else {
      res.json(job.result);
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

**Step 6: Initialize DB + resume pending jobs on startup (before the polling intervals, ~line 143)**

```typescript
// Add before: setInterval(pollMarkets, 10_000)
getDb(); // Initialize SQLite
resumePendingJobs(); // Resume any pending jobs from before restart
```

**Step 7: Verify server starts**

```bash
npm run dev:server
```
Expected: `[Server] Trader API running on http://localhost:3001` and `[DB] SQLite initialized`

**Step 8: Test download endpoint**

```bash
curl -X POST http://localhost:3001/api/backtest/download \
  -H "Content-Type: application/json" \
  -d '{"coins":["BTC"],"timeframes":["1h","4h","1d"]}'
```
Expected: `{"started":true}`

**Step 9: Test job submission**

```bash
curl -X POST http://localhost:3001/api/backtest/run \
  -H "Content-Type: application/json" \
  -d '{"coins":["BTC"],"timeframes":["1h"],"signalModes":["threshold"],"thresholdMin":7}'
```
Expected: `{"jobId":"bt_..."}` — verify job appears in `GET /api/backtest/jobs`

**Step 10: Commit**

```bash
git add server/index.ts server/types.ts
git commit -m "feat(server): add /api/backtest/* routes, wire job queue to SSE stream"
```

---

## Phase 6: Frontend Store + SSE

### Task 8: Update Zustand store with backtest state

**Files:**
- Modify: `src/store.ts`

**Step 1: Add backtest types and state to store.ts**

Add these interfaces before the `Store` interface (around line 96):

```typescript
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

export interface ToastNotification {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
  createdAt: number;
}
```

Add these to the `Store` interface:

```typescript
  // Backtest state
  backtestJobs: BacktestJobSummary[];
  selectedJobId: string | null;
  dbStatus: BacktestDbStatus;
  downloadRunning: boolean;
  playbackCandles: Record<string, PlaybackCandle[]>;   // jobId → candles
  playbackTrades: Record<string, PlaybackTrade[]>;     // jobId → trades
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
```

Add initial values + setters to `create<Store>()`:

```typescript
  // Initial backtest state
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
      updated[existing] = job;
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
      { id: `n_${Date.now()}`, message, type, createdAt: Date.now() },
    ],
  })),
  dismissNotification: (id) => set((state) => ({
    notifications: state.notifications.filter((n) => n.id !== id),
  })),
```

**Step 2: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): add backtest state slice with jobs, playback, notifications"
```

---

### Task 9: Update SSE handler with backtest events

**Files:**
- Modify: `src/services/api.ts`

**Step 1: Add backtest event cases to the switch in connectSSE()** (after line 33 `case 'rtds':`)

```typescript
        case 'backtest_job_update': {
          const { jobId, status, progress, error } = payload.data as any;
          const { upsertBacktestJob, addNotification } = useStore.getState();
          if (status === 'running' || status === 'failed' || status === 'pending') {
            upsertBacktestJob({ id: jobId, status, progress: progress ?? 0, config: {coins:[],timeframes:[],signalModes:[]}, createdAt: Date.now(), completedAt: null });
          }
          if (status === 'failed') addNotification(`Backtest ${jobId} failed: ${error}`, 'error');
          break;
        }

        case 'backtest_progress': {
          const { jobId, percent } = payload.data as any;
          useStore.getState().updateJobProgress(jobId, percent);
          break;
        }

        case 'backtest_candle': {
          const { jobId, candle, indicators } = payload.data as any;
          useStore.getState().addPlaybackCandle(jobId, { ...candle, indicators });
          break;
        }

        case 'backtest_trade': {
          const { jobId, trade } = payload.data as any;
          useStore.getState().addPlaybackTrade(jobId, trade);
          break;
        }

        case 'backtest_complete': {
          const { jobId, result } = payload.data as any;
          const { upsertBacktestJob, addNotification } = useStore.getState();
          upsertBacktestJob({
            id: jobId, status: 'completed', progress: 100,
            config: {coins:[],timeframes:[],signalModes:[]},
            createdAt: Date.now(), completedAt: Date.now(),
            summary: result,
          });
          addNotification(
            `✓ Backtest complete — Win Rate: ${(result.winRate * 100).toFixed(1)}% | P&L: $${result.totalPnl.toFixed(2)}`,
            'success',
          );
          break;
        }
```

**Step 2: Add backtest API helper functions** (at end of file)

```typescript
// Backtest API helpers

export async function fetchDbStatus() {
  const res = await fetch('/api/backtest/db-status');
  return res.json();
}

export async function triggerDownload(coins: string[], timeframes: string[]) {
  const res = await fetch('/api/backtest/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coins, timeframes }),
  });
  return res.json();
}

export async function submitBacktestJob(config: object) {
  const res = await fetch('/api/backtest/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return res.json();
}

export async function fetchBacktestJobs() {
  const res = await fetch('/api/backtest/jobs');
  return res.json();
}

export async function fetchBacktestJob(id: string) {
  const res = await fetch(`/api/backtest/jobs/${id}`);
  return res.json();
}

export async function deleteBacktestJob(id: string) {
  const res = await fetch(`/api/backtest/jobs/${id}`, { method: 'DELETE' });
  return res.json();
}
```

**Step 3: Commit**

```bash
git add src/services/api.ts
git commit -m "feat(api): add backtest SSE event handlers + API helper functions"
```

---

## Phase 7: Toast Notification Component

### Task 10: Create global toast notification system

**Files:**
- Create: `src/components/Notification.tsx`

**Step 1: Create the component**

```tsx
// src/components/Notification.tsx
import { useEffect } from 'react';
import { useStore } from '../store';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';

export function NotificationCenter() {
  const notifications = useStore((s) => s.notifications);
  const dismiss = useStore((s) => s.dismissNotification);

  // Auto-dismiss after 8 seconds
  useEffect(() => {
    if (notifications.length === 0) return;
    const timer = setTimeout(() => {
      dismiss(notifications[0].id);
    }, 8000);
    return () => clearTimeout(timer);
  }, [notifications, dismiss]);

  if (notifications.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md">
      {notifications.slice(0, 5).map((n) => (
        <div
          key={n.id}
          className={`flex items-start gap-3 p-4 rounded-lg shadow-xl border text-sm animate-in slide-in-from-right-5 ${
            n.type === 'success'
              ? 'bg-emerald-900/95 border-emerald-700 text-emerald-100'
              : n.type === 'error'
              ? 'bg-red-900/95 border-red-700 text-red-100'
              : 'bg-gray-800/95 border-gray-700 text-gray-100'
          }`}
        >
          {n.type === 'success' ? (
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          ) : n.type === 'error' ? (
            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          ) : (
            <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
          )}
          <span className="flex-1">{n.message}</span>
          <button
            onClick={() => dismiss(n.id)}
            className="text-gray-400 hover:text-white shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
```

**Step 2: Add to App.tsx** (inside the return, after `</main>`)

```tsx
import { NotificationCenter } from './components/Notification';
// ...
  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      {/* ... existing ... */}
      <NotificationCenter />
    </div>
  );
```

**Step 3: Commit**

```bash
git add src/components/Notification.tsx src/App.tsx
git commit -m "feat(ui): add global toast notification system"
```

---

## Phase 8: Backtesting UI — Core Components

### Task 11: Create DataManager component

**Files:**
- Create: `src/components/backtest/DataManager.tsx`

```tsx
// src/components/backtest/DataManager.tsx
import { useEffect, useState } from 'react';
import { Database, Download, RefreshCw, CheckCircle } from 'lucide-react';
import { useStore } from '../../store';
import { fetchDbStatus, triggerDownload } from '../../services/api';

const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function DataManager() {
  const dbStatus = useStore((s) => s.dbStatus);
  const setDbStatus = useStore((s) => s.setDbStatus);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    const data = await fetchDbStatus();
    setDbStatus(data.status ?? {});
  }

  useEffect(() => { refresh(); }, []);

  async function handleDownloadAll() {
    setLoading(true);
    await triggerDownload(COINS, TIMEFRAMES);
    // Refresh every 5s while downloading
    const interval = setInterval(refresh, 5000);
    setTimeout(() => { clearInterval(interval); setLoading(false); }, 60_000 * 10);
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <Database className="w-4 h-4 text-blue-400" />
          Historical Data
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh} className="p-1.5 text-gray-400 hover:text-white rounded">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDownloadAll}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded font-medium"
          >
            <Download className="w-3.5 h-3.5" />
            {loading ? 'Downloading...' : 'Download All (6mo)'}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left py-1 pr-3">Coin</th>
              {TIMEFRAMES.map((tf) => (
                <th key={tf} className="text-center py-1 px-2">{tf}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COINS.map((coin) => (
              <tr key={coin} className="border-t border-gray-800">
                <td className="py-1.5 pr-3 font-medium text-gray-300">{coin}</td>
                {TIMEFRAMES.map((tf) => {
                  const info = dbStatus[coin]?.[tf];
                  return (
                    <td key={tf} className="text-center py-1.5 px-2">
                      {info ? (
                        <span className="flex items-center justify-center gap-1 text-emerald-400">
                          <CheckCircle className="w-3 h-3" />
                          {formatCount(info.count)}
                        </span>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

### Task 12: Create JobForm component

**Files:**
- Create: `src/components/backtest/JobForm.tsx`

```tsx
// src/components/backtest/JobForm.tsx
import { useState } from 'react';
import { Play } from 'lucide-react';
import { useStore } from '../../store';
import { submitBacktestJob, fetchBacktestJobs } from '../../services/api';

const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];
const STRATEGIES = [
  { id: 'all', label: 'All Strategies' },
  { id: 'momentum_burst', label: 'Momentum Burst 🚀' },
  { id: 'mean_reversion', label: 'Mean Reversion ↩️' },
  { id: 'funding_squeeze', label: 'Funding Squeeze 💰' },
  { id: 'order_book', label: 'Order Book 📊' },
  { id: 'vwap', label: 'VWAP Signal 📈' },
  { id: 'combined', label: 'Combined Signal' },
];
const SIGNAL_MODES = [
  { id: 'threshold', label: 'Threshold (score ≥ N)' },
  { id: 'crossover', label: 'Crossover (signal flip)' },
  { id: 'every_candle', label: 'Every Candle' },
  { id: 'combined', label: 'Combined Score' },
];

function MultiSelect<T extends string>({
  options, value, onChange, label,
}: {
  options: { id: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  label: string;
}) {
  const toggle = (id: T) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <div>
      <label className="text-xs text-gray-400 mb-1 block">{label}</label>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => toggle(opt.id)}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              value.includes(opt.id)
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function JobForm() {
  const setBacktestJobs = useStore((s) => s.setBacktestJobs);
  const [coins, setCoins] = useState<string[]>(['BTC']);
  const [timeframes, setTimeframes] = useState<string[]>(['5m', '15m']);
  const [strategies, setStrategies] = useState<string[]>(['all']);
  const [signalModes, setSignalModes] = useState<string[]>(['threshold', 'combined']);
  const [threshold, setThreshold] = useState(7);
  const [capital, setCapital] = useState(100);
  const [monthsBack, setMonthsBack] = useState(6);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!coins.length || !timeframes.length || !signalModes.length) return;
    setSubmitting(true);

    const fromMs = Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000;
    const toMs = Date.now();

    try {
      await submitBacktestJob({
        coins, timeframes, strategies, signalModes,
        thresholdMin: threshold, initialCapital: capital, fromMs, toMs,
      });
      const jobs = await fetchBacktestJobs();
      setBacktestJobs(jobs);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-gray-200">Configure Backtest</h3>

      <MultiSelect
        options={COINS.map((c) => ({ id: c, label: c }))}
        value={coins}
        onChange={setCoins}
        label="Coins"
      />

      <MultiSelect
        options={TIMEFRAMES.map((t) => ({ id: t, label: t }))}
        value={timeframes}
        onChange={setTimeframes}
        label="Timeframes"
      />

      <MultiSelect
        options={STRATEGIES as any}
        value={strategies}
        onChange={setStrategies}
        label="Strategies"
      />

      <MultiSelect
        options={SIGNAL_MODES as any}
        value={signalModes}
        onChange={setSignalModes}
        label="Signal Modes"
      />

      <div>
        <label className="text-xs text-gray-400 mb-1 flex justify-between">
          <span>Min Score Threshold</span>
          <span className="text-blue-400 font-mono">{threshold}/10</span>
        </label>
        <input
          type="range" min={1} max={10} step={0.5}
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          className="w-full accent-blue-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Initial Capital ($)</label>
          <input
            type="number" value={capital} onChange={(e) => setCapital(parseInt(e.target.value, 10))}
            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Date Range</label>
          <select
            value={monthsBack}
            onChange={(e) => setMonthsBack(parseInt(e.target.value, 10))}
            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5"
          >
            <option value={1}>Last 1 month</option>
            <option value={3}>Last 3 months</option>
            <option value={6}>Last 6 months</option>
          </select>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting || !coins.length || !timeframes.length}
        className="flex items-center justify-center gap-2 w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded"
      >
        <Play className="w-4 h-4" />
        {submitting ? 'Submitting...' : 'Run Backtest'}
      </button>
    </div>
  );
}
```

---

### Task 13: Create JobList component

**Files:**
- Create: `src/components/backtest/JobList.tsx`

```tsx
// src/components/backtest/JobList.tsx
import { useEffect } from 'react';
import { Circle, CheckCircle, XCircle, Clock, Trash2, Eye } from 'lucide-react';
import { useStore } from '../../store';
import { fetchBacktestJobs, deleteBacktestJob } from '../../services/api';

const STATUS_CONFIG = {
  pending: { icon: Clock, color: 'text-yellow-400', label: 'Pending' },
  running: { icon: Circle, color: 'text-blue-400 animate-pulse', label: 'Running' },
  completed: { icon: CheckCircle, color: 'text-emerald-400', label: 'Done' },
  failed: { icon: XCircle, color: 'text-red-400', label: 'Failed' },
};

export function JobList() {
  const jobs = useStore((s) => s.backtestJobs);
  const selectedJobId = useStore((s) => s.selectedJobId);
  const setSelectedJobId = useStore((s) => s.setSelectedJobId);
  const setBacktestJobs = useStore((s) => s.setBacktestJobs);

  useEffect(() => {
    fetchBacktestJobs().then(setBacktestJobs).catch(() => {});
  }, []);

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await deleteBacktestJob(id);
    const jobs = await fetchBacktestJobs();
    setBacktestJobs(jobs);
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">
        Job Queue
        {jobs.filter((j) => j.status === 'running').length > 0 && (
          <span className="ml-2 px-1.5 py-0.5 bg-blue-600 text-white text-xs rounded">
            {jobs.filter((j) => j.status === 'running').length} running
          </span>
        )}
      </h3>

      {jobs.length === 0 ? (
        <p className="text-gray-500 text-xs text-center py-6">No backtest jobs yet</p>
      ) : (
        <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
          {jobs.map((job) => {
            const cfg = STATUS_CONFIG[job.status];
            const Icon = cfg.icon;
            const isSelected = job.id === selectedJobId;

            return (
              <div
                key={job.id}
                onClick={() => setSelectedJobId(job.id)}
                className={`flex items-center gap-3 p-3 rounded cursor-pointer border transition-colors ${
                  isSelected
                    ? 'bg-blue-900/30 border-blue-700'
                    : 'bg-gray-800/50 border-gray-700/50 hover:border-gray-600'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${cfg.color}`} />

                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-200 truncate">
                    {job.config.coins?.join(', ')} × {job.config.timeframes?.join(', ')}
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                    <span>{cfg.label}</span>
                    {job.status === 'running' && (
                      <span className="text-blue-400">{job.progress}%</span>
                    )}
                    {job.summary && (
                      <span className="text-emerald-400">
                        WR: {(job.summary.winRate * 100).toFixed(1)}%
                      </span>
                    )}
                  </div>

                  {job.status === 'running' && (
                    <div className="mt-1.5 w-full bg-gray-700 rounded-full h-1">
                      <div
                        className="bg-blue-500 h-1 rounded-full transition-all"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {job.status === 'completed' && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedJobId(job.id); }}
                      className="p-1 text-gray-400 hover:text-white"
                      title="View results"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {job.status !== 'running' && (
                    <button
                      onClick={(e) => handleDelete(job.id, e)}
                      className="p-1 text-gray-600 hover:text-red-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

**Step 1: Commit all backtest UI components so far**

```bash
git add src/components/backtest/
git commit -m "feat(ui): add DataManager, JobForm, JobList backtest components"
```

---

## Phase 9: Results Dashboard

### Task 14: Create MetricsGrid

**Files:**
- Create: `src/components/backtest/MetricsGrid.tsx`

```tsx
// src/components/backtest/MetricsGrid.tsx
import { useState } from 'react';
import { ArrowUpDown } from 'lucide-react';

interface MetricRow {
  label: string;
  coin: string;
  timeframe: string;
  winRate: number;
  totalPnl: number;
  sharpe: number;
  maxDrawdown: number;
  totalTrades: number;
  profitFactor: number;
}

type SortKey = keyof Omit<MetricRow, 'label' | 'coin' | 'timeframe'>;

export function MetricsGrid({ byCoinTimeframe }: {
  byCoinTimeframe: Record<string, any>;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('winRate');
  const [sortAsc, setSortAsc] = useState(false);
  const [filterCoin, setFilterCoin] = useState('All');
  const [filterTf, setFilterTf] = useState('All');

  const rows: MetricRow[] = Object.entries(byCoinTimeframe).map(([key, m]: [string, any]) => {
    const [coin, timeframe] = key.split('_');
    return {
      label: key, coin, timeframe,
      winRate: m.winRate ?? 0,
      totalPnl: m.totalPnl ?? 0,
      sharpe: m.sharpe ?? 0,
      maxDrawdown: m.maxDrawdown ?? 0,
      totalTrades: m.totalTrades ?? 0,
      profitFactor: m.profitFactor ?? 0,
    };
  });

  const coins = ['All', ...new Set(rows.map((r) => r.coin))];
  const tfs = ['All', ...new Set(rows.map((r) => r.timeframe))];

  const filtered = rows
    .filter((r) => filterCoin === 'All' || r.coin === filterCoin)
    .filter((r) => filterTf === 'All' || r.timeframe === filterTf)
    .sort((a, b) => sortAsc ? (a[sortKey] as number) - (b[sortKey] as number) : (b[sortKey] as number) - (a[sortKey] as number));

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  const ColHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      className="text-right py-1.5 px-2 cursor-pointer hover:text-white select-none"
      onClick={() => toggleSort(k)}
    >
      <span className="flex items-center justify-end gap-1">
        {label}
        <ArrowUpDown className="w-3 h-3 opacity-50" />
      </span>
    </th>
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Performance by Coin × Timeframe</h3>
        <div className="flex gap-2">
          <select value={filterCoin} onChange={(e) => setFilterCoin(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1">
            {coins.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={filterTf} onChange={(e) => setFilterTf(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1">
            {tfs.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="text-left py-1.5 px-2">Pair</th>
              <ColHeader k="winRate" label="Win Rate" />
              <ColHeader k="totalPnl" label="P&L ($)" />
              <ColHeader k="sharpe" label="Sharpe" />
              <ColHeader k="maxDrawdown" label="Drawdown" />
              <ColHeader k="profitFactor" label="Prof. Factor" />
              <ColHeader k="totalTrades" label="Trades" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.label} className="border-t border-gray-800 hover:bg-gray-800/30">
                <td className="py-1.5 px-2 font-medium text-gray-300">{r.coin} {r.timeframe}</td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.winRate >= 0.55 ? 'text-emerald-400' : r.winRate >= 0.45 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {(r.winRate * 100).toFixed(1)}%
                </td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {r.totalPnl >= 0 ? '+' : ''}{r.totalPnl.toFixed(2)}
                </td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.sharpe >= 1 ? 'text-emerald-400' : r.sharpe >= 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {r.sharpe.toFixed(2)}
                </td>
                <td className="text-right py-1.5 px-2 font-mono text-orange-400">
                  {(r.maxDrawdown * 100).toFixed(1)}%
                </td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.profitFactor >= 1.5 ? 'text-emerald-400' : 'text-gray-400'}`}>
                  {r.profitFactor.toFixed(2)}x
                </td>
                <td className="text-right py-1.5 px-2 text-gray-400">{r.totalTrades}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

### Task 15: Create HeatMap component

**Files:**
- Create: `src/components/backtest/HeatMap.tsx`

```tsx
// src/components/backtest/HeatMap.tsx
const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

function heatColor(winRate: number): string {
  if (winRate >= 0.65) return 'bg-emerald-600 text-white';
  if (winRate >= 0.58) return 'bg-emerald-800 text-emerald-200';
  if (winRate >= 0.52) return 'bg-yellow-800 text-yellow-200';
  if (winRate >= 0.45) return 'bg-orange-900 text-orange-300';
  return 'bg-red-900 text-red-300';
}

export function HeatMap({ byCoinTimeframe }: { byCoinTimeframe: Record<string, any> }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">Win Rate Heatmap</h3>
      <div className="overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left py-1 pr-4 w-12">Coin</th>
              {TIMEFRAMES.map((tf) => (
                <th key={tf} className="text-center py-1 px-2">{tf}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COINS.map((coin) => (
              <tr key={coin}>
                <td className="py-1.5 pr-4 font-medium text-gray-300">{coin}</td>
                {TIMEFRAMES.map((tf) => {
                  const key = `${coin}_${tf}`;
                  const m = byCoinTimeframe[key];
                  const wr = m?.winRate ?? null;
                  return (
                    <td key={tf} className="py-1 px-1 text-center">
                      {wr !== null ? (
                        <span className={`inline-block px-2 py-1 rounded text-xs font-mono ${heatColor(wr)}`}>
                          {(wr * 100).toFixed(0)}%
                        </span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

### Task 16: Create EquityCurve + PlaybackChart

**Files:**
- Create: `src/components/backtest/EquityCurve.tsx`

```tsx
// src/components/backtest/EquityCurve.tsx
import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';

interface Point { time: number; equity: number }

export function EquityCurve({ curve, title = 'Equity Curve' }: { curve: Point[]; title?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || curve.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9ca3af' },
      grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
      width: containerRef.current.clientWidth,
      height: 200,
      timeScale: { timeVisible: true, borderColor: '#374151' },
      rightPriceScale: { borderColor: '#374151' },
      crosshair: { mode: 1 },
    });

    const lineSeries = chart.addLineSeries({
      color: '#10b981',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
    });

    const data = curve.map((p) => ({
      time: Math.floor(p.time / 1000) as any,
      value: p.equity,
    }));

    lineSeries.setData(data);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.resize(containerRef.current.clientWidth, 200);
    });
    ro.observe(containerRef.current);

    return () => { chart.remove(); ro.disconnect(); };
  }, [curve]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">{title}</h3>
      {curve.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-gray-600 text-sm">No data</div>
      ) : (
        <div ref={containerRef} className="w-full" />
      )}
    </div>
  );
}
```

---

### Task 17: Create TradeLog

**Files:**
- Create: `src/components/backtest/TradeLog.tsx`

```tsx
// src/components/backtest/TradeLog.tsx
import { useState } from 'react';

interface Trade {
  time: number; coin: string; timeframe: string;
  strategy: string; signalMode: string; direction: string;
  result: string; pnl: number; equity: number;
}

export function TradeLog({ trades }: { trades: Trade[] }) {
  const [filterCoin, setFilterCoin] = useState('All');
  const [filterResult, setFilterResult] = useState('All');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const coins = ['All', ...new Set(trades.map((t) => t.coin))];
  const filtered = trades
    .filter((t) => filterCoin === 'All' || t.coin === filterCoin)
    .filter((t) => filterResult === 'All' || t.result === filterResult);

  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">
          Trade Log <span className="text-gray-500 font-normal">({filtered.length} trades)</span>
        </h3>
        <div className="flex gap-2">
          <select value={filterCoin} onChange={(e) => { setFilterCoin(e.target.value); setPage(0); }}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1">
            {coins.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={filterResult} onChange={(e) => { setFilterResult(e.target.value); setPage(0); }}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1">
            <option>All</option>
            <option>WIN</option>
            <option>LOSS</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="text-left py-1.5 px-2">Time</th>
              <th className="text-left py-1.5 px-2">Coin</th>
              <th className="text-left py-1.5 px-2">TF</th>
              <th className="text-left py-1.5 px-2">Mode</th>
              <th className="text-left py-1.5 px-2">Dir</th>
              <th className="text-left py-1.5 px-2">Result</th>
              <th className="text-right py-1.5 px-2">P&L</th>
              <th className="text-right py-1.5 px-2">Equity</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((t, i) => (
              <tr key={i} className="border-t border-gray-800/50 hover:bg-gray-800/20">
                <td className="py-1 px-2 text-gray-500">{new Date(t.time).toLocaleDateString()}</td>
                <td className="py-1 px-2 text-gray-300">{t.coin}</td>
                <td className="py-1 px-2 text-gray-400">{t.timeframe}</td>
                <td className="py-1 px-2 text-gray-500">{t.signalMode}</td>
                <td className={`py-1 px-2 font-medium ${t.direction === 'BULL' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.direction === 'BULL' ? '▲' : '▼'} {t.direction}
                </td>
                <td className={`py-1 px-2 font-medium ${t.result === 'WIN' ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.result}
                </td>
                <td className={`py-1 px-2 text-right font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                </td>
                <td className="py-1 px-2 text-right font-mono text-gray-400">{t.equity.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
          <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
            className="px-2 py-1 bg-gray-800 rounded disabled:opacity-30">← Prev</button>
          <span>Page {page + 1} / {totalPages}</span>
          <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}
            className="px-2 py-1 bg-gray-800 rounded disabled:opacity-30">Next →</button>
        </div>
      )}
    </div>
  );
}
```

---

### Task 18: Create ResultsDashboard

**Files:**
- Create: `src/components/backtest/ResultsDashboard.tsx`

```tsx
// src/components/backtest/ResultsDashboard.tsx
import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { fetchBacktestJob } from '../../services/api';
import { MetricsGrid } from './MetricsGrid';
import { HeatMap } from './HeatMap';
import { EquityCurve } from './EquityCurve';
import { TradeLog } from './TradeLog';
import { TrendingUp, BarChart2, List, Grid } from 'lucide-react';

export function ResultsDashboard() {
  const selectedJobId = useStore((s) => s.selectedJobId);
  const playbackCandles = useStore((s) => s.playbackCandles);
  const jobs = useStore((s) => s.backtestJobs);
  const [result, setResult] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'heatmap' | 'trades'>('overview');

  const selectedJob = jobs.find((j) => j.id === selectedJobId);
  const isRunning = selectedJob?.status === 'running';

  useEffect(() => {
    if (!selectedJobId) { setResult(null); return; }
    if (selectedJob?.status === 'completed') {
      fetchBacktestJob(selectedJobId).then((j) => setResult(j.result));
    }
  }, [selectedJobId, selectedJob?.status]);

  if (!selectedJobId) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 text-center text-gray-500 text-sm">
        Select a job from the queue to view results
      </div>
    );
  }

  const summaryCards = result
    ? [
        { label: 'Win Rate', value: `${(result.summary.winRate * 100).toFixed(1)}%`, color: result.summary.winRate >= 0.55 ? 'text-emerald-400' : 'text-red-400' },
        { label: 'Total P&L', value: `$${result.summary.totalPnl.toFixed(2)}`, color: result.summary.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400' },
        { label: 'Sharpe', value: result.summary.sharpe.toFixed(2), color: result.summary.sharpe >= 1 ? 'text-emerald-400' : 'text-yellow-400' },
        { label: 'Max DD', value: `${(result.summary.maxDrawdown * 100).toFixed(1)}%`, color: 'text-orange-400' },
        { label: 'Trades', value: result.summary.totalTrades.toLocaleString(), color: 'text-gray-200' },
        { label: 'Prof. Factor', value: `${result.summary.profitFactor.toFixed(2)}x`, color: result.summary.profitFactor >= 1.5 ? 'text-emerald-400' : 'text-yellow-400' },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      {/* Summary Cards */}
      {result && (
        <div className="grid grid-cols-6 gap-3">
          {summaryCards.map((c) => (
            <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
              <div className={`text-lg font-bold font-mono ${c.color}`}>{c.value}</div>
              <div className="text-xs text-gray-500 mt-0.5">{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Live playback chart when running */}
      {isRunning && selectedJobId && (
        <EquityCurve
          curve={(playbackCandles[selectedJobId] ?? []).map((c, i) => ({ time: c.t, equity: 100 + i }))}
          title="Live Playback"
        />
      )}

      {/* Tabs */}
      {result && (
        <>
          <div className="flex gap-1">
            {[
              { id: 'overview' as const, icon: TrendingUp, label: 'Overview' },
              { id: 'heatmap' as const, icon: Grid, label: 'Heatmap' },
              { id: 'trades' as const, icon: List, label: 'Trade Log' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
              >
                <tab.icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && (
            <>
              <EquityCurve curve={result.summary.equityCurve ?? []} />
              <MetricsGrid byCoinTimeframe={result.byCoinTimeframe ?? {}} />
            </>
          )}

          {activeTab === 'heatmap' && (
            <HeatMap byCoinTimeframe={result.byCoinTimeframe ?? {}} />
          )}

          {activeTab === 'trades' && (
            <TradeLog trades={result.trades ?? []} />
          )}
        </>
      )}
    </div>
  );
}
```

**Step 1: Commit all results dashboard components**

```bash
git add src/components/backtest/
git commit -m "feat(ui): add MetricsGrid, HeatMap, EquityCurve, TradeLog, ResultsDashboard components"
```

---

## Phase 10: Main Tab + App Integration

### Task 19: Create BacktestTab + update App.tsx

**Files:**
- Create: `src/components/BacktestTab.tsx`
- Modify: `src/App.tsx`

**Step 1: Create BacktestTab**

```tsx
// src/components/BacktestTab.tsx
import { DataManager } from './backtest/DataManager';
import { JobForm } from './backtest/JobForm';
import { JobList } from './backtest/JobList';
import { ResultsDashboard } from './backtest/ResultsDashboard';

export function BacktestTab() {
  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Data Manager */}
      <DataManager />

      {/* Job Config + Queue */}
      <div className="grid grid-cols-2 gap-4">
        <JobForm />
        <JobList />
      </div>

      {/* Results */}
      <ResultsDashboard />
    </div>
  );
}
```

**Step 2: Update App.tsx with tab navigation**

Replace `src/App.tsx` entirely:

```tsx
// src/App.tsx
import { useState, useEffect } from 'react';
import { PriceBar } from './components/PriceBar';
import { MarketGrid } from './components/MarketGrid';
import { CandleChart } from './components/CandleChart';
import { SignalPanel } from './components/SignalPanel';
import { BacktestTab } from './components/BacktestTab';
import { NotificationCenter } from './components/Notification';
import { connectSSE } from './services/api';
import { BarChart2, Activity } from 'lucide-react';

type Tab = 'trading' | 'backtest';

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('trading');

  useEffect(() => {
    const disconnect = connectSSE();
    return disconnect;
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <PriceBar />

      {/* Tab Navigation */}
      <div className="flex items-center gap-1 px-4 pt-3 border-b border-gray-800">
        {([
          { id: 'trading' as Tab, icon: Activity, label: 'Live Trading' },
          { id: 'backtest' as Tab, icon: BarChart2, label: 'Backtesting' },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-t border-b-2 transition-colors -mb-px ${
              activeTab === tab.id
                ? 'text-white border-blue-500 bg-gray-900'
                : 'text-gray-400 border-transparent hover:text-gray-200'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <main className="flex-1 overflow-y-auto">
        {activeTab === 'trading' ? (
          <>
            <div className="grid grid-cols-2 gap-4 p-4">
              <CandleChart />
              <SignalPanel />
            </div>
            <div className="border-t border-gray-800">
              <MarketGrid />
            </div>
          </>
        ) : (
          <BacktestTab />
        )}
      </main>

      <NotificationCenter />
    </div>
  );
}
```

**Step 3: Test in browser**

```bash
npm run dev
```

Open http://localhost:5174, click "Backtesting" tab. Verify:
- Data Manager grid loads
- Job Form shows multi-selects
- Job Queue shows empty state

**Step 4: Commit**

```bash
git add src/components/BacktestTab.tsx src/App.tsx
git commit -m "feat(app): add Backtesting tab with full layout integration"
```

---

## Phase 11: End-to-End Test

### Task 20: Full integration test

**Step 1: Start the server**

```bash
npm run dev
```

**Step 2: Trigger a small download (fast)**

```bash
curl -X POST http://localhost:3001/api/backtest/download \
  -H "Content-Type: application/json" \
  -d '{"coins":["BTC"],"timeframes":["1h","4h","1d"]}'
```

Wait ~30 seconds. Then check:

```bash
curl http://localhost:3001/api/backtest/db-status
```
Expected: `{"status":{"BTC":{"1h":{...},"4h":{...},"1d":{...}}},"downloadRunning":false}`

**Step 3: Submit a backtest job**

```bash
curl -X POST http://localhost:3001/api/backtest/run \
  -H "Content-Type: application/json" \
  -d '{"coins":["BTC"],"timeframes":["1h"],"signalModes":["threshold"],"thresholdMin":6}'
```
Note the `jobId` in the response.

**Step 4: Poll job status**

```bash
# Replace bt_xxx with actual jobId
curl http://localhost:3001/api/backtest/jobs/bt_xxx
```
Expected: status changes from `pending` → `running` → `completed`

**Step 5: Check result**

```bash
curl http://localhost:3001/api/backtest/jobs/bt_xxx | node -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const j=JSON.parse(d);
    if(j.result) console.log('Win Rate:', (j.result.summary.winRate*100).toFixed(1)+'%',
      'Trades:', j.result.summary.totalTrades)
  })"
```

**Step 6: Test in UI**

1. Click "Backtesting" tab
2. Click "Download All (6mo)" — verify progress updates in SSE
3. Configure job form: select BTC, 1h, threshold mode, click Run
4. Watch Job Queue: job appears as pending → running with progress bar
5. Wait for completion — toast notification fires
6. Click job → Results Dashboard shows metrics, equity curve, heatmap, trade log

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat: complete backtesting platform with download, jobs, results, playback, notifications"
```

---

## Summary of All New Files

| File | Purpose |
|---|---|
| `server/db.ts` | SQLite setup, schema, bulk insert, query helpers |
| `server/historical.ts` | Binance ZIP bulk download + REST API fill |
| `server/backtestEngine.ts` | Core backtesting logic, all strategies, all signal modes |
| `server/backtestWorker.ts` | Worker thread entry point |
| `server/jobQueue.ts` | SQLite-backed job queue + worker_threads pool |
| `server/index.ts` | *(modified)* — new API routes, DB init, SSE events |
| `server/types.ts` | *(modified)* — extended SSEPayload types |
| `src/store.ts` | *(modified)* — backtest state slice |
| `src/services/api.ts` | *(modified)* — backtest SSE handlers + API helpers |
| `src/App.tsx` | *(modified)* — tab navigation |
| `src/components/Notification.tsx` | Global toast system |
| `src/components/BacktestTab.tsx` | Tab shell |
| `src/components/backtest/DataManager.tsx` | Download status grid |
| `src/components/backtest/JobForm.tsx` | Multi-select config form |
| `src/components/backtest/JobList.tsx` | Live job queue panel |
| `src/components/backtest/ResultsDashboard.tsx` | Results container + tabs |
| `src/components/backtest/MetricsGrid.tsx` | Sortable/filterable metrics table |
| `src/components/backtest/HeatMap.tsx` | Coin × Timeframe win rate heatmap |
| `src/components/backtest/EquityCurve.tsx` | lightweight-charts equity curve |
| `src/components/backtest/TradeLog.tsx` | Filterable paginated trade log |

## ML-Readiness Notes

- Every trade record in `result.trades` includes `rawFeatures` with all indicator values at signal time
- Export endpoint: `GET /api/backtest/export/:id?format=csv`
- SQLite schema is stable and can be queried directly with any SQLite client
- Add new strategies by adding to `scoreStrategies()` and `backtestEngine.ts` — no other changes needed
- Add new signal modes by adding a case to the `for (const mode of config.signalModes)` loop in `runBacktestForPair()`
