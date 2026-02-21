import { useEffect, useRef } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';

interface Point {
  time: number;
  equity: number;
}

export function EquityCurve({ curve, title = 'Equity Curve' }: { curve: Point[]; title?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || curve.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#9ca3af',
      },
      grid: {
        vertLines: { color: '#1f2937' },
        horzLines: { color: '#1f2937' },
      },
      width: containerRef.current.clientWidth,
      height: 220,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#374151',
      },
      rightPriceScale: { borderColor: '#374151' },
      crosshair: { mode: 1 },
    });

    const lineSeries = chart.addLineSeries({
      color: '#10b981',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    });

    // Filter out duplicate timestamps and sort
    const seen = new Set<number>();
    const data = curve
      .map((p) => ({ time: Math.floor(p.time / 1000) as any, value: p.equity }))
      .filter((p) => {
        if (seen.has(p.time)) return false;
        seen.add(p.time);
        return true;
      })
      .sort((a, b) => a.time - b.time);

    if (data.length > 0) {
      lineSeries.setData(data);
      chart.timeScale().fitContent();
    }

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.resize(containerRef.current.clientWidth, 220);
      }
    });
    ro.observe(containerRef.current);

    return () => {
      chart.remove();
      ro.disconnect();
    };
  }, [curve]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">{title}</h3>
      {curve.length === 0 ? (
        <div className="h-52 flex items-center justify-center text-gray-600 text-sm">
          No equity data available
        </div>
      ) : (
        <div ref={containerRef} className="w-full" />
      )}
    </div>
  );
}
