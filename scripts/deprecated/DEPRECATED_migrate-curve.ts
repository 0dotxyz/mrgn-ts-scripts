import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { commonSetup } from "../lib/common-setup";
import { INTEREST_CURVE_SEVEN_POINT } from "../lib/constants";

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  BANK: new PublicKey("GM98Qmzdoc7PSD64t7bG5Gqt4XEcZV9RKGcgsFCxTY4e"),
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.keys/zerotrade_admin.json",
    undefined,
  );
  const program = user.program;
  const connection = user.connection;

  let bankBefore = await program.account.bank.fetch(config.BANK);
  const migrated =
    bankBefore.config.interestRateConfig.curveType ==
    INTEREST_CURVE_SEVEN_POINT;

  let tx = new Transaction();

  if (!migrated) {
    tx.add(
      await program.methods
        .migrateCurve()
        .accounts({
          bank: config.BANK,
        })
        .instruction(),
    );
    console.log(" Migrating curve for bank: " + config.BANK);
  } else {
    console.log(" Skipped bank (already migrated): " + config.BANK);
  }

  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [
      user.wallet.payer,
    ]);
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }
}

main().catch((err) => {
  console.error(err);
});
