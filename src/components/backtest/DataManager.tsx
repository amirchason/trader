import { useEffect, useState } from 'react';
import { Database, Download, RefreshCw, CheckCircle, Zap, GitMerge } from 'lucide-react';
import { useStore } from '../../store';
import { fetchDbStatus, triggerDownload, trigger1sDownload, triggerDerive10m } from '../../services/api';

const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
// Standard Binance timeframes (bulk ZIP + REST fill, 3 years)
const STANDARD_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'];
// All timeframes shown in grid
// 5s = derived from 1s ZIPs (Binance has no 5s interval)
// 10m = derived from 5m pairs (Binance has no 10m interval)
const TIMEFRAMES = ['5s', '1m', '5m', '10m', '15m', '30m', '1h', '4h', '12h', '1d'];

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

export function DataManager() {
  const dbStatus = useStore((s) => s.dbStatus);
  const setDbStatus = useStore((s) => s.setDbStatus);
  const [loading, setLoading] = useState(false);
  const [loading5s, setLoading5s] = useState(false);
  const [loading10m, setLoading10m] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const data = await fetchDbStatus();
      setDbStatus(data.status ?? {});
    } catch {
      // ignore
    }
  }

  useEffect(() => { refresh(); }, []);

  function startPolling(durationMs: number) {
    let polls = 0;
    const maxPolls = durationMs / 5000;
    const interval = setInterval(async () => {
      await refresh();
      polls++;
      if (polls > maxPolls) clearInterval(interval);
    }, 5000);
  }

  async function handleDownloadAll() {
    setLoading(true);
    setError(null);
    try {
      await triggerDownload(COINS, STANDARD_TIMEFRAMES, 36);
      startPolling(60_000 * 60); // poll up to 60 min
      setTimeout(() => setLoading(false), 60_000 * 60);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function handleDownload5s() {
    setLoading5s(true);
    setError(null);
    try {
      await trigger1sDownload(COINS, 36);
      startPolling(60_000 * 480); // poll up to 8 hours
      setTimeout(() => setLoading5s(false), 60_000 * 480);
    } catch (err) {
      setError(String(err));
      setLoading5s(false);
    }
  }

  async function handleDerive10m() {
    setLoading10m(true);
    setError(null);
    try {
      await triggerDerive10m(COINS);
      startPolling(60_000 * 5); // poll 5 min
      setTimeout(() => setLoading10m(false), 60_000 * 5);
    } catch (err) {
      setError(String(err));
      setLoading10m(false);
    }
  }

  const totalCandles = Object.values(dbStatus).reduce(
    (sum, tfs) => sum + Object.values(tfs).reduce((s, v) => s + v.count, 0),
    0,
  );

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-200">
          <Database className="w-4 h-4 text-blue-400" />
          Historical Data (3 years)
          {totalCandles > 0 && (
            <span className="text-xs text-gray-500">({formatCount(totalCandles)} candles stored)</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={refresh}
            className="p-1.5 text-gray-400 hover:text-white rounded transition-colors"
            title="Refresh status"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDerive10m}
            disabled={loading10m || loading || loading5s}
            title="Derive 10m candles from 5m data (Binance has no 10m interval)"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs rounded font-medium transition-colors"
          >
            <GitMerge className="w-3.5 h-3.5" />
            {loading10m ? 'Deriving...' : 'Derive 10m'}
          </button>
          <button
            onClick={handleDownload5s}
            disabled={loading5s || loading}
            title="Downloads 1s ZIPs (3 years per coin, ~8-24h) and aggregates to 5s. 1s raw data is NOT stored."
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-xs rounded font-medium transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            {loading5s ? '5s Downloading...' : 'Download 5s (3yr, ~8-24h)'}
          </button>
          <button
            onClick={handleDownloadAll}
            disabled={loading || loading5s}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded font-medium transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            {loading ? 'Downloading...' : 'Download 1m–1d (3yr)'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3 text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">{error}</div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left py-1 pr-3 font-normal">Coin</th>
              {TIMEFRAMES.map((tf) => (
                <th key={tf} className="text-center py-1 px-2 font-normal">{tf}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COINS.map((coin) => (
              <tr key={coin} className="border-t border-gray-800/60">
                <td className="py-1.5 pr-3 font-medium text-gray-300">{coin}</td>
                {TIMEFRAMES.map((tf) => {
                  const info = dbStatus[coin]?.[tf];
                  return (
                    <td key={tf} className="text-center py-1.5 px-2">
                      {info ? (
                        <span className="flex flex-col items-center gap-0.5 text-emerald-400">
                          <span className="flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" />
                            {formatCount(info.count)}
                          </span>
                          {info.earliest > 0 && (
                            <span className="text-gray-600 text-[10px]">
                              {formatDate(info.earliest)}
                            </span>
                          )}
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

      <div className="mt-2 text-[10px] text-gray-600 space-y-0.5">
        <div>5s = derived in-process from 1s ZIPs (Binance has no 5s interval; raw 1s not stored)</div>
        <div>10m = derived from 5m pairs (click "Derive 10m" after downloading 5m data)</div>
      </div>

      {loading && (
        <div className="mt-3 text-xs text-blue-400 animate-pulse">
          Downloading 1m–1d data (3 years) in background — updates every 5s...
        </div>
      )}
      {loading5s && (
        <div className="mt-3 text-xs text-purple-400 animate-pulse">
          Downloading 3 years of 1s ZIPs → aggregating to 5s. Estimated 8-24h depending on connection.
        </div>
      )}
      {loading10m && (
        <div className="mt-3 text-xs text-emerald-400 animate-pulse">
          Deriving 10m candles from 5m data in background...
        </div>
      )}
    </div>
  );
}
