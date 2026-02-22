import { useState } from 'react';
import { useStore } from '../store';
import type { StrategyResult } from '../store';

function ScoreBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const color = score >= 7 ? 'bg-emerald-500' : score >= 4 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function SignalList({ data, label }: { data: StrategyResult | null; label: string }) {
  if (!data) {
    return (
      <div className="flex items-center justify-center h-24 text-gray-600 text-xs">
        Waiting for {label} signals…
      </div>
    );
  }

  const { strategies, verdict } = data;
  const verdictColor = verdict.direction === 'BULLISH'
    ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
    : verdict.direction === 'BEARISH'
    ? 'text-red-400 border-red-500/30 bg-red-500/10'
    : 'text-gray-400 border-gray-600 bg-gray-800';
  const verdictIcon = verdict.direction === 'BULLISH' ? '↑' : verdict.direction === 'BEARISH' ? '↓' : '→';

  return (
    <>
      {/* Verdict row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-2">
          <span className="text-[10px] text-gray-500">
            Bull <span className="text-emerald-400 font-mono">{verdict.bullishScore}</span>
          </span>
          <span className="text-[10px] text-gray-500">
            Bear <span className="text-red-400 font-mono">{verdict.bearishScore}</span>
          </span>
        </div>
        <div className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold ${verdictColor}`}>
          {verdictIcon} {verdict.direction}
        </div>
      </div>

      {/* Strategy list */}
      <div className="flex flex-col gap-1">
        {strategies.length === 0 ? (
          <p className="text-xs text-gray-600 italic text-center py-3">
            No signals now — hour filter active{label === 'SOL' ? ' (fires at 0/12/13/20 UTC)' : label === 'XRP' ? ' (fires at 6/9/12/18 UTC)' : ' (fires at 10/11/12/21 UTC)'}
          </p>
        ) : (
          strategies.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-1 border-b border-gray-800/50 last:border-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm shrink-0">{s.emoji}</span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-gray-200 truncate">{s.name}</div>
                  <div className="text-[10px] text-gray-500 truncate max-w-[130px]">{s.signal}</div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0 ml-1">
                <div className={`text-xs font-bold ${
                  s.direction === 'bullish' ? 'text-emerald-400' :
                  s.direction === 'bearish' ? 'text-red-400' : 'text-gray-400'
                }`}>
                  {s.direction === 'bullish' ? '▲' : s.direction === 'bearish' ? '▼' : '—'} {s.score.toFixed(1)}
                </div>
                <ScoreBar score={s.score} />
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

export function SignalPanel() {
  const { signals, ethSignals, solSignals, xrpSignals } = useStore();
  const [activeAsset, setActiveAsset] = useState<'ETH' | 'BTC' | 'SOL' | 'XRP'>('ETH');

  const activeData = activeAsset === 'ETH' ? ethSignals
    : activeAsset === 'SOL' ? solSignals
    : activeAsset === 'XRP' ? xrpSignals
    : signals;
  const indicators = activeAsset === 'ETH'
    ? ethSignals?.indicators
    : activeAsset === 'SOL'
    ? solSignals?.indicators
    : activeAsset === 'XRP'
    ? xrpSignals?.indicators
    : signals?.indicators;

  return (
    <div className="card p-4 h-full flex flex-col">
      {/* Header with asset tabs */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Strategy Signals</h3>
        <div className="flex rounded border border-gray-700 overflow-hidden text-xs font-semibold">
          {(['ETH', 'BTC', 'SOL', 'XRP'] as const).map(asset => (
            <button
              key={asset}
              onClick={() => setActiveAsset(asset)}
              className={`px-3 py-1 transition-colors border-l border-gray-700 first:border-l-0 ${
                activeAsset === asset
                  ? 'bg-blue-800 text-white'
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {asset}
            </button>
          ))}
        </div>
      </div>

      {/* Signal list for selected asset */}
      <div className="flex-1 min-h-0">
        <SignalList data={activeData} label={activeAsset} />
      </div>

      {/* Indicators */}
      {indicators && (
        <div className="mt-3 pt-3 border-t border-gray-800 grid grid-cols-2 gap-x-4 gap-y-1.5">
          <div className="flex justify-between">
            <span className="text-[10px] text-gray-500">RSI(14) 5m</span>
            <span className={`text-[10px] font-mono ${
              (indicators.rsi14_5m ?? 50) > 70 ? 'text-red-400' :
              (indicators.rsi14_5m ?? 50) < 30 ? 'text-emerald-400' : 'text-gray-300'
            }`}>
              {indicators.rsi14_5m?.toFixed(1) ?? '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[10px] text-gray-500">RSI(7) 1m</span>
            <span className={`text-[10px] font-mono ${
              (indicators.rsi7_1m ?? 50) > 70 ? 'text-red-400' :
              (indicators.rsi7_1m ?? 50) < 30 ? 'text-emerald-400' : 'text-gray-300'
            }`}>
              {indicators.rsi7_1m?.toFixed(1) ?? '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[10px] text-gray-500">SMA(20)</span>
            <span className="text-[10px] font-mono text-gray-300">
              {indicators.sma20 ? `$${indicators.sma20.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[10px] text-gray-500">VWAP</span>
            <span className="text-[10px] font-mono text-gray-300">
              {indicators.vwap ? `$${indicators.vwap.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[10px] text-gray-500">MACD</span>
            <span className={`text-[10px] font-mono ${
              indicators.macd?.signal === 'bullish' ? 'text-emerald-400' :
              indicators.macd?.signal === 'bearish' ? 'text-red-400' : 'text-gray-400'
            }`}>
              {indicators.macd ? `${indicators.macd.macd > 0 ? '+' : ''}${indicators.macd.macd}` : '—'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[10px] text-gray-500">BB Upper</span>
            <span className="text-[10px] font-mono text-gray-300">
              {indicators.bb ? `$${indicators.bb.upper.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
