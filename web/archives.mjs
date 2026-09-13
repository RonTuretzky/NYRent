import {
  JsonRpcProvider,
  Contract,
  Interface,
  toUtf8Bytes,
} from "./vendor/ethers.min.js";
import { prepareEmail } from "./email.mjs";
const $ = (id) => document.getElementById(id);
const names = [
  "Pinpointe",
  "The Bigger Apple",
  "Hemlane",
  "CRE Daily NY",
  "Finding Space",
  "Hallmark (out of scope)",
  "Broadsheet (out of scope)",
];
const usd = (n) =>
  (Number(n) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
const period = (n) => String(n).slice(0, 4) + "-" + String(n).slice(4);
const json = async (p) => {
  const r = await fetch(p);
  if (!r.ok) throw Error("Could not load " + p);
  return r.json();
};
let config,
  provider,
  parser,
  feed,
  corpus,
  interfaces = [],
  busy = false,
  raw = null,
  prepared = null,
  verified = null,
  sourceId = -1,
  finalizable = false;
function errorName(e) {
  for (const iface of interfaces) {
    try {
      const x = iface.parseError(e.data ?? e.info?.error?.data);
      if (x) return x.name;
    } catch {}
  }
  return e.shortMessage ?? e.message;
}
const messages = {
  NoMatchingMedian: "No supported Manhattan median statement.",
  StaleSection:
    "Section month does not match the previous month; reject the stale heading.",
  UnsupportedPublication:
    "This publication’s excerpt is outside the Manhattan median scope.",
  InvalidPeriod: "Missing, unsupported or stale reporting period.",
  AmbiguousObservation: "Duplicate or conflicting observations.",
  InvalidAmount: "Amount does not match the supported USD grammar.",
  OutsideWindow: "This month’s submission window has closed.",
  DuplicatePublication: "This publication has already contributed this value.",
  IdentityMismatch:
    "The signed identity is not in this feed’s fixed key policy.",
  BadSignature: "The signature does not verify with the pinned key.",
  BodyHashMismatch: "Signed body hash does not match the supplied body.",
  CannotFinalize: "The month is not eligible for finalization.",
};
function show(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle("error", error);
}
function log(text) {
  const li = document.createElement("li");
  li.textContent = text;
  $("pinned-log").prepend(li);
}
function buttons() {
  document.querySelectorAll("button,input,select,textarea").forEach((el) => {
    el.disabled = busy;
  });
  $("verify-pinned").disabled = busy || !prepared || sourceId < 0;
  $("submit-pinned").disabled = busy || !verified;
  $("finalize-pinned").disabled = busy || !finalizable;
}
async function action(fn, target = "parse-result") {
  if (busy) return;
  busy = true;
  buttons();
  try {
    await fn();
  } catch (e) {
    const n = errorName(e);
    show(target, messages[n] ?? n, true);
  } finally {
    busy = false;
    buttons();
  }
}
function selectRow(r) {
  $("publication").value = r.publication;
  $("issued-date").value = r.publishedAt;
  $("excerpt").value = r.text;
  $("excerpt-provenance").textContent =
    `${r.id} · ${r.evidenceKind} · curated excerpt, not an original email`;
  show(
    "parse-result",
    "Archive wording loaded. Run the parser to see its decision.",
  );
}
async function runOne(r) {
  return parser.parse(
    r.publication,
    toUtf8Bytes(r.text),
    toUtf8Bytes(r.contentType ?? "text/plain"),
    toUtf8Bytes(r.encoding ?? "8bit"),
    r.issuedAt,
  );
}
async function runAll() {
  let accepted = 0,
    rejected = 0,
    mismatch = 0;
  for (let i = 0; i < corpus.length; i++) {
    const r = corpus[i],
      cell = $("case-" + i);
    cell.textContent = "Checking…";
    try {
      const v = await runOne(r);
      cell.textContent = `${period(v[0])} · ${usd(v[1])} · rule ${v[2]}`;
      accepted++;
      if (
        r.expected.error ||
        Number(v[0]) !== r.expected.month ||
        Number(v[1]) !== r.expected.cents
      )
        mismatch++;
    } catch (e) {
      const name = errorName(e);
      cell.textContent = messages[name] ?? name;
      rejected++;
      if (name !== r.expected.error) mismatch++;
    }
    $("parsed-count").textContent = accepted;
    $("rejected-count").textContent = rejected;
    $("baseline-status").textContent =
      `Checked ${i + 1} / ${corpus.length} excerpts on Solidity.`;
  }
  $("baseline-status").textContent = mismatch
    ? `${mismatch} result(s) differ from the evidence baseline. Investigate before use.`
    : `All ${corpus.length} decisions match the reviewed baseline: ${accepted} parsed, ${rejected} rejected. No publisher authentication is claimed.`;
}
async function parseEditable() {
  const issuedAt = Date.parse($("issued-date").value + "T12:00:00Z") / 1000;
  if (!Number.isFinite(issuedAt)) throw Error("Choose a publication date.");
  const result = await runOne({
    publication: Number($("publication").value),
    text: $("excerpt").value,
    issuedAt,
  });
  show(
    "parse-result",
    `${usd(result[1])} / month\n${period(result[0])} · Manhattan median · rule ${result[2]}\nParsed only. This input is not an authenticated publisher email.`,
  );
}
function prepare(index = 0) {
  prepared = null;
  verified = null;
  sourceId = -1;
  prepared = prepareEmail(raw, index);
  sourceId = config.sources.findIndex(
    (s) =>
      s.domain === prepared.identity.domain &&
      s.from === prepared.identity.from &&
      s.listId === prepared.identity.listId,
  );
  $("pinned-signature-label").hidden = prepared.signatureCount < 2;
  $("pinned-signature").replaceChildren();
  for (let i = 0; i < prepared.signatureCount; i++)
    $("pinned-signature").add(new Option(`Signature ${i + 1}`, i));
  $("pinned-signature").value = index;
  $("loaded-email").textContent =
    `Claimed signed identity: ${prepared.identity.from} · ${prepared.identity.domain} · selector ${prepared.identity.selector}`;
  $("pinned-body").textContent = new TextDecoder().decode(
    Uint8Array.from(prepared.envelope.body.slice(2).match(/../g) ?? [], (x) =>
      parseInt(x, 16),
    ),
  );
  show(
    "pinned-result",
    sourceId < 0
      ? "This identity has no configured key in the local test feed."
      : "Envelope prepared. The next step verifies its signature and parses its body.",
    sourceId < 0,
  );
}
async function sample(i) {
  prepared = null;
  verified = null;
  sourceId = -1;
  const r = await fetch(`archive/${config.sources[i].archiveId}-test.eml`);
  if (!r.ok) throw Error("Sample unavailable");
  raw = await r.arrayBuffer();
  prepare();
}
async function verify() {
  verified = null;
  const envelope = prepared.envelope;
  const result = await feed.preview(sourceId, envelope);
  verified = { sourceId, envelope, result };
  show(
    "pinned-result",
    `${usd(result[1])} · ${period(result[0])} · grammar ${result[2]}\nDKIM verified against the configured TEST key; actual archive wording parsed in Solidity. No DNSSEC proof supplied.`,
  );
}
async function submit() {
  const v = verified;
  if (!v) throw Error("Verify the envelope first.");
  const signer = await provider.getSigner(1);
  const gas = await feed.submit.estimateGas(v.sourceId, v.envelope);
  const tx = await feed
    .connect(signer)
    .submit(v.sourceId, v.envelope, { gasLimit: (gas * 12n) / 10n });
  show("pinned-result", "Waiting for the local transaction…");
  const receipt = await tx.wait();
  verified = null;
  show(
    "pinned-result",
    "Test-signed archive wording recorded. The publication now counts once.",
  );
  log(
    `Accepted ${config.sources[v.sourceId].archiveId} · ${receipt.hash} · ${receipt.gasUsed} gas`,
  );
  await refresh();
}
async function refresh() {
  const m = await feed.months(config.month),
    end = Number(await parser.monthEnd(config.month));
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const now = Number(BigInt(block.timestamp));
  const close = end + Number(await feed.WINDOW());
  $("month-rate").textContent = m.cents ? usd(m.cents) : "—";
  $("month-sources").textContent = `${m.sources} / 2`;
  $("month-status").textContent = m.finalized
    ? "Finalized on the local chain using test signatures."
    : m.conflict
      ? "Conflicting evidence; finalization blocked."
      : `${Number(m.sources) >= 2 ? "Agreement reached; awaiting deadline." : "Awaiting matching publications."} Deadline: ${new Date(close * 1000).toISOString().slice(0, 10)} UTC.`;
  finalizable =
    !m.finalized && !m.conflict && Number(m.sources) >= 2 && now > close;
  $("advance-pinned").hidden = m.finalized || now > close;
  buttons();
}
async function advance() {
  if (
    !config.testDeployment ||
    config.chainId !== 31339 ||
    new URL(config.rpc).hostname !== "127.0.0.1"
  )
    throw Error("Local test chain only");
  const t =
    Number(await parser.monthEnd(config.month)) +
    Number(await feed.WINDOW()) +
    1;
  await provider.send("evm_setNextBlockTimestamp", [t]);
  await provider.send("evm_mine", []);
  await refresh();
}
async function finalize() {
  const signer = await provider.getSigner(1);
  const r = await (await feed.connect(signer).finalize(config.month)).wait();
  log(`Finalized ${period(config.month)} · ${r.hash}`);
  await refresh();
}
async function init() {
  try {
    [config, corpus] = await Promise.all([
      json("archive/config.json"),
      json("archive/corpus.json"),
    ]);
    if (
      config.chainId !== 31339 ||
      !config.testDeployment ||
      new URL(config.rpc).hostname !== "127.0.0.1"
    )
      throw Error("Expected isolated local archive chain");
    provider = new JsonRpcProvider(config.rpc);
    if ((await provider.getNetwork()).chainId !== 31339n)
      throw Error("Wrong chain");
    const abis = await Promise.all(
      ["ArchiveRentParser", "PinnedRentFeed", "DkimVerifier", "RentParser"].map(
        (n) => json(`abi/${n}.json`),
      ),
    );
    interfaces = abis.map((a) => new Interface(a));
    parser = new Contract(config.parser, abis[0], provider);
    feed = new Contract(config.feed, abis[1], provider);
    if ((await feed.policyHash()) !== config.policyHash)
      throw Error("Configured policy mismatch");
    names.forEach((n, i) => $("publication").add(new Option(n, i)));
    corpus.forEach((r, i) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = names[r.publication];
      const small = document.createElement("small");
      small.textContent = r.publishedAt;
      name.append(small);
      const result = document.createElement("td");
      result.id = "case-" + i;
      result.textContent = "Not run";
      const evidence = document.createElement("td");
      const a = document.createElement("a");
      a.href = r.url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent =
        r.evidenceKind === "sent_email_web_archive"
          ? "Sent-email archive ↗"
          : "Newsletter web version ↗";
      evidence.append(a);
      const control = document.createElement("td");
      const b = document.createElement("button");
      b.textContent = "Inspect";
      b.className = "quiet";
      b.setAttribute("aria-label", "Inspect " + r.id);
      b.onclick = () => {
        selectRow(r);
        $("parser").scrollIntoView({ behavior: "smooth" });
      };
      control.append(b);
      tr.append(name, result, evidence, control);
      $("baseline-rows").append(tr);
    });
    $("archive-contracts").textContent =
      `Chain 31339 · parser ${config.parser} · pinned feed ${config.feed} · policy ${config.policyHash}`;
    selectRow(corpus.find((r) => r.id === "pinpointe-2026-02"));
    $("run-all").onclick = () => action(runAll);
    $("parse-excerpt").onclick = () => action(parseEditable);
    document
      .querySelectorAll("[data-archive-email]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            action(
              () => sample(Number(b.dataset.archiveEmail)),
              "pinned-result",
            )),
      );
    $("verify-pinned").onclick = () => action(verify, "pinned-result");
    $("submit-pinned").onclick = () => action(submit, "pinned-result");
    $("advance-pinned").onclick = () => action(advance, "pinned-result");
    $("finalize-pinned").onclick = () => action(finalize, "pinned-result");
    $("refresh-pinned").onclick = () => action(refresh, "pinned-result");
    $("pinned-signature").onchange = () =>
      action(
        () => prepare(Number($("pinned-signature").value)),
        "pinned-result",
      );
    $("pinned-file").onchange = () =>
      action(async () => {
        raw = null;
        prepared = null;
        verified = null;
        sourceId = -1;
        $("pinned-body").textContent = "";
        $("loaded-email").textContent = "No valid envelope loaded.";
        const file = $("pinned-file").files[0];
        if (!file) return;
        if (file.size > 100000)
          throw Error("Maximum original email size is 100 KB.");
        raw = await file.arrayBuffer();
        prepare();
      }, "pinned-result");
    for (const id of ["excerpt", "issued-date", "publication"])
      $(id).addEventListener("input", () =>
        show("parse-result", "Input changed. Run the parser again."),
      );
    await refresh();
    await action(runAll);
  } catch (e) {
    $("baseline-status").textContent =
      `Unable to connect: ${e.message}. Run npm run archives in the project folder.`;
  }
}
init();
