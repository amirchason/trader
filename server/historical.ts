import axios from 'axios';
import pLimit from 'p-limit';
import { Readable } from 'stream';
import { bulkInsertCandles, getLatestCandleTime, queryCandles, type DbCandle } from './db';

export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'] as const;
export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'] as const;
export type BinanceSymbol = typeof SYMBOLS[number];
export type Timeframe = typeof TIMEFRAMES[number];

export function symbolToAsset(s: BinanceSymbol): string {
  return s.endsWith('USDT') ? s.slice(0, -4) : s;
}

export interface DownloadProgress {
  symbol: string;
  timeframe: string;
  phase: 'zip' | 'api' | 'done' | 'error';
  message: string;
  inserted: number;
}

async function downloadMonthlyZip(
  symbol: BinanceSymbol,
  interval: Timeframe,
  year: number,
  month: number,
  onProgress?: (msg: string) => void,
): Promise<DbCandle[]> {
  const monthStr = String(month).padStart(2, '0');
  const filename = `${symbol}-${interval}-${year}-${monthStr}`;
  const url = `https://data.binance.vision/data/spot/monthly/klines/${symbol}/${interval}/${filename}.zip`;

  onProgress?.(`Downloading ${filename}.zip`);

  let buffer: Buffer;
  try {
    const res = await axios.get<Buffer>(url, {
      responseType: 'arraybuffer',
      timeout: 120_000,
    });
    buffer = Buffer.from(res.data);
  } catch (err: any) {
    if (err?.response?.status === 404) return [];
    throw err;
  }

  return parseZipBuffer(buffer, symbol, interval);
}

async function parseZipBuffer(
  buffer: Buffer,
  symbol: BinanceSymbol,
  interval: Timeframe | string,
): Promise<DbCandle[]> {
  const unzipper = await import('unzipper');
  const { parse } = await import('csv-parse');

  return new Promise((resolve, reject) => {
    const candles: DbCandle[] = [];
    const asset = symbolToAsset(symbol as BinanceSymbol);

    const bufferStream = Readable.from(Buffer.from(buffer));

    bufferStream
      .pipe(unzipper.Parse())
      .on('entry', (entry: any) => {
        if (!entry.path.endsWith('.csv')) {
          entry.autodrain();
          return;
        }

        const parser = parse({ columns: false, skip_empty_lines: true });

        parser.on('data', (row: string[]) => {
          if (row[0] === 'open_time') return;
          const openTime = parseInt(row[0], 10);
          if (isNaN(openTime)) return;
          // Normalize to milliseconds — Binance bulk CSVs may store microseconds (16-digit)
          const openTimeMs = openTime > 1e13 ? Math.floor(openTime / 1000) : openTime;

          candles.push({
            symbol: asset,
            timeframe: interval as string,
            open_time: openTimeMs,
            open: parseFloat(row[1]),
            high: parseFloat(row[2]),
            low: parseFloat(row[3]),
            close: parseFloat(row[4]),
            volume: parseFloat(row[5]),
          });
        });

        parser.on('error', reject);
        entry.pipe(parser);
      })
      .on('finish', () => resolve(candles))
      .on('error', reject);
  });
}

const BINANCE_API = 'https://api.binance.com/api/v3';

async function fetchKlinesPage(
  symbol: BinanceSymbol,
  interval: Timeframe,
  startTime: number,
  limit = 1000,
): Promise<DbCandle[]> {
  const res = await axios.get(`${BINANCE_API}/klines`, {
    params: { symbol, interval, startTime, limit },
    timeout: 10_000,
  });

  const asset = symbolToAsset(symbol);
  return (res.data as any[][]).map((c) => ({
    symbol: asset,
    timeframe: interval,
    open_time: c[0] as number,
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

async function fillGapFromApi(
  symbol: BinanceSymbol,
  interval: Timeframe,
  fromMs: number,
  onProgress?: (msg: string) => void,
): Promise<number> {
  let startTime = fromMs;
  let totalInserted = 0;
  const now = Date.now();

  while (startTime < now) {
    const candles = await fetchKlinesPage(symbol, interval, startTime);
    if (candles.length === 0) break;

    const inserted = bulkInsertCandles(candles);
    totalInserted += inserted;

    startTime = candles[candles.length - 1].open_time + 1;
    onProgress?.(`${symbolToAsset(symbol)} ${interval}: fetched ${totalInserted} candles via API`);

    // Rate limit: 200ms between requests
    await new Promise((r) => setTimeout(r, 200));
  }

  return totalInserted;
}

// ─────────────────── Standard Timeframe Download (3 years) ───────────────────

export async function downloadAllHistoricalData(
  symbols: BinanceSymbol[] = [...SYMBOLS],
  timeframes: Timeframe[] = [...TIMEFRAMES],
  onProgress?: (p: DownloadProgress) => void,
  months = 36, // default: 3 years
): Promise<void> {
  const limit = pLimit(5);

  const now = new Date();
  const monthList: { year: number; month: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthList.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  // Stage 1: Bulk ZIP download
  const zipTasks: Promise<void>[] = [];

  for (const sym of symbols) {
    for (const tf of timeframes) {
      for (const { year, month } of monthList) {
        zipTasks.push(
          limit(async () => {
            try {
              const candles = await downloadMonthlyZip(sym, tf, year, month, (msg) => {
                onProgress?.({ symbol: symbolToAsset(sym), timeframe: tf, phase: 'zip', message: msg, inserted: 0 });
              });

              if (candles.length > 0) {
                const inserted = bulkInsertCandles(candles);
                onProgress?.({
                  symbol: symbolToAsset(sym), timeframe: tf, phase: 'zip',
                  message: `Stored ${inserted} candles`, inserted,
                });
              }
            } catch (err: any) {
              onProgress?.({ symbol: symbolToAsset(sym), timeframe: tf, phase: 'error', message: String(err), inserted: 0 });
            }
          }),
        );
      }
    }
  }

  await Promise.allSettled(zipTasks);

  // Stage 2: Fill gaps with REST API
  const threeYearsAgo = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  for (const sym of symbols) {
    for (const tf of timeframes) {
      const asset = symbolToAsset(sym);
      const latestRaw = getLatestCandleTime(asset, tf);
      // Ensure fromMs is in milliseconds (guard against pre-migration microsecond value)
      const latestMs = latestRaw && latestRaw > 1e13 ? Math.floor(latestRaw / 1000) : latestRaw;
      const fromMs = latestMs ? latestMs + 1 : threeYearsAgo;

      try {
        const inserted = await fillGapFromApi(sym, tf, fromMs, (msg) => {
          onProgress?.({ symbol: asset, timeframe: tf, phase: 'api', message: msg, inserted: 0 });
        });
        onProgress?.({ symbol: asset, timeframe: tf, phase: 'done', message: `Complete. ${inserted} new via API`, inserted });
      } catch (err: any) {
        onProgress?.({ symbol: asset, timeframe: tf, phase: 'error', message: String(err), inserted: 0 });
      }
    }
  }
}

// ─────────────────── 5s data: download 1s ZIPs, aggregate to 5s ───────────────────
// Binance has no 5s klines — we download 1s monthly ZIPs and aggregate in-process.
// We do NOT store 1s candles (saves ~95% disk space vs storing raw 1s).

function aggregateFrom1s(candles1s: DbCandle[], seconds: number, targetTf: string): DbCandle[] {
  const result: DbCandle[] = [];
  let i = 0;
  while (i < candles1s.length) {
    const windowStart = candles1s[i].open_time;
    const windowEnd = windowStart + seconds * 1000;
    const group: DbCandle[] = [];
    while (i < candles1s.length && candles1s[i].open_time < windowEnd) {
      group.push(candles1s[i]);
      i++;
    }
    if (group.length === 0) break;
    result.push({
      symbol: group[0].symbol,
      timeframe: targetTf,
      open_time: group[0].open_time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

export interface Download1sProgress {
  symbol: string;
  phase: '1s_zip' | '1s_api' | 'aggregate' | 'done' | 'error';
  message: string;
  inserted: number;
}

export async function download5sData(
  symbols: BinanceSymbol[] = [...SYMBOLS],
  onProgress?: (p: Download1sProgress) => void,
  months = 36, // default: 3 years
): Promise<void> {
  const now = new Date();
  const monthList: { year: number; month: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthList.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  for (const sym of symbols) {
    const asset = symbolToAsset(sym);

    // Stage 1: Download 1s monthly ZIPs → aggregate to 5s → store immediately
    // Process one month at a time to avoid huge memory usage
    for (const { year, month } of monthList) {
      const monthStr = String(month).padStart(2, '0');
      const filename = `${sym}-1s-${year}-${monthStr}`;
      const url = `https://data.binance.vision/data/spot/monthly/klines/${sym}/1s/${filename}.zip`;

      onProgress?.({ symbol: asset, phase: '1s_zip', message: `Downloading ${filename}.zip`, inserted: 0 });

      try {
        const res = await axios.get<Buffer>(url, {
          responseType: 'arraybuffer',
          timeout: 180_000,
        });
        // Parse as 1s but don't store — immediately aggregate to 5s
        const candles1s = await parseZipBuffer(Buffer.from(res.data), sym, '1s');
        const candles5s = aggregateFrom1s(candles1s, 5, '5s');
        const ins = bulkInsertCandles(candles5s);
        onProgress?.({
          symbol: asset,
          phase: '1s_zip',
          message: `${filename}: stored ${ins} 5s candles (from ${candles1s.length} 1s)`,
          inserted: ins,
        });
      } catch (err: any) {
        const isNotFound = axios.isAxiosError(err) && err.response?.status === 404;
        onProgress?.({
          symbol: asset,
          phase: isNotFound ? '1s_zip' : 'error',
          message: isNotFound ? `${filename}.zip not available` : `${filename}: ${String(err)}`,
          inserted: 0,
        });
      }
    }

    // Stage 2: Fill recent gap (current month so far) via REST API
    const latest5s = getLatestCandleTime(asset, '5s');
    const apiFrom = latest5s
      ? latest5s + 5000
      : Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days if no data at all

    let startTime = apiFrom;
    const nowMs = Date.now();
    let restBuf: DbCandle[] = [];
    let restCount = 0;

    onProgress?.({ symbol: asset, phase: '1s_api', message: 'Filling current-month gap via REST...', inserted: 0 });

    while (startTime < nowMs) {
      try {
        const res = await axios.get(`${BINANCE_API}/klines`, {
          params: { symbol: sym, interval: '1s', startTime, limit: 1000 },
          timeout: 10_000,
        });
        const page: DbCandle[] = (res.data as any[][]).map((c) => ({
          symbol: asset,
          timeframe: '1s',
          open_time: c[0] as number,
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        }));
        if (page.length === 0) break;
        restBuf.push(...page);
        restCount += page.length;
        startTime = page[page.length - 1].open_time + 1;
        onProgress?.({ symbol: asset, phase: '1s_api', message: `REST: ${restCount} 1s candles fetched`, inserted: 0 });
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        break;
      }
    }

    if (restBuf.length > 0) {
      restBuf.sort((a, b) => a.open_time - b.open_time);
      const candles5s = aggregateFrom1s(restBuf, 5, '5s');
      const ins = bulkInsertCandles(candles5s);
      onProgress?.({ symbol: asset, phase: '1s_api', message: `Stored ${ins} 5s candles from REST`, inserted: ins });
    }

    onProgress?.({ symbol: asset, phase: 'done', message: `${asset} 5s data complete!`, inserted: 0 });
  }
}

// Legacy export for backwards compat (routes that call download1sAndAggregate)
export async function download1sAndAggregate(
  symbols: BinanceSymbol[] = [...SYMBOLS],
  onProgress?: (p: Download1sProgress) => void,
  months = 36,
): Promise<void> {
  return download5sData(symbols, onProgress, months);
}

// ─────────────────── 10m derivation from 5m ───────────────────
// Binance has no 10m klines. We aggregate pairs of 5m candles from our DB.

export interface Derive10mProgress {
  symbol: string;
  message: string;
  inserted: number;
}

export async function derive10mFrom5m(
  symbols: BinanceSymbol[] = [...SYMBOLS],
  onProgress?: (p: Derive10mProgress) => void,
): Promise<void> {
  for (const sym of symbols) {
    const asset = symbolToAsset(sym);
    onProgress?.({ symbol: asset, message: 'Reading 5m candles...', inserted: 0 });

    // Read all 5m candles from DB
    const candles5m = queryCandles(asset, '5m', 0, Date.now() + 86400000);
    if (candles5m.length < 2) {
      onProgress?.({ symbol: asset, message: 'Not enough 5m data — download 5m first', inserted: 0 });
      continue;
    }

    // Aggregate pairs: 5m[0]+5m[1] = 10m[0], 5m[2]+5m[3] = 10m[1], etc.
    const candles10m: DbCandle[] = [];
    for (let i = 0; i + 1 < candles5m.length; i += 2) {
      const a = candles5m[i];
      const b = candles5m[i + 1];
      // Only pair candles that are exactly 5m apart (300000 ms)
      if (b.open_time - a.open_time !== 300_000) continue;
      candles10m.push({
        symbol: asset,
        timeframe: '10m',
        open_time: a.open_time,
        open: a.open,
        high: Math.max(a.high, b.high),
        low: Math.min(a.low, b.low),
        close: b.close,
        volume: a.volume + b.volume,
      });
    }

    const ins = bulkInsertCandles(candles10m);
    onProgress?.({ symbol: asset, message: `Stored ${ins} 10m candles from ${candles5m.length} 5m`, inserted: ins });
  }
}
