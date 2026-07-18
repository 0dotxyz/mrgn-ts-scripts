import fs from "fs";
import path from "path";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { isRateLimit, makePacer, withRetry } from "./rpc_throttle";

const BASE_FEE_LAMPORTS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 20;
const MAX_RATE_LIMIT_RETRIES = 5;

export type BatchSendOptions<T> = {
  connection: Connection;
  payer: Keypair;
  /** Pre-built batches; each becomes one transaction */
  batches: T[][];
  /** Instructions for one transaction covering the given items */
  buildIxs: (items: T[]) => TransactionInstruction[];
  /** Identifier used in logs and the failed-items file */
  label: (item: T) => string;
  /** Failed-item list is written to logs/<failedLogName> for later retry */
  failedLogName: string;
  /** Concurrent transactions in flight (default 8) */
  concurrency?: number;
  /** Global cap on transaction sends per second (default 8); lower this on 429s */
  requestsPerSecond?: number;
  /** Compute unit limit per transaction (default 1,400,000) */
  computeUnits?: number;
  /** Priority fee in micro-lamports per CU (default 0 = no priority fee) */
  priorityFeeMicroLamports?: number;
};

export type BatchSendResult = { succeeded: number; failed: string[] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends batched transactions with bounded concurrency. A failed multi-item batch is retried
 * item by item so one bad item cannot sink the rest. Blockhash-expiry timeouts are re-checked
 * against the chain before being counted as failures. Aborts after a run of consecutive
 * failures (drained wallet, wrong program, RPC outage) instead of grinding on, and always
 * writes surviving failures to logs/ for retry.
 */
export async function sendBatches<T>(
  opts: BatchSendOptions<T>,
): Promise<BatchSendResult> {
  const { connection, payer, batches, buildIxs, label } = opts;
  const concurrency = opts.concurrency ?? 8;
  const pace = makePacer(opts.requestsPerSecond ?? 8);
  const computeUnits = opts.computeUnits ?? 1_400_000;
  const priorityFee = opts.priorityFeeMicroLamports ?? 0;
  const totalItems = batches.reduce((n, b) => n + b.length, 0);

  if (batches.length === 0) {
    return { succeeded: 0, failed: [] };
  }

  const balance = await withRetry(() => connection.getBalance(payer.publicKey));
  const feePerTx =
    BASE_FEE_LAMPORTS + Math.ceil((computeUnits * priorityFee) / 1_000_000);
  const estimatedFees = batches.length * feePerTx;
  if (balance < estimatedFees * 2) {
    throw new Error(
      `Payer balance ${balance / 1e9} SOL is below 2x the estimated base fees ` +
        `(${(estimatedFees * 2) / 1e9} SOL for ${batches.length} txs plus retry headroom); top up before running`,
    );
  }

  let succeeded = 0;
  let processedBatches = 0;
  const failed: string[] = [];
  let consecutiveFailures = 0;
  let aborted = false;

  // Returns once the tx is confirmed. Expiry timeouts are re-checked on chain before
  // counting as failure. Rate-limit errors are retried in place: a 429 fires before the
  // tx reaches the cluster, so re-sending cannot double-execute.
  const sendOne = async (items: T[]): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      );
      if (priorityFee > 0) {
        tx.add(
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: priorityFee,
          }),
        );
      }
      tx.add(...buildIxs(items));
      try {
        await pace();
        await sendAndConfirmTransaction(connection, tx, [payer]);
        return;
      } catch (error) {
        if (error instanceof TransactionExpiredBlockheightExceededError) {
          const status = await withRetry(() =>
            connection.getSignatureStatus(error.signature, {
              searchTransactionHistory: true,
            }),
          );
          const value = status.value;
          if (
            value &&
            value.err === null &&
            (value.confirmationStatus === "confirmed" ||
              value.confirmationStatus === "finalized")
          ) {
            return;
          }
          throw error;
        }
        if (isRateLimit(error) && attempt < MAX_RATE_LIMIT_RETRIES) {
          await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt));
          continue;
        }
        throw error;
      }
    }
  };

  const recordFailure = (item: T, error: unknown) => {
    failed.push(label(item));
    consecutiveFailures++;
    console.error(`  ${label(item)} failed: ${errorMessage(error)}`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) aborted = true;
  };

  const processBatch = async (batch: T[]) => {
    if (aborted) {
      failed.push(...batch.map(label));
      return;
    }
    try {
      await sendOne(batch);
      succeeded += batch.length;
      consecutiveFailures = 0;
    } catch (batchError) {
      if (batch.length === 1) {
        recordFailure(batch[0], batchError);
      } else {
        console.warn(
          `Batch of ${batch.length} failed (${errorMessage(batchError)}); retrying items individually`,
        );
        for (const item of batch) {
          if (aborted) {
            failed.push(label(item));
            continue;
          }
          try {
            await sendOne([item]);
            succeeded += 1;
            consecutiveFailures = 0;
          } catch (itemError) {
            recordFailure(item, itemError);
          }
        }
      }
    }
    processedBatches++;
    if (processedBatches % 20 === 0 || processedBatches === batches.length) {
      console.log(
        `Progress: ${processedBatches}/${batches.length} txs, ${succeeded}/${totalItems} items ok, ${failed.length} failed`,
      );
    }
  };

  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, batches.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= batches.length) break;
        await processBatch(batches[i]);
      }
    },
  );
  await Promise.all(workers);

  if (aborted) {
    console.error(
      `Aborted after ${MAX_CONSECUTIVE_FAILURES} consecutive failures; remaining items were not sent`,
    );
  }
  if (failed.length > 0) {
    const logsDir = path.join(process.cwd(), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const filePath = path.join(logsDir, opts.failedLogName);
    fs.writeFileSync(filePath, JSON.stringify(failed, null, 2));
    console.log(`${failed.length} failed items written to: ${filePath}`);
  }

  console.log(`Done. Succeeded: ${succeeded}, failed: ${failed.length}`);
  return { succeeded, failed };
}
