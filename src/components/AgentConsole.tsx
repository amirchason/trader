import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Minus, Terminal, ChevronRight } from 'lucide-react';

// ─────────────────── Types ───────────────────

interface ConsoleLine {
  id: number;
  type: 'input' | 'output' | 'error' | 'info' | 'success';
  text: string;
  time: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  onClose: () => void;
}

// ─────────────────── API helpers ───────────────────

const API = 'http://localhost:3001';

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return data;
}

// ─────────────────── Command handler ───────────────────

async function runCommand(cmd: string): Promise<{ type: ConsoleLine['type']; text: string }[]> {
  const parts = cmd.trim().split(/\s+/);
  const verb = parts[0].toLowerCase();

  const json = (d: unknown) => JSON.stringify(d, null, 2);

  switch (verb) {
    case 'help':
      return [{ type: 'info', text: `Available commands:
  health               — server health check
  signals              — live strategy signals + indicators
  markets              — active binary markets
  candles [interval]   — OHLCV candles (10s/30s/1m/5m/15m/1h/4h/1d)
  book <tokenId>       — order book for a market token

  buy <marketId> <entryPrice> <size> [reason]
                       — place YES paper trade
  sell <marketId> <entryPrice> <size> [reason]
                       — place NO paper trade
  close <tradeId> <exitPrice>
                       — close a paper trade
  positions            — open paper positions
  trades               — full trade history
  pnl                  — P&L summary

  dbstatus             — historical candle counts
  download [coins...] [--tf timeframes...]
                       — download historical data
  backtest <coins> <timeframes> [--capital N] [--threshold N]
                       — run a backtest (returns jobId)
  jobs                 — list backtest jobs
  result <jobId>       — get backtest result
  deljob <jobId>       — delete a backtest job
  export <jobId> [csv] — export backtest results

  clear                — clear console
  help                 — show this help` }];

    case 'health': {
      const d = await call('GET', '/api/health');
      return [{ type: 'success', text: json(d) }];
    }

    case 'signals': {
      const d = await call('GET', '/api/signals') as any;
      const v = d.verdict ?? {};
      const strats = (d.strategies ?? []) as any[];
      const top = strats.sort((a: any, b: any) => b.confidence - a.confidence).slice(0, 3);
      const summary = `Verdict: ${v.direction ?? '?'} (bull: ${v.bullishScore ?? 0}, bear: ${v.bearishScore ?? 0})
Top strategies:${top.map((s: any) => `\n  ${s.name}: ${s.signal} [conf: ${s.confidence}%]`).join('')}`;
      return [
        { type: 'info', text: summary },
        { type: 'output', text: json(d) },
      ];
    }

    case 'markets': {
      const d = await call('GET', '/api/markets') as any[];
      const summary = d.slice(0, 5).map((m: any) =>
        `${m.asset} ${m.interval}  YES:${m.yesPrice?.toFixed(3)}  NO:${m.noPrice?.toFixed(3)}  vol:${m.volume24h?.toFixed(0)}  id:${m.id?.slice(0, 8)}…`
      ).join('\n');
      return [
        { type: 'info', text: `${d.length} markets (showing first 5):\n${summary}` },
        { type: 'output', text: json(d) },
      ];
    }

    case 'candles': {
      const interval = parts[1] ?? '5m';
      const d = await call('GET', '/api/btc') as any;
      const key = `candles${interval}` as keyof typeof d;
      const candles = (d[key] ?? []).slice(-10) as any[];
      const text = candles.length
        ? candles.map((c: any) => `O:${c.open.toFixed(2)}  H:${c.high.toFixed(2)}  L:${c.low.toFixed(2)}  C:${c.close.toFixed(2)}  V:${c.volume.toFixed(0)}`).join('\n')
        : `No candles for interval "${interval}"`;
      return [{ type: 'output', text: `Last ${candles.length} ${interval} candles:\n${text}` }];
    }

    case 'book': {
      if (!parts[1]) return [{ type: 'error', text: 'Usage: book <tokenId>' }];
      const d = await call('GET', `/api/market/${parts[1]}/book`);
      return [{ type: 'output', text: json(d) }];
    }

    case 'buy':
    case 'sell': {
      const direction = verb === 'buy' ? 'YES' : 'NO';
      if (parts.length < 4) return [{ type: 'error', text: `Usage: ${verb} <marketId> <entryPrice> <size> [reason]` }];
      const [, marketId, entryPriceStr, sizeStr, ...reasonParts] = parts;
      const d = await call('POST', '/api/trade/paper', {
        marketId,
        direction,
        entryPrice: parseFloat(entryPriceStr),
        size: parseFloat(sizeStr),
        reason: reasonParts.join(' ') || undefined,
        asset: 'BTC',
      });
      return [{ type: 'success', text: `Trade opened:\n${json(d)}` }];
    }

    case 'close': {
      if (parts.length < 3) return [{ type: 'error', text: 'Usage: close <tradeId> <exitPrice>' }];
      const [, tradeId, exitPriceStr] = parts;
      const d = await call('POST', `/api/trade/paper/${tradeId}/close`, { exitPrice: parseFloat(exitPriceStr) });
      return [{ type: 'success', text: `Trade closed:\n${json(d)}` }];
    }

    case 'positions': {
      const d = await call('GET', '/api/positions') as any[];
      if (!d.length) return [{ type: 'info', text: 'No open positions.' }];
      const rows = d.map((t: any) => `[${t.id.slice(0, 8)}] ${t.direction} @ ${t.entry_price} × $${t.size}  ${t.market_q?.slice(0, 40) ?? ''}…`).join('\n');
      return [{ type: 'output', text: `${d.length} open positions:\n${rows}` }];
    }

    case 'trades': {
      const d = await call('GET', '/api/trades') as any[];
      return [{ type: 'output', text: json(d) }];
    }

    case 'pnl': {
      const d = await call('GET', '/api/pnl');
      return [{ type: 'success', text: json(d) }];
    }

    case 'dbstatus': {
      const d = await call('GET', '/api/backtest/db-status');
      return [{ type: 'output', text: json(d) }];
    }

    case 'download': {
      const coins = parts.slice(1).filter(p => !p.startsWith('--')) || undefined;
      const d = await call('POST', '/api/backtest/download', { coins: coins.length ? coins : undefined });
      return [{ type: 'info', text: `Download started:\n${json(d)}\n(Monitor progress via SSE stream)` }];
    }

    case 'backtest': {
      if (parts.length < 3) return [{ type: 'error', text: 'Usage: backtest <coins,comma-sep> <timeframes,comma-sep> [--capital N] [--threshold N]' }];
      const coins = parts[1].split(',');
      const timeframes = parts[2].split(',');
      let initialCapital = 100;
      let thresholdMin = 7;
      for (let i = 3; i < parts.length - 1; i++) {
        if (parts[i] === '--capital') initialCapital = parseFloat(parts[i + 1]);
        if (parts[i] === '--threshold') thresholdMin = parseFloat(parts[i + 1]);
      }
      const d = await call('POST', '/api/backtest/run', { coins, timeframes, initialCapital, thresholdMin });
      return [{ type: 'success', text: `Backtest submitted:\n${json(d)}\nUse "result <jobId>" to check results.` }];
    }

    case 'jobs': {
      const d = await call('GET', '/api/backtest/jobs') as any[];
      if (!d.length) return [{ type: 'info', text: 'No backtest jobs.' }];
      const rows = d.map((j: any) => `[${j.id.slice(0, 8)}] ${j.status.padEnd(10)} ${j.progress}%  ${new Date(j.created_at).toLocaleTimeString()}`).join('\n');
      return [{ type: 'output', text: `${d.length} jobs:\n${rows}` }];
    }

    case 'result': {
      if (!parts[1]) return [{ type: 'error', text: 'Usage: result <jobId>' }];
      const d = await call('GET', `/api/backtest/jobs/${parts[1]}`) as any;
      if (d.status !== 'completed') return [{ type: 'info', text: `Job ${d.status} (${d.progress}%)` }];
      const r = d.result;
      const summary = r ? `Win rate: ${(r.winRate * 100).toFixed(1)}%  Sharpe: ${r.sharpeRatio?.toFixed(2) ?? 'N/A'}  Drawdown: ${(r.maxDrawdown * 100).toFixed(1)}%  Trades: ${r.totalTrades}` : '';
      return [
        { type: 'success', text: summary },
        { type: 'output', text: json(d) },
      ];
    }

    case 'deljob': {
      if (!parts[1]) return [{ type: 'error', text: 'Usage: deljob <jobId>' }];
      const d = await call('DELETE', `/api/backtest/jobs/${parts[1]}`);
      return [{ type: 'success', text: json(d) }];
    }

    case 'export': {
      if (!parts[1]) return [{ type: 'error', text: 'Usage: export <jobId> [csv]' }];
      const fmt = parts[2] === 'csv' ? 'csv' : 'json';
      const d = await call('GET', `/api/backtest/export/${parts[1]}?format=${fmt}`);
      return [{ type: 'output', text: typeof d === 'string' ? d : json(d) }];
    }

    case 'clear':
      return [{ type: 'info', text: '__CLEAR__' }];

    case '':
      return [];

    default:
      return [{ type: 'error', text: `Unknown command: "${verb}". Type "help" for a list.` }];
  }
}

// ─────────────────── Component ───────────────────

const LINE_COLORS: Record<ConsoleLine['type'], string> = {
  input:   'text-cyan-400',
  output:  'text-gray-300',
  error:   'text-red-400',
  info:    'text-gray-400',
  success: 'text-green-400',
};

let _id = 0;
const nextId = () => ++_id;

export function AgentConsole({ onClose }: Props) {
  const [minimized, setMinimized] = useState(false);
  const [lines, setLines] = useState<ConsoleLine[]>([
    { id: nextId(), type: 'info', time: ts(), text: 'AI Agent ready. Ask anything in natural language.\nExamples: "Should I buy BTC now?" · "Show my P&L" · "Run a BTC 5m backtest"\nTip: prefix with / for raw commands (e.g. /signals, /positions, /help)' },
  ]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  // Position & size
  const [pos, setPos] = useState({ x: window.innerWidth - 680, y: 60 });
  const [size, setSize] = useState({ w: 640, h: 480 });

  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizing = useRef(false);
  const resizeStart = useRef({ mx: 0, my: 0, w: 0, h: 0 });

  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function ts() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  function addLines(newLines: { type: ConsoleLine['type']; text: string }[]) {
    setLines(prev => {
      const next = [...prev];
      for (const l of newLines) {
        if (l.text === '__CLEAR__') return [];
        next.push({ id: nextId(), type: l.type, time: ts(), text: l.text });
      }
      return next;
    });
  }

  // Auto-scroll
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  // Drag — title bar
  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - size.w, e.clientX - dragOffset.current.x)),
        y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dragOffset.current.y)),
      });
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [size.w]);

  // Resize — bottom-right corner
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    resizing.current = true;
    resizeStart.current = { mx: e.clientX, my: e.clientY, w: size.w, h: size.h };
    e.preventDefault();
    e.stopPropagation();
  }, [size]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      const { mx, my, w, h } = resizeStart.current;
      setSize({
        w: Math.max(360, w + (e.clientX - mx)),
        h: Math.max(200, h + (e.clientY - my)),
      });
    };
    const onUp = () => { resizing.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Submit — routes between raw CLI (/command) and natural language (AI agent)
  const submit = useCallback(async () => {
    const cmd = input.trim();
    if (!cmd || busy) return;

    // /command prefix → raw CLI mode (old behavior, no AI involved)
    if (cmd.startsWith('/')) {
      const rawCmd = cmd.slice(1);
      addLines([{ type: 'input', text: `$ ${rawCmd}` }]);
      setHistory(h => [cmd, ...h.slice(0, 49)]);
      setHistIdx(-1);
      setInput('');
      setBusy(true);
      try {
        const result = await runCommand(rawCmd);
        addLines(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addLines([{ type: 'error', text: `Error: ${msg}` }]);
      } finally {
        setBusy(false);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      return;
    }

    // Natural language → AI agent
    addLines([{ type: 'input', text: cmd }]);
    setHistory(h => [cmd, ...h.slice(0, 49)]);
    setHistIdx(-1);
    setInput('');
    setBusy(true);

    const newHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: cmd }];
    try {
      addLines([{ type: 'info', text: '⟳ thinking…' }]);

      const res = await fetch(`${API}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cmd, history: chatHistory }),
      });

      const data = await res.json() as { response: string };
      setLines(prev => prev.slice(0, -1)); // remove "thinking…"

      if (data.response) {
        addLines([{ type: 'success', text: data.response }]);
      }

      setChatHistory([...newHistory, { role: 'assistant', content: data.response ?? '' }]);
    } catch (err: unknown) {
      setLines(prev => prev.slice(0, -1)); // remove "thinking…"
      const msg = err instanceof Error ? err.message : String(err);
      addLines([{ type: 'error', text: `Error: ${msg}` }]);
    } finally {
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [input, busy, chatHistory]);

  // Key handlers
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { submit(); return; }
    if (e.key === 'ArrowUp') {
      const idx = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(idx);
      setInput(history[idx] ?? '');
      e.preventDefault();
    }
    if (e.key === 'ArrowDown') {
      const idx = Math.max(histIdx - 1, -1);
      setHistIdx(idx);
      setInput(idx < 0 ? '' : (history[idx] ?? ''));
      e.preventDefault();
    }
  };

  const containerH = minimized ? 0 : size.h - 40;

  return (
    <div
      className="fixed z-50 flex flex-col rounded-lg border border-gray-600 shadow-2xl bg-gray-950 select-none"
      style={{ left: pos.x, top: pos.y, width: size.w }}
    >
      {/* Title bar */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-gray-800 rounded-t-lg cursor-move border-b border-gray-700"
        onMouseDown={onDragStart}
      >
        <Terminal className="w-4 h-4 text-cyan-400 shrink-0" />
        <span className="text-sm font-mono font-medium text-cyan-300 flex-1">Agent Console</span>
        {busy && <span className="text-xs text-gray-400 animate-pulse">running…</span>}
        <button
          onClick={() => setMinimized(m => !m)}
          className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white transition-colors"
          title="Minimize"
        >
          <Minus className="w-3 h-3" />
        </button>
        <button
          onClick={onClose}
          className="p-1 hover:bg-red-700 rounded text-gray-400 hover:text-white transition-colors"
          title="Close"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Console output */}
      {!minimized && (
        <div
          className="overflow-y-auto overflow-x-hidden font-mono text-xs leading-relaxed p-3 bg-gray-950"
          style={{ height: containerH - 44 }}
          onClick={() => inputRef.current?.focus()}
        >
          {lines.map(line => (
            <div key={line.id} className={`flex gap-2 mb-1 ${LINE_COLORS[line.type]}`}>
              <span className="text-gray-600 shrink-0">{line.time}</span>
              <pre className="whitespace-pre-wrap break-words flex-1">{line.text}</pre>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}

      {/* Input bar — always visible */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-gray-700 bg-gray-900 rounded-b-lg">
        <ChevronRight className="w-4 h-4 text-cyan-400 shrink-0" />
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder='Ask anything… (prefix / for raw commands)'
          disabled={busy}
          autoFocus
          className="flex-1 bg-transparent text-sm font-mono text-white placeholder-gray-600 outline-none disabled:opacity-50"
          spellCheck={false}
        />
        <button
          onClick={submit}
          disabled={busy || !input.trim()}
          className="text-xs text-cyan-400 hover:text-cyan-200 disabled:opacity-30 transition-colors px-1"
        >
          ↵
        </button>
      </div>

      {/* Resize handle */}
      {!minimized && (
        <div
          className="absolute bottom-0 right-0 w-5 h-5 cursor-se-resize"
          onMouseDown={onResizeStart}
          style={{
            background: 'linear-gradient(135deg, transparent 50%, rgba(100,100,120,0.5) 50%)',
            borderRadius: '0 0 8px 0',
          }}
        />
      )}
    </div>
  );
}
