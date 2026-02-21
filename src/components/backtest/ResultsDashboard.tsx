import { useEffect, useState } from 'react';
import { TrendingUp, Grid, List } from 'lucide-react';
import { useStore } from '../../store';
import { fetchBacktestJob } from '../../services/api';
import { MetricsGrid } from './MetricsGrid';
import { HeatMap } from './HeatMap';
import { EquityCurve } from './EquityCurve';
import { TradeLog } from './TradeLog';

type ActiveTab = 'overview' | 'heatmap' | 'trades';

export function ResultsDashboard() {
  const selectedJobId = useStore((s) => s.selectedJobId);
  const jobs = useStore((s) => s.backtestJobs);
  const playbackCandles = useStore((s) => s.playbackCandles);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');

  const selectedJob = jobs.find((j) => j.id === selectedJobId);
  const isRunning = selectedJob?.status === 'running';

  useEffect(() => {
    if (!selectedJobId) { setResult(null); return; }
    if (selectedJob?.status !== 'completed') return;

    setLoading(true);
    fetchBacktestJob(selectedJobId)
      .then((j) => setResult(j.result))
      .catch(() => setResult(null))
      .finally(() => setLoading(false));
  }, [selectedJobId, selectedJob?.status]);

  if (!selectedJobId) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center">
        <div className="text-gray-500 text-sm">Select a completed job from the queue to view results</div>
        <div className="text-gray-700 text-xs mt-1">Running jobs show live playback here</div>
      </div>
    );
  }

  if (isRunning && selectedJobId) {
    const liveCandles = playbackCandles[selectedJobId] ?? [];
    return (
      <div className="flex flex-col gap-4">
        <div className="bg-gray-900 border border-blue-800/50 rounded-lg p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-blue-400 mb-3">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            Live Backtest Running — {selectedJob.progress}% complete
          </div>
          <div className="w-full bg-gray-800 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-500"
              style={{ width: `${selectedJob.progress}%` }}
            />
          </div>
          {liveCandles.length > 0 && (
            <div className="mt-3 text-xs text-gray-500">
              Streaming {liveCandles.length} candles...
            </div>
          )}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center text-gray-500 text-sm">
        Loading results...
      </div>
    );
  }

  if (!result) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-10 text-center text-gray-500 text-sm">
        No results available for this job
      </div>
    );
  }

  const summary = result.summary ?? {};
  const summaryCards = [
    {
      label: 'Win Rate',
      value: summary.winRate != null ? `${(summary.winRate * 100).toFixed(1)}%` : '—',
      color: (summary.winRate ?? 0) >= 0.55 ? 'text-emerald-400' : 'text-red-400',
    },
    {
      label: 'Total P&L',
      value: summary.totalPnl != null ? `${summary.totalPnl >= 0 ? '+' : ''}$${summary.totalPnl.toFixed(2)}` : '—',
      color: (summary.totalPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400',
    },
    {
      label: 'Sharpe Ratio',
      value: summary.sharpe != null ? summary.sharpe.toFixed(2) : '—',
      color: (summary.sharpe ?? 0) >= 1 ? 'text-emerald-400' : 'text-yellow-400',
    },
    {
      label: 'Max Drawdown',
      value: summary.maxDrawdown != null ? `${(summary.maxDrawdown * 100).toFixed(1)}%` : '—',
      color: 'text-orange-400',
    },
    {
      label: 'Total Trades',
      value: summary.totalTrades?.toLocaleString() ?? '—',
      color: 'text-gray-200',
    },
    {
      label: 'Profit Factor',
      value: summary.profitFactor != null ? `${summary.profitFactor.toFixed(2)}x` : '—',
      color: (summary.profitFactor ?? 0) >= 1.5 ? 'text-emerald-400' : 'text-yellow-400',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Summary cards */}
      <div className="grid grid-cols-6 gap-3">
        {summaryCards.map((c) => (
          <div key={c.label} className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <div className={`text-lg font-bold font-mono ${c.color}`}>{c.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Tab navigation */}
      <div className="flex gap-1">
        {[
          { id: 'overview' as ActiveTab, icon: TrendingUp, label: 'Overview' },
          { id: 'heatmap' as ActiveTab, icon: Grid, label: 'Heatmap' },
          { id: 'trades' as ActiveTab, icon: List, label: 'Trade Log' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-medium transition-colors ${
              activeTab === tab.id
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:text-white'
            }`}
          >
            <tab.icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <>
          <EquityCurve curve={summary.equityCurve ?? []} />
          <MetricsGrid byCoinTimeframe={result.byCoinTimeframe ?? {}} />
        </>
      )}

      {activeTab === 'heatmap' && (
        <HeatMap byCoinTimeframe={result.byCoinTimeframe ?? {}} />
      )}

      {activeTab === 'trades' && (
        <TradeLog trades={result.trades ?? []} />
      )}
    </div>
  );
}
