// Run deposit_single_pool first to convert to LST. In production, these will likely be atomic.
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { SINGLE_POOL_PROGRAM_ID } from "./utils";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { commonSetup } from "../lib/common-setup";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
  BANK: PublicKey;
  STAKE_POOL: PublicKey;
  /** In native decimals */
  AMOUNT: BN;

  MULTISIG?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("5CuUxApoh9r7niiZKtsAyhjGMYJjjGKDZqFXGT3HdAKk"),
  BANK: new PublicKey("E5hZu5QQ1pRmGvyS4JHGXVQwzdUPaYM4yEiNKr64YzyG"),
  STAKE_POOL: new PublicKey("5ggDh4yt9qBrArSsMbLbj5wdpinfNN5Z9LGMRAGryh4o"),
  AMOUNT: new BN(0.0001 * 10 ** 9), // sol has 9 decimals

  MULTISIG: new PublicKey("4yZ86JsaJZoccQNn6fCgtcfgnKTEGe1JGCbnHb7L5zeH"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/keys/phantom-wallet.json",
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const [lstMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), config.STAKE_POOL.toBuffer()],
    SINGLE_POOL_PROGRAM_ID,
  );
  const lstAta = getAssociatedTokenAddressSync(
    lstMint,
    user.wallet.publicKey,
    true,
  );

  const transaction = new Transaction();
  transaction.add(
    await program.methods
      .lendingAccountDeposit(config.AMOUNT, false)
      .accounts({
        marginfiAccount: config.ACCOUNT,
        bank: config.BANK,
        signerTokenAccount: lstAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer],
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    transaction.feePayer = config.MULTISIG; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }

  console.log("deposit: " + config.AMOUNT.toString() + " to " + config.BANK);
}

main().catch((err) => {
  console.error(err);
});
