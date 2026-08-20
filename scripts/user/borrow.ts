// Run deposit_single_pool first to convert to LST. In production, these will likely be atomic.
import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import {
  commonSetup,
  registerDriftProgram,
  registerJuplendProgram,
  registerKaminoProgram,
} from "../../lib/common-setup";
import { BankAndOracles, getOraclesAndCrankSwb } from "../../lib/utils";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import { simpleRefreshReserve } from "../kamino/ixes-common";
import {
  DRIFT_PROGRAM_ID,
  makeUpdateSpotMarketCumulativeInterestIx,
} from "../drift/lib/utils";
import {
  JUPLEND_LENDING_PROGRAM_ID,
  makeJuplendNativeUpdateRateIx,
} from "../juplend/lib/utils";
import { createAssociatedTokenAccountIdempotentInstruction, getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { CrossbarClient } from "@switchboard-xyz/common";
import { crankSwitchboardFeeds } from "./crank-swb-feed-alt";

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
  LUT?: PublicKey; // Optional but likely needed, especially if you use integration accs

  // Optional, omit if not using MS.
  MULTISIG?: PublicKey;

  // Optional, if Kamino positions's health is required for borrow
  KAMINO_RESERVES?: PublicKey[];

  // Optional, if Drift positions's health is required for borrow
  DRIFT_MARKETS?: number[];

  // Optional, if Juplend positions's health is required for borrow
  JUPLEND_STATES?: PublicKey[];

  // Optional, Crossbar used to crank the Switchboard feeds backing the involved banks, so the
  // oracles are inside `oracle_max_age` when the risk engine reads them. Defaults to the public
  // Switchboard crossbar.
  CROSSBAR_URL?: string;
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
  KAMINO_RESERVES: [
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),
  ],
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
  registerDriftProgram(user, DRIFT_PROGRAM_ID.toString());
  registerJuplendProgram(user, JUPLEND_LENDING_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  let luts: AddressLookupTableAccount[] = [];
  if (!config.LUT) {
    luts = [];
  } else {
    const lutLookup = await connection.getAddressLookupTable(config.LUT);
    if (!lutLookup || !lutLookup.value) {
      console.warn(
        `Warning: LUT not provided or not found on-chain. Proceeding without it.`,
      );
      luts = [];
    } else {
      luts = [lutLookup.value];
    }
  }

  const bank = await program.account.bank.fetch(config.BANK);
  const borrowMint = bank.mint as PublicKey;

  // Switchboard feeds backing the banks the risk engine reads for this borrow (the account's
  // active positions plus the bank being borrowed from), cranked in their own tx before the
  // borrow tx is built (see below). Deduped: several banks can share one feed.
  const swbFeeds = new Map<string, PublicKey>();
  const noteSwbFeed = (bankAcc: any) => {
    if (
      bankAcc.config.oracleSetup.switchboardPull ||
      bankAcc.config.oracleSetup.kaminoSwitchboardPull ||
      bankAcc.config.oracleSetup.driftSwitchboardPull ||
      bankAcc.config.oracleSetup.juplendSwitchboardPull
    ) {
      const feed: PublicKey = bankAcc.config.oracleKeys[0];
      console.log("SWB ORACLE:", feed.toBase58());
      swbFeeds.set(feed.toBase58(), feed);
    }
  };
  // Only used when actually sending: the MS path emits a tx to sign later, so cranking now is
  // pointless and the extra fetches are wasted.
  if (sendTx) {
    noteSwbFeed(bank);
    const acc = await program.account.marginfiAccount.fetch(config.ACCOUNT);
    for (const bal of acc.lendingAccount.balances) {
      if (bal.active !== 1 || bal.bankPk.equals(config.BANK)) {
        continue;
      }
      noteSwbFeed(await program.account.bank.fetch(bal.bankPk));
    }
  }

  const mintAccInfo = await connection.getAccountInfo(borrowMint);
  if (!mintAccInfo) {
    throw new Error(`Mint account not found: ${borrowMint.toBase58()}`);
  }
  const tokenProgram = mintAccInfo.owner;
  const isToken2022 = tokenProgram.equals(TOKEN_2022_PROGRAM_ID);

  const oracleMeta: AccountMeta[] = config.NEW_REMAINING.flat().map(
    (pubkey) => {
      return { pubkey, isSigner: false, isWritable: false };
    },
  );

  if (isToken2022) {
    oracleMeta.unshift({
      pubkey: borrowMint,
      isSigner: false,
      isWritable: false,
    });
  }

  const ata = getAssociatedTokenAddressSync(
    borrowMint,
    user.wallet.publicKey,
    true,
    tokenProgram,
  );
  let instructions: TransactionInstruction[] = [];

  if (config.ADD_COMPUTE_UNITS) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    );
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    );
  }

  if (config.KAMINO_RESERVES) {
    const reserves = config.KAMINO_RESERVES ?? [];
    for (let i = 0; i < reserves.length; i++) {
      const reserve = config.KAMINO_RESERVES[i];
      const reserveAcc =
        await user.kaminoProgram.account.reserve.fetch(reserve);

      instructions.push(
        await simpleRefreshReserve(
          user.kaminoProgram,
          reserve,
          reserveAcc.lendingMarket,
          reserveAcc.config.tokenInfo.scopeConfiguration.priceFeed, // NOTE: depends on the config, but in practice it's always 'scope'
        ),
      );
    }
  }

  if (config.DRIFT_MARKETS) {
    const spotMarkets = config.DRIFT_MARKETS ?? [];
    for (let i = 0; i < spotMarkets.length; i++) {
      const marketIndex = config.DRIFT_MARKETS[i];

      instructions.push(
        await makeUpdateSpotMarketCumulativeInterestIx(
          user.driftProgram,
          marketIndex,
        ),
      );
    }
  }

  if (config.JUPLEND_STATES) {
    const lendingStates = config.JUPLEND_STATES ?? [];
    for (let i = 0; i < lendingStates.length; i++) {
      const lending = config.JUPLEND_STATES[i];

      instructions.push(
        await makeJuplendNativeUpdateRateIx(user.juplendProgram, lending),
      );
    }
  }

  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      user.wallet.publicKey,
      ata,
      user.wallet.publicKey,
      borrowMint,
      tokenProgram,
    ),
    await program.methods
      .lendingAccountBorrow(config.AMOUNT)
      .accounts({
        // marginfiGroup: config.GROUP,
        marginfiAccount: config.ACCOUNT,
        // signer: wallet.publicKey,
        bank: config.BANK,
        destinationTokenAccount: ata,
        authority: user.wallet.publicKey,
        // bankLiquidityVaultAuthority = deriveLiquidityVaultAuthority(id, bank);
        // bankLiquidityVault = deriveLiquidityVault(id, bank)
        tokenProgram,
      })
      .remainingAccounts(oracleMeta)
      .instruction(),
  );

  console.log(
    "borrowing : " + config.AMOUNT.toString() + " from " + config.BANK,
  );

  // Crank the Switchboard feeds right before the borrow tx is assembled, so the freshly-pushed
  // prices are as young as possible when the risk engine reads them. This is a separate tx on
  // purpose: the SWB update ixs carry secp256k1 signature verification and their own LUTs, and
  // the borrow tx is typically already close to the size limit.
  if (sendTx && swbFeeds.size > 0) {
    const feeds = [...swbFeeds.values()];
    console.log();
    console.log(`Cranking ${feeds.length} Switchboard feed(s) before borrowing`);
    try {
      await crankSwitchboardFeeds({
        ORACLE_KEYS: feeds,
        CROSSBAR_CLIENT: new CrossbarClient(
          config.CROSSBAR_URL ?? "https://crossbar.switchboard.xyz",
        ),
        // Already HOME-resolved, so `crankSwitchboardFeeds` leaves it alone and we are
        // guaranteed to sign with the same keypair as the borrow tx.
        WALLET_PATH: process.env.HOME + walletPath,
        RPC_URL: connection.rpcEndpoint,
      });
    } catch (error) {
      // A failed crank is not fatal: the feeds may still be inside `oracle_max_age`, and if they
      // are not the borrow tx will fail on its own with a stale-oracle error.
      console.error("Switchboard crank failed, continuing anyway:", error);
    }
    console.log();
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  if (sendTx) {
    try {
      const v0Message = new TransactionMessage({
        payerKey: user.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(luts);
      const v0Tx = new VersionedTransaction(v0Message);

      v0Tx.sign([user.wallet.payer]);
      const signature = await connection.sendTransaction(v0Tx, {
        maxRetries: 2,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    const v0Message = new TransactionMessage({
      payerKey: config.MULTISIG!,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(luts);
    const v0Tx = new VersionedTransaction(v0Message);

    const serializedTransaction = v0Tx.serialize();
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
