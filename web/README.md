# web — NY Rent Cover frontend

Vite + React + TS app implementing SPEC §4. Decentral Park branded
(`@decentralpark/ui`, vendored tarball in `vendor/` for hermetic builds),
wagmi v2 + RainbowKit v2 **injected-only by default** (no WalletConnect
network calls), hash router (GitHub-Pages safe). Setting
`VITE_WALLETCONNECT_PROJECT_ID` (a Reown/WalletConnect Cloud projectId) at
build time additionally enables the WalletConnect, Coinbase and Safe wallets.

## Commands

```bash
npm install        # installs @decentralpark/ui from vendor/*.tgz
npm run dev        # vite dev server on 127.0.0.1:5174
npm run build      # production build → dist/ (this is the CI gate)
npm run preview    # serve dist/ on 127.0.0.1:5174
npm run typecheck  # tsc --noEmit (app + e2e-shim)
npm run lint       # eslint src e2e-shim
npm test           # emailkit unit tests (node --test, owned by src/lib)
```

## Layout

- `src/lib/emailkit.ts`, `src/lib/abi.ts` — shared library owned by the
  emailkit workstream. All UI access goes through the adapters
  `src/emailkit/bridge.ts` and `src/chain/contracts.ts`; don't import
  `src/lib` anywhere else.
- `src/chain/` — wagmi config (Gnosis; `VITE_RPC_URL` env can override the RPC,
  and a non-100 `deployment.json` chainId targets a local anvil), typed reads
  with per-block refetch, tx state machine (`useTx`: simulate → wallet →
  pending → confirmed/reverted) and custom-error → human-copy decoding.
- `src/components/HowItWorks.tsx` — the crowdstake.fun-mechanics explainer
  (stepper + autoplay + per-step animated stage) drawn as our own SVG in brand
  colors.
- `src/deployment.json` — written by deploy tooling. While addresses are zero
  the app renders a "Not deployed yet" banner and disables chain reads.
- `e2e-shim/` — EIP-1193 test wallet for Playwright (`installTestWallet`),
  **never** imported from `src/`, so it can't reach production bundles. See
  its README.
- `vendor/` — `npm pack` output of the Decentral Park UI kit; rebuild it from
  the kit repo (`npm run build && npm pack`) when the kit changes, then update
  the `file:` dependency if the version bumps.
