import { PublicKey } from "@solana/web3.js";

/**
 * Kamino Bank Config File Schema
 *
 * Config files are JSON files stored in scripts/kamino/configs/
 * Naming convention: <asset>_<market>.json (e.g., sol_main.json, pyusd_jlp.json)
 */

export interface KaminoBankConfig {
  // Required: Asset identification
  asset: string; // Human-readable name (e.g., "SOL", "USDC")
  market: string; // Market name (e.g., "main", "jlp", "altcoin")
  bankMint: string; // Token mint address

  // Required: Kamino integration
  kaminoMarket: string; // Kamino lending market address
  kaminoReserve: string; // Kamino reserve address for this asset

  // Required: Oracle configuration
  oracle: string; // Oracle feed address
  oracleType: KaminoOracleType; // "kaminoPythPush"

  // Required: Risk parameters
  assetWeightInit: number; // 0.0 - 1.0 (e.g., 0.80 = 80%)
  assetWeightMaint: number; // 0.0 - 1.0 (e.g., 0.90 = 90%)
  depositLimit: string; // Native units as string (to handle large numbers)
  totalAssetValueInitLimit: string; // USD value limit as string

  // Optional: Oracle settings (defaults provided)
  oracleMaxAge?: number; // Default: 300 seconds
  oracleMaxConfidence?: number; // Default: 0 (use 10%)

  // Optional: Seed (null = auto-select starting at 300)
  seed?: number | null;

  // Derived values (populated by add_bank script)
  derived?: DerivedConfig;

  // Optional: Human-readable comments
  comments?: {
    depositLimitHuman?: string;
    totalAssetValueHuman?: string;
    notes?: string;
    [key: string]: string | undefined;
  };
}

export interface DerivedConfig {
  bankAddress?: string | null;
  reserveOracle?: string | null; // Scope oracle from Kamino reserve
  farmState?: string | null; // Farm state from Kamino reserve (or null if no farm)
  tokenProgram?: string | null; // Token program address
  decimals?: number | null;
  seed?: number | null; // Final seed used
}

export type KaminoOracleType = "kaminoPythPush";

/**
 * Convert oracle type string to the raw enum format expected by the program
 */
export function oracleTypeToRaw(oracleType: KaminoOracleType): { kaminoPythPush: {} } {
  if (oracleType === "kaminoPythPush") {
    return { kaminoPythPush: {} };
  }
  throw new Error(`Unknown oracle type: ${oracleType}`);
}

/**
 * Load and validate a config file
 */
export function loadConfig(configPath: string): KaminoBankConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require(configPath) as KaminoBankConfig;
  validateConfig(config);
  return config;
}

/**
 * Validate required fields in config
 */
export function validateConfig(config: KaminoBankConfig): void {
  const required: (keyof KaminoBankConfig)[] = [
    "asset",
    "market",
    "bankMint",
    "kaminoMarket",
    "kaminoReserve",
    "oracle",
    "oracleType",
    "assetWeightInit",
    "assetWeightMaint",
    "depositLimit",
    "totalAssetValueInitLimit",
  ];

  for (const field of required) {
    if (config[field] === undefined || config[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }

  // Validate oracle type
  if (!["kaminoPythPush"].includes(config.oracleType)) {
    throw new Error(`Invalid oracleType: ${config.oracleType}. Must be "kaminoPythPush"`);
  }

  // Validate weights are in valid range
  if (config.assetWeightInit < 0 || config.assetWeightInit > 1) {
    throw new Error(`assetWeightInit must be between 0 and 1, got: ${config.assetWeightInit}`);
  }
  if (config.assetWeightMaint < 0 || config.assetWeightMaint > 1) {
    throw new Error(`assetWeightMaint must be between 0 and 1, got: ${config.assetWeightMaint}`);
  }

  // Validate public keys are valid
  try {
    new PublicKey(config.bankMint);
    new PublicKey(config.kaminoMarket);
    new PublicKey(config.kaminoReserve);
    new PublicKey(config.oracle);
  } catch (e) {
    throw new Error(`Invalid public key in config: ${e}`);
  }
}

/**
 * Constants for Kamino bank configuration
 */
export const KAMINO_ASSET_TAG = 3;
export const KAMINO_SEED_START = 300;

/**
 * Mainnet constants
 */
export const MAINNET_PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
export const MAINNET_GROUP = "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8";
export const MAINNET_MULTISIG = "CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw";
export const MAINNET_LUT = "FtQ5uKQvFoKQ27SWY15tgBeJQnGKmKGzWqDz7kGUbeiq"; // Kamino operations LUT
