import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
} from "@solana/spl-token";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { loadKeypairFromFile } from "../../lib/utils";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

/**
 * Wallet used as fee payer when sendTx=true.
 */
const walletPath = "/.keys/staging-deploy.json";

const REQUIRED_PUBKEY_PLACEHOLDER = "PASTE_PUBLIC_KEY_HERE";

type Config = {
  PROGRAM_ID: string;
  /** Existing local mint keypair json path, relative to HOME */
  MINT_KEYPAIR_PATH: string;
  DECIMALS: number;
  /** Paste intended mint authority */
  MINT_AUTHORITY: string;
  /**
   * Paste intended freeze authority.
   * Set to null to disable freeze authority.
   */
  FREEZE_AUTHORITY: string | null;

  /**
   * Required if sendTx=false (for multisig flow).
   */
  MULTISIG_PAYER?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  MINT_KEYPAIR_PATH: "/.keys/replace-with-mint-keypair.json",
  DECIMALS: 6,
  MINT_AUTHORITY: REQUIRED_PUBKEY_PLACEHOLDER,
  FREEZE_AUTHORITY: REQUIRED_PUBKEY_PLACEHOLDER,
  // FREEZE_AUTHORITY: null,

  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  await createMint(sendTx, config, walletPath);
}

export async function createMint(
  sendTx: boolean,
  config: Config,
  walletPath: string,
): Promise<PublicKey> {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;

  const mintKeypair = loadKeypairFromFile(
    process.env.HOME + config.MINT_KEYPAIR_PATH,
  );
  const mintAuthority = parseRequiredPublicKey(
    "MINT_AUTHORITY",
    config.MINT_AUTHORITY,
  );
  const freezeAuthority = parseOptionalPublicKey(
    "FREEZE_AUTHORITY",
    config.FREEZE_AUTHORITY,
  );

  const feePayer = sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER;
  if (!feePayer) {
    throw new Error("MULTISIG_PAYER must be set when sendTx=false");
  }

  const existingMintInfo = await connection.getAccountInfo(mintKeypair.publicKey);
  if (existingMintInfo) {
    throw new Error(
      `Mint already exists on chain: ${mintKeypair.publicKey.toBase58()}`,
    );
  }

  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: feePayer,
      newAccountPubkey: mintKeypair.publicKey,
      lamports: rent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      config.DECIMALS,
      mintAuthority,
      freezeAuthority,
      TOKEN_PROGRAM_ID,
    ),
  );

  console.log("classic mint pubkey:", mintKeypair.publicKey.toBase58());
  console.log("mint authority:", mintAuthority.toBase58());
  console.log(
    "freeze authority:",
    freezeAuthority ? freezeAuthority.toBase58() : "none",
  );
  console.log("decimals:", config.DECIMALS);

  if (sendTx) {
    const signature = await sendAndConfirmTransaction(connection, tx, [
      user.wallet.payer,
      mintKeypair,
    ]);
    console.log("Transaction signature:", signature);
  } else {
    tx.feePayer = feePayer;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.partialSign(mintKeypair);
    const serializedTransaction = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }

  return mintKeypair.publicKey;
}

function parseRequiredPublicKey(field: string, value: string): PublicKey {
  if (value === REQUIRED_PUBKEY_PLACEHOLDER) {
    throw new Error(`Set ${field} in config before running this script`);
  }
  return new PublicKey(value);
}

function parseOptionalPublicKey(
  field: string,
  value: string | null,
): PublicKey | null {
  if (value === null) return null;
  if (value === REQUIRED_PUBKEY_PLACEHOLDER) {
    throw new Error(`Set ${field} in config before running this script`);
  }
  return new PublicKey(value);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
