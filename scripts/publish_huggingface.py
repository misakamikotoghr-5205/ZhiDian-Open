#!/usr/bin/env python3
"""Publish ZhiDian dual GGUF LoRA adapters to Hugging Face Model Hub.

Usage:
    HF_TOKEN="hf_xxx" python3 scripts/publish_huggingface.py [--repo-id <owner>/ZhiDian-Qwen3.5-0.8B-Office-LoRA]
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

from huggingface_hub import HfApi


ROOT = Path(__file__).resolve().parents[1]

UPLOAD_FILES = [
    (ROOT / "huggingface" / "README.md", "README.md"),
    (ROOT / "models" / "office-small-lora.gguf", "office-small-lora.gguf"),
    (ROOT / "models" / "zhidian-pointer-qwen3.5-0.8b.gguf", "zhidian-pointer-qwen3.5-0.8b.gguf"),
    (ROOT / "models" / "office-adapter.json", "office-adapter.json"),
    (ROOT / "models" / "LICENSE-Qwen.txt", "LICENSE-Qwen.txt"),
    (ROOT / "LICENSE", "LICENSE"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish ZhiDian GGUF LoRAs to Hugging Face Hub")
    parser.add_argument(
        "--repo-id",
        default="",
        help="Target Hugging Face repo id (<username>/ZhiDian-Qwen3.5-0.8B-Office-LoRA). Auto-detected from token if omitted.",
    )
    parser.add_argument(
        "--private",
        action="store_true",
        help="Create/keep the Hugging Face model repo private instead of public.",
    )
    args = parser.parse_args()

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not token:
        print("ERROR: Set HF_TOKEN='hf_...' in environment before running.", file=sys.stderr)
        return 1

    api = HfApi(token=token)
    who = api.whoami()
    owner = who.get("name")
    repo_id = args.repo_id or f"{owner}/ZhiDian-Qwen3.5-0.8B-Office-LoRA"

    for local_path, _ in UPLOAD_FILES:
        if not local_path.is_file():
            print(f"ERROR: Missing required file: {local_path}", file=sys.stderr)
            return 1

    url = api.create_repo(
        repo_id=repo_id,
        repo_type="model",
        private=args.private,
        exist_ok=True,
    )
    print(f"Target repository ready: {url}")

    for local_path, path_in_repo in UPLOAD_FILES:
        print(f"Uploading {path_in_repo} ({local_path.stat().st_size:,} bytes)...")
        api.upload_file(
            path_or_fileobj=str(local_path),
            path_in_repo=path_in_repo,
            repo_id=repo_id,
            repo_type="model",
            commit_message=f"Upload {path_in_repo} for ZhiDian v0.5.0",
        )

    print(f"\nSUCCESS! Published to: https://huggingface.co/{repo_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
