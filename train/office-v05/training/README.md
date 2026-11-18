# Zhidian office action LoRA

This experiment adapts **Qwen/Qwen3.5-0.8B** to Zhidian's bounded office action
JSON schema. It does not train general office knowledge, OCR, screen pointing,
document layout generation, or the bundled 4B model. All examples are generated
synthetic Chinese requests; no user document is included.

The final `model-build/office-small-lora/run-report.json` records actual hardware,
steps, loss, timings and heldout generation results. A report without a training
section is an interrupted run, not a trained-model claim.

## Reproduction

Use Python 3.14 on Windows with a CUDA-capable NVIDIA GPU. Keep this `training`
directory and sibling `model-build` on a drive with at least 20 GB free. All build
caches and temporary files can stay beside the project:

```powershell
$trainRoot = (Resolve-Path training).Path
New-Item -ItemType Directory -Force "$trainRoot/temp", "$trainRoot/cache/pip" | Out-Null
$env:TEMP = "$trainRoot/temp"
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = "$trainRoot/cache/pip"
$env:HF_HOME = "$trainRoot/cache/huggingface"
python -m venv training/venv
training/venv/Scripts/python.exe -m pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
training/venv/Scripts/python.exe -m pip install -r training/requirements.txt
training/venv/Scripts/python.exe training/fetch_base.py
training/venv/Scripts/python.exe training/make_dataset.py
training/venv/Scripts/python.exe -u training/run_training.py --steps 96 --eval-count 76 --rank 8
training/venv/Scripts/python.exe training/summarize_evaluation.py
```

`fetch_base.py` pins the official model to
`2fc06364715b967f1860aea9cf38778875588b17` and verifies LFS SHA256. Where a large
single HTTP stream is unreliable, `parallel_download.py URL OUTPUT SIZE SHA256`
downloads verified range chunks through curl. Use the exact size/hash from the
downloaded official `source.json`; never silently accept a different revision.

Dataset generation uses the app's current `PLAN_PROMPT` if available. Its frozen
copy is `data/system-prompt.txt`. The manifest contains SHA256 hashes and seeds.
The train and evaluation request phrases and filenames are separate. The small
synthetic evaluation is a format/action-routing check, not a benchmark of unseen
real office documents. There is no claim that a heldout score measures OCR or PPT
visual quality.

## Exports

The llama.cpp conversion source is pinned to b12110,
`cd959bae99ff4bed22bef2604f45241c09bbb8c8`. `fetch_converters.py` retrieves files
listed in `converters/tree.json` and verifies Git blob hashes. Conversion tools
retain their upstream license. After a successful training run:

```powershell
training/venv/Scripts/python.exe training/converters/convert_lora_to_gguf.py --base model-build/base-small --outfile model-build/office-small-lora.gguf --outtype f16 model-build/office-small-lora
training/venv/Scripts/python.exe training/converters/convert_hf_to_gguf.py model-build/office-small-merged --outfile model-build/Qwen3.5-0.8B-office-F16.gguf --outtype f16
# Set this to the same llama.cpp b12110 runtime used by the application.
& $llamaQuantize model-build/Qwen3.5-0.8B-office-F16.gguf model-build/Qwen3.5-0.8B-office-Q4_K_M.gguf Q4_K_M
```

Alternatively run `training/export_models.ps1 -LlamaQuantize PATH_TO_EXE` for the
three exports with checked exit codes. `HF_DOWNLOAD_HOST=hf-mirror.com` can be set
when the official model download endpoint is unreachable; the pinned file's
official SHA256 remains mandatory.

Run `smoke_runtime.py --runtime PATH_TO_LLAMA_SERVER --model GGUF --label merged`
to load the exported model with llama.cpp and execute three heldout fixtures.
For the standalone adapter, supply the standard pinned base GGUF plus
`--adapter model-build/office-small-lora.gguf --label adapter`. The process uses
an automatically chosen local port and terminates only its own server.
After exports, run `finalize_artifacts.py` to write hashes and portable provenance.

The standalone office adapter is distinct from the screen-pointer adapter. It
must never select pointer mode. The merged Q4_K_M file already contains the
office weights, so do not apply this adapter to that merged file a second time.
The model's Apache 2.0 license is copied from the pinned upstream model.

Windows currently uses the correct PyTorch reference implementation for Qwen's
linear attention when `causal_conv1d` / `flash-linear-attention` are absent. This
is slower than a native fused-kernel environment. Training requires real CUDA;
the script explicitly rejects a CPU-only run.
