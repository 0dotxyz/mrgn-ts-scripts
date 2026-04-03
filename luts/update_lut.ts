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
  LUT: new PublicKey("inzqinzgHh3muPvSWLqtabt9MJayhVVfTm2eE87RTfC"),
  KEYS: [
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    new PublicKey("7xMyFsPEhCEeuWyNnwkrAQhPVJ3iRu1icmcZJdrv85tA"),
    new PublicKey("AnGdBvg8VmVHq7zyUYmC7mgjZ5pW6odwFsh6eharbzLu"),
    new PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    new PublicKey("11111111111111111111111111111111"),
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
    new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    new PublicKey("Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8"),
    new PublicKey("7Ng54qf7BrCcZLqXmKA9WSR7SVRn4q6RX1YpLksBQ21A"),
    new PublicKey("38VGtXd2pDPq9FMh1z6AVjcHCoHgvWyMhdNyamDTeeks"),
    new PublicKey("HMEFVtz5sWT4enWmahyw4WyHK4nP9kKYHhPZ4adZhHvT"),
    new PublicKey("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
    new PublicKey("22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE"),
    new PublicKey("6YxGd65JbXzgFGWjE44jsyVeCnZp7Bb1wfL9jDia1n8w"),
    new PublicKey("B6HqNn83a2bLqo4i5ygjLHJgD11ePtQksUyx4MjD55DV"),
    new PublicKey("GpUfazcpuhTqAVNQvrvXyheq5NH87pfzR9Zkn7nFYM7r"),
    new PublicKey("jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v"),
    new PublicKey("8LaUZadNqtzuCG7iCvZd7d5cbquuYfv19KjAg6GPuuCb"),
    new PublicKey("93Qqsge2jHVsWLd8vas4cWghrsZJooMUr5JKN5DtcfMX"),
    new PublicKey("B1zjqKPoYp9bTMhzFADaAvjyGb49FMitLpi6P3Pa3YR6"),
    new PublicKey("B7MhfqTcAKhj59ydA2dKU4ikQVC265MKBh9UxuG324iS"),
    new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    new PublicKey("DeyH7QxWvnbbaVB4zFrf4hoq7Q8z1ZT14co42BGwGtfM"),
    new PublicKey("26kcZkdjJc94PdhqiLiEaGiLCYgAVVUfpDaZyK4cqih3"),
    new PublicKey("7FdQsXmCW3N5JQbknj3F9Yqq73er9VZJjGhEEMS8Ct2A"),
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
