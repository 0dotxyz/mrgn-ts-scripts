import fs from "fs";
import path from "path";

type BankMetaEntry = {
  ticker?: string;
  symbol?: string;
  venue?: string;
};

export type BankMetaSnapshot = {
  banks: Record<string, BankMetaEntry>;
};

export const SNAPSHOT_PATH = path.resolve(
  __dirname,
  "data/bank-meta-0xyz.snapshot.json",
);

let snapshotCache: BankMetaSnapshot | null = null;

export function loadBankMetaSnapshot(): BankMetaSnapshot {
  if (snapshotCache) return snapshotCache;

  const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
  snapshotCache = JSON.parse(raw) as BankMetaSnapshot;
  return snapshotCache;
}

export function clearBankMetaSnapshotCache(): void {
  snapshotCache = null;
}

function getSymbol(entry?: BankMetaEntry): string | null {
  const symbol = entry?.symbol?.trim();
  if (symbol) return symbol;

  const tickerFromTickerField = entry?.ticker?.split("|")[0]?.trim();
  return tickerFromTickerField || null;
}

export function formatBankTickerVenue(
  bankKey: string,
  snapshot = loadBankMetaSnapshot(),
): string {
  const entry = snapshot.banks[bankKey];
  if (!entry) return bankKey;

  const symbol = getSymbol(entry);
  const venue = entry.venue?.trim();

  if (symbol && venue) return `${symbol} - ${venue}`;
  if (symbol) return symbol;
  if (venue) return venue;
  return bankKey;
}

export function mapBankKeysToTickerVenue(
  bankKeys: string[],
  snapshot = loadBankMetaSnapshot(),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const bankKey of bankKeys) {
    out[bankKey] = formatBankTickerVenue(bankKey, snapshot);
  }
  return out;
}
