# Tools Package

A collection of CLI tools and utilities for account and banking operations.

## Features

- Command-line interface tools for common operations.
- Account and bank search utilities.
- Collection of debugging and testing scripts.

## Requirements

- Node, with support for crypto. If this is false, upgrade Node versions:

```
console.log("Environment supports crypto: ", !!global.crypto?.subtle);
```

- pnpm (`npm install -g pnpm@latest-10`)
- (Optional) A wallet (with SOL) at ~/keys/wallet.json

## Create Env File

Copy the [env.template](env.template) file to `.env` file and populate missing data.

## Available Tools

### `pnpm accounts:get`

**Description:**

Retrieves account details by providing the account public key.

**Usage:**

```bash
pnpm accounts:get --account <ACCOUNT_PUBLIC_KEY>
```

**Options:**

- `-a, --account`  
  Account public key _(string, required)_

---

### `pnpm accounts:get-all`

**Description:**

Retrieves details for all accounts associated with a wallet.

**Usage:**

```bash
pnpm accounts:get-all --wallet <WALLET_PUBLIC_KEY>
```

**Options:**

- `-w, --wallet`  
  Wallet public key _(string, required)_

---

### `pnpm accounts:find-users`

**Description:**  
Searches for users based on assets, liabilities, and balance criteria.

**Usage:**

```bash
pnpm accounts:find-users [options]
```

**Options:**

- `--assets`  
  Comma-separated list of token symbols to search for assets.
- `--liabs`  
  Comma-separated list of token symbols to search for liabilities.
- `-m, --min-balance`  
  Minimum balance to return _(number, default: 0.1)_
- `-l, --limit`  
  Maximum number of accounts to return _(number, default: 1)_

---

### `pnpm accounts:cache`

**Description:**  
Caches account data for quicker access.

**Usage:**

```bash
pnpm accounts:cache
```

**Options:**

- _No options available._

---

### `pnpm banks:get`

**Description:**  
Retrieves bank details using either the bank's public key or a token symbol.

**Usage:**

```bash
pnpm banks:get [options]
```

**Options:**

- `-a, --address`  
  Bank public key _(string)_
- `-s, --symbol`  
  Token symbol (e.g., 'USDC') _(string)_

---

### `pnpm banks:get-all`

**Description:**  
Retrieves details for all banks.

**Usage:**

```bash
pnpm banks:get-all
```

**Options:**

- _No options available._

---

### `pnpm banks:get-accounts`

**Description:**  
Retrieves accounts associated with a specific bank.

**Usage:**

```bash
pnpm banks:get-accounts [options]
```

**Options:**

- `-a, --address`  
  Bank public key _(string)_
- `-s, --symbol`  
  Token symbol (e.g., 'USDC') _(string)_
- `-l, --limit`  
  Limit the number of accounts to return _(number, default: 5)_
- `-m, --min-balance`  
  Minimum balance to return _(number, default: 0.01)_
- `-t, --type`  
  Type of accounts to return

---

### `pnpm banks:configure-circuit-breaker`

**Description:**

Enables and configures the per-bank circuit breaker from
[scripts/admin/circuit_breaker_config.json](scripts/admin/circuit_breaker_config.json). Each
category in the JSON carries its own tiers, halt durations and window caps, and a list of banks;
to move a bank between categories, move its entry from one `banks` array to the other. Every
config is validated against the program's `validate_circuit_breaker` rules before anything is
fetched.

The script reads each bank's on-chain state and only builds an instruction for banks whose
breaker flag or settings differ from their category, so re-running it after a partial rollout
picks up just what is left. Banks in another group, banks with `FREEZE_SETTINGS` (where
`configure_bank` would succeed and silently ignore the config), and banks that already match are
reported and skipped.

Instructions are packed into v0 transactions using both shared LUTs, capped at 5 banks and 458
serialized bytes per transaction. That byte figure is the largest transaction known to import
into Squads, the rate-limit rollout's 15-instruction tranche; larger transactions that still fit
Solana's 1232-byte wire limit were rejected there. Pass `--max-bytes N` to raise it only after a
bigger transaction has imported successfully. Every emitted transaction is checked against the
cap before being printed as base58 for the multisig. A bank outside the LUTs costs 32 bytes
instead of 1, so extending a LUT with the remaining banks is how to fit more per transaction.

Enabling requires a positive cached price written within the last 30 seconds, so the keeper must
be pulsing the banks in a batch when its transaction executes. The report warns for every bank
that does not satisfy that gate at build time, including zero prices and future timestamps.

**Usage:**

```bash
pnpm banks:configure-circuit-breaker [--check]
```

**Options:**

- `--check`  
  Report what would change without building transactions
- `--category NAME`  
  Only banks in this category; repeat the flag for several
- `--only ADDRESS`  
  Only this bank; repeat the flag for several. Re-splits a transaction that was too large for the multisig without re-emitting banks already proposed
- `--max-bytes N`  
  Serialized bytes per transaction _(number, default: 458)_
- `--max-banks N`  
  Instructions per transaction _(number, default: 5)_

---

### `simulate-swb-feed`

**Description**  
Runs simulations for Switchboard price feeds in an infinite loop and saves simulation results in the `swb-sim-output-{DateTime}.csv` file.

**Usage**

```bash
pnpm ts-node scripts/simulate-swb-feed.ts <SWB_FEEDS_FILE> <CROSSBAR_URL> [all]
```

_Parameters:_

- **`SWB_FEEDS_FILE`** _(required)_ The KVP file with Switchboard price feed addresses. The [swb-feeds.kvp](data/all-banks.kvp) file can be taken as prototype.
- **`CROSSBAR_URL`** - _(required)_ the Switchboard Crossbar instance URL. Example: `https://crossbar.switchboard.xyz`
- **`all`** - _(optional)_ flag to crank all feeds in a single call

_Example_

```bash
[ -f swb-sim.out ] && rm swb-sim.out; nohup pnpm ts-node scripts/simulate-swb-feed.ts data/swb-feeds.kvp https://internal-crossbar.stage.mrgn.app > swb-sim.out 2>&1 &
```

### `simulate-swb-feed-dev`

tbd

### `crank-swb-feed`

**Description**  
Cranks Switchboard price feeds in an infinite loop and saves simulation results in the `swb-crank-output-{DateTime}.csv` file.

**Usage**

```bash
pnpm ts-node scripts/crank-swb-feed.ts <SWB_FEEDS_FILE> <CROSSBAR_URL> [all]
```

_Parameters:_

- **`SWB_FEEDS_FILE`** _(required)_ The KVP file with Switchboard price feed addresses. The [swb-feeds.kvp](data/all-banks.kvp) file can be taken as prototype.
- **`CROSSBAR_URL`** - _(required)_ the Switchboard Crossbar instance URL. Example: `https://crossbar.switchboard.xyz`
- **`all`** - _(optional)_ flag to run simulation for all feeds in a single call

_Example_

```bash
[ -f swb-crank.out ] && rm swb-crank.out; nohup pnpm ts-node scripts/crank-swb-feed.ts data/swb-feeds.kvp https://internal-crossbar.stage.mrgn.app > swb-crank.out 2>&1 &
```

### `fetch-jup-prices`

tbd

## Additional Help

Run any script with the `--help` flag for more details.

**Example:**

```bash
pnpm accounts:get --help
```
