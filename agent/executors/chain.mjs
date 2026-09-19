/**
 * chain.mjs — tiny shared helpers for the agent package (env loading + JSON
 * bigint rendering). Nothing chain-specific lives here anymore:
 *
 *   - per-chain deployments/ABIs for the RUNNER:   agent/targets.mjs
 *   - per-chain deployments/ABIs for the EXECUTORS: agent/executors/targets.mjs
 *
 * The sponsor-era constants that used to live here (legacy Gnosis pool address,
 * fundPool/withdrawExcess/setSalesPaused ABI, the sponsor address) are GONE —
 * the deployed protocol is permissionless (src/CoverPool.sol: no roles at all)
 * and the retired v1 pool is history, not configuration.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Load repo-root .env (gitignored) without overriding real env vars.
 * Same semantics as scripts/_lib.mjs loadEnv, duplicated to stay decoupled from web/.
 */
export function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

/** JSON.stringify replacer that renders bigints as decimal strings. */
export const jsonBigint = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
