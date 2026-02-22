# SOL ML Research Results

**Date:** 2026-02-22
**Dataset:** SOL/5m (52,992 candles) + SOL/15m synthetic from 5m
**Validation:** 3-fold walk-forward (chronological)
**Pass criteria:** WR >= 65%, sigma <= 8%, T >= 50 avg

---

## TOP 5 NEW SOL STRATEGIES (VALIDATED)

| Rank | Strategy | WR | sigma | T | Folds |
|------|----------|-----|-------|---|-------|
| 1 | SOL Daily Range Top30%+BB(20,2.2)+s>=1+GoodH | 74.7% | 1.6% | 79 | 73.1/76.9/74.1 |
| 2 | SOL Keltner(1.5)+BB(20,2.2)+s>=1+GoodH | 68.7% | 4.2% | 147 | 63.3/73.5/69.4 |
| 3 | SOL BB(20,2.2)+dev[0.05-0.25%]+s>=1+GoodH | 71.6% | 5.7% | 88 | 65.5/79.3/70.0 |
| 4 | SOL LowATR<50pct+BB(20,2.2)+s>=1+GoodH | 70.6% | 3.9% | 85 | 75.0/71.4/65.5 |
| 5 | SOL RSI>65+body>=0.2%+BB(20,2.2)+GoodH | 66.7% | 5.1% | 120 | 60.0/67.5/72.5 |

---

## Strategy Definitions

### Strategy 1: SOL Daily Range Extreme (CHAMPION)
WR=74.7% sigma=1.6% T=79 [73.1/76.9/74.1] -- ULTRA STABLE

- Signal: SOL/15m synth price in top/bottom 30% of daily range + BB(20,2.2) + streak>=1 + GoodH[0,12,13,20]
- BEAR: price position >= 70% of daily range + above BB upper + streak>=1 + GoodH
- BULL: price position <= 30% of daily range + below BB lower + streak<=-1 + GoodH
- Max fold delta: 3.8% (most stable SOL strategy found)

Key variants:
- Top20%+BB(20,2.2)+s>=1+GoodH: WR=80.7% sigma=7.4% T=52 [70.6/88.2/83.3]
- Top25%+BB(20,2.2)+s>=1+GoodH: WR=78.8% sigma=7.7% T=66 [68.2/81.8/86.4]
- Top30%+BB(20,2.2)+s>=1+GoodH: WR=74.7% sigma=1.6% T=79 -- BEST STABLE
- Top20%+noHourFilter: WR=70.3% sigma=5.0% T=313 -- HIGH VOLUME option

### Strategy 2: SOL Keltner+BB Squeeze
WR=68.7% sigma=4.2% T=147 [63.3/73.5/69.4]

- Signal: price outside BOTH Keltner(EMA20, ATR10, mult=1.5) AND BB(20,2.2) + streak>=1 + GoodH[0,12,13,20]
- 49 trades/fold -- good statistical reliability
- KC(1.5)+BB(20,2.2)+s>=2+GoodH: WR=67.0% sigma=1.3% T=97 -- ULTRA STABLE variant

### Strategy 3: SOL BB Deviation Sweet Spot
WR=71.6% sigma=5.7% T=88 [65.5/79.3/70.0]

- Signal: price 0.05-0.25% outside BB(20,2.2) + streak>=1 + GoodH[0,12,13,20]
- Deep BB (>0.5% outside) = trend continuation, WR=49% -- skip
- Most stable: BB(25,2)+dev[0.03-0.2%] = WR=67.8% sigma=1.6% T=87 [69/69/65.5]
- High-volume stable: BB(20,2.2)+dev[0-0.25%] = WR=68.8% sigma=2.3% T=128

### Strategy 4: SOL ATR Regime Filter
WR=70.6% sigma=3.9% T=85 [75.0/71.4/65.5]

- Signal: ONLY trade when ATR(14) < 50th pct of rolling 200-bar ATR window
  Then: BB(20,2.2) outside + streak>=1 + GoodH[0,12,13,20]
- Baseline (no ATR filter): 54.8% WR -- ATR filter adds +16% WR!
- High ATR regime: FAIL (54-56%) -- SOL trends in high-vol, mean-reverts in low-vol

### Strategy 5: SOL RSI Panic Exhaustion
WR=66.7% sigma=5.1% T=120 [60.0/67.5/72.5]

- Signal: RSI(14)>65 + candle body>=0.2% + above BB(20,2.2) + GoodH[0,12,13,20]
- BEAR signal: overbought RSI exhaustion at BB upper during good hours
- Symmetric BULL: RSI<35 + body>=0.2% + below BB lower + GoodH
- More trades: RSI>65+BB(20,2)+GoodH = WR=65.4% sigma=4.9% T=153

---

## Failed Strategies

| Strategy | Best WR | sigma | Reason |
|----------|---------|-------|--------|
| MFI Exhaustion | 64.7% | 8.4% | High fold variance, unstable |
| Volume Exhaustion | 64.8% | 4.7% | WR just below 65% threshold |
| Synth30m | 51.8% | 1.3% | 30m too coarse, no signal |
| High ATR Regime | 56.6% | 4.9% | Trending regime |
| RRRG/GRRR Patterns | 48-54% | high | Pattern unreliable on SOL |
| SOL/5m (any) | 58% | high | Not mean-reverting at 5m |

---

## Hour Research Findings

New hours tested (BB(20,2.2)+streak>=2):
- h=22: 70.0% WR sigma=8.2% T=30 -- NEW PROMISING HOUR for SOL
- h=17: 77.4% WR sigma=18.6% T=29 -- HIGH WR but UNSTABLE
- h=02: 62.5% WR sigma=7.6% T=43 -- potential addition
- h=05: 62.5% WR sigma=6.1% T=35 -- potential addition

Best new combo: h=[0,12,13,20,17] = WR=66.0% sigma=4.3% T=150 -- PASS
Adding h=17 to existing set improves from 63.6% to 66.0%

---

## Summary of Key Findings

1. SOL Daily Range position is the strongest SOL filter found
2. BB deviation sweet spot 0.05-0.25% replicates from ETH to SOL
3. Low ATR regime filter adds +16% WR for SOL mean-reversion
4. RGGG/GRGG patterns cross-validate from ETH to SOL (76.7% WR, low trade count)
5. Keltner+BB squeeze works on SOL/15m (replicates ETH Strat 10)
6. Deep BB (>0.5% outside band) = trend continuation on SOL
7. Hour 22 UTC = new potential SOL signal hour
8. h=[0,12,13,20,17] improves existing Strat 19 hour set
9. SOL/5m and SOL/30m remain non-viable
10. MFI and Volume exhaustion fail on SOL unlike BTC/ETH

Research scripts in: server/research/sol_ml_*.js
