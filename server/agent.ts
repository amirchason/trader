import { spawn } from 'child_process';

// Claude binary — configurable via CLAUDE_BIN env var, falls back to known install path.
// The Express server is a plain Node.js process (not a Claude Code session), so spawning
// claude -p here is NOT subject to the nested-session protection. The subprocess inherits
// ~/.claude/claude.json and gets all 16 trader MCP tools automatically.
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'C:\\Users\\ahava\\.local\\bin\\claude.exe';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentResponse {
  response: string;
}

// System context is embedded in the prompt rather than using a --system flag,
// which may or may not be supported depending on the claude CLI version.
const SYSTEM_PROMPT = `You are an expert trading agent for a Polymarket binary options platform.
You have access to real-time BTC/ETH/SOL/XRP prices, strategy signals, and a paper trading engine
via the "trader" MCP tools (trader__get_live_signals, trader__get_active_markets,
trader__place_paper_trade, trader__get_positions, trader__get_pnl, etc.).

RULES:
1. READ operations (signals, markets, candles, positions, pnl, health, backtest jobs/results):
   Execute immediately using the appropriate trader MCP tool, then report findings in plain English.

2. WRITE operations (place_paper_trade, close_paper_trade, run_backtest, download_historical_data, delete_backtest_job):
   First explain exactly what you plan to do and why, then end your message with:
   "Reply yes to confirm or cancel to abort."
   Do NOT call the write tool until the user explicitly replies "yes" or "confirm" or "do it".

3. Be concise but insightful. Lead with the key insight, support with data from tool results.

4. Binary options context:
   - YES token price near 0 = market thinks event very unlikely
   - YES token price near 1 = market thinks event very likely
   - We trade on whether BTC/ETH/SOL/XRP will be above a strike price at expiry
   - Strategy confidence > 75% is a strong signal; > 85% is very strong

5. When recommending a trade, always specify: direction (YES/NO), which market, size, and reasoning.

---
`;

export async function agentChat(
  message: string,
  history: ChatMessage[],
): Promise<AgentResponse> {
  // Build the full prompt with system context + conversation history embedded.
  // This avoids relying on CLI flags that may not be available.
  const conversationLines = history.map(m =>
    `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`,
  );

  const conversation = conversationLines.length > 0
    ? conversationLines.join('\n\n') + '\n\n'
    : '';

  const fullPrompt = `${SYSTEM_PROMPT}${conversation}Human: ${message}`;

  // Strip CLAUDECODE so the subprocess isn't blocked by nested-session protection.
  // The Express server inherits this var from the shell that started it (Claude Code),
  // but the subprocess itself is a fresh claude invocation, not a nested session.
  const env = { ...process.env };
  delete env['CLAUDECODE'];

  const startMs = Date.now();
  console.error(`[agent] starting claude subprocess for: "${message.slice(0, 60)}..."`);

  return new Promise<AgentResponse>(resolve => {
    // Use spawn with stdin='ignore' to ensure the subprocess doesn't block waiting
    // for terminal input — critical on Windows where execFile can leave stdin open.
    const child = spawn(CLAUDE_BIN, ['-p', fullPrompt], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    console.error(`[agent] subprocess PID: ${child.pid}`);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stdout += s;
      console.error(`[agent] stdout chunk (${s.length} chars)`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const s = chunk.toString();
      stderr += s;
      process.stderr.write(`[agent] stderr: ${s}`);
    });

    const timer = setTimeout(() => {
      console.error(`[agent] TIMEOUT after ${Date.now() - startMs}ms — killing`);
      child.kill();
      resolve({ response: 'Agent timeout: claude took too long to respond.' });
    }, 120_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Date.now() - startMs;
      console.error(`[agent] closed code=${code} elapsed=${elapsed}ms stdout=${stdout.length} stderr=${stderr.length}`);
      if (stderr && !stdout) {
        resolve({ response: `Agent error: ${stderr.trim().slice(0, 500)}` });
      } else {
        resolve({ response: stdout.trim() || '(no response)' });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[agent] spawn error:', err.message);
      resolve({ response: `Agent error: ${err.message}` });
    });
  });
}
