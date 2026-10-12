import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import {
  commonSetup,
  registerJuplendProgram,
  registerKaminoProgram,
} from "../../lib/common-setup";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import BigNumber from "bignumber.js";
import {
  deriveLiquidationRecord,
  deriveLiquidityVaultAuthority,
} from "../common/pdas";
import {
  ASSET_TAG_JUPLEND,
  ASSET_TAG_KAMINO,
} from "../../lib/constants";
import {
  makeKaminoWithdrawIx,
  simpleRefreshObligation,
  simpleRefreshReserve,
} from "../kamino/ixes-common";
import { FARMS_PROGRAM_ID, KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import { deriveUserState } from "../kamino/pdas";
import {
  deriveJuplendCpiAccounts,
  findJuplendClaimAccountPda,
  findJuplendLendingAdminPda,
  JUPLEND_LENDING_PROGRAM_ID,
} from "../juplend/lib/utils";
import { updateLut } from "../../luts/update_lut";
import { briefError, bytesToF64 } from "../../lib/utils";

const sendTx = true;

type Balances = Array<{
  bankPk: PublicKey;
  isCollateral: boolean;
  shares: BigNumber;
  hasEmissions: boolean;
}>;
type AccountBanks = Map<PublicKey, Balances>;
type FetchedBanks = Map<string, any>; // any here is our Bank type
type FetchedReserves = Map<string, any>; // any here is the Reserve type from Kamino IDL
type FetchedLendings = Map<string, any>; // any here is the Lending type from the JupLend IDL

/// Fraction of the maint-weighted debt the seizure is allowed to consume. `end_deleverage`
/// compares health against prices locked on-chain at `start_deleverage`, which can have moved
/// since this script read the bank caches; without slack a small adverse move trips
/// WorseHealthPostLiquidation and reverts the whole tx.
const SEIZE_MARGIN = BigNumber(0.98);

/// Price and confidence the risk engine will use for a bank, in USD per whole token.
///
/// `cache.lastOraclePrice` is the RAW feed price. Venue setups (Kamino/Drift/JupLend) and the
/// mSOL/LST/PT wrappers keep their exchange rate in `cache.priceMultiplier` and the engine
/// multiplies the two (see `update_cache_price`), so both the price and its confidence have to
/// be scaled by it. The stored confidence is already multiplied by `CONF_INTERVAL_MULTIPLE`.
function bankPrice(bank: any): { price: BigNumber; conf: BigNumber } {
  let mult = wrappedI80F48toBigNumber(bank.cache.priceMultiplier);
  if (mult.isZero()) mult = BigNumber(1);
  return {
    price: wrappedI80F48toBigNumber(bank.cache.lastOraclePrice).multipliedBy(mult),
    conf: wrappedI80F48toBigNumber(bank.cache.lastOraclePriceConfidence).multipliedBy(mult),
  };
}

/// `Bank.flags` bit that lets the risk admin clear a debt with no tokens (see
/// `TOKENLESS_REPAYMENTS_ALLOWED` in the program's constants).
const TOKENLESS_REPAYMENTS_ALLOWED = 1n << 5n;

/// Remaining liability value (USD) below which seizing more collateral is pointless: the
/// withdraw rounds to nothing useful and risks tripping WorseHealthPostLiquidation.
const DUST_LIAB_VALUE = BigNumber(0.001);

/// Accounts each `OracleSetup` needs after its bank, as indices into `bank.config.oracleKeys`.
/// Mirrors `get_remaining_accounts_per_bank` and the per-setup `ais` layout in `price.rs`. Every
/// setup must be listed: a bank that contributes no accounts silently shifts every later balance
/// and the health check fails with `InvalidBankAccount`.
const ORACLE_KEY_INDICES: Record<string, number[]> = {
  fixed: [],
  pythPushOracle: [0],
  scope: [0],
  ptFixed: [0],
  // The venue loaders all validate against `oracle_keys[1]`, and these carry no base feed.
  fixedKamino: [1],
  fixedDrift: [1],
  fixedJuplend: [1],
  kaminoPythPush: [0, 1],
  driftPythPull: [0, 1],
  solendPythPull: [0, 1],
  juplendPythPull: [0, 1],
  // Base feed + rate source (Marinade State / SPL stake pool / Exponent vault).
  pythMsol: [0, 1],
  pythLst: [0, 1],
  ptPyth: [0, 1],
  // Base feed + venue + rate source.
  kaminoMsol: [0, 1, 2],
  juplendMsol: [0, 1, 2],
  kaminoLst: [0, 1, 2],
  juplendLst: [0, 1, 2],
  // [3] is the on-ramp, replaced with the derived key when unset (see below).
  stakedWithPythPush: [0, 1, 2, 3],
};

/// Setups holding a Kamino reserve in `integrationAcc1`, which needs a refresh ix.
const KAMINO_SETUPS = new Set([
  "kaminoPythPush",
  "fixedKamino",
  "kaminoMsol",
  "kaminoLst",
]);

/// Setups holding a JupLend Lending state in `integrationAcc1`, which needs an updateRate ix.
const JUPLEND_SETUPS = new Set([
  "juplendPythPull",
  "fixedJuplend",
  "juplendMsol",
  "juplendLst",
]);

const SPL_SINGLE_POOL_PROGRAM_ID = new PublicKey(
  "SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE",
);

/// `derive_staked_onramp_from_vote`: the single-pool on-ramp stake account for a validator.
function deriveStakedOnramp(voteAccount: PublicKey): PublicKey {
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), voteAccount.toBuffer()],
    SPL_SINGLE_POOL_PROGRAM_ID,
  );
  const [onramp] = PublicKey.findProgramAddressSync(
    [Buffer.from("onramp"), pool.toBuffer()],
    SPL_SINGLE_POOL_PROGRAM_ID,
  );
  return onramp;
}

/// Extra margin (bps) added on top of the computed repay amount when checking that the repay ATA
/// is funded. `repay_all` settles the debt as of execution, which is a few slots after this check,
/// so it covers interest accrued in between.
const REPAY_FUNDING_BUFFER_BPS = 10;

/// Group pubkey -> fetched group, shared across `deleverage` calls (only read for `riskAdmin`).
const fetchedGroups = new Map<string, any>();

export type DeleverageResult = {
  /** Nothing to do on this account (no debt / no BANK position, or dust); nothing was sent. */
  skipped: boolean;
  /** Tx landed. False means it was built but the send failed. */
  ok: boolean;
  /** Debt cleared, in BANK native units ("liability" mode only) and in USD. */
  repaidNative: BigNumber;
  repaidUsd: BigNumber;
  /** Collateral seized, in USD, summed over every bank withdrawn from. */
  seizedUsd: BigNumber;
};

/** Thrown when the deleverager wallet cannot cover the next account's debt. Stops the run. */
export class InsufficientRepayFunds extends Error {
  constructor(
    readonly account: PublicKey,
    readonly missingNative: BigNumber,
    readonly haveNative: BigNumber,
    readonly neededNative: BigNumber,
    readonly decimals: number,
    readonly mint: PublicKey,
  ) {
    super(`insufficient repay funds for ${account.toBase58()}`);
  }
}

/**
 * "liability": repay every account's debt in BANK, seizing its collateral (USDC banks first).
 * "collateral": BANK is collateral to strip, e.g. a ReduceOnly bank that still backs debt. Repay
 *   every account's debts (in any bank) and seize only BANK; when BANK is worth less than the
 *   debt, repay just enough to seize all of it.
 */
type Mode = "liability" | "collateral";

const grandConfig = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  MODE: "collateral" as Mode,
  BANK: new PublicKey("3RVamPQE3nDViuUU7wdZJgnru7Q93cRzdysXA8kjxMiq"), // zBTC
  LUT: new PublicKey("3S5KoqRRSEhWSsmfszFnKHaEAE9Yxt5dEMNHm65xqpX8"),

  /**
   * Produced by fetch-accounts-for-bank.ts (ONLY_LIABS for "liability" mode,
   * ONLY_COLLATERAL_BACKING_DEBT for "collateral" mode).
   */
  DUMP: "logs/3RVamPQE3nDViuUU7wdZJgnru7Q93cRzdysXA8kjxMiq_accounts.json",
  /** Wallet holding the tokens used to repay. Must be the group's risk admin. */
  WALLET: "/.config/deleverager/id.json",
  /**
   * Resume point: skip every account until this one (inclusive). Set it to the pubkey the last
   * run stopped on after topping the wallet back up. Empty string starts from the beginning.
   */
  START_FROM: "",
};

type Config = {
  PROGRAM_ID: string;
  MODE: Mode;
  BANK: PublicKey;
  ACCOUNT: PublicKey;
  BALANCES: Balances;
  LUT: PublicKey;
};

async function main() {
  const data = JSON.parse(fs.readFileSync(grandConfig.DUMP, "utf8"));
  const accountBanks = parseAccountBanks(data);

  let fetchedBanks: FetchedBanks = new Map();
  let fetchedReserves: FetchedReserves = new Map();
  let fetchedLendings: FetchedLendings = new Map();

  let repaidUsd = BigNumber(0);
  let repaidNative = BigNumber(0);
  let seizedUsd = BigNumber(0);
  let done = 0;
  let skipped = 0;
  let failed = 0;
  let reached = grandConfig.START_FROM === "";
  let stoppedOn: InsufficientRepayFunds | undefined;

  const accounts = [...accountBanks];
  for (let i = 0; i < accounts.length; i++) {
    const [accountPk, balances] = accounts[i];

    if (!reached) {
      if (accountPk.toBase58() !== grandConfig.START_FROM) continue;
      reached = true;
    }

    console.log(`\n[${i + 1}/${accounts.length}] ${accountPk.toBase58()}`);

    const config: Config = {
      PROGRAM_ID: grandConfig.PROGRAM_ID,
      MODE: grandConfig.MODE,
      BANK: grandConfig.BANK,
      ACCOUNT: accountPk,
      BALANCES: balances,
      LUT: grandConfig.LUT,
    };

    let result: DeleverageResult;
    try {
      result = await deleverage(
        sendTx,
        config,
        grandConfig.WALLET,
        fetchedBanks,
        fetchedReserves,
        fetchedLendings,
      );
    } catch (error) {
      if (error instanceof InsufficientRepayFunds) {
        stoppedOn = error;
        break;
      }
      throw error;
    }

    if (result.skipped) {
      skipped++;
    } else if (result.ok) {
      done++;
      repaidUsd = repaidUsd.plus(result.repaidUsd);
      repaidNative = repaidNative.plus(result.repaidNative);
      seizedUsd = seizedUsd.plus(result.seizedUsd);
    } else {
      failed++;
    }
  }

  const dec = fetchedBanks.get(grandConfig.BANK.toBase58())?.mintDecimals ?? 8;
  const tok = (n: BigNumber) => n.dividedBy(10 ** dec).toFixed(dec);
  const usd = (n: BigNumber) => "$" + n.toFixed(2);

  console.log("\n====== RUN SUMMARY ======");
  console.log(`deleveraged:      ${done}`);
  console.log(`skipped (no liab): ${skipped}`);
  console.log(`failed to send:   ${failed}`);
  if (grandConfig.MODE === "liability") {
    console.log(`debt repaid:      ${tok(repaidNative)}  (${usd(repaidUsd)})`);
  } else {
    console.log(`debt repaid:      ${usd(repaidUsd)}`);
  }
  console.log(`collateral seized: ${usd(seizedUsd)}`);
  console.log("=========================");

  if (stoppedOn) {
    const stopTok = (n: BigNumber) =>
      n.dividedBy(10 ** stoppedOn.decimals).toFixed(stoppedOn.decimals);
    console.log("\n====== STOPPED: NOT ENOUGH REPAY FUNDS ======");
    console.log(`next target:  ${stoppedOn.account.toBase58()}`);
    console.log(`mint:         ${stoppedOn.mint.toBase58()}`);
    console.log(`needed:       ${stopTok(stoppedOn.neededNative)}`);
    console.log(`have:         ${stopTok(stoppedOn.haveNative)}`);
    console.log(`MISSING:      ${stopTok(stoppedOn.missingNative)}`);
    console.log(
      `\nTop up the wallet, then set START_FROM to "${stoppedOn.account.toBase58()}" and re-run.`,
    );
    console.log("=====================================");
    process.exitCode = 1;
  }
}

/// Flattens `[bank, ...oracles]` groups into remaining-account metas.
///
/// The bank is writable: `start_deleverage` locks the liquidation price cache on every bank in
/// the list and `end_deleverage` clears it, both via `load_mut`. Writability is a property of the
/// transaction, not the instruction, so passing them read-only only worked by accident on
/// accounts where every bank also happened to be repaid or withdrawn from.
const toMeta = (groups: PublicKey[][]): AccountMeta[] =>
  groups.flatMap(([bankPk, ...oracles]) => [
    { pubkey: bankPk, isSigner: false, isWritable: true },
    ...oracles.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    })),
  ]);

export async function deleverage(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  fetchedBanks?: FetchedBanks,
  fetchedReserves?: FetchedReserves,
  fetchedLendings?: FetchedLendings,
): Promise<DeleverageResult> {
  const skippedResult: DeleverageResult = {
    skipped: true,
    ok: false,
    repaidNative: BigNumber(0),
    repaidUsd: BigNumber(0),
    seizedUsd: BigNumber(0),
  };
  // Always the risk admin's keypair: a dry run (sendTx = false) still signs nothing, it simulates.
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    walletPath,
    undefined,
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  registerJuplendProgram(user, JUPLEND_LENDING_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  if (!fetchedBanks.has(config.BANK.toBase58())) {
    console.log();
    console.log("Fetching bank: ", config.BANK.toBase58());
    console.log();
    fetchedBanks.set(
      config.BANK.toBase58(),
      await program.account.bank.fetch(config.BANK),
    );
  }

  const liabBank = fetchedBanks.get(config.BANK.toBase58());
  const liabMint = liabBank.mint;
  const liabAta = getAssociatedTokenAddressSync(
    liabMint,
    user.wallet.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  if (!fetchedGroups.has(liabBank.group.toBase58())) {
    fetchedGroups.set(
      liabBank.group.toBase58(),
      await program.account.marginfiGroup.fetch(liabBank.group),
    );
  }
  const group = fetchedGroups.get(liabBank.group.toBase58());

  // `lendingAccountRepay(0, repay_all = true)` below only skips the token transfer when the signer
  // is the group's risk admin AND the bank carries TOKENLESS_REPAYMENTS_ALLOWED. In every other
  // case the very same instruction moves the whole debt out of `liabAta`, so the wallet has to
  // hold it. Resolve which mode we are in up front, and preflight the funding before signing.
  const isRiskAdmin = user.wallet.publicKey.equals(group.riskAdmin);
  const tokenlessRepay =
    isRiskAdmin &&
    (BigInt(liabBank.flags.toString()) & TOKENLESS_REPAYMENTS_ALLOWED) !== 0n;

  if (!isRiskAdmin) {
    // start/end deleverage take the risk admin as a `Signer`, so this run cannot succeed as-is.
    // Left as a warning rather than a throw so the tx can still be built for inspection or for
    // handoff to whatever signs on the risk admin's behalf.
    console.warn(
      `WARNING: wallet ${user.wallet.publicKey.toBase58()} is not the group risk admin ` +
        `(${group.riskAdmin.toBase58()}). start/end deleverage will be rejected.`,
    );
  }
  if (config.MODE === "liability") {
    console.log(
      tokenlessRepay
        ? "Repay mode: TOKENLESS (bank has TOKENLESS_REPAYMENTS_ALLOWED, debt is written off)"
        : `Repay mode: WITH TOKENS (paid out of ${liabAta.toBase58()})`,
    );
  } else {
    const holdsBank = config.BALANCES.some(
      (b) => b.isCollateral && b.bankPk.equals(config.BANK),
    );
    const owes = config.BALANCES.some((b) => !b.isCollateral && !b.shares.isNaN());
    if (!holdsBank || !owes) return skippedResult;
    console.log();
    console.log("Deleveraging account: ", config.ACCOUNT.toBase58());
  }

  let instructions: TransactionInstruction[] = [];
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  );

  // Several JupLend banks can share one Lending state (one per mint), so only emit
  // `updateRate` once per state to keep the tx small.
  const refreshedLendings = new Set<string>();

  /** Maint-weighted headroom the seizure may consume; the withdraw loop draws it down. */
  let liabValue = BigNumber(0);
  /** Plain USD value of the debt this run clears, for the run stats (not weighted). */
  let liabUsd = BigNumber(0);
  /** Plain USD value of the collateral seized, for the run stats (not weighted). */
  let seizedUsd = BigNumber(0);
  /// Native token amount `repay_all` will pull from `liabAta` when not repaying tokenlessly.
  let liabNative = BigNumber(0);
  let remainingAccounts: PublicKey[][] = [];
  let banksToWithdrawFrom: {
    bankPk: PublicKey;
    shares: BigNumber;
    hasEmissions: boolean;
  }[] = [];
  /** "collateral" mode: every debt on the account, repaid before BANK is seized. */
  const debts: { bankPk: PublicKey; shares: BigNumber }[] = [];
  for (const {
    bankPk,
    isCollateral,
    shares,
    hasEmissions,
  } of config.BALANCES) {
    if (config.MODE === "collateral" && !isCollateral && !shares.isNaN()) {
      debts.push({ bankPk, shares });
    }
    if (config.MODE === "liability" && config.BANK.toBase58() == bankPk.toBase58()) {
      if (isCollateral || shares.isNaN()) {
        return skippedResult;
      } else {
        console.log();
        console.log("Deleveraging account: ", config.ACCOUNT.toBase58());

        const liabShareValue = wrappedI80F48toBigNumber(
          liabBank.liabilityShareValue,
        );

        const liabTokens = shares.multipliedBy(liabShareValue);
        // `repay_all` transfers `ceil(liability_shares * liability_share_value)` (see
        // `BankAccountWrapper::repay_all`), so this is what the ATA must cover.
        liabNative = liabTokens.integerValue(BigNumber.ROUND_CEIL);

        // `end_deleverage` weighs health in MAINT terms: a liability counts at the
        // confidence-raised price times the maint liability weight, collateral at the
        // confidence-lowered price times the maint asset weight. Size the seizure in those same
        // units, otherwise raw-USD parity silently overshoots whenever the asset weight is
        // heavier than the liability weight.
        const { price, conf } = bankPrice(liabBank);
        const adjustedPrice = price.plus(conf);
        const liabWeight = wrappedI80F48toBigNumber(
          liabBank.config.liabilityWeightMaint,
        );
        const liabTokensUi = liabTokens.dividedBy(10 ** liabBank.mintDecimals);
        liabUsd = liabTokensUi.multipliedBy(price);
        liabValue = liabTokensUi
          .multipliedBy(adjustedPrice)
          .multipliedBy(liabWeight)
          .multipliedBy(SEIZE_MARGIN);

        console.log();
        console.log("liab share value: ", liabShareValue.toString());
        console.log("liab tokens (native): ", liabTokens.toString());
        console.log(
          "price: ",
          price.toString(),
          "(adjusted: )",
          adjustedPrice.toString(),
        );
        console.log("LIAB value: ", liabValue.toString());
        console.log();
      }
    }

    if (!fetchedBanks.has(bankPk.toBase58())) {
      console.log("Fetching bank: ", bankPk.toBase58());
      fetchedBanks.set(
        bankPk.toBase58(),
        await program.account.bank.fetch(bankPk),
      );
    }
    const bank = fetchedBanks.get(bankPk.toBase58());

    if (config.MODE === "collateral") {
      if (isCollateral && bankPk.equals(config.BANK)) {
        banksToWithdrawFrom.push({ bankPk, shares, hasEmissions });
      }
    } else if (isCollateral) {
      // We prioritize withdrawing from USDC banks
      if (
        bank.mint.toBase58() == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ) {
        banksToWithdrawFrom.unshift({ bankPk, shares, hasEmissions });
      } else {
        banksToWithdrawFrom.push({ bankPk, shares, hasEmissions });
      }
    }

    const setup = Object.keys(bank.config.oracleSetup)[0];

    const keyIndices = ORACLE_KEY_INDICES[setup];
    if (!keyIndices) {
      throw new Error(
        `bank ${bankPk.toBase58()}: unhandled oracle setup "${setup}". Add it to ` +
          `ORACLE_KEY_INDICES, otherwise this bank contributes no remaining accounts and ` +
          `every later balance reads the wrong one (InvalidBankAccount).`,
      );
    }
    const group = [bankPk, ...keyIndices.map((i) => bank.config.oracleKeys[i])];
    if (setup === "stakedWithPythPush") {
      // `expected_staked_onramp`: `oracle_keys[3]` when set, else derived off the vote account.
      group[4] = bank.config.oracleKeys[3].equals(PublicKey.default)
        ? deriveStakedOnramp(bank.integrationAcc1)
        : bank.config.oracleKeys[3];
    }
    remainingAccounts.push(group);

    if (KAMINO_SETUPS.has(setup)) {
      if (!fetchedReserves.has(bank.integrationAcc1.toBase58())) {
        console.log("Fetching reserve: ", bank.integrationAcc1.toBase58());
        fetchedReserves.set(
          bank.integrationAcc1.toBase58(),
          await user.kaminoProgram.account.reserve.fetch(bank.integrationAcc1),
        );
      }
      const reserve = fetchedReserves.get(bank.integrationAcc1.toBase58());

      instructions.push(
        await simpleRefreshReserve(
          user.kaminoProgram,
          bank.integrationAcc1,
          reserve.lendingMarket,
          reserve.config.tokenInfo.scopeConfiguration.priceFeed,
        ),
      );
    }

    if (JUPLEND_SETUPS.has(setup)) {
      if (!fetchedLendings.has(bank.integrationAcc1.toBase58())) {
        console.log("Fetching lending: ", bank.integrationAcc1.toBase58());
        fetchedLendings.set(
          bank.integrationAcc1.toBase58(),
          await user.juplendProgram.account.lending.fetch(bank.integrationAcc1),
        );
      }
      const lending = fetchedLendings.get(bank.integrationAcc1.toBase58());

      // The Lending state must be fresh before any risk check runs, otherwise the
      // bank prices off a stale `token_exchange_price`. Mirrors
      // `makeJuplendNativeUpdateRateIx`, but reuses the cached Lending account.
      if (!refreshedLendings.has(bank.integrationAcc1.toBase58())) {
        refreshedLendings.add(bank.integrationAcc1.toBase58());
        instructions.push(
          await user.juplendProgram.methods
            .updateRate()
            .accounts({
              lending: bank.integrationAcc1,
              supplyTokenReservesLiquidity: lending.tokenReservesLiquidity,
              rewardsRateModel: lending.rewardsRateModel,
            })
            .instruction(),
        );
      }
    }
  }

  /**
   * "collateral" mode prices from a simulated `pulse_health`: the per-balance (biased) prices the
   * program itself computes, written to the account's health cache. Bank caches can be days old
   * (a quiet bank's is only refreshed when someone touches it), and sizing from a stale one
   * over-seizes and trips WorseHealthPostLiquidation. Banks the pulse could not price (e.g. a
   * ReduceOnly collateral bank the init pass weighs at zero) fall back to the cache.
   */
  const livePrices =
    config.MODE === "collateral"
      ? await pulsePrices(program, connection, user.wallet.publicKey, config, remainingAccounts, instructions)
      : new Map<string, BigNumber>();
  const priceFor = (bankPk: PublicKey, bank: any) => {
    const live = livePrices.get(bankPk.toBase58());
    return live ? { price: live, conf: BigNumber(0) } : bankPrice(bank);
  };

  /** "collateral" mode: the repay instructions to send, sized below. */
  const repays: {
    bankPk: PublicKey;
    bank: any;
    native: BigNumber;
    repayAll: boolean;
    tokenless: boolean;
  }[] = [];
  if (config.MODE === "collateral") {
    // Weighted value of BANK the health check lets us seize, in the same maint units as below.
    const { shares: bankShares } = banksToWithdrawFrom[0];
    const { price: bPrice, conf: bConf } = priceFor(config.BANK, liabBank);
    const bankWeighted = bankShares
      .multipliedBy(wrappedI80F48toBigNumber(liabBank.assetShareValue))
      .dividedBy(10 ** liabBank.mintDecimals)
      .multipliedBy(bPrice.minus(bConf))
      .multipliedBy(wrappedI80F48toBigNumber(liabBank.config.assetWeightMaint));
    // Repaying this much weighted debt is enough to seize all of BANK.
    let toCover = bankWeighted.dividedBy(SEIZE_MARGIN);

    // When only part of the debt gets repaid, use the common stables first, so the wallet needs
    // the odd tokens only where an account owes nothing else.
    const preferred = [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
      "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
      "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", // USDS
    ];
    const rank = (bankPk: PublicKey) => {
      const i = preferred.indexOf(fetchedBanks.get(bankPk.toBase58()).mint.toBase58());
      return i === -1 ? preferred.length : i;
    };
    debts.sort((a, b) => rank(a.bankPk) - rank(b.bankPk));

    // E-mode boosts collateral weights only while the account owes a bank whose e-mode config
    // covers that collateral. Closing every liability drops the boost, and end_deleverage then
    // sees lower health even though the account is debt free. On such accounts the last debt
    // is left open by one liability share, rounded up to whole native units (a partial repay
    // may not leave less than one share).
    const collateralTags = new Set<number>(
      config.BALANCES.filter((b) => b.isCollateral)
        .map((b) => fetchedBanks.get(b.bankPk.toBase58()).emode.emodeTag)
        .filter((t: number) => t !== 0),
    );
    const emodeBoosted = debts.some(({ bankPk }) =>
      (fetchedBanks.get(bankPk.toBase58()).emode.emodeConfig.entries as any[]).some(
        (e) => e.collateralBankEmodeTag !== 0 && collateralTags.has(e.collateralBankEmodeTag),
      ),
    );

    for (const [idx, { bankPk, shares }] of debts.entries()) {
      if (toCover.lte(0)) break;
      const bank = fetchedBanks.get(bankPk.toBase58());
      const { price, conf } = priceFor(bankPk, bank);
      const perNative = price
        .plus(conf)
        .multipliedBy(wrappedI80F48toBigNumber(bank.config.liabilityWeightMaint))
        .dividedBy(10 ** bank.mintDecimals);
      const debtNative = shares.multipliedBy(
        wrappedI80F48toBigNumber(bank.liabilityShareValue),
      );
      const debtWeighted = debtNative.multipliedBy(perNative);
      let repayAll = debtWeighted.lte(toCover);
      let native = repayAll
        ? debtNative.integerValue(BigNumber.ROUND_CEIL)
        : toCover.dividedBy(perNative).integerValue(BigNumber.ROUND_CEIL);
      if (emodeBoosted && repayAll && idx === debts.length - 1) {
        repayAll = false;
        const leftNative = wrappedI80F48toBigNumber(bank.liabilityShareValue).integerValue(
          BigNumber.ROUND_CEIL,
        );
        native = debtNative.integerValue(BigNumber.ROUND_FLOOR).minus(leftNative);
        console.log(`E-mode boosted: leaving ${leftNative.toString()} native of the last debt open`);
        if (native.lte(0)) break;
      }
      const repaidWeighted = repayAll ? debtWeighted : native.multipliedBy(perNative);
      toCover = toCover.minus(repaidWeighted);
      liabValue = liabValue.plus(repaidWeighted.multipliedBy(SEIZE_MARGIN));
      liabUsd = liabUsd.plus(native.dividedBy(10 ** bank.mintDecimals).multipliedBy(price));
      const tokenless =
        isRiskAdmin &&
        (BigInt(bank.flags.toString()) & TOKENLESS_REPAYMENTS_ALLOWED) !== 0n;
      repays.push({ bankPk, bank, native, repayAll, tokenless });
      console.log(
        `Repay ${repayAll ? "ALL" : "PARTIAL"} ${native.toString()} native of ${bank.mint.toBase58()} ` +
          `(bank ${bankPk.toBase58()})${tokenless ? " TOKENLESS" : ""}`,
      );
    }
    // Debt fully covered by less than all of BANK: the withdraw loop takes a matching part.
    // Otherwise all of BANK goes; make sure the loop withdraws everything rather than a
    // floor-rounded share that leaves dust behind.
    if (toCover.gt(0) === false && liabValue.gte(bankWeighted)) {
      liabValue = bankWeighted.multipliedBy(1.000001);
    }

    for (const r of repays) {
      if (r.tokenless) continue;
      const tokenProgram = (await connection.getAccountInfo(r.bank.mint)).owner;
      await assertRepayFunded(
        connection,
        getAssociatedTokenAddressSync(r.bank.mint, user.wallet.publicKey, true, tokenProgram),
        r.native,
        r.bank,
        config,
      );
    }
  } else if (!tokenlessRepay) {
    await assertRepayFunded(
      connection,
      liabAta,
      liabNative,
      liabBank,
      config,
    );
  }

  const [liqRecordKey] = deriveLiquidationRecord(
    program.programId,
    config.ACCOUNT,
  );
  const liqRecordInfo = await connection.getAccountInfo(liqRecordKey);
  if (!liqRecordInfo && !sendTx) {
    // Dry run: create it inside the simulated tx instead of sending a separate one.
    instructions.push(
      await program.methods
        .marginfiAccountInitLiqRecord()
        .accounts({
          marginfiAccount: config.ACCOUNT,
          feePayer: user.wallet.publicKey,
        })
        .instruction(),
    );
  } else if (!liqRecordInfo) {
    console.log(
      "Creating liquidation record for account: ",
      config.ACCOUNT.toBase58(),
    );
    const transaction = new Transaction();
    transaction.add(
      await program.methods
        .marginfiAccountInitLiqRecord()
        .accounts({
          marginfiAccount: config.ACCOUNT,
          feePayer: user.wallet.publicKey,
        })
        .instruction(),
    );
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer],
        {
          commitment: "confirmed",
        },
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  }

  const startMeta = toMeta(remainingAccounts);

  instructions.push(
    await program.methods
      .startDeleverage()
      .accounts({
        marginfiAccount: config.ACCOUNT,
      })
      // Explicit: Anchor would read it off the account, which is unset until the record exists.
      .accountsPartial({ liquidationRecord: liqRecordKey })
      .remainingAccounts(startMeta)
      .instruction(),
  );

  if (config.MODE === "collateral") {
    for (const r of repays) {
      if (r.repayAll) {
        remainingAccounts = remainingAccounts.filter(
          (a) => a[0].toBase58() != r.bankPk.toBase58(),
        );
      }
      const tokenProgram = (await connection.getAccountInfo(r.bank.mint)).owner;
      const repayMeta = toMeta(remainingAccounts);
      if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        // must be first in the array
        repayMeta.unshift({ pubkey: r.bank.mint, isSigner: false, isWritable: false });
      }
      instructions.push(
        await program.methods
          .lendingAccountRepay(r.repayAll ? new BN(0) : new BN(r.native.toFixed(0)), r.repayAll)
          .accounts({
            marginfiAccount: config.ACCOUNT,
            bank: r.bankPk,
            signerTokenAccount: getAssociatedTokenAddressSync(
              r.bank.mint,
              user.wallet.publicKey,
              true,
              tokenProgram,
            ),
            tokenProgram,
          })
          .remainingAccounts(repayMeta)
          .instruction(),
      );
    }
  } else {
    remainingAccounts = remainingAccounts.filter(
      (a) => a[0].toBase58() != config.BANK.toBase58(),
    );
    const repayMeta = toMeta(remainingAccounts);
    instructions.push(
      await program.methods
        .lendingAccountRepay(new BN(0), true)
        .accounts({
          marginfiAccount: config.ACCOUNT,
          bank: config.BANK,
          signerTokenAccount: liabAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(repayMeta)
        .instruction(),
    );
  }

  for (const { bankPk, shares, hasEmissions } of banksToWithdrawFrom) {
    const bank = fetchedBanks.get(bankPk.toBase58());
    if (wrappedI80F48toBigNumber(bank.config.assetWeightInit).isZero()) {
      continue;
    }

    const shareValue = wrappedI80F48toBigNumber(bank.assetShareValue);

    const seizableTokens = shares.multipliedBy(shareValue);

    const { price, conf } = priceFor(bankPk, bank);
    const assetWeight = wrappedI80F48toBigNumber(bank.config.assetWeightMaint);
    if (price.isZero() || assetWeight.isZero()) {
      continue;
    }
    const adjustedPrice = price.minus(conf);
    const seizableUi = seizableTokens.dividedBy(10 ** bank.mintDecimals);
    const seizableValue = seizableUi
      .multipliedBy(adjustedPrice)
      .multipliedBy(assetWeight);

    console.log();
    console.log("bank: ", bankPk.toString());
    console.log("mint: ", bank.mint.toString());
    console.log("share value: ", shareValue.toString());
    console.log("seizable tokens (native): ", seizableTokens.toString());
    console.log(
      "price: ",
      price.toString(),
      "(adjusted: )",
      adjustedPrice.toString(),
    );
    console.log("SEIZABLE value: ", seizableValue.toString());
    console.log();

    if (hasEmissions && seizableValue.isLessThan(0.1)) {
      console.log("EMISSIONS active and the seizable value is small, ignoring");
      continue;
    }

    let withdrawAmount: BN;
    let withdrawAll: boolean;
    if (liabValue.gt(seizableValue)) {
      liabValue = liabValue.minus(seizableValue);
      seizedUsd = seizedUsd.plus(seizableUi.multipliedBy(price));
      console.log(
        "Withdrawing ALL, remaining liab value to cover: ",
        liabValue.toString(),
      );
      withdrawAmount = new BN(0);
      withdrawAll = true;
    } else {
      if (liabValue.isLessThan(DUST_LIAB_VALUE)) {
        // Such small values may cause WorseHealthPostLiquidation but give no practical sense for
        // withdrawing. The remaining debt is already covered, so no later bank is needed either.
        console.log("Remaining liab value is dust, nothing left to seize");
        break;
      }

      const proportion = liabValue.dividedBy(seizableValue);
      // console.log("proportion", proportion.toString());

      const fullValue = seizableTokens.multipliedBy(proportion);
      // console.log("fullValue", fullValue.toString());

      const adjustedValue = fullValue.integerValue(BigNumber.ROUND_FLOOR);

      if (adjustedValue.isZero()) {
        // The share is worth less than one native unit of this mint. Nothing to take here, but
        // the debt is still outstanding, so keep looking at the remaining banks.
        console.log("NOTHING to withdraw, skipping");
        continue;
      }

      withdrawAmount = new BN(adjustedValue.toString()); // this is just to not accidentally withdraw too much
      seizedUsd = seizedUsd.plus(
        adjustedValue.dividedBy(10 ** bank.mintDecimals).multipliedBy(price),
      );
      console.log("Withdrawing: ", withdrawAmount.toString());
      withdrawAll = false;
      // Note: no `break` here. The withdraw instruction is built below; the loop is terminated
      // after it is pushed, by the `if (withdrawAll)` check at the end of this block.
    }
    console.log();

    const withdrawMeta = toMeta(remainingAccounts);

    let mintAccInfo = await connection.getAccountInfo(bank.mint);
    const tokenProgram = mintAccInfo.owner;
    let isT22 = tokenProgram.toString() == TOKEN_2022_PROGRAM_ID.toString();

    if (isT22) {
      const m: AccountMeta = {
        pubkey: bank.mint,
        isSigner: false,
        isWritable: false,
      };
      // must be pushed first in the array
      withdrawMeta.unshift(m);
    }

    const ata = getAssociatedTokenAddressSync(
      bank.mint,
      user.wallet.publicKey,
      true,
      tokenProgram,
    );

    const info = await connection.getAccountInfo(ata);
    if (!info && !sendTx) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          user.wallet.publicKey,
          ata,
          user.wallet.publicKey,
          bank.mint,
          tokenProgram,
        ),
      );
    } else if (!info) {
      console.log("Creating idempotent account for mint: ", bank.mint.toBase58());
      const ataTransaction = new Transaction();
      ataTransaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
          user.wallet.publicKey,
          ata,
          user.wallet.publicKey,
          bank.mint,
          tokenProgram,
        ),
      );
      const signature = await sendAndConfirmTransaction(
        connection,
        ataTransaction,
        [user.wallet.payer],
      );
    }

    if (bank.config.assetTag == ASSET_TAG_KAMINO) {
      const reserve = fetchedReserves.get(bank.integrationAcc1.toBase58());
      let reserveFarmState = reserve.farmCollateral;
      let [userState] = deriveUserState(
        FARMS_PROGRAM_ID,
        reserveFarmState,
        bank.integrationAcc2,
      );
      // Reserves without a farm store the default pubkey, but both farm accounts are `Option<_>`
      // with a `mut` constraint, so they must be None rather than the default key.
      if (reserveFarmState.toString() == PublicKey.default.toString()) {
        reserveFarmState = null;
        userState = null;
      }

      instructions.push(
        await simpleRefreshObligation(
          user.kaminoProgram,
          reserve.lendingMarket,
          bank.integrationAcc2,
          [bank.integrationAcc1],
        ),
        await makeKaminoWithdrawIx(
          program,
          {
            marginfiAccount: config.ACCOUNT,
            bank: bankPk,
            destinationTokenAccount: ata,
            lendingMarket: reserve.lendingMarket,
            reserve: bank.integrationAcc1,
            reserveLiquidityMint: bank.mint,
            reserveFarmState,
            obligationFarmUserState: userState,
            // Only reserves made with the deterministic seeds match the ix builder's
            // derivations; read the vaults off the reserve instead.
            reserveLiquiditySupply: reserve.liquidity.supplyVault,
            reserveCollateralMint: reserve.collateral.mintPubkey,
            reserveSourceCollateral: reserve.collateral.supplyVault,
          },
          withdrawAmount,
          withdrawAll,
          withdrawMeta,
        ),
      );
    } else if (bank.config.assetTag == ASSET_TAG_JUPLEND) {
      const lending = fetchedLendings.get(bank.integrationAcc1.toBase58());

      const [lendingAdmin] = findJuplendLendingAdminPda();
      const juplendAccounts = deriveJuplendCpiAccounts(bank.mint, tokenProgram);

      const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
        program.programId,
        bankPk,
      );
      const [claimAccount] = findJuplendClaimAccountPda(
        liquidityVaultAuthority,
        bank.mint,
      );

      instructions.push(
        await program.methods
          .juplendWithdraw(withdrawAmount, withdrawAll ? true : null)
          .accounts({
            marginfiAccount: config.ACCOUNT,
            bank: bankPk,
            destinationTokenAccount: ata,
            lendingAdmin,
            supplyTokenReservesLiquidity: lending.tokenReservesLiquidity,
            lendingSupplyPositionOnLiquidity: lending.supplyPositionOnLiquidity,
            rateModel: juplendAccounts.rateModel,
            vault: juplendAccounts.vault,
            claimAccount,
            liquidity: juplendAccounts.liquidity,
            liquidityProgram: juplendAccounts.liquidityProgram,
            rewardsRateModel: juplendAccounts.rewardsRateModel,
            tokenProgram,
          })
          .accountsPartial({
            fTokenMint: lending.fTokenMint,
          })
          .remainingAccounts(withdrawMeta)
          .instruction(),
      );
    } else {
      instructions.push(
        await program.methods
          .lendingAccountWithdraw(withdrawAmount, withdrawAll)
          .accounts({
            marginfiAccount: config.ACCOUNT,
            bank: bankPk,
            destinationTokenAccount: ata,
            tokenProgram,
          })
          .remainingAccounts(withdrawMeta)
          .instruction(),
      );
    }

    if (withdrawAll) {
      remainingAccounts = remainingAccounts.filter(
        (a) => a[0].toBase58() != bankPk.toBase58(),
      );
    } else {
      break;
    }
  }

  const endMeta: AccountMeta[] = remainingAccounts.map(([bankPk]) => ({
    pubkey: bankPk,
    isSigner: false,
    isWritable: true,
  }));

  instructions.push(
    await program.methods
      .endDeleverage()
      .accounts({
        marginfiAccount: config.ACCOUNT,
      })
      // Explicit: Anchor would read it off the account, which is unset until the record exists.
      .accountsPartial({ liquidationRecord: liqRecordKey })
      .remainingAccounts(endMeta)
      .instruction(),
  );

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

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const v0Message = new TransactionMessage({
    payerKey: user.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(luts);
  let ok = false;
  const v0Tx = new VersionedTransaction(v0Message);
  if (!sendTx) {
    const sim = await connection.simulateTransaction(v0Tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
    ok = !sim.value.err;
    console.log(
      `SIMULATION ${ok ? "OK" : "FAILED " + JSON.stringify(sim.value.err)}: ` +
        `${v0Tx.serialize().length} bytes, ${sim.value.unitsConsumed} CU`,
    );
    if (!ok) {
      console.log(
        (sim.value.logs ?? [])
          .filter((l) => /Error|failed|insufficient|health|Program log: [a-z_]/.test(l))
          .slice(-12)
          .join("\n"),
      );
    }
    return { skipped: false, ok, repaidNative: liabNative, repaidUsd: liabUsd, seizedUsd };
  }
  try {
    v0Tx.sign([user.wallet.payer]);
    const signature = await connection.sendTransaction(v0Tx, {
      maxRetries: 2,
    });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    ok = true;
    console.log("Success:", signature);
  } catch (error) {
    console.error("Transaction failed:", briefError(error));
    if (
      String(error).includes("Transaction too large") ||
      String(error).includes("encoding overruns Uint8Array")
    ) {
      const keys = new Set(
        instructions.flatMap((i) => i.keys.map((m) => m.pubkey.toBase58())),
      );
      const keysArray = [...keys].map((k) => new PublicKey(k));
      for (let i = 0; i < keysArray.length; i += 8) {
        const chunk = keysArray.slice(i, i + 8);
        await updateLut(
          true,
          {
            LUT: config.LUT,
            KEYS: chunk,
          },
          walletPath,
        );
      }
      try {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash();
        const lutLookup = await connection.getAddressLookupTable(config.LUT);
        const v0Message = new TransactionMessage({
          payerKey: user.wallet.publicKey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message([lutLookup.value]);
        const v0Tx = new VersionedTransaction(v0Message);

        v0Tx.sign([user.wallet.payer]);
        const signature = await connection.sendTransaction(v0Tx, {
          maxRetries: 2,
        });
        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        ok = true;
        console.log("Success:", signature);
      } catch (error) {
        console.error("Transaction failed:", briefError(error));
      }
    }
    if (String(error).includes("Transaction locked too many accounts")) {
      // Analyze the output and decrease the amount of locked accs
      countUniqueWritableKeys(v0Tx, luts);
    }
  }

  return {
    skipped: false,
    ok,
    repaidNative: liabNative,
    repaidUsd: liabUsd,
    seizedUsd,
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}

/**
 * Simulates `pulse_health` on the account (after the same venue refreshes the deleverage tx runs)
 * and returns, per bank, the price the program used for that balance. Empty on failure; callers
 * fall back to the bank caches.
 */
async function pulsePrices(
  program: any,
  connection: Connection,
  payer: PublicKey,
  config: Config,
  groups: PublicKey[][],
  refreshIxs: TransactionInstruction[],
): Promise<Map<string, BigNumber>> {
  const prices = new Map<string, BigNumber>();
  try {
    const pulse = await program.methods
      .lendingAccountPulseHealth()
      .accounts({ marginfiAccount: config.ACCOUNT })
      .remainingAccounts(
        groups.flat().map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      )
      .instruction();
    const lut = (await connection.getAddressLookupTable(config.LUT)).value;
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: [...refreshIxs, pulse],
      }).compileToV0Message(lut ? [lut] : []),
    );
    const sim = await connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: { encoding: "base64", addresses: [config.ACCOUNT.toBase58()] },
    });
    const data = sim.value.accounts?.[0]?.data?.[0];
    if (sim.value.err || !data) throw new Error(JSON.stringify(sim.value.err));
    const acc = program.coder.accounts.decode("marginfiAccount", Buffer.from(data, "base64"));
    const active = acc.lendingAccount.balances.filter((b: any) => b.active);
    active.forEach((b: any, i: number) => {
      const price = bytesToF64(acc.healthCache.prices[i]);
      if (price > 0) prices.set(b.bankPk.toBase58(), BigNumber(price));
    });
    console.log(`Live prices from a simulated pulse_health: ${prices.size}/${active.length} balances`);
  } catch (error) {
    console.warn("pulse_health simulation failed, sizing from bank caches:", briefError(error));
  }
  return prices;
}

/**
 * Preflight for a token-funded `repay_all`.
 *
 * Without TOKENLESS_REPAYMENTS_ALLOWED the repay instruction transfers the entire debt out of
 * `liabAta` in one shot, so an underfunded ATA fails the whole deleverage tx at the SPL transfer
 * — after the risk engine work, with a token error that says nothing about why. Throw here
 * instead, with the exact shortfall, and abort the run: every later account would fail the same
 * way, and each attempt burns a `marginfiAccountInitLiqRecord` rent payment.
 */
async function assertRepayFunded(
  connection: Connection,
  liabAta: PublicKey,
  liabNative: BigNumber,
  liabBank: any,
  config: Config,
) {
  const required = liabNative
    .multipliedBy(10_000 + REPAY_FUNDING_BUFFER_BPS)
    .dividedBy(10_000)
    .integerValue(BigNumber.ROUND_CEIL);

  const decimals = liabBank.mintDecimals;
  const ui = (native: BigNumber) => native.dividedBy(10 ** decimals).toString();

  const info = await connection.getAccountInfo(liabAta);
  if (!info) {
    throw new InsufficientRepayFunds(
      config.ACCOUNT,
      required,
      BigNumber(0),
      required,
      decimals,
      liabBank.mint,
    );
  }

  const balance = new BigNumber(
    (await connection.getTokenAccountBalance(liabAta)).value.amount,
  );

  console.log(
    `Repay funding check: need ${ui(required)} (debt ${ui(liabNative)} + ` +
      `${REPAY_FUNDING_BUFFER_BPS}bps), have ${ui(balance)}`,
  );

  if (balance.isLessThan(required)) {
    throw new InsufficientRepayFunds(
      config.ACCOUNT,
      required.minus(balance),
      balance,
      required,
      decimals,
      liabBank.mint,
    );
  }
}

function parseAccountBanks(json: unknown): AccountBanks {
  if (!Array.isArray(json)) throw new Error("Expected array");

  const result: AccountBanks = new Map();

  for (const entry of json as any[]) {
    if (
      typeof entry?.publicKey !== "string" ||
      !Array.isArray(entry?.balances)
    ) {
      throw new Error("Invalid entry");
    }

    const accountPk = new PublicKey(entry.publicKey);

    const banks: Balances = entry.balances.map((b: any) => {
      if (typeof b?.bankPk !== "string") {
        throw new Error("Invalid balance");
      }
      const isCollateral =
        b.assetShares !== "-" &&
        Number.isFinite(Number(b.assetShares)) &&
        Number(b.assetShares) > 0;

      let shares: BigNumber;
      if (isCollateral) {
        shares = new BigNumber(b.assetShares);
      } else {
        shares = new BigNumber(b.liabilityShares);
      }
      return {
        bankPk: new PublicKey(b.bankPk),
        isCollateral,
        shares,
        hasEmissions: b.hasEmissions,
      };
    });

    result.set(accountPk, banks);
  }

  return result;
}

function countUniqueWritableKeys(
  vtx: VersionedTransaction,
  alts: AddressLookupTableAccount[],
) {
  const msg = vtx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: alts });

  const writable = new Set<string>();

  for (let i = 0; i < keys.length; i++) {
    if (msg.isAccountWritable(i)) {
      writable.add(keys.get(i)!.toBase58());
    }
  }

  console.log("total keys:", keys.length);
  console.log("unique writable keys:", writable.size);
}
