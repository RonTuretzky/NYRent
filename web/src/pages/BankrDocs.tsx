import { ArrowSquareOutIcon, CheckCircleIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Card } from "../components/States";
import { BankrExecutionViz, BankrQuotesViz, BankrResearchViz, BankrSettlementViz } from "../components/hiw/BankrStepViz";

function Step({ number, title, children, visual }: { number: number; title: string; children: ReactNode; visual: ReactNode }) {
  return <section className="grid items-center gap-8 lg:grid-cols-2 lg:gap-12" aria-labelledby={`bankr-step-${number}`}>
    <div className={number % 2 === 0 ? "lg:order-2" : undefined}>
      <div className="flex items-center gap-4"><span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-core-green font-parkDisplay text-lg font-bold text-white">{number}</span><h2 id={`bankr-step-${number}`} className="font-parkDisplay text-xl font-bold sm:text-2xl">{title}</h2></div>
      <div className="font-parkBody text-surface-grey-2 [&_p]:mt-4 [&_p]:leading-relaxed">{children}</div>
    </div>
    <div className={`min-w-0 ${number % 2 === 0 ? "lg:order-1" : ""}`}>{visual}</div>
  </section>;
}

const explorer = "https://arbitrum.blockscout.com";
const evidence = [
  ["Authenticated baseline", "0x40e4302d64f0ca90e9aed3c5df3709788e789a3ed9d3d3072943d66c5e459163"],
  ["Market created", "0xba5077dab0160d7f79b1964eda8600455ac61fbe72dd4b489235e8b2dee95204"],
  ["Live buy smoke", "0xc8e768da2b2adcf91ff8871fd9031b01ec1e521e34a3c60d8470dd688e718941"],
  ["Live sell smoke", "0xe7be9d501a0d1c60f0bba4d4f3c5ecebe4098d51044f85948ba4439026c9e88f"],
  ["Bankr collateral deposit", "0x5b47b7f883db118b0e91177150f7a7e07b5f00215484fa41d59b9262dcc7284c"],
  ["Bankr bid range", "0x5194a485bf26ff99578c2f611dfd263c66a0638f680e483a0b5580b05474f89e"],
  ["Bankr ask range", "0x5c4cbc974854484e2fe6bab67a218f29186c036ab2409e7e0c126437b00d1231"],
] as const;

function Pill({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5 rounded-full border border-core-green bg-green-0 px-3 py-1 font-parkBody text-xs font-bold text-primary-pine">{children}</span>;
}

export function BankrDocs() {
  return <div className="mx-auto min-w-0 max-w-6xl space-y-12 sm:space-y-16">
    <header className="space-y-4">
      <div className="flex flex-wrap gap-2"><Pill><CheckCircleIcon weight="fill" /> Live on Arbitrum</Pill><Pill><ShieldCheckIcon weight="fill" /> Bankr custody</Pill></div>
      <h1 className="font-parkDisplay text-3xl font-bold leading-tight sm:text-4xl">The Bankr market maker</h1>
      <p className="max-w-3xl font-parkBody text-lg leading-relaxed text-surface-grey-2">The agent supplies both sides of the RENT market: USDC to buy RENT from sellers, and backed RENT to sell to buyers. It researches market context, estimates a fair price, and uses its Bankr wallet to place and rebalance real Uniswap v4 liquidity positions.</p>
      <p className="max-w-3xl font-parkBody leading-relaxed text-surface-grey-2">Its aim is to earn a spread and trading fees while managing the inventory left by trades. Both returns and inventory value depend on prices and fills. The pilot has placed live positions; rebalancing runs when an operator invokes the agent, with no unattended schedule enabled.</p>
    </header>

    <div className="space-y-16 sm:space-y-24">
      <Step number={1} title="Research, then constrain" visual={<BankrResearchViz />}>
        <p>The research collector reviews real-estate reporting and prediction-market context. Bankr reviews that context for inconsistencies and risk. The pricing calculation uses authenticated rent observations, with a Bachelier model estimating the value of RENT’s capped payout.</p>
        <p>The policy adds a margin to the selling price and adjusts quotes for the agent’s inventory. It converts those prices into exact Uniswap ranges and token budgets. Research prose cannot set the settlement value or invent transaction amounts.</p>
      </Step>
      <Step number={2} title="Quote and rebalance the market" visual={<BankrQuotesViz />}>
        <p>A market maker offers to buy and sell. Here, the agent funds a bid range with USDC and an ask range with fully backed RENT. These are Uniswap liquidity positions: when traders reach a range, its assets convert as trades fill and it earns its share of pool fees.</p>
        <p><strong className="text-text-standard">What is being rebalanced?</strong> The agent’s trading inventory of RENT and USDC, and the price ranges where it offers that inventory. A bid fill spends USDC and adds RENT; an ask fill sells RENT and adds USDC. Those fills can leave the agent with too much or too little RENT for its inventory target.</p>
        <p>With more RENT, the policy lowers quotes to encourage sales and discourage further purchases. With less RENT, it raises quotes to encourage purchases and conserve the remaining tokens. On a new run, it reads balances and its existing positions, removes its old ranges, and posts fresh quotes within the current limits.</p>
        <p className="text-sm">Rebalancing does not release the USDC backing locked in escrow. New RENT requires new backing. Pilot limits cap new collateral, bid cash, acquired RENT and ask inventory at 0.5 units per action; a filled range can still lose money. Near the trading cutoff, the agent only unwinds its tracked liquidity positions.</p>
      </Step>
      <Step number={3} title="Bankr signs, contracts enforce" visual={<BankrExecutionViz />}>
        <p>Before submitting a change, the runner checks the wallet, market, balances, existing positions, price movement, trading window and transaction costs. It simulates each call, then asks Bankr to sign and broadcast from the agent’s wallet. Execution requires the operator to enable it explicitly.</p>
        <p>The contracts enforce full backing, position ownership, trading dates and settlement terms. The runner waits for each transaction receipt before proceeding and stops if a call fails. The API key stays outside the website and repository.</p>
      </Step>
      <Step number={4} title="Scan and settle safely" visual={<BankrSettlementViz />}>
        <p>After trading closes, a separate settlement path scans a local inbox of exported raw .eml newsletters. It verifies CRE Daily’s pinned signature, the complete body and the observation date, then extracts the rent value. Large messages are uploaded in chunks before the complete signed result is verified on-chain.</p>
        <p>A qualifying observation lets the agent settle the market and fix the payout ratio. Repeat scans check whether the observation is already recorded or the market is already settled, so completed work is not submitted again.</p>
        <p className="text-sm">Trading closes before the observation window begins, so settlement cannot be bundled with a purchase based on the known result. This pilot reads exported email files; direct Gmail or IMAP polling is not connected.</p>
      </Step>
    </div>

    <Card><h2 className="font-parkDisplay text-xl font-bold">What is live</h2>
      <p className="mt-3 font-parkBody">The Arbitrum market at <a className="break-all font-mono text-sm text-core-green underline" href={`${explorer}/address/0x8bd12856d093ffE96dd997e1882cc4f251B0E3Ec`} target="_blank" rel="noreferrer">0x8bd12856d093ffE96dd997e1882cc4f251B0E3Ec</a> now accounts for 1.5 USDC of backing. The launch executed a real buy and sell through the canonical PoolManager. Bankr then deposited another 0.5 USDC and posted one bid plus one ask from its custody wallet.</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {evidence.map(([label, hash]) => <a key={hash} href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-2xl border border-paper-2 bg-paper-1 px-4 py-3 font-parkBody text-sm transition hover:border-core-green hover:text-core-green"><span>{label}</span><ArrowSquareOutIcon className="shrink-0" /></a>)}
      </div>
      <p className="mt-4 font-parkBody text-sm text-surface-grey-2">No settlement transaction is claimed yet: the September 2027 observation window has not begun. The watcher is implemented and fixture-tested now so that a future qualifying signed email can be posted without reopening trading.</p>
    </Card>

  </div>;
}
