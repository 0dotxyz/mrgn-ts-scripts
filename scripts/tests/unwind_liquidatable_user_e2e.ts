import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { composeRemainingAccounts } from "../../lib/utils";
import { appendFileSync, readFileSync } from "fs";
import { fetchLiqRecord } from "../fetch/fetch-liq-record";
import { repay } from "../user/repay";
import { withdrawKamino } from "../kamino/withdraw_kamino";
import { withdraw } from "../user/withdraw";
import { closeAccount } from "../user/close_account";
import { closeBank } from "../admin/close_bank";
import { Config, State } from "./create_liquidatable_user_e2e";
import { sleep } from "@mrgnlabs/mrgn-common";
import { updateLut } from "../../luts/update_lut";
import { withdrawDrift } from "../drift/withdraw";
import { withdrawJuplend } from "../juplend/withdraw";

async function main() {
  const raw_config = readFileSync("liquidation_e2e_config.json", "utf8");
  const config = parseConfig(raw_config);
  const raw_state = readFileSync("liquidation_e2e_state.json", "utf8");
  const state = parseState(raw_state);

  let p0RemainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < state.p0Banks.length; i++) {
    p0RemainingAccounts.push([
      state.p0Banks[i], // only bank, for the Fixed oracle
    ]);
  }
  let kaminoRemainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < state.kaminoBanks.length; i++) {
    kaminoRemainingAccounts.push([
      state.kaminoBanks[i],
      config.KAMINO_COLLATERAL_ORACLE,
      config.KAMINO_RESERVE,
    ]);
  }
  let driftRemainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < state.driftBanks.length; i++) {
    driftRemainingAccounts.push([
      state.driftBanks[i],
      config.DRIFT_COLLATERAL_ORACLE,
      config.DRIFT_SPOT_MARKET,
    ]);
  }
  let juplendRemainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < state.juplendBanks.length; i++) {
    juplendRemainingAccounts.push([
      state.juplendBanks[i],
      config.JUPLEND_COLLATERAL_ORACLE,
      config.JUPLEND_LENDING,
    ]);
  }
  let remainingAccounts: PublicKey[][] = [
    ...kaminoRemainingAccounts,
    ...driftRemainingAccounts,
    ...juplendRemainingAccounts,
  ];

  console.log("\n\n\n 1. UPDATE LUT");
  await updateLut(
    true,
    {
      LUT: config.LUT,
      KEYS: state.p0Banks.concat(state.kaminoBanks).concat(state.driftBanks).concat(state.juplendBanks).concat(state.debtBank),
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 2. REPAY DEBT BY LIQUIDATEE");
  const NEW_REMAINING = composeRemainingAccounts(remainingAccounts);
  // Repay all still requires the closing bank's oracles. They must come last.
  NEW_REMAINING.push(state.debtBank, config.DEBT_ORACLE, config.DEBT_MINT);

  const repayConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: state.debtBank,
    ACCOUNT: state.liquidatee,
    AMOUNT: new BN(0), // doesn't matter, since we repay all
    REPAY_ALL: true,
    MINT: config.DEBT_MINT,
    ADD_COMPUTE_UNITS: false,
    NEW_REMAINING,
  };
  await repay(true, repayConfig, config.LIQUIDATEE_WALLET_PATH);
  await sleep(1000);

  console.log("\n\n\n 3. WITHDRAW FROM P0 BANKS BY LIQUIDATEE");
  let p0WithdrawConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: state.p0Banks[0],
    ACCOUNT: state.liquidatee,
    AMOUNT: new BN(0), // doesn't matter, since we withdraw all
    WITHDRAW_ALL: true,
    MINT: config.P0_COLLATERAL_MINT,
    LUT: config.LUT, // a liquidator-created LUT
    REMAINING: [] as PublicKey[],
    ADD_COMPUTE_UNITS: true,
  };

  for (let i = 0; i < state.p0Banks.length; i++) {
    remainingAccounts = [
      ...kaminoRemainingAccounts,
      ...driftRemainingAccounts,
      ...juplendRemainingAccounts,
    ];
    // Add all active P0 banks except the one to withdraw from
    for (let j = i + 1; j < state.p0Banks.length; j++) {
      remainingAccounts.push([state.p0Banks[j]]);
    }

    const REMAINING = composeRemainingAccounts(remainingAccounts);
    // Withdraw all still requires the closing bank's oracles. They must come last.
    REMAINING.push(
      state.p0Banks[i],
    );

    p0WithdrawConfig.BANK = state.p0Banks[i];
    p0WithdrawConfig.REMAINING = REMAINING;
    await withdraw(true, p0WithdrawConfig, config.LIQUIDATEE_WALLET_PATH);
    await sleep(1000);
  }

  console.log("\n\n\n 4. WITHDRAW FROM KAMINO BANKS BY LIQUIDATEE");
  let kaminoWithdrawConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: state.kaminoBanks[0],
    ACCOUNT: state.liquidatee,
    AMOUNT: new BN(0), // doesn't matter, since we withdraw all
    WITHDRAW_ALL: true,
    BANK_MINT: config.KAMINO_COLLATERAL_MINT,
    KAMINO_RESERVE: config.KAMINO_RESERVE,
    KAMINO_MARKET: config.KAMINO_MARKET,
    RESERVE_ORACLE: config.KAMINO_RESERVE_ORACLE,
    FARM_STATE: config.KAMINO_FARM_STATE,
    LUT: config.LUT, // a liquidator-created LUT
    NEW_REMAINING: [] as PublicKey[],
    ADD_COMPUTE_UNITS: true,
  };

  for (let i = 0; i < state.kaminoBanks.length; i++) {
    remainingAccounts = [
      ...driftRemainingAccounts,
      ...juplendRemainingAccounts,
    ];
    // Add all active Kamino banks except the one to withdraw from
    for (let j = i + 1; j < state.kaminoBanks.length; j++) {
      remainingAccounts.push([
        state.kaminoBanks[j],
        config.KAMINO_COLLATERAL_ORACLE,
        config.KAMINO_RESERVE,
      ]);
    }

    const NEW_REMAINING = composeRemainingAccounts(remainingAccounts);
    // Withdraw all still requires the closing bank's oracles. They must come last.
    NEW_REMAINING.push(
      state.kaminoBanks[i],
      config.KAMINO_COLLATERAL_ORACLE,
      config.KAMINO_RESERVE,
    );

    kaminoWithdrawConfig.BANK = state.kaminoBanks[i];
    kaminoWithdrawConfig.NEW_REMAINING = NEW_REMAINING;
    await withdrawKamino(
      true,
      kaminoWithdrawConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 5. WITHDRAW FROM DRIFT BANKS BY LIQUIDATEE");
  let driftWithdrawConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: state.driftBanks[0],
    ACCOUNT: state.liquidatee,
    AMOUNT: new BN(0), // doesn't matter, since we withdraw all
    WITHDRAW_ALL: true,

    DRIFT_MARKET_INDEX: config.DRIFT_MARKET_INDEX,
    DRIFT_ORACLE: config.DRIFT_ORACLE,

    LUT: config.LUT, // a liquidator-created LUT

    NEW_REMAINING: [] as PublicKey[],
    ADD_COMPUTE_UNITS: true,
  };

  for (let i = 0; i < state.driftBanks.length; i++) {
    remainingAccounts = [...juplendRemainingAccounts];
    // Add all active Drift banks except the one to withdraw from
    for (let j = i + 1; j < state.driftBanks.length; j++) {
      remainingAccounts.push([
        state.driftBanks[j],
        config.DRIFT_COLLATERAL_ORACLE,
        config.DRIFT_SPOT_MARKET,
      ]);
    }

    const NEW_REMAINING = composeRemainingAccounts(remainingAccounts);
    // Withdraw all still requires the closing bank's oracles. They must come last.
    NEW_REMAINING.push(
      state.driftBanks[i],
      config.DRIFT_COLLATERAL_ORACLE,
      config.DRIFT_SPOT_MARKET,
    );

    driftWithdrawConfig.BANK = state.driftBanks[i];
    driftWithdrawConfig.NEW_REMAINING = NEW_REMAINING;
    await withdrawDrift(
      true,
      driftWithdrawConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 6. WITHDRAW FROM JUPLEND BANKS BY LIQUIDATEE");
  let juplendWithdrawConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: state.juplendBanks[0],
    ACCOUNT: state.liquidatee,
    AMOUNT: new BN(0), // doesn't matter, since we withdraw all
    WITHDRAW_ALL: true,

    LUT: config.LUT, // a liquidator-created LUT

    NEW_REMAINING: [] as PublicKey[],
    ADD_COMPUTE_UNITS: true,
  };

  for (let i = 0; i < state.juplendBanks.length; i++) {
    let remainingAccounts = [];
    // Add all active Juplend banks except the one to withdraw from
    for (let j = i + 1; j < state.juplendBanks.length; j++) {
      remainingAccounts.push([
        state.juplendBanks[j],
        config.JUPLEND_COLLATERAL_ORACLE,
        config.JUPLEND_LENDING,
      ]);
    }

    const NEW_REMAINING = composeRemainingAccounts(remainingAccounts);
    // Withdraw all still requires the closing bank's oracles. They must come last.
    NEW_REMAINING.push(
      state.juplendBanks[i],
      config.JUPLEND_COLLATERAL_ORACLE,
      config.JUPLEND_LENDING,
    );

    juplendWithdrawConfig.BANK = state.juplendBanks[i];
    juplendWithdrawConfig.NEW_REMAINING = NEW_REMAINING;
    await withdrawJuplend(
      true,
      juplendWithdrawConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 7. WITHDRAW FROM DEBT BANK BY LIQUIDATOR");
  let withdrawConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    ACCOUNT: state.liquidator,
    BANK: state.debtBank,
    MINT: config.DEBT_MINT,
    AMOUNT: new BN(0), // doesn't matter, since we withdraw all
    WITHDRAW_ALL: true,
    LUT: config.LUT, // a liquidator-created LUT
    REMAINING: [state.debtBank, config.DEBT_ORACLE, config.DEBT_MINT], // required even in case of withdraw all
    ADD_COMPUTE_UNITS: false,
  };
  await withdraw(true, withdrawConfig, config.LIQUIDATOR_WALLET_PATH);
  await sleep(1000);

  console.log("\n\n\n 8. CLOSE LIQUIDATOR AND LIQUIDATEE ACCOUNTS");
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

  console.log("\n\n\n 9. CLOSE ALL BANKS");
  for (let i = 0; i < state.kaminoBanks.length; i++) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: state.kaminoBanks[i] },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }
  for (let i = 0; i < state.driftBanks.length; i++) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: state.driftBanks[i] },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }
  for (let i = 0; i < state.juplendBanks.length; i++) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: state.juplendBanks[i] },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }
  await closeBank(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, BANK: state.debtBank },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

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
    KAMINO_COLLATERAL_MINT: pkFromString(json.KAMINO_COLLATERAL_MINT),
    KAMINO_COLLATERAL_ORACLE: pkFromString(json.KAMINO_COLLATERAL_ORACLE),
    DRIFT_COLLATERAL_MINT: pkFromString(json.DRIFT_COLLATERAL_MINT),
    DRIFT_COLLATERAL_ORACLE: pkFromString(json.DRIFT_COLLATERAL_ORACLE),
    JUPLEND_COLLATERAL_MINT: pkFromString(json.JUPLEND_COLLATERAL_MINT),
    JUPLEND_COLLATERAL_ORACLE: pkFromString(json.JUPLEND_COLLATERAL_ORACLE),
    DEBT_MINT: pkFromString(json.DEBT_MINT),
    DEBT_ORACLE: pkFromString(json.DEBT_ORACLE),
    KAMINO_RESERVE: pkFromString(json.KAMINO_RESERVE),
    KAMINO_MARKET: pkFromString(json.KAMINO_MARKET),
    KAMINO_RESERVE_ORACLE: pkFromString(json.KAMINO_RESERVE_ORACLE),
    KAMINO_FARM_STATE: pkFromString(json.KAMINO_FARM_STATE),
    DRIFT_SPOT_MARKET: pkFromString(json.DRIFT_SPOT_MARKET),
    DRIFT_MARKET_INDEX: json.DRIFT_MARKET_INDEX,
    DRIFT_ORACLE: pkFromString(json.DRIFT_ORACLE),
    JUPLEND_LENDING: pkFromString(json.JUPLEND_LENDING),
    JUPLEND_F_TOKEN_MINT: pkFromString(json.JUPLEND_F_TOKEN_MINT),
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
    kaminoBanks: json.kaminoBanks.map(pkFromString),
    kaminoObligations: json.kaminoObligations.map(pkFromString),
    driftBanks: json.driftBanks.map(pkFromString),
    juplendBanks: json.juplendBanks.map(pkFromString),
  };
}

main().catch((err) => {
  console.error(err);
});
