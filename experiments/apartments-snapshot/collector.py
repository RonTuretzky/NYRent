"""Offline, fail-closed research extractor. NOT a DKIM verifier or settlement oracle."""
import argparse
import email.policy
import hashlib
import json
import re
from email import message_from_bytes
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, parse_qs


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError('duplicate JSON key')
        obj[key] = value
    return obj


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.parts = []
        self.current = ''

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('type') == 'application/json':
            self.active = True
            self.current = ''

    def handle_data(self, data):
        if self.active:
            self.current += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            self.parts.append(self.current)
            self.active = False


def publisher_url(value):
    u = urlsplit(value)
    if u.scheme != 'https' or u.username or u.password or u.port or u.fragment:
        raise ValueError('invalid URL')
    if u.netloc == 'www.google.com' and u.path == '/url':
        targets = parse_qs(u.query).get('url', [])
        if len(targets) != 1:
            raise ValueError('ambiguous redirect')
        value = targets[0]
        u = urlsplit(value)
    if u.scheme != 'https' or u.netloc != 'www.apartments.com' or u.query or u.fragment:
        raise ValueError('noncanonical publisher URL')
    return value


def extract(payload, registry):
    """Accept only one widget's URL + explicit description. Ignore all query fields."""
    by_url = {r['url']: r for r in registry['series']}
    results = []
    months = 'January February March April May June July August September October November December'.split()
    for ci, card in enumerate(payload.get('cards', [])):
        for wi, widget in enumerate(card.get('widgets', [])):
            if widget.get('type') != 'LINK':
                continue
            try:
                url = publisher_url(widget.get('url', ''))
            except ValueError:
                continue
            if url not in by_url:
                continue
            row = by_url[url]
            pattern = (r'As of (' + '|'.join(months) + r') (20\d{2}), the average rent in '
                       + re.escape(row['geography']) + r' was \$([1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)/mo\.')
            desc = widget.get('description', '')
            matches = list(re.finditer(pattern, desc))
            # Exactly one complete leading clause; no cross-widget repair or inferred period.
            if len(matches) != 1 or matches[0].start() != 0:
                continue
            m = matches[0]
            # Additional dollar amounts need a separate reviewed template, never silently ignored.
            if '$' in desc[m.end():]:
                continue
            cents = int(m[3].replace(',', '')) * 100
            if cents > 2**32 - 1:
                continue
            results.append(dict(seriesId=row['seriesId'], url=url,
                asOfMonth=f'{m[2]}-{months.index(m[1])+1:02}', cents=cents,
                excerpt=m[0], location=f'cards[{ci}].widgets[{wi}].description',
                periodKind='rolling-as-of-month', settlementEnabled=False,
                holds=['DKIM not verified by this tool', 'metric/cohort approval unresolved',
                       'no finalization or availability proof']))
    return results


def read_eml(raw, registry):
    msg = message_from_bytes(raw, policy=email.policy.default)
    html = [p for p in msg.walk() if p.get_content_type() == 'text/html']
    if len(html) != 1 or msg.defects or html[0].defects:
        raise ValueError('ambiguous or defective MIME')
    parser = Scripts()
    parser.feed(html[0].get_content())
    if len(parser.parts) != 1:
        raise ValueError('expected exactly one structured payload')
    payload = json.loads(parser.parts[0], object_pairs_hook=unique_object)
    return {'rawSha256': hashlib.sha256(raw).hexdigest(),
            'authentication': 'unverified', 'settlementEnabled': False,
            'candidates': extract(payload, registry)}


def summarize(candidates):
    groups = {}
    for c in candidates:
        groups.setdefault((c['seriesId'], c['asOfMonth']), set()).add(c['cents'])
    return [dict(seriesId=k[0], asOfMonth=k[1], valuesCents=sorted(v),
                 status='conflict-hold' if len(v)>1 else 'research-candidate',
                 settlementEnabled=False) for k, v in sorted(groups.items())]


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('eml', type=Path)
    args = ap.parse_args()
    registry = json.loads(Path(__file__).with_name('series.json').read_text())
    print(json.dumps(read_eml(args.eml.read_bytes(), registry), indent=2))
