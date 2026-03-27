import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  WALLET: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  WALLET: new PublicKey("CS3NzMknNWtjo2pq5dqp67hQYQ8wdLPt5m67oa5mBZUX"),
};

async function main() {
  const user = commonSetup(true, config.PROGRAM_ID, "/.config/stage/id.json");
  const program = user.program;

  const acc = await program.account.marginfiAccount.all([
    {
      memcmp: {
        offset: 8 + 32, // Discriminator + Pubkey + u8 (matches Rust: 8 + size_of::<Pubkey>() + size_of::<u8>())
        bytes: config.WALLET.toBase58(),
      },
    },
  ]);

  acc.forEach((accInfo, index) => {
    const acc = accInfo.account;
    console.log(`${index}: ${accInfo.publicKey.toString()}`);
    console.log("group: " + acc.group.toString());
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
    if (activeBalances.length > 0) {
      console.table(activeBalances);
    }
    if (acc.migratedFrom.toString() != PublicKey.default.toString()) {
      console.log("migrated from: " + acc.migratedFrom);
    }
    if (acc.migratedTo.toString() != PublicKey.default.toString()) {
      console.log("migrated to: " + acc.migratedTo);
    }
    console.log();
  });
}

main().catch((err) => {
  console.error(err);
});
