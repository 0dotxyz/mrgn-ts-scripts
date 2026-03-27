import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";

// import whatever provides commonSetup, wrappedI80F48toBigNumber, etc.

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  // Whether to only include the accounts with active liability positions in the bank
  ONLY_LIABS: boolean;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANK: new PublicKey("BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR"),
  ONLY_LIABS: false,
};

// ---- Layout constants ----
const DISCRIMINATOR_LEN = 8;
const LENDING_ACCOUNT_OFFSET = 64;
const BALANCE_SIZE = 104;
const BALANCE_BANK_PK_OFFSET = 1;
const MAX_BALANCES = 16;
//** Count how many users have more or less than this many shares */
const MIN_SHARES = 841683837;

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

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.config/stage/id.json",
    undefined,
    "current",
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

  // Prepare JSON output and summary totals
  const jsonOutput: any[] = [];

  let totalAssetSharesForBank = 0;
  let totalLiabilitySharesForBank = 0;
  let totalAssetsForPureLenders = 0; // accounts with NO liabilities anywhere
  let countAboveMinShares = 0;
  let countBelowMinShares = 0;

  // Collateral-at-risk map: bankPk -> total assetShares (for accounts borrowing the target bank)
  const collateralByBank: Record<string, number> = {};

  allAcc.forEach((accInfo, index) => {
    const acc = accInfo.account;
    const pk = accInfo.publicKey.toString();
    const balances = acc.lendingAccount.balances;

    console.log(`${index}: ${pk}`);

    const accountEntry: any = {
      publicKey: pk,
      balances: [],
    };

    let hasThisBank = false;
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

        if (liab > 0) {
          hasTargetBankLiability = true;
        }
      }
    }

    // Account must contain a position in this BANK to be included in main output / file
    if (hasThisBank) {
      if (config.ONLY_LIABS && hasTargetBankLiability) {
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
          collateralByBank[bankKey] = (collateralByBank[bankKey] || 0) + asset;
        }
      }

      console.log();
    }
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

  console.log("====== SUMMARY TOTALS ======");
  console.log(`Total Asset Shares for bank:        ${totalAssetSharesForBank}`);
  console.log(
    `Total Liability Shares for bank:     ${totalLiabilitySharesForBank}`,
  );
  console.log(
    `Accounts with bank assetShares > ${MIN_SHARES}: ${countAboveMinShares}`,
  );
  console.log(
    `Accounts with bank assetShares < ${MIN_SHARES}: ${countBelowMinShares}`,
  );
  console.log(`Total Asset Shares NOT AT RISK: ${totalAssetsForPureLenders}`);
  console.log("=============================\n");

  // ----- PRINT COLLATERAL FUNDS AT RISK -----

  console.log("====== COLLATERAL FUNDS AT RISK (by bank) ======");
  const collateralEntries = Object.entries(collateralByBank);
  if (collateralEntries.length === 0) {
    console.log("None (no accounts borrowing this bank had collateral).");
  } else {
    collateralEntries.forEach(([bankPk, amount]) => {
      console.log(`${bankPk}: ${amount}`);
    });
  }
  console.log("===============================================\n");
}

main().catch((err) => {
  console.error(err);
});
