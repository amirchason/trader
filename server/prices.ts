import axios from 'axios';
import type { Candle, BinanceOrderBook, FundingData, BtcData, OrderBook } from './types';

const BINANCE_API = 'https://api.binance.com/api/v3';
const BINANCE_FUTURES = 'https://fapi.binance.com/fapi/v1';
const CLOB_API = 'https://clob.polymarket.com';

export async function getBinancePrice(symbol = 'BTCUSDT') {
  const { data } = await axios.get(`${BINANCE_API}/ticker/24hr`, {
    params: { symbol },
    timeout: 5000,
  });
  return {
    price: parseFloat(data.lastPrice),
    change24h: parseFloat(data.priceChangePercent),
    high24h: parseFloat(data.highPrice),
    low24h: parseFloat(data.lowPrice),
    volume24h: parseFloat(data.volume),
  };
}

export async function getBinanceCandles(symbol = 'BTCUSDT', interval = '5m', limit = 50): Promise<Candle[]> {
  const { data } = await axios.get(`${BINANCE_API}/klines`, {
    params: { symbol, interval, limit },
    timeout: 5000,
  });
  return data.map((c: unknown[]) => ({
    openTime: c[0] as number,
    open: parseFloat(c[1] as string),
    high: parseFloat(c[2] as string),
    low: parseFloat(c[3] as string),
    close: parseFloat(c[4] as string),
    volume: parseFloat(c[5] as string),
    closeTime: c[6] as number,
    quoteVolume: parseFloat(c[7] as string),
    trades: c[8] as number,
  }));
}

export async function getBinanceOrderBook(symbol = 'BTCUSDT', limit = 20): Promise<BinanceOrderBook> {
  const { data } = await axios.get(`${BINANCE_API}/depth`, {
    params: { symbol, limit },
    timeout: 5000,
  });

  const totalBids = (data.bids as string[][]).reduce((s, b) => s + parseFloat(b[1]) * parseFloat(b[0]), 0);
  const totalAsks = (data.asks as string[][]).reduce((s, a) => s + parseFloat(a[1]) * parseFloat(a[0]), 0);
  const ratio = totalAsks > 0 ? totalBids / totalAsks : 1;

  return {
    bids: (data.bids as string[][]).slice(0, 10).map(b => ({
      price: parseFloat(b[0]),
      qty: parseFloat(b[1]),
      total: parseFloat(b[0]) * parseFloat(b[1]),
    })),
    asks: (data.asks as string[][]).slice(0, 10).map(a => ({
      price: parseFloat(a[0]),
      qty: parseFloat(a[1]),
      total: parseFloat(a[0]) * parseFloat(a[1]),
    })),
    bidTotal: Math.round(totalBids),
    askTotal: Math.round(totalAsks),
    ratio: Math.round(ratio * 100) / 100,
    pressure: ratio > 1.3 ? 'bullish' : ratio < 0.7 ? 'bearish' : 'neutral',
  };
}

export async function getBinanceFunding(symbol = 'BTCUSDT'): Promise<FundingData> {
  try {
    const { data } = await axios.get(`${BINANCE_FUTURES}/fundingRate`, {
      params: { symbol, limit: 10 },
      timeout: 5000,
    });
    const latest = data[data.length - 1];
    const rate = parseFloat(latest?.fundingRate || '0');
    const annualized = rate * 3 * 365 * 100;

    return {
      current: rate,
      annualizedPct: Math.round(annualized * 100) / 100,
      signal: rate > 0.0005 ? 'overbought' : rate < -0.0003 ? 'oversold' : 'neutral',
      strength: Math.abs(rate) > 0.001 ? 'extreme' : Math.abs(rate) > 0.0005 ? 'elevated' : 'normal',
      history: data.map((d: { fundingRate: string; fundingTime: number }) => ({
        rate: parseFloat(d.fundingRate),
        time: d.fundingTime,
      })),
    };
  } catch {
    return { current: 0, annualizedPct: 0, signal: 'unknown', strength: 'unknown', history: [] };
  }
}

export async function getClobOrderBook(tokenId: string): Promise<OrderBook> {
  const { data } = await axios.get(`${CLOB_API}/book`, {
    params: { token_id: tokenId },
    timeout: 5000,
  });
  return {
    tokenId,
    bids: (data.bids || []).map((b: { price: string; size: string }) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    })),
    asks: (data.asks || []).map((a: { price: string; size: string }) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    })),
  };
}

// Aggregate 1-second candles into N-second bars (for 10s / 30s timeframes)
function aggregateCandles(candles1s: Candle[], periodSeconds: number): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + periodSeconds <= candles1s.length; i += periodSeconds) {
    const g = candles1s.slice(i, i + periodSeconds);
    result.push({
      openTime:    g[0].openTime,
      open:        g[0].open,
      high:        Math.max(...g.map(c => c.high)),
      low:         Math.min(...g.map(c => c.low)),
      close:       g[g.length - 1].close,
      volume:      g.reduce((s, c) => s + c.volume, 0),
      closeTime:   g[g.length - 1].closeTime,
      quoteVolume: g.reduce((s, c) => s + c.quoteVolume, 0),
      trades:      g.reduce((s, c) => s + c.trades, 0),
    });
  }
  return result;
}

export async function getFullBtcData(): Promise<BtcData> {
  const [
    priceRes, candles1sRes, candles1mRes, candles5mRes,
    candles15mRes, candles1hRes, candles4hRes, candles1dRes,
    fundingRes, bookRes,
  ] = await Promise.allSettled([
    getBinancePrice('BTCUSDT'),
    getBinanceCandles('BTCUSDT', '1s', 1000),   // aggregated → 10s & 30s
    getBinanceCandles('BTCUSDT', '1m', 60),
    getBinanceCandles('BTCUSDT', '5m', 60),
    getBinanceCandles('BTCUSDT', '15m', 48),
    getBinanceCandles('BTCUSDT', '1h', 48),
    getBinanceCandles('BTCUSDT', '4h', 30),
    getBinanceCandles('BTCUSDT', '1d', 30),
    getBinanceFunding('BTCUSDT'),
    getBinanceOrderBook('BTCUSDT', 20),
  ]);

  const priceData = priceRes.status === 'fulfilled'
    ? priceRes.value
    : { price: 0, change24h: 0, high24h: 0, low24h: 0, volume24h: 0 };

  const candles1s = candles1sRes.status === 'fulfilled' ? candles1sRes.value : [];

  return {
    ...priceData,
    candles10s:  aggregateCandles(candles1s, 10),
    candles30s:  aggregateCandles(candles1s, 30),
    candles1m:   candles1mRes.status  === 'fulfilled' ? candles1mRes.value  : [],
    candles5m:   candles5mRes.status  === 'fulfilled' ? candles5mRes.value  : [],
    candles15m:  candles15mRes.status === 'fulfilled' ? candles15mRes.value : [],
    candles1h:   candles1hRes.status  === 'fulfilled' ? candles1hRes.value  : [],
    candles4h:   candles4hRes.status  === 'fulfilled' ? candles4hRes.value  : [],
    candles1d:   candles1dRes.status  === 'fulfilled' ? candles1dRes.value  : [],
    funding: fundingRes.status === 'fulfilled'
      ? fundingRes.value
      : { current: 0, annualizedPct: 0, signal: 'unknown', strength: 'unknown', history: [] },
    orderBook: bookRes.status === 'fulfilled'
      ? bookRes.value
      : { bids: [], asks: [], bidTotal: 0, askTotal: 0, ratio: 1, pressure: 'neutral' },
  };
}
