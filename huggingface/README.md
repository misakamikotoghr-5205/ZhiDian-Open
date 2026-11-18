---
license: apache-2.0
base_model:
  - Qwen/Qwen3.5-0.8B
library_name: gguf
pipeline_tag: image-text-to-text
language:
  - zh
  - en
tags:
  - qwen3.5
  - lora
  - gguf
  - llama-cpp
  - desktop-agent
  - gui-grounding
  - office-automation
  - local-first
  - mcp
---

# ZhiDian Qwen3.5-0.8B Office & Pointer LoRA Adapters (GGUF)

Lightweight GGUF LoRA adapters trained for **[ZhiDian (指点) v0.5](https://github.com/misakamikotoghr-5205/ZhiDian-Open)** — a screen-native, offline-first Windows desktop AI office agent built on `Qwen/Qwen3.5-0.8B` and `llama.cpp`.

## Included Adapters

| File | Size | Target Base Model | Purpose |
| --- | ---: | --- | --- |
| `office-small-lora.gguf` | `3.4 MB` | `Qwen/Qwen3.5-0.8B` (`Q4_K_M` / `BF16`) | Maps natural-language Chinese office requests + bound file handles into strict, schema-validated JSON action plans (`files.pdf`, `files.pptx`, `word.restyle`, `pdf.split`, `pdf.extract`, `sheets.merge`, `images.shrink`, `text.typeset`). |
| `zhidian-pointer-qwen3.5-0.8b.gguf` | `12.2 MB` | `Qwen/Qwen3.5-0.8B` + `mmproj` | Single-pass visual grounding adapter that simultaneously outputs a concise answer and `[x, y]` UI coordinates to drive ZhiDian's secondary AI cursor without hijacking the user's physical mouse. |
| `office-adapter.json` | `477 B` | Metadata | SHA-256 verification manifest and pinned base revision (`2fc06364715b967f1860aea9cf38778875588b17`). |

---

## Evaluation Results

### 1. Office Action Planning Adapter (`office-small-lora.gguf`)
Trained on a single consumer laptop GPU (RTX 3060 Laptop GPU, Rank-8, 96 steps, ~329s, peak VRAM 1,856 MiB) using 100% synthetic Chinese office instructions (368 train / 76 disjoint held-out test items; zero personal documents):

| Configuration | Valid JSON Schema (`76` held-out) | Exact Action + Valid Arguments |
| --- | ---: | ---: |
| `Qwen3.5-0.8B` Base (`BF16`, zero-shot) | `38 / 76` (`50.0%`) | `39 / 76` (`51.3%`) |
| `Qwen3.5-0.8B` + `office-small-lora` (`BF16`) | **`76 / 76` (`100.0%`)** | **`68 / 76` (`89.5%`)** |
| `Qwen3.5-0.8B` (`Q4_K_M`) + `office-small-lora` (`llama.cpp` runtime) | **`76 / 76` (`100.0%`)** | **`67 / 76` (`88.2%`)** |

### 2. Single-Pass Visual Pointer Adapter (`zhidian-pointer-qwen3.5-0.8b.gguf`)
Evaluated on synthetic UI layouts (`120` seen-layout validation items + `120` unseen UI category items) and 4-core CPU `llama-server` (`Q4_K_M`):

| Metric | Base `Qwen3.5-0.8B` (Single-Pass) | Base `Qwen3.5-0.8B` (2-Pass Crop) | + `zhidian-pointer` LoRA (Single-Pass) |
| --- | ---: | ---: | ---: |
| Validation hit rate (seen UI categories) | `5.0%` | — | **`94.2%`** |
| Generalization hit rate (unseen UI categories: menus/files/toolbars) | `10.0%` | — | **`72.5%`** |
| Median latency on 4-core CPU (Windows / Linux) | `7–10s` (`0/8` hits) | `21–26s` / `17–32s` | **`7.1s` / `6.6s`** |

---

## Quick Usage with `llama.cpp`

```bash
# 1. Start llama-server with Qwen3.5-0.8B Q4_K_M + Office LoRA
llama-server \
  -m Qwen3.5-0.8B-Q4_K_M.gguf \
  --lora office-small-lora.gguf \
  --ctx-size 4096 \
  --port 8080

# 2. Or start multimodal visual pointer mode with mmproj + Pointer LoRA
llama-server \
  -m Qwen3.5-0.8B-Q4_K_M.gguf \
  --mmproj mmproj-Qwen3.5-0.8B-F16.gguf \
  --lora zhidian-pointer-qwen3.5-0.8b.gguf \
  --ctx-size 4096 \
  --port 8080
```

## Links & License

- **Source Code & Windows Offline Package**: [https://github.com/misakamikotoghr-5205/ZhiDian-Open](https://github.com/misakamikotoghr-5205/ZhiDian-Open)
- **Training & Evaluation Reproduction**: [`train/office-v05/`](https://github.com/misakamikotoghr-5205/ZhiDian-Open/tree/main/train/office-v05)
- **License**: Apache-2.0 (see `LICENSE-Qwen.txt` for base model notices).
