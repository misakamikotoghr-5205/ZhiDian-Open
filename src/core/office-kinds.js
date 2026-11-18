// What the pointer is on, as far as office work goes: a selection of files, or a piece of
// selected text. This module names the kinds of files and describes a selection; the actions
// themselves, and when each is offered, are in src/main/office/tools-*.js.

const EXT_KIND = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', jfif: 'image', webp: 'image', gif: 'image', bmp: 'image',
  avif: 'image', svg: 'image', ico: 'image',
  docx: 'word',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', log: 'text',
  csv: 'sheet', tsv: 'sheet', xlsx: 'sheet',
  // Readable only with an office suite installed (LibreOffice): offered when one is found.
  doc: 'office', rtf: 'office', odt: 'office', wps: 'office',
  ppt: 'office', pptx: 'office', odp: 'office',
  xls: 'office', ods: 'office',
};

export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/** 'pdf' | 'image' | 'word' | 'markdown' | 'text' | 'sheet' | 'office' | 'other' */
export function kindOf(name, platform = typeof process !== 'undefined' ? process.platform : '') {
  const ext = extOf(name);
  if ((ext === 'heic' || ext === 'heif') && platform === 'darwin') return 'image';
  return EXT_KIND[ext] ?? 'other';
}

const baseName = (p) => String(p ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();

/** Normalise a list of paths into [{ path, name, ext, kind }], dropping duplicates. */
export function describeFiles(paths) {
  const seen = new Set();
  const files = [];
  for (const p of paths ?? []) {
    const path = String(p ?? '').trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = baseName(path);
    files.push({ path, name, ext: extOf(name), kind: kindOf(name) });
  }
  return files;
}

/** A short human label: "3 个文件：报告.docx、图1.png 等". */
export function summarize(context) {
  if (context?.kind === 'text') {
    const t = context.text.replace(/\s+/g, ' ').trim();
    const chars = [...t];
    return `选中的文字（${[...context.text.trim()].length} 字）：${chars.length > 26 ? chars.slice(0, 26).join('') + '…' : t}`;
  }
  if (context?.kind === 'files') {
    const names = context.files.map((f) => f.name);
    if (names.length === 1) return names[0];
    return `${names.length} 个文件：${names.slice(0, 2).join('、')}${names.length > 2 ? ' 等' : ''}`;
  }
  return '';
}

/** A name for the result, built from what went in. */
export function resultName(files, suffix, ext) {
  const first = (files[0]?.name ?? '').replace(/\.[A-Za-z0-9]{1,8}$/, '').trim() || '结果';
  const stem = files.length > 1 ? `${first} 等 ${files.length} 个文件` : first;
  return `${stem}${suffix}.${ext}`;
}
