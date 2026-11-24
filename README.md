# OrbitPad

A small token launchpad on **GIWA Sepolia testnet** (chainId 91342), built with the
[Ammora SDK](https://www.npmjs.com/package/@ammora-protocol/sdk) `@ammora-protocol/sdk@0.3.9` (auto-route generation).

Live: https://orbitpad-giwa.netlify.app/

> Built with the Ammora SDK. Not an official Ammora site. Testnet only, pre-audit — do not use real funds.

## Features

- Wallet connection (any EIP-1193 wallet, e.g. Rabby) with automatic add/switch to GIWA Sepolia. No private keys anywhere: every transaction is simulated, then signed in your wallet.
- **Launch a token**: name, ticker, description (stored as a `data:` JSON metadata URI).
  - With a first buy: `createConfigAndPoolWithFirstBuy` with a copy of Config #46's economics read on-chain — exact WETH approval → re-plan at a fresh block → `READY` → one transaction creating Config + token + first buy.
  - Without a first buy: `buildCreateAmmoraV4Launch` on the shared OrbitPad platform Config.
- **Platform Config #46**: the single source of OrbitPad economics (fees, Creator/Partner split, curve, 0.01 WETH graduation threshold, 100M sale supply); partner/LP/leftover recipient `0x7dE71b1d5936985182d30336e1AF1Ec399b7178B`. The site reads it on-chain and checks its hash, `enabled` flag and roles before every launch; if any check fails it shows why instead of launching. It was originally derived from template Config #6, which the site no longer reads (#6 is disabled on GIWA Sepolia).
- **Launch list**. The OrbitPad tab shows every OrbitPad launch since Config #46 (block 41,534,300). It finds them in `LaunchCreated` logs: Config #46, or metadata `app: "OrbitPad"` with the curve's partner confirmed on-chain. The site reads the logs in 10k-block windows (GIWA RPC's limit) and caches them in the browser, so later visits show the list at once and scan only new blocks. The All tab shows recent launches from `AmmoraDataApiClient`, or `LaunchCreated` logs over the last ~120k blocks when the API is down. Cards show status (Trading / Ready to migrate / Graduated) and graduation progress, painted first from the last cached read.
- **Token page**: curve status, progress, live quotes, buy/sell via `AmmoraV4LaunchCurveClient.planSwapExactInput` with exact-amount approvals and leftover-allowance cleanup, final-fill handling with `classifyAmmoraV4ExactInputFill` (partial fill only at the graduation boundary), permissionless **Migrate** via `planMigrateAtBlock`, and an SVG bonding-curve chart with the current point.
- Deterministic 8×8 pixel avatar per token address (nothing stored).
- Light/dark theme, mobile layout.

## Develop

```bash
npm ci --ignore-scripts
npm run dev
npm run build
npm run deploy   # production deploy to Netlify (run `npx netlify login` and `npx netlify link` once)
```

