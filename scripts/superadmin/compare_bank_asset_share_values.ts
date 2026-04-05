import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

type BankRow = {
  address: string;
  tokenSymbol?: string;
  assetShareValue?: string;
};

type BankCache = {
  banks: BankRow[];
};

function loadBankCache(path: string): BankCache {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as BankCache;

  if (!parsed || !Array.isArray(parsed.banks)) {
    throw new Error(`Invalid bank cache format: ${path}`);
  }

  return parsed;
}

function toMapByAddress(rows: BankRow[]): Map<string, BankRow> {
  const out = new Map<string, BankRow>();
  for (const row of rows) {
    if (!row.address) continue;
    out.set(row.address, row);
  }
  return out;
}

function loadPriorityBankKeysFromCsv(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();

  // Expect header with first column "bank"; skip first row.
  for (let i = 1; i < lines.length; i++) {
    const firstCol = lines[i].split(",")[0]?.trim() ?? "";
    if (!firstCol || seen.has(firstCol)) {
      continue;
    }
    seen.add(firstCol);
    out.push(firstCol);
  }

  return out;
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) {
    return `"${v.replace(/"/g, "\"\"")}"`;
  }
  return v;
}

function computePctDiff(pre: string | undefined, after: string | undefined): string {
  if (pre == null || after == null || pre === "" || after === "") {
    return "";
  }

  const preNum = Number(pre);
  const afterNum = Number(after);

  if (!Number.isFinite(preNum) || !Number.isFinite(afterNum)) {
    return "";
  }

  if (preNum === 0) {
    return afterNum === 0 ? "0" : "";
  }

  return (((afterNum - preNum) / preNum) * 100).toFixed(8);
}

function buildCsvLines(
  addresses: string[],
  preByAddress: Map<string, BankRow>,
  afterByAddress: Map<string, BankRow>,
): string[] {
  const lines: string[] = [
    [
      "bank_key",
      "ticker",
      "asset_share_value_pre_pause",
      "asset_share_value_after_delev",
      "pct_diff",
    ].join(","),
  ];

  for (const address of addresses) {
    const preRow = preByAddress.get(address);
    const afterRow = afterByAddress.get(address);

    const ticker = afterRow?.tokenSymbol ?? preRow?.tokenSymbol ?? "";
    const preAsv = preRow?.assetShareValue ?? "";
    const afterAsv = afterRow?.assetShareValue ?? "";
    const pctDiff = computePctDiff(preAsv, afterAsv);

    lines.push(
      [
        csvEscape(address),
        csvEscape(ticker),
        csvEscape(preAsv),
        csvEscape(afterAsv),
        csvEscape(pctDiff),
      ].join(","),
    );
  }

  return lines;
}

function main() {
  const prePath = resolve(process.argv[2] ?? "scripts/superadmin/bankCachePrepause.md");
  const afterPath = resolve(process.argv[3] ?? "scripts/superadmin/bankCacheAfterDelev.md");
  const prioritySourceCsvPath = resolve(
    process.argv[4] ?? "scripts/superadmin/super_admin_table.csv",
  );
  const outPriorityPath = resolve(
    process.argv[5] ?? "scripts/superadmin/bank_asset_share_value_diff_priority.csv",
  );
  const outOtherPath = resolve(
    process.argv[6] ?? "scripts/superadmin/bank_asset_share_value_diff_other.csv",
  );

  const pre = loadBankCache(prePath);
  const after = loadBankCache(afterPath);

  const preByAddress = toMapByAddress(pre.banks);
  const afterByAddress = toMapByAddress(after.banks);

  const allAddresses = Array.from(
    new Set([...preByAddress.keys(), ...afterByAddress.keys()]),
  ).sort();
  const allAddressSet = new Set(allAddresses);

  const priorityAddresses = loadPriorityBankKeysFromCsv(prioritySourceCsvPath).filter(
    (addr) => allAddressSet.has(addr),
  );
  const priorityAddressSet = new Set(priorityAddresses);
  const otherAddresses = allAddresses.filter((addr) => !priorityAddressSet.has(addr));

  const priorityLines = buildCsvLines(priorityAddresses, preByAddress, afterByAddress);
  const otherLines = buildCsvLines(otherAddresses, preByAddress, afterByAddress);

  let missingPre = 0;
  let missingAfter = 0;
  for (const address of allAddresses) {
    const preRow = preByAddress.get(address);
    const afterRow = afterByAddress.get(address);
    if (!preRow) missingPre++;
    if (!afterRow) missingAfter++;
  }

  writeFileSync(outPriorityPath, `${priorityLines.join("\n")}\n`, "utf8");
  writeFileSync(outOtherPath, `${otherLines.join("\n")}\n`, "utf8");

  console.log(`Priority source: ${prioritySourceCsvPath}`);
  console.log(`Wrote ${priorityAddresses.length} priority rows: ${outPriorityPath}`);
  console.log(`Wrote ${otherAddresses.length} other rows: ${outOtherPath}`);
  console.log(`Total banks across caches: ${allAddresses.length}`);
  console.log(`Prepause banks: ${preByAddress.size}`);
  console.log(`AfterDelev banks: ${afterByAddress.size}`);
  console.log(`Missing in prepause: ${missingPre}`);
  console.log(`Missing in afterDelev: ${missingAfter}`);
}

if (require.main === module) {
  main();
}
