#!/usr/bin/env python3
"""LoRA fine-tuning and evaluation of Qwen3.5-0.8B for Zhidian's pointer task.

The base model answers a question about a screenshot crop and, asked separately, says where the
answer is. That second request is what costs time on a CPU-only laptop. The adapter trained here
teaches the smallest model to do both in one pass: a short answer, then one JSON line with a
point on the 0-1000 grid of the crop. The prompts come from train/prompt.json, which is generated
from the app's own prompt module, so training matches what the app sends.

  python pointer_lora.py train --data DATA --out OUT [--epochs 2]
  python pointer_lora.py eval  --data DATA --out OUT [--adapter OUT/adapter] [--split heldout]

`eval` reports, for the base model and (if given) the adapter: how often the reply contained a
usable point, and how often that point landed inside the right element.
"""
import argparse
import subprocess
import json
import math
import random
import re
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoModelForImageTextToText, AutoProcessor

import os

# A local directory can stand in for the hub id (ZHIDIAN_BASE=/path/to/Qwen3.5-0.8B).
BASE = os.environ.get("ZHIDIAN_BASE", "Qwen/Qwen3.5-0.8B")
REVISION = None if os.path.isdir(BASE) else "2fc06364715b967f1860aea9cf38778875588b17"
PROMPTS = json.loads(Path(__file__).with_name("prompt.json").read_text(encoding="utf-8"))
LORA_TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


def load_rows(data: Path, split: str):
    return [json.loads(line) for line in (data / f"{split}.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]


def open_images(row, data: Path):
    return [Image.open(data / im["file"]).convert("RGB") for im in row["images"]]


def pointer_messages(row, images):
    """The single-pass request, exactly as the app builds it in pointer mode."""
    content = []
    for i, img in enumerate(images):
        content.append({"type": "text", "text": PROMPTS["ref_label"].replace("@{n}", row["handles"][i])})
        content.append({"type": "image", "image": img})
    content.append({"type": "text", "text": row["question"]})
    return [
        {"role": "system", "content": [{"type": "text", "text": PROMPTS["system_pointer"]}]},
        {"role": "user", "content": content},
    ]


def target_text(row):
    p = row["point"]
    tail = json.dumps({"ref": p["ref"], "point_2d": [p["x"], p["y"]], "label": p["label"]}, ensure_ascii=False)
    return f"{row['answer']}\n{tail}"


def encode(processor, messages, device):
    enc = processor.apply_chat_template(
        messages, add_generation_prompt=True, tokenize=True, return_dict=True, return_tensors="pt", enable_thinking=False
    )
    return {k: v.to(device) for k, v in enc.items()}


def load_base(device, dtype):
    processor = AutoProcessor.from_pretrained(BASE, revision=REVISION)
    model = AutoModelForImageTextToText.from_pretrained(BASE, revision=REVISION, dtype=dtype)
    return processor, model.to(device)


def lora_module_names(model):
    """Linear layers of the language model only: the vision tower stays frozen and untouched,
    so the adapter applies to the text GGUF and the stock mmproj file keeps working."""
    names = []
    for name, module in model.named_modules():
        if not isinstance(module, torch.nn.Linear):
            continue
        if "visual" in name or "vision" in name:
            continue
        if name.split(".")[-1] in LORA_TARGETS:
            names.append(name)
    return names


# ---------------------------------------------------------------------------------- training

def train(args):
    from peft import LoraConfig, get_peft_model

    data, out = Path(args.data), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float32  # plain float32: runs the same on any GPU (a T4 has no native bfloat16) and on CPU
    torch.manual_seed(args.seed)
    random.seed(args.seed)

    processor, model = load_base(device, dtype)
    names = lora_module_names(model)
    model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=args.rank * 2, lora_dropout=0.05, target_modules=names, bias="none"))
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"device={device} dtype={dtype} lora modules={len(names)} trainable={trainable / 1e6:.2f}M of {total / 1e6:.0f}M", flush=True)

    rows = load_rows(data, "train")
    if args.limit:
        rows = rows[: args.limit]
    eos = processor.tokenizer.convert_tokens_to_ids("<|im_end|>")
    steps_total = math.ceil(len(rows) * args.epochs / args.accum)
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=args.lr, weight_decay=0.0)
    warm = max(1, int(steps_total * 0.05))
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: (s + 1) / warm if s < warm else 0.5 * (1 + math.cos(math.pi * (s - warm) / max(1, steps_total - warm))))

    model.train()
    t0, seen, running, step = time.time(), 0, 0.0, 0
    log = []
    for epoch in range(args.epochs):
        random.shuffle(rows)
        for row in rows:
            enc = encode(processor, pointer_messages(row, open_images(row, data)), device)
            answer = processor.tokenizer(target_text(row), add_special_tokens=False, return_tensors="pt").input_ids.to(device)
            answer = torch.cat([answer, torch.tensor([[eos]], device=device)], dim=1)
            ids = torch.cat([enc["input_ids"], answer], dim=1)
            labels = torch.cat([torch.full_like(enc["input_ids"], -100), answer], dim=1)  # loss on the reply only
            prompt_len = enc["input_ids"].shape[1]
            for key, value in list(enc.items()):
                # Per-token side inputs (for example the text/image type of each token) have to
                # cover the appended reply as well: it is all text, which is type 0.
                if key not in ("input_ids", "attention_mask") and value.dim() == 2 and value.shape[1] == prompt_len:
                    enc[key] = torch.cat([value, torch.zeros((1, answer.shape[1]), dtype=value.dtype, device=device)], dim=1)
            enc["input_ids"] = ids
            enc["attention_mask"] = torch.ones_like(ids)
            loss = model(**enc, labels=labels).loss
            (loss / args.accum).backward()
            running += loss.item()
            seen += 1
            if seen % args.accum == 0:
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                sched.step()
                opt.zero_grad(set_to_none=True)
                step += 1
                if step % args.log_every == 0 or step == steps_total:
                    avg = running / (args.accum * args.log_every)
                    running = 0.0
                    rate = seen / (time.time() - t0)
                    log.append({"step": step, "loss": round(avg, 4), "examples_per_s": round(rate, 2)})
                    print(f"epoch {epoch + 1} step {step}/{steps_total} loss {avg:.4f} {rate:.1f} ex/s", flush=True)
                if args.save_every and step % args.save_every == 0 and step < steps_total:
                    # A rented GPU can disappear at any moment: keep what has been learned so far.
                    model.save_pretrained(out / "adapter")
                    (out / "train_log.json").write_text(json.dumps({"args": vars(args), "examples": len(rows), "seconds": round(time.time() - t0), "trainable_params": trainable, "finished": False, "log": log}, indent=1))
                    if args.on_save:
                        subprocess.run(args.on_save, shell=True, check=False)
            if args.max_steps and step >= args.max_steps:
                break
        if args.max_steps and step >= args.max_steps:
            break

    model.save_pretrained(out / "adapter")
    (out / "train_log.json").write_text(json.dumps({"args": vars(args), "examples": len(rows), "seconds": round(time.time() - t0), "trainable_params": trainable, "finished": True, "log": log}, indent=1))
    print(f"saved adapter to {out / 'adapter'} after {time.time() - t0:.0f}s", flush=True)


# ---------------------------------------------------------------------------------- evaluation

POINT_RE = re.compile(r'\{[^{}\n]*"point_2d"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\][^{}\n]*\}')


def parse_reply(text):
    """Returns (answer, ref, x, y) with x, y on the 0-1000 grid, or (answer, None, None, None)."""
    m = None
    for m in POINT_RE.finditer(text):
        pass  # keep the last one
    if not m:
        return text.strip(), None, None, None
    ref = re.search(r'"ref"\s*:\s*"(@\d+)"', m.group(0))
    return text[: m.start()].strip(), ref.group(1) if ref else None, float(m.group(1)), float(m.group(2))


def is_hit(row, ref, x, y, pad=4):
    if ref is None or ref != row["box"]["ref"]:
        return False
    im = row["images"][row["handles"].index(ref)]
    px, py = x / 1000 * im["w"], y / 1000 * im["h"]
    b = row["box"]
    return b["x"] - pad <= px <= b["x"] + b["w"] + pad and b["y"] - pad <= py <= b["y"] + b["h"] + pad


@torch.no_grad()
def generate(processor, model, messages, device, max_new_tokens=160):
    enc = encode(processor, messages, device)
    out = model.generate(**enc, max_new_tokens=max_new_tokens, do_sample=False)
    return processor.tokenizer.decode(out[0, enc["input_ids"].shape[1]:], skip_special_tokens=True)


def score(processor, model, rows, data, device, tag):
    results, hits, parsed, exact_label, t0 = [], 0, 0, 0, time.time()
    for i, row in enumerate(rows):
        reply = generate(processor, model, pointer_messages(row, open_images(row, data)), device)
        answer, ref, x, y = parse_reply(reply)
        if x is not None and ref is None:
            ref = row["handles"][0]  # a point with no "ref" can only mean the first image
        ok = is_hit(row, ref, x, y) if ref else False
        parsed += ref is not None
        hits += ok
        exact_label += row["point"]["label"].replace("…", "") in answer
        results.append({"id": row["id"], "family": row["family"], "reply": reply, "hit": ok})
        if (i + 1) % 20 == 0:
            print(f"  [{tag}] {i + 1}/{len(rows)} hit {hits / (i + 1):.3f}", flush=True)
    n = len(rows)
    by_family = {}
    for r in results:
        f = by_family.setdefault(r["family"], [0, 0])
        f[0] += r["hit"]
        f[1] += 1
    return {
        "n": n,
        "point_hit_rate": round(hits / n, 4),
        "reply_has_point_rate": round(parsed / n, 4),
        "answer_names_target_rate": round(exact_label / n, 4),
        "by_family": {k: round(v[0] / v[1], 4) for k, v in sorted(by_family.items())},
        "seconds_per_example": round((time.time() - t0) / n, 3),
    }, results


def evaluate(args):
    data, out = Path(args.data), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float32  # plain float32: runs the same on any GPU (a T4 has no native bfloat16) and on CPU
    processor, model = load_base(device, dtype)
    model.eval()
    report = {"base_model": BASE, "revision": REVISION, "device": device, "splits": {}}
    for split in args.split.split(","):
        rows = load_rows(data, split)
        if args.limit:
            rows = rows[: args.limit]
        print(f"== {split}: {len(rows)} examples", flush=True)
        base_metrics, base_rows = score(processor, model, rows, data, device, "base")
        report["splits"][split] = {"base": base_metrics}
        (out / f"replies_{split}_base.json").write_text(json.dumps(base_rows, ensure_ascii=False, indent=1))
    if args.adapter:
        from peft import PeftModel

        tuned = PeftModel.from_pretrained(model, args.adapter).eval()
        for split in args.split.split(","):
            rows = load_rows(data, split)
            if args.limit:
                rows = rows[: args.limit]
            metrics, replies = score(processor, tuned, rows, data, device, "lora")
            report["splits"][split]["lora"] = metrics
            (out / f"replies_{split}_lora.json").write_text(json.dumps(replies, ensure_ascii=False, indent=1))
    (out / "eval.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--data", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--epochs", type=int, default=2)
    t.add_argument("--rank", type=int, default=16)
    t.add_argument("--lr", type=float, default=2e-4)
    t.add_argument("--accum", type=int, default=8)
    t.add_argument("--seed", type=int, default=7)
    t.add_argument("--limit", type=int, default=0)
    t.add_argument("--max-steps", type=int, default=0)
    t.add_argument("--log-every", type=int, default=10)
    t.add_argument("--save-every", type=int, default=0, help="also save the adapter every N steps")
    t.add_argument("--on-save", default="", help="shell command to run after each intermediate save")
    e = sub.add_parser("eval")
    e.add_argument("--data", required=True)
    e.add_argument("--out", required=True)
    e.add_argument("--adapter", default="")
    e.add_argument("--split", default="heldout,val")
    e.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    train(a) if a.cmd == "train" else evaluate(a)
