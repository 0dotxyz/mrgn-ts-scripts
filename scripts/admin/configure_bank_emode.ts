import { Program } from "@coral-xyz/anchor";
import { bigNumberToWrappedI80F48, WrappedI80F48 } from "@mrgnlabs/mrgn-common";
import {
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { commonSetup } from "../../lib/common-setup";
import { EmodeTag, MAX_EMODE_ENTRIES } from "../../lib/constants";
import { I80F48_ZERO } from "../utils/utils";
import { groupBy } from "lodash";
import { Marginfi } from "../../idl/marginfi";

/**
 * If true, send the tx. If false, output the unsigned b58 tx to console.
 */
const sendTx = true;

type Config = {
  PROGRAM_ID: string;
  MULTISIG?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  // Not required if sending without multisig.
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
};

interface PairConfig {
  lend: EmodeTag;
  borrow: EmodeTag;
  /** True to apply to isolated banks, false otherwise */
  appIso: boolean;
  /** Initial weight, as a float, e.g. for 90% pass 0.9 */
  init: number;
  maint: number;
}

// STEP 1: Map each tag to the bank PublicKeys that will use that tag. NOTE: If a bank currently has
// an emode entry and you want to REMOVE IT, make sure that bank appears here too (with a dummy
// value for the tag)
// prettier-ignore
const BANK_KEYS: Record<EmodeTag, PublicKey[]> = {
  // SOL
  // Base asset weight: 0.8, base maint weight: 0.9
  [EmodeTag.SOL]: [
    new PublicKey("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh"), // SOL
    new PublicKey("9SerK63jzwLimSP8nnH5aGoZzK2pVXBWTWmUZSyivwaV")  // Kamino Main Market SOL
  ],

  // Liquid staking tokens that are SOL correlated
  // Base asset weight: 0.65, base maint weight: 0.80
  [EmodeTag.LST_T1]: [
    new PublicKey("22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE"), // msol
    new PublicKey("6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K"), // bsol
    new PublicKey("DMoqjmsuoru986HgfjqrKEvPv8YBufvBGADHUonkadC5"), // lst (our own)
    new PublicKey("8LaUZadNqtzuCG7iCvZd7d5cbquuYfv19KjAg6GPuuCb"), // jupsol
    new PublicKey("Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8"), // jitosol
    new PublicKey("6zN8tRxMpuqruDF4ChjeNGCVggqWBMQQ9KmiNhYeiqXb"), // hylosol
  ],
  // Liquid staking tokens with a smaller market cap
  // Base asset weight: 0.65, base maint weight: 0.80
  [EmodeTag.LST_T2]: [
    new PublicKey("GJCi1uj3kYPZ64puA5sLUiCQfFapxT2xnREzrbDzFkYY"), // hsol
    new PublicKey("4YipZHMNQjip1LrG3uF2fj1G5ieWQ9QRQRy1jhAWWKUZ"), // bbSol
    new PublicKey("FVVKPocxQqJNjDTjzvT3HFXte5oarfp29vJ9tqjAPUW4"), // bnSol
    new PublicKey("AwLRW3aPMMftXEjgWhTkYwM9CGBHdtKecvahCJZBwAqY"), // inf
    new PublicKey("4gQYBXPg4GuUQ58pyRebJrtUt6TvFdznwMu7RLfNsipH"), // dfdvSOL
    new PublicKey("ARwrmohp8qMCkxQNiq5di4pTnTWhvXhAc7c18tZ877Kg"), // picoSOL
    new PublicKey("GR9GNdjWf8kSf3b4REribKKSeVvkzjbAQJ1A8CDnFxLF"), // rkSOL
    new PublicKey("5wZz2MV3dFJVq3Wp4tBoqrgrSGZqeLCdLE1L4w6okm9g"), // JSOL
    new PublicKey("FvrTUfd3kimMfXvGrvcS1XC8NrtmSSurX8yP6XeUFt2s"), // LanternSOL
    new PublicKey("E7LfHgmiWT6TxAcWq18yDBXWxHw4VasjD98aZaoXCp8T"),  // DZSOL
    new PublicKey("8W3GgWFFnHdd98GKGzvNNi9Wzjoq2CU4wW6cHz6cKxk1"),  // dsol
    new PublicKey("9p1TiAeTc6FSiNHhnR6BgmwRq49zywczAY4m77BbKGer"),  // bulksol
    new PublicKey("8iKgNvkQH9bBXyMbV5vor25gQRFM3tfyA7si68eKrLoa"),  // fwdsol
  ],
  // NEW
  // Base asset weight: 0, base maint weight: 0 
  [EmodeTag.LST_PT]: [
    new PublicKey("2VmE6PMRWLRxjMkoK2sWu3WyNGGdXFK1G38ZAaQu3r5Y"), // hysol
    new PublicKey("4PtX5fLM5JwujjHmSyzbh5XLasKx9kiPxPfygi57jAov"), // bulksol
  ],
  // Base asset weight: 0.5, base maint weight: 0.65
  [EmodeTag.JLP]: [
    new PublicKey("Amtw3n7GZe5SWmyhMhaFhDTi39zbTkLeWErBsmZXwpDa"), // jlp
  ],
  // Base asset weight: 1, base maint weight: 1
  [EmodeTag.STABLE_T1]: [
    new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB"), // usdc
    new PublicKey("HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV"), // usdt
    new PublicKey("FDsf8sj6SoV313qrA91yms3u5b3P4hBxEPvanVs8LtJV"), // usds
  ],
  [EmodeTag.STABLE_T2]: [
    // TBD in another update...
  ],
  // Base asset weight: 0.82, base maint weight: 0.87
  [EmodeTag.BTC_T1]: [
    new PublicKey("Ac4KV5K5isDqtABtg6h5DiwzZMe3Sp9bc3pBiCUvUpaQ"), // cbBTC
    new PublicKey("HDYFgNRTFL2tVwGyAHaTr4SW7Y7riXjew48qKLHgi8es"), // xBTC
  ],
  [EmodeTag.BTC_T2]: [
    // TBD in another update...
  ],
};

// STEP 2: Construct the pairs of Emode advantages that will be offered
// prettier-ignore
const PAIR_TABLE: PairConfig[] = [
  // In plain English, when lending X and borrowing Y, offer rate A/B
  { lend: EmodeTag.SOL, borrow: EmodeTag.LST_T1, appIso: true, init: 0.9, maint: 0.95 },
  { lend: EmodeTag.SOL, borrow: EmodeTag.LST_T2, appIso: true, init: 0.85, maint: 0.95 },
  { lend: EmodeTag.SOL, borrow: EmodeTag.SOL, appIso: true, init: 0.95, maint: 0.99 }, 

  { lend: EmodeTag.LST_T1, borrow: EmodeTag.SOL, appIso: true, init: 1.046, maint: 1.051 }, // UPDATE
  { lend: EmodeTag.LST_T1, borrow: EmodeTag.LST_T1, appIso: true, init: 0.88, maint: 0.93 },
  { lend: EmodeTag.LST_T1, borrow: EmodeTag.LST_T2, appIso: true, init: 0.85, maint: 0.9 },

  { lend: EmodeTag.LST_T2, borrow: EmodeTag.SOL, appIso: true, init: 0.992, maint: 0.999 },
  { lend: EmodeTag.LST_T2, borrow: EmodeTag.LST_T1, appIso: true, init: 0.8, maint: 0.85 },
  { lend: EmodeTag.LST_T2, borrow: EmodeTag.LST_T2, appIso: true, init: 0.75, maint: 0.85 },

  { lend: EmodeTag.JLP, borrow: EmodeTag.STABLE_T1, appIso: true, init: 0.94, maint: .99 },
  { lend: EmodeTag.JLP, borrow: EmodeTag.SOL, appIso: true, init: 0.85, maint: 0.92 },

  { lend: EmodeTag.BTC_T1, borrow: EmodeTag.STABLE_T1, appIso: true, init: 0.87, maint: 0.92 },

    // NEW EMODE PAIRS
  { lend: EmodeTag.LST_PT, borrow: EmodeTag.SOL, appIso: true, init: 0.85, maint: 0.95 },
  { lend: EmodeTag.LST_PT, borrow: EmodeTag.LST_T1, appIso: true, init: 0.8, maint: 0.85 },
  { lend: EmodeTag.LST_PT, borrow: EmodeTag.LST_T2, appIso: true, init: 0.75, maint: 0.85 },
];

async function main() {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    "/.keys/emode-burner.json",
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const setups: ConfigureBankEmodeArgs[] = [];

  for (const [borrowTagStr, pairs] of Object.entries(
    groupBy(PAIR_TABLE, (p) => p.borrow),
  )) {
    const borrowTag = Number(borrowTagStr) as EmodeTag;
    const entries: EmodeEntry[] = (pairs as PairConfig[]).map((p) => ({
      collateralBankEmodeTag: p.lend,
      flags: p.appIso ? 1 : 0,
      pad0: [0, 0, 0, 0, 0],
      assetWeightInit: bigNumberToWrappedI80F48(p.init),
      assetWeightMaint: bigNumberToWrappedI80F48(p.maint),
    }));

    // One setup per bank key under this borrow tag
    for (const bankPubkey of BANK_KEYS[borrowTag] || []) {
      console.log(
        "preparing to add tag " + borrowTag + " to bank " + bankPubkey,
      );
      setups.push({
        bank: bankPubkey,
        tag: borrowTag,
        entries: entries,
      });
    }
  }

  // Deal with banks that need a tag set, but have no entries in the borrow column (e.g. Staked
  // collateral)
  for (const borrowTagKey of Object.keys(BANK_KEYS)) {
    const borrowTag = Number(borrowTagKey) as EmodeTag;
    if (!setups.some((s) => s.tag === borrowTag)) {
      for (const bankPubkey of BANK_KEYS[borrowTag]) {
        console.log(
          `preparing to add tag ${borrowTag} to bank ${bankPubkey} with EMPTY entries`,
        );
        setups.push({
          bank: bankPubkey,
          tag: borrowTag,
          entries: [],
        });
      }
    }
  }

  if (sendTx) {
    for (const setup of setups) {
      const tx = new Transaction();
      console.log(
        `Configuring ${setup.bank.toString()} with tag (${setup.tag}) using ${
          setup.entries.length
        } entries`,
      );
      tx.add(
        await configBankEmode(program, {
          bank: setup.bank,
          tag: setup.tag,
          entries: setup.entries,
        }),
      );

      try {
        const signature = await sendAndConfirmTransaction(connection, tx, [
          user.wallet.payer,
        ]);
        console.log("✅ Transaction signature:", signature);
      } catch (error) {
        console.error("❌ Transaction failed:", error);
      }
    }
  } else {
    // TODO output a series of bs58 encoded txes in pairs?
    // transaction.feePayer = config.MULTISIG;
    // const { blockhash } = await user.connection.getLatestBlockhash();
    // transaction.recentBlockhash = blockhash;
    // const serializedTransaction = transaction.serialize({
    //   requireAllSignatures: false,
    //   verifySignatures: false,
    // });
    // const base58Transaction = bs58.encode(serializedTransaction);
    // console.log("Base58-encoded transaction:", base58Transaction);
  }
}

main().catch((err) => {
  console.error(err);
});

type ConfigureBankEmodeArgs = {
  bank: PublicKey;
  tag: number;
  /** Must be `MAX_EMODE_ENTRIES` or fewer, see `newEmodeEntry` */
  entries: EmodeEntry[];
};

function configBankEmode(
  program: Program<Marginfi>,
  args: ConfigureBankEmodeArgs,
) {
  const paddedEntries = padEmodeEntries(args.entries);

  const ix = program.methods
    .lendingPoolConfigureBankEmode(args.tag, paddedEntries)
    .accounts({
      // group: // implied from bank
      // emode_admin: // implied from group
      bank: args.bank,
    })
    .instruction();

  return ix;
}

function padEmodeEntries(entries: EmodeEntry[]): EmodeEntry[] {
  if (entries.length > MAX_EMODE_ENTRIES) {
    throw new Error(
      `Too many entries provided. Maximum allowed is ${MAX_EMODE_ENTRIES}`,
    );
  }
  const padded = [...entries];
  while (padded.length < MAX_EMODE_ENTRIES) {
    padded.push({
      collateralBankEmodeTag: 0,
      flags: 0,
      pad0: [0, 0, 0, 0, 0],
      assetWeightInit: I80F48_ZERO,
      assetWeightMaint: I80F48_ZERO,
    });
  }
  return padded;
}

type EmodeEntry = {
  collateralBankEmodeTag: number;
  flags: number;
  pad0: number[];
  assetWeightInit: WrappedI80F48;
  assetWeightMaint: WrappedI80F48;
};

function newEmodeEntry(
  collateralBankEmodeTag: number,
  flags: number,
  assetWeightInit: WrappedI80F48,
  assetWeightMaint: WrappedI80F48,
): EmodeEntry {
  return {
    collateralBankEmodeTag,
    flags,
    pad0: [0, 0, 0, 0, 0],
    assetWeightInit,
    assetWeightMaint,
  };
}

// ******************* Staging

// const BANK_KEYS: Record<EmodeTag, PublicKey[]> = {
//   // SOL
//   [EmodeTag.SOL]: [new PublicKey("3evdJSa25nsUiZzEUzd92UNa13TPRJrje1dRyiQP5Lhp")],
//   // Liquid staking tokens that are SOL correlated
//   [EmodeTag.LST]: [
//     new PublicKey("EJuhmswifV6wumS28Sfr5W8B18CJ29m1ZNKkhbhbYDCA"), // Jup SOL
//     new PublicKey("7QYMReTbACXKeX3fJWeJfxJs1gKRrCyWXKq63fUtBDNJ"), // hSOL
//   ],
//   // Stablecoins (~1:1 correlated to each other)
//   [EmodeTag.STABLE]: [
//     new PublicKey("Ek5JSFJFD8QgXM6rPDCzf31XhDp1q3xezaWYSkJWqbqc"), // USDC
//     new PublicKey("Fe5QkKPVAh629UPP5aJ8sDZu8HTfe6M26jDQkKyXVhoA"), // PyUSD
//     new PublicKey("FNEoFRVnmBF5KpRtghHJrJPbdbMjry1E33dNzzHY9UGC"), // UXD
//   ],
//   // Memecoins
//   [EmodeTag.MEME]: [
//     new PublicKey("DDLVJyj5sT3knnVDoTifrtQmroLnRCkBmGZ1QXCUDUUd"), // WIF
//     new PublicKey("GNw2sfgnFX4vermA94de6tgTyftpQHMvWLqFEceVZ1ad"), // DUST
//   ],
//   // Staked collateral
//   [EmodeTag.STAKE]: [
//     new PublicKey("3jt43usVm7qL1N5qPvbzYHWQRxamPCRhri4CxwDrf6aL"), // Cool
//     new PublicKey("4Gg6pW1U8W6ZQ22TbUWYRetx2nxjhUAydfKoCTSHhkkG"), // Phantom
//   ],
// };

// const PAIR_TABLE: PairConfig[] = [
//   // In plain English, when lending X and borrowing Y, offer rate A/B
//   { lend: EmodeTag.SOL, borrow: EmodeTag.LST, appIso: true, init: 0.9, maint: 0.95 },
//   { lend: EmodeTag.SOL, borrow: EmodeTag.STABLE, appIso: true, init: 0.85, maint: 0.9 },

//   { lend: EmodeTag.LST, borrow: EmodeTag.SOL, appIso: true, init: 0.8, maint: 0.85 },
//   { lend: EmodeTag.LST, borrow: EmodeTag.LST, appIso: true, init: 0.75, maint: 0.8 },

//   { lend: EmodeTag.STABLE, borrow: EmodeTag.STABLE, appIso: true, init: 0.95, maint: 0.97 },
//   { lend: EmodeTag.STABLE, borrow: EmodeTag.SOL, appIso: true, init: 0.95, maint: 0.97 },
//   { lend: EmodeTag.STABLE, borrow: EmodeTag.MEME, appIso: true, init: 0.15, maint: 0.25 },

//   { lend: EmodeTag.MEME, borrow: EmodeTag.MEME, appIso: true, init: 0.2, maint: 0.25 },
//   { lend: EmodeTag.MEME, borrow: EmodeTag.STABLE, appIso: true, init: 0.15, maint: 0.25 },
//   { lend: EmodeTag.MEME, borrow: EmodeTag.SOL, appIso: true, init: 0.15, maint: 0.25 },
//   { lend: EmodeTag.MEME, borrow: EmodeTag.LST, appIso: true, init: 0.1, maint: 0.2 },

//   { lend: EmodeTag.STAKE, borrow: EmodeTag.SOL, appIso: true, init: 0.98, maint: 1 },
// ];

// ******************* Proposed 07/10/2025

// const BANK_KEYS: Record<EmodeTag, PublicKey[]> = {
//   // SOL
//   [EmodeTag.SOL]: [new PublicKey("CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh")],
//   // Liquid staking tokens that are SOL correlated
//   [EmodeTag.LST_T1]: [
//     new PublicKey("22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE"), // msol
//     new PublicKey("6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K"), // bsol
//     new PublicKey("DMoqjmsuoru986HgfjqrKEvPv8YBufvBGADHUonkadC5"), // lst (our own)
//     new PublicKey("8LaUZadNqtzuCG7iCvZd7d5cbquuYfv19KjAg6GPuuCb"), // jupsol
//     new PublicKey("Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8"), // jitosol
//   ],
//   // Liquid staking tokens with a smaller market cap
//   [EmodeTag.LST_T2]: [
//     new PublicKey("GJCi1uj3kYPZ64puA5sLUiCQfFapxT2xnREzrbDzFkYY"), // hsol
//     new PublicKey("4YipZHMNQjip1LrG3uF2fj1G5ieWQ9QRQRy1jhAWWKUZ"), // bbSol
//     new PublicKey("FVVKPocxQqJNjDTjzvT3HFXte5oarfp29vJ9tqjAPUW4"), // bnSol
//   ],
// };

// // STEP 2: Construct the pairs of Emode advantages that will be offered
// const PAIR_TABLE: PairConfig[] = [
//   // In plain English, when lending X and borrowing Y, offer rate A/B
//   { lend: EmodeTag.SOL, borrow: EmodeTag.LST_T1, appIso: true, init: 0.90, maint: 0.95 },
//   { lend: EmodeTag.SOL, borrow: EmodeTag.LST_T2, appIso: true, init: 0.85, maint: 0.95 },

//   { lend: EmodeTag.LST_T1, borrow: EmodeTag.SOL, appIso: true, init: 0.90, maint: 0.95 },
//   { lend: EmodeTag.LST_T1, borrow: EmodeTag.LST_T2, appIso: true, init: 0.85, maint: 0.90 },

//   { lend: EmodeTag.LST_T2, borrow: EmodeTag.SOL, appIso: true, init: 0.85, maint: 0.90 },
//   { lend: EmodeTag.LST_T2, borrow: EmodeTag.LST_T1, appIso: true, init: 0.80, maint: 0.85 },
// ];
