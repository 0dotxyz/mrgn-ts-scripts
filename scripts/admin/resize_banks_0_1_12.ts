import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { loadKeypairFromFile } from "../../lib/utils";
import { DEFAULT_API_URL, loadEnvFile } from "../utils/utils";

/**
 * 0.1.12 bank account-size migration (permissionless).
 *
 * `Bank` grows from 1856 to 3904 bytes (+8 discriminator). The upgraded program cannot load an
 * unresized bank, so every tx touching one fails (including health checks of accounts that hold
 * a position in it) until `lending_pool_resize_bank_account` runs on it. Group and FeeState sizes
 * are unchanged from 0.1.10/0.1.11.
 *
 * Patch notes commit the admin to resizing the main group; other group admins resize their own.
 * The wallet only pays the rent delta: up to ~0.0104 SOL per bank, less where a bank already
 * holds spare lamports (~1.36 SOL for the 204 main-group banks as of 2026-10-11).
 *
 * Idempotent: only banks still at the old size are fetched, so re-running picks up whatever is
 * left. Each round sends all batches in parallel, then re-scans; it stops when nothing is left.
 *
 * Run right AFTER the program upgrade confirms. Before the upgrade, simulation fails with
 * InstructionFallbackNotFound (0x65) because 0.1.11 has no such instruction. The upgraded program
 * is also not invocable in its deploy slot; the next round retries automatically.
 *
 *   npx tsx scripts/admin/resize_banks_0_1_12.ts
 */
const sendTx = true;

type Config = {
  PROGRAM_ID: PublicKey;
  /** Groups whose banks get resized. */
  GROUPS: PublicKey[];
  /** Pays the rent delta and fees. Any funded wallet; no admin rights needed. */
  WALLET_PATH: string;
  /** Priority fee, micro-lamports per CU. The resize lands during an outage; don't go cheap. */
  CU_PRICE_MICRO_LAMPORTS: number;
};

const config: Config = {
  // production
  PROGRAM_ID: new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
  GROUPS: [new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8")],
  // staging
  // PROGRAM_ID: new PublicKey("stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct"),
  // GROUPS: [new PublicKey("FCPfpHA69EbS8f9KKSreTRkXbzFpunsKuYf5qNmnJjpo")],
  WALLET_PATH: "~/.config/solana/id.json",
  CU_PRICE_MICRO_LAMPORTS: 50_000,
};

// Raw ix: the checked-in idl/marginfi.json predates 0.1.12 and lacks this instruction.
// sha256("global:lending_pool_resize_bank_account")[..8], matches the 0.1.12 IDL.
const RESIZE_BANK_DISC = Buffer.from([44, 109, 34, 113, 110, 33, 139, 160]);
const BANK_DISC = Buffer.from([142, 49, 166, 242, 50, 66, 97, 188]);

/** 8-byte discriminator + struct size, per type-crate assert_struct_size */
const BANK_OLD_LEN = 8 + 1856;
const BANK_TARGET_LEN = 8 + 3904;
/** Bank layout: discriminator (8) | mint (32) | mint_decimals (1) | group (32) */
const BANK_GROUP_OFFSET = 41;

/** Round 1 batches for speed; later rounds go one bank per tx so a failing bank can't block others. */
const BANKS_PER_TX = 10;
const MAX_ROUNDS = 5;
const ROUND_DELAY_MS = 3_000;
const SIMULATION_CU_LIMIT = 1_400_000;
const MULTIPLE_ACCOUNTS_LIMIT = 100;

function resizeIx(bank: PublicKey, payer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: config.PROGRAM_ID,
    keys: [
      { pubkey: bank, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: RESIZE_BANK_DISC,
  });
}

type Pending = { bank: PublicKey; lamports: number };

/**
 * Banks of `group` still at the pre-0.1.12 size. getProgramAccounts can serve a lagging index, so
 * each candidate's size is re-read with getMultipleAccountsInfo before it counts as pending.
 */
async function unresizedBanks(
  connection: Connection,
  group: PublicKey,
): Promise<Pending[]> {
  const candidates = await connection.getProgramAccounts(config.PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { dataSize: BANK_OLD_LEN },
      { memcmp: { offset: 0, bytes: bs58.encode(BANK_DISC) } },
      { memcmp: { offset: BANK_GROUP_OFFSET, bytes: group.toBase58() } },
    ],
  });
  const pending: Pending[] = [];
  for (let i = 0; i < candidates.length; i += MULTIPLE_ACCOUNTS_LIMIT) {
    const keys = candidates
      .slice(i, i + MULTIPLE_ACCOUNTS_LIMIT)
      .map((c) => c.pubkey);
    const infos = await connection.getMultipleAccountsInfo(keys);
    for (let j = 0; j < keys.length; j++) {
      const info = infos[j];
      if (info && info.data.length < BANK_TARGET_LEN) {
        pending.push({ bank: keys[j], lamports: info.lamports });
      }
    }
  }
  return pending;
}

async function allUnresized(connection: Connection): Promise<Pending[]> {
  const pending: Pending[] = [];
  for (const group of config.GROUPS) {
    const banks = await unresizedBanks(connection, group);
    console.log(`group ${group.toBase58()}: ${banks.length} banks need resize`);
    pending.push(...banks);
  }
  return pending;
}

type SignedTx = {
  tx: VersionedTransaction;
  blockhash: string;
  lastValidBlockHeight: number;
};

async function buildTx(
  connection: Connection,
  wallet: Keypair,
  banks: PublicKey[],
  cuLimit: number,
): Promise<SignedTx> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: config.CU_PRICE_MICRO_LAMPORTS,
      }),
      ...banks.map((b) => resizeIx(b, wallet.publicKey)),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);
  return { tx, blockhash, lastValidBlockHeight };
}

/** Simulates one batch, then sends it with a CU limit sized from the simulation. */
async function resizeBatch(
  connection: Connection,
  wallet: Keypair,
  banks: PublicKey[],
  label: string,
): Promise<void> {
  const { tx: simTx } = await buildTx(
    connection,
    wallet,
    banks,
    SIMULATION_CU_LIMIT,
  );
  const sim = await connection.simulateTransaction(simTx, {
    sigVerify: false,
  });
  if (sim.value.err) {
    const logs = (sim.value.logs ?? [])
      .slice(-6)
      .map((l) => `\n    ${l}`)
      .join("");
    throw new Error(
      `${label}: simulation failed ${JSON.stringify(sim.value.err)}${logs}`,
    );
  }
  const used = sim.value.unitsConsumed ?? SIMULATION_CU_LIMIT;
  if (!sendTx) {
    console.log(`${label}: simulated OK (${used} CU)`);
    return;
  }

  const { tx, blockhash, lastValidBlockHeight } = await buildTx(
    connection,
    wallet,
    banks,
    Math.ceil(used * 1.2),
  );
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: true,
    maxRetries: 5,
  });
  const res = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  if (res.value.err) {
    throw new Error(
      `${label}: tx ${signature} failed ${JSON.stringify(res.value.err)}`,
    );
  }
  console.log(`${label}: ${signature} (${used} CU)`);
}

async function checkFunding(
  connection: Connection,
  wallet: Keypair,
  pending: Pending[],
) {
  const target =
    await connection.getMinimumBalanceForRentExemption(BANK_TARGET_LEN);
  let rent = 0;
  for (const p of pending) rent += Math.max(0, target - p.lamports);
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(
    `rent top-up: ${rent / 1e9} SOL, payer balance: ${balance / 1e9} SOL`,
  );
  if (balance >= rent * 1.05) return;
  const msg = `payer ${wallet.publicKey.toBase58()} needs ~${(rent * 1.05) / 1e9} SOL, has ${balance / 1e9}`;
  if (sendTx) throw new Error(msg);
  console.warn(`WARN ${msg}`);
}

async function runRound(
  connection: Connection,
  wallet: Keypair,
  pending: Pending[],
  perTx: number,
) {
  const batches: PublicKey[][] = [];
  for (let i = 0; i < pending.length; i += perTx) {
    batches.push(pending.slice(i, i + perTx).map((p) => p.bank));
  }
  const results = await Promise.allSettled(
    batches.map((b, i) =>
      resizeBatch(connection, wallet, b, `batch ${i + 1}/${batches.length}`),
    ),
  );
  const errors: string[] = [];
  for (const r of results) {
    if (r.status === "rejected") errors.push((r.reason as Error).message);
  }
  for (const e of errors) console.error(`  ${e}`);
  return errors;
}

async function main() {
  loadEnvFile(".env.api");
  const connection = new Connection(
    process.env.API_URL || DEFAULT_API_URL,
    "confirmed",
  );
  const wallet = loadKeypairFromFile(config.WALLET_PATH);
  console.log("program:", config.PROGRAM_ID.toBase58());
  console.log("payer:", wallet.publicKey.toBase58());

  let pending = await allUnresized(connection);
  if (pending.length > 0) await checkFunding(connection, wallet, pending);

  for (let round = 1; round <= MAX_ROUNDS && pending.length > 0; round++) {
    if (round > 1) await new Promise((r) => setTimeout(r, ROUND_DELAY_MS));
    const perTx = round === 1 ? BANKS_PER_TX : 1;
    console.log(`round ${round}: ${pending.length} banks, ${perTx} per tx`);
    const errors = await runRound(connection, wallet, pending, perTx);
    if (errors.some((e) => e.includes("InstructionFallbackNotFound"))) {
      throw new Error(
        "program has no lending_pool_resize_bank_account: the 0.1.12 upgrade has not landed yet. " +
          "Nothing was sent; re-run once the upgrade tx is confirmed.",
      );
    }
    if (!sendTx) return;
    pending = await allUnresized(connection);
  }

  if (pending.length > 0) {
    console.error(`FAIL ${pending.length} banks still unresized:`);
    for (const p of pending) console.error(`  ${p.bank.toBase58()}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "OK all banks in the configured groups are at",
    BANK_TARGET_LEN,
    "bytes",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
