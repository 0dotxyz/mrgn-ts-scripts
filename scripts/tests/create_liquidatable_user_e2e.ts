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
import { bankConfigOptDefault, BankConfigPair, configBank } from "../admin/config_bank";
import { bigNumberToWrappedI80F48, sleep } from "@mrgnlabs/mrgn-common";
import { pulseHealth } from "../user/health_pulse";
import { writeFileSync } from "fs";
import { addDriftBank } from "../drift/add_bank";
import { depositDrift } from "../drift/deposit";
import { addJuplendBank } from "../juplend/add_bank";
import { depositJuplend } from "../juplend/deposit";
import { initJuplendPosition } from "../juplend/init_position";
import { updateLut } from "../../luts/update_lut";

export type Config = {
  PROGRAM_ID: string;
  LIQUIDATOR_WALLET_PATH: string;
  LIQUIDATEE_WALLET_PATH: string;
  KAMINO_COLLATERAL_MINT: PublicKey;
  KAMINO_COLLATERAL_ORACLE: PublicKey;
  DRIFT_COLLATERAL_MINT: PublicKey;
  DRIFT_COLLATERAL_ORACLE: PublicKey;
  JUPLEND_COLLATERAL_MINT: PublicKey;
  JUPLEND_COLLATERAL_ORACLE: PublicKey;
  DEBT_MINT: PublicKey;
  DEBT_ORACLE: PublicKey;
  KAMINO_RESERVE: PublicKey;
  KAMINO_MARKET: PublicKey;
  KAMINO_RESERVE_ORACLE: PublicKey;
  KAMINO_FARM_STATE: PublicKey;
  DRIFT_SPOT_MARKET: PublicKey;
  DRIFT_MARKET_INDEX: number;
  DRIFT_ORACLE: PublicKey; // The oracle Drift uses, which is different from DRIFT_COLLATERAL_ORACLE (which WE use).
  JUPLEND_LENDING: PublicKey;
  JUPLEND_F_TOKEN_MINT: PublicKey;
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
  juplendBanks: PublicKey[];
};

type SerializedState = {
  marginfiGroup: string;
  liquidator?: string;
  liquidatee?: string;
  debtBank?: string;
  kaminoBanks?: string[];
  kaminoObligations?: string[];
  driftBanks?: string[];
  juplendBanks?: string[];
};

// TODO: add fixed oracles
// Once we lift the constraints on the program side, we can use up to 16 in total.
const P0_BANKS = 1; // TODO: make fixed usdc
const KAMINO_BANKS = 4;
const DRIFT_BANKS = 0;
const JUPLEND_BANKS = 4;

// Note: current setup assumes you have ~1 USDC, ~1 USDS and ~1 USDT on your liquidatee's balances,
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
  JUPLEND_COLLATERAL_MINT: new PublicKey(
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  ), // usdt
  JUPLEND_COLLATERAL_ORACLE: new PublicKey(
    "FDf95uC3U4qFgTZbMDEBCziydC7k2Ex3Yqd7B1fhU5D1",
  ), // usdt SwitchboardPull
  DEBT_MINT: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"), // bonk
  DEBT_ORACLE: new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"), // bonk PythPull
  KAMINO_RESERVE: new PublicKey("9GJ9GBRwCp4pHmWrQ43L5xpc9Vykg7jnfwcFGN8FoHYu"), // usdc (NEW)
  KAMINO_MARKET: new PublicKey("CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA"), // main (NEW)
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
  JUPLEND_LENDING: new PublicKey(
    "F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE",
  ), // usdt
  JUPLEND_F_TOKEN_MINT: new PublicKey(
    "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A",
  ), // usdt
  LUT: new PublicKey("As8aiRyqcbmU5o2tTP3PnBM8tyRG4bBaqCKQyCw3rLV7"),
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
  console.log("group: " + marginfiGroup);
  await sleep(1000);
  // const marginfiGroup = new PublicKey(
  //   "B6bga2bbaVZ4mZaR6dKezvJRnvKb2WsrnNKwa6PMQLRE",
  // );
  let state: SerializedState = {
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
  console.log("liquidator: " + liquidator);
  await sleep(1000);
  // const liquidator = new PublicKey(
  //   "Fn7cXZD74bMSVf8tKyVNNBoQCxSLv39FhsBXzVmS2ZB7",
  // );
  state.liquidator = pkToString(liquidator);
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
  console.log("liquidatee: " + liquidatee);
  await sleep(1000);
  // const liquidatee = new PublicKey(
  //   "9nSThJznnwPEKxsfN6ZxMJHiDULaMbFWbfxfHrrB2tEa",
  // );
  state.liquidatee = pkToString(liquidatee);
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
    SEED: 42,
  };
  let kaminoBanks: PublicKey[] = [];
  for (let i = 0; i < KAMINO_BANKS; i++) {
    kaminoBankConfig.SEED = 42 + i;
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
  //   new PublicKey("AemvWQRnSoi2n8wHSvTfDQaM1jrTYVBmDjWsgjNexx1J"),
  //   new PublicKey("GQSkTStX5w976NvnVPYU3Gi5nh4oMruHvDm9kDzfRg3K"),
  // ];
  state.kaminoBanks = kaminoBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 4. INIT KAMINO OBLIGATIONS");
  let kaminoObligationConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ADMIN: liquidatorWallet.publicKey,
    BANK: kaminoBanks[0],
    ADD_COMPUTE_UNITS: true,
    KAMINO_MARKET: config.KAMINO_MARKET,
    RESERVE_ORACLE: config.KAMINO_RESERVE_ORACLE,
    FARM_STATE: config.KAMINO_FARM_STATE,
  };
  let kaminoObligations: PublicKey[] = [];
  for (let i = 0; i < kaminoBanks.length; i++) {
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
  //   new PublicKey("Fu61wCjXNGe5vQtHKcHcK8AZ4JVRZt2pFDbboX4TeZnC"),
  //   new PublicKey("HPmPJLDfX8bXRSatCxbofmZ5MJB4TeLijWVLkkGPWJ6N"),
  // ];
  state.kaminoObligations = kaminoObligations.map(pkToString);
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

  // The last bank gets 2x more. This is needed to test that the profit-oriented liquidator
  // will choose exactly it for as the liquidation "target".
  for (let i = 0; i < kaminoBanks.length; i++) {
    if (i == kaminoBanks.length - 1) {
      kaminoDepositConfig.AMOUNT = kaminoDepositConfig.AMOUNT.mul(new BN(2));
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
  let driftBanks: PublicKey[] = [];
  for (let i = 0; i < DRIFT_BANKS; i++) {
    driftBankConfig.SEED = new BN(i);
    driftBanks.push(
      await addDriftBank(true, driftBankConfig, config.LIQUIDATOR_WALLET_PATH),
    );
    await sleep(1000);
  }
  // let driftBanks = [
  //   new PublicKey("7n9nfzjP97rQaLd7SeWkHQzvoq1gTdgdYbRrxoqybY3J"),
  //   new PublicKey("8s5kpf86xERXw9D19i6fAQwe9kEfMJoPwAnPR6TYmY5u"),
  // ];
  state.driftBanks = driftBanks.map(pkToString);
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

  // The last bank gets 2x more. This is needed to test that the profit-oriented liquidator
  // will choose exactly it for as the liquidation "target".
  for (let i = 0; i < driftBanks.length; i++) {
    if (i == driftBanks.length - 1) {
      driftDepositConfig.AMOUNT = driftDepositConfig.AMOUNT.mul(new BN(2));
    }
    driftDepositConfig.BANK = driftBanks[i];
    await depositDrift(true, driftDepositConfig, config.LIQUIDATEE_WALLET_PATH);
    await sleep(1000);
  }

  console.log("\n\n\n 8. ADD JUPLEND (USDT) BANKS");
  let juplendBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    BANK_MINT: config.JUPLEND_COLLATERAL_MINT,
    JUPLEND_LENDING: config.JUPLEND_LENDING,
    F_TOKEN_MINT: config.JUPLEND_F_TOKEN_MINT,
    ORACLE: config.JUPLEND_COLLATERAL_ORACLE,
    ORACLE_SETUP: { juplendSwitchboardPull: {} },
    ADMIN: liquidatorWallet.publicKey,
    SEED: new BN(0),
    ASSET_WEIGHT_INIT: "1.0",
    ASSET_WEIGHT_MAINT: "1.0",
    DEPOSIT_LIMIT: "1000000000000",
    TOTAL_ASSET_VALUE_INIT_LIMIT: "1000000",
    RISK_TIER: "collateral" as "isolated" | "collateral",
    ORACLE_MAX_AGE: 300,
    CONFIG_FLAGS: 0,
  };
  let juplendBanks: PublicKey[] = [];
  for (let i = 0; i < JUPLEND_BANKS; i++) {
    juplendBankConfig.SEED = new BN(i);
    juplendBanks.push(
      await addJuplendBank(
        true,
        juplendBankConfig,
        config.LIQUIDATOR_WALLET_PATH,
      ),
    );
    await sleep(1000);
  }
  // let juplendBanks = [
  //   new PublicKey("B8c2GfxTz1zc7j1grr1gW3H62ScYMLnhSpvMXJYW5tVb"),
  //   new PublicKey("6RbGNXwHUQP18z4piYoTM6jFRob5gNDXB8Sdy7CfTSb4"),
  //   new PublicKey("FWqJFgwJQLM9ezskQxm5XcpRfsCCHFanix9CvMqVrA24"),
  //   new PublicKey("U7Qnu9biDCfiBnZfHhTePHtCuHSVF4juStMXctFMRBA"),
  // ];
  state.juplendBanks = juplendBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 9. INIT JUPLEND POSITIONS");
  let juplendPositionConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: juplendBanks[0],
    BANK_MINT: config.JUPLEND_COLLATERAL_MINT,
  };
  for (let i = 0; i < juplendBanks.length; i++) {
    juplendPositionConfig.BANK = juplendBanks[i];
    await initJuplendPosition(
      true,
      juplendPositionConfig,
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 10. DEPOSIT TO ALL JUPLEND BANKS BY LIQUIDATEE");
  let juplendDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: juplendBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: new BN(1 * 10 ** 5), // 0.1 USDT
  };

  // The last bank gets 2x more. This is needed to test that the profit-oriented liquidator
  // will choose exactly it for as the liquidation "target".
  for (let i = 0; i < juplendBanks.length; i++) {
    if (i == juplendBanks.length - 1) {
      juplendDepositConfig.AMOUNT = juplendDepositConfig.AMOUNT.mul(new BN(2));
    }
    juplendDepositConfig.BANK = juplendBanks[i];
    await depositJuplend(
      true,
      juplendDepositConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 11. ADD 1 (REGULAR) DEBT BANK");
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
  // const debtBank = new PublicKey("HWx9SUvp8px69zAe2hac4Ncq6L2PGYaM73u1kp7fKhh");
  state.debtBank = pkToString(debtBank);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 12. DEPOSIT TO DEBT BANK BY LIQUIDATOR");
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

  console.log("\n\n\n 13. BORROW FROM DEBT BANK BY LIQUIDATEE");
  let remainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < kaminoBanks.length; i++) {
    remainingAccounts.push([
      kaminoBanks[i],
      config.KAMINO_COLLATERAL_ORACLE,
      config.KAMINO_RESERVE,
    ]);
  }
  for (let i = 0; i < driftBanks.length; i++) {
    remainingAccounts.push([
      driftBanks[i],
      config.DRIFT_COLLATERAL_ORACLE,
      config.DRIFT_SPOT_MARKET,
    ]);
  }
  for (let i = 0; i < juplendBanks.length; i++) {
    remainingAccounts.push([
      juplendBanks[i],
      config.JUPLEND_COLLATERAL_ORACLE,
      config.JUPLEND_LENDING,
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
    KAMINO_RESERVES: KAMINO_BANKS > 0 ? [config.KAMINO_RESERVE] : [],
    DRIFT_MARKETS: DRIFT_BANKS > 0 ? [config.DRIFT_MARKET_INDEX] : [],
    JUPLEND_STATES: JUPLEND_BANKS > 0 ? [config.JUPLEND_LENDING] : [],
    NEW_REMAINING: composeRemainingAccounts(remainingAccounts),
    LUT: config.LUT,
  };

  for (
    let chunkStart = 0;
    chunkStart < borrowConfig.NEW_REMAINING.length;
    chunkStart += 10
  ) {
    const chunk = borrowConfig.NEW_REMAINING.slice(chunkStart, chunkStart + 10);
    await updateLut(
      true,
      {
        LUT: config.LUT,
        KEYS: chunk,
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  await borrow(true, borrowConfig, config.LIQUIDATEE_WALLET_PATH);
  await sleep(5000);

  console.log(
    "\n\n\n 14. SET ALL COLLATERAL BANKS' ASSET WEIGHT TO 0.1 TO RENDER LIQUIDATEE UNHEALTHY",
  );
  let updatedBankConfig = bankConfigOptDefault();
  // updatedBankConfig.oracleMaxAge = 300;
  updatedBankConfig.assetWeightInit = bigNumberToWrappedI80F48(0.1);
  updatedBankConfig.assetWeightMaint = bigNumberToWrappedI80F48(0.1);

  let configBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    ADMIN: liquidatorWallet.publicKey,
    LUT: config.LUT, // copied from config_bank.ts
    BANKS: [] as BankConfigPair[],
  };

  // config all banks in bulk
  let bankEntries = [
    // {
    //   bank: debtBank,
    //   config: updatedBankConfig,
    // },
  ];
  for (let i = 0; i < kaminoBanks.length; i++) {
    bankEntries.push({
      bank: kaminoBanks[i],
      config: updatedBankConfig,
    });
  }
  for (let i = 0; i < driftBanks.length; i++) {
    bankEntries.push({
      bank: driftBanks[i],
      config: updatedBankConfig,
    });
  }
  for (let i = 0; i < juplendBanks.length; i++) {
    bankEntries.push({
      bank: juplendBanks[i],
      config: updatedBankConfig,
    });
  }
  configBankConfig.BANKS = bankEntries;
  await configBank(true, configBankConfig, config.LIQUIDATOR_WALLET_PATH);
  await sleep(1000);

  console.log("\n\n\n 15. CONFIRM LIQUIDATEE IS LIQUIDATABLE NOW");
  const pulseHealthConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    ACCOUNT: liquidatee,
    LUT: config.LUT, // copied from health_pulse.ts
  };
  await pulseHealth(pulseHealthConfig, config.LIQUIDATEE_WALLET_PATH);

  console.log("Account " + liquidatee + " is now liquidatable");
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
    JUPLEND_COLLATERAL_MINT: pkToString(config.JUPLEND_COLLATERAL_MINT),
    JUPLEND_COLLATERAL_ORACLE: pkToString(config.JUPLEND_COLLATERAL_ORACLE),
    DEBT_MINT: pkToString(config.DEBT_MINT),
    DEBT_ORACLE: pkToString(config.DEBT_ORACLE),
    KAMINO_RESERVE: pkToString(config.KAMINO_RESERVE),
    KAMINO_MARKET: pkToString(config.KAMINO_MARKET),
    KAMINO_RESERVE_ORACLE: pkToString(config.KAMINO_RESERVE_ORACLE),
    KAMINO_FARM_STATE: pkToString(config.KAMINO_FARM_STATE),
    DRIFT_SPOT_MARKET: pkToString(config.DRIFT_SPOT_MARKET),
    DRIFT_MARKET_INDEX: config.DRIFT_MARKET_INDEX,
    DRIFT_ORACLE: pkToString(config.DRIFT_ORACLE),
    JUPLEND_LENDING: pkToString(config.JUPLEND_LENDING),
    JUPLEND_F_TOKEN_MINT: pkToString(config.JUPLEND_F_TOKEN_MINT),
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
