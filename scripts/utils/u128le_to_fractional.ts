type Config = {
  NUM: bigint;
};

const config: Config = {
  NUM: BigInt(21110623253299),
};

async function main() {
  // Define the constant 2^48 as a BigInt.
  const fractionalDenom = 1n << 48n; // 2^48 = 281474976710656
  // Compute the fractional bits using modulo operation.
  const fractionalBits = config.NUM % fractionalDenom;
  // Convert the fractional bits to a normalized fraction.
  // Note: Since fractionalDenom is less than Number.MAX_SAFE_INTEGER, this conversion is safe.
  let fraction = Number(fractionalBits) / Number(fractionalDenom);
  console.log("fractional part: " + fraction);

  const wholeDenom = config.NUM >> 48n;
  let whole = Number(wholeDenom);
  console.log("whole part: " + whole);
  console.log("Value actually is: " + (whole + fraction));
}

main().catch((err) => {
  console.error(err);
});
