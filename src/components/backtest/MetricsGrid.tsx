import { useState } from 'react';
import { ArrowUpDown } from 'lucide-react';

interface MetricRow {
  key: string;
  coin: string;
  timeframe: string;
  winRate: number;
  totalPnl: number;
  sharpe: number;
  maxDrawdown: number;
  totalTrades: number;
  profitFactor: number;
}

type SortKey = 'winRate' | 'totalPnl' | 'sharpe' | 'maxDrawdown' | 'totalTrades' | 'profitFactor';

export function MetricsGrid({ byCoinTimeframe }: { byCoinTimeframe: Record<string, any> }) {
  const [sortKey, setSortKey] = useState<SortKey>('winRate');
  const [sortAsc, setSortAsc] = useState(false);
  const [filterCoin, setFilterCoin] = useState('All');
  const [filterTf, setFilterTf] = useState('All');

  const rows: MetricRow[] = Object.entries(byCoinTimeframe).map(([k, m]: [string, any]) => {
    const parts = k.split('_');
    return {
      key: k,
      coin: parts[0] ?? k,
      timeframe: parts[1] ?? '',
      winRate: m.winRate ?? 0,
      totalPnl: m.totalPnl ?? 0,
      sharpe: m.sharpe ?? 0,
      maxDrawdown: m.maxDrawdown ?? 0,
      totalTrades: m.totalTrades ?? 0,
      profitFactor: m.profitFactor ?? 0,
    };
  });

  const coins = ['All', ...new Set(rows.map((r) => r.coin))];
  const tfs = ['All', ...new Set(rows.map((r) => r.timeframe))];

  const filtered = rows
    .filter((r) => filterCoin === 'All' || r.coin === filterCoin)
    .filter((r) => filterTf === 'All' || r.timeframe === filterTf)
    .sort((a, b) =>
      sortAsc ? a[sortKey] - b[sortKey] : b[sortKey] - a[sortKey],
    );

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  const ColHeader = ({ k, label }: { k: SortKey; label: string }) => (
    <th
      className="text-right py-1.5 px-2 font-normal cursor-pointer hover:text-white select-none whitespace-nowrap"
      onClick={() => toggleSort(k)}
    >
      <span className="inline-flex items-center justify-end gap-1">
        {label}
        <ArrowUpDown className={`w-3 h-3 ${sortKey === k ? 'opacity-100 text-blue-400' : 'opacity-40'}`} />
      </span>
    </th>
  );

  if (rows.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 text-center text-gray-600 text-sm">
        No results data available
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-200">Performance by Coin × Timeframe</h3>
        <div className="flex gap-2">
          <select
            value={filterCoin}
            onChange={(e) => setFilterCoin(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none"
          >
            {coins.map((c) => <option key={c}>{c}</option>)}
          </select>
          <select
            value={filterTf}
            onChange={(e) => setFilterTf(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded px-2 py-1 focus:outline-none"
          >
            {tfs.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-gray-500">
            <tr>
              <th className="text-left py-1.5 px-2 font-normal">Pair</th>
              <ColHeader k="winRate" label="Win Rate" />
              <ColHeader k="totalPnl" label="P&L ($)" />
              <ColHeader k="sharpe" label="Sharpe" />
              <ColHeader k="maxDrawdown" label="Drawdown" />
              <ColHeader k="profitFactor" label="P.Factor" />
              <ColHeader k="totalTrades" label="Trades" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.key} className="border-t border-gray-800/50 hover:bg-gray-800/20">
                <td className="py-1.5 px-2 font-medium text-gray-300">
                  {r.coin} <span className="text-gray-500">{r.timeframe}</span>
                </td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.winRate >= 0.55 ? 'text-emerald-400' : r.winRate >= 0.45 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {(r.winRate * 100).toFixed(1)}%
                </td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {r.totalPnl >= 0 ? '+' : ''}{r.totalPnl.toFixed(2)}
                </td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.sharpe >= 1 ? 'text-emerald-400' : r.sharpe >= 0 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {r.sharpe.toFixed(2)}
                </td>
                <td className="text-right py-1.5 px-2 font-mono text-orange-400">
                  {(r.maxDrawdown * 100).toFixed(1)}%
                </td>
                <td className={`text-right py-1.5 px-2 font-mono ${r.profitFactor >= 1.5 ? 'text-emerald-400' : r.profitFactor >= 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                  {r.profitFactor.toFixed(2)}x
                </td>
                <td className="text-right py-1.5 px-2 text-gray-400 font-mono">
                  {r.totalTrades.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
