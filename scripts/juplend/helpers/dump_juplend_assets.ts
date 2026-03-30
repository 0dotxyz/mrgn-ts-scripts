/**
 * Fetches all JupLend lending pools on-chain, derives PDAs,
 * resolves token symbols, and writes juplend-assets.json.
 *
 * Usage: npx tsx scripts/juplend/dumps/dump_juplend_assets.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import {
  JUPLEND_LENDING_PROGRAM_ID,
  findJuplendLendingAdminPda,
  findJuplendFTokenMintPda,
  findJuplendLendingPda,
} from "../lib/utils";
import { DEFAULT_API_URL, loadEnvFile } from "../../utils";

// Known token symbols by mint address
const KNOWN_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "WSOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr: "EURC",
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH": "USDG",
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: "USDS",
  "8smindLdDuySY6i2bStQX9o8DVhALCXCMbNxD98unx35": "USDV",
  DghpMkatCiUsofbTmid3M3kAbDTPqDwKiYHnudXeGG52: "EURCV",
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD: "JUPUSD",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: "bSOL",
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": "stSOL",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": "JLP",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: "RENDER",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "WETH",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: "HNT",
};

// Lending account layout (196 bytes):
//   discriminator: 8 bytes  @ 0
//   mint:          pubkey   @ 8
//   fTokenMint:    pubkey   @ 40
//   lendingId:     u16      @ 72
//   decimals:      u8       @ 74

function pubkeyAt(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.slice(offset, offset + 32));
}

type ParsedLending = {
  address: string;
  mint: string;
  fTokenMint: string;
  lendingId: number;
  decimals: number;
};

function parseLendingAccount(
  address: PublicKey,
  data: Buffer,
): ParsedLending {
  return {
    address: address.toString(),
    mint: pubkeyAt(data, 8).toString(),
    fTokenMint: pubkeyAt(data, 40).toString(),
    lendingId: data.readUInt16LE(72),
    decimals: data[74],
  };
}

async function main() {
  loadEnvFile(".env.api");
  const rpcUrl = process.env.API_URL || DEFAULT_API_URL;
  const connection = new Connection(rpcUrl, "confirmed");

  console.log("RPC:", rpcUrl.slice(0, 40) + "...");
  console.log(
    "Fetching lending accounts from",
    JUPLEND_LENDING_PROGRAM_ID.toString(),
    "...\n",
  );

  const rawAccounts = await connection.getProgramAccounts(
    JUPLEND_LENDING_PROGRAM_ID,
    { filters: [{ dataSize: 196 }] },
  );

  console.log(
    `Found ${rawAccounts.length} lending pools\n`,
  );

  const pools = rawAccounts.map((acc) =>
    parseLendingAccount(acc.pubkey, acc.account.data),
  );
  pools.sort((a, b) => a.lendingId - b.lendingId);

  // Derive global lendingAdmin PDA
  const [lendingAdmin] = findJuplendLendingAdminPda();

  // Build assets array with PDA verification
  const assets: {
    symbol: string;
    lending: string;
    fTokenMint: string;
    mint: string;
  }[] = [];

  let pdaMismatches = 0;

  for (const pool of pools) {
    const mint = new PublicKey(pool.mint);

    // Verify fTokenMint PDA
    const [derivedFToken] = findJuplendFTokenMintPda(mint);
    const fTokenMatch =
      derivedFToken.toString() === pool.fTokenMint;

    // Verify lending PDA
    const fTokenMint = new PublicKey(pool.fTokenMint);
    const [derivedLending] = findJuplendLendingPda(
      mint,
      fTokenMint,
    );
    const lendingMatch =
      derivedLending.toString() === pool.address;

    const symbol =
      KNOWN_SYMBOLS[pool.mint] ||
      pool.mint.slice(0, 8) + "...";

    if (!fTokenMatch) {
      pdaMismatches++;
      console.log(
        `WARNING: ${symbol} fTokenMint PDA mismatch`,
      );
      console.log(
        `  on-chain: ${pool.fTokenMint}`,
      );
      console.log(
        `  derived:  ${derivedFToken.toString()}`,
      );
    }
    if (!lendingMatch) {
      pdaMismatches++;
      console.log(
        `WARNING: ${symbol} lending PDA mismatch`,
      );
      console.log(`  on-chain: ${pool.address}`);
      console.log(
        `  derived:  ${derivedLending.toString()}`,
      );
    }

    console.log(
      `  ${String(pool.lendingId).padStart(3)} `
      + `${symbol.padEnd(10)} `
      + `dec=${pool.decimals} `
      + `fToken=${fTokenMatch ? "ok" : "MISMATCH"} `
      + `lending=${lendingMatch ? "ok" : "MISMATCH"}`,
    );

    assets.push({
      symbol,
      lending: pool.address,
      fTokenMint: pool.fTokenMint,
      mint: pool.mint,
    });
  }

  const output = {
    juplendProgram:
      JUPLEND_LENDING_PROGRAM_ID.toString(),
    lendingAdmin: lendingAdmin.toString(),
    bankSeed: 600,
    assets,
  };

  const outPath =
    "scripts/juplend/configs/juplend-assets.json";
  fs.writeFileSync(
    outPath,
    JSON.stringify(output, null, 2) + "\n",
  );
  console.log(`\nWrote ${outPath}`);
  console.log(`Total assets: ${assets.length}`);
  if (pdaMismatches > 0) {
    console.log(
      `PDA mismatches: ${pdaMismatches} (review above)`,
    );
  } else {
    console.log("All PDA derivations verified.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
