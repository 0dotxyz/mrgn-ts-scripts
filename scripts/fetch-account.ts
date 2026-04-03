import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("BcgDrQRenbNGqs46WkZg1xZzGqRQtrfWCondNFSvjQn5"),
};

async function main() {
  const user = commonSetup(true, config.PROGRAM_ID, "/.config/solana/id.json");
  const program = user.program;

  let acc = await program.account.marginfiAccount.fetch(config.ACCOUNT);
  console.log("authority: " + acc.authority);
  let balances = acc.lendingAccount.balances;
  let activeBalances = [];
  // dumpAccBalances(acc);
  for (let i = 0; i < balances.length; i++) {
    if (balances[i].active == 0) {
      // activeBalances.push({
      //   "Bank PK": "empty",
      //   Tag: "-",
      //   "Liab Shares ": "-",
      //   "Asset Shares": "-",
      //   Emissions: "-",
      // });
      continue;
    }

    activeBalances.push({
      "Bank PK": balances[i].bankPk.toString(),
      Tag: balances[i].bankAssetTag,
      "Liab Shares ": formatNumber(
        wrappedI80F48toBigNumber(balances[i].liabilityShares)
      ),
      "Asset Shares": formatNumber(
        wrappedI80F48toBigNumber(balances[i].assetShares)
      ),
      // Emissions: formatNumber(
      //   wrappedI80F48toBigNumber(balances[i].emissionsOutstanding)
      // ),
    });

    function formatNumber(num) {
      const number = parseFloat(num).toFixed(4);
      return number === "0.0000" ? "-" : number;
    }
  }
  console.table(activeBalances);
  console.log("migrated from: " + acc.migratedFrom);
  console.log("migrated to: " + acc.migratedTo);
}

main().catch((err) => {
  console.error(err);
});
