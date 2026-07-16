import {
  AddressLookupTableAccount,
  Commitment,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SendTransactionError,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { CrossbarClient, Gateway } from "@switchboard-xyz/common";
import * as sb from "@switchboard-xyz/on-demand";
import { loadKeypairFromFile } from "../../lib/utils";
import { DEFAULT_API_URL, loadEnvFile } from "../utils/utils";

export type Config = {
  ORACLE_KEYS: PublicKey[];
  CROSSBAR_CLIENT: CrossbarClient;

  /** Optional */
  GATEWAY_URL?: string;
  NETWORK?: string;
  NUM_SIGNATURES?: number;
  WALLET_PATH?: string;
  RPC_URL?: string;
  COMMITMENT?: Commitment;
  MAX_RETRIES?: number;
  SIMULATE_BEFORE_SEND?: boolean;
  COMPUTE_UNIT_LIMIT_PER_FEED?: number;
  COMPUTE_UNIT_PRICE_MICRO_LAMPORTS?: number;
  FETCH_UPDATE_MAX_ATTEMPTS?: number;
  FETCH_UPDATE_RETRY_DELAY_MS?: number;
  HIDE_FETCH_SIGNATURES_CONSENSUS_AXIOS_ERRORS?: boolean;
  JUP_API_ENV_VAR?: string;
  JUP_API_VARIABLE_OVERRIDE_NAMES?: string[];
  SWITCHBOARD_VARIABLE_OVERRIDES?: Record<string, string>;
};

const config: Config = {
  ORACLE_KEYS: [
    new PublicKey("Bpj45hy6poT2TwqxLDHiwjjeq1WoijLHPtS34VNN18hX"),
  ],
  CROSSBAR_CLIENT: new CrossbarClient(
    "https://crossbar.switchboard.xyz",
  ),

  // curl -s 'https://crossbar.switchboard-oracles.xyz/gateways?network=mainnet' | jq
  GATEWAY_URL: undefined,
  NETWORK: "mainnet",
  NUM_SIGNATURES: 1,
  WALLET_PATH: "/.config/solana/id.json",
  COMMITMENT: "confirmed",
  MAX_RETRIES: 5,
  SIMULATE_BEFORE_SEND: true,
  COMPUTE_UNIT_LIMIT_PER_FEED: 300_000,
  COMPUTE_UNIT_PRICE_MICRO_LAMPORTS: 5_000,
  FETCH_UPDATE_MAX_ATTEMPTS: 5,
  FETCH_UPDATE_RETRY_DELAY_MS: 1_000,
  HIDE_FETCH_SIGNATURES_CONSENSUS_AXIOS_ERRORS: true,
  JUP_API_ENV_VAR: "JUP_API",
  JUP_API_VARIABLE_OVERRIDE_NAMES: ["JUPITER_API_KEY"],
};

async function main() {
  await crankSwitchboardFeeds(config);
}

export async function crankSwitchboardFeeds(config: Config) {
  if (config.ORACLE_KEYS.length === 0) {
    throw new Error("No Switchboard oracle keys configured.");
  }

  loadEnvFile(".env");
  loadEnvFile(".env.api");

  const commitment = config.COMMITMENT ?? "confirmed";
  const network = config.NETWORK ?? "mainnet";
  const numSignatures = config.NUM_SIGNATURES ?? 1;
  const variableOverrides = buildVariableOverrides(config);
  const connection = new Connection(
    config.RPC_URL ?? process.env.API_URL ?? DEFAULT_API_URL,
    commitment,
  );
  const payer = loadKeypairFromFile(
    resolveWalletPath(config.WALLET_PATH ?? "/.config/solana/id.json"),
  );

  if (config.GATEWAY_URL) {
    forceCrossbarGateway(config.CROSSBAR_CLIENT, config.GATEWAY_URL);
  }

  const feedKeys = dedupePublicKeys(config.ORACLE_KEYS);
  const feedKeyStrings = feedKeys.map((key) => key.toBase58());

  console.log("Switchboard crank config:");
  console.log(`  rpc: ${connection.rpcEndpoint}`);
  console.log(`  commitment: ${commitment}`);
  console.log(`  payer: ${payer.publicKey.toBase58()}`);
  console.log(`  crossbar: ${config.CROSSBAR_CLIENT.crossbarUrl}`);
  console.log(`  gateway override: ${config.GATEWAY_URL ?? "<none>"}`);
  console.log(`  network: ${network}`);
  console.log(`  numSignatures: ${numSignatures}`);
  console.log(
    `  suppress fetchSignaturesConsensus Axios dumps: ${
      config.HIDE_FETCH_SIGNATURES_CONSENSUS_AXIOS_ERRORS ?? false
    }`,
  );
  console.log(
    `  Switchboard variable overrides: ${
      Object.keys(variableOverrides).length > 0
        ? Object.keys(variableOverrides).join(", ")
        : "<none>"
    }`,
  );

  await logCrossbarGateways(config.CROSSBAR_CLIENT, network);

  console.log(`Cranking ${feedKeys.length} Switchboard feed(s):`);
  for (const feedKey of feedKeyStrings) {
    console.log(`  ${feedKey}`);
  }

  await logCrossbarSimulation(config.CROSSBAR_CLIENT, network, feedKeyStrings);

  console.log("Loading Switchboard program...");
  const swbProgram = await sb.AnchorUtils.loadProgramFromConnection(
    // TODO fix when web3 is bumped in swb?
    // @ts-ignore
    connection,
  );

  const pullFeeds = feedKeys.map(
    (feedKey) => new sb.PullFeed(swbProgram as any, feedKey as any),
  );
  const computeIxs = makeComputeBudgetIxs(config, pullFeeds.length);

  console.log(JSON.stringify(variableOverrides));

  console.log("Fetching Switchboard update instructions through SDK...");
  const [switchboardIxs, lookupTables, consensusResponse] =
    await fetchUpdateManyIxWithOracleRetry({
      swbProgram,
      feeds: pullFeeds,
      numSignatures,
      crossbarClient: config.CROSSBAR_CLIENT,
      payer: payer.publicKey as any,
      signatureInstructionIdx: computeIxs.length,
      maxAttempts: config.FETCH_UPDATE_MAX_ATTEMPTS ?? 5,
      retryDelayMs: config.FETCH_UPDATE_RETRY_DELAY_MS ?? 1_000,
      network,
      variableOverrides,
      hideFetchSignaturesConsensusAxiosErrors:
        config.HIDE_FETCH_SIGNATURES_CONSENSUS_AXIOS_ERRORS ?? false,
    });

  logConsensusResponse(consensusResponse);

  const switchboardInstructions = switchboardIxs as TransactionInstruction[];
  const switchboardLookupTables = lookupTables as AddressLookupTableAccount[];
  const instructions = [...computeIxs, ...switchboardInstructions];
  if (switchboardIxs.length === 0) {
    throw new Error("Switchboard SDK returned no crank instructions.");
  }
  logInstructions(instructions);

  logLookupTables(switchboardLookupTables);

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(commitment);
  console.log(`Latest blockhash: ${blockhash}`);
  console.log(`Last valid block height: ${lastValidBlockHeight}`);

  const v0Message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(switchboardLookupTables);

  const v0Tx = new VersionedTransaction(v0Message);
  v0Tx.sign([payer]);

  console.log(`Serialized tx bytes: ${v0Tx.serialize().length}`);

  if (config.SIMULATE_BEFORE_SEND ?? false) {
    await logSimulation(connection, v0Tx);
  }

  let signature: string;
  try {
    console.log("Sending Switchboard crank transaction...");
    signature = await connection.sendTransaction(v0Tx, {
      maxRetries: config.MAX_RETRIES ?? 5,
    });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      commitment,
    );
  } catch (error) {
    await logSendTransactionError(connection, error);
    throw error;
  }

  console.log("Swb crank (v0) tx signature:", signature);
}

async function fetchUpdateManyIxWithOracleRetry(args: {
  swbProgram: any;
  feeds: sb.PullFeed[];
  numSignatures: number;
  crossbarClient: CrossbarClient;
  payer: PublicKey;
  signatureInstructionIdx: number;
  maxAttempts: number;
  retryDelayMs: number;
  network: string;
  variableOverrides: Record<string, string>;
  hideFetchSignaturesConsensusAxiosErrors: boolean;
}) {
  let lastError: unknown;
  const gatewayUrls = await getRetryGatewayUrls(
    args.crossbarClient,
    args.network,
  );

  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    try {
      const gatewayUrl = gatewayUrls[(attempt - 1) % gatewayUrls.length];
      forceCrossbarGateway(args.crossbarClient, gatewayUrl);
      console.log(
        `fetchUpdateManyIx attempt ${attempt}/${args.maxAttempts}`,
      );
      console.log(`  gateway: ${gatewayUrl}`);

      return await withFetchSignaturesConsensusVariableOverrides(
        args.variableOverrides,
        async () =>
          withOptionalFetchSignaturesConsensusErrorSuppression(
            args.hideFetchSignaturesConsensusAxiosErrors,
            async () =>
              sb.PullFeed.fetchUpdateManyIx(args.swbProgram, {
                feeds: args.feeds,
                numSignatures: args.numSignatures,
                crossbarClient: args.crossbarClient,
                payer: args.payer,
                signatureInstructionIdx: args.signatureInstructionIdx,
                variableOverrides: args.variableOverrides,
              }),
          ),
      );
    } catch (error) {
      lastError = error;

      if (!isOracleUnavailableError(error) || attempt === args.maxAttempts) {
        throw error;
      }

      console.warn(
        `ORACLE_UNAVAILABLE on attempt ${attempt}; retrying in ${args.retryDelayMs}ms`,
      );
      console.warn(extractOracleUnavailableMessage(error));

      await sleep(args.retryDelayMs);
    }
  }

  throw lastError;
}

async function withFetchSignaturesConsensusVariableOverrides<T>(
  variableOverrides: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  if (Object.keys(variableOverrides).length === 0) {
    return fn();
  }

  const queue = sb.Queue as any;
  const originalFetchSignaturesConsensus = queue.fetchSignaturesConsensus;

  queue.fetchSignaturesConsensus = async (program: any, params: any) =>
    originalFetchSignaturesConsensus.call(queue, program, {
      ...params,
      variableOverrides: {
        ...(params.variableOverrides ?? {}),
        ...variableOverrides,
      },
    });

  try {
    return await fn();
  } finally {
    queue.fetchSignaturesConsensus = originalFetchSignaturesConsensus;
  }
}

async function withOptionalFetchSignaturesConsensusErrorSuppression<T>(
  suppress: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!suppress) {
    return fn();
  }

  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const firstArg = args[0];
    if (
      typeof firstArg === "string" &&
      firstArg.includes("fetchSignaturesConsensus error")
    ) {
      return;
    }

    originalConsoleError(...args);
  };

  try {
    return await fn();
  } finally {
    console.error = originalConsoleError;
  }
}

async function getRetryGatewayUrls(
  crossbarClient: CrossbarClient,
  network: string,
): Promise<string[]> {
  try {
    const gateways = await crossbarClient.fetchGateways(network);
    const dedupedGateways = [...new Set(gateways)];

    if (dedupedGateways.length > 0) {
      return dedupedGateways;
    }
  } catch (error) {
    console.warn("Failed to fetch retry gateway list; using fetchGateway().");
    console.warn(error);
  }

  const gateway = await crossbarClient.fetchGateway(network);
  return [gateway.gatewayUrl];
}

function isOracleUnavailableError(error: unknown): boolean {
  return extractOracleUnavailableMessage(error).includes("ORACLE_UNAVAILABLE");
}

function extractOracleUnavailableMessage(error: unknown): string {
  const err = error as any;
  const responseData = err?.response?.data;

  if (typeof responseData === "string") {
    return responseData;
  }

  if (typeof err?.message === "string") {
    return err.message;
  }

  return "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function forceCrossbarGateway(
  crossbarClient: CrossbarClient,
  gatewayUrl: string,
) {
  const gateway = new Gateway(gatewayUrl);

  crossbarClient.fetchGateway = async () => gateway;
}

function buildVariableOverrides(config: Config): Record<string, string> {
  const variableOverrides: Record<string, string> = {
    ...(config.SWITCHBOARD_VARIABLE_OVERRIDES ?? {}),
  };
  const jupApiEnvVar = config.JUP_API_ENV_VAR;

  if (!jupApiEnvVar) {
    return variableOverrides;
  }

  const jupApiKey = stripMatchingOuterQuotes(process.env[jupApiEnvVar] ?? "");
  if (!jupApiKey) {
    console.warn(`Jupiter API env var ${jupApiEnvVar} is not set.`);
    return variableOverrides;
  }

  for (const overrideName of config.JUP_API_VARIABLE_OVERRIDE_NAMES ?? []) {
    variableOverrides[overrideName] = jupApiKey;
  }

  return variableOverrides;
}

function stripMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];

  if (
    trimmed.length >= 2 &&
    ((first === "\"" && last === "\"") || (first === "'" && last === "'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

async function logCrossbarGateways(
  crossbarClient: CrossbarClient,
  network: string,
) {
  try {
    const gateways = await crossbarClient.fetchGateways(network);
    console.log(`Crossbar gateways (${gateways.length}):`);
    for (const [index, gateway] of gateways.entries()) {
      console.log(`  [${index}] ${gateway}${index === 0 ? " (selected)" : ""}`);
    }

    const selectedGateway = await crossbarClient.fetchGateway(network);
    console.log(`Crossbar fetchGateway(): ${selectedGateway.gatewayUrl}`);
  } catch (error) {
    console.warn("Failed to fetch Crossbar gateways:");
    console.warn(error);
  }
}

async function logCrossbarSimulation(
  crossbarClient: CrossbarClient,
  network: string,
  feedKeys: string[],
) {
  try {
    console.log("Simulating feeds through Crossbar...");
    const simulations = await crossbarClient.simulateSolanaFeeds(
      network,
      feedKeys,
    );

    console.log(`Crossbar simulation result count: ${simulations.length}`);
    for (const [index, simulation] of simulations.entries()) {
      console.log(`Simulation ${index}:`);
      console.log(`  feed: ${simulation.feed}`);
      console.log(`  feedHash: ${simulation.feedHash}`);
      console.log(`  results: ${JSON.stringify(simulation.results)}`);
    }
  } catch (error) {
    console.warn("Crossbar feed simulation failed:");
    console.warn(error);
  }
}

function makeComputeBudgetIxs(
  config: Config,
  feedCount: number,
): TransactionInstruction[] {
  const perFeedUnits = config.COMPUTE_UNIT_LIMIT_PER_FEED ?? 300_000;
  const unitLimit = Math.min(
    1_400_000,
    Math.max(300_000, perFeedUnits * feedCount),
  );

  console.log(`Compute unit limit: ${unitLimit}`);
  console.log(
    `Compute unit price: ${config.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS ?? 5_000}`,
  );

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: config.COMPUTE_UNIT_PRICE_MICRO_LAMPORTS ?? 5_000,
    }),
  ];
}

function logConsensusResponse(response: any) {
  console.log("Switchboard consensus response:");
  console.log(`  slot: ${response.slot}`);
  console.log(`  recent_hash: ${response.recent_hash}`);
  console.log(`  median_responses: ${response.median_responses?.length ?? 0}`);

  for (const [index, median] of (response.median_responses ?? []).entries()) {
    console.log(`  median ${index}:`);
    console.log(`    feed_hash: ${median.feed_hash}`);
    console.log(`    value: ${median.value}`);
    console.log(
      `    num_successful_responses: ${median.num_successful_responses}`,
    );
    console.log(`    min_oracle_samples: ${median.min_oracle_samples}`);
  }

  console.log(`  oracle_responses: ${response.oracle_responses?.length ?? 0}`);
  for (const [index, oracle] of (response.oracle_responses ?? []).entries()) {
    console.log(`  oracle ${index}:`);
    console.log(`    oracle_pubkey: ${oracle.oracle_pubkey}`);
    console.log(`    oracle_idx: ${oracle.oracle_idx}`);
    console.log(`    eth_address: ${oracle.eth_address}`);
    console.log(`    recovery_id: ${oracle.recovery_id}`);
    console.log(`    checksum: ${oracle.checksum}`);
    console.log(`    feed_responses: ${oracle.feed_responses?.length ?? 0}`);
    console.log(`    errors: ${JSON.stringify(oracle.errors ?? [])}`);
  }

  console.log(
    `  failed_oracle_responses: ${response.failed_oracle_responses?.length ?? 0}`,
  );
  for (const [index, oracle] of (
    response.failed_oracle_responses ?? []
  ).entries()) {
    console.log(`  failed oracle ${index}:`);
    console.log(`    oracle_pubkey: ${oracle.oracle_pubkey}`);
    console.log(`    oracle_idx: ${oracle.oracle_idx}`);
    console.log(`    errors: ${JSON.stringify(oracle.errors ?? [])}`);
  }
}

function logInstructions(instructions: TransactionInstruction[]) {
  console.log(`Decoded instruction count: ${instructions.length}`);

  for (const [index, instruction] of instructions.entries()) {
    console.log(`Instruction ${index}:`);
    console.log(`  programId: ${instruction.programId.toBase58()}`);
    console.log(`  data bytes: ${instruction.data.length}`);
    console.log(`  data hex prefix: ${instruction.data.toString("hex").slice(0, 64)}`);
    console.log(`  account metas: ${instruction.keys.length}`);

    for (const [accountIndex, key] of instruction.keys.entries()) {
      console.log(
        `    [${accountIndex}] ${key.pubkey.toBase58()} signer=${key.isSigner} writable=${key.isWritable}`,
      );
    }
  }
}

function logLookupTables(lookupTables: AddressLookupTableAccount[]) {
  console.log(`Loaded LUT count: ${lookupTables.length}`);
  for (const [index, lookupTable] of lookupTables.entries()) {
    console.log(
      `  [${index}] ${lookupTable.key.toBase58()} addresses=${lookupTable.state.addresses.length}`,
    );
  }
}

async function logSimulation(
  connection: Connection,
  transaction: VersionedTransaction,
) {
  console.log("Simulating transaction before send...");
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: true,
    replaceRecentBlockhash: false,
  });

  console.log(`Simulation err: ${JSON.stringify(simulation.value.err)}`);
  console.log(`Simulation units consumed: ${simulation.value.unitsConsumed}`);

  if (simulation.value.logs && simulation.value.logs.length > 0) {
    console.log("Simulation logs:");
    for (const log of simulation.value.logs) {
      console.log(`  ${log}`);
    }
  } else {
    console.log("Simulation logs: <none>");
  }
}

async function logSendTransactionError(
  connection: Connection,
  error: unknown,
) {
  if (!(error instanceof SendTransactionError)) {
    console.error("Non-SendTransactionError thrown while sending:");
    console.error(error);
    return;
  }

  console.error("SendTransactionError details:");
  console.error(`  message: ${error.transactionError.message}`);
  console.error(
    `  cached logs: ${JSON.stringify(error.transactionError.logs ?? [], null, 2)}`,
  );

  try {
    const logs = await error.getLogs(connection);
    console.error("  getLogs():");
    for (const log of logs) {
      console.error(`    ${log}`);
    }
  } catch (logsError) {
    console.error("  getLogs() failed:");
    console.error(logsError);
  }
}

function resolveWalletPath(walletPath: string): string {
  if (walletPath.startsWith("/.config/")) {
    return `${process.env.HOME}${walletPath}`;
  }

  return walletPath;
}

function dedupePublicKeys(keys: PublicKey[]): PublicKey[] {
  return [...new Map(keys.map((key) => [key.toBase58(), key])).values()];
}

if (require.main === module) {
  main().catch((err) => {
    logErrorSafely(err);
  });
}

function logErrorSafely(error: unknown) {
  const err = error as any;

  if (err?.isAxiosError) {
    console.error(`${err.name ?? "AxiosError"}: ${err.message}`);
    console.error(`  status: ${err.response?.status ?? "<none>"}`);
    console.error(`  url: ${err.config?.url ?? "<unknown>"}`);

    if (err.response?.data) {
      console.error(`  response: ${err.response.data}`);
    }

    return;
  }

  console.error(error);
}
