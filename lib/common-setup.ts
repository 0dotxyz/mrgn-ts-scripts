// This script is an abomination and I apologize.
import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl } from "@coral-xyz/anchor";

import { KaminoLending } from "../idl/kamino_lending";
import KaminoLendingIdl from "../idl/kamino_lending.json";

import { Drift } from "../idl/drift";
import DriftIdl from "../idl/drift.json";

import { Lending } from "../idl/juplend_earn";
import JuplendIdl from "../idl/juplend_earn.json";

import { Marginfi as MarginfiCurrent } from "../idl/marginfi";
import marginfiIdlCurrent from "../idl/marginfi.json";

import { loadKeypairFromFile, ReadOnlyWallet } from "../lib/utils";
import { DEFAULT_API_URL, loadEnvFile } from "../scripts/utils";

/**
 * A user context containing the Anchor program, wallet, provider, and connection.
 */
export type User<IDL extends Idl> = {
  program: Program<IDL>;
  kaminoProgram: Program<KaminoLending>;
  driftProgram: Program<Drift>;
  juplendProgram: Program<Lending>;
  wallet: ReadOnlyWallet | Wallet;
  provider: AnchorProvider;
  connection: Connection;
};

export function commonSetup(
  sendTx: boolean,
  programId: string,
  walletPath?: string,
  multisig?: PublicKey,
): User<MarginfiCurrent> {
  const selectedJsonIdl = marginfiIdlCurrent;
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
  {
    return {
      program: new Program<MarginfiCurrent>(selectedJsonIdl as any, provider),
      kaminoProgram: undefined,
      driftProgram: undefined,
      juplendProgram: undefined,
      wallet,
      provider,
      connection,
    };
  }
}

export function registerKaminoProgram<IDL extends Idl>(
  user: User<IDL>,
  kaminoProgramId: string,
): void {
  const kaminoIdl = { ...(KaminoLendingIdl as Idl), address: kaminoProgramId };
  user.kaminoProgram = new Program<KaminoLending>(
    kaminoIdl as any,
    user.provider,
  );
}

export function registerDriftProgram<IDL extends Idl>(
  user: User<IDL>,
  driftProgramId: string,
): void {
  const driftIdl = { ...(DriftIdl as Idl), address: driftProgramId };
  user.driftProgram = new Program<Drift>(driftIdl as any, user.provider);
}

export function registerJuplendProgram<IDL extends Idl>(
  user: User<IDL>,
  juplendProgramId: string,
): void {
  const juplendIdl = { ...(JuplendIdl as Idl), address: juplendProgramId };
  user.juplendProgram = new Program<Lending>(juplendIdl as any, user.provider);
}
