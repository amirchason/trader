import express, { Request, Response } from 'express';
import cors from 'cors';
import { fetchBinaryMarkets } from './markets';
import { getFullBtcData, getClobOrderBook } from './prices';
import { scoreStrategies } from './indicators';
import { connectRTDS } from './rtds';
import type { SSEPayload, BinaryMarket, BtcData, StrategyResult, Candle } from './types';
import { getDb, getDbStatus, queryCandles } from './db';
import { downloadAllHistoricalData, download1sAndAggregate, derive10mFrom5m } from './historical';
import { createJob, getJob, listJobs, deleteJob, resumePendingJobs, setBroadcast } from './jobQueue';
import { openTrade, closeTrade, getOpenPositions, getAllTrades, getPnlSummary, initPaperTradingDb, clearAllTrades, autoCloseTrades } from './paper-trading';
import { checkAndAutoTrade, fetchEthData, fetchSolData, fetchXrpData } from './auto-trader';
import { initStrategyConfigDb, getStrategyConfigs, setStrategyEnabled, initSettingsDb, getTradeSizeSettings, setAppSetting, getMinConfidence, setMinConfidence } from './strategy-config';
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
let latestEthCandles5m: Candle[] = [];
let latestEthCandles15m: Candle[] = [];
let latestEthSignals: StrategyResult | null = null;
let latestSolSignals: StrategyResult | null = null;
let latestXrpSignals: StrategyResult | null = null;
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
  if (latestEthCandles5m.length > 0) {
    res.write(`data: ${JSON.stringify({ type: 'eth_candles', data: { candles5m: latestEthCandles5m, candles15m: latestEthCandles15m }, timestamp: Date.now() })}\n\n`);
  }
  if (latestEthSignals) {
    res.write(`data: ${JSON.stringify({ type: 'eth_signals', data: latestEthSignals, timestamp: Date.now() })}\n\n`);
  }
  if (latestSolSignals) {
    res.write(`data: ${JSON.stringify({ type: 'sol_signals', data: latestSolSignals, timestamp: Date.now() })}\n\n`);
  }
  if (latestXrpSignals) {
    res.write(`data: ${JSON.stringify({ type: 'xrp_signals', data: latestXrpSignals, timestamp: Date.now() })}\n\n`);
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

// Serve historical candles to the webapp
// GET /api/candles?symbol=ETH&timeframe=5m&limit=500&endMs=<ms>
const TF_MS: Record<string, number> = {
  '1s': 1_000, '5s': 5_000, '10s': 10_000, '30s': 30_000,
  '1m': 60_000, '5m': 300_000, '10m': 600_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '12h': 43_200_000, '1d': 86_400_000,
};
app.get('/api/candles', (req: Request, res: Response) => {
  try {
    const { symbol, timeframe, limit = '500', endMs } = req.query as Record<string, string>;
    if (!symbol || !timeframe) return res.status(400).json({ error: 'symbol and timeframe required' });
    const limitNum = Math.min(parseInt(limit, 10) || 500, 10_000);
    const endTime = endMs ? parseInt(endMs, 10) : Date.now();
    const tfMs = TF_MS[timeframe] ?? 300_000;
    const startTime = endTime - limitNum * tfMs * 1.5; // generous buffer
    const candles = queryCandles(symbol.toUpperCase(), timeframe, startTime, endTime);
    // Return up to limitNum most-recent candles
    const slice = candles.slice(-limitNum);
    res.json({ symbol: symbol.toUpperCase(), timeframe, candles: slice });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/backtest/download', async (req: Request, res: Response) => {
  if (downloadRunning) {
    return res.status(409).json({ error: 'Download already in progress' });
  }

  const { coins, timeframes, months } = req.body as {
    coins?: string[];
    timeframes?: string[];
    months?: number;
  };

  downloadRunning = true;
  const monthCount = Math.min(Math.max(months ?? 36, 1), 60); // 1–60 months, default 36
  res.json({ started: true, months: monthCount });

  const symbols = (coins ?? ['BTC', 'ETH', 'SOL', 'XRP']).map((c) => `${c}USDT` as any);
  const tfs = (timeframes ?? ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d']) as any[];

  downloadAllHistoricalData(symbols, tfs, (progress) => {
    broadcast({
      type: 'backtest_job_update',
      data: { type: 'download_progress', ...progress },
      timestamp: Date.now(),
    });
  }, monthCount)
    .catch((err) => console.error('[Download] Error:', err))
    .finally(() => { downloadRunning = false; });
});

app.post('/api/backtest/download-1s', async (req: Request, res: Response) => {
  if (download1sRunning) {
    return res.status(409).json({ error: '5s download already in progress' });
  }

  const { coins, months } = req.body as { coins?: string[]; months?: number };
  const symbols = (coins ?? ['BTC', 'ETH', 'SOL', 'XRP']).map((c) => `${c}USDT` as any);
  const monthCount = Math.min(Math.max(months ?? 36, 1), 60);

  download1sRunning = true;
  res.json({
    started: true,
    months: monthCount,
    note: `Downloads 1s ZIPs (${monthCount} months) → aggregates to 5s. Larger months = longer download.`,
  });

  download1sAndAggregate(symbols, (progress) => {
    broadcast({
      type: 'backtest_job_update',
      data: { type: 'download_1s_progress', ...progress },
      timestamp: Date.now(),
    });
  }, monthCount)
    .catch((err) => console.error('[Download5s] Error:', err))
    .finally(() => { download1sRunning = false; });
});

app.post('/api/backtest/derive-10m', async (req: Request, res: Response) => {
  if (downloadRunning) {
    return res.status(409).json({ error: 'Another download is in progress' });
  }

  const { coins } = req.body as { coins?: string[] };
  const symbols = (coins ?? ['BTC', 'ETH', 'SOL', 'XRP']).map((c) => `${c}USDT` as any);

  res.json({ started: true, note: 'Deriving 10m candles from 5m data in background' });

  derive10mFrom5m(symbols, (p) => {
    broadcast({
      type: 'backtest_job_update',
      data: { type: 'derive_10m_progress', ...p },
      timestamp: Date.now(),
    });
    console.log(`[Derive10m] ${p.symbol}: ${p.message}`);
  }).catch((err) => console.error('[Derive10m] Error:', err));
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

app.delete('/api/paper/reset', (_req: Request, res: Response) => {
  try {
    clearAllTrades();
    const summary = getPnlSummary();
    broadcast({ type: 'paper_update', data: { positions: [], pnl: summary }, timestamp: Date.now() });
    res.json({ ok: true, message: 'All paper trades cleared. Balance reset to $1000.' });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─────────────────── Strategy Config Routes ───────────────────

app.get('/api/strategy/config', (_req: Request, res: Response) => {
  try { res.json(getStrategyConfigs()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/strategy/config/:strategyId/:coin', (req: Request, res: Response) => {
  try {
    const { strategyId, coin } = req.params;
    const { enabled } = req.body as { enabled: boolean };
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    setStrategyEnabled(parseInt(strategyId, 10), coin, enabled);
    const configs = getStrategyConfigs();
    broadcast({ type: 'strategy_config_update', data: configs, timestamp: Date.now() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

// ─────────────────── Trade Size Settings Routes ───────────────────

app.get('/api/settings/trade-size', (_req: Request, res: Response) => {
  try { res.json(getTradeSizeSettings()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/settings/trade-size', (req: Request, res: Response) => {
  try {
    const { type, value } = req.body as { type: 'fixed' | 'percent'; value: number };
    if (!['fixed', 'percent'].includes(type)) return res.status(400).json({ error: 'type must be fixed or percent' });
    if (typeof value !== 'number' || value <= 0) return res.status(400).json({ error: 'value must be positive number' });
    setAppSetting('trade_size_type', type);
    setAppSetting('trade_size_value', String(value));
    const settings = getTradeSizeSettings();
    broadcast({ type: 'trade_size_update', data: settings, timestamp: Date.now() });
    res.json({ ok: true, settings });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/settings/min-confidence', (_req: Request, res: Response) => {
  try { res.json({ minConfidence: getMinConfidence() }); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.post('/api/settings/min-confidence', (req: Request, res: Response) => {
  try {
    const { value } = req.body as { value: number };
    if (typeof value !== 'number' || value < 0 || value > 100) return res.status(400).json({ error: 'value must be 0-100' });
    setMinConfidence(value);
    broadcast({ type: 'min_confidence_update', data: { minConfidence: Math.round(value) }, timestamp: Date.now() });
    res.json({ ok: true, minConfidence: getMinConfidence() });
  } catch (err) { res.status(500).json({ error: String(err) }); }
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

    // Auto-trade BTC strategies
    const btcAutoTrades = checkAndAutoTrade('BTC', signals, latestMarkets, btcData.price);
    if (btcAutoTrades.length > 0) {
      console.log(`[AutoTrade] BTC: ${btcAutoTrades.length} trade(s) placed`);
      pollPaperTrading();
    }
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
Promise.all([pollMarkets(), pollBtcData(), pollEthData(), pollSolData(), pollXrpData()]);

getDb(); // Initialize SQLite on startup
initPaperTradingDb(); // Create paper_trades table if not exists
initStrategyConfigDb(); // Create strategy_configs table + seed defaults
initSettingsDb(); // Create app_settings table + seed defaults
resumePendingJobs(); // Resume any pending jobs from before restart

function pollPaperTrading() {
  try {
    // Build current spot prices from latest data
    const currentSpots: Record<string, number> = {};
    if (latestBtcData?.price) currentSpots['BTC'] = latestBtcData.price;
    if (latestEthSignals?.indicators?.lastPrice) currentSpots['ETH'] = latestEthSignals.indicators.lastPrice;
    if (latestSolSignals?.indicators?.lastPrice) currentSpots['SOL'] = latestSolSignals.indicators.lastPrice;
    if (latestXrpSignals?.indicators?.lastPrice) currentSpots['XRP'] = latestXrpSignals.indicators.lastPrice;

    // Auto-close any trades whose interval has expired
    const closed = autoCloseTrades(currentSpots);
    if (closed.length > 0) {
      console.log(`[Paper] Auto-closed ${closed.length} trade(s)`);
    }

    const positions = getOpenPositions();
    const pnl = getPnlSummary();
    broadcast({ type: 'paper_update', data: { positions, pnl }, timestamp: Date.now() });
  } catch (err) {
    console.error('[Paper] Poll error:', err);
  }
}

async function pollEthData() {
  try {
    const { signals: ethSignals, candles5m, candles15m } = await fetchEthData();
    latestEthCandles5m = candles5m;
    latestEthCandles15m = candles15m;
    latestEthSignals = ethSignals;
    broadcast({ type: 'eth_candles', data: { candles5m, candles15m }, timestamp: Date.now() });
    broadcast({ type: 'eth_signals', data: ethSignals, timestamp: Date.now() });
    const ethSpot = ethSignals.indicators.lastPrice || candles5m[candles5m.length - 1]?.close;
    const ethAutoTrades = checkAndAutoTrade('ETH', ethSignals, latestMarkets, ethSpot);
    if (ethAutoTrades.length > 0) {
      console.log(`[AutoTrade] ETH: ${ethAutoTrades.length} trade(s) placed`);
      pollPaperTrading();
    }
  } catch (err) {
    console.error('[ETH] Poll error:', err);
  }
}

async function pollSolData() {
  try {
    const { signals: solSignals } = await fetchSolData();
    latestSolSignals = solSignals;
    broadcast({ type: 'sol_signals', data: solSignals, timestamp: Date.now() });
    const solSpot = solSignals.indicators.lastPrice || undefined;
    const solAutoTrades = checkAndAutoTrade('SOL', solSignals, latestMarkets, solSpot);
    if (solAutoTrades.length > 0) {
      console.log(`[AutoTrade] SOL: ${solAutoTrades.length} trade(s) placed`);
      pollPaperTrading();
    }
  } catch (err) {
    console.error('[SOL] Poll error:', err);
  }
}

async function pollXrpData() {
  try {
    const { signals: xrpSignals } = await fetchXrpData();
    latestXrpSignals = xrpSignals;
    broadcast({ type: 'xrp_signals', data: xrpSignals, timestamp: Date.now() });
    const xrpSpot = xrpSignals.indicators.lastPrice || undefined;
    const xrpAutoTrades = checkAndAutoTrade('XRP', xrpSignals, latestMarkets, xrpSpot);
    if (xrpAutoTrades.length > 0) {
      console.log(`[AutoTrade] XRP: ${xrpAutoTrades.length} trade(s) placed`);
      pollPaperTrading();
    }
  } catch (err) {
    console.error('[XRP] Poll error:', err);
  }
}

// Polling intervals
setInterval(pollMarkets, 10_000);      // Markets every 10s
setInterval(pollBtcData, 5_000);       // BTC data + signals every 5s
setInterval(pollPaperTrading, 10_000); // Paper trading every 10s
setInterval(pollEthData, 30_000);      // ETH signals for auto-trading every 30s
setInterval(pollSolData, 60_000);      // SOL signals every 60s (15m strategy, low frequency)
setInterval(pollXrpData, 60_000);      // XRP signals every 60s (15m strategy, low frequency)

app.listen(PORT, () => {
  console.log(`[Server] Trader API running on http://localhost:${PORT}`);
  console.log(`[Server] SSE stream: http://localhost:${PORT}/api/stream`);
});

process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  cleanupRTDS();
  process.exit(0);
});
