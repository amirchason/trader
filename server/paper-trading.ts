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
    closed_at   TEXT
  )
`;

export function initPaperTradingDb(): void {
  const db = getDb();
  db.exec(CREATE_TABLE);
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
  };

  db.prepare(`
    INSERT INTO paper_trades
      (id, market_id, market_q, asset, direction, entry_price, size, status,
       exit_price, pnl, reason, strategy, confidence, created_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.id, trade.market_id, trade.market_q, trade.asset, trade.direction,
    trade.entry_price, trade.size, trade.status, null, null,
    trade.reason, trade.strategy, trade.confidence, trade.created_at, null,
  );

  return trade;
}

export function closeTrade(id: string, exitPrice: number): PaperTrade | null {
  initPaperTradingDb();
  const db = getDb();

  const trade = db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id) as PaperTrade | undefined;
  if (!trade || trade.status !== 'OPEN') return null;

  // Binary option P&L: direction=YES wins if exitPrice >= 0.5, NO wins if < 0.5
  const won = trade.direction === 'YES' ? exitPrice >= 0.5 : exitPrice < 0.5;
  const pnl = won ? trade.size * (exitPrice - trade.entry_price) : -trade.size * trade.entry_price;

  const closedAt = new Date().toISOString();

  db.prepare(`
    UPDATE paper_trades
    SET status = 'CLOSED', exit_price = ?, pnl = ?, closed_at = ?
    WHERE id = ?
  `).run(exitPrice, Math.round(pnl * 100) / 100, closedAt, id);

  return { ...trade, status: 'CLOSED', exit_price: exitPrice, pnl: Math.round(pnl * 100) / 100, closed_at: closedAt };
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
