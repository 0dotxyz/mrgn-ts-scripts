/**
 * Dump all banks (including Drift) via discriminator filter.
 *
 * Output: dumps/banks-raw.json
 *
 * Usage: tsx scripts/drift/sunset/dump-banks.ts
 */

import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { BorshAccountsCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { getMarginfiProgram, getConfig } from "../../../lib/config";
import { Environment } from "../../../lib/types";

dotenv.config();

const ENV = "production";
const DUMPS_DIR = path.join(__dirname, "dumps");
const OUTPUT_FILE = path.join(DUMPS_DIR, "banks-raw.json");

async function main() {
  const program = getMarginfiProgram(ENV);
  const connection = program.provider.connection;
  const config = getConfig(ENV as Environment);

  console.log("=== Dump Banks ===\n");
  console.log(`Group: ${config.GROUP_ADDRESS}`);

  if (!fs.existsSync(DUMPS_DIR)) {
    fs.mkdirSync(DUMPS_DIR);
  }

  const discriminator = bs58.encode(
    new BorshAccountsCoder(program.idl).accountDiscriminator("bank"),
  );

  // Bank layout: 8 (discriminator) + 32 (mint) + 1 (mint_decimals) + 32 (group)
  // Group is at offset 41
  const GROUP_OFFSET = 8 + 32 + 1;

  console.log("Fetching production group banks via getProgramAccounts...");
  const bankAccounts = await connection.getProgramAccounts(program.programId, {
    commitment: connection.commitment,
    filters: [
      { memcmp: { offset: 0, bytes: discriminator } },
      { memcmp: { offset: GROUP_OFFSET, bytes: config.GROUP_ADDRESS } },
    ],
  });

  console.log(`  ${bankAccounts.length} banks found`);

  const banks = bankAccounts.map((a) => ({
    address: a.pubkey.toBase58(),
    data: a.account.data.toString("base64"),
    owner: a.account.owner.toBase58(),
  }));

  const output = {
    timestamp: new Date().toISOString(),
    env: ENV,
    bankCount: banks.length,
    banks,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  const sizeMb = fs.statSync(OUTPUT_FILE).size / 1024 / 1024;
  console.log(`\nWritten ${OUTPUT_FILE} (${sizeMb.toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
