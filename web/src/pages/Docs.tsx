import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Chip } from "@decentralpark/ui";
import type { Icon } from "@phosphor-icons/react";
import {
  ArrowSquareOutIcon,
  BankIcon,
  BookOpenIcon,
  EnvelopeSimpleIcon,
  FileTextIcon,
  HandCoinsIcon,
  HouseIcon,
  PiggyBankIcon,
  PlugsIcon,
  ReceiptIcon,
  RobotIcon,
  ShieldCheckIcon,
  SwapIcon,
} from "@phosphor-icons/react";
import { Card, StatRow } from "../components/States";
import { useActiveDeployment } from "../chain/registry";
import { addressUrl, txUrl } from "../chain/explorer";
import { LIFECYCLE_TXS, SETTLEMENT_EMAIL_ID } from "../chain/lifecycle";
import { truncateAddress, truncateHex } from "../chain/format";

const REPO = "https://github.com/RonTuretzky/NYRent";

/** The retired sponsor-model Gnosis deployment — preserved verbatim as the
 * historical record (it settled with the real 2026-09-17 email). No live
 * reads ever touch these addresses. */
const LEGACY_GNOSIS_V1 = {
  explorerBase: "https://gnosis.blockscout.com",
  oracle: "0xdd45a0f7fcA25dD540625130d6c252b1880D0561",
  pool: "0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3",
  token: "0x48Db7336C15DC4439aE3F023e24FAA26b400CC87",
  windDownTx:
    "0x4b5175eacee972e65c018fd2ca4ccc37d0e15cee730aacc0aff79e3204878391",
} as const;

const DOCS = [
  {
    href: `${REPO}/blob/main/docs/PROTOCOL.md`,
    title: "PROTOCOL.md",
    desc: "The settlement statement — numbered acceptance rules, trust assumptions, limitations.",
  },
  {
    href: `${REPO}/blob/main/docs/VERIFICATION.md`,
    title: "VERIFICATION.md",
    desc: "Evidence chain for the pinned DKIM key and the verified fixture email.",
  },
  {
    href: `${REPO}/blob/main/docs/OPERATIONS.md`,
    title: "OPERATIONS.md",
    desc: "Deploy and settlement runbooks.",
  },
  {
    href: `${REPO}/blob/main/docs/TESTING.md`,
    title: "TESTING.md",
    desc: "The scenario matrix and how to run each suite.",
  },
  {
    href: `${REPO}/blob/main/docs/SPEC.md`,
    title: "SPEC.md",
    desc: "The frozen build specification: interfaces, fixtures ground truth, deployment plan.",
  },
  {
    href: `${REPO}/blob/main/fixtures/credaily-2026-09-17/EVIDENCE.md`,
    title: "Fixture evidence",
    desc: "The authenticated 2026-09-17 email: raw bytes, canonical goldens, DNS capture, Gmail authentication results.",
  },
];

/** One recorded guide GIF per flow, in journey order. `media` lives in
 * web/public/docs/ (vite copies public/ → dist, so the same file serves
 * GitHub Pages and this page). Recorded on a local Anvil / Gnosis
 * mainnet-fork stack — see the honesty note in the Guides section. */
interface Flow {
  id: string;
  n: number;
  icon: Icon;
  title: string;
  blurb: string;
  steps: string[];
  media: string;
  alt: string;
  /** Intrinsic GIF pixels, so lazy-loaded images reserve space. */
  width: number;
  height: number;
}

const FLOWS: Flow[] = [
  {
    id: "landing",
    n: 1,
    icon: HouseIcon,
    title: "See how it works",
    blurb: "The landing page walks the whole lifecycle before you connect anything.",
    steps: [
      "Open the app — no wallet needed to read anything.",
      "Scroll the five animated steps: fund → buy → email → settle → redeem.",
      "End on the payout curve — the settled 2026-09-17 issue printed $92.88/SF → 61%.",
    ],
    media: "landing.gif",
    alt: "Landing page without a wallet: hero, five animated how-it-works step cards, ending on the payout curve with the settled $92.88 to 61% dot.",
    width: 1000,
    height: 562,
  },
  {
    id: "connect-browse",
    n: 2,
    icon: PlugsIcon,
    title: "Browse series and connect",
    blurb: "Everything is readable without a wallet; connect only to act.",
    steps: [
      "Open Series and pick one — payout curve, lifecycle, capacity and solvency bars.",
      "Hit Connect and choose your wallet in the RainbowKit modal.",
      "Your account chip appears in the header — you are ready to transact.",
    ],
    media: "connect-browse.gif",
    alt: "Browsing the series list and Series #0 detail while disconnected, then connecting a wallet through the RainbowKit modal until the account chip shows in the header.",
    width: 900,
    height: 506,
  },
  {
    id: "sponsor-fund",
    n: 3,
    icon: BankIcon,
    title: "Sponsor: fund the pool",
    blurb: "Cover only exists once capital is on-chain — the sponsor deposits WXDAI first.",
    steps: [
      "On Sponsor, type the amount into Fund the pool.",
      "Approve WXDAI (step 1), then Fund pool (step 2).",
      "Pool state updates: pool balance and free capital rise, the solvency bar stays green.",
    ],
    media: "sponsor-fund.gif",
    alt: "Sponsor console funding the pool with 0.02 WXDAI in two steps, approve then fund, with confirmed transaction toasts and the updated pool-state solvency bar.",
    width: 900,
    height: 506,
  },
  {
    id: "buy",
    n: 4,
    icon: ReceiptIcon,
    title: "Buy cover with WXDAI",
    blurb: "Pay a fixed-rate premium, mint non-transferable cover units 1:1 with your max claim.",
    steps: [
      "Enter your max claim — the premium quote updates live.",
      "Open the pricing breakdown behind “Show the math”: your price, where it goes, how the payout ramps.",
      "Pick WXDAI (or xDAI), approve, then buy.",
      "Your cover balance appears once the transaction confirms.",
    ],
    media: "buy.gif",
    alt: "Buy page quoting a 0.00285 WXDAI premium on a 0.01 max claim, the pricing-transparency breakdown opened, then the approve-and-buy two-step confirming.",
    width: 900,
    height: 506,
  },
  {
    id: "buy-with-usdce",
    n: 5,
    icon: SwapIcon,
    title: "Pay the premium in USDC.e",
    blurb:
      "No pool currency? The buy page routes other tokens through the real Uniswap v3 pools. This recording shows the OLD four-step swap flow — the live app now does the whole thing in one router transaction.",
    steps: [
      "Choose USDC.e in the token selector — the quote reprices via QuoterV2.",
      "The recording then walks the old stepper: approve the swap, swap, approve the pool, buy — four confirmations.",
      "The live app collapses all of that: approve the payment token once (skipped entirely for the native coin), then ONE SwapAndBuyRouter transaction swaps, buys and refunds any unused input atomically.",
    ],
    media: "buy-with-usdce.gif",
    alt: "Buying 1 WXDAI of cover paying in USDC.e on a Gnosis mainnet fork: real Uniswap v3 quote, then a four-step stepper of approve swap, swap, approve pool, buy.",
    width: 900,
    height: 506,
  },
  {
    id: "settle",
    n: 6,
    icon: EnvelopeSimpleIcon,
    title: "Settle with the raw email",
    blurb: "Drop the CRE Daily .eml on the settle page — the EVM verifies DKIM and settles.",
    steps: [
      "Drag the raw .eml onto the dropzone.",
      "Watch the nine preflight checks flip green — pinned key, body hash, RSA-2048, $92.88 extraction.",
      "Record the observation on-chain, then settle.",
      "The series locks at its ratio — 61% for the 2026-09-17 issue. One shot; the first qualifying email wins.",
    ],
    media: "settle.gif",
    alt: "The real 2026-09-17 CRE Daily .eml dropped on the settle page, all nine DKIM preflight checks passing, record-observation and settle transactions confirming, ending on the 61% payout ratio.",
    width: 900,
    height: 506,
  },
  {
    id: "redeem",
    n: 7,
    icon: HandCoinsIcon,
    title: "Redeem your payout",
    blurb: "After settlement, burn cover units for maxClaim × ratio — redemption can never be paused.",
    steps: [
      "Open Redeem — the settled ratio and your cover balance load.",
      "Max fills your full balance; the preview shows exactly what you will receive.",
      "Redeem — the WXDAI lands and your cover balance drops to zero.",
    ],
    media: "redeem.gif",
    alt: "Redeem page after settlement at a 61% ratio: Max fills 0.01, the preview shows 0.0061 WXDAI, and the redeem transaction confirms with the balance dropping to zero.",
    width: 900,
    height: 506,
  },
  {
    id: "sponsor-withdraw",
    n: 8,
    icon: PiggyBankIcon,
    title: "Sponsor: withdraw free capital",
    blurb: "Reserved claims stay locked; the sponsor can only ever pull unreserved capital.",
    steps: [
      "After settlement, the Withdraw excess card shows what is free.",
      "Withdraw — the transaction confirms.",
      "Pool state re-settles, still fully collateralized against remaining claims.",
    ],
    media: "sponsor-withdraw.gif",
    alt: "Sponsor withdrawing 0.005 WXDAI of free capital after settlement, with the pool state settling at 0.01175 WXDAI and the fully-collateralized bar.",
    width: 900,
    height: 506,
  },
  {
    id: "docs",
    n: 9,
    icon: FileTextIcon,
    title: "Verify the real deployment",
    blurb: "This page carries the pinned key, the rules, and the real contract addresses and transactions.",
    steps: [
      "Scroll this page: the ten settlement rules and the verified contract addresses.",
      "Cross-check the recorded lifecycle — three permanent mainnet transactions.",
      "Follow the repository docs for the full evidence chain.",
    ],
    media: "docs.gif",
    alt: "Scrolling this docs page: the ten settlement rules, the real Gnosis contract addresses, the recorded-lifecycle transactions, and the repository docs list.",
    width: 900,
    height: 506,
  },
];

function FlowCard({ flow }: { flow: Flow }) {
  const FlowIcon = flow.icon;
  return (
    <Card>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="font-parkDisplay flex h-8 w-8 flex-none items-center justify-center rounded-full bg-core-green text-sm font-bold text-white"
        >
          {flow.n}
        </span>
        <FlowIcon size={24} className="text-core-green shrink-0" />
        <div>
          <h3 className="font-parkDisplay font-bold text-text-standard">
            {flow.title}
          </h3>
          <p className="font-parkBody text-sm text-surface-grey-2">
            {flow.blurb}
          </p>
        </div>
      </div>
      <ol className="font-parkBody list-decimal pl-5 mt-3 space-y-1 text-sm text-text-standard">
        {flow.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      <img
        src={import.meta.env.BASE_URL + "docs/" + flow.media}
        alt={flow.alt}
        loading="lazy"
        width={flow.width}
        height={flow.height}
        className="w-full h-auto rounded-xl border-2 border-paper-2 mt-4"
      />
    </Card>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-xs bg-paper-1 px-1 py-0.5 rounded">
      {children}
    </code>
  );
}

/** Oracle acceptance (green) and pool money-math (blue) rules, condensed
 * from docs/PROTOCOL.md's settlement statement. */
const RULES: { pool?: boolean; body: ReactNode }[] = [
  {
    body: (
      <>
        New email only: <Code>emailId = sha256(body)</Code> never seen before —
        replays revert.
      </>
    ),
  },
  {
    body: (
      <>
        The signed headers contain a <Code>from:</Code> line with{" "}
        <Code>&lt;mail@newyork.credaily.com&gt;</Code> and end with the
        canonical <Code>dkim-signature:</Code> line.
      </>
    ),
  },
  {
    body: (
      <>
        Strict tag policy: <Code>v=1</Code>, <Code>a=rsa-sha256</Code>,{" "}
        <Code>c=relaxed/relaxed</Code>, <Code>d=newyork.credaily.com</Code>,{" "}
        <Code>s=b37</Code>, empty <Code>b=</Code>, no <Code>l=</Code> —
        duplicates revert.
      </>
    ),
  },
  {
    body: (
      <>
        The signed <Code>bh=</Code> equals the base64 SHA-256 of the submitted
        body.
      </>
    ),
  },
  {
    body: (
      <>
        The signed timestamp is not in the future (
        <Code>t ≤ now + 1 day</Code>).
      </>
    ),
  },
  {
    body: (
      <>
        RSA-2048 PKCS#1 v1.5 verification against the immutable pinned
        modulus (keccak <Code>0x2f2f9938…4a41</Code>).
      </>
    ),
  },
  {
    body: (
      <>
        Template extraction: exactly one <Code>Manhattan Office Rent</Code>{" "}
        anchor, then <Code>Avg Effective</Code>, then <Code>$NN.NN / SF</Code>{" "}
        within bounded distance — quoted-printable decoded on the fly.
      </>
    ),
  },
  {
    pool: true,
    body: (
      <>
        A series settles against an observation whose <em>signed email time</em>{" "}
        lies in <Code>[obsStart, obsEnd]</Code>; the first successful settle
        wins, one-shot.
      </>
    ),
  },
  {
    pool: true,
    body: (
      <>
        Payout ratio = <Code>clamp((cents − low) / (high − low), 0, 1)</Code> —
        the reference strikes $88.00 → $96.00 put $92.88 at 61%.
      </>
    ),
  },
  {
    pool: true,
    body: (
      <>
        Per-series escrow: every claim unit is backed 1:1 by its own series'
        escrow (<Code>sold ≤ escrow</Code>), claims draw only from that
        escrow, and the creator's per-series pause never blocks settle or
        redeem. There is no global pause and no roles at all.
      </>
    ),
  },
];

function AddressLink({
  address,
  explorerBase,
}: {
  address: string;
  explorerBase: string;
}) {
  return (
    <a
      href={addressUrl(address, explorerBase)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted"
    >
      {truncateAddress(address)}
    </a>
  );
}

/** Verified Uniswap v3 payment routes per chain (docs/UNISWAP.md). */
const UNISWAP_ROUTES: Record<
  string,
  { token: string; note: string }[]
> = {
  "Gnosis Chain": [
    { token: "xDAI (native)", note: "wrapped 1:1 to WXDAI — no swap fee" },
    { token: "WXDAI", note: "the pool currency itself — no swap" },
    {
      token: "USDC.e",
      note: "0x2a22…76F0 · 0.01% fee pool → WXDAI",
    },
    {
      token: "GNO",
      note: "two hops: GNO → USDC.e (0.30%) → WXDAI (0.01%)",
    },
  ],
  "Arbitrum One": [
    { token: "ETH (native)", note: "wrapped to WETH, then 0.05% pool → USDC" },
    { token: "USDC", note: "the pool currency itself — no swap" },
    {
      token: "WETH",
      note: "0x82aF…bab1 · 0.05% fee pool → USDC",
    },
    { token: "USDT", note: "0.01% fee pool → USDC" },
    {
      token: "USDC.e",
      note: "0xFF97…5CC8 · 0.01% fee pool → USDC",
    },
    {
      token: "ARB",
      note: "0.05% pool (0.30% fallback) — depth is thin, so larger purchases may get a worse rate; the buy page shows the worst-case total before you confirm",
    },
  ],
};

export function Docs() {
  const { deployment } = useActiveDeployment();
  const routes = UNISWAP_ROUTES[deployment.name] ?? [];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Documentation
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          RentSafe pays you when the reported rent number goes up. This page
          is the full disclosure behind that sentence: exactly which rent
          number settles the market (an index of Manhattan office rent —
          commercial, not residential), how the signed newsletter is verified,
          what is trusted, and how to check everything yourself. The{" "}
          <Link to="/" className="underline decoration-dotted">
            home page
          </Link>{" "}
          has the plain-language walkthrough; this page is the reference.
        </p>
        <div className="flex gap-2 flex-wrap mt-4">
          <Chip size="small">
            {deployment.name} · chainId {deployment.chainId}
          </Chip>
          <Chip size="small">Pinned key d=newyork.credaily.com s=b37</Chip>
          <Chip size="small">2026-09-17 issue: $92.88 / SF → 61% ratio</Chip>
          <Chip size="small">Unaudited experiment — tiny amounts</Chip>
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="font-parkDisplay font-bold text-lg text-text-standard">
          Guides
        </h2>
        <p className="font-parkBody text-sm text-surface-grey-2 border-l-4 border-system-warning pl-3 py-0.5">
          Honesty note: these recordings were made on a local Anvil /
          Gnosis-mainnet-fork stack running the earlier sponsor-model
          contracts with the real 2026-09-17 newsletter <Code>.eml</Code> —
          that deployment's series 0 is already settled, so the flows cannot
          be re-recorded live. The live app is now the permissionless version
          (see Underwriting below); the settle and redeem mechanics shown are
          unchanged, while pay-with-any-token is now a single router
          transaction (flow 5 explains the difference). The permanent
          on-chain results are in the{" "}
          <button
            type="button"
            onClick={() =>
              document
                .getElementById("recorded-lifecycle")
                ?.scrollIntoView({ behavior: "smooth" })
            }
            className="underline decoration-dotted"
          >
            legacy-deployment table
          </button>{" "}
          below.
        </p>
        {FLOWS.map((flow) => (
          <FlowCard key={flow.id} flow={flow} />
        ))}
      </section>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-1">
          Settlement rules
        </h2>
        <p className="font-parkBody text-sm text-surface-grey-2 mb-4">
          The full statement with trust boundaries is in{" "}
          <a
            href={`${REPO}/blob/main/docs/PROTOCOL.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted"
          >
            PROTOCOL.md
          </a>
          . Rules 1–7 are the oracle's email acceptance (green); rules 8–10
          are the pool's money math (blue).
        </p>
        <ol className="space-y-2">
          {RULES.map((rule, i) => (
            <li
              key={i}
              className={`flex gap-3 border-l-4 pl-3 py-0.5 ${
                rule.pool ? "border-primary-sky" : "border-core-green"
              }`}
            >
              <span className="sr-only">
                {rule.pool ? "pool rule:" : "oracle rule:"}
              </span>
              <span
                className={`font-parkDisplay font-bold shrink-0 ${
                  rule.pool ? "text-primary-sky" : "text-core-green"
                }`}
              >
                {i + 1}
              </span>
              <span className="font-parkBody text-sm text-text-standard">
                {rule.body}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      {/* NEW: underwriting */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheckIcon size={22} className="text-core-green" />
          <h2 className="font-parkDisplay font-bold text-lg">Underwriting</h2>
        </div>
        <p className="font-parkBody text-sm text-text-standard">
          The pool is fully permissionless — there are NO roles in the
          contract. Anyone calls <Code>createSeries</Code> with strikes,
          premium rate, windows and capacity, and the call pulls the full
          capacity from the caller as that series' escrow. Every unit of
          protection sold is backed 1:1 by that escrow alone: accounting is
          strictly per series, so one creator's claims can never touch
          another's money.
        </p>
        <ul className="font-parkBody text-sm text-surface-grey-2 mt-3 space-y-1.5 list-disc pl-5">
          <li>
            Creator rights (and nothing more): pause their own series' sales,
            top up escrow before the sale ends, cancel while unsold (full
            refund), withdraw the residual — escrow + premiums − payouts —
            after the claim window. Terms themselves are immutable.
          </li>
          <li>
            <Code>saleEnd ≤ obsStart</Code> is enforced on-chain: sales close
            before a qualifying rent reading can exist, so nobody can buy a
            known outcome against the creator's escrow.
          </li>
          <li>
            The claim window must last ≥ 7 days after the observation window
            (<Code>MIN_REDEEM_WINDOW</Code>), so holders always get a real
            chance to settle and claim.
          </li>
        </ul>
        <p className="font-parkBody text-sm text-surface-grey-2 mt-3">
          Try it on the{" "}
          <Link to="/underwrite" className="underline">
            Underwrite page
          </Link>{" "}
          · full mechanics in{" "}
          <a
            href={`${REPO}/blob/main/docs/PROTOCOL.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted"
          >
            PROTOCOL.md
          </a>
          .
        </p>
      </Card>

      {/* NEW: pay with any token */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <SwapIcon size={22} className="text-core-green" />
          <h2 className="font-parkDisplay font-bold text-lg">
            Pay with any token — Uniswap
          </h2>
        </div>
        <p className="font-parkBody text-sm text-text-standard">
          The <Code>SwapAndBuyRouter</Code> makes any supported token a
          one-transaction purchase: it pulls your token (or wraps the native
          coin), exact-output swaps to exactly the quoted premium in the pool
          currency via Uniswap v3, buys the protection minted directly to
          YOU, and refunds every leftover wei. Ownerless, immutable, holds
          nothing between transactions; any failing leg reverts the whole
          call.
        </p>
        <div className="overflow-x-auto mt-3">
          <table className="w-full font-parkBody text-sm">
            <thead>
              <tr className="text-left text-surface-grey-2 border-b border-paper-2">
                <th className="py-2 pr-4">Token ({deployment.name})</th>
                <th className="py-2">Verified route</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.token} className="border-b border-paper-1">
                  <td className="py-2 pr-4 font-bold">{r.token}</td>
                  <td className="py-2 text-surface-grey-2">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="font-parkBody text-sm text-surface-grey-2 mt-3">
          Why is the protection itself never pooled on Uniswap? Cover is
          soulbound — it can't move after minting, so there is no secondary
          market to pool. Only the PREMIUM leg touches Uniswap; the cover
          mints straight to your address. Details and pool evidence in{" "}
          <a
            href={`${REPO}/blob/main/docs/UNISWAP.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted"
          >
            UNISWAP.md
          </a>
          .
        </p>
      </Card>

      {/* NEW: reference agent */}
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <RobotIcon size={22} className="text-core-green" />
          <h2 className="font-parkDisplay font-bold text-lg">
            The reference agent
          </h2>
        </div>
        <p className="font-parkBody text-sm text-text-standard">
          A two-sided market maker keeps the order book honest: it computes a
          fair value for each strike band from the rent-index history, then
          works both legs — UNDERWRITING new standard series when premiums
          would clear above fair value, and ARB-BUYING any cover offered
          below it. Inventory leans against whichever side it's overweight,
          so it never becomes a one-way seller.
        </p>
        <p className="font-parkBody text-sm text-surface-grey-2 mt-3">
          On Arbitrum the agent's keys live in Bankr custody rather than on
          the box running the loop. Design, policy knobs and run logs in{" "}
          <a
            href={`${REPO}/blob/main/agent/README.md`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted"
          >
            agent/README.md
          </a>
          .
        </p>
      </Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">
          Contract addresses ({deployment.name}, chain {deployment.chainId})
        </h2>
        <StatRow
          label="Oracle"
          value={
            <AddressLink
              address={deployment.oracle}
              explorerBase={deployment.explorerBase}
            />
          }
          mono
        />
        <StatRow
          label="Cover pool"
          value={
            <AddressLink
              address={deployment.pool}
              explorerBase={deployment.explorerBase}
            />
          }
          mono
        />
        <StatRow
          label="Cover token"
          value={
            <AddressLink
              address={deployment.token}
              explorerBase={deployment.explorerBase}
            />
          }
          mono
        />
        <StatRow
          label={`Currency (${deployment.currency.symbol})`}
          value={
            <AddressLink
              address={deployment.currency.address}
              explorerBase={deployment.explorerBase}
            />
          }
          mono
        />
        {deployment.router ? (
          <StatRow
            label="Swap-and-buy router"
            value={
              <AddressLink
                address={deployment.router}
                explorerBase={deployment.explorerBase}
              />
            }
            mono
          />
        ) : null}
        <p className="font-parkBody text-sm text-surface-grey-2 mt-3">
          Both live chains run the SAME permissionless contract version —
          switch chains in the header to see the other set. Use the chain
          switcher; nothing here reads the retired deployment below.
        </p>
      </Card>

      {/* Legacy deployment — the settled v1 record, preserved verbatim */}
      <Card>
        <h2
          id="recorded-lifecycle"
          className="font-parkDisplay font-bold text-lg mb-1 scroll-mt-24"
        >
          Legacy deployment (settled with the real 2026-09-17 email)
        </h2>
        <p className="font-parkBody text-sm text-surface-grey-2 mb-2">
          RETIRED — the original sponsor-model deployment on Gnosis. It is
          kept here purely as the historical record: its series 0 settled at
          0.61 with the real 2026-09-17 newsletter (emailId{" "}
          <span className="font-mono text-xs">
            {truncateHex(SETTLEMENT_EMAIL_ID, 6)}
          </span>
          ), and its series 1 was wound down — free capital withdrawn while
          all outstanding sold cover stays backed. The app never reads these
          contracts. All three are Sourcify exact_match verified.
        </p>
        <StatRow
          label="Oracle (retired)"
          value={
            <AddressLink
              address={LEGACY_GNOSIS_V1.oracle}
              explorerBase={LEGACY_GNOSIS_V1.explorerBase}
            />
          }
          mono
        />
        <StatRow
          label="Cover pool (retired)"
          value={
            <AddressLink
              address={LEGACY_GNOSIS_V1.pool}
              explorerBase={LEGACY_GNOSIS_V1.explorerBase}
            />
          }
          mono
        />
        <StatRow
          label="Cover token (retired)"
          value={
            <AddressLink
              address={LEGACY_GNOSIS_V1.token}
              explorerBase={LEGACY_GNOSIS_V1.explorerBase}
            />
          }
          mono
        />
        <p className="font-parkBody text-sm text-surface-grey-2 mt-3 mb-2">
          Series 0's full life — three permanent transactions:
        </p>
        {LIFECYCLE_TXS.map((tx) => (
          <div
            key={tx.step}
            className="py-2 border-b border-paper-1 last:border-b-0"
          >
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-parkDisplay font-bold text-sm text-text-standard">
                {tx.step}
              </span>
              <a
                href={txUrl(tx.hash, LEGACY_GNOSIS_V1.explorerBase)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs underline decoration-dotted break-all text-right"
              >
                {truncateHex(tx.hash, 8)}
              </a>
            </div>
            <p className="font-parkBody text-sm text-surface-grey-2 mt-0.5">
              {tx.note}
            </p>
          </div>
        ))}
        <div className="py-2 border-t border-paper-1 mt-1">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-parkDisplay font-bold text-sm text-text-standard">
              series 1 wind-down
            </span>
            <a
              href={txUrl(
                LEGACY_GNOSIS_V1.windDownTx,
                LEGACY_GNOSIS_V1.explorerBase,
              )}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs underline decoration-dotted break-all text-right"
            >
              {truncateHex(LEGACY_GNOSIS_V1.windDownTx, 8)}
            </a>
          </div>
          <p className="font-parkBody text-sm text-surface-grey-2 mt-0.5">
            Free capital withdrawn; outstanding sold cover remains fully
            backed until its claim window closes.
          </p>
        </div>
      </Card>

      <div className="space-y-3">
        <h2 className="font-parkDisplay font-bold text-lg text-text-standard">
          Repository docs
        </h2>
        {DOCS.map((doc) => (
          <a
            key={doc.title}
            href={doc.href}
            target="_blank"
            rel="noopener noreferrer"
            className="block group"
          >
            <Card className="transition-colors group-hover:border-core-green">
              <div className="flex items-center gap-3">
                <BookOpenIcon size={24} className="text-core-green shrink-0" />
                <div className="flex-1">
                  <p className="font-parkDisplay font-bold text-text-standard">
                    {doc.title}
                  </p>
                  <p className="font-parkBody text-sm text-surface-grey-2">
                    {doc.desc}
                  </p>
                </div>
                <ArrowSquareOutIcon size={20} className="text-surface-grey" />
              </div>
            </Card>
          </a>
        ))}
      </div>

      <p className="font-parkBody text-xs text-surface-grey-2">
        Unaudited software. Fully collateralized but experimental — use tiny
        amounts. The index is commercial office rent (CompStak via CRE Daily),
        not residential.
      </p>
    </div>
  );
}
