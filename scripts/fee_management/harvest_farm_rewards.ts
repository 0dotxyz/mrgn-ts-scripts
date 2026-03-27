/**
 * Harvest farm rewards from Kamino farms attached to marginfi banks
 * 
 * This script harvests rewards from Kamino Farms that are accrued by marginfi banks.
 * The harvested rewards are sent to the global fee wallet.
 * 
 * Run with:
 * ts-node harvest_farm_rewards.ts <path-to-config.json>
 * 
 * Example:
 * ts-node harvest_farm_rewards.ts scripts/farm_rewards/my-reward-config.json
 */

import {
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
} from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { deriveLiquidityVaultAuthority } from "../common/pdas";
import { loadEnvFile } from "../utils/utils";
import * as fs from "fs";
import * as path from "path";

const sendTx = true;

// Load .env from root directory first (before commonSetup tries to load .env.api)
loadEnvFile(".env");

// Strip quotes from environment variables (in case .env has quoted values)
const stripQuotes = (str: string): string => {
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
        return str.slice(1, -1);
    }
    return str;
};

// Map PRIVATE_RPC_ENDPOINT to API_URL if it exists (for commonSetup compatibility)
if (process.env.PRIVATE_RPC_ENDPOINT) {
    const cleanEndpoint = stripQuotes(process.env.PRIVATE_RPC_ENDPOINT);
    process.env.API_URL = cleanEndpoint;
    process.env.PRIVATE_RPC_ENDPOINT = cleanEndpoint; // Also clean the original
}

// Clean API_URL if it exists and has quotes
if (process.env.API_URL) {
    process.env.API_URL = stripQuotes(process.env.API_URL);
}

// Clean MARGINFI_WALLET if it exists and has quotes
if (process.env.MARGINFI_WALLET) {
    process.env.MARGINFI_WALLET = stripQuotes(process.env.MARGINFI_WALLET);
}

// Kamino Farms program ID (mainnet)
const FARMS_PROGRAM_ID = new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");

/**
 * Configuration for harvesting farm rewards (parsed from JSON file)
 */
type ConfigJson = {
    /** Marginfi program ID */
    PROGRAM_ID: string;

    /** The marginfi bank address that has a Kamino farm attached */
    BANK: string;

    /** The Kamino lending market (required to derive obligation) */
    LENDING_MARKET: string;

    /** The Kamino farm state address for this bank */
    FARM_STATE: string;

    /** The Kamino global config address */
    GLOBAL_CONFIG: string;

    /** The reward mint address */
    REWARD_MINT: string;

    /** The reward index to harvest (usually 0 for the first reward) */
    REWARD_INDEX: number;

    /** Multisig wallet (optional, if not sending directly) */
    MULTISIG?: string | null;
};

/**
 * Parsed configuration with PublicKey objects
 */
type Config = {
    PROGRAM_ID: string;
    BANK: PublicKey;
    LENDING_MARKET: PublicKey;
    FARM_STATE: PublicKey;
    GLOBAL_CONFIG: PublicKey;
    REWARD_MINT: PublicKey;
    REWARD_INDEX: number;
    MULTISIG?: PublicKey;
};

/**
 * Load and parse config from JSON file
 */
function loadConfig(configPath: string): Config {
    try {
        // Read the config file
        const absolutePath = path.isAbsolute(configPath)
            ? configPath
            : path.resolve(process.cwd(), configPath);

        if (!fs.existsSync(absolutePath)) {
            throw new Error(`Config file not found: ${absolutePath}`);
        }

        const configData = fs.readFileSync(absolutePath, "utf-8");
        const configJson: ConfigJson = JSON.parse(configData);

        // Validate required fields
        const requiredFields = [
            "PROGRAM_ID",
            "BANK",
            "LENDING_MARKET",
            "FARM_STATE",
            "GLOBAL_CONFIG",
            "REWARD_MINT",
            "REWARD_INDEX",
        ];

        for (const field of requiredFields) {
            if (!(field in configJson) || configJson[field as keyof ConfigJson] === null) {
                throw new Error(`Missing required field in config: ${field}`);
            }
        }

        // Parse public keys
        const config: Config = {
            PROGRAM_ID: configJson.PROGRAM_ID,
            BANK: new PublicKey(configJson.BANK),
            LENDING_MARKET: new PublicKey(configJson.LENDING_MARKET),
            FARM_STATE: new PublicKey(configJson.FARM_STATE),
            GLOBAL_CONFIG: new PublicKey(configJson.GLOBAL_CONFIG),
            REWARD_MINT: new PublicKey(configJson.REWARD_MINT),
            REWARD_INDEX: configJson.REWARD_INDEX,
        };

        // Add optional multisig if present
        if (configJson.MULTISIG && configJson.MULTISIG !== null) {
            config.MULTISIG = new PublicKey(configJson.MULTISIG);
        }

        return config;
    } catch (error) {
        if (error instanceof Error) {
            throw new Error(`Failed to load config: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Derive the global fee state PDA
 */
const deriveGlobalFeeState = (programId: PublicKey) => {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("feestate", "utf-8")],
        programId
    );
};

/**
 * Derive the Kamino user state PDA (farm obligation user state)
 */
const deriveUserState = (
    farmsProgramId: PublicKey,
    farmState: PublicKey,
    obligation: PublicKey
) => {
    return PublicKey.findProgramAddressSync(
        [
            Buffer.from("user"),
            farmState.toBuffer(),
            obligation.toBuffer(),
        ],
        farmsProgramId
    );
};

const KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

/**
 * Internal helper to derive a Kamino obligation PDA with full seed support
 */
const deriveObligation = (
    programId: PublicKey,
    tag: number,
    id: number,
    ownerPublicKey: PublicKey,
    marketPublicKey: PublicKey,
    seed1AccountKey: PublicKey,
    seed2AccountKey: PublicKey
) => {
    const tagBuffer = Buffer.alloc(1);
    tagBuffer.writeUInt8(tag);

    const idBuffer = Buffer.alloc(1);
    idBuffer.writeUInt8(id);

    return PublicKey.findProgramAddressSync(
        [
            tagBuffer,
            idBuffer,
            ownerPublicKey.toBuffer(),
            marketPublicKey.toBuffer(),
            seed1AccountKey.toBuffer(),
            seed2AccountKey.toBuffer(),
        ],
        programId
    );
};

/**
 * Derive the Kamino base obligation PDA
 * 
 * Typically the obligation for each bank will have tag and id = 0
 * @param ownerPublicKey - The liquidity vault authority that owns the obligation
 * @param marketPublicKey - The Kamino lending market
 * @param programId - Default KLEND_PROGRAM_ID
 * @param seed1AccountKey - Default PublicKey.default
 * @param seed2AccountKey - Default PublicKey.default
 * @param tag - Default 0
 * @param id - Default 0
 * @returns [PublicKey, number] - The obligation PDA and bump
 */
const deriveBaseObligation = (
    ownerPublicKey: PublicKey,
    marketPublicKey: PublicKey,
    programId: PublicKey = KLEND_PROGRAM_ID,
    seed1AccountKey: PublicKey = PublicKey.default,
    seed2AccountKey: PublicKey = PublicKey.default,
    tag: number = 0,
    id: number = 0
) => {
    return deriveObligation(
        programId,
        tag,
        id,
        ownerPublicKey,
        marketPublicKey,
        seed1AccountKey,
        seed2AccountKey
    );
};

/**
 * Derive the farm vaults authority PDA
 */
const deriveFarmVaultsAuthority = (
    farmsProgramId: PublicKey,
    farmState: PublicKey
) => {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("authority"), farmState.toBuffer()],
        farmsProgramId
    );
};

/**
 * Derive the reward vault PDA
 */
const deriveRewardVault = (
    farmsProgramId: PublicKey,
    farmState: PublicKey,
    rewardMint: PublicKey
) => {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("rvault"), farmState.toBuffer(), rewardMint.toBuffer()],
        farmsProgramId
    );
};

/**
 * Derive the reward treasury vault PDA
 */
const deriveRewardTreasuryVault = (
    farmsProgramId: PublicKey,
    globalConfig: PublicKey,
    rewardMint: PublicKey
) => {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("tvault"), globalConfig.toBuffer(), rewardMint.toBuffer()],
        farmsProgramId
    );
};

async function main() {
    // Check for config file argument
    if (process.argv.length < 3) {
        console.error("❌ Error: Config file path is required");
        console.error("\nUsage:");
        console.error("  ts-node harvest_farm_rewards.ts <path-to-config.json>");
        console.error("\nExample:");
        console.error("  ts-node harvest_farm_rewards.ts scripts/farm_rewards/my-reward-config.json");
        console.error("\nSee scripts/farm_rewards/README_CONFIG.md for more information");
        process.exit(1);
    }

    const configPath = process.argv[2];
    console.log(`Loading config from: ${configPath}`);

    // Load and parse config
    let config: Config;
    try {
        config = loadConfig(configPath);
        console.log("✅ Config loaded successfully\n");
    } catch (error) {
        console.error("❌ Failed to load config:", error instanceof Error ? error.message : error);
        process.exit(1);
    }

    // Debug: Show loaded environment variables
    console.log("Environment variables loaded:");
    console.log("  PRIVATE_RPC_ENDPOINT:", process.env.PRIVATE_RPC_ENDPOINT ? "✓ Set" : "✗ Not set");
    console.log("  API_URL:", process.env.API_URL ? process.env.API_URL : "Using default");
    console.log("  MARGINFI_WALLET:", process.env.MARGINFI_WALLET || "Using default");
    console.log("  HOME:", process.env.HOME);
    console.log("");

    // Get wallet path from env or use default
    let walletPath = process.env.MARGINFI_WALLET || "/.config/solana/id.json";

    // commonSetup prepends HOME to the path, so if we have an absolute path, strip HOME first
    if (path.isAbsolute(walletPath) && process.env.HOME && walletPath.startsWith(process.env.HOME)) {
        walletPath = walletPath.substring(process.env.HOME.length);
    }

    console.log("Wallet path (relative to HOME):", walletPath);
    console.log("Full wallet path that will be loaded:", process.env.HOME + walletPath);

    const user = commonSetup(
        sendTx,
        config.PROGRAM_ID,
        walletPath,
        config.MULTISIG,
        "current" // Use the kamino IDL version
    );
    const program = user.program;
    const connection = user.connection;

    console.log("Harvesting farm rewards...");
    console.log("Program ID:", config.PROGRAM_ID);
    console.log("Bank:", config.BANK.toString());
    console.log("Lending Market:", config.LENDING_MARKET.toString());
    console.log("Farm State:", config.FARM_STATE.toString());
    console.log("Reward Mint:", config.REWARD_MINT.toString());
    console.log("Reward Index:", config.REWARD_INDEX);

    // Detect which token program the reward mint uses
    console.log("\nDetecting token program for reward mint...");
    const mintInfo = await connection.getAccountInfo(config.REWARD_MINT);
    if (!mintInfo) {
        throw new Error("Reward mint account not found");
    }

    const tokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

    console.log("Token Program:", tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "Legacy Token Program");
    console.log("Token Program ID:", tokenProgram.toString());

    // Derive PDAs
    const [feeState] = deriveGlobalFeeState(new PublicKey(config.PROGRAM_ID));
    console.log("Fee State:", feeState.toString());

    // Fetch fee state to get the global fee wallet
    const feeStateAccount = await program.account.feeState.fetch(feeState);
    const globalFeeWallet = feeStateAccount.globalFeeWallet;
    console.log("Global Fee Wallet:", globalFeeWallet.toString());

    // Derive liquidity vault authority
    const [liquidityVaultAuthority] = deriveLiquidityVaultAuthority(
        new PublicKey(config.PROGRAM_ID),
        config.BANK
    );
    console.log("Liquidity Vault Authority:", liquidityVaultAuthority.toString());

    // Derive obligation using Kamino SDK method (tag=0, id=0 for base obligation)
    const [obligation] = deriveBaseObligation(liquidityVaultAuthority, config.LENDING_MARKET);
    console.log("Obligation (Kamino base obligation):", obligation.toString());

    // Derive user state (farm user state for the obligation)
    const [userState] = deriveUserState(
        FARMS_PROGRAM_ID,
        config.FARM_STATE,
        obligation
    );
    console.log("User State:", userState.toString());

    // Derive farm vaults authority
    const [farmVaultsAuthority] = deriveFarmVaultsAuthority(
        FARMS_PROGRAM_ID,
        config.FARM_STATE
    );
    console.log("Farm Vaults Authority:", farmVaultsAuthority.toString());

    // Derive reward vaults
    const [rewardsVault] = deriveRewardVault(
        FARMS_PROGRAM_ID,
        config.FARM_STATE,
        config.REWARD_MINT
    );
    console.log("Rewards Vault:", rewardsVault.toString());

    const [rewardsTreasuryVault] = deriveRewardTreasuryVault(
        FARMS_PROGRAM_ID,
        config.GLOBAL_CONFIG,
        config.REWARD_MINT
    );
    console.log("Rewards Treasury Vault:", rewardsTreasuryVault.toString());

    // Manually create destination ATA owned by globalFeeWallet (overriding IDL's auto-derivation)
    const destinationAta = getAssociatedTokenAddressSync(
        config.REWARD_MINT,
        globalFeeWallet,
        true,
        tokenProgram
    );
    console.log("Destination ATA (manually set to globalFeeWallet owner):", destinationAta.toString());
    console.log("  Owner: globalFeeWallet =", globalFeeWallet.toString());

    // Get user reward ATA (owned by liquidity vault authority)
    const userRewardAta = getAssociatedTokenAddressSync(
        config.REWARD_MINT,
        liquidityVaultAuthority,
        true,
        tokenProgram
    );
    console.log("User Reward ATA:", userRewardAta.toString());

    // Build transaction
    const transaction = new Transaction();

    // Add instruction to create destination ATA if it doesn't exist
    // Manually creating with globalFeeWallet as owner (overriding IDL's auto-derivation)
    transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
            user.wallet.publicKey,
            destinationAta,
            globalFeeWallet, // ✅ Manual override: globalFeeWallet is the owner
            config.REWARD_MINT,
            tokenProgram
        )
    );

    // Add instruction to create user reward ATA if it doesn't exist
    transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
            user.wallet.publicKey,
            userRewardAta,
            liquidityVaultAuthority,
            config.REWARD_MINT,
            tokenProgram
        )
    );

    // Add harvest reward instruction
    // Note: We're manually overriding destinationTokenAccount to use globalFeeWallet as owner
    // Note: liquidityVaultAuthority is still auto-derived by Anchor
    // Note: farmsProgram is hardcoded in the IDL and not passed as an account
    console.log("\n🔧 Building kaminoHarvestReward instruction...");
    console.log("   Manually overriding destinationTokenAccount to:", destinationAta.toString());

    const harvestIxBuilder = program.methods
        .kaminoHarvestReward(new BN(config.REWARD_INDEX))
        .accountsPartial({  // Use accountsPartial to allow overriding PDA-derived accounts
            bank: config.BANK,
            feeState: feeState,
            destinationTokenAccount: destinationAta, // ✅ Manual override with globalFeeWallet owner
            // liquidityVaultAuthority: auto-derived PDA (leave blank for Anchor to derive)
            userState: userState,
            farmState: config.FARM_STATE,
            globalConfig: config.GLOBAL_CONFIG,
            rewardMint: config.REWARD_MINT,
            userRewardAta: userRewardAta,
            rewardsVault: rewardsVault,
            rewardsTreasuryVault: rewardsTreasuryVault,
            farmVaultsAuthority: farmVaultsAuthority,
            scopePrices: null, // Optional, set to null if not needed
            tokenProgram: tokenProgram, // Use detected token program (supports both legacy and Token-2022)
        });

    // Get the resolved public keys from the instruction builder
    const resolvedAccounts = await harvestIxBuilder.pubkeys();

    console.log("\n📋 Resolved Instruction Accounts:");
    console.log("NOTE: destinationTokenAccount manually overridden to use globalFeeWallet as owner");
    console.log("      (overriding IDL's auto-derivation which would use feeState PDA)\n");
    console.log("  bank:", resolvedAccounts.bank?.toString());
    console.log("  feeState:", resolvedAccounts.feeState?.toString());
    console.log("  destinationTokenAccount (manually set):", resolvedAccounts.destinationTokenAccount?.toString());
    console.log("    ^ Should match our destinationAta:", destinationAta.toString());
    console.log("  liquidityVaultAuthority (auto-derived):", resolvedAccounts.liquidityVaultAuthority?.toString());
    console.log("  userState:", resolvedAccounts.userState?.toString());
    console.log("  farmState:", resolvedAccounts.farmState?.toString());
    console.log("  globalConfig:", resolvedAccounts.globalConfig?.toString());
    console.log("  rewardMint:", resolvedAccounts.rewardMint?.toString());
    console.log("  userRewardAta:", resolvedAccounts.userRewardAta?.toString());
    console.log("  rewardsVault:", resolvedAccounts.rewardsVault?.toString());
    console.log("  rewardsTreasuryVault:", resolvedAccounts.rewardsTreasuryVault?.toString());
    console.log("  farmVaultsAuthority:", resolvedAccounts.farmVaultsAuthority?.toString());
    console.log("  scopePrices:", resolvedAccounts.scopePrices?.toString() || "null");
    console.log("  farmsProgram:", resolvedAccounts.farmsProgram?.toString());
    console.log("  tokenProgram:", resolvedAccounts.tokenProgram?.toString());

    // Build and add the instruction
    const harvestIx = await harvestIxBuilder.instruction();
    transaction.add(harvestIx);

    if (sendTx) {
        try {
            console.log("\n🔍 Simulating transaction first...");

            // Get a recent blockhash for the simulation
            const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = user.wallet.publicKey;

            // Manually simulate to get detailed error logs
            const simulation = await connection.simulateTransaction(transaction);

            if (simulation.value.err) {
                console.error("\n❌ Transaction simulation failed!");
                console.error("Error:", JSON.stringify(simulation.value.err, null, 2));

                if (simulation.value.logs) {
                    console.error("\n📋 Simulation Logs:");
                    simulation.value.logs.forEach((log: string) => console.error("  " + log));
                }

                throw new Error("Transaction simulation failed: " + JSON.stringify(simulation.value.err));
            }

            console.log("✅ Simulation successful!");
            console.log("Compute units used:", simulation.value.unitsConsumed);

            if (simulation.value.logs && simulation.value.logs.length > 0) {
                console.log("\n📋 Simulation Logs:");
                simulation.value.logs.slice(0, 10).forEach((log: string) => console.log("  " + log));
                if (simulation.value.logs.length > 10) {
                    console.log(`  ... and ${simulation.value.logs.length - 10} more logs`);
                }
            }

            console.log("\n📤 Sending transaction...");
            const signature = await sendAndConfirmTransaction(
                connection,
                transaction,
                [user.wallet.payer],
                {
                    skipPreflight: false,
                    commitment: "confirmed",
                }
            );
            console.log("\n✅ Transaction successful!");
            console.log("Signature:", signature);
            console.log("View on Solana Explorer:", `https://explorer.solana.com/tx/${signature}`);
        } catch (error: any) {
            console.error("\n❌ Transaction failed:", error.message || error);

            // Try to get more details about the error
            if (error.logs) {
                console.error("\n📋 Transaction Logs:");
                error.logs.forEach((log: string) => console.error("  " + log));
            }

            throw error; // Re-throw to exit with error code
        }
    } else {
        // Prepare for multisig
        transaction.feePayer = config.MULTISIG;
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        const serializedTransaction = transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        });
        const base58Transaction = bs58.encode(serializedTransaction);
        console.log("Base58-encoded transaction for multisig:", base58Transaction);
    }

    console.log("✨ Harvest farm rewards complete!");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
