import { useStore } from '../store';

const ASSET_COLORS: Record<string, string> = {
  BTC: 'text-orange-400',
  ETH: 'text-blue-400',
  SOL: 'text-purple-400',
  XRP: 'text-cyan-400',
};

export function PriceBar() {
  const { btcData, rtdsPrices, connected, lastUpdate } = useStore();

  const btcPrice = rtdsPrices['BTC'] ?? btcData?.price ?? 0;
  const change = btcData?.change24h ?? 0;
  const isUp = change >= 0;

  const timeAgo = lastUpdate
    ? Math.floor((Date.now() - lastUpdate) / 1000)
    : null;

  return (
    <div className="flex items-center justify-between px-6 py-3 bg-gray-900 border-b border-gray-800">
      {/* Logo */}
      <div className="flex items-center gap-3">
        <span className="text-lg font-black tracking-tight text-white">
          TRADER
        </span>
        <span className="badge bg-gray-800 text-gray-400 text-[10px]">
          POLYMARKET BINARY
        </span>
      </div>

      {/* Live prices */}
      <div className="flex items-center gap-6">
        {/* BTC price */}
        <div className="flex items-center gap-2">
          <span className={`font-bold text-sm ${ASSET_COLORS['BTC']}`}>BTC</span>
          <span className="font-mono font-bold text-white">
            ${btcPrice > 0 ? btcPrice.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
          </span>
          <span className={`text-xs font-semibold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
            {isUp ? '+' : ''}{change.toFixed(2)}%
          </span>
        </div>

        {/* Other RTDS prices */}
        {['ETH', 'SOL', 'XRP'].map(asset => {
          const price = rtdsPrices[asset];
          if (!price) return null;
          return (
            <div key={asset} className="flex items-center gap-1.5">
              <span className={`font-bold text-xs ${ASSET_COLORS[asset]}`}>{asset}</span>
              <span className="font-mono text-sm text-gray-200">
                ${price.toLocaleString('en-US', {
                  minimumFractionDigits: asset === 'XRP' ? 4 : 2,
                  maximumFractionDigits: asset === 'XRP' ? 4 : 0,
                })}
              </span>
            </div>
          );
        })}
      </div>

      {/* Connection status */}
      <div className="flex items-center gap-2 text-xs text-gray-500">
        {timeAgo !== null && (
          <span>{timeAgo}s ago</span>
        )}
        <div className={`flex items-center gap-1.5 ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'} ${connected ? 'animate-pulse' : ''}`} />
          <span className="font-semibold">{connected ? 'LIVE' : 'DISCONNECTED'}</span>
        </div>
      </div>
    </div>
  );
}
