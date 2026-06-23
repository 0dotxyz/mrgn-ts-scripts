import { assetGroups } from "../meta/asset_groups";
import { removeRateLimits } from "./remove_rate_limits";

// Every Pendle PT mint.
const PT_MINTS = new Set<string>(Object.values(assetGroups["rate-products"]));

if (require.main === module) {
  removeRateLimits("PT", PT_MINTS).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
