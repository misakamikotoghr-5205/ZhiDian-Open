// Tables as rows of text: CSV in and out, the cells of an Excel workbook (.xlsx) in and out,
// and a table as Markdown. Pure: strings and buffers go in and come out; no Electron and no
// files, so everything here runs under plain Node.
//
// What is written for Excel is values only. Text that merely looks like a number ("007", a
// phone number, an 18-digit ID) stays text, so no zero is dropped and no digit is rounded,
// which is what happens to such columns when a CSV is opened in a spreadsheet directly.
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { documentTheme } from '../../core/document-themes.js';

// What one sheet of an Excel workbook can hold.
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;
export const MAX_CELL_CHARS = 32_767;

const empty = (v) => v === '' || v == null;

// ---------------------------------------------------------------- CSV

const DELIMITERS = [',', '\t', ';'];
// "sep=;" on a line of its own at the top is how a file tells Excel what separates its fields.
const SEP_LINE = /^sep=([^\r\n"])(?:\r\n?|\n|$)/i;

/** Records of `src` split at `d`, at most `limit` of them. Quotes as in RFC 4180. */
function records(src, d, limit = Infinity) {
  const rows = [];
  const dc = d.charCodeAt(0);
  const n = src.length;
  let row = [];
  let i = 0;
  let open = false; // a record has begun and is not yet in `rows`
  while (i < n && rows.length < limit) {
    let field = '';
    if (src.charCodeAt(i) === 34) {
      // A quoted field: everything up to the closing quote, "" standing for one quote.
      let j = i + 1;
      for (;;) {
        const q = src.indexOf('"', j);
        if (q < 0) {
          // Never closed: the rest of the text is the field.
          field += src.slice(j);
          j = n;
          break;
        }
        field += src.slice(j, q);
        if (src.charCodeAt(q + 1) !== 34) {
          j = q + 1;
          break;
        }
        field += '"';
        j = q + 2;
      }
      i = j;
    }
    // The plain part of a field (after a closing quote: whatever is left before the delimiter).
    let k = i;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === dc || c === 10 || c === 13) break;
      k++;
    }
    if (k > i) field += src.slice(i, k);
    row.push(field);
    open = true;
    i = k;
    if (i >= n) break;
    const c = src.charCodeAt(i);
    if (c === dc) {
      i++;
      if (i >= n) row.push(''); // the text ends with a delimiter: one more, empty, field
      continue;
    }
    i += c === 13 && src.charCodeAt(i + 1) === 10 ? 2 : 1;
    rows.push(row);
    row = [];
    open = false;
  }
  if (open && rows.length < limit) rows.push(row);
  return rows;
}

/** Comma, tab or semicolon: the one that cuts the first lines into the same number of fields. */
function sniff(src) {
  const sample = src.length > 65_536 ? src.slice(0, 65_536) : src;
  let best = ',';
  let bestShare = 0;
  for (const d of DELIMITERS) {
    const rows = records(sample, d, 100);
    if (sample.length < src.length && rows.length > 1) rows.pop(); // cut off in the middle
    const seen = new Map();
    for (const r of rows) if (r.length > 1) seen.set(r.length, (seen.get(r.length) ?? 0) + 1);
    const share = Math.max(0, ...seen.values());
    // On a tie the earlier candidate stays: a comma file whose cells end in a tab (some bank
    // and payment exports do that to keep long numbers as text) is still a comma file.
    if (share > bestShare) {
      best = d;
      bestShare = share;
    }
  }
  return best;
}

const withoutMark = (text) => {
  const src = String(text ?? '');
  return src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
};

/** The delimiter a piece of CSV text uses: what its "sep=" line says, or what its lines show. */
export function detectDelimiter(text) {
  const src = withoutMark(text);
  const sep = SEP_LINE.exec(src);
  return sep ? sep[1] : sniff(src);
}

/**
 * CSV text as rows of fields. Quoted fields may hold delimiters, line breaks and doubled
 * quotes (RFC 4180); lines end in CRLF, LF or CR; the line break at the very end starts no
 * extra row. An empty line is a row with one empty field. Rows are as long as their own line.
 * @param {string} text
 * @param {string} [delimiter]  one character; found by detectDelimiter() when not given
 * @returns {string[][]}
 */
export function parseCsv(text, delimiter) {
  let src = withoutMark(text);
  const sep = SEP_LINE.exec(src);
  const d = delimiter ?? (sep ? sep[1] : sniff(src));
  if (typeof d !== 'string' || d.length !== 1 || d === '"' || d === '\n' || d === '\r') throw new TypeError('a delimiter is one character, and not a quote or a line break');
  if (sep && sep[1] === d) src = src.slice(sep[0].length); // that line is not data
  return records(src, d);
}

/**
 * Rows as CSV text: CRLF after every row, quotes only around fields that need them.
 * @param {Array<Array<string | number | null | undefined>>} rows
 * @param {{ delimiter?: string, bom?: boolean, width?: number }} [o]
 *   bom: start with a UTF-8 mark, which is what makes Excel read the file as UTF-8 (without
 *   it Chinese comes out garbled there); width: write every row with this many fields
 */
export function toCsv(rows, { delimiter = ',', bom = false, width } = {}) {
  const lines = new Array(rows.length);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const n = width ?? row.length;
    let line = '';
    for (let c = 0; c < n; c++) {
      const v = row[c];
      const s = v == null ? '' : String(v);
      if (c) line += delimiter;
      // A file whose first two letters are "ID" is taken by Excel for a SYLK file and
      // refused: in quotes it is a CSV again.
      const quoted = s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') || (r === 0 && c === 0 && s.startsWith('ID'));
      line += quoted ? `"${s.replace(/"/g, '""')}"` : s;
    }
    lines[r] = line + '\r\n';
  }
  return (bom ? '\ufeff' : '') + lines.join('');
}

// ---------------------------------------------------------------- tables

/**
 * How far a table really goes: its rows without the empty ones at the end (the same row
 * lists, none copied), and `cols`, how many columns there are up to the last one that holds
 * something. Empty rows and columns in the middle count.
 * @returns {{ rows: Array<Array<string | number>>, cols: number }}
 */
export function fitTable(rows) {
  let end = rows.length;
  while (end && rows[end - 1].every(empty)) end--;
  let cols = 0;
  for (let r = 0; r < end; r++) {
    const row = rows[r];
    let w = row.length;
    while (w > cols && empty(row[w - 1])) w--;
    if (w > cols) cols = w;
  }
  return { rows: end === rows.length ? rows : rows.slice(0, end), cols };
}

const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DIGITS_ONLY = /^-?\d+(?:\.\d+)?$/;
const edgeSpace = /^[ \t]+|[ \t]+$/g;

/**
 * The number a cell holds, if it is written as a plain number: digits, perhaps a minus and a
 * decimal point, at most 15 digits (what a spreadsheet keeps exactly), and no zeros in front.
 * "007", "+8613800138000", "1e5", "1,234" and an 18-digit ID are not: they are text.
 * @returns {number | null}
 */
export function plainNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 40) return null;
  const t = value.replace(edgeSpace, '');
  if (!PLAIN_NUMBER.test(t) || t.replace(/[-.]/g, '').length > 15) return null;
  return Number(t);
}

/**
 * How the cells of a table will be written: `numbers` as numbers, and `kept` that are all
 * digits yet stay text because of their zeros in front or their length.
 */
export function numberStats(rows) {
  let numbers = 0;
  let kept = 0;
  for (const row of rows) {
    for (const v of row) {
      if (empty(v)) continue;
      if (plainNumber(v) !== null) numbers++;
      else if (typeof v === 'string' && v.length <= 60 && DIGITS_ONLY.test(v.replace(edgeSpace, ''))) kept++;
    }
  }
  return { numbers, kept };
}

/**
 * The same rows with no cell longer than Excel takes (32767 characters).
 * @returns {{ rows: Array<Array<string | number>>, clipped: number }}  clipped: how many were cut
 */
export function clipCells(rows) {
  let clipped = 0;
  const out = rows.map((row) => {
    if (!row.some((v) => typeof v === 'string' && v.length > MAX_CELL_CHARS)) return row;
    return row.map((v) => {
      if (typeof v !== 'string' || v.length <= MAX_CELL_CHARS) return v;
      clipped++;
      // Not in the middle of a character that takes two units.
      const cut = v.charCodeAt(MAX_CELL_CHARS - 1) >= 0xd800 && v.charCodeAt(MAX_CELL_CHARS - 1) <= 0xdbff ? MAX_CELL_CHARS - 1 : MAX_CELL_CHARS;
      return v.slice(0, cut);
    });
  });
  return { rows: out, clipped };
}

const isWide = (c) =>
  c >= 0x1100 &&
  (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0xd800 && c <= 0xdbff));

/**
 * How wide a text is on screen, in the width of a digit: Chinese, Japanese and Korean
 * characters, full-width forms and emoji take two. For several lines: the longest of them.
 */
export function displayWidth(text) {
  const s = String(text ?? '');
  let widest = 0;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10) {
      if (w > widest) widest = w;
      w = 0;
    } else if (c >= 0xdc00 && c <= 0xdfff) continue; // the second half of a character already counted
    else w += isWide(c) ? 2 : 1;
  }
  return Math.max(widest, w);
}

/** A string cut to `max` UTF-16 units, never through the middle of a character. */
function cutTo(s, max) {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/**
 * Names Excel accepts for the sheets of one workbook: at most 31 characters, none of
 * \ / ? * [ ] :, no apostrophe at either end, not empty, and no two alike (Excel does not
 * tell capitals from small letters). Square brackets become round ones, the other forbidden
 * characters an underscore; a name that is taken gets " (2)", " (3)" ...
 * @param {string[]} names
 * @returns {string[]}
 */
export function sheetNames(names) {
  const taken = new Set();
  return names.map((raw, i) => {
    let base = String(raw ?? '')
      .replace(UNFIT, '')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/[\\/?*:\u0000-\u001f\ufffe\uffff]/g, '_')
      .replace(/^[\s']+|[\s']+$/g, '');
    if (!base) base = `Sheet${i + 1}`;
    if (base.toLowerCase() === 'history') base += '_'; // a name Excel keeps for itself
    let name = cutTo(base, 31).replace(/[\s']+$/, '');
    for (let k = 2; taken.has(name.toLowerCase()); k++) {
      const tail = ` (${k})`;
      name = cutTo(base, 31 - tail.length).replace(/[\s']+$/, '') + tail;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

// ---------------------------------------------------------------- writing .xlsx

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const WIDTH_MIN = 6; // of a column, in digits
const WIDTH_MAX = 60;
const WIDTH_PAD = 2;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
// Characters XML cannot carry: control characters and halves of a broken pair.
const UNFIT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const hex4 = (c) => c.toString(16).toUpperCase().padStart(4, '0');

/**
 * Cell text for the inside of a <t>. A line break inside a cell is a line feed in Excel;
 * control characters are written the way Excel writes them (_x0001_), and text that happens
 * to look like such an escape is guarded so that it is read back as itself.
 */
function xmlText(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/_(?=x[0-9A-Fa-f]{4}_)/g, '_x005F_')
    .replace(UNFIT, (ch) => (ch.charCodeAt(0) < 0x20 ? `_x${hex4(ch.charCodeAt(0))}_` : '\ufffd'))
    .replace(/[&<>]/g, (ch) => ESCAPES[ch]);
}
const xmlAttr = (s) => String(s).replace(UNFIT, '').replace(/[&<>"]/g, (ch) => ESCAPES[ch]);

const colNames = [];
/** 0 -> A, 25 -> Z, 26 -> AA ... */
function colName(index) {
  if (colNames[index]) return colNames[index];
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  colNames[index] = name;
  return name;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Cell formats, by their place in <cellXfs>: +1 bold (the first row), +2 wraps (text with line
// breaks), 4 and 5 show every digit of a long whole number (Excel's general format shows
// twelve digits and more as 1.23457E+11).
const STYLES = `<styleSheet xmlns="${NS_MAIN}">
<fonts count="2"><font><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font><font><b/><sz val="11"/><name val="等线"/><family val="2"/><charset val="134"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function workbookStyles(template) {
  if (!template) return STYLES;
  const theme = documentTheme(template);
  return STYLES
    .replace('<font><sz', `<font><color rgb="FF${theme.ink}"/><sz`)
    .replace('<font><b/>', '<font><b/><color rgb="FFFFFFFF"/>')
    .replace('<fills count="2">', '<fills count="3">')
    .replace('</fills>', `<fill><patternFill patternType="solid"><fgColor rgb="FF${theme.accent}"/><bgColor indexed="64"/></patternFill></fill></fills>`)
    .replaceAll('fontId="1" fillId="0"', 'fontId="1" fillId="2" applyFill="1"')
    .replace('<bottom/>', `<bottom style="hair"><color rgb="FF${theme.line}"/></bottom>`);
}

/**
 * One sheet as XML, in UTF-8. (Put together as bytes a few thousand rows at a time: as one
 * string, a sheet of a million rows would not fit in memory next to the rows themselves.)
 * @returns {Promise<Buffer>}
 */
async function sheetXml(rows, selected, template) {
  if (rows.length > MAX_ROWS) throw new Error(`有 ${rows.length} 行，超过了 Excel 一张表最多 ${MAX_ROWS} 行的上限`);
  const widths = [];
  const chunks = [];
  let lines = [];
  let cols = 0;
  let last = 0; // the number of the last row that holds something
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const bold = r === 0 ? 1 : 0;
    let cells = '';
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (empty(v)) continue;
      if (c >= MAX_COLS) throw new Error(`第 ${r + 1} 行有 ${row.length} 列，超过了 Excel 一张表最多 ${MAX_COLS} 列的上限`);
      const ref = colName(c) + (r + 1);
      const number = plainNumber(v);
      let shown;
      if (number !== null) {
        shown = String(number);
        const style = bold + (Number.isInteger(number) && Math.abs(number) >= 1e11 ? 4 : 0);
        cells += `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${shown.replace('e', 'E')}</v></c>`;
      } else {
        shown = String(v);
        const style = bold + (shown.includes('\n') || shown.includes('\r') ? 2 : 0);
        const keep = /^\s|\s$|\s\s|[\n\t]/.test(shown) ? ' xml:space="preserve"' : '';
        cells += `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t${keep}>${xmlText(shown)}</t></is></c>`;
      }
      if ((widths[c] ?? 0) < WIDTH_MAX) widths[c] = Math.max(widths[c] ?? 0, displayWidth(shown));
      if (c >= cols) cols = c + 1;
    }
    if (cells) {
      const singleLineHeader = template && r === 0 && !row.some((v) => /[\r\n]/.test(String(v ?? '')));
      lines.push(`<row r="${r + 1}"${singleLineHeader ? ' ht="28" customHeight="1"' : ''}>${cells}</row>`);
      last = r + 1;
    }
    if (lines.length >= 5000) {
      chunks.push(Buffer.from(lines.join(''), 'utf8'));
      lines = [];
      await tick(); // a long table does not hold everything else up
    }
  }
  if (lines.length) chunks.push(Buffer.from(lines.join(''), 'utf8'));
  let colsXml = '';
  for (let c = 0; c < cols; c++) {
    if (!widths[c]) continue;
    const width = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, widths[c] + WIDTH_PAD));
    colsXml += `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`;
  }
  // The first row stays in view while the rest scrolls under it.
  const pane = rows.length ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '';
  const head =
    XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}">` +
    `<dimension ref="${last ? `A1:${colName(cols - 1)}${last}` : 'A1'}"/>` +
    `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ''}${template ? ' showGridLines="0"' : ''} workbookViewId="0">${pane}</sheetView></sheetViews>` +
    (colsXml ? `<cols>${colsXml}</cols>` : '') +
    (chunks.length ? '<sheetData>' : '<sheetData/>');
  const filter = template && last > 1 && cols > 0 ? `<autoFilter ref="A1:${colName(cols - 1)}${last}"/>` : '';
  return Buffer.concat([Buffer.from(head, 'utf8'), ...chunks, Buffer.from(`${chunks.length ? '</sheetData>' : ''}${filter}</worksheet>`, 'utf8')]);
}

/**
 * An Excel workbook holding these tables, values only. A cell that is a number, or text
 * written as a plain number (see plainNumber), becomes a number; everything else becomes
 * text exactly as it is. The first row of every sheet is bold and stays in view; columns are
 * as wide as what is in them, up to a limit. Sheet names are made valid (see sheetNames).
 * @param {Array<{ name: string, rows: Array<Array<string | number | null | undefined>> }>} sheets
 * @returns {Promise<Buffer>}
 */
export async function writeXlsx(sheets, { template } = {}) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('没有可以写进工作簿的表');
  const names = sheetNames(sheets.map((s) => s.name));
  const zip = new JSZip();
  // Parts only, no entries for the folders: that is all a package may hold.
  const put = (name, xml) => zip.file(name, XML_HEAD + xml, { createFolders: false });
  put(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${TYPE_SHEET}.sheet.main+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="${TYPE_SHEET}.styles+xml"/>` +
      names.map((_n, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${TYPE_SHEET}.worksheet+xml"/>`).join('') +
      '</Types>',
  );
  put('_rels/.rels', `<Relationships xmlns="${NS_PACKAGE_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put(
    'xl/workbook.xml',
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
      names.map((name, i) => `<sheet name="${xmlAttr(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  );
  put(
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="${NS_PACKAGE_REL}">` +
      names.map((_n, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${names.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  put('xl/styles.xml', workbookStyles(template));
  for (let i = 0; i < sheets.length; i++) zip.file(`xl/worksheets/sheet${i + 1}.xml`, await sheetXml(sheets[i].rows ?? [], i === 0, template), { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } });
}

// ---------------------------------------------------------------- reading .xlsx

const DAY = 86_400; // seconds
const LAST_DAY = 2_958_465; // 9999-12-31
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A date or time as Excel stores it (days since the end of 1899, the time of day as the
 * fraction) written out: "2024-03-05", "2024-03-05 14:30:00" when there is a time of day,
 * "14:30:00" when there is no day. To the second.
 * @param {number} serial
 * @param {{ date1904?: boolean, elapsed?: boolean }} [o]  date1904: the workbook counts from
 *   1904 (old Mac files); elapsed: a duration, written as hours:minutes:seconds ("30:00:00")
 * @returns {string | null}  null when the number is not a date Excel could show
 */
export function serialToText(serial, { date1904 = false, elapsed = false } = {}) {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const total = Math.round(serial * DAY);
  let days = Math.floor(total / DAY);
  const secs = total - days * DAY;
  const clock = `${pad2(Math.floor(secs / 3600))}:${pad2(Math.floor(secs / 60) % 60)}:${pad2(secs % 60)}`;
  if (elapsed) return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`;
  if (days === 0) return clock;
  if (date1904) days += 1462;
  if (days > LAST_DAY) return null;
  // Excel has a 29 February 1900, a day that never was: the days before it count from one
  // day later than all the days after it.
  const date = days === 60 ? '1900-02-29' : new Date(Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * DAY * 1000).toISOString().slice(0, 10);
  return secs ? `${date} ${clock}` : date;
}

/**
 * What kind of thing a number format shows: 'date' for dates and times of day (a format with
 * y, d, m, h or s in it, outside quotes and square brackets), 'elapsed' for durations
 * ("[h]:mm:ss"), null for everything else.
 * @returns {'date' | 'elapsed' | null}
 */
export function dateFormatKind(code) {
  const s = String(code ?? '');
  let pattern = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      // Quoted text is shown as it is.
      const close = s.indexOf('"', i + 1);
      i = close < 0 ? s.length : close;
    } else if (ch === '\\' || ch === '_' || ch === '*') i++; // an escaped character, a gap as wide as one, a filler
    else if (ch === '[') {
      const close = s.indexOf(']', i + 1);
      if (/^(?:h+|m+|s+)$/i.test(s.slice(i + 1, close < 0 ? s.length : close))) return 'elapsed';
      i = close < 0 ? s.length : close; // a colour, a condition, a currency or a locale
    } else if (ch === ';') break; // of the sections (positive;negative;zero;text) the first decides
    else pattern += ch;
  }
  if (/general/i.test(pattern)) return null;
  return /[ydmhs]/i.test(pattern) ? 'date' : null;
}

/** The same for a format that has a number of its own instead of a pattern. */
function builtInKind(id) {
  if (id === 46) return 'elapsed';
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) ? 'date' : null;
}

const plain15 = new Intl.NumberFormat('en-US', { useGrouping: false, maximumSignificantDigits: 15 });

/** A stored number as a person would write it: 0.30000000000000004 is 0.3, 1E-7 is 0.0000001. */
function numberText(v) {
  const t = v.trim();
  const n = Number(t);
  if (t === '' || !Number.isFinite(n)) return t;
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n === 0 ? 0 : n);
  return plain15.format(n);
}

const unescapeX = (s) => (s.includes('_x') ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16))) : s);

function parseXml(xml) {
  return new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml');
}
/** The child elements with this name, whatever their namespace prefix. */
function* kids(node, name) {
  for (let n = node?.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && n.localName === name) yield n;
}
const kid = (node, name) => kids(node, name).next().value ?? null;

/** The text of a string item: its own <t>, or the <t> of each of its runs. Not the phonetic guide. */
function stringOf(item) {
  let text = '';
  for (let n = item.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    if (n.localName === 't') text += n.textContent;
    else if (n.localName === 'r') for (const t of kids(n, 't')) text += t.textContent;
  }
  return text;
}

/** "BC12" -> 54: the column of a cell reference, counted from 0; -1 when there is none. */
function columnOf(ref) {
  let col = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i) & ~32; // either case
    if (c < 65 || c > 90) break;
    col = col * 26 + (c - 64);
  }
  return col - 1;
}

const dirOf = (part) => part.slice(0, part.lastIndexOf('/') + 1);
/** The part a relationship points at, from the part it is written for. */
function resolvePart(from, target) {
  const out = [];
  for (const piece of (target.startsWith('/') ? target : dirOf(from) + target).split('/')) {
    if (piece === '..') out.pop();
    else if (piece && piece !== '.') out.push(piece);
  }
  return out.join('/');
}
const relsOf = (part) => `${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;

function relationships(xml, from) {
  const list = [];
  if (!xml) return list;
  for (const el of kids(parseXml(xml).documentElement, 'Relationship')) {
    if (el.getAttribute('TargetMode') === 'External') continue;
    list.push({ id: el.getAttribute('Id') ?? '', type: el.getAttribute('Type') ?? '', part: resolvePart(from, el.getAttribute('Target') ?? '') });
  }
  return list;
}

const DAMAGED = '打不开这个 Excel 文件：文件不完整或已损坏';
const PIECE = 400_000; // characters of XML that are turned into a tree at a time, at most
const MAX_PART = 500 * 1024 * 1024; // bytes of one part, unpacked: just under the longest string there can be

/** Where the tag that starts at `from` ends (after its ">"), or -1. */
function tagEnd(xml, from) {
  let quote = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) quote = c;
    else if (c === 62) return i + 1;
  }
  return -1;
}

/**
 * Goes through the elements that make up the bulk of a large part: the rows of a sheet, the
 * strings of the string table. The XML parser needs some hundred times the room of the text
 * for its tree, and a quarter of a minute for a hundred thousand rows, so:
 *  - an element written the plain way every spreadsheet program writes them is read straight
 *    from the text by `plain`, which takes nothing but exactly that shape;
 *  - everything else is handed to the parser, a stretch of elements at a time under a
 *    stand-in for the root element, and read from the tree by `tree`. The whole part never
 *    becomes one tree.
 * @param {string} xml
 * @param {string} item         the name of the elements: "row", "si"
 * @param {string | null} container  the name of the element they are in, when that is not the root
 * @param {(xml: string, at: number) => number} plain  reads the element that starts at `at`
 *   and returns where it ends, or -1 when it is not written the plain way
 * @param {(parent: Element) => void} tree  reads the elements among the children of `parent`
 */
async function bulk(xml, item, container, plain, tree) {
  const rootAt = xml.search(/<[A-Za-z_]/);
  const headEnd = rootAt < 0 ? -1 : tagEnd(xml, rootAt);
  // The start tag of the root goes around every stretch: it declares the prefixes used inside.
  const head = headEnd < 0 ? '' : xml.slice(rootAt, headEnd);
  const opening = new RegExp(`<((?:[\\w.-]+:)?)${item}[\\s/>]`, 'g');
  opening.lastIndex = Math.max(0, headEnd);
  const first = head && !head.endsWith('/>') ? opening.exec(xml) : null;
  const close = first ? `</${first[1]}${item}>` : '';
  const last = first ? xml.lastIndexOf(close) : -1;
  // Where something that looks like a tag may be mere text (a comment, a CDATA section), and
  // where there is nothing to cut at, the part is read whole.
  if (!first || last < first.index || xml.includes('<![CDATA[') || xml.includes('<!--')) {
    const root = parseXml(xml).documentElement;
    const parent = container ? kid(root, container) : root;
    if (parent) tree(parent);
    return;
  }
  const stop = last + close.length;
  // What is left of the part without its elements has to be sound by itself: a part that is
  // cut off in the middle is refused, not read as far as it goes.
  const rest = parseXml(xml.slice(0, first.index) + xml.slice(stop)).documentElement;
  const tail = `</${/^<([^\s/>]+)/.exec(head)[1]}>`;
  let at = first.index;
  let paused = at;
  let stretch = 0; // grows while one element after another is not plain: fewer, larger trees
  while (at < stop) {
    const c = xml.charCodeAt(at);
    if (c === 32 || c === 10 || c === 13 || c === 9) {
      at++;
      continue;
    }
    const next = plain(xml, at);
    if (next > at) {
      at = next;
      stretch = 0;
    } else {
      stretch = Math.min(PIECE, Math.max(1024, stretch * 2));
      const end = xml.indexOf(close, Math.min(at + stretch, last)) + close.length;
      tree(parseXml(head + xml.slice(at, end) + tail).documentElement);
      at = end;
    }
    if (at - paused > PIECE) {
      paused = at;
      await tick(); // a large part does not hold everything else up
    }
  }
  // Elements after the last end tag (empty ones, written <row/>) are still in what was left.
  const parent = container ? kid(rest, container) : rest;
  if (parent) tree(parent);
}

// The plain way of writing things, as text. Attributes in double quotes; nothing nested but
// what is named here; no prefixes; no space between elements.
const ATTRS = '((?:\\s+[\\w:.-]+="[^"<]*")*)\\s*';
const PLAIN_ROW = new RegExp(`<row${ATTRS}(/?)>`, 'y');
const PLAIN_CELL = new RegExp(`<c${ATTRS}(?:/>|>(<f${ATTRS}(?:/>|>[^<]*</f>))?(?:<v${ATTRS}(?:/>|>([^<]*)</v>))?(?:<is><t${ATTRS}(?:/>|>([^<]*)</t>)</is>)?</c>)`, 'y');
const PLAIN_STRING = new RegExp(`<si>(?:<t${ATTRS}(?:/>|>([^<]*)</t>))?(?:<phoneticPr${ATTRS}/>)?</si>|<si/>`, 'y');
const ATTR_R = /\sr="([^"]*)"/;
const ATTR_S = /\ss="([^"]*)"/;
const ATTR_T = /\st="([^"]*)"/;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Text between two tags as the characters it stands for; null when that is for the parser to judge. */
function plainText(raw) {
  // (A line break written as CR or CRLF is a line feed, as for any XML parser.)
  const text = raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw;
  if (!text.includes('&')) return text;
  let odd = false;
  const out = text.replace(/&(?:#x([0-9A-Fa-f]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos));|&/g, (all, hex, dec, name) => {
    if (name) return ENTITIES[name];
    const code = hex ? parseInt(hex, 16) : dec ? Number(dec) : -1;
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)) return String.fromCodePoint(code);
    odd = true;
    return all;
  });
  return odd ? null : out;
}

/** The strings of the string table, in order. */
async function sharedStrings(xml, quick) {
  const strings = [];
  const plain = (text, at) => {
    PLAIN_STRING.lastIndex = at;
    const m = PLAIN_STRING.exec(text);
    const value = m ? plainText(m[2] ?? '') : null;
    if (value === null) return -1;
    strings.push(unescapeX(value));
    return PLAIN_STRING.lastIndex;
  };
  const tree = (parent) => {
    for (const item of kids(parent, 'si')) strings.push(unescapeX(stringOf(item)));
  };
  await bulk(xml, 'si', null, quick ? plain : () => -1, tree);
  return strings;
}

/** The cells of one sheet. */
async function sheetCells(xml, book, quick) {
  const rows = [];
  const stats = { dates: 0, formulas: 0, uncached: 0, formatted: 0 };
  let r = -1;
  let c = -1;
  let line = null;
  // Rows and cells say where they are (r="7", r="B7"); one that does not follows the one before.
  const startRow = (number) => {
    const n = Number(number);
    r = Number.isInteger(n) && n > 0 ? n - 1 : r + 1;
    c = -1;
    line = r < MAX_ROWS ? rows[r] ?? null : null;
  };
  /**
   * @param {string | null} ref     r="B7"
   * @param {string | null} type    t="s"
   * @param {string | null} style   s="3"
   * @param {string} stored         what is in <v>
   * @param {boolean} formula       is there an <f>
   * @param {string | null} inline  the text in <is>, when there is one
   */
  const putCell = (ref, type, style, stored, formula, inline) => {
    const col = ref ? columnOf(ref) : -1;
    c = col >= 0 ? col : c + 1;
    if (c >= MAX_COLS || r >= MAX_ROWS) return;
    let text;
    if (!type || type === 'n') {
      const format = book.formats[Number(style ?? 0)];
      const filled = stored.trim() !== '';
      const date = format?.kind && filled ? serialToText(Number(stored), { date1904: book.date1904, elapsed: format.kind === 'elapsed' }) : null;
      if (date !== null) stats.dates++;
      else if (format?.custom && filled) stats.formatted++;
      text = date ?? numberText(stored);
    } else if (type === 's') text = book.strings[Number(stored)] ?? '';
    else if (type === 'inlineStr') text = unescapeX(inline ?? stored);
    else if (type === 'str') text = unescapeX(stored);
    else if (type === 'b') text = stored.trim() === '' ? '' : stored.trim() === '0' ? 'FALSE' : 'TRUE';
    else if (type === 'd') {
      // A date written out (ISO 8601) instead of counted in days.
      text = stored.trim().replace('T', ' ').replace(/(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/, '').replace(/ 00:00(?::00)?$/, '');
      if (text) stats.dates++;
    } else text = stored.trim(); // "e", an error such as #DIV/0!, and anything not known
    if (formula) {
      stats.formulas++;
      if (text === '') stats.uncached++;
    }
    if (text === '') return;
    line ??= rows[r] = [];
    line[c] = text;
  };

  const tree = (parent) => {
    for (let rowEl = parent.firstChild; rowEl; rowEl = rowEl.nextSibling) {
      if (rowEl.nodeType !== 1 || rowEl.localName !== 'row') continue;
      startRow(rowEl.getAttribute('r'));
      for (let cell = rowEl.firstChild; cell; cell = cell.nextSibling) {
        if (cell.nodeType !== 1 || cell.localName !== 'c') continue;
        let stored = '';
        let formula = false;
        let inline = null;
        for (let n = cell.firstChild; n; n = n.nextSibling) {
          if (n.nodeType !== 1) continue;
          if (n.localName === 'v') stored = n.textContent;
          else if (n.localName === 'f') formula = true;
          else if (n.localName === 'is') inline = stringOf(n);
        }
        putCell(cell.getAttribute('r'), cell.getAttribute('t'), cell.getAttribute('s'), stored, formula, inline);
      }
    }
  };
  // One row straight from the text. Its cells are only put once the whole row has been read,
  // so that a row which turns out not to be plain is left entirely to the parser.
  const held = [];
  const plain = (text, at) => {
    PLAIN_ROW.lastIndex = at;
    const row = PLAIN_ROW.exec(text);
    if (!row || row[1].includes('&')) return -1;
    let i = PLAIN_ROW.lastIndex;
    held.length = 0;
    while (!row[2]) {
      if (text.startsWith('</row>', i)) {
        i += 6;
        break;
      }
      PLAIN_CELL.lastIndex = i;
      const cell = PLAIN_CELL.exec(text);
      if (!cell || cell[1].includes('&')) return -1;
      const stored = cell[5] === undefined ? '' : plainText(cell[5]);
      const inline = cell[7] === undefined ? null : plainText(cell[7]);
      if (stored === null || (inline === null && cell[7] !== undefined)) return -1;
      held.push(ATTR_R.exec(cell[1])?.[1] ?? null, ATTR_T.exec(cell[1])?.[1] ?? null, ATTR_S.exec(cell[1])?.[1] ?? null, stored, cell[2] !== undefined, inline);
      i = PLAIN_CELL.lastIndex;
    }
    startRow(ATTR_R.exec(row[1])?.[1]);
    for (let k = 0; k < held.length; k += 6) putCell(held[k], held[k + 1], held[k + 2], held[k + 3], held[k + 4], held[k + 5]);
    return i;
  };
  await bulk(xml, 'row', 'sheetData', quick ? plain : () => -1, tree);
  // No holes: an empty row is an empty list, an empty cell an empty string.
  for (let i = 0; i < rows.length; i++) {
    const cells = (rows[i] ??= []);
    for (let j = 0; j < cells.length; j++) cells[j] ??= '';
  }
  return { rows, ...stats };
}

/**
 * The sheets of an Excel workbook, in the order of its tabs, every cell as text: strings as
 * they are (shared, inline, with several fonts in one cell), numbers the way a person writes
 * them, TRUE and FALSE, for a formula the result that was saved with it, and dates as
 * "2024-03-05", "2024-03-05 14:30:00" or "14:30:00" (see serialToText; a cell is a date when
 * its number format is one, see dateFormatKind). Rows and cells are put where their
 * references say; a row is as long as its last cell with something in it, and rows after the
 * last one with something in it are left out.
 *
 * Besides `rows`, every sheet says: `hidden`; `dates`, how many cells were written out as a
 * date or time; `formulas`, how many cells hold a formula, and `uncached`, how many of those
 * came without a saved result (and so are empty here); `formatted`, how many numbers have a
 * display format of their own (percent, thousands, currency) and are given here as the plain
 * number.
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 * @param {{ plain?: boolean }} [o]  plain: false has every row and string go through the XML
 *   parser, none read straight from the text (some forty times slower; the two ways must
 *   agree, which is what the tests use this for)
 * @returns {Promise<Array<{ name: string, rows: string[][], hidden: boolean, dates: number, formulas: number, uncached: number, formatted: number }>>}
 */
export async function readXlsx(buffer, { plain = true } = {}) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    // Not a zip. An .xlsx with a password to open it is kept in the container old .xls files use.
    if (bytes?.[0] === 0xd0 && bytes?.[1] === 0xcf && bytes?.[2] === 0x11 && bytes?.[3] === 0xe0) throw new Error('这个文件读不了：它加了打开密码，或者其实是旧版的 .xls 文件');
    throw new Error(DAMAGED);
  }
  const byLower = new Map(Object.keys(zip.files).map((name) => [name.replace(/\\/g, '/').toLowerCase(), name]));
  const read = (part) => {
    const entry = zip.file(part) ?? zip.file(byLower.get(part.toLowerCase()) ?? '');
    if (!entry) return Promise.resolve(null);
    // Longer than a string can be, or than anyone would wait for.
    if (entry._data?.uncompressedSize > MAX_PART) throw new Error(`这个工作簿太大了：里面有一张表解开后有 ${Math.round(entry._data.uncompressedSize / 1024 / 1024)} MB，这里读不了`);
    return entry.async('string');
  };
  try {
    const bookPart = relationships(await read('_rels/.rels'), '').find((x) => x.type.endsWith('/officeDocument'))?.part ?? 'xl/workbook.xml';
    const bookXml = await read(bookPart);
    if (!bookXml) throw new Error('这不是一个 Excel 工作簿：里面没有工作表');
    const bookEl = parseXml(bookXml).documentElement;
    const rels = relationships(await read(relsOf(bookPart)), bookPart);
    const partOf = (suffix, fallback) => rels.find((x) => x.type.endsWith(suffix))?.part ?? dirOf(bookPart) + fallback;

    const book = { strings: [], formats: [], date1904: /^(1|true)$/i.test(kid(bookEl, 'workbookPr')?.getAttribute('date1904') ?? '') };
    const stringsXml = await read(partOf('/sharedStrings', 'sharedStrings.xml'));
    if (stringsXml) book.strings = await sharedStrings(stringsXml, plain);
    const stylesXml = await read(partOf('/styles', 'styles.xml'));
    if (stylesXml) {
      const stylesEl = parseXml(stylesXml).documentElement;
      const patterns = new Map();
      for (const f of kids(kid(stylesEl, 'numFmts'), 'numFmt')) patterns.set(Number(f.getAttribute('numFmtId')), (f.getAttribute('formatCode') ?? '').trim());
      for (const xf of kids(kid(stylesEl, 'cellXfs'), 'xf')) {
        const id = Number(xf.getAttribute('numFmtId') ?? 0);
        const pattern = patterns.get(id);
        book.formats.push({
          // A pattern in the file goes before the meaning the number has on its own.
          kind: pattern === undefined ? builtInKind(id) : dateFormatKind(pattern),
          // The general format (0) and "text" (49, "@") do not change how a number looks.
          custom: pattern === undefined ? id !== 0 && id !== 49 : !/^general$/i.test(pattern) && pattern !== '@',
        });
      }
    }

    const sheets = [];
    for (const el of kids(kid(bookEl, 'sheets'), 'sheet')) {
      // r:id, under whatever prefix the file gives that namespace.
      let rid = '';
      for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        if (a.localName === 'id' && a.prefix && a.prefix !== 'xmlns') rid = a.value;
      }
      const rel = rels.find((x) => x.id === rid);
      if (!rel || !rel.type.endsWith('/worksheet')) continue; // a chart on a tab of its own, a macro sheet
      const xml = await read(rel.part);
      if (xml === null) continue;
      const cells = await sheetCells(xml, book, plain);
      sheets.push({ name: el.getAttribute('name') ?? '', rows: cells.rows, hidden: /hidden/i.test(el.getAttribute('state') ?? ''), dates: cells.dates, formulas: cells.formulas, uncached: cells.uncached, formatted: cells.formatted });
    }
    return sheets;
  } catch (err) {
    // Our own refusals pass; anything else is a file that is not what it should be.
    throw /[\u4e00-\u9fff]/.test(String(err?.message)) ? err : new Error(DAMAGED);
  }
}

// ---------------------------------------------------------------- Markdown

/**
 * A table as a Markdown (GFM) table, its first row as the header. A pipe in a cell is
 * escaped, a line break becomes <br>; a column of nothing but numbers is aligned right.
 * @param {Array<Array<string | number>>} rows
 */
export function toMarkdownTable(rows) {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  if (!width) return '';
  const cell = (v) => String(v ?? '').trim().replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>').replace(/[\t\u000b\u000c]/g, ' ');
  const line = (r) => `| ${Array.from({ length: width }, (_x, i) => cell(r[i])).join(' | ')} |`;
  const numeric = Array.from({ length: width }, (_x, c) => {
    const body = rows.slice(1).map((r) => r[c]).filter((v) => !empty(v) && String(v).trim() !== '');
    return body.length > 0 && body.every((v) => plainNumber(typeof v === 'string' ? v.trim() : v) !== null);
  });
  return [line(rows[0]), `| ${numeric.map((n) => (n ? '---:' : '---')).join(' | ')} |`, ...rows.slice(1).map(line)].join('\n') + '\n';
}
