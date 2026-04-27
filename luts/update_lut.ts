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
    new PublicKey("8W3GgWFFnHdd98GKGzvNNi9Wzjoq2CU4wW6cHz6cKxk1"),
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("HoMNdUF3RDZDPKAARYK1mxcPFfUnPjLmpKYibZzAijev"),
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("phaseZSfPxTDBpiVb96H4XFSD8xHeHxZre5HerehBJG"),
    new PublicKey("5Tj1B7bT8PSyKjUCBxiUNe5C2Pn59NhA2ohmdj3RPpE5"),
    new PublicKey("5zqnB8kRX687APdVXaffaJPmDkPrYfZgsF1xEr1ejMRk"),
    new PublicKey("BvN7jJrLSzvJUd3FcR2kjvfzX6zPRkxBdMoK4Whz4cvD"),
    new PublicKey("DNtPGU9HnS1dbun1kQNzQhofxY8ejCmznvAT8DSzkqqK"),
    new PublicKey("5FBKoSCuuafqWNyQoDBEnioyPJgasbAeUUVVbNnshtWP"),
    new PublicKey("39RDtRHtFSVeK9y7MZXYRMSrEgP7t6DAtBbEXqiuPK1X"),
    new PublicKey("9GqsYwDCjT87XgC91B6Agnp417zjGWh1G3mXdAfNz1sp"),
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("5Tj1B7bT8PSyKjUCBxiUNe5C2Pn59NhA2ohmdj3RPpE5"),
    new PublicKey("6xVPyY4x9VA4VF7yMfUsrtymLTWRzAa8FEnUwexBYeu"),
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
