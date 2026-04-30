import {
  AccountInfo,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
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

import { commonSetup } from "../../lib/common-setup";
import { chunk, loadKeypairFromFile } from "../utils/utils";
import { decodePriceUpdateV2 } from "../utils/utils_oracle";


const sendTx = false;

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
  // Bytes reserved off the 1232-byte tx limit. Covers the Squads execute-ix
  // wrapper (extra program id + vault/PDA account metas) plus a comfort
  // margin so we never pack right up against the hard limit.
  TX_BYTE_RESERVE: number;
  MAX_TRANCHES: number;
  SKIP_ASSET_TAGS: number[];
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  LUT: new PublicKey("2b8UjpA3bAe7f8gcXd1gA3rFe6WuGZiKRNUXsS6tghEk"),
  LUT_AUTHORITY_WALLET: "/.config/solana/id.json",
  USD_THRESHOLD: 100_000,
  HOURLY_PCT: 20,
  DAILY_PCT: 40,
  TX_BYTE_RESERVE: 200,
  MAX_TRANCHES: 12,
  SKIP_ASSET_TAGS: [],
};

const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";


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
  mint: PublicKey;
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
    // SWB SDK was typed against a different @solana/web3.js version; it works
    // fine with ours at runtime.
    // @ts-ignore
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

function measureTxBytes(
  payerKey: PublicKey,
  blockhash: string,
  lut: AddressLookupTableAccount,
  ixs: TransactionInstruction[],
): number {
  const msg = new TransactionMessage({
    payerKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([lut]);
  return new VersionedTransaction(msg).serialize().length;
}

type PackStep = {
  globalIx: number;
  tranche: number;
  posInTranche: number;
  label: string;
  bytesBefore: number;
  bytesAfter: number;
  delta: number;
  startedNewTranche: boolean;
};

// Greedily pack ixs into as few v0 txs as possible without exceeding the
// wire-format limit. Each candidate batch is actually compiled against the
// live LUT so we measure real bytes — no guessing. Emits a per-ix step log
// so the caller can render exactly how the tranches filled up.
function packInstructionsBySize(
  payerKey: PublicKey,
  blockhash: string,
  lut: AddressLookupTableAccount,
  ixs: TransactionInstruction[],
  labels: string[],
  budgetBytes: number,
  maxIxsPerTranche?: number,
): {
  batches: TransactionInstruction[][];
  byteCounts: number[];
  steps: PackStep[];
} {
  const batches: TransactionInstruction[][] = [];
  const byteCounts: number[] = [];
  const steps: PackStep[] = [];
  let tranche = 0;
  let current: TransactionInstruction[] = [];
  let currentSize = 0;

  for (let g = 0; g < ixs.length; g++) {
    const ix = ixs[g];
    const trial = [...current, ix];
    const trialSize = measureTxBytes(payerKey, blockhash, lut, trial);
    const fitsBytes = trialSize <= budgetBytes;
    const fitsCount =
      maxIxsPerTranche === undefined || trial.length <= maxIxsPerTranche;

    if (fitsBytes && fitsCount) {
      steps.push({
        globalIx: g,
        tranche,
        posInTranche: current.length,
        label: labels[g],
        bytesBefore: currentSize,
        bytesAfter: trialSize,
        delta: trialSize - currentSize,
        startedNewTranche: current.length === 0,
      });
      current = trial;
      currentSize = trialSize;
      continue;
    }

    if (current.length === 0) {
      throw new Error(
        `Single instruction serializes to ${trialSize} bytes, exceeds budget ${budgetBytes}. ` +
          `Either increase LUT coverage or reduce TX_BYTE_RESERVE.`,
      );
    }

    // Current tranche is full — flush and open a new one with this ix.
    batches.push(current);
    byteCounts.push(currentSize);
    tranche++;
    current = [ix];
    currentSize = measureTxBytes(payerKey, blockhash, lut, current);
    steps.push({
      globalIx: g,
      tranche,
      posInTranche: 0,
      label: labels[g],
      bytesBefore: 0,
      bytesAfter: currentSize,
      delta: currentSize,
      startedNewTranche: true,
    });
  }
  if (current.length > 0) {
    batches.push(current);
    byteCounts.push(currentSize);
  }
  return { batches, byteCounts, steps };
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
      mint: b.mint,
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
      "Hourly cap (token)": new BigNumber(s.hourlyCap.toString())
        .shiftedBy(-s.decimals)
        .toFormat(4),
      "Daily cap (token)": new BigNumber(s.dailyCap.toString())
        .shiftedBy(-s.decimals)
        .toFormat(4),
      "Hourly cap ($)": new BigNumber(s.hourlyCap.toString())
        .shiftedBy(-s.decimals)
        .multipliedBy(s.priceUsd)
        .toFormat(2),
      "Daily cap ($)": new BigNumber(s.dailyCap.toString())
        .shiftedBy(-s.decimals)
        .multipliedBy(s.priceUsd)
        .toFormat(2),
    })),
  );

  // Per-bank window caps — the actual policy: at most HOURLY_PCT of deposits
  // can flow out in any 1h window, at most DAILY_PCT in any 24h window.
  console.log(`\nPer-bank flow caps:`);
  console.table(
    selected.map((s) => ({
      Bank: s.pubkey.toBase58(),
      Mint: s.mint.toBase58(),
      Hourly: new BigNumber(s.hourlyCap.toString())
        .shiftedBy(-s.decimals)
        .toFormat(4),
      Daily: new BigNumber(s.dailyCap.toString())
        .shiftedBy(-s.decimals)
        .toFormat(4),
    })),
  );

  const flowCapsJson = selected.map((s) => ({
    bank: s.pubkey.toBase58(),
    mint: s.mint.toBase58(),
    decimals: s.decimals,
    hourlyCapNative: s.hourlyCap.toString(),
    dailyCapNative: s.dailyCap.toString(),
    hourlyCapUi: new BigNumber(s.hourlyCap.toString())
      .shiftedBy(-s.decimals)
      .toString(),
    dailyCapUi: new BigNumber(s.dailyCap.toString())
      .shiftedBy(-s.decimals)
      .toString(),
  }));
  console.log(`\nPer-bank flow caps (JSON):`);
  console.log(JSON.stringify(flowCapsJson, null, 2));

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


  const groupHourlyUsd = new BN(0);
  const groupDailyUsd = new BN(0);
  console.log(
    `\nGroup caps: hourly=$${groupHourlyUsd.toString()} daily=$${groupDailyUsd.toString()}`,
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

  const packBudget = PACKET_DATA_SIZE - config.TX_BYTE_RESERVE;
  const sizingBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const ixLabels = ixs.map((_, i) =>
    i < selected.length ? `${selected[i].symbol} ${selected[i].pubkey.toBase58()}` : "GROUP configureGroupRateLimits",
  );
  // Force the per-bank configureBankRateLimits ixs across 3 tranches even when
  // they would byte-fit in fewer — keeps each multisig tx smaller for review.
  const targetTranches = 3;
  const maxIxsPerTranche = Math.ceil(selected.length / targetTranches);
  const { batches, byteCounts, steps } = packInstructionsBySize(
    payerKey,
    sizingBlockhash,
    lut,
    ixs,
    ixLabels,
    packBudget,
    maxIxsPerTranche,
  );
  console.log(
    `\nPacked ${ixs.length} ix(s) into ${batches.length} tranche(s) ` +
      `(limit ${PACKET_DATA_SIZE} bytes, reserve ${config.TX_BYTE_RESERVE}, budget ${packBudget}).`,
  );

  // Per-ix packing log — shows how each added ix grew the tranche and where
  // the tranche boundary was forced.
  console.log(`\nPer-ix packing log (budget ${packBudget} bytes):`);
  for (const s of steps) {
    const marker = s.startedNewTranche ? " [NEW TRANCHE]" : "";
    const pct = ((s.bytesAfter / packBudget) * 100).toFixed(1);
    console.log(
      `  ix #${s.globalIx + 1} tranche ${s.tranche + 1} pos ${s.posInTranche + 1} | ` +
        `${s.bytesBefore} → ${s.bytesAfter} bytes (+${s.delta}) | ` +
        `remaining ${packBudget - s.bytesAfter} (${pct}% of budget) | ${s.label}${marker}`,
    );
  }

  // Per-tranche summary: max ixs and bytes we reached before flushing.
  console.log(`\nPer-tranche summary:`);
  for (let i = 0; i < batches.length; i++) {
    const bytes = byteCounts[i];
    const pct = ((bytes / packBudget) * 100).toFixed(1);
    console.log(
      `  Tranche ${i + 1}: ${batches[i].length} ixs, ${bytes} bytes | ` +
        `budget headroom ${packBudget - bytes} (${pct}% of budget) | ` +
        `hard-limit headroom ${PACKET_DATA_SIZE - bytes}`,
    );
  }

  if (batches.length > config.MAX_TRANCHES) {
    throw new Error(
      `Packed ${batches.length} tranches, exceeds MAX_TRANCHES=${config.MAX_TRANCHES}. ` +
        `Verify the LUT covers all ix accounts or raise MAX_TRANCHES.`,
    );
  }

  let ixCursor = 0;
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

    const banksInTranche = batch.map((_, idx) => {
      const globalIdx = ixCursor + idx;
      if (globalIdx < selected.length) {
        const s = selected[globalIdx];
        return { idx, symbol: s.symbol, bank: s.pubkey.toBase58() };
      }
      return { idx, symbol: "GROUP", bank: "configureGroupRateLimits" };
    });
    ixCursor += batch.length;

    console.log(
      `\n=== Tranche ${i + 1}/${batches.length} (${batch.length} ix${
        batch.length === 1 ? "" : "s"
      }, ${byteCounts[i]} bytes) ===`,
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
