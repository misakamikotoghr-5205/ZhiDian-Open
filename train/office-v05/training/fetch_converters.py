import concurrent.futures,hashlib,json,pathlib,urllib.request,time
DEST=pathlib.Path(__file__).resolve().parent/'converters'
COMMIT='cd959bae99ff4bed22bef2604f45241c09bbb8c8'
DEST.mkdir(parents=True,exist_ok=True)
tree_path=DEST/'tree.json'
if tree_path.exists():
    tree=json.loads(tree_path.read_text(encoding='utf-8-sig'))
else:
    with urllib.request.urlopen(f'https://api.github.com/repos/ggml-org/llama.cpp/git/trees/{COMMIT}?recursive=1',timeout=60) as response:
        tree=json.load(response)
    tree_path.write_text(json.dumps(tree),encoding='utf-8')
assert tree['sha']==COMMIT,'Unexpected converter source revision'
items=[x for x in tree['tree'] if x['type']=='blob' and ((x['path'].startswith(('conversion/','gguf-py/gguf/')) and x['path'].endswith('.py')) or x['path'] in ['LICENSE','convert_hf_to_gguf.py','convert_lora_to_gguf.py'])]
def fetch(item):
    target=DEST/item['path'];target.parent.mkdir(parents=True,exist_ok=True)
    if target.exists() and target.stat().st_size==item['size']:
        data=target.read_bytes()
        if hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()==item['sha']:return
    for attempt in range(3):
        try:
            with urllib.request.urlopen('https://raw.githubusercontent.com/ggml-org/llama.cpp/'+tree['sha']+'/'+item['path'],timeout=45) as response:data=response.read()
            blob=hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()
            assert blob==item['sha']
            target.write_bytes(data);return
        except Exception:
            if attempt==2:raise
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:list(pool.map(fetch,items))
print('Verified converter source files:',len(items),'commit:',tree['sha'],flush=True)
