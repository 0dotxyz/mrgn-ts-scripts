import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export function decodePriceUpdateV2(buffer: Buffer): PriceUpdateV2 {
  //const buffer = Buffer.from(base64Data, "base64");
  let offset = 0;

  const discrim = buffer.subarray(offset, offset + 8);
  // console.log("discrim (expect 34 241 35 99 157 126 244 205)");
  // console.log("actual: " + JSON.stringify(discrim));
  offset += 8;

  // 1. write_authority (32 bytes)
  const write_authority = new PublicKey(buffer.subarray(offset, offset + 32));
  offset += 32;

  // 2. verification_level (2 bytes)
  const verTag = buffer.readUInt8(offset);
  offset += 1;
  let verification_level: VerificationLevel;
  if (verTag === 0) {
    // "Partial" variant: the next byte is the num_signatures.
    const num_signatures = buffer.readUInt8(offset);
    offset += 1;
    verification_level = { kind: "Partial", num_signatures };
  } else if (verTag === 1) {
    // "Full" variant: the next byte is NOT SKIPPED, it is just one byte shorter!
    // offset += 1;
    verification_level = { kind: "Full" };
  } else {
    throw new Error(`Unknown verification level tag: ${verTag}`);
  }

  // 3. PriceFeedMessage
  // - feed_id: 32 bytes
  const feed_id = new PublicKey(buffer.subarray(offset, offset + 32));
  // console.log("feed id: " + feed_id);
  offset += 32;
  // - price: i64 (8 bytes, little-endian)
  const priceBN = new BN(buffer.subarray(offset, offset + 8), "le");
  offset += 8;
  // - conf: u64 (8 bytes)
  const conf = new BN(buffer.subarray(offset, offset + 8), "le");
  offset += 8;
  // - exponent: i32 (4 bytes)
  const exponent = buffer.readInt32LE(offset);
  offset += 4;
  // - publish_time: i64 (8 bytes)
  const publishTimeBN = new BN(buffer.subarray(offset, offset + 8), "le");
  offset += 8;
  // - prev_publish_time: i64 (8 bytes)
  const prevPublishTimeBN = new BN(buffer.subarray(offset, offset + 8), "le");
  offset += 8;
  // - ema_price: i64 (8 bytes)
  const emaPriceBN = new BN(buffer.subarray(offset, offset + 8), "le");
  offset += 8;
  // - ema_conf: u64 (8 bytes)
  const ema_conf = new BN(buffer.subarray(offset, offset + 8), "le");
  offset += 8;

  const price_message: PriceFeedMessage = {
    feed_id,
    price: priceBN,
    conf,
    exponent,
    publish_time: publishTimeBN,
    prev_publish_time: prevPublishTimeBN,
    ema_price: emaPriceBN,
    ema_conf,
  };

  // 4. posted_slot: u64 (8 bytes)
  const posted_slot = new BN(buffer.subarray(offset, offset + 8), "le");
  offset += 8;

  return {
    write_authority,
    verification_level,
    price_message,
    posted_slot,
  };
}

type VerificationLevel =
  | { kind: "Partial"; num_signatures: number }
  | { kind: "Full" };

export interface PriceUpdateV2 {
  write_authority: PublicKey; // 32 bytes
  verification_level: VerificationLevel; // 2 bytes (1 byte tag + 1 byte value/padding)
  price_message: PriceFeedMessage; // 84 bytes
  posted_slot: BN; // u64 (8 bytes)
}

interface PriceFeedMessage {
  feed_id: PublicKey; // 32 bytes
  price: BN; // i64
  conf: BN; // u64
  exponent: number; // i32
  publish_time: BN; // i64 (timestamp in seconds)
  prev_publish_time: BN; // i64
  ema_price: BN; // i64
  ema_conf: BN; // u64
}
