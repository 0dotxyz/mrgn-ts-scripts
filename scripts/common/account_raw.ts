import { createHash } from "crypto";
import { Connection, GetProgramAccountsFilter, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { makePacer, withRetry } from "./rpc_throttle";

/**
 * Raw (byte-offset) decoding for MarginfiAccount as laid out in mrgn-0.1.9. The bundled IDL
 * (0.1.8) predates the indexer_flags/active_orders fields, so scripts that need them decode
 * account data directly.
 */

// 8-byte anchor account discriminator + 2304-byte struct
const MARGINFI_ACCOUNT_SIZE = 2312;
const MARGINFI_ACCOUNT_DISCRIMINATOR = Buffer.from([
  67, 178, 130, 109, 126, 114, 28, 42,
]);

const DISC = 8;
const GROUP_OFFSET = DISC + 0;
const BALANCES_OFFSET = DISC + 64;
const BALANCE_SIZE = 104;
const MAX_BALANCES = 16;
const ACCOUNT_FLAGS_OFFSET = DISC + 1792;
const LAST_UPDATE_OFFSET = DISC + 2200;
const ACTIVE_ORDERS_OFFSET = DISC + 2213;
const LIQUIDATION_RECORD_OFFSET = DISC + 2216;
const INDEXER_FLAGS_OFFSET = DISC + 2248;

export const ACCOUNT_DISABLED = 1n << 0n;
export const ACCOUNT_IN_FLASHLOAN = 1n << 1n;
export const ACCOUNT_IN_RECEIVERSHIP = 1n << 4n;
export const ACCOUNT_IN_DELEVERAGE = 1n << 5n;
export const ACCOUNT_FROZEN = 1n << 6n;
export const ACCOUNT_IN_ORDER_EXECUTION = 1n << 7n;

const ASSET_TAG_STAKED = 2;
const ASSET_TAG_KAMINO = 3;
const ASSET_TAG_DRIFT = 4;
const ASSET_TAG_JUPLEND = 6;

/** I80F48 representation of 1.0 (EMPTY_BALANCE_THRESHOLD on chain) */
export const I80F48_ONE = 1n << 48n;

export type RawBalance = {
  active: boolean;
  bankAssetTag: number;
  /** Raw I80F48 value (48 fractional bits), signed */
  assetSharesRaw: bigint;
  /** Raw I80F48 value (48 fractional bits), signed */
  liabilitySharesRaw: bigint;
};

/** Balance-derived indexer flags, in on-chain byte order within IndexerFlags */
export type IndexerFlags = {
  isLendingOnly: number;
  isEmpty: number;
  isSingleBorrower: number;
  hasIsolated: number;
  hasStaked: number;
  hasKamino: number;
  hasDrift: number;
  hasJuplend: number;
};

export type RawMarginfiAccount = {
  pubkey: PublicKey;
  group: PublicKey;
  balances: RawBalance[];
  accountFlags: bigint;
  lastUpdate: bigint;
  activeOrders: number;
  liquidationRecord: PublicKey;
  indexerFlags: IndexerFlags;
};

/** Reads a signed 128-bit little-endian integer (raw I80F48) */
function readI80F48Raw(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigInt64LE(offset + 8);
  return (hi << 64n) | lo;
}

export function decodeMarginfiAccountRaw(
  pubkey: PublicKey,
  data: Buffer,
): RawMarginfiAccount {
  const balances: RawBalance[] = [];
  for (let i = 0; i < MAX_BALANCES; i++) {
    const base = BALANCES_OFFSET + i * BALANCE_SIZE;
    balances.push({
      active: data[base] !== 0,
      bankAssetTag: data[base + 33],
      assetSharesRaw: readI80F48Raw(data, base + 40),
      liabilitySharesRaw: readI80F48Raw(data, base + 56),
    });
  }

  const flagsBase = INDEXER_FLAGS_OFFSET;
  return {
    pubkey,
    group: new PublicKey(data.subarray(GROUP_OFFSET, GROUP_OFFSET + 32)),
    balances,
    accountFlags: data.readBigUInt64LE(ACCOUNT_FLAGS_OFFSET),
    lastUpdate: data.readBigUInt64LE(LAST_UPDATE_OFFSET),
    activeOrders: data[ACTIVE_ORDERS_OFFSET],
    liquidationRecord: new PublicKey(
      data.subarray(LIQUIDATION_RECORD_OFFSET, LIQUIDATION_RECORD_OFFSET + 32),
    ),
    indexerFlags: {
      isLendingOnly: data[flagsBase + 0],
      isEmpty: data[flagsBase + 1],
      isSingleBorrower: data[flagsBase + 2],
      hasIsolated: data[flagsBase + 6],
      hasStaked: data[flagsBase + 7],
      hasKamino: data[flagsBase + 8],
      hasDrift: data[flagsBase + 9],
      hasJuplend: data[flagsBase + 10],
    },
  };
}

/**
 * Mirrors IndexerFlags::sync_balance_derived. Returns the flags the on-chain sync would
 * produce; hasIsolated keeps its stored value unless the liability count is zero.
 */
export function computeBalanceDerivedFlags(
  account: RawMarginfiAccount,
): IndexerFlags {
  let liabilityCount = 0;
  let hasAnyBalance = false;
  let staked = false;
  let kamino = false;
  let drift = false;
  let juplend = false;

  for (const b of account.balances) {
    if (!b.active) continue;
    // Mirrors Balance::get_side().is_none(): both sides below the empty threshold
    if (b.assetSharesRaw < I80F48_ONE && b.liabilitySharesRaw < I80F48_ONE)
      continue;
    hasAnyBalance = true;

    if (b.liabilitySharesRaw >= I80F48_ONE) liabilityCount++;

    switch (b.bankAssetTag) {
      case ASSET_TAG_STAKED:
        staked = true;
        break;
      case ASSET_TAG_KAMINO:
        kamino = true;
        break;
      case ASSET_TAG_DRIFT:
        drift = true;
        break;
      case ASSET_TAG_JUPLEND:
        juplend = true;
        break;
    }
  }

  return {
    isEmpty: hasAnyBalance ? 0 : 1,
    isLendingOnly: hasAnyBalance && liabilityCount === 0 ? 1 : 0,
    isSingleBorrower: liabilityCount === 1 ? 1 : 0,
    hasStaked: staked ? 1 : 0,
    hasKamino: kamino ? 1 : 0,
    hasDrift: drift ? 1 : 0,
    hasJuplend: juplend ? 1 : 0,
    hasIsolated: liabilityCount === 0 ? 0 : account.indexerFlags.hasIsolated,
  };
}

export function indexerFlagsEqual(a: IndexerFlags, b: IndexerFlags): boolean {
  return (
    a.isEmpty === b.isEmpty &&
    a.isLendingOnly === b.isLendingOnly &&
    a.isSingleBorrower === b.isSingleBorrower &&
    a.hasStaked === b.hasStaked &&
    a.hasKamino === b.hasKamino &&
    a.hasDrift === b.hasDrift &&
    a.hasJuplend === b.hasJuplend &&
    a.hasIsolated === b.hasIsolated
  );
}

/** Anchor global instruction discriminator: sha256("global:<name>")[0..8] */
export function ixDiscriminator(name: string): Buffer {
  return createHash("sha256")
    .update(`global:${name}`)
    .digest()
    .subarray(0, 8);
}

const HYDRATE_CHUNK = 100;

export type FetchPacing = {
  /** Concurrent hydration workers (default 4) */
  concurrency?: number;
  /** Global cap on RPC request starts per second (default 8); lower this on 429s */
  requestsPerSecond?: number;
};

/**
 * Fetches every MarginfiAccount owned by the program (optionally restricted to one group)
 * and decodes them from raw bytes.
 *
 * Runs in two phases because a single full-data getProgramAccounts response for all
 * accounts (~1.6 GB of JSON) exceeds Node's maximum string length: first a pubkey-only
 * scan via dataSlice, then hydration through chunked getMultipleAccountsInfo calls.
 */
export async function fetchAllMarginfiAccountsRaw(
  connection: Connection,
  programId: PublicKey,
  group?: PublicKey,
  pacing?: FetchPacing,
): Promise<RawMarginfiAccount[]> {
  const concurrency = pacing?.concurrency ?? 4;
  const pace = makePacer(pacing?.requestsPerSecond ?? 8);
  const filters: GetProgramAccountsFilter[] = [
    {
      memcmp: {
        offset: 0,
        bytes: utils.bytes.bs58.encode(MARGINFI_ACCOUNT_DISCRIMINATOR),
      },
    },
  ];
  if (group) {
    filters.push({ memcmp: { offset: GROUP_OFFSET, bytes: group.toBase58() } });
  }

  const keyOnly = await withRetry(async () => {
    await pace();
    return connection.getProgramAccounts(programId, {
      filters,
      dataSlice: { offset: 0, length: 0 },
    });
  });
  const pubkeys = keyOnly.map((a) => a.pubkey);
  console.log(`Found ${pubkeys.length} accounts, hydrating...`);

  const chunks: PublicKey[][] = [];
  for (let i = 0; i < pubkeys.length; i += HYDRATE_CHUNK) {
    chunks.push(pubkeys.slice(i, i + HYDRATE_CHUNK));
  }

  const results: RawMarginfiAccount[][] = new Array(chunks.length);
  let closedSinceScan = 0;
  let skippedSize = 0;
  let next = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, chunks.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= chunks.length) break;
        const infos = await withRetry(async () => {
          await pace();
          return connection.getMultipleAccountsInfo(chunks[i]);
        });
        const out: RawMarginfiAccount[] = [];
        infos.forEach((info, j) => {
          if (!info) {
            closedSinceScan++;
            return;
          }
          if (info.data.length !== MARGINFI_ACCOUNT_SIZE) {
            skippedSize++;
            console.warn(
              `Skipping ${chunks[i][j].toBase58()}: unexpected data length ${info.data.length}`,
            );
            return;
          }
          out.push(decodeMarginfiAccountRaw(chunks[i][j], info.data));
        });
        results[i] = out;
        if ((i + 1) % 500 === 0) {
          console.log(
            `  hydrated ~${(i + 1) * HYDRATE_CHUNK}/${pubkeys.length}`,
          );
        }
      }
    },
  );
  await Promise.all(workers);

  const decoded = results.flat();
  if (closedSinceScan > 0) {
    console.log(`${closedSinceScan} accounts closed between scan and hydration`);
  }
  if (skippedSize > 0) {
    console.warn(`Skipped ${skippedSize} accounts with unexpected data length`);
  }
  return decoded;
}
