import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { commonSetup } from "../../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  BANK_KEY: PublicKey;
};
const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  BANK_KEY: new PublicKey("Fe5QkKPVAh629UPP5aJ8sDZu8HTfe6M26jDQkKyXVhoA"),
};

async function main() {
  const user = commonSetup(true, config.PROGRAM_ID, "/.config/solana/id.json");
  const program = user.program;

  const transaction = new Transaction().add(
    await program.methods
      .lendingPoolAccrueBankInterest()
      .accounts({
        bank: config.BANK_KEY,
      })
      .instruction()
  );

  try {
    const signature = await sendAndConfirmTransaction(
      user.connection,
      transaction,
      [user.wallet.payer]
    );
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }
}

main().catch((err) => {
  console.error(err);
});
