"""Load a produced GGUF with the real bundled llama.cpp runtime and run fixtures."""
import argparse,json,os,pathlib,socket,subprocess,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('--runtime',required=True);p.add_argument('--model',required=True);p.add_argument('--adapter');p.add_argument('--label',required=True);p.add_argument('--all',action='store_true');args=p.parse_args()
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
out=ROOT/'model-build/office-small-lora';log_path=out/f'runtime-{args.label}.log'
command=[args.runtime,'--model',args.model,'--ctx-size','2048','--n-gpu-layers','0','--threads','4','--parallel','1','--port',str(port),'--host','127.0.0.1','--no-webui']
if args.adapter:command+=['--lora',args.adapter]
rows=[json.loads(line) for line in (ROOT/'training/data/eval.jsonl').read_text(encoding='utf-8').splitlines()]
fixtures=[next(r for r in rows if r['expected'] and r['expected'][0]['actionId']=='pdf.extract'),next(r for r in rows if not r['expected']),next(r for r in rows if r['expected'] and r['expected'][0]['actionId']=='sheets.merge')]
if args.all:fixtures=rows
results=[];started=time.time()
with log_path.open('w',encoding='utf-8') as log:
    process=subprocess.Popen(command,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    try:
        for _ in range(180):
            if process.poll() is not None:raise RuntimeError(f'Runtime exited {process.returncode}; inspect {log_path}')
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=2) as response:
                    if response.status==200:break
            except Exception:time.sleep(1)
        else:raise RuntimeError('Runtime never became ready')
        for row in fixtures:
            body={'messages':[{'role':'system','content':row['system']},{'role':'user','content':row['user']}],'temperature':0,'max_tokens':112,'seed':583,'chat_template_kwargs':{'enable_thinking':False}}
            request=urllib.request.Request(f'http://127.0.0.1:{port}/v1/chat/completions',data=json.dumps(body,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(request,timeout=180) as response:completion=json.load(response)
            raw=completion['choices'][0]['message'].get('content','')
            try:actual=json.loads(raw.strip().split('</think>')[-1].strip().removeprefix('```json').removesuffix('```').strip())['steps']
            except Exception:actual=None
            result={'id':row['id'],'expected':row['expected'],'actual':actual,'correct':actual==row['expected'],'raw':raw,'finish_reason':completion['choices'][0].get('finish_reason')}
            results.append(result);print(f'{args.label} {len(results)}/{len(fixtures)} correct={result["correct"]}' if args.all else json.dumps(result,ensure_ascii=False),flush=True)
    finally:
        process.terminate()
        try:process.wait(timeout=20)
        except subprocess.TimeoutExpired:process.kill();process.wait()
report={'label':args.label,'model':pathlib.Path(args.model).name,'adapter':pathlib.Path(args.adapter).name if args.adapter else None,'runtime_build':'b12110','cpu_only':True,'count':len(results),'correct':sum(r['correct'] for r in results),'seconds':time.time()-started,'cases':results}
(out/f'runtime-{args.label}.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
assert len(results)==len(fixtures),'Missing GGUF results'
if not args.all:assert all(r['correct'] for r in results),'GGUF fixture mismatch; inspect actual result'
