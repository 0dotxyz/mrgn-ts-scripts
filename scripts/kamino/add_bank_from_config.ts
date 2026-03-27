/**
 * Add Kamino Bank from Config File
 *
 * Usage: npx tsx scripts/kamino/add_bank_from_config.ts configs/<asset>_<market>.json [--skip-oracle-validation]
 */

import {
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  bigNumberToWrappedI80F48,
  TOKEN_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { getMint } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import { makeAddKaminoBankIx } from "./ixes-common";
import { deriveBankWithSeed } from "../common/pdas";
import {
  loadConfig,
  oracleTypeToRaw,
  MAINNET_PROGRAM_ID,
  MAINNET_GROUP,
  MAINNET_MULTISIG,
  MAINNET_LUT,
  KAMINO_SEED_START,
} from "./lib/config_types";
import { getNextAvailableSeed, verifySeedAvailable } from "./lib/seed_manager";
import { validateOracle } from "./lib/validate_oracle";
import { fetchAndValidateReserve } from "./lib/reserve_utils";
import { generateMarkdownOutput, BankOutputData } from "./lib/output_formatter";
import {
  validateSimulationParams,
  formatSimulationValidation,
} from "./lib/simulation_validator";
import { KaminoConfigCompact, KLEND_PROGRAM_ID } from "./kamino-types";
import { PYTH_PULL_MIGRATED } from "../utils/utils";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: npx tsx scripts/kamino/add_bank_from_config.ts <config_path> [--skip-oracle-validation]"
    );
    process.exit(1);
  }
  await addBankFromConfig(args[0], args.includes("--skip-oracle-validation"));
}

export async function addBankFromConfig(
  configPath: string,
  skipOracleValidation = false
): Promise<void> {
  // Load config
  const resolvedPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(__dirname, configPath);
  const config = loadConfig(resolvedPath);
  console.log(`\n=== ${config.asset} on ${config.market} market ===\n`);

  // Setup
  const user = commonSetup(
    false,
    MAINNET_PROGRAM_ID,
    undefined,
    new PublicKey(MAINNET_MULTISIG),
    "current"
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toBase58());

  const group = new PublicKey(MAINNET_GROUP);
  const mint = new PublicKey(config.bankMint);
  const kaminoReserve = new PublicKey(config.kaminoReserve);
  const kaminoMarket = new PublicKey(config.kaminoMarket);
  const oracle = new PublicKey(config.oracle);

  // 1. Check existing banks and select seed
  const seedResult = await getNextAvailableSeed(
    user.program,
    group,
    mint,
    kaminoReserve,
    config.seed ?? KAMINO_SEED_START
  );

  if (seedResult.isDuplicate) {
    console.error(
      `ERROR: Bank already exists for reserve ${kaminoReserve.toBase58()}`
    );
    process.exit(1);
  }
  console.log(
    `Existing banks: ${seedResult.existingBanks.length}, Selected seed: ${seedResult.seed}`
  );

  const finalSeed = config.seed ?? seedResult.seed;
  if (
    !(await verifySeedAvailable(
      user.connection,
      user.program.programId,
      group,
      mint,
      finalSeed
    ))
  ) {
    console.error(`ERROR: Seed ${finalSeed} already in use`);
    process.exit(1);
  }

  const [bankAddress] = deriveBankWithSeed(
    user.program.programId,
    group,
    mint,
    new BN(finalSeed)
  );
  console.log(`Bank address: ${bankAddress.toBase58()}`);

  // 2. Oracle validation (Switchboard only)
  let oracleReport;
  if (config.oracleType === "kaminoSwitchboardPull" && !skipOracleValidation) {
    console.log(`Validating Switchboard oracle (scraping page)...`);
    oracleReport = await validateOracle(
      user.connection,
      config.oracle,
      config.bankMint,
      config.oracleType,
      config.asset
    );

    // Log results
    console.log(
      `Ticker: ${oracleReport.tickerValidation?.actualTicker || "unknown"} - ${
        oracleReport.tickerValidation?.isValid ? "VALID" : "INVALID"
      }`
    );
    console.log(
      `Authority: ${oracleReport.switchboard.authority || "unknown"} - ${
        oracleReport.switchboard.authorityValid ? "VALID" : "INVALID"
      }`
    );
    if (oracleReport.priceComparison) {
      const pc = oracleReport.priceComparison;
      const status = pc.isWithinTolerance ? "VALID" : "INVALID";
      console.log(
        `Price: Switchboard $${pc.oraclePrice?.toFixed(
          2
        )} vs Jupiter $${pc.jupiterPrice?.toFixed(
          2
        )} (${pc.deviationPercent?.toFixed(2)}% diff, ${
          pc.tolerancePercent
        }% tolerance) - ${status}`
      );
    }

    // Fail if validation failed
    if (!oracleReport.overallValid) {
      console.error("\nERROR: Oracle validation failed:");
      for (const error of oracleReport.errors) {
        console.error(`  - ${error}`);
      }
      process.exit(1);
    }
  }

  // 3. Fetch and validate reserve
  const mintInfo = await getMint(user.connection, mint);
  const decimals = mintInfo.decimals;
  const tokenProgram =
    mintInfo.tlvData.length > 0
      ? new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
      : TOKEN_PROGRAM_ID;

  const reserveValidation = await fetchAndValidateReserve(
    user.kaminoProgram,
    kaminoReserve,
    kaminoMarket,
    mint
  );
  if (!reserveValidation.isValid) {
    console.error(
      "ERROR: Reserve validation failed:",
      reserveValidation.errors
    );
    process.exit(1);
  }
  console.log(`Reserve validation: PASSED (market + mint match)`);

  const { reserveData } = reserveValidation;

  // 4. Build bank config
  const bankConfig: KaminoConfigCompact = {
    oracle,
    assetWeightInit: bigNumberToWrappedI80F48(config.assetWeightInit),
    assetWeightMaint: bigNumberToWrappedI80F48(config.assetWeightMaint),
    depositLimit: new BN(config.depositLimit),
    oracleSetup: oracleTypeToRaw(config.oracleType),
    operationalState: { operational: {} },
    riskTier: { collateral: {} },
    configFlags: PYTH_PULL_MIGRATED,
    totalAssetValueInitLimit: new BN(config.totalAssetValueInitLimit),
    oracleMaxAge: config.oracleMaxAge,
    oracleMaxConfidence: config.oracleMaxConfidence,
  };

  // 5. Build instruction
  const multisig = new PublicKey(MAINNET_MULTISIG);
  const ix = await makeAddKaminoBankIx(
    user.program,
    {
      group,
      feePayer: multisig,
      bankMint: mint,
      kaminoReserve,
      kaminoMarket,
      oracle,
      tokenProgram,
      admin: multisig,
    },
    { seed: new BN(finalSeed), config: bankConfig }
  );

  // 6. Fetch LUT for smaller tx size
  let luts: AddressLookupTableAccount[] = [];
  const lutLookup = await user.connection.getAddressLookupTable(
    new PublicKey(MAINNET_LUT)
  );
  if (lutLookup.value) {
    luts = [lutLookup.value];
  } else {
    console.warn(
      `Warning: LUT ${MAINNET_LUT} not found, proceeding without it`
    );
  }

  const { blockhash } = await user.connection.getLatestBlockhash();

  // 7. Simulate with legacy tx (for log parsing)
  const legacyTx = new Transaction().add(ix);
  legacyTx.feePayer = multisig;
  legacyTx.recentBlockhash = blockhash;
  const simulation = await user.connection.simulateTransaction(legacyTx);
  const simValidation = validateSimulationParams(
    simulation.value.logs || [],
    config
  );

  console.log(
    `Simulation: ${simValidation.programSucceeded ? "SUCCESS" : "FAILED"} (${
      simulation.value.unitsConsumed
    } CU)`
  );
  if (simValidation.validations.length > 0) {
    console.log(formatSimulationValidation(simValidation));
  }

  if (!simValidation.success) {
    if (simulation.value.err) {
      console.error("Transaction error:", simulation.value.err);
    }
    if (!simValidation.allParamsMatch) {
      console.error("WARNING: Some parameters don't match config!");
    }
  }

  // 8. Build versioned tx with LUT for smaller size
  const v0Message = new TransactionMessage({
    payerKey: multisig,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message(luts);
  const v0Tx = new VersionedTransaction(v0Message);
  const serializedTx = v0Tx.serialize();
  const txSizeBytes = serializedTx.length;
  const base58Tx = bs58.encode(serializedTx);

  // 8. Update config with derived values
  config.derived = {
    bankAddress: bankAddress.toBase58(),
    reserveOracle: reserveData.scopeOracle.toBase58(),
    farmState: reserveData.farmCollateral.equals(PublicKey.default)
      ? null
      : reserveData.farmCollateral.toBase58(),
    tokenProgram: tokenProgram.toBase58(),
    decimals,
    seed: finalSeed,
  };
  fs.writeFileSync(resolvedPath, JSON.stringify(config, null, 2));

  // 9. Generate output file
  const outputData: BankOutputData = {
    config,
    seedResult,
    finalSeed,
    bankAddress,
    decimals,
    tokenProgram,
    reserveData,
    oracleReport,
    simulationSuccess: simValidation.success,
    simValidation,
    computeUnits: simulation.value.unitsConsumed,
    txSizeBytes,
    base58Tx,
  };
  const outputPath = resolvedPath.replace(".json", ".output.md");
  fs.writeFileSync(outputPath, generateMarkdownOutput(outputData));

  // 10. Output
  console.log(`\nConfig updated: ${resolvedPath}`);
  console.log(`Output file: ${outputPath}`);
  console.log(`\n--- Base58 Transaction (${txSizeBytes} bytes) ---\n`);
  console.log(base58Tx);
  console.log(`\n=== COMPLETE ===\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
