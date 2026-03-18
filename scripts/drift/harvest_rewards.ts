import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  AccountMeta,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  deriveDriftStatePDA,
  deriveSpotMarketVaultPDA,
  deriveDriftSignerPDA,
  DRIFT_PROGRAM_ID,
  deriveSpotMarketPDA,
} from "./lib/utils";
import { commonSetup, registerDriftProgram } from "../../lib/common-setup";
import { bs58 } from "@switchboard-xyz/common";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  ACCOUNT: PublicKey;
  AMOUNT: BN;

  DRIFT_MARKET_INDEX: number;

  /** Oracle address the Drift User uses. Can be read from bank.integrationAcc1 */
  DRIFT_ORACLE: PublicKey;

  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  BANK: new PublicKey("8qPLKaKb4F5BC6mVncKAryMp78yp5ZRGYnPkQbt9ikKt"),
  ACCOUNT: new PublicKey("89ViS63BocuvZx5NE5oS9tBJ4ZbKZe3GkvurxHuSqFhz"),
  AMOUNT: new BN(1 * 10 ** 5), // 0.1 USDC
  DRIFT_MARKET_INDEX: 0, // USDC
  DRIFT_ORACLE: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
};

/**
 * Drift Harvest Rewards Script
 *
 * Harvests accumulated rewards from admin deposits (positions 2-7).
 * Only relevant when 2+ admin deposits are active in drift user.
 */

async function main() {
  await harvestDriftRewards(sendTx, config, "/keys/staging-deploy.json");
}

export async function harvestDriftRewards(
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
  registerDriftProgram(user, DRIFT_PROGRAM_ID.toString());
  const connection = user.connection;
  const wallet = user.wallet;
  const program = user.program;

  const bank = await program.account.bank.fetch(config.BANK);
  const mint = bank.mint;

  console.log("=== Drift Harvest Rewards ===\n");
  console.log("Bank:", config.BANK.toString());
  console.log();

  const [driftState] = deriveDriftStatePDA();
  const [driftSigner] = deriveDriftSignerPDA();

  console.log("Derived Accounts:");
  console.log("  Bank:", bank.toString());
  console.log("  Drift State:", driftState.toString());
  console.log();

  // Fetch bank to get drift user
  console.log("Fetching bank and drift user to check for rewards...");
  const driftUser = await user.driftProgram.account.user.fetch(
    bank.integrationAcc2,
  );

  // Check active positions for rewards (positions 2-7)
  console.log("Drift user positions:");
  const rewardPositions: number[] = [];
  for (let i = 0; i < driftUser.spotPositions.length; i++) {
    const pos = driftUser.spotPositions[i];
    const scaledBalance = new BN(pos.scaledBalance.toString());
    if (i >= 2 && i <= 7 && !scaledBalance.isZero()) {
      console.log(
        `  Position ${i}: Market ${pos.marketIndex}, Balance: ${scaledBalance.toString()}`,
      );
      rewardPositions.push(i);
    }
  }

  if (rewardPositions.length === 0) {
    console.log("\nNo reward positions found (positions 2-7 are empty).");
    console.log("Rewards only accumulate when 2+ admin deposits are active.");
    process.exit(0);
  }

  console.log(
    `\nFound ${rewardPositions.length} reward position(s) to harvest`,
  );
  console.log();

  // For now, harvest the first reward position
  // In practice, you might want to harvest all or let user choose
  const rewardPosIndex = rewardPositions[0];
  const rewardPos = driftUser.spotPositions[rewardPosIndex];

  console.log(
    `Harvesting reward from position ${rewardPosIndex} (market ${rewardPos.marketIndex})...`,
  );

  // Derive the harvest spot market PDA
  const [harvestDriftSpotMarket] = deriveSpotMarketPDA(rewardPos.marketIndex);
  const [harvestDriftSpotMarketVault] = deriveSpotMarketVaultPDA(
    rewardPos.marketIndex,
  );

  // Fetch the harvest spot market to get the mint
  const harvestSpotMarket = await user.driftProgram.account.spotMarket.fetch(
    harvestDriftSpotMarket,
  );
  const rewardMint = harvestSpotMarket.mint;

  console.log("  Harvest Spot Market:", harvestDriftSpotMarket.toString());
  console.log("  Reward Mint:", rewardMint.toString());
  console.log();

  // Fetch fee state to get global fee wallet
  const [feeState] = PublicKey.findProgramAddressSync(
    [Buffer.from("feeState")],
    program.programId,
  );

  const feeStateData = await program.account.feeState.fetch(feeState);
  const globalFeeWallet = feeStateData.globalFeeWallet;

  // Derive the destination token account (ATA of fee wallet for reward mint)
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    rewardMint,
    globalFeeWallet,
    true, // allowOwnerOffCurve
  );

  console.log("  Global Fee Wallet:", globalFeeWallet.toString());
  console.log(
    "  Destination Token Account:",
    destinationTokenAccount.toString(),
  );
  console.log();

  // Build remaining accounts for drift (similar pattern to withdraw)
  // This should include oracle and spot market for the harvest asset
  const remainingAccounts: AccountMeta[] = [];

  // Build instruction
  const ix = await program.methods
    .driftHarvestReward()
    .accounts({
      bank: config.BANK,
      driftState,
      harvestDriftSpotMarket,
      harvestDriftSpotMarketVault,
      driftSigner,
      rewardMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .accountsPartial({
      destinationTokenAccount,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  const transaction = new Transaction().add(ix);

  // Simulate
  transaction.feePayer = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  console.log("Simulating driftHarvestReward...");
  const simulation = await connection.simulateTransaction(transaction);

  console.log("\nProgram Logs:");
  simulation.value.logs?.forEach((log) => console.log("  " + log));

  if (simulation.value.err) {
    console.log("\nSimulation failed:");
    console.log(JSON.stringify(simulation.value.err, null, 2));
    process.exit(1);
  }

  console.log("\nSimulation successful!");
  console.log("Compute units:", simulation.value.unitsConsumed);
  console.log();

  if (sendTx) {
    try {
      console.log("Executing transaction...");
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet.payer],
      );

      console.log("✓ Rewards harvested successfully!");
      console.log("Signature:", signature);
      console.log("Rewards sent to:", destinationTokenAccount.toString());
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
    console.log("deposit to: " + config.BANK);
    console.log("by account: " + config.ACCOUNT);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
