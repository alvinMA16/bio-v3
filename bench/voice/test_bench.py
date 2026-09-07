import json
import tempfile
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
import run as bench
from build_cases import build


def judgment(winner='A'):
    scores = lambda n: {key:n for key in bench.WEIGHTS}
    evidence = {key:'Concrete supporting quote' for key in bench.WEIGHTS}
    return {'A':{'scores':scores(5),'evidence':evidence,'critical_flags':[]},
            'B':{'scores':scores(1),'evidence':evidence,'critical_flags':[]},
            'winner':winner,'reason':'A respects the request; B contradicts it.','confidence':'high'}


class BenchTests(unittest.TestCase):
    def test_dataset_is_reproducible_and_has_no_future_turns(self):
        cases = bench.load_cases(Path(__file__).with_name('cases.jsonl'))
        self.assertEqual(cases,build())
        self.assertEqual(len(cases),24)
        dev = {c['family'] for c in cases if c['split']=='dev'}
        test = {c['family'] for c in cases if c['split']=='test'}
        self.assertFalse(dev & test)
        self.assertEqual(len({c['family'] for c in bench.select_cases(cases,'all',8)}),8)

    def test_invalid_score_and_contradiction_fail(self):
        self.assertEqual(bench.validate_judgment(judgment())['winner'],'A')
        for bad in (True, 6, 0, 4.5):
            value = judgment()
            value['A']['scores']['grounding'] = bad
            with self.assertRaises(ValueError): bench.validate_judgment(value)
        with self.assertRaises(ValueError): bench.validate_judgment(judgment('B'))
        value = judgment()
        value['A']['evidence']['grounding'] = ''
        with self.assertRaises(ValueError): bench.validate_judgment(value)

    def test_order_bias_is_not_a_tie_and_failures_not_zero(self):
        row = {'id':'one','family':'f','candidates':{'qwen':{'text':'x'},'deepseek':{'text':'y'}},
               'reviews':[{'order':['qwen','deepseek'],'judgment':judgment(),'mapped_winner':'qwen'},
                          {'order':['deepseek','qwen'],'judgment':judgment(),'mapped_winner':'deepseek'}]}
        failed = {'id':'two','family':'g','candidates':{'qwen':{'error':'network'},'deepseek':{'text':'z'}},'reviews':[]}
        summary = bench.summarize({'candidate_names':['qwen','deepseek'],'results':[row,failed]})
        self.assertEqual(summary['outcomes']['inconsistent'],1)
        self.assertEqual(summary['outcomes']['tie'],0)
        self.assertEqual(summary['outcomes']['failed'],1)
        self.assertEqual(summary['family_macro_scores']['qwen'],3)
        self.assertEqual(summary['generation_failures']['qwen'],1)

    def test_swapped_labels_and_judge_blinding(self):
        self.assertEqual(bench.map_winner('A',['deepseek','qwen']),'deepseek')
        with patch.object(bench,'complete',return_value={'text':json.dumps(judgment()),'duration_ms':1,'usage':{},'returned_model':'judge'}) as mock:
            case = build()[0]
            bench.adjudicate(case,{'qwen':{'text':'reply q'},'deepseek':{'text':'reply d'}},{},'judge rules',['deepseek','qwen'])
            payload = json.loads(mock.call_args.args[1][1]['content'])
            self.assertEqual(payload['A'],'reply d')
            self.assertNotIn('qwen',json.dumps(payload))
            self.assertNotIn('deepseek',json.dumps(payload))
            self.assertNotIn('provenance',payload)

    def test_invalid_judgment_retains_raw_evidence(self):
        raw = json.dumps(judgment('B'))
        with patch.object(bench,'complete',return_value={'text':raw,'duration_ms':1,'usage':{},'returned_model':'judge'}):
            value = bench.adjudicate(build()[0],{'qwen':{'text':'q'},'deepseek':{'text':'d'}},{},'rules',['qwen','deepseek'])
            self.assertEqual(value['raw_reply'],raw)
            self.assertIn('contradicts',value['error'])

    def test_end_to_end_report_without_network(self):
        def reply(model, messages, temperature, max_tokens):
            text = json.dumps(judgment()) if max_tokens == 4096 else '您慢慢想。'
            return {'text':text,'duration_ms':1,'usage':{},'returned_model':model['model']}
        env = {'QWEN_API_KEY':'fake','DEEPSEEK_API_KEY':'fake'}
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'run'
            with patch.object(bench,'load_env',return_value=env), patch.object(bench,'complete',side_effect=reply) as mock, patch.object(sys,'argv',['bench','run','--limit','2','--judge','qwen','--output',str(output)]):
                bench.main()
            self.assertEqual(mock.call_count,8)
            summary = json.loads((output/'summary.json').read_text())
            self.assertEqual(summary['outcomes']['inconsistent'],2)
            self.assertTrue((output/'report.md').exists())
            self.assertNotIn('fake',(output/'results.json').read_text())
            state = json.loads((output/'results.json').read_text())
            self.assertTrue(state['self_judge_risk'])
            self.assertEqual(state['spec']['rubric_weights'],bench.WEIGHTS)

    def test_provider_payload_and_truncation(self):
        class Reply:
            def __enter__(self): return self
            def __exit__(self,*args): pass
            def read(self): return json.dumps({'choices':[{'finish_reason':'length','message':{'content':'cut'}}]}).encode()
        model = {'name':'qwen','model':'test','url':'https://example.com/v1','key':'not-a-real-key'}
        with patch.object(bench.urllib.request,'urlopen',return_value=Reply()) as mock:
            with self.assertRaises(ValueError): bench.complete(model,[],.3,512)
            request = mock.call_args.args[0]
            self.assertFalse(json.loads(request.data)['enable_thinking'])
        self.assertNotIn('key',bench.public_profile(model))


if __name__=='__main__': unittest.main()
