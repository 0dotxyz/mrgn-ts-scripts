import fs from "fs";
import { SNAPSHOT_PATH, clearBankMetaSnapshotCache } from "./bank-meta-utils";

const BANK_META_URL = "https://api.0.xyz/v0/bankMeta?age=86400";

async function main() {
  const response = await fetch(BANK_META_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch bank metadata: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !payload.banks) {
    throw new Error("Unexpected response shape: missing 'banks' field");
  }

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload, null, 2) + "\n");
  clearBankMetaSnapshotCache();

  const bankCount = Object.keys(payload.banks).length;
  console.log(`Refreshed ${SNAPSHOT_PATH} with ${bankCount} banks from ${BANK_META_URL}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

