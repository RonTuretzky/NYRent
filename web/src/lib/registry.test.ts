/**
 * Registry resolution matrix (chain/registryCore.ts): baked production
 * deployments, the legacy deployment.json → test-chain merge (with the
 * VITE_ALLOW_TEST_CHAIN / zero-address gates), default-chain selection, and
 * the stored > wallet > default active-chain resolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARBITRUM_CHAIN_ID,
  GNOSIS_CHAIN_ID,
  POLYGON_CHAIN_ID,
  buildDeployments,
  computeDefaultChainId,
  fromRaw,
  isLiveDeployment,
  legacyToTestDeployment,
  resolveActiveChainId,
  type RawDeployment,
} from "../chain/registryCore.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

const baked: Record<string, RawDeployment> = {
  "100": {
    chainId: 100,
    name: "Gnosis Chain",
    oracle: "0xCBD1F13ed4F376fBE662d4634de52C31bEFb6E43",
    token: "0x821d100Aa36Beec16D830C7E2B8D5249AF62C857",
    pool: "0x68A3b66cb9d66c359B83d6CaAEeAABbA0cA29Aa3",
    router: "0x36861cbD424CDAaf9EF981Dd8C6a89F77CEB5f8b",
    currency: {
      address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
      symbol: "WXDAI",
      decimals: 18,
    },
    seriesIds: [],
    explorerBase: "https://gnosis.blockscout.com",
  },
  "42161": {
    chainId: 42161,
    name: "Arbitrum One",
    oracle: "0x128fF279AbD137DE6e378E8aCcefFe77Ea5259B3",
    token: "0xaB1abFCa157aAD0bCE63A0a578c20122e1a9925E",
    pool: "0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c",
    router: "0xFE9CA93d607f38e152a3b3A1CB320950209c2F2F",
    currency: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      symbol: "USDC",
      decimals: 6,
    },
    seriesIds: [],
    explorerBase: "https://arbiscan.io",
  },
};

const anvilLegacy = {
  chainId: 31337,
  oracle: "0xdd45a0f7fcA25dD540625130d6c252b1880D0561",
  pool: "0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3",
  token: "0x48Db7336C15DC4439aE3F023e24FAA26b400CC87",
  currency: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
  seriesIds: [0],
};

const gnosisLegacy = { ...anvilLegacy, chainId: 100 };

// ------------------------------------------------------------------- fromRaw

test("fromRaw keeps per-chain currency meta (18-dec WXDAI vs 6-dec USDC)", () => {
  const gnosis = fromRaw(baked["100"]);
  const arb = fromRaw(baked["42161"]);
  assert.equal(gnosis.currency.decimals, 18);
  assert.equal(gnosis.currency.symbol, "WXDAI");
  assert.equal(arb.currency.decimals, 6);
  assert.equal(arb.currency.symbol, "USDC");
  assert.equal(arb.router, baked["42161"].router);
});

test("fromRaw: router stays optional", () => {
  const { router: _router, ...noRouter } = baked["100"];
  assert.equal(fromRaw(noRouter).router, undefined);
});

// ----------------------------------------------------- legacy → test entry

test("legacy deployment.json on a production chainId is NEVER a test entry", () => {
  assert.equal(legacyToTestDeployment(gnosisLegacy), undefined);
  assert.equal(
    legacyToTestDeployment({ ...anvilLegacy, chainId: 42161 }),
    undefined,
  );
});

test("legacy anvil deployment.json becomes the test entry (no router)", () => {
  const d = legacyToTestDeployment(anvilLegacy);
  assert.ok(d);
  assert.equal(d.chainId, 31337);
  assert.equal(d.router, undefined);
  assert.equal(d.currency.address, anvilLegacy.currency);
  assert.deepEqual(d.seriesIds, [0]);
});

// ----------------------------------------------------------- registry merge

test("production registry: both baked chains, no test entry", () => {
  const deployments = buildDeployments(baked, undefined, false);
  assert.deepEqual(
    Object.keys(deployments).map(Number).sort((a, b) => a - b),
    [GNOSIS_CHAIN_ID, ARBITRUM_CHAIN_ID],
  );
  assert.equal(computeDefaultChainId(deployments, undefined), GNOSIS_CHAIN_ID);
});

test("anvil e2e registry: test entry merged and made the default", () => {
  const testDep = legacyToTestDeployment(anvilLegacy);
  const deployments = buildDeployments(baked, testDep, true);
  assert.ok(deployments[31337]);
  assert.equal(computeDefaultChainId(deployments, testDep), 31337);
});

test("kill-switch: test entry excluded without allowTestChain", () => {
  const testDep = legacyToTestDeployment(anvilLegacy);
  const deployments = buildDeployments(baked, testDep, false);
  assert.equal(deployments[31337], undefined);
  // and the default falls back to Gnosis even though the entry exists
  assert.equal(computeDefaultChainId(deployments, testDep), GNOSIS_CHAIN_ID);
});

test("kill-switch: zero-address placeholders never merge", () => {
  const testDep = legacyToTestDeployment({ ...anvilLegacy, pool: ZERO });
  assert.ok(testDep);
  assert.equal(isLiveDeployment(testDep), false);
  const deployments = buildDeployments(baked, testDep, true);
  assert.equal(deployments[31337], undefined);
  assert.equal(computeDefaultChainId(deployments, testDep), GNOSIS_CHAIN_ID);
});

// -------------------------------------------------- active-chain resolution

test("resolution matrix: stored > wallet > default", () => {
  const testDep = legacyToTestDeployment(anvilLegacy);
  const prod = buildDeployments(baked, undefined, false);
  const e2e = buildDeployments(baked, testDep, true);

  // explicit stored choice wins
  assert.equal(
    resolveActiveChainId(ARBITRUM_CHAIN_ID, GNOSIS_CHAIN_ID, prod, GNOSIS_CHAIN_ID),
    ARBITRUM_CHAIN_ID,
  );
  // stale stored id (test chain from an old e2e run) falls through to wallet
  assert.equal(
    resolveActiveChainId(31337, ARBITRUM_CHAIN_ID, prod, GNOSIS_CHAIN_ID),
    ARBITRUM_CHAIN_ID,
  );
  // wallet on a known chain, nothing stored
  assert.equal(
    resolveActiveChainId(null, ARBITRUM_CHAIN_ID, prod, GNOSIS_CHAIN_ID),
    ARBITRUM_CHAIN_ID,
  );
  // wallet on an unknown chain → default (Gnosis)
  assert.equal(
    resolveActiveChainId(null, 1, prod, GNOSIS_CHAIN_ID),
    GNOSIS_CHAIN_ID,
  );
  // nothing at all → default
  assert.equal(
    resolveActiveChainId(undefined, undefined, prod, GNOSIS_CHAIN_ID),
    GNOSIS_CHAIN_ID,
  );
  // e2e build: default is the anvil chain
  assert.equal(resolveActiveChainId(null, undefined, e2e, 31337), 31337);
  // e2e build: shim wallet on 31337 resolves to the test deployment
  assert.equal(resolveActiveChainId(null, 31337, e2e, 31337), 31337);
});

// A configured but unfunded production target must not become a local xDAI chain.
test("Polygon stays a non-live production target and resolves wallet selection", () => {
  const polygon: RawDeployment = {
    chainId: POLYGON_CHAIN_ID, name: "Polygon PoS", oracle: ZERO, pool: ZERO, token: ZERO,
    currency: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", symbol: "USDC", decimals: 6 },
    seriesIds: [], explorerBase: "https://polygonscan.com",
  };
  const deployments = buildDeployments({ ...baked, [POLYGON_CHAIN_ID]: polygon }, undefined, false);
  assert.equal(legacyToTestDeployment({ ...anvilLegacy, chainId: POLYGON_CHAIN_ID }), undefined);
  assert.equal(isLiveDeployment(deployments[POLYGON_CHAIN_ID]), false);
  assert.equal(resolveActiveChainId(null, POLYGON_CHAIN_ID, deployments, GNOSIS_CHAIN_ID), POLYGON_CHAIN_ID);
  assert.equal(computeDefaultChainId(deployments, undefined), GNOSIS_CHAIN_ID);
});
