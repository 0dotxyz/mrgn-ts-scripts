import { EventParser, BorshCoder } from "@coral-xyz/anchor";
import { base64 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  TX_SIG: string;
  EVENT_EXPECTED_SIZE: number;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  TX_SIG:
    "2RccxeFZzG3MyVZWJ4vua3XhH3cnhtHgrxcJ7tbkvg8WzPcMv2mSHW758iYv93smSttFqL7ZCtuRCK4NULdJqVST",
  // The Liquidate event is 408 bytes, plus something (probably the Option) adds one byte.
  EVENT_EXPECTED_SIZE: 409,
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/keys/staging-deploy.json",
    undefined,
  );
  const program = user.program;
  const connection = user.connection;

  const tx = await connection.getTransaction(config.TX_SIG, {
    maxSupportedTransactionVersion: 0,
  });
  const coder = new BorshCoder(program.idl);
  const parser = new EventParser(program.programId, coder);

  const logs = tx.meta?.logMessages || [];
  const decodedEvents = [];

  // const key = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
  // console.log("KEY ACTUAL:");
  // const keyBytes = key.toBuffer();
  // const keyHexStr = Array.from(keyBytes)
  //   .map((b) => b.toString(16).padStart(2, "0"))
  //   .join(" ");
  // console.log(" ", keyHexStr);
  // console.log("END KEY ACTUAL");

  for (const logLine of logs) {
    //console.log("line: " + logLine);
    let decoded = base64.decode(logLine.substring("Program data: ".length));
    // console.log("decoded bytes: " + decoded.length);
    if (decoded.length == config.EVENT_EXPECTED_SIZE) {
      console.log("decoded bytes (chunked hex):");
      const bytesPerLine = 16;
      for (let i = 0; i < decoded.length; i += bytesPerLine) {
        const chunk = decoded.subarray(i, i + bytesPerLine);
        const hexLine = Array.from(chunk)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        console.log(
          `[${i.toString().padStart(4, "0")}..${(i + chunk.length - 1)
            .toString()
            .padStart(4, "0")}]  ${hexLine}`,
        );
      }

      // if you want, you can just read the raw bytes here into a float or whatever...
    }
    try {
      // pass one event at a time because parseLogs throws on decode errors...
      const events = parser.parseLogs([logLine], false);
      decodedEvents.push(...events);
    } catch (err) {
      // If a log line fails just print and ignore it, we likely just don't have the decoder...
      // console.warn(`Could not decode event from log:\n  ${logLine}\n`);
      // console.warn(`Error:`, err);
    }
  }

  console.log("Decoded events:");
  for (const event of parser.parseLogs(logs)) {
    console.log(event);
  }

  const decoded = Array.from(parser.parseLogs(logs, false));
  const liquidateEvent = decoded.find(
    (evt) => evt.name === "lendingAccountLiquidateEvent",
  );
  if (!liquidateEvent) {
    throw new Error("No lendingAccountLiquidateEvent found in logs");
  }
  const { preBalances, postBalances } = liquidateEvent.data;
  const balances = {
    pre: {
      liquidateeAsset: preBalances.liquidateeAssetBalance,
      liquidateeLiability: preBalances.liquidateeLiabilityBalance,
      liquidatorAsset: preBalances.liquidatorAssetBalance,
      liquidatorLiability: preBalances.liquidatorLiabilityBalance,
    },
    post: {
      liquidateeAsset: postBalances.liquidateeAssetBalance,
      liquidateeLiability: postBalances.liquidateeLiabilityBalance,
      liquidatorAsset: postBalances.liquidatorAssetBalance,
      liquidatorLiability: postBalances.liquidatorLiabilityBalance,
    },
  };
  console.log("Balances object:", balances);

  // Asset amount seized
  const assetSeizedActual =
    balances.pre.liquidateeAsset - balances.post.liquidateeAsset;
  const assetSeizedAlt =
    balances.post.liquidatorAsset - balances.pre.liquidatorAsset;

  // Liability amounts
  const liabilityRepaidToLiquidatee =
    balances.pre.liquidateeLiability - balances.post.liquidateeLiability;
  const liabilityPaidByLiquidator =
    balances.post.liquidatorLiability - balances.pre.liquidatorLiability;

  // Insurance‐fund fee paid
  const insuranceFundPaid =
    liabilityPaidByLiquidator - liabilityRepaidToLiquidatee;

  console.log(`Asset amount seized (actual): ${assetSeizedActual}`);
  console.log(`Asset amount seized (alt calc): ${assetSeizedAlt}`);

  console.log(`Liability repaid to liquidatee: ${liabilityRepaidToLiquidatee}`);
  console.log(`Liability paid by liquidator: ${liabilityPaidByLiquidator}`);

  console.log(`Insurance fund amount paid: ${insuranceFundPaid}`);
  console.log("");

  // Note these must be adjusted by the bank's decimals to get back into token...
  const assetBankPubkey = liquidateEvent.data.assetBank;
  let assetBank = await program.account.bank.fetch(assetBankPubkey);
  let assetDecimals = assetBank.mintDecimals;
  const liabBankPubkey = liquidateEvent.data.liabilityBank;
  let liabBank = await program.account.bank.fetch(liabBankPubkey);
  let liabDecimals = liabBank.mintDecimals;

  console.log("In native token....");
  console.log(
    `Asset amount seized (actual): ${assetSeizedActual / 10 ** assetDecimals}`,
  );
  console.log(
    `Asset amount seized (alt calc): ${assetSeizedAlt / 10 ** assetDecimals}`,
  );

  console.log(
    `Liability repaid to liquidatee: ${
      liabilityRepaidToLiquidatee / 10 ** liabDecimals
    }`,
  );
  console.log(
    `Liability paid by liquidator: ${
      liabilityPaidByLiquidator / 10 ** liabDecimals
    }`,
  );

  console.log(
    `Insurance fund amount paid: ${insuranceFundPaid / 10 ** liabDecimals}`,
  );
}

main().catch((err) => {
  console.error(err);
});

/*
example at:
2RccxeFZzG3MyVZWJ4vua3XhH3cnhtHgrxcJ7tbkvg8WzPcMv2mSHW758iYv93smSttFqL7ZCtuRCK4NULdJqVST

Asset mint (PyUSD) decimals: 6
Liab mint (JitoSOL) decimals: 9

Asset seized: 
2835534973.577767 - 2882525365.577767 =    46,990,392     = 46.990392 PyUSD

Liability repaid (to liquidatee)
23266748103.847755 - 23025256901.151913 = 241491202.696 =    0.24149120269 JitoSOL

Liability repaid (actual, by liquidator) 
247846234.34573492 - 0 = 247846234.34573492 =                0.24784623434 JitoSOL

insurance fund fee paid
61077177072.15771 - 59511095608.8 = 1,566,081,463.36 =       0.00635503165 JitoSOL

*/
