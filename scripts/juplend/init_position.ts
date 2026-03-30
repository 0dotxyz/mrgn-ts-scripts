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
import { deriveLiquidityVaultAuthority } from "../common/pdas";
import { commonSetup } from "../../lib/common-setup";
import { bs58 } from "@switchboard-xyz/common";

import { readFileSync } from "fs";
import { join } from "path";
import { deriveBankWithSeed } from "../common/pdas";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;

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
    FEE_PAYER: feePayer ? new PublicKey(feePayer) : undefined,
    MULTISIG_PAYER: multisigPayer
      ? new PublicKey(multisigPayer)
      : undefined,
  };
}

async function main() {
  const configFile = process.argv[2];
  const amountArg = process.argv[3];
  if (!configFile) {
    console.error(
      "Usage: tsx scripts/juplend/init_position.ts <config-file> [amount]",
    );
    console.error(
      "Example: tsx scripts/juplend/init_position.ts configs/stage/usdc.json 10000",
    );
    process.exit(1);
  }

  const config = parseInitConfig(configFile);
  if (amountArg) {
    config.INIT_DEPOSIT_AMOUNT = new BN(amountArg);
  }

  console.log("=== Init JupLend Position ===\n");
  console.log("Bank:", config.BANK.toString());
  console.log("Amount:", (config.INIT_DEPOSIT_AMOUNT ?? new BN(100)).toString());
  if (config.MULTISIG_PAYER) {
    console.log("Multisig:", config.MULTISIG_PAYER.toString());
  }
  console.log();

  await initJuplendPosition(sendTx, config, "/keys/staging-deploy.json");
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

  // Fetch bank to get mint and integration accounts
  const bankData = await program.account.bank.fetch(config.BANK);
  const mint = bankData.mint;
  const juplendLending = bankData.integrationAcc1;

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
  const [lendingAdmin] = findJuplendLendingAdminPda();
  const juplendAccounts = deriveJuplendCpiAccounts(mint, tokenProgram);

  // Fetch JupLend Lending account
  const lendingInfo = await connection.getAccountInfo(juplendLending);
  if (!lendingInfo) {
    throw new Error("JupLend Lending not found: " + juplendLending.toString());
  }
  const fTokenMint = new PublicKey(lendingInfo.data.slice(40, 72));
  const supplyTokenReservesLiquidity = new PublicKey(
    lendingInfo.data.slice(131, 163),
  );
  const lendingSupplyPositionOnLiquidity = new PublicKey(
    lendingInfo.data.slice(163, 195),
  );

  const signerTokenAccount = getAssociatedTokenAddressSync(
    mint,
    feePayer,
    false,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("Derived accounts:");
  console.log("  liquidityVaultAuthority:", liquidityVaultAuthority.toString());
  console.log("  lendingAdmin:", lendingAdmin.toString());
  console.log("  fTokenMint:", fTokenMint.toString());
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
      feePayer,
      signerTokenAccount,
      bank: config.BANK,
      lendingAdmin,
      supplyTokenReservesLiquidity,
      lendingSupplyPositionOnLiquidity,
      rateModel: juplendAccounts.rateModel,
      vault: juplendAccounts.vault,
      liquidity: juplendAccounts.liquidity,
      liquidityProgram: juplendAccounts.liquidityProgram,
      rewardsRateModel: juplendAccounts.rewardsRateModel,
      tokenProgram,
    })
    .accountsPartial({
      fTokenMint,
    })
    .instruction();

  transaction.add(initPositionIx);

  // Simulate + send
  transaction.feePayer = feePayer;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

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

  if (sendTx) {
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      wallet.payer,
    ]);
    console.log("Signature:", signature);
    console.log("Position initialized!");
  } else {
    transaction.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    console.log("bank:", config.BANK.toString());
    console.log("Base58-encoded transaction:", bs58.encode(serialized));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
