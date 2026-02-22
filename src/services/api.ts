import { useStore } from '../store';
import { playTradeOpen, playTradeClose } from '../utils/sound';

export function connectSSE() {
  const store = useStore.getState();
  let es: EventSource | null = null;
  let retryTimeout: number | null = null;

  function connect() {
    es = new EventSource('/api/stream');

    es.onopen = () => {
      store.setConnected(true);
      console.log('[SSE] Connected');
    };

    es.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { setMarkets, setBtcData, setSignals, setRtdsPrice } = useStore.getState();

        switch (payload.type) {
          case 'markets':
            setMarkets(payload.data);
            break;
          case 'btc':
            setBtcData(payload.data);
            break;
          case 'signals':
            setSignals(payload.data);
            break;
          case 'rtds':
            setRtdsPrice(payload.data.asset, payload.data.price);
            break;

        case 'backtest_job_update': {
          const { jobId, status, progress, error } = payload.data as any;
          const { upsertBacktestJob, addNotification } = useStore.getState();
          upsertBacktestJob({
            id: jobId,
            status: status ?? 'pending',
            progress: progress ?? 0,
            config: { coins: [], timeframes: [], signalModes: [] },
            createdAt: Date.now(),
            completedAt: null,
          });
          if (status === 'failed') {
            addNotification(`Backtest ${jobId.slice(0, 12)} failed: ${error ?? 'unknown error'}`, 'error');
          }
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
            id: jobId,
            status: 'completed',
            progress: 100,
            config: { coins: [], timeframes: [], signalModes: [] },
            createdAt: Date.now(),
            completedAt: Date.now(),
            summary: result,
          });
          const wr = result?.winRate != null ? `${(result.winRate * 100).toFixed(1)}%` : 'N/A';
          const pnl = result?.totalPnl != null ? `$${result.totalPnl.toFixed(2)}` : 'N/A';
          addNotification(`✓ Backtest complete — Win Rate: ${wr} | P&L: ${pnl}`, 'success');
          break;
        }

        case 'paper_update': {
          const { positions, pnl } = payload.data as any;
          const { setPaperPositions, setPaperPnl, paperPositions, soundMuted } = useStore.getState();
          if (positions && !soundMuted) {
            const prevOpen = paperPositions.filter((p: any) => p.status === 'OPEN').length;
            const nextOpen = (positions as any[]).filter((p: any) => p.status === 'OPEN').length;
            if (nextOpen > prevOpen) playTradeOpen();
            else if (nextOpen < prevOpen) playTradeClose();
          }
          if (positions) setPaperPositions(positions);
          if (pnl) setPaperPnl(pnl);
          break;
        }

        case 'strategy_config_update': {
          useStore.getState().setStrategyConfigs(payload.data);
          break;
        }

        case 'trade_size_update': {
          const { type, value } = payload.data as { type: 'fixed' | 'percent'; value: number };
          useStore.getState().setTradeSizeSettings(type, value);
          break;
        }

        case 'eth_candles': {
          const { candles5m, candles15m } = payload.data as any;
          useStore.getState().setEthCandles(candles5m, candles15m);
          break;
        }

        case 'eth_signals': {
          useStore.getState().setEthSignals(payload.data);
          break;
        }

        case 'sol_candles': {
          const { candles5m } = payload.data as any;
          useStore.getState().setSolCandles(candles5m);
          break;
        }

        case 'sol_signals': {
          useStore.getState().setSolSignals(payload.data);
          break;
        }
        case 'xrp_signals': {
          useStore.getState().setXrpSignals(payload.data);
          break;
        }
        }
      } catch (err) {
        console.warn('[SSE] Parse error:', err);
      }
    };

    es.onerror = () => {
      store.setConnected(false);
      es?.close();
      // Reconnect after 3s
      retryTimeout = window.setTimeout(connect, 3000);
    };
  }

  connect();

  return () => {
    if (retryTimeout) clearTimeout(retryTimeout);
    es?.close();
    store.setConnected(false);
  };
}

export async function fetchOrderBook(tokenId: string) {
  const res = await fetch(`/api/market/${tokenId}/book`);
  if (!res.ok) throw new Error('Failed to fetch orderbook');
  return res.json();
}

// ─── Backtest API helpers ───

export async function fetchDbStatus() {
  const res = await fetch('/api/backtest/db-status');
  if (!res.ok) throw new Error('Failed to fetch DB status');
  return res.json();
}

export async function triggerDownload(coins: string[], timeframes: string[], months = 36) {
  const res = await fetch('/api/backtest/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coins, timeframes, months }),
  });
  return res.json();
}

export async function trigger1sDownload(coins: string[], months = 36) {
  const res = await fetch('/api/backtest/download-1s', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coins, months }),
  });
  return res.json();
}

export async function triggerDerive10m(coins: string[]) {
  const res = await fetch('/api/backtest/derive-10m', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coins }),
  });
  return res.json();
}

export async function fetchCandles(symbol: string, timeframe: string, limit = 500, endMs?: number) {
  const params = new URLSearchParams({ symbol, timeframe, limit: String(limit) });
  if (endMs) params.set('endMs', String(endMs));
  const res = await fetch(`/api/candles?${params}`);
  if (!res.ok) throw new Error('Failed to fetch candles');
  return res.json() as Promise<{ symbol: string; timeframe: string; candles: Array<{
    symbol: string; timeframe: string; open_time: number;
    open: number; high: number; low: number; close: number; volume: number;
  }> }>;
}

export async function submitBacktestJob(config: object) {
  const res = await fetch('/api/backtest/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error('Failed to submit backtest job');
  return res.json();
}

export async function fetchBacktestJobs() {
  const res = await fetch('/api/backtest/jobs');
  if (!res.ok) throw new Error('Failed to fetch jobs');
  return res.json();
}

export async function fetchBacktestJob(id: string) {
  const res = await fetch(`/api/backtest/jobs/${id}`);
  if (!res.ok) throw new Error('Failed to fetch job');
  return res.json();
}

export async function deleteBacktestJob(id: string) {
  const res = await fetch(`/api/backtest/jobs/${id}`, { method: 'DELETE' });
  return res.json();
}

// ─── Paper Trading API helpers ───

export async function fetchPaperPositions() {
  const res = await fetch('/api/positions');
  if (!res.ok) throw new Error('Failed to fetch positions');
  return res.json();
}

export async function fetchPaperPnl() {
  const res = await fetch('/api/pnl');
  if (!res.ok) throw new Error('Failed to fetch PnL');
  return res.json();
}

export async function fetchPaperTrades() {
  const res = await fetch('/api/trades');
  if (!res.ok) throw new Error('Failed to fetch trades');
  return res.json();
}

export async function closePaperTrade(id: string, exitPrice: number) {
  const res = await fetch(`/api/trade/paper/${id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exitPrice }),
  });
  return res.json();
}

export async function resetPaperTrading() {
  const res = await fetch('/api/paper/reset', { method: 'DELETE' });
  return res.json();
}

// ─── Strategy Config API helpers ───

export async function fetchStrategyConfigs() {
  const res = await fetch('/api/strategy/config');
  if (!res.ok) throw new Error('Failed to fetch strategy configs');
  return res.json();
}

export async function setStrategyEnabled(strategyId: number, coin: string, enabled: boolean) {
  const res = await fetch(`/api/strategy/config/${strategyId}/${coin}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return res.json();
}

export async function fetchTradeSizeSettings() {
  const res = await fetch('/api/settings/trade-size');
  if (!res.ok) throw new Error('Failed to fetch trade size settings');
  return res.json() as Promise<{ type: 'fixed' | 'percent'; value: number }>;
}

export async function saveTradeSizeSettings(type: 'fixed' | 'percent', value: number) {
  const res = await fetch('/api/settings/trade-size', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, value }),
  });
  return res.json();
}

export async function fetchMinConfidence(): Promise<number> {
  const res = await fetch('/api/settings/min-confidence');
  const d = await res.json();
  return d.minConfidence ?? 65;
}

export async function saveMinConfidence(value: number): Promise<void> {
  await fetch('/api/settings/min-confidence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}
