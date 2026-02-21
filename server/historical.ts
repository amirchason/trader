import axios from 'axios';
import pLimit from 'p-limit';
import { Readable } from 'stream';
import { bulkInsertCandles, getLatestCandleTime, type DbCandle } from './db';

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
      timeout: 60_000,
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
  interval: Timeframe,
): Promise<DbCandle[]> {
  const unzipper = await import('unzipper');
  const { parse } = await import('csv-parse');

  return new Promise((resolve, reject) => {
    const candles: DbCandle[] = [];
    const asset = symbolToAsset(symbol);

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
            timeframe: interval,
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

export async function downloadAllHistoricalData(
  symbols: BinanceSymbol[] = [...SYMBOLS],
  timeframes: Timeframe[] = [...TIMEFRAMES],
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const limit = pLimit(5);

  const now = new Date();
  const months: { year: number; month: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  // Stage 1: Bulk ZIP download
  const zipTasks: Promise<void>[] = [];

  for (const sym of symbols) {
    for (const tf of timeframes) {
      for (const { year, month } of months) {
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
  for (const sym of symbols) {
    for (const tf of timeframes) {
      const asset = symbolToAsset(sym);
      const latestRaw = getLatestCandleTime(asset, tf);
      // Ensure fromMs is in milliseconds (guard against pre-migration microsecond value)
      const latestMs = latestRaw && latestRaw > 1e13 ? Math.floor(latestRaw / 1000) : latestRaw;
      const fromMs = latestMs ? latestMs + 1 : Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;

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

// ─────────────────── 1s data + 10s/30s aggregation ───────────────────

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

export async function download1sAndAggregate(
  symbols: BinanceSymbol[] = [...SYMBOLS],
  onProgress?: (p: Download1sProgress) => void,
): Promise<void> {
  const now = new Date();
  const months: { year: number; month: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }

  for (const sym of symbols) {
    const asset = symbolToAsset(sym);
    const allCandles1s: DbCandle[] = [];

    // Stage 1: Try ZIP download for each month
    for (const { year, month } of months) {
      const monthStr = String(month).padStart(2, '0');
      const filename = `${sym}-1s-${year}-${monthStr}`;
      const url = `https://data.binance.vision/data/spot/monthly/klines/${sym}/1s/${filename}.zip`;

      onProgress?.({ symbol: asset, phase: '1s_zip', message: `Trying ${filename}.zip`, inserted: 0 });

      try {
        const res = await axios.get<Buffer>(url, { responseType: 'arraybuffer', timeout: 120_000 });
        const candles = await parseZipBuffer(Buffer.from(res.data), sym, '1m' as Timeframe);
        // Re-tag as 1s timeframe
        const tagged = candles.map((c) => ({ ...c, timeframe: '1s' }));
        allCandles1s.push(...tagged);
        onProgress?.({ symbol: asset, phase: '1s_zip', message: `Got ${tagged.length} 1s candles from ZIP`, inserted: tagged.length });
      } catch {
        // ZIP not available for this month, will fill via API
        onProgress?.({ symbol: asset, phase: '1s_zip', message: `${filename}.zip not available, skipping`, inserted: 0 });
      }
    }

    // Stage 2: Fill any remaining gap via REST API (1s interval)
    const latest1s = getLatestCandleTime(asset, '1s');
    const apiFrom = latest1s
      ? latest1s + 1
      : allCandles1s.length > 0
        ? Math.max(...allCandles1s.map((c) => c.open_time)) + 1
        : Date.now() - 6 * 30 * 24 * 60 * 60 * 1000;

    let startTime = apiFrom;
    const nowMs = Date.now();
    let restCount = 0;

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
        allCandles1s.push(...page);
        restCount += page.length;
        startTime = page[page.length - 1].open_time + 1;
        onProgress?.({ symbol: asset, phase: '1s_api', message: `REST: ${restCount} 1s candles`, inserted: 0 });
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        break;
      }
    }

    if (allCandles1s.length === 0) {
      onProgress?.({ symbol: asset, phase: 'error', message: 'No 1s data obtained', inserted: 0 });
      continue;
    }

    // Sort by time
    allCandles1s.sort((a, b) => a.open_time - b.open_time);

    // Store 1s
    const ins1s = bulkInsertCandles(allCandles1s);
    onProgress?.({ symbol: asset, phase: 'aggregate', message: `Stored ${ins1s} 1s candles`, inserted: ins1s });

    // Aggregate to 10s
    const candles10s = aggregateFrom1s(allCandles1s, 10, '10s');
    const ins10s = bulkInsertCandles(candles10s);
    onProgress?.({ symbol: asset, phase: 'aggregate', message: `Stored ${ins10s} 10s candles`, inserted: ins10s });

    // Aggregate to 30s
    const candles30s = aggregateFrom1s(allCandles1s, 30, '30s');
    const ins30s = bulkInsertCandles(candles30s);
    onProgress?.({ symbol: asset, phase: 'done', message: `Stored ${ins30s} 30s candles. Done!`, inserted: ins30s });
  }
}
