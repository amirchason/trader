# Trader — AI Agent Guide

Polymarket binary options trading dashboard with real-time signals, paper trading, and backtesting.
React 18 + TypeScript frontend, Express + Node.js backend, SQLite for persistence.

## How to Run

```bash
npm run dev          # Frontend (port 5174) + Backend API (port 3001) concurrently
npm run dev:server   # Backend only
npm run dev:client   # Frontend only
npm run mcp          # MCP server (requires dev:server running first)
```

MCP server requires the Express API to be running on port 3001 first.

## Architecture

```
src/                    ← React frontend (Vite + Tailwind)
  App.tsx               ← Root component, tab routing
  store.ts              ← Zustand state (markets, btcData, signals, rtdsPrices)
  services/api.ts       ← SSE connection + REST calls
  components/
    PriceBar.tsx        ← Live prices header
    CandleChart.tsx     ← OHLCV chart (lightweight-charts)
    SignalPanel.tsx      ← Strategy signals display
    MarketGrid.tsx      ← Binary markets table

server/                 ← Express backend (Node.js + TypeScript)
  index.ts              ← Main server, all REST routes, SSE broadcaster, polling loops
  types.ts              ← Shared TypeScript interfaces
  markets.ts            ← Polymarket Gamma API → BinaryMarket[]
  prices.ts             ← Binance REST API (candles, orderbook, funding, price)
  indicators.ts         ← Technical analysis (RSI, MACD, VWAP, momentum, scoreStrategies)
  rtds.ts               ← Polymarket WebSocket (real-time prices for BTC/ETH/SOL/XRP)
  db.ts                 ← SQLite (trader.db): candles + backtest_jobs tables
  historical.ts         ← Download 6mo OHLCV from Binance data.binance.vision
  backtestEngine.ts     ← Core backtesting logic (runBacktestForPair, aggregateResults)
  backtestWorker.ts     ← worker_threads entry point for parallel backtests
  jobQueue.ts           ← SQLite-backed job queue (max 3 concurrent workers)
  paper-trading.ts      ← Paper trading engine (paper_trades table in trader.db)

mcp-server/             ← MCP server (AI agent interface)
  index.ts              ← McpServer with all 16 tools registered
  client.ts             ← HTTP client proxying to Express API

docs/plans/             ← Design docs (approved specs)
trader.db               ← SQLite database (auto-created on first run)
```

## Data Flow

```
Binance REST ──────► server/prices.ts ──► getFullBtcData()
Polymarket Gamma ──► server/markets.ts ──► fetchBinaryMarkets()
Polymarket RTDS ───► server/rtds.ts ────► real-time prices (WebSocket)
                          │
                    server/index.ts
                    ├─ polling loops (5s BTC, 10s markets)
                    ├─ broadcast() → SSE clients
                    └─ REST endpoints
                          │
               src/services/api.ts ← SSE stream
                    ├─ store.ts (Zustand)
                    └─ React components re-render
```

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stream` | GET SSE | Real-time event stream (markets, btc, signals, rtds, backtest_*) |
| `/api/markets` | GET | Cached binary markets |
| `/api/btc` | GET | Cached BTC OHLCV + indicators + funding + orderbook |
| `/api/signals` | GET | Strategy signals (5 strategies, verdict, indicators) |
| `/api/market/:tokenId/book` | GET | Polymarket order book |
| `/api/health` | GET | Server status |
| `/api/trade/paper` | POST | Open paper trade |
| `/api/trade/paper/:id/close` | POST | Close paper trade |
| `/api/positions` | GET | Open paper positions |
| `/api/trades` | GET | Full trade history |
| `/api/pnl` | GET | P&L summary |
| `/api/backtest/db-status` | GET | Historical candle counts |
| `/api/backtest/download` | POST | Download 6mo data (async, SSE progress) |
| `/api/backtest/run` | POST | Submit backtest job → jobId |
| `/api/backtest/jobs` | GET | List all jobs |
| `/api/backtest/jobs/:id` | GET | Job result |
| `/api/backtest/jobs/:id` | DELETE | Delete job |
| `/api/backtest/export/:id` | GET | CSV/JSON export |

## MCP Tools (AI Agent Interface)

The MCP server (`npm run mcp`) exposes these tools to Claude Code:

**Market data:** `get_health`, `get_live_signals`, `get_active_markets`, `get_candles`, `get_order_book`

**Paper trading:** `place_paper_trade`, `close_paper_trade`, `get_positions`, `get_trade_log`, `get_pnl`

**Backtesting:** `get_db_status`, `download_historical_data`, `run_backtest`, `get_backtest_jobs`, `get_backtest_result`, `delete_backtest_job`, `export_backtest`

Example agent workflow:
```
1. get_live_signals          → check current strategy confidence
2. get_active_markets        → find matching BTC 5m binary market
3. place_paper_trade         → record decision with reasoning
4. get_pnl                   → review performance
5. run_backtest              → test strategy variations
6. get_backtest_result       → compare Sharpe ratio / win rate
```

## Key Patterns

**Adding a new REST endpoint:** Add to `server/index.ts` in the appropriate section.

**Adding a new MCP tool:** Add `server.registerTool(...)` call in `mcp-server/index.ts` and a corresponding API call in `mcp-server/client.ts`.

**Adding new state to frontend:** Add to `store.ts` Zustand store, then handle in `src/services/api.ts` SSE handler.

**Adding a new SSE event type:** Add to `SSEPayload` type in `server/types.ts`, broadcast in `server/index.ts`, handle in `src/services/api.ts`.

**Strategy signals:** All signal scoring is in `server/indicators.ts → scoreStrategies()`. Each strategy returns score (0-10), direction, and confidence (0-100).

## SQLite Database (`trader.db`)

Three tables (auto-created on startup):
- `candles` — historical OHLCV (symbol, timeframe, open_time, ohlcv)
- `backtest_jobs` — job queue (id, config, status, progress, result, error, timestamps)
- `paper_trades` — paper trading log (id, market_id, direction, entry_price, pnl, etc.)

## Environment Variables

```
PORT=3001              # Express server port (default: 3001)
TRADER_API_URL=...     # MCP server → API URL (default: http://localhost:3001)
```

No API keys required — uses public Binance and Polymarket APIs.

## Coding Conventions

- TypeScript strict mode, no `any` unless unavoidable
- Functional React components only, no class components
- Tailwind CSS for all styling (no CSS files except `index.css` base)
- Server files use CommonJS module system (ts-node)
- MCP server uses `tsconfig.mcp.json` (moduleResolution: bundler for SDK compat)
- All async errors caught and returned as `{ error: string }`
- SQLite via `better-sqlite3` (sync API), accessed via `server/db.ts → getDb()`

## Phase Roadmap

- **Done:** Live dashboard, signals, paper trading, backtesting engine, MCP server
- **Next:** Agent console UI (floating draggable window in frontend)
- **Phase 2:** 24/7 autonomous agent loop (`agent/loop.ts`)
- **Phase 3:** Real trade execution via Polymarket CLOB API
