import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient } from "wagmi";
import { decodeEventLog, encodeFunctionData, type Address } from "viem";
import { Button } from "@decentralpark/ui";
import { Card } from "../components/States";
import { TxStatus } from "../components/TxStatus";
import { useTx } from "../chain/useTx";
import { useV4Market } from "../chain/v4";
import { RentV4MarketAbi, ChunkedObservationSubmitterAbi } from "../chain/v4Abi";
import { oracleAbi } from "../chain/contracts";
import { runPreflight, toHex, type PreflightReport } from "../emailkit/bridge";
import { formatCents, formatTimestamp } from "../chain/format";

export function V4Settle() {
  const m = useV4Market();
  if (!m.deployment || !m.data) return <Card><p>Reading the active trading market…</p></Card>;
  return <Settlement key={`${m.deployment.chainId}:${m.deployment.market}`} />;
}

function Settlement() {
  const market = useV4Market();
  const d = market.deployment!;
  const m = market.data!;
  const client = usePublicClient({ chainId: d.chainId });
  const { address, chainId } = useAccount();
  const queryClient = useQueryClient();
  const tx = useTx();
  const [report, setReport] = useState<PreflightReport>();
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState("");
  const observations = useQuery({
    queryKey: ["v4-observations", d.chainId, d.oracle],
    enabled: !!client,
    refetchInterval: 15000,
    queryFn: async () => {
      const count = await client!.readContract({ address: d.oracle, abi: oracleAbi, functionName: "observationCount" });
      if (count > 1000n) throw new Error("Observation history requires pagination. Use the operator settlement script.");
      return Promise.all(Array.from({ length: Number(count) }, async (_, index) => {
        const [t, cents, emailId] = await client!.readContract({ address: d.oracle, abi: oracleAbi, functionName: "observations", args: [BigInt(index)] });
        return { index: BigInt(index), t, cents, emailId };
      }));
    },
  });
  const qualifying = observations.data?.find(o => o.t >= m.obsStart && o.t <= m.obsEnd);
  const known = report?.parsed && observations.data?.some(o => o.emailId === report.parsed!.emailId);
  const timestampTag = report?.parsed?.tags.t ?? "";
  const signedTime = /^\d+$/.test(timestampTag) ? BigInt(timestampTag) : 0n;
  const inWindow = signedTime >= m.obsStart && signedTime <= m.obsEnd;
  const parsedCents = report?.parsed?.cents;
  const previewRatio = parsedCents === undefined ? undefined : Math.min(1, Math.max(0,
    (parsedCents - m.strikeLowCents) / (m.strikeHighCents - m.strikeLowCents)));
  const ready = !!address && chainId === d.chainId && !working && !market.isError && !["pending", "stillPending", "wallet", "simulating"].includes(tx.state.status);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["v4-observations"] });
    await queryClient.invalidateQueries({ queryKey: ["v4-market"] });
  };
  async function upload(file: File) {
    setError(""); setReport(undefined); setWorking(true);
    try {
      if (file.size > 2_000_000) throw new Error("This email is too large for the current submission path.");
      setReport(await runPreflight(new Uint8Array(await file.arrayBuffer())));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read the email"); }
    finally { setWorking(false); }
  }
  async function record() {
    if (!ready || !report?.ok || !report.parsed) return;
    setWorking(true); setError("");
    const p = report.parsed;
    try {
      const directArgs = [toHex(p.signedHeaders), toHex(p.canonBody), toHex(p.sig)] as const;
      const data = encodeFunctionData({ abi: oracleAbi, functionName: "submitObservation", args: directArgs });
      // Leave room for the transaction envelope under the sequencer's 95KB admission bound.
      if (d.chainId !== 42161 || (data.length - 2) / 2 < 90000) {
        const result = await tx.send({ chainId: d.chainId, account: address, address: d.oracle, abi: oracleAbi, functionName: "submitObservation", args: directArgs }, { label: "Authenticate the email" });
        if (result.status !== "confirmed") throw new Error("Email submission is not confirmed. Check its receipt before retrying.");
      } else {
        const helper = d.observationSubmitter;
        if (!helper) throw new Error("This email needs the large-message helper, which is not configured on this network.");
        if (p.canonBody.length > 192000) throw new Error("The signed body exceeds the large-message helper limit.");
        const prefixCount = Math.ceil(Math.max(0, p.canonBody.length - 80000) / 24000);
        const cacheKey = `rentsafe.email-chunks:${d.chainId}:${helper}:${p.emailId}`;
        let chunks: Address[] = [];
        try { const parsed: unknown = JSON.parse(localStorage.getItem(cacheKey) ?? "[]"); if (Array.isArray(parsed) && parsed.every(c => typeof c === "string" && /^0x[0-9a-fA-F]{40}$/.test(c))) chunks = parsed.slice(0, prefixCount); } catch { /* unavailable browser storage */ }
        for (let i = chunks.length; i < prefixCount; i++) {
          setProgress(`Store signed message part ${i + 1} of ${prefixCount}`);
          const part = toHex(p.canonBody.slice(i * 24000, (i + 1) * 24000));
          const result = await tx.send({ chainId: d.chainId, account: address, address: helper, abi: ChunkedObservationSubmitterAbi, functionName: "store", args: [part] }, { label: `Store email part ${i + 1}` });
          if (result.status !== "confirmed") throw new Error("Message storage is not confirmed. Check its receipt before retrying.");
          let chunk: Address | undefined;
          for (const log of result.receipt.logs) {
            if (log.address.toLowerCase() !== helper.toLowerCase()) continue;
            try { const event = decodeEventLog({ abi: ChunkedObservationSubmitterAbi, eventName: "ChunkStored", data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] }); chunk = event.args.chunk; } catch { /* other log */ }
          }
          if (!chunk) throw new Error("Stored-message receipt could not be decoded.");
          chunks.push(chunk);
          try { localStorage.setItem(cacheKey, JSON.stringify(chunks)); } catch { /* storage optional */ }
        }
        setProgress("Authenticate the complete email");
        const args = [d.oracle, chunks, p.emailId as `0x${string}`, toHex(p.signedHeaders), toHex(p.sig), toHex(p.canonBody.slice(prefixCount * 24000))] as const;
        const calldata = encodeFunctionData({ abi: ChunkedObservationSubmitterAbi, functionName: "submit", args });
        if ((calldata.length - 2) / 2 > 90000) throw new Error("Submission exceeds the safe transaction size; use smaller chunks through the operator script.");
        const result = await tx.send({ chainId: d.chainId, account: address, address: helper, abi: ChunkedObservationSubmitterAbi, functionName: "submit", args }, { label: "Authenticate the complete email" });
        if (result.status !== "confirmed") throw new Error("Email authentication is not confirmed. Check its receipt before retrying.");
      }
      await refresh();
      setProgress("Email authenticated on-chain.");
    } catch (e) { setError(e instanceof Error ? e.message : "Submission failed"); }
    finally { setWorking(false); }
  }
  async function settle() {
    if (!ready || !qualifying) return;
    setWorking(true); setError("");
    try {
      await tx.send({ chainId: d.chainId, account: address, address: d.market, abi: RentV4MarketAbi, functionName: "settle", args: [qualifying.index] }, { label: "Settle the rent market" });
      await refresh();
    } finally { setWorking(false); }
  }
  return <div className="max-w-2xl mx-auto space-y-5"><Card>
    <h1 className="font-parkDisplay font-bold text-3xl">Settle with a signed email</h1>
    <p className="mt-3">The original newsletter signature authenticates the rent print. The market accepts a signed timestamp from {formatTimestamp(m.obsStart)} through {formatTimestamp(m.obsEnd)}. The first successful qualifying settlement fixes the payout permanently.</p>
    {m.settled ? <p className="my-4 font-bold">Already settled at {(Number(m.payoutRatioWad) / 1e16).toFixed(2)}% of maximum payout.</p> : qualifying ? <div className="my-4"><p>Authenticated qualifying print: {formatCents(qualifying.cents)} · {formatTimestamp(qualifying.t)}</p><Button app="fund" className="mt-3" disabled={!ready} onClick={() => void settle()}>Settle market</Button></div> : <p className="my-4">{observations.isError ? "Could not read recorded observations. Retry before settling." : "No qualifying observation has been recorded yet."}</p>}
    {(!address || chainId !== d.chainId) && <p>Connect a wallet on the selected network to submit or settle.</p>}
  </Card><Card><h2 className="text-xl font-bold">Verify the original newsletter</h2>
    <label className="block mt-3">Original email (.eml)<input type="file" accept=".eml,message/rfc822" className="block mt-2" disabled={working || m.settled} onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }} /></label>
    {report && <>
      {report.parsed && <div className="mt-5 rounded-xl border-2 border-paper-2 bg-paper-1 p-4" data-testid="signed-rent-summary">
        <p className="text-sm font-bold text-primary-green">{known ? "Authenticated on-chain" : report.ok ? "Signature checks passed locally" : "Email checks need attention"}</p>
        <div className="grid sm:grid-cols-2 gap-4 mt-3">
          <div><p className="text-sm text-surface-grey-2">Rent print in the signed email</p><p className="font-parkDisplay font-bold text-3xl">{formatCents(report.parsed.cents)} <span className="text-base">/SF</span></p></div>
          <div><p className="text-sm text-surface-grey-2">{m.settled ? "Fixed payout per RENT" : "Payout preview per RENT"}</p><p className="font-parkDisplay font-bold text-3xl">{(m.settled ? Number(m.payoutRatioWad) / 1e18 : previewRatio!).toFixed(4)} <span className="text-base">{d.symbol}</span></p></div>
        </div>
        <p className="text-sm mt-3">{inWindow ? "The signed timestamp is inside the settlement window." : "Outside the settlement window: this email cannot settle this market."} {!m.settled && "The payout becomes final only after the oracle authenticates an eligible email and the settlement transaction confirms."}</p>
      </div>}
      <ul className="my-4 space-y-2" data-testid="v4-preflight">{report.checks.map(c => <li key={c.id}>{c.pass ? "✓" : "✕"} {c.label}: {c.detail}</li>)}</ul>

      <Button app="fund" className="mt-4" disabled={!ready || !report.ok || !!known || m.settled} onClick={() => void record()}>{known ? "Email already authenticated" : "Authenticate email on-chain"}</Button>
    </>}
    {progress && <p role="status" className="mt-3">{progress}</p>}
  </Card><TxStatus state={tx.state} />{error && <p role="alert" className="text-system-red">{error}</p>}</div>;
}
