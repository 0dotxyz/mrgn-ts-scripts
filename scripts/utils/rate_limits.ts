import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import BigNumber from "bignumber.js";

import { assetGroups } from "../meta/asset_groups";

// Rate-limit policy and data access shared by the analysis report
// (scripts/api_fetch/rate_limit_outflow_analysis.ts) and the tx-emitting
// admin script (scripts/admin/configure_bank_rate_limits.ts), so the numbers
// a reviewer sees are the numbers the multisig transactions are built from.

export const API_BASE = "https://api.0.xyz/v0";

// Banks with deposits at or above this qualify for a rate limit; banks below
// it (or on the excluded list) get any existing limit removed.
export const USD_THRESHOLD = 150_000;

// Window of 1h bankHistory snapshots the outflow stats are computed from.
export const LOOKBACK_DAYS = 60;
export const HISTORY_CONCURRENCY = 6;

// Caps as a percent of current deposits. Base applies to banks whose
// observed outflows stayed comfortably below the base caps; raised applies
// to banks that hit or came close to them.
export const BASE_HOURLY_PCT = 20;
export const BASE_DAILY_PCT = 40;
export const RAISED_HOURLY_PCT = 40;
export const RAISED_DAILY_PCT = 60;

// "Close to hitting" a base cap = worst observed window outflow at or above
// this fraction of the cap.
export const CLOSE_FACTOR = 0.8;

export const PT_MINTS = new Set<string>(
  Object.values(assetGroups["rate-products"]),
);
export const CASH_MINTS = new Set<string>([assetGroups.stablecoins.CASH]);
// Banks that never get a rate limit, regardless of size.
export const EXCLUDED_MINTS = new Set<string>([...PT_MINTS, ...CASH_MINTS]);

/**
 * A bank whose ticker looks like a Pendle PT token but whose mint is not
 * registered in assetGroups["rate-products"] — likely a new PT listing that
 * must be added to the registry so it stays exempt from rate limits.
 */
export function isSuspectPt(
  symbol: string | null | undefined,
  mint: string,
): boolean {
  return (
    !!symbol && symbol.toUpperCase().startsWith("PT-") && !PT_MINTS.has(mint)
  );
}

const FETCH_TIMEOUT_MS = 30_000;

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export function toNum(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type RealPrice = {
  price: BigNumber;
  symbol?: string;
};

/**
 * Per-bank prices from the api.0.xyz strict resolver, keyed by bank address.
 * Prices follow the on-chain marginfi convention: per-share price for
 * integration banks and pool-ratio-adjusted price for staked banks, so
 * `shares × assetShareValue × price` is correct for every bank type.
 * Entries with a missing or zero price are omitted. Throws when the endpoint
 * is unreachable — callers decide whether that aborts the run.
 */
export async function fetchRealPrices(
  ageSec = 60,
): Promise<Map<string, RealPrice>> {
  const body = await getJson<{
    prices?: Record<
      string,
      {
        oraclePrice?: { priceRealtime?: { price?: string } };
        symbol?: string;
      }
    >;
  }>(`${API_BASE}/realprice?age=${ageSec}`);
  const out = new Map<string, RealPrice>();
  for (const [bank, entry] of Object.entries(body.prices ?? {})) {
    const raw = entry?.oraclePrice?.priceRealtime?.price;
    if (!raw) continue;
    const price = new BigNumber(raw);
    if (price.isFinite() && price.gt(0)) {
      out.set(bank, { price, symbol: entry?.symbol ?? undefined });
    }
  }
  return out;
}

export type HistorySnapshot = {
  timestamp: number;
  assetShareValue: string;
  liabilityShareValue: string;
  totalAssetShares: string;
  totalLiabilityShares: string;
};

export type OutflowStats = {
  snapshotCount: number;
  daysCovered: number;
  // All values in native token atoms.
  maxOutflow1h: number;
  p95Outflow1h: number;
  maxOutflow24h: number;
  netChange60d: number;
};

export async function fetchHistory(
  bank: string,
  lookbackDays = LOOKBACK_DAYS,
): Promise<HistorySnapshot[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - lookbackDays * 86_400;
  const resp = await getJson<{ snapshots?: HistorySnapshot[] }>(
    `${API_BASE}/bankHistory?bank=${bank}&resolution=1h&from=${from}&to=${now}&limit=10000`,
  );
  return resp.snapshots ?? [];
}

// Snapshot pairs further apart than this are not treated as a 1h window —
// a history gap would otherwise count a multi-hour drop as a 1h outflow.
const HOURLY_PAIR_MAX_GAP_SEC = 3600 + 300;

/**
 * Worst net outflow (largest drop in available liquidity) between any two
 * snapshots no more than `windowSec` apart. Snapshots must be sorted
 * ascending by timestamp.
 */
function maxDropInWindow(
  series: { ts: number; liq: number }[],
  windowSec: number,
): number {
  let maxDrop = 0;
  let start = 0;
  for (let i = 0; i < series.length; i++) {
    while (start < i && series[i].ts - series[start].ts > windowSec) start++;
    let peak = -Infinity;
    for (let j = start; j < i; j++) {
      if (series[j].liq > peak) peak = series[j].liq;
    }
    if (peak > -Infinity) {
      const drop = peak - series[i].liq;
      if (drop > maxDrop) maxDrop = drop;
    }
  }
  return maxDrop;
}

/**
 * Net-outflow statistics over a series of 1h bankHistory snapshots. Available
 * liquidity per snapshot is assets − liabilities in native units — the same
 * quantity the on-chain rate limiter meters (withdrawals + borrows net of
 * deposits + repays). Returns null when the series has fewer than two points.
 */
export function computeOutflowStats(
  snapshots: HistorySnapshot[],
): OutflowStats | null {
  const series = snapshots
    .map((s) => ({
      ts: s.timestamp,
      liq:
        toNum(s.totalAssetShares) * toNum(s.assetShareValue) -
        toNum(s.totalLiabilityShares) * toNum(s.liabilityShareValue),
    }))
    .filter((p) => Number.isFinite(p.liq))
    .sort((a, b) => a.ts - b.ts);
  if (series.length < 2) return null;

  const hourlyOutflows: number[] = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i].ts - series[i - 1].ts > HOURLY_PAIR_MAX_GAP_SEC) continue;
    const drop = series[i - 1].liq - series[i].liq;
    if (drop > 0) hourlyOutflows.push(drop);
  }
  hourlyOutflows.sort((a, b) => a - b);
  const p95 =
    hourlyOutflows.length > 0
      ? hourlyOutflows[Math.floor(hourlyOutflows.length * 0.95)] ??
        hourlyOutflows[hourlyOutflows.length - 1]
      : 0;

  return {
    snapshotCount: series.length,
    daysCovered: (series[series.length - 1].ts - series[0].ts) / 86_400,
    maxOutflow1h: hourlyOutflows.length
      ? hourlyOutflows[hourlyOutflows.length - 1]
      : 0,
    p95Outflow1h: p95,
    maxOutflow24h: maxDropInWindow(series, 24 * 3600 + 300),
    netChange60d: series[series.length - 1].liq - series[0].liq,
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export type BankTier = "base" | "raised";

/**
 * Tier decision: raised when the worst observed 1h or 24h net outflow is at
 * least CLOSE_FACTOR of the corresponding base cap; base otherwise.
 */
export function classifyTier(
  stats: OutflowStats,
  depositsNative: BigNumber,
): BankTier {
  const nearCap = (pct: number, observed: number) =>
    depositsNative
      .multipliedBy(pct)
      .dividedBy(100)
      .multipliedBy(CLOSE_FACTOR)
      .lte(observed);
  return nearCap(BASE_HOURLY_PCT, stats.maxOutflow1h) ||
    nearCap(BASE_DAILY_PCT, stats.maxOutflow24h)
    ? "raised"
    : "base";
}

export function tierPcts(tier: BankTier): {
  hourlyPct: number;
  dailyPct: number;
} {
  return tier === "raised"
    ? { hourlyPct: RAISED_HOURLY_PCT, dailyPct: RAISED_DAILY_PCT }
    : { hourlyPct: BASE_HOURLY_PCT, dailyPct: BASE_DAILY_PCT };
}

// Dated per-run dumps: the analysis script writes its preview as
// rate_limit_outflows_<date>.json, the configure script records what it
// actually emitted as rate_limit_caps_<date>.json.
export const STATS_DIR = join(__dirname, "..", "api_fetch", "rate_limit_stats");

/** Write `data` to STATS_DIR as `<prefix>_<YYYY-MM-DD>.json`; returns the path. */
export function writeDatedDump(
  prefix: string,
  generatedAt: Date,
  data: unknown,
): string {
  mkdirSync(STATS_DIR, { recursive: true });
  const path = join(
    STATS_DIR,
    `${prefix}_${generatedAt.toISOString().slice(0, 10)}.json`,
  );
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}
