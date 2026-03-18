import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { deriveDriftStatePDA, deriveSpotMarketVaultPDA } from "./lib/utils";
import { commonSetup } from "../../lib/common-setup";
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

async function main() {
  await depositDrift(sendTx, config, "/keys/staging-deploy.json");
}

export async function depositDrift(
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

  const bank = await program.account.bank.fetch(config.BANK);
  const mint = bank.mint;

  console.log("=== Drift Deposit ===\n");
  console.log("Bank:", config.BANK.toString());
  console.log("Amount:", config.AMOUNT.toString(), "base units");
  console.log();

  const [driftState] = deriveDriftStatePDA();
  const [driftSpotMarketVault] = deriveSpotMarketVaultPDA(
    config.DRIFT_MARKET_INDEX,
  );

  // Detect token program
  let tokenProgram = TOKEN_PROGRAM_ID;
  try {
    await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    tokenProgram = TOKEN_2022_PROGRAM_ID;
    console.log("Detected Token-2022 mint");
  } catch {
    console.log("Detected SPL Token mint");
  }

  const signerTokenAccount = getAssociatedTokenAddressSync(
    mint,
    wallet.publicKey,
    false,
    tokenProgram,
  );

  // Create transaction with ATA creation
  const transaction = new Transaction();

  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      signerTokenAccount,
      wallet.publicKey,
      mint,
      tokenProgram,
    ),
  );

  const depositIx = await program.methods
    .driftDeposit(config.AMOUNT)
    .accounts({
      marginfiAccount: config.ACCOUNT,
      bank: config.BANK,
      signerTokenAccount: signerTokenAccount,
      driftState,
      driftSpotMarketVault,
      driftOracle: config.DRIFT_ORACLE,
      tokenProgram: tokenProgram,
    })
    .instruction();

  transaction.add(depositIx);

  // Simulate
  transaction.feePayer = wallet.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  console.log("Simulating driftDeposit...");
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
      console.log("Signature:", signature);
      console.log("✓ Deposit successful!");
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
