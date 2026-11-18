// Safe, zero-dependency Markdown-to-DOM renderer for the answer bubble.
// Never touches innerHTML: every element and text node is built through the DOM API so the
// overlay's strict Content-Security-Policy stays intact and model output cannot inject markup.

const BADGE_RE = /\uE000(\d{1,3})\uE001/;
const INLINE_SRC = '(`[^`\\n]+`|\\*\\*[^*\\n]+?\\*\\*|__[^_\\n]+?__|~~[^~\\n]+?~~|(?<![*\\w])\\*[^*\\s][^*\\n]*?\\*(?![*\\w])|\\uE000\\d{1,3}\\uE001|(?<![\\w@])@0*[1-9]\\d{0,2}\\b)';

/** Build an inline badge token that survives Markdown parsing and turns into `.badge`. */
export const badgeToken = (n) => `\uE000${n}\uE001`;

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function appendInline(parent, text, opts, doc) {
  const str = String(text ?? '');
  if (!str) return;
  let last = 0;
  const re = new RegExp(INLINE_SRC, 'g');
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) parent.append(doc.createTextNode(str.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('`') && tok.endsWith('`')) {
      parent.append(el(doc, 'code', 'md-code', tok.slice(1, -1)));
    } else if ((tok.startsWith('**') && tok.endsWith('**')) || (tok.startsWith('__') && tok.endsWith('__'))) {
      const strong = el(doc, 'strong', '');
      appendInline(strong, tok.slice(2, -2), opts, doc);
      parent.append(strong);
    } else if (tok.startsWith('~~') && tok.endsWith('~~')) {
      const del = el(doc, 'del', '');
      appendInline(del, tok.slice(2, -2), opts, doc);
      parent.append(del);
    } else if (tok.startsWith('*') && tok.endsWith('*')) {
      const em = el(doc, 'em', '');
      appendInline(em, tok.slice(1, -1), opts, doc);
      parent.append(em);
    } else if (tok.startsWith('\uE000')) {
      const bm = BADGE_RE.exec(tok);
      if (bm) parent.append(el(doc, 'span', 'badge', bm[1]));
    } else if (tok.startsWith('@')) {
      const handle = '@' + Number(tok.slice(1));
      if (opts.isRef?.(handle)) {
        const ref = opts.renderRef ? opts.renderRef(handle, doc) : el(doc, 'span', 'ref', handle);
        parent.append(ref);
      } else {
        parent.append(doc.createTextNode(tok));
      }
    } else {
      parent.append(doc.createTextNode(tok));
    }
    last = m.index + tok.length;
  }
  if (last < str.length) parent.append(doc.createTextNode(str.slice(last)));
}

function appendLines(parent, lines, opts, doc) {
  lines.forEach((line, idx) => {
    if (idx > 0) parent.append(doc.createElement('br'));
    appendInline(parent, line, opts, doc);
  });
}

function splitTableCells(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function isTableRule(line, cols) {
  if (!line || !line.includes('|')) return false;
  const cells = splitTableCells(line);
  return cells.length === cols && cells.length >= 2 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/**
 * Render Markdown text into a safe DocumentFragment (no innerHTML).
 * @param {string} text
 * @param {{ isRef?: (handle: string) => boolean, renderRef?: (handle: string, doc: Document) => Node, onCopyCode?: (code: string) => void }} [opts]
 * @param {Document} [doc]
 */
export function renderMarkdown(text, opts = {}, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!raw.trim()) {
    if (raw) frag.append(doc.createTextNode(raw));
    return frag;
  }
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank lines separate blocks.
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block: ```lang or ~~~lang
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n`]*)$/.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2].trim().split(/\s+/)[0] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      const codeText = codeLines.join('\n');
      const wrap = el(doc, 'div', 'md-pre');
      const bar = el(doc, 'div', 'md-pre-bar');
      bar.append(el(doc, 'span', 'md-pre-lang', lang || '代码'));
      if (opts.onCopyCode) {
        const btn = el(doc, 'button', 'md-copy', '复制代码');
        btn.setAttribute('type', 'button');
        btn.addEventListener('click', (ev) => {
          ev?.stopPropagation?.();
          opts.onCopyCode(codeText);
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制代码'; }, 1600);
        });
        bar.append(btn);
      }
      const pre = el(doc, 'pre', '');
      pre.append(el(doc, 'code', '', codeText));
      wrap.append(bar, pre);
      frag.append(wrap);
      continue;
    }

    // Horizontal rule
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      frag.append(el(doc, 'hr', 'md-hr'));
      i++;
      continue;
    }

    // ATX heading (# .. ####)
    const heading = /^ {0,3}(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const hNode = el(doc, `h${level}`, `md-h md-h${level}`);
      appendInline(hNode, heading[2], opts, doc);
      frag.append(hNode);
      i++;
      continue;
    }

    // GFM table
    if (line.includes('|') && i + 1 < lines.length) {
      const headCells = splitTableCells(line);
      if (headCells.length >= 2 && isTableRule(lines[i + 1], headCells.length)) {
        const tableWrap = el(doc, 'div', 'md-table-wrap');
        const table = el(doc, 'table', 'md-table');
        const thead = doc.createElement('thead');
        const trHead = doc.createElement('tr');
        for (const cell of headCells) {
          const th = doc.createElement('th');
          appendInline(th, cell, opts, doc);
          trHead.append(th);
        }
        thead.append(trHead);
        table.append(thead);
        i += 2;
        const tbody = doc.createElement('tbody');
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const rowCells = splitTableCells(lines[i]);
          const tr = doc.createElement('tr');
          for (let c = 0; c < headCells.length; c++) {
            const td = doc.createElement('td');
            appendInline(td, rowCells[c] ?? '', opts, doc);
            tr.append(td);
          }
          tbody.append(tr);
          i++;
        }
        table.append(tbody);
        tableWrap.append(table);
        frag.append(tableWrap);
        continue;
      }
    }

    // Blockquote
    if (/^ {0,3}>\s?/.test(line)) {
      const qLines = [];
      while (i < lines.length && /^ {0,3}>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i++;
      }
      const bq = el(doc, 'blockquote', 'md-quote');
      appendLines(bq, qLines, opts, doc);
      frag.append(bq);
      continue;
    }

    // Unordered or ordered list
    const ulMatch = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const olMatch = !ulMatch ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line) : null;
    if (ulMatch || olMatch) {
      const ordered = Boolean(olMatch);
      const list = el(doc, ordered ? 'ol' : 'ul', 'md-list');
      if (ordered && Number(olMatch[2]) !== 1) list.setAttribute('start', olMatch[2]);
      while (i < lines.length) {
        const mItem = ordered
          ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i])
          : /^(\s*)([-*+])\s+(.*)$/.exec(lines[i]);
        if (!mItem) break;
        const li = doc.createElement('li');
        appendInline(li, mItem[3], opts, doc);
        list.append(li);
        i++;
      }
      frag.append(list);
      continue;
    }

    // Paragraph: gather consecutive plain lines until a blank line or block starter
    const pLines = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) break;
      if (/^ {0,3}(`{3,}|~{3,}|#{1,4}\s|>\s?|[-*+]\s|\d+[.)]\s|([-*_])(?:\s*\2){2,}\s*$)/.test(next)) break;
      if (next.includes('|') && i + 1 < lines.length) {
        const hc = splitTableCells(next);
        if (hc.length >= 2 && isTableRule(lines[i + 1], hc.length)) break;
      }
      pLines.push(next);
      i++;
    }
    const p = el(doc, 'p', 'md-p');
    appendLines(p, pLines, opts, doc);
    frag.append(p);
  }

  return frag;
}
