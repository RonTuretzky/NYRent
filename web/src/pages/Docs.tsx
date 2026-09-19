import { Link } from "react-router-dom";
import { ArrowsLeftRightIcon, NewspaperIcon, PlayCircleIcon } from "@phosphor-icons/react";
import { Card } from "../components/States";
import { useActiveMarket } from "../chain/useActiveMarket";
import { formatCents, formatDate } from "../chain/format";
import { useActiveDeployment } from "../chain/registry";
import { V4_DEPLOYMENTS } from "../chain/v4";
import { addressUrl } from "../chain/explorer";

export function Docs() {
  const market = useActiveMarket();
  const { deployment } = useActiveDeployment();
  const v4 = V4_DEPLOYMENTS[String(deployment.chainId)];
  return <div className="max-w-3xl min-w-0 mx-auto space-y-6 [&_p]:leading-relaxed [&_li]:leading-relaxed">
    <header><h1 className="font-parkDisplay font-bold text-2xl leading-tight sm:text-3xl">How Manhattan Rent Cover works</h1>
      <p className="font-parkBody text-surface-grey-2 mt-2">One market follows the CRE Daily Manhattan Office Rent average effective rent index, measured in dollars per square foot. It tracks office rents, not residential leases.</p>
    </header>
    <div className="grid gap-4 sm:grid-cols-3">
      <Link to="/docs/uniswap" className="group rounded-2xl border border-paper-2 bg-paper-1 p-5 transition-colors hover:border-core-green focus-visible:outline-2 focus-visible:outline-core-green">
        <ArrowsLeftRightIcon size={28} className="text-core-green" weight="bold" />
        <h2 className="font-parkDisplay mt-3 text-lg font-bold">The Uniswap integration</h2>
        <p className="font-parkBody mt-2 text-sm text-surface-grey-2">An illustrated tour of backing, trading, the v4 hook and redemption.</p>
        <span className="font-parkBody mt-4 inline-block text-sm font-semibold text-core-green">See how it works →</span>
      </Link>
      <Link to="/docs/walkthrough" className="group rounded-2xl border border-paper-2 bg-paper-1 p-5 transition-colors hover:border-core-green focus-visible:outline-2 focus-visible:outline-core-green">
        <PlayCircleIcon size={28} className="text-core-green" weight="bold" />
        <h2 className="font-parkDisplay mt-3 text-lg font-bold">Watch the walkthrough</h2>
        <p className="font-parkBody mt-2 text-sm text-surface-grey-2">Follow the renter, insurer, signed-email oracle and redemption flows.</p>
        <span className="font-parkBody mt-4 inline-block text-sm font-semibold text-core-green">Open recordings →</span>
      </Link>
      <Link to="/docs/sources" className="group rounded-2xl border border-paper-2 bg-paper-1 p-5 transition-colors hover:border-core-green focus-visible:outline-2 focus-visible:outline-core-green">
        <NewspaperIcon size={28} className="text-core-green" weight="bold" />
        <h2 className="font-parkDisplay mt-3 text-lg font-bold">The source archive</h2>
        <p className="font-parkBody mt-2 text-sm text-surface-grey-2">The seven publications we indexed, their editions and the live oracle source.</p>
        <span className="font-parkBody mt-4 inline-block text-sm font-semibold text-core-green">Explore the evidence →</span>
      </Link>
    </div>
    {v4 ? <Card>
      <h2 className="font-parkDisplay font-bold text-xl">On-chain market · {deployment.name}</h2>
      <p className="font-parkBody mt-3">RENT trades against native {v4.symbol} on {deployment.name} (chain {deployment.chainId}). Its backing and trading liquidity stay on this network.</p>
      <div className="font-parkBody mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {[["RENT and escrow", v4.market], ["Uniswap v4 hook", v4.hook], ["Signed-rent oracle", v4.oracle]].map(([label, address]) =>
          <a key={address} className="inline-flex min-h-11 items-center rounded-lg underline text-core-green focus-visible:outline-2 focus-visible:outline-core-green" href={addressUrl(address, deployment.explorerBase)} target="_blank" rel="noreferrer">{label} ↗</a>
        )}
      </div>
    </Card> : null}
    <Card><h2 className="font-parkDisplay font-bold text-xl">The fixed terms</h2>
      <p className="font-parkBody mt-3">The market uses a signed September 2026 oracle observation as its base. {market.baseIsDemo ? "The recorded base is currently unavailable on this network." : <>The authenticated base is {formatCents(market.baseCents)}/SF.</>}</p>
      <p className="font-parkBody mt-3">The first successful settlement transaction fixes the payout using a qualifying observation for September 2027; the contract cannot prove that no earlier email was withheld. Growth is g = settlement / base − 1. RENT pays nothing through 3% growth, increases linearly to $1 at 8%, and stays capped at $1 above that.</p>
      <p className="font-mono break-words text-xs sm:text-sm my-4 rounded-lg bg-paper-1 p-3">r = clamp((g − 0.03) / 0.05, 0, 1)</p>
      <p className="font-parkBody">Contracts using cent-denominated strikes settle against {formatCents(market.strikeLowCents)} and {formatCents(market.strikeHighCents)}. Cent rounding can differ slightly from the ideal percentage curve; the contract's integer formula determines the actual payout.</p>
      <p className="font-parkBody mt-3">Sales close {formatDate(market.saleEnd)}. Observation runs {formatDate(market.obsStart)} through {formatDate(market.obsEnd)}. Claims close {formatDate(market.redeemEnd)}. The configured sale window cannot extend beyond the start of observation.</p>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">PLATFORM, INSURER and RENTER</h2>
      <ul className="font-parkBody mt-3 space-y-3 list-disc pl-5">
        <li><strong>PLATFORM</strong> specifies the index, oracle rules, coverage band and windows. The terms become immutable when the market is created. Backing stays in the escrow contract until claims and the residual withdrawal.</li>
        <li><strong>INSURER</strong> supplies the backing: one dollar-stable unit per RENT. The market creator chooses the opening price when the pool is initialized. Insurers can then provide separate RENT/stablecoin liquidity at the pool's existing price. The maximum RENT and USDC inputs are deposit budgets, not controls for resetting the price. Trading payments become pool inventory; LP fees and assets belong to the liquidity position rather than arriving directly in the insurer's wallet. For example, backing 1,000 RENT takes 1,000 USDC in escrow, and supplying them to a full-range pool at $0.285 needs roughly 285 more USDC. Retained and pool-held RENT still carries a redemption claim.</li>
        <li><strong>RENTER</strong> pays a premium, receives RENT, and can claim r times the token balance after settlement. Trading out before observation depends on an enabled trading pool and available liquidity; the fixed-rate fallback has no resale flow.</li>
      </ul>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">What the calculators mean</h2>
      <p className="font-parkBody mt-3">For annual rent R, buying R × 5% RENT covers the five-percentage-point band in the model. It does not cover your entire rent increase. At R = $60,000 and an assumed average purchase price p = $0.285, the model calls for 3,000 RENT at a cost of $855, breaks even at 4.425% index growth and pays at most $3,000. This is a scenario calculation; the live pool quote can differ because of fees and price impact, or the pool may not have enough RENT to fill it.</p>
      <p className="font-parkBody mt-3">The insurer model counts sale proceeds p × u × C and claims r × u × C. For $100,000 of capital with 10% sold at an average $0.285, modeled proceeds are $2,850 and the worst net is −$7,150. Retained RENT is the insurer's own claim on backing and must still be redeemed. This simplified sold-inventory model does not simulate an LP position's changing inventory or trading fees.</p>
      <p className="font-parkBody mt-3">At the same assumed average price, both sides break even at 4.425% index growth in the model. Selling more RENT increases both proceeds and the payout exposure; it does not change the per-token payout formula.</p>
      <p className="font-parkBody mt-3">Mapping price to 3% + 5% × p produces a price-equivalent growth level. It is not expected growth E[g]: a capped payout discards information about outcomes outside the band. Risk margins, discounting and liquidity also affect price.</p>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">Settlement and wallet flow</h2>
      <p className="font-parkBody mt-3">Connect a wallet on the selected network. Checkout shows the actual currency and price before approval. Approval authorizes a spend; the following transaction performs the trade. On Polygon, use native USDC for a purchase and POL for network fees. A USDC balance on another chain, or a USDC.e balance, cannot fund that purchase.</p>
      <p className="font-parkBody mt-3">On <Link className="underline" to="/settle">the signed-email settlement page</Link>, upload the original signed .eml newsletter. Local preflight checks the signed headers and body before the oracle verifies the pinned publisher DKIM signature on-chain. Anyone may submit a qualifying observation and finalize the payout. A signature authenticates the publisher's message; it does not independently verify the economic truth of the index.</p>
      <p className="font-parkBody mt-3">After settlement, <Link className="underline" to="/redeem">Redeem RENT</Link> exchanges RENT for its escrow payout before the claim deadline. The trading cutoff does not disable settlement or redemption. Remaining backing follows the deployed contract's residual-withdrawal rules.</p>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">Status and risks</h2>
      <p className="font-parkBody mt-3">A fixed-rate quote is labeled as such and is not a v4 pool price. Calculators do not submit transactions. Bankr automation is dormant.</p>
      <p className="font-parkBody mt-3">The contracts have not been audited. Office rent can diverge from your lease; stablecoins, contracts, the publisher's signing key and liquidity introduce additional risks. Use tiny amounts. A secondary-market exit depends on available liquidity.</p>
    </Card>
  </div>;
}
