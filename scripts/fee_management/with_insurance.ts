// Withdraw fees (optionally set destination) for multiple banks in one v0 tx using a LUT.
import {
  AccountMeta,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { deriveInsuranceVault } from "../common/pdas";

/**
 * If true, send the tx; if false, output an unsigned base58 v0 message to console (for multisig).
 */
const sendTx = false;

export type Config = {
  PROGRAM_ID: string;
  BANKS: PublicKey[]; // <-- multiple banks
  DESTINATION_WALLET: PublicKey;

  MULTISIG_PAYER: PublicKey;

  LUT: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANKS: [
    // new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"),
    // new PublicKey("HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV"),
    // new PublicKey("Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8"),

    // new PublicKey("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh"),
    // new PublicKey("22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE"),
    // new PublicKey("DeyH7QxWvnbbaVB4zFrf4hoq7Q8z1ZT14co42BGwGtfM"),

    // new PublicKey("6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K"),
    // new PublicKey("8UEiPmgZHXXEDrqLS3oiTxQxTbeYTtPbeMBxAd2XGbpu"),
    // new PublicKey("DMoqjmsuoru986HgfjqrKEvPv8YBufvBGADHUonkadC5"),

    // new PublicKey("BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR"),
    // new PublicKey("FDsf8sj6SoV313qrA91yms3u5b3P4hBxEPvanVs8LtJV"),
    // new PublicKey("BKsfDJCMbYep6gr9pq8PsmJbb5XGLHbAJzUV8vmorz7a"),

    new PublicKey("Amtw3n7GZe5SWmyhMhaFhDTi39zbTkLeWErBsmZXwpDa"),
    new PublicKey("BkUyfXjbBBALcfZvw76WAFRvYQ21xxMWWeoPtJrUqG3z"),
  ],
  DESTINATION_WALLET: new PublicKey(
    "CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw",
  ),

  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/keys/staging-deploy.json",
    config.MULTISIG_PAYER,
    "current",
  );
  const program = user.program;
  const connection = user.connection;

  const payerPubkey = sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER;

  const { value: lut } = await connection.getAddressLookupTable(config.LUT);

  const ixes: TransactionInstruction[] = [];

  for (const bankPk of config.BANKS) {
    const bankAcc = await program.account.bank.fetch(bankPk);
    const mint: PublicKey = bankAcc.mint;
    const mintAccInfo = await connection.getAccountInfo(mint);

    const tokenProgram = mintAccInfo.owner;
    const isT22 = tokenProgram.toString() === TOKEN_2022_PROGRAM_ID.toString();

    const feesUncollected = wrappedI80F48toBigNumber(
      bankAcc.collectedInsuranceFeesOutstanding,
    ).toNumber();

    const [insuranceVault] = deriveInsuranceVault(program.programId, bankPk);
    const feesVaultAcc = await getAccount(
      connection,
      insuranceVault,
      undefined,
      tokenProgram,
    );
    const feesAvailable = feesVaultAcc.amount;

    console.log(
      `[${bankPk.toBase58()}] mint=${mint.toBase58()} t22=${isT22} dec=${
        bankAcc.mintDecimals
      } ` +
        `insurance Uncollected=${feesUncollected.toLocaleString()} insurance Available=${feesAvailable.toLocaleString()}`,
    );

    // Destination ATA for this mint
    const dstAta = getAssociatedTokenAddressSync(
      mint,
      config.DESTINATION_WALLET,
      true,
      tokenProgram,
    );
    console.log(
      `[${bankPk.toBase58()}] fee destination ATA: ${dstAta.toBase58()}`,
    );

    // Create the ATA if needed (idempotent).
    ixes.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payerPubkey,
        dstAta,
        config.DESTINATION_WALLET,
        mint,
        tokenProgram,
      ),
    );

    // Token-2022 mints require passing the mint as a remaining account.
    const remaining: AccountMeta[] = isT22
      ? [{ pubkey: mint, isSigner: false, isWritable: false }]
      : [];

    // Withdraw fees if there is anything to withdraw
    if (feesAvailable > 1) {
      const withdrawIx = await program.methods
        .lendingPoolWithdrawInsurance(new BN(feesAvailable).subn(1))
        .accounts({
          bank: bankPk,
          tokenProgram: tokenProgram,
        })
        // The destination ATA may not exist yet; specify explicitly
        .accountsPartial({
          dstTokenAccount: dstAta,
        })
        .remainingAccounts(remaining)
        .instruction();
      ixes.push(withdrawIx);
    } else {
      console.log(
        `[${bankPk.toBase58()}] Skipping withdraw; available <= 1 (=${feesAvailable}).`,
      );
    }
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

const deriveFeeVault = (programId: PublicKey, bank: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault", "utf-8"), bank.toBuffer()],
    programId,
  );
};

main().catch((err) => {
  console.error(err);
});
