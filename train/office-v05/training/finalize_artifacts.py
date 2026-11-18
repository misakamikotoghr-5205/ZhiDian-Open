"""Hash successful training/export outputs and produce portable provenance."""
import hashlib,importlib.metadata,json,pathlib,sys,time
ROOT=pathlib.Path(__file__).resolve().parent.parent
BUILD=ROOT/'model-build';OUT=BUILD/'office-small-lora'
report=json.loads((OUT/'run-report.json').read_text(encoding='utf-8'))
assert report.get('training',{}).get('steps',0)>0 and report.get('finished_at'),'Training did not finish'
assert report.get('base',{}).get('count')==report.get('lora',{}).get('count'),'Missing paired evaluation'
report['merged_hf_directory']='model-build/office-small-merged'
report['package_versions']={name:importlib.metadata.version(name) for name in ['torch','transformers','peft','accelerate','numpy']}
report['python']=sys.version.split()[0]
report['training']['examples_seen']=report['training']['steps']*report['training']['gradient_accumulation']
(OUT/'run-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
config=json.loads((OUT/'adapter_config.json').read_text(encoding='utf-8'))
config['base_model_name_or_path']='Qwen/Qwen3.5-0.8B'
config['revision']='2fc06364715b967f1860aea9cf38778875588b17'
(OUT/'adapter_config.json').write_text(json.dumps(config,ensure_ascii=False,indent=2),encoding='utf-8')
files={}
for name in ['office-small-lora.gguf','Qwen3.5-0.8B-office-Q4_K_M.gguf','office-small-lora/adapter_model.safetensors','office-small-lora/adapter_config.json','office-small-lora/run-report.json']:
    path=BUILD/name
    assert path.is_file(),f'Missing export {name}'
    if name.endswith('.gguf'):
        with path.open('rb') as inp:assert inp.read(4)==b'GGUF',f'Not a GGUF file: {name}'
    with path.open('rb') as inp:digest=hashlib.file_digest(inp,'sha256').hexdigest()
    files[name]={'size':path.stat().st_size,'sha256':digest}
manifest={
    'name':'Zhidian office action adapter v0.5',
    'base_model':'Qwen/Qwen3.5-0.8B','base_revision':report['base_revision'],
    'base_license':'Apache-2.0','base_source':'https://huggingface.co/Qwen/Qwen3.5-0.8B',
    'converter_commit':'cd959bae99ff4bed22bef2604f45241c09bbb8c8','quantization':'Q4_K_M',
    'model_size':'0.8B','lora_rank':report['rank'],'trained_on':report['gpu'],
    'training':report['training'],'dataset':report['dataset'],
    'evaluation':{key:report[key] for key in ['base','lora','evaluation_notes']+[k for k in report if k.startswith('runtime_')]},
    'files':files,'generated_at':time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    'limitations':['Only synthetic bounded action routing was trained and evaluated.','No OCR, screen grounding, document layout or general reasoning benchmark was performed.','The bundled 4B model is the original quantized upstream model; it was not LoRA trained.'],
    'integration':{'adapter':'office-small-lora.gguf','merged_quantized':'Qwen3.5-0.8B-office-Q4_K_M.gguf','pointer_adapter':False,'do_not_apply_adapter_to_merged_model':True}}
(BUILD/'office-small-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
(OUT/'README.md').write_text(f'''# Zhidian office action LoRA v0.5

Base: Qwen/Qwen3.5-0.8B, revision `{report['base_revision']}`, Apache-2.0.
Rank {report['rank']} LoRA, {report['trainable_parameters']:,} trainable parameters.
Actually trained on {report['gpu']} for {report['training']['steps']} optimizer steps
using 368 synthetic Chinese training requests. No private documents were used.

On the same 76 heldout synthetic examples:

| Metric | Base BF16 | LoRA BF16 |
| --- | ---: | ---: |
| Action IDs correct | {report['base']['action_ids_correct']}/76 | {report['lora']['action_ids_correct']}/76 |
| Actions and meaningful parameters correct | {report['base']['execution_equivalent']}/76 | {report['lora']['execution_equivalent']}/76 |
| Strict JSON | {report['base']['strict_json']}/76 | {report['lora']['strict_json']}/76 |

This is bounded office action routing, not general office reasoning. Known errors
remain, especially PDF extraction versus page splitting and choosing a related
action when the requested capability is unavailable. Keep application capability
validation, deterministic routing and confirmation before file changes.

The adapter does not train OCR, screenshot grounding, presentation layouts, or
the larger 4B model. The model's existing vision encoder/projector is unchanged.
GGUF deployment checks and every raw response are in `runtime-*.json`; the
paired Transformers results are in `eval-base.json` and `eval-lora.json`.
`run-report.json` records actual metrics and hardware. Reproduction code is in
the sibling project's `training` directory; use its pinned dependencies and data.
''',encoding='utf-8')
print(json.dumps(files,ensure_ascii=False,indent=2))
