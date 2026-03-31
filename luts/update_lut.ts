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
} from "../scripts/utils";
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
  LUT: new PublicKey("3XpcTktgNzeMv2ATg4Y6yLgE5Wfxebcb8Tb9zj755PhH"),
  KEYS: [
    new PublicKey("FsqEotn7wcZvyMV214BbQRUJwbwLujDGHHBNrM5tzN6Z"),
    new PublicKey("3vejrc7HzHszWjn5YpntjiQEtJNB4Yd1Fff2cs9Hh7JZ"),
    new PublicKey("H24JXW3k7y8B8x2zBXhHyCtfVvZJZFYkKh7iV7hB47UF"),
    new PublicKey("B8rYZr3vpN45fREYqZQ7brxvM6j4brH6D1JWT1FwqzLo"),
    new PublicKey("5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6"),
    new PublicKey("GcV9tEj62VncGithz4o4N9x6HWXARxuRgEAYk9zahNA8"),
    new PublicKey("3Q4kx6MUF6HrKUk6ryK28VaZkfTYfm8bwwWbaomEQTTm"),
    new PublicKey("FGFqvYQis8sg8xEkPWcNxc4hsrMz6UAHSW4rWK3CSZGr"),
    new PublicKey("EMCFG8nFXas42F26CR6KryWBTGvv2Tb1WjAhU6ASpWnt"),
    new PublicKey("CYH54HYnAp3fPkWXJ1GNdCwHpCWPxY3oEJWussB7QhEb"),
    new PublicKey("ATNeEjgUCkeRr11tx3SyRfejyKuqC8WyahfPtzFdA2dZ"),
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
