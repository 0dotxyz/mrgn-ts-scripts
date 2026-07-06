import {
  AccountInfo,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import BigNumber from "bignumber.js";
import * as sb from "@switchboard-xyz/on-demand";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";

import { commonSetup } from "../../lib/common-setup";
import { chunk, loadEnvFile, loadKeypairFromFile } from "../utils/utils";
import { decodePriceUpdateV2 } from "../utils/utils_oracle";
import {
  BASE_DAILY_PCT,
  BASE_HOURLY_PCT,
  BankTier,
  CLOSE_FACTOR,
  EXCLUDED_MINTS,
  HISTORY_CONCURRENCY,
  LOOKBACK_DAYS,
  OutflowStats,
  RAISED_DAILY_PCT,
  RAISED_HOURLY_PCT,
  USD_THRESHOLD,
  classifyTier,
  computeOutflowStats,
  fetchHistory,
  fetchRealPrices,
  isSuspectPt,
  mapWithConcurrency,
  tierPcts,
  writeDatedDump,
} from "../utils/rate_limits";

const sendTx = false;

// Bank struct layout before `group`: 8 disc + 32 mint + 1 decimals = 41 bytes.
const BANK_GROUP_OFFSET = 8 + 32 + 1;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  MULTISIG: PublicKey;
  LUT: PublicKey;
  LUT_AUTHORITY_WALLET: string;
  // Bytes reserved off the 1232-byte tx limit. Covers the Squads execute-ix
  // wrapper (extra program id + vault/PDA account metas) plus a comfort
  // margin so we never pack right up against the hard limit.
  TX_BYTE_RESERVE: number;
  // Hard cap on ixs per tranche regardless of byte fit — Squads rejects
  // imports that are too large even when they fit the wire format.
  MAX_IXS_PER_TRANCHE: number;
  MAX_TRANCHES: number;
  SKIP_ASSET_TAGS: number[];
  /**
   * When non-empty, emit SET ixs for exactly these banks (no USD threshold
   * filter) and skip the REMOVE txs. Use to re-emit a subset of a
   * previous run, e.g. re-splitting a tranche that was too large for the
   * multisig, without disturbing already-created proposals.
   */
  ONLY_BANKS: string[];
  // When false, abort if any selected bank ends up without outflow history —
  // a partial-data run must not be signable unnoticed. When true, such banks
  // fall back to base caps.
  ALLOW_MISSING_HISTORY: boolean;
  // When false, abort if a selected bank has a PT-style symbol whose mint is
  // not registered in assetGroups["rate-products"].
  ALLOW_SUSPECT_PT: boolean;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  LUT: new PublicKey("2b8UjpA3bAe7f8gcXd1gA3rFe6WuGZiKRNUXsS6tghEk"),
  LUT_AUTHORITY_WALLET: "/.config/solana/id.json",
  TX_BYTE_RESERVE: 200,
  MAX_IXS_PER_TRANCHE: 15,
  MAX_TRANCHES: 12,
  SKIP_ASSET_TAGS: [],
  ONLY_BANKS: [],
  ALLOW_MISSING_HISTORY: false,
  ALLOW_SUSPECT_PT: false,
};

const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";

type BankInfo = {
  address: PublicKey;
  mint: PublicKey;
  mintDecimals: number;
  totalAssetShares: BigNumber;
  assetShareValue: BigNumber;
  oracleKey: PublicKey;
  oracleSetup: string;
  fixedPrice: BigNumber;
  assetTag: number;
  operationalState: string;
  currentHourlyCap: BN;
  currentDailyCap: BN;
};

type BankSnapshot = {
  pubkey: PublicKey;
  mint: PublicKey;
  symbol: string;
  decimals: number;
  assetTag: number;
  totalDepositsNative: BigNumber;
  priceUsd: BigNumber;
  totalDepositsUsd: BigNumber;
  currentHourlyCap: BN;
  currentDailyCap: BN;
};

type ClassifiedBank = BankSnapshot & {
  tier: BankTier;
  stats: OutflowStats | null;
  hourlyCap: BN;
  dailyCap: BN;
};

function pctOfNative(totalNative: BigNumber, pct: number): BN {
  const atoms = totalNative
    .multipliedBy(pct)
    .dividedBy(100)
    .integerValue(BigNumber.ROUND_FLOOR);
  return new BN(atoms.toFixed(0));
}

export function addLutKeysFromIx(
  ix: TransactionInstruction,
  keyMap: Map<string, PublicKey>,
) {
  const pid = ix.programId.toBase58();
  if (!keyMap.has(pid)) keyMap.set(pid, ix.programId);
  for (const meta of ix.keys) {
    if (meta.isSigner) continue;
    const pk = meta.pubkey.toBase58();
    if (!keyMap.has(pk)) keyMap.set(pk, meta.pubkey);
  }
}

export async function ensureLutHasKeys(
  connection: Connection,
  lut: AddressLookupTableAccount,
  authority: Keypair,
  missing: PublicKey[],
): Promise<AddressLookupTableAccount> {
  if (missing.length === 0) return lut;

  if (!lut.state.authority) {
    throw new Error(
      `LUT ${lut.key.toBase58()} is frozen (no authority). Cannot extend.`,
    );
  }
  if (!lut.state.authority.equals(authority.publicKey)) {
    throw new Error(
      `LUT authority mismatch: on-chain ${lut.state.authority.toBase58()}, ` +
        `signer ${authority.publicKey.toBase58()}. Point LUT_AUTHORITY_WALLET ` +
        `at the key that owns the LUT.`,
    );
  }

  console.log(
    `\nExtending LUT ${lut.key.toBase58()} with ${missing.length} new key(s):`,
  );
  for (const k of missing) console.log(`  + ${k.toBase58()}`);

  const EXTEND_CHUNK = 20;
  for (const group of chunk(missing, EXTEND_CHUNK)) {
    const ix = AddressLookupTableProgram.extendLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      lookupTable: lut.key,
      addresses: group,
    });
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [authority],
    );
    console.log(`  extend ${group.length} key(s) → ${sig}`);
  }

  const refreshed = await connection.getAddressLookupTable(lut.key);
  if (!refreshed.value) {
    throw new Error(`LUT ${lut.key.toBase58()} missing after extend`);
  }
  return refreshed.value;
}

type OracleKind = "pyth" | "switchboard" | "fixed" | "unsupported";

function classifyOracle(setup: string): OracleKind {
  const lower = setup.toLowerCase();
  if (lower === "fixed" || lower.startsWith("fixed")) return "fixed";
  if (lower.includes("pyth")) return "pyth";
  if (lower.includes("switchboard")) return "switchboard";
  return "unsupported";
}

function oracleSetupKey(setup: unknown): string {
  if (typeof setup === "string") return setup;
  if (setup && typeof setup === "object") {
    return Object.keys(setup as object)[0] ?? "";
  }
  return "";
}

async function fetchAccountsBatched(
  connection: Connection,
  keys: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  const CHUNK = 100;
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = await connection.getMultipleAccountsInfo(
      keys.slice(i, i + CHUNK),
    );
    out.push(...slice);
  }
  return out;
}

type ResolvedPrices = {
  prices: Map<string, BigNumber>;
  symbols: Map<string, string>;
  // Banks priced by the raw on-chain oracle fallback instead of realprice.
  // The raw feed lacks the per-share / pool-ratio conversion, so USD values
  // for these banks are unreliable — they must never drive a cap REMOVAL.
  fallbackPriced: Set<string>;
};

async function resolvePrices(
  connection: Connection,
  banks: BankInfo[],
): Promise<ResolvedPrices> {
  const prices = new Map<string, BigNumber>();
  const symbols = new Map<string, string>();
  const fallbackPriced = new Set<string>();
  const pyth: BankInfo[] = [];
  const swb: BankInfo[] = [];

  // Fixed-price banks use the price stored in bank config; everything else
  // is priced per bank by the api.0.xyz realprice resolver, with on-chain
  // oracles as fallback for individual banks the resolver doesn't cover.
  // A total realprice failure aborts the run instead: silently repricing
  // every bank with wrong-convention oracle fallbacks could zero caps or
  // misclassify tiers protocol-wide.
  const nonFixed: BankInfo[] = [];
  for (const b of banks) {
    if (classifyOracle(b.oracleSetup) === "fixed") {
      prices.set(b.address.toBase58(), b.fixedPrice);
    } else {
      nonFixed.push(b);
    }
  }

  const apiPrices = await fetchRealPrices();

  const unpriced: BankInfo[] = [];
  for (const b of nonFixed) {
    const addr = b.address.toBase58();
    const entry = apiPrices.get(addr);
    if (entry) {
      prices.set(addr, entry.price);
      if (entry.symbol) symbols.set(addr, entry.symbol);
    } else {
      unpriced.push(b);
    }
  }
  console.log(
    `realprice priced ${nonFixed.length - unpriced.length}/${nonFixed.length} bank(s)`,
  );

  for (const b of unpriced) {
    console.warn(
      `[warn] no realprice for bank ${b.address.toBase58()} ` +
        `(mint ${b.mint.toBase58()}) — falling back to ${b.oracleSetup} oracle`,
    );
    fallbackPriced.add(b.address.toBase58());
    switch (classifyOracle(b.oracleSetup)) {
      case "pyth":
        pyth.push(b);
        break;
      case "switchboard":
        swb.push(b);
        break;
    }
  }

  if (pyth.length > 0) {
    const infos = await fetchAccountsBatched(
      connection,
      pyth.map((b) => b.oracleKey),
    );
    for (let i = 0; i < pyth.length; i++) {
      const info = infos[i];
      if (!info) continue;
      const update = decodePriceUpdateV2(Buffer.from(info.data));
      const msg = update.price_message;
      prices.set(
        pyth[i].address.toBase58(),
        new BigNumber(msg.price.toString()).multipliedBy(
          new BigNumber(10).pow(msg.exponent),
        ),
      );
    }
  }

  if (swb.length > 0) {
    // SWB SDK was typed against a different @solana/web3.js version; it works
    // fine with ours at runtime.
    // @ts-ignore
    const swbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection);
    const feeds = await swbProgram.account.pullFeedAccountData.fetchMultiple(
      swb.map((b) => b.oracleKey),
    );
    const SWB_SCALE = new BigNumber(10).pow(18);
    for (let i = 0; i < swb.length; i++) {
      const acc = feeds[i] as { result?: { value?: BN } } | null;
      if (!acc?.result?.value) continue;
      prices.set(
        swb[i].address.toBase58(),
        new BigNumber(acc.result.value.toString()).dividedBy(SWB_SCALE),
      );
    }
  }

  return { prices, symbols, fallbackPriced };
}

export async function fetchGroupBanks(
  program: ReturnType<typeof commonSetup>["program"],
  group: PublicKey,
): Promise<BankInfo[]> {
  const rows = await program.account.bank.all([
    { memcmp: { offset: BANK_GROUP_OFFSET, bytes: group.toBase58() } },
  ]);
  return rows.map(({ publicKey, account }) => ({
    address: publicKey,
    mint: account.mint,
    mintDecimals: account.mintDecimals,
    totalAssetShares: wrappedI80F48toBigNumber(account.totalAssetShares),
    assetShareValue: wrappedI80F48toBigNumber(account.assetShareValue),
    oracleKey: account.config.oracleKeys[0],
    oracleSetup: oracleSetupKey(account.config.oracleSetup),
    fixedPrice: wrappedI80F48toBigNumber(account.config.fixedPrice),
    assetTag: account.config.assetTag,
    operationalState: oracleSetupKey(account.config.operationalState),
    currentHourlyCap: new BN(account.rateLimiter.hourly.maxOutflow.toString()),
    currentDailyCap: new BN(account.rateLimiter.daily.maxOutflow.toString()),
  }));
}

function measureTxBytes(
  payerKey: PublicKey,
  blockhash: string,
  lut: AddressLookupTableAccount,
  ixs: TransactionInstruction[],
): number {
  const msg = new TransactionMessage({
    payerKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([lut]);
  return new VersionedTransaction(msg).serialize().length;
}

type PackStep = {
  globalIx: number;
  tranche: number;
  posInTranche: number;
  label: string;
  bytesBefore: number;
  bytesAfter: number;
  delta: number;
  startedNewTranche: boolean;
};

// Greedily pack ixs into as few v0 txs as possible without exceeding the
// wire-format limit. Each candidate batch is actually compiled against the
// live LUT so we measure real bytes — no guessing. Emits a per-ix step log
// so the caller can render exactly how the tranches filled up.
export function packInstructionsBySize(
  payerKey: PublicKey,
  blockhash: string,
  lut: AddressLookupTableAccount,
  ixs: TransactionInstruction[],
  labels: string[],
  budgetBytes: number,
  maxIxsPerTranche?: number,
): {
  batches: TransactionInstruction[][];
  byteCounts: number[];
  steps: PackStep[];
} {
  const batches: TransactionInstruction[][] = [];
  const byteCounts: number[] = [];
  const steps: PackStep[] = [];
  let tranche = 0;
  let current: TransactionInstruction[] = [];
  let currentSize = 0;

  for (let g = 0; g < ixs.length; g++) {
    const ix = ixs[g];
    const trial = [...current, ix];
    const trialSize = measureTxBytes(payerKey, blockhash, lut, trial);
    const fitsBytes = trialSize <= budgetBytes;
    const fitsCount =
      maxIxsPerTranche === undefined || trial.length <= maxIxsPerTranche;

    if (fitsBytes && fitsCount) {
      steps.push({
        globalIx: g,
        tranche,
        posInTranche: current.length,
        label: labels[g],
        bytesBefore: currentSize,
        bytesAfter: trialSize,
        delta: trialSize - currentSize,
        startedNewTranche: current.length === 0,
      });
      current = trial;
      currentSize = trialSize;
      continue;
    }

    if (current.length === 0) {
      throw new Error(
        `Single instruction serializes to ${trialSize} bytes, exceeds budget ${budgetBytes}. ` +
          `Either increase LUT coverage or reduce TX_BYTE_RESERVE.`,
      );
    }

    // Current tranche is full — flush and open a new one with this ix.
    batches.push(current);
    byteCounts.push(currentSize);
    tranche++;
    current = [ix];
    currentSize = measureTxBytes(payerKey, blockhash, lut, current);
    steps.push({
      globalIx: g,
      tranche,
      posInTranche: 0,
      label: labels[g],
      bytesBefore: 0,
      bytesAfter: currentSize,
      delta: currentSize,
      startedNewTranche: true,
    });
  }
  if (current.length > 0) {
    batches.push(current);
    byteCounts.push(currentSize);
  }
  return { batches, byteCounts, steps };
}

/**
 * Fresh outflow stats per selected bank from live bankHistory. Aborts when a
 * bank ends up with no stats unless ALLOW_MISSING_HISTORY is set — tiers
 * must not be silently decided on partial data.
 */
async function collectOutflowStats(
  selected: BankSnapshot[],
): Promise<Map<string, OutflowStats>> {
  const statsByBank = new Map<string, OutflowStats>();

  console.log(
    `Fetching ${LOOKBACK_DAYS}d of outflow history for ${selected.length} bank(s)...`,
  );
  await mapWithConcurrency(selected, HISTORY_CONCURRENCY, async (s) => {
    try {
      const stats = computeOutflowStats(
        await fetchHistory(s.pubkey.toBase58()),
      );
      if (stats) statsByBank.set(s.pubkey.toBase58(), stats);
    } catch (err) {
      console.warn(
        `[warn] bankHistory failed for ${s.pubkey.toBase58()}: ${err}`,
      );
    }
  });

  const missing = selected.filter((s) => !statsByBank.has(s.pubkey.toBase58()));
  if (missing.length > 0) {
    const list = missing
      .map((s) => `${s.symbol} ${s.pubkey.toBase58()}`)
      .join(", ");
    if (!config.ALLOW_MISSING_HISTORY) {
      throw new Error(
        `${missing.length} selected bank(s) have no outflow history: ${list}. ` +
          `Refusing to classify tiers on partial data — retry when bankHistory ` +
          `is healthy, or set ALLOW_MISSING_HISTORY to proceed with base caps.`,
      );
    }
    console.warn(
      `[warn] ${missing.length} bank(s) have no outflow history — using base caps: ${list}`,
    );
  }
  return statsByBank;
}

async function main() {
  loadEnvFile(".env"); // API_URL for commonSetup
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    DEFAULT_WALLET_PATH,
    config.MULTISIG,
  );
  const { program, connection } = user;
  const adminKey = sendTx ? user.wallet.publicKey : config.MULTISIG;
  const payerKey = adminKey;

  const onChainBanks = await fetchGroupBanks(program, config.GROUP);
  const operationalBanks = onChainBanks.filter(
    (b) => b.operationalState.toLowerCase() === "operational",
  );
  const nonOperationalCount = onChainBanks.length - operationalBanks.length;
  console.log(
    `Fetched ${onChainBanks.length} banks on-chain in group ${config.GROUP} ` +
      `(${operationalBanks.length} operational${
        nonOperationalCount
          ? `, ${nonOperationalCount} paused/reduce-only — skipped`
          : ""
      })`,
  );

  const { prices: priceMap, symbols, fallbackPriced } = await resolvePrices(
    connection,
    operationalBanks,
  );

  const snapshots: BankSnapshot[] = [];
  for (const b of operationalBanks) {
    if (config.SKIP_ASSET_TAGS.includes(b.assetTag)) continue;
    if (EXCLUDED_MINTS.has(b.mint.toBase58())) continue;

    const totalDepositsNative = b.totalAssetShares.multipliedBy(
      b.assetShareValue,
    );

    const addr = b.address.toBase58();
    const priceUsd = priceMap.get(addr);
    if (!priceUsd || priceUsd.isZero()) {
      console.warn(`[skip] no price for ${addr} (${b.oracleSetup})`);
      continue;
    }

    const totalDepositsUsd = totalDepositsNative
      .shiftedBy(-b.mintDecimals)
      .multipliedBy(priceUsd);

    snapshots.push({
      pubkey: b.address,
      mint: b.mint,
      symbol: symbols.get(addr) ?? addr.slice(0, 4),
      decimals: b.mintDecimals,
      assetTag: b.assetTag,
      totalDepositsNative,
      priceUsd,
      totalDepositsUsd,
      currentHourlyCap: b.currentHourlyCap,
      currentDailyCap: b.currentDailyCap,
    });
  }

  const pinned = config.ONLY_BANKS.length > 0;
  let selected: BankSnapshot[];
  if (pinned) {
    const byAddress = new Map(snapshots.map((s) => [s.pubkey.toBase58(), s]));
    selected = [];
    for (const addr of config.ONLY_BANKS) {
      const snap = byAddress.get(addr);
      if (snap) {
        selected.push(snap);
      } else {
        throw new Error(
          `ONLY_BANKS entry ${addr} not found among priced operational banks — ` +
            `refusing to emit a partial set. Check the address, note that ` +
            `PT/CASH banks are excluded from rate limiting, or clear ONLY_BANKS.`,
        );
      }
    }
    console.log(
      `\nONLY_BANKS mode: rate-limiting exactly ${selected.length} pinned bank(s) ` +
        `(threshold filter bypassed; REMOVE txs skipped):`,
    );
  } else {
    selected = snapshots
      .filter((s) => s.totalDepositsUsd.gte(USD_THRESHOLD))
      .sort((a, b) => b.totalDepositsUsd.comparedTo(a.totalDepositsUsd) ?? 0);
    console.log(
      `\n${selected.length} bank(s) meet the $${USD_THRESHOLD.toLocaleString()} USD deposits threshold — rate-limiting these:`,
    );
  }

  const suspects = selected.filter((s) =>
    isSuspectPt(s.symbol, s.mint.toBase58()),
  );
  if (suspects.length > 0) {
    const list = suspects
      .map((s) => `${s.symbol} ${s.pubkey.toBase58()} (mint ${s.mint.toBase58()})`)
      .join(", ");
    if (!config.ALLOW_SUSPECT_PT) {
      throw new Error(
        `${suspects.length} selected bank(s) look like unregistered PT tokens: ${list}. ` +
          `PT banks must never be rate-limited — add the mint(s) to ` +
          `assetGroups["rate-products"], or set ALLOW_SUSPECT_PT if the ` +
          `symbol match is a false positive.`,
      );
    }
    console.warn(`[warn] rate-limiting PT-style symbol bank(s): ${list}`);
  }

  const statsByBank = await collectOutflowStats(selected);

  const classified: ClassifiedBank[] = selected.map((s) => {
    const stats = statsByBank.get(s.pubkey.toBase58()) ?? null;
    const tier: BankTier = stats
      ? classifyTier(stats, s.totalDepositsNative)
      : "base";
    const { hourlyPct, dailyPct } = tierPcts(tier);
    return {
      ...s,
      tier,
      stats,
      hourlyCap: pctOfNative(s.totalDepositsNative, hourlyPct),
      dailyCap: pctOfNative(s.totalDepositsNative, dailyPct),
    };
  });

  const outflowPct = (s: ClassifiedBank, outflow: number | undefined) =>
    outflow === undefined
      ? "-"
      : new BigNumber(outflow)
          .dividedBy(s.totalDepositsNative)
          .multipliedBy(100)
          .toFixed(1) + "%";

  console.table(
    classified.map((s) => ({
      Symbol: s.symbol,
      Bank: s.pubkey.toBase58(),
      AssetTag: s.assetTag,
      Tier: s.tier,
      "Max 1h out": outflowPct(s, s.stats?.maxOutflow1h),
      "Max 24h out": outflowPct(s, s.stats?.maxOutflow24h),
      "Deposits (token)": s.totalDepositsNative.shiftedBy(-s.decimals).toFormat(4),
      "Price ($)": s.priceUsd.toFormat(6),
      "Deposits ($)": s.totalDepositsUsd.toFormat(2),
      "Hourly cap (token)": new BigNumber(s.hourlyCap.toString())
        .shiftedBy(-s.decimals)
        .toFormat(4),
      "Daily cap (token)": new BigNumber(s.dailyCap.toString())
        .shiftedBy(-s.decimals)
        .toFormat(4),
      "Hourly cap ($)": new BigNumber(s.hourlyCap.toString())
        .shiftedBy(-s.decimals)
        .multipliedBy(s.priceUsd)
        .toFormat(2),
      "Daily cap ($)": new BigNumber(s.dailyCap.toString())
        .shiftedBy(-s.decimals)
        .multipliedBy(s.priceUsd)
        .toFormat(2),
    })),
  );

  // Banks that currently have a rate limit set on-chain but no longer meet
  // the requirements: operational excluded-mint banks (PT/CASH) and banks
  // below the USD threshold. Only banks we could evaluate are touched: no
  // removal for paused/reduce-only banks, missing prices, or prices that
  // came from the raw-oracle fallback (whose USD values are unreliable).
  // These get their caps zeroed out in a *separate* set of tranches.
  const ZERO = new BN(0);
  type RemoveTarget = {
    pubkey: PublicKey;
    symbol: string;
    reason: string;
    depositsUsd: string;
    currentHourlyCap: BN;
    currentDailyCap: BN;
  };
  const toRemove: RemoveTarget[] = [];
  const fallbackSkipped: BankSnapshot[] = [];
  if (!pinned) {
    for (const b of operationalBanks) {
      const addr = b.address.toBase58();
      if (!EXCLUDED_MINTS.has(b.mint.toBase58())) continue;
      if (b.currentHourlyCap.isZero() && b.currentDailyCap.isZero()) continue;
      toRemove.push({
        pubkey: b.address,
        symbol: symbols.get(addr) ?? addr.slice(0, 4),
        reason: "PT/CASH",
        depositsUsd: "-",
        currentHourlyCap: b.currentHourlyCap,
        currentDailyCap: b.currentDailyCap,
      });
    }
    for (const s of snapshots) {
      if (s.totalDepositsUsd.gte(USD_THRESHOLD)) continue;
      if (s.currentHourlyCap.isZero() && s.currentDailyCap.isZero()) continue;
      if (fallbackPriced.has(s.pubkey.toBase58())) {
        fallbackSkipped.push(s);
        continue;
      }
      toRemove.push({
        pubkey: s.pubkey,
        symbol: s.symbol,
        reason: `deposits < $${USD_THRESHOLD.toLocaleString()}`,
        depositsUsd: s.totalDepositsUsd.toFormat(2),
        currentHourlyCap: s.currentHourlyCap,
        currentDailyCap: s.currentDailyCap,
      });
    }
  }

  if (fallbackSkipped.length > 0) {
    console.warn(
      `\n[warn] ${fallbackSkipped.length} bank(s) read below the threshold but were priced ` +
        `by the raw-oracle fallback — leaving their limits as-is:`,
    );
    console.table(
      fallbackSkipped.map((s) => ({
        Symbol: s.symbol,
        Bank: s.pubkey.toBase58(),
        "Deposits ($, unreliable)": s.totalDepositsUsd.toFormat(2),
      })),
    );
  }

  // Banks holding a limit that we could NOT evaluate (paused/reduce-only,
  // skipped asset tag, or no price). Left untouched — flag them for review.
  const evaluatedSet = new Set([
    ...snapshots.map((s) => s.pubkey.toBase58()),
    ...operationalBanks
      .filter((b) => EXCLUDED_MINTS.has(b.mint.toBase58()))
      .map((b) => b.address.toBase58()),
  ]);
  const unevaluatedWithCaps = onChainBanks.filter(
    (b) =>
      !evaluatedSet.has(b.address.toBase58()) &&
      (!b.currentHourlyCap.isZero() || !b.currentDailyCap.isZero()),
  );
  if (unevaluatedWithCaps.length > 0) {
    console.warn(
      `\n[warn] ${unevaluatedWithCaps.length} bank(s) have a rate limit set but could not be ` +
        `evaluated (paused/reduce-only, skipped tag, or no price) — leaving their limits as-is:`,
    );
    console.table(
      unevaluatedWithCaps.map((b) => ({
        Bank: b.address.toBase58(),
        OperationalState: b.operationalState,
        "Current hourly cap": b.currentHourlyCap.toString(),
        "Current daily cap": b.currentDailyCap.toString(),
      })),
    );
  }

  if (toRemove.length > 0) {
    console.log(
      `\n${toRemove.length} bank(s) have an existing rate limit but no longer meet the ` +
        `requirements — removing their limits:`,
    );
    console.table(
      toRemove.map((s) => ({
        Symbol: s.symbol,
        Bank: s.pubkey.toBase58(),
        "Deposits ($)": s.depositsUsd,
        Reason: s.reason,
        "Current hourly cap": s.currentHourlyCap.toString(),
        "Current daily cap": s.currentDailyCap.toString(),
      })),
    );
  }

  const baseBanks = classified.filter((s) => s.tier === "base");
  const raisedBanks = classified.filter((s) => s.tier === "raised");
  console.log(
    `\nTiers: ${baseBanks.length} base (${BASE_HOURLY_PCT}%/${BASE_DAILY_PCT}%), ` +
      `${raisedBanks.length} raised (${RAISED_HOURLY_PCT}%/${RAISED_DAILY_PCT}%).`,
  );

  // Record of exactly what this run emits, for team review alongside the
  // analysis script's rate_limit_outflows_<date>.json preview.
  const now = new Date();
  const capsDump = {
    generatedAt: now.toISOString(),
    sendTx,
    policy: {
      usdThreshold: USD_THRESHOLD,
      lookbackDays: LOOKBACK_DAYS,
      baseHourlyPct: BASE_HOURLY_PCT,
      baseDailyPct: BASE_DAILY_PCT,
      raisedHourlyPct: RAISED_HOURLY_PCT,
      raisedDailyPct: RAISED_DAILY_PCT,
      closeFactor: CLOSE_FACTOR,
    },
    qualifying: classified.map((s) => ({
      symbol: s.symbol,
      bank: s.pubkey.toBase58(),
      mint: s.mint.toBase58(),
      decimals: s.decimals,
      priceUsd: s.priceUsd.toNumber(),
      depositedNative: s.totalDepositsNative.toNumber(),
      depositedUsd: s.totalDepositsUsd.toNumber(),
      tier: s.tier,
      hourlyCapNative: s.hourlyCap.toString(),
      dailyCapNative: s.dailyCap.toString(),
      hourlyCapUi: new BigNumber(s.hourlyCap.toString())
        .shiftedBy(-s.decimals)
        .toString(),
      dailyCapUi: new BigNumber(s.dailyCap.toString())
        .shiftedBy(-s.decimals)
        .toString(),
      stats: s.stats,
    })),
    removed: toRemove.map((r) => ({
      symbol: r.symbol,
      bank: r.pubkey.toBase58(),
      reason: r.reason,
      depositsUsd: r.depositsUsd,
      currentHourlyCapNative: r.currentHourlyCap.toString(),
      currentDailyCapNative: r.currentDailyCap.toString(),
    })),
  };
  const capsDumpPath = writeDatedDump("rate_limit_caps", now, capsDump);
  console.log(`Caps dump written to ${capsDumpPath}`);

  type EmitItem = {
    pubkey: PublicKey;
    label: string;
    hourlyCap: BN;
    dailyCap: BN;
  };
  const toEmitItem = (s: {
    pubkey: PublicKey;
    symbol: string;
    hourlyCap: BN;
    dailyCap: BN;
  }): EmitItem => ({
    pubkey: s.pubkey,
    label: `${s.symbol} ${s.pubkey.toBase58()}`,
    hourlyCap: s.hourlyCap,
    dailyCap: s.dailyCap,
  });
  const emitGroups: { tag: string; items: EmitItem[] }[] = [
    { tag: "SET-BASE", items: baseBanks.map(toEmitItem) },
    { tag: "SET-RAISED", items: raisedBanks.map(toEmitItem) },
    {
      tag: "REMOVE",
      items: toRemove.map((r) =>
        toEmitItem({ ...r, hourlyCap: ZERO, dailyCap: ZERO }),
      ),
    },
  ];

  const lutKeys = new Map<string, PublicKey>();
  const builtGroups: {
    tag: string;
    ixs: TransactionInstruction[];
    labels: string[];
  }[] = [];
  for (const g of emitGroups) {
    const ixs: TransactionInstruction[] = [];
    for (const item of g.items) {
      const ix = await program.methods
        .configureBankRateLimits(item.hourlyCap, item.dailyCap)
        .accounts({ bank: item.pubkey })
        .accountsPartial({ group: config.GROUP, admin: adminKey })
        .instruction();
      ixs.push(ix);
      addLutKeysFromIx(ix, lutKeys);
    }
    builtGroups.push({ tag: g.tag, ixs, labels: g.items.map((i) => i.label) });
  }

  const lutResp = await connection.getAddressLookupTable(config.LUT);
  if (!lutResp.value) {
    throw new Error(`LUT not found on-chain: ${config.LUT.toBase58()}`);
  }
  const lutKnown = new Set(
    lutResp.value.state.addresses.map((k) => k.toBase58()),
  );
  const missing = Array.from(lutKeys.values()).filter(
    (k) => !lutKnown.has(k.toBase58()),
  );
  const lutAuthority = loadKeypairFromFile(
    process.env.HOME + config.LUT_AUTHORITY_WALLET,
  );
  const lut = await ensureLutHasKeys(
    connection,
    lutResp.value,
    lutAuthority,
    missing,
  );

  const packBudget = PACKET_DATA_SIZE - config.TX_BYTE_RESERVE;
  const sizingBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const packedGroups = builtGroups.map((g) => ({
    ...g,
    packed: packInstructionsBySize(
      payerKey,
      sizingBlockhash,
      lut,
      g.ixs,
      g.labels,
      packBudget,
      config.MAX_IXS_PER_TRANCHE,
    ),
  }));

  const totalIxs = packedGroups.reduce((n, g) => n + g.ixs.length, 0);
  const totalTranches = packedGroups.reduce(
    (n, g) => n + g.packed.batches.length,
    0,
  );
  console.log(
    `\nPacked ${totalIxs} bank ix(s) into ` +
      packedGroups
        .map((g) => `${g.packed.batches.length} ${g.tag}`)
        .join(" + ") +
      ` tranche(s) ` +
      `(limit ${PACKET_DATA_SIZE} bytes, reserve ${config.TX_BYTE_RESERVE}, budget ${packBudget}, ` +
      `max ${config.MAX_IXS_PER_TRANCHE} ixs/tranche).`,
  );
  if (totalTranches > config.MAX_TRANCHES) {
    throw new Error(
      `Packed ${totalTranches} tranches, exceeds MAX_TRANCHES=${config.MAX_TRANCHES}. ` +
        `Verify the LUT covers all ix accounts or raise MAX_TRANCHES.`,
    );
  }

  // Per-ix packing log — shows how each added ix grew the tranche and where
  // the tranche boundary was forced — plus a per-tranche summary.
  const logPacking = (
    tag: string,
    packed: ReturnType<typeof packInstructionsBySize>,
  ) => {
    if (packed.batches.length === 0) return;
    console.log(`\n${tag} per-ix packing log (budget ${packBudget} bytes):`);
    for (const s of packed.steps) {
      const marker = s.startedNewTranche ? " [NEW TRANCHE]" : "";
      const pct = ((s.bytesAfter / packBudget) * 100).toFixed(1);
      console.log(
        `  ix #${s.globalIx + 1} tranche ${s.tranche + 1} pos ${s.posInTranche + 1} | ` +
          `${s.bytesBefore} → ${s.bytesAfter} bytes (+${s.delta}) | ` +
          `remaining ${packBudget - s.bytesAfter} (${pct}% of budget) | ${s.label}${marker}`,
      );
    }
    console.log(`\n${tag} per-tranche summary:`);
    for (let i = 0; i < packed.batches.length; i++) {
      const bytes = packed.byteCounts[i];
      const pct = ((bytes / packBudget) * 100).toFixed(1);
      console.log(
        `  Tranche ${i + 1}: ${packed.batches[i].length} ixs, ${bytes} bytes | ` +
          `budget headroom ${packBudget - bytes} (${pct}% of budget) | ` +
          `hard-limit headroom ${PACKET_DATA_SIZE - bytes}`,
      );
    }
  };
  for (const g of packedGroups) logPacking(g.tag, g.packed);

  const emitTranches = async (
    batches: TransactionInstruction[][],
    byteCounts: number[],
    labels: string[],
    tag: string,
  ) => {
    let cursor = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();

      const v0Message = new TransactionMessage({
        payerKey,
        recentBlockhash: blockhash,
        instructions: batch,
      }).compileToV0Message([lut]);
      const v0Tx = new VersionedTransaction(v0Message);

      const banksInTranche = labels
        .slice(cursor, cursor + batch.length)
        .map((label, idx) => ({ idx, label }));
      cursor += batch.length;

      console.log(
        `\n=== ${tag} Tranche ${i + 1}/${batches.length} (${batch.length} ix${
          batch.length === 1 ? "" : "s"
        }, ${byteCounts[i]} bytes) ===`,
      );
      console.table(banksInTranche);

      if (sendTx) {
        v0Tx.sign([user.wallet.payer]);
        const sig = await connection.sendTransaction(v0Tx, { maxRetries: 2 });
        await connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        console.log("Signature:", sig);
      } else {
        const sim = await connection.simulateTransaction(v0Tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        });
        if (sim.value.err) {
          console.error(
            `[sim] ${tag} tranche ${i + 1}/${batches.length} FAILED: ` +
              JSON.stringify(sim.value.err),
          );
          for (const l of sim.value.logs ?? []) console.error(`    ${l}`);
        } else {
          console.log(
            `[sim] ${tag} tranche ${i + 1}/${batches.length} OK ` +
              `(CU: ${sim.value.unitsConsumed ?? "?"})`,
          );
        }
        const encoded = bs58.encode(v0Tx.serialize());
        console.log(
          `\n---- BEGIN MULTISIG TX ${tag} ${i + 1}/${batches.length} (base58) ----`,
        );
        console.log(encoded);
        console.log(`---- END MULTISIG TX ${tag} ${i + 1}/${batches.length} ----\n`);
      }
    }
  };

  for (const g of packedGroups) {
    await emitTranches(g.packed.batches, g.packed.byteCounts, g.labels, g.tag);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
