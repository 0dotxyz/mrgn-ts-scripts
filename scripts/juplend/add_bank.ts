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

const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";

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
  ADMIN: PublicKey;
  /** Pays flat sol fee to init and rent (generally the MS on mainnet) */
  FEE_PAYER: PublicKey;
  MULTISIG_PAYER: PublicKey;

  ASSET_WEIGHT_INIT: string;
  ASSET_WEIGHT_MAINT: string;
  DEPOSIT_LIMIT: string;
  TOTAL_ASSET_VALUE_INIT_LIMIT: string;
  RISK_TIER: "isolated" | "collateral";
  ORACLE_MAX_AGE: number;
  CONFIG_FLAGS: number;
};

function normalizeNumericInput(value: string | number): string {
  return String(value).replace(/_/g, "").trim();
}

function numberFromConfig(
  value: string | number,
  fieldName: string,
): number {
  const normalized = normalizeNumericInput(value);
  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric value for ${fieldName}: ${value}`);
  }
  return parsed;
}

function bnFromConfig(
  value: string | number,
  fieldName: string,
): BN {
  const normalized = normalizeNumericInput(value);
  try {
    return new BN(normalized);
  } catch {
    throw new Error(`Invalid integer value for ${fieldName}: ${value}`);
  }
}

function requireField(
  json: Record<string, unknown>,
  fieldName: string,
): string | number {
  const value = json[fieldName];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Missing required config field: ${fieldName}`);
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`Invalid type for ${fieldName}: expected string or number`);
  }
  return value;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let sendTx = false;
  let walletPath = DEFAULT_WALLET_PATH;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--send") {
      sendTx = true;
    } else if (arg.startsWith("--wallet=")) {
      walletPath = arg.split("=")[1];
    } else {
      positional.push(arg);
    }
  }

  const envName = positional[0];
  const configFile = positional[1];

  if (!envName || !configFile) {
    console.error(
      "Usage: tsx scripts/juplend/add_bank.ts <env> <config-file> [--send] [--wallet=<path>]",
    );
    console.error(
      "Example: tsx scripts/juplend/add_bank.ts stage configs/stage/usdc.json --send",
    );
    process.exit(1);
  }

  return { envName, configFile, sendTx, walletPath };
}

async function main() {
  const { envName, configFile, sendTx, walletPath } = parseArgs();

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
  console.log("Send:", sendTx);
  if (config.MULTISIG_PAYER) {
    console.log("Multisig:", config.MULTISIG_PAYER.toString());
  }
  console.log();

  await addJuplendBank(sendTx, config, walletPath);
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
      numberFromConfig(config.ASSET_WEIGHT_INIT, "assetWeightInit"),
    ),
    assetWeightMaint: bigNumberToWrappedI80F48(
      numberFromConfig(config.ASSET_WEIGHT_MAINT, "assetWeightMaint"),
    ),
    depositLimit: bnFromConfig(config.DEPOSIT_LIMIT, "depositLimit"),
    oracleSetup: config.ORACLE_SETUP,
    riskTier,
    configFlags: config.CONFIG_FLAGS,
    totalAssetValueInitLimit: bnFromConfig(
      config.TOTAL_ASSET_VALUE_INIT_LIMIT,
      "totalAssetValueInitLimit",
    ),
    oracleMaxAge: config.ORACLE_MAX_AGE,
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

  const admin = config.ADMIN;
  const feePayer = config.FEE_PAYER;

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
  _env?: Record<string, string>,
): Config {
  const json = JSON.parse(rawConfig);

  const programId = requireField(json, "programId");
  const group = requireField(json, "group");
  const bankMint = requireField(json, "bankMint");
  const juplendLending = requireField(json, "juplendLending");
  const fTokenMint = requireField(json, "fTokenMint");
  const oracle = requireField(json, "oracle");
  const seed = requireField(json, "seed");
  const assetWeightInit = requireField(json, "assetWeightInit");
  const assetWeightMaint = requireField(json, "assetWeightMaint");
  const depositLimit = requireField(json, "depositLimit");
  const totalAssetValueInitLimit = requireField(json, "totalAssetValueInitLimit");
  const riskTierRaw = requireField(json, "riskTier");
  const oracleMaxAge = requireField(json, "oracleMaxAge");
  const configFlags = requireField(json, "configFlags");
  const admin = requireField(json, "admin");
  const feePayer = requireField(json, "feePayer");
  const multisigPayer = requireField(json, "multisigPayer");
  const oracleSetup = requireField(json, "oracleSetup");

  let ORACLE_SETUP: Config["ORACLE_SETUP"];
  if (oracleSetup === "juplendSwitchboardPull" || oracleSetup === "switchboardPull") {
    ORACLE_SETUP = { juplendSwitchboardPull: {} };
  } else if (oracleSetup === "juplendPythPull" || oracleSetup === "pythPull") {
    ORACLE_SETUP = { juplendPythPull: {} };
  } else {
    throw new Error(
      `Invalid oracleSetup: ${oracleSetup}. Expected juplendSwitchboardPull/switchboardPull or juplendPythPull/pythPull`,
    );
  }

  if (riskTierRaw !== "isolated" && riskTierRaw !== "collateral") {
    throw new Error(
      `Invalid riskTier: ${riskTierRaw}. Expected "isolated" or "collateral"`,
    );
  }

  return {
    PROGRAM_ID: String(programId),
    GROUP_KEY: new PublicKey(String(group)),
    BANK_MINT: new PublicKey(String(bankMint)),
    JUPLEND_LENDING: new PublicKey(String(juplendLending)),
    F_TOKEN_MINT: new PublicKey(String(fTokenMint)),
    ORACLE: new PublicKey(String(oracle)),
    ORACLE_SETUP,
    SEED: bnFromConfig(seed, "seed"),
    ASSET_WEIGHT_INIT: String(assetWeightInit),
    ASSET_WEIGHT_MAINT: String(assetWeightMaint),
    DEPOSIT_LIMIT: String(depositLimit),
    TOTAL_ASSET_VALUE_INIT_LIMIT: String(totalAssetValueInitLimit),
    RISK_TIER: riskTierRaw,
    ORACLE_MAX_AGE: numberFromConfig(oracleMaxAge, "oracleMaxAge"),
    CONFIG_FLAGS: numberFromConfig(configFlags, "configFlags"),
    ADMIN: new PublicKey(String(admin)),
    FEE_PAYER: new PublicKey(String(feePayer)),
    MULTISIG_PAYER: new PublicKey(String(multisigPayer)),
  };
}
