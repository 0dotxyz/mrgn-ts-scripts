import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bigNumberToWrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../lib/common-setup";

/**
 * If true, send the tx. If false, output the b58 tx to console.
 */
const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  ADMIN: PublicKey;

  /** Multisig if using a MS, otherwise any value */
  MULTISIG: PublicKey;

  NEW_WALLET: PublicKey;
  NEW_ADMIN: PublicKey;
  NEW_POOL_FLAT_SOL_FEE: number;
  LIQUIDATION_FLAT_SOL_FEE: number;
  FIXED_FEE: number;
  RATE_FEE: number;
  LIQUIDATION_MAX_PREMIUM: number;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  NEW_WALLET: new PublicKey("CYcWgRxSCLXJKB6c8xGBddgZdFxPoksBL5DrJVqAtsQj"),
  NEW_ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  NEW_POOL_FLAT_SOL_FEE: 0,
  LIQUIDATION_FLAT_SOL_FEE: 0.002 * 10 ** 9,
  FIXED_FEE: 0,
  RATE_FEE: 0.075,
  LIQUIDATION_MAX_PREMIUM: 0.1,
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/keys/phantom-wallet.json",
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const transaction = new Transaction().add(
    await program.methods
      .editGlobalFeeState(
        config.NEW_ADMIN,
        config.NEW_WALLET,
        config.NEW_POOL_FLAT_SOL_FEE,
        config.LIQUIDATION_FLAT_SOL_FEE,
        bigNumberToWrappedI80F48(config.FIXED_FEE),
        bigNumberToWrappedI80F48(config.RATE_FEE),
        bigNumberToWrappedI80F48(config.LIQUIDATION_MAX_PREMIUM),
      )
      .accounts({})
      .accountsPartial({
        globalFeeAdmin: config.ADMIN,
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
    transaction.feePayer = config.MULTISIG; // Set the fee payer to Squads wallet
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

/*
 * Status 1/30/2026
 admin:        CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw
 wallet:       CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw
 flat (banks): 0
 flat (liq)):  1000000
 fixed:        0
 rate          0.074999999999999289457
 liq max       0.10000000000000142109
 */

/*
 * Status 2/28/2025
Admin: AZtUUe9GvTFq9kfseu9jxTioSgdSfjgmZfGQBmhVpTj1 wallet JAnRanMrsn5vxWmSpU5ndvtvQLAyzGJEenNzgVC1vNMC
flat sol: 150000000 fixed: 0 rate 0.0075000000000002842171
 */
