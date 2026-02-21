# Natural Language Agent Console — Design

**Date:** 2026-02-21
**Status:** Approved

## Problem

The Agent Console currently requires exact CLI-style commands (`signals`, `buy <id> <price> <size>`). This is friction-heavy and excludes non-technical use. The goal is to replace the input with a natural language interface powered by Claude so you can say "Should I buy BTC right now?" and the agent reasons, gathers data, and responds intelligently.

## Solution

Server-side agentic loop using `claude-opus-4-6` with tool calling. The existing 16 REST endpoints are exposed as Claude tools. Claude reasons across multiple tool calls per message, then returns a human-readable response. Write operations (trades, backtests) require user confirmation.

## Architecture

```
User message → POST /api/agent/chat → server/agent.ts
                                           │
                                    claude-opus-4-6
                                    + 16 tool defs
                                           │
                               ┌── tool_use calls (loop) ──┐
                               │  execute against REST API  │
                               └───────────────────────────┘
                                           │
                               text response + actions log
                                           │
                          AgentConsole.tsx displays result
```

## Components

### `server/agent.ts` (new)
- Anthropic SDK, model `claude-opus-4-6`
- System prompt: trading expert context + confirmation rules for write ops
- 16 tool definitions (all REST endpoints)
- Agentic loop max 10 iterations
- Returns `{ response: string, actions: { tool, input, result }[] }`

### `POST /api/agent/chat` (add to `server/index.ts`)
- Body: `{ message: string, history: AnthropicMessage[] }`
- History capped at 20 messages
- Returns agent response + actions taken

### `AgentConsole.tsx` (update)
- All input → `/api/agent/chat` (natural language)
- `/command` prefix → old CLI parser (escape hatch for power users)
- Shows `[tool] name → result` line per tool call
- Maintains `history[]` in React state (sent with every request)
- Confirmation flow: Claude proposes write actions → user replies "yes" to execute

## Confirmation Protocol

System prompt instructs Claude:
> "For any tool that places trades, starts backtests, or downloads data, describe your planned action first and end with 'Reply yes to confirm.' Do NOT call the write tool until the user explicitly confirms."

When user replies "yes", the full conversation history gives Claude context to recall and execute the pending action.

## Key Constraints
- `ANTHROPIC_API_KEY` required in server `.env`
- No streaming (full round-trip per message)
- Tool results truncated to 2000 chars per call
- History capped at 20 messages to control token cost
- Raw `/command` mode preserved for power users
