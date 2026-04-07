import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;
/**
 * If true, pause. If false, unpause.
 */
const pause = true;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;

  MULTISIG?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),

  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/.keys/staging-deploy.json",
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const tx = new Transaction();
  if (pause) {
    tx.add(await program.methods.panicPause().accounts({}).instruction());
  } else {
    tx.add(await program.methods.panicUnpause().accounts({}).instruction());
  }
  tx.add(
    await program.methods
      .propagateFeeState()
      .accounts({
        marginfiGroup: config.GROUP,
      })
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [
        user.wallet.payer,
      ]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    tx.feePayer = config.MULTISIG;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const serializedTransaction = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

main().catch((err) => {
  console.error(err);
});
