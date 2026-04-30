import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  HOURLY_LIMIT_USD: BN;
  DAILY_LIMIT_USD: BN;
  ADMIN_WALLET_PATH: string;
  MULTISIG?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  HOURLY_LIMIT_USD: new BN(0),
  DAILY_LIMIT_USD: new BN(0),

  ADMIN_WALLET_PATH: "/.keys/staging-deploy.json",
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    config.ADMIN_WALLET_PATH,
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const groupBefore = await program.account.marginfiGroup.fetch(config.GROUP);
  console.log(
    "Current group limits:",
    `hourly=${groupBefore.rateLimiter.hourly.maxOutflow.toString()}`,
    `daily=${groupBefore.rateLimiter.daily.maxOutflow.toString()}`,
  );
  console.log(
    "New group limits:",
    `hourly=${config.HOURLY_LIMIT_USD.toString()}`,
    `daily=${config.DAILY_LIMIT_USD.toString()}`,
  );

  const tx = new Transaction();
  tx.add(
    await program.methods
      .configureGroupRateLimits(config.HOURLY_LIMIT_USD, config.DAILY_LIMIT_USD)
      .accountsPartial({
        marginfiGroup: config.GROUP,
        admin: user.wallet.publicKey,
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
      return;
    }

    const groupAfter = await program.account.marginfiGroup.fetch(config.GROUP);
    console.log(
      "Updated group limits:",
      `hourly=${groupAfter.rateLimiter.hourly.maxOutflow.toString()}`,
      `daily=${groupAfter.rateLimiter.daily.maxOutflow.toString()}`,
    );
  } else {
    tx.feePayer = config.MULTISIG ?? user.wallet.publicKey;
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
