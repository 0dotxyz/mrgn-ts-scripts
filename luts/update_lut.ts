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
    new PublicKey("USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA"),
    new PublicKey("4VgNUPbdTNJ6a8NcLZDrjqtxpRk1fK7NDpMBSmvGVwHn"),
    new PublicKey("7SzMWArC8WAenndXFmRyfvcvrNPodqUFkmPrmmoRZvn4"),
    new PublicKey("GQXa12MUT4VBijrdsgLjLW9Gm2NcKY6z1GEuGQ9RZnUG"),
    new PublicKey("4APdiiokyNHprU4ad1Tjkk8nG4AGm1X7TTGuVgdahxnm"),
    new PublicKey("A7sgCQXcp57aE12dmmke4vVvWjTfrGq7XnTsbsX7aDuq"),
    new PublicKey("FUSmKEWGCUsPiBxtnxrxD6RGG2hFGWPJeawYLDrhBRH5"),
    new PublicKey("ABFQWChwkHgjaBTif7PZQwpURnBsdYyeYJASafr6CYVk"),
    new PublicKey("5FzhwSgLVMTa7wKRvoJspnMjKLKJrtZo3zdSxQTWGWtB"),
    new PublicKey("bxo8QRcVLZQrxPq566aRzF43ndVP2zd3XwyCnwsFiV2"),
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("EtEbRr1fiigYs51PVaX6Ldupda4aMxz9qQE2iTBwLpZD"),
    new PublicKey("BgfHEvVwMJfpXJ23XDAdmnbypeRCTy7SqfVfkp1wa6K8"),
    new PublicKey("25WG1Xs9ebNFseoEFUY76V7rSP5e9pFkRbnuGAgQXdxP"),
    new PublicKey("CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA"),
    new PublicKey("9SLBVnPz8dRGvafST6zNBZYSSt3HtdU68XQLGR13t3uM"),
    new PublicKey("5tP1kDJBYnjtrpUaRQhsrU1Y28ahiJVjz8p9mbqJFpz5"),
    new PublicKey("66VV9X7UovT9QbbwzQmBCDyC4FDgxfyArVWGXcR9CfLk"),
    new PublicKey("CjXKMfFgRnPUmZ3YqFqhLjeCwittrpdsj71jXB7aPerA"),
    new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
    new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
    new PublicKey("CGCbJTdYqHwXnyHGCdCGDmGosh2s4iKmTUmxuzsy8qFr"),
    new PublicKey("2ReqXnaMZJD91WpeikFoYwbkCUCvWcHYrM6jze6WkokT"),
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
