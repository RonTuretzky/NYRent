import copy
import json
import unittest
from pathlib import Path
from collector import extract, read_eml, summarize, unique_object

REGISTRY = json.loads(Path(__file__).with_name('series.json').read_text())
URL = 'https://www.apartments.com/rent-market-trends/east-harlem-new-york-ny/'
DESC = 'As of October 2026, the average rent in East Harlem was $2,952/mo.'


def payload(desc=DESC, url=URL):
    return {'cards':[{'widgets':[{'type':'LINK','description':desc,'url':url}]}]}


class BoundaryTests(unittest.TestCase):
    def test_bound_candidate_is_never_settlement(self):
        c = extract(payload(), REGISTRY)[0]
        self.assertEqual((c['cents'], c['asOfMonth']), (295200,'2026-10'))
        self.assertFalse(c['settlementEnabled'])

    def test_query_and_title_cannot_supply_price(self):
        p = payload('No rent observation')
        p['entity'] = {'title': DESC}
        p['cards'][0]['title'] = DESC
        p['cards'][0]['widgets'][0]['title'] = DESC
        self.assertEqual(extract(p, REGISTRY), [])

    def test_missing_period_and_wrong_geo(self):
        for d in (DESC.replace('2026',''), DESC.replace('October 2026','October'),
                  DESC.replace('East Harlem','Harlem'), DESC.replace('was','is')):
            with self.subTest(description=d):
                self.assertEqual(extract(payload(d), REGISTRY), [])

    def test_host_path_redirect_binding(self):
        for u in (URL.replace('www.apartments.com','www.apartments.com.evil.test'),
                  URL+'?override=1', URL.replace('east-harlem','harlem'),
                  'https://www.google.com/url?url='+URL+'&url='+URL):
            self.assertEqual(extract(payload(url=u), REGISTRY), [])
        self.assertEqual(len(extract(payload(url='https://www.google.com/url?url='+URL),REGISTRY)),1)

    def test_no_cross_result_join(self):
        p=payload('No price')
        p['cards'][0]['widgets'].append({'type':'LINK','description':DESC,'url':'https://example.com/'})
        self.assertEqual(extract(p,REGISTRY),[])

    def test_additional_prices_and_duplicate_clause_hold(self):
        for d in (DESC+' Nearby Brooklyn $4,500.', DESC+' '+DESC):
            self.assertEqual(extract(payload(d), REGISTRY), [])

    def test_duplicate_json_rejected(self):
        with self.assertRaises(ValueError):
            json.loads('{"cards":[],"cards":[]}',object_pairs_hook=unique_object)

    def test_duplicate_payload_rejected(self):
        html='<script type="application/json">'+json.dumps(payload())+'</script>'
        raw=('Content-Type: text/html; charset=utf-8\r\n\r\n'+html+html).encode()
        with self.assertRaises(ValueError): read_eml(raw, REGISTRY)

    def test_repeated_value_dedup_and_revision_conflict(self):
        c=extract(payload(),REGISTRY)[0]
        self.assertEqual(summarize([c,c])[0]['valuesCents'],[295200])
        changed=copy.deepcopy(c);changed['cents']=294500
        self.assertEqual(summarize([c,changed])[0]['status'],'conflict-hold')


if __name__ == '__main__': unittest.main()
