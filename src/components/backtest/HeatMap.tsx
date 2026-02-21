const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

function heatColor(winRate: number): string {
  if (winRate >= 0.65) return 'bg-emerald-600 text-white';
  if (winRate >= 0.58) return 'bg-emerald-800 text-emerald-200';
  if (winRate >= 0.52) return 'bg-yellow-800 text-yellow-200';
  if (winRate >= 0.45) return 'bg-orange-900 text-orange-300';
  return 'bg-red-900 text-red-300';
}

export function HeatMap({ byCoinTimeframe }: { byCoinTimeframe: Record<string, any> }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Win Rate Heatmap</h3>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-900 inline-block" /> &lt;45%</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-800 inline-block" /> 52%</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-600 inline-block" /> ≥65%</span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-xs w-full">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left py-1 pr-4 w-10 font-normal">Coin</th>
              {TIMEFRAMES.map((tf) => (
                <th key={tf} className="text-center py-1 px-1.5 font-normal">{tf}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COINS.map((coin) => (
              <tr key={coin}>
                <td className="py-1.5 pr-4 font-medium text-gray-300">{coin}</td>
                {TIMEFRAMES.map((tf) => {
                  const key = `${coin}_${tf}`;
                  const m = byCoinTimeframe[key];
                  const wr = m?.winRate ?? null;
                  const trades = m?.totalTrades ?? 0;
                  return (
                    <td key={tf} className="py-1 px-1 text-center">
                      {wr !== null && trades > 0 ? (
                        <span
                          className={`inline-block px-2 py-1 rounded text-xs font-mono ${heatColor(wr)}`}
                          title={`${trades} trades`}
                        >
                          {(wr * 100).toFixed(0)}%
                        </span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
