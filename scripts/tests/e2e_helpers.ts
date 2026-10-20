import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@mrgnlabs/mrgn-common";
import { appendFileSync, writeFileSync } from "fs";
import { commonSetup } from "../../lib/common-setup";
import { deriveLiquidationRecord } from "../common/pdas";

export type BalanceRequirement = {
  who: string;
  owner: PublicKey;
  label: string;
  mint: PublicKey;
  needed: BN;
};

/** Throws, before anything is sent, if either wallet is short of what the deposit steps will spend. */
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
    throw new Error("wallets are short of the tokens listed above; top up and re-run");
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

/**
 * A liquidated account cannot be closed until its liquidation record has sat inactive for 60 days
 * and been closed. Records the liquidatee and the time it becomes closable in
 * liquidatees_pending_closing.txt so the cleanup can be finished later.
 */
export async function dumpLiquidatee(
  programId: string,
  walletPath: string,
  liquidatee: PublicKey,
) {
  const { program } = commonSetup(true, programId, walletPath);
  const [liqRecordKey] = deriveLiquidationRecord(program.programId, liquidatee);
  const record: any = await program.account.liquidationRecord.fetchNullable(liqRecordKey);
  const lastLiquidation = (record?.entries ?? []).reduce(
    (max: number, entry: any) => Math.max(max, Number(entry.timestamp)),
    0,
  );
  const INACTIVITY_PERIOD_SECS = 60 * 24 * 60 * 60;
  const closableAfter = lastLiquidation > 0 ? lastLiquidation + INACTIVITY_PERIOD_SECS : 0;
  const closableAfterIso =
    closableAfter > 0 ? new Date(closableAfter * 1000).toISOString() : "now (never liquidated)";

  appendFileSync(
    "liquidatees_pending_closing.txt",
    `${liquidatee.toBase58()}\tlastLiquidation=${lastLiquidation}\t` +
      `closableAfter=${closableAfter}\tclosableAfterIso=${closableAfterIso}\n`,
  );
  console.log("LIQUIDATEE PENDING CLOSE (dumped to liquidatees_pending_closing.txt)");
  console.log("liquidatee:       " + liquidatee.toBase58());
  console.log("liq record:       " + liqRecordKey.toBase58());
  console.log("closable after:   " + closableAfterIso);
}

export function writeJsonFile(path: string, obj: any) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
  console.log(`✔ wrote ${path}`);
}
