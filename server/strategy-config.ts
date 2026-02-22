import { getDb } from './db';
import { getPnlSummary } from './paper-trading';

// ─────────────────── Types ───────────────────

export interface StrategyConfig {
  id: string;
  strategyId: number;
  coin: string;
  enabled: boolean;
  tradeSize: number;
}

// ─────────────────── Schema ───────────────────

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS strategy_configs (
    id          TEXT    PRIMARY KEY,
    strategy_id INTEGER NOT NULL,
    coin        TEXT    NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 0,
    trade_size  REAL    NOT NULL DEFAULT 50
  )
`;

// The 6 strategy+coin combos we support
const DEFAULT_CONFIGS: Array<{ strategyId: number; coin: string }> = [
  // Tier 1: Best ETH
  { strategyId: 18, coin: 'ETH' },
  { strategyId: 16, coin: 'ETH' },
  { strategyId: 17, coin: 'ETH' },
  { strategyId: 15, coin: 'ETH' },
  { strategyId: 13, coin: 'ETH' },
  // Tier 2: Cross-coin
  { strategyId: 14, coin: 'ETH' },
  { strategyId: 14, coin: 'BTC' },
  { strategyId: 12, coin: 'BTC' },
  // Tier 3: Additional
  { strategyId: 10, coin: 'ETH' },
  { strategyId: 10, coin: 'BTC' },
  { strategyId: 11, coin: 'ETH' },
  { strategyId: 9,  coin: 'ETH' },
  { strategyId: 9,  coin: 'BTC' },
  // SOL
  { strategyId: 19, coin: 'SOL' },
  // XRP
  { strategyId: 20, coin: 'XRP' },
  // New ETH strategies (21-25) — Session 4 ML-optimized
  { strategyId: 21, coin: 'ETH' },
  { strategyId: 22, coin: 'ETH' },
  { strategyId: 23, coin: 'ETH' },
  { strategyId: 24, coin: 'ETH' },
  { strategyId: 25, coin: 'ETH' },
  // New SOL strategies (26-30) — Session 4 ML-optimized
  { strategyId: 26, coin: 'SOL' },
  { strategyId: 27, coin: 'SOL' },
  { strategyId: 28, coin: 'SOL' },
  { strategyId: 29, coin: 'SOL' },
  { strategyId: 30, coin: 'SOL' },
  // New ETH strategies (31-32, 35) — Session 5 ML-optimized (best ever WR)
  { strategyId: 31, coin: 'ETH' },
  { strategyId: 32, coin: 'ETH' },
  { strategyId: 35, coin: 'ETH' },
  // New SOL strategies (33-34) — Session 5 ML-optimized (ultra stable)
  { strategyId: 33, coin: 'SOL' },
  { strategyId: 34, coin: 'SOL' },
  // New ETH/15m strategies (36-38) — Session 6 Wave 3 (ultra stable body+RSI+MFI)
  { strategyId: 36, coin: 'ETH' },
  { strategyId: 37, coin: 'ETH' },
  { strategyId: 38, coin: 'ETH' },
  // New XRP strategies (39-40) — Session 6 validated (near-perfect stability)
  { strategyId: 39, coin: 'XRP' },
  { strategyId: 40, coin: 'XRP' },
  // Strategy 41: Saturday BB — BTC validated (69.1% WF), also for ETH
  { strategyId: 41, coin: 'BTC' },
  { strategyId: 41, coin: 'ETH' },
  // Strategy 42: SOL RSI Streak BB — ULTRA STABLE WF=67.1% σ=2.9% (paramOptimize)
  { strategyId: 42, coin: 'SOL' },
  // BTC 5m strategies (43-46) — btc5mResearch.js: BTC h=[1,12,13,16,20] strongly mean-reverting
  { strategyId: 43, coin: 'BTC' }, // MFI>75+BB22+GH+s>=1 → WF=81.6% σ=2.6% ULTRA STABLE
  { strategyId: 44, coin: 'BTC' }, // RSI>67+BB22+GH+s>=1 → WF=80.5% σ=4.2%
  { strategyId: 45, coin: 'BTC' }, // GH+BB22+s>=2         → WF=79.7% σ=5.5% T=310 HIGH FREQ
  { strategyId: 46, coin: 'BTC' }, // RSI>70+BB22+GH+s>=1 → WF=83.1% σ=8.5% HIGHEST WR
  // All-Hours High-Frequency strategies (56-58) — quickValidateBTC5m.js: no hour filter, 5+/day
  { strategyId: 56, coin: 'ETH' }, // ALL_H+RSI>70+BB22+s>=1 → ETH WF=76.1% σ=2.6% 5.1/day ULTRA STABLE
  { strategyId: 56, coin: 'BTC' }, // ALL_H+RSI>70+BB22+s>=1 → BTC WF=75.2% σ=5.6% 5.1/day
  { strategyId: 57, coin: 'ETH' }, // ALL_H+MFI>80+BB22+s>=1 → ETH WF=75.7% σ=4.1% 4.2/day
  { strategyId: 57, coin: 'BTC' }, // ALL_H+MFI>80+BB22+s>=1 → BTC validated 4.2/day
  { strategyId: 58, coin: 'ETH' }, // ALL_H+MFI>85+BB22+s>=1 → ETH WF=76.3% σ=4.3% 2.8/day
  { strategyId: 58, coin: 'BTC' }, // ALL_H+MFI>85+BB22+s>=1 → BTC validated 2.8/day
  // SOL All-Hours High-Frequency strategies (59-60) — newSignalSearch.js: SOL 5m all hours
  { strategyId: 59, coin: 'SOL' }, // SOL ALL_H+RSI>70+BB22+s>=1 → WF=73.0% σ=2.8% 4.8/day ULTRA STABLE
  { strategyId: 60, coin: 'SOL' }, // SOL ALL_H+RSI7>75+BB22+s>=1 → WF=73.2% σ=3.1% 7.2/day HIGHEST FREQ
  // BTC Synth-15m strategies (61-62) — newSignalSearch.js: group 3×5m → synth15m
  { strategyId: 61, coin: 'BTC' }, // Synth15m GH+RSI>65+BB22+s>=1 → WF=86.3% σ=6.3% HIGHEST WR EVER!
  { strategyId: 62, coin: 'BTC' }, // Synth15m ALL_H+RSI>70+BB22+s>=1 → WF=77.0% σ=4.4% 1.8/day
  // ETH Enhanced All-Hours strategies (64-65) — newSignalSearch.js
  { strategyId: 64, coin: 'ETH' }, // ALL_H+RSI>70+MFI>70+BB22+s>=1 → WF=76.4% σ=2.2% 4.4/day ULTRA STABLE
  { strategyId: 64, coin: 'BTC' }, // same logic, BTC version
  { strategyId: 65, coin: 'ETH' }, // ALL_H+RSI>70+dev[0.05-0.5%]+BB22+s>=1 → WF=77.8% σ=2.7% ULTRA STABLE
  { strategyId: 65, coin: 'BTC' }, // same logic, BTC version
  // BTC GoodH body+RSI filter (66) — newSignalSearch.js
  { strategyId: 66, coin: 'BTC' }, // GH+RSI>65+body>=0.15%+BB22+s>=1 → WF=79.2% σ=2.6% ULTRA STABLE
  // Ultra High-Frequency Testing Strategy (67) — 40+ trades/day for position testing
  { strategyId: 67, coin: 'ETH' }, // ETH BB(20,1.8)+s>=1 → WF=73.1% σ=0.7% 42/day ULTRA STABLE
  { strategyId: 67, coin: 'BTC' }, // BTC BB(20,1.8)+s>=1 → WF=73.4% σ=0.7% 42/day ULTRA STABLE
  { strategyId: 67, coin: 'SOL' }, // SOL BB(20,1.8)+s>=1 → WF=71.7% σ=0.4% 43/day MOST STABLE EVER
  // Ultra High-Frequency 80+ Strategy (68) — 100+/day BB(20,1.0)
  { strategyId: 68, coin: 'ETH' }, // ETH BB(20,1.0)+s>=1 → WF=72.2% σ=1.2% 104/day ULTRA STABLE
  { strategyId: 68, coin: 'BTC' }, // BTC BB(20,1.0)+s>=1 → WF=71.7% σ=1.5% 108/day ULTRA STABLE
  { strategyId: 68, coin: 'SOL' }, // SOL BB(20,1.0)+s>=1 → WF=70.9% σ=0.6% 107/day ULTRA STABLE
  // ML-Optimized Stochastic+BB (69) — NOTE: mlOptimize5m WRs were inflated (flawed exit model)
  // Correct at-expiry WR ≈ 54% for BB(20,1.0) — kept for signal diversity only
  { strategyId: 69, coin: 'ETH' }, // ~54% WR correct-exit (diversity signal only)
  { strategyId: 69, coin: 'BTC' }, // ~54% WR correct-exit (diversity signal only)
  { strategyId: 69, coin: 'SOL' }, // ~53% WR correct-exit (diversity signal only)
  // h=12 Noon Peak BB(20,1.5) (70) — correctExitValidation.js VERIFIED at-expiry WR
  { strategyId: 70, coin: 'ETH' }, // h=12+BB(20,1.5)+s>=1 → WF=62.9% σ=4.0% 2.7/d CORRECT ✅
  { strategyId: 70, coin: 'BTC' }, // h=12+BB(20,1.5)+s>=1 → WF=57.1% σ=4.4% 2.9/d
  { strategyId: 70, coin: 'SOL' }, // h=12+BB(20,1.5)+s>=1 → WF=63.8% σ=3.6% 2.9/d CORRECT ✅
  // ALL-H Pure BB(20,2.2)+s>=1 (71) — fiveMinBinary.js + fifteenMinBinary.js TRUE at-expiry
  { strategyId: 71, coin: 'ETH' }, // ETH 5m=56.6% σ=1.5% 20.9/d + 15m=55.0% σ=2.4% 20.3/d → 41.2/d ✅
  { strategyId: 71, coin: 'BTC' }, // BTC 5m=55.9% σ=2.0% 20.1/d + 15m=56.2% σ=2.2% 20.4/d → 40.5/d ✅
  { strategyId: 71, coin: 'SOL' }, // SOL 5m=52.8% σ=1.1% 20.9/d + 15m=54.6% σ=2.1% 20.8/d → 41.7/d
  // Connors RSI (15/85) (72) — TradingView CRSI = RSI(3)+streakRSI(2)+percentileRank(100)
  { strategyId: 72, coin: 'ETH' }, // ETH CRSI(15/85) → WF=56.3% σ=1.9% 33/day ✅
  { strategyId: 72, coin: 'BTC' }, // BTC CRSI(15/85) → WF=54.9% σ=1.7% 34/day ✅
  { strategyId: 72, coin: 'SOL' }, // SOL CRSI(15/85) → WF=52.7% σ=2.5% 34/day (marginal)
  { strategyId: 72, coin: 'XRP' }, // XRP CRSI(15/85) → WF=52.8% σ=1.0% 34/day (marginal)
  // ATR Climax BB22 + RSI7 (73) — Big candle at BB extreme = exhaustion → reverse
  { strategyId: 73, coin: 'ETH' }, // ETH ATR Climax → WF=57.3% σ=1.5% 10/day ✅✅
  { strategyId: 73, coin: 'BTC' }, // BTC ATR Climax → WF=57.8% σ=2.2% 11/day ✅✅
  { strategyId: 73, coin: 'SOL' }, // SOL ATR Climax → WF=55.1% σ=3.9% 9/day ✅
  { strategyId: 73, coin: 'XRP' }, // XRP ATR Climax → WF=54.9% σ=3.5% 10/day ✅
  // StochRSI (K+D<20) + BB22 (74) — Double oscillator + BB = high conviction
  { strategyId: 74, coin: 'ETH' }, // ETH StochRSI+BB22 → WF=58.4% σ=3.5% 14/day ✅✅
  { strategyId: 74, coin: 'BTC' }, // BTC StochRSI+BB22 → WF=57.7% σ=2.2% 13/day ✅✅
  { strategyId: 74, coin: 'SOL' }, // SOL StochRSI+BB22 → WF=52.1% σ=3.4% 14/day (marginal)
  { strategyId: 74, coin: 'XRP' }, // XRP StochRSI+BB22 → WF=54.1% σ=2.6% 14/day ✅

  // Session 10: CCI>200 + BB22 (75) — avg 55.9% WR 9/day ✅✅
  { strategyId: 75, coin: 'ETH' }, // ETH CCI>200+BB22 → WF=56.6% 2/day ✅
  { strategyId: 75, coin: 'BTC' }, // BTC CCI>200+BB22 → WF=58.2% 2/day ✅✅
  { strategyId: 75, coin: 'SOL' }, // SOL CCI>200+BB22 → WF=53.6% 3/day ✅
  { strategyId: 75, coin: 'XRP' }, // XRP CCI>200+BB22 → WF=55.3% 2/day ✅

  // Session 10: Williams %R + RSI7 + BB22 (76) — avg 55.2% WR 10/day ✅
  { strategyId: 76, coin: 'ETH' }, // ETH WPR+RSI7+BB22 → WF=56.8% 2/day ✅
  { strategyId: 76, coin: 'BTC' }, // BTC WPR+RSI7+BB22 → WF=57.5% 3/day ✅✅
  { strategyId: 76, coin: 'SOL' }, // SOL WPR+RSI7+BB22 → WF=53.6% 3/day ✅
  { strategyId: 76, coin: 'XRP' }, // XRP WPR+RSI7+BB22 → WF=52.8% 3/day (marginal)

  // Session 10: Keltner Outer (77) — avg 54.6% WR 24/day ✅ (best volume)
  { strategyId: 77, coin: 'ETH' }, // ETH Keltner Outer → WF=56.6% 6/day ✅
  { strategyId: 77, coin: 'BTC' }, // BTC Keltner Outer → WF=54.0% 7/day ✅
  { strategyId: 77, coin: 'SOL' }, // SOL Keltner Outer → WF=54.5% 6/day ✅
  { strategyId: 77, coin: 'XRP' }, // XRP Keltner Outer → WF=53.2% 6/day ✅

  // Session 10 Micro-Structure (hfBinary5m.ts, at-expiry validated) ─────────────
  // Strat 78: 1m RSI7+BB22 — ETH=58.0% BTC=57.1% SOL=54.8% XRP=54.2% ~6.5/day each
  { strategyId: 78, coin: 'ETH' }, // ETH 1m RSI7+BB22 → WF=58.0% ~6.5/day ✅✅
  { strategyId: 78, coin: 'BTC' }, // BTC 1m RSI7+BB22 → WF=57.1% ~6.5/day ✅✅
  { strategyId: 78, coin: 'SOL' }, // SOL RSI7+BB22 → WF=54.8% ~6.5/day ✅
  { strategyId: 78, coin: 'XRP' }, // XRP RSI7+BB22 → WF=54.2% ~6.5/day ✅

  // Strat 79: Vol Exhaustion BB22 — ETH=58.1% BTC=60.5% SOL=55.7% XRP=57.1% ~3.7/day
  { strategyId: 79, coin: 'ETH' }, // ETH Vol Exhaustion → WF=58.1% ~3.7/day ✅✅
  { strategyId: 79, coin: 'BTC' }, // BTC Vol Exhaustion → WF=60.5% ~3.7/day ✅✅✅
  { strategyId: 79, coin: 'SOL' }, // SOL Vol Exhaustion → WF=55.7% ~3.7/day ✅
  { strategyId: 79, coin: 'XRP' }, // XRP Vol Exhaustion → WF=57.1% ~3.7/day ✅✅

  // Strat 80: MicroStreak×3 BB22 — ETH=58.4% BTC=60.9% SOL=57.4% XRP=55.4% ~3/day
  { strategyId: 80, coin: 'ETH' }, // ETH MicroStreak×3 → WF=58.4% ~3/day ✅✅
  { strategyId: 80, coin: 'BTC' }, // BTC MicroStreak×3 → WF=60.9% ~3/day ✅✅✅
  { strategyId: 80, coin: 'SOL' }, // SOL MicroStreak×3 → WF=57.4% ~3/day ✅✅
  { strategyId: 80, coin: 'XRP' }, // XRP MicroStreak×3 → WF=55.4% ~3/day ✅

  // Strat 81: ML 15m-Streak+BB22 — BTC=72.7% ETH=63.5% SOL=64.8% XRP=60.8% ~5.5/day
  { strategyId: 81, coin: 'ETH' }, // ETH ML 15m-Streak → WF=63.5% ~5.5/day ✅✅✅
  { strategyId: 81, coin: 'BTC' }, // BTC ML 15m-Streak → WF=72.7% ~5.5/day ✅✅✅✅
  { strategyId: 81, coin: 'SOL' }, // SOL ML 15m-Streak → WF=64.8% ~5.5/day ✅✅✅
  { strategyId: 81, coin: 'XRP' }, // XRP ML 15m-Streak → WF=60.8% ~5.5/day ✅✅✅

  // Session 11: BB%B+RSI7 (82) — avg 56.3% WR 8/day ✅✅
  { strategyId: 82, coin: 'ETH' }, // ETH BB%B+RSI7 → WF=58.3% ~2.2/day ✅✅
  { strategyId: 82, coin: 'BTC' }, // BTC BB%B+RSI7 → WF=58.2% ~2.0/day ✅✅
  { strategyId: 82, coin: 'SOL' }, // SOL BB%B+RSI7 → WF=54.2% ~2.0/day ✅
  { strategyId: 82, coin: 'XRP' }, // XRP BB%B+RSI7 → WF=54.4% ~1.9/day ✅

  // Session 11: RSI3>90+BB22 (83) — avg 55.9% WR 8/day ✅✅ (ETH=59.3%!)
  { strategyId: 83, coin: 'ETH' }, // ETH RSI3+BB22 → WF=59.3% ~2.2/day ✅✅✅
  { strategyId: 83, coin: 'BTC' }, // BTC RSI3+BB22 → WF=56.2% ~2.0/day ✅
  { strategyId: 83, coin: 'SOL' }, // SOL RSI3+BB22 → WF=54.1% ~2.0/day ✅
  { strategyId: 83, coin: 'XRP' }, // XRP RSI3+BB22 → WF=54.1% ~2.1/day ✅

  // Session 11: RSI7 Consec2+BB22 (84) — avg 55.5% WR 8/day ✅ (ETH=58.1%!)
  { strategyId: 84, coin: 'ETH' }, // ETH RSI7 Consec2 → WF=58.1% ~2.0/day ✅✅
  { strategyId: 84, coin: 'BTC' }, // BTC RSI7 Consec2 → WF=56.3% ~1.8/day ✅
  { strategyId: 84, coin: 'SOL' }, // SOL RSI7 Consec2 → WF=53.8% ~1.9/day ✅
  { strategyId: 84, coin: 'XRP' }, // XRP RSI7 Consec2 → WF=54.0% ~1.9/day ✅

  // Session 11: EMA20Dev+RSI7+BB22 (85) — avg 55.6% WR 7/day ✅
  { strategyId: 85, coin: 'ETH' }, // ETH EMA20Dev → WF=57.0% ~1.7/day ✅✅
  { strategyId: 85, coin: 'BTC' }, // BTC EMA20Dev → WF=56.9% ~0.9/day ✅✅
  { strategyId: 85, coin: 'SOL' }, // SOL EMA20Dev → WF=54.3% ~2.1/day ✅
  { strategyId: 85, coin: 'XRP' }, // XRP EMA20Dev → WF=54.3% ~1.8/day ✅

  // Session 11: BB%B+CCI+WPR Triple (86) — avg 55.2% WR 12/day ✅ (best vol S11)
  { strategyId: 86, coin: 'ETH' }, // ETH Triple → WF=56.1% ~3.1/day ✅
  { strategyId: 86, coin: 'BTC' }, // BTC Triple → WF=57.5% ~3.0/day ✅✅
  { strategyId: 86, coin: 'SOL' }, // SOL Triple → WF=53.9% ~3.1/day ✅
  { strategyId: 86, coin: 'XRP' }, // XRP Triple → WF=53.1% ~3.2/day ✅

  // Session 12: Advanced Confluence (87-90) — session12_research.js
  { strategyId: 87, coin: 'ETH' }, // ETH DoubleRSI+BB22 → WF=57.6% ~2.4/day ✅✅
  { strategyId: 87, coin: 'BTC' }, // BTC DoubleRSI+BB22 → WF=56.2% ~2.2/day ✅✅
  { strategyId: 87, coin: 'SOL' }, // SOL DoubleRSI+BB22 → WF=55.4% ~2.3/day ✅
  { strategyId: 87, coin: 'XRP' }, // XRP DoubleRSI+BB22 → WF=54.1% ~2.3/day ✅
  { strategyId: 88, coin: 'ETH' }, // ETH BB Squeeze→Release → WF=57.1% ~1.9/day ✅✅
  { strategyId: 88, coin: 'BTC' }, // BTC BB Squeeze→Release → WF=58.1% ~1.7/day ✅✅
  { strategyId: 88, coin: 'SOL' }, // SOL BB Squeeze→Release → WF=53.4% ~1.6/day ✅
  { strategyId: 88, coin: 'XRP' }, // XRP BB Squeeze→Release → WF=54.6% ~1.7/day ✅
  { strategyId: 89, coin: 'ETH' }, // ETH WideRange+BB22 → WF=55.6% ~2.0/day ✅
  { strategyId: 89, coin: 'BTC' }, // BTC WideRange+BB22 → WF=56.1% ~1.9/day ✅✅
  { strategyId: 89, coin: 'SOL' }, // SOL WideRange+BB22 → WF=54.7% ~1.7/day ✅
  { strategyId: 89, coin: 'XRP' }, // XRP WideRange+BB22 → WF=55.6% ~1.7/day ✅
  { strategyId: 90, coin: 'ETH' }, // ETH ADX<20+BB22 → WF=56.4% ~0.7/day ✅✅
  { strategyId: 90, coin: 'BTC' }, // BTC ADX<20+BB22 → WF=63.1% ~0.5/day ✅✅✅ BEST ALL-HOURS!
  { strategyId: 90, coin: 'SOL' }, // SOL ADX<20+BB22 → WF=53.5% ~0.8/day ✅
  { strategyId: 90, coin: 'XRP' }, // XRP ADX<20+BB22 → WF=57.4% ~0.7/day ✅✅

  // Session 12 High-WR: Good Hours ultra-selective (session12_highwr.js) — >65% WR target
  { strategyId: 91, coin: 'ETH' }, // ETH GH+CRSI85+BB22 → WF=67.2% ~0.32/day ✅✅✅
  { strategyId: 91, coin: 'BTC' }, // BTC GH+CRSI85+BB22 → WF=61.1% ~0.45/day ✅✅
  { strategyId: 92, coin: 'BTC' }, // BTC GH+ADX<20+RSI73+MFI72+BB22 → WF=76.2% 🔥🔥🔥 >75% WR!
  { strategyId: 92, coin: 'ETH' }, // ETH GH+ADX<20+RSI73+MFI72+BB22 → WF=60.0% ~0.05/day ✅
  { strategyId: 92, coin: 'XRP' }, // XRP GH+ADX<20+RSI73+MFI72+BB22 → WF=72.7% 🔥🔥 XRP good hours
  // Session 13 High-WR: >75% WR ultra-selective (session13_highwr.js)
  { strategyId: 93, coin: 'BTC' }, // BTC GH+ADX<20+RSI73+MFI72+RSI14 → WF=83.3% 🔥🔥🔥 >75%!
  { strategyId: 93, coin: 'XRP' }, // XRP GH+ADX<20+RSI73+MFI72+RSI14 → WF=80.0% 🔥🔥🔥 >75%!
  { strategyId: 93, coin: 'SOL' }, // SOL GH+ADX<20+RSI73+MFI72+RSI14 → WF=71.4% 🔥🔥
  { strategyId: 93, coin: 'ETH' }, // ETH GH+ADX<20+RSI73+MFI72+RSI14 → WF=66.7% 🔥
  { strategyId: 94, coin: 'BTC' }, // BTC GH+ADX<20+RSI76+MFI75 → WF=80.0% 🔥🔥🔥 >75%!
  { strategyId: 94, coin: 'XRP' }, // XRP GH+ADX<20+RSI76+MFI75 → WF=77.8% 🔥🔥🔥 >75%!
  { strategyId: 94, coin: 'SOL' }, // SOL GH+ADX<20+RSI76+MFI75 → WF=62.5%
  { strategyId: 94, coin: 'ETH' }, // ETH GH+ADX<20+RSI76+MFI75 → WF=63.6%
  { strategyId: 95, coin: 'SOL' }, // SOL TightGH[12,13]+ADX<20+RSI70+MFI68 → WF=80.0% n=44 🔥🔥🔥
  { strategyId: 95, coin: 'ETH' }, // ETH TightGH[12,21]+ADX<20+RSI70+MFI68 → WF=71.4% n=46 🔥🔥
  { strategyId: 95, coin: 'BTC' }, // BTC TightGH[12,13,21]+ADX<20+RSI70+MFI68 → ~70% 🔥
  { strategyId: 96, coin: 'BTC' }, // BTC GH+ADX<20+RSI3>93+BB22 → WF=75.0% n=92 🔥🔥🔥 best vol!
  { strategyId: 96, coin: 'XRP' }, // XRP GH+ADX<20+RSI3>93+BB22 → WF=66.7% 🔥
  // Session 14: triple RSI + WPR + CRSI+MFI + BB(20,2.0) (session14_highwr.js)
  { strategyId: 97, coin: 'BTC' }, // BTC triple RSI cascade → WF=85.7% n=32 🔥🔥🔥 BEST BTC WR!
  { strategyId: 97, coin: 'XRP' }, // XRP triple RSI cascade → WF=75.0% n=26 🔥🔥🔥 >75%!
  { strategyId: 97, coin: 'SOL' }, // SOL triple RSI cascade → BTC-validated pattern 🔥
  { strategyId: 97, coin: 'ETH' }, // ETH triple RSI cascade → BTC-validated pattern 🔥
  { strategyId: 98, coin: 'BTC' }, // BTC WPR>-8+RSI73+MFI72 → WF=77.8% n=26 🔥🔥🔥 >75%!
  { strategyId: 98, coin: 'ETH' }, // ETH WPR+RSI73+MFI72 → WF=71.4% n=16 🔥🔥
  { strategyId: 98, coin: 'SOL' }, // SOL WPR+RSI73+MFI72 → BTC-validated pattern 🔥
  { strategyId: 99, coin: 'BTC' }, // BTC CRSI>85+MFI72 → WF=77.8% n=42 best volume! 🔥🔥🔥
  { strategyId: 99, coin: 'XRP' }, // XRP CRSI>85+MFI72 → applied from BTC pattern 🔥
  { strategyId: 99, coin: 'SOL' }, // SOL CRSI>85+MFI72 → applied from BTC pattern 🔥
  { strategyId: 99, coin: 'ETH' }, // ETH CRSI>85+MFI72 → applied from BTC pattern 🔥
  { strategyId: 100, coin: 'BTC' }, // BTC BB(20,2.0)+RSI73+MFI72+RSI14 → WF=80.0% n=27 🔥🔥🔥 >75%!
  { strategyId: 100, coin: 'ETH' }, // ETH BB(20,2.0)+RSI73+MFI72+RSI14 → BTC-validated pattern 🔥
  // Session 15: BB(1.8) × RSI3 extreme + BB(1.0) triple confirm (session15_highvol_highwr.js)
  { strategyId: 105, coin: 'ETH' }, // ETH BB(1.8)+RSI3>90+MFI70 → WF=75.0% n=110 🔥🔥🔥 FIRST ETH >75%!
  { strategyId: 105, coin: 'BTC' }, // BTC BB(1.8)+RSI3>90+MFI70 → ETH=75.0% validated pattern 🔥
  { strategyId: 105, coin: 'SOL' }, // SOL BB(1.8)+RSI3>90+MFI70 → ETH-validated pattern 🔥
  { strategyId: 105, coin: 'XRP' }, // XRP BB(1.8)+RSI3>90+MFI70 → ETH-validated pattern 🔥
  { strategyId: 106, coin: 'BTC' }, // BTC BB(1.0)+RSI73+MFI72+RSI14 → WF=78.9% n=70 🔥🔥🔥 >75%!
  { strategyId: 106, coin: 'ETH' }, // ETH BB(1.0)+RSI73+MFI72+RSI14 → BTC-validated pattern 🔥
  // Session 16: 4h ADX filter + RSI3>95 ultra-extreme (session16_research.js H3/D2/D3)
  { strategyId: 107, coin: 'BTC' }, // BTC 4hADX+RSI3>93 → 70.5% n=44 — borderline, display only
  { strategyId: 107, coin: 'ETH' }, // ETH 4hADX+RSI3>93 → 74.5% n=47 — near-threshold
  { strategyId: 108, coin: 'XRP' }, // XRP RSI3>95+BB22 → WF=80.0% n=20 🔥🔥🔥 >75%!
  { strategyId: 109, coin: 'XRP' }, // XRP RSI3>95+BB18 → WF=77.3% n=22 🔥🔥🔥 >75%!
  // Session 16: StochRSI-K extreme (session16_vol_wr_balance.js G3/G4)
  { strategyId: 110, coin: 'BTC' }, // BTC StochK>85+MFI72+RSI14+BB22 → WF=80.0% n=44 🔥🔥🔥 >75%!
  { strategyId: 110, coin: 'XRP' }, // XRP StochK>85+MFI72+RSI14+BB22 → WF=80.0% n=37 🔥🔥🔥 >75%!
  { strategyId: 111, coin: 'BTC' }, // BTC StochK>85+MFI72+RSI14+BB18 → WF=81.8% n=60 🔥🔥🔥 >75%!
];

export function initStrategyConfigDb(): void {
  const db = getDb();
  db.exec(CREATE_TABLE);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO strategy_configs (id, strategy_id, coin, enabled, trade_size)
    VALUES (?, ?, ?, 0, 50)
  `);
  for (const { strategyId, coin } of DEFAULT_CONFIGS) {
    insert.run(`strat_${strategyId}_${coin}`, strategyId, coin);
  }
}

// ─────────────────── Functions ───────────────────

export function getStrategyConfigs(): StrategyConfig[] {
  initStrategyConfigDb();
  const db = getDb();
  const rows = db.prepare('SELECT * FROM strategy_configs ORDER BY strategy_id, coin').all() as Array<{
    id: string; strategy_id: number; coin: string; enabled: number; trade_size: number;
  }>;
  return rows.map(r => ({
    id: r.id,
    strategyId: r.strategy_id,
    coin: r.coin,
    enabled: r.enabled === 1,
    tradeSize: r.trade_size,
  }));
}

export function getStrategyConfig(strategyId: number, coin: string): StrategyConfig | null {
  initStrategyConfigDb();
  const db = getDb();
  const row = db.prepare('SELECT * FROM strategy_configs WHERE strategy_id = ? AND coin = ?').get(strategyId, coin) as {
    id: string; strategy_id: number; coin: string; enabled: number; trade_size: number;
  } | undefined;
  if (!row) return null;
  return { id: row.id, strategyId: row.strategy_id, coin: row.coin, enabled: row.enabled === 1, tradeSize: row.trade_size };
}

export function setStrategyEnabled(strategyId: number, coin: string, enabled: boolean): void {
  initStrategyConfigDb();
  const db = getDb();
  // Upsert: create row if it doesn't exist (for strategies added after initial DB creation)
  db.prepare(`
    INSERT INTO strategy_configs (id, strategy_id, coin, enabled, trade_size)
    VALUES (?, ?, ?, ?, 50)
    ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled
  `).run(`strat_${strategyId}_${coin}`, strategyId, coin, enabled ? 1 : 0);
}

// ─────────────────── App Settings ───────────────────

const CREATE_SETTINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`;

export interface TradeSizeSettings {
  type: 'fixed' | 'percent';
  value: number;
}

export function initSettingsDb(): void {
  const db = getDb();
  db.exec(CREATE_SETTINGS_TABLE);
  const ins = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  ins.run('trade_size_type', 'fixed');
  ins.run('trade_size_value', '50');
}

export function getAppSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getTradeSizeSettings(): TradeSizeSettings {
  return {
    type: (getAppSetting('trade_size_type') ?? 'fixed') as 'fixed' | 'percent',
    value: parseFloat(getAppSetting('trade_size_value') ?? '50'),
  };
}

export function getMinConfidence(): number {
  return parseInt(getAppSetting('min_confidence') ?? '65', 10);
}

export function setMinConfidence(value: number): void {
  setAppSetting('min_confidence', String(Math.round(value)));
}

/** Compute actual dollar trade size based on current settings and balance */
export function computeTradeSize(): number {
  const { type, value } = getTradeSizeSettings();
  if (type === 'fixed') return Math.max(1, value);
  // percent of current balance
  const balance = getPnlSummary().balance;
  const size = Math.max(1, (value / 100) * balance);
  return Math.round(size * 100) / 100;
}
