import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { commonSetup } from "../lib/common-setup";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANK: new PublicKey("2D1dc9jo8CNjgVG4qTKpRuGA83zrXv9iuSHV9BWZ7Js9"),
};

async function main() {
  await forceRepaymentsComplete(sendTx, config, "/.config/drift.json");
}

export async function forceRepaymentsComplete(sendTx: boolean, config: Config, walletPath: string) {
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
      .lendingPoolForceTokenlessRepayComplete()
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
