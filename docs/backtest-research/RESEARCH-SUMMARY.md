# ETH 5m Binary Prediction Research Summary

Generated: 2026-02-21

## Key Findings

### 1. Base Rate
- ETH 5m next-candle-up rate: ~50% (train: 49.95%, test: 50.19%)
- Market is near-efficient. Any edge > 1% is significant.

### 2. MTF (Multi-Timeframe) Analysis — STRONGEST EDGE

| Strategy | Train Edge | Test Edge | Trades | Verdict |
|---|---|---|---|---|
| Uptrend (1h+4h) + 5m RSI>70 → BEAR | +3.32% | **+8.82%** | 272 | ✅ STRONG |
| Downtrend (1h+4h) + 5m RSI<30 → BULL | +1.53% | **+3.54%** | 297 | ✅ STRONG |
| RSI 1h<40 AND 4h<40 → BEAR | +1.07% | +0.51% | 2039 | 🟢 MODEST |
| RSI 1h>60 AND 4h>60 → BULL | +0.43% | +0.79% | 1896 | 🟢 MODEST |

**Key insight**: Mean reversion within higher-TF trend is the most reliable signal.
When 1h/4h says uptrend but 5m RSI is overbought → the 5m will dip back.

### 3. Candle Pattern Analysis — CONSISTENT SIGNALS

| Pattern | Train Edge | Test Edge | Verdict |
|---|---|---|---|
| Strong green (+0.5%) → next RED | +8.33% | **+9.06%** | ✅ STRONG |
| 4+ consecutive green → next RED | +4.43% | **+7.07%** | ✅ STRONG |
| 4+ consecutive red → next GREEN | +4.25% | **+6.68%** | ✅ STRONG |
| Big GREEN candle → next RED | +4.89% | **+6.34%** | ✅ STRONG |
| 3 consecutive green → next RED | +3.34% | **+5.84%** | ✅ STRONG |
| 3 consecutive red → next GREEN | +3.10% | **+5.37%** | ✅ STRONG |

**Key insight**: ETH 5m shows STRONG mean reversion. Momentum does NOT work.
- "Previous green → next green" = -1.38% edge (anti-momentum!)
- "GGG" sequence → next RED has -4.08% edge

### 4. Candle Sequence Matrix (GGG/GRR/etc.)

| Sequence | Next UP% | Edge | Bet |
|---|---|---|---|
| GGG | 45.92% | **-4.08%** | BEAR |
| RRR | 53.70% | **+3.70%** | BULL |
| GRR | 51.77% | +1.77% | BULL |
| GRG | 48.74% | -1.26% | BEAR |

### 5. ML Classifiers

| Model | Test Accuracy | Best WR | Best PnL | Notes |
|---|---|---|---|---|
| Gaussian Naive Bayes | 53.26% | 57.03% | $5,149 | Many trades, consistent |
| Logistic Regression | 53.16% | 57.39% | $1,293 | Fewer high-conf trades |
| Random Forest | TBD | TBD | TBD | Running... |

**NB at threshold=0.52** (most aggressive): 10,227 trades, 53.86% WR, **$5,149 PnL**

### 6. What DOESN'T Work

- Simple momentum (prev green → next green): -1.38% edge
- Volume spike → follow direction: -4.72% edge (REVERSAL expected!)
- 1h/4h trend following alone: near-zero edge
- Simple RSI threshold without MTF context: minimal edge

## Recommended Combined Strategy

```
For each 5m candle:

1. Check MTF state:
   - rsi1h, rsi4h (from completed 1h/4h candles)
   - Classify as: strong_up, up, neutral, down, strong_down

2. Check 5m signals:
   - 5m RSI (overbought/oversold)
   - Candle streak (3+ consecutive)
   - Candle body size (big = reversion expected)

3. Combine:
   IF (strong uptrend AND 5m RSI>70): BET BEAR   ← best signal (+8.82%)
   IF (strong downtrend AND 5m RSI<30): BET BULL   ← 2nd best (+3.54%)
   IF (3+ consecutive candles): BET REVERSION
   IF (ML model confidence > 0.55): FOLLOW ML prediction

4. Position sizing: Kelly criterion or fixed 1%/trade
```

## ML Best Packages for Node.js

- **ml-random-forest** (installed): Pure JS, stable, good for this use case
- **brain.js**: Neural networks, less maintained
- **@tensorflow/tfjs-node**: LSTM, best for sequential, heavy dependency

## Research Files

- `mtf-results.json` — Multi-timeframe filter analysis
- `pattern-results.json` — Candle pattern sequences
- `ml-results.json` — Logistic Regression + Naive Bayes
- `rf-results.json` — Random Forest (in progress)
- `batch-results.json` — 960-config batch test

## Next Steps

1. Implement MTF + pattern combined strategy in `backtestEngine.ts`
2. Add MTF-aware signal to the live trading signals (`indicators.ts`)
3. Train RF model on full dataset, serialize for live use
4. Build walk-forward validation (retrain monthly)
