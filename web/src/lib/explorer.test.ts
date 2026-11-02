/** Explorer link contract (chain/explorer.ts): every caller passes the base
 * captured when the link was created, and an empty base falls back to
 * Arbiscan. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPLORER, addressUrl, txUrl } from "../chain/explorer.ts";

const ARBISCAN = "https://arbiscan.io";

test("EXPLORER is Arbiscan with no trailing slash", () => {
  assert.equal(EXPLORER, ARBISCAN);
});

test("links are built from the passed base", () => {
  assert.equal(txUrl("0xabc123", ARBISCAN), "https://arbiscan.io/tx/0xabc123");
  assert.equal(
    addressUrl("0xa59b195135D5220c82d2C19270CadC392585F30A", ARBISCAN),
    "https://arbiscan.io/address/0xa59b195135D5220c82d2C19270CadC392585F30A",
  );
  assert.equal(txUrl("0xabc123", "https://example.test"), "https://example.test/tx/0xabc123");
});

test("an empty base falls back to Arbiscan", () => {
  assert.equal(txUrl("0xabc123", ""), "https://arbiscan.io/tx/0xabc123");
  assert.equal(addressUrl("0xdead", ""), "https://arbiscan.io/address/0xdead");
});
