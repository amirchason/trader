import { useStore } from '../store';

function ScoreBar({ score }: { score: number }) {
  const pct = (score / 10) * 100;
  const color = score >= 7 ? 'bg-emerald-500' : score >= 4 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SignalPanel() {
  const { signals } = useStore();

  if (!signals) {
    return (
      <div className="card p-4 h-full">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider mb-4">Strategy Signals</h3>
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
          Loading signals…
        </div>
      </div>
    );
  }

  const { strategies, indicators, verdict } = signals;

  const verdictColor = verdict.direction === 'BULLISH'
    ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
    : verdict.direction === 'BEARISH'
    ? 'text-red-400 border-red-500/30 bg-red-500/10'
    : 'text-gray-400 border-gray-600 bg-gray-800';

  const verdictIcon = verdict.direction === 'BULLISH' ? '↑' : verdict.direction === 'BEARISH' ? '↓' : '→';

  return (
    <div className="card p-4 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Strategy Signals</h3>
        <div className={`flex items-center gap-1.5 px-3 py-1 rounded-lg border text-xs font-bold ${verdictColor}`}>
          <span>{verdictIcon}</span>
          <span>{verdict.direction}</span>
        </div>
      </div>

      {/* Verdict scores */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2 text-center">
          <div className="text-xs text-emerald-400 mb-0.5">Bull Score</div>
          <div className="text-lg font-bold font-mono text-emerald-400">{verdict.bullishScore}</div>
        </div>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-center">
          <div className="text-xs text-red-400 mb-0.5">Bear Score</div>
          <div className="text-lg font-bold font-mono text-red-400">{verdict.bearishScore}</div>
        </div>
      </div>

      {/* Strategy list */}
      <div className="flex flex-col gap-2 flex-1">
        {strategies.length === 0 ? (
          <p className="text-xs text-gray-600 italic text-center py-4">No strong signals detected</p>
        ) : (
          strategies.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 border-b border-gray-800/50 last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-base">{s.emoji}</span>
                <div>
                  <div className="text-xs font-semibold text-gray-200">{s.name}</div>
                  <div className="text-[10px] text-gray-500 truncate max-w-[140px]">{s.signal}</div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
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

      {/* Indicators */}
      <div className="mt-4 pt-3 border-t border-gray-800 grid grid-cols-2 gap-x-4 gap-y-1.5">
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
          <span className="text-[10px] text-gray-500">Momentum</span>
          <span className={`text-[10px] font-semibold ${
            indicators.momentum.direction === 'bullish' ? 'text-emerald-400' :
            indicators.momentum.direction === 'bearish' ? 'text-red-400' : 'text-gray-400'
          }`}>
            {indicators.momentum.direction.toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  );
}
