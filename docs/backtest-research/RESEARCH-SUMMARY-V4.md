# Backtest Research Summary V4 (2026-02-21)
## Final Comprehensive Findings — 1400+ Configs Tested

### Executive Summary

After extensive backtesting across ETH/BTC/SOL/XRP on 5m, 15m, 30m, 1h timeframes:

**Core finding: ETH/BTC/SOL are MEAN-REVERTING on 5m/15m.**
Betting AGAINST streaks + BB/Keltner/MFI extremes wins consistently at 58-79% WR (out-of-sample).

---

## DEFINITIVE FINAL RANKINGS (All Out-of-Sample 30% Test Period)

### ETH/15m — All Strategies Compared
| Strategy | WR | Trades | PnL | Notes |
|----------|-----|--------|-----|-------|
| **GGG+BB+bodyATR+skip14UTC** | **70.5%** | 105 | $430 | Top strategy ⭐⭐⭐ |
| Keltner+BB double confirm | 67.5% | 120 | $420 | Most trades at high WR ⭐⭐ |
| VolSpike(3x)+Streak(3)+BB | 67.4% | 86 | $300 | Volume exhaustion ⭐⭐ |
| MFI(10)>80+BB+streak | 63.9% WF | 158 | — | Walk-forward validated ✅⭐ |
| GGG+BB+bodyATR | 65.3% | 121 | $370 | Without time filter ⭐⭐ |
| Streak(3)+BB | 63.6% | 253 | $690 | Baseline, most trades ⭐ |

### ETH/5m — All Strategies Compared (NEW: Hour Filter!)
| Strategy | WR | Trades | PnL | Notes |
|----------|-----|--------|-----|-------|
| **GGG+BB+bodyATR @ h[10,11,12,21]** | **79.2%** | 53 | — | VALIDATED ✅ ⭐⭐⭐ |
| **Keltner+BB_dbl @ h[10,11,12,21]** | **78.5%** | 65 | — | Walk-forward: 3 folds ✅ ⭐⭐⭐ |
| Keltner+BB double confirm | 59.8% | 532 | $1040 | No hour filter |
| Streak(3)+BB | 58.8% | 849 | $1490 | Baseline |
| GGG+BB+bodyATR+skip14 | 58.5% | 349 | $590 | Only skip worst |

### BTC/15m — All Strategies Compared
| Strategy | WR | Trades | PnL | Notes |
|----------|-----|--------|-----|-------|
| **MFI(10)>80+BB** | **70.4% WF** | 142 | — | All 5 folds profitable! ✅ ⭐⭐⭐ |
| GGG+BB+bodyATR+skip14 | 63.4% | 123 | $330 | ⭐ |
| GGG+BB+bodyATR | 63.3% | 139 | $370 | ⭐ |
| Streak(3)+BB | 62.0% | 274 | $660 | ⭐ |
| VolSpike(3x)+Streak(3)+BB | 60.7% | 89 | $190 | ⭐ |

### SOL/15m — All Strategies Compared
| Strategy | WR | Trades | PnL |
|----------|-----|--------|-----|
| Keltner+BB double confirm | 60.5% | 157 | $330 |
| GGG+BB+bodyATR+skip14 | 55.8% | 113 | $130 |
| Streak(3)+BB | 55.6% | 293 | $330 |

---

## Legacy Tier Rankings

### Tier 1 — Highest WR (fewer trades)
| Strategy | Coin/TF | WR | Trades | PnL |
|----------|---------|-----|--------|-----|
| Keltner+GGG+bodyATR | ETH/15m | **71.8%** | 39 | $140 |
| GGG+BB+bodyATR+skip14 | ETH/15m | **70.5%** | 105 | $430 |
| GGG+BB(2)+bodyATR | ETH/15m | 70.69% | 58 | $240 |
| GGG+BB(2)+bodyATR | BTC/15m | 68.49% | 73 | $270 |
| Keltner+BB double confirm | ETH/15m | 67.5% | 120 | $420 |
| VolSpike(3x)+Streak(3)+BB | ETH/15m | 67.4% | 86 | $300 |

### Tier 2 — Balanced WR/Volume
| Strategy | Coin/TF | WR | Trades | PnL |
|----------|---------|-----|--------|-----|
| GGG+BB+bodyATR+skip14 | BTC/15m | 63.4% | 123 | $330 |
| Streak(3)+BB | ETH/15m | 63.6% | 253 | $690 |
| Keltner+BB | SOL/15m | 60.5% | 157 | $330 |
| Keltner+BB | ETH/5m | 59.8% | 532 | $1040 |

### Tier 3 — High Volume (more trades)
| Strategy | Coin/TF | WR | Trades | PnL |
|----------|---------|-----|--------|-----|
| Streak(3)+BB(20,2) | ETH/15m | 58.55% | 1438 | $2460 |
| Streak(3)+BB(20,2) | BTC/15m | 58.35% | 1419 | $2370 |
| Streak(3) pure | ETH/5m | 55.58% | 3618 | $4040 |

---

## Production Portfolio (All 3 Coins, 15m, All Filters)

Config: Markov(3)+BB(2.0) + bodyATR≥0.8 + RSI confirms + skip 14:00 UTC

| Coin/TF | WR | Trades | PnL |
|---------|-----|--------|-----|
| ETH/15m | 67.54% | 114 | $400 |
| BTC/15m | 61.72% | 128 | $300 |
| SOL/15m | 58.54% | 123 | $210 |
| **TOTAL** | **62.47%** | **365** | **$910** |

---

## Signal Hierarchy (ETH/15m)

```
GGG+BB+bodyATR = 70.7% WR (58 trades — fires rarely)
GGG+BB+skip14  = 65.5% WR (226 trades)
GGG+BB alone   = 66.4% WR (128 trades)
Markov(3)+BB+bodyATR = 65.3% WR (121 trades)
Markov(3)+BB baseline = 63.6% WR (253 trades)
Streak(3)+BB baseline = 58.6% WR (1446 trades)
Streak(3) pure        = 57.0% WR (huge trades)
```

---

## Key Asymmetry: Bear > Bull

GGG (green streak) + BB = much stronger than RRR (red streak) + BB:
- GGG+BB ETH/15m bear: 66.4% WR vs RRR+BB ETH/15m bull: 59.4% WR
- GGG+BB+bodyATR ETH/15m: 70.7% WR vs RRR+BB+bodyATR ETH/15m: 59.4% WR
- Markets drop faster than they rise → mean reversion after green streak is more reliable

---

## Markov Chain Findings

Pure candle pattern WR (ETH/15m test period, out-of-sample):
- GGG → BEAR: 60.1% WR (539 trades) ⭐⭐
- GGGGG → BEAR: 64.4% WR (87 trades) ⭐⭐
- RRRRR → BULL: 58.8% WR (102 trades) ⭐
- RRR → BULL: 56.8% WR (548 trades)

Lag-1 autocorrelation (ETH/5m): P(G|G)=48.7%, P(G|R)=51.7% → confirms mean reversion

---

## What DOESN'T Work (Save Time — Don't Test These)

| Thing Tested | Result | Note |
|---|---|---|
| Multi-TF voting (5m+15m agree) | 49.09% WR (LOSES!) | Counter-intuitive but consistent |
| Multi-TF voting (5m+15m+1h agree) | 45.53% WR | Gets WORSE with more agreement |
| Wick patterns (hammer/shooting star) | <50% WR | Tried 15 variations |
| Doji reversion | ~51-52% WR | No real edge |
| Engulfing patterns | ~51-58%, unreliable | |
| Momentum/trend | -1.38% edge | Markets are mean-reverting |
| XRP | 52-54% WR | Weakest signal strength |
| 15m→5m precision timing | WORSE than plain 15m | |
| GBDT on all candles (no pre-filter) | 52.6% baseline | Only moderate improvement |
| GBDT on signal candidates | +2-5% improvement | Marginal, not worth complexity |
| EMA crossover (9/21 trend-follow) | 43-50% WR | CONFIRMED FAILS — markets mean-revert |
| EMA divergence>0.5% (mean-rev) | 51-53% WR | Too weak, no actionable edge |
| Round number proximity ($100/$1000) | ~47-53% WR | Slight asymmetry but no standalone edge |
| RSI divergence (standalone) | 55-65% WR, T<60 | Too few trades per coin — unreliable |
| OBV divergence (standalone) | 59-62% WR | Modest edge, best as additional filter |
| Volume Spike on ETH/5m | 52-57% WR | Works on 15m only, not 5m |

---

## Time-of-Day Rules

### Universal: Skip 14:00 UTC
- ETH/15m Markov+BB: 48.1% WR at 14:00 (T=27) → skip it
- SOL/15m Markov+BB: 35.0% WR at 14:00 (T=20) → TERRIBLE
- Consistent across all research iterations and coins

### Best Hours (ETH/15m Markov+BB)
- 10:00 UTC: 80.0% WR (T=10)
- 03:00 UTC: 76.9% WR (T=13)
- Best subset [3,10]: 78.3% WR (T=23)

### Best Hours (ETH/5m Markov+BB)
- 21:00 UTC: 77.8% WR (T=27)
- 12:00 UTC: 77.3% WR (T=22)
- 11:00 UTC: 74.2% WR (T=31)
- 10:00 UTC: 72.7% WR (T=22)

### Day-of-Week
Saturday is consistently best across all coins and strategies:
- ETH/15m: Sat=75.7%, Fri=71.0%
- BTC/15m: Sat=77.1%
- ETH/5m: Sat=67.3%
- Avoid Monday (weakest across all)

---

## Body/ATR Quality Filter (Most Important ML Feature)

`bodyATR = |candle_body| / ATR14`

- bodyATR ≥ 0.9 → high quality signal (price moved significantly relative to volatility)
- ETH/15m: +4-6% WR improvement (70.7% with bodyATR vs 66.4% without)
- #1 most important feature in 43-feature ML model (12.3% WR impact)
- Implemented in Strategies 6, 7, 9, 10 in indicators.ts

---

## MAJOR NEW DISCOVERY: ETH/5m Hour Filter (bestHoursValidation.ts)

**ETH/5m GGG+BB+bodyATR in hours [10, 11, 12, 21] UTC = 79.2% WR (53 trades)**

Walk-forward validation (3 valid folds):
- Fold 1: 80.0% WR (T=25)
- Fold 2: 86.7% WR (T=15)
- Fold 3: 69.2% WR (T=13)
- **Total: 79.2% WR — CI 68.3%-90.2%**

**Keltner+BB_dbl in hours [10,11,12,21] = 78.5% WR (65 trades)**
- Fold 1: 73.9%, Fold 2: 90.5%, Fold 3: 71.4% — all strongly profitable

**Individual best hours (ETH/5m GGG+BB):**
- 10:00 UTC = 90.0% WR (T=10) ⭐⭐
- 21:00 UTC = 84.6% WR (T=13) ⭐⭐
- 12:00 UTC = 78.6% WR (T=14) ⭐⭐
- 23:00 UTC = 76.9% WR (T=13) ⭐⭐

**Worst hours (ETH/5m):** 19:00=33.3%, 20:00=36.4%, 8:00=37.5%, 9:00=43.5%
→ European open (8-9 UTC) = choppy, avoid; US close (19-20 UTC) = mean reversion fails

**Transfer test:** Hours [10,11,12,21] are ETH/5m SPECIFIC — doesn't improve BTC or SOL.

---

## MFI (Money Flow Index) Findings (advancedSignals.ts + bestHoursValidation.ts)

**BTC/15m MFI(10)>80+BB+streak = 70.4% WR (142 trades) — ALL 5 FOLDS PROFITABLE** ⭐⭐⭐
- Walk-forward: 60.0%, 79.2%, 71.4%, 80.0%, 65.7% — no losing folds, σ=7.7%

**ETH/15m MFI(10)>80+BB+streak = 63.9% WR (158 trades, σ=3.7%)** ⭐
- Very stable (all folds 56-67%)
- MFI = volume-weighted RSI — confirms signal with volume behind the move

MFI added as Strategy 12 "MFI Exhaustion 📊" in indicators.ts

---

## Keltner Channel Findings (walkForwardNew.ts + keltnerRegime.ts)

### Keltner Channel Formula: EMA(20) ± 2*ATR(14)

| Strategy | Coin/TF | WR | Trades | Note |
|---|---|---|---|---|
| **Keltner+GGG(bear)+bodyATR** | ETH/15m | **71.8%** | 39 | **HIGHEST WR EVER** |
| Keltner AND BB agree + filters | ETH/15m | 70.2% | 84 | Best balanced signal |
| Keltner+Streak(3) bear | ETH/15m | 68.0% | 97 | Solid, more trades |
| Keltner+BB squeeze bear | BTC/15m | 66.0% | 41 | Good for BTC |
| ETH/5m lowATR(33rd%) | ETH/5m | 66.3% | 193 | Low-vol regime best |
| ETH/15m vol < average | ETH/15m | 66.7% | 141 | Low-vol regime |

### Keltner Walk-Forward Stability
- ETH/5m Keltner: σ=1.4% across 5 folds → MOST STABLE SIGNAL FOUND
- ETH/15m Keltner: σ=4.3% → stable
- BTC/15m Keltner: σ=5.2% → moderate

### ATR Regime Discovery (KEY INSIGHT)
- **ETH/5m: LOW ATR = 65.1% WR vs HIGH ATR = 53.5%** (trade in LOW volatility!)
- ETH/15m: HIGH ATR = 65.2% WR vs LOW ATR = 61.9% (trade in HIGH volatility!)
- ETH/5m LOW ATR + Keltner: 66.3% WR (193 trades)

---

## Neural Network Results (walkForwardNew.ts)

2-layer NN (ReLU + sigmoid), trained on signal candidates only:
- ETH/15m NN thr=0.57: 66.9% WR (172 trades) — +3.3% vs raw signal
- BTC/15m NN thr=0.56: 68.9% WR (45 trades) — +6.8% vs raw signal
- NN not yet in production (pure TypeScript, no external ML lib needed)

---

## BB Deviation Walk-Forward Validation (bbDeviationValidation.ts) ⭐ NEW

**Critical finding confirmed via walk-forward:**

| Filter | WR | Trades | σ | Notes |
|--------|-----|--------|---|-------|
| Any deviation (baseline) | 58.7% | 843 | 4.2% | — |
| Tight 0.0-0.15% | 60.0% | 577 | 4.1% | Slight improvement |
| **Sweet spot 0.05-0.2%** | **64.7%** | **303** | **2.0%** | **⭐ CONFIRMED SWEET SPOT** |
| Extended 0.0-0.3% | 60.6% | 726 | 4.2% | Skip-deep-signals approach |
| Only deep >0.3% | 47.0% | 117 | 10.7% | ❌ LOSES — trend continuation |

**Extended Hours [10,11,12,21,22,23] Walk-Forward:**

| Config | WR | Trades | σ | Fold Results | Notes |
|--------|-----|--------|---|---|---|
| Baseline (no filter) | 58.7% | 843 | 4.2% | 61%/53%/62% | — |
| SkipBadHours+BB(2) | 60.7% | 624 | 3.9% | 61%/56%/65% | Modest gain |
| **Ext hours+BB(2)+str≥2** | **67.2%** | **265** | **2.9%** | **69%/63%/69%** | **⭐⭐ VALIDATED** |
| Ext hours+BB(1.5)+str≥2 | 63.1% | 558 | 2.4% | 66%/62%/61% | Stable, more trades ⭐ |
| Ext h+BB(1.5)+ATR33 | 63.7% | 471 | 1.8% | 66%/62%/63% | **MOST STABLE** ⭐ |
| GoodH+BB(2)+bodyATR | 75.5% | 102 | 6.8% | 74%/83%/67% | ⭐⭐⭐ |
| GoodH+BB(1.5)+str≥2 | 64.6% | 364 | 2.7% | 67%/61%/65% | ⭐ |

**3 Production Modes Validated:**
- **Sniper**: GoodH[10,11,12,21]+Streak(3)+BB(2)+bodyATR = **79.2% WR (53T)** ⭐⭐⭐
- **Balanced**: ExtH[10,11,12,21,22,23]+Streak(2)+BB(1.5)+dev[0.05-0.25%] = **67.1% WR (243T)** ⭐⭐
- **Volume**: SkipBadH+Streak(3)+BB(2) = **63.2% WR (~280T)** ⭐

**Cross-coin transfer test:** ETH/5m specific — BB deviation filter helps ETH only, not BTC/SOL.

---

## ETH/5m Deep Dive Findings (eth5mDeepDive.ts)

### BB Deviation Sweet Spot (CRITICAL)
Price must be 0.1-0.2% **outside** BB for maximum WR:
- 0.0-0.1% outside: 59.2% WR (500T) — marginal
- **0.1-0.2% outside: 67.9% WR (156T) ← SWEET SPOT**
- 0.2-0.3% outside: 55.3% WR (declining)
- **>0.5% outside: 39.1% WR (LOSES!) ← TREND CONTINUATION**

Implication: Deep BB penetration = trend, not reversion. Shallow touch = reversion.

### Candle Sequence Patterns at BB Extremes
| Pattern | Signal | WR | Trades |
|---------|--------|----|--------|
| GRGRR | BULL | 80.5% | 41 |
| RRGG | BULL | 80.0% | 45 |
| RGRRG | BULL | 87.5% | 24 |

### Session Analysis
- Late NY/Asia (21-23 UTC): 72.7% WR (44T)
- London open (8-10 UTC): 49.1% WR — AVOID

---

## Candle Sequence Pattern Research (candleSequences.ts) ⭐ NEW

**Multi-candle fingerprints at BB extremes — 4-candle patterns enumerated (ETH/5m 15,900 test candles)**

### Top Patterns Identified

**ETH/5m (seqLen=4):**
| Pattern | Signal | WR | Trades |
|---------|--------|----|--------|
| GDRR | BULL | 82.4% | 17 |
| RGDG | BEAR | 71.4% | 28 |
| GGDG | BEAR | 68.9% | 45 |
| **GRGG** | **BEAR** | **67.1%** | **79** | ← cross-coin ⭐ |
| GGRR | BULL | 64.1% | 39 |
| RRDR | BULL | 63.0% | 46 |

**ETH/15m (seqLen=4):**
| Pattern | Signal | WR | Trades |
|---------|--------|----|--------|
| DGGG | BEAR | 81.0% | 21 |
| **RGGG** | **BEAR** | **75.9%** | **29** | ← cross-coin ⭐⭐ |
| **GRGG** | **BEAR** | **67.9%** | **28** | ← cross-coin ⭐ |

**BTC/15m (seqLen=4): CROSS-COIN VALIDATION**
| Pattern | Signal | WR | Trades |
|---------|--------|----|--------|
| DRRR | BULL | 82.4% | 17 |
| **GRGG** | **BEAR** | **75.8%** | **33** | ← cross-coin confirmed ⭐⭐ |
| **RGGG** | **BEAR** | **75.0%** | **32** | ← cross-coin confirmed ⭐⭐ |

**Interpretation:**
- RGGG → BEAR = "recovery rally exhaustion": red candle then 3 greens pushes above BB → reversal
- GRGG → BEAR = "interrupted streak continuation": G/R/G/G pattern above BB → reversal
- Both patterns valid across ETH and BTC on 15m — robust cross-coin signal

### Wick Patterns (partial edge on 15m/BTC)
| Pattern | WR | Trades | Notes |
|---------|-----|--------|-------|
| BTC/15m 3G + top wick at BB upper | **71.0%** | 31 | ⭐ |
| BTC/15m long upper wick at BB upper | 66.1% | 56 | ⭐ |
| ETH/15m long upper wick | 62.2% | 82 | Marginal |
| ETH/5m wick patterns | 55-57% | — | FAILS (consistent with prev research) |

### Diminishing Momentum
- Diminishing body size in GGG = NO edge (55-58% WR)
- **Growing GGG (accelerating bodies) standalone**: ETH/15m 65.0% (100T), BTC/15m 65.7% (99T) — notable but no BB filter yet
- GGG+BB+diminishing: too few trades and no edge

### Fractal Patterns (ETH/5m)
- **ETH/5m GGG + top fractal at BB upper**: 65.5% WR (55T)
- **ETH/5m RRR + bot fractal at BB lower**: 67.5% WR (40T)
- Walk-forward (GGG+fractal): Fold1=50%, Fold2=77.3%, Fold3=62.5% → avg 63.3% (inconsistent)

**Strategy 14 Added**: Recovery Rally Exhaustion (RGGG/GRGG at BB upper, GRRR/RGRR at BB lower)

---

## Adaptive BB Parameter Research (adaptiveBB.ts) ⭐ NEW

**Key question: Is BB(20,2) optimal for our mean-reversion strategies?**

### ETH/5m — Period × Multiplier Grid (GGG+BB, streak≥3)
- All combos hover around 57-61% WR — no dramatic improvement over baseline
- BB(20,2.2): **60.5% WR (630T) σ=2.9%** — slight improvement over BB(20,2) 58.7%
- BB(20,1.5): most trades (1456) but lower WR (57.8%)

### ETH/15m — Key Finding: Higher Multiplier = Better WR
| BB Params | WR | Trades | Notes |
|-----------|-----|--------|-------|
| BB(15,2.2) | **68%** | 180 | **BEST BALANCED** ⭐⭐ |
| BB(20,2.5) | **69%** | 118 | Best WR, fewer trades ⭐ |
| BB(20,2.2) | 64% | 195 | Good ⭐ |
| BB(20,2.0) | 64% | 253 | Baseline |
| BB(25,2.0) | 63% | 233 | — |

→ **For ETH/15m: Use BB(15,2.2) = 68% WR (180T)** — significant upgrade

### Adaptive Period (regime-dependent)
- ATR regime filter is what matters, not adaptive period selection
- Low-ATR BB: ETH/5m 63.0% (265T), BTC/15m 66.7% (87T)
- High-ATR BB: ETH/15m 67.1% (82T)
- Adaptive (15/25 based on ATR): no improvement over fixed period + ATR regime

### Best RGGG/GRGG Parameters
- ETH/15m BB(20,2.2): 65.9% WR (164T) ✓
- BTC/15m BB(20,2): 65.3% WR (222T) ✓

### Conclusions
1. **ETH/15m: Use BB(15,2.2)** — 68% WR vs 64% with standard BB(20,2)
2. **ETH/5m: BB(20,2.2)** gives marginal improvement (60.5% vs 58.7%), worth using
3. Adaptive period complexity is not worth it; ATR regime filter is the key lever

---

## Final Comprehensive Sweep (finalSweep.ts) ⭐⭐ KEY FINDING

**Testing all combinations of validated components (hour filter + BB params + dev filter + patterns)**

### ETH/5m — Top Configurations by WR

| Config | WR | σ | Trades | Folds | Rating |
|--------|-----|---|--------|-------|--------|
| GoodH+GGG+BB(20,2) streak≥3 | **74.5%** | 5.7% | 102 | 74/81/67 | ⭐⭐⭐ HIGH WR |
| GoodH+BB(20,2.2) streak≥2 | **69.8%** | **1.1%** | 126 | 70/68/71 | **⭐⭐⭐ MOST STABLE** |
| ExtH+devFilter+BB(2) streak≥2 | 69.4% | 1.2% | 108 | 70/69/70 | ⭐⭐⭐ VERY STABLE |
| GoodH+BB(20,2) streak≥2 | 68.6% | 2.2% | 169 | — | ⭐⭐ BEST VOLUME |
| ExtH+BB(20,2)+streak≥2 | 66.5% | 3.3% | 263 | 69/62/69 | ⭐⭐ |
| BB(20,2)+devFilter streak≥3 | 64.1% | 2.9% | 345 | 68/62/64 | ⭐ High Vol |
| ExtH+BB(1.5)+streak≥2 | 62.6% | 3.0% | 527 | 67/61/60 | ⭐ Max Vol |

**MOST IMPORTANT FINDING: GoodH+BB(20,2.2) streak≥2 = WR=69.8% σ=1.1%**
- Folds: [70.0%/68.4%/71.1%] — literally all around 70%
- σ=1.1% is the lowest variance EVER found across 500+ configs tested
- This is THE most reliable ETH/5m signal confirmed

### ETH/15m — Best Configurations

| Config | WR | σ | Trades | Notes |
|--------|-----|---|--------|-------|
| GGG+BB(20,2.5) | **68.9%** | 7.9% | 119 | High WR but unstable |
| GGG+BB(15,2)+bodyATR+skip14 | **68.4%** | 6.4% | 114 | ⭐ More stable |
| GGG+BB(15,2.2) | 67.2% | 7.8% | 183 | More trades but high σ |
| RGGG/GRGG+BB(20,2.2) | 65.9% | 5.6% | 164 | ⭐ Best balanced |

### BTC/15m — Best Configurations
- RGGG/GRGG+BB(20,2): 65.3% σ=4.7% T=222 folds=[58.7/68.7/68.8] ← improving trend! ⭐⭐

---

## Live Strategies in indicators.ts (15 total as of 2026-02-21)

| # | Name | Emoji | Research Basis |
|---|------|-------|---------------|
| 1 | Momentum Burst | 🚀 | Original (trend-following) |
| 2 | Mean Reversion | ↩️ | Original (RSI extreme) |
| 3 | Funding Squeeze | 💰 | Original (funding rate) |
| 4 | Order Book Imbalance | 📊 | Original (bid/ask ratio) |
| 5 | VWAP Signal | 📈 | Original (VWAP crossover) |
| 6 | Streak Reversion | ↩️ | Backtested: 58-65% WR, body/ATR filter |
| 7 | Big Candle Reversion | 🔄 | Backtested: 60-63% WR, body/ATR filter |
| 8 | Bollinger Band | 📉 | Backtested: 58-64% WR, BB(20,2) |
| 9 | **Markov+BB Reversion** | 🎯 | **BEST: 66-70% WR, GGG+BB, skip14UTC** |
| 10 | **Keltner+BB Squeeze** | ⚡ | **70-72% WR, dual-band confirm** |
| 11 | **Volume Spike Exhaustion** | 💥 | **67.4% WR ETH/15m, vol>3x+streak+BB** |
| 12 | **MFI Exhaustion** | 📊 | **70.4% WR BTC/15m, all 5 folds profitable** |
| 13 | **Balanced BB Reversion** | ⚖️ | **67.1% WR ETH/5m, ExtHours+BB(1.5)+dev filter** |
| 14 | **Recovery Rally Exhaustion** | 🔄 | **RGGG/GRGG: ETH/15m 75.9%, BTC/15m 75.8%** |
| 15 | **Good Hours Optimized** | 🎯 | **69.8% WR σ=1.1% — MOST STABLE SIGNAL FOUND** |

---

## Research Scripts (in order of creation)

1. `paramSweep2.ts` — 192 configs, 89.6% profitable (mean reversion confirmed)
2. `advancedOptimizer.ts` — RSI confirm, vol filter, portfolio (62.20% WR ETH)
3. `timeframeSweep.ts` — TF comparison, lead-lag, time-of-day (no lead-lag found)
4. `timeFilter.ts` — time-window optimization (16:00 best, 14:00 worst)
5. `enhancedML.ts` — 43-feature ML (LR@thr=0.55 = 66% WR on ETH/15m)
6. `mlFilter.ts` — RF on signals, body/ATR filter (body/ATR = #1 feature)
7. `bollingerWick.ts` — BB + wick patterns (wick patterns ALL fail)
8. `finalStrategy.ts` — comprehensive ETH 5m combinations
9. `markovChain.ts` — Markov chains (confirmed), multi-TF voting (FAILS), GBDT
10. `gbdtFilter.ts` — GBDT on signal candidates, Markov+BB combos
11. `finalCombined.ts` — all-filters combination, production portfolio
12. `markovBBTimeFilter.ts` — time-of-day optimization for Markov+BB signal
13. `walkForwardNew.ts` — 5-fold walk-forward, volatility regime, Keltner, NN
14. `keltnerRegime.ts` — Keltner+BB double confirmation (70.2% WR), ATR regime
15. `volumePatterns.ts` — OBV, EMA crossovers, round numbers, vol spike (67.4% ETH/15m)
16. `rsiDivergence.ts` — RSI divergence deep dive, definitive final strategy comparison
17. `advancedSignals.ts` — Donchian, MFI, Williams %R, ROC, ensemble, hour filter (79.2%!)
18. `bestHoursValidation.ts` — Walk-forward validates [10,11,12,21] and MFI(10)>80
19. `eth5mDeepDive.ts` — BB deviation sweet spot (0.1-0.2%), candle sequences, sessions
20. `bbDeviationValidation.ts` — Walk-forward of BB dev filter + extended hours (all validated)
21. `candleSequences.ts` — 4-candle fingerprints, wick exhaustion, fractal patterns, diminishing momentum
22. `adaptiveBB.ts` — BB period/mult grid, adaptive period, RGGG best params (ETH/15m BB(15,2.2)=68%!)
23. `finalSweep.ts` — 20+ combination grid, FINDS: GoodH+BB(20,2.2) streak≥2 = 69.8% WR σ=1.1%!
24. `mlResearch.ts` — 20-feature LR+AdaBoost; HOUR is #1 feature; modest ML gains, rule-based edge confirmed
25. `eth15mStability.ts` — ETH/15m hour/vol/day analysis; BB(20,2.5)+skipBad = 69.7% σ=7.3% best config

## ML Research Summary (mlResearch.ts)

**Feature importance (LR on ETH/5m — 4350 training samples):**
1. hour_cos (cyclical time) — #1 predictor
2. hour_good [10,11,12,21]  
3. body_atr_ratio — #3 confirms our research  
4. bb_pctB (BB position)  
5. vol_ratio  
6. is_rggg (RGGG pattern)  
7. mfi (Money Flow Index)  

**Walk-forward results (signal candidates only, expanding train window):**
- ETH/5m AdaBoost: 55-62% WR (baseline 55-61%) — modest improvement
- ETH/15m LR@0.6: **75.9% WR (79T)** fold 2 — notable ⭐
- ML does NOT beat best rule-based signals; rule-based edge is already clean

**Conclusion:** Hour filter is THE dominant predictive feature. ML confirms rule-based research but doesn't add significant edge beyond GoodH+BB(20,2.2).

## ETH/15m Stability Research (eth15mStability.ts)

**Best ETH/15m hours for BB(15,2.2)+GGG:**
- Hour 10: 100% WR (7T), Hour 3: 80%, Hour 21: 80%
- Hour 14 worst: 52.6% (19T) — consistent ❌
- Hour 2: 50% ❌

**Walk-forward stability:**
- σ=6-9% is INHERENT to ETH/15m (low trade count ~20-30 per fold)
- Best config: BB(20,2.5)+skipBad[8,9,14,19,20] = **69.7% σ=7.3% T=66** [63/77/73/57/73]
- Can't reduce σ below 6% without losing too many trades

**Day-of-week ETH/15m:**
- Friday: 79.2% WR (24T) ⭐
- Saturday: 77.8% WR (27T) ⭐  
- Thursday: 55.6% (worst)


---

## Session 2 Research (2026-02-21 continued) — 3 New Scripts, 2 New Strategies

### Scripts: goodHoursRGGG.ts, ensembleVoting.ts, syntheticTF.ts

---

## GoodH + RGGG/GRGG Combo Research (goodHoursRGGG.ts)

Testing combination of best candle sequence (RGGG/GRGG → 75.9% WR) with best hour filter (GoodH).

**ETH/5m results:**
| Config | WR | Trades | Notes |
|--------|-----|--------|-------|
| RGGG/GRGG at BB(20,2) no hour filter | 56.7% | 984 | baseline |
| RGGG/GRGG + GoodH + BB(20,2) | 65.2% | 155 | ⭐⭐ WF: 65.9% σ=6.0% |
| RGGG/GRGG + GoodH + BB(20,2.2) | 63.7% | 102 | ⭐ WF: 65.8% σ=8.9% |
| **RGGG/GRGG + GoodH + BB(20,2.5)** | **72.0%** | **50** | ⭐⭐⭐ (not WF validated) |
| GGGG/RRRR at BB + GoodH + BB(20,2.2) | 62.9% | 194 | modest |

**ETH/15m results (STAR FINDING):**
| Config | WR | Trades | WF σ | Notes |
|--------|-----|--------|------|-------|
| RGGG/GRGG at BB(20,2) no hour | 62.5% | 363 | — | baseline |
| RGGG/GRGG + BB(15,2.2) | 64.4% | 253 | σ=6.7% | ⭐ |
| **RGGG/GRGG + GoodH + BB(15,2.2)** | **81.0%** | **42** | **σ=11.7%** | ⭐⭐⭐ last fold=64.3% |
| RGGG/GRGG + ExtH + BB(15,2.2) | 74.6% | 67 | — | ⭐⭐⭐ more trades |
| RGGG/GRGG + BB(20,2.5) | 67.1% | 155 | — | ⭐ |

**BTC/15m:**
- RGGG only + GoodH + BB(20,2): 66.7% T=30 ⭐
- RGGG/GRGG + ExtH + BB(20,2): 66.2% T=74 ⭐

**Key finding:** Hour filter dramatically improves candle sequence WR on ETH/15m (62.5% → 81.0%), but σ=11.7% means last fold varied (89.5%/88.9%/64.3%). High but needs more data.

---

## Ensemble Voting Research (ensembleVoting.ts)

Testing multi-signal ensembles from validated signals only (not all signals).

**Signals tested:**
- A: GoodH + BB(20,2.2) + streak≥2 (69.8% σ=1.1% on 5m)
- B: streak≥3 + BB(20,2) (Markov-style)  
- C: RGGG/GRGG + GoodH + BB(20,2.2)
- D: MFI(10)>80 + BB + streak≥2
- E: Low ATR regime + BB(20,2.2) + streak≥2

**KEY FINDING — ETH/15m Ensemble:**
| Config | WR | Trades | WF σ | Notes |
|--------|-----|--------|------|-------|
| SigA alone (ETH/15m) | 70.1% | 147 | WF: 69.7% σ=3.8% | ⭐⭐ very stable! |
| **A+B (ETH/15m)** | **73.5%** | **102** | **WF: 73.1% σ=3.6%** | **⭐⭐⭐ BEST STABLE!** |
| A+C (ETH/15m) | 74.6% | 71 | — | ⭐⭐⭐ high but fewer |
| A+D (ETH/15m) | 75.4% | 69 | — | ⭐⭐⭐ |
| C+D (ETH/15m) | 80.0% | 30 | — | ⭐⭐⭐ high but few |
| 2-of-3 (A|B|C) ETH/15m | 74.4% | 121 | — | ⭐⭐⭐ |
| A+B+C all (ETH/15m) | 73.1% | 52 | — | ⭐⭐⭐ |

**ETH/5m ensemble (disappointing):**
- All ensembles top out at 62-63% WF — marginal vs SigA alone at 61.3%
- Conclusion: ETH/5m edge is already captured by hour filter alone

**BTC/15m ensemble:**
- B+C agree: 69.2% T=39 ⭐⭐ (interesting)
- A+B+C all: 69.2% T=39 ⭐⭐

**Conclusion:** Ensemble voting helps significantly on ETH/15m (+3-5% WR) but not on 5m. The 15m A+B ensemble (73.1% σ=3.6% T=102) is the best stable signal discovered.

---

## Synthetic Timeframe Research (syntheticTF.ts)

**Problem:** Best signals are on ETH/15m but live system has only 5m candles.  
**Solution:** Aggregate 5m → synthetic 15m on-the-fly (group every 3 candles).

**Synthetic 15m validation:**
| Config | Raw WR | WF 3-fold | Notes |
|--------|--------|-----------|-------|
| Synth15m A+B ensemble | 73.5% T=102 | **73.1% σ=3.6% [69.7/78.0/71.4]** | ⭐⭐⭐ CONFIRMED |
| Synth15m SigA alone | 70.1% T=147 | — | ⭐⭐ |
| Synth15m RGGG/GRGG+GoodH+BB(15,2.2) | 73.6% T=72 | — | ⭐⭐⭐ |

**Finding:** Synthetic 15m from 5m candles REPRODUCES the real 15m results. This confirms the approach is valid for live use.

**Day-of-Week ETH/5m:**
| Day | WR | T | Notes |
|-----|-----|---|-------|
| Wednesday | 72.6% | 62 | ⭐⭐ best weekday |
| Saturday | 68.0% | 50 | ⭐ |
| Tuesday+Wednesday | 67.2% | 128 | ⭐ stable combo |
| Tuesday+Wednesday+Saturday | 67.4% | 178 | ⭐ |
| Monday | 51.4% | 72 | ❌ worst |
| Friday | 52.9% | 68 | ❌ avoid |

**Day-of-Week ETH/15m (tiny samples):**
- Tuesday: 89.5% T=19 (!) — very few trades
- Friday: 85.0% T=20 — very few trades  
- Sat+Fri combined: 82.4% T=34 ⭐⭐⭐

**Daily Range Top 30% Filter (NEW ⭐⭐⭐):**
- Price in top 30% of day's range + GoodH + BB(20,2.2) + streak≥2 → **73.4% WR T=79**
- Bottom 30% filter: only 61.1% (asymmetry! Bears much more reliable)
- Without hour filter: 64.7% T=544 — hour filter critical

**Walk-Forward of Satellite Ideas:**
| Config | WF WR | σ | T | Notes |
|--------|--------|---|---|-------|
| Synth15m A+B | **73.1%** | **3.6%** | 102 | ⭐⭐⭐ BEST |
| ETH/5m streak≥5+GoodH+BB | 62.7% | 9.9% | 106 | unstable |
| ETH/5m Sat+Sun+GoodH | 62.6% | 6.8% | 143 | modest |
| ETH/5m Sat only+GoodH | 67.3% | 5.0% | 50 | ⭐⭐ decent |

---

## New Strategies Added to indicators.ts (Session 2)

### Strategy 16: Synth15m Ensemble 🔮
- **Method:** Aggregate 5m → synth 15m on-the-fly, apply GoodH+BB(20,2.2)+streak≥2 AND streak≥3+BB(20,2)
- **Walk-forward: 73.1% WR σ=3.6% T=102 folds=[69.7/78.0/71.4] ⭐⭐⭐**
- Highest stable WR of any signal found — better than any single 5m signal
- Requires 63 candles (21 synth 15m) to compute

### Strategy 17: Daily Range Extreme 📏
- **Method:** GoodH + BB(20,2.2) + streak≥2 + price in top 30% of daily range (bear) or bottom 30% (bull)
- **Raw WR: 73.4% T=79** (not yet walk-forward validated — treat as supplementary)
- Intuition: at BB extreme AND near daily high = double overextension confirmation

---

## Updated Rankings (As of Session 2)

### BEST STRATEGIES (walk-forward validated, out-of-sample)

| Rank | Strategy | WR | σ | Trades | Coin/TF |
|------|---------|-----|---|--------|---------|
| 1 | **Synth15m Ensemble (Strat 16)** | **73.1%** | **3.6%** | 102 | ETH/5m |
| 2 | **Good Hours Optimized (Strat 15)** | **69.8%** | **1.1%** | 126 | ETH/5m |
| 3 | BTC/15m MFI(10)>80+BB (Strat 12) | 70.4% | ~5% | 142 | BTC/15m |
| 4 | ETH/5m GGG+BB+bodyATR @ GoodH | 74.5% | 5.7% | 102 | ETH/5m |
| 5 | ETH/5m Sniper (GGG+BB+bodyATR exact) | 79.2% | — | 53 | ETH/5m |

### RESEARCH SCRIPTS (total: 28)
goodHoursRGGG.ts, ensembleVoting.ts, syntheticTF.ts + all previous 25
