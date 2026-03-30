# JupLend Bank Management

Scripts for creating and managing JupLend banks on the Marginfi protocol.

## Config Generation

Bank configs are **generated, not hand-written**. A single generator script
combines four data sources into per-bank JSON files for each environment.

### Data Sources

```
environments.json ──┐
bank-params.json ───┤
juplend-assets.json ┼──▶ generate_configs.ts ──▶ configs/<env>/<symbol>.json
oracles.json ───────┘
```

**`configs/environments.json`** — environment-specific program and group:

```json
{
  "stage": {
    "programId": "stag8sTKds2h4KzjUw3zKTsxbqvT4XKHdaR9X9E6Rct",
    "group": "FCPfpHA69EbS8f9KKSreTRkXbzFpunsKuYf5qNmnJjpo"
  },
  "prod": {
    "programId": "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    "group": "<prod-group-address>"
  }
}
```

**`configs/bank-params.json`** — per-asset risk parameters and metadata
(shared across all environments):

```json
{
  "defaults": {
    "seed": 600,
    "riskTier": "collateral",
    "configFlags": 1
  },
  "banks": [
    {
      "symbol": "WSOL",
      "mint": "So11111111111111111111111111111111111111112",
      "fullName": "Wrapped SOL",
      "category": "Native",
      "tokenProgram": "SPL Token",
      "decimals": 9,
      "assetWeightInit": "0.75",
      "assetWeightMaint": "0.85",
      "depositLimit": "150000000000000",
      "totalAssetValueInitLimit": "20000000",
      "oracleMaxAge": 70
    }
  ]
}
```

Fields in `defaults` apply to all banks unless overridden per-bank. Each bank
entry requires:

| Field | Description |
|-------|-------------|
| `symbol` | Token symbol, must match `juplend-assets.json` |
| `mint` | SPL token mint address |
| `fullName` | Human-readable name (used in metadata ticker/description) |
| `category` | `Native`, `Stablecoin`, etc. (used in metadata description) |
| `tokenProgram` | `SPL Token` or `Token-2022` (informational, in comments) |
| `decimals` | Token decimals (informational, in comments) |
| `assetWeightInit` | Initial collateral weight (e.g. `"0.75"`) |
| `assetWeightMaint` | Maintenance collateral weight (e.g. `"0.85"`) |
| `depositLimit` | Max deposit in native units as string |
| `totalAssetValueInitLimit` | Max total asset value in USD as string |
| `oracleMaxAge` | Max oracle staleness in seconds |

Optional per-bank overrides: `riskTier` (`"collateral"` or `"isolated"`),
`configFlags`.

**`configs/juplend-assets.json`** — JupLend lending PDAs per mint (fetched
from on-chain). Provides `juplendLending` and `fTokenMint` for each asset:

```json
{
  "juplendProgram": "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
  "lendingAdmin": "5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6",
  "bankSeed": 600,
  "assets": [
    {
      "symbol": "WSOL",
      "lending": "BeAqbxfr...",
      "fTokenMint": "2uQsyo1f...",
      "mint": "So111111..."
    }
  ]
}
```

Refresh from on-chain with:

```bash
npx tsx scripts/juplend/helpers/dump_juplend_assets.ts
```

**`dumps/artefacts/oracles.json`** — oracle addresses and types per mint
(fetched from on-chain Marginfi banks). Provides `oracle`, `oracleSetup`.

### Running the Generator

```bash
npx tsx scripts/juplend/helpers/generate_configs.ts stage
npx tsx scripts/juplend/helpers/generate_configs.ts prod
```

Output: `configs/stage/wsol.json`, `configs/stage/usdc.json`, etc.

The generator validates that each asset has entries in both
`juplend-assets.json` and `oracles.json`, skipping any that are missing.
Each generated config includes a derived `bankAddress` in the `comments`
field for verification.

### Generated Config Format

Each file (e.g. `configs/stage/wsol.json`) contains everything needed by
`add_bank.ts` and `bank_metadata.ts`:

```json
{
  "programId": "stag8sTK...",
  "group": "FCPfpHA6...",
  "bankMint": "So111111...",
  "juplendLending": "BeAqbxfr...",
  "fTokenMint": "2uQsyo1f...",
  "oracle": "4Hmd6Pdj...",
  "oracleSetup": "juplendSwitchboardPull",
  "seed": 600,
  "assetWeightInit": "0.75",
  "assetWeightMaint": "0.85",
  "depositLimit": "150000000000000",
  "totalAssetValueInitLimit": "20000000",
  "riskTier": "collateral",
  "oracleMaxAge": 70,
  "configFlags": 1,
  "ticker": "WSOL | Wrapped SOL",
  "description": "Wrapped SOL | Native | WSOL | JupLend",
  "comments": {
    "asset": "Wrapped SOL",
    "tokenProgram": "SPL Token",
    "decimals": 9,
    "bankAddress": "E3C8YBqd..."
  }
}
```

| Field | Source | Description |
|-------|--------|-------------|
| `programId` | environments.json | Marginfi program for this env |
| `group` | environments.json | Marginfi group for this env |
| `bankMint` | bank-params.json | Token mint address |
| `juplendLending` | juplend-assets.json | JupLend lending PDA |
| `fTokenMint` | juplend-assets.json | JupLend fToken mint PDA |
| `oracle` | oracles.json | Oracle feed address |
| `oracleSetup` | oracles.json | `juplendPythPull` or `juplendSwitchboardPull` |
| `seed` | bank-params.json defaults | Bank PDA seed (600) |
| `assetWeightInit` | bank-params.json | Initial collateral weight |
| `assetWeightMaint` | bank-params.json | Maintenance collateral weight |
| `depositLimit` | bank-params.json | Max deposit (native units) |
| `totalAssetValueInitLimit` | bank-params.json | Max total value (USD) |
| `riskTier` | bank-params.json | `collateral` or `isolated` |
| `oracleMaxAge` | bank-params.json | Max oracle staleness (seconds) |
| `configFlags` | bank-params.json | Bank config flags |
| `ticker` | generated | `"SYMBOL \| Full Name"` |
| `description` | generated | `"Full Name \| Category \| Symbol \| JupLend"` |
| `comments.bankAddress` | derived | Bank PDA (for verification) |

### Adding a New Asset

1. Ensure the JupLend lending pool exists on-chain
2. Run `helpers/dump_juplend_assets.ts` to refresh `juplend-assets.json`
3. Run `dumps/dump_oracles.ts` to refresh oracle data
4. Add the asset entry to `bank-params.json` with risk parameters
5. Run `helpers/generate_configs.ts <env>`

## Bank Lifecycle

All scripts take a **config file** as the first argument. The bank PDA is
derived from `programId`, `group`, `bankMint`, and `seed` in the config.

All scripts have a `sendTx` flag at the top. When `false` (default), they
output an unsigned base58-encoded transaction for multisig signing. When
`true`, they sign and broadcast directly.

### 1. Create bank

```bash
npx tsx scripts/juplend/add_bank.ts <config-file>
```

```bash
npx tsx scripts/juplend/add_bank.ts configs/stage/wsol.json
```

Calls `lendingPoolAddBankJuplend` with the full bank config (oracle, risk
weights, deposit limits, JupLend CPI accounts).

### 2. Write metadata

```bash
npx tsx scripts/juplend/bank_metadata.ts <config-file>
```

```bash
npx tsx scripts/juplend/bank_metadata.ts configs/stage/wsol.json
```

Two steps: `initBankMetadata` (permissionless, pays rent) then
`writeBankMetadata` (metadata admin only). Reads `ticker` and `description`
from the config file.

### 3. Init position (seed deposit)

```bash
npx tsx scripts/juplend/init_position.ts <config-file> <amount>
```

```bash
npx tsx scripts/juplend/init_position.ts configs/stage/wsol.json 10000
```

Amount is in base units (lamports for SOL, smallest unit for SPL tokens).
Handles WSOL wrapping automatically when the mint is native SOL.

### 4. Deposit

```bash
npx tsx scripts/juplend/deposit.ts <config-file> <marginfi-account> <amount>
```

```bash
npx tsx scripts/juplend/deposit.ts configs/stage/usdc.json 89ViS63B... 100000
```

Detects token program (SPL Token vs Token-2022) and creates the ATA
automatically.

### 5. Withdraw

```bash
npx tsx scripts/juplend/withdraw.ts <config-file> <marginfi-account> <amount> [--all]
```

```bash
npx tsx scripts/juplend/withdraw.ts configs/stage/usdc.json 89ViS63B... 100000
npx tsx scripts/juplend/withdraw.ts configs/stage/usdc.json 89ViS63B... 0 --all
```

Pass `--all` to withdraw the entire balance (amount is required but ignored).

### 6. Close bank

```bash
npx tsx scripts/juplend/close_bank.ts <config-file>
```

```bash
npx tsx scripts/juplend/close_bank.ts configs/stage/usdc.json
```

Bank must have zero deposits.

### Script Reference

| Script | Args | Description |
|--------|------|-------------|
| `add_bank.ts` | `<config>` | Create a new bank |
| `bank_metadata.ts` | `<config>` | Write ticker/description metadata |
| `init_position.ts` | `<config> <amount>` | Seed deposit to activate bank |
| `deposit.ts` | `<config> <account> <amount>` | Deposit into bank |
| `withdraw.ts` | `<config> <account> <amount> [--all]` | Withdraw from bank |
| `close_bank.ts` | `<config>` | Close empty bank |

All `<config>` paths are relative to `scripts/juplend/`
(e.g. `configs/stage/wsol.json`).

## Environment

Scripts load RPC from `.env.api` (`API_URL` key). Falls back to public
mainnet RPC. Wallet path is set per-script (default: `/keys/staging-deploy.json`).
