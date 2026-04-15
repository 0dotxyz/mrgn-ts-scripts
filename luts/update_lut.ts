import {
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  DEFAULT_API_URL,
  loadEnvFile,
  loadKeypairFromFile,
} from "../scripts/utils/utils";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

// TODO support deduping accross multiple LUTs and add the first non-full LUT

type Config = {
  LUT: PublicKey;
  KEYS: PublicKey[];
};

const config: Config = {
  LUT: new PublicKey("C83sPjiLpUU5oGtEjYo5i1LoRagSsdPj62SaLsWWUN3T"),
  KEYS: [
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    new PublicKey("VnVjbrytWcxTi6nCASMryKm4vHwpVZvwJetE2W1w5gB"),
    new PublicKey("9GJ9GBRwCp4pHmWrQ43L5xpc9Vykg7jnfwcFGN8FoHYu"),
    new PublicKey("74ZA1xw8A3gfUP56Jj76yZbgFt4Nj9TvbAReZBYmVbWC"),
    new PublicKey("9x6StiGodcKvKrQrrBGxfpku9XopC57XP17CGqeKNrjG"),
    new PublicKey("66kvQZbAswWz8yBXzPHtYHTeUqMZET9TXtCT3FZ6kpuD"),
    new PublicKey("DPRbUCGzXcBGJ44ym9SvF4Z2L26YbW7mFZ3UqUW5BUK7"),
    new PublicKey("2SBAcCGUmECPUViJhXg92932kjXNc8ktDRcZ9ooNk19n"),
    new PublicKey("6ci3vGBTh8RFp2mesM1UeVYCyZHL7fyi1STmZHpKzJ8X"),
    new PublicKey("CsMm6Fa4b25JV25u49MoQkJKLGDkfyVhBCvyaJn1aiNP"),
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("4C9r6qeen5pbAC4ikJaQXBJmWg1LyYJAbUCnt1nkj6ry"),
    new PublicKey("ArSVtzrESaMqD82hbaLWC2gKXhuv4VMyoY7E2jTVgZa2"),
    new PublicKey("CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA"),
    new PublicKey("9SLBVnPz8dRGvafST6zNBZYSSt3HtdU68XQLGR13t3uM"),
    new PublicKey("H6JUwz8c61eQnYUx8avGXydKztKPyGvgWAUjmZUPS3BC"),
    new PublicKey("DKaVQFXD6Qz4USTkRWyPun3oU6r1RfYsWJ8YqLpnSnN5"),
    new PublicKey("CtgiQTkAQp8h1ayqdE21Cr56qekdqeQ19da3j1KLgSUn"),
    new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
    new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
    new PublicKey("B45JYN5DszxjmYXfmXSmu5VovtKU8FWQ9G4fJrS3WHQU"),
    new PublicKey("HqEqwkTmqCAVEQQaEBuSSGD2EAvcorFogqhZz46TYJyz"),
    new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"),
    new PublicKey("Sysvar1nstructions1111111111111111111111111"),
    new PublicKey("SysvarRent111111111111111111111111111111111"),
  ],
};

async function main() {
  await updateLut(sendTx, config, "/.config/solana/id.json");
}

export async function updateLut(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
  loadEnvFile(".env.api");
  const apiUrl = process.env.API_URL || DEFAULT_API_URL;
  console.log("api: " + apiUrl);
  const connection = new Connection(apiUrl, "confirmed");
  const wallet = loadKeypairFromFile(process.env.HOME + walletPath);

  const transaction = new Transaction();

  const lutAccount = await connection.getAddressLookupTable(config.LUT);
  if (!lutAccount.value) {
    throw new Error("Failed to fetch the lookup table account");
  }

  // Extract the existing addresses from the lookup table
  const existingAddresses = lutAccount.value.state.addresses;
  const existingSet = new Set(
    existingAddresses.map((addr: PublicKey) => addr.toBase58()),
  );

  // Filter out keys that are already in the lookup table
  const keysToAdd = config.KEYS.filter(
    (key) => !existingSet.has(key.toBase58()),
  );
  if (keysToAdd.length === 0) {
    console.log(
      "No new keys to add, lookup table is already up to date, aborting.",
    );
    return;
  } else {
    console.log("Adding the following new keys, others already in the LUT");
    for (let i = 0; i < keysToAdd.length; i++) {
      console.log("[" + i + "] " + keysToAdd[i]);
    }
    console.log("");
  }

  // Create the instruction to extend the lookup table with the deduped keys
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    authority: wallet.publicKey,
    lookupTable: config.LUT,
    payer: wallet.publicKey,
    addresses: keysToAdd,
  });
  transaction.add(extendIx);

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet],
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: true,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
