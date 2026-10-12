import {
  AccountMeta,
  Commitment,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bytesToF64, getOraclesAndKaminoIxes } from "../../lib/utils";
import {
  commonSetup,
  registerJuplendProgram,
  registerKaminoProgram,
} from "../../lib/common-setup";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import { JUPLEND_LENDING_PROGRAM_ID } from "../juplend/lib/utils";

export type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;

  /** Optional */
  LUT: PublicKey | undefined;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("2mXuJpnznBhxVv67kDBDGNTZbFxHeP3WVH7W2M6UCYAC"),

  LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
};

async function main() {
  await pulseHealth(config, "/.config/solana/id.json");
}

export async function pulseHealth(
  config: Config,
  walletPath: string,
) {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    walletPath,
    undefined,
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  registerJuplendProgram(user, JUPLEND_LENDING_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  let [activeBalances, kaminoIxes] = await getOraclesAndKaminoIxes(
    program,
    user.kaminoProgram,
    config.ACCOUNT,
    user.juplendProgram,
  );

  const oracleMeta: AccountMeta[] = activeBalances.flat().map((pubkey) => {
    return { pubkey, isSigner: false, isWritable: false };
  });
  const transaction = new Transaction();
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
    ...kaminoIxes,
    await program.methods
      .lendingAccountPulseHealth()
      .accounts({
        marginfiAccount: config.ACCOUNT,
      })
      .remainingAccounts(oracleMeta)
      .instruction(),
  );

  try {
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const lut = config.LUT
      ? [(await connection.getAddressLookupTable(config.LUT)).value]
      : [];

    const v0Message = new TransactionMessage({
      payerKey: user.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: transaction.instructions,
    }).compileToV0Message(lut);

    const commitment: Commitment = "confirmed";
    const v0Tx = new VersionedTransaction(v0Message);
    v0Tx.sign([user.wallet.payer]);

    const signature = await connection.sendTransaction(v0Tx, {
      maxRetries: 2,
    });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      commitment,
    );
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }
  let accAfter = await program.account.marginfiAccount.fetch(config.ACCOUNT);
  let cache = accAfter.healthCache;

  console.log("err: " + cache.mrgnErr);
  console.log("internal err: " + cache.internalErr);
  console.log("err index: " + cache.errIndex);
  console.log("liq err: " + cache.internalLiqErr);
  console.log("bankrupt err: " + cache.internalBankruptcyErr);
  console.log("flags: " + cache.flags);
  console.log("");
  console.log(
    "asset value: " + wrappedI80F48toBigNumber(cache.assetValue).toNumber(),
  );
  console.log(
    "liab value: " + wrappedI80F48toBigNumber(cache.liabilityValue).toNumber(),
  );
  console.log(
    "asset value (maint): " +
      wrappedI80F48toBigNumber(cache.assetValueMaint).toNumber(),
  );
  console.log(
    "liab value (maint): " +
      wrappedI80F48toBigNumber(cache.liabilityValueMaint).toNumber(),
  );
  console.log(
    "asset value (equity): " +
      wrappedI80F48toBigNumber(cache.assetValueEquity).toNumber(),
  );
  console.log(
    "liab value (equity): " +
      wrappedI80F48toBigNumber(cache.liabilityValueEquity).toNumber(),
  );
  console.log("");
  for (let i = 0; i < cache.prices.length; i++) {
    const price = bytesToF64(cache.prices[i]);
    if (price != 0) {
      console.log("price of balance " + i + ": " + price.toFixed(10));
    }
  }
  return cache;
}

/**
 * Throws unless the pulse priced every balance. `pulse_health` itself never fails: an oracle
 * problem is recorded in the cache and the values are left at zero, so a caller that reads health
 * off the cache must check this first. The program's own flags are the test: `ENGINE_OK` is set
 * whenever the risk engine ran (an unhealthy account still records `mrgn_err` 6009,
 * RiskEngineInitRejected) and `ORACLE_OK` is cleared on any oracle or internal error.
 */
export function assertHealthCacheOk(cache: any) {
  const ENGINE_OK = 2;
  const ORACLE_OK = 4;
  if ((cache.flags & ENGINE_OK) === 0 || (cache.flags & ORACLE_OK) === 0) {
    throw new Error(
      `health cache is not usable: flags ${cache.flags}, mrgn_err ${cache.mrgnErr}, ` +
        `internal_err ${cache.internalErr} (balance index ${cache.errIndex}); ` +
        `fix the oracle / venue refresh before going on`,
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}

export type HealthPulseArgs = {
  marginfiAccount: PublicKey;
  remaining: PublicKey[];
};
