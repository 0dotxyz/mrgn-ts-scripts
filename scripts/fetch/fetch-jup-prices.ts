import dotenv from "dotenv";
import { appendFileSync, readFileSync } from "fs";
import fetch from "node-fetch";

const FETCH_URL =
  "https://lite-api.jup.ag/price/v3?ids={token},EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
console.log(`Fetch URL: ${FETCH_URL}`);

// Jup API rate limit is 60 requests per minute: https://dev.jup.ag/docs/api-rate-limit
const RATE_LIMIT = 60;

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const OUTPUT_FILE = `jup-prices-${timestamp}.csv`;
console.log(`Output file: ${OUTPUT_FILE}`);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The Swb Feeds file
if (!process.argv[2]) {
  console.error("❌ Missing the required Tokens file argument.");
  process.exit(1);
}
console.log(`Using Tokens file: ${process.argv[2]}`);
const tokens = new Map(
  Object.entries(dotenv.parse(readFileSync(process.argv[2], "utf8"))),
);

// The Simulation delay
const MIN_DELAY = RATE_LIMIT / tokens.size;
const FETCH_DELAY = process.argv[3] ? parseInt(process.argv[3]) : 10;
if (FETCH_DELAY < MIN_DELAY) {
  console.error(
    `❌ Fetch delay (${FETCH_DELAY} seconds) has to be greater than the minimum delay (${MIN_DELAY} seconds).`,
  );
  process.exit(1);
}
console.log(`Using the fetch delay: ${FETCH_DELAY} seconds`);

async function fetchPrice(token: string) {
  const response = await fetch(FETCH_URL.replace("{token}", token));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  // Prepare rows
  const rows = Object.entries(data).map(([mint, entry]: any) => [
    new Date().toISOString(), // when we fetched
    mint,
    entry.usdPrice,
    entry.blockId,
    entry.decimals,
    entry.priceChange24h,
  ]);

  const csvRows = rows.map((r) => r.join(",")) + "\n";
  appendFileSync(OUTPUT_FILE, csvRows);
}

const headers = [
  "fetchedAt",
  "mint",
  "usdPrice",
  "blockId",
  "decimals",
  "priceChange24h",
  "mint",
  "usdPrice",
  "blockId",
  "decimals",
  "priceChange24h",
];
appendFileSync(OUTPUT_FILE, headers.join(",") + "\n");

(async () => {
  let errorCount = 0;
  while (true) {
    console.log(`[${new Date().toISOString()}]`, `Fetching prices...`);
    const start = Date.now();
    try {
      for (const [_, token] of tokens) {
        await fetchPrice(token);
        await delay(1000);
      }
    } catch (error) {
      errorCount++;
      console.error(
        `[${new Date().toISOString()}]`,
        `Error ${errorCount} occurred while fetching feed data:`,
        error,
      );
    }
    const elapsed = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}]`,
      `Fetch completed in ${elapsed} ms.`,
    );

    await delay(FETCH_DELAY * 1000);
  }
})();
