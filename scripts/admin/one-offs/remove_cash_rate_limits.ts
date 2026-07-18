import { CASH_MINTS } from "../utils/rate_limits";
import { removeRateLimits } from "./remove_rate_limits";

if (require.main === module) {
  removeRateLimits("CASH", CASH_MINTS).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
