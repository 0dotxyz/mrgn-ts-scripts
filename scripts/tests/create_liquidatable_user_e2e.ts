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
import { commonSetup } from "../../lib/common-setup";
import {
  bankConfigOptDefault,
  BankConfigPair,
  configBank,
} from "../admin/config_bank";
import {
  bigNumberToWrappedI80F48,
  getAssociatedTokenAddressSync,
  sleep,
} from "@mrgnlabs/mrgn-common";
import { pulseHealth } from "../user/health_pulse";
import { writeFileSync } from "fs";
import { addDriftBank } from "../drift/add_bank";
import { depositDrift } from "../drift/deposit";
import { addJuplendBank } from "../juplend/add_bank";
import { depositJuplend } from "../juplend/deposit";
import { initJuplendPosition } from "../juplend/init_position";
import { updateLut } from "../../luts/update_lut";
import {
  BankOracleConfig,
  setFixedOraclePrice,
} from "../admin/config_bank_fixed_price";
import {
  ORACLE_SETUP_PT_PYTH,
  setPtOracle,
} from "../admin/config_bank_oracle_pt";
import {
  configureLstOracle,
  ORACLE_SETUP_KAMINO_MSOL,
} from "../admin/config_bank_oracle_lst";

export type Config = {
  PROGRAM_ID: string;
  LIQUIDATOR_WALLET_PATH: string;
  LIQUIDATEE_WALLET_PATH: string;
  P0_COLLATERAL_MINT: PublicKey;
  PT_COLLATERAL_MINT: PublicKey;
  PT_EXPONENT_VAULT: PublicKey;
  PT_BASE_ORACLE: PublicKey;
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
  MSOL_MINT: PublicKey;
  MSOL_BASE_ORACLE: PublicKey;
  MARINADE_STATE: PublicKey;
  MSOL_KAMINO_RESERVE: PublicKey;
  MSOL_KAMINO_MARKET: PublicKey;
  MSOL_KAMINO_RESERVE_ORACLE: PublicKey;
  MSOL_KAMINO_FARM_STATE: PublicKey;
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
  p0Banks: PublicKey[];
  ptBanks: PublicKey[];
  kaminoBanks: PublicKey[];
  kaminoObligations: PublicKey[];
  kaminoMsolBanks: PublicKey[];
  kaminoMsolObligations: PublicKey[];
  driftBanks: PublicKey[];
  juplendBanks: PublicKey[];
};

type SerializedState = {
  marginfiGroup: string;
  liquidator?: string;
  liquidatee?: string;
  debtBank?: string;
  p0Banks?: string[];
  ptBanks?: string[];
  kaminoBanks?: string[];
  kaminoObligations?: string[];
  kaminoMsolBanks?: string[];
  kaminoMsolObligations?: string[];
  driftBanks?: string[];
  juplendBanks?: string[];
};

// Once we lift the constraints on the program side, we can use up to 16 in total.
const P0_BANKS = 2; // + 1 for debt
const PT_BANKS = 2; // PTPyth
const KAMINO_BANKS = 2;
const KAMINO_MSOL_BANKS = 2; // KaminoMSOL
const DRIFT_BANKS = 0;
const JUPLEND_BANKS = 4;
// JuplendLST would go here, but JupLend lists no SPL stake-pool LST, and JuplendLST requires the
// bank mint to equal the stake pool's `pool_mint`. Nothing to point it at yet.
const JUPLEND_LST_BANKS = 0;

const P0_DEPOSIT = new BN(1 * 10 ** 5); // 0.1 USDC
const PT_DEPOSIT = new BN(1 * 10 ** 6); // 0.001 PT, ~$0.10
const KAMINO_DEPOSIT = new BN(1 * 10 ** 5); // 0.1 USDC
const KAMINO_MSOL_DEPOSIT = new BN(1 * 10 ** 6); // 0.001 mSOL
const DRIFT_DEPOSIT = new BN(1 * 10 ** 5); // 0.1 USDS
const JUPLEND_DEPOSIT = new BN(1 * 10 ** 5); // 0.1 USDT
const DEBT_DEPOSIT = new BN(6 * 10 ** 5); // 0.6 PyUSD, by the liquidator

// Note: current setup assumes you have ~1 USDC, ~1 USDS, ~1 USDT, plus a little PT-fragSOL and
// mSOL on your liquidatee's balances,
// and at least 0.9 PyUSD on your liquidator's balances. Plus significant amount of SOL
// for transactions and for rent (>1 SOL in liquidator's case).

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  LIQUIDATOR_WALLET_PATH: "/.config/stage/id.json",
  LIQUIDATEE_WALLET_PATH: "/.config/liquidatee/id.json",
  P0_COLLATERAL_MINT: new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  ), // usdc, Fixed to 1
  PT_COLLATERAL_MINT: new PublicKey(
    "HgyWqTZ6JdGYF5TfrYmScTyvsyuopwYRJXwqA2LzCrz6",
  ), // PT-bulkSOL-31OCT26
  PT_EXPONENT_VAULT: new PublicKey(
    "BwBn7Sro6RzDp3A59cDC7WoxWdT7yTaWuaHwvR7Gvypa",
  ),
  PT_BASE_ORACLE: new PublicKey(
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  ), // SOL/USD PythPush (bulkSOL is SOL-denominated)
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
    "3XBYLaF9wisQLaCxTgchH6xeNJGchwDauGpot1GcRMZV",
  ), // usdt PythPull
  DEBT_MINT: new PublicKey("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"), // pyusd (t22)
  DEBT_ORACLE: new PublicKey("F1huL4wkpzHLezvKMXQMgrL6SN7CkG9fYWm4VWSmVbjw"), // pyusd PythPull
  KAMINO_RESERVE: new PublicKey("9GJ9GBRwCp4pHmWrQ43L5xpc9Vykg7jnfwcFGN8FoHYu"), // usdc (NEW)
  KAMINO_MARKET: new PublicKey("CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA"), // main (NEW)
  KAMINO_RESERVE_ORACLE: new PublicKey(
    "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
  ),
  KAMINO_FARM_STATE: new PublicKey(
    "JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh",
  ),
  MSOL_MINT: new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
  MSOL_BASE_ORACLE: new PublicKey(
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  ), // SOL/USD PythPush
  MARINADE_STATE: new PublicKey(
    "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC",
  ),
  MSOL_KAMINO_RESERVE: new PublicKey(
    "FBSyPnxtHKLBZ4UeeUyAnbtFuAmTHLtso9YtsqRDRWpM",
  ),
  MSOL_KAMINO_MARKET: new PublicKey(
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
  ), // kamino main
  MSOL_KAMINO_RESERVE_ORACLE: new PublicKey(
    "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
  ),
  MSOL_KAMINO_FARM_STATE: new PublicKey(
    "11111111111111111111111111111111",
  ), // no farm on this reserve
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
  LUT: new PublicKey("UzGyBno8GEZDapsj1FAy11aquXby1wkxeeDa4Y5TdPN"), // stage
};

async function main() {
  const liquidatorWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATOR_WALLET_PATH,
  );
  const liquidateeWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATEE_WALLET_PATH,
  );
  writeJsonFile("liquidation_e2e_config.json", serializeConfig(config));

  console.log("\n\n\n 0. CHECK WALLET BALANCES");
  // Banks that give the last one 2x use (n + 1) deposits in total.
  const twice = (n: number, amt: BN) => (n > 0 ? amt.muln(n + 1) : new BN(0));
  await warnOnMissingBalances(config, [
    { who: "Liquidatee", owner: liquidateeWallet.publicKey, label: "USDC",
      mint: config.P0_COLLATERAL_MINT,
      needed: P0_DEPOSIT.muln(P0_BANKS).add(twice(KAMINO_BANKS, KAMINO_DEPOSIT)) },
    { who: "Liquidatee", owner: liquidateeWallet.publicKey, label: "PT",
      mint: config.PT_COLLATERAL_MINT, needed: PT_DEPOSIT.muln(PT_BANKS) },
    { who: "Liquidatee", owner: liquidateeWallet.publicKey, label: "mSOL",
      mint: config.MSOL_MINT, needed: KAMINO_MSOL_DEPOSIT.muln(KAMINO_MSOL_BANKS) },
    { who: "Liquidatee", owner: liquidateeWallet.publicKey, label: "USDS",
      mint: config.DRIFT_COLLATERAL_MINT, needed: twice(DRIFT_BANKS, DRIFT_DEPOSIT) },
    { who: "Liquidatee", owner: liquidateeWallet.publicKey, label: "USDT",
      mint: config.JUPLEND_COLLATERAL_MINT, needed: twice(JUPLEND_BANKS, JUPLEND_DEPOSIT) },
    { who: "Liquidator", owner: liquidatorWallet.publicKey, label: "PyUSD",
      mint: config.DEBT_MINT, needed: DEBT_DEPOSIT },
  ]);

  console.log("\n\n\n 1. INIT GROUP");
  const marginfiGroup = await initGroup(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ADMIN_KEY: liquidatorWallet.publicKey },
    config.LIQUIDATOR_WALLET_PATH,
  );
  console.log("group: " + marginfiGroup);
  await sleep(10000);
  // const marginfiGroup = new PublicKey(
  //   "27z17WWf7DFkR8VaS5s5QyJ3poaEZJrUgEBvBWGVFdaf",
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
  //   "9GNx5FDk5VKniLCpsAo9kpMneSBu28QUHtYYxsWwHSQe",
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
  //   "8rpvp9ZNW4SJjQSN9EP3yc9BtGAkYtqR6Fiu2h1fEvnZ",
  // );
  state.liquidatee = pkToString(liquidatee);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 3. ADD P0 (Fixed USDC) BANKS");
  let p0BankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ORACLE: config.KAMINO_COLLATERAL_ORACLE, // will be reset to Fixed
    ORACLE_TYPE: ORACLE_TYPE_PYTH,
    ADMIN: liquidatorWallet.publicKey,
    BANK_MINT: config.P0_COLLATERAL_MINT,
    SEED: 1,
  };

  let p0Banks: PublicKey[] = [];
  for (let i = 0; i < P0_BANKS; i++) {
    p0BankConfig.SEED = 1 + i;
    p0Banks.push(
      await addBank(true, p0BankConfig, config.LIQUIDATOR_WALLET_PATH),
    );
    await sleep(1000);
  }
  // let p0Banks = [
  //   new PublicKey("Fn3p8T5UeAP3vydyrjR8FzwjG7SXqek9oswkN7znhEog"),
  //   new PublicKey("AWLoPkAoVTD2bJXeYf42TxKztHXTMFz9fJ8qaLus7Kbk"),
  // ];
  state.p0Banks = p0Banks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  // console.log("\n\n\n 4. SET FIXED PRICE ORACLES FOR P0 BANKS");
  const configCommon = {
    PROGRAM_ID: config.PROGRAM_ID,
    ADMIN: liquidatorWallet.publicKey,
  };
  const configs = p0Banks.map(pkToBankOracleConfig);
  await setFixedOraclePrice(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    configs,
  );
  await sleep(1000);

  console.log("\n\n\n 5. DEPOSIT TO ALL P0 BANKS BY LIQUIDATEE");
  let depositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: p0Banks[0],
    ACCOUNT: liquidatee,
    AMOUNT: P0_DEPOSIT,
    MINT: config.P0_COLLATERAL_MINT,
  };

  // 0.1 USDC to each
  for (let i = 0; i < p0Banks.length; i++) {
    depositConfig.BANK = p0Banks[i];
    await depositRegular(true, depositConfig, config.LIQUIDATEE_WALLET_PATH);
    await sleep(1000);
  }

  console.log("\n\n\n 5b. ADD PT (PTPyth) BANKS");
  let ptBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ORACLE: config.PT_BASE_ORACLE, // will be reset to PTPyth
    ORACLE_TYPE: ORACLE_TYPE_PYTH,
    ADMIN: liquidatorWallet.publicKey,
    BANK_MINT: config.PT_COLLATERAL_MINT,
    SEED: 1,
  };
  let ptBanks: PublicKey[] = [];
  for (let i = 0; i < PT_BANKS; i++) {
    ptBankConfig.SEED = 1 + i;
    ptBanks.push(
      await addBank(true, ptBankConfig, config.LIQUIDATOR_WALLET_PATH),
    );
    await sleep(1000);
  }
  // let ptBanks = [
  //   new PublicKey("EYWgXLK7CyBuUhVBPsxe7zsVmmpbksDJgVCcCEvGywBg"),
  //   new PublicKey("EUqara3ejYYaaKVZS5KyeMhND1SHYYJAC7hr4G4ANvEE"),
  // ];
  state.ptBanks = ptBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 5c. SET PTPyth ORACLES FOR PT BANKS");
  await setPtOracle(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    ptBanks.map((bank) => ({
      bank,
      setup: ORACLE_SETUP_PT_PYTH,
      price: 0.9,
      oracle: config.PT_BASE_ORACLE,
      vault: config.PT_EXPONENT_VAULT,
    })),
  );
  await sleep(1000);

  console.log("\n\n\n 5d. DEPOSIT TO ALL PT BANKS BY LIQUIDATEE");
  let ptDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: ptBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: PT_DEPOSIT,
    MINT: config.PT_COLLATERAL_MINT,
  };
  for (let i = 0; i < ptBanks.length; i++) {
    ptDepositConfig.BANK = ptBanks[i];
    await depositRegular(true, ptDepositConfig, config.LIQUIDATEE_WALLET_PATH);
    await sleep(1000);
  }

  console.log("\n\n\n 6. ADD KAMINO (USDC) BANKS");
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
        false,
      ),
    );
    await sleep(1000);
  }
  // let kaminoBanks = [
  //   new PublicKey("BGD8iwYhXaYfhAFKDGNez789JLEJDmumkhYFFzxTGfDt"),
  //   new PublicKey("13Ejq4vkRZApUNskc4oH5SF5Ntr21hSnhN6aaXtDZUKn"),
  // ];
  state.kaminoBanks = kaminoBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 7. INIT KAMINO OBLIGATIONS");
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
  //   new PublicKey("23RPmyTEtwkJSfqRW4Bq443vihCYFACFX4C7PSue7T7e"),
  //   new PublicKey("AHPWmsVQ3gB1VPWtWukuhXo4JqZo4kQ79RSWqc4jfe3W"),
  // ];
  state.kaminoObligations = kaminoObligations.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 8. DEPOSIT TO ALL KAMINO BANKS BY LIQUIDATEE");
  let kaminoDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: kaminoBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: KAMINO_DEPOSIT,
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

  console.log("\n\n\n 8b. ADD KAMINO mSOL BANKS (KaminoMSOL)");
  let kaminoMsolBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ORACLE: config.MSOL_BASE_ORACLE, // will be reset to KaminoMSOL
    ORACLE_TYPE: { kaminoPythPush: {} },
    ADMIN: liquidatorWallet.publicKey,
    BANK_MINT: config.MSOL_MINT,
    KAMINO_RESERVE: config.MSOL_KAMINO_RESERVE,
    KAMINO_MARKET: config.MSOL_KAMINO_MARKET,
    SEED: 142,
  };
  let kaminoMsolBanks: PublicKey[] = [];
  for (let i = 0; i < KAMINO_MSOL_BANKS; i++) {
    kaminoMsolBankConfig.SEED = 142 + i;
    kaminoMsolBanks.push(
      await addKaminoBank(
        true,
        kaminoMsolBankConfig,
        config.LIQUIDATOR_WALLET_PATH,
        false,
      ),
    );
    await sleep(1000);
  }
  // let kaminoMsolBanks = [
  //   new PublicKey("DDJ64b4sxmrq3mdPLNJp8qijo5Q83iZ9Prc3KdkXKPyj"),
  //   new PublicKey("F8rrY7RfXVzgP4TRYi2JdNEVourhnXUoUtJQ2Svjvs1G"),
  // ];
  state.kaminoMsolBanks = kaminoMsolBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 8c. SET KaminoMSOL ORACLES");
  await configureLstOracle(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    kaminoMsolBanks.map((bank) => ({
      bank,
      oracle: config.MSOL_BASE_ORACLE,
      multiplier: config.MARINADE_STATE,
      setup: ORACLE_SETUP_KAMINO_MSOL,
    })),
  );
  await sleep(1000);

  console.log("\n\n\n 8d. INIT KAMINO mSOL OBLIGATIONS");
  let kaminoMsolObligationConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    ADMIN: liquidatorWallet.publicKey,
    BANK: kaminoMsolBanks[0],
    ADD_COMPUTE_UNITS: true,
    KAMINO_MARKET: config.MSOL_KAMINO_MARKET,
    RESERVE_ORACLE: config.MSOL_KAMINO_RESERVE_ORACLE,
    FARM_STATE: config.MSOL_KAMINO_FARM_STATE,
  };
  let kaminoMsolObligations: PublicKey[] = [];
  for (let i = 0; i < kaminoMsolBanks.length; i++) {
    kaminoMsolObligationConfig.BANK = kaminoMsolBanks[i];
    kaminoMsolObligations.push(
      await initKaminoObligation(
        true,
        kaminoMsolObligationConfig,
        config.LIQUIDATEE_WALLET_PATH,
      ),
    );
    await sleep(1000);
  }
  // let kaminoMsolObligations = [
  //   new PublicKey("CgxoXxnTQ9RgQUjY3HAgj6vtFUTKfSmM66eMxFZ4qQoo"),
  //   new PublicKey("BESEyE58c9VovWv7Dk8ncfSWJGD56Q8hWJ2rXWPKyiRe"),
  // ];
  state.kaminoMsolObligations = kaminoMsolObligations.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 8e. DEPOSIT TO ALL KAMINO mSOL BANKS BY LIQUIDATEE");
  let kaminoMsolDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: kaminoMsolBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: KAMINO_MSOL_DEPOSIT,
    BANK_MINT: config.MSOL_MINT,
    KAMINO_RESERVE: config.MSOL_KAMINO_RESERVE,
    KAMINO_MARKET: config.MSOL_KAMINO_MARKET,
    RESERVE_ORACLE: config.MSOL_KAMINO_RESERVE_ORACLE,
    FARM_STATE: config.MSOL_KAMINO_FARM_STATE,
  };
  for (let i = 0; i < kaminoMsolBanks.length; i++) {
    kaminoMsolDepositConfig.BANK = kaminoMsolBanks[i];
    await depositKamino(
      true,
      kaminoMsolDepositConfig,
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 9. ADD DRIFT (USDS) BANKS");
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

  console.log("\n\n\n 10. DEPOSIT TO ALL DRIFT BANKS BY LIQUIDATEE");
  let driftDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: kaminoBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: DRIFT_DEPOSIT,
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

  console.log("\n\n\n 11. ADD JUPLEND (USDT) BANKS");
  let juplendBankConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    GROUP_KEY: marginfiGroup,
    BANK_MINT: config.JUPLEND_COLLATERAL_MINT,
    JUPLEND_LENDING: config.JUPLEND_LENDING,
    F_TOKEN_MINT: config.JUPLEND_F_TOKEN_MINT,
    ORACLE: config.JUPLEND_COLLATERAL_ORACLE,
    ORACLE_SETUP: { juplendPythPull: {} },
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
  //   new PublicKey("scvU8c78BJSLtA66nEa2sqeoDDMpXHpq2MroGHcbTXz"),
  //   new PublicKey("AWUdzRKs96ELsbPSguDp8cZEpSDPmMmttErdbNc3xQox"),
  //   new PublicKey("7BCVGfSPMFuncaG5jB57uMLey43NXgBHRtzaLvuqpLuT"),
  //   new PublicKey("C1j3H1jDaruUSdnxbuv1dadMJj88k1zqYzyuEnMq4uuA"),
  // ];
  state.juplendBanks = juplendBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 12. INIT JUPLEND POSITIONS");
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

  console.log("\n\n\n 13. DEPOSIT TO ALL JUPLEND BANKS BY LIQUIDATEE");
  let juplendDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: juplendBanks[0],
    ACCOUNT: liquidatee,
    AMOUNT: JUPLEND_DEPOSIT,
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

  console.log("\n\n\n 14. ADD 1 (REGULAR) DEBT BANK");
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
  // const debtBank = new PublicKey("HrL7JdYsCBjuJaZXJ86RGgs7eeDbNWdYK3MhSk2W8HSW");
  state.debtBank = pkToString(debtBank);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 15. DEPOSIT TO DEBT BANK BY LIQUIDATOR");
  let regularDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: debtBank,
    ACCOUNT: liquidator,
    AMOUNT: DEBT_DEPOSIT,
    MINT: config.DEBT_MINT,
  };
  await depositRegular(
    true,
    regularDepositConfig,
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 16. BORROW FROM DEBT BANK BY LIQUIDATEE");
  let remainingAccounts: PublicKey[][] = [];
  for (let i = 0; i < p0Banks.length; i++) {
    remainingAccounts.push([p0Banks[i]]);
  }
  for (let i = 0; i < ptBanks.length; i++) {
    remainingAccounts.push([
      ptBanks[i],
      config.PT_BASE_ORACLE,
      config.PT_EXPONENT_VAULT,
    ]);
  }
  for (let i = 0; i < kaminoBanks.length; i++) {
    remainingAccounts.push([
      kaminoBanks[i],
      config.KAMINO_COLLATERAL_ORACLE,
      config.KAMINO_RESERVE,
    ]);
  }
  for (let i = 0; i < kaminoMsolBanks.length; i++) {
    remainingAccounts.push([
      kaminoMsolBanks[i],
      config.MSOL_BASE_ORACLE,
      config.MSOL_KAMINO_RESERVE,
      config.MARINADE_STATE,
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
    AMOUNT: new BN(5 * 10 ** 5), // 0.5 PyUSD
    MINT: config.DEBT_MINT,
    ADD_COMPUTE_UNITS: true,
    KAMINO_RESERVES: [
      ...(KAMINO_BANKS > 0 ? [config.KAMINO_RESERVE] : []),
      ...(KAMINO_MSOL_BANKS > 0 ? [config.MSOL_KAMINO_RESERVE] : []),
    ],
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
    "\n\n\n 17. SET ALL COLLATERAL BANKS' ASSET WEIGHT TO 0.1 TO RENDER LIQUIDATEE UNHEALTHY",
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
  for (let i = 0; i < p0Banks.length; i++) {
    bankEntries.push({
      bank: p0Banks[i],
      config: updatedBankConfig,
    });
  }
  for (let i = 0; i < ptBanks.length; i++) {
    bankEntries.push({
      bank: ptBanks[i],
      config: updatedBankConfig,
    });
  }
  for (let i = 0; i < kaminoBanks.length; i++) {
    bankEntries.push({
      bank: kaminoBanks[i],
      config: updatedBankConfig,
    });
  }
  for (let i = 0; i < kaminoMsolBanks.length; i++) {
    bankEntries.push({
      bank: kaminoMsolBanks[i],
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

  console.log("\n\n\n 18. CONFIRM LIQUIDATEE IS LIQUIDATABLE NOW");
  const pulseHealthConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    ACCOUNT: liquidatee,
    LUT: config.LUT, // copied from health_pulse.ts
  };
  await pulseHealth(pulseHealthConfig, config.LIQUIDATEE_WALLET_PATH);

  console.log("Account " + liquidatee + " is now liquidatable");
}

type BalanceRequirement = {
  who: string;
  owner: PublicKey;
  label: string;
  mint: PublicKey;
  needed: BN;
};

/** Warns (does not throw) if either wallet is short of what the deposit steps will spend. */
async function warnOnMissingBalances(
  config: Config,
  reqs: BalanceRequirement[],
) {
  const { connection } = commonSetup(
    true,
    config.PROGRAM_ID,
    config.LIQUIDATOR_WALLET_PATH,
  );

  let allOk = true;
  for (const r of reqs) {
    if (r.needed.isZero()) continue;
    const mintInfo = await connection.getAccountInfo(r.mint);
    if (!mintInfo) {
      console.warn(`  ${r.label}: mint ${r.mint.toBase58()} not found`);
      allOk = false;
      continue;
    }
    const decimals = mintInfo.data[44];
    const ata = getAssociatedTokenAddressSync(
      r.mint,
      r.owner,
      true,
      mintInfo.owner,
    );
    const acc = await connection.getAccountInfo(ata);
    const have = acc
      ? new BN((await connection.getTokenAccountBalance(ata)).value.amount)
      : new BN(0);

    if (have.lt(r.needed)) {
      allOk = false;
      const short = r.needed.sub(have);
      console.warn(
        `  ${r.who} lacks ${toUi(short, decimals)} ${r.label} ` +
          `(mint: ${r.mint.toBase58()}) to run the script. Please top up.`,
      );
    } else {
      console.log(
        `  ${r.who} ${r.label}: has ${toUi(have, decimals)}, needs ${toUi(r.needed, decimals)}`,
      );
    }
  }
  if (!allOk) {
    console.warn("  ^ script will fail at the deposit steps until topped up");
  }
}

function toUi(amount: BN, decimals: number): string {
  return (Number(amount.toString()) / 10 ** decimals).toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
}

function pkToString(pk: PublicKey | string): string {
  return typeof pk === "string" ? pk : pk.toBase58();
}

function pkToBankOracleConfig(bank: PublicKey): BankOracleConfig {
  return { bank, price: 1.0 };
}

function serializeConfig(config: Config): any {
  return {
    PROGRAM_ID: config.PROGRAM_ID,
    LIQUIDATOR_WALLET_PATH: config.LIQUIDATOR_WALLET_PATH,
    LIQUIDATEE_WALLET_PATH: config.LIQUIDATEE_WALLET_PATH,
    P0_COLLATERAL_MINT: pkToString(config.P0_COLLATERAL_MINT),
    PT_COLLATERAL_MINT: pkToString(config.PT_COLLATERAL_MINT),
    PT_EXPONENT_VAULT: pkToString(config.PT_EXPONENT_VAULT),
    PT_BASE_ORACLE: pkToString(config.PT_BASE_ORACLE),
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
    MSOL_MINT: pkToString(config.MSOL_MINT),
    MSOL_BASE_ORACLE: pkToString(config.MSOL_BASE_ORACLE),
    MARINADE_STATE: pkToString(config.MARINADE_STATE),
    MSOL_KAMINO_RESERVE: pkToString(config.MSOL_KAMINO_RESERVE),
    MSOL_KAMINO_MARKET: pkToString(config.MSOL_KAMINO_MARKET),
    MSOL_KAMINO_RESERVE_ORACLE: pkToString(config.MSOL_KAMINO_RESERVE_ORACLE),
    MSOL_KAMINO_FARM_STATE: pkToString(config.MSOL_KAMINO_FARM_STATE),
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
