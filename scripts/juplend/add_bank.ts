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
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "fs";
import { join } from "path";
import { JuplendConfigCompact } from "./lib/utils";
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
  JUPLEND_LENDING: PublicKey;
  F_TOKEN_MINT: PublicKey;
  ORACLE: PublicKey;
  /** 15 (JuplendPythPull) or 16 (JuplendSwitchboardPull) */
  ORACLE_SETUP: { juplendPythPull: {} } | { juplendSwitchboardPull: {} };
  SEED: BN;
  ADMIN?: PublicKey; // If omitted, defaults to wallet.pubkey
  /** Pays flat sol fee to init and rent (generally the MS on mainnet) */
  FEE_PAYER?: PublicKey; // If omitted, defaults to ADMIN
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads

  // Optional Bank Config fields
  ASSET_WEIGHT_INIT?: string;
  ASSET_WEIGHT_MAINT?: string;
  DEPOSIT_LIMIT?: string;
  TOTAL_ASSET_VALUE_INIT_LIMIT?: string;
  RISK_TIER?: string;
  ORACLE_MAX_AGE?: number;
  CONFIG_FLAGS?: number;
};

async function main() {
  const envName = process.argv[2];
  const configFile = process.argv[3];
  if (!envName || !configFile) {
    console.error(
      "Usage: tsx scripts/juplend/add_bank.ts <env> <config-file>",
    );
    console.error(
      "Example: tsx scripts/juplend/add_bank.ts stage configs/stage/usdc.json",
    );
    process.exit(1);
  }

  const envPath = join(__dirname, "configs/environments.json");
  const envs = JSON.parse(readFileSync(envPath, "utf8"));
  const env = envs[envName];
  if (!env) {
    console.error(`Unknown environment: ${envName}`);
    console.error(`Available: ${Object.keys(envs).join(", ")}`);
    process.exit(1);
  }

  const configPath = join(__dirname, configFile);
  const rawConfig = readFileSync(configPath, "utf8");
  const config = parseConfig(rawConfig, env);

  console.log("=== Add JupLend Bank ===\n");
  console.log("Environment:", envName);
  console.log("Config:", configFile);
  console.log("Bank mint:", config.BANK_MINT.toString());
  console.log("JupLend Lending:", config.JUPLEND_LENDING.toString());
  if (config.MULTISIG_PAYER) {
    console.log("Multisig:", config.MULTISIG_PAYER.toString());
  }
  console.log();

  await addJuplendBank(sendTx, config, "/keys/staging-deploy.json");
}

export async function addJuplendBank(
  sendTx: boolean,
  config: Config,
  walletPath: string,
): Promise<PublicKey> {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;
  const wallet = user.wallet;
  const program = user.program;

  // Derive bank PDA
  const [bank] = deriveBankWithSeed(
    program.programId,
    config.GROUP_KEY,
    config.BANK_MINT,
    config.SEED,
  );

  console.log("Derived Accounts:");
  console.log("  Bank:", bank.toString());
  console.log();

  // Detect token program (SPL vs Token-2022)
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
    console.log("  Using SPL Token program");
  }
  console.log();

  // Build JuplendConfigCompact
  const riskTier =
    config.RISK_TIER === "isolated" ? { isolated: {} } : { collateral: {} };

  const bankConfig: JuplendConfigCompact = {
    oracle: config.ORACLE,
    assetWeightInit: bigNumberToWrappedI80F48(
      Number(config.ASSET_WEIGHT_INIT ?? "0.8"),
    ),
    assetWeightMaint: bigNumberToWrappedI80F48(
      Number(config.ASSET_WEIGHT_MAINT ?? "0.9"),
    ),
    depositLimit: new BN(config.DEPOSIT_LIMIT ?? "1000000000000"),
    oracleSetup: config.ORACLE_SETUP,
    riskTier,
    configFlags: config.CONFIG_FLAGS ?? 0,
    totalAssetValueInitLimit: new BN(
      config.TOTAL_ASSET_VALUE_INIT_LIMIT ?? "1000000000",
    ),
    oracleMaxAge: config.ORACLE_MAX_AGE ?? 70,
    oracleMaxConfidence: 0,
  };

  console.log("Bank Configuration:");
  console.log("  Deposit Limit:", bankConfig.depositLimit.toString());
  console.log(
    "  Total Asset Value Limit:",
    bankConfig.totalAssetValueInitLimit.toString(),
  );
  console.log();

  // Derive vault PDAs
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    bank,
  );
  const [liquidityVault] = deriveLiquidityVault(program.programId, bank);

  // fToken vault is an ATA of liquidityVaultAuthority for fTokenMint
  const juplendFTokenVault = getAssociatedTokenAddressSync(
    config.F_TOKEN_MINT,
    liquidityVaultAuthority,
    true,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const admin = config.ADMIN ?? wallet.publicKey;
  const feePayer = config.FEE_PAYER ?? admin;

  // Remaining accounts for oracle validation
  const oracleMeta: AccountMeta = {
    pubkey: config.ORACLE,
    isSigner: false,
    isWritable: false,
  };
  const lendingMeta: AccountMeta = {
    pubkey: config.JUPLEND_LENDING,
    isSigner: false,
    isWritable: false,
  };

  console.log("Derived accounts:");
  console.log("  liquidityVaultAuthority:", liquidityVaultAuthority.toString());
  console.log("  liquidityVault:", liquidityVault.toString());
  console.log("  fTokenVault:", juplendFTokenVault.toString());
  console.log();

  const addBankIx = await program.methods
    .lendingPoolAddBankJuplend(bankConfig, config.SEED)
    .accounts({
      group: config.GROUP_KEY,
      feePayer,
      bankMint: config.BANK_MINT,
      integrationAcc1: config.JUPLEND_LENDING,
      tokenProgram,
    })
    .accountsPartial({
      fTokenMint: config.F_TOKEN_MINT,
    })
    .remainingAccounts([oracleMeta, lendingMeta])
    .instruction();

  const transaction = new Transaction().add(addBankIx);

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
      console.log("Signature:", signature);
      console.log("Bank added successfully!");
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    transaction.feePayer = config.MULTISIG_PAYER;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("bank key: " + bank);
    console.log("Base58-encoded transaction:", base58Transaction);
  }

  console.log();
  console.log("JupLend bank setup complete!");

  return bank;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}

export function parseConfig(
  rawConfig: string,
  env?: Record<string, string>,
): Config {
  const json = JSON.parse(rawConfig);

  // Environment provides defaults; bank config can override
  const programId = json.programId ?? env?.programId;
  const group = json.group ?? env?.group;
  const admin = json.admin ?? env?.admin;
  const feePayer = json.feePayer ?? env?.feePayer;
  const multisigPayer = json.multisigPayer ?? env?.multisigPayer;

  let ORACLE_SETUP: Config["ORACLE_SETUP"];
  if (
    json.oracleSetup === "juplendSwitchboardPull" ||
    json.oracleSetup === "switchboardPull"
  ) {
    ORACLE_SETUP = { juplendSwitchboardPull: {} };
  } else {
    ORACLE_SETUP = { juplendPythPull: {} };
  }

  return {
    PROGRAM_ID: programId,
    GROUP_KEY: new PublicKey(group),
    BANK_MINT: new PublicKey(json.bankMint),
    JUPLEND_LENDING: new PublicKey(json.juplendLending),
    F_TOKEN_MINT: new PublicKey(json.fTokenMint),
    ORACLE: new PublicKey(json.oracle),
    ORACLE_SETUP,
    SEED: new BN(json.seed),
    ASSET_WEIGHT_INIT: json.assetWeightInit,
    ASSET_WEIGHT_MAINT: json.assetWeightMaint,
    DEPOSIT_LIMIT: json.depositLimit,
    TOTAL_ASSET_VALUE_INIT_LIMIT: json.totalAssetValueInitLimit,
    RISK_TIER: json.riskTier,
    ORACLE_MAX_AGE: json.oracleMaxAge,
    CONFIG_FLAGS: json.configFlags,
    ADMIN: admin ? new PublicKey(admin) : undefined,
    FEE_PAYER: feePayer ? new PublicKey(feePayer) : undefined,
    MULTISIG_PAYER: multisigPayer ? new PublicKey(multisigPayer) : undefined,
  };
}
