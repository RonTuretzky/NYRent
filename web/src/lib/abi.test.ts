/**
 * Both policy pools are driven with the V2 ABI (chain/apartments.ts
 * policyPoolAbi). That is only sound while V2's ABI is V1's plus new errors:
 * every V1 function and event must appear in V2 with the same signature.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Item = { type: string; name?: string; inputs?: { type: string }[]; outputs?: { type: string }[] };

function abiFrom(file: string, name: string): Item[] {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = src.indexOf("[", src.indexOf(`export const ${name}`));
  let depth = 0;
  let end = start;
  for (; end < src.length; end++) {
    if (src[end] === "[") depth++;
    if (src[end] === "]" && --depth === 0) break;
  }
  return JSON.parse(src.slice(start, end + 1));
}

const sig = (e: Item) => `${e.type} ${e.name ?? ""}(${(e.inputs ?? []).map((i) => i.type).join(",")})${(e.outputs ?? []).map((o) => o.type).join(",")}`;

test("the V2 pool ABI is a superset of V1's; the only additions are errors", () => {
  const v1 = new Set(abiFrom("../chain/apartmentsAbi.ts", "apartmentsPoolAbi").map(sig));
  const v2 = new Set(abiFrom("../chain/apartmentsV2Abi.ts", "apartmentsPoolV2Abi").map(sig));
  for (const s of v1) assert.ok(v2.has(s), `V2 lacks ${s}`);
  const added = [...v2].filter((s) => !v1.has(s));
  assert.deepEqual(added, ["error RentAlreadyRecorded()"]);
});

test("the committed deployment names the live pool on Arbitrum One", () => {
  const d = JSON.parse(readFileSync(new URL("../chain/apartments-deployment.json", import.meta.url), "utf8"));
  assert.equal(d.chainId, 42161);
  for (const a of [d.oracle, d.v2.pool, d.v2.token]) assert.match(a, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(d.v1, undefined);
});