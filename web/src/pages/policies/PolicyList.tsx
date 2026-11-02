import { Link } from "react-router-dom";
import { Button } from "@decentralpark/ui";
import { POOLS } from "../../chain/apartments";
import { Card, EmptyState, LoadingSkeleton, RpcDownState, RpcStaleBanner } from "../../components/States";
import { NotDeployed, networkName, symbol, useNow } from "./shared";
import { EarlierRulesChip, PolicyCard, cardTestId, usePolicyRows } from "./listing";

export function PolicyList() {
  const { items, isLoading, rpcDown, stale, refetch } = usePolicyRows();
  const now = useNow();
  if (POOLS.length === 0) return <NotDeployed />;
  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-12 min-w-0">
      <div>
        <p className="font-parkBody font-bold">Permissionless rent protection on {networkName}</p>
        <h1 className="font-parkDisplay font-bold text-3xl sm:text-4xl mt-2">Neighborhood rent policies</h1>
        <p className="font-parkBody mt-4 leading-relaxed">
          Each policy names an Apartments.com neighborhood page and a month. Someone escrows {symbol} and sets a premium; renters
          buy protection; the first Google-signed alert of that month sets the headline rent, and the rent decides who gets paid.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/policies/guide"><Button>Step-by-step guide</Button></Link>
        <Link to="/policies/new"><Button variant="secondary">Create a policy</Button></Link>
        <Link to="/policies/submit"><Button variant="secondary">Record a rent</Button></Link>
      </div>
      <Card>
        <p className="font-parkBody text-sm leading-relaxed">
          These contracts are unaudited, ownerless and cannot be changed. This is not insurance and it does not pay based on your
          own lease: it pays on one publisher's headline figure. A policy that receives no qualifying email voids, so buyers get
          their premium back and the creator gets the escrow back. Only use money you can afford to lose.
        </p>
      </Card>
      {stale && <RpcStaleBanner />}
      {rpcDown ? <RpcDownState onRetry={() => void refetch()} /> : isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4" aria-busy="true">
          {[0, 1].map((i) => <Card key={i}><LoadingSkeleton lines={5} /></Card>)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title="No policies yet">
          <p>Nobody has opened a policy on {networkName}. <Link className="underline font-bold text-core-green" to="/policies/new">Create the first one</Link> or read the <Link className="underline font-bold text-core-green" to="/policies/guide">guide</Link>.</p>
        </EmptyState>
      ) : (
        <ul className="grid sm:grid-cols-2 gap-4 list-none p-0 m-0">
          {items.map((item) => (
            <li key={`${item.version}-${item.id}`} className="min-w-0">
              <PolicyCard item={item} now={now} testId={cardTestId("policy", item)} />
            </li>
          ))}
        </ul>
      )}
      {items.some((i) => i.version === "v1") && (
        <div className="flex flex-wrap items-start gap-3 font-parkBody text-sm text-surface-grey-2" data-testid="v1-explainer">
          <EarlierRulesChip />
          <p className="flex-1 min-w-60 leading-relaxed">
            Policies marked V1 were created on the first pool and keep its rules: sales close when the policy month starts, and claims open seven days after the month ends. New policies use the current pool, where the creator picks when sales close, sales stop once the month's rent is recorded, and claims open two days after the month.
          </p>
        </div>
      )}
    </div>
  );
}
