#!/usr/bin/env python3
"""Generate Google Alert fixtures for test/apartments.

    python3 scripts/make-google-alert-fixtures.py            # synthetic only
    python3 scripts/make-google-alert-fixtures.py DIR ...    # also real .eml archives

fixtures/google-alert-synthetic/<case>/  committed, signed with fixtures/testkey.
fixtures/private/google-alerts/<n>/      gitignored: real originals hold the mailbox
                                         address and delivery tokens. Never commit.

The expected results in the private manifest come from json.loads plus a regex, an
independent reading of each email, so the forge test is a differential check of the
Solidity parser. Each real signature is verified here against Google's DNS key.
"""
from __future__ import annotations

import base64, calendar, email, glob, hashlib, json, os, pathlib, quopri, re, shutil, sys
from email import policy
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

ROOT = pathlib.Path(__file__).resolve().parent.parent
SYN = ROOT / "fixtures" / "google-alert-synthetic"
PRIV = ROOT / "fixtures" / "private" / "google-alerts"
FROM = "Google Alerts <googlealerts-noreply@google.com>"
BOUNDARY = "000000000000a9a270065d52604d"
MONTHS = list(calendar.month_name)
NOV_T = 1793620800  # 2026-11-02 12:00 UTC


def body_canon(raw: bytes) -> bytes:
    lines = raw.replace(b"\r\n", b"\n").split(b"\n")
    out = [re.sub(rb"[ \t]+", b" ", l).rstrip(b" \t") for l in lines]
    while out and out[-1] == b"":
        out.pop()
    return b"\r\n".join(out) + b"\r\n" if out else b""


def header_canon(name: str, value: str) -> str:
    v = re.sub(r"[ \t]+", " ", re.sub(r"\r?\n", "", value)).strip(" \t")
    return f"{name.lower()}:{v}"


def qp(text: str) -> bytes:
    return quopri.encodestring(text.encode(), quotetabs=False).replace(b"\n", b"\r\n")


def widget(title, description, url, extra=""):
    def esc(s):
        return s.replace("\\", "\\\\").replace('"', '\\"') if "\\u0026" not in s else s
    return (
        '{\n      "type": "LINK",\n      "title": "%s",\n      "description": "%s",%s\n      "url": "%s"\n    }'
        % (esc(title), esc(description), extra, url)
    )


def apt_url(slug, host="www.apartments.com", path="rent-market-trends"):
    return (
        f"https://www.google.com/url?rct=j\\u0026sa=t\\u0026url=https://{host}/{path}/{slug}/"
        "\\u0026ct=ga\\u0026cd=SYNTHETIC\\u0026usg=SYNTHETIC"
    )


def sentence(month, year, name, dollars, tail=" When you rent an apartment you can expect to pay ..."):
    return f"As of {month} {year}, the average rent in {name} was ${dollars}/mo..{tail}"


def build_body(widgets, query="rent", plain=None, raw_json=None):
    title = "Google Alert - " + query.replace("\\", "\\\\").replace('"', '\\"')
    js = raw_json or (
        '{\n  "api_version": "1.0",\n  "entity": {\n    "title": "%s"\n  },\n  "cards": [ {\n'
        '    "title": "%s",\n    "widgets": [ %s ]\n  } ]\n}' % (title, title, ", ".join(widgets))
    )
    html = (
        '<html> <head> </head> <body> <div>  <script data-scope="inboxmarkup" type="application/json">'
        + js + "</script> <div>" + query.replace("<", "&lt;").replace('"', "&quot;") + "</div> </body> </html>"
    )
    plain = plain if plain is not None else f"=== Web - new result for [{query}] ===\n"
    return (
        f"--{BOUNDARY}\r\nContent-Type: text/plain; charset=\"UTF-8\"; format=flowed; delsp=yes\r\n\r\n".encode()
        + plain.replace("\n", "\r\n").encode()
        + f"\r\n--{BOUNDARY}\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n"
        "Content-Transfer-Encoding: quoted-printable\r\n\r\n".encode()
        + qp(html)
        + f"\r\n--{BOUNDARY}--\r\n".encode()
    )


def signed(body, t, key, **o):
    canon = o.get("canon_body") or body_canon(body)
    bh = base64.b64encode(hashlib.sha256(canon).digest()).decode()
    if o.get("wrong_bh"):
        bh = base64.b64encode(b"\x11" * 32).decode()
    tags = [
        ("v", "1"), ("a", o.get("a", "rsa-sha256")), ("c", "relaxed/relaxed"), ("d", o.get("d", "google.com")),
        ("s", o.get("s", "20251104")), ("t", str(t)), ("x", str(t + 604800)),
        ("h", "content-type:to:from:subject:date"), ("bh", bh),
    ]
    if o.get("l"):
        tags.insert(5, ("l", "10"))
    dkim = "dkim-signature:" + "; ".join(f"{k}={v}" for k, v in tags) + "; b="
    frm = o.get("from", FROM)
    ctype = o.get("ctype", f'multipart/alternative; boundary="{BOUNDARY}"')
    head = (
        f"content-type:{ctype}\r\nto:synthetic@example.com\r\nfrom:{frm}\r\n"
        f"subject:Google Alert - rent\r\ndate:Mon, 02 Nov 2026 12:00:00 +0000\r\n{dkim}"
    ).encode()
    sig = key.sign(head, padding.PKCS1v15(), hashes.SHA256())
    return head, canon, sig


def write(dirpath, head, canon, sig):
    dirpath.mkdir(parents=True, exist_ok=True)
    (dirpath / "signed-headers.bin").write_bytes(head)
    (dirpath / "canon-body.bin").write_bytes(canon)
    (dirpath / "sig.bin").write_bytes(sig)


def synthetic():
    key = serialization.load_pem_private_key(
        (ROOT / "fixtures/testkey/test-only-private-key.pem").read_bytes(), password=None)
    EH, MH = "east-harlem-new-york-ny", "mott-haven-bronx-ny"
    w_eh = widget("Rental Market Trends in East Harlem - Apartments.com",
                  sentence("November", 2026, "East Harlem", "3,010"), apt_url(EH))
    w_mh = widget("Rental Market Trends in Mott Haven - Apartments.com",
                  sentence("November", 2026, "Mott Haven", "2,800"), apt_url(MH))
    w_other = widget("NYC rents - Realtor.com", "Rents in NYC keep rising.", apt_url("nyc", host="www.realtor.com"))
    fake_json = re.sub(r"\s*\n\s*", " ", '"widgets": [ ' + w_eh.replace("3,010", "9,999") + " ]")
    cases = {
        "ok-single": dict(w=[w_eh], t=NOV_T),
        "ok-later-different": dict(w=[w_eh.replace("3,010", "3,500")], t=NOV_T + 86400),
        "ok-earlier-different": dict(w=[w_eh.replace("3,010", "2,500")], t=NOV_T - 86400),
        "ok-multi": dict(w=[w_other, w_eh, w_mh], t=NOV_T),
        "ok-extra-dollars": dict(w=[w_eh.replace("you can expect to pay", "pay as little as $1,197")], t=NOV_T),
        "ok-image-key": dict(w=[widget("t", sentence("November", 2026, "East Harlem", "3,010"), apt_url(EH),
                                       extra='\n      "image_url": "https://example.com/a.png",')], t=NOV_T),
        "ok-query-injection": dict(w=[w_eh], t=NOV_T, q=fake_json,
                                   plain='<script data-scope="inboxmarkup" type="application/json">{' + fake_json + "}</script>\n"),
        "bad-wrong-host": dict(w=[widget("t", sentence("November", 2026, "East Harlem", "3,010"),
                                         apt_url(EH, host="www.apartments.com.evil.example"))], t=NOV_T),
        "bad-wrong-path": dict(w=[widget("t", sentence("November", 2026, "East Harlem", "3,010"),
                                         apt_url(EH, path="blog"))], t=NOV_T),
        "bad-joined-widgets": dict(w=[widget("t", "See rents here.", apt_url(EH)),
                                      widget("t", sentence("November", 2026, "East Harlem", "9,999"),
                                             apt_url("x", host="www.realtor.com"))], t=NOV_T),
        "bad-name-mismatch": dict(w=[widget("t", sentence("November", 2026, "Melrose", "1,000"), apt_url(MH))], t=NOV_T),
        "bad-month-mismatch": dict(w=[widget("t", sentence("December", 2026, "East Harlem", "3,010"), apt_url(EH))], t=NOV_T),
        "bad-bedroom-text": dict(w=[widget("t", "Average Rent by Bedroom in East Harlem. Studio $2,000", apt_url(EH))], t=NOV_T),
        "bad-amount-group": dict(w=[widget("t", sentence("November", 2026, "East Harlem", "3,01"), apt_url(EH))], t=NOV_T),
        "bad-leading-zero": dict(w=[widget("t", sentence("November", 2026, "East Harlem", "03,010"), apt_url(EH))], t=NOV_T),
        "bad-duplicate-key": dict(json_override=True, t=NOV_T),
        "bad-from-display": dict(w=[w_eh], t=NOV_T, sign={"from": '"<googlealerts-noreply@google.com>" <x@evil.example>'}),
        "bad-selector": dict(w=[w_eh], t=NOV_T, sign={"s": "20230601"}),
        "bad-domain": dict(w=[w_eh], t=NOV_T, sign={"d": "evil.example"}),
        "bad-l-tag": dict(w=[w_eh], t=NOV_T, sign={"l": True}),
        "bad-body-hash": dict(w=[w_eh], t=NOV_T, sign={"wrong_bh": True}),
        "bad-boundary": dict(w=[w_eh], t=NOV_T, sign={"ctype": 'multipart/alternative; boundary="other"'}),
    }
    if SYN.exists():
        shutil.rmtree(SYN)
    for name, c in cases.items():
        if c.get("json_override"):
            js = ('{\n "cards": [ {\n "widgets": [ {\n "type": "LINK",\n "description": "%s",\n "description": "%s",\n "url": "%s"\n } ]\n } ]\n}'
                  % (sentence("November", 2026, "East Harlem", "3,010"), sentence("November", 2026, "East Harlem", "9,999"), apt_url(EH)))
            body = build_body([], raw_json=js)
        else:
            body = build_body(c["w"], query=c.get("q", "rent"), plain=c.get("plain"))
        write(SYN / name, *signed(body, c["t"], key, **c.get("sign", {})))
        (SYN / name / "t.txt").write_text(str(c["t"]))
    head, canon, sig = signed(build_body([w_eh]), NOV_T, key)
    write(SYN / "bad-tampered-sig", head, canon, bytes([sig[0] ^ 1]) + sig[1:])
    write(SYN / "bad-tampered-body", head, canon.replace(b"3,010", b"9,010"), sig)
    print(len(cases) + 2, "synthetic cases")


def expected_results(msg, t):
    html = next(p for p in msg.walk() if p.get_content_type() == "text/html").get_content()
    a = html.find('type="application/json">') + 24
    data = json.loads(html[a:html.find("</script>", a)])
    out = []
    for w in data["cards"][0]["widgets"]:
        m = re.fullmatch(r"https://www\.google\.com/url\?rct=j&sa=t&url=https://www\.apartments\.com/rent-market-trends/([a-z0-9-]+)/&ct=ga&.*", w.get("url", ""))
        s = re.match(r"As of ([A-Z][a-z]+) (\d{4}), the average rent in ([A-Za-z -]+?) was \$([1-9]\d{0,2}(?:,\d{3})*)/mo\.", w.get("description", ""))
        if not (m and s and w.get("type") == "LINK" and s[1] in MONTHS):
            continue
        slug = m[1]
        label = s[3].lower().replace(" ", "-")
        if not slug.startswith(label + "-"):
            continue
        y, mo = int(s[2]), MONTHS.index(s[1])
        start = calendar.timegm((y, mo, 1, 0, 0, 0))
        end = start + calendar.monthrange(y, mo)[1] * 86400 - 1
        if start <= t <= end:
            out.append({"slug": slug, "yyyymm": y * 100 + mo, "cents": int(s[4].replace(",", "")) * 100})
    return out


def real(roots):
    import subprocess
    txt = subprocess.check_output(["dig", "+short", "TXT", "20251104._domainkey.google.com"]).decode()
    der = base64.b64decode("".join(re.findall(r'"([^"]*)"', txt)).split("p=")[1])
    pub = serialization.load_der_public_key(der)
    if PRIV.exists():
        shutil.rmtree(PRIV)
    seen, manifest = set(), []
    for root in roots:
        for f in glob.glob(os.path.expanduser(root) + "/**/*.eml", recursive=True):
            raw = open(f, "rb").read()
            h = hashlib.sha256(raw).hexdigest()
            if h in seen or b"googlealerts-noreply@google.com" not in raw:
                continue
            seen.add(h)
            sep = raw.find(b"\r\n\r\n")
            head, body = raw[:sep].decode("latin1"), raw[sep + 4:]
            fields = re.findall(r"(?m)^([A-Za-z0-9-]+):((?:[^\r\n]*)(?:\r\n[ \t][^\r\n]*)*)", head)
            sender = next((v for n, v in fields if n.lower() == "from"), "")
            found = [i for i, (n, _) in enumerate(fields) if n.lower() == "dkim-signature"
                     and "d=google.com" in re.sub(r"\s", "", fields[i][1])]
            if "<googlealerts-noreply@google.com>" not in sender or not found:
                continue
            dk = found[0]
            tags = dict(re.findall(r"(\w+)=([^;]*)", re.sub(r"\s+", "", fields[dk][1])))
            used, lines = set(), []
            for name in tags["h"].lower().split(":"):
                for i in range(len(fields) - 1, -1, -1):
                    if i != dk and i not in used and fields[i][0].lower() == name:
                        used.add(i)
                        lines.append(header_canon(*fields[i]) + "\r\n")
                        break
            line = header_canon(*fields[dk])
            line = re.sub(r"(;\s*b=)[^;]*$", r"\1", line)
            block = "".join(lines).encode("latin1") + line.encode("latin1")
            canon = body_canon(body)
            sig = base64.b64decode(tags["b"])
            assert base64.b64encode(hashlib.sha256(canon).digest()).decode() == tags["bh"], f
            pub.verify(sig, block, padding.PKCS1v15(), hashes.SHA256())
            msg = email.message_from_bytes(raw, policy=policy.default)
            n = len(manifest)
            write(PRIV / str(n), block, canon, sig)
            results = expected_results(msg, int(tags["t"]))
            manifest.append({"t": int(tags["t"]), "resultCount": len(results), "results": results})
    (PRIV / "manifest.json").write_text(json.dumps({"count": len(manifest), "emails": manifest}))
    print(len(manifest), "real emails;", sum(len(m["results"]) for m in manifest), "expected results")


if __name__ == "__main__":
    synthetic()
    if sys.argv[1:]:
        real(sys.argv[1:])
