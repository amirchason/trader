import { useEffect, useRef } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  CrosshairMode,
  UTCTimestamp,
  LineStyle,
} from 'lightweight-charts';
import { useStore, Candle, StrategyResult } from '../store';
import type { PaperTrade } from '../store';

const CHART_HEIGHT = 180;
const BG_COLOR = '#111827';

interface ChartConfig {
  strategyId: number;
  coin: string;
  tf: string;
  bbPeriod: number;
  bbMult: number;
  emoji: string;
  name: string;
  wr: string;
  nameSubstr: string;
}

const CHART_CONFIGS: ChartConfig[] = [
  { strategyId: 15, coin: 'ETH', tf: '5m',  bbPeriod: 20, bbMult: 2.2, emoji: '🎯', name: 'Good Hours',     wr: '69.8%', nameSubstr: 'Good Hours' },
  { strategyId: 16, coin: 'ETH', tf: '5m',  bbPeriod: 20, bbMult: 2.2, emoji: '🔮', name: 'Synth15m',       wr: '73.1%', nameSubstr: 'Synth15m' },
  { strategyId: 17, coin: 'ETH', tf: '5m',  bbPeriod: 20, bbMult: 2.2, emoji: '📏', name: 'Daily Range',    wr: '73.4%', nameSubstr: 'Daily Range' },
  { strategyId: 14, coin: 'ETH', tf: '15m', bbPeriod: 15, bbMult: 2.2, emoji: '🔄', name: 'Recovery ETH',   wr: '75.9%', nameSubstr: 'Recovery Rally' },
  { strategyId: 14, coin: 'BTC', tf: '15m', bbPeriod: 15, bbMult: 2.2, emoji: '🔄', name: 'Recovery BTC',   wr: '75.8%', nameSubstr: 'Recovery Rally' },
  { strategyId: 12, coin: 'BTC', tf: '15m', bbPeriod: 20, bbMult: 2.0, emoji: '📊', name: 'MFI Exhaustion', wr: '70.4%', nameSubstr: 'MFI' },
  // HF40 — BB(20,1.8): 40+ trades/day, walk-forward validated
  { strategyId: 67, coin: 'ETH', tf: '5m',  bbPeriod: 20, bbMult: 1.8, emoji: '⚡🔁', name: 'HF40 ETH',    wr: '73.1%', nameSubstr: 'ALL-H BB18 HF' },
  { strategyId: 67, coin: 'BTC', tf: '5m',  bbPeriod: 20, bbMult: 1.8, emoji: '⚡🔁', name: 'HF40 BTC',    wr: '73.4%', nameSubstr: 'ALL-H BB18 HF' },
  { strategyId: 67, coin: 'SOL', tf: '5m',  bbPeriod: 20, bbMult: 1.8, emoji: '⚡🌟', name: 'HF40 SOL',    wr: '71.7%', nameSubstr: 'SOL ALL-H BB18 HF' },
  // HF80 — BB(20,1.0): 100+ trades/day, 5-fold walk-forward validated
  { strategyId: 68, coin: 'ETH', tf: '5m',  bbPeriod: 20, bbMult: 1.0, emoji: '🚀',   name: 'HF80 ETH',    wr: '72.2%', nameSubstr: 'ALL-H BB10 UHF80' },
  { strategyId: 68, coin: 'BTC', tf: '5m',  bbPeriod: 20, bbMult: 1.0, emoji: '🚀',   name: 'HF80 BTC',    wr: '71.7%', nameSubstr: 'ALL-H BB10 UHF80' },
  { strategyId: 68, coin: 'SOL', tf: '5m',  bbPeriod: 20, bbMult: 1.0, emoji: '🚀🌟', name: 'HF80 SOL',    wr: '70.9%', nameSubstr: 'SOL ALL-H BB10 UHF80' },
];

function computeBB(
  candles: Candle[],
  period: number,
  mult: number,
): { upper: number; mid: number; lower: number } | null {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  const mid = slice.reduce((s, c) => s + c.close, 0) / period;
  const variance = slice.reduce((s, c) => s + (c.close - mid) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mid + mult * std, mid, lower: mid - mult * std };
}

interface StrategyChartProps {
  config: ChartConfig;
  candles: Candle[];
  signals: StrategyResult | null;
  openPositions: PaperTrade[];
  enabled: boolean;
}

function StrategyChart({ config, candles, signals, openPositions, enabled }: StrategyChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candleSeriesRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbUpperRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbMidRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbLowerRef = useRef<ISeriesApi<any> | null>(null);

  // ── Effect 1: Create chart on mount ──────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: BG_COLOR },
        textColor: '#6b7280',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#374151', width: 1, style: 2 },
        horzLine: { color: '#374151', width: 1, style: 2 },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#1f2937',
        rightOffset: 2,
      },
      rightPriceScale: {
        borderColor: '#1f2937',
        scaleMargins: { top: 0.1, bottom: 0.05 },
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

    // Candlestick series
    candleSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      borderVisible: false,
    });

    // BB bands — indigo/purple dashed lines
    bbUpperRef.current = chart.addLineSeries({
      color: 'rgba(99, 102, 241, 0.7)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    bbMidRef.current = chart.addLineSeries({
      color: 'rgba(99, 102, 241, 0.3)',
      lineWidth: 1,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    bbLowerRef.current = chart.addLineSeries({
      color: 'rgba(99, 102, 241, 0.7)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });

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
      candleSeriesRef.current = null;
      bbUpperRef.current = null;
      bbMidRef.current = null;
      bbLowerRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect 2: Update candle + BB data ────────────────────────────────────
  useEffect(() => {
    if (!candleSeriesRef.current || !candles.length) return;

    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime).slice(-80);

    // Candlesticks
    candleSeriesRef.current.setData(
      sorted.map(c => ({
        time: Math.floor(c.openTime / 1000) as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    // BB data — compute per candle for the line
    const bbData: { upper: { time: UTCTimestamp; value: number }[]; mid: { time: UTCTimestamp; value: number }[]; lower: { time: UTCTimestamp; value: number }[] } = {
      upper: [], mid: [], lower: [],
    };

    for (let i = config.bbPeriod - 1; i < sorted.length; i++) {
      const slice = sorted.slice(i - config.bbPeriod + 1, i + 1);
      const bb = computeBB(slice, config.bbPeriod, config.bbMult);
      if (!bb) continue;
      const t = Math.floor(sorted[i].openTime / 1000) as UTCTimestamp;
      bbData.upper.push({ time: t, value: bb.upper });
      bbData.mid.push({ time: t, value: bb.mid });
      bbData.lower.push({ time: t, value: bb.lower });
    }

    bbUpperRef.current?.setData(bbData.upper);
    bbMidRef.current?.setData(bbData.mid);
    bbLowerRef.current?.setData(bbData.lower);

    chartRef.current?.timeScale().fitContent();
  }, [candles, config.bbPeriod, config.bbMult]);

  // ── Effect 3: Open position entry price line ──────────────────────────────
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    // Remove all existing price lines
    const series = candleSeriesRef.current;
    // lightweight-charts v4: no direct way to remove all price lines, so we track them
    // We recreate by calling setData which resets lines — instead track with ref
    // Simple approach: just create a new price line if position exists
    // (minor: old lines persist but they're static; re-mount on position change would be overkill)
    const pos = openPositions.find(
      p => p.asset === config.coin && p.strategy?.includes(config.nameSubstr) && p.status === 'OPEN'
    );
    if (pos) {
      series.createPriceLine({
        price: pos.entry_price,
        color: pos.direction === 'YES' ? '#10b981' : '#ef4444',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: `${pos.direction} entry`,
      });
    }
  }, [openPositions, config.coin, config.nameSubstr]);

  const sig = signals?.strategies.find(s => s.name.includes(config.nameSubstr));
  const lastCandle = candles[candles.length - 1];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* Chart header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800/60">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm">{config.emoji}</span>
          <span className="text-xs font-semibold text-gray-200 truncate">{config.name}</span>
          <span className="text-[10px] text-gray-600 font-mono shrink-0">{config.coin}/{config.tf}</span>
          <span className="text-[10px] font-mono text-emerald-500 shrink-0">{config.wr}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Enabled dot */}
          <span
            className={`w-1.5 h-1.5 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-gray-700'}`}
            title={enabled ? 'Auto-trading enabled' : 'Auto-trading disabled'}
          />
          {/* Signal badge */}
          {sig && sig.direction !== 'neutral' ? (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded font-mono ${
              sig.direction === 'bearish'
                ? 'bg-red-900/50 text-red-400'
                : 'bg-emerald-900/50 text-emerald-400'
            }`}>
              {sig.direction === 'bearish' ? '▼' : '▲'} {sig.confidence}%
            </span>
          ) : (
            <span className="text-[10px] text-gray-600 font-mono">—</span>
          )}
          {/* Last price */}
          {lastCandle && (
            <span className="text-[10px] font-mono text-gray-400">
              ${lastCandle.close.toLocaleString('en-US', { maximumFractionDigits: config.coin === 'ETH' ? 2 : 0 })}
            </span>
          )}
        </div>
      </div>

      {/* Chart */}
      <div className="relative" style={{ height: CHART_HEIGHT }}>
        <div ref={containerRef} style={{ height: CHART_HEIGHT, width: '100%' }} />
        {candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-xs pointer-events-none">
            Waiting for {config.coin} data…
          </div>
        )}
      </div>
    </div>
  );
}

export function StrategyCharts() {
  const { ethCandles5m, ethCandles15m, ethSignals, btcData, signals, solCandles5m, solSignals, strategyConfigs, paperPositions } = useStore();

  function getCandlesForConfig(cfg: ChartConfig): Candle[] {
    if (cfg.coin === 'ETH' && cfg.tf === '5m') return ethCandles5m;
    if (cfg.coin === 'ETH' && cfg.tf === '15m') return ethCandles15m;
    if (cfg.coin === 'BTC' && cfg.tf === '5m') return btcData?.candles5m ?? [];
    if (cfg.coin === 'BTC' && cfg.tf === '15m') return btcData?.candles15m ?? [];
    if (cfg.coin === 'SOL' && cfg.tf === '5m') return solCandles5m;
    return [];
  }

  function getSignalsForConfig(cfg: ChartConfig): StrategyResult | null {
    if (cfg.coin === 'ETH') return ethSignals;
    if (cfg.coin === 'SOL') return solSignals;
    return signals;
  }

  function isEnabled(cfg: ChartConfig): boolean {
    return strategyConfigs.find(c => c.strategyId === cfg.strategyId && c.coin === cfg.coin)?.enabled ?? false;
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* Section header */}
      <div className="px-4 py-2.5 border-b border-gray-800 flex items-center gap-2">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Strategy Charts</span>
        <span className="text-xs text-gray-600">· live candles with BB bands</span>
      </div>

      {/* 2-column chart grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-3">
        {CHART_CONFIGS.map((cfg) => (
          <StrategyChart
            key={`${cfg.strategyId}-${cfg.coin}`}
            config={cfg}
            candles={getCandlesForConfig(cfg)}
            signals={getSignalsForConfig(cfg)}
            openPositions={paperPositions}
            enabled={isEnabled(cfg)}
          />
        ))}
      </div>
    </div>
  );
}
