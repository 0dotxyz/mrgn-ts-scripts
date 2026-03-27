import { OperationalStateRaw, RiskTierRaw } from "@mrgnlabs/marginfi-client-v2";
import { WrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { PublicKey } from "@solana/web3.js";
import { I80F48_ONE, PYTH_PULL_MIGRATED } from "../utils/utils";
import { BN } from "@coral-xyz/anchor";

export const KLEND_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
export const FARMS_PROGRAM_ID = new PublicKey(
  "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr"
);

export type OracleSetupRawWithKamino =
  | { none: {} }
  | { pythLegacy: {} }
  | { switchboardV2: {} }
  | { pythPushOracle: {} }
  | { switchboardPull: {} }
  | { stakedWithPythPush: {} }
  | { kaminoPythPush: {} }
  | { kaminoSwitchboardPull: {} };

export type KaminoConfigCompact = {
  oracle: PublicKey;
  assetWeightInit: WrappedI80F48;
  assetWeightMaint: WrappedI80F48;
  depositLimit: BN;
  oracleSetup: OracleSetupRawWithKamino;
  /** Paused = 0, Operational = 1, ReduceOnly = 2 */
  operationalState: OperationalStateRaw;
  /** Collateral = 0, Isolated = 1 */
  riskTier: RiskTierRaw;
  configFlags: number;
  totalAssetValueInitLimit: BN;
  oracleMaxAge: number;
  /** A u32, e.g. for 100% pass u32::MAX */
  oracleMaxConfidence: number;
};

export const defaultKaminoBankConfig = (
  oracle: PublicKey
): KaminoConfigCompact => {
  let config: KaminoConfigCompact = {
    oracle: oracle,
    assetWeightInit: I80F48_ONE,
    assetWeightMaint: I80F48_ONE,
    depositLimit: new BN(10000000000000),
    oracleSetup: {
      kaminoPythPush: {},
    },
    operationalState: { operational: {} },
    riskTier: { collateral: {} },
    configFlags: PYTH_PULL_MIGRATED,
    totalAssetValueInitLimit: new BN(1000000000000),
    oracleMaxAge: 100,
    oracleMaxConfidence: 0, // Use default 10%
  };
  return config;
};
