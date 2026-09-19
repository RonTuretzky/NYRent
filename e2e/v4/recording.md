# Website walkthrough recordings

The recording harness drives the actual React UI. It adds only a visible cursor,
caption overlay and extra bottom space so captions do not cover the active form.
There are no mocked transaction results or edited market values.

Run commands from `e2e/`:

```sh
npx playwright test -c v4/record.config.ts
RECORD_LIVE_URL=http://127.0.0.1:5205 npx playwright test -c v4/record.live.config.ts
```

The lifecycle recorder owns ports 8559 and 5199 and must run separately from the
v4 regression configuration. It reuses the isolated global setup, real Uniswap v4
contracts, synthetic USDC and test-key signed emails. It checks balances and
contract state after the mint, liquidity deposit, buy, sell, oracle submission,
settlement, both redemptions and final residual withdrawal. Its captions explain
when the local clock advances. This is not a future Polygon settlement.

The separate Polygon recording installs no wallet, submits no transactions and
reads the production-configured interface. The UI origin may be a local preview
of the current revision; its network and prices come from Polygon mainnet. Keep
that preview on the production manifest while capturing.

`RECORD_DRAFT=1 RECORD_PACE=0.04` accelerates presentation pauses and validates
selectors without publishing assets. Use normal pacing for the website output.
Draft and final raw WebM files are ignored under `v4/.artifacts/recordings/`.

Final MP4s, poster JPEGs, individual chapter MP4s and JSON metadata are generated
under `web/public/guides/`. JSON includes capture time, chapter positions and the
verification scope. The lifecycle metadata also includes its local transaction
hashes and checked amounts. The `/docs/walkthrough` page plays these static
assets. `ffmpeg` and `ffprobe` must be available on `PATH` for encoding.

Inspect representative frames before publishing. After building the site, verify
both video URLs, posters, chapter metadata, seeking and playback in a browser.
