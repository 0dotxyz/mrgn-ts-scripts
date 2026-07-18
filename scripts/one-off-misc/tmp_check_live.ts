import { PublicKey } from "@solana/web3.js";
import { commonSetup } from "../lib/common-setup";

const MULTISIG = new PublicKey("CYXEgwbPHu2f9cY3mcUkinzDoDcsSan7myh1uBvYRbEw");

// bank -> [expected hourly, expected daily] from the executed proposals 386-389
const EXPECTED: Record<string, [string, string]> = {
  "2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB": ["1700096796808", "3400193593616"],
  CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh: ["19647084535245", "39294169070490"],
  Bohoc1ikHLD7xKJuzTyiTyCwzaL5N7ggJQu75A8mKYM8: ["13224238715853", "26448477431706"],
  HmpMfL8942u22htC4EMiWgLX931g3sacXFR6KjuLgKLV: ["743087627470", "1486175254940"],
  "22DcjMZrMwC5Bpa5AGBsmjc5V9VuQrXG6N9ZtdUNyYGE": ["8108872006007", "16217744012014"],
  DeyH7QxWvnbbaVB4zFrf4hoq7Q8z1ZT14co42BGwGtfM: ["13030821562105944", "26061643124211888"],
  "8LaUZadNqtzuCG7iCvZd7d5cbquuYfv19KjAg6GPuuCb": ["6193137523231", "12386275046462"],
  DMoqjmsuoru986HgfjqrKEvPv8YBufvBGADHUonkadC5: ["4231689420644", "8463378841289"],
  "3Gm3ZbbPE7JnC5FxAgCj2i6pK22kjePa4y5NDVVENnjr": ["3970101077380", "7940202154760"],
  "6hS9i46WyTq1KXcoa2Chas2Txh9TJAVr6n1t3tnrE23K": ["3152881941903", "6305763883806"],
  EdB7YADw4XUt6wErT8kHGCUok4mnTpWGzPUU9rWDebzb: ["360361526615810", "720723053231620"],
  BKsfDJCMbYep6gr9pq8PsmJbb5XGLHbAJzUV8vmorz7a: ["315853028", "631706056"],
  Amtw3n7GZe5SWmyhMhaFhDTi39zbTkLeWErBsmZXwpDa: ["46931444744", "93862889488"],
  Guu5uBc8k1WK1U2ihGosNaCy57LSgCkpWAabtzQqrQf8: ["928753288334", "1857506576668"],
  BkUyfXjbBBALcfZvw76WAFRvYQ21xxMWWeoPtJrUqG3z: ["8519549861", "17039099723"],
  AwLRW3aPMMftXEjgWhTkYwM9CGBHdtKecvahCJZBwAqY: ["1336923135481", "2673846270962"],
  FDsf8sj6SoV313qrA91yms3u5b3P4hBxEPvanVs8LtJV: ["120484259464", "240968518928"],
  "3RVamPQE3nDViuUU7wdZJgnru7Q93cRzdysXA8kjxMiq": ["188969830", "377939661"],
  Ac4KV5K5isDqtABtg6h5DiwzZMe3Sp9bc3pBiCUvUpaQ: ["186460252", "372920504"],
  "6zN8tRxMpuqruDF4ChjeNGCVggqWBMQQ9KmiNhYeiqXb": ["1511183858528", "3022367717056"],
  "9dpu8KL5ABYiD3WP2Cnajzg1XaotcJvZspv29Y1Y3tn1": ["616380756798", "1232761513597"],
  EbuSnXdFz1R4VPdaJ96KQQQmeYgZTHSzpNW94Tw1PE3H: ["4653044164504", "9306088329009"],
  "5Tj1B7bT8PSyKjUCBxiUNe5C2Pn59NhA2ohmdj3RPpE5": ["945572574414", "1891145148828"],
  J5mxC3hLXqmsJB4Nauf9YrtbNMSTHGz7FWfAmy1v6Fzr: ["1055303570383", "2110607140766"],
  "75UmeEMdqVnGn3JHx8yVZEn7viybJ73XYSjhYCYfyhp2": ["731027915425", "1462055830851"],
  VnVjbrytWcxTi6nCASMryKm4vHwpVZvwJetE2W1w5gB: ["45336216264", "90672432528"],
  BeNBJrAh1tZg5sqgt8D6AWKJLD5KkBrfZvtcgd7EuiAR: ["44556208257", "89112416514"],
  "8UEiPmgZHXXEDrqLS3oiTxQxTbeYTtPbeMBxAd2XGbpu": ["40518218170", "81036436341"],
  "6pSfmSLALBsTVCmoYLXs2auDSdU1TDcBWa81gCPzf8EX": ["38967241068", "77934482137"],
  GJCi1uj3kYPZ64puA5sLUiCQfFapxT2xnREzrbDzFkYY: ["493086983737", "986173967475"],
  "3VCkXWAmE5DSwYRpqGFnkUz7vvD2RKbhFvrhzLuE8msu": ["511189461410", "1022378922821"],
  "9ThXmfwhNzc6qbkRLuSGHwKS7mxjn6QcuRD644Pjn4F": ["485217289421", "970434578843"],
  "5syijTAMBBmdjwUgYYBvvv26zTS6YX1bYV9EdXkgYqLa": ["27880860296", "55761720593"],
  "4ecRL7M2fdmWjZd81PTZ9Sqg1e47ZpiwhkeDbsBJtqax": ["414834794305", "829669588611"],
  JBcir4DPRPYVUpks9hkS1jtHMXejfeBo4xJGv3AYYHg6: ["8938206649181", "17876413298362"],
  FLwQ2tV4gPHKWY1jwdB3Hp8Z18nU4WngvNgJn3qZVGd7: ["22628073268", "45256146537"],
  FuyzDwmMbYYPPd3oLtjNk3ZLqsTBPaQtQrxRGzUGcAvp: ["31897812522856", "63795625045712"],
  "27Cpv49jQ3hav8zF3qZjp7T78ATdUTZN4m9x389Z8uH4": ["21612674345", "43225348691"],
  "7GbG8B1aHpV4Q271ozU9EDEGPTLXpekv7m2UgyCgFzr5": ["5068605047", "10137210094"],
  "4YPGUhxmAXgoGDRkg68zGnbGrV2xCgaoqQSfcZCjFhon": ["21337148824", "42674297648"],
  "4YipZHMNQjip1LrG3uF2fj1G5ieWQ9QRQRy1jhAWWKUZ": ["0", "0"],
};

async function main() {
  const user = commonSetup(
    false,
    "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    undefined,
    MULTISIG,
  );
  const keys = Object.keys(EXPECTED);
  const banks = await user.program.account.bank.fetchMultiple(
    keys.map((k) => new PublicKey(k)),
  );

  let ok = 0;
  for (let i = 0; i < keys.length; i++) {
    const b = banks[i] as any;
    if (!b) {
      console.log(`MISSING ${keys[i]}`);
      continue;
    }
    const hourly = b.rateLimiter.hourly.maxOutflow.toString();
    const daily = b.rateLimiter.daily.maxOutflow.toString();
    const [eh, ed] = EXPECTED[keys[i]];
    if (hourly === eh && daily === ed) {
      ok++;
    } else {
      console.log(
        `DIFF ${keys[i]} on-chain hourly=${hourly} daily=${daily} expected hourly=${eh} daily=${ed}`,
      );
    }
  }
  console.log(`\n${ok}/${keys.length} banks match the executed proposals exactly.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
