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
  // GUAC
  {
    bank: new PublicKey("44digRwKFeyiqDaxJRE6iag4cbXECKjG54v5ozxdu5mu"),
    price: 0.0001,
  },
  // TBTC
  {
    bank: new PublicKey("AyeEyCiBU2CzZmxz3f3o3vk2hvMsM5G3t3D6vhLsiFkf"),
    price: 63000,
  },
  // USDY
  {
    bank: new PublicKey("5WL5CnjWT71NPgj8iQR2FU5H3FsVci9cnsHSNJzxj788"),
    price: 1.1,
  },
  // LFG
  {
    bank: new PublicKey("9ojzV5xFHtx2h2GhKRSgCwJK3BLswczdiiLW3hsyRE5c"),
    price: 0.0001,
  },
  // KIN
  {
    bank: new PublicKey("GZK3yC3Kfn1ykFhLryzeKqemRNZ3wpZgWhbh5b5ygGML"),
    price: 0.0001,
  },
  // boden
  {
    bank: new PublicKey("5xVGr3pAWDtWPLcf6YsQTjKm6pGqLnJrENQXGajdP2wZ"),
    price: 0.0001,
  },
  // SNS
  {
    bank: new PublicKey("Emb5g6cEbRU2Yq9ZQnKhRDQLNRLSMWdgYRvJrBHzH6yB"),
    price: 0.0001,
  },
  // SHDW
  {
    bank: new PublicKey("2Ux4yKTTxQf14MzxRPUyybw9akqHC5jnViF1iKWZRxMb"),
    price: 0.0001,
  },
  // RLB
  {
    bank: new PublicKey("BsrjGaXJNmzXBK855wXev2Jb846AbyRCoA6R8TnpfrNM"),
    price: 0.0001,
  },
  // DITH
  {
    bank: new PublicKey("9cizJpitym7CGL2QauvgG4BtTvSeADvppUpwGTPRc6De"),
    price: 0.0001,
  },
  // Neiro
  {
    bank: new PublicKey("GpNuWCghujQQNyyX1qv2p2r7WpX2hD6UyPnN8rRDGLs"),
    price: 0.0001,
  },
  // OPOS
  {
    bank: new PublicKey("4TBA2upbfULV5ryM8LxSqreztonu5xLYxN6qBEzHXR5f"),
    price: 0.0001,
  },
  // ISC
  {
    bank: new PublicKey("BDo6z3urnxkMBPWP1PTcPDMNnvgTtEqtKtf219exvA87"),
    price: 0.0001,
  },
  // META
  {
    bank: new PublicKey("H6bfRmfZPoxDDs8eoVBgouTPowwyv7opfBbHd5KUmuUz"),
    price: 0.0001,
  },
  // ORE
  {
    bank: new PublicKey("CQVtZK8rpL4M6JQzXxkPhadkVDFChfmdyw9MAXM3oFZT"),
    price: 0.0001,
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
