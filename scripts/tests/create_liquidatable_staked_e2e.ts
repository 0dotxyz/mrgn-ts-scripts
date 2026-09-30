import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { sleep, bigNumberToWrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { loadKeypairFromFile } from "../utils/utils";
import { initGroup } from "../admin/init_group";
import { initAccount } from "../user/init_account";
import { addBank, ORACLE_TYPE_PYTH } from "../admin/add_bank";
import { addStakedBank } from "../admin/add_bank_staked";
import { initStakedSettings } from "../../svsp/init_staked_settings";
import { depositRegular } from "../user/deposit_regular";
import { borrow } from "../user/borrow";
import { pulseHealth } from "../user/health_pulse";
import { composeRemainingAccounts } from "../../lib/utils";
import { updateLut } from "../../luts/update_lut";
import { ASSET_TAG_SOL } from "../../lib/constants";
import { deriveSinglePoolKeys } from "../common/pdas";
import {
  bankConfigOptDefault,
  BankConfigPair,
  configBank,
} from "../admin/config_bank";
import {
  BalanceRequirement,
  pkToString,
  warnOnMissingBalances,
  writeJsonFile,
} from "./e2e_helpers";

/**
 * Builds a liquidatable account made of STAKED collateral.
 *
 * Staked positions cannot share an account with DEFAULT-like ones (`validate_asset_tags`: default,
 * Kamino, Drift, Solend and JupLend all set `has_default_asset`, which a STAKED bank rejects), so
 * this cannot be folded into create_liquidatable_user_e2e.ts — the liquidatee there already holds
 * DEFAULT-like collateral. Only `ASSET_TAG_SOL` mixes with STAKED, hence the SOL banks below.
 *
 * Layout: 4 staked banks (the current per-account maximum) + 2 SOL banks, one of which the
 * liquidatee borrows from.
 */
export type Config = {
  PROGRAM_ID: string;
  LIQUIDATOR_WALLET_PATH: string;
  LIQUIDATEE_WALLET_PATH: string;
  /** Pyth SOL/USD push feed. Every staked bank prices off it times its pool's exchange rate. */
  SOL_ORACLE: PublicKey;
  /** Validator vote accounts. The SVSP pool, LST mint, sol pool and on-ramp all derive from these. */
  VALIDATOR_VOTE_ACCOUNTS: PublicKey[];
  /** Wrapped SOL. Both SOL banks use it, distinguished by their bank seed. */
  SOL_MINT: PublicKey;
  LUT: PublicKey;
};

export type State = {
  marginfiGroup: PublicKey;
  liquidator: PublicKey;
  liquidatee: PublicKey;
  stakedSettings: PublicKey;
  stakedBanks: PublicKey[];
  solCollateralBank: PublicKey;
  debtBank: PublicKey;
};

/** Per-account maximum for staked positions. */
const STAKED_BANKS = 4;

/** LSTs and wrapped SOL are both 9 decimals. */
const STAKED_DEPOSIT = new BN(2 * 10 ** 7); // 0.02 LST each, 0.08 total
const SOL_COLLATERAL_DEPOSIT = new BN(2 * 10 ** 7); // 0.02 SOL
const DEBT_DEPOSIT = new BN(5 * 10 ** 7); // 0.05 SOL, by the liquidator
const BORROW_AMOUNT = new BN(3 * 10 ** 7); // 0.03 SOL

/** Asset weight applied to every collateral bank at the end, to force the account underwater. */
const UNHEALTHY_WEIGHT = 0.1;

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  LIQUIDATOR_WALLET_PATH: "/.config/stage/id.json",
  LIQUIDATEE_WALLET_PATH: "/.config/liquidatee/id.json",
  SOL_ORACLE: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  VALIDATOR_VOTE_ACCOUNTS: [
    // Four validators with an existing SVSP pool. The liquidatee must already hold each pool's
    // LST; svsp/init_single_pool.ts + deposit_single_pool.ts mint them if you need to bootstrap.
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("11111111111111111111111111111111"),
  ],
  SOL_MINT: new PublicKey("So11111111111111111111111111111111111111112"),
  LUT: new PublicKey("UzGyBno8GEZDapsj1FAy11aquXby1wkxeeDa4Y5TdPN"),
};

async function main() {
  const liquidatorWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATOR_WALLET_PATH,
  );
  const liquidateeWallet = loadKeypairFromFile(
    process.env.HOME + config.LIQUIDATEE_WALLET_PATH,
  );

  const pools = config.VALIDATOR_VOTE_ACCOUNTS.slice(0, STAKED_BANKS).map(
    (vote) => deriveSinglePoolKeys(vote),
  );
  if (pools.length < STAKED_BANKS) {
    throw new Error(
      `need ${STAKED_BANKS} validator vote accounts, got ${pools.length}`,
    );
  }

  console.log("\n\n\n 0. CHECK WALLET BALANCES");
  const reqs: BalanceRequirement[] = pools.map((p, i) => ({
    who: "Liquidatee",
    owner: liquidateeWallet.publicKey,
    label: `LST #${i} (pool ${p.pool.toBase58().slice(0, 8)}…)`,
    mint: p.lstMint,
    needed: STAKED_DEPOSIT,
  }));
  reqs.push({
    who: "Liquidatee",
    owner: liquidateeWallet.publicKey,
    label: "wSOL",
    mint: config.SOL_MINT,
    needed: SOL_COLLATERAL_DEPOSIT,
  });
  reqs.push({
    who: "Liquidator",
    owner: liquidatorWallet.publicKey,
    label: "wSOL",
    mint: config.SOL_MINT,
    needed: DEBT_DEPOSIT,
  });
  await warnOnMissingBalances(
    config.PROGRAM_ID,
    config.LIQUIDATOR_WALLET_PATH,
    reqs,
  );

  console.log("\n\n\n 1. INIT GROUP");
  const marginfiGroup = await initGroup(
    true,
    { PROGRAM_ID: config.PROGRAM_ID, ADMIN_KEY: liquidatorWallet.publicKey },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(10000);

  const state: Partial<State> = { marginfiGroup };
  const save = () =>
    writeJsonFile("liquidation_staked_e2e_state.json", {
      ...serializeConfig(config),
      ...Object.fromEntries(
        Object.entries(state).map(([k, v]) => [
          k,
          Array.isArray(v) ? v.map(pkToString) : pkToString(v as PublicKey),
        ]),
      ),
    });
  save();

  console.log("\n\n\n 2. INIT STAKED SETTINGS FOR THE GROUP");
  // Required before any permissionless staked bank can be added: the bank inherits its weights,
  // oracle and limits from this account.
  const stakedSettings = await initStakedSettings(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP_KEY: marginfiGroup,
      SOL_ORACLE: config.SOL_ORACLE,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(3000);
  state.stakedSettings = stakedSettings;
  save();

  console.log("\n\n\n 3. INIT MARGINFI ACCOUNTS");
  const liquidator = await initAccount(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      AUTHORITY: liquidatorWallet.publicKey,

    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);
  const liquidatee = await initAccount(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP: marginfiGroup,
      AUTHORITY: liquidateeWallet.publicKey,
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(1000);
  state.liquidator = liquidator;
  state.liquidatee = liquidatee;
  save();

  console.log("\n\n\n 4. ADD STAKED BANKS");
  const stakedBanks: PublicKey[] = [];
  for (let i = 0; i < STAKED_BANKS; i++) {
    const bank = await addStakedBank(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        GROUP_KEY: marginfiGroup,
        STAKE_POOL: pools[i].pool,
        SOL_ORACLE_FEED: config.SOL_ORACLE,
        SEED: 0,
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    stakedBanks.push(bank);
    await sleep(1000);
  }
  state.stakedBanks = stakedBanks;
  save();

  console.log("\n\n\n 5. ADD SOL COLLATERAL AND DEBT BANKS");
  // Same mint, different seeds. ASSET_TAG_SOL is the only tag that mixes with STAKED.
  const solCollateralBank = await addBank(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP_KEY: marginfiGroup,
      ORACLE: config.SOL_ORACLE,
      ORACLE_TYPE: ORACLE_TYPE_PYTH,
      ADMIN: liquidatorWallet.publicKey,
      BANK_MINT: config.SOL_MINT,
      SEED: 0,
      ASSET_TAG: ASSET_TAG_SOL,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);
  const debtBank = await addBank(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      GROUP_KEY: marginfiGroup,
      ORACLE: config.SOL_ORACLE,
      ORACLE_TYPE: ORACLE_TYPE_PYTH,
      ADMIN: liquidatorWallet.publicKey,
      BANK_MINT: config.SOL_MINT,
      SEED: 1,
      ASSET_TAG: ASSET_TAG_SOL,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);
  state.solCollateralBank = solCollateralBank;
  state.debtBank = debtBank;
  save();

  console.log("\n\n\n 6. DEPOSIT TO ALL STAKED BANKS BY LIQUIDATEE");
  for (let i = 0; i < stakedBanks.length; i++) {
    await depositRegular(
      true,
      {
        PROGRAM_ID: config.PROGRAM_ID,
        BANK: stakedBanks[i],
        ACCOUNT: liquidatee,
        AMOUNT: STAKED_DEPOSIT,
        MINT: pools[i].lstMint,
      },
      config.LIQUIDATEE_WALLET_PATH,
    );
    await sleep(1000);
  }

  console.log("\n\n\n 7. DEPOSIT TO SOL COLLATERAL BANK BY LIQUIDATEE");
  await depositRegular(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANK: solCollateralBank,
      ACCOUNT: liquidatee,
      AMOUNT: SOL_COLLATERAL_DEPOSIT,
      MINT: config.SOL_MINT,
    },
    config.LIQUIDATEE_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 8. DEPOSIT TO DEBT BANK BY LIQUIDATOR");
  await depositRegular(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      BANK: debtBank,
      ACCOUNT: liquidator,
      AMOUNT: DEBT_DEPOSIT,
      MINT: config.SOL_MINT,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 9. BORROW SOL BY LIQUIDATEE");
  // A staked balance takes FIVE remaining accounts, not the usual two: bank, oracle, lst mint,
  // sol pool, on-ramp (see `get_remaining_accounts_per_asset_tag`).
  const remainingAccounts: PublicKey[][] = stakedBanks.map((bank, i) => [
    bank,
    config.SOL_ORACLE,
    pools[i].lstMint,
    pools[i].solPool,
    pools[i].onramp,
  ]);
  remainingAccounts.push([solCollateralBank, config.SOL_ORACLE]);
  remainingAccounts.push([debtBank, config.SOL_ORACLE]);

  const borrowConfig = {
    PROGRAM_ID: config.PROGRAM_ID,
    BANK: debtBank,
    ACCOUNT: liquidatee,
    AMOUNT: BORROW_AMOUNT,
    MINT: config.SOL_MINT,
    ADD_COMPUTE_UNITS: true,
    KAMINO_RESERVES: [] as PublicKey[],
    DRIFT_MARKETS: [] as number[],
    JUPLEND_STATES: [] as PublicKey[],
    NEW_REMAINING: composeRemainingAccounts(remainingAccounts),
    LUT: config.LUT,
  };

  for (
    let chunkStart = 0;
    chunkStart < borrowConfig.NEW_REMAINING.length;
    chunkStart += 10
  ) {
    await updateLut(
      true,
      {
        LUT: config.LUT,
        KEYS: borrowConfig.NEW_REMAINING.slice(chunkStart, chunkStart + 10),
      },
      config.LIQUIDATOR_WALLET_PATH,
    );
    await sleep(1000);
  }

  await borrow(true, borrowConfig, config.LIQUIDATEE_WALLET_PATH);
  await sleep(5000);

  console.log(
    `\n\n\n 10. DROP COLLATERAL ASSET WEIGHTS TO ${UNHEALTHY_WEIGHT} TO RENDER LIQUIDATEE UNHEALTHY`,
  );
  // Note: this writes the staked banks directly rather than going through
  // edit_staked_settings + propagate_staked_settings. A later propagation would undo it.
  const updatedBankConfig = bankConfigOptDefault();
  updatedBankConfig.assetWeightInit =
    bigNumberToWrappedI80F48(UNHEALTHY_WEIGHT);
  updatedBankConfig.assetWeightMaint =
    bigNumberToWrappedI80F48(UNHEALTHY_WEIGHT);

  const bankEntries: BankConfigPair[] = [
    ...stakedBanks.map((bank) => ({ bank, config: updatedBankConfig })),
    { bank: solCollateralBank, config: updatedBankConfig },
  ];
  await configBank(
    true,
    {
      PROGRAM_ID: config.PROGRAM_ID,
      ADMIN: liquidatorWallet.publicKey,
      LUT: config.LUT,
      BANKS: bankEntries,
    },
    config.LIQUIDATOR_WALLET_PATH,
  );
  await sleep(1000);

  console.log("\n\n\n 11. CONFIRM LIQUIDATEE IS LIQUIDATABLE NOW");
  await pulseHealth(
    {
      PROGRAM_ID: config.PROGRAM_ID,
      ACCOUNT: liquidatee,
      LUT: config.LUT,
    },
    config.LIQUIDATEE_WALLET_PATH,
  );

  console.log("Account " + liquidatee + " is now liquidatable");
}

function serializeConfig(config: Config): any {
  return {
    PROGRAM_ID: config.PROGRAM_ID,
    LIQUIDATOR_WALLET_PATH: config.LIQUIDATOR_WALLET_PATH,
    LIQUIDATEE_WALLET_PATH: config.LIQUIDATEE_WALLET_PATH,
    SOL_ORACLE: config.SOL_ORACLE.toBase58(),
    VALIDATOR_VOTE_ACCOUNTS: config.VALIDATOR_VOTE_ACCOUNTS.map((v) =>
      v.toBase58(),
    ),
    SOL_MINT: config.SOL_MINT.toBase58(),
    LUT: config.LUT.toBase58(),
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
