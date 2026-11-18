// Bind a crop to files that the OS reported in the same Explorer/Desktop view.
// Names are only compared within that captured view; no OCR guesses or disk-wide search.
import path from 'node:path';

const key = (name) => String(name ?? '').normalize('NFC').toLocaleLowerCase('en-US');
export function validRect(rect) {
  return Boolean(rect && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(rect[k])) && rect.w > 0 && rect.h > 0);
}

export function candidatesForItem(name, entries) {
  const label = key(name);
  if (!label) return [];
  const names = (entry) => [entry.name, ...(entry.aliases || []), path.win32.basename(entry.path || '')].map(key);
  const exact = entries.filter(e => names(e).includes(label));
  const unique = (rows) => [...new Map(rows.filter(e => e.path).map(e => [key(e.path), e])).values()];
  if (exact.length) return unique(exact);
  // Only a visible truncation marker permits prefix matching, and only a unique result binds.
  // UI Automation normally provides the untruncated label, even when Explorer paints ellipses.
  const prefix = /(?:…|\.\.\.)$/.test(label) ? label.replace(/(?:…|\.\.\.)$/, '') : '';
  if (prefix.length < 3) return [];
  return unique(entries.filter(e => names(e).some(name => name.startsWith(prefix))));
}

export function rectSelectsItem(region, item) {
  if (!validRect(region)) return false;
  const targets = item.hitBounds?.filter(validRect);
  return (targets?.length ? targets : [item.bounds]).some(rect => {
    if (!validRect(rect)) return false;
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    if (cx >= region.x && cx <= region.x + region.w && cy >= region.y && cy <= region.y + region.h) return true;
    const w = Math.max(0, Math.min(region.x + region.w, rect.x + rect.w) - Math.max(region.x, rect.x));
    const h = Math.max(0, Math.min(region.y + region.h, rect.y + rect.h) - Math.max(region.y, rect.y));
    return w * h >= rect.w * rect.h * 0.5;
  });
}

/** Both region and native item bounds are screen physical pixels, including negative origins. */
export function filesInRegion(items, region) {
  if (!validRect(region)) return { ok: false, files: [], items: [], unresolved: [], warnings: ['框选范围无效，请重新框选文件图标。'] };
  const selected = items.filter(item => rectSelectsItem(region, item));
  const resolved = selected.filter(item => item.status === 'resolved' && item.path);
  const unresolved = selected.filter(item => item.status !== 'resolved' || !item.path);
  const files = [...new Set(resolved.map(item => item.path))];
  const warnings = [];
  if (!selected.length) warnings.push('框内没有识别到文件图标。请在桌面或资源管理器中框住文件图标及名称。');
  if (unresolved.some(item => item.status === 'ambiguous')) warnings.push('有同名文件无法唯一对应，请在资源管理器中显示扩展名或缩小到可确认的文件后重试。');
  if (unresolved.some(item => item.status !== 'ambiguous')) warnings.push('部分图标未能对应到可读取的本地文件；文件夹、虚拟位置和失效快捷方式不会被当作文件处理。');
  return { ok: files.length > 0 && unresolved.length === 0, files, items: selected, unresolved, warnings };
}
