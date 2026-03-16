import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
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
  makeKaminoWithdrawIx,
  simpleRefreshObligation,
  simpleRefreshReserve,
} from "./ixes-common";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { deriveBaseObligation, deriveUserState } from "./pdas";
import { deriveLiquidityVaultAuthority } from "../common/pdas";
import { BankAndOracles } from "../../lib/utils";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  ACCOUNT: PublicKey;
  AMOUNT: BN;
  WITHDRAW_ALL: boolean;

  BANK_MINT: PublicKey;
  KAMINO_RESERVE: PublicKey;
  KAMINO_MARKET: PublicKey;
  /** Oracle address the Kamino Reserve uses. Typically read from reserve.config.tokenInfo.scope */
  RESERVE_ORACLE: PublicKey;
  TOKEN_PROGRAM?: PublicKey; // If omitted, defaults to TOKEN_PROGRAM_ID
  LUT: PublicKey;
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
  NEW_REMAINING: BankAndOracles;
  ADD_COMPUTE_UNITS: boolean;
};

const prodKaminoTestconfig: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  BANK: new PublicKey("AzAxeU7KzUGKr82TFJdpvpLBKRTpTtuWWfBLuxm7FtFo"),
  ACCOUNT: new PublicKey("DeCbfDxCGc6gJetJNozNTL51u6JHGRp6HSKgxP8fhEd5"),
  AMOUNT: new BN(40 * 10 ** 6), // 40 USDC
  WITHDRAW_ALL: true,

  BANK_MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  KAMINO_RESERVE: new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),
  KAMINO_MARKET: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
  RESERVE_ORACLE: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),

  LUT: new PublicKey("FtQ5uKQvFoKQ27SWY15tgBeJQnGKmKGzWqDz7kGUbeiq"),

  NEW_REMAINING: [
    new PublicKey("CVjHEnJWKELsbFt37znC2nq4KNrwTf7w42fcfySEifNu"),
    new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"),
  ],
  ADD_COMPUTE_UNITS: true,
};

const config = prodKaminoTestconfig;

async function main() {
  await withdrawKamino(sendTx, config, "/.config/stage/id.json");
}

export async function withdrawKamino(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  version?: "current"
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
    version
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  let luts: AddressLookupTableAccount[] = [];
  const lutLookup = await connection.getAddressLookupTable(config.LUT);
  if (!lutLookup || !lutLookup.value) {
    console.warn(
      `Warning: LUT ${config.LUT.toBase58()} not found on-chain. Proceeding without it.`
    );
    luts = [];
  } else {
    luts = [lutLookup.value];
  }

  const oracleMeta: AccountMeta[] = config.NEW_REMAINING.flat().map(
    (pubkey) => {
      return { pubkey, isSigner: false, isWritable: false };
    }
  );

  const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
    program.programId,
    config.BANK
  );
  const [baseObligation] = deriveBaseObligation(
    liquidityVaultAuthority,
    config.KAMINO_MARKET,
  );

  const ata = getAssociatedTokenAddressSync(
    config.BANK_MINT,
    user.wallet.publicKey,
    true,
    config.TOKEN_PROGRAM ?? TOKEN_PROGRAM_ID
  );

  const reserve = await user.kaminoProgram.account.reserve.fetch(
    config.KAMINO_RESERVE,
  );
  const reserveFarmState = reserve.farmCollateral;

  const [userState] = deriveUserState(
    FARMS_PROGRAM_ID,
    reserveFarmState,
    baseObligation
  );

  let instructions: TransactionInstruction[] = [];
  if (config.ADD_COMPUTE_UNITS) {
    // instructions.push(
    //   ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
    // );
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
    );
  }

  instructions.push(
    await simpleRefreshReserve(
      user.kaminoProgram,
      config.KAMINO_RESERVE,
      config.KAMINO_MARKET,
      config.RESERVE_ORACLE
    ),
    await simpleRefreshObligation(
      user.kaminoProgram,
      config.KAMINO_MARKET,
      baseObligation,
      [config.KAMINO_RESERVE]
    ),
    await makeKaminoWithdrawIx(
      program,
      {
        marginfiAccount: config.ACCOUNT,
        bank: config.BANK,
        reserveLiquidityMint: config.BANK_MINT,
        destinationTokenAccount: ata,
        lendingMarket: config.KAMINO_MARKET,
        reserve: config.KAMINO_RESERVE,
        reserveFarmState,
        obligationFarmUserState: userState,
      },
      config.AMOUNT,
      config.WITHDRAW_ALL,
      oracleMeta
    )
  );
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  if (sendTx) {
    try {
      console.log("withdraw from: " + config.BANK);
      console.log("by account: " + config.ACCOUNT);
      const v0Message = new TransactionMessage({
        payerKey: user.wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(luts);
      const v0Tx = new VersionedTransaction(v0Message);

      v0Tx.sign([user.wallet.payer]);
      const signature = await connection.sendTransaction(v0Tx, {
        maxRetries: 2,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      console.log("tx signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    const v0Message = new TransactionMessage({
      payerKey: config.MULTISIG_PAYER,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(luts);
    const v0Tx = new VersionedTransaction(v0Message);

    const serializedTransaction = v0Tx.serialize();
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("withdraw from: " + config.BANK);
    console.log("by account: " + config.ACCOUNT);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
