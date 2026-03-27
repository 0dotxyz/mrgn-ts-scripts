// Run deposit_single_pool first to convert to LST. In production, these will likely be atomic.
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
import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import { BankAndOracles } from "../../lib/utils";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import {
  simpleRefreshObligation,
  simpleRefreshReserve,
} from "../kamino/ixes-common";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  LIQUIDATOR: PublicKey;
  LIQUIDATEE: PublicKey;
  COLLATERAL_BANK: PublicKey;
  COLLATERAL_MINT: PublicKey;
  COLLATERAL_ORACLE: PublicKey;
  DEBT_BANK: PublicKey;
  DEBT_MINT: PublicKey;
  DEBT_ORACLE: PublicKey;
  /** In native decimals */
  AMOUNT: BN;
  LIQUIDATOR_REMAINING: BankAndOracles;
  LIQUIDATEE_REMAINING: BankAndOracles;
  ADD_COMPUTE_UNITS: boolean;
  LUT: PublicKey;

  // Optional, omit if not using MS.
  MULTISIG?: PublicKey;

  // Optional, omit if neither liquidator nor liquidatee have active Kamino positions
  KAMINO_RESERVE?: PublicKey;
  KAMINO_MARKET?: PublicKey;
  RESERVE_ORACLE?: PublicKey;

  // Optional, omit if COLLATERAL_BANK is non-kamino
  OBLIGATION?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  LIQUIDATOR: new PublicKey("FvRj5WiHZh6mU9TSsgAeJinDeSAkBmPvbJHJCqXAxCsH"),
  LIQUIDATEE: new PublicKey("GUPa5bHBFxqcpAKnehhwzV7McKrA92AaCMSj5MsxttPE"),
  COLLATERAL_BANK: new PublicKey(
    "Ay8kyX7q2G9Yp3T6Nt8Z3p8xcMeaC19xLQjmGjTX2niq",
  ),
  COLLATERAL_MINT: new PublicKey(
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  ),
  COLLATERAL_ORACLE: new PublicKey(
    "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX",
  ),
  DEBT_BANK: new PublicKey("CVjHEnJWKELsbFt37znC2nq4KNrwTf7w42fcfySEifNu"),
  DEBT_MINT: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
  DEBT_ORACLE: new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"),
  AMOUNT: new BN(0.05 * 10 ** 6), // 0.05 USDC
  LIQUIDATOR_REMAINING: [
    new PublicKey("CVjHEnJWKELsbFt37znC2nq4KNrwTf7w42fcfySEifNu"), // BONK
    new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"),

    new PublicKey("Ay8kyX7q2G9Yp3T6Nt8Z3p8xcMeaC19xLQjmGjTX2niq"), // newly created USDC position
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),
  ],
  LIQUIDATEE_REMAINING: [
    new PublicKey("GTeUyNaftFgZHLfPiuC5ZLJTYTA75i1yoDAoUymGVdan"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("DFiyddNb7Hf48PoBuy4pxZsqAadG81gviN5NqdnwCiVT"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("CVjHEnJWKELsbFt37znC2nq4KNrwTf7w42fcfySEifNu"), // BONK
    new PublicKey("DBE3N8uNjhKPRHfANdwGvCZghWXyLPdqdSbEW2XFwBiX"),

    new PublicKey("BtnG6KXXKxd9hzCMC7HmM8EfLQquw4DFPEXrSxgXP18H"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("Ay8kyX7q2G9Yp3T6Nt8Z3p8xcMeaC19xLQjmGjTX2niq"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("9snV9wxCEt6FNagg5FEQNbYazDJTD8PWiLUBSfqZhC7S"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("9qAerN38xQFxtVCvoA2oGfrQQ3bvBuKBv72LrHS5DLJu"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("9cmWCZ2fQXrk8xnu6deKp1RPQKyqmCav97rvrxybjMpN"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("8vEZQdezXeqeE7VUYQYQM3R61CbdYrtuXNGkbUPwEVX2"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("7ijHw1oBJxyfWjSeWBSSnRSAp3BFk59LeCTy4WbgvJ3U"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("7bRoeKP4bbKVf1ARK5g7a1GVqhAQA1V7Cix7yDzSpG9D"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("5JG1WJ7UZniv51jY2xbMSR1CKJ4SsY6ub71vqQAMWNDX"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("51NtMW17paWS9t1k3BeCKJTLuJiaHtFDkZM3R2ZvjWq3"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),

    new PublicKey("2oEWxmFg8572sHeVaQY2uL81T3ujv29gHdxVeNQbXpPV"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("SyftqdCJ6LjiiJ9PMJ9MAjSFVNdV2JhXFCmd47ij8Ff"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),

    new PublicKey("Fr73y5RxjJK8xcG8CNZ5EXTnSpKMMFLWjpXcpGiFfgY"),
    new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
  ],
  ADD_COMPUTE_UNITS: true,
  LUT: new PublicKey("FtQ5uKQvFoKQ27SWY15tgBeJQnGKmKGzWqDz7kGUbeiq"),
  KAMINO_RESERVE: new PublicKey("D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"),
  KAMINO_MARKET: new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"),
  RESERVE_ORACLE: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
  OBLIGATION: new PublicKey("5HxomAyh1wDSqHp9Gg5n3aF4vLAKQL3WK3baYMZwK6Yd"),
};

async function main() {
  await liquidate(sendTx, config, "/.config/stage/id.json");
}

export async function liquidate(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  version?: "current",
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG,
    version,
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  let luts: AddressLookupTableAccount[] = [];
  const lutLookup = await connection.getAddressLookupTable(config.LUT);
  if (!lutLookup || !lutLookup.value) {
    console.warn(
      `Warning: LUT ${config.LUT.toBase58()} not found on-chain. Proceeding without it.`,
    );
    luts = [];
  } else {
    luts = [lutLookup.value];
  }

  let oracles = [];
  if (config.OBLIGATION !== undefined) {
    oracles = [
      config.COLLATERAL_ORACLE,
      config.RESERVE_ORACLE,
      config.DEBT_ORACLE,
    ];
  } else {
    oracles = [config.COLLATERAL_ORACLE, config.DEBT_ORACLE];
  }

  const remainingAccounts: BankAndOracles = oracles.concat(
    config.LIQUIDATOR_REMAINING.concat(config.LIQUIDATEE_REMAINING),
  );
  const oracleMeta: AccountMeta[] = remainingAccounts.flat().map((pubkey) => {
    return { pubkey, isSigner: false, isWritable: false };
  });

  let instructions: TransactionInstruction[] = [];
  if (config.ADD_COMPUTE_UNITS) {
    // instructions.push(
    //   ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
    // );
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    );
  }

  if (config.KAMINO_RESERVE !== undefined) {
    instructions.push(
      await simpleRefreshReserve(
        user.kaminoProgram,
        config.KAMINO_RESERVE,
        config.KAMINO_MARKET,
        config.RESERVE_ORACLE,
      ),
    );
  }

  if (config.OBLIGATION !== undefined) {
    instructions.push(
      await simpleRefreshObligation(
        user.kaminoProgram,
        config.KAMINO_MARKET,
        config.OBLIGATION,
        [config.KAMINO_RESERVE],
      ),
    );
  }

  instructions.push(
    await program.methods
      .lendingAccountLiquidate(
        config.AMOUNT,
        config.LIQUIDATEE_REMAINING.length,
        config.LIQUIDATOR_REMAINING.length,
      )
      .accounts({
        assetBank: config.COLLATERAL_BANK,
        liabBank: config.DEBT_BANK,
        liquidatorMarginfiAccount: config.LIQUIDATOR,
        liquidateeMarginfiAccount: config.LIQUIDATEE,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(oracleMeta)
      .instruction(),
  );

  console.log(
    config.LIQUIDATOR +
      " liquidating " +
      config.LIQUIDATEE +
      " for : " +
      config.AMOUNT.toString() +
      " of " +
      config.COLLATERAL_MINT,
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  if (sendTx) {
    try {
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
        "confirmed",
      );

      console.log("tx signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    const v0Message = new TransactionMessage({
      payerKey: config.MULTISIG,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(luts);
    const v0Tx = new VersionedTransaction(v0Message);

    const serializedTransaction = v0Tx.serialize();
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
