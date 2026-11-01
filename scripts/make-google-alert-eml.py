#!/usr/bin/env python3
"""Write one complete Google-Alert-shaped .eml signed with fixtures/testkey.

    python3 scripts/make-google-alert-eml.py --out /tmp/alert.eml \
        --slug east-harlem-new-york-ny --name "East Harlem" --dollars 3,010 \
        --month 2026-11 --t 1793620800 [--sentence-month 2026-12] [--bedroom]

Only the browser e2e suite uses this: the real Google key cannot sign a future
month, so a fork deploys an oracle pinned to the test key (DeployApartmentsFork)
and records this file. The recipient is a placeholder, never a real mailbox.
Builds on the same helpers as make-google-alert-fixtures.py, so the signed
bytes match what the Foundry fixtures exercise.
"""
from __future__ import annotations

import argparse, base64, calendar, importlib.util, pathlib

from cryptography.hazmat.primitives import serialization

_HERE = pathlib.Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("make_google_alert_fixtures", _HERE / "make-google-alert-fixtures.py")
assert _spec and _spec.loader
fx = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fx)
BOUNDARY, FROM, ROOT, apt_url, build_body, sentence, signed, widget = (
    fx.BOUNDARY, fx.FROM, fx.ROOT, fx.apt_url, fx.build_body, fx.sentence, fx.signed, fx.widget)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--slug", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--dollars", required=True, help="e.g. 3,010")
    ap.add_argument("--month", required=True, help="YYYY-MM the alert is for")
    ap.add_argument("--t", required=True, type=int, help="DKIM signing time (unix seconds)")
    ap.add_argument("--sentence-month", help="YYYY-MM named in the sentence, if different")
    ap.add_argument("--bedroom", action="store_true", help="use a non-qualifying 'Average Rent by Bedroom' snippet")
    ap.add_argument("--dump-canon", help="also write <prefix>.head/.body/.sig for byte-level checks")
    a = ap.parse_args()

    y, m = (a.sentence_month or a.month).split("-")
    month_name = calendar.month_name[int(m)]
    if a.bedroom:
        w = widget("t", f"Average Rent by Bedroom in {a.name}. Studio ${a.dollars}", apt_url(a.slug))
    else:
        w = widget(f"Rental Market Trends in {a.name} - Apartments.com", sentence(month_name, int(y), a.name, a.dollars), apt_url(a.slug))
    body = build_body([w])
    key = serialization.load_pem_private_key((ROOT / "fixtures/testkey/test-only-private-key.pem").read_bytes(), password=None)
    head, canon, sig = signed(body, a.t, key)
    if a.dump_canon:
        pathlib.Path(a.dump_canon + ".head").write_bytes(head)
        pathlib.Path(a.dump_canon + ".body").write_bytes(canon)
        pathlib.Path(a.dump_canon + ".sig").write_bytes(sig)

    # `signed` returns the relaxed-canonical header block ending in the dkim line
    # with b= emptied. Re-emit it as ordinary headers (same values, so relaxed
    # canonicalization in the browser reproduces the exact signed bytes).
    lines = head.decode("latin1").split("\r\n")
    out = []
    for line in lines:
        name, value = line.split(":", 1)
        pretty = "-".join(p.capitalize() for p in name.split("-")) if name != "dkim-signature" else "DKIM-Signature"
        if name == "dkim-signature":
            value = value + base64.b64encode(sig).decode()
        out.append(f"{pretty}: {value}")
    raw = ("\r\n".join(out) + "\r\n\r\n").encode("latin1") + body
    pathlib.Path(a.out).write_bytes(raw)
    print(a.out, len(raw), "bytes; from", FROM, "boundary", BOUNDARY)


if __name__ == "__main__":
    main()
