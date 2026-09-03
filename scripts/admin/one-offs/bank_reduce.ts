import { PublicKey, Transaction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../../lib/common-setup";

const PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
/** Main group admin (Squads vault) */
const ADMIN = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");

/**
 * Puts banks into reduce-only mode: no new deposits or borrows, and their
 * assets stop counting as collateral for Initial margin (unless withBorrowingPower is true).
 * Withdrawals, repayments, and liquidations still work.
 *
 * Outputs one unsigned base58 tx containing an instruction per bank
 * (fee payer = MS vault) to paste into Squads.
 */
export async function reduceOnlyBanks(banks: PublicKey[], withBorrowingPower: boolean = false) {
  const user = commonSetup(false, PROGRAM_ID, undefined, ADMIN);
  const config = withBorrowingPower ? reduceOnlyWithBorrowingPowerConfig : reduceOnlyConfig;

  const transaction = new Transaction();
  for (const bank of banks) {
    const ix = await user.program.methods
      .lendingPoolConfigureBank(config)
      .accounts({ bank })
      .accountsPartial({ admin: ADMIN })
      .instruction();
    transaction.add(ix);
  }

  transaction.feePayer = ADMIN;
  const { blockhash } = await user.connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  const serialized = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const labels = banks.map((b) => b.toBase58()).join(", ");
  console.log(`Reduce-only tx for bank(s) ${labels} (base58):\n`);
  console.log(bs58.encode(serialized));
}

/**
 * Every `BankConfigOpt` field explicitly null, i.e. "change nothing". Callers spread this and
 * override only the fields they mean to set.
 *
 * This must list EVERY field in the IDL's `BankConfigOpt`. Anchor serializes the struct in IDL
 * field order and encodes a missing key as absent rather than as `None`, so an incomplete object
 * produces a short buffer and the program rejects the ix with `InstructionDidNotDeserialize`
 * (0x66) at simulation time. If a future IDL adds a field, add it here too.
 */
const noConfigChanges = {
  assetWeightInit: null,
  assetWeightMaint: null,
  liabilityWeightInit: null,
  liabilityWeightMaint: null,
  depositLimit: null,
  borrowLimit: null,
  operationalState: null,
  interestRateConfig: null,
  riskTier: null,
  assetTag: null,
  totalAssetValueInitLimit: null,
  oracleMaxConfidence: null,
  oracleMaxAge: null,
  permissionlessBadDebtSettlement: null,
  freezeSettings: null,
  tokenlessRepaymentsAllowed: null,
  liquidationLiquidatorFee: null,
  liquidationInsuranceFee: null,
  circuitBreakerEnabled: null,
  cbDeviationBpsTiers: null,
  cbTierDurationsSeconds: null,
  cbEscalationWindowMult: null,
  cbEmaAlphaBps: null,
  cbWindowSeconds: null,
  cbWindowMaxUpBps: null,
  cbWindowMaxDownBps: null,
};

/** Every field unchanged except operationalState = reduceOnly. */
const reduceOnlyConfig = {
  ...noConfigChanges,
  operationalState: { reduceOnly: {} },
};

/** Every field unchanged except operationalState = reduceOnlyWithBorrowingPower. */
const reduceOnlyWithBorrowingPowerConfig = {
  ...noConfigChanges,
  operationalState: { reduceOnlyWithBorrowingPower: {} },
};

/** UXD bank in the main group (mint 7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT) */
const UXD_BANK = new PublicKey("BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR");

reduceOnlyBanks([UXD_BANK]).catch((err) => {
  console.error(err);
});