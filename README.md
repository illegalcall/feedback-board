# Feedback Board

A decentralized sticky-note board on Polkadot. Pin your feedback, notes, or thoughts to a shared board — everyone using a remix of this app sees the same notes, because they all read from the same on-chain contract.

## How it works

- A **sticky note** is stored as JSON on the Bulletin Chain and gets a content-addressed CID.
- A **smart contract** on Asset Hub keeps an ordered list of those CIDs (plus the H160 of whoever posted each note).
- To render the board, the app reads all CIDs from the contract, fetches each note's JSON from a Bulletin IPFS gateway, and pins them up as sticky notes.
- Color and tilt of each note are derived deterministically from its CID — everyone sees the same board, but it still looks playfully random.

Because every remix uses the same `@example/feedback` contract, the board is shared across all forks.

## Stack — Paseo Next v2

- **Smart contract** — PVM (PolkaVM) on Paseo Asset Hub Next, managed via [CDM](https://github.com/paritytech/contract-dependency-manager)
- **Bulletin Chain** — host-mediated preimage submission via `@novasamatech/product-sdk` (`preimageManager`)
- **Account management** — `@novasamatech/product-sdk` `createAccountsProvider()` with the `"createTransaction"` signer path (preserves Paseo Next's `AsPgas` / `AsRingAlias` signed extensions). Requires Polkadot Desktop ≥ 0.3.10.
- **Contracts** — `@parity/product-sdk-contracts` `ContractManager` with lazy chain follow + `ensureContractAccountMapped` for Revive mapping.
- **Frontend** — React + Vite

## Setup

```bash
npm install
npm run dev
```

Open the app in Polkadot Desktop or Polkadot Mobile. Localhost dev mode uses a direct WS provider to Paseo Asset Hub Next.

> Deploying **your own copy** (own contract, own `.dot` name, published to the
> playground)? Follow the step-by-step [DEPLOYMENT.md](./DEPLOYMENT.md).

### Deploy contract (first time only)

```bash
cdm build
npm run deploy
cdm install @example/feedback -n paseo
```

`npm run deploy` targets Paseo Next v2 endpoints explicitly:

- Asset Hub: `wss://paseo-asset-hub-next-rpc.polkadot.io`
- Bulletin:  `wss://paseo-bulletin-next-rpc.polkadot.io`

`cdm install` updates [cdm.json](./cdm.json) with the deployed address. The repo ships with a placeholder address (`0x0…0`); after the first deploy, commit the updated `cdm.json` so remixes pick up the shared contract.

### Build & deploy frontend

```bash
npm run build:frontend
npx bulletin-deploy --env paseo-next-v2 ./dist <your-domain>.dot
```

## Remixing

This app is designed to be remixed via the Polkadot Playground. Forks keep the same contract address in `cdm.json`, so all remixes read and write to the same board.

Ideas to fork:

- Add reactions (like/heart counts per note)
- Group notes into columns by topic
- Add a "burn" countdown that fades notes after N days
- Allow image attachments stored on Bulletin
