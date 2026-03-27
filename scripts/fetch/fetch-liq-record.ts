import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { bytesToF64, formatNumber } from "../../lib/utils";

type Config = {
  PROGRAM_ID: string;
  LIQ_RECORD?: PublicKey;
  MARGINFI_ACCOUNT?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  // LIQ_RECORD: new PublicKey("..."),
  MARGINFI_ACCOUNT: new PublicKey("3JgMGpqb7YXDppz5iAzuUk8mXzHCA8Da7D3A8zt3F6mz"),
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.config/solana/id.json",
    undefined,
    "current",
  );
  const program = user.program;

  if (!config.LIQ_RECORD && !config.MARGINFI_ACCOUNT) {
    throw new Error("Set LIQ_RECORD or MARGINFI_ACCOUNT in config.");
  }

  const liqRecordKey =
    config.LIQ_RECORD ??
    deriveLiquidationRecord(program.programId, config.MARGINFI_ACCOUNT!);

  const record = await program.account.liquidationRecord.fetch(liqRecordKey);

  console.log("liquidation record: " + liqRecordKey.toString());
  console.log("marginfi account:  " + record.marginfiAccount.toString());
  console.log("record payer:      " + record.recordPayer.toString());
  console.log("liq receiver:      " + record.liquidationReceiver.toString());

  const entryRows = record.entries
    .map((entry, index) => {
      const assetSeized = bytesToF64(entry.assetAmountSeized);
      const liabRepaid = bytesToF64(entry.liabAmountRepaid);
      const timestamp = toNumber(entry.timestamp);
      return {
        Index: index,
        "Asset Seized ($)": formatF64(assetSeized),
        "Liab Repaid ($)": formatF64(liabRepaid),
        Timestamp: timestamp,
        ISO: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : "-",
      };
    })
    .filter(
      (row) =>
        row.Timestamp !== 0 ||
        row["Asset Seized ($)"] !== "-" ||
        row["Liab Repaid ($)"] !== "-",
    );

  if (entryRows.length > 0) {
    console.log("Entries:");
    console.table(entryRows);
  } else {
    console.log("Entries: none");
  }

  const cache = record.cache;
  console.log("Cache:");
  console.table([
    {
      Metric: "Asset Value Maint",
      Value: formatNumber(wrappedI80F48toBigNumber(cache.assetValueMaint)),
    },
    {
      Metric: "Liability Value Maint",
      Value: formatNumber(wrappedI80F48toBigNumber(cache.liabilityValueMaint)),
    },
    {
      Metric: "Asset Value Equity",
      Value: formatNumber(wrappedI80F48toBigNumber(cache.assetValueEquity)),
    },
    {
      Metric: "Liability Value Equity",
      Value: formatNumber(wrappedI80F48toBigNumber(cache.liabilityValueEquity)),
    },
  ]);
}

function formatF64(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "-";
  const fixed = value.toFixed(4);
  return fixed === "0.0000" ? "-" : fixed;
}

function toNumber(value: any): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value.toNumber === "function") return value.toNumber();
  return Number(value);
}

const deriveLiquidationRecord = (
  programId: PublicKey,
  marginfiAccount: PublicKey,
): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liq_record", "utf-8"), marginfiAccount.toBuffer()],
    programId,
  )[0];
};

main().catch((err) => {
  console.error(err);
});
