import { BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@mrgnlabs/mrgn-common";
import {
  TransactionInstruction,
  AccountMeta,
  PublicKey,
} from "@solana/web3.js";
import { KaminoConfigCompact, KLEND_PROGRAM_ID } from "./kamino-types";
import {
  deriveBankWithSeed,
  deriveLiquidityVault,
  deriveLiquidityVaultAuthority,
} from "../common/pdas";
import {
  deriveBaseObligation,
  deriveLendingMarketAuthority,
  deriveReserveCollateralMint,
  deriveReserveCollateralSupply,
  deriveReserveLiquiditySupply,
  deriveUserMetadata,
} from "./pdas";
import { KaminoLending } from "../../idl/kamino_lending";
import { Marginfi } from "../../idl/marginfi";

export interface AddKaminoBankArgs {
  seed: BN;
  config: KaminoConfigCompact;
}

export interface AddKaminoBankAccounts {
  group: PublicKey;
  feePayer: PublicKey;
  bankMint: PublicKey;
  integrationAcc1: PublicKey;
  kaminoMarket: PublicKey;
  oracle: PublicKey;
  tokenProgram?: PublicKey;
  admin?: PublicKey;
}

export const makeAddKaminoBankIx = (
  program: Program<Marginfi>,
  accounts: AddKaminoBankAccounts,
  args: AddKaminoBankArgs,
): Promise<TransactionInstruction> => {
  const oracleMeta: AccountMeta = {
    pubkey: accounts.oracle,
    isSigner: false,
    isWritable: false,
  };
  const reserveMeta: AccountMeta = {
    pubkey: accounts.integrationAcc1,
    isSigner: false,
    isWritable: false,
  };

  const [bankKey] = deriveBankWithSeed(
    program.programId,
    accounts.group,
    accounts.bankMint,
    args.seed,
  );
  console.log("key to be init: " + bankKey);
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    bankKey,
  );
  const [kaminoObligation] = deriveBaseObligation(
    liquidityVaultAuthority,
    accounts.kaminoMarket,
  );

  const ix = program.methods
    .lendingPoolAddBankKamino(args.config, args.seed)
    .accounts({
      integrationAcc2: kaminoObligation,
      tokenProgram: accounts.tokenProgram || TOKEN_PROGRAM_ID,
      ...accounts,
    })
    .accountsPartial({
      bank: bankKey,
      admin: accounts.admin,
    })
    .remainingAccounts([oracleMeta, reserveMeta])
    .instruction();

  return ix;
};

const DEFAULT_INIT_OBLIGATION_OPTIONAL_ACCOUNTS = {
  obligationFarmUserState: null,
  reserveFarmState: null,
  referrerUserMetadata: null,
  pythOracle: null,
  switchboardPriceOracle: null,
  switchboardTwapOracle: null,
  scopePrices: null,
} as const;

export interface InitObligationAccounts {
  feePayer: PublicKey;
  bank: PublicKey;
  signerTokenAccount: PublicKey;
  lendingMarket: PublicKey;
  reserve: PublicKey;
  liquidityTokenProgram?: PublicKey;
  mint: PublicKey;
  reserveLiquiditySupply: PublicKey;
  reserveCollateralMint: PublicKey;
  reserveDestinationDepositCollateral: PublicKey;

  obligationFarmUserState?: PublicKey | null;
  reserveFarmState?: PublicKey | null;
  referrerUserMetadata?: PublicKey | null;
  // Oracle accounts for refreshing the reserve, pick just one.
  pythOracle?: PublicKey | null;
  switchboardPriceOracle?: PublicKey | null;
  switchboardTwapOracle?: PublicKey | null;
  scopePrices?: PublicKey | null;
}

/**
 * Initialize a Kamino obligation for a marginfi account
 *
 * This instruction creates the user metadata and obligation accounts in the Kamino program. It
 * requires:
 * - feePayer: The account that will pay for the transaction, and owns `signerTokenAccount` doesn't
 *   have to be the admin
 * - bank: The bank account that the obligation is for
 * - lendingMarket: The Kamino lending market the bank's reserve falls under.
 *
 * @param program The marginfi program
 * @param accounts
 * @param amount - Any nominal amount is fine. Default 100 (NO DECIMALS, just 100 exactly)
 * @returns The instruction to initialize a Kamino obligation
 */
export const makeInitObligationIx = async (
  program: Program<Marginfi>,
  accounts: InitObligationAccounts,
  amount?: BN,
): Promise<TransactionInstruction> => {
  // Merge with defaults...
  const accs = {
    ...DEFAULT_INIT_OBLIGATION_OPTIONAL_ACCOUNTS,
    ...accounts,
  };

  const [liquidityVault] = deriveLiquidityVault(
    program.programId,
    accounts.bank,
  );
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    accounts.bank,
  );
  const [userMetadata] = deriveUserMetadata(
    KLEND_PROGRAM_ID,
    liquidityVaultAuthority,
  );
  const [lendingMarketAuthority] = deriveLendingMarketAuthority(
    KLEND_PROGRAM_ID,
    accounts.lendingMarket,
  );
  const [baseObligation] = deriveBaseObligation(
    liquidityVaultAuthority,
    accounts.lendingMarket,
  );

  const ix = await program.methods
    .kaminoInitObligation(amount ?? new BN(100))
    .accounts({
      // Derived
      userMetadata,
      lendingMarketAuthority,
      liquidityTokenProgram: accounts.liquidityTokenProgram
        ? accounts.liquidityTokenProgram
        : TOKEN_PROGRAM_ID,
      ...accs,
    })
    .accountsPartial({
      liquidityVault,
      integrationAcc1: accounts.reserve,
      integrationAcc2: baseObligation,
    })
    .instruction();

  return ix;
};

const DEFAULT_KAMINO_DEPOSIT_OPTIONAL_ACCOUNTS = {
  obligationFarmUserState: null,
  reserveFarmState: null,
} as const;

export interface KaminoDepositAccounts {
  marginfiAccount: PublicKey;
  bank: PublicKey;
  signerTokenAccount: PublicKey;
  lendingMarket: PublicKey;
  reserve: PublicKey;

  obligationFarmUserState?: PublicKey | null;
  reserveFarmState?: PublicKey | null;
}

export const makeKaminoDepositIx = async (
  program: Program<Marginfi>,
  accounts: KaminoDepositAccounts,
  amount: BN,
): Promise<TransactionInstruction> => {
  // Merge with defaults...
  const accs = {
    ...DEFAULT_KAMINO_DEPOSIT_OPTIONAL_ACCOUNTS,
    ...accounts,
  };

  const [lendingMarketAuthority] = deriveLendingMarketAuthority(
    KLEND_PROGRAM_ID,
    accounts.lendingMarket,
  );
  const [reserveLiquiditySupply] = deriveReserveLiquiditySupply(
    KLEND_PROGRAM_ID,
    accounts.reserve,
  );
  const [reserveCollateralMint] = deriveReserveCollateralMint(
    KLEND_PROGRAM_ID,
    accounts.reserve,
  );
  const [reserveCollateralSupply] = deriveReserveCollateralSupply(
    KLEND_PROGRAM_ID,
    accounts.reserve,
  );

  return program.methods
    .kaminoDeposit(amount)
    .accounts({
      lendingMarketAuthority,
      reserveLiquiditySupply,
      reserveCollateralMint,
      reserveDestinationDepositCollateral: reserveCollateralSupply,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      ...accs,
    })
    .instruction();
};

const DEFAULT_KAMINO_WITHDRAW_OPTIONAL_ACCOUNTS = {
  obligationFarmUserState: null,
  reserveFarmState: null,
} as const;

export interface KaminoWithdrawAccounts {
  marginfiAccount: PublicKey;
  bank: PublicKey;
  destinationTokenAccount: PublicKey;
  lendingMarket: PublicKey;
  reserve: PublicKey;
  reserveLiquidityMint: PublicKey;

  obligationFarmUserState?: PublicKey | null;
  reserveFarmState?: PublicKey | null;
}

export const makeKaminoWithdrawIx = async (
  program: Program<Marginfi>,
  accounts: KaminoWithdrawAccounts,
  amount: BN,
  withdraw_all: boolean,
  remaining: AccountMeta[],
): Promise<TransactionInstruction> => {
  // Merge with defaults...
  const accs = {
    ...DEFAULT_KAMINO_WITHDRAW_OPTIONAL_ACCOUNTS,
    ...accounts,
  };

  const [lendingMarketAuthority] = deriveLendingMarketAuthority(
    KLEND_PROGRAM_ID,
    accounts.lendingMarket,
  );
  const [reserveLiquiditySupply] = deriveReserveLiquiditySupply(
    KLEND_PROGRAM_ID,
    accounts.reserve,
  );
  const [reserveCollateralMint] = deriveReserveCollateralMint(
    KLEND_PROGRAM_ID,
    accounts.reserve,
  );
  const [reserveCollateralSupply] = deriveReserveCollateralSupply(
    KLEND_PROGRAM_ID,
    accounts.reserve,
  );

  return program.methods
    .kaminoWithdraw(amount, withdraw_all)
    .accounts({
      lendingMarketAuthority,
      reserveLiquiditySupply,
      reserveCollateralMint,
      reserveSourceCollateral: reserveCollateralSupply,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      ...accs,
    })
    .remainingAccounts(remaining)
    .instruction();
};

// Note:  The vast majority (maybe all) Kamino reserves use scope so we do not bother to support
// other types
/**
 * Refresh a generic Kamino reserve with a scope oracle.
 * @param program
 * @param reserve
 * @param market
 * @param oracle
 * @returns
 */
export const simpleRefreshReserve = (
  program: Program<KaminoLending>,
  reserve: PublicKey,
  market: PublicKey,
  oracle: PublicKey,
) => {
  const ix = program.methods
    .refreshReserve()
    .accounts({
      reserve: reserve,
      lendingMarket: market,
      pythOracle: null,
      switchboardPriceOracle: null,
      switchboardTwapOracle: null,
      scopePrices: oracle,
    })
    .instruction();

  return ix;
};

/**
 * Refresh a generic Kamino obligation
 * @param program
 * @param market
 * @param obligation
 * @param remaining - pack the reserves used in this obligation, in the order they appear, starting
 * with lending reserves. For example, a user lending USDC at index 0, SOL at index 1, borrowing
 * BONK at index 0, pass [USDC, SOL, BONK] reserves
 * @returns
 */
export const simpleRefreshObligation = (
  program: Program<KaminoLending>,
  market: PublicKey,
  obligation: PublicKey,
  remaining: PublicKey[] = [],
) => {
  const accMeta: AccountMeta[] = remaining.map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));

  const ix = program.methods
    .refreshObligation()
    .accounts({
      lendingMarket: market,
      obligation: obligation,
    })
    .remainingAccounts(accMeta)
    .instruction();

  return ix;
};
