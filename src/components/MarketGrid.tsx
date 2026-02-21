import { useState, useMemo } from 'react';
import { useStore, BinaryMarket } from '../store';
import { MarketCard } from './MarketCard';

type SortKey = 'status' | 'volume' | 'liquidity' | 'expiry' | 'spread';

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'status', label: 'Active First' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'volume', label: 'Volume' },
  { key: 'liquidity', label: 'Liquidity' },
  { key: 'spread', label: 'Spread' },
];

function sortMarkets(markets: BinaryMarket[], sortBy: SortKey): BinaryMarket[] {
  const now = Math.floor(Date.now() / 1000);

  return [...markets].sort((a, b) => {
    // Always push closed/expired to the bottom
    const aLive = !a.closed && a.epochEnd > now;
    const bLive = !b.closed && b.epochEnd > now;
    if (aLive !== bLive) return aLive ? -1 : 1;

    switch (sortBy) {
      case 'status': {
        // Among live markets, sooner expiry first (most urgent)
        return a.epochEnd - b.epochEnd;
      }
      case 'expiry': {
        // Closest expiry first
        return a.epochEnd - b.epochEnd;
      }
      case 'volume': {
        // Highest volume first
        return b.volume24h - a.volume24h;
      }
      case 'liquidity': {
        // Highest liquidity first
        return b.liquidity - a.liquidity;
      }
      case 'spread': {
        // Tightest spread first (lower is better)
        const spreadA = Math.abs(a.yesPrice - a.noPrice);
        const spreadB = Math.abs(b.yesPrice - b.noPrice);
        return spreadA - spreadB;
      }
      default:
        return 0;
    }
  });
}

export function MarketGrid() {
  const { markets } = useStore();
  const [sortBy, setSortBy] = useState<SortKey>('status');

  const now = Math.floor(Date.now() / 1000);

  const sorted5m = useMemo(
    () => sortMarkets(markets.filter(m => m.interval === '5m'), sortBy),
    [markets, sortBy]
  );
  const sorted15m = useMemo(
    () => sortMarkets(markets.filter(m => m.interval === '15m'), sortBy),
    [markets, sortBy]
  );

  const live5m = sorted5m.filter(m => !m.closed && m.epochEnd > now).length;
  const live15m = sorted15m.filter(m => !m.closed && m.epochEnd > now).length;

  if (markets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-gray-500">
        <div className="text-4xl mb-4 animate-pulse">⏳</div>
        <p className="text-sm">Loading binary markets…</p>
        <p className="text-xs mt-1 text-gray-600">Fetching from Polymarket Gamma API</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Sort controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs text-gray-500">
          {live5m + live15m} active / {markets.length} total markets
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-gray-600 uppercase tracking-wider mr-1">Sort</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              className={`px-2 py-1 text-[10px] font-semibold rounded-md transition-colors ${
                sortBy === opt.key
                  ? 'bg-gray-700 text-white'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* 5M Column */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">5-Minute Markets</h2>
            <span className="badge bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
              {live5m}
            </span>
            {sorted5m.length > live5m && (
              <span className="text-[10px] text-gray-600">+{sorted5m.length - live5m} expired</span>
            )}
          </div>
          {sorted5m.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No 5m markets found</p>
          ) : (
            <div className="flex flex-col gap-3">
              {sorted5m.map(m => (
                <MarketCard key={m.id || m.conditionId} market={m} />
              ))}
            </div>
          )}
        </div>

        {/* 15M Column */}
        <div>
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">15-Minute Markets</h2>
            <span className="badge bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
              {live15m}
            </span>
            {sorted15m.length > live15m && (
              <span className="text-[10px] text-gray-600">+{sorted15m.length - live15m} expired</span>
            )}
          </div>
          {sorted15m.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No 15m markets found</p>
          ) : (
            <div className="flex flex-col gap-3">
              {sorted15m.map(m => (
                <MarketCard key={m.id || m.conditionId} market={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
