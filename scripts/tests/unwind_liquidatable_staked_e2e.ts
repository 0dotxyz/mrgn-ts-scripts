import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { sleep } from "@mrgnlabs/mrgn-common";
import { repay } from "../user/repay";
import { withdraw } from "../user/withdraw";
import { closeAccount } from "../user/close_account";
import { closeBank } from "../admin/close_bank";
import { composeRemainingAccounts } from "../../lib/utils";
import { updateLut } from "../../luts/update_lut";
import { deriveSinglePoolKeys } from "../common/pdas";
import { Config, State } from "./create_liquidatable_staked_e2e";

/**
 * Reverses create_liquidatable_staked_e2e.ts: repay the SOL debt, withdraw every staked and SOL
 * position, then close the accounts and banks so the next run starts clean.
 */
async function main() {
  const config = parseConfig(
    readFileSync("liquidation_staked_e2e_state.json", "utf8"),
  );
  const state = parseState(
    readFileSync("liquidation_staked_e2e_state.json", "utf8"),
  );

  const pools = config.VALIDATOR_VOTE_ACCOUNTS.map((v) =>
    deriveSinglePoolKeys(v),
  );

  // A staked balance needs five accounts: bank, oracle, lst mint, sol pool, on-ramp.
  const stakedRemaining: PublicKey[][] = state.stakedBanks.map((bank, i) => [
    bank,
    config.SOL_ORACLE,
    pools[i].lstMint,
    pools[i].solPool,
    pools[i].onramp,
  ]);
  const solCollateralRemaining: PublicKey[][] = [
    [state.solCollateralBank, config.SOL_ORACLE],
  ];
  const debtRemaining: PublicKey[][] = [[state.debtBank, config.SOL_ORACLE]];

  const allRemaining = [
    ...stakedRemaining,
    ...solCollateralRemaining,
    ...debtRemaining,
  ];

  console.log("\n\n\n 1. UPDATE LUT");
  const keys = composeRemainingAccounts(allRemaining);
  for (let start = 0; start < keys.length; start += 10) {
    await updateLut(
      true,
      { LUT: config.LUT, KEYS: keys.slice(start, start + 10) },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 2. REPAY SOL DEBT BY LIQUIDATEE");
  await repay(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      ACCOUNT: state.liquidatee,
      BANK: state.debtBank,
      MINT: config.SOL_MINT,
      AMOUNT: new BN(0),
      REPAY_ALL: true,
      ADD_COMPUTE_UNITS: true,
      NEW_REMAINING: composeRemainingAccounts(allRemaining),
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(2000);

  console.log("\n\n\n 3. WITHDRAW FROM STAKED BANKS BY LIQUIDATEE");
  // The debt is gone, so the remaining list shrinks as each balance closes. Rebuild it every
  // iteration from the banks still held, or the health check reads the wrong account.
  for (let i = 0; i < state.stakedBanks.length; i++) {
    const stillHeld = [
      ...stakedRemaining.slice(i),
      ...solCollateralRemaining,
    ];
    await withdraw(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        ACCOUNT: state.liquidatee,
        BANK: state.stakedBanks[i],
        MINT: pools[i].lstMint,
        AMOUNT: new BN(0),
        WITHDRAW_ALL: true,
        ADD_COMPUTE_UNITS: true,
        REMAINING: composeRemainingAccounts(stillHeld),
      },
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(2000);
  }

  console.log("\n\n\n 4. WITHDRAW FROM SOL COLLATERAL BANK BY LIQUIDATEE");
  await withdraw(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      ACCOUNT: state.liquidatee,
      BANK: state.solCollateralBank,
      MINT: config.SOL_MINT,
      AMOUNT: new BN(0),
      WITHDRAW_ALL: true,
      ADD_COMPUTE_UNITS: true,
      REMAINING: composeRemainingAccounts(solCollateralRemaining),
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(2000);

  console.log("\n\n\n 5. WITHDRAW FROM DEBT BANK BY LIQUIDATOR");
  await withdraw(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      ACCOUNT: state.liquidator,
      BANK: state.debtBank,
      MINT: config.SOL_MINT,
      AMOUNT: new BN(0),
      WITHDRAW_ALL: true,
      ADD_COMPUTE_UNITS: true,
      REMAINING: composeRemainingAccounts(debtRemaining),
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(2000);

  console.log("\n\n\n 6. CLOSE LIQUIDATOR AND LIQUIDATEE ACCOUNTS");
  await closeAccount(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: state.liquidatee },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(1000);
  await closeAccount(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: state.liquidator },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 7. CLOSE ALL BANKS");
  for (const bank of [
    ...state.stakedBanks,
    state.solCollateralBank,
    state.debtBank,
  ]) {
    await closeBank(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: bank },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  // Note: the group's staked_settings account has no close instruction, so the group is left
  // behind. Each run makes a fresh one.
  console.log("\nDone. Group " + state.marginfiGroup + " is now empty.");
}

const pk = (s: any) => new PublicKey(s);

function parseConfig(raw: string): Config {
  const j = JSON.parse(raw);
  return {
    PROGRAM_ID: j.PROGRAM_ID,
    LIQUIDATOR_WALLET_PATH: j.LIQUIDATOR_WALLET_PATH,
    LIQUIDATEE_WALLET_PATH: j.LIQUIDATEE_WALLET_PATH,
    SOL_ORACLE: pk(j.SOL_ORACLE),
    VALIDATOR_VOTE_ACCOUNTS: (j.VALIDATOR_VOTE_ACCOUNTS ?? []).map(pk),
    SOL_MINT: pk(j.SOL_MINT),
    LUT: pk(j.LUT),
  };
}

function parseState(raw: string): State {
  const j = JSON.parse(raw);
  for (const k of [
    "marginfiGroup",
    "liquidator",
    "liquidatee",
    "stakedBanks",
    "solCollateralBank",
    "debtBank",
  ]) {
    if (!j[k]) {
      throw new Error(`state file is missing ${k}; did the create script finish?`);
    }
  }
  return {
    marginfiGroup: pk(j.marginfiGroup),
    liquidator: pk(j.liquidator),
    liquidatee: pk(j.liquidatee),
    stakedSettings: pk(j.stakedSettings),
    stakedBanks: j.stakedBanks.map(pk),
    solCollateralBank: pk(j.solCollateralBank),
    debtBank: pk(j.debtBank),
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
