import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  ADMIN_KEY: PublicKey;

  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  ADMIN_KEY: new PublicKey("6DdJqQYD8AizuXiCkbn19LiyWRwUsRMzy2Sgyoyasyj7"),
};

const deriveGlobalFeeState = (programId: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("feestate", "utf-8")],
    programId,
  );
};

async function main() {
  await initGroup(sendTx, config, "/.config/stage/id.json");
}

export async function initGroup(
  sendTx: boolean,
  config: Config,
  walletPath: string,
): Promise<PublicKey> {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;

  const marginfiGroup = Keypair.generate();

  const transaction = new Transaction();
  transaction.add(
    await program.methods
      .marginfiGroupInitialize()
      .accountsPartial({
        marginfiGroup: marginfiGroup.publicKey,
        feeState: deriveGlobalFeeState(new PublicKey(config.PROGRAM_ID))[0],
        admin: config.ADMIN_KEY,
        // systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer, marginfiGroup],
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    transaction.feePayer = config.ADMIN_KEY; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.partialSign(marginfiGroup);
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }

  console.log("Group init: " + marginfiGroup.publicKey);
  return marginfiGroup.publicKey;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
