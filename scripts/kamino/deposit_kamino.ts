// Call this once after each bank is made.
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  FARMS_PROGRAM_ID,
  KLEND_PROGRAM_ID,
} from "./kamino-types";
import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import {
  makeKaminoDepositIx,
  simpleRefreshObligation,
  simpleRefreshReserve,
} from "./ixes-common";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveBaseObligation, deriveUserState } from "./pdas";
import { deriveLiquidityVaultAuthority } from "../common/pdas";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  ACCOUNT: PublicKey;
  AMOUNT: BN;

  KAMINO_MARKET: PublicKey;
  /** Oracle address the Kamino Reserve uses. Typically read from reserve.config.tokenInfo.scope */
  RESERVE_ORACLE: PublicKey;
  TOKEN_PROGRAM?: PublicKey; // If omitted, defaults to TOKEN_PROGRAM_ID
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANK: new PublicKey("24gdUT9SNqeizCD1dHXWgjpa6NnWSFD6TWPAnCFSJnAk"),
  ACCOUNT: new PublicKey("985eLETmzwJB14K6EpVZ3V33xqxBQBX7zCTLgMamfuwq"),
  AMOUNT: new BN(0.001 * 10 ** 9), // 0.001 STKESOL

  KAMINO_MARKET: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
  RESERVE_ORACLE: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
};

async function main() {
  await depositKamino(sendTx, config, "/.config/stage/id.json");
}

export async function depositKamino(sendTx: boolean, config: Config, walletPath: string) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  const bank = await program.account.bank.fetch(config.BANK);
  const mint = bank.mint;
  const reserve = bank.integrationAcc1;

  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    config.BANK
  );
  const [baseObligation] = deriveBaseObligation(
    liquidityVaultAuthority,
    config.KAMINO_MARKET,
  );

  const ata = getAssociatedTokenAddressSync(
    mint,
    user.wallet.publicKey,
    true,
    config.TOKEN_PROGRAM ?? TOKEN_PROGRAM_ID
  );

  const reserveAcc = await user.kaminoProgram.account.reserve.fetch(
    reserve,
  );
  const reserveFarmState = reserveAcc.farmCollateral;

  const [userState] = deriveUserState(
    FARMS_PROGRAM_ID,
    reserveFarmState,
    baseObligation
  );

  let depositTx = new Transaction().add(
    await simpleRefreshReserve(
      user.kaminoProgram,
      reserve,
      config.KAMINO_MARKET,
      config.RESERVE_ORACLE
    ),
    await simpleRefreshObligation(
      user.kaminoProgram,
      config.KAMINO_MARKET,
      baseObligation,
      [reserve]
    ),
    await makeKaminoDepositIx(
      program,
      {
        marginfiAccount: config.ACCOUNT,
        bank: config.BANK,
        signerTokenAccount: ata,
        lendingMarket: config.KAMINO_MARKET,
        reserve: reserve,
        reserveFarmState,
        obligationFarmUserState: userState,
      },
      config.AMOUNT
    )
  );

  if (sendTx) {
    try {
      const sigObligation = await sendAndConfirmTransaction(
        connection,
        depositTx,
        [user.wallet.payer]
      );
      console.log("deposit to: " + config.BANK);
      console.log("by account: " + config.ACCOUNT);
      console.log("Transaction signature:", sigObligation);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    depositTx.feePayer = config.MULTISIG_PAYER; // Set the fee payer to Squads wallet
    const { blockhash } = await connection.getLatestBlockhash();
    depositTx.recentBlockhash = blockhash;
    const serializedTransaction = depositTx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("deposit to: " + config.BANK);
    console.log("by account: " + config.ACCOUNT);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
