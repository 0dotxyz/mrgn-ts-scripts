import {
  AccountMeta,
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
  findJuplendClaimAccountPda,
} from "./lib/utils";
import { deriveLiquidityVaultAuthority } from "../common/pdas";
import { commonSetup } from "../../lib/common-setup";
import { bs58 } from "@switchboard-xyz/common";
import { BankAndOracles } from "../../lib/utils";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  ACCOUNT: PublicKey;
  AMOUNT: BN;
  WITHDRAW_ALL: boolean;

  LUT: PublicKey;
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
  NEW_REMAINING: BankAndOracles;
  ADD_COMPUTE_UNITS: boolean;

  // Necessary if the user has Kamino positions and the health would not be good without accounting for them
  KAMINO_RESERVE?: PublicKey;
  KAMINO_MARKET?: PublicKey;
  KAMINO_ORACLE?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  BANK: new PublicKey("Ay8kyX7q2G9Yp3T6Nt8Z3p8xcMeaC19xLQjmGjTX2niq"),
  ACCOUNT: new PublicKey("FvRj5WiHZh6mU9TSsgAeJinDeSAkBmPvbJHJCqXAxCsH"),
  AMOUNT: new BN(40 * 10 ** 6), // 40 USDC
  WITHDRAW_ALL: true,

  LUT: new PublicKey("FtQ5uKQvFoKQ27SWY15tgBeJQnGKmKGzWqDz7kGUbeiq"),

  NEW_REMAINING: [
    new PublicKey("CVjHEnJWKELsbFt37znC2nq4KNrwTf7w42fcfySEifNu"),
    new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"),
  ],
  ADD_COMPUTE_UNITS: true,
};

async function main() {
  await withdrawJuplend(sendTx, config, "/keys/staging-deploy.json");
}

export async function withdrawJuplend(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  version?: "current",
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
    version,
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

  // Derive claim account PDA
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    config.BANK,
  );
  const [claimAccount] = findJuplendClaimAccountPda(
    liquidityVaultAuthority,
    mint,
  );

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

  const oracleMeta: AccountMeta[] = config.NEW_REMAINING.flat().map(
    (pubkey) => {
      return { pubkey, isSigner: false, isWritable: false };
    },
  );

  const destinationTokenAccount = getAssociatedTokenAddressSync(
    mint,
    payerKey,
    false,
    tokenProgram,
  );

  const transaction = new Transaction();

  // // Create destination ATA idempotently
  // transaction.add(
  //   createAssociatedTokenAccountIdempotentInstruction(
  //     payerKey,
  //     destinationTokenAccount,
  //     payerKey,
  //     mint,
  //     tokenProgram,
  //   ),
  // );

  const withdrawIx = await program.methods
    .juplendWithdraw(config.AMOUNT, config.WITHDRAW_ALL ? true : null)
    .accounts({
      marginfiAccount: config.ACCOUNT,
      destinationTokenAccount,
      bank: config.BANK,
      lendingAdmin,
      supplyTokenReservesLiquidity,
      lendingSupplyPositionOnLiquidity,
      rateModel: juplendAccounts.rateModel,
      vault: juplendAccounts.vault,
      claimAccount,
      liquidity: juplendAccounts.liquidity,
      liquidityProgram: juplendAccounts.liquidityProgram,
      rewardsRateModel: juplendAccounts.rewardsRateModel,
      tokenProgram,
    })
    .accountsPartial({
      fTokenMint,
    })
    .remainingAccounts(oracleMeta)
    .instruction();

  transaction.add(withdrawIx);

  // Simulate
  transaction.feePayer = payerKey;
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;

  console.log("Simulating juplendWithdraw...");
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
    console.log("Withdrawal successful!");
  } else {
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    console.log("withdraw from:", config.BANK.toString());
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
