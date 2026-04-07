import { PublicKey } from "@solana/web3.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Environment } from "../../lib/types";
import { commonSetup } from "../../lib/common-setup";
import { configs } from "../../lib/config";
import { loadEnvFile } from "../utils/utils";

function deriveBankMetadataPda(
  programId: PublicKey,
  bank: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata", "utf-8"), bank.toBuffer()],
    programId
  );
}

function decodeUtf8Field(data: number[]): string {
  // Trim trailing null bytes and decode as UTF-8
  const end = data.indexOf(0);
  const trimmed = end === -1 ? data : data.slice(0, end);
  return Buffer.from(data).toString("utf-8");
}

async function main() {
  loadEnvFile(".env");

  const argv = yargs(hideBin(process.argv))
    .option("env", {
      type: "string",
      choices: ["production", "staging"] as Environment[],
      default: "staging",
      description: "Marginfi environment",
    })
    .option("bank", {
      type: "string",
      demandOption: true,
      description: "Bank public key",
    })
    .parseSync();

  const env = argv.env as Environment;
  const envConfig = configs[env];
  const programId = new PublicKey(envConfig.PROGRAM_ID);

  const user = commonSetup(false, envConfig.PROGRAM_ID, undefined, programId);

  const bankPubkey = new PublicKey(argv.bank);
  const [metadataPda] = deriveBankMetadataPda(programId, bankPubkey);

  console.log(`Metadata PDA: ${metadataPda.toBase58()}`);
  console.log("");

  const metadataAccount = await user.program.account.bankMetadata.fetch(
    metadataPda
  );

  const ticker = decodeUtf8Field(metadataAccount.ticker);
  const description = decodeUtf8Field(metadataAccount.description);

  console.log(`Bank:        ${(metadataAccount.bank as PublicKey).toBase58()}`);
  console.log(`Ticker:      ${ticker}`);
  console.log(`Description: ${description}`);
  
}

main().catch((err) => {
  console.error(err);
});
