const Database = require("better-sqlite3");
const path = require("path");
const DB_PATH = path.join(__dirname, "../../trader.db");
const db = new Database(DB_PATH, { readonly: true });

interface Candle { open_time: number; open: number; high: number; low: number; close: number; volume: number; }
interface BB { upper: number; lower: number; std: number; }
interface RunResult { wr: number; wins: number; trades: number; }
interface WFResult { wr: number; sigma: number; total: number; folds: number[]; }

function loadCandles(sym: string, tf: string): Candle[] {
  return db.prepare("SELECT open_time,open,high,low,close,volume FROM candles WHERE symbol=? AND timeframe=? ORDER BY open_time").all(sym, tf);
}
function calcBB(c: Candle[], end: number, p: number = 20, m: number = 2.0): BB | null {
  if (end < p-1) return null;
  const sl = c.slice(end-p+1, end+1).map((x: Candle) => x.close);
  const mean = sl.reduce((a: number, b: number) => a+b, 0)/p;
  const std = Math.sqrt(sl.reduce((s: number, v: number) => s+Math.pow(v-mean, 2), 0)/p);
  return { upper: mean+m*std, lower: mean-m*std, std };
}
function calcATR(c: Candle[], end: number, p: number = 14): number {
  if (end < p) return 0;
  let s = 0;
  for (let i = end-p+1; i <= end; i++) {
    const tr = Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close));
    s += tr;
  }
  return s/p;
}
function calcRSI(c: Candle[], end: number, p: number = 14): number {
  if (end < p) return 50;
  let g = 0, l = 0;
  for (let i = end-p+1; i <= end; i++) {
    const d = c[i].close - c[i-1].close;
    if (d > 0) g += d; else l += Math.abs(d);
  }
  if (l === 0) return 100;
  return 100 - 100/(1+g/l);
}
function calcMFI(c: Candle[], end: number, p: number = 10): number {
  if (end < p) return 50;
  let pos = 0, neg = 0;
  for (let i = end-p+1; i <= end; i++) {
    const tp = (c[i].high+c[i].low+c[i].close)/3;
    const prevTp = i > 0 ? (c[i-1].high+c[i-1].low+c[i-1].close)/3 : tp;
    const mf = tp*c[i].volume;
    if (tp >= prevTp) pos += mf; else neg += mf;
  }
  if (neg === 0) return 100;
  return 100-100/(1+pos/neg);
}
function gd(c: Candle): string { return c.close >= c.open ? "G" : "R"; }
function streak(c: Candle[], i: number, mx: number = 8): number {
  const d = gd(c[i]); let n = 1;
  for (let j = i-1; j >= Math.max(0, i-mx); j--) { if (gd(c[j]) === d) n++; else break; }
  return n;
}
function seq4(c: Candle[], i: number): string {
  if (i < 3) return "";
  return [gd(c[i-3]), gd(c[i-2]), gd(c[i-1]), gd(c[i])].join("");
}

interface RunOpts {
  sym: string; tf: string; bbP?: number; bbM?: number;
  minStr?: number; pats?: string[]; hrs?: number[] | null; skipH?: number[];
  rsiOB?: number; rsiBull?: number; mfiOB?: number; bodyATR?: boolean;
  devMin?: number; devMax?: number;
}

function run(opts: RunOpts): RunResult {
  const { sym, tf } = opts;
  const bbP = opts.bbP ?? 20, bbM = opts.bbM ?? 2.0;
  const minStr = opts.minStr ?? 0, pats = opts.pats ?? [];
  const hrs = opts.hrs ?? null, skipH = opts.skipH ?? [];
  const rsiOB = opts.rsiOB ?? 0, rsiBull = opts.rsiBull ?? 0;
  const mfiOB = opts.mfiOB ?? 0, bodyATR = opts.bodyATR ?? false;
  const devMin = opts.devMin ?? 0, devMax = opts.devMax ?? 1;
  const ca = loadCandles(sym, tf);
  if (ca.length < 100) return { wr: 0, wins: 0, trades: 0 };
  const res: number[] = [];
  const si = Math.max(bbP+14, 25);
  for (let i = si; i < ca.length-1; i++) {
    const x = ca[i];
    const h = new Date(x.open_time).getUTCHours();
    if (hrs !== null && !hrs.includes(h)) continue;
    if (skipH.length > 0 && skipH.includes(h)) continue;
    const bb = calcBB(ca, i, bbP, bbM);
    if (!bb) continue;
    const p = x.close, isBear = p > bb.upper, isBull = p < bb.lower;
    if (!isBear && !isBull) continue;
    if (devMin > 0 || devMax < 1) {
      const dev = isBear ? (p-bb.upper)/bb.upper : (bb.lower-p)/bb.lower;
      if (dev < devMin) continue;
      if (devMax < 1 && dev > devMax) continue;
    }
    if (minStr > 0) {
      const d = gd(x), st = streak(ca, i);
      if (isBear && (d !== "G" || st < minStr)) continue;
      if (isBull && (d !== "R" || st < minStr)) continue;
    }
    if (pats.length > 0 && !pats.includes(seq4(ca, i))) continue;
    if (bodyATR) { const atr = calcATR(ca, i); if (!atr || Math.abs(x.close-x.open)/atr < 0.3) continue; }
    if (rsiOB > 0 || rsiBull > 0) {
      const rsi = calcRSI(ca, i);
      if (isBear && rsiOB > 0 && rsi < rsiOB) continue;
      if (isBull && rsiBull > 0 && rsi > rsiBull) continue;
    }
    if (mfiOB > 0) {
      const mfi = calcMFI(ca, i);
      if (isBear && mfi < mfiOB) continue;
      if (isBull && mfi > (100-mfiOB)) continue;
    }
    const nxt = ca[i+1];
    const ok = isBear ? nxt.close < nxt.open : nxt.close > nxt.open;
    res.push(ok ? 1 : 0);
  }
  const w = res.filter(v => v === 1).length;
  return { wr: res.length > 0 ? w/res.length : 0, wins: w, trades: res.length };
}

function wf3(opts: RunOpts, folds: number = 3): WFResult {
  const { sym, tf } = opts;
  const bbP = opts.bbP ?? 20, bbM = opts.bbM ?? 2.0;
  const minStr = opts.minStr ?? 0, pats = opts.pats ?? [];
  const hrs = opts.hrs ?? null, skipH = opts.skipH ?? [];
  const rsiOB = opts.rsiOB ?? 0, rsiBull = opts.rsiBull ?? 0;
  const mfiOB = opts.mfiOB ?? 0, bodyATR = opts.bodyATR ?? false;
  const ca = loadCandles(sym, tf);
  if (ca.length < 300) return { wr: 0, sigma: 99, total: 0, folds: [] };
  const fsz = Math.floor(ca.length/folds);
  const frs: number[] = [];
  let tw = 0, tt = 0;
  const si = Math.max(bbP+14, 25);
  for (let f = 0; f < folds; f++) {
    const fs2 = Math.max(f*fsz, si);
    const fe = (f === folds-1) ? ca.length-1 : (f+1)*fsz-1;
    const fc = ca.slice(0, fe+1);
    const res: number[] = [];
    for (let i = fs2; i < fe; i++) {
      const x = fc[i];
      const h = new Date(x.open_time).getUTCHours();
      if (hrs !== null && !hrs.includes(h)) continue;
      if (skipH.length > 0 && skipH.includes(h)) continue;
      const bb = calcBB(fc, i, bbP, bbM);
      if (!bb) continue;
      const p = x.close, isBear = p > bb.upper, isBull = p < bb.lower;
      if (!isBear && !isBull) continue;
      if (minStr > 0) {
        const d = gd(x), st = streak(fc, i);
        if (isBear && (d !== "G" || st < minStr)) continue;
        if (isBull && (d !== "R" || st < minStr)) continue;
      }
      if (pats.length > 0 && !pats.includes(seq4(fc, i))) continue;
      if (bodyATR) { const atr = calcATR(fc, i); if (!atr || Math.abs(x.close-x.open)/atr < 0.3) continue; }
      if (rsiOB > 0 || rsiBull > 0) {
        const rsi = calcRSI(fc, i);
        if (isBear && rsiOB > 0 && rsi < rsiOB) continue;
        if (isBull && rsiBull > 0 && rsi > rsiBull) continue;
      }
      if (mfiOB > 0) {
        const mfi = calcMFI(fc, i);
        if (isBear && mfi < mfiOB) continue;
        if (isBull && mfi > (100-mfiOB)) continue;
      }
      const nxt = fc[i+1];
      if (!nxt) continue;
      const ok = isBear ? nxt.close < nxt.open : nxt.close > nxt.open;
      res.push(ok ? 1 : 0);
    }
    const fw = res.filter(v => v === 1).length;
    frs.push(res.length > 0 ? fw/res.length : 0);
    tw += fw; tt += res.length;
  }
  const mn = frs.reduce((a, b) => a+b, 0)/folds;
  const sg = Math.sqrt(frs.reduce((s, w) => s+Math.pow(w-mn, 2), 0)/folds);
  return { wr: mn, sigma: sg, total: tt, folds: frs };
}

function pr(nm: string, r: RunResult, base: number = 0.60): void {
  const flag = r.wr >= base+0.08 && r.trades >= 20 ? " ***" : r.wr >= base+0.04 && r.trades >= 10 ? " **" : r.wr >= base && r.trades >= 5 ? " *" : "";
  console.log("  " + nm.padEnd(62) + " WR=" + (r.wr*100).toFixed(1).padStart(5) + "%  T=" + String(r.trades).padStart(4) + flag);
}

function prWF(nm: string, w: WFResult): void {
  const fs = w.folds.map(v => (v*100).toFixed(1)).join("/");
  const flag = w.wr >= 0.67 && w.sigma <= 0.07 && w.total >= 20 ? " *** VALIDATED" :
               w.wr >= 0.63 && w.sigma <= 0.10 && w.total >= 12 ? " ** PROMISING" :
               w.wr >= 0.58 && w.total >= 8 ? " * MARGINAL" : " (weak)";
  console.log("  " + nm.padEnd(62) + " WR=" + (w.wr*100).toFixed(1).padStart(5) + "%  sig=" + (w.sigma*100).toFixed(1).padStart(4) + "%  T=" + String(w.total).padStart(4) + "  [" + fs + "]" + flag);
}

// ─── Check available data ───────────────────────────────────────────
const solCheck = loadCandles("SOL", "5m");
const xrpCheck = loadCandles("XRP", "5m");
const sol15Check = loadCandles("SOL", "15m");
const xrp15Check = loadCandles("XRP", "15m");
console.log(`\nData availability:`);
console.log(`  SOL/5m:  ${solCheck.length} candles`);
console.log(`  SOL/15m: ${sol15Check.length} candles`);
console.log(`  XRP/5m:  ${xrpCheck.length} candles`);
console.log(`  XRP/15m: ${xrp15Check.length} candles`);

// ─── ETH/5m Sanity Check ────────────────────────────────────────────
console.log("\n══ ETH/5m SANITY CHECK (expect ~70% WR) ══");
prWF("ETH/5m GoodH[10,11,12,21]+BB(20,2.2)+streak≥2", wf3({ sym: "ETH", tf: "5m", bbP: 20, bbM: 2.2, minStr: 2, hrs: [10,11,12,21] }));

// ─── SOL/5m Hour Sweep ──────────────────────────────────────────────
console.log("\n══ SOL/5m BASELINE BB ONLY ══");
pr("SOL/5m BB(20,2) all hours", run({ sym: "SOL", tf: "5m" }));
pr("SOL/5m BB(20,2) streak≥2", run({ sym: "SOL", tf: "5m", minStr: 2 }));
pr("SOL/5m BB(20,2.2) streak≥2", run({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 2 }));

console.log("\n══ SOL/5m HOUR SWEEP (BB(20,2.2)+streak≥2) ══");
const hours5m = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
for (const h of hours5m) {
  const r = run({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 2, hrs: [h] });
  if (r.trades >= 5) pr(`SOL/5m h=${h}UTC + BB(20,2.2)+streak≥2`, r);
}

console.log("\n══ SOL/5m GOOD HOURS COMBOS ══");
// Test best ETH hours
pr("SOL/5m GoodH[10,11,12,21]+BB(20,2.2)+streak≥2", run({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 2, hrs: [10,11,12,21] }));
pr("SOL/5m GoodH[10,11,12,21]+BB(20,2)+streak≥2",   run({ sym: "SOL", tf: "5m", minStr: 2, hrs: [10,11,12,21] }));
pr("SOL/5m AllH + BB(20,2.2) + streak≥2 + bodyATR",  run({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 2, bodyATR: true }));
pr("SOL/5m GoodH + BB(20,2.2) + streak≥2 + bodyATR", run({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 2, hrs: [10,11,12,21], bodyATR: true }));

// RSI panic
pr("SOL/5m GoodH+BB(20,2.2)+RSI>70",  run({ sym: "SOL", tf: "5m", bbM: 2.2, hrs: [10,11,12,21], rsiOB: 70 }));
pr("SOL/5m AllH+BB(20,2.2)+RSI>70",   run({ sym: "SOL", tf: "5m", bbM: 2.2, rsiOB: 70 }));
pr("SOL/5m AllH+BB(20,2.2)+RSI>70+s≥2", run({ sym: "SOL", tf: "5m", bbM: 2.2, rsiOB: 70, minStr: 2 }));

// MFI
pr("SOL/5m AllH+BB(20,2)+MFI>80",    run({ sym: "SOL", tf: "5m", mfiOB: 80 }));
pr("SOL/5m AllH+BB(20,2)+MFI>80+s≥2", run({ sym: "SOL", tf: "5m", mfiOB: 80, minStr: 2 }));

console.log("\n══ SOL/5m PATTERNS ══");
pr("SOL/5m RGGG+BB(20,2.2) all hours", run({ sym: "SOL", tf: "5m", bbM: 2.2, pats: ["RGGG","GRGG"] }));
pr("SOL/5m GGG (streak≥3)+BB(20,2.2)", run({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 3 }));
pr("SOL/5m GGGG (streak≥4)+BB(20,2.2)", run({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 4 }));

// ─── SOL/15m ────────────────────────────────────────────────────────
console.log("\n══ SOL/15m BASELINE ══");
pr("SOL/15m BB(20,2) all hours", run({ sym: "SOL", tf: "15m" }));
pr("SOL/15m BB(15,2.2) all hours", run({ sym: "SOL", tf: "15m", bbP: 15, bbM: 2.2 }));
pr("SOL/15m BB(20,2.2) all hours", run({ sym: "SOL", tf: "15m", bbM: 2.2 }));

console.log("\n══ SOL/15m HOUR SWEEP ══");
for (const h of hours5m) {
  const r = run({ sym: "SOL", tf: "15m", bbM: 2.2, minStr: 2, hrs: [h] });
  if (r.trades >= 5) pr(`SOL/15m h=${h}UTC + BB(20,2.2)+streak≥2`, r);
}

console.log("\n══ SOL/15m PATTERNS ══");
pr("SOL/15m RGGG+BB(15,2.2)", run({ sym: "SOL", tf: "15m", bbP: 15, bbM: 2.2, pats: ["RGGG","GRGG"] }));
pr("SOL/15m RGGG+BB(20,2.2)", run({ sym: "SOL", tf: "15m", bbM: 2.2, pats: ["RGGG","GRGG"] }));
pr("SOL/15m GGG+BB(15,2.2)+bodyATR", run({ sym: "SOL", tf: "15m", bbP: 15, bbM: 2.2, minStr: 3, bodyATR: true }));
pr("SOL/15m MFI>80+BB(15,2.2)+s≥2", run({ sym: "SOL", tf: "15m", bbP: 15, bbM: 2.2, mfiOB: 80, minStr: 2 }));
pr("SOL/15m MFI>80+BB(20,2.0)+s≥2", run({ sym: "SOL", tf: "15m", mfiOB: 80, minStr: 2 }));

// ─── XRP/5m Hour Sweep ──────────────────────────────────────────────
console.log("\n══ XRP/5m BASELINE ══");
pr("XRP/5m BB(20,2) all hours", run({ sym: "XRP", tf: "5m" }));
pr("XRP/5m BB(20,2) streak≥2", run({ sym: "XRP", tf: "5m", minStr: 2 }));
pr("XRP/5m BB(20,2.2) streak≥2", run({ sym: "XRP", tf: "5m", bbM: 2.2, minStr: 2 }));

console.log("\n══ XRP/5m HOUR SWEEP ══");
for (const h of hours5m) {
  const r = run({ sym: "XRP", tf: "5m", bbM: 2.2, minStr: 2, hrs: [h] });
  if (r.trades >= 5) pr(`XRP/5m h=${h}UTC + BB(20,2.2)+streak≥2`, r);
}

console.log("\n══ XRP/5m GOOD HOURS COMBOS ══");
pr("XRP/5m GoodH[10,11,12,21]+BB(20,2.2)+s≥2",   run({ sym: "XRP", tf: "5m", bbM: 2.2, minStr: 2, hrs: [10,11,12,21] }));
pr("XRP/5m AllH+BB(20,2.2)+RSI>70",               run({ sym: "XRP", tf: "5m", bbM: 2.2, rsiOB: 70 }));
pr("XRP/5m GoodH+BB(20,2.2)+RSI>70",              run({ sym: "XRP", tf: "5m", bbM: 2.2, rsiOB: 70, hrs: [10,11,12,21] }));
pr("XRP/5m AllH+BB(20,2)+MFI>80+s≥2",            run({ sym: "XRP", tf: "5m", mfiOB: 80, minStr: 2 }));

console.log("\n══ XRP/5m PATTERNS ══");
pr("XRP/5m RGGG+BB(20,2.2)", run({ sym: "XRP", tf: "5m", bbM: 2.2, pats: ["RGGG","GRGG"] }));
pr("XRP/5m GGG+BB(20,2.2)+bodyATR", run({ sym: "XRP", tf: "5m", bbM: 2.2, minStr: 3, bodyATR: true }));

// ─── XRP/15m ────────────────────────────────────────────────────────
console.log("\n══ XRP/15m BASELINE ══");
pr("XRP/15m BB(20,2) all hours", run({ sym: "XRP", tf: "15m" }));
pr("XRP/15m BB(15,2.2) all hours", run({ sym: "XRP", tf: "15m", bbP: 15, bbM: 2.2 }));
pr("XRP/15m BB(20,2.2) all hours", run({ sym: "XRP", tf: "15m", bbM: 2.2 }));

console.log("\n══ XRP/15m HOUR SWEEP ══");
for (const h of hours5m) {
  const r = run({ sym: "XRP", tf: "15m", bbM: 2.2, minStr: 2, hrs: [h] });
  if (r.trades >= 5) pr(`XRP/15m h=${h}UTC + BB(20,2.2)+streak≥2`, r);
}

console.log("\n══ XRP/15m PATTERNS ══");
pr("XRP/15m RGGG+BB(15,2.2)", run({ sym: "XRP", tf: "15m", bbP: 15, bbM: 2.2, pats: ["RGGG","GRGG"] }));
pr("XRP/15m MFI>80+BB(20,2)+s≥2", run({ sym: "XRP", tf: "15m", mfiOB: 80, minStr: 2 }));
pr("XRP/15m MFI>80+BB(15,2.2)+s≥2", run({ sym: "XRP", tf: "15m", bbP: 15, bbM: 2.2, mfiOB: 80, minStr: 2 }));
pr("XRP/15m GGG+BB(15,2.2)+bodyATR", run({ sym: "XRP", tf: "15m", bbP: 15, bbM: 2.2, minStr: 3, bodyATR: true }));

// ─── Walk-Forward Validation for promising candidates ────────────────
console.log("\n══ WALK-FORWARD VALIDATION — TOP CANDIDATES ══");

// SOL candidates
prWF("SOL/5m GoodH[10,11,12,21]+BB(20,2.2)+s≥2",   wf3({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 2, hrs: [10,11,12,21] }));
prWF("SOL/5m AllH+BB(20,2.2)+s≥2",                  wf3({ sym: "SOL", tf: "5m", bbM: 2.2, minStr: 2 }));
prWF("SOL/5m AllH+BB(20,2.2)+RSI>70",               wf3({ sym: "SOL", tf: "5m", bbM: 2.2, rsiOB: 70 }));
prWF("SOL/5m AllH+BB(20,2.2)+RSI>70+s≥2",           wf3({ sym: "SOL", tf: "5m", bbM: 2.2, rsiOB: 70, minStr: 2 }));
prWF("SOL/5m AllH+BB(20,2)+MFI>80+s≥2",            wf3({ sym: "SOL", tf: "5m", mfiOB: 80, minStr: 2 }));
prWF("SOL/15m RGGG+BB(15,2.2)",                      wf3({ sym: "SOL", tf: "15m", bbP: 15, bbM: 2.2, pats: ["RGGG","GRGG"] }));
prWF("SOL/15m MFI>80+BB(20,2)+s≥2",                 wf3({ sym: "SOL", tf: "15m", mfiOB: 80, minStr: 2 }));
prWF("SOL/15m BB(15,2.2)+s≥2",                       wf3({ sym: "SOL", tf: "15m", bbP: 15, bbM: 2.2, minStr: 2 }));

// XRP candidates
prWF("XRP/5m GoodH[10,11,12,21]+BB(20,2.2)+s≥2",   wf3({ sym: "XRP", tf: "5m", bbM: 2.2, minStr: 2, hrs: [10,11,12,21] }));
prWF("XRP/5m AllH+BB(20,2.2)+s≥2",                  wf3({ sym: "XRP", tf: "5m", bbM: 2.2, minStr: 2 }));
prWF("XRP/5m AllH+BB(20,2.2)+RSI>70",               wf3({ sym: "XRP", tf: "5m", bbM: 2.2, rsiOB: 70 }));
prWF("XRP/15m RGGG+BB(15,2.2)",                      wf3({ sym: "XRP", tf: "15m", bbP: 15, bbM: 2.2, pats: ["RGGG","GRGG"] }));
prWF("XRP/15m MFI>80+BB(20,2)+s≥2",                 wf3({ sym: "XRP", tf: "15m", mfiOB: 80, minStr: 2 }));
prWF("XRP/15m BB(15,2.2)+s≥2",                       wf3({ sym: "XRP", tf: "15m", bbP: 15, bbM: 2.2, minStr: 2 }));

console.log("\n✓ SOL/XRP research complete");
