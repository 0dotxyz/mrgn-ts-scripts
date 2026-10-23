import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SendTransactionError,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
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
import {
  composeRemainingAccounts,
  getOraclesAndKaminoIxes,
} from "../../lib/utils";
import {
  commonSetup,
  registerJuplendProgram,
  registerKaminoProgram,
} from "../../lib/common-setup";
import { JUPLEND_LENDING_PROGRAM_ID } from "../juplend/lib/utils";
import { configBankGov } from "../admin/config_bank_gov";
import { setGovernanceAdmin } from "../admin/set_governance_admin";
import { configureScopeOracle } from "../admin/config_bank_oracle_scope";
import { KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import {
  getAssociatedTokenAddressSync,
  sleep,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import { assertHealthCacheOk } from "../user/health_pulse";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { addJuplendBank } from "../juplend/add_bank";
import { depositJuplend } from "../juplend/deposit";
import { initJuplendPosition } from "../juplend/init_position";
import { updateLut } from "../../luts/update_lut";
import {
  BankOracleConfig,
  setFixedOraclePrice,
} from "../admin/config_bank_fixed_price";
import {
  ORACLE_SETUP_PT_FIXED,
  ORACLE_SETUP_PT_PYTH,
  setPtOracle,
} from "../admin/config_bank_oracle_pt";
import {
  configureLstOracle,
  ORACLE_SETUP_KAMINO_LST,
  ORACLE_SETUP_KAMINO_MSOL,
  ORACLE_SETUP_PYTH_LST,
  ORACLE_SETUP_PYTH_MSOL,
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
  JUPLEND_LENDING: PublicKey;
  JUPLEND_F_TOKEN_MINT: PublicKey;
  /** SPL stake-pool LST for PythLST / KaminoLST, and its stake pool (the LST/SOL rate). */
  JITOSOL_MINT: PublicKey;
  JITOSOL_STAKE_POOL: PublicKey;
  JITOSOL_KAMINO_RESERVE: PublicKey;
  JITOSOL_KAMINO_MARKET: PublicKey;
  JITOSOL_KAMINO_RESERVE_ORACLE: PublicKey;
  JITOSOL_KAMINO_FARM_STATE: PublicKey;
  /** Scope OraclePrices account and the entries Kamino itself uses for USDC and USDT. */
  SCOPE_PRICES: PublicKey;
  SCOPE_USDC_ENTRY: number;
  SCOPE_USDT_ENTRY: number;
  LUT: PublicKey;
  /** A push-Pyth USDC feed for the plain PythPushOracle collateral bank. */
  PYTH_COLLATERAL_ORACLE: PublicKey;
  /** JupLend lendings besides USDT's, so a liquidatee can hold four on different underlyings. */
  JUPLEND_EXTRA: JuplendVenue[];
  /** zeeper's wallet: owns the classic keeper account (CLASSIC_KEEPER). */
  KEEPER_WALLET_PATH: string;
};

type JuplendVenue = {
  symbol: string;
  mint: PublicKey;
  lending: PublicKey;
  fTokenMint: PublicKey;
  oracle: PublicKey;
  /** Overrides the JupLend banks' 300s for a feed that updates less often. */
  oracleMaxAge?: number;
  /** Switched to FixedJuplend at $1 after creation instead of pricing off `oracle`. */
  fixed?: boolean;
};

export type State = {
  marginfiGroup: PublicKey;
  liquidator: PublicKey;
  liquidatee?: PublicKey; // unset while a create run has not opened it yet
  debtBank: PublicKey;
  p0Banks: PublicKey[];
  ptBanks: PublicKey[];
  kaminoBanks: PublicKey[];
  kaminoObligations: PublicKey[];
  kaminoMsolBanks: PublicKey[];
  kaminoMsolObligations: PublicKey[];
  kaminoLstBanks: PublicKey[];
  kaminoLstObligations: PublicKey[];
  pythMsolBanks: PublicKey[];
  pythLstBanks: PublicKey[];
  scopeBanks: PublicKey[];
  juplendBanks: PublicKey[];
  kaminoPythBanks: PublicKey[];
  fixedJuplendBanks: PublicKey[];
  p0ExtraBanks: PublicKey[];
  pythBanks: PublicKey[];
  juplendExtraBanks: PublicKey[];
  keeperBanks: PublicKey[];
  keeperAccount?: PublicKey;
  sandwichLiquidatees: PublicKey[];
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
  kaminoLstBanks?: string[];
  kaminoLstObligations?: string[];
  pythMsolBanks?: string[];
  pythLstBanks?: string[];
  scopeBanks?: string[];
  juplendBanks?: string[];
  kaminoPythBanks?: string[];
  fixedJuplendBanks?: string[];
  p0ExtraBanks?: string[];
  pythBanks?: string[];
  juplendExtraBanks?: string[];
  keeperBanks?: string[];
  keeperAccount?: string;
  sandwichLiquidatees?: string[];
};

// Which liquidator the run stages for:
// - eva:    SANDWICHES = true,  VENUES = "2kamino2jup", CLASSIC_KEEPER = false
// - zeeper: SANDWICHES = false, VENUES = "4jup",        CLASSIC_KEEPER = true
// Every bank exists regardless (one setup serves both); the flags only pick what the liquidatees
// hold and whether the keeper account is opened.
/** One single-collateral liquidatee per oracle setup (eva's one-tx sandwich path). */
const SANDWICHES = false;
/**
 * The heavy liquidatee's venue positions (at most 4: the costly-position cap).
 * - "4jup": 4 JupLend on four different lendings + 11 natives + the debt: 16 balances, the most
 *   accounts a liquidation can carry (classic liquidators must fit it in one tx).
 * - "2kamino2jup": 2 Kamino + 2 JupLend + 7 natives, every position on a different oracle setup.
 */
const VENUES = "4jup" as "4jup" | "2kamino2jup";
/** Open zeeper's keeper account with a USDC deposit in the keeper bank (classic flow). */
const CLASSIC_KEEPER = true;

// 16 balances per account, and since 0.1.12 at most 4 "costly" ones (Kamino, Solend, JupLend
// and staked positions together). The layout covers every oracle setup added in 0.1.11/0.1.12 that
// has a usable venue on stage, with the costly ones holding exactly 4.
const P0_BANKS = 2; // Fixed. + 1 for debt
const PT_BANKS = 2; // first PTPyth, the rest PTFixed
const PYTH_MSOL_BANKS = 1; // PythMSOL
const PYTH_LST_BANKS = 1; // PythLST (JitoSOL)
const SCOPE_BANKS = 1; // Scope (USDC)
const KAMINO_BANKS = 1; // costly. ScopeKamino (USDC)
const KAMINO_MSOL_BANKS = 1; // costly. KaminoMSOL
const KAMINO_LST_BANKS = 1; // costly. KaminoLST (JitoSOL)
const JUPLEND_BANKS = 1; // costly. ScopeJuplend (USDT)
// JuplendLST would go here, but JupLend lists no SPL stake-pool LST, and JuplendLST requires the
// bank mint to equal the stake pool's `pool_mint`. Nothing to point it at yet.
const JUPLEND_LST_BANKS = 0;
if (KAMINO_BANKS + KAMINO_MSOL_BANKS + KAMINO_LST_BANKS + JUPLEND_BANKS > 4) {
  throw new Error("more than 4 costly positions; the program rejects the 5th deposit");
}

/** Scope entries are refreshed by Kamino's crank every ~30-60s; 70s (add_bank's default) is tight. */
const SCOPE_ORACLE_MAX_AGE = 300;

const P0_DEPOSIT = new BN(1 * 10 ** 5); // 0.1 USDC
const PT_DEPOSIT = new BN(1 * 10 ** 6); // 0.001 PT, ~$0.10
const PYTH_MSOL_DEPOSIT = new BN(1 * 10 ** 6); // 0.001 mSOL
const PYTH_LST_DEPOSIT = new BN(1 * 10 ** 6); // 0.001 JitoSOL
const KAMINO_LST_DEPOSIT = new BN(1 * 10 ** 6); // 0.001 JitoSOL
const SCOPE_DEPOSIT = new BN(1 * 10 ** 5); // 0.1 USDC
/** By the liquidator on a fresh setup; topped up when this run borrows more than the bank holds. */
const DEBT_DEPOSIT = new BN(6 * 10 ** 6); // 6 PyUSD
/** PyUSD's push feed only updates every ~19 min while its price is flat; prod allows 1200s too. */
const DEBT_ORACLE_MAX_AGE = 1200;

// Besides the heavy liquidatee (too big for eva's one-tx sandwich at 64 locked accounts, so it
// exercises the [buy][liquidate] fallback), one "sandwich" liquidatee per oracle setup holds a single
// collateral against a PyUSD debt. Each is small enough for the one-tx liquidation.
const SANDWICH_USD = new BN(15 * 10 ** 5); // 1.5 USDC / USDT
const SANDWICH_LST = new BN(11 * 10 ** 6); // 0.011 mSOL / JitoSOL
const SANDWICH_BORROW = new BN(6 * 10 ** 5); // 0.6 PyUSD each

/** Heavy liquidatee: venue legs and its debt. zeeper's settle sells what it seizes, so its venue
 * legs (the largest, hence the ones it seizes) stay above $1 to route. */
const EVA_VENUE_USD = new BN(2 * 10 ** 5); // 0.2 USDC / USDT
const ZEEPER_VENUE_USD = new BN(15 * 10 ** 5); // 1.5 per stablecoin
const HEAVY_BORROW = VENUES === "4jup" ? new BN(25 * 10 ** 5) : new BN(5 * 10 ** 5); // PyUSD
/** zeeper's keeper deposit in the keeper bank; it backs the debt the classic flow borrows. */
const KEEPER_DEPOSIT = new BN(10 * 10 ** 6); // 10 USDC
const KEEPER_WEIGHT_INIT = 0.9;
const KEEPER_WEIGHT_MAINT = 0.95;

// Step 0 lists the tokens and SOL each wallet needs for the chosen flags and fails if any is short.

/** Collateral weights a reused setup restores before borrowing: the lowest of the bank defaults. */
const REUSED_WEIGHT_INIT = 0.6;
const REUSED_WEIGHT_MAINT = 0.75;
/** SOL for rent and fees. A fresh setup pays for the group and 29 banks; a reused one only for the
 * ADDED_BANKS it still lacks. */
const LIQUIDATOR_SOL_FRESH = new BN(1.4 * 10 ** 9);
const LIQUIDATOR_SOL_REUSED = new BN(0.05 * 10 ** 9);
const SOL_PER_BANK = new BN(0.025 * 10 ** 9);
/** 12 marginfi accounts (~0.017 SOL each); a fresh setup adds the Kamino obligations and JupLend
 * positions, which the liquidatee opens because they are seeded from the signer's tokens. */
const LIQUIDATEE_SOL_FRESH = new BN(0.4 * 10 ** 9);
const LIQUIDATEE_SOL_REUSED = new BN(0.25 * 10 ** 9);
/** zeeper's wallet: its keeper account and the deposit's fees. */
const KEEPER_SOL = new BN(0.05 * 10 ** 9);

// Run book (before every program release):
// 1. Run this script. The first run creates the group and banks; later runs reuse the ones in
//    liquidation_e2e_state.json and only open fresh liquidatees.
// 2. Point eva's MARGINFI_GROUP_KEY (or zeeper's staging p0-monitor MARGINFI_GROUP) at the group it
//    prints and let the liquidator liquidate every liquidatee.
// 3. Run reset_liquidatable_user_e2e.ts: it empties the liquidatees and keeps the group and banks.
// unwind_liquidatable_user_e2e.ts tears everything down instead (bank rent back, the group's lost).
const STATE_FILE = "liquidation_e2e_state.json";
/** The bank lists a finished setup records, with how many banks each holds. */
const SETUP_BANKS: [keyof SerializedState, number][] = [
  ["p0Banks", P0_BANKS],
  ["ptBanks", PT_BANKS],
  ["pythMsolBanks", PYTH_MSOL_BANKS],
  ["pythLstBanks", PYTH_LST_BANKS],
  ["scopeBanks", SCOPE_BANKS],
  ["kaminoBanks", KAMINO_BANKS],
  ["kaminoMsolBanks", KAMINO_MSOL_BANKS],
  ["kaminoLstBanks", KAMINO_LST_BANKS],
  ["juplendBanks", JUPLEND_BANKS],
  ["kaminoPythBanks", 1],
  ["fixedJuplendBanks", 1],
];
/** Lists added after setups already existed: step 14b creates what a setup lacks of them. */
const ADDED_BANKS: [keyof SerializedState, number][] = [
  ["p0ExtraBanks", 3], // more Fixed USDC: zeeper's 16-balance liquidatee needs 11 natives
  ["pythBanks", 1], // plain PythPushOracle collateral (USDC)
  ["juplendExtraBanks", 3], // config.JUPLEND_EXTRA, in order
  ["keeperBanks", 1], // Fixed USDC that no liquidatee holds and no weight change touches
];

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  LIQUIDATOR_WALLET_PATH: "/.config/deleverager/id.json",
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
  JUPLEND_LENDING: new PublicKey(
    "F7tLdeF2YZZex9MR8HgGggyFiz7UU2UgUube2tmfwNPE",
  ), // usdt
  JUPLEND_F_TOKEN_MINT: new PublicKey(
    "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A",
  ), // usdt
  JITOSOL_MINT: new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
  JITOSOL_STAKE_POOL: new PublicKey(
    "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
  ),
  JITOSOL_KAMINO_RESERVE: new PublicKey(
    "EVbyPKrHG6WBfm4dLxLMJpUDY43cCAcHSpV3KYjKsktW",
  ),
  JITOSOL_KAMINO_MARKET: new PublicKey(
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
  ), // kamino main
  JITOSOL_KAMINO_RESERVE_ORACLE: new PublicKey(
    "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH",
  ),
  JITOSOL_KAMINO_FARM_STATE: new PublicKey(
    "11111111111111111111111111111111",
  ), // no farm on this reserve
  SCOPE_PRICES: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
  SCOPE_USDC_ENTRY: 13, // the entry Kamino's USDC reserve prices from
  SCOPE_USDT_ENTRY: 16, // the entry Kamino's USDT reserves price from
  LUT: new PublicKey("3S5KoqRRSEhWSsmfszFnKHaEAE9Yxt5dEMNHm65xqpX8"), // deleverager
  PYTH_COLLATERAL_ORACLE: new PublicKey("6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT"), // usdc push
  JUPLEND_EXTRA: [
    {
      symbol: "USDC",
      mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      lending: new PublicKey("2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ"),
      fTokenMint: new PublicKey("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"),
      oracle: new PublicKey("6HAuqASbHEh4w4REJEUUUCginTLfj1kwCh215ZLtMkrT"), // usdc push
    },
    {
      symbol: "USDS",
      mint: new PublicKey("USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA"),
      lending: new PublicKey("Ey9UTFK5KDMZJuHqndU8kYrSrWHQb5uQqNEaTk57Toc"),
      fTokenMint: new PublicKey("j14XLJZSVMcUYpAfajdZRpnfHUpJieZHS4aPektLWvh"),
      oracle: new PublicKey("BC1J4HFFraWf5dnp1wPJWNXkkoMDoHn7v18gzcbh6aGf"), // usds push
      oracleMaxAge: 1200, // seen publishing every ~4 min
    },
    {
      symbol: "JupUSD",
      mint: new PublicKey("JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD"),
      lending: new PublicKey("papYEgeG5uPE4niUWZhihUUzVVotJn1mAWbYo2UBSHi"),
      fTokenMint: new PublicKey("7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk"),
      oracle: new PublicKey("HKQmnfKCnXeJg5DhUnZXjFHDxrex6mPdrT9E29bcbfK2"), // jupusd push
      fixed: true,
    },
  ],
  KEEPER_WALLET_PATH: "/.config/zeeper/id.json",
};

/** A deposit a liquidatee makes: into bank `index` of state list `list`. */
type Position = {
  setup: string;
  list: keyof SerializedState;
  index?: number;
  mint: PublicKey;
  amount: BN;
  kamino?: { KAMINO_MARKET: PublicKey; RESERVE_ORACLE: PublicKey } & Record<string, PublicKey>;
  reserve?: PublicKey; // Kamino: refreshed by the borrow
  lending?: PublicKey; // JupLend: refreshed by the borrow
};
const USDC_KAMINO = {
  BANK_MINT: config.KAMINO_COLLATERAL_MINT,
  KAMINO_RESERVE: config.KAMINO_RESERVE,
  KAMINO_MARKET: config.KAMINO_MARKET,
  RESERVE_ORACLE: config.KAMINO_RESERVE_ORACLE,
  FARM_STATE: config.KAMINO_FARM_STATE,
};
const MSOL_KAMINO = {
  BANK_MINT: config.MSOL_MINT,
  KAMINO_RESERVE: config.MSOL_KAMINO_RESERVE,
  KAMINO_MARKET: config.MSOL_KAMINO_MARKET,
  RESERVE_ORACLE: config.MSOL_KAMINO_RESERVE_ORACLE,
  FARM_STATE: config.MSOL_KAMINO_FARM_STATE,
};
const LST_KAMINO = {
  KAMINO_MARKET: config.JITOSOL_KAMINO_MARKET,
  RESERVE_ORACLE: config.JITOSOL_KAMINO_RESERVE_ORACLE,
};
const USDC = config.P0_COLLATERAL_MINT;
const [JUP_USDC, JUP_USDS, JUP_USD] = config.JUPLEND_EXTRA;

/** Every native setup once. */
const NATIVES: Position[] = [
  { setup: "Fixed", list: "p0Banks", mint: USDC, amount: P0_DEPOSIT },
  { setup: "PTPyth", list: "ptBanks", mint: config.PT_COLLATERAL_MINT, amount: PT_DEPOSIT },
  { setup: "PTFixed", list: "ptBanks", index: 1, mint: config.PT_COLLATERAL_MINT, amount: PT_DEPOSIT },
  { setup: "PythMSOL", list: "pythMsolBanks", mint: config.MSOL_MINT, amount: PYTH_MSOL_DEPOSIT },
  { setup: "PythLST", list: "pythLstBanks", mint: config.JITOSOL_MINT, amount: PYTH_LST_DEPOSIT },
  { setup: "Scope", list: "scopeBanks", mint: USDC, amount: SCOPE_DEPOSIT },
  { setup: "PythPush", list: "pythBanks", mint: USDC, amount: P0_DEPOSIT },
];
const juplend = (v: JuplendVenue, list: keyof SerializedState, index: number, amount: BN): Position => ({
  setup: v.fixed ? "FixedJuplend" : "JuplendPythPull",
  list,
  index,
  mint: v.mint,
  amount,
  lending: v.lending,
});
/** The heavy liquidatee: debt plus the collateral VENUES picks. */
const HEAVY: Position[] =
  VENUES === "4jup"
    ? [
        ...NATIVES,
        { setup: "Fixed", list: "p0Banks", index: 1, mint: USDC, amount: P0_DEPOSIT },
        ...[0, 1, 2].map((index): Position =>
          ({ setup: "Fixed", list: "p0ExtraBanks", index, mint: USDC, amount: P0_DEPOSIT })),
        { setup: "ScopeJuplend", list: "juplendBanks", mint: config.JUPLEND_COLLATERAL_MINT,
          amount: ZEEPER_VENUE_USD, lending: config.JUPLEND_LENDING },
        ...config.JUPLEND_EXTRA.map((v, i) => juplend(v, "juplendExtraBanks", i, ZEEPER_VENUE_USD)),
      ]
    : [
        ...NATIVES,
        { setup: "ScopeKamino", list: "kaminoBanks", mint: USDC, amount: EVA_VENUE_USD,
          kamino: USDC_KAMINO, reserve: config.KAMINO_RESERVE },
        { setup: "KaminoLST", list: "kaminoLstBanks", mint: config.JITOSOL_MINT,
          amount: KAMINO_LST_DEPOSIT, kamino: LST_KAMINO, reserve: config.JITOSOL_KAMINO_RESERVE },
        { setup: "ScopeJuplend", list: "juplendBanks", mint: config.JUPLEND_COLLATERAL_MINT,
          amount: EVA_VENUE_USD, lending: config.JUPLEND_LENDING },
        juplend(JUP_USDC, "juplendExtraBanks", 0, EVA_VENUE_USD),
      ];
/** One single-collateral liquidatee per setup (SANDWICHES). PT is left out: eva needs a
 * collateral->PyUSD route for the in-tx swap. */
const SANDWICH_POSITIONS: Position[] = [
  { setup: "Fixed", list: "p0Banks", mint: USDC, amount: SANDWICH_USD },
  { setup: "Scope", list: "scopeBanks", mint: USDC, amount: SANDWICH_USD },
  { setup: "PythPush", list: "pythBanks", mint: USDC, amount: SANDWICH_USD },
  { setup: "PythMSOL", list: "pythMsolBanks", mint: config.MSOL_MINT, amount: SANDWICH_LST },
  { setup: "PythLST", list: "pythLstBanks", mint: config.JITOSOL_MINT, amount: SANDWICH_LST },
  { setup: "KaminoPythPush", list: "kaminoPythBanks", mint: USDC, amount: SANDWICH_USD,
    kamino: USDC_KAMINO, reserve: config.KAMINO_RESERVE },
  { setup: "KaminoMSOL", list: "kaminoMsolBanks", mint: config.MSOL_MINT, amount: SANDWICH_LST,
    kamino: MSOL_KAMINO, reserve: config.MSOL_KAMINO_RESERVE },
  { setup: "KaminoLST", list: "kaminoLstBanks", mint: config.JITOSOL_MINT, amount: SANDWICH_LST,
    kamino: LST_KAMINO, reserve: config.JITOSOL_KAMINO_RESERVE },
  { setup: "ScopeJuplend", list: "juplendBanks", mint: config.JUPLEND_COLLATERAL_MINT,
    amount: SANDWICH_USD, lending: config.JUPLEND_LENDING },
  { setup: "FixedJuplend", list: "fixedJuplendBanks", mint: config.JUPLEND_COLLATERAL_MINT,
    amount: SANDWICH_USD, lending: config.JUPLEND_LENDING },
  juplend(JUP_USDC, "juplendExtraBanks", 0, SANDWICH_USD),
];

async function main() {
  const liquidatorWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATOR_WALLET_PATH,
  );
  const liquidateeWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATEE_WALLET_PATH,
  );
  writeJsonFile("liquidation_e2e_config.json", serializeConfig(config));

  // The helpers below log a failed send ("Transaction failed: ...") and carry on, leaving a
  // half-built fixture. Stop the run at the first one instead.
  const logError = console.error;
  console.error = (...args: any[]) => {
    logError(...args);
    if (String(args[0]).startsWith("Transaction failed")) {
      throw new Error("a transaction failed (see above); stopping. Unwind, fix and re-run");
    }
  };
  // A preflight that fails with no logs never reached a program (e.g. the RPC has not seen the
  // blockhash yet), so nothing was sent and resending the same signed tx is safe.
  const sendRaw = Connection.prototype.sendRawTransaction;
  Connection.prototype.sendRawTransaction = async function (...args) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await sendRaw.apply(this, args);
      } catch (e) {
        const transient = e instanceof SendTransactionError && e.transactionLogs?.length === 0;
        if (!transient || attempt >= 3) throw e;
        console.log(`preflight failed before any program ran, retrying (${attempt}/2)`);
        await sleep(2000);
      }
    }
  };

  const reused = await loadReusableState(config);
  if (reused) {
    console.log(`\nReusing the group and banks in ${STATE_FILE} (group ${reused.marginfiGroup})`);
  }

  console.log("\n\n\n 0. CHECK WALLET BALANCES");
  const { program, connection } = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATOR_WALLET_PATH);
  const sandwiches = SANDWICHES ? SANDWICH_POSITIONS : [];
  const liquidateeNeeds = new Map<string, BN>();
  const need = (mint: PublicKey, amount: BN | number) =>
    liquidateeNeeds.set(mint.toBase58(), (liquidateeNeeds.get(mint.toBase58()) ?? new BN(0)).add(new BN(amount)));
  for (const p of [...HEAVY, ...sandwiches]) need(p.mint, p.amount);
  // Kamino obligations and JupLend positions are seeded with 100 native from the liquidatee.
  if (!reused) {
    need(USDC, 100 * (KAMINO_BANKS + 1)); // incl. KaminoPythPush
    need(config.MSOL_MINT, 100 * KAMINO_MSOL_BANKS);
    need(config.JITOSOL_MINT, 100 * KAMINO_LST_BANKS);
    need(config.JUPLEND_COLLATERAL_MINT, 100 * (JUPLEND_BANKS + 1)); // incl. FixedJuplend
  }
  // ...and so are the extra JupLend positions step 14b has yet to open.
  const extraJuplends = reused?.juplendExtraBanks?.length ?? 0;
  for (const v of config.JUPLEND_EXTRA.slice(extraJuplends)) need(v.mint, 100);
  const symbols = new Map(
    [
      ...config.JUPLEND_EXTRA.map((v) => [v.mint, v.symbol] as const),
      [USDC, "USDC"] as const,
      [config.PT_COLLATERAL_MINT, "PT"] as const,
      [config.MSOL_MINT, "mSOL"] as const,
      [config.JITOSOL_MINT, "JitoSOL"] as const,
      [config.JUPLEND_COLLATERAL_MINT, "USDT"] as const,
    ].map(([mint, symbol]) => [mint.toBase58(), symbol]),
  );

  // The liquidator's deposit is what the liquidatees borrow; top it up to this run's borrows.
  const totalBorrow = HEAVY_BORROW.add(SANDWICH_BORROW.muln(sandwiches.length));
  let debtLiquidity = new BN(0);
  if (reused) {
    const bank: any = await program.account.bank.fetch(new PublicKey(reused.debtBank!));
    debtLiquidity = new BN((await connection.getTokenAccountBalance(bank.liquidityVault)).value.amount);
  }
  const debtDeposit = BN.max(
    reused ? new BN(0) : DEBT_DEPOSIT,
    totalBorrow.muln(105).divn(100).sub(debtLiquidity),
  );

  const keeperWallet = CLASSIC_KEEPER
    ? loadKeypairFromFile(process.env.HOME + config.KEEPER_WALLET_PATH)
    : undefined;
  const opensKeeper = CLASSIC_KEEPER && !reused?.keeperAccount;
  await warnOnMissingBalances(config, [
    ...[...liquidateeNeeds].map(([mint, needed]) => ({
      who: "Liquidatee", owner: liquidateeWallet.publicKey, label: symbols.get(mint)!,
      mint: new PublicKey(mint), needed })),
    { who: "Liquidator", owner: liquidatorWallet.publicKey, label: "PyUSD",
      mint: config.DEBT_MINT, needed: debtDeposit }, // stays in the bank
    ...(opensKeeper
      ? [{ who: "Keeper", owner: keeperWallet!.publicKey, label: "USDC", mint: USDC,
          needed: KEEPER_DEPOSIT }]
      : []),
  ]);
  const newBanks = ADDED_BANKS.reduce(
    (n, [key, count]) => n + count - ((reused?.[key] as string[] | undefined)?.length ?? 0), 0);
  await assertSolBalances(config, [
    { who: "Liquidator", owner: liquidatorWallet.publicKey,
      needed: reused ? LIQUIDATOR_SOL_REUSED.add(SOL_PER_BANK.muln(newBanks)) : LIQUIDATOR_SOL_FRESH },
    { who: "Liquidatee", owner: liquidateeWallet.publicKey,
      needed: reused ? LIQUIDATEE_SOL_REUSED : LIQUIDATEE_SOL_FRESH },
    ...(opensKeeper ? [{ who: "Keeper", owner: keeperWallet!.publicKey, needed: KEEPER_SOL }] : []),
  ]);

  console.log("\n\n\n 1. INIT GROUP");
  const marginfiGroup = reused
    ? new PublicKey(reused.marginfiGroup)
    : await initGroup(
        true,
        { PROGRAM_ID: config.PROGRAM_ID, ADMIN_KEY: liquidatorWallet.publicKey },
        config.LIQUIDATOR_WALLET_PATH,
      );
  console.log("group: " + marginfiGroup);
  if (!reused) await sleep(10000);
  // const marginfiGroup = new PublicKey(
  //   "27z17WWf7DFkR8VaS5s5QyJ3poaEZJrUgEBvBWGVFdaf",
  // );
  // A reused setup keeps its banks; this run's liquidatees replace the (reset) previous ones.
  let state: SerializedState = reused
    ? { ...reused, liquidatee: undefined, sandwichLiquidatees: [] }
    : { marginfiGroup: pkToString(marginfiGroup) };
  writeJsonFile("liquidation_e2e_state.json", state);
  /** A list from the reused setup, or an empty one the creation steps below fill. */
  const banksOf = (key: keyof SerializedState): PublicKey[] =>
    reused ? ((reused[key] as string[]) ?? []).map((k) => new PublicKey(k)) : [];

  // 0.1.12: banks, oracles and weights need the governance admin, which a new group starts without.
  console.log("\n\n\n 1b. SET GOVERNANCE ADMIN");
  if (!reused) await setGovernanceAdmin(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      NEW_GOVERNANCE_ADMIN: liquidatorWallet.publicKey,
      SIGNER: liquidatorWallet.publicKey,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(2000);

  console.log("\n\n\n 2. INIT MARGINFI ACCOUNTS");
  const liquidator = reused
    ? new PublicKey(reused.liquidator!)
    : await initAccount(
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

  let p0Banks: PublicKey[] = banksOf("p0Banks");
  for (let i = 0; !reused && i < P0_BANKS; i++) {
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
  if (!reused) await setFixedOraclePrice(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    configs,
  );
  await sleep(1000);

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
  let ptBanks: PublicKey[] = banksOf("ptBanks");
  for (let i = 0; !reused && i < PT_BANKS; i++) {
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

  console.log("\n\n\n 5c. SET PT ORACLES (first PTPyth, the rest PTFixed)");
  if (!reused) await setPtOracle(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    ptBanks.map((bank, i) =>
      i === 0
        ? {
            bank,
            setup: ORACLE_SETUP_PT_PYTH,
            price: 0.9,
            oracle: config.PT_BASE_ORACLE,
            vault: config.PT_EXPONENT_VAULT,
          }
        : {
            // PTFixed assumes a $1 underlying, so this SOL-denominated PT is priced far below
            // market. Fine for exercising the setup; it only shrinks the bank's collateral value.
            bank,
            setup: ORACLE_SETUP_PT_FIXED,
            price: 0.9,
            vault: config.PT_EXPONENT_VAULT,
          },
    ),
  );
  await sleep(1000);

  console.log("\n\n\n 5e. ADD PythMSOL / PythLST / Scope BANKS");
  // Created with a plain Pyth feed (SOL/USD, or USDC for Scope) and switched right after.
  const addRegularBank = async (mint: PublicKey, oracle: PublicKey, seed: number) => {
    const bank = await addBank(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        GROUP_KEY: marginfiGroup,
        ORACLE: oracle,
        ORACLE_TYPE: ORACLE_TYPE_PYTH,
        ADMIN: liquidatorWallet.publicKey,
        BANK_MINT: mint,
        SEED: seed,
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
    return bank;
  };
  const pythMsolBanks: PublicKey[] = banksOf("pythMsolBanks");
  for (let i = 0; !reused && i < PYTH_MSOL_BANKS; i++) {
    pythMsolBanks.push(await addRegularBank(config.MSOL_MINT, config.MSOL_BASE_ORACLE, 1 + i));
  }
  const pythLstBanks: PublicKey[] = banksOf("pythLstBanks");
  for (let i = 0; !reused && i < PYTH_LST_BANKS; i++) {
    pythLstBanks.push(await addRegularBank(config.JITOSOL_MINT, config.MSOL_BASE_ORACLE, 1 + i));
  }
  const scopeBanks: PublicKey[] = banksOf("scopeBanks");
  for (let i = 0; !reused && i < SCOPE_BANKS; i++) {
    // P0 banks use USDC seeds 1..P0_BANKS.
    scopeBanks.push(
      await addRegularBank(config.P0_COLLATERAL_MINT, config.KAMINO_COLLATERAL_ORACLE, 1 + P0_BANKS + i),
    );
  }
  state.pythMsolBanks = pythMsolBanks.map(pkToString);
  state.pythLstBanks = pythLstBanks.map(pkToString);
  state.scopeBanks = scopeBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 5f. SET PythMSOL / PythLST / Scope ORACLES");
  if (!reused) await configureLstOracle(true, configCommon, config.LIQUIDATOR_WALLET_PATH, [
    ...pythMsolBanks.map((bank) => ({
      bank,
      oracle: config.MSOL_BASE_ORACLE,
      multiplier: config.MARINADE_STATE,
      setup: ORACLE_SETUP_PYTH_MSOL,
    })),
    ...pythLstBanks.map((bank) => ({
      bank,
      oracle: config.MSOL_BASE_ORACLE, // SOL/USD
      multiplier: config.JITOSOL_STAKE_POOL,
      setup: ORACLE_SETUP_PYTH_LST,
    })),
  ]);
  await sleep(1000);
  if (!reused) await configureScopeOracle(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    scopeBanks.map((bank) => ({
      bank,
      oracle: config.SCOPE_PRICES,
      entryIndex: config.SCOPE_USDC_ENTRY,
    })),
  );
  await sleep(1000);

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
  let kaminoBanks: PublicKey[] = banksOf("kaminoBanks");
  for (let i = 0; !reused && i < KAMINO_BANKS; i++) {
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

  console.log("\n\n\n 6b. SET ScopeKamino ORACLES");
  if (!reused) await configureScopeOracle(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    kaminoBanks.map((bank) => ({
      bank,
      oracle: config.SCOPE_PRICES,
      entryIndex: config.SCOPE_USDC_ENTRY,
      venue: config.KAMINO_RESERVE,
    })),
  );
  await sleep(1000);

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
  let kaminoObligations: PublicKey[] = banksOf("kaminoObligations");
  for (let i = 0; !reused && i < kaminoBanks.length; i++) {
    kaminoObligationConfig.BANK = kaminoBanks[i];
    kaminoObligations.push(
      await initKaminoObligation(
        true,
        kaminoObligationConfig,
        config.LIQUIDATEE_WALLET_PATH, // seeds 100 native from the signer
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
  let kaminoMsolBanks: PublicKey[] = banksOf("kaminoMsolBanks");
  for (let i = 0; !reused && i < KAMINO_MSOL_BANKS; i++) {
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
  if (!reused) await configureLstOracle(
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
  let kaminoMsolObligations: PublicKey[] = banksOf("kaminoMsolObligations");
  for (let i = 0; !reused && i < kaminoMsolBanks.length; i++) {
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

  console.log("\n\n\n 8f. ADD KAMINO JitoSOL BANKS (KaminoLST)");
  const kaminoLstBanks: PublicKey[] = banksOf("kaminoLstBanks");
  for (let i = 0; !reused && i < KAMINO_LST_BANKS; i++) {
    kaminoLstBanks.push(
      await addKaminoBank(
        true,
        {
          PROGRAM_ID: config.PROGRAM_ID,
          GROUP_KEY: marginfiGroup,
          ORACLE: config.MSOL_BASE_ORACLE, // SOL/USD; reset to KaminoLST below
          ORACLE_TYPE: { kaminoPythPush: {} },
          ADMIN: liquidatorWallet.publicKey,
          BANK_MINT: config.JITOSOL_MINT,
          KAMINO_RESERVE: config.JITOSOL_KAMINO_RESERVE,
          KAMINO_MARKET: config.JITOSOL_KAMINO_MARKET,
          SEED: 242 + i,
        },
        config.LIQUIDATOR_WALLET_PATH,
        false,
      ),
    );
    await sleep(1000);
  }
  state.kaminoLstBanks = kaminoLstBanks.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

  console.log("\n\n\n 8g. SET KaminoLST ORACLES");
  if (!reused) await configureLstOracle(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    kaminoLstBanks.map((bank) => ({
      bank,
      oracle: config.MSOL_BASE_ORACLE, // SOL/USD
      multiplier: config.JITOSOL_STAKE_POOL,
      setup: ORACLE_SETUP_KAMINO_LST,
    })),
  );
  await sleep(1000);

  console.log("\n\n\n 8h. INIT KAMINO JitoSOL OBLIGATIONS");
  const kaminoLstObligations: PublicKey[] = banksOf("kaminoLstObligations");
  for (const bank of reused ? [] : kaminoLstBanks) {
    kaminoLstObligations.push(
      await initKaminoObligation(
        true,
        {
          PROGRAM_ID: config.PROGRAM_ID,
          GROUP_KEY: marginfiGroup,
          ADMIN: liquidatorWallet.publicKey,
          BANK: bank,
          ADD_COMPUTE_UNITS: true,
          RESERVE_ORACLE: config.JITOSOL_KAMINO_RESERVE_ORACLE,
        },
        // Seeds the obligation with 100 native JitoSOL from the signer, like the mSOL one above.
        config.LIQUIDATEE_WALLET_PATH,
      ),
    );
    await sleep(1000);
  }
  state.kaminoLstObligations = kaminoLstObligations.map(pkToString);
  writeJsonFile("liquidation_e2e_state.json", state);

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
  let juplendBanks: PublicKey[] = banksOf("juplendBanks");
  for (let i = 0; !reused && i < JUPLEND_BANKS; i++) {
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

  console.log("\n\n\n 11b. SET ScopeJuplend ORACLES");
  if (!reused) await configureScopeOracle(
    true,
    configCommon,
    config.LIQUIDATOR_WALLET_PATH,
    juplendBanks.map((bank) => ({
      bank,
      oracle: config.SCOPE_PRICES,
      entryIndex: config.SCOPE_USDT_ENTRY,
      venue: config.JUPLEND_LENDING,
    })),
  );
  await sleep(1000);

  console.log("\n\n\n 11c. RAISE ORACLE MAX AGE ON SCOPE-PRICED BANKS");
  if (!reused) await configBankGov(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANKS: [...scopeBanks, ...kaminoBanks, ...juplendBanks].map((bank) => ({
        bank,
        update: { oracleMaxAge: SCOPE_ORACLE_MAX_AGE },
      })),
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 12. INIT JUPLEND POSITIONS");
  let juplendPositionConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: juplendBanks[0],
    BANK_MINT: config.JUPLEND_COLLATERAL_MINT,
  };
  for (let i = 0; !reused && i < juplendBanks.length; i++) {
    juplendPositionConfig.BANK = juplendBanks[i];
    await initJuplendPosition(
      true,
      juplendPositionConfig,
      config.LIQUIDATEE_WALLET_PATH, // seeds 100 native from the signer
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
  const debtBank = reused
    ? new PublicKey(reused.debtBank!)
    : await addBank(true, bankConfig, config.LIQUIDATOR_WALLET_PATH);
  await sleep(1000);
  // const debtBank = new PublicKey("HrL7JdYsCBjuJaZXJ86RGgs7eeDbNWdYK3MhSk2W8HSW");
  state.debtBank = pkToString(debtBank);
  writeJsonFile("liquidation_e2e_state.json", state);
  if (!reused) await configBankGov(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANKS: [{ bank: debtBank, update: { oracleMaxAge: DEBT_ORACLE_MAX_AGE } }],
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 14b. ADD MORE Fixed USDC, PythPush USDC, JupLend USDC/USDS/JupUSD, KEEPER BANKS");
  // Created up to their count, so a reused setup from before these lists gets them too.
  // USDC seeds: p0 1-2, Scope 3, these 4-8 (Kamino's start at 42).
  const fixedUsdcBank = async (seed: number) => {
    const bank = await addRegularBank(USDC, config.KAMINO_COLLATERAL_ORACLE, seed);
    await setFixedOraclePrice(true, configCommon, config.LIQUIDATOR_WALLET_PATH, [
      pkToBankOracleConfig(bank),
    ]);
    await sleep(1000);
    return bank;
  };
  const p0ExtraBanks: PublicKey[] = banksOf("p0ExtraBanks");
  const pythBanks: PublicKey[] = banksOf("pythBanks");
  const juplendExtraBanks: PublicKey[] = banksOf("juplendExtraBanks");
  const keeperBanks: PublicKey[] = banksOf("keeperBanks");
  const record = () => {
    state.p0ExtraBanks = p0ExtraBanks.map(pkToString);
    state.pythBanks = pythBanks.map(pkToString);
    state.juplendExtraBanks = juplendExtraBanks.map(pkToString);
    state.keeperBanks = keeperBanks.map(pkToString);
    writeJsonFile("liquidation_e2e_state.json", state);
  };
  record();
  for (let i = p0ExtraBanks.length; i < 3; i++) {
    p0ExtraBanks.push(await fixedUsdcBank(4 + i));
    record();
  }
  for (let i = pythBanks.length; i < 1; i++) {
    pythBanks.push(await addRegularBank(USDC, config.PYTH_COLLATERAL_ORACLE, 7 + i));
    record();
  }
  for (let i = juplendExtraBanks.length; i < config.JUPLEND_EXTRA.length; i++) {
    const v = config.JUPLEND_EXTRA[i];
    const bank = await addJuplendBank(
      true,
      {
        ...juplendBankConfig,
        BANK_MINT: v.mint,
        JUPLEND_LENDING: v.lending,
        F_TOKEN_MINT: v.fTokenMint,
        ORACLE: v.oracle,
        ORACLE_MAX_AGE: v.oracleMaxAge ?? juplendBankConfig.ORACLE_MAX_AGE,
        SEED: new BN(100 + i),
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
    await initJuplendPosition(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: bank, BANK_MINT: v.mint },
      config.LIQUIDATEE_WALLET_PATH, // seeds 100 native from the signer
    );
    await sleep(1000);
    if (v.fixed) {
      await setFixedOraclePrice(true, configCommon, config.LIQUIDATOR_WALLET_PATH, [
        pkToBankOracleConfig(bank),
      ]);
      await sleep(1000);
    }
    juplendExtraBanks.push(bank);
    record();
  }
  for (let i = keeperBanks.length; i < 1; i++) {
    // Normal weights, and left out of the weight changes in 15b and 17: the keeper's headroom.
    const bank = await fixedUsdcBank(8 + i);
    await configBankGov(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        BANKS: [{
          bank,
          update: { assetWeightInit: KEEPER_WEIGHT_INIT, assetWeightMaint: KEEPER_WEIGHT_MAINT },
        }],
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
    keeperBanks.push(bank);
    record();
  }

  console.log("\n\n\n 14c. OPEN zeeper's KEEPER ACCOUNT WITH A USDC DEPOSIT (CLASSIC_KEEPER)");
  // Only USDC in the keeper bank: a deposit in the debt bank would pay the liquidated debt itself
  // and skip zeeper's settle. A reused keeper account is left as zeeper keeps it.
  if (opensKeeper) {
    const keeper = await initAccount(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, GROUP: marginfiGroup, AUTHORITY: keeperWallet!.publicKey },
      config.KEEPER_WALLET_PATH,
    );
    await sleep(1000);
    state.keeperAccount = pkToString(keeper);
    writeJsonFile("liquidation_e2e_state.json", state);
    await depositRegular(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, BANK: keeperBanks[0], ACCOUNT: keeper, AMOUNT: KEEPER_DEPOSIT, MINT: USDC },
      config.KEEPER_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log(`\n\n\n 14d. DEPOSIT THE "${VENUES}" LAYOUT BY LIQUIDATEE`);
  const bankOf = (p: Position) => new PublicKey((state[p.list] as string[])[p.index ?? 0]);
  const depositPosition = async (account: PublicKey, p: Position) => {
    const deposit = { PROGRAM_ID: config.PROGRAM_ID, BANK: bankOf(p), ACCOUNT: account, AMOUNT: p.amount };
    if (p.kamino) {
      await depositKamino(true, { ...deposit, ...p.kamino }, config.LIQUIDATEE_WALLET_PATH);
    } else if (p.lending) {
      await depositJuplend(true, deposit, config.LIQUIDATEE_WALLET_PATH);
    } else {
      await depositRegular(true, { ...deposit, MINT: p.mint }, config.LIQUIDATEE_WALLET_PATH);
    }
    await sleep(1000);
  };
  for (const p of HEAVY) {
    await depositPosition(liquidatee, p);
  }

  console.log("\n\n\n 15. DEPOSIT TO DEBT BANK BY LIQUIDATOR");
  let regularDepositConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: debtBank,
    ACCOUNT: liquidator,
    AMOUNT: debtDeposit,
    MINT: config.DEBT_MINT,
  };
  // A reused setup keeps the liquidator's deposit (the reset repaid every borrow back into it) and
  // only tops it up when this run borrows more.
  if (!debtDeposit.isZero()) await depositRegular(
    true,
    regularDepositConfig,
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  if (reused) {
    // The previous run lowered every collateral weight to 0.1 (step 17); borrowing needs them back.
    console.log("\n\n\n 15b. RESTORE BORROWING WEIGHTS ON THE REUSED BANKS");
    await configBankGov(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        BANKS: [...SETUP_BANKS, ...ADDED_BANKS]
          .filter(([key]) => key !== "keeperBanks")
          .flatMap(([key]) => banksOf(key))
          .map((bank) => ({
            bank,
            update: { assetWeightInit: REUSED_WEIGHT_INIT, assetWeightMaint: REUSED_WEIGHT_MAINT },
          })),
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 16. BORROW FROM DEBT BANK BY LIQUIDATEE");
  // Every collateral position is already open, so read the per-bank accounts off the liquidatee
  // itself (each oracle setup takes a different number) and add the debt bank, which only becomes
  // active with this borrow.
  const user = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATEE_WALLET_PATH);
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  const [collateralAccounts] = await getOraclesAndKaminoIxes(
    user.program,
    user.kaminoProgram,
    liquidatee,
  );
  const remainingAccounts: PublicKey[][] = [
    ...collateralAccounts,
    [debtBank, config.DEBT_ORACLE],
  ];

  let borrowConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: debtBank,
    ACCOUNT: liquidatee,
    AMOUNT: HEAVY_BORROW,
    MINT: config.DEBT_MINT,
    ADD_COMPUTE_UNITS: true,
    KAMINO_RESERVES: HEAVY.flatMap((p) => (p.reserve ? [p.reserve] : [])),
    JUPLEND_STATES: HEAVY.flatMap((p) => (p.lending ? [p.lending] : [])),
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

  // Addresses added to a LUT only resolve from a later slot; a tx sent sooner gets dropped.
  const lut = (await user.connection.getAddressLookupTable(config.LUT)).value!;
  while ((await user.connection.getSlot("confirmed")) <= Number(lut.state.lastExtendedSlot) + 1) {
    await sleep(500);
  }
  await borrow(true, borrowConfig, config.LIQUIDATEE_WALLET_PATH);
  await sleep(5000);

  console.log("\n\n\n 16b. ADD KaminoPythPush / FixedJuplend BANKS (SANDWICH LIQUIDATEES ONLY)");
  // No heavy layout uses them (it has 4 costly positions already), so these two only back sandwiches.
  const kaminoPythBanks: PublicKey[] = banksOf("kaminoPythBanks");
  const fixedJuplendBanks: PublicKey[] = banksOf("fixedJuplendBanks");
  if (!reused) {
    const kaminoPythBank = await addKaminoBank(
      true,
      { ...kaminoBankConfig, SEED: 42 + KAMINO_BANKS }, // left on its kaminoPythPush setup
      config.LIQUIDATOR_WALLET_PATH,
      false,
    );
    await sleep(1000);
    kaminoObligations.push(
      await initKaminoObligation(
        true,
        { ...kaminoObligationConfig, BANK: kaminoPythBank },
        config.LIQUIDATEE_WALLET_PATH, // seeds 100 native from the signer
      ),
    );
    await sleep(1000);
    const fixedJuplendBank = await addJuplendBank(
      true,
      { ...juplendBankConfig, SEED: new BN(JUPLEND_BANKS) },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
    await initJuplendPosition(
      true,
      { ...juplendPositionConfig, BANK: fixedJuplendBank },
      config.LIQUIDATEE_WALLET_PATH, // seeds 100 native from the signer
    );
    await sleep(1000);
    await setFixedOraclePrice(true, configCommon, config.LIQUIDATOR_WALLET_PATH, [
      pkToBankOracleConfig(fixedJuplendBank),
    ]);
    await sleep(1000);
    kaminoPythBanks.push(kaminoPythBank);
    fixedJuplendBanks.push(fixedJuplendBank);
    state.kaminoObligations = kaminoObligations.map(pkToString);
    state.kaminoPythBanks = kaminoPythBanks.map(pkToString);
    state.fixedJuplendBanks = fixedJuplendBanks.map(pkToString);
    writeJsonFile("liquidation_e2e_state.json", state);
  }

  console.log("\n\n\n 16c. SANDWICH LIQUIDATEES: ONE COLLATERAL + PyUSD DEBT EACH");
  const sandwichLiquidatees: PublicKey[] = [];
  for (const s of sandwiches) {
    const account = await initAccount(
      true,
      { PROGRAM_ID: config.PROGRAM_ID, GROUP: marginfiGroup, AUTHORITY: liquidateeWallet.publicKey },
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
    sandwichLiquidatees.push(account);
    state.sandwichLiquidatees = sandwichLiquidatees.map(pkToString);
    writeJsonFile("liquidation_e2e_state.json", state);

    await depositPosition(account, s);

    const [groups] = await getOraclesAndKaminoIxes(user.program, user.kaminoProgram, account);
    await borrow(
      true,
      {
        ...borrowConfig,
        ACCOUNT: account,
        AMOUNT: SANDWICH_BORROW,
        KAMINO_RESERVES: s.reserve ? [s.reserve] : [],
        JUPLEND_STATES: s.lending ? [s.lending] : [],
        NEW_REMAINING: composeRemainingAccounts([...groups, [debtBank, config.DEBT_ORACLE]]),
      },
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(2000);
    console.log(`${s.setup} sandwich liquidatee: ${account}`);
  }

  console.log(
    "\n\n\n 17. SET ALL COLLATERAL BANKS' ASSET WEIGHT TO 0.1 TO RENDER LIQUIDATEE UNHEALTHY",
  );
  // 0.1.12: weights moved to the governance-only `lending_pool_configure_bank_gov`.
  await configBankGov(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANKS: [
        ...p0Banks,
        ...ptBanks,
        ...pythMsolBanks,
        ...pythLstBanks,
        ...scopeBanks,
        ...kaminoBanks,
        ...kaminoMsolBanks,
        ...kaminoLstBanks,
        ...juplendBanks,
        ...kaminoPythBanks,
        ...fixedJuplendBanks,
        ...p0ExtraBanks,
        ...pythBanks,
        ...juplendExtraBanks,
      ].map((bank) => ({
        bank,
        update: { assetWeightInit: 0.1, assetWeightMaint: 0.1 },
      })),
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 18. CONFIRM EVERY LIQUIDATEE IS LIQUIDATABLE NOW");
  for (const account of [liquidatee, ...sandwichLiquidatees]) {
    const cache = await simulatePulse(config, account);
    assertHealthCacheOk(cache);
    const healthMaint = wrappedI80F48toBigNumber(cache.assetValueMaint)
      .minus(wrappedI80F48toBigNumber(cache.liabilityValueMaint))
      .toNumber();
    if (healthMaint >= 0) {
      throw new Error(`liquidatee ${account} is still healthy: maintenance health $${healthMaint}`);
    }
    console.log(
      `Account ${account} is now liquidatable (maintenance health $${healthMaint.toFixed(6)})`,
    );
  }
  if (state.keeperAccount) {
    console.log(
      `\nzeeper (classic): LIQUIDATOR_ACCOUNT=${state.keeperAccount} ` +
        `LIQUIDATOR_SWAP_BANK=${keeperBanks[0]} MARGINFI_GROUP=${marginfiGroup}`,
    );
  }
}

type BalanceRequirement = {
  who: string;
  owner: PublicKey;
  label: string;
  mint: PublicKey;
  needed: BN;
};

/** Throws, before anything is sent, if either wallet is short of what the deposit steps will spend. */
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
    throw new Error("wallets are short of the tokens listed above; top up and re-run");
  }
}

/** Throws, before anything is sent, if a wallet lacks the SOL its steps spend on rent and fees. */
async function assertSolBalances(
  config: Config,
  reqs: { who: string; owner: PublicKey; needed: BN }[],
) {
  const { connection } = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATOR_WALLET_PATH);
  let allOk = true;
  for (const r of reqs) {
    const have = new BN(await connection.getBalance(r.owner));
    console.log(`  ${r.who} SOL: has ${toUi(have, 9)}, needs ${toUi(r.needed, 9)}`);
    if (have.lt(r.needed)) allOk = false;
  }
  if (!allOk) {
    throw new Error("wallets are short of SOL (see above); top up and re-run");
  }
}

/**
 * A finished setup from an earlier run (group, banks, liquidator with its PyUSD deposit) to reuse,
 * or undefined without a state file. Throws on a setup that stopped partway, lists accounts that are
 * gone, or still has funded liquidatees: unwind, reset or delete the file first, as the error says.
 */
async function loadReusableState(config: Config): Promise<SerializedState | undefined> {
  if (!existsSync(STATE_FILE)) return undefined;
  const raw: SerializedState = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const lists = [
    ...SETUP_BANKS.map(([key, n]) => [raw[key] as string[] | undefined, n, n] as const),
    ...ADDED_BANKS.map(([key, n]) => [raw[key] as string[] | undefined, 0, n] as const),
  ];
  if (
    !raw.liquidator ||
    !raw.debtBank ||
    lists.some(([list, min, max]) => (list?.length ?? 0) < min || (list?.length ?? 0) > max)
  ) {
    throw new Error(
      `${STATE_FILE} is from a setup that stopped partway. Run unwind_liquidatable_user_e2e.ts ` +
        "first (or delete the file to start over).",
    );
  }

  const { connection, program } = commonSetup(
    true,
    config.PROGRAM_ID,
    config.LIQUIDATOR_WALLET_PATH,
  );
  const keys = [
    raw.marginfiGroup,
    raw.liquidator,
    raw.debtBank,
    ...(raw.keeperAccount ? [raw.keeperAccount] : []),
    ...lists.flatMap(([l]) => l ?? []),
  ];
  const infos = await connection.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
  const gone = keys.filter((_, i) => !infos[i]?.owner.equals(program.programId));
  if (gone.length > 0) {
    throw new Error(
      `${STATE_FILE} lists accounts that no longer exist (${gone.join(", ")}). Delete the file ` +
        "to start over.",
    );
  }

  // A reset empties the last run's liquidatees; their keys are about to be overwritten.
  const liquidatees = [raw.liquidatee, ...(raw.sandwichLiquidatees ?? [])].filter(Boolean);
  for (const key of liquidatees) {
    const acc: any = await program.account.marginfiAccount.fetchNullable(new PublicKey(key!));
    if (acc?.lendingAccount.balances.some((b: any) => b.active)) {
      throw new Error(
        `liquidatee ${key} from the last run still has open positions. Run ` +
          "reset_liquidatable_user_e2e.ts first.",
      );
    }
  }
  return raw;
}

/**
 * The health cache `pulse_health` would write for `account`, from a simulation: nothing is sent, so
 * neither a dropped tx nor reading the account back before the RPC has the new state can fail it.
 */
async function simulatePulse(config: Config, account: PublicKey): Promise<any> {
  const user = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATEE_WALLET_PATH);
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  registerJuplendProgram(user, JUPLEND_LENDING_PROGRAM_ID.toString());
  const [groups, refreshIxs] = await getOraclesAndKaminoIxes(
    user.program,
    user.kaminoProgram,
    account,
    user.juplendProgram,
  );
  const pulse = await user.program.methods
    .lendingAccountPulseHealth()
    .accounts({ marginfiAccount: account })
    .remainingAccounts(
      groups.flat().map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
    )
    .instruction();
  const lut = (await user.connection.getAddressLookupTable(config.LUT)).value;
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: user.wallet.publicKey,
      recentBlockhash: (await user.connection.getLatestBlockhash()).blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 2_000_000 }),
        ...refreshIxs,
        pulse,
      ],
    }).compileToV0Message(lut ? [lut] : []),
  );
  const sim = await user.connection.simulateTransaction(tx, {
    sigVerify: false,
    accounts: { addresses: [account.toBase58()], encoding: "base64" },
  });
  if (sim.value.err) {
    throw new Error(`pulse_health simulation failed for ${account}: ${JSON.stringify(sim.value.err)}`);
  }
  const data = Buffer.from(sim.value.accounts![0]!.data[0], "base64");
  return (user.program.coder.accounts.decode("marginfiAccount", data) as any).healthCache;
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
    JUPLEND_LENDING: pkToString(config.JUPLEND_LENDING),
    JUPLEND_F_TOKEN_MINT: pkToString(config.JUPLEND_F_TOKEN_MINT),
    JITOSOL_MINT: pkToString(config.JITOSOL_MINT),
    JITOSOL_STAKE_POOL: pkToString(config.JITOSOL_STAKE_POOL),
    JITOSOL_KAMINO_RESERVE: pkToString(config.JITOSOL_KAMINO_RESERVE),
    JITOSOL_KAMINO_MARKET: pkToString(config.JITOSOL_KAMINO_MARKET),
    JITOSOL_KAMINO_RESERVE_ORACLE: pkToString(config.JITOSOL_KAMINO_RESERVE_ORACLE),
    JITOSOL_KAMINO_FARM_STATE: pkToString(config.JITOSOL_KAMINO_FARM_STATE),
    SCOPE_PRICES: pkToString(config.SCOPE_PRICES),
    SCOPE_USDC_ENTRY: config.SCOPE_USDC_ENTRY,
    SCOPE_USDT_ENTRY: config.SCOPE_USDT_ENTRY,
    LUT: pkToString(config.LUT),
    PYTH_COLLATERAL_ORACLE: pkToString(config.PYTH_COLLATERAL_ORACLE),
    JUPLEND_EXTRA: config.JUPLEND_EXTRA.map((v) => ({
      ...v,
      mint: pkToString(v.mint),
      lending: pkToString(v.lending),
      fTokenMint: pkToString(v.fTokenMint),
      oracle: pkToString(v.oracle),
    })),
    KEEPER_WALLET_PATH: config.KEEPER_WALLET_PATH,
  };
}

function writeJsonFile(path: string, obj: any) {
  const json = JSON.stringify(obj, null, 2);
  writeFileSync(path, json);
  console.log(`✔ wrote ${path}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
