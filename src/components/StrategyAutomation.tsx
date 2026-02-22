import { useEffect, useState, useRef } from 'react';
import { Zap } from 'lucide-react';
import { useStore } from '../store';
import { fetchStrategyConfigs, setStrategyEnabled, fetchTradeSizeSettings, saveTradeSizeSettings, fetchMinConfidence, saveMinConfidence } from '../services/api';

// Lookup table: confidence → estimated WR and trades/day (from 6-month backtest data)
const CONF_TABLE = [
  { conf: 90, wr: 0.79, tpd: 0.5 },
  { conf: 85, wr: 0.77, tpd: 1   },
  { conf: 75, wr: 0.73, tpd: 2   },
  { conf: 65, wr: 0.68, tpd: 4   },
  { conf: 55, wr: 0.62, tpd: 8   },
  { conf: 48, wr: 0.58, tpd: 14  },
  { conf: 42, wr: 0.55, tpd: 20  },
  { conf: 35, wr: 0.52, tpd: 30  },
  { conf: 30, wr: 0.50, tpd: 40  },
];

function interpConf(conf: number): { wr: number; tpd: number } {
  if (conf >= CONF_TABLE[0].conf) return CONF_TABLE[0];
  if (conf <= CONF_TABLE[CONF_TABLE.length - 1].conf) return CONF_TABLE[CONF_TABLE.length - 1];
  for (let i = 0; i < CONF_TABLE.length - 1; i++) {
    const hi = CONF_TABLE[i], lo = CONF_TABLE[i + 1];
    if (conf <= hi.conf && conf >= lo.conf) {
      const t = (conf - lo.conf) / (hi.conf - lo.conf);
      return { wr: lo.wr + t * (hi.wr - lo.wr), tpd: lo.tpd + t * (hi.tpd - lo.tpd) };
    }
  }
  return CONF_TABLE[Math.floor(CONF_TABLE.length / 2)];
}

// Per-strategy stats: tpd = avg trades/day per coin, wrNum = avg WR, coinWr = per-coin WR overrides
// Sources: 6-month walk-forward backtest data (T = total trades over period)
const STRAT_STATS: Record<number, { tpd: number; wrNum: number; coinWr?: Record<string, number> }> = {
  // ── Tier 1 ETH ──
  18: { tpd: 0.67, wrNum: 0.711 }, // T=121/6mo
  16: { tpd: 0.57, wrNum: 0.731 }, // T=102/6mo
  17: { tpd: 0.44, wrNum: 0.734 }, // T=79/6mo
  15: { tpd: 0.70, wrNum: 0.698 }, // T=126/6mo
  13: { tpd: 0.80, wrNum: 0.671 }, // T=303/6mo with dev[0.05-0.25%] filter
  // ── Tier 2 Cross-coin ──
  14: { tpd: 0.17, wrNum: 0.759 }, // T≈29 ETH + 33 BTC / 6mo (sniper) — WRs similar
  12: { tpd: 0.79, wrNum: 0.704 }, // T=142/6mo BTC/15m
  // ── Tier 3 ──
  10: { tpd: 0.45, wrNum: 0.710 }, // dual-band = rare, est.
  11: { tpd: 0.40, wrNum: 0.674 }, // ETH/15m vol spike
   9: { tpd: 0.50, wrNum: 0.680 }, // GGG+BB, moderate
  // ── SOL ──
  19: { tpd: 1.26, wrNum: 0.687 }, // T=226/6mo
  // ── XRP ──
  20: { tpd: 1.07, wrNum: 0.667 }, // T=192/6mo
  // ── Session 4 ETH ML ──
  21: { tpd: 0.30, wrNum: 0.705 }, // Wed+Sat only (2/7 days) + hour filter
  22: { tpd: 1.60, wrNum: 0.659 }, // EMA50 ext — HIGH FREQ (from desc)
  23: { tpd: 0.80, wrNum: 0.660 }, // bidir RSI+GoodH
  24: { tpd: 0.50, wrNum: 0.682 }, // synth-15m MFI, moderate
  25: { tpd: 0.60, wrNum: 0.696 }, // RSI+streak, stable
  // ── Session 4 SOL ML ──
  26: { tpd: 0.40, wrNum: 0.774 }, // Tue/Wed/Thu only (3/7 days)
  27: { tpd: 0.50, wrNum: 0.690 }, // GG/RR patterns
  28: { tpd: 1.00, wrNum: 0.709 }, // Tight BB — HIGH FREQ (from desc)
  29: { tpd: 0.50, wrNum: 0.694 }, // body filter
  30: { tpd: 0.40, wrNum: 0.682 }, // EMA dist
  // ── Session 5 ETH ──
  31: { tpd: 0.30, wrNum: 0.800 }, // triple-filter sniper
  32: { tpd: 0.40, wrNum: 0.753 }, // h=[7,12,20]+RSI, stable
  35: { tpd: 0.40, wrNum: 0.718 }, // narrow dev zone
  // ── Session 5 SOL ──
  33: { tpd: 0.40, wrNum: 0.727 }, // daily range + GoodH
  34: { tpd: 0.50, wrNum: 0.716 }, // low-vol only (~50% of bars)
  // ── Session 6 ETH/15m Wave 3 ──
  36: { tpd: 0.40, wrNum: 0.732 }, // body+RSI7+s≥2 tight
  37: { tpd: 0.40, wrNum: 0.767 }, // MFI+s≥2 stable
  38: { tpd: 0.30, wrNum: 0.776 }, // body/ATR+RSI7 — most filters
  // ── Session 6 XRP ──
  39: { tpd: 0.60, wrNum: 0.673 }, // MFI>75 tight
  40: { tpd: 1.00, wrNum: 0.681 }, // BB15 wide, high-volume
  41: { tpd: 0.20, wrNum: 0.691 }, // Saturday only (1/7 days) — BTC=69.1% ETH≈similar
  42: { tpd: 0.50, wrNum: 0.671 }, // SOL RSI Streak, stable
  // ── BTC 5m ──
  43: { tpd: 0.50, wrNum: 0.816 }, // MFI+BB+5 good hours, ultra stable
  44: { tpd: 1.20, wrNum: 0.805 }, // T=221 over period, ~1.2/day
  45: { tpd: 1.70, wrNum: 0.797 }, // HIGH FREQ ~1.7/day (from desc, T=310/yr)
  46: { tpd: 0.90, wrNum: 0.831 }, // T=161 over period
  // ── Session 7 ALL-H HF (added to STRAT_STATS for accurate tpd) ──
  56: { tpd: 5.1, wrNum: 0.757, coinWr: { ETH: 0.761, BTC: 0.752 } }, // ETH=76.1% BTC=75.2%
  57: { tpd: 4.2, wrNum: 0.757 }, // ETH≈BTC≈75.7%
  58: { tpd: 2.8, wrNum: 0.763 }, // ETH≈BTC≈76.3%
  59: { tpd: 4.8, wrNum: 0.730 }, // SOL ALL-H RSI Panic 73.0%
  60: { tpd: 7.2, wrNum: 0.732 }, // SOL ALL-H RSI7 73.2%
  61: { tpd: 1.2, wrNum: 0.863 }, // BTC Synth15m GH RSI 86.3%
  62: { tpd: 1.8, wrNum: 0.770 }, // BTC Synth15m ALL-H RSI 77.0%
  64: { tpd: 4.4, wrNum: 0.764 }, // ETH≈BTC≈76.4% dual RSI+MFI
  65: { tpd: 3.2, wrNum: 0.778 }, // ETH≈BTC≈77.8% dev filter
  66: { tpd: 1.5, wrNum: 0.792 }, // BTC GH Body RSI BB 79.2%
  // ── HF Strategies — correct single-candle Polymarket exit (not 3-candle touch) ──
  67: { tpd: 42,  wrNum: 0.540, coinWr: { ETH: 0.554, BTC: 0.543, SOL: 0.522 } }, // BB(20,1.8)+s>=1
  68: { tpd: 106, wrNum: 0.526, coinWr: { ETH: 0.537, BTC: 0.525, SOL: 0.515 } }, // BB(20,1.0)+s>=1
  69: { tpd: 40,  wrNum: 0.540, coinWr: { ETH: 0.540, BTC: 0.540, SOL: 0.540 } }, // Stoch+BB10 ~54% all
  70: { tpd: 2.8, wrNum: 0.632, coinWr: { ETH: 0.629, BTC: 0.630, SOL: 0.638 } }, // Noon Peak BB15
  71: { tpd: 34,  wrNum: 0.556, coinWr: { ETH: 0.566, BTC: 0.559, SOL: 0.528 } }, // BB(20,2.2)+s>=1 5m+15m
  72: { tpd: 34,  wrNum: 0.546, coinWr: { ETH: 0.563, BTC: 0.549, SOL: 0.527, XRP: 0.528 } }, // Connors RSI(15/85)
  73: { tpd: 10,  wrNum: 0.568, coinWr: { ETH: 0.573, BTC: 0.578, SOL: 0.551, XRP: 0.549 } }, // ATR Climax BB22
  74: { tpd: 14,  wrNum: 0.565, coinWr: { ETH: 0.584, BTC: 0.577, SOL: 0.521, XRP: 0.541 } }, // StochRSI+BB22
  75: { tpd: 2,   wrNum: 0.559, coinWr: { ETH: 0.566, BTC: 0.582, SOL: 0.536, XRP: 0.553 } }, // CCI>200+BB22
  76: { tpd: 3,   wrNum: 0.552, coinWr: { ETH: 0.568, BTC: 0.575, SOL: 0.536, XRP: 0.528 } }, // WPR+RSI7+BB22
  77: { tpd: 6,   wrNum: 0.546, coinWr: { ETH: 0.566, BTC: 0.540, SOL: 0.545, XRP: 0.532 } }, // Keltner Outer
  // Session 10 — Micro-Structure + ML (hfBinary5m.ts research, at-expiry validated)
  78: { tpd: 6.5, wrNum: 0.557, coinWr: { ETH: 0.580, BTC: 0.571, SOL: 0.548, XRP: 0.542 } }, // 1m RSI7+BB22
  79: { tpd: 3.7, wrNum: 0.579, coinWr: { ETH: 0.581, BTC: 0.605, SOL: 0.557, XRP: 0.571 } }, // Vol Exhaustion BB22
  80: { tpd: 3.0, wrNum: 0.580, coinWr: { ETH: 0.584, BTC: 0.609, SOL: 0.574, XRP: 0.554 } }, // MicroStreak×3 BB22
  81: { tpd: 5.5, wrNum: 0.652, coinWr: { ETH: 0.635, BTC: 0.727, SOL: 0.648, XRP: 0.608 } }, // ML 15m-Streak+BB22
  // Session 11: oscillator confluence
  82: { tpd: 2.0, wrNum: 0.563, coinWr: { ETH: 0.583, BTC: 0.582, SOL: 0.542, XRP: 0.544 } }, // BB%B+RSI7
  83: { tpd: 2.0, wrNum: 0.559, coinWr: { ETH: 0.593, BTC: 0.562, SOL: 0.541, XRP: 0.541 } }, // RSI3>90+BB22
  84: { tpd: 1.9, wrNum: 0.555, coinWr: { ETH: 0.581, BTC: 0.563, SOL: 0.538, XRP: 0.540 } }, // RSI7 Consec2+BB22
  85: { tpd: 1.6, wrNum: 0.556, coinWr: { ETH: 0.570, BTC: 0.569, SOL: 0.549, XRP: 0.545 } }, // EMA20Dev+RSI7+BB22
  86: { tpd: 3.1, wrNum: 0.552, coinWr: { ETH: 0.561, BTC: 0.575, SOL: 0.543, XRP: 0.543 } }, // BB%B+CCI+WPR Triple
  // Session 12 strategies
  87: { tpd: 2.3, wrNum: 0.558, coinWr: { ETH: 0.576, BTC: 0.562, SOL: 0.554, XRP: 0.541 } }, // DoubleRSI+BB22
  88: { tpd: 1.7, wrNum: 0.558, coinWr: { ETH: 0.571, BTC: 0.581, SOL: 0.534, XRP: 0.546 } }, // BB Squeeze→Release
  89: { tpd: 1.8, wrNum: 0.555, coinWr: { ETH: 0.556, BTC: 0.561, SOL: 0.547, XRP: 0.556 } }, // WideRange+BB22
  90: { tpd: 0.7, wrNum: 0.576, coinWr: { ETH: 0.564, BTC: 0.631, SOL: 0.535, XRP: 0.574 } }, // ADX<20+BB22 (BTC=63.1%!)
  91: { tpd: 0.4, wrNum: 0.641, coinWr: { ETH: 0.672, BTC: 0.611 } },                          // GH+CRSI85+BB22
  92: { tpd: 0.06, wrNum: 0.683, coinWr: { BTC: 0.762, ETH: 0.600, XRP: 0.727 } },             // GH+ADX<20+RSI73+MFI72 — 76.2% BTC! 🔥
  93: { tpd: 0.02, wrNum: 0.754, coinWr: { BTC: 0.833, XRP: 0.800, SOL: 0.714, ETH: 0.667 } }, // GH+ADX20+RSI73+MFI72+RSI14 avg=75.4% 🔥🔥🔥
  94: { tpd: 0.03, wrNum: 0.710, coinWr: { BTC: 0.800, XRP: 0.778, SOL: 0.625, ETH: 0.636 } }, // GH+ADX20+RSI76+MFI75 avg=71.0% 🔥🔥
  95: { tpd: 0.05, wrNum: 0.738, coinWr: { SOL: 0.800, ETH: 0.714, BTC: 0.700 } },             // TightGH+ADX20+RSI70+MFI68 SOL=80%! 🔥🔥🔥
  96: { tpd: 0.10, wrNum: 0.709, coinWr: { BTC: 0.750, XRP: 0.667 } },                         // GH+ADX20+RSI3_93 BTC=75% n=92 🔥🔥🔥
  97: { tpd: 0.02, wrNum: 0.804, coinWr: { BTC: 0.857, XRP: 0.750, SOL: 0.750, ETH: 0.710 } }, // RSI3+RSI5+MFI70 BTC=85.7%! XRP=75%! 🔥🔥🔥
  98: { tpd: 0.02, wrNum: 0.746, coinWr: { BTC: 0.778, ETH: 0.714, SOL: 0.700 } },             // WPR_8+RSI73+MFI72 BTC=77.8%! 🔥🔥🔥
  99: { tpd: 0.04, wrNum: 0.778, coinWr: { BTC: 0.778, SOL: 0.750, ETH: 0.720, XRP: 0.700 } }, // CRSI85+MFI72 BTC=77.8% n=42 best vol! 🔥🔥🔥
  100: { tpd: 0.03, wrNum: 0.800, coinWr: { BTC: 0.800, ETH: 0.740 } },                        // BB20_2.0+RSI73+MFI72+RSI14 BTC=80.0%! 🔥🔥🔥
  // Session 13: 1m sub-candle + 1h ranging regime strategies
  101: { tpd: 7, wrNum: 0.568, coinWr: { ETH: 0.584, BTC: 0.589, SOL: 0.551, XRP: 0.552 } },  // 1m VolClimax+BB22 (5-fold WF)
  102: { tpd: 11, wrNum: 0.580, coinWr: { ETH: 0.590, BTC: 0.590, SOL: 0.570, XRP: 0.570 } }, // 1h Ranging+BB22+Streak (5-fold WF)
  103: { tpd: 7, wrNum: 0.561, coinWr: { ETH: 0.577, BTC: 0.577, SOL: 0.545, XRP: 0.545 } },  // 1m MomentumFade+BB22 (5-fold WF)
  104: { tpd: 4, wrNum: 0.605, coinWr: { ETH: 0.612, BTC: 0.627, SOL: 0.575, XRP: 0.595 } },  // 1m VolSpike+1h Range+BB22 STAR 🌟
  // Session 15: BB(1.8)×RSI3 + BB(1.0) triple confirm
  105: { tpd: 0.60, wrNum: 0.750, coinWr: { ETH: 0.750, BTC: 0.700, SOL: 0.690, XRP: 0.680 } }, // BB18+RSI3_90+MFI70 ETH=75.0% n=110 🔥🔥🔥
  106: { tpd: 0.40, wrNum: 0.789, coinWr: { BTC: 0.789, ETH: 0.667 } },                          // BB10+RSI73+MFI72+RSI14 BTC=78.9% n=70 🔥🔥🔥
  // Session 16: 4h regime filter + ultra-extreme RSI3>95
  107: { tpd: 0.25, wrNum: 0.745, coinWr: { ETH: 0.745, BTC: 0.705, XRP: 0.623 } },              // 4hADX<20+RSI3>93+MFI70+BB22 ETH=74.5% BTC=70.5% 🔥🔥
  108: { tpd: 0.15, wrNum: 0.800, coinWr: { BTC: 0.710, XRP: 0.800 } },                           // ultra-extreme RSI3>95+MFI70+BB22 XRP=80.0% 🔥🔥🔥
  109: { tpd: 0.20, wrNum: 0.773, coinWr: { BTC: 0.700, XRP: 0.773 } },                           // ultra-extreme RSI3>95+MFI70+BB18 XRP=77.3% 🔥🔥🔥
  110: { tpd: 0.20, wrNum: 0.800, coinWr: { BTC: 0.800, XRP: 0.800 } },                           // StochK>85+MFI72+RSI14+BB22 BTC=80.0% XRP=80.0% 🔥🔥🔥
  111: { tpd: 0.30, wrNum: 0.818, coinWr: { BTC: 0.818 } },                                        // StochK>85+MFI72+RSI14+BB18 BTC=81.8% n=60 🔥🔥🔥 HIGHEST BTC StochRSI!
  // Session 17: quad-oscillator BB18, XRP RSI3+StochK, 2-consec BB
  112: { tpd: 0.15, wrNum: 0.756, coinWr: { BTC: 0.756, ETH: 0.708 } },                           // RSI7>73+StochK80+MFI72+RSI14+BB18 BTC=75.6% ETH=70.8% 🔥🔥
  113: { tpd: 0.20, wrNum: 0.727, coinWr: { XRP: 0.727 } },                                        // XRP RSI3>93+StochK80+MFI70+BB22 XRP=72.7% n=33 🔥🔥
  114: { tpd: 0.30, wrNum: 0.714, coinWr: { BTC: 0.714 } },                                        // 2-consec BB22+RSI3>90+MFI68 BTC=71.4% n=49 🔥🔥
  // Session 18: BB%B deep overshoot, StochK>90 ultra-extreme, XRP double-extreme
  115: { tpd: 0.20, wrNum: 0.759, coinWr: { ETH: 0.759, BTC: 0.714 } },                           // BB%B>1.1+RSI3>90+MFI70 ETH=75.9% BTC=71.4% 🔥🔥🔥
  116: { tpd: 0.15, wrNum: 0.806, coinWr: { BTC: 0.806, ETH: 0.682, XRP: 0.708 } },               // StochK>90+MFI72+RSI14+BB22 BTC=80.6% n=36 🔥🔥🔥
  117: { tpd: 0.20, wrNum: 0.714, coinWr: { XRP: 0.714 } },                                        // XRP StochK>90+RSI3>93+MFI72+BB22 XRP=71.4% n=28 🔥🔥
  // Session 19: triple RSI alignment (σ=2.9% ULTRA STABLE), triple RSI+MFI, ultra-high MFI+StochK
  118: { tpd: 0.30, wrNum: 0.806, coinWr: { BTC: 0.806, ETH: 0.700, XRP: 0.700 } },               // RSI3>90+RSI7>72+RSI14>68+BB22 BTC=80.6% σ=2.9% ULTRA STABLE 🏆🔥
  119: { tpd: 0.20, wrNum: 0.821, coinWr: { BTC: 0.821, ETH: 0.700, XRP: 0.750 } },               // RSI3>90+RSI7>72+RSI14>68+MFI70+BB22 BTC=82.1% XRP=75.0% 🔥🏆
  120: { tpd: 0.15, wrNum: 0.846, coinWr: { BTC: 0.846 } },                                        // MFI>75+StochK>80+RSI14>68+BB22 BTC=84.6% n=26 🔥💫
  // Session 20: VWAP session-dev (new pattern class), σ=7.8% stable
  121: { tpd: 0.12, wrNum: 0.722, coinWr: { BTC: 0.722 } },                                        // VWAP_dev>0.3%+RSI3>90+BB22 BTC=72.2% n=22 σ=7.8% 📊
};

// Fallback: parse wr string ("71.1%" or "70-72%") when no explicit STRAT_STATS entry
function resolveStats(s: typeof STRATEGY_META[0]): { tpd: number; wrNum: number; coinWr?: Record<string, number> } | null {
  if (STRAT_STATS[s.strategyId]) return STRAT_STATS[s.strategyId];
  const m = s.wr.match(/(\d+\.?\d*)/);
  if (!m) return null;
  return { tpd: 0.5, wrNum: parseFloat(m[1]) / 100 };
}

const STRATEGY_META = [
  // ── Tier 1: Best validated ETH strategies ──────────────────────────────
  {
    strategyId: 18,
    emoji: '🔥',
    name: 'RSI Panic Exhaustion',
    wr: '71.1%',
    badge: 'ULTRA STABLE',
    badgeColor: 'bg-orange-900/40 text-orange-400',
    coins: ['ETH'],
    desc: 'RSI>70+body≥0.3%+BB(20,2.2)+GoodH → all 3 folds ≥70%',
  },
  {
    strategyId: 16,
    emoji: '🔮',
    name: 'Synth15m Ensemble',
    wr: '73.1%',
    badge: 'CHAMPION',
    badgeColor: 'bg-purple-900/40 text-purple-400',
    coins: ['ETH'],
    desc: 'Aggregate 5m→15m dual-confirm signals',
  },
  {
    strategyId: 17,
    emoji: '📏',
    name: 'Daily Range Extreme',
    wr: '73.4%',
    badge: null,
    badgeColor: '',
    coins: ['ETH'],
    desc: 'GoodH+BB+top/bottom 30% daily range',
  },
  {
    strategyId: 15,
    emoji: '🎯',
    name: 'Good Hours Optimized',
    wr: '69.8%',
    badge: 'STABLE',
    badgeColor: 'bg-blue-900/40 text-blue-400',
    coins: ['ETH'],
    desc: 'GoodH[10-12,21]+BB(20,2.2)+streak≥2',
  },
  {
    strategyId: 13,
    emoji: '⚖️',
    name: 'Balanced BB Reversion',
    wr: '67.1%',
    badge: null,
    badgeColor: '',
    coins: ['ETH'],
    desc: 'ExtHours+BB(1.5)+dev[0.05-0.25%]',
  },
  // ── Tier 2: Cross-coin validated ───────────────────────────────────────
  {
    strategyId: 14,
    emoji: '🔄',
    name: 'Recovery Rally',
    wr: '75.9%',
    badge: 'CROSS-COIN',
    badgeColor: 'bg-amber-900/40 text-amber-400',
    coins: ['ETH', 'BTC'],
    desc: 'RGGG/GRGG at BB upper → reversion',
  },
  {
    strategyId: 12,
    emoji: '📊',
    name: 'MFI Exhaustion',
    wr: '70.4%',
    badge: '5-FOLD',
    badgeColor: 'bg-emerald-900/40 text-emerald-400',
    coins: ['BTC'],
    desc: 'MFI(10)>80+streak+BB — BTC/15m',
  },
  // ── Tier 3: Additional validated signals ───────────────────────────────
  {
    strategyId: 10,
    emoji: '⚡',
    name: 'Keltner+BB Squeeze',
    wr: '70-72%',
    badge: null,
    badgeColor: '',
    coins: ['ETH', 'BTC'],
    desc: 'Outside BOTH Keltner+BB bands → reversion',
  },
  {
    strategyId: 11,
    emoji: '💥',
    name: 'Volume Spike Exhaustion',
    wr: '67.4%',
    badge: null,
    badgeColor: '',
    coins: ['ETH'],
    desc: 'vol>3x + streak≥2 + outside BB',
  },
  {
    strategyId: 9,
    emoji: '🎯',
    name: 'Markov+BB Reversion',
    wr: '66-70%',
    badge: null,
    badgeColor: '',
    coins: ['ETH', 'BTC'],
    desc: 'GGG+BB+bodyATR, skip 14UTC',
  },
  // ── SOL strategies ─────────────────────────────────────────────────
  {
    strategyId: 19,
    emoji: '🌟',
    name: 'SOL Good Hours BB',
    wr: '68.7%',
    badge: 'NEW',
    badgeColor: 'bg-cyan-900/40 text-cyan-400',
    coins: ['SOL'],
    desc: 'SOL/15m h=[0,12,13,20]+BB(20,2.2)+streak≥2 (σ=5.6%)',
  },
  // ── XRP strategies ─────────────────────────────────────────────────
  {
    strategyId: 20,
    emoji: '💎',
    name: 'XRP Good Hours BB',
    wr: '66.7%',
    badge: 'NEW',
    badgeColor: 'bg-violet-900/40 text-violet-400',
    coins: ['XRP'],
    desc: 'XRP/15m h=[6,9,12,18]+BB(25,2.2)+streak≥1 σ=0.4% ULTRA STABLE',
  },
  // ── New ETH strategies (Session 4 ML-optimized) ───────────────────
  {
    strategyId: 21,
    emoji: '📅',
    name: 'DoW Reversion',
    wr: '70.5%',
    badge: 'ML',
    badgeColor: 'bg-teal-900/40 text-teal-400',
    coins: ['ETH'],
    desc: 'ETH/5m Wed+Sat+GoodH+BB(20,2.2)+streak≥2 σ=6.0% [5-fold]',
  },
  {
    strategyId: 22,
    emoji: '📐',
    name: 'EMA50 Extension',
    wr: '65.9%',
    badge: 'ML',
    badgeColor: 'bg-teal-900/40 text-teal-400',
    coins: ['ETH'],
    desc: 'ETH/5m EMA50 dist≥0.5%+GoodH+BB(20,2.2) σ=5.9% HIGH FREQ (1.6/day)',
  },
  {
    strategyId: 23,
    emoji: '🎭',
    name: 'RSI Bidir Exhaustion',
    wr: '66.0%',
    badge: 'ML',
    badgeColor: 'bg-teal-900/40 text-teal-400',
    coins: ['ETH'],
    desc: 'ETH/5m RSI>65/<35+body≥0.3%+GoodH+BB(20,2.2) σ=4.1% bidir',
  },
  {
    strategyId: 24,
    emoji: '💹',
    name: 'ETH 15m MFI Exhaustion',
    wr: '68.2%',
    badge: 'ML',
    badgeColor: 'bg-teal-900/40 text-teal-400',
    coins: ['ETH'],
    desc: 'ETH synth-15m MFI>70/<30+GoodH+BB(15,2.2)+streak≥1 σ=9.4%',
  },
  {
    strategyId: 25,
    emoji: '🤖',
    name: 'RSI Bear Streak',
    wr: '69.6%',
    badge: 'ML',
    badgeColor: 'bg-teal-900/40 text-teal-400',
    coins: ['ETH'],
    desc: 'ETH/5m ML: RSI>65+streak≥2+GoodH+aboveBB22 σ=1.9% ULTRA STABLE',
  },
  // ── New SOL strategies (Session 4 ML-optimized) ───────────────────
  {
    strategyId: 26,
    emoji: '🗓️',
    name: 'SOL DoW Reversion',
    wr: '77.4%',
    badge: 'ML',
    badgeColor: 'bg-pink-900/40 text-pink-400',
    coins: ['SOL'],
    desc: 'SOL synth-15m Tue+Wed+Thu+GoodH+BB(20,2.2)+streak≥1 σ=9.4%',
  },
  {
    strategyId: 27,
    emoji: '🕯️',
    name: 'SOL Pattern Exhaustion',
    wr: '69.0%',
    badge: 'ML',
    badgeColor: 'bg-pink-900/40 text-pink-400',
    coins: ['SOL'],
    desc: 'SOL synth-15m GG bear/RR bull at GoodH+BB(20,2.2) σ=5.3%',
  },
  {
    strategyId: 28,
    emoji: '🔵',
    name: 'SOL Tight BB Reversion',
    wr: '70.9%',
    badge: 'ML',
    badgeColor: 'bg-pink-900/40 text-pink-400',
    coins: ['SOL'],
    desc: 'SOL synth-15m GoodH+BB(15,2.2)+streak≥2 σ=7.1% HIGH FREQ (1.0/day)',
  },
  {
    strategyId: 29,
    emoji: '💪',
    name: 'SOL Panic Body BB',
    wr: '69.4%',
    badge: 'ML',
    badgeColor: 'bg-pink-900/40 text-pink-400',
    coins: ['SOL'],
    desc: 'SOL synth-15m body≥0.3%+GoodH+BB(20,2.2)+streak≥2 σ=8.8%',
  },
  {
    strategyId: 30,
    emoji: '📈',
    name: 'SOL EMA Extension',
    wr: '68.2%',
    badge: 'ML',
    badgeColor: 'bg-pink-900/40 text-pink-400',
    coins: ['SOL'],
    desc: 'SOL synth-15m EMA50 dist≥0.3%+GoodH+BB(20,2.2)+streak≥2 σ=6.9%',
  },
  // Session 5 — ETH best-ever WR strategies
  {
    strategyId: 31,
    emoji: '🔴',
    name: 'ETH Synth-15m RSI Panic',
    wr: '80.0%',
    badge: 'S5',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH'],
    desc: 'ETH synth-15m GoodH+BB(20,2.2)+RSI14>68+body≥0.3% — BEST EVER σ=6.1%',
  },
  {
    strategyId: 32,
    emoji: '🌙',
    name: 'ETH 15m Discovery',
    wr: '75.3%',
    badge: 'S5',
    badgeColor: 'bg-violet-900/40 text-violet-300',
    coins: ['ETH'],
    desc: 'ETH 15m h=[7,12,20]+RSI14>60+BB(20,2.2)+streak≥2 — ULTRA STABLE σ=1.5%',
  },
  {
    strategyId: 35,
    emoji: '🎯',
    name: 'ETH Tight BB Zone',
    wr: '71.8%',
    badge: 'S5',
    badgeColor: 'bg-cyan-900/40 text-cyan-300',
    coins: ['ETH'],
    desc: 'ETH 5m h=[10,12,21]+BB(20,2.2)+dev(0.05-0.25%)+streak≥2 σ=6.3%',
  },
  // Session 5 — SOL ultra stable strategies
  {
    strategyId: 33,
    emoji: '🏔️',
    name: 'SOL Daily Range Extreme',
    wr: '72.7%',
    badge: 'S5',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['SOL'],
    desc: 'SOL synth-15m GoodH+BB(20,2.2)+daily range top/bot 30% σ=2.5%',
  },
  {
    strategyId: 34,
    emoji: '🧲',
    name: 'SOL Low-ATR BB',
    wr: '71.6%',
    badge: 'S5',
    badgeColor: 'bg-emerald-900/40 text-emerald-300',
    coins: ['SOL'],
    desc: 'SOL synth-15m GoodH+BB(15,2.2)+ATR percentile≤33% (low-vol) σ=1.9%',
  },
  // Session 6 — ETH/15m Wave 3 (ultra stable body+RSI+MFI)
  {
    strategyId: 36,
    emoji: '🔶',
    name: 'ETH 15m Body RSI7',
    wr: '73.2%',
    badge: 'S6',
    badgeColor: 'bg-amber-900/40 text-amber-300',
    coins: ['ETH'],
    desc: 'ETH 15m h=[7,12,20]+body≥0.3%+RSI7>65+BB(15,2.2)+s≥2 — σ=1.2% ULTRA STABLE',
  },
  {
    strategyId: 37,
    emoji: '🟠',
    name: 'ETH 15m MFI Confirm',
    wr: '76.7%',
    badge: 'S6',
    badgeColor: 'bg-orange-800/40 text-orange-200',
    coins: ['ETH'],
    desc: 'ETH 15m h=[5,12,20]+MFI>70+BB(15,2.2)+s≥2 — σ=1.8% ULTRA STABLE',
  },
  {
    strategyId: 38,
    emoji: '🔸',
    name: 'ETH 15m ATR Panic',
    wr: '77.6%',
    badge: 'S6',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH'],
    desc: 'ETH 15m h=[5,12,20]+body/ATR≥0.5+RSI7>70+BB(15,2.2)+s≥2 — σ=4.9%',
  },
  // Session 6 — XRP validated (near-perfect stability)
  {
    strategyId: 39,
    emoji: '💠',
    name: 'XRP MFI75 Exhaustion',
    wr: '67.3%',
    badge: 'S6',
    badgeColor: 'bg-sky-900/40 text-sky-300',
    coins: ['XRP'],
    desc: 'XRP synth-15m MFI>75+BB(25,2.2)+GoodH+s≥1 — σ=0.4% NEAR-PERFECT',
  },
  {
    strategyId: 40,
    emoji: '🔷',
    name: 'XRP BB15 Reversion',
    wr: '68.1%',
    badge: 'S6',
    badgeColor: 'bg-blue-900/40 text-blue-300',
    coins: ['XRP'],
    desc: 'XRP synth-15m BB(15,2.2)+GoodH+s≥1 — σ=1.6% high-volume stable',
  },
  {
    strategyId: 41,
    emoji: '📅',
    name: 'Saturday BB Reversion',
    wr: '69.1%',
    badge: 'S6',
    badgeColor: 'bg-indigo-900/40 text-indigo-300',
    coins: ['BTC', 'ETH'],
    desc: 'Saturday synth-15m BB(15,2.2)+s≥1 — BTC WF=69.1% σ=5.7% T=149',
  },
  {
    strategyId: 42,
    emoji: '🏆',
    name: 'SOL RSI Streak BB',
    wr: '67.1%',
    badge: 'OPT',
    badgeColor: 'bg-violet-900/40 text-violet-300',
    coins: ['SOL'],
    desc: 'SOL RSI>65+2G synth-15m at BB(20,2.2) — σ=2.9% ULTRA STABLE [all 5 folds identical]',
  },
  {
    strategyId: 43,
    emoji: '💹',
    name: 'BTC MFI BB',
    wr: '81.6%',
    badge: 'BTC5',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['BTC'],
    desc: 'BTC MFI>75+BB(20,2.2)+GoodH+s≥1 — σ=2.6% ULTRA STABLE h=[1,12,13,16,20]UTC',
  },
  {
    strategyId: 44,
    emoji: '📡',
    name: 'BTC RSI BB',
    wr: '80.5%',
    badge: 'BTC5',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['BTC'],
    desc: 'BTC RSI>67+BB(20,2.2)+GoodH+s≥1 — σ=4.2% T=221 h=[1,12,13,16,20]UTC',
  },
  {
    strategyId: 45,
    emoji: '🔰',
    name: 'BTC GH BB Streak',
    wr: '79.7%',
    badge: 'BTC5',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['BTC'],
    desc: 'BTC GoodH+BB(20,2.2)+s≥2 — σ=5.5% T=310/yr HIGH FREQ ~1.7/day',
  },
  {
    strategyId: 46,
    emoji: '🏅',
    name: 'BTC RSI70 BB',
    wr: '83.1%',
    badge: 'BTC5',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['BTC'],
    desc: 'BTC RSI>70+BB(20,2.2)+GoodH+s≥1 — σ=8.5% T=161 HIGHEST WR found for BTC',
  },
  {
    strategyId: 56,
    emoji: '⚡',
    name: 'ALL-H RSI Panic BB',
    wr: '76.1%',
    badge: 'HF',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC'],
    desc: 'ALL hours RSI>70+BB(20,2.2)+s≥1 — ETH σ=2.6% 5.1/day ULTRA STABLE | BTC 75.2% σ=5.6%',
  },
  {
    strategyId: 57,
    emoji: '🌊',
    name: 'ALL-H MFI80 BB',
    wr: '75.7%',
    badge: 'HF',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC'],
    desc: 'ALL hours MFI>80+BB(20,2.2)+s≥1 — ETH σ=4.1% 4.2/day | BTC validated 4.2/day',
  },
  {
    strategyId: 58,
    emoji: '🔥',
    name: 'ALL-H MFI85 BB',
    wr: '76.3%',
    badge: 'HF',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC'],
    desc: 'ALL hours MFI>85+BB(20,2.2)+s≥1 — ETH σ=4.3% 2.8/day (tightest MFI filter)',
  },
  {
    strategyId: 59,
    emoji: '🌟',
    name: 'SOL ALL-H RSI Panic',
    wr: '73.0%',
    badge: 'HF-SOL',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['SOL'],
    desc: 'SOL ALL hours RSI>70+BB(20,2.2)+s≥1 — σ=2.8% 4.8/day ULTRA STABLE',
  },
  {
    strategyId: 60,
    emoji: '💫',
    name: 'SOL ALL-H RSI7 Panic',
    wr: '73.2%',
    badge: 'HF-SOL',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['SOL'],
    desc: 'SOL ALL hours RSI7>75+BB(20,2.2)+s≥1 — σ=3.1% 7.2/day HIGHEST FREQUENCY',
  },
  {
    strategyId: 61,
    emoji: '👑',
    name: 'BTC Synth15m GH RSI',
    wr: '86.3%',
    badge: 'S15m',
    badgeColor: 'bg-amber-900/40 text-amber-300',
    coins: ['BTC'],
    desc: 'BTC Synth15m GoodH[1,12,13,16,20]+RSI>65+BB22+s≥1 — σ=6.3% HIGHEST WR EVER!',
  },
  {
    strategyId: 62,
    emoji: '📊',
    name: 'BTC Synth15m ALL-H RSI',
    wr: '77.0%',
    badge: 'S15m',
    badgeColor: 'bg-amber-900/40 text-amber-300',
    coins: ['BTC'],
    desc: 'BTC Synth15m ALL hours RSI>70+BB22+s≥1 — σ=4.4% 1.8/day',
  },
  {
    strategyId: 64,
    emoji: '🎯',
    name: 'ALL-H Dual RSI+MFI BB',
    wr: '76.4%',
    badge: 'HF',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC'],
    desc: 'ALL hours RSI>70+MFI>70+BB(20,2.2)+s≥1 — σ=2.2% 4.4/day ULTRA STABLE dual filter',
  },
  {
    strategyId: 65,
    emoji: '🔭',
    name: 'ALL-H RSI Dev Filter BB',
    wr: '77.8%',
    badge: 'HF',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC'],
    desc: 'ALL hours RSI>70+dev[0.05-0.5%]+BB(20,2.2)+s≥1 — σ=2.7% 3.2/day ULTRA STABLE',
  },
  {
    strategyId: 66,
    emoji: '💎',
    name: 'BTC GH Body RSI BB',
    wr: '79.2%',
    badge: 'BTC5',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['BTC'],
    desc: 'BTC GoodH+RSI>65+body≥0.15%+BB22+s≥1 — σ=2.6% ULTRA STABLE body filter',
  },
  {
    strategyId: 67,
    emoji: '⚡🔁',
    name: 'ALL-H BB18 HF',
    wr: '54%',
    badge: 'HF84',
    badgeColor: 'bg-green-900/40 text-green-300',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'ALL hours BB(20,1.8)+s≥1 — ETH 55.4% | BTC 54.3% | SOL 52.2% | 42/d/coin · 84/d ETH+BTC (correct Polymarket exit)',
  },
  {
    strategyId: 68,
    emoji: '🚀',
    name: 'ALL-H BB10 UHF',
    wr: '53%',
    badge: 'HF106',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'ALL hours BB(20,1.0)+s≥1 — ETH 53.7% | BTC 52.5% | SOL 51.5% | ~106/d/coin (correct exit, thin margin — use only on liquid markets)',
  },
  {
    strategyId: 69,
    emoji: '🎲🚀',
    name: 'Stoch+BB10 HF80',
    wr: '54%',
    badge: 'DIV',
    badgeColor: 'bg-gray-700/40 text-gray-400',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'Stoch(5)>70+BB(20,1.0)+s≥1 — ~54% correct-exit WR (mlOptimize WRs were inflated) — kept for signal diversity only',
  },
  {
    strategyId: 70,
    emoji: '🕛🎯',
    name: 'Noon Peak BB15',
    wr: '63%',
    badge: 'NOON',
    badgeColor: 'bg-amber-900/40 text-amber-300',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'h=12 UTC + BB(20,1.5)+s≥1 — ETH 62.9% σ=4.0% 2.7/d | SOL 63.8% σ=3.6% 2.9/d — CORRECT at-expiry validated ✅',
  },
  {
    strategyId: 71,
    emoji: '⚡🎯',
    name: 'HF BB22 Pure',
    wr: '55-57%',
    badge: '122/DAY',
    badgeColor: 'bg-cyan-900/40 text-cyan-300',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'ALL-H BB(20,2.2)+s≥1 — TRUE at-expiry: 5m binary=56% WR 20/d + 15m binary=55% WR 20/d = 122/day total across ETH+BTC+SOL ✅ 120+/day ACHIEVED',
  },
  {
    strategyId: 72,
    emoji: '🧠⚡',
    name: 'Connors RSI 15/85',
    wr: '53-56%',
    badge: '135/DAY',
    badgeColor: 'bg-violet-900/40 text-violet-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'TradingView Connors RSI = RSI(3)+StreakRSI(2)+PercentileRank(100) — CRSI<15=oversold→BULL | CRSI>85=overbought→BEAR | ETH=56.3% BTC=54.9% 33/day each → 135/day total ✅',
  },
  {
    strategyId: 73,
    emoji: '💥🔄',
    name: 'ATR Climax BB22',
    wr: '55-58%',
    badge: '40/DAY',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'TradingView Exhaustion Pattern — Big candle(≥ATR) at BB22 extreme + RSI7 overbought/oversold = climax → reverse | ETH=57.3% BTC=57.8% σ=2% ~10/day each → 40/day total ✅',
  },
  {
    strategyId: 74,
    emoji: '📊🎯',
    name: 'StochRSI+BB22',
    wr: '52-58%',
    badge: '55/DAY',
    badgeColor: 'bg-teal-900/40 text-teal-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Double Oscillator Exhaustion — StochRSI K+D both <20 (or >80) AND price outside BB22 = double-confirmed reversal | ETH=58.4% BTC=57.7% ~14/day each → 55/day total ✅',
  },
  {
    strategyId: 75,
    emoji: '📉🎯',
    name: 'CCI>200 BB22',
    wr: '53-58%',
    badge: 'HIGH WR',
    badgeColor: 'bg-amber-900/40 text-amber-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'CCI Extreme Reversal — CCI(20)>200 at BB22 upper / <-200 at BB22 lower = extreme mean-reversion signal | ETH=56.6% BTC=58.2% XRP=55.3% avg=55.9% WR ~2/day each (Session 10) ✅',
  },
  {
    strategyId: 76,
    emoji: '📡🔄',
    name: 'Williams %R + RSI7 + BB22',
    wr: '52-57%',
    badge: 'TRIPLE',
    badgeColor: 'bg-cyan-900/40 text-cyan-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Triple Confirmation Reversal — Williams %R overbought/oversold + RSI7 extreme + price outside BB22 = 3-way exhaustion signal | ETH=56.8% BTC=57.5% avg=55.2% WR ~3/day (Session 10) ✅',
  },
  {
    strategyId: 77,
    emoji: '🌋🔄',
    name: 'Keltner Outer',
    wr: '53-57%',
    badge: '24/DAY',
    badgeColor: 'bg-rose-900/40 text-rose-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Keltner Channel Outer Reversal — Price outside EMA(20)±2×ATR(14) Keltner Channel = extreme volatility overextension → reverse | ETH=56.6% SOL=54.5% avg=54.6% WR ~6/day each → 24/day total (Session 10) ✅',
  },
  // ── Session 10 — Micro-Structure + ML (hfBinary5m.ts, at-expiry validated) ──
  {
    strategyId: 78,
    emoji: '⚡📈',
    name: '1m RSI7 Extreme + BB22',
    wr: '54-58%',
    badge: '26/DAY',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Micro-Structure RSI7 Reversal — 1m RSI7 >78/<22 (proxy for 5s exhaustion) + price outside 5m BB(20,2.2) → mean-revert | ETH=58.0% BTC=57.1% SOL=54.8% XRP=54.2% WR ~6.5/day → 26/day total (at-expiry ✅)',
  },
  {
    strategyId: 79,
    emoji: '💧🔥',
    name: 'Volume Exhaustion + BB22',
    wr: '55-61%',
    badge: '15/DAY',
    badgeColor: 'bg-blue-900/40 text-blue-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Volume Exhaustion Reversal — Last 1m volume >1.8× avg (exhaustion spike) + 5m BB(20,2.2) outside + streak≥1 → fade the move | ETH=58.1% BTC=60.5% SOL=55.7% XRP=57.1% WR ~3.7/day → 15/day total (at-expiry ✅)',
  },
  {
    strategyId: 80,
    emoji: '🔥🎯',
    name: 'MicroStreak×3 + BB22',
    wr: '55-61%',
    badge: '12/DAY',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Micro-Streak Triple Reversal — 3+ consecutive 5m candles in same direction at BB(20,2.2) extreme + RSI14>65/<35 → exhaustion reversal | ETH=58.4% BTC=60.9% SOL=57.4% XRP=55.4% WR ~3/day → 12/day total (at-expiry ✅)',
  },
  {
    strategyId: 81,
    emoji: '🤖🧠',
    name: 'ML 15m-Streak + BB22',
    wr: '61-73%',
    badge: 'ML ★★★',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'ML-Synthesized Strategy — Derived from logistic regression top features: 15m streak≥3 (coeff=+0.62) + 5m BB(20,2.2) outside (coeff=+0.45) + RSI14 extreme (coeff=-0.49) | BTC ML=72.7% ETH=63.5% SOL=64.8% XRP=60.8% WR ~5.5/day → 22/day total (at-expiry ✅)',
  },
  // ── Session 11: New Pattern Families ───────────────────────────────────────────
  {
    strategyId: 82,
    emoji: '📐🎯',
    name: 'BB %B + RSI7',
    wr: '54-58%',
    badge: '8/DAY',
    badgeColor: 'bg-sky-900/40 text-sky-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Bollinger %B Extreme + RSI7 — %B>1.05 (price clearly above upper band) + RSI7>65 = double-confirmed overbought → BEAR | ETH=58.3% BTC=58.2% SOL=54.2% avg=56.3% WR ~2/day each → 8/day total (Session 11) ✅',
  },
  {
    strategyId: 83,
    emoji: '⚡🔴',
    name: 'RSI(3) > 90 + BB22',
    wr: '54-59%',
    badge: '8/DAY',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Ultra-Fast RSI(3) Extreme — RSI(3) hypersensitive oscillator >90 at BB22 upper = extreme short-term overbought → sharp reversal | ETH=59.3%! BTC=56.2% SOL=54.1% avg=55.9% WR ~2/day → 8/day total (Session 11) ✅',
  },
  {
    strategyId: 84,
    emoji: '🔥🔥',
    name: 'RSI7 Consecutive 2 + BB22',
    wr: '53-58%',
    badge: '8/DAY',
    badgeColor: 'bg-orange-900/40 text-orange-400',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Sustained Overbought Reversal — Two consecutive 5m bars with RSI7>70 at BB22 upper = sustained overextension → high-conviction reversal | ETH=58.1% BTC=56.3% avg=55.5% WR ~2/day → 8/day total (Session 11) ✅',
  },
  {
    strategyId: 85,
    emoji: '📏🎯',
    name: 'EMA20 Dev + RSI7 + BB22',
    wr: '54-57%',
    badge: 'TRIPLE',
    badgeColor: 'bg-indigo-900/40 text-indigo-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Triple Anchor Mean Reversion — Price >0.5% above EMA(20) + RSI7>67 + outside BB22 = 3 simultaneous overextension signals → reversal | ETH=57.0% BTC=56.9% avg=55.6% WR ~1.6/day → 7/day total (Session 11) ✅',
  },
  {
    strategyId: 86,
    emoji: '🎰🏆',
    name: 'BB%B + CCI + WPR Triple',
    wr: '53-57%',
    badge: '12/DAY',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Triple Oscillator Confluence — BB %B>1 + CCI>100 + Williams %R>-20 ALL simultaneously pointing to overbought = maximum mean-reversion conviction | ETH=56.1% BTC=57.5% avg=55.2% WR ~3/day → 12/day total (Session 11) ✅',
  },
  {
    strategyId: 87,
    emoji: '📊📊',
    name: 'Double RSI + BB22',
    wr: '54-58%',
    badge: '9/DAY',
    badgeColor: 'bg-blue-900/40 text-blue-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Dual Oscillator Extreme — RSI(7)>72 AND RSI(14)>65 simultaneously at BB(20,2.2) upper = both short-term and medium-term momentum overextended | ETH=57.6% BTC=56.2% avg=55.8% WR ~9/day total (Session 12) ✅✅',
  },
  {
    strategyId: 88,
    emoji: '🗜️📈',
    name: 'BB Squeeze → Release',
    wr: '53-58%',
    badge: '7/DAY',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Volatility Fakeout — BB was extremely narrow (squeeze) then suddenly expands → price shoots to extreme = false breakout, reverses back inside | ETH=57.1% BTC=58.1% avg=55.8% WR ~7/day total (Session 12) ✅✅',
  },
  {
    strategyId: 89,
    emoji: '📏🔥',
    name: 'Wide Range Candle + BB22',
    wr: '55-56%',
    badge: '7/DAY',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Exhaustion Blowoff — Candle range >1.5×ATR at BB(20,2.2) extreme + RSI overextended = climax exhaustion candle, reversal follows | ETH=55.6% BTC=56.1% avg=55.5% WR ~7/day total (Session 12) ✅✅',
  },
  {
    strategyId: 90,
    emoji: '📉🎯',
    name: 'ADX<20 Ranging + BB22',
    wr: '54-63%',
    badge: '3/DAY',
    badgeColor: 'bg-cyan-900/40 text-cyan-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Ranging Market Reversal — ADX<20 confirms non-trending environment where mean reversion is most reliable; BB extreme at RSI extreme | BTC=63.1%! ETH=56.4% avg=57.6% WR ~3/day total (Session 12) ✅✅',
  },
  {
    strategyId: 91,
    emoji: '⏰🧮',
    name: 'Good Hours + ConnorsRSI>85',
    wr: '61-67%',
    badge: 'HIGH-WR',
    badgeColor: 'bg-green-900/40 text-green-300',
    coins: ['ETH', 'BTC'],
    desc: 'Compound Oscillator Extreme in Best Hours — ConnorsRSI>85 (RSI3+StreakRSI+Percentile) at BB extreme during proven good trading hours | ETH=67.2% BTC=61.1% WR ~0.8/day total (Session 12 High-WR) ✅✅✅',
  },
  {
    strategyId: 92,
    emoji: '🔥💎',
    name: 'GH + ADX<20 + RSI73 + MFI72',
    wr: '60-76%',
    badge: '>75% WR',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC', 'XRP'],
    desc: '5-Condition Ultra-Selective — Good Hours + ADX<20 (ranging) + RSI7>73 (deep) + MFI>72 (volume) + BB22 extreme = highest conviction signal | BTC=76.2%! XRP=72.7% avg=64.7% WR ~0.06/day (Session 12 High-WR) 🔥🔥🔥',
  },
  {
    strategyId: 93,
    emoji: '🔥💎💎',
    name: 'GH + ADX<20 + RSI73 + MFI72 + RSI14',
    wr: '67-83%',
    badge: '>75% WR',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: '6-Condition Ultra-Selective — Strat92 + RSI14>68 confirmation | BTC=83.3%! XRP=80.0%! SOL=71.4% ETH=66.7% avg=75.4% WR ~0.02/day (Session 13 High-WR) 🔥🔥🔥',
  },
  {
    strategyId: 94,
    emoji: '🔥🔥',
    name: 'GH + ADX<20 + RSI76 + MFI75',
    wr: '63-80%',
    badge: '>75% WR',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Deep Thresholds — Strat92 with RSI7>76+MFI>75 instead of 73/72 | BTC=80.0%! XRP=77.8%! SOL=62.5% ETH=63.6% avg=71.0% WR ~0.03/day (Session 13 High-WR) 🔥🔥',
  },
  {
    strategyId: 95,
    emoji: '🕐🔥',
    name: 'TightGH + ADX<20 + RSI70 + MFI68',
    wr: '70-80%',
    badge: '>75% WR',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'Tight 2-Hour Window — Best 2-3 hours only: SOL[12,13]+ETH[12,21]+BTC shared | SOL=80.0% n=44! ETH=71.4% n=46 BTC=70% avg=73.8% WR ~0.05/day (Session 13 High-WR) 🔥🔥🔥',
  },
  {
    strategyId: 96,
    emoji: '⚡🔥',
    name: 'GH + ADX<20 + RSI3>93',
    wr: '67-75%',
    badge: '>75% WR',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['BTC', 'XRP'],
    desc: 'Ultra-Fast RSI3 Extreme — RSI(3-period)>93 at BB extreme during good hours in ranging market | BTC=75.0% n=92 (best volume >75%!) XRP=66.7% ~0.10/day (Session 13 High-WR) 🔥🔥🔥',
  },
  {
    strategyId: 97,
    emoji: '🔥💥',
    name: 'GH + ADX<20 + RSI3>93 + RSI5>82 + MFI70',
    wr: '75-86%',
    badge: 'BEST BTC WR',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'Triple RSI Cascade — RSI3>93 AND RSI5>82 both extreme + MFI volume confirm at BB22 in ranging market | BTC=85.7% n=32 🔥🔥🔥 XRP=75.0% n=26 (Session 14 H3)',
  },
  {
    strategyId: 98,
    emoji: '📉🔥',
    name: 'GH + ADX<20 + WPR>-8 + RSI73 + MFI72',
    wr: '71-78%',
    badge: '>75% BTC',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'Williams %R Extreme — WPR>-8 (top 8% range) + RSI7>73 + MFI>72 at BB22 in ranging market | BTC=77.8% n=26 🔥🔥🔥 ETH=71.4% n=16 (Session 14 C4)',
  },
  {
    strategyId: 99,
    emoji: '🧠🔥',
    name: 'GH + ADX<20 + ConnorsRSI>85 + MFI72',
    wr: '75-78%',
    badge: '>75% WR',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'ConnorsRSI + MFI Volume — CRSI>85 (extreme overbought) + MFI>72 at BB22 in ranging market | BTC=77.8% n=42 (best volume in session 14!) 🔥🔥🔥 (Session 14 K2)',
  },
  {
    strategyId: 100,
    emoji: '🎯🔥',
    name: 'GH + BB(20,2.0) + RSI73 + MFI72 + RSI14',
    wr: '74-80%',
    badge: '>75% WR',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC'],
    desc: 'Intermediate BB(2.0) Triple Confirm — RSI7>73 + MFI>72 + RSI14>68 at BB(20,2.0) in ranging market | BTC=80.0% n=27 🔥🔥🔥 (Session 14 F2)',
  },
  // ── Session 15: BB(1.8) RSI3 Extreme + BB(1.0) Triple Confirm ─────────────
  {
    strategyId: 105,
    emoji: '🔥🎯',
    name: 'GH + ADX<20 + RSI3>90 + MFI70 + BB(20,1.8)',
    wr: '68-75%',
    badge: 'ETH >75%',
    badgeColor: 'bg-green-900/40 text-green-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: 'BB(1.8) RSI3 Extreme — RSI3>90 ultra-fast overbought + MFI>70 at medium-tight BB band | ETH=75.0% n=110 🔥🔥🔥 FIRST ETH >75% WR at n≥100! (Session 15 B3)',
  },
  {
    strategyId: 106,
    emoji: '🎯💎',
    name: 'GH + ADX<20 + RSI73 + MFI72 + RSI14 + BB(20,1.0)',
    wr: '67-79%',
    badge: '>75% BTC',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC'],
    desc: 'BB(1.0) Ultra-Tight Triple Confirm — RSI7>73 + MFI>72 + RSI14>68 at ultra-tight BB(1.0) | BTC=78.9% n=70 🔥🔥🔥 (Session 15 D3)',
  },
  // ── Session 16: 4h Regime Filter + Ultra-Extreme RSI3>95 ──────────────────
  {
    strategyId: 107,
    emoji: '🔥🌐',
    name: 'GH + 4h ADX<20 + RSI3>93 + MFI70 + BB22',
    wr: '62-74%',
    badge: '4h Filter NEW',
    badgeColor: 'bg-blue-900/40 text-blue-300',
    coins: ['ETH', 'BTC', 'XRP'],
    desc: '4h Regime Filter — 4h ADX<20 (broader ranging) + RSI3>93 + MFI70 at BB22 | ETH=74.5% BTC=70.5% n≈45 🔥🔥 First 4h-based strategy! (Session 16 H3)',
  },
  {
    strategyId: 108,
    emoji: '🚀🔥',
    name: 'GH + ADX<20 + RSI3>95 + MFI70 + BB22',
    wr: '71-80%',
    badge: 'XRP 80% 🔥',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['BTC', 'XRP'],
    desc: 'Ultra-Extreme RSI3>95 — hyper-overbought threshold rarely fires but very high WR | XRP=80.0% n=20 BTC=71.0% n=31 🔥🔥🔥 (Session 16 D2)',
  },
  {
    strategyId: 109,
    emoji: '💎🔥',
    name: 'GH + ADX<20 + RSI3>95 + MFI70 + BB(20,1.8)',
    wr: '70-77%',
    badge: 'XRP 77% 💎',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['BTC', 'XRP'],
    desc: 'Ultra-Extreme RSI3>95 + BB(1.8) — same as 108 but tighter band gives ~40% more signals | XRP=77.3% n=22 BTC=70.0% n=40 🔥🔥🔥 (Session 16 D3)',
  },
  {
    strategyId: 110,
    emoji: '🔥💡',
    name: 'GH + ADX<20 + StochRSI-K>85 + MFI72 + RSI14 + BB22',
    wr: '80%',
    badge: 'BTC+XRP 80% 🔥',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['BTC', 'XRP'],
    desc: 'StochRSI-K Extreme + Triple Confirm — StochK>85 + MFI>72 + RSI14>68 at BB22 in ranging market | BTC=80.0% n=44 XRP=80.0% n=37 🔥🔥🔥 (Session 16 G3)',
  },
  {
    strategyId: 111,
    emoji: '🔥🎖️',
    name: 'GH + ADX<20 + StochRSI-K>85 + MFI72 + RSI14 + BB(20,1.8)',
    wr: '82%',
    badge: 'BTC 81.8% 🏆',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['BTC'],
    desc: 'StochRSI-K Extreme + BB(1.8) — tighter band gives more signals with even higher WR | BTC=81.8% n=60 tpd=0.3 🔥🔥🔥 HIGHEST BTC StochRSI WR! (Session 16 G4)',
  },
  // ── Session 17: Quad-oscillator combos + Consecutive BB breaks ─────────────
  {
    strategyId: 112,
    emoji: '🔥🎯',
    name: 'GH + ADX<20 + RSI7>73 + StochK>80 + MFI72 + RSI14 + BB(1.8)',
    wr: '71-76%',
    badge: 'ETH+BTC 76% 🔥',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC'],
    desc: 'Quad-oscillator confluence at BB(1.8) in ranging market — RSI7 + StochK + MFI + RSI14 all extreme | BTC=75.6% n=45 ETH=70.8% n=24 🔥🔥 (Session 17 G2)',
  },
  {
    strategyId: 113,
    emoji: '🔥💡',
    name: 'XRP GH + ADX<20 + RSI3>93 + StochK>80 + MFI70 + BB22',
    wr: '73%',
    badge: 'XRP 72.7% 🔥',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['XRP'],
    desc: 'RSI3 + StochK double oscillator at BB22 in ranging XRP market = hyper-overbought exhaustion | XRP=72.7% n=33 tpd=0.2 🔥🔥 (Session 17 A4)',
  },
  {
    strategyId: 114,
    emoji: '🔥🔥',
    name: 'GH(BTC) + ADX<20 + 2-Consec BB22 + RSI3>90 + MFI68',
    wr: '71%',
    badge: 'BTC 71.4% 🔥',
    badgeColor: 'bg-blue-900/40 text-blue-300',
    coins: ['BTC'],
    desc: 'Consecutive BB breaks (2 candles above BB22) + RSI3 extreme + MFI confirm = sustained overextension reversal | BTC=71.4% n=49 tpd=0.3 🔥🔥 (Session 17 E2)',
  },
  // ── Session 18: BB%B deep overshoot + StochK>90 ultra-extreme ─────────────
  {
    strategyId: 115,
    emoji: '🔥🌊',
    name: 'GH + ADX<20 + BB%B > 1.1 + RSI3>90 + MFI70',
    wr: '72-76%',
    badge: 'ETH 75.9% 🔥',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC'],
    desc: 'Deeper BB overshoot (BB%B>1.1 = price 10% beyond upper band) + RSI3 + MFI = stronger exhaustion signal | ETH=75.9% n=29 BTC=71.4% n=42 🔥🔥🔥 (Session 18 H2)',
  },
  {
    strategyId: 116,
    emoji: '🔥💎',
    name: 'GH + ADX<20 + StochRSI-K > 90 + MFI72 + RSI14 + BB22',
    wr: '71-81%',
    badge: 'BTC 80.6% 🔥',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['ETH', 'BTC', 'XRP'],
    desc: 'Ultra-extreme StochK>90 (tighter than strat 110\'s >85) at BB22 in ranging market | BTC=80.6% n=36 ETH=68.2% XRP=70.8% n=24 🔥🔥🔥 (Session 18 C1)',
  },
  {
    strategyId: 117,
    emoji: '🔥🎯',
    name: 'XRP GH + ADX<20 + StochK>90 + RSI3>93 + MFI72 + BB22',
    wr: '71%',
    badge: 'XRP 71.4% 🔥',
    badgeColor: 'bg-purple-900/40 text-purple-300',
    coins: ['XRP'],
    desc: 'Ultra-extreme StochK>90 + RSI3>93 double-extreme at BB22 in ranging XRP market | XRP=71.4% n=28 tpd=0.2 🔥🔥 (Session 18 C3)',
  },
  // ── Session 19: Triple RSI alignment — ULTRA STABLE σ=2.9% ────────────────
  {
    strategyId: 118,
    emoji: '🏆🔥',
    name: 'GH + ADX<20 + RSI3>90 + RSI7>72 + RSI14>68 + BB22',
    wr: '80%',
    badge: 'BTC 80.6% σ=2.9% 🏆',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC', 'XRP'],
    desc: 'Triple RSI alignment: RSI3>90 + RSI7>72 + RSI14>68 simultaneously at BB(20,2.2) in ranging market | BTC=80.6% σ=2.9% ULTRA STABLE n=62 XRP=70.0% n=40 🏆🔥 (Session 19 C1)',
  },
  {
    strategyId: 119,
    emoji: '🔥🏆',
    name: 'GH + ADX<20 + RSI3>90 + RSI7>72 + RSI14>68 + MFI70 + BB22',
    wr: '82%',
    badge: 'BTC 82.1% 🔥🏆',
    badgeColor: 'bg-orange-900/40 text-orange-300',
    coins: ['ETH', 'BTC', 'XRP'],
    desc: 'Triple RSI alignment + MFI>70 money flow: RSI3+RSI7+RSI14 all extreme + MFI at BB22 | BTC=82.1% n=39 XRP=75.0% n=24 🔥🏆 (Session 19 C2)',
  },
  {
    strategyId: 120,
    emoji: '🔥💫',
    name: 'GH + ADX<20 + MFI>75 + StochK>80 + RSI14>68 + BB22',
    wr: '84%',
    badge: 'BTC 84.6% 🔥',
    badgeColor: 'bg-red-900/40 text-red-300',
    coins: ['BTC'],
    desc: 'Ultra-high MFI>75 + StochK>80 + RSI14>68 money flow confluence at BB22 in ranging BTC | BTC=84.6% n=26 σ=15.0% 🔥💫 (Session 19 A2)',
  },
  // ── Session 20: VWAP session deviation — new pattern class ────────────────
  {
    strategyId: 121,
    emoji: '📊🔥',
    name: 'BTC GH + ADX<20 + VWAP day-dev>0.3% + RSI3>90 + BB22',
    wr: '72%',
    badge: 'BTC 72.2% σ=7.8% 📊',
    badgeColor: 'bg-teal-900/40 text-teal-300',
    coins: ['BTC'],
    desc: 'Rolling intraday VWAP deviation >0.3% above session VWAP + RSI3>90 at BB22 extreme in ranging BTC | BTC=72.2% n=22 σ=7.8% ✅ STABLE tpd=0.12 (Session 20 E1)',
  },
  // ── Session 13: 1m Sub-candle + 1h Regime strategies ──────────────────────
  {
    strategyId: 101,
    emoji: '📊⚡',
    name: '1m Vol Climax + BB22',
    wr: '55-59%',
    badge: 'Session 13',
    badgeColor: 'bg-cyan-900/40 text-cyan-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: '1m bar volume > 2.2× avg20 at BB(20,2.2) extreme = distribution/accumulation exhaustion | ETH=58.4% BTC=58.9% @7/day (5-fold WF) ✅',
  },
  {
    strategyId: 102,
    emoji: '🕐📊',
    name: '1h Ranging + BB22 + Streak',
    wr: '57-59%',
    badge: 'Session 13',
    badgeColor: 'bg-cyan-900/40 text-cyan-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: '1h RSI14 in [40,62] (non-trending) + 5m streak≥1 + outside BB22 | ETH/BTC=59.0% SOL/XRP=57.0% @10-12/day (5-fold WF) ✅✅',
  },
  {
    strategyId: 103,
    emoji: '🔄📉',
    name: '1m Momentum Fade + BB22',
    wr: '54-58%',
    badge: 'Session 13',
    badgeColor: 'bg-cyan-900/40 text-cyan-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: '3 consecutive 1m candles same direction + body ratio ≥ 0.6 + outside BB22 = sub-bar momentum exhaustion | ETH/BTC=57.7% @7/day ✅',
  },
  {
    strategyId: 104,
    emoji: '🚀📊',
    name: '1m VolSpike + 1h Range + BB22',
    wr: '57-63%',
    badge: 'STAR 🌟',
    badgeColor: 'bg-yellow-900/40 text-yellow-300',
    coins: ['ETH', 'BTC', 'SOL', 'XRP'],
    desc: '1m vol > 2.5× avg + 1h RSI14 in [38,63] (ranging regime) + outside BB22 | ETH=61.2% σ=1.3% BTC=62.7% σ=2.1% XRP=59.5% @4/day (5-fold WF) 🌟',
  },
];

export function StrategyAutomation() {
  const { strategyConfigs, setStrategyConfigs, tradeSizeType, tradeSizeValue, setTradeSizeSettings, paperPnl } = useStore();
  const [localSizeValue, setLocalSizeValue] = useState<string>(String(tradeSizeValue));
  const [minConf, setMinConf] = useState(65);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchStrategyConfigs().then(setStrategyConfigs).catch(console.error);
    fetchTradeSizeSettings()
      .then(s => {
        setTradeSizeSettings(s.type, s.value);
        setLocalSizeValue(String(s.value));
      })
      .catch(console.error);
    fetchMinConfidence().then(setMinConf).catch(console.error);
  }, []);

  // Keep local input in sync when SSE updates arrive from another client
  useEffect(() => {
    setLocalSizeValue(String(tradeSizeValue));
  }, [tradeSizeValue]);

  async function toggle(strategyId: number, coin: string) {
    const cfg = strategyConfigs.find(c => c.strategyId === strategyId && c.coin === coin);
    const newVal = !(cfg?.enabled ?? false);
    // Optimistic update: add new entry if it doesn't exist yet
    if (cfg) {
      setStrategyConfigs(strategyConfigs.map(c =>
        c.strategyId === strategyId && c.coin === coin ? { ...c, enabled: newVal } : c
      ));
    } else {
      setStrategyConfigs([...strategyConfigs, { id: `strat_${strategyId}_${coin}`, strategyId, coin, enabled: newVal, tradeSize: 50 }]);
    }
    try {
      await setStrategyEnabled(strategyId, coin, newVal);
    } catch (e) {
      console.error('[StrategyAutomation] toggle error:', e);
      // Revert
      if (cfg) {
        setStrategyConfigs(strategyConfigs.map(c =>
          c.strategyId === strategyId && c.coin === coin ? { ...c, enabled: !newVal } : c
        ));
      } else {
        setStrategyConfigs(strategyConfigs.filter(c => !(c.strategyId === strategyId && c.coin === coin)));
      }
    }
  }

  function handleTypeToggle(newType: 'fixed' | 'percent') {
    if (newType === tradeSizeType) return;
    // Reset value to sensible default when switching modes
    const defaultVal = newType === 'fixed' ? 50 : 5;
    setTradeSizeSettings(newType, defaultVal);
    setLocalSizeValue(String(defaultVal));
    saveTradeSizeSettings(newType, defaultVal).catch(console.error);
  }

  function handleValueChange(raw: string) {
    setLocalSizeValue(raw);
    const num = parseFloat(raw);
    if (!isNaN(num) && num > 0) {
      if (saveTimeout.current) clearTimeout(saveTimeout.current);
      saveTimeout.current = setTimeout(() => {
        setTradeSizeSettings(tradeSizeType, num);
        saveTradeSizeSettings(tradeSizeType, num).catch(console.error);
      }, 600);
    }
  }

  function handleConfChange(val: number) {
    setMinConf(val);
    if (confSaveTimeout.current) clearTimeout(confSaveTimeout.current);
    confSaveTimeout.current = setTimeout(() => {
      saveMinConfidence(val).catch(console.error);
    }, 600);
  }

  function isEnabled(strategyId: number, coin: string) {
    return strategyConfigs.find(c => c.strategyId === strategyId && c.coin === coin)?.enabled ?? false;
  }

  const anyEnabled = strategyConfigs.some(c => c.enabled);
  const balance = paperPnl?.balance ?? 1000;

  // Compute effective trade size for display
  const effectiveSize = tradeSizeType === 'fixed'
    ? tradeSizeValue
    : Math.max(1, (tradeSizeValue / 100) * balance);

  // Aggregate totals across all enabled strategy+coin combos
  const totals = STRATEGY_META.reduce(
    (acc, s) => {
      s.coins.forEach(coin => {
        if (!isEnabled(s.strategyId, coin)) return;
        const st = resolveStats(s);
        if (!st) return;
        acc.tpd += st.tpd;
        acc.wrSum += st.tpd * st.wrNum; // tpd-weighted for avg WR
        acc.pnlPerDay += st.tpd * effectiveSize * (st.wrNum - 0.515);
      });
      return acc;
    },
    { tpd: 0, wrSum: 0, pnlPerDay: 0 },
  );
  const avgWr = totals.tpd > 0 ? (totals.wrSum / totals.tpd) * 100 : 0;
  const totalMonthly = Math.round(totals.tpd * 30);
  const totalMonthlyPnl = totals.pnlPerDay * 30;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Zap className={`w-4 h-4 ${anyEnabled ? 'text-yellow-400' : 'text-gray-600'}`} />
          <h3 className="text-sm font-semibold text-white">Strategy Automation</h3>
          {anyEnabled && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 font-medium">
              LIVE
            </span>
          )}
        </div>

        {/* Trade size control */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Per trade:</span>
          {/* Mode toggle */}
          <div className="flex rounded border border-gray-700 overflow-hidden text-xs font-semibold">
            <button
              onClick={() => handleTypeToggle('fixed')}
              className={`px-2 py-1 transition-colors ${
                tradeSizeType === 'fixed'
                  ? 'bg-blue-800 text-white'
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              $
            </button>
            <button
              onClick={() => handleTypeToggle('percent')}
              className={`px-2 py-1 transition-colors border-l border-gray-700 ${
                tradeSizeType === 'percent'
                  ? 'bg-blue-800 text-white'
                  : 'bg-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              %
            </button>
          </div>
          {/* Value input */}
          <input
            type="number"
            min={tradeSizeType === 'fixed' ? 1 : 0.1}
            max={tradeSizeType === 'fixed' ? 10000 : 100}
            step={tradeSizeType === 'fixed' ? 1 : 0.5}
            value={localSizeValue}
            onChange={e => handleValueChange(e.target.value)}
            className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white font-mono text-right focus:outline-none focus:border-blue-600"
          />
          {/* Effective size hint */}
          {tradeSizeType === 'percent' && (
            <span className="text-xs text-gray-500 font-mono">
              ≈${effectiveSize.toFixed(0)}
            </span>
          )}
        </div>
      </div>

      {/* Confidence Slider */}
      {(() => {
        const { wr, tpd } = interpConf(minConf);
        const edge = wr - 0.515;
        const effectiveSz = tradeSizeType === 'fixed'
          ? tradeSizeValue
          : Math.max(1, (tradeSizeValue / 100) * balance);
        const dailyProfit = tpd * effectiveSz * edge;
        const edgeColor = edge > 0.05 ? 'text-emerald-400' : edge > 0 ? 'text-yellow-400' : 'text-red-400';
        const profitColor = dailyProfit > 0 ? 'text-emerald-400' : 'text-red-400';
        return (
          <div className="px-4 py-3 border-b border-gray-800 bg-gray-900/30">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-400 font-medium">Min Signal Confidence</span>
              <span className="text-sm font-mono font-bold text-white">{minConf}%</span>
            </div>
            <input
              type="range"
              min={30}
              max={90}
              step={1}
              value={minConf}
              onChange={e => handleConfChange(Number(e.target.value))}
              className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-gray-700 accent-blue-500"
            />
            <div className="flex justify-between text-xs text-gray-600 mt-1 mb-3">
              <span>◀ Strict</span>
              <span>Liberal ▶</span>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="bg-gray-800/60 rounded p-1.5">
                <div className="text-xs text-gray-500 mb-0.5">trades/day</div>
                <div className="text-sm font-mono font-semibold text-white">~{tpd < 1 ? tpd.toFixed(1) : Math.round(tpd)}</div>
              </div>
              <div className="bg-gray-800/60 rounded p-1.5">
                <div className="text-xs text-gray-500 mb-0.5">WR estimate</div>
                <div className="text-sm font-mono font-semibold text-white">~{(wr * 100).toFixed(0)}%</div>
              </div>
              <div className="bg-gray-800/60 rounded p-1.5">
                <div className="text-xs text-gray-500 mb-0.5">edge/trade</div>
                <div className={`text-sm font-mono font-semibold ${edgeColor}`}>{edge >= 0 ? '+' : ''}{(edge * 100).toFixed(1)}%</div>
              </div>
              <div className="bg-gray-800/60 rounded p-1.5">
                <div className="text-xs text-gray-500 mb-0.5">daily profit</div>
                <div className={`text-sm font-mono font-semibold ${profitColor}`}>{dailyProfit >= 0 ? '+' : ''}${dailyProfit.toFixed(0)}</div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Active Strategies Summary */}
      {anyEnabled && (
        <div className="px-4 py-2.5 border-b border-gray-700 bg-gray-800/40 flex items-center gap-4 flex-wrap">
          <span className="text-xs text-gray-400 font-medium uppercase tracking-wide shrink-0">Active total</span>
          <div className="flex items-center gap-3 flex-wrap text-xs font-mono">
            <span className="text-white">
              ~{totals.tpd < 1 ? totals.tpd.toFixed(1) : totals.tpd.toFixed(1)}<span className="text-gray-500">/day</span>
            </span>
            <span className="text-gray-600">·</span>
            <span className="text-white">
              ~{totalMonthly}<span className="text-gray-500">/mo</span>
            </span>
            <span className="text-gray-600">·</span>
            <span className="text-cyan-400 font-semibold">
              {avgWr.toFixed(1)}%<span className="text-gray-500 font-normal"> avg WR</span>
            </span>
            <span className="text-gray-600">·</span>
            <span className={totals.pnlPerDay >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
              {totals.pnlPerDay >= 0 ? '+' : ''}${totals.pnlPerDay.toFixed(1)}<span className="text-gray-500 font-normal">/day</span>
            </span>
            <span className="text-gray-600">·</span>
            <span className={totalMonthlyPnl >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
              {totalMonthlyPnl >= 0 ? '+' : ''}${Math.round(totalMonthlyPnl)}<span className="text-gray-500 font-normal">/mo est.</span>
            </span>
          </div>
        </div>
      )}

      {/* Strategy Cards — 2-column grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3">
        {STRATEGY_META.map(s => {
          const anyOn = s.coins.some(c => isEnabled(s.strategyId, c));
          const st = resolveStats(s);
          const edge = st ? st.wrNum - 0.515 : null;
          const pnlPerTrade = (st && edge !== null) ? effectiveSize * edge : null;
          const wrNum = parseFloat(s.wr);
          const wrColor = wrNum >= 80 ? 'text-amber-300' : wrNum >= 70 ? 'text-emerald-400' : wrNum >= 65 ? 'text-cyan-400' : wrNum >= 60 ? 'text-blue-400' : 'text-yellow-400';
          const pnlColor = pnlPerTrade !== null ? (pnlPerTrade > 2 ? 'text-emerald-400' : pnlPerTrade > 0 ? 'text-yellow-400' : 'text-red-400') : 'text-gray-400';

          return (
            <div
              key={s.strategyId}
              className={`rounded-xl border p-3 flex flex-col gap-2.5 transition-all duration-200 ${
                anyOn
                  ? 'border-emerald-500/50 bg-gradient-to-br from-emerald-950/50 to-gray-800/80 shadow-lg shadow-emerald-900/20'
                  : 'border-gray-700/40 bg-gray-800/25 hover:border-gray-600/60 hover:bg-gray-800/50'
              }`}
            >
              {/* Top row: emoji + name + badge + WR */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-base leading-none shrink-0">{s.emoji}</span>
                  <span className="text-sm font-bold text-white leading-snug">{s.name}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {s.badge && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold leading-none ${s.badgeColor}`}>
                      {s.badge}
                    </span>
                  )}
                  {anyOn && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                      LIVE
                    </span>
                  )}
                </div>
              </div>

              {/* Stats row: WR | trades/day | edge/trade */}
              <div className="flex items-stretch gap-0 rounded-lg overflow-hidden border border-gray-700/40">
                <div className="flex-1 flex flex-col items-center justify-center py-1.5 bg-gray-900/50">
                  <span className={`text-lg font-black font-mono leading-none ${wrColor}`}>{s.wr}</span>
                  <span className="text-[9px] text-gray-500 mt-0.5 uppercase tracking-wide">win rate</span>
                </div>
                {st && (
                  <>
                    <div className="w-px bg-gray-700/40" />
                    <div className="flex-1 flex flex-col items-center justify-center py-1.5 bg-gray-900/50">
                      <span className="text-sm font-bold font-mono text-white leading-none">
                        {st.tpd >= 10 ? Math.round(st.tpd) : st.tpd < 1 ? st.tpd.toFixed(1) : st.tpd.toFixed(1)}/d
                      </span>
                      <span className="text-[9px] text-gray-500 mt-0.5 uppercase tracking-wide">trades</span>
                    </div>
                    <div className="w-px bg-gray-700/40" />
                    <div className="flex-1 flex flex-col items-center justify-center py-1.5 bg-gray-900/50">
                      <span className={`text-sm font-bold font-mono leading-none ${pnlColor}`}>
                        {pnlPerTrade !== null ? `${pnlPerTrade >= 0 ? '+' : ''}$${pnlPerTrade.toFixed(1)}` : '—'}
                      </span>
                      <span className="text-[9px] text-gray-500 mt-0.5 uppercase tracking-wide">per trade</span>
                    </div>
                  </>
                )}
              </div>

              {/* Description — full text, readable */}
              <p className="text-xs text-gray-300 leading-relaxed">{s.desc}</p>

              {/* Coin toggle buttons */}
              <div className="flex gap-1.5">
                {s.coins.map(coin => {
                  const on = isEnabled(s.strategyId, coin);
                  return (
                    <button
                      key={coin}
                      onClick={() => toggle(s.strategyId, coin)}
                      className={`flex-1 py-1.5 rounded-lg text-xs font-bold tracking-wide transition-all duration-150 border flex flex-col items-center gap-0.5 ${
                        on
                          ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/60 shadow-sm shadow-emerald-900/50 hover:bg-emerald-500/30'
                          : 'bg-gray-700/30 text-gray-400 border-gray-600/30 hover:bg-gray-700/60 hover:text-white hover:border-gray-500/60'
                      }`}
                    >
                      <span>{on ? '● ' : '○ '}{coin}</span>
                      {st && (
                        <span className={`text-[10px] font-normal leading-none ${on ? 'text-emerald-300/70' : 'text-gray-500'}`}>
                          {((st.coinWr?.[coin] ?? st.wrNum) * 100).toFixed(0)}% · {st.tpd >= 10 ? Math.round(st.tpd) : st.tpd < 1 ? st.tpd.toFixed(1) : st.tpd.toFixed(1)}/d
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer note */}
      <div className="px-4 py-2 border-t border-gray-800 bg-gray-900/50">
        <p className="text-xs text-gray-500">
          Signals: BTC every 5s · ETH every 10s · SOL/XRP every 15s · conf ≥{minConf}% · one position per strategy per coin
        </p>
      </div>
    </div>
  );
}
