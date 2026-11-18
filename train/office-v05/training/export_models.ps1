param(
    [Parameter(Mandatory=$true)][string]$LlamaQuantize,
    [string]$Python = (Join-Path $PSScriptRoot 'venv/Scripts/python.exe')
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$modelRoot = Join-Path $taskRoot 'model-build'
$env:TEMP = Join-Path $PSScriptRoot 'temp'
$env:TMP = $env:TEMP
$env:HF_HOME = Join-Path $PSScriptRoot 'cache/huggingface'
$env:HF_HUB_OFFLINE = '1'
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
& $Python (Join-Path $PSScriptRoot 'fetch_converters.py')
if ($LASTEXITCODE -ne 0) { throw 'Converter source verification failed' }
& $Python (Join-Path $PSScriptRoot 'converters/convert_lora_to_gguf.py') --base (Join-Path $modelRoot 'base-small') --outfile (Join-Path $modelRoot 'office-small-lora.gguf') --outtype f16 (Join-Path $modelRoot 'office-small-lora')
if ($LASTEXITCODE -ne 0) { throw 'LoRA GGUF export failed' }
& $Python (Join-Path $PSScriptRoot 'converters/convert_hf_to_gguf.py') (Join-Path $modelRoot 'office-small-merged') --outfile (Join-Path $modelRoot 'Qwen3.5-0.8B-office-F16.gguf') --outtype f16
if ($LASTEXITCODE -ne 0) { throw 'Merged GGUF export failed' }
& $LlamaQuantize (Join-Path $modelRoot 'Qwen3.5-0.8B-office-F16.gguf') (Join-Path $modelRoot 'Qwen3.5-0.8B-office-Q4_K_M.gguf') Q4_K_M
if ($LASTEXITCODE -ne 0) { throw 'Q4_K_M quantization failed' }
Get-FileHash (Join-Path $modelRoot 'office-small-lora.gguf'), (Join-Path $modelRoot 'Qwen3.5-0.8B-office-Q4_K_M.gguf') -Algorithm SHA256
