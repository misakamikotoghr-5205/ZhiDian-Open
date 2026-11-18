# Runs on a Colab GPU VM (sent with `colab exec -f train/colab_job.py`). Expects, in /content/job:
#   data.tar.gz   the dataset from gen_dataset.mjs
#   pointer_lora.py, runtime_eval.py, prompt.json
# Produces /content/job/out: the adapter (PEFT and GGUF), the training log, and two evaluations:
# eval.json (full-precision model on GPU) and runtime_eval.json (quantised model in llama-server
# on this VM's CPU, which is the configuration the app ships).
import json, os, subprocess, sys, tarfile, time, urllib.request
from pathlib import Path

JOB = Path("/content/job"); OUT = JOB / "out"; OUT.mkdir(parents=True, exist_ok=True)
TAG = "b12110"
STAGE = os.environ.get("ZHIDIAN_STAGE", "all")

def sh(cmd, **kw):
    print("$", cmd if isinstance(cmd, str) else " ".join(map(str, cmd)), flush=True)
    subprocess.run(cmd, shell=isinstance(cmd, str), check=True, **kw)

def fetch(url, dest):
    dest = Path(dest)
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    print("downloading", url, flush=True)
    urllib.request.urlretrieve(url, dest)
    return dest

t0 = time.time()
if not (JOB / "data" / "train.jsonl").exists():
    with tarfile.open(JOB / "data.tar.gz") as tar:
        tar.extractall(JOB / "data")
sh([sys.executable, "-m", "pip", "install", "-q", "-U", "transformers", "peft", "accelerate", "torchvision", "gguf", "sentencepiece"])
# Colab images ship an old torchao; PEFT refuses to load next to it and nothing here uses it.
sh([sys.executable, "-m", "pip", "uninstall", "-q", "-y", "torchao"])
gpu = subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True).stdout.strip()
print("GPU:", gpu or "none", flush=True)

# Where finished pieces are copied as soon as they exist, so they outlive this VM (a mounted
# Google Drive folder, for example). Nothing is copied if it is not set.
SAVE = os.environ.get("ZHIDIAN_SAVE_DIR", "")
def keep(*names):
    if not SAVE:
        return
    Path(SAVE).mkdir(parents=True, exist_ok=True)
    for name in names:
        src = OUT / name
        if src.is_dir():
            sh(f"cd {OUT} && tar -czf {name}.tar.gz {name} && cp -f {name}.tar.gz '{SAVE}/'")
        elif src.exists():
            sh(f"cp -f '{src}' '{SAVE}/'")
    sh(f"cp -f {OUT}/job.log '{SAVE}/' 2>/dev/null || true")

def to_gguf():
    """Adapter to GGUF with llama.cpp's own converter, at the same tag as the runtime."""
    if not (JOB / "llama.cpp").exists():
        sh(f"git clone --depth 1 --branch {TAG} https://github.com/ggml-org/llama.cpp {JOB / 'llama.cpp'}")
    from huggingface_hub import snapshot_download
    base = snapshot_download("Qwen/Qwen3.5-0.8B", revision="2fc06364715b967f1860aea9cf38778875588b17")
    gguf = OUT / "zhidian-pointer-qwen3.5-0.8b.gguf"
    sh([sys.executable, str(JOB / "llama.cpp" / "convert_lora_to_gguf.py"), "--base", base, "--outtype", "f16", "--outfile", str(gguf), str(OUT / "adapter")])
    return gguf

if STAGE in ("all", "train"):
    save_cmd = f"mkdir -p '{SAVE}' && cd {OUT} && tar -czf adapter.tar.gz adapter && cp -f adapter.tar.gz train_log.json job.log '{SAVE}/'" if SAVE else ""
    sh([sys.executable, str(JOB / "pointer_lora.py"), "train", "--data", str(JOB / "data"), "--out", str(OUT), "--epochs", os.environ.get("ZHIDIAN_EPOCHS", "2"), "--save-every", "125", "--on-save", save_cmd])
    keep("adapter", "train_log.json")
    to_gguf()
    keep("zhidian-pointer-qwen3.5-0.8b.gguf")
    sh([sys.executable, str(JOB / "pointer_lora.py"), "eval", "--data", str(JOB / "data"), "--out", str(OUT), "--adapter", str(OUT / "adapter"), "--split", "heldout,val", "--limit", os.environ.get("ZHIDIAN_EVAL_LIMIT", "0")])
    keep("eval.json", *[p.name for p in OUT.glob("replies_*.json")])

if STAGE in ("all", "runtime"):
    gguf = to_gguf() if not (OUT / "zhidian-pointer-qwen3.5-0.8b.gguf").exists() else OUT / "zhidian-pointer-qwen3.5-0.8b.gguf"
    # The official prebuilt CPU runtime and the same quantised files the app installs.
    rt = JOB / "rt"; rt.mkdir(exist_ok=True)
    fetch(f"https://github.com/ggml-org/llama.cpp/releases/download/{TAG}/llama-{TAG}-bin-ubuntu-x64.tar.gz", rt / "rt.tar.gz")
    if not list(rt.glob("*/llama-server")):
        sh(f"tar -xzf {rt / 'rt.tar.gz'} -C {rt}")
    server = str(list(rt.glob("*/llama-server"))[0])
    hf = "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0"
    model = fetch(f"{hf}/Qwen3.5-0.8B-Q4_K_M.gguf", rt / "model.gguf")
    mmproj = fetch(f"{hf}/mmproj-F16.gguf", rt / "mmproj.gguf")
    sh([sys.executable, str(JOB / "runtime_eval.py"), "--server", server, "--model", str(model), "--mmproj", str(mmproj), "--lora", str(gguf), "--data", str(JOB / "data"), "--out", str(OUT), "--split", "heldout", "--limit", os.environ.get("ZHIDIAN_RT_LIMIT", "60"), "--threads", str(os.cpu_count() or 2)])
    keep("runtime_eval.json", *[p.name for p in OUT.glob("runtime_replies_*.json")], *[p.name for p in OUT.glob("server_*.log")])

(OUT / "job.json").write_text(json.dumps({"gpu": gpu, "cpu_count": os.cpu_count(), "seconds": round(time.time() - t0), "llama_cpp_tag": TAG, "stage": STAGE}, indent=1))
keep("job.json")
print("JOB DONE in", round(time.time() - t0), "s", flush=True)
