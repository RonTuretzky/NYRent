# CRE Daily authenticated email evidence

- Saved message: `/Users/wk/Documents/NYRent/email-evidence/credaily-2026-09-17/credaily-cpace-2026-09-17.eml`
- SHA-256: `1a280566fd24dd03d1629e7debd0fc66472666b1f1b016e3c8f8510db242b2ba`
- Message-ID: `<WzVnkfIgQeKaHCizo93DnA@geopod-ismtpd-61>`
- From: `CRE Daily New York <mail@newyork.credaily.com>`
- To: `ron.t1234@gmail.com`
- Subject: `C-PACE Loans Are 40% Bigger`
- Date: `Thu, 17 Sep 2026 10:54:24 +0000 (UTC)`

## Authentication

Gmail's delivered-message `Authentication-Results` reports:

```text
dkim=pass header.i=@newyork.credaily.com header.s=b37 header.b=IILsFZPG
spf=pass
dmarc=pass header.from=credaily.com
```

The signed header is the first `DKIM-Signature` header in the raw message. It uses `d=newyork.credaily.com`, `s=b37`, `a=rsa-sha256`, and `c=relaxed/relaxed`.

## Rent quote location

The MIME body is a quoted-printable `text/html` part. In the saved raw `.eml`, the quote is at **lines 844-847** (the line wrapping is MIME quoted-printable folding):

```text
842: ;border-bottom:1px solid #e5e7eb;"><table width=3D"100%"><tbody><tr><td wid=
843: th=3D"50%" style=3D"font-size:13px;line-height:1.2;color:#111827;font-weigh=
844: t:600;"> Manhattan Office Rent <div style=3D"margin-top:2px;color:#6b7280;f=
845: ont-weight:400;"> Avg Effective </div></td><td width=3D"50%" style=3D"text-=
846: align:right;font-size:13px;line-height:1.2;color:#111827;font-weight:600;">=
847:  $92.88 / SF </td></tr></tbody></table></td></tr><tr><td style=3D"padding:8=
848: px 10px;"><table width=3D"100%"><tbody><tr><td width=3D"50%" style=3D"font-=
849: size:13px;line-height:1.2;color:#111827;font-weight:600;"> Office Rent Grow=
```

Decoded body text:

```text
Market Snapshot
Manhattan Office Rent
Avg Effective
$92.88 / SF
```

The email also states that these office metrics are courtesy of CompStak and cover data from `5/1/26 to 7/31/26`. This is commercial office rent, not residential apartment rent.

## Public key

The DKIM public key is the DNS TXT record at `b37._domainkey.newyork.credaily.com`. The selector CNAME resolves to `b37.domainkey.u58081633.wl134.sendgrid.net.`. The exact DNS response and key are saved in `dkim-dns.txt`, `dkim-public-key.pem`, and `dkim-public-key.der`.
