import {
  PublicKey,
} from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";
import { deriveStakedSettings } from "../common/pdas";

const verbose = true;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
};

async function main() {
  const user = commonSetup(
    true,
    config.PROGRAM_ID,
    "/keys/staging-deploy.json",
    undefined
  );
  const program = user.program;

  let [stakedSettingsKey] = deriveStakedSettings(
    program.programId,
    config.GROUP,
  );

  let settings = await program.account.stakedSettings.fetch(stakedSettingsKey);

  console.log("key: " + settings.key);
  console.log("group: " + settings.marginfiGroup);
  console.log(
    "weight init: " + wrappedI80F48toBigNumber(settings.assetWeightInit),
  );
  console.log(
    "weight maint: " + wrappedI80F48toBigNumber(settings.assetWeightMaint),
  );
  console.log("deposit limit: " + settings.depositLimit.toNumber());
  console.log("oracle: " + settings.oracle);
  console.log("oracle age: " + settings.oracleMaxAge);
  // console.log("curve: " + settings.); //.....
  console.log("init limit: " + settings.totalAssetValueInitLimit);
  console.log("risk tier: " + JSON.stringify(settings.riskTier));
}

main().catch((err) => {
  console.error(err);
});
