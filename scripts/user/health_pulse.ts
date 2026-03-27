import {
  AccountMeta,
  Commitment,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bytesToF64, getOraclesAndCrankSwb } from "../../lib/utils";
import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { KLEND_PROGRAM_ID } from "../kamino/kamino-types";

export type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;

  /** Optional */
  LUT: PublicKey | undefined;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("9BEFUYsNsASkQFxBMcXis2giLrFL6QEitsZ49YhVC7Pw"),

  LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
};

async function main() {
  await pulseHealth(config, "/.config/solana/id.json");
}

export async function pulseHealth(
  config: Config,
  walletPath: string,
  version?: "current",
) {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    walletPath,
    undefined,
    version,
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  let [activeBalances, kaminoIxes] = await getOraclesAndCrankSwb(
    program,
    user.kaminoProgram,
    config.ACCOUNT,
    connection,
    user.wallet.payer,
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
