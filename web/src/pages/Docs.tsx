import { ArrowSquareOutIcon, BookOpenIcon } from "@phosphor-icons/react";
import { Card, StatRow } from "../components/States";
import { deployment, isDeployed, ZERO_ADDRESS } from "../chain/deployment";
import { truncateAddress } from "../chain/format";

const REPO = "https://github.com/RonTuretzky/nyrent-cover";

const DOCS = [
  {
    href: "docs-site/index.html",
    title: "Docs site",
    desc: "Branded single-page overview: settlement rules, payout curve, addresses.",
    local: true,
  },
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
];

function addr(a: string): string {
  return a === ZERO_ADDRESS ? "not deployed" : truncateAddress(a);
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
          verify it yourself.
        </p>
      </header>

      <div className="space-y-3">
        {DOCS.map((doc) => (
          <a
            key={doc.title}
            href={doc.href}
            target={doc.local ? "_self" : "_blank"}
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

      <Card>
        <h2 className="font-parkDisplay font-bold text-lg mb-3">
          Contract addresses (Gnosis, chain {deployment.chainId})
        </h2>
        {!isDeployed ? (
          <p className="font-parkBody text-sm text-system-warning font-bold mb-2">
            Placeholders — not deployed yet.
          </p>
        ) : null}
        <StatRow label="Oracle" value={addr(deployment.oracle)} mono />
        <StatRow label="Cover pool" value={addr(deployment.pool)} mono />
        <StatRow label="Cover token" value={addr(deployment.token)} mono />
        <StatRow
          label="Currency (WXDAI)"
          value={addr(deployment.currency)}
          mono
        />
      </Card>
    </div>
  );
}
