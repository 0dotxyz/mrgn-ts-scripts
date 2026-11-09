import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { bigNumberToWrappedI80F48 } from "@mrgnlabs/mrgn-common";
import { commonSetup } from "../../lib/common-setup";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = false;

/**
 * `lending_pool_configure_bank_gov` (0.1.12, governance admin): the risk-increasing half of the old
 * `lending_pool_configure_bank`. Weights, risk tier, asset tag, oracle max age/confidence and
 * returning a bank to Operational live here; limits, rates, fees and circuit breakers stay on
 * `lending_pool_configure_bank` (see config_bank.ts). Unset fields are left unchanged.
 */
export type BankConfigGovUpdate = {
  assetWeightInit?: number;
  assetWeightMaint?: number;
  liabilityWeightInit?: number;
  liabilityWeightMaint?: number;
  oracleMaxAge?: number;
  tokenlessRepaymentsAllowed?: boolean;
};

export type BankGovEntry = {
  bank: PublicKey;
  update: BankConfigGovUpdate;
};

type Config = {
  PROGRAM_ID: string;
  BANKS: BankGovEntry[];
  /**
   * Groups start without a governance admin. If set and the group has none yet, the first tx
   * bootstraps it (signed by the group admin) before the updates, which it then signs.
   */
  BOOTSTRAP_GOVERNANCE_ADMIN?: PublicKey;
  MULTISIG?: PublicKey; // May be omitted if not using squads
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANKS: [
    {
      bank: new PublicKey("FWZbU8TSPyjyrWQASzujo7FjgF9f3GEkjaFAtbKWqjMH"), // sUSD
      update: { tokenlessRepaymentsAllowed: true },
    },
  ],
  BOOTSTRAP_GOVERNANCE_ADMIN: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

/** Banks per transaction; each instruction is small, this just keeps long lists under 1232 bytes. */
const BANKS_PER_TX = 6;

async function main() {
  await configBankGov(sendTx, config, "/keys/staging-deploy.json");
}

export async function configBankGov(
  sendTx: boolean,
  config: Config,
  walletPath: string,
) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;
  const wrap = (v?: number) =>
    v === undefined ? null : bigNumberToWrappedI80F48(v);

  const groupKey = (await program.account.bank.fetch(config.BANKS[0].bank)).group;
  const group = await program.account.marginfiGroup.fetch(groupKey);
  const bootstrap =
    config.BOOTSTRAP_GOVERNANCE_ADMIN && group.governanceAdmin.equals(PublicKey.default);
  const governanceAdmin = bootstrap ? config.BOOTSTRAP_GOVERNANCE_ADMIN : group.governanceAdmin;
  console.log(`governance admin: ${governanceAdmin}${bootstrap ? " (bootstrapped in the first tx)" : ""}`);

  for (let start = 0; start < config.BANKS.length; start += BANKS_PER_TX) {
    const transaction = new Transaction();
    if (bootstrap && start === 0) {
      transaction.add(
        await program.methods
          .marginfiGroupSetGovernanceAdmin(governanceAdmin)
          .accounts({ marginfiGroup: groupKey, signer: group.admin })
          .instruction(),
      );
    }
    for (const { bank, update } of config.BANKS.slice(start, start + BANKS_PER_TX)) {
      transaction.add(
        await program.methods
          .lendingPoolConfigureBankGov({
            assetWeightInit: wrap(update.assetWeightInit),
            assetWeightMaint: wrap(update.assetWeightMaint),
            liabilityWeightInit: wrap(update.liabilityWeightInit),
            liabilityWeightMaint: wrap(update.liabilityWeightMaint),
            operationalState: null,
            riskTier: null,
            assetTag: null,
            oracleMaxConfidence: null,
            oracleMaxAge: update.oracleMaxAge ?? null,
            tokenlessRepaymentsAllowed: update.tokenlessRepaymentsAllowed ?? null,
            freezeSettings: null,
          } as any)
          .accountsPartial({ bank, governanceAdmin })
          .instruction(),
      );
    }

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
    } else {
      transaction.feePayer = config.MULTISIG;
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      const serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      console.log("Base58-encoded transaction:", bs58.encode(serializedTransaction));
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
