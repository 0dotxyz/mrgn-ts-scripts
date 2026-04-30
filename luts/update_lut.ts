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
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("HoMNdUF3RDZDPKAARYK1mxcPFfUnPjLmpKYibZzAijev"),
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("EgCjHHmF2SRGwoqjHCicoZkbzJbPgZRN7h3eeuNZWndK"),
    new PublicKey("6os7THfmjSXjxvZ488GNJAkTtTMY56vj1FfdDwocds6i"),
    new PublicKey("2JpjFam7UcHr4Ya2PzibjNqtRogQ9YY1thxVBjsW8rgt"),
    new PublicKey("4wVn5oHj8RHkMKaAPwC2m2kufszyqDTmDqc5fan5z4X7"),
    new PublicKey("DiUe8eEdbpsXBZ9vEj9XeeyNJcqB1sXdCFj6X4579xGr"),
    new PublicKey("3WRrTKiXkQw654HJx9rsTaSg5yAWhs5Bcj7NeQN8B5pk"),
    new PublicKey("9jxKvR7KTSTTk9wiAWXqxinJ5pNrs9j4oCHaXuJQmsQz"),
    new PublicKey("7ApYr9oQxTbtuh2cuU8jdPfUEg7LSQevjkYaRxku8cdN"),
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
    new PublicKey("6os7THfmjSXjxvZ488GNJAkTtTMY56vj1FfdDwocds6i"),
    new PublicKey("Ai1PZuTEfNjFib24GTBpAXRsVs62HkSYpw2sHUQiQ8Sr"),
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
