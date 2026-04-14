/**
 * Simulates a base58-encoded transaction and prints logs
 * Usage: pnpm tsx scripts/kamino/simulate_transaction.ts <base58_tx>
 */

import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { loadEnvFile } from "../utils/utils";

async function main() {
  const base58Tx = process.argv[2];

  if (!base58Tx) {
    console.error("Usage: pnpm tsx scripts/kamino/simulate_transaction.ts <base58_tx>");
    process.exit(1);
  }

  loadEnvFile(".env.api");
  const apiUrl = process.env.API_URL || "https://api.mainnet-beta.solana.com";
  const connection = new Connection(apiUrl, "confirmed");

  console.log("🔄 Simulating transaction...");
  console.log("RPC:", apiUrl);
  console.log();

  try {
    // Decode transaction
    const txBuffer = Buffer.from(bs58.decode(base58Tx));

    // Try legacy transaction first
    let tx: Transaction | VersionedTransaction;
    try {
      tx = Transaction.from(txBuffer);
    } catch {
      // Fall back to versioned transaction
      tx = VersionedTransaction.deserialize(txBuffer);
    }

    // Simulate with signature verification disabled
    let simulation;
    if (tx instanceof Transaction) {
      simulation = await connection.simulateTransaction(tx);
    } else {
      simulation = await connection.simulateTransaction(tx, {
        sigVerify: false,
      });
    }

    // Print results
    if (simulation.value.err) {
      console.error("❌ Simulation failed:");
      console.error(JSON.stringify(simulation.value.err, null, 2));
      console.log();
    } else {
      console.log("✅ Simulation successful!");
      console.log();
    }

    console.log("📊 Results:");
    console.log(`  Units consumed: ${simulation.value.unitsConsumed || "N/A"}`);
    console.log(`  Accounts read: ${simulation.value.accounts?.length || 0}`);
    console.log();

    if (simulation.value.logs && simulation.value.logs.length > 0) {
      console.log("📝 Logs:");
      simulation.value.logs.forEach((log, i) => {
        console.log(`  [${i}] ${log}`);
      });
    } else {
      console.log("📝 Logs: (none)");
    }

    process.exit(simulation.value.err ? 1 : 0);
  } catch (error) {
    console.error("❌ Error simulating transaction:");
    console.error(error);
    process.exit(1);
  }
}

main();
