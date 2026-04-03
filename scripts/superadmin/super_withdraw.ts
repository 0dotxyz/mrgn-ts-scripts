import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  AccountMeta,
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import Decimal from "decimal.js";
import { readFileSync } from "fs";
import { join } from "path";

import { commonSetup } from "../../lib/common-setup";
import {
  deriveLiquidityVault,
  deriveLiquidityVaultAuthority,
} from "../common/pdas";

const sendTx = false;
const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  DESTINATION_WALLET: PublicKey;
  MULTISIG_PAYER: PublicKey;
  LUT: PublicKey;
  CSV_FILE: string;
  BATCH_SIZE: number;
  ATA_CREATE_MODE: "always" | "missing-only" | "never";
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  DESTINATION_WALLET: new PublicKey("AnGdBvg8VmVHq7zyUYmC7mgjZ5pW6odwFsh6eharbzLu"),
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  LUT: new PublicKey("3XpcTktgNzeMv2ATg4Y6yLgE5Wfxebcb8Tb9zj755PhH"),
  CSV_FILE: "super_admin_table.csv",
  BATCH_SIZE: 4,
  ATA_CREATE_MODE: "missing-only",
};

type ParsedWithdrawRow = {
  bank: PublicKey;
  mint: PublicKey;
  name: string;
  decimals: number;
  withdrawToken: Decimal;
  amountNative: BN;
};

type BankOnChainContext = {
  tokenProgram: PublicKey;
  destinationTokenAccount: PublicKey;
  liquidityVault: PublicKey;
  liquidityVaultAuthority: PublicKey;
  remainingAccounts: AccountMeta[];
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += ch;
  }

  out.push(current);
  return out;
}

function parseCsv(filePath: string): Record<string, string>[] {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const header = parseCsvLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length !== header.length) {
      throw new Error(
        `CSV parse error on line ${i + 1}: expected ${header.length} fields, got ${fields.length}`,
      );
    }

    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = fields[j];
    }
    rows.push(row);
  }

  return rows;
}

function sanitizeNumeric(raw: string): string {
  return raw.replace(/[$,\s]/g, "").replace(/^"|"$/g, "").trim();
}

function decimalFromCsv(raw: string, field: string): Decimal {
  const sanitized = sanitizeNumeric(raw);
  if (!sanitized) {
    throw new Error(`Missing numeric value for ${field}`);
  }
  return new Decimal(sanitized);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function addLutKeysFromIx(
  ix: TransactionInstruction,
  keyMap: Map<string, PublicKey>,
) {
  const programId = ix.programId.toBase58();
  if (!keyMap.has(programId)) {
    keyMap.set(programId, ix.programId);
  }

  for (const key of ix.keys) {
    if (key.isSigner) {
      continue;
    }
    const pk = key.pubkey.toBase58();
    if (!keyMap.has(pk)) {
      keyMap.set(pk, key.pubkey);
    }
  }
}

async function fetchLutOrThrow(
  connection: ReturnType<typeof commonSetup>["connection"],
  lut: PublicKey,
): Promise<AddressLookupTableAccount> {
  const lookup = await connection.getAddressLookupTable(lut);
  if (!lookup.value) {
    throw new Error(`LUT not found on-chain: ${lut.toBase58()}`);
  }
  return lookup.value;
}

async function shouldAddCreateAtaIx(
  mode: Config["ATA_CREATE_MODE"],
  connection: ReturnType<typeof commonSetup>["connection"],
  destinationAta: PublicKey,
  createdAtaInBatch: Set<string>,
  ataExistsCache: Map<string, boolean>,
): Promise<boolean> {
  if (mode === "never") {
    return false;
  }

  const ataStr = destinationAta.toBase58();
  if (createdAtaInBatch.has(ataStr)) {
    return false;
  }

  if (mode === "always") {
    return true;
  }

  let exists = ataExistsCache.get(ataStr);
  if (exists === undefined) {
    const accInfo = await connection.getAccountInfo(destinationAta);
    exists = !!accInfo;
    ataExistsCache.set(ataStr, exists);
  }

  return !exists;
}

function buildWithdrawalPlan(csvRows: Record<string, string>[]): ParsedWithdrawRow[] {
  const out: ParsedWithdrawRow[] = [];

  for (const row of csvRows) {
    const withdrawToken = decimalFromCsv(
      row["to withdraw (token)"],
      "to withdraw (token)",
    );
    if (withdrawToken.isNegative()) {
      continue;
    }

    const decimalsRaw = row["decimals"];
    const decimals = Number.parseInt(decimalsRaw, 10);
    if (!Number.isFinite(decimals) || decimals < 0) {
      throw new Error(`Invalid decimals '${decimalsRaw}' for bank ${row["bank"]}`);
    }

    const amountNativeDecimal = withdrawToken
      .abs()
      .mul(new Decimal(10).pow(decimals));
    const amountNativeRounded = amountNativeDecimal.toDecimalPlaces(
      0,
      Decimal.ROUND_FLOOR,
    );

    if (!amountNativeRounded.eq(amountNativeDecimal)) {
      console.warn(
        `[${row["bank"]}] amount ${withdrawToken.abs().toString()} had extra precision; rounding down to ${amountNativeRounded.toString()} native units.`,
      );
    }

    if (amountNativeRounded.lte(0)) {
      continue;
    }

    out.push({
      bank: new PublicKey(row["bank"]),
      mint: new PublicKey(row["mint"]),
      name: row["name"],
      decimals,
      withdrawToken,
      amountNative: new BN(amountNativeRounded.toFixed(0)),
    });
  }

  return out;
}

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    DEFAULT_WALLET_PATH,
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;
  const program = user.program;

  const payerKey = sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER;
  const adminKey = sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER;

  const csvPath = join(__dirname, config.CSV_FILE);
  const rows = parseCsv(csvPath);
  const withdrawPlan = buildWithdrawalPlan(rows);

  console.log(`Loaded ${rows.length} CSV rows from ${csvPath}`);
  console.log(
    `Selected ${withdrawPlan.length} banks with non-negative 'to withdraw (token)' values.`,
  );
  console.log(`ATA create mode: ${config.ATA_CREATE_MODE}`);

  if (withdrawPlan.length === 0) {
    console.log("Nothing to withdraw. Exiting.");
    return;
  }

  const lut = await fetchLutOrThrow(connection, config.LUT);
  const batches = chunk(withdrawPlan, config.BATCH_SIZE);

  const mintOwnerCache = new Map<string, PublicKey>();
  const ataExistsCache = new Map<string, boolean>();

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const ixes: TransactionInstruction[] = [];
    const createdAtaInBatch = new Set<string>();
    let createAtaIxCount = 0;
    const lutKeys = new Map<string, PublicKey>();
    const amountTable: Array<{
      bank: string;
      name: string;
      amount_native: string;
      amount_token: string;
    }> = [];

    for (const item of batch) {
      const bankAcc = await program.account.bank.fetch(item.bank);

      if (!bankAcc.group.equals(config.GROUP)) {
        throw new Error(
          `Bank ${item.bank.toBase58()} belongs to ${bankAcc.group.toBase58()}, expected ${config.GROUP.toBase58()}`,
        );
      }

      if (!bankAcc.mint.equals(item.mint)) {
        throw new Error(
          `CSV mint mismatch for ${item.bank.toBase58()}: csv=${item.mint.toBase58()} onchain=${bankAcc.mint.toBase58()}`,
        );
      }

      if (bankAcc.mintDecimals !== item.decimals) {
        console.warn(
          `Decimals mismatch for ${item.bank.toBase58()}: csv=${item.decimals} onchain=${bankAcc.mintDecimals}. Using csv decimals as requested.`,
        );
      }

      const mintKey = item.mint.toBase58();
      let tokenProgram = mintOwnerCache.get(mintKey);
      if (!tokenProgram) {
        const mintAccountInfo = await connection.getAccountInfo(item.mint);
        if (!mintAccountInfo) {
          throw new Error(`Mint account not found: ${item.mint.toBase58()}`);
        }
        tokenProgram = mintAccountInfo.owner;
        mintOwnerCache.set(mintKey, tokenProgram);
      }

      const bankCtx: BankOnChainContext = {
        tokenProgram,
        destinationTokenAccount: getAssociatedTokenAddressSync(
          item.mint,
          config.DESTINATION_WALLET,
          true,
          tokenProgram,
        ),
        liquidityVault: deriveLiquidityVault(program.programId, item.bank)[0],
        liquidityVaultAuthority: deriveLiquidityVaultAuthority(
          program.programId,
          item.bank,
        )[0],
        remainingAccounts: tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
          ? [{ pubkey: item.mint, isSigner: false, isWritable: false }]
          : [],
      };

      const includeCreateAtaIx = await shouldAddCreateAtaIx(
        config.ATA_CREATE_MODE,
        connection,
        bankCtx.destinationTokenAccount,
        createdAtaInBatch,
        ataExistsCache,
      );

      if (includeCreateAtaIx) {
        const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          payerKey,
          bankCtx.destinationTokenAccount,
          config.DESTINATION_WALLET,
          item.mint,
          bankCtx.tokenProgram,
        );
        ixes.push(createAtaIx);
        addLutKeysFromIx(createAtaIx, lutKeys);
        createdAtaInBatch.add(bankCtx.destinationTokenAccount.toBase58());
        createAtaIxCount++;
      }

      const withdrawIx = await program.methods
        .superAdminWithdraw(item.amountNative)
        .accounts({
          // group: config.GROUP,
          // admin: adminKey,
          bank: item.bank,
          destinationTokenAccount: bankCtx.destinationTokenAccount,
          // liquidityVaultAuthority: bankCtx.liquidityVaultAuthority,
          // liquidityVault: bankCtx.liquidityVault,
          tokenProgram: bankCtx.tokenProgram,
        })
        .remainingAccounts(bankCtx.remainingAccounts)
        .instruction();

      ixes.push(withdrawIx);
      addLutKeysFromIx(withdrawIx, lutKeys);

      amountTable.push({
        bank: item.bank.toBase58(),
        name: item.name,
        amount_native: item.amountNative.toString(),
        amount_token: item.withdrawToken.abs().toString(),
      });
    }

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();

    const v0Message = new TransactionMessage({
      payerKey: sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER,
      recentBlockhash: blockhash,
      instructions: ixes,
    }).compileToV0Message([lut]);

    const v0Tx = new VersionedTransaction(v0Message);

    console.log(
      `\n=== Batch ${batchIdx + 1}/${batches.length} (${batch.length} banks) ===`,
    );
    console.log(
      `Instructions: ${ixes.length} total (${createAtaIxCount} create-ATA + ${batch.length} withdraw)`,
    );

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
      console.log("Base58-encoded transaction:");
      console.log(encoded);
    }

    console.log("\nWithdraw amount table (actual native amount passed):");
    console.table(amountTable);

    console.log("LUT keys (paste into update_lut.ts):");
    Array.from(lutKeys.values()).forEach((key) => {
      console.log(`    new PublicKey("${key.toBase58()}"),`);
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
