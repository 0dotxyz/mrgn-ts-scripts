import {
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

import { commonSetup } from "../../lib/common-setup";
import { loadKeypairFromFile } from "../utils/utils";
import { assetGroups } from "../meta/asset_groups";
import {
  addLutKeysFromIx,
  ensureLutHasKeys,
  fetchGroupBanks,
  packInstructionsBySize,
} from "./configure_bank_rate_limits";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  MULTISIG: PublicKey;
  LUT: PublicKey;
  LUT_AUTHORITY_WALLET: string;
  TX_BYTE_RESERVE: number;
  MAX_IXS_PER_TRANCHE: number;
  MAX_TRANCHES: number;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  LUT: new PublicKey("2b8UjpA3bAe7f8gcXd1gA3rFe6WuGZiKRNUXsS6tghEk"),
  LUT_AUTHORITY_WALLET: "/.config/solana/id.json",
  TX_BYTE_RESERVE: 200,
  MAX_IXS_PER_TRANCHE: 15,
  MAX_TRANCHES: 12,
};

const DEFAULT_WALLET_PATH = "/keys/staging-deploy.json";

// CASH plus every Pendle PT mint. Banks in GROUP holding one of these mints get
// their hourly/daily flow caps zeroed (rate limit removed).
const TARGET_MINTS = new Set<string>([
  assetGroups.stablecoins.CASH,
  ...Object.values(assetGroups["rate-products"]),
]);

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    DEFAULT_WALLET_PATH,
    config.MULTISIG,
  );
  const { program, connection } = user;
  const adminKey = sendTx ? user.wallet.publicKey : config.MULTISIG;
  const payerKey = adminKey;

  const onChainBanks = await fetchGroupBanks(program, config.GROUP);
  const matched = onChainBanks.filter((b) =>
    TARGET_MINTS.has(b.mint.toBase58()),
  );

  const matchedMints = new Set(matched.map((b) => b.mint.toBase58()));
  const missingMints = [...TARGET_MINTS].filter((m) => !matchedMints.has(m));
  if (missingMints.length > 0) {
    console.warn(
      `\n[warn] ${missingMints.length} target mint(s) have no bank in group ${config.GROUP.toBase58()}:`,
    );
    for (const m of missingMints) console.warn(`  - ${m}`);
  }

  const ZERO = new BN(0);
  const toRemove = matched.filter(
    (b) => !b.currentHourlyCap.isZero() || !b.currentDailyCap.isZero(),
  );
  const alreadyZero = matched.length - toRemove.length;
  console.log(
    `\nMatched ${matched.length} CASH/PT bank(s) in group; ${toRemove.length} have a ` +
      `rate limit to remove${alreadyZero ? `, ${alreadyZero} already zero (skipped)` : ""}.`,
  );

  if (toRemove.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  console.table(
    toRemove.map((b) => ({
      Bank: b.address.toBase58(),
      Mint: b.mint.toBase58(),
      "Current hourly cap": b.currentHourlyCap.toString(),
      "Current daily cap": b.currentDailyCap.toString(),
    })),
  );

  const ixs: TransactionInstruction[] = [];
  const lutKeys = new Map<string, PublicKey>();
  for (const b of toRemove) {
    const ix = await program.methods
      .configureBankRateLimits(ZERO, ZERO)
      .accounts({ bank: b.address })
      .accountsPartial({ group: config.GROUP, admin: adminKey })
      .instruction();
    ixs.push(ix);
    addLutKeysFromIx(ix, lutKeys);
  }

  const lutResp = await connection.getAddressLookupTable(config.LUT);
  if (!lutResp.value) {
    throw new Error(`LUT not found on-chain: ${config.LUT.toBase58()}`);
  }
  const lutKnown = new Set(
    lutResp.value.state.addresses.map((k) => k.toBase58()),
  );
  const missing = Array.from(lutKeys.values()).filter(
    (k) => !lutKnown.has(k.toBase58()),
  );
  const lutAuthority = loadKeypairFromFile(
    process.env.HOME + config.LUT_AUTHORITY_WALLET,
  );
  const lut = await ensureLutHasKeys(
    connection,
    lutResp.value,
    lutAuthority,
    missing,
  );

  const packBudget = PACKET_DATA_SIZE - config.TX_BYTE_RESERVE;
  const sizingBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const labels = toRemove.map(
    (b) => `${b.mint.toBase58().slice(0, 4)} ${b.address.toBase58()}`,
  );

  const packed = packInstructionsBySize(
    payerKey,
    sizingBlockhash,
    lut,
    ixs,
    labels,
    packBudget,
    config.MAX_IXS_PER_TRANCHE,
  );
  if (packed.batches.length > config.MAX_TRANCHES) {
    throw new Error(
      `Packed ${packed.batches.length} tranches, exceeds MAX_TRANCHES=${config.MAX_TRANCHES}. ` +
        `Verify the LUT covers all ix accounts or raise MAX_TRANCHES.`,
    );
  }
  console.log(
    `\nPacked ${ixs.length} removal ix(s) into ${packed.batches.length} tranche(s) ` +
      `(limit ${PACKET_DATA_SIZE} bytes, reserve ${config.TX_BYTE_RESERVE}, budget ${packBudget}, ` +
      `max ${config.MAX_IXS_PER_TRANCHE} ixs/tranche).`,
  );

  let cursor = 0;
  for (let i = 0; i < packed.batches.length; i++) {
    const batch = packed.batches[i];
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const v0Tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey,
        recentBlockhash: blockhash,
        instructions: batch,
      }).compileToV0Message([lut]),
    );

    const banksInTranche = labels
      .slice(cursor, cursor + batch.length)
      .map((label, idx) => ({ idx, label }));
    cursor += batch.length;

    console.log(
      `\n=== REMOVE Tranche ${i + 1}/${packed.batches.length} (${batch.length} ix${
        batch.length === 1 ? "" : "s"
      }, ${packed.byteCounts[i]} bytes) ===`,
    );
    console.table(banksInTranche);

    if (sendTx) {
      v0Tx.sign([user.wallet.payer]);
      const sig = await connection.sendTransaction(v0Tx, { maxRetries: 2 });
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      console.log("Signature:", sig);
    } else {
      const sim = await connection.simulateTransaction(v0Tx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
      });
      if (sim.value.err) {
        console.error(
          `[sim] tranche ${i + 1}/${packed.batches.length} FAILED: ` +
            JSON.stringify(sim.value.err),
        );
        for (const l of sim.value.logs ?? []) console.error(`    ${l}`);
      } else {
        console.log(
          `[sim] tranche ${i + 1}/${packed.batches.length} OK ` +
            `(CU: ${sim.value.unitsConsumed ?? "?"})`,
        );
      }
      console.log(
        `\n---- BEGIN MULTISIG TX REMOVE ${i + 1}/${packed.batches.length} (base58) ----`,
      );
      console.log(bs58.encode(v0Tx.serialize()));
      console.log(
        `---- END MULTISIG TX REMOVE ${i + 1}/${packed.batches.length} ----\n`,
      );
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
