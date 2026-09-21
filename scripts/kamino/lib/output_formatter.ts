import { PublicKey } from "@solana/web3.js";
import { KaminoBankConfig } from "./config_types";
import { SeedSelectionResult } from "./seed_manager";
import { ReserveData } from "./reserve_utils";
import { SimulationValidationResult } from "./simulation_validator";

/**
 * Collected data for output generation
 */
export interface BankOutputData {
  config: KaminoBankConfig;
  seedResult: SeedSelectionResult;
  finalSeed: number;
  bankAddress: PublicKey;
  decimals: number;
  tokenProgram: PublicKey;
  reserveData: ReserveData;
  simulationSuccess: boolean;
  simValidation?: SimulationValidationResult;
  computeUnits?: number;
  txSizeBytes?: number;
  base58Tx: string;
}

/**
 * Log a section header to console
 */
export function logSection(title: string): void {
  console.log(`--- ${title} ---`);
}

/**
 * Log seed selection results to console
 */
export function logSeedSelection(
  seedResult: SeedSelectionResult,
  finalSeed: number,
  bankAddress: PublicKey,
  assetName: string
): void {
  logSection("Existing Banks & Seed Selection");

  if (seedResult.existingBanks.length === 0) {
    console.log(`No existing Kamino banks found for ${assetName}`);
  } else {
    console.log(`Existing Kamino banks for ${assetName}:`);
    for (const bank of seedResult.existingBanks) {
      console.log(`  - Seed ${bank.seed}: ${bank.bankAddress.toBase58()}`);
    }
  }

  if (seedResult.isDuplicate) {
    console.log(`\nDuplicate reserve detected: ${seedResult.duplicateBank!.bankAddress.toBase58()}`);
  } else {
    console.log(`\nNo existing bank for this reserve`);
  }

  console.log(`Selected seed: ${finalSeed}`);
  console.log(`Bank address: ${bankAddress.toBase58()}`);
  console.log("");
}

/**
 * Log reserve validation results to console
 */
export function logReserveValidation(
  reserveData: ReserveData,
  decimals: number,
  isToken2022: boolean
): void {
  console.log("Reserve market verification: PASSED");
  console.log("Reserve mint verification: PASSED");
  console.log(`Mint decimals: ${decimals}`);
  console.log(`Token program: ${isToken2022 ? "Token-2022" : "Token Program"}`);
  console.log(`Scope Oracle: ${reserveData.scopeOracle.toBase58()}`);
  const hasFarm = !reserveData.farmCollateral.equals(PublicKey.default);
  console.log(`Farm State: ${hasFarm ? reserveData.farmCollateral.toBase58() : "None"}`);
  console.log("");
}

/**
 * Log bank config to console
 */
export function logBankConfig(config: KaminoBankConfig): void {
  logSection("Bank Configuration");
  console.log(`Asset Weight Init: ${config.assetWeightInit}`);
  console.log(`Asset Weight Maint: ${config.assetWeightMaint}`);
  console.log(`Deposit Limit: ${config.depositLimit}`);
  console.log(`Total Asset Value Init Limit: ${config.totalAssetValueInitLimit}`);
  console.log("");
}

/**
 * Log simulation results to console
 */
export function logSimulation(success: boolean, computeUnits?: number, error?: any): void {
  logSection("Transaction Simulation");
  if (success) {
    console.log(`Simulation successful (${computeUnits} CU)`);
  } else {
    console.log("Simulation FAILED");
    if (error) console.error(error);
  }
  console.log("");
}

/**
 * Generate markdown output file content
 */
export function generateMarkdownOutput(data: BankOutputData): string {
  const lines: string[] = [];
  const { config, seedResult, finalSeed, bankAddress, decimals, tokenProgram, reserveData } = data;
  const isToken2022 = !tokenProgram.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
  const hasFarm = !reserveData.farmCollateral.equals(PublicKey.default);

  // Header
  lines.push(`# ${config.asset} Kamino Bank - ${config.market} Market`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  // Existing banks
  lines.push("## Existing Banks");
  lines.push("");
  if (seedResult.existingBanks.length === 0) {
    lines.push(`No existing Kamino banks found for ${config.asset}`);
  } else {
    lines.push(`| Seed | Bank Address | Reserve |`);
    lines.push(`|------|--------------|---------|`);
    for (const bank of seedResult.existingBanks) {
      lines.push(
        `| ${bank.seed} | [${bank.bankAddress.toBase58().slice(0, 8)}...](https://solscan.io/account/${bank.bankAddress.toBase58()}) | ${bank.kaminoReserve.toBase58().slice(0, 8)}... |`
      );
    }
  }
  lines.push("");

  // Seed selection
  lines.push("## Seed Selection");
  lines.push("");
  lines.push(`- Selected Seed: **${finalSeed}**`);
  lines.push(`- Bank Address: \`${bankAddress.toBase58()}\``);
  lines.push(`- [View on Solscan](https://solscan.io/account/${bankAddress.toBase58()})`);
  lines.push("");

  // On-chain data
  lines.push("## On-Chain Data & Verification");
  lines.push("");
  lines.push("**Reserve Verification:** PASSED");
  lines.push("");
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Mint | \`${config.bankMint}\` |`);
  lines.push(`| Decimals | ${decimals} |`);
  lines.push(`| Token Program | ${isToken2022 ? "Token-2022" : "Token Program"} |`);
  lines.push(`| Kamino Reserve | \`${config.kaminoReserve}\` |`);
  lines.push(`| Kamino Market | \`${config.kaminoMarket}\` |`);
  lines.push(`| Scope Oracle | \`${reserveData.scopeOracle.toBase58()}\` |`);
  lines.push(`| Farm State | ${hasFarm ? `\`${reserveData.farmCollateral.toBase58()}\`` : "None"} |`);
  lines.push("");

  // Bank config
  lines.push("## Bank Configuration");
  lines.push("");
  lines.push(`| Parameter | Value |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| Asset Weight Init | ${config.assetWeightInit} |`);
  lines.push(`| Asset Weight Maint | ${config.assetWeightMaint} |`);
  lines.push(`| Deposit Limit | ${config.depositLimit} ${config.comments?.depositLimitHuman ? `(${config.comments.depositLimitHuman})` : ""} |`);
  lines.push(`| Total Asset Value Init Limit | ${config.totalAssetValueInitLimit} ${config.comments?.totalAssetValueHuman ? `(${config.comments.totalAssetValueHuman})` : ""} |`);
  lines.push(`| Oracle | \`${config.oracle}\` |`);
  lines.push(`| Oracle Type | ${config.oracleType} |`);
  lines.push("");

  // Simulation
  lines.push("## Simulation Results");
  lines.push("");
  lines.push(`**Status:** ${data.simulationSuccess ? "SUCCESS" : "FAILED"}`);
  if (data.computeUnits) {
    lines.push(`- Compute Units: ${data.computeUnits}`);
  }
  if (data.simValidation) {
    lines.push(`- Instruction Found: ${data.simValidation.instructionFound ? "YES" : "NO"}`);
    lines.push(`- Program Succeeded: ${data.simValidation.programSucceeded ? "YES" : "NO"}`);
    lines.push(`- All Parameters Match: ${data.simValidation.allParamsMatch ? "YES" : "NO"}`);
    if (data.simValidation.validations.length > 0) {
      lines.push("");
      lines.push("**Parameter Validation:**");
      lines.push("");
      lines.push("| Parameter | Expected | Actual | Status |");
      lines.push("|-----------|----------|--------|--------|");
      for (const v of data.simValidation.validations) {
        const status = v.match ? "✓" : "✗";
        lines.push(`| ${v.param} | ${v.expected} | ${v.actual} | ${status} |`);
      }
    }
  }
  lines.push("");

  // Base58 tx
  lines.push("## Base58 Transaction");
  lines.push("");
  if (data.txSizeBytes) {
    lines.push(`**Size:** ${data.txSizeBytes} bytes (max 1232)`);
    lines.push("");
  }
  lines.push("```");
  lines.push(data.base58Tx);
  lines.push("```");
  lines.push("");

  // Derived values
  lines.push("## Derived Values");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(config.derived, null, 2));
  lines.push("```");
  lines.push("");

  // Next steps
  lines.push("## Next Steps");
  lines.push("");
  lines.push("1. Submit base58 transaction to Squads multisig");
  lines.push("2. Get approvals and execute");
  lines.push("3. After confirmation, run init_obligation_from_config.ts");
  lines.push("");

  return lines.join("\n");
}
