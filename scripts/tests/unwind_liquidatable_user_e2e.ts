import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  composeRemainingAccounts,
  getOraclesAndKaminoIxes,
} from "../../lib/utils";
import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import { KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import { dumpLiquidatee } from "./e2e_helpers";
import { existsSync, readFileSync, rmSync } from "fs";
import { repay } from "../user/repay";
import { withdrawKamino } from "../kamino/withdraw_kamino";
import { withdraw } from "../user/withdraw";
import { closeAccount } from "../user/close_account";
import { closeBank } from "../admin/close_bank";
import { Config, State } from "./create_liquidatable_user_e2e";
import { sleep, wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { updateLut } from "../../luts/update_lut";
import { withdrawJuplend } from "../juplend/withdraw";

/**
 * Reverses create_liquidatable_user_e2e.ts. Eva may already have liquidated part of the position,
 * so every step reads the liquidatee's live balances and derives its remaining accounts from them
 * (`getOraclesAndKaminoIxes`) instead of assuming the layout the create script left.
 *
 * Health checks price every open position in Live mode, so each withdraw also refreshes the Kamino
 * reserves and JupLend rates still open. Order: debt, then regular banks, then Kamino, then
 * JupLend last, when nothing else needs refreshing.
 *
 * `reset` (reset_liquidatable_user_e2e.ts) stops once the liquidatees are empty, keeping the group,
 * banks and liquidator for the next create run.
 */
export async function unwind(reset: boolean) {
  const raw_config = readFileSync("liquidation_e2e_config.json", "utf8");
  const config = parseConfig(raw_config);
  const raw_state = readFileSync("liquidation_e2e_state.json", "utf8");
  const state = parseState(raw_state);

  const user = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATEE_WALLET_PATH);
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());

  type KaminoVenue = { reserve: PublicKey; market: PublicKey; reserveOracle: PublicKey; mint: PublicKey };
  const kaminoVenues = new Map<string, KaminoVenue>();
  [...state.kaminoBanks, ...state.kaminoPythBanks].forEach((b) =>
    kaminoVenues.set(b.toBase58(), {
      reserve: config.KAMINO_RESERVE,
      market: config.KAMINO_MARKET,
      reserveOracle: config.KAMINO_RESERVE_ORACLE,
      mint: config.KAMINO_COLLATERAL_MINT,
    }),
  );
  state.kaminoMsolBanks.forEach((b) =>
    kaminoVenues.set(b.toBase58(), {
      reserve: config.MSOL_KAMINO_RESERVE,
      market: config.MSOL_KAMINO_MARKET,
      reserveOracle: config.MSOL_KAMINO_RESERVE_ORACLE,
      mint: config.MSOL_MINT,
    }),
  );
  state.kaminoLstBanks.forEach((b) =>
    kaminoVenues.set(b.toBase58(), {
      reserve: config.JITOSOL_KAMINO_RESERVE,
      market: config.JITOSOL_KAMINO_MARKET,
      reserveOracle: config.JITOSOL_KAMINO_RESERVE_ORACLE,
      mint: config.JITOSOL_MINT,
    }),
  );
  const juplend = new Set(
    [...state.juplendBanks, ...state.fixedJuplendBanks].map((b) => b.toBase58()),
  );

  // A create run that stopped early may not have opened them all.
  const liquidatees = [state.liquidatee, ...state.sandwichLiquidatees].filter(
    (k): k is PublicKey => k !== undefined,
  );
  /** The liquidatee being unwound: the 14-position one, then each sandwich liquidatee. */
  let liquidatee = liquidatees[0];
  /** The liquidatee's open balances, each as `[bank, oracle accounts...]`. */
  const openGroups = async () =>
    (await getOraclesAndKaminoIxes(user.program, user.kaminoProgram, liquidatee))[0];
  /** Health-check accounts for withdrawing `bank`: every other open balance, then `bank` last. */
  const remainingFor = (groups: PublicKey[][], bank: PublicKey) => {
    const own = groups.find((g) => g[0].equals(bank))!;
    const others = groups.filter((g) => !g[0].equals(bank));
    return [...composeRemainingAccounts(others), ...own];
  };
  /** Venues the other open balances need refreshed. */
  const refreshFor = (groups: PublicKey[][], bank: PublicKey) => {
    const others = groups.map((g) => g[0]).filter((b) => !b.equals(bank));
    return {
      KAMINO_RESERVES: others
        .filter((b) => kaminoVenues.has(b.toBase58()))
        .map((b) => kaminoVenues.get(b.toBase58())!.reserve),
      JUPLEND_STATES: others.some((b) => juplend.has(b.toBase58()))
        ? [config.JUPLEND_LENDING]
        : [],
    };
  };

  for (liquidatee of liquidatees) {
    console.log(`\n\n\n UNWINDING LIQUIDATEE ${liquidatee}`);
    console.log("\n\n\n 1. UPDATE LUT");
    const allKeys = composeRemainingAccounts(await openGroups());
    for (let start = 0; start < allKeys.length; start += 10) {
      await updateLut(
        true,
        { LUT: config.LUT, KEYS: allKeys.slice(start, start + 10) },
        config.LIQUIDATOR_WALLET_PATH,
      );
      await sleep(1000);
    }

    console.log("\n\n\n 2. REPAY DEBT BY LIQUIDATEE");
    const liquidateeAcc: any = await user.program.account.marginfiAccount.fetch(liquidatee);
    const debtBalance = liquidateeAcc.lendingAccount.balances.find(
      (b: any) => b.active && b.bankPk.equals(state.debtBank),
    );
    if (debtBalance && wrappedI80F48toBigNumber(debtBalance.liabilityShares).gt(0)) {
      await repay(
        true,
        {
          PROGRAM_ID: config.PROGRAM_ID,
          BANK: state.debtBank,
          ACCOUNT: liquidatee,
          AMOUNT: new BN(0), // doesn't matter, since we repay all
          REPAY_ALL: true,
          MINT: config.DEBT_MINT,
          ADD_COMPUTE_UNITS: false,
          // Repay runs no health check; only the closing bank is passed.
          NEW_REMAINING: [state.debtBank, config.DEBT_ORACLE],
        },
        config.LIQUIDATEE_WALLET_PATH,
      );
      await sleep(2000);
    } else {
      console.log("no debt left");
    }

    console.log("\n\n\n 3. WITHDRAW EVERY REMAINING COLLATERAL BY LIQUIDATEE");
    const rank = (bank: PublicKey) =>
      juplend.has(bank.toBase58()) ? 2 : kaminoVenues.has(bank.toBase58()) ? 1 : 0;
    const attempts = new Map<string, number>();
    for (;;) {
      const open = await openGroups();
      const groups = open.filter((g) => !g[0].equals(state.debtBank));
      if (groups.length === 0) break;
      groups.sort((a, b) => rank(a[0]) - rank(b[0]));
      const bank = groups[0][0];
      const remaining = remainingFor(open, bank);
      const refresh = refreshFor(open, bank);
      console.log(`\n withdrawing all from ${bank.toBase58()}`);

      if (juplend.has(bank.toBase58())) {
        await withdrawJuplend(
          true,
          {
            PROGRAM_ID: config.PROGRAM_ID,
            BANK: bank,
            ACCOUNT: liquidatee,
            AMOUNT: new BN(0),
            WITHDRAW_ALL: true,
            LUT: config.LUT,
            NEW_REMAINING: remaining,
            ADD_COMPUTE_UNITS: true,
          },
          config.LIQUIDATEE_WALLET_PATH,
        );
      } else if (kaminoVenues.has(bank.toBase58())) {
        const venue = kaminoVenues.get(bank.toBase58())!;
        await withdrawKamino(
          true,
          {
            PROGRAM_ID: config.PROGRAM_ID,
            BANK: bank,
            ACCOUNT: liquidatee,
            AMOUNT: new BN(0),
            WITHDRAW_ALL: true,
            BANK_MINT: venue.mint,
            KAMINO_RESERVE: venue.reserve,
            KAMINO_MARKET: venue.market,
            RESERVE_ORACLE: venue.reserveOracle,
            LUT: config.LUT,
            NEW_REMAINING: remaining,
            ADD_COMPUTE_UNITS: true,
            OTHER_REFRESH: refresh,
          },
          config.LIQUIDATEE_WALLET_PATH,
        );
      } else {
        const bankAcc: any = await user.program.account.bank.fetch(bank);
        await withdraw(
          true,
          {
            PROGRAM_ID: config.PROGRAM_ID,
            BANK: bank,
            ACCOUNT: liquidatee,
            MINT: bankAcc.mint,
            AMOUNT: new BN(0),
            WITHDRAW_ALL: true,
            REMAINING: remaining,
            ADD_COMPUTE_UNITS: true,
            REFRESH: refresh,
            LUT: config.LUT,
          },
          config.LIQUIDATEE_WALLET_PATH,
        );
      }
      await sleep(2000);

      const after = (await openGroups()).map((g) => g[0].toBase58());
      if (after.includes(bank.toBase58())) {
        // Usually the tx just didn't land (expired blockhash); the next pass retries the same bank.
        const tries = (attempts.get(bank.toBase58()) ?? 0) + 1;
        attempts.set(bank.toBase58(), tries);
        if (tries >= 3) {
          throw new Error(`withdraw from ${bank.toBase58()} did not close the balance; stopping`);
        }
        console.log(`balance still open after attempt ${tries}, retrying`);
      }
    }
  }

  /**
   * The liquidatee account can no longer be closed immediately: its liquidation
   * record must first sit inactive for at least 60 days (from the last
   * liquidation), then be closed, and only then can the account be closed.
   *
   * This dumps the liquidatee pubkey and the timestamp after which it becomes
   * closable (last liquidation + 60 days, or "now" if it was never liquidated)
   * to liquidatees_pending_closing.txt so it can be finished manually later.
   */
  const dumped = existsSync("liquidatees_pending_closing.txt")
    ? readFileSync("liquidatees_pending_closing.txt", "utf8")
    : "";
  for (const account of liquidatees) {
    if (dumped.includes(account.toBase58())) continue; // listed by an earlier unwind
    await dumpLiquidatee(config.PROGRAM_ID, config.LIQUIDATEE_WALLET_PATH, account);
  }

  if (reset) {
    console.log("Reset finished: the group, banks and liquidator are kept for the next create run.");
    return;
  }

  console.log("\n\n\n 4. WITHDRAW FROM DEBT BANK BY LIQUIDATOR");
  // A create run that stopped early may not have reached the debt bank.
  if (!state.debtBank.equals(PublicKey.default)) await withdraw(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      ACCOUNT: state.liquidator,
      BANK: state.debtBank,
      MINT: config.DEBT_MINT,
      AMOUNT: new BN(0), // doesn't matter, since we withdraw all
      WITHDRAW_ALL: true,
      REMAINING: [state.debtBank, config.DEBT_ORACLE], // required even in case of withdraw all
      ADD_COMPUTE_UNITS: false,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 5. CLOSE LIQUIDATOR ACCOUNT");
  // Already gone if an earlier unwind of this run got this far.
  if (await user.connection.getAccountInfo(state.liquidator)) await closeAccount(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: state.liquidator },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 6. CLOSE ALL BANKS");
  const allBanks = [
    ...state.p0Banks,
    ...state.ptBanks,
    ...state.pythMsolBanks,
    ...state.pythLstBanks,
    ...state.scopeBanks,
    ...state.kaminoBanks,
    ...state.kaminoMsolBanks,
    ...state.kaminoLstBanks,
    ...state.juplendBanks,
    ...state.kaminoPythBanks,
    ...state.fixedJuplendBanks,
    state.debtBank,
  ];
  // Skip banks a stopped create run never got to create (its failed adds are still in the state).
  const infos = await user.connection.getMultipleAccountsInfo(allBanks);
  const existingBanks = allBanks.filter((_, i) => infos[i]?.owner.equals(user.program.programId));
  for (let start = 0; start < existingBanks.length; start += 5) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANKS: existingBanks.slice(start, start + 5), FORCE: true },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  // With every bank gone the state file only describes a dead setup; drop it so the next create
  // starts fresh instead of refusing to reuse it.
  const left = (await user.connection.getMultipleAccountsInfo(existingBanks)).filter(Boolean);
  if (left.length === 0) {
    rmSync("liquidation_e2e_state.json");
    console.log("Cleanup finished; removed liquidation_e2e_state.json.");
  } else {
    console.log(`Cleanup finished, but ${left.length} bank(s) are still open; kept the state file.`);
  }
}

const pkFromString = (s: any) => new PublicKey(s);

function parseConfig(rawConfig: string): Config {
  const json = JSON.parse(rawConfig) as Config;

  return {
    PROGRAM_ID: json.PROGRAM_ID,
    LIQUIDATOR_WALLET_PATH: json.LIQUIDATOR_WALLET_PATH,
    LIQUIDATEE_WALLET_PATH: json.LIQUIDATEE_WALLET_PATH,
    P0_COLLATERAL_MINT: pkFromString(json.P0_COLLATERAL_MINT),
    PT_COLLATERAL_MINT: pkFromString(json.PT_COLLATERAL_MINT),
    PT_EXPONENT_VAULT: pkFromString(json.PT_EXPONENT_VAULT),
    PT_BASE_ORACLE: pkFromString(json.PT_BASE_ORACLE),
    KAMINO_COLLATERAL_MINT: pkFromString(json.KAMINO_COLLATERAL_MINT),
    KAMINO_COLLATERAL_ORACLE: pkFromString(json.KAMINO_COLLATERAL_ORACLE),
    JUPLEND_COLLATERAL_MINT: pkFromString(json.JUPLEND_COLLATERAL_MINT),
    JUPLEND_COLLATERAL_ORACLE: pkFromString(json.JUPLEND_COLLATERAL_ORACLE),
    DEBT_MINT: pkFromString(json.DEBT_MINT),
    DEBT_ORACLE: pkFromString(json.DEBT_ORACLE),
    KAMINO_RESERVE: pkFromString(json.KAMINO_RESERVE),
    KAMINO_MARKET: pkFromString(json.KAMINO_MARKET),
    KAMINO_RESERVE_ORACLE: pkFromString(json.KAMINO_RESERVE_ORACLE),
    KAMINO_FARM_STATE: pkFromString(json.KAMINO_FARM_STATE),
    MSOL_MINT: pkFromString(json.MSOL_MINT),
    MSOL_BASE_ORACLE: pkFromString(json.MSOL_BASE_ORACLE),
    MARINADE_STATE: pkFromString(json.MARINADE_STATE),
    MSOL_KAMINO_RESERVE: pkFromString(json.MSOL_KAMINO_RESERVE),
    MSOL_KAMINO_MARKET: pkFromString(json.MSOL_KAMINO_MARKET),
    MSOL_KAMINO_RESERVE_ORACLE: pkFromString(json.MSOL_KAMINO_RESERVE_ORACLE),
    MSOL_KAMINO_FARM_STATE: pkFromString(json.MSOL_KAMINO_FARM_STATE),
    JUPLEND_LENDING: pkFromString(json.JUPLEND_LENDING),
    JUPLEND_F_TOKEN_MINT: pkFromString(json.JUPLEND_F_TOKEN_MINT),
    JITOSOL_MINT: pkFromString(json.JITOSOL_MINT),
    JITOSOL_STAKE_POOL: pkFromString(json.JITOSOL_STAKE_POOL),
    JITOSOL_KAMINO_RESERVE: pkFromString(json.JITOSOL_KAMINO_RESERVE),
    JITOSOL_KAMINO_MARKET: pkFromString(json.JITOSOL_KAMINO_MARKET),
    JITOSOL_KAMINO_RESERVE_ORACLE: pkFromString(json.JITOSOL_KAMINO_RESERVE_ORACLE),
    JITOSOL_KAMINO_FARM_STATE: pkFromString(json.JITOSOL_KAMINO_FARM_STATE),
    SCOPE_PRICES: pkFromString(json.SCOPE_PRICES),
    SCOPE_USDC_ENTRY: json.SCOPE_USDC_ENTRY,
    SCOPE_USDT_ENTRY: json.SCOPE_USDT_ENTRY,
    LUT: pkFromString(json.LUT),
  };
}

export function parseState(raw: string): State {
  const json = JSON.parse(raw) as State;

  return {
    marginfiGroup: pkFromString(json.marginfiGroup),
    liquidator: pkFromString(json.liquidator),
    liquidatee: json.liquidatee ? pkFromString(json.liquidatee) : undefined,
    debtBank: json.debtBank ? pkFromString(json.debtBank) : PublicKey.default,
    p0Banks: (json.p0Banks ?? []).map(pkFromString),
    ptBanks: (json.ptBanks ?? []).map(pkFromString),
    kaminoBanks: (json.kaminoBanks ?? []).map(pkFromString),
    kaminoObligations: (json.kaminoObligations ?? []).map(pkFromString),
    kaminoMsolBanks: (json.kaminoMsolBanks ?? []).map(pkFromString),
    kaminoMsolObligations: (json.kaminoMsolObligations ?? []).map(pkFromString),
    kaminoLstBanks: (json.kaminoLstBanks ?? []).map(pkFromString),
    kaminoLstObligations: (json.kaminoLstObligations ?? []).map(pkFromString),
    pythMsolBanks: (json.pythMsolBanks ?? []).map(pkFromString),
    pythLstBanks: (json.pythLstBanks ?? []).map(pkFromString),
    scopeBanks: (json.scopeBanks ?? []).map(pkFromString),
    juplendBanks: (json.juplendBanks ?? []).map(pkFromString),
    kaminoPythBanks: (json.kaminoPythBanks ?? []).map(pkFromString),
    fixedJuplendBanks: (json.fixedJuplendBanks ?? []).map(pkFromString),
    sandwichLiquidatees: (json.sandwichLiquidatees ?? []).map(pkFromString),
  };
}

if (require.main === module) {
  unwind(false).catch((err) => {
    console.error(err);
  });
}
