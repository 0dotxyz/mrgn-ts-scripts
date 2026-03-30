/**
 * Generates per-bank JSON config files for a given environment
 * by combining: environments.json + bank-params.json +
 * juplend-assets.json + oracles dump.
 *
 * Usage:
 *   npx tsx scripts/juplend/helpers/generate_configs.ts stage
 *   npx tsx scripts/juplend/helpers/generate_configs.ts prod
 *
 * Output: scripts/juplend/configs/<env>/<symbol-lower>.json
 */
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { deriveBankWithSeed } from "../../common/pdas";

// ── Types ──

type Environment = {
  programId: string;
  group: string;
};

type BankParam = {
  symbol: string;
  mint: string;
  fullName: string;
  category: string;
  tokenProgram: string;
  decimals: number;
  assetWeightInit: string;
  assetWeightMaint: string;
  depositLimit: string;
  totalAssetValueInitLimit: string;
  oracleMaxAge: number;
  riskTier?: string;
  configFlags?: number;
};

type BankParamsFile = {
  defaults: {
    seed: number;
    riskTier: string;
    configFlags: number;
  };
  banks: BankParam[];
};

type AssetEntry = {
  symbol: string;
  lending: string;
  fTokenMint: string;
  mint: string;
};

type AssetsFile = {
  juplendProgram: string;
  lendingAdmin: string;
  bankSeed: number;
  assets: AssetEntry[];
};

type OracleEntry = {
  symbol: string;
  mint: string;
  oracle: string;
  oracleSetup: string;
  juplendOracleSetup: string;
  juplendOracleSetupValue: number;
  oracleMaxAge: number;
};

type OraclesFile = {
  oracles: OracleEntry[];
};

// ── Paths ──

const CONFIGS_DIR = "scripts/juplend/configs";
const ENVS_PATH = path.join(CONFIGS_DIR, "environments.json");
const PARAMS_PATH = path.join(CONFIGS_DIR, "bank-params.json");
const ASSETS_PATH = path.join(CONFIGS_DIR, "juplend-assets.json");
const ORACLES_PATH = path.join(
  "scripts/juplend/dumps/artefacts/oracles.json",
);

// ── Main ──

function main() {
  const envName = process.argv[2];
  if (!envName) {
    console.error(
      "Usage: tsx scripts/juplend/helpers/"
      + "generate_configs.ts <env>",
    );
    console.error("  env: stage | prod");
    process.exit(1);
  }

  // Load environments
  const envs: Record<string, Environment> = JSON.parse(
    fs.readFileSync(ENVS_PATH, "utf-8"),
  );
  const env = envs[envName];
  if (!env) {
    console.error(
      `Unknown environment: ${envName}. `
      + `Available: ${Object.keys(envs).join(", ")}`,
    );
    process.exit(1);
  }

  if (env.group.startsWith("TODO")) {
    console.error(
      `Group not configured for "${envName}". `
      + `Edit ${ENVS_PATH} first.`,
    );
    process.exit(1);
  }

  // Load bank parameters
  const params: BankParamsFile = JSON.parse(
    fs.readFileSync(PARAMS_PATH, "utf-8"),
  );

  // Load JupLend assets
  const assets: AssetsFile = JSON.parse(
    fs.readFileSync(ASSETS_PATH, "utf-8"),
  );
  const assetsByMint = new Map<string, AssetEntry>();
  for (const a of assets.assets) {
    assetsByMint.set(a.mint, a);
  }

  // Load oracles (optional — warn if missing)
  let oraclesByMint = new Map<string, OracleEntry>();
  if (fs.existsSync(ORACLES_PATH)) {
    const oraclesFile: OraclesFile = JSON.parse(
      fs.readFileSync(ORACLES_PATH, "utf-8"),
    );
    for (const o of oraclesFile.oracles) {
      oraclesByMint.set(o.mint, o);
    }
  } else {
    console.warn(
      `WARNING: ${ORACLES_PATH} not found. `
      + `Oracle fields will be empty. `
      + `Run dump_oracles.ts first.`,
    );
  }

  // Create output directory
  const outDir = path.join(CONFIGS_DIR, envName);
  fs.mkdirSync(outDir, { recursive: true });

  const programId = new PublicKey(env.programId);
  const group = new PublicKey(env.group);
  const seed = new BN(params.defaults.seed);

  console.log(`Generating configs for: ${envName}`);
  console.log(`  programId: ${env.programId}`);
  console.log(`  group:     ${env.group}`);
  console.log(`  seed:      ${params.defaults.seed}`);
  console.log();

  let generated = 0;
  let skipped = 0;

  for (const bank of params.banks) {
    const asset = assetsByMint.get(bank.mint);
    if (!asset) {
      console.warn(
        `SKIP ${bank.symbol}: `
        + `mint ${bank.mint} not in juplend-assets.json`,
      );
      skipped++;
      continue;
    }

    const oracle = oraclesByMint.get(bank.mint);
    if (!oracle || !oracle.oracle) {
      console.warn(
        `SKIP ${bank.symbol}: `
        + `no oracle found in oracles dump`,
      );
      skipped++;
      continue;
    }

    // Derive bank address for comments
    const [bankPda] = deriveBankWithSeed(
      programId,
      group,
      new PublicKey(bank.mint),
      seed,
    );

    const riskTier =
      bank.riskTier || params.defaults.riskTier;
    const configFlags =
      bank.configFlags ?? params.defaults.configFlags;

    const ticker =
      `${bank.symbol} | ${bank.fullName}`;
    const description =
      `${bank.fullName} | ${bank.category} `
      + `| ${bank.symbol} | JupLend`;

    const config = {
      programId: env.programId,
      group: env.group,
      bankMint: bank.mint,
      juplendLending: asset.lending,
      fTokenMint: asset.fTokenMint,
      oracle: oracle.oracle,
      oracleSetup: oracle.juplendOracleSetup,
      seed: params.defaults.seed,
      assetWeightInit: bank.assetWeightInit,
      assetWeightMaint: bank.assetWeightMaint,
      depositLimit: bank.depositLimit,
      totalAssetValueInitLimit:
        bank.totalAssetValueInitLimit,
      riskTier,
      oracleMaxAge: bank.oracleMaxAge,
      configFlags,
      ticker,
      description,
      comments: {
        asset: bank.fullName,
        tokenProgram: bank.tokenProgram,
        decimals: bank.decimals,
        bankAddress: bankPda.toString(),
      },
    };

    const filename =
      bank.symbol.toLowerCase() + ".json";
    const outPath = path.join(outDir, filename);
    fs.writeFileSync(
      outPath,
      JSON.stringify(config, null, 2) + "\n",
    );

    console.log(
      `  ${bank.symbol.padEnd(8)} → ${outPath}`,
    );
    console.log(
      `    bank PDA: ${bankPda.toString()}`,
    );
    generated++;
  }

  console.log(
    `\nGenerated: ${generated}, Skipped: ${skipped}`,
  );
}

main();
