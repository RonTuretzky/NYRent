/** Per-chain explorer link contract (chain/explorer.ts): every caller passes
 * the base captured from the deployment that produced the link (no module
 * global), and an empty local-chain base falls back to Blockscout. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLORER, addressUrl, txUrl } from "../chain/explorer.ts";

const BLOCKSCOUT = "https://gnosis.blockscout.com";
const ARBISCAN = "https://arbiscan.io";

test("EXPLORER is Blockscout with no trailing slash", () => {
  assert.equal(EXPLORER, BLOCKSCOUT);
});

test("links are built from the passed base, per chain", () => {
  assert.equal(
    txUrl("0xabc123", BLOCKSCOUT),
    "https://gnosis.blockscout.com/tx/0xabc123",
  );
  assert.equal(txUrl("0xabc123", ARBISCAN), "https://arbiscan.io/tx/0xabc123");
  assert.equal(
    addressUrl("0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3", BLOCKSCOUT),
    "https://gnosis.blockscout.com/address/0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3",
  );
  assert.equal(
    addressUrl("0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c", ARBISCAN),
    "https://arbiscan.io/address/0x6699fb5cdADb6065c71457Dc44A6f9d0688a5e4c",
  );
});

test("empty base (local anvil chain) falls back to Blockscout", () => {
  assert.equal(txUrl("0xabc123", ""), "https://gnosis.blockscout.com/tx/0xabc123");
  assert.equal(
    addressUrl("0xdead", ""),
    "https://gnosis.blockscout.com/address/0xdead",
  );
});
