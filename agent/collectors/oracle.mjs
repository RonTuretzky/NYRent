/**
 * oracle.mjs — on-chain collector: the settled truth. Reads every recorded
 * observation from the live CredailyRentOracle on Gnosis (chainId 100) via
 * viem. Each observation is a DKIM-verified CRE Daily email whose
 * "Manhattan Office Rent · Avg Effective" value was extracted by
 * src/lib/Dkim.sol on-chain — this is the series the CoverPool settles on.
 *
 * Read-only: no key, no writes. Addresses are vendored here (instead of
 * importing web/src/deployment.json) because web/ is owned by a concurrent
 * workflow; override with ORACLE_ADDRESS / GNOSIS_RPC_URL env vars.
 */
import { createPublicClient, http } from "viem";
import { gnosis } from "viem/chains";

import { signal, fail, isMain, printResult, DEFAULT_TIMEOUT_MS } from "./_shared.mjs";

// Live Gnosis deployment (docs/VERIFICATION.md; matches web/src/deployment.json)
export const DEFAULT_ORACLE = "0xdd45a0f7fcA25dD540625130d6c252b1880D0561";
export const DEFAULT_RPC = "https://rpc.gnosischain.com";

// Minimal vendored ABI — src/CredailyRentOracle.sol views
export const ORACLE_ABI = [
  {
    type: "function",
    name: "observationCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "observations",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "t", type: "uint64" },
      { name: "cents", type: "uint32" },
      { name: "emailId", type: "bytes32" },
    ],
  },
];

/**
 * Pure transform (unit-tested against the recorded live read):
 * [{ index, t, cents, emailId }] -> Signal[]. `t` is the DKIM signature
 * timestamp of the settlement email — the datum's own time, used as asOf.
 */
export function observationsToSignals(observations, oracle = DEFAULT_ORACLE) {
  return observations.map((o) =>
    signal({
      source: "oracle",
      asOf: new Date(Number(o.t) * 1000).toISOString(),
      kind: "onchain_observation_cents",
      value: Number(o.cents),
      detail: `observation #${o.index}: $${(Number(o.cents) / 100).toFixed(2)} / SF, emailId ${o.emailId} (DKIM-verified CRE Daily email — the settled truth)`,
      url: `https://gnosisscan.io/address/${oracle}#readContract`,
    }),
  );
}

/**
 * Collector: read observationCount + every observation. Never throws.
 * Zero rpc retries, hard per-call timeout.
 */
export async function collectOracle({
  rpcUrl = process.env.GNOSIS_RPC_URL || DEFAULT_RPC,
  oracle = process.env.ORACLE_ADDRESS || DEFAULT_ORACLE,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const source = "oracle";
  try {
    const client = createPublicClient({
      chain: gnosis,
      transport: http(rpcUrl, { timeout: timeoutMs, retryCount: 0 }),
    });
    const read = (functionName, args = []) =>
      client.readContract({ address: oracle, abi: ORACLE_ABI, functionName, args });

    const count = await read("observationCount");
    const observations = [];
    for (let i = 0n; i < count; i++) {
      const [t, cents, emailId] = await read("observations", [i]);
      observations.push({ index: Number(i), t: t.toString(), cents: Number(cents), emailId });
    }
    return { ok: true, signals: observationsToSignals(observations, oracle), observations };
  } catch (err) {
    return fail(source, err?.shortMessage ?? err?.message ?? err);
  }
}

if (isMain(import.meta.url)) {
  const res = await collectOracle();
  printResult("oracle", res);
  process.exit(res.ok ? 0 : 1);
}
