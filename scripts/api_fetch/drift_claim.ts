import { readFileSync } from "fs";
import { join } from "path";
import { PublicKey } from "@solana/web3.js";

const BANK_CACHE_URL = "https://api.0.xyz/v0/bankCache";
// Note: Must be signed into Vercel (any account) to hit this
const DRIFT_ALLOCATIONS_URL = "https://beta.dfx.drift.trade/api/allocations";
const DRIFT_CLAIMS_PATH = join(__dirname, "drift_claims.json");
const MARGINFI_PROGRAM_ID = new PublicKey(
  process.env.MARGINFI_PROGRAM_ID ??
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
);
const ASSET_TAG_DRIFT = 4;
const LIQUIDITY_VAULT_AUTHORITY_SEED = "liquidity_vault_auth";

const printUrl = true;

type BankConfig = {
  assetTag?: number;
  asset_tag?: number;
};

type Bank = {
  address?: string;
  bank?: string;
  tokenSymbol?: string | null;
  token_symbol?: string | null;
  config?: BankConfig;
  assetTag?: number;
  asset_tag?: number;
};

type BankCacheResponse = {
  banks?: Bank[];
};

type DriftClaimRow = {
  symbol: string;
  bank: string;
  liquidityVaultAuthority: string;
  amountUnlocked: string;
  claimsPortal: string;
};

type DriftClaim = {
  claimant: string;
  mint: string;
  symbol: string;
  amount_unlocked: string;
  amount_locked: string;
};

async function getJson<T>(
  url: string,
  options?: Parameters<typeof fetch>[1],
): Promise<T> {
  const res = await fetch(url, options);
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`GET ${url} failed: ${res.status} ${body}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `GET ${url} returned ${contentType || "unknown content type"}: ${body.slice(
        0,
        200,
      )}`,
    );
  }

  return JSON.parse(body) as T;
}

function getBankAddress(bank: Bank): string | undefined {
  return bank.address ?? bank.bank;
}

function getAssetTag(bank: Bank): number | undefined {
  return (
    bank.config?.assetTag ??
    bank.config?.asset_tag ??
    bank.assetTag ??
    bank.asset_tag
  );
}

function deriveLiquidityVaultAuthority(bank: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(LIQUIDITY_VAULT_AUTHORITY_SEED, "utf-8"), bank.toBuffer()],
    MARGINFI_PROGRAM_ID,
  )[0];
}

function getClaimsPortalUrl(liquidityVaultAuthority: string): string {
  return `${DRIFT_ALLOCATIONS_URL}/${liquidityVaultAuthority}`;
}

function loadDriftClaims(): Map<string, DriftClaim> {
  const claims = JSON.parse(
    readFileSync(DRIFT_CLAIMS_PATH, "utf-8"),
  ) as DriftClaim[];

  return new Map(claims.map((claim) => [claim.claimant, claim]));
}

function parseAmount(value: string | undefined): bigint {
  return value == null || value === "" ? 0n : BigInt(value);
}

async function main() {
  const [bankCache, driftClaimsByClaimant] = await Promise.all([
    getJson<BankCacheResponse>(BANK_CACHE_URL),
    Promise.resolve(loadDriftClaims()),
  ]);

  const rows: DriftClaimRow[] = (bankCache.banks ?? [])
    .filter((bank) => getAssetTag(bank) === ASSET_TAG_DRIFT)
    .map((bank) => {
      const bankAddress = getBankAddress(bank);
      if (!bankAddress) {
        throw new Error(
          `Drift bank is missing address: ${JSON.stringify(bank)}`,
        );
      }

      const bankPublicKey = new PublicKey(bankAddress);
      const liquidityVaultAuthority =
        deriveLiquidityVaultAuthority(bankPublicKey);
      const liquidityVaultAuthorityAddress = liquidityVaultAuthority.toBase58();
      const claim = driftClaimsByClaimant.get(liquidityVaultAuthorityAddress);

      return {
        symbol: bank.tokenSymbol ?? bank.token_symbol ?? "",
        bank: bankPublicKey.toBase58(),
        liquidityVaultAuthority: liquidityVaultAuthorityAddress,
        amountUnlocked: claim?.amount_unlocked ?? "0",
        claimsPortal: printUrl
          ? getClaimsPortalUrl(liquidityVaultAuthorityAddress)
          : "-",
      };
    })
    .sort(
      (a, b) =>
        a.symbol.localeCompare(b.symbol) || a.bank.localeCompare(b.bank),
    );

  const amountUnlockedSum = rows.reduce(
    (acc, row) => acc + parseAmount(row.amountUnlocked),
    0n,
  );

  console.log(`\nDrift banks (${rows.length})`);
  console.table(rows);

  console.log("\nTotals");
  console.table([
    {
      rows: rows.length,
      amountUnlocked: amountUnlockedSum.toString(),
    },
  ]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
