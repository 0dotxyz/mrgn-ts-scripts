import { PublicKey } from "@solana/web3.js";
import { reduceOnlyBanks } from "./bank_reduce";

/** BONK bank in the main group (mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263) */
const BONK_BANK = new PublicKey("DeyH7QxWvnbbaVB4zFrf4hoq7Q8z1ZT14co42BGwGtfM");

reduceOnlyBanks([BONK_BANK]).catch((err) => {
  console.error(err);
});
