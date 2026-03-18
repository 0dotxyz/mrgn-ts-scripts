import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { commonSetup } from "../lib/common-setup";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  BANK: new PublicKey("8qPLKaKb4F5BC6mVncKAryMp78yp5ZRGYnPkQbt9ikKt"),
};

async function main() {
  await closeBank(sendTx, config, "/.config/stage/id.json");
}

export async function closeBank(sendTx: boolean, config: Config, walletPath: string, version?: "current") {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    undefined,
  );
  const program = user.program;
  const connection = user.connection;

  const transaction = new Transaction().add(
    await program.methods
      .lendingPoolCloseBank()
      .accounts({
        bank: config.BANK,
      })
      .instruction()
  );

  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, [user.wallet.payer]);
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
