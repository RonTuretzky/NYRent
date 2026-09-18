# Verification — evidence chain for the pinned key and fixture

Everything the oracle trusts cryptographically reduces to one RSA-2048 public key. This file
records how that key was obtained, every fingerprint needed to re-check it, and the local
verification anyone can reproduce against the committed fixture. All checks below were performed
locally on 2026-09-18 against the fixture in `fixtures/credaily-2026-09-17/`; the Gnosis
deployment re-asserts the same constants at deploy time (see
[OPERATIONS.md](OPERATIONS.md)).

## The pinned key

| Property | Value |
|---|---|
| DKIM domain (`d=`) | `newyork.credaily.com` |
| Selector (`s=`) | `b37` |
| DNS name | `b37._domainkey.newyork.credaily.com` |
| CNAME target | `b37.domainkey.u58081633.wl134.sendgrid.net.` |
| Key type | RSA-2048, `e = 65537` |
| SHA-256 of DER SPKI | `b991b8c3223dc8b7cb0e26fe5dc700a00e9e98337812815d5343d1ff2f46f381` |
| `keccak256(modulus)` (on-chain `MODULUS_HASH`) | `0x2f2f9938845a16a65bb4651356bc7d160fca499a50aea0c158b2b766c6b84a41` |

The raw DNS response, PEM and modulus are committed:
`fixtures/credaily-2026-09-17/dkim-dns.txt`, `dkim-public-key.pem`, and `meta.json`
(`modulus_hex`, `exponent`).

Reproduce the DNS retrieval and fingerprint yourself:

```sh
dig +short TXT b37._domainkey.newyork.credaily.com
# concatenate the quoted TXT chunks; the p= value is the base64 SPKI
openssl pkey -pubin -in fixtures/credaily-2026-09-17/dkim-public-key.pem -outform DER \
  | shasum -a 256    # b991b8c3…f381
cast keccak 0x$(python3 - <<'EOF'
import json; print(json.load(open('fixtures/credaily-2026-09-17/meta.json'))['modulus_hex'][2:])
EOF
)                    # 0x2f2f9938…4a41
```

Note `t=s` in the TXT record: the domain declares strict mode, consistent with the exact
`d=newyork.credaily.com` match the contract enforces.

## Independent authentication of the same message

Gmail's delivered copy of the fixture message carries its own `Authentication-Results`:

```text
dkim=pass header.i=@newyork.credaily.com header.s=b37 header.b=IILsFZPG
spf=pass
dmarc=pass header.from=credaily.com
```

Google's DKIM verifier and this repository's verifier independently accept the same signature
under the same DNS key. See `fixtures/credaily-2026-09-17/EVIDENCE.md` for the full capture
(Message-ID `<WzVnkfIgQeKaHCizo93DnA@geopod-ismtpd-61>`).

## Fixture ground truth

| Artifact | Bytes | SHA-256 |
|---|---|---|
| `credaily-cpace-2026-09-17.eml` (raw, CRLF) | 110,429 | `1a280566fd24dd03d1629e7debd0fc66472666b1f1b016e3c8f8510db242b2ba` |
| `canon-body.bin` (relaxed canonical body) | 102,197 | `5cef15b201facb36640cfd59d166688d731d3a86b88f58b5edea419382b948e1` |
| `signed-headers.bin` (canonical signed header block, `b=` emptied) | 1,378 | `5f19115625a277e8706cac17340ea3f513bb8d2d871e90187afdd71c2e83763a` |
| `sig.bin` (RSA signature) | 256 | `ba80fe62bda062a5392a0da27522c5856d92c331fcae1dc6881f713e513fe95c` |

Verified relations (each re-checked by the automated suites in [TESTING.md](TESTING.md)):

- `sha256(canon-body.bin)`, base64-encoded, equals the signed `bh=` tag:
  `XO8VsgH6yzZkDP1Z0WZojXMdOoa4j1i17epBk4K5SOE=` (note the body-hash SHA-256 above is the same
  digest in hex).
- `sig.bin` RSA-verifies (PKCS#1 v1.5, SHA-256 DigestInfo) over `sha256(signed-headers.bin)`
  against the pinned modulus.
- The signed DKIM tags are `v=1; a=rsa-sha256; c=relaxed/relaxed; d=newyork.credaily.com; s=b37;
  t=1789642464` (2026-09-17 10:54:24 UTC) with no `l=` tag.
- Extraction over the canonical body finds the anchor `Manhattan Office Rent` exactly once (raw
  canonical offset 43,411) and yields `$92.88 / SF` → **9288 cents**.

## Reproduce the whole chain in one command

```sh
node scripts/verify-eml.mjs fixtures/credaily-2026-09-17/credaily-cpace-2026-09-17.eml
```

The script (WebCrypto only, no network) re-derives the canonical body and signed header block
from the raw `.eml`, compares them byte-for-byte against the committed `.bin` goldens, recomputes
`bh`, verifies the RSA signature against the pinned modulus, applies the tag policy, and runs the
value extraction — the same named checks the app's settle-page preflight renders. Any authentic
future CRE Daily snapshot email can be passed through the same script before submitting it
on-chain.

## What this does and does not establish

Established: the committed fixture bytes are exactly what CRE Daily's mailer signed under the DNS
key that both Gmail and this verifier retrieved, and the deterministic parsing of those bytes
yields 9288 cents. Anyone can re-derive every hash above from public inputs.

Not established: that 92.88 is the "true" Manhattan rent (that is CRE Daily/CompStak editorial
trust, see [PROTOCOL.md](PROTOCOL.md)), that the key will not rotate, or that the contracts are
bug-free (unaudited; see the test evidence in [TESTING.md](TESTING.md)).
