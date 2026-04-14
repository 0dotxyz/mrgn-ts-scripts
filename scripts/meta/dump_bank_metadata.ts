import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { configs } from "../../lib/config";

type MainnetBankMetadata = {
  bank_address: string;
  symbol: string;
  name: string;
  venue?: string;
  venue_identifier?: string;
  asset_tag?: number;
};

function deriveBankMetadataPda(
  programId: PublicKey,
  bank: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata", "utf-8"), bank.toBuffer()],
    programId
  );
}

async function main() {
  const envConfig = configs["production"];
  const programId = new PublicKey(envConfig.PROGRAM_ID);

  // Fetch all banks from prod API
  const url = "https://app.0.xyz/api/banks/db";
  console.log(`Fetching bank list from: ${url}`);
  const response = await fetch(url);
  const banks = (await response.json()) as MainnetBankMetadata[];
  console.log(`Fetched ${banks.length} banks\n`);

  const results: {
    bankName: string;
    bankAddress: string;
    bankMetadataAddress: string;
  }[] = [];

  for (let i = 0; i < banks.length; i++) {
    const bank = banks[i];
    const bankPubkey = new PublicKey(bank.bank_address);
    const [metadataPda] = deriveBankMetadataPda(programId, bankPubkey);

    console.log(`[${i + 1}/${banks.length}] ${bank.symbol} (${bank.bank_address}) -> ${metadataPda.toBase58()}`);

    results.push({
      bankName: bank.name,
      bankAddress: bank.bank_address,
      bankMetadataAddress: metadataPda.toBase58(),
    });
  }

  const outPath = "bank_metadata_dump.json";
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nDone. Wrote ${results.length} banks to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
