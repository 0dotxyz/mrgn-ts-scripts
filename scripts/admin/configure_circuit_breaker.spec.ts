import { expect } from "chai";
import { describe, it } from "mocha";
import {
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  CbSettings,
  packInstructions,
  validateSettings,
} from "./configure_circuit_breaker";

const PAYER = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");
const PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA");

const validSettings: CbSettings = {
  cbDeviationBpsTiers: [100, 200, 300],
  cbTierDurationsSeconds: [60, 120, 180],
  cbWindowMaxUpBps: 500,
  cbWindowMaxDownBps: 500,
  cbWindowSeconds: 3600,
  cbEscalationWindowMult: 2,
  cbEmaAlphaBps: 1000,
};

function instruction(dataBytes: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: [],
    data: Buffer.alloc(dataBytes),
  });
}

function serializedBytes(ixs: TransactionInstruction[]): number {
  const message = new TransactionMessage({
    payerKey: PAYER,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize().length;
}

describe("configure circuit breaker", () => {
  it("rejects fractional and negative unsigned settings", () => {
    expect(validateSettings({ ...validSettings, cbWindowMaxUpBps: 0.5 })).not.to
      .be.empty;
    expect(validateSettings({ ...validSettings, cbWindowSeconds: -1 })).not.to
      .be.empty;
  });

  it("keeps every batch within both byte and instruction limits", () => {
    const budget = 500;
    const maxPerTx = 3;
    const batches = packInstructions(
      Array.from({ length: 10 }, () => instruction(80)),
      PAYER,
      [],
      budget,
      maxPerTx,
    );

    expect(batches.flat()).to.have.length(10);
    for (const batch of batches) {
      expect(batch.length).to.be.at.most(maxPerTx);
      expect(serializedBytes(batch)).to.be.at.most(budget);
      expect(serializedBytes(batch)).to.be.at.most(PACKET_DATA_SIZE);
    }
  });

  it("rejects a single instruction that exceeds the byte budget", () => {
    expect(() =>
      packInstructions([instruction(600)], PAYER, [], 500, 8),
    ).to.throw("single configure-bank instruction");
  });
});
