// Tables: reading and writing CSV and Excel workbooks (src/main/office/sheet.js), and the sheet
// actions (src/main/office/tools-sheet.js) run with a hand-made env that writes into a
// temporary folder. Workbooks that the reader is tried on are put together here by hand, the
// way other programs lay them out, not by the writer under test. The same actions inside the
// real app, and LibreOffice opening what is written: test/e2e/office-sheet.mjs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';
import { describeFiles } from '../src/core/office-kinds.js';
import {
  MAX_CELL_CHARS,
  MAX_COLS,
  MAX_ROWS,
  clipCells,
  dateFormatKind,
  detectDelimiter,
  displayWidth,
  fitTable,
  numberStats,
  parseCsv,
  plainNumber,
  readXlsx,
  serialToText,
  sheetNames,
  toCsv,
  toMarkdownTable,
  writeXlsx,
} from '../src/main/office/sheet.js';
import { actions as basic } from '../src/main/office/tools-basic.js';
import { MARKDOWN_ROWS, actions, fileNames } from '../src/main/office/tools-sheet.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-sheet-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const action = (id) => actions.find((a) => a.id === id);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let folders = 0;
const freshDir = () => {
  const dir = path.join(root, `case-${++folders}`);
  fs.mkdirSync(dir);
  return dir;
};
const filesCtx = (paths, has = {}) => ({ kind: 'files', files: describeFiles(paths), text: '', has: { office: false, model: true, ...has } });

/** A name in `dir` that is not taken, the way the app picks one. */
function free(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** An env like the one src/main/office/index.js hands to an action, writing into `dir`. */
function makeEnv(dir, signal) {
  const log = { steps: [], saved: [], folders: [] };
  const env = {
    signal,
    step: (done, total, name) => log.steps.push({ done, total, name }),
    save: (name, data) => {
      const file = free(dir, name);
      fs.writeFileSync(file, data);
      log.saved.push(name);
      return file;
    },
    folder: (name) => {
      const made = free(dir, name);
      fs.mkdirSync(made);
      log.folders.push(name);
      return made;
    },
    tools: {},
  };
  return { env, log };
}
const run = (id, paths, dir, signal) => action(id).run(filesCtx(paths), makeEnv(dir, signal).env);

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/**
 * A workbook put together by hand, laid out the way Excel lays one out.
 * @param {object} o
 * @param {Array<{ name: string, data: string, state?: string }>} o.sheets  data: the inside of <sheetData>
 * @param {string[]} [o.strings]   shared strings: plain text, or the inside of an <si> when it starts with "<"
 * @param {Array<number | string>} [o.xfs]  the number format of each cell style
 * @param {Record<string, string>} [o.formats]  custom number formats, id -> pattern
 */
async function bookOf({ sheets, strings = [], xfs = [0], formats = {}, date1904 = false }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${REL}">${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="${PKG}">${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId90" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId91" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => (s.startsWith('<') ? `<si>${s}</si>` : `<si><t>${s}</t></si>`)).join('')}</sst>`);
  const numFmts = Object.entries(formats).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>`).join('');
  zip.file('xl/styles.xml', `<styleSheet xmlns="${NS}">${numFmts ? `<numFmts count="${Object.keys(formats).length}">${numFmts}</numFmts>` : ''}<cellXfs count="${xfs.length}">${xfs.map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"/>`).join('')}</cellXfs></styleSheet>`);
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"><dimension ref="A1"/><sheetData>${s.data}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`));
  return zip.generateAsync({ type: 'nodebuffer' });
}
/**
 * The sheets of a workbook. Rows written the plain way are read straight from the text, the
 * others by the XML parser: here everything is also read by the parser alone, and the two
 * must agree.
 */
async function read(buffer) {
  const sheets = await readXlsx(buffer);
  assert.deepEqual(await readXlsx(buffer, { plain: false }), sheets, 'read straight from the text, and read by the XML parser');
  return sheets;
}
const rowsOf = async (buffer, sheet = 0) => (await read(buffer))[sheet].rows;
const xmlOf = async (buffer, part) => (await JSZip.loadAsync(buffer)).file(part).async('string');
const parses = (xml) => new DOMParser({ onError: (level, message) => assert.fail(`${level}: ${message}`) }).parseFromString(xml, 'text/xml').documentElement;

/** Text as the bytes of an old Chinese (GBK) file. Node only decodes GBK, so: a table made by decoding. */
let gbkTable = null;
function gbk(text) {
  if (!gbkTable) {
    gbkTable = new Map();
    const decoder = new TextDecoder('gb18030');
    for (let hi = 0x81; hi <= 0xfe; hi++) {
      for (let lo = 0x40; lo <= 0xfe; lo++) {
        if (lo === 0x7f) continue;
        const ch = decoder.decode(Uint8Array.of(hi, lo));
        if (ch.length === 1 && ch !== '\ufffd' && !gbkTable.has(ch)) gbkTable.set(ch, [hi, lo]);
      }
    }
  }
  return Buffer.from([...text].flatMap((ch) => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : gbkTable.get(ch) ?? assert.fail(`no GBK bytes for ${ch}`))));
}

/** The same every time: a small random number generator. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- CSV

test('parseCsv: fields, quotes, and where rows end', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n', ','), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepEqual(parseCsv('a,b,c\r\n1,2,3\r\n', ','), [['a', 'b', 'c'], ['1', '2', '3']], 'CRLF');
  assert.deepEqual(parseCsv('a,b\r1,2', ','), [['a', 'b'], ['1', '2']], 'old Mac line ends, and no line break at the end');
  assert.deepEqual(parseCsv('', ','), []);
  assert.deepEqual(parseCsv('a', ','), [['a']]);
  assert.deepEqual(parseCsv('a\n', ','), [['a']], 'the line break at the end starts no row');
  assert.deepEqual(parseCsv('a\n\n', ','), [['a'], ['']], 'but an empty line is a row');
  assert.deepEqual(parseCsv('a,b\n\n1,2\n', ','), [['a', 'b'], [''], ['1', '2']]);
  assert.deepEqual(parseCsv(',a,,b,\n,\n', ','), [['', 'a', '', 'b', ''], ['', '']], 'empty fields, at both ends too');
  assert.deepEqual(parseCsv('a,b,', ','), [['a', 'b', '']], 'a delimiter at the very end');
  // Quoted: delimiters, line breaks and doubled quotes are part of the field.
  assert.deepEqual(parseCsv('"a,b","say ""hi""","line 1\nline 2","x\r\ny"\r\n"",""\r\n', ','), [['a,b', 'say "hi"', 'line 1\nline 2', 'x\r\ny'], ['', '']]);
  assert.deepEqual(parseCsv('1,"2\n\n3",4\n5,6,7', ','), [['1', '2\n\n3', '4'], ['5', '6', '7']]);
  assert.deepEqual(parseCsv('""""', ','), [['"']]);
  assert.deepEqual(parseCsv('"a""",""""""', ','), [['a"', '""']]);
  // Not by the book, read the way spreadsheets read it.
  assert.deepEqual(parseCsv('a"b,5" pipe,"x"y\n', ','), [['a"b', '5" pipe', 'xy']], 'a quote inside a plain field is a quote; text after a closing quote is kept');
  assert.deepEqual(parseCsv('a,"never closed\nb,c', ','), [['a', 'never closed\nb,c']]);
  assert.deepEqual(parseCsv(' "a" , b ', ','), [[' "a" ', ' b ']], 'spaces belong to the field');
  // Other delimiters, and a mark at the start.
  assert.deepEqual(parseCsv('a\tb,c\t"d\te"\n', '\t'), [['a', 'b,c', 'd\te']]);
  assert.deepEqual(parseCsv('a;b\n"1;5";2\n', ';'), [['a', 'b'], ['1;5', '2']]);
  assert.deepEqual(parseCsv('\ufeffa,b\n'), [['a', 'b']]);
  assert.deepEqual(parseCsv('a|b\n', '|'), [['a', 'b']]);
  assert.throws(() => parseCsv('a', '"'), TypeError);
  assert.throws(() => parseCsv('a', ', '), TypeError);
});

test('parseCsv finds the delimiter by itself: comma, tab or semicolon', () => {
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(detectDelimiter('a;b;c\n1;2;3\n'), ';');
  assert.equal(detectDelimiter('one column\nno delimiter at all\n'), ',');
  assert.equal(detectDelimiter(''), ',');
  // Prices with a decimal comma in a semicolon file; sentences with commas in a tab file.
  assert.equal(detectDelimiter('品名;单价;数量\n苹果;3,5;2\n梨;4;10\n'), ';');
  assert.equal(detectDelimiter('name\tnote\nA\thello, world\nB\tplain\n'), '\t');
  // What is inside quotes does not count.
  assert.equal(detectDelimiter('a;b\n"x,y,z,w";2\n"p,q";3\n'), ';');
  // A title line above the table.
  assert.equal(detectDelimiter('三月销售报表\n日期\t金额\n2024-03-01\t5\n2024-03-02\t6\n'), '\t');
  // Cells that end in a tab (payment exports do this to keep long numbers as text): still commas.
  assert.equal(detectDelimiter('交易号,金额\n2024030522001412345\t,12.50\n2024030522001412346\t,8.00\n'), ',');
  // What the file itself says goes first, and that line is not data.
  assert.equal(detectDelimiter('sep=;\na,b;c,d\n'), ';');
  assert.deepEqual(parseCsv('sep=;\r\na,b;c,d\r\n'), [['a,b', 'c,d']]);
  assert.deepEqual(parseCsv('sep=;\na;b\n', ';'), [['a', 'b']]);
  assert.deepEqual(parseCsv('sep=;\na,b\n', ','), [['sep=;'], ['a', 'b']], 'with another delimiter asked for, it is a line like any other');

  assert.deepEqual(parseCsv('品名;单价\n"苹果;红";3,5\n'), [['品名', '单价'], ['苹果;红', '3,5']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2\n'), [['a', 'b'], ['1', '2']]);
  // Decided on the first lines only, however long the file.
  const long = 'k;v\n' + 'key;value, with a comma\n'.repeat(20_000);
  assert.equal(detectDelimiter(long), ';');
  assert.equal(parseCsv(long).length, 20_001);
});

test('toCsv: quotes only where they are needed, CRLF after every row', () => {
  assert.equal(toCsv([['a', 'b c', ''], ['1', '2', '3']]), 'a,b c,\r\n1,2,3\r\n');
  assert.equal(toCsv([['a,b', 'say "hi"', 'two\nlines', 'cr\rhere', ' spaces ', "it's"]]), '"a,b","say ""hi""","two\nlines","cr\rhere", spaces ,it\'s\r\n');
  assert.equal(toCsv([[1, 2.5, -3, null, undefined, 0, true]]), '1,2.5,-3,,,0,true\r\n');
  assert.equal(toCsv([]), '');
  assert.equal(toCsv([['a;b', 'c,d']], { delimiter: ';' }), '"a;b";c,d\r\n');
  assert.equal(toCsv([['a\tb', 'c']], { delimiter: '\t' }), '"a\tb"\tc\r\n');
  // For Excel: a mark in front, so that it reads the file as UTF-8.
  const marked = toCsv([['姓名', '城市'], ['张三', '北京']], { bom: true });
  assert.equal(marked, '\ufeff姓名,城市\r\n张三,北京\r\n');
  assert.deepEqual([...Buffer.from(marked, 'utf8').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  // Every row as wide as the table.
  assert.equal(toCsv([['a', 'b', 'c'], ['1'], [], ['x', 'y', 'z', '']], { width: 3 }), 'a,b,c\r\n1,,\r\n,,\r\nx,y,z\r\n');
  // A file that starts with the letters ID is taken for another format by Excel, unless quoted.
  assert.equal(toCsv([['ID', 'ID'], ['ID', 'x']]), '"ID",ID\r\nID,x\r\n');
  assert.equal(toCsv([['IDs', 'x']]), '"IDs",x\r\n');
  assert.equal(toCsv([['id', 'x']]), 'id,x\r\n');
});

test('what toCsv writes, parseCsv reads back exactly', () => {
  const rows = [
    ['ID', '姓名', '备注'],
    ['007', '张三', 'a,b "quoted"\r\nsecond line'],
    ['', '', ''],
    ['"', '""', ',,,'],
    [' leading', 'trailing ', '\ttab'],
    ['😀 emoji', "O'Brien", ';'],
  ];
  for (const delimiter of [',', '\t', ';']) assert.deepEqual(parseCsv(toCsv(rows, { delimiter }), delimiter), rows);
  assert.deepEqual(parseCsv(toCsv(rows, { bom: true })), rows, 'with the mark, and the delimiter found');

  // A few hundred tables of awkward cells.
  const next = random(20240305);
  const pieces = ['a', 'b', '1', '中', '文', ' ', ',', ';', '\t', '"', '""', '\n', '\r', '\r\n', "'", '=', '-', '😀', 'ID'];
  for (let n = 0; n < 300; n++) {
    const table = Array.from({ length: 1 + Math.floor(next() * 5) }, () => Array.from({ length: 1 + Math.floor(next() * 5) }, () => Array.from({ length: Math.floor(next() * 5) }, () => pieces[Math.floor(next() * pieces.length)]).join('')));
    for (const delimiter of [',', '\t', ';']) assert.deepEqual(parseCsv(toCsv(table, { delimiter }), delimiter), table, JSON.stringify(table));
  }
});

// ---------------------------------------------------------------- small pieces

test('plainNumber: only what is written as a plain number is a number', () => {
  const numbers = { 0: 0, 7: 7, '-7': -7, '12.50': 12.5, '0.5': 0.5, '-0.25': -0.25, '1000000': 1e6, '123456789012345': 123456789012345, '12345678.1234567': 12345678.1234567, ' 42 ': 42, '\t42': 42, '-0': -0 };
  for (const [text, value] of Object.entries(numbers)) assert.equal(plainNumber(text), value, JSON.stringify(text));
  const text = [
    '', ' ', '007', '00', '0123.5', '-01', // zeros in front: a code, not an amount
    '13800138000x', '+8613800138000', '+5', // phone numbers
    '1234567890123456', '110101199003071234', '0.1234567890123456', // more digits than a spreadsheet keeps
    '1e5', '1E5', '0x10', '1,234', '1 234', '12%', '¥12', '$5', '.5', '5.', '1.2.3', '--1', '-', '１２３', 'NaN', 'Infinity', 'TRUE',
    '2024-03-05', '12:30', '3/4', '12\n',
  ];
  for (const t of text) assert.equal(plainNumber(t), null, JSON.stringify(t));
  assert.equal(plainNumber(12.5), 12.5);
  assert.equal(plainNumber(NaN), null);
  assert.equal(plainNumber(Infinity), null);
  assert.equal(plainNumber(null), null);
  assert.equal(plainNumber(true), null);

  assert.deepEqual(numberStats([['编号', '金额', '手机'], ['007', '12.5', '13800138000'], ['008', '', '110101199003071234'], ['x9', 3, ' 0012 ']]), { numbers: 3, kept: 4 });
});

test('sheetNames: what Excel accepts, and no two alike', () => {
  assert.deepEqual(sheetNames(['销售', 'Q1 data', "it's"]), ['销售', 'Q1 data', "it's"]);
  assert.deepEqual(sheetNames(['a/b\\c?d*e:f', 'report [final]', "'quoted'", '  spaced  ']), ['a_b_c_d_e_f', 'report (final)', 'quoted', 'spaced']);
  assert.deepEqual(sheetNames(['', null, undefined, "''", ' ']), ['Sheet1', 'Sheet2', 'Sheet3', 'Sheet4', 'Sheet5']);
  assert.deepEqual(sheetNames(['History', 'history']), ['History_', 'history_ (2)']);
  // 31 characters at most, counted the way Excel counts, and never half a character.
  const long = sheetNames(['一二三四五六七八九十'.repeat(4), 'x'.repeat(40), '😀'.repeat(20), `${'y'.repeat(30)} z`]);
  assert.deepEqual(long, ['一二三四五六七八九十'.repeat(3) + '一', 'x'.repeat(31), '😀'.repeat(15), 'y'.repeat(30)]);
  for (const name of long) assert.ok(name.length <= 31);
  // Alike, also when only the capitals differ: numbered.
  assert.deepEqual(sheetNames(['data', 'Data', 'DATA', 'data (2)']), ['data', 'Data (2)', 'DATA (3)', 'data (2) (2)']);
  const twins = sheetNames(['z'.repeat(40), 'z'.repeat(40), 'z'.repeat(40)]);
  assert.deepEqual(twins, ['z'.repeat(31), `${'z'.repeat(27)} (2)`, `${'z'.repeat(27)} (3)`]);
  const many = sheetNames(Array.from({ length: 120 }, () => '同名'));
  assert.equal(new Set(many.map((n) => n.toLowerCase())).size, 120);
  for (const name of [...long, ...twins, ...many, ...sheetNames(['a/b\\c?d*e:f[g]'])]) assert.ok(name.length >= 1 && name.length <= 31 && !/[\\/?*[\]:]/.test(name) && !/^'|'$/.test(name), name);
});

test('displayWidth: Chinese counts double, the longest line counts', () => {
  assert.equal(displayWidth(''), 0);
  assert.equal(displayWidth('hello'), 5);
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth('2024年3月'), 9);
  assert.equal(displayWidth('ＡＢ，。'), 8, 'full-width forms and punctuation');
  assert.equal(displayWidth('カタカナ 한글'), 13);
  assert.equal(displayWidth('😀'), 2, 'one character, though it takes two units');
  assert.equal(displayWidth('short\na much longer line\n中'), 18);
  assert.equal(displayWidth(1234.5), 6);
});

test('fitTable and clipCells', () => {
  const rows = [['a', '', ''], ['', 'b'], [], ['', ''], []];
  const fit = fitTable(rows);
  assert.deepEqual(fit, { rows: [['a', '', ''], ['', 'b']], cols: 2 });
  assert.equal(fit.rows[0], rows[0], 'the rows themselves, not copies');
  assert.deepEqual(fitTable([]), { rows: [], cols: 0 });
  assert.deepEqual(fitTable([[''], [null, undefined]]), { rows: [], cols: 0 });
  assert.deepEqual(fitTable([['', '', 'x'], [], ['y']]).cols, 3, 'empty rows and columns in the middle count');
  const whole = [['a', 0]];
  assert.equal(fitTable(whole).rows, whole);
  assert.equal(fitTable([[0]]).cols, 1, 'a zero is something');

  const big = 'x'.repeat(MAX_CELL_CHARS + 10);
  const clipped = clipCells([['short', big], [big, 5], ['fine']]);
  assert.equal(clipped.clipped, 2);
  assert.deepEqual(clipped.rows.map((r) => r.map((v) => String(v).length)), [[5, MAX_CELL_CHARS], [MAX_CELL_CHARS, 1], [4]]);
  const emoji = 'y'.repeat(MAX_CELL_CHARS - 1) + '😀';
  assert.equal(clipCells([[emoji]]).rows[0][0], 'y'.repeat(MAX_CELL_CHARS - 1), 'never half a character');
  const same = [['a', 'b']];
  assert.equal(clipCells(same).rows[0], same[0]);
  assert.equal(clipCells(same).clipped, 0);
});

test('toMarkdownTable: a GFM table, the first row its header', () => {
  assert.equal(toMarkdownTable([['品名', '数量', '备注'], ['苹果', '12', '红'], ['梨', '7', '']]), '| 品名 | 数量 | 备注 |\n| --- | ---: | --- |\n| 苹果 | 12 | 红 |\n| 梨 | 7 |  |\n');
  // Pipes are escaped, a line break becomes <br>, short rows are filled up.
  assert.equal(toMarkdownTable([['a|b', 'two\nlines'], ['x'], ['1', 'p\r\nq', 'extra']]), '| a\\|b | two<br>lines |  |\n| --- | --- | --- |\n| x |  |  |\n| 1 | p<br>q | extra |\n');
  assert.equal(toMarkdownTable([['only header', 'here']]), '| only header | here |\n| --- | --- |\n');
  assert.equal(toMarkdownTable([[' padded ', 5], ['\ttab\there', 6.5]]), '| padded | 5 |\n| --- | ---: |\n| tab here | 6.5 |\n');
  // Codes with zeros in front are text and stay on the left.
  assert.equal(toMarkdownTable([['编号', '金额'], ['007', '1.5'], ['008', '-2']]).split('\n')[1], '| --- | ---: |');
  assert.equal(toMarkdownTable([]), '');
  assert.equal(toMarkdownTable([[]]), '');
});

// ---------------------------------------------------------------- writing .xlsx

test('writeXlsx: a package with exactly the parts a workbook needs, each of them well-formed', async () => {
  const buffer = await writeXlsx([{ name: '一', rows: [['a', 1]] }, { name: '二', rows: [['b', 2]] }]);
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files);
  assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'], 'the content types first, and no entries for folders');
  const roots = {};
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>\n</, name);
    roots[name] = parses(xml);
  }
  // Every part has its content type, and every relationship leads to a part.
  const types = roots['[Content_Types].xml'];
  const overrides = Object.fromEntries(Array.from(types.getElementsByTagName('Override'), (o) => [o.getAttribute('PartName'), o.getAttribute('ContentType')]));
  assert.deepEqual(overrides, {
    '/xl/workbook.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    '/xl/styles.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml',
    '/xl/worksheets/sheet1.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
    '/xl/worksheets/sheet2.xml': 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
  });
  assert.deepEqual(Array.from(types.getElementsByTagName('Default'), (d) => d.getAttribute('Extension')).sort(), ['rels', 'xml']);
  assert.equal(roots['_rels/.rels'].getElementsByTagName('Relationship')[0].getAttribute('Target'), 'xl/workbook.xml');
  const rels = Object.fromEntries(Array.from(roots['xl/_rels/workbook.xml.rels'].getElementsByTagName('Relationship'), (r) => [r.getAttribute('Id'), [r.getAttribute('Type').split('/').pop(), r.getAttribute('Target')]]));
  assert.deepEqual(rels, { rId1: ['worksheet', 'worksheets/sheet1.xml'], rId2: ['worksheet', 'worksheets/sheet2.xml'], rId3: ['styles', 'styles.xml'] });
  for (const [, target] of Object.values(rels)) assert.ok(names.includes(`xl/${target}`), target);
  const sheets = Array.from(roots['xl/workbook.xml'].getElementsByTagName('sheet'), (s) => [s.getAttribute('name'), s.getAttribute('sheetId'), s.getAttribute('r:id')]);
  assert.deepEqual(sheets, [['一', '1', 'rId1'], ['二', '2', 'rId2']]);
  assert.equal(roots['xl/workbook.xml'].namespaceURI, NS);
  // The styles the cells point at are all there.
  const styles = roots['xl/styles.xml'];
  const count = (tag) => [Number(styles.getElementsByTagName(tag)[0].getAttribute('count')), styles.getElementsByTagName(tag)[0].childNodes.length];
  assert.deepEqual(count('fonts'), [2, 2]);
  assert.deepEqual(count('fills'), [2, 2]);
  assert.deepEqual(count('borders'), [1, 1]);
  const xfs = Array.from(styles.getElementsByTagName('cellXfs')[0].getElementsByTagName('xf'));
  assert.equal(Number(styles.getElementsByTagName('cellXfs')[0].getAttribute('count')), xfs.length);
  assert.deepEqual(xfs.map((xf) => [xf.getAttribute('fontId'), xf.getAttribute('numFmtId'), xf.getElementsByTagName('alignment')[0]?.getAttribute('wrapText') ?? '0']), [['0', '0', '0'], ['1', '0', '0'], ['0', '0', '1'], ['1', '0', '1'], ['0', '1', '0'], ['1', '1', '0']]);
  assert.equal(styles.getElementsByTagName('font')[1].getElementsByTagName('b').length, 1, 'the second font is the bold one');

  await assert.rejects(writeXlsx([]), /没有可以写进工作簿的表/);
});

test('writeXlsx: plain numbers become numbers, everything else stays text exactly as it is', async () => {
  const rows = [
    ['编号', '金额', '手机号', '身份证', '备注'],
    ['007', '1234.50', '13800138000', '110101199003071234', 'a,b "q" <tag> & more'],
    ['8', '-0.5', '+8613800138000', '123456789012345', '1e5'],
    [9, 0.1, ' 42 ', '1234567890123456', '2024-03-05'],
    ['', null, undefined, '0', 'TRUE'],
  ];
  const buffer = await writeXlsx([{ name: '订单', rows }]);
  const xml = await xmlOf(buffer, 'xl/worksheets/sheet1.xml');
  const root = parses(xml);
  const cells = Object.fromEntries(Array.from(root.getElementsByTagName('c'), (c) => [c.getAttribute('r'), { type: c.getAttribute('t') ?? 'n', style: c.getAttribute('s') ?? '0', value: c.getElementsByTagName(c.getAttribute('t') ? 't' : 'v')[0].textContent }]));
  const typed = (ref) => `${cells[ref].type}:${cells[ref].value}`;
  // Numbers: in <v>, as the number they are.
  assert.equal(typed('B2'), 'n:1234.5');
  assert.equal(typed('C2'), 'n:13800138000');
  assert.equal(typed('A3'), 'n:8');
  assert.equal(typed('B3'), 'n:-0.5');
  assert.equal(typed('D3'), 'n:123456789012345');
  assert.equal(typed('A4'), 'n:9');
  assert.equal(typed('B4'), 'n:0.1');
  assert.equal(typed('C4'), 'n:42');
  assert.equal(typed('D5'), 'n:0');
  // Text: inline, every character kept.
  assert.equal(typed('A2'), 'inlineStr:007');
  assert.equal(typed('D2'), 'inlineStr:110101199003071234');
  assert.equal(typed('E2'), 'inlineStr:a,b "q" <tag> & more');
  assert.equal(typed('C3'), 'inlineStr:+8613800138000');
  assert.equal(typed('E3'), 'inlineStr:1e5');
  assert.equal(typed('D4'), 'inlineStr:1234567890123456');
  assert.equal(typed('E4'), 'inlineStr:2024-03-05');
  assert.equal(typed('E5'), 'inlineStr:TRUE');
  // Empty cells are not written; there is no formula and no shared string anywhere.
  assert.deepEqual(Object.keys(cells).filter((ref) => ref.endsWith('5')), ['D5', 'E5']);
  assert.ok(!/<f[ >]|t="s"/.test(xml));
  // The first row is bold, the others are not; whole numbers of 12 digits and more show all their digits.
  for (const ref of ['A1', 'B1', 'C1', 'D1', 'E1']) assert.equal(cells[ref].style, '1', ref);
  assert.deepEqual([cells.A2.style, cells.B2.style, cells.C2.style, cells.D3.style, cells.E4.style], ['0', '0', '0', '4', '0']);
  assert.equal(root.getElementsByTagName('dimension')[0].getAttribute('ref'), 'A1:E5');
  assert.deepEqual(Array.from(root.getElementsByTagName('row'), (r) => r.getAttribute('r')), ['1', '2', '3', '4', '5']);

  // And read back: the same cells, numbers written the short way.
  assert.deepEqual(await rowsOf(buffer), [
    ['编号', '金额', '手机号', '身份证', '备注'],
    ['007', '1234.5', '13800138000', '110101199003071234', 'a,b "q" <tag> & more'],
    ['8', '-0.5', '+8613800138000', '123456789012345', '1e5'],
    ['9', '0.1', '42', '1234567890123456', '2024-03-05'],
    ['', '', '', '0', 'TRUE'],
  ]);
});

test('writeXlsx: the first row stays in view, columns are as wide as their content', async () => {
  const rows = [['品名', 'n', '说明', '', 'wide'], ['苹果（红富士）', 5, 'x'.repeat(300), '', 'two\nlines here'], ['梨', 123456, '短', '', '']];
  const xml = await xmlOf(await writeXlsx([{ name: 's', rows }, { name: 'second', rows: [['x']] }, { name: 'none', rows: [] }]), 'xl/worksheets/sheet1.xml');
  const root = parses(xml);
  const pane = root.getElementsByTagName('pane')[0];
  assert.deepEqual(['ySplit', 'topLeftCell', 'activePane', 'state'].map((a) => pane.getAttribute(a)), ['1', 'A2', 'bottomLeft', 'frozen']);
  assert.equal(pane.getAttribute('xSplit'), null);
  assert.equal(root.getElementsByTagName('sheetView')[0].getAttribute('tabSelected'), '1');
  // Elements in the order the format prescribes.
  assert.deepEqual(Array.from(root.childNodes, (n) => n.localName), ['dimension', 'sheetViews', 'cols', 'sheetData']);
  const cols = Array.from(root.getElementsByTagName('col'), (c) => [c.getAttribute('min'), c.getAttribute('max'), Number(c.getAttribute('width')), c.getAttribute('customWidth')]);
  assert.deepEqual(cols, [
    ['1', '1', 16, '1'], // 苹果（红富士） is 14 wide, and 2 to spare
    ['2', '2', 8, '1'], // 123456
    ['3', '3', 60, '1'], // capped
    ['5', '5', 12, '1'], // the longer of the two lines; the empty column in between has no width of its own
  ]);
  // Text with a line break wraps.
  const wide = Array.from(root.getElementsByTagName('c')).find((c) => c.getAttribute('r') === 'E2');
  assert.equal(wide.getAttribute('s'), '2');
  assert.equal(wide.textContent, 'two\nlines here');

  // The other sheets: not selected; an empty one is still a sheet.
  const book = await writeXlsx([{ name: 's', rows }, { name: 'second', rows: [['x']] }, { name: 'none', rows: [] }]);
  assert.equal(parses(await xmlOf(book, 'xl/worksheets/sheet2.xml')).getElementsByTagName('sheetView')[0].getAttribute('tabSelected'), null);
  const none = parses(await xmlOf(book, 'xl/worksheets/sheet3.xml'));
  assert.equal(none.getElementsByTagName('dimension')[0].getAttribute('ref'), 'A1');
  assert.equal(none.getElementsByTagName('pane').length, 0);
  assert.equal(none.getElementsByTagName('cols').length, 0);
  assert.deepEqual((await read(book)).map((s) => [s.name, s.rows.length]), [['s', 3], ['second', 1], ['none', 0]]);
});

test('writeXlsx: awkward text comes back from the workbook as it went in', async () => {
  const awkward = [
    ' leading and trailing ',
    'two  spaces\tand a tab',
    'line 1\nline 2',
    'windows\r\nline',
    'old mac\rline',
    '<b>&amp;</b> "quotes" \'single\'',
    '_x0041_ is not an A, _x000D_ no line break, _x005F_ stays',
    'bell \u0007 and null \u0000 inside',
    '😀 emoji, 𠀀 a rare character',
    '=SUM(A1:A9)',
    '@mention',
    '\u00a0no-break\u3000spaces\u200b',
    ']]> <![CDATA[x]]> <!-- c -->',
    'x'.repeat(MAX_CELL_CHARS),
  ];
  const buffer = await writeXlsx([{ name: 's', rows: awkward.map((text) => ['row', text]) }]);
  const back = await rowsOf(buffer);
  const expected = awkward.map((text) => text.replace(/\r\n?/g, '\n'));
  assert.deepEqual(back.map((r) => r[1]), expected, 'a line break in a cell is a line feed; nothing else changes');
  // Half a character cannot be stored: it is replaced, and the file is still sound.
  const lonely = await rowsOf(await writeXlsx([{ name: 's', rows: [['a\ud83dz', '\udc00']] }]));
  assert.deepEqual(lonely, [['a\ufffdz', '\ufffd']]);
  // The sheet is well-formed whatever the text was, and a formula is never made of text.
  const xml = await xmlOf(buffer, 'xl/worksheets/sheet1.xml');
  parses(xml);
  assert.ok(!xml.includes('<f>'));
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml));
  assert.match(xml, /bell _x0007_ and null _x0000_ inside/);
  // Spaces at the ends of a text are marked to be kept (a spreadsheet may drop them otherwise).
  assert.match(xml, /<t xml:space="preserve"> leading and trailing <\/t>/);
  assert.match(xml, /<t xml:space="preserve">line 1\nline 2<\/t>/);
  assert.match(xml, /<t>=SUM\(A1:A9\)<\/t>/);
  assert.match(xml, /_x005F_x0041_ is not an A/);
});

test('writeXlsx: sheet names are made valid, and what Excel cannot hold is refused', async () => {
  const names = ['2024/Q1', '2024/Q1', 'x'.repeat(40), '', 'a<b>&"c"'];
  const book = await read(await writeXlsx(names.map((name) => ({ name, rows: [['x']] }))));
  assert.deepEqual(book.map((s) => s.name), ['2024_Q1', '2024_Q1 (2)', 'x'.repeat(31), 'Sheet4', 'a<b>&"c"']);

  await assert.rejects(writeXlsx([{ name: 's', rows: new Array(MAX_ROWS + 1).fill([]) }]), /超过了 Excel 一张表最多 1048576 行的上限/);
  const wide = [];
  wide[MAX_COLS] = 'one too many';
  await assert.rejects(writeXlsx([{ name: 's', rows: [wide] }]), /超过了 Excel 一张表最多 16384 列的上限/);
  // The last column and the last row themselves are fine.
  const edge = [];
  edge[MAX_COLS - 1] = 'last';
  const far = await writeXlsx([{ name: 's', rows: [edge] }]);
  assert.match(await xmlOf(far, 'xl/worksheets/sheet1.xml'), /<c r="XFD1" s="1" t="inlineStr">/);
  assert.equal((await rowsOf(far))[0][MAX_COLS - 1], 'last');
});

// ---------------------------------------------------------------- reading .xlsx

test('readXlsx: strings, numbers, booleans, errors and formulas, each cell where its reference says', async () => {
  const buffer = await bookOf({
    strings: ['名称', '<r><rPr><b/></rPr><t>粗</t></r><r><t xml:space="preserve"> 细 </t></r>', '<t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/>', 'a &amp; b &lt;c&gt;', 'CR_x000D_LF and _x005F_x0041_'],
    xfs: [0, 14, 22, 9],
    sheets: [
      {
        name: '数据',
        data:
          '<row r="1" spans="1:5" x14ac:dyDescent="0.25"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
          '<row r="2"><c r="A2" t="inlineStr"><is><t>inline</t></is></c><c r="B2"><v>0.30000000000000004</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="e"><v>#DIV/0!</v></c><c r="E2" t="b"><v>0</v></c></row>' +
          // No row 3, and row 4 starts at column C.
          '<row r="4"><c r="C4" s="1"><v>45356</v></c><c r="E4" s="2"><v>45356.604166666664</v></c><c r="F4" s="1"/></row>' +
          '<row r="5"><c r="A5"><f>B2*2</f><v>0.6</v></c><c r="B5" t="str"><f>A2&amp;"!"</f><v>inline!</v></c><c r="C5"><f>NOW()</f></c><c r="D5" s="3"><v>0.5</v></c><c r="E5" t="inlineStr"><is><r><t>rich </t></r><r><rPr><i/></rPr><t>inline</t></r></is></c></row>' +
          '<row r="7"/><row r="9"><c r="B9" t="n"><v>1E-7</v></c><c r="AA9"><v>1.5E+20</v></c></row>',
      },
    ],
  });
  const [sheet, ...others] = await read(buffer);
  assert.equal(others.length, 0);
  assert.equal(sheet.name, '数据');
  assert.equal(sheet.hidden, false);
  const far = Array.from({ length: 27 }, () => '');
  far[1] = '0.0000001';
  far[26] = '150000000000000000000';
  assert.deepEqual(sheet.rows, [
    ['名称', '粗 细 ', '東京', 'a & b <c>', 'CR\rLF and _x0041_'],
    ['inline', '0.3', 'TRUE', '#DIV/0!', 'FALSE'],
    [],
    ['', '', '2024-03-05', '', '2024-03-05 14:30:00'],
    ['0.6', 'inline!', '', '0.5', 'rich inline'],
    [],
    [],
    [],
    far,
  ]);
  assert.deepEqual({ dates: sheet.dates, formulas: sheet.formulas, uncached: sheet.uncached, formatted: sheet.formatted }, { dates: 2, formulas: 3, uncached: 1, formatted: 1 });
});

test('readXlsx: rows and cells that do not say where they are follow the one before', async () => {
  const data = '<row><c><v>1</v></c><c><v>2</v></c></row><row><c r="C2"><v>3</v></c><c><v>4</v></c></row><row r="5"><c><v>5</v></c></row><row><c t="inlineStr"><is><t>six</t></is></c></row>';
  assert.deepEqual(await rowsOf(await bookOf({ sheets: [{ name: 's', data }] })), [['1', '2'], ['', '', '3', '4'], [], [], ['5'], ['six']]);
});

test('readXlsx: numbers are written the way a person writes them', async () => {
  const stored = ['5', '5.0', '-0', '0.1', '0.30000000000000004', '1234567.891', '123456789012345', '1.0E-3', '2.5E10', '-7.000000000000001', '1E+21', '1.7976931348623157E308', '9999999999999.98', '99999999999999.98'];
  const data = `<row r="1">${stored.map((v) => `<c><v>${v}</v></c>`).join('')}</row>`;
  const [row] = await rowsOf(await bookOf({ sheets: [{ name: 's', data }] }));
  assert.deepEqual(row.slice(0, 11), ['5', '5', '0', '0.1', '0.3', '1234567.891', '123456789012345', '0.001', '25000000000', '-7', '1000000000000000000000']);
  assert.match(row[11], /^1797693134862320*$/);
  assert.equal(row[12], '9999999999999.98');
  assert.equal(row[13], '100000000000000', 'fifteen digits are all a spreadsheet keeps of a number');
});

test('readXlsx: dates and times, by the number format of the cell', async () => {
  const buffer = await bookOf({
    xfs: [0, 14, 20, 46, 164, 165, 166, 22, 49, 167, 31, 57],
    formats: { 164: 'yyyy"年"m"月"d"日"', 165: '[$-409]h:mm:ss\\ AM/PM', 166: '0.00"元"', 167: 'General' },
    sheets: [
      {
        name: 's',
        data:
          '<row r="1"><c r="A1" s="1"><v>45356</v></c><c r="B1" s="2"><v>0.354166666666667</v></c><c r="C1" s="3"><v>1.25</v></c><c r="D1" s="4"><v>36526</v></c><c r="E1" s="5"><v>0.75</v></c><c r="F1" s="6"><v>12.5</v></c></row>' +
          // A time format on a cell that also has a day; a date format on a number that is no date.
          '<row r="2"><c r="A2" s="2"><v>45356.25</v></c><c r="B2" s="1"><v>-5</v></c><c r="C2" s="7"><v>45356.999999999</v></c><c r="D2" s="8"><v>45356</v></c><c r="E2" s="9"><v>45356</v></c><c r="F2" s="1"><v>60</v></c></row>' +
          // The same number without a date format is a number; a date kept as text is text.
          '<row r="3"><c r="A3"><v>45356</v></c><c r="B3" s="10"><v>45356</v></c><c r="C3" s="11"><v>45356</v></c><c r="D3" t="d" s="1"><v>2024-03-05T00:00:00</v></c><c r="E3" t="d"><v>2024-03-05T14:30:00.000Z</v></c><c r="F3" s="1" t="inlineStr"><is><t>2024/3/5</t></is></c></row>',
      },
    ],
  });
  const [sheet] = await read(buffer);
  assert.deepEqual(sheet.rows, [
    ['2024-03-05', '08:30:00', '30:00:00', '2000-01-01', '18:00:00', '12.5'],
    ['2024-03-05 06:00:00', '-5', '2024-03-06', '45356', '45356', '1900-02-29'],
    ['45356', '2024-03-05', '2024-03-05', '2024-03-05', '2024-03-05 14:30:00', '2024/3/5'],
  ]);
  assert.equal(sheet.dates, 12);
  assert.equal(sheet.formatted, 2, 'the amount in 元, and the number under a date format that is no date');

  // A workbook that counts its days from 1904 (old Mac files).
  const mac = await bookOf({ date1904: true, xfs: [0, 14], sheets: [{ name: 's', data: '<row r="1"><c r="A1" s="1"><v>43894</v></c><c r="B1" s="1"><v>1</v></c><c r="C1"><v>43894</v></c></row>' }] });
  assert.deepEqual(await rowsOf(mac), [['2024-03-05', '1904-01-02', '43894']]);
});

test('serialToText: the days and seconds Excel counts, written out', () => {
  const cases = [
    [1, '1900-01-01'], [31, '1900-01-31'], [59, '1900-02-28'], [60, '1900-02-29'], [61, '1900-03-01'], [367, '1901-01-01'],
    [25569, '1970-01-01'], [36526, '2000-01-01'], [36585, '2000-02-29'], [45356, '2024-03-05'], [45657, '2024-12-31'], [2958465, '9999-12-31'],
    [45356.5, '2024-03-05 12:00:00'], [45356.604166666664, '2024-03-05 14:30:00'], [45356.00001157407, '2024-03-05 00:00:01'], [45356.99998842593, '2024-03-05 23:59:59'],
    [45356.999999999, '2024-03-06'], // closer to midnight than a second: the next day
    [0, '00:00:00'], [0.25, '06:00:00'], [0.5, '12:00:00'], [0.999988425925926, '23:59:59'], [0.354166666666667, '08:30:00'],
  ];
  for (const [serial, text] of cases) assert.equal(serialToText(serial), text, String(serial));
  for (const no of [-1, -0.5, 2958466, NaN, Infinity]) assert.equal(serialToText(no), null, String(no));
  // Durations: hours go on past 24.
  assert.equal(serialToText(1.25, { elapsed: true }), '30:00:00');
  assert.equal(serialToText(0.5, { elapsed: true }), '12:00:00');
  assert.equal(serialToText(100.000011574, { elapsed: true }), '2400:00:01');
  // Counted from 1904.
  assert.equal(serialToText(0.5, { date1904: true }), '12:00:00');
  assert.equal(serialToText(1, { date1904: true }), '1904-01-02');
  assert.equal(serialToText(43894.5, { date1904: true }), '2024-03-05 12:00:00');
  // Every day of a few years, against the calendar.
  for (let serial = 61, ms = Date.UTC(1900, 2, 1); serial < 61 + 366 * 130; serial += 17, ms += 17 * 86_400_000) assert.equal(serialToText(serial), new Date(ms).toISOString().slice(0, 10));
});

test('dateFormatKind: which number formats show a date or a time', () => {
  const dates = ['yyyy-mm-dd', 'm/d/yy', 'd-mmm-yy', 'mmm-yy', 'yyyy"年"m"月"d"日"', 'yyyy\\-mm\\-dd\\ hh:mm:ss', '[$-F800]dddd\\,\\ mmmm\\ dd\\,\\ yyyy', '[$-409]h:mm:ss\\ AM/PM', 'h:mm', 'mm:ss', 'mm:ss.0', 'hh:mm:ss\\ AM/PM', 'YYYY/MM/DD', 'dd/mm/yyyy;@', '[Red]yyyy-mm-dd', 'mmmm', 'd', 'aaaa, yyyy/m/d'];
  for (const code of dates) assert.equal(dateFormatKind(code), 'date', code);
  for (const code of ['[h]:mm:ss', '[hh]:mm', '[mm]:ss', '[s]', '[H]:MM']) assert.equal(dateFormatKind(code), 'elapsed', code);
  const plain = [
    'General', 'GENERAL', '0', '0.00', '#,##0.00', '0%', '0.00E+00', '@', '# ?/?', '',
    '#,##0.00_);[Red](#,##0.00)', '[$¥-804]#,##0.00', '[$-804]General', '[DBNum1][$-804]General', '[Red]0', '[>100]0.0',
    '0.00"元"', '"day "0', '0 "d"', '0" hours"', '\\d0', '0\\ \\m\\s', '0_d', '0*d',
    '_ * #,##0.00_ ;_ * \\-#,##0.00_ ;_ * "-"??_ ;_ @_ ',
    '0.0;yyyy', // of the sections, the first decides
    '"TRUE";"TRUE";"FALSE"',
  ];
  for (const code of plain) assert.equal(dateFormatKind(code), null, code);
  assert.equal(dateFormatKind(undefined), null);
});

test('readXlsx: a workbook laid out another way (prefixes, other part names, hidden sheets, a chart sheet)', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', `<Relationships xmlns="${PKG}"><Relationship Id="R1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="/book/main.xml"/></Relationships>`);
  zip.file(
    'book/main.xml',
    `<x:workbook xmlns:x="${NS}" xmlns:rel="${REL}"><x:sheets>` +
      `<x:sheet name="First &amp; &quot;best&quot;" sheetId="7" rel:id="Ra"/><x:sheet name="Chart" sheetId="3" rel:id="Rc"/><x:sheet name="Secret" sheetId="2" state="hidden" rel:id="Rb"/><x:sheet name="Deep" sheetId="9" state="veryHidden" rel:id="Rd"/><x:sheet name="Gone" sheetId="4" rel:id="Rz"/>` +
      '</x:sheets></x:workbook>',
  );
  zip.file(
    'book/_rels/main.xml.rels',
    `<Relationships xmlns="${PKG}"><Relationship Id="Ra" Type="${REL}/worksheet" Target="tabs/one.xml"/><Relationship Id="Rb" Type="${REL}/worksheet" Target="/book/tabs/two.xml"/><Relationship Id="Rd" Type="${REL}/worksheet" Target="../book/tabs/../tabs/three.xml"/>` +
      `<Relationship Id="Rc" Type="${REL}/chartsheet" Target="charts/c1.xml"/><Relationship Id="Rs" Type="${REL}/sharedStrings" Target="text.xml"/><Relationship Id="Rt" Type="${REL}/styles" Target="look.xml"/><Relationship Id="Rx" Type="${REL}/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`,
  );
  zip.file('book/text.xml', `<x:sst xmlns:x="${NS}"><x:si><x:t>shared</x:t></x:si><x:si/><x:si><x:r><x:t>ri</x:t></x:r><x:r><x:t>ch</x:t></x:r></x:si></x:sst>`);
  zip.file('book/look.xml', `<x:styleSheet xmlns:x="${NS}"><x:numFmts><x:numFmt numFmtId="170" formatCode="dd/mm/yyyy"/></x:numFmts><x:cellXfs><x:xf numFmtId="0"/><x:xf numFmtId="170"/></x:cellXfs></x:styleSheet>`);
  // Laid out over several lines, single quotes round attributes, a comment in between.
  zip.file(
    'book/tabs/one.xml',
    `<?xml version='1.0'?>\n<!-- made by hand -->\n<x:worksheet xmlns:x='${NS}'>\n  <x:sheetData>\n    <x:row r='1'>\n      <x:c r='A1' t='s'>\n        <x:v>0</x:v>\n      </x:c>\n      <x:c r='B1' t='s'><x:v>2</x:v></x:c>\n      <x:c r='C1' t='s'><x:v>1</x:v></x:c>\n      <x:c r='D1' s='1'><x:v>45356</x:v></x:c>\n    </x:row>\n    <x:row r='2'><x:c r='A2' t='inlineStr'><x:is><x:t><![CDATA[</x:row> is text here]]></x:t></x:is></x:c></x:row>\n  </x:sheetData>\n</x:worksheet>`,
  );
  zip.file('book/tabs/two.xml', `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>`);
  zip.file('book/tabs/three.xml', `<x:worksheet xmlns:x="${NS}"><x:sheetData/></x:worksheet>`);
  zip.file('book/charts/c1.xml', `<x:chartsheet xmlns:x="${NS}"/>`);
  const book = await read(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.deepEqual(book.map((s) => [s.name, s.hidden, s.rows]), [
    ['First & "best"', false, [['shared', 'rich', '', '2024-03-05'], ['</x:row> is text here']]],
    ['Secret', true, [['2']]],
    ['Deep', true, []],
  ]);
  // An ArrayBuffer or a plain Uint8Array will do as well as a Buffer.
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  assert.equal((await read(bytes)).length, 3);
  assert.equal((await read(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).length, 3);
});

test('readXlsx: a long sheet and a long string table are read a slice at a time, nothing lost at the seams', async () => {
  const ROWS = 9000;
  let data = '';
  const strings = [];
  // No references at all: every row and cell must still land where it belongs, across slices.
  for (let r = 0; r < ROWS; r++) {
    strings.push(`文本 ${r} ${'·'.repeat(20 + (r % 60))}`);
    data += r % 1000 === 500 ? '<row/>' : `<row><c t="s"><v>${r}</v></c><c><v>${r * 2}.5</v></c><c t="inlineStr"><is><t>行 ${r + 1}</t></is></c></row>`;
  }
  assert.ok(data.length > 800_000 && strings.join('').length > 500_000, 'both longer than one slice');
  const [sheet] = await read(await bookOf({ strings, sheets: [{ name: 'long', data }] }));
  assert.equal(sheet.rows.length, ROWS);
  for (let r = 0; r < ROWS; r++) assert.deepEqual(sheet.rows[r], r % 1000 === 500 ? [] : [strings[r], `${r * 2}.5`, `行 ${r + 1}`], `row ${r + 1}`);

  // With references, some rows out of step and empty rows at the end of the file.
  let sparse = '';
  for (let r = 1; r <= 6000; r++) sparse += `<row r="${r * 3}" spans="1:3" x14ac:dyDescent="0.25"><c r="B${r * 3}"><v>${r}</v></c><c r="D${r * 3}" t="b"><v>${r % 2}</v></c></row>`;
  sparse += '<row r="20000"/><row r="20001"></row>';
  const rows = await rowsOf(await bookOf({ sheets: [{ name: 'sparse', data: sparse }] }));
  assert.equal(rows.length, 18_000);
  for (let r = 1; r <= 6000; r++) {
    assert.deepEqual(rows[r * 3 - 1], ['', String(r), '', r % 2 ? 'TRUE' : 'FALSE']);
    assert.deepEqual(rows[r * 3 - 2], []);
  }
});

test('readXlsx: rows written the plain way and rows that are not, in any order, come out the same', async () => {
  // Six ways to write a row with a text and a number; none says where it is, so that a row
  // lost or read twice when the reading changes hands would shift everything after it.
  const ways = [
    (i) => [`<row><c t="inlineStr"><is><t>plain ${i}</t></is></c><c><v>${i}</v></c></row>`, `plain ${i}`],
    (i) => [`<row><c t='inlineStr'><is><t>quoted ${i}</t></is></c><c><v>${i}</v></c></row>`, `quoted ${i}`],
    (i) => [`<row>\n  <c t="inlineStr">\n    <is><t>spaced ${i}</t></is>\n  </c>\n  <c><v>${i}</v></c>\n</row>\n`, `spaced ${i}`],
    (i) => [`<row><c t="inlineStr"><is><r><t>rich </t></r><r><rPr><b/></rPr><t>${i}</t></r></is></c><c><v>${i}</v></c></row>`, `rich ${i}`],
    (i) => [`<row><c t="str"><v>odd ${i}</v><f>A1</f></c><c><v>${i}</v><extLst><ext uri="x"/></extLst></c></row>`, `odd ${i}`],
    (i) => [`<row><c t="str"><f>A1&amp;"x"</f><v xml:space="preserve">a &amp; b &#20013;&#x6587; &lt;&gt;&quot;&apos; ${i}</v></c><c><v>${i}</v></c></row>`, `a & b 中文 <>"' ${i}`],
  ];
  const next = random(7);
  let data = '';
  const expected = [];
  const add = (way, i) => {
    const [xml, text] = ways[way](i);
    data += xml;
    expected.push([text, String(i)]);
  };
  for (let i = 0; i < 3000; i++) add(Math.floor(next() * ways.length), i);
  for (let i = 3000; i < 12_000; i++) add(1, i); // a long run the parser has to read, in ever larger stretches
  for (let i = 12_000; i < 15_000; i++) add(i % 500 === 0 ? 3 : 0, i); // and a plain run with an odd row now and then
  assert.ok(data.length > 1_000_000);
  const [sheet] = await read(await bookOf({ sheets: [{ name: 'mixed', data }] }));
  assert.equal(sheet.rows.length, expected.length);
  for (let i = 0; i < expected.length; i++) assert.deepEqual(sheet.rows[i], expected[i], `row ${i + 1}`);
  assert.equal(sheet.formulas, expected.filter(([text]) => /^(odd|a &)/.test(text)).length);

  // The string table likewise: plain items, items with a phonetic guide, with several fonts, empty ones.
  const strings = [];
  const texts = [];
  for (let i = 0; i < 6000; i++) {
    const kind = Math.floor(next() * 6);
    if (kind === 0) strings.push(`<t>s${i}</t>`), texts.push(`s${i}`);
    else if (kind === 1) strings.push(`<t xml:space="preserve"> s${i} </t><phoneticPr fontId="1" type="noConversion"/>`), texts.push(` s${i} `);
    else if (kind === 2) strings.push(`<r><t>s</t></r><r><rPr><b/></rPr><t>${i}</t></r>`), texts.push(`s${i}`);
    else if (kind === 3) strings.push('<t/>'), texts.push('');
    else if (kind === 4) strings.push(`<t>東${i}</t><rPh sb="0" eb="1"><t>ヒガシ</t></rPh>`), texts.push(`東${i}`);
    else strings.push(`<t>A&amp;B ${i}_x000A_&#9;&#13;end</t>`), texts.push(`A&B ${i}\n\t\rend`);
  }
  const cells = texts.map((_s, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>${i}</v></c><c r="B${i + 1}" t="s"><v>${(i * 7) % texts.length}</v></c></row>`).join('');
  const rows = await rowsOf(await bookOf({ strings, sheets: [{ name: 's', data: cells }] }));
  for (let i = 0; i < texts.length; i++) assert.deepEqual(rows[i] ?? [], [texts[i], texts[(i * 7) % texts.length]].join('') === '' ? [] : texts[(i * 7) % texts.length] === '' ? [texts[i]] : [texts[i], texts[(i * 7) % texts.length]], `string ${i}`);
});

test('readXlsx: line ends, character references and whatever else XML allows in a cell', async () => {
  const data =
    '<row r="1"><c r="A1" t="inlineStr"><is><t>one\r\ntwo\rthree\nfour</t></is></c><c r="B1" t="str"><v>cr &#13; ref, tab &#9; ref, emoji &#x1F600;, &#65;</v></c><c r="C1" t="str"><v>a > b ]] "q" \'s\'</v></c></row>' +
    '<row r="2" customHeight="1" ht="20.5" note="a > b"><c r="A2" s="0" t="n" vm="1"><v> 12.50 </v></c><c r="B2" t="b"><v>1</v></c><c r="C2" t="inlineStr"><is><t/></is></c><c r="D2" t="s"><v/></c><c r="E2"/><c r="F2" t="n"><v>7</v></c></row>' +
    '<row r="3" note="R&amp;D"><c r="A3" t="inlineStr" note="x &amp; y"><is><t>attributes with references</t></is></c></row>' +
    '<row r="4"/><row r="5"></row><row r="6"><c r="B6" t="str"><f t="shared" ref="B6:B9" si="0">A6</f><v>shared formula</v></c><c r="C6"><f t="shared" si="0"/><v>3</v></c></row>' +
    // Legal, if absurd: the references themselves written as character references.
    '<row r="&#56;"><c r="&#66;8" t="&#115;"><v>0</v></c></row>';
  const [sheet] = await read(await bookOf({ strings: ['zero'], sheets: [{ name: 's', data }] }));
  assert.deepEqual(sheet.rows, [
    ['one\ntwo\nthree\nfour', 'cr \r ref, tab \t ref, emoji 😀, A', 'a > b ]] "q" \'s\''],
    ['12.5', 'TRUE', '', 'zero', '', '7'],
    ['attributes with references'],
    [],
    [],
    ['', 'shared formula', '3'],
    [],
    ['', 'zero'],
  ]);
  assert.equal(sheet.formulas, 2);
  // What is not quite XML is for the parser to judge: read straight from the text or not, the outcome is the same.
  const outcome = (buffer, o) => readXlsx(buffer, o).then((sheets) => sheets[0].rows, (err) => err.message);
  for (const odd of ['<v>a & b</v>', '<v>&#0;</v>', '<v>&bogus;</v>', '<v>&#xD800;</v>', '<v>&amp</v>', '<v>1</v><v>2</v>']) {
    const buffer = await bookOf({ sheets: [{ name: 's', data: `<row r="1"><c r="A1" t="str"><v>before</v></c></row><row r="2"><c r="A2" t="str">${odd}</c></row><row r="3"><c r="A3" t="str"><v>after</v></c></row>` }] });
    assert.deepEqual(await outcome(buffer), await outcome(buffer, { plain: false }), odd);
  }
  const broken = await bookOf({ sheets: [{ name: 's', data: '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></row>' }] });
  await assert.rejects(readXlsx(broken), /打不开这个 Excel 文件：文件不完整或已损坏/);
  await assert.rejects(readXlsx(broken, { plain: false }), /打不开这个 Excel 文件：文件不完整或已损坏/);
});

test('readXlsx: what is not a workbook is refused in plain words', async () => {
  await assert.rejects(readXlsx(Buffer.from('this is not a workbook')), /打不开这个 Excel 文件：文件不完整或已损坏/);
  await assert.rejects(readXlsx(Buffer.alloc(0)), /打不开这个 Excel 文件/);
  // The container of old .xls files, which is also what a password-protected .xlsx is kept in.
  await assert.rejects(readXlsx(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)])), /加了打开密码，或者其实是旧版的 \.xls 文件/);
  // A zip, but of something else (a Word document).
  const word = new JSZip();
  word.file('[Content_Types].xml', '<Types/>');
  word.file('word/document.xml', '<w:document xmlns:w="w"/>');
  await assert.rejects(readXlsx(await word.generateAsync({ type: 'nodebuffer' })), /这不是一个 Excel 工作簿/);
  // A workbook cut off in the middle of a sheet.
  const cut = await JSZip.loadAsync(await bookOf({ sheets: [{ name: 's', data: '<row r="1"><c r="A1"><v>1</v></c></row>' }] }));
  cut.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="${NS}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v>`);
  await assert.rejects(readXlsx(await cut.generateAsync({ type: 'nodebuffer' })), /打不开这个 Excel 文件：文件不完整或已损坏/);
  const cutShort = await JSZip.loadAsync(await bookOf({ sheets: [{ name: 's', data: '' }] }));
  cutShort.file('xl/workbook.xml', '<workbook><sheets><sheet name="s"');
  await assert.rejects(readXlsx(await cutShort.generateAsync({ type: 'nodebuffer' })), /打不开这个 Excel 文件：文件不完整或已损坏/);
  // Half of the bytes of a good file.
  const good = await writeXlsx([{ name: 's', rows: [['a', 'b'], ['1', '2']] }]);
  await assert.rejects(readXlsx(good.subarray(0, good.length >> 1)), /打不开这个 Excel 文件/);
});

// ---------------------------------------------------------------- the actions: when they are offered

test('the sheet actions are offered for tables only, the likeliest first', async () => {
  const dir = freshDir();
  const file = (name) => {
    fs.writeFileSync(path.join(dir, name), 'a,b\n1,2\n');
    return path.join(dir, name);
  };
  const csv = file('a.csv'), tsv = file('b.tsv'), xlsx = file('c.xlsx'), txt = file('d.txt'), pdf = file('e.pdf'), xls = file('f.xls');
  const offered = (ctx, from = actions) => from.filter((x) => x.applies(ctx)).sort((x, y) => x.rank - y.rank).map((x) => x.id);

  assert.deepEqual(offered(filesCtx([csv])), ['sheet.xlsx', 'sheet.markdown']);
  assert.deepEqual(offered(filesCtx([tsv])), ['sheet.xlsx', 'sheet.markdown']);
  assert.deepEqual(offered(filesCtx([xlsx])), ['sheet.csv', 'sheet.markdown']);
  assert.deepEqual(offered(filesCtx([csv, xlsx])), ['sheets.merge']);
  assert.deepEqual(offered(filesCtx([csv, tsv, xlsx])), ['sheets.merge']);
  assert.deepEqual(offered(filesCtx([csv, txt])), [], 'not every file is a table');
  assert.deepEqual(offered(filesCtx([xlsx, pdf])), []);
  assert.deepEqual(offered(filesCtx([xlsx, xls], { office: true })), [], 'an old .xls is not read here');
  assert.deepEqual(offered(filesCtx([txt])), []);
  assert.deepEqual(offered(filesCtx([xls], { office: true })), []);
  assert.deepEqual(offered(filesCtx([])), []);
  assert.deepEqual(offered({ kind: 'text', files: [], text: 'a,b\n1,2', has: { office: true, model: true } }), []);

  // Together with the first set of actions: for several tables, one workbook comes before one PDF.
  const all = [...basic, ...actions];
  assert.deepEqual(offered(filesCtx([csv, xlsx]), all).slice(0, 2), ['sheets.merge', 'files.pdf']);
  assert.deepEqual(offered(filesCtx([csv]), all), ['sheet.xlsx', 'sheet.markdown']);
  assert.deepEqual(offered(filesCtx([xlsx]), all), ['sheet.csv', 'sheet.markdown']);
  assert.equal(new Set(all.map((x) => x.id)).size, all.length, 'no id is taken twice');

  for (const x of actions) {
    assert.match(x.id, /^sheets?\.[a-z]+$/);
    assert.ok(x.label && x.hint && Number.isFinite(x.rank), x.id);
    assert.equal(typeof x.run, 'function');
  }
  assert.deepEqual(Object.fromEntries(actions.map((x) => [x.id, x.label])), { 'sheet.xlsx': '转成 Excel', 'sheet.csv': '转成 CSV', 'sheet.markdown': '复制为 Markdown 表格', 'sheets.merge': '合并成一个 Excel' });
});

// ---------------------------------------------------------------- sheet.xlsx

test('sheet.xlsx: a CSV becomes a workbook next to it; numbers are numbers, codes keep their zeros', async () => {
  const dir = freshDir();
  const src = path.join(dir, '三月订单.csv');
  fs.writeFileSync(src, '订单号,客户,金额,手机,备注\r\n00123,张三,1280.50,13800138000,"加急, 上午送"\r\n00124,李四,99,13900139000,"他说""行""\n第二行"\r\n00125,王五,,110101199003071234,\r\n\r\n');
  const before = sha(src);
  const r = await run('sheet.xlsx', [src], dir);
  assert.equal(r.kind, 'file');
  assert.equal(r.path, path.join(dir, '三月订单.xlsx'));
  const [sheet, ...rest] = await read(fs.readFileSync(r.path));
  assert.equal(rest.length, 0);
  assert.equal(sheet.name, '三月订单');
  assert.deepEqual(sheet.rows, [
    ['订单号', '客户', '金额', '手机', '备注'],
    ['00123', '张三', '1280.5', '13800138000', '加急, 上午送'],
    ['00124', '李四', '99', '13900139000', '他说"行"\n第二行'],
    ['00125', '王五', '', '110101199003071234'],
  ]);
  const xml = await xmlOf(fs.readFileSync(r.path), 'xl/worksheets/sheet1.xml');
  assert.match(xml, /<c r="C2"><v>1280\.5<\/v><\/c>/, 'the amount is a number');
  assert.match(xml, /<c r="A2" t="inlineStr"><is><t>00123<\/t><\/is><\/c>/, 'the order number is text, zeros and all');
  assert.match(xml, /<c r="D4" t="inlineStr"><is><t>110101199003071234<\/t>/, 'eighteen digits stay eighteen digits');
  assert.match(xml, /<c r="A1" s="1" t="inlineStr">/);
  assert.match(xml, /state="frozen"/);
  assert.equal(r.message, '已转成 Excel：4 行 × 5 列（按逗号分列），首行加粗并冻结。4 个单元格是数字，写成了数值；4 个以 0 开头或超过 15 位的数字（编号、证件号、银行卡号之类）保留为文本，一位不少；其余（包括日期）是文本。');
  assert.equal(sha(src), before, 'the CSV is as it was');

  // Again: a second workbook, the first one untouched.
  const first = sha(r.path);
  const again = await run('sheet.xlsx', [src], dir);
  assert.equal(again.path, path.join(dir, '三月订单 (2).xlsx'));
  assert.equal(sha(r.path), first);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['三月订单 (2).xlsx', '三月订单.csv', '三月订单.xlsx']);
});

test('sheet.xlsx: old Chinese encodings, tabs, semicolons, and files that say little', async () => {
  const dir = freshDir();
  const write = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  // GBK, as Excel on a Chinese Windows saves a CSV.
  const gbkFile = write('员工.csv', gbk('姓名,部门,工号\r\n张三,财务部,0012\r\n李四,市场部,0013\r\n'));
  assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(gbkFile)), 'the fixture really is not UTF-8');
  const fromGbk = await run('sheet.xlsx', [gbkFile], dir);
  assert.deepEqual(await rowsOf(fs.readFileSync(fromGbk.path)), [['姓名', '部门', '工号'], ['张三', '财务部', '0012'], ['李四', '市场部', '0013']]);
  assert.ok(!fromGbk.message.includes('认不出来'), fromGbk.message);

  // UTF-16 with a mark and tabs: "Unicode text" out of Excel, here under the name .tsv.
  const tsv = write('库存.tsv', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('品名\t数量\t说明\r\n螺丝, M4\t1200\t"带\t制表符"\r\n', 'utf16le')]));
  const fromTsv = await run('sheet.xlsx', [tsv], dir);
  assert.deepEqual(await rowsOf(fs.readFileSync(fromTsv.path)), [['品名', '数量', '说明'], ['螺丝, M4', '1200', '带\t制表符']]);
  assert.match(fromTsv.message, /^已转成 Excel：2 行 × 3 列（按制表符分列）/);

  // UTF-8 with a mark, semicolons and decimal commas.
  const semi = write('preise.csv', '\ufeffArtikel;Preis\r\nApfel;3,5\r\nBirne;4\r\n');
  const fromSemi = await run('sheet.xlsx', [semi], dir);
  assert.deepEqual(await rowsOf(fs.readFileSync(fromSemi.path)), [['Artikel', 'Preis'], ['Apfel', '3,5'], ['Birne', '4']]);
  assert.match(fromSemi.message, /2 列（按分号分列）.*1 个单元格是数字，写成了数值，其余（包括日期）是文本。$/);

  // One column: nothing to split at, and nothing claimed about splitting.
  const list = write('名单.csv', '张三\n李四\n王五\n');
  const fromList = await run('sheet.xlsx', [list], dir);
  assert.equal(fromList.message, '已转成 Excel：3 行 × 1 列，首行加粗并冻结。所有单元格都是文本。');

  // Bytes that are neither UTF-8 nor GBK: converted, and the person is told what they will see.
  const odd = write('odd.csv', Buffer.concat([Buffer.from('name,city\r\nJos'), Buffer.from([0xe9, 0x2c]), Buffer.from('Paris\r\n')]));
  const fromOdd = await run('sheet.xlsx', [odd], dir);
  assert.match(fromOdd.message, /有些字符认不出来，显示成了“\ufffd”：这个文件可能不是 UTF-8 或 GBK 编码。$/);

  // A cell longer than Excel takes is cut, and that is said.
  const long = write('long.csv', `a,b\r\n${'长'.repeat(MAX_CELL_CHARS + 5)},1\r\n`);
  const fromLong = await run('sheet.xlsx', [long], dir);
  assert.equal((await rowsOf(fs.readFileSync(fromLong.path)))[1][0].length, MAX_CELL_CHARS);
  assert.match(fromLong.message, /有 1 个单元格的文字超过 Excel 每格 32767 字的上限，只留了前 32767 字。$/);
});

test('sheet.xlsx refuses what it cannot turn into a workbook, and writes nothing', async () => {
  const dir = freshDir();
  const write = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const empty = write('empty.csv', '');
  const blank = write('blank.csv', '\r\n\r\n,,\r\n');
  const wide = write('wide.csv', `${Array.from({ length: MAX_COLS + 1 }, (_x, i) => i).join(',')}\n`);
  const listing = fs.readdirSync(dir).sort();
  await assert.rejects(run('sheet.xlsx', [empty], dir), /这个文件是空的，没有可以转的内容/);
  await assert.rejects(run('sheet.xlsx', [blank], dir), /这个文件是空的/);
  await assert.rejects(run('sheet.xlsx', [wide], dir), /这个表有 16385 列，超过了 Excel 一张表最多 16384 列的上限，转不了/);
  await assert.rejects(run('sheet.xlsx', [path.join(dir, 'gone.csv')], dir), /读不了这个文件：gone\.csv/);
  const stopped = new AbortController();
  stopped.abort();
  const good = write('good.csv', 'a,b\n1,2\n');
  await assert.rejects(run('sheet.xlsx', [good], dir, stopped.signal), /已取消/);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...listing, 'good.csv'].sort(), 'nothing was written');
});

// ---------------------------------------------------------------- sheet.csv

test('sheet.csv: a workbook with one table becomes one CSV that Excel reads as UTF-8', async () => {
  const dir = freshDir();
  const src = path.join(dir, '报价.xlsx');
  fs.writeFileSync(
    src,
    await bookOf({
      strings: ['品名', '单价', '日期', '苹果, 红富士', '他说"好"\n第二行', '合计'],
      xfs: [0, 14, 10, 4],
      sheets: [
        {
          name: '报价单',
          data:
            '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
            '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="3"><v>1234.5</v></c><c r="C2" s="1"><v>45356</v></c></row>' +
            '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><v>0.125</v></c></row>' +
            '<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4"><f>SUM(B2:B3)</f><v>1234.625</v></c><c r="C4"><f>TODAY()</f></c></row>',
        },
      ],
    }),
  );
  const before = sha(src);
  const r = await run('sheet.csv', [src], dir);
  assert.equal(r.kind, 'file');
  assert.equal(r.path, path.join(dir, '报价.csv'));
  const bytes = fs.readFileSync(r.path);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the mark that tells Excel it is UTF-8');
  assert.equal(bytes.toString('utf8'), '\ufeff品名,单价,日期\r\n"苹果, 红富士",1234.5,2024-03-05\r\n"他说""好""\n第二行",0.125,\r\n合计,1234.625,\r\n');
  assert.equal(r.message, '已转成 CSV：4 行 × 3 列（UTF-8 编码，带 BOM，Excel 直接打开不乱码）。2 个公式单元格导出的是算好的结果（其中 1 个在文件里没有存结果，是空的）；1 个日期、时间单元格写成“2024-03-05 14:30:00”这种样子的文字；2 个带显示格式的数字（千分位、百分号、货币符号之类）导出的是原值。');
  assert.equal(sha(src), before);
});

test('sheet.csv: several tables become a folder with one CSV each; empty and hidden sheets are named as left out', async () => {
  const dir = freshDir();
  const src = path.join(dir, '年度.xlsx');
  const table = (rows) => rows.map((cells, r) => `<row r="${r + 1}">${cells.map((v, c) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`).join('');
  fs.writeFileSync(
    src,
    await bookOf({
      sheets: [
        { name: '一季度', data: table([['月', '额'], ['1', '10'], ['2', '20']]) },
        { name: '空的', data: '' },
        { name: 'a&lt;b&gt;|c', data: table([['x']]) },
        { name: '参数', state: 'hidden', data: table([['secret']]) },
        { name: 'CON', data: table([['p', 'q', 'r'], ['', '', ''], ['', 's']]) },
      ],
    }),
  );
  const before = sha(src);
  const { env, log } = makeEnv(dir);
  const r = await action('sheet.csv').run(filesCtx([src]), env);
  assert.equal(r.kind, 'folder');
  assert.equal(r.path, path.join(dir, '年度 CSV'));
  assert.deepEqual(fs.readdirSync(r.path).sort(), ['_CON.csv', 'a_b__c.csv', '一季度.csv']);
  const read = (name) => fs.readFileSync(path.join(r.path, name), 'utf8');
  assert.equal(read('一季度.csv'), '\ufeff月,额\r\n1,10\r\n2,20\r\n');
  assert.equal(read('a_b__c.csv'), '\ufeffx\r\n');
  assert.equal(read('_CON.csv'), '\ufeffp,q,r\r\n,,\r\n,s,\r\n', 'every row as wide as the table, the empty row in the middle kept');
  assert.equal(r.message, '这个工作簿有 3 张有数据的表，每张存成了一个 CSV，放在一个新文件夹里：一季度（3 行）、a<b>|c（1 行）、CON（3 行）（UTF-8 编码，带 BOM，Excel 直接打开不乱码）。另有 1 张空表、1 张隐藏的表没有导出。');
  assert.deepEqual(log.steps.map((s) => `${s.done}/${s.total} ${s.name}`), ['0/3 一季度', '1/3 a<b>|c', '2/3 CON', '3/3 ']);
  assert.equal(sha(src), before);
  // Again: a second folder.
  const again = await run('sheet.csv', [src], dir);
  assert.equal(again.path, path.join(dir, '年度 CSV (2)'));
  assert.deepEqual(fs.readdirSync(r.path).sort(), ['_CON.csv', 'a_b__c.csv', '一季度.csv']);

  // One table with data among several sheets: one file, and which sheet it was.
  const one = path.join(dir, '单表.xlsx');
  fs.writeFileSync(one, await bookOf({ sheets: [{ name: '说明', data: '' }, { name: '明细', data: table([['a', 'b']]) }, { name: '参数', state: 'veryHidden', data: table([['k']]) }] }));
  const single = await run('sheet.csv', [one], dir);
  assert.equal(single.kind, 'file');
  assert.equal(fs.readFileSync(single.path, 'utf8'), '\ufeffa,b\r\n');
  assert.equal(single.message, '已把“明细”这张表转成 CSV：1 行 × 2 列（UTF-8 编码，带 BOM，Excel 直接打开不乱码）。另有 1 张空表、1 张隐藏的表没有导出。');
});

test('fileNames: sheet names as file names', () => {
  assert.deepEqual(fileNames(['销售', 'a/b:c*d?e"f<g>h|i\\j', 'trailing. ', '', 'NUL', 'com1', 'Data', 'data', 'DATA']), ['销售', 'a_b_c_d_e_f_g_h_i_j', 'trailing', '表4', '_NUL', '_com1', 'Data', 'data (2)', 'DATA (3)']);
  assert.ok(fileNames(['长'.repeat(200)])[0].length <= 80);
});

test('sheet.csv refuses a workbook without data or one it cannot open, and leaves nothing behind', async () => {
  const dir = freshDir();
  const write = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const empty = write('empty.xlsx', await bookOf({ sheets: [{ name: 'Sheet1', data: '' }, { name: 'h', state: 'hidden', data: '<row r="1"><c r="A1"><v>1</v></c></row>' }] }));
  const broken = write('broken.xlsx', 'this is not a workbook');
  const locked = write('locked.xlsx', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(1024)]));
  const listing = fs.readdirSync(dir).sort();
  await assert.rejects(run('sheet.csv', [empty], dir), /这个工作簿里没有数据（1 张隐藏的表没有读）/);
  await assert.rejects(run('sheet.csv', [broken], dir), /打不开这个 Excel 文件：文件不完整或已损坏/);
  await assert.rejects(run('sheet.csv', [locked], dir), /加了打开密码/);
  await assert.rejects(run('sheet.markdown', [broken], dir), /打不开这个 Excel 文件/);
  await assert.rejects(run('sheet.markdown', [empty], dir), /这个工作簿里没有数据/);
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);

  // Stopped while the folder is being filled: the folder goes away again.
  const many = write('many.xlsx', await writeXlsx([{ name: 'a', rows: [['1']] }, { name: 'b', rows: [['2']] }, { name: 'c', rows: [['3']] }]));
  const stop = new AbortController();
  const { env } = makeEnv(dir, stop.signal);
  env.step = (done) => {
    if (done === 1) stop.abort();
  };
  await assert.rejects(action('sheet.csv').run(filesCtx([many]), env), /已取消/);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...listing, 'many.xlsx'].sort(), 'no half-filled folder is left');
});

// ---------------------------------------------------------------- sheet.markdown

test('sheet.markdown: the first table onto the clipboard as a Markdown table', async () => {
  const dir = freshDir();
  const csv = path.join(dir, '价目.csv');
  fs.writeFileSync(csv, '品名,单价,说明\n苹果,3.5,红|甜\n梨,4,"两行\n说明"\n');
  const listing = fs.readdirSync(dir);
  const r = await run('sheet.markdown', [csv], dir);
  assert.equal(r.kind, 'clipboard');
  assert.equal(r.text, '| 品名 | 单价 | 说明 |\n| --- | ---: | --- |\n| 苹果 | 3.5 | 红\\|甜 |\n| 梨 | 4 | 两行<br>说明 |\n');
  assert.equal(r.message, '已把这张表做成 Markdown 表格：3 行 × 3 列，第一行是表头');
  assert.deepEqual(fs.readdirSync(dir), listing, 'nothing is written');

  // Of a workbook: its first sheet with data, starting at the first row that holds something.
  const book = path.join(dir, 'book.xlsx');
  fs.writeFileSync(book, await writeXlsx([{ name: '封面', rows: [] }, { name: '明细', rows: [[], ['', ''], ['编号', '数量'], ['007', '5'], ['008', '12']] }, { name: '其他', rows: [['x']] }]));
  const fromBook = await run('sheet.markdown', [book], dir);
  assert.equal(fromBook.text, '| 编号 | 数量 |\n| --- | ---: |\n| 007 | 5 |\n| 008 | 12 |\n');
  assert.equal(fromBook.message, '已把“明细”这张表做成 Markdown 表格：3 行 × 2 列，第一行是表头；工作簿里另外 1 张有数据的表没有取');
});

test('sheet.markdown: a long table is cut at 200 rows, and the message says so', async () => {
  const dir = freshDir();
  assert.equal(MARKDOWN_ROWS, 200);
  const make = (name, rows) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `序号,值\n${Array.from({ length: rows - 1 }, (_x, i) => `${i + 1},v${i + 1}`).join('\n')}\n`);
    return file;
  };
  const long = await run('sheet.markdown', [make('long.csv', 1234)], dir);
  const lines = long.text.trimEnd().split('\n');
  assert.equal(lines.length, 201, '200 rows of the table and the line under the header');
  assert.equal(lines[0], '| 序号 | 值 |');
  assert.equal(lines.at(-1), '| 199 | v199 |');
  assert.equal(long.message, '这张表有 1234 行，只取了前 200 行做成 Markdown 表格（第一行是表头），共 2 列');

  const exact = await run('sheet.markdown', [make('exact.csv', 200)], dir);
  assert.equal(exact.text.trimEnd().split('\n').length, 201);
  assert.equal(exact.message, '已把这张表做成 Markdown 表格：200 行 × 2 列，第一行是表头');
  const over = await run('sheet.markdown', [make('over.csv', 201)], dir);
  assert.equal(over.text.trimEnd().split('\n').length, 201);
  assert.match(over.message, /^这张表有 201 行，只取了前 200 行/);
  // The app adds a sentence of its own after the message: no full stop of ours before it.
  for (const m of [long.message, exact.message, over.message]) assert.ok(!/[。.]$/.test(m), m);
});

// ---------------------------------------------------------------- sheets.merge

test('sheets.merge: tables with the same header go into one workbook, and are stacked on a first sheet', async () => {
  const dir = freshDir();
  const write = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const jan = write('一月.csv', '日期,门店,金额\n2024-01-05,东城,120.5\n2024-01-09,西城,80\n');
  const feb = write('二月.tsv', ' 日期\t门店 \t金额\t\n2024-02-03\t东城\t200\t\n\t\t\t\n2024-02-11\t南城\t0015\t\n');
  const mar = write(
    '三月.xlsx',
    await bookOf({
      xfs: [0, 14],
      sheets: [{ name: 'Sheet1', data: '<row r="1"><c r="A1" t="inlineStr"><is><t>日期</t></is></c><c r="B1" t="inlineStr"><is><t>门店</t></is></c><c r="C1" t="inlineStr"><is><t>金额</t></is></c></row><row r="2"><c r="A2" s="1"><v>45356</v></c><c r="B2" t="inlineStr"><is><t>东城</t></is></c><c r="C2"><f>100*3</f><v>300</v></c></row>' }],
    }),
  );
  const before = [jan, feb, mar].map(sha);
  const { env, log } = makeEnv(dir);
  const r = await action('sheets.merge').run(filesCtx([jan, feb, mar]), env);
  assert.equal(r.kind, 'file');
  assert.equal(r.path, path.join(dir, '一月 等 3 个文件 合并.xlsx'));
  const book = await read(fs.readFileSync(r.path));
  assert.deepEqual(book.map((s) => s.name), ['合并', '一月', '二月', '三月']);
  assert.deepEqual(book[0].rows, [
    ['日期', '门店', '金额', '来源'],
    ['2024-01-05', '东城', '120.5', '一月.csv'],
    ['2024-01-09', '西城', '80', '一月.csv'],
    ['2024-02-03', '东城', '200', '二月.tsv'],
    ['2024-02-11', '南城', '0015', '二月.tsv'],
    ['2024-03-05', '东城', '300', '三月.xlsx'],
  ]);
  assert.deepEqual(book[1].rows, [['日期', '门店', '金额'], ['2024-01-05', '东城', '120.5'], ['2024-01-09', '西城', '80']]);
  assert.deepEqual(book[2].rows, [[' 日期', '门店 ', '金额'], ['2024-02-03', '东城', '200'], [], ['2024-02-11', '南城', '0015']], 'each table as it was, its empty row too');
  assert.deepEqual(book[3].rows, [['日期', '门店', '金额'], ['2024-03-05', '东城', '300']]);
  // Amounts are numbers in the stacked sheet as well; the code with zeros in front is not.
  const stacked = await xmlOf(fs.readFileSync(r.path), 'xl/worksheets/sheet1.xml');
  assert.match(stacked, /<c r="C2"><v>120\.5<\/v><\/c>/);
  assert.match(stacked, /<c r="C5" t="inlineStr"><is><t>0015<\/t>/);
  assert.match(stacked, /<c r="D1" s="1" t="inlineStr"><is><t>来源<\/t>/);
  assert.equal(
    r.message,
    '合并了 3 个文件里的 3 张表，共 9 行，每张表在新工作簿里各占一个工作表。各表的表头相同，所以最前面多了一张“合并”表：表头只留一次，5 行数据叠在一起，最后一列“来源”写着每一行出自哪个文件（1 个空行没有放进去）。' +
      '1 个公式单元格带过来的是算好的结果；1 个日期、时间单元格写成“2024-03-05 14:30:00”这种样子的文字。原表的字体、颜色、合并单元格等格式没有带过来。',
  );
  assert.deepEqual(log.steps.map((s) => `${s.done}/${s.total} ${s.name}`), ['0/3 一月.csv', '1/3 二月.tsv', '2/3 三月.xlsx', '3/3 ']);
  assert.deepEqual([jan, feb, mar].map(sha), before, 'the originals are as they were');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['一月 等 3 个文件 合并.xlsx', '一月.csv', '三月.xlsx', '二月.tsv']);
});

test('sheets.merge: different headers are not stacked; a workbook with several sheets gives each a sheet', async () => {
  const dir = freshDir();
  const write = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const people = write('人员.csv', '姓名,部门\n张三,财务\n');
  const book = write('台账 2024 年度（含各分公司明细与汇总）.xlsx', await writeXlsx([{ name: '收入', rows: [['月', '额'], ['1', '10']] }, { name: '空', rows: [] }, { name: '支出', rows: [['月', '额'], ['1', '7'], ['2', '8']] }]));
  const r = await run('sheets.merge', [people, book], dir);
  const merged = await read(fs.readFileSync(r.path));
  assert.deepEqual(merged.map((s) => s.name), ['人员', '台账 2024 年度（含各分公司明细与汇总）-收入', '台账 2024 年度（含各分公司明细与汇总）-支出']);
  for (const s of merged) assert.ok(s.name.length <= 31, s.name);
  // A file name too long for a sheet name is cut so that the sheet's own name still fits.
  const longBook = write(`${'很长的文件名'.repeat(8)}.xlsx`, await writeXlsx([{ name: '收入', rows: [['a']] }, { name: '支出', rows: [['b']] }]));
  const longNamed = await read(fs.readFileSync((await run('sheets.merge', [people, longBook], dir)).path));
  assert.deepEqual(longNamed.map((x) => x.name), ['人员', `${'很长的文件名'.repeat(8).slice(0, 28)}-收入`, `${'很长的文件名'.repeat(8).slice(0, 28)}-支出`]);
  assert.equal(longNamed[1].name.length, 31);
  assert.deepEqual(merged[0].rows, [['姓名', '部门'], ['张三', '财务']]);
  assert.deepEqual(merged[2].rows, [['月', '额'], ['1', '7'], ['2', '8']]);
  assert.equal(r.message, '合并了 2 个文件里的 3 张表，共 7 行，每张表在新工作簿里各占一个工作表。各表的表头不一样，所以没有把它们叠成一张总表。原表的字体、颜色、合并单元格等格式没有带过来。');

  // The same header in every sheet of two workbooks: stacked, and the source says which sheet.
  const other = write('分店.xlsx', await writeXlsx([{ name: '收入', rows: [['月', '额', '来源'], ['3', '30', '线上']] }, { name: '隐藏不了', rows: [['月', '额', '来源'], ['4', '40', '']] }]));
  const third = write('补充.csv', '月,额,来源\n5,50,线下,多出来的一格\n');
  const s = await run('sheets.merge', [other, third], dir);
  const stacked = await read(fs.readFileSync(s.path));
  assert.deepEqual(stacked.map((x) => x.name), ['合并', '分店-收入', '分店-隐藏不了', '补充']);
  assert.deepEqual(stacked[0].rows, [
    ['月', '额', '来源', '', '来源文件'],
    ['3', '30', '线上', '', '分店.xlsx / 收入'],
    ['4', '40', '', '', '分店.xlsx / 隐藏不了'],
    ['5', '50', '线下', '多出来的一格', '补充.csv'],
  ]);
  assert.match(s.message, /^合并了 2 个文件里的 3 张表，共 6 行.*3 行数据叠在一起，最后一列“来源文件”写着每一行出自哪个文件。/);

  // A file named like the stacked sheet keeps its content under a numbered name.
  const a = write('合并.csv', 'k,v\n1,2\n');
  const b = write('b.csv', 'k,v\n3,4\n');
  const named = await read(fs.readFileSync((await run('sheets.merge', [a, b], dir)).path));
  assert.deepEqual(named.map((x) => [x.name, x.rows.length]), [['合并', 3], ['合并 (2)', 2], ['b', 2]]);

  // A table that starts with an empty row has no header to compare.
  const late = write('late.xlsx', await writeXlsx([{ name: 's', rows: [[], ['k', 'v'], ['5', '6']] }]));
  const headless = await run('sheets.merge', [late, b], dir);
  assert.deepEqual((await read(fs.readFileSync(headless.path))).map((x) => x.name), ['late', 'b']);
  assert.match(headless.message, /^合并了 2 个文件里的 2 张表，共 5 行，每张表在新工作簿里各占一个工作表。late\.xlsx 的第一行是空的，看不出表头，所以没有把各表叠成一张总表。/);
});

test('sheets.merge: files that cannot be used are named; with fewer than two left there is nothing to merge', async () => {
  const dir = freshDir();
  const write = (name, data) => {
    fs.writeFileSync(path.join(dir, name), data);
    return path.join(dir, name);
  };
  const a = write('a.csv', 'k,v\n1,2\n');
  const b = write('b.csv', 'k,v\n3,4\n');
  const empty = write('empty.csv', '');
  const broken = write('broken.xlsx', 'not a workbook');
  const hidden = write('h.xlsx', await bookOf({ sheets: [{ name: 'v', data: '<row r="1"><c r="A1" t="inlineStr"><is><t>k</t></is></c><c r="B1" t="inlineStr"><is><t>v</t></is></c></row><row r="2"><c r="A2"><v>5</v></c><c r="B2"><v>6</v></c></row>' }, { name: 'h', state: 'hidden', data: '<row r="1"><c r="A1"><v>1</v></c></row>' }] }));
  const r = await run('sheets.merge', [a, empty, broken, b, hidden], dir);
  const book = await read(fs.readFileSync(r.path));
  assert.deepEqual(book.map((s) => s.name), ['合并', 'a', 'b', 'h']);
  assert.deepEqual(book[0].rows, [['k', 'v', '来源'], ['1', '2', 'a.csv'], ['3', '4', 'b.csv'], ['5', '6', 'h.xlsx']]);
  assert.match(r.message, /^合并了 3 个文件里的 3 张表，共 6 行/);
  assert.match(r.message, /1 张隐藏的表没有放进去。没能处理：empty\.csv（里面没有数据）；broken\.xlsx（打不开这个 Excel 文件：文件不完整或已损坏）。$/);

  const listing = fs.readdirSync(dir).sort();
  await assert.rejects(run('sheets.merge', [a, empty, broken], dir), /只有 a\.csv 读出了数据，没有可以合并的。没能处理：empty\.csv（里面没有数据）；broken\.xlsx（打不开这个 Excel 文件：文件不完整或已损坏）。/);
  await assert.rejects(run('sheets.merge', [empty, broken], dir), /选中的文件都没有读出数据，没有可以合并的。/);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(run('sheets.merge', [a, b], dir, stopped.signal), /已取消/);
  assert.deepEqual(fs.readdirSync(dir).sort(), listing, 'a refusal writes nothing');
});

test('sheets.merge and sheet.xlsx keep astral emoji intact in tab names and handle dotfile tables', async () => {
  const dir = freshDir();
  const emojiName = `${'📊'.repeat(18)}.xlsx`; // 18 emoji = 36 UTF-16 units; cutting for "-表一" must not leave a lone surrogate
  const f1 = path.join(dir, emojiName);
  const f2 = path.join(dir, '.csv');
  fs.writeFileSync(f1, await writeXlsx([{ name: '表一', rows: [['列'], ['1']] }, { name: '表二', rows: [['列'], ['2']] }]));
  fs.writeFileSync(f2, '列\n3\n');

  const single = await run('sheet.xlsx', [f2], dir);
  assert.equal(path.basename(single.path), '结果.xlsx');

  const merged = await run('sheets.merge', [f1, f2], dir);
  const sheets = await read(fs.readFileSync(merged.path));
  for (const s of sheets) {
    assert.equal(s.name.isWellFormed(), true, `sheet name has no lone surrogate: ${s.name}`);
    assert.ok(!s.name.includes('\ufffd'), `sheet name had no broken surrogate replaced: ${s.name}`);
  }
  assert.ok(sheets.some((s) => s.name === '表格'), 'dotfile .csv gets fallback sheet name 表格');
});
