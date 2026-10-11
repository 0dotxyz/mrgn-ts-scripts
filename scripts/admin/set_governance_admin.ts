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
 * 0.1.12 splits group administration: adding banks, oracles, weights, e-mode and unfreezing need
 * the governance admin, which every group starts without. While it is unset the admin may set it
 * once; afterwards only the governance admin can rotate it.
 */
type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  NEW_GOVERNANCE_ADMIN: PublicKey;
  /** The group admin while the governance admin is unset, the governance admin afterwards. */
  SIGNER: PublicKey;
  MULTISIG?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  GROUP: new PublicKey("FCPfpHA69EbS8f9KKSreTRkXbzFpunsKuYf5qNmnJjpo"),
  NEW_GOVERNANCE_ADMIN: new PublicKey("mfC1LoEk4mpM5yx1LjwR9QLZQ49AitxxWkK5Aciw7ZC"),
  SIGNER: new PublicKey("mfC1LoEk4mpM5yx1LjwR9QLZQ49AitxxWkK5Aciw7ZC"),
};

async function main() {
  await setGovernanceAdmin(sendTx, config, "/keys/staging-deploy.json");
}

export async function setGovernanceAdmin(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const transaction = new Transaction().add(
    await program.methods
      .marginfiGroupSetGovernanceAdmin(config.NEW_GOVERNANCE_ADMIN)
      .accounts({
        marginfiGroup: config.GROUP,
        signer: config.SIGNER,
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
  } else {
    transaction.feePayer = config.MULTISIG ?? config.SIGNER;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    console.log("Base58-encoded transaction:", bs58.encode(serializedTransaction));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
