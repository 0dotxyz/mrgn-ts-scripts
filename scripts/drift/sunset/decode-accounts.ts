/**
 * Decode raw account data from dumps/accounts-raw-*.json batch files.
 *
 * Reads manifest.json to find all batch files, decodes each one,
 * and writes corresponding decoded-accounts-*.json files.
 *
 * Usage: tsx scripts/drift/sunset/decode-accounts.ts
 */

import * as fs from "fs";
import * as path from "path";
import { BorshAccountsCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh";
import marginfiIdl from "../../../idl/marginfi.json";
import { serializeValue } from "./lib/serialize";

const DUMPS_DIR = path.join(__dirname, "dumps");
const MANIFEST_FILE = path.join(DUMPS_DIR, "manifest.json");

async function main() {
  console.log("=== Decode Accounts ===\n");

  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error(`${MANIFEST_FILE} not found. Run dump-accounts.ts first.`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
  const accountFiles: string[] = manifest.accountFiles;

  console.log(`${accountFiles.length} batch files, ${manifest.totalAccounts} total accounts\n`);

  const coder = new BorshAccountsCoder(marginfiIdl as any);

  let totalDecoded = 0;
  let totalFailed = 0;

  for (const fileName of accountFiles) {
    const inputPath = path.join(DUMPS_DIR, fileName);
    const outputName = fileName.replace("accounts-raw-", "decoded-accounts-");
    const outputPath = path.join(DUMPS_DIR, outputName);

    if (!fs.existsSync(inputPath)) {
      console.warn(`  Missing ${fileName}, skipping`);
      continue;
    }

    const raw: any[] = JSON.parse(fs.readFileSync(inputPath, "utf-8"));

    const decoded: any[] = [];
    let failed = 0;

    for (const entry of raw) {
      try {
        const buf = Buffer.from(entry.data, "base64");
        const account = coder.decode("MarginfiAccount", buf);

        decoded.push({
          address: entry.address,
          ...serializeValue(account),
        });
      } catch {
        failed++;
      }
    }

    fs.writeFileSync(outputPath, JSON.stringify(decoded));

    const sizeMb = fs.statSync(outputPath).size / 1024 / 1024;
    console.log(
      `  ${outputName}: ${decoded.length} decoded, ${failed} failed (${sizeMb.toFixed(1)} MB)`,
    );

    totalDecoded += decoded.length;
    totalFailed += failed;
  }

  console.log(`\nTotal: ${totalDecoded} decoded, ${totalFailed} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
