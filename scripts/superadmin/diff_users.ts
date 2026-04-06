import { readFileSync } from "fs";
import { join } from "path";

type Config = {
  DRIFT_JSON: string;
  USERS_CSV: string;
};

const config: Config = {
  DRIFT_JSON: join(__dirname, "drift_accounts.json"),
  USERS_CSV: join(__dirname, "users_maybe.csv"),
};

function parseArgs(): Config {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    return config;
  }

  if (args.length !== 2) {
    console.error(
      "Usage: tsx scripts/superadmin/diff_users.ts [drift_accounts.json users_maybe.csv]",
    );
    process.exit(1);
  }

  return {
    DRIFT_JSON: args[0],
    USERS_CSV: args[1],
  };
}

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
  return out.map((f) => f.trim());
}

function extractDriftPublicKeys(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${filePath}`);
  }

  const keys: string[] = [];
  for (const item of parsed) {
    const key = item?.publicKey;
    if (typeof key === "string" && key.trim().length > 0) {
      keys.push(key.trim());
    }
  }
  return keys;
}

function extractUsersPublicKeys(filePath: string): string[] {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return [];
  }

  const firstFields = parseCsvLine(lines[0]);
  const headerIdx = firstFields.findIndex(
    (f) => f.toLowerCase() === "publickey",
  );

  const keys: string[] = [];
  if (headerIdx >= 0) {
    for (let i = 1; i < lines.length; i++) {
      const row = parseCsvLine(lines[i]);
      const key = (row[headerIdx] ?? "").trim();
      if (key) {
        keys.push(key);
      }
    }
    return keys;
  }

  // No header: treat first column as the key (works for one-column list too).
  for (const line of lines) {
    const row = parseCsvLine(line);
    const key = (row[0] ?? "").trim();
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

function countDuplicates(keys: string[]): number {
  return keys.length - new Set(keys).size;
}

function diffSet(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const k of a) {
    if (!b.has(k)) {
      out.push(k);
    }
  }
  return out.sort();
}

function printList(title: string, keys: string[]) {
  console.log(`\n${title}: ${keys.length}`);
  if (keys.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const key of keys) {
    console.log(`  ${key}`);
  }
}

function main() {
  const cfg = parseArgs();

  const driftRaw = extractDriftPublicKeys(cfg.DRIFT_JSON);
  const usersRaw = extractUsersPublicKeys(cfg.USERS_CSV);

  const driftSet = new Set(driftRaw);
  const usersSet = new Set(usersRaw);

  const missingFromDrift = diffSet(usersSet, driftSet);
  const missingFromUsersCsv = diffSet(driftSet, usersSet);

  console.log("=== User Key Diff ===");
  console.log(`drift_accounts.json path: ${cfg.DRIFT_JSON}`);
  console.log(`users_maybe.csv path:    ${cfg.USERS_CSV}`);
  console.log(`drift_accounts keys:     ${driftSet.size}`);
  console.log(`users_maybe keys:        ${usersSet.size}`);
  console.log(`drift duplicate rows:    ${countDuplicates(driftRaw)}`);
  console.log(`users duplicate rows:    ${countDuplicates(usersRaw)}`);

  printList("Missing from drift_accounts.json (present in users_maybe.csv)", missingFromDrift);
  printList("Missing from users_maybe.csv (present in drift_accounts.json)", missingFromUsersCsv);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
