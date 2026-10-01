import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@mrgnlabs/mrgn-common";
import { writeFileSync } from "fs";
import { commonSetup } from "../../lib/common-setup";

export type BalanceRequirement = {
  who: string;
  owner: PublicKey;
  label: string;
  mint: PublicKey;
  needed: BN;
};

/** Warns (does not throw) if either wallet is short of what the deposit steps will spend. */
export async function warnOnMissingBalances(
  programId: string,
  walletPath: string,
  reqs: BalanceRequirement[],
) {
  const { connection } = commonSetup(true, programId, walletPath);

  let allOk = true;
  for (const r of reqs) {
    if (r.needed.isZero()) continue;
    const mintInfo = await connection.getAccountInfo(r.mint);
    if (!mintInfo) {
      console.warn(`  ${r.label}: mint ${r.mint.toBase58()} not found`);
      allOk = false;
      continue;
    }
    const decimals = mintInfo.data[44];
    const ata = getAssociatedTokenAddressSync(
      r.mint,
      r.owner,
      true,
      mintInfo.owner,
    );
    const acc = await connection.getAccountInfo(ata);
    const have = acc
      ? new BN((await connection.getTokenAccountBalance(ata)).value.amount)
      : new BN(0);

    if (have.lt(r.needed)) {
      allOk = false;
      const short = r.needed.sub(have);
      console.warn(
        `  ${r.who} lacks ${toUi(short, decimals)} ${r.label} ` +
          `(mint: ${r.mint.toBase58()}) to run the script. Please top up.`,
      );
    } else {
      console.log(
        `  ${r.who} ${r.label}: has ${toUi(have, decimals)}, needs ${toUi(r.needed, decimals)}`,
      );
    }
  }
  if (!allOk) {
    console.warn("  ^ script will fail at the deposit steps until topped up");
  }
}

export function toUi(amount: BN, decimals: number): string {
  return (Number(amount.toString()) / 10 ** decimals)
    .toFixed(decimals)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

export function pkToString(pk: PublicKey | string): string {
  return typeof pk === "string" ? pk : pk.toBase58();
}

export function writeJsonFile(path: string, obj: any) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
  console.log(`✔ wrote ${path}`);
}
