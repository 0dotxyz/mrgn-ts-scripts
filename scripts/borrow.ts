// Run deposit_single_pool first to convert to LST. In production, these will likely be atomic.
import {
  AccountMeta,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import { commonSetup, registerKaminoProgram } from "../lib/common-setup";
import { BankAndOracles } from "../lib/utils";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { KLEND_PROGRAM_ID } from "./kamino/kamino-types";
import { simpleRefreshReserve } from "./kamino/ixes-common";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
  BANK: PublicKey;
  MINT: PublicKey;
  /** In native decimals */
  AMOUNT: BN;
  /**
   * If this borrow is opening a NEW POSITION, add the bank and oracle here, in that order
   * */
  NEW_REMAINING: BankAndOracles;
  ADD_COMPUTE_UNITS: boolean;

  // Optional, omit if not using MS.
  MULTISIG?: PublicKey;
  KAMINO_RESERVE: PublicKey;
  KAMINO_MARKET: PublicKey;
  RESERVE_ORACLE: PublicKey;
  OBLIGATION?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  ACCOUNT: new PublicKey("89ViS63BocuvZx5NE5oS9tBJ4ZbKZe3GkvurxHuSqFhz"),
  BANK: new PublicKey("7ApaDMRXcHvh8Q3QcoZ5bM3JD1vtd3BX3zsDJuM8TGy6"),
  MINT: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
  AMOUNT: new BN(50000 * 10 ** 5), // 50k BONK
  NEW_REMAINING: [
    new PublicKey("J3KtPXSWiVjYLrTEGNqUt7A2BT3r263miZXYBsrhjyee"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("HakK3mqEPwsaYiZkcsDbdkY9Y8Eg7bV74jhMbvEdrufX"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("GcifFUfAfE18eyLwottPVqGcGJzKF1tcQrAbxj6xwfwi"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("EXdnvWEHhg6LGGsnPW7MDPWrkAGjuU372cP4ANFq6zrx"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("E4eAE2HF979z4SFcWht5c3tTuvRfGCPJ7qGSf7BDPkNr"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("BJXzzbvcfcjh95oidYJ8PvzQdu4kozYqfPN5Nbm1QmcW"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("BCAUSwpinknASD9uuiT5Fm13TvzNgVPJk5sRTEwHQqmE"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("8qPLKaKb4F5BC6mVncKAryMp78yp5ZRGYnPkQbt9ikKt"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("8LkHC2Gh17H4KmdaPU788NgiehMXZRhtXkLgDgcMVUh8"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("7VVKtodpVdfNZbYa9BR4HTMmGhrBkji5cHo4L6A5pq4R"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("7ApaDMRXcHvh8Q3QcoZ5bM3JD1vtd3BX3zsDJuM8TGy6"), // BONK
    new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"),

    new PublicKey("75D5Cs7z5S53ZwzXLSQhSF2upyitArZrgWY6WvkgABd7"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("73vML9t9N9gyJxYMqXYMHb7cQso7JuKphwVGUsHoLQSg"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("52qegQaofPUG8CHb6RmMmDH2PpZ74CuDbhURPhurXV5F"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("w7rEzN9zrQjwZN7LYRtigv4XSd1gnmGYmKz8YSCQC8f"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("MdyhEhSQKXsobV8dSg4ySVwJ1e9Qdb8RQdPfzFyoxqF"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
  ],
  ADD_COMPUTE_UNITS: true,
  KAMINO_RESERVE: new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),
  KAMINO_MARKET: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
  RESERVE_ORACLE: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
  OBLIGATION: new PublicKey("5HxomAyh1wDSqHp9Gg5n3aF4vLAKQL3WK3baYMZwK6Yd"),
};

async function main() {
  await borrow(sendTx, config, "/.config/stage/id.json");
}

export async function borrow(
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
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  const oracleMeta: AccountMeta[] = config.NEW_REMAINING.flat().map(
    (pubkey) => {
      return { pubkey, isSigner: false, isWritable: false };
    },
  );

  const ata = getAssociatedTokenAddressSync(config.MINT, user.wallet.publicKey);
  const transaction = new Transaction();

  if (config.ADD_COMPUTE_UNITS) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    );
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    );
  }

  transaction.add(
    // createAssociatedTokenAccountIdempotentInstruction(
    //   user.wallet.publicKey,
    //   ata,
    //   user.wallet.publicKey,
    //   config.MINT
    // ),
    await simpleRefreshReserve(
      user.kaminoProgram,
      config.KAMINO_RESERVE,
      config.KAMINO_MARKET,
      config.RESERVE_ORACLE,
    ),
    // await simpleRefreshObligation(
    //   user.kaminoProgram,
    //   config.KAMINO_MARKET,
    //   config.OBLIGATION,
    //   [config.KAMINO_RESERVE]
    // ),
    await program.methods
      .lendingAccountBorrow(config.AMOUNT)
      .accounts({
        // marginfiGroup: config.GROUP,
        marginfiAccount: config.ACCOUNT,
        // signer: wallet.publicKey,
        bank: config.BANK,
        destinationTokenAccount: ata,
        // bankLiquidityVaultAuthority = deriveLiquidityVaultAuthority(id, bank);
        // bankLiquidityVault = deriveLiquidityVault(id, bank)
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(oracleMeta)
      .instruction(),
  );

  console.log(
    "borrowing : " + config.AMOUNT.toString() + " from " + config.BANK,
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
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
