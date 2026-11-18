# 指针适配器：数据、训练、评测

目标：让默认的 Qwen3.5-0.8B **一趟推理同时给出回答和坐标**，并且在小截图上指得准，这样没有显卡的电脑也只需算一次。

## 文件

| 文件 | 作用 |
|---|---|
| `gen_dataset.mjs` | 用随机化的界面模板渲染截图，生成"截图 + 问题 → 回答 + 坐标"的样本。需要 Playwright 和 Chromium。 |
| `export_prompt.mjs` | 把应用实际使用的提示词导出成 `prompt.json`。改了 `src/core/prompt.js` 之后重新运行。 |
| `pointer_lora.py` | LoRA 训练（`train`）和评测（`eval`）。只在语言模型的线性层上加适配器，视觉编码器不动，所以原版的 mmproj 文件照常使用。 |
| `runtime_eval.py` | 在应用实际使用的运行环境里测：`llama-server` + 量化模型，纯 CPU，发的请求和应用一模一样。对比原版"两趟"与带适配器"一趟"的命中率、每题耗时、服务进程内存峰值。 |
| `colab_job.py` | 在 Colab GPU 机器上一次跑完：训练 → 转成 GGUF → 评测（可选再跑 `runtime_eval.py`）。训练中每 125 步存一次，设了 `ZHIDIAN_SAVE_DIR` 就同时拷到那个目录。 |
| `results/` | 仓库里这份适配器的训练日志和评测结果（`train_log.json`、`eval.json`、`job.json`）。 |

## 数据

六类界面参与训练：对话框、价格卡片（单张和两张对比）、表格、设置开关、代码、表单。另外三类（菜单、文件列表、工具栏）**完全不参与训练**，只用于评测（`heldout`），用来回答"换一种没见过的界面还行不行"。

每条样本的目标输出是：

```
@2 更便宜，¥ 3,899，比另一个少 ¥ 400。
{"ref": "@2", "point_2d": [241, 593], "label": "¥ 3,899"}
```

坐标是 0–1000 的相对坐标（Qwen-VL 系列的原生约定）。一半样本的编号不是从 @1 开始，让模型照抄给它的编号而不是数图片。

局限要说清楚：数据全是程序合成的，字体只有本机装的几种，回答是模板句。它教会模型的是输出格式、在低分辨率下定位、以及简短的中文界面用语；它不会让模型更懂世界。评测数字也只说明在这类合成界面上的表现。

## 本地跑

```bash
node train/export_prompt.mjs
node train/gen_dataset.mjs --out train/data --n 4000 --seed 11
pip install torch torchvision transformers peft accelerate pillow
python train/pointer_lora.py train --data train/data --out train/out --epochs 2
python train/pointer_lora.py eval  --data train/data --out train/out --adapter train/out/adapter
```

实测：A100 上 4000 条两轮用了 57 分钟（2.4 条/秒），T4 上约 1.5 条/秒。速度不随显卡明显提高，因为 transformers 对这个模型的两个算子用的是较慢的参考实现；装上日志里提示的 `flash-linear-attention` 和 `causal_conv1d` 应该会快，我没有试。纯 CPU 每条约 5 秒，只适合小规模试跑（`--limit 640 --epochs 1`）。

训练用 float32（T4 没有原生 bfloat16）。租来的 GPU 随时可能被收回：`--save-every 125` 会定期存下适配器。

## 转成应用能用的格式

```bash
git clone --depth 1 --branch b12110 https://github.com/ggml-org/llama.cpp
python llama.cpp/convert_lora_to_gguf.py --base <Qwen3.5-0.8B 的本地目录> --outtype f16 \
    --outfile models/zhidian-pointer-qwen3.5-0.8b.gguf train/out/adapter
```

把生成的文件放到仓库的 `models/` 目录（或应用数据目录的 `local/models/`），应用启动本地模型时会自动带上 `--lora`，并切换到一趟模式。删掉这个文件就回到原来的两趟模式。

## 仓库里这份适配器是怎么来的

| 项目 | 值 |
|---|---|
| 基座 | `Qwen/Qwen3.5-0.8B`，修订 `2fc0636…` |
| 数据 | `gen_dataset.mjs --n 4000 --seed 11`：训练 4000 条，验证 200 条，未见类型 240 条 |
| 配置 | LoRA rank 16、alpha 32、dropout 0.05，语言模型各层的注意力和前馈投影（q/k/v/o、gate/up/down，共 638.9 万个可训练参数），学习率 2e-4 余弦衰减，累积 8 步，2 轮共 1000 步 |
| 硬件与时间 | Colab A100，训练 57 分钟；损失 0.93 → 0.18 |
| 产物 | `models/zhidian-pointer-qwen3.5-0.8b.gguf`，12.8 MB（f16），SHA-256 `04d4fe63…a14fe7` |

评测（每个划分取前 120 条，全精度模型，GPU）见 [`results/eval.json`](results/eval.json)，数字和解读在 [`docs/benchmarks.md`](../docs/benchmarks.md)。

一个要对齐的细节：模型自带的预处理器不会给它小于 64 个图像 token（65,536 像素）的图，小截图会先被放大；而 GGUF 的视觉文件里没带这个下限，llama.cpp 默认按原样喂。应用启动 `llama-server` 时显式加了 `--image-min-tokens 64`，让运行时看到的图和训练时一致。
