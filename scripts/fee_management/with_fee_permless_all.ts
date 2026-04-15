// multi-bank-fees.ts

/**
 * This script fetches a list of banks from a JSON cache, filters out any banks
 * whose assetTag equals ASSET_TAG_STAKED, and for each remaining bank it:
 *   1. Creates an associated token account (ATA) for DESTINATION_WALLET if needed.
 *   2. Sets the lending pool's fees destination account to that ATA.
 *   3. Withdraws the available fees (minus 1 token for buffer) permissionlessly.
 *
 * It groups instructions into one Transaction per 10 banks.
 */

import {
  AccountMeta,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import fetch from "node-fetch"; // or `import fetch from "cross-fetch";` if using ESM
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, actually send each transaction; if false, log the unsigned base58-encoded tx.
 */
const sendTx = true;

/**
 * If true, include the `lendingPoolUpdateFeesDestinationAccount` instruction;
 * if false, skip setting the destination and only withdraw.
 */
const setDestination = false;

/**
 * If true, skip any bank that doesn't have an emissions destination set
 */
const skipUnset = true;

/**
 * The maximum number of banks to batch into a single Transaction.
 */
const CHUNK_SIZE = 6;
const JSON_URL =
  "https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache.json";

export type Config = {
  PROGRAM_ID: string;
  DESTINATION_WALLET: PublicKey;

  MULTISIG_PAYER: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  DESTINATION_WALLET: new PublicKey(
    "J3oBkTkDXU3TcAggJEa3YeBZE5om5yNAdTtLVNXFD47",
  ),

  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/.keys/staging-deploy.json",
    config.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;

  console.log("Fetching banks list from JSON...");
  const response = await fetch(JSON_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON: ${response.statusText}`);
  }
  const pools: PoolEntry[] = (await response.json()) as PoolEntry[];
  const includedBanks: { bankPubkey: PublicKey; mintPubkey: PublicKey }[] = [];

  console.log("read " + pools.length + " pools");
  for (let i = 0; i < pools.length; i++) {
    const bankPubkey = new PublicKey(pools[i].bankAddress);
    let bankAcc = await program.account.bank.fetch(bankPubkey);

    // Exclude if assetTag is ASSET_TAG_STAKED
    if (bankAcc.config.assetTag === ASSET_TAG_STAKED) {
      continue;
    }
    if (
      skipUnset &&
      bankAcc.feesDestinationAccount.toString() == PublicKey.default.toString()
    ) {
      continue;
    }

    const mintPubkey = new PublicKey(pools[i].tokenAddress);
    includedBanks.push({ bankPubkey, mintPubkey });
  }

  console.log(`Banks to process: ${includedBanks.length}`);

  // Break txes into chunks of CHUNK_SIZE
  for (
    let chunkStart = 0;
    chunkStart < includedBanks.length;
    chunkStart += CHUNK_SIZE
  ) {
    const chunk = includedBanks.slice(chunkStart, chunkStart + CHUNK_SIZE);
    const tx = new Transaction();

    for (const { bankPubkey, mintPubkey } of chunk) {
      const bankAcc = await program.account.bank.fetch(bankPubkey);
      const collectedFees = wrappedI80F48toBigNumber(
        bankAcc.collectedGroupFeesOutstanding,
      ).toNumber();

      const [feeVault] = deriveFeeVault(program.programId, bankPubkey);
      // Determine token program: check if mint uses Token-2022
      const mintAccInfo = await connection.getAccountInfo(mintPubkey);
      const tokenProgram = mintAccInfo.owner;
      const isT22 =
        tokenProgram.toString() === TOKEN_2022_PROGRAM_ID.toString();

      let feesVaultAcc = await getAccount(
        connection,
        feeVault,
        undefined,
        tokenProgram,
      );
      const feesAvailable = Number(feesVaultAcc.amount);
      console.log(
        `    · Bank ${bankPubkey.toString()}: collectedFees=${collectedFees}, feesAvailable=${feesAvailable}, isT22=${isT22}`,
      );

      const dstAta = getAssociatedTokenAddressSync(
        mintPubkey,
        config.DESTINATION_WALLET,
        true,
        tokenProgram,
      );
      const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
        config.MULTISIG_PAYER,
        dstAta,
        config.DESTINATION_WALLET,
        mintPubkey,
        tokenProgram,
      );

      if (setDestination) {
        const updateIx = await program.methods
          .lendingPoolUpdateFeesDestinationAccount()
          .accounts({
            bank: bankPubkey,
            destinationAccount: dstAta,
          })
          .instruction();
        tx.add(createAtaIx, updateIx);
      }

      const remaining: AccountMeta[] = [];
      if (isT22) {
        remaining.push({
          pubkey: mintPubkey,
          isSigner: false,
          isWritable: false,
        });
      }

      const withdrawIx = await program.methods
        .lendingPoolWithdrawFeesPermissionless(
          new BN(Math.max(feesAvailable - 1, 0)),
        )
        .accounts({
          bank: bankPubkey,
          tokenProgram: tokenProgram,
        })
        .accountsPartial({
          feesDestinationAccount: dstAta,
        })
        .remainingAccounts(remaining)
        .instruction();
      tx.add(withdrawIx);
    }

    // TODO WIP: we need to create a LUT and use a versioned tx for this
    if (sendTx) {
      try {
        const signature = await sendAndConfirmTransaction(connection, tx, [
          user.wallet.payer,
        ]);
        console.log("Transaction signature:", signature);
      } catch (error) {
        console.error("Transaction failed:", error);
      }
    } else {
      tx.feePayer = config.MULTISIG_PAYER;
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      const serializedTransaction = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const base58Transaction = bs58.encode(serializedTransaction);
      console.log("Base58-encoded transaction:", base58Transaction);
    }
    console.log();
  }
}

const ASSET_TAG_STAKED = 2;

type PoolEntry = {
  bankAddress: string;
  validatorVoteAccount: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
};

const deriveFeeVault = (programId: PublicKey, bank: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault", "utf-8"), bank.toBuffer()],
    programId,
  );
};

main().catch((err) => {
  console.error("Fatal error in multi-bank script:", err);
  process.exit(1);
});
