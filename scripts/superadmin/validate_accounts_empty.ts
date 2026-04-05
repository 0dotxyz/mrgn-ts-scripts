import { PublicKey } from "@solana/web3.js";
import { wrappedI80F48toBigNumber } from "@mrgnlabs/mrgn-common";

import { commonSetup } from "../../lib/common-setup";

type Config = {
  PROGRAM_ID: string;
  WALLET_PATH: string;
};

type CheckStatus = "empty" | "non-empty" | "fetch-error" | "invalid-pubkey";

type BalanceViolation = {
  bank: string;
  active: number;
  tag: number;
  liabilityShares: string;
  assetShares: string;
  emissionsOutstanding: string;
};

type CheckResult = {
  account: string;
  status: CheckStatus;
  nonZeroBalanceCount: number;
  error?: string;
  violations: BalanceViolation[];
};

const ZERO_EPSILON = "0.0001";

const config: Config = {
  PROGRAM_ID: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
  WALLET_PATH: "/.config/solana/id.json",
};

const RAW_ACCOUNT_LIST = `
FTfHpdeSzjScptaL3txMAEr99jCXRL4dovBGseBxmLNX
BcgDrQRenbNGqs46WkZg1xZzGqRQtrfWCondNFSvjQn5
E9Yq6e4N3dRqhGFZ5PUW88UbGYeSPfspyqWEBFNdKxTj
Bix8Qjx37BB5ixoEQTJ1UEKhuqpCuUG6PDZigtvWjXWq
98gQvdLRX34xuzzn6pQxpvr26mmWNzZ4rHioxEwtGwWf
98gQvdLRX34xuzzn6pQxpvr26mmWNzZ4rHioxEwtGwWf
GFSwkPbS9NB3VP1CbA2Bk3fRkeKE4VyTH2P4MoP4juNC
J6gw9jdMd4mS22mt9akQM5mcX3R84fwASF8eioe5tA3E
2hScwtncNqtMGyLHCjx3J33ppWVMNZpQUjYGFprh7vCQ
Hv3RVX2znCsL1y182ZWScp9MiX8qzvbKH9DSDBbStrUu
6XNpatEQzacDwBGumvdMS51tCHgHAiWUsNcWz3pF71oM
6VscBrEpaH61PzpyiLEoyKF9anBPrVRVNGW6MRdmvusA
2gGzZBLafXKrpfpZgEHWg89dZXnZLFv4HcfcaXtznpiZ
CoFzXbJM6xo6dwiuw9bmMi6oDKCYypG5XACy3pWC7NVv
6TJmuEkvEJ4YQLmHzJCugtxQug1p2zXyZXyWghetCBRZ
7t6eqA9SQYSQvkRJnS87xmaLb3rKYpaZMyF64ZPTHfuK
3gC6uCcnjX7uaNJAZygAYeW1vdmRov8aQeBkYGHPv6ut
EjUGr2xF61mao3XnpTtcUpEZkzYwB41VPhejCR7Yewyq
12Ha1qPiaoLcxpG4LCLxa3mNkKRzAfroQJdDQDCMHby
8HftkGY4iNm6JofGDSah8YBnYd9JxAukSkewgr6t6dA8
CqqeFwSJuzFCijtv3HLCZX8YNx6nJtrCQYHFQK1vsGg
9n868gRGbcDFBZji59fgicaw3GkgfcSUFfHjuSDyDXhA
9n868gRGbcDFBZji59fgicaw3GkgfcSUFfHjuSDyDXhA
GL5SXYPG52BJRdcFjYqbQjwSuPdWXiN2LwGNuGqvrvws
7mkkVFFno4Uwzypr9XvSX7ixjoJYhyyAEZ422f18vjeW
7wJ9AfQjiNEzjw2sBJ9FzSChuWWDJKncGyzgoD3ogHau
7wJ9AfQjiNEzjw2sBJ9FzSChuWWDJKncGyzgoD3ogHau
4G6dgLcTQ39ddfoWPAtTwjZMfujjDF6QPPZF3PG5XnDr
9Mkx3rFEQtCma2RyzqoUgMnQEevNmPE9EA6nd2rLSzCh
7NoHLMNZYkyvHD9qPFfDqXFW6iHVRtuWwnbzTzfqoGtC
CsnVKMjcC32dxwFPbC5Lfu1kbNAyumznf4CfFKAtCaVk
4iEenQEnRbSNxj3kttoGisvWz6d4o8ai9grCsKcNJajf
BDCnZGt1Sh7yWfpBPHRXZTnW5wz5XvT1f5hLmMB14DKG
3nKxDuB38BysbHYimPgfSgur2xowCySNdnE3UFjNBXMR
BMkHHNGcj25HTqevnZzA3qTNZZNMKk8TBaiUiZCpp85Y
12qmQWEY8evTxt7fCLeV9fPqMsMeK34y46CVcneDkYsE
2LNNsMx9KeRJeNbGaYxbbjgPykPoeaND41Df1e7HRTVz
DP2HWYRC9z5sXcyv1dYBmYKmihGDzq7H8NdsP6rJYrG8
ARu6QgenhXGHC6hEDv4HHbURCjE926kQMeor45HUwG1e
Ej8UWTNZquq5gsQDku2Vqxe1xquJXdT3MzhKKARtrY7k
4EGrpAUYmrX4uPf4fUGvSgms6XRV2nvShBSHL9o5927p
9tb7pShQjBexupY4f3y1fahjCh4E6btCncsSiArYgGNk
AGuoHxG698cpA9qbY8ce4QdUYGj7dwygTpVMMsACW8TU
9FAShFD7BntJNs3b9jveNQgi99NDVJZ18CBBVS7FTrW8
7sEbdPiZPLCbtVH63fCy9DV6avuzE7GZE9TaErAGQjCk
6FPXvPYecn1EzW86MPRFGKNgSzYSWQUmwawfeBEGVBfh
EJHUAZXv7HHyCErEaapBvk5Gn2CJ9iKWchMmshPVQRwW
3Tn1m59jbBjnLYg9gfX7VMdtMmpetGyBCwk7Nbh9Kge5
3xNmimbTGEL84WYrSrwEt2JWjwwXhBBp5ABdV5YHhjd1
HHHQiT3CupmJeerAcfATNAmQrhJa1TeXnmSmUnq6N8G5
8yyM8niTgiJpCCjgMc5ZoVAJvsFpKejktE4B9WLwV6am
E6Q2UZHs5Hh5DLtQQXJdsqTDwD7turwqaoZ1rA2GLMfE
CaFAGimJCbWqg2m7UTLD21mwn5xMyamuQUwADybrUsNV
v2sCt5gTivqxigKpC143giMAzhTCCSpdjAqHSvHiqE2
8HP7bdpJ7NAkHcwhT7idrtdsSj2V9GcQCzLNUngdBDqz
C7revtqYyVJBWvFa5DyjG27D4ZYbTLs8pHkoSY2QXWR4
2ueUA4zXgXWTiDieQjuf4W16Z8zvoLxtfRUVcSToJtkb
CXncdJv4GdLT4v56Zmb3dXfrygA9iGiwfwaAXq6PLMJb
Hrh1pN755fG6USNL6mSsmhV5QihGasH9pQmr2XgEcQD4
FDaMMFp17uUaxhYnjYhirEdyxZuC28MwwerkL4uki7Q8
77Yyu1qALtN9fF8gwVF4ZKG9TbhrskRuW41nLScBUHKR
BWmaCAKTZySPaUPzG3RjKitDNBhKV6SuxBXWGBvfUaKi
9LaQfJcvXLgrVeNtfCqoncEXzf4uD2BwWEHF5wrcMc6r
3WSNCfoGoPwoKEV62T2wSLGPE2XEhcW7LHQKQx6FBBaR
FGF5135bNSSPm55E4FM6yeFrLMZnEdPDBgywgEFmMT6N
2wHPLgtuaup6cyERByE75FLVRDD57QFBYiawLzazvbSc
E198XjiweZZpzkLutJpLdaDXv8xpSfZv97y1RQo4URjY
63ytoT77wgZ1c3bkk4JLUpp2WtgRaZpxXfCihtomFX8z
C5uFMubiuW43z8VEFkMVZgBNVxTqD5zC13tg3tqkeuin
DVReE9zjAhRFPjAiyLgQNDfL5GwwnDRQ2kMUbSH2ko3X
86e24zJgjWHdJ3JsnrcUyGWHzs1KACFd2wbeYxwEYXgq
wD6EAjBfd7LjA8PKkMX1FafyJmdnydmCMuJsAD6Gizb
vunfbJFbazfRVDhqpYL1dqkzsujgPB2uf1LE7ib5RuK
F5tQuU7QWt8v68EQoaVYPm1jG8jBwjwnqjiSvZbx1PB6
G63RJc2RSVi5v3H36y6793f1NxgDhPYnHUXSUJPtaE2U
CR5ApS5xC4C3pB6UxXbkUSpuYDteHDLq5PdJYSQtzHUv
HDjsN7HxUuoSrpRTT2LyXcQjLZKvHS3dhd1gD3sJicfy
8QpzbA7e2pJV2zX9GjKq8Sq8PVS12Ba5cSYU3EXShWxR
9DLbodTdba4NMytyXhTzsCacWnsd5o2D4sxbLftT6co4
2421zTGbmg39wdcjrh8mq4mhhAwJeGfC66o1UUDGVJdN
GAQvbp9jnkeH4HWZAXgqVCBE3g7j8jgcBJreeYdDqVor
DTxnoC895fQtuc1yuFuEdkgYYzx9kPPR68EEYsVxEZju
74mprgZrzEWtdU8X6iBMviHPZUSgwR2NprDJ3vf8i94P
8uCCzt9hsAC7MKnYtUj5XpkAcFuSzmhnAYxmvvoo9Tk7
8pARynrid5ScoQNRm5qExjHujU3qXfgbCXXzhQtXvwTq
4PbPF6z27jaSR6WoMdN4pxXbZaedZd79ToEcYRTQAXdK
6n1aYuAabr4XMD5Yt1vYJMVzF6Kuxf7w23d8wbzvyqhA
`;

function splitAndTrimList(input: string): string[] {
  return input
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isEffectivelyZero(value: any): boolean {
  return value.abs().lt(ZERO_EPSILON);
}

function collectNonZeroBalances(balances: any[]): BalanceViolation[] {
  const violations: BalanceViolation[] = [];

  for (const b of balances) {
    const liab = wrappedI80F48toBigNumber(b.liabilityShares);
    const asset = wrappedI80F48toBigNumber(b.assetShares);
    const emissions = b.emissionsOutstanding
      ? wrappedI80F48toBigNumber(b.emissionsOutstanding)
      : null;

    const hasNonZero =
      !isEffectivelyZero(liab) ||
      !isEffectivelyZero(asset) ||
      (emissions ? !isEffectivelyZero(emissions) : false);

    if (!hasNonZero) {
      continue;
    }

    violations.push({
      bank: b.bankPk.toString(),
      active: Number(b.active),
      tag: Number(b.bankAssetTag),
      liabilityShares: liab.toString(),
      assetShares: asset.toString(),
      emissionsOutstanding: emissions ? emissions.toString() : "0",
    });
  }

  return violations;
}

async function main() {
  const inputAccounts = splitAndTrimList(RAW_ACCOUNT_LIST);
  const dedupedAccounts = Array.from(new Set(inputAccounts));
  const duplicateRows = Array.from(
    inputAccounts.reduce((acc, cur) => {
      acc.set(cur, (acc.get(cur) ?? 0) + 1);
      return acc;
    }, new Map<string, number>()),
  )
    .filter(([, count]) => count > 1)
    .map(([account, count]) => ({ account, count }));

  const user = commonSetup(true, config.PROGRAM_ID, config.WALLET_PATH);
  const program = user.program;

  const results: CheckResult[] = [];

  for (let i = 0; i < dedupedAccounts.length; i++) {
    const accountStr = dedupedAccounts[i];
    process.stdout.write(
      `[${i + 1}/${dedupedAccounts.length}] checking ${accountStr}\n`,
    );

    let accountPk: PublicKey;
    try {
      accountPk = new PublicKey(accountStr);
    } catch (err: any) {
      results.push({
        account: accountStr,
        status: "invalid-pubkey",
        nonZeroBalanceCount: 0,
        error: String(err?.message ?? err),
        violations: [],
      });
      continue;
    }

    try {
      const acc = await program.account.marginfiAccount.fetch(accountPk);
      const violations = collectNonZeroBalances(acc.lendingAccount.balances);
      results.push({
        account: accountStr,
        status: violations.length === 0 ? "empty" : "non-empty",
        nonZeroBalanceCount: violations.length,
        violations,
      });
    } catch (err: any) {
      results.push({
        account: accountStr,
        status: "fetch-error",
        nonZeroBalanceCount: 0,
        error: String(err?.message ?? err),
        violations: [],
      });
    }
  }

  const emptyCount = results.filter((r) => r.status === "empty").length;
  const nonEmpty = results.filter((r) => r.status === "non-empty");
  const errored = results.filter(
    (r) => r.status === "fetch-error" || r.status === "invalid-pubkey",
  );

  console.log("\n=== Summary ===");
  console.log(`Zero epsilon (abs): < ${ZERO_EPSILON}`);
  console.log(`Input rows: ${inputAccounts.length}`);
  console.log(`Unique accounts checked: ${dedupedAccounts.length}`);
  console.log(`Duplicate rows removed: ${inputAccounts.length - dedupedAccounts.length}`);
  console.log(`Empty accounts: ${emptyCount}`);
  console.log(`Non-empty accounts: ${nonEmpty.length}`);
  console.log(`Errors: ${errored.length}`);

  if (duplicateRows.length > 0) {
    console.log("\n=== Duplicates In Input ===");
    console.table(duplicateRows);
  }

  console.log("\n=== Account Status Table ===");
  console.table(
    results.map((r) => ({
      account: r.account,
      status: r.status,
      non_zero_balances: r.nonZeroBalanceCount,
      error: r.error ?? "",
    })),
  );

  if (nonEmpty.length > 0) {
    console.log("\n=== Non-Empty Account Details ===");
    for (const item of nonEmpty) {
      console.log(`\n${item.account}`);
      console.table(item.violations);
    }
  }

  if (errored.length > 0) {
    console.log("\n=== Errors ===");
    for (const item of errored) {
      console.log(`${item.account}: ${item.error}`);
    }
  }

  if (nonEmpty.length > 0 || errored.length > 0) {
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
