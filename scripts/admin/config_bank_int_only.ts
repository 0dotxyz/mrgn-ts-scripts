import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";
import { InterestRateConfigOpt1_6, RatePoint } from "../common/types";
import { aprToU32, utilToU32 } from "../../lib/utils";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

export type Config = {
  PROGRAM_ID: string;
  CURVE_ADMIN: PublicKey;
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  CURVE_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
  MULTISIG_PAYER: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
};

// For consistency/readability this file uses percents for everything, here we convert since the
// utils expect a float.
const aprPctToU32 = (aprPct: number): number => aprToU32(aprPct / 100);
const utilPctToU32 = (utilPct: number): number => utilToU32(utilPct / 100);

const makeRatePoint = (utilPct: number, aprPct: number): RatePoint => ({
  util: utilPctToU32(utilPct),
  rate: aprPctToU32(aprPct),
});

const makeRatePoints = (utilPct: number[], aprPct: number[]): RatePoint[] => {
  if (utilPct.length > 5 || aprPct.length > 5) {
    throw new Error("makeRatePoints: maximum of 5 points allowed");
  }
  if (utilPct.length !== aprPct.length) {
    throw new Error("makeRatePoints: expected one APR value per util value");
  }

  for (let i = 1; i < utilPct.length; i++) {
    if (utilPct[i] < utilPct[i - 1]) {
      throw new Error("makeRatePoints: util values must be in ascending order");
    }
    if (aprPct[i] <= aprPct[i - 1]) {
      throw new Error("makeRatePoints: apr values must be in ascending order");
    }
  }

  const points: RatePoint[] = utilPct.map((u, i) => makeRatePoint(u, aprPct[i]));
  while (points.length < 5) {
    points.push(makeRatePoint(0, 0));
  }

  return points;
};

// ---- List your (BANK, intConfig) pairs here ----
const ITEMS: Array<{ bank: PublicKey; int: InterestRateConfigOpt1_6 }> = [
  // SOL
  {
    bank: new PublicKey("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh"),
    int: {
      protocolOriginationFee: null,
      protocolIrFee: null,
      protocolFixedFeeApr: null,
      insuranceIrFee: null,
      insuranceFeeFixedApr: null,

      zeroUtilRate: aprPctToU32(0),
      hundredUtilRate: aprPctToU32(20),
      points: makeRatePoints([90, 98, 99], [5, 7, 10]),
    },
  },
  // USDC
  {
    bank: new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"),
    int: {
      protocolOriginationFee: null,
      protocolIrFee: null,
      protocolFixedFeeApr: null,
      insuranceIrFee: null,
      insuranceFeeFixedApr: null,

      zeroUtilRate: aprPctToU32(0),
      hundredUtilRate: aprPctToU32(15),
      points: makeRatePoints([50, 80, 90, 95, 98], [2, 4, 5, 7.5, 10]),
    },
  },
  // USDT
  {
    bank: new PublicKey("HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV"),
    int: {
      protocolOriginationFee: null,
      protocolIrFee: null,
      protocolFixedFeeApr: null,
      insuranceIrFee: null,
      insuranceFeeFixedApr: null,

      zeroUtilRate: aprPctToU32(0),
      hundredUtilRate: aprPctToU32(15),
      points: makeRatePoints([50, 80, 90, 95, 98], [2, 4, 5, 7.5, 10]),
    },
  },
];

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/.keys/staging-deploy.json",
    config.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;

  const transaction = new Transaction();

  // Create one instruction per (bank, int) pair
  for (const { bank, int } of ITEMS) {
    const ix = await program.methods
      .lendingPoolConfigureBankInterestOnly(int)
      .accounts({
        bank,
      })
      .accountsPartial({
        delegateCurveAdmin: config.CURVE_ADMIN,
      })
      .instruction();

    transaction.add(ix);
  }

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer]
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    // Prepare unsigned tx for Squads or offline sigs
    if (!config.MULTISIG_PAYER) {
      throw new Error("MULTISIG_PAYER must be set when sendTx = false.");
    }
    transaction.feePayer = config.MULTISIG_PAYER;
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

main().catch((err) => {
  console.error(err);
});
