import { Link } from "react-router-dom";
import { Card } from "../components/States";
import { useActiveMarket } from "../chain/useActiveMarket";
import { formatCents, formatDate } from "../chain/format";
import { DemoBadge } from "../components/DemoBadge";

export function Docs() {
  const market = useActiveMarket();
  return <div className="max-w-3xl mx-auto space-y-6">
    <header><h1 className="font-parkDisplay font-bold text-3xl">How Manhattan Rent Cover works</h1>
      <p className="font-parkBody text-surface-grey-2 mt-2">One market follows the CRE Daily Manhattan Office Rent average effective rent index, measured in dollars per square foot. It tracks office rents, not residential leases.</p>
    </header>
    <Card><h2 className="font-parkDisplay font-bold text-xl">The fixed terms</h2>
      <p className="font-parkBody mt-3">The configured base is an authenticated oracle observation signed in September 2026. The displayed base is {formatCents(market.baseCents)}/SF {market.baseIsDemo ? <DemoBadge /> : null}. Until that observation is recorded, the verified $92.88/SF fixture is a demo assumption.</p>
      <p className="font-parkBody mt-3">The first successful settlement transaction fixes the payout using a qualifying observation for September 2027; the contract cannot prove that no earlier email was withheld. Growth is g = settlement / base − 1. RENT pays nothing through 3% growth, increases linearly to $1 at 8%, and stays capped at $1 above that.</p>
      <p className="font-mono text-sm my-4 rounded-lg bg-paper-1 p-3">r = clamp((g − 0.03) / 0.05, 0, 1)</p>
      <p className="font-parkBody">Contracts using cent-denominated strikes settle against {formatCents(market.strikeLowCents)} and {formatCents(market.strikeHighCents)}. Cent rounding can differ slightly from the ideal percentage curve; the contract's integer formula determines the actual payout.</p>
      <p className="font-parkBody mt-3">Sales close {formatDate(market.saleEnd)}. Observation runs {formatDate(market.obsStart)} through {formatDate(market.obsEnd)}. Claims close {formatDate(market.redeemEnd)}. The configured sale window cannot extend beyond the start of observation.</p>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">PLATFORM, INSURER and RENTER</h2>
      <ul className="font-parkBody mt-3 space-y-3 list-disc pl-5">
        <li><strong>PLATFORM</strong> specifies the index, oracle rules, coverage band and windows. It takes no contractual rent payout position. Investing escrow in a yield-bearing stable and returning yield to the insurer is planned, not active in the current escrow.</li>
        <li><strong>INSURER</strong> supplies the backing: one dollar-stable unit per RENT. Premiums compensate for the payout obligation. The v4 design lets the insurer choose an opening price by seeding the RENT/stablecoin pool. Unsold and liquidity-pool inventory still carries its redemption claim.</li>
        <li><strong>RENTER</strong> pays a premium, receives RENT, and can claim r times the token balance after settlement. Trading out before observation depends on an enabled trading pool and available liquidity; the fixed-rate fallback has no resale flow.</li>
      </ul>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">What the calculators mean</h2>
      <p className="font-parkBody mt-3">For annual rent R, buying R × 5% RENT covers the five-percentage-point band in the model. It does not cover your entire rent increase. At R = $60,000 and p = $0.285, 3,000 RENT costs $855, breaks even at 4.425% index growth and pays at most $3,000.</p>
      <p className="font-parkBody mt-3">The insurer model counts premium p × u × C, assumed planned yield y × C, and claims r × u × C. At the defaults, premium is $2,850, assumed yield $4,000 and the worst net is −$3,150. Without yield, the worst net is −$7,150. The model treats retained inventory as the insurer's own claim on backing; it does not remove that liability from the contract.</p>
      <p className="font-parkBody mt-3">The insurer breakeven of 6.425% exceeds the renter's 4.425% because of the modeled yield allocated over sold inventory. The difference is 5% × y/u, not a separately measured risk loading.</p>
      <p className="font-parkBody mt-3">Mapping price to 3% + 5% × p produces a price-equivalent growth level. It is not expected growth E[g]: a capped payout discards information about outcomes outside the band. Risk margins, discounting and liquidity also affect price.</p>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">Settlement and wallet flow</h2>
      <p className="font-parkBody mt-3">Connect a wallet on the selected network. Checkout shows the actual currency and price before approval. Approval authorizes a spend; the following transaction buys RENT. Existing wrapping and payment-token conversion remain separate from RENT market trading.</p>
      <p className="font-parkBody mt-3">On <Link className="underline" to="/settle">Settle</Link>, upload the original signed .eml newsletter. Local preflight checks the signed headers and body before the oracle verifies the pinned publisher DKIM signature on-chain. Anyone may submit a qualifying observation and finalize the payout. A signature authenticates the publisher's message; it does not independently verify the economic truth of the index.</p>
      <p className="font-parkBody mt-3">After settlement, <Link className="underline" to="/redeem">Redeem</Link> exchanges RENT for its escrow payout before the claim deadline. Sales pauses do not disable settlement or redemption. Remaining backing follows the deployed contract's residual-withdrawal rules.</p>
    </Card>
    <Card><h2 className="font-parkDisplay font-bold text-xl">Status and risks</h2>
      <p className="font-parkBody mt-3">A demo badge identifies assumptions or a market not configured for live transactions. A fixed-rate quote is labeled as such and is not a v4 pool price. Calculators do not submit transactions. Bankr automation is dormant.</p>
      <p className="font-parkBody mt-3">Unaudited and experimental. Office rent can diverge from your lease; stablecoins, contracts, the publisher's signing key and liquidity introduce additional risks. Use tiny amounts. No secondary exit or yield is guaranteed.</p>
    </Card>
  </div>;
}
