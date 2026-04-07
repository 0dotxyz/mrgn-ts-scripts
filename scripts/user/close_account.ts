import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { commonSetup } from "../../lib/common-setup";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  ACCOUNT: new PublicKey("829Rvt2ewWRhCj1N1PQWwXtTCPNRgGLTx76yhtyiPiaC"),
};

async function main() {
  await closeAccount(sendTx, config, "/.config/stage/id.json");
}

export async function closeAccount(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
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
      .marginfiAccountClose()
      .accounts({
        marginfiAccount: config.ACCOUNT,
      })
      .instruction()
  );

  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      user.wallet.payer,
    ]);
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
