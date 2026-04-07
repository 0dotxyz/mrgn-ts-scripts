import { PublicKey } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import BigNumber from "bignumber.js";
import fs from "fs";
import path from "path";

type Config = {
  PROGRAM_ID: string;
  WALLET: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  WALLET: new PublicKey("evoxxcAvFrt8Xg6cXKV2Q5SPpnxqEv14VdmAnHmQS13"),
  // top liquidator
  // * evoxxcAvFrt8Xg6cXKV2Q5SPpnxqEv14VdmAnHmQS13
  // second place
  // * 7QRQpcLVFd46Kegg1C2fGZvTPBL5ck2fS8viXbGwaMaU
  // top receivership liquidation
  // * amebFu142uR4RrDMRRWwwhB6mdueFB58ppSEzfQZcft
  // our liquidator
  // * HPeLmNJgQdZ2yzxqiDY5v1EBW8ADF1Fx5Mt4xArjPbuX
};

const LOG_ACTIVITY_TO_FILE = false;
const WINDOW_DEFS = {
  "1h": 1 * 60 * 60,
  "24h": 24 * 60 * 60,
  "3d": 3 * 24 * 60 * 60,
  // !! WARN also restore `WINDOW_ORDER`. Note: 24h+ uses a lot of time + rpc resources

  //  "7d": 7 * 24 * 60 * 60,
  //  "30d": 30 * 24 * 60 * 60,
};
const WINDOW_ORDER = [
  "1h",
  "24h",
  "3d",
  // "7d", "30d"
] as const;

async function main() {
  const user = commonSetup(true, config.PROGRAM_ID, "/.config/solana/id.json");
  const connection = user.connection;
  const program = user.program;
  const programId = new PublicKey(config.PROGRAM_ID);
  const JUPITER_PROGRAM_ID = new PublicKey(
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  );
  const TITAN_PROGRAM_ID = new PublicKey(
    "T1TANpTeScyeqVzzgNViGDNrkQ6qHz9KrSBS4aNXvGT",
  );

  const color = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
  };
  const paint = (text: string, tint: keyof typeof color) =>
    `${color[tint]}${text}${color.reset}`;

  const printTable = (headers: string[], rows: string[][]) => {
    const widths = headers.map((header, idx) =>
      Math.max(header.length, ...rows.map((row) => (row[idx] ?? "").length)),
    );
    const line = (cells: string[]) =>
      cells
        .map((cell, idx) => cell.padEnd(widths[idx]))
        .join("  ")
        .trimEnd();
    console.log(line(headers));
    console.log(line(widths.map((width) => "-".repeat(Math.max(width, 1)))));
    for (const row of rows) {
      console.log(line(row));
    }
  };

  const START_LIQUIDATION_DISCRIMINATOR = [244, 93, 90, 214, 192, 166, 191, 21];
  const LENDING_ACCOUNT_LIQUIDATE_DISCRIMINATOR = [
    214, 169, 151, 213, 251, 167, 86, 219,
  ];
  const LENDING_ACCOUNT_WITHDRAW_DISCRIMINATOR = [
    36, 72, 74, 19, 210, 210, 192, 192,
  ];
  const LENDING_ACCOUNT_REPAY_DISCRIMINATOR = [
    79, 209, 172, 177, 222, 51, 173, 151,
  ];
  const TOKEN_PROGRAM_ID = new PublicKey(
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  );
  const TOKEN_2022_PROGRAM_ID = new PublicKey(
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  );
  const BANK_ACCOUNT_INDEX = 3;
  const LIQUIDATION_ASSET_BANK_ACCOUNT_INDEX = 1;
  const LIQUIDATION_LIABILITY_BANK_ACCOUNT_INDEX = 2;

  const nowSec = Math.floor(Date.now() / 1000);
  const windows = WINDOW_DEFS;
  const windowOrder = WINDOW_ORDER;

  const windowSeconds = windowOrder
    .map((label) => windows[label])
    .filter((value): value is number => typeof value === "number");
  if (windowSeconds.length === 0) {
    throw new Error(
      "WINDOW_DEFS/WINDOW_ORDER must include at least one window.",
    );
  }
  const maxWindowSeconds = Math.max(...windowSeconds);
  const maxWindowLabel = windowOrder[windowSeconds.indexOf(maxWindowSeconds)];
  const cutoffMax = nowSec - maxWindowSeconds;
  const signatures = [];
  let before: string | undefined;

  while (true) {
    const batch = await connection.getSignaturesForAddress(
      config.WALLET,
      { limit: 1000, before },
      "confirmed",
    );
    if (batch.length === 0) {
      break;
    }
    signatures.push(...batch);
    before = batch[batch.length - 1].signature;
    const oldestBlockTime = batch[batch.length - 1].blockTime ?? 0;
    if (oldestBlockTime && oldestBlockTime < cutoffMax) {
      break;
    }
  }

  const candidates = signatures.filter(
    (sig) => sig.blockTime && sig.blockTime >= cutoffMax,
  );

  const matches: {
    signature: string;
    blockTime: number;
    instructionNames: string[];
    success: boolean;
  }[] = [];
  const activityEvents: {
    signature: string;
    time: string;
    status: "success" | "failed";
    instruction: string;
  }[] = [];
  const jupiterTxs: {
    signature: string;
    blockTime: number;
    success: boolean;
  }[] = [];
  const titanTxs: { signature: string; blockTime: number; success: boolean }[] =
    [];
  const withdrawTotals = new Map<string, bigint>();
  const repayTotals = new Map<string, bigint>();
  const liquidationClassicProfitTotals = new Map<string, bigint>();
  const liquidationClassicAssetSeizedTotals = new Map<string, bigint>();

  const matchesDiscriminator = (data: Uint8Array, discriminator: number[]) => {
    if (data.length < discriminator.length) {
      return false;
    }
    for (let i = 0; i < discriminator.length; i += 1) {
      if (data[i] !== discriminator[i]) {
        return false;
      }
    }
    return true;
  };
  const readU64LE = (data: Uint8Array, offset: number) => {
    let value = 0n;
    for (let i = 0; i < 8; i += 1) {
      value |= BigInt(data[offset + i]) << (8n * BigInt(i));
    }
    return value;
  };
  const parseTokenTransferAmount = (data: Uint8Array) => {
    if (data.length < 9) {
      return null;
    }
    const instruction = data[0];
    if (instruction === 3 && data.length >= 9) {
      return readU64LE(data, 1);
    }
    if (instruction === 12 && data.length >= 10) {
      return readU64LE(data, 1);
    }
    return null;
  };
  const parseLiquidationAssetAmount = (data: Uint8Array) => {
    if (
      !matchesDiscriminator(data, LENDING_ACCOUNT_LIQUIDATE_DISCRIMINATOR)
    ) {
      return null;
    }
    const offset = LENDING_ACCOUNT_LIQUIDATE_DISCRIMINATOR.length;
    if (data.length < offset + 8) {
      return null;
    }
    return readU64LE(data, offset);
  };
  const addTotal = (
    totals: Map<string, bigint>,
    bank: string,
    amount: bigint,
  ) => {
    totals.set(bank, (totals.get(bank) ?? 0n) + amount);
  };

  for (const sigInfo of candidates) {
    const tx = await connection.getTransaction(sigInfo.signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      continue;
    }

    const message = tx.transaction.message;
    const staticKeys = message.staticAccountKeys;
    const loadedWritable = tx.meta?.loadedAddresses?.writable ?? [];
    const loadedReadonly = tx.meta?.loadedAddresses?.readonly ?? [];
    const accountKeys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
    const signerIndex = accountKeys.findIndex((key) =>
      key.equals(config.WALLET),
    );

    if (signerIndex < 0 || !message.isAccountSigner(signerIndex)) {
      continue;
    }

    const instructionNames: string[] = [];
    const withdrawRepayByIndex = new Map<
      number,
      { type: "withdraw" | "repay"; bank: PublicKey }
    >();
    const liquidationByIndex = new Map<number, PublicKey>();
    let hasStartLiquidation = false;
    let hasJupiter = false;
    let hasTitan = false;
    for (const [ixIndex, ix] of message.compiledInstructions.entries()) {
      if (ix.programIdIndex >= accountKeys.length) {
        continue;
      }
      const programKey = accountKeys[ix.programIdIndex];
      if (programKey?.equals(JUPITER_PROGRAM_ID)) {
        hasJupiter = true;
      } else if (programKey?.equals(TITAN_PROGRAM_ID)) {
        hasTitan = true;
      }
      if (!programKey || !programKey.equals(programId)) {
        continue;
      }

      const data = typeof ix.data === "string" ? bs58.decode(ix.data) : ix.data;
      if (matchesDiscriminator(data, START_LIQUIDATION_DISCRIMINATOR)) {
        instructionNames.push("startLiquidation");
        hasStartLiquidation = true;
      } else if (
        matchesDiscriminator(data, LENDING_ACCOUNT_LIQUIDATE_DISCRIMINATOR)
      ) {
        instructionNames.push("lendingAccountLiquidate");
        const accountIndexes =
          (ix as { accountKeyIndexes?: number[]; accounts?: number[] })
            .accountKeyIndexes ?? (ix as { accounts?: number[] }).accounts;
        const liabilityBankIndex =
          accountIndexes &&
          accountIndexes.length > LIQUIDATION_LIABILITY_BANK_ACCOUNT_INDEX
            ? accountIndexes[LIQUIDATION_LIABILITY_BANK_ACCOUNT_INDEX]
            : undefined;
        const liabilityBankKey =
          liabilityBankIndex === undefined
            ? undefined
            : accountKeys[liabilityBankIndex];
        if (liabilityBankKey) {
          liquidationByIndex.set(ixIndex, liabilityBankKey);
        }
        const assetBankIndex =
          accountIndexes &&
          accountIndexes.length > LIQUIDATION_ASSET_BANK_ACCOUNT_INDEX
            ? accountIndexes[LIQUIDATION_ASSET_BANK_ACCOUNT_INDEX]
            : undefined;
        const assetBankKey =
          assetBankIndex === undefined ? undefined : accountKeys[assetBankIndex];
        const assetAmount = parseLiquidationAssetAmount(data);
        if (assetBankKey && assetAmount !== null) {
          addTotal(
            liquidationClassicAssetSeizedTotals,
            assetBankKey.toBase58(),
            assetAmount,
          );
        }
      } else if (
        matchesDiscriminator(data, LENDING_ACCOUNT_WITHDRAW_DISCRIMINATOR)
      ) {
        const accountIndexes =
          (ix as { accountKeyIndexes?: number[]; accounts?: number[] })
            .accountKeyIndexes ?? (ix as { accounts?: number[] }).accounts;
        const bankIndex =
          accountIndexes && accountIndexes.length > BANK_ACCOUNT_INDEX
            ? accountIndexes[BANK_ACCOUNT_INDEX]
            : undefined;
        const bankKey =
          bankIndex === undefined ? undefined : accountKeys[bankIndex];
        if (bankKey) {
          withdrawRepayByIndex.set(ixIndex, {
            type: "withdraw",
            bank: bankKey,
          });
        }
      } else if (
        matchesDiscriminator(data, LENDING_ACCOUNT_REPAY_DISCRIMINATOR)
      ) {
        const accountIndexes =
          (ix as { accountKeyIndexes?: number[]; accounts?: number[] })
            .accountKeyIndexes ?? (ix as { accounts?: number[] }).accounts;
        const bankIndex =
          accountIndexes && accountIndexes.length > BANK_ACCOUNT_INDEX
            ? accountIndexes[BANK_ACCOUNT_INDEX]
            : undefined;
        const bankKey =
          bankIndex === undefined ? undefined : accountKeys[bankIndex];
        if (bankKey) {
          withdrawRepayByIndex.set(ixIndex, { type: "repay", bank: bankKey });
        }
      }
    }

    if (tx.meta?.innerInstructions?.length) {
      for (const inner of tx.meta.innerInstructions) {
        const parent = hasStartLiquidation
          ? withdrawRepayByIndex.get(inner.index)
          : undefined;
        const liquidationBank = liquidationByIndex.get(inner.index);
        if (!parent && !liquidationBank) {
          continue;
        }
        for (const innerIx of inner.instructions) {
          if (innerIx.programIdIndex >= accountKeys.length) {
            continue;
          }
          const innerProgram = accountKeys[innerIx.programIdIndex];
          if (
            !innerProgram ||
            (!innerProgram.equals(TOKEN_PROGRAM_ID) &&
              !innerProgram.equals(TOKEN_2022_PROGRAM_ID))
          ) {
            continue;
          }
          const data =
            typeof innerIx.data === "string"
              ? bs58.decode(innerIx.data)
              : innerIx.data;
          const amount = parseTokenTransferAmount(data);
          if (amount === null) {
            continue;
          }
          if (parent) {
            const bankKey = parent.bank.toBase58();
            if (parent.type === "withdraw") {
              addTotal(withdrawTotals, bankKey, amount);
            } else {
              addTotal(repayTotals, bankKey, amount);
            }
          }
          if (liquidationBank) {
            addTotal(
              liquidationClassicProfitTotals,
              liquidationBank.toBase58(),
              amount,
            );
          }
        }
      }
    }

    if (instructionNames.length > 0) {
      matches.push({
        signature: sigInfo.signature,
        blockTime: sigInfo.blockTime!,
        instructionNames,
        success: !tx.meta?.err,
      });
    }

    const status = tx.meta?.err ? "failed" : "success";
    const time = new Date(sigInfo.blockTime! * 1000).toISOString();
    for (const instruction of instructionNames) {
      activityEvents.push({
        signature: sigInfo.signature,
        time,
        status,
        instruction,
      });
    }
    if (hasJupiter) {
      jupiterTxs.push({
        signature: sigInfo.signature,
        blockTime: sigInfo.blockTime!,
        success: !tx.meta?.err,
      });
      activityEvents.push({
        signature: sigInfo.signature,
        time,
        status,
        instruction: "Jupiter",
      });
    }
    if (hasTitan) {
      titanTxs.push({
        signature: sigInfo.signature,
        blockTime: sigInfo.blockTime!,
        success: !tx.meta?.err,
      });
      activityEvents.push({
        signature: sigInfo.signature,
        time,
        status,
        instruction: "Titan",
      });
    }
  }

  matches.sort((a, b) => b.blockTime - a.blockTime);

  console.log(
    paint(
      `Matched ${matches.length} liquidation txs in the last ${maxWindowLabel} (wallet signer only).`,
      "cyan",
    ),
  );
  console.log("");
  console.log(paint("Transactions:", "yellow"));
  const txRows = matches.map((match) => {
    const date = new Date(match.blockTime * 1000).toISOString();
    return [
      match.signature,
      date,
      match.success ? paint("success", "green") : paint("failed", "red"),
      match.instructionNames.join(", "),
    ];
  });
  if (txRows.length > 0) {
    printTable(["signature", "time", "status", "instructions"], txRows);
  } else {
    console.log(paint("No matching liquidation transactions.", "dim"));
  }

  const summarize = (windowLabel: keyof typeof windows) => {
    const cutoff = nowSec - windows[windowLabel];
    const inWindow = matches.filter((m) => m.blockTime >= cutoff);
    const success = inWindow.filter((m) => m.success).length;
    const failed = inWindow.length - success;
    return [
      windowLabel,
      inWindow.length.toString(),
      paint(success.toString(), "green"),
      failed ? paint(failed.toString(), "red") : failed.toString(),
    ];
  };
  const summarizeHits = (
    windowLabel: keyof typeof windows,
    label: string,
    hits: { blockTime: number; success: boolean }[],
  ) => {
    const cutoff = nowSec - windows[windowLabel];
    const inWindow = hits.filter((m) => m.blockTime >= cutoff);
    const success = inWindow.filter((m) => m.success).length;
    const failed = inWindow.length - success;
    return [
      label,
      windowLabel,
      inWindow.length.toString(),
      paint(success.toString(), "green"),
      failed ? paint(failed.toString(), "red") : failed.toString(),
    ];
  };

  console.log("");
  console.log(paint("Liquidation counts:", "yellow"));
  printTable(
    ["window", "total", "success", "failed"],
    windowOrder.map((windowLabel) => summarize(windowLabel)),
  );
  console.log("");
  console.log(paint("Jupiter/Titan (any instruction) counts:", "yellow"));
  printTable(
    ["program", "window", "total", "success", "failed"],
    [
      ...windowOrder.map((windowLabel) =>
        summarizeHits(windowLabel, "Jupiter", jupiterTxs),
      ),
      ...windowOrder.map((windowLabel) =>
        summarizeHits(windowLabel, "Titan", titanTxs),
      ),
    ],
  );

  const bankKeys = new Map<string, PublicKey>();
  for (const totals of [
    withdrawTotals,
    repayTotals,
    liquidationClassicProfitTotals,
    liquidationClassicAssetSeizedTotals,
  ]) {
    for (const bank of totals.keys()) {
      if (!bankKeys.has(bank)) {
        bankKeys.set(bank, new PublicKey(bank));
      }
    }
  }
  const bankInfoByKey = new Map<
    string,
    { mintDecimals: number; price: BigNumber }
  >();
  if (bankKeys.size > 0) {
    const bankKeyList = Array.from(bankKeys.values());
    const bankAccounts = await program.account.bank.fetchMultiple(bankKeyList);
    bankAccounts.forEach((bankAcc, idx) => {
      if (!bankAcc) {
        return;
      }
      const bankKey = bankKeyList[idx].toBase58();
      bankInfoByKey.set(bankKey, {
        mintDecimals: bankAcc.mintDecimals,
        price: wrappedI80F48toBigNumber(bankAcc.cache.lastOraclePrice),
      });
    });
  }

  const formatUsd = (bank: string, amount: bigint) => {
    const info = bankInfoByKey.get(bank);
    if (!info) {
      return "n/a";
    }
    const amountBn = new BigNumber(amount.toString());
    const dollars = amountBn
      .times(info.price)
      .div(new BigNumber(10).pow(info.mintDecimals));
    return dollars.toFixed(2);
  };

  const formatTotals = (totals: Map<string, bigint>) =>
    Array.from(totals.entries())
      .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0))
      .map(([bank, amount]) => [
        bank,
        amount.toString(),
        formatUsd(bank, amount),
      ]);
  const totalsToObject = (totals: Map<string, bigint>) =>
    Array.from(totals.entries()).reduce<Record<string, string>>(
      (acc, [bank, amount]) => {
        acc[bank] = amount.toString();
        return acc;
      },
      {},
    );

  console.log("");
  console.log(paint("Withdraw totals (token amount, raw):", "yellow"));
  printTable(["bank", "amount", "amount ($)"], formatTotals(withdrawTotals));
  console.log("");
  console.log(paint("Repay totals (token amount, raw):", "yellow"));
  printTable(["bank", "amount", "amount ($)"], formatTotals(repayTotals));
  console.log("");
  console.log(
    paint("Liquidation classic profit totals (token amount, raw):", "yellow"),
  );
  printTable(
    ["bank", "amount", "amount ($)"],
    formatTotals(liquidationClassicProfitTotals),
  );
  console.log("");
  console.log(
    paint("Liquidation classic assets seized (token amount, raw):", "yellow"),
  );
  printTable(
    ["bank", "amount", "amount ($)"],
    formatTotals(liquidationClassicAssetSeizedTotals),
  );

  if (LOG_ACTIVITY_TO_FILE) {
    const activityDir = path.join("logs", "activity");
    fs.mkdirSync(activityDir, { recursive: true });
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const activityPath = path.join(
      activityDir,
      `${config.WALLET.toBase58()}_${safeTimestamp}.json`,
    );
    const activityPayload = {
      wallet: config.WALLET.toBase58(),
      generatedAt: new Date().toISOString(),
      events: activityEvents,
      withdraw: totalsToObject(withdrawTotals),
      repay: totalsToObject(repayTotals),
      liquidationClassicProfit: totalsToObject(liquidationClassicProfitTotals),
      liquidationClassicAssetsSeized: totalsToObject(
        liquidationClassicAssetSeizedTotals,
      ),
    };
    fs.writeFileSync(activityPath, JSON.stringify(activityPayload, null, 2));
    console.log("");
    console.log(
      paint(
        `Wrote ${activityEvents.length} activity rows to ${activityPath}`,
        "cyan",
      ),
    );
  }
}

main().catch((err) => {
  console.error(err);
});
