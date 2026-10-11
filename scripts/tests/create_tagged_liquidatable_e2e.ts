import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { sleep, wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { loadKeypairFromFile } from "../utils/utils";
import { commonSetup } from "../../lib/common-setup";
import { composeRemainingAccounts } from "../../lib/utils";
import { initGroup } from "../admin/init_group";
import { initAccount } from "../user/init_account";
import { addBank, ORACLE_TYPE_PYTH } from "../admin/add_bank";
import { setFixedOraclePrice } from "../admin/config_bank_fixed_price";
import { configBankGov } from "../admin/config_bank_gov";
import { setGovernanceAdmin } from "../admin/set_governance_admin";
import { depositRegular } from "../user/deposit_regular";
import { borrow } from "../user/borrow";
import { assertHealthCacheOk, pulseHealth } from "../user/health_pulse";
import {
  BalanceRequirement,
  pkToString,
  warnOnMissingBalances,
  writeJsonFile,
} from "./e2e_helpers";

/**
 * Builds a liquidatee that is unhealthy but not worth liquidating at the base premium, then tags
 * it (`marginfi_account_tag_liq_record`, 0.1.12) so the premium a receivership liquidator may take
 * grows over time until it is.
 *
 * Shape: 10 USDC collateral (Fixed $1) against 8.9 PyUSD debt, liability weight 1. The collateral's
 * maintenance weight is then lowered until maintenance health is -TARGET_DEFICIT. The account stays
 * solvent ($10 > $8.9), so the tag premium grows, and holds more than the $5 closeout threshold, so
 * a liquidation must leave it unhealthy. That second rule is what caps the repayable amount at
 * `deficit / (l - w * (1 + premium))`, which is tiny at the base premium and opens up as the
 * premium grows.
 */
export type Config = {
  PROGRAM_ID: string;
  /** Group admin, governance admin and the PyUSD lender. */
  LIQUIDATOR_WALLET_PATH: string;
  LIQUIDATEE_WALLET_PATH: string;
  COLLATERAL_MINT: PublicKey;
  /** Only used to create the bank; the bank is switched to a Fixed $1 price right after. */
  COLLATERAL_PLACEHOLDER_ORACLE: PublicKey;
  DEBT_MINT: PublicKey;
  DEBT_ORACLE: PublicKey;
};

export type State = {
  marginfiGroup: PublicKey;
  liquidator: PublicKey;
  liquidatee: PublicKey;
  collateralBank: PublicKey;
  debtBank: PublicKey;
};

const COLLATERAL_DEPOSIT = new BN(10 * 10 ** 6); // 10 USDC, by the liquidatee
const DEBT_DEPOSIT = new BN(9_500_000); // 9.5 PyUSD, by the liquidator
const BORROW_AMOUNT = new BN(8_900_000); // 8.9 PyUSD, by the liquidatee

/** Weights while borrowing, so 8.9 fits under 0.9 * $10 of collateral. */
const COLLATERAL_WEIGHT_INIT = 0.9;
const COLLATERAL_WEIGHT_MAINT = 0.95;
const DEBT_LIABILITY_WEIGHT = 1;

/** Maintenance health to leave the liquidatee at, in USD. Large enough to survive PyUSD noise. */
const TARGET_DEFICIT = 0.05;

/** Eva's MIN_PROFIT, only used for the schedule printed at the end. */
const EVA_MIN_PROFIT = 0.5;

/** Program constants (marginfi-v2 `constants.rs`). */
const LIQUIDATION_BONUS_FEE_MINIMUM = 0.05;
const LIQUIDATION_TAG_DELAY_SECS = 60 * 60;
const LIQUIDATION_TAG_FULL_PREMIUM_SECS = 7 * 24 * 60 * 60;
const LIQUIDATION_CLOSEOUT_DOLLAR_THRESHOLD = 5;

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  LIQUIDATOR_WALLET_PATH: "/.config/stage/id.json",
  LIQUIDATEE_WALLET_PATH: "/.config/liquidatee/id.json",
  COLLATERAL_MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // usdc
  COLLATERAL_PLACEHOLDER_ORACLE: new PublicKey(
    "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX",
  ), // usdc PythPull
  DEBT_MINT: new PublicKey("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"), // pyusd (t22)
  DEBT_ORACLE: new PublicKey("F1huL4wkpzHLezvKMXQMgrL6SN7CkG9fYWm4VWSmVbjw"), // pyusd PythPull
};

const STATE_FILE = "liquidation_tagged_e2e_state.json";

async function main() {
  const liquidatorWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATOR_WALLET_PATH,
  );
  const liquidateeWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATEE_WALLET_PATH,
  );
  const admin = commonSetup(
    true,
    config.PROGRAM_ID,
    config.LIQUIDATOR_WALLET_PATH,
  );
  writeJsonFile("liquidation_tagged_e2e_config.json", serializeConfig(config));

  console.log("\n\n\n 0. CHECK WALLET BALANCES");
  const reqs: BalanceRequirement[] = [
    {
      who: "Liquidatee",
      owner: liquidateeWallet.publicKey,
      label: "USDC",
      mint: config.COLLATERAL_MINT,
      needed: COLLATERAL_DEPOSIT,
    },
    {
      who: "Liquidator",
      owner: liquidatorWallet.publicKey,
      label: "PyUSD",
      mint: config.DEBT_MINT,
      needed: DEBT_DEPOSIT,
    },
  ];
  await warnOnMissingBalances(
    config.PROGRAM_ID,
    config.LIQUIDATOR_WALLET_PATH,
    reqs,
  );

  console.log("\n\n\n 1. INIT GROUP");
  const marginfiGroup = await initGroup(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ADMIN_KEY: liquidatorWallet.publicKey },
    config.LIQUIDATOR_WALLET_PATH,
  );
  console.log("group: " + marginfiGroup);
  const state: Record<string, any> = { marginfiGroup: pkToString(marginfiGroup) };
  writeJsonFile(STATE_FILE, state);
  await sleep(5000);

  // 0.1.12: adding banks, oracles and weights need the governance admin, which a new group lacks.
  console.log("\n\n\n 2. SET GOVERNANCE ADMIN");
  await setGovernanceAdmin(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      NEW_GOVERNANCE_ADMIN: liquidatorWallet.publicKey,
      SIGNER: liquidatorWallet.publicKey,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(2000);

  console.log("\n\n\n 3. ADD COLLATERAL (Fixed USDC) AND DEBT (PyUSD) BANKS");
  const collateralBank = await addBank(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP_KEY: marginfiGroup,
      ORACLE: config.COLLATERAL_PLACEHOLDER_ORACLE,
      ORACLE_TYPE: ORACLE_TYPE_PYTH,
      ADMIN: liquidatorWallet.publicKey,
      BANK_MINT: config.COLLATERAL_MINT,
      SEED: 1,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(2000);
  await setFixedOraclePrice(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ADMIN: liquidatorWallet.publicKey },
    config.LIQUIDATOR_WALLET_PATH,
    [{ bank: collateralBank, price: 1 }],
  );
  await sleep(1000);

  const debtBank = await addBank(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP_KEY: marginfiGroup,
      ORACLE: config.DEBT_ORACLE,
      ORACLE_TYPE: ORACLE_TYPE_PYTH,
      ADMIN: liquidatorWallet.publicKey,
      BANK_MINT: config.DEBT_MINT,
      SEED: 0,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  state.collateralBank = pkToString(collateralBank);
  state.debtBank = pkToString(debtBank);
  writeJsonFile(STATE_FILE, state);
  await sleep(2000);

  console.log("\n\n\n 4. SET BORROWING WEIGHTS");
  await configBankGov(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANKS: [
        {
          bank: collateralBank,
          update: {
            assetWeightInit: COLLATERAL_WEIGHT_INIT,
            assetWeightMaint: COLLATERAL_WEIGHT_MAINT,
          },
        },
        {
          bank: debtBank,
          update: {
            liabilityWeightInit: DEBT_LIABILITY_WEIGHT,
            liabilityWeightMaint: DEBT_LIABILITY_WEIGHT,
          },
        },
      ],
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(2000);

  console.log("\n\n\n 5. INIT MARGINFI ACCOUNTS");
  const liquidator = await initAccount(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      AUTHORITY: liquidatorWallet.publicKey,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  state.liquidator = pkToString(liquidator);
  await sleep(1000);
  const liquidatee = await initAccount(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      AUTHORITY: liquidateeWallet.publicKey,
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  state.liquidatee = pkToString(liquidatee);
  writeJsonFile(STATE_FILE, state);
  await sleep(1000);

  console.log("\n\n\n 6. DEPOSITS");
  await depositRegular(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANK: debtBank,
      ACCOUNT: liquidator,
      AMOUNT: DEBT_DEPOSIT,
      MINT: config.DEBT_MINT,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);
  await depositRegular(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANK: collateralBank,
      ACCOUNT: liquidatee,
      AMOUNT: COLLATERAL_DEPOSIT,
      MINT: config.COLLATERAL_MINT,
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 7. BORROW PyUSD BY LIQUIDATEE");
  const remaining = composeRemainingAccounts([
    [collateralBank],
    [debtBank, config.DEBT_ORACLE],
  ]);
  await borrow(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      ACCOUNT: liquidatee,
      BANK: debtBank,
      MINT: config.DEBT_MINT,
      AMOUNT: BORROW_AMOUNT,
      ADD_COMPUTE_UNITS: false,
      NEW_REMAINING: remaining,
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(3000);

  console.log("\n\n\n 8. LOWER COLLATERAL WEIGHT TO A SMALL DEFICIT");
  // Size the weight off the live health cache rather than the nominal amounts, so PyUSD's actual
  // price (and confidence) is already in the liability side.
  await pulseHealth(
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: liquidatee, LUT: undefined },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(2000);
  const before = await readHealth(admin, liquidatee);
  const collateralValue = before.assetsMaint / COLLATERAL_WEIGHT_MAINT;
  const weight = (before.liabsMaint - TARGET_DEFICIT) / collateralValue;
  console.log(
    `collateral $${collateralValue.toFixed(4)}, liabilities (maint) $${before.liabsMaint.toFixed(4)}` +
      ` -> maintenance weight ${weight.toFixed(6)}`,
  );
  if (!(weight > 0 && weight < COLLATERAL_WEIGHT_MAINT)) {
    throw new Error(`computed weight ${weight} is out of range; check the amounts`);
  }
  await configBankGov(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANKS: [
        { bank: collateralBank, update: { assetWeightInit: weight, assetWeightMaint: weight } },
      ],
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(2000);

  console.log("\n\n\n 9. CONFIRM UNHEALTHY BUT SOLVENT");
  await pulseHealth(
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: liquidatee, LUT: undefined },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(2000);
  const after = await readHealth(admin, liquidatee);
  console.log(
    `maintenance health ${after.healthMaint.toFixed(6)}, equity $${after.assetsEquity.toFixed(4)}` +
      ` vs debt $${after.liabsEquity.toFixed(4)}`,
  );
  if (after.healthMaint >= 0) {
    throw new Error("liquidatee is still healthy; raise TARGET_DEFICIT");
  }
  if (after.assetsEquity < after.liabsEquity) {
    throw new Error("liquidatee is in bad debt; the tag premium would not grow");
  }

  console.log("\n\n\n 10. TAG THE LIQUIDATEE");
  await send(admin, [
    await admin.program.methods
      .marginfiAccountTagLiqRecord()
      .accounts({ marginfiAccount: liquidatee })
      .remainingAccounts(
        remaining.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      )
      .instruction(),
  ]);
  await sleep(2000);
  const acc: any = await admin.program.account.marginfiAccount.fetch(liquidatee);
  const taggedAt = Number(acc.liquidationTaggedAt.toString());
  if (taggedAt === 0) throw new Error("tag did not stick");
  console.log(`tagged at ${new Date(taggedAt * 1000).toISOString()}`);

  const [feeStateKey] = PublicKey.findProgramAddressSync(
    [Buffer.from("feestate")],
    admin.program.programId,
  );
  const feeState: any = await admin.program.account.feeState.fetch(feeStateKey);
  const basePremium = Math.max(
    wrappedI80F48toBigNumber(feeState.liquidationMaxFee).toNumber(),
    LIQUIDATION_BONUS_FEE_MINIMUM,
  );
  printSchedule(
    {
      weight,
      liabilityWeight: DEBT_LIABILITY_WEIGHT,
      assets: after.assetsEquity,
      liabs: after.liabsEquity,
      deficit: -after.healthMaint,
      basePremium,
    },
    taggedAt,
  );

  console.log(`\nPoint Eva's MARGINFI_GROUP_KEY at ${marginfiGroup} to let it pick this up.`);
}

async function send(
  user: ReturnType<typeof commonSetup>,
  ixs: TransactionInstruction[],
) {
  const signature = await sendAndConfirmTransaction(
    user.connection,
    new Transaction().add(...ixs),
    [user.wallet.payer],
  );
  console.log("Transaction signature:", signature);
}

async function readHealth(
  user: ReturnType<typeof commonSetup>,
  account: PublicKey,
) {
  const acc: any = await user.program.account.marginfiAccount.fetch(account);
  const hc = acc.healthCache;
  assertHealthCacheOk(hc);
  const n = (v: any) => wrappedI80F48toBigNumber(v).toNumber();
  const assetsMaint = n(hc.assetValueMaint);
  const liabsMaint = n(hc.liabilityValueMaint);
  return {
    assetsMaint,
    liabsMaint,
    healthMaint: assetsMaint - liabsMaint,
    assetsEquity: n(hc.assetValueEquity),
    liabsEquity: n(hc.liabilityValueEquity),
  };
}

type Position = {
  weight: number;
  liabilityWeight: number;
  assets: number;
  liabs: number;
  deficit: number;
  basePremium: number;
};

/** Mirrors `tag_adjusted_premium`. */
function tagPremium(base: number, elapsed: number): number {
  if (base >= 1 || elapsed <= LIQUIDATION_TAG_DELAY_SECS) return base;
  const growth = Math.min(elapsed, LIQUIDATION_TAG_FULL_PREMIUM_SECS) - LIQUIDATION_TAG_DELAY_SECS;
  const window = LIQUIDATION_TAG_FULL_PREMIUM_SECS - LIQUIDATION_TAG_DELAY_SECS;
  return base + (1 - base) * (growth / window);
}

/**
 * Largest repayment (USD) `end_liquidation` accepts at `premium`, taking the full premium: the
 * account must stay unhealthy above the closeout threshold, must not go insolvent, and the seizure
 * cannot exceed the collateral or the repayment the debt.
 */
function maxRepay(p: Position, premium: number): number {
  let bound = Math.min(p.liabs, p.assets / (1 + premium));
  if (premium > 0) bound = Math.min(bound, (p.assets - p.liabs) / premium);
  const denom = p.liabilityWeight - p.weight * (1 + premium);
  if (p.assets >= LIQUIDATION_CLOSEOUT_DOLLAR_THRESHOLD && denom > 0) {
    bound = Math.min(bound, p.deficit / denom);
  }
  return Math.max(0, bound);
}

function printSchedule(p: Position, taggedAt: number) {
  console.log(`\nbase premium ${(p.basePremium * 100).toFixed(2)}%, Eva min profit $${EVA_MIN_PROFIT}`);
  console.log("elapsed   premium   max repay   max profit");
  const hours = [0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 24, 36, 48];
  for (const h of hours) {
    const premium = tagPremium(p.basePremium, h * 3600);
    const repay = maxRepay(p, premium);
    console.log(
      `${String(h).padStart(5)}h   ${(premium * 100).toFixed(2).padStart(6)}%   $${repay.toFixed(4).padStart(8)}   $${(repay * premium).toFixed(4)}`,
    );
  }
  for (let s = 0; s <= LIQUIDATION_TAG_FULL_PREMIUM_SECS; s += 60) {
    const premium = tagPremium(p.basePremium, s);
    if (maxRepay(p, premium) * premium >= EVA_MIN_PROFIT) {
      console.log(
        `\nworth $${EVA_MIN_PROFIT} from ~${(s / 3600).toFixed(1)}h after tagging ` +
          `(${new Date((taggedAt + s) * 1000).toISOString()}), premium ${(premium * 100).toFixed(2)}%`,
      );
      return;
    }
  }
  console.log(`\nnever reaches $${EVA_MIN_PROFIT}; lower EVA_MIN_PROFIT or grow the position`);
}

function serializeConfig(c: Config) {
  return {
    PROGRAM_ID: c.PROGRAM_ID,
    LIQUIDATOR_WALLET_PATH: c.LIQUIDATOR_WALLET_PATH,
    LIQUIDATEE_WALLET_PATH: c.LIQUIDATEE_WALLET_PATH,
    COLLATERAL_MINT: c.COLLATERAL_MINT.toBase58(),
    COLLATERAL_PLACEHOLDER_ORACLE: c.COLLATERAL_PLACEHOLDER_ORACLE.toBase58(),
    DEBT_MINT: c.DEBT_MINT.toBase58(),
    DEBT_ORACLE: c.DEBT_ORACLE.toBase58(),
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
