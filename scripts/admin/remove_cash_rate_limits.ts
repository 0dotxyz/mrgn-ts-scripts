import { assetGroups } from "../meta/asset_groups";
import { removeRateLimits } from "./remove_rate_limits";

// CASH stablecoin mint (matches all CASH banks in the group, any venue).
const CASH_MINTS = new Set<string>([assetGroups.stablecoins.CASH]);

if (require.main === module) {
  removeRateLimits("CASH", CASH_MINTS).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
