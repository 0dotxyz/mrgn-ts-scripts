import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  PublicKey,
  Transaction,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import Decimal from "decimal.js";

import { commonSetup } from "../../lib/common-setup";

const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";

type Config = {
  PROGRAM_ID: string;
  MULTISIG_PAYER: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

type IdlInstruction = {
  name: string;
  discriminator?: number[];
};

type Idl = {
  instructions?: IdlInstruction[];
};

function readInputBs58(): string {
  const arg = process.argv[2];
  if (arg) {
    if (existsSync(arg)) {
      return readFileSync(arg, "utf8").trim();
    }
    return arg.trim();
  }

  const fromStdin = readFileSync(0, "utf8").trim();
  if (!fromStdin) {
    console.error(
      "Usage: ts-node scripts/superadmin/decode_super_withdraw_tx_bs58.ts <bs58 | /path/to/file>\n" +
        "or: cat tx.txt | ts-node scripts/superadmin/decode_super_withdraw_tx_bs58.ts",
    );
    process.exit(1);
  }
  return fromStdin;
}

function loadMarginfiIdl(): Idl {
  const candidatePaths = [
    join(process.cwd(), "idl/marginfi.json"),
    join(__dirname, "../../idl/marginfi.json"),
  ];

  for (const p of candidatePaths) {
    try {
      return JSON.parse(readFileSync(p, "utf8")) as Idl;
    } catch {
      // try next path
    }
  }

  throw new Error(
    `Could not find idl/marginfi.json. Tried: ${candidatePaths.join(", ")}`,
  );
}

function getWithdrawDiscriminator(idl: Idl): Buffer {
  const ix = idl.instructions?.find((i) => i.name === "super_admin_withdraw");
  if (!ix?.discriminator || ix.discriminator.length !== 8) {
    throw new Error("super_admin_withdraw discriminator not found in IDL");
  }
  return Buffer.from(ix.discriminator);
}

function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

async function resolveV0AccountKeys(
  msg: any,
  connection: ReturnType<typeof commonSetup>["connection"],
): Promise<PublicKey[]> {
  const staticKeys: PublicKey[] = msg.staticAccountKeys ?? [];
  const allKeys: PublicKey[] = [...staticKeys];

  const lookups = msg.addressTableLookups ?? [];
  for (const lookup of lookups) {
    const { value: lut } = await connection.getAddressLookupTable(
      lookup.accountKey,
    );
    if (!lut) {
      throw new Error(
        `Missing LUT on-chain while decoding tx: ${lookup.accountKey.toBase58()}`,
      );
    }
    for (const idx of lookup.writableIndexes) {
      allKeys.push(lut.state.addresses[idx]);
    }
    for (const idx of lookup.readonlyIndexes) {
      allKeys.push(lut.state.addresses[idx]);
    }
  }

  return allKeys;
}

async function decodeVersioned(
  msg: any,
  connection: ReturnType<typeof commonSetup>["connection"],
): Promise<Array<{ programId: PublicKey; accounts: PublicKey[]; data: Buffer }>> {
  const allKeys = await resolveV0AccountKeys(msg, connection);
  const compiledInstructions = msg.compiledInstructions ?? [];

  return compiledInstructions.map((ix: any) => ({
    programId: allKeys[ix.programIdIndex],
    accounts: ix.accountKeyIndexes.map((i: number) => allKeys[i]),
    data: Buffer.from(ix.data),
  }));
}

function decodeLegacy(
  raw: Buffer,
): Array<{ programId: PublicKey; accounts: PublicKey[]; data: Buffer }> {
  try {
    const tx = Transaction.from(raw);
    return tx.instructions.map((ix) => ({
      programId: ix.programId,
      accounts: ix.keys.map((k) => k.pubkey),
      data: Buffer.from(ix.data),
    }));
  } catch (e: any) {
    throw new Error(
      `Failed to decode as legacy tx: ${e?.message ?? e}. ` +
        "Input is likely versioned tx/message data.",
    );
  }
}

async function main() {
  const txBs58 = readInputBs58();
  const idl = loadMarginfiIdl();
  const withdrawDisc = getWithdrawDiscriminator(idl);

  const user = commonSetup(
    false,
    config.PROGRAM_ID,
    DEFAULT_WALLET_PATH,
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;
  const program = user.program;

  const raw = Buffer.from(bs58.decode(txBs58));
  let instructions: Array<{
    programId: PublicKey;
    accounts: PublicKey[];
    data: Buffer;
  }> = [];
  let versionedTx: VersionedTransaction | null = null;
  let versionedMessage: VersionedMessage | null = null;

  try {
    versionedTx = VersionedTransaction.deserialize(raw);
  } catch {
    versionedTx = null;
  }

  if (versionedTx) {
    instructions = await decodeVersioned(versionedTx.message, connection);
    console.log("Decoded as versioned transaction");
  } else {
    try {
      versionedMessage = VersionedMessage.deserialize(raw);
    } catch {
      versionedMessage = null;
    }

    if (versionedMessage) {
      instructions = await decodeVersioned(versionedMessage, connection);
      console.log("Decoded as versioned message");
    } else {
      instructions = decodeLegacy(raw);
      console.log("Decoded as legacy transaction");
    }
  }

  const bankCache = new Map<string, { decimals: number }>();
  const rows: Array<{
    ix_index: number;
    bank: string;
    amount_native: string;
    decimals: number;
    amount_token: string;
  }> = [];

  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i];
    if (!ix.programId.equals(program.programId)) {
      continue;
    }
    if (ix.data.length < 16) {
      continue;
    }

    const disc = ix.data.subarray(0, 8);
    if (!buffersEqual(disc, withdrawDisc)) {
      continue;
    }

    if (ix.accounts.length < 3) {
      throw new Error(
        `super_admin_withdraw ix at index ${i} has too few accounts (${ix.accounts.length})`,
      );
    }

    const bank = ix.accounts[2];
    const bankKey = bank.toBase58();
    let decimals = bankCache.get(bankKey)?.decimals;
    if (decimals === undefined) {
      const bankAcc: any = await program.account.bank.fetch(bank);
      decimals = bankAcc.mintDecimals;
      bankCache.set(bankKey, { decimals });
    }

    const amountNative = ix.data.readBigUInt64LE(8);
    const amountToken = new Decimal(amountNative.toString())
      .div(new Decimal(10).pow(decimals))
      .toFixed(decimals)
      .replace(/\.?0+$/, "");

    rows.push({
      ix_index: i,
      bank: bankKey,
      amount_native: amountNative.toString(),
      decimals,
      amount_token: amountToken,
    });
  }

  if (rows.length === 0) {
    console.log("No super_admin_withdraw instructions found in transaction.");
    return;
  }

  console.log(`Found ${rows.length} super_admin_withdraw instruction(s):`);
  console.table(rows);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
