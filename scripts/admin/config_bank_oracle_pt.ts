import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { bigNumberToWrappedI80F48 } from "@mrgnlabs/mrgn-common";

/**
 * Configure a bank to use one of the Exponent PT (principal token) oracle setups. The PT price
 * accretes linearly from `price` (the start price, must be in (0, 1]) toward par at the vault's
 * maturity, capped by the vault's redemption backing:
 *
 *  - PTPyth:  base Pyth feed + Exponent vault -> price = base_feed * pt_rate. Remaining: [oracle, vault].
 *  - PTFixed: Exponent vault only (underlying ~= $1) -> price = pt_rate in USD. Remaining: [vault].
 *
 * If true, send the tx. If false, output the unsigned b58 tx to console (for a squads proposal).
 */
const sendTx = false;

/** Instruction `setup` byte (see `OracleSetup::from_u8`). */
const ORACLE_SETUP_PT_PYTH = 25;
const ORACLE_SETUP_PT_FIXED = 26;

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
  /** ORACLE_SETUP_PT_PYTH or ORACLE_SETUP_PT_FIXED */
  setup: number;
  /** PT start price, must be in (0, 1]. */
  price: number;
  /** Exponent vault account. */
  vault: PublicKey;
  /** Base price feed. Required for PTPyth, omitted for PTFixed. */
  oracle?: PublicKey;
};

/** One entry per bank to update */
const configs: BankOracleConfig[] = [
  // Example (PTPyth): PT-SOL bank priced off Pyth SOL/USD * PT rate.
  // {
  //   bank: new PublicKey("..."),
  //   setup: ORACLE_SETUP_PT_PYTH,
  //   price: 0.9,
  //   oracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  //   vault: new PublicKey("9YbaicMsXrtupkpD72pdWBfU6R7EJfSByw75sEpDM1uH"),
  // },
  // Example (PTFixed): PT-hyUSD bank (underlying ~= $1).
  // {
  //   bank: new PublicKey("..."),
  //   setup: ORACLE_SETUP_PT_FIXED,
  //   price: 0.95,
  //   vault: new PublicKey("..."),
  // },
];

function remainingFor(cfg: BankOracleConfig): AccountMeta[] {
  const keys: PublicKey[] = [];
  if (cfg.setup === ORACLE_SETUP_PT_PYTH) {
    if (!cfg.oracle) throw new Error("PTPyth requires `oracle` (base feed)");
    keys.push(cfg.oracle);
  }
  keys.push(cfg.vault);
  return keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}

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
      .lendingPoolSetOraclePrice(bigNumberToWrappedI80F48(cfg.price), cfg.setup)
      .accountsPartial({
        admin: configCommon.ADMIN,
        bank: cfg.bank,
      })
      .remainingAccounts(remainingFor(cfg))
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
