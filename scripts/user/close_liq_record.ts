import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { commonSetup } from "../../lib/common-setup";
import { deriveLiquidationRecord } from "../common/pdas";

const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  ACCOUNT: PublicKey;
  // Optional. If omitted, the liq record PDA is derived from ACCOUNT.
  LIQ_RECORD?: PublicKey;
  // Optional. If omitted, read from the on-chain record's `recordPayer` field.
  RECORD_PAYER?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  ACCOUNT: new PublicKey("3JgMGpqb7YXDppz5iAzuUk8mXzHCA8Da7D3A8zt3F6mz"),
};

async function main() {
  await closeLiqRecord(sendTx, config, "/.config/solana/id.json");
}

export async function closeLiqRecord(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    undefined,
  );
  const program = user.program;
  const connection = user.connection;

  const liqRecord =
    config.LIQ_RECORD ??
    deriveLiquidationRecord(program.programId, config.ACCOUNT)[0];

  // Rent always returns to the wallet that paid to create the record.
  let recordPayer = config.RECORD_PAYER;
  if (!recordPayer) {
    const record = await program.account.liquidationRecord.fetch(liqRecord);
    recordPayer = record.recordPayer;
  }

  console.log("marginfi account: " + config.ACCOUNT.toString());
  console.log("liq record:       " + liqRecord.toString());
  console.log("record payer:     " + recordPayer.toString());

  const transaction = new Transaction().add(
    await program.methods
      .marginfiAccountCloseLiqRecord()
      .accountsPartial({
        marginfiAccount: config.ACCOUNT,
        liquidationRecord: liqRecord,
        recordPayer,
      })
      .instruction()
  );

  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, [
      user.wallet.payer,
    ]);
    console.log("Transaction signature:", signature);
  } catch (error) {
    console.error("Transaction failed:", error);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
