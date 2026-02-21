import express, { Request, Response } from 'express';
import cors from 'cors';
import { fetchBinaryMarkets } from './markets';
import { getFullBtcData, getClobOrderBook } from './prices';
import { scoreStrategies } from './indicators';
import { connectRTDS } from './rtds';
import type { SSEPayload, BinaryMarket, BtcData, StrategyResult } from './types';
import { getDb, getDbStatus } from './db';
import { downloadAllHistoricalData, download1sAndAggregate } from './historical';
import { createJob, getJob, listJobs, deleteJob, resumePendingJobs, setBroadcast } from './jobQueue';
import { openTrade, closeTrade, getOpenPositions, getAllTrades, getPnlSummary, initPaperTradingDb } from './paper-trading';
import { agentChat } from './agent';
import type { ChatMessage } from './agent';

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────── State ───────────────────

let latestMarkets: BinaryMarket[] = [];
let latestBtcData: BtcData | null = null;
let latestSignals: StrategyResult | null = null;
const rtdsPrices: Record<string, number> = {};
let downloadRunning = false;
let download1sRunning = false;

// ─────────────────── SSE Clients ───────────────────

const sseClients = new Set<Response>();

function broadcast(payload: SSEPayload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}
setBroadcast(broadcast as (payload: object) => void);

// ─────────────────── SSE Endpoint ───────────────────

app.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  sseClients.add(res);
  console.log(`[SSE] Client connected (${sseClients.size} total)`);

  // Send current state immediately on connect
  if (latestMarkets.length > 0) {
    res.write(`data: ${JSON.stringify({ type: 'markets', data: latestMarkets, timestamp: Date.now() })}\n\n`);
  }
  if (latestBtcData) {
    res.write(`data: ${JSON.stringify({ type: 'btc', data: latestBtcData, timestamp: Date.now() })}\n\n`);
  }
  if (latestSignals) {
    res.write(`data: ${JSON.stringify({ type: 'signals', data: latestSignals, timestamp: Date.now() })}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
    console.log(`[SSE] Client disconnected (${sseClients.size} total)`);
  });
});

// ─────────────────── REST Endpoints ───────────────────

app.get('/api/markets', (_req: Request, res: Response) => {
  res.json(latestMarkets);
});

app.get('/api/btc', (_req: Request, res: Response) => {
  res.json(latestBtcData || {});
});

app.get('/api/signals', (_req: Request, res: Response) => {
  res.json(latestSignals || {});
});

app.get('/api/market/:tokenId/book', async (req: Request, res: Response) => {
  try {
    const book = await getClobOrderBook(req.params.tokenId);
    res.json(book);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    markets: latestMarkets.length,
    sseClients: sseClients.size,
    rtdsPrices,
    timestamp: new Date().toISOString(),
  });
});

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
  const tfs = (timeframes ?? ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d']) as any[];

  downloadAllHistoricalData(symbols, tfs, (progress) => {
    broadcast({
      type: 'backtest_job_update',
      data: { type: 'download_progress', ...progress },
      timestamp: Date.now(),
    });
  })
    .catch((err) => console.error('[Download] Error:', err))
    .finally(() => { downloadRunning = false; });
});

app.post('/api/backtest/download-1s', async (req: Request, res: Response) => {
  if (download1sRunning) {
    return res.status(409).json({ error: '1s download already in progress' });
  }

  const { coins } = req.body as { coins?: string[] };
  const symbols = (coins ?? ['BTC', 'ETH', 'SOL', 'XRP']).map((c) => `${c}USDT` as any);

  download1sRunning = true;
  res.json({ started: true, note: '1s data for 6 months ~3-4h via REST API; 10s and 30s derived automatically' });

  download1sAndAggregate(symbols, (progress) => {
    broadcast({
      type: 'backtest_job_update',
      data: { type: 'download_1s_progress', ...progress },
      timestamp: Date.now(),
    });
  })
    .catch((err) => console.error('[Download1s] Error:', err))
    .finally(() => { download1sRunning = false; });
});

app.get('/api/backtest/download-status', (_req: Request, res: Response) => {
  res.json({ downloadRunning, download1sRunning });
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
    res.json(listJobs());
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

    const format = (req.query.format as string) ?? 'json';
    if (format === 'csv') {
      const trades = job.result.trades as any[];
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
      return res.send(csv);
    }
    res.json(job.result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────── AI Agent Route ───────────────────

app.post('/api/agent/chat', async (req: Request, res: Response) => {
  try {
    const { message, history = [] } = req.body as {
      message: string;
      history: ChatMessage[];
    };

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message required' });
    }

    // Cap history to last 20 messages to keep prompt size manageable
    const cappedHistory = (history as ChatMessage[]).slice(-20);

    const result = await agentChat(message, cappedHistory);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─────────────────── Paper Trading Routes ───────────────────

app.post('/api/trade/paper', (req: Request, res: Response) => {
  try {
    const { marketId, marketQ, asset, direction, entryPrice, size, reason, strategy, confidence } = req.body;
    if (!marketId || !direction || !size || !entryPrice) {
      return res.status(400).json({ error: 'marketId, direction, entryPrice, size required' });
    }
    const trade = openTrade({
      market_id: marketId,
      market_q: marketQ ?? '',
      asset: asset ?? 'BTC',
      direction,
      entry_price: entryPrice,
      size,
      reason,
      strategy,
      confidence,
    });
    res.json(trade);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/trade/paper/:id/close', (req: Request, res: Response) => {
  try {
    const { exitPrice } = req.body;
    if (exitPrice === undefined) return res.status(400).json({ error: 'exitPrice required' });
    const trade = closeTrade(req.params.id, exitPrice);
    if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' });
    res.json(trade);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/positions', (_req: Request, res: Response) => {
  try { res.json(getOpenPositions()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/trades', (_req: Request, res: Response) => {
  try { res.json(getAllTrades()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/pnl', (_req: Request, res: Response) => {
  try { res.json(getPnlSummary()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─────────────────── Polling Loops ───────────────────

async function pollMarkets() {
  try {
    const markets = await fetchBinaryMarkets();
    latestMarkets = markets;
    broadcast({ type: 'markets', data: markets, timestamp: Date.now() });
    console.log(`[Markets] Updated: ${markets.length} binary markets`);
  } catch (err) {
    console.error('[Markets] Poll error:', err);
  }
}

async function pollBtcData() {
  try {
    const btcData = await getFullBtcData();
    latestBtcData = btcData;

    // Compute strategy signals
    const signals = scoreStrategies(
      btcData.candles5m,
      btcData.candles1m,
      btcData.funding,
      btcData.orderBook,
    );
    latestSignals = signals;

    broadcast({ type: 'btc', data: btcData, timestamp: Date.now() });
    broadcast({ type: 'signals', data: signals, timestamp: Date.now() });
  } catch (err) {
    console.error('[BTC] Poll error:', err);
  }
}

// ─────────────────── RTDS Integration ───────────────────

const cleanupRTDS = connectRTDS((update) => {
  rtdsPrices[update.asset] = update.price;
  broadcast({ type: 'rtds', data: update, timestamp: Date.now() });
});

// ─────────────────── Start ───────────────────

// Initial fetch
Promise.all([pollMarkets(), pollBtcData()]);

getDb(); // Initialize SQLite on startup
initPaperTradingDb(); // Create paper_trades table if not exists
resumePendingJobs(); // Resume any pending jobs from before restart

// Polling intervals
setInterval(pollMarkets, 10_000);   // Markets every 10s
setInterval(pollBtcData, 5_000);    // BTC data + signals every 5s

app.listen(PORT, () => {
  console.log(`[Server] Trader API running on http://localhost:${PORT}`);
  console.log(`[Server] SSE stream: http://localhost:${PORT}/api/stream`);
});

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  cleanupRTDS();
  process.exit(0);
});
