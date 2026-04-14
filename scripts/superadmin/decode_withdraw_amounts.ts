import { readFileSync } from "fs";
import { join } from "path";

type IdlInstruction = {
  name: string;
  discriminator?: number[];
};

type IdlEvent = {
  name: string;
  discriminator?: number[];
};

type Idl = {
  instructions?: IdlInstruction[];
  events?: IdlEvent[];
};

function bufEq(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.equals(b);
}

function toDiscBuffer(disc: number[] | undefined, label: string): Buffer {
  if (!disc || disc.length !== 8) {
    throw new Error(`Missing/invalid 8-byte discriminator for ${label}`);
  }
  return Buffer.from(disc);
}

function readInputText(): string {
  const fileArg = process.argv[2];
  if (fileArg) {
    return readFileSync(fileArg, "utf8");
  }
  // Read from stdin when no file path is provided.
  return readFileSync(0, "utf8");
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

function extractProgramDataB64(text: string): string[] {
  const re = /Program data:\s*([A-Za-z0-9+/=]+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function decodeU64LE(buf: Buffer, offset: number): bigint {
  if (offset < 0 || offset + 8 > buf.length) {
    throw new Error(`u64 offset out of range: ${offset} (len=${buf.length})`);
  }
  return buf.readBigUInt64LE(offset);
}

function main() {
  const text = readInputText();
  const idl = loadMarginfiIdl();

  const superWithdrawIxDisc = toDiscBuffer(
    idl.instructions?.find((i) => i.name === "super_admin_withdraw")
      ?.discriminator,
    "instructions.super_admin_withdraw",
  );
  const superWithdrawEventDisc = toDiscBuffer(
    idl.events?.find((e) => e.name === "LendingPoolSuperAdminWithdrawEvent")
      ?.discriminator,
    "events.LendingPoolSuperAdminWithdrawEvent",
  );

  const b64Rows = extractProgramDataB64(text);
  if (b64Rows.length === 0) {
    console.error(
      "No 'Program data:' lines found. Paste explorer simulation output (or pass a file path).",
    );
    process.exit(1);
  }

  const decoded = b64Rows.map((b64, idx) => ({
    idx: idx + 1,
    b64,
    buf: Buffer.from(b64, "base64"),
  }));

  const superWithdrawInputAmounts: bigint[] = [];
  const superWithdrawEventAmounts: bigint[] = [];

  for (const row of decoded) {
    if (row.buf.length < 16) {
      continue;
    }

    const disc = row.buf.subarray(0, 8);

    // Instruction payload: 8-byte discriminator + u64 amount
    if (bufEq(disc, superWithdrawIxDisc)) {
      const amount = decodeU64LE(row.buf, 8);
      superWithdrawInputAmounts.push(amount);
      console.log(
        `[Program data #${row.idx}] super_admin_withdraw instruction amount = ${amount.toString()}`,
      );
      continue;
    }

    // Event payload: discriminator + event fields, amount is final u64
    if (bufEq(disc, superWithdrawEventDisc)) {
      const amount = decodeU64LE(row.buf, row.buf.length - 8);
      superWithdrawEventAmounts.push(amount);
      console.log(
        `[Program data #${row.idx}] LendingPoolSuperAdminWithdrawEvent vault_outflow_amount = ${amount.toString()}`,
      );
      continue;
    }
  }

  console.log("\nSummary:");
  console.log(
    `  super_admin_withdraw instruction amounts found: ${superWithdrawInputAmounts.length}`,
  );
  console.log(
    `  super_admin_withdraw event amounts found:       ${superWithdrawEventAmounts.length}`,
  );

  if (superWithdrawInputAmounts.length > 0) {
    console.log(
      `  instruction amounts: ${superWithdrawInputAmounts.map((v) => v.toString()).join(", ")}`,
    );
  }
  if (superWithdrawEventAmounts.length > 0) {
    console.log(
      `  event amounts:       ${superWithdrawEventAmounts.map((v) => v.toString()).join(", ")}`,
    );
  }

  if (
    superWithdrawInputAmounts.length === 0 &&
    superWithdrawEventAmounts.length === 0
  ) {
    console.error(
      "No super_admin_withdraw instruction/event payloads found in provided simulation text.",
    );
    process.exit(2);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
