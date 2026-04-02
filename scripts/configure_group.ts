import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../lib/common-setup";
import BN from "bn.js";
import { bigNumberToWrappedI80F48, WrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { utilToU32 } from "../lib/utils";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  GROUP: PublicKey;
  ADMIN_GENERAL?: PublicKey;
  EMODE_ADMIN?: PublicKey;
  CURVE_ADMIN?: PublicKey;
  FLOW_ADMIN?: PublicKey;
  LIMIT_ADMIN?: PublicKey;
  EMISS_ADMIN?: PublicKey;
  META_ADMIN?: PublicKey;
  RISK_ADMIN?: PublicKey;
  EMODE_MAX_INIT_LEVERAGE?: WrappedI80F48;
  EMODE_MAX_MAINT_LEVERAGE?: WrappedI80F48;

  MULTISIG?: PublicKey;
};

// const config: Config = {
//   PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
//   GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
//   ADMIN_GENERAL: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
//   EMODE_ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
//   CURVE_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
//   LIMIT_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
//   EMISS_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
//   META_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
//   RISK_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),

//   MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
// };

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  GROUP: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
  // ADMIN_GENERAL: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  // EMODE_ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  // CURVE_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
  // FLOW_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
  // LIMIT_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
  // EMISS_ADMIN: new PublicKey("BACjgGYJYwVRRpnHJfcjykfkp2Xu118ghx5fYL1wgY7p"),
  // META_ADMIN: new PublicKey("B2QBNiT857wyU56jffuy5i7YPpLC9eUwJ99CzJt52RN9"),
  RISK_ADMIN: new PublicKey("CNHBsXx4pej97awWEWijwZN2SRboA784zonUy1Cxs6cP"),
  // EMODE_MAX_INIT_LEVERAGE: bigNumberToWrappedI80F48(20),
  // EMODE_MAX_MAINT_LEVERAGE: bigNumberToWrappedI80F48(40),

  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/.keys/zerotrade_admin.json",
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;
  if (config.ADMIN_GENERAL) {
    console.log("setting admin to: " + config.ADMIN_GENERAL.toString());
  }
  if (config.EMODE_ADMIN) {
    console.log("setting emode admin to: " + config.EMODE_ADMIN.toString());
  }
  if (config.CURVE_ADMIN) {
    console.log("setting curve admin to: " + config.CURVE_ADMIN.toString());
  }
  if (config.FLOW_ADMIN) {
    console.log("setting flow admin to: " + config.FLOW_ADMIN.toString());
  }
  if (config.LIMIT_ADMIN) {
    console.log("setting limit admin to: " + config.LIMIT_ADMIN.toString());
  }
  if (config.EMISS_ADMIN) {
    console.log("setting emiss admin to: " + config.EMISS_ADMIN.toString());
  }
  if (config.META_ADMIN) {
    console.log("setting meta admin to: " + config.META_ADMIN.toString());
  }
  if (config.RISK_ADMIN) {
    console.log("setting risk admin to: " + config.RISK_ADMIN.toString());
  }

  let groupBefore = await program.account.marginfiGroup.fetch(config.GROUP);
  console.log("Current risk admin:", groupBefore.riskAdmin.toString());

  const transaction = new Transaction();
  transaction.add(
    await program.methods
      .marginfiGroupConfigure(
        config.ADMIN_GENERAL ?? groupBefore.admin,
        config.EMODE_ADMIN ?? groupBefore.emodeAdmin,
        config.CURVE_ADMIN ?? groupBefore.delegateCurveAdmin,
        config.FLOW_ADMIN ?? groupBefore.delegateFlowAdmin,
        config.LIMIT_ADMIN ?? groupBefore.delegateLimitAdmin,
        config.EMISS_ADMIN ?? groupBefore.delegateEmissionsAdmin,
        config.META_ADMIN ?? groupBefore.metadataAdmin,
        config.RISK_ADMIN ?? groupBefore.riskAdmin,
        config.EMODE_MAX_INIT_LEVERAGE ?? null,
        config.EMODE_MAX_MAINT_LEVERAGE ?? null,
      )
      .accounts({
        marginfiGroup: config.GROUP,
      })
      .instruction(),
  );

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(
        connection,
        transaction,
        [user.wallet.payer],
      );
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }

    let groupAfter = await program.account.marginfiGroup.fetch(config.GROUP);
    console.log("Group " + config.GROUP);
    console.log("new admin: " + groupAfter.admin + " was " + groupBefore.admin);
    console.log(
      "new emode admin: " +
        groupAfter.emodeAdmin +
        " was " +
        groupBefore.emodeAdmin,
    );
    console.log(
      "new curve admin: " +
        groupAfter.delegateCurveAdmin +
        " was " +
        groupBefore.delegateCurveAdmin,
    );
    console.log(
      "new curve admin: " +
        groupAfter.delegateFlowAdmin +
        " was " +
        groupBefore.delegateFlowAdmin,
    );
    console.log(
      "new limit admin: " +
        groupAfter.delegateLimitAdmin +
        " was " +
        groupBefore.delegateLimitAdmin,
    );
    console.log(
      "new emiss admin: " +
        groupAfter.delegateEmissionsAdmin +
        " was " +
        groupBefore.delegateEmissionsAdmin,
    );
    console.log(
      "new meta admin: " +
        groupAfter.metadataAdmin +
        " was " +
        groupBefore.metadataAdmin,
    );
    console.log(
      "new risk admin: " +
        groupAfter.riskAdmin +
        " was " +
        groupBefore.riskAdmin,
    );
  } else {
    transaction.feePayer = config.MULTISIG;
    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base58Transaction = bs58.encode(serializedTransaction);
    console.log("Base58-encoded transaction:", base58Transaction);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
