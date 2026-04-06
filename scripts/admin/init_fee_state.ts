import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { WrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { I80F48_ZERO } from "../utils/utils";
import { commonSetup } from "../../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  ADMIN_PUBKEY: PublicKey;
  INIT_FLAT_SOL_FEE: number;
  LIQUIDATION_FLAT_SOL_FEE: number;
  PROGRAM_FEE_FIXED: WrappedI80F48;
  PROGRAM_FEE_RATE: WrappedI80F48;
  LIQUIDATION_MAX_FEE: WrappedI80F48;

  /// Required if using multisig only
  MULTISIG_PAYER: PublicKey;
};
const config: Config = {
  PROGRAM_ID: "5UDghkpgW1HfYSrmEj2iAApHShqU44H6PKTAar9LL9bY",
  ADMIN_PUBKEY: new PublicKey("725Z4QQUVhRiXcCdf4cQTrxXYmQXyW9zgVkW5PDVSJz4"),
  INIT_FLAT_SOL_FEE: 1000,
  LIQUIDATION_FLAT_SOL_FEE: 1000,
  PROGRAM_FEE_FIXED: I80F48_ZERO,
  PROGRAM_FEE_RATE: I80F48_ZERO,
  LIQUIDATION_MAX_FEE: I80F48_ZERO,

  MULTISIG_PAYER: new PublicKey("3HGdGLrnK9DsnHi1mCrUMLGfQHcu6xUrXhMY14GYjqvM"),
};

type InitGlobalFeeStateArgs = {
  payer: PublicKey;
  admin: PublicKey;
  wallet: PublicKey;
  bankInitFlatSolFee: number;
  programFeeFixed: WrappedI80F48;
  programFeeRate: WrappedI80F48;
};

async function main() {
  await initGlobalFeeState();
}

async function initGlobalFeeState() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/keys/zerotrade_admin.json",
    config.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;

  const transaction = new Transaction().add(
    await program.methods
      .initGlobalFeeState(
        config.ADMIN_PUBKEY,
        config.ADMIN_PUBKEY,
        config.INIT_FLAT_SOL_FEE,
        config.LIQUIDATION_FLAT_SOL_FEE,
        config.PROGRAM_FEE_FIXED,
        config.PROGRAM_FEE_RATE,
        config.LIQUIDATION_MAX_FEE,
      )
      .accounts({
        payer: user.wallet.publicKey,
        // feeState = deriveGlobalFeeState(id),
        // rent = SYSVAR_RENT_PUBKEY,
        // systemProgram: SystemProgram.programId,
      })
      .instruction(),
  );

  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      user.wallet.payer,
    ]);
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }
}

main().catch((err) => {
  console.error(err);
});
