import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  bigNumberToWrappedI80F48,
  TOKEN_PROGRAM_ID,
  WrappedI80F48,
} from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { OperationalStateRaw, RiskTierRaw } from "@mrgnlabs/marginfi-client-v2";
import { aprToU32, utilToU32 } from "../../lib/utils";
import { deriveBankWithSeed } from "../common/pdas";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;
const cloneEmode = false;
// Always output a separate unsigned transaction to execute after bank creation.
const cloneBreaker = true;

const ASSET_TAG_DEFAULT = 0;
const CIRCUIT_BREAKER_ENABLED_BIT = 11;

export const ORACLE_TYPE_PYTH = 3;
export const ORACLE_TYPE_SCOPE = 18;

type Config = {
  PROGRAM_ID: string;
  GROUP_KEY: PublicKey;
  /**
   * For Pyth, This is the feed, and is owned by rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
   * Pyth Feed IDs can be taken from: https://www.pyth.network/developers/price-feed-ids
   */
  ORACLE: PublicKey;
  /** See `OracleSetup::from_u8`, e.g. 3 (PythPushOracle) */
  ORACLE_TYPE: number;
  /** Required for Scope: entry within the OraclePrices account (0–511). */
  SCOPE_ENTRY_INDEX?: number;
  /** Group governance admin (generally the timelocked MS on mainnet) */
  ADMIN: PublicKey;
  /** Pays flat sol fee to init and rent (generally the MS on mainnet) */
  FEE_PAYER?: PublicKey; // If omitted, defaults to ADMIN
  BANK_MINT: PublicKey;
  SEED: number;
  /** Defaults to ASSET_TAG_DEFAULT (0). Set to 1 for a SOL bank, etc. */
  ASSET_TAG?: number;
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
  CLONE_EMODE_FROM?: PublicKey; // Required when cloneEmode = true
  CLONE_BREAKER_FROM?: PublicKey; // Required when cloneBreaker = true
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEY: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  ORACLE: new PublicKey("AMjqm5S4QaAHWLv52jJiRpFNW1qo23F6ZM5ChCF5tYgc"),
  ORACLE_TYPE: ORACLE_TYPE_SCOPE,
  SCOPE_ENTRY_INDEX: 60,
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  BANK_MINT: new PublicKey("USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk"),
  SEED: 0,
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  CLONE_EMODE_FROM: new PublicKey(
    "Dj2CwMF3GM7mMT5hcyGXKuYSQ2kQ5zaVCkA1zX1qaTva",
  ),
  CLONE_BREAKER_FROM: new PublicKey(
    "Dj2CwMF3GM7mMT5hcyGXKuYSQ2kQ5zaVCkA1zX1qaTva",
  ),
};

const rate: InterestRateConfig1_7 = {
  insuranceFeeFixedApr: bigNumberToWrappedI80F48(0),
  insuranceIrFee: bigNumberToWrappedI80F48(0),
  protocolFixedFeeApr: bigNumberToWrappedI80F48(0.00001),
  protocolIrFee: bigNumberToWrappedI80F48(0.06),
  protocolOriginationFee: bigNumberToWrappedI80F48(0),

  zeroUtilRate: aprToU32(0),
  hundredUtilRate: aprToU32(0.2),
  points: [
    { util: utilToU32(0.5), rate: aprToU32(0.02) },
    { util: utilToU32(0.8), rate: aprToU32(0.04) },
    { util: utilToU32(0.9), rate: aprToU32(0.05) },
    { util: utilToU32(0.95), rate: aprToU32(0.075) },
    { util: utilToU32(0.98), rate: aprToU32(0.15) },
  ],
  curveType: 1,
};

const bankConfig: BankConfig = {
  assetWeightInit: bigNumberToWrappedI80F48(0.65),
  assetWeightMaint: bigNumberToWrappedI80F48(0.8),
  liabilityWeightInit: bigNumberToWrappedI80F48(1.3),
  liabilityWeightMaint: bigNumberToWrappedI80F48(1.2),
  depositLimit: new BN(5000000 * 10 ** 6),
  interestRateConfig: rate,
  operationalState: { operational: {} },
  borrowLimit: new BN(2500000 * 10 ** 6),
  riskTier: { collateral: {} },
  totalAssetValueInitLimit: new BN(5000000),
  oracleMaxAge: 70,
  assetTag: 0,
  oracleMaxConfidence: 0,
  configFlags: 0,
};

async function main() {
  await addBank(
    sendTx,
    config,
    "/.keys/staging-deploy.json",
    cloneEmode,
    cloneBreaker,
  );
}

export async function addBank(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  cloneEmode = false,
  cloneBreaker = false,
): Promise<PublicKey> {
  if (cloneBreaker && !config.CLONE_BREAKER_FROM) {
    throw new Error("CLONE_BREAKER_FROM must be set when cloneBreaker = true");
  }

  console.log("adding bank to group: " + config.GROUP_KEY);
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;

  const [bankKey] = deriveBankWithSeed(
    program.programId,
    config.GROUP_KEY,
    config.BANK_MINT,
    new BN(config.SEED),
  );

  // Detect token program
  let tokenProgram = TOKEN_PROGRAM_ID;
  try {
    await getMint(
      connection,
      config.BANK_MINT,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    tokenProgram = TOKEN_2022_PROGRAM_ID;
    console.log("Detected Token-2022 mint");
  } catch {
    console.log("Detected SPL Token mint");
  }

  if (cloneEmode && !config.CLONE_EMODE_FROM) {
    throw new Error("CLONE_FROM must be set when cloneEmode = true");
  }

  let oracleMeta: AccountMeta;
  oracleMeta = {
    pubkey: config.ORACLE,
    isSigner: false,
    isWritable: false,
  };

  if (
    config.ORACLE_TYPE === ORACLE_TYPE_SCOPE &&
    config.SCOPE_ENTRY_INDEX == null
  ) {
    throw new Error("SCOPE_ENTRY_INDEX must be set for Scope oracles");
  }

  const configureOracle =
    config.ORACLE_TYPE === ORACLE_TYPE_SCOPE
      ? program.methods.lendingPoolConfigureBankOracleScope(
          config.ORACLE,
          config.SCOPE_ENTRY_INDEX!,
        )
      : program.methods.lendingPoolConfigureBankOracle(
          config.ORACLE_TYPE,
          config.ORACLE,
        );

  const tx = new Transaction();

  tx.add(
    await program.methods
      .lendingPoolAddBankWithSeed(
        {
          assetWeightInit: bankConfig.assetWeightInit,
          assetWeightMaint: bankConfig.assetWeightMaint,
          liabilityWeightInit: bankConfig.liabilityWeightInit,
          liabilityWeightMaint: bankConfig.liabilityWeightMaint,
          depositLimit: bankConfig.depositLimit,
          interestRateConfig: bankConfig.interestRateConfig,
          operationalState: bankConfig.operationalState,
          borrowLimit: bankConfig.borrowLimit,
          riskTier: bankConfig.riskTier,
          assetTag: config.ASSET_TAG ?? bankConfig.assetTag,
          pad0: [0, 0, 0, 0, 0, 0],
          totalAssetValueInitLimit: bankConfig.totalAssetValueInitLimit,
          oracleMaxAge: bankConfig.oracleMaxAge,
          configFlags: bankConfig.configFlags,
          oracleMaxConfidence: bankConfig.oracleMaxConfidence,
        },
        new BN(config.SEED),
      )
      .accountsPartial({
        marginfiGroup: config.GROUP_KEY,
        governanceAdmin: config.ADMIN,
        feePayer: config.FEE_PAYER ?? config.ADMIN,
        bankMint: config.BANK_MINT,
        tokenProgram,
      })
      .instruction(),
    await configureOracle
      .accountsPartial({
        group: config.GROUP_KEY,
        governanceAdmin: config.ADMIN,
        bank: bankKey,
      })
      .remainingAccounts([oracleMeta])
      .instruction(),
  );

  if (cloneEmode) {
    tx.add(
      await program.methods
        .lendingPoolCloneEmode()
        .accounts({
          copyFromBank: config.CLONE_EMODE_FROM!,
          copyToBank: bankKey,
        })
        .accountsPartial({
          governanceAdmin: config.ADMIN,
        })
        .instruction(),
    );
  }

  // Keep the breaker instructions out of the bank-creation transaction.
  let breakerTx: Transaction | undefined;
  if (cloneBreaker) {
    const source = await program.account.bank.fetch(config.CLONE_BREAKER_FROM!);
    const enabled = source.flags.testn(CIRCUIT_BREAKER_ENABLED_BIT);
    breakerTx = new Transaction();

    // Enabling requires a warm price cache on the newly created bank.
    if (enabled) {
      breakerTx.add(
        await program.methods
          .lendingPoolPulseBankPriceCache()
          .accountsPartial({ group: config.GROUP_KEY, bank: bankKey })
          .remainingAccounts([oracleMeta])
          .instruction(),
      );
    }

    breakerTx.add(
      await program.methods
        .lendingPoolConfigureBank({
          depositLimit: null,
          borrowLimit: null,
          operationalState: null,
          interestRateConfig: null,
          totalAssetValueInitLimit: null,
          permissionlessBadDebtSettlement: null,
          liquidationLiquidatorFee: null,
          liquidationInsuranceFee: null,
          circuitBreakerEnabled: enabled,
          cbDeviationBpsTiers: source.config.cbDeviationBpsTiers,
          cbTierDurationsSeconds: source.config.cbTierDurationsSeconds,
          cbEscalationWindowMult: source.config.cbEscalationWindowMult,
          cbEmaAlphaBps: source.config.cbEmaAlphaBps,
          cbWindowSeconds: source.config.cbWindowSeconds,
          cbWindowMaxUpBps: source.config.cbWindowMaxUpBps,
          cbWindowMaxDownBps: source.config.cbWindowMaxDownBps,
        })
        .accountsPartial({
          group: config.GROUP_KEY,
          admin: config.ADMIN,
          bank: bankKey,
        })
        .instruction(),
    );
  }

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [
        user.wallet.payer,
      ]);
      console.log("bank key: " + bankKey);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    tx.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const serializedTransaction = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("bank key: " + bankKey);
    console.log("Base58-encoded transaction:", base58Transaction);
    console.log("ALL accounts:");
    for (let ix of tx.instructions) {
      for (let account of ix.keys) {
        console.log(`    new PublicKey("${account.pubkey.toString()}"),`);
      }
    }
  }

  if (breakerTx) {
    breakerTx.feePayer = config.MULTISIG_PAYER ?? config.ADMIN;
    breakerTx.recentBlockhash = (
      await connection.getLatestBlockhash()
    ).blockhash;
    console.log("Execute the circuit breaker transaction after bank creation.");
    console.log(
      "Base58-encoded circuit breaker transaction:",
      bs58.encode(
        breakerTx.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
      ),
    );
  }

  return bankKey;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}

export type RatePoint = {
  util: number;
  rate: number;
};

type InterestRateConfig1_7 = {
  // Fees
  insuranceFeeFixedApr: WrappedI80F48;
  insuranceIrFee: WrappedI80F48;
  protocolFixedFeeApr: WrappedI80F48;
  protocolIrFee: WrappedI80F48;

  protocolOriginationFee: WrappedI80F48;

  zeroUtilRate: number;
  hundredUtilRate: number;
  points: RatePoint[];
  curveType: number;
};

type BankConfig = {
  assetWeightInit: WrappedI80F48;
  assetWeightMaint: WrappedI80F48;

  liabilityWeightInit: WrappedI80F48;
  liabilityWeightMaint: WrappedI80F48;

  depositLimit: BN;
  interestRateConfig: InterestRateConfig1_7;

  /** Paused = 0, Operational = 1, ReduceOnly = 2 */
  operationalState: OperationalStateRaw;

  borrowLimit: BN;
  /** Collateral = 0, Isolated = 1 */
  riskTier: RiskTierRaw;
  assetTag: number;
  configFlags: number;
  totalAssetValueInitLimit: BN;
  oracleMaxAge: number;
  /** A u32, e.g. for 100% pass u32::MAX */
  oracleMaxConfidence: number;
};
