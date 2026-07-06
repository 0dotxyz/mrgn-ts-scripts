import BigNumber from "bignumber.js";

import {
  API_BASE,
  BASE_DAILY_PCT,
  BASE_HOURLY_PCT,
  BankTier,
  CASH_MINTS,
  CLOSE_FACTOR,
  HISTORY_CONCURRENCY,
  LOOKBACK_DAYS,
  OutflowStats,
  PT_MINTS,
  RAISED_DAILY_PCT,
  RAISED_HOURLY_PCT,
  USD_THRESHOLD,
  classifyTier,
  computeOutflowStats,
  fetchHistory,
  fetchRealPrices,
  getJson,
  isSuspectPt,
  mapWithConcurrency,
  tierPcts,
  toNum,
  writeDatedDump,
} from "../utils/rate_limits";

/**
 * Read-only preview of the per-bank rate-limit policy. No transactions are
 * emitted.
 *
 * Policy (shared with scripts/admin/configure_bank_rate_limits.ts via
 * scripts/utils/rate_limits.ts):
 * - Banks below USD_THRESHOLD in deposits get no rate limit.
 * - PT (Pendle) and CASH banks get no rate limit regardless of size.
 * - Qualifying banks whose observed outflows stayed under CLOSE_FACTOR of
 *   the base caps keep base caps; banks that hit or came close get raised
 *   caps.
 *
 * For every operational, non-excluded bank at or above the threshold, pulls
 * LOOKBACK_DAYS of /v0/bankHistory at 1h resolution, measures net liquidity
 * outflow (the quantity the on-chain rate limiter meters), and shows the
 * tier and caps the configure script would emit. Also lists banks that
 * currently have a cap set but no longer qualify — removal candidates.
 *
 * Each run writes a dated JSON dump to rate_limit_stats/ for team review;
 * the configure script fetches its own fresh stats at tx-build time and
 * records what it emitted as a separate rate_limit_caps_<date>.json dump.
 */

const CACHE_AGE = 60;

// From /v0/bankCache?raw=true. Deposits are derived from shares × share
// value so they are in on-chain native units for every bank type — the same
// units the rate limiter and /v0/bankHistory use. (bankBalances is NOT
// equivalent: for staked banks its depositedNative is SOL-equivalent, which
// double-counts the pool ratio once multiplied by the per-token price.)
type RawBank = {
  address: string;
  tokenSymbol?: string | null;
  mint: string;
  mintDecimals: number;
  totalAssetShares: string;
  assetShareValue: string;
  totalLiabilityShares: string;
  liabilityShareValue: string;
  config?: {
    // 1 = Operational.
    operationalState?: number;
    assetTag?: number;
  };
  rateLimiter?: {
    hourly?: { maxOutflow?: string | number };
    daily?: { maxOutflow?: string | number };
  };
};

type AnalysisRow = {
  symbol: string;
  bank: string;
  mint: string;
  decimals: number;
  priceUsd: number;
  depositedNative: number;
  depositedUsd: number;
  liquidityNative: number;
  currentHourlyCap: number;
  currentDailyCap: number;
  tier: BankTier | null;
  stats: OutflowStats | null;
};

function usd(n: number): string {
  return n.toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}

function pctOf(part: number, whole: number): string {
  if (whole <= 0) return "-";
  return ((part / whole) * 100).toFixed(1) + "%";
}

function proposedCaps(
  row: AnalysisRow,
): { hourly: number; daily: number } | null {
  if (!row.tier) return null;
  const { hourlyPct, dailyPct } = tierPcts(row.tier);
  return {
    hourly: Math.floor((row.depositedNative * hourlyPct) / 100),
    daily: Math.floor((row.depositedNative * dailyPct) / 100),
  };
}

function exclusionReason(row: AnalysisRow, operational: boolean): string | null {
  if (PT_MINTS.has(row.mint)) return "PT token";
  if (CASH_MINTS.has(row.mint)) return "CASH bank";
  if (!operational) return "not operational";
  if (row.depositedUsd < USD_THRESHOLD)
    return `deposits < $${USD_THRESHOLD.toLocaleString()}`;
  return null;
}

async function main() {
  const [bankCache, realPrices] = await Promise.all([
    getJson<{ banks?: RawBank[] }>(
      `${API_BASE}/bankCache?age=${CACHE_AGE}&raw=true`,
    ),
    fetchRealPrices(CACHE_AGE),
  ]);

  const rows: { row: AnalysisRow; operational: boolean }[] = [];
  for (const bank of bankCache.banks ?? []) {
    const entry = realPrices.get(bank.address);
    const price = entry ? entry.price.toNumber() : 0;
    const decimals = bank.mintDecimals;
    const depositedNative =
      toNum(bank.totalAssetShares) * toNum(bank.assetShareValue);
    const borrowedNative =
      toNum(bank.totalLiabilityShares) * toNum(bank.liabilityShareValue);
    const depositedUsd = (depositedNative / 10 ** decimals) * price;

    rows.push({
      operational: bank.config?.operationalState === 1,
      row: {
        symbol: bank.tokenSymbol ?? entry?.symbol ?? bank.mint.slice(0, 4),
        bank: bank.address,
        mint: bank.mint,
        decimals,
        priceUsd: price,
        depositedNative,
        depositedUsd,
        liquidityNative: depositedNative - borrowedNative,
        currentHourlyCap: toNum(bank.rateLimiter?.hourly?.maxOutflow),
        currentDailyCap: toNum(bank.rateLimiter?.daily?.maxOutflow),
        tier: null,
        stats: null,
      },
    });
  }

  const qualifying = rows
    .filter(({ row, operational }) => !exclusionReason(row, operational))
    .map(({ row }) => row)
    .sort((a, b) => b.depositedUsd - a.depositedUsd);

  const removeCandidates = rows
    .filter(
      ({ row, operational }) =>
        exclusionReason(row, operational) !== null &&
        (row.currentHourlyCap > 0 || row.currentDailyCap > 0),
    )
    .sort((a, b) => b.row.depositedUsd - a.row.depositedUsd);

  for (const r of qualifying.filter((q) => isSuspectPt(q.symbol, q.mint))) {
    console.warn(
      `[warn] ${r.symbol} (${r.bank}) has a PT-style symbol but its mint is not in ` +
        `assetGroups["rate-products"] — register it before setting a limit.`,
    );
  }

  console.log(
    `Fetched ${rows.length} banks; ${qualifying.length} qualify for rate limits ` +
      `(operational, non-PT, non-CASH, deposits >= $${USD_THRESHOLD.toLocaleString()}).`,
  );
  console.log(
    `Pulling ${LOOKBACK_DAYS}d of 1h bankHistory for ${qualifying.length} bank(s)...`,
  );

  await mapWithConcurrency(qualifying, HISTORY_CONCURRENCY, async (row) => {
    try {
      row.stats = computeOutflowStats(await fetchHistory(row.bank));
      if (row.stats) {
        row.tier = classifyTier(row.stats, new BigNumber(row.depositedNative));
      }
    } catch (err) {
      console.warn(`[warn] bankHistory failed for ${row.symbol} (${row.bank}): ${err}`);
    }
  });

  const toUi = (row: AnalysisRow, native: number) => native / 10 ** row.decimals;
  const toUsd = (row: AnalysisRow, native: number) =>
    toUi(row, native) * row.priceUsd;

  console.log(
    `\n=== Qualifying banks — observed net outflows over ${LOOKBACK_DAYS}d ` +
      `(percentages are of current deposits) ===`,
  );
  console.table(
    qualifying.map((r) => {
      const s = r.stats;
      const prop = proposedCaps(r);
      return {
        Symbol: r.symbol,
        Bank: r.bank,
        "Dep ($)": usd(r.depositedUsd),
        Tier: r.tier ?? "no data",
        "Cur 1h cap": r.currentHourlyCap
          ? `${usd(toUsd(r, r.currentHourlyCap))}$ (${pctOf(r.currentHourlyCap, r.depositedNative)})`
          : "none",
        "Cur 24h cap": r.currentDailyCap
          ? `${usd(toUsd(r, r.currentDailyCap))}$ (${pctOf(r.currentDailyCap, r.depositedNative)})`
          : "none",
        "Max 1h out": s
          ? `${usd(toUsd(r, s.maxOutflow1h))}$ (${pctOf(s.maxOutflow1h, r.depositedNative)})`
          : "no data",
        "P95 1h out": s
          ? `${usd(toUsd(r, s.p95Outflow1h))}$ (${pctOf(s.p95Outflow1h, r.depositedNative)})`
          : "-",
        "Max 24h out": s
          ? `${usd(toUsd(r, s.maxOutflow24h))}$ (${pctOf(s.maxOutflow24h, r.depositedNative)})`
          : "-",
        "60d net": s ? `${usd(toUsd(r, s.netChange60d))}$` : "-",
        "Prop 1h cap": prop
          ? `${usd(toUsd(r, prop.hourly))}$ (${pctOf(prop.hourly, r.depositedNative)})`
          : "-",
        "Prop 24h cap": prop
          ? `${usd(toUsd(r, prop.daily))}$ (${pctOf(prop.daily, r.depositedNative)})`
          : "-",
        Days: s ? s.daysCovered.toFixed(0) : "0",
      };
    }),
  );

  console.log(
    `\nTier policy: base ${BASE_HOURLY_PCT}%/${BASE_DAILY_PCT}%, raised ` +
      `${RAISED_HOURLY_PCT}%/${RAISED_DAILY_PCT}% when observed outflow >= ` +
      `${CLOSE_FACTOR} of a base cap.`,
  );

  if (removeCandidates.length > 0) {
    console.log(
      `\n=== ${removeCandidates.length} bank(s) with a cap set that no longer qualify — removal candidates ===`,
    );
    console.table(
      removeCandidates.map(({ row, operational }) => ({
        Symbol: row.symbol,
        Bank: row.bank,
        "Dep ($)": usd(row.depositedUsd),
        Reason: exclusionReason(row, operational),
        "Cur 1h cap (native)": row.currentHourlyCap,
        "Cur 24h cap (native)": row.currentDailyCap,
      })),
    );
  } else {
    console.log(`\nNo non-qualifying banks currently hold a rate limit.`);
  }

  const now = new Date();
  const jsonOut = {
    generatedAt: now.toISOString(),
    policy: {
      usdThreshold: USD_THRESHOLD,
      lookbackDays: LOOKBACK_DAYS,
      baseHourlyPct: BASE_HOURLY_PCT,
      baseDailyPct: BASE_DAILY_PCT,
      raisedHourlyPct: RAISED_HOURLY_PCT,
      raisedDailyPct: RAISED_DAILY_PCT,
      closeFactor: CLOSE_FACTOR,
    },
    qualifying: qualifying.map((r) => {
      const prop = proposedCaps(r);
      return {
        symbol: r.symbol,
        bank: r.bank,
        mint: r.mint,
        decimals: r.decimals,
        priceUsd: r.priceUsd,
        depositedNative: r.depositedNative,
        depositedUsd: r.depositedUsd,
        currentHourlyCapNative: r.currentHourlyCap,
        currentDailyCapNative: r.currentDailyCap,
        tier: r.tier,
        proposedHourlyCapNative: prop?.hourly ?? null,
        proposedDailyCapNative: prop?.daily ?? null,
        proposedHourlyCapUsd: prop ? toUsd(r, prop.hourly) : null,
        proposedDailyCapUsd: prop ? toUsd(r, prop.daily) : null,
        stats: r.stats,
      };
    }),
    removeCandidates: removeCandidates.map(({ row, operational }) => ({
      symbol: row.symbol,
      bank: row.bank,
      mint: row.mint,
      depositedUsd: row.depositedUsd,
      reason: exclusionReason(row, operational),
      currentHourlyCapNative: row.currentHourlyCap,
      currentDailyCapNative: row.currentDailyCap,
    })),
  };

  const outPath = writeDatedDump("rate_limit_outflows", now, jsonOut);
  console.log(`\nStats written to ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
