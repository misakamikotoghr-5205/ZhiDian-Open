"""GPU LoRA supervised tuning on synthetic bounded office action plans.
Runs baseline/final heldout generation, saves PEFT adapter and merged HF weights.
No results are precomputed; run-report.json is emitted from the actual execution.
"""
import argparse, gc, hashlib, json, os, pathlib, random, time
ROOT=pathlib.Path(__file__).resolve().parent.parent
for key,sub in [('HF_HOME','huggingface'),('TORCH_HOME','torch'),('TRITON_CACHE_DIR','triton')]:
    os.environ[key]=str(ROOT/'training'/'cache'/sub)
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1'
import torch
from transformers import AutoTokenizer, AutoModelForImageTextToText
from peft import LoraConfig, get_peft_model

parser=argparse.ArgumentParser();parser.add_argument('--steps',type=int,default=96);parser.add_argument('--eval-count',type=int,default=32);parser.add_argument('--rank',type=int,default=8)
args=parser.parse_args()
BASE=ROOT/'model-build'/'base-small';OUT=ROOT/'model-build'/'office-small-lora';OUT.mkdir(exist_ok=True)
MERGED=ROOT/'model-build'/'office-small-merged'
random.seed(583);torch.manual_seed(583)
assert torch.cuda.is_available(),'Actual CUDA GPU required'
torch.backends.cuda.matmul.allow_tf32=True
torch.set_num_threads(4)
device=torch.device('cuda')
report={'base_model':'Qwen/Qwen3.5-0.8B','base_revision':'2fc06364715b967f1860aea9cf38778875588b17',
        'training_source':'synthetic office tasks only','dataset':json.loads((ROOT/'training/data/manifest.json').read_text(encoding='utf-8')),
        'gpu':torch.cuda.get_device_name(0),'torch':torch.__version__,'cuda':torch.version.cuda,'seed':583,'train_steps_requested':args.steps,'rank':args.rank,'started_at':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
def save_report():
    (OUT/'run-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
save_report();print(json.dumps({k:report[k] for k in ['gpu','torch','cuda']},ensure_ascii=False),flush=True)
tokenizer=AutoTokenizer.from_pretrained(BASE,local_files_only=True)
tokenizer.pad_token=tokenizer.eos_token
def read_split(name):return [json.loads(line) for line in (ROOT/f'training/data/{name}.jsonl').read_text(encoding='utf-8').splitlines()]
train=read_split('train');validation=read_split('eval')
def prompt(row):
    return tokenizer.apply_chat_template([{'role':'system','content':row['system']},{'role':'user','content':row['user']}],tokenize=False,add_generation_prompt=True,enable_thinking=False)
encoded=[]
for row in train:
    p=tokenizer.encode(prompt(row),add_special_tokens=False)
    a=tokenizer.encode(row['answer']+tokenizer.eos_token,add_special_tokens=False)
    encoded.append((p+a,len(a)))
report['sequence_lengths']={'max':max(len(x[0]) for x in encoded),'mean':sum(len(x[0]) for x in encoded)/len(encoded)}
print('SEQUENCES',report['sequence_lengths'],flush=True)
model=AutoModelForImageTextToText.from_pretrained(BASE,dtype=torch.bfloat16,local_files_only=True,attn_implementation='sdpa').to(device)
print('MODEL LOADED',torch.cuda.memory_allocated()/2**20,flush=True)
# Keep every module on CUDA: generation selects its input device from the first
# model parameter (the vision encoder), even for text-only office tasks.
torch.cuda.empty_cache()
def parse_plan(raw):
    try:
        result=json.loads(raw.strip().split('</think>')[-1].strip().removeprefix('```json').removesuffix('```').strip())
        assert isinstance(result.get('message'),str) and isinstance(result.get('steps'),list)
        return result['steps']
    except Exception:return None
def evaluate(label):
    model.eval();model.config.use_cache=True
    results=[];start=time.time()
    for i,row in enumerate(validation[:args.eval_count]):
        ids=tokenizer(prompt(row),return_tensors='pt').to(device)
        with torch.inference_mode():
            generated=model.generate(**ids,max_new_tokens=112,do_sample=False,use_cache=True,pad_token_id=tokenizer.pad_token_id)
        raw=tokenizer.decode(generated[0,ids.input_ids.shape[1]:],skip_special_tokens=True)
        parsed=parse_plan(raw)
        expected=row['expected'];correct=parsed==expected
        results.append({'id':row['id'],'expected':expected,'actual':parsed,'correct':correct,'raw':raw})
        print(f'EVAL {label} {i+1}/{min(args.eval_count,len(validation))} correct={correct}',flush=True)
        del ids,generated
    result={'count':len(results),'correct':sum(x['correct'] for x in results),'valid_json':sum(x['actual'] is not None for x in results),'seconds':time.time()-start,'cases':results}
    (OUT/f'eval-{label}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    report[label]={k:v for k,v in result.items() if k!='cases'};save_report();return result
evaluate('base')
targets=[name for name,module in model.named_modules() if isinstance(module,torch.nn.Linear) and '.language_model.layers.' in name and name.rsplit('.',1)[-1] in ['q_proj','v_proj','in_proj_qkv','out_proj']]
assert targets,'No text LoRA targets found'
report['target_modules']=targets
model=get_peft_model(model,LoraConfig(r=args.rank,lora_alpha=args.rank*2,lora_dropout=.05,target_modules=targets,bias='none',task_type='CAUSAL_LM'))
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant':False})
model.enable_input_require_grads();model.config.use_cache=False;model.train()
parameters=[p for p in model.parameters() if p.requires_grad]
report['trainable_parameters']=sum(p.numel() for p in parameters)
optimizer=torch.optim.AdamW(parameters,lr=2e-4,weight_decay=.01)
random.shuffle(encoded);start=time.time();losses=[];optimizer.zero_grad(set_to_none=True)
accum=4
for step in range(args.steps):
    current=[]
    for micro in range(accum):
        ids,answer_len=encoded[(step*accum+micro)%len(encoded)]
        batch=torch.tensor([ids],device=device)
        # Project only response tokens to the very large vocabulary, saving VRAM.
        output=model(input_ids=batch,attention_mask=torch.ones_like(batch),use_cache=False,logits_to_keep=answer_len+1)
        logits=output.logits[:,:-1,:].float()
        labels=batch[:,-answer_len:]
        loss=torch.nn.functional.cross_entropy(logits.reshape(-1,logits.shape[-1]),labels.reshape(-1))
        (loss/accum).backward();current.append(loss.item())
        del output,logits,labels,batch,loss
    torch.nn.utils.clip_grad_norm_(parameters,1.0)
    optimizer.step();optimizer.zero_grad(set_to_none=True)
    losses.append(sum(current)/len(current))
    if step%4==0 or step+1==args.steps:
        row={'step':step+1,'loss':losses[-1],'seconds':round(time.time()-start,2),'gpu_peak_mb':round(torch.cuda.max_memory_allocated()/2**20)}
        print('TRAIN',json.dumps(row),flush=True)
        with (OUT/'training-log.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps(row)+'\n')
    if (step+1)%32==0:model.save_pretrained(OUT)
model.save_pretrained(OUT);tokenizer.save_pretrained(OUT)
report['training']={'steps':len(losses),'micro_batch':1,'gradient_accumulation':accum,'learning_rate':2e-4,'loss_first':losses[0],'loss_last':losses[-1],'seconds':time.time()-start,'gpu_peak_mb':torch.cuda.max_memory_allocated()/2**20}
save_report()
model.gradient_checkpointing_disable();gc.collect();torch.cuda.empty_cache()
evaluate('lora')
print('MERGING',flush=True)
model=model.to('cpu');model=model.merge_and_unload();model.save_pretrained(MERGED,safe_serialization=True)
tokenizer.save_pretrained(MERGED)
for name in ['preprocessor_config.json','video_preprocessor_config.json','chat_template.jinja','LICENSE']:
    if (BASE/name).exists():(MERGED/name).write_bytes((BASE/name).read_bytes())
report['finished_at']=time.strftime('%Y-%m-%dT%H:%M:%S%z');report['merged_hf_directory']=str(MERGED.relative_to(ROOT));save_report()
print('FINISHED',str(OUT),flush=True)
