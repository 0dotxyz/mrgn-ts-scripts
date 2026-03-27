import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
  // OLD_AUTHORITY: PublicKey;
  NEW_AUTHORITY: PublicKey;
  /** H4QMTHMVbJ3KrB5bz573cBBZKoYSZ2B4mSST1JKzPUrH on staging, typically the MS on the mainnet  */
  GLOBAL_FEE_WALLET: PublicKey;
  ACCOUNT_INDEX: number;
  THIRD_PARTY_SEED: number;

  MULTISIG: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("C1w1Jw37ci5HeWDFrY8vabcRinxFDPpuYdHfkHTMErxt"),
  // OLD_AUTHORITY: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  NEW_AUTHORITY: new PublicKey("BSQX5SNk8dTMsP6MBkyrH3ET2WdWvWVVpE3wKYPQqaTH"),
  GLOBAL_FEE_WALLET: new PublicKey(
    "CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw",
  ),
  ACCOUNT_INDEX: 0,
  THIRD_PARTY_SEED: 615,

  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/keys/phantom-wallet.json",
    config.MULTISIG,
    "current",
  );
  const program = user.program;
  const connection = user.connection;

  const acc = await program.account.marginfiAccount.fetch(config.ACCOUNT);
  console.log(
    "Old account on group: " + acc.group + " migrated from " + acc.migratedFrom,
  );

  const [newAcc] = deriveMarginfiAccountPda(
    program.programId,
    acc.group,
    config.NEW_AUTHORITY,
    config.ACCOUNT_INDEX,
    config.THIRD_PARTY_SEED,
  );

  let tx = new Transaction().add(
    await program.methods
      .transferToNewAccountPda(config.ACCOUNT_INDEX, config.THIRD_PARTY_SEED)
      .accounts({
        oldMarginfiAccount: config.ACCOUNT,
        feePayer: user.wallet.publicKey,
        newAuthority: config.NEW_AUTHORITY,
        globalFeeWallet: config.GLOBAL_FEE_WALLET,
      })
      // TODO figure out why this doesn't infer
      .accountsPartial({
        newMarginfiAccount: newAcc,
      })
      .instruction(),
  );
  console.log("Moving account: " + config.ACCOUNT + " to " + newAcc);

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [
        user.wallet.payer,
      ]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    // NOTE: this current cannot work unless the ephemeral keypair we just created can sign too!
    tx.feePayer = config.MULTISIG; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const serializedTransaction = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

const deriveMarginfiAccountPda = (
  programId: PublicKey,
  group: PublicKey,
  authority: PublicKey,
  accountIndex: number,
  thirdPartyId?: number,
) => {
  const accountIndexBuffer = Buffer.allocUnsafe(2);
  accountIndexBuffer.writeUInt16LE(accountIndex, 0);

  const thirdPartyIdBuffer = Buffer.allocUnsafe(2);
  thirdPartyIdBuffer.writeUInt16LE(thirdPartyId || 0, 0);

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("marginfi_account", "utf-8"),
      group.toBuffer(),
      authority.toBuffer(),
      accountIndexBuffer,
      thirdPartyIdBuffer,
    ],
    programId,
  );
};

main().catch((err) => {
  console.error(err);
});
