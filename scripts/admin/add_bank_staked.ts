import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { SINGLE_POOL_PROGRAM_ID } from "../utils/utils";
import { TOKEN_PROGRAM_ID } from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { deriveBankWithSeed, deriveStakedSettings } from "../common/pdas";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;
const verbose = true;

type Config = {
  PROGRAM_ID: string;
  GROUP_KEY: PublicKey;
  STAKE_POOL: PublicKey;
  /** A pyth price feed that matches the configured Oracle */
  SOL_ORACLE_FEED: PublicKey;
  SEED: number;
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  GROUP_KEY: new PublicKey("FCPfpHA69EbS8f9KKSreTRkXbzFpunsKuYf5qNmnJjpo"),
  STAKE_POOL: new PublicKey("AvS4oXtxWdrJGCJwDbcZ7DqpSqNQtKjyXnbkDbrSk6Fq"),
  SOL_ORACLE_FEED: new PublicKey(
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
  ),
  SEED: 0,
  MULTISIG_PAYER: new PublicKey("AZtUUe9GvTFq9kfseu9jxTioSgdSfjgmZfGQBmhVpTj1"),
};

async function main() {
  await addStakedBank(sendTx, config, "/keys/staging-deploy.json");
}

async function addStakedBank(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  version?: "current",
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const connection = user.connection;
  const wallet = user.wallet;
  const program = user.program;

  let [stakedSettingsKey] = deriveStakedSettings(
    program.programId,
    config.GROUP_KEY,
  );

  const [lstMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint"), config.STAKE_POOL.toBuffer()],
    SINGLE_POOL_PROGRAM_ID,
  );
  const [solPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake"), config.STAKE_POOL.toBuffer()],
    SINGLE_POOL_PROGRAM_ID,
  );

  // Note: oracle and lst mint/pool are also passed in meta for validation
  const oracleMeta: AccountMeta = {
    pubkey: config.SOL_ORACLE_FEED,
    isSigner: false,
    isWritable: false,
  };
  const lstMeta: AccountMeta = {
    pubkey: lstMint,
    isSigner: false,
    isWritable: false,
  };
  const solPoolMeta: AccountMeta = {
    pubkey: solPool,
    isSigner: false,
    isWritable: false,
  };

  const [bankKey] = deriveBankWithSeed(
    program.programId,
    config.GROUP_KEY,
    lstMint,
    new BN(config.SEED),
  );

  const transaction = new Transaction();

  transaction.add(
    await program.methods
      .lendingPoolAddBankPermissionless(new BN(config.SEED))
      .accounts({
        // marginfiGroup: args.marginfiGroup, // implied from stakedSettings
        stakedSettings: stakedSettingsKey,
        feePayer: wallet.publicKey,
        bankMint: lstMint,
        solPool: solPool,
        stakePool: config.STAKE_POOL,
        // bank: bankKey, // deriveBankWithSeed
        // globalFeeState: deriveGlobalFeeState(id),
        // globalFeeWallet: // implied from globalFeeState,
        // liquidityVaultAuthority = deriveLiquidityVaultAuthority(id, bank);
        // liquidityVault = deriveLiquidityVault(id, bank);
        // insuranceVaultAuthority = deriveInsuranceVaultAuthority(id, bank);
        // insuranceVault = deriveInsuranceVault(id, bank);
        // feeVaultAuthority = deriveFeeVaultAuthority(id, bank);
        // feeVault = deriveFeeVault(id, bank);
        // rent = SYSVAR_RENT_PUBKEY
        tokenProgram: TOKEN_PROGRAM_ID,
        // systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([oracleMeta, lstMeta, solPoolMeta])
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [wallet.payer],
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }

    if (verbose) {
      console.log("init bank: " + bankKey);
    }
  } else {
    transaction.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
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
