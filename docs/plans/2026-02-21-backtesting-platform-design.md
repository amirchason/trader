# Backtesting Platform Design
**Date:** 2026-02-21
**Project:** Polymarket Binary Trading Dashboard
**Feature:** Full Backtesting Tab with Analytics, Background Jobs, Real-Time Playback

---

## Overview

Add a comprehensive backtesting platform as a new **Backtesting** tab in the existing trading dashboard. The platform will:

1. Download 6 months of OHLCV data for BTC, ETH, SOL, XRP across 6 timeframes
2. Store all data in SQLite on the server
3. Let users configure and submit multiple simultaneous backtest jobs
4. Run jobs in the background using worker_threads (true CPU parallelism)
5. Stream real-time candle playback + trade signals during execution
6. Show a full analytics dashboard with metrics, equity curve, heatmap, trade log
7. Send toast notifications when jobs complete (regardless of active tab)
8. Produce ML-ready output with raw indicator values per trade

---

## Architecture

### System Diagram

```
Browser (any tab)
     │   SSE events: backtest_candle, backtest_trade, backtest_progress, backtest_complete
     ▼
Express Server
  ├─ POST /api/backtest/download    → triggers ZIP bulk download + REST API fill
  ├─ GET  /api/backtest/db-status   → candle count per coin/timeframe
  ├─ POST /api/backtest/run         → enqueue job → returns jobId immediately
  ├─ GET  /api/backtest/jobs        → list all jobs + status
  ├─ GET  /api/backtest/jobs/:id    → full result JSON
  ├─ DELETE /api/backtest/jobs/:id  → delete job
  └─ GET  /api/backtest/export/:id  → ML-ready CSV/JSON export

  Job Queue (SQLite-backed, zero Redis)
  ├─ Max 3 concurrent jobs
  └─ Each job → worker_threads pool
       ├─ Worker A: BTC × 5m      ← Float64Array bulk processing
       ├─ Worker B: ETH × 5m
       ├─ Worker C: SOL × 5m      ← true CPU parallelism
       └─ Worker D: XRP × 1h

  SQLite DB (trader.db, WAL mode)
  ├─ candles (symbol, timeframe, open_time, open, high, low, close, volume)
  └─ backtest_jobs (id, config, status, progress, result, error, timestamps)
```

### Data Download: Hybrid Two-Stage

**Stage 1 — Bulk via data.binance.vision (4-8 min total)**
- Downloads monthly ZIP CSVs: `https://data.binance.vision/data/spot/monthly/klines/{SYMBOL}/{INTERVAL}/{SYMBOL}-{INTERVAL}-{YEAR}-{MONTH}.zip`
- p-limit concurrency=5 for parallel downloads
- Parses CSV → bulk inserts into SQLite (250K rows/sec)

**Stage 2 — Incremental via Binance REST API**
- Fills gap from last stored timestamp to now
- Rate-limited: 200ms between requests, max 600 req/min
- Runs on-demand or scheduled daily

### Bulk Processing (key design point)

Each backtesting worker:
1. Loads all candles as `Float64Array` typed arrays (no object overhead)
2. Calculates all indicators (RSI, SMA, VWAP, MACD, momentum) in vectorized loops
3. Evaluates each signal mode in batch
4. Streams results back via parentPort → main thread → SSE

---

## Data Model

### SQLite Schema

```sql
-- Candles (WAL mode, WITHOUT ROWID for maximum performance)
CREATE TABLE candles (
  symbol    TEXT    NOT NULL,   -- 'BTC', 'ETH', 'SOL', 'XRP'
  timeframe TEXT    NOT NULL,   -- '1m', '5m', '15m', '1h', '4h', '1d'
  open_time INTEGER NOT NULL,   -- Unix ms
  open      REAL    NOT NULL,
  high      REAL    NOT NULL,
  low       REAL    NOT NULL,
  close     REAL    NOT NULL,
  volume    REAL    NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time)
) WITHOUT ROWID;

CREATE INDEX idx_candle_range ON candles(symbol, timeframe, open_time);

-- Backtest jobs
CREATE TABLE backtest_jobs (
  id           TEXT PRIMARY KEY,
  config       TEXT NOT NULL,   -- JSON
  status       TEXT NOT NULL,   -- pending|running|completed|failed
  progress     INTEGER DEFAULT 0,
  result       TEXT,            -- JSON
  error        TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_jobs_status ON backtest_jobs(status, created_at);
```

### Job Config JSON

```json
{
  "coins": ["BTC", "ETH", "SOL", "XRP"],
  "timeframes": ["5m", "15m", "1h"],
  "strategies": ["all", "momentum_burst", "mean_reversion", "funding_rate", "order_book", "vwap"],
  "signalModes": ["threshold", "crossover", "every_candle", "combined"],
  "thresholdMin": 7,
  "initialCapital": 100,
  "dateRange": { "from": 1700000000000, "to": 1740000000000 }
}
```

### Job Result JSON (ML-Ready)

```json
{
  "summary": {
    "totalTrades": 1842, "winRate": 0.624,
    "sharpe": 1.91, "maxDrawdown": 0.14,
    "pnl": 1247.80, "profitFactor": 2.1
  },
  "byStrategy": { "momentum_burst": {...}, "combined": {...} },
  "byCoin": { "BTC": {...}, "ETH": {...} },
  "byTimeframe": { "5m": {...}, "1h": {...} },
  "equityCurve": [{ "time": 1700000000, "equity": 10000 }],
  "trades": [{
    "time": 1700000000, "coin": "BTC", "interval": "5m",
    "signal": "BULL", "result": "WIN", "pnl": 12.50,
    "rawFeatures": { "rsi": 28.4, "macd": 0.003, "vwapDev": -0.012, "momentum": 0.85 }
  }]
}
```

---

## SSE Events (Real-Time Playback)

Extended on the existing `/api/stream` SSE pipe:

| Event Type | Payload | Purpose |
|---|---|---|
| `backtest_candle` | `{ jobId, candle: {t,o,h,l,c,v}, indicators }` | Live chart replay |
| `backtest_trade` | `{ jobId, time, direction, price, strategy }` | Trade marker on chart |
| `backtest_progress` | `{ jobId, percent, processed, total }` | Progress bar update |
| `backtest_job_update` | `{ jobId, status, config }` | Queue panel update |
| `backtest_complete` | `{ jobId, result }` | Toast notification trigger |

---

## Signal Modes (Pluggable, User-Selectable)

| Mode | Description | Extensibility |
|---|---|---|
| `threshold` | Score ≥ N (user slider 1-10) | Adjust N |
| `crossover` | Signal flip bull↔bear only | Filter by magnitude |
| `every_candle` | All candles evaluated | Max data points |
| `combined` | All strategies merged, threshold applied | Add more strategies |
| *(future)* | ML model output | Plug in model score |

---

## Metrics (User-Selectable, Sortable)

- Win Rate %
- Total P&L ($)
- Sharpe Ratio
- Max Drawdown %
- Total Trades
- Profit Factor (gross profit ÷ gross loss)
- Best Coin × Timeframe combo (heatmap)
- Avg Trade Duration
- Consecutive Win/Loss streaks

---

## Frontend UI Layout

```
[Home] [Backtesting]  ← new tab

BACKTESTING TAB:
┌────────────────────────────────────────────────────────────────┐
│ DATA MANAGER                                                    │
│ [BTC 5m ✓ 260k candles] [ETH 5m ✓] [SOL 15m ✓] ...           │
│ [▼ Download All Data]  Progress: 47% ███████░░░ 2.1GB/4.5GB    │
└────────────────────────────────────────────────────────────────┘
┌──────────────────────┐  ┌──────────────────────────────────────┐
│ JOB FORM             │  │ JOB QUEUE                            │
│ Coins: [multi-select]│  │ ● Job #3  Running  43%  [cancel]     │
│ Timeframes: [multi]  │  │ ○ Job #4  Pending                    │
│ Strategies: [multi]  │  │ ✓ Job #2  Complete  [view] [delete]  │
│ Signal Mode: [multi] │  │ ✗ Job #1  Failed   [retry] [delete]  │
│ Threshold: ━━●━━ 7   │  └──────────────────────────────────────┘
│ Capital: $[100]      │
│ Date range: [6m ▼]   │
│ [▶ Run Backtest]     │
└──────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ RESULTS DASHBOARD (Job #2 selected)                            │
│ Show: [Win Rate ✓][P&L ✓][Sharpe ✓][Drawdown ✓][Trades ✓]    │
│ Sort: [Win Rate ▼]   Filter: [All coins ▼][All timeframes ▼]  │
│                                                                │
│ ┌────────────────────┐  ┌──────────────────────────────────┐  │
│ │ METRICS GRID       │  │ EQUITY CURVE (lightweight-charts) │  │
│ │ Win Rate:  62.4%   │  │  $14,247 ╭──────╮               │  │
│ │ P&L:    +$1,247    │  │          │       ╰──────────────  │  │
│ │ Sharpe:    1.91    │  │ $10,000  ┴─────────────────────  │  │
│ │ Drawdown:  14.2%   │  └──────────────────────────────────┘  │
│ │ Trades:    1,842   │                                         │
│ └────────────────────┘                                         │
│                                                                │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ WIN RATE HEATMAP: Coin × Timeframe                         │ │
│ │         1m    5m    15m   1h    4h    1d                   │ │
│ │ BTC   58%   72%   65%   61%   55%   49%                    │ │
│ │ ETH   52%   68%   63%   59%   51%   45%                    │ │
│ │ SOL   61%   74%   69%   64%   58%   50%                    │ │
│ │ XRP   49%   61%   57%   54%   48%   42%                    │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ PLAYBACK CHART (during running job)                        │ │
│ │ [Live candlestick chart + trade markers]                   │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                │
│ ┌────────────────────────────────────────────────────────────┐ │
│ │ TRADE LOG  [Filter: coin▼ timeframe▼ result▼ strategy▼]   │ │
│ │ Time       Coin  TF   Signal  Result  P&L    Strategy      │ │
│ │ 2025-08-01 BTC   5m   BULL    WIN    +$14.2  momentum      │ │
│ └────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘

[Toast: "✓ Backtest #3 Complete — Win Rate: 72.4% (+$2,841)"]
```

---

## File Map

### New Server Files
- `server/db.ts` — SQLite init, WAL mode, schema creation, bulk insert helpers
- `server/historical.ts` — Stage 1 ZIP download + Stage 2 REST API fill, p-limit concurrency
- `server/backtestEngine.ts` — Float64Array batch engine, all 5 strategies + combined, all signal modes
- `server/backtestWorker.ts` — worker_thread entry point, streams progress via parentPort
- `server/jobQueue.ts` — SQLite-backed job queue, worker pool (max 3 concurrent)

### Modified Server Files
- `server/index.ts` — Add `/api/backtest/*` routes, broadcast backtest SSE events

### New Frontend Files
- `src/components/BacktestTab.tsx` — Tab shell, layout manager
- `src/components/backtest/DataManager.tsx` — Per-coin/timeframe download status grid, progress
- `src/components/backtest/JobForm.tsx` — Multi-select coins/timeframes/strategies/signal modes, threshold slider, date range, capital input
- `src/components/backtest/JobList.tsx` — Live queue panel, pulsing active indicator, cancel/delete/retry
- `src/components/backtest/ResultsDashboard.tsx` — Results container, metric toggles, sort/filter controls
- `src/components/backtest/EquityCurve.tsx` — lightweight-charts equity curve + live updates
- `src/components/backtest/MetricsGrid.tsx` — Sortable metrics table
- `src/components/backtest/HeatMap.tsx` — Coin × Timeframe win rate color grid
- `src/components/backtest/PlaybackChart.tsx` — Live candlestick replay during job execution
- `src/components/backtest/TradeLog.tsx` — Filterable/sortable trade log table
- `src/components/Notification.tsx` — Global toast notification system

### Modified Frontend Files
- `src/App.tsx` — Add Backtesting tab to navigation
- `src/store.ts` — Add backtest state slice (jobs, selected job, db status, notifications)
- `src/services/api.ts` — Add backtest API calls + new SSE event handlers

---

## New Dependencies

```json
{
  "better-sqlite3": "^9.x",
  "@types/better-sqlite3": "^9.x",
  "unzipper": "^0.10.x",
  "csv-parse": "^5.x",
  "p-limit": "^5.x"
}
```

---

## ML Compatibility

- All trade records include `rawFeatures` object with every indicator value at signal time
- SQLite makes data trivially exportable to CSV/pandas
- Export endpoint: `GET /api/backtest/export/:id?format=json|csv`
- Schema is versioned, extensible — new indicators = new fields in `rawFeatures`

---

## Approved by user: 2026-02-21
