import { PublicKey } from "@solana/web3.js";
import { reduceOnlyBanks } from "./bank_reduce";

/** WIF (dogwifhat) bank in the main group (mint EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm) */
const WIF_BANK = new PublicKey("9dpu8KL5ABYiD3WP2Cnajzg1XaotcJvZspv29Y1Y3tn1");

reduceOnlyBanks([WIF_BANK]).catch((err) => {
  console.error(err);
});
