import {
  Connection,
  PublicKey,
  StakeAuthorizationLayout,
  StakeProgram,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
} from "@solana/web3.js";
import { SINGLE_POOL_PROGRAM_ID } from "../scripts/utils/utils";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { commonSetup } from "../lib/common-setup";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

/**
 * SVSP Deposit with Squads
 */

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  USER_STAKE_ACCOUNT: PublicKey;  // The user's stake to deposit
  POOL_DEST_STAKE: PublicKey;     // The pool's destination stake
  STAKE_POOL: PublicKey;
  MULTISIG: PublicKey;
};

// TODO:
// Update this with your own values
const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  USER_STAKE_ACCOUNT: new PublicKey("BhYKpeRoTXyAi8FXYsXK7oLLDEm2Kn8PUwFS2HQKXUSW"),
  POOL_DEST_STAKE: new PublicKey("Dswm5Vdy5J1dnYCGKAgjAa6P7gUPKdZnDkfqLKPTp4PP"),
  STAKE_POOL: new PublicKey("5ggDh4yt9qBrArSsMbLbj5wdpinfNN5Z9LGMRAGryh4o"),
  MULTISIG: new PublicKey("4yZ86JsaJZoccQNn6fCgtcfgnKTEGe1JGCbnHb7L5zeH"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/keys/phantom-wallet.json",
    config.MULTISIG,
  );
  const connection = user.connection;

  // Derive PDAs
  const [lstMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), config.STAKE_POOL.toBuffer()],
    SINGLE_POOL_PROGRAM_ID
  );
  
  const [poolStakeAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_authority"), config.STAKE_POOL.toBuffer()],
    SINGLE_POOL_PROGRAM_ID
  );

  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority"), config.STAKE_POOL.toBuffer()],
    SINGLE_POOL_PROGRAM_ID
  );

  const actualSigner = config.MULTISIG;
  const lstAta = getAssociatedTokenAddressSync(
    lstMint,
    actualSigner,
    true // allowOwnerOffCurve for vault PDA
  );

  console.log("=== SVSP Deposit (Corrected Account Order) ===");
  console.log("Vault:", actualSigner.toBase58());
  console.log("User's stake to deposit:", config.USER_STAKE_ACCOUNT.toBase58());
  console.log("Pool's destination stake:", config.POOL_DEST_STAKE.toBase58());
  console.log("LST mint:", lstMint.toBase58());
  console.log("LST ATA:", lstAta.toBase58());
  console.log("Pool stake authority:", poolStakeAuthority.toBase58());

  // Check current stake authorities
  const stakeAccountInfo = await connection.getParsedAccountInfo(config.USER_STAKE_ACCOUNT);
  const stakeData = (stakeAccountInfo.value as any)?.data?.parsed?.info;
  const currentStaker = stakeData?.meta?.authorized?.staker;
  const currentWithdrawer = stakeData?.meta?.authorized?.withdrawer;
  
  console.log("=== Current User Stake Authorities ===");
  console.log("Staker:", currentStaker);
  console.log("Withdrawer:", currentWithdrawer);

  const ixes: TransactionInstruction[] = [];

  // Check if ATA exists
  const ataInfo = await connection.getAccountInfo(lstAta);
  if (!ataInfo) {
    console.log("Adding: Create LST ATA");
    
    // Manually construct the instruction with correct writability flags
    const createAtaIx = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: actualSigner, isSigner: true, isWritable: true }, // payer
        { pubkey: lstAta, isSigner: false, isWritable: true }, // ata
        { pubkey: actualSigner, isSigner: false, isWritable: false }, // owner (NOT writable)
        { pubkey: lstMint, isSigner: false, isWritable: false }, // mint (NOT writable)
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system (NOT writable)
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // token program (NOT writable)
      ],
      data: Buffer.from([1]), // CreateIdempotent instruction
    });
    ixes.push(createAtaIx);
  }

  // Only add auth if needed
  const needsStakerAuth = currentStaker === actualSigner.toBase58();
  const needsWithdrawerAuth = currentWithdrawer === actualSigner.toBase58();

  if (needsStakerAuth) {
    console.log("Adding: Authorize staker to pool (Clock NOT writable)");
    
    // Manually build authorize instruction with Clock explicitly NOT writable
    const authorizeStakerIx = new TransactionInstruction({
      programId: StakeProgram.programId,
      keys: [
        { pubkey: config.USER_STAKE_ACCOUNT, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // EXPLICITLY NOT WRITABLE
        { pubkey: actualSigner, isSigner: true, isWritable: false },
        { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false }, // custodian (none)
      ],
      data: Buffer.concat([
        Buffer.from([1, 0, 0, 0]), // Authorize instruction
        poolStakeAuthority.toBuffer(),
        Buffer.from([0, 0, 0, 0]), // StakeAuthorize::Staker
      ]),
    });
    ixes.push(authorizeStakerIx);
  }

  if (needsWithdrawerAuth) {
    console.log("Adding: Authorize withdrawer to pool (Clock NOT writable)");
    
    // Manually build authorize instruction with Clock explicitly NOT writable
    const authorizeWithdrawerIx = new TransactionInstruction({
      programId: StakeProgram.programId,
      keys: [
        { pubkey: config.USER_STAKE_ACCOUNT, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // EXPLICITLY NOT WRITABLE
        { pubkey: actualSigner, isSigner: true, isWritable: false },
        { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false }, // custodian (none)
      ],
      data: Buffer.concat([
        Buffer.from([1, 0, 0, 0]), // Authorize instruction
        poolStakeAuthority.toBuffer(),
        Buffer.from([1, 0, 0, 0]), // StakeAuthorize::Withdrawer
      ]),
    });
    ixes.push(authorizeWithdrawerIx);
  }

  console.log("Adding: SVSP deposit stake (with corrected account order)");
  
  const depositIx = new TransactionInstruction({
    programId: SINGLE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: config.STAKE_POOL, isSigner: false, isWritable: false },              // #1 Pool
      { pubkey: config.POOL_DEST_STAKE, isSigner: false, isWritable: true },          // #2 Pool's destination stake
      { pubkey: lstMint, isSigner: false, isWritable: true },                         // #3 LST mint
      { pubkey: poolStakeAuthority, isSigner: false, isWritable: false },             // #4 Pool stake authority
      { pubkey: mintAuthority, isSigner: false, isWritable: false },                  // #5 Mint authority
      { pubkey: config.USER_STAKE_ACCOUNT, isSigner: false, isWritable: true },       // #6 User's stake to deposit
      { pubkey: lstAta, isSigner: false, isWritable: true },                          // #7 LST ATA
      { pubkey: actualSigner, isSigner: true, isWritable: true },                     // #8 Signer
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },            // #9 Clock (NOT writable)
      { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },    // #10 Stake History
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },               // #11 Token program
      { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },         // #12 Stake program
    ],
    data: Buffer.from([2]), // DepositStake instruction
  });
  ixes.push(depositIx);

  const transaction = new Transaction();
  transaction.add(...ixes);
  transaction.feePayer = actualSigner;
  
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  
  const serializedTransaction = transaction.serialize({
    requireAllSignatures: false,
    verifySignatures: false,
  });
  const base58Transaction = bs58.encode(serializedTransaction);
  
  console.log("=== Base58 Transaction ===");
  console.log(base58Transaction);
  
  console.log("=== Transaction Summary ===");
  console.log("Instructions:", ixes.length);
  if (!ataInfo) console.log("- Create ATA");
  if (needsStakerAuth || needsWithdrawerAuth) console.log("- Transfer authorities to pool");
  console.log("- Deposit stake");
}

main().catch((err) => {
  console.error(err);
});
