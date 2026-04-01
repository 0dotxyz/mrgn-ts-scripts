import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  WALLET_PATH: string;
  INPUT_PATH: string;
  OUTPUT_PATH?: string;
  META_PATH?: string;
};

type AccountJson = {
  publicKey: string;
  balances: BalanceJson[];
};

type BalanceJson = {
  balanceIndex: number;
  bankPk: string;
  tag: number;
  assetShares: string;
  liabilityShares: string;
  hasEmissions: boolean;
};

type BankMeta = {
  mintDecimals: number;
  assetShareValue: number;
  liabilityShareValue: number;
  cachedPrice: number;
};

type Position = {
  bankLabel: string;
  tokens: number;
  usd: number;
};

type MetaBankInfo = {
  ticker?: string;
  symbol?: string;
  venue?: string;
};

type MetaFile = {
  banks?: Record<string, MetaBankInfo>;
};

const MAX_ASSETS = 16;
const MAX_LIABS = 15;

const DEFAULT_PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const DEFAULT_WALLET_PATH = "/.config/solana/id.json";
const DEFAULT_INPUT =
  "logs/2D1dc9jo8CNjgVG4qTKpRuGA83zrXv9iuSHV9BWZ7Js9_accounts.json";
const DEFAULT_META_PATH = "logs/meta/metacachedAt1775063812546.json";

function parseArgs(): Config {
  const args = process.argv.slice(2);

  let inputPath = DEFAULT_INPUT;
  let outputPath: string | undefined;
  let programId = DEFAULT_PROGRAM_ID;
  let walletPath = DEFAULT_WALLET_PATH;
  let metaPath: string | undefined;

  for (const arg of args) {
    if (arg.startsWith("--output=")) {
      outputPath = arg.slice("--output=".length);
      continue;
    }
    if (arg.startsWith("--program-id=")) {
      programId = arg.slice("--program-id=".length);
      continue;
    }
    if (arg.startsWith("--wallet=")) {
      walletPath = arg.slice("--wallet=".length);
      continue;
    }
    if (arg.startsWith("--meta=")) {
      metaPath = arg.slice("--meta=".length);
      continue;
    }
    inputPath = arg;
  }

  return {
    PROGRAM_ID: programId,
    WALLET_PATH: walletPath,
    INPUT_PATH: inputPath,
    OUTPUT_PATH: outputPath,
    META_PATH: metaPath,
  };
}

function resolveInputPath(inputPath: string): string {
  const resolved = path.isAbsolute(inputPath)
    ? inputPath
    : path.join(process.cwd(), inputPath);
  if (fs.existsSync(resolved)) return resolved;

  if (!resolved.endsWith(".json")) {
    const withJson = `${resolved}.json`;
    if (fs.existsSync(withJson)) return withJson;
  }

  throw new Error(`Input file not found: ${resolved}`);
}

function resolveOptionalPath(filePath: string): string | undefined {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  if (fs.existsSync(resolved)) return resolved;

  if (!resolved.endsWith(".json")) {
    const withJson = `${resolved}.json`;
    if (fs.existsSync(withJson)) return withJson;
  }

  return undefined;
}

function findLatestMetaPath(metaDirPath: string): string | undefined {
  if (!fs.existsSync(metaDirPath)) return undefined;

  const files = fs
    .readdirSync(metaDirPath)
    .filter((f) => /^metacachedAt\d+\.json$/.test(f));
  if (files.length === 0) return undefined;

  let bestFile = files[0];
  let bestTs = Number((files[0].match(/\d+/) ?? ["0"])[0]);
  for (const file of files.slice(1)) {
    const ts = Number((file.match(/\d+/) ?? ["0"])[0]);
    if (ts > bestTs) {
      bestTs = ts;
      bestFile = file;
    }
  }
  return path.join(metaDirPath, bestFile);
}

function parseShare(raw: string): number {
  const normalized = raw.trim();
  if (normalized === "-" || normalized.length === 0) return 0;
  const parsed = Number(normalized.replace(/,/g, ""));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid share value: ${raw}`);
  }
  return parsed;
}

function getCachedBankPrice(bankAcc: any): number {
  const oracleSetup = bankAcc?.config?.oracleSetup ?? {};
  if (Object.prototype.hasOwnProperty.call(oracleSetup, "fixed")) {
    return wrappedI80F48toBigNumber(bankAcc.config.fixedPrice).toNumber();
  }
  return wrappedI80F48toBigNumber(bankAcc.cache.lastOraclePrice).toNumber();
}

function convertSharesToTokens(
  shares: number,
  shareValue: number,
  mintDecimals: number,
): number {
  return (shares * shareValue) / Math.pow(10, mintDecimals);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatToken(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(8);
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(2);
}

function getTickerVenueLabel(bankPk: string, meta?: MetaBankInfo): string {
  if (!meta) return bankPk;

  const symbol = meta.symbol?.trim();
  const tickerFromTickerField = meta.ticker?.split("|")[0]?.trim();
  const ticker = symbol || tickerFromTickerField;
  const venue = meta.venue?.trim();

  if (ticker && venue) {
    return `${ticker}-${venue}`;
  }
  if (ticker) return ticker;
  return bankPk;
}

function positionColumns(
  positions: Position[],
  maxCount: number,
  tokenFormatter: (value: number) => string,
  usdFormatter: (value: number) => string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < maxCount; i++) {
    const p = positions[i];
    if (!p) {
      out.push("", "", "");
      continue;
    }
    out.push(p.bankLabel, tokenFormatter(p.tokens), usdFormatter(p.usd));
  }
  return out;
}

async function main() {
  const config = parseArgs();
  const inputPath = resolveInputPath(config.INPUT_PATH);
  const outputPath =
    config.OUTPUT_PATH === undefined
      ? path.join(
          path.dirname(inputPath),
          `${path.basename(inputPath, path.extname(inputPath))}_table.csv`,
        )
      : path.isAbsolute(config.OUTPUT_PATH)
        ? config.OUTPUT_PATH
        : path.join(process.cwd(), config.OUTPUT_PATH);

  const raw = fs.readFileSync(inputPath, "utf8");
  const accounts = JSON.parse(raw) as AccountJson[];

  let metaPath: string | undefined;
  if (config.META_PATH) {
    metaPath = resolveOptionalPath(config.META_PATH);
    if (!metaPath) {
      throw new Error(`Meta file not found: ${config.META_PATH}`);
    }
  } else {
    metaPath = resolveOptionalPath(DEFAULT_META_PATH);
  }

  if (!metaPath) {
    metaPath = findLatestMetaPath(path.join(process.cwd(), "logs/meta"));
  }

  const metaByBankPk: Record<string, MetaBankInfo> = {};
  if (metaPath) {
    const metaRaw = fs.readFileSync(metaPath, "utf8");
    const parsed = JSON.parse(metaRaw) as MetaFile;
    if (parsed.banks && typeof parsed.banks === "object") {
      Object.assign(metaByBankPk, parsed.banks);
      console.log(`Using meta labels from ${metaPath}`);
    }
  }

  const allBankPks = new Set<string>();
  for (const account of accounts) {
    for (const balance of account.balances) {
      allBankPks.add(balance.bankPk);
    }
  }

  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    config.WALLET_PATH,
    undefined,
  );
  const program = user.program;

  const bankKeys = Array.from(allBankPks).map((pk) => new PublicKey(pk));
  const bankAccounts = await program.account.bank.fetchMultiple(bankKeys);
  const bankMetaByPk: Record<string, BankMeta> = {};

  for (let i = 0; i < bankAccounts.length; i++) {
    const bankAcc = bankAccounts[i];
    if (!bankAcc) continue;
    const bankPk = bankKeys[i].toBase58();
    bankMetaByPk[bankPk] = {
      mintDecimals: bankAcc.mintDecimals,
      assetShareValue: wrappedI80F48toBigNumber(bankAcc.assetShareValue).toNumber(),
      liabilityShareValue: wrappedI80F48toBigNumber(
        bankAcc.liabilityShareValue,
      ).toNumber(),
      cachedPrice: getCachedBankPrice(bankAcc),
    };
  }

  const headers: string[] = ["user"];
  for (let i = 1; i <= MAX_ASSETS; i++) {
    headers.push(`asset_${i}_bank`, `asset_${i}_tokens`, `asset_${i}_usd`);
  }
  for (let i = 1; i <= MAX_LIABS; i++) {
    headers.push(`liab_${i}_bank`, `liab_${i}_tokens`, `liab_${i}_usd`);
  }
  headers.push("total_assets_usd", "total_liabs_usd", "net_health_usd");

  const rows: string[][] = [headers];

  for (const account of accounts) {
    const assets: Position[] = [];
    const liabs: Position[] = [];

    for (const balance of account.balances) {
      const bankMeta = bankMetaByPk[balance.bankPk];
      if (!bankMeta) continue;

      const assetShares = parseShare(balance.assetShares);
      const liabShares = parseShare(balance.liabilityShares);

      if (assetShares > 0) {
        const tokens = convertSharesToTokens(
          assetShares,
          bankMeta.assetShareValue,
          bankMeta.mintDecimals,
        );
        assets.push({
          bankLabel: getTickerVenueLabel(balance.bankPk, metaByBankPk[balance.bankPk]),
          tokens,
          usd: tokens * bankMeta.cachedPrice,
        });
      }

      if (liabShares > 0) {
        const tokens = convertSharesToTokens(
          liabShares,
          bankMeta.liabilityShareValue,
          bankMeta.mintDecimals,
        );
        liabs.push({
          bankLabel: getTickerVenueLabel(balance.bankPk, metaByBankPk[balance.bankPk]),
          tokens,
          usd: tokens * bankMeta.cachedPrice,
        });
      }
    }

    const totalAssetsUsd = assets.reduce((sum, p) => sum + p.usd, 0);
    const totalLiabsUsd = liabs.reduce((sum, p) => sum + p.usd, 0);
    const netHealthUsd = totalAssetsUsd - totalLiabsUsd;

    const row = [
      account.publicKey,
      ...positionColumns(assets, MAX_ASSETS, formatToken, formatUsd),
      ...positionColumns(liabs, MAX_LIABS, formatToken, formatUsd),
      formatUsd(totalAssetsUsd),
      formatUsd(totalLiabsUsd),
      formatUsd(netHealthUsd),
    ];

    rows.push(row);
  }

  const csv = rows
    .map((row) => row.map((v) => csvEscape(v)).join(","))
    .join("\n");

  fs.writeFileSync(outputPath, `${csv}\n`);
  console.log(`Wrote CSV for ${accounts.length} users to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
