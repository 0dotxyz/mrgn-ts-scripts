import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { mapBankKeysToTickerVenue } from "../meta/bank-meta-utils";
import type {
  ActiveBalanceRow,
  BalanceLike,
  BankAccountLike,
} from "../mockTypes";

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("5C9UQG8q7B4Epaj6yBMY7DNtw75LWipBhBUoXL84r4vj"),
};

type BankConversionMeta = {
  mintDecimals: number;
  assetShareValue: number;
  liabilityShareValue: number;
  cachedPrice: number;
};

function toFixedOrDash(num: number, decimals = 6) {
  if (!Number.isFinite(num) || num === 0) return "-";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function convertSharesToTokens(
  shares: number,
  shareValue: number,
  mintDecimals: number,
): number {
  return (shares * shareValue) / Math.pow(10, mintDecimals);
}

function getCachedBankPrice(bankAcc: BankAccountLike): number {
  const oracleSetup = bankAcc?.config?.oracleSetup ?? {};
  const isFixedOracleSetup =
    JSON.stringify(oracleSetup) === JSON.stringify({ fixed: {} });
  if (isFixedOracleSetup) {
    return wrappedI80F48toBigNumber(bankAcc.config.fixedPrice).toNumber();
  }
  return wrappedI80F48toBigNumber(bankAcc.cache.lastOraclePrice).toNumber();
}

async function main() {
  const user = commonSetup(true, config.PROGRAM_ID, "/.config/solana/id.json");
  const program = user.program;

  const acc = await program.account.marginfiAccount.fetch(config.ACCOUNT);
  console.log("account: " + config.ACCOUNT);
  console.log("authority: " + acc.authority);
  const balances = acc.lendingAccount.balances as BalanceLike[];
  const activeBalanceSlots = balances.filter((b) => b.active !== 0);
  const activeBalances: ActiveBalanceRow[] = [];
  let totalAssetUsd = 0;
  let totalLiabilityUsd = 0;

  const activeBankPkSet = new Set<string>();
  for (const b of activeBalanceSlots) {
    activeBankPkSet.add(b.bankPk.toString());
  }

  const activeBankKeys = Array.from(activeBankPkSet).map(
    (k) => new PublicKey(k),
  );
  const bankAccounts = (await program.account.bank.fetchMultiple(
    activeBankKeys,
  )) as Array<BankAccountLike | null>;
  const bankMetaByPk: Record<string, BankConversionMeta> = {};
  const bankTickerVenueByPk = mapBankKeysToTickerVenue(
    activeBankKeys.map((k) => k.toString()),
  );

  bankAccounts.forEach((bankAcc, i) => {
    if (!bankAcc) return;
    const bankPk = activeBankKeys[i].toString();
    bankMetaByPk[bankPk] = {
      mintDecimals: bankAcc.mintDecimals,
      assetShareValue: wrappedI80F48toBigNumber(
        bankAcc.assetShareValue,
      ).toNumber(),
      liabilityShareValue: wrappedI80F48toBigNumber(
        bankAcc.liabilityShareValue,
      ).toNumber(),
      cachedPrice: getCachedBankPrice(bankAcc),
    };
  });

  for (const b of activeBalanceSlots) {
    const bankPk = b.bankPk.toString();
    const bankMeta = bankMetaByPk[bankPk];

    const liabilityShares = wrappedI80F48toBigNumber(
      b.liabilityShares,
    ).toNumber();
    const assetShares = wrappedI80F48toBigNumber(b.assetShares).toNumber();

    const liabilityTokens = bankMeta
      ? convertSharesToTokens(
          liabilityShares,
          bankMeta.liabilityShareValue,
          bankMeta.mintDecimals,
        )
      : 0;
    const assetTokens = bankMeta
      ? convertSharesToTokens(
          assetShares,
          bankMeta.assetShareValue,
          bankMeta.mintDecimals,
        )
      : 0;

    const liabilityUsd = bankMeta ? liabilityTokens * bankMeta.cachedPrice : 0;
    const assetUsd = bankMeta ? assetTokens * bankMeta.cachedPrice : 0;
    totalLiabilityUsd += liabilityUsd;
    totalAssetUsd += assetUsd;

    activeBalances.push({
      "Bank PK": bankPk,
      "Ticker/Venue": bankTickerVenueByPk[bankPk] || bankPk,
      Tag: b.bankAssetTag,
      // "Liab Shares": toFixedOrDash(liabilityShares, 4),
      "Liab Tokens": toFixedOrDash(liabilityTokens, 6),
      "Liab USD": toFixedOrDash(liabilityUsd, 2),
      // "Asset Shares": toFixedOrDash(assetShares, 4),
      "Asset Tokens": toFixedOrDash(assetTokens, 6),
      "Asset USD": toFixedOrDash(assetUsd, 2),
    });
  }

  console.table(activeBalances);
  const netAccountUsd = totalAssetUsd - totalLiabilityUsd;
  console.log(`net account value (usd): ${toFixedOrDash(netAccountUsd, 2)}`);
  if (!acc.migratedFrom.equals(PublicKey.default)) {
    console.log("migrated from: " + acc.migratedFrom);
  }
  if (!acc.migratedTo.equals(PublicKey.default)) {
    console.log("migrated to: " + acc.migratedFrom);
  }
}

main().catch((err) => {
  console.error(err);
});
