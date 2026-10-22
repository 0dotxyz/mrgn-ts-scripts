import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bigNumberToWrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, send the tx. If false, output the b58 tx to console.
 */
const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  ADMIN: PublicKey;

  /** Multisig if using a MS, otherwise any value */
  MULTISIG: PublicKey;

  /** Fields set to null are left unchanged. */
  NEW_ADMIN: PublicKey | null;
  NEW_WALLET: PublicKey | null;
  NEW_POOL_FLAT_SOL_FEE: number | null;
  LIQUIDATION_FLAT_SOL_FEE: number | null;
  ORDER_INIT_FLAT_SOL_FEE: number | null;
  FIXED_FEE: number | null;
  RATE_FEE: number | null;
  LIQUIDATION_MAX_PREMIUM: number | null;
  ORDER_EXECUTION_MAX_FEE: number | null;
  PAUSE_DELEGATE_ADMIN: PublicKey | null;
  ACCOUNT_TRANSFER_FEE: number | null;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  NEW_ADMIN: null,
  NEW_WALLET: null,
  NEW_POOL_FLAT_SOL_FEE: null,
  LIQUIDATION_FLAT_SOL_FEE: null,
  ORDER_INIT_FLAT_SOL_FEE: null,
  FIXED_FEE: null,
  RATE_FEE: null,
  LIQUIDATION_MAX_PREMIUM: null,
  ORDER_EXECUTION_MAX_FEE: 0.04,
  PAUSE_DELEGATE_ADMIN: null,
  ACCOUNT_TRANSFER_FEE: null,
};

const wrapOptional = (value: number | null) =>
  value === null ? null : bigNumberToWrappedI80F48(value);

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
        config.ORDER_INIT_FLAT_SOL_FEE,
        wrapOptional(config.FIXED_FEE),
        wrapOptional(config.RATE_FEE),
        wrapOptional(config.LIQUIDATION_MAX_PREMIUM),
        wrapOptional(config.ORDER_EXECUTION_MAX_FEE),
        config.PAUSE_DELEGATE_ADMIN,
        config.ACCOUNT_TRANSFER_FEE,
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
