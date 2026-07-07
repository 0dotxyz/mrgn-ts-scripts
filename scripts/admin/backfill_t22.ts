import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { commonSetup } from "../../lib/common-setup";
import { deriveBankWithSeed } from "../common/pdas";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;
/** Try to send this many backfill ixes per tx */
const CHUNK_SIZE = 10;
/** True to backfill every bank in the group, false to do just what's in the configs list */
const BACKFILL_ALL = true;
/** True to skip banks where BANK_SEED_KNOWN is set, false to backfill everything regardless. */
const SKIP_BACKFILLED = true;
/** WARN: set this too high, and your computer will die (a poem) */
const MAX_SEED_TO_SEARCH = 50;
/** Bitwise flag that indicates the seed was already backfilled and is known */
const BANK_SEED_KNOWN = new BN(256);

type SeedInput = number | string | BN | null | undefined;

type SharedConfig = {
  PROGRAM_ID: string;
  /** Used when BACKFILL_ALL = true. */
  GROUP_KEY: PublicKey;
  WALLET_PATH: string;
  /** Required when sendTx = false. Used as the fee payer for multisig flow. */
  MULTISIG_PAYER?: PublicKey;
};

const configCommon: SharedConfig = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  GROUP_KEY: new PublicKey("Diu1q9gniR1qR4Daaej3rcHd6949HMmxLGsnQ94Z3rLz"),
  WALLET_PATH: "/.config/solana/id.json",
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

type BackfillConfig = {
  bank: PublicKey;
  /**
   * Omit/null to pass None and only backfill IS_T22.
   * Set to a seed, including 0, to also backfill bank_seed.
   */
  bankSeed?: SeedInput;
};

/** One entry per bank to backfill. */
const configs: BackfillConfig[] = [
  // {
  //   bank: new PublicKey("..."),
  //   bankSeed: 0,
  // },
];

type BankRecord = {
  bank: PublicKey;
  group: PublicKey;
  mint: PublicKey;
  flags: BN;
  bankSeed: BN;
  requestedSeed: SeedInput;
};

type BackfillResult = {
  bank: PublicKey;
  group: PublicKey;
  mint: PublicKey;
  bankSeed: BN | null;
  isT22: boolean;
  chunk: number;
};

function toOptionalBn(seed: SeedInput): BN | null {
  if (seed === null || seed === undefined) {
    return null;
  }

  if (BN.isBN(seed)) {
    return seed;
  }

  if (typeof seed === "number") {
    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new Error(`Invalid bankSeed number: ${seed}`);
    }
    return new BN(seed);
  }

  return new BN(seed);
}

function hasBankSeedKnown(flags: BN): boolean {
  return !flags.and(BANK_SEED_KNOWN).isZero();
}

function findBankSeed(
  programId: PublicKey,
  group: PublicKey,
  mint: PublicKey,
  bank: PublicKey,
): BN | null {
  for (let seed = 0; seed <= MAX_SEED_TO_SEARCH; seed++) {
    const [derivedBank] = deriveBankWithSeed(
      programId,
      group,
      mint,
      new BN(seed),
    );

    if (derivedBank.equals(bank)) {
      return new BN(seed);
    }
  }

  return null;
}

function printTable(title: string, results: BackfillResult[]) {
  console.log(`\n${title}: ${results.length}`);
  if (results.length === 0) {
    return;
  }

  console.table(
    results.map((result) => ({
      bank: result.bank.toBase58(),
      group: result.group.toBase58().slice(0, 5),
      mint: result.mint.toBase58().slice(0, 5),
      t22: result.isT22,
      bankSeed: result.bankSeed ? result.bankSeed.toString() : "None",
      chunk: result.chunk,
    })),
  );
}

async function main() {
  if (!BACKFILL_ALL && configs.length === 0) {
    throw new Error("Add at least one bank to configs before running");
  }

  if (!sendTx && !configCommon.MULTISIG_PAYER) {
    throw new Error("MULTISIG_PAYER must be set when sendTx = false");
  }

  const user = commonSetup(
    sendTx,
    configCommon.PROGRAM_ID,
    configCommon.WALLET_PATH,
    configCommon.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;
  const records: BankRecord[] = [];
  const backfilled: BackfillResult[] = [];
  const skippedKnownSeed: BackfillResult[] = [];

  if (BACKFILL_ALL) {
    const allBanks = await program.account.bank.all([
      {
        memcmp: {
          offset: 41,
          bytes: configCommon.GROUP_KEY.toBase58(),
        },
      },
    ]);

    console.log(
      `Found ${allBanks.length} banks for group ${configCommon.GROUP_KEY.toBase58()}`,
    );

    for (const bank of allBanks) {
      const account = bank.account;
      records.push({
        bank: bank.publicKey,
        group: account.group as PublicKey,
        mint: account.mint as PublicKey,
        flags: account.flags as BN,
        bankSeed: account.bankSeed as BN,
        requestedSeed: undefined,
      });
    }
  } else {
    for (const cfg of configs) {
      const bankAcc = await program.account.bank.fetch(cfg.bank);
      records.push({
        bank: cfg.bank,
        group: bankAcc.group as PublicKey,
        mint: bankAcc.mint as PublicKey,
        flags: bankAcc.flags as BN,
        bankSeed: bankAcc.bankSeed as BN,
        requestedSeed: cfg.bankSeed,
      });
    }
  }

  console.log(`Processing ${records.length} banks in chunks of ${CHUNK_SIZE}`);

  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunkIndex = i / CHUNK_SIZE;
    const chunk = records.slice(i, i + CHUNK_SIZE);
    const transaction = new Transaction();
    const chunkBackfilled: BackfillResult[] = [];

    for (const record of chunk) {
      const mintInfo = await connection.getAccountInfo(record.mint);

      if (!mintInfo) {
        throw new Error(`Mint account not found: ${record.mint.toBase58()}`);
      }

      const isT22 = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
      if (SKIP_BACKFILLED && hasBankSeedKnown(record.flags)) {
        skippedKnownSeed.push({
          bank: record.bank,
          group: record.group,
          mint: record.mint,
          bankSeed: record.bankSeed,
          isT22,
          chunk: chunkIndex,
        });
        console.log(
          `[${record.bank.toBase58()}] BANK_SEED_KNOWN set; skipping`,
        );
        continue;
      }

      const bankSeed = BACKFILL_ALL
        ? findBankSeed(
            program.programId,
            record.group,
            record.mint,
            record.bank,
          )
        : toOptionalBn(record.requestedSeed);
      const tokenProgram =
        isT22
          ? "Token-2022"
          : mintInfo.owner.equals(TOKEN_PROGRAM_ID)
            ? "SPL Token"
            : mintInfo.owner.toBase58();

      console.log(
        `[${record.bank.toBase58()}] group=${record.group.toBase58()} mint=${record.mint.toBase58()} tokenProgram=${tokenProgram} bankSeed=${
          bankSeed ? bankSeed.toString() : "None"
        }`,
      );

      const ix = await program.methods
        .lendingPoolBackfillBankIsT22Flag(bankSeed)
        .accountsPartial({
          bank: record.bank,
          group: record.group,
          mint: record.mint,
        })
        .instruction();

      transaction.add(ix);
      chunkBackfilled.push({
        bank: record.bank,
        group: record.group,
        mint: record.mint,
        bankSeed,
        isT22,
        chunk: chunkIndex,
      });
    }

    if (chunkBackfilled.length === 0) {
      console.log(
        `No backfills needed for chunk starting at index ${i}; skipping transaction.`,
      );
      continue;
    }

    if (sendTx) {
      try {
        const signature = await sendAndConfirmTransaction(
          connection,
          transaction,
          [user.wallet.payer],
        );
        console.log("Transaction signature:", signature);
        for (const result of chunkBackfilled) {
          backfilled.push(result);
        }
      } catch (error) {
        console.error("Transaction failed:", error);
      }
    } else {
      transaction.feePayer = configCommon.MULTISIG_PAYER;
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;

      const serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const base58Transaction = bs58.encode(serializedTransaction);
      console.log(
        `Base58-encoded transaction for chunk ${chunkIndex}:`,
        base58Transaction,
      );
      backfilled.push(...chunkBackfilled);
    }
  }

  printTable(
    sendTx ? "Banks backfilled successfully" : "Banks prepared for backfill",
    backfilled,
  );
  printTable(
    "Banks skipped because BANK_SEED_KNOWN is already set",
    skippedKnownSeed,
  );
}

main().catch((err) => {
  console.error(err);
});
