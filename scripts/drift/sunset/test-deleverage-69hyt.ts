/**
 * Test Drift sunset flow for account 69hytF6JSbVJpQGmQUwj5Bhjn18H5BM7GwsQ8aW6PTYd
 * on staging program 5UDghkpgW1HfYSrmEj2iAApHShqU44H6PKTAar9LL9bY
 *
 * Account positions:
 *   - Drift SOL deposit  (bank H2FT24R..., asset_tag=4, mint=SOL, oracle=DriftPythPull)
 *   - Kamino USDC deposit (bank 4iApZwb..., asset_tag=3, mint=USDC, oracle=KaminoPythPush)
 *   - P0 USDC borrow     (bank 2niLzLp..., asset_tag=0, mint=USDC, oracle=PythPushOracle)
 *
 * Steps (run one at a time by setting STEP):
 *   1. Deleverage: startDeleverage → tokenlessRepay → endDeleverage
 *   2. Force tokenless repay complete on Drift SOL bank
 *   3. Purge Drift SOL position
 *   4. Handle bankruptcy on P0 USDC bank (if needed)
 *
 * Based on the existing scripts/deleverage.ts pattern.
 *
 * Usage: tsx scripts/drift/sunset/test-deleverage-69hyt.ts
 */

import dotenv from "dotenv";
import {
  PublicKey,
  AccountMeta,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN, Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Marginfi as MarginfiCurrent } from "../../../idl/marginfi";
import marginfiIdlJson from "../../../idl/marginfi.json";
import {
  deriveLiquidityVault,
  deriveInsuranceVault,
  deriveInsuranceVaultAuthority,
  deriveLiquidationRecord,
} from "../../common/pdas";
import { loadEnvFile } from "../../utils";
import { loadKeypairFromFile } from "../../../lib/utils";

dotenv.config();

// ── Configuration ──────────────────────────────────────────────────
const STEP = 1; // 1=deleverage, 2=force complete, 3=purge, 4=bankruptcy
const DRY_RUN = true; // true=simulate only, false=send

const PROGRAM_ID = new PublicKey(
  "5UDghkpgW1HfYSrmEj2iAApHShqU44H6PKTAar9LL9bY",
);
const GROUP = new PublicKey(
  "ERBiJdWtnVBBd4gFm7YVHT3a776x5NbGbJBR5BDvsxtj",
);

// Target account
const ACCOUNT = new PublicKey(
  "69hytF6JSbVJpQGmQUwj5Bhjn18H5BM7GwsQ8aW6PTYd",
);

// Banks involved in this account
const DRIFT_SOL_BANK = new PublicKey(
  "H2FT24RksVSq6kxhfPZacyqbEaXUtRZNi1QvMGV9RrFX",
);
const KAMINO_USDC_BANK = new PublicKey(
  "4iApZwbuTCkxgeg67sQsvSAPxWdWkkT5XVgv3R29s6JU",
);
const P0_USDC_BANK = new PublicKey(
  "2niLzLpnYRh7Xf7YLzhX7rxfUn41T3FzPTEgPtAkyRiJ",
);

// Mints
const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
);

// Wallet path (risk_admin hot wallet)
const WALLET_PATH = "";
// ────────────────────────────────────────────────────────────────────

async function main() {
  loadEnvFile(".env.api");
  const apiUrl = process.env.API_URL || "https://api.mainnet-beta.solana.com";
  const { Connection } = await import("@solana/web3.js");
  const connection = new Connection(apiUrl, "confirmed");

  const wallet = new Wallet(
    loadKeypairFromFile(process.env.HOME + WALLET_PATH),
  );
  const provider = new AnchorProvider(connection, wallet, {
    preflightCommitment: "confirmed",
  });

  const idl = { ...marginfiIdlJson, address: PROGRAM_ID.toBase58() } as any;
  const program = new Program<MarginfiCurrent>(idl, provider);

  console.log(`=== Drift Sunset Test — Step ${STEP} ===`);
  console.log(`Program:  ${PROGRAM_ID.toBase58()}`);
  console.log(`Account:  ${ACCOUNT.toBase58()}`);
  console.log(`Wallet:   ${wallet.publicKey.toBase58()}`);
  console.log(`Dry run:  ${DRY_RUN}\n`);

  let instructions: TransactionInstruction[] = [];

  switch (STEP) {
    case 1:
      instructions = await buildDeleverageTx(
        program,
        connection,
        wallet,
      );
      break;
    case 2:
      instructions = await buildForceCompleteTx(program, wallet.publicKey);
      break;
    case 3:
      instructions = await buildPurgeTx(program, wallet.publicKey);
      break;
    case 4:
      instructions = await buildBankruptcyTx(program, wallet.publicKey);
      break;
    default:
      console.error("Invalid STEP:", STEP);
      process.exit(1);
  }

  instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  );

  await sendOrSimulate(connection, wallet, instructions);
}

// ────────────────────────────────────────────────────────────────────
// Step 1: Deleverage
//
// The account has 3 active balances. Each balance's bank has an oracle.
// startDeleverage and endDeleverage need ALL bank+oracle pairs as
// remaining accounts so the program can compute health.
//
// Flow:
//   1. Init liquidation record (if not exists) — separate tx
//   2. startDeleverage — with all bank+oracle remaining accounts
//   3. lendingAccountRepay — tokenless repay USDC borrow
//   4. endDeleverage — with remaining bank+oracle accounts (minus repaid bank)
// ────────────────────────────────────────────────────────────────────
async function buildDeleverageTx(
  program: Program<MarginfiCurrent>,
  connection: any,
  wallet: Wallet,
): Promise<TransactionInstruction[]> {
  console.log("Building TX 1: Deleverage\n");

  const riskAdmin = wallet.publicKey;
  const [liquidationRecord] = deriveLiquidationRecord(PROGRAM_ID, ACCOUNT);

  // Ensure liquidation record exists (needed by startDeleverage)
  // This is always sent regardless of DRY_RUN — it's idempotent and
  // required for the deleverage simulation to work.
  const liqRecordInfo = await connection.getAccountInfo(liquidationRecord);
  if (!liqRecordInfo) {
    console.log("  Creating liquidation record...");
    const initTx = new Transaction().add(
      await program.methods
        .marginfiAccountInitLiqRecord()
        .accounts({
          marginfiAccount: ACCOUNT,
          feePayer: riskAdmin,
        })
        .instruction(),
    );
    const sig = await sendAndConfirmTransaction(
      connection,
      initTx,
      [wallet.payer],
      { commitment: "confirmed" },
    );
    console.log("  Liquidation record created:", sig);
  } else {
    console.log("  Liquidation record exists");
  }

  // Fetch all 3 banks to get oracle configs
  const banks = await Promise.all([
    program.account.bank.fetch(DRIFT_SOL_BANK),
    program.account.bank.fetch(KAMINO_USDC_BANK),
    program.account.bank.fetch(P0_USDC_BANK),
  ]);
  const [driftSolBankData, kaminoUsdcBankData, p0UsdcBankData] = banks;

  // Build remaining accounts: [bank, oracle_key_0, oracle_key_1?, ...] per balance
  // The program needs these to compute health at start and end
  const allRemainingGroups = buildRemainingAccountGroups([
    { bankPk: DRIFT_SOL_BANK, bank: driftSolBankData },
    { bankPk: KAMINO_USDC_BANK, bank: kaminoUsdcBankData },
    { bankPk: P0_USDC_BANK, bank: p0UsdcBankData },
  ]);

  console.log("  Remaining account groups:");
  for (const group of allRemainingGroups) {
    console.log(
      "    bank=" + group[0].toBase58().slice(0, 12) + "...",
      "oracles=" + (group.length - 1),
    );
  }

  const startMeta = toAccountMetas(allRemainingGroups);

  // After repay, the P0 USDC bank balance is gone, so endDeleverage
  // doesn't need it in remaining accounts
  const endRemainingGroups = allRemainingGroups.filter(
    (g) => !g[0].equals(P0_USDC_BANK),
  );
  const endMeta = toAccountMetas(endRemainingGroups);

  // Build instructions
  const ixes: TransactionInstruction[] = [];

  // 1. startDeleverage
  console.log("\n  1. startDeleverage — enter receivership, snapshot health");
  ixes.push(
    await program.methods
      .startDeleverage()
      .accounts({
        marginfiAccount: ACCOUNT,
      })
      .remainingAccounts(startMeta)
      .instruction(),
  );

  // 2. tokenless repay USDC borrow
  console.log("  2. lendingAccountRepay — tokenless repay all USDC debt");
  const [liquidityVaultUsdc] = deriveLiquidityVault(PROGRAM_ID, P0_USDC_BANK);
  const signerUsdcAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    riskAdmin,
    true,
    TOKEN_PROGRAM_ID,
  );

  // Repay remaining accounts: all banks EXCEPT the one being repaid
  const repayRemainingGroups = allRemainingGroups.filter(
    (g) => !g[0].equals(P0_USDC_BANK),
  );
  const repayMeta = toAccountMetas(repayRemainingGroups);

  ixes.push(
    await program.methods
      .lendingAccountRepay(new BN(0), true)
      .accounts({
        marginfiAccount: ACCOUNT,
        bank: P0_USDC_BANK,
        signerTokenAccount: signerUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(repayMeta)
      .instruction(),
  );

  // 3. endDeleverage
  console.log("  3. endDeleverage — validate health, release account\n");
  ixes.push(
    await program.methods
      .endDeleverage()
      .accounts({
        marginfiAccount: ACCOUNT,
      })
      .remainingAccounts(endMeta)
      .instruction(),
  );

  return ixes;
}

/**
 * Build remaining account groups from bank data.
 * Each group is [bankPk, oracleKey0, oracleKey1?, oracleKey2?]
 * depending on the oracle setup type.
 */
function buildRemainingAccountGroups(
  bankEntries: { bankPk: PublicKey; bank: any }[],
): PublicKey[][] {
  const groups: PublicKey[][] = [];

  for (const { bankPk, bank } of bankEntries) {
    const setup = bank.config.oracleSetup;
    const keys = bank.config.oracleKeys;

    if (setup.fixed || setup.fixedDrift || setup.fixedKamino) {
      groups.push([bankPk]);
    } else if (setup.pythPushOracle || setup.switchboardPull) {
      groups.push([bankPk, keys[0]]);
    } else if (
      setup.kaminoPythPush ||
      setup.kaminoSwitchboardPull ||
      setup.driftPythPull ||
      setup.driftSwitchboardPull
    ) {
      groups.push([bankPk, keys[0], keys[1]]);
    } else if (setup.stakedWithPythPush) {
      groups.push([bankPk, keys[0], keys[1], keys[2]]);
    } else {
      // Fallback: just bank + first oracle key
      groups.push([bankPk, keys[0]]);
    }
  }

  return groups;
}

/**
 * Flatten remaining account groups into AccountMeta array.
 */
function toAccountMetas(groups: PublicKey[][]): AccountMeta[] {
  return groups.flat().map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));
}

// ────────────────────────────────────────────────────────────────────
// Step 2: Force Tokenless Repay Complete
// ────────────────────────────────────────────────────────────────────
async function buildForceCompleteTx(
  program: Program<MarginfiCurrent>,
  riskAdmin: PublicKey,
): Promise<TransactionInstruction[]> {
  console.log("Building TX 2: Force Tokenless Repay Complete\n");

  return [
    await program.methods
      .lendingPoolForceTokenlessRepayComplete()
      .accounts({
        group: GROUP,
        riskAdmin,
        bank: DRIFT_SOL_BANK,
      })
      .instruction(),
  ];
}

// ────────────────────────────────────────────────────────────────────
// Step 3: Purge Drift Position
// ────────────────────────────────────────────────────────────────────
async function buildPurgeTx(
  program: Program<MarginfiCurrent>,
  riskAdmin: PublicKey,
): Promise<TransactionInstruction[]> {
  console.log("Building TX 3: Purge Drift Position\n");

  return [
    await program.methods
      .purgeDeleverageBalance()
      .accounts({
        group: GROUP,
        marginfiAccount: ACCOUNT,
        riskAdmin,
        bank: DRIFT_SOL_BANK,
      })
      .instruction(),
  ];
}

// ────────────────────────────────────────────────────────────────────
// Step 4: Handle Bankruptcy
// ────────────────────────────────────────────────────────────────────
async function buildBankruptcyTx(
  program: Program<MarginfiCurrent>,
  riskAdmin: PublicKey,
): Promise<TransactionInstruction[]> {
  console.log("Building TX 4: Handle Bankruptcy\n");

  const [liquidityVault] = deriveLiquidityVault(PROGRAM_ID, P0_USDC_BANK);
  const [insuranceVault] = deriveInsuranceVault(PROGRAM_ID, P0_USDC_BANK);
  const [insuranceVaultAuth] = deriveInsuranceVaultAuthority(
    PROGRAM_ID,
    P0_USDC_BANK,
  );

  return [
    await program.methods
      .lendingPoolHandleBankruptcy()
      .accounts({
        group: GROUP,
        signer: riskAdmin,
        bank: P0_USDC_BANK,
        marginfiAccount: ACCOUNT,
        liquidityVault,
        insuranceVault,
        insuranceVaultAuthority: insuranceVaultAuth,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  ];
}

// ────────────────────────────────────────────────────────────────────
// Send or simulate
// ────────────────────────────────────────────────────────────────────
async function sendOrSimulate(
  connection: any,
  wallet: Wallet,
  instructions: TransactionInstruction[],
) {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const v0Message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([]);

  const v0Tx = new VersionedTransaction(v0Message);

  console.log(`Transaction: ${instructions.length} instructions`);
  console.log(`Serialized size: ${v0Tx.serialize().length} bytes\n`);

  if (DRY_RUN) {
    v0Tx.sign([wallet.payer]);
    const sim = await connection.simulateTransaction(v0Tx);
    if (sim.value.err) {
      console.error("Simulation FAILED:", JSON.stringify(sim.value.err));
      console.error("\nLogs:");
      sim.value.logs?.forEach((l: string) => console.error("  " + l));
    } else {
      console.log("Simulation OK");
      console.log("Compute units:", sim.value.unitsConsumed);
    }
  } else {
    v0Tx.sign([wallet.payer]);
    const sig = await connection.sendTransaction(v0Tx, { maxRetries: 2 });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log("Signature:", sig);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
