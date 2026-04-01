import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../lib/common-setup";

// import whatever provides commonSetup, wrappedI80F48toBigNumber, etc.

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  // Whether to only include the accounts with active liability positions in the bank
  ONLY_LIABS: boolean;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANK: new PublicKey("HSWzj4oipYaMD7DtpiFcBs3oH5ZwDp4PUTtzPCJNMSd4"),
  ONLY_LIABS: false,
};

// ---- Layout constants ----
const DISCRIMINATOR_LEN = 8;
const LENDING_ACCOUNT_OFFSET = 64;
const BALANCE_SIZE = 104;
const BALANCE_BANK_PK_OFFSET = 1;
const MAX_BALANCES = 16;
//** Count how many users have more or less than this many shares */
const MIN_SHARES = 1000;

function bankPkOffsetForIndex(i: number): number {
  return (
    DISCRIMINATOR_LEN +
    LENDING_ACCOUNT_OFFSET +
    i * BALANCE_SIZE +
    BALANCE_BANK_PK_OFFSET
  );
}

function formatNumber(num: number | string) {
  const number = parseFloat(num as string).toFixed(4);
  return number === "0.0000" ? "-" : number;
}

function toFixedOrDash(num: number, decimals = 6) {
  if (!Number.isFinite(num) || num === 0) return "-";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

type BankConversionMeta = {
  mintDecimals: number;
  assetShareValue: number;
  liabilityShareValue: number;
  cachedPrice: number;
};

function convertSharesToTokens(
  shares: number,
  shareValue: number,
  mintDecimals: number,
): number {
  return (shares * shareValue) / Math.pow(10, mintDecimals);
}

function getCachedBankPrice(bankAcc: any): number {
  const oracleSetup = bankAcc?.config?.oracleSetup ?? {};
  if (Object.prototype.hasOwnProperty.call(oracleSetup, "fixed")) {
    return wrappedI80F48toBigNumber(bankAcc.config.fixedPrice).toNumber();
  }
  return wrappedI80F48toBigNumber(bankAcc.cache.lastOraclePrice).toNumber();
}

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.config/solana/id.json",
    undefined,
  );
  const program = user.program;

  const allAcc: any[] = [];

  // Query accounts for the bank across all balance slots
  for (let i = 0; i < MAX_BALANCES; i++) {
    const offset = bankPkOffsetForIndex(i);

    const accForSlot = await program.account.marginfiAccount.all([
      {
        memcmp: {
          offset,
          bytes: config.BANK.toBase58(),
        },
      },
    ]);

    allAcc.push(...accForSlot);
  }

  // Deduplicate by account key in case it appears in more than one scanned slot.
  const dedupedAccounts = new Map<string, any>();
  for (const item of allAcc) {
    dedupedAccounts.set(item.publicKey.toString(), item);
  }
  const uniqueAccounts = Array.from(dedupedAccounts.values());

  // Prepare JSON output and summary totals
  const jsonOutput: any[] = [];

  let totalAssetSharesForBank = 0;
  let totalLiabilitySharesForBank = 0;
  let totalAssetsForPureLenders = 0; // accounts with NO liabilities anywhere
  let countAboveMinShares = 0;
  let countBelowMinShares = 0;

  // Collateral-at-risk map: bankPk -> total assetShares (for accounts borrowing the target bank)
  const collateralByBankShares: Record<string, number> = {};
  // Inverse metric: for users lending target bank, sum all their liabilities by bank
  const liabilitiesByBankShares: Record<string, number> = {};

  uniqueAccounts.forEach((accInfo, index) => {
    const acc = accInfo.account;
    const pk = accInfo.publicKey.toString();
    const balances = acc.lendingAccount.balances;

    console.log(`${index}: ${pk}`);

    const accountEntry: any = {
      publicKey: pk,
      balances: [],
    };

    let hasThisBank = false;
    let hasTargetBankAsset = false;
    let hasAnyLiabilities = false;
    let hasTargetBankLiability = false;
    let targetBankAssetShares = 0;

    // First pass over balances: collect info & summary numbers
    for (let i = 0; i < balances.length; i++) {
      const b = balances[i];
      if (b.active === 0) continue;

      const asset = wrappedI80F48toBigNumber(b.assetShares).toNumber();
      const liab = wrappedI80F48toBigNumber(b.liabilityShares).toNumber();
      const hasEmissions = !wrappedI80F48toBigNumber(
        b.emissionsOutstanding,
      ).isZero();

      if (liab > 0) {
        hasAnyLiabilities = true;
      }

      const balInfo = {
        balanceIndex: i,
        bankPk: b.bankPk.toString(),
        tag: b.bankAssetTag,
        assetShares: formatNumber(asset),
        liabilityShares: formatNumber(liab),
        hasEmissions,
      };

      accountEntry.balances.push(balInfo);

      // Track only balances belonging to the TARGET bank
      if (b.bankPk.equals(config.BANK)) {
        hasThisBank = true;
        totalAssetSharesForBank += asset;
        totalLiabilitySharesForBank += liab;
        targetBankAssetShares += asset;
        if (asset > 0) {
          hasTargetBankAsset = true;
        }

        if (liab > 0) {
          hasTargetBankLiability = true;
        }
      }
    }

    // Account must contain a position in this BANK to be included in main output / file
    if (hasThisBank) {
      if (!config.ONLY_LIABS || hasTargetBankLiability) {
        jsonOutput.push(accountEntry);
      }
      if (targetBankAssetShares > MIN_SHARES) {
        countAboveMinShares += 1;
      } else if (targetBankAssetShares < MIN_SHARES) {
        countBelowMinShares += 1;
      }

      if (accountEntry.balances.length > 0) {
        console.table(accountEntry.balances);
      }

      // If zero liabilities ANYWHERE, add this account’s assetShares in the target bank as PURE
      // LENDER with no risk
      if (!hasAnyLiabilities) {
        for (let i = 0; i < balances.length; i++) {
          const b = balances[i];
          if (b.active === 0) continue;
          if (b.bankPk.equals(config.BANK)) {
            const asset = wrappedI80F48toBigNumber(b.assetShares).toNumber();
            totalAssetsForPureLenders += asset;
          }
        }
      }

      // If this account has a liability in the TARGET bank, treat *all* of its positive asset
      // balances (across all banks) as collateral at risk. Note that this is a gross
      // over-estimation: a dollar of liability doesn't technically expose the entire collateral,
      // but it *could* in theory if the price goes to infinity.
      if (hasTargetBankLiability) {
        for (let i = 0; i < balances.length; i++) {
          const b = balances[i];
          if (b.active === 0) continue;

          const asset = wrappedI80F48toBigNumber(b.assetShares).toNumber();
          if (asset <= 0) continue;

          const bankKey = b.bankPk.toString();
          collateralByBankShares[bankKey] =
            (collateralByBankShares[bankKey] || 0) + asset;
        }
      }

      // Inverse metric:
      // If this account is lending in target bank (asset > 0 in target bank),
      // then all of its positive liabilities are liabilities "at risk", grouped by bank.
      if (hasTargetBankAsset) {
        for (let i = 0; i < balances.length; i++) {
          const b = balances[i];
          if (b.active === 0) continue;

          const liab = wrappedI80F48toBigNumber(b.liabilityShares).toNumber();
          if (liab <= 0) continue;

          const bankKey = b.bankPk.toString();
          liabilitiesByBankShares[bankKey] =
            (liabilitiesByBankShares[bankKey] || 0) + liab;
        }
      }

      console.log();
    }
  });

  // Fetch all referenced banks once so we can convert SHARES -> TOKEN amounts.
  const banksNeeded = new Set<string>();
  banksNeeded.add(config.BANK.toString());
  Object.keys(collateralByBankShares).forEach((k) => banksNeeded.add(k));
  Object.keys(liabilitiesByBankShares).forEach((k) => banksNeeded.add(k));

  const bankKeys = Array.from(banksNeeded).map((k) => new PublicKey(k));
  const bankAccounts = await program.account.bank.fetchMultiple(bankKeys);
  const bankMetaByPk: Record<string, BankConversionMeta> = {};

  bankAccounts.forEach((bankAcc, i) => {
    if (!bankAcc) return;
    const bankPk = bankKeys[i].toString();
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

  // ----- WRITE OUTPUT TO FILE -----

  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
  }

  const filename = `${config.BANK.toBase58()}_accounts.json`;
  const filePath = path.join(logsDir, filename);

  fs.writeFileSync(filePath, JSON.stringify(jsonOutput, null, 2));
  console.log(`\n📁 Results written to: ${filePath}\n`);

  // ----- PRINT SUMMARY TOTALS -----
  console.log(`\nBANK: ${config.BANK}\n`);
  const targetBankMeta = bankMetaByPk[config.BANK.toString()];
  const totalAssetTokensForBank = targetBankMeta
    ? convertSharesToTokens(
        totalAssetSharesForBank,
        targetBankMeta.assetShareValue,
        targetBankMeta.mintDecimals,
      )
    : NaN;
  const totalLiabilityTokensForBank = targetBankMeta
    ? convertSharesToTokens(
        totalLiabilitySharesForBank,
        targetBankMeta.liabilityShareValue,
        targetBankMeta.mintDecimals,
      )
    : NaN;
  const totalAssetsForPureLendersTokens = targetBankMeta
    ? convertSharesToTokens(
        totalAssetsForPureLenders,
        targetBankMeta.assetShareValue,
        targetBankMeta.mintDecimals,
      )
    : NaN;

  console.log("====== SUMMARY TOTALS ======");
  console.log(
    `Total Asset Shares for bank:        ${toFixedOrDash(totalAssetSharesForBank)}`,
  );
  console.log(
    `Total Asset Tokens for bank:        ${toFixedOrDash(totalAssetTokensForBank)}`,
  );
  console.log(
    `Total Liability Shares for bank:     ${toFixedOrDash(totalLiabilitySharesForBank)}`,
  );
  console.log(
    `Total Liability Tokens for bank:     ${toFixedOrDash(totalLiabilityTokensForBank)}`,
  );
  console.log(
    `Accounts with bank assetShares > ${MIN_SHARES}: ${countAboveMinShares}`,
  );
  console.log(
    `Accounts with bank assetShares < ${MIN_SHARES}: ${countBelowMinShares}`,
  );
  console.log(
    `Total Asset Shares NOT AT RISK:      ${toFixedOrDash(totalAssetsForPureLenders)}`,
  );
  console.log(
    `Total Asset Tokens NOT AT RISK:      ${toFixedOrDash(totalAssetsForPureLendersTokens)}`,
  );
  console.log("=============================\n");

  // ----- PRINT COLLATERAL FUNDS AT RISK -----

  console.log("====== COLLATERAL FUNDS AT RISK (by bank) ======");
  const collateralEntries = Object.entries(collateralByBankShares);
  if (collateralEntries.length === 0) {
    console.log("None (no accounts borrowing this bank had collateral).");
  } else {
    const rows = collateralEntries
      .map(([bankPk, shares]) => {
        const bankMeta = bankMetaByPk[bankPk];
        const tokens = bankMeta
          ? convertSharesToTokens(
              shares,
              bankMeta.assetShareValue,
              bankMeta.mintDecimals,
            )
          : NaN;
        const usd = bankMeta ? tokens * bankMeta.cachedPrice : NaN;

        return { bankPk, shares, tokens, usd };
      })
      .sort((a, b) => {
        const av = Number.isFinite(a.usd) ? a.usd : -Infinity;
        const bv = Number.isFinite(b.usd) ? b.usd : -Infinity;
        return bv - av;
      })
      .map((row) => {
        const { bankPk, shares, tokens, usd } = row;

        return {
          Bank: bankPk,
          "Asset Shares": toFixedOrDash(shares, 2),
          "Asset Tokens": toFixedOrDash(tokens, 6),
          "Asset USD": toFixedOrDash(usd, 2),
        };
      });
    console.table(rows);
  }
  console.log("===============================================\n");

  // ----- PRINT LIABILITIES AT RISK -----
  console.log("====== LIABILITIES AT RISK (by bank) ======");
  const liabilityEntries = Object.entries(liabilitiesByBankShares);
  if (liabilityEntries.length === 0) {
    console.log("None (no lenders in this bank had liabilities).");
  } else {
    const rows = liabilityEntries
      .map(([bankPk, shares]) => {
        const bankMeta = bankMetaByPk[bankPk];
        const tokens = bankMeta
          ? convertSharesToTokens(
              shares,
              bankMeta.liabilityShareValue,
              bankMeta.mintDecimals,
            )
          : NaN;
        const usd = bankMeta ? tokens * bankMeta.cachedPrice : NaN;

        return { bankPk, shares, tokens, usd };
      })
      .sort((a, b) => {
        const av = Number.isFinite(a.usd) ? a.usd : -Infinity;
        const bv = Number.isFinite(b.usd) ? b.usd : -Infinity;
        return bv - av;
      })
      .map((row) => {
        const { bankPk, shares, tokens, usd } = row;

        return {
          Bank: bankPk,
          "Liability Shares": toFixedOrDash(shares, 2),
          "Liability Tokens": toFixedOrDash(tokens, 6),
          "Liability USD": toFixedOrDash(usd, 2),
        };
      });
    console.table(rows);
  }
  console.log("==========================================\n");
}

main().catch((err) => {
  console.error(err);
});
