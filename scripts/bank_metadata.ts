import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../lib/common-setup";
import { configs } from "../lib/config";
import { Environment } from "../lib/types";
import { loadEnvFile } from "./utils";
import yargs from "yargs";
import { buildMintToGroupMap } from "./asset_groups";
import { hideBin } from "yargs/helpers";

const sendTx = true;

 type BankMetadataEntry = {
  bank: PublicKey;
  ticker: string;
  description: string;
};

 type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;

  /**
   * Exclude if not using MS
   */
  MULTISIG_PAYER?: PublicKey;

  /**
   * Array of banks and their corresponding metadata.
   */
  BANKS: BankMetadataEntry[];
};

// Staging metadata format
type StagingBankMetadata = {
  bankAddress: string;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
};

// Mainnet metadata format
type MainnetBankMetadata = {
  bank_address: string;
  mint: string;
  symbol: string;
  name: string;
  venue?: string;
  venue_identifier?: string;
  asset_tag?: number;
  risk_tier_name?: string;
};

// Banks not yet in the metadata cache (manually added)
const ADDITIONAL_STAGING_BANKS: BankMetadataEntry[] = [
  {
    bank: new PublicKey("GFMZQWGdfvcXQd6PM3ZTtMjYhEFh9gBEogfKsZKBsKjs"),
    ticker: "ptBulkSOL | PT-bulkSOL-26FEB26",
    description: "Exponent Principal Token for BulkSOL | PT | ptBulkSOL | P0",
  },
];

/**
 * Fetches bank metadata from the appropriate source based on environment.
 */
async function fetchBankMetadata(env: Environment): Promise<BankMetadataEntry[]> {
  let url: string;

  if (env === "staging") {
    url = "https://storage.googleapis.com/mrgn-public/mrgn-bank-metadata-cache-stage.json";
  } else {
    url = "https://app.0.xyz/api/banks/db";
  }

  console.log(`Fetching bank metadata from: ${url}`);
  const response = await fetch(url);
  const data = await response.json();

  if (env === "staging") {
    // Parse staging format
    const stagingData = data as StagingBankMetadata[];
    const banks = stagingData.map((item) => {
      const assetGroup = getAssetGroup(item.tokenAddress);
      return {
        bank: new PublicKey(item.bankAddress),
        // ticker = "symbol | name"
        ticker: `${item.tokenSymbol} | ${item.tokenName}`,
        // description = "description | asset_group | venue_identifier"
        description: `${item.tokenName} | ${assetGroup} | ${item.tokenSymbol} | P0`,
      };
    });
    // Add banks not yet in metadata cache
    return [...ADDITIONAL_STAGING_BANKS, ...banks,];
  } else {
    // Parse mainnet format
    const mainnetData = data as MainnetBankMetadata[];
    return mainnetData.map((item) => {
      const assetGroup = getAssetGroup(item.mint, item.risk_tier_name);
      const venue = item.venue || "P0";
      let marketType: string | undefined;
      if (item.venue_identifier) {
        const afterDash = item.venue_identifier.split(" - ")[1];
        if (afterDash && afterDash !== venue) {
          marketType = afterDash.startsWith(venue) ? afterDash.slice(venue.length).trim() : afterDash;
        }
      }
      const marketSuffix = marketType ? ` | ${marketType}` : " | -";
      return {
        bank: new PublicKey(item.bank_address),
        // ticker = "symbol | name"
        ticker: `${item.symbol} | ${item.name}`,
        // description = "name | asset_group | symbol | venue | market_type"
        description: `${item.name} | ${assetGroup} | ${item.symbol} | ${venue}${marketSuffix}`,
      };
    });
  }
}

const MINT_TO_GROUP = buildMintToGroupMap();

/**
 * Determines asset group based on mint address, with "W/E" override for isolated risk tier.
 */
function getAssetGroup(mint: string, riskTierName?: string): string {
  if (riskTierName?.toLowerCase() === "isolated") {
    return "W/E";
  }
  return MINT_TO_GROUP[mint] || "W/E";
}

/**
 * Derives the metadata PDA for a given bank.
 * Seeds: ["metadata", bank_pubkey]
 */
function deriveBankMetadataPda(
  programId: PublicKey,
  bank: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata", "utf-8"), bank.toBuffer()],
    programId,
  );
}

async function main() {
  loadEnvFile(".env");

  const argv = yargs(hideBin(process.argv))
    .option("env", {
      type: "string",
      choices: ["production", "staging"] as Environment[],
      default: "staging",
      description: "Marginfi environment",
    })
    .option("limit", {
      type: "number",
      default: 200,
      description: "Number of banks to process (for testing)",
    })
    .option("wallet", {
      type: "string",
      description: "Path to wallet keypair (defaults to MARGINFI_WALLET from .env)",
    })
    .option("dry-run", {
      type: "boolean",
      default: false,
      description: "Print config without executing transactions",
    })
    .option("delay", {
      type: "number",
      default: 2000,
      description: "Delay in ms between transactions (to avoid rate limiting)",
    })
    .option("fresh-only", {
      type: "boolean",
      default: false,
      description: "Only process banks that do not have an existing metadata account",
    })
    .parseSync();

  const env = argv.env as Environment;
  const limit = argv.limit;
  const walletPath = process.env.MARGINFI_WALLET;
  const dryRun = argv["dry-run"];
  const delay = argv.delay;
  const freshOnly = argv["fresh-only"];

  console.log(`\nEnvironment: ${env}`);
  console.log(`Limit: ${limit} banks`);
  console.log(`Wallet: ${walletPath}`);
  console.log(`Delay: ${delay}ms`);
  console.log(`Dry run: ${dryRun}`);
  console.log(`Fresh only: ${freshOnly}\n`);

  const allBanks = await fetchBankMetadata(env);
  console.log(`Fetched ${allBanks.length} banks from metadata API\n`);

  let banks: BankMetadataEntry[];

  if (freshOnly) {
    const envConfig = configs[env];
    const programId = new PublicKey(envConfig.PROGRAM_ID);
    const { connection } = commonSetup(
      false,
      envConfig.PROGRAM_ID,
      walletPath,
    );

    console.log("Filtering for banks without metadata accounts...");
    const freshBanks: BankMetadataEntry[] = [];

    for (const bank of allBanks) {
      const [metadataPda] = deriveBankMetadataPda(programId, bank.bank);
      const accountInfo = await connection.getAccountInfo(metadataPda);
      if (accountInfo === null) {
        freshBanks.push(bank);
      }
    }

    console.log(`Found ${freshBanks.length} banks without metadata accounts\n`);
    banks = freshBanks.slice(0, limit);
  } else {
    // Limit banks for testing
    banks = allBanks.slice(0, limit);
  }

  const envConfig = configs[env];
  const config: Config = {
    PROGRAM_ID: envConfig.PROGRAM_ID,
    GROUP: new PublicKey(envConfig.GROUP_ADDRESS),
    BANKS: banks,
  };

  console.log("Banks to process:");
  console.log("─".repeat(80));
  banks.forEach((bank, i) => {
    console.log(`[${i + 1}] ${bank.bank.toBase58()}`);
    console.log(`    Ticker: ${bank.ticker}`);
    console.log(`    Description: ${bank.description}`);
  });
  console.log("─".repeat(80));

  if (dryRun) {
    console.log("\nDry run - no transactions will be sent.");
    return;
  }

  await writeBankMetadata(sendTx, config, walletPath, delay);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function writeBankMetadata(
  sendTx: boolean,
  config: Config,
  walletPath: string,
  delay: number = 2000,
) {
  if (config.BANKS.length === 0) {
    throw new Error("Config.BANKS is empty - nothing to do.");
  }

  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG_PAYER,
  );
  const program = user.program;
  const connection = user.connection;
  const programId = new PublicKey(config.PROGRAM_ID);

  console.log(`\nProcessing ${config.BANKS.length} banks...`);
  console.log(`Group: ${config.GROUP.toBase58()}`);
  console.log(`Wallet: ${user.wallet.publicKey.toBase58()}`);
  console.log("");

  for (let i = 0; i < config.BANKS.length; i++) {
    const entry = config.BANKS[i];
    console.log(
      `\n[${i + 1}/${config.BANKS.length}] Bank: ${entry.bank.toBase58()}`,
    );
    console.log(`  Ticker: ${entry.ticker}`);
    console.log(`  Description: ${entry.description}`);

    const payerKey = sendTx
      ? user.wallet.publicKey
      : (config.MULTISIG_PAYER ??
        (() => {
          throw new Error("MULTISIG_PAYER must be set when sendTx = false");
        })());

    const [metadataPda] = deriveBankMetadataPda(programId, entry.bank);
    console.log(`  Metadata PDA: ${metadataPda.toBase58()}`);

    // Check if metadata account exists
    const metadataAccountInfo = await connection.getAccountInfo(metadataPda);
    const needsInit = metadataAccountInfo === null;

    if (needsInit) {
      console.log("  Metadata account does not exist. Initializing...");

      const initIx = await program.methods
        .initBankMetadata()
        .accounts({
          bank: entry.bank,
          feePayer: payerKey,
        })
        .instruction();

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash();

      if (sendTx) {
        const v0Message = new TransactionMessage({
          payerKey,
          recentBlockhash: blockhash,
          instructions: [initIx],
        }).compileToV0Message();
        const v0Tx = new VersionedTransaction(v0Message);

        v0Tx.sign([user.wallet.payer]);
        const signature = await connection.sendTransaction(v0Tx, {
          maxRetries: 2,
        });
        await connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        );
        console.log(`  initBankMetadata tx: ${signature}`);
        console.log(`  https://solscan.io/tx/${signature}`);
      } else {
        let transaction = new Transaction().add(initIx);
        transaction.feePayer = config.MULTISIG_PAYER;
        transaction.recentBlockhash = blockhash;
        const serializedTransaction = transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        });
        const base58Transaction = bs58.encode(serializedTransaction);
        console.log("  initBankMetadata Base58 tx:", base58Transaction);
      }
    } else {
      console.log("  Metadata account already exists. Skipping init.");
    }

    // Now write the metadata
    console.log("  Writing metadata...");

    const tickerBytes = Buffer.from(entry.ticker, "utf-8");
    const descriptionBytes = Buffer.from(entry.description, "utf-8");

    const writeIx = await program.methods
      .writeBankMetadata(tickerBytes, descriptionBytes)
      .accountsPartial({
        group: config.GROUP,
        bank: entry.bank,
        metadataAdmin: payerKey,
        metadata: metadataPda,
      })
      .instruction();

    const {
      blockhash: writeBlockhash,
      lastValidBlockHeight: writeLastValidBlockHeight,
    } = await connection.getLatestBlockhash();

    if (sendTx) {
      const v0Message = new TransactionMessage({
        payerKey,
        recentBlockhash: writeBlockhash,
        instructions: [writeIx],
      }).compileToV0Message();
      const v0Tx = new VersionedTransaction(v0Message);

      v0Tx.sign([user.wallet.payer]);
      const signature = await connection.sendTransaction(v0Tx, {
        maxRetries: 2,
      });
      await connection.confirmTransaction(
        {
          signature,
          blockhash: writeBlockhash,
          lastValidBlockHeight: writeLastValidBlockHeight,
        },
        "confirmed",
      );
      console.log(`  writeBankMetadata tx: ${signature}`);
      console.log(`  https://solscan.io/tx/${signature}`);
    } else {
      let transaction = new Transaction().add(writeIx);
      transaction.feePayer = config.MULTISIG_PAYER;
      transaction.recentBlockhash = writeBlockhash;
      const serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const base58Transaction = bs58.encode(serializedTransaction);
      console.log("  writeBankMetadata Base58 tx:", base58Transaction);
    }

    console.log(`  Done with bank ${entry.bank.toBase58()}`);

    if (i < config.BANKS.length - 1 && delay > 0) {
      console.log(`  Waiting ${delay}ms...`);
      await sleep(delay);
    }
  }

  console.log("\nAll banks processed.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
