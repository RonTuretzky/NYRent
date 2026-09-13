import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
  JsonRpcProvider,
  Contract,
  toUtf8Bytes,
  ZeroAddress,
  Interface,
} from "ethers";
import { deploy, RPC } from "../scripts/deploy.mjs";
import {
  getKeys,
  makeMail,
  proof,
  aliasProof,
  profiles,
  START,
} from "../scripts/fixtures.mjs";
import { prepareEmail, canonicalBody, hex } from "../web/email.mjs";
let ctx, keys, top, snapshot;
const gas = [];
const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
const envelope = (id = "alpha", opts = {}) => ({
  ...prepareEmail(makeMail(keys, id, opts)).envelope,
  keyProof: proof(keys, id),
});
const utf = (s) => toUtf8Bytes(s);
const mutateHex = (s) => s.slice(0, -2) + (s.endsWith("00") ? "01" : "00");
const current = async () =>
  Number(
    BigInt(
      (await provider.send("eth_getBlockByNumber", ["latest", false]))
        .timestamp,
    ),
  );
const advance = async (t) => {
  await provider.send("evm_setNextBlockTimestamp", [t]);
  await provider.send("evm_mine", []);
};
const submit = async (id = "alpha", opts = {}, from = 1) => {
  const tx = await ctx.feed.connect(await provider.getSigner(from)).submit(
    profiles.findIndex((p) => p.id === id),
    envelope(id, opts),
    { gasLimit: 30000000 },
  );
  const r = await tx.wait();
  gas.push({ id, gasUsed: String(r.gasUsed) });
  return r;
};
before(async () => {
  top = await provider.send("evm_snapshot", []);
  keys = await getKeys();
  ctx = await deploy(provider, false);
});
after(async () => {
  await writeFile(".local/test-gas.json", JSON.stringify(gas, null, 2));
  await provider.send("evm_revert", [top]);
  provider.destroy();
});
beforeEach(async () => {
  snapshot = await provider.send("evm_snapshot", []);
});
afterEach(async () => {
  await provider.send("evm_revert", [snapshot]);
});

test("full DNSSEC→DKIM→Solidity parse→different public submitters→finalized monthly rate", async () => {
  assert.equal(await ctx.dns.owner(), ZeroAddress);
  assert.deepEqual(
    Array.from(await ctx.feed.preview(0, envelope())).slice(0, 2),
    [202608n, 540800n],
  );
  await submit("alpha", {}, 1);
  await assert.rejects(ctx.feed.rate(202608));
  assert.equal((await ctx.feed.months(202608)).sources, 1n);
  await submit("beta", { html: true }, 2);
  assert.equal((await ctx.feed.months(202608)).sources, 2n);
  await assert.rejects(ctx.feed.finalize.staticCall(202608));
  await advance(Number(await ctx.feed.monthEnd(202608)) + 45 * 86400 + 1);
  await (
    await ctx.feed.connect(await provider.getSigner(3)).finalize(202608)
  ).wait();
  assert.equal(await ctx.feed.rate(202608), 540800n);
  assert.equal(await ctx.feed.latestMonth(), 202608n);
});
test("native Node crypto independently verifies the prepared email signature", async () => {
  const e = envelope();
  assert(
    cryptoVerify(
      "RSA-SHA256",
      Buffer.from(e.headers.slice(2), "hex"),
      createPublicKey(keys.mailalpha),
      Buffer.from(e.signature.slice(2), "hex"),
    ),
  );
});
test("full DNSSEC chain accepts ECDSA P-256 zone signatures", async () => {
  let e = envelope("gamma");
  e.keyProof = proof({ ...keys, gamma: keys.p256 }, "gamma");
  assert.equal((await ctx.feed.preview(2, e))[1], 540800n);
});
test("DNSSEC-authenticated CNAME delegation binds the DKIM key", async () => {
  let e = envelope();
  e.keyProof = aliasProof(keys);
  assert.equal((await ctx.feed.preview(0, e))[1], 540800n);
});
test("substituted CNAME terminal proof is rejected", async () => {
  let e = envelope();
  e.keyProof = aliasProof(keys);
  e.keyProof[1] = proof(keys, "gamma")[0];
  await assert.rejects(ctx.feed.preview(0, e));
});
test("DNSSEC configuration cannot be updated by the deployer", async () => {
  await assert.rejects(
    ctx.dns.setOwner.staticCall(await ctx.signer.getAddress()),
  );
});
test("the ABI has no price setter, reporter authorization or upgrade function", async () => {
  const names = ctx.feed.interface.fragments
    .filter((f) => f.type === "function")
    .map((f) => f.name);
  for (const name of [
    "setPrice",
    "updateRate",
    "setOwner",
    "upgradeTo",
    "setReporter",
    "addSource",
  ])
    assert(!names.includes(name));
});
test("signed HTML produces the same monthly amount", async () => {
  assert.equal(
    (await ctx.feed.preview(1, envelope("beta", { html: true })))[1],
    540800n,
  );
});
test("signed base64 MIME produces the same monthly amount", async () => {
  assert.equal(
    (await ctx.feed.preview(2, envelope("gamma", { encoding: "base64" })))[1],
    540800n,
  );
});
test("signed quoted-printable MIME produces the same monthly amount", async () => {
  assert.equal(
    (
      await ctx.feed.preview(
        0,
        envelope("alpha", { encoding: "quoted-printable" }),
      )
    )[1],
    540800n,
  );
});
test("plain and HTML multipart alternatives must agree", async () => {
  const p = profiles[0].template;
  const line =
    p.beforeMonth + "2026-08" + p.beforePrice + "5,408.00" + p.afterPrice;
  const body = `--testboundary\r\nContent-Type: text/plain\r\n\r\n${line}\r\n--testboundary\r\nContent-Type: text/html\r\n\r\n<p>${line}</p>\r\n--testboundary--\r\n`;
  assert.equal(
    (
      await ctx.feed.preview(
        0,
        envelope("alpha", {
          body,
          contentType: 'multipart/alternative; boundary="testboundary"',
          encoding: "7bit",
        }),
      )
    )[1],
    540800n,
  );
});
test("conflicting multipart alternatives are rejected", async () => {
  const p = profiles[0].template;
  const line =
    p.beforeMonth + "2026-08" + p.beforePrice + "5,408.00" + p.afterPrice;
  const body = `--b\r\nContent-Type: text/plain\r\n\r\n${line}\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>${line.replace("5,408", "5,900")}</p>\r\n--b--\r\n`;
  await assert.rejects(
    ctx.feed.preview(
      0,
      envelope("alpha", {
        body,
        contentType: 'multipart/alternative; boundary="b"',
        encoding: "7bit",
      }),
    ),
  );
});

for (const [name, change] of [
  [
    "body substitution",
    (e) => {
      e.body = hex(
        Buffer.from(e.body.slice(2), "hex")
          .toString("latin1")
          .replace("5,408", "9,999"),
      );
    },
  ],
  [
    "signature bit flip",
    (e) => {
      e.signature = mutateHex(e.signature);
    },
  ],
  [
    "unsigned appended content",
    (e) => {
      e.body += Buffer.from("Appended rent 9999\r\n").toString("hex");
    },
  ],
  [
    "header substitution",
    (e) => {
      e.headers = hex(
        Buffer.from(e.headers.slice(2), "hex")
          .toString("latin1")
          .replace("2026-08", "2026-07"),
      );
    },
  ],
  [
    "DNSSEC signature bit flip",
    (e) => {
      e.keyProof[0][5].sig = mutateHex(e.keyProof[0][5].sig);
    },
  ],
  [
    "DNSSEC TXT record tampering",
    (e) => {
      e.keyProof[0][5].rrset = mutateHex(e.keyProof[0][5].rrset);
    },
  ],
  [
    "different publisher DNS key proof",
    (e) => {
      e.keyProof = proof(keys, "beta");
    },
  ],
  [
    "attacker-generated DNS root",
    (e) => {
      e.keyProof = proof(keys, "alpha", { rogue: true });
    },
  ],
  [
    "expired DNSSEC proof",
    (e) => {
      e.keyProof = proof(keys, "alpha", { expiry: START - 1 });
    },
  ],
  [
    "future DNSSEC proof",
    (e) => {
      e.keyProof = proof(keys, "alpha", { inception: START + 86400 });
    },
  ],
  [
    "empty DNSSEC proof",
    (e) => {
      e.keyProof = [];
    },
  ],
  [
    "missing DNSSEC intermediate",
    (e) => {
      e.keyProof[0].splice(2, 1);
    },
  ],
  [
    "duplicate DKIM b tag",
    (e) => {
      e.headers += Buffer.from("; b=").toString("hex");
    },
  ],
  [
    "noncanonical body",
    (e) => {
      e.body =
        "0x" +
        Buffer.from(
          "\t" + Buffer.from(e.body.slice(2), "hex").toString("latin1"),
          "latin1",
        ).toString("hex");
    },
  ],
])
  test("rejects " + name, async () => {
    let e = envelope();
    change(e);
    await assert.rejects(ctx.feed.preview(0, e));
  });

test("one email cannot count as a different publication", async () => {
  await assert.rejects(ctx.feed.preview(1, envelope()));
});
test("an unconfigured publisher index is rejected", async () => {
  await assert.rejects(ctx.feed.preview(99, envelope()));
});
test("signed wrong From identity is rejected", async () => {
  await assert.rejects(
    ctx.feed.preview(
      0,
      envelope("alpha", { from: "Attacker <someone@alpha.rent.test>" }),
    ),
  );
});
test("correct signature with no rent template is rejected", async () => {
  await assert.rejects(
    ctx.feed.preview(
      0,
      envelope("alpha", {
        body: "Ordinary email without a rent observation.\r\n",
      }),
    ),
  );
});
test("one source can only count once even when a different recipient resubmits", async () => {
  await submit();
  await assert.rejects(
    ctx.feed
      .connect(await provider.getSigner(2))
      .submit.staticCall(0, envelope()),
  );
  assert.equal((await ctx.feed.months(202608)).sources, 1n);
});
test("conflicting second publication blocks finalization despite later matching quorum", async () => {
  await submit();
  await submit("beta", { amount: "5,409.00" });
  await submit("gamma");
  assert((await ctx.feed.months(202608)).conflict);
  await advance(Number(await ctx.feed.monthEnd(202608)) + 45 * 86400 + 1);
  await assert.rejects(ctx.feed.finalize.staticCall(202608));
});
test("publisher equivocation blocks the month without adding a vote", async () => {
  await submit();
  await submit("alpha", { amount: "5,409.00" });
  const m = await ctx.feed.months(202608);
  assert(m.conflict);
  assert.equal(m.sources, 1n);
});
test("a source replay cannot reset the month or change the current value", async () => {
  await submit();
  const first = await ctx.feed.evidence(202608, 0);
  await assert.rejects(ctx.feed.submit.staticCall(0, envelope()));
  assert.equal(await ctx.feed.evidence(202608, 0), first);
});
test("no agreement cannot finalize after the deadline", async () => {
  await advance(Number(await ctx.feed.monthEnd(202608)) + 45 * 86400 + 1);
  await assert.rejects(ctx.feed.finalize.staticCall(202608));
});
test("late submissions cannot enter a finalized or closed month", async () => {
  await advance(Number(await ctx.feed.monthEnd(202608)) + 45 * 86400 + 1);
  await assert.rejects(ctx.feed.preview(0, envelope()));
});
test("signed future month is rejected", async () => {
  await assert.rejects(
    ctx.feed.preview(0, envelope("alpha", { month: "2026-09" })),
  );
});
test("signed future timestamp is rejected", async () => {
  await assert.rejects(
    ctx.feed.preview(0, envelope("alpha", { timestamp: START + 86400 })),
  );
});
test("pre-period-end timestamp is rejected", async () => {
  await assert.rejects(
    ctx.feed.preview(
      0,
      envelope("alpha", { timestamp: Date.parse("2026-08-20") / 1000 }),
    ),
  );
});
test("calendar boundaries handle leap February and December correctly", async () => {
  assert.equal(
    Number(await ctx.feed.monthEnd(202402)),
    Date.parse("2024-03-01") / 1000,
  );
  assert.equal(
    Number(await ctx.feed.monthEnd(202612)),
    Date.parse("2027-01-01") / 1000,
  );
});
test("older finalization cannot replace a later finalized latest month", async () => {
  await submit();
  await submit("beta");
  await advance(Date.parse("2026-10-05") / 1000);
  await submit("alpha", {
    month: "2026-09",
    timestamp: Date.parse("2026-10-04") / 1000,
  });
  await submit("beta", {
    month: "2026-09",
    timestamp: Date.parse("2026-10-04") / 1000,
  });
  await advance(Number(await ctx.feed.monthEnd(202609)) + 45 * 86400 + 1);
  await (await ctx.feed.finalize(202609)).wait();
  await (await ctx.feed.finalize(202608)).wait();
  assert.equal(await ctx.feed.latestMonth(), 202609n);
});
test("stale latest read fails closed under consumer maxAge", async () => {
  await submit();
  await submit("beta");
  await advance(Number(await ctx.feed.monthEnd(202608)) + 45 * 86400 + 1);
  await (await ctx.feed.finalize(202608)).wait();
  await assert.rejects(ctx.feed.latest(30 * 86400));
  assert.equal((await ctx.feed.latest(60 * 86400))[1], 540800n);
});
for (const amount of [
  "5,40",
  "05,408",
  "5,408.0",
  "5,408.000",
  "5,408–5,500",
  "-5408",
  "1",
  "999999999",
  "5,408%",
])
  test("invalid amount fails: " + amount, async () => {
    await assert.rejects(ctx.feed.preview(0, envelope("alpha", { amount })));
  });
test("integer amount without commas is accepted", async () => {
  assert.equal(
    (await ctx.feed.preview(0, envelope("alpha", { amount: "5408" })))[1],
    540800n,
  );
});
test("two matching records in one body remain ambiguous", async () => {
  let line =
    profiles[0].template.beforeMonth +
    "2026-08" +
    profiles[0].template.beforePrice +
    "5408" +
    profiles[0].template.afterPrice;
  await assert.rejects(
    ctx.feed.preview(
      0,
      envelope("alpha", { body: line + "\r\n" + line + "\r\n" }),
    ),
  );
});
test("HTML script-only rent text is not extracted", async () => {
  let line =
    profiles[0].template.beforeMonth +
    "2026-08" +
    profiles[0].template.beforePrice +
    "5408" +
    profiles[0].template.afterPrice;
  await assert.rejects(
    ctx.feed.preview(
      0,
      envelope("alpha", {
        body: "<script>" + line + "</script>\r\n",
        contentType: "text/html; charset=utf-8",
      }),
    ),
  );
});
test("HTML comment-only rent text is not extracted", async () => {
  let line =
    profiles[0].template.beforeMonth +
    "2026-08" +
    profiles[0].template.beforePrice +
    "5408" +
    profiles[0].template.afterPrice;
  await assert.rejects(
    ctx.feed.preview(
      0,
      envelope("alpha", {
        body: "<!--" + line + "-->\r\n",
        contentType: "text/html; charset=utf-8",
      }),
    ),
  );
});
test("archived website text cannot masquerade as a signed email", () => {
  assert.throws(() => prepareEmail("<p>Manhattan rent $5,408</p>"));
});
test("partial body DKIM signatures are rejected before submission", () => {
  assert.throws(
    () => prepareEmail(makeMail(keys, "alpha", { extraTags: " l=20;" })),
    /Partial/,
  );
});
test("relaxed empty body canonicalization matches RFC empty-body behavior", () => {
  assert.equal(canonicalBody(" \t\r\n\r\n"), "");
});
