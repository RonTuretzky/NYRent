// The browser prepares DKIM's signed representation; the contract verifies every byte.
// No price is extracted or trusted in this module.
const ascii = (bytes) => {
  let text = "";
  for (let p = 0; p < bytes.length; p += 8192)
    text += String.fromCharCode(...bytes.subarray(p, p + 8192));
  return text;
};
export const hex = (s) =>
  "0x" +
  Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
export function canonicalBody(body) {
  const lines = body
    .split("\r\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""));
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}
export function canonicalHeader(name, value) {
  return (
    name.toLowerCase() +
    ":" +
    value
      .replace(/\r\n[ \t]+/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/^[ \t]+|[ \t]+$/g, "")
  );
}
export function parseHeaders(raw) {
  const lines = raw.split("\r\n");
  const headers = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!headers.length) throw Error("Unexpected header continuation");
      headers.at(-1).value += "\r\n" + line;
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) throw Error("Malformed email header");
    const name = line.slice(0, i);
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name))
      throw Error("Malformed header name");
    headers.push({ name: name.toLowerCase(), value: line.slice(i + 1) });
  }
  return headers;
}
export function tags(value) {
  const result = {};
  for (const part of value.replace(/\r\n[ \t]+/g, " ").split(";")) {
    if (!part.trim()) continue;
    const i = part.indexOf("=");
    if (i < 1) throw Error("Malformed DKIM tag");
    const k = part.slice(0, i).trim();
    if (Object.hasOwn(result, k)) throw Error("Duplicate DKIM tag: " + k);
    result[k] = part.slice(i + 1).trim();
  }
  return result;
}
export function prepareEmail(input, signatureIndex = 0) {
  let raw = typeof input === "string" ? input : ascii(new Uint8Array(input));
  if (raw.length > 100000) throw Error("Email exceeds the 100 KB input limit");
  if (!raw.includes("\r\n")) raw = raw.replace(/\n/g, "\r\n");
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0)
    throw Error("An original .eml message with headers and body is required");
  const all = parseHeaders(raw.slice(0, split));
  const signatures = all.filter((h) => h.name === "dkim-signature");
  if (!signatures[signatureIndex])
    throw Error(
      "No DKIM signature found. A newsletter web page cannot substitute for the original email.",
    );
  const selected = signatures[signatureIndex];
  const dkim = tags(selected.value);
  if (dkim.a !== "rsa-sha256" || dkim.c !== "relaxed/relaxed")
    throw Error("Supported DKIM profile: rsa-sha256 and relaxed/relaxed");
  if ("l" in dkim) throw Error("Partial body signatures (l=) are rejected");
  if (!dkim.t || !dkim.d || !dkim.s || !dkim.h || !dkim.b)
    throw Error("Incomplete DKIM signature");
  const used = new Set();
  const fields = [];
  for (const h of dkim.h.split(":")) {
    const name = h.trim().toLowerCase();
    const index = all.findLastIndex(
      (field, i) => field.name === name && !used.has(i),
    );
    if (index >= 0) {
      used.add(index);
      fields.push(all[index]);
    }
  }
  const blank = selected.value.replace(
    /(^|;)([ \t\r\n]*b[ \t]*=)[^;]*/,
    "$1$2",
  );
  const signedHeaders =
    fields.map((h) => canonicalHeader(h.name, h.value) + "\r\n").join("") +
    canonicalHeader("dkim-signature", blank);
  const body = canonicalBody(raw.slice(split + 4));
  if (body.length > 65536 || signedHeaders.length > 16384)
    throw Error(
      "The signed body or headers exceed contract bounds (64 KiB / 16 KiB)",
    );
  const b64 = dkim.b.replace(/[ \t\r\n]/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64))
    throw Error("Malformed DKIM signature");
  const sig = atob(b64);
  const values = Object.fromEntries(
    fields.map((h) => [
      h.name,
      canonicalHeader(h.name, h.value).slice(h.name.length + 1),
    ]),
  );
  return {
    envelope: {
      headers: hex(signedHeaders),
      body: hex(body),
      signature: hex(sig),
    },
    identity: {
      domain: dkim.d,
      selector: dkim.s,
      from: values.from,
      listId: values["list-id"] ?? "",
      signedAt: Number(dkim.t),
    },
    signatureCount: signatures.length,
    bodyBytes: body.length,
    signedHeaders: fields.map((h) => h.name),
  };
}
