import { PublicKey } from "@solana/web3.js";
import { reduceOnlyBanks } from "./bank_reduce";

/** BONK bank in the main group (mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263) */
const BONK_BANK = new PublicKey("DeyH7QxWvnbbaVB4zFrf4hoq7Q8z1ZT14co42BGwGtfM");
/** WIF (dogwifhat) bank in the main group (mint EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm) */
const WIF_BANK = new PublicKey("9dpu8KL5ABYiD3WP2Cnajzg1XaotcJvZspv29Y1Y3tn1");

reduceOnlyBanks([BONK_BANK, WIF_BANK], true).catch((err) => {
  console.error(err);
});
