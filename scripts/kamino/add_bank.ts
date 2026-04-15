import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  bigNumberToWrappedI80F48,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@mrgnlabs/mrgn-common";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  FARMS_PROGRAM_ID,
  KLEND_PROGRAM_ID,
  KaminoConfigCompact,
  OracleSetupRawWithKamino,
} from "./kamino-types";
import { commonSetup, registerKaminoProgram } from "../../lib/common-setup";
import { makeAddKaminoBankIx, makeInitObligationIx } from "./ixes-common";
import { deriveBankWithSeed, deriveLiquidityVaultAuthority } from "../common/pdas";
import { deriveBaseObligation, deriveUserState } from "./pdas";
import { getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;
/**
 * If true, include Kamino init obligation in the tx.
 */
const toInit = true;

type Config = {
  PROGRAM_ID: string;
  GROUP_KEY: PublicKey;
  /** Oracle used by marginfi bank config */
  ORACLE: PublicKey;
  /** Oracle used by Kamino reserve refresh/init (can differ from ORACLE) */
  RESERVE_ORACLE: PublicKey;
  /** { kaminoPythPush: {} } (6) or  { kaminoSwitchboardPull: {} } (7) */
  ORACLE_TYPE: OracleSetupRawWithKamino;
  /** Group admin (generally the MS on mainnet) */
  ADMIN: PublicKey;
  /** Pays flat sol fee to init and rent (generally the MS on mainnet) */
  FEE_PAYER?: PublicKey; // If omitted, defaults to ADMIN
  BANK_MINT: PublicKey;
  KAMINO_RESERVE: PublicKey;
  KAMINO_MARKET: PublicKey;
  SEED: number;
  LUT?: PublicKey; // Optional, but strongly recommended for v0 size reduction
  MULTISIG_PAYER?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEY: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),

  // PyUSD (Prime market)
  ORACLE: new PublicKey("9zXQxpYH3kYhtoybmZfUNNCRVuud7fY9jswTg1hLyT8k"),
  RESERVE_ORACLE: new PublicKey("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"),
  ORACLE_TYPE: { kaminoPythPush: {} },
  BANK_MINT: new PublicKey("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"),
  KAMINO_RESERVE: new PublicKey("3ZUAwhEtK8XWfK4fy98z4yoptm4GeyeAu21L11HPXaZ5"),
  KAMINO_MARKET: new PublicKey("CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA"), // prime
  LUT: new PublicKey("C83sPjiLpUU5oGtEjYo5i1LoRagSsdPj62SaLsWWUN3T"),

  SEED: 34,
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  await addKaminoBank(sendTx, config, "/.keys/staging-deploy.json");
}

export async function addKaminoBank(
  sendTx: boolean,
  config: Config,
  walletPath: string,
): Promise<PublicKey> {
  console.log("adding bank to group: " + config.GROUP_KEY);
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  if (toInit) {
    registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  }
  const program = user.program;
  const connection = user.connection;

  const bankConfig: KaminoConfigCompact = {
    assetWeightInit: bigNumberToWrappedI80F48(0.6),
    assetWeightMaint: bigNumberToWrappedI80F48(0.75),
    depositLimit: new BN(1_500_000 * 10 ** 6),
    operationalState: { operational: {} },
    riskTier: { collateral: {} },
    totalAssetValueInitLimit: new BN(1_500_000),
    oracleMaxAge: 300,
    oracleMaxConfidence: 0,
    oracle: config.ORACLE,
    oracleSetup: config.ORACLE_TYPE,
    configFlags: 0,
  };

  console.log("Detecting token program for mint...");
  let tokenProgram = TOKEN_PROGRAM_ID;
  try {
    await getMint(
      connection,
      config.BANK_MINT,
      "confirmed",
      TOKEN_2022_PROGRAM_ID,
    );
    tokenProgram = TOKEN_2022_PROGRAM_ID;
    console.log("  Using Token-2022 program");
  } catch {
    // If it fails with Token-2022, it's a regular SPL token
    console.log("  Using SPL Token program");
  }
  console.log();

  const [bankKey] = deriveBankWithSeed(
    program.programId,
    config.GROUP_KEY,
    config.BANK_MINT,
    new BN(config.SEED),
  );

  let luts: AddressLookupTableAccount[] = [];
  if (config.LUT) {
    const lutLookup = await connection.getAddressLookupTable(config.LUT);
    if (!lutLookup.value) {
      throw new Error(`LUT not found on-chain: ${config.LUT.toBase58()}`);
    }
    luts = [lutLookup.value];
  }

  const feePayer = config.FEE_PAYER ?? config.ADMIN;
  const instructions: TransactionInstruction[] = [];

  instructions.push(
    await makeAddKaminoBankIx(
      program,
      {
        group: config.GROUP_KEY,
        feePayer,
        bankMint: config.BANK_MINT,
        integrationAcc1: config.KAMINO_RESERVE,
        kaminoMarket: config.KAMINO_MARKET,
        oracle: config.ORACLE,
        tokenProgram,
        admin: config.ADMIN,
      },
      {
        seed: new BN(config.SEED),
        config: bankConfig,
      },
    ),
  );

  let baseObligation: PublicKey | null = null;
  if (toInit) {
    const reserveAcc = await user.kaminoProgram.account.reserve.fetch(
      config.KAMINO_RESERVE,
    );
    const lendingMarket = reserveAcc.lendingMarket;
    const reserveMint = reserveAcc.liquidity.mintPubkey;
    let reserveFarmState = reserveAcc.farmCollateral;

    if (!reserveMint.equals(config.BANK_MINT)) {
      throw new Error(
        `Reserve mint mismatch. Reserve=${reserveMint.toString()} bankMint=${config.BANK_MINT.toString()}`,
      );
    }
    if (!lendingMarket.equals(config.KAMINO_MARKET)) {
      throw new Error(
        `Reserve market mismatch. Reserve=${lendingMarket.toString()} config=${config.KAMINO_MARKET.toString()}`,
      );
    }

    const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
      program.programId,
      bankKey,
    );
    const signerTokenAccount = getAssociatedTokenAddressSync(
      reserveMint,
      feePayer,
      true,
      tokenProgram,
    );
    [baseObligation] = deriveBaseObligation(liquidityVaultAuthority, lendingMarket);

    let [obligationFarmUserState] = deriveUserState(
      FARMS_PROGRAM_ID,
      reserveFarmState,
      baseObligation,
    );
    if (reserveFarmState.equals(PublicKey.default)) {
      reserveFarmState = null;
      obligationFarmUserState = null;
    }

    instructions.push(
      await makeInitObligationIx(
        program,
        {
          feePayer,
          bank: bankKey,
          signerTokenAccount,
          lendingMarket,
          reserve: config.KAMINO_RESERVE,
          scopePrices: config.RESERVE_ORACLE,
          reserveFarmState,
          obligationFarmUserState,
          liquidityTokenProgram: tokenProgram,
          mint: reserveMint,
          reserveLiquiditySupply: reserveAcc.liquidity.supplyVault,
          reserveCollateralMint: reserveAcc.collateral.mintPubkey,
          reserveDestinationDepositCollateral: reserveAcc.collateral.supplyVault,
        },
        new BN(100),
      ),
    );
  }

  const payerKey = sendTx
    ? user.wallet.publicKey
    : (config.MULTISIG_PAYER ??
      (() => {
        throw new Error("MULTISIG_PAYER must be set when sendTx=false");
      })());
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();
  const v0Message = new TransactionMessage({
    payerKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(luts);
  const v0Tx = new VersionedTransaction(v0Message);

  if (sendTx) {
    try {
      v0Tx.sign([user.wallet.payer]);
      const sigInit = await connection.sendTransaction(v0Tx, {
        maxRetries: 2,
      });
      await connection.confirmTransaction(
        { signature: sigInit, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      console.log("bank key: " + bankKey);
      if (baseObligation) {
        console.log("obligation key: " + baseObligation.toString());
      }
      console.log("Transaction signature:", sigInit);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else {
    const lutKeys = getUniqueInstructionPubkeys(instructions);
    const serializedTransaction = v0Tx.serialize();
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("bank key: " + bankKey);
    if (baseObligation) {
      console.log("obligation key: " + baseObligation.toString());
    }
    console.log("LUT keys (paste into update_lut.ts):");
    lutKeys.forEach((key) =>
      console.log(`    new PublicKey("${key.toString()}"),`),
    );
    console.log();
    console.log("Base58-encoded transaction:", base58Transaction);
  }

  return bankKey;
}

function getUniqueInstructionPubkeys(
  instructions: TransactionInstruction[],
): PublicKey[] {
  const keys = instructions.flatMap((ix) => ix.keys.map((key) => key.pubkey));
  return Array.from(new Map(keys.map((key) => [key.toString(), key])).values());
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
