import fs from "fs";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Connection, PublicKey } from "@solana/web3.js";

import { configs } from "../../lib/config";
import { Environment } from "../../lib/types";
import { DEFAULT_API_URL, loadEnvFile } from "../utils/utils";

/**
 * Discover banks in the target group that don't yet have on-chain metadata.
 *
 * Two-pass filter:
 *  1. Cheap cross-reference: bankCache (active banks) vs bankMeta (banks the
 *     backend knows have written metadata).
 *  2. Authoritative: for every active bank in the group, derive its metadata
 *     PDA and check the chain. bankMeta can lag or miss entries, so the
 *     on-chain existence check is the ground truth.
 *
 * Emits the on-chain-verified missing list for the write command to consume,
 * and flags any discrepancies between bankMeta and on-chain state.
 */

const BANK_CACHE_URL = "https://api.0.xyz/v0/bankCache";
const BANK_META_URL = "https://api.0.xyz/v0/bankMeta";
const GET_ACCOUNTS_CHUNK = 100;

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

export type MissingMetadataBank = {
  bank: string;
  mint: string;
  group: string;
  symbol: string;
  venue: string;
  riskTier: string;
  oracleSetup: string;
  assetTag: number;
};

function deriveVenue(oracleSetup: string): string {
  const s = oracleSetup.toLowerCase();
  if (s.includes("kamino")) return "Kamino";
  if (s.includes("drift")) return "Drift";
  if (s.includes("solend")) return "Solend";
  if (s.includes("juplend")) return "JupLend";
  return "P0";
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

function toMissingBank(b: CachedBank): MissingMetadataBank {
  return {
    bank: b.address,
    mint: b.mint,
    group: b.group,
    symbol: b.tokenSymbol,
    venue: deriveVenue(b.config.oracleSetup),
    riskTier: b.config.riskTier,
    oracleSetup: b.config.oracleSetup,
    assetTag: b.config.assetTag,
  };
}

/**
 * Fetch account info for every PDA in batches of GET_ACCOUNTS_CHUNK, returning
 * a set of base58 addresses that exist on-chain.
 */
async function existingAccounts(
  connection: Connection,
  pdas: PublicKey[],
): Promise<Set<string>> {
  const exists = new Set<string>();
  for (let i = 0; i < pdas.length; i += GET_ACCOUNTS_CHUNK) {
    const slice = pdas.slice(i, i + GET_ACCOUNTS_CHUNK);
    const infos = await connection.getMultipleAccountsInfo(slice);
    infos.forEach((info, j) => {
      if (info) exists.add(slice[j].toBase58());
    });
  }
  return exists;
}

export async function findBanksWithoutMetadata(
  connection: Connection,
  programId: PublicKey,
  group: string,
): Promise<{
  missing: MissingMetadataBank[];
  endpointOnly: string[];
  onChainOnly: string[];
  totalActive: number;
}> {
  const [cacheResp, metaResp] = await Promise.all([
    fetch(BANK_CACHE_URL),
    fetch(BANK_META_URL),
  ]);
  if (!cacheResp.ok) {
    throw new Error(
      `bankCache fetch failed: ${cacheResp.status} ${cacheResp.statusText}`,
    );
  }
  if (!metaResp.ok) {
    throw new Error(
      `bankMeta fetch failed: ${metaResp.status} ${metaResp.statusText}`,
    );
  }
  const cache = (await cacheResp.json()) as { banks: CachedBank[] };
  const meta = (await metaResp.json()) as { banks: Record<string, unknown> };

  const active = cache.banks.filter((b) => b.group === group);
  const endpointReportedMissing = new Set(
    active.filter((b) => !(b.address in meta.banks)).map((b) => b.address),
  );

  // Authoritative check: metadata PDA actually on-chain?
  const pdas = active.map((b) =>
    deriveBankMetadataPda(programId, new PublicKey(b.address)),
  );
  const onChainPresent = await existingAccounts(connection, pdas);

  const missing: MissingMetadataBank[] = [];
  const endpointOnly: string[] = []; // reported missing but PDA exists
  const onChainOnly: string[] = []; // not reported missing but PDA absent

  for (let i = 0; i < active.length; i++) {
    const b = active[i];
    const pdaExists = onChainPresent.has(pdas[i].toBase58());
    const reportedMissing = endpointReportedMissing.has(b.address);

    if (!pdaExists) {
      missing.push(toMissingBank(b));
      if (!reportedMissing) onChainOnly.push(b.address);
    } else if (reportedMissing) {
      endpointOnly.push(b.address);
    }
  }

  return { missing, endpointOnly, onChainOnly, totalActive: active.length };
}

async function main() {
  loadEnvFile(".env.api");

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
    .option("out", {
      type: "string",
      description: "Write the missing-metadata list to this JSON path",
    })
    .parseSync();

  const env = argv.env as Environment;
  const envConfig = configs[env];
  const group = argv.group ?? envConfig.GROUP_ADDRESS;
  const programId = new PublicKey(envConfig.PROGRAM_ID);
  const connection = new Connection(
    process.env.API_URL || DEFAULT_API_URL,
    "confirmed",
  );

  console.log(`Environment: ${env}`);
  console.log(`Group:       ${group}`);
  console.log(`Program:     ${programId.toBase58()}`);
  console.log(`Sources:`);
  console.log(`  bankCache: ${BANK_CACHE_URL}`);
  console.log(`  bankMeta:  ${BANK_META_URL}`);
  console.log(`  on-chain:  ${connection.rpcEndpoint}\n`);

  const { missing, endpointOnly, onChainOnly, totalActive } =
    await findBanksWithoutMetadata(connection, programId, group);

  console.log(`Active banks in group:           ${totalActive}`);
  console.log(`Missing metadata (on-chain PDA): ${missing.length}`);
  if (onChainOnly.length > 0) {
    console.log(
      `  [!] ${onChainOnly.length} bank(s) bankMeta says are covered, but PDA is NOT on-chain:`,
    );
    for (const b of onChainOnly) console.log(`      ${b}`);
  }
  if (endpointOnly.length > 0) {
    console.log(
      `  [i] ${endpointOnly.length} bank(s) bankMeta flagged missing, but PDA IS on-chain (endpoint lag):`,
    );
    for (const b of endpointOnly) console.log(`      ${b}`);
  }

  if (missing.length > 0) {
    console.log();
    console.table(
      missing.map((m) => ({
        Bank: m.bank,
        Mint: m.mint,
        Symbol: m.symbol,
        Venue: m.venue,
        RiskTier: m.riskTier,
        Oracle: m.oracleSetup,
        AssetTag: m.assetTag,
      })),
    );
  }

  if (argv.out) {
    fs.writeFileSync(argv.out, JSON.stringify(missing, null, 2) + "\n");
    console.log(`\nWrote ${missing.length} entries to ${argv.out}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
