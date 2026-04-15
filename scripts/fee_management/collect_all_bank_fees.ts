// TODO add a LUT and send these all in one tx to avoid burning so many tx fees.
import {
  AccountMeta,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.keys/staging-deploy.json"
  );
  const program = user.program;
  const connection = user.connection;

  const jsonUrl =
    "https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache.json";
  const response = await fetch(jsonUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON: ${response.statusText}`);
  }
  const pools: PoolEntry[] = (await response.json()) as PoolEntry[];
  // Or read it locally....
  //   const poolsJson = fs.readFileSync(path.join(__dirname, "svsp_pools.json"), "utf8");
  //   const pools: PoolEntry[] = JSON.parse(poolsJson);
  console.log("read " + pools.length + " pools");
  console.log("");

  let [globalFeeState] = deriveGlobalFeeState(program.programId);
  let globalFeeAcc = await program.account.feeState.fetch(globalFeeState);
  let globalFeeWallet = globalFeeAcc.globalFeeWallet;

  for (let i = 0; i < pools.length; i++) {
    const bank = new PublicKey(pools[i].bankAddress);
    const mint = new PublicKey(pools[i].tokenAddress);
    let mintAccInfo = await connection.getAccountInfo(mint);
    const tokenProgram = mintAccInfo.owner;

    let feeAta = getAssociatedTokenAddressSync(
      mint,
      globalFeeWallet,
      true,
      tokenProgram
    );

    let createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      user.wallet.publicKey,
      feeAta,
      globalFeeWallet,
      mint,
      tokenProgram
    );

    let remaining: AccountMeta[] = [];
    if (tokenProgram.toString() == TOKEN_2022_PROGRAM_ID.toString()) {
      const meta: AccountMeta = {
        pubkey: mint,
        isSigner: false,
        isWritable: false,
      };
      remaining.push(meta);
    }

    let tx = new Transaction();
    const ix = await program.methods
      .lendingPoolCollectBankFees()
      .accounts({
        bank: bank,
        feeAta: feeAta,
        tokenProgram: tokenProgram,
      })
      .remainingAccounts(remaining)
      .instruction();
    tx.add(createAtaIx);
    tx.add(ix);

    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [
        user.wallet.payer,
      ]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }

    console.log("[" + i + "] Collected fees for: " + bank);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
});

const deriveGlobalFeeState = (programId: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("feestate", "utf-8")],
    programId
  );
};

/**
 * JSON file format of our staked banks endpoint
 * (https://storage.googleapis.com/mrgn-public/mrgn-staked-bank-metadata-cache.json)
 */
type PoolEntry = {
  bankAddress: string;
  validatorVoteAccount: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
};
