import type { WrappedI80F48 } from "@mrgnlabs/mrgn-common";
import type { PublicKey } from "@solana/web3.js";

export type WrappedI80Input = WrappedI80F48;

export type BalanceLike = {
  active: number;
  bankPk: PublicKey;
  bankAssetTag: string | number;
  liabilityShares: WrappedI80Input;
  assetShares: WrappedI80Input;
};

export type BankAccountLike = {
  mintDecimals: number;
  assetShareValue: WrappedI80Input;
  liabilityShareValue: WrappedI80Input;
  config: {
    oracleSetup?: unknown;
    fixedPrice: WrappedI80Input;
  };
  cache: {
    lastOraclePrice: WrappedI80Input;
  };
};

export type ActiveBalanceRow = {
  "Bank PK": string;
  "Ticker/Venue": string;
  Tag: string | number;
  "Liab Tokens": string;
  "Liab USD": string;
  "Asset Tokens": string;
  "Asset USD": string;
};

