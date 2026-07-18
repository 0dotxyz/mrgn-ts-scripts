import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { commonSetup } from "../../lib/common-setup";
import {
  RawMarginfiAccount,
  computeBalanceDerivedFlags,
  fetchAllMarginfiAccountsRaw,
  indexerFlagsEqual,
  ixDiscriminator,
} from "../common/account_raw";
import { sendBatches } from "../common/batch_send";

/**
 * Permissionless backfill of balance-derived indexer flags (mrgn-0.1.9). Fetches every live
 * marginfi account, skips those whose stored flags already match what sync_indexer_flags
 * would write, and batches the rest as writable remaining accounts on sync_indexer_flags
 * txes. Safe to re-run: already-synced accounts are skipped, so a partial run resumes
 * cheaply.
 */

// Set true to send. When false, dry-runs: writes the accounts needing sync to logs/ without
// sending.
const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  /** Restrict to one group, or undefined for all groups */
  GROUP: PublicKey | undefined;
  /** Marginfi accounts per transaction (all passed as writable remaining accounts) */
  BATCH_SIZE: number;
  /** Global cap on RPC requests per second; lower this if the provider returns 429s */
  RPC_REQUESTS_PER_SECOND: number;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: undefined,
  BATCH_SIZE: 25,
  RPC_REQUESTS_PER_SECOND: 8,
};

const WALLET_PATH = "/.config/solana/id.json";

async function main() {
  const user = commonSetup(true, config.PROGRAM_ID, WALLET_PATH, undefined);
  const { wallet } = user;
  const programId = new PublicKey(config.PROGRAM_ID);

  dotenv.config();
  const connection = process.env.PRIVATE_RPC_ENDPOINT
    ? new Connection(process.env.PRIVATE_RPC_ENDPOINT, "confirmed")
    : user.connection;
  console.log(
    process.env.PRIVATE_RPC_ENDPOINT
      ? "Using PRIVATE_RPC_ENDPOINT"
      : "PRIVATE_RPC_ENDPOINT not set, using default API_URL",
  );

  console.log("Fetching all marginfi accounts...");
  const accounts = await fetchAllMarginfiAccountsRaw(
    connection,
    programId,
    config.GROUP,
    { requestsPerSecond: config.RPC_REQUESTS_PER_SECOND },
  );
  console.log(`Fetched ${accounts.length} accounts`);

  const needsSync = accounts.filter(
    (acc) =>
      !indexerFlagsEqual(acc.indexerFlags, computeBalanceDerivedFlags(acc)),
  );
  console.log(
    `${needsSync.length} accounts need syncing (${accounts.length - needsSync.length} already in sync)`,
  );

  const logsDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, "accounts_needing_sync.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      needsSync.map((acc) => acc.pubkey.toBase58()),
      null,
      2,
    ),
  );
  console.log(`Accounts needing sync written to: ${filePath}`);

  if (!sendTx) {
    console.log("Dry run only, no transactions sent.");
    return;
  }

  const discriminator = ixDiscriminator("sync_indexer_flags");
  const batches: RawMarginfiAccount[][] = [];
  for (let i = 0; i < needsSync.length; i += config.BATCH_SIZE) {
    batches.push(needsSync.slice(i, i + config.BATCH_SIZE));
  }

  await sendBatches({
    connection,
    payer: wallet.payer,
    batches,
    buildIxs: (items) => [
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          ...items.map((acc) => ({
            pubkey: acc.pubkey,
            isSigner: false,
            isWritable: true,
          })),
        ],
        data: discriminator,
      }),
    ],
    label: (acc) => acc.pubkey.toBase58(),
    failedLogName: "sync_indexer_flags_failed.json",
    requestsPerSecond: config.RPC_REQUESTS_PER_SECOND,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
