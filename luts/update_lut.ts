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
    new PublicKey("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"),
    new PublicKey("EQs18wjcya2x2CtwhqiWXGWu1frDzUjM2e2BSniBQoj4"),
    new PublicKey("3ZUAwhEtK8XWfK4fy98z4yoptm4GeyeAu21L11HPXaZ5"),
    new PublicKey("9vVq1V2LaTqGRbNn1Zi7t9EvJEVCxj2x3Tr7Z2vhJi1N"),
    new PublicKey("FWzVLfbuRFhK7uomEtn37CKosoGpyUeaLXJZp9oTV7x4"),
    new PublicKey("qVFWku45kSpcE8gYFcCkokwVkHJiSoXvpzLWArk9RBh"),
    new PublicKey("FnyGPZ5QJYbzPXZNmVWTwiqdqttwehe2Rj2m825xNddZ"),
    new PublicKey("EEE8ZygveEQEaB2Wx6q1WhcZzsXFjUKmf9gFcHb63Tay"),
    new PublicKey("AyPSLDKhhnSpjMp5pVwAitkcAscJTkMu13yPwaG4bAzf"),
    new PublicKey("5oF69G27BMEpt3PMXWxPUYKEUqHsh4AecamJwmHeNZHK"),
    new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("9zXQxpYH3kYhtoybmZfUNNCRVuud7fY9jswTg1hLyT8k"),
    new PublicKey("FPg5uNfGmPCTqJzS71mBVucMw5CRiSgGsznHXGRFgdaB"),
    new PublicKey("8Ux9C8b85LtJYkC2wM8FxgGFk2BwhTBQJSG6JsBEucUQ"),
    new PublicKey("CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA"),
    new PublicKey("9SLBVnPz8dRGvafST6zNBZYSSt3HtdU68XQLGR13t3uM"),
    new PublicKey("4LF3i8grZPRbk8d6gXvzRux4rYjGd5AmqrpLLYFpPKKt"),
    new PublicKey("2d835sBokkyWMeiZ7SzwFxkGefsSDYi48paVWmYDs4Zo"),
    new PublicKey("41cVGqN41zAk4dgC28cHBX5ANkEUr7pxHimHjELcu3Aw"),
    new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
    new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
    new PublicKey("2GKWQPxTUG2JmY4VixKLE95nzwspXxNeHHrEM4x7maTc"),
    new PublicKey("4ReiBniCcYNJxFTMGJC4J2Mneek4VDedigRwoPbKc1LL"),
    new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
    new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"),
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
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
