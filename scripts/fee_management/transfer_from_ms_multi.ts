// Withdraw assets for multiple mints in one v0 tx using a LUT.
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { createTransferInstruction } from "@solana/spl-token";

/**
 * If true, send the tx; if false, output an unsigned base58 v0 message to console (for multisig).
 */
const sendTx = false;

export type Config = {
  PROGRAM_ID: string;
  MINTS: PublicKey[]; // <-- multiple mints
  SOURCE_WALLET: PublicKey;
  DEST_WALLET: PublicKey;

  MULTISIG_PAYER: PublicKey;

  LUT: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  MINTS: [
    // new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    // new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    // new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    // new PublicKey("SW1TCHLmRGTfW5xZknqQdpdarB8PD95sJYWpNp9TbFx"),
    // new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),

    new PublicKey("bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"),
    new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    new PublicKey("LSTxxxnJzKDFSLr4dUkPcmCf5VyryEqzPLz5j4bpxFp"),
    new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"),
    new PublicKey("USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA"),
  ],
  SOURCE_WALLET: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  DEST_WALLET: new PublicKey("DBNRpvecWpcxckFs2uDeuioR8Bcad6v68TDJKPeYBNHG"),

  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  LUT: new PublicKey("DP9JAbtatfCrSAJQiWZUmWTfgHCnuWsx1QBczi1mnuxW"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/keys/staging-deploy.json",
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;

  const payerPubkey = sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER;

  const { value: lut } = await connection.getAddressLookupTable(config.LUT);

  const ixes: TransactionInstruction[] = [];

  for (const mintPk of config.MINTS) {
    const mintAccInfo = await connection.getAccountInfo(mintPk);

    const tokenProgram = mintAccInfo.owner;
    const isT22 = tokenProgram.toString() === TOKEN_2022_PROGRAM_ID.toString();

    const srcAta = getAssociatedTokenAddressSync(
      mintPk,
      config.SOURCE_WALLET,
      true,
      tokenProgram,
    );

    const srcTokenAcc = await getAccount(
      connection,
      srcAta,
      undefined, // default commitment
      tokenProgram,
    );

    const amount = srcTokenAcc.amount;
    if (amount === 0n) {
      console.log(
        `[${mintPk.toBase58()}] source ATA ${srcAta.toBase58()} has 0 balance, skipping transfer`,
      );
      continue;
    }

    // Destination ATA for this mint
    const dstAta = getAssociatedTokenAddressSync(
      mintPk,
      config.DEST_WALLET,
      true,
      tokenProgram,
    );

    console.log(
      `[${mintPk.toBase58()}] transferring ${amount.toString()} from ${srcAta.toBase58()} to ${dstAta.toBase58()}`,
    );

    // Create the ATA if needed (idempotent).
    ixes.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payerPubkey,
        dstAta,
        config.DEST_WALLET,
        mintPk,
        tokenProgram,
      ),
    );

    ixes.push(
      createTransferInstruction(
        srcAta,
        dstAta,
        config.SOURCE_WALLET, // authority (must sign)
        amount,
        [],
        tokenProgram,
      ),
    );

    // TODO invoke transfer
  }

  if (ixes.length === 0) {
    console.log(
      "No instructions to send (nothing to set or withdraw). Exiting.",
    );
    return;
  }

  if (sendTx) {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const v0Message = new TransactionMessage({
      payerKey: user.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [...ixes],
    }).compileToV0Message([lut]);
    const v0Tx = new VersionedTransaction(v0Message);

    v0Tx.sign([user.wallet.payer]);
    const signature = await connection.sendTransaction(v0Tx, {
      maxRetries: 2,
    });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    console.log("tx signature:", signature);
  } else {
    // No versioned tx for squads (yet)
    let transaction = new Transaction().add(...ixes);
    transaction.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

main().catch((err) => {
  console.error(err);
});
