// Call this once after each bank is made.
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { FARMS_PROGRAM_ID, KLEND_PROGRAM_ID } from "./kamino-types";
import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import { makeInitObligationIx } from "./ixes-common";
import {
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { deriveBaseObligation, deriveUserState } from "./pdas";
import { deriveLiquidityVaultAuthority } from "../common/pdas";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  GROUP_KEY: PublicKey;

  /** Group admin (generally the MS on mainnet) */
  ADMIN: PublicKey;
  /** Pays flat sol fee to init and rent (generally the MS on mainnet) */
  FEE_PAYER?: PublicKey; // If omitted, defaults to ADMIN
  BANK: PublicKey;

  /** Oracle address the Kamino Reserve uses. Typically read from reserve.config.tokenInfo.scope */
  RESERVE_ORACLE: PublicKey;
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads

  RESERVE?: PublicKey; // If omitted, read from the bank.integrationAcc1
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEY: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),

  // BANK: new PublicKey("44WmBHm3bKvrwy1jnf9EkgX8hBT61Dz7Z9yfLCSmdEyy"), // USDS
  // BANK: new PublicKey("8u7NuUBxckF2ouC3XKFkuxurinBYQTQiTcXVyqqoyRgM"), // USDC
  BANK: new PublicKey("8y23ks4ZdoKf6G4aiamXSXWerkEbo4U9Zdi2WmqbqSJY"), // USD1
  ADMIN: new PublicKey("CS3NzMknNWtjo2pq5dqp67hQYQ8wdLPt5m67oa5mBZUX"),
  FEE_PAYER: new PublicKey("FbfXs6D1BGUqyz6ya5AfVi3eoyfhin6hfM9d7yt1WK3L"),

  RESERVE_ORACLE: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),

  // RESERVE: new PublicKey("6vKCRnEzrxRS1NybsMVEyNE3ztFAxCz6WusiiGft1PbA"),
};

async function main() {
  await initKaminoObligation(sendTx, config, "/.config/arena/id.json");
}

export async function initKaminoObligation(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  version?: "current",
): Promise<PublicKey> {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
    version,
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  const reserve = config.RESERVE ?? (await program.account.bank.fetch(config.BANK)).integrationAcc1;

  const reserveAcc = await user.kaminoProgram.account.reserve.fetch(reserve);
  const mint = reserveAcc.liquidity.mintPubkey;
  const lendingMarket = reserveAcc.lendingMarket;
  let reserveFarmState = reserveAcc.farmCollateral;

  console.log(
    "init obligation for bank: " + config.BANK + " (mint: " + mint + ")",
  );

  console.log("Detecting token program for mint...");
  let tokenProgram = TOKEN_PROGRAM_ID;
  try {
    await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    tokenProgram = TOKEN_2022_PROGRAM_ID;
    console.log("  Using Token-2022 program");
  } catch {
    // If it fails with Token-2022, it's a regular SPL token
    console.log("  Using SPL Token program");
  }
  console.log();

  console.log(
    "init obligation for bank: " + config.BANK + " (mint: " + mint + ")",
  );
  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    config.BANK,
  );


  const [baseObligation] = deriveBaseObligation(
    liquidityVaultAuthority,
    lendingMarket,
  );
  const ata = getAssociatedTokenAddressSync(
    mint,
    user.wallet.publicKey,
    true,
    tokenProgram,
  );

  let [userState] = deriveUserState(
    FARMS_PROGRAM_ID,
    reserveFarmState,
    baseObligation,
  );

  if (reserveFarmState.toString() == PublicKey.default.toString())
  {
    reserveFarmState = undefined;
    userState = undefined;
  }

  let initObligationTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    await makeInitObligationIx(
      program,
      {
        feePayer: config.FEE_PAYER ?? config.ADMIN,
        bank: config.BANK,
        signerTokenAccount: ata,
        lendingMarket,
        reserve,
        scopePrices: config.RESERVE_ORACLE,
        reserveFarmState,
        obligationFarmUserState: userState,
        liquidityTokenProgram: tokenProgram,
      },
      new BN(100),
    ),
  );

  if (sendTx) {
    try {
      const sigObligation = await sendAndConfirmTransaction(
        connection,
        initObligationTx,
        [user.wallet.payer],
      );
      console.log("obligation key: " + baseObligation);
      console.log("Transaction signature:", sigObligation);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    initObligationTx.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    initObligationTx.recentBlockhash = blockhash;
    const serializedTransaction = initObligationTx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("bank key: " + config.BANK);
    console.log("Base58-encoded transaction:", base58Transaction);
    console.log("ALL accounts:");
    for (let ix of initObligationTx.instructions)
    {
      for (let account of ix.keys)
      {
        console.log(account.pubkey.toString());
      }
    }
  }

  return baseObligation;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
