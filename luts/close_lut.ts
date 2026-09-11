import {
  AddressLookupTableProgram,
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  DEFAULT_API_URL,
  loadEnvFile,
  loadKeypairFromFile,
} from "../scripts/utils/utils";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

/**
 * Closes a LUT and returns its rent. Two steps with a cooldown in between:
 * deactivate, wait ~512 slots (~3.5 min) for the deactivation slot to fall out of the
 * SlotHashes sysvar, then close. This script does all three, resuming wherever the table
 * already is, so it is safe to re-run.
 *
 * If true, send the txs. If false, output the unsigned b58 tx for the current step.
 */
const sendTx = true;

/** Slots the table stays in `Deactivating` (SlotHashes MAX_ENTRIES), plus one for safety. */
const COOLDOWN_SLOTS = 513;
const POLL_MS = 15_000;
const U64_MAX = BigInt("0xffffffffffffffff");

type Config = {
  LUT: PublicKey;
  /** Rent destination. Defaults to the wallet (which is also the LUT authority). */
  RECIPIENT?: PublicKey;
};

const config: Config = {
  LUT: new PublicKey("DdejzsoJypNyb3Q1iMAwxiyHHtjNuvb9tZvz5nfaUA7R"),
};

async function main() {
  await closeLut(sendTx, config, "/.config/deleverager/id.json");
}

export async function closeLut(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
  loadEnvFile(".env.api");
  const apiUrl = process.env.API_URL || DEFAULT_API_URL;
  console.log("api: " + apiUrl);
  const connection = new Connection(apiUrl, "confirmed");
  const wallet = loadKeypairFromFile(process.env.HOME + walletPath);
  const recipient = config.RECIPIENT ?? wallet.publicKey;

  const send = async (tx: Transaction, label: string) => {
    if (!sendTx) {
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const serialized = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      console.log(`${label} (base58):`, bs58.encode(serialized));
      return false;
    }
    const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);
    console.log(`${label}:`, signature);
    return true;
  };

  const info = await connection.getAccountInfo(config.LUT);
  if (!info) {
    console.log(`LUT ${config.LUT.toBase58()} does not exist, nothing to do`);
    return;
  }
  const table = (await connection.getAddressLookupTable(config.LUT)).value;
  const authority = table.state.authority;

  console.log(`LUT:       ${config.LUT.toBase58()}`);
  console.log(`authority: ${authority?.toBase58() ?? "NONE (frozen)"}`);
  console.log(`addresses: ${table.state.addresses.length}`);
  console.log(`rent:      ${info.lamports / 1e9} SOL -> ${recipient.toBase58()}`);

  // Both ixes require the authority to sign, and a frozen table can never be closed.
  if (!authority) {
    throw new Error("LUT has no authority (frozen), it can never be closed");
  }
  if (!authority.equals(wallet.publicKey)) {
    throw new Error(
      `wallet ${wallet.publicKey.toBase58()} is not the LUT authority ${authority.toBase58()}`,
    );
  }

  if (table.state.deactivationSlot === U64_MAX) {
    console.log("\nDeactivating...");
    const sent = await send(
      new Transaction().add(
        AddressLookupTableProgram.deactivateLookupTable({
          lookupTable: config.LUT,
          authority: wallet.publicKey,
        }),
      ),
      "deactivate",
    );
    if (!sent) return; // unsigned mode: re-run after the deactivate lands to get the close tx
  }

  // Re-read: in the branch above the deactivation slot was just set.
  const deactivationSlot = Number(
    (await connection.getAddressLookupTable(config.LUT)).value.state
      .deactivationSlot,
  );

  for (;;) {
    const elapsed = (await connection.getSlot()) - deactivationSlot;
    if (elapsed > COOLDOWN_SLOTS) break;
    const left = COOLDOWN_SLOTS - elapsed;
    console.log(`Cooldown: ${left} slots left (~${Math.ceil(left * 0.4)}s)`);
    if (!sendTx) return; // unsigned mode: re-run once the cooldown has passed
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  console.log("\nClosing...");
  await send(
    new Transaction().add(
      AddressLookupTableProgram.closeLookupTable({
        lookupTable: config.LUT,
        authority: wallet.publicKey,
        recipient,
      }),
    ),
    "close",
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
