import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { commonSetup } from "../../lib/common-setup";
import {
  ACCOUNT_DISABLED,
  ACCOUNT_FROZEN,
  ACCOUNT_IN_DELEVERAGE,
  ACCOUNT_IN_FLASHLOAN,
  ACCOUNT_IN_ORDER_EXECUTION,
  ACCOUNT_IN_RECEIVERSHIP,
  I80F48_ONE,
  RawMarginfiAccount,
  fetchAllMarginfiAccountsRaw,
  ixDiscriminator,
} from "../common/account_raw";
import { sendBatches } from "../common/batch_send";

/**
 * Permissionless sweep of closable marginfi accounts via admin_close_account (mrgn-0.1.9).
 * Mirrors the on-chain eligibility checks client-side (empty balances, no blocking flags, no
 * orders or liquidation record, inactive for more than 60 days), then closes eligible accounts
 * in batches. Rent is refunded to each group's global fee wallet, not the tx payer.
 */

// Set true to send. When false, dry-runs: writes the eligible account list to logs/ without
// sending, so the list can be reviewed first.
const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  /** Restrict to one group, or undefined for all groups */
  GROUP: PublicKey | undefined;
  /** Max accounts closed per transaction (one admin_close_account ix each) */
  BATCH_SIZE: number;
  /** Global cap on RPC requests per second; lower this if the provider returns 429s */
  RPC_REQUESTS_PER_SECOND: number;
  /** Compute unit limit per tx; a close consumes ~3,600 CU */
  COMPUTE_UNITS: number;
  /** Priority fee in micro-lamports per CU; raise when txs expire under congestion */
  PRIORITY_FEE_MICROLAMPORTS: number;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: undefined,
  BATCH_SIZE: 16,
  RPC_REQUESTS_PER_SECOND: 8,
  COMPUTE_UNITS: 120_000,
  PRIORITY_FEE_MICROLAMPORTS: 50_000,
};

const WALLET_PATH = "/.config/solana/id.json";

const SECONDS_PER_DAY = 86_400n;
// Buffer over the on-chain 60-day threshold so accounts right at the boundary don't fail the tx
const INACTIVITY_THRESHOLD_SECONDS = 60n * SECONDS_PER_DAY + 3_600n;

const BLOCKING_FLAGS =
  ACCOUNT_DISABLED |
  ACCOUNT_IN_FLASHLOAN |
  ACCOUNT_IN_RECEIVERSHIP |
  ACCOUNT_FROZEN |
  ACCOUNT_IN_DELEVERAGE |
  ACCOUNT_IN_ORDER_EXECUTION;

/** Mirrors can_be_closed + the admin_close_account checks */
function isCloseEligible(acc: RawMarginfiAccount, now: bigint): boolean {
  if ((acc.accountFlags & BLOCKING_FLAGS) !== 0n) return false;
  if (acc.activeOrders !== 0) return false;
  if (!acc.liquidationRecord.equals(PublicKey.default)) return false;

  // can_be_closed requires every balance slot to have no side (both sides below the empty
  // threshold of 1 share) and non-positive liability shares, which reduces to
  // asset < 1 && liability <= 0
  const allEmpty = acc.balances.every(
    (b) => b.assetSharesRaw < I80F48_ONE && b.liabilitySharesRaw <= 0n,
  );
  if (!allEmpty) return false;

  return now - acc.lastUpdate > INACTIVITY_THRESHOLD_SECONDS;
}

/**
 * Packs group-sorted accounts into transaction-sized batches. Every account from a group not
 * yet in the batch adds its group and fee-wallet keys, so the byte budget is tracked per
 * batch: ~108 bytes fixed (signature, header, blockhash, compute budget ix), 32 per unique
 * key, ~15 per close ix.
 */
function packBatches(
  accounts: RawMarginfiAccount[],
  maxPerTx: number,
): RawMarginfiAccount[][] {
  const TX_BYTE_BUDGET = 1200;
  const fits = (uniqueGroups: number, count: number) =>
    count <= maxPerTx &&
    108 + 32 * (3 + count + 2 * uniqueGroups) + 15 * count <= TX_BYTE_BUDGET;

  const sorted = [...accounts].sort((a, b) =>
    a.group.toBase58().localeCompare(b.group.toBase58()),
  );

  const batches: RawMarginfiAccount[][] = [];
  let current: RawMarginfiAccount[] = [];
  let groups = new Set<string>();
  for (const acc of sorted) {
    const groupKey = acc.group.toBase58();
    const nextGroups = groups.has(groupKey) ? groups.size : groups.size + 1;
    if (current.length > 0 && !fits(nextGroups, current.length + 1)) {
      batches.push(current);
      current = [];
      groups = new Set();
    }
    current.push(acc);
    groups.add(acc.group.toBase58());
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function main() {
  const user = commonSetup(true, config.PROGRAM_ID, WALLET_PATH, undefined);
  const { program, wallet } = user;
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

  const now = BigInt(Math.floor(Date.now() / 1000));
  const eligible = accounts.filter((acc) => isCloseEligible(acc, now));
  console.log(`${eligible.length} accounts eligible for permissionless close`);

  // Resolve each group's global fee wallet (receives the rent refund)
  const groupKeys = [
    ...new Map(eligible.map((a) => [a.group.toBase58(), a.group])).values(),
  ];
  const groups = await program.account.marginfiGroup.fetchMultiple(groupKeys);
  const feeWalletByGroup = new Map<string, PublicKey>();
  groups.forEach((group, i) => {
    if (!group) {
      console.warn(`Group ${groupKeys[i].toBase58()} not found, skipping`);
      return;
    }
    feeWalletByGroup.set(
      groupKeys[i].toBase58(),
      group.feeStateCache.globalFeeWallet,
    );
  });

  const closable = eligible.filter((acc) =>
    feeWalletByGroup.has(acc.group.toBase58()),
  );

  const logsDir = path.join(process.cwd(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, "closable_accounts.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      closable.map((acc) => ({
        account: acc.pubkey.toBase58(),
        group: acc.group.toBase58(),
        lastUpdate: Number(acc.lastUpdate),
      })),
      null,
      2,
    ),
  );
  console.log(`Eligible accounts written to: ${filePath}`);

  if (!sendTx) {
    console.log("Dry run only, no transactions sent.");
    return;
  }

  const discriminator = ixDiscriminator("admin_close_account");

  await sendBatches({
    connection,
    payer: wallet.payer,
    batches: packBatches(closable, config.BATCH_SIZE),
    buildIxs: (items) =>
      items.map(
        (acc) =>
          new TransactionInstruction({
            programId,
            keys: [
              { pubkey: acc.group, isSigner: false, isWritable: false },
              { pubkey: acc.pubkey, isSigner: false, isWritable: true },
              {
                pubkey: feeWalletByGroup.get(acc.group.toBase58())!,
                isSigner: false,
                isWritable: true,
              },
            ],
            data: discriminator,
          }),
      ),
    label: (acc) => acc.pubkey.toBase58(),
    failedLogName: "admin_close_failed.json",
    requestsPerSecond: config.RPC_REQUESTS_PER_SECOND,
    computeUnits: config.COMPUTE_UNITS,
    priorityFeeMicroLamports: config.PRIORITY_FEE_MICROLAMPORTS,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
