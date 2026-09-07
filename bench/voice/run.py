"""Frozen-context voice response bench. Python stdlib only; no server access."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
WEIGHTS = {'intent': .20, 'grounding': .25, 'continuity': .15, 'spoken': .15, 'pacing': .15, 'empathy': .10}
FLAGS = {'fabricated_action', 'invented_fact', 'ignored_boundary'}
PROVIDERS = {
    'qwen': ('QWEN', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-flash'),
    'deepseek': ('DEEPSEEK', 'https://api.deepseek.com', 'deepseek-v4-flash'),
    'custom': ('LLM', '', ''),
    'judge': ('BENCH_JUDGE', '', ''),
}


def load_env():
    # Deliberately no shell evaluation, expansion or printing of credentials.
    values = {}
    env_file = REPO / '.env'
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('\"\'')
    values.update(os.environ)
    return values


def profile(name, env):
    prefix, default_url, default_model = PROVIDERS[name]
    result = {'name': name, 'url': env.get(prefix + '_BASE_URL', default_url).rstrip('/'),
              'model': env.get(prefix + '_MODEL', default_model), 'key': env.get(prefix + '_API_KEY', '')}
    if not all(result.values()):
        raise ValueError(f'{prefix}_BASE_URL, {prefix}_MODEL and {prefix}_API_KEY are required')
    if not result['url'].startswith(('https://', 'http://127.0.0.1:', 'http://localhost:')):
        raise ValueError('Remote model endpoints must use HTTPS')
    return result


def public_profile(value):
    return {key: value[key] for key in ('name', 'model', 'url')}


def complete(model, messages, temperature, max_tokens):
    body = {'model': model['model'], 'messages': messages, 'temperature': temperature,
            'max_tokens': max_tokens, 'stream': False}
    if model['name'] == 'qwen':
        body['enable_thinking'] = False
    elif model['name'] == 'deepseek':
        body['thinking'] = {'type': 'disabled'}
    request = urllib.request.Request(model['url'] + '/chat/completions',
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={'Authorization': 'Bearer ' + model['key'], 'Content-Type': 'application/json'})
    start = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        # Provider bodies can contain credentials or echoed prompts; do not persist them.
        raise RuntimeError(f'HTTP {exc.code}') from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError('Model network request failed or timed out') from None
    choices = payload.get('choices', [])
    if not choices:
        raise ValueError('Provider returned no choices')
    choice = choices[0]
    if choice.get('finish_reason') != 'stop':
        raise ValueError('Incomplete response: ' + str(choice.get('finish_reason')))
    text = choice.get('message', {}).get('content')
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Provider returned empty/non-text content')
    return {'text': text, 'duration_ms': round((time.monotonic() - start) * 1000),
            'usage': payload.get('usage'), 'returned_model': payload.get('model')}


def load_cases(path):
    cases = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    ids = set()
    family_splits = {}
    for case in cases:
        if case['id'] in ids:
            raise ValueError('Duplicate case ID')
        ids.add(case['id'])
        split = family_splits.setdefault(case['family'], case['split'])
        if split != case['split']:
            raise ValueError('Scenario family leaks across dev/test')
        if case['split'] not in ('dev', 'test') or case['source_kind'] not in ('observed_pattern_rewrite', 'derived_stress_variant'):
            raise ValueError('Unknown split/source kind')
        if not case['messages'] or case['messages'][-1]['role'] != 'user':
            raise ValueError('Case must end at the user turn, with no future response')
        for message in case['messages']:
            if message['role'] not in ('user', 'assistant') or not isinstance(message['content'], str) or not message['content'].strip():
                raise ValueError('Invalid history message')
        if not case['rubric']['expectation']:
            raise ValueError('Missing semantic evaluation target')
    return cases


def select_cases(cases, split, limit):
    selected = [c for c in cases if split == 'all' or c['split'] == split]
    # Round-robin families so a smoke limit does not select one scenario only.
    groups = {}
    for case in selected:
        groups.setdefault(case['family'], []).append(case)
    selected = [group[i] for i in range(max(map(len, groups.values()), default=0))
                for group in groups.values() if i < len(group)]
    return selected[:limit] if limit is not None else selected


def weighted(scores):
    return sum(scores[key] * weight for key, weight in WEIGHTS.items())


def score_winner(a, b):
    delta = weighted(a) - weighted(b)
    return 'tie' if abs(delta) < .25 else ('A' if delta > 0 else 'B')


def validate_judgment(value):
    if value.get('winner') not in ('A', 'B', 'tie') or value.get('confidence') not in ('low', 'medium', 'high'):
        raise ValueError('Invalid winner/confidence')
    if not isinstance(value.get('reason'), str) or not value['reason'].strip():
        raise ValueError('Missing comparative rationale')
    for label in ('A', 'B'):
        scores, evidence = value[label]['scores'], value[label]['evidence']
        if set(scores) != set(WEIGHTS) or set(evidence) != set(WEIGHTS):
            raise ValueError('Missing/unknown rubric dimensions')
        if any(type(v) is not int or v < 1 or v > 5 for v in scores.values()):
            raise ValueError('Scores must be integers in 1..5')
        if any(not isinstance(v, str) or not v.strip() for v in evidence.values()):
            raise ValueError('Every score needs specific evidence')
        flags = value[label]['critical_flags']
        if not isinstance(flags, list) or any(f not in FLAGS for f in flags):
            raise ValueError('Invalid critical flags')
    if score_winner(value['A']['scores'], value['B']['scores']) != value['winner']:
        raise ValueError('Winner contradicts weighted scores')
    return value


def map_winner(winner, order):
    return winner if winner == 'tie' else order[0 if winner == 'A' else 1]


def adjudicate(case, candidates, judge, system, order):
    data = {'history': case['messages'], 'case_goal': case['rubric'],
            'environment': '纯语音文本，无读取/修改/保存工具。历史助手承诺未经工具确认。',
            'A': candidates[order[0]]['text'], 'B': candidates[order[1]]['text']}
    reply = complete(judge, [{'role': 'system', 'content': system},
                            {'role': 'user', 'content': json.dumps(data, ensure_ascii=False)}], 0, 4096)
    try:
        judgment = validate_judgment(json.loads(reply['text']))
    except (ValueError, KeyError, TypeError) as exc:
        return {'order': order, 'error': str(exc), 'raw_reply': reply['text'],
                'duration_ms': reply['duration_ms'], 'usage': reply['usage'], 'returned_model': reply['returned_model']}
    return {'order': order, 'judgment': judgment, 'mapped_winner': map_winner(judgment['winner'], order),
            'duration_ms': reply['duration_ms'], 'usage': reply['usage'], 'returned_model': reply['returned_model']}


def save(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def summarize(state):
    names = state['candidate_names']
    wins = {name: 0 for name in names}
    wins.update(tie=0, inconsistent=0, failed=0)
    rows = []
    family_scores = {name: {} for name in names}
    failures = {name: 0 for name in names}
    dimensions = {name: {dim: {} for dim in WEIGHTS} for name in names}
    critical = {name: {flag: 0 for flag in sorted(FLAGS)} for name in names}
    for row in state['results']:
        for name in names:
            if 'error' in row['candidates'].get(name, {}):
                failures[name] += 1
        reviews = row.get('reviews', [])
        if len(reviews) != 2 or any('error' in r for r in reviews):
            wins['failed'] += 1
            outcome = 'failed'
        else:
            first, second = [r['mapped_winner'] for r in reviews]
            outcome = first if first == second else 'inconsistent'
            wins[outcome] += 1
            # Descriptive scores include order disagreements, explicitly separated from wins.
            for name in names:
                scores = [weighted(r['judgment']['A' if r['order'][0] == name else 'B']['scores']) for r in reviews]
                family_scores[name].setdefault(row['family'], []).append(sum(scores) / 2)
                evaluations = [r['judgment']['A' if r['order'][0] == name else 'B'] for r in reviews]
                for dim in WEIGHTS:
                    dimensions[name][dim].setdefault(row['family'], []).append(sum(e['scores'][dim] for e in evaluations)/2)
                for flag in {f for e in evaluations for f in e['critical_flags']}:
                    critical[name][flag] += 1
        rows.append({'id': row['id'], 'family': row['family'], 'outcome': outcome})
    macro = {}
    per_family = {}
    for name in names:
        per_family[name] = {k: sum(v)/len(v) for k,v in family_scores[name].items()}
        vals = list(per_family[name].values())
        macro[name] = sum(vals)/len(vals) if vals else None
    dimension_macro = {name: {dim: (sum(sum(v)/len(v) for v in groups.values())/len(groups) if groups else None)
        for dim, groups in values.items()} for name, values in dimensions.items()}
    return {'dimension_macro_scores':dimension_macro, 'critical_flag_cases':critical, 'total_cases':len(state['results']), 'outcomes':wins, 'generation_failures':failures,
            'family_macro_scores':macro, 'per_family_scores':per_family, 'cases':rows}


def report(state, directory):
    summary = summarize(state)
    save(directory / 'summary.json', summary)
    lines = ['# Voice Reply Bench', '', f"Run: {state['created_at']} · split: {state['split']} · cases: {summary['total_cases']}",
        '', '范围：改写后的真实问题 + 衍生压力案例；固定历史的下一轮文本回复。非原始语音重放、非端到端 Agent/ASR/TTS 测试。',
        '历史回复不作为金标准；dev/test 按场景族拆分，不是按真实用户拆分。',
        '', f"Judge: {state['judge']['model']} · self-judge risk: {state['self_judge_risk']}",
        '同源/自评风险为 true 时仅作管线冒烟；评审尚需人工校准，不据此发布模型排名。',
        '', '评分范围 1–5，先平均两个顺序，再在场景内平均，最后等权平均场景；没有用户总体置信区间。',
        '换序不一致单独计数，不冒充平局；失败不算零分或自动判另一模型获胜。分数只覆盖双向评审成功的共同案例。',
        '', '|模型|场景宏平均|一致胜出数|生成失败|', '|---|---:|---:|---:|']
    for name in state['candidate_names']:
        score = summary['family_macro_scores'][name]
        lines.append(f"|{name}|{score:.3f}|{summary['outcomes'][name]}|{summary['generation_failures'][name]}|" if score is not None else f'|{name}|N/A|0|{summary["generation_failures"][name]}|')
    lines += ['', '逐项宏平均（同样按场景等权）：', '', '|模型|' + '|'.join(WEIGHTS) + '|', '|---|' + '---:|' * len(WEIGHTS)]
    for name in state['candidate_names']:
        lines.append('|' + name + '|' + '|'.join('N/A' if v is None else f'{v:.3f}' for v in summary['dimension_macro_scores'][name].values()) + '|')
    lines += ['', '严重问题按案例计数（两个顺序任一标记即计入，不代表人工确认）：' + json.dumps(summary['critical_flag_cases'], ensure_ascii=False)]
    lines += ['', f"结果计数：{json.dumps(summary['outcomes'], ensure_ascii=False)}", '',
              '|场景|结果|', '|---|---|']
    lines += [f"|{r['id']}|{r['outcome']}|" for r in summary['cases']]
    lines += ['', '详细回复、逐项证据、调用用量和错误见 results.json。耗时是非流式 API 整次请求耗时，不是首字/首音延迟。',
              '建议人工复核所有换序不一致、critical_flags、低置信度案例，并随机复核至少20%的其余案例。']
    (directory / 'report.md').write_text('\n'.join(lines) + '\n')
    return summary


def calibrate(judge, directory, seed):
    controls = json.loads((ROOT / 'calibration.json').read_text())
    system = (ROOT / 'judge-system.txt').read_text()
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    results = []
    rng = random.Random(seed)
    for control in controls:
        order = ['A', 'B']
        rng.shuffle(order)
        row = {'id': control['id'], 'expected': control['expected'], 'reviews': []}
        for orientation in (order, list(reversed(order))):
            try:
                review = adjudicate(control, {k: {'text': control[k]} for k in ('A', 'B')}, judge, system, orientation)
            except (RuntimeError, ValueError, KeyError, TypeError) as exc:
                review = {'error': str(exc), 'order': orientation}
            row['reviews'].append(review)
        row['passed'] = all(r.get('mapped_winner') == control['expected'] for r in row['reviews'])
        results.append(row)
        save(directory / 'calibration.json', {'judge':public_profile(judge), 'results':results,
            'note':'Three sanity checks only; not a substitute for human calibration on real scenarios.'})
        print(control['id'] + ': ' + str(row['passed']), flush=True)
    if not all(r['passed'] for r in results):
        raise SystemExit(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['validate', 'run', 'calibrate'])
    parser.add_argument('--cases', type=Path, default=ROOT / 'cases.jsonl')
    parser.add_argument('--split', choices=['dev', 'test', 'all'], default='dev')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--candidates', nargs=2, choices=list(PROVIDERS), default=['qwen', 'deepseek'])
    parser.add_argument('--judge', choices=list(PROVIDERS), default='judge')
    parser.add_argument('--seed', type=int, default=20260907)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.command == 'calibrate':
        calibrate(profile(args.judge, load_env()), args.output or ROOT / 'runs' / ('calibration-' + time.strftime('%Y%m%d-%H%M%S')), args.seed)
        return
    cases = load_cases(args.cases)
    selected = select_cases(cases, args.split, args.limit)
    if (args.limit is not None and args.limit <= 0) or not selected:
        parser.error('Select at least one case')
    if args.candidates[0] == args.candidates[1]:
        parser.error('Candidates must be distinct')
    print(json.dumps({'cases':len(cases), 'selected':len(selected), 'families':len({c['family'] for c in selected}),
                      'planned_calls':len(selected)*4, 'network':args.command == 'run'}))
    if args.command == 'validate':
        return
    env = load_env()
    candidates = {name:profile(name,env) for name in args.candidates}
    judge = profile(args.judge,env)
    candidate_system = (ROOT / 'candidate-system.txt').read_text()
    judge_system = (ROOT / 'judge-system.txt').read_text()
    directory = args.output or ROOT / 'runs' / time.strftime('%Y%m%d-%H%M%S')
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    spec = {'cases':selected, 'candidate_prompt':candidate_system, 'judge_prompt':judge_system,
            'seed':args.seed, 'candidates':{k:public_profile(v) for k,v in candidates.items()},
            'judge':public_profile(judge), 'rubric_weights':WEIGHTS, 'tie_threshold':.25, 'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'temperature':.3, 'max_tokens':512, 'judge_temperature':0, 'judge_max_tokens':4096}
    state = {'created_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'split':args.split,
             'fingerprint':hashlib.sha256(json.dumps(spec,ensure_ascii=False,sort_keys=True).encode()).hexdigest(),
             'spec':spec, 'candidate_names':args.candidates, 'judge':public_profile(judge),
             'self_judge_risk':any(judge['name']==c['name'] or judge['model']==c['model'] for c in candidates.values()),
             'results':[]}
    rng = random.Random(args.seed)
    for case in selected:
        row = {'id':case['id'], 'family':case['family'], 'candidates':{}, 'reviews':[]}
        state['results'].append(row)
        order = args.candidates.copy()
        rng.shuffle(order)
        for name in order:
            try:
                row['candidates'][name] = complete(candidates[name], [{'role':'system','content':candidate_system}] + case['messages'], .3, 512)
            except (RuntimeError, ValueError, KeyError) as exc:
                row['candidates'][name] = {'error':str(exc)}
            save(directory / 'results.json', state)
        if all('text' in row['candidates'][name] for name in args.candidates):
            for review_order in (order, list(reversed(order))):
                try:
                    review = adjudicate(case,row['candidates'],judge,judge_system,review_order)
                except (RuntimeError, ValueError, KeyError, TypeError) as exc:
                    review = {'order':review_order, 'error':str(exc)}
                row['reviews'].append(review)
                save(directory / 'results.json',state)
        print(case['id'] + ' completed', flush=True)
    summary = report(state,directory)
    print(json.dumps({'output':str(directory), 'outcomes':summary['outcomes']},ensure_ascii=False))
    if summary['outcomes']['failed']:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
