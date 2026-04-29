import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  bigNumberToWrappedI80F48,
  TOKEN_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";

import { commonSetup } from "../../../lib/common-setup";
import { aprToU32, utilToU32 } from "../../../lib/utils";
import { deriveBankWithSeed } from "../../common/pdas";
import { cap } from "../../utils/utils";

/**
 * Creates one or more dummy banks under a group, backed by a Fixed-price
 * oracle — convenient for exercising downstream flows (rate-limits, metadata,
 * etc.) on staging without chasing real Pyth/Switchboard feeds.
 *
 * For each entry in BANKS:
 *   1. lendingPoolAddBankWithSeed       — create bank at (group, mint, seed)
 *   2. lendingPoolSetFixedOraclePrice   — switch the bank to Fixed-price
 *                                         oracle and set USD price in one ix
 *                                         (the program rejects calling
 *                                         ConfigureBankOracle with the Fixed
 *                                         variant; this ix handles both).
 * Both ixs land in a single tx. Pre-existing banks at a given seed are
 * detected and skipped.
 *
 * The wallet loaded via commonSetup must be the group admin (the same key
 * that was passed as `ADMIN_KEY` to init_group.ts).
 */

const sendTx = true;

type BankEntry = {
  seed: number;
  priceUsd: number;
};

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  WALLET_PATH: string;
  BANK_MINT: PublicKey;
  MINT_DECIMALS: number;
  ASSET_TAG: number;
  DEPOSIT_LIMIT_UI: number;
  BORROW_LIMIT_UI: number;
  BANKS: BankEntry[];
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  GROUP: new PublicKey("E7BFUEqkHUyyiHUeUJci8j4JPZpkzNL6YSaVMkt4B8FP"),
  WALLET_PATH: "/.config/solana/id.json",
  BANK_MINT: new PublicKey("So11111111111111111111111111111111111111112"), // wSOL
  MINT_DECIMALS: 9,
  ASSET_TAG: 1, // ASSET_TAG_SOL
  DEPOSIT_LIMIT_UI: 1_000_000,
  BORROW_LIMIT_UI: 0,
  BANKS: [
    { seed: 0, priceUsd: 180 },
    { seed: 1, priceUsd: 180 },
    { seed: 2, priceUsd: 180 },
  ],
};

const bankConfig = {
  assetWeightInit: bigNumberToWrappedI80F48(0.9),
  assetWeightMaint: bigNumberToWrappedI80F48(0.95),
  liabilityWeightInit: bigNumberToWrappedI80F48(1.1),
  liabilityWeightMaint: bigNumberToWrappedI80F48(1.05),
  interestRateConfig: {
    insuranceFeeFixedApr: bigNumberToWrappedI80F48(0),
    insuranceIrFee: bigNumberToWrappedI80F48(0),
    protocolFixedFeeApr: bigNumberToWrappedI80F48(0),
    protocolIrFee: bigNumberToWrappedI80F48(0),
    protocolOriginationFee: bigNumberToWrappedI80F48(0),
    zeroUtilRate: 0,
    hundredUtilRate: aprToU32(0.25),
    points: [
      { util: utilToU32(0.5), rate: aprToU32(0.03) },
      { util: utilToU32(0.85), rate: aprToU32(0.06) },
      { util: utilToU32(0.95), rate: aprToU32(0.1) },
      { util: utilToU32(0.99), rate: aprToU32(0.15) },
      { util: 0, rate: 0 },
      { util: 0, rate: 0 },
    ],
    curveType: 1,
  },
  operationalState: { operational: {} } as any,
  riskTier: { collateral: {} } as any,
  totalAssetValueInitLimit: new BN(1_000_000),
  oracleMaxAge: 70,
  configFlags: 0,
  oracleMaxConfidence: 0,
};

async function main() {
  const user = commonSetup(sendTx, config.PROGRAM_ID, config.WALLET_PATH);
  const { program, connection } = user;
  const admin = user.wallet.publicKey;

  console.log(`Group:  ${config.GROUP.toBase58()}`);
  console.log(`Mint:   ${config.BANK_MINT.toBase58()} (decimals=${config.MINT_DECIMALS})`);
  console.log(`Admin:  ${admin.toBase58()}`);
  console.log(`Banks:  ${config.BANKS.length} entries\n`);

  const depositLimit = cap(config.DEPOSIT_LIMIT_UI, config.MINT_DECIMALS);
  const borrowLimit = cap(config.BORROW_LIMIT_UI, config.MINT_DECIMALS);

  for (const entry of config.BANKS) {
    const [bankKey] = deriveBankWithSeed(
      program.programId,
      config.GROUP,
      config.BANK_MINT,
      new BN(entry.seed),
    );

    const existing = await connection.getAccountInfo(bankKey);
    if (existing) {
      console.log(
        `[seed=${entry.seed}] bank already exists: ${bankKey.toBase58()} — skipping`,
      );
      continue;
    }

    const tx = new Transaction().add(
      await program.methods
        .lendingPoolAddBankWithSeed(
          {
            ...bankConfig,
            depositLimit,
            borrowLimit,
            assetTag: config.ASSET_TAG,
            pad0: [0, 0, 0, 0, 0, 0],
          },
          new BN(entry.seed),
        )
        .accountsPartial({
          marginfiGroup: config.GROUP,
          admin,
          feePayer: admin,
          bankMint: config.BANK_MINT,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
      await program.methods
        .lendingPoolSetFixedOraclePrice(bigNumberToWrappedI80F48(entry.priceUsd))
        .accountsPartial({
          group: config.GROUP,
          admin,
          bank: bankKey,
        })
        .instruction(),
    );

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [
        user.wallet.payer,
      ]);
      console.log(
        `[seed=${entry.seed}] bank=${bankKey.toBase58()} price=$${entry.priceUsd} → ${sig}`,
      );
    } catch (err) {
      console.error(`[seed=${entry.seed}] failed:`, err);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
