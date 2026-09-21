import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

const ORACLE_TYPE_PYTH = 3;

/** Setups that take the venue account (Kamino reserve / Drift market / Solend / JupLend Lending)
 *  after the price feed. It is validated against `oracle_keys[1]`, which this ix does not write,
 *  so it is read off the bank rather than configured below. */
const VENUE_SETUPS = new Set([
  6, // KaminoPythPush
  9, // DriftPythPull
  11, // SolendPythPull
  15, // JuplendPythPull
]);

/** Shared settings across all entries */
type SharedConfig = {
  PROGRAM_ID: string;
  ADMIN: PublicKey;
  MULTISIG?: PublicKey; // May be omitted if not using squads
};

const configCommon: SharedConfig = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  ADMIN: new PublicKey("725Z4QQUVhRiXcCdf4cQTrxXYmQXyW9zgVkW5PDVSJz4"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

type BankOracleConfig = {
  bank: PublicKey;
  oracle: PublicKey;
  /** See `OracleSetup::from_u8`, e.g. 3 (PythPushOracle) */
  oracleType: number;
};

/** One entry per bank to update */
const configs: BankOracleConfig[] = [
  {
    bank: new PublicKey("4JgDTBCnaXBd5M14Z6nJHhzEVL5iLjyyCrGC1Zfz3Qma"),
    oracle: new PublicKey("6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT"),
    oracleType: ORACLE_TYPE_PYTH,
  },
  // ...More entries here as needed. The limit even without using LUTs is fairly high (at least 6)
];

async function main() {
  const user = commonSetup(
    sendTx,
    configCommon.PROGRAM_ID,
    "/.keys/zerotrade_admin.json",
    configCommon.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  // Build a single transaction with one instruction per configs[] entry
  const transaction = new Transaction();

  for (const cfg of configs) {
    const keys: PublicKey[] = [cfg.oracle];
    if (VENUE_SETUPS.has(cfg.oracleType)) {
      const bank = await program.account.bank.fetch(cfg.bank);
      keys.push(bank.config.oracleKeys[1]);
    }

    const remaining: AccountMeta[] = keys.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    }));

    const ix = await program.methods
      .lendingPoolConfigureBankOracle(cfg.oracleType, cfg.oracle)
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
