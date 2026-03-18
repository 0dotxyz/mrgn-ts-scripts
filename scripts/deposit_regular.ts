import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../lib/common-setup";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  GROUP?: PublicKey;
  ACCOUNT: PublicKey;
  ACCOUNT_AUTHORITY?: PublicKey;
  BANK: PublicKey;
  MINT: PublicKey;
  /** In native decimals */
  AMOUNT: BN;

  MULTISIG?: PublicKey;
};

const examples: Record<string, Config> = {
  depositUSDCKamino: {
    PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
    ACCOUNT: new PublicKey("3VbTuhoZrLdHkrvUyxZffKgJ247GweRE62AEgXPx9ghM"),
    BANK: new PublicKey("8LkHC2Gh17H4KmdaPU788NgiehMXZRhtXkLgDgcMVUh8"),
    MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    AMOUNT: new BN(1 * 10 ** 5), // 0.1 USDC (** 6 decimals)
    // REMAINING: [
    //   new PublicKey("8LkHC2Gh17H4KmdaPU788NgiehMXZRhtXkLgDgcMVUh8"), // usdc bank
    //   new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"), // usdc oracle
    // ],
    MULTISIG: undefined,
  },
  depositBonkKamino: {
    PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
    ACCOUNT: new PublicKey("FvRj5WiHZh6mU9TSsgAeJinDeSAkBmPvbJHJCqXAxCsH"),
    BANK: new PublicKey("CVjHEnJWKELsbFt37znC2nq4KNrwTf7w42fcfySEifNu"),
    MINT: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    AMOUNT: new BN(10000 * 10 ** 5), // 10'000 BONK (** 5 decimals)
    // REMAINING: [
    //   new PublicKey("7ApaDMRXcHvh8Q3QcoZ5bM3JD1vtd3BX3zsDJuM8TGy6"), // bonk bank
    //   new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"), // bonk oracle
    // ],
    MULTISIG: undefined,
  },
  depositUXDProd: {
    PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    ACCOUNT: new PublicKey("AkRjbYJgrKXmdE9zizGWXcK4oecJfhuLxBuNrKsooAKK"),
    BANK: new PublicKey("BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR"),
    MINT: new PublicKey("7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT"),
    AMOUNT: new BN(29675 * 10 ** 6), // 29'675 UXD (** 6 decimals)
    // REMAINING: [
    //   new PublicKey("BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR"), // uxd bank
    //   new PublicKey("CoEDGeYda7Mi6c1BAsHE2LL6zEVcitX43wPABSLgQfpB"), // uxd oracle
    // ],
    MULTISIG: undefined,
  },
};

const config = examples.depositBonkKamino;

async function main() {
  await depositRegular(sendTx, config, "/.config/stage/id.json");
}

export async function depositRegular(
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

  const ata = getAssociatedTokenAddressSync(
    config.MINT,
    user.wallet.publicKey,
    true,
  );

  const transaction = new Transaction();
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      user.wallet.publicKey,
      ata,
      user.wallet.publicKey,
      config.MINT,
    ),
  );
  if (config.MINT.toString() == "So11111111111111111111111111111111111111112") {
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: user.wallet.publicKey,
        toPubkey: ata,
        lamports: config.AMOUNT.toNumber(),
      }),
    );
    transaction.add(createSyncNativeInstruction(ata));
  }
  transaction.add(
    await program.methods
      .lendingAccountDeposit(config.AMOUNT, false)
      .accounts({
        marginfiAccount: config.ACCOUNT,
        bank: config.BANK,
        signerTokenAccount: ata,
        // bankLiquidityVault = deriveLiquidityVault(id, bank)
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      // To handle the case where the account doesn't exist yet.
      // .accountsPartial({
      //   group: config.GROUP,
      //   authority: config.ACCOUNT_AUTHORITY,
      // })
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
