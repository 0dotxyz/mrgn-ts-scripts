import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { commonSetup } from "../../lib/common-setup";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  AUTHORITY: PublicKey;

  MULTISIG?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  GROUP: new PublicKey("Diu1q9gniR1qR4Daaej3rcHd6949HMmxLGsnQ94Z3rLz"),
  AUTHORITY: new PublicKey("FDr3iLdfyyzMmge9rN5sqQ38PgbrXY94VDW726EUN2kK"),

  // Not required if sending without multisig.
  //MULTISIG: new PublicKey("ToM1VY97cMeAiyN3MUFKKLuPdG8CaNiqhoDDGJ3a9cg"),
};

async function main() {
  await initAccount(sendTx, config, "/.config/solana/id.json");
}

export async function initAccount(
  sendTx: boolean,
  config: Config,
  walletPath: string,
): Promise<PublicKey> {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const accountKeypair = Keypair.generate();
  console.log(accountKeypair.publicKey.toString());
  const transaction = new Transaction();
  transaction.add(
    await program.methods
      .marginfiAccountInitialize()
      .accounts({
        marginfiGroup: config.GROUP,
        marginfiAccount: accountKeypair.publicKey,
        authority: config.AUTHORITY,
        feePayer: user.wallet.publicKey,
      })
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer, accountKeypair],
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    transaction.feePayer = config.MULTISIG; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.partialSign(accountKeypair);
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }

  console.log("Account init: " + accountKeypair.publicKey);
  return accountKeypair.publicKey;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
