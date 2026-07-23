import {
  ParsedAccountData,
  PublicKey,
  Transaction,
  VoteProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

/**
 * (permissionless) Backfill the validator vote account (`integration_acc_1`) and on-ramp
 * (`oracle_keys[3]`) on pre-upgrade staked-collateral banks (`StakedWithPythPush`). Anyone can run
 * this. The vote account is read from each bank's stake account (`oracle_keys[2]`) delegation; the
 * ix re-derives and sets the on-ramp on-chain.
 */

/** If true, send the tx. If false, output the unsigned b58 tx to console. */
const sendTx = true;
/** Try to send this many backfill ixes per tx. */
const CHUNK_SIZE = 10;
/** True to backfill every eligible staked bank in the group; false to use `configs` only. */
const BACKFILL_ALL = true;
/** True to skip banks whose `integration_acc_1` is already set (the ix would be a no-op). */
const SKIP_BACKFILLED = true;
/** StakedWithPythPush = variant 5 of the OracleSetup enum. */
const STAKED_ORACLE_KEY = "stakedWithPythPush";

type SharedConfig = {
  PROGRAM_ID: string;
  /** Used when BACKFILL_ALL = true. */
  GROUP_KEY: PublicKey;
  WALLET_PATH: string;
  /** Required when sendTx = false. Used as the fee payer for the multisig flow. */
  MULTISIG_PAYER?: PublicKey;
};

const configCommon: SharedConfig = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEY: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  WALLET_PATH: "/.config/stage/id.json",
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

type BackfillConfig = {
  bank: PublicKey;
  /** Optional: override the auto-derived validator vote account. */
  validatorVoteAccount?: PublicKey;
};

/** One entry per bank; used only when BACKFILL_ALL = false. */
const configs: BackfillConfig[] = [
  // { bank: new PublicKey("...") },
];

type BankRecord = {
  bank: PublicKey;
  /** oracle_keys[2], the stake account whose delegation gives the validator vote account. */
  solPool: PublicKey;
  integrationSet: boolean;
  voteOverride?: PublicKey;
};

/** Reads a delegated stake account's `voter` (the validator vote account). */
async function voteFromStakeAccount(
  connection: ReturnType<typeof commonSetup>["connection"],
  stakeAccount: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getParsedAccountInfo(stakeAccount);
  const data = info.value?.data as ParsedAccountData;
  return new PublicKey(data.parsed.info.stake.delegation.voter);
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

  if (BACKFILL_ALL) {
    const allBanks = await program.account.bank.all([
      { memcmp: { offset: 41, bytes: configCommon.GROUP_KEY.toBase58() } },
    ]);
    for (const { publicKey, account } of allBanks) {
      if (!(STAKED_ORACLE_KEY in (account.config.oracleSetup as object))) {
        continue;
      }
      records.push({
        bank: publicKey,
        solPool: account.config.oracleKeys[2] as PublicKey,
        integrationSet: !(account.integrationAcc1 as PublicKey).equals(
          PublicKey.default,
        ),
      });
    }
    console.log(
      `Found ${records.length} StakedWithPythPush banks in group ${configCommon.GROUP_KEY.toBase58()}`,
    );
  } else {
    for (const cfg of configs) {
      const account = await program.account.bank.fetch(cfg.bank);
      records.push({
        bank: cfg.bank,
        solPool: account.config.oracleKeys[2] as PublicKey,
        integrationSet: !(account.integrationAcc1 as PublicKey).equals(
          PublicKey.default,
        ),
        voteOverride: cfg.validatorVoteAccount,
      });
    }
  }

  const targets = records.filter((r) => !(SKIP_BACKFILLED && r.integrationSet));

  // Resolve each bank's validator vote account (override or from its stake account delegation).
  const pending: { bank: PublicKey; vote: PublicKey }[] = [];
  for (const r of targets) {
    const vote =
      r.voteOverride ?? (await voteFromStakeAccount(connection, r.solPool));
    pending.push({ bank: r.bank, vote });
  }

  // Skip banks whose vote account is closed/missing: the ix requires a live vote-owned account,
  // and one bad account would fail the entire (all-or-nothing) chunk tx.
  const voteInfos = await connection.getMultipleAccountsInfo(
    pending.map((p) => p.vote),
  );
  const valid = pending.filter((p, i) => {
    if (voteInfos[i]?.owner.equals(VoteProgram.programId)) {
      return true;
    }
    console.warn(
      `[${p.bank.toBase58()}] vote ${p.vote.toBase58()} is missing/not a vote account; skipping`,
    );
    return false;
  });

  console.log(`Sending ${valid.length} backfills in chunks of ${CHUNK_SIZE}`);

  for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
    const chunkIndex = i / CHUNK_SIZE;
    const transaction = new Transaction();

    for (const { bank, vote } of valid.slice(i, i + CHUNK_SIZE)) {
      console.log(`[${bank.toBase58()}] vote=${vote.toBase58()}`);
      transaction.add(
        await program.methods
          .lendingPoolBackfillStakedBankValidatorVoteAccount()
          .accountsPartial({ bank, validatorVoteAccount: vote })
          .instruction(),
      );
    }

    if (sendTx) {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer],
      );
      console.log(`chunk ${chunkIndex} signature:`, signature);
    } else {
      transaction.feePayer = configCommon.MULTISIG_PAYER;
      transaction.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;
      console.log(
        `Base58 tx for chunk ${chunkIndex}:`,
        bs58.encode(
          transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
          }),
        ),
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
});
