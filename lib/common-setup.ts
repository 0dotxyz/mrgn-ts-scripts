// This script is an abomination and I apologize.
import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl } from "@coral-xyz/anchor";

import { KaminoLending } from "../idl/kamino_lending";
import KaminoLendingIdl from "../idl/kamino_lending.json";

import { Drift } from "../idl/drift";
import DriftIdl from "../idl/drift.json";

import { Marginfi as MarginfiCurrent } from "../idl/marginfi";
import marginfiIdlCurrent from "../idl/marginfi.json";

import { Marginfi as MarginfiV1_6 } from "../idl/marginfi1.6";
import marginfiIdlV1_6 from "../idl/marginfi1.6.json";

import { loadKeypairFromFile, ReadOnlyWallet } from "../lib/utils";
import { DEFAULT_API_URL, loadEnvFile } from "../scripts/utils/utils";

/**
 * A user context containing the Anchor program, wallet, provider, and connection.
 */
export type User<IDL extends Idl> = {
  program: Program<IDL>;
  kaminoProgram: Program<KaminoLending>;
  driftProgram: Program<Drift>;
  wallet: ReadOnlyWallet | Wallet;
  provider: AnchorProvider;
  connection: Connection;
};

/**
 * Supported IDL versions.
 */
type Versions = {
  current: MarginfiCurrent;
  "1.6": MarginfiV1_6;
};

// Map each version to its corresponding JSON IDL object.
const idlJsonMap: Record<keyof Versions, Idl> = {
  current: marginfiIdlCurrent as Idl,
  "1.6": marginfiIdlV1_6 as Idl,
};

/**
 * @overload
 * commonSetup(sendTx, programId, walletPath?, multisig?, version?: 'current'): User<MarginfiCurrent>
 */
/**
 * @overload
 * commonSetup(sendTx, programId, walletPath?, multisig?, version: '1.3'): User<MarginfiV1_3>
 */
export function commonSetup(
  sendTx: boolean,
  programId: string,
  walletPath?: string,
  multisig?: PublicKey,
  version?: "current"
): User<MarginfiCurrent>;
export function commonSetup(
  sendTx: boolean,
  programId: string,
  walletPath?: string,
  multisig?: PublicKey,
  version?: "1.6"
): User<MarginfiV1_6>;
export function commonSetup(
  sendTx: boolean,
  programId: string,
  walletPath?: string,
  multisig?: PublicKey,
  version: keyof Versions = "current"
):
  | User<MarginfiCurrent>
  | User<MarginfiV1_6> {
  const selectedJsonIdl = idlJsonMap[version];
  selectedJsonIdl.address = programId;

  loadEnvFile(".env.api");
  const apiUrl = process.env.API_URL || DEFAULT_API_URL;
  // console.log("api: " + apiUrl);

  const connection = new Connection(apiUrl, "confirmed");

  let wallet: ReadOnlyWallet | Wallet;
  let provider: AnchorProvider;

  if (sendTx) {
    console.log("using provided path as wallet: " + walletPath);
    wallet = new Wallet(loadKeypairFromFile(process.env.HOME + walletPath!));
    provider = new AnchorProvider(connection, wallet, {
      preflightCommitment: "confirmed",
    });
  } else {
    console.log("using MS as wallet: " + multisig);
    wallet = new ReadOnlyWallet(multisig!);
    provider = new AnchorProvider(connection, wallet, {
      preflightCommitment: "confirmed",
    });
  }

  // Instantiate the program with the selected IDL
  if (version === "1.6") {
    return {
      program: new Program<MarginfiV1_6>(selectedJsonIdl as any, provider),
      kaminoProgram: undefined,
      driftProgram: undefined,
      wallet,
      provider,
      connection,
    };
  } else {
    return {
      program: new Program<MarginfiCurrent>(selectedJsonIdl as any, provider),
      kaminoProgram: undefined,
      driftProgram: undefined,
      wallet,
      provider,
      connection,
    };
  }
}

export function registerKaminoProgram<IDL extends Idl>(
  user: User<IDL>,
  kaminoProgramId: string
): void {
  const kaminoIdl = { ...(KaminoLendingIdl as Idl), address: kaminoProgramId };
  user.kaminoProgram = new Program<KaminoLending>(
    kaminoIdl as any,
    user.provider
  );
}

export function registerDriftProgram<IDL extends Idl>(
  user: User<IDL>,
  driftProgramId: string
): void {
  const driftIdl = { ...(DriftIdl as Idl), address: driftProgramId };
  user.driftProgram = new Program<Drift>(
    driftIdl as any,
    user.provider
  );
}
