/**
 * collect.mjs — run every collector live and print the full signal bundle
 * as JSON on stdout (log lines go to stderr). This is the daily entry point:
 *
 *   node collectors/collect.mjs            # pretty summary + JSON bundle
 *   node collectors/collect.mjs --json     # JSON bundle only
 */
import { collectCredaily } from "./credaily.mjs";
import { collectKalshi } from "./kalshi.mjs";
import { collectReports } from "./reports.mjs";
import { collectOracle } from "./oracle.mjs";

const jsonOnly = process.argv.includes("--json");
const log = (...a) => console.error(...a);

const started = new Date().toISOString();
const [credaily, kalshi, reports, oracle] = await Promise.all([
  collectCredaily(),
  collectKalshi(),
  collectReports(),
  collectOracle(),
]);

const results = { credaily, kalshi, reports, oracle };
const bundle = {
  collectedAt: started,
  signals: [],
  failures: [],
};
for (const [name, res] of Object.entries(results)) {
  if (res.ok) {
    bundle.signals.push(...res.signals);
    for (const e of res.errors ?? []) bundle.failures.push({ source: name, error: e, fatal: false });
  } else {
    bundle.failures.push({ source: name, error: res.error, fatal: true });
  }
}

if (!jsonOnly) {
  for (const [name, res] of Object.entries(results)) {
    log(
      res.ok
        ? `${name.padEnd(9)} OK    ${res.signals.length} signal(s)${res.errors?.length ? ` (${res.errors.length} non-fatal)` : ""}`
        : `${name.padEnd(9)} FAIL  ${res.error}`,
    );
  }
  log(`total: ${bundle.signals.length} signals, ${bundle.failures.length} failure note(s)`);
}
console.log(JSON.stringify(bundle, null, 2));
process.exit(bundle.signals.length > 0 ? 0 : 1);
