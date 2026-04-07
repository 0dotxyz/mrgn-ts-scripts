import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { bigNumberToWrappedI80F48 } from "@mrgnlabs/mrgn-common";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

/** Shared settings across all entries */
type SharedConfig = {
  PROGRAM_ID: string;
  ADMIN: PublicKey;
  MULTISIG?: PublicKey; // May be omitted if not using squads
};

const configCommon: SharedConfig = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

type BankOracleConfig = {
  bank: PublicKey;
  price: number;
};

/** One entry per bank to update */
const configs: BankOracleConfig[] = [
  {
    bank: new PublicKey("EKwXy2ui2jtJnvH4A2XufyqMyeSFecJE8xAKWpZEtDwd"),
    price: 1,
  },
  // ...More entries here as needed. The limit even without using LUTs is fairly high (at least 6)
];

async function main() {
  const user = commonSetup(
    sendTx,
    configCommon.PROGRAM_ID,
    "./keys/zerotrade_admin.json",
    configCommon.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  // Build a single transaction with one instruction per configs[] entry
  const transaction = new Transaction();

  for (const cfg of configs) {
    const ix = await program.methods
      .lendingPoolSetFixedOraclePrice(bigNumberToWrappedI80F48(cfg.price))
      .accounts({
        bank: cfg.bank,
      })
      .remainingAccounts([])
      .instruction();

    transaction.add(ix);
  }

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
    if (configCommon.MULTISIG) {
      transaction.feePayer = configCommon.MULTISIG;
    }
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

main().catch((err) => {
  console.error(err);
});
