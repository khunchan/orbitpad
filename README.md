# OrbitPad

A small token launchpad on **GIWA Sepolia testnet** (chainId 91342), built with the
[Ammora SDK](https://www.npmjs.com/package/@ammora-protocol/sdk) `@ammora-protocol/sdk@0.3.9` (auto-route generation).

Live: https://orbitpad-giwa.netlify.app/

> Built with the Ammora SDK. Not an official Ammora site. Testnet only, pre-audit — do not use real funds.

## Features

- Wallet connection (any EIP-1193 wallet, e.g. Rabby) with automatic add/switch to GIWA Sepolia. No private keys anywhere: every transaction is simulated, then signed in your wallet.
- **Launch a token**: name, ticker, description (stored as a `data:` JSON metadata URI).
  - With a first buy: `createConfigAndPoolWithFirstBuy` — exact WETH approval → re-plan at a fresh block → `READY` → one transaction creating Config + token + first buy.
  - Without a first buy: `buildCreateAmmoraV4Launch` on the shared OrbitPad platform Config.
- **Platform Config**: derived from reviewed template Config #6 with a 0.01 WETH graduation threshold and 100M sale supply; partner/LP/leftover recipient `0x4cB75146e98562C9d79b31649C6C739e4DCB7CD5`. Created from the site with a button.
- **Recent launches** from `AmmoraDataApiClient`, falling back to `LaunchCreated` logs over RPC. Shows status (Trading / Ready to migrate / Graduated) and graduation progress.
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

`src/config-from-template.ts` is adapted from [AmmoraLabs/ammora-examples](https://github.com/AmmoraLabs/ammora-examples) (MIT).
