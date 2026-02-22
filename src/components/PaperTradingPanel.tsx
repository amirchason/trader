import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, RefreshCw, Trash2, DollarSign, Activity, Award } from 'lucide-react';
import { useStore } from '../store';
import { fetchPaperPositions, fetchPaperPnl, fetchPaperTrades, closePaperTrade, resetPaperTrading } from '../services/api';
import type { PaperTrade, PnlSummary } from '../store';
import { StrategyAutomation } from './StrategyAutomation';
import { StrategyCharts } from './StrategyCharts';

function PnlBadge({ value }: { value: number }) {
  const positive = value >= 0;
  return (
    <span className={`font-mono font-semibold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
      {positive ? '+' : ''}${value.toFixed(2)}
    </span>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-gray-800 rounded-lg p-3 flex flex-col gap-0.5">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-lg font-semibold font-mono text-white">{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function PaperTradingPanel() {
  const { paperPositions, paperPnl, setPaperPositions, setPaperPnl } = useStore();
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [activeTab, setActiveTab] = useState<'positions' | 'history'>('positions');
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function loadData() {
    setLoading(true);
    try {
      const [pos, pnl, history] = await Promise.all([
        fetchPaperPositions(),
        fetchPaperPnl(),
        fetchPaperTrades(),
      ]);
      setPaperPositions(pos);
      setPaperPnl(pnl);
      setTrades(history);
      setLastRefresh(new Date());
    } catch (e) {
      console.error('[PaperTrading] Load error:', e);
    } finally {
      setLoading(false);
    }
  }

  // Initial load + 10s auto-refresh
  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10_000);
    return () => clearInterval(interval);
  }, []);

  // Also refresh when SSE pushes updates
  useEffect(() => {
    setLastRefresh(new Date());
    // Fetch full trade history when SSE arrives (positions+pnl already in store)
    fetchPaperTrades().then(setTrades).catch(() => {});
  }, [paperPositions, paperPnl]);

  async function handleClose(id: string) {
    const pos = paperPositions.find(p => p.id === id);
    if (!pos) return;
    const exitPrice = pos.direction === 'YES' ? 0.95 : 0.05;
    await closePaperTrade(id, exitPrice);
    await loadData();
  }

  async function handleReset() {
    if (!confirm('Clear ALL paper trades and reset balance to $1,000?')) return;
    await resetPaperTrading();
    await loadData();
  }

  const pnl: PnlSummary = paperPnl ?? {
    totalTrades: 0, openCount: 0, closedCount: 0,
    realizedPnl: 0, unrealizedPnl: 0,
    balance: 1000, equity: 1000, startingBalance: 1000,
    winRate: 0, wins: 0, losses: 0,
  };

  const balancePct = ((pnl.balance - pnl.startingBalance) / pnl.startingBalance) * 100;
  const balanceColor = pnl.balance >= pnl.startingBalance ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="flex flex-col gap-4 p-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg font-semibold text-white">Paper Trading</h2>
          <span className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded">$1,000 Starting Balance</span>
        </div>
        <div className="flex items-center gap-2">
          {lastRefresh && (
            <span className="text-xs text-gray-600">
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-400 border border-gray-700 rounded hover:border-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={handleReset}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-red-400 border border-red-900 rounded hover:bg-red-900/20 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
            Reset
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
        <div className="bg-gray-800 rounded-lg p-3 flex flex-col gap-0.5 col-span-2">
          <div className="text-xs text-gray-400">Account Balance</div>
          <div className={`text-2xl font-bold font-mono ${balanceColor}`}>
            ${pnl.balance.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500">
            {balancePct >= 0 ? '+' : ''}{balancePct.toFixed(2)}% vs starting $1,000
          </div>
        </div>
        <StatCard
          label="Realized P&L"
          value={`${pnl.realizedPnl >= 0 ? '+' : ''}$${pnl.realizedPnl.toFixed(2)}`}
          sub={`${pnl.closedCount} closed trades`}
        />
        <StatCard
          label="Win Rate"
          value={pnl.closedCount > 0 ? `${pnl.winRate}%` : '—'}
          sub={`${pnl.wins}W / ${pnl.losses}L`}
        />
        <StatCard
          label="Open Positions"
          value={String(pnl.openCount)}
          sub={`${pnl.totalTrades} total trades`}
        />
        <StatCard
          label="Equity"
          value={`$${pnl.equity.toFixed(2)}`}
          sub="balance + unrealized"
        />
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-800">
        {(['positions', 'history'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab
                ? 'text-white border-blue-500'
                : 'text-gray-400 border-transparent hover:text-gray-200'
            }`}
          >
            {tab === 'positions' ? `Open Positions (${pnl.openCount})` : `Trade History (${pnl.closedCount})`}
          </button>
        ))}
      </div>

      {/* Positions Table */}
      {activeTab === 'positions' && (
        <div className="overflow-x-auto">
          {paperPositions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500 gap-3">
              <Activity className="w-8 h-8 opacity-40" />
              <p className="text-sm">No open positions</p>
              <p className="text-xs text-gray-600">Positions will appear here when paper trades are placed via the Agent Console or API</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="py-2 pr-3">Time</th>
                  <th className="py-2 pr-3">Asset</th>
                  <th className="py-2 pr-3">Direction</th>
                  <th className="py-2 pr-3">Entry</th>
                  <th className="py-2 pr-3">Size</th>
                  <th className="py-2 pr-3">Strategy</th>
                  <th className="py-2 pr-3">Confidence</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {paperPositions.map(pos => (
                  <tr key={pos.id} className="hover:bg-gray-800/50 transition-colors">
                    <td className="py-2 pr-3 text-gray-400 text-xs whitespace-nowrap">
                      {new Date(pos.created_at).toLocaleTimeString()}
                    </td>
                    <td className="py-2 pr-3 font-semibold text-white">{pos.asset}</td>
                    <td className="py-2 pr-3">
                      <span className={`flex items-center gap-1 font-medium ${
                        pos.direction === 'YES' ? 'text-emerald-400' : 'text-red-400'
                      }`}>
                        {pos.direction === 'YES'
                          ? <TrendingUp className="w-3.5 h-3.5" />
                          : <TrendingDown className="w-3.5 h-3.5" />}
                        {pos.direction}
                      </span>
                    </td>
                    <td className="py-2 pr-3 font-mono text-gray-300">${pos.entry_price.toFixed(3)}</td>
                    <td className="py-2 pr-3 font-mono text-gray-300">${pos.size.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-gray-400 text-xs max-w-[140px] truncate">
                      {pos.strategy ?? '—'}
                    </td>
                    <td className="py-2 pr-3">
                      {pos.confidence != null ? (
                        <span className={`text-xs font-mono ${
                          pos.confidence >= 70 ? 'text-emerald-400' : pos.confidence >= 50 ? 'text-yellow-400' : 'text-gray-400'
                        }`}>
                          {pos.confidence}%
                        </span>
                      ) : '—'}
                    </td>
                    <td className="py-2">
                      <button
                        onClick={() => handleClose(pos.id)}
                        className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:border-red-700 hover:text-red-400 transition-colors"
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* History Table */}
      {activeTab === 'history' && (
        <div className="overflow-x-auto">
          {trades.filter(t => t.status !== 'OPEN').length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500 gap-3">
              <Award className="w-8 h-8 opacity-40" />
              <p className="text-sm">No closed trades yet</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="py-2 pr-3">Closed</th>
                  <th className="py-2 pr-3">Asset</th>
                  <th className="py-2 pr-3">Dir</th>
                  <th className="py-2 pr-3">Entry</th>
                  <th className="py-2 pr-3">Exit</th>
                  <th className="py-2 pr-3">Size</th>
                  <th className="py-2 pr-3">P&L</th>
                  <th className="py-2 pr-3">Strategy</th>
                  <th className="py-2 pr-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                {trades
                  .filter(t => t.status !== 'OPEN')
                  .map(t => (
                    <tr key={t.id} className="hover:bg-gray-800/50 transition-colors">
                      <td className="py-2 pr-3 text-gray-400 text-xs whitespace-nowrap">
                        {t.closed_at ? new Date(t.closed_at).toLocaleString() : '—'}
                      </td>
                      <td className="py-2 pr-3 font-semibold text-white">{t.asset}</td>
                      <td className="py-2 pr-3">
                        <span className={`text-xs font-medium ${
                          t.direction === 'YES' ? 'text-emerald-400' : 'text-red-400'
                        }`}>{t.direction}</span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-gray-300 text-xs">${t.entry_price.toFixed(3)}</td>
                      <td className="py-2 pr-3 font-mono text-gray-300 text-xs">
                        {t.exit_price != null ? `$${t.exit_price.toFixed(3)}` : '—'}
                      </td>
                      <td className="py-2 pr-3 font-mono text-gray-300 text-xs">${t.size.toFixed(2)}</td>
                      <td className="py-2 pr-3 text-xs">
                        {t.pnl != null ? <PnlBadge value={t.pnl} /> : '—'}
                      </td>
                      <td className="py-2 pr-3 text-gray-400 text-xs max-w-[140px] truncate">
                        {t.strategy ?? '—'}
                      </td>
                      <td className="py-2 pr-3">
                        {t.pnl != null ? (
                          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${
                            t.pnl > 0
                              ? 'bg-emerald-900/40 text-emerald-400'
                              : 'bg-red-900/40 text-red-400'
                          }`}>
                            {t.pnl > 0 ? 'WIN' : 'LOSS'}
                          </span>
                        ) : (
                          <span className="text-xs text-gray-500">{t.status}</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Strategy Automation */}
      <StrategyAutomation />

      {/* Strategy Charts */}
      <StrategyCharts />
    </div>
  );
}
