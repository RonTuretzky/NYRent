import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Chip } from "@decentralpark/ui";
import { ArrowSquareOutIcon, BookOpenIcon } from "@phosphor-icons/react";
import { Card, StatRow } from "../components/States";
import { deployment, isDeployed, ZERO_ADDRESS } from "../chain/deployment";
import { addressUrl, txUrl } from "../chain/explorer";
import { LIFECYCLE_TXS, SETTLEMENT_EMAIL_ID } from "../chain/lifecycle";
import { truncateAddress, truncateHex } from "../chain/format";

const REPO = "https://github.com/RonTuretzky/nyrent-cover";

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
        the demo strikes $88.00 → $96.00 put $92.88 at 61%.
      </>
    ),
  },
  {
    pool: true,
    body: (
      <>
        Solvency invariant: reserved claims never exceed the pool balance, the
        sponsor can only withdraw free capital, and pause never blocks redeem.
      </>
    ),
  },
];

function AddressLink({ address }: { address: string }) {
  if (address === ZERO_ADDRESS) return <>not deployed</>;
  return (
    <a
      href={addressUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-dotted"
    >
      {truncateAddress(address)}
    </a>
  );
}

export function Docs() {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Documentation
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Everything about how settlement works, what is trusted, and how to
          verify it yourself. The{" "}
          <Link to="/" className="underline decoration-dotted">
            home page
          </Link>{" "}
          has the how-it-works walkthrough and the payout-curve explainer;
          this page is the reference.
        </p>
        <div className="flex gap-2 flex-wrap mt-4">
          <Chip size="small">Gnosis · chainId {deployment.chainId}</Chip>
          <Chip size="small">Pinned key d=newyork.credaily.com s=b37</Chip>
          <Chip size="small">2026-09-17 issue: $92.88 / SF → 61% ratio</Chip>
          <Chip size="small">Unaudited demo — tiny amounts</Chip>
        </div>
      </header>

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

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">
          Contract addresses (Gnosis, chain {deployment.chainId})
        </h2>
        {!isDeployed ? (
          <p className="font-parkBody text-sm text-system-warning font-bold mb-2">
            Placeholders — not deployed yet.
          </p>
        ) : null}
        <StatRow
          label="Oracle"
          value={<AddressLink address={deployment.oracle} />}
          mono
        />
        <StatRow
          label="Cover pool"
          value={<AddressLink address={deployment.pool} />}
          mono
        />
        <StatRow
          label="Cover token"
          value={<AddressLink address={deployment.token} />}
          mono
        />
        <StatRow
          label="Currency (WXDAI)"
          value={<AddressLink address={deployment.currency} />}
          mono
        />
        {isDeployed ? (
          <p className="font-parkBody text-sm text-surface-grey-2 mt-3">
            Status: deployed · chainId {deployment.chainId} · series{" "}
            {deployment.seriesIds.join(", ")}. All three contracts are Sourcify
            exact_match verified.
          </p>
        ) : null}
      </Card>

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-1">
          Recorded lifecycle
        </h2>
        <p className="font-parkBody text-sm text-surface-grey-2 mb-2">
          Series 0 settled on-chain 2026-09-18 with the real 2026-09-17
          newsletter (emailId{" "}
          <span className="font-mono text-xs">
            {truncateHex(SETTLEMENT_EMAIL_ID, 6)}
          </span>
          ). Three permanent transactions:
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
                href={txUrl(tx.hash)}
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
