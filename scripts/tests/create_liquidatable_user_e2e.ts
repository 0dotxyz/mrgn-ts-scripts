import { PublicKey } from "@solana/web3.js";
import { loadKeypairFromFile } from "../utils/utils";
import { initGroup } from "../admin/init_group";
import { initAccount } from "../user/init_account";
import { addKaminoBank } from "../kamino/add_bank";
import { initKaminoObligation } from "../kamino/init_bank_obligation";
import { BN } from "@coral-xyz/anchor";
import { depositKamino } from "../kamino/deposit_kamino";
import { addBank, ORACLE_TYPE_PYTH } from "../admin/add_bank";
import { depositRegular } from "../user/deposit_regular";
import { borrow } from "../user/borrow";
import { composeRemainingAccounts } from "../../lib/utils";
import { bankConfigOptDefault, configBank } from "../admin/config_bank";
import { bigNumberToWrappedI80F48, sleep } from "@mrgnlabs/mrgn-common";
import { pulseHealth } from "../user/health_pulse";
import { writeFileSync } from "fs";
import { addDriftBank } from "../drift/add_bank";
import { depositDrift } from "../drift/deposit";

export type Config = {
  PROGRAM_ID: string;
  LIQUIDATOR_WALLET_PATH: string;
  LIQUIDATEE_WALLET_PATH: string;
  KAMINO_COLLATERAL_MINT: PublicKey;
  KAMINO_COLLATERAL_ORACLE: PublicKey;
  DRIFT_COLLATERAL_MINT: PublicKey;
  DRIFT_COLLATERAL_ORACLE: PublicKey;
  DEBT_MINT: PublicKey;
  DEBT_ORACLE: PublicKey;
  KAMINO_RESERVE: PublicKey;
  KAMINO_MARKET: PublicKey;
  KAMINO_RESERVE_ORACLE: PublicKey;
  KAMINO_FARM_STATE: PublicKey;
  DRIFT_SPOT_MARKET: PublicKey;
  DRIFT_MARKET_INDEX: number;
  DRIFT_ORACLE: PublicKey; // The oracle Drift uses, which is different from DRIFT_COLLATERAL_ORACLE (which WE use).
  LUT: PublicKey;
};

export type State = {
  marginfiGroup: PublicKey;
  liquidator: PublicKey;
  liquidatee: PublicKey;
  debtBank: PublicKey;
  kaminoBanks: PublicKey[];
  kaminoObligations: PublicKey[];
  driftBanks: PublicKey[];
};

// Note: current setup assumes you have ~1 USDC and ~1 USDS on your liquidatee's balances,
// and at least 50'000 BONK on your liquidator's balances. Plus significant amount of SOL
// for transactions and for rent (>1 SOL in liquidator's case).

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  LIQUIDATOR_WALLET_PATH: "/.config/stage/id.json",
  LIQUIDATEE_WALLET_PATH: "/.config/arena/id.json",
  KAMINO_COLLATERAL_MINT: new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  ), // usdc
  KAMINO_COLLATERAL_ORACLE: new PublicKey(
    "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX",
  ), // usdc PythPull
  DRIFT_COLLATERAL_MINT: new PublicKey(
    "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
  ), // usds
  DRIFT_COLLATERAL_ORACLE: new PublicKey(
    "DyYBBWEi9xZvgNAeMDCiFnmC1U9gqgVsJDXkL5WETpoX",
  ), // usds PythPull
  DEBT_MINT: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), // bonk
  DEBT_ORACLE: new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"), // bonk PythPull
  KAMINO_RESERVE: new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"), // usdc
  KAMINO_MARKET: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"), // main
  KAMINO_RESERVE_ORACLE: new PublicKey(
    "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
  ),
  KAMINO_FARM_STATE: new PublicKey(
    "JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh",
  ),
  DRIFT_SPOT_MARKET: new PublicKey(
    "hX9tXtcFomQ38TvtbpzdsNGwoGRBqkNg4J4hNDcET2t",
  ),
  DRIFT_MARKET_INDEX: 28, // usds
  DRIFT_ORACLE: new PublicKey("5Km85n3s9Zs5wEoXYWuHbpoDzst4EBkS5f1XuQJGG1DL"), // usds
  LUT: new PublicKey("FtQ5uKQvFoKQ27SWY15tgBeJQnGKmKGzWqDz7kGUbeiq"),
};

async function main() {
  const liquidatorWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATOR_WALLET_PATH,
  );
  const liquidateeWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATEE_WALLET_PATH,
  );
  writeJsonFile("liquidation_e2e_config.json", serializeConfig(config));

  console.log("\n\n\n 1. INIT GROUP");
  const marginfiGroup = await initGroup(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ADMIN_KEY: liquidatorWallet.publicKey },
    config.LIQUIDATOR_WALLET_PATH,
  );
  // const marginfiGroup = new PublicKey(
  //   "AWJ21dKoR4srQKBmmVXfZbaBfa7zqi7v7M3fzhyAQ4pH",
  // );
  await sleep(1000);
  let state = {
    marginfiGroup: pkToString(marginfiGroup),
  };
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 2. INIT MARGINFI ACCOUNTS");
  const liquidator = await initAccount(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      AUTHORITY: liquidatorWallet.publicKey,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  // const liquidator = new PublicKey(
  //   "442gdrt1xvBMb5bVhoSbEVFiNAJrdyBkETRxfjMGeRav",
  // );
  console.log("liquidator: " + liquidator);
  await sleep(1000);
  state["liquidator"] = pkToString(liquidator);
  writeJsonFile("liquidation_e2e_state.json", state);

  const liquidatee = await initAccount(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      AUTHORITY: liquidateeWallet.publicKey,
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  // const liquidatee = new PublicKey(
  //   "DeCbfDxCGc6gJetJNozNTL51u6JHGRp6HSKgxP8fhEd5",
  // );
  console.log("liquidatee: " + liquidatee);
  await sleep(1000);
  state["liquidatee"] = pkToString(liquidatee);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 3. ADD KAMINO (USDC) BANKS");
  let kaminoBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ORACLE: config.KAMINO_COLLATERAL_ORACLE,
    ORACLE_TYPE: { kaminoPythPush: {} },
    ADMIN: liquidatorWallet.publicKey,
    BANK_MINT: config.KAMINO_COLLATERAL_MINT,
    KAMINO_RESERVE: config.KAMINO_RESERVE,
    KAMINO_MARKET: config.KAMINO_MARKET,
    SEED: 0,
  };
  let kaminoBanks = [];
  for (let i = 0; i < 8; i++) {
    kaminoBankConfig.SEED = i;
    kaminoBanks.push(
      await addKaminoBank(
        true,
        kaminoBankConfig,
        config.LIQUIDATOR_WALLET_PATH,
      ),
    );
    await sleep(1000);
  }
  // let kaminoBanks = [
  //   new PublicKey("AzAxeU7KzUGKr82TFJdpvpLBKRTpTtuWWfBLuxm7FtFo"),
  //   new PublicKey("6bpK1b8s8uvCVanWNk7A6Vat96XwmogY7AXdu6jszyga"),
  //   new PublicKey("GdLaHAtwPEgZCeV4PpmTKNy3zVpHKw2ypsfTjhrC3n6q"),
  //   new PublicKey("54SAMAUXrSh3caguJP6nCDDJuYUG4ULqnJno2SMwQAEq"),
  //   new PublicKey("AWLAK7doiEasUZ1STQhMCRTcU3ycobMH3Jg5cmAVTqKr"),
  //   new PublicKey("4pAwYDeqDgrj3qDfEbqDcBcWFqkkA8qC12tHuHwNpEc5"),
  //   new PublicKey("7UYEmWNno9MHGwwM8oiWTYnYRxpaoWdaToEJej1WhnkN"),
  //   new PublicKey("ExLuU8gDjr7Vqq3gvavFAdHqSABMDDWZp69iUnJ9uN2W"),
  // ];
  state["kaminoBanks"] = kaminoBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 4. INIT KAMINO OBLIGATIONS");
  let kaminoObligationConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ADMIN: liquidatorWallet.publicKey,
    BANK: kaminoBanks[0],
    KAMINO_MARKET: config.KAMINO_MARKET,
    RESERVE_ORACLE: config.KAMINO_RESERVE_ORACLE,
    FARM_STATE: config.KAMINO_FARM_STATE,
  };
  let kaminoObligations = [];
  for (let i = 0; i < 8; i++) {
    kaminoObligationConfig.BANK = kaminoBanks[i];
    kaminoObligations.push(
      await initKaminoObligation(
        true,
        kaminoObligationConfig,
        config.LIQUIDATOR_WALLET_PATH,
      ),
    );
    await sleep(1000);
  }
  // let kaminoObligations = [
  //   new PublicKey("78137qAL8GrFJYC8DURpQ2gmaVWqiJ4tDygqJ9NjwWQF"),
  //   new PublicKey("B6XfY8ZCPYuJcHaZrSRgKEEUVi4gsZBio7mwdW4D6niZ"),
  //   new PublicKey("D7gLYosUviPq9FH4WnzENasSEAe2yQbi16f16qCFiBVU"),
  //   new PublicKey("4HoY6Ye9ebBEJN67xz7cgM1vqadak9ExFuETHVdXUqve"),
  //   new PublicKey("6mSA1JaUUftyiAx5PVE5k4GPVLocC6Dfk42A278oDpr6"),
  //   new PublicKey("8Ro1rfEnjseLkfuX43ZqtXdwz8AFBwKmXcmonjr2ujJf"),
  //   new PublicKey("5azW5bT7WEJigAR9vPEGhh8jghox88QXpJKK4zEp5UW3"),
  //   new PublicKey("Di9aa7UZLtd2p1Vc2AwzkRrWCLFFn4GgEyAiFD5uPZDv"),
  // ];
  state["kaminoObligations"] = kaminoObligations.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 5. DEPOSIT TO ALL KAMINO BANKS BY LIQUIDATEE");
  let kaminoDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: kaminoBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: new BN(1 * 10 ** 5), // 0.1 USDC
    BANK_MINT: config.KAMINO_COLLATERAL_MINT,
    KAMINO_RESERVE: config.KAMINO_RESERVE,
    KAMINO_MARKET: config.KAMINO_MARKET,
    RESERVE_ORACLE: config.KAMINO_RESERVE_ORACLE,
    FARM_STATE: config.KAMINO_FARM_STATE,
  };

  // The last bank gets slightly more. This is needed to test that the profit-oriented liquidator
  // will choose exactly it for as the liquidation "target".
  for (let i = 0; i < 8; i++) {
    if (i == 7) {
      kaminoDepositConfig.AMOUNT = new BN(2 * 10 ** 5); // 0.2 USDC
    }
    kaminoDepositConfig.BANK = kaminoBanks[i];
    await depositKamino(
      true,
      kaminoDepositConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 6. ADD DRIFT (USDS) BANKS");
  let driftBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    BANK_MINT: config.DRIFT_COLLATERAL_MINT,
    DRIFT_MARKET_INDEX: config.DRIFT_MARKET_INDEX,
    ORACLE: config.DRIFT_COLLATERAL_ORACLE,
    ORACLE_SETUP: { driftPythPull: {} },
    DRIFT_ORACLE: config.DRIFT_ORACLE,
    ADMIN: liquidatorWallet.publicKey,
    SEED: new BN(0),
  };
  let driftBanks = [];
  for (let i = 0; i < 7; i++) {
    driftBankConfig.SEED = new BN(i);
    driftBanks.push(
      await addDriftBank(true, driftBankConfig, config.LIQUIDATOR_WALLET_PATH),
    );
    await sleep(1000);
  }
  // let driftBanks = [
  //   new PublicKey("B1d2FRxJP2VEGpucPAbZyPjWMb7uWUPMqMzZdut1pxSs"),
  //   new PublicKey("2ea7us3NXJY9MoQY4JYe16GDBUJFATAe3QhVNhSrBqav"),
  //   new PublicKey("6xMUaXJfXmV459u8mZ1s7ByLTFX4bUnV48AktXayMCkk"),
  //   new PublicKey("FJH34mtkipNM5LMyVKFCJRfyTCY4dEChVDMDDXdhmnRj"),
  //   new PublicKey("FvhBNVz4vY2SQRkHMBPGWFwC8twuCmiW8iwbQNE5akiP"),
  //   new PublicKey("xy1Dyj14rvsaasuZT6bBrW2NpmC548C1NNuExKY8amb"),
  //   new PublicKey("3QEtWuH7Erzhnej8HhWF3rf8xmH3kLUbtbX2aiTQZvMg"),
  // ];
  state["driftBanks"] = driftBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 7. DEPOSIT TO ALL DRIFT BANKS BY LIQUIDATEE");
  let driftDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: kaminoBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: new BN(1 * 10 ** 5), // 0.1 USDS
    DRIFT_MARKET_INDEX: config.DRIFT_MARKET_INDEX,
    DRIFT_ORACLE: config.DRIFT_ORACLE,
  };

  // The last bank gets slightly more. This is needed to test that the profit-oriented liquidator
  // will choose exactly it for as the liquidation "target".
  for (let i = 0; i < 7; i++) {
    if (i == 6) {
      driftDepositConfig.AMOUNT = new BN(2 * 10 ** 5); // 0.2 USDS
    }
    driftDepositConfig.BANK = driftBanks[i];
    await depositDrift(true, driftDepositConfig, config.LIQUIDATEE_WALLET_PATH);
    await sleep(1000);
  }

  console.log("\n\n\n 8. ADD 1 (REGULAR) DEBT BANK");
  let bankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ORACLE: config.DEBT_ORACLE,
    ORACLE_TYPE: ORACLE_TYPE_PYTH,
    ADMIN: liquidatorWallet.publicKey,
    BANK_MINT: config.DEBT_MINT,
    SEED: 0,
  };
  const debtBank = await addBank(
    true,
    bankConfig,
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);
  // const debtBank = new PublicKey(
  //   "EQHmVmqqHhWjnbqxgLxhHsKEjfRoA5beioUx71p92k8U",
  // );
  state["debtBank"] = pkToString(debtBank);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 9. DEPOSIT TO DEBT BANK BY LIQUIDATOR");
  let regularDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: debtBank,
    ACCOUNT: liquidator,
    AMOUNT: new BN(50000 * 10 ** 5), // 50'000 BONK (** 5 decimals)
    MINT: config.DEBT_MINT,
  };
  await depositRegular(
    true,
    regularDepositConfig,
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 10. BORROW FROM DEBT BANK BY LIQUIDATEE");
  let remainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < 8; i++) {
    remainingAccounts.push([
      kaminoBanks[i],
      config.KAMINO_COLLATERAL_ORACLE,
      config.KAMINO_RESERVE,
    ]);
  }
  for (let i = 0; i < 7; i++) {
    remainingAccounts.push([
      driftBanks[i],
      config.DRIFT_COLLATERAL_ORACLE,
      config.DRIFT_SPOT_MARKET,
    ]);
  }
  remainingAccounts.push([debtBank, config.DEBT_ORACLE]);

  let borrowConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: debtBank,
    ACCOUNT: liquidatee,
    AMOUNT: new BN(40000 * 10 ** 5), // 40k BONK
    MINT: config.DEBT_MINT,
    ADD_COMPUTE_UNITS: true,
    KAMINO_RESERVE: config.KAMINO_RESERVE,
    KAMINO_MARKET: config.KAMINO_MARKET,
    RESERVE_ORACLE: config.KAMINO_RESERVE_ORACLE,
    FARM_STATE: config.KAMINO_FARM_STATE,
    NEW_REMAINING: composeRemainingAccounts(remainingAccounts),
  };

  await borrow(true, borrowConfig, config.LIQUIDATEE_WALLET_PATH);
  await sleep(1000);

  console.log(
    "\n\n\n 11. SET ALL COLLATERAL BANKS' ASSET WEIGHT TO 0.1 TO RENDER LIQUIDATEE UNHEALTHY",
  );
  let updatedBankConfig = bankConfigOptDefault();
  // updatedBankConfig.oracleMaxAge = 300;
  updatedBankConfig.assetWeightInit = bigNumberToWrappedI80F48(0.1);
  updatedBankConfig.assetWeightMaint = bigNumberToWrappedI80F48(0.1);

  let configBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    ADMIN: liquidatorWallet.publicKey,
    LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"), // copied from config_bank.ts
    BANKS: [],
  };

  // config all banks in bulk
  let bankEntries = [
    // {
    //   bank: debtBank,
    //   config: updatedBankConfig,
    // },
  ];
  for (let i = 0; i < 8; i++) {
    bankEntries.push({
      bank: kaminoBanks[i],
      config: updatedBankConfig,
    });
  }
  for (let i = 0; i < 7; i++) {
    bankEntries.push({
      bank: driftBanks[i],
      config: updatedBankConfig,
    });
  }
  configBankConfig.BANKS = bankEntries;
  await configBank(true, configBankConfig, config.LIQUIDATOR_WALLET_PATH);
  await sleep(1000);

  console.log("\n\n\n 12. CONFIRM LIQUIDATEE IS LIQUIDATABLE NOW");
  const pulseHealthConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    ACCOUNT: liquidatee,
    LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"), // copied from health_pulse.ts
  };
  await pulseHealth(pulseHealthConfig, config.LIQUIDATEE_WALLET_PATH);

  console.log("Account " + liquidatee + " is now liquidatable.");
}

function pkToString(pk: PublicKey | string): string {
  return typeof pk === "string" ? pk : pk.toBase58();
}

function serializeConfig(config: Config): any {
  return {
    PROGRAM_ID: config.PROGRAM_ID,
    LIQUIDATOR_WALLET_PATH: config.LIQUIDATOR_WALLET_PATH,
    LIQUIDATEE_WALLET_PATH: config.LIQUIDATEE_WALLET_PATH,
    KAMINO_COLLATERAL_MINT: pkToString(config.KAMINO_COLLATERAL_MINT),
    KAMINO_COLLATERAL_ORACLE: pkToString(config.KAMINO_COLLATERAL_ORACLE),
    DRIFT_COLLATERAL_MINT: pkToString(config.DRIFT_COLLATERAL_MINT),
    DRIFT_COLLATERAL_ORACLE: pkToString(config.DRIFT_COLLATERAL_ORACLE),
    DEBT_MINT: pkToString(config.DEBT_MINT),
    DEBT_ORACLE: pkToString(config.DEBT_ORACLE),
    KAMINO_RESERVE: pkToString(config.KAMINO_RESERVE),
    KAMINO_MARKET: pkToString(config.KAMINO_MARKET),
    KAMINO_RESERVE_ORACLE: pkToString(config.KAMINO_RESERVE_ORACLE),
    KAMINO_FARM_STATE: pkToString(config.KAMINO_FARM_STATE),
    DRIFT_SPOT_MARKET: pkToString(config.DRIFT_SPOT_MARKET),
    DRIFT_MARKET_INDEX: config.DRIFT_MARKET_INDEX,
    DRIFT_ORACLE: pkToString(config.DRIFT_ORACLE),
    LUT: pkToString(config.LUT),
  };
}

function writeJsonFile(path: string, obj: any) {
  const json = JSON.stringify(obj, null, 2);
  writeFileSync(path, json);
  console.log(`✔ wrote ${path}`);
}

main().catch((err) => {
  console.error(err);
});
