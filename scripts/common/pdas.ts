import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

export const deriveLiquidityVaultAuthority = (
  programId: PublicKey,
  bank: PublicKey,
) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault_auth", "utf-8"), bank.toBuffer()],
    programId,
  );
};

export const deriveLiquidityVault = (programId: PublicKey, bank: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_vault", "utf-8"), bank.toBuffer()],
    programId,
  );
};

export const deriveJuplendFTokenVault = (
  programId: PublicKey,
  bank: PublicKey,
) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("f_token_vault", "utf-8"), bank.toBuffer()],
    programId,
  );
};

export const deriveInsuranceVaultAuthority = (
  programId: PublicKey,
  bank: PublicKey,
) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("insurance_vault_auth", "utf-8"), bank.toBuffer()],
    programId,
  );
};

export const deriveInsuranceVault = (programId: PublicKey, bank: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("insurance_vault", "utf-8"), bank.toBuffer()],
    programId,
  );
};

export const deriveFeeVaultAuthority = (
  programId: PublicKey,
  bank: PublicKey,
) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault_auth", "utf-8"), bank.toBuffer()],
    programId,
  );
};

export const deriveFeeVault = (programId: PublicKey, bank: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee_vault", "utf-8"), bank.toBuffer()],
    programId,
  );
};

export const deriveEmissionsAuth = (
  programId: PublicKey,
  bank: PublicKey,
  mint: PublicKey,
) => {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("emissions_auth_seed", "utf-8"),
      bank.toBuffer(),
      mint.toBuffer(),
    ],
    programId,
  );
};

export const deriveEmissionsTokenAccount = (
  programId: PublicKey,
  bank: PublicKey,
  mint: PublicKey,
) => {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("emissions_token_account_seed", "utf-8"),
      bank.toBuffer(),
      mint.toBuffer(),
    ],
    programId,
  );
};

export const deriveBankWithSeed = (
  programId: PublicKey,
  group: PublicKey,
  bankMint: PublicKey,
  seed: BN,
) => {
  return PublicKey.findProgramAddressSync(
    [group.toBuffer(), bankMint.toBuffer(), seed.toArrayLike(Buffer, "le", 8)],
    programId,
  );
};

export const deriveStakedSettings = (
  programId: PublicKey,
  group: PublicKey,
) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("staked_settings", "utf-8"), group.toBuffer()],
    programId,
  );
};

export const deriveLiquidationRecord = (
  programId: PublicKey,
  marginfiAccount: PublicKey
) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liq_record", "utf-8"), marginfiAccount.toBuffer()],
    programId
  );
};

export const SPL_SINGLE_POOL_PROGRAM_ID = new PublicKey(
  "SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE",
);

/** SVSP keys for a validator, matching `derive_single_pool_keys_from_vote`. */
export const deriveSinglePoolKeys = (voteAccount: PublicKey) => {
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), voteAccount.toBuffer()],
    SPL_SINGLE_POOL_PROGRAM_ID,
  );
  const derive = (seed: string) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from(seed), pool.toBuffer()],
      SPL_SINGLE_POOL_PROGRAM_ID,
    )[0];
  return {
    pool,
    lstMint: derive("mint"),
    solPool: derive("stake"),
    onramp: derive("onramp"),
  };
};

/** The on-ramp stake account for an SVSP pool (`derive_staked_onramp_from_vote`'s last element). */
export const deriveStakedOnrampFromPool = (stakePool: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("onramp"), stakePool.toBuffer()],
    SPL_SINGLE_POOL_PROGRAM_ID,
  )[0];
};
