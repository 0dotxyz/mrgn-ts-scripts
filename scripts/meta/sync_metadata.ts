import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { getTokenMetadata } from "@solana/spl-token";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { commonSetup } from "../../lib/common-setup";
import { configs } from "../../lib/config";
import { Environment } from "../../lib/types";
import { loadEnvFile } from "../utils/utils";
import { buildMintToGroupMap } from "./asset_groups";
import {
  applyEntry,
  ApplyStatus,
  BankMetadataEntry,
} from "./write_bank_metadata";

/**
 * Sync bank metadata for every active bank in the target group.
 *
 * Flow:
 *   1. Pull active banks from bankCache.
 *   2. Bulk-fetch every metadata PDA in one batched RPC.
 *   3. For each bank, resolve {name, symbol} via cache → Jupiter → Metaplex →
 *      Token-2022, build the target ticker/description, and compare against
 *      the pre-fetched on-chain state. Classify into init+write / update /
 *      skip / unresolved.
 *   4. Print the classification summary, then apply only the actionable
 *      entries (init+write and update). Skipped banks never re-enter the
 *      RPC/tx loop.
 *
 * Token-name resolutions are cached at scripts/meta/data/token-name-cache.json
 * keyed by mint, so subsequent runs do no Jupiter calls for unchanged mints.
 * Pass --refresh-cache to ignore the cache for this run.
 *
  * Venue is derived from the on-chain assetTag:
  *   3 Kamino, 4 Drift, 5 Solend, 6 JupLend, everything else P0.
 *
 * Asset group is the mint's bucket in asset_groups.ts; Isolated risk-tier
 * banks force W/E (matches the convention in write_bank_metadata.ts).
 */

const BANK_CACHE_URL = "https://api.0.xyz/v0/bankCache";
const JUP_SEARCH_URL = "https://api.jup.ag/tokens/v2/search";
const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

const CACHE_PATH = path.resolve(__dirname, "data/token-name-cache.json");

const ASSET_TAG_TO_VENUE: Record<number, string> = {
  3: "Kamino",
  4: "Drift",
  5: "Solend",
  6: "JupLend",
};

type CachedBank = {
  address: string;
  mint: string;
  group: string;
  tokenSymbol: string;
  config: {
    oracleSetup: string;
    riskTier: string;
    assetTag: number;
  };
};

type TokenInfoSource = "jupiter" | "metaplex" | "token2022";
type TokenInfo = { name: string; symbol: string; source: TokenInfoSource };
type JupTokenHit = { id: string; name?: string; symbol?: string };

type TokenNameCacheEntry = TokenInfo & { cachedAt: number };
type TokenNameCache = Record<string, TokenNameCacheEntry>;

type CurrentMetadata = { ticker: string; description: string };

type ActionKind = "init" | "update" | "skip" | "unresolved";

type Classification = {
  bank: CachedBank;
  resolved: TokenInfo | null;
  current: CurrentMetadata | null;
  target: BankMetadataEntry | null;
  kind: ActionKind;
};

// --- Token name resolution -------------------------------------------------

async function resolveFromJupiter(mint: string): Promise<TokenInfo | null> {
  const apiKey = process.env.JUP_API_KEY?.trim().replace(/^['"]|['"]$/g, "");
  if (!apiKey) return null;

  let resp: Response;
  try {
    resp = await fetch(
      `${JUP_SEARCH_URL}?query=${encodeURIComponent(mint)}`,
      { headers: { "x-api-key": apiKey } },
    );
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  const hits = (await resp.json()) as JupTokenHit[];
  if (!Array.isArray(hits) || hits.length === 0) return null;

  const match = hits.find((h) => h.id === mint) ?? hits[0];
  const name = match?.name?.trim();
  const symbol = match?.symbol?.trim();
  if (!name || !symbol) return null;
  return { name, symbol, source: "jupiter" };
}

function deriveMplMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

// Metaplex strings are borsh-encoded (u32 length + bytes) but the on-chain
// buffers are padded to 32/10/200, so trailing nulls need stripping.
function readBorshString(
  buf: Buffer,
  offset: number,
): { value: string; next: number } {
  const len = buf.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  const raw = buf.subarray(start, end).toString("utf8");
  return { value: raw.replace(/\0+$/, "").trim(), next: end };
}

async function resolveFromMetaplex(
  connection: Connection,
  mint: PublicKey,
): Promise<TokenInfo | null> {
  const pda = deriveMplMetadataPda(mint);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  // key(1) + updateAuthority(32) + mint(32) = 65
  const offset = 1 + 32 + 32;
  const { value: name, next } = readBorshString(info.data, offset);
  const { value: symbol } = readBorshString(info.data, next);
  if (!name) return null;
  return { name, symbol, source: "metaplex" };
}

async function resolveFromToken2022(
  connection: Connection,
  mint: PublicKey,
): Promise<TokenInfo | null> {
  try {
    const meta = await getTokenMetadata(connection, mint);
    if (!meta?.name || !meta?.symbol) return null;
    return {
      name: meta.name.trim(),
      symbol: meta.symbol.trim(),
      source: "token2022",
    };
  } catch {
    return null;
  }
}

async function resolveTokenName(
  connection: Connection,
  mint: string,
): Promise<TokenInfo | null> {
  const pk = new PublicKey(mint);
  return (
    (await resolveFromJupiter(mint)) ??
    (await resolveFromMetaplex(connection, pk)) ??
    (await resolveFromToken2022(connection, pk))
  );
}

// --- Local name cache ------------------------------------------------------

function loadCache(): TokenNameCache {
  if (!fs.existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as TokenNameCache;
  } catch {
    return {};
  }
}

function saveCache(cache: TokenNameCache): void {
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
}

async function resolveWithCache(
  connection: Connection,
  mint: string,
  cache: TokenNameCache,
): Promise<{ info: TokenInfo | null; hit: boolean }> {
  const cached = cache[mint];
  if (cached) {
    return {
      info: { name: cached.name, symbol: cached.symbol, source: cached.source },
      hit: true,
    };
  }
  const fresh = await resolveTokenName(connection, mint);
  if (fresh) cache[mint] = { ...fresh, cachedAt: Date.now() };
  return { info: fresh, hit: false };
}

// --- Entry building --------------------------------------------------------

function deriveVenueFromAssetTag(assetTag: number): string {
  return ASSET_TAG_TO_VENUE[assetTag] ?? "P0";
}

function resolveAssetGroup(
  mint: string,
  riskTier: string,
  mintToGroup: Record<string, string>,
): string {
  if (riskTier.toLowerCase() === "isolated") return "W/E";
  return mintToGroup[mint] ?? "W/E";
}

function buildEntry(
  bank: CachedBank,
  resolved: TokenInfo,
  mintToGroup: Record<string, string>,
): BankMetadataEntry {
  const venue = deriveVenueFromAssetTag(bank.config.assetTag);
  const assetGroup = resolveAssetGroup(
    bank.mint,
    bank.config.riskTier,
    mintToGroup,
  );
  return {
    bank: new PublicKey(bank.address),
    group: new PublicKey(bank.group),
    mint: new PublicKey(bank.mint),
    ticker: `${resolved.symbol} | ${resolved.name}`,
    description: `${resolved.name} | ${assetGroup} | ${resolved.symbol} | ${venue} | -`,
  };
}

// --- On-chain bulk fetch ---------------------------------------------------

async function fetchActiveBanks(group: string): Promise<CachedBank[]> {
  const resp = await fetch(BANK_CACHE_URL);
  if (!resp.ok) {
    throw new Error(
      `bankCache fetch failed: ${resp.status} ${resp.statusText}`,
    );
  }
  const cache = (await resp.json()) as { banks: CachedBank[] };
  return cache.banks.filter((b) => b.group === group);
}

function deriveBankMetadataPda(
  programId: PublicKey,
  bank: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata", "utf-8"), bank.toBuffer()],
    programId,
  )[0];
}

function decodeMetadataChars(acc: {
  ticker: number[];
  description: number[];
  endTickerByte: number;
  endDescriptionByte: number;
}): CurrentMetadata {
  const toStr = (bytes: number[], end: number) => {
    if (!bytes.length || bytes[0] === 0) return "";
    const buf = Buffer.from(bytes);
    const len = Math.min(end + 1, buf.length);
    return buf.subarray(0, len).toString("utf-8");
  };
  return {
    ticker: toStr(acc.ticker, acc.endTickerByte),
    description: toStr(acc.description, acc.endDescriptionByte),
  };
}

// --- Main ------------------------------------------------------------------

async function main() {
  loadEnvFile(".env");

  const argv = yargs(hideBin(process.argv))
    .option("env", {
      type: "string",
      choices: ["production", "staging"] as Environment[],
      default: "production",
      description: "Marginfi environment",
    })
    .option("group", {
      type: "string",
      description: "Override group address (defaults to env's configured group)",
    })
    .option("wallet", {
      type: "string",
      description: "Wallet keypair path (defaults to MARGINFI_WALLET)",
    })
    .option("send", {
      type: "boolean",
      default: true,
      description:
        "true: sign+send with local wallet. false: emit unsigned b58 tx per bank for multisig.",
    })
    .option("multisig", {
      type: "string",
      description: "Multisig payer pubkey (required when --send false)",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      description: "Resolve and print target entries without sending",
    })
    .option("out", {
      type: "string",
      description: "Write the actionable plan to a JSON file",
    })
    .option("limit", {
      type: "number",
      description: "Only process the first N banks (for testing)",
    })
    .option("delay", {
      type: "number",
      default: 1000,
      description: "Delay in ms between cache-miss lookups and between writes",
    })
    .option("refresh-cache", {
      type: "boolean",
      default: false,
      description:
        "Ignore the local token-name cache for this run (entries are still re-written)",
    })
    .parseSync();

  const env = argv.env as Environment;
  const envConfig = configs[env];
  const programId = new PublicKey(envConfig.PROGRAM_ID);
  const group = argv.group ?? envConfig.GROUP_ADDRESS;
  const multisigPayer = argv.multisig
    ? new PublicKey(argv.multisig)
    : undefined;
  const walletPath = argv.wallet ?? process.env.MARGINFI_WALLET;

  const user = commonSetup(
    argv.send,
    envConfig.PROGRAM_ID,
    walletPath,
    multisigPayer,
  );

  console.log(`Environment: ${env}`);
  console.log(`Group:       ${group}`);
  console.log(`Program:     ${programId.toBase58()}`);
  console.log(`Signer:      ${user.wallet.publicKey.toBase58()}\n`);

  // ----- Phase 1: discover active banks
  console.log("Fetching active banks from bankCache...");
  const allActive = await fetchActiveBanks(group);
  const active = argv.limit ? allActive.slice(0, argv.limit) : allActive;
  console.log(
    `  active in group: ${allActive.length}${argv.limit ? ` (processing first ${active.length})` : ""}`,
  );

  if (active.length === 0) {
    console.log("No active banks found.");
    return;
  }

  // ----- Phase 2: bulk-fetch current metadata
  console.log("Bulk-fetching current metadata PDAs...");
  const pdas = active.map((b) =>
    deriveBankMetadataPda(programId, new PublicKey(b.address)),
  );
  const fetched = (await user.program.account.bankMetadata.fetchMultiple(
    pdas,
  )) as Array<{
    ticker: number[];
    description: number[];
    endTickerByte: number;
    endDescriptionByte: number;
  } | null>;

  const currentByBank = new Map<string, CurrentMetadata | null>();
  const pdaByBank = new Map<string, string>();
  for (let i = 0; i < active.length; i++) {
    currentByBank.set(
      active[i].address,
      fetched[i] ? decodeMetadataChars(fetched[i]!) : null,
    );
    pdaByBank.set(active[i].address, pdas[i].toBase58());
  }
  const withMeta = [...currentByBank.values()].filter((c) => c !== null).length;
  console.log(
    `  with metadata: ${withMeta}, missing: ${active.length - withMeta}\n`,
  );

  // ----- Phase 3: classify with cached/fresh name resolution
  const cache = argv["refresh-cache"] ? {} : loadCache();
  const initialCacheSize = Object.keys(cache).length;
  console.log(
    `Token-name cache: ${initialCacheSize} entr${initialCacheSize === 1 ? "y" : "ies"}${argv["refresh-cache"] ? " (refreshing — bypassing reads)" : ""}`,
  );

  const mintToGroup = buildMintToGroupMap();
  const classifications: Classification[] = [];
  const tableRows: Record<string, string>[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  console.log(`Classifying ${active.length} bank(s)...`);
  for (let i = 0; i < active.length; i++) {
    const bank = active[i];
    process.stdout.write(
      `  [${i + 1}/${active.length}] ${bank.address} (${bank.tokenSymbol}) mint=${bank.mint}... `,
    );

    const { info: resolved, hit } = await resolveWithCache(
      user.connection,
      bank.mint,
      cache,
    );
    if (hit) cacheHits++;
    else cacheMisses++;

    const current = currentByBank.get(bank.address) ?? null;

    const metadataPda = pdaByBank.get(bank.address) ?? "";

    if (!resolved) {
      classifications.push({
        bank,
        resolved: null,
        current,
        target: null,
        kind: "unresolved",
      });
      console.log("UNRESOLVED");
      tableRows.push({
        symbol: bank.tokenSymbol,
        bank: bank.address,
        mint: bank.mint,
        metadataPda,
        kind: "unresolved",
        ticker: "",
        description: "",
      });
      continue;
    }

    const target = buildEntry(bank, resolved, mintToGroup);

    let kind: ActionKind;
    if (!current) {
      kind = "init";
    } else if (
      current.ticker === target.ticker &&
      current.description === target.description
    ) {
      kind = "skip";
    } else {
      kind = "update";
    }

    classifications.push({ bank, resolved, current, target, kind });
    console.log(`${hit ? "cached" : resolved.source} → ${kind}`);
    tableRows.push({
      symbol: bank.tokenSymbol,
      bank: bank.address,
      mint: bank.mint,
      metadataPda,
      kind,
      ticker: target.ticker,
      description: target.description,
    });

    // Only pace on real network calls.
    if (!hit && i < active.length - 1 && argv.delay > 0) {
      await new Promise((r) => setTimeout(r, argv.delay));
    }
  }

  saveCache(cache);

  console.log("\n=== Banks ===");
  for (const [i, r] of tableRows.entries()) {
    console.log(`\n[${i + 1}] ${r.symbol} (${r.kind})`);
    console.log(`    bank:        ${r.bank}`);
    console.log(`    mint:        ${r.mint}`);
    console.log(`    metadataPda: ${r.metadataPda}`);
    console.log(`    ticker:      ${r.ticker}`);
    console.log(`    description: ${r.description}`);
  }

  // ----- Phase 4: print classification summary
  const initActions = classifications.filter((c) => c.kind === "init");
  const updateActions = classifications.filter((c) => c.kind === "update");
  const skips = classifications.filter((c) => c.kind === "skip");
  const unresolved = classifications.filter((c) => c.kind === "unresolved");
  const actionable = [...initActions, ...updateActions];

  console.log(
    `\n=== Classification (cache hits: ${cacheHits}, misses: ${cacheMisses}) ===`,
  );
  console.log(`  init+write:  ${initActions.length}`);
  console.log(`  update:      ${updateActions.length}`);
  console.log(`  skip:        ${skips.length}`);
  console.log(`  unresolved:  ${unresolved.length}`);

  if (initActions.length > 0) {
    console.log(`\n--- init+write (${initActions.length}) ---`);
    for (const [i, a] of initActions.entries()) {
      console.log(`  [${i + 1}] ${a.bank.address}`);
      console.log(`      ticker:      ${a.target!.ticker}`);
      console.log(`      description: ${a.target!.description}`);
    }
  }
  if (updateActions.length > 0) {
    console.log(`\n--- update (${updateActions.length}) ---`);
    for (const [i, a] of updateActions.entries()) {
      console.log(`  [${i + 1}] ${a.bank.address}`);
      console.log(`      from ticker: ${a.current!.ticker}`);
      console.log(`        to ticker: ${a.target!.ticker}`);
      console.log(`      from desc:   ${a.current!.description}`);
      console.log(`        to desc:   ${a.target!.description}`);
    }
  }
  if (unresolved.length > 0) {
    console.log(`\n--- unresolved (${unresolved.length}, on-chain metadata left untouched) ---`);
    for (const u of unresolved) {
      console.log(
        `  ${u.bank.address}  mint=${u.bank.mint}  symbol=${u.bank.tokenSymbol}`,
      );
    }
  }

  if (argv.out) {
    const plan = actionable.map((a) => ({
      bankAddress: a.target!.bank.toBase58(),
      group: a.target!.group.toBase58(),
      tokenAddress: a.target!.mint.toBase58(),
      ticker: a.target!.ticker,
      description: a.target!.description,
      action: a.kind,
    }));
    fs.writeFileSync(argv.out, JSON.stringify(plan, null, 2) + "\n");
    console.log(`\nWrote plan (${plan.length} actionable entries) to ${argv.out}`);
  }

  if (argv["dry-run"]) {
    console.log("\nDry run — nothing written.");
    return;
  }

  if (actionable.length === 0) {
    console.log("\nNothing to write — all resolved banks already in sync.");
    return;
  }

  if (!argv.send && !multisigPayer) {
    throw new Error("--multisig is required when --send false");
  }

  // ----- Phase 5: apply only actionable entries
  console.log(
    `\n=== Applying ${actionable.length} entr${actionable.length === 1 ? "y" : "ies"} ===`,
  );
  const counts: Record<ApplyStatus, number> = {
    UpToDate: 0,
    Updated: 0,
    CreatedAndUpdated: 0,
    Prepared: 0,
  };

  for (let i = 0; i < actionable.length; i++) {
    const a = actionable[i];
    console.log(
      `\n[${i + 1}/${actionable.length}] ${a.target!.bank.toBase58()} (${a.kind})`,
    );
    const result = await applyEntry(user, a.target!, argv.send, multisigPayer);
    counts[result.status]++;
    switch (result.status) {
      case "UpToDate":
        // Race: someone wrote the same content between phase 2 and now.
        console.log("  ✓ already up to date");
        break;
      case "Updated":
        console.log(`  update → ${result.sig}`);
        break;
      case "CreatedAndUpdated":
        console.log(`  init+write → ${result.sig}`);
        break;
      case "Prepared":
        console.log(`  b58 tx (multisig): ${result.b58}`);
        break;
    }
    if (i < actionable.length - 1 && argv.delay > 0) {
      await new Promise((r) => setTimeout(r, argv.delay));
    }
  }

  console.log(
    `\nDone. up-to-date=${counts.UpToDate}  updated=${counts.Updated}  init+written=${counts.CreatedAndUpdated}  prepared=${counts.Prepared}  skipped-upfront=${skips.length}  unresolved=${unresolved.length}`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
