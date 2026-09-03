import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * Configure a bank to use one of the LST/mSOL "multiplier" oracle setups, priced as
 * `base_feed * exchange_rate`. The rate comes from the Marinade `State` (…MSOL) or an SPL /
 * Sanctum stake pool (…LST). Kamino/JupLend variants additionally carry the venue account.
 *
 * Remaining accounts:
 *   Pyth variants:            [base feed, rate source]
 *   Kamino / JupLend variants: [base feed, venue account, rate source]
 *
 * The instruction does not write `oracle_keys[1]` (the venue account is fixed at bank creation,
 * only re-validated here), so it is read off the bank instead of being configured below.
 *
 * If true, send the tx. If false, output the unsigned b58 tx to console (for a squads proposal).
 */
const sendTx = false;

/** Instruction `setup` byte (see `OracleSetup::from_u8`). */
const ORACLE_SETUP_PYTH_MSOL = 19;
const ORACLE_SETUP_KAMINO_MSOL = 20;
const ORACLE_SETUP_JUPLEND_MSOL = 21;
const ORACLE_SETUP_PYTH_LST = 22;
const ORACLE_SETUP_KAMINO_LST = 23;
const ORACLE_SETUP_JUPLEND_LST = 24;

/** Setups that take a venue account between the base feed and the rate source. */
const VENUE_SETUPS = new Set([
  ORACLE_SETUP_KAMINO_MSOL,
  ORACLE_SETUP_JUPLEND_MSOL,
  ORACLE_SETUP_KAMINO_LST,
  ORACLE_SETUP_JUPLEND_LST,
]);

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
  /** Base price feed -> `oracle_keys[0]`. Pyth SOL/USD for every setup here. */
  oracle: PublicKey;
  /** Rate source: Marinade State (…MSOL) or SPL stake pool (…LST). */
  multiplier: PublicKey;
  /** One of the ORACLE_SETUP_* constants above. */
  setup: number;
};

/** One entry per bank to update */
const configs: BankOracleConfig[] = [
  // Example (PythMSOL): mSOL bank priced off Pyth SOL/USD * Marinade rate.
  // {
  //   bank: new PublicKey("..."),
  //   oracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  //   multiplier: new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC"),
  //   setup: ORACLE_SETUP_PYTH_MSOL,
  // },
  // Example (KaminoLST): Kamino-deposited LST bank; the reserve is read off the bank.
  // {
  //   bank: new PublicKey("..."),
  //   oracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  //   multiplier: new PublicKey("stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi"),
  //   setup: ORACLE_SETUP_KAMINO_LST,
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
    const keys: PublicKey[] = [cfg.oracle];
    if (VENUE_SETUPS.has(cfg.setup)) {
      const bank = await program.account.bank.fetch(cfg.bank);
      keys.push(bank.config.oracleKeys[1]);
    }
    keys.push(cfg.multiplier);

    const remaining: AccountMeta[] = keys.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    }));

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
