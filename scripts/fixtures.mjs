import {
  generateKeyPairSync,
  createHash,
  sign,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { canonicalBody, canonicalHeader, prepareEmail } from "../web/email.mjs";

export const START = Date.parse("2026-09-10T12:00:00Z") / 1000;
const b = (s) => Buffer.from(s);
const sha = (s) => createHash("sha256").update(s).digest();
const u16 = (n) => {
  const v = Buffer.alloc(2);
  v.writeUInt16BE(n);
  return v;
};
const u32 = (n) => {
  const v = Buffer.alloc(4);
  v.writeUInt32BE(n);
  return v;
};
export const wire = (name) =>
  name === "."
    ? b([0])
    : Buffer.concat([
        ...name.split(".").map((s) => Buffer.concat([b([s.length]), b(s)])),
        b([0]),
      ]);
const keytag = (r) => {
  let n = 0;
  for (let i = 0; i < r.length; i++) n += i % 2 ? r[i] : r[i] << 8;
  n += (n >> 16) & 65535;
  return n & 65535;
};
const rr = (name, type, rdata) =>
  Buffer.concat([
    wire(name),
    u16(type),
    u16(1),
    u32(3600),
    u16(rdata.length),
    rdata,
  ]);
function dnskey(key) {
  const j = createPublicKey(key).export({ format: "jwk" });
  if (j.kty === "EC")
    return Buffer.concat([
      u16(257),
      b([3, 13]),
      Buffer.from(j.x, "base64url"),
      Buffer.from(j.y, "base64url"),
    ]);
  const e = Buffer.from(j.e, "base64url"),
    n = Buffer.from(j.n, "base64url");
  return Buffer.concat([u16(257), b([3, 8, e.length]), e, n]);
}
function ds(name, key) {
  const data = dnskey(key);
  return rr(
    name,
    43,
    Buffer.concat([
      u16(keytag(data)),
      b([data[3], 2]),
      sha(Buffer.concat([wire(name), data])),
    ]),
  );
}
function signed(name, type, rdata, zone, key, options = {}) {
  const head = Buffer.concat([
    u16(type),
    b([dnskey(key)[3], name === "." ? 0 : name.split(".").length]),
    u32(3600),
    u32(options.expiry ?? START + 120 * 86400),
    u32(options.inception ?? START - 15 * 86400),
    u16(keytag(dnskey(key))),
    wire(zone),
  ]);
  const data = Buffer.concat([head, rr(name, type, rdata)]);
  return {
    rrset: "0x" + data.toString("hex"),
    sig:
      "0x" +
      sign("sha256", data, { key, dsaEncoding: "ieee-p1363" }).toString("hex"),
  };
}
function dsRdata(name, key) {
  return ds(name, key).subarray(wire(name).length + 10);
}
export async function getKeys() {
  await mkdir(".local", { recursive: true });
  let saved;
  try {
    saved = JSON.parse(await readFile(".local/test-keys.json", "utf8"));
  } catch {
    saved = {};
    for (const name of [
      "root",
      "test",
      "alpha",
      "beta",
      "gamma",
      "mailalpha",
      "mailbeta",
      "mailgamma",
      "rogue",
    ]) {
      saved[name] = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicExponent: 65537,
      }).privateKey.export({ type: "pkcs8", format: "pem" });
    }
    await writeFile(".local/test-keys.json", JSON.stringify(saved), {
      mode: 0o600,
    });
  }
  if (!saved.p256) {
    saved.p256 = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }).privateKey.export({ type: "pkcs8", format: "pem" });
    await writeFile(".local/test-keys.json", JSON.stringify(saved), {
      mode: 0o600,
    });
  }
  return Object.fromEntries(
    Object.entries(saved).map(([k, v]) => [k, createPrivateKey(v)]),
  );
}
export function proof(keys, source, options = {}) {
  const domain = source + ".rent.test";
  const root = options.rogue ? keys.rogue : keys.root;
  const der = createPublicKey(keys["mail" + source]).export({
    type: "spki",
    format: "der",
  });
  const txt = b("v=DKIM1; k=rsa; p=" + der.toString("base64"));
  const chunks = [];
  for (let i = 0; i < txt.length; i += 200) {
    let chunk = txt.subarray(i, i + 200);
    chunks.push(b([chunk.length]), chunk);
  }
  return [
    [
      signed(".", 48, dnskey(root), ".", root, options),
      signed("test", 43, dsRdata("test", keys.test), ".", root, options),
      signed("test", 48, dnskey(keys.test), "test", keys.test, options),
      signed(
        domain,
        43,
        dsRdata(domain, keys[source]),
        "test",
        keys.test,
        options,
      ),
      signed(domain, 48, dnskey(keys[source]), domain, keys[source], options),
      signed(
        "rent._domainkey." + domain,
        16,
        Buffer.concat(chunks),
        domain,
        keys[source],
        options,
      ),
    ],
  ];
}
export function aliasProof(keys, source = "alpha", target = "beta") {
  const a = proof(keys, source)[0],
    c = proof(keys, target)[0];
  const domain = source + ".rent.test",
    destination = "rent._domainkey." + target + ".rent.test";
  a[a.length - 1] = signed(
    "rent._domainkey." + domain,
    5,
    wire(destination),
    domain,
    keys[source],
  );
  const txt = b(
    "v=DKIM1; k=rsa; p=" +
      createPublicKey(keys["mail" + source])
        .export({ type: "spki", format: "der" })
        .toString("base64"),
  );
  const chunks = [];
  for (let i = 0; i < txt.length; i += 200) {
    const piece = txt.subarray(i, i + 200);
    chunks.push(b([piece.length]), piece);
  }
  c[c.length - 1] = signed(
    destination,
    16,
    Buffer.concat(chunks),
    target + ".rent.test",
    keys[target],
  );
  return [a, c];
}
export const profiles = ["alpha", "beta", "gamma"].map((id, i) => ({
  id,
  name: "Test publication " + String.fromCharCode(65 + i),
  domain: id + ".rent.test",
  from: `Rent Bulletin <rent@${id}.rent.test>`,
  listId: "",
  template: [
    {
      beforeMonth: "Manhattan rental report for ",
      beforePrice: ". Corcoran one-bedroom average rent: $",
      afterPrice: " per month.",
    },
    {
      beforeMonth: "Corcoran Manhattan one-bedroom mean, ",
      beforePrice: ": $",
      afterPrice: "/month.",
    },
    {
      beforeMonth: "Rental statistics for Manhattan: ",
      beforePrice: ". One-bedroom mean in the Corcoran sample: $",
      afterPrice: " per month.",
    },
  ][i],
}));
export function makeMail(keys, id, options = {}) {
  const profile = profiles.find((p) => p.id === id);
  const month = options.month ?? "2026-08";
  const amount = options.amount ?? "5,408.00";
  const t = options.timestamp ?? START;
  const line =
    profile.template.beforeMonth +
    month +
    profile.template.beforePrice +
    amount +
    profile.template.afterPrice;
  let body =
    options.body ??
    `SYNTHETIC TEST EMAIL — NOT A REAL NEWSLETTER\r\n\r\n${line}\r\n\r\nTest source: ${id}.rent.test. Values are demonstration inputs.\r\n`;
  let typ = options.contentType ?? "text/plain; charset=utf-8";
  let encoding = options.encoding ?? "8bit";
  if (options.html) {
    body = `<html><body><p>SYNTHETIC TEST EMAIL</p><p>${line}</p><p>Test data only.</p></body></html>\r\n`;
    typ = "text/html; charset=utf-8";
  }
  if (encoding === "base64")
    body =
      Buffer.from(body, "utf8")
        .toString("base64")
        .match(/.{1,64}/g)
        .join("\r\n") + "\r\n";
  else if (encoding === "quoted-printable")
    body = Buffer.from(body, "utf8")
      .toString("latin1")
      .replace(
        /[^\x20-\x3c\x3e-\x7e\r\n]/g,
        (c) =>
          "=" + c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase(),
      )
      .replace(/=/g, (s, o, str) =>
        /^=[0-9A-F]{2}/.test(str.slice(o)) ? "=" : "=3D",
      );
  else body = Buffer.from(body, "utf8").toString("latin1");
  const fields = [
    ["From", options.from ?? profile.from],
    ["To", "subscriber@example.invalid"],
    ["Subject", `Synthetic ${id} rental bulletin — ${month}`],
    ["Date", new Date(t * 1000).toUTCString()],
    ["MIME-Version", "1.0"],
    ["Content-Type", typ],
    ["Content-Transfer-Encoding", encoding],
    [
      "Message-ID",
      `<test-${id}-${month}-${amount.replace(/\W/g, "")}@${profile.domain}>`,
    ],
  ];
  const h = fields.map(([name]) => name.toLowerCase()).join(":");
  // body uses octets; do not UTF-8 encode the latin1 representation a second time.
  const actualBh = sha(Buffer.from(canonicalBody(body), "latin1")).toString(
    "base64",
  );
  const dkim = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${profile.domain}; s=rent; t=${t}; h=${h}; bh=${actualBh};${options.extraTags ?? ""} b=`;
  const canonical =
    fields
      .map(
        ([name, val]) =>
          canonicalHeader(name, Buffer.from(val, "utf8").toString("latin1")) +
          "\r\n",
      )
      .join("") + canonicalHeader("DKIM-Signature", dkim);
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(canonical, "latin1"),
    keys["mail" + id],
  ).toString("base64");
  return (
    fields
      .map(
        ([name, val]) =>
          name + ": " + Buffer.from(val, "utf8").toString("latin1") + "\r\n",
      )
      .join("") +
    "DKIM-Signature: " +
    dkim +
    signature +
    "\r\n\r\n" +
    body
  );
}
export async function generate() {
  const keys = await getKeys();
  await mkdir("web/fixtures", { recursive: true });
  const manifest = {
    warning: "TEST ROOT AND SYNTHETIC PUBLISHERS. NOT REAL NEWSLETTER EMAILS.",
    start: START,
    rootDS: "0x" + ds(".", keys.root).toString("hex"),
    profiles,
  };
  for (const p of profiles) {
    const mail = makeMail(keys, p.id, {
      html: p.id === "beta",
      encoding: p.id === "gamma" ? "base64" : "8bit",
    });
    const prepared = prepareEmail(mail);
    const keyProof = proof(keys, p.id);
    await writeFile(`web/fixtures/${p.id}.eml`, Buffer.from(mail, "latin1"));
    await writeFile(
      `web/fixtures/${p.id}-proof.json`,
      JSON.stringify(keyProof, null, 2),
    );
    await writeFile(
      `.local/${p.id}-envelope.json`,
      JSON.stringify({ ...prepared.envelope, keyProof }),
    );
    for (const [month, timestamp] of [
      ["2026-08", START],
      ["2026-09", Date.parse("2026-10-10T12:00:00Z") / 1000],
      ["2026-10", Date.parse("2026-11-10T12:00:00Z") / 1000],
    ]) {
      const dir = `web/fixtures/${month.replace("-", "")}`;
      await mkdir(dir, { recursive: true });
      await writeFile(
        `${dir}/${p.id}.eml`,
        Buffer.from(
          makeMail(keys, p.id, {
            month,
            timestamp,
            html: p.id === "beta",
            encoding: p.id === "gamma" ? "base64" : "8bit",
          }),
          "latin1",
        ),
      );
    }
  }
  await writeFile(".local/fixtures.json", JSON.stringify(manifest, null, 2));
  console.log(
    "Generated three RSA-signed synthetic emails and full DNSSEC proof chains under a TEST root.",
  );
  return manifest;
}
if (import.meta.url === `file://${process.argv[1]}`) await generate();
