/**
 * Binary market fetching from Polymarket Gamma API.
 * Supports BTC, ETH, SOL, XRP across 5m and 15m intervals.
 * Ported and extended from polymarket-suite/dashboard/server/btcBinary.js
 */
import axios from 'axios';
import type { BinaryMarket, Asset, Interval } from './types';

const GAMMA_API = 'https://gamma-api.polymarket.com';

type AssetConfig = {
  symbols: string[];   // Keywords to match in market question
  prefix: string;      // Slug prefix (e.g. 'btc', 'eth')
};

const ASSETS: Record<Asset, AssetConfig> = {
  BTC: { symbols: ['bitcoin', 'btc'], prefix: 'btc' },
  ETH: { symbols: ['ethereum', 'eth'], prefix: 'eth' },
  SOL: { symbols: ['solana', 'sol'], prefix: 'sol' },
  XRP: { symbols: ['xrp', 'ripple'], prefix: 'xrp' },
};

function parseOutcomePrices(raw: unknown): [number, number] {
  let prices: string[] = [];
  if (typeof raw === 'string') {
    try { prices = JSON.parse(raw); } catch { prices = []; }
  } else if (Array.isArray(raw)) {
    prices = raw;
  }
  const yes = parseFloat(prices[0] ?? '0.5');
  const no = parseFloat(prices[1] ?? '0.5');
  return [isNaN(yes) ? 0.5 : yes, isNaN(no) ? 0.5 : no];
}

function detectAsset(question: string, slug: string): Asset {
  const text = (question + slug).toLowerCase();
  if (text.includes('bitcoin') || text.includes('btc')) return 'BTC';
  if (text.includes('ethereum') || text.includes('eth')) return 'ETH';
  if (text.includes('solana') || text.includes('sol')) return 'SOL';
  if (text.includes('xrp') || text.includes('ripple')) return 'XRP';
  return 'BTC';
}

function detectInterval(question: string, slug: string): Interval {
  const text = (question + slug).toLowerCase();
  if (text.includes('15m') || text.includes('15-min') || text.includes('15 min')) return '15m';
  if (text.includes('5m') || text.includes('5-min') || text.includes('5 min')) return '5m';
  // Fallback by timing
  if (text.includes('15')) return '15m';
  return '5m';
}

// Compute epoch end timestamp from slug or endDate
function computeEpochEnd(slug: string, endDate: string, interval: Interval): number {
  // Try to extract epoch from slug: btc-updown-5m-1708000000
  const epochMatch = slug.match(/(\d{9,10})$/);
  if (epochMatch) {
    const epoch = parseInt(epochMatch[1]);
    return epoch + (interval === '5m' ? 300 : 900);
  }
  // Fallback to endDate
  if (endDate) {
    const parsed = new Date(endDate).getTime();
    if (!isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  // Fallback to current epoch
  const now = Math.floor(Date.now() / 1000);
  const epochSize = interval === '5m' ? 300 : 900;
  return now - (now % epochSize) + epochSize;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeMarket(m: any, slug: string): BinaryMarket {
  const question = m.question || m.title || '';
  const interval = detectInterval(question, slug || m.slug || '');
  const asset = detectAsset(question, slug || m.slug || '');
  const endDate = m.endDate || m.end_date_iso || '';
  const epochEnd = computeEpochEnd(slug || m.slug || '', endDate, interval);
  const [yesPrice, noPrice] = parseOutcomePrices(m.outcomePrices);

  const tokens: { token_id?: string; outcome?: string }[] = m.tokens || [];
  const yesToken = tokens.find(t => t.outcome?.toLowerCase() === 'yes');
  const noToken = tokens.find(t => t.outcome?.toLowerCase() === 'no');

  return {
    id: m.id || m.condition_id || '',
    conditionId: m.condition_id || m.conditionId || '',
    slug: slug || m.slug || '',
    question,
    interval,
    asset,
    epochEnd,
    yesTokenId: yesToken?.token_id || tokens[0]?.token_id || '',
    noTokenId: noToken?.token_id || tokens[1]?.token_id || '',
    yesPrice,
    noPrice,
    volume24h: parseFloat(m.volume24hr || m.volume24h || '0'),
    volume: parseFloat(m.volume || '0'),
    liquidity: parseFloat(m.liquidity || '0'),
    active: m.active !== false && !m.closed,
    closed: m.closed === true,
    endDate,
  };
}

async function fetchBySlug(slug: string): Promise<BinaryMarket[]> {
  try {
    const { data } = await axios.get(`${GAMMA_API}/events/slug/${slug}`, { timeout: 6000 });
    if (!data?.markets) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data.markets.map((m: any) => normalizeMarket(m, slug));
  } catch {
    return [];
  }
}

async function fetchBySearch(): Promise<BinaryMarket[]> {
  try {
    const { data } = await axios.get(`${GAMMA_API}/markets`, {
      params: {
        limit: 100,
        active: true,
        closed: false,
        order: 'volume24hr',
        ascending: false,
      },
      timeout: 10000,
    });

    const markets: unknown[] = Array.isArray(data) ? data : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return markets.filter((m: any) => {
      const text = (m.question || '').toLowerCase();
      const isCrypto = Object.values(ASSETS).some(a =>
        a.symbols.some(s => text.includes(s))
      );
      const isBinary = text.includes('up') || text.includes('down') ||
                       text.includes('above') || text.includes('below') ||
                       text.includes('higher') || text.includes('lower');
      const hasShortExpiry = text.includes('5m') || text.includes('15m') ||
                             text.includes('5 min') || text.includes('15 min') ||
                             (m.slug || '').includes('updown');
      return isCrypto && (isBinary || hasShortExpiry);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }).map((m: any) => normalizeMarket(m, m.slug || ''));
  } catch {
    return [];
  }
}

export async function fetchBinaryMarkets(): Promise<BinaryMarket[]> {
  const now = Math.floor(Date.now() / 1000);
  const epoch5m = now - (now % 300);
  const epoch15m = now - (now % 900);

  // Generate epoch-based slugs for all assets and intervals
  const slugs: string[] = [];
  for (const asset of Object.values(ASSETS)) {
    // 5m: current + 2 previous epochs
    slugs.push(`${asset.prefix}-updown-5m-${epoch5m}`);
    slugs.push(`${asset.prefix}-updown-5m-${epoch5m - 300}`);
    slugs.push(`${asset.prefix}-updown-5m-${epoch5m - 600}`);
    // 15m: current + 2 previous epochs
    slugs.push(`${asset.prefix}-updown-15m-${epoch15m}`);
    slugs.push(`${asset.prefix}-updown-15m-${epoch15m - 900}`);
    slugs.push(`${asset.prefix}-updown-15m-${epoch15m - 1800}`);
  }

  // Fetch all slugs + general search in parallel
  const results = await Promise.all([
    ...slugs.map(fetchBySlug),
    fetchBySearch(),
  ]);

  const allMarkets = results.flat();

  // Deduplicate by id/conditionId
  const seen = new Set<string>();
  return allMarkets.filter(m => {
    const key = m.id || m.conditionId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
