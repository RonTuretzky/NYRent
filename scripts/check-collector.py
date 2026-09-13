"""Exercise the proof collector over DNS packets from a local fixture responder."""
import json, socket, struct, subprocess, sys, threading
from pathlib import Path
import dns.name,dns.message,dns.rdata,dns.rrset

chain=json.loads(Path('web/fixtures/alpha-proof.json').read_text())[0];db={}
for item in chain:
    raw=bytes.fromhex(item['rrset'][2:]);sig=bytes.fromhex(item['sig'][2:]);_,n=dns.name.from_wire(raw,18);p=18+n
    signature=dns.rdata.from_wire(1,46,raw[:p]+sig,0,p+len(sig));owner,n=dns.name.from_wire(raw,p);p+=n
    typ,cls,ttl,length=struct.unpack('!HHIH',raw[p:p+10]);p+=10
    data=dns.rdata.from_wire(cls,typ,raw,p,length)
    db[(owner.to_text(),typ)]=(dns.rrset.from_rdata(owner,ttl,data),dns.rrset.from_rdata(owner,ttl,signature))
sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];stop=False
def serve():
    while not stop:
        try:
            data,address=sock.recvfrom(65535);query=dns.message.from_wire(data);q=query.question[0];answer=dns.message.make_response(query)
            answer.answer.extend(db[(q.name.to_text(),q.rdtype)]);sock.sendto(answer.to_wire(),address)
        except OSError:return
threading.Thread(target=serve,daemon=True).start()
subprocess.run([sys.executable,'scripts/collect-dnssec.py','--domain','alpha.rent.test','--selector','rent','--resolver','127.0.0.1','--port',str(port),'--output','.local/collected-proof.json'],check=True)
actual=json.loads(Path('.local/collected-proof.json').read_text())
assert actual==[chain], 'Collected DNS signature bytes differ from the signed fixture chain'
stop=True;sock.close();print('Collector reproduced all six signed DNSSEC RRsets exactly from DNS wire responses.')
