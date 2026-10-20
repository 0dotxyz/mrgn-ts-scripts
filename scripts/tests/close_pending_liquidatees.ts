import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, close every due account. If false, only list what is due (sends nothing).
 */
const sendTx = true;

const config = {
  PROGRAM_ID: "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
  /** The liquidatees' authority: signs the account close and gets its rent back. */
  LIQUIDATEE_WALLET_PATH: "/.config/liquidatee/id.json",
  FILE: "liquidatees_pending_closing.txt",
};

/** `close_liquidation_record` requires this much inactivity since the record's last liquidation. */
const INACTIVITY_PERIOD_SECS = 60 * 24 * 60 * 60;

/**
 * Closes the e2e liquidatees listed in liquidatees_pending_closing.txt (written by the unwind and
 * reset scripts) once they can be closed: first the liquidation record (rent back to whoever paid
 * for it), then the account itself (rent back to the liquidatee wallet), in one tx per account.
 * Closed, or already gone, accounts are removed from the file; the rest stay for a later run.
 * Inactivity is re-checked against the on-chain record rather than the dates in the file.
 */
async function main() {
  if (!existsSync(config.FILE)) {
    console.log(`${config.FILE} not found, nothing to close.`);
    return;
  }
  const user = commonSetup(true, config.PROGRAM_ID, config.LIQUIDATEE_WALLET_PATH);
  const program = user.program;
  const connection = user.connection;
  const now = Math.floor(Date.now() / 1000);

  const lines = readFileSync(config.FILE, "utf8").split("\n").filter((l) => l.trim());
  const keep: string[] = [];
  for (const line of lines) {
    const account = new PublicKey(line.split("\t")[0]);
    const info = await connection.getAccountInfo(account);
    if (!info) {
      console.log(`${account}: already closed, dropping it from the list`);
      continue;
    }
    if (!info.owner.equals(program.programId)) {
      console.log(`${account}: not an account of ${config.PROGRAM_ID}, keeping it`);
      keep.push(line);
      continue;
    }

    const acc: any = await program.account.marginfiAccount.fetch(account);
    if (!acc.authority.equals(user.wallet.publicKey)) {
      console.log(`${account}: authority ${acc.authority} is not this wallet, keeping it`);
      keep.push(line);
      continue;
    }

    const transaction = new Transaction();
    if (!acc.liquidationRecord.equals(PublicKey.default)) {
      const record: any = await program.account.liquidationRecord.fetch(acc.liquidationRecord);
      const last = Math.max(...record.entries.map((e: any) => Number(e.timestamp)));
      if (last > 0 && now - last < INACTIVITY_PERIOD_SECS) {
        const due = new Date((last + INACTIVITY_PERIOD_SECS) * 1000).toISOString();
        console.log(`${account}: liquidation record active until ${due}, keeping it`);
        keep.push(line);
        continue;
      }
      transaction.add(
        await program.methods
          .marginfiAccountCloseLiqRecord()
          .accountsPartial({
            marginfiAccount: account,
            liquidationRecord: acc.liquidationRecord,
            recordPayer: record.recordPayer,
          })
          .instruction(),
      );
    }
    transaction.add(
      await program.methods
        .marginfiAccountClose()
        .accounts({ marginfiAccount: account })
        .instruction(),
    );

    if (!sendTx) {
      console.log(`${account}: due, would close (${transaction.instructions.length} ix)`);
      keep.push(line);
      continue;
    }
    try {
      const signature = await sendAndConfirmTransaction(connection, transaction, [
        user.wallet.payer,
      ]);
      console.log(`${account}: closed (${signature})`);
    } catch (error) {
      console.error(`${account}: close failed, keeping it:`, error);
      keep.push(line);
    }
  }

  if (!sendTx) return; // a listing run leaves the file as it is
  writeFileSync(config.FILE, keep.map((l) => l + "\n").join(""));
  console.log(`${lines.length - keep.length} closed or gone, ${keep.length} left in ${config.FILE}`);
}

main().catch((err) => {
  console.error(err);
});
