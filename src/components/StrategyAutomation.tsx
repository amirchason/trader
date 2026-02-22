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

// Per-strategy stats: tpd = avg trades/day per coin, wrNum = numeric WR for edge calc
// Sources: 6-month walk-forward backtest data (T = total trades over period)
const STRAT_STATS: Record<number, { tpd: number; wrNum: number }> = {
  // ── Tier 1 ETH ──
  18: { tpd: 0.67, wrNum: 0.711 }, // T=121/6mo
  16: { tpd: 0.57, wrNum: 0.731 }, // T=102/6mo
  17: { tpd: 0.44, wrNum: 0.734 }, // T=79/6mo
  15: { tpd: 0.70, wrNum: 0.698 }, // T=126/6mo
  13: { tpd: 0.80, wrNum: 0.671 }, // T=303/6mo with dev[0.05-0.25%] filter
  // ── Tier 2 Cross-coin ──
  14: { tpd: 0.17, wrNum: 0.759 }, // T≈29 ETH + 33 BTC / 6mo (sniper)
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
  41: { tpd: 0.20, wrNum: 0.691 }, // Saturday only (1/7 days)
  42: { tpd: 0.50, wrNum: 0.671 }, // SOL RSI Streak, stable
  // ── BTC 5m ──
  43: { tpd: 0.50, wrNum: 0.816 }, // MFI+BB+5 good hours, ultra stable
  44: { tpd: 1.20, wrNum: 0.805 }, // T=221 over period, ~1.2/day
  45: { tpd: 1.70, wrNum: 0.797 }, // HIGH FREQ ~1.7/day (from desc, T=310/yr)
  46: { tpd: 0.90, wrNum: 0.831 }, // T=161 over period
};

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
    wr: '73%',
    badge: 'HF40',
    badgeColor: 'bg-green-900/40 text-green-300',
    coins: ['ETH', 'BTC', 'SOL'],
    desc: 'ALL hours BB(20,1.8)+s≥1 — ETH 73.1% σ=0.7% | BTC 73.4% σ=0.7% | SOL 71.7% σ=0.4% | 40-43/day!',
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
        const st = STRAT_STATS[s.strategyId];
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

      {/* Strategy List */}
      <div className="divide-y divide-gray-800/40">
        {STRATEGY_META.map(s => (
          <div key={s.strategyId} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800/20 transition-colors">
            {/* Emoji */}
            <span className="text-sm shrink-0 leading-none">{s.emoji}</span>

            {/* Info — 2 compact lines */}
            <div className="flex-1 min-w-0">
              {/* Line 1: name · badge · WR */}
              <div className="flex items-center gap-1.5 leading-tight flex-wrap">
                <span className="text-xs font-semibold text-white">{s.name}</span>
                {s.badge && (
                  <span className={`text-[10px] px-1 py-px rounded font-semibold leading-none ${s.badgeColor}`}>
                    {s.badge}
                  </span>
                )}
                <span className="text-xs font-mono font-bold text-emerald-400">{s.wr}</span>
              </div>
              {/* Line 2: desc + stats */}
              <div className="flex items-center gap-1 flex-wrap text-[10px] leading-tight mt-px">
                <span className="text-gray-600 truncate max-w-xs">{s.desc}</span>
                {STRAT_STATS[s.strategyId] && (() => {
                  const st = STRAT_STATS[s.strategyId];
                  const monthly = Math.round(st.tpd * 30);
                  const edge = st.wrNum - 0.515;
                  const pnlPerTrade = effectiveSize * edge;
                  const pnlColor = edge > 0.05 ? 'text-emerald-500' : edge > 0 ? 'text-yellow-500' : 'text-red-500';
                  return (
                    <>
                      <span className="text-gray-700 shrink-0">·</span>
                      <span className="text-gray-500 font-mono shrink-0">~{st.tpd < 1 ? st.tpd.toFixed(1) : Math.round(st.tpd)}/d</span>
                      <span className="text-gray-700 shrink-0">·</span>
                      <span className="text-gray-500 font-mono shrink-0">~{monthly}/mo</span>
                      <span className="text-gray-700 shrink-0">·</span>
                      <span className={`font-mono shrink-0 ${pnlColor}`}>{pnlPerTrade >= 0 ? '+' : ''}${pnlPerTrade.toFixed(1)}/tr</span>
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Coin toggles */}
            <div className="flex items-center gap-1 shrink-0">
              {s.coins.map(coin => {
                const on = isEnabled(s.strategyId, coin);
                return (
                  <button
                    key={coin}
                    onClick={() => toggle(s.strategyId, coin)}
                    title={`${on ? 'Disable' : 'Enable'} ${s.name} on ${coin}`}
                    className={`px-2 py-0.5 rounded text-[10px] font-bold border transition-all duration-150 ${
                      on
                        ? 'bg-emerald-900/60 text-emerald-300 border-emerald-600'
                        : 'bg-gray-800/60 text-gray-500 border-gray-700 hover:border-gray-500 hover:text-gray-300'
                    }`}
                  >
                    {coin}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer note */}
      <div className="px-4 py-2 border-t border-gray-800 bg-gray-900/50">
        <p className="text-xs text-gray-600">
          Signals checked every 5s (BTC) / 30s (ETH) · conf ≥{minConf}% · one position per strategy per coin
        </p>
      </div>
    </div>
  );
}
