import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { JsonRpcProvider, ContractFactory, toUtf8Bytes } from "ethers";
import { deployArchives, ARCHIVE_START } from "../scripts/deploy-archives.mjs";
import { artifact } from "../scripts/deploy.mjs";
import { makeMail } from "../scripts/fixtures.mjs";
import { prepareEmail } from "../web/email.mjs";

const corpus = JSON.parse(await readFile("web/archive/corpus.json", "utf8"));
const item = (id) => corpus.find((r) => r.id === id);
let child, provider, ctx, snapshot;
const outcomes = [];
before(async () => {
  child = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      "18549",
      "--chain-id",
      "31339",
      "--timestamp",
      String(ARCHIVE_START),
      "--gas-limit",
      "120000000",
      "--silent",
    ],
    { stdio: "pipe" },
  );
  let exitCode = null,
    diagnostic = "";
  child.on("exit", (code) => (exitCode = code));
  child.stderr.on("data", (x) => (diagnostic += x));
  child.stdout.resume();
  await delay(300);
  if (exitCode !== null) throw Error(`Isolated Anvil failed: ${diagnostic}`);
  provider = new JsonRpcProvider("http://127.0.0.1:18549", 31339, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  ctx = await deployArchives(provider, false);
});
after(async () => {
  await writeFile(
    ".local/archive-test-results.json",
    JSON.stringify(outcomes, null, 2),
  );
  provider?.destroy();
  child?.kill("SIGTERM");
});
beforeEach(async () => {
  snapshot = await provider.send("evm_snapshot", []);
});
afterEach(async () => {
  await provider.send("evm_revert", [snapshot]);
});
const parse = async (r, overrides = {}) => {
  const x = { ...r, ...overrides };
  return ctx.parser.parse(
    x.publication,
    toUtf8Bytes(x.text),
    toUtf8Bytes(x.contentType),
    toUtf8Bytes(x.encoding),
    x.issuedAt,
  );
};
function decodeError(e) {
  for (const iface of [
    ctx.parser.interface,
    ctx.decoder.interface,
    ctx.feed.interface,
    ctx.dkim.interface,
  ]) {
    try {
      const x = iface.parseError(e.data ?? e.info?.error?.data);
      if (x) return x.name;
    } catch {}
  }
  return e.shortMessage ?? e.message;
}
const reject = async (p, expected) =>
  assert.rejects(p, (e) => {
    assert.equal(decodeError(e), expected);
    return true;
  });

for (const row of corpus)
  test(`archive evidence ${row.id}`, async () => {
    if (row.expected.error) {
      await reject(parse(row), row.expected.error);
      outcomes.push({
        id: row.id,
        status: "rejected",
        reason: row.expected.error,
      });
    } else {
      const result = await parse(row);
      assert.equal(Number(result[0]), row.expected.month);
      assert.equal(Number(result[1]), row.expected.cents);
      outcomes.push({
        id: row.id,
        status: "parsed",
        month: Number(result[0]),
        cents: Number(result[1]),
        rule: Number(result[2]),
        authenticated: false,
      });
    }
  });

test("real archive agreement: Pinpointe and Bigger Apple both extract January 2026 at 469500 cents", async () => {
  const a = await parse(item("pinpointe-2026-02")),
    b = await parse(item("bigger-2026-02"));
  assert.deepEqual([...a].slice(0, 2), [...b].slice(0, 2));
});
test("real archive agreement: May 2025 matches despite different June/July publication dates", async () => {
  const a = await parse(item("pinpointe-2025-06")),
    b = await parse(item("hemlane-2025-07"));
  assert.deepEqual([...a].slice(0, 2), [...b].slice(0, 2));
});
test("March Pinpointe selects $5000 median, not its $5206 one-bedroom mean", async () => {
  assert.equal((await parse(item("pinpointe-2026-04")))[1], 500000n);
});
test("unsupported prose changes fail closed", async () => {
  const r = item("bigger-2026-02");
  await reject(
    parse(r, { text: r.text.replace("was", "stood at") }),
    "NoMatchingMedian",
  );
});
test("the profile is required; identical wording under another publication fails", async () => {
  await reject(
    parse(item("bigger-2026-02"), { publication: 2 }),
    "NoMatchingMedian",
  );
});
for (const bad of [
  "4,69",
  "04,695",
  "4,695.1",
  "4,695.123",
  "4,695k",
  "4,695/yr",
  "4,6950",
  "-4,695",
  "4.695,00",
]) {
  test(`malformed amount ${bad} is rejected`, async () => {
    const r = item("bigger-2026-02");
    await assert.rejects(parse(r, { text: r.text.replace("4,695", bad) }));
  });
}
test("decimal cents are parsed exactly", async () => {
  const r = item("bigger-2026-02");
  assert.equal(
    (await parse(r, { text: r.text.replace("4,695", "4,695.27") }))[1],
    469527n,
  );
});
for (const suffix of [" million", " per year", " per square foot", "k"])
  test(`Pinpointe rejects changed amount unit: ${suffix}`, async () => {
    const r = item("pinpointe-2026-02");
    await reject(parse(r, { text: r.text + suffix }), "InvalidAmount");
  });
test("duplicate matching sentences cannot silently select the first value", async () => {
  const r = item("bigger-2026-02");
  await reject(
    parse(r, { text: r.text + " " + r.text.replace("4,695", "4,800") }),
    "AmbiguousObservation",
  );
});
test("duplicate Pinpointe headings are rejected", async () => {
  const r = item("pinpointe-2026-02");
  await reject(
    parse(r, { text: r.text + "\n" + r.text }),
    "AmbiguousObservation",
  );
});
test("Pinpointe price outside Rental Rundown is not accepted", async () => {
  const r = item("pinpointe-2026-02");
  await reject(
    parse(r, { text: r.text.replace("Rental Rundown", "Sales Snapshot") }),
    "NoMatchingMedian",
  );
});
test("conflicting Pinpointe section and news headline are rejected", async () => {
  const r = item("pinpointe-2026-02");
  await reject(
    parse(r, {
      text:
        r.text +
        ".\nSales Snapshot\nNews You Can Use\nManhattan Hits All-Time Rental High: $4,800 Median in January",
    }),
    "AmbiguousObservation",
  );
});
test("past explicit years cannot be silently assigned to this year", async () => {
  const r = item("hemlane-2025-07");
  await reject(
    parse(r, { text: r.text.replace("May.", "May 2024.") }),
    "InvalidPeriod",
  );
});
test("future named months and references older than 90 days are rejected", async () => {
  const r = item("hemlane-2025-07");
  await reject(
    parse(r, { text: r.text.replace("May.", "August.") }),
    "InvalidPeriod",
  );
  await reject(
    parse(r, { text: r.text.replace("May.", "January.") }),
    "InvalidPeriod",
  );
});
test("last month crosses year boundary using the authenticated timestamp", async () => {
  const r = item("bigger-2026-02");
  assert.equal(
    (
      await parse(r, { issuedAt: Date.parse("2026-01-13T12:00:00Z") / 1000 })
    )[0],
    202512n,
  );
});
test("basic HTML and base64 use the same on-chain grammar", async () => {
  const r = item("pinpointe-2026-02");
  const html =
    "<html><body>" +
    r.text
      .split("\n")
      .map((x) => "<p>" + x + "</p>")
      .join("") +
    "</body></html>";
  const result = await parse(r, {
    text: Buffer.from(html).toString("base64"),
    contentType: "text/html",
    encoding: "base64",
  });
  assert.equal(result[0], 202601n);
  assert.equal(result[1], 469500n);
});
test("HTML comments and scripts cannot supply the only price", async () => {
  const r = item("bigger-2026-02");
  await reject(
    parse(r, {
      contentType: "text/html",
      text: `<script>${r.text}</script><!--${r.text}-->`,
    }),
    "NoMatchingMedian",
  );
});
test("multipart alternatives must agree", async () => {
  const r = item("bigger-2026-02");
  const text = `--b\r\nContent-Type: text/plain\r\n\r\n${r.text}\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>${r.text.replace("4,695", "4,800")}</p>\r\n--b--\r\n`;
  await reject(
    parse(r, {
      text,
      contentType: 'multipart/alternative; boundary="b"',
      encoding: "7bit",
    }),
    "AmbiguousObservation",
  );
});

const envelope = (i) => prepareEmail(ctx.emails[i].raw).envelope;
const advance = async (t) => {
  await provider.send("evm_setNextBlockTimestamp", [t]);
  await provider.send("evm_mine", []);
};
test("pinned-key full flow: actual archive wording, test signatures, two public submitters, finalized January", async () => {
  for (let i = 0; i < 2; i++) {
    const preview = await ctx.feed.preview(i, envelope(i));
    assert.equal(preview[0], 202601n);
    assert.equal(preview[1], 469500n);
    const receipt = await (
      await ctx.feed
        .connect(await provider.getSigner(i + 1))
        .submit(i, envelope(i))
    ).wait();
    outcomes.push({
      kind: "test-signature-harness",
      publication: i,
      gasUsed: String(receipt.gasUsed),
    });
  }
  await reject(ctx.feed.rate(202601), "NoFinalRate");
  await advance(Number(await ctx.parser.monthEnd(202601)) + 90 * 86400 + 1);
  await (
    await ctx.feed.connect(await provider.getSigner(3)).finalize(202601)
  ).wait();
  assert.equal(await ctx.feed.rate(202601), 469500n);
  await reject(ctx.feed.latest(86400), "StaleRate");
});
test("pinned-key submission needs no DNSSEC proof or caller-supplied public key", async () => {
  assert.deepEqual(Object.keys(envelope(0)).sort(), [
    "body",
    "headers",
    "signature",
  ]);
  assert.equal((await ctx.feed.preview(0, envelope(0)))[1], 469500n);
});
test("wrong signing key with correct claimed identity is rejected", async () => {
  const raw = makeMail({ ...ctx.keys, mailalpha: ctx.keys.rogue }, "alpha", {
    body: item("pinpointe-2026-02").text.replace(/\n/g, "\r\n") + "\r\n",
    timestamp: item("pinpointe-2026-02").issuedAt,
  });
  await reject(ctx.feed.preview(0, prepareEmail(raw).envelope), "BadSignature");
});
test("altering signed body bytes is rejected before parsing", async () => {
  const e = envelope(0);
  e.body = Buffer.from(
    Buffer.from(e.body.slice(2), "hex")
      .toString("latin1")
      .replace("4,695", "9,999"),
    "latin1",
  );
  await reject(ctx.feed.preview(0, e), "BodyHashMismatch");
});
test("a publisher cannot use another publication profile", async () => {
  await reject(ctx.feed.preview(1, envelope(0)), "IdentityMismatch");
});
test("duplicate publication does not count twice", async () => {
  await (await ctx.feed.submit(0, envelope(0))).wait();
  await reject(
    ctx.feed.submit.staticCall(0, envelope(0)),
    "DuplicatePublication",
  );
  assert.equal((await ctx.feed.months(202601)).sources, 1n);
});
test("conflicting signed publication blocks finalization", async () => {
  await (await ctx.feed.submit(0, envelope(0))).wait();
  const raw = makeMail(ctx.keys, "beta", {
    body: item("bigger-2026-02").text.replace("4,695", "4,800") + "\r\n",
    timestamp: item("bigger-2026-02").issuedAt,
  });
  await (await ctx.feed.submit(1, prepareEmail(raw).envelope)).wait();
  await advance(Number(await ctx.parser.monthEnd(202601)) + 90 * 86400 + 1);
  await reject(ctx.feed.finalize.staticCall(202601), "CannotFinalize");
});
test("late archived emails cannot update a closed monthly window", async () => {
  await advance(Number(await ctx.parser.monthEnd(202601)) + 90 * 86400 + 1);
  await reject(ctx.feed.preview(0, envelope(0)), "OutsideWindow");
});
test("pin policy has no mutable keys, prices, source list or owner", async () => {
  const names = ctx.feed.interface.fragments
    .filter((x) => x.type === "function")
    .map((x) => x.name);
  for (const name of ["setKey", "setPrice", "setSource", "upgradeTo", "owner"])
    assert(!names.includes(name));
});
test("duplicate configured identity cannot create extra publication votes", async () => {
  const a = await artifact("PinnedRentFeed", "PinnedRentFeed");
  const f = new ContractFactory(a.abi, a.bytecode.object, ctx.signer);
  await assert.rejects(
    f.deploy(
      await ctx.dkim.getAddress(),
      await ctx.parser.getAddress(),
      [ctx.sources[0], ctx.sources[0]],
      2,
      true,
    ),
  );
});
