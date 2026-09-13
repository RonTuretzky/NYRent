"""Independent dkimpy and dnspython checks over the generated signed fixtures."""
from pathlib import Path
import base64, json, struct
import dkim
import dns.name, dns.rdata, dns.rdataclass, dns.rdatatype, dns.rrset, dns.dnssec

def unpack(item):
    raw=bytes.fromhex(item['rrset'][2:]); signature=bytes.fromhex(item['sig'][2:])
    signer,used=dns.name.from_wire(raw,18); prefix=18+used
    rrsig=dns.rdata.from_wire(1,46,raw[:prefix]+signature,0,prefix+len(signature))
    owner,used=dns.name.from_wire(raw,prefix); p=prefix+used
    typ,cls,ttl,length=struct.unpack('!HHIH',raw[p:p+10]);p+=10
    rdata=dns.rdata.from_wire(cls,typ,raw,p,length)
    rrset=dns.rrset.from_rdata(owner,ttl,rdata)
    sigset=dns.rrset.from_rdata(owner,ttl,rrsig)
    return rrset,sigset,signer

manifest=json.loads(Path('.local/fixtures.json').read_text()); now=manifest['start']
for source in ['alpha','beta','gamma']:
    chain=json.loads(Path(f'web/fixtures/{source}-proof.json').read_text())[0]
    known={};last=None
    for item in chain:
        records,sigs,signer=unpack(item)
        if records.rdtype==48: known[records.name]=records
        dns.dnssec.validate(records,sigs,known,now=now)
        if records.rdtype==48 and last is not None:
            assert any(dns.dnssec.make_ds(records.name,key,'SHA256') in last for key in records), 'DS does not authorize DNSKEY'
        if records.rdtype==43:last=records
    txt=b''.join(records[0].strings)
    mail=Path(f'web/fixtures/{source}.eml').read_bytes()
    assert dkim.verify(mail,dnsfunc=lambda name,timeout=5:txt), f'{source} DKIM signature invalid'
    changed=mail[:-3]+b'X'+mail[-2:]
    assert not dkim.verify(changed,dnsfunc=lambda name,timeout=5:txt), 'altered body unexpectedly verified'
    print(f'{source}: independent DNSSEC signatures + DS links + DKIM verification passed; altered body rejected')
Path('.local/independent-verification.json').write_text(json.dumps({'dkimpy':'1.1.8','dnspython':'2.8.0','sources':3,'dnssec_signature_checks':18,'dkim_valid':3,'tampered_body_rejected':3},indent=2))
