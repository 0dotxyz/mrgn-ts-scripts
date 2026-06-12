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
    new PublicKey("2Ux4yKTTxQf14MzxRPUyybw9akqHC5jnViF1iKWZRxMb"),
    new PublicKey("BsrjGaXJNmzXBK855wXev2Jb846AbyRCoA6R8TnpfrNM"),
    new PublicKey("9cizJpitym7CGL2QauvgG4BtTvSeADvppUpwGTPRc6De"),
    new PublicKey("GpNuWCghujQQNyyX1qv2p2r7WpX2hD6UyPnN8rRDGLs"),
    new PublicKey("GpNuWCghujQQNyyX1qv2p2r7WpX2hD6UyPnN8rRDGLs"),
    new PublicKey("44digRwKFeyiqDaxJRE6iag4cbXECKjG54v5ozxdu5mu"),
    new PublicKey("AyeEyCiBU2CzZmxz3f3o3vk2hvMsM5G3t3D6vhLsiFkf"),
    new PublicKey("5WL5CnjWT71NPgj8iQR2FU5H3FsVci9cnsHSNJzxj788"),
    new PublicKey("9ojzV5xFHtx2h2GhKRSgCwJK3BLswczdiiLW3hsyRE5c"),
    new PublicKey("GZK3yC3Kfn1ykFhLryzeKqemRNZ3wpZgWhbh5b5ygGML"),
    new PublicKey("5xVGr3pAWDtWPLcf6YsQTjKm6pGqLnJrENQXGajdP2wZ"),
    new PublicKey("Emb5g6cEbRU2Yq9ZQnKhRDQLNRLSMWdgYRvJrBHzH6yB"),
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
    new PublicKey("8UEiPmgZHXXEDrqLS3oiTxQxTbeYTtPbeMBxAd2XGbpu"),
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
    new PublicKey("5syijTAMBBmdjwUgYYBvvv26zTS6YX1bYV9EdXkgYqLa"),
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
    new PublicKey("8efP4VoKDo3SqxoVCUcgxpN9S7boDWtPmeFwahRZ4ukg"),
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
