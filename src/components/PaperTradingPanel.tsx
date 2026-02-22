import { useEffect, useRef, useState } from 'react';
import {
  createChart, IChartApi, ISeriesApi, ColorType, CrosshairMode, UTCTimestamp,
} from 'lightweight-charts';
import { TrendingUp, TrendingDown, RefreshCw, Trash2, DollarSign, Activity, Award, BarChart2, ChevronDown } from 'lucide-react';
import { useStore } from '../store';
import { fetchPaperPositions, fetchPaperPnl, fetchPaperTrades, closePaperTrade, resetPaperTrading } from '../services/api';
import type { PaperTrade, PnlSummary, Candle } from '../store';
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

function CountdownTimer({ createdAt, intervalM }: { createdAt: string; intervalM: number }) {
  const closeMs = new Date(createdAt).getTime() + intervalM * 60_000;
  const [msLeft, setMsLeft] = useState(() => closeMs - Date.now());

  useEffect(() => {
    const tick = setInterval(() => setMsLeft(closeMs - Date.now()), 1000);
    return () => clearInterval(tick);
  }, [closeMs]);

  if (msLeft <= 0) {
    return <span className="text-xs font-mono font-bold text-red-400 animate-pulse">EXPIRED</span>;
  }

  const totalSec = Math.ceil(msLeft / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const display = `${min}:${String(sec).padStart(2, '0')}`;
  const pct = Math.max(0, msLeft / (intervalM * 60_000));
  const color = pct > 0.5 ? 'text-emerald-400' : pct > 0.2 ? 'text-yellow-400' : 'text-red-400';
  const barColor = pct > 0.5 ? 'bg-emerald-500' : pct > 0.2 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="flex flex-col gap-0.5 min-w-[52px]">
      <span className={`text-xs font-mono font-bold tabular-nums ${color}`}>{display}</span>
      <div className="h-1 rounded-full bg-gray-700 overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

function PositionChart({ pos, candles, livePrice, tfLabel }: {
  pos: PaperTrade;
  candles: Candle[];
  livePrice: number | null;
  tfLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strikePriceLineRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const livePriceLineRef = useRef<any>(null);
  const hasFitRef = useRef(false);

  const entryTs = new Date(pos.created_at).getTime();
  const sorted = [...candles].sort((a, b) => a.openTime - b.openTime).slice(-80);

  // The candle open at trade entry = binary strike price (closest candle before entry)
  const entryCandle = sorted.filter(c => c.openTime <= entryTs + 60_000).at(-1);
  const strikePrice = entryCandle?.open ?? null;

  const isOpen = pos.status === 'OPEN';
  const currentWinning = livePrice != null && strikePrice != null
    ? (pos.direction === 'YES' ? livePrice > strikePrice : livePrice < strikePrice)
    : null;

  // ── Create chart ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 170,
      layout: {
        background: { type: ColorType.Solid, color: '#0f172a' },
        textColor: '#9ca3af',
        fontSize: 10,
      },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#334155', rightOffset: 3 },
      rightPriceScale: { borderColor: '#334155', scaleMargins: { top: 0.1, bottom: 0.05 } },
      handleScroll: true,
      handleScale: true,
    });
    chartRef.current = chart;

    const series = chart.addCandlestickSeries({
      upColor: '#10b981', downColor: '#ef4444',
      wickUpColor: '#10b981', wickDownColor: '#ef4444',
      borderVisible: false,
    });
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      strikePriceLineRef.current = null;
      livePriceLineRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Update candle data ─────────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !sorted.length) return;
    series.setData(sorted.map(c => ({
      time: Math.floor(c.openTime / 1000) as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    if (!hasFitRef.current) {
      chartRef.current?.timeScale().fitContent();
      hasFitRef.current = true;
    }
  }, [candles]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Strike / target price line ─────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || strikePrice == null) return;
    if (strikePriceLineRef.current) {
      try { series.removePriceLine(strikePriceLineRef.current); } catch { /* ignore */ }
    }
    strikePriceLineRef.current = series.createPriceLine({
      price: strikePrice,
      color: '#818cf8',
      lineWidth: 2,
      lineStyle: 2, // dashed
      axisLabelVisible: true,
      title: pos.direction === 'YES' ? 'TARGET ↑' : 'TARGET ↓',
    });
  }, [strikePrice]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live price line ────────────────────────────────────────────────────────
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || livePrice == null || !isOpen) return;
    if (livePriceLineRef.current) {
      try { series.removePriceLine(livePriceLineRef.current); } catch { /* ignore */ }
    }
    const winning = strikePrice != null
      ? (pos.direction === 'YES' ? livePrice > strikePrice : livePrice < strikePrice)
      : null;
    livePriceLineRef.current = series.createPriceLine({
      price: livePrice,
      color: winning === true ? '#10b981' : winning === false ? '#ef4444' : '#6b7280',
      lineWidth: 1,
      lineStyle: 0, // solid
      axisLabelVisible: true,
      title: winning === true ? 'LIVE ✓' : winning === false ? 'LIVE ✗' : 'LIVE',
    });
  }, [livePrice]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!candles.length) {
    return (
      <div className="bg-slate-950 rounded-lg border border-gray-800/40 flex items-center justify-center" style={{ height: 170 }}>
        <span className="text-xs text-gray-600">No {pos.asset} chart data</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="rounded-lg overflow-hidden border border-gray-800/40">
        <div ref={containerRef} />
      </div>
      <div className="flex items-center gap-2 flex-wrap px-0.5">
        <span className="text-xs text-gray-600 font-mono">{tfLabel}</span>
        <span className={`text-xs font-bold px-2 py-0.5 rounded border ${
          pos.direction === 'YES'
            ? 'bg-emerald-900/25 text-emerald-400 border-emerald-900/40'
            : 'bg-red-900/25 text-red-400 border-red-900/40'
        }`}>
          {pos.direction === 'YES' ? '↑ WIN if above target' : '↓ WIN if below target'}
        </span>
        {isOpen && currentWinning != null && (
          <span className={`text-xs font-semibold ${currentWinning ? 'text-emerald-400' : 'text-red-400'}`}>
            {currentWinning ? '● Winning' : '● Losing'}
          </span>
        )}
        {strikePrice != null && (
          <span className="text-xs text-indigo-300 font-mono ml-auto">
            target ${strikePrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
          </span>
        )}
      </div>
    </div>
  );
}

function PositionExpanded({ pos, colSpan, onClosePosition }: {
  pos: PaperTrade;
  colSpan: number;
  onClosePosition: (id: string) => void;
}) {
  const { signals, ethSignals, solSignals, xrpSignals, btcData, ethCandles5m, solCandles5m } = useStore();

  const coinSignals =
    pos.asset === 'ETH' ? ethSignals :
    pos.asset === 'SOL' ? solSignals :
    pos.asset === 'XRP' ? xrpSignals :
    signals;

  // BTC → 1m candles; ETH/SOL → 5m (finest available); XRP → none
  const candles: Candle[] =
    pos.asset === 'BTC' ? (btcData?.candles1m ?? []) :
    pos.asset === 'ETH' ? ethCandles5m :
    pos.asset === 'SOL' ? solCandles5m :
    [];
  const tfLabel = pos.asset === 'BTC' ? '1m candles' : '5m candles';

  const liveSignal = coinSignals?.strategies.find(s => s.name === pos.strategy) ?? null;
  const indicators = coinSignals?.indicators ?? null;
  const verdict = coinSignals?.verdict ?? null;
  const isOpen = pos.status === 'OPEN';

  return (
    <tr className="bg-indigo-950/10 border-b border-gray-800/60">
      <td colSpan={colSpan} className="px-3 pt-2 pb-3">
        <div className="flex gap-4 flex-wrap">

          {/* LEFT: chart + entry info */}
          <div className="flex flex-col gap-2 min-w-[260px] flex-1">
            <PositionChart
              pos={pos}
              candles={candles}
              livePrice={indicators?.lastPrice ?? null}
              tfLabel={tfLabel}
            />

            <div className="grid grid-cols-4 gap-1.5 text-center text-xs">
              <div className="bg-gray-800/60 rounded-lg p-2">
                <div className="text-gray-500 mb-0.5">Entry</div>
                <div className="font-mono font-semibold text-white">${pos.entry_price.toFixed(3)}</div>
              </div>
              <div className="bg-gray-800/60 rounded-lg p-2">
                <div className="text-gray-500 mb-0.5">Size</div>
                <div className="font-mono font-semibold text-white">${pos.size.toFixed(2)}</div>
              </div>
              <div className="bg-gray-800/60 rounded-lg p-2">
                <div className="text-gray-500 mb-0.5">Conf</div>
                <div className={`font-mono font-semibold ${
                  (pos.confidence ?? 0) >= 70 ? 'text-emerald-400' :
                  (pos.confidence ?? 0) >= 60 ? 'text-yellow-400' : 'text-gray-400'
                }`}>{pos.confidence != null ? `${pos.confidence}%` : '—'}</div>
              </div>
              {isOpen ? (
                <div className="bg-gray-800/60 rounded-lg p-2 flex flex-col items-center">
                  <div className="text-gray-500 mb-0.5">Closes</div>
                  <CountdownTimer createdAt={pos.created_at} intervalM={pos.interval_m ?? 5} />
                </div>
              ) : (
                <div className="bg-gray-800/60 rounded-lg p-2">
                  <div className="text-gray-500 mb-0.5">P&L</div>
                  <div className={`font-mono font-semibold ${(pos.pnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}$${pos.pnl.toFixed(2)}` : '—'}
                  </div>
                </div>
              )}
            </div>

            {pos.reason && (
              <div className="bg-indigo-950/30 border border-indigo-800/25 rounded-lg p-2">
                <div className="text-xs text-indigo-400 font-medium mb-1">Signal at Entry</div>
                <div className="text-xs text-gray-300 leading-relaxed">{pos.reason.replace(/^Auto:\s*/, '')}</div>
              </div>
            )}
          </div>

          {/* RIGHT: live signal + indicators */}
          <div className="flex flex-col gap-2 w-[240px] shrink-0">

            <div className="bg-gray-900 rounded-lg p-3 border border-gray-800/60 flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <BarChart2 className="w-3.5 h-3.5 text-cyan-400" />
                <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">Live Signal</span>
                {!coinSignals && <span className="text-xs text-gray-600 ml-auto">waiting…</span>}
              </div>

              {pos.strategy && (
                <div className="text-xs text-gray-300 font-medium leading-snug border-l-2 border-blue-700/50 pl-2">
                  {pos.strategy}
                </div>
              )}

              {liveSignal ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
                      liveSignal.direction === 'bullish' ? 'bg-emerald-900/50 text-emerald-300' :
                      liveSignal.direction === 'bearish' ? 'bg-red-900/50 text-red-300' :
                      'bg-gray-700 text-gray-400'
                    }`}>{liveSignal.direction.toUpperCase()}</span>
                    <span className={`text-xs font-mono font-bold ${
                      liveSignal.confidence >= 70 ? 'text-emerald-400' :
                      liveSignal.confidence >= 60 ? 'text-yellow-400' : 'text-gray-400'
                    }`}>{liveSignal.confidence}%</span>
                    <span className="text-xs text-cyan-400 font-mono ml-auto">{liveSignal.score.toFixed(1)}/10</span>
                  </div>
                  {liveSignal.signal && (
                    <div className="text-xs text-gray-500 leading-snug">{liveSignal.signal}</div>
                  )}
                </div>
              ) : coinSignals ? (
                <div className="text-xs text-gray-600 italic">Not currently firing</div>
              ) : null}
            </div>

            {indicators && (
              <div className="bg-gray-900 rounded-lg p-3 border border-gray-800/60">
                <div className="text-xs text-gray-500 uppercase font-medium tracking-wide mb-2">Indicators</div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {indicators.lastPrice != null && (
                    <><span className="text-gray-500">Price</span><span className="font-mono text-gray-300">${indicators.lastPrice.toLocaleString()}</span></>
                  )}
                  {indicators.rsi14_5m != null && (
                    <><span className="text-gray-500">RSI 14</span>
                    <span className={`font-mono font-medium ${indicators.rsi14_5m > 70 ? 'text-red-400' : indicators.rsi14_5m < 30 ? 'text-emerald-400' : 'text-gray-300'}`}>
                      {indicators.rsi14_5m.toFixed(1)}
                    </span></>
                  )}
                  {indicators.rsi7_1m != null && (
                    <><span className="text-gray-500">RSI 7</span>
                    <span className={`font-mono font-medium ${indicators.rsi7_1m > 70 ? 'text-red-400' : indicators.rsi7_1m < 30 ? 'text-emerald-400' : 'text-gray-300'}`}>
                      {indicators.rsi7_1m.toFixed(1)}
                    </span></>
                  )}
                  {indicators.bb != null && (
                    <><span className="text-gray-500">BB %B</span>
                    <span className={`font-mono font-medium ${indicators.bb.pctB > 1 ? 'text-red-400' : indicators.bb.pctB < 0 ? 'text-emerald-400' : 'text-gray-300'}`}>
                      {(indicators.bb.pctB * 100).toFixed(1)}%
                    </span></>
                  )}
                  {indicators.momentum != null && (
                    <><span className="text-gray-500">Streak</span>
                    <span className={`font-mono font-medium ${indicators.momentum.direction === 'up' ? 'text-emerald-400' : 'text-red-400'}`}>
                      {indicators.momentum.direction === 'up' ? '+' : '-'}{indicators.momentum.consecutive}
                    </span></>
                  )}
                  {verdict != null && (
                    <><span className="text-gray-500">Verdict</span>
                    <span className={`font-semibold ${verdict.direction === 'BULLISH' ? 'text-emerald-400' : verdict.direction === 'BEARISH' ? 'text-red-400' : 'text-gray-400'}`}>
                      {verdict.direction}
                    </span></>
                  )}
                </div>
              </div>
            )}

            {isOpen && (
              <button
                onClick={e => { e.stopPropagation(); onClosePosition(pos.id); }}
                className="text-xs py-2 text-red-400 border border-red-900/60 rounded-lg hover:bg-red-900/20 transition-colors"
              >
                Close Position
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function formatDuration(createdAt: string, closedAt: string | null): string {
  if (!closedAt) return '—';
  const ms = new Date(closedAt).getTime() - new Date(createdAt).getTime();
  if (ms < 0) return '—';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h}h${m > 0 ? ` ${m}m` : ''}`;
  }
  if (min > 0) return `${min}m ${totalSec % 60}s`;
  return `${totalSec}s`;
}

// ─── History sort ───

type HistSortKey =
  | 'closed_at' | 'asset' | 'interval_m' | 'direction'
  | 'entry_price' | 'exit_price' | 'duration' | 'size'
  | 'confidence' | 'pnl' | 'result' | 'strategy' | 'reason';

function sortHistTrades(trades: PaperTrade[], key: HistSortKey, dir: 'asc' | 'desc'): PaperTrade[] {
  return [...trades].sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;
    switch (key) {
      case 'closed_at':
        aVal = a.closed_at ? new Date(a.closed_at).getTime() : 0;
        bVal = b.closed_at ? new Date(b.closed_at).getTime() : 0;
        break;
      case 'asset':      aVal = a.asset;           bVal = b.asset;           break;
      case 'interval_m': aVal = a.interval_m ?? 5; bVal = b.interval_m ?? 5; break;
      case 'direction':  aVal = a.direction;        bVal = b.direction;        break;
      case 'entry_price':aVal = a.entry_price;      bVal = b.entry_price;      break;
      case 'exit_price': aVal = a.exit_price ?? 0;  bVal = b.exit_price ?? 0;  break;
      case 'duration': {
        aVal = a.closed_at ? new Date(a.closed_at).getTime() - new Date(a.created_at).getTime() : 0;
        bVal = b.closed_at ? new Date(b.closed_at).getTime() - new Date(b.created_at).getTime() : 0;
        break;
      }
      case 'size':       aVal = a.size;              bVal = b.size;              break;
      case 'confidence': aVal = a.confidence ?? 0;   bVal = b.confidence ?? 0;   break;
      case 'pnl':        aVal = a.pnl ?? 0;          bVal = b.pnl ?? 0;          break;
      case 'result':     aVal = (a.pnl ?? 0) > 0 ? 1 : 0; bVal = (b.pnl ?? 0) > 0 ? 1 : 0; break;
      case 'strategy':   aVal = a.strategy ?? '';    bVal = b.strategy ?? '';    break;
      case 'reason':     aVal = a.reason ?? '';      bVal = b.reason ?? '';      break;
      default:           return 0;
    }
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return dir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return dir === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
  });
}

function SortTh({
  label, col, current, dir, onClick,
}: {
  label: string; col: HistSortKey;
  current: HistSortKey; dir: 'asc' | 'desc';
  onClick: (col: HistSortKey) => void;
}) {
  const active = col === current;
  return (
    <th
      className="py-2 pr-3 cursor-pointer select-none whitespace-nowrap group"
      onClick={() => onClick(col)}
    >
      <span className={`flex items-center gap-0.5 transition-colors ${
        active ? 'text-blue-400' : 'text-gray-500 group-hover:text-gray-300'
      }`}>
        {label}
        <span className={`text-xs leading-none transition-opacity ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'}`}>
          {active && dir === 'asc' ? ' ↑' : ' ↓'}
        </span>
      </span>
    </th>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [histSortKey, setHistSortKey] = useState<HistSortKey>('closed_at');
  const [histSortDir, setHistSortDir] = useState<'asc' | 'desc'>('desc');

  function handleHistSort(col: HistSortKey) {
    if (col === histSortKey) {
      setHistSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setHistSortKey(col);
      setHistSortDir('desc');
    }
  }

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
                  <th className="py-2 pr-3">TF</th>
                  <th className="py-2 pr-3">Closes In</th>
                  <th className="py-2 pr-3">Direction</th>
                  <th className="py-2 pr-3">Entry</th>
                  <th className="py-2 pr-3">Size</th>
                  <th className="py-2 pr-3">Strategy</th>
                  <th className="py-2 pr-3">Confidence</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {paperPositions.map(pos => {
                  const isExpanded = expandedId === pos.id;
                  return (
                    <>
                      <tr
                        key={pos.id}
                        className={`border-b border-gray-800 transition-colors cursor-pointer select-none ${isExpanded ? 'bg-indigo-950/20' : 'hover:bg-gray-800/40'}`}
                        onClick={() => setExpandedId(isExpanded ? null : pos.id)}
                      >
                        <td className="py-2 pr-3 text-gray-400 text-xs whitespace-nowrap">
                          {new Date(pos.created_at).toLocaleTimeString()}
                        </td>
                        <td className="py-2 pr-3 font-semibold text-white">{pos.asset}</td>
                        <td className="py-2 pr-3">
                          <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300">
                            {pos.interval_m ?? 5}m
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <CountdownTimer createdAt={pos.created_at} intervalM={pos.interval_m ?? 5} />
                        </td>
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
                        <td className="py-2" onClick={e => e.stopPropagation()}>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => handleClose(pos.id)}
                              className="text-xs px-2 py-1 rounded border border-gray-700 text-gray-400 hover:border-red-700 hover:text-red-400 transition-colors"
                            >
                              Close
                            </button>
                            <ChevronDown className={`w-3.5 h-3.5 text-gray-600 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <PositionExpanded
                          key={`exp-${pos.id}`}
                          pos={pos}
                          colSpan={10}
                          onClosePosition={async (id) => { await handleClose(id); setExpandedId(null); }}
                        />
                      )}
                    </>
                  );
                })}
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
                <tr className="text-left text-xs border-b border-gray-800">
                  <SortTh label="Closed"   col="closed_at"   current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Asset"    col="asset"        current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="TF"       col="interval_m"   current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Dir"      col="direction"    current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Entry"    col="entry_price"  current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Exit"     col="exit_price"   current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Duration" col="duration"     current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Size"     col="size"         current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Conf"     col="confidence"   current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="P&L"      col="pnl"          current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Result"   col="result"       current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Strategy" col="strategy"     current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                  <SortTh label="Signal"   col="reason"       current={histSortKey} dir={histSortDir} onClick={handleHistSort} />
                </tr>
              </thead>
              <tbody>
                {sortHistTrades(trades.filter(t => t.status !== 'OPEN'), histSortKey, histSortDir)
                  .map(t => {
                    const duration = formatDuration(t.created_at, t.closed_at);
                    const signalText = t.reason ? t.reason.replace(/^Auto:\s*/, '') : null;
                    const isExpanded = expandedId === t.id;
                    return (
                      <>
                      <tr
                        key={t.id}
                        className={`border-b border-gray-800 transition-colors cursor-pointer select-none ${isExpanded ? 'bg-indigo-950/20' : 'hover:bg-gray-800/40'}`}
                        onClick={() => setExpandedId(isExpanded ? null : t.id)}
                      >
                        <td className="py-2 pr-3 text-gray-400 text-xs whitespace-nowrap">
                          {t.closed_at ? new Date(t.closed_at).toLocaleString() : '—'}
                        </td>
                        <td className="py-2 pr-3 font-semibold text-white">{t.asset}</td>
                        <td className="py-2 pr-3">
                          <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300">
                            {t.interval_m ?? 5}m
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          <span className={`text-xs font-medium ${
                            t.direction === 'YES' ? 'text-emerald-400' : 'text-red-400'
                          }`}>{t.direction}</span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-gray-300 text-xs">${t.entry_price.toFixed(3)}</td>
                        <td className="py-2 pr-3 font-mono text-gray-300 text-xs">
                          {t.exit_price != null ? `$${t.exit_price.toFixed(3)}` : '—'}
                        </td>
                        <td className="py-2 pr-3 font-mono text-gray-500 text-xs whitespace-nowrap">{duration}</td>
                        <td className="py-2 pr-3 font-mono text-gray-300 text-xs">${t.size.toFixed(2)}</td>
                        <td className="py-2 pr-3">
                          {t.confidence != null ? (
                            <span className={`text-xs font-mono font-medium ${
                              t.confidence >= 75 ? 'text-emerald-400' :
                              t.confidence >= 65 ? 'text-yellow-400' : 'text-gray-400'
                            }`}>{t.confidence}%</span>
                          ) : <span className="text-gray-600">—</span>}
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {t.pnl != null ? <PnlBadge value={t.pnl} /> : '—'}
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
                        <td className="py-2 pr-3 text-gray-400 text-xs max-w-[160px] truncate">
                          {t.strategy ?? '—'}
                        </td>
                        <td className="py-2 pr-3 text-gray-500 text-xs max-w-[200px] truncate" title={signalText ?? ''}>
                          {signalText ?? '—'}
                        </td>
                      </tr>
                      {isExpanded && (
                        <PositionExpanded
                          key={`exp-${t.id}`}
                          pos={t}
                          colSpan={13}
                          onClosePosition={async (id) => { await handleClose(id); setExpandedId(null); }}
                        />
                      )}
                      </>
                    );
                  })}
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
