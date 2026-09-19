/** Shared explorer link contract (chain/explorer.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLORER, addressUrl, txUrl } from "../chain/explorer.ts";

test("EXPLORER is Blockscout with no trailing slash", () => {
  assert.equal(EXPLORER, "https://gnosis.blockscout.com");
});

test("txUrl", () => {
  assert.equal(
    txUrl("0xabc123"),
    "https://gnosis.blockscout.com/tx/0xabc123",
  );
});

test("addressUrl", () => {
  assert.equal(
    addressUrl("0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3"),
    "https://gnosis.blockscout.com/address/0x7B22Ed9499aBF9d081A6bA4a632Ab81DE588f0f3",
  );
});
