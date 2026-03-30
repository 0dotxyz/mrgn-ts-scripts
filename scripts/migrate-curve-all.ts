import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fetch from "node-fetch";
import { commonSetup } from "../lib/common-setup";
import { INTEREST_CURVE_SEVEN_POINT } from "../lib/constants";

type Config = {
  PROGRAM_ID: string;
  DEPLOY_KEYPAIR_PATH: string;
};

type BankEntry = {
  bank_address: string;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  DEPLOY_KEYPAIR_PATH: "/keys/zerotrade_admin.json",
};

const BANKS_URL = "https://app.0.xyz/api/banks/db";
const CHUNK_SIZE = 10;

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    config.DEPLOY_KEYPAIR_PATH,
    undefined,
  );
  const { program, connection, wallet } = user;

  console.log(`Fetching banks from ${BANKS_URL}...`);
  const response = await fetch(BANKS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch banks: ${response.statusText}`);
  }
  const banks: BankEntry[] = await response.json();
  console.log(`Fetched ${banks.length} banks from API.`);

  const bankPubkeys = banks.map((b) => new PublicKey(b.bank_address));
  console.log(
    `Processing ${bankPubkeys.length} banks in chunks of ${CHUNK_SIZE}...`,
  );

  for (let i = 0; i < bankPubkeys.length; i += CHUNK_SIZE) {
    const chunk = bankPubkeys.slice(i, i + CHUNK_SIZE);
    const tx = new Transaction();
    let instructionsAdded = 0;

    for (const bank of chunk) {
      console.log(`Checking bank: ${bank.toBase58()}`);
      const bankBefore = await program.account.bank.fetch(bank);
      const migrated =
        bankBefore.config.interestRateConfig.curveType ===
        INTEREST_CURVE_SEVEN_POINT;

      if (migrated) {
        console.log("  • Already migrated; skipping");
        continue;
      }

      const ix = await program.methods
        .migrateCurve()
        .accounts({
          bank,
        })
        .instruction();
      tx.add(ix);
      instructionsAdded++;
      console.log("  • Added migrateCurve instruction");
    }

    if (!instructionsAdded) {
      console.log(
        `No migrations needed for chunk starting at index ${i}; skipping transaction.`,
      );
      continue;
    }

    console.log(
      `Sending transaction for chunk starting at index ${i} (${instructionsAdded} bank(s))...`,
    );
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [
        wallet.payer,
      ]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }

    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal error migrating curves:", err);
  process.exit(1);
});
