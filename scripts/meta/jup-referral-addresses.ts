import { PublicKey } from "@solana/web3.js";

const REFERRAL_PROGRAM_ID = new PublicKey(
  "REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3",
);
const REFERRAL_ACCOUNT_PUBKEY = new PublicKey(
  "Mm7HcujSK2JzPW4eX7g4oqTXbWYDuFxapNMHXe8yp1B",
);

type BankDbEntry = {
  mint: string;
  symbol: string;
  asset_tag: number;
};

function getJupReferralFeeAccount(mint: PublicKey): string {
  const [feeAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("referral_ata"),
      REFERRAL_ACCOUNT_PUBKEY.toBuffer(),
      mint.toBuffer(),
    ],
    REFERRAL_PROGRAM_ID,
  );
  return feeAccount.toBase58();
}

async function main() {
  const apiResponse = await fetch("https://app.0.xyz/api/banks/db");
  const bankDb = (await apiResponse.json()) as BankDbEntry[];

  const rows = bankDb
    .filter((entry) => entry.asset_tag !== 2)
    .map((entry) => {
      const mint = new PublicKey(entry.mint);
      return {
        Symbol: entry.symbol,
        Mint: entry.mint,
        "Jup Referral Key": getJupReferralFeeAccount(mint),
      };
    });

  // Sort alphabetically by symbol
  rows.sort((a, b) => a.Symbol.localeCompare(b.Symbol));

  console.log(`\nFound ${rows.length} banks\n`);
  console.table(rows);
}

main().catch((err) => {
  console.error(err);
});
