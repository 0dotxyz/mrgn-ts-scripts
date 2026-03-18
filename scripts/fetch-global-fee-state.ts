import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/.config/solana/id.json",
    undefined,
  );
  const program = user.program;

  const [feeStateKey] = deriveGlobalFeeState(program.programId);
  const gfs = await program.account.feeState.fetch(feeStateKey);
  console.log("***Fee state***");
  console.log(" admin:        " + gfs.globalFeeAdmin);
  console.log(" wallet:       " + gfs.globalFeeWallet);
  console.log(" flat (banks): " + gfs.bankInitFlatSolFee);
  console.log(" flat (liq)):  " + gfs.liquidationFlatSolFee);
  console.log(
    " fixed:        " + wrappedI80F48toBigNumber(gfs.programFeeFixed),
  );
  console.log(" rate          " + wrappedI80F48toBigNumber(gfs.programFeeRate));
  console.log(
    " liq max       " + wrappedI80F48toBigNumber(gfs.liquidationMaxFee),
  );
}

// TODO remove after package updates
const deriveGlobalFeeState = (programId: PublicKey) => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("feestate", "utf-8")],
    programId,
  );
};

main().catch((err) => {
  console.error(err);
});
