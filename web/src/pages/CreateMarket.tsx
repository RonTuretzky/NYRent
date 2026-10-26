import { useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, usePublicClient } from "wagmi";
import { decodeEventLog, parseAbi } from "viem";
import { Card } from "../components/States";
import { useActiveDeployment } from "../chain/registry";
import { V4_DEPLOYMENTS } from "../chain/v4";
import { RentV4FactoryAbi } from "../chain/v4Abi";
import { useTx } from "../chain/useTx";
import { creationTerms, type CreationInput } from "../lib/createMarket";
import catalog from "../data/apartments-series.json";

const inputClass = "w-full border rounded-lg p-3 bg-white text-black";
const buttonClass = "border-2 rounded-lg px-5 py-3 font-bold disabled:opacity-40";
const oracleAbi = parseAbi(["function observations(uint256) view returns (uint64 t,uint32 cents,bytes32 emailId)"]);

export function CreateMarket() {
  const { chainId } = useActiveDeployment();
  const deployment = V4_DEPLOYMENTS[String(chainId)];
  const client = usePublicClient({ chainId });
  const account = useAccount();
  const tx = useTx({ label: "Create permissionless market" });
  const [mode, setMode] = useState("residential");
  const [seriesId, setSeriesId] = useState(catalog.series[0].seriesId);
  const [period, setPeriod] = useState("2026-11");
  const [hash, setHash] = useState("");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [market, setMarket] = useState<{ address: string; chain: number }>();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState<CreationInput>({ low: "95.67", high: "100.32", saleEnd: "2027-08-30", obsStart: "2027-09-01", obsEnd: "2027-10-01", redeemEnd: "2027-10-08" });
  const series = catalog.series.find(s => s.seriesId === seriesId)!;
  const pending = busy || ["simulating", "wallet", "pending", "stillPending"].includes(tx.state.status);

  async function create() {
    setError(""); setMarket(undefined); setBusy(true);
    try {
      if (!accepted || !client || !deployment || !account.address || account.chainId !== chainId) throw new Error("Connect your wallet to the selected supported network and review the terms.");
      const base = await client.readContract({ address: deployment.oracle, abi: oracleAbi, functionName: "observations", args: [BigInt(deployment.baseObservationIndex)] });
      const block = await client.getBlock();
      if (base[0] > block.timestamp) throw new Error("Baseline timestamp is in the future.");
      const immutableTerms = creationTerms(terms, BigInt(deployment.baseObservationIndex), base[1], Number(block.timestamp));
      // Both currencies use identical decimals; 1:1 is independent of token address ordering.
      // Creation initializes an EMPTY pool, not a quote or funded liquidity.
      const result = await tx.send({ address: deployment.factory, abi: RentV4FactoryAbi, chainId, functionName: "createMarket", args: [immutableTerms, 2n ** 96n], account: account.address });
      if (result.status === "confirmed") {
        for (const log of result.receipt.logs) {
          if (log.address.toLowerCase() !== deployment.factory.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({ abi: RentV4FactoryAbi, data: log.data, topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]] });
            if (decoded.eventName === "MarketCreated") setMarket({ address: decoded.args.market, chain: chainId });
          } catch { /* Other factory events are not creation receipts. */ }
        }
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function exportDraft() {
    const document = { schema: "rentsafe-residential-policy-draft-v1", status: "DRAFT_NOT_DEPLOYED", settlementEnabled: false, series, asOfMonth: period, evidence: hash ? { sha256: hash, authentication: "NOT_VERIFIED" } : null, proposedFinalization: "All accepted submissions for this series and month must agree by a fixed deadline. Conflicts or absent data prevent price finalization.", unresolved: ["Production Google DKIM verifier and key policy", "Cohort definition", "Commitment and challenge deadlines", "No-data and conflict payout rules, including secondary holders"] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }));
    const a = window.document.createElement("a"); a.href = url; a.download = "rentsafe-policy-draft.json"; a.click(); URL.revokeObjectURL(url);
  }

  return <div className="max-w-3xl mx-auto space-y-6 pb-12">
    <div><p className="font-bold">Permissionless participation</p><h1 className="text-4xl font-bold mt-2">Create a market or policy</h1><p className="mt-4">Anyone can create an onchain office-rent market. Residential Google Alert policies are currently drafts while their settlement verifier is being built.</p></div>
    <label className="block">Market type<select className={inputClass} value={mode} onChange={e => { setMode(e.target.value); setAccepted(false); setError(""); }}><option value="residential">Residential · Google Alerts · draft</option><option value="office">Office · CRE Daily · live contracts</option></select></label>
    {mode === "residential" ? <>
      <Card><h2 className="text-2xl font-bold">Neighborhood policy builder</h2><p className="my-3">Choose a publisher series, then prepare a policy and evidence commitment. This does not create a funded policy or publish your email.</p>
      <label className="block my-4">Neighborhood<select className={inputClass} value={seriesId} onChange={e => setSeriesId(e.target.value)}>{catalog.series.map(s => <option key={s.seriesId} value={s.seriesId}>{s.geography} · {s.seriesId.split(":")[1]}</option>)}</select></label>
      <a href={series.url} target="_blank" rel="noreferrer" className="underline">Apartments.com source page</a>
      <p className="my-3">Metric: publisher headline average rent. Rolling as-of month; not a calendar-month average. Bedroom cohort remains unresolved.</p>
      <label className="block my-4">As-of month<input className={inputClass} type="month" value={period} onChange={e => setPeriod(e.target.value)} /></label>
      <label className="block my-4">Original Google Alert (.eml)<input className={inputClass} type="file" accept=".eml,message/rfc822" onChange={async e => {
        const file = e.target.files?.[0]; setHash(""); setFileName(""); setError("");
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) { setError("Choose an original smaller than 10 MB."); return; }
        try { const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); setHash(Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")); setFileName(file.name); }
        catch { setError("Could not fingerprint this file. No proof was submitted."); }
      }} /></label>
      {hash && <p className="break-all text-sm">Local fingerprint for {fileName}: {hash}<br /><strong>Authentication not verified. Nothing uploaded.</strong></p>}
      <button className={buttonClass} disabled={!/^20\d\d-(0[1-9]|1[0-2])$/.test(period)} onClick={exportDraft}>Download policy draft</button></Card>
      <Card><h2 className="text-2xl font-bold">Who can submit proof?</h2><p className="mt-3">The intended protocol accepts submissions from anyone. A valid Google signature alone is insufficient: the accepted result must bind the exact publisher URL, neighborhood, month, statistic and value required by the policy. Alert queries and titles cannot supply a price.</p><p className="mt-3">Google authenticates the relay email, not the publisher’s own signature or the truth of its data. Production proof submission and residential settlement are not enabled in this release.</p></Card>
    </> : <Card><h2 className="text-2xl font-bold">Create an office-rent market</h2><p className="my-3">This uses the existing ownerless factory on {chainId === 137 ? "Polygon" : chainId === 42161 ? "Arbitrum" : "the selected network"}. No allowlist or operator approval. Its oracle measures Manhattan office effective rent in dollars per square foot, from CRE Daily / CompStak. Google Alerts cannot settle this market.</p>
      <div className="grid sm:grid-cols-2 gap-4">{([ ["low", "Zero payout strike ($/SF)"], ["high", "Full payout strike ($/SF)"], ["saleEnd", "Trading closes (UTC)"], ["obsStart", "Observation starts (UTC)"], ["obsEnd", "Observation ends (UTC)"], ["redeemEnd", "Redemption ends (UTC)"] ] as [keyof CreationInput, string][]).map(([key, label]) => <label key={key}>{label}<input className={inputClass} type={key === "low" || key === "high" ? "text" : "date"} value={terms[key]} onChange={e => { setTerms({ ...terms, [key]: e.target.value }); setAccepted(false); }} /></label>)}</div>
      <p className="my-4">The first eligible oracle observation fixes a linear payout between the strikes. If no observation arrives, holders receive no payout; after redemption closes, residual collateral belongs to the original depositors. Creation initializes an empty pool at 1 USDC per RENT; this is not an executable quote. Funding and liquidity require separate transactions.</p>
      <label className="flex gap-3 my-4"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} />I reviewed these immutable terms, the office-only data source and the no-observation outcome.</label>
      <button className={buttonClass} disabled={!accepted || !deployment || !account.address || account.chainId !== chainId || pending} onClick={() => void create()}>{pending ? "Processing…" : "Create market with wallet"}</button>
      {!account.address && <p className="mt-2">Connect your wallet using the header.</p>}{account.address && account.chainId !== chainId && <p className="mt-2">Switch your wallet to the selected network using the header.</p>}
      <p className="mt-3" role="status">Transaction: {tx.state.status}</p>
      {tx.state.status === "reverted" && <p role="alert">{tx.state.error.message}</p>}
      {"hash" in tx.state && tx.state.hash && <a className="underline" href={`${tx.state.explorerBase}/tx/${tx.state.hash}`} target="_blank" rel="noreferrer">View transaction</a>}
      {market && <p className="mt-3 break-all">Created on chain {market.chain}: <strong>{market.address}</strong>. The market has no backing or liquidity yet. Save this address; it is separate from the homepage’s featured market.</p>}
    </Card>}
    {error && <p role="alert">{error}</p>}
    <p><Link className="underline" to="/settle">Existing office-market proof submission</Link> · <Link className="underline" to="/docs">Protocol documentation</Link></p>
  </div>;
}
