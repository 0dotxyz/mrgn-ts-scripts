import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

import { commonSetup } from "../../lib/common-setup";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  MULTISIG: PublicKey;
  BANK: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  BANK: new PublicKey("3RVamPQE3nDViuUU7wdZJgnru7Q93cRzdysXA8kjxMiq"), // zBTC
};

const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    DEFAULT_WALLET_PATH,
    config.MULTISIG,
  );
  const { program, connection } = user;
  const adminKey = sendTx ? user.wallet.publicKey : config.MULTISIG;
  const payerKey = adminKey;

  const ZERO = new BN(0);
  const ix: TransactionInstruction = await program.methods
    .configureBankRateLimits(ZERO, ZERO)
    .accounts({ bank: config.BANK })
    .accountsPartial({ group: config.GROUP, admin: adminKey })
    .instruction();

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const v0Tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message(),
  );

  console.log(`Removing rate limit (hourly=0, daily=0) on bank ${config.BANK.toBase58()}`);

  if (sendTx) {
    v0Tx.sign([user.wallet.payer]);
    const sig = await connection.sendTransaction(v0Tx, { maxRetries: 2 });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log("Signature:", sig);
  } else {
    const sim = await connection.simulateTransaction(v0Tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    if (sim.value.err) {
      console.error(`[sim] FAILED: ${JSON.stringify(sim.value.err)}`);
      for (const l of sim.value.logs ?? []) console.error(`    ${l}`);
    } else {
      console.log(`[sim] OK (CU: ${sim.value.unitsConsumed ?? "?"})`);
    }
    console.log(`\n---- BEGIN MULTISIG TX (base58) ----`);
    console.log(bs58.encode(v0Tx.serialize()));
    console.log(`---- END MULTISIG TX ----\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
