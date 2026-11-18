// Real Chromium PDF printing and slide generation for all built-in document templates.
// KEEP=1 retains the outputs for visual inspection; xvfb-run supplies a display on Linux.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { DOCUMENT_THEMES } from '../../src/core/document-themes.js';
import { launchOffice } from './office-harness.mjs';

const office = await launchOffice();
try {
  for (const theme of DOCUMENT_THEMES) {
    const file = path.join(office.work, `report-${theme.id}.md`);
    fs.writeFileSync(file, `# 2026 项目进展 / Project review

## 关键进展 / Highlights

我们把复杂的信息整理成清晰的报告，让每一个结论都有依据。所有内容在本机转换，文字、表格和图片保持可读。

- 发布流程更稳定，团队可以更快地完成日常交付。
- 每个任务都有明确的负责人和完成时间。
- 下一阶段聚焦体验改进、质量保障与客户反馈。

> 好的文档，让读者先看到重点，再找到细节。

## 执行计划 / Delivery plan

| 项目 / Item | 负责人 / Owner | 状态 / Status |
| --- | --- | --- |
${Array.from({ length: 80 }, (_, i) => `| Record ${String(i + 1).padStart(3, '0')} | Team ${i % 3 + 1} | In progress |`).join('\n')}

## Next steps

FINAL-CONTENT-MARKER: confirm the owners and review the next milestone.
`);
    const { result } = await office.ok('files.pdf', { files: [file] }, { template: theme.id });
    const pdf = await PDFDocument.load(fs.readFileSync(result.path));
    assert.ok(pdf.getPageCount() >= 3, 'long tables paginate over multiple pages');
    const extracted = await office.ok('pdf.text', { files: [result.path] });
    const text = fs.readFileSync(extracted.result.path, 'utf8');
    assert.ok(text.includes('Record 001'));
    assert.ok(text.includes('Record 080'), 'the last table row is retained');
    assert.ok(text.includes('FINAL-CONTENT-MARKER'), 'body content after the table is retained');
    assert.ok((text.match(/Item/g) ?? []).length >= 2, 'table column headings repeat on later pages');
    await office.ok('files.pptx', { files: [file] }, { template: theme.id });
    console.log(`PASS: ${theme.label}, ${pdf.getPageCount()} PDF pages; PDF/PPTX saved in ${office.work}`);
  }
} finally {
  await office.close();
  if (!process.env.KEEP) fs.rmSync(office.work, { recursive: true, force: true });
}
