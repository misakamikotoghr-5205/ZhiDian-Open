# Zhidian office action LoRA v0.5

Base: Qwen/Qwen3.5-0.8B, revision `2fc06364715b967f1860aea9cf38778875588b17`, Apache-2.0.
Rank 8 LoRA, 1,794,048 trainable parameters.
Actually trained on NVIDIA GeForce RTX 3060 Laptop GPU for 96 optimizer steps
using 368 synthetic Chinese training requests. No private documents were used.

On the same 76 heldout synthetic examples:

| Metric | Base BF16 | LoRA BF16 |
| --- | ---: | ---: |
| Action IDs correct | 40/76 | 68/76 |
| Actions and meaningful parameters correct | 39/76 | 68/76 |
| Strict JSON | 38/76 | 76/76 |

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
