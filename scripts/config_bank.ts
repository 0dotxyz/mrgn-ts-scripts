import {
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bigNumberToWrappedI80F48, WrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../lib/common-setup";
import { InterestRateConfigOpt1_6 } from "./common/types";

/**
 * If true, send the txs. If false, output the unsigned b58 v0 txs to console.
 */
const sendTx = false;

export type BankConfigPair = {
  bank: PublicKey;
  config: BankConfigOptRaw;
};

export type Config = {
  PROGRAM_ID: string;
  ADMIN: PublicKey;
  LUT: PublicKey;

  /**
   * Exclude if not using MS
   */
  MULTISIG_PAYER?: PublicKey;

  /**
   * Array of banks and their corresponding config overrides.
   */
  BANKS: PublicKey[];
  CONFIG: BankConfigOptRaw;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  //MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  BANKS: [
    // 1 BATCH
    new PublicKey("22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE"),
    new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"),
    new PublicKey("3RVamPQE3nDViuUU7wdZJgnru7Q93cRzdysXA8kjxMiq"),
    new PublicKey("4ecRL7M2fdmWjZd81PTZ9Sqg1e47ZpiwhkeDbsBJtqax"),
    new PublicKey("5KjGKr7pKBG7DLcPdZTiSji7cwNYJ5ERj2pPSNLTejoZ"),
    new PublicKey("5syijTAMBBmdjwUgYYBvvv26zTS6YX1bYV9EdXkgYqLa"),
    new PublicKey("5wZz2MV3dFJVq3Wp4tBoqrgrSGZqeLCdLE1L4w6okm9g"),
    new PublicKey("61Qx9kgWo9RVtPHf8Rku6gbaUtcnzgkpAuifQBUcMRVK"),
    new PublicKey("6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K"),
    new PublicKey("6zN8tRxMpuqruDF4ChjeNGCVggqWBMQQ9KmiNhYeiqXb"),
    new PublicKey("7GbG8B1aHpV4Q271ozU9EDEGPTLXpekv7m2UgyCgFzr5"),
    new PublicKey("8LaUZadNqtzuCG7iCvZd7d5cbquuYfv19KjAg6GPuuCb"),
    new PublicKey("8UEiPmgZHXXEDrqLS3oiTxQxTbeYTtPbeMBxAd2XGbpu"),

    // 2 BATCH
    new PublicKey("8W3GgWFFnHdd98GKGzvNNi9Wzjoq2CU4wW6cHz6cKxk1"),
    new PublicKey("8efP4VoKDo3SqxoVCUcgxpN9S7boDWtPmeFwahRZ4ukg"),
    new PublicKey("9KbkQsu4EGAeM7ZxvwsZcpxoekZyg5LTk1BF5SAMPXdY"),
    new PublicKey("9p1TiAeTc6FSiNHhnR6BgmwRq49zywczAY4m77BbKGer"),
    new PublicKey("Ac4KV5K5isDqtABtg6h5DiwzZMe3Sp9bc3pBiCUvUpaQ"),
    new PublicKey("Amtw3n7GZe5SWmyhMhaFhDTi39zbTkLeWErBsmZXwpDa"),
    new PublicKey("AwLRW3aPMMftXEjgWhTkYwM9CGBHdtKecvahCJZBwAqY"),
    new PublicKey("BKsfDJCMbYep6gr9pq8PsmJbb5XGLHbAJzUV8vmorz7a"),
    new PublicKey("BkUyfXjbBBALcfZvw76WAFRvYQ21xxMWWeoPtJrUqG3z"),
    new PublicKey("Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8"),
    new PublicKey("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh"),
    new PublicKey("DMoqjmsuoru986HgfjqrKEvPv8YBufvBGADHUonkadC5"),
    new PublicKey("DeyH7QxWvnbbaVB4zFrf4hoq7Q8z1ZT14co42BGwGtfM"),

    // 3 BATCH
    new PublicKey("Dj2CwMF3GM7mMT5hcyGXKuYSQ2kQ5zaVCkA1zX1qaTva"),
    new PublicKey("Dyuh6umsxbLAXKz3SrwXgYmmXuVWE9muYBvFUBPM58NY"),
    new PublicKey("E4td8i8PT2BZkMygzW4MGHCv2KPPs57dvz5W2ZXf9Twu"),
    new PublicKey("EKwXy2ui2jtJnvH4A2XufyqMyeSFecJE8xAKWpZEtDwd"),
    new PublicKey("EmMhorGDR3N9ecNWVQjJi2QpFLkeHEvjZFdW6TuVgXjU"),
    new PublicKey("F4brCRJHx8epWah7p8Ace4ehutphxYZ1ctRq2LS3iiBh"),
    new PublicKey("FDsf8sj6SoV313qrA91yms3u5b3P4hBxEPvanVs8LtJV"),
    new PublicKey("Ffe4RTL4oYrzA9QKQVJ3PCATXnp3mS3s7buDKnnmHYGX"),
    new PublicKey("GR9GNdjWf8kSf3b4REribKKSeVvkzjbAQJ1A8CDnFxLF"),
    new PublicKey("GZcUY6egnYuXHGWPukTo8iKEZiv5CVKXutcphRuKryNE"),
    new PublicKey("Guu5uBc8k1WK1U2ihGosNaCy57LSgCkpWAabtzQqrQf8"),
    new PublicKey("HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV"),
    new PublicKey("JBcir4DPRPYVUpks9hkS1jtHMXejfeBo4xJGv3AYYHg6"),
  ],
  CONFIG: {
    assetWeightInit: null,
    assetWeightMaint: null,
    liabilityWeightInit: null,
    liabilityWeightMaint: null,
    depositLimit: null,
    borrowLimit: null,
    riskTier: null,
    assetTag: null,
    totalAssetValueInitLimit: null,
    interestRateConfig: {
      protocolOriginationFee: null,
      protocolIrFee: null,
      protocolFixedFeeApr: null,
      insuranceIrFee: null,
      insuranceFeeFixedApr: null,
      zeroUtilRate: null,
      hundredUtilRate: null,
      points: null,
    },
    operationalState: null,
    oracleMaxAge: null,
    oracleMaxConfidence: null,
    permissionlessBadDebtSettlement: null,
    freezeSettings: null,
    tokenlessRepaymentsAllowed: true,
  },
};

export function bankConfigOptDefault(): BankConfigOptRaw {
  const bankConfigOpt: BankConfigOptRaw = {
    assetWeightInit: null, // I80, a %
    assetWeightMaint: null, // I80, a %
    liabilityWeightInit: null, // I80, a %
    liabilityWeightMaint: null, // I80, a %
    depositLimit: null, // BN, in native token
    borrowLimit: null, // BN, in native token
    riskTier: null, // { collateral: {} } or { isolated: {} }
    assetTag: null, // 0 - Default, 1 - SOL, 2 - STAKED COLLATERAL
    totalAssetValueInitLimit: null, // BN, in $
    interestRateConfig: {
      protocolOriginationFee: null, // I80, a %
      protocolIrFee: null, // I80, a %
      protocolFixedFeeApr: null, // I80, a %
      insuranceIrFee: null, // I80, a %
      insuranceFeeFixedApr: null, // I80, a %
      zeroUtilRate: null, // u32, a % (out of 1000)
      hundredUtilRate: null, // u32, a % (out of 1000)
      points: null, // pairs of u32 util/rate pairs (out of 100 and 1000 respectively)
    },
    operationalState: { operational: {} }, // { reduceOnly: {} } or { paused: {} }
    oracleMaxAge: null, // number, in seconds
    oracleMaxConfidence: null, // number, a % out of 100%, as u32, e.g. 10% = u32MAX * 0.10
    permissionlessBadDebtSettlement: null, // true or false
    freezeSettings: null,
    tokenlessRepaymentsAllowed: null,
  };
  return bankConfigOpt;
}

async function main() {
  await configBank(sendTx, config, "/.keys/staging-deploy.json");
}

export async function configBank(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
  if (config.BANKS.length === 0) {
    throw new Error("Config.BANKS is empty - nothing to do.");
  }

  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );

  const program = user.program;
  const connection = user.connection;

  // Fetch LUT (hard-coded in config). If not found, we still proceed without it.
  let luts: AddressLookupTableAccount[] = [];
  const lutLookup = await connection.getAddressLookupTable(config.LUT);
  if (!lutLookup || !lutLookup.value) {
    console.warn(
      `Warning: LUT ${config.LUT.toBase58()} not found on-chain. Proceeding without it.`,
    );
    luts = [];
  } else {
    luts = [lutLookup.value];
  }

  for (let i = 0; i < config.BANKS.length; i++) {
    const bank = config.BANKS[i];

    // Choose payer: if broadcasting now, use the local wallet; otherwise, use multisig payer.
    const payerKey = sendTx
      ? user.wallet.publicKey
      : (config.MULTISIG_PAYER ??
        (() => {
          throw new Error("MULTISIG_PAYER must be set when sendTx = false");
        })());

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const ix = await program.methods
      .lendingPoolConfigureBank(config.CONFIG)
      .accounts({
        bank,
      })
      .accountsPartial({
        admin: config.ADMIN,
      })
      .instruction();

    if (sendTx) {
      const v0Message = new TransactionMessage({
        payerKey,
        recentBlockhash: blockhash,
        instructions: [ix],
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

      console.log("tx signature:", signature);
    } else {
      // No versioned tx for squads (yet)
      let transaction = new Transaction().add(ix);
      transaction.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      const serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const base58Transaction = bs58.encode(serializedTransaction);
      console.log("Base58-encoded transaction:", base58Transaction);
    }
  }
}

const ASSET_TAG_DEFAULT = 0;
const ASSET_TAG_SOL = 1;
const ASSET_TAG_STAKED = 2;

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}

type BankConfigOptRaw = {
  assetWeightInit: WrappedI80F48 | null;
  assetWeightMaint: WrappedI80F48 | null;

  liabilityWeightInit: WrappedI80F48 | null;
  liabilityWeightMaint: WrappedI80F48 | null;

  depositLimit: BN | null;
  borrowLimit: BN | null;
  riskTier: { collateral: {} } | { isolated: {} } | null;
  assetTag: number | null;
  totalAssetValueInitLimit: BN | null;

  interestRateConfig: InterestRateConfigOpt1_6 | null;
  operationalState:
    | { paused: {} }
    | { operational: {} }
    | { reduceOnly: {} }
    | null;

  oracleMaxConfidence: number | null;
  oracleMaxAge: number | null;
  permissionlessBadDebtSettlement: boolean | null;
  freezeSettings: boolean | null;
  tokenlessRepaymentsAllowed: boolean | null;
};
