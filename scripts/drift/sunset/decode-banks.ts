/**
 * Decode raw bank data from dumps/banks-raw.json.
 *
 * Usage: tsx scripts/drift/sunset/decode-banks.ts
 */

import * as fs from "fs";
import * as path from "path";
import { BorshAccountsCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh";
import marginfiIdl from "../../../idl/marginfi.json";
import { serializeValue } from "./lib/serialize";

const INPUT_FILE = path.join(__dirname, "dumps", "banks-raw.json");
const OUTPUT_FILE = path.join(__dirname, "dumps", "decoded-banks.json");

async function main() {
  console.log("=== Decode Banks ===\n");

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`${INPUT_FILE} not found. Run dump-accounts.ts first.`);
    process.exit(1);
  }

  const dump = JSON.parse(fs.readFileSync(INPUT_FILE, "utf-8"));
  console.log(`Loaded ${dump.banks.length} raw banks`);

  const coder = new BorshAccountsCoder(marginfiIdl as any);
  const decoded: any[] = [];
  let failed = 0;

  for (const raw of dump.banks) {
    try {
      const buffer = Buffer.from(raw.data, "base64");
      const bank = coder.decode("Bank", buffer);

      decoded.push({
        address: raw.address,
        symbol: raw.symbol,
        ...serializeValue(bank),
      });
    } catch (err: any) {
      console.warn(
        `  Failed to decode ${raw.symbol} (${raw.address}): ${err.message}`,
      );
      failed++;
    }
  }

  console.log(`Decoded: ${decoded.length}, Failed: ${failed}`);

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify({ bankCount: decoded.length, banks: decoded }, null, 2),
  );

  const sizeMb = fs.statSync(OUTPUT_FILE).size / 1024 / 1024;
  console.log(`Written ${OUTPUT_FILE} (${sizeMb.toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
