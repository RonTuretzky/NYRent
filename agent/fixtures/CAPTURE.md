# Fixture provenance

Every file here is a REAL captured response — no fixture is fabricated or
edited. They exist solely so the parser unit tests
(`agent/collectors/*.test.mjs`, run with `node --test`) are deterministic and
offline; the collectors themselves always hit the live endpoints.

- **Captured:** 2026-09-18 (America/New_York), 2026-09-19T03:0xZ UTC
- **User-Agent used for every HTTP capture** (same one the collectors send):
  `Mozilla/5.0 (compatible; nyrent-agent/0.1; +https://github.com/RonTuretzky/nyrent-cover)`
- HTTP captures via `curl -sL --max-time 40 -A "$UA" <url>`; the on-chain
  capture via viem `readContract` (see below). All HTTP responses were
  status 200 at capture time.

| File | Source URL / origin |
| --- | --- |
| `credaily-ny-index.html` | https://www.credaily.com/newsletters/new-york/ (archive index, newest issue first) |
| `credaily-issue-nyc-c-pace-revamp.html` | https://www.credaily.com/newsletters/new-york/issue/nyc-c-pace-revamp-could-unlock-more-cre-capital/ — published 2026-09-17, carries **$92.88 / SF**, the exact value of on-chain observation #0 |
| `credaily-issue-brookfield-ai-office-hub.html` | https://www.credaily.com/newsletters/new-york/issue/brookfield-bets-3-5b-on-manhattans-rising-ai-office-hub/ — published 2026-07-14, carries the older **$85.03 / SF** |
| `kalshi-markets-KXMANOFFVAC.json` | https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMANOFFVAC |
| `kalshi-markets-KXNYCRENTSY.json` | https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNYCRENTSY |
| `kalshi-markets-KXNYCASKRENT.json` | https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNYCASKRENT |
| `kalshi-markets-KXMANHATTANRENT.json` | https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMANHATTANRENT |
| `kalshi-series-economics.json` | https://api.elections.kalshi.com/trade-api/v2/series?category=Economics (879 series; used by discovery-filter tests) |
| `cushman-manhattan-office.html` | https://www.cushmanwakefield.com/en/united-states/insights/us-marketbeats/new-york-city-area-marketbeats/manhattan-office (Q2 2026: vacancy 19.3%, overall asking $72.83/SF) |
| `commercialobserver-feed.xml` | https://commercialobserver.com/feed/ (17 items at capture) |
| `therealdeal-new-york-feed.xml` | https://therealdeal.com/new-york/feed/ (10 items at capture; the site's AWS WAF requires a `Mozilla/5.0`-prefixed UA) |
| `bls-CUURS12ASEHA.json` | https://api.bls.gov/publicAPI/v2/timeseries/data/CUURS12ASEHA (CPI rent of primary residence, NY metro; latest August 2026 = 509.228) |
| `oracle-observations.json` | Gnosis mainnet (chainId 100) read of CredailyRentOracle `0xdd45a0f7fcA25dD540625130d6c252b1880D0561` via viem over https://rpc.gnosischain.com — `observationCount()` + `observations(i)`; recorded 2026-09-19T03:11:58Z by `collectors/oracle.mjs`'s `collectOracle()` |

Note on probed-but-excluded sources (2026-09-18): Colliers
(`colliers.com/en/research`) and Moody's CommercialEdge
(`commercialedge.com/blog/national-office-report/`) return CDN 403s to
non-browser clients, and `compstak.com/insights` 404s; they are intentionally
not collected rather than mocked.

Redaction note: the Cushman & Wakefield capture embedded the site's own Google Maps browser key; it is redacted here (and purged from git history) because the string is secret-shaped and was unrestricted at capture time. The redaction does not affect any parser test.
