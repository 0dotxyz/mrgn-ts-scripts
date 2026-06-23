import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import Decimal from "decimal.js";

const MINT = "AZsHEMXd36Bj1EMNXhowJajpUXzrKcK57wW4ZGXVa7yR";
const FROM = 1781552400;
const TO = 1781553600;
const LIMIT = 1000;
const AGE = 600;
const WRITE_TO_FILE = false;
const LIQUIDATIONS_URL = "https://api.0.xyz/v0/liquidations";
const CSV_OUTPUT_DIR = "logs/liquidations";

type LiquidationAction = {
  action: string;
  mint: string;
  symbol?: string;
  amount?: string | number;
  amountUsd?: string | number;
  amountUSD?: string | number;
  bank?: string;
};

type LiquidationEvent = {
  type: string;
  signature: string;
  slot: number;
  blockTime: number;
  marginfiAccount: string;
  authority: string;
  actions: LiquidationAction[];
  liquidator?: string;
};

type LiquidationsResponse = {
  count?: number;
  events?: LiquidationEvent[];
};

type AuthoritySummary = {
  authority: string;
  amountSeized: Decimal;
  amountSeizedUsd: Decimal;
  count: number;
};

type EventTypeSummary = {
  type: string;
  symbols: Set<string>;
  matchingEvents: number;
  matchingActions: number;
  seizedActions: number;
  amountUsd: Decimal;
  amountSeized: Decimal;
  amountSeizedUsd: Decimal;
};

type CsvLiquidationRow = {
  signature: string;
  slot: number;
  blockTime: number;
  isoTime: string;
  authority: string;
  marginfiAccount: string;
  liquidator: string;
  amountLiquidated: string;
  amountLiquidatedUsd: string;
  liquidatedMint: string;
  liquidatedSymbol: string;
  collateralAmountSeized: string;
  collateralAmountSeizedUsd: string;
  collateralMint: string;
  collateralSymbol: string;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function toDecimal(value: string | number | undefined | null): Decimal {
  if (value == null || value === "") return new Decimal(0);
  return new Decimal(value);
}

function fmt(value: Decimal, dp = 6): string {
  if (value.isZero()) return "0";
  return value.toDecimalPlaces(dp).toString();
}

function fmtUsd(value: Decimal): string {
  if (value.isZero()) return "0";
  return value.toDecimalPlaces(2).toString();
}

function csvEscape(value: string | number): string {
  const str = String(value);
  if (!/[",\n\r]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function csvLine(values: Array<string | number>): string {
  return values.map(csvEscape).join(",");
}

function buildLiquidationsUrl(
  from: number,
  to: number,
  limit: number,
  age: number,
): string {
  const params = new URLSearchParams({
    from: from.toString(),
    to: to.toString(),
    limit: limit.toString(),
    age: age.toString(),
  });

  return `${LIQUIDATIONS_URL}?${params.toString()}`;
}

async function fetchLiquidations(from: number, to: number, limit: number, age: number) {
  const events: LiquidationEvent[] = [];
  const seenSignatures = new Set<string>();
  const saturatedRanges: Array<{ from: number; to: number; count: number }> = [];

  async function fetchRange(rangeFrom: number, rangeTo: number): Promise<void> {
    const url = buildLiquidationsUrl(rangeFrom, rangeTo, limit, age);
    const response = await getJson<LiquidationsResponse>(url);
    const pageEvents = response.events ?? [];

    if (pageEvents.length >= limit && rangeFrom < rangeTo) {
      const mid = Math.floor((rangeFrom + rangeTo) / 2);
      await fetchRange(mid + 1, rangeTo);
      await fetchRange(rangeFrom, mid);
      return;
    }

    if (pageEvents.length >= limit) {
      saturatedRanges.push({
        from: rangeFrom,
        to: rangeTo,
        count: pageEvents.length,
      });
    }

    for (const event of pageEvents) {
      if (seenSignatures.has(event.signature)) continue;
      seenSignatures.add(event.signature);
      events.push(event);
    }
  }

  await fetchRange(from, to);

  if (saturatedRanges.length > 0) {
    console.warn(
      "Warning: at least one one-second range hit the API limit; totals may be undercounted.",
    );
    console.table(saturatedRanges);
  }

  return events;
}

function actionAmount(action: LiquidationAction): string {
  return action.amount == null ? "" : String(action.amount);
}

function actionAmountUsd(action: LiquidationAction): string {
  return action.amountUsd == null && action.amountUSD == null
    ? ""
    : String(action.amountUsd ?? action.amountUSD);
}

function joinActionValues(
  actions: LiquidationAction[],
  getValue: (action: LiquidationAction) => string,
): string {
  return actions.map(getValue).filter(Boolean).join("; ");
}

function buildCsvRows(events: LiquidationEvent[], mint: string): CsvLiquidationRow[] {
  return events
    .map((event) => {
      const matchingActions = event.actions.filter((action) => action.mint === mint);
      if (matchingActions.length === 0) return null;

      const collateralActions = event.actions.filter(
        (action) => action.action === "collateral_seized",
      );
      const debtActions = event.actions.filter((action) => action.action === "debt_repaid");

      return {
        signature: event.signature,
        slot: event.slot,
        blockTime: event.blockTime,
        isoTime: new Date(event.blockTime * 1000).toISOString(),
        authority: event.authority,
        marginfiAccount: event.marginfiAccount,
        liquidator: event.liquidator ?? "",
        amountLiquidated: joinActionValues(debtActions, actionAmount),
        amountLiquidatedUsd: joinActionValues(debtActions, actionAmountUsd),
        liquidatedMint: joinActionValues(debtActions, (action) => action.mint),
        liquidatedSymbol: joinActionValues(debtActions, (action) => action.symbol ?? ""),
        collateralAmountSeized: joinActionValues(collateralActions, actionAmount),
        collateralAmountSeizedUsd: joinActionValues(collateralActions, actionAmountUsd),
        collateralMint: joinActionValues(collateralActions, (action) => action.mint),
        collateralSymbol: joinActionValues(collateralActions, (action) => action.symbol ?? ""),
      };
    })
    .filter((row): row is CsvLiquidationRow => row !== null)
    .sort((a, b) => b.blockTime - a.blockTime || b.slot - a.slot);
}

function writeLiquidationsCsv(events: LiquidationEvent[], mint: string): string {
  const rows = buildCsvRows(events, mint);
  const outputDir = path.join(process.cwd(), CSV_OUTPUT_DIR);
  mkdirSync(outputDir, { recursive: true });

  const fileName = `liquidations_${mint}_${FROM}_${TO}.csv`;
  const outputPath = path.join(outputDir, fileName);
  const headers: Array<keyof CsvLiquidationRow> = [
    "signature",
    "slot",
    "blockTime",
    "isoTime",
    "authority",
    "marginfiAccount",
    "liquidator",
    "amountLiquidated",
    "amountLiquidatedUsd",
    "liquidatedMint",
    "liquidatedSymbol",
    "collateralAmountSeized",
    "collateralAmountSeizedUsd",
    "collateralMint",
    "collateralSymbol",
  ];

  const lines = [
    csvLine([
      "query",
      `mint=${mint}`,
      `from=${FROM}`,
      `to=${TO}`,
      `limit=${LIMIT}`,
      `age=${AGE}`,
      `url=${buildLiquidationsUrl(FROM, TO, LIMIT, AGE)}`,
    ]),
    csvLine(headers),
    ...rows.map((row) => csvLine(headers.map((header) => row[header]))),
  ];

  writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  return outputPath;
}

async function main() {
  if (FROM > TO) {
    throw new Error("FROM must be less than or equal to TO");
  }

  const mint = MINT.trim();
  const events = await fetchLiquidations(FROM, TO, LIMIT, AGE);

  const csvPath = WRITE_TO_FILE ? writeLiquidationsCsv(events, mint) : null;
  const summariesByType = new Map<string, EventTypeSummary>();
  const authoritySummaries = new Map<string, AuthoritySummary>();

  for (const event of events) {
    let eventHasMatch = false;
    const summary = summariesByType.get(event.type) ?? {
      type: event.type,
      symbols: new Set<string>(),
      matchingEvents: 0,
      matchingActions: 0,
      seizedActions: 0,
      amountUsd: new Decimal(0),
      amountSeized: new Decimal(0),
      amountSeizedUsd: new Decimal(0),
    };

    for (const action of event.actions ?? []) {
      if (action.mint !== mint) continue;

      eventHasMatch = true;
      summary.matchingActions += 1;
      if (action.symbol) summary.symbols.add(action.symbol);

      const amountUsd = toDecimal(action.amountUsd ?? action.amountUSD);
      summary.amountUsd = summary.amountUsd.plus(amountUsd);

      if (action.action !== "collateral_seized") continue;

      summary.seizedActions += 1;
      const amount = toDecimal(action.amount);
      summary.amountSeized = summary.amountSeized.plus(amount);
      summary.amountSeizedUsd = summary.amountSeizedUsd.plus(amountUsd);

      const existing = authoritySummaries.get(event.authority) ?? {
        authority: event.authority,
        amountSeized: new Decimal(0),
        amountSeizedUsd: new Decimal(0),
        count: 0,
      };

      existing.amountSeized = existing.amountSeized.plus(amount);
      existing.amountSeizedUsd = existing.amountSeizedUsd.plus(amountUsd);
      existing.count += 1;
      authoritySummaries.set(event.authority, existing);
    }

    if (eventHasMatch) {
      summary.matchingEvents += 1;
      summariesByType.set(event.type, summary);
    }
  }

  const summaryRows = Array.from(summariesByType.values())
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((summary) => ({
      type: summary.type,
      symbol: Array.from(summary.symbols).join(", ") || "-",
      matchingEvents: summary.matchingEvents,
      matchingActions: summary.matchingActions,
      seizedActions: summary.seizedActions,
      amountUsd: fmtUsd(summary.amountUsd),
      amountSeized: fmt(summary.amountSeized),
      amountSeizedUsd: fmtUsd(summary.amountSeizedUsd),
    }));

  const authorityRows = Array.from(authoritySummaries.values())
    .sort((a, b) => b.amountSeizedUsd.cmp(a.amountSeizedUsd))
    .map((summary) => ({
      authority: summary.authority,
      "amount seized": fmt(summary.amountSeized),
      "amount seized usd": fmtUsd(summary.amountSeizedUsd),
      count: summary.count,
    }));

  console.log(`\nLiquidations for mint ${mint}`);
  console.log(`Window: ${FROM} to ${TO}`);
  console.log(`Fetched events: ${events.length}`);
  console.log(WRITE_TO_FILE ? `CSV: ${csvPath}` : "CSV: skipped");
  if (summaryRows.length > 0) {
    console.table(summaryRows);
  } else {
    console.log("No matching actions found for this mint.");
  }

  console.log("\nAuthority seized amounts");
  if (authorityRows.length > 0) {
    console.table(authorityRows);
  } else {
    console.log("No collateral_seized actions found for this mint.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
