/**
 * Unit tests for oracle.mjs's pure transform against the RECORDED live read
 * of the Gnosis CredailyRentOracle (fixtures/oracle-observations.json,
 * captured via viem over https://rpc.gnosischain.com — see
 * fixtures/CAPTURE.md). Run: node --test agent/collectors/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { observationsToSignals, DEFAULT_ORACLE, ORACLE_ABI } from "./oracle.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = JSON.parse(readFileSync(path.join(FIXTURES, "oracle-observations.json"), "utf8"));

test("recorded fixture is the live deployment on Gnosis", () => {
  assert.equal(fixture.chainId, 100);
  assert.equal(fixture.oracle, DEFAULT_ORACLE);
  assert.ok(fixture.observations.length >= 1);
});

test("observationsToSignals: observation #0 = 9288 cents from the DKIM email", () => {
  const signals = observationsToSignals(fixture.observations, fixture.oracle);
  assert.equal(signals.length, fixture.observations.length);
  const s = signals[0];
  assert.equal(s.source, "oracle");
  assert.equal(s.kind, "onchain_observation_cents");
  assert.equal(s.value, 9288); // $92.88 / SF — settled series 0 at payout ratio 0.61
  // t = 1789642464 (DKIM signature timestamp) -> 2026-09-17T10:54:24Z
  assert.equal(s.asOf, "2026-09-17T10:54:24.000Z");
  assert.ok(s.detail.includes("0x5cef15b201facb36640cfd59d166688d731d3a86b88f58b5edea419382b948e1"), s.detail);
  assert.ok(s.url.includes(DEFAULT_ORACLE));
});

test("vendored ABI matches the CredailyRentOracle views the collector reads", () => {
  const names = ORACLE_ABI.map((f) => f.name);
  assert.deepEqual(names.sort(), ["observationCount", "observations"]);
  const obs = ORACLE_ABI.find((f) => f.name === "observations");
  assert.deepEqual(
    obs.outputs.map((o) => o.type),
    ["uint64", "uint32", "bytes32"],
  );
});
