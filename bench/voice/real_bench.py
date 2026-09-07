"""Real transcripts -> streaming measurements -> Codex blind review -> cost/style report."""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import secrets
import statistics
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

from run import ROOT, WEIGHTS, FLAGS, load_env, profile, public_profile, save, weighted, score_winner


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def normalize_usage(raw):
    raw = raw or {}
    def number(value):
        return value if type(value) is int and value >= 0 else None
    prompt = number(raw.get('prompt_tokens'))
    output = number(raw.get('completion_tokens'))
    hit = number(raw.get('prompt_cache_hit_tokens'))
    if hit is None:
        hit = number((raw.get('prompt_tokens_details') or {}).get('cached_tokens'))
    miss = number(raw.get('prompt_cache_miss_tokens'))
    if miss is None and hit is not None and prompt is not None:
        miss = prompt - hit
    if hit is not None and miss is not None and (miss < 0 or prompt is None or hit + miss != prompt):
        raise ValueError('Inconsistent cache accounting')
    return {'input': prompt, 'cache_hit': hit, 'cache_miss': miss, 'output': output,
            'reasoning': number((raw.get('completion_tokens_details') or {}).get('reasoning_tokens')),
            'total': number(raw.get('total_tokens'))}


def rates_for(name, started_at, prices):
    if name == 'qwen': return 'standard', prices[name]['rates']
    local = datetime.fromisoformat(started_at).astimezone(ZoneInfo('Asia/Shanghai'))
    hour = local.hour + local.minute / 60
    band = 'peak' if local.weekday() < 5 and (9 <= hour < 12 or 14 <= hour < 18) else 'off_peak'
    return band, prices[name][band]


def charge(usage, rates):
    fields = ('cache_hit', 'cache_miss', 'output')
    components = {key: usage[key] * rates[key] / 1_000_000 if usage[key] is not None else None for key in fields}
    components['total'] = sum(components.values()) if all(v is not None for v in components.values()) else None
    return components


def stream(model, messages):
    body = {'model': model['model'], 'messages': messages, 'temperature': .3, 'max_tokens': 512,
            'stream': True, 'stream_options': {'include_usage': True}}
    body.update({'enable_thinking':False} if model['name']=='qwen' else {'thinking':{'type':'disabled'}})
    request = urllib.request.Request(model['url'] + '/chat/completions', data=json.dumps(body,ensure_ascii=False).encode(),
        headers={'Content-Type':'application/json','Authorization':'Bearer '+model['key']})
    started_at = datetime.now(timezone.utc).isoformat()
    start = time.perf_counter()
    first = None
    texts = []
    usage = None
    finish = None
    returned_model = None
    done = False
    error = None
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            for line in response:
                if time.perf_counter()-start > 90:
                    raise TimeoutError()
                if not line.startswith(b'data:'): continue
                data = line[5:].strip()
                if data == b'[DONE]':
                    done = True
                    break
                if not data: continue
                event = json.loads(data)
                if event.get('error'): raise ValueError('Provider stream error')
                if event.get('usage'): usage = event['usage']
                if event.get('model'): returned_model = event['model']
                for choice in event.get('choices',[]):
                    content = choice.get('delta',{}).get('content')
                    if isinstance(content,str) and content:
                        if first is None: first = (time.perf_counter()-start)*1000
                        texts.append(content)
                    if choice.get('finish_reason'): finish = choice['finish_reason']
    except urllib.error.HTTPError as exc:
        error = f'HTTP {exc.code}'
    except (urllib.error.URLError, TimeoutError): error = 'Network/TLS/timeout failure'
    except (ValueError, KeyError, TypeError): error = 'Malformed/error stream'
    elapsed = (time.perf_counter()-start)*1000
    if not error and (not done or finish != 'stop' or not texts):
        error = f'Incomplete reply: finish={finish}, done={done}'
    try:
        normalized = normalize_usage(usage)
    except ValueError:
        normalized = normalize_usage(None)
        error = error or 'Usage accounting inconsistent'
    return {'started_at':started_at,'text':''.join(texts),'raw_usage':usage,'usage':normalized,
            'ttft_ms':round(first,2) if first is not None else None,'duration_ms':round(elapsed,2),
            'finish_reason':finish,'returned_model':returned_model,'error':error}


def generate(args):
    cases = [json.loads(line) for line in args.cases.read_text().splitlines() if line.strip()]
    if not cases or len({c['id'] for c in cases}) != len(cases): raise ValueError('Empty/duplicate cases')
    for c in cases:
        if c.get('source_kind') != 'real_transcript_identity_redacted' or c['messages'][-1]['role']!='user':
            raise ValueError('Real cases must end on user and carry source provenance')
        if any(m['role'] not in ('user','assistant') for m in c['messages']): raise ValueError('Unexpected role')
    models = {k:profile(k,load_env()) for k in ('qwen','deepseek')}
    prices = json.loads((ROOT/'prices-2026-09-07.json').read_text())
    if any(v['model']!=prices[k]['model'] for k,v in models.items()): raise ValueError('Price/model mismatch')
    if models['qwen']['url'] != 'https://dashscope.aliyuncs.com/compatible-mode/v1':
        raise ValueError('Price snapshot is for Qwen mainland endpoint only')
    system = (ROOT/'candidate-system.txt').read_text()
    args.output.mkdir(parents=True,exist_ok=False,mode=0o700)
    spec = {'cases':cases,'system_prompt':system,'models':{k:public_profile(v) for k,v in models.items()},
            'temperature':.3,'max_tokens':512,'thinking':'off','repeats':args.repeats,'seed':args.seed,
            'prices':prices,'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    state = {'fingerprint':digest(spec),'spec':spec,'calls':[]}
    rng = random.Random(args.seed)
    for repeat in range(1,args.repeats+1):
        for case in cases:
            order=list(models)
            rng.shuffle(order)
            for name in order:
                result=stream(models[name],[{'role':'system','content':system}]+case['messages'])
                band,rates=rates_for(name,result['started_at'],prices)
                state['calls'].append({'case_id':case['id'],'repeat':repeat,'provider':name,**result,
                                       'price_band':band,'rates':rates,'cost_cny':charge(result['usage'],rates)})
                save(args.output/'calls.json',state)
            print(f"repeat {repeat} {case['id']} done",flush=True)
    blind=[]
    mapping={}
    for case in cases:
        pair=[c for c in state['calls'] if c['case_id']==case['id'] and c['repeat']==1]
        if len(pair)!=2 or any(c['error'] for c in pair):continue
        secrets.SystemRandom().shuffle(pair)
        mapping[case['id']]={label:c['provider'] for label,c in zip(('A','B'),pair)}
        blind.append({'id':case['id'],'history_omitted':case['history_omitted'],'messages':case['messages'],
                      'A':pair[0]['text'],'B':pair[1]['text']})
    package={'run_fingerprint':state['fingerprint'],'system_prompt':system,'cases':blind}
    package['fingerprint']=digest(package)
    save(args.output/'blind-review.json',package)
    save(args.output/'mapping.json',mapping)
    print(f'Prepared {len(blind)} blind cases; review blind-review.json before opening mapping/calls.')


def percentile(values,p):
    if not values:return None
    values=sorted(values)
    x=(len(values)-1)*p
    lower=int(x)
    upper=min(lower+1,len(values)-1)
    return values[lower]+(values[upper]-values[lower])*(x-lower)


def summarize_calls(calls):
    result={}
    for name in ('qwen','deepseek'):
        rows=[c for c in calls if c['provider']==name]
        good=[c for c in rows if not c['error']]
        sums={key:sum(c['usage'][key] for c in rows if c['usage'][key] is not None) for key in ('input','cache_hit','cache_miss','output')}
        missing={key:sum(c['usage'][key] is None for c in rows) for key in sums}
        costs={key:sum(c['cost_cny'][key] for c in rows if c['cost_cny'][key] is not None) for key in ('cache_hit','cache_miss','output','total')}
        latency={key:{'mean':statistics.mean(v) if v else None,'p50':percentile(v,.5),'p95':percentile(v,.95)}
                 for key in ('ttft_ms','duration_ms') for v in [[c[key] for c in good if c[key] is not None]]}
        result[name]={'calls':len(rows),'success':len(good),'tokens':sums,'missing_usage_calls':missing,
                      'unpriced_calls':sum(c['cost_cny']['total'] is None for c in rows),'known_cost_cny':costs,
                      'cache_hit_ratio':sums['cache_hit']/sums['input'] if sums['input'] and not any(missing[k] for k in ('input','cache_hit')) else None,
                      'latency':latency}
    return result


def validate_reviews(review,blind):
    if review['fingerprint']!=blind['fingerprint']:raise ValueError('Review fingerprint mismatch')
    ids=[r['id'] for r in review['reviews']]
    if len(ids)!=len(set(ids)) or set(ids)!={c['id'] for c in blind['cases']}:raise ValueError('Missing/extra/duplicate reviews')
    for row in review['reviews']:
        for label in ('A','B'):
            item=row[label]
            if set(item['scores'])!=set(WEIGHTS) or set(item['evidence'])!=set(WEIGHTS):raise ValueError('Invalid dimensions')
            if any(type(v)is not int or not 1<=v<=5 for v in item['scores'].values()):raise ValueError('Invalid scores')
            if any(not isinstance(v,str) or not v.strip() for v in item['evidence'].values()):raise ValueError('Missing evidence')
            if not isinstance(item['critical_flags'],list) or any(f not in FLAGS for f in item['critical_flags']):raise ValueError('Invalid flag')
        if not row.get('comparison'):raise ValueError('Missing comparison')


def finalize(args):
    directory=args.output
    state=json.loads((directory/'calls.json').read_text())
    blind=json.loads((directory/'blind-review.json').read_text())
    review=json.loads((directory/'codex-review.json').read_text())
    mapping=json.loads((directory/'mapping.json').read_text())
    if digest(state['spec'])!=state['fingerprint'] or state['fingerprint']!=blind['run_fingerprint']:
        raise ValueError('Run mismatch')
    if digest({k:v for k,v in blind.items() if k!='fingerprint'})!=blind['fingerprint']:
        raise ValueError('Blind package was modified')
    for item in blind['cases']:
        if set(mapping[item['id']])!={'A','B'} or set(mapping[item['id']].values())!={'qwen','deepseek'}:
            raise ValueError('Invalid identity mapping')
        for label in ('A','B'):
            first=[c for c in state['calls'] if c['case_id']==item['id'] and c['repeat']==1 and c['provider']==mapping[item['id']][label]]
            if len(first)!=1 or first[0]['text']!=item[label]:raise ValueError('Reply/mapping mismatch')
    validate_reviews(review,blind)
    summaries=summarize_calls(state['calls'])
    case_map={c['id']:c for c in state['spec']['cases']}
    scored=[]
    for row in review['reviews']:
        winner=score_winner(row['A']['scores'],row['B']['scores'])
        scored.append({'id':row['id'],'winner':winner if winner=='tie' else mapping[row['id']][winner],
                       'scores':{mapping[row['id']][label]:weighted(row[label]['scores']) for label in ('A','B')},
                       'comparison':row['comparison']})
    quality={}
    for name in ('qwen','deepseek'):
        groups={}
        for row in scored:groups.setdefault(case_map[row['id']]['session_group'],[]).append(row['scores'][name])
        quality[name]={'case_mean':statistics.mean(r['scores'][name] for r in scored) if scored else None,
                       'session_macro':statistics.mean(statistics.mean(v) for v in groups.values()) if groups else None,
                       'wins':sum(r['winner']==name for r in scored)}
    save(directory/'summary.json',{'measurement':summaries,'quality':quality,'scored_cases':scored})
    fields=['case_id','repeat','provider','started_at','price_band','input','cache_hit','cache_miss','output','reasoning','total','ttft_ms','duration_ms','input_hit_cost','input_miss_cost','output_cost','total_cost','error']
    with (directory/'per-call.csv').open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=fields);writer.writeheader()
        for c in state['calls']:
            writer.writerow({**{k:c[k] for k in ('case_id','repeat','provider','started_at','price_band','ttft_ms','duration_ms','error')},**c['usage'],
                'input_hit_cost':c['cost_cny']['cache_hit'],'input_miss_cost':c['cost_cny']['cache_miss'],'output_cost':c['cost_cny']['output'],'total_cost':c['cost_cny']['total']})
    lines=['# 真实语音对话模型评测 · Codex 盲评','',
        f"{len(case_map)}个真实回合 / {len({c['session_group'] for c in case_map.values()})}场对话 / {len({c['user_group'] for c in case_map.values()})}个账号；本次实际 {len(case_map)} 题，每模型 {state['spec']['repeats']} 次生成。",'',
        '输入来自只读数据库提取，最多4条前文；除姓名占位替换外保留原始断句、重复和歧义。语音诊断是会话级证据，不是音频逐条核验。仅普通访谈模式，不代表全部用户。',
        '评分由当前 Codex 会话按匿名 A/B 单次完成，先锁分再解盲。未做独立双评/换序复评，不声称优于人工。质量评分只看第一轮生成；第二轮用于重复测量。',
        '统一访谈提示词、temperature=0.3、输出上限512、关闭思考；候选看不到评分标准。文本环境没有回忆录读写工具。未回放完整历史、未接Pi工具、ASR或TTS，因此不是端到端语音质量测试。', '',
        '## 质量概览','', '|模型|题目均分 /5|会话等权均分 /5|胜出题数|','|---|---:|---:|---:|']
    for name,q in quality.items():lines.append(f"|{name}|{q['case_mean']:.2f}|{q['session_macro']:.2f}|{q['wins']}|")
    lines += ['',f"平局 {sum(r['winner']=='tie' for r in scored)} 题。近邻题同源相关，分数只描述本样本，不作统计显著性结论。",'',
        '## Token与费用（所有重复调用）','', '|模型|完整响应/调用|输入|缓存命中|未命中|输出|命中比例|命中费¥|未命中费¥|输出费¥|合计¥|', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for name,s in summaries.items():
        t=s['tokens'];c=s['known_cost_cny'];ratio=s['cache_hit_ratio']
        ratio_text=f'{ratio:.1%}' if ratio is not None else '未知'
        lines.append(f"|{name}|{s['success']}/{s['calls']}|{t['input']}|{t['cache_hit']}|{t['cache_miss']}|{t['output']}|{ratio_text}|{c['cache_hit']:.6f}|{c['cache_miss']:.6f}|{c['output']:.6f}|{c['total']:.6f}|")
        if s['unpriced_calls'] or any(s['missing_usage_calls'].values()):lines.append(f"\n{name} 有缺失计量，以上为已知部分，不能当完整账单：{s['missing_usage_calls']}，未定价调用 {s['unpriced_calls']}。\n")
    lines += ['', '每次费用 = (缓存命中Token×命中单价 + 未命中Token×输入单价 + 输出Token×输出单价) ÷ 1,000,000。输入已含缓存命中，不重复相加。reasoning为输出中的细分字段，未上报留空，不能再次叠加计费。',
        '缓存是厂商usage报告的上下文缓存命中，不是客户端直接检测GPU KV cache。本次无显式缓存创建API，不收取额外显式创建费用；缺失缓存字段不按0处理。', '',
        '官网价查询日期2026-09-07，人民币/百万Token：', '',
        '|模型/时段|命中输入|未命中输入|输出|','|---|---:|---:|---:|',
        '|千问 北京|0.1|0.8|2.7|','|DeepSeek 空闲|0.05|1.5|4.5|','|DeepSeek 高峰|0.1|3.0|9.0|', '',
        '来源：[千问官网](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[DeepSeek官网](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。DeepSeek高峰为北京时间工作日9–12、14–18点，本次按每次客户端请求开始时间归档；边界时刻以账单为准。旧项目静态价格未用于本报告。优惠/套餐/赠额未扣除。', '',
        'Codex评分没有额外调用候选API judge；Codex当前会话自身的精确Token/费用不可从本工具取得，不能记为零。上表仅候选模型API费用，不含开发过程、旧版试评、ASR/TTS或网络基础设施。', '',
        '## 耗时','', '|模型|平均首字秒|P50首字秒|P95首字秒|平均完整秒|P50完整秒|P95完整秒|','|---|---:|---:|---:|---:|---:|---:|']
    for name,s in summaries.items():
        vals=[s['latency'][k][p] for k in ('ttft_ms','duration_ms') for p in ('mean','p50','p95')]
        lines.append('|'+name+'|'+'|'.join(f'{v/1000:.3f}' if v is not None else '未知' for v in vals)+'|')
    lines += ['', '首字=本地发起请求到首个非空content分片，完整=收到结束标记；包含网络与服务端排队。串行请求、每题随机模型顺序，同机同窗口重复测量，无并发压测。P95为小样本线性插值，不是SLA。未使用TLS连接池，含建连开销；不是首音延迟。', '',
        '## 每轮成本与重复测量','', '|轮次|模型|调用|输入|命中|输出|费用¥|平均首字秒|平均完整秒|','|---|---|---:|---:|---:|---:|---:|---:|---:|']
    for repeat in range(1,state['spec']['repeats']+1):
        for name,s in summarize_calls([c for c in state['calls'] if c['repeat']==repeat]).items():
            lines.append(f"|{repeat}|{name}|{s['calls']}|{s['tokens']['input']}|{s['tokens']['cache_hit']}|{s['tokens']['output']}|{s['known_cost_cny']['total']:.6f}|{s['latency']['ttft_ms']['mean']/1000:.3f}|{s['latency']['duration_ms']['mean']/1000:.3f}|")
    lines += ['', '### 价格时段拆分', '', '|模型|时段|调用数|命中Token|未命中Token|输出Token|费用¥|', '|---|---|---:|---:|---:|---:|---:|']
    for name in ('qwen','deepseek'):
        for band in sorted({c['price_band'] for c in state['calls'] if c['provider']==name}):
            rows=[c for c in state['calls'] if c['provider']==name and c['price_band']==band]
            totals=summarize_calls(rows)[name]
            t=totals['tokens']
            lines.append(f"|{name}|{band}|{len(rows)}|{t['cache_hit']}|{t['cache_miss']}|{t['output']}|{totals['known_cost_cny']['total']:.6f}|")
    started=[datetime.fromisoformat(c['started_at']) for c in state['calls']]
    lines += ['', f"实际请求窗口（北京时间）：{min(started).astimezone(ZoneInfo('Asia/Shanghai')).isoformat()} 至 {max(started).astimezone(ZoneInfo('Asia/Shanghai')).isoformat()}。"]
    ds=[c for c in state['calls'] if c['provider']=='deepseek']
    if len({c['price_band'] for c in ds})>1:
        lines += ['', '**本次跨越DeepSeek高峰/空闲切换，第二轮费用下降同时受缓存与单价变化影响，不能全归因于缓存。**']
    if not summaries['deepseek']['unpriced_calls']:
        normalized={band:sum(charge(c['usage'],state['spec']['prices']['deepseek'][band])['total'] for c in ds) for band in ('peak','off_peak')}
        lines += ['', f"固定实际Token和命中情况，把DeepSeek全部请求统一为高峰价是 ¥{normalized['peak']:.6f}，统一为空闲价是 ¥{normalized['off_peak']:.6f}。这是价格归一化反事实，用于区分价格时段的影响；不是另一次实测。"]
    lines += ['', '第二轮重复相同上下文，但共享前缀/厂商调度可影响两轮缓存，不能把第一轮叫纯冷缓存、第二轮叫必定热缓存。', '', '按本样本长度与命中分布进行量级外推（不是月账单预测）：','']
    for name,s in summaries.items():
        if not s['unpriced_calls'] and s['calls']:
            lines.append(f"- {name}：每次平均 ¥{s['known_cost_cny']['total']/s['calls']:.6f}；1000次同类回复约 ¥{s['known_cost_cny']['total']/s['calls']*1000:.3f}。")
    lines += ['', '## 人工体感：真实输入与两种完整回复','', '以下展示第一轮全部案例，避免只挑好看的例子。省略前文时需结合 blind-review.json 查看；质量评论为Codex主观评审，欢迎人工改判。','']
    blind_map={c['id']:c for c in blind['cases']}
    for row in review['reviews']:
        c=blind_map[row['id']]
        lines += [f"### {row['id']}", '', '用户真实输入（仅身份脱敏）：','',c['messages'][-1]['content'],'']
        for label in ('A','B'):
            name=mapping[row['id']][label]
            lines += [f"**{name}（匿名{label}） · {weighted(row[label]['scores']):.2f}/5**",'', c[label],'']
        lines += ['Codex点评：'+row['comparison'],'']
    findings=directory/'findings.md'
    if findings.exists():
        lines[2:2]=[findings.read_text(), '']
    (directory/'report.md').write_text('\n'.join(lines)+'\n')
    print('Finalized '+str(directory/'report.md'))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('command',choices=['generate','finalize'])
    p.add_argument('--cases',type=Path,default=Path('.bench-private/voice-real/cases.jsonl'))
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--repeats',type=int,default=2)
    p.add_argument('--seed',type=int,default=20260907)
    args=p.parse_args()
    if not 1<=args.repeats<=5:p.error('repeats must be 1..5')
    if args.command=='generate':generate(args)
    else:finalize(args)


if __name__=='__main__':main()
