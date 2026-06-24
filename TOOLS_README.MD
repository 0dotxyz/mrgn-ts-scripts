# TS CLI

## Requirements

* Node
* pnpm (`npm install -g pnpm@latest-10`)
* A wallet (with SOL) at  ~/keys/wallet.json


## Create Env File
* Under packages/tools create a `.env` file.
```
PRIVATE_RPC_ENDPOINT="https://rpc.ironforge.network/mainnet?apiKey=WHATEVER"
MARGINFI_WALLET=home/user/keys/wallet.json
MARGINFI_ENV="production"
```

## Run the Scripts
* `cd packages/tools`
* `pnpm install`
* `pnpm tools` to see list of available CLI tools

# One-Off scripts

## Requirements

* Node
* Repo dependencies installed (`npm install` or `yarn install`)
* A wallet (with SOL) at  ~/keys/wallet.json
* (Optional) create a .env.api and add API_URL=https://rpc.ironforge.network/mainnet?apiKey=WHATEVER

## Run the Scripts
* `cd scripts-ts`
* Run directly through Yarn's repo-local binary resolution:
  * `yarn ts-node path_to_script.ts`
* Or load the repo-local CLI binaries for bare `ts-node` commands:
  * with direnv: `direnv allow`
  * without direnv: `source .envrc`
* `ts-node path_to_script.ts`

## Disclaimer
One-off scripts are exactly that: meant to be ran once. Edit them to fit your immediate needs.
