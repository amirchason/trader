import { getDb } from './db';
import { getPnlSummary } from './paper-trading';

// ─────────────────── Types ───────────────────

export interface StrategyConfig {
  id: string;
  strategyId: number;
  coin: string;
  enabled: boolean;
  tradeSize: number;
}

// ─────────────────── Schema ───────────────────

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS strategy_configs (
    id          TEXT    PRIMARY KEY,
    strategy_id INTEGER NOT NULL,
    coin        TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 0,
    trade_size  REAL    NOT NULL DEFAULT 50
  )
`;

// The 6 strategy+coin combos we support
const DEFAULT_CONFIGS: Array<{ strategyId: number; coin: string }> = [
  // Tier 1: Best ETH
  { strategyId: 18, coin: 'ETH' },
  { strategyId: 16, coin: 'ETH' },
  { strategyId: 17, coin: 'ETH' },
  { strategyId: 15, coin: 'ETH' },
  { strategyId: 13, coin: 'ETH' },
  // Tier 2: Cross-coin
  { strategyId: 14, coin: 'ETH' },
  { strategyId: 14, coin: 'BTC' },
  { strategyId: 12, coin: 'BTC' },
  // Tier 3: Additional
  { strategyId: 10, coin: 'ETH' },
  { strategyId: 10, coin: 'BTC' },
  { strategyId: 11, coin: 'ETH' },
  { strategyId: 9,  coin: 'ETH' },
  { strategyId: 9,  coin: 'BTC' },
  // SOL
  { strategyId: 19, coin: 'SOL' },
  // XRP
  { strategyId: 20, coin: 'XRP' },
  // New ETH strategies (21-25) — Session 4 ML-optimized
  { strategyId: 21, coin: 'ETH' },
  { strategyId: 22, coin: 'ETH' },
  { strategyId: 23, coin: 'ETH' },
  { strategyId: 24, coin: 'ETH' },
  { strategyId: 25, coin: 'ETH' },
  // New SOL strategies (26-30) — Session 4 ML-optimized
  { strategyId: 26, coin: 'SOL' },
  { strategyId: 27, coin: 'SOL' },
  { strategyId: 28, coin: 'SOL' },
  { strategyId: 29, coin: 'SOL' },
  { strategyId: 30, coin: 'SOL' },
  // New ETH strategies (31-32, 35) — Session 5 ML-optimized (best ever WR)
  { strategyId: 31, coin: 'ETH' },
  { strategyId: 32, coin: 'ETH' },
  { strategyId: 35, coin: 'ETH' },
  // New SOL strategies (33-34) — Session 5 ML-optimized (ultra stable)
  { strategyId: 33, coin: 'SOL' },
  { strategyId: 34, coin: 'SOL' },
  // New ETH/15m strategies (36-38) — Session 6 Wave 3 (ultra stable body+RSI+MFI)
  { strategyId: 36, coin: 'ETH' },
  { strategyId: 37, coin: 'ETH' },
  { strategyId: 38, coin: 'ETH' },
  // New XRP strategies (39-40) — Session 6 validated (near-perfect stability)
  { strategyId: 39, coin: 'XRP' },
  { strategyId: 40, coin: 'XRP' },
  // Strategy 41: Saturday BB — BTC validated (69.1% WF), also for ETH
  { strategyId: 41, coin: 'BTC' },
  { strategyId: 41, coin: 'ETH' },
  // Strategy 42: SOL RSI Streak BB — ULTRA STABLE WF=67.1% σ=2.9% (paramOptimize)
  { strategyId: 42, coin: 'SOL' },
  // BTC 5m strategies (43-46) — btc5mResearch.js: BTC h=[1,12,13,16,20] strongly mean-reverting
  { strategyId: 43, coin: 'BTC' }, // MFI>75+BB22+GH+s>=1 → WF=81.6% σ=2.6% ULTRA STABLE
  { strategyId: 44, coin: 'BTC' }, // RSI>67+BB22+GH+s>=1 → WF=80.5% σ=4.2%
  { strategyId: 45, coin: 'BTC' }, // GH+BB22+s>=2         → WF=79.7% σ=5.5% T=310 HIGH FREQ
  { strategyId: 46, coin: 'BTC' }, // RSI>70+BB22+GH+s>=1 → WF=83.1% σ=8.5% HIGHEST WR
  // All-Hours High-Frequency strategies (56-58) — quickValidateBTC5m.js: no hour filter, 5+/day
  { strategyId: 56, coin: 'ETH' }, // ALL_H+RSI>70+BB22+s>=1 → ETH WF=76.1% σ=2.6% 5.1/day ULTRA STABLE
  { strategyId: 56, coin: 'BTC' }, // ALL_H+RSI>70+BB22+s>=1 → BTC WF=75.2% σ=5.6% 5.1/day
  { strategyId: 57, coin: 'ETH' }, // ALL_H+MFI>80+BB22+s>=1 → ETH WF=75.7% σ=4.1% 4.2/day
  { strategyId: 57, coin: 'BTC' }, // ALL_H+MFI>80+BB22+s>=1 → BTC validated 4.2/day
  { strategyId: 58, coin: 'ETH' }, // ALL_H+MFI>85+BB22+s>=1 → ETH WF=76.3% σ=4.3% 2.8/day
  { strategyId: 58, coin: 'BTC' }, // ALL_H+MFI>85+BB22+s>=1 → BTC validated 2.8/day
  // SOL All-Hours High-Frequency strategies (59-60) — newSignalSearch.js: SOL 5m all hours
  { strategyId: 59, coin: 'SOL' }, // SOL ALL_H+RSI>70+BB22+s>=1 → WF=73.0% σ=2.8% 4.8/day ULTRA STABLE
  { strategyId: 60, coin: 'SOL' }, // SOL ALL_H+RSI7>75+BB22+s>=1 → WF=73.2% σ=3.1% 7.2/day HIGHEST FREQ
  // BTC Synth-15m strategies (61-62) — newSignalSearch.js: group 3×5m → synth15m
  { strategyId: 61, coin: 'BTC' }, // Synth15m GH+RSI>65+BB22+s>=1 → WF=86.3% σ=6.3% HIGHEST WR EVER!
  { strategyId: 62, coin: 'BTC' }, // Synth15m ALL_H+RSI>70+BB22+s>=1 → WF=77.0% σ=4.4% 1.8/day
  // ETH Enhanced All-Hours strategies (64-65) — newSignalSearch.js
  { strategyId: 64, coin: 'ETH' }, // ALL_H+RSI>70+MFI>70+BB22+s>=1 → WF=76.4% σ=2.2% 4.4/day ULTRA STABLE
  { strategyId: 64, coin: 'BTC' }, // same logic, BTC version
  { strategyId: 65, coin: 'ETH' }, // ALL_H+RSI>70+dev[0.05-0.5%]+BB22+s>=1 → WF=77.8% σ=2.7% ULTRA STABLE
  { strategyId: 65, coin: 'BTC' }, // same logic, BTC version
  // BTC GoodH body+RSI filter (66) — newSignalSearch.js
  { strategyId: 66, coin: 'BTC' }, // GH+RSI>65+body>=0.15%+BB22+s>=1 → WF=79.2% σ=2.6% ULTRA STABLE
  // Ultra High-Frequency Testing Strategy (67) — 40+ trades/day for position testing
  { strategyId: 67, coin: 'ETH' }, // ETH BB(20,1.8)+s>=1 → WF=73.1% σ=0.7% 42/day ULTRA STABLE
  { strategyId: 67, coin: 'BTC' }, // BTC BB(20,1.8)+s>=1 → WF=73.4% σ=0.7% 42/day ULTRA STABLE
  { strategyId: 67, coin: 'SOL' }, // SOL BB(20,1.8)+s>=1 → WF=71.7% σ=0.4% 43/day MOST STABLE EVER
];

export function initStrategyConfigDb(): void {
  const db = getDb();
  db.exec(CREATE_TABLE);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO strategy_configs (id, strategy_id, coin, enabled, trade_size)
    VALUES (?, ?, ?, 0, 50)
  `);
  for (const { strategyId, coin } of DEFAULT_CONFIGS) {
    insert.run(`strat_${strategyId}_${coin}`, strategyId, coin);
  }
}

// ─────────────────── Functions ───────────────────

export function getStrategyConfigs(): StrategyConfig[] {
  initStrategyConfigDb();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM strategy_configs ORDER BY strategy_id, coin').all() as Array<{
    id: string; strategy_id: number; coin: string; enabled: number; trade_size: number;
  }>;
  return rows.map(r => ({
    id: r.id,
    strategyId: r.strategy_id,
    coin: r.coin,
    enabled: r.enabled === 1,
    tradeSize: r.trade_size,
  }));
}

export function getStrategyConfig(strategyId: number, coin: string): StrategyConfig | null {
  initStrategyConfigDb();
  const db = getDb();
  const row = db.prepare('SELECT * FROM strategy_configs WHERE strategy_id = ? AND coin = ?').get(strategyId, coin) as {
    id: string; strategy_id: number; coin: string; enabled: number; trade_size: number;
  } | undefined;
  if (!row) return null;
  return { id: row.id, strategyId: row.strategy_id, coin: row.coin, enabled: row.enabled === 1, tradeSize: row.trade_size };
}

export function setStrategyEnabled(strategyId: number, coin: string, enabled: boolean): void {
  initStrategyConfigDb();
  const db = getDb();
  // Upsert: create row if it doesn't exist (for strategies added after initial DB creation)
  db.prepare(`
    INSERT INTO strategy_configs (id, strategy_id, coin, enabled, trade_size)
    VALUES (?, ?, ?, ?, 50)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled
  `).run(`strat_${strategyId}_${coin}`, strategyId, coin, enabled ? 1 : 0);
}

// ─────────────────── App Settings ───────────────────

const CREATE_SETTINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

export interface TradeSizeSettings {
  type: 'fixed' | 'percent';
  value: number;
}

export function initSettingsDb(): void {
  const db = getDb();
  db.exec(CREATE_SETTINGS_TABLE);
  const ins = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  ins.run('trade_size_type', 'fixed');
  ins.run('trade_size_value', '50');
}

export function getAppSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getTradeSizeSettings(): TradeSizeSettings {
  return {
    type: (getAppSetting('trade_size_type') ?? 'fixed') as 'fixed' | 'percent',
    value: parseFloat(getAppSetting('trade_size_value') ?? '50'),
  };
}

export function getMinConfidence(): number {
  return parseInt(getAppSetting('min_confidence') ?? '65', 10);
}

export function setMinConfidence(value: number): void {
  setAppSetting('min_confidence', String(Math.round(value)));
}

/** Compute actual dollar trade size based on current settings and balance */
export function computeTradeSize(): number {
  const { type, value } = getTradeSizeSettings();
  if (type === 'fixed') return Math.max(1, value);
  // percent of current balance
  const balance = getPnlSummary().balance;
  const size = Math.max(1, (value / 100) * balance);
  return Math.round(size * 100) / 100;
}
