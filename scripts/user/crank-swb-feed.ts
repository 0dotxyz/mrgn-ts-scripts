import dotenv from "dotenv";
import { loadKeypairFromFile } from "../../lib/utils";

import * as sb from "@switchboard-xyz/on-demand";
import { PullFeed } from "@switchboard-xyz/on-demand";

import { CrossbarClient } from "@switchboard-xyz/common";
import { appendFileSync, readFileSync } from "fs";
import {
  Commitment,
  sendAndConfirmRawTransaction,
  Connection,
} from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_FILE = `swb-crank-output-${timestamp}.csv`;
console.log(`Output file: ${OUTPUT_FILE}`);

const TX_CONFIG = {
  commitment: "confirmed" as Commitment,
  skipPreflight: true,
  maxRetries: 1,
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

dotenv.config();
if (!process.env.MARGINFI_PROGRAM_ID) {
  console.error(
    "❌ Missing required environment variable MARGINFI_PROGRAM_ID.",
  );
  process.exit(1);
}
console.log(`Using Marginfi Program ID: ${process.env.MARGINFI_PROGRAM_ID}`);

if (!process.env.MARGINFI_WALLET) {
  console.error("❌ Missing required environment variable MARGINFI_WALLET.");
  process.exit(1);
}
console.log(`Using Marginfi Wallet: ${process.env.MARGINFI_WALLET}`);

if (!process.env.PRIVATE_RPC_ENDPOINT) {
  console.error(
    "❌ Missing required environment variable PRIVATE_RPC_ENDPOINT.",
  );
  process.exit(1);
}
console.log(`Using Private RPC Endpoint: ${process.env.PRIVATE_RPC_ENDPOINT}`);

const MARGINFI_WALLET_FULL_PATH =
  process.env.HOME + process.env.MARGINFI_WALLET;
console.log(`The Marginfi Wallet full path: ${MARGINFI_WALLET_FULL_PATH}`);

// The Swb Feeds file
if (!process.argv[2]) {
  console.error("❌ Missing the required Feeds file argument.");
  process.exit(1);
}
console.log(`Using Feeds file: ${process.argv[2]}`);

const feeds: string[] = readFileSync(process.argv[2], "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.split("=").slice(1).join("="));

// The Crossbar URL
const CROSSBAR_URL = process.argv[3];
if (!CROSSBAR_URL) {
  console.error("❌ Missing the required Crossbar URL argument.");
  process.exit(1);
}
console.log(`Using Crossbar URL: ${CROSSBAR_URL}`);

// The Cranking delay
const CRANKING_DELAY = process.argv[4] ? parseInt(process.argv[4]) : 60;
console.log(`Using Cranking delay: ${CRANKING_DELAY} seconds`);

const crank_all = process.argv[5] === "all";
if (crank_all) {
  console.log("Cranking all feeds at once.");
} else {
  console.log("Cranking feeds one by one.");
}

(async () => {
  const connection = new Connection(
    process.env.PRIVATE_RPC_ENDPOINT,
    "confirmed",
  );
  const wallet = new Wallet(loadKeypairFromFile(process.env.MARGINFI_WALLET));
  const swbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection);
  const crossbar = new CrossbarClient(CROSSBAR_URL, true);
  const queue = await sb.Queue.loadDefault(swbProgram!);
  const gateway = await queue.fetchGatewayFromCrossbar(crossbar);

  async function crank(feeds: PullFeed[]) {
    try {
      const feed_addresses = feeds.map((feed) => feed.pubkey.toString());

      console.log(
        `[${new Date().toISOString()}]`,
        `Fetch the feeds ${feed_addresses}...`,
      );
      const fetch_start = Date.now();
      const [pullIx, luts] = await sb.PullFeed.fetchUpdateManyIx(swbProgram, {
        feeds,
        gateway: gateway.gatewayUrl,
        numSignatures: 1,
        payer: wallet.publicKey,
      });
      const fetch_elapsed = Date.now() - fetch_start;
      console.log(
        `[${new Date().toISOString()}]`,
        `Fetch completed in ${fetch_elapsed} ms.`,
      );

      const tx = await sb.asV0Tx({
        connection,
        ixs: pullIx,
        signers: [wallet.payer],
        computeUnitLimitMultiple: 2,
        lookupTables: luts,
      });

      console.log(
        `[${new Date().toISOString()}]`,
        `Submit the feed ${feed_addresses} Tx...`,
      );
      const submit_start = Date.now();
      const result = await sendAndConfirmRawTransaction(
        connection,
        Buffer.from(tx.serialize()),
        TX_CONFIG,
      );
      const submit_elapsed = Date.now() - submit_start;

      appendFileSync(
        OUTPUT_FILE,
        `${new Date().toISOString()}, ${feed_addresses}, ${fetch_elapsed}, ${submit_elapsed}, ${result}` +
          "\n",
      );
      console.log(
        `[${new Date().toISOString()}]`,
        `Submit completed in ${submit_elapsed} ms.`,
      );
    } catch (error) {
      errorCount++;
      console.error(
        `[${new Date().toISOString()}]`,
        `Error ${errorCount} occurred while cranking:`,
        error,
      );
    }
  }

  const pullFeeds = feeds.map((pubkey) => new sb.PullFeed(swbProgram, pubkey));

  appendFileSync(
    OUTPUT_FILE,
    `DateTime, Feed Address, Ix Fetch Time (ms), Tx Submit Time (ms), Tx Signature` +
      "\n",
  );

  let errorCount = 0;
  while (true) {
    if (crank_all) {
      await crank(pullFeeds);
    } else {
      for (const feed of pullFeeds) {
        await crank([feed]);
      }
    }
    await delay(CRANKING_DELAY * 1000);
  }
})();
