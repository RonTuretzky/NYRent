import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Cuer } from "cuer";
import { create } from "cuer/QrCode";
import decodeQR from "qr/decode.js";

// Synthetic pairing data. Exercise the actual RainbowKit QR dependency so
// a dependency update cannot silently reintroduce its border=0 render crash.
const uri = `wc:${"a".repeat(64)}@2?relay-protocol=irn&symKey=${"b".repeat(64)}`;

test("wallet QR renders without crashing the connection modal", () => {
  const markup = renderToStaticMarkup(createElement(Cuer, { value: uri, errorCorrection: "medium" }));
  assert.match(markup, /<svg/);
  assert.match(markup, /<path|<rect/);
});

test("wallet QR module matrix decodes to the original pairing URI", () => {
  const { grid, edgeLength } = create(uri, { errorCorrection: "medium" });
  const padding = 4;
  const scale = 6;
  const width = (edgeLength + padding * 2) * scale;
  const data = new Uint8Array(width * width * 3).fill(255);
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      if (grid[Math.floor(y / scale) - padding]?.[Math.floor(x / scale) - padding]) {
        data.fill(0, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    }
  }
  assert.equal(decodeQR({ width, height: width, data }), uri);
});
