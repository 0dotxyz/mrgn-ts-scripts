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
import { commonSetup } from "../../lib/common-setup";
import { InterestRateConfigOpt1_6 } from "../common/types";

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
  BANKS: BankConfigPair[];
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  //MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  // One tx per entry in this array:
  BANKS: [
    {
      bank: new PublicKey("6Fk3bzhqmUqupk6sN5CbfYMdafvyzDdqDNHW5CsJzq8K"), // BLZE-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("2000000000000000000"),
        borrowLimit: new BN("73807292000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("GZcUY6egnYuXHGWPukTo8iKEZiv5CVKXutcphRuKryNE"), // DUST-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("0"),
        borrowLimit: new BN("0"),
        riskTier: { collateral: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("HWA59PLUXJmgrjGPWE2eH1381Wnz512qocV4PtyqhKqs"), // HONEY-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("52521008000000000"),
        borrowLimit: new BN("52521000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("BDo6z3urnxkMBPWP1PTcPDMNnvgTtEqtKtf219exvA87"), // ISC-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("250000000000"),
        borrowLimit: new BN("50000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("9ojzV5xFHtx2h2GhKRSgCwJK3BLswczdiiLW3hsyRE5c"), // LFG-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("1000000000000000000"),
        borrowLimit: new BN("3832886160000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("5oNLkC42jSSrLER4tYjax99zkaGJegV1FjAtEbw81Xs6"), // MNDE-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("8293971000000000"),
        borrowLimit: new BN("122704000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("2z8C1CCoJBKMLCNbaMWXuTYKHjcdHQBVth5CHsSQq611"), // MOTHER-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("20000000000000"),
        borrowLimit: new BN("250000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("G1pNtooUWPad3zCJLGAtjD3Zu9K56PrRpmvVB6AED1Tr"), // NOS-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("100000000000000"),
        borrowLimit: new BN("9615000000"),
        riskTier: { isolated: {} },
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
        operationalState: { operational: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("CQVtZK8rpL4M6JQzXxkPhadkVDFChfmdyw9MAXM3oFZT"), // ORE-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("425000000000"),
        borrowLimit: new BN("42000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("D1vPUa8JhMpxi5qjZeYLCJvHHQbAZ8pdfXum3AwWAk5H"), // PRCL-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("1000000000000"),
        borrowLimit: new BN("10000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("4PtX5fLM5JwujjHmSyzbh5XLasKx9kiPxPfygi57jAov"), // PT-BulkSOL-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("10000000000000"),
        borrowLimit: new BN("0"),
        riskTier: { collateral: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("9ThXmfwhNzc6qbkRLuSGHwKS7mxjn6QcuRD644Pjn4F"), // PT-BulkSOL-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("10000000000000"),
        borrowLimit: new BN("0"),
        riskTier: { collateral: {} },
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
        operationalState: { operational: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("2VmE6PMRWLRxjMkoK2sWu3WyNGGdXFK1G38ZAaQu3r5Y"), // PT-hyloSOL-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("10000000000000"),
        borrowLimit: new BN("0"),
        riskTier: { collateral: {} },
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
        operationalState: { operational: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("5HSLxQN34V9jLihfBDwNLguDKWEPDBL7QBG5JKcAQ7ne"), // SAMO-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("26478465000000000"),
        borrowLimit: new BN("1662062000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { operational: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("Emb5g6cEbRU2Yq9ZQnKhRDQLNRLSMWdgYRvJrBHzH6yB"), // SNS-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("100000000000000000"),
        borrowLimit: new BN("421229000000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
    {
      bank: new PublicKey("7aoit6hVmaqWn2VjhmDo5qev6QXjsJJf4q5RTd7yczZj"), // WEN-P0
      config: {
        assetWeightInit: bigNumberToWrappedI80F48(0),
        assetWeightMaint: bigNumberToWrappedI80F48(0),
        liabilityWeightInit: null,
        liabilityWeightMaint: null,
        depositLimit: new BN("104997900041900000"),
        borrowLimit: new BN("10499790000000"),
        riskTier: { isolated: {} },
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
        operationalState: { reduceOnly: {} },
        oracleMaxAge: null,
        oracleMaxConfidence: null,
        permissionlessBadDebtSettlement: null,
        freezeSettings: null,
        tokenlessRepaymentsAllowed: null,
      },
    },
  ],
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
    const entry = config.BANKS[i];

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
      .lendingPoolConfigureBank(entry.config)
      .accounts({
        bank: entry.bank,
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
