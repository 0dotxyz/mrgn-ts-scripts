import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assertI80F48Approx, assertKeysEqual } from "./softTests";
import { commonSetup } from "../lib/common-setup";

const verbose = true;

type Config = {
  PROGRAM_ID: string;
  GROUP_KEYS: PublicKey[];
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEYS: [
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    // Up to ~30 groups per script execution
  ],
};

const deriveGlobalFeeState = (programId: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("feestate", "utf-8")],
    programId,
  );
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.keys/staging-deploy.json",
    undefined,
    "current",
  );
  const program = user.program;

  const transaction = new Transaction();
  for (const groupKey of config.GROUP_KEYS) {
    const ix = await program.methods
      .propagateFeeState()
      .accounts({
        // feeState: derived automatically from static PDA
        marginfiGroup: groupKey,
      })
      .instruction();

    transaction.add(ix);
  }

  try {
    const signature = await sendAndConfirmTransaction(
      user.connection,
      transaction,
      [user.wallet.payer],
    );
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }

  const [feeStateKey] = deriveGlobalFeeState(program.programId);
  const feeState = await program.account.feeState.fetch(feeStateKey);
  const groups = await program.account.marginfiGroup.fetchMultiple(
    config.GROUP_KEYS,
  );

  if (verbose) {
    console.log("fee state: " + feeStateKey);
  }
  for (let i = 0; i < config.GROUP_KEYS.length; i++) {
    const group = groups[i];
    const cache = group.feeStateCache;

    if (verbose) {
      console.log("[" + i + "] checking group: " + config.GROUP_KEYS[i]);
    }

    assertKeysEqual(feeState.globalFeeWallet, cache.globalFeeWallet);
    assertI80F48Approx(feeState.programFeeFixed, cache.programFeeFixed);
    assertI80F48Approx(feeState.programFeeRate, cache.programFeeRate);

    if (verbose) {
      console.log("   " + config.GROUP_KEYS[i] + " ok");
    }
  }
}

main().catch((err) => {
  console.error(err);
});
