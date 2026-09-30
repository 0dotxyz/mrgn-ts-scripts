// Runs once per group, before any staked banks can be init.
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  bigNumberToWrappedI80F48,
  WrappedI80F48,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import { RiskTierRaw } from "@mrgnlabs/marginfi-client-v2";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../lib/common-setup";
import { deriveStakedSettings } from "../scripts/common/pdas";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;
const verbose = true;

export type Config = {
  PROGRAM_ID: string;
  GROUP_KEY: PublicKey;
  SOL_ORACLE: PublicKey;
  // Keep default values to use the defaults...
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
  ASSET_WEIGHT_INIT?: number;
  ASSET_WEIGHT_MAINT?: number;
  DEPOSIT_LIMIT?: BN;
  TOTAL_ASSET_VALUE_INIT_LIMIT?: BN;
  ORACLE_MAX_AGE?: number;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEY: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  SOL_ORACLE: new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"),
  MULTISIG_PAYER: new PublicKey("AZtUUe9GvTFq9kfseu9jxTioSgdSfjgmZfGQBmhVpTj1"),

  ASSET_WEIGHT_INIT: 0.8,
  ASSET_WEIGHT_MAINT: 0.9,
  DEPOSIT_LIMIT: new BN(10_000_000_000), // dunno, in native sol decimals...
  TOTAL_ASSET_VALUE_INIT_LIMIT: new BN(100_000_000_000), // dunno, in $
  ORACLE_MAX_AGE: 120,
};

async function main() {
  await initStakedSettings(sendTx, config, "/keys/staging-deploy.json");
}

export async function initStakedSettings(
  sendTx: boolean,
  config: Config,
  walletPath: string,
): Promise<PublicKey> {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;

  const settings = defaultStakedInterestSettings(config.SOL_ORACLE);
  if (config.ASSET_WEIGHT_INIT !== undefined) {
    settings.assetWeightInit = bigNumberToWrappedI80F48(
      config.ASSET_WEIGHT_INIT,
    );
  }
  if (config.ASSET_WEIGHT_MAINT !== undefined) {
    settings.assetWeightMaint = bigNumberToWrappedI80F48(
      config.ASSET_WEIGHT_MAINT,
    );
  }
  if (config.DEPOSIT_LIMIT !== undefined) {
    settings.depositLimit = config.DEPOSIT_LIMIT;
  }
  if (config.TOTAL_ASSET_VALUE_INIT_LIMIT !== undefined) {
    settings.totalAssetValueInitLimit = config.TOTAL_ASSET_VALUE_INIT_LIMIT;
  }
  if (config.ORACLE_MAX_AGE !== undefined) {
    settings.oracleMaxAge = config.ORACLE_MAX_AGE;
  }

  const [stakedSettingsKey] = deriveStakedSettings(
    program.programId,
    config.GROUP_KEY,
  );

  const transaction = new Transaction();
  transaction.add(
    await program.methods
      .initStakedSettings(settings)
      .accountsPartial({
        marginfiGroup: config.GROUP_KEY,
        admin: sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER,
        feePayer: sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER,
        // staked_settings: deriveStakedSettings()
      })
      .instruction(),
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

    if (verbose) {
      console.log("staked settings: " + stakedSettingsKey);
      const acc = await program.account.stakedSettings.fetch(stakedSettingsKey);
      console.log("oracle: " + acc.oracle);
      console.log(
        "asset weight init/maint: " +
          wrappedI80F48toBigNumber(acc.assetWeightInit).toString() +
          " / " +
          wrappedI80F48toBigNumber(acc.assetWeightMaint).toString(),
      );
      console.log("deposit limit: " + acc.depositLimit.toString());
      console.log("oracle max age: " + acc.oracleMaxAge);
    }
  } else {
    transaction.feePayer = config.MULTISIG_PAYER;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    console.log(
      "Base58-encoded transaction:",
      bs58.encode(serializedTransaction),
    );
  }

  return stakedSettingsKey;
}

// TODO remove when package updates
type StakedSettingsConfig = {
  oracle: PublicKey;

  assetWeightInit: WrappedI80F48;
  assetWeightMaint: WrappedI80F48;

  depositLimit: BN;
  totalAssetValueInitLimit: BN;

  oracleMaxAge: number;
  /** Collateral = 0, Isolated = 1 */
  riskTier: RiskTierRaw;
};

const defaultStakedInterestSettings = (oracle: PublicKey) => {
  let settings: StakedSettingsConfig = {
    oracle: oracle,
    assetWeightInit: bigNumberToWrappedI80F48(0.8),
    assetWeightMaint: bigNumberToWrappedI80F48(0.9),
    depositLimit: new BN(1_000_000_000_000), // 1000 SOL
    totalAssetValueInitLimit: new BN(150_000_000),
    oracleMaxAge: 60,
    riskTier: {
      collateral: undefined,
    },
  };
  return settings;
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
