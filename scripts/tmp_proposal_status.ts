import { Connection, PublicKey } from "@solana/web3.js";
import { loadEnvFile } from "./utils/utils";

const SQUADS_PROGRAM = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
const MS_CONFIG = new PublicKey("74QKjjvoSrq2cGqFzzQNN8ox3gomYS1mBwcLsbiYaH8j");
const STATUS = ["Draft", "Active", "Rejected", "Approved", "Executing", "Executed", "Cancelled"];

async function main() {
  loadEnvFile(".env.api");
  const connection = new Connection(process.env.API_URL!, "confirmed");

  for (const index of [386n, 387n, 388n, 389n]) {
    const idxBuf = Buffer.alloc(8);
    idxBuf.writeBigUInt64LE(index);
    const [proposalPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("multisig"),
        MS_CONFIG.toBuffer(),
        Buffer.from("transaction"),
        idxBuf,
        Buffer.from("proposal"),
      ],
      SQUADS_PROGRAM,
    );
    const info = await connection.getAccountInfo(proposalPda);
    if (!info) {
      console.log(`tx #${index}: proposal account NOT FOUND (${proposalPda.toBase58()})`);
      continue;
    }
    // Proposal: 8 disc + 32 multisig + 8 transaction_index + status enum (u8 variant)
    const variant = info.data.readUInt8(8 + 32 + 8);
    console.log(`tx #${index}: ${STATUS[variant] ?? `unknown(${variant})`}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
