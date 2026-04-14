import bs58 from "bs58";
import { loadEnvFile } from "./utils";
import { Keypair } from "@solana/web3.js";

const ENV_FILE = ".env.api";
const ENV_VAR = "SECRET_KEY_BYTES";

// NOTE: Put your secret key bytes in .env.api like [1, 2, 3 .....]

async function main() {
  const secret = loadSecretKey();
  const kp = Keypair.fromSecretKey(secret);

  console.log("Public Key:", kp.publicKey.toBase58());
  // WARN WARN WARN WARN WARN DON'T SHARE THIS WARN WARN WARN WARN DON'T DO IT DON'T DO IT DON'T
  // SHARE IT JUST DON'T SHARE IT IF YOU'RE THINKING OF SHARING IT THEN STOP AND DON'T.
  console.log("Base58 Secret Key:", bs58.encode(secret));
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

function loadSecretKey(): Uint8Array {
  loadEnvFile(".env.api");

  const raw = process.env[ENV_VAR];
  if (!raw) {
    console.error(`Env var "${ENV_VAR}" not found in ${ENV_FILE}`);
    process.exit(1);
  }

  if (raw.trim().startsWith("[")) {
    try {
      const nums = JSON.parse(raw) as number[];
      return Uint8Array.from(nums);
    } catch (e) {
      console.error(`Failed to parse JSON in ${ENV_VAR}:`, e);
      process.exit(1);
    }
  }

  try {
    return bs58.decode(raw);
  } catch (e) {
    console.error(`Failed Base58‑decoding ${ENV_VAR}:`, e);
    process.exit(1);
  }
}
