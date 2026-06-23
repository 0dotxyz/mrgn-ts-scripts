type Bank = {
  address: string;
  tokenSymbol?: string | null;
  mint: string;
  config?: {
    riskTier?: string;
    oracleSetup?: string;
    operationalState?: string;
  };
};

type BankBalance = {
  bank: string;
  tokenSymbol?: string | null;
  mint: string;
  decimals: number;
  depositedNative: string;
  borrowedNative: string;
  multiplier?: string;
  isIntegrationBank?: boolean;
};

type RealPriceEntry = {
  oraclePrice?: {
    priceRealtime?: {
      price?: string;
    };
  };
  source?: string;
  symbol?: string;
  mint?: string;
};

type Row = {
  symbol: string;
  bank: string;
  mint: string;
  oracleSetup: string;
  op: string;
  price: number;
  depositedToken: number;
  depositedUsd: number;
  borrowedToken: number;
  borrowedUsd: number;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

function toNum(value: string | number | undefined | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nativeToTokenAmount(nativeAmount: string, decimals: number): number {
  return toNum(nativeAmount) / 10 ** decimals;
}

function fmt4(n: number): string {
  return n.toFixed(4);
}

function shortOracleSetup(oracleSetup: string | undefined): string {
  const map: Record<string, string> = {
    None: "None",
    PythLegacy: "PythLgcy",
    SwitchboardV2: "SwbV2",
    PythPushOracle: "PythPush",
    SwitchboardPull: "SwbPull",
    StakedWithPythPush: "StkPyth",
    KaminoPythPush: "KamPyth",
    KaminoSwitchboardPull: "KamSwb",
    Fixed: "Fixed",
    DriftPythPull: "DriftPyth",
    DriftSwitchboardPull: "DriftSwb",
    SolendPythPull: "SolendPyth",
    SolendSwitchboardPull: "SolendSwb",
    FixedKamino: "FixKam",
    FixedDrift: "FixDrift",
    JuplendPythPull: "JupPyth",
    JuplendSwitchboardPull: "JupSwb",
    FixedJuplend: "FixJup",
  };

  return map[oracleSetup ?? ""] ?? oracleSetup ?? "";
}

function shortOp(op: string | undefined): string {
  const map: Record<string, string> = {
    Operational: "Op",
    Paused: "Paused",
    ReduceOnly: "Reduce",
    KilledByBankruptcy: "Killed",
  };

  return map[op ?? ""] ?? op ?? "";
}

function toTableRows(rows: Row[]) {
  return rows.map((r) => ({
    symbol: r.symbol,
    op: shortOp(r.op),
    oracle: shortOracleSetup(r.oracleSetup),
    price: fmt4(r.price),
    depTok: fmt4(r.depositedToken),
    depUsd: fmt4(r.depositedUsd),
    borTok: fmt4(r.borrowedToken),
    borUsd: fmt4(r.borrowedUsd),
    bank: r.bank,
  }));
}

async function main() {
  const age = 60;

  const [bankCache, bankBalances, realPrice] = await Promise.all([
    getJson<{ banks?: Bank[] }>(`https://api.0.xyz/v0/bankCache?age=${age}`),
    getJson<{ banks?: BankBalance[] }>(`https://api.0.xyz/v0/bankBalances?age=${age}`),
    getJson<{ prices?: Record<string, RealPriceEntry> }>(
      `https://api.0.xyz/v0/realprice?age=${age}`
    ),
  ]);

  const balancesByBank = new Map(
    (bankBalances.banks ?? []).map((b) => [b.bank, b])
  );

  const pricesByBank = realPrice.prices ?? {};

  const isolatedRows: Row[] = (bankCache.banks ?? [])
    .filter((bank) => bank.config?.riskTier === "Isolated")
    .map((bank) => {
      const balance = balancesByBank.get(bank.address);
      const price = toNum(
        pricesByBank[bank.address]?.oraclePrice?.priceRealtime?.price
      );

      const depositedToken = balance
        ? nativeToTokenAmount(balance.depositedNative, balance.decimals)
        : 0;

      const borrowedToken = balance
        ? nativeToTokenAmount(balance.borrowedNative, balance.decimals)
        : 0;

      return {
        symbol:
          bank.tokenSymbol ??
          balance?.tokenSymbol ??
          pricesByBank[bank.address]?.symbol ??
          "",
        bank: bank.address,
        mint: bank.mint,
        oracleSetup: bank.config?.oracleSetup ?? "",
        op: bank.config?.operationalState ?? "",
        price,
        depositedToken,
        depositedUsd: depositedToken * price,
        borrowedToken,
        borrowedUsd: borrowedToken * price,
      };
    });

  const activeNonFixedRows = isolatedRows
    .filter((r) => r.op === "Operational" && r.oracleSetup !== "Fixed")
    .sort((a, b) => b.depositedUsd - a.depositedUsd);

  const otherIsolatedRows = isolatedRows
    .filter((r) => !(r.op === "Operational" && r.oracleSetup !== "Fixed"))
    .sort((a, b) => b.depositedUsd - a.depositedUsd);

  console.log("\nIsolated / Operational / Non-Fixed oracle");
  console.table(toTableRows(activeNonFixedRows));

  console.log("\nOther Isolated banks");
  console.table(toTableRows(otherIsolatedRows));

  const sum = (rows: Row[]) =>
    rows.reduce(
      (acc, r) => {
        acc.depositedUsd += r.depositedUsd;
        acc.borrowedUsd += r.borrowedUsd;
        return acc;
      },
      { depositedUsd: 0, borrowedUsd: 0 }
    );

  const activeTotals = sum(activeNonFixedRows);
  const otherTotals = sum(otherIsolatedRows);

  console.log("\nTotals");
  console.table([
    {
      table: "activeNonFixed",
      count: activeNonFixedRows.length,
      depUsd: fmt4(activeTotals.depositedUsd),
      borUsd: fmt4(activeTotals.borrowedUsd),
    },
    {
      table: "otherIsolated",
      count: otherIsolatedRows.length,
      depUsd: fmt4(otherTotals.depositedUsd),
      borUsd: fmt4(otherTotals.borrowedUsd),
    },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});