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
  LUT: new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
  KEYS: [
    new PublicKey("ARavHAycdzMxXyNFCZneQi4N8wepe8WXpWHYq19avFLq"),
    new PublicKey("94vK29npVbyRHXH63rRcTiSr26SFhrQTzbpNJuhQEDu"),
    new PublicKey("Hf9gtkM4dpVBahVSzEXSVCAPpKzBsBcns3s8As3z77oF"),
    new PublicKey("2j8xSz6m1hBufkqspPd56SCj2TsSNGSrG7T54VCrpppP"),
    // new PublicKey("5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6"),
    // new PublicKey("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"),
    // new PublicKey("B62ErTornx9tSVwcLwGh9RqvfFCen4cfWkArYdRpRy91"),
    // new PublicKey("58ACj986huaXwNUHD6YKJ88gZzyUY4rhSTizyaGvnyAy"),
    // new PublicKey("7SAxf2SCJe5c72rZNo4etpGjz5TaEAqi8QkbfpRbouuT"),
    // new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"),
  ],
};

async function main() {
  await updateLut(sendTx, config, "/.keys/BURNED_phantom-wallet.json",);
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
