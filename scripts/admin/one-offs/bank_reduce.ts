import { PublicKey, Transaction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

const PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
/** Main group admin (Squads vault) */
const ADMIN = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");

/** Every field null (unchanged) except operationalState = reduceOnly. */
const reduceOnlyConfig = {
  assetWeightInit: null,
  assetWeightMaint: null,
  liabilityWeightInit: null,
  liabilityWeightMaint: null,
  depositLimit: null,
  borrowLimit: null,
  riskTier: null,
  assetTag: null,
  totalAssetValueInitLimit: null,
  interestRateConfig: null,
  operationalState: { reduceOnly: {} },
  oracleMaxAge: null,
  oracleMaxConfidence: null,
  permissionlessBadDebtSettlement: null,
  freezeSettings: null,
  tokenlessRepaymentsAllowed: null,
};

/**
 * Puts banks into reduce-only mode: no new deposits or borrows, and their
 * assets stop counting as collateral for Initial margin. Withdrawals,
 * repayments, and liquidations still work.
 *
 * Outputs one unsigned base58 tx containing an instruction per bank
 * (fee payer = MS vault) to paste into Squads.
 */
export async function reduceOnlyBanks(banks: PublicKey[]) {
  const user = commonSetup(false, PROGRAM_ID, undefined, ADMIN);

  const transaction = new Transaction();
  for (const bank of banks) {
    const ix = await user.program.methods
      .lendingPoolConfigureBank(reduceOnlyConfig)
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
  console.log(`Reduce-only tx for bank(s) ${labels} (base58):`);
  console.log(bs58.encode(serialized));
}
