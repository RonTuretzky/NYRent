import { ArrowSquareOutIcon, CheckCircleIcon, EnvelopeSimpleIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Card } from "../components/States";
import { BankrAgentViz } from "../components/hiw/BankrAgentViz";

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
  return <div className="mx-auto max-w-4xl space-y-8">
    <header className="space-y-4">
      <div className="flex flex-wrap gap-2"><Pill><CheckCircleIcon weight="fill" /> Live on Arbitrum</Pill><Pill><ShieldCheckIcon weight="fill" /> Bankr custody</Pill></div>
      <h1 className="font-parkDisplay text-4xl font-bold leading-tight">The Bankr market agent</h1>
      <p className="max-w-3xl font-parkBody text-lg text-surface-grey-2">A bounded agent researches rent-market context, computes a two-sided price from authenticated oracle data, and uses the Bankr wallet to maintain real Uniswap v4 bid and ask positions. A separate email path can post a signed result and settle after trading has closed.</p>
    </header>

    <BankrAgentViz />

    <div className="grid gap-5 md:grid-cols-2">
      <Card><h2 className="font-parkDisplay text-xl font-bold">1. Research, then constrain</h2>
        <p className="mt-3 font-parkBody">The research collector reviews real-estate reporting and prediction-market context. Bankr can flag an inconsistent plan, but prose never becomes a settlement value and the model cannot invent transaction amounts.</p>
        <p className="mt-3 font-parkBody">The deterministic policy reads the signed rent observations, estimates a Bachelier fair value, adds a sell-side loading, leans for inventory, and signs exact ticks and token maxima.</p>
      </Card>
      <Card><h2 className="font-parkDisplay text-xl font-bold">2. Quote the actual market</h2>
        <p className="mt-3 font-parkBody">The agent posts a USDC-funded bid below fair value and a fully collateralized RENT ask above it. It can remove and replace only its own ranges. Every run rechecks the pool, balances, prior positions, price drift, cutoff, gas and slippage.</p>
        <p className="mt-3 font-parkBody">Pilot limits cap new collateral, bid cash, acquired RENT and ask inventory at 0.5 units per action. The agent can lose money when its model is wrong or a range fills.</p>
      </Card>
      <Card><h2 className="font-parkDisplay text-xl font-bold">3. Bankr signs, contracts enforce</h2>
        <p className="mt-3 font-parkBody">The API key never enters the site or repository. The runner verifies the live Bankr wallet identity, simulates every call as that wallet, then asks Bankr to sign and broadcast. A distinct <code className="rounded bg-paper-1 px-1.5 py-0.5 text-sm">BANKR_V4_EXECUTE=1</code> gate is required.</p>
        <p className="mt-3 font-parkBody">The on-chain market—not the agent prompt—enforces collateralization, trading dates, ownership and settlement.</p>
      </Card>
      <Card><h2 className="font-parkDisplay text-xl font-bold"><EnvelopeSimpleIcon className="mr-2 inline" />4. Scan and settle safely</h2>
        <p className="mt-3 font-parkBody">The POC scans a configured local inbox directory for raw <code className="rounded bg-paper-1 px-1.5 py-0.5 text-sm">.eml</code> files. It verifies the pinned CRE Daily DKIM signature, body hash and extracted rent locally, uploads large bodies through the chunk helper, then settles the market idempotently.</p>
        <p className="mt-3 font-parkBody font-bold">It cannot bundle a trade with known settlement information.</p>
        <p className="mt-2 font-parkBody">Market terms require sales to close no later than the observation start. The settlement runner also refuses all chain actions while trading is open, and it imports no quote or swap code. Direct Gmail/IMAP polling is not part of this POC; raw email export is the inbox adapter.</p>
      </Card>
    </div>

    <Card><h2 className="font-parkDisplay text-xl font-bold">What is live</h2>
      <p className="mt-3 font-parkBody">The Arbitrum market at <a className="break-all font-mono text-sm text-core-green underline" href={`${explorer}/address/0x8bd12856d093ffE96dd997e1882cc4f251B0E3Ec`} target="_blank" rel="noreferrer">0x8bd12856d093ffE96dd997e1882cc4f251B0E3Ec</a> now accounts for 1.5 USDC of backing. The launch executed a real buy and sell through the canonical PoolManager. Bankr then deposited another 0.5 USDC and posted one bid plus one ask from its custody wallet.</p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        {evidence.map(([label, hash]) => <a key={hash} href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-2xl border border-paper-2 bg-paper-1 px-4 py-3 font-parkBody text-sm transition hover:border-core-green hover:text-core-green"><span>{label}</span><ArrowSquareOutIcon className="shrink-0" /></a>)}
      </div>
      <p className="mt-4 font-parkBody text-sm text-surface-grey-2">No settlement transaction is claimed yet: the September 2027 observation window has not begun. The watcher is implemented and fixture-tested now so that a future qualifying signed email can be posted without reopening trading.</p>
    </Card>

    <Card><h2 className="font-parkDisplay text-xl font-bold">Run the POC</h2>
      <pre className="mt-3 overflow-x-auto rounded-2xl bg-primary-pine p-4 font-mono text-xs text-white"><code>{`# Read-only quote plan
npm --prefix agent run v4:bankr -- --target target.json --rpc RPC_URL

# Explicit Bankr custody execution
BANKR_V4_EXECUTE=1 npm --prefix agent run v4:bankr -- \\
  --target target.json --rpc RPC_URL --bankr-review --execute

# One settlement-only inbox scan
npm --prefix agent run v4:settle:bankr -- \\
  --target target.json --rpc RPC_URL --inbox ./raw-email-inbox`}</code></pre>
      <p className="mt-3 font-parkBody text-sm text-surface-grey-2">Keep the API key in a secret manager or macOS Keychain and inject it as <code>BANKR_API_KEY</code>. Do not put it in a target file, command history, browser bundle or commit.</p>
    </Card>
  </div>;
}
