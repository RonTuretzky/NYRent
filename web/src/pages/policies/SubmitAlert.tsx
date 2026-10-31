import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type Address } from "viem";
import { useReadContract } from "wagmi";
import { Button } from "@decentralpark/ui";
import { APARTMENTS_ORACLE, APARTMENTS_POOL } from "../../chain/apartments";
import { apartmentsOracleAbi } from "../../chain/apartmentsAbi";
import { formatCents, formatTimestamp } from "../../chain/format";
import { useTx } from "../../chain/useTx";
import { Card, StatRow } from "../../components/States";
import { TxStatus } from "../../components/TxStatus";
import { parseEmailBytes, toHex } from "../../emailkit/bridge";
import { extractAlertCandidates, monthLabel, publishedRecipient, signedInsideMonth, type AlertResult } from "../../lib/googleAlert";
import { RECORDER_STEPS, fileProblem } from "../../lib/policy";
import { ActionFailureHint, NotDeployed, Notice, StepBar, WalletGate, chainId, inputClass, neighborhood, txBusy, txOpts, useLock, useNow, useWalletFunds } from "./shared";

interface Prepared {
  fileName: string;
  headers: Uint8Array;
  body: Uint8Array;
  sig: Uint8Array;
  emailId: `0x${string}`;
  recipient: string | null;
  signedAt: number;
  candidates: AlertResult[];
}

export function SubmitAlert() {
  const now = useNow();
  const funds = useWalletFunds(0n);
  const tx = useTx({ label: "Record rent" });
  const lock = useLock();
  const input = useRef<HTMLInputElement>(null);
  const [prepared, setPrepared] = useState<Prepared>();
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [consent, setConsent] = useState(false);
  useEffect(() => setConsent(false), [prepared]);
  const already = useReadContract({
    address: APARTMENTS_ORACLE as Address, abi: apartmentsOracleAbi, chainId, functionName: "recorded",
    args: prepared ? [prepared.emailId] : undefined, query: { enabled: Boolean(prepared && APARTMENTS_ORACLE) },
  });

  async function load(file: File | undefined) {
    setPrepared(undefined);
    setError("");
    tx.reset();
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) return setError(problem);
    setReading(true);
    try {
      const parsed = await parseEmailBytes(new Uint8Array(await file.arrayBuffer()), { domain: "google.com" });
      const signedAt = Number(parsed.tags.raw["t"]);
      if (!Number.isFinite(signedAt) || signedAt <= 0) throw new Error("no t=");
      setPrepared({
        fileName: file.name,
        headers: parsed.signedHeaders,
        body: parsed.canonBody,
        sig: parsed.sig,
        emailId: parsed.emailId as `0x${string}`,
        recipient: publishedRecipient(parsed.signedHeaders),
        signedAt,
        candidates: extractAlertCandidates(parsed.canonBody),
      });
    } catch {
      setError(`"${file.name}" is not an original Google Alert email: it has no Google signature. Forwarded, printed or re-saved copies lose the signature. In Gmail open the alert, choose "Download message" from the three-dot menu, and upload that .eml unchanged.`);
    } finally {
      setReading(false);
    }
  }

  if (!APARTMENTS_POOL) return <NotDeployed />;
  const qualifying = prepared?.candidates.filter((c) => signedInsideMonth(c.yyyymm, prepared.signedAt)) ?? [];
  const outside = prepared?.candidates.filter((c) => !signedInsideMonth(c.yyyymm, prepared.signedAt)) ?? [];
  const future = prepared ? prepared.signedAt > Number(now) + 86_400 : false;
  const recorded = already.data === true;
  const step = tx.state.status === "confirmed" ? 5 : prepared && qualifying.length > 0 ? (consent ? 4 : 3) : 2;
  const busy = txBusy(tx.state);

  return (
    <div className="max-w-2xl mx-auto space-y-6 pb-12 min-w-0">
      <div>
        <p className="font-parkBody font-bold">For anyone</p>
        <h1 className="font-parkHeading text-3xl sm:text-4xl mt-2">Record a month's rent</h1>
        <p className="font-parkBody text-sm mt-2 leading-relaxed">
          Upload the original Google Alert email (.eml) for an Apartments.com neighborhood page. Your browser reads it here first and shows what the contract would record; nothing leaves your computer until you click publish. <Link className="underline font-bold text-core-green" to="/policies/guide?tab=record">Set up the alert and download the .eml</Link>.
        </p>
      </div>
      <Card><StepBar steps={RECORDER_STEPS} current={step} title="Record a rent" /></Card>
      <Card>
        <h2 className="font-parkHeading text-2xl mb-3">Upload the .eml</h2>
        <label className="block font-parkBody">
          Original alert email from Gmail
          <input ref={input} className={`${inputClass} file:mr-3 file:rounded-md file:border-0 file:bg-paper-1 file:px-3 file:py-1.5 file:font-parkBody`} type="file" accept=".eml,message/rfc822" onChange={(e) => void load(e.target.files?.[0])} data-testid="alert-file" aria-describedby="file-help" />
        </label>
        <p id="file-help" className="font-parkBody text-xs text-surface-grey-2 mt-1">One .eml file, under 1 MB, exactly as Gmail saved it.</p>
        {reading && <p className="font-parkBody text-sm mt-3" role="status">Reading the email locally…</p>}
        {error && <div className="mt-3"><Notice tone="error" testId="file-error">{error}</Notice></div>}
      </Card>
      {prepared && (
        <Card data-testid="preview-card">
          <h2 className="font-parkHeading text-2xl mb-2 break-words">{prepared.fileName}</h2>
          <StatRow label="Signed by Google" value={formatTimestamp(BigInt(prepared.signedAt))} />
          {qualifying.length === 0 ? (
            <div className="mt-3 space-y-2">
              <Notice tone="error" testId="no-qualifying">
                {outside.length > 0 ? (
                  <>
                    <p className="font-bold">This email's rent sentence names {outside.map((c) => monthLabel(c.yyyymm)).join(", ")}, but Google signed it on {formatTimestamp(BigInt(prepared.signedAt))}.</p>
                    <p className="mt-1">The contract only records a sentence signed during the month it names, so it would reject this one. Use an alert that arrived during {outside.map((c) => monthLabel(c.yyyymm)).join(" or ")}, or wait for one that names {monthLabel(yyyymmOf(prepared.signedAt))}.</p>
                  </>
                ) : (
                  <>
                    <p className="font-bold">This is a genuine Google Alert, but it has no rent the contract accepts.</p>
                    <p className="mt-1">It needs the exact sentence "As of Month Year, the average rent in Name was $n/mo." linking to an Apartments.com rent-market-trends page. Other snippets, like "Average Rent by Bedroom", do not count. Set the alert's query to the exact page address and wait for the next one.</p>
                  </>
                )}
              </Notice>
            </div>
          ) : (
            <>
              <p className="font-parkBody text-sm mt-3 mb-1">The contract would record:</p>
              {qualifying.map((r) => (
                <StatRow key={r.slug} label={`${neighborhood(r.slug)?.geography ?? r.slug}, ${monthLabel(r.yyyymm)}`} value={`${formatCents(r.cents)}/mo`} />
              ))}
              {outside.length > 0 && <p className="font-parkBody text-xs text-surface-grey-2 mt-2">Skipped (signed outside their month): {outside.map((c) => `${neighborhood(c.slug)?.geography ?? c.slug} ${monthLabel(c.yyyymm)}`).join(", ")}.</p>}
              {tx.state.status === "confirmed" ? null : recorded ? (
                <div className="mt-4"><Notice tone="ok" testId="already-recorded">This exact email is already recorded on-chain. There is nothing to do: the policies for these pages will use it (or an earlier-signed one). <Link className="underline font-bold" to="/policies">Back to policies</Link>.</Notice></div>
              ) : future ? (
                <div className="mt-4"><Notice tone="warn" testId="future-signature">Google's signing time on this email is more than a day ahead of the network clock, so the contract would reject it as "from the future". Try again after {formatTimestamp(BigInt(prepared.signedAt))}.</Notice></div>
              ) : (
                <>
                  <div className="mt-4"><Notice tone="warn" testId="publish-warning">
                    <p className="font-bold">Publishing puts the whole email on a public blockchain, permanently.</p>
                    <p className="mt-1">
                      That includes the address it was sent to{prepared.recipient ? ` (${prepared.recipient})` : ""}, the alert's search text and every link in it, including the unsubscribe link, so anyone could cancel that alert. It can never be removed. Use a mailbox dedicated to these alerts.
                    </p>
                  </Notice></div>
                  <label className="flex gap-3 my-4 font-parkBody min-h-11 items-center">
                    <input type="checkbox" className="h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="alert-consent" />
                    <span>I understand this publishes the email permanently and I want to record this rent.</span>
                  </label>
                  <WalletGate why="to pay the network fee for recording">
                    {funds.stage === "noGas" ? (
                      <Notice tone="warn" testId="no-gas">Your wallet has no balance to pay the network fee. Recording costs more than most transactions because the contract checks Google's signature on-chain. <Link className="underline font-bold" to="/policies/guide?tab=renter">How to get a little gas money</Link>.</Notice>
                    ) : (
                      <Button
                        disabled={!consent || busy}
                        isLoading={busy}
                        showChildrenWhenLoading
                        data-testid="alert-submit"
                        onClick={() => void lock(async () => {
                          await tx.send({
                            abi: apartmentsOracleAbi, address: APARTMENTS_ORACLE as Address, chainId, account: funds.address,
                            functionName: "submitObservation", args: [toHex(prepared.headers), toHex(prepared.body), toHex(prepared.sig)],
                          }, txOpts);
                          await already.refetch();
                        })}
                      >
                        {busy ? "Recording…" : "Publish and record rent"}
                      </Button>
                    )}
                  </WalletGate>
                </>
              )}
            </>
          )}
          <div className="mt-3 space-y-2">
            <TxStatus state={tx.state} />
            <ActionFailureHint state={tx.state} />
            {tx.state.status === "confirmed" && (
              <Notice tone="ok" testId="recorded-ok">Recorded. If an earlier-signed email for the same page and month exists, that one wins instead. Seven days after the month ends, anyone can finalize from the <Link className="underline font-bold" to="/policies">policy page</Link>; claiming finalizes automatically.</Notice>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function yyyymmOf(t: number) {
  const d = new Date(t * 1000);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}
