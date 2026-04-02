/**
 * Dump all marginfi accounts and banks to JSON for offline analytics.
 *
 * Output:
 *   dumps/banks-raw.json                  (single file, small)
 *   dumps/accounts-raw-000.json           (batch 0: accounts 0–9999)
 *   dumps/accounts-raw-001.json           (batch 1: accounts 10000–19999)
 *   ...
 *
 * Each account batch file is a simple JSON array of {address, data} objects,
 * small enough to JSON.parse in one shot.
 *
 * Usage: tsx scripts/drift/sunset/dump-accounts.ts
 */

import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { getMarginfiProgram, getConfig } from "../../../lib/config";
import { getCachedAccounts } from "../../../lib/utils";
import { chunk } from "../../utils";

dotenv.config();

const ENV = "production";
const RPC_BATCH_SIZE = 100;
const CONCURRENCY = 10;
const FILE_BATCH_SIZE = 10_000;
const DUMPS_DIR = path.join(__dirname, "dumps");

async function main() {
  const program = getMarginfiProgram(ENV);
  const connection = program.provider.connection;
  const timestamp = new Date().toISOString();

  if (!fs.existsSync(DUMPS_DIR)) {
    fs.mkdirSync(DUMPS_DIR);
  }

  console.log("=== Dump All ===\n");

  // 1. Banks — fetch all via discriminator (same approach as account cache)
  const config = getConfig(ENV as any);
  const discriminator = bs58.encode(
    new BorshAccountsCoder(program.idl).accountDiscriminator("Bank"),
  );

  console.log("Fetching all bank pubkeys via getProgramAccounts...");
  const bankAccounts = await connection.getProgramAccounts(program.programId, {
    commitment: connection.commitment,
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: 0, bytes: discriminator } },
      { memcmp: { offset: 8, bytes: config.GROUP_ADDRESS } },
    ],
  });
  const bankAddresses = bankAccounts.map((a) => a.pubkey);
  console.log(`  ${bankAddresses.length} banks found`);

  console.log("Fetching bank account data (raw)...");
  const bankBatches = chunk(bankAddresses, RPC_BATCH_SIZE);
  const banks: any[] = [];
  for (const batch of bankBatches) {
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      if (!info) continue;
      banks.push({
        address: batch[i].toBase58(),
        data: info.data.toString("base64"),
        owner: info.owner.toBase58(),
      });
    }
  }

  const banksFile = path.join(DUMPS_DIR, "banks-raw.json");
  fs.writeFileSync(
    banksFile,
    JSON.stringify({ timestamp, env: ENV, bankCount: banks.length, banks }, null, 2),
  );
  console.log(`  ${banks.length} banks → ${banksFile}`);

  // 2. Accounts — batched into files of FILE_BATCH_SIZE
  const cachedAccounts = getCachedAccounts();
  console.log(
    `\nFetching ${cachedAccounts.length} accounts ` +
      `(raw, concurrency=${CONCURRENCY}, ${FILE_BATCH_SIZE}/file)...`,
  );

  const rpcBatches = chunk(cachedAccounts, RPC_BATCH_SIZE);
  const concurrentGroups = chunk(rpcBatches, CONCURRENCY);

  let processed = 0;
  let saved = 0;
  let skipped = 0;
  let fileIndex = 0;
  let currentBatch: any[] = [];

  const flushBatch = () => {
    if (currentBatch.length === 0) return;
    const fileName = `accounts-raw-${String(fileIndex).padStart(3, "0")}.json`;
    const filePath = path.join(DUMPS_DIR, fileName);
    fs.writeFileSync(filePath, JSON.stringify(currentBatch));
    const sizeMb = fs.statSync(filePath).size / 1024 / 1024;
    console.log(
      `  Wrote ${fileName}: ${currentBatch.length} accounts (${sizeMb.toFixed(1)} MB)`,
    );
    fileIndex++;
    currentBatch = [];
  };

  for (const group of concurrentGroups) {
    const results = await Promise.all(
      group.map((batch) =>
        connection.getMultipleAccountsInfo(batch).then(
          (infos) => ({ batch, infos }),
          (err) => {
            console.warn(`  Batch failed, will retry: ${err.message}`);
            return { batch, infos: null };
          },
        ),
      ),
    );

    for (const result of results) {
      if (!result.infos) {
        try {
          result.infos = await connection.getMultipleAccountsInfo(result.batch);
        } catch (err: any) {
          console.warn(`  Retry failed, skipping batch: ${err.message}`);
          skipped += result.batch.length;
          processed += result.batch.length;
          continue;
        }
      }

      for (let i = 0; i < result.infos.length; i++) {
        const info = result.infos[i];
        if (!info) {
          skipped++;
          continue;
        }

        currentBatch.push({
          address: result.batch[i].toBase58(),
          data: info.data.toString("base64"),
        });
        saved++;

        if (currentBatch.length >= FILE_BATCH_SIZE) {
          flushBatch();
        }
      }

      processed += result.batch.length;
    }

    const pct = ((processed / cachedAccounts.length) * 100).toFixed(1);
    process.stdout.write(
      `\r  ${processed}/${cachedAccounts.length} (${pct}%) — ${saved} saved, ${skipped} null`,
    );
  }

  // Flush remaining
  flushBatch();

  console.log(
    `\n\nDone: ${saved} accounts across ${fileIndex} files, ${skipped} null (closed/missing)`,
  );

  // Write manifest
  const manifest = {
    timestamp,
    env: ENV,
    totalAccounts: saved,
    totalSkipped: skipped,
    fileCount: fileIndex,
    fileBatchSize: FILE_BATCH_SIZE,
    banksFile: "banks-raw.json",
    accountFiles: Array.from({ length: fileIndex }, (_, i) =>
      `accounts-raw-${String(i).padStart(3, "0")}.json`,
    ),
  };
  const manifestFile = path.join(DUMPS_DIR, "manifest.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`Manifest → ${manifestFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
