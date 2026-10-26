import assert from "assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  AnchorProvider,
  BN,
  BorshInstructionCoder,
  Idl,
  Program,
} from "@coral-xyz/anchor";
import { PACKET_DATA_SIZE, PublicKey, Transaction } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import marginfiIdl from "../../idl/marginfi.json";
import { addBank, ORACLE_TYPE_SCOPE } from "./add_bank";

const common = require("../../lib/common-setup");
const config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP_KEY: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  MULTISIG_PAYER: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  BANK_MINT: new PublicKey("USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk"),
  ORACLE: new PublicKey("AMjqm5S4QaAHWLv52jJiRpFNW1qo23F6ZM5ChCF5tYgc"),
  ORACLE_TYPE: ORACLE_TYPE_SCOPE,
  SCOPE_ENTRY_INDEX: 60,
  SEED: 0,
  CLONE_FROM: new PublicKey("9p1TiAeTc6FSiNHhnR6BgmwRq49zywczAY4m77BbKGer"),
  CLONE_BREAKER_FROM: new PublicKey("Dj2CwMF3GM7mMT5hcyGXKuYSQ2kQ5zaVCkA1zX1qaTva"),
};
const settings = {
  cbDeviationBpsTiers: [50, 100, 200],
  cbTierDurationsSeconds: [600, 1800, 7200],
  cbEscalationWindowMult: 2,
  cbEmaAlphaBps: 1000,
  cbWindowSeconds: 86400,
  cbWindowMaxUpBps: 300,
  cbWindowMaxDownBps: 300,
};

describe("add bank circuit breaker clone", () => {
  let program: Program;
  let coder: BorshInstructionCoder;
  let sourceEnabled: boolean;
  let sourceFetches: number;
  let logs: unknown[][];
  const originalSetup = common.commonSetup;
  const originalLog = console.log;

  beforeEach(() => {
    sourceEnabled = true;
    sourceFetches = 0;
    logs = [];
    console.log = (...args) => logs.push(args);
    const connection = {
      getAccountInfo: async () => null,
      getLatestBlockhash: async () => ({
        blockhash: PublicKey.default.toBase58(),
      }),
    };
    program = new Program(
      { ...marginfiIdl, address: config.PROGRAM_ID } as Idl,
      { connection } as unknown as AnchorProvider,
      undefined,
      () => async ({ accounts, idlIx }) => {
        // Supply accounts normally resolved from existing on-chain group/fee state.
        let resolved = 0;
        for (const [name, key] of Object.entries({
          group: config.GROUP_KEY,
          globalFeeWallet: PublicKey.default,
        })) {
          if (idlIx.accounts.some((a) => a.name === name) && !accounts[name]) {
            accounts[name] = key;
            resolved++;
          }
        }
        return { accounts, resolved };
      },
    );
    coder = program.coder.instruction as BorshInstructionCoder;
    program.account["bank"].fetch = async (address) => {
      assert.equal(address.toString(), config.CLONE_BREAKER_FROM.toBase58());
      sourceFetches++;
      return {
        flags: new BN(sourceEnabled ? 1 << 11 : 0),
        config: settings,
      } as any;
    };
    common.commonSetup = () => ({ program, connection });
  });

  afterEach(() => {
    common.commonSetup = originalSetup;
    console.log = originalLog;
  });

  function output(label: string): Transaction {
    const encoded = logs.find((args) => args[0] === label)?.[1];
    assert.equal(typeof encoded, "string", `Missing output: ${label}`);
    const bytes = bs58.decode(encoded as string);
    assert.ok(bytes.length <= PACKET_DATA_SIZE);
    return Transaction.from(bytes);
  }

  it("outputs a separate pulse/configure tx and preserves the creation tx", async () => {
    await addBank(false, config, "", true, false);
    const baseline = output("Base58-encoded transaction:");
    logs = [];
    const bank = await addBank(false, config, "", true, true);
    const creation = output("Base58-encoded transaction:");
    const breaker = output("Base58-encoded circuit breaker transaction:");
    assert.deepEqual(creation.serializeMessage(), baseline.serializeMessage());
    assert.equal(sourceFetches, 1);
    assert.equal(breaker.instructions.length, 2);
    const pulse = breaker.instructions[0];
    assert.equal(
      coder.decode(pulse.data)?.name,
      "lendingPoolPulseBankPriceCache",
    );
    assert.ok(pulse.keys.some((key) => key.pubkey.equals(config.ORACLE)));
    const configure = breaker.instructions[1];
    assert.ok(configure.keys.some((key) => key.pubkey.equals(bank)));
    const decoded = coder.decode(configure.data)!;
    assert.equal(decoded.name, "lendingPoolConfigureBank");
    const copied = (decoded.data as any).bankConfigOpt;
    for (const [key, value] of Object.entries(settings)) {
      assert.deepEqual(copied[key], value);
    }
    assert.equal(copied.circuitBreakerEnabled, true);
    for (const [key, value] of Object.entries(copied)) {
      if (!(key in settings) && key !== "circuitBreakerEnabled") {
        assert.equal(value, null, `Unrelated setting changed: ${key}`);
      }
    }
  });

  it("copies a disabled breaker without adding a price-cache pulse", async () => {
    sourceEnabled = false;
    await addBank(false, config, "", false, true);
    const breaker = output("Base58-encoded circuit breaker transaction:");
    assert.equal(breaker.instructions.length, 1);
    const decoded = coder.decode(breaker.instructions[0].data)!;
    assert.equal((decoded.data as any).bankConfigOpt.circuitBreakerEnabled, false);
  });

  it("skips fetching and breaker output by default", async () => {
    await addBank(false, { ...config, CLONE_BREAKER_FROM: undefined }, "");
    assert.equal(sourceFetches, 0);
    assert.ok(
      !logs.some((args) => args[0] === "Base58-encoded circuit breaker transaction:"),
    );
  });

  it("requires a source when cloning is enabled", async () => {
    await assert.rejects(
      addBank(false, { ...config, CLONE_BREAKER_FROM: undefined }, "", false, true),
      /CLONE_BREAKER_FROM must be set/,
    );
    assert.equal(sourceFetches, 0);
  });
});
