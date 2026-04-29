import fs from "fs";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { commonSetup } from "../../lib/common-setup";
import { configs } from "../../lib/config";
import { Environment } from "../../lib/types";
import { loadEnvFile } from "../utils/utils";
import { buildMintToGroupMap } from "./asset_groups";

/**
 * --config JSON shape (see data/prime-config.json for a live example):
 *   [
 *     {
 *       "bankAddress":     "<BANK_PK>",         // required
 *       "group":           "<GROUP_PK>",        // optional, resolved from bank on-chain
 *       "tokenAddress":    "<MINT_PK>",         // optional, resolved from bank on-chain
 *       "tokenSymbol":     "USDC",              // required unless ticker+description given
 *       "tokenName":       "USD Coin",          // required unless ticker+description given
 *       "venue":           "Kamino",            // optional, defaults to "P0"
 *       "venueIdentifier": "USDC - Kamino Prime Market", // optional, becomes market suffix
 *       "riskTierName":    "Collateral"         // optional, forces assetGroup="W/E" if "Isolated"
 *     },
 *     ...
 *   ]
 * Accepts a single object too. snake_case aliases also accepted. If both
 * `ticker` and `description` are present, they override all derivation.
 */

const MINT_TO_GROUP = buildMintToGroupMap();

type ConfigEntryRaw = {
  bank?: string;
  bankAddress?: string;
  bank_address?: string;
  group?: string;
  mint?: string;
  tokenAddress?: string;
  token_address?: string;
  symbol?: string;
  tokenSymbol?: string;
  token_symbol?: string;
  name?: string;
  tokenName?: string;
  token_name?: string;
  assetGroup?: string;
  asset_group?: string;
  venue?: string;
  venueIdentifier?: string;
  venue_identifier?: string;
  riskTierName?: string;
  risk_tier_name?: string;
  ticker?: string;
  description?: string;
};

type BankMetadataInput = {
  bank: PublicKey;
  group?: PublicKey;
  mint?: PublicKey;
  ticker?: string;
  description?: string;
  symbol?: string;
  name?: string;
  assetGroup?: string;
  venue?: string;
  venueIdentifier?: string;
  riskTierName?: string;
};

type BankMetadataEntry = {
  bank: PublicKey;
  group: PublicKey;
  mint: PublicKey;
  ticker: string;
  description: string;
};

const CONFIG_EXAMPLE = `[
  {
    "bankAddress": "<BANK_PUBKEY>",
    "group": "<GROUP_PUBKEY>",
    "tokenAddress": "<MINT_PUBKEY>",
    "tokenSymbol": "USDC",
    "tokenName": "USD Coin",
    "venue": "<VENUE e.g. Kamino, P0>",
    "venueIdentifier": "<e.g. USDC - Kamino Prime Market>",
    "riskTierName": "<Collateral | Isolated>"
  }
]
`;

function getAssetGroup(mint: string, riskTierName?: string): string {
  if (riskTierName?.toLowerCase() === "isolated") return "W/E";
  return MINT_TO_GROUP[mint] || "W/E";
}


function buildMarketSuffix(venue: string, venueIdentifier?: string): string {
  const afterDash = venueIdentifier?.split(" - ")[1];
  if (!afterDash) return " | -";
  if (afterDash === venue) return " | -";
  const marketType = afterDash.startsWith(venue)
    ? afterDash.slice(venue.length).trim()
    : afterDash.trim();
  return marketType ? ` | ${marketType}` : " | -";
}

function parseConfigEntry(raw: ConfigEntryRaw): BankMetadataInput {
  const bank =
    raw.bank ?? raw.bankAddress ?? raw.bank_address;
  if (!bank) throw new Error("config entry missing bank/bankAddress");
  const mint =
    raw.mint ?? raw.tokenAddress ?? raw.token_address;
  return {
    bank: new PublicKey(bank),
    group: raw.group ? new PublicKey(raw.group) : undefined,
    mint: mint ? new PublicKey(mint) : undefined,
    ticker: raw.ticker,
    description: raw.description,
    symbol: raw.symbol ?? raw.tokenSymbol ?? raw.token_symbol,
    name: raw.name ?? raw.tokenName ?? raw.token_name,
    assetGroup: raw.assetGroup ?? raw.asset_group,
    venue: raw.venue,
    venueIdentifier: raw.venueIdentifier ?? raw.venue_identifier,
    riskTierName: raw.riskTierName ?? raw.risk_tier_name,
  };
}

function loadConfigFile(path: string): BankMetadataInput[] {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  const rows: ConfigEntryRaw[] = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(parseConfigEntry);
}

function deriveBankMetadataPda(
  programId: PublicKey,
  bank: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata", "utf-8"), bank.toBuffer()],
    programId,
  )[0];
}

function decodeMetadataAccount(acc: {
  ticker: number[] | Uint8Array;
  description: number[] | Uint8Array;
  endTickerByte: number;
  endDescriptionByte: number;
}): { ticker: string; description: string } {
  const toStr = (bytes: number[] | Uint8Array, end: number) => {
    if (!bytes.length || bytes[0] === 0) return "";
    const buf = Buffer.from(bytes);
    const len = Math.min(end + 1, buf.length);
    return buf.subarray(0, len).toString("utf-8");
  };
  return {
    ticker: toStr(acc.ticker, acc.endTickerByte),
    description: toStr(acc.description, acc.endDescriptionByte),
  };
}

async function resolveInput(
  program: ReturnType<typeof commonSetup>["program"],
  input: BankMetadataInput,
): Promise<BankMetadataEntry> {
  let { group, mint } = input;

  if (!group || !mint) {
    const bank = await program.account.bank.fetchNullable(input.bank);
    if (!bank) {
      if (!group || !mint) {
        throw new Error(
          `bank ${input.bank.toBase58()} is not initialized on-chain; --group and --mint are required`,
        );
      }
    } else {
      group = group ?? bank.group;
      mint = mint ?? bank.mint;
    }
  }

  if (input.ticker && input.description) {
    return {
      bank: input.bank,
      group: group!,
      mint: mint!,
      ticker: input.ticker,
      description: input.description,
    };
  }

  const symbol = input.symbol;
  const name = input.name;
  if (!symbol || !name) {
    throw new Error(
      `bank ${input.bank.toBase58()}: --symbol and --name are required when --ticker/--description are omitted`,
    );
  }

  const assetGroup =
    input.assetGroup ?? getAssetGroup(mint!.toBase58(), input.riskTierName);
  const venue = input.venue ?? "P0";
  const suffix = buildMarketSuffix(venue, input.venueIdentifier);

  return {
    bank: input.bank,
    group: group!,
    mint: mint!,
    ticker: input.ticker ?? `${symbol} | ${name}`,
    description:
      input.description ??
      `${name} | ${assetGroup} | ${symbol} | ${venue}${suffix}`,
  };
}

type ApplyStatus = "UpToDate" | "Updated" | "CreatedAndUpdated" | "Prepared";

async function applyEntry(
  user: ReturnType<typeof commonSetup>,
  entry: BankMetadataEntry,
  sendTx: boolean,
  multisigPayer: PublicKey | undefined,
): Promise<{ status: ApplyStatus; sig?: string; b58?: string }> {
  const { program, connection } = user;
  const programId = program.programId;
  const metadataPda = deriveBankMetadataPda(programId, entry.bank);

  const current = (await program.account.bankMetadata.fetchNullable(
    metadataPda,
  )) as
    | {
        ticker: number[];
        description: number[];
        endTickerByte: number;
        endDescriptionByte: number;
      }
    | null;
  const decoded = current ? decodeMetadataAccount(current) : null;

  if (
    decoded &&
    decoded.ticker === entry.ticker &&
    decoded.description === entry.description
  ) {
    return { status: "UpToDate" };
  }

  const payerKey = sendTx
    ? user.wallet.publicKey
    : (multisigPayer ??
      (() => {
        throw new Error(
          "--multisig must be set when not sending locally (sendTx=false)",
        );
      })());

  const ixs: TransactionInstruction[] = [];
  const needsInit = current === null;
  if (needsInit) {
    ixs.push(
      await program.methods
        .initBankMetadata()
        .accounts({ bank: entry.bank, feePayer: payerKey })
        .instruction(),
    );
  }
  ixs.push(
    await program.methods
      .writeBankMetadata(
        Buffer.from(entry.ticker, "utf-8"),
        Buffer.from(entry.description, "utf-8"),
      )
      .accountsPartial({
        group: entry.group,
        bank: entry.bank,
        metadataAdmin: payerKey,
        metadata: metadataPda,
      })
      .instruction(),
  );

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash();

  if (sendTx) {
    const msg = new TransactionMessage({
      payerKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([user.wallet.payer]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 2 });
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      "confirmed",
    );
    return {
      status: needsInit ? "CreatedAndUpdated" : "Updated",
      sig,
    };
  }

  const msg = new TransactionMessage({
    payerKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return { status: "Prepared", b58: bs58.encode(tx.serialize()) };
}

async function main() {
  loadEnvFile(".env.api");

  const argv = yargs(hideBin(process.argv))
    .option("env", {
      type: "string",
      choices: ["production", "staging"] as Environment[],
      default: "production",
      description: "Marginfi environment",
    })
    .option("wallet", {
      type: "string",
      description: "Wallet keypair path (defaults to MARGINFI_WALLET)",
    })
    .option("bank", { type: "string", description: "Bank pubkey" })
    .option("config", {
      type: "string",
      description: "Path to JSON config file (array or single object)",
    })
    .option("config-example", {
      type: "boolean",
      default: false,
      description: "Print an example JSON config and exit",
    })
    .option("group", { type: "string" })
    .option("mint", { type: "string" })
    .option("ticker", { type: "string" })
    .option("description", { type: "string" })
    .option("symbol", { type: "string" })
    .option("name", { type: "string" })
    .option("asset-group", { type: "string" })
    .option("venue", { type: "string" })
    .option("venue-identifier", { type: "string" })
    .option("risk-tier-name", { type: "string" })
    .option("send", {
      type: "boolean",
      default: true,
      description:
        "true: sign+send with local wallet. false: emit unsigned b58 tx per bank for multisig.",
    })
    .option("multisig", {
      type: "string",
      description: "Multisig payer pubkey (required when --send false)",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      description: "Resolve and print target entries without sending",
    })
    .option("delay", {
      type: "number",
      default: 1000,
      description: "Delay in ms between banks",
    })
    .parseSync();

  if (argv["config-example"]) {
    console.log(CONFIG_EXAMPLE);
    return;
  }

  const env = argv.env as Environment;
  const envConfig = configs[env];

  const inputs: BankMetadataInput[] = argv.config
    ? loadConfigFile(argv.config)
    : [
        {
          bank: new PublicKey(
            argv.bank ??
              (() => {
                throw new Error("pass either --bank or --config");
              })(),
          ),
          group: argv.group ? new PublicKey(argv.group) : undefined,
          mint: argv.mint ? new PublicKey(argv.mint) : undefined,
          ticker: argv.ticker,
          description: argv.description,
          symbol: argv.symbol,
          name: argv.name,
          assetGroup: argv["asset-group"],
          venue: argv.venue,
          venueIdentifier: argv["venue-identifier"],
          riskTierName: argv["risk-tier-name"],
        },
      ];

  const multisigPayer = argv.multisig
    ? new PublicKey(argv.multisig)
    : undefined;
  const walletPath = argv.wallet ?? process.env.MARGINFI_WALLET;

  const user = commonSetup(
    argv.send,
    envConfig.PROGRAM_ID,
    walletPath,
    multisigPayer,
  );
  const { program } = user;

  const entries: BankMetadataEntry[] = [];
  for (const input of inputs) {
    entries.push(await resolveInput(program, input));
  }

  console.log(`Environment: ${env}`);
  console.log(`Program:     ${envConfig.PROGRAM_ID}`);
  console.log(`Signer:      ${user.wallet.publicKey.toBase58()}`);
  console.log(`Entries:     ${entries.length}\n`);
  for (const [i, e] of entries.entries()) {
    console.log(`[${i + 1}] ${e.bank.toBase58()}`);
    console.log(`    ticker:      ${e.ticker}`);
    console.log(`    description: ${e.description}`);
  }

  if (argv["dry-run"]) {
    console.log("\nDry run - nothing written.");
    return;
  }

  let upToDate = 0;
  let written = 0;
  let initAndWritten = 0;
  let prepared = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    console.log(`\n[${i + 1}/${entries.length}] ${entry.bank.toBase58()}`);
    const result = await applyEntry(user, entry, argv.send, multisigPayer);
    switch (result.status) {
      case "UpToDate":
        console.log("  ✓ already up to date");
        upToDate++;
        break;
      case "Updated":
        console.log(`  write → ${result.sig}`);
        written++;
        break;
      case "CreatedAndUpdated":
        console.log(`  init+write → ${result.sig}`);
        initAndWritten++;
        break;
      case "Prepared":
        console.log(`  b58 tx (multisig): ${result.b58}`);
        prepared++;
        break;
    }

    if (i < entries.length - 1 && argv.delay > 0) {
      await new Promise((r) => setTimeout(r, argv.delay));
    }
  }

  console.log(
    `\nDone. up-to-date=${upToDate}  written=${written}  init+written=${initAndWritten}  prepared=${prepared}`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
