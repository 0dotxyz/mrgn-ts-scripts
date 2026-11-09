import { unwind } from "./unwind_liquidatable_user_e2e";

/**
 * Empties every liquidatee of the last create_liquidatable_user_e2e.ts run (repays its debt and
 * withdraws its collateral) but keeps the group, banks and liquidator, so the next create run
 * reuses them instead of paying for a new group and 21 banks. The liquidatees go to
 * liquidatees_pending_closing.txt, like after a full unwind.
 */
unwind(true).catch((err) => {
  console.error(err);
});
