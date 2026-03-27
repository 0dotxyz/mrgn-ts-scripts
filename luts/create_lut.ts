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

type Config = {
  PLACEHOLDER: PublicKey;
};

// stage: 7mTGsbaXnNpdcP2jdStswRx8rdH8cVCdj2xKKENDsJHH
// prod: 4GcLy4cdMzQ16WUB9Q8fBwBgaohTXT2F1oLGTMfhdjW8
const config: Config = {
  PLACEHOLDER: new PublicKey("J3oBkTkDXU3TcAggJEa3YeBZE5om5yNAdTtLVNXFD47"),
};

async function main() {
  loadEnvFile(".env.api");
  const apiUrl = process.env.API_URL || DEFAULT_API_URL;
  console.log("api: " + apiUrl);
  const connection = new Connection(apiUrl, "confirmed");
  const wallet = loadKeypairFromFile(
    process.env.HOME + "/.config/stage/id.json"
  );

  const transaction = new Transaction();
  const currentSlot = (await connection.getSlot()) - 1;

  // Create a new lookup table. The authority and payer are set to the wallet's public key.
  const [createLookupTableIx, lutKey] =
    AddressLookupTableProgram.createLookupTable({
      authority: wallet.publicKey,
      payer: wallet.publicKey,
      recentSlot: currentSlot,
    });
  transaction.add(createLookupTableIx);
  console.log("lut key: " + lutKey);

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet]
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.log(
        "NOTE: ERROR DOES NOT MEAN IT ACTUALLY FAILED. CHECK CHAIN FIRST, DON'T WASTE RENT"
      );
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
