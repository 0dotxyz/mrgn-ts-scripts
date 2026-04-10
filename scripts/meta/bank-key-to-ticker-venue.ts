import { formatBankTickerVenue } from "./bank-meta-utils";

async function main() {
  const bankKey = process.argv[2]?.trim();
  if (!bankKey) {
    console.error(
      "Usage: pnpm -s tsx scripts/meta/bank-key-to-ticker-venue.ts <BANK_KEY>",
    );
    process.exit(1);
  }

  console.log(formatBankTickerVenue(bankKey));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
