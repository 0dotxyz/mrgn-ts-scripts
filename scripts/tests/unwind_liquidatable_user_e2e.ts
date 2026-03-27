import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { composeRemainingAccounts } from "../../lib/utils";
import { readFileSync } from "fs";
import { repay } from "../user/repay";
import { withdrawKamino } from "../kamino/withdraw_kamino";
import { withdraw } from "../user/withdraw";
import { closeAccount } from "../user/close_account";
import { closeBank } from "../admin/close_bank";
import { Config, State } from "./create_liquidatable_user_e2e";
import { sleep } from "@mrgnlabs/mrgn-common";
import { updateLut } from "../../luts/update_lut";
import { withdrawDrift } from "../drift/withdraw";

async function main() {
  const raw_config = readFileSync("liquidation_e2e_config.json", "utf8");
  const config = parseConfig(raw_config);
  const raw_state = readFileSync("liquidation_e2e_state.json", "utf8");
  const state = parseState(raw_state);

  console.log("\n\n\n 1. UPDATE LUT");
  await updateLut(
    true,
    {
      LUT: config.LUT,
      KEYS: state.kaminoBanks,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);
  await updateLut(
    true,
    {
      LUT: config.LUT,
      KEYS: state.driftBanks.concat(state.debtBank),
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 2. REPAY DEBT BY LIQUIDATEE");
  const repayConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: state.debtBank,
    ACCOUNT: state.liquidatee,
    AMOUNT: new BN(0), // doesn't matter, since we repay all
    REPAY_ALL: true,
    MINT: config.DEBT_MINT,
    ADD_COMPUTE_UNITS: false,
  };
  await repay(true, repayConfig, config.LIQUIDATEE_WALLET_PATH);
  await sleep(1000);

  console.log("\n\n\n 3. WITHDRAW FROM KAMINO BANKS BY LIQUIDATEE");
  let remainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < 7; i++) {
    remainingAccounts.push([
      state.driftBanks[i],
      config.DRIFT_COLLATERAL_ORACLE,
      config.DRIFT_SPOT_MARKET,
    ]);
  }

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
    NEW_REMAINING: [],
    ADD_COMPUTE_UNITS: true,
  };

  for (let i = 0; i < 8; i++) {
    // Deep clone
    let fullRemainingAccounts = remainingAccounts.map((inner) =>
      inner.map((pk) => new PublicKey(pk.toBytes())),
    );
    // Add all active Kamino banks except the one to withdraw from
    for (let j = i + 1; j < 8; j++) {
      fullRemainingAccounts.push([
        state.kaminoBanks[j],
        config.KAMINO_COLLATERAL_ORACLE,
        config.KAMINO_RESERVE,
      ]);
    }

    kaminoWithdrawConfig.BANK = state.kaminoBanks[i];
    kaminoWithdrawConfig.NEW_REMAINING = composeRemainingAccounts(
      fullRemainingAccounts,
    );
    await withdrawKamino(
      true,
      kaminoWithdrawConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 4. WITHDRAW FROM DRIFT BANKS BY LIQUIDATEE");
  let driftWithdrawConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: state.driftBanks[0],
    ACCOUNT: state.liquidatee,
    AMOUNT: new BN(0), // doesn't matter, since we withdraw all
    WITHDRAW_ALL: true,

    DRIFT_MARKET_INDEX: config.DRIFT_MARKET_INDEX,
    DRIFT_ORACLE: config.DRIFT_ORACLE,

    LUT: config.LUT, // a liquidator-created LUT

    NEW_REMAINING: [],
    ADD_COMPUTE_UNITS: true,
  };

  for (let i = 0; i < 7; i++) {
    let fullRemainingAccounts = [];
    // Add all active Drift banks except the one to withdraw from
    for (let j = i + 1; j < 7; j++) {
      fullRemainingAccounts.push([
        state.driftBanks[j],
        config.DRIFT_COLLATERAL_ORACLE,
        config.DRIFT_SPOT_MARKET,
      ]);
    }

    driftWithdrawConfig.BANK = state.driftBanks[i];
    driftWithdrawConfig.NEW_REMAINING = composeRemainingAccounts(
      fullRemainingAccounts,
    );
    await withdrawDrift(
      true,
      driftWithdrawConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 5. WITHDRAW FROM DEBT BANK BY LIQUIDATOR");
  let withdrawConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    ACCOUNT: state.liquidator,
    BANK: state.debtBank,
    MINT: config.DEBT_MINT,
    AMOUNT: new BN(0), // doesn't matter, since we withdraw all
    WITHDRAW_ALL: true,
    LUT: config.LUT, // a liquidator-created LUT
    REMAINING: [],
    ADD_COMPUTE_UNITS: false,
  };
  await withdraw(true, withdrawConfig, config.LIQUIDATOR_WALLET_PATH);
  await sleep(1000);

  console.log("\n\n\n 6. CLOSE LIQUIDATOR AND LIQUIDATEE ACCOUNTS");
  await closeAccount(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: state.liquidator },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);
  await closeAccount(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: state.liquidatee },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 7. CLOSE ALL BANKS");
  for (let i = 0; i < 8; i++) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: state.kaminoBanks[i] },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }
  for (let i = 0; i < 7; i++) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: state.driftBanks[i] },
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

const pkFromString = (s: any) => new PublicKey(s);

function parseConfig(rawConfig: string): Config {
  const json = JSON.parse(rawConfig) as Config;

  return {
    PROGRAM_ID: json.PROGRAM_ID,
    LIQUIDATOR_WALLET_PATH: json.LIQUIDATOR_WALLET_PATH,
    LIQUIDATEE_WALLET_PATH: json.LIQUIDATEE_WALLET_PATH,
    KAMINO_COLLATERAL_MINT: pkFromString(json.KAMINO_COLLATERAL_MINT),
    KAMINO_COLLATERAL_ORACLE: pkFromString(json.KAMINO_COLLATERAL_ORACLE),
    DRIFT_COLLATERAL_MINT: pkFromString(json.DRIFT_COLLATERAL_MINT),
    DRIFT_COLLATERAL_ORACLE: pkFromString(json.DRIFT_COLLATERAL_ORACLE),
    DEBT_MINT: pkFromString(json.DEBT_MINT),
    DEBT_ORACLE: pkFromString(json.DEBT_ORACLE),
    KAMINO_RESERVE: pkFromString(json.KAMINO_RESERVE),
    KAMINO_MARKET: pkFromString(json.KAMINO_MARKET),
    KAMINO_RESERVE_ORACLE: pkFromString(json.KAMINO_RESERVE_ORACLE),
    KAMINO_FARM_STATE: pkFromString(json.KAMINO_FARM_STATE),
    DRIFT_SPOT_MARKET: pkFromString(json.DRIFT_SPOT_MARKET),
    DRIFT_MARKET_INDEX: json.DRIFT_MARKET_INDEX,
    DRIFT_ORACLE: pkFromString(json.DRIFT_ORACLE),
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
    kaminoBanks: json.kaminoBanks.map(pkFromString),
    kaminoObligations: json.kaminoObligations.map(pkFromString),
    driftBanks: json.driftBanks.map(pkFromString),
  };
}

main().catch((err) => {
  console.error(err);
});
