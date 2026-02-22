import { getDb } from './db';
import { randomUUID } from 'crypto';

// ─────────────────── Schema ───────────────────

const STARTING_BALANCE = 1000;

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS paper_trades (
    id          TEXT    PRIMARY KEY,
    market_id   TEXT    NOT NULL,
    market_q    TEXT    NOT NULL,
    asset       TEXT    NOT NULL,
    direction   TEXT    NOT NULL,
    entry_price REAL    NOT NULL,
    size        REAL    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'OPEN',
    exit_price  REAL,
    pnl         REAL,
    reason      TEXT,
    strategy    TEXT,
    confidence  INTEGER,
    created_at  TEXT    NOT NULL,
    closed_at   TEXT,
    entry_spot  REAL,
    interval_m  INTEGER NOT NULL DEFAULT 5,
    epoch_end   INTEGER
  )
`;

export function initPaperTradingDb(): void {
  const db = getDb();
  db.exec(CREATE_TABLE);
  // Migrate existing DBs that don't have the new columns
  try { db.exec('ALTER TABLE paper_trades ADD COLUMN entry_spot REAL'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE paper_trades ADD COLUMN interval_m INTEGER NOT NULL DEFAULT 5'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE paper_trades ADD COLUMN epoch_end INTEGER'); } catch { /* already exists */ }
}

// ─────────────────── Types ───────────────────

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
  entry_spot: number | null;
  interval_m: number;
  epoch_end: number | null;  // Unix timestamp: actual market resolution time
}

export interface OpenTradeParams {
  market_id: string;
  market_q: string;
  asset: string;
  direction: 'YES' | 'NO';
  entry_price: number;
  size: number;
  reason?: string;
  strategy?: string;
  confidence?: number;
  entry_spot?: number;  // Current asset spot price (BTC/ETH/SOL price)
  interval_m?: number;  // Resolution interval in minutes (5 or 15)
  epoch_end?: number;   // Actual epoch resolution timestamp from the Polymarket market
}

export interface PnlSummary {
  totalTrades: number;
  openCount: number;
  closedCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  balance: number;         // starting balance + realized PnL
  equity: number;          // balance + unrealized PnL
  startingBalance: number;
  winRate: number;
  wins: number;
  losses: number;
}

// ─────────────────── Functions ───────────────────

export function openTrade(params: OpenTradeParams): PaperTrade {
  initPaperTradingDb();
  const db = getDb();

  const trade: PaperTrade = {
    id: randomUUID(),
    market_id: params.market_id,
    market_q: params.market_q,
    asset: params.asset,
    direction: params.direction,
    entry_price: params.entry_price,
    size: params.size,
    status: 'OPEN',
    exit_price: null,
    pnl: null,
    reason: params.reason ?? null,
    strategy: params.strategy ?? null,
    confidence: params.confidence ?? null,
    created_at: new Date().toISOString(),
    closed_at: null,
    entry_spot: params.entry_spot ?? null,
    interval_m: params.interval_m ?? 5,
    epoch_end: params.epoch_end ?? null,
  };

  db.prepare(`
    INSERT INTO paper_trades
      (id, market_id, market_q, asset, direction, entry_price, size, status,
       exit_price, pnl, reason, strategy, confidence, created_at, closed_at,
       entry_spot, interval_m, epoch_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.id, trade.market_id, trade.market_q, trade.asset, trade.direction,
    trade.entry_price, trade.size, trade.status, null, null,
    trade.reason, trade.strategy, trade.confidence, trade.created_at, null,
    trade.entry_spot, trade.interval_m, trade.epoch_end,
  );

  return trade;
}

export function closeTrade(id: string, exitPrice: number): PaperTrade | null {
  initPaperTradingDb();
  const db = getDb();

  const trade = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id) as PaperTrade | undefined;
  if (!trade || trade.status !== 'OPEN') return null;

  // Binary option P&L: direction=YES wins if exitPrice >= 0.5, NO wins if < 0.5
  // Win payout is always 1.0 per token (entry_price = price you paid for the token, YES or NO)
  const won = trade.direction === 'YES' ? exitPrice >= 0.5 : exitPrice < 0.5;
  const pnl = won ? trade.size * (1.0 - trade.entry_price) : -trade.size * trade.entry_price;

  const closedAt = new Date().toISOString();

  db.prepare(`
    UPDATE paper_trades
    SET status = 'CLOSED', exit_price = ?, pnl = ?, closed_at = ?
    WHERE id = ?
  `).run(exitPrice, Math.round(pnl * 100) / 100, closedAt, id);

  return { ...trade, status: 'CLOSED', exit_price: exitPrice, pnl: Math.round(pnl * 100) / 100, closed_at: closedAt };
}

// Auto-close trades whose resolution window has passed.
// currentSpots: { ETH: 2500, BTC: 95000, SOL: 180 }
// Win/loss determined by comparing current spot price to entry spot.
// Uses epoch_end if stored (accurate Polymarket resolution time), otherwise falls back to interval_m.
export function autoCloseTrades(currentSpots: Record<string, number>): PaperTrade[] {
  initPaperTradingDb();
  const db = getDb();
  const open = db.prepare("SELECT * FROM paper_trades WHERE status = 'OPEN'").all() as PaperTrade[];
  const closed: PaperTrade[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();

  for (const trade of open) {
    // Determine if the binary has expired:
    // - If we have epoch_end (the actual Polymarket resolution timestamp), use it + 30s grace
    // - Otherwise fall back to created_at + interval_m*60s + 30s (old behavior)
    let shouldClose: boolean;
    if (trade.epoch_end && trade.epoch_end > 0) {
      shouldClose = nowSec >= trade.epoch_end + 30;
    } else {
      const ageMs = nowMs - new Date(trade.created_at).getTime();
      const intervalMs = (trade.interval_m ?? 5) * 60_000;
      shouldClose = ageMs >= intervalMs + 30_000;
    }
    if (!shouldClose) continue;

    const spot = currentSpots[trade.asset];
    const entrySpot = trade.entry_spot;

    let won: boolean;
    if (spot && entrySpot && entrySpot > 0) {
      // Compare current spot to entry spot to determine direction
      const bullish = spot > entrySpot;
      won = trade.direction === 'YES' ? bullish : !bullish;
    } else {
      // No spot data yet — skip this trade, will retry next cycle
      console.warn(`[AutoClose] Skip ${trade.asset}/${trade.id.slice(0, 8)}: no spot price, retrying next cycle`);
      continue;
    }

    // Binary exit: won = 1.0 (full payout), lost = 0.0
    const exitPrice = won ? 1.0 : 0.0;
    const result = closeTrade(trade.id, exitPrice);
    if (result) {
      closed.push(result);
      const epochInfo = trade.epoch_end ? `epochEnd=${trade.epoch_end}` : `interval=${trade.interval_m}m`;
      console.log(`[AutoClose] ${trade.asset} ${trade.strategy} ${trade.direction} → ${won ? 'WIN' : 'LOSS'} (spot ${entrySpot?.toFixed(2)}→${spot?.toFixed(2)}, ${epochInfo})`);
    }
  }

  return closed;
}

export function getOpenPositions(): PaperTrade[] {
  initPaperTradingDb();
  const db = getDb();
  return db.prepare(`
    SELECT * FROM paper_trades WHERE status = 'OPEN' ORDER BY created_at DESC
  `).all() as PaperTrade[];
}

export function getAllTrades(): PaperTrade[] {
  initPaperTradingDb();
  const db = getDb();
  return db.prepare(`
    SELECT * FROM paper_trades ORDER BY created_at DESC
  `).all() as PaperTrade[];
}

export function getPnlSummary(): PnlSummary {
  initPaperTradingDb();

  const trades = getAllTrades();
  const closed = trades.filter(t => t.status === 'CLOSED');
  const open = trades.filter(t => t.status === 'OPEN');
  const wins = closed.filter(t => (t.pnl ?? 0) > 0);
  const realizedPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  // Unrealized: sum of (currentPrice - entryPrice) * size for open trades
  // We don't have live prices here so use entry_price as proxy (0 unrealized until closed)
  const unrealizedPnl = 0;
  const balance = STARTING_BALANCE + realizedPnl;
  const equity = balance + unrealizedPnl;

  return {
    totalTrades: trades.length,
    openCount: open.length,
    closedCount: closed.length,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    balance: Math.round(balance * 100) / 100,
    equity: Math.round(equity * 100) / 100,
    startingBalance: STARTING_BALANCE,
    winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 100) : 0,
    wins: wins.length,
    losses: closed.length - wins.length,
  };
}

export function clearAllTrades(): void {
  initPaperTradingDb();
  const db = getDb();
  db.prepare('DELETE FROM paper_trades').run();
}
