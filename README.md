# 指点 ZhiDian · v0.5

[![Release v0.5.0](https://img.shields.io/github/v/release/misakamikotoghr-5205/ZhiDian-Open?style=flat-square&color=2563eb)](https://github.com/misakamikotoghr-5205/ZhiDian-Open/releases/tag/v0.5.0)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-16a34a?style=flat-square)](LICENSE)
[![Base Model: Qwen3.5](https://img.shields.io/badge/Base_Model-Qwen3.5--0.8B_%2F_4B-7c3aed?style=flat-square)](https://huggingface.co/Qwen/Qwen3.5-0.8B)
[![MCP Server](https://img.shields.io/badge/MCP-Stdio_Server-0891b2?style=flat-square)](bin/zhidian-mcp.mjs)

> **Screen-Native Offline Desktop AI Office Agent for Windows** — Press **F8**, drag over desktop or Explorer files to bind real file handles via Windows Shell COM + Z-order occlusion clipping, and run 20+ deterministic Office/PDF/Sheet conversions locally with custom **Qwen3.5 LoRA** adapters (`office-small-lora.gguf` 3.4 MB & `zhidian-pointer-qwen3.5-0.8b.gguf` 12.2 MB). Zero cloud upload required.

面向 Windows 的本地办公助手：按 **F8**，框住桌面或资源管理器里的几个文件，再选择办公动作。模型理解任务，文件转换由本地程序按模板完成。

- **发行版与演示视频下载（GitHub Releases）**：[v0.5.0 Release（含双 LoRA GGUF 权重、1080p 虚拟机全流程演示视频与离线安装包）](https://github.com/misakamikotoghr-5205/ZhiDian-Open/releases/tag/v0.5.0)
- **实测基准报告**：[docs/benchmarks.md](docs/benchmarks.md) · **训练复现说明**：[train/office-v05/README.md](train/office-v05/README.md) · **在线工作台源码**：[studio/app.py](studio/app.py)

---

## 核心特性 / Highlights

- **Windows Shell 真实文件几何绑定（防顶层窗口遮挡）**：直接通过 Windows Shell COM 读取桌面与资源管理器可见项的真实路径与屏幕矩形，并裁剪顶层窗口 Z-order 遮挡区域——不靠截图 OCR 猜文件名，也不会误抓被前景窗口挡住的后台文件。
- **小模型规划意图 + 确定性引擎保排版**：内置商务、简洁、暖色三套原生可编辑主题，由确定性代码完成 PPTX 分页续表头、Word 样式重排、PDF 页码提取/拆分/合并与表格汇总，零数字篡改、不覆盖原文件。
- **端侧双 LoRA 轻量适配器（单卡消费级 GPU 可复现）**：
  - `models/office-small-lora.gguf`（3.4 MB，Rank-8）：面向 `Qwen/Qwen3.5-0.8B` 的中文办公动作规划适配器，76 题留出集严格 JSON 率 **100%**（`76/76`），动作与有效参数准确率从基座 `51.3%` 提升至 **88.2%–89.5%**。
  - `models/zhidian-pointer-qwen3.5-0.8b.gguf`（12.2 MB）：一趟同时输出回答与界面元素坐标的屏幕副光标适配器，4 核纯 CPU 推理耗时相比两趟精确定位缩短约 **65%–70%**，驱动独立 AI 副光标直指目标行而不抢占物理鼠标。
- **内置标准 MCP Server**：通过 `npx zhidian-mcp`（[bin/zhidian-mcp.mjs](bin/zhidian-mcp.mjs)）向 Claude Desktop、Cursor 等外部客户端暴露本地确定性文档转换能力。

---

## 打开和使用

1. 将完整离线包解压到 D 盘、G 盘等位置，双击 `Zhidian.exe`，保留旁边的 resources、DLL 和模型文件。
2. 打开桌面或目标文件夹，按 **F8**，拖框覆盖文件的图标和名称。无需提前选中文件或拖入软件。
3. 在约 340 像素宽的小卡片中核对文件，直接选动作，或输入任务。自然语言方案经点击执行后运行。
4. 输出放在原文件旁；无权限时放到“文档/Zhidian”，不覆盖原文件。
5. 基本设置只有语音开关和折叠的高级设置。高级设置包含输出模板、模型扩展目录、快捷键和可选服务。

启动不会因为没有联网服务而自动弹出大设置窗口。全部快捷键被占用时会显示快捷键设置。

## 截图与真实文件

截图模式支持左键点击确认截图、左键拖拽框选；右键取消当前截图模式，Esc取消仍然保留。已截取的引用可通过引用上的关闭按钮或Backspace移除。

截图时，程序同时读取 Windows Shell 提供的真实文件身份，以及图标和名称的位置。框选矩形与这些位置相交后才把文件交给办公工具，路径不由模型猜测。

- 支持资源管理器当前可见文件和 Windows 桌面，包括桌面 UI Automation 不提供图标的情况。
- 同名歧义、未解析图标、虚拟位置、文件已移走会提示；混合框选含歧义时不执行部分文件。
- 快照过期、文件变化后需重新按 F8。
- 网页截图或聊天中的文件图片不会自动变成本地文件。
- 常用界面和模型工具列表已移除任意窗口按钮点击、填写、滚动等通用软件控制。

## 自动模型与功能范围

完整离线包包含 Qwen3.5 **0.8B 小模型**、**4B 大模型**、视觉投影器和 llama.cpp 运行时，构建时下载并校验。启动从软件目录读取，不要求用户下载，也不把权重复制到 C 盘。已移除 2B 中档。

默认自动选择：物理内存至少约 15 GiB、可用内存至少 7 GiB 时优先大模型，其余用小模型。自动推荐在本次运行中保持稳定。高级设置可手动指定0.8B或4B；手动选择优先，保存目录不会覆盖它。若指定模型缺失，会提示检查文件，不会悄悄改用其他模型。CPU运行时可用，不要求独立显卡。

| 档位 | 办公动作 |
|---|---|
| 小模型 | 转/合并 PDF、生成 PPT、Word 排版、PDF 拆分、PDF 页码提取、合并表格、图片压缩、选中文字排版 |
| 大模型 | 小模型全部动作，以及 PDF 转 Word/提取文字、Word 提取文字/转 Markdown、文本文件排版、表格转 XLSX/CSV、翻译、润色、摘要、图片文字识别 |

显示和执行两端均检查档位限制。确定性文件工具不需要等待模型加载，自然语言理解需要模型就绪。大模型是固定版本的原始量化模型；小模型办公 LoRA 的训练范围和实际评测见 `train/office-v05`，不能理解为通用办公能力保证。

高级设置可更改模型扩展目录，不移动或删除已有文件。支持直接选择放有GGUF的文件夹，也支持包含models子文件夹的上级目录；同名且完整的外部文件优先，未提供的模型文件可使用内置版本。设置显示当前模型文件的实际路径。`ZHIDIAN_LOCAL_DIR` 环境变量优先于界面设置。

**模型下载入口始终保留在「高级设置 → 本地模型 → 下载模型」中**。无模型的软件包可先保存下载目录，再选择0.8B或4B及下载源，点击「下载并安装」，补齐模型、视觉投影器及缺失的运行时。已齐全的文件会复用；支持查看进度、取消及重试，关闭设置窗口后可重新打开继续管理下载。下载不会改变上方「使用模型」的自动/手动选择，也不会在首次启动时自动联网下载。

## 按规则写入模板

内置商务、简洁、暖色三套主题。Word、PDF、PPT 和表格输出使用一致的字体、颜色、层级规则。

- PPT 读取 Word、Markdown、纯文本和 PDF 文字，按标题和段落填入可编辑文本框。长表分页、宽表分列，重复表头及关键列，保留原生表格。
- 没有可提取文字的 PDF 扫描页保留图片，明确提示“文字不可编辑”。
- 长段落采用页面节选加完整备注，避免静默丢失内容。
- Word 统一字体、层级、行距与表格表头，另存一份。
- 表格统一标题行、筛选与冻结首行，主要处理值，不保证保留全部公式、宏或复杂格式。

模型理解“做什么”，排版、分页和保存由程序按规则完成。0.5 暂不提供任意外部 PPT 模板的占位符映射。

## 语音与联网

语音默认关闭，需要在高级设置连接本机 Whisper 兼容服务或云端语音 API。录音转为可编辑草稿，经发送才执行。完整包不包含语音识别权重。

办公模型默认本机运行。可选联网模型由用户配置并开启，界面显示服务来源。文档和文件名作为数据处理，模型只能从已提供的动作中选择。

## 开发与离线构建

需要 Node.js 22.12 以上。源码不直接存放数 GB 的基础权重，构建器按固定版本和 SHA256 获取；发行包必须包含全部离线文件。

```powershell
git clone https://github.com/misakamikotoghr-5205/ZhiDian-Open.git
cd ZhiDian-Open
npm ci
npm test
# 国内可选：$env:ZHIDIAN_BUILD_SOURCE='hfmirror'
npm run bundle
node build/bundle-local.mjs --verify-only
npm run package
```

构建要求已提交的办公适配器及 `models/office-adapter.json` 校验清单，缺少时拒绝生成“已训练离线包”。调试界面可运行 `npm run rehearse`，这是明确标注的排练脚本，不能作为模型效果证据。

版本说明与验证范围见 [0.5 发布说明](docs/releases/v0.5.0.md)。本轮实机验证针对 Windows；其他系统基础代码保留，但文件区域绑定只在 Windows 验证。

## 开源许可 / License

本项目源码与自训 LoRA 适配器采用 [Apache License 2.0](LICENSE) 开源；基座模型遵循 Qwen 官方许可协议（见 [models/LICENSE-Qwen.txt](models/LICENSE-Qwen.txt)）。
