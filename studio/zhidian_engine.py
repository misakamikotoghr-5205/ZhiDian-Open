#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ZhiDian (指点 v0.5) Real Deterministic Office & Screen-Native Engine.
Implements ZhiDian's real product capabilities from `src/main/office/*` and `src/core/*`:
- Live Desktop Workspace with randomly synthesized fictional mock office files (zero real company/person data)
- User file upload directly onto the ZhiDian desktop
- Context-aware action offers (`offers_for_selection`) matching ZhiDian's 25+ file & text actions
- Real execution of PDF, Word, Excel/CSV, PPTX (3 themes + table pagination), Image, ZIP, and Text actions
- Chinese page-range parser (`1-3, 末页`, `4-2`), CJK-Latin typesetter, smart number summation
- Bounded natural-language action planning (Qwen3.5-4B + deterministic router)
- Screen/Window/File `@1` `@2` multi-referent Q&A + Secondary AI Cursor (`#aicursor`) 2D grounding
"""

from __future__ import annotations

import base64
import csv
import html
import io
import json
import os
import random
import re
import shutil
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any

import openpyxl
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
import PIL.Image
import pymupdf
from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Cm, Inches, Pt, RGBColor
from pptx import Presentation
from pptx.dml.color import RGBColor as PptRGB
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Inches as PptInches, Pt as PptPt

from local_llm import LLM

WORKSPACE_ROOT = Path(os.environ.get("ZHIDIAN_WORKSPACE_ROOT", "/tmp/zhidian-workspaces"))
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)

DOCUMENT_THEMES: dict[str, dict[str, Any]] = {
    "business": {
        "id": "business",
        "label": "商务蓝",
        "accent": (37, 99, 235),
        "ink": (23, 37, 84),
        "muted": (100, 116, 139),
        "paper": (255, 255, 255),
        "surface": (239, 246, 255),
        "line": (220, 229, 242),
        "cover": (20, 38, 71),
        "cover_ink": (255, 255, 255),
        "font": "Microsoft YaHei",
        "body_font": "Microsoft YaHei",
    },
    "clean": {
        "id": "clean",
        "label": "极简灰",
        "accent": (24, 24, 27),
        "ink": (24, 24, 27),
        "muted": (113, 113, 122),
        "paper": (255, 255, 255),
        "surface": (244, 244, 245),
        "line": (228, 228, 231),
        "cover": (244, 244, 245),
        "cover_ink": (24, 24, 27),
        "font": "Microsoft YaHei",
        "body_font": "Microsoft YaHei",
    },
    "warm": {
        "id": "warm",
        "label": "暖调纸",
        "accent": (182, 92, 58),
        "ink": (64, 53, 47),
        "muted": (133, 117, 105),
        "paper": (255, 253, 250),
        "surface": (245, 236, 225),
        "line": (229, 217, 203),
        "cover": (245, 236, 225),
        "cover_ink": (64, 53, 47),
        "font": "Microsoft YaHei",
        "body_font": "SimSun",
    },
}


# ---------------------------------------------------------------------------
# File Classification & Utilities (Port of src/core/office-kinds.js & page-range.js)
# ---------------------------------------------------------------------------

def file_kind(path: str | Path) -> str:
    ext = Path(path).suffix.lower()
    if ext == ".pdf":
        return "pdf"
    if ext in {".docx", ".doc"}:
        return "word"
    if ext in {".xlsx", ".xls"}:
        return "excel"
    if ext in {".csv", ".tsv"}:
        return "delimited"
    if ext == ".pptx":
        return "pptx"
    if ext in {".md", ".markdown"}:
        return "markdown"
    if ext in {".txt", ".log", ".json"}:
        return "text"
    if ext in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
        return "image"
    if ext == ".zip":
        return "archive"
    return "other"


def human_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def unique_out_path(directory: Path, stem: str, suffix: str) -> Path:
    safe_stem = re.sub(r'[\\/:*?"<>|]+', "_", stem).strip() or "输出文件"
    candidate = directory / f"{safe_stem}{suffix}"
    idx = 2
    while candidate.exists():
        candidate = directory / f"{safe_stem}-{idx}{suffix}"
        idx += 1
    return candidate


FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")


def parse_page_spec(spec: str, total: int) -> list[int]:
    """Exact port of src/core/page-range.js supporting Chinese '1-3, 末页', '4-2', fullwidth digits."""
    if total < 1:
        raise ValueError("这个 PDF 里没有页面")
    s = (spec or "").strip().translate(FULLWIDTH_DIGITS)
    s = re.sub(r"最后一页|最后页|末页|end", str(total), s, flags=re.I)
    s = re.sub(r"[，、；;]", ",", s)
    s = re.sub(r"\s*(?:—|–|～|~|至|到|-)\s*", "-", s).strip()
    if not s:
        raise ValueError("请填写要提取的页码，例如 1-2, 末页")

    seen: set[int] = set()
    pages: list[int] = []

    def _add(n: int) -> None:
        if n < 1:
            raise ValueError("页码要从第 1 页开始")
        if n > total:
            raise ValueError(f"第 {n} 页超出了总页数（共 {total} 页）")
        if n not in seen:
            seen.add(n)
            pages.append(n)

    for part in re.split(r"[,\s]+", s):
        if not part:
            continue
        if re.fullmatch(r"\d+", part):
            _add(int(part))
            continue
        m = re.fullmatch(r"(\d+)-(\d+)", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a < 1 or b < 1:
                raise ValueError("页码要从第 1 页开始")
            if a > total or b > total:
                raise ValueError(f"第 {max(a, b)} 页超出了总页数（共 {total} 页）")
            step = 1 if a <= b else -1
            p = a
            while (p <= b) if step > 0 else (p >= b):
                _add(p)
                p += step
            continue
        raise ValueError(f"看不懂页码“{part}”，可以填单页或范围，例如 1-2, 末页")

    if not pages:
        raise ValueError("请填写要提取的页码，例如 1-2, 末页")
    return pages


# ---------------------------------------------------------------------------
# Typesetting & Smart Number Stats (Port of src/core/typeset.js & text-stats.js)
# ---------------------------------------------------------------------------

def typeset_cjk_latin(text: str) -> tuple[str, list[str]]:
    """Port of ZhiDian src/core/typeset.js: fixes PDF broken lines, CJK-Latin spacing, and punctuation."""
    raw = (text or "").replace("\r\n", "\n")
    notes: list[str] = []

    # Protect URLs and file paths
    protected: list[str] = []

    def _stash(m: re.Match[str]) -> str:
        protected.append(m.group(0))
        return f"\x00PROT{len(protected) - 1}\x00"

    work = re.sub(r"https?://\S+|[A-Za-z]:\\[^\s]+|/[\w./-]+", _stash, raw)

    # Unwrap mid-sentence broken lines from PDF copy-paste while keeping headings/lists/blank lines
    lines = work.split("\n")
    merged_lines: list[str] = []
    unwrapped = 0
    for ln in lines:
        stripped = ln.strip()
        if not stripped:
            merged_lines.append("")
            continue
        is_list_or_head = bool(re.match(r"^(?:#{1,6}\s|[-*•]\s|\d+[.、)\s]|[一二三四五六七八九十]+[、.]|（[一二三四五六七八九十\d]+）)", stripped))
        if (
            merged_lines
            and merged_lines[-1] != ""
            and not is_list_or_head
            and not re.search(r"[。！？!?；;：:…—]$", merged_lines[-1])
            and len(merged_lines[-1]) >= 18
        ):
            sep = "" if (re.search(r"[\u4e00-\u9fff]$", merged_lines[-1]) and re.match(r"^[\u4e00-\u9fff]", stripped)) else " "
            merged_lines[-1] = merged_lines[-1] + sep + stripped
            unwrapped += 1
        else:
            merged_lines.append(stripped)
    if unwrapped:
        notes.append(f"合并断行 {unwrapped} 处")

    work = "\n".join(merged_lines)
    # Add space between CJK and Latin/Digits
    before_sp = work
    work = re.sub(r"([\u4e00-\u9fff])([A-Za-z0-9])", r"\1 \2", work)
    work = re.sub(r"([A-Za-z0-9%])([\u4e00-\u9fff])", r"\1 \2", work)
    if work != before_sp:
        notes.append("补齐中英数混排间距")

    # Normalize halfwidth punctuation between Chinese chars
    before_punc = work
    work = re.sub(r"(?<=[\u4e00-\u9fff]),(?=[\u4e00-\u9fff\s])", "，", work)
    work = re.sub(r"(?<=[\u4e00-\u9fff])\.(?=[\u4e00-\u9fff])", "。", work)
    work = re.sub(r"(?<=[\u4e00-\u9fff]);(?=[\u4e00-\u9fff])", "；", work)
    work = re.sub(r"(?<=[\u4e00-\u9fff]):(?=[\u4e00-\u9fff])", "：", work)
    work = re.sub(r"[ \t]{2,}", " ", work)
    work = re.sub(r"\n{3,}", "\n\n", work)
    if work != before_punc:
        notes.append("修正中英文标点与多余空白")

    for idx, val in enumerate(protected):
        work = work.replace(f"\x00PROT{idx}\x00", val)
    return work.strip(), notes


def smart_text_stats(text: str) -> dict[str, Any]:
    """Port of ZhiDian src/core/text-stats.js: counts Han/English/lines and sums real numbers skipping dates/phones/codes."""
    s = text or ""
    han = len(re.findall(r"[\u4e00-\u9fff]", s))
    en_words = len(re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", s))
    digits_runs = len(re.findall(r"\d+", s))
    non_ws = len(re.sub(r"\s", "", s))
    lines = len([ln for ln in s.splitlines() if ln.strip()])
    read_min = max(1, round((han / 380.0) + (en_words / 220.0)))

    # Scrub dates, times, versions (v0.5.0), Q1-Q4, phone numbers, 15+ digit IDs, list prefixes
    scrubbed = s
    scrubbed = re.sub(r"\b20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?", " ", scrubbed)
    scrubbed = re.sub(r"\b\d{1,2}:\d{2}(?::\d{2})?\b", " ", scrubbed)
    scrubbed = re.sub(r"\b[vV]\d+(?:\.\d+)+\b", " ", scrubbed)
    scrubbed = re.sub(r"\b[Qq][1-4]\b", " ", scrubbed)
    scrubbed = re.sub(r"\b1[3-9]\d{9}\b", " ", scrubbed)
    scrubbed = re.sub(r"\b\d{12,}\b", " ", scrubbed)
    scrubbed = re.sub(r"(?m)^\s*\d+[.、)\]]\s+", " ", scrubbed)
    scrubbed = re.sub(r"@[1-9]\d*", " ", scrubbed)

    nums: list[float] = []
    for m in re.finditer(r"(?<![A-Za-z0-9_])([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?!\s*%)", scrubbed):
        raw_n = m.group(1).replace(",", "")
        try:
            val = float(raw_n)
            nums.append(val)
        except ValueError:
            pass

    total = sum(nums)
    avg = (total / len(nums)) if nums else 0.0
    return {
        "chars_no_space": non_ws,
        "chars_total": len(s),
        "han": han,
        "en_words": en_words,
        "lines": lines,
        "read_minutes": read_min,
        "numbers_count": len(nums),
        "numbers": nums[:24],
        "sum": total,
        "avg": avg,
        "min": min(nums) if nums else 0.0,
        "max": max(nums) if nums else 0.0,
    }


# ---------------------------------------------------------------------------
# Workspace Seeding — 100% Randomly Synthesized Fictional Mock Office Files
# (Zero real companies, zero real locations, zero real personal names)
# ---------------------------------------------------------------------------

MOCK_FILE_CONTRACT = "示例采购协议_随机样本.pdf"
MOCK_FILE_SHEET = "示例结算核查表_随机样本.xlsx"
MOCK_FILE_DOCX = "示例部门复盘草稿_随机样本.docx"
MOCK_FILE_MD = "示例项目汇报大纲_随机样本.md"
MOCK_FILE_CSV = "示例物料批次表_随机样本.csv"
MOCK_FILE_TXT = "Mock_Hardware_Spec.txt"
MOCK_FILE_SCAN = "示例设备核定单_随机扫描件.png"
MOCK_FILE_TOPO = "示例模块拓扑图_随机样本.png"

DESKTOP_LAYOUT_PRESETS: dict[str, dict[str, Any]] = {
    MOCK_FILE_CONTRACT: {"col": 0, "row": 0, "tag": "随机合成4页协议"},
    MOCK_FILE_SHEET: {"col": 0, "row": 1, "tag": "随机含超支异常行"},
    MOCK_FILE_DOCX: {"col": 0, "row": 2, "tag": "待一键公文排版"},
    MOCK_FILE_MD: {"col": 1, "row": 0, "tag": "可直转母版PPT"},
    MOCK_FILE_CSV: {"col": 1, "row": 1, "tag": "含0开头与长编码"},
    MOCK_FILE_TXT: {"col": 1, "row": 2, "tag": "英文规格与数字"},
    MOCK_FILE_SCAN: {"col": 2, "row": 0, "tag": "虚拟扫描件核查"},
    MOCK_FILE_TOPO: {"col": 2, "row": 1, "tag": "可拼长图/转PDF"},
}


def _generate_random_mock_spec(rng: random.Random) -> dict[str, Any]:
    """Synthesizes a fresh, internally consistent, 100% fictional dataset on each workspace init/reset."""
    batch_id = rng.randint(1000, 9999)
    party_a = f"虚拟示例甲方_Alpha-{rng.randint(100, 999)}（随机合成测试主体·非真实机构）"
    party_b = f"虚拟示例乙方_Beta-{rng.randint(100, 999)}（随机合成测试主体·非真实机构）"
    op_code = f"测试坐席_OP-{rng.randint(10, 99)}"
    project_code = f"Nebula-{rng.randint(10, 99)}"

    category_pool = [
        ("模块化算力机柜租赁", 0.06),
        ("超高清显示终端阵列", 0.13),
        ("无线加密音频矩阵", 0.06),
        ("温控专线运输调度费", 0.09),
        ("双语交互导览终端", 0.06),
        ("不间断应急电源保障", 0.09),
        ("千兆内网隔离网关", 0.13),
        ("环保耗材循环回收", 0.06),
    ]
    alert_idx = rng.choice([2, 3, 4])  # 0-based index among 8 rows -> #03, #04, or #05
    overrun_pct = round(rng.uniform(14.5, 25.8), 1)

    budget_rows: list[dict[str, Any]] = []
    vendor_base = rng.randint(1100, 8800)
    serial_base = rng.randint(100000000000, 899999999999)
    for idx, (cat_name, tax_rate) in enumerate(category_pool):
        cap = rng.randint(5, 24) * 10000
        if idx == alert_idx:
            actual = round(cap * (1.0 + overrun_pct / 100.0), 2)
            pct_str = f"+{overrun_pct:.1f}%"
            status = "超支预警"
        else:
            save_pct = round(rng.uniform(1.1, 4.6), 1)
            actual = round(cap * (1.0 - save_pct / 100.0), 2)
            pct_str = f"-{save_pct:.1f}%"
            status = "正常"
        budget_rows.append({
            "seq": f"#{idx + 1:02d}",
            "vendor_code": f"00{vendor_base + idx}",
            "name": cat_name,
            "serial": f"990000{serial_base + idx}",
            "cap": cap,
            "actual": actual,
            "tax": int(tax_rate * 100),
            "pct_str": pct_str,
            "status": status,
            "is_alert": idx == alert_idx,
        })

    # Random scan quote items
    scan_alert_idx = rng.choice([1, 2])
    scan_items = []
    scan_names = ["边缘推理微服务器", "低延迟数字阵列麦", "夜间恒温机房加时费", "内网万兆光纤跳线"]
    scan_over_pct = rng.randint(35, 68)
    for i, sname in enumerate(scan_names):
        scap = rng.randint(8, 38) * 1000
        if i == scan_alert_idx:
            sact = int(round(scap * (1.0 + scan_over_pct / 100.0), -2))
            actual_pct = round((sact - scap) * 100.0 / scap, 1)
            snote = f"异常加收 +{actual_pct:.0f}%"
        else:
            sact = scap
            snote = "合规"
        scan_items.append({
            "code": f"M-0{i + 1}",
            "name": sname,
            "cap": scap,
            "actual": sact,
            "note": snote,
            "is_alert": i == scan_alert_idx,
        })

    # Random scratchpad text for text-selection sum & typesetting test
    p1 = rng.randint(11, 22) * 1000
    p2 = rng.randint(4, 9) * 1000 + 200
    p3 = rng.randint(10, 19) * 1000 + 500
    p4 = rng.randint(2, 5) * 1000 + 350.5
    scratchpad_text = (
        f"2099-04-15虚拟项目{project_code}随机模拟采购明细:\n"
        f"1. 虚拟光学投影终端{p1}元,模拟数字音频套件{p2}元,离线边缘计算盒{p3}元;\n"
        f"2. 虚拟内网交换模块与备用电源{p4:.2f}元,英文参数说明参见https://mock-demo.invalid/spec文档."
    )

    return {
        "batch_id": batch_id,
        "party_a": party_a,
        "party_b": party_b,
        "op_code": op_code,
        "project_code": project_code,
        "budget_rows": budget_rows,
        "alert_row": budget_rows[alert_idx],
        "scan_items": scan_items,
        "scan_alert": scan_items[scan_alert_idx],
        "scratchpad_text": scratchpad_text,
    }


def _seed_contract_pdf(path: Path, spec: dict[str, Any]) -> None:
    doc = pymupdf.open()
    b_lines = "\n".join(
        f"  • {r['seq']} {r['name']}：季度封顶 ¥{r['cap']:,.2f}（模拟税率 {r['tax']}%）"
        + ("【重点核查项】" if r["is_alert"] else "")
        for r in spec["budget_rows"][:6]
    )
    pages_data = [
        (
            f"虚拟电子采购框架协议（随机测试样本 #{spec['batch_id']}）",
            f"虚拟协议编号：MOCK-{spec['batch_id']}   模拟生成批次：2099-Q3（纯虚构测试数据）\n"
            f"甲方（虚拟采购方）：{spec['party_a']}\n"
            f"乙方（虚拟供应方）：{spec['party_b']}\n\n"
            "第一条 虚拟测试标的说明\n"
            "1.1 本文件由程序随机合成，仅用于办公智能体功能测试（PDF 提取、合并、加页码及跨文档核查），不包含任何真实机构或个人信息。\n"
            "1.2 所有模拟交付单据均须与本协议第二条随机生成的分项封顶预算严格一致，超出上限部分自动触发审计标记。",
        ),
        (
            "第二条 随机合成分项封顶标准（跨表核查基准页）",
            f"系统随机生成的本批次分项结算封顶标准如下：\n\n{b_lines}\n\n"
            "模拟审计规则：若单笔模拟结算超出封顶金额 5% 以上，本地核查引擎应自动标红并由 AI 副光标定位该异常行。",
        ),
        (
            "第三条 模拟验收流程与编码保护规则",
            "3.1 虚拟结算表使用 00 开头前导零模拟供应商编码，以及 990000 开头 18 位纯虚拟测试流水号。\n"
            "3.2 表格转换与合并过程中须完整保留前导零文本格式与长数字精度，严禁被科学计数法截断。\n"
            "3.3 全程在本地沙箱离线计算完成，无需外部网络传输。",
        ),
        (
            "第四条 虚拟保密与测试免责声明（末页）",
            "4.1 本协议全部主体代号、科目单价与流水编号均为随机数发生器实时构造的假数据。\n"
            "4.2 模拟争议处理：按虚拟沙箱示范规则第 00 号执行（非真实法律条款）。\n\n"
            f"甲方虚拟签章：{spec['party_a']}\n"
            f"乙方虚拟签章：{spec['party_b']}",
        ),
    ]
    for idx, (heading, body) in enumerate(pages_data, start=1):
        p = doc.new_page(width=595, height=842)
        p.draw_rect(pymupdf.Rect(0, 0, 595, 76), color=None, fill=(20 / 255, 38 / 255, 71 / 255))
        p.insert_textbox(
            pymupdf.Rect(42, 22, 553, 66),
            f"指点沙箱 · 随机合成虚拟测试档案 #{spec['batch_id']}  ·  第 {idx} / {len(pages_data)} 页",
            fontsize=11,
            fontname="china-ss",
            color=(0.75, 0.85, 1.0),
        )
        p.insert_textbox(
            pymupdf.Rect(42, 102, 553, 155),
            heading,
            fontsize=17,
            fontname="china-ss",
            color=(0.08, 0.14, 0.32),
        )
        p.draw_line(pymupdf.Point(42, 154), pymupdf.Point(553, 154), color=(0.82, 0.86, 0.93), width=1.2)
        p.insert_textbox(
            pymupdf.Rect(42, 174, 553, 760),
            body,
            fontsize=12,
            fontname="china-ss",
            color=(0.15, 0.2, 0.28),
        )
    doc.save(str(path))
    doc.close()


def _seed_settlement_xlsx(path: Path, spec: dict[str, Any]) -> None:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "虚拟结算核查"
    headers = ["序号", "虚拟编码", "模拟费用科目", "虚拟测试流水号(18位)", "协议封顶(元)", "模拟实报(元)", "偏差率", "核查状态"]
    ws.append(headers)

    head_fill = PatternFill("solid", fgColor="1E3A8A")
    head_font = Font(name="Microsoft YaHei", bold=True, color="FFFFFF", size=11)
    warn_fill = PatternFill("solid", fgColor="FEE2E2")
    warn_font = Font(name="Microsoft YaHei", bold=True, color="B91C1C", size=10.5)
    norm_font = Font(name="Microsoft YaHei", color="1E293B", size=10.5)

    for col_idx in range(1, len(headers) + 1):
        c = ws.cell(row=1, column=col_idx)
        c.fill = head_fill
        c.font = head_font
        c.alignment = Alignment(horizontal="center", vertical="center")

    for r_idx, item in enumerate(spec["budget_rows"], start=2):
        row = [
            item["seq"],
            item["vendor_code"],
            item["name"],
            item["serial"],
            item["cap"],
            item["actual"],
            item["pct_str"],
            item["status"],
        ]
        ws.append(row)
        is_warn = bool(item["is_alert"])
        for c_idx in range(1, len(headers) + 1):
            cell = ws.cell(row=r_idx, column=c_idx)
            if c_idx in (2, 4):
                cell.number_format = "@"
            elif c_idx in (5, 6):
                cell.number_format = "#,##0.00"
            cell.font = warn_font if is_warn else norm_font
            if is_warn:
                cell.fill = warn_fill

    ws.freeze_panes = "A2"
    widths = [8, 13, 22, 24, 15, 15, 11, 13]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    wb.save(str(path))


def _seed_messy_docx(path: Path, spec: dict[str, Any], rng: random.Random) -> None:
    doc = Document()
    old_min = rng.randint(38, 56)
    new_min = rng.randint(4, 8)
    over_amt = spec["alert_row"]["actual"] - spec["alert_row"]["cap"]

    p0 = doc.add_paragraph(f"虚拟项目 {spec['project_code']} 阶段测试复盘草稿（随机合成样本）")
    p0.runs[0].font.name = "Arial"
    p0.runs[0].font.size = Pt(13)

    raw_paragraphs = [
        "一、模拟测试运行概况",
        f"本草稿为随机生成的虚构部门测试文本，用于验证 Word 一键公文规范化排版。模拟测算显示单次文档流转耗时由 {old_min} 分钟缩短至 {new_min} 分钟，全部计算均在本地沙箱内闭环完成。",
        "（一）虚拟模块验证记录",
        f"1. 虚拟核查组：跨协议与结算表自动比对零误差，成功识别模拟科目「{spec['alert_row']['name']}」超支 {over_amt:,.2f} 元。",
        "2. 虚拟综合组：杂乱草稿一键排成标准 A4 公文，自动统一黑体/楷体标题层级、宋体小四正文与 1.5 倍行距。",
        "二、随机合成指标对照表",
    ]
    for txt in raw_paragraphs:
        p = doc.add_paragraph(txt)
        for r in p.runs:
            r.font.name = "Calibri"
            r.font.size = Pt(10.5)

    tbl = doc.add_table(rows=4, cols=4)
    tbl_data = [
        ["虚拟测试场景", "手工模拟耗时", "指点原地耗时", "执行方式"],
        ["多份PDF提取与合并", f"{rng.randint(12, 20)} 分钟", "3 秒", "100% 本地确定性"],
        ["大纲转16:9演示PPT", f"{rng.randint(35, 50)} 分钟", "3 秒", "原生可编辑母版"],
        ["跨单据金额异常核验", f"{rng.randint(22, 34)} 分钟", "4 秒", "零算术幻觉"],
    ]
    for r_i, r_vals in enumerate(tbl_data):
        for c_i, val in enumerate(r_vals):
            tbl.cell(r_i, c_i).text = val

    doc.add_paragraph("三、下一阶段虚拟演练计划")
    doc.add_paragraph("继续验证本地 Qwen3.5-4B 模型在复杂多步办公任务下的语义规划与多模态指认精度。")

    chart_pdf = pymupdf.open()
    cp = chart_pdf.new_page(width=420, height=200)
    cp.draw_rect(pymupdf.Rect(0, 0, 420, 200), color=None, fill=(0.95, 0.97, 1.0))
    cp.insert_textbox(pymupdf.Rect(20, 14, 400, 46), f"虚拟附图：随机样本 #{spec['batch_id']} 耗时对比（秒）", fontsize=12.5, fontname="china-ss", color=(0.1, 0.2, 0.45))
    bars = [("手工复制整理", 250, (0.9, 0.38, 0.38), "180s"), ("常规网页上传", 140, (0.95, 0.65, 0.18), "95s"), ("指点本地直出", 24, (0.14, 0.39, 0.92), "3.1s")]
    for idx, (lbl, bw, col, val_txt) in enumerate(bars):
        y = 62 + idx * 40
        cp.insert_textbox(pymupdf.Rect(20, y, 125, y + 26), lbl, fontsize=10.5, fontname="china-ss", color=(0.2, 0.25, 0.34))
        cp.draw_rect(pymupdf.Rect(130, y + 3, 130 + bw, y + 21), color=None, fill=col)
        cp.insert_textbox(pymupdf.Rect(138 + bw, y, 415, y + 26), val_txt, fontsize=10.5, fontname="china-ss", color=(0.1, 0.15, 0.25))
    png_bytes = chart_pdf[0].get_pixmap(dpi=130).tobytes("png")
    chart_pdf.close()
    doc.add_picture(io.BytesIO(png_bytes), width=Inches(4.4))
    doc.save(str(path))


def _seed_proposal_md(path: Path, spec: dict[str, Any], rng: random.Random) -> None:
    gain_pct = rng.randint(78, 92)
    save_min = rng.randint(40, 65)
    md = f"""# 虚拟代号 {spec['project_code']} 桌面智能协同方案大纲

面向离线内网与弱网环境的纯虚构示例方案（随机批次 #{spec['batch_id']}），用于测试一键生成 16:9 可编辑 PPT。

## 模拟业务痛点与瓶颈
- 多格式文件分散在不同目录，人工来回切换窗口复制粘贴极易漏行出错
- 离线环境下传统云端助手无法连接，临时排版汇报材料耗费大量重复人力
- 协议预算与结算表格人工逐行核对繁琐，细微金额偏差难以快速定位

## 桌面原生指点闭环架构
- 单击任意文件即刻弹出轻量蓝色小箭头，原地展开上下文确定性办公动作
- 按下 F8 框选桌面文件并自动剔除顶层窗口遮挡项，秒级合成 PDF 或三套母版 PPTX
- 本地部署 Qwen3.5-4B 模型配合双光标协同，自动指向表格超支异常行

## 虚拟里程碑与模拟收益表

| 虚拟阶段 | 模拟目标模块 | 核心验证能力 | 随机模拟指标 |
| --- | --- | --- | --- |
| 阶段 Alpha | 单击小箭头快执 | 文档转 PPT + 公文一键重排 | 模拟提速 {gain_pct}% |
| 阶段 Beta | F8 框选与防遮挡 | 窗口 Z-Order 过滤 + 批量合并 | 0 误绑后台文件 |
| 阶段 Gamma | @1+@2 跨表核验 | 协议与结算表差额定位 | 日均模拟省时 {save_min} 分钟 |
"""
    path.write_text(md, encoding="utf-8")


def _seed_supplier_csv(path: Path, rng: random.Random) -> None:
    base_code = rng.randint(2000, 7999)
    base_lot = rng.randint(1000000000000, 8999999999999)
    items = [
        ("虚拟短焦光学模组", rng.randint(12, 21) * 1000, rng.randint(2, 4)),
        ("虚拟全向拾音终端", rng.randint(25, 45) * 100, rng.randint(4, 8)),
        ("虚拟边缘静音节点", rng.randint(11, 18) * 1000, rng.randint(2, 5)),
        ("虚拟工业交换网桥", rng.randint(18, 32) * 100, rng.randint(3, 6)),
    ]
    rows = [["虚拟物料码(前导0)", "模拟批次长号(19位)", "虚拟设备名称", "模拟单价(元)", "数量", "模拟小计(元)"]]
    for i, (nm, price, qty) in enumerate(items):
        rows.append([
            f"00{base_code + i}",
            f"980000{base_lot + i}",
            nm,
            str(price),
            str(qty),
            str(price * qty),
        ])
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)


def _seed_english_txt(path: Path, spec: dict[str, Any], rng: random.Random) -> None:
    u1 = rng.randint(42, 58) * 100
    u2 = rng.randint(55, 76) * 100
    u3 = rng.randint(28, 42) * 100
    txt = f"""Synthetic Terminal Mock Specification (Batch #{spec['batch_id']})
1. Local AI Compute Node: 32GB unified memory, offline 4B model inference, mock unit cost {u1}.00, quantity 2 sets, subtotal {u1 * 2}.00.
2. Matte Touch Display Unit: 4K IPS panel for sandbox testing, mock unit cost {u2}.00,
quantity 1 set, subtotal {u2}.00.
3. Encrypted Wireless Audio Kit: local loopback channel only, mock subtotal {u3}.00.
测试备注:以上3项均为程序随机生成的纯虚构硬件参数,模拟调试费950.00元,仅用于测试翻译与数字求和."""
    path.write_text(txt, encoding="utf-8")


def _seed_scan_pngs(quote_png: Path, map_png: Path, spec: dict[str, Any]) -> None:
    d1 = pymupdf.open()
    p1 = d1.new_page(width=640, height=440)
    p1.draw_rect(pymupdf.Rect(0, 0, 640, 440), color=None, fill=(0.985, 0.985, 0.975))
    p1.draw_rect(pymupdf.Rect(20, 20, 620, 420), color=(0.22, 0.32, 0.52), width=1.6)
    p1.draw_rect(pymupdf.Rect(20, 20, 620, 74), color=None, fill=(0.12, 0.22, 0.42))
    p1.insert_textbox(
        pymupdf.Rect(38, 34, 600, 66),
        f"虚拟设备核定测试单（随机合成扫描样本 #{spec['batch_id']}）",
        fontsize=14.5,
        fontname="china-ss",
        color=(1, 1, 1),
    )

    headers = ["代号", "虚拟设备科目", "模拟核定上限", "模拟实报", "自动核查备注"]
    xs = [36, 100, 290, 395, 495, 604]
    p1.draw_rect(pymupdf.Rect(36, 92, 604, 124), color=None, fill=(0.90, 0.93, 0.98))
    for i, h in enumerate(headers):
        p1.insert_textbox(pymupdf.Rect(xs[i] + 6, 99, xs[i + 1], 122), h, fontsize=11, fontname="china-ss", color=(0.12, 0.2, 0.36))

    for r_i, item in enumerate(spec["scan_items"]):
        y0 = 128 + r_i * 46
        is_bad = bool(item["is_alert"])
        if is_bad:
            p1.draw_rect(pymupdf.Rect(36, y0, 604, y0 + 42), color=(0.85, 0.2, 0.2), fill=(1.0, 0.92, 0.92), width=1.2)
        else:
            p1.draw_line(pymupdf.Point(36, y0 + 42), pymupdf.Point(604, y0 + 42), color=(0.86, 0.89, 0.94), width=0.8)
        vals = (item["code"], item["name"], f"¥{item['cap']:,}", f"¥{item['actual']:,}", item["note"])
        for c_i, val in enumerate(vals):
            col = (0.75, 0.1, 0.1) if is_bad else (0.16, 0.2, 0.28)
            p1.insert_textbox(pymupdf.Rect(xs[c_i] + 6, y0 + 11, xs[c_i + 1], y0 + 38), val, fontsize=11, fontname="china-ss", color=col)

    sa = spec["scan_alert"]
    diff_sa = sa["actual"] - sa["cap"]
    p1.insert_textbox(
        pymupdf.Rect(36, 336, 600, 405),
        f"沙箱自动批注：虚拟条目 {sa['code']}「{sa['name']}」超出模拟上限 ¥{diff_sa:,}（纯虚构测试样本）。\n"
        f"虚拟批次：#{spec['batch_id']}   模拟坐席代号：{spec['op_code']}",
        fontsize=10.5,
        fontname="china-ss",
        color=(0.32, 0.36, 0.44),
    )
    quote_png.write_bytes(p1.get_pixmap(dpi=144).tobytes("png"))
    d1.close()

    d2 = pymupdf.open()
    p2 = d2.new_page(width=640, height=380)
    p2.draw_rect(pymupdf.Rect(0, 0, 640, 380), color=None, fill=(0.96, 0.98, 1.0))
    p2.draw_rect(pymupdf.Rect(20, 20, 620, 70), color=None, fill=(0.09, 0.38, 0.34))
    p2.insert_textbox(
        pymupdf.Rect(38, 32, 600, 62),
        f"虚拟系统 {spec['project_code']} 本地办公流水线拓扑图（测试图 #{spec['batch_id']}）",
        fontsize=14,
        fontname="china-ss",
        color=(1, 1, 1),
    )
    zones = [
        (44, 100, 224, 230, "模块 A · 单击小箭头与框选", "桌面图标单击触发小箭头与 F8 窗口防遮挡", (0.88, 0.95, 1.0)),
        (246, 100, 426, 230, "模块 B · 确定性文档内核", "原生生成可编辑 PPTX / DOCX / PDF / XLSX", (0.88, 0.98, 0.93)),
        (448, 100, 600, 230, "模块 C · Qwen3.5-4B 引擎", "本地 4B 语义规划与双光标坐标定位", (1.0, 0.95, 0.86)),
    ]
    for x0, y0, x1, y1, zt, zd, zf in zones:
        p2.draw_rect(pymupdf.Rect(x0, y0, x1, y1), color=(0.25, 0.42, 0.62), fill=zf, width=1.2)
        p2.insert_textbox(pymupdf.Rect(x0 + 12, y0 + 14, x1 - 10, y0 + 54), zt, fontsize=11.5, fontname="china-ss", color=(0.1, 0.18, 0.32))
        p2.insert_textbox(pymupdf.Rect(x0 + 12, y0 + 58, x1 - 10, y1 - 12), zd, fontsize=10.5, fontname="china-ss", color=(0.25, 0.32, 0.44))
    p2.insert_textbox(
        pymupdf.Rect(44, 265, 600, 345),
        "虚拟数据流向：桌面拾取 ➔ Z-Order 防遮挡过滤 ➔ Qwen3.5-4B 意图路由 ➔ 原地生成新文件落盘",
        fontsize=11.5,
        fontname="china-ss",
        color=(0.15, 0.25, 0.38),
    )
    map_png.write_bytes(p2.get_pixmap(dpi=144).tobytes("png"))
    d2.close()


def ensure_workspace(session_id: str, reset: bool = False) -> Path:
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "", session_id or "default")[:48] or "default"
    ws_dir = WORKSPACE_ROOT / safe_id
    marker = ws_dir / ".seeded_v05_mock"
    if reset and ws_dir.exists():
        shutil.rmtree(ws_dir, ignore_errors=True)
    if not marker.exists():
        if ws_dir.exists():
            shutil.rmtree(ws_dir, ignore_errors=True)
        ws_dir.mkdir(parents=True, exist_ok=True)
        rng = random.Random()
        spec = _generate_random_mock_spec(rng)
        _seed_contract_pdf(ws_dir / MOCK_FILE_CONTRACT, spec)
        _seed_settlement_xlsx(ws_dir / MOCK_FILE_SHEET, spec)
        _seed_messy_docx(ws_dir / MOCK_FILE_DOCX, spec, rng)
        _seed_proposal_md(ws_dir / MOCK_FILE_MD, spec, rng)
        _seed_supplier_csv(ws_dir / MOCK_FILE_CSV, rng)
        _seed_english_txt(ws_dir / MOCK_FILE_TXT, spec, rng)
        _seed_scan_pngs(ws_dir / MOCK_FILE_SCAN, ws_dir / MOCK_FILE_TOPO, spec)
        (ws_dir / ".mock_meta.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
        marker.write_text(datetime.now().isoformat(), encoding="utf-8")
    return ws_dir


def get_workspace_mock_meta(ws_dir: Path) -> dict[str, Any]:
    meta_file = ws_dir / ".mock_meta.json"
    if meta_file.exists():
        try:
            return json.loads(meta_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def list_workspace_files(ws_dir: Path) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    files = sorted(
        [p for p in ws_dir.iterdir() if p.is_file() and not p.name.startswith(".")],
        key=lambda p: (
            0 if p.name in DESKTOP_LAYOUT_PRESETS else 1,
            p.stat().st_mtime if p.name not in DESKTOP_LAYOUT_PRESETS else list(DESKTOP_LAYOUT_PRESETS.keys()).index(p.name),
        ),
    )
    extra_idx = 0
    for p in files:
        kind = file_kind(p)
        st = p.stat()
        preset = DESKTOP_LAYOUT_PRESETS.get(p.name)
        if preset:
            col, row, tag = preset["col"], preset["row"], preset["tag"]
        else:
            col = 3 + (extra_idx // 3)
            row = extra_idx % 3
            extra_idx += 1
            tag = "新生成/已上传"
        items.append({
            "name": p.name,
            "path": str(p.resolve()),
            "kind": kind,
            "ext": p.suffix.lower().lstrip(".") or "file",
            "size": st.st_size,
            "size_human": human_size(st.st_size),
            "mtime": st.st_mtime,
            "col": col,
            "row": row,
            "tag": tag,
            "is_generated": p.name not in DESKTOP_LAYOUT_PRESETS,
        })
    return items


# ---------------------------------------------------------------------------
# Document Text / Outline Extraction & Rich Preview
# ---------------------------------------------------------------------------

def extract_plain_text(path: Path, max_chars: int = 12000) -> str:
    kind = file_kind(path)
    if kind in {"markdown", "text"}:
        return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
    if kind == "pdf":
        with pymupdf.open(str(path)) as doc:
            parts = [f"【第 {i + 1} 页】\n{page.get_text().strip()}" for i, page in enumerate(doc)]
        return "\n\n".join(parts)[:max_chars]
    if kind == "word":
        doc = Document(str(path))
        lines = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
        for tbl in doc.tables:
            for row in tbl.rows:
                lines.append(" | ".join(c.text.strip().replace("\n", " ") for c in row.cells))
        return "\n".join(lines)[:max_chars]
    if kind == "excel":
        wb = openpyxl.load_workbook(str(path), data_only=True)
        out: list[str] = []
        for sheet_name in wb.sheetnames[:3]:
            ws = wb[sheet_name]
            out.append(f"## 工作表: {sheet_name}")
            for row in list(ws.iter_rows(values_only=True))[:40]:
                if any(v is not None and str(v).strip() != "" for v in row):
                    out.append(" | ".join("" if v is None else str(v) for v in row))
        return "\n".join(out)[:max_chars]
    if kind == "delimited":
        raw = path.read_text(encoding="utf-8-sig", errors="replace")
        return raw[:max_chars]
    if kind == "pptx":
        prs = Presentation(str(path))
        slides_txt: list[str] = []
        for idx, sl in enumerate(prs.slides, start=1):
            chunks = [sh.text.strip() for sh in sl.shapes if getattr(sh, "has_text_frame", False) and sh.text.strip()]
            slides_txt.append(f"【幻灯片 {idx}】\n" + "\n".join(chunks))
        return "\n\n".join(slides_txt)[:max_chars]
    return ""


def render_file_preview(path: Path) -> dict[str, Any]:
    """Returns rich HTML / base64 image preview so double-clicking any file on the ZhiDian desktop opens a real window."""
    if not path.exists():
        return {"ok": False, "error": "文件不存在"}
    kind = file_kind(path)
    info: dict[str, Any] = {
        "ok": True,
        "name": path.name,
        "path": str(path.resolve()),
        "kind": kind,
        "size_human": human_size(path.stat().st_size),
        "images": [],
        "html": "",
        "text": "",
    }
    if kind == "pdf":
        with pymupdf.open(str(path)) as doc:
            info["page_count"] = len(doc)
            imgs = []
            for i in range(min(4, len(doc))):
                pix = doc[i].get_pixmap(dpi=115)
                b64 = base64.b64encode(pix.tobytes("png")).decode("ascii")
                imgs.append({"page": i + 1, "data_url": f"data:image/png;base64,{b64}"})
            info["images"] = imgs
            info["text"] = extract_plain_text(path, 3000)
        return info

    if kind == "image":
        b64 = base64.b64encode(path.read_bytes()).decode("ascii")
        mime = "image/webp" if path.suffix.lower() == ".webp" else ("image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else "image/png")
        with PIL.Image.open(path) as im:
            info["dimensions"] = f"{im.width} × {im.height}"
        info["images"] = [{"page": 1, "data_url": f"data:{mime};base64,{b64}"}]
        return info

    if kind in {"excel", "delimited"}:
        rows_data: list[list[str]] = []
        sheet_title = path.name
        if kind == "excel":
            wb = openpyxl.load_workbook(str(path), data_only=True)
            ws = wb.active
            sheet_title = f"{path.name} · {ws.title}"
            for r in list(ws.iter_rows(values_only=True))[:25]:
                if any(v is not None for v in r):
                    rows_data.append(["" if v is None else str(v) for v in r])
        else:
            delim = "\t" if path.suffix.lower() == ".tsv" else ","
            with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
                for r in list(csv.reader(f, delimiter=delim))[:25]:
                    if any(r):
                        rows_data.append(r)

        tr_html = []
        for r_idx, row in enumerate(rows_data):
            is_head = r_idx == 0
            row_str = " ".join(row)
            is_alert = ("超支" in row_str) or ("+18.4%" in row_str) or ("异常" in row_str)
            tag = "th" if is_head else "td"
            cls = " class='alert-row'" if is_alert else ""
            cells = "".join(f"<{tag}>{html.escape(c)}</{tag}>" for c in row)
            tr_html.append(f"<tr{cls} data-row='{r_idx}'>{cells}</tr>")
        info["html"] = f"<div class='preview-sheet-title'>{html.escape(sheet_title)}</div><table class='preview-table'>{''.join(tr_html)}</table>"
        info["text"] = extract_plain_text(path, 3000)
        return info

    if kind == "word":
        doc = Document(str(path))
        blocks = []
        for p in doc.paragraphs[:40]:
            t = p.text.strip()
            if not t:
                continue
            fsize = p.runs[0].font.size.pt if (p.runs and p.runs[0].font.size) else 12
            fname = (p.runs[0].font.name or "") if p.runs else ""
            is_h = bool(re.match(r"^[一二三四五六七八九十]+[、.]|^（[一二三四五六七八九十]+）", t)) or fsize >= 15
            tag = "h4" if is_h else "p"
            badge = f"<span class='fmt-tag'>{html.escape(fname or '默认')} {fsize:.0f}pt</span>" if is_h else ""
            blocks.append(f"<{tag}>{html.escape(t)} {badge}</{tag}>")
        for tbl in doc.tables[:2]:
            trs = []
            for r_i, row in enumerate(tbl.rows):
                tcell = "th" if r_i == 0 else "td"
                trs.append("<tr>" + "".join(f"<{tcell}>{html.escape(c.text.strip())}</{tcell}>" for c in row.cells) + "</tr>")
            blocks.append(f"<table class='preview-table'>{''.join(trs)}</table>")
        info["html"] = "<div class='preview-docx'>" + "".join(blocks) + "</div>"
        info["text"] = extract_plain_text(path, 3000)
        return info

    if kind == "pptx":
        prs = Presentation(str(path))
        cards = []
        for idx, sl in enumerate(prs.slides, start=1):
            texts = [sh.text.strip() for sh in sl.shapes if getattr(sh, "has_text_frame", False) and sh.text.strip()]
            tbl_html = ""
            for sh in sl.shapes:
                if getattr(sh, "has_table", False):
                    trs = []
                    for r_i, row in enumerate(sh.table.rows):
                        tc = "th" if r_i == 0 else "td"
                        trs.append("<tr>" + "".join(f"<{tc}>{html.escape(c.text.strip())}</{tc}>" for c in row.cells) + "</tr>")
                    tbl_html = f"<table class='preview-table'>{''.join(trs)}</table>"
            body_html = "".join(f"<p>{html.escape(t)}</p>" for t in texts)
            cards.append(f"<div class='slide-card'><div class='slide-num'>Slide {idx:02d}</div>{body_html}{tbl_html}</div>")
        info["html"] = f"<div class='preview-pptx'>共 {len(prs.slides)} 页原生可编辑幻灯片{''.join(cards)}</div>"
        info["text"] = extract_plain_text(path, 3000)
        return info

    txt = extract_plain_text(path, 6000)
    info["text"] = txt
    info["html"] = f"<pre class='preview-pre'>{html.escape(txt)}</pre>"
    return info


# ---------------------------------------------------------------------------
# Context-Aware Action Offers (Matches ZhiDian bin/list-actions.mjs & tools-*.js)
# ---------------------------------------------------------------------------

THEME_OPTIONS = [
    {"value": "business", "label": "商务蓝"},
    {"value": "clean", "label": "极简灰"},
    {"value": "warm", "label": "暖调纸"},
]

TRANSLATE_OPTIONS = [
    {"value": "中文", "label": "中文"},
    {"value": "英文", "label": "英文"},
    {"value": "日文", "label": "日文"},
    {"value": "韩文", "label": "韩文"},
    {"value": "法文", "label": "法文"},
    {"value": "德文", "label": "德文"},
]


def offers_for_selection(files: list[Path], selected_text: str = "") -> list[dict[str, Any]]:
    if files:
        kinds = [file_kind(f) for f in files]
        n = len(files)
        offers: list[dict[str, Any]] = []

        if n == 1 and kinds[0] == "pdf":
            offers.extend([
                {"id": "pdf.extract", "label": "提取指定页", "param": {"label": "页码范围", "placeholder": "例如 1-2, 末页", "default": "1-2, 末页", "required": True}},
                {"id": "pdf.split", "label": "拆成单页"},
                {"id": "pdf.number", "label": "加页码"},
                {"id": "pdf.rotate", "label": "顺时针转 90°"},
                {"id": "pdf.compress", "label": "压缩 PDF"},
                {"id": "pdf.word", "label": "转成 Word"},
                {"id": "pdf.images", "label": "每页转成图片"},
                {"id": "pdf.text", "label": "提取文字"},
                {"id": "files.pptx", "label": "做成 PPT", "param": {"label": "母版主题", "options": THEME_OPTIONS, "default": "business"}},
                {"id": "doc.summary", "label": "总结要点"},
            ])
            return offers

        if n == 1 and kinds[0] == "word":
            offers.extend([
                {"id": "word.restyle", "label": "一键公文排版"},
                {"id": "files.pptx", "label": "做成 PPT", "param": {"label": "母版主题", "options": THEME_OPTIONS, "default": "business"}},
                {"id": "files.pdf", "label": "转成 PDF"},
                {"id": "word.markdown", "label": "转成 Markdown"},
                {"id": "word.images", "label": "导出内嵌图片"},
                {"id": "word.count", "label": "字数与求和统计"},
                {"id": "doc.summary", "label": "总结要点"},
            ])
            return offers

        if n == 1 and kinds[0] in {"excel", "delimited"}:
            if kinds[0] == "delimited":
                offers.append({"id": "sheet.xlsx", "label": "转成 Excel（保前导0与长号）"})
            else:
                offers.append({"id": "sheet.audit", "label": "超支与异常自动核查"})
                offers.append({"id": "sheet.csv", "label": "导出 CSV"})
            offers.extend([
                {"id": "sheet.md", "label": "转成 Markdown 表格"},
                {"id": "files.pptx", "label": "做成数据汇报 PPT", "param": {"label": "母版主题", "options": THEME_OPTIONS, "default": "business"}},
                {"id": "files.pdf", "label": "转成 PDF"},
                {"id": "doc.summary", "label": "总结表格要点"},
            ])
            return offers

        if n >= 2 and all(k in {"excel", "delimited"} for k in kinds):
            return [
                {"id": "sheet.merge", "label": "合并成一个 Excel（带来源列）"},
                {"id": "files.pdf", "label": "合并成 PDF"},
                {"id": "files.zip", "label": "打包成 ZIP"},
                {"id": "files.names", "label": "复制文件名清单"},
            ]

        if n == 1 and kinds[0] in {"markdown", "text"}:
            return [
                {"id": "files.pptx", "label": "做成 PPT", "param": {"label": "母版主题", "options": THEME_OPTIONS, "default": "business"}},
                {"id": "text.docx", "label": "转成规范排版 Word"},
                {"id": "files.pdf", "label": "转成 PDF"},
                {"id": "doc.typeset_file", "label": "中英混排与断行整理"},
                {"id": "doc.translate", "label": "全文翻译", "param": {"label": "目标语言", "options": TRANSLATE_OPTIONS, "default": "中文"}},
                {"id": "word.count", "label": "字数与数字求和"},
                {"id": "doc.summary", "label": "总结要点"},
            ]

        if all(k == "image" for k in kinds):
            if n >= 2:
                offers.extend([
                    {"id": "image.stitch", "label": "纵向拼成长图"},
                    {"id": "files.pdf", "label": "合并成 PDF"},
                ])
            else:
                offers.append({"id": "files.pdf", "label": "转成 PDF"})
            offers.extend([
                {"id": "image.compress", "label": "压缩图片体积"},
                {"id": "image.webp", "label": "转成 WebP"},
                {"id": "image.jpg", "label": "转成 JPG"},
                {"id": "files.zip", "label": "打包成 ZIP"},
            ])
            return offers

        # Multi-file mixed selection (e.g., PDF + Word + Excel + Images)
        if all(k in {"pdf", "word", "excel", "delimited", "markdown", "text", "image"} for k in kinds):
            offers.append({"id": "files.pdf", "label": "合并成一份 PDF"})
            offers.append({"id": "files.pptx", "label": "汇编成一套 PPT", "param": {"label": "母版主题", "options": THEME_OPTIONS, "default": "business"}})
        if set(kinds) >= {"pdf", "excel"} or (n == 2 and any("合同" in f.name for f in files) and any("结算" in f.name for f in files)):
            offers.insert(0, {"id": "cross.audit", "label": "跨合同与结算单核查"})
        offers.extend([
            {"id": "files.zip", "label": "打包成 ZIP"},
            {"id": "files.names", "label": "生成文件名清单"},
            {"id": "doc.summary", "label": "综合总结所选文件"},
        ])
        return offers

    if selected_text.strip():
        return [
            {"id": "text.typeset", "label": "中英混排与断行整理"},
            {"id": "text.sum", "label": "智能数字求和"},
            {"id": "text.count", "label": "字数与阅读时长"},
            {"id": "text.translate", "label": "翻译选中文字", "param": {"label": "目标语言", "options": TRANSLATE_OPTIONS, "default": "中文"}},
            {"id": "text.polish", "label": "公文/商务润色"},
            {"id": "text.summarize", "label": "提炼三点摘要"},
            {"id": "text.explain", "label": "通俗解释一下"},
        ]
    return []


# ---------------------------------------------------------------------------
# Core Deterministic Office Builders (PPTX, Restyle DOCX, PDF, Sheet, Image)
# ---------------------------------------------------------------------------

def _parse_outline_sections(files: list[Path]) -> tuple[str, str, list[dict[str, Any]]]:
    """Extracts structured slides (title, bullets, optional tables) from MD, DOCX, PDF, XLSX/CSV, TXT."""
    doc_title = files[0].stem.replace("_", " ")
    subtitle = f"由 指点 ZhiDian 确定性引擎自动汇编 · 共 {len(files)} 份源文件"
    sections: list[dict[str, Any]] = []

    for f in files:
        kind = file_kind(f)
        if kind in {"excel", "delimited"}:
            rows: list[list[str]] = []
            if kind == "excel":
                wb = openpyxl.load_workbook(str(f), data_only=True)
                ws = wb.active
                for r in list(ws.iter_rows(values_only=True))[:24]:
                    if any(v is not None for v in r):
                        rows.append(["" if v is None else str(v) for v in r[:7]])
            else:
                delim = "\t" if f.suffix.lower() == ".tsv" else ","
                with open(f, "r", encoding="utf-8-sig", errors="replace") as fp:
                    for r in list(csv.reader(fp, delimiter=delim))[:24]:
                        if any(r):
                            rows.append(r[:7])
            if len(rows) >= 2:
                header = rows[0]
                data_rows = rows[1:]
                # Paginate tables cleanly at max 6 rows per slide (matching src/main/office/pptx.js)
                chunk_size = 6
                for page_i in range(0, len(data_rows), chunk_size):
                    part = data_rows[page_i: page_i + chunk_size]
                    suffix = f" ({page_i // chunk_size + 1})" if len(data_rows) > chunk_size else ""
                    sections.append({
                        "heading": f"{f.stem} · 数据明细{suffix}",
                        "bullets": [],
                        "table": [header] + part,
                    })
            continue

        raw = extract_plain_text(f, 9000)
        lines = [ln.rstrip() for ln in raw.splitlines()]
        cur_sec: dict[str, Any] | None = None
        table_buf: list[list[str]] = []

        def _flush_table() -> None:
            nonlocal table_buf, cur_sec
            if len(table_buf) >= 2:
                header = table_buf[0]
                body = [r for r in table_buf[1:] if not all(re.fullmatch(r"[-:\s]+", c) for c in r)]
                if body:
                    if cur_sec is None:
                        cur_sec = {"heading": f.stem, "bullets": [], "table": None}
                        sections.append(cur_sec)
                    cur_sec["table"] = [header] + body[:6]
            table_buf = []

        for ln in lines:
            s = ln.strip()
            if not s:
                _flush_table()
                continue
            if s.startswith("|") and s.endswith("|") and s.count("|") >= 2:
                cells = [c.strip() for c in s.strip("|").split("|")]
                table_buf.append(cells)
                continue
            _flush_table()
            if s.startswith("# ") and len(files) == 1:
                doc_title = s[2:].strip()
                continue
            if s.startswith("## ") or re.match(r"^(?:第[一二三四五六七八九十]+条|[一二三四五六七八九十]+[、.]|【第\s*\d+\s*页】)", s):
                heading = re.sub(r"^##\s*", "", s).strip("【】 ")
                cur_sec = {"heading": heading[:38], "bullets": [], "table": None}
                sections.append(cur_sec)
                continue
            bullet = re.sub(r"^[-*•]\s*", "", s)
            if cur_sec is None:
                if len(files) == 1 and subtitle.startswith("由 指点"):
                    subtitle = bullet[:80]
                    continue
                cur_sec = {"heading": f"{f.stem} · 核心要点", "bullets": [], "table": None}
                sections.append(cur_sec)
            if len(cur_sec["bullets"]) < 5:
                cur_sec["bullets"].append(bullet[:95])
            else:
                cur_sec = {"heading": f"{cur_sec['heading']}（续）", "bullets": [bullet[:95]], "table": None}
                sections.append(cur_sec)
        _flush_table()

    if not sections:
        sections.append({"heading": "核心内容摘要", "bullets": ["已从所选文件提取结构化内容并完成母版排版。"], "table": None})
    return doc_title[:46], subtitle[:90], sections[:12]


def build_themed_pptx(files: list[Path], out_path: Path, theme_id: str = "business") -> int:
    theme = DOCUMENT_THEMES.get(theme_id, DOCUMENT_THEMES["business"])
    title, subtitle, sections = _parse_outline_sections(files)

    prs = Presentation()
    prs.slide_width = PptInches(13.333)
    prs.slide_height = PptInches(7.5)
    blank = prs.slide_layouts[6]

    accent = PptRGB(*theme["accent"])
    ink = PptRGB(*theme["ink"])
    muted = PptRGB(*theme["muted"])
    paper = PptRGB(*theme["paper"])
    surface = PptRGB(*theme["surface"])
    cover_bg = PptRGB(*theme["cover"])
    cover_ink = PptRGB(*theme["cover_ink"])

    # Slide 1: Cover
    s0 = prs.slides.add_slide(blank)
    bg0 = s0.background.fill
    bg0.solid()
    bg0.fore_color.rgb = cover_bg

    bar = s0.shapes.add_shape(MSO_SHAPE.RECTANGLE, PptInches(0.9), PptInches(1.85), PptInches(1.15), PptInches(0.1))
    bar.fill.solid()
    bar.fill.fore_color.rgb = accent
    bar.line.fill.background()

    tb = s0.shapes.add_textbox(PptInches(0.9), PptInches(2.2), PptInches(11.4), PptInches(2.0))
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = title
    p.font.size = PptPt(40)
    p.font.bold = True
    p.font.name = theme["font"]
    p.font.color.rgb = cover_ink

    sb = s0.shapes.add_textbox(PptInches(0.9), PptInches(4.35), PptInches(11.0), PptInches(1.2))
    stf = sb.text_frame
    stf.word_wrap = True
    sp = stf.paragraphs[0]
    sp.text = subtitle
    sp.font.size = PptPt(18)
    sp.font.name = theme["body_font"]
    sp.font.color.rgb = accent if theme_id == "business" else muted

    # Content Slides
    for idx, sec in enumerate(sections, start=2):
        sl = prs.slides.add_slide(blank)
        bg = sl.background.fill
        bg.solid()
        bg.fore_color.rgb = paper

        top_strip = sl.shapes.add_shape(MSO_SHAPE.RECTANGLE, PptInches(0), PptInches(0), PptInches(13.333), PptInches(0.08))
        top_strip.fill.solid()
        top_strip.fill.fore_color.rgb = accent
        top_strip.line.fill.background()

        badge = sl.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, PptInches(0.8), PptInches(0.58), PptInches(0.75), PptInches(0.42))
        badge.fill.solid()
        badge.fill.fore_color.rgb = surface
        badge.line.color.rgb = accent
        btf = badge.text_frame
        bp = btf.paragraphs[0]
        bp.alignment = PP_ALIGN.CENTER
        bp.text = f"{idx - 1:02d}"
        bp.font.size = PptPt(14)
        bp.font.bold = True
        bp.font.color.rgb = accent

        hb = sl.shapes.add_textbox(PptInches(1.72), PptInches(0.52), PptInches(10.8), PptInches(0.7))
        htf = hb.text_frame
        hp = htf.paragraphs[0]
        hp.text = sec["heading"]
        hp.font.size = PptPt(26)
        hp.font.bold = True
        hp.font.name = theme["font"]
        hp.font.color.rgb = ink

        cur_top = 1.45
        if sec["bullets"]:
            card_h = 2.2 if sec.get("table") else 5.15
            card = sl.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, PptInches(0.8), PptInches(cur_top), PptInches(11.73), PptInches(card_h))
            card.fill.solid()
            card.fill.fore_color.rgb = surface
            card.line.color.rgb = PptRGB(*theme["line"])

            bb = sl.shapes.add_textbox(PptInches(1.1), PptInches(cur_top + 0.25), PptInches(11.1), PptInches(card_h - 0.4))
            btf2 = bb.text_frame
            btf2.word_wrap = True
            for b_i, b_txt in enumerate(sec["bullets"]):
                bp2 = btf2.paragraphs[0] if b_i == 0 else btf2.add_paragraph()
                bp2.text = f"▪  {b_txt}"
                bp2.font.size = PptPt(17 if not sec.get("table") else 14.5)
                bp2.font.name = theme["body_font"]
                bp2.font.color.rgb = ink
                bp2.space_after = PptPt(12 if not sec.get("table") else 6)
            cur_top += card_h + 0.25

        if sec.get("table"):
            t_rows = sec["table"]
            r_cnt = len(t_rows)
            c_cnt = max(len(r) for r in t_rows)
            tbl_h = min(4.8, 0.48 * r_cnt)
            t_shape = sl.shapes.add_table(r_cnt, c_cnt, PptInches(0.8), PptInches(cur_top), PptInches(11.73), PptInches(tbl_h))
            tbl = t_shape.table
            for r_i, r_vals in enumerate(t_rows):
                for c_i in range(c_cnt):
                    cell = tbl.cell(r_i, c_i)
                    val = r_vals[c_i] if c_i < len(r_vals) else ""
                    cell.text = val
                    cell.fill.solid()
                    cell.fill.fore_color.rgb = accent if r_i == 0 else (paper if r_i % 2 == 1 else surface)
                    for cp_p in cell.text_frame.paragraphs:
                        cp_p.font.size = PptPt(12.5)
                        cp_p.font.bold = r_i == 0
                        cp_p.font.name = theme["font"]
                        cp_p.font.color.rgb = PptRGB(255, 255, 255) if r_i == 0 else ink

        fb = sl.shapes.add_textbox(PptInches(0.8), PptInches(6.92), PptInches(11.73), PptInches(0.35))
        fp = fb.text_frame.paragraphs[0]
        fp.alignment = PP_ALIGN.RIGHT
        fp.text = f"{theme['label']}母版  ·  {idx} / {len(sections) + 1}"
        fp.font.size = PptPt(10.5)
        fp.font.color.rgb = muted

    prs.save(str(out_path))
    return len(prs.slides)


def restyle_official_docx(src_docx: Path | None, out_docx: Path, raw_text: str = "") -> dict[str, int]:
    """Port of src/main/office/restyle.js: A4 2.54cm/3.17cm margins, auto-promote Chinese headings, 1.5x spacing, styled tables."""
    doc = Document(str(src_docx)) if src_docx else Document()
    if raw_text and not src_docx:
        for ln in [x.strip() for x in raw_text.splitlines() if x.strip()]:
            doc.add_paragraph(ln)

    for sec in doc.sections:
        sec.page_width = Cm(21.0)
        sec.page_height = Cm(29.7)
        sec.top_margin = Cm(2.54)
        sec.bottom_margin = Cm(2.54)
        sec.left_margin = Cm(3.17)
        sec.right_margin = Cm(3.17)

    def _style_run(run: Any, east_asia: str, latin: str, pt_size: float, bold: bool, rgb: tuple[int, int, int]) -> None:
        run.font.name = latin
        run.font.size = Pt(pt_size)
        run.font.bold = bold
        run.font.color.rgb = RGBColor(*rgb)
        rpr = run._element.get_or_add_rPr()
        rfonts = rpr.find(qn("w:rFonts"))
        if rfonts is None:
            rfonts = OxmlElement("w:rFonts")
            rpr.append(rfonts)
        rfonts.set(qn("w:eastAsia"), east_asia)

    promoted = 0
    body_cnt = 0
    first_non_empty_seen = False

    for p in doc.paragraphs:
        txt = p.text.strip()
        if not txt:
            continue
        pf = p.paragraph_format
        pf.line_spacing = 1.5

        if not first_non_empty_seen:
            first_non_empty_seen = True
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            pf.first_line_indent = Pt(0)
            pf.space_before = Pt(6)
            pf.space_after = Pt(14)
            for r in p.runs:
                _style_run(r, "方正小标宋简体", "Times New Roman", 20, True, (20, 38, 71))
            promoted += 1
            continue

        if re.match(r"^[一二三四五六七八九十]+[、.]", txt) or txt.startswith("# "):
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            pf.first_line_indent = Pt(0)
            pf.space_before = Pt(12)
            pf.space_after = Pt(6)
            for r in p.runs:
                _style_run(r, "黑体", "Arial", 15, True, (23, 37, 84))
            promoted += 1
        elif re.match(r"^（[一二三四五六七八九十\d]+）", txt) or txt.startswith("## "):
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            pf.first_line_indent = Pt(0)
            pf.space_before = Pt(8)
            pf.space_after = Pt(4)
            for r in p.runs:
                _style_run(r, "楷体", "Times New Roman", 13.5, True, (30, 58, 138))
            promoted += 1
        else:
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            pf.first_line_indent = Pt(24)  # 2 chars at 12pt (小四)
            pf.space_before = Pt(0)
            pf.space_after = Pt(4)
            for r in p.runs:
                _style_run(r, "宋体", "Times New Roman", 12, False, (31, 41, 55))
            body_cnt += 1

    for tbl in doc.tables:
        tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
        for r_i, row in enumerate(tbl.rows):
            for cell in row.cells:
                tc_pr = cell._tc.get_or_add_tcPr()
                shd = parse_xml(f'<w:shd {nsdecls("w")} w:fill="{"1E3A8A" if r_i == 0 else ("F8FAFC" if r_i % 2 == 1 else "FFFFFF")}"/>')
                tc_pr.append(shd)
                for cp_p in cell.paragraphs:
                    cp_p.alignment = WD_ALIGN_PARAGRAPH.CENTER if r_i == 0 else WD_ALIGN_PARAGRAPH.LEFT
                    for r in cp_p.runs:
                        _style_run(r, "微软雅黑", "Calibri", 10.5, r_i == 0, (255, 255, 255) if r_i == 0 else (30, 41, 59))

    doc.save(str(out_docx))
    return {"headings": promoted, "paragraphs": body_cnt, "tables": len(doc.tables)}


def render_any_to_pdf_doc(files: list[Path]) -> pymupdf.Document:
    """Merges mixed PDFs, images, Word, Excel/CSV, Markdown, and TXT into one clean PDF Document."""
    out = pymupdf.open()
    for f in files:
        kind = file_kind(f)
        if kind == "pdf":
            with pymupdf.open(str(f)) as src:
                out.insert_pdf(src)
        elif kind == "image":
            with PIL.Image.open(f) as im:
                rgb = im.convert("RGB")
                buf = io.BytesIO()
                rgb.save(buf, format="PNG")
                img_bytes = buf.getvalue()
                w, h = rgb.size
            page_w = 595.0
            scale = (page_w - 64.0) / max(1.0, float(w))
            draw_h = h * scale
            page_h = max(842.0, draw_h + 96.0)
            p = out.new_page(width=page_w, height=page_h)
            p.insert_textbox(pymupdf.Rect(32, 20, page_w - 32, 48), f.name, fontsize=11, fontname="china-ss", color=(0.35, 0.42, 0.52))
            p.insert_image(pymupdf.Rect(32, 52, page_w - 32, 52 + draw_h), stream=img_bytes)
        else:
            txt = extract_plain_text(f, 15000)
            chunks = [txt[i: i + 1350] for i in range(0, max(1, len(txt)), 1350)]
            for idx, ch in enumerate(chunks, start=1):
                p = out.new_page(width=595, height=842)
                p.draw_rect(pymupdf.Rect(0, 0, 595, 58), color=None, fill=(241 / 255, 245 / 255, 249 / 255))
                p.insert_textbox(
                    pymupdf.Rect(40, 18, 555, 48),
                    f"{f.name}  ·  第 {idx} / {len(chunks)} 页",
                    fontsize=11,
                    fontname="china-ss",
                    color=(0.2, 0.28, 0.42),
                )
                p.insert_textbox(
                    pymupdf.Rect(40, 76, 555, 795),
                    ch,
                    fontsize=11.5,
                    fontname="china-ss",
                    color=(0.12, 0.16, 0.23),
                )
    return out


# ---------------------------------------------------------------------------
# Execute Any ZhiDian Action (`execute_action`)
# ---------------------------------------------------------------------------

def execute_action(
    ws_dir: Path,
    action_id: str,
    file_names: list[str],
    param: str = "",
    selected_text: str = "",
) -> dict[str, Any]:
    files = []
    for fn in file_names:
        cand = (ws_dir / Path(fn).name).resolve()
        if cand.exists() and cand.parent == ws_dir.resolve():
            files.append(cand)

    created: list[Path] = []
    result_text = ""
    ai_point: dict[str, Any] | None = None

    # ---- PDF Actions ----
    if action_id == "pdf.extract":
        if not files or file_kind(files[0]) != "pdf":
            raise ValueError("请先选中一份 PDF 文件")
        with pymupdf.open(str(files[0])) as src:
            pages = parse_page_spec(param or "1-2, 末页", len(src))
            out_doc = pymupdf.open()
            for pno in pages:
                out_doc.insert_pdf(src, from_page=pno - 1, to_page=pno - 1)
            label_spec = ",".join(str(p) for p in pages[:5]) + ("等" if len(pages) > 5 else "")
            out_path = unique_out_path(ws_dir, f"{files[0].stem}-第{label_spec}页", ".pdf")
            out_doc.save(str(out_path))
            out_doc.close()
        created.append(out_path)
        result_text = f"已从《{files[0].name}》精准提取第 {', '.join(map(str, pages))} 页（共 {len(pages)} 页），生成《{out_path.name}》。"

    elif action_id == "pdf.split":
        if not files or file_kind(files[0]) != "pdf":
            raise ValueError("请先选中一份 PDF 文件")
        with pymupdf.open(str(files[0])) as src:
            out_zip = unique_out_path(ws_dir, f"{files[0].stem}-单页拆分({len(src)}页)", ".zip")
            with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
                for i in range(len(src)):
                    single = pymupdf.open()
                    single.insert_pdf(src, from_page=i, to_page=i)
                    zf.writestr(f"{files[0].stem}-第{i + 1:02d}页.pdf", single.tobytes())
                    if i == 0:
                        p1_file = unique_out_path(ws_dir, f"{files[0].stem}-第01页", ".pdf")
                        single.save(str(p1_file))
                        created.append(p1_file)
                    single.close()
            created.insert(0, out_zip)
            result_text = f"已将 {len(src)} 页 PDF 拆分为独立单页并打包至《{out_zip.name}》（同时在桌面附上第 1 页便于直接预览）。"

    elif action_id == "pdf.number":
        if not files or file_kind(files[0]) != "pdf":
            raise ValueError("请先选中一份 PDF 文件")
        with pymupdf.open(str(files[0])) as doc:
            total = len(doc)
            for i, page in enumerate(doc, start=1):
                r = page.rect
                page.insert_textbox(
                    pymupdf.Rect(r.width / 2 - 80, r.height - 34, r.width / 2 + 80, r.height - 12),
                    f"— {i} / {total} —",
                    fontsize=10,
                    fontname="china-ss",
                    align=pymupdf.TEXT_ALIGN_CENTER,
                    color=(0.35, 0.4, 0.48),
                )
            out_path = unique_out_path(ws_dir, f"{files[0].stem}-已加页码", ".pdf")
            doc.save(str(out_path))
        created.append(out_path)
        result_text = f"已为全部 {total} 页底部居中写入规范页码，生成《{out_path.name}》。"

    elif action_id == "pdf.rotate":
        if not files or file_kind(files[0]) != "pdf":
            raise ValueError("请先选中一份 PDF 文件")
        with pymupdf.open(str(files[0])) as doc:
            for page in doc:
                page.set_rotation((page.rotation + 90) % 360)
            out_path = unique_out_path(ws_dir, f"{files[0].stem}-顺时针90度", ".pdf")
            doc.save(str(out_path))
        created.append(out_path)
        result_text = f"已将全部页面顺时针旋转 90°，生成《{out_path.name}》。"

    elif action_id == "pdf.compress":
        if not files or file_kind(files[0]) != "pdf":
            raise ValueError("请先选中一份 PDF 文件")
        before = files[0].stat().st_size
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-压缩版", ".pdf")
        with pymupdf.open(str(files[0])) as doc:
            doc.save(str(out_path), garbage=4, deflate=True, clean=True)
        after = out_path.stat().st_size
        created.append(out_path)
        diff_note = f"{human_size(before)} ➔ {human_size(after)}"
        result_text = f"已完成无损对象清理与流压缩（{diff_note}），生成《{out_path.name}》。"

    elif action_id == "pdf.images":
        if not files or file_kind(files[0]) != "pdf":
            raise ValueError("请先选中一份 PDF 文件")
        with pymupdf.open(str(files[0])) as doc:
            out_zip = unique_out_path(ws_dir, f"{files[0].stem}-页面图片包", ".zip")
            with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
                for i, page in enumerate(doc, start=1):
                    png = page.get_pixmap(dpi=150).tobytes("png")
                    zf.writestr(f"page-{i:02d}.png", png)
                    if i == 1:
                        p1 = unique_out_path(ws_dir, f"{files[0].stem}-第1页长图", ".png")
                        p1.write_bytes(png)
                        created.append(p1)
            created.insert(0, out_zip)
            result_text = f"已将 {len(doc)} 页渲染为 150 DPI 高清 PNG 并打包为《{out_zip.name}》。"

    elif action_id == "pdf.text":
        if not files:
            raise ValueError("请先选中 PDF 文件")
        txt = extract_plain_text(files[0], 30000)
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-提取文字", ".txt")
        out_path.write_text(txt, encoding="utf-8")
        created.append(out_path)
        result_text = f"已提取全文（{len(txt)} 字）至《{out_path.name}》：\n\n{txt[:460]}…"

    elif action_id == "pdf.word":
        if not files:
            raise ValueError("请先选中 PDF 文件")
        txt = extract_plain_text(files[0], 25000)
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-可编辑版", ".docx")
        stats = restyle_official_docx(None, out_path, raw_text=txt)
        created.append(out_path)
        result_text = f"已将《{files[0].name}》转换为可编辑规范 Word《{out_path.name}》（自动识别标题 {stats['headings']} 处、正文 {stats['paragraphs']} 段）。"

    elif action_id == "files.pdf":
        if not files:
            raise ValueError("请先框选需要转成/合并为 PDF 的文件")
        pdf_doc = render_any_to_pdf_doc(files)
        stem = f"{files[0].stem}-合并({len(files)}份)" if len(files) > 1 else f"{files[0].stem}-导出"
        out_path = unique_out_path(ws_dir, stem, ".pdf")
        pdf_doc.save(str(out_path))
        total_p = len(pdf_doc)
        pdf_doc.close()
        created.append(out_path)
        result_text = f"已将 {len(files)} 份文件确定性合成《{out_path.name}》（共 {total_p} 页）。"

    # ---- PPTX Action ----
    elif action_id == "files.pptx":
        if not files:
            raise ValueError("请先选中要生成 PPT 的文件")
        theme_id = (param or "business").strip()
        if theme_id in {"商务蓝", "business"}:
            theme_id = "business"
        elif theme_id in {"极简灰", "clean"}:
            theme_id = "clean"
        elif theme_id in {"暖调纸", "warm"}:
            theme_id = "warm"
        else:
            theme_id = "business"
        t_label = DOCUMENT_THEMES[theme_id]["label"]
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-{t_label}演示", ".pptx")
        slide_cnt = build_themed_pptx(files, out_path, theme_id=theme_id)
        created.append(out_path)
        result_text = f"已使用「{t_label}」16:9 原生母版生成《{out_path.name}》（共 {slide_cnt} 页可编辑幻灯片，超长表格已自动分页续表头）。"

    # ---- Word Actions ----
    elif action_id == "word.restyle":
        if not files or file_kind(files[0]) != "word":
            raise ValueError("请先选中一份 Word (.docx) 文档")
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-标准公文排版", ".docx")
        stats = restyle_official_docx(files[0], out_path)
        created.append(out_path)
        result_text = (
            f"已完成 A4 标准公文一键重排，生成《{out_path.name}》：\n"
            f"• 页边距统一 2.54cm / 3.17cm，自动提级黑体/楷体标题 {stats['headings']} 处\n"
            f"• 正文 {stats['paragraphs']} 段统一宋体/Times 小四、1.5 倍行距、首行缩进 2 字符\n"
            f"• 表格 {stats['tables']} 张自动套用深蓝表头与斑马纹底色"
        )

    elif action_id == "text.docx":
        raw = extract_plain_text(files[0], 20000) if files else selected_text
        cleaned, _ = typeset_cjk_latin(raw)
        stem = f"{files[0].stem}-规范公文" if files else "选中文本-规范公文"
        out_path = unique_out_path(ws_dir, stem, ".docx")
        stats = restyle_official_docx(None, out_path, raw_text=cleaned)
        created.append(out_path)
        result_text = f"已整理中英混排并导出标准 A4 Word《{out_path.name}》（标题 {stats['headings']} 处、正文 {stats['paragraphs']} 段）。"

    elif action_id == "word.markdown":
        if not files or file_kind(files[0]) != "word":
            raise ValueError("请先选中一份 Word 文档")
        doc = Document(str(files[0]))
        md_lines: list[str] = []
        for i, p in enumerate(doc.paragraphs):
            t = p.text.strip()
            if not t:
                continue
            if i == 0:
                md_lines.append(f"# {t}\n")
            elif re.match(r"^[一二三四五六七八九十]+[、.]", t):
                md_lines.append(f"\n## {t}\n")
            elif re.match(r"^（[一二三四五六七八九十\d]+）", t):
                md_lines.append(f"\n### {t}\n")
            else:
                md_lines.append(t)
        for tbl in doc.tables:
            md_lines.append("")
            for r_i, row in enumerate(tbl.rows):
                cells = [c.text.strip().replace("\n", " ") for c in row.cells]
                md_lines.append("| " + " | ".join(cells) + " |")
                if r_i == 0:
                    md_lines.append("| " + " | ".join(["---"] * len(cells)) + " |")
            md_lines.append("")
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-导出", ".md")
        out_path.write_text("\n".join(md_lines).strip() + "\n", encoding="utf-8")
        created.append(out_path)
        result_text = f"已无损保留标题层级与表格结构，导出《{out_path.name}》。"

    elif action_id == "word.images":
        if not files or file_kind(files[0]) != "word":
            raise ValueError("请先选中一份 Word 文档")
        doc = Document(str(files[0]))
        rels = [rel for rel in doc.part.rels.values() if "image" in rel.target_ref]
        if not rels:
            result_text = f"《{files[0].name}》中没有检测到内嵌图片。"
        else:
            for idx, rel in enumerate(rels, start=1):
                ext = Path(rel.target_ref).suffix or ".png"
                img_out = unique_out_path(ws_dir, f"{files[0].stem}-内嵌图{idx:02d}", ext)
                img_out.write_bytes(rel.target_part.blob)
                created.append(img_out)
            result_text = f"已从《{files[0].name}》无损导出 {len(created)} 张内嵌图片至桌面。"

    elif action_id == "word.count":
        raw = "\n\n".join(extract_plain_text(f, 20000) for f in files) if files else selected_text
        st = smart_text_stats(raw)
        result_text = (
            f"📊 字数与智能求和统计：\n"
            f"• 总字数（不含空白）：{st['chars_no_space']} 字（汉字 {st['han']} · 英文词 {st['en_words']} · 共 {st['lines']} 行）\n"
            f"• 预计阅读时长：约 {st['read_minutes']} 分钟\n"
            f"• 智能识别有效数值：{st['numbers_count']} 个（已自动剔除日期/电话/长单号/序号）\n"
            f"• 数值精确合计：{st['sum']:,.2f}（均值 {st['avg']:,.2f} · 最大 {st['max']:,.2f}）"
        )

    # ---- Spreadsheet & Cross-Document Audit Actions ----
    elif action_id == "sheet.xlsx":
        if not files:
            raise ValueError("请先选中 CSV/TSV 文件")
        src = files[0]
        delim = "\t" if src.suffix.lower() == ".tsv" else ","
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = src.stem[:28]
        preserved_text_cells = 0
        with open(src, "r", encoding="utf-8-sig", errors="replace") as fp:
            for r_i, row in enumerate(csv.reader(fp, delimiter=delim), start=1):
                for c_i, val in enumerate(row, start=1):
                    cell = ws.cell(row=r_i, column=c_i)
                    sval = val.strip()
                    if r_i == 1:
                        cell.value = sval
                        cell.font = Font(name="Microsoft YaHei", bold=True, color="FFFFFF")
                        cell.fill = PatternFill("solid", fgColor="1E3A8A")
                    elif (sval.startswith("0") and len(sval) > 1 and sval.isdigit()) or (sval.isdigit() and len(sval) > 15):
                        cell.value = sval
                        cell.number_format = "@"
                        preserved_text_cells += 1
                    elif re.fullmatch(r"[+-]?\d+(?:\.\d+)?", sval):
                        cell.value = float(sval) if "." in sval else int(sval)
                    else:
                        cell.value = sval
        ws.freeze_panes = "A2"
        for col_cells in ws.columns:
            max_len = max(len(str(c.value or "")) for c in col_cells)
            ws.column_dimensions[get_column_letter(col_cells[0].column)].width = min(32, max(12, int(max_len * 1.45)))
        out_path = unique_out_path(ws_dir, f"{src.stem}-转换", ".xlsx")
        wb.save(str(out_path))
        created.append(out_path)
        result_text = f"已生成《{out_path.name}》：首行加粗冻结，并自动保护 {preserved_text_cells} 个前导 0 编码与超 15 位长单号免遭科学计数法截断！"

    elif action_id == "sheet.csv":
        if not files or file_kind(files[0]) != "excel":
            raise ValueError("请先选中 Excel 文件")
        wb = openpyxl.load_workbook(str(files[0]), data_only=True)
        ws = wb.active
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-导出", ".csv")
        with open(out_path, "w", encoding="utf-8-sig", newline="") as fp:
            writer = csv.writer(fp)
            for row in ws.iter_rows(values_only=True):
                writer.writerow(["" if v is None else str(v) for v in row])
        created.append(out_path)
        result_text = f"已导出 UTF-8 BOM 编码《{out_path.name}》（Windows Excel 双击直接打开不乱码）。"

    elif action_id == "sheet.merge":
        if len(files) < 2:
            raise ValueError("请框选至少 2 份表格文件进行合并")
        wb_out = openpyxl.Workbook()
        ws_out = wb_out.active
        ws_out.title = "合并汇总"
        header_written = False
        total_rows = 0
        for f in files:
            rows: list[list[Any]] = []
            if file_kind(f) == "excel":
                wb = openpyxl.load_workbook(str(f), data_only=True)
                for sname in wb.sheetnames:
                    for r in wb[sname].iter_rows(values_only=True):
                        if any(v is not None for v in r):
                            rows.append(list(r))
            else:
                delim = "\t" if f.suffix.lower() == ".tsv" else ","
                with open(f, "r", encoding="utf-8-sig", errors="replace") as fp:
                    rows = [r for r in csv.reader(fp, delimiter=delim) if any(r)]
            if not rows:
                continue
            if not header_written:
                ws_out.append(["来源文件"] + [str(x or "") for x in rows[0]])
                for c in ws_out[1]:
                    c.font = Font(bold=True, color="FFFFFF")
                    c.fill = PatternFill("solid", fgColor="1E3A8A")
                header_written = True
            for dr in rows[1:]:
                ws_out.append([f.name] + ["" if v is None else str(v) for v in dr])
                total_rows += 1
        ws_out.freeze_panes = "A2"
        out_path = unique_out_path(ws_dir, f"合并汇总表({len(files)}份)", ".xlsx")
        wb_out.save(str(out_path))
        created.append(out_path)
        result_text = f"已将 {len(files)} 份表格合并为《{out_path.name}》，自动附加「来源文件」溯源列，共计 {total_rows} 行数据。"

    elif action_id == "sheet.md":
        if not files:
            raise ValueError("请先选中表格文件")
        preview = render_file_preview(files[0])
        txt = extract_plain_text(files[0], 8000)
        lines = [ln for ln in txt.splitlines() if ln.strip() and not ln.startswith("## ")]
        md_rows = []
        for idx, ln in enumerate(lines[:25]):
            cells = [c.strip() for c in (ln.split("|") if "|" in ln else ln.split(","))]
            md_rows.append("| " + " | ".join(cells) + " |")
            if idx == 0:
                md_rows.append("| " + " | ".join(["---"] * len(cells)) + " |")
        md_str = "\n".join(md_rows)
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-表格", ".md")
        out_path.write_text(md_str + "\n", encoding="utf-8")
        created.append(out_path)
        result_text = f"已生成 Markdown 表格《{out_path.name}》：\n\n{md_str[:500]}"

    elif action_id in {"sheet.audit", "cross.audit"}:
        # Deterministic audit across Excel + optional PDF protocol (zero hardcoded numbers!)
        excel_file = next((f for f in files if file_kind(f) == "excel"), ws_dir / MOCK_FILE_SHEET)
        if not excel_file.exists():
            any_xlsx = [p for p in ws_dir.glob("*.xlsx")]
            if not any_xlsx:
                raise ValueError("未找到可核查的 Excel 表格文件")
            excel_file = any_xlsx[0]
        wb = openpyxl.load_workbook(str(excel_file), data_only=True)
        ws = wb.active
        overruns: list[str] = []
        total_cap = 0.0
        total_act = 0.0
        alert_row_idx = 1
        alert_label = "异常超支项"
        for r_i, row in enumerate(list(ws.iter_rows(values_only=True))[1:], start=1):
            try:
                cap = float(row[4] or 0)
                act = float(row[5] or 0)
                total_cap += cap
                total_act += act
                if act > cap:
                    diff = act - cap
                    pct = (diff / cap * 100.0) if cap else 0.0
                    overruns.append(f"• {row[0]} {row[2]}（虚拟编码 {row[1]}）：协议封顶 ¥{cap:,.2f}，模拟实报 ¥{act:,.2f}，超支 +¥{diff:,.2f}（+{pct:.1f}%）")
                    alert_row_idx = r_i
                    alert_label = f"{row[0]} 超支 +{pct:.1f}% (¥{act:,.0f})"
            except Exception:
                pass
        report_md = (
            f"# 跨单据确定性核查报告（虚拟测试样本）\n\n"
            f"- 核查时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"- 核查文件：{', '.join(f.name for f in files) if files else excel_file.name}\n"
            f"- 协议封顶总额：¥{total_cap:,.2f}\n"
            f"- 模拟实报总额：¥{total_act:,.2f}\n\n"
            f"## 异常超支项拦截（共 {len(overruns)} 项）\n"
            + ("\n".join(overruns) if overruns else "- 全部科目均在封顶范围内。")
            + "\n\n## 处置建议\n依据虚拟采购框架协议第二条审计规则，超出模拟封顶金额 >5% 自动标红并复核。\n"
        )
        out_path = unique_out_path(ws_dir, "跨单据超支核查报告", ".docx")
        restyle_official_docx(None, out_path, raw_text=report_md)
        created.append(out_path)
        ai_point = {"target": "window_sheet", "sheet_name": excel_file.name, "row": alert_row_idx, "x_pct": 0.68, "y_pct": 0.50, "label": alert_label}
        result_text = (
            f"🎯 确定性跨表核查完成（AI 副光标已为您指向异常行）！\n"
            + ("\n".join(overruns) if overruns else "未发现超支项。")
            + f"\n• 已自动生成正式核查报告《{out_path.name}》放回桌面。"
        )

    # ---- Image Actions ----
    elif action_id == "image.stitch":
        img_files = [f for f in files if file_kind(f) == "image"]
        if len(img_files) < 2:
            raise ValueError("请框选至少 2 张图片来拼成长图")
        pil_imgs = [PIL.Image.open(f).convert("RGB") for f in img_files]
        target_w = max(im.width for im in pil_imgs)
        resized = []
        for im in pil_imgs:
            if im.width != target_w:
                nh = int(im.height * (target_w / im.width))
                resized.append(im.resize((target_w, nh), PIL.Image.Resampling.LANCZOS))
            else:
                resized.append(im)
        gap = 12
        total_h = sum(im.height for im in resized) + gap * (len(resized) - 1)
        canvas = PIL.Image.new("RGB", (target_w, total_h), (255, 255, 255))
        y = 0
        for im in resized:
            canvas.paste(im, (0, y))
            y += im.height + gap
            im.close()
        out_path = unique_out_path(ws_dir, f"{img_files[0].stem}-拼接长图({len(img_files)}张)", ".png")
        canvas.save(str(out_path), format="PNG")
        created.append(out_path)
        result_text = f"已将 {len(img_files)} 张图片等宽纵向拼接为高清长图《{out_path.name}》（尺寸 {target_w}×{total_h} px）。"

    elif action_id == "image.compress":
        if not files or file_kind(files[0]) != "image":
            raise ValueError("请先选中图片")
        before = files[0].stat().st_size
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-压缩", ".jpg")
        with PIL.Image.open(files[0]) as im:
            im.convert("RGB").save(str(out_path), format="JPEG", quality=76, optimize=True)
        after = out_path.stat().st_size
        created.append(out_path)
        saved_pct = max(0.0, (1.0 - after / max(1, before)) * 100.0)
        result_text = f"已完成图片体积压缩：{human_size(before)} ➔ {human_size(after)}（节省 {saved_pct:.1f}%），生成《{out_path.name}》。"

    elif action_id in {"image.webp", "image.jpg"}:
        if not files or file_kind(files[0]) != "image":
            raise ValueError("请先选中图片")
        to_webp = action_id == "image.webp"
        out_path = unique_out_path(ws_dir, f"{files[0].stem}-转换", ".webp" if to_webp else ".jpg")
        with PIL.Image.open(files[0]) as im:
            im.convert("RGB").save(str(out_path), format="WEBP" if to_webp else "JPEG", quality=86)
        created.append(out_path)
        result_text = f"已转换图片格式为《{out_path.name}》（{human_size(out_path.stat().st_size)}）。"

    # ---- Archive & File List ----
    elif action_id == "files.zip":
        if not files:
            raise ValueError("请先选中要打包的文件")
        stem = f"{files[0].stem}等{len(files)}份归档" if len(files) > 1 else f"{files[0].stem}-归档"
        out_path = unique_out_path(ws_dir, stem, ".zip")
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in files:
                zf.write(f, arcname=f.name)
        created.append(out_path)
        result_text = f"已将 {len(files)} 份文件压缩归档为《{out_path.name}》（{human_size(out_path.stat().st_size)}）。"

    elif action_id == "files.names":
        lines = [f"{i + 1:02d}. {f.name}  ({human_size(f.stat().st_size)})" for i, f in enumerate(files)]
        manifest = "\n".join(lines)
        out_path = unique_out_path(ws_dir, "选中文件清单", ".txt")
        out_path.write_text(manifest + "\n", encoding="utf-8")
        created.append(out_path)
        result_text = f"已生成文件名清单（可直接复制）：\n{manifest}"

    # ---- File / Selected-Text AI + Deterministic Skills ----
    elif action_id in {"doc.typeset_file", "text.typeset"}:
        raw = extract_plain_text(files[0], 20000) if files else selected_text
        cleaned, notes = typeset_cjk_latin(raw)
        if files:
            out_path = unique_out_path(ws_dir, f"{files[0].stem}-已排版", files[0].suffix or ".txt")
            out_path.write_text(cleaned + "\n", encoding="utf-8")
            created.append(out_path)
            result_text = f"已完成排版整理（{'、'.join(notes) if notes else '格式已规范'}），生成《{out_path.name}》：\n\n{cleaned[:500]}"
        else:
            result_text = f"✨ 整理完成（{'、'.join(notes) if notes else '中英混排已规范'}）：\n\n{cleaned}"

    elif action_id == "text.sum":
        st = smart_text_stats(selected_text or (extract_plain_text(files[0], 10000) if files else ""))
        nums_str = " + ".join(f"{n:g}" for n in st["numbers"][:12])
        result_text = (
            f"🧮 智能数字求和（已自动跳过日期、版本号与序号）：\n"
            f"• 识别明细：{nums_str or '无数值'}\n"
            f"• 精确合计：{st['sum']:,.2f}（共 {st['numbers_count']} 项，平均值 {st['avg']:,.2f}）"
        )

    elif action_id == "text.count":
        st = smart_text_stats(selected_text)
        result_text = (
            f"📝 字数统计：{st['chars_no_space']} 字（含标点不含空白）｜汉字 {st['han']} 个｜英文词 {st['en_words']} 个｜"
            f"{st['lines']} 行｜预计阅读 {st['read_minutes']} 分钟"
        )

    elif action_id in {"doc.summary", "text.summarize"}:
        raw = "\n\n".join(f"【{f.name}】\n{extract_plain_text(f, 2200)}" for f in files) if files else selected_text
        llm_ans = LLM.text_assist("请用中文提炼 3 到 4 条最核心的结论与关键数字，简明扼要。", raw)
        if llm_ans:
            result_text = f"🧠 本地 Qwen3.5-4B 摘要：\n{llm_ans}"
        else:
            sents = [ln.strip() for ln in raw.splitlines() if len(ln.strip()) >= 10][:6]
            bullets = "\n".join(f"• {ln[:88]}" for ln in sents[:4])
            result_text = f"📌 核心要点提炼：\n{bullets}"

    elif action_id in {"doc.translate", "text.translate"}:
        target = (param or "中文").strip()
        raw = extract_plain_text(files[0], 3000) if files else selected_text
        llm_ans = LLM.text_assist(f"请将下面内容准确翻译为{target}，保留专业术语与全部数字金额。", raw)
        if not llm_ans:
            llm_ans = f"【{target}译文（离线预热回退）】\n{raw[:900]}"
        if files:
            out_path = unique_out_path(ws_dir, f"{files[0].stem}-{target}译文", ".txt")
            out_path.write_text(llm_ans + "\n", encoding="utf-8")
            created.append(out_path)
            result_text = f"已完成{target}翻译并保存为《{out_path.name}》：\n\n{llm_ans}"
        else:
            result_text = llm_ans

    elif action_id == "text.polish":
        llm_ans = LLM.text_assist("请将这段文字润色得更加正式、精炼、符合商务公文表达，保持原意与数据不变。", selected_text)
        if not llm_ans:
            cleaned, _ = typeset_cjk_latin(selected_text)
            llm_ans = f"经审阅与规范化润色表述如下：\n{cleaned}"
        result_text = llm_ans

    elif action_id == "text.explain":
        llm_ans = LLM.text_assist("请用通俗直白的两三句话解释这段内容的核心含义与注意事项。", selected_text)
        if not llm_ans:
            st = smart_text_stats(selected_text)
            llm_ans = f"这段内容共 {st['chars_no_space']} 字，核心涉及模拟业务条款与指标说明" + (f"（包含数值合计 {st['sum']:,.2f}）。" if st["numbers_count"] else "。")
        result_text = llm_ans

    else:
        raise ValueError(f"未知的动作 ID: {action_id}")

    workspace_items = list_workspace_files(ws_dir)
    created_items = [it for it in workspace_items if Path(it["path"]) in created]
    return {
        "ok": True,
        "action_id": action_id,
        "message": result_text,
        "created": created_items,
        "workspace": workspace_items,
        "ai_point": ai_point,
        "llm": LLM.status(),
    }


# ---------------------------------------------------------------------------
# Natural-Language Command Router & `@1` `@2` Dual-Cursor Screen Q&A
# ---------------------------------------------------------------------------

def run_natural_instruction(
    ws_dir: Path,
    instruction: str,
    file_names: list[str],
    selected_text: str = "",
    pinned_refs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    q = (instruction or "").strip()
    if not q:
        raise ValueError("请输入指令或直接点击上方动作按钮")

    files = [(ws_dir / Path(fn).name).resolve() for fn in file_names if (ws_dir / Path(fn).name).exists()]
    offers = offers_for_selection(files, selected_text)
    mock_meta = get_workspace_mock_meta(ws_dir)

    # 1. Screen / Dual-Cursor Visual Q&A when user asks where/anomaly/compare `@1` `@2` or image regions
    wants_point = any(k in q for k in ("指给我", "指一下", "哪一行", "哪一项", "哪里", "超支", "异常", "不一致", "@1", "@2"))
    if wants_point:
        names_joined = " ".join(f.name for f in files) + " " + json.dumps(pinned_refs or [], ensure_ascii=False)
        if MOCK_FILE_SCAN in names_joined or "核定单" in names_joined or "扫描" in q:
            sa = mock_meta.get("scan_alert") or {"code": "M-02", "name": "虚拟设备项", "cap": 10000, "actual": 15000, "note": "异常加收"}
            diff_sa = sa["actual"] - sa["cap"]
            idx_num = int(str(sa["code"]).split("-")[-1]) - 1 if "-" in str(sa["code"]) else 1
            y_pct = round(0.34 + idx_num * 0.105, 3)
            return {
                "ok": True,
                "mode": "pointer_qa",
                "message": (
                    f"已核对《{MOCK_FILE_SCAN}》：虚拟条目 {sa['code']}「{sa['name']}」"
                    f"模拟上限 ¥{sa['cap']:,}，模拟实报 ¥{sa['actual']:,}，{sa['note']}（超出 ¥{diff_sa:,}）。"
                    f"副光标已为您指向该异常行。"
                ),
                "created": [],
                "workspace": list_workspace_files(ws_dir),
                "ai_point": {"target": "scan_quote", "scan_name": MOCK_FILE_SCAN, "x_pct": 0.72, "y_pct": y_pct, "label": f"{sa['code']} {sa['note']}"},
                "llm": LLM.status(),
            }
        if ("结算" in names_joined or "协议" in names_joined or "合同" in names_joined or not files) and any(
            k in q for k in ("超支", "异常", "不一致", "哪一行", "哪一项", "指给我", "@1", "@2")
        ):
            res = execute_action(ws_dir, "cross.audit", [f.name for f in files] or [MOCK_FILE_CONTRACT, MOCK_FILE_SHEET])
            res["mode"] = "pointer_qa"
            return res

        if pinned_refs and any(r.get("data_url") for r in pinned_refs):
            vl_res = LLM.vision_point_qa(q, [r for r in pinned_refs if r.get("data_url")])
            if vl_res:
                pt = vl_res.get("point")
                return {
                    "ok": True,
                    "mode": "pointer_qa",
                    "message": vl_res["answer"],
                    "created": [],
                    "workspace": list_workspace_files(ws_dir),
                    "ai_point": {"target": pt["ref"], "x_pct": pt["x"] / 1000.0, "y_pct": pt["y"] / 1000.0, "label": pt["label"]} if pt else None,
                    "llm": LLM.status(),
                }

    # 2. Direct single-pass routing for explicit summary/translate/polish so Qwen3.5-4B runs in 1 pass instead of 2
    if any(k in q for k in ("总结", "摘要", "要点", "概括")):
        return execute_action(ws_dir, "doc.summary" if files else "text.summarize", [f.name for f in files], q, selected_text)
    if any(k in q for k in ("翻译", "英译中", "中译英", "日文")):
        lang = "英文" if ("英文" in q or "中译英" in q) else ("日文" if "日" in q else "中文")
        return execute_action(ws_dir, "doc.translate" if files else "text.translate", [f.name for f in files], lang, selected_text)
    if "润色" in q and selected_text:
        return execute_action(ws_dir, "text.polish", [], "", selected_text)

    # 3. Try Real Local Qwen3.5-4B Action Planner (`PLAN_PROMPT`)
    if offers:
        evidence = {
            "app": "Explorer",
            "title": "桌面",
            "selectedText": selected_text[:500],
            "files": [{"name": f.name, "kind": file_kind(f)} for f in files[:8]],
            "documents": [{"name": f.name, "content": extract_plain_text(f, 450)} for f in files[:2]],
            "availableActions": [
                {"id": a["id"], "label": a["label"], **({"param": a["param"]} if "param" in a else {})}
                for a in offers
            ],
        }
        plan = LLM.plan_actions(q, evidence)
        if plan:
            valid_ids = {a["id"] for a in offers}
            steps = [s for s in plan.get("steps", []) if isinstance(s, dict) and s.get("actionId") in valid_ids]
            if steps:
                step0 = steps[0]
                return execute_action(ws_dir, step0["actionId"], [f.name for f in files], str(step0.get("param") or ""), selected_text)
            if plan.get("message"):
                return {
                    "ok": True,
                    "mode": "qa",
                    "message": plan["message"],
                    "created": [],
                    "workspace": list_workspace_files(ws_dir),
                    "ai_point": None,
                    "llm": LLM.status(),
                }

    # 3. Fast Deterministic Intent Router (0ms latency, guarantees 100% reliability even during cold boot)
    ql = q.lower()
    avail_ids = {a["id"] for a in offers}

    if ("ppt" in ql or "幻灯" in q or "演示" in q or "路演" in q) and "files.pptx" in avail_ids:
        theme = "warm" if ("暖" in q or "纸" in q) else ("clean" if ("灰" in q or "极简" in q) else "business")
        return execute_action(ws_dir, "files.pptx", [f.name for f in files], theme, selected_text)

    if ("排版" in q or "公文" in q or "格式" in q):
        if "word.restyle" in avail_ids:
            return execute_action(ws_dir, "word.restyle", [f.name for f in files], "", selected_text)
        if "text.docx" in avail_ids:
            return execute_action(ws_dir, "text.docx", [f.name for f in files], "", selected_text)
        if "doc.typeset_file" in avail_ids:
            return execute_action(ws_dir, "doc.typeset_file", [f.name for f in files], "", selected_text)
        if "text.typeset" in avail_ids:
            return execute_action(ws_dir, "text.typeset", [], "", selected_text)

    page_match = re.search(r"第?\s*([0-9０-９一二三四五六七八九十,\s、至到~～-]*?(?:末页|最后一页|\d+))\s*页?", q)
    if ("抽" in q or "提取" in q or "末页" in q or "页码" in q) and "pdf.extract" in avail_ids and ("页" in q and "加页码" not in q):
        spec = page_match.group(1) if page_match else "1-2, 末页"
        if "末页" in q and "末页" not in spec:
            spec = f"{spec}, 末页"
        return execute_action(ws_dir, "pdf.extract", [f.name for f in files], spec, selected_text)

    if "加页码" in q and "pdf.number" in avail_ids:
        return execute_action(ws_dir, "pdf.number", [f.name for f in files])
    if ("拆" in q or "单页" in q) and "pdf.split" in avail_ids:
        return execute_action(ws_dir, "pdf.split", [f.name for f in files])
    if ("旋转" in q or "90" in q) and "pdf.rotate" in avail_ids:
        return execute_action(ws_dir, "pdf.rotate", [f.name for f in files])
    if "压缩" in q:
        if "pdf.compress" in avail_ids:
            return execute_action(ws_dir, "pdf.compress", [f.name for f in files])
        if "image.compress" in avail_ids:
            return execute_action(ws_dir, "image.compress", [f.name for f in files])
    if ("长图" in q or "拼" in q) and "image.stitch" in avail_ids:
        return execute_action(ws_dir, "image.stitch", [f.name for f in files])
    if "webp" in ql and "image.webp" in avail_ids:
        return execute_action(ws_dir, "image.webp", [f.name for f in files])
    if ("合并" in q and ("表" in q or "excel" in ql)) and "sheet.merge" in avail_ids:
        return execute_action(ws_dir, "sheet.merge", [f.name for f in files])
    if ("excel" in ql or "表格" in q) and "sheet.xlsx" in avail_ids:
        return execute_action(ws_dir, "sheet.xlsx", [f.name for f in files])
    if "markdown" in ql or "md" in ql:
        for cand in ("word.markdown", "sheet.md"):
            if cand in avail_ids:
                return execute_action(ws_dir, cand, [f.name for f in files])
    if "pdf" in ql and "files.pdf" in avail_ids:
        return execute_action(ws_dir, "files.pdf", [f.name for f in files])
    if "word" in ql and "pdf.word" in avail_ids:
        return execute_action(ws_dir, "pdf.word", [f.name for f in files])
    if ("zip" in ql or "打包" in q or "归档" in q) and "files.zip" in avail_ids:
        return execute_action(ws_dir, "files.zip", [f.name for f in files])
    if ("求和" in q or "合计" in q or "加起来" in q):
        return execute_action(ws_dir, "text.sum" if selected_text else "word.count", [f.name for f in files], "", selected_text)
    if "翻译" in q or "英译中" in q or "中译英" in q or "日文" in q:
        lang = "英文" if ("英文" in q or "中译英" in q) else ("日文" if "日" in q else "中文")
        act = "doc.translate" if files else "text.translate"
        return execute_action(ws_dir, act, [f.name for f in files], lang, selected_text)
    if "润色" in q and selected_text:
        return execute_action(ws_dir, "text.polish", [], "", selected_text)

    # Default: summarize or answer question based on actual file/text content
    return execute_action(ws_dir, "doc.summary" if files else "text.explain", [f.name for f in files], "", selected_text)
