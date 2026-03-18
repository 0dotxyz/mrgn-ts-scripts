// Change settings for an existing group's staked settings. To update banks and force them to accept
// these settings, propagate them to the banks (presumably there's an API for this by the time
// you're reading this)
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  WrappedI80F48,
  bigNumberToWrappedI80F48,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../lib/common-setup";
import {
  assertKeysEqual,
  assertI80F48Approx,
  assertBNEqual,
} from "../scripts/softTests";
import { deriveStakedSettings } from "../scripts/common/pdas";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;
const verbose = true;

type Config = {
  PROGRAM_ID: string;
  ADMIN: PublicKey;
  GROUP_KEY: PublicKey;
  // Keep undefined for any field you wish to leave as-is on-chain
  MULTISIG?: PublicKey; // May be omitted if not using squads
  SOL_ORACLE?: PublicKey;
  ASSET_WEIGHT_INIT?: number;
  ASSET_WEIGHT_MAINT?: number;
  DEPOSIT_LIMIT?: BN;
  TOTAL_ASSET_VALUE_INIT_LIMIT?: BN;
  ORACLE_MAX_AGE?: number;
  RISK_TIER: { collateral: {} } | { isolated: {} } | null;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEY: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  // Leave these undefined if you do NOT want them to be changed
  SOL_ORACLE: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  ASSET_WEIGHT_INIT: undefined,
  ASSET_WEIGHT_MAINT: undefined,
  DEPOSIT_LIMIT: undefined,
  TOTAL_ASSET_VALUE_INIT_LIMIT: undefined,
  ORACLE_MAX_AGE: undefined,
  RISK_TIER: undefined,
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/keys/staging-deploy.json",
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  let [stakedSettingsKey] = deriveStakedSettings(
    program.programId,
    config.GROUP_KEY,
  );

  const editSettings: StakedSettingsEdit = {
    oracle: config.SOL_ORACLE !== undefined ? config.SOL_ORACLE : null,
    assetWeightInit:
      config.ASSET_WEIGHT_INIT !== undefined
        ? bigNumberToWrappedI80F48(config.ASSET_WEIGHT_INIT)
        : null,
    assetWeightMaint:
      config.ASSET_WEIGHT_MAINT !== undefined
        ? bigNumberToWrappedI80F48(config.ASSET_WEIGHT_MAINT)
        : null,
    depositLimit:
      config.DEPOSIT_LIMIT !== undefined ? config.DEPOSIT_LIMIT : null,
    totalAssetValueInitLimit:
      config.TOTAL_ASSET_VALUE_INIT_LIMIT !== undefined
        ? config.TOTAL_ASSET_VALUE_INIT_LIMIT
        : null,
    oracleMaxAge:
      config.ORACLE_MAX_AGE !== undefined ? config.ORACLE_MAX_AGE : null,
    riskTier: config.RISK_TIER !== undefined ? config.RISK_TIER : null,
  };

  let stakedSettingsAccBefore =
    await program.account.stakedSettings.fetch(stakedSettingsKey);

  const tx = new Transaction();
  tx.add(
    await program.methods
      .editStakedSettings(editSettings)
      .accountsPartial({
        // group: args.group, // implied from stakedSettings
        admin: config.ADMIN,
        stakedSettings: stakedSettingsKey,
      })
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [
        user.wallet.payer,
      ]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Couldn't confirm in time or error:", error);
    }

    if (verbose) {
      let stakedSettingsAcc =
        await program.account.stakedSettings.fetch(stakedSettingsKey);

      if (config.SOL_ORACLE !== undefined) {
        assertKeysEqual(stakedSettingsAcc.oracle, config.SOL_ORACLE);
        console.log("sol oracle: " + stakedSettingsAcc.oracle);
        console.log("was: " + stakedSettingsAccBefore.oracle);
      }

      if (config.ASSET_WEIGHT_INIT !== undefined) {
        assertI80F48Approx(
          stakedSettingsAcc.assetWeightInit,
          bigNumberToWrappedI80F48(config.ASSET_WEIGHT_INIT),
        );
        console.log(
          "assetWeightInit: " +
            wrappedI80F48toBigNumber(
              stakedSettingsAcc.assetWeightInit,
            ).toString(),
        );
        console.log(
          "was: " +
            wrappedI80F48toBigNumber(
              stakedSettingsAccBefore.assetWeightInit,
            ).toString(),
        );
      }

      if (config.ASSET_WEIGHT_MAINT !== undefined) {
        assertI80F48Approx(
          stakedSettingsAcc.assetWeightMaint,
          bigNumberToWrappedI80F48(config.ASSET_WEIGHT_MAINT),
        );
        console.log(
          "assetWeightMaint: " +
            wrappedI80F48toBigNumber(
              stakedSettingsAcc.assetWeightMaint,
            ).toString(),
        );
        console.log(
          "was: " +
            wrappedI80F48toBigNumber(
              stakedSettingsAccBefore.assetWeightMaint,
            ).toString(),
        );
      }

      if (config.DEPOSIT_LIMIT !== undefined) {
        assertBNEqual(stakedSettingsAcc.depositLimit, config.DEPOSIT_LIMIT);
        console.log(
          "depositLimit: " + stakedSettingsAcc.depositLimit.toString(),
        );
        console.log("was: " + stakedSettingsAccBefore.depositLimit.toString());
      }

      if (config.TOTAL_ASSET_VALUE_INIT_LIMIT !== undefined) {
        assertBNEqual(
          stakedSettingsAcc.totalAssetValueInitLimit,
          config.TOTAL_ASSET_VALUE_INIT_LIMIT,
        );
        console.log(
          "totalAssetValueInitLimit: " +
            stakedSettingsAcc.totalAssetValueInitLimit.toString(),
        );
        console.log(
          "was: " + stakedSettingsAccBefore.totalAssetValueInitLimit.toString(),
        );
      }

      if (config.ORACLE_MAX_AGE !== undefined) {
        assertBNEqual(
          new BN(stakedSettingsAcc.oracleMaxAge),
          new BN(config.ORACLE_MAX_AGE),
        );
        console.log("oracleMaxAge: " + stakedSettingsAcc.oracleMaxAge);
        console.log("was: " + stakedSettingsAccBefore.oracleMaxAge);
      }

      if (config.RISK_TIER !== undefined) {
        console.log("oracle risk tier: " + stakedSettingsAcc.riskTier);
        console.log("was: " + stakedSettingsAccBefore.riskTier);
      }
    }
  } else {
    tx.feePayer = config.MULTISIG; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    const serializedTransaction = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

interface StakedSettingsEdit {
  oracle: PublicKey | null;

  assetWeightInit: WrappedI80F48 | null;
  assetWeightMaint: WrappedI80F48 | null;

  depositLimit: BN | null;
  totalAssetValueInitLimit: BN | null;

  oracleMaxAge: number | null;
  riskTier: { collateral: {} } | { isolated: {} } | null;
}

main().catch((err) => {
  console.error(err);
});
