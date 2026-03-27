import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

import {
  DEFAULT_API_URL,
  loadEnvFile,
  loadKeypairFromFile,
} from "../scripts/utils/utils";

type Bank = {
  pubkey: PublicKey;
  liquidityVault: PublicKey;
  oracleKeys: PublicKey[];
};

type ProcessConfig = {
  programId: PublicKey;
  group: PublicKey;
  existingLuts: PublicKey[]; // addresses of existing LUTs
  extraKeys?: PublicKey[];
};

// Max items that fit an ALT
const MAX_LUT_ADDRESSES = 256;
// Technically we can go up to ~30 here
const MAX_ADDRESSES_PER_EXTEND_IX = 20;

const b58 = (k: PublicKey) => k.toBase58();

function dedupePubkeys(keys: PublicKey[]): PublicKey[] {
  const seen = new Set<string>();
  const out: PublicKey[] = [];
  for (const k of keys) {
    const s = b58(k);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(k);
    }
  }
  return out;
}

function differenceByBase58(a: PublicKey[], have: Set<string>): PublicKey[] {
  const out: PublicKey[] = [];
  for (const k of a) {
    if (!have.has(b58(k))) out.push(k);
  }
  return out;
}

function allAddressesFromLuts(luts: AddressLookupTableAccount[]): PublicKey[] {
  const all: PublicKey[] = [];
  for (const lut of luts) {
    all.push(...lut.state.addresses);
  }
  return all;
}

/**
 * Fetch and decode LUT accounts for the given addresses.
 */
async function fetchLuts(
  connection: Connection,
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount[]> {
  const fetched = await Promise.all(
    addresses.map((addr) => connection.getAddressLookupTable(addr))
  );
  const luts = fetched
    .map((res) => res.value)
    .filter((v): v is AddressLookupTableAccount => !!v);

  // Sanity: ensure same order as input
  const byKey = new Map<string, AddressLookupTableAccount>();
  luts.forEach((lut) => byKey.set(b58(lut.key), lut));
  return addresses
    .map((a) => byKey.get(b58(a)))
    .filter((x): x is AddressLookupTableAccount => !!x);
}

async function fetchBanksForGroup(
  connection: Connection,
  programId: PublicKey,
  group: PublicKey
): Promise<Bank[]> {
  // TODO maybe just fetch from endpoint?
  return [];
}

async function processUpdateLookupTables(
  connection: Connection,
  payer: Keypair,
  cfg: ProcessConfig,
  opts?: {
    send?: boolean;
    log?: boolean;
  }
): Promise<void> {
  const sendTx = opts?.send ?? true;
  const shouldLog = opts?.log ?? true;

  // Load all LUTs
  const luts = await fetchLuts(connection, cfg.existingLuts);
  if (luts.length !== cfg.existingLuts.length) {
    console.warn(
      `[warn] Requested ${cfg.existingLuts.length} LUTs, decoded ${luts.length}.`
    );
  }

  // Authority sanity/warnings
  for (const lut of luts) {
    const auth = lut.state.authority;
    if (!auth) {
      console.warn(`Lookup table ${b58(lut.key)} has no authority (frozen).`);
    } else if (!auth.equals(payer.publicKey)) {
      console.warn(
        `Lookup table ${b58(lut.key)} authority mismatch. Found ${b58(
          auth
        )}; expected ${b58(
          payer.publicKey
        )}. I will still count its addresses for dedupe, but will not attempt to extend it.`
      );
    } else if (shouldLog) {
      console.info(
        `Loaded table ${b58(lut.key)} with ${
          lut.state.addresses.length
        } addresses (authority OK).`
      );
    }
  }

  // Gather program-relevant keys
  const banks = await fetchBanksForGroup(connection, cfg.programId, cfg.group);

  let keys: PublicKey[] = [
    cfg.programId, // config.mfi_program.id()
    cfg.group, // marginfi_group
    TOKEN_PROGRAM_ID, // spl_token::id()
    SystemProgram.programId, // system_program::id()
  ];

  // Add bank signers + liquidity vault PDAs + oracles
  for (const bank of banks) {
    keys.push(bank.pubkey);
    keys.push(bank.liquidityVault);
    // TODO vault authority...
    keys.push(...bank.oracleKeys);
  }

  if (cfg.extraKeys && cfg.extraKeys.length) {
    keys.push(...cfg.extraKeys);
  }

  // Dedup (equivalent to keys.dedup())
  keys = dedupePubkeys(keys.filter((k) => !!k && b58(k).length > 0));

  // Figure out which keys are missing across ALL LUTs
  const existingAcrossAllLuts = new Set<string>(
    allAddressesFromLuts(luts).map((k) => b58(k))
  );
  let missing = differenceByBase58(keys, existingAcrossAllLuts);
  if (shouldLog) {
    console.info(`Missing ${missing.length} keys across all LUTs.`);
  }
  if (missing.length === 0) {
    if (shouldLog) console.log("Everything already covered. Done.");
    return;
  }

  // For each existing LUT you control, extend until full, then move on
  const preparedTxs: Transaction[] = [];
  for (const lut of luts) {
    const authority = lut.state.authority;
    if (!authority || !authority.equals(payer.publicKey)) {
      // Not extendable by given authority (but still counted in dedupe earlier)
      continue;
    }

    let capacity = Math.max(0, MAX_LUT_ADDRESSES - lut.state.addresses.length);
    if (capacity === 0) continue;

    while (capacity > 0 && missing.length > 0) {
      const take = Math.min(
        capacity,
        missing.length,
        MAX_ADDRESSES_PER_EXTEND_IX
      );
      const chunk = missing.splice(0, take);

      const ix = AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: lut.key,
        addresses: chunk,
      });

      const tx = new Transaction().add(ix);
      preparedTxs.push(tx);

      capacity -= take;
      if (shouldLog)
        console.log(
          `Prepared extend for LUT ${b58(
            lut.key
          )} (+${take}, remaining capacity ${capacity}).`
        );
    }
    if (missing.length === 0) break;
  }

  // If still missing, create new LUTs and fill them until all keys are added
  while (missing.length > 0) {
    const recentSlot = await connection.getSlot();
    const [createIx, newLutAddr] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot,
    });

    // Put create + first extend in one transaction
    const firstTake = Math.min(
      missing.length,
      MAX_ADDRESSES_PER_EXTEND_IX,
      MAX_LUT_ADDRESSES
    );
    const firstChunk = missing.splice(0, firstTake);

    const firstExtendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: newLutAddr,
      addresses: firstChunk,
    });

    // Tx #1: create + initial extend
    preparedTxs.push(new Transaction().add(createIx, firstExtendIx));
    if (shouldLog)
      console.log(
        `Prepared create LUT ${b58(newLutAddr)} and add ${
          firstChunk.length
        } addresses.`
      );

    // Remaining capacity in this new LUT
    let capacity = MAX_LUT_ADDRESSES - firstChunk.length;
    // Add further extends to same LUT if keys remain
    while (capacity > 0 && missing.length > 0) {
      const take = Math.min(
        capacity,
        missing.length,
        MAX_ADDRESSES_PER_EXTEND_IX
      );
      const chunk = missing.splice(0, take);
      const ix = AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: newLutAddr,
        addresses: chunk,
      });
      preparedTxs.push(new Transaction().add(ix));
      capacity -= take;

      if (shouldLog)
        console.log(
          `Prepared extend for new LUT ${b58(
            newLutAddr
          )} (+${take}, remaining capacity ${capacity}).`
        );
    }
  }

  if (preparedTxs.length === 0) {
    if (shouldLog) console.log("No transactions to send. Done.");
    return;
  }

  if (sendTx) {
    for (let i = 0; i < preparedTxs.length; i++) {
      const tx = preparedTxs[i];
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = blockhash;

      const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      console.log(`[${i + 1}/${preparedTxs.length}] signature: ${sig}`);
    }
  } else {
    // Dry-run: print base58-encoded blobs for offline signing/broadcasting
    const out: string[] = [];
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    for (const tx of preparedTxs) {
      tx.feePayer = payer.publicKey;
      tx.recentBlockhash = blockhash;
      const bytes = tx.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      out.push(bs58.encode(bytes));
    }
    console.log(
      `Prepared ${out.length} unsigned transactions (base58). First 3 shown:`
    );
    out.slice(0, 3).forEach((t, i) => console.log(`#${i + 1}: ${t}`));
  }
}

async function main() {
  loadEnvFile(".env.api");
  const apiUrl = process.env.API_URL || DEFAULT_API_URL;
  const connection = new Connection(apiUrl, "confirmed");

  // Note: Must be LUT authority
  const wallet = loadKeypairFromFile(
    `${process.env.HOME}/keys/phantom-wallet.json`
  );

  const cfg: ProcessConfig = {
    programId: new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
    group: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    existingLuts: [
      // Note: (authority should be `wallet.publicKey`)
      new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
      // ...Add more here if multiple LUTs
    ],
    // Optional: seed extra keys here
    extraKeys: [
      new PublicKey("Guu5uBc8k1WK1U2ihGosNaCy57LSgCkpWAabtzQqrQf8"),
      new PublicKey("G1pNtooUWPad3zCJLGAtjD3Zu9K56PrRpmvVB6AED1Tr"),
      new PublicKey("EdB7YADw4XUt6wErT8kHGCUok4mnTpWGzPUU9rWDebzb"),
      new PublicKey("EYp4j7oHV2SfEGSE3GJ4MjsCL33CzmqLTdvTCdacQ9uG"),
      new PublicKey("E4td8i8PT2BZkMygzW4MGHCv2KPPs57dvz5W2ZXf9Twu"),
      new PublicKey("DeyH7QxWvnbbaVB4zFrf4hoq7Q8z1ZT14co42BGwGtfM"),
    ],
  };

  await processUpdateLookupTables(connection, wallet, cfg, {
    send: true, // set false to print unsigned base58 tx blobs
    log: true,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
