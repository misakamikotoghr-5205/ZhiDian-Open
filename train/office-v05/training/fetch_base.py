import concurrent.futures, hashlib, json, os, pathlib, subprocess, sys, time, urllib.request
ROOT = pathlib.Path(__file__).resolve().parent.parent
MODEL = 'Qwen/Qwen3.5-0.8B'
REVISION = '2fc06364715b967f1860aea9cf38778875588b17'
DEST = ROOT / 'model-build' / 'base-small'
DEST.mkdir(parents=True, exist_ok=True)
with urllib.request.urlopen(f'https://huggingface.co/api/models/{MODEL}/revision/{REVISION}?blobs=true', timeout=60) as response:
    metadata = json.load(response)
(DEST / 'source.json').write_text(json.dumps({'model':MODEL,'revision':REVISION,'license':'apache-2.0','files':metadata['siblings']},ensure_ascii=False,indent=2),encoding='utf-8')
def download(entry):
    name = entry['rfilename']
    if name.startswith('.') or name == 'README.md': return
    target = DEST / name
    expected = entry.get('lfs',{}).get('sha256')
    if target.exists() and target.stat().st_size == entry.get('size'):
        correct = hashlib.file_digest(target.open('rb'),'sha256').hexdigest() == expected if expected else hashlib.sha1(f'blob {target.stat().st_size}\0'.encode()+target.read_bytes()).hexdigest() == entry['blobId']
        if correct:
            print('EXISTS', name, flush=True); return
    if entry['size'] > 64*1024*1024 and expected:
        host=os.environ.get('HF_DOWNLOAD_HOST','huggingface.co')
        subprocess.run([sys.executable,str(ROOT/'training/parallel_download.py'),f'https://{host}/{MODEL}/resolve/{REVISION}/{name}',str(target),str(entry['size']),expected],check=True)
        return
    part = target.with_name(target.name+'.download')
    for attempt in range(3):
        host = 'huggingface.co' if attempt != 1 else 'hf-mirror.com'
        try:
            digest=hashlib.sha256(); count=0; started=time.time(); last=0
            req=urllib.request.Request(f'https://{host}/{MODEL}/resolve/{REVISION}/{name}?download=true', headers={'User-Agent':'Zhidian-office-training/1.0'})
            with urllib.request.urlopen(req, timeout=120) as response, part.open('wb') as out:
                while block:=response.read(4*1024*1024):
                    out.write(block); digest.update(block); count+=len(block)
                    if time.time()-last>15:
                        print(f'{name}: {count/1e6:.1f}/{entry.get("size",0)/1e6:.1f} MB',flush=True);last=time.time()
            if count != entry['size']: raise RuntimeError(f'Wrong size {count}')
            if expected and digest.hexdigest()!=expected: raise RuntimeError('SHA256 mismatch')
            if not expected and hashlib.sha1(f'blob {count}\0'.encode()+part.read_bytes()).hexdigest()!=entry['blobId']: raise RuntimeError('Git blob hash mismatch')
            os.replace(part,target)
            print(f'DONE {name} {digest.hexdigest()} {time.time()-started:.1f}s',flush=True);return
        except Exception as error:
            print(f'RETRY {name}: {error}',flush=True)
            if attempt==2: raise
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(download,metadata['siblings']))
