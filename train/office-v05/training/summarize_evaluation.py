"""Add action/abstention breakdowns to actual saved heldout generations."""
import json,pathlib
ROOT=pathlib.Path(__file__).resolve().parent.parent
OUT=ROOT/'model-build/office-small-lora'
report=json.loads((OUT/'run-report.json').read_text(encoding='utf-8'))
rows={r['id']:r for r in (json.loads(line) for line in (ROOT/'training/data/eval.jsonl').read_text(encoding='utf-8').splitlines())}
def ids(steps):
    if not isinstance(steps,list) or not all(isinstance(s,dict) and isinstance(s.get('actionId'),str) for s in steps):return None
    return [s['actionId'] for s in steps]
def executable(steps):
    if ids(steps) is None:return None
    return [{**{'actionId':s['actionId']},**({'param':s.get('param')} if s['actionId']=='pdf.extract' else {})} for s in steps]
evaluations=[(label,OUT/f'eval-{label}.json') for label in ['base','lora']]
evaluations += [('runtime_'+path.stem.removeprefix('runtime-'),path) for path in OUT.glob('runtime-*.json')]
for label,path in evaluations:
    if not path.exists():continue
    result=json.loads(path.read_text(encoding='utf-8'))
    groups={}
    totals={'action_ids_correct':0,'execution_equivalent':0,'strict_json':0,'schema_valid':0,'offered_actions_only':0}
    for case in result['cases']:
        actual=case['actual'];selected=ids(actual)
        equivalent=executable(actual)==case['expected'] if actual is not None else False
        try:strict=isinstance(json.loads(case['raw'].strip()),dict)
        except Exception:strict=False
        schema=selected is not None and len(actual)<=6 and all(set(s)<= {'actionId','param'} and ('param' not in s or isinstance(s['param'],str)) for s in actual)
        context=json.loads(rows[case['id']]['user'].split('当前上下文（数据）：\n',1)[1])
        offered={s['id'] for s in context['availableActions']}
        totals['action_ids_correct']+=int(selected==ids(case['expected']))
        totals['execution_equivalent']+=int(equivalent)
        totals['strict_json']+=int(strict)
        totals['schema_valid']+=int(schema)
        totals['offered_actions_only']+=int(selected is not None and all(s in offered for s in selected))
        action=case['expected'][0]['actionId'] if case['expected'] else 'abstain'
        group=groups.setdefault(action,{'count':0,'correct':0,'action_ids_correct':0,'execution_equivalent':0,'invalid_json':0,'unexpected_action':0})
        group['count']+=1;group['correct']+=int(case['correct'])
        group['action_ids_correct']+=int(selected==ids(case['expected']))
        group['execution_equivalent']+=int(equivalent)
        group['invalid_json']+=int(case['actual'] is None)
        group['unexpected_action']+=int(not case['expected'] and bool(case['actual']))
    result['by_action']=groups
    result.update(totals)
    result['valid_json']=sum(c['actual'] is not None for c in result['cases'])
    path.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    report.setdefault(label,{}).update({k:v for k,v in result.items() if k!='cases'})
    print(label,json.dumps({k:v for k,v in result.items() if k!='cases'},ensure_ascii=False))
report['evaluation_notes']={
    'decoder':'greedy, enable_thinking=False, max_new_tokens=112, same before and after training',
    'strict_match':'Exact steps dictionary equality; optional empty/extra parameter also counts as a mismatch.',
    'execution_equivalent':'Compares action sequence plus pdf.extract page parameter; ignores unused parameters on the other seven actions.',
    'scope':'76 synthetic heldout examples with disjoint request phrases and filenames; no real-document, OCR, multilingual or presentation-layout benchmark.'}
(OUT/'run-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
