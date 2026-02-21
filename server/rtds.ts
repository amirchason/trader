/**
 * RTDS — Polymarket Real-Time Data Socket client.
 * Connects to wss://ws-live-data.polymarket.com and subscribes to
 * Chainlink BTC/USD prices. Broadcasts updates via callback.
 */
import WebSocket from 'ws';

type PriceUpdate = { price: number; asset: string };
type OnPriceCallback = (update: PriceUpdate) => void;

const RTDS_URL = 'wss://ws-live-data.polymarket.com';

const SUBSCRIPTIONS = [
  { asset: 'BTC', pair: 'btc/usd', message_type: 'chainlink' },
  { asset: 'ETH', pair: 'eth/usd', message_type: 'chainlink' },
  { asset: 'SOL', pair: 'sol/usd', message_type: 'chainlink' },
  { asset: 'XRP', pair: 'xrp/usd', message_type: 'chainlink' },
];

export function connectRTDS(onPrice: OnPriceCallback): () => void {
  let ws: WebSocket | null = null;
  let pingInterval: NodeJS.Timeout | null = null;
  let reconnectTimeout: NodeJS.Timeout | null = null;
  let stopped = false;

  function connect() {
    if (stopped) return;

    ws = new WebSocket(RTDS_URL);

    ws.on('open', () => {
      console.log('[RTDS] Connected to Polymarket RTDS WebSocket');

      // Subscribe to all crypto prices
      for (const sub of SUBSCRIPTIONS) {
        ws!.send(JSON.stringify({
          action: 'subscribe',
          topic: 'crypto_prices',
          message_type: sub.message_type,
          filters: { pair: sub.pair },
        }));
      }

      // Send PING every 5 seconds to keep alive
      pingInterval = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send('PING');
        }
      }, 5000);
    });

    ws.on('message', (raw) => {
      try {
        const text = raw.toString();
        if (text === 'PONG') return;

        const msg = JSON.parse(text);
        if (msg.topic === 'crypto_prices' && msg.data?.price) {
          const asset = msg.data.asset?.toUpperCase() ||
                        (msg.data.pair || '').split('/')[0].toUpperCase() ||
                        'BTC';
          const price = parseFloat(msg.data.price);
          if (!isNaN(price) && price > 0) {
            onPrice({ price, asset });
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', () => {
      console.log('[RTDS] Disconnected, reconnecting in 5s...');
      if (pingInterval) clearInterval(pingInterval);
      if (!stopped) {
        reconnectTimeout = setTimeout(connect, 5000);
      }
    });

    ws.on('error', (err) => {
      console.warn('[RTDS] WebSocket error:', err.message);
      ws?.close();
    });
  }

  connect();

  // Return cleanup function
  return () => {
    stopped = true;
    if (pingInterval) clearInterval(pingInterval);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    ws?.close();
  };
}
