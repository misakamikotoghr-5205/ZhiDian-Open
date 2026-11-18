// "一键排版" for a Word document: one consistent, themed layout for the whole file,
// without touching the words, tables or pictures. The result is a new .docx; the original is
// never modified.
//
// The layout starts with conventional Chinese report typography, then applies the chosen
// business, clean or warm palette, heading fonts and alternating table backgrounds:
//   body      宋体 / Times New Roman 小四 (12 pt), 1.5 line spacing, first line indented two
//             characters, justified, no gaps made of empty paragraphs or leading spaces
//   headings  黑体: level 1 三号 (16 pt), level 2 小三 (15 pt), level 3 四号 (14 pt), no indent.
//             Paragraphs that are numbered like headings ("一、", "（一）", "第一章", a short
//             "1. xxx") become real headings, so Word's outline and table of contents work
//   title     a short first paragraph is treated as the title: 黑体 二号 (22 pt), centred
//   page      A4, margins 2.54 cm top and bottom, 3.17 cm left and right
// Direct formatting scattered over the text (fonts, sizes, colours, highlights) is removed so
// the styles above actually show; bold, italic, underline and super/subscript are kept.
//
// A .docx is a zip of XML files. Only word/styles.xml and word/document.xml are rewritten, with
// an XML parser, never with string surgery.
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { documentTheme } from '../../core/document-themes.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const BODY_FONT = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体', cs: 'Times New Roman' };
const HEAD_FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: '黑体', cs: 'Arial' };
const HEAD_SIZE = { 0: 44, 1: 32, 2: 30, 3: 28 }; // half-points
const BODY_SIZE = 24;

const kids = (node, name) => Array.from(node?.childNodes ?? []).filter((n) => n.nodeType === 1 && (!name || n.localName === name) && n.namespaceURI === W);
const kid = (node, name) => kids(node, name)[0] ?? null;
const all = (node, name) => Array.from(node.getElementsByTagNameNS(W, name));
const attr = (node, name) => node?.getAttributeNS(W, name) ?? node?.getAttribute?.('w:' + name) ?? '';

function make(doc, name, attrs = {}) {
  const node = doc.createElementNS(W, 'w:' + name);
  for (const [k, v] of Object.entries(attrs)) node.setAttributeNS(W, 'w:' + k, String(v));
  return node;
}

/** Get or create child `name` of `parent`; new children go first (schema order matters to Word). */
function ensure(doc, parent, name, { first = false } = {}) {
  let node = kid(parent, name);
  if (!node) {
    node = make(doc, name);
    if (first && parent.firstChild) parent.insertBefore(node, parent.firstChild);
    else parent.appendChild(node);
  }
  return node;
}

function drop(parent, ...names) {
  let n = 0;
  for (const name of names) for (const node of kids(parent, name)) {
    parent.removeChild(node);
    n++;
  }
  return n;
}

/** Replace child `name` (schema position: before the first of `before` that exists, else at the end). */
function put(doc, parent, name, attrs, before = []) {
  drop(parent, name);
  const node = make(doc, name, attrs);
  const anchor = before.map((b) => kid(parent, b)).find(Boolean) ?? null;
  parent.insertBefore(node, anchor);
  return node;
}

// The child order the schema wants inside w:pPr and w:rPr, for the elements written here.
const AFTER_SPACING = ['ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const AFTER_IND = AFTER_SPACING.slice(1);
const AFTER_JC = AFTER_SPACING.slice(AFTER_SPACING.indexOf('jc') + 1);
const AFTER_FONTS = ['b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'];
const AFTER_B = AFTER_FONTS.slice(AFTER_FONTS.indexOf('bCs'));
const AFTER_SZ = AFTER_FONTS.slice(AFTER_FONTS.indexOf('szCs'));
const AFTER_SZCS = AFTER_FONTS.slice(AFTER_FONTS.indexOf('highlight'));

function setRunLook(doc, rPr, { font, size, bold }) {
  put(doc, rPr, 'rFonts', font, AFTER_FONTS);
  if (bold !== undefined) {
    drop(rPr, 'b', 'bCs');
    if (bold) rPr.insertBefore(make(doc, 'b'), AFTER_B.map((b) => kid(rPr, b)).find(Boolean) ?? null);
  }
  put(doc, rPr, 'sz', { val: size }, AFTER_SZ);
  put(doc, rPr, 'szCs', { val: size }, AFTER_SZCS);
}

function setParaLook(doc, pPr, { indent, align, before = 0, after = 0, line = 360 }) {
  put(doc, pPr, 'spacing', { before, after, line, lineRule: 'auto' }, AFTER_SPACING);
  put(doc, pPr, 'ind', indent ? { firstLineChars: 200, firstLine: 480 } : { firstLineChars: 0, firstLine: 0 }, AFTER_IND);
  if (align) put(doc, pPr, 'jc', { val: align }, AFTER_JC);
}

const nearest = (node, name) => {
  for (let n = node.parentNode; n; n = n.parentNode) if (n.nodeType === 1 && n.localName === name && n.namespaceURI === W) return n;
  return null;
};
const inside = (node, name) => Boolean(nearest(node, name));
const own = (p, name) => all(p, name).filter((n) => nearest(n, 'p') === p);
const paraText = (p) => own(p, 't').map((t) => t.textContent).join('');
const hasObject = (p) => ['drawing', 'pict', 'object', 'sectPr', 'fldChar', 'bookmarkStart', 'commentReference', 'footnoteReference', 'endnoteReference'].some((n) => own(p, n).length) || own(p, 'br').some((b) => attr(b, 'type') === 'page');

/** Does this paragraph read like a heading although it is not styled as one? Returns 1-3 or 0. */
export function headingLevelOf(text) {
  const t = text.trim();
  if (!t || [...t].length > 40) return 0;
  if (/^第[一二三四五六七八九十百零〇\d]+[章节篇部分]/.test(t)) return 1;
  if (/^[一二三四五六七八九十]{1,3}[、．.]\s*\S/.test(t) && !/[。；;！？!?]$/.test(t)) return 1;
  if (/^[（(][一二三四五六七八九十]{1,3}[)）]\s*\S/.test(t) && !/[。；;！？!?]$/.test(t)) return 2;
  if (/^\d{1,2}[.．、]\s*\S/.test(t) && [...t].length <= 24 && !/[。；;，,：:！？!?]$/.test(t)) return 3;
  if (/^\d{1,2}\.\d{1,2}(\.\d{1,2})?\s+\S/.test(t) && !/[。；;！？!?]$/.test(t)) return /^\d+\.\d+\.\d+/.test(t) ? 3 : 2;
  return 0;
}

function restyleStyles(doc) {
  const root = doc.documentElement;
  // Document defaults.
  const defaults = ensure(doc, root, 'docDefaults', { first: true });
  const rPrDefault = ensure(doc, defaults, 'rPrDefault', { first: true });
  setRunLook(doc, ensure(doc, rPrDefault, 'rPr'), { font: BODY_FONT, size: BODY_SIZE });

  const styles = kids(root, 'style').filter((s) => attr(s, 'type') === 'paragraph');
  const nameOf = (s) => attr(kid(s, 'name'), 'val');
  const levelOf = (s) => {
    const m = /^(?:heading|标题)\s*(\d)$/i.exec(nameOf(s));
    return m ? Number(m[1]) : null;
  };

  // The default paragraph style ("Normal" / "正文").
  let normal = styles.find((s) => attr(s, 'default') === '1' || attr(s, 'default') === 'true') ?? styles.find((s) => /^(normal|正文)$/i.test(nameOf(s)));
  if (!normal) {
    normal = make(doc, 'style', { type: 'paragraph', default: '1', styleId: 'Normal' });
    normal.appendChild(make(doc, 'name', { val: 'Normal' }));
    root.appendChild(normal);
  }
  const normalId = attr(normal, 'styleId');
  setParaLook(doc, ensure(doc, normal, 'pPr'), { indent: true, align: 'both' });
  setRunLook(doc, ensure(doc, normal, 'rPr'), { font: BODY_FONT, size: BODY_SIZE });

  // Headings 1-3: restyle the existing ones, add any that are missing.
  const headingIds = {};
  for (let level = 1; level <= 3; level++) {
    let style = styles.find((s) => levelOf(s) === level);
    if (!style) {
      const used = new Set(kids(root, 'style').map((s) => attr(s, 'styleId')));
      let id = `Heading${level}`;
      while (used.has(id)) id += 'x';
      style = make(doc, 'style', { type: 'paragraph', styleId: id });
      style.appendChild(make(doc, 'name', { val: `heading ${level}` }));
      style.appendChild(make(doc, 'basedOn', { val: normalId }));
      style.appendChild(make(doc, 'next', { val: normalId }));
      style.appendChild(make(doc, 'qFormat'));
      root.appendChild(style);
    }
    headingIds[level] = attr(style, 'styleId');
    // Word wants pPr before rPr inside a style, and both after the name/basedOn/... elements.
    drop(style, 'pPr', 'rPr');
    const pPr = make(doc, 'pPr');
    pPr.appendChild(make(doc, 'keepNext'));
    pPr.appendChild(make(doc, 'keepLines'));
    style.appendChild(pPr);
    setParaLook(doc, pPr, { indent: false, align: 'left', before: level === 1 ? 312 : 156, after: 156 });
    pPr.appendChild(make(doc, 'outlineLvl', { val: level - 1 }));
    const rPr = make(doc, 'rPr');
    style.appendChild(rPr);
    setRunLook(doc, rPr, { font: HEAD_FONT, size: HEAD_SIZE[level], bold: true });
  }
  const styleLevels = {};
  for (const s of kids(root, 'style')) {
    const level = attr(s, 'type') === 'paragraph' ? levelOf(s) : null;
    if (level) styleLevels[attr(s, 'styleId')] = level;
    if (/^(title|标题)$/i.test(nameOf(s))) styleLevels[attr(s, 'styleId')] = 0;
  }
  return { headingIds, styleLevels, normalId };
}

function cleanRuns(doc, p, counts, { keepBold = true } = {}) {
  for (const rPr of own(p, 'rPr')) {
    if (rPr.parentNode?.localName !== 'r' && rPr.parentNode?.localName !== 'pPr') continue;
    const removed = drop(rPr, 'rFonts', 'sz', 'szCs', 'color', 'highlight', 'shd', 'spacing', 'w', 'kern', 'position', 'snapToGrid', 'eastAsianLayout', ...(keepBold ? [] : ['b', 'bCs']));
    if (removed) counts.runs++;
  }
}

function restyleBody(doc, { headingIds, styleLevels }) {
  const counts = { paragraphs: 0, headings: 0, title: 0, empty: 0, runs: 0, tables: 0 };
  const body = kid(doc.documentElement, 'body');
  if (!body) return counts;

  // Empty top-level paragraphs used as vertical spacing go away (spacing is in the styles now).
  for (const p of kids(body, 'p')) {
    if (paraText(p).trim() === '' && !hasObject(p) && kid(p, 'pPr') && kid(kid(p, 'pPr'), 'sectPr')) continue;
    if (paraText(p).trim() === '' && !hasObject(p)) {
      body.removeChild(p);
      counts.empty++;
    }
  }

  const top = kids(body, 'p');
  const firstText = top.find((p) => paraText(p).trim() !== '');
  for (const p of all(body, 'p')) {
    const text = paraText(p);
    const inTable = inside(p, 'tc');
    const inBox = inside(p, 'txbxContent');
    const pPr = ensure(doc, p, 'pPr', { first: true });
    const styleId = attr(kid(pPr, 'pStyle'), 'val');
    const jc = attr(kid(pPr, 'jc'), 'val');
    const numbered = Boolean(kid(pPr, 'numPr'));
    let level = styleLevels[styleId];

    // Hand-made indents: leading spaces, full-width spaces and tabs at the start of the text.
    if (!inTable && !inBox) {
      const firstRun = kids(p, 'r')[0];
      if (firstRun) for (const tab of kids(firstRun, 'tab')) if (!tab.previousSibling || tab.previousSibling.localName === 'rPr') firstRun.removeChild(tab);
      // The spaces may be spread over several runs: strip until the first real character or inline object.
      outer: for (const r of own(p, 'r')) {
        if (['drawing', 'pict', 'object', 'fldChar', 'br'].some((n) => kids(r, n).length)) break;
        for (const t of kids(r, 't')) {
          t.textContent = t.textContent.replace(/^[\s　]+/, '');
          if (t.textContent) break outer;
        }
      }
    }

    if (inBox) {
      cleanRuns(doc, p, counts);
      continue;
    }
    if (inTable) {
      // Table cells: body font, single spacing, no first-line indent; alignment as it was.
      drop(pPr, 'spacing', 'ind', 'snapToGrid');
      put(doc, pPr, 'spacing', { before: 0, after: 0, line: 300, lineRule: 'auto' }, AFTER_SPACING);
      put(doc, pPr, 'ind', { firstLineChars: 0, firstLine: 0 }, AFTER_IND);
      cleanRuns(doc, p, counts);
      continue;
    }

    const isTitle = p === firstText && level === undefined && !numbered && [...text.trim()].length <= 40 && !/[。；;，,！？!?]$/.test(text.trim()) && top.filter((x) => paraText(x).trim()).length > 1 && !headingLevelOf(text);
    if (level === undefined && !numbered && !isTitle) level = headingLevelOf(text) || undefined;

    if (isTitle || level === 0) {
      drop(pPr, 'spacing', 'ind', 'jc', 'snapToGrid');
      setParaLook(doc, pPr, { indent: false, align: 'center', before: 0, after: 312, line: 360 });
      cleanRuns(doc, p, counts, { keepBold: false });
      for (const r of own(p, 'r')) setRunLook(doc, ensure(doc, r, 'rPr', { first: true }), { font: HEAD_FONT, size: HEAD_SIZE[0], bold: true });
      counts.title++;
    } else if (level >= 1 && level <= 3) {
      // A real heading: the style carries the look, nothing direct stays on the paragraph.
      drop(pPr, 'spacing', 'ind', 'jc', 'snapToGrid', 'pStyle');
      pPr.insertBefore(make(doc, 'pStyle', { val: headingIds[level] }), pPr.firstChild);
      cleanRuns(doc, p, counts, { keepBold: false });
      counts.headings++;
    } else {
      // Body text. Centred or right-aligned lines (captions, signatures, dates) keep their
      // alignment and lose the first-line indent; everything else follows the body style.
      const keep = jc === 'center' || jc === 'right' || jc === 'end';
      drop(pPr, 'spacing', 'snapToGrid', 'ind', ...(keep ? [] : ['jc']));
      if (keep || hasObject(p)) put(doc, pPr, 'ind', { firstLineChars: 0, firstLine: 0 }, AFTER_IND);
      cleanRuns(doc, p, counts);
      counts.paragraphs++;
    }
  }
  counts.tables = all(body, 'tbl').length;

  // Page: A4 with the standard margins, orientation kept.
  for (const sect of all(body, 'sectPr')) {
    const size = kid(sect, 'pgSz');
    const landscape = attr(size, 'orient') === 'landscape' || Number(attr(size, 'w')) > Number(attr(size, 'h'));
    put(doc, sect, 'pgSz', landscape ? { w: 16838, h: 11906, orient: 'landscape' } : { w: 11906, h: 16838 }, ['pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange']);
    const old = kid(sect, 'pgMar');
    put(doc, sect, 'pgMar', { top: 1440, right: 1800, bottom: 1440, left: 1800, header: attr(old, 'header') || 851, footer: attr(old, 'footer') || 992, gutter: 0 }, ['paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange']);
  }
  return counts;
}

/**
 * @param {Buffer|Uint8Array} input  the .docx file
 * @returns {Promise<{ buffer: Buffer, counts: object }>}
 */
export async function restyleDocx(input, { template } = {}) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    if (bytes?.[0] === 0xd0 && bytes?.[1] === 0xcf && bytes?.[2] === 0x11 && bytes?.[3] === 0xe0) {
      throw new Error('打不开这个 Word 文档：它加了打开密码，或者其实是旧版的 .doc 文件');
    }
    throw new Error('打不开这个 Word 文档：文件是空的或已损坏');
  }
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('这不是一个有效的 Word 文档（缺少 word/document.xml）');
  const parser = new DOMParser({ onError: () => {} });
  const serializer = new XMLSerializer();
  const document = parser.parseFromString(await docFile.async('string'), 'text/xml');
  if (!document?.documentElement || !kid(document.documentElement, 'body')) {
    throw new Error('打不开这个 Word 文档：文件已损坏');
  }
  const stylesFile = zip.file('word/styles.xml');
  const stylesXml = stylesFile
    ? await stylesFile.async('string')
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}"></w:styles>`;
  const styles = parser.parseFromString(stylesXml, 'text/xml');
  if (!styles?.documentElement) throw new Error('打不开这个 Word 文档：样式表已损坏');

  const info = restyleStyles(styles);
  const counts = restyleBody(document, info);
  applyDocumentTheme(styles, document, documentTheme(template));

  zip.file('word/styles.xml', serializer.serializeToString(styles));
  zip.file('word/document.xml', serializer.serializeToString(document));
  if (!stylesFile) {
    // A document without a styles part: register the new one via DOM (works even on self-closing <Types/> or <Relationships/>).
    const types = zip.file('[Content_Types].xml');
    if (types) {
      const typesDoc = parser.parseFromString(await types.async('string'), 'text/xml');
      const typesRoot = typesDoc?.documentElement;
      if (typesRoot) {
        const hasOverride = Array.from(typesRoot.getElementsByTagName('Override')).some((el) => el.getAttribute('PartName') === '/word/styles.xml');
        if (!hasOverride) {
          const el = typesDoc.createElementNS(typesRoot.namespaceURI || 'http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
          el.setAttribute('PartName', '/word/styles.xml');
          el.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml');
          typesRoot.appendChild(el);
          zip.file('[Content_Types].xml', serializer.serializeToString(typesDoc));
        }
      }
    }
    const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const rels = zip.file('word/_rels/document.xml.rels');
    const relXml = rels ? await rels.async('string') : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${relNs}"></Relationships>`;
    const relDoc = parser.parseFromString(relXml, 'text/xml');
    const relRoot = relDoc?.documentElement;
    if (relRoot) {
      const existing = Array.from(relRoot.getElementsByTagName('Relationship'));
      const hasStyles = existing.some((el) => (el.getAttribute('Target') ?? '').endsWith('styles.xml'));
      if (!hasStyles) {
        const ids = new Set(existing.map((el) => el.getAttribute('Id')));
        let id = 'rIdZhidianStyles';
        for (let k = 2; ids.has(id); k++) id = `rIdZhidianStyles${k}`;
        const el = relDoc.createElementNS(relRoot.namespaceURI || relNs, 'Relationship');
        el.setAttribute('Id', id);
        el.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles');
        el.setAttribute('Target', 'styles.xml');
        relRoot.appendChild(el);
        zip.file('word/_rels/document.xml.rels', serializer.serializeToString(relDoc));
      }
    }
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, counts };
}

export function describeRestyle(c, { template } = {}) {
  const parts = [`正文 ${c.paragraphs} 段`];
  if (c.title) parts.push('1 个标题');
  if (c.headings) parts.push(`${c.headings} 个小标题`);
  if (c.tables) parts.push(`${c.tables} 个表格`);
  if (c.empty) parts.push(`去掉 ${c.empty} 个空行`);
  return `已按“${documentTheme(template).label}”模板统一版式：${parts.join('，')}。正文小四、1.5 倍行距；标题分级、表格首行强调并交替底色。原文件没有改动。`;
}

/** Apply visual hierarchy without changing text, relationships, tables or embedded objects. */
function applyDocumentTheme(styles, document, theme) {
  for (const style of kids(styles.documentElement, 'style')) {
    if (attr(style, 'type') !== 'paragraph') continue;
    const styleName = attr(kid(style, 'name'), 'val');
    const heading = /^(heading|标题)\s*\d$/i.test(styleName);
    const normal = attr(style, 'default') === '1' || /^(normal|正文)$/i.test(styleName);
    if (!heading && !normal) continue;
    const rPr = ensure(styles, style, 'rPr');
    put(styles, rPr, 'color', { val: heading ? theme.accent : theme.ink }, ['spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u']);
    put(styles, rPr, 'rFonts', { ascii: theme.serif && !heading ? 'Georgia' : 'Arial', hAnsi: theme.serif && !heading ? 'Georgia' : 'Arial', eastAsia: heading ? HEAD_FONT.eastAsia : theme.bodyFont }, AFTER_FONTS);
  }
  // The main title has direct formatting; its accent should match the headings.
  for (const rPr of all(document, 'rPr')) {
    if (attr(kid(rPr, 'sz'), 'val') === String(HEAD_SIZE[0])) put(document, rPr, 'color', { val: theme.accent }, ['spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u']);
  }
  for (const table of all(document, 'tbl')) {
    const tablePr = ensure(document, table, 'tblPr', { first: true });
    const borders = ensure(document, tablePr, 'tblBorders');
    for (const edge of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
      put(document, borders, edge, { val: 'single', sz: edge === 'insideV' ? 0 : 4, color: theme.line });
    }
    for (const [rowIndex, row] of kids(table, 'tr').entries()) {
      if (!rowIndex) ensure(document, ensure(document, row, 'trPr', { first: true }), 'tblHeader');
      for (const cell of kids(row, 'tc')) {
        const cellPr = ensure(document, cell, 'tcPr', { first: true });
        put(document, cellPr, 'shd', { val: 'clear', color: 'auto', fill: rowIndex === 0 ? theme.accent : rowIndex % 2 === 0 ? theme.surface : theme.paper }, ['noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark']);
        if (rowIndex === 0) for (const run of all(cell, 'r')) {
          const rPr = ensure(document, run, 'rPr', { first: true });
          put(document, rPr, 'color', { val: 'FFFFFF' }, ['spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u']);
          if (!kid(rPr, 'b')) rPr.insertBefore(make(document, 'b'), AFTER_B.map((name) => kid(rPr, name)).find(Boolean) ?? null);
        }
      }
    }
  }
}
