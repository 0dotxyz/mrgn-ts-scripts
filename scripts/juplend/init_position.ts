import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  deriveJuplendCpiAccounts,
  findJuplendLendingAdminPda,
} from "./lib/utils";
import {
  deriveJuplendFTokenVault,
  deriveLiquidityVault,
  deriveLiquidityVaultAuthority,
} from "../common/pdas";
import { commonSetup } from "../../lib/common-setup";
import { bs58 } from "@switchboard-xyz/common";

import { readFileSync } from "fs";
import { join } from "path";
import { deriveBankWithSeed } from "../common/pdas";

const DEFAULT_WALLET_PATH = "/.keys/staging-deploy.json";

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  BANK_MINT: PublicKey;
  JUPLEND_LENDING?: PublicKey;
  F_TOKEN_MINT?: PublicKey;

  /** Pays flat sol fee to init and rent (generally the MS on mainnet) */
  FEE_PAYER?: PublicKey; // If omitted, defaults to wallet.pubkey
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads

  INIT_DEPOSIT_AMOUNT?: BN; // Default: 100
};

function parseInitConfig(configFile: string): Config {
  const configPath = join(__dirname, configFile);
  const json = JSON.parse(readFileSync(configPath, "utf8"));

  const programId = json.programId;
  const group = new PublicKey(json.group);
  const bankMint = new PublicKey(json.bankMint);
  const juplendLending = json.juplendLending
    ? new PublicKey(json.juplendLending)
    : undefined;
  const fTokenMint = json.fTokenMint ? new PublicKey(json.fTokenMint) : undefined;
  const seed = new BN(json.seed);
  const [bank] = deriveBankWithSeed(
    new PublicKey(programId),
    group,
    bankMint,
    seed,
  );

  const feePayer = json.feePayer ?? json.multisigPayer;
  const multisigPayer = json.multisigPayer;

  return {
    PROGRAM_ID: programId,
    BANK: bank,
    BANK_MINT: bankMint,
    JUPLEND_LENDING: juplendLending,
    F_TOKEN_MINT: fTokenMint,
    FEE_PAYER: feePayer ? new PublicKey(feePayer) : undefined,
    MULTISIG_PAYER: multisigPayer ? new PublicKey(multisigPayer) : undefined,
  };
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

  const configFile = positional[0];
  const amount = positional[1];

  if (!configFile) {
    console.error(
      "Usage: tsx scripts/juplend/init_position.ts <config-file> [amount] [--send] [--wallet=<path>]",
    );
    console.error(
      "Example: tsx scripts/juplend/init_position.ts configs/stage/usdc.json 10000 --send",
    );
    process.exit(1);
  }

  return { configFile, amount, sendTx, walletPath };
}

async function main() {
  const { configFile, amount, sendTx, walletPath } = parseArgs();

  const config = parseInitConfig(configFile);
  if (amount) {
    config.INIT_DEPOSIT_AMOUNT = new BN(amount);
  }

  console.log("=== Init JupLend Position ===\n");
  console.log("Bank:", config.BANK.toString());
  console.log("Bank Mint:", config.BANK_MINT.toString());
  console.log(
    "Amount:",
    (config.INIT_DEPOSIT_AMOUNT ?? new BN(100)).toString(),
  );
  console.log("Send:", sendTx);
  if (config.MULTISIG_PAYER) {
    console.log("Multisig:", config.MULTISIG_PAYER.toString());
  }
  console.log();

  await initJuplendPosition(sendTx, config, walletPath);
}

export async function initJuplendPosition(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;
  const wallet = user.wallet;
  const program = user.program;

  const feePayer = config.FEE_PAYER ?? wallet.publicKey;
  let mint = config.BANK_MINT;
  let juplendLending = config.JUPLEND_LENDING;
  let fTokenMint = config.F_TOKEN_MINT;
  let onChainIntegrationAcc2: PublicKey | undefined;

  // If bank exists on-chain, prefer canonical values from bank state.
  try {
    const bankData = await program.account.bank.fetch(config.BANK);
    mint = bankData.mint;
    juplendLending = bankData.integrationAcc1;
    onChainIntegrationAcc2 = bankData.integrationAcc2;
  } catch {
    // bank may not exist yet; this is expected for pre-init bs58 generation
  }

  // Detect token program
  let tokenProgram = TOKEN_PROGRAM_ID;
  try {
    await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    tokenProgram = TOKEN_2022_PROGRAM_ID;
    console.log("Detected Token-2022 mint");
  } catch {
    console.log("Detected SPL Token mint");
  }

  // Derive accounts
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    config.BANK,
  );
  const [liquidityVault] = deriveLiquidityVault(program.programId, config.BANK);
  const [derivedIntegrationAcc2] = deriveJuplendFTokenVault(
    program.programId,
    config.BANK,
  );
  const [lendingAdmin] = findJuplendLendingAdminPda();
  const juplendAccounts = deriveJuplendCpiAccounts(mint, tokenProgram);
  juplendLending = juplendLending ?? juplendAccounts.lending;
  fTokenMint = fTokenMint ?? juplendAccounts.fTokenMint;
  const supplyTokenReservesLiquidity = juplendAccounts.tokenReserve;
  const lendingSupplyPositionOnLiquidity = juplendAccounts.supplyPosition;
  let integrationAcc2 = derivedIntegrationAcc2;
  if (onChainIntegrationAcc2) {
    if (!onChainIntegrationAcc2.equals(integrationAcc2)) {
      console.log(
        "Warning: on-chain integrationAcc2 differs from derived PDA; using on-chain value.",
      );
    }
    integrationAcc2 = onChainIntegrationAcc2;
  }

  const signerTokenAccount = getAssociatedTokenAddressSync(
    mint,
    feePayer,
    true,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("Derived accounts:");
  console.log("  juplendLending:", juplendLending.toString());
  console.log("  liquidityVault:", liquidityVault.toString());
  console.log("  liquidityVaultAuthority:", liquidityVaultAuthority.toString());
  console.log("  lendingAdmin:", lendingAdmin.toString());
  console.log("  fTokenMint:", fTokenMint.toString());
  console.log("  integrationAcc2 (fToken vault):", integrationAcc2.toString());
  console.log(
    "  supplyTokenReserves:",
    supplyTokenReservesLiquidity.toString(),
  );
  console.log("  supplyPosition:", lendingSupplyPositionOnLiquidity.toString());
  console.log();

  const transaction = new Transaction();

  const amount = config.INIT_DEPOSIT_AMOUNT ?? new BN(100);

  // Handle WSOL wrapping if needed
  const isWsol = mint.equals(NATIVE_MINT);
  if (isWsol) {
    const ataInfo = await connection.getAccountInfo(signerTokenAccount);
    if (!ataInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          feePayer,
          signerTokenAccount,
          feePayer,
          mint,
          tokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }
    console.log(`Wrapping ${amount.toString()} lamports as WSOL...`);
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: signerTokenAccount,
        lamports: amount.toNumber(),
      }),
    );
    transaction.add(
      createSyncNativeInstruction(signerTokenAccount, tokenProgram),
    );
  }

  // Create withdraw intermediary ATA (integration_acc_3)
  // This ATA is owned by liquidityVaultAuthority and is
  // required for juplend_withdraw to work.
  const withdrawIntermediaryAta = getAssociatedTokenAddressSync(
    mint,
    liquidityVaultAuthority,
    true,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      feePayer,
      withdrawIntermediaryAta,
      liquidityVaultAuthority,
      mint,
      tokenProgram,
    ),
  );
  console.log("  withdrawIntermediaryAta:", withdrawIntermediaryAta.toString());
  console.log();

  const initPositionIx = await program.methods
    .juplendInitPosition(amount)
    .accounts({
      feePayer: feePayer,
      signerTokenAccount: signerTokenAccount,
      bank: config.BANK,
      rewardsRateModel: juplendAccounts.rewardsRateModel,
      tokenProgram: tokenProgram,
      vault: juplendAccounts.vault,
      lendingAdmin: lendingAdmin,
      supplyTokenReservesLiquidity: supplyTokenReservesLiquidity,
      lendingSupplyPositionOnLiquidity: lendingSupplyPositionOnLiquidity,
      rateModel: juplendAccounts.rateModel,
      liquidity: juplendAccounts.liquidity,
      liquidityProgram: juplendAccounts.liquidityProgram
    })
    .accountsPartial({
      // bank: config.BANK,
      liquidityVault,
      mint,
      integrationAcc1: juplendLending,
      integrationAcc2,
      fTokenMint,
    })
    .instruction();

  transaction.add(initPositionIx);

  // Simulate + send
  transaction.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  if (sendTx) {
    console.log("Simulating juplendInitPosition...");
    const simulation = await connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      console.log("\nProgram Logs:");
      simulation.value.logs?.forEach((log) => console.log("  " + log));
      console.log("\nSimulation failed:");
      console.log(JSON.stringify(simulation.value.err, null, 2));
      process.exit(1);
    }

    console.log("\nSimulation successful!");
    console.log("Compute units:", simulation.value.unitsConsumed);
    console.log();
  } else {
    console.log(
      "Skipping simulation in unsigned mode; transaction can be generated before bank exists.",
    );
    console.log();
  }

  if (sendTx) {
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      wallet.payer,
    ]);
    console.log("Signature:", signature);
    console.log("Position initialized!");
  } else {
    const lutKeys = [
      signerTokenAccount,
      juplendLending,
      liquidityVault,
      liquidityVaultAuthority,
      lendingAdmin,
      fTokenMint,
      integrationAcc2,
      supplyTokenReservesLiquidity,
      lendingSupplyPositionOnLiquidity,
      withdrawIntermediaryAta,
      config.BANK, // keep bank last for copy/paste ergonomics
    ];
    const uniqueLutKeys = Array.from(
      new Map(lutKeys.map((key) => [key.toString(), key])).values(),
    );

    transaction.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    console.log("bank:", config.BANK.toString());
    console.log("LUT keys (paste into update_lut.ts):");
    uniqueLutKeys.forEach((key) =>
      console.log(`    new PublicKey("${key.toString()}"),`),
    );
    console.log();
    console.log("Base58-encoded transaction:", bs58.encode(serialized));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
