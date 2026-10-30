import {
  AccountMeta,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { commonSetup } from "../lib/common-setup";
import { ASSET_TAG_STAKED } from "../lib/constants";
import { deriveStakedSettings } from "../scripts/common/pdas";

const BANK_CACHE_URL = "https://api.0.xyz/v0/bankCache?age=60";

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  ORACLE?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  // Only required if changing the oracle; otherwise leave undefined.
  // ORACLE: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
};

type CachedBank = {
  address: string;
  group: string;
  config: { assetTag: number };
};

async function getStakedBanks(group: PublicKey): Promise<PublicKey[]> {
  const response = await fetch(BANK_CACHE_URL);
  if (!response.ok) {
    throw new Error(
      `Bank cache request failed: ${response.status} ${response.statusText}`,
    );
  }
  const cache = (await response.json()) as { banks?: CachedBank[] };
  if (!Array.isArray(cache?.banks)) {
    throw new Error("Bank cache response is missing the banks array");
  }

  const addresses = new Set<string>();
  for (const bank of cache.banks) {
    if (
      !bank ||
      typeof bank.address !== "string" ||
      typeof bank.group !== "string" ||
      typeof bank.config?.assetTag !== "number"
    ) {
      throw new Error("Bank cache contains an invalid bank entry");
    }
    if (
      bank.group === group.toBase58() &&
      bank.config.assetTag === ASSET_TAG_STAKED
    ) {
      addresses.add(bank.address);
    }
  }
  if (addresses.size === 0) {
    throw new Error(`No staked banks found for group ${group.toBase58()}`);
  }
  return Array.from(addresses, (address) => new PublicKey(address));
}

async function main() {
  const banks = await getStakedBanks(config.GROUP);
  console.log(`Found ${banks.length} staked banks for group ${config.GROUP}`);

  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.keys/staging-deploy.json",
    undefined,
  );
  const program = user.program;
  const [stakedSettings] = deriveStakedSettings(program.programId, config.GROUP);
  const remainingAccounts: AccountMeta[] = config.ORACLE
    ? [{ pubkey: config.ORACLE, isSigner: false, isWritable: false }]
    : [];
  if (config.ORACLE) {
    console.log("updating oracle to: " + config.ORACLE);
  }

  const failedBanks: string[] = [];
  for (const bank of banks) {
    try {
      const ix = await program.methods
        .propagateStakedSettings()
        .accounts({ stakedSettings, bank })
        .remainingAccounts(remainingAccounts)
        .instruction();
      const signature = await sendAndConfirmTransaction(
        user.connection,
        new Transaction().add(ix),
        [user.wallet.payer],
      );
      console.log(`Propagated settings for ${bank}: ${signature}`);
    } catch (error) {
      failedBanks.push(bank.toBase58());
      console.error(`Failed to propagate settings for ${bank}:`, error);
    }
  }
  if (failedBanks.length > 0) {
    throw new Error(
      `Propagation failed for ${failedBanks.length} banks: ${failedBanks.join(", ")}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
