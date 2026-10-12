import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { readFileSync } from "fs";
import { sleep, wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { composeRemainingAccounts } from "../../lib/utils";
import { repay } from "../user/repay";
import { withdraw } from "../user/withdraw";
import { closeAccount } from "../user/close_account";
import { closeBank } from "../admin/close_bank";
import { dumpLiquidatee } from "./e2e_helpers";

/**
 * Reverses create_tagged_liquidatable_e2e.ts. A liquidation may already have moved part of the
 * position, so each leg is skipped when the on-chain balance is already empty.
 */
async function main() {
  const config = JSON.parse(
    readFileSync("liquidation_tagged_e2e_config.json", "utf8"),
  );
  const state = JSON.parse(
    readFileSync("liquidation_tagged_e2e_state.json", "utf8"),
  );
  for (const k of ["marginfiGroup", "liquidator", "liquidatee", "collateralBank", "debtBank"]) {
    if (!state[k]) {
      throw new Error(`state file is missing ${k}; did the create script finish?`);
    }
  }
  const pk = (s: string) => new PublicKey(s);
  const collateralBank = pk(state.collateralBank);
  const debtBank = pk(state.debtBank);
  const liquidatee = pk(state.liquidatee);
  const liquidator = pk(state.liquidator);
  const collateralMint = pk(config.COLLATERAL_MINT);
  const debtMint = pk(config.DEBT_MINT);

  const user = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATOR_WALLET_PATH);
  const exists = async (account: PublicKey) =>
    (await user.program.account.marginfiAccount.fetchNullable(account)) !== null;
  const held = async (account: PublicKey, bank: PublicKey) => {
    const acc: any = await user.program.account.marginfiAccount.fetchNullable(account);
    if (!acc) return { assets: false, liabs: false };
    const b = acc.lendingAccount.balances.find(
      (x: any) => x.active && x.bankPk.equals(bank),
    );
    return {
      assets: b ? wrappedI80F48toBigNumber(b.assetShares).gt(0) : false,
      liabs: b ? wrappedI80F48toBigNumber(b.liabilityShares).gt(0) : false,
    };
  };

  const collateral: PublicKey[] = [collateralBank];
  const debt: PublicKey[] = [debtBank];

  console.log("\n\n\n 1. REPAY PyUSD DEBT BY LIQUIDATEE");
  if ((await held(liquidatee, debtBank)).liabs) {
    await repay(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        ACCOUNT: liquidatee,
        BANK: debtBank,
        MINT: debtMint,
        AMOUNT: new BN(0),
        REPAY_ALL: true,
        ADD_COMPUTE_UNITS: false,
        NEW_REMAINING: composeRemainingAccounts([collateral, debt]),
      },
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(2000);
  } else {
    console.log("no debt left");
  }

  console.log("\n\n\n 2. WITHDRAW USDC BY LIQUIDATEE");
  if ((await held(liquidatee, collateralBank)).assets) {
    await withdraw(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        ACCOUNT: liquidatee,
        BANK: collateralBank,
        MINT: collateralMint,
        AMOUNT: new BN(0),
        WITHDRAW_ALL: true,
        ADD_COMPUTE_UNITS: false,
        REMAINING: composeRemainingAccounts([collateral]),
      },
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(2000);
  } else {
    console.log("no collateral left");
  }

  console.log("\n\n\n 3. WITHDRAW PyUSD BY LIQUIDATOR");
  if ((await held(liquidator, debtBank)).assets) {
    await withdraw(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        ACCOUNT: liquidator,
        BANK: debtBank,
        MINT: debtMint,
        AMOUNT: new BN(0),
        WITHDRAW_ALL: true,
        ADD_COMPUTE_UNITS: false,
        REMAINING: composeRemainingAccounts([debt]),
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(2000);
  } else {
    console.log("no PyUSD deposit left");
  }

  console.log("\n\n\n 4. CLOSE ACCOUNTS");
  // A create run that failed at account init leaves the state file pointing at an account that
  // was never created.
  for (const [account, walletPath] of [
    [liquidatee, config.LIQUIDATEE_WALLET_PATH],
    [liquidator, config.LIQUIDATOR_WALLET_PATH],
  ] as [PublicKey, string][]) {
    if (!(await exists(account))) {
      console.log(`${account.toBase58()} does not exist, skipping`);
      continue;
    }
    await closeAccount(true, { PROGRAM_ID: config.PROGRAM_ID, ACCOUNT: account }, walletPath);
    await sleep(1000);
  }
  // Once liquidated, the account outlives this run: its record must sit idle for 60 days first.
  if (await exists(liquidatee)) {
    await dumpLiquidatee(config.PROGRAM_ID, config.LIQUIDATEE_WALLET_PATH, liquidatee);
  }

  console.log("\n\n\n 5. CLOSE BANKS");
  await closeBank(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, BANKS: [collateralBank, debtBank], FORCE: true },
    config.LIQUIDATOR_WALLET_PATH,
  );

  console.log("\nDone. Group " + state.marginfiGroup + " is now empty.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
