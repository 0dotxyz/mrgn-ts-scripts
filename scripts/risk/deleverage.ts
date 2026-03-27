import {
  AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  wrappedI80F48toBigNumber,
} from "@mrgnlabs/mrgn-common";
import {
  commonSetup,
  registerDriftProgram,
  registerKaminoProgram,
} from "../../lib/common-setup";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import BigNumber from "bignumber.js";
import { deriveLiquidationRecord } from "../common/pdas";
import { ASSET_TAG_DRIFT, ASSET_TAG_KAMINO } from "../../lib/constants";
import {
  makeKaminoWithdrawIx,
  simpleRefreshObligation,
  simpleRefreshReserve,
} from "../kamino/ixes-common";
import { FARMS_PROGRAM_ID, KLEND_PROGRAM_ID } from "../kamino/kamino-types";
import { deriveUserState } from "../kamino/pdas";
import {
  deriveDriftSignerPDA,
  deriveDriftStatePDA,
  deriveSpotMarketVaultPDA,
  DRIFT_PROGRAM_ID,
} from "../drift/lib/utils";
import { updateLut } from "../../luts/update_lut";

const sendTx = true;

type Balances = Array<{
  bankPk: PublicKey;
  isCollateral: boolean;
  shares: BigNumber;
  hasEmissions: boolean;
}>;
type AccountBanks = Map<PublicKey, Balances>;
type FetchedBanks = Map<string, any>; // any here is our Bank type
type FetchedReserves = Map<string, any>; // any here is the Reserve type from Kamino IDL
type FetchedSpotMarkets = Map<string, any>; // any here is the SpotMarket type from Drift IDL

const confidence = BigNumber(0.0212);

const grandConfig = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANK: new PublicKey("BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR"), // UXD
  LUT: new PublicKey("FtQ5uKQvFoKQ27SWY15tgBeJQnGKmKGzWqDz7kGUbeiq"),
};

type Config = {
  PROGRAM_ID: string;
  BANK: PublicKey;
  ACCOUNT: PublicKey;
  BALANCES: Balances;
  LUT: PublicKey;
};

async function main() {
  const raw = fs.readFileSync(
    // Note: use a log created by fetch-accounts-for-bank.ts
    // "logs/BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR_accounts.json",
    "logs/test.json",
    "utf8",
  );
  const data = JSON.parse(raw);

  const accountBanks = parseAccountBanks(data);

  let fetchedBanks: FetchedBanks = new Map();
  let fetchedReserves: FetchedReserves = new Map();
  let fetchedSpotMarkets: FetchedSpotMarkets = new Map();

  for (const [accountPk, balances] of accountBanks) {
    const config: Config = {
      PROGRAM_ID: grandConfig.PROGRAM_ID,
      BANK: grandConfig.BANK,
      ACCOUNT: accountPk,
      BALANCES: balances,
      LUT: grandConfig.LUT,
    };

    await deleverage(
      sendTx,
      config,
      "/.config/stage/id.json",
      fetchedBanks,
      fetchedReserves,
      fetchedSpotMarkets,
    );
  }
}

export async function deleverage(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  fetchedBanks?: FetchedBanks,
  fetchedReserves?: FetchedReserves,
  fetchedSpotMarkets?: FetchedSpotMarkets,
  version?: "current",
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    undefined,
    version,
  );
  registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
  registerDriftProgram(user, DRIFT_PROGRAM_ID.toString());
  const program = user.program;
  const connection = user.connection;

  if (!fetchedBanks.has(config.BANK.toBase58())) {
    console.log();
    console.log("Fetching bank: ", config.BANK.toBase58());
    console.log();
    fetchedBanks.set(
      config.BANK.toBase58(),
      await program.account.bank.fetch(config.BANK),
    );
  }

  const liabBank = fetchedBanks.get(config.BANK.toBase58());
  const liabMint = liabBank.mint;
  const liabAta = getAssociatedTokenAddressSync(
    liabMint,
    user.wallet.publicKey,
    true,
    TOKEN_PROGRAM_ID,
  );

  let instructions: TransactionInstruction[] = [];
  instructions.push(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  );

  let liabValue: BigNumber;
  let remainingAccounts: PublicKey[][] = [];
  let banksToWithdrawFrom: {
    bankPk: PublicKey;
    shares: BigNumber;
    hasEmissions: boolean;
  }[] = [];
  for (const {
    bankPk,
    isCollateral,
    shares,
    hasEmissions,
  } of config.BALANCES) {
    if (config.BANK.toBase58() == bankPk.toBase58()) {
      if (isCollateral || shares.isNaN()) {
        return;
      } else {
        console.log();
        console.log("Deleveraging account: ", config.ACCOUNT.toBase58());

        const liabShareValue = wrappedI80F48toBigNumber(
          liabBank.liabilityShareValue,
        );

        const liabTokens = shares.multipliedBy(liabShareValue);

        const price = wrappedI80F48toBigNumber(liabBank.cache.lastOraclePrice);
        const adjustedPrice = price.multipliedBy(BigNumber(1).plus(confidence));
        liabValue = liabTokens
          .dividedBy(10 ** liabBank.mintDecimals)
          .multipliedBy(adjustedPrice);

        console.log();
        console.log("liab share value: ", liabShareValue.toString());
        console.log("liab tokens (native): ", liabTokens.toString());
        console.log(
          "price: ",
          price.toString(),
          "(adjusted: )",
          adjustedPrice.toString(),
        );
        console.log("LIAB value: ", liabValue.toString());
        console.log();
      }
    }

    if (!fetchedBanks.has(bankPk.toBase58())) {
      console.log("Fetching bank: ", bankPk.toBase58());
      fetchedBanks.set(
        bankPk.toBase58(),
        await program.account.bank.fetch(bankPk),
      );
    }
    const bank = fetchedBanks.get(bankPk.toBase58());

    if (isCollateral) {
      // We prioritize withdrawing from USDC banks
      if (
        bank.mint.toBase58() == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      ) {
        banksToWithdrawFrom.unshift({ bankPk, shares, hasEmissions });
      } else {
        banksToWithdrawFrom.push({ bankPk, shares, hasEmissions });
      }
    }

    if (
      bank.config.oracleSetup.switchboardPull ||
      bank.config.oracleSetup.kaminoSwitchboardPull ||
      bank.config.oracleSetup.driftSwitchboardPull
    ) {
      // TODO: put cranking directly in this script. Currently it's done separately.
      console.log("SWB ORACLE:", bank.config.oracleKeys[0].toBase58());
    }

    if (bank.config.oracleSetup.fixed) {
      remainingAccounts.push([bankPk]);
    } else if (
      bank.config.oracleSetup.pythPushOracle ||
      bank.config.oracleSetup.switchboardPull
    ) {
      remainingAccounts.push([bankPk, bank.config.oracleKeys[0]]);
    } else if (
      bank.config.oracleSetup.kaminoPythPush ||
      bank.config.oracleSetup.kaminoSwitchboardPull
    ) {
      remainingAccounts.push([
        bankPk,
        bank.config.oracleKeys[0],
        bank.config.oracleKeys[1],
      ]);

      if (!fetchedReserves.has(bank.integrationAcc1.toBase58())) {
        console.log("Fetching reserve: ", bank.integrationAcc1.toBase58());
        fetchedReserves.set(
          bank.integrationAcc1.toBase58(),
          await user.kaminoProgram.account.reserve.fetch(bank.integrationAcc1),
        );
      }
      const reserve = fetchedReserves.get(bank.integrationAcc1.toBase58());

      instructions.push(
        await simpleRefreshReserve(
          user.kaminoProgram,
          bank.integrationAcc1,
          reserve.lendingMarket,
          reserve.config.tokenInfo.scopeConfiguration.priceFeed,
        ),
      );
    } else if (
      bank.config.oracleSetup.driftPythPull ||
      bank.config.oracleSetup.driftSwitchboardPull
    ) {
      remainingAccounts.push([
        bankPk,
        bank.config.oracleKeys[0],
        bank.config.oracleKeys[1],
      ]);
    } else if (bank.config.oracleSetup.stakedWithPythPush) {
      remainingAccounts.push([
        bankPk,
        bank.config.oracleKeys[0],
        bank.config.oracleKeys[1],
        bank.config.oracleKeys[2],
      ]);
    }
  }

  const [liqRecordKey] = deriveLiquidationRecord(
    program.programId,
    config.ACCOUNT,
  );
  const liqRecordInfo = await connection.getAccountInfo(liqRecordKey);
  if (!liqRecordInfo) {
    console.log(
      "Creating liquidation record for account: ",
      config.ACCOUNT.toBase58(),
    );
    const transaction = new Transaction();
    transaction.add(
      await program.methods
        .marginfiAccountInitLiqRecord()
        .accounts({
          marginfiAccount: config.ACCOUNT,
          feePayer: user.wallet.publicKey,
        })
        .instruction(),
    );
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer],
        {
          commitment: "confirmed",
        },
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  }

  const startRemaining = remainingAccounts.flat();
  let startMeta: AccountMeta[] = startRemaining.map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));

  instructions.push(
    await program.methods
      .startDeleverage()
      .accounts({
        marginfiAccount: config.ACCOUNT,
      })
      .remainingAccounts(startMeta)
      .instruction(),
  );

  remainingAccounts = remainingAccounts.filter(
    (a) => a[0].toBase58() != config.BANK.toBase58(),
  );
  const repayRemaining = remainingAccounts.flat();
  let repayMeta: AccountMeta[] = repayRemaining.map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));
  instructions.push(
    await program.methods
      .lendingAccountRepay(new BN(0), true)
      .accounts({
        marginfiAccount: config.ACCOUNT,
        bank: config.BANK,
        signerTokenAccount: liabAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(repayMeta)
      .instruction(),
  );

  for (const { bankPk, shares, hasEmissions } of banksToWithdrawFrom) {
    const bank = fetchedBanks.get(bankPk.toBase58());
    if (wrappedI80F48toBigNumber(bank.config.assetWeightInit).isZero()) {
      continue;
    }

    const shareValue = wrappedI80F48toBigNumber(bank.assetShareValue);

    const seizableTokens = shares.multipliedBy(shareValue);

    const price = wrappedI80F48toBigNumber(bank.cache.lastOraclePrice);
    if (price.isZero()) {
      continue;
    }
    const adjustedPrice = price.multipliedBy(BigNumber(1).minus(confidence));
    const seizableValue = seizableTokens
      .dividedBy(10 ** bank.mintDecimals)
      .multipliedBy(adjustedPrice);

    console.log();
    console.log("bank: ", bankPk.toString());
    console.log("mint: ", bank.mint.toString());
    console.log("share value: ", shareValue.toString());
    console.log("seizable tokens (native): ", seizableTokens.toString());
    console.log(
      "price: ",
      price.toString(),
      "(adjusted: )",
      adjustedPrice.toString(),
    );
    console.log("SEIZABLE value: ", seizableValue.toString());
    console.log();

    if (hasEmissions && seizableValue.isLessThan(0.1)) {
      console.log("EMISSIONS active and the seizable value is small, ignoring");
      continue;
    }

    let withdrawAmount: BN;
    let withdrawAll: boolean;
    if (liabValue.gt(seizableValue)) {
      liabValue = liabValue.minus(seizableValue);
      console.log(
        "Withdrawing ALL, remaining liab value to cover: ",
        liabValue.toString(),
      );
      withdrawAmount = new BN(0);
      withdrawAll = true;
    } else {
      const proportion = liabValue.dividedBy(seizableValue);
      // console.log("proportion", proportion.toString());

      const fullValue = seizableTokens.multipliedBy(proportion);
      // console.log("fullValue", fullValue.toString());

      let adjustedValue: BigNumber;
      if (liabValue.isLessThan(0.001)) {
        // Such small values may cause WorseHealthPostLiquidation but give no practical sense for withdrawing.
        adjustedValue = BigNumber(0);
      } else {
        adjustedValue = fullValue.integerValue(BigNumber.ROUND_FLOOR);
      }

      if (adjustedValue.isZero()) {
        console.log("NOTHING to withdraw, skipping");
        continue;
      }

      withdrawAmount = new BN(adjustedValue.toString()); // this is just to not accidentally withdraw too much
      console.log("Withdrawing: ", withdrawAmount.toString());
      withdrawAll = false;
      break;
    }
    console.log();

    const withdrawRemaining = remainingAccounts.flat();
    let withdrawMeta: AccountMeta[] = withdrawRemaining.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    }));

    let mintAccInfo = await connection.getAccountInfo(bank.mint);
    const tokenProgram = mintAccInfo.owner;
    let isT22 = tokenProgram.toString() == TOKEN_2022_PROGRAM_ID.toString();

    if (isT22) {
      const m: AccountMeta = {
        pubkey: bank.mint,
        isSigner: false,
        isWritable: false,
      };
      // must be pushed first in the array
      withdrawMeta.unshift(m);
    }

    const ata = getAssociatedTokenAddressSync(
      bank.mint,
      user.wallet.publicKey,
      true,
      tokenProgram,
    );

    // const info = await connection.getAccountInfo(ata);
    // if (!info) {
    //   console.log("Creating idempotent account for mint: ", bank.mint.toBase58());
    //   const ataTransaction = new Transaction();
    //   ataTransaction.add(
    //     createAssociatedTokenAccountIdempotentInstruction(
    //       user.wallet.publicKey,
    //       ata,
    //       user.wallet.publicKey,
    //       bank.mint,
    //       tokenProgram,
    //     ),
    //   );
    //   const signature = await sendAndConfirmTransaction(
    //     connection,
    //     ataTransaction,
    //     [user.wallet.payer],
    //   );
    // }

    if (bank.config.assetTag == ASSET_TAG_KAMINO) {
      const reserve = fetchedReserves.get(bank.integrationAcc1.toBase58());
      const [userState] = deriveUserState(
        FARMS_PROGRAM_ID,
        reserve.farmCollateral,
        bank.integrationAcc2,
      );

      instructions.push(
        await simpleRefreshObligation(
          user.kaminoProgram,
          reserve.lendingMarket,
          bank.integrationAcc2,
          [bank.integrationAcc1],
        ),
        await makeKaminoWithdrawIx(
          program,
          {
            marginfiAccount: config.ACCOUNT,
            bank: config.BANK,
            destinationTokenAccount: ata,
            lendingMarket: reserve.lendingMarket,
            reserveLiquidityMint: bank.mint,
            reserveFarmState: reserve.farmCollateral,
            obligationFarmUserState: userState,
          },
          withdrawAmount,
          withdrawAll,
          withdrawMeta,
        ),
      );
    } else if (bank.config.assetTag == ASSET_TAG_DRIFT) {
      if (!fetchedSpotMarkets.has(bank.integrationAcc1.toBase58())) {
        console.log("Fetching spot market: ", bank.integrationAcc1.toBase58());
        const fetched = await (
          user.driftProgram as any
        ).account.spotMarket.fetch(bank.integrationAcc1);
        fetchedSpotMarkets.set(bank.integrationAcc1.toBase58(), fetched);
      }
      const spotMarket = fetchedSpotMarkets.get(
        bank.integrationAcc1.toBase58(),
      );

      const [driftState] = deriveDriftStatePDA();
      const [driftSigner] = deriveDriftSignerPDA();
      const [driftSpotMarketVault] = deriveSpotMarketVaultPDA(
        spotMarket.marketIndex,
      );

      instructions.push(
        await program.methods
          .driftWithdraw(withdrawAmount, withdrawAll)
          .accounts({
            marginfiAccount: config.ACCOUNT,
            bank: bankPk,
            destinationTokenAccount: ata,
            driftState,
            driftSpotMarketVault,
            driftSigner,
            driftOracle: spotMarket.oracle,
            driftRewardOracle: null,
            driftRewardSpotMarket: null,
            driftRewardMint: null,
            driftRewardOracle2: null,
            driftRewardSpotMarket2: null,
            driftRewardMint2: null,
            tokenProgram,
          })
          .remainingAccounts(withdrawMeta)
          .instruction(),
      );
    } else {
      instructions.push(
        await program.methods
          .lendingAccountWithdraw(withdrawAmount, withdrawAll)
          .accounts({
            marginfiAccount: config.ACCOUNT,
            bank: bankPk,
            destinationTokenAccount: ata,
            tokenProgram,
          })
          .remainingAccounts(withdrawMeta)
          .instruction(),
      );
    }

    if (withdrawAll) {
      remainingAccounts = remainingAccounts.filter(
        (a) => a[0].toBase58() != bankPk.toBase58(),
      );
    } else {
      break;
    }
  }

  const endRemaining = remainingAccounts.flat();
  let endMeta: AccountMeta[] = endRemaining.map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));

  instructions.push(
    await program.methods
      .endDeleverage()
      .accounts({
        marginfiAccount: config.ACCOUNT,
      })
      .remainingAccounts(endMeta)
      .instruction(),
  );

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

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  const v0Message = new TransactionMessage({
    payerKey: user.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(luts);
  const v0Tx = new VersionedTransaction(v0Message);
  try {
    v0Tx.sign([user.wallet.payer]);
    const signature = await connection.sendTransaction(v0Tx, {
      maxRetries: 2,
    });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    console.log("Success:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
    if (
      String(error).includes("Transaction too large") ||
      String(error).includes("encoding overruns Uint8Array")
    ) {
      const keys = new Set(
        instructions.flatMap((i) => i.keys.map((m) => m.pubkey.toBase58())),
      );
      const keysArray = [...keys].map((k) => new PublicKey(k));
      for (let i = 0; i < keysArray.length; i += 8) {
        const chunk = keysArray.slice(i, i + 8);
        await updateLut(
          true,
          {
            LUT: config.LUT,
            KEYS: chunk,
          },
          walletPath,
        );
      }
      try {
        const { blockhash, lastValidBlockHeight } =
          await connection.getLatestBlockhash();
        const lutLookup = await connection.getAddressLookupTable(config.LUT);
        const v0Message = new TransactionMessage({
          payerKey: user.wallet.publicKey,
          recentBlockhash: blockhash,
          instructions,
        }).compileToV0Message([lutLookup.value]);
        const v0Tx = new VersionedTransaction(v0Message);

        v0Tx.sign([user.wallet.payer]);
        const signature = await connection.sendTransaction(v0Tx, {
          maxRetries: 2,
        });
        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        console.log("Success:", signature);
      } catch (error) {
        console.error("Transaction failed:", error);
      }
    }
    if (String(error).includes("Transaction locked too many accounts")) {
      // Analyze the output and decrease the amount of locked accs
      countUniqueWritableKeys(v0Tx, luts);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}

function parseAccountBanks(json: unknown): AccountBanks {
  if (!Array.isArray(json)) throw new Error("Expected array");

  const result: AccountBanks = new Map();

  for (const entry of json as any[]) {
    if (
      typeof entry?.publicKey !== "string" ||
      !Array.isArray(entry?.balances)
    ) {
      throw new Error("Invalid entry");
    }

    const accountPk = new PublicKey(entry.publicKey);

    const banks: Balances = entry.balances.map((b: any) => {
      if (typeof b?.bankPk !== "string") {
        throw new Error("Invalid balance");
      }
      const isCollateral =
        b.assetShares !== "-" &&
        Number.isFinite(Number(b.assetShares)) &&
        Number(b.assetShares) > 0;

      let shares: BigNumber;
      if (isCollateral) {
        shares = new BigNumber(b.assetShares);
      } else {
        shares = new BigNumber(b.liabilityShares);
      }
      return {
        bankPk: new PublicKey(b.bankPk),
        isCollateral,
        shares,
        hasEmissions: b.hasEmissions,
      };
    });

    result.set(accountPk, banks);
  }

  return result;
}

function countUniqueWritableKeys(
  vtx: VersionedTransaction,
  alts: AddressLookupTableAccount[],
) {
  const msg = vtx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: alts });

  const writable = new Set<string>();

  for (let i = 0; i < keys.length; i++) {
    if (msg.isAccountWritable(i)) {
      writable.add(keys.get(i)!.toBase58());
    }
  }

  console.log("total keys:", keys.length);
  console.log("unique writable keys:", writable.size);
}
