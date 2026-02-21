---
active: true
iteration: 5
max_iterations: 15
completion_promise: "TASK_COMPLETE"
started_at: "2026-02-21T17:16:51Z"
---

Continue deep backtesting research for ETH 5m binary candle prediction. 15 strategies in server/indicators.ts, 25 research scripts in server/research/. Best WR so far: 79.2% sniper, 69.8% stable. Run scripts with: npx ts-node -P tsconfig.server.json server/research/NAME.ts. DB symbols ETH/BTC/SOL/XRP, columns open_time/open/high/low/close/volume. Good hours UTC: 10,11,12,21. Mean-reverting market, bet against streaks plus BB extremes. Test: RGGG combo with GoodH plus BB, multi-indicator ensemble from validated signals only, and any untested combos above 65% WR with 50 plus trades. Add winners to indicators.ts, update RESEARCH-SUMMARY-V4.md and MEMORY.md.
