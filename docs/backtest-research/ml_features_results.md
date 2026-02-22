# ML Feature Analysis Results

**Date:** 2026-02-22
**Scripts:** ml_feature_importance.js, ml_logistic_signal.js, ml_regime_clustering.js, ml_combined_signal.js

---

## 1. Feature Rankings (Mutual Information)

**ALL correlations are NEGATIVE** confirming mean-reverting markets.

### Cross-Dataset Rankings

| Rank | Feature | AvgRank | ETH/5m | ETH/15ms | SOL/5m | SOL/15ms |
|------|---------|---------|--------|----------|--------|----------|
| 1 | dailyRangePos | 1.0 | 1 | 1 | 1 | 1 |
| 2 | bbPos1522 | 3.5 | 3 | 5 | 2 | 4 |
| 3 | rsi7 | 3.8 | 2 | 3 | 5 | 5 |
| 4 | bbPos2020 | 5.8 | 4 | 8 | 3 | 8 |
| 5 | stochK | 6.0 | 7 | 4 | 6 | 7 |
| 6 | pattern3 | 6.3 | 10 | 2 | 10 | 3 |
| 7 | rsi14 | 6.5 | 6 | 11 | 7 | 2 |
| 8 | bbPos2022 | 6.8 | 5 | 9 | 4 | 9 |
| 9 | rsi21 | 9.0 | 9 | 12 | 9 | 6 |
| 10 | cci14 | 9.5 | 8 | 10 | 8 | 12 |
### Key Feature Insights

1. **dailyRangePos is #1 everywhere** - intraday mean reversion at daily extremes. Corr ETH/5m=-0.075, ETH/15m=-0.120, SOL/15m=-0.115
2. **rsi7 > rsi14 > rsi21** - shorter RSI captures exhaustion faster
3. **BB(15,2.2) position marginally better than BB(20,2.2)** across most datasets
4. **StochK competitive with RSI** - ranks #5 overall, provides independent confirmation
5. **pattern3 strong on 15m** - 3-candle sequence ranks #2 on ETH/15m, #3 on SOL/15m
6. **Hour is low MI but real** - temporal filters have proven value despite low raw MI

---

## 2. Logistic Regression Results

### Dominant LR Weights (consistent across all datasets)

| Dataset | #1 Feature/Weight | #2 Feature/Weight |
|---------|------------------|------------------|
| ETH/5m | dailyRangePos: -0.155 (BEAR) | vwapDist: +0.074 (BULL) |
| ETH/15m | dailyRangePos: -0.256 (BEAR) | vwapDist: +0.113 (BULL) |
| SOL/5m | dailyRangePos: -0.157 (BEAR) | vwapDist: +0.075 (BULL) |
| SOL/15m | dailyRangePos: -0.253 (BEAR) | vwapDist: +0.099 (BULL) |

### High-Confidence Signal WR

| Dataset | Thresh | WR | sigma | T | Status |
|---------|--------|----|-------|---|--------|
| ETH/5m | 0.58 | 63.1% | 2.9% | 791 | OK |
| ETH/5m | 0.60 | 65.3% | 2.3% | 216 | PASS |
| ETH/15m | 0.58 | 62.2% | 0.8% | 1366 | OK |
| ETH/15m | 0.62 | 65.5% | 7.3% | 397 | PASS |
| SOL/15m | 0.60 | 67.2% | 0.1% | 488 | PASS - ultra stable |
| SOL/15m | 0.62 | 69.3% | 2.9% | 215 | PASS |

### GoodHour + LR Combined
| ETH/5m GoodH+LR>=0.60 | 77.4% | 6.1% | 22 | Very selective but extreme accuracy |
| SOL/15m GoodH+LR>=0.60 | 72.3% | 7.8% | 94 | VALIDATED |
---

## 3. Regime Clustering (K-Means k=3)

### ETH/15m Synth - Critical Finding

| Regime | n candles | WR | sigma | T |
|--------|----------|-----|-------|---|
| LOW-VOL (cluster 0) | 11,025 | 64.3% | 5.5% | 67 |
| MED-VOL (cluster 2) | 4,106 | 68.4% | 4.3% | 57 |
| HIGH-VOL (cluster 1) | 2,533 | **87.5%** | 10.2% | 24 |

**ETH/15m HIGH-VOL cluster at BB = 87.5% WR [75/87/100] - all 3 folds profitable!**
Consistent with prior research: HIGH ATR is best for ETH/15m (not 5m).

### ETH/5m Regime Analysis

| Regime | n candles | WR | sigma | T |
|--------|----------|-----|-------|---|
| LOW-VOL | 41,112 | 58.9% | 3.8% | 246 |
| MED-VOL | 3,693 | 62.2% | 2.2% | 212 |
| HIGH-VOL | 8,187 | 65.1% | 5.9% | 23 |

MED-VOL regime is best for ETH/5m. LOW-VOL noisy, HIGH-VOL too sparse.

### SOL/15m Synth Regime Analysis

| Regime | n candles | WR | sigma | T |
|--------|----------|-----|-------|---|
| LOW-VOL | 13,225 | 70.0% | 14.7% | 62 |
| MED-VOL | 1,500 | 66.9% | 6.9% | 94 |
| HIGH-VOL | 2,939 | 58.8% | - | 17 |

**SOL is OPPOSITE of ETH:** LOW-VOL is best, HIGH-VOL worst.
SOL mean reversion only works in calm markets. ETH is most predictable when volatile.
---

## 4. Combined ML Strategies

### ETH/15m Synth - Best Results

| Strategy | WR | sigma | T | Folds |
|----------|-----|-------|---|-------|
| A: RSI14>65 + StochK>70 + BB | 66.1% | 5.8% | 106 | 62.9/74.3/61.1 |
| B: LowATR + CCI>100 + BB | 66.8% | 15.3% | 68 | FAIL - sigma too high |
| C: DailyRange top30% + RSI7 + BB | 67.2% | 7.3% | 79 | 65.4/76.9/59.3 |
| **D: MFI(10)>80 + RSI7 + s>=2 + BB** | **75.4%** | **5.4%** | **69** | **69.6/82.6/73.9** |
| E: RSI7>70 + Stoch>75 + s>=3 | 70.3% | 6.1% | 94 | 71.0/77.4/62.5 |
| F: VWAP dist + RSI14 + BB | 66.1% | 6.3% | 109 | 61.1/75.0/62.2 |
| **G: HighVol + RSI7 + BB** | **74.1%** | **5.2%** | **54** | **77.8/66.7/77.8** |

### SOL/15m Synth - Best Results

| Strategy | WR | sigma | T | Folds |
|----------|-----|-------|---|-------|
| A: RSI14>65 + StochK>70 + BB | 64.9% | 3.0% | 128 | 61.9/69.0/63.6 |
| B: LowATR + CCI>100 + BB | 68.3% | 10.1% | 76 | 56.0/68.0/80.8 |
| **C: DailyRange top30% + RSI7 + BB** | **72.2%** | **2.2%** | **97** | **71.9/75.0/69.7** |
| D: MFI(10)>80 + RSI7 + s>=2 + BB | 66.1% | 8.8% | 74 | 54.2/75.0/69.2 |
| E: RSI7+Stoch+s>=3 sniper | 64.6% | 5.7% | 99 | 72.7/60.6/60.6 |
| F: VWAP + RSI14 + BB | 63.6% | 1.1% | 129 | 62.8/62.8/65.1 |
| **G: HighVol + RSI7 + BB** | **68.6%** | **0.7%** | **67** | **68.2/68.2/69.6** |

### ETH/5m - All below 65% threshold
Best: StratC DailyRange+RSI7+BB = 63.1% sigma=3.9% T=222
StratE RSI7+Stoch+s>=3 = 63.0% sigma=3.3% T=287

### SOL/5m - All failed
Best: StratG HighVol+RSI7+BB = 58.3% sigma=3.9% - below threshold
---

## 5. Validated New Strategies

### Strategy ML-20: SOL/15m DailyRange+RSI7+BB (ULTRA STABLE)



### Strategy ML-21: ETH/15m MFI(10)+RSI7+streak+BB



### Strategy ML-22: ETH/15m HighVol+RSI7+BB



### Strategy ML-23: SOL/15m HighVol+RSI7+BB (MOST STABLE SOL)


---

## 6. Key ML Insights

### What LR Model Taught Us

1. **dailyRangePos is the dominant feature** - more predictive than BB position alone.
   - Captures intraday mean reversion at daily extremes
   - Should be added as a primary filter to ALL existing strategies

2. **vwapDist has POSITIVE weight** despite negative MI - when BELOW VWAP AND below BB lower,
   that is a BULL signal. VWAP acts as magnet.

3. **MFI(10) > standard period for ETH/15m** - shorter MFI captures exhaustion faster.
   StratD with MFI(10)+RSI7+s>=2+BB = 75.4% WR on ETH/15m.

4. **StochK is competitive with RSI** - ranks #5 overall, provides independent confirmation.
   RSI+StochK combination = stronger signal than either alone.

5. **High-vol good for ETH/15m, bad for SOL** - fundamental difference in regime behavior.

### Patterns NOT to Chase

- Wick ratios: low MI confirms wicks are not predictive on 5m/15m
- LowATR+CCI: high sigma (15.3% on ETH/15m) - unstable
- SOL/5m: nothing works above 58% WR regardless of feature combo

### Promising Patterns for Further Validation

1. ETH/15m HIGH-VOL cluster at BB = 87.5% WR (T=24) - small but extraordinary
2. ETH/5m GoodHour+LR>=0.60 = 77.4% WR (T=22) - selective but extreme
3. SOL/15m dailyRangePos>=0.7 + RSI7 + BB = 72.2% sigma=2.2% - most stable SOL ever
4. LR threshold 0.60 on SOL/15m = 67.2% sigma=0.1% T=488 - incredibly stable

---

## 7. Implementation Priority

| Priority | Strategy | Coin | WR | Sigma | T | Proposed ID |
|----------|----------|------|-----|-------|---|-------------|
| 1 | DailyRange+RSI7+BB | SOL/15m | 72.2% | 2.2% | 97 | Strategy 20 |
| 2 | MFI(10)+RSI7+s>=2+BB | ETH/15m | 75.4% | 5.4% | 69 | Strategy 21 |
| 3 | HighVol+RSI7+BB | ETH/15m | 74.1% | 5.2% | 54 | Strategy 22 |
| 4 | HighVol+RSI7+BB | SOL/15m | 68.6% | 0.7% | 67 | Strategy 23 |
| 5 | dailyRangePos filter | All | — | — | — | Add to existing |

---

*Generated: 2026-02-22 by ML analysis scripts*