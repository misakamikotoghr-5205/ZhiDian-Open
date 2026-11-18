import concurrent.futures, hashlib, json, os, pathlib, subprocess, sys, time
url, output, size, sha = sys.argv[1:]
output=pathlib.Path(output); size=int(size)
output.parent.mkdir(parents=True,exist_ok=True)
parts=output.parent/(output.name+'.parts');parts.mkdir(exist_ok=True)
chunk=8*1024*1024
started=time.time()
def fetch(index):
    begin=index*chunk;end=min(size,begin+chunk)-1;part=parts/str(index)
    if part.exists() and part.stat().st_size==end-begin+1:return index
    for attempt in range(4):
        proc=subprocess.run(['curl.exe','-f','-L','--range',f'{begin}-{end}','--max-time','120','--max-filesize',str(chunk),'--retry','1','-sS','-o',str(part),url],capture_output=True)
        if proc.returncode==0 and part.exists() and part.stat().st_size==end-begin+1:return index
        print(f'retry {index} {proc.stderr.decode(errors="replace")[-120:]}',flush=True)
    raise RuntimeError(f'failed chunk {index}')
indexes=list(range((size+chunk-1)//chunk))
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    for count,index in enumerate(pool.map(fetch,indexes),1):
        if count%8==0 or count==len(indexes):print(f'{output.name}: {count}/{len(indexes)} chunks ({time.time()-started:.0f}s)',flush=True)
digest=hashlib.sha256()
temporary=output.with_name(output.name+'.assembled')
with temporary.open('wb') as out:
    for index in indexes:
        with (parts/str(index)).open('rb') as inp:
            while data:=inp.read(4*1024*1024):out.write(data);digest.update(data)
assert temporary.stat().st_size==size
assert digest.hexdigest()==sha,(digest.hexdigest(),sha)
os.replace(temporary,output)
print(f'VERIFIED {output} SHA256={sha}',flush=True)
