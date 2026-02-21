# Natural Language Agent Console Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the Agent Console's CLI-style command parser with a natural language interface powered by `claude-opus-4-6` tool calling, while preserving `/command` syntax as an escape hatch.

**Architecture:** Server-side agentic loop in `server/agent.ts` — receives conversation history, calls Claude API with 16 tool definitions (our REST endpoints), executes tool calls against `localhost:3001`, returns `{ response, actions[] }` to the frontend. Write operations (trades, backtests) require user confirmation before Claude executes them.

**Tech Stack:** `@anthropic-ai/sdk` (server), `claude-opus-4-6` model, existing Express + TypeScript, React frontend.

---

## Pre-flight: What Already Exists

- `server/index.ts` — Express server on port 3001, all REST endpoints already live
- `src/components/AgentConsole.tsx` — floating console UI with CLI command parser
- `mcp-server/client.ts` — HTTP helper patterns we can adapt for server/agent.ts
- No `.env` file yet — needs creating with `ANTHROPIC_API_KEY`
- `@anthropic-ai/sdk` NOT yet installed

---

### Task 1: Install Anthropic SDK and create .env

**Files:**
- Modify: `package.json` (via npm install)
- Create: `c:\proj\trader\.env`
- Modify: `c:\proj\trader\.env.example`

**Step 1: Install SDK**

```bash
cd c:/proj/trader && npm install @anthropic-ai/sdk
```

Expected output: `added N packages`

**Step 2: Create .env file**

Create `c:\proj\trader\.env` with content:
```
PORT=3001
ANTHROPIC_API_KEY=your-api-key-here
```

> **IMPORTANT:** The user must replace `your-api-key-here` with a real Anthropic API key from https://console.anthropic.com/

**Step 3: Update .env.example**

Edit `c:\proj\trader\.env.example` to add:
```
PORT=3001
ANTHROPIC_API_KEY=        # Required for natural language agent console
```

**Step 4: Load dotenv in server**

Check `server/index.ts` line 1 — if `import 'dotenv/config'` or similar is not already there, add it at the very top:
```typescript
import 'dotenv/config';
```
(dotenv is already a dependency — no install needed)

**Step 5: Verify type-check still passes**

```bash
cd c:/proj/trader && npx tsc --project tsconfig.server.json --noEmit
```
Expected: no errors

---

### Task 2: Create server/agent.ts — Agentic Loop

**Files:**
- Create: `c:\proj\trader\server\agent.ts`

This is the core file. It exports one function `agentChat()` that runs the agentic loop.

**Step 1: Write server/agent.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-4-6';
const BASE = process.env.TRADER_API_URL ?? 'http://localhost:3001';
const MAX_ITERATIONS = 10;
const MAX_TOOL_RESULT_CHARS = 2000;

// ─────────────────── Types ───────────────────

export interface AgentAction {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
}

export interface AgentResponse {
  response: string;
  actions: AgentAction[];
}

// ─────────────────── System prompt ───────────────────

const SYSTEM_PROMPT = `You are an expert trading agent for a Polymarket binary options platform.
You have access to real-time BTC/ETH/SOL/XRP prices, strategy signals, and a paper trading engine.

RULES:
1. For READ operations (signals, markets, candles, positions, pnl, health, jobs, results):
   Execute immediately and report findings.

2. For WRITE operations (place_paper_trade, close_paper_trade, run_backtest, download_historical_data, delete_backtest_job):
   First explain exactly what you plan to do, then end your message with:
   "Reply **yes** to confirm or **cancel** to abort."
   Do NOT call the write tool until the user explicitly replies "yes" or "confirm" or "do it".

3. Be concise but insightful. Lead with the key insight, support with data.

4. Binary options context:
   - YES token price close to 0 = market thinks event unlikely
   - YES token price close to 1 = market thinks event very likely
   - You trade on whether BTC/ETH/SOL/XRP will be above a strike price at expiry
   - Strategy confidence > 75% is strong; > 85% is very strong

5. When recommending a trade, always specify: direction (YES/NO), which market, entry price, size, and reasoning.`;

// ─────────────────── Tool definitions ───────────────────

const TOOLS: Anthropic.Tool[] = [
  // ── Market data ──
  {
    name: 'get_health',
    description: 'Check server health: connection status, market count, SSE clients, live prices.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_live_signals',
    description: 'Get current BTC strategy signals. Returns 5 strategies (Momentum Burst, Mean Reversion, Funding Squeeze, Order Book Imbalance, VWAP Crossover) each with score 0-10 and confidence 0-100, plus RSI/MACD/VWAP indicators and overall verdict (BULLISH/BEARISH/NEUTRAL).',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_active_markets',
    description: 'List all active Polymarket binary option markets (BTC/ETH/SOL/XRP, 5m and 15m expiry). Each has yesPrice, noPrice (0-1), volume, liquidity, and epochEnd timestamp.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_candles',
    description: 'Get live BTC OHLCV candles. Available intervals: 10s, 30s, 1m, 5m, 15m, 1h, 4h, 1d.',
    input_schema: {
      type: 'object' as const,
      properties: {
        interval: { type: 'string', enum: ['10s', '30s', '1m', '5m', '15m', '1h', '4h', '1d'], description: 'Candle interval' },
        limit: { type: 'number', description: 'Number of candles (1-500, default 50)' },
      },
      required: ['interval'],
    },
  },
  {
    name: 'get_order_book',
    description: 'Get Polymarket CLOB order book for a market token.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tokenId: { type: 'string', description: 'Polymarket token ID (yesTokenId or noTokenId from get_active_markets)' },
      },
      required: ['tokenId'],
    },
  },
  // ── Paper trading ──
  {
    name: 'place_paper_trade',
    description: 'WRITE OPERATION — Open a paper trade. entryPrice is YES token price (0-1). size is USD.',
    input_schema: {
      type: 'object' as const,
      properties: {
        marketId: { type: 'string', description: 'Market ID from get_active_markets' },
        direction: { type: 'string', enum: ['YES', 'NO'], description: 'Buy YES or NO token' },
        entryPrice: { type: 'number', description: 'Current YES price (0-1)' },
        size: { type: 'number', description: 'Position size in USD' },
        marketQ: { type: 'string', description: 'Market question text' },
        asset: { type: 'string', description: 'Asset (BTC/ETH/SOL/XRP)' },
        reason: { type: 'string', description: 'Reasoning for this trade' },
        strategy: { type: 'string', description: 'Strategy that triggered this trade' },
        confidence: { type: 'number', description: 'Signal confidence 0-100' },
      },
      required: ['marketId', 'direction', 'entryPrice', 'size'],
    },
  },
  {
    name: 'close_paper_trade',
    description: 'WRITE OPERATION — Close an open paper trade at exitPrice and calculate P&L.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tradeId: { type: 'string', description: 'Trade ID from get_positions' },
        exitPrice: { type: 'number', description: 'Current YES price (0-1) at close time' },
      },
      required: ['tradeId', 'exitPrice'],
    },
  },
  {
    name: 'get_positions',
    description: 'Get all open paper trading positions.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_trade_log',
    description: 'Get full paper trading history with P&L for all open and closed trades.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_pnl',
    description: 'Get paper trading P&L summary: realized P&L, win rate, win/loss counts.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  // ── Backtesting ──
  {
    name: 'get_db_status',
    description: 'Check available historical OHLCV candles per coin/timeframe in the local SQLite database.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'download_historical_data',
    description: 'WRITE OPERATION — Download 6 months of historical OHLCV data from Binance. Required before running backtests.',
    input_schema: {
      type: 'object' as const,
      properties: {
        coins: { type: 'array', items: { type: 'string' }, description: 'Coins (default: BTC/ETH/SOL/XRP)' },
        timeframes: { type: 'array', items: { type: 'string' }, description: 'Timeframes (default: 1m/5m/15m/1h/4h/1d)' },
      },
      required: [],
    },
  },
  {
    name: 'run_backtest',
    description: 'WRITE OPERATION — Submit a backtest job. Returns jobId — poll get_backtest_result for results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        coins: { type: 'array', items: { type: 'string' }, description: 'Coins to test' },
        timeframes: { type: 'array', items: { type: 'string' }, description: 'Timeframes to test' },
        strategies: { type: 'array', items: { type: 'string' }, description: '"all","momentum","meanReversion","fundingSqueeze","orderBook","vwap"' },
        signalModes: { type: 'array', items: { type: 'string' }, description: '"threshold","crossover","every_candle","combined"' },
        initialCapital: { type: 'number', description: 'Starting capital USD (default 100)' },
        thresholdMin: { type: 'number', description: 'Min score 0-10 to trigger trade (default 7)' },
        fromMs: { type: 'number', description: 'Start timestamp ms' },
        toMs: { type: 'number', description: 'End timestamp ms' },
      },
      required: ['coins', 'timeframes'],
    },
  },
  {
    name: 'get_backtest_jobs',
    description: 'List all backtest jobs with status and progress.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_backtest_result',
    description: 'Get full results for a completed backtest: equity curve, trade log, per-strategy metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        jobId: { type: 'string', description: 'Job ID from run_backtest' },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'delete_backtest_job',
    description: 'WRITE OPERATION — Delete a completed or failed backtest job.',
    input_schema: {
      type: 'object' as const,
      properties: {
        jobId: { type: 'string', description: 'Job ID to delete' },
      },
      required: ['jobId'],
    },
  },
];

// ─────────────────── Tool executor ───────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const get = (path: string) =>
    fetch(`${BASE}${path}`).then(r => r.json());
  const post = (path: string, body: unknown) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
  const del = (path: string) =>
    fetch(`${BASE}${path}`, { method: 'DELETE' }).then(r => r.json());

  switch (name) {
    case 'get_health': return get('/api/health');
    case 'get_live_signals': return get('/api/signals');
    case 'get_active_markets': return get('/api/markets');
    case 'get_candles': {
      const data = await get('/api/btc') as Record<string, unknown>;
      const key = `candles${input.interval}` as keyof typeof data;
      const all = (data[key] ?? []) as unknown[];
      const limit = Number(input.limit ?? 50);
      return all.slice(-limit);
    }
    case 'get_order_book': return get(`/api/market/${input.tokenId}/book`);
    case 'place_paper_trade': return post('/api/trade/paper', {
      marketId: input.marketId,
      marketQ: input.marketQ ?? '',
      asset: input.asset ?? 'BTC',
      direction: input.direction,
      entryPrice: input.entryPrice,
      size: input.size,
      reason: input.reason,
      strategy: input.strategy,
      confidence: input.confidence,
    });
    case 'close_paper_trade': return post(`/api/trade/paper/${input.tradeId}/close`, { exitPrice: input.exitPrice });
    case 'get_positions': return get('/api/positions');
    case 'get_trade_log': return get('/api/trades');
    case 'get_pnl': return get('/api/pnl');
    case 'get_db_status': return get('/api/backtest/db-status');
    case 'download_historical_data': return post('/api/backtest/download', { coins: input.coins, timeframes: input.timeframes });
    case 'run_backtest': return post('/api/backtest/run', input);
    case 'get_backtest_jobs': return get('/api/backtest/jobs');
    case 'get_backtest_result': return get(`/api/backtest/jobs/${input.jobId}`);
    case 'delete_backtest_job': return del(`/api/backtest/jobs/${input.jobId}`);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─────────────────── Agentic loop ───────────────────

export async function agentChat(
  history: Anthropic.MessageParam[],
): Promise<AgentResponse> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      response: 'ANTHROPIC_API_KEY is not set. Add it to your .env file and restart the server.',
      actions: [],
    };
  }

  const client = new Anthropic();
  const actions: AgentAction[] = [];
  let messages: Anthropic.MessageParam[] = [...history];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map(c => c.text)
        .join('');
      return { response: text, actions };
    }

    if (response.stop_reason === 'tool_use') {
      // Add assistant turn
      messages = [...messages, { role: 'assistant', content: response.content }];

      // Execute all tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        let result: unknown;
        try {
          result = await executeTool(block.name, block.input as Record<string, unknown>);
        } catch (err: unknown) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }

        actions.push({ tool: block.name, input: block.input as Record<string, unknown>, result });

        // Truncate large results
        const resultStr = JSON.stringify(result);
        const truncated = resultStr.length > MAX_TOOL_RESULT_CHARS
          ? resultStr.slice(0, MAX_TOOL_RESULT_CHARS) + '… [truncated]'
          : resultStr;

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncated,
        });
      }

      messages = [...messages, { role: 'user', content: toolResults }];
      continue;
    }

    // Unexpected stop reason
    break;
  }

  return { response: 'Agent loop reached max iterations.', actions };
}
```

**Step 2: Verify type-check**

```bash
cd c:/proj/trader && npx tsc --project tsconfig.server.json --noEmit
```
Expected: no errors

---

### Task 3: Add POST /api/agent/chat to server/index.ts

**Files:**
- Modify: `c:\proj\trader\server\index.ts`

**Step 1: Add import at the top of server/index.ts**

After the existing imports, add:
```typescript
import { agentChat } from './agent';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
```

**Step 2: Add the route**

Find the comment `// ─────────────────── Paper Trading Routes ───────────────────` in server/index.ts.
Add a new section BEFORE it:

```typescript
// ─────────────────── AI Agent Route ───────────────────

app.post('/api/agent/chat', async (req: Request, res: Response) => {
  try {
    const { message, history = [] } = req.body as {
      message: string;
      history: MessageParam[];
    };

    if (!message?.trim()) {
      return res.status(400).json({ error: 'message required' });
    }

    // Cap history to last 20 messages to control token cost
    const cappedHistory = history.slice(-20);

    // Append the new user message
    const messages: MessageParam[] = [
      ...cappedHistory,
      { role: 'user', content: message },
    ];

    const result = await agentChat(messages);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
```

**Step 3: Type-check**

```bash
cd c:/proj/trader && npx tsc --project tsconfig.server.json --noEmit
```
Expected: no errors

---

### Task 4: Update AgentConsole.tsx — Natural Language Mode

**Files:**
- Modify: `c:\proj\trader\src\components\AgentConsole.tsx`

The component needs:
1. A `history` state: `Anthropic.MessageParam[]` (but as plain objects `{role, content}`)
2. A new `submitNL()` path that calls `/api/agent/chat`
3. `/command` prefix → old `runCommand()` (unchanged)
4. Tool calls shown as `[tool] name → ...` lines in console
5. Welcome message updated to explain natural language mode

**Step 1: Add history state and types to AgentConsole.tsx**

At the top of the file, add the `ChatMessage` type and update imports:

```typescript
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AgentAction {
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
}
```

**Step 2: Add history state inside the component**

```typescript
const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
```

**Step 3: Add the natural language submit handler**

Add `submitNL` function inside the component (alongside the existing `submit`):

```typescript
const submitNL = useCallback(async (userMsg: string) => {
  addLines([{ type: 'input', text: userMsg }]);
  setHistory(h => [userMsg, ...h.slice(0, 49)]);
  setHistIdx(-1);
  setInput('');
  setBusy(true);

  // Optimistically add user message to history
  const newHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: userMsg }];

  try {
    addLines([{ type: 'info', text: '⟳ thinking…' }]);

    const res = await fetch('http://localhost:3001/api/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMsg, history: chatHistory }),
    });

    const data = await res.json() as { response: string; actions: AgentAction[] };

    // Remove the "thinking" line (it's the last one)
    setLines(prev => prev.slice(0, -1));

    // Show each tool action
    for (const action of (data.actions ?? [])) {
      const resultStr = JSON.stringify(action.result, null, 2);
      const preview = resultStr.length > 300 ? resultStr.slice(0, 300) + '…' : resultStr;
      addLines([{ type: 'info', text: `[tool] ${action.tool} →\n${preview}` }]);
    }

    // Show Claude's response
    if (data.response) {
      addLines([{ type: 'success', text: data.response }]);
    }

    // Update history with assistant reply
    setChatHistory([
      ...newHistory,
      { role: 'assistant', content: data.response ?? '' },
    ]);
  } catch (err: unknown) {
    setLines(prev => prev.slice(0, -1)); // remove "thinking"
    const msg = err instanceof Error ? err.message : String(err);
    addLines([{ type: 'error', text: `Error: ${msg}` }]);
  } finally {
    setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }
}, [chatHistory, input, busy]);
```

**Step 4: Update the main submit function to route correctly**

Replace the existing `submit` callback with:

```typescript
const submit = useCallback(async () => {
  const cmd = input.trim();
  if (!cmd || busy) return;

  // /command prefix → raw CLI mode (old behavior)
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

  // Everything else → natural language agent
  await submitNL(cmd);
}, [input, busy, chatHistory]);
```

**Step 5: Update the initial welcome message and placeholder**

Change the initial `lines` state:
```typescript
const [lines, setLines] = useState<ConsoleLine[]>([
  { id: nextId(), type: 'info', time: ts(), text: 'AI Agent ready (claude-opus-4-6). Ask anything in natural language.\nExamples: "Should I buy BTC now?" · "Show me my P&L" · "Run a BTC 5m backtest"\nTip: prefix with / to use raw commands (e.g. /signals)' },
]);
```

Change the input placeholder:
```typescript
placeholder='Ask anything… (prefix / for raw commands)'
```

**Step 6: Type-check frontend**

```bash
cd c:/proj/trader && npx tsc --noEmit
```
Expected: no errors

---

### Task 5: Restart server and verify end-to-end

**Step 1: Stop any running server**

```bash
# Find and kill process on port 3001
netstat -ano | grep ":3001"
# Then: cmd //c "taskkill /PID <pid> /F"
```

**Step 2: Ensure ANTHROPIC_API_KEY is set in .env**

The `.env` file must exist at `c:\proj\trader\.env` with a valid key.

**Step 3: Start the server**

```bash
cd c:/proj/trader && npm run dev
```

Expected:
```
[Server] Trader API running on http://localhost:3001
[Markets] Updated: XX binary markets
```

**Step 4: Open browser**

Navigate to http://localhost:5174 (or 5175 if 5174 is busy)

**Step 5: Open Agent Console and test natural language**

Click "Agent Console" button. Type:
```
What are the current BTC signals?
```

Expected: Agent calls `get_live_signals`, shows `[tool] get_live_signals → ...`, then gives a natural language summary.

**Step 6: Test a write operation (confirmation flow)**

Type:
```
Buy $25 of BTC YES on the 5 minute market
```

Expected: Agent calls `get_live_signals` + `get_active_markets`, then describes the trade it wants to place and asks for confirmation. Do NOT execute the trade yet.

**Step 7: Confirm the trade**

Type:
```
yes
```

Expected: Agent calls `place_paper_trade`, shows `[tool] place_paper_trade → ...`, confirms trade was placed.

**Step 8: Test raw command escape hatch**

Type:
```
/signals
```

Expected: Old CLI parser runs, shows raw signal data (no AI involved).

**Step 9: Test P&L check**

Type:
```
how are my trades doing?
```

Expected: Agent calls `get_pnl` + optionally `get_positions`, gives human-readable summary.

---

## Notes for Implementer

- The `agentChat()` function in `server/agent.ts` receives the FULL conversation history including previous tool calls as assistant messages. This is what enables Claude to remember "I was about to place a trade" when you reply "yes".

- The frontend only stores `ChatMessage[]` (role + string content), not the full Anthropic message format with tool_use blocks. When you reply "yes" to a confirmation request, Claude reconstructs its intent from the conversation history.

- The `MAX_TOOL_RESULT_CHARS = 2000` truncation prevents context window overflows when API returns large datasets (e.g. full backtest results with hundreds of trades).

- If `ANTHROPIC_API_KEY` is missing, `agentChat()` returns a helpful error message instead of crashing — the server won't fail to start.

- The `/command` prefix is the power-user escape hatch. It bypasses Claude entirely and runs the old command parser directly. Useful for scripts or when you want raw JSON output.
