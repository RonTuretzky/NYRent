/**
 * isDeployed matrix (chain/isDeployed.ts): zero-address placeholders and the
 * wrong-chain-in-PROD kill-switch, incl. the e2e VITE_ALLOW_TEST_CHAIN escape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeIsDeployed, ZERO_ADDRESS } from "../chain/isDeployed.ts";

const real = {
  chainId: 100,
  oracle: "0xdd45a0f7fcA25dD540625130d6c252b1880D0561",
  pool: "0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3",
  token: "0x48Db7336C15DC4439aE3F023e24FAA26b400CC87",
  currency: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
} as const;

const PROD = { prod: true, allowTestChain: false };
const DEV = { prod: false, allowTestChain: false };

test("deployed: real Gnosis addresses in PROD", () => {
  assert.equal(computeIsDeployed(real, PROD), true);
});

test("not deployed: any zero-address placeholder", () => {
  for (const key of ["oracle", "pool", "token", "currency"] as const) {
    assert.equal(
      computeIsDeployed({ ...real, [key]: ZERO_ADDRESS }, PROD),
      false,
      `zero ${key} should kill isDeployed`,
    );
    assert.equal(
      computeIsDeployed({ ...real, [key]: ZERO_ADDRESS }, DEV),
      false,
    );
  }
});

test("kill-switch: non-Gnosis chainId in a PROD build", () => {
  assert.equal(computeIsDeployed({ ...real, chainId: 31337 }, PROD), false);
});

test("kill-switch escape: VITE_ALLOW_TEST_CHAIN=1 (e2e stack)", () => {
  assert.equal(
    computeIsDeployed(
      { ...real, chainId: 31337 },
      { prod: true, allowTestChain: true },
    ),
    true,
  );
});

test("dev builds may point at any chain", () => {
  assert.equal(computeIsDeployed({ ...real, chainId: 31337 }, DEV), true);
});
