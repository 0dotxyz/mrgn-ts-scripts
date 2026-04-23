import {
  AccountInfo,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import BigNumber from "bignumber.js";
import * as sb from "@switchboard-xyz/on-demand";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";

import { commonSetup } from "../../../lib/common-setup";
import { chunk, loadKeypairFromFile } from "../../utils/utils";
import { decodePriceUpdateV2 } from "../../utils/utils_oracle";


const sendTx = true;

// Bank struct layout before `group`: 8 disc + 32 mint + 1 decimals = 41 bytes.
const BANK_GROUP_OFFSET = 8 + 32 + 1;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  MULTISIG: PublicKey;
  LUT: PublicKey;
  LUT_AUTHORITY_WALLET: string;
  USD_THRESHOLD: number;
  HOURLY_PCT: number;
  DAILY_PCT: number;
  BATCH_SIZE: number;
  MAX_TRANCHES: number;
  SKIP_ASSET_TAGS: number[];
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  GROUP: new PublicKey("E7BFUEqkHUyyiHUeUJci8j4JPZpkzNL6YSaVMkt4B8FP"),
  MULTISIG: new PublicKey("EokNERAAaWorYsqMqgNhVHbyNmQoGDzEuVpbbEsCtK3a"),
  LUT: new PublicKey("7NtDMfcMfXZuRPJMK4oQAk8sfEebpp1bpN94Fe1pVFXE"),
  LUT_AUTHORITY_WALLET: "/.config/solana/id.json",
  USD_THRESHOLD: -1,
  HOURLY_PCT: 20,
  DAILY_PCT: 40,
  BATCH_SIZE: 20,
  MAX_TRANCHES: 5,
  SKIP_ASSET_TAGS: [],
};

const DEFAULT_WALLET_PATH = "/.config/solana/id.json";

type BankInfo = {
  address: PublicKey;
  mint: PublicKey;
  mintDecimals: number;
  totalAssetShares: BigNumber;
  assetShareValue: BigNumber;
  oracleKey: PublicKey;
  oracleSetup: string;
  fixedPrice: BigNumber;
  assetTag: number;
  operationalState: string;
};

type BankSnapshot = {
  pubkey: PublicKey;
  symbol: string;
  decimals: number;
  assetTag: number;
  totalDepositsNative: BigNumber;
  priceUsd: BigNumber;
  totalDepositsUsd: BigNumber;
  hourlyCap: BN;
  dailyCap: BN;
};

function pctOfNative(totalNative: BigNumber, pct: number): BN {
  const atoms = totalNative
    .multipliedBy(pct)
    .dividedBy(100)
    .integerValue(BigNumber.ROUND_FLOOR);
  return new BN(atoms.toFixed(0));
}

function addLutKeysFromIx(
  ix: TransactionInstruction,
  keyMap: Map<string, PublicKey>,
) {
  const pid = ix.programId.toBase58();
  if (!keyMap.has(pid)) keyMap.set(pid, ix.programId);
  for (const meta of ix.keys) {
    if (meta.isSigner) continue;
    const pk = meta.pubkey.toBase58();
    if (!keyMap.has(pk)) keyMap.set(pk, meta.pubkey);
  }
}


async function ensureLutHasKeys(
  connection: Connection,
  lut: AddressLookupTableAccount,
  authority: Keypair,
  missing: PublicKey[],
): Promise<AddressLookupTableAccount> {
  if (missing.length === 0) return lut;

  if (!lut.state.authority) {
    throw new Error(
      `LUT ${lut.key.toBase58()} is frozen (no authority). Cannot extend.`,
    );
  }
  if (!lut.state.authority.equals(authority.publicKey)) {
    throw new Error(
      `LUT authority mismatch: on-chain ${lut.state.authority.toBase58()}, ` +
        `signer ${authority.publicKey.toBase58()}. Point LUT_AUTHORITY_WALLET ` +
        `at the key that owns the LUT.`,
    );
  }

  console.log(
    `\nExtending LUT ${lut.key.toBase58()} with ${missing.length} new key(s):`,
  );
  for (const k of missing) console.log(`  + ${k.toBase58()}`);

  const EXTEND_CHUNK = 20;
  for (const group of chunk(missing, EXTEND_CHUNK)) {
    const ix = AddressLookupTableProgram.extendLookupTable({
      authority: authority.publicKey,
      payer: authority.publicKey,
      lookupTable: lut.key,
      addresses: group,
    });
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [authority],
    );
    console.log(`  extend ${group.length} key(s) → ${sig}`);
  }

  const refreshed = await connection.getAddressLookupTable(lut.key);
  if (!refreshed.value) {
    throw new Error(`LUT ${lut.key.toBase58()} missing after extend`);
  }
  return refreshed.value;
}

type OracleKind = "pyth" | "switchboard" | "fixed" | "unsupported";

function classifyOracle(setup: string): OracleKind {
  const lower = setup.toLowerCase();
  if (lower === "fixed" || lower.startsWith("fixed")) return "fixed";
  if (lower.includes("pyth")) return "pyth";
  if (lower.includes("switchboard")) return "switchboard";
  return "unsupported";
}

function oracleSetupKey(setup: unknown): string {
  if (typeof setup === "string") return setup;
  if (setup && typeof setup === "object") {
    return Object.keys(setup as object)[0] ?? "";
  }
  return "";
}

async function fetchAccountsBatched(
  connection: Connection,
  keys: PublicKey[],
): Promise<(AccountInfo<Buffer> | null)[]> {
  const CHUNK = 100;
  const out: (AccountInfo<Buffer> | null)[] = [];
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = await connection.getMultipleAccountsInfo(
      keys.slice(i, i + CHUNK),
    );
    out.push(...slice);
  }
  return out;
}


async function resolvePrices(
  connection: Connection,
  banks: BankInfo[],
): Promise<Map<string, BigNumber>> {
  const prices = new Map<string, BigNumber>();
  const pyth: BankInfo[] = [];
  const swb: BankInfo[] = [];

  for (const b of banks) {
    const key = b.address.toBase58();
    switch (classifyOracle(b.oracleSetup)) {
      case "fixed":
        prices.set(key, b.fixedPrice);
        break;
      case "pyth":
        pyth.push(b);
        break;
      case "switchboard":
        swb.push(b);
        break;
    }
  }

  if (pyth.length > 0) {
    const infos = await fetchAccountsBatched(
      connection,
      pyth.map((b) => b.oracleKey),
    );
    for (let i = 0; i < pyth.length; i++) {
      const info = infos[i];
      if (!info) continue;
      const update = decodePriceUpdateV2(Buffer.from(info.data));
      const msg = update.price_message;
      prices.set(
        pyth[i].address.toBase58(),
        new BigNumber(msg.price.toString()).multipliedBy(
          new BigNumber(10).pow(msg.exponent),
        ),
      );
    }
  }

  if (swb.length > 0) {
    // @ts-ignore — SWB SDK typed against different @solana/web3.js version
    const swbProgram = await sb.AnchorUtils.loadProgramFromConnection(connection);
    const feeds = await swbProgram.account.pullFeedAccountData.fetchMultiple(
      swb.map((b) => b.oracleKey),
    );
    const SWB_SCALE = new BigNumber(10).pow(18);
    for (let i = 0; i < swb.length; i++) {
      const acc = feeds[i] as { result?: { value?: BN } } | null;
      if (!acc?.result?.value) continue;
      prices.set(
        swb[i].address.toBase58(),
        new BigNumber(acc.result.value.toString()).dividedBy(SWB_SCALE),
      );
    }
  }

  return prices;
}

async function fetchGroupBanks(
  program: ReturnType<typeof commonSetup>["program"],
  group: PublicKey,
): Promise<BankInfo[]> {
  const rows = await program.account.bank.all([
    { memcmp: { offset: BANK_GROUP_OFFSET, bytes: group.toBase58() } },
  ]);
  return rows.map(({ publicKey, account }) => ({
    address: publicKey,
    mint: account.mint,
    mintDecimals: account.mintDecimals,
    totalAssetShares: wrappedI80F48toBigNumber(account.totalAssetShares),
    assetShareValue: wrappedI80F48toBigNumber(account.assetShareValue),
    oracleKey: account.config.oracleKeys[0],
    oracleSetup: oracleSetupKey(account.config.oracleSetup),
    fixedPrice: wrappedI80F48toBigNumber(account.config.fixedPrice),
    assetTag: account.config.assetTag,
    operationalState: oracleSetupKey(account.config.operationalState),
  }));
}

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    DEFAULT_WALLET_PATH,
    config.MULTISIG,
  );
  const { program, connection } = user;
  const adminKey = sendTx ? user.wallet.publicKey : config.MULTISIG;
  const payerKey = adminKey;

  const onChainBanks = await fetchGroupBanks(program, config.GROUP);
  const operationalBanks = onChainBanks.filter(
    (b) => b.operationalState.toLowerCase() === "operational",
  );
  const nonOperationalCount = onChainBanks.length - operationalBanks.length;
  console.log(
    `Fetched ${onChainBanks.length} banks on-chain in group ${config.GROUP} ` +
      `(${operationalBanks.length} operational${
        nonOperationalCount
          ? `, ${nonOperationalCount} paused/reduce-only — skipped`
          : ""
      })`,
  );

  const priceMap = await resolvePrices(connection, operationalBanks);

  const snapshots: BankSnapshot[] = [];
  for (const b of operationalBanks) {
    if (config.SKIP_ASSET_TAGS.includes(b.assetTag)) continue;

    const totalDepositsNative = b.totalAssetShares.multipliedBy(
      b.assetShareValue,
    );

    const priceUsd = priceMap.get(b.address.toBase58());
    if (!priceUsd || priceUsd.isZero()) {
      console.warn(
        `[skip] no price for ${b.address.toBase58()} (${b.oracleSetup})`,
      );
      continue;
    }

    const totalDepositsUsd = totalDepositsNative
      .shiftedBy(-b.mintDecimals)
      .multipliedBy(priceUsd);

    snapshots.push({
      pubkey: b.address,
      symbol: b.address.toBase58().slice(0, 4),
      decimals: b.mintDecimals,
      assetTag: b.assetTag,
      totalDepositsNative,
      priceUsd,
      totalDepositsUsd,
      hourlyCap: pctOfNative(totalDepositsNative, config.HOURLY_PCT),
      dailyCap: pctOfNative(totalDepositsNative, config.DAILY_PCT),
    });
  }

  const selected = snapshots
    .filter((s) => s.totalDepositsUsd.gt(config.USD_THRESHOLD))
    .sort((a, b) => b.totalDepositsUsd.comparedTo(a.totalDepositsUsd) ?? 0);

  console.log(
    `\n${selected.length} bank(s) meet the $${config.USD_THRESHOLD.toLocaleString()} USD deposits threshold — rate-limiting these:`,
  );
  console.table(
    selected.map((s) => ({
      Symbol: s.symbol,
      Bank: s.pubkey.toBase58(),
      AssetTag: s.assetTag,
      "Deposits (token)": s.totalDepositsNative.shiftedBy(-s.decimals).toFormat(4),
      "Price ($)": s.priceUsd.toFormat(6),
      "Deposits ($)": s.totalDepositsUsd.toFormat(2),
      "Hourly cap (native)": s.hourlyCap.toString(),
      "Daily cap (native)": s.dailyCap.toString(),
    })),
  );

  if (selected.length === 0) {
    console.log("No banks over threshold. Nothing to do.");
    return;
  }

  const ixs: TransactionInstruction[] = [];
  const lutKeys = new Map<string, PublicKey>();
  for (const s of selected) {
    const ix = await program.methods
      .configureBankRateLimits(s.hourlyCap, s.dailyCap)
      .accounts({ bank: s.pubkey })
      .accountsPartial({ group: config.GROUP, admin: adminKey })
      .instruction();
    ixs.push(ix);
    addLutKeysFromIx(ix, lutKeys);
  }

  const totalTvlUsd = snapshots.reduce(
    (sum, s) => sum.plus(s.totalDepositsUsd),
    new BigNumber(0),
  );
  const groupHourlyUsd = new BN(
    totalTvlUsd
      .multipliedBy(config.HOURLY_PCT)
      .dividedBy(100)
      .integerValue(BigNumber.ROUND_FLOOR)
      .toFixed(0),
  );
  const groupDailyUsd = new BN(
    totalTvlUsd
      .multipliedBy(config.DAILY_PCT)
      .dividedBy(100)
      .integerValue(BigNumber.ROUND_FLOOR)
      .toFixed(0),
  );
  console.log(
    `\nGroup TVL $${totalTvlUsd.toFormat(2)} — applying group caps: ` +
      `hourly=$${groupHourlyUsd.toString()} daily=$${groupDailyUsd.toString()}`,
  );
  const groupIx = await program.methods
    .configureGroupRateLimits(groupHourlyUsd, groupDailyUsd)
    .accountsPartial({ marginfiGroup: config.GROUP, admin: adminKey })
    .instruction();
  if (sendTx) ixs.push(groupIx);

  const lutResp = await connection.getAddressLookupTable(config.LUT);
  if (!lutResp.value) {
    throw new Error(`LUT not found on-chain: ${config.LUT.toBase58()}`);
  }
  const lutKnown = new Set(
    lutResp.value.state.addresses.map((k) => k.toBase58()),
  );
  const missing = Array.from(lutKeys.values()).filter(
    (k) => !lutKnown.has(k.toBase58()),
  );
  const lutAuthority = loadKeypairFromFile(
    process.env.HOME + config.LUT_AUTHORITY_WALLET,
  );
  const lut = await ensureLutHasKeys(
    connection,
    lutResp.value,
    lutAuthority,
    missing,
  );

  const batches = chunk(ixs, config.BATCH_SIZE);
  console.log(
    `\nPlanning ${batches.length} tranche(s) at BATCH_SIZE=${config.BATCH_SIZE} (budget: ${config.MAX_TRANCHES}).`,
  );
  if (batches.length > config.MAX_TRANCHES) {
    throw new Error(
      `Would emit ${batches.length} tranches, exceeds MAX_TRANCHES=${config.MAX_TRANCHES}. ` +
        `Increase BATCH_SIZE (tx-size ceiling is ~32 ixs/tx with LUT) or raise MAX_TRANCHES.`,
    );
  }

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const v0Message = new TransactionMessage({
      payerKey,
      recentBlockhash: blockhash,
      instructions: batch,
    }).compileToV0Message([lut]);
    const v0Tx = new VersionedTransaction(v0Message);

    const banksInTranche = selected
      .slice(i * config.BATCH_SIZE, i * config.BATCH_SIZE + batch.length)
      .map((s, idx) => ({ idx, symbol: s.symbol, bank: s.pubkey.toBase58() }));

    console.log(
      `\n=== Tranche ${i + 1}/${batches.length} (${batch.length} ix${
        batch.length === 1 ? "" : "s"
      }) ===`,
    );
    console.table(banksInTranche);

    if (sendTx) {
      v0Tx.sign([user.wallet.payer]);
      const sig = await connection.sendTransaction(v0Tx, { maxRetries: 2 });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      console.log("Signature:", sig);
    } else {
      const encoded = bs58.encode(v0Tx.serialize());
      console.log(`\n---- BEGIN MULTISIG TX ${i + 1}/${batches.length} (base58) ----`);
      console.log(encoded);
      console.log(`---- END MULTISIG TX ${i + 1}/${batches.length} ----\n`);
    }
  }


  if (!sendTx) {
    const { blockhash } = await connection.getLatestBlockhash();
    const groupMsg = new TransactionMessage({
      payerKey,
      recentBlockhash: blockhash,
      instructions: [groupIx],
    }).compileToV0Message([lut]);
    const groupTx = new VersionedTransaction(groupMsg);
    console.log(`\n---- BEGIN MULTISIG TX GROUP (base58) ----`);
    console.log(bs58.encode(groupTx.serialize()));
    console.log(`---- END MULTISIG TX GROUP ----\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
