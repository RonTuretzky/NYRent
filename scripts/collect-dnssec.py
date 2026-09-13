"""Collect untrusted DNS packets as a proof witness. Solidity decides validity.

Usage: .local/verify-venv/bin/python scripts/collect-dnssec.py \
  --domain publisher.example --selector mail --output proof.json
Requires dnspython[dnssec]==2.8.0. No resolver's AD flag is trusted.
"""
import argparse,json,sys
import dns.message,dns.query,dns.flags,dns.dnssec,dns.rdatatype,dns.name

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--domain',required=True);ap.add_argument('--selector',required=True)
    ap.add_argument('--resolver',default='1.1.1.1');ap.add_argument('--port',type=int,default=53);ap.add_argument('--output',required=True)
    args=ap.parse_args();cache={}
    def lookup(name,typ):
        name=dns.name.from_text(str(name)).canonicalize();key=(name.to_text(),typ)
        if key in cache:return cache[key]
        query=dns.message.make_query(name,typ,want_dnssec=True)
        response=dns.query.udp(query,args.resolver,port=args.port,timeout=5)
        if response.flags&dns.flags.TC:response=dns.query.tcp(query,args.resolver,port=args.port,timeout=5)
        records=next((r for r in response.answer if r.name==name and r.rdtype==typ),None)
        if records is None:
            cname=next((r for r in response.answer if r.name==name and r.rdtype==5),None)
            if typ==16 and cname:records=cname
            else:raise ValueError(f'No positive signed {dns.rdatatype.to_text(typ)} RRset for {name}')
        signatures=[s for r in response.answer if r.name==name and r.rdtype==46 for s in r if s.type_covered==records.rdtype and s.algorithm in (8,13)]
        if not signatures:raise ValueError(f'{name} has no supported RRSIG; no oracle-free DNSSEC proof is available from this answer')
        sig=signatures[0];cache[key]=(records,sig);return records,sig
    def encoded(rrset,sig):
        # Pinned dnspython implementation of RFC4034 canonical signature input.
        wire=dns.dnssec._make_rrsig_signature_data(rrset,sig)
        return {'rrset':'0x'+wire.hex(),'sig':'0x'+sig.signature.hex()}
    def chain(records,sig,depth=0):
        if depth>12:raise ValueError('DNSSEC delegation depth exceeds configured limit')
        zone=sig.signer;keyset,keysig=lookup(zone,48)
        if zone==dns.name.root:result=[encoded(keyset,keysig)]
        else:
            ds,dssig=lookup(zone,43);result=chain(ds,dssig,depth+1)+[encoded(keyset,keysig)]
        return result+[encoded(records,sig)]
    name=args.selector+'._domainkey.'+args.domain;chains=[]
    for _ in range(4):
        records,sig=lookup(name,16);chains.append(chain(records,sig))
        if records.rdtype==16:break
        name=records[0].target.to_text()
    else:raise ValueError('CNAME chain exceeds three aliases')
    with open(args.output,'w') as f:json.dump(chains,f,indent=2)
    print(f'Wrote {len(chains)} proof chain(s). These are untrusted witnesses until checked by the deployed contract.')
if __name__=='__main__':
    try:main()
    except Exception as e:print(f'Cannot build proof: {e}',file=sys.stderr);sys.exit(1)
