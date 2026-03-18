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
import {
  deriveJuplendCpiAccounts,
  findJuplendLendingAdminPda,
} from "./lib/utils";
import { commonSetup } from "../../lib/common-setup";
import { bs58 } from "@switchboard-xyz/common";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  ACCOUNT: PublicKey;
  AMOUNT: BN;

  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  BANK: new PublicKey("8qPLKaKb4F5BC6mVncKAryMp78yp5ZRGYnPkQbt9ikKt"),
  ACCOUNT: new PublicKey("89ViS63BocuvZx5NE5oS9tBJ4ZbKZe3GkvurxHuSqFhz"),
  AMOUNT: new BN(1 * 10 ** 5), // 0.1 USDC
};

async function main() {
  await depositJuplend(sendTx, config, "/keys/staging-deploy.json");
}

export async function depositJuplend(
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

  const payerKey = sendTx ? wallet.publicKey : config.MULTISIG_PAYER;

  if (!payerKey) {
    throw new Error("MULTISIG_PAYER must be set when sendTx = false");
  }

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

  // Derive JupLend CPI accounts
  const [lendingAdmin] = findJuplendLendingAdminPda();
  const juplendAccounts = deriveJuplendCpiAccounts(mint, tokenProgram);

  // Fetch Lending account
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
    payerKey,
    false,
    tokenProgram,
  );

  const transaction = new Transaction();

  // Create ATA idempotently
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payerKey,
      signerTokenAccount,
      payerKey,
      mint,
      tokenProgram,
    ),
  );

  const depositIx = await program.methods
    .juplendDeposit(config.AMOUNT)
    .accounts({
      marginfiAccount: config.ACCOUNT,
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

  transaction.add(depositIx);

  // Simulate
  transaction.feePayer = payerKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  console.log("Simulating juplendDeposit...");
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
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      wallet.payer,
    ]);
    console.log("Signature:", signature);
    console.log("Deposit successful!");
  } else {
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    console.log("deposit to:", config.BANK.toString());
    console.log("by account:", config.ACCOUNT.toString());
    console.log("Base58-encoded transaction:", bs58.encode(serialized));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
