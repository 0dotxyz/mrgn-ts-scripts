// Run deposit_single_pool first to convert to LST. In production, these will likely be atomic.
import {
  AccountMeta,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { composeRemainingAccounts } from "../../lib/utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
  BANK: PublicKey;
  MINT: PublicKey;
  /** In native decimals */
  AMOUNT: BN;
  WITHDRAW_ALL: boolean;
  /**
   * ONLY NEEDED IF USING THE MULTISIG, OTHERWISE FETCHED FROM THE ACCOUNT. Set sendTx = true and
   * this script will print these for you to copy and paste!
   * 
   * MAKE SURE YOU REMOVE THE ONE YOU ARE WITHDRAWING IF WITHDRAWING ALL
   *
   * For each balance the user has, in order, pass
   * * bank0, oracle0, bank1, oracle1, etc
   *
   * in any order
   *
   * if a bank is a STAKED COLLATERAL bank, also pass the LST mint and SOL pool, like:
   * * bank0, oracle0, lstMint0, solPool0, bank1, oracle1
   *
   * You can derive these with:
    ```
    const [lstMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint"), config.STAKE_POOL.toBuffer()],
        SINGLE_POOL_PROGRAM_ID
    );
    ```
     and
    ```
    const [pool] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake"), config.STAKE_POOL.toBuffer()],
        SINGLE_POOL_PROGRAM_ID
    );
    ```
   * or read them from the bank directly (oracles[1] and oracles[2])
   * */
  REMAINING: PublicKey[][];
  ADD_COMPUTE_UNITS: boolean;

  // Optional, omit if not using MS.
  MULTISIG?: PublicKey;
};

const withdrawLiquidatorUSDC: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("CE7D7oeCXs54w8BQjZGq46wjS3a36SSuMmrsXkQTfvJL"),
  BANK: new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"),
  MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  AMOUNT: new BN(20 * 10 ** 6),
  WITHDRAW_ALL: false,
  REMAINING: [
    [
      new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"), // usdc bank
      new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"), // usdc oracle
    ],
  ],
  ADD_COMPUTE_UNITS: false,
};

const withdrawKaminoLiquidatorUSDC: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  ACCOUNT: new PublicKey("3VbTuhoZrLdHkrvUyxZffKgJ247GweRE62AEgXPx9ghM"),
  BANK: new PublicKey("8LkHC2Gh17H4KmdaPU788NgiehMXZRhtXkLgDgcMVUh8"),
  MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  AMOUNT: new BN(20 * 10 ** 6),
  WITHDRAW_ALL: true,
  REMAINING: [],
  ADD_COMPUTE_UNITS: false,
};

const config = withdrawKaminoLiquidatorUSDC;

async function main() {
  await withdraw(sendTx, config, "/.config/stage/id.json");
}

export async function withdraw(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  version?: "current",
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG,
    version,
  );
  const program = user.program;
  const connection = user.connection;

  let mintAccInfo = await connection.getAccountInfo(config.MINT);
  const tokenProgram = mintAccInfo.owner;
  let isT22 = tokenProgram.toString() == TOKEN_2022_PROGRAM_ID.toString();

  const remaining = composeRemainingAccounts(config.REMAINING);
  let meta: AccountMeta[] = remaining.map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));

  if (isT22) {
    const m: AccountMeta = {
      pubkey: config.MINT,
      isSigner: false,
      isWritable: false,
    };
    // must be pushed first in the array
    meta.unshift(m);
  }

  const transaction = new Transaction();

  if (config.ADD_COMPUTE_UNITS) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    );
  }

  const ata = getAssociatedTokenAddressSync(
    config.MINT,
    user.wallet.publicKey,
    true,
    tokenProgram,
  );

  transaction.add(
    // createAssociatedTokenAccountIdempotentInstruction(
    //   user.wallet.publicKey,
    //   ata,
    //   user.wallet.publicKey,
    //   config.MINT,
    //   tokenProgram
    // ),
    await program.methods
      .lendingAccountWithdraw(config.AMOUNT, config.WITHDRAW_ALL)
      .accounts({
        marginfiAccount: config.ACCOUNT,
        bank: config.BANK,
        destinationTokenAccount: ata,
        tokenProgram: tokenProgram,
      })
      .remainingAccounts(meta)
      .instruction(),
  );

  console.log(
    "(" +
      user.wallet.publicKey +
      ") withdrawing " +
      config.AMOUNT.toString() +
      " from " +
      config.BANK,
  );

  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      user.wallet.payer,
    ]);
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
