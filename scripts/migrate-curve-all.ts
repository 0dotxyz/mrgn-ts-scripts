import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fetch from "node-fetch";
import { commonSetup } from "../lib/common-setup";
import { INTEREST_CURVE_SEVEN_POINT } from "../lib/constants";

type Config = {
  PROGRAM_ID: string;
  DEPLOY_KEYPAIR_PATH: string;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  DEPLOY_KEYPAIR_PATH: "/.keys/staging-deploy.json",
};

const CHUNK_SIZE = 10;

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    config.DEPLOY_KEYPAIR_PATH,
    undefined,
  );
  const { program, connection, wallet } = user;

  const group = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");

  let notMigrated = 0;
  let notMigratedKeys: PublicKey[] = [];
  const allBanks = await program.account.bank.all([
    {
      memcmp: {
        offset: 41,
        bytes: group.toBase58(),
      },
    },
  ]);
  for (let i = 0; i < allBanks.length; i++) {
    let acc = allBanks[i].account;
    let key = allBanks[i].publicKey;
    let migrated = acc.config.interestRateConfig.curveType;
    if (acc.config.assetTag == 2) {
      // console.log(" STAKED " + i + " " + key);
      if (!migrated) {
        console.error(
          "Staked bank " + key + " not migrated this should never happen",
        );
      }
      continue;
    }
    // Various legacy bank states are invalid due to state validation...
    if (acc.config.oracleMaxAge < 10) {
      console.log(" INELIGIBLE to migrate " + i + " " + key);
      continue;
    }
    if (migrated == 0) {
      console.log("NOT migrated " + i + " " + key);
      notMigrated++;
      notMigratedKeys.push(key);
    } else {
      // console.log(" migrated " + i + " " + key);
    }
  }

  console.log("not migrated count: " + notMigrated);

  const bankPubkeys = notMigratedKeys;
  console.log(
    `Processing ${bankPubkeys.length} banks in chunks of ${CHUNK_SIZE}...`,
  );

  for (let i = 0; i < bankPubkeys.length; i += CHUNK_SIZE) {
    const chunk = bankPubkeys.slice(i, i + CHUNK_SIZE);
    const tx = new Transaction();
    let instructionsAdded = 0;

    for (const bank of chunk) {
      console.log(`Checking bank: ${bank.toBase58()}`);
      const bankBefore = await program.account.bank.fetch(bank);
      const migrated =
        bankBefore.config.interestRateConfig.curveType ===
        INTEREST_CURVE_SEVEN_POINT;

      if (migrated) {
        console.log("  • Already migrated; skipping");
        continue;
      }

      const ix = await program.methods
        .migrateCurve()
        .accounts({
          bank,
        })
        .instruction();
      tx.add(ix);
      instructionsAdded++;
      console.log("  • Added migrateCurve instruction");
    }

    if (!instructionsAdded) {
      console.log(
        `No migrations needed for chunk starting at index ${i}; skipping transaction.`,
      );
      continue;
    }

    console.log(
      `Sending transaction for chunk starting at index ${i} (${instructionsAdded} bank(s))...`,
    );
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [
        wallet.payer,
      ]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }

    console.log();
  }
}

main().catch((err) => {
  console.error("Fatal error migrating curves:", err);
  process.exit(1);
});
