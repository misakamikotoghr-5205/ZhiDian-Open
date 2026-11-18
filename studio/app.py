#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
指点 ZhiDian v0.5 · 1:1 复刻在线交互桌面工作台 (ModelScope Studio)
严格对齐桌面端 `src/renderer/overlay.html`、`overlay.css` 与 `overlay.js` 全套交互：
1. 默认桌面态 (idle)：单击任意文件或窗口内划选文字 -> 原地弹出 32×32 蓝色小箭头 (#actpill) -> 悬停或点击展开 380px 动作面板 (#act)，含主题下拉框、更多折叠、行内参数输入、原地落盘预览与原文件名下载。
2. F8 指点态 (pointing)：按 F8 或点任务栏按钮进入 -> 蓝色呼吸视口框 (#veil) + 光标光环 (#halo) + 自动吸附框 (#snap，支持滚轮与 [-/+] 缩放范围) + 左键拖拽框选文件（含顶层窗口 HWND Z-Order 防遮挡过滤）+ 340px 悬浮助手面板 (#ask，含 60s 语音波形球、高级设置、截图保存与提取文字）。
3. 跨文件多指代 (@1 @2) 与人机双光标 (#aicursor)：右键或 F8 点击建立 @1 @2 引用筹码 (#pins + 底部 #dock)，提问或跨表核查时弹出回答气泡 (#bubble) 并驱动紫色副光标 (#aicursor) 飞向异常超支行，绝不抢占用户物理鼠标。
4. 零按钮遮挡碰撞引擎 (placeSmartPanel)：所有悬浮面板自动避让顶栏、底栏、窗口标题栏按钮与其他活动面板，支持任意拖拽与一键置顶。
"""

from __future__ import annotations

import base64
import io
import json
import mimetypes
import os
from pathlib import Path
import shutil
import traceback
from typing import Any

for _proxy_key in ("NO_PROXY", "no_proxy"):
    if _proxy_key in os.environ and "[::1]" in os.environ[_proxy_key]:
        os.environ[_proxy_key] = os.environ[_proxy_key].replace("[::1]", "::1")

import gradio as gr
from PIL import Image, ImageDraw, ImageFont

from local_llm import LLM
from zhidian_engine import (
    WORKSPACE_ROOT,
    ensure_workspace,
    execute_action,
    extract_plain_text,
    file_kind,
    get_workspace_mock_meta,
    human_size,
    list_workspace_files,
    offers_for_selection,
    render_file_preview,
    run_natural_instruction,
    unique_out_path,
)

STUDIO_DIR = Path(__file__).resolve().parent
DEMO_VIDEO_PATH = STUDIO_DIR / "assets" / "zhidian-vm-demo.mp4"

# Kick off background local Qwen3.5-4B runtime boot on container start
LLM.ensure_background_boot()


def _build_region_snapshot_png(ws_dir: Path, names: list[str], box: dict[str, Any] | None) -> Path:
    """Generates a crisp real PNG snapshot of the selected region/files on disk for `保存图片`."""
    w = max(360, min(960, int((box or {}).get("w") or 520)))
    h = max(220, min(640, int((box or {}).get("h") or 300)))
    img = Image.new("RGB", (w, h), (15, 23, 42))
    draw = ImageDraw.Draw(img)
    draw.rectangle((2, 2, w - 3, h - 3), outline=(37, 99, 235), width=3)
    draw.rectangle((14, 14, w - 15, 52), fill=(30, 58, 138))
    font = None
    for fp in (
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, 15)
                break
            except Exception:
                pass
    title = f"指点 ZhiDian 框选快照 ({w}x{h})"
    draw.text((24, 23), title, fill=(255, 255, 255), font=font)
    y = 70
    summary_lines = [f"命中文件: {', '.join(names) if names else '桌面局部区域'}"]
    for n in names[:3]:
        p = ws_dir / Path(n).name
        if p.exists():
            snippet = extract_plain_text(p, 240).replace("\n", " ")[:72]
            summary_lines.append(f"• {p.name}: {snippet}")
    for ln in summary_lines:
        draw.text((24, y), ln, fill=(226, 232, 240), font=font)
        y += 30
    out = unique_out_path(ws_dir, "指点框选快照", ".png")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    out.write_bytes(buf.getvalue())
    return out


def handle_rpc(payload_str: str) -> str:
    """Unified JSON RPC endpoint called by the interactive ZhiDian Desktop Workbench via /gradio_api/call/zhidian_rpc."""
    try:
        req = json.loads(payload_str or "{}")
        op = str(req.get("op") or "init")
        sid = str(req.get("session_id") or "default")
        ws_dir = ensure_workspace(sid, reset=(op == "reset"))

        if op in {"init", "reset", "status"}:
            files = list_workspace_files(ws_dir)
            meta = get_workspace_mock_meta(ws_dir)
            return json.dumps({
                "ok": True,
                "workspace": files,
                "scratchpad_text": meta.get("scratchpad_text", ""),
                "batch_id": meta.get("batch_id", 0),
                "llm": LLM.status(),
            }, ensure_ascii=False)

        if op == "inspect":
            names = [str(x) for x in (req.get("files") or [])]
            sel_text = str(req.get("selected_text") or "")
            paths = [(ws_dir / Path(n).name).resolve() for n in names if (ws_dir / Path(n).name).exists()]
            offers = offers_for_selection(paths, sel_text)
            summary = (
                f"{paths[0].name} · {human_size(paths[0].stat().st_size)}"
                if len(paths) == 1
                else (f"已选 {len(paths)} 个文件" if len(paths) > 1 else f"已选文字（{len(sel_text)} 字）")
            )
            return json.dumps({
                "ok": True,
                "summary": summary,
                "files": [{"name": p.name, "kind": file_kind(p), "size_human": human_size(p.stat().st_size)} for p in paths],
                "offers": offers,
                "llm": LLM.status(),
            }, ensure_ascii=False)

        if op == "execute":
            action_id = str(req.get("action_id") or "")
            names = [str(x) for x in (req.get("files") or [])]
            param = str(req.get("param") or "")
            sel_text = str(req.get("selected_text") or "")
            res = execute_action(ws_dir, action_id, names, param=param, selected_text=sel_text)
            return json.dumps(res, ensure_ascii=False)

        if op == "instruct":
            instruction = str(req.get("instruction") or "")
            names = [str(x) for x in (req.get("files") or [])]
            sel_text = str(req.get("selected_text") or "")
            pinned_refs = req.get("pinned_refs") or []
            res = run_natural_instruction(ws_dir, instruction, names, selected_text=sel_text, pinned_refs=pinned_refs)
            return json.dumps(res, ensure_ascii=False)

        if op == "capture_save":
            names = [str(x) for x in (req.get("files") or [])]
            box = req.get("box") if isinstance(req.get("box"), dict) else None
            out = _build_region_snapshot_png(ws_dir, names, box)
            files = list_workspace_files(ws_dir)
            created_meta = [f for f in files if f["name"] == out.name]
            return json.dumps({
                "ok": True,
                "message": f"已将当前框选区域保存为《{out.name}》并放回桌面。",
                "created": created_meta,
                "workspace": files,
                "llm": LLM.status(),
            }, ensure_ascii=False)

        if op == "ocr_extract":
            names = [str(x) for x in (req.get("files") or [])]
            chunks: list[str] = []
            for n in names[:4]:
                p = (ws_dir / Path(n).name).resolve()
                if p.exists():
                    chunks.append(f"【{p.name}】\n{extract_plain_text(p, 1200).strip()}")
            text_out = "\n\n".join(chunks) if chunks else "指点本地视觉识别（虚拟测试样本）：已识别当前桌面局部区域文本，可直接粘贴使用。"
            return json.dumps({
                "ok": True,
                "text": text_out,
                "message": f"已提取 {len(text_out)} 字符文本（可直接复制粘贴）：\n{text_out[:360]}",
                "created": [],
                "workspace": list_workspace_files(ws_dir),
                "llm": LLM.status(),
            }, ensure_ascii=False)

        if op == "preview":
            fname = Path(str(req.get("name") or "")).name
            target = (ws_dir / fname).resolve()
            if target.parent != ws_dir.resolve() or not target.exists():
                return json.dumps({"ok": False, "error": f"找不到文件：{fname}"}, ensure_ascii=False)
            prev = render_file_preview(target)
            prev["offers"] = offers_for_selection([target], "")
            return json.dumps(prev, ensure_ascii=False)

        if op == "upload_b64":
            uploads = req.get("uploads") or []
            added = []
            for item in uploads[:10]:
                raw_name = Path(str(item.get("name") or "upload.bin")).name
                data_url = str(item.get("data_url") or "")
                b64_part = data_url.split(",", 1)[1] if "," in data_url else data_url
                raw_bytes = base64.b64decode(b64_part)
                p = Path(raw_name)
                dest = unique_out_path(ws_dir, p.stem, p.suffix or ".bin") if (ws_dir / raw_name).exists() else (ws_dir / raw_name)
                dest.write_bytes(raw_bytes)
                added.append(dest.name)
            files = list_workspace_files(ws_dir)
            return json.dumps({
                "ok": True,
                "added": added,
                "workspace": files,
                "llm": LLM.status(),
            }, ensure_ascii=False)

        if op == "download_b64":
            fname = Path(str(req.get("name") or "")).name
            target = (ws_dir / fname).resolve()
            if target.parent != ws_dir.resolve() or not target.exists():
                return json.dumps({"ok": False, "error": "文件不存在"}, ensure_ascii=False)
            mime, _ = mimetypes.guess_type(target.name)
            b64 = base64.b64encode(target.read_bytes()).decode("ascii")
            return json.dumps({
                "ok": True,
                "name": target.name,
                "mime": mime or "application/octet-stream",
                "size_human": human_size(target.stat().st_size),
                "b64": b64,
            }, ensure_ascii=False)

        return json.dumps({"ok": False, "error": f"不支持的操作: {op}"}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({
            "ok": False,
            "error": str(exc),
            "trace": traceback.format_exc()[-400:],
        }, ensure_ascii=False)


QUICK_ACTIONS = [
    ("自动按自然语言指令执行", "auto"),
    ("做成 16:9 演示 PPT（商务蓝）", "files.pptx:business"),
    ("做成 16:9 演示 PPT（极简灰）", "files.pptx:clean"),
    ("做成 16:9 演示 PPT（暖调纸）", "files.pptx:warm"),
    ("Word 一键标准公文排版", "word.restyle:"),
    ("合并/导出为一份 PDF", "files.pdf:"),
    ("PDF 提取指定页（如 1-2, 末页）", "pdf.extract:1-2, 末页"),
    ("PDF 加页码", "pdf.number:"),
    ("PDF 转成可编辑 Word", "pdf.word:"),
    ("CSV 转成 Excel（保护前导0与18位长号）", "sheet.xlsx:"),
    ("多份表格合并成一个 Excel（带来源列）", "sheet.merge:"),
    ("跨合同与结算单超支核查", "cross.audit:"),
    ("多张图片纵向拼成长图", "image.stitch:"),
    ("图片压缩体积", "image.compress:"),
    ("打包成 ZIP 归档", "files.zip:"),
]


def handle_direct_batch(uploaded_files: list[str] | None, action_choice: str, param_or_prompt: str, pasted_text: str) -> tuple[str, list[str]]:
    ws_dir = ensure_workspace("direct_batch", reset=False)
    names: list[str] = []
    if uploaded_files:
        for uf in uploaded_files:
            src = Path(uf)
            if src.exists():
                dest = unique_out_path(ws_dir, src.stem, src.suffix)
                shutil.copy2(src, dest)
                names.append(dest.name)

    if not names and not (pasted_text or "").strip():
        return "请先上传至少一份文件，或在左侧粘贴需要处理的文字。", []

    if action_choice == "auto" or not action_choice:
        res = run_natural_instruction(
            ws_dir,
            param_or_prompt.strip() or ("总结要点" if names else "整理排版并统计字数"),
            names,
            selected_text=pasted_text or "",
        )
    else:
        act_id, default_param = (action_choice.split(":", 1) + [""])[:2]
        use_param = param_or_prompt.strip() or default_param
        res = execute_action(ws_dir, act_id, names, param=use_param, selected_text=pasted_text or "")

    out_files = [c["path"] for c in res.get("created", []) if os.path.exists(c["path"])]
    return res.get("message", "处理完成"), out_files


# ---------------------------------------------------------------------------
# 1:1 Faithful ZhiDian v0.5 Desktop Workbench (Exact overlay.html / css / js)
# ---------------------------------------------------------------------------

WORKBENCH_DOC = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>指点 ZhiDian v0.5 桌面工作台</title>
<style>
  :root {
    --me: #2563eb;
    --me-hover: #1d4ed8;
    --ai: #4f46e5;
    --warn: #a76508;
    --bad: #c43737;
    --ink: #ffffff;
    --line: #e3e8f0;
    --text: #202c40;
    --dim: #718096;
    --soft: #f5f7fb;
    --blue-soft: #eff5ff;
    --font: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "WenQuanYi Zen Hei", system-ui, sans-serif;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
  html, body {
    width: 100%; height: 100%; overflow: hidden;
    font: 13px/1.5 var(--font); color: var(--text);
    user-select: none; -webkit-user-select: none;
    background: #0b1324;
  }
  button { font: inherit; color: inherit; cursor: pointer; }

  /* ---- Top Scenario & Engine Bar (42px, never overlaps desktop) ---- */
  #topbar {
    position: fixed; left: 0; right: 0; top: 0; height: 42px; z-index: 200;
    background: rgba(12, 19, 34, 0.96);
    border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 12px; gap: 8px; color: #e2e8f0;
  }
  .brand-pill { display: flex; align-items: center; gap: 7px; flex-shrink: 0; }
  .brand-mark {
    width: 24px; height: 24px; border-radius: 7px; background: var(--me);
    color: #fff; font-weight: 700; font-size: 15px; display: grid; place-items: center;
  }
  .brand-pill b { font-size: 13px; color: #f8fafc; }
  .brand-pill span { font-size: 10.5px; color: #94a3b8; }

  .quick-demos { display: flex; align-items: center; gap: 5px; overflow-x: auto; scrollbar-width: none; }
  .quick-demos::-webkit-scrollbar { display: none; }
  .qbtn {
    background: rgba(30, 41, 59, 0.9); color: #dbeafe;
    border: 1px solid rgba(148, 163, 184, 0.28);
    border-radius: 7px; padding: 4px 8px; font-size: 11px;
    white-space: nowrap; transition: background 0.14s, border-color 0.14s;
  }
  .qbtn:hover { background: rgba(37, 99, 235, 0.35); border-color: #60a5fa; color: #fff; }
  .qbtn.accent { background: rgba(37, 99, 235, 0.26); border-color: rgba(96, 165, 250, 0.65); color: #fff; font-weight: 600; }

  #llm-badge {
    display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: #cbd5e1;
    background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(148, 163, 184, 0.24);
    padding: 3px 9px; border-radius: 999px; flex-shrink: 0; max-width: 245px;
  }
  #llm-dot { width: 7px; height: 7px; border-radius: 50%; background: #10b981; flex-shrink: 0; }
  #llm-dot.busy { background: #f59e0b; animation: pulse 1s infinite; }
  #llm-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ---- Main Desktop Stage ---- */
  #desktop {
    position: fixed; left: 0; right: 0; top: 42px; bottom: 44px;
    background:
      radial-gradient(880px 520px at 16% 18%, rgba(37, 99, 235, 0.22), transparent 65%),
      radial-gradient(780px 480px at 84% 78%, rgba(16, 185, 129, 0.14), transparent 65%),
      linear-gradient(155deg, #0b1324 0%, #111c34 54%, #0d1729 100%);
    overflow: hidden;
  }
  body.pointing #desktop { cursor: crosshair; }

  /* ---- Authentic Pointing Backdrop (#veil, #halo, #snap, #drag, #pins from overlay.css) ---- */
  #veil {
    position: absolute; inset: 0; display: none; pointer-events: none; z-index: 40;
    box-shadow: inset 0 0 0 2px #2563eb99, inset 0 0 24px #2563eb22;
  }
  body.pointing #veil { display: block; }

  #halo {
    position: absolute; left: -100px; top: -100px; width: 30px; height: 30px;
    margin: -15px 0 0 -15px; border-radius: 50%;
    border: 2px solid #2563ebaa; box-shadow: 0 0 12px #2563eb45;
    pointer-events: none; display: none; z-index: 44;
  }
  body.pointing #halo { display: block; }

  #snap {
    position: absolute; display: none; pointer-events: none; z-index: 42;
    border: 2px solid var(--me); border-radius: 6px;
    background: rgba(37, 99, 235, 0.06);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.6), 0 0 16px rgba(37,99,235,0.25);
    transition: left 0.08s ease-out, top 0.08s ease-out, width 0.08s ease-out, height 0.08s ease-out;
  }
  body.pointing #snap.on { display: block; }
  #snap .tag {
    position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px;
    padding: 1px 8px; border-radius: 5px; background: var(--me); color: #fff;
    font-size: 10.5px; font-weight: 600; white-space: nowrap;
  }
  #snap.flip .tag { bottom: auto; top: 100%; margin: 4px 0 0; }
  #snap .c { position: absolute; width: 8px; height: 8px; border: 2.5px solid #fff; }
  #snap .tl { left: -3px; top: -3px; border-right: 0; border-bottom: 0; border-radius: 4px 0 0 0; }
  #snap .tr { right: -3px; top: -3px; border-left: 0; border-bottom: 0; border-radius: 0 4px 0 0; }
  #snap .bl { left: -3px; bottom: -3px; border-right: 0; border-top: 0; border-radius: 0 0 0 4px; }
  #snap .br { right: -3px; bottom: -3px; border-left: 0; border-top: 0; border-radius: 0 0 4px 0; }

  #drag {
    position: absolute; display: none; pointer-events: none; z-index: 58;
    border: 2px dashed var(--me); border-radius: 5px;
    background: rgba(37, 99, 235, 0.12);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
  }

  /* Subtle non-blocking top-right status hint (pointer-events: none, zero occlusion) */
  #hint {
    position: absolute; right: 14px; top: 10px; z-index: 35;
    background: rgba(255, 255, 255, 0.93); color: var(--text);
    border: 1px solid #dbe3ef; border-radius: 999px;
    padding: 4px 13px; font-size: 11px; box-shadow: 0 4px 16px rgba(15, 23, 42, 0.18);
    pointer-events: none; white-space: nowrap;
  }
  #hint kbd {
    background: var(--blue-soft); color: var(--me); border: 1px solid #bfdbfe;
    border-radius: 4px; padding: 0 5px; font-weight: 700; font-size: 10.5px;
  }

  /* ---- Desktop File Icons Grid (Left columns x: 14..372) ---- */
  #icongrid { position: absolute; inset: 0; pointer-events: none; z-index: 15; }
  .dicon {
    position: absolute; width: 104px; padding: 7px 5px 6px; border-radius: 10px;
    display: flex; flex-direction: column; align-items: center; text-align: center;
    cursor: pointer; pointer-events: auto;
    border: 1px solid transparent; transition: background 0.12s, border-color 0.12s, transform 0.12s;
  }
  .dicon:hover { background: rgba(255, 255, 255, 0.09); border-color: rgba(255, 255, 255, 0.16); }
  .dicon.selected {
    background: rgba(37, 99, 235, 0.28);
    border-color: rgba(96, 165, 250, 0.88);
    box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.4), 0 6px 16px rgba(15, 23, 42, 0.36);
  }
  .dicon.fresh { animation: iconPop 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
  @keyframes iconPop {
    0% { transform: scale(0.72); box-shadow: 0 0 0 10px rgba(52, 245, 197, 0.45); }
    100% { transform: scale(1); box-shadow: none; }
  }
  .dicon .glyph {
    width: 44px; height: 50px; border-radius: 10px; position: relative;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 10.5px; letter-spacing: 0.4px; color: #fff;
    box-shadow: 0 5px 12px rgba(0, 0, 0, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.25);
    margin-bottom: 4px;
  }
  .glyph.pdf { background: linear-gradient(145deg, #ef4444, #b91c1c); }
  .glyph.excel, .glyph.delimited { background: linear-gradient(145deg, #10b981, #047857); }
  .glyph.word { background: linear-gradient(145deg, #3b82f6, #1d4ed8); }
  .glyph.pptx { background: linear-gradient(145deg, #f97316, #c2410c); }
  .glyph.markdown, .glyph.text { background: linear-gradient(145deg, #64748b, #334155); }
  .glyph.image { background: linear-gradient(145deg, #8b5cf6, #6d28d9); }
  .glyph.archive { background: linear-gradient(145deg, #eab308, #a16207); }
  .dicon .new-dot {
    position: absolute; right: -5px; top: -5px; background: #10b981; color: #022c22;
    font-size: 8.5px; font-weight: 900; padding: 1px 4px; border-radius: 5px;
  }
  .dicon .fname {
    font-size: 11px; line-height: 1.28; color: #f1f5f9; font-weight: 500;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.88);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; word-break: break-all; width: 100%;
  }
  .dicon .fmeta { font-size: 9.5px; color: #94a3b8; margin-top: 1px; }

  /* ---- @1 @2 Referent Pins & Bottom #dock (1:1 from overlay.css) ---- */
  #pins { position: absolute; inset: 0; pointer-events: none; z-index: 41; }
  .pin {
    position: absolute; border: 2px solid var(--me); border-radius: 6px;
    background: rgba(37, 99, 235, 0.08);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.65);
    animation: stamp 0.24s ease-out;
  }
  .pin b {
    position: absolute; left: -2px; top: -2px; padding: 0 7px;
    border-radius: 6px 0 6px 0; background: var(--me); color: #fff; font-size: 11px;
  }
  @keyframes stamp { from { transform: scale(1.06); } to { transform: none; } }

  #dock {
    position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 75;
    display: flex; align-items: center; gap: 7px; padding: 5px 9px;
    background: #fff; border: 1px solid var(--line); border-radius: 14px;
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.22); max-width: 82%;
  }
  #dock .brand { display: inline-flex; fill: var(--me); flex-shrink: 0; }
  #chips { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 6px 0 8px;
    border-radius: 9px; background: #f8fafd; border: 1px solid var(--line); white-space: nowrap; font-size: 11.5px;
  }
  .chip.sel { background: var(--blue-soft); border-color: #b8cffc; }
  .chip b { color: var(--me); font-weight: 700; }
  .chip span.l { max-width: 115px; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .chip .st { width: 6px; height: 6px; border-radius: 50%; background: var(--me); }
  button.ghost {
    background: transparent; border: 0; padding: 3px 7px; border-radius: 6px; color: var(--dim); font-size: 11.5px;
  }
  button.ghost:hover { background: var(--soft); color: var(--text); }

  /* ---- Draggable Desktop Windows (.appwin in center lane x: 388+) ---- */
  #winlayer { position: absolute; inset: 0; pointer-events: none; z-index: 25; }
  .appwin {
    position: absolute; pointer-events: auto; background: #ffffff;
    border: 1px solid #cbd5e1; border-radius: 12px;
    box-shadow: 0 20px 50px rgba(2, 6, 23, 0.5), 0 4px 12px rgba(2, 6, 23, 0.2);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .appwin.active { border-color: #93c5fd; }
  .winbar {
    height: 36px; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 8px 0 11px; cursor: grab; flex-shrink: 0; gap: 6px;
  }
  .winbar:active { cursor: grabbing; }
  .wintitle { font-size: 12px; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap; min-width: 0; }
  .wintitle span:first-child { overflow: hidden; text-overflow: ellipsis; }
  .wintitle .zbadge {
    font-size: 9.5px; font-weight: 600; color: #0369a1; background: #e0f2fe;
    padding: 1px 5px; border-radius: 4px; flex-shrink: 0;
  }
  .winbtns { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
  .winbtns button {
    border: 1px solid #dbe3ef; background: #fff; color: #475569;
    border-radius: 6px; padding: 3px 7px; font-size: 11px; white-space: nowrap;
  }
  .winbtns button:hover { background: var(--blue-soft); color: var(--me); border-color: #bfdbfe; }
  .winbtns button.close:hover { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
  .winbody {
    flex: 1; overflow: auto; padding: 11px 13px; background: #fff;
    user-select: text; -webkit-user-select: text; font-size: 12.5px; color: #1e293b;
  }

  .preview-sheet-title { font-weight: 700; font-size: 12px; color: #334155; margin-bottom: 8px; }
  .preview-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .preview-table th { background: #1e3a8a; color: #fff; padding: 6px 9px; text-align: left; font-weight: 700; position: sticky; top: 0; white-space: nowrap; }
  .preview-table td { padding: 6px 9px; border-bottom: 1px solid #e2e8f0; color: #1e293b; white-space: nowrap; }
  .preview-table tr:nth-child(even) td { background: #f8fafc; }
  .preview-table tr.alert-row td { background: #fee2e2 !important; color: #b91c1c; font-weight: 700; }
  .preview-docx h4 { font-size: 13.5px; color: #172554; margin: 10px 0 4px; display: flex; align-items: center; gap: 8px; }
  .preview-docx p { font-size: 12.5px; line-height: 1.7; color: #334155; margin-bottom: 6px; text-indent: 2em; }
  .fmt-tag { font-size: 10px; font-weight: 600; background: #eff6ff; color: #2563eb; padding: 1px 6px; border-radius: 4px; text-indent: 0; }
  .preview-pptx { display: flex; flex-direction: column; gap: 9px; font-size: 12px; color: #475569; }
  .slide-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 9px 11px; background: #f8fafc; }
  .slide-num { font-size: 10.5px; font-weight: 800; color: var(--me); margin-bottom: 4px; }
  .preview-pre { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.6; color: #1e293b; }
  .preview-pages { display: flex; flex-direction: column; gap: 10px; align-items: center; background: #f1f5f9; padding: 10px; border-radius: 8px; }
  .preview-pages img { max-width: 100%; border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,0.14); background: #fff; }

  /* ---- Shared Panel Surface (.panel from overlay.css) ---- */
  .panel {
    position: absolute; background: var(--ink); border: 1px solid var(--line);
    border-radius: 16px; box-shadow: 0 14px 38px rgba(30, 48, 80, 0.24), 0 2px 8px rgba(30, 48, 80, 0.09);
    cursor: default; animation: panelArrive 150ms ease-out;
  }
  @keyframes panelArrive { from { opacity: 0.25; } to { opacity: 1; } }

  /* ---- 1:1 Authentic #actpill (32x32 Little Blue Pointer Arrow on Single Click!) ---- */
  #actpill {
    width: 34px; height: 34px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 10px; border: 1.5px solid #93c5fd;
    background: #ffffff; fill: var(--me);
    box-shadow: 0 6px 18px rgba(15, 23, 42, 0.28), 0 0 0 4px rgba(37, 99, 235, 0.16);
    z-index: 95; cursor: pointer;
    transition: transform 0.14s, background 0.14s, border-color 0.14s;
  }
  #actpill:hover {
    transform: scale(1.1); border-color: var(--me); background: var(--blue-soft);
  }
  #actpill::after {
    content: ''; position: absolute; inset: -5px; border-radius: 13px;
    border: 2px solid rgba(37, 99, 235, 0.45); pointer-events: none;
    animation: pillPulse 1.4s ease-out infinite;
  }
  @keyframes pillPulse {
    0% { transform: scale(0.88); opacity: 0.9; }
    100% { transform: scale(1.28); opacity: 0; }
  }

  /* ---- 1:1 Authentic #act (376px Idle Office Action Card from overlay.css) ---- */
  #act {
    width: 376px; max-width: calc(100% - 24px); max-height: calc(100% - 20px);
    overflow-y: auto; padding: 14px 15px; z-index: 88;
  }
  #act header {
    display: flex; align-items: center; gap: 9px; margin: 0 0 11px; cursor: grab;
  }
  #act header .ico {
    width: 16px; height: 16px; padding: 5px; box-sizing: content-box;
    border-radius: 9px; background: var(--blue-soft); fill: none;
    stroke: var(--me); stroke-width: 1.6; stroke-linejoin: round; flex-shrink: 0;
  }
  .action-heading { display: flex; flex-direction: column; min-width: 0; flex: 1; gap: 1px; }
  .eyebrow { font-size: 9.5px; color: #8a96a8; }
  #actwhat { font-size: 12px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #actbtns { display: flex; flex-wrap: wrap; gap: 7px; }
  #actbtns button, #actdone button, #actparam button {
    font-size: 12px; color: var(--text); background: #fff;
    border: 1px solid var(--line); border-radius: 9px; padding: 7px 11px;
  }
  #actbtns > button:first-child, #actbtns > .actgroup:first-child > button, #actdone button.main, #actparam button.main {
    background: var(--blue-soft); border-color: #c9dafe; color: var(--me); font-weight: 600;
  }
  #actbtns button:hover, #actdone button:hover, #actparam button:hover { background: #e7efff; border-color: #b8cffc; }
  #actbtns .actgroup { display: inline-flex; align-items: stretch; }
  #actbtns .actgroup button { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  #actbtns .actgroup select.actselect {
    font-size: 11.5px; color: #536686; background: #f8fafd;
    border: 1px solid var(--line); border-left: 0; border-radius: 0 9px 9px 0;
    padding: 0 6px; cursor: pointer; outline: 0;
  }
  #actbtns .rest { display: flex; flex-wrap: wrap; gap: 7px; flex-basis: 100%; }
  #actbtns button.more { color: var(--dim); }
  #actparam { display: flex; align-items: center; gap: 6px; padding-top: 2px; }
  #actparam input {
    flex: 1; min-width: 0; background: #f8fafd; border: 1px solid #93c5fd;
    border-radius: 8px; padding: 6px 9px; color: var(--text); font: 12.5px var(--font); outline: 0;
    user-select: text; -webkit-user-select: text;
  }
  #actstatus { display: flex; align-items: center; gap: 9px; color: var(--text); font-size: 12.5px; padding: 4px 0 2px; }
  #actdone { font-size: 12.5px; line-height: 1.6; color: var(--text); }
  #actdone .name { color: var(--me); font-weight: 700; word-break: break-all; }
  #actdone .note { color: var(--dim); font-size: 11.5px; margin-top: 3px; white-space: pre-wrap; max-height: 140px; overflow-y: auto; user-select: text; }
  #actdone.error .name { color: var(--bad); }
  #actdone .row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }

  /* ---- 1:1 Authentic #ask (340px F8 Assistant Panel from overlay.html / overlay.css) ---- */
  #ask {
    width: 344px; max-width: calc(100% - 24px); max-height: calc(100% - 20px);
    overflow-y: auto; padding: 12px 13px; border-radius: 14px; z-index: 86;
    scrollbar-width: thin;
  }
  .assistant-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; cursor: grab; }
  .appmark {
    display: grid; place-items: center; width: 26px; height: 26px;
    border-radius: 7px; color: #fff; background: var(--me); font-size: 18px; font-weight: 700; flex-shrink: 0;
  }
  .assistant-title { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .assistant-title b { font-size: 13px; color: var(--text); }
  .assistant-title span { font-size: 9.5px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #selectionhint { margin: 4px 0 8px; color: var(--dim); font-size: 11px; line-height: 1.55; }

  #sendlist { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-bottom: 7px; }
  #sendlist .lead { color: var(--dim); font-size: 10.5px; }
  .send {
    display: inline-flex; align-items: center; gap: 5px; height: 25px; padding: 0 6px;
    border-radius: 7px; border: 1px solid #c9dafe; background: var(--blue-soft); font-size: 11px;
  }
  .send b { color: var(--me); }
  .send.ghostchip { border: 0; color: #577099; }

  #contextcard { border: 1px solid var(--line); border-radius: 9px; padding: 8px 9px; background: #fafbfd; margin-bottom: 7px; }
  .context-source { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .context-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--me); }
  .context-file { display: flex; align-items: center; gap: 7px; padding-top: 5px; min-width: 0; font-size: 11px; }
  .file-type {
    flex-shrink: 0; border-radius: 4px; font-size: 8.5px; font-weight: 700;
    color: #1d4ed8; background: #dbeafe; padding: 2px 5px; min-width: 32px; text-align: center;
  }
  .context-warning {
    font-size: 10.5px; color: var(--warn); background: #fff8e9; border: 1px solid #fde68a;
    padding: 5px 8px; margin-top: 7px; border-radius: 6px; line-height: 1.45;
  }
  .section-label { display: flex; align-items: center; justify-content: space-between; margin: 7px 0 5px; font-size: 10px; color: #53627b; font-weight: 600; }
  .context-action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
  .context-action {
    display: flex; justify-content: space-between; align-items: center; gap: 5px;
    min-width: 0; text-align: left; padding: 7px 8px; border: 1px solid var(--line);
    border-radius: 7px; background: #fff; color: #455570; font-size: 11px;
  }
  .context-action:hover { border-color: #b8cffc; background: var(--blue-soft); color: var(--me); }
  .context-action > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .context-param {
    display: flex; flex-wrap: wrap; gap: 6px; padding: 9px; border: 1px solid #cdddf8;
    border-radius: 9px; background: #f7faff; margin-top: 8px;
  }
  .context-param label { flex-basis: 100%; font-size: 10.5px; font-weight: 600; color: #1e3a8a; }
  .context-param input, .context-param select {
    flex: 1; min-width: 0; border: 1px solid #c9d5e8; background: #fff; color: var(--text);
    border-radius: 6px; padding: 5px 7px; font: 11.5px var(--font); user-select: text;
  }
  .context-status {
    border: 1px solid var(--line); border-radius: 9px; padding: 8px 9px; margin-top: 8px;
    font-size: 11px; background: #f8fafd; line-height: 1.6;
  }
  .context-status.error { background: #fff7f5; border-color: #f2d7ce; color: #a95643; }
  .resfile-row {
    display: flex; align-items: center; justify-content: space-between; gap: 5px;
    padding: 4px 6px; margin-top: 5px; border-radius: 6px; background: var(--blue-soft); border: 1px solid #bfdbfe;
  }
  .resfile-row b { font-size: 10.5px; color: #1e40af; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mini-btn {
    border: 1px solid #93c5fd; background: #fff; color: var(--me);
    border-radius: 5px; padding: 2px 6px; font-size: 10px; font-weight: 600;
  }
  .mini-btn.primary { background: var(--me); color: #fff; border-color: var(--me); }

  /* Composer & Voice Orb (#voicepanel from overlay.css) */
  .composer { border: 1px solid #cfd9e9; background: #fafcff; border-radius: 9px; padding: 8px; margin-top: 8px; }
  .composer:focus-within { border-color: #8aaff8; box-shadow: 0 0 0 3px #2563eb14; }
  #q {
    display: block; width: 100%; border: 0; outline: 0; background: transparent;
    min-height: 32px; max-height: 66px; resize: none; font: 12px/1.55 var(--font); color: var(--text);
    user-select: text; -webkit-user-select: text;
  }
  .composer-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; gap: 6px; }
  #inputhint { font-size: 9.5px; color: #96a0af; }
  .composer-actions { display: flex; align-items: center; gap: 6px; }
  #qmic {
    display: grid; place-items: center; width: 30px; height: 30px;
    border: 1px solid #dce6f6; border-radius: 8px; background: #f2f6ff; color: #5273b2;
  }
  #qmic:hover { background: #e9f0ff; border-color: #aec7f8; color: var(--me); }
  #qmic[data-state="listening"] { color: #fff; background: linear-gradient(135deg, #2563eb, #6366f1); border-color: #5478eb; }
  #qmic svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  #qsend, .primary-button {
    border: 1px solid var(--me); border-radius: 7px; background: var(--me); color: #fff;
    padding: 5px 10px; font-size: 11.5px; font-weight: 600;
  }
  #qsend:hover, .primary-button:hover { background: var(--me-hover); }

  #voicepanel {
    display: flex; align-items: center; gap: 10px; position: relative;
    padding: 9px 22px 8px 4px; margin: 7px 0 3px; border-top: 1px solid #e2eafa;
  }
  .voice-orb {
    width: 36px; height: 36px; border-radius: 38%; display: grid; place-items: center; color: #fff; flex-shrink: 0;
    background: linear-gradient(140deg, #2876ee 12%, #5155ec 62%, #8b5cf6);
    box-shadow: 0 4px 14px rgba(82, 101, 233, 0.35);
    animation: voiceMorph 1.2s ease-in-out infinite alternate;
  }
  @keyframes voiceMorph { from { transform: scale(0.95); } to { transform: scale(1.06); } }
  .voice-body { flex: 1; min-width: 0; }
  .voice-heading { display: flex; justify-content: space-between; font-size: 11px; font-weight: 600; color: #425a8b; }
  #voice-wave { display: flex; align-items: center; gap: 2.5px; height: 20px; margin: 3px 0; }
  #voice-wave i {
    display: block; width: 3px; height: 16px; border-radius: 3px;
    background: linear-gradient(#5da8fa, #7070ee);
    animation: waveBounce 0.65s ease-in-out infinite alternate;
  }
  #voice-wave i:nth-child(2n) { animation-delay: -0.25s; height: 11px; }
  #voice-wave i:nth-child(3n) { animation-delay: -0.42s; height: 18px; }
  @keyframes waveBounce { from { transform: scaleY(0.28); } to { transform: scaleY(1); } }
  #voice-stop { border: 0; background: #eaf0ff; color: #255dce; font-size: 10.5px; font-weight: 600; padding: 3px 8px; border-radius: 5px; }
  #voice-cancel { position: absolute; right: 0; top: 6px; }

  .compact-options { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-top: 8px; color: var(--dim); font-size: 10.5px; flex-wrap: wrap; }
  .compact-options > label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
  #quickadvanced { flex: 1; text-align: right; min-width: 0; }
  #quickadvanced > summary { cursor: pointer; font-size: 10.5px; }
  #quickadvanced[open] { flex-basis: 100%; }
  .advanced-popover { text-align: left; border-top: 1px solid var(--line); padding-top: 8px; margin-top: 6px; }
  .mode-tabs { display: flex; padding: 3px; gap: 4px; background: var(--soft); border: 1px solid #edf0f5; border-radius: 9px; margin-bottom: 7px; }
  .mode-tabs button { flex: 1; padding: 5px 8px; border: 0; border-radius: 6px; color: var(--dim); background: transparent; font-size: 11px; font-weight: 600; }
  .mode-tabs button[aria-selected="true"] { color: var(--me); background: #fff; box-shadow: 0 1px 3px rgba(32,60,102,0.1); }
  #asktools { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
  #asktools button.tool { border: 1px solid var(--line); border-radius: 6px; background: var(--soft); color: #536686; padding: 4px 7px; font-size: 10.5px; }
  #asktools button.tool:hover { background: var(--blue-soft); color: var(--me); border-color: #b8cffc; }
  #hud { font-size: 10px; color: var(--dim); border-top: 1px solid var(--line); padding-top: 6px; display: flex; justify-content: space-between; }

  /* ---- 1:1 Authentic #bubble (Answer Bubble) & #aicursor + #marks ---- */
  #bubble {
    width: 364px; max-width: calc(100% - 24px); padding: 13px 15px; z-index: 89;
  }
  #bubble header { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; cursor: grab; }
  #bubble .who { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: #536686; font-weight: 600; }
  #bubble .who .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--me); }
  #bq { font-size: 11px; color: #8a96a8; padding-bottom: 6px; border-bottom: 1px solid var(--line); margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #btext { font-size: 12px; line-height: 1.6; white-space: pre-wrap; max-height: 108px; overflow-y: auto; user-select: text; color: var(--text); }
  #btext .ref { color: var(--me); font-weight: 700; }
  .badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 18px; height: 18px; padding: 0 5px; margin: 0 2px;
    border-radius: 9px; background: var(--blue-soft); color: var(--me); font-size: 11px; font-weight: 700;
  }
  #bfiles { margin-top: 7px; }
  #bfoot { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--line); color: var(--dim); font-size: 10.5px; display: flex; gap: 8px; flex-wrap: wrap; }

  #marks { position: absolute; inset: 0; pointer-events: none; z-index: 78; }
  .mark { position: absolute; left: 0; top: 0; }
  .mark .ring {
    position: absolute; left: -17px; top: -17px; width: 34px; height: 34px;
    border-radius: 50%; border: 3px solid var(--ai);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.7), 0 0 18px rgba(79, 70, 229, 0.7);
    animation: ping 1.2s ease-out infinite;
  }
  @keyframes ping { 0% { transform: scale(0.45); opacity: 1; } 100% { transform: scale(1.45); opacity: 0; } }
  .mark .lab {
    position: absolute; left: 18px; top: -30px; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 9px 2px 4px; border-radius: 999px;
    background: #fff; border: 1.5px solid #818cf8; color: var(--text);
    font-size: 11.5px; font-weight: 600; box-shadow: 0 6px 18px rgba(15,23,42,0.25);
  }

  #aicursor {
    position: absolute; left: 0; top: 0; margin: -4px 0 0 -24px;
    display: none; pointer-events: none; z-index: 82;
    fill: var(--ai); stroke: #ffffff; stroke-width: 1.6; stroke-linejoin: round;
    filter: drop-shadow(0 4px 10px rgba(79, 70, 229, 0.65));
    transition: transform 0.68s cubic-bezier(0.22, 0.9, 0.28, 1);
  }
  #aicursor.on { display: block; }

  /* Toasts */
  #toasts { position: absolute; right: 14px; bottom: 12px; z-index: 120; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
  .toast {
    background: #fff; border: 1px solid var(--line); border-left: 3px solid var(--me);
    border-radius: 9px; padding: 7px 12px; font-size: 12px; color: var(--text);
    box-shadow: 0 8px 24px rgba(15, 23, 42, 0.24);
  }

  /* ---- Bottom Taskbar (44px, zero overlap) ---- */
  #taskbar {
    position: fixed; left: 0; right: 0; bottom: 0; height: 44px; z-index: 200;
    background: rgba(12, 19, 34, 0.96); border-top: 1px solid rgba(148, 163, 184, 0.2);
    display: flex; align-items: center; justify-content: space-between; padding: 0 12px; gap: 8px;
  }
  .tb-group { display: flex; align-items: center; gap: 6px; overflow-x: auto; scrollbar-width: none; }
  .tbtn {
    display: inline-flex; align-items: center; gap: 5px;
    background: rgba(30, 41, 59, 0.92); color: #e2e8f0;
    border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 8px;
    padding: 5px 10px; font-size: 11.5px; font-weight: 600; white-space: nowrap;
  }
  .tbtn:hover { background: rgba(51, 65, 85, 0.96); border-color: #94a3b8; }
  .tbtn.on {
    background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff;
    border-color: #60a5fa; box-shadow: 0 0 14px rgba(37, 99, 235, 0.45);
  }
  .tbtn.upload { background: rgba(16, 185, 129, 0.18); border-color: rgba(16, 185, 129, 0.5); color: #a7f3d0; cursor: pointer; }
  .tbtn.upload:hover { background: rgba(16, 185, 129, 0.3); color: #fff; }
  .tb-right { font-size: 11px; color: #94a3b8; flex-shrink: 0; }

  .spin {
    display: inline-block; width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid #dbe6fa; border-top-color: var(--me); animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { opacity: 0.4; } }
</style>
</head>
<body class="idle">

  <!-- Top Scenario & Engine Bar -->
  <div id="topbar">
    <div class="brand-pill">
      <div class="brand-mark">↗</div>
      <div>
        <b>指点 ZhiDian v0.5</b>
        <span>单击文件出小箭头 · 按 F8 框选与双光标</span>
      </div>
    </div>

    <div class="quick-demos">
      <button class="qbtn accent" id="demo-arrow-pptx" type="button" onclick="demoScenario('arrow_pptx')">⚡ 演示：单击小箭头转PPT</button>
      <button class="qbtn" id="demo-pdf" type="button" onclick="demoScenario('pdf')">⚡ PDF抽第1-2与末页</button>
      <button class="qbtn" id="demo-restyle" type="button" onclick="demoScenario('restyle')">⚡ Word公文排版</button>
      <button class="qbtn" id="demo-occlusion" type="button" onclick="demoScenario('occlusion')">⚡ F8窗口防遮挡框选</button>
      <button class="qbtn" id="demo-audit" type="button" onclick="demoScenario('audit')">⚡ @1+@2双光标查超支</button>
    </div>

    <div id="llm-badge">
      <span id="llm-dot"></span>
      <span id="llm-text">本地引擎初始化中…</span>
    </div>
  </div>

  <!-- Main Desktop Stage -->
  <div id="desktop">
    <div id="veil"></div>
    <div id="halo"></div>
    <div id="snap"><span class="tag"></span><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i></div>
    <div id="drag"></div>
    <div id="hint">单击桌面文件或划选文字 → 弹出<b>小箭头 ↗</b> · 按 <kbd>F8</kbd> 拖拽框选 / 右键 <b>@1 @2</b></div>

    <div id="icongrid"></div>
    <div id="pins"></div>
    <div id="winlayer"></div>
    <div id="marks"></div>

    <!-- 1:1 Authentic Secondary AI Cursor (#aicursor from overlay.html) -->
    <svg id="aicursor" viewBox="0 0 28 28" width="32" height="32" aria-hidden="true">
      <path d="M24 3 L4 11.5 L12.5 14.8 L15.8 23.5 Z"/>
    </svg>

    <!-- 1:1 Authentic Single-Click Little Blue Arrow Pill (#actpill from overlay.html) -->
    <button id="actpill" class="panel" hidden type="button" title="指点：对选中的内容执行操作（点击或悬停展开）" aria-label="展开指点操作">
      <svg viewBox="0 0 28 28" width="16" height="16" aria-hidden="true">
        <path d="M4 3 L24 11.5 L15.5 14.8 L12.2 23.5 Z"/>
      </svg>
    </button>

    <!-- 1:1 Authentic Idle Office Action Card (#act from overlay.html) -->
    <section id="act" class="panel" hidden>
      <header id="acthead">
        <svg class="ico" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6.2L15.5 7v10.5h-10.5z M11 2.5V7h4.5"/></svg>
        <div class="action-heading">
          <span class="eyebrow">对选中内容执行操作</span>
          <span id="actwhat"></span>
        </div>
        <button id="actpin" class="ghost" type="button" title="钉为 @n 跨文档引用">+@暂存</button>
        <button id="actask" class="ghost" type="button" title="转入 F8 助手自由提问">F8 提问</button>
        <button id="actclose" class="ghost" type="button" title="关闭 (Esc)">✕</button>
      </header>
      <div id="actbtns"></div>
      <div id="actparam" hidden></div>
      <div id="actstatus" hidden><i class="spin"></i><span id="actmsg"></span></div>
      <div id="actdone" hidden></div>
    </section>

    <!-- 1:1 Authentic F8 Assistant Panel (#ask from overlay.html) -->
    <section id="ask" class="panel" hidden>
      <header id="askhead" class="assistant-head">
        <span class="appmark" aria-hidden="true">↗</span>
        <div class="assistant-title">
          <b>指点</b>
          <span id="compactmode">基础办公 · 自动匹配本机资源</span>
        </div>
        <button id="askpin" class="ghost" type="button" title="将当前选中对象暂存为 @n">+@暂存</button>
        <button id="askclose" class="ghost" type="button" title="退出指向（Esc）" aria-label="退出指向">✕</button>
      </header>
      <p id="selectionhint">按住左键拖拽框住桌面图标，或单击截图提问</p>
      <div id="sendlist" hidden></div>
      <div id="contextcard" hidden></div>
      <div class="section-label" id="askseclabel"><span id="quicklabel">处理这些文件</span><span id="quicknote">100% 本地确定性执行</span></div>
      <div id="contextactions"></div>
      <div id="askparam" class="context-param" hidden></div>
      <div id="askstatus" class="context-status" hidden></div>

      <div class="composer">
        <textarea id="q" rows="2" maxlength="2000" placeholder="例如：做成暖调纸PPT / 对比 @1 和 @2 哪行超支了指给我看"></textarea>
        <div id="voicepanel" data-state="idle" hidden>
          <div class="voice-orb" aria-hidden="true">🎤</div>
          <div class="voice-body">
            <div class="voice-heading"><b id="voice-status">正在听你说</b><span id="voice-time">00 / 60 秒</span></div>
            <div id="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <button id="voice-stop" type="button">结束并转写</button>
          </div>
          <button id="voice-cancel" class="ghost" type="button" title="取消语音输入">✕</button>
        </div>
        <div class="composer-foot">
          <span id="inputhint">Enter 发送 · Shift+Enter 换行</span>
          <div class="composer-actions">
            <button id="qmic" type="button" title="语音输入：单击开始/结束" aria-label="语音输入">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11v1a6.5 6.5 0 0 0 13 0v-1M12 18.5V22M8.5 22h7"/></svg>
            </button>
            <button id="qsend" type="button">发送 <span>↑</span></button>
          </div>
        </div>
      </div>

      <div class="compact-options">
        <label><input type="checkbox" id="quickvoice" checked />语音输入</label>
        <details id="quickadvanced">
          <summary>高级设置</summary>
          <div class="advanced-popover">
            <div id="inputmodes" class="mode-tabs" role="tablist">
              <button type="button" id="contextmode" role="tab" aria-selected="true" data-input-mode="context">文件操作</button>
              <button type="button" id="screenmode" role="tab" aria-selected="false" data-input-mode="screen">截图问答</button>
            </div>
            <div id="asktools">
              <button type="button" class="tool" id="tool-copy">复制截图</button>
              <button type="button" class="tool" id="tool-save">保存图片</button>
              <button type="button" class="tool" id="tool-ocr">提取文字</button>
              <button type="button" class="tool" id="tool-scope-minus">范围 −</button>
              <button type="button" class="tool" id="tool-scope-plus">范围 +</button>
            </div>
            <div id="hud"><span id="hud-model">Qwen3.5-4B</span><span>全程在本机容器</span></div>
          </div>
        </details>
      </div>
    </section>

    <!-- 1:1 Authentic Answer Bubble (#bubble from overlay.html) -->
    <section id="bubble" class="panel" hidden>
      <header id="bubblehead">
        <span class="who"><i class="dot"></i><b id="bwho">指点 · Qwen3.5-4B 本地引擎</b></span>
        <span style="flex:1"></span>
        <button id="bcopy" class="ghost" type="button" title="复制回答">复制</button>
        <button id="bclose" class="ghost" type="button" title="关闭">✕</button>
      </header>
      <div id="bq"></div>
      <div id="btext"></div>
      <div id="bfiles"></div>
      <footer id="bfoot"></footer>
    </section>

    <!-- 1:1 Authentic Bottom Referent Dock (#dock from overlay.html) -->
    <nav id="dock" hidden>
      <span class="brand" title="已钉住的引用"><svg viewBox="0 0 28 28" width="15" height="15"><path d="M4 3 L24 11.5 L15.5 14.8 L12.2 23.5 Z"/></svg></span>
      <div id="chips"></div>
      <button id="dclear" class="ghost" type="button" title="释放全部引用">清空</button>
    </nav>

    <div id="toasts"></div>
  </div>

  <!-- Bottom Taskbar -->
  <div id="taskbar">
    <div class="tb-group">
      <button class="tbtn" id="f8btn" type="button" onclick="togglePointing()">🎯 按 F8 进入指点框选</button>
      <label class="tbtn upload" id="uploadlabel" title="上传您电脑里的真实文件到指点桌面">
        ➕ 上传文件上桌
        <input id="filepicker" type="file" multiple accept=".pdf,.docx,.xlsx,.csv,.tsv,.md,.txt,.png,.jpg,.jpeg,.webp" style="display:none" onchange="uploadUserFiles(this.files)" />
      </label>
      <button class="tbtn" id="btn-open-sheet" type="button" onclick="openDefaultSheet()">📊 打开虚拟结算表</button>
      <button class="tbtn" id="btn-open-pad" type="button" onclick="openScratchpad()">✂️ 划词选区工作窗</button>
      <button class="tbtn" id="btn-reset" type="button" onclick="resetWorkspace()">🎲 重新随机生成样本</button>
    </div>
    <div class="tb-right">
      <span id="filecounter">桌面共 8 份随机虚拟测试样本</span>
    </div>
  </div>

<script>
  const SESSION_ID = 'ws_' + Math.random().toString(36).slice(2, 10);

  function resolveApiBase() {
    try {
      const href = window.parent.location.href.split('?')[0].split('#')[0];
      return href.replace(/\/+$/, '');
    } catch (e) {
      return '';
    }
  }
  const API_BASE = resolveApiBase();

  async function callRpc(payload) {
    const body = JSON.stringify({ data: [JSON.stringify({ session_id: SESSION_ID, ...payload })] });
    const postRes = await fetch(`${API_BASE}/gradio_api/call/zhidian_rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!postRes.ok) throw new Error(`网关请求失败 (${postRes.status})`);
    const { event_id } = await postRes.json();
    const sseRes = await fetch(`${API_BASE}/gradio_api/call/zhidian_rpc/${event_id}`);
    const sseText = await sseRes.text();
    const lines = sseText.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('event: complete')) {
        const dataLine = lines[i + 1] || '';
        if (dataLine.startsWith('data: ')) {
          const arr = JSON.parse(dataLine.slice(6));
          return JSON.parse(arr[0]);
        }
      }
      if (lines[i].startsWith('event: error')) throw new Error('后端执行返回错误');
    }
    throw new Error('未收到完整响应');
  }

  // ---- Core State (Matching src/renderer/overlay.js S) ----
  const S = {
    mode: 'idle',            // 'idle' (normal desktop) | 'pointing' (F8 active)
    inputMode: 'context',    // 'context' (file/text ops) | 'screen' (visual QA)
    workspace: [],
    scratchpadText: '',
    batchId: 0,
    selectedNames: [],
    selectedText: '',
    lastAnchor: { x: 140, y: 80, w: 104, h: 96 },
    offers: [],
    summary: '',
    refs: [],                // [{ handle: '@1', files: [...], box: {x,y,w,h}, label: '...' }]
    windows: [],             // [{ id, name, title, x, y, w, h, el }]
    snapScope: 0,            // -1, 0, +1 scope steps for #snap
    snapBox: { x: 16, y: 14, w: 236, h: 244 },
    cursor: { x: 220, y: 160 },
    topZ: 90,
    winZ: 10,
    pillHoverTimer: 0,
    voiceTimer: 0,
    voiceSec: 0,
  };

  const $ = (id) => document.getElementById(id);
  const desktopEl = $('desktop');
  const iconGridEl = $('icongrid');
  const winLayerEl = $('winlayer');
  const pinsEl = $('pins');
  const marksEl = $('marks');
  const dragEl = $('drag');
  const snapEl = $('snap');
  const haloEl = $('halo');
  const actPillEl = $('actpill');
  const actEl = $('act');
  const askEl = $('ask');
  const bubbleEl = $('bubble');
  const dockEl = $('dock');
  const aiCursorEl = $('aicursor');

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rectsOverlap(a, b, pad = 6) {
    return !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
  }
  function pointInRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }

  function toast(text) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = text;
    $('toasts').appendChild(node);
    setTimeout(() => node.remove(), 3200);
  }

  function bringToFront(el) {
    S.topZ += 1;
    el.style.zIndex = String(S.topZ);
  }

  function relRect(el) {
    const d = desktopEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - d.left, y: r.top - d.top, w: r.width, h: r.height };
  }

  // ---- Zero-Occlusion Collision-Free Placement Engine ----
  function getObstacleRects(excludeEl) {
    const hard = [];
    const soft = [];
    // Never cover open window title/button bars (.winbar) so window buttons are 100% clickable; avoid window bodies too when possible
    S.windows.forEach(w => {
      hard.push({ x: w.x, y: w.y, w: w.w, h: 42 });
      soft.push({ x: w.x, y: w.y + 42, w: w.w, h: Math.max(0, w.h - 42) });
    });
    // Never cover other open floating panels or #dock (measured accurately via getBoundingClientRect)
    [actEl, askEl, bubbleEl, dockEl].forEach(p => {
      if (p && p !== excludeEl && !p.hidden) {
        const rr = relRect(p);
        if (rr.w > 4 && rr.h > 4) hard.push(rr);
      }
    });
    return { hard, soft };
  }

  function placeSmartPanel(panelEl, anchor) {
    if (panelEl.dataset.moved === '1') return;
    const W = desktopEl.clientWidth || 1280;
    const H = desktopEl.clientHeight || 660;
    const pw = panelEl.offsetWidth || (panelEl === actEl ? 376 : panelEl === bubbleEl ? 364 : 344);
    const ph = Math.min(panelEl.offsetHeight || 280, H - 20);
    const a = anchor || S.lastAnchor || { x: 140, y: 60, w: 100, h: 90 };
    const { hard, soft } = getObstacleRects(panelEl);

    const rawCandidates = [
      { x: a.x + a.w + 14, y: a.y },
      { x: W - pw - 14, y: 44 },
      { x: 372, y: 342 },
      { x: 14, y: 368 },
      { x: a.x - pw - 14, y: a.y },
      { x: a.x, y: a.y + a.h + 14 },
      { x: a.x, y: a.y - ph - 14 },
      { x: W - pw - 14, y: H - ph - 16 },
      { x: clamp(W - pw * 2 - 28, 376, W - pw - 14), y: 44 },
      { x: clamp(W - pw * 2 - 28, 376, W - pw - 14), y: H - ph - 54 },
    ];
    S.windows.forEach(w => {
      rawCandidates.push({ x: w.x, y: w.y + w.h + 12 });
      rawCandidates.push({ x: w.x + w.w + 14, y: w.y });
    });

    const candidates = rawCandidates.map(c => ({
      x: clamp(Math.round(c.x), 10, Math.max(10, W - pw - 10)),
      y: clamp(Math.round(c.y), 10, Math.max(10, H - ph - 10)),
      w: pw,
      h: ph,
    }));

    let best = candidates[0];
    let bestPenalty = Infinity;
    for (const c of candidates) {
      let penalty = 0;
      for (const o of hard) {
        if (rectsOverlap(c, o, 6)) penalty += 25000;
      }
      for (const s of soft) {
        if (rectsOverlap(c, s, 4)) penalty += 12000;
      }
      for (const item of S.workspace) {
        const ip = iconRect(item);
        if (rectsOverlap(c, ip, 2)) {
          penalty += S.selectedNames.includes(item.name) ? 3500 : 800;
        }
      }
      penalty += Math.hypot(c.x - (a.x + a.w + 14), c.y - a.y) * 0.22;
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = c;
      }
    }
    panelEl.style.left = best.x + 'px';
    panelEl.style.top = best.y + 'px';
    bringToFront(panelEl);
  }

  function placeActPill(anchor) {
    const W = desktopEl.clientWidth || 1280;
    const H = desktopEl.clientHeight || 660;
    let px, py;
    if ((anchor.w || 0) >= 90) {
      // Desktop icon: place the 34x34 little blue arrow cleanly at the top-right shoulder of the icon (zero overlap with glyph, title, or neighbor!)
      px = anchor.x + 74;
      py = anchor.y + 4;
    } else {
      // Text selection / window anchor: place beside selection while avoiding .winbar button bars
      px = anchor.x + (anchor.w || 20) + 8;
      py = anchor.y + 6;
      for (const w of S.windows) {
        if (rectsOverlap({ x: px, y: py, w: 36, h: 36 }, { x: w.x, y: w.y, w: w.w, h: 42 }, 4)) {
          py = w.y + 48;
        }
      }
    }
    actPillEl.style.left = clamp(Math.round(px), 10, W - 46) + 'px';
    actPillEl.style.top = clamp(Math.round(py), 10, H - 46) + 'px';
    bringToFront(actPillEl);
  }

  function makeDraggable(panelEl, handleEl) {
    let drag = null;
    handleEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('button,select,input,textarea')) return;
      bringToFront(panelEl);
      drag = { mx: e.clientX, my: e.clientY, x: panelEl.offsetLeft, y: panelEl.offsetTop };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const W = desktopEl.clientWidth;
      const H = desktopEl.clientHeight;
      panelEl.dataset.moved = '1';
      panelEl.style.left = clamp(drag.x + (e.clientX - drag.mx), 6, Math.max(6, W - panelEl.offsetWidth - 6)) + 'px';
      panelEl.style.top = clamp(drag.y + (e.clientY - drag.my), 6, Math.max(6, H - 48)) + 'px';
    });
    window.addEventListener('mouseup', () => { drag = null; });
    panelEl.addEventListener('mousedown', () => bringToFront(panelEl));
  }
  makeDraggable(actEl, $('acthead'));
  makeDraggable(askEl, $('askhead'));
  makeDraggable(bubbleEl, $('bubblehead'));

  function updateLLMBadge(llm) {
    if (!llm) return;
    $('llm-dot').className = (llm.state === 'downloading' || llm.state === 'starting') ? 'busy' : '';
    const label = llm.ready ? 'Qwen3.5-4B 本地引擎已就绪' : (llm.detail || 'Qwen3.5-4B 引擎在线');
    $('llm-text').textContent = label;
    $('hud-model').textContent = llm.ready ? 'Qwen3.5-4B (Ready)' : 'Qwen3.5-4B + 确定性内核';
  }

  // ---- Desktop Icons Rendering & Authentic Click Behavior ----
  function iconRect(item) {
    return {
      x: 14 + item.col * 116,
      y: 14 + item.row * 118,
      w: 104,
      h: 102,
    };
  }

  function renderDesktopIcons(freshNames = []) {
    iconGridEl.innerHTML = '';
    const freshSet = new Set(freshNames);
    S.workspace.forEach(item => {
      const r = iconRect(item);
      const div = document.createElement('div');
      div.className = 'dicon' + (S.selectedNames.includes(item.name) ? ' selected' : '') + (freshSet.has(item.name) ? ' fresh' : '');
      div.style.left = r.x + 'px';
      div.style.top = r.y + 'px';
      div.dataset.name = item.name;
      const extLabel = (item.ext || 'FILE').toUpperCase().slice(0, 4);
      div.innerHTML = `
        <div class="glyph ${item.kind}">
          ${extLabel}
          ${item.is_generated ? '<span class="new-dot">NEW</span>' : ''}
        </div>
        <div class="fname" title="${item.name}">${item.name}</div>
        <div class="fmeta">${item.size_human}</div>
      `;

      // SINGLE CLICK:
      // - In idle mode -> Authentic ZhiDian #actpill (32x32 little blue arrow) pops up right beside the icon!
      // - In F8 pointing + screen mode -> Pins @n referent & opens #ask!
      // - In F8 pointing + context mode -> Updates #ask context!
      div.addEventListener('click', async (e) => {
        e.stopPropagation();
        clearMarks();
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          if (S.selectedNames.includes(item.name)) {
            S.selectedNames = S.selectedNames.filter(n => n !== item.name);
          } else {
            S.selectedNames = [...S.selectedNames, item.name];
          }
        } else {
          S.selectedNames = [item.name];
        }
        S.selectedText = '';
        S.lastAnchor = r;
        renderDesktopIcons();

        if (!S.selectedNames.length) {
          hideAct();
          return;
        }

        if (S.mode === 'idle') {
          await offerIdleArrowPill(r);
        } else if (S.inputMode === 'screen') {
          addPin([item.name], r, item.name);
          await refreshAskPanel(r, []);
        } else {
          await refreshAskPanel(r, []);
        }
      });

      div.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        hideActPillOnly();
        openFileWindow(item.name);
      });

      div.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        addPin([item.name], r, item.name);
        if (!S.selectedNames.includes(item.name)) S.selectedNames = [item.name];
        S.lastAnchor = r;
        renderDesktopIcons();
        toast(`已钉住引用 ${S.refs[S.refs.length - 1].handle} · ${item.name}`);
        if (S.mode === 'pointing') {
          await refreshAskPanel(r, []);
        }
      });

      iconGridEl.appendChild(div);
    });
    $('filecounter').textContent = `桌面共 ${S.workspace.length} 份随机虚拟测试样本${S.batchId ? ' · 批次 #' + S.batchId : ''}`;
  }

  // ---- Surface 1: #actpill (Little Blue Arrow) -> #act (380px Office Action Card) ----
  function hideActPillOnly() {
    clearTimeout(S.pillHoverTimer);
    actPillEl.hidden = true;
  }

  function hideAct() {
    clearTimeout(S.pillHoverTimer);
    actPillEl.hidden = true;
    actEl.hidden = true;
    delete actEl.dataset.moved;
  }

  async function offerIdleArrowPill(anchor) {
    actEl.hidden = true;
    delete actEl.dataset.moved;
    const data = await callRpc({ op: 'inspect', files: S.selectedNames, selected_text: S.selectedText });
    updateLLMBadge(data.llm);
    S.offers = data.offers || [];
    S.summary = data.summary || '';
    if (!S.offers.length) return;
    actPillEl.title = `${S.summary} · 点击或悬停小箭头查看操作`;
    actPillEl.hidden = false;
    placeActPill(anchor);
  }

  function expandActPill() {
    clearTimeout(S.pillHoverTimer);
    if (actPillEl.hidden && !actEl.hidden) return;
    actPillEl.hidden = true;
    openActPanel();
  }

  actPillEl.addEventListener('click', (e) => {
    e.stopPropagation();
    expandActPill();
  });
  actPillEl.addEventListener('pointerenter', () => {
    clearTimeout(S.pillHoverTimer);
    S.pillHoverTimer = setTimeout(() => {
      if (!actPillEl.hidden) expandActPill();
    }, 240);
  });
  actPillEl.addEventListener('pointerleave', () => {
    clearTimeout(S.pillHoverTimer);
  });

  function renderOfferBtnForAct(o) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.act = o.id;
    btn.textContent = o.label;

    if (o.param && Array.isArray(o.param.options)) {
      const wrap = document.createElement('span');
      wrap.className = 'actgroup';
      const sel = document.createElement('select');
      sel.className = 'actselect';
      sel.dataset.paramFor = o.id;
      o.param.options.forEach(opt => {
        const op = document.createElement('option');
        op.value = opt.value;
        op.textContent = opt.label;
        if (opt.value === (o.param.default || o.param.options[0].value)) op.selected = true;
        sel.appendChild(op);
      });
      btn.onclick = () => executeFromAct(o, sel.value);
      wrap.append(btn, sel);
      return wrap;
    }

    btn.onclick = () => {
      if (o.param && !o.param.options) {
        openActParamInput(o);
      } else {
        executeFromAct(o, '');
      }
    };
    return btn;
  }

  function openActPanel() {
    delete actEl.dataset.moved;
    $('actwhat').textContent = S.summary;
    $('actwhat').title = S.summary;
    const btnsEl = $('actbtns');
    btnsEl.innerHTML = '';

    const shown = S.offers.length > 5 ? S.offers.slice(0, 4) : S.offers;
    const rest = S.offers.slice(shown.length);
    shown.forEach(o => btnsEl.appendChild(renderOfferBtnForAct(o)));

    if (rest.length) {
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'more';
      moreBtn.id = 'actmorebtn';
      moreBtn.textContent = `更多 ${rest.length}`;
      const restDiv = document.createElement('div');
      restDiv.className = 'rest';
      restDiv.hidden = true;
      rest.forEach(o => restDiv.appendChild(renderOfferBtnForAct(o)));
      moreBtn.onclick = () => {
        restDiv.hidden = false;
        moreBtn.remove();
        placeSmartPanel(actEl, S.lastAnchor);
      };
      btnsEl.append(moreBtn, restDiv);
    }

    btnsEl.hidden = false;
    $('actparam').hidden = true;
    $('actstatus').hidden = true;
    $('actdone').hidden = true;
    actEl.hidden = false;
    placeSmartPanel(actEl, S.lastAnchor);
  }

  function openActParamInput(offer) {
    const p = offer.param || {};
    const paramEl = $('actparam');
    paramEl.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'actparam-input';
    input.value = p.default || '';
    input.placeholder = p.placeholder || '';
    const goBtn = document.createElement('button');
    goBtn.type = 'button';
    goBtn.className = 'main';
    goBtn.id = 'actparam-submit';
    goBtn.textContent = '确定';
    goBtn.onclick = () => executeFromAct(offer, input.value.trim());
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.id = 'actparam-back';
    backBtn.textContent = '返回';
    backBtn.onclick = () => {
      paramEl.hidden = true;
      $('actbtns').hidden = false;
      placeSmartPanel(actEl, S.lastAnchor);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); goBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); backBtn.click(); }
    });
    $('actbtns').hidden = true;
    paramEl.append(input, goBtn, backBtn);
    paramEl.hidden = false;
    placeSmartPanel(actEl, S.lastAnchor);
    setTimeout(() => { input.focus(); input.select(); }, 20);
  }

  async function executeFromAct(offer, paramVal) {
    $('actbtns').hidden = true;
    $('actparam').hidden = true;
    $('actdone').hidden = true;
    $('actstatus').hidden = false;
    $('actmsg').textContent = `正在执行「${offer.label}」…`;

    const combinedFiles = [...new Set([...S.refs.flatMap(r => r.files || []), ...S.selectedNames])];
    try {
      const res = await callRpc({
        op: 'execute',
        action_id: offer.id,
        files: combinedFiles,
        param: paramVal,
        selected_text: S.selectedText,
      });
      $('actstatus').hidden = true;
      renderActDone(res);
    } catch (err) {
      $('actstatus').hidden = true;
      renderActDone({ ok: false, error: err.message });
    }
  }

  function renderActDone(res) {
    const doneEl = $('actdone');
    doneEl.innerHTML = '';
    doneEl.classList.toggle('error', !res.ok);
    updateLLMBadge(res.llm);

    const created = res.created || [];
    if (res.workspace) {
      S.workspace = res.workspace;
      renderDesktopIcons(created.map(c => c.name));
    }

    const titleDiv = document.createElement('div');
    titleDiv.className = 'name';
    titleDiv.textContent = !res.ok ? '操作未完成' : (created.length ? `✓ 已生成 ${created[0].name}` : '✓ 处理完成');

    const noteDiv = document.createElement('div');
    noteDiv.className = 'note';
    const displayText = !res.ok ? (res.error || '处理失败') : (res.result_text ? `${res.message}\n\n${res.result_text}` : (res.message || '已完成'));
    noteDiv.textContent = displayText;

    const row = document.createElement('div');
    row.className = 'row';

    if (res.ok && created.length) {
      const first = created[0];
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'main';
      openBtn.dataset.actdo = 'open';
      openBtn.textContent = '打开预览';
      openBtn.onclick = () => openFileWindow(first.name);

      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.dataset.actdo = 'download';
      dlBtn.textContent = '⬇ 下载文件';
      dlBtn.onclick = () => downloadDesktopFile(first.name);
      row.append(openBtn, dlBtn);
    }

    if (res.ok) {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.dataset.actdo = 'copy';
      copyBtn.textContent = '复制结果';
      copyBtn.onclick = () => {
        navigator.clipboard?.writeText(res.result_text || res.message || '').catch(() => {});
        copyBtn.textContent = '已复制 ✓';
        toast('结果已复制到剪贴板');
      };
      row.appendChild(copyBtn);
    }

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.textContent = '继续操作';
    backBtn.onclick = () => openActPanel();

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.dataset.actdo = 'close';
    closeBtn.textContent = '关闭';
    closeBtn.onclick = () => hideAct();

    row.append(backBtn, closeBtn);
    doneEl.append(titleDiv, noteDiv, row);
    doneEl.hidden = false;
    placeSmartPanel(actEl, S.lastAnchor);

    if (res.ai_point) flyAiCursor(res.ai_point);
  }

  $('actclose').onclick = () => hideAct();
  $('actpin').onclick = () => {
    if (S.selectedNames.length) {
      addPin([...S.selectedNames], S.lastAnchor, S.selectedNames.join('、'));
      toast(`已暂存为 ${S.refs[S.refs.length - 1].handle}`);
    }
  };
  $('actask').onclick = async () => {
    const anchor = S.lastAnchor;
    hideAct();
    if (S.mode !== 'pointing') setPointingMode(true);
    await refreshAskPanel(anchor, []);
  };

  // ---- Surface 2: F8 Pointing Mode (#veil, #halo, #snap, #drag, #ask) ----
  function setPointingMode(on) {
    S.mode = on ? 'pointing' : 'idle';
    document.body.classList.toggle('pointing', on);
    document.body.classList.toggle('idle', !on);
    const btn = $('f8btn');
    btn.classList.toggle('on', on);
    btn.textContent = on ? '🎯 F8 指点模式：开启 (按 Esc 退出)' : '🎯 按 F8 进入指点框选';

    if (on) {
      hideAct();
      updateSnapBox();
      refreshAskPanel(S.lastAnchor, []);
    } else {
      snapEl.classList.remove('on');
      askEl.hidden = true;
      delete askEl.dataset.moved;
    }
  }

  function togglePointing() {
    setPointingMode(S.mode !== 'pointing');
  }

  function updateSnapBox() {
    if (S.mode !== 'pointing') return;
    const W = desktopEl.clientWidth || 1280;
    const H = desktopEl.clientHeight || 660;
    const sizes = [
      { w: 124, h: 118, label: '范围 1/3 · 单图标' },
      { w: 250, h: 244, label: '范围 2/3 · 文件组' },
      { w: Math.min(540, W - 40), h: Math.min(380, H - 40), label: '范围 3/3 · 窗口区' },
    ];
    const idx = clamp(1 + S.snapScope, 0, 2);
    const sz = sizes[idx];
    const x = clamp(Math.round(S.cursor.x - sz.w / 2), 10, Math.max(10, W - sz.w - 10));
    const y = clamp(Math.round(S.cursor.y - sz.h / 2), 10, Math.max(10, H - sz.h - 10));
    S.snapBox = { x, y, w: sz.w, h: sz.h };
    snapEl.style.left = x + 'px';
    snapEl.style.top = y + 'px';
    snapEl.style.width = sz.w + 'px';
    snapEl.style.height = sz.h + 'px';
    snapEl.classList.toggle('flip', y < 28);
    snapEl.querySelector('.tag').textContent = `${sz.label} · ${sz.w}×${sz.h}`;
    snapEl.classList.add('on');
  }

  function changeScope(delta) {
    S.snapScope = clamp(S.snapScope + delta, -1, 1);
    updateSnapBox();
    toast(`吸附范围已调整 (${S.snapScope + 2}/3)`);
  }

  let dragStart = null;
  desktopEl.addEventListener('mousemove', (e) => {
    const rect = desktopEl.getBoundingClientRect();
    S.cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (S.mode === 'pointing') {
      haloEl.style.left = S.cursor.x + 'px';
      haloEl.style.top = S.cursor.y + 'px';
      if (!dragStart && !e.target.closest('.panel,.appwin')) {
        updateSnapBox();
      }
    }
    if (dragStart) {
      const cx = clamp(S.cursor.x, 0, rect.width);
      const cy = clamp(S.cursor.y, 0, rect.height);
      const x = Math.min(dragStart.x, cx);
      const y = Math.min(dragStart.y, cy);
      const w = Math.abs(cx - dragStart.x);
      const h = Math.abs(cy - dragStart.y);
      if (w >= 6 || h >= 6) dragStart.moved = true;
      dragEl.style.left = x + 'px';
      dragEl.style.top = y + 'px';
      dragEl.style.width = w + 'px';
      dragEl.style.height = h + 'px';
      dragEl.style.display = dragStart.moved ? 'block' : 'none';
      if (dragStart.moved) snapEl.classList.remove('on');
    }
  });

  desktopEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.panel,.appwin,.dicon,#dock')) return;
    if (e.button !== 0 && e.button !== 2) return;
    const rect = desktopEl.getBoundingClientRect();
    dragStart = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      rightBtn: e.button === 2,
      moved: false,
    };
  });

  desktopEl.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.appwin,.panel')) e.preventDefault();
  });

  window.addEventListener('mouseup', async (e) => {
    if (!dragStart) return;
    const st = dragStart;
    dragStart = null;
    dragEl.style.display = 'none';

    if (!st.moved) {
      // Single click on empty desktop
      if (S.mode === 'idle') {
        S.selectedNames = [];
        S.selectedText = '';
        renderDesktopIcons();
        hideAct();
      } else if (S.inputMode === 'screen') {
        addPin([], S.snapBox, `屏幕区域 ${S.snapBox.w}×${S.snapBox.h}`);
        await refreshAskPanel(S.snapBox, []);
      }
      return;
    }

    // Drag box selection (works in both F8 pointing mode and normal desktop rubber-band drag!)
    const rect = desktopEl.getBoundingClientRect();
    const cx = clamp(e.clientX - rect.left, 0, rect.width);
    const cy = clamp(e.clientY - rect.top, 0, rect.height);
    const box = {
      x: Math.min(st.x, cx),
      y: Math.min(st.y, cy),
      w: Math.abs(cx - st.x),
      h: Math.abs(cy - st.y),
    };

    const matched = [];
    const occluded = [];
    S.workspace.forEach(item => {
      const ir = iconRect(item);
      if (!rectsOverlap(box, ir, 0)) return;
      const icx = ir.x + ir.w / 2;
      const icy = ir.y + ir.h / 2;
      const covered = S.windows.some(w => pointInRect(icx, icy, { x: w.x, y: w.y, w: w.w, h: w.h }));
      if (covered) occluded.push(item.name);
      else matched.push(item.name);
    });

    const warnings = occluded.length
      ? [`HWND Z-Order 防遮挡生效：已自动剔除被顶层窗口遮挡的 ${occluded.length} 个后台文件（${occluded.join('、')}）`]
      : [];

    S.selectedNames = matched;
    S.selectedText = '';
    S.lastAnchor = box;
    renderDesktopIcons();

    if (st.rightBtn && matched.length) {
      addPin(matched, box, matched.join(' + '));
    }

    if (S.mode === 'pointing') {
      S.inputMode = 'context';
      syncModeTabs();
      await refreshAskPanel(box, warnings);
    } else if (matched.length) {
      // Rubber-band drag in idle mode: show the little arrow pill (or if warnings exist, show #ask)
      if (warnings.length) {
        setPointingMode(true);
        await refreshAskPanel(box, warnings);
      } else {
        await offerIdleArrowPill(box);
      }
    }
  });

  desktopEl.addEventListener('wheel', (e) => {
    if (S.mode !== 'pointing' || e.target.closest('.panel,.appwin')) return;
    e.preventDefault();
    changeScope(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // ---- @1 @2 Referent Pinning & #dock ----
  function addPin(files, box, label) {
    const handle = '@' + (S.refs.length + 1);
    S.refs.push({ handle, files: [...files], box: { ...box }, label });
    renderPinsAndDock();
  }

  function removePin(handle) {
    S.refs = S.refs.filter(r => r.handle !== handle);
    S.refs.forEach((r, i) => { r.handle = '@' + (i + 1); });
    renderPinsAndDock();
    if (!askEl.hidden) renderSendList();
  }

  function renderPinsAndDock() {
    pinsEl.innerHTML = '';
    const chipsEl = $('chips');
    chipsEl.innerHTML = '';

    S.refs.forEach(r => {
      if (r.box) {
        const p = document.createElement('div');
        p.className = 'pin';
        p.style.left = r.box.x + 'px';
        p.style.top = r.box.y + 'px';
        p.style.width = r.box.w + 'px';
        p.style.height = r.box.h + 'px';
        p.innerHTML = `<b>${r.handle}</b>`;
        pinsEl.appendChild(p);
      }
      const c = document.createElement('div');
      c.className = 'chip sel';
      c.innerHTML = `<b>${r.handle}</b><span class="l">${r.label}</span><i class="st"></i>`;
      const xBtn = document.createElement('button');
      xBtn.type = 'button';
      xBtn.className = 'ghost';
      xBtn.textContent = '✕';
      xBtn.onclick = () => removePin(r.handle);
      c.appendChild(xBtn);
      chipsEl.appendChild(c);
    });
    dockEl.hidden = S.refs.length === 0;
  }

  $('dclear').onclick = () => {
    S.refs = [];
    renderPinsAndDock();
    if (!askEl.hidden) renderSendList();
  };

  function renderSendList() {
    const sl = $('sendlist');
    sl.innerHTML = '';
    if (!S.refs.length && S.inputMode !== 'screen') {
      sl.hidden = true;
      return;
    }
    sl.hidden = false;
    const lead = document.createElement('span');
    lead.className = 'lead';
    lead.textContent = '将读入';
    sl.appendChild(lead);

    if (!S.refs.length) {
      const g = document.createElement('span');
      g.className = 'send ghostchip';
      g.textContent = '你正指着的区域 · 单击固定 @1';
      sl.appendChild(g);
      return;
    }
    S.refs.forEach(r => {
      const chip = document.createElement('span');
      chip.className = 'send';
      chip.innerHTML = `<b>${r.handle}</b><span>${r.label.slice(0, 14)}</span>`;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'ghost';
      x.textContent = '✕';
      x.onclick = () => removePin(r.handle);
      chip.appendChild(x);
      sl.appendChild(chip);
    });
  }

  // ---- #ask Panel Refresh & Actions ----
  function syncModeTabs() {
    const isCtx = S.inputMode === 'context';
    $('contextmode').setAttribute('aria-selected', String(isCtx));
    $('screenmode').setAttribute('aria-selected', String(!isCtx));
  }

  async function refreshAskPanel(anchor, warnings = []) {
    askEl.hidden = false;
    $('askparam').hidden = true;
    $('askstatus').hidden = true;
    renderSendList();

    const combinedFiles = [...new Set([...S.refs.flatMap(r => r.files || []), ...S.selectedNames])];
    const data = await callRpc({ op: 'inspect', files: combinedFiles, selected_text: S.selectedText });
    updateLLMBadge(data.llm);
    S.offers = data.offers || [];

    const isCtx = S.inputMode === 'context';
    $('selectionhint').hidden = isCtx && (combinedFiles.length > 0 || S.selectedText.length > 0) && !warnings.length;
    $('selectionhint').textContent = isCtx
      ? '拖动框住桌面文件图标，自动剔除被顶层窗口挡住的后台文件'
      : '左键单击屏幕任意位置钉住 @1 @2，直接向本地视觉模型提问';

    const card = $('contextcard');
    const acts = $('contextactions');
    if (isCtx) {
      card.hidden = false;
      card.innerHTML = '';
      const srcRow = document.createElement('div');
      srcRow.className = 'context-source';
      srcRow.innerHTML = `<span class="context-dot"></span><b>${
        S.selectedText ? `已选文字 (${S.selectedText.length} 字)` : (combinedFiles.length ? `已找到 ${combinedFiles.length} 个桌面文件` : '等待框选桌面文件')
      }</b>`;
      card.appendChild(srcRow);

      (data.files || []).slice(0, 4).forEach(f => {
        const fr = document.createElement('div');
        fr.className = 'context-file';
        fr.innerHTML = `<span class="file-type">${f.kind.slice(0, 5).toUpperCase()}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</span>`;
        card.appendChild(fr);
      });

      warnings.forEach(w => {
        const wn = document.createElement('div');
        wn.className = 'context-warning';
        wn.textContent = w;
        card.appendChild(wn);
      });

      acts.innerHTML = '';
      if (S.offers.length) {
        $('askseclabel').hidden = false;
        const grid = document.createElement('div');
        grid.className = 'context-action-grid';
        S.offers.slice(0, 8).forEach(o => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'context-action';
          b.dataset.askact = o.id;
          b.innerHTML = `<span>${o.label}</span><span>›</span>`;
          b.onclick = () => onClickAskAction(o);
          grid.appendChild(b);
        });
        acts.appendChild(grid);
      } else {
        $('askseclabel').hidden = true;
      }
    } else {
      card.hidden = true;
      $('askseclabel').hidden = true;
      acts.innerHTML = '';
    }

    placeSmartPanel(askEl, anchor || S.lastAnchor);
  }

  function onClickAskAction(offer) {
    const paramBox = $('askparam');
    if (offer.param) {
      paramBox.innerHTML = '';
      const lbl = document.createElement('label');
      lbl.textContent = `${offer.label} · ${offer.param.label}`;
      paramBox.appendChild(lbl);

      let ctrl;
      if (Array.isArray(offer.param.options)) {
        ctrl = document.createElement('select');
        offer.param.options.forEach(opt => {
          const op = document.createElement('option');
          op.value = opt.value;
          op.textContent = opt.label;
          if (opt.value === offer.param.default) op.selected = true;
          ctrl.appendChild(op);
        });
      } else {
        ctrl = document.createElement('input');
        ctrl.type = 'text';
        ctrl.value = offer.param.default || '';
        ctrl.placeholder = offer.param.placeholder || '';
      }
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'primary-button';
      go.textContent = '执行';
      go.onclick = () => executeFromAsk(offer.id, ctrl.value);
      paramBox.append(ctrl, go);
      paramBox.hidden = false;
      placeSmartPanel(askEl, S.lastAnchor);
      return;
    }
    executeFromAsk(offer.id, '');
  }

  async function executeFromAsk(actionId, paramVal) {
    $('askparam').hidden = true;
    const st = $('askstatus');
    st.className = 'context-status';
    st.hidden = false;
    st.innerHTML = `<span class="spin"></span> 正在原地处理文件…`;

    const combinedFiles = [...new Set([...S.refs.flatMap(r => r.files || []), ...S.selectedNames])];
    try {
      const res = await callRpc({
        op: 'execute',
        action_id: actionId,
        files: combinedFiles,
        param: paramVal,
        selected_text: S.selectedText,
      });
      renderAskResult(res);
    } catch (err) {
      renderAskResult({ ok: false, error: err.message });
    }
  }

  function renderAskResult(res) {
    const st = $('askstatus');
    st.hidden = false;
    st.className = 'context-status' + (res.ok ? '' : ' error');
    st.innerHTML = '';
    updateLLMBadge(res.llm);

    const created = res.created || [];
    if (res.workspace) {
      S.workspace = res.workspace;
      renderDesktopIcons(created.map(c => c.name));
    }

    const msg = document.createElement('div');
    msg.style.whiteSpace = 'pre-wrap';
    msg.textContent = res.ok ? (res.result_text ? `${res.message}\n${res.result_text}` : res.message) : ('❌ ' + (res.error || '处理失败'));
    st.appendChild(msg);

    created.forEach(c => {
      const row = document.createElement('div');
      row.className = 'resfile-row';
      row.innerHTML = `<b title="${c.name}">📄 ${c.name}</b>`;
      const btns = document.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '4px';
      const pBtn = document.createElement('button');
      pBtn.type = 'button';
      pBtn.className = 'mini-btn';
      pBtn.textContent = '预览';
      pBtn.onclick = () => openFileWindow(c.name);
      const dBtn = document.createElement('button');
      dBtn.type = 'button';
      dBtn.className = 'mini-btn primary';
      dBtn.textContent = '⬇ 下载';
      dBtn.onclick = () => downloadDesktopFile(c.name);
      btns.append(pBtn, dBtn);
      row.appendChild(btns);
      st.appendChild(row);
    });

    placeSmartPanel(askEl, S.lastAnchor);
    if (res.ai_point) flyAiCursor(res.ai_point);
  }

  // ---- Surface 3: Natural Language Submit -> #bubble + #aicursor ----
  async function submitQuestion() {
    const q = $('q').value.trim();
    if (!q) { $('q').focus(); return; }
    const combinedFiles = [...new Set([...S.refs.flatMap(r => r.files || []), ...S.selectedNames])];

    $('bq').textContent = `${S.refs.map(r => r.handle).join(' ')} ${q}`.trim();
    $('btext').innerHTML = `<span class="spin"></span> 正在调用本地 Qwen3.5-4B 分析…`;
    $('bfiles').innerHTML = '';
    $('bfoot').textContent = '';
    bubbleEl.hidden = false;
    delete bubbleEl.dataset.moved;
    placeSmartPanel(bubbleEl, { x: askEl.offsetLeft, y: askEl.offsetTop, w: askEl.offsetWidth, h: askEl.offsetHeight });

    const t0 = performance.now();
    try {
      const res = await callRpc({
        op: 'instruct',
        instruction: q,
        files: combinedFiles,
        selected_text: S.selectedText,
        pinned_refs: S.refs,
      });
      const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
      updateLLMBadge(res.llm);

      const created = res.created || [];
      if (res.workspace) {
        S.workspace = res.workspace;
        renderDesktopIcons(created.map(c => c.name));
      }

      const btext = $('btext');
      btext.innerHTML = '';
      const fullText = res.ok ? (res.result_text ? `${res.message}\n\n${res.result_text}` : res.message) : ('❌ ' + res.error);
      fullText.split(/(@\d+)/g).forEach(part => {
        if (/^@\d+$/.test(part)) {
          const sp = document.createElement('span');
          sp.className = 'ref';
          sp.textContent = part;
          btext.appendChild(sp);
        } else {
          btext.append(part);
        }
      });
      if (res.ai_point) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '1';
        btext.append(' ', badge);
      }

      const bfiles = $('bfiles');
      created.forEach(c => {
        const row = document.createElement('div');
        row.className = 'resfile-row';
        row.innerHTML = `<b>📄 ${c.name} (${c.size_human})</b>`;
        const wrap = document.createElement('div');
        wrap.style.display = 'flex';
        wrap.style.gap = '4px';
        const oBtn = document.createElement('button');
        oBtn.type = 'button';
        oBtn.className = 'mini-btn';
        oBtn.textContent = '预览';
        oBtn.onclick = () => openFileWindow(c.name);
        const dBtn = document.createElement('button');
        dBtn.type = 'button';
        dBtn.className = 'mini-btn primary';
        dBtn.textContent = '⬇ 下载';
        dBtn.onclick = () => downloadDesktopFile(c.name);
        wrap.append(oBtn, dBtn);
        row.appendChild(wrap);
        bfiles.appendChild(row);
      });

      $('bfoot').innerHTML = `<span>耗时 <b>${elapsed} 秒</b></span><span>全程在本机容器</span>`;
      placeSmartPanel(bubbleEl, S.lastAnchor);

      if (res.ai_point) await flyAiCursor(res.ai_point);
    } catch (err) {
      $('btext').textContent = '❌ ' + err.message;
    }
  }

  $('qsend').onclick = submitQuestion;
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(); }
  });
  $('askclose').onclick = () => setPointingMode(false);
  $('askpin').onclick = () => {
    if (S.selectedNames.length) {
      addPin([...S.selectedNames], S.lastAnchor, S.selectedNames.join('、'));
      renderSendList();
      toast(`已暂存为 ${S.refs[S.refs.length - 1].handle}`);
    }
  };
  $('bcopy').onclick = () => {
    navigator.clipboard?.writeText($('btext').textContent || '').catch(() => {});
    toast('已复制回答内容');
  };
  $('bclose').onclick = () => {
    bubbleEl.hidden = true;
    clearMarks();
  };

  // Advanced tools inside #ask (#inputmodes, #asktools, #quickvoice)
  $('inputmodes').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-input-mode]')?.dataset.inputMode;
    if (!mode) return;
    S.inputMode = mode;
    syncModeTabs();
    refreshAskPanel(S.lastAnchor, []);
  });
  $('quickvoice').addEventListener('change', () => {
    $('qmic').hidden = !$('quickvoice').checked;
  });
  $('quickadvanced').addEventListener('toggle', () => {
    placeSmartPanel(askEl, S.lastAnchor);
  });
  $('tool-copy').onclick = () => {
    const info = S.selectedNames.length ? S.selectedNames.join('、') : `桌面框选区域 (${S.snapBox.w}×${S.snapBox.h})`;
    navigator.clipboard?.writeText(info).catch(() => {});
    toast(`✓ 已复制框选快照信息：${info}`);
  };
  $('tool-save').onclick = async () => {
    const res = await callRpc({ op: 'capture_save', files: S.selectedNames, box: S.snapBox });
    renderAskResult(res);
    toast('✓ 已保存框选快照 PNG 到桌面');
  };
  $('tool-ocr').onclick = async () => {
    const res = await callRpc({ op: 'ocr_extract', files: S.selectedNames });
    navigator.clipboard?.writeText(res.text || '').catch(() => {});
    renderAskResult(res);
    toast('✓ 已提取文字并自动复制');
  };
  $('tool-scope-minus').onclick = () => changeScope(-1);
  $('tool-scope-plus').onclick = () => changeScope(1);

  // ---- Voice Orb (#qmic & #voicepanel — Real Web Speech + Universal Interactive Fallback) ----
  let recognition = null;
  function startVoiceSession() {
    clearInterval(S.voiceTimer);
    S.voiceSec = 0;
    $('voicepanel').hidden = false;
    $('voicepanel').dataset.state = 'listening';
    $('qmic').dataset.state = 'listening';
    $('voice-status').textContent = '正在听你说（本机安全听写）';
    $('voice-time').textContent = '00 / 60 秒';

    S.voiceTimer = setInterval(() => {
      S.voiceSec += 1;
      $('voice-time').textContent = `${String(S.voiceSec).padStart(2, '0')} / 60 秒`;
      if (S.voiceSec >= 60) finishVoiceSession();
    }, 1000);

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      try {
        recognition = new SR();
        recognition.lang = 'zh-CN';
        recognition.interimResults = true;
        recognition.onresult = (ev) => {
          $('q').value = Array.from(ev.results).map(r => r[0].transcript).join('');
        };
        recognition.onerror = () => {};
        recognition.start();
      } catch (e) {}
    }
  }

  function finishVoiceSession() {
    clearInterval(S.voiceTimer);
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    $('voicepanel').hidden = true;
    $('qmic').dataset.state = 'idle';
    if (!$('q').value.trim()) {
      $('q').value = S.selectedNames.some(n => n.endsWith('.md'))
        ? '把这份虚拟汇报大纲做成暖调纸风格的演示PPT'
        : '对比 @1 采购协议上限和 @2 结算核查表，哪一行超支了？指给我看';
    }
    toast('✓ 语音已转写填入输入框，确认后可发送');
    $('q').focus();
  }

  function cancelVoiceSession() {
    clearInterval(S.voiceTimer);
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    $('voicepanel').hidden = true;
    $('qmic').dataset.state = 'idle';
  }

  $('qmic').onclick = () => {
    if ($('qmic').dataset.state === 'listening') finishVoiceSession();
    else startVoiceSession();
  };
  $('voice-stop').onclick = finishVoiceSession;
  $('voice-cancel').onclick = cancelVoiceSession;

  // ---- Secondary AI Cursor (#aicursor) + Pulsing .mark ----
  function clearMarks() {
    marksEl.innerHTML = '';
    aiCursorEl.classList.remove('on');
  }

  async function flyAiCursor(pt) {
    clearMarks();
    let targetWin = null;
    // Open window in upper-center lane (x: 376, y: 40, w: 486, h: 318) so #bubble (y: 370..590), #dock (y: 614), and #ask (x: 1090) stay 100% non-overlapping!
    if (pt.target === 'window_sheet') {
      const sheetName = pt.sheet_name || (S.workspace.find(f => f.kind === 'excel') || {}).name;
      if (sheetName) targetWin = await openFileWindow(sheetName, { x: 372, y: 14, w: 520, h: 318 });
      [askEl, bubbleEl].forEach(p => { if (!p.hidden) placeSmartPanel(p, S.lastAnchor); });
    } else if (pt.target === 'scan_quote') {
      const scanName = pt.scan_name || (S.workspace.find(f => f.name.includes('核定单') || f.kind === 'image') || {}).name;
      if (scanName) targetWin = await openFileWindow(scanName, { x: 372, y: 14, w: 490, h: 318 });
      [askEl, bubbleEl].forEach(p => { if (!p.hidden) placeSmartPanel(p, S.lastAnchor); });
    } else if (S.windows.length) {
      targetWin = S.windows[S.windows.length - 1];
    }

    let tx = 580, ty = 230;
    if (targetWin) {
      const alertRow = targetWin.el.querySelector('tr.alert-row');
      if (alertRow) {
        alertRow.scrollIntoView({ block: 'center', inline: 'nearest' });
        const dRect = desktopEl.getBoundingClientRect();
        const rRect = alertRow.getBoundingClientRect();
        tx = Math.round(rRect.left - dRect.left + Math.min(rRect.width * 0.55, 290));
        ty = Math.round(rRect.top - dRect.top + rRect.height * 0.5);
      } else {
        tx = Math.round(targetWin.x + targetWin.w * (pt.x_pct || 0.62));
        ty = Math.round(targetWin.y + 36 + (targetWin.h - 36) * (pt.y_pct || 0.52));
      }
    }

    const startX = !bubbleEl.hidden ? bubbleEl.offsetLeft + 40 : (!actEl.hidden ? actEl.offsetLeft + 40 : 880);
    const startY = !bubbleEl.hidden ? bubbleEl.offsetTop + 30 : (!actEl.hidden ? actEl.offsetTop + 30 : 120);

    aiCursorEl.style.transition = 'none';
    aiCursorEl.style.transform = `translate(${startX}px, ${startY}px)`;
    aiCursorEl.classList.add('on');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    aiCursorEl.style.transition = '';
    aiCursorEl.style.transform = `translate(${tx}px, ${ty}px)`;

    setTimeout(() => {
      const m = document.createElement('div');
      m.className = 'mark';
      m.style.transform = `translate(${tx}px, ${ty}px)`;
      m.innerHTML = `<div class="ring"></div><div class="lab"><span class="badge">1</span>${pt.label || '异常项定位'}</div>`;
      marksEl.appendChild(m);
    }, 620);
  }

  // ---- Desktop Windows (Center Lane x: 382, Zero Overlap with Icons or Right Panel Lane!) ----
  async function openDefaultSheet() {
    const sheetItem = S.workspace.find(f => f.kind === 'excel') || S.workspace[0];
    if (!sheetItem) return null;
    return await openFileWindow(sheetItem.name);
  }

  async function openFileWindow(fileName, customBox = null) {
    let existing = S.windows.find(w => w.name === fileName);
    if (existing) {
      if (customBox) {
        existing.x = customBox.x; existing.y = customBox.y;
        existing.w = customBox.w; existing.h = customBox.h;
        existing.el.style.left = existing.x + 'px';
        existing.el.style.top = existing.y + 'px';
        existing.el.style.width = existing.w + 'px';
        existing.el.style.height = existing.h + 'px';
      }
      focusWindow(existing);
      return existing;
    }
    const prev = await callRpc({ op: 'preview', name: fileName });
    if (!prev.ok) return null;

    const W = desktopEl.clientWidth || 1280;
    const H = desktopEl.clientHeight || 660;
    const w = customBox ? customBox.w : Math.min(500, Math.max(380, W - 770));
    const h = customBox ? customBox.h : Math.min(390, H - 80);
    const x = customBox ? customBox.x : clamp(384 + (S.windows.length % 3) * 20, 265, Math.max(265, W - w - 395));
    const y = customBox ? customBox.y : clamp(46 + (S.windows.length % 3) * 22, 42, Math.max(42, H - h - 20));

    const winEl = document.createElement('div');
    winEl.className = 'appwin active';
    winEl.dataset.winname = fileName;
    winEl.style.left = x + 'px';
    winEl.style.top = y + 'px';
    winEl.style.width = w + 'px';
    winEl.style.height = h + 'px';

    const bodyHtml = (prev.images && prev.images.length)
      ? `<div class="preview-pages">` + prev.images.map(im => `<img src="${im.data_url}" alt="第${im.page}页"/>`).join('') + `</div>`
      : (prev.html || `<pre class="preview-pre">${prev.text || ''}</pre>`);

    winEl.innerHTML = `
      <div class="winbar">
        <div class="wintitle">
          <span>📄 ${prev.name}</span>
          <span class="zbadge">HWND</span>
        </div>
        <div class="winbtns">
          <button type="button" class="win-act-btn">↗ 指点此文件</button>
          <button type="button" class="win-dl-btn">⬇ 下载</button>
          <button type="button" class="close">✕</button>
        </div>
      </div>
      <div class="winbody">${bodyHtml}</div>
    `;

    const winObj = { id: 'w_' + Date.now(), name: fileName, title: prev.name, x, y, w, h, el: winEl };
    winEl.querySelector('.win-act-btn').onclick = async () => {
      S.selectedNames = [fileName];
      S.selectedText = '';
      S.lastAnchor = { x: winObj.x + winObj.w - 40, y: winObj.y + 8, w: 36, h: 32 };
      renderDesktopIcons();
      await offerIdleArrowPill(S.lastAnchor);
      expandActPill();
    };
    winEl.querySelector('.win-dl-btn').onclick = () => downloadDesktopFile(fileName);

    S.windows.push(winObj);
    winLayerEl.appendChild(winEl);
    bindWindowEvents(winObj);
    focusWindow(winObj);

    // Re-place any open floating panel so it never covers the newly opened window's buttons
    [actEl, askEl, bubbleEl].forEach(p => { if (!p.hidden) placeSmartPanel(p, S.lastAnchor); });
    return winObj;
  }

  function defaultScratchpadSample() {
    return S.scratchpadText || '2099-04-15虚拟项目随机模拟采购明细:\n1. 虚拟光学投影终端16000元,模拟数字音频套件6200元,离线边缘计算盒14500元;\n2. 虚拟内网交换模块与备用电源3350.50元,英文参数说明参见https://mock-demo.invalid/spec文档.';
  }

  function openScratchpad() {
    let existing = S.windows.find(w => w.name === '__scratchpad__');
    if (existing) { focusWindow(existing); return existing; }

    const x = 384, y = 52, w = 490, h = 320;
    const winEl = document.createElement('div');
    winEl.className = 'appwin active';
    winEl.dataset.winname = '__scratchpad__';
    winEl.style.left = x + 'px';
    winEl.style.top = y + 'px';
    winEl.style.width = w + 'px';
    winEl.style.height = h + 'px';
    winEl.innerHTML = `
      <div class="winbar">
        <div class="wintitle"><span>✂️ 划词即出小箭头 · 虚拟文本选区工作窗</span><span class="zbadge">划词触发</span></div>
        <div class="winbtns">
          <button type="button" id="pad-select-btn">↗ 划选全文唤出小箭头</button>
          <button type="button" class="close">✕</button>
        </div>
      </div>
      <div class="winbody" style="padding:10px;display:flex;flex-direction:column;gap:8px;">
        <div style="font-size:11.5px;color:#475569;">用鼠标<b>涂黑选中下方任意一段随机虚拟文字</b>，松开鼠标即在选区旁弹出<b>指点蓝色小箭头 ↗</b>（支持智能数字求和、中英混排整理、翻译、润色）：</div>
        <textarea id="padarea" style="flex:1;width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px;font:12.5px/1.65 var(--font);color:#1e293b;resize:none;"></textarea>
      </div>
    `;
    const area = winEl.querySelector('#padarea');
    area.value = defaultScratchpadSample();
    const winObj = { id: 'w_pad', name: '__scratchpad__', title: '虚拟文本选区工作窗', x, y, w, h, el: winEl };
    S.windows.push(winObj);
    winLayerEl.appendChild(winEl);
    bindWindowEvents(winObj);
    focusWindow(winObj);

    area.addEventListener('mouseup', async (ev) => {
      const sel = area.value.substring(area.selectionStart, area.selectionEnd).trim();
      if (sel.length >= 2) {
        const dRect = desktopEl.getBoundingClientRect();
        const anchor = { x: ev.clientX - dRect.left, y: ev.clientY - dRect.top - 10, w: 20, h: 20 };
        S.selectedNames = [];
        S.selectedText = sel;
        S.lastAnchor = anchor;
        renderDesktopIcons();
        if (S.mode === 'idle') {
          await offerIdleArrowPill(anchor);
        } else {
          await refreshAskPanel(anchor, []);
        }
      }
    });

    winEl.querySelector('#pad-select-btn').onclick = async () => {
      area.focus();
      area.setSelectionRange(0, area.value.length);
      S.selectedNames = [];
      S.selectedText = area.value.trim();
      const anchor = { x: winObj.x + winObj.w - 32, y: winObj.y + 68, w: 24, h: 24 };
      S.lastAnchor = anchor;
      renderDesktopIcons();
      await offerIdleArrowPill(anchor);
    };

    return winObj;
  }

  function bindWindowEvents(winObj) {
    const bar = winObj.el.querySelector('.winbar');
    winObj.el.querySelector('.close').onclick = () => {
      winObj.el.remove();
      S.windows = S.windows.filter(w => w !== winObj);
    };
    winObj.el.addEventListener('mousedown', () => focusWindow(winObj));

    winObj.el.querySelector('.winbody').addEventListener('mouseup', async (ev) => {
      if (winObj.name === '__scratchpad__') return;
      const sel = (window.getSelection()?.toString() || '').trim();
      if (sel.length >= 3) {
        const dRect = desktopEl.getBoundingClientRect();
        const anchor = { x: ev.clientX - dRect.left, y: ev.clientY - dRect.top - 10, w: 20, h: 20 };
        S.selectedNames = [];
        S.selectedText = sel;
        S.lastAnchor = anchor;
        renderDesktopIcons();
        if (S.mode === 'idle') await offerIdleArrowPill(anchor);
        else await refreshAskPanel(anchor, []);
      }
    });

    let drag = null;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag = { mx: e.clientX, my: e.clientY, x: winObj.x, y: winObj.y };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const W = desktopEl.clientWidth;
      const H = desktopEl.clientHeight;
      winObj.x = clamp(drag.x + (e.clientX - drag.mx), 4, Math.max(4, W - 140));
      winObj.y = clamp(drag.y + (e.clientY - drag.my), 4, Math.max(4, H - 56));
      winObj.el.style.left = winObj.x + 'px';
      winObj.el.style.top = winObj.y + 'px';
    });
    window.addEventListener('mouseup', () => { drag = null; });
  }

  function focusWindow(winObj) {
    S.windows.forEach(w => w.el.classList.remove('active'));
    winObj.el.classList.add('active');
    S.winZ += 1;
    winObj.el.style.zIndex = String(Math.min(70, S.winZ));
  }

  // ---- File Upload & Download ----
  async function uploadUserFiles(fileList) {
    if (!fileList || !fileList.length) return;
    toast(`正在上传 ${fileList.length} 份文件到指点桌面…`);
    const uploads = [];
    for (const file of Array.from(fileList).slice(0, 8)) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsDataURL(file);
      });
      uploads.push({ name: file.name, data_url: dataUrl });
    }
    const res = await callRpc({ op: 'upload_b64', uploads });
    $('filepicker').value = '';
    if (res.ok) {
      S.workspace = res.workspace;
      S.selectedNames = res.added || [];
      S.selectedText = '';
      renderDesktopIcons(S.selectedNames);
      const firstAdded = S.workspace.find(f => f.name === S.selectedNames[0]);
      S.lastAnchor = firstAdded ? iconRect(firstAdded) : { x: 260, y: 60, w: 104, h: 102 };
      await offerIdleArrowPill(S.lastAnchor);
      toast(`✓ 已放入桌面：${S.selectedNames.join('、')}（点击小箭头即可处理）`);
    }
  }

  async function downloadDesktopFile(name) {
    const res = await callRpc({ op: 'download_b64', name });
    if (!res.ok) { toast('❌ ' + (res.error || '下载失败')); return; }
    const bin = atob(res.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: res.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`⬇ 已触发下载：${res.name}`);
  }

  async function resetWorkspace() {
    S.windows.forEach(w => w.el.remove());
    S.windows = [];
    S.refs = [];
    S.selectedNames = [];
    S.selectedText = '';
    clearMarks();
    renderPinsAndDock();
    hideAct();
    bubbleEl.hidden = true;
    setPointingMode(false);
    const res = await callRpc({ op: 'reset' });
    if (res.ok) {
      S.workspace = res.workspace;
      S.scratchpadText = res.scratchpad_text || '';
      S.batchId = res.batch_id || 0;
      updateLLMBadge(res.llm);
      renderDesktopIcons();
      toast(`🎲 已重新随机生成 8 份纯虚构测试样本（批次 #${S.batchId || 'NEW'}）`);
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F8') { e.preventDefault(); togglePointing(); return; }
    if (e.key === 'Escape') {
      if (!$('voicepanel').hidden) { cancelVoiceSession(); return; }
      if (!actEl.hidden || !actPillEl.hidden) { hideAct(); return; }
      if (!bubbleEl.hidden) { bubbleEl.hidden = true; clearMarks(); return; }
      if (S.mode === 'pointing') { setPointingMode(false); return; }
    }
    if (S.mode === 'pointing' && !e.target.closest('input,textarea')) {
      if (e.key === '[') { e.preventDefault(); changeScope(-1); }
      if (e.key === ']') { e.preventDefault(); changeScope(1); }
    }
  });

  // ---- Guided 1-Click Scenarios (Demonstrates Real ZhiDian Flow Without Occlusion!) ----
  async function demoScenario(kind) {
    clearMarks();
    bubbleEl.hidden = true;
    delete actEl.dataset.moved;
    delete askEl.dataset.moved;
    delete bubbleEl.dataset.moved;

    if (kind === 'arrow_pptx') {
      setPointingMode(false);
      const item = S.workspace.find(f => f.kind === 'markdown') || S.workspace[0];
      if (!item) return;
      S.selectedNames = [item.name];
      S.selectedText = '';
      S.lastAnchor = iconRect(item);
      renderDesktopIcons();
      await offerIdleArrowPill(S.lastAnchor);
      toast('已模拟单击文件 → 出现蓝色小箭头 ↗（正在自动展开并生成暖调纸 PPT）');
      await new Promise(r => setTimeout(r, 520));
      expandActPill();
      await executeFromAct({ id: 'files.pptx', label: '做成 PPT' }, 'warm');
    } else if (kind === 'pdf') {
      setPointingMode(false);
      const item = S.workspace.find(f => f.kind === 'pdf') || S.workspace[0];
      if (!item) return;
      S.selectedNames = [item.name];
      S.selectedText = '';
      S.lastAnchor = iconRect(item);
      renderDesktopIcons();
      await offerIdleArrowPill(S.lastAnchor);
      expandActPill();
      await executeFromAct({ id: 'pdf.extract', label: '提取指定页' }, '1-2, 末页');
    } else if (kind === 'restyle') {
      setPointingMode(false);
      const item = S.workspace.find(f => f.kind === 'word') || S.workspace[0];
      if (!item) return;
      S.selectedNames = [item.name];
      S.selectedText = '';
      S.lastAnchor = iconRect(item);
      renderDesktopIcons();
      await offerIdleArrowPill(S.lastAnchor);
      expandActPill();
      await executeFromAct({ id: 'word.restyle', label: '一键公文排版' }, '');
    } else if (kind === 'occlusion') {
      hideAct();
      S.windows.forEach(w => w.el.remove());
      S.windows = [];
      const sheetItem = S.workspace.find(f => f.kind === 'excel') || S.workspace[0];
      const pdfItem = S.workspace.find(f => f.kind === 'pdf') || S.workspace[0];
      if (!sheetItem || !pdfItem) return;
      // Deliberately place window over Column 1 icons (x=126, y=18) to demonstrate HWND Z-Order occlusion filtering!
      await openFileWindow(sheetItem.name, { x: 126, y: 18, w: 420, h: 280 });
      const col1Blocked = S.workspace.filter(f => f.col === 1 && f.row <= 1).map(f => f.name);
      S.selectedNames = [pdfItem.name, sheetItem.name];
      S.selectedText = '';
      S.inputMode = 'context';
      syncModeTabs();
      S.lastAnchor = { x: 16, y: 16, w: 230, h: 230 };
      renderDesktopIcons();
      setPointingMode(true);
      await refreshAskPanel(S.lastAnchor, [
        `HWND Z-Order 防遮挡生效：框选横跨两列，已自动剔除被《${sheetItem.name}》窗口挡住的后台图标（${col1Blocked.join('、') || '第2列后台文件'}）`
      ]);
    } else if (kind === 'audit') {
      hideAct();
      S.refs = [];
      const f1 = S.workspace.find(f => f.kind === 'pdf');
      const f2 = S.workspace.find(f => f.kind === 'excel');
      if (!f1 || !f2) return;
      addPin([f1.name], iconRect(f1), f1.name);
      addPin([f2.name], iconRect(f2), f2.name);
      S.selectedNames = [f1.name, f2.name];
      S.selectedText = '';
      renderDesktopIcons();
      setPointingMode(true);
      $('q').value = '对比 @1 采购协议上限和 @2 结算核查表，哪一行超支了？指给我看';
      await submitQuestion();
    }
  }

  // Expose test/automation handle for E2E & VM screen recording
  window.__zhidianStudio = { S, offerIdleArrowPill, expandActPill, setPointingMode, openDefaultSheet, openFileWindow, openScratchpad, resetWorkspace, demoScenario };

  // ---- Boot Clean Idle Desktop ----
  (async function boot() {
    try {
      const res = await callRpc({ op: 'init' });
      if (res.ok) {
        S.workspace = res.workspace;
        S.scratchpadText = res.scratchpad_text || '';
        S.batchId = res.batch_id || 0;
        updateLLMBadge(res.llm);
        renderDesktopIcons();
      }
    } catch (e) {
      console.error('Init failed:', e);
    }
    const poll = setInterval(async () => {
      try {
        const st = await callRpc({ op: 'status' });
        if (st.ok && st.llm) {
          updateLLMBadge(st.llm);
          if (st.llm.ready || st.llm.state === 'fallback' || st.llm.state === 'deterministic') clearInterval(poll);
        }
      } catch (e) {}
    }, 6000);
  })();
</script>
</body>
</html>
"""

# DOMPurify-proof mount via Gradio 6 `js_on_load` + `props` (never puts raw <iframe> in sanitized HTML value!)
WORKBENCH_MOUNT_HTML = (
    '<div class="zhidian-host" '
    'style="width:100%;height:750px;border:1px solid #1e293b;border-radius:14px;overflow:hidden;background:#0b1324;">'
    '</div>'
)

_SERIALIZED_DOC = json.dumps(WORKBENCH_DOC).replace("</", "<\\/")

WORKBENCH_JS_ON_LOAD = (
    "const host = element.querySelector('.zhidian-host') || element;\n"
    "if (host && !host.querySelector('iframe')) {\n"
    "  const ifr = document.createElement('iframe');\n"
    "  ifr.id = 'zhidian-workbench';\n"
    "  ifr.title = '指点 ZhiDian v0.5 在线交互工作台';\n"
    "  ifr.style.cssText = 'width:100%;height:750px;border:0;display:block;background:#0b1324;';\n"
    "  ifr.setAttribute('allow', 'clipboard-read; clipboard-write; microphone');\n"
    f"  ifr.srcdoc = {_SERIALIZED_DOC};\n"
    "  host.innerHTML = '';\n"
    "  host.appendChild(ifr);\n"
    "}\n"
)

APP_CSS = """
.gradio-container { max-width: 1480px !important; padding-top: 8px !important; }
#rpc-bridge { display: none !important; }
footer { display: none !important; }
.demo-video-card { margin-top: 10px; border-radius: 12px; }
"""

with gr.Blocks(title="指点 ZhiDian v0.5 · 桌面办公智能体") as demo:
    gr.HTML(
        value=WORKBENCH_MOUNT_HTML,
        js_on_load=WORKBENCH_JS_ON_LOAD,
        padding=False,
        apply_default_css=False,
    )

    with gr.Accordion(
        "🎬 指点 ZhiDian v0.5 全功能真机实测演示视频（虚拟机全按钮无遮挡实测录屏 × Remotion 制作）",
        open=True,
        elem_classes=["demo-video-card"],
    ):
        gr.Video(
            value=str(DEMO_VIDEO_PATH) if DEMO_VIDEO_PATH.exists() else None,
            label="全功能实测录屏（单击小箭头 ↗ · 原地生成 PPTX/DOCX/PDF · F8 窗口防遮挡 · @1+@2 双光标异常核查 · 划词求和）",
            autoplay=False,
            interactive=False,
            height=480,
        )

    with gr.Accordion("📂 极速直传批处理面板（也可直接将您电脑里的多份 PDF / Word / Excel / 图片拖入此处一键生成下载）", open=False):
        with gr.Row():
            with gr.Column(scale=5):
                direct_files = gr.File(
                    label="上传一份或多份本地办公文件（.pdf / .docx / .xlsx / .csv / .md / .txt / .png / .jpg）",
                    file_count="multiple",
                    type="filepath",
                )
                direct_text = gr.Textbox(
                    label="或者直接粘贴需要处理的文字（可选，支持混排整理 / 数字求和 / 翻译 / 润色）",
                    lines=3,
                    placeholder="在此粘贴任意文本段落…",
                )
            with gr.Column(scale=5):
                direct_action = gr.Dropdown(
                    label="选择指点动作（或选第一项由自然语言自动路由）",
                    choices=QUICK_ACTIONS,
                    value="auto",
                )
                direct_param = gr.Textbox(
                    label="自然语言指令 / 动作参数（如：做成暖调纸PPT / 1-2, 末页 / 翻译成英文）",
                    placeholder="例如：把这几份文件做成暖调纸风格的演示PPT",
                )
                direct_run_btn = gr.Button("⚡ 立即执行并生成文件", variant="primary")
                direct_msg = gr.Textbox(label="执行结果", lines=4, interactive=False)
                direct_out = gr.File(label="下载生成结果文件", file_count="multiple")

        direct_run_btn.click(
            fn=handle_direct_batch,
            inputs=[direct_files, direct_action, direct_param, direct_text],
            outputs=[direct_msg, direct_out],
            api_name="direct_batch",
        )

    # Hidden RPC bridge called directly by the interactive ZhiDian Desktop iframe
    with gr.Row(elem_id="rpc-bridge"):
        rpc_in = gr.Textbox(label="rpc_in")
        rpc_out = gr.Textbox(label="rpc_out")
        rpc_btn = gr.Button("rpc_go")
        rpc_btn.click(fn=handle_rpc, inputs=[rpc_in], outputs=[rpc_out], api_name="zhidian_rpc")


if __name__ == "__main__":
    allowed = [str(WORKSPACE_ROOT), str(STUDIO_DIR / "assets")]
    demo.queue(default_concurrency_limit=8).launch(
        server_name="0.0.0.0",
        server_port=int(os.environ.get("PORT", "7860")),
        css=APP_CSS,
        allowed_paths=allowed,
    )
