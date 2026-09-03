import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * Configure a bank to use one of the internal LST/mSOL "multiplier" oracle setups. The bank is
 * priced as `base_feed * exchange_rate`, where the rate is read from a second on-chain account:
 *
 *  - PythMSOL: base Pyth SOL/USD feed + the Marinade `State` account (mSOL/SOL rate).
 *  - PythLST:  base Pyth SOL/USD feed + an SPL / Sanctum stake-pool account (LST/SOL rate).
 *
 * `oracle` becomes `oracle_keys[0]` (base feed); `multiplier` becomes `oracle_keys[1]`. Both are
 * passed as remaining accounts, in that order, for validation.
 *
 * If true, send the tx. If false, output the unsigned b58 tx to console (for a squads proposal).
 */
const sendTx = false;

/** Instruction `setup` byte (see `OracleSetup::from_u8`). */
const ORACLE_SETUP_PYTH_MSOL = 19;
const ORACLE_SETUP_PYTH_LST = 22;

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
  /** Base price feed -> `oracle_keys[0]`. Pyth SOL/USD for both setups. */
  oracle: PublicKey;
  /** Rate source -> `oracle_keys[1]`. Marinade State (PythMSOL) or SPL stake pool (PythLST). */
  multiplier: PublicKey;
  /** ORACLE_SETUP_PYTH_MSOL or ORACLE_SETUP_PYTH_LST */
  setup: number;
};

/** One entry per bank to update */
const configs: BankOracleConfig[] = [
  // Example (PythLST): bSOL bank priced off Pyth SOL/USD * bSOL stake-pool rate.
  // {
  //   bank: new PublicKey("..."),
  //   oracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  //   multiplier: new PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi"),
  //   setup: ORACLE_SETUP_PYTH_LST,
  // },
  // Example (PythMSOL): mSOL bank priced off Pyth SOL/USD * Marinade rate.
  // {
  //   bank: new PublicKey("..."),
  //   oracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  //   multiplier: new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC"),
  //   setup: ORACLE_SETUP_PYTH_MSOL,
  // },
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
    // Remaining accounts: [base feed, rate source], in that order.
    const remaining: AccountMeta[] = [cfg.oracle, cfg.multiplier].map(
      (pubkey) => ({ pubkey, isSigner: false, isWritable: false }),
    );

    const ix = await program.methods
      .lendingPoolConfigureBankOracle(cfg.setup, cfg.oracle)
      .accountsPartial({
        admin: configCommon.ADMIN,
        bank: cfg.bank,
      })
      .remainingAccounts(remaining)
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
