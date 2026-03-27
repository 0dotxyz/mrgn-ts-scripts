import { Connection, Transaction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { loadEnvFile } from "../utils/utils";

loadEnvFile(".env.api");

const base58Tx = process.argv[2];

if (!base58Tx) {
  console.error("Usage: npx tsx scripts/kamino/simulate_tx.ts <base58-transaction>");
  process.exit(1);
}

async function main() {
  const apiUrl = process.env.API_URL || "https://api.mainnet-beta.solana.com";
  const connection = new Connection(apiUrl, "confirmed");

  const txBuffer = bs58.decode(base58Tx);
  const tx = Transaction.from(txBuffer);

  console.log("Simulating transaction...");
  console.log("Fee payer:", tx.feePayer?.toBase58());
  console.log("Instructions:", tx.instructions.length);
  console.log("");

  const simulation = await connection.simulateTransaction(tx);

  console.log("=== SIMULATION RESULTS ===\n");

  if (simulation.value.err) {
    console.log("❌ Simulation failed!");
    console.log("Error:", JSON.stringify(simulation.value.err, null, 2));
  } else {
    console.log("✅ Simulation successful!");
    console.log("Compute units:", simulation.value.unitsConsumed);
  }

  if (simulation.value.logs) {
    console.log("\n📝 Logs:");
    simulation.value.logs.forEach((log, i) => {
      console.log(`  [${i}] ${log}`);
    });
  }
}

main().catch(console.error);
