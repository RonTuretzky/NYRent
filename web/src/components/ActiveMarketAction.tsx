import type { ReactNode } from "react";
import { useActiveMarket } from "../chain/useActiveMarket";
import { Card, EmptyState, LoadingSkeleton, RpcDownState } from "./States";
import { V4Trade } from "../pages/V4Trade";
import { lazy, Suspense } from "react";

const V4Settle = lazy(() => import("../pages/V4Settle").then((m) => ({ default: m.V4Settle })));

/** Primary routes operate only on the configured one market. Older markets
 * remain available through hidden routes and must never masquerade as it. */
export function ActiveMarketAction({ action, children }: { action: "buy" | "settle" | "redeem"; children: ReactNode }) {
  const market = useActiveMarket();
  if (market.isLoading) return <Card><LoadingSkeleton lines={3} /></Card>;
  if (market.isDemo && market.rpcError) return <RpcDownState />;
  if (market.isDemo) return (
    <EmptyState title={`${action === "buy" ? "Buy RENT" : action === "settle" ? "Settle this market" : "Redeem RENT"} · demo preview`}>
      This market is not configured for transactions on the selected network yet.
      The calculators show labeled examples; a matching on-chain market is required to {action}.
    </EmptyState>
  );
  if (market.source === "v4" && action !== "settle") {
    return <V4Trade mode={action === "redeem" ? "redeem" : "trade"} />;
  }
  if (market.source === "v4") {
    return <Suspense fallback={<Card><LoadingSkeleton lines={3} /></Card>}><V4Settle /></Suspense>;
  }
  return <>{children}</>;
}
