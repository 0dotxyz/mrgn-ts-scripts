import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  AccountMeta,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import { join } from "path";
import {
  deriveSpotMarketPDA,
  deriveDriftStatePDA,
  deriveSpotMarketVaultPDA,
  DriftConfigCompact,
  deriveDriftUserPDA,
  deriveDriftUserStatsPDA,
} from "./lib/utils";
import {
  deriveBankWithSeed,
  deriveLiquidityVault,
  deriveLiquidityVaultAuthority,
} from "../common/pdas";
import { commonSetup } from "../../lib/common-setup";
import { bs58 } from "@switchboard-xyz/common";
import { bigNumberToWrappedI80F48 } from "@mrgnlabs/mrgn-common";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  GROUP_KEY: PublicKey;
  BANK_MINT: PublicKey;
  // Can be found here: https://github.com/drift-labs/protocol-v2/blob/53166fa2702db1bac1ae9c025a7e28bbe35fab30/sdk/src/constants/spotMarkets.ts
  DRIFT_MARKET_INDEX: number;
  ORACLE: PublicKey;
  /** 9 (DriftPythPush) or 10 (DriftSwitchboardPull) */
  ORACLE_SETUP: { driftPythPull: {} } | { driftSwitchboardPull: {} };
  DRIFT_ORACLE: PublicKey;
  SEED: BN;
  /** Group admin (generally the MS on mainnet) */
  ADMIN?: PublicKey; // If omitted, defaults to wallet.pubkey
  /** Pays flat sol fee to init and rent (generally the MS on mainnet) */
  FEE_PAYER?: PublicKey; // If omitted, defaults to ADMIN
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads

  // Optional Bank Config fields
  DEPOSIT_LIMIT?: string; // Default: 10^13 (10_000_000_000)
  TOTAL_ASSET_VALUE_INIT_LIMIT?: string; // Default: 10^13 (10_000_000_000)
  INIT_DEPOSIT_AMOUNT?: BN; // Default: 100
};

async function main() {
  // Get config file from args
  const configFile = process.argv[2];
  if (!configFile) {
    console.error(
      "Usage: npx ts-node scripts/drift/add_drift_bank.ts <config-file>",
    );
    console.error(
      "Example: npx ts-node scripts/drift/add_drift_bank.ts configs/usdc.json",
    );
    process.exit(1);
  }

  // Load config
  const configPath = join(__dirname, configFile);
  const raw_config = readFileSync(configPath, "utf8");
  const config = parseConfig(raw_config);

  console.log("=== Add Drift Bank ===\n");
  console.log("Config:", configFile);
  console.log("Bank mint:", config.BANK_MINT.toString());
  console.log("Drift market index:", config.DRIFT_MARKET_INDEX);
  console.log();
  config.ADMIN = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");
  config.FEE_PAYER = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");
  config.MULTISIG_PAYER = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");

  await addDriftBank(sendTx, config, "/keys/staging-deploy.json");
}

export async function addDriftBank(
  sendTx: boolean,
  config: Config,
  walletPath: string,
): Promise<PublicKey> {
  // Setup connection and program
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;
  const wallet = user.wallet;
  const program = user.program;

  // Derive accounts
  const [bank] = deriveBankWithSeed(
    program.programId,
    config.GROUP_KEY,
    config.BANK_MINT,
    config.SEED,
  );

  // Use spot market address from config if provided, otherwise derive it
  const driftSpotMarket = deriveSpotMarketPDA(config.DRIFT_MARKET_INDEX)[0];

  const [driftState] = deriveDriftStatePDA();
  const [driftSpotMarketVault] = deriveSpotMarketVaultPDA(
    config.DRIFT_MARKET_INDEX,
  );

  console.log("Derived Accounts:");
  console.log("  Bank:", bank.toString());
  console.log("  Drift Spot Market:", driftSpotMarket.toString());
  console.log("  Drift Spot Market Vault:", driftSpotMarketVault.toString());
  console.log("  Drift State:", driftState.toString());
  console.log();

  // Build drift bank config
  const driftConfig: DriftConfigCompact = {
    oracle: config.ORACLE,
    assetWeightInit: bigNumberToWrappedI80F48(0.55),
    assetWeightMaint: bigNumberToWrappedI80F48(0.65),
    depositLimit: new BN(config.DEPOSIT_LIMIT ?? 10_000_000_000),
    oracleSetup: config.ORACLE_SETUP,
    operationalState: {
      operational: {},
    },
    riskTier: {
      collateral: {},
    },
    configFlags: 0,
    totalAssetValueInitLimit: new BN(
      config.TOTAL_ASSET_VALUE_INIT_LIMIT ?? 10_000_000_000,
    ),
    oracleMaxAge: 70,
    oracleMaxConfidence: 0, // Default: 10% confidence
  };

  console.log("Bank Configuration:");
  console.log("  Deposit Limit:", driftConfig.depositLimit.toString());
  console.log(
    "  Total Asset Value Limit:",
    driftConfig.totalAssetValueInitLimit.toString(),
  );
  console.log();

  // Detect the correct token program by checking the mint's owner
  console.log("Detecting token program for mint...");
  let tokenProgram = TOKEN_PROGRAM_ID;
  try {
    await getMint(
      connection,
      config.BANK_MINT,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    tokenProgram = TOKEN_2022_PROGRAM_ID;
    console.log("  Using Token-2022 program");
  } catch {
    // If it fails with Token-2022, it's a regular SPL token
    console.log("  Using SPL Token program");
  }
  console.log();

  // Build lendingPoolAddBankDrift instruction
  const oracleMeta: AccountMeta = {
    pubkey: driftConfig.oracle,
    isSigner: false,
    isWritable: false,
  };
  const spotMarketMeta: AccountMeta = {
    pubkey: driftSpotMarket,
    isSigner: false,
    isWritable: false,
  };

  const admin = config.ADMIN ?? wallet.publicKey;
  const feePayer = config.FEE_PAYER ?? admin;

  const addBankIx = await program.methods
    .lendingPoolAddBankDrift(driftConfig, config.SEED)
    .accounts({
      group: config.GROUP_KEY,
      feePayer,
      bankMint: config.BANK_MINT,
      integrationAcc1: driftSpotMarket,
      tokenProgram,
    })
    .accountsPartial({
      admin,
    })
    .remainingAccounts([oracleMeta, spotMarketMeta])
    .instruction();

  const signerTokenAccount = getAssociatedTokenAddressSync(
    config.BANK_MINT,
    admin,
    true,
    tokenProgram,
  );
  const [liquidityVault] = deriveLiquidityVault(
    program.programId,
    bank,
  );
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    bank,
  );

  const [driftUser] = deriveDriftUserPDA(liquidityVaultAuthority, 0);
  const [driftUserStats] = deriveDriftUserStatsPDA(liquidityVaultAuthority);

  console.log("Derived accounts:");
  console.log("  spotMarket:", driftSpotMarket.toString());
  console.log("  liquidityVaultAuthority:", liquidityVaultAuthority.toString());
  console.log("  driftUser:", driftUser.toString());
  console.log("  driftUserStats:", driftUserStats.toString());
  console.log("  signerTokenAccount", signerTokenAccount.toString());
  console.log();

  const initUserIx = await program.methods
    .driftInitUser(config.INIT_DEPOSIT_AMOUNT ?? new BN(100))
    .accounts({
      feePayer,
      signerTokenAccount,
      bank,
      driftState,
      driftSpotMarketVault,
      driftOracle: config.DRIFT_ORACLE,
      tokenProgram,
    })
    .accountsPartial({
      liquidityVault,
      liquidityVaultAuthority,
      mint: config.BANK_MINT,
      integrationAcc1: driftSpotMarket,
      integrationAcc2: driftUser,
      integrationAcc3: driftUserStats,
    })
    .instruction();

  const transaction = new Transaction().add(addBankIx, initUserIx);

  transaction.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  if (sendTx) {
    try {
      console.log("Executing transaction...");
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet.payer],
      );
      console.log("✓ Bank & Drift useradded successfully!");
      console.log("Signature:", signature);
      console.log();
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    transaction.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("bank key: " + bank);
    console.log("Base58-encoded transaction:", base58Transaction);
    console.log();
    console.log("ALL accounts:");
    for (let ix of transaction.instructions)
    {
      for (let account of ix.keys)
      {
        console.log(account.pubkey.toString());
      }
    }
  }

  console.log();
  console.log("✓ Drift bank setup complete!");

  return bank;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}

function parseConfig(rawConfig: string): Config {
  const pkFromString = (s: any) => new PublicKey(s);
  const json = JSON.parse(rawConfig);

  let ORACLE_SETUP;
  if (
    json.marginfiOracleType === "switchboardPull" ||
    json.comments?.marginfiOracleType === "switchboardPull"
  ) {
    ORACLE_SETUP = { driftSwitchboardPull: {} };
  } else {
    // Default to pythPushOracle
    ORACLE_SETUP = { driftPythPull: {} };
  }

  return {
    PROGRAM_ID: json.programId,
    GROUP_KEY: pkFromString(json.group),
    BANK_MINT: pkFromString(json.bankMint),
    DRIFT_MARKET_INDEX: json.driftMarketIndex,
    ORACLE: pkFromString(json.oracle),
    ORACLE_SETUP,
    DRIFT_ORACLE: pkFromString(json.driftOracle),
    DEPOSIT_LIMIT: json.depositLimit,
    TOTAL_ASSET_VALUE_INIT_LIMIT: json.totalAssetValueInitLimit,
    SEED: new BN(json.seed),
    INIT_DEPOSIT_AMOUNT: new BN(json.initDepositAmount),
  };
}
