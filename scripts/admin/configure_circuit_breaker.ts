import {
  AddressLookupTableAccount,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { BN, Idl, Program } from "@coral-xyz/anchor";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { chunk } from "../utils/utils";
import marginfiIdl from "../../idl/marginfi.json";
import cbConfigFile from "./circuit_breaker_config.json";

/**
 * If true, send the txs. If false, output the unsigned b58 v0 txs to console for Squads.
 */
const sendTx = false;

/**
 * Largest serialized tx known to import into Squads: the rate-limit rollout's 15-instruction
 * tranche (configure_bank_rate_limits.ts). Larger txs that fit the wire limit were rejected.
 */
const KNOWN_GOOD_TX_BYTES = 458;
const MAX_BANKS_PER_TX = 5;

const PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const GROUP = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");
const ADMIN = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");
const LUTS = [
  new PublicKey("CQ8omkUwDtsszuJLo9grtXCeEyDU4QqBLRv9AjRDaUZ3"),
  new PublicKey("2b8UjpA3bAe7f8gcXd1gA3rFe6WuGZiKRNUXsS6tghEk"),
];
const WALLET_PATH = "/.keys/staging-deploy.json";

const CIRCUIT_BREAKER_ENABLED_BIT = 11;
const FREEZE_SETTINGS_BIT = 3;
const CB_ENABLE_MAX_PRICE_AGE_SECONDS = 30;

// Bounds enforced by `validate_circuit_breaker` on chain.
const MAX_DEVIATION_BPS = 5_000;
const MAX_ALPHA_BPS = 2_000;
const MAX_ESCALATION_MULT = 10;
const MAX_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const MAX_WINDOW_DEVIATION_BPS = 10_000;
const U16_MAX = 65_535;

export type CbSettings = {
  cbDeviationBpsTiers: [number, number, number];
  cbTierDurationsSeconds: [number, number, number];
  cbWindowMaxUpBps: number;
  cbWindowMaxDownBps: number;
  cbWindowSeconds: number;
  cbEscalationWindowMult: number;
  cbEmaAlphaBps: number;
};

export type BankEntry = {
  symbol: string;
  venue: string;
  address: string;
};

export type Category = CbSettings & {
  name: string;
  banks: BankEntry[];
};

type Target = {
  category: string;
  entry: BankEntry;
  bank: PublicKey;
  settings: CbSettings;
};

type Verdict = {
  target: Target;
  action: "enable" | "update" | "skip";
  reason: string;
  cacheAgeSeconds?: number;
  cachePricePositive?: boolean;
  switchboard?: boolean;
};

const CB_FIELDS: (keyof CbSettings)[] = [
  "cbDeviationBpsTiers",
  "cbTierDurationsSeconds",
  "cbWindowMaxUpBps",
  "cbWindowMaxDownBps",
  "cbWindowSeconds",
  "cbEscalationWindowMult",
  "cbEmaAlphaBps",
];

/**
 * Applies the shared settings to every category and flattens to one target per bank.
 * Throws on a bank listed under more than one category.
 */
export function loadTargets(file: typeof cbConfigFile): Target[] {
  const seen = new Map<string, string>();
  const targets: Target[] = [];

  for (const category of file.categories) {
    const settings: CbSettings = {
      cbDeviationBpsTiers: triple(category.cbDeviationBpsTiers, category.name),
      cbTierDurationsSeconds: triple(
        category.cbTierDurationsSeconds,
        category.name,
      ),
      cbWindowMaxUpBps: category.cbWindowMaxUpBps,
      cbWindowMaxDownBps: category.cbWindowMaxDownBps,
      cbWindowSeconds: category.cbWindowSeconds,
      cbEscalationWindowMult: file.shared.cbEscalationWindowMult,
      cbEmaAlphaBps: file.shared.cbEmaAlphaBps,
    };

    const errors = validateSettings(settings);
    if (errors.length > 0) {
      throw new Error(`${category.name}: ${errors.join("; ")}`);
    }

    for (const entry of category.banks) {
      const owner = seen.get(entry.address);
      if (owner) {
        throw new Error(
          `${entry.address} (${entry.symbol}) is listed under both ${owner} and ${category.name}`,
        );
      }
      seen.set(entry.address, category.name);
      targets.push({
        category: category.name,
        entry,
        bank: new PublicKey(entry.address),
        settings,
      });
    }
  }

  return targets;
}

function triple(values: number[], name: string): [number, number, number] {
  if (values.length !== 3) {
    throw new Error(`${name}: expected 3 tier values, got ${values.length}`);
  }
  return [values[0], values[1], values[2]];
}

/**
 * Mirrors the program's `validate_circuit_breaker` checks.
 */
export function validateSettings(s: CbSettings): string[] {
  const errors: string[] = [];
  const tiers = s.cbDeviationBpsTiers;
  const durations = s.cbTierDurationsSeconds;

  const requireUnsignedInteger = (name: string, value: number, max: number) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
      errors.push(`${name} ${value} outside integer range [0, ${max}]`);
      return false;
    }
    return true;
  };

  for (let i = 0; i < 3; i++) {
    if (
      requireUnsignedInteger(`tier ${i + 1} deviation`, tiers[i], U16_MAX) &&
      (tiers[i] <= 0 || tiers[i] > MAX_DEVIATION_BPS)
    ) {
      errors.push(
        `tier ${i + 1} deviation ${tiers[i]} outside (0, ${MAX_DEVIATION_BPS}]`,
      );
    }
    if (
      requireUnsignedInteger(`tier ${i + 1} duration`, durations[i], U16_MAX) &&
      durations[i] <= 0
    ) {
      errors.push(
        `tier ${i + 1} duration ${durations[i]} outside (0, ${U16_MAX}]`,
      );
    }
    if (i > 0 && tiers[i] <= tiers[i - 1]) {
      errors.push("deviation tiers must be strictly ascending");
    }
    if (i > 0 && durations[i] <= durations[i - 1]) {
      errors.push("tier durations must be strictly ascending");
    }
  }
  if (
    requireUnsignedInteger("ema alpha", s.cbEmaAlphaBps, U16_MAX) &&
    (s.cbEmaAlphaBps <= 0 || s.cbEmaAlphaBps > MAX_ALPHA_BPS)
  ) {
    errors.push(`ema alpha ${s.cbEmaAlphaBps} outside (0, ${MAX_ALPHA_BPS}]`);
  }
  if (
    requireUnsignedInteger("escalation mult", s.cbEscalationWindowMult, 255) &&
    (s.cbEscalationWindowMult <= 0 ||
      s.cbEscalationWindowMult > MAX_ESCALATION_MULT)
  ) {
    errors.push(
      `escalation mult ${s.cbEscalationWindowMult} outside (0, ${MAX_ESCALATION_MULT}]`,
    );
  }
  if (
    requireUnsignedInteger("window seconds", s.cbWindowSeconds, 0xffff_ffff) &&
    s.cbWindowSeconds > MAX_WINDOW_SECONDS
  ) {
    errors.push(
      `window seconds ${s.cbWindowSeconds} over ${MAX_WINDOW_SECONDS}`,
    );
  }
  const upValid = requireUnsignedInteger(
    "window max up bps",
    s.cbWindowMaxUpBps,
    U16_MAX,
  );
  const downValid = requireUnsignedInteger(
    "window max down bps",
    s.cbWindowMaxDownBps,
    U16_MAX,
  );
  if (
    upValid &&
    downValid &&
    (s.cbWindowMaxUpBps > MAX_WINDOW_DEVIATION_BPS ||
      s.cbWindowMaxDownBps > MAX_WINDOW_DEVIATION_BPS)
  ) {
    errors.push(`window caps over ${MAX_WINDOW_DEVIATION_BPS}`);
  }
  return errors;
}

type OnChainBank = {
  group: PublicKey;
  flags: BN;
  config: Record<keyof CbSettings, number | number[]>;
  cache: {
    lastOraclePrice: { value: number[] };
    lastOraclePriceTimestamp: BN;
  };
};

type BankAccounts = {
  fetchMultiple(keys: PublicKey[]): Promise<(OnChainBank | null)[]>;
};

type ConfigureBank = (opt: ReturnType<typeof bankConfigOpt>) => {
  accountsPartial(accounts: {
    group: PublicKey;
    admin: PublicKey;
    bank: PublicKey;
  }): { instruction(): Promise<TransactionInstruction> };
};

/**
 * Names the settings that differ from what the bank holds now, plus the enable flag.
 */
export function diffSettings(
  desired: CbSettings,
  onChain: OnChainBank,
): string[] {
  const changed: string[] = [];
  if (!onChain.flags.testn(CIRCUIT_BREAKER_ENABLED_BIT)) {
    changed.push("circuitBreakerEnabled");
  }
  for (const field of CB_FIELDS) {
    const want = desired[field];
    const have = onChain.config[field];
    const same = Array.isArray(want)
      ? Array.isArray(have) && want.every((v, i) => v === have[i])
      : want === have;
    if (!same) {
      changed.push(field);
    }
  }
  return changed;
}

function bankConfigOpt(s: CbSettings) {
  return {
    assetWeightInit: null,
    assetWeightMaint: null,
    liabilityWeightInit: null,
    liabilityWeightMaint: null,
    depositLimit: null,
    borrowLimit: null,
    operationalState: null,
    interestRateConfig: null,
    riskTier: null,
    assetTag: null,
    totalAssetValueInitLimit: null,
    oracleMaxConfidence: null,
    oracleMaxAge: null,
    permissionlessBadDebtSettlement: null,
    freezeSettings: null,
    tokenlessRepaymentsAllowed: null,
    liquidationLiquidatorFee: null,
    liquidationInsuranceFee: null,
    circuitBreakerEnabled: true,
    cbDeviationBpsTiers: s.cbDeviationBpsTiers,
    cbTierDurationsSeconds: s.cbTierDurationsSeconds,
    cbEscalationWindowMult: s.cbEscalationWindowMult,
    cbEmaAlphaBps: s.cbEmaAlphaBps,
    cbWindowSeconds: s.cbWindowSeconds,
    cbWindowMaxUpBps: s.cbWindowMaxUpBps,
    cbWindowMaxDownBps: s.cbWindowMaxDownBps,
  };
}

/**
 * Anchor encodes `BankConfigOpt` from the IDL and drops any key the IDL does not list, so an
 * older IDL would produce a configure_bank that silently sets nothing. Refuse to run on one.
 */
function idlWithCircuitBreaker() {
  const opt = marginfiIdl.types.find((t) => t.name === "BankConfigOpt");
  const fields = (opt?.type as { fields?: { name: string }[] })?.fields ?? [];
  if (!fields.some((f) => f.name === "circuit_breaker_enabled")) {
    throw new Error(
      `idl/marginfi.json (${marginfiIdl.metadata.version}) has no circuit breaker fields; refresh it from chain`,
    );
  }
  return marginfiIdl;
}

/**
 * Greedily fills txs with instructions until the next one would push the serialized size
 * over `maxBytes` or the count over `maxPerTx`. Size is measured against a placeholder
 * blockhash; it does not depend on the real one.
 */
export function packInstructions(
  instructions: TransactionInstruction[],
  payerKey: PublicKey,
  luts: AddressLookupTableAccount[],
  maxBytes = KNOWN_GOOD_TX_BYTES,
  maxPerTx = MAX_BANKS_PER_TX,
): TransactionInstruction[][] {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > PACKET_DATA_SIZE
  ) {
    throw new Error(
      `maxBytes must be an integer in [1, ${PACKET_DATA_SIZE}], got ${maxBytes}`,
    );
  }
  if (!Number.isSafeInteger(maxPerTx) || maxPerTx <= 0) {
    throw new Error(`maxPerTx must be a positive integer, got ${maxPerTx}`);
  }

  const size = (ixs: TransactionInstruction[]) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: ixs,
      }).compileToV0Message(luts),
    ).serialize().length;

  const batches: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];
  for (const ix of instructions) {
    const candidate = [...current, ix];
    if (
      current.length > 0 &&
      (candidate.length > maxPerTx || size(candidate) > maxBytes)
    ) {
      batches.push(current);
      current = [ix];
      const singleSize = size(current);
      if (singleSize > maxBytes) {
        throw new Error(
          `A single configure-bank instruction serializes to ${singleSize} bytes, ` +
            `exceeding the ${maxBytes}-byte transaction budget`,
        );
      }
    } else {
      current = candidate;
      if (current.length === 1) {
        const singleSize = size(current);
        if (singleSize > maxBytes) {
          throw new Error(
            `A single configure-bank instruction serializes to ${singleSize} bytes, ` +
              `exceeding the ${maxBytes}-byte transaction budget`,
          );
        }
      }
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

const USAGE = `Enable and configure the per-bank circuit breaker from circuit_breaker_config.json.

Usage: pnpm banks:configure-circuit-breaker [--check]

Reads each bank's on-chain state and only includes banks whose breaker flag or settings differ
from their category in the JSON. Outputs base58 v0 transactions for Squads (sendTx = false).

Options:
  --check          Report what would change without building transactions.
  --max-bytes N    Serialized bytes per tx (default ${KNOWN_GOOD_TX_BYTES}, the largest known to
                   import into Squads). Raise only after a larger tx has imported successfully.`;

function parseMaxBytes(argv: string[]): number {
  const at = argv.indexOf("--max-bytes");
  if (at < 0) {
    return KNOWN_GOOD_TX_BYTES;
  }
  const value = Number(argv[at + 1]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > PACKET_DATA_SIZE) {
    throw new Error(
      `--max-bytes must be an integer in [1, ${PACKET_DATA_SIZE}], got ${argv[at + 1]}`,
    );
  }
  return value;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const checkOnly = process.argv.includes("--check");
  const maxBytes = parseMaxBytes(process.argv);
  const targets = loadTargets(cbConfigFile);
  console.log(
    `${targets.length} banks across ${cbConfigFile.categories.length} categories`,
  );

  const user = commonSetup(sendTx, PROGRAM_ID, WALLET_PATH, ADMIN);
  const connection = user.connection;
  // Typed as the generic Idl: the full Marginfi type is too deep for ts-node to instantiate.
  const program = new Program(idlWithCircuitBreaker() as Idl, user.provider);
  const bankAccounts = program.account["bank"] as unknown as BankAccounts;
  const configureBank = program.methods[
    "lendingPoolConfigureBank"
  ] as unknown as ConfigureBank;

  const now = Math.floor(Date.now() / 1000);
  const verdicts: Verdict[] = [];

  for (const batch of chunk(targets, 100)) {
    const banks = await bankAccounts.fetchMultiple(batch.map((t) => t.bank));

    banks.forEach((bank, i) => {
      const target = batch[i];
      if (!bank) {
        verdicts.push({ target, action: "skip", reason: "account not found" });
        return;
      }
      if (!bank.group.equals(GROUP)) {
        verdicts.push({
          target,
          action: "skip",
          reason: `wrong group ${bank.group.toBase58()}; admin would not match`,
        });
        return;
      }
      if (bank.flags.testn(FREEZE_SETTINGS_BIT)) {
        verdicts.push({
          target,
          action: "skip",
          reason:
            "FREEZE_SETTINGS is set; configure_bank would succeed and ignore this",
        });
        return;
      }
      const changed = diffSettings(target.settings, bank);
      if (changed.length === 0) {
        verdicts.push({ target, action: "skip", reason: "already matches" });
        return;
      }
      const enabling = changed.includes("circuitBreakerEnabled");
      verdicts.push({
        target,
        action: enabling ? "enable" : "update",
        reason: changed.join(", "),
        cacheAgeSeconds: enabling
          ? now - bank.cache.lastOraclePriceTimestamp.toNumber()
          : undefined,
        cachePricePositive: enabling
          ? wrappedI80F48toBigNumber(bank.cache.lastOraclePrice).isGreaterThan(
              0,
            )
          : undefined,
        switchboard: Object.keys(bank.config.oracleSetup)[0]
          ?.toLowerCase()
          .includes("switchboard"),
      });
    });
  }

  report(verdicts);

  const todo = verdicts.filter((v) => v.action !== "skip");
  if (checkOnly || todo.length === 0) {
    return;
  }

  const luts: AddressLookupTableAccount[] = [];
  for (const key of LUTS) {
    const lookup = await connection.getAddressLookupTable(key);
    if (lookup.value) {
      luts.push(lookup.value);
    } else {
      console.warn(`LUT ${key.toBase58()} not found; proceeding without it`);
    }
  }
  const inLut = (key: PublicKey) =>
    luts.some((lut) => lut.state.addresses.some((a) => a.equals(key)));
  const uncovered = todo.filter((v) => !inLut(v.target.bank)).length;
  console.log(`LUTs cover ${todo.length - uncovered} of ${todo.length} banks`);
  if (uncovered > 0) {
    console.log(
      "An uncovered bank costs 32 bytes instead of 1; extend a LUT with them to fit more per tx.",
    );
  }

  const payerKey = sendTx ? user.wallet.publicKey : ADMIN;
  const groups = [
    todo.filter((v) => !v.switchboard),
    todo.filter((v) => v.switchboard),
  ];
  const ordered = groups.flat();
  const batches: TransactionInstruction[][] = [];
  for (const group of groups) {
    const instructions: TransactionInstruction[] = [];
    for (const v of group) {
      instructions.push(
        await configureBank(bankConfigOpt(v.target.settings))
          .accountsPartial({ group: GROUP, admin: ADMIN, bank: v.target.bank })
          .instruction(),
      );
    }
    batches.push(...packInstructions(instructions, payerKey, luts, maxBytes));
  }
  console.log(
    `\n${batches.length} tx(s), max ${maxBytes} bytes / ${MAX_BANKS_PER_TX} banks each`,
  );

  let cursor = 0;
  for (const [i, ixs] of batches.entries()) {
    const members = ordered.slice(cursor, cursor + ixs.length);
    cursor += ixs.length;
    const note = members.some((v) => v.switchboard)
      ? " [switchboard: crank within 30s of execution]"
      : "";

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash();
    const v0Tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message(luts),
    );
    const bytes = v0Tx.serialize().length;
    if (bytes > maxBytes) {
      throw new Error(
        `Internal packing error: tx ${i + 1} is ${bytes} bytes, over the ${maxBytes} byte budget`,
      );
    }
    console.log(
      `\ntx ${i + 1}/${batches.length}: ${ixs.length} banks, ${bytes} bytes: ${members
        .map((v) => v.target.entry.symbol)
        .join(", ")}${note}`,
    );

    if (sendTx) {
      v0Tx.sign([(user.wallet as any).payer]);
      const signature = await connection.sendTransaction(v0Tx, {
        maxRetries: 2,
      });
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      console.log("tx signature:", signature);
    } else {
      console.log("Base58-encoded transaction:", bs58.encode(v0Tx.serialize()));
    }
  }
}

function report(verdicts: Verdict[]) {
  const width = Math.max(...verdicts.map((v) => v.target.entry.symbol.length));
  for (const v of verdicts) {
    const oracle = v.switchboard ? " [switchboard]" : "";
    console.log(
      `[${v.action.padEnd(6)}] ${v.target.entry.symbol.padEnd(width)} ${v.target.bank.toBase58()}  ${v.target.category}: ${v.reason}${oracle}`,
    );
  }

  const counts = { enable: 0, update: 0, skip: 0 };
  for (const v of verdicts) counts[v.action]++;
  console.log(
    `\nenable ${counts.enable}, update ${counts.update}, skip ${counts.skip}`,
  );

  const cold = verdicts.filter(
    (v) =>
      v.cacheAgeSeconds !== undefined &&
      (v.cacheAgeSeconds < 0 ||
        v.cacheAgeSeconds > CB_ENABLE_MAX_PRICE_AGE_SECONDS ||
        v.cachePricePositive === false),
  );
  if (cold.length > 0) {
    console.warn(
      `\nWARNING: ${cold.length} bank(s) being enabled do not currently satisfy the warm-cache gate ` +
        `(positive price and age 0-${CB_ENABLE_MAX_PRICE_AGE_SECONDS}s). Enabling reverts with ` +
        "CircuitBreakerRequiresWarmCache unless the keeper pulses them before the tx executes.",
    );
  }

  const switchboard = verdicts.filter((v) => v.action === "enable" && v.switchboard);
  if (switchboard.length > 0) {
    console.warn(
      `${switchboard.length} of them price from Switchboard pull feeds, which the keeper only cranks ` +
        "for breaker-enabled banks; crank those feeds within the same window or their tx reverts.",
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
