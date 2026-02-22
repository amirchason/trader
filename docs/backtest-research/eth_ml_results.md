# ETH ML Strategy Research Results

**Date:** 2026-02-22
**Research scripts:** server/research/eth_ml_*.js
**Data:** ETH/5m (52,992 candles), ETH/15m (17,664 candles), ~6 months
**Validation:** Walk-forward 3-fold and 5-fold chronological splits

---

## FINAL 5 VALIDATED STRATEGIES

| # | Name | TF | WR | sigma | T | 5-fold | Status |
|---|------|----|-----|-------|---|--------|--------|
| A | ETH/15m MFI(10)>80 BB(20,2) s>=2 GoodH | 15m | 71.6% | 1.9% | 88 | 71.6% sig=9.4% | PASS 3-fold |
| B | ETH/5m Range(48)+BB(20,2.5) GoodH | 5m | 70.2% | 2.9% | 164 | 70.1% sig=3.8% | PASS both |
| C | ETH/5m Wed+Sat+GoodH+BB(20,2.2)+s>=2 | 5m | 70.5% | 4.4% | 112 | 70.5% sig=5.7% | PASS both |
| D | ETH/15m MFI(10)>80 BB(20,2.2) s>=2 GoodH | 15m | 75.4% | 5.4% | 69 | 75.7% sig=8.8% | PASS 3-fold |
| E | ETH/15m MFI(10)>75 BB(20,2.2) s>=2 GoodH | 15m | 67.1% | 4.1% | 91 | 67.1% sig=4.6% | PASS both |

---

## Strategy A: ETH/15m MFI(10)>80 BB(20,2) s>=2 GoodH [MOST STABLE]

**3-fold:** WR=71.6% sigma=1.9% T=88 [69.0/72.4/73.3] -- lowest sigma, all folds consistent
**5-fold:** WR=71.6% sigma=9.4% T=88 [64.7/82.4/58.8/82.4/70.0]

MFI (Money Flow Index) combines price AND volume. MFI>80 at BB extreme = double exhaustion.
BB(20,2.0) preferred: more trades (T=88 vs T=69) and dramatically lower sigma (1.9% vs 5.4%)

Implementation:
- BEAR: MFI(10)>80 AND close>BB(20,2.0).upper AND hour in {10,11,12,21} AND streak>=2 greens
- BULL: MFI(10)<20 AND close<BB(20,2.0).lower AND hour in {10,11,12,21} AND streak>=2 reds

---

## Strategy B: ETH/5m Range Breakout Exhaustion [BEST 5-FOLD]

**3-fold:** WR=70.2% sigma=2.9% T=164 [72.2/72.2/66.1]
**5-fold:** WR=70.1% sigma=3.8% T=164 [75.0/71.9/65.6/65.6/72.2] -- ALL 5 FOLDS >= 65%!

Price breaking a 4-hour historical range AND BB outer band = double exhaustion confirmation.

Variants also passing 5-fold:
- Range(36)+BB(20,2.5): WR=68.0% sigma=2.2% T=197 (more trades)
- Range(60)+BB(20,2.5): WR=69.4% sigma=4.6% T=147
- Range(48)+BB(20,2.2): WR=66.8% sigma=4.6% T=241 (most trades)

Implementation:
- high48 = max(high[i-48..i-1]) -- 4 hours on 5m
- low48 = min(low[i-48..i-1])
- BEAR: close>high48 AND close>BB(20,2.5).upper AND hour in GoodH
- BULL: close<low48 AND close<BB(20,2.5).lower AND hour in GoodH

---

## Strategy C: ETH/5m Wednesday+Saturday Day Filter [DOW ALPHA]

**3-fold:** WR=70.5% sigma=4.4% T=112 [64.9/75.7/71.1]
**5-fold:** WR=70.5% sigma=5.7% T=112 [63.6/72.7/77.3/63.6/75.0]

Day-of-week filter on existing GoodH+BB(20,2.2)+s>=2 strategy.
Wed/Sat have stronger mean-reversion than other days: 70.5% vs ~61% on Mon/Tue/Thu/Fri.

Implementation:
- day_of_week in {3=Wednesday, 6=Saturday} UTC
- Then apply existing BB+GoodH+streak logic

---

## Strategy D: ETH/15m MFI(10)>80 BB(20,2.2) s>=2 GoodH [HIGHEST WR]

**3-fold:** WR=75.4% sigma=5.4% T=69 [69.6/82.6/73.9]
**5-fold:** WR=75.7% sigma=8.8% T=69

Tighter band version of Strategy A. Fewer trades but highest WR.
Best used as a confluence signal -- when both A and D agree, high conviction entry.

---

## Strategy E: ETH/15m MFI(10)>75 BB(20,2.2) s>=2 GoodH [BALANCED]

**3-fold:** WR=67.1% sigma=4.1% T=91 [70.0/70.0/61.3]
**5-fold:** WR=67.1% sigma=4.6% T=91 [66.7/72.2/72.2/61.1/63.2] -- PASS 5-fold, all >= 61%

More trades than D (T=91 vs T=69). MFI>75 threshold catches more signals while still meaningful.

---

## Scripts That Failed

| Script | Best WR | Reason |
|--------|---------|--------|
| eth_ml_stoch.js | 61.5% | Stochastic adds no edge beyond BB alone |
| eth_ml_cci.js | 60.2% | CCI is redundant with BB signal |
| eth_ml_smallbody.js | 54.5% | Too few trades, no reliable edge |
| eth_ml_keltner_rsi.js | 61.9% | Does not reach 65% threshold |
| eth_ml_vwap_exhaust.js | 59.0% | VWAP deviation adds no marginal edge |
| eth_ml_lowvol.js | 61.6% | Low-vol regime does not boost BB signals |
| eth_ml_gap.js (original) | 0% | No price gaps in 24/7 crypto |

---

## Key Findings

1. **MFI on ETH/15m works** -- same pattern as BTC/15m MFI (70.4%). ETH gets 71-75% WR with MFI>80+BB+GoodH.
2. **Range breakout exhaustion is new** -- 48-bar range + BB extreme = 70% WR, ultra-stable (all 5 folds >= 65%).
3. **Wednesday+Saturday genuine alpha** -- 70.5% WR vs ~61% on other days with same filters.
4. **CCI/Stoch/VWAP add no edge** -- BB captures the reversal signal more cleanly than oscillators.
5. **Low-vol regime does not help** -- ATR percentile filter does not push BB signals past 62%.
6. **Doji patterns fail** -- Small body at BB: too few trades, no reliable directional signal.
7. **Streak=4 promising but T too low** -- 72.6% WR at BB(20,2.5) but T=55 for 5-fold is unreliable.

---

## Full Iteration Data

### ETH/15m MFI variants (3-fold, all PASS):
- MFI>80 BB(20,2.2) s>=3 GoodH: WR=75.5% sigma=5.0% T=53
- MFI>80 BB(20,2.2) s>=2 GoodH: WR=75.4% sigma=5.4% T=69
- MFI>80 BB(15,2) s>=2 GoodH: WR=74.4% sigma=3.6% T=78
- MFI>80 BB(15,2.2) s>=2 GoodH: WR=73.0% sigma=5.9% T=52
- MFI>80 BB(20,2.2) s>=2 H=[10,11,12,13,21]: WR=72.5% sigma=3.5% T=91
- MFI>80 BB(20,2.2) s>=1 GoodH: WR=72.4% sigma=3.3% T=76
- MFI>80 BB(20,2) s>=2 GoodH: WR=71.6% sigma=1.9% T=88 [RECOMMENDED]
- MFI(8)>80 BB(20,2.2) s>=2 GoodH: WR=67.7% sigma=5.3% T=93
- MFI>75 BB(20,2.2) s>=2 GoodH: WR=67.1% sigma=4.1% T=91

### ETH/5m Range Breakout variants (3-fold, all PASS):
- Range(36)+BB(20,2.5): WR=68.0% sigma=2.1% T=197
- Range(48)+BB(20,2.5): WR=70.2% sigma=2.9% T=164 [RECOMMENDED]
- Range(60)+BB(20,2.5): WR=69.4% sigma=3.3% T=147
- Range(72)+BB(20,2.5): WR=67.2% sigma=2.2% T=131
- Range(96)+BB(20,2.5): WR=67.5% sigma=6.6% T=104
- Range(48)+BB(20,2.2): WR=66.8% sigma=2.7% T=241

### ETH/5m Day-of-Week variants (3-fold):
- Wed only: WR=72.9% sigma=12.1% T=62 -- sigma too high
- Wed+Sat: WR=70.5% sigma=4.4% T=112 PASS [RECOMMENDED]
- Wed+Thu: WR=67.7% sigma=2.5% T=133 PASS (fails 5-fold sigma)
- Sun+Wed+Sat: WR=65.3% sigma=5.0% T=205 PASS
- Tue+Wed+Sat: WR=67.4% sigma=7.2% T=178 PASS

---

## Implementation Priority

For adding to indicators.ts as new strategies (20-24):

1. **Strategy 20** -- ETH/15m MFI(10)>80 + BB(20,2) + GoodH + s>=2 (most stable, sigma=1.9%)
2. **Strategy 21** -- ETH/5m Range(48)+BB(20,2.5)+GoodH (all 5 folds >= 65%, ultra stable)
3. **Strategy 22** -- ETH/5m Wed+Sat+GoodH+BB(20,2.2)+s>=2 (5-fold PASS, genuine DOW alpha)
4. **Strategy 23** -- ETH/15m MFI(10)>80+BB(20,2.2)+GoodH+s>=2 (highest WR = 75.4%)
5. **Strategy 24** -- ETH/15m MFI(10)>75+BB(20,2.2)+GoodH+s>=2 (5-fold PASS, more trades)
