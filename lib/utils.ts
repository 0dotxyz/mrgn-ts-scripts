import * as fs from "fs";
import path from "path";
import { homedir } from "os";
import dotenv from "dotenv";
import BigNumber from "bignumber.js";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AccountLayout,
  groupedNumberFormatterDyn,
  RawAccount,
  Wallet,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import {
  AccountCache,
  BankMetadata,
  BirdeyeTokenMetadataResponse,
  BirdeyePriceResponse,
} from "./types";
import {
  PYTH_PUSH_ORACLE_ID,
  PYTH_SPONSORED_SHARD_ID,
  MARGINFI_SPONSORED_SHARD_ID,
} from "./constants";
import { Environment, MarginfiAccountRaw } from "@mrgnlabs/marginfi-client-v2";
import { Program, Provider } from "@coral-xyz/anchor";
import * as sb from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import { KaminoLending } from "../idl/kamino_lending";
import { simpleRefreshReserve } from "../scripts/kamino/ixes-common";
import { Marginfi } from "../idl/marginfi";

export const u32_MAX: number = 4294967295;

dotenv.config();

/** Resolves `~` and relative paths for keypair paths from `.env`. */
export function resolveUserPath(filePath: string): string {
  const p = filePath.trim();
  if (!p) {
    throw new Error("Path is empty.");
  }
  if (p.startsWith("~/")) {
    return path.join(homedir(), p.slice(2));
  }
  if (p === "~") {
    return homedir();
  }
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export function loadKeypairFromFile(filePath: string): Keypair {
  const resolved = resolveUserPath(filePath);
  const keyData = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(keyData));
}

export function formatNumber(num: number | BigNumber): string {
  const value = typeof num === "number" ? new BigNumber(num) : num;
  if (value.eq(0)) return "0";
  if (value.lt(1)) return value.toString();
  return groupedNumberFormatterDyn.format(value.toNumber());
}

export function getCachedAccounts(): PublicKey[] {
  const CACHE_FILE = path.join(__dirname, "../account-cache.json");

  if (!fs.existsSync(CACHE_FILE)) {
    throw new Error(
      "Account cache not found. Please run 'pnpm accounts:cache' first.",
    );
  }

  const cache: AccountCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  const accounts = cache.accounts.map((addr) => new PublicKey(addr));
  return accounts.sort(() => Math.random() - 0.5);
}

export function getCachedActivity(): Record<string, any[]> {
  const CACHE_FILE = path.join(__dirname, "../activity-cache.json");

  if (!fs.existsSync(CACHE_FILE)) {
    throw new Error(
      "Activity cache not found. Please run 'pnpm activity:cache' first.",
    );
  }

  return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
}

function u16ToArrayBufferLE(value: number): Uint8Array {
  // Create a buffer of 2 bytes
  const buffer = new ArrayBuffer(2);
  const dataView = new DataView(buffer);

  // Set the Uint16 value in little-endian order
  dataView.setUint16(0, value, true);

  // Return the buffer
  return new Uint8Array(buffer);
}

function findPythPushOracleAddress(
  feedId: Buffer,
  programId: PublicKey,
  shardId: number,
): PublicKey {
  const shardBytes = u16ToArrayBufferLE(shardId);
  return PublicKey.findProgramAddressSync([shardBytes, feedId], programId)[0];
}

export function getPythPushOracleAddresses(feedId: Buffer): PublicKey[] {
  return [
    findPythPushOracleAddress(
      feedId,
      PYTH_PUSH_ORACLE_ID,
      PYTH_SPONSORED_SHARD_ID,
    ),
    findPythPushOracleAddress(
      feedId,
      PYTH_PUSH_ORACLE_ID,
      MARGINFI_SPONSORED_SHARD_ID,
    ),
  ];
}

export async function getBankMetadata(
  env: Environment,
): Promise<BankMetadata[]> {
  let bankMetadataUrl =
    "https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache.json";
  let stakedBankMetadataUrl =
    "https://storage.googleapis.com/mrgn-public/mrgn-staked-bank-metadata-cache.json";

  if (env === "staging") {
    bankMetadataUrl =
      "https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache-stage.json";
    stakedBankMetadataUrl =
      "https://storage.googleapis.com/mrgn-public/mrgn-staked-bank-metadata-cache-stage.json";
  }

  const bankMetadataResponse = await fetch(bankMetadataUrl);
  const stakedBankMetadataResponse = await fetch(stakedBankMetadataUrl);
  const bankMetadata = (await bankMetadataResponse.json()) as BankMetadata[];
  const stakedBankMetadata =
    (await stakedBankMetadataResponse.json()) as BankMetadata[];

  return [...bankMetadata, ...stakedBankMetadata];
}

export async function getBankMetadataFromBirdeye(
  bank: PublicKey,
  mint: PublicKey,
) {
  const birdeyeApiResponse = await fetch(
    `https://public-api.birdeye.so/defi/v3/token/meta-data/single?address=${mint.toBase58()}`,
    {
      headers: {
        "x-api-key": process.env.BIRDEYE_API_KEY,
        "x-chain": "solana",
      },
    },
  );
  const birdeyeApiJson: BirdeyeTokenMetadataResponse =
    await birdeyeApiResponse.json();

  if (birdeyeApiResponse.ok && birdeyeApiJson.data) {
    return {
      bankAddress: bank.toString(),
      tokenSymbol: birdeyeApiJson.data.symbol,
    };
  }

  return null;
}

/**
 * A Wallet, but it's built from pubkey only, so it can't sign, and the keypair is always undefined.
 */
export class ReadOnlyWallet implements Wallet {
  payer: Keypair;
  readonly publicKey: PublicKey;

  constructor(pubkey: PublicKey) {
    this.publicKey = pubkey;
    this.payer = undefined;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    tx: T,
  ): Promise<T> {
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    txs: T[],
  ): Promise<T[]> {
    return txs;
  }
}

export type BankAndOracles = PublicKey[]; // [bank, oracle, oracle_2...]

/**
 * Prepares transaction remaining accounts by processing bank-oracle groups:
 * 1. Sorts groups in descending order by bank public key (pushes inactive accounts to end)
 * 2. Flattens the structure into a single public key array
 *
 * Stable on most JS implementations (this shouldn't matter since we do not generally have duplicate
 * banks), in place, and uses the raw 32-byte value to sort in byte-wise lexicographical order (like
 * Rust's b.key.cmp(&a.key))
 *
 * @param banksAndOracles - Array where each element is a bank-oracle group: [bankPubkey,
 *                          oracle1Pubkey, oracle2Pubkey?, ...] Note: SystemProgram keys (111..111)
 *                          represent inactive accounts
 * @returns Flattened array of public keys with inactive accounts at the end, ready for transaction
 *          composition
 */
export const composeRemainingAccounts = (
  banksAndOracles: PublicKey[][],
): PublicKey[] => {
  banksAndOracles.sort((a, b) => {
    const A = a[0].toBytes();
    const B = b[0].toBytes();
    // find the first differing byte
    for (let i = 0; i < 32; i++) {
      if (A[i] !== B[i]) {
        // descending: bigger byte should come first
        return B[i] - A[i];
      }
    }
    return 0; // identical keys
  });

  // flatten out [bank, oracle…, oracle…] → [bank, oracle…, bank, oracle…, …]
  return banksAndOracles.flat();
};

/**
 * Print account balances in a pretty table. If you're getting a type error here, due to a different
 * client version. feel free to ts-ignore it.
 */
export function dumpAccBalances(account: MarginfiAccountRaw) {
  let balances = account.lendingAccount.balances;
  let activeBalances = [];
  for (let i = 0; i < balances.length; i++) {
    if (balances[i].active == 0) {
      activeBalances.push({
        "Bank PK": "empty",
        // Tag: "-",
        "Liab Shares ": "-",
        "Asset Shares": "-",
        // Emissions: "-",
      });
      continue;
    }

    activeBalances.push({
      "Bank PK": balances[i].bankPk.toString(),
      // Tag: balances[i].bankAssetTag,
      "Liab Shares ": formatNumber(
        wrappedI80F48toBigNumber(balances[i].liabilityShares),
      ),
      "Asset Shares": formatNumber(
        wrappedI80F48toBigNumber(balances[i].assetShares),
      ),
      // Emissions: formatNumber(
      //   wrappedI80F48toBigNumber(balances[i].emissionsOutstanding)
      // ),
    });

    function formatNumber(num) {
      const number = parseFloat(num).toFixed(4);
      return number === "0.0000" ? "-" : number;
    }
  }
  console.table(activeBalances);
}

/**
 * Decode an f64 from 8 bytes (little‑endian).
 * @param bytes - either a Uint8Array or number[] of length 8
 * @returns the decoded number
 */
export function bytesToF64(bytes: Uint8Array | number[]): number {
  // Normalize to a Uint8Array
  const u8: Uint8Array =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  if (u8.length !== 8) {
    throw new Error(`Invalid length ${u8.length}, expected exactly 8 bytes`);
  }

  // Create a DataView on the buffer (little‑endian)
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return dv.getFloat64(0, /* littleEndian */ true);
}

/**
 * Fetches token prices for a list of banks using Birdeye API
 * @param banks Array of bank objects containing mint property
 * @returns A map of token addresses to their prices
 */
export async function getBankPrices(
  banks: any[],
): Promise<Map<string, number>> {
  // Extract token addresses from banks
  const tokenAddresses = banks.map((bank) => bank.mint.toBase58());

  // Prepare request payload for Birdeye API
  const payload = {
    list_address: tokenAddresses.join(","),
  };

  // Make API request to Birdeye
  const birdeyeApiResponse = await fetch(
    "https://public-api.birdeye.so/defi/multi_price",
    {
      method: "POST",
      headers: {
        "x-api-key": process.env.BIRDEYE_API_KEY,
        "x-chain": "solana",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  // Parse response
  const birdeyeApiJson: BirdeyePriceResponse = await birdeyeApiResponse.json();
  const priceMap = new Map<string, number>();

  // Create a map of token address to price
  if (birdeyeApiResponse.ok && birdeyeApiJson.data) {
    Object.entries(birdeyeApiJson.data).forEach(([tokenAddress, priceData]) => {
      if (!priceData) return;
      priceMap.set(tokenAddress, priceData.value);
    });
  }

  return priceMap;
}

export async function getOraclesAndCrankSwb(
  program: Program<Marginfi>,
  kaminoProgram: Program<KaminoLending>,
  account: PublicKey,
  connection: Connection,
  payer: Keypair,
): Promise<[BankAndOracles[], TransactionInstruction[]]> {
  let swbPullFeeds: PublicKey[] = [];
  const ixs: TransactionInstruction[] = [];

  let acc = await program.account.marginfiAccount.fetch(account);
  dumpAccBalances(acc);
  let balances = acc.lendingAccount.balances;
  let activeBalances: BankAndOracles[] = [];
  for (let i = 0; i < balances.length; i++) {
    const bal = balances[i];
    if (bal.active == 1) {
      const bankAcc = await program.account.bank.fetch(bal.bankPk);
      const setup = bankAcc.config.oracleSetup;
      const keys = bankAcc.config.oracleKeys;

      if ("switchboardPull" in setup) {
        const oracle = keys[0];
        console.log(`[${i}] swb oracle: ${oracle}`);
        swbPullFeeds.push(oracle);
        activeBalances.push([bal.bankPk, oracle]);
      } else if ("kaminoSwitchboardPull" in setup) {
        const oracle = keys[0];
        console.log(`[${i}] kamino swb oracle: ${oracle}`);
        console.log(`  extra key: ${keys[1]}`);
        swbPullFeeds.push(oracle); // still a switchboard feed
        activeBalances.push([bal.bankPk, oracle, keys[1]]);

        const kaminoReservePk: PublicKey = bankAcc.integrationAcc1;
        let reserve =
          await kaminoProgram.account.reserve.fetch(kaminoReservePk);
        const ix = await simpleRefreshReserve(
          kaminoProgram,
          kaminoReservePk,
          reserve.lendingMarket,
          reserve.config.tokenInfo.scopeConfiguration.priceFeed,
        );
        ixs.push(ix);
      } else if ("pythPushOracle" in setup) {
        const oracle = keys[0];
        console.log(`[${i}] pyth oracle: ${oracle}`);
        activeBalances.push([bal.bankPk, oracle]);
      } else if ("kaminoPythPush" in setup) {
        const oracle = keys[0];
        console.log(`[${i}] kamino pyth oracle: ${oracle}`);
        console.log(`  extra key: ${keys[1]}`);
        activeBalances.push([bal.bankPk, oracle, keys[1]]);

        const kaminoReservePk: PublicKey = bankAcc.integrationAcc1;
        let reserve =
          await kaminoProgram.account.reserve.fetch(kaminoReservePk);
        const ix = await simpleRefreshReserve(
          kaminoProgram,
          kaminoReservePk,
          reserve.lendingMarket,
          reserve.config.tokenInfo.scopeConfiguration.priceFeed,
        );
        ixs.push(ix);
      } else if ("stakedWithPythPush" in setup) {
        const oracle = keys[0];
        console.log(`[${i}] pyth oracle: ${oracle}`);
        console.log(`  lst pool/mint: ${keys[1]} ${keys[2]}`);
        activeBalances.push([bal.bankPk, oracle, keys[1], keys[2]]);
      } else if ("fixed" in setup) {
        // do nothing
      } else {
        const oracle = keys[0];
        console.log(`[${i}] other oracle: ${oracle}`);
        activeBalances.push([bal.bankPk, oracle]);
      }
      // TODO drift
    }
  }

  if (swbPullFeeds.length > 0) {
    try {
      const swbProgram = await sb.AnchorUtils.loadProgramFromConnection(
        // TODO fix when web3 is bumped in swb?
        // @ts-ignore
        connection,
      );

      const pullFeedInstances: string[] = swbPullFeeds.map((pubkey) =>
        pubkey.toString(),
      );

      // TODO env var
      const crossbarClient = new CrossbarClient(
        "https://integrator-crossbar.prod.mrgn.app",
      );

      const [{ pullIxns, lookupTables }] =
        await crossbarClient.fetchSolanaUpdates(
          "mainnet",
          pullFeedInstances,
          payer.publicKey.toString(),
          1,
        );

      let luts: AddressLookupTableAccount[] = [];
      for (let i = 0; i < lookupTables.length; i++) {
        const lut = await connection.getAddressLookupTable(
          new PublicKey(lookupTables[i]),
        );
        if (!lut || !lut.value) {
          console.warn(
            `Warning: LUT ${lookupTables[i]} not found on-chain. Proceeding without it.`,
          );
        } else {
          luts.push(lut.value);
        }
      }

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();

      const v0Message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: pullIxns,
      }).compileToV0Message(luts);

      const v0Tx = new VersionedTransaction(v0Message);
      v0Tx.sign([payer]);

      const signature = await connection.sendTransaction(v0Tx, {
        maxRetries: 5,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      console.log("Swb crank (v0) tx signature:", signature);
    } catch (err) {
      console.log("swb crank failed");
      console.log(err);
    }
  }

  return [activeBalances, ixs];
}

export const getTokenBalance = async (
  provider: Provider,
  account: PublicKey,
) => {
  const accountInfo = await provider.connection.getAccountInfo(account);
  if (!accountInfo) {
    console.error("Tried to load balance of acc that doesn't exist");
    return 0;
  }
  const data: RawAccount = AccountLayout.decode(accountInfo.data);
  if (data === undefined || data.amount === undefined) {
    return 0;
  }
  const amount: BigInt = data.amount;
  return Number(amount);
};

export const aprToU32 = (apr: number): number => {
  if (apr < 0 || apr > 10) {
    console.error("apr out of range, exp 0-1000% (0-10), will clamp: " + apr);
  }
  const clamped = Math.max(0, Math.min(apr, 10));
  return Math.round((clamped / 10) * u32_MAX);
};
export const utilToU32 = (util: number): number => {
  if (util < 0 || util > 1) {
    console.error("util out of range, exp 0-100% (0-1), will clamp: " + util);
  }
  const clamped = Math.max(0, Math.min(util, 1));
  return Math.round(clamped * u32_MAX);
};

export const u32ToApr = (aprAsU32: number): number => {
  return (aprAsU32 / u32_MAX) * 10;
};

export const u32ToUtil = (utilAsU32: number): number => {
  return utilAsU32 / u32_MAX;
};
