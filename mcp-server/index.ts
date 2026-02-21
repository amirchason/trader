/**
 * Trader MCP Server
 *
 * Exposes all trading platform functions as MCP tools so Claude Code
 * (and any MCP-compatible agent) can interactively control the platform.
 *
 * Registered tools:
 *   Market data:   get_health, get_live_signals, get_active_markets, get_candles, get_order_book
 *   Paper trading: place_paper_trade, close_paper_trade, get_positions, get_trade_log, get_pnl
 *   Backtesting:   get_db_status, download_historical_data, run_backtest, get_backtest_jobs,
 *                  get_backtest_result, delete_backtest_job, export_backtest
 *
 * Usage:
 *   npm run mcp   (requires Express API running on port 3001 first)
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
// Direct CJS paths needed because tsconfig.server.json uses legacy "node" moduleResolution
// which does not support package.json exports maps. skipLibCheck handles any type mismatches.
const { McpServer } = require('@modelcontextprotocol/sdk/dist/cjs/server/mcp.js') as
  typeof import('@modelcontextprotocol/sdk/server/mcp');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/dist/cjs/server/stdio.js') as
  typeof import('@modelcontextprotocol/sdk/server/stdio');

import * as z from 'zod';
import * as api from './client';

const server = new McpServer({ name: 'trader', version: '1.0.0' });

// ─────────────────── Helper ───────────────────

function text(content: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(content, null, 2) }] };
}

async function safe(fn: () => Promise<unknown>) {
  try {
    return text(await fn());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return text({ error: msg, hint: 'Is the Express server running? (npm run dev:server)' });
  }
}

// ─────────────────── Market Data Tools ───────────────────

server.registerTool('get_health', {
  description: 'Check server health: connection status, market count, SSE clients, live prices.',
}, async () => safe(api.getHealth));

server.registerTool('get_live_signals', {
  description: 'Get current BTC strategy signals. Returns 5 strategies (Momentum Burst, Mean Reversion, Funding Squeeze, Order Book Imbalance, VWAP Crossover) each with score 0-10 and confidence 0-100, plus RSI/MACD/VWAP and overall verdict (BULLISH/BEARISH/NEUTRAL).',
}, async () => safe(api.getSignals));

server.registerTool('get_active_markets', {
  description: 'List all active Polymarket binary option markets (BTC/ETH/SOL/XRP, 5m and 15m expiry). Each has yesPrice, noPrice (0-1), volume, liquidity, and epochEnd timestamp.',
}, async () => safe(api.getMarkets));

server.registerTool('get_candles', {
  description: 'Get live BTC OHLCV candles. Available intervals: 10s, 30s, 1m, 5m, 15m, 1h, 4h, 1d.',
  inputSchema: {
    interval: z.enum(['10s', '30s', '1m', '5m', '15m', '1h', '4h', '1d']).describe('Candle interval'),
    limit: z.number().int().min(1).max(500).default(50).describe('Number of most recent candles to return'),
  },
}, async ({ interval, limit }: { interval: string; limit: number }) =>
  safe(() => api.getCandles('BTC', interval, limit)));

server.registerTool('get_order_book', {
  description: 'Get Polymarket CLOB order book for a market token. Use yesTokenId or noTokenId from get_active_markets.',
  inputSchema: {
    tokenId: z.string().describe('Polymarket token ID'),
  },
}, async ({ tokenId }: { tokenId: string }) => safe(() => api.getOrderBook(tokenId)));

// ─────────────────── Paper Trading Tools ───────────────────

server.registerTool('place_paper_trade', {
  description: 'Open a paper trade on a Polymarket binary option. entryPrice is the YES token price (0-1). size is USD amount.',
  inputSchema: {
    marketId: z.string().describe('Market ID from get_active_markets'),
    direction: z.enum(['YES', 'NO']).describe('Buy YES or NO token'),
    entryPrice: z.number().min(0).max(1).describe('Current YES price (0-1)'),
    size: z.number().positive().describe('Position size in USD'),
    marketQ: z.string().optional().describe('Market question text'),
    asset: z.string().optional().describe('Asset (BTC/ETH/SOL/XRP)'),
    reason: z.string().optional().describe('Agent reasoning for this trade decision'),
    strategy: z.string().optional().describe('Strategy that triggered this trade'),
    confidence: z.number().int().min(0).max(100).optional().describe('Signal confidence 0-100'),
  },
}, async (params: {
  marketId: string; direction: 'YES' | 'NO'; entryPrice: number; size: number;
  marketQ?: string; asset?: string; reason?: string; strategy?: string; confidence?: number;
}) => safe(() => api.placePaperTrade(params)));

server.registerTool('close_paper_trade', {
  description: 'Close an open paper trade and calculate P&L based on exit price.',
  inputSchema: {
    tradeId: z.string().describe('Trade ID from place_paper_trade or get_positions'),
    exitPrice: z.number().min(0).max(1).describe('Current YES price (0-1) at close time'),
  },
}, async ({ tradeId, exitPrice }: { tradeId: string; exitPrice: number }) =>
  safe(() => api.closePaperTrade(tradeId, exitPrice)));

server.registerTool('get_positions', {
  description: 'Get all open paper trading positions.',
}, async () => safe(api.getPositions));

server.registerTool('get_trade_log', {
  description: 'Get full paper trading history with P&L for all open and closed trades.',
}, async () => safe(api.getTrades));

server.registerTool('get_pnl', {
  description: 'Get paper trading P&L summary: realized P&L, win rate, win/loss counts.',
}, async () => safe(api.getPnl));

// ─────────────────── Backtesting Tools ───────────────────

server.registerTool('get_db_status', {
  description: 'Check available historical OHLCV candles per coin/timeframe in the local SQLite database.',
}, async () => safe(api.getDbStatus));

server.registerTool('download_historical_data', {
  description: 'Download 6 months of historical OHLCV data from Binance. Required before running backtests. Async — progress streamed via SSE.',
  inputSchema: {
    coins: z.array(z.string()).optional().describe('Coins to download (default: BTC/ETH/SOL/XRP)'),
    timeframes: z.array(z.string()).optional().describe('Timeframes (default: 1m/5m/15m/1h/4h/1d)'),
  },
}, async ({ coins, timeframes }: { coins?: string[]; timeframes?: string[] }) =>
  safe(() => api.downloadData(coins, timeframes)));

server.registerTool('run_backtest', {
  description: 'Submit a backtest job. Returns jobId immediately — poll get_backtest_result for results. Use to optimize strategies by comparing Sharpe ratio / win rate across different parameter combinations.',
  inputSchema: {
    coins: z.array(z.string()).min(1).describe('Coins, e.g. ["BTC","ETH"]'),
    timeframes: z.array(z.string()).min(1).describe('Timeframes, e.g. ["5m","15m"]'),
    strategies: z.array(z.string()).optional().describe('"all","momentum","meanReversion","fundingSqueeze","orderBook","vwap"'),
    signalModes: z.array(z.string()).optional().describe('"threshold","crossover","every_candle","combined"'),
    initialCapital: z.number().positive().optional().describe('Starting capital USD (default: 100)'),
    thresholdMin: z.number().min(0).max(10).optional().describe('Min score 0-10 to trigger trade (default: 7)'),
    fromMs: z.number().optional().describe('Start timestamp ms'),
    toMs: z.number().optional().describe('End timestamp ms'),
  },
}, async (config: unknown) => safe(() => api.runBacktest(config)));

server.registerTool('get_backtest_jobs', {
  description: 'List all backtest jobs with status (pending/running/completed/failed) and progress %.',
}, async () => safe(api.getBacktestJobs));

server.registerTool('get_backtest_result', {
  description: 'Get full results for a completed backtest: equity curve, trade log, per-strategy metrics (win rate, Sharpe ratio, max drawdown, profit factor).',
  inputSchema: {
    jobId: z.string().describe('Job ID from run_backtest or get_backtest_jobs'),
  },
}, async ({ jobId }: { jobId: string }) => safe(() => api.getBacktestJob(jobId)));

server.registerTool('delete_backtest_job', {
  description: 'Delete a completed or failed backtest job from the queue.',
  inputSchema: {
    jobId: z.string().describe('Job ID to delete'),
  },
}, async ({ jobId }: { jobId: string }) => safe(() => api.deleteBacktestJob(jobId)));

server.registerTool('export_backtest', {
  description: 'Export backtest results as JSON or ML-ready CSV (with raw indicator values: RSI, VWAP, MACD, momentum scores).',
  inputSchema: {
    jobId: z.string().describe('Job ID to export'),
    format: z.enum(['json', 'csv']).default('json').describe('Export format'),
  },
}, async ({ jobId, format }: { jobId: string; format: 'json' | 'csv' }) =>
  safe(() => api.exportBacktest(jobId, format)));

// ─────────────────── Start ───────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Trader MCP server ready (stdio transport)');
  console.error('[MCP] 16 tools registered — requires Express API on http://localhost:3001');
}

main().catch((err) => {
  console.error('[MCP] Fatal:', err);
  process.exit(1);
});
