import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../lib/common-setup";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

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
    "/keys/zerotrade_admin.json",
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  let groupBefore = await program.account.marginfiGroup.fetch(config.GROUP);
  console.log("Current limit:", groupBefore.deleverageWithdrawWindowCache.dailyLimit.toString());

  const transaction = new Transaction();
  transaction.add(
    await program.methods
      .configureDeleverageWithdrawalLimit(
        100000 // in USD
      )
      .accounts({
        marginfiGroup: config.GROUP,
      })
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer],
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }

    let groupAfter = await program.account.marginfiGroup.fetch(config.GROUP);
    console.log("Group " + config.GROUP);
    console.log("new limit: " + groupAfter.deleverageWithdrawWindowCache.dailyLimit);
  } else {
    transaction.feePayer = config.MULTISIG;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
