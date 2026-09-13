import {
  JsonRpcProvider,
  BrowserProvider,
  Contract,
  Interface,
  toUtf8String,
  formatUnits,
} from "./vendor/ethers.min.js";
import { prepareEmail } from "./email.mjs";
const $ = (id) => document.getElementById(id);
const money = (n) => Number(n) / 100;
const usd = (n) =>
  money(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
const date = (t) =>
  new Date(Number(t) * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const json = async (path) => {
  const r = await fetch(path);
  if (!r.ok) throw Error(`Unable to load ${path}`);
  return r.json();
};
let config,
  provider,
  feed,
  signer,
  interfaces = [],
  sources = [],
  currentRaw = null,
  prepared = null,
  proof = null,
  verified = null,
  sourceId = -1,
  busy = false,
  fileGeneration = 0,
  finalizable = false;
const log = (text) => {
  if (
    $("activity").firstElementChild?.textContent.startsWith("No transactions")
  )
    $("activity").replaceChildren();
  const li = document.createElement("li");
  li.textContent = new Date().toLocaleTimeString() + " · " + text;
  $("activity").prepend(li);
};
function errorText(err) {
  let data = err.data ?? err.info?.error?.data;
  if (data && typeof data === "object") data = data.data ?? data.result;
  let name;
  if (typeof data === "string")
    for (const i of interfaces) {
      try {
        name = i.parseError(data)?.name;
        if (name) break;
      } catch {}
    }
  const errors = {
    IdentityMismatch:
      "The signed publisher identity does not match this feed’s fixed source policy.",
    BadKeyProof: "The DNSSEC proof does not authorize this DKIM key.",
    NoMatchingProof:
      "The DNSSEC signatures do not chain to the configured root anchor.",
    SignatureExpired:
      "The DNSSEC proof has expired. Supply a currently valid proof chain.",
    SignatureNotValidYet: "The DNSSEC proof is not valid yet.",
    BadSignature: "The DKIM RSA signature is invalid.",
    BodyHashMismatch:
      "The email body does not match the signed DKIM body hash.",
    UnsupportedDKIM:
      "This email uses an unsupported DKIM profile or lacks a required signed header.",
    InvalidDKIM: "The signed representation or signing time is invalid.",
    UnsupportedMIME:
      "This email’s MIME format is not supported by the fixed parser.",
    NoRecord:
      "The signed body does not contain the exact configured rent template.",
    InvalidRecord:
      "The rent record has an invalid month, amount or template structure.",
    AmbiguousRecord: "Multiple or conflicting rent records were found.",
    OutsideWindow:
      "The signing or submission time is outside this month’s fixed window.",
    AlreadySubmitted:
      "This publisher has already contributed this price for the month. A duplicate cannot add another vote.",
    InsufficientAgreement:
      "This month cannot finalize: it lacks a quorum or has a disagreement.",
    MonthClosed: "This month is already finalized.",
    UnknownSource: "This publication is not configured for the feed.",
  };
  return (
    errors[name] ??
    (name
      ? `${name}: contract rejected the submission.`
      : (err.shortMessage ?? err.message ?? String(err)))
  );
}
function status(text, error = false) {
  $("verification").className = "verification" + (error ? " error" : "");
  $("verification").replaceChildren();
  const p = document.createElement("p");
  p.textContent = text;
  $("verification").append(p);
}
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  setTimeout(() => ($("toast").hidden = true), 7000);
}
function setBusy(value) {
  busy = value;
  for (const id of ["verify", "submit-email", "connect", "finalize", "advance"])
    $(id).classList.toggle("busy", value);
  buttons();
}
function buttons() {
  $("verify").disabled = busy || !prepared || !proof || sourceId < 0;
  $("submit-email").disabled = busy || !verified;
  $("finalize").disabled = busy || !finalizable;
  $("advance").disabled = busy;
  for (const id of ["email-file", "proof-file", "signature-index", "month"]) $(id).disabled = busy;
  document.querySelectorAll("[data-sample]").forEach((button) => { button.disabled = busy; });
}
async function action(fn) {
  if (busy) return;
  setBusy(true);
  try {
    await fn();
  } catch (e) {
    status(errorText(e), true);
    log(errorText(e));
  } finally {
    setBusy(false);
  }
}
async function connect(wallet = false) {
  if (wallet) {
    if (!window.ethereum)
      throw Error(
        "No browser wallet detected. Install/connect a wallet, or use the local test account.",
      );
    const bp = new BrowserProvider(window.ethereum);
    await bp.send("eth_requestAccounts", []);
    const n = await bp.getNetwork();
    if (Number(n.chainId) !== config.chainId)
      throw Error(
        `Connect your wallet to chain ${config.chainId} before submitting.`,
      );
    signer = await bp.getSigner();
  } else {
    if (
      !config.testDeployment ||
      config.chainId !== 31338 ||
      !["127.0.0.1", "localhost"].includes(new URL(config.rpc).hostname)
    )
      throw Error(
        "Unlocked test accounts are restricted to the local demonstration.",
      );
    signer = await provider.getSigner(1);
  }
  const address = await signer.getAddress();
  $("connect").textContent = address.slice(0, 6) + "…" + address.slice(-4);
  log(
    "Connected " +
      (wallet ? "wallet" : "unprivileged local test account") +
      " " +
      address,
  );
  return signer;
}
function invalidate() {
  verified = null;
  buttons();
}
async function loadRaw(raw, label) {
  currentRaw = raw;
  invalidate();
  prepared = null;
  proof = null;
  sourceId = -1;
  $("proof-label").textContent = "Choose a proof-chain JSON file";
  $("file-label").textContent = label;
  $("email-summary").hidden = true;
  try {
    await prepareCurrent();
  } catch (e) {
    status(errorText(e), true);
    buttons();
  }
}
async function prepareCurrent(index = 0) {
  invalidate();
  prepared = prepareEmail(currentRaw, index);
  const { identity } = prepared;
  sourceId = sources.findIndex(
    (s) =>
      s.domain === identity.domain &&
      s.from === identity.from &&
      s.listId === identity.listId,
  );
  $("email-summary").hidden = false;
  $("email-summary").textContent =
    `Signed identity: ${identity.from} · DKIM domain: ${identity.domain} · Selector: ${identity.selector} · Signed body: ${prepared.bodyBytes.toLocaleString()} bytes`;
  $("body-preview").textContent = new TextDecoder().decode(
    Uint8Array.from(prepared.envelope.body.slice(2).match(/../g) ?? [], (n) =>
      parseInt(n, 16),
    ),
  );
  $("signature-label").hidden = prepared.signatureCount < 2;
  $("signature-index").replaceChildren();
  for (let i = 0; i < prepared.signatureCount; i++) {
    $("signature-index").add(new Option(`Signature ${i + 1}`, i));
  }
  $("signature-index").value = index;
  if (sourceId < 0) {
    status(
      "This email has a DKIM signature, but its publisher is not configured. Real newsletters cannot be enabled using archive excerpts or an uploader-supplied key. A new source policy requires genuine signed samples, stable templates and a verifiable DNSSEC key chain.",
      true,
    );
  } else
    status(
      "Email prepared. Supply the DNSSEC proof to ask the contract to verify and parse it.",
    );
  buttons();
}
async function sample(id) {
  const generation = ++fileGeneration;
  const r = await fetch(`fixtures/${monthValue()}/${id}.eml`);
  if (!r.ok)
    throw Error(
      "Signed test samples are available for August, September and October 2026. Choose one of those months.",
    );
  const raw = await r.arrayBuffer();
  const keyProof = await json(`fixtures/${id}-proof.json`);
  if (generation !== fileGeneration) return;
  await loadRaw(raw, `Synthetic ${id} · ${$("month").value}.eml`);
  proof = keyProof;
  $("proof-label").textContent = "Signed test DNSSEC chain loaded";
  status(
    "Synthetic email and test-root DNSSEC proof loaded. Click Verify to execute the real contract checks.",
  );
  buttons();
}
async function verify() {
  const envelope = { ...prepared.envelope, keyProof: proof };
  const result = await feed.preview(sourceId, envelope);
  const gas = await feed.submit.estimateGas(sourceId, envelope);
  verified = {
    envelope,
    sourceId,
    month: Number(result[0]),
    cents: result[1],
    commitment: result[2],
  };
  $("verification").className = "verification";
  $("verification").replaceChildren();
  const h = document.createElement("strong");
  h.textContent = usd(result[1]) + " / month";
  const p = document.createElement("p");
  p.textContent = `Contract result: ${String(result[0]).slice(0, 4)}-${String(result[0]).slice(4)} · DNSSEC key proof, DKIM signature, body hash and fixed rent template all passed.`;
  const detail = document.createElement("small");
  detail.textContent = `Estimated transaction gas: ${gas.toLocaleString()} · Evidence ${result[2]}`;
  $("verification").append(h, p, detail);
  log(
    `Contract verified ${sources[sourceId].name}: ${result[0]} at ${usd(result[1])}. No transaction sent.`,
  );
  buttons();
}
async function submit() {
  if (!verified) throw Error("Verify an email first");
  if (!signer) await connect();
  const v = verified;
  const gas = await feed.submit.estimateGas(v.sourceId, v.envelope);
  const tx = await feed
    .connect(signer)
    .submit(v.sourceId, v.envelope, { gasLimit: (gas * 120n) / 100n });
  status("Submission sent. Waiting for the transaction receipt…");
  const receipt = await tx.wait();
  log(
    `Email accepted · ${sources[v.sourceId].name} · transaction ${receipt.hash} · gas ${receipt.gasUsed.toLocaleString()}`,
  );
  $("month").value =
    String(v.month).slice(0, 4) + "-" + String(v.month).slice(4);
  invalidate();
  status(
    "Email recorded on the contract. This source contributes once to the monthly agreement.",
  );
  await refresh();
}
function monthValue() {
  return Number($("month").value.replace("-", ""));
}
async function refresh() {
  if (!feed) return;
  const month = monthValue();
  if (!month) return;
  const [m, end, block] = await Promise.all([
    feed.months(month),
    feed.monthEnd(month),
    provider.send("eth_getBlockByNumber", ["latest", false]),
  ]);
  const now = parseInt(block.timestamp, 16);
  const close = Number(end) + 45 * 86400;
  $("chain-clock").textContent = "Local chain time: " + date(now);
  $("deadline").textContent = date(close) + " · UTC";
  $("agreement").textContent = m.sources;
  $("agreement-bar").style.setProperty(
    "--fill",
    `${(Number(m.sources) / sources.length) * 100}%`,
  );
  $("rate-label").textContent = m.finalized
    ? "Finalized rate"
    : m.candidateCents
      ? "Proposed rent"
      : "Finalized rate";
  $("rate").textContent = m.candidateCents
    ? usd(m.finalized ? m.finalCents : m.candidateCents)
    : "—";
  $("rate-help").textContent = m.finalized
    ? "Stored on-chain for this month."
    : m.candidateCents
      ? "Pending finalization; not available through rate()."
      : "No finalized observation for this month.";
  $("status").className = m.conflict ? "conflict" : "";
  $("status").textContent = m.conflict
    ? "Conflicting signed evidence. This month cannot finalize."
    : m.finalized
      ? "Finalized with exact publisher agreement."
      : Number(m.sources) >= 2
        ? "Quorum reached. All received prices agree."
        : `Waiting for ${2 - Number(m.sources)} more matching publication${Number(m.sources) === 0 ? "s" : ""}.`;
  finalizable =
    !m.finalized && !m.conflict && Number(m.sources) >= 2 && now > close;
  buttons();
  $("advance").hidden = !config.testDeployment || m.finalized || now > close;
  $("receipts").replaceChildren();
  for (let i = 0; i < sources.length; i++) {
    const [v, h] = await Promise.all([
      feed.votes(month, i),
      feed.evidence(month, i),
    ]);
    const tr = document.createElement("tr");
    const vals = [
      sources[i].name,
      v ? usd(v) : "—",
      v ? "Signature verified" : "Awaiting email",
      v ? h.slice(0, 12) + "…" + h.slice(-8) : "—",
    ];
    vals.forEach((text, j) => {
      const td = document.createElement("td");
      td.textContent = text;
      if (j === 0) {
        const small = document.createElement("small");
        small.textContent = sources[i].domain;
        td.append(small);
      }
      if (j === 3) {
        td.className = "hash";
        td.title = h;
      }
      tr.append(td);
    });
    $("receipts").append(tr);
  }
}
async function init() {
  try {
    config = await json("config.json");
    provider = new JsonRpcProvider(config.rpc);
    const n = await provider.getNetwork();
    if (Number(n.chainId) !== config.chainId)
      throw Error("RPC chain does not match the deployment");
    const abis = await Promise.all(
      [
        "RentEmailFeed",
        "KeyProof",
        "DkimVerifier",
        "RentParser",
        "FrozenDNSSEC",
      ].map((n) => json(`abi/${n}.json`)),
    );
    interfaces = abis.map((a) => new Interface(a));
    feed = new Contract(config.RentEmailFeed, abis[0], provider);
    if ((await feed.policyHash()) !== config.policyHash)
      throw Error("Deployment policy hash mismatch");
    if ((await feed.testDeployment()) !== config.testDeployment)
      throw Error("Deployment mode mismatch");
    for (let i = 0; i < Number(await feed.sourceCount()); i++) {
      const s = await feed.source(i);
      sources.push({
        name: s.name,
        domain: toUtf8String(s.domain),
        from: toUtf8String(s.from),
        listId: toUtf8String(s.listId),
      });
    }
    $("network-state").textContent = "Chain " + config.chainId + " · connected";
    $("connect").textContent = "Connect test account";
    const wallet = document.createElement("button");
    wallet.textContent = "Use browser wallet";
    wallet.className = "text-button";
    wallet.addEventListener("click", () => action(() => connect(true)));
    $("connect").after(wallet);
    const details = {
      Network: "Local Anvil · chain " + config.chainId,
      Feed: config.RentEmailFeed,
      "Policy hash": config.policyHash,
      "Root anchor": config.anchorHash,
      "DNS verifier": config.FrozenDNSSEC,
      "DKIM verifier": config.DkimVerifier,
      "Rent parser": config.RentParser,
    };
    for (const [k, v] of Object.entries(details)) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      $("contract-details").append(dt, dd);
    }
    await refresh();
  } catch (e) {
    $("network-state").textContent = "Not connected";
    status(errorText(e), true);
    toast("Local chain connection failed. Run npm run local and reload.");
  }
}
$("connect").onclick = () => action(() => connect());
$("verify").onclick = () => action(verify);
$("submit-email").onclick = () => action(submit);
$("refresh").onclick = () => action(refresh);
$("month").onchange = () => action(refresh);
$("email-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const generation = ++fileGeneration;
  invalidate();
  prepared = null;
  proof = null;
  sourceId = -1;
  buttons();
  if (file.size > 100000) {
    status("File exceeds 100 KB input limit", true);
    return;
  }
  const raw = await file.arrayBuffer();
  if (generation !== fileGeneration) return;
  await loadRaw(raw, file.name);
};
$("proof-file").onchange = async (e) => {
  invalidate();
  proof = null;
  const generation = fileGeneration;
  buttons();
  try {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 1000000) throw Error("Proof file too large");
    const p = JSON.parse(await f.text());
    if (
      !Array.isArray(p) ||
      !p.length ||
      p.length > 4 ||
      p.some(
        (c) =>
          !Array.isArray(c) ||
          !c.length ||
          c.length > 16 ||
          c.some(
            (r) =>
              !/^0x(?:[a-fA-F0-9]{2})+$/.test(r.rrset) ||
              !/^0x(?:[a-fA-F0-9]{2})+$/.test(r.sig),
          ),
      )
    )
      throw Error(
        "Expected an array of DNSSEC proof chains containing rrset and sig hex bytes",
      );
    if (generation !== fileGeneration) return;
    proof = p;
    $("proof-label").textContent = f.name;
    buttons();
  } catch (e) {
    status(errorText(e), true);
  }
};
$("signature-index").onchange = () =>
  action(() => prepareCurrent(Number($("signature-index").value)));
document
  .querySelectorAll("[data-sample]")
  .forEach((b) => (b.onclick = () => action(() => sample(b.dataset.sample))));
$("finalize").onclick = () =>
  action(async () => {
    if (!signer) await connect();
    const month = monthValue();
    const tx = await feed.connect(signer).finalize(month);
    const receipt = await tx.wait();
    log(`Month ${month} finalized · transaction ${receipt.hash}`);
    toast("Monthly rate finalized on the contract.");
    await refresh();
  });
$("advance").onclick = () =>
  action(async () => {
    if (!config.testDeployment || config.chainId !== 31338)
      throw Error("Time travel is local-test only");
    const end = await feed.monthEnd(monthValue());
    await provider.send("evm_setNextBlockTimestamp", [
      Number(end) + 45 * 86400 + 1,
    ]);
    await provider.send("evm_mine", []);
    log(
      "Advanced only the local Anvil clock to the end of the submission window.",
    );
    await refresh();
  });
$("clear-log").onclick = () => $("activity").replaceChildren();
await init();
