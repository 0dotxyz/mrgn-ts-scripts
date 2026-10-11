import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { registerJuplendProgram, registerKaminoProgram } from "./common-setup";
import { KLEND_PROGRAM_ID } from "../scripts/kamino/kamino-types";
import { simpleRefreshReserve } from "../scripts/kamino/ixes-common";
import {
  JUPLEND_LENDING_PROGRAM_ID,
  makeJuplendNativeUpdateRateIx,
} from "../scripts/juplend/lib/utils";

/**
 * Venue accounts a health check prices in Live mode, which must be refreshed in the same slot:
 * every Kamino reserve and JupLend lending state behind an active position.
 */
export type VenueRefresh = {
  KAMINO_RESERVES?: PublicKey[];
  JUPLEND_STATES?: PublicKey[];
};

export async function venueRefreshIxs(
  user: any,
  refresh: VenueRefresh,
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];

  if (refresh.KAMINO_RESERVES?.length) {
    if (!user.kaminoProgram) registerKaminoProgram(user, KLEND_PROGRAM_ID.toString());
    for (const reserve of refresh.KAMINO_RESERVES) {
      const reserveAcc = await user.kaminoProgram.account.reserve.fetch(reserve);
      ixs.push(
        await simpleRefreshReserve(
          user.kaminoProgram,
          reserve,
          reserveAcc.lendingMarket,
          reserveAcc.config.tokenInfo.scopeConfiguration.priceFeed,
        ),
      );
    }
  }

  if (refresh.JUPLEND_STATES?.length) {
    if (!user.juplendProgram) {
      registerJuplendProgram(user, JUPLEND_LENDING_PROGRAM_ID.toString());
    }
    for (const lending of refresh.JUPLEND_STATES) {
      ixs.push(await makeJuplendNativeUpdateRateIx(user.juplendProgram, lending));
    }
  }

  return ixs;
}
