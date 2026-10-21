// Run deposit_single_pool first to convert to LST. In production, these will likely be atomic.
import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { BankAndOracles } from "../../lib/utils";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { VenueRefresh, venueRefreshIxs } from "../../lib/venue_refresh";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
  BANK: PublicKey;
  MINT: PublicKey;
  /** In native decimals */
  AMOUNT: BN;
  WITHDRAW_ALL: boolean;
  REMAINING: BankAndOracles;
  ADD_COMPUTE_UNITS: boolean;

  // Optional, omit if not using MS.
  MULTISIG?: PublicKey;

  /**
   * Optional. Set when the account still holds Kamino/JupLend positions: the health check
   * prices them and needs them refreshed in the same tx. With these or a LUT the tx is sent as v0.
   */
  REFRESH?: VenueRefresh;
  LUT?: PublicKey;
};

const withdrawLiquidatorUSDC: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("CE7D7oeCXs54w8BQjZGq46wjS3a36SSuMmrsXkQTfvJL"),
  BANK: new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"),
  MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  AMOUNT: new BN(20 * 10 ** 6),
  WITHDRAW_ALL: false,
  REMAINING: [
      new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"), // usdc bank
      new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"), // usdc oracle
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
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  let mintAccInfo = await connection.getAccountInfo(config.MINT);
  const tokenProgram = mintAccInfo.owner;
  let isT22 = tokenProgram.toString() == TOKEN_2022_PROGRAM_ID.toString();

  const meta: AccountMeta[] = config.REMAINING.flat().map(
    (pubkey) => {
      return { pubkey, isSigner: false, isWritable: false };
    }
  );

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

  const refreshIxs = config.REFRESH
    ? await venueRefreshIxs(user, config.REFRESH)
    : [];
  if (refreshIxs.length === 0 && !config.LUT) {
    try {
      const signature = await sendAndConfirmTransaction(connection, transaction, [
        user.wallet.payer,
      ]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
    return;
  }

  let luts: AddressLookupTableAccount[] = [];
  if (config.LUT) {
    const lut = (await connection.getAddressLookupTable(config.LUT)).value;
    if (lut) luts = [lut];
    else console.warn(`Warning: LUT ${config.LUT.toBase58()} not found; sending without it.`);
  }
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const v0Tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: user.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
          ...refreshIxs,
          ...transaction.instructions,
        ],
      }).compileToV0Message(luts),
    );
    v0Tx.sign([user.wallet.payer]);
    const signature = await connection.sendTransaction(v0Tx, { maxRetries: 2 });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
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
