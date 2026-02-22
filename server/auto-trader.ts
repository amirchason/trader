import { getBinanceCandles } from './prices';
import { scoreStrategies, scoreSolStrategies, scoreXrpStrategies } from './indicators';
import { openTrade, getOpenPositions, PaperTrade } from './paper-trading';
import { getStrategyConfig, computeTradeSize, getMinConfidence } from './strategy-config';
import type { Candle, BinaryMarket, StrategyResult, FundingData, BinanceOrderBook } from './types';

// ─────────────────── Constants ───────────────────

const SCORE_THRESHOLD = 6;

const TOP_STRATEGIES = [
  { strategyId: 18, nameSubstr: 'RSI Panic',      coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 15, nameSubstr: 'Good Hours',      coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 16, nameSubstr: 'Synth15m',        coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 17, nameSubstr: 'Daily Range',     coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 13, nameSubstr: 'Balanced BB',     coins: ['ETH'],         interval: '5m' as const },
  { strategyId: 14, nameSubstr: 'Recovery Rally',  coins: ['ETH', 'BTC'], interval: '15m' as const },
  { strategyId: 12, nameSubstr: 'MFI',             coins: ['BTC'],         interval: '15m' as const },
  { strategyId: 10, nameSubstr: 'Keltner',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 9,  nameSubstr: 'Markov',          coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 19, nameSubstr: 'SOL Good Hours',       coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 20, nameSubstr: 'XRP Good Hours',       coins: ['XRP'],  interval: '5m' as const },
  // New ETH strategies (21-25) — Session 4 ML-optimized
  { strategyId: 21, nameSubstr: 'DoW Reversion',        coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 22, nameSubstr: 'EMA50 Extension',      coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 23, nameSubstr: 'RSI Bidir Exhaustion', coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 24, nameSubstr: 'ETH 15m MFI',          coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 25, nameSubstr: 'RSI Bear Streak',      coins: ['ETH'],  interval: '5m' as const },
  // New SOL strategies (26-30) — Session 4 ML-optimized
  { strategyId: 26, nameSubstr: 'SOL DoW Reversion',    coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 27, nameSubstr: 'SOL Pattern Exhaustion', coins: ['SOL'], interval: '5m' as const },
  { strategyId: 28, nameSubstr: 'SOL Tight BB',         coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 29, nameSubstr: 'SOL Panic Body',       coins: ['SOL'],  interval: '5m' as const },
  { strategyId: 30, nameSubstr: 'SOL EMA Extension',    coins: ['SOL'],  interval: '5m' as const },
  // New ETH strategies (31-32, 35) — Session 5 (best ever WR)
  { strategyId: 31, nameSubstr: 'ETH Synth-15m RSI Panic', coins: ['ETH'], interval: '5m' as const },
  { strategyId: 32, nameSubstr: 'ETH 15m Discovery',    coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 35, nameSubstr: 'ETH Tight BB Zone',    coins: ['ETH'],  interval: '5m' as const },
  // New SOL strategies (33-34) — Session 5 (ultra stable)
  { strategyId: 33, nameSubstr: 'SOL Daily Range Extreme', coins: ['SOL'], interval: '5m' as const },
  { strategyId: 34, nameSubstr: 'SOL Low-ATR BB',       coins: ['SOL'],  interval: '5m' as const },
  // New ETH/15m strategies (36-38) — Session 6 Wave 3 (ultra stable 73-78% WR)
  { strategyId: 36, nameSubstr: 'ETH 15m Body RSI7',    coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 37, nameSubstr: 'ETH 15m MFI Confirm',  coins: ['ETH'],  interval: '5m' as const },
  { strategyId: 38, nameSubstr: 'ETH 15m ATR Panic',    coins: ['ETH'],  interval: '5m' as const },
  // New XRP strategies (39-40) — Session 6 validated (near-perfect stability)
  { strategyId: 39, nameSubstr: 'XRP MFI75 Exhaustion', coins: ['XRP'],  interval: '5m' as const },
  { strategyId: 40, nameSubstr: 'XRP BB15 Reversion',   coins: ['XRP'],  interval: '5m' as const },
  // Strategy 41: Saturday BB — BTC WF=69.1%, also valid for ETH Saturday
  { strategyId: 41, nameSubstr: 'Saturday BB Reversion', coins: ['BTC', 'ETH'], interval: '5m' as const },
  // Strategy 42: SOL RSI Streak BB — ULTRA STABLE WF=67.1% σ=2.9% (paramOptimize)
  { strategyId: 42, nameSubstr: 'SOL RSI Streak BB',     coins: ['SOL'],         interval: '5m' as const },
  // BTC 5m strategies (43-46) — BTC h=[1,12,13,16,20] is strongly mean-reverting above BB
  { strategyId: 43, nameSubstr: 'BTC MFI BB',            coins: ['BTC'],         interval: '5m' as const },
  { strategyId: 44, nameSubstr: 'BTC RSI BB',            coins: ['BTC'],         interval: '5m' as const },
  { strategyId: 45, nameSubstr: 'BTC GH BB Streak',      coins: ['BTC'],         interval: '5m' as const },
  { strategyId: 46, nameSubstr: 'BTC RSI70 BB',          coins: ['BTC'],         interval: '5m' as const },
  // All-Hours High-Frequency strategies (56-58) — no hour filter, 2-5 trades/day, 75-76% WR
  { strategyId: 56, nameSubstr: 'ALL-H RSI Panic BB',    coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 57, nameSubstr: 'ALL-H MFI80 BB',        coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 58, nameSubstr: 'ALL-H MFI85 BB',        coins: ['ETH', 'BTC'], interval: '5m' as const },
  // SOL All-Hours HF (59-60) — 4.8-7.2 trades/day, 73% WR ULTRA STABLE
  { strategyId: 59, nameSubstr: 'SOL ALL-H RSI Panic',   coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 60, nameSubstr: 'SOL ALL-H RSI7 Panic',  coins: ['SOL'],        interval: '5m' as const },
  // BTC Synth-15m (61-62) — HIGHEST WR 86.3%
  { strategyId: 61, nameSubstr: 'BTC Synth15m GH RSI',   coins: ['BTC'],        interval: '5m' as const },
  { strategyId: 62, nameSubstr: 'BTC Synth15m ALL-H RSI',coins: ['BTC'],        interval: '5m' as const },
  // Enhanced all-hours (64-65) — ULTRA STABLE σ<3%
  { strategyId: 64, nameSubstr: 'ALL-H Dual RSI+MFI BB', coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 65, nameSubstr: 'ALL-H RSI Dev Filter BB', coins: ['ETH', 'BTC'], interval: '5m' as const },
  // BTC GoodH body filter (66) — WF=79.2% σ=2.6% ULTRA STABLE
  { strategyId: 66, nameSubstr: 'BTC GH Body RSI BB',    coins: ['BTC'],        interval: '5m' as const },
  // Ultra High-Frequency Testing Strategy (67) — BB(20,1.8) 40+/day
  { strategyId: 67, nameSubstr: 'ALL-H BB18 HF',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 67, nameSubstr: 'SOL ALL-H BB18 HF',     coins: ['SOL'],        interval: '5m' as const },
  // Ultra High-Frequency 80+ Strategy (68) — BB(20,1.0) 100+/day
  { strategyId: 68, nameSubstr: 'ALL-H BB10 UHF80',      coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 68, nameSubstr: 'SOL ALL-H BB10 UHF80',  coins: ['SOL'],        interval: '5m' as const },
  // ML-Optimized Stochastic+BB (69) — NOTE: WR was inflated; real ~54% (diversity only)
  { strategyId: 69, nameSubstr: 'Stoch+BB10 HF80',       coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 69, nameSubstr: 'SOL Stoch+BB10 HF80',   coins: ['SOL'],        interval: '5m' as const },
  // h=12 Noon Peak BB(20,1.5) (70) — CORRECT at-expiry binary exit validated
  { strategyId: 70, nameSubstr: 'Noon Peak BB15',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 70, nameSubstr: 'SOL Noon Peak BB15',     coins: ['SOL'],        interval: '5m' as const },
  // ALL-H Pure BB(20,2.2)+s>=1 (71) — TRUE binary exit: 5m=56% + 15m=55% WR, 122/day combined ✅
  { strategyId: 71, nameSubstr: 'HF BB22 Pure',           coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 71, nameSubstr: 'SOL HF BB22 Pure',       coins: ['SOL'],        interval: '5m' as const },
  // Connors RSI (15/85) (72) — TradingView mean-reversion: ETH=56.3% BTC=54.9% SOL=52.7% XRP=52.8% @33/day
  { strategyId: 72, nameSubstr: 'Connors RSI 15/85',      coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 72, nameSubstr: 'SOL Connors RSI 15/85',  coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 72, nameSubstr: 'XRP Connors RSI 15/85',  coins: ['XRP'],        interval: '5m' as const },
  // ATR Climax BB22 + RSI7 (73) — Exhaustion reversal: ETH=57.3% BTC=57.8% SOL=55.1% XRP=54.9% @10/day
  { strategyId: 73, nameSubstr: 'ATR Climax BB22',        coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 73, nameSubstr: 'SOL ATR Climax BB22',    coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 73, nameSubstr: 'XRP ATR Climax BB22',    coins: ['XRP'],        interval: '5m' as const },
  // StochRSI (K+D<20) + BB22 (74) — Double oscillator: ETH=58.4% BTC=57.7% SOL=52.1% XRP=54.1% @13/day
  { strategyId: 74, nameSubstr: 'StochRSI+BB22',          coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 74, nameSubstr: 'SOL StochRSI+BB22',      coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 74, nameSubstr: 'XRP StochRSI+BB22',      coins: ['XRP'],        interval: '5m' as const },
  // CCI>200 + BB22 (75)
  { strategyId: 75, nameSubstr: 'CCI>200 BB22',           coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 75, nameSubstr: 'SOL CCI>200 BB22',       coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 75, nameSubstr: 'XRP CCI>200 BB22',       coins: ['XRP'],        interval: '5m' as const },
  // Williams %R + RSI7 + BB22 (76)
  { strategyId: 76, nameSubstr: 'WPR+RSI7+BB22',          coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 76, nameSubstr: 'SOL WPR+RSI7+BB22',      coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 76, nameSubstr: 'XRP WPR+RSI7+BB22',      coins: ['XRP'],        interval: '5m' as const },
  // Keltner Outer (77)
  { strategyId: 77, nameSubstr: 'Keltner Outer',          coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 77, nameSubstr: 'SOL Keltner Outer',      coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 77, nameSubstr: 'XRP Keltner Outer',      coins: ['XRP'],        interval: '5m' as const },
  // 1m RSI7 Extreme + BB22 (78) — hfBinary5m S6: ETH=58.0% BTC=57.1% SOL=54.8% XRP=54.2% WR ✅
  { strategyId: 78, nameSubstr: '1m RSI7+BB22',           coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 78, nameSubstr: 'SOL RSI7+BB22',          coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 78, nameSubstr: 'XRP RSI7+BB22',          coins: ['XRP'],        interval: '5m' as const },
  // Volume Exhaustion + BB22 + Streak (79) — hfBinary5m S2: ETH=58.1% BTC=60.5% XRP=57.1% ✅
  { strategyId: 79, nameSubstr: 'Vol Exhaustion BB22',    coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 79, nameSubstr: 'SOL Vol Exhaustion BB22',coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 79, nameSubstr: 'XRP Vol Exhaustion BB22',coins: ['XRP'],        interval: '5m' as const },
  // MicroStreak×3 + BB22 + RSI14 (80) — hfBinary5m S5: ETH=58.4% BTC=60.9% SOL=57.4% ✅
  { strategyId: 80, nameSubstr: 'MicroStreak×3 BB22',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 80, nameSubstr: 'SOL MicroStreak×3 BB22', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 80, nameSubstr: 'XRP MicroStreak×3 BB22', coins: ['XRP'],        interval: '5m' as const },
  // ML-Synthesized 15m Streak + BB22 (81) — ML top features: BTC=72.7% ETH=63.5% SOL=64.8% ✅
  { strategyId: 81, nameSubstr: 'ML 15m-Streak+BB22',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 81, nameSubstr: 'SOL ML 15m-Streak+BB22', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 81, nameSubstr: 'XRP ML 15m-Streak+BB22', coins: ['XRP'],        interval: '5m' as const },
  // Session 11: BB %B + RSI7 (82) — ETH=58.3% BTC=58.2% avg=56.3% WR ~2/day ✅✅
  { strategyId: 82, nameSubstr: 'BB%B+RSI7',              coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 82, nameSubstr: 'SOL BB%B+RSI7',          coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 82, nameSubstr: 'XRP BB%B+RSI7',          coins: ['XRP'],        interval: '5m' as const },
  // Session 11: RSI(3)>90 + BB22 (83) — ETH=59.3% avg=55.9% WR ~2/day ✅✅
  { strategyId: 83, nameSubstr: 'RSI3>90+BB22',           coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 83, nameSubstr: 'SOL RSI3>90+BB22',       coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 83, nameSubstr: 'XRP RSI3>90+BB22',       coins: ['XRP'],        interval: '5m' as const },
  // Session 11: RSI7 Consec2 + BB22 (84) — ETH=58.1% BTC=56.3% avg=55.5% WR ~2/day ✅
  { strategyId: 84, nameSubstr: 'RSI7 Consec2+BB22',      coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 84, nameSubstr: 'SOL RSI7 Consec2+BB22',  coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 84, nameSubstr: 'XRP RSI7 Consec2+BB22',  coins: ['XRP'],        interval: '5m' as const },
  // Session 11: EMA20 Dev + RSI7 + BB22 (85) — ETH=57% BTC=57% avg=55.6% WR ~1.7/day ✅
  { strategyId: 85, nameSubstr: 'EMA20Dev+RSI7+BB22',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 85, nameSubstr: 'SOL EMA20Dev+RSI7+BB22', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 85, nameSubstr: 'XRP EMA20Dev+RSI7+BB22', coins: ['XRP'],        interval: '5m' as const },
  // Session 11: BB%B + CCI + WPR Triple (86) — ETH=56.1% BTC=57.5% avg=55.2% WR ~3/day ✅ best volume
  { strategyId: 86, nameSubstr: 'BB%B+CCI+WPR',           coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 86, nameSubstr: 'SOL BB%B+CCI+WPR',       coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 86, nameSubstr: 'XRP BB%B+CCI+WPR',       coins: ['XRP'],        interval: '5m' as const },
  // Session 12: Advanced confluence patterns (session12_research.js)
  { strategyId: 87, nameSubstr: 'DoubleRSI+BB22',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 87, nameSubstr: 'SOL DoubleRSI+BB22',     coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 87, nameSubstr: 'XRP DoubleRSI+BB22',     coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 88, nameSubstr: 'BB Squeeze→Release',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 88, nameSubstr: 'SOL BB Squeeze→Release', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 88, nameSubstr: 'XRP BB Squeeze→Release', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 89, nameSubstr: 'WideRange+BB22',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 89, nameSubstr: 'SOL WideRange+BB22',     coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 89, nameSubstr: 'XRP WideRange+BB22',     coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 90, nameSubstr: 'ADX<20+BB22',            coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 90, nameSubstr: 'SOL ADX<20+BB22',        coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 90, nameSubstr: 'XRP ADX<20+BB22',        coins: ['XRP'],        interval: '5m' as const },
  // Session 12 High-WR: Good Hours ultra-selective (session12_highwr.js)
  { strategyId: 91, nameSubstr: 'GH+CRSI85+BB22',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 92, nameSubstr: 'GH+ADX20+RSI73+MFI72',  coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 92, nameSubstr: 'XRP GH+ADX20+RSI73+MFI72', coins: ['XRP'],     interval: '5m' as const },
  // Session 13 High-WR: >75% WR strategies (session13_highwr.js)
  { strategyId: 93, nameSubstr: 'GH+ADX20+RSI73+MFI72+RSI14',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 93, nameSubstr: 'SOL GH+ADX20+RSI73+MFI72+RSI14', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 93, nameSubstr: 'XRP GH+ADX20+RSI73+MFI72+RSI14', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 94, nameSubstr: 'GH+ADX20+RSI76+MFI75',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 94, nameSubstr: 'SOL GH+ADX20+RSI76+MFI75', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 94, nameSubstr: 'XRP GH+ADX20+RSI76+MFI75', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 95, nameSubstr: 'TightGH+ADX20+RSI70+MFI68',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 95, nameSubstr: 'SOL TightGH+ADX20+RSI70+MFI68', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 96, nameSubstr: 'GH+ADX20+RSI3_93+BB22',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 96, nameSubstr: 'XRP GH+ADX20+RSI3_93+BB22', coins: ['XRP'],        interval: '5m' as const },
  // Session 14 High-WR: triple RSI cascade + WPR + ConnorsRSI+MFI + BB(20,2.0) (session14_highwr.js)
  { strategyId: 97, nameSubstr: 'GH+ADX20+RSI3_93+RSI5_82+MFI70',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 97, nameSubstr: 'SOL GH+ADX20+RSI3_93+RSI5_82+MFI70', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 97, nameSubstr: 'XRP GH+ADX20+RSI3_93+RSI5_82+MFI70', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 98, nameSubstr: 'GH+ADX20+WPR_8+RSI73+MFI72',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 98, nameSubstr: 'SOL GH+ADX20+WPR_8+RSI73+MFI72', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 99, nameSubstr: 'GH+ADX20+CRSI85+MFI72',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 99, nameSubstr: 'SOL GH+ADX20+CRSI85+MFI72', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 99, nameSubstr: 'XRP GH+ADX20+CRSI85+MFI72', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 100, nameSubstr: 'GH+BB20_2.0+RSI73+MFI72+RSI14', coins: ['ETH', 'BTC'], interval: '5m' as const },
  // Session 13: 1m sub-candle + 1h ranging regime (session13_5s_mtf_research.js)
  { strategyId: 101, nameSubstr: '1mVolClimaxBB22',             coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 101, nameSubstr: 'SOL 1mVolClimaxBB22',         coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 101, nameSubstr: 'XRP 1mVolClimaxBB22',         coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 102, nameSubstr: '1hRanging+BB22+Streak',       coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 102, nameSubstr: 'SOL 1hRanging+BB22+Streak',   coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 102, nameSubstr: 'XRP 1hRanging+BB22+Streak',   coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 103, nameSubstr: '1mMomentumFade+BB22',         coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 103, nameSubstr: 'SOL 1mMomentumFade+BB22',     coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 103, nameSubstr: 'XRP 1mMomentumFade+BB22',     coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 104, nameSubstr: '1mVolSpike+1hRange+BB22',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 104, nameSubstr: 'SOL 1mVolSpike+1hRange+BB22', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 104, nameSubstr: 'XRP 1mVolSpike+1hRange+BB22', coins: ['XRP'],        interval: '5m' as const },
  // Session 15: BB(1.8) × RSI3 extreme + BB(1.0) triple confirm (session15_highvol_highwr.js)
  { strategyId: 105, nameSubstr: 'GH+ADX20+RSI3_90+MFI70+BB18',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 105, nameSubstr: 'SOL GH+ADX20+RSI3_90+MFI70+BB18', coins: ['SOL'],        interval: '5m' as const },
  { strategyId: 105, nameSubstr: 'XRP GH+ADX20+RSI3_90+MFI70+BB18', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 106, nameSubstr: 'GH+ADX20+RSI73+MFI72+RSI14+BB10', coins: ['ETH', 'BTC'], interval: '5m' as const },
  // Session 16: 4h regime filter + ultra-extreme RSI3>95 (session16_research.js)
  { strategyId: 107, nameSubstr: 'GH+4hADX20+RSI3_93+MFI70+BB22',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 107, nameSubstr: 'XRP GH+4hADX20+RSI3_93+MFI70+BB22', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 108, nameSubstr: 'GH+ADX20+RSI3_95+MFI70+BB22',        coins: ['BTC'],        interval: '5m' as const },
  { strategyId: 108, nameSubstr: 'XRP GH+ADX20+RSI3_95+MFI70+BB22',    coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 109, nameSubstr: 'GH+ADX20+RSI3_95+MFI70+BB18',        coins: ['BTC'],        interval: '5m' as const },
  { strategyId: 109, nameSubstr: 'XRP GH+ADX20+RSI3_95+MFI70+BB18',    coins: ['XRP'],        interval: '5m' as const },
  // Session 16: StochRSI-K extreme + MFI + RSI14 at BB (session16_vol_wr_balance.js G3/G4)
  { strategyId: 110, nameSubstr: 'GH+ADX20+StochK85+MFI72+RSI14+BB22',     coins: ['BTC'],        interval: '5m' as const },
  { strategyId: 110, nameSubstr: 'XRP GH+ADX20+StochK85+MFI72+RSI14+BB22', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 111, nameSubstr: 'GH+ADX20+StochK85+MFI72+RSI14+BB18',     coins: ['BTC'],        interval: '5m' as const },
  // Session 17: G2 (quad-oscillator BB18), A4 (XRP RSI3+StochK), E2 (2-consec BB)
  { strategyId: 112, nameSubstr: 'GH+ADX20+RSI7_73+StochK80+MFI72+RSI14+BB18', coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 113, nameSubstr: 'XRP GH+ADX20+RSI3_93+StochK80+MFI70+BB22',   coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 114, nameSubstr: 'GH+ADX20+2ConsecBB22+RSI3_90+MFI68',          coins: ['BTC'],        interval: '5m' as const },
  // Session 18: BB%B>1.1 deep overshoot, StochK>90 ultra-extreme, XRP double-extreme
  { strategyId: 115, nameSubstr: 'GH+ADX20+BB%B1.1+RSI3_90+MFI70',               coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 116, nameSubstr: 'GH+ADX20+StochK90+MFI72+RSI14+BB22',            coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 116, nameSubstr: 'XRP GH+ADX20+StochK90+MFI72+RSI14+BB22',        coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 117, nameSubstr: 'XRP GH+ADX20+StochK90+RSI3_93+MFI72+BB22',      coins: ['XRP'],        interval: '5m' as const },
  // Session 19: triple RSI alignment (σ=2.9% ULTRA STABLE), triple RSI+MFI, ultra-high MFI+StochK
  { strategyId: 118, nameSubstr: 'GH+ADX20+RSI3_90+RSI7_72+RSI14+BB22',           coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 118, nameSubstr: 'XRP GH+ADX20+RSI3_90+RSI7_72+RSI14+BB22',       coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 119, nameSubstr: 'GH+ADX20+RSI3_90+RSI7_72+RSI14+MFI70+BB22',     coins: ['ETH', 'BTC'], interval: '5m' as const },
  { strategyId: 119, nameSubstr: 'XRP GH+ADX20+RSI3_90+RSI7_72+RSI14+MFI70+BB22', coins: ['XRP'],        interval: '5m' as const },
  { strategyId: 120, nameSubstr: 'GH+ADX20+MFI75+StochK80+RSI14+BB22',            coins: ['BTC'],        interval: '5m' as const },
  // Session 20: VWAP session-dev + RSI3 (new VWAP pattern, BTC only)
  { strategyId: 121, nameSubstr: 'GH+ADX20+VWAP_dev0.3%+RSI3_90+BB22',           coins: ['BTC'],        interval: '5m' as const },
];

const DEFAULT_FUNDING: FundingData = {
  current: 0, annualizedPct: 0, signal: 'neutral', strength: 'normal', history: [],
};

const DEFAULT_ORDERBOOK: BinanceOrderBook = {
  bids: [], asks: [], bidTotal: 0, askTotal: 0, ratio: 1, pressure: 'neutral',
};

// ─────────────────── ETH Data Fetch ───────────────────

export async function fetchEthData(): Promise<{
  signals: StrategyResult;
  candles5m: Candle[];
  candles15m: Candle[];
}> {
  const [candles5m, candles15m, candles1m, candles1h, candles4h] = await Promise.all([
    getBinanceCandles('ETHUSDT', '5m', 65),
    getBinanceCandles('ETHUSDT', '15m', 50),
    getBinanceCandles('ETHUSDT', '1m', 60),
    getBinanceCandles('ETHUSDT', '1h', 50),
    getBinanceCandles('ETHUSDT', '4h', 30),
  ]);
  const signals = scoreStrategies(candles5m, candles1m, DEFAULT_FUNDING, DEFAULT_ORDERBOOK, candles15m, candles1h, candles4h);
  return { signals, candles5m, candles15m };
}

export async function fetchEthSignals(): Promise<StrategyResult> {
  return (await fetchEthData()).signals;
}

// ─────────────────── SOL Data Fetch ───────────────────

export async function fetchSolData(): Promise<{
  signals: StrategyResult;
  candles5m: Candle[];
}> {
  const [candles5m, candles1m, candles1h, candles4h] = await Promise.all([
    getBinanceCandles('SOLUSDT', '5m', 65),
    getBinanceCandles('SOLUSDT', '1m', 60),
    getBinanceCandles('SOLUSDT', '1h', 50),
    getBinanceCandles('SOLUSDT', '4h', 30),
  ]);
  const signals = scoreSolStrategies(candles5m, candles1m, candles1h, candles4h);
  return { signals, candles5m };
}

export async function fetchSolSignals(): Promise<StrategyResult> {
  return (await fetchSolData()).signals;
}

// ─────────────────── XRP Data Fetch ───────────────────

export async function fetchXrpData(): Promise<{
  signals: StrategyResult;
  candles5m: Candle[];
}> {
  const [candles5m, candles1m, candles1h, candles4h] = await Promise.all([
    getBinanceCandles('XRPUSDT', '5m', 80),
    getBinanceCandles('XRPUSDT', '1m', 60),
    getBinanceCandles('XRPUSDT', '1h', 50),
    getBinanceCandles('XRPUSDT', '4h', 30),
  ]);
  const signals = scoreXrpStrategies(candles5m, candles1m, candles1h, candles4h);
  return { signals, candles5m };
}

export async function fetchXrpSignals(): Promise<StrategyResult> {
  return (await fetchXrpData()).signals;
}

// ─────────────────── Auto Trade Check ───────────────────

interface TradeCandidate {
  sig: { name: string; direction: string; confidence: number; score: number; signal: string };
  interval: '5m' | '15m';
  intervalM: 5 | 15;
  market: BinaryMarket | undefined;
  direction: 'YES' | 'NO';
  entryPrice: number;
  marketId: string;
  marketQ: string;
}

export function checkAndAutoTrade(
  coin: string,
  signals: StrategyResult,
  markets: BinaryMarket[],
  currentSpot?: number,
): PaperTrade[] {
  const placed: PaperTrade[] = [];

  const openPositions = getOpenPositions();

  // ── One-slot-per-interval guard ──
  // Build a set of coin+intervalM slots that already have an open trade.
  // A "slot" is occupied as long as the trade is still in OPEN status —
  // the paper-trading auto-closer will expire it when the binary resolves.
  const occupiedSlots = new Set(
    openPositions
      .filter(p => p.asset === coin)
      .map(p => `${p.asset}_${p.interval_m ?? 5}`)
  );

  // Strategy-level dupe guard: same strategy+coin can't open twice
  const dupeSet = new Set(openPositions.map(p => `${p.strategy ?? ''}_${p.asset}`));

  // ── Step 1: collect all valid candidates ──
  const candidates: TradeCandidate[] = [];

  for (const strat of TOP_STRATEGIES) {
    if (!strat.coins.includes(coin)) continue;

    const intervalM: 5 | 15 = strat.interval === '15m' ? 15 : 5;

    // Skip if this coin+interval slot is already occupied
    if (occupiedSlots.has(`${coin}_${intervalM}`)) continue;

    const sig = signals.strategies.find(s => s.name.includes(strat.nameSubstr));
    if (!sig) continue;

    const config = getStrategyConfig(strat.strategyId, coin);
    if (!config?.enabled) continue;

    if (sig.direction === 'neutral') continue;
    if (sig.confidence < getMinConfidence()) continue;
    if (sig.score < SCORE_THRESHOLD) continue;
    if (dupeSet.has(`${sig.name}_${coin}`)) continue;

    const market = markets.find(
      m => m.asset === coin && m.interval === strat.interval && m.active && !m.closed
    );
    const direction: 'YES' | 'NO' = sig.direction === 'bearish' ? 'NO' : 'YES';
    const entryPrice = market
      ? (direction === 'NO' ? market.noPrice : market.yesPrice)
      : 0.50;

    candidates.push({
      sig,
      interval: strat.interval,
      intervalM,
      market,
      direction,
      entryPrice,
      marketId: market?.conditionId ?? 'synthetic',
      marketQ: market?.question ?? `Auto-trade ${coin}/${strat.interval}`,
    });
  }

  // ── Step 2: one trade per coin per interval — pick highest-confidence ──
  // Group by intervalM, take the single best candidate per slot
  const bestBySlot = new Map<number, TradeCandidate>();
  for (const c of candidates) {
    const existing = bestBySlot.get(c.intervalM);
    if (!existing || c.sig.confidence > existing.sig.confidence) {
      bestBySlot.set(c.intervalM, c);
    }
  }
  const toOpen = [...bestBySlot.values()];

  if (candidates.length > 1) {
    console.log(
      `[AutoTrade] ${coin}: ${candidates.length} candidates → opening ${toOpen.length} best ` +
      toOpen.map(c => `${c.sig.name}(${c.sig.confidence}%)`).join(', ')
    );
  }

  // ── Step 3: open selected candidates ──
  for (const c of toOpen) {
    // Re-check slot in case two intervals resolve to the same slot mid-loop
    if (occupiedSlots.has(`${coin}_${c.intervalM}`)) continue;
    if (dupeSet.has(`${c.sig.name}_${coin}`)) continue;
    try {
      const trade = openTrade({
        market_id: c.marketId,
        market_q: c.marketQ,
        asset: coin,
        direction: c.direction,
        entry_price: c.entryPrice,
        size: computeTradeSize(),
        strategy: c.sig.name,
        confidence: c.sig.confidence,
        reason: `Auto: ${c.sig.signal}`,
        entry_spot: currentSpot,
        interval_m: c.intervalM,
        epoch_end: c.market?.epochEnd ?? undefined,
      });
      placed.push(trade);
      occupiedSlots.add(`${coin}_${c.intervalM}`);
      dupeSet.add(`${c.sig.name}_${coin}`);
      console.log(`[AutoTrade] ${coin} ${c.sig.name} → ${c.direction} @ ${c.entryPrice.toFixed(3)} (conf=${c.sig.confidence}%)`);
    } catch (e) {
      console.error('[AutoTrade] openTrade error:', e);
    }
  }

  return placed;
}
