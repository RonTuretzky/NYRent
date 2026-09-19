import { ACTIVE_MARKET_ID } from "../lib/market";
import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { decodeEventLog } from "viem";
import { useAccount } from "wagmi";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { Button } from "@decentralpark/ui";
import {
  CheckCircleIcon,
  EnvelopeSimpleIcon,
  FileArrowUpIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { isLiveDeployment, useActiveDeployment } from "../chain/registry";
import { oracleAbi, poolAbi } from "../chain/contracts";
import {
  useOracleObservations,
  useSeriesIndex,
  useSeriesRow,
} from "../chain/poolHooks";
import { useTx } from "../chain/useTx";
import { TxStatus } from "../components/TxStatus";
import {
  Card,
  EmptyState,
  LoadingSkeleton,
  RpcDownState,
  RpcStaleBanner,
} from "../components/States";
import {
  runPreflight,
  toHex,
  type PreflightReport,
} from "../emailkit/bridge";
import {
  formatCents,
  formatTimestamp,
  nowSec,
  truncateHex,
} from "../chain/format";

/** /settle without an id: pick a series. */
export function SettlePicker() {
  const { deployment } = useActiveDeployment();
  const { rows: series, isLoading, rpcError } = useSeriesIndex();
  if (!isLiveDeployment(deployment)) {
    return (
      <EmptyState title="Not deployed yet">
        Settlement opens once contracts are live on {deployment.name}.
      </EmptyState>
    );
  }
  if (isLoading) {
    return (
      <Card className="max-w-xl mx-auto">
        <LoadingSkeleton lines={3} />
      </Card>
    );
  }
  // Full-page outage state only when nothing is cached; a failed background
  // refetch keeps the last-good list visible behind a slim stale banner.
  if (rpcError && series.length === 0) {
    return (
      <div className="max-w-xl mx-auto">
        <RpcDownState />
      </div>
    );
  }
  if (series.length === 0) {
    return <EmptyState title="No market to settle" />;
  }
  return (
    <div className="max-w-xl mx-auto space-y-4">
      <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
        Settle a market
      </h1>
      {rpcError ? <RpcStaleBanner /> : null}
      {series.map(({ id, series: s }) => (
        <Link key={id} to={`/settle/${id}`} className="block">
          <Card className="hover:border-core-green transition-colors">
            <div className="flex items-center justify-between">
              <span className="font-parkBody font-bold">
                Market #{id} · {formatCents(s.strikeLowCents)} →{" "}
                {formatCents(s.strikeHighCents)}
              </span>
              <span className="font-parkBody text-sm text-surface-grey-2">
                {s.settled ? "settled" : "open"}
              </span>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

type FileState =
  | { status: "empty" }
  | { status: "reading" }
  | { status: "not-email"; message: string }
  | { status: "ready"; name: string; bytes: Uint8Array; report: PreflightReport };

export function Settle() {
  const { id } = useParams();
  const seriesId = id !== undefined ? Number(id) : ACTIVE_MARKET_ID;
  const { deployment } = useActiveDeployment();
  const { series: s, isLoading, rpcError } = useSeriesRow(seriesId);
  const { observations } = useOracleObservations();
  const { address, isConnected, chainId } = useAccount();
  const { openConnectModal } = useConnectModal();

  const [file, setFile] = useState<FileState>({ status: "empty" });
  const [dragOver, setDragOver] = useState(false);
  const [obsIndex, setObsIndex] = useState<bigint | undefined>(undefined);

  const submitTx = useTx();
  const settleTx = useTx();

  const onFile = useCallback(async (f: File) => {
    setFile({ status: "reading" });
    setObsIndex(undefined);
    submitTx.reset();
    settleTx.reset();
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const report = await runPreflight(buf);
      const parseCheck = report.checks.find((c) => c.id === "eml-parse");
      if (parseCheck && !parseCheck.pass) {
        setFile({
          status: "not-email",
          message: `“${f.name}” doesn't look like an email (.eml): ${parseCheck.detail}`,
        });
        return;
      }
      setFile({ status: "ready", name: f.name, bytes: buf, report });
    } catch (err) {
      setFile({
        status: "not-email",
        message: `Could not process “${f.name}”: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parsed = file.status === "ready" ? file.report.parsed : null;

  // Replay awareness: if this email is already on-chain, skip straight to settle.
  const existingObs = useMemo(() => {
    if (!parsed) return undefined;
    return observations.find((o) => o.emailId === parsed.emailId);
  }, [parsed, observations]);

  const emailT = parsed ? BigInt(parsed.tags.t || "0") : undefined;
  const inWindow =
    s && emailT !== undefined
      ? emailT >= s.obsStart && emailT <= s.obsEnd
      : undefined;

  const now = nowSec();
  const wrongNetwork = isConnected && chainId !== deployment.chainId;

  if (!isLiveDeployment(deployment)) {
    return (
      <EmptyState title="Not deployed yet">
        Settlement opens once contracts are live on {deployment.name}.
      </EmptyState>
    );
  }
  if (seriesId === undefined || Number.isNaN(seriesId)) {
    return <EmptyState title="Invalid market id" />;
  }
  if (isLoading) {
    return (
      <Card className="max-w-2xl mx-auto">
        <LoadingSkeleton lines={5} />
      </Card>
    );
  }
  // Full-page outage state only when there is nothing to render — a transient
  // refetch failure must NOT unmount the page (that would lose the uploaded
  // and preflighted .eml plus any in-flight TxStatus).
  if (!s && rpcError) {
    return (
      <div className="max-w-2xl mx-auto">
        <RpcDownState />
      </div>
    );
  }
  if (!s) {
    return <EmptyState title={`Market #${seriesId} not found`} />;
  }

  const recordedIndex =
    obsIndex ?? (existingObs ? BigInt(existingObs.index) : undefined);
  const allChecksPass = file.status === "ready" && file.report.ok;
  const busy = (tx: typeof submitTx) =>
    tx.state.status === "simulating" ||
    tx.state.status === "wallet" ||
    tx.state.status === "pending";

  async function onSubmitObservation() {
    if (!parsed) return;
    const result = await submitTx.send(
      {
        abi: oracleAbi,
        address: deployment.oracle,
        chainId: deployment.chainId,
        functionName: "submitObservation",
        args: [
          toHex(parsed.signedHeaders),
          toHex(parsed.canonBody),
          toHex(parsed.sig),
        ],
        account: address,
      },
      { label: "Record observation" },
    );
    if (result.status === "confirmed") {
      // decode ObservationRecorded from the receipt for the exact index
      for (const log of result.receipt.logs) {
        if (log.address.toLowerCase() !== deployment.oracle.toLowerCase())
          continue;
        try {
          const ev = decodeEventLog({
            abi: oracleAbi,
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          if (ev.eventName === "ObservationRecorded") {
            const args = ev.args as unknown as { index: bigint };
            setObsIndex(args.index);
          }
        } catch {
          /* other event */
        }
      }
    } else if (
      result.status === "reverted" &&
      result.error.name === "AlreadyRecorded"
    ) {
      // fine — the email is on-chain already; observations list gives the index
    }
  }

  async function onSettle() {
    if (recordedIndex === undefined) return;
    await settleTx.send(
      {
        abi: poolAbi,
        address: deployment.pool,
        chainId: deployment.chainId,
        functionName: "settle",
        args: [BigInt(seriesId!), recordedIndex],
        account: address,
      },
      { label: "Settle market" },
    );
  }

  const alreadyRecorded =
    existingObs !== undefined ||
    (submitTx.state.status === "reverted" &&
      submitTx.state.error.name === "AlreadyRecorded");

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <header>
        <h1 className="font-parkDisplay font-bold text-3xl text-text-standard">
          Settle market #{seriesId}
        </h1>
        <p className="font-parkBody text-surface-grey-2 mt-1">
          Drop the raw CRE Daily “Market Snapshot” .eml. Every on-chain
          acceptance rule is checked locally first — nothing is sent until the
          email verifies.
        </p>
      </header>

      {rpcError ? <RpcStaleBanner /> : null}

      {s.settled ? (
        <Card>
          <div className="flex items-center gap-3 text-system-green">
            <CheckCircleIcon size={28} weight="fill" />
            <div>
              <p className="font-parkDisplay font-bold">
                Already settled — one-shot settlement has happened.
              </p>
              <p
                className="font-parkBody text-sm text-surface-grey-2"
                data-testid="settle-ratio"
              >
                Ratio {`${(Number(s.payoutRatioWad) / 1e16).toFixed(1)}%`} ·
                observation at {formatTimestamp(s.observationT)} ·{" "}
                <Link className="underline" to={`/redeem/${seriesId}`}>
                  redeem now
                </Link>
              </p>
            </div>
          </div>
        </Card>
      ) : (
        <>
          {/* dropzone */}
          <div
            data-testid="eml-dropzone"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) void onFile(f);
            }}
            className={`border-2 border-dashed rounded-2xl p-8 text-center transition-colors bg-paper-0 ${
              dragOver ? "border-core-green bg-paper-1" : "border-paper-2"
            }`}
          >
            <EnvelopeSimpleIcon
              size={40}
              className="mx-auto text-surface-grey"
            />
            <p className="font-parkBody mt-3">
              Drag & drop the <code>.eml</code> here, or
            </p>
            <label
              htmlFor="eml-file-input"
              className="inline-block mt-2 cursor-pointer rounded focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-core-green"
            >
              <span className="font-parkBody font-bold text-core-green underline">
                choose a file
              </span>
              <input
                id="eml-file-input"
                type="file"
                accept=".eml,message/rfc822"
                className="sr-only"
                data-testid="eml-input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                  e.target.value = "";
                }}
              />
            </label>
            <p className="font-parkBody text-xs text-surface-grey mt-2">
              In Gmail: ⋮ → “Download message”. The raw file, unmodified.
            </p>
          </div>

          {file.status === "reading" ? <LoadingSkeleton lines={3} /> : null}

          {file.status === "not-email" ? (
            <Card>
              <div
                className="flex items-start gap-3 text-system-red"
                role="alert"
                data-testid="preflight-error"
              >
                <XCircleIcon size={24} weight="fill" className="shrink-0" />
                <p className="font-parkBody text-sm">{file.message}</p>
              </div>
            </Card>
          ) : null}

          {file.status === "ready" ? (
            <>
              {/* preflight checklist */}
              <Card>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-parkDisplay font-bold text-lg">
                    DKIM preflight · {file.name}
                  </h2>
                  <FileArrowUpIcon size={22} className="text-surface-grey" />
                </div>
                <ul className="space-y-2" data-testid="preflight-checklist">
                  {file.report.checks.map((check) => (
                    <li
                      key={check.id}
                      data-testid={`preflight-check-${check.id}`}
                      data-pass={check.pass ? "true" : "false"}
                      className="flex items-start gap-2.5"
                    >
                      {check.pass ? (
                        <CheckCircleIcon
                          size={20}
                          weight="fill"
                          className="text-system-green shrink-0 mt-0.5"
                        />
                      ) : (
                        <XCircleIcon
                          size={20}
                          weight="fill"
                          className="text-system-red shrink-0 mt-0.5"
                        />
                      )}
                      <div>
                        <p
                          className={`font-parkBody text-sm ${check.pass ? "text-text-standard" : "text-system-red font-bold"}`}
                        >
                          {check.label}
                        </p>
                        {check.detail ? (
                          <p className="font-parkBody text-xs text-surface-grey break-all">
                            {check.detail}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
                {parsed ? (
                  <div className="mt-4 border-t border-paper-1 pt-3 font-parkBody text-sm space-y-1">
                    <p>
                      Extracted value:{" "}
                      <span className="font-bold">
                        {formatCents(parsed.cents)} / SF
                      </span>{" "}
                      · signed {formatTimestamp(emailT)}
                    </p>
                    <p className="text-xs text-surface-grey">
                      email id {truncateHex(parsed.emailId)}
                    </p>
                    {inWindow === false ? (
                      <p
                        className="text-system-red font-bold"
                        data-testid="out-of-window"
                      >
                        This email's signature time is outside the observation
                        window ({formatTimestamp(s.obsStart)} →{" "}
                        {formatTimestamp(s.obsEnd)}) — settling with it will
                        revert.
                      </p>
                    ) : null}
                    {alreadyRecorded ? (
                      <p className="text-primary-sky font-bold" data-testid="already-recorded">
                        This email is already recorded on-chain
                        {existingObs !== undefined
                          ? ` as observation #${existingObs.index}`
                          : ""}{" "}
                        — skip straight to settling.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </Card>

              {/* transactions */}
              <Card>
                <h2 className="font-parkDisplay font-bold text-lg mb-3">
                  On-chain settlement
                </h2>
                {!isConnected ? (
                  <div className="mb-3 flex flex-col gap-2">
                    <p className="font-parkBody text-sm text-surface-grey-2">
                      Settlement is permissionless — any account may do it.
                    </p>
                    <Button
                      app="fund"
                      onClick={() => openConnectModal?.()}
                      data-testid="connect-cta"
                    >
                      Connect wallet to settle
                    </Button>
                  </div>
                ) : null}
                <div className="flex flex-col gap-3">
                  <Button
                    app="fund"
                    disabled={
                      !allChecksPass ||
                      alreadyRecorded ||
                      obsIndex !== undefined ||
                      !isConnected ||
                      wrongNetwork ||
                      busy(submitTx)
                    }
                    onClick={onSubmitObservation}
                    data-testid="record-button"
                  >
                    1 · Submit observation
                  </Button>
                  <TxStatus state={submitTx.state} label="Submit" />
                  <Button
                    app="fund"
                    variant="secondary"
                    disabled={
                      recordedIndex === undefined ||
                      inWindow === false ||
                      !isConnected ||
                      wrongNetwork ||
                      busy(settleTx) ||
                      settleTx.state.status === "confirmed"
                    }
                    onClick={onSettle}
                    data-testid="settle-button"
                  >
                    2 · Settle market #{seriesId}
                    {recordedIndex !== undefined
                      ? ` with observation #${recordedIndex}`
                      : ""}
                  </Button>
                  <TxStatus state={settleTx.state} label="Settle" />
                  {settleTx.state.status === "confirmed" ? (
                    <p className="font-parkBody text-sm text-system-green">
                      Settled.{" "}
                      <Link
                        className="underline font-bold"
                        to={`/redeem/${seriesId}`}
                      >
                        Claim your payout →
                      </Link>
                    </p>
                  ) : null}
                </div>
              </Card>
            </>
          ) : null}

          {/* context */}
          <p className="font-parkBody text-xs text-surface-grey">
            Observation window: {formatTimestamp(s.obsStart)} →{" "}
            {formatTimestamp(s.obsEnd)} · now {formatTimestamp(now)} ·
            settlement is one-shot; if several observations qualify the first
            settle call wins.
          </p>
        </>
      )}
    </div>
  );
}
