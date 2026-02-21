import { useStore, BinaryMarket } from '../store';
import { Countdown } from './Countdown';

const ASSET_COLORS: Record<string, string> = {
  BTC: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  ETH: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  SOL: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  XRP: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
};

const INTERVAL_COLORS: Record<string, string> = {
  '5m': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  '15m': 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
};

function formatUsd(val: number): string {
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}k`;
  return `$${val.toFixed(0)}`;
}

interface MarketCardProps {
  market: BinaryMarket;
}

export function MarketCard({ market }: MarketCardProps) {
  const { setSelectedMarket, selectedMarket } = useStore();
  const isSelected = selectedMarket?.id === market.id;

  const yesPrice = market.yesPrice;
  const noPrice = market.noPrice;
  const spread = Math.abs(yesPrice - noPrice);
  const dominant = yesPrice > noPrice ? 'YES' : 'NO';

  // Shorten question
  const question = market.question.length > 70
    ? market.question.slice(0, 67) + '…'
    : market.question;

  return (
    <div
      onClick={() => setSelectedMarket(isSelected ? null : market)}
      className={`card p-4 cursor-pointer transition-all duration-200 hover:border-gray-600 hover:bg-gray-800/50 ${
        isSelected ? 'border-emerald-500/50 bg-gray-800/80 ring-1 ring-emerald-500/20' : ''
      }`}
    >
      {/* Header badges */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`badge border ${ASSET_COLORS[market.asset]}`}>
          {market.asset}
        </span>
        <span className={`badge border ${INTERVAL_COLORS[market.interval]}`}>
          {market.interval}
        </span>
        {market.closed && (
          <span className="badge bg-gray-700 text-gray-400 border border-gray-600">CLOSED</span>
        )}
      </div>

      {/* Question */}
      <p className="text-sm text-gray-200 font-medium leading-snug mb-4 min-h-[2.5rem]">
        {question}
      </p>

      {/* YES / NO prices */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className={`rounded-lg p-2 text-center ${
          dominant === 'YES' ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-gray-800'
        }`}>
          <div className="text-xs text-gray-400 mb-0.5">YES</div>
          <div className={`text-lg font-bold font-mono ${
            dominant === 'YES' ? 'text-emerald-400' : 'text-gray-300'
          }`}>
            {(yesPrice * 100).toFixed(1)}¢
          </div>
        </div>
        <div className={`rounded-lg p-2 text-center ${
          dominant === 'NO' ? 'bg-red-500/10 border border-red-500/20' : 'bg-gray-800'
        }`}>
          <div className="text-xs text-gray-400 mb-0.5">NO</div>
          <div className={`text-lg font-bold font-mono ${
            dominant === 'NO' ? 'text-red-400' : 'text-gray-300'
          }`}>
            {(noPrice * 100).toFixed(1)}¢
          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <div className="flex items-center gap-3">
          <span title="24h Volume">Vol {formatUsd(market.volume24h)}</span>
          <span title="Liquidity">Liq {formatUsd(market.liquidity)}</span>
          <span title="Spread">Sprd {(spread * 100).toFixed(1)}¢</span>
        </div>
        <Countdown epochEnd={market.epochEnd} />
      </div>
    </div>
  );
}
