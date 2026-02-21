import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  IChartApi,
  ISeriesApi,
  ColorType,
  CrosshairMode,
  UTCTimestamp,
} from 'lightweight-charts';
import { useStore, Candle } from '../store';

type ChartMode = 'candles' | 'line';
type TF = '10s' | '30s' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

const CHART_HEIGHT = 210;
const BG_COLOR = '#111827'; // bg-gray-900

const TF_LABELS: TF[] = ['10s', '30s', '1m', '5m', '15m', '1h', '4h', '1d'];

// Map timeframe → BtcData key
const TF_KEY: Record<TF, keyof import('../store').BtcData> = {
  '10s': 'candles10s',
  '30s': 'candles30s',
  '1m':  'candles1m',
  '5m':  'candles5m',
  '15m': 'candles15m',
  '1h':  'candles1h',
  '4h':  'candles4h',
  '1d':  'candles1d',
};

export function CandleChart() {
  const { btcData } = useStore();
  const [activeTF, setActiveTF] = useState<TF>('5m');
  const [chartMode, setChartMode] = useState<ChartMode>('candles');
  const [showVolume, setShowVolume] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const volSeriesRef = useRef<ISeriesApi<any> | null>(null);
  // Track last TF+mode so we only fitContent on deliberate user changes, not periodic refreshes
  const lastFitKeyRef = useRef<string>('');

  const candles: Candle[] = (
    (btcData?.[TF_KEY[activeTF]] as Candle[] | undefined) ?? []
  ).slice(-100);

  // ── Effect 1: Create chart on mount, destroy on unmount ─────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: CHART_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: BG_COLOR },
        textColor: '#9ca3af',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4b5563', width: 1, style: 2 },
        horzLine: { color: '#4b5563', width: 1, style: 2 },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#374151',
        rightOffset: 3,
      },
      rightPriceScale: {
        borderColor: '#374151',
        scaleMargins: { top: 0.08, bottom: 0.05 },
      },
      handleScroll: true,
      handleScale: true,
    });

    chartRef.current = chart;

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
      mainSeriesRef.current = null;
      volSeriesRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect 2: Recreate main series when chart mode changes ───────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (mainSeriesRef.current) {
      chart.removeSeries(mainSeriesRef.current);
      mainSeriesRef.current = null;
    }

    if (chartMode === 'candles') {
      mainSeriesRef.current = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444',
        borderVisible: false,
      });
    } else {
      mainSeriesRef.current = chart.addAreaSeries({
        lineColor: '#10b981',
        topColor: 'rgba(16, 185, 129, 0.25)',
        bottomColor: 'rgba(16, 185, 129, 0)',
        lineWidth: 2,
      });
    }
  }, [chartMode]);

  // ── Effect 3: Update main series data whenever candles or mode changes ───
  useEffect(() => {
    if (!mainSeriesRef.current || !candles.length) return;

    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);

    if (chartMode === 'candles') {
      mainSeriesRef.current.setData(
        sorted.map(c => ({
          time: Math.floor(c.openTime / 1000) as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
      );
    } else {
      mainSeriesRef.current.setData(
        sorted.map(c => ({
          time: Math.floor(c.openTime / 1000) as UTCTimestamp,
          value: c.close,
        }))
      );
    }

    // Only fitContent when the user switches TF or chart mode — NOT on every 5s data refresh.
    // This lets the user scroll into history without being snapped back.
    const fitKey = `${activeTF}:${chartMode}`;
    if (fitKey !== lastFitKeyRef.current) {
      chartRef.current?.timeScale().fitContent();
      lastFitKeyRef.current = fitKey;
    }
  }, [candles, chartMode, activeTF]);

  // ── Effect 4: Volume series ──────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (!showVolume) {
      if (volSeriesRef.current) {
        chart.removeSeries(volSeriesRef.current);
        volSeriesRef.current = null;
      }
      chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.05 } });
      return;
    }

    if (!candles.length) return;

    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    const data = sorted.map(c => ({
      time: Math.floor(c.openTime / 1000) as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? 'rgba(16, 185, 129, 0.45)' : 'rgba(239, 68, 68, 0.45)',
    }));

    if (!volSeriesRef.current) {
      const vol = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      });
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.32 } });
      volSeriesRef.current = vol;
    }

    volSeriesRef.current.setData(data);
  }, [showVolume, candles]);

  const lastCandle = candles[candles.length - 1];
  const firstCandle = candles[0];
  const isUp = lastCandle && firstCandle ? lastCandle.close >= firstCandle.close : true;

  return (
    <div className="card p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">BTC / USDT</h3>
          {lastCandle && (
            <div className={`text-xl font-mono font-bold mt-0.5 ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
              ${lastCandle.close.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Chart mode toggle */}
          <div className="flex bg-gray-800 rounded-md p-0.5">
            <button
              onClick={() => setChartMode('candles')}
              className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                chartMode === 'candles' ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
              title="Candlesticks"
            >
              &#9608;&#9608;&#9608;
            </button>
            <button
              onClick={() => setChartMode('line')}
              className={`px-2 py-1 text-[10px] font-semibold rounded transition-colors ${
                chartMode === 'line' ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
              title="Line chart"
            >
              &#x2F;&#x5C;&#x2F;
            </button>
          </div>

          {/* Volume toggle */}
          <button
            onClick={() => setShowVolume(v => !v)}
            className={`px-2 py-1 text-[10px] font-semibold rounded-md border transition-colors ${
              showVolume
                ? 'bg-blue-500/20 border-blue-500/40 text-blue-400'
                : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-gray-300'
            }`}
          >
            VOL
          </button>

          {/* Timeframe selector */}
          <div className="flex items-center gap-px bg-gray-800 rounded-md p-0.5">
            {TF_LABELS.map((tf, i) => (
              <>
                {/* visual separator between groups */}
                {(i === 2 || i === 5) && (
                  <span key={`sep-${i}`} className="w-px h-3 bg-gray-600 mx-0.5 self-center" />
                )}
                <button
                  key={tf}
                  onClick={() => setActiveTF(tf)}
                  className={`px-1.5 py-1 text-[10px] font-semibold rounded transition-colors ${
                    activeTF === tf ? 'bg-gray-600 text-white' : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {tf}
                </button>
              </>
            ))}
          </div>
        </div>
      </div>

      {/* Chart container — always rendered so the ref is available on mount */}
      <div className="relative" style={{ height: CHART_HEIGHT }}>
        <div ref={containerRef} style={{ height: CHART_HEIGHT, width: '100%' }} />
        {candles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-sm pointer-events-none">
            Loading chart data…
          </div>
        )}
      </div>

      {/* BTC stats footer */}
      {btcData && (
        <div className="grid grid-cols-3 gap-2 pt-3 border-t border-gray-800">
          <div className="text-center">
            <div className="text-xs text-gray-500">24h High</div>
            <div className="text-xs font-mono text-gray-300">
              ${btcData.high24h.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-gray-500">Funding</div>
            <div className={`text-xs font-mono ${
              btcData.funding.signal === 'overbought' ? 'text-red-400' :
              btcData.funding.signal === 'oversold' ? 'text-emerald-400' : 'text-gray-400'
            }`}>
              {(btcData.funding.current * 100).toFixed(4)}%
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-gray-500">OB Pressure</div>
            <div className={`text-xs font-semibold ${
              btcData.orderBook.pressure === 'bullish' ? 'text-emerald-400' :
              btcData.orderBook.pressure === 'bearish' ? 'text-red-400' : 'text-gray-400'
            }`}>
              {btcData.orderBook.pressure.toUpperCase()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
