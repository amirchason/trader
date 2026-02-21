/**
 * HTTP client for the Trader Express API (localhost:3001).
 * The MCP server calls these functions to proxy requests.
 */

const BASE = process.env.TRADER_API_URL ?? 'http://localhost:3001';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ─────────────────── Market Data ───────────────────

export const getHealth = () => get<unknown>('/api/health');
export const getSignals = () => get<unknown>('/api/signals');
export const getMarkets = () => get<unknown>('/api/markets');
export const getBtcData = () => get<unknown>('/api/btc');
export const getOrderBook = (tokenId: string) => get<unknown>(`/api/market/${tokenId}/book`);
export const getCandles = (symbol: string, interval: string, limit: number) =>
  get<unknown>(`/api/btc`).then((d: any) => {
    const key = `candles${interval.replace('m', 'm').replace('h', 'h').replace('d', 'd').replace('s', 's')}` as keyof typeof d;
    const all = (d as any)[key] ?? [];
    return all.slice(-limit);
  });

// ─────────────────── Paper Trading ───────────────────

export const getPositions = () => get<unknown>('/api/positions');
export const getTrades = () => get<unknown>('/api/trades');
export const getPnl = () => get<unknown>('/api/pnl');

export const placePaperTrade = (body: {
  marketId: string; marketQ?: string; asset?: string;
  direction: 'YES' | 'NO'; entryPrice: number; size: number;
  reason?: string; strategy?: string; confidence?: number;
}) => post<unknown>('/api/trade/paper', body);

export const closePaperTrade = (tradeId: string, exitPrice: number) =>
  post<unknown>(`/api/trade/paper/${tradeId}/close`, { exitPrice });

// ─────────────────── Backtesting ───────────────────

export const getDbStatus = () => get<unknown>('/api/backtest/db-status');
export const downloadData = (coins?: string[], timeframes?: string[]) =>
  post<unknown>('/api/backtest/download', { coins, timeframes });
export const runBacktest = (config: unknown) => post<unknown>('/api/backtest/run', config);
export const getBacktestJobs = () => get<unknown>('/api/backtest/jobs');
export const getBacktestJob = (jobId: string) => get<unknown>(`/api/backtest/jobs/${jobId}`);
export const deleteBacktestJob = (jobId: string) => del<unknown>(`/api/backtest/jobs/${jobId}`);
export const exportBacktest = (jobId: string, format: 'json' | 'csv' = 'json') =>
  get<unknown>(`/api/backtest/export/${jobId}?format=${format}`);
