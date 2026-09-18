#!/usr/bin/env python3
"""Generate the TEST-ONLY RSA keypair and the synthetic DKIM fixtures.

    python3 scripts/make-synthetic-fixtures.py

Outputs
-------
fixtures/testkey/
    test-only-private-key.pem   RSA-2048 private key. TEST ONLY — generated for
                                signing synthetic fixtures, deliberately committed.
    test-only-public-key.pem    Matching public key.
    meta.json                   {"modulus_hex": "0x…", "exponent": 65537}
    README.md                   The warning label.
fixtures/synthetic/<case>/
    canon-body.bin              Relaxed-canonical body (QP-encoded HTML, CRLF).
    signed-headers.bin          Canonical signed header block, b= emptied (or
                                deliberately violated), no trailing CRLF.
    sig.bin                     RSA-2048 PKCS#1 v1.5 / SHA-256 signature over
                                signed-headers.bin (possibly tampered).
fixtures/synthetic/manifest.json

Every case is verified in-process BEFORE writing, the same way the reference
fixture was verified locally:
  * bh (sha256 of the body) matches the bh= tag — or mismatches for tamper cases;
  * the RSA signature verifies over the signed-header block — or fails for
    tampered-sig;
  * a python port of the on-chain state machine (QP decode + anchor count + value
    grammar) produces the expected cents/anchors;
  * a python simulation of CredailyRentOracle.submitObservation produces exactly
    the expected outcome ("ok" or a named custom error).
The script also re-verifies the REAL fixture (fixtures/credaily-2026-09-17/) with
the same code path, so the port is grounded against ground truth.
"""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import re
import shutil
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.exceptions import InvalidSignature

ROOT = pathlib.Path(__file__).resolve().parent.parent
REAL_DIR = ROOT / "fixtures" / "credaily-2026-09-17"
TESTKEY_DIR = ROOT / "fixtures" / "testkey"
SYN_DIR = ROOT / "fixtures" / "synthetic"

DOMAIN = "newyork.credaily.com"
SELECTOR = "b37"
FROM_NEEDLE = b"<mail@newyork.credaily.com>"

# Tests warp to this timestamp (the real email's t=) before submitting.
TEST_NOW = 1789642464
DEFAULT_T = TEST_NOW - 3600

ANCHOR = b"Manhattan Office Rent"
LABEL = b"Avg Effective"
SUFFIX = b"/ SF"
WINDOW = 600

# ─────────────────────────────────────────────────────────────────────────────
# Python port of Dkim.extractSnapshot (must match src/lib/Dkim.sol exactly)
# ─────────────────────────────────────────────────────────────────────────────


class ValueOverflow(Exception):
    pass


def qp_decode_stream(body: bytes):
    """Yields decoded bytes exactly like the on-chain QP machine."""
    i, n = 0, len(body)
    while i < n:
        b = body[i]
        if b == 0x3D:  # '='
            if i + 2 < n and body[i + 1] == 0x0D and body[i + 2] == 0x0A:
                i += 3  # soft break
                continue
            if i + 2 < n:
                pair = body[i + 1 : i + 3]
                try:
                    yield int(pair.decode("ascii"), 16)
                    i += 3
                    continue
                except (ValueError, UnicodeDecodeError):
                    pass
            yield 0x3D  # literal '='
            i += 1
        else:
            yield b
            i += 1


def extract_snapshot(body: bytes) -> tuple[int, int]:
    """(cents, anchorCount) — mirror of Dkim.extractSnapshot."""
    aj = 0
    anchor_count = 0
    # value machine
    ST_WAIT, ST_LABEL, ST_DOLLARSIGN, ST_SP1, ST_DOLLARS, ST_C1, ST_C2, ST_SP2, ST_SUF, ST_DONE, ST_FAIL = range(11)
    stage, budget, lj, dollars, cents = ST_WAIT, 0, 0, 0, 0

    for b in qp_decode_stream(body):
        # anchor counter (always on)
        anchor_completed = False
        if b == ANCHOR[aj]:
            aj += 1
            if aj == len(ANCHOR):
                anchor_count += 1
                aj = 0
                if stage == ST_WAIT:
                    stage, budget, lj = ST_LABEL, WINDOW, 0
                    continue  # anchor's last byte feeds nothing else
        else:
            aj = 1 if b == ANCHOR[0] else 0

        if stage in (ST_WAIT, ST_DONE, ST_FAIL):
            continue
        if budget == 0:
            stage = ST_FAIL
            cents = 0
            continue
        budget -= 1

        if stage == ST_LABEL:
            if b == LABEL[lj]:
                lj += 1
                if lj == len(LABEL):
                    stage, budget = ST_DOLLARSIGN, WINDOW
            else:
                lj = 1 if b == LABEL[0] else 0
        elif stage == ST_DOLLARSIGN:
            if b == ord("$"):
                stage, budget = ST_SP1, WINDOW
        elif stage == ST_SP1:
            if b == ord(" "):
                continue
            if ord("0") <= b <= ord("9"):
                dollars = b - 0x30
                stage = ST_DOLLARS
            else:
                stage = ST_FAIL
        elif stage == ST_DOLLARS:
            if ord("0") <= b <= ord("9"):
                dollars = dollars * 10 + (b - 0x30)
                if dollars > 21_474_835:
                    raise ValueOverflow()
            elif b == ord("."):
                stage = ST_C1
            else:
                stage = ST_FAIL
        elif stage == ST_C1:
            if ord("0") <= b <= ord("9"):
                cents = dollars * 100 + (b - 0x30) * 10
                stage = ST_C2
            else:
                stage = ST_FAIL
        elif stage == ST_C2:
            if ord("0") <= b <= ord("9"):
                cents += b - 0x30
                stage = ST_SP2
            else:
                stage = ST_FAIL
        elif stage == ST_SP2:
            if b == ord(" "):
                continue
            if b == SUFFIX[0]:
                lj, stage = 1, ST_SUF
            else:
                stage = ST_FAIL
        elif stage == ST_SUF:
            if b == SUFFIX[lj]:
                lj += 1
                if lj == len(SUFFIX):
                    stage = ST_DONE
            else:
                stage = ST_FAIL
        if stage == ST_FAIL:
            cents = 0

    return (cents if stage == ST_DONE else 0, anchor_count)


# ─────────────────────────────────────────────────────────────────────────────
# Python simulation of CredailyRentOracle.submitObservation
# ─────────────────────────────────────────────────────────────────────────────


def parse_dkim_tags(line: bytes) -> dict:
    """Mirror of Dkim.parseDkimTags; raises on the same conditions."""
    prefix = b"dkim-signature:"
    if not line.startswith(prefix):
        raise AssertionError("MalformedTag")
    tags: dict = {"t": 0, "hasL": False, "bEmpty": False}
    seen: set = set()
    for segment in line[len(prefix) :].split(b";"):
        seg = segment.strip(b" \t")
        if not seg:
            continue
        if b"=" not in seg:
            raise AssertionError("MalformedTag")
        name, value = seg.split(b"=", 1)
        name = name.rstrip(b" \t")
        value = value.lstrip(b" \t")
        key = name.decode("ascii", "replace")
        if key in ("v", "a", "c", "d", "s", "t", "bh", "l", "b"):
            if key in seen:
                raise AssertionError(f'DuplicateTag("{key}")')
            seen.add(key)
            if key == "t":
                if not value or not value.isdigit() or int(value) > 2**64 - 1:
                    raise AssertionError("BadTimestampTag")
                tags["t"] = int(value)
            elif key == "l":
                tags["hasL"] = True
            elif key == "b":
                tags["bEmpty"] = len(value) == 0
            elif key == "bh":
                tags["bhB64"] = value.decode("ascii", "replace")
            else:
                tags[key] = value.decode("ascii", "replace")
    return tags


def simulate_submit(headers: bytes, body: bytes, sig: bytes, public_key, now: int = TEST_NOW) -> str:
    """Returns 'ok' or the custom-error name submitObservation would revert with."""
    bh32 = hashlib.sha256(body).digest()

    # 2. header-block policy
    lines = headers.split(b"\r\n")
    if not any(ln.startswith(b"from:") and FROM_NEEDLE in ln for ln in lines):
        return "MissingFrom"
    trailing = lines[-1]
    if not trailing.startswith(b"dkim-signature:"):
        return "MissingDkimLine"
    try:
        tags = parse_dkim_tags(trailing)
    except AssertionError as exc:
        return str(exc)
    if tags.get("v") != "1":
        return 'BadTagPolicy("v")'
    if tags.get("a") != "rsa-sha256":
        return 'BadTagPolicy("a")'
    if tags.get("c") != "relaxed/relaxed":
        return 'BadTagPolicy("c")'
    if tags.get("d") != DOMAIN:
        return 'BadTagPolicy("d")'
    if tags.get("s") != SELECTOR:
        return 'BadTagPolicy("s")'
    if tags["hasL"]:
        return 'BadTagPolicy("l")'
    if not tags["bEmpty"]:
        return 'BadTagPolicy("b")'
    if tags.get("bhB64") != base64.b64encode(bh32).decode():
        return "BadBodyHash"
    if tags["t"] == 0 or tags["t"] > now + 86400:
        return "BadTimestamp"

    # 3. RSA
    try:
        public_key.verify(sig, headers, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        return "BadSignature"

    # 4. extraction
    try:
        cents, anchors = extract_snapshot(body)
    except ValueOverflow:
        return "ValueOverflow"
    if anchors != 1:
        return f"AnchorNotUnique({anchors})"
    if cents == 0:
        return "SnapshotNotFound"
    return "ok"


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic body / header construction
# ─────────────────────────────────────────────────────────────────────────────


def qp_wrap(raw: bytes, width: int = 75) -> bytes:
    """Splits a QP payload into lines of ≤ `width` chars joined by soft breaks
    (`=\\r\\n`), never splitting an =HH escape, final line terminated by CRLF."""
    lines = []
    i = 0
    while i < len(raw):
        end = min(i + width, len(raw))
        # don't split an escape sequence
        if end < len(raw):
            for back in (1, 2):
                if raw[end - back : end - back + 1] == b"=":
                    end -= back
                    break
        lines.append(raw[i:end])
        i = end
    return b"=\r\n".join(lines) + b"\r\n"


def snapshot_html(
    value: str = "92.88",
    anchor: bytes = ANCHOR,
    label: bytes = LABEL,
    suffix: bytes = b"/ SF",
    pre_label_filler: bytes = b"",
    money: bytes | None = None,
) -> bytes:
    """The QP payload (pre-wrap) for the snapshot table, mirroring the real email's
    decoded shape: anchor … label … $value / SF, with =3D escapes like real QP HTML."""
    if money is None:
        money = b" $" + value.encode() + b" " + suffix + b" "
    return (
        b'<table width=3D"100%"><tbody><tr><td style=3D"font-size:13px;color:#111827;font-weight:600;"> '
        + anchor
        + b' <div style=3D"margin-top:2px;color:#6b7280;font-weight:400;">'
        + pre_label_filler
        + b" "
        + label
        + b' </div></td><td style=3D"text-align:right;font-size:13px;font-weight:600;">'
        + money
        + b"</td></tr></tbody></table>"
    )


def make_body(payload_middle: bytes, wrap_middle: bool = True) -> bytes:
    """Full canonical body: filler + snapshot html + filler, QP-wrapped, CRLF.

    With ``wrap_middle=False`` the middle is emitted verbatim on its own line(s) —
    used when the payload already contains hand-placed soft breaks that qp_wrap
    must not cut through."""
    head = b'<html><body style=3D"margin:0;padding:0;background:#f9fafb;"><p>Market Snapshot =E2=80=94 weekly metrics courtesy of CompStak.</p>'
    tail = b'<p style=3D"color:#6b7280;">You are receiving this synthetic TEST fixture; it never came from CRE Daily.</p></body></html>'
    if wrap_middle:
        return qp_wrap(head + payload_middle + tail)
    return qp_wrap(head) + payload_middle + b"\r\n" + qp_wrap(tail)


def make_headers(
    bh_b64: str,
    d: str = DOMAIN,
    s: str = SELECTOR,
    t: int | None = DEFAULT_T,
    v: str = "1",
    a: str = "rsa-sha256",
    c: str = "relaxed/relaxed",
    include_from: bool = True,
    include_l: bool = False,
    b_value: str = "",
    duplicate_d: bool = False,
) -> bytes:
    """Relaxed-canonical signed header block terminated by the dkim-signature line
    (no trailing CRLF), shaped like the verified reference block."""
    lines = []
    if include_from:
        lines.append(b"from:CRE Daily New York <mail@newyork.credaily.com>")
    lines.append(b"to:test-recipient@example.com")
    lines.append(b"subject:Synthetic Market Snapshot (TEST ONLY)")
    lines.append(b"mime-version:1.0")
    tags = [f"v={v}", f"a={a}", f"c={c}", f"d={d}", "h=from:to:subject:mime-version"]
    if duplicate_d:
        tags.append(f"d={d}")
    tags += [f"s={s}"]
    if t is not None:
        tags.append(f"t={t}")
    if include_l:
        tags.append("l=1000")
    tags += [f"bh={bh_b64}", f"b={b_value}"]
    lines.append(("dkim-signature:" + "; ".join(tags)).encode())
    return b"\r\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# Case definitions
# ─────────────────────────────────────────────────────────────────────────────


def build_cases(sign) -> list[dict]:
    """Each case: name, description, expect ('ok' or error), cents, anchors, t,
    headers, body, sig."""
    cases: list[dict] = []

    def case(name, description, expect, body, cents=0, anchors=1, sign_headers=None, **hdr_kwargs):
        bh_b64 = base64.b64encode(hashlib.sha256(body).digest()).decode()
        headers = make_headers(bh_b64, **hdr_kwargs)
        sig = sign(sign_headers if sign_headers is not None else headers)
        entry = {
            "name": name,
            "description": description,
            "expect": expect,
            "cents": cents,
            "anchors": anchors,
            "t": hdr_kwargs.get("t", DEFAULT_T) or 0,
            "headers": headers,
            "body": body,
            "sig": sig,
        }
        cases.append(entry)
        return entry

    plain = make_body(snapshot_html())

    # ── positive branches ────────────────────────────────────────────────────
    case("ok-basic", "well-formed synthetic snapshot, $92.88", "ok", plain, cents=9288)
    case("ok-value-100-00", "round hundred: $100.00", "ok", make_body(snapshot_html("100.00")), cents=10000)
    case("ok-value-9-99", "single-digit dollars: $9.99", "ok", make_body(snapshot_html("9.99")), cents=999)
    case(
        "ok-value-1234-56", "four-digit dollars: $1234.56", "ok", make_body(snapshot_html("1234.56")), cents=123456
    )
    # decoder workout: '$' as =24, '/' as =2F, digits split by a hand-placed soft
    # break; wrap_middle=False so qp_wrap cannot cut through the manual escapes
    qp_money = b" =2492.=\r\n88 =2F SF "
    case(
        "ok-qp-escaped-value",
        "value written with QP escapes and a soft break inside the number",
        "ok",
        make_body(snapshot_html(money=qp_money), wrap_middle=False),
        cents=9288,
    )

    # ── header / tag policy branches ─────────────────────────────────────────
    case("wrong-domain", "d= is not the pinned domain", 'BadTagPolicy("d")', plain, d="evil.example.com")
    case("wrong-selector", "s= is not the pinned selector", 'BadTagPolicy("s")', plain, s="zzz")
    case("wrong-version", "v=2", 'BadTagPolicy("v")', plain, v="2")
    case("wrong-algo", "a=rsa-sha1", 'BadTagPolicy("a")', plain, a="rsa-sha1")
    case("wrong-canon", "c=simple/simple", 'BadTagPolicy("c")', plain, c="simple/simple")
    case("has-l-tag", "l= body-length tag present", 'BadTagPolicy("l")', plain, include_l=True)
    case("nonempty-b", "b= tag not emptied", 'BadTagPolicy("b")', plain, b_value="Zm9vYmFy")
    case("missing-from", "no from: line in the signed block", "MissingFrom", plain, include_from=False)
    case("future-t", "t= more than 1 day in the future", "BadTimestamp", plain, t=TEST_NOW + 86400 + 3600)
    case("missing-t", "no t= tag", "BadTimestamp", plain, t=None)
    case("duplicate-d-tag", "d= appears twice", 'DuplicateTag("d")', plain, duplicate_d=True)

    # trailing CRLF after the dkim line (violates 'no trailing CRLF')
    body = plain
    bh_b64 = base64.b64encode(hashlib.sha256(body).digest()).decode()
    hdrs = make_headers(bh_b64) + b"\r\n"
    cases.append(
        {
            "name": "trailing-crlf",
            "description": "signed block ends with CRLF, so the trailing line is empty",
            "expect": "MissingDkimLine",
            "cents": 0,
            "anchors": 1,
            "t": DEFAULT_T,
            "headers": hdrs,
            "body": body,
            "sig": sign(hdrs),
        }
    )

    # ── crypto branches ──────────────────────────────────────────────────────
    ok_bh = base64.b64encode(hashlib.sha256(plain).digest()).decode()
    ok_headers = make_headers(ok_bh)
    # headers carry the ORIGINAL body's bh; the shipped body has one byte flipped
    tampered_body = bytearray(plain)
    tampered_body[len(tampered_body) // 2] ^= 0x01
    cases.append(
        {
            "name": "tampered-body",
            "description": "one body byte flipped after signing (bh mismatch)",
            "expect": "BadBodyHash",
            "cents": 0,
            "anchors": 1,
            "t": DEFAULT_T,
            "headers": ok_headers,
            "body": bytes(tampered_body),
            "sig": sign(ok_headers),
        }
    )
    bad_sig = bytearray(sign(ok_headers))
    bad_sig[0] ^= 0x01
    cases.append(
        {
            "name": "tampered-sig",
            "description": "one signature byte flipped",
            "expect": "BadSignature",
            "cents": 0,
            "anchors": 1,
            "t": DEFAULT_T,
            "headers": ok_headers,
            "body": plain,
            "sig": bytes(bad_sig),
        }
    )
    # headers byte flipped after signing (RSA fails before extraction)
    flipped_headers = bytearray(ok_headers)
    idx = flipped_headers.index(b"Synthetic"[0], flipped_headers.find(b"subject:"))
    flipped_headers[idx] ^= 0x20
    cases.append(
        {
            "name": "tampered-headers",
            "description": "one signed-header byte flipped after signing",
            "expect": "BadSignature",
            "cents": 0,
            "anchors": 1,
            "t": DEFAULT_T,
            "headers": bytes(flipped_headers),
            "body": plain,
            "sig": sign(ok_headers),
        }
    )

    # ── extraction branches ──────────────────────────────────────────────────
    two_anchors = make_body(snapshot_html() + b"<p>Later the phrase Manhattan Office Rent appears again.</p>")
    case("duplicate-anchor", "anchor occurs twice in the body", "AnchorNotUnique(2)", two_anchors, anchors=2)
    case("zero-value", "$0.00 extracts to zero cents", "SnapshotNotFound", make_body(snapshot_html("0.00")))
    case(
        "value-overflow",
        "dollar digits push cents past 2^31",
        "ValueOverflow",
        make_body(snapshot_html("99999999999999.00")),
    )
    case(
        "no-label",
        "anchor present but 'Avg Effective' never appears",
        "SnapshotNotFound",
        make_body(snapshot_html(label=b"Median Asking")),
    )
    case(
        "label-too-far",
        "'Avg Effective' more than 600 decoded bytes after the anchor",
        "SnapshotNotFound",
        make_body(snapshot_html(pre_label_filler=b"x" * 700)),
    )
    case(
        "bad-suffix",
        "value not followed by '/ SF'",
        "SnapshotNotFound",
        make_body(snapshot_html(suffix=b"/ SM")),
    )

    return cases


# ─────────────────────────────────────────────────────────────────────────────
# main
# ─────────────────────────────────────────────────────────────────────────────


def verify_real_fixture() -> None:
    """Ground the python port against the locally verified reference fixture."""
    body = (REAL_DIR / "canon-body.bin").read_bytes()
    headers = (REAL_DIR / "signed-headers.bin").read_bytes()
    sig = (REAL_DIR / "sig.bin").read_bytes()
    meta = json.loads((REAL_DIR / "meta.json").read_text())
    n = int(meta["modulus_hex"], 16)
    real_pub = rsa.RSAPublicNumbers(meta["exponent"], n).public_key()
    outcome = simulate_submit(headers, body, sig, real_pub, now=int(meta["t"]))
    assert outcome == "ok", f"real fixture simulation failed: {outcome}"
    cents, anchors = extract_snapshot(body)
    assert (cents, anchors) == (9288, 1), (cents, anchors)
    assert hashlib.sha256(body).digest() == base64.b64decode(meta["bh_b64"])
    print("real fixture re-verified: ok (9288 cents, 1 anchor, RSA pass)")


def main() -> None:
    verify_real_fixture()

    # fresh TEST-ONLY keypair
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pub = key.public_key()
    modulus = pub.public_numbers().n.to_bytes(256, "big")

    def sign(data: bytes) -> bytes:
        return key.sign(data, padding.PKCS1v15(), hashes.SHA256())

    cases = build_cases(sign)

    # internal verification of every case before anything is written
    for c in cases:
        got = simulate_submit(c["headers"], c["body"], c["sig"], pub)
        assert got == c["expect"], f'{c["name"]}: simulated {got}, expected {c["expect"]}'
        if c["expect"] == "ok":
            cents, anchors = extract_snapshot(c["body"])
            assert (cents, anchors) == (c["cents"], c["anchors"]), (c["name"], cents, anchors)
    names = [c["name"] for c in cases]
    assert len(names) == len(set(names)), "duplicate case names"
    print(f"verified {len(cases)} synthetic cases in-process")

    # write testkey
    if TESTKEY_DIR.exists():
        shutil.rmtree(TESTKEY_DIR)
    TESTKEY_DIR.mkdir(parents=True)
    (TESTKEY_DIR / "test-only-private-key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    (TESTKEY_DIR / "test-only-public-key.pem").write_bytes(
        pub.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    )
    (TESTKEY_DIR / "meta.json").write_text(
        json.dumps({"modulus_hex": "0x" + modulus.hex(), "exponent": 65537}, indent=1) + "\n"
    )
    (TESTKEY_DIR / "README.md").write_text(
        "# TEST-ONLY RSA keypair\n\n"
        "Generated by `scripts/make-synthetic-fixtures.py` purely to sign the synthetic\n"
        "DKIM fixtures in `fixtures/synthetic/`. **The private key is deliberately\n"
        "committed** (SPEC §7) so the Foundry tests need no ffi. It protects nothing,\n"
        "must protect nothing, and must never be reused anywhere else.\n"
    )

    # write cases + manifest
    if SYN_DIR.exists():
        shutil.rmtree(SYN_DIR)
    SYN_DIR.mkdir(parents=True)
    manifest = {"testNow": TEST_NOW, "defaultT": DEFAULT_T, "cases": []}
    for c in cases:
        d = SYN_DIR / c["name"]
        d.mkdir()
        (d / "canon-body.bin").write_bytes(c["body"])
        (d / "signed-headers.bin").write_bytes(c["headers"])
        (d / "sig.bin").write_bytes(c["sig"])
        manifest["cases"].append(
            {
                "name": c["name"],
                "description": c["description"],
                "expect": c["expect"],
                "cents": c["cents"],
                "anchors": c["anchors"],
                "t": c["t"],
            }
        )
    (SYN_DIR / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"wrote {TESTKEY_DIR} and {len(cases)} cases under {SYN_DIR}")


if __name__ == "__main__":
    sys.exit(main())
