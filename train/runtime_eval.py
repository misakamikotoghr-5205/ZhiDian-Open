#!/usr/bin/env python3
"""Measure the pointer model in the runtime the app actually ships: llama-server on CPU with the
quantised GGUF, talking the same HTTP requests the app sends.

Two modes are compared on the same examples:
  two-pass  the stock model: answer first, then a follow-up "where is it" in the same
            conversation (the app's behaviour without the adapter)
  one-pass  the model with the Zhidian adapter loaded (--lora): answer and point together

For each it reports the point hit rate, seconds per question, and the server's peak memory.

  python runtime_eval.py --server /path/llama-server --model M.gguf --mmproj P.gguf \
      [--lora adapter.gguf] --data DATA --out OUT [--split heldout] [--limit 60] [--threads 4]
"""
import argparse
import base64
import io
import json
import math
import re
import subprocess
import time
import urllib.request
from pathlib import Path

from PIL import Image

PROMPTS = json.loads(Path(__file__).with_name("prompt.json").read_text(encoding="utf-8"))
POINT_RE = re.compile(r'"point_2d"\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]')
PORT = 18439


def data_url(img: Image.Image, fmt="PNG"):
    buf = io.BytesIO()
    img.save(buf, format=fmt, quality=92)
    return f"data:image/{fmt.lower()};base64," + base64.b64encode(buf.getvalue()).decode()


def post(body, timeout=600):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/chat/completions", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())["choices"][0]["message"]["content"]


def grounding_size(w, h, target=520_000, max_scale=4, max_edge=1792, patch=32):
    """Same rule as groundingSize() in src/core/grounding.js."""
    scale = math.sqrt(target / (w * h))
    scale = min(scale, max_scale, max_edge / max(w, h))
    scale = max(scale, min(1, max_edge / max(w, h)))
    r = lambda v: max(patch, round(v * scale / patch) * patch)
    return r(w), r(h)


def user_content(row, images):
    content = []
    for handle, img in zip(row["handles"], images):
        content.append({"type": "text", "text": f"{handle}："})
        content.append({"type": "image_url", "image_url": {"url": data_url(img)}})
    content.append({"type": "text", "text": row["question"]})
    return content


def ask_one_pass(row, images):
    reply = post({"messages": [{"role": "system", "content": PROMPTS["system_pointer"]}, {"role": "user", "content": user_content(row, images)}], "max_tokens": 200, "temperature": 0, "cache_prompt": True, "chat_template_kwargs": {"enable_thinking": False}})
    m = None
    for m in POINT_RE.finditer(reply):
        pass
    ref = re.search(r'"ref"\s*:\s*"(@\d+)"', reply)
    return reply, (ref.group(1) if ref else row["handles"][0]) if m else None, (float(m.group(1)), float(m.group(2))) if m else None


def ask_two_pass(row, images):
    """The app without the adapter: the answer, then a follow-up asking where (same conversation,
    so the server reuses the screenshots it has already processed)."""
    messages = [{"role": "system", "content": PROMPTS["system"]}, {"role": "user", "content": user_content(row, images)}]
    answer = post({"messages": messages, "max_tokens": 200, "temperature": 0, "cache_prompt": True, "chat_template_kwargs": {"enable_thinking": False}})
    zh = bool(re.search(r"[\u3400-\u9fff]", row["question"] + answer))
    follow = messages + [{"role": "assistant", "content": answer}, {"role": "user", "content": PROMPTS["locate"]["zh" if zh else "en"]}]
    reply = post({"messages": follow, "max_tokens": 96, "temperature": 0, "cache_prompt": True, "chat_template_kwargs": {"enable_thinking": False}, "response_format": {"type": "json_schema", "json_schema": {"name": "location", "schema": PROMPTS["locate_schema"]}}})
    m = POINT_RE.search(reply)
    ref = re.search(r'"ref"\s*:\s*"\s*(@\d+)', reply)
    handle = ref.group(1) if ref and ref.group(1) in row["handles"] else row["handles"][0]
    return answer + "\n" + reply, handle if m else None, (float(m.group(1)), float(m.group(2))) if m else None


def is_hit(row, ref, pt, pad=4):
    if not pt or ref != row["box"]["ref"]:
        return False
    im = row["images"][row["handles"].index(ref)]
    px, py = pt[0] / 1000 * im["w"], pt[1] / 1000 * im["h"]
    b = row["box"]
    return b["x"] - pad <= px <= b["x"] + b["w"] + pad and b["y"] - pad <= py <= b["y"] + b["h"] + pad


def peak_rss_mb(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmHWM:"):
            return round(int(line.split()[1]) / 1024)
    return None


def run(args, lora):
    cmd = [args.server, "--host", "127.0.0.1", "--port", str(PORT), "-m", args.model, "--mmproj", args.mmproj, "-c", "4096", "-np", "1", "--no-webui", "--offline", "--reasoning", "off", "-t", str(args.threads), "-ngl", "0"]
    if lora:
        cmd += ["--lora", lora]
    log = open(Path(args.out) / f"server_{'lora' if lora else 'base'}.log", "w")
    t_start = time.time()
    proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
    try:
        for _ in range(600):
            if proc.poll() is not None:
                raise RuntimeError("llama-server exited; see the server log")
            try:
                if urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2).status == 200:
                    break
            except Exception:
                time.sleep(0.5)
        load_s = time.time() - t_start
        data = Path(args.data)
        rows = [json.loads(l) for l in (data / f"{args.split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()][: args.limit]
        hits, pointed, times, replies = 0, 0, [], []
        for i, row in enumerate(rows):
            images = [Image.open(data / im["file"]).convert("RGB") for im in row["images"]]
            t0 = time.time()
            reply, ref, pt = (ask_one_pass if lora else ask_two_pass)(row, images)
            times.append(time.time() - t0)
            ok = is_hit(row, ref, pt)
            hits += ok
            pointed += pt is not None
            replies.append({"id": row["id"], "hit": ok, "seconds": round(times[-1], 2), "reply": reply})
            if (i + 1) % 10 == 0:
                print(f"  [{'one-pass+lora' if lora else 'two-pass base'}] {i + 1}/{len(rows)} hit {hits / (i + 1):.3f} avg {sum(times) / len(times):.1f}s", flush=True)
        times.sort()
        result = {
            "mode": "one-pass with adapter" if lora else "two-pass, stock model",
            "n": len(rows),
            "point_hit_rate": round(hits / len(rows), 4),
            "reply_has_point_rate": round(pointed / len(rows), 4),
            "seconds_per_question_median": round(times[len(times) // 2], 2),
            "seconds_per_question_mean": round(sum(times) / len(times), 2),
            "model_load_seconds": round(load_s, 1),
            "server_peak_rss_mb": peak_rss_mb(proc.pid),
            "threads": args.threads,
        }
        (Path(args.out) / f"runtime_replies_{'lora' if lora else 'base'}.json").write_text(json.dumps(replies, ensure_ascii=False, indent=1))
        return result
    finally:
        proc.terminate()
        proc.wait(timeout=20)
        log.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--mmproj", required=True)
    ap.add_argument("--lora", default="")
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--split", default="heldout")
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    Path(a.out).mkdir(parents=True, exist_ok=True)
    cpu = next((l.split(":", 1)[1].strip() for l in Path("/proc/cpuinfo").read_text().splitlines() if l.startswith("model name")), "unknown")
    report = {"cpu": cpu, "split": a.split, "runs": [run(a, "")]}
    if a.lora:
        report["runs"].append(run(a, a.lora))
    (Path(a.out) / "runtime_eval.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    print(json.dumps(report, ensure_ascii=False, indent=1))
