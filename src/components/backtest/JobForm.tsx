import { useState } from 'react';
import { Play } from 'lucide-react';
import { useStore } from '../../store';
import { submitBacktestJob, fetchBacktestJobs } from '../../services/api';

const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TIMEFRAMES = ['10s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'];
const STRATEGIES = [
  { id: 'all', label: 'All Strategies' },
  { id: 'momentum_burst', label: '🚀 Momentum Burst' },
  { id: 'mean_reversion', label: '↩️ Mean Reversion' },
  { id: 'funding_squeeze', label: '💰 Funding Squeeze' },
  { id: 'order_book', label: '📊 Order Book' },
  { id: 'vwap', label: '📈 VWAP Signal' },
  { id: 'combined', label: '⚡ Combined' },
];
const SIGNAL_MODES = [
  { id: 'threshold', label: 'Threshold (≥ N)' },
  { id: 'crossover', label: 'Crossover (flip)' },
  { id: 'every_candle', label: 'Every Candle' },
  { id: 'combined', label: 'Combined Score' },
];

function MultiSelect<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
  label: string;
}) {
  const toggle = (id: T) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  return (
    <div>
      <label className="text-xs text-gray-400 mb-1.5 block">{label}</label>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <button
            key={opt.id}
            onClick={() => toggle(opt.id)}
            className={`px-2 py-1 text-xs rounded border transition-colors ${
              value.includes(opt.id)
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function JobForm() {
  const setBacktestJobs = useStore((s) => s.setBacktestJobs);
  const addNotification = useStore((s) => s.addNotification);

  const [coins, setCoins] = useState<string[]>(['BTC']);
  const [timeframes, setTimeframes] = useState<string[]>(['5m', '15m']);
  const [strategies, setStrategies] = useState<string[]>(['all']);
  const [signalModes, setSignalModes] = useState<string[]>(['threshold', 'combined']);
  const [threshold, setThreshold] = useState(7);
  const [capital, setCapital] = useState(100);
  const [monthsBack, setMonthsBack] = useState(6);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!coins.length || !timeframes.length || !signalModes.length) {
      addNotification('Please select at least one coin, timeframe, and signal mode.', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const fromMs = Date.now() - monthsBack * 30 * 24 * 60 * 60 * 1000;
      const toMs = Date.now();

      await submitBacktestJob({
        coins,
        timeframes,
        strategies,
        signalModes,
        thresholdMin: threshold,
        initialCapital: capital,
        fromMs,
        toMs,
      });

      const jobs = await fetchBacktestJobs();
      setBacktestJobs(jobs);
      addNotification('Backtest job submitted! Check the Job Queue.', 'info');
    } catch (err) {
      addNotification(`Failed to submit: ${String(err)}`, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-gray-200">Configure Backtest</h3>

      <MultiSelect
        options={COINS.map((c) => ({ id: c, label: c }))}
        value={coins}
        onChange={setCoins}
        label="Coins"
      />

      <MultiSelect
        options={TIMEFRAMES.map((t) => ({ id: t, label: t }))}
        value={timeframes}
        onChange={setTimeframes}
        label="Timeframes"
      />

      <MultiSelect
        options={STRATEGIES as any}
        value={strategies}
        onChange={setStrategies}
        label="Strategies"
      />

      <MultiSelect
        options={SIGNAL_MODES as any}
        value={signalModes}
        onChange={setSignalModes}
        label="Signal Modes"
      />

      <div>
        <label className="text-xs text-gray-400 mb-1.5 flex justify-between">
          <span>Min Score Threshold</span>
          <span className="text-blue-400 font-mono font-medium">{threshold}/10</span>
        </label>
        <input
          type="range"
          min={1}
          max={10}
          step={0.5}
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-xs text-gray-600 mt-0.5">
          <span>1 (loose)</span>
          <span>10 (strict)</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Initial Capital ($)</label>
          <input
            type="number"
            value={capital}
            min={10}
            onChange={(e) => setCapital(Math.max(10, parseInt(e.target.value, 10) || 100))}
            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          />
        </div>
        <div>
          <label className="text-xs text-gray-400 mb-1 block">Date Range</label>
          <select
            value={monthsBack}
            onChange={(e) => setMonthsBack(parseInt(e.target.value, 10))}
            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded px-2 py-1.5 focus:outline-none"
          >
            <option value={1}>Last 1 month</option>
            <option value={3}>Last 3 months</option>
            <option value={6}>Last 6 months</option>
          </select>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting || !coins.length || !timeframes.length}
        className="flex items-center justify-center gap-2 w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded transition-colors"
      >
        <Play className="w-4 h-4" />
        {submitting ? 'Submitting...' : 'Run Backtest'}
      </button>
    </div>
  );
}
