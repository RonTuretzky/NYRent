# Neighborhood policy journey

Runs the live UI against a local Gnosis fork with the shim wallet:

1. `anvil --fork-url $GNOSIS_RPC_URL --chain-id 100 --port 8599`
2. Deploy with `script/DeployApartments.s.sol` and put the addresses in
   `web/src/chain/apartments-deployment.json` for this build only.
3. `VITE_RPC_URL=http://127.0.0.1:8599 npm run build && npx vite preview --port 5176 --strictPort`
4. `REAL_ALERT_EML=/path/to/alert.eml npx playwright test -c e2e/apartments/playwright.config.ts`

`REAL_ALERT_EML` is optional. Without it the upload step is skipped. Fork state is
local, so nothing in that email is published.
