import {
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { commonSetup } from "../../lib/common-setup";

const sendTx = false;

type Config = {
  PROGRAM_ID: string;
  BANKS: PublicKey[];
  FORCE?: boolean;
  MULTISIG?: PublicKey;
  LUT?: PublicKey;
};

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  BANKS: [
    "6os7THfmjSXjxvZ488GNJAkTtTMY56vj1FfdDwocds6i", // PT-hyUSD DEFAULT
    "BYZ4ZPjNw8Ha2o6DcNLUPfmuuacTno9j135XeYRubHfA", // dSOL DRIFT
    "2D1dc9jo8CNjgVG4qTKpRuGA83zrXv9iuSHV9BWZ7Js9", // INF DRIFT
    "HSWzj4oipYaMD7DtpiFcBs3oH5ZwDp4PUTtzPCJNMSd4", // JitoSOL DRIFT
    "8yH6soQM2SUFjkRQiBo5UDLbLTWPCYEsyT22Xdi1sfh7", // mSOL DRIFT
    "BsvoBGsejZTbkUckZtdQDav3PGvbatCoZTfJgB48CsCK", // PYUSD DRIFT
    "CwbdVVmGfR4H9bQ39vmeKjt9Gd128iFGrc9Jvht2oPx6", // SOL DRIFT
    "FKrkgcTCduBvnitwqg5GPnfK7M4aBNuZDjZZeeUhz7Uv", // syrupUSDC DRIFT
    "5GZmPEr6czroe3ax29D2FHyKuT64ixj5evB2NqWjUk1d", // USDC DRIFT
    "BpEDE4y44E3JYhNoRycxiPxr4UnhtG5qAKX5AVtG7Wp5", // USDS DRIFT
    "HWSRiriCeJ8MZEWaQWb5dtztjEtLTinu5EfjcXyT8RPv", // USDS KAMINO
    "BZAm4qGscR8gg5bmWrEq6BTofgaZPbg7Fwfa7rFghEXL", // BONK STAKED
    "4watsWcjTBAwsrZpArwQbnNX4bQ1yeHBxgdbrGT4eMu9", // COMPASS STAKED
    "4irzCCsU53ffh9XB7NxGzbbHjvSR7FTfPbn6KoXkt7kX", // DEFICORP STAKED
    "CmBDHSVuodmUnanbBVFvY9cauLeosbdFQn9bJANMVYUG", // HANABI STAKED
    "HzS8RqaQ5syk6EHbVi7h9rFYN48PpxykUXEs6w9wNfNP", // HYDEX STAKED
    "6q5DB86DhCBQt5bqzZwgopV8EA96aCnngu5ebR1ooDFq", // KIWAMI STAKED
    "J9trpcrVdFjVNg6VFrdF1XPGgjftQKZhbbWsxertdv9V", // LNTRN STAKED
    "91jkdp4cF8vCDhjwude3SGSGrmVWFk5vTAtR6fsGVAfy", // LOTUS STAKED
    "2foqT8wWzWRduyV37uRdj81DijkNMKzYD3D6JPfir7La", // LUX STAKED
    "9Hs4E6ACNw6Hmwjvm1duXzbaWmvXxSxN11agw4updEn1", // MADLAD STAKED
    "4C2vPweGNpiE6kTEbYvcbUBHNWxrn4ErQYaqWm5zDexx", // MAVAN STAKED
    "Hco1P3dGRXz3ZGFvMkbDgghZQy47Tp7vp7koSYRvP6nm", // MRGN3 STAKED
    "9d7MTvcz1VMB1rK6H73quMxkR26dLPz5HDaac2eGRjQx", // NYMS STAKED
    "GdtggomQth6cxuYPdiVhBbcX7VC9rnDDwLMfxipxE2Po", // OPAL STAKED
    "72BS34HkCgq8RWQR7kuVVmiJMtKqSxG4CHX6ZXpSCwg7", // ORANGEFIN STAKED
    "6V4vCK3n3JVncfpS16mW8ceLoNPatvu61pKxFmWx8adi", // PRIVATE STAKED
    "H6CT1aiCgSNw9S6aq38npEhdoN2UPhSKe8Lj9fQqqjuu", // ROSS STAKED
    "Dfr6Sf44ftecaJaoJMzFQABdkt3CEHfBwut1WyacRzaE", // SOLAYER STAKED
    "7bLfrb4fWVYkVpZ9rg7dBUwKRAqLyiivCW4ahMMGcKyS", // SOLJAPAN STAKED
    "3F3QXT3BtkegaBfFjn2odKLurFYLHJHJ99xKV2TRTvrk", // SPECTRUM STAKED
    "8c269gkonvATm93nviuYiriCQ829f7ypx3aScYDR1YoQ", // STARKE STAKED
    "CK8qRAcmvkDXaqX2S5GkgTCZT5pCz34me1neQhpJYe1Z", // STRONGHOLD STAKED
    "EGTfrYiuWpPPZ4yfY9tCxnK6QMkY7pzVie9DxK772iGe", // SUPER STAKED
    "GLSCJ39N82Xo21621jMheinvjQLrBrkG7gzo2C5L1y6y", // TOPAZ STAKED
    "FCi8unSVCwJd3QkrhTtv6LTTjw1c4zV65D5cG5N1rAG6", // VALID STAKED
    "5sJCKePwAhyD3mzrzLRDM2PkFMc85nnvvarxHLsvWvpg", // WATCHTOWER STAKED
    // Do not close: operational and added in Jun-Jul 2026.
    // "CFmvdtEPQJPVqS1QRkeRcdQm2itAPk6k8hSJbmt88Sjc", // EMERALD STAKED (active validator, ~1.2M SOL)
    // "FsdWEJzHXkUXejWnb7c1p9UJtF69hVWQNNoakjoXyRCJ", // ANAGRAM STAKED (active validator, ~2.5M SOL)
    // "9LiRrrzgnu84wL6ftqGGDBZfjGmYSNCnExmL4gKf9mzr", // PYUSD KAMINO (operational, Mar 2026)
    // "77tvwSNZUMnXJmETfyXRiJKUPDZyheaGUXS8EBcnVimk", // PT-rkuSOL-31OCT26 DEFAULT
    // "CMaeX9mWbwYDeknxHCUiz2UXtyyBbpXSCVcoYs4KWJ5Z", // rkuSOL DEFAULT
    // "EQs18wjcya2x2CtwhqiWXGWu1frDzUjM2e2BSniBQoj4", // PYUSD KAMINO
    // "5wEJdDtCAVwPASNM2QfXAmLUnP8DCLy7D2piSgZxQ9xb", // syrupUSDC KAMINO
    // "3zk6EmXANYQK12bwy9dySRAM4cT2vT5cDcAB79j8G33B", // ATSOL STAKED
    // "5CBocarwfJeWGNozGemWktRYSz6kPikRPdfH8ZHSFrsg", // DAWN STAKED
    // "FZaHyfg9hmNMKpfUJ474wNKPaPdXMpnJouasKnndECiZ", // KILN1 STAKED
    // "75UmeEMdqVnGn3JHx8yVZEn7viybJ73XYSjhYCYfyhp2", // KUMASOL STAKED
    // "E5hZu5QQ1pRmGvyS4JHGXVQwzdUPaYM4yEiNKr64YzyG", // NFGC STAKED
    // "5q1wJkGqqRh6mSBtjG8sfjBsgJSGdA2QoXTWv4UQbHGk", // SHIFT STAKED
    // "9dZiyG51FBR4BWpAs69XbDpr7GfVAEB1ZB89v38maV36", // SIMPDIGIT STAKED
    // "9ivswG37QpCUmkPkLMpRZT7PMyP64V9dDpZdteM254ec", // VALIGATOR STAKED
  ].map((b) => new PublicKey(b)),
  FORCE: true,
  MULTISIG: new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw"),
  LUT: new PublicKey("UzGyBno8GEZDapsj1FAy11aquXby1wkxeeDa4Y5TdPN"),
};

async function main() {
  await closeBank(sendTx, config, "/.config/stage/id.json");
}

export async function closeBank(sendTx: boolean, config: Config, walletPath: string) {
  const user = commonSetup(
    sendTx,
    config.PROGRAM_ID,
    walletPath,
    config.MULTISIG,
  );
  const program = user.program;
  const connection = user.connection;

  const transaction = new Transaction();
  for (const bank of config.BANKS) {
    transaction.add(
      await program.methods
        .lendingPoolCloseBank(config.FORCE ?? false)
        .accounts({
          bank,
        })
        .instruction()
    );
  }

  if (sendTx) {
    try {
      const signature = await sendAndConfirmTransaction(connection, transaction, [user.wallet.payer]);
      console.log("Transaction signature:", signature);
    } catch (error) {
      console.error("Transaction failed:", error);
    }
  } else if (config.LUT) {
    const lut = (await connection.getAddressLookupTable(config.LUT)).value;
    if (!lut) throw new Error(`LUT ${config.LUT} not found`);
    const inLut = new Set(lut.state.addresses.map((a) => a.toBase58()));
    const missing = transaction.instructions
      .flatMap((ix) => ix.keys)
      .filter((k) => !k.isSigner && !inLut.has(k.pubkey.toBase58()))
      .map((k) => k.pubkey.toBase58());
    if (missing.length > 0) throw new Error(`LUT is missing: ${[...new Set(missing)].join(", ")}`);
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: config.MULTISIG!,
        recentBlockhash: blockhash,
        instructions: transaction.instructions,
      }).compileToV0Message([lut])
    );
    console.log(`${config.BANKS.length} banks, ${tx.serialize().length} bytes`);
    console.log("Base58-encoded transaction:", bs58.encode(tx.serialize()));
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
  });
}
