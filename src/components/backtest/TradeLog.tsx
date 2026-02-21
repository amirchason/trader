import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Trade {
  time: number;
  coin: string;
  timeframe: string;
  strategy: string;
  signalMode: string;
  direction: string;
  result: string;
  pnl: number;
  equity: number;
}

const PAGE_SIZE = 50;

export function TradeLog({ trades }: { trades: Trade[] }) {
  const [filterCoin, setFilterCoin] = useState('All');
  const [filterResult, setFilterResult] = useState('All');
  const [filterMode, setFilterMode] = useState('All');
  const [page, setPage] = useState(0);

  const coins = ['All', ...new Set(trades.map((t) => t.coin))];
  const modes = ['All', ...new Set(trades.map((t) => t.signalMode))];

  const filtered = trades
    .filter((t) => filterCoin === 'All' || t.coin === filterCoin)
    .filter((t) => filterResult === 'All' || t.result === filterResult)
    .filter((t) => filterMode === 'All' || t.signalMode === filterMode);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safeePage = Math.min(page, totalPages - 1);
  const paginated = filtered.slice(safeePage * PAGE_SIZE, (safeePage + 1) * PAGE_SIZE);

  function handleFilterChange(setter: (v: string) => void) {
    return (e: React.ChangeEvent<HTMLSelectElement>) => {
      setter(e.target.value);
      setPage(0);
    };
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">
          Trade Log{' '}
          <span className="text-gray-500 font-normal text-xs">({filtered.length.toLocaleString()} trades)</span>
        </h3>
        <div className="flex gap-1.5">
          <select value={filterCoin} onChange={handleFilterChange(setFilterCoin)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none">
            {coins.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select value={filterResult} onChange={handleFilterChange(setFilterResult)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none">
            <option>All</option>
            <option>WIN</option>
            <option>LOSS</option>
          </select>
          <select value={filterMode} onChange={handleFilterChange(setFilterMode)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none">
            {modes.map((m) => <option key={m}>{m}</option>)}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="text-left py-1.5 px-2 font-normal">Date</th>
              <th className="text-left py-1.5 px-2 font-normal">Coin</th>
              <th className="text-left py-1.5 px-2 font-normal">TF</th>
              <th className="text-left py-1.5 px-2 font-normal">Mode</th>
              <th className="text-left py-1.5 px-2 font-normal">Direction</th>
              <th className="text-left py-1.5 px-2 font-normal">Result</th>
              <th className="text-right py-1.5 px-2 font-normal">P&L</th>
              <th className="text-right py-1.5 px-2 font-normal">Equity</th>
            </tr>
          </thead>
          <tbody>
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-6 text-gray-600">No trades match the current filters</td>
              </tr>
            ) : (
              paginated.map((t, i) => (
                <tr key={i} className="border-t border-gray-800/40 hover:bg-gray-800/20">
                  <td className="py-1 px-2 text-gray-500">
                    {new Date(t.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </td>
                  <td className="py-1 px-2 text-gray-300 font-medium">{t.coin}</td>
                  <td className="py-1 px-2 text-gray-400">{t.timeframe}</td>
                  <td className="py-1 px-2 text-gray-500">{t.signalMode}</td>
                  <td className={`py-1 px-2 font-medium ${t.direction === 'BULL' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.direction === 'BULL' ? '▲' : '▼'} {t.direction}
                  </td>
                  <td className={`py-1 px-2 font-medium ${t.result === 'WIN' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.result}
                  </td>
                  <td className={`py-1 px-2 text-right font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                  </td>
                  <td className="py-1 px-2 text-right font-mono text-gray-400">{t.equity.toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
          <button
            onClick={() => setPage(Math.max(0, safeePage - 1))}
            disabled={safeePage === 0}
            className="flex items-center gap-1 px-2 py-1 bg-gray-800 rounded hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-3.5 h-3.5" /> Prev
          </button>
          <span>Page {safeePage + 1} / {totalPages}</span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, safeePage + 1))}
            disabled={safeePage >= totalPages - 1}
            className="flex items-center gap-1 px-2 py-1 bg-gray-800 rounded hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
