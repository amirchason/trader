import { useStore } from '../store';

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
          const { setPaperPositions, setPaperPnl } = useStore.getState();
          if (positions) setPaperPositions(positions);
          if (pnl) setPaperPnl(pnl);
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

export async function triggerDownload(coins: string[], timeframes: string[]) {
  const res = await fetch('/api/backtest/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coins, timeframes }),
  });
  return res.json();
}

export async function trigger1sDownload(coins: string[]) {
  const res = await fetch('/api/backtest/download-1s', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coins }),
  });
  return res.json();
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
