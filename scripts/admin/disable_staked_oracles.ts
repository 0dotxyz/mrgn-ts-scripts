import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { deriveStakedSettings } from "../common/pdas";

/**
 * (admin only) Disable stake pricing for the group, forbidding all operations involving stake
 * banks. Used during the SVSP upgrade rollout. Clears STAKED_ORACLE_PRICE_USES_ONRAMP and sets
 * STAKED_ORACLE_DISABLED on the group's staked settings.
 */

/** If true, send the tx. If false, output the unsigned b58 tx to console. */
const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  WALLET_PATH: string;
  /** Required when sendTx = false. Used as the admin + fee payer for the multisig flow. */
  MULTISIG?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  WALLET_PATH: "/.config/solana/id.json",
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  if (!sendTx && !config.MULTISIG) {
    throw new Error("MULTISIG must be set when sendTx = false");
  }

  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    config.WALLET_PATH,
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const [stakedSettings] = deriveStakedSettings(
    program.programId,
    config.GROUP,
  );
  console.log("group:          ", config.GROUP.toBase58());
  console.log("admin:          ", user.wallet.publicKey.toBase58());
  console.log("staked settings:", stakedSettings.toBase58());

  const ix = await program.methods
    .disableStakedOracles()
    .accountsPartial({
      group: config.GROUP,
      admin: user.wallet.publicKey,
      stakedSettings,
    })
    .instruction();

  const tx = new Transaction().add(ix);

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
    console.log(
      "Base58-encoded transaction:",
      bs58.encode(serializedTransaction),
    );
  }
}

main().catch((err) => {
  console.error(err);
});
