import { PublicKey } from "@solana/web3.js";
import { chunk } from "../utils/utils";
import { commonSetup } from "../../lib/common-setup";
import { loadSponsoredOracle } from "../../lib/pyth-oracle-helpers";
import { PriceUpdateV2, decodePriceUpdateV2 } from "../utils/utils_oracle";

const CHUNK_SIZE = 100;
const JSON_URL =
  "https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache.json";

type Config = {
  PROGRAM_ID: string;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/keys/staging-deploy.json",
    undefined,
    "current",
  );
  const program = user.program;
  const connection = user.connection;

  type BankAcc = Awaited<ReturnType<typeof program.account.bank.fetch>>;
  // All banks except staked collateral
  type FetchedBank = {
    bankPubkey: PublicKey;
    mintPubkey: PublicKey;
    tokenName: string;
    bankAcc: BankAcc;
  };

  console.log("Fetching pools list from JSON…");
  const resp = await fetch(JSON_URL);
  if (!resp.ok) throw new Error(`Failed to fetch JSON: ${resp.statusText}`);
  const pools = (await resp.json()) as PoolEntry[];
  console.log(`Loaded ${pools.length} banks`);

  const allBanks = pools.map((p) => ({
    bankPubkey: new PublicKey(p.bankAddress),
    mintPubkey: new PublicKey(p.tokenAddress),
    tokenName: p.tokenName,
  }));

  // Just non-staked banks
  const includedBanks: FetchedBank[] = [];
  let stakedIgnored: number = 0;
  const batches = chunk(allBanks, CHUNK_SIZE);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const keys = batch.map((b) => b.bankPubkey);
    const accounts = await program.account.bank.fetchMultiple(keys);

    accounts.forEach((bankAcc, idx) => {
      const { bankPubkey, mintPubkey, tokenName } = batch[idx];
      if (!bankAcc) {
        console.warn(`  [!] Bank not found: ${bankPubkey.toBase58()}`);
        return;
      }

      if (bankAcc.config.assetTag === ASSET_TAG_STAKED) {
        stakedIgnored++;
        return;
      }

      includedBanks.push({ bankPubkey, mintPubkey, tokenName, bankAcc });

      const firstOracleKey = bankAcc.config.oracleKeys[0];
      console.log(`• Bank ${bankPubkey.toBase58()}`);
      const os = (bankAcc.config as any).oracleSetup;
      const oracleType =
        "pythPushOracle" in os
          ? "Pyth"
          : "switchboardPull" in os
            ? "Swb"
            : "???";
      console.log(
        ` oracle type: ${oracleType} key: ${firstOracleKey.toBase58()}`,
      );
    });
  }

  console.log(`Banks to process (non-staked): ${includedBanks.length}`);
  console.log(`Ignored: ${stakedIgnored} staked collateral banks`);

  console.log("Gathering Pyth feeds…");
  const feedsWithMeta: {
    meta: FetchedBank;
    feedPubkey: PublicKey;
  }[] = [];

  for (const b of includedBanks) {
    const os = (b.bankAcc.config as any).oracleSetup;
    if ("pythPushOracle" in os) {
      const sponsored = await loadSponsoredOracle(
        b.bankAcc.config.oracleKeys[0],
        connection,
      );
      feedsWithMeta.push({ meta: b, feedPubkey: sponsored.address });
    }
  }

  console.log(`Will fetch ${feedsWithMeta.length} Pyth feeds in batches…`);

  const feedBatches = chunk(feedsWithMeta, CHUNK_SIZE);

  // grab current time & slot once
  const nowMs = Date.now();
  const currentSlot = await connection.getSlot();

  for (const batch of feedBatches) {
    // getMultipleAccountsInfo takes PublicKey[]
    const infos = await connection.getMultipleAccountsInfo(
      batch.map((f) => f.feedPubkey),
    );

    infos.forEach((info, idx) => {
      const { meta, feedPubkey } = batch[idx];
      console.log(
        `\n${
          meta.tokenName
        }, Bank ${meta.bankPubkey.toBase58()}, Mint ${meta.mintPubkey.toBase58()}`,
      );

      if (!info) {
        console.warn(`  [!] No account info for feed ${feedPubkey.toBase58()}`);
        return;
      }

      // decode the Pyth v2 update
      const update: PriceUpdateV2 = decodePriceUpdateV2(Buffer.from(info.data));
      const msg = update.price_message;

      // raw → real values
      const rawPrice = msg.price.toNumber();
      const rawConf = msg.conf.toNumber();
      const factor = 10 ** msg.exponent;
      const price = rawPrice * factor;
      const conf = rawConf * factor;

      const publishMs = msg.publish_time.toNumber() * 1_000;
      const isoTs = new Date(publishMs).toISOString();
      const ageSec = (nowMs - publishMs) / 1_000;
      const slotsOld = currentSlot - update.posted_slot.toNumber();

      console.log(
        `  • Price:      ${price.toLocaleString(undefined, {
          maximumFractionDigits: 8,
        })}`,
      );
      console.log(
        `  • Confidence: ±${conf.toLocaleString(undefined, {
          maximumFractionDigits: 8,
        })}`,
      );
      console.log(`  • Published:  ${isoTs}`);
      console.log(`  • Posted Slot:${update.posted_slot.toString()}`);

      // Age display bar
      const BAR_LEN = 20;
      const maxAge = meta.bankAcc.config.oracleMaxAge;
      const pct = Math.min((ageSec / maxAge) * 100, 100);
      const filled = Math.round((pct / 100) * BAR_LEN);
      const empty = BAR_LEN - filled;
      const bar = `[${"#".repeat(filled)}${"-".repeat(empty)}]`;

      console.log(
        `  • Age:        ${ageSec.toFixed(2)}s, ${slotsOld} slots  ` +
          `${bar} ${pct.toFixed(1)}% of ${maxAge}s`,
      );
    });
  }
}

const ASSET_TAG_STAKED = 2;

type PoolEntry = {
  bankAddress: string;
  validatorVoteAccount: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
};

main().catch(console.error);
