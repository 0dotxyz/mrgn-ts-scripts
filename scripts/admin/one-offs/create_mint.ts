import {
  Keypair,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createSetAuthorityInstruction,
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

const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

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
   * If true, create Metaplex metadata in the same tx as mint creation.
   * This prevents races where a metadata account could be created before you do.
   */
  CREATE_METADATA: boolean;
  /** Token metadata name */
  METADATA_NAME: string;
  /** Token metadata symbol */
  METADATA_SYMBOL: string;
  /** Token metadata URI */
  METADATA_URI: string;
  /** Update authority for token metadata (can differ from mint authority) */
  METADATA_UPDATE_AUTHORITY: string;
  /**
   * Optional signer if MINT_AUTHORITY is not the payer wallet in sendTx=true mode.
   * Path is relative to HOME.
   */
  MINT_AUTHORITY_KEYPAIR_PATH?: string;
  /**
   * Optional authority handoff after mint + metadata creation.
   * If set:
   * - string => transfer authority to that pubkey
   * - null => revoke authority
   * - undefined => do not modify this authority
   */
  TRANSFER_MINT_AUTHORITY_TO?: string | null;
  TRANSFER_FREEZE_AUTHORITY_TO?: string | null;
  /**
   * Optional signer if FREEZE_AUTHORITY is not payer/MS and transfer is requested.
   * Path is relative to HOME.
   */
  FREEZE_AUTHORITY_KEYPAIR_PATH?: string;

  /**
   * Required if sendTx=false (for multisig flow).
   */
  MULTISIG_PAYER?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  MINT_KEYPAIR_PATH: "/.keys/mint-keypair.json",
  DECIMALS: 6,
  MINT_AUTHORITY: "mfC1LoEk4mpM5yx1LjwR9QLZQ49AitxxWkK5Aciw7ZC",
  FREEZE_AUTHORITY: "mfC1LoEk4mpM5yx1LjwR9QLZQ49AitxxWkK5Aciw7ZC",
  // FREEZE_AUTHORITY: null,
  CREATE_METADATA: true,
  METADATA_NAME: "Project 0",
  METADATA_SYMBOL: "P0",
  METADATA_URI: "https://www.0.xyz",
  METADATA_UPDATE_AUTHORITY: "CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw",
  // MINT_AUTHORITY_KEYPAIR_PATH: "/.keys/burner-authority.json",
  TRANSFER_MINT_AUTHORITY_TO: "CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw",
  TRANSFER_FREEZE_AUTHORITY_TO: "CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw",
  // FREEZE_AUTHORITY_KEYPAIR_PATH: "/.keys/burner-authority.json",

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
  const metadataUpdateAuthority = config.CREATE_METADATA
    ? parseRequiredPublicKey(
        "METADATA_UPDATE_AUTHORITY",
        config.METADATA_UPDATE_AUTHORITY,
      )
    : null;
  const mintAuthoritySigner = loadOptionalKeypair(
    config.MINT_AUTHORITY_KEYPAIR_PATH,
  );
  const transferMintAuthorityTo = parseOptionalAuthorityPubkey(
    config.TRANSFER_MINT_AUTHORITY_TO,
  );
  const transferFreezeAuthorityTo = parseOptionalAuthorityPubkey(
    config.TRANSFER_FREEZE_AUTHORITY_TO,
  );
  const freezeAuthoritySigner = loadOptionalKeypair(
    config.FREEZE_AUTHORITY_KEYPAIR_PATH,
  );

  const feePayer = sendTx ? user.wallet.publicKey : config.MULTISIG_PAYER;
  if (!feePayer) {
    throw new Error("MULTISIG_PAYER must be set when sendTx=false");
  }

  const existingMintInfo = await connection.getAccountInfo(
    mintKeypair.publicKey,
  );
  if (existingMintInfo) {
    throw new Error(
      `Mint already exists on chain: ${mintKeypair.publicKey.toBase58()}`,
    );
  }
  const metadataPda = deriveMetadataPda(mintKeypair.publicKey);
  if (config.CREATE_METADATA) {
    const existingMetadataInfo = await connection.getAccountInfo(metadataPda);
    if (existingMetadataInfo) {
      throw new Error(
        `Metadata already exists on chain: ${metadataPda.toBase58()}`,
      );
    }
  }

  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new Transaction();
  tx.add(
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
  if (config.CREATE_METADATA) {
    tx.add(
      createMetadataIx({
        metadata: metadataPda,
        mint: mintKeypair.publicKey,
        mintAuthority,
        payer: feePayer,
        updateAuthority: metadataUpdateAuthority!,
        name: config.METADATA_NAME,
        symbol: config.METADATA_SYMBOL,
        uri: config.METADATA_URI,
      }),
    );
  }
  if (config.TRANSFER_MINT_AUTHORITY_TO !== undefined) {
    tx.add(
      createSetAuthorityInstruction(
        mintKeypair.publicKey,
        mintAuthority,
        AuthorityType.MintTokens,
        transferMintAuthorityTo,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
  }
  if (config.TRANSFER_FREEZE_AUTHORITY_TO !== undefined) {
    if (!freezeAuthority) {
      throw new Error(
        "Cannot transfer freeze authority because current FREEZE_AUTHORITY is null",
      );
    }
    tx.add(
      createSetAuthorityInstruction(
        mintKeypair.publicKey,
        freezeAuthority,
        AuthorityType.FreezeAccount,
        transferFreezeAuthorityTo,
        [],
        TOKEN_PROGRAM_ID,
      ),
    );
  }

  console.log("classic mint pubkey:", mintKeypair.publicKey.toBase58());
  console.log("mint authority:", mintAuthority.toBase58());
  console.log(
    "freeze authority:",
    freezeAuthority ? freezeAuthority.toBase58() : "none",
  );
  if (config.CREATE_METADATA) {
    console.log("metadata PDA:", metadataPda.toBase58());
    console.log(
      "metadata update authority:",
      metadataUpdateAuthority.toBase58(),
    );
  }
  if (config.TRANSFER_MINT_AUTHORITY_TO !== undefined) {
    console.log(
      "transfer mint authority to:",
      transferMintAuthorityTo
        ? transferMintAuthorityTo.toBase58()
        : "none (revoked)",
    );
  }
  if (config.TRANSFER_FREEZE_AUTHORITY_TO !== undefined) {
    console.log(
      "transfer freeze authority to:",
      transferFreezeAuthorityTo
        ? transferFreezeAuthorityTo.toBase58()
        : "none (revoked)",
    );
  }
  console.log("decimals:", config.DECIMALS);

  const requiredAuthoritySigners: Keypair[] = [];
  if (
    config.CREATE_METADATA ||
    config.TRANSFER_MINT_AUTHORITY_TO !== undefined
  ) {
    const signer = resolveAuthoritySigner({
      sendTx,
      authority: mintAuthority,
      authorityLabel: "MINT_AUTHORITY",
      payer: feePayer,
      multisigPayer: config.MULTISIG_PAYER,
      providedSigner: mintAuthoritySigner,
    });
    if (signer) requiredAuthoritySigners.push(signer);
  }
  if (config.TRANSFER_FREEZE_AUTHORITY_TO !== undefined) {
    if (!freezeAuthority) {
      throw new Error(
        "Cannot transfer freeze authority because current FREEZE_AUTHORITY is null",
      );
    }
    const signer = resolveAuthoritySigner({
      sendTx,
      authority: freezeAuthority,
      authorityLabel: "FREEZE_AUTHORITY",
      payer: feePayer,
      multisigPayer: config.MULTISIG_PAYER,
      providedSigner: freezeAuthoritySigner ?? mintAuthoritySigner,
    });
    if (signer) requiredAuthoritySigners.push(signer);
  }
  const uniqueAuthoritySigners = Array.from(
    new Map(
      requiredAuthoritySigners.map((kp) => [kp.publicKey.toBase58(), kp]),
    ).values(),
  );

  if (sendTx) {
    const signers: Keypair[] = [user.wallet.payer, mintKeypair, ...uniqueAuthoritySigners];
    const signature = await sendAndConfirmTransaction(connection, tx, signers);
    console.log("Transaction signature:", signature);
  } else {
    tx.feePayer = feePayer;
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.partialSign(mintKeypair);
    for (const signer of uniqueAuthoritySigners) {
      tx.partialSign(signer);
    }
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
  return new PublicKey(value);
}

function parseOptionalPublicKey(
  field: string,
  value: string | null,
): PublicKey | null {
  if (value === null) return null;
  return new PublicKey(value);
}

function parseOptionalAuthorityPubkey(
  value: string | null | undefined,
): PublicKey | null {
  if (value === undefined) return null;
  if (value === null) return null;
  return new PublicKey(value);
}

function loadOptionalKeypair(path: string | undefined): Keypair | null {
  if (!path) return null;
  return loadKeypairFromFile(process.env.HOME + path);
}

type ResolveAuthoritySignerArgs = {
  sendTx: boolean;
  authority: PublicKey;
  authorityLabel: string;
  payer: PublicKey;
  multisigPayer?: PublicKey;
  providedSigner: Keypair | null;
};

function resolveAuthoritySigner(args: ResolveAuthoritySignerArgs): Keypair | null {
  if (args.authority.equals(args.payer)) {
    return null;
  }
  if (args.providedSigner) {
    if (!args.providedSigner.publicKey.equals(args.authority)) {
      throw new Error(
        `${args.authorityLabel}_KEYPAIR_PATH does not match ${args.authorityLabel}`,
      );
    }
    return args.providedSigner;
  }
  if (
    !args.sendTx &&
    args.multisigPayer &&
    args.authority.equals(args.multisigPayer)
  ) {
    // Multisig authority will sign later.
    return null;
  }
  throw new Error(
    `${args.authorityLabel} must be payer wallet, multisig payer (when sendTx=false), or provide a matching local keypair path`,
  );
}

function deriveMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  )[0];
}

type CreateMetadataIxParams = {
  metadata: PublicKey;
  mint: PublicKey;
  mintAuthority: PublicKey;
  payer: PublicKey;
  updateAuthority: PublicKey;
  name: string;
  symbol: string;
  uri: string;
};

function createMetadataIx(
  params: CreateMetadataIxParams,
): TransactionInstruction {
  const data = buildCreateMetadataAccountV3Data({
    name: params.name,
    symbol: params.symbol,
    uri: params.uri,
  });

  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: params.metadata, isSigner: false, isWritable: true },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.mintAuthority, isSigner: true, isWritable: false },
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildCreateMetadataAccountV3Data(args: {
  name: string;
  symbol: string;
  uri: string;
}): Buffer {
  return Buffer.concat([
    Buffer.from([33]), // MetadataInstruction::CreateMetadataAccountV3
    encodeString(args.name),
    encodeString(args.symbol),
    encodeString(args.uri),
    encodeU16(0), // sellerFeeBasisPoints
    Buffer.from([0]), // creators: None
    Buffer.from([0]), // collection: None
    Buffer.from([0]), // uses: None
    Buffer.from([1]), // isMutable: true
    Buffer.from([0]), // collectionDetails: None
  ]);
}

function encodeString(value: string): Buffer {
  const str = Buffer.from(value, "utf8");
  return Buffer.concat([encodeU32(str.length), str]);
}

function encodeU16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function encodeU32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
