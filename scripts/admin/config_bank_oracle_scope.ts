import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * Configure a bank to price from a Scope feed. Scope stores a fixed array of `DatedPrice` records
 * in one `OraclePrices` account (owned by HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ), so a bank
 * is identified by the pair (account, entry index) rather than by the account alone. That is why
 * this has its own instruction instead of going through `configure_bank_oracle`.
 *
 * `oracle` becomes `oracle_keys[0]` and the first remaining account. `entryIndex` becomes
 * `scope_entry_index`. Scope carries no confidence interval, so risk is expressed through weights.
 *
 * The setup follows the bank's asset tag: `Scope` for default/SOL banks, `ScopeKamino` and
 * `ScopeJuplend` (0.1.12) for Kamino and JupLend banks, which also pass their reserve or lending
 * account (`venue`, already in `oracle_keys[1]` from bank creation) after the feed.
 *
 * The entry must already be populated: a never-refreshed record is all zeroes and is rejected.
 *
 * If true, send the tx. If false, output the unsigned b58 tx to console (for a squads proposal).
 */
const sendTx = false;

/** Shared settings across all entries */
export type SharedConfig = {
  PROGRAM_ID: string;
  ADMIN: PublicKey;
  MULTISIG?: PublicKey; // May be omitted if not using squads
};

const configCommon: SharedConfig = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

export type BankOracleConfig = {
  bank: PublicKey;
  /** Scope `OraclePrices` account -> `oracle_keys[0]`. */
  oracle: PublicKey;
  /** Record within that account -> `scope_entry_index`. */
  entryIndex: number;
  /** Kamino reserve or JupLend lending account; set for Kamino/JupLend banks only. */
  venue?: PublicKey;
};

/** One entry per bank to update */
const configs: BankOracleConfig[] = [
  // {
  //   bank: new PublicKey("..."),
  //   oracle: new PublicKey("3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C"),
  //   entryIndex: 0,
  // },
];

async function main() {
  await configureScopeOracle(sendTx, configCommon, "./keys/zerotrade_admin.json", configs);
}

export async function configureScopeOracle(
  sendTx: boolean,
  configCommon: SharedConfig,
  walletPath: string,
  configs: BankOracleConfig[],
) {
  const user = commonSetup(
    sendTx,
    configCommon.PROGRAM_ID,
    walletPath,
    configCommon.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  // Build a single transaction with one instruction per configs[] entry
  const transaction = new Transaction();

  for (const cfg of configs) {
    // Remaining accounts: the Scope OraclePrices account (same key as `oracle`), then the venue.
    const remaining: AccountMeta[] = [cfg.oracle, ...(cfg.venue ? [cfg.venue] : [])].map(
      (pubkey) => ({ pubkey, isSigner: false, isWritable: false }),
    );

    const ix = await program.methods
      .lendingPoolConfigureBankOracleScope(cfg.oracle, cfg.entryIndex)
      .accountsPartial({
        governanceAdmin: configCommon.ADMIN,
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
