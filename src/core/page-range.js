// Parses human page specifications such as "1-3, 5", "2、4、末页", or "8-6" into a deduplicated
// 1-based list of page numbers, rejecting out-of-range or malformed inputs in plain Chinese.

const FULLWIDTH_DIGITS = '０１２３４５６７８９';

function normalizeSpec(raw, total) {
  let s = String(raw ?? '').trim();
  s = s.replace(/[０-９]/g, (ch) => String(FULLWIDTH_DIGITS.indexOf(ch)));
  s = s.replace(/最后一页|最后页|末页|end/gi, String(total));
  s = s.replace(/[，、；;]/g, ',');
  s = s.replace(/\s*(?:—|–|～|~|至|到|-)\s*/g, '-');
  return s.trim();
}

/**
 * @param {string} spec  e.g. "1-3, 5"
 * @param {number} total 1-based page count of the PDF
 * @returns {number[]}   deduplicated 1-based page numbers in the order requested
 */
export function parsePageSpec(spec, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error('这个 PDF 里没有页面');
  const norm = normalizeSpec(spec, total);
  if (!norm) throw new Error('请填写要提取的页码，例如 1-3, 5');

  const seen = new Set();
  const pages = [];
  const add = (n) => {
    if (n < 1) throw new Error('页码要从第 1 页开始');
    if (n > total) throw new Error(`第 ${n} 页超出了总页数（这个 PDF 共 ${total} 页）`);
    if (!seen.has(n)) {
      seen.add(n);
      pages.push(n);
    }
  };

  for (const part of norm.split(/[,\s]+/).filter(Boolean)) {
    if (/^\d+$/.test(part)) {
      add(Number(part));
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b < 1) throw new Error('页码要从第 1 页开始');
      if (a > total || b > total) throw new Error(`第 ${Math.max(a, b)} 页超出了总页数（这个 PDF 共 ${total} 页）`);
      const step = a <= b ? 1 : -1;
      for (let p = a; step > 0 ? p <= b : p >= b; p += step) add(p);
      continue;
    }
    if (/^-\d+$/.test(part)) throw new Error('页码要从第 1 页开始');
    throw new Error(`看不懂页码“${part}”，可以填单页或范围，例如 1-3, 5`);
  }

  if (!pages.length) throw new Error('请填写要提取的页码，例如 1-3, 5');
  return pages;
}
