import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  composeRemainingAccounts,
  getOraclesAndKaminoIxes,
} from "../../lib/utils";
import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import { KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import { appendFileSync, readFileSync } from "fs";
import { fetchLiqRecord } from "../fetch/fetch-liq-record";
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
 */
async function main() {
  const raw_config = readFileSync("liquidation_e2e_config.json", "utf8");
  const config = parseConfig(raw_config);
  const raw_state = readFileSync("liquidation_e2e_state.json", "utf8");
  const state = parseState(raw_state);

  const user = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATEE_WALLET_PATH);
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());

  type KaminoVenue = { reserve: PublicKey; market: PublicKey; reserveOracle: PublicKey; mint: PublicKey };
  const kaminoVenues = new Map<string, KaminoVenue>();
  state.kaminoBanks.forEach((b) =>
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
  const juplend = new Set(state.juplendBanks.map((b) => b.toBase58()));

  /** The liquidatee's open balances, each as `[bank, oracle accounts...]`. */
  const openGroups = async () =>
    (await getOraclesAndKaminoIxes(user.program, user.kaminoProgram, state.liquidatee))[0];
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
  const liquidateeAcc: any = await user.program.account.marginfiAccount.fetch(state.liquidatee);
  const debtBalance = liquidateeAcc.lendingAccount.balances.find(
    (b: any) => b.active && b.bankPk.equals(state.debtBank),
  );
  if (debtBalance && wrappedI80F48toBigNumber(debtBalance.liabilityShares).gt(0)) {
    await repay(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        BANK: state.debtBank,
        ACCOUNT: state.liquidatee,
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
          ACCOUNT: state.liquidatee,
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
          ACCOUNT: state.liquidatee,
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
          ACCOUNT: state.liquidatee,
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
      throw new Error(`withdraw from ${bank.toBase58()} did not close the balance; stopping`);
    }
  }

  console.log("\n\n\n 4. WITHDRAW FROM DEBT BANK BY LIQUIDATOR");
  await withdraw(
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
  await closeAccount(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: state.liquidator },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  /**
   * The liquidatee account can no longer be closed immediately: its liquidation
   * record must first sit inactive for at least 60 days (from the last
   * liquidation), then be closed, and only then can the account be closed.
   *
   * This dumps the liquidatee pubkey and the timestamp after which it becomes
   * closable (last liquidation + 60 days, or "now" if it was never liquidated)
   * to liquidatees_pending_closing.txt so it can be finished manually later.
   */
  await dumpLiquidatee(config, state);

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
    state.debtBank,
  ];
  for (let start = 0; start < allBanks.length; start += 5) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANKS: allBanks.slice(start, start + 5), FORCE: true },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("Cleanup finished.");
}

async function dumpLiquidatee(config: Config, state: State) {
  const { liqRecordKey, record } = await fetchLiqRecord(
    { PROGRAM_ID: config.PROGRAM_ID, MARGINFI_ACCOUNT: state.liquidatee },
    config.LIQUIDATEE_WALLET_PATH,
  );

  const lastLiquidation = record.entries.reduce(
    (max: number, entry) => Math.max(max, Number(entry.timestamp)),
    0,
  );

  // 60 days of inactivity are required before the liq record (and then the
  // account) can be closed. If never liquidated, it can be closed immediately.
  const INACTIVITY_PERIOD_SECS = 60 * 24 * 60 * 60;
  const closableAfter =
    lastLiquidation > 0 ? lastLiquidation + INACTIVITY_PERIOD_SECS : 0;

  const closableAfterIso =
    closableAfter > 0
      ? new Date(closableAfter * 1000).toISOString()
      : "now (never liquidated)";

  const line =
    `${state.liquidatee.toString()}\t` +
    `lastLiquidation=${lastLiquidation}\t` +
    `closableAfter=${closableAfter}\t` +
    `closableAfterIso=${closableAfterIso}\n`;

  appendFileSync("liquidatees_pending_closing.txt", line);

  console.log(
    "LIQUIDATEE PENDING CLOSE (dumped to liquidatees_pending_closing.txt)",
  );
  console.log("liquidatee:      " + state.liquidatee.toString());
  console.log("liq record:      " + liqRecordKey.toString());
  console.log("last liquidation: " + lastLiquidation);
  console.log(
    "closable after:  " + closableAfter + " (" + closableAfterIso + ")",
  );
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
    liquidatee: pkFromString(json.liquidatee),
    debtBank: pkFromString(json.debtBank),
    p0Banks: json.p0Banks.map(pkFromString),
    ptBanks: (json.ptBanks ?? []).map(pkFromString),
    kaminoBanks: json.kaminoBanks.map(pkFromString),
    kaminoObligations: json.kaminoObligations.map(pkFromString),
    kaminoMsolBanks: (json.kaminoMsolBanks ?? []).map(pkFromString),
    kaminoMsolObligations: (json.kaminoMsolObligations ?? []).map(pkFromString),
    kaminoLstBanks: (json.kaminoLstBanks ?? []).map(pkFromString),
    kaminoLstObligations: (json.kaminoLstObligations ?? []).map(pkFromString),
    pythMsolBanks: (json.pythMsolBanks ?? []).map(pkFromString),
    pythLstBanks: (json.pythLstBanks ?? []).map(pkFromString),
    scopeBanks: (json.scopeBanks ?? []).map(pkFromString),
    juplendBanks: json.juplendBanks.map(pkFromString),
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
