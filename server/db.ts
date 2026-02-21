import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'trader.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(DB_PATH);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('cache_size = -64000'); // 64MB cache
  _db.pragma('temp_store = MEMORY');


  _db.exec(`
    CREATE TABLE IF NOT EXISTS candles (
      symbol    TEXT    NOT NULL,
      timeframe TEXT    NOT NULL,
      open_time INTEGER NOT NULL,
      open      REAL    NOT NULL,
      high      REAL    NOT NULL,
      low       REAL    NOT NULL,
      close     REAL    NOT NULL,
      volume    REAL    NOT NULL,
      PRIMARY KEY (symbol, timeframe, open_time)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_candle_range
      ON candles(symbol, timeframe, open_time);

    CREATE TABLE IF NOT EXISTS backtest_jobs (
      id           TEXT    PRIMARY KEY,
      config       TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'pending',
      progress     INTEGER NOT NULL DEFAULT 0,
      result       TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL,
      started_at   INTEGER,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_created
      ON backtest_jobs(created_at DESC);
  `);

  console.log('[DB] SQLite initialized:', DB_PATH);

  // One-time migration: normalize microsecond timestamps to milliseconds.
  // Binance bulk CSV files stored open_time in microseconds (16 digits) but the
  // rest of the codebase (engine, REST API, job configs) uses milliseconds.
  const sample = (_db as Database.Database).prepare('SELECT open_time FROM candles LIMIT 1').get() as { open_time: number } | undefined;
  if (sample && sample.open_time > 1e13) {
    console.log('[DB] Migrating candle timestamps from microseconds to milliseconds...');
    (_db as Database.Database).exec('UPDATE candles SET open_time = open_time / 1000');
    console.log('[DB] Timestamp migration complete.');
  }

  return _db;
}

export interface DbCandle {
  symbol: string;
  timeframe: string;
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function bulkInsertCandles(candles: DbCandle[]): number {
  const db = getDb();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO candles
      (symbol, timeframe, open_time, open, high, low, close, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows: DbCandle[]) => {
    for (const c of rows) {
      insert.run(c.symbol, c.timeframe, c.open_time, c.open, c.high, c.low, c.close, c.volume);
    }
    return rows.length;
  });

  return insertMany(candles) as number;
}

export function queryCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number,
): DbCandle[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT symbol, timeframe, open_time, open, high, low, close, volume
    FROM candles
    WHERE symbol = ? AND timeframe = ?
      AND open_time >= ? AND open_time <= ?
    ORDER BY open_time ASC
  `);
  return stmt.all(symbol, timeframe, startMs, endMs) as DbCandle[];
}

export function getDbStatus(): Record<string, Record<string, { count: number; earliest: number; latest: number }>> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT symbol, timeframe,
           COUNT(*) as count,
           MIN(open_time) as earliest,
           MAX(open_time) as latest
    FROM candles
    GROUP BY symbol, timeframe
  `).all() as { symbol: string; timeframe: string; count: number; earliest: number; latest: number }[];

  const result: Record<string, Record<string, { count: number; earliest: number; latest: number }>> = {};
  for (const row of rows) {
    if (!result[row.symbol]) result[row.symbol] = {};
    result[row.symbol][row.timeframe] = { count: row.count, earliest: row.earliest, latest: row.latest };
  }
  return result;
}

export function getLatestCandleTime(symbol: string, timeframe: string): number | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(open_time) as latest FROM candles
    WHERE symbol = ? AND timeframe = ?
  `).get(symbol, timeframe) as { latest: number | null };
  return row.latest;
}
