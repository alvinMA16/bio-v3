import copy
import json
from unittest.mock import patch
import real_bench
import unittest
from real_bench import normalize_usage, charge, rates_for, percentile, validate_reviews
from run import WEIGHTS

class RealBenchTests(unittest.TestCase):
    def test_usage_does_not_double_count_cache_or_reasoning(self):
        u=normalize_usage({'prompt_tokens':100,'prompt_tokens_details':{'cached_tokens':60},'completion_tokens':30,'completion_tokens_details':{'reasoning_tokens':10},'total_tokens':130})
        self.assertEqual((u['cache_hit'],u['cache_miss'],u['output'],u['reasoning']),(60,40,30,10))
        c=charge(u,{'cache_hit':.1,'cache_miss':.8,'output':2.7})
        self.assertAlmostEqual(c['total'],.000119)
        self.assertIsNone(normalize_usage({'prompt_tokens':100})['cache_hit'])
        self.assertIsNone(charge(normalize_usage(None),{'cache_hit':1,'cache_miss':1,'output':1})['total'])
        with self.assertRaises(ValueError):normalize_usage({'prompt_tokens':100,'prompt_cache_hit_tokens':90,'prompt_cache_miss_tokens':90})

    def test_peak_weekday_boundaries(self):
        prices={'deepseek':{'peak':{},'off_peak':{}}}
        for stamp,expected in [('2026-09-07T08:59:59+08:00','off_peak'),('2026-09-07T09:00:00+08:00','peak'),('2026-09-07T12:00:00+08:00','off_peak'),('2026-09-07T14:00:00+08:00','peak'),('2026-09-07T18:00:00+08:00','off_peak'),('2026-09-06T10:00:00+08:00','off_peak')]:
            self.assertEqual(rates_for('deepseek',stamp,prices)[0],expected)

    def test_review_binding_and_dimensions(self):
        item={'scores':{k:4 for k in WEIGHTS},'evidence':{k:'text evidence' for k in WEIGHTS},'critical_flags':[]}
        review={'fingerprint':'a','reviews':[{'id':'x','A':copy.deepcopy(item),'B':copy.deepcopy(item),'comparison':'clear'}]}
        blind={'fingerprint':'a','cases':[{'id':'x'}]}
        validate_reviews(review,blind)
        review['reviews'][0]['A']['scores']['spoken']=True
        with self.assertRaises(ValueError):validate_reviews(review,blind)
        review['fingerprint']='b'
        with self.assertRaises(ValueError):validate_reviews(review,blind)

    def test_stream_records_usage_and_text_not_reasoning(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def __iter__(self):
                for event in [
                    {'choices':[{'delta':{'reasoning_content':'hidden'},'finish_reason':None}]},
                    {'model':'test','choices':[{'delta':{'content':'你好'},'finish_reason':None}]},
                    {'choices':[{'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'prompt_cache_hit_tokens':4,'prompt_cache_miss_tokens':6,'completion_tokens':2,'total_tokens':12}},
                ]:
                    yield b'data: '+json.dumps(event).encode()+b'\n'
                yield b'data: [DONE]\n'
        with patch.object(real_bench.urllib.request,'urlopen',return_value=Response()) as mock:
            r=real_bench.stream({'name':'deepseek','url':'https://example.com','model':'test','key':'fake'},[])
        self.assertEqual(r['text'],'你好')
        self.assertEqual(r['usage']['cache_miss'],6)
        self.assertIsNone(r['error'])
        self.assertIsNotNone(r['ttft_ms'])
        self.assertTrue(json.loads(mock.call_args.args[0].data)['stream_options']['include_usage'])

    def test_percentiles(self):
        self.assertEqual(percentile([1,2,3,4],.5),2.5)
        self.assertIsNone(percentile([],.95))

if __name__=='__main__':unittest.main()
