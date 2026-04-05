import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  AccountMeta,
  AddressLookupTableAccount,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import Decimal from "decimal.js";
import { readFileSync } from "fs";
import { join } from "path";

import { commonSetup } from "../../lib/common-setup";
import { deriveLiquidityVault } from "../common/pdas";

const sendTx = false;
const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  ADMIN_SOURCE_WALLET: PublicKey;
  MULTISIG_PAYER: PublicKey;
  LUT: PublicKey;
  CSV_FILE: string;
  BATCH_SIZE: number;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  ADMIN_SOURCE_WALLET: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  LUT: new PublicKey("3XpcTktgNzeMv2ATg4Y6yLgE5Wfxebcb8Tb9zj755PhH"),
  CSV_FILE: "super_admin_table.csv",
  BATCH_SIZE: 10,
};

type ParsedDepositRow = {
  bank: PublicKey;
  mint: PublicKey;
  name: string;
  decimals: number;
  withdrawToken: Decimal;
  amountNative: BN;
};

type BankOnChainContext = {
  tokenProgram: PublicKey;
  adminTokenAccount: PublicKey;
  liquidityVault: PublicKey;
  remainingAccounts: AccountMeta[];
};

type AtaBalanceSnapshot = {
  exists: boolean;
  amountNative: string;
  amountToken: string;
  decimals: number;
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

async function readAtaBalance(
  connection: ReturnType<typeof commonSetup>["connection"],
  ata: PublicKey,
  decimalsHint: number,
): Promise<AtaBalanceSnapshot> {
  const ataInfo = await connection.getAccountInfo(ata);
  if (!ataInfo) {
    return {
      exists: false,
      amountNative: "0",
      amountToken: "0",
      decimals: decimalsHint,
    };
  }

  const balance = await connection.getTokenAccountBalance(ata);
  const decimals = balance.value.decimals;
  const amountNative = balance.value.amount;
  const amountToken =
    balance.value.uiAmountString ??
    new Decimal(amountNative).div(new Decimal(10).pow(decimals)).toString();

  return {
    exists: true,
    amountNative,
    amountToken,
    decimals,
  };
}

function buildDepositPlan(csvRows: Record<string, string>[]): ParsedDepositRow[] {
  const out: ParsedDepositRow[] = [];

  for (const row of csvRows) {
    const withdrawToken = decimalFromCsv(
      row["to withdraw (token)"],
      "to withdraw (token)",
    );

    // Deposit the opposite side of withdraw: negative "to withdraw" means vault inflow.
    if (!withdrawToken.isNegative()) {
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

  const adminKey = sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER;

  const csvPath = join(__dirname, config.CSV_FILE);
  const rows = parseCsv(csvPath);
  const depositPlan = buildDepositPlan(rows);

  console.log(`Loaded ${rows.length} CSV rows from ${csvPath}`);
  console.log(
    `Selected ${depositPlan.length} banks with negative 'to withdraw (token)' values for deposit.`,
  );

  if (depositPlan.length === 0) {
    console.log("Nothing to deposit. Exiting.");
    return;
  }

  const lut = await fetchLutOrThrow(connection, config.LUT);
  const batches = chunk(depositPlan, config.BATCH_SIZE);
  const mintOwnerCache = new Map<string, PublicKey>();
  const ataBalanceCache = new Map<string, AtaBalanceSnapshot>();

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const ixes: TransactionInstruction[] = [];
    const lutKeys = new Map<string, PublicKey>();
    const amountTable: Array<{
      bank: string;
      name: string;
      amount_native: string;
      amount_token: string;
      admin_token_account: string;
    }> = [];
    const ataBalanceTable: Array<{
      bank: string;
      name: string;
      mint: string;
      admin_token_account: string;
      ata_exists: boolean;
      ata_amount_native: string;
      ata_amount_token: string;
      planned_deposit_native: string;
      planned_deposit_token: string;
      sufficient_for_planned_deposit: string;
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
        adminTokenAccount: getAssociatedTokenAddressSync(
          item.mint,
          config.ADMIN_SOURCE_WALLET,
          true,
          tokenProgram,
        ),
        liquidityVault: deriveLiquidityVault(program.programId, item.bank)[0],
        remainingAccounts: tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
          ? [{ pubkey: item.mint, isSigner: false, isWritable: false }]
          : [],
      };

      if (!bankAcc.liquidityVault.equals(bankCtx.liquidityVault)) {
        throw new Error(
          `Liquidity vault mismatch for ${item.bank.toBase58()}: derived=${bankCtx.liquidityVault.toBase58()} onchain=${bankAcc.liquidityVault.toBase58()}`,
        );
      }

      if (!item.mint.equals(NATIVE_MINT)) {
        const ataKey = bankCtx.adminTokenAccount.toBase58();
        let ataBalance = ataBalanceCache.get(ataKey);
        if (!ataBalance) {
          ataBalance = await readAtaBalance(
            connection,
            bankCtx.adminTokenAccount,
            item.decimals,
          );
          ataBalanceCache.set(ataKey, ataBalance);
        }

        const hasEnough =
          ataBalance.exists &&
          new BN(ataBalance.amountNative).gte(item.amountNative);

        ataBalanceTable.push({
          bank: item.bank.toBase58(),
          name: item.name,
          mint: item.mint.toBase58(),
          admin_token_account: ataKey,
          ata_exists: ataBalance.exists,
          ata_amount_native: ataBalance.amountNative,
          ata_amount_token: ataBalance.amountToken,
          planned_deposit_native: item.amountNative.toString(),
          planned_deposit_token: item.withdrawToken.abs().toString(),
          sufficient_for_planned_deposit: hasEnough ? "yes" : "no",
        });
      }

      if (item.mint.equals(NATIVE_MINT)) {
        // Ensure WSOL ATA exists and is funded for this deposit amount.
        const createWsolAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER,
          bankCtx.adminTokenAccount,
          config.ADMIN_SOURCE_WALLET,
          item.mint,
          bankCtx.tokenProgram,
        );
        ixes.push(createWsolAtaIx);
        addLutKeysFromIx(createWsolAtaIx, lutKeys);

        if (item.amountNative.gt(new BN(Number.MAX_SAFE_INTEGER.toString()))) {
          throw new Error(
            `WSOL wrap amount exceeds JS safe integer: ${item.amountNative.toString()} for bank ${item.bank.toBase58()}`,
          );
        }

        const wrapLamportsIx = SystemProgram.transfer({
          fromPubkey: adminKey,
          toPubkey: bankCtx.adminTokenAccount,
          lamports: item.amountNative.toNumber(),
        });
        ixes.push(wrapLamportsIx);
        addLutKeysFromIx(wrapLamportsIx, lutKeys);

        const syncNativeIx = createSyncNativeInstruction(
          bankCtx.adminTokenAccount,
        );
        ixes.push(syncNativeIx);
        addLutKeysFromIx(syncNativeIx, lutKeys);
      }

      const depositIx = await program.methods
        .superAdminDeposit(item.amountNative)
        .accounts({
          // group: config.GROUP,
          // admin: adminKey,
          bank: item.bank,
          adminTokenAccount: bankCtx.adminTokenAccount,
          // liquidityVault: bankCtx.liquidityVault,
          tokenProgram: bankCtx.tokenProgram,
        })
        .remainingAccounts(bankCtx.remainingAccounts)
        .instruction();

      ixes.push(depositIx);
      addLutKeysFromIx(depositIx, lutKeys);

      amountTable.push({
        bank: item.bank.toBase58(),
        name: item.name,
        amount_native: item.amountNative.toString(),
        amount_token: item.withdrawToken.abs().toString(),
        admin_token_account: bankCtx.adminTokenAccount.toBase58(),
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
    console.log(`Instructions: ${ixes.length} total (${batch.length} deposit)`);

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

    console.log("\nDeposit amount table (actual native amount passed):");
    console.table(amountTable);
    console.log(
      "\nSource ATA balance table (non-SOL mints, read before tx assembly):",
    );
    console.table(ataBalanceTable);

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
