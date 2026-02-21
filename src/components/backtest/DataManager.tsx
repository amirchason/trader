import { useEffect, useState } from 'react';
import { Database, Download, RefreshCw, CheckCircle, Zap } from 'lucide-react';
import { useStore } from '../../store';
import { fetchDbStatus, triggerDownload, trigger1sDownload } from '../../services/api';

const COINS = ['BTC', 'ETH', 'SOL', 'XRP'];
// Standard Binance timeframes (bulk ZIP + REST fill)
const STANDARD_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'];
// All timeframes shown in grid (including 1s/10s/30s derived from 1s download)
const TIMEFRAMES = ['1s', '10s', '30s', '1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d'];

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function DataManager() {
  const dbStatus = useStore((s) => s.dbStatus);
  const setDbStatus = useStore((s) => s.setDbStatus);
  const [loading, setLoading] = useState(false);
  const [loading1s, setLoading1s] = useState(false);
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
      await triggerDownload(COINS, STANDARD_TIMEFRAMES);
      startPolling(60_000 * 15); // poll 15 min
      setTimeout(() => setLoading(false), 60_000 * 15);
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  }

  async function handleDownload1s() {
    setLoading1s(true);
    setError(null);
    try {
      await trigger1sDownload(COINS);
      startPolling(60_000 * 240); // poll up to 4 hours
      setTimeout(() => setLoading1s(false), 60_000 * 240);
    } catch (err) {
      setError(String(err));
      setLoading1s(false);
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
          Historical Data
          {totalCandles > 0 && (
            <span className="text-xs text-gray-500">({formatCount(totalCandles)} candles stored)</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="p-1.5 text-gray-400 hover:text-white rounded transition-colors"
            title="Refresh status"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleDownload1s}
            disabled={loading1s || loading}
            title="Downloads 6mo of 1s data (~3-4h) and derives 10s/30s automatically"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-700 hover:bg-purple-600 disabled:opacity-50 text-white text-xs rounded font-medium transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            {loading1s ? '1s Downloading...' : 'Download 1s+10s+30s (~4h)'}
          </button>
          <button
            onClick={handleDownloadAll}
            disabled={loading || loading1s}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs rounded font-medium transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            {loading ? 'Downloading...' : 'Download All (6mo)'}
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
                        <span className="flex items-center justify-center gap-1 text-emerald-400">
                          <CheckCircle className="w-3 h-3" />
                          {formatCount(info.count)}
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

      {loading && (
        <div className="mt-3 text-xs text-blue-400 animate-pulse">
          Downloading 1m–1d data in background — updates every 5s...
        </div>
      )}
      {loading1s && (
        <div className="mt-3 text-xs text-purple-400 animate-pulse">
          Downloading 1s data via REST API — this takes ~3-4 hours. 10s and 30s will be auto-derived when done.
        </div>
      )}
    </div>
  );
}
