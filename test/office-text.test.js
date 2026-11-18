// The quick actions on selected text (src/main/office/tools-text.js) and on documents and files
// (src/main/office/tools-docs.js), and the counting and number reading behind them
// (src/core/text-stats.js). The actions run with a hand-made env: results go into a temporary
// folder and a PDF is played by a stand-in. The same actions inside the real app:
// test/e2e/office-docs.mjs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { describeFiles } from '../src/core/office-kinds.js';
import { countText, describeCount, describeSum, extractNumbers, grouped, joinLines, sumNumbers, unifyRadicals } from '../src/core/text-stats.js';
import { Office } from '../src/main/office/index.js';
import { actions as basic } from '../src/main/office/tools-basic.js';
import { SUMMARY_CHARS, ZIP_LIMIT, actions as docs, docxText, sizeText, uniqueName } from '../src/main/office/tools-docs.js';
import { MODEL_CHARS, RANK_SUM, RANK_SUM_FIRST, actions as text } from '../src/main/office/tools-text.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-text-test-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cp = (...codes) => String.fromCodePoint(...codes);
const ZWSP = cp(0x200b), BOM = cp(0xfeff), NBSP = cp(0xa0), WIDE_SPACE = cp(0x3000), ACUTE = cp(0x301), LINE_SEP = cp(0x2028);
const action = (id) => [...text, ...docs].find((a) => a.id === id);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let folders = 0;
const freshDir = () => {
  const dir = path.join(root, `case-${++folders}`);
  fs.mkdirSync(dir);
  return dir;
};
const textCtx = (t, has = {}) => ({ kind: 'text', files: [], text: t, has: { office: false, model: true, ...has } });
const filesCtx = (paths, has = {}) => ({ kind: 'files', files: describeFiles(paths), text: '', has: { office: false, model: true, ...has } });
const offered = (set, ctx) => set.filter((a) => a.applies(ctx)).sort((a, b) => a.rank - b.rank).map((a) => a.id);

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
function makeEnv(dir, tools = {}, signal) {
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
    tools,
  };
  return { env, log };
}

// ---------------------------------------------------------------- Word documents made here

// A 2x2 red PNG, enough to be a picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8DAwMDAxMAAAAYIAQMd3rB0AAAAAElFTkSuQmCC', 'base64');
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const run = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const para = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const cell = (...paras) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paras.join('')}</w:tc>`;
const table = (...rows) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rows.map((cells) => `<w:tr>${cells.join('')}</w:tr>`).join('')}</w:tbl>`;
const lineBreak = '<w:r><w:br/></w:r>';
const tab = '<w:r><w:tab/></w:r>';
const numbered = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
const footnoteMark = '<w:r><w:footnoteReference w:id="2"/></w:r>';
const picture = (rid) =>
  `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

/**
 * A Word document with the given body. `media` is { 'image1.png': bytes }: each file gets the
 * relationship id "rIdM1", "rIdM2" ... in the order given. The document always has a header, a
 * footnote and a numbering definition, so that what must not be counted is there to be counted.
 */
async function makeDocx(file, body, media = {}) {
  const zip = new JSZip();
  const names = Object.keys(media);
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="emf" ContentType="image/x-emf"/><Default Extension="mp4" ContentType="video/mp4"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdN" Type="${REL}/numbering" Target="numbering.xml"/><Relationship Id="rIdF" Type="${REL}/footnotes" Target="footnotes.xml"/><Relationship Id="rIdH" Type="${REL}/header" Target="header1.xml"/>${names.map((n, i) => `<Relationship Id="rIdM${i + 1}" Type="${REL}/image" Target="media/${n}"/>`).join('')}</Relationships>`);
  zip.file('word/numbering.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  zip.file('word/footnotes.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${NS}><w:footnote w:id="2">${para(run('脚注里的十个字都不该算'))}</w:footnote></w:footnotes>`);
  zip.file('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}>${para(run('页眉 Header 2026'))}</w:hdr>`);
  for (const n of names) zip.file(`word/media/${n}`, media[n]);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

// The document whose numbers are worked out by hand below.
const KNOWN_BODY = [
  para(run('年度工作报告')),
  para(''),
  para(run('Hello') + lineBreak + run('world，欢迎。')),
  para(run('a') + tab + run('b 100')),
  table([cell(para(run('指标'))), cell(para(run('数值')))], [cell(para(run('收入'))), cell(para(run('1,902')))]),
  para(picture('rIdM1')),
  para(run('第一条'), numbered),
  para(run('第二条'), numbered),
  para(run('结束') + footnoteMark),
].join('');
const KNOWN_TEXT = '年度工作报告\n\nHello\nworld，欢迎。\na\tb 100\n指标\t数值\n收入\t1,902\n\n第一条\n第二条\n结束';

/** The entries of a ZIP read from its central directory, each with read() through zlib. */
function zipEntries(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'the end record of a ZIP');
  const out = [];
  let o = buf.readUInt32LE(end + 16);
  for (let k = 0; k < buf.readUInt16LE(end + 10); k++) {
    assert.equal(buf.readUInt32LE(o), 0x02014b50, 'an entry of the central directory');
    const method = buf.readUInt16LE(o + 10), time = buf.readUInt16LE(o + 12), date = buf.readUInt16LE(o + 14);
    const packed = buf.readUInt32LE(o + 20), size = buf.readUInt32LE(o + 24);
    const nameLength = buf.readUInt16LE(o + 28), extra = buf.readUInt16LE(o + 30), comment = buf.readUInt16LE(o + 32), local = buf.readUInt32LE(o + 42);
    out.push({
      name: buf.toString('utf8', o + 46, o + 46 + nameLength),
      method,
      size,
      // the time as the archive shows it, read as local time
      modified: new Date((date >> 9) + 1980, ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2),
      read() {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.subarray(start, start + packed);
        return method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
      },
    });
    o += 46 + nameLength + extra + comment;
  }
  return out;
}

// ---------------------------------------------------------------- counting

test('countText: Chinese, English, numbers and punctuation in one text', () => {
  const c = countText("你好，world！这是 2026-11-13 的 Q3 报告 v2。\n\n第二段 don't stop，共 1,234.5 元。");
  // line 1 has 34 characters (5 spaces), line 2 has 27 (4 spaces)
  assert.deepEqual(c, { total: 24, chars: 61, charsNoSpace: 52, han: 12, words: 5, numbers: 2, lines: 2, blankLines: 1, paragraphs: 2 });
});

test('countText: nothing, and nothing but spaces', () => {
  const zero = { total: 0, chars: 0, charsNoSpace: 0, han: 0, words: 0, numbers: 0, lines: 0, blankLines: 0, paragraphs: 0 };
  assert.deepEqual(countText(''), zero);
  assert.deepEqual(countText(undefined), zero);
  assert.deepEqual(countText('\n\n\n'), zero);
  assert.deepEqual(countText('  \n \t'), { ...zero, chars: 4 });
});

test('countText: characters are what a person sees; spaces of every kind are spaces; line breaks are not characters', () => {
  assert.deepEqual(pick(countText(`a b\tc${WIDE_SPACE}d${NBSP}e`), 'chars', 'charsNoSpace'), { chars: 9, charsNoSpace: 5 });
  assert.deepEqual(pick(countText('ab\r\ncd\ref\n'), 'chars', 'lines'), { chars: 6, lines: 3 }, 'Windows, old Mac and Unix line ends');
  assert.deepEqual(pick(countText(`ab${LINE_SEP}cd`), 'chars', 'lines'), { chars: 4, lines: 2 }, 'the Unicode line separator');
  assert.equal(countText(`a${ZWSP}b${BOM}`).chars, 2, 'zero-width characters are not counted');
  // a family (three people joined), an e with a combining accent, a flag (two letters)
  assert.deepEqual(pick(countText(`👨‍👩‍👧e${ACUTE}🇨🇳`), 'chars', 'charsNoSpace'), { chars: 3, charsNoSpace: 3 });
  assert.deepEqual(pick(countText('𠮷野家'), 'chars', 'han', 'total'), { chars: 3, han: 3, total: 3 }, 'a character outside the basic plane is one character');
});

test('countText: 汉字 are Chinese characters only; kana and punctuation are not', () => {
  assert.equal(countText('汉字、かな。カナ「引用」〇々').han, 6, '汉 字 引 用 〇 々');
  assert.equal(countText('한국어 text').han, 0);
  assert.equal(countText('１２３ＡＢＣ，。！').han, 0);
});

test('countText: words are in Latin letters, with their apostrophes, hyphens and digits', () => {
  assert.equal(countText("don't state-of-the-art e-mail GPT-4 Q3 naïve café").words, 7);
  assert.equal(countText('rock’n’roll').words, 1, 'curly apostrophes too');
  assert.deepEqual(pick(countText('3D 打印 10kg 的 B2B 方案'), 'words', 'numbers'), { words: 3, numbers: 2 }, 'D, kg and B2B are words; 3 and 10 are numbers');
  assert.equal(countText('中文里没有英文单词').words, 0);
  assert.equal(countText('Привет мир').words, 0, 'only Latin letters make an "English word"');
});

test('countText: digits written together are one number', () => {
  assert.equal(countText('1,234.5 2026-11-13 12:30 １２３ 3.14 50%').numbers, 6);
  assert.equal(countText('1 2 3').numbers, 3);
  assert.equal(countText('2026年11月13日').numbers, 3);
  assert.equal(countText('Q3 v2 GPT-4').numbers, 0, 'digits inside a word belong to the word');
});

test('countText: 字数 the way a word processor counts', () => {
  const total = (t) => countText(t).total;
  assert.equal(total('你好，world!'), 4, '你 好 ， and one word');
  assert.equal(total('“好。”'), 4, 'quotation marks around Chinese are Chinese punctuation');
  assert.equal(total('“hello” state-of-the-art'), 2, 'quotation marks around a word belong to the word');
  assert.equal(total('……——'), 4);
  assert.equal(total('hello - world'), 3, 'a hyphen standing alone counts, as it does in Word');
  assert.equal(total('Python3.11版本'), 3);
  assert.equal(total('こんにちは'), 5, 'kana one by one');
  assert.equal(total('안녕하세요 세계'), 2, 'Korean by its words');
  assert.equal(total('ＡＢ'), 2, 'full-width letters one by one');
});

test('countText: lines with something on them, empty lines between them, and paragraphs', () => {
  const shape = (t) => pick(countText(t), 'lines', 'blankLines', 'paragraphs');
  assert.deepEqual(shape('a\nb\nc'), { lines: 3, blankLines: 0, paragraphs: 3 }, 'without empty lines every line is a paragraph');
  assert.deepEqual(shape('\n\n标题\n\n第一行\n第二行\n\n\n结尾\n\n'), { lines: 4, blankLines: 3, paragraphs: 3 }, 'empty lines around the text are not counted');
  assert.deepEqual(shape('a\n  \t\nb'), { lines: 2, blankLines: 1, paragraphs: 2 }, 'a line of spaces is an empty line');
  assert.deepEqual(shape('only'), { lines: 1, blankLines: 0, paragraphs: 1 });
});

test('describeCount: every line names what it counts', () => {
  const c = { total: 12345, chars: 23456, charsNoSpace: 20000, han: 9000, words: 1200, numbers: 34, lines: 120, blankLines: 0, paragraphs: 40 };
  assert.equal(describeCount(c), '字数 12,345（中文按字算，英文和数字按词算）\n字符 23,456，不计空格 20,000\n汉字 9,000，英文单词 1,200，数字 34\n行 120，段落 40');
  assert.equal(describeCount({ ...c, blankLines: 7 }).split('\n')[3], '行 120（另有空行 7），段落 40');
  assert.equal(describeCount(c, { lines: false }).split('\n')[3], '段落 40');
  assert.equal(grouped(1234567), '1,234,567');
  assert.equal(grouped(999), '999');
});

function pick(object, ...keys) {
  return Object.fromEntries(keys.map((k) => [k, object[k]]));
}

// ---------------------------------------------------------------- the numbers in a text

const values = (t) => extractNumbers(t).numbers.map((n) => n.value);
const skippedIn = (t) => Object.fromEntries(Object.entries(extractNumbers(t).skipped).filter(([, n]) => n));

test('extractNumbers: thousands separators, decimals, signs', () => {
  assert.deepEqual(values('收入 1,234.5 元，支出 -300，结余 934.5'), [1234.5, -300, 934.5]);
  assert.deepEqual(values('12,345,678 和 0.5 和 007'), [12345678, 0.5, 7]);
  assert.deepEqual(values('+3 负5 -0.25'), [3, -5, -0.25]);
  assert.deepEqual(values('100, 200, 300'), [100, 200, 300], 'a comma and a space separate numbers');
  assert.deepEqual(values('1,2,3'), [1, 2, 3], 'groups that are not three digits are not thousands');
  assert.deepEqual(values('1,2345'), [1, 2345]);
  assert.deepEqual(values('0,123'), [0, 123]);
  assert.deepEqual(values('总数是 3.'), [3], 'a full stop after a number ends the sentence');
  assert.deepEqual(values('x=-5，y = -7'), [-5, -7]);
});

test('extractNumbers: a hyphen between two things is not a minus sign', () => {
  assert.deepEqual(values('3-5 天'), [3, 5]);
  assert.deepEqual(values('10 - 3'), [10, 3]);
  assert.deepEqual(values('10 -3'), [10, -3]);
  assert.deepEqual(values('温度 -5 度'), [-5]);
  assert.deepEqual(values('30%-40% 之间'), [30, 40]);
  assert.deepEqual(values('−5 和 －6'), [-5, -6], 'the minus sign of typography and the full-width one');
});

test('extractNumbers: full-width digits and signs', () => {
  assert.deepEqual(values('１２３ 和 ４５６．５，还有 １，９０２'), [123, 456.5, 1902]);
  assert.deepEqual(extractNumbers('增长 ５０％').numbers.map((n) => [n.value, n.rate, n.raw]), [[50, '%', '５０％']]);
  assert.deepEqual(values('１，２，３'), [1, 2, 3], 'a full-width comma separates, unless three digits follow');
});

test('extractNumbers: units and currency signs are kept as labels, never multiplied in', () => {
  const read = (t) => extractNumbers(t).numbers.map((n) => [n.value, n.currency, n.unit, n.raw]);
  assert.deepEqual(read('¥ 3,899'), [[3899, '¥', '', '¥ 3,899']]);
  assert.deepEqual(read('1,902万元'), [[1902, '', '万元', '1,902万元']]);
  assert.deepEqual(read('￥1,000 和 RMB 20'), [[1000, '¥', '', '￥1,000'], [20, '¥', '', 'RMB 20']]);
  assert.deepEqual(read('$2.5 US$20 USD 30 €7 £8'), [[2.5, '$', '', '$2.5'], [20, 'USD', '', 'US$20'], [30, 'USD', '', 'USD 30'], [7, '€', '', '€7'], [8, '£', '', '£8']]);
  assert.deepEqual(read('-¥50 和 ¥-20'), [[-50, '¥', '', '-¥50'], [-20, '¥', '', '¥-20']]);
  assert.deepEqual(read('3 亿，20k，3w，5 千，12 元，8块'), [[3, '', '亿', '3 亿'], [20, '', 'k', '20k'], [3, '', 'w', '3w'], [5, '', '千', '5 千'], [12, '', '元', '12 元'], [8, '', '块', '8块']]);
  assert.deepEqual(read('5 kg 和 3千克，7km').map((n) => [n[0], n[2]]), [[5, ''], [3, ''], [7, '']], 'kg, 千克 and km are not thousands');
  assert.deepEqual(read('共 12 人，3 个').map((n) => n[0]), [12, 3]);
});

test('extractNumbers: percentages are marked', () => {
  assert.deepEqual(extractNumbers('31%，12.5 %，-3%，5‰，100').numbers.map((n) => [n.value, n.rate]), [[31, '%'], [12.5, '%'], [-3, '%'], [5, '‰'], [100, '']]);
});

test('extractNumbers: dates are not quantities', () => {
  for (const t of ['2026-11-13', '2026/11/13', '2026.11.13', '2026-11', '11/13/2026', '2026年11月13日', '2026 年 11 月 13 日', '2026年11月', '2026年', '2020-2025年', '11月13日', '11月13号', '11月13-15日', '11月', '12 月', 'Nov 13, 2026', 'November 13th', '13 November 2026', 'Sept. 5', 'March 2026', 'Jan 5-7, 2026']) {
    assert.deepEqual(values(`到 ${t} 为止`), [], t);
    assert.deepEqual(skippedIn(`到 ${t} 为止`), { date: 1 }, t);
  }
  assert.deepEqual(values('2026-11-13T12:30:00 收入 300'), [300]);
  assert.deepEqual(values('日期,2026-11-13.'), [], 'between punctuation');
  assert.deepEqual(values('1月收入 300，2月收入 500'), [300, 500]);
  // what only looks a little like a date stays a number
  assert.deepEqual(values('3个月 13月 2026.5 12026-11-13'), [3, 13, 2026.5, 12026, 11, 13]);
  assert.deepEqual(values('工作了 25 年，3 年历史'), [25, 3]);
});

test('extractNumbers: times are not quantities', () => {
  for (const t of ['12:30', '9:05', '23:59:59', '12：30', '08:00:00.250']) assert.deepEqual([values(`在 ${t} 开始`), skippedIn(`在 ${t} 开始`)], [[], { time: 1 }], t);
  assert.deepEqual(skippedIn('12:30-13:30'), { time: 2 });
  assert.deepEqual(values('比分 3:2，画面 16:9'), [3, 2, 16, 9], 'not a time: a ratio stays numbers');
  assert.deepEqual(values('收入：100'), [100]);
});

test('extractNumbers: telephone numbers are not quantities', () => {
  for (const t of ['13800138000', '+8613800138000', '+86 13800138000', '138-0013-8000', '138 0013 8000', '010-12345678', '(021) 1234567', '0755-12345678', '400-800-1234']) {
    assert.deepEqual([values(`电话 ${t}。`), skippedIn(`电话 ${t}。`)], [[], { phone: 1 }], t);
  }
  assert.deepEqual(values('call 13800138000, then pay 20'), [20]);
  // eleven digits with a money sign or unit are money; ten or twelve digits are a number
  assert.deepEqual(values('¥13800138000 和 15000000000元 和 13800138000.50'), [13800138000, 15000000000, 13800138000.5]);
  assert.deepEqual(values('1380013800 和 138001380001'), [1380013800, 138001380001]);
});

test('extractNumbers: list markers at the start of a line are not quantities', () => {
  assert.deepEqual(values('1. 买菜 30 元\n2. 水果 25.5 元\n3、牛奶 12 元\n4) 面包 8 元\n（5）鸡蛋 10 元\n  (6) 盐 2 元'), [30, 25.5, 12, 8, 10, 2]);
  assert.deepEqual(skippedIn('1. 买菜 30 元\n2. 水果 25.5 元'), { marker: 2 });
  assert.deepEqual(values('1. 30 个鸡蛋'), [30], 'the item may begin with a number');
  assert.deepEqual(values('1.5 元\n2.5 元'), [1.5, 2.5], 'a decimal at the start of a line is a number');
  assert.deepEqual(values('100、200、300'), [100, 200, 300], 'a list of numbers is not a marker and its item');
  assert.deepEqual(values('1.5\n2.5\n3.'), [1.5, 2.5, 3], 'a line that is only "3." is a number');
  assert.deepEqual(values('共 3. 其余略'), [3], 'only at the start of a line');
  assert.deepEqual(values('2026. 这一年'), [2026], 'four digits are not a marker');
});

test('extractNumbers: ordinals and digits that are part of a name are not quantities', () => {
  assert.deepEqual(values('Q3 的 COVID-19 报告 v2 第3章 第 4 节 No.5 #7 1st 2nd 3rd 4th 共 3 页，10 条'), [3, 10]);
  assert.deepEqual(skippedIn('Q3 的 COVID-19 报告 v2 第3章 No.5 #7 1st'), { marker: 4, code: 3 });
  assert.deepEqual(values('IP 192.168.1.1 版本 1.2.3。'), []);
  assert.deepEqual(values('身份证 11010519491231002X，卡号 6222021234567890123'), []);
  assert.deepEqual(values('看 https://example.com/2026/11/13/post-123 和 www.a1.cn/5 或写信给 a@b123.com，共 7 个'), [7]);
  assert.deepEqual(values('# 5 个要点'), [5], 'a heading mark with a space is not "#5"');
  assert.deepEqual(values('iPhone 15 卖 5,999'), [15, 5999], 'a number standing alone is read, whatever it is the number of');
});

test('extractNumbers: where each number was found', () => {
  const t = '¥ 3,899 和 31% 和 １２';
  const found = extractNumbers(t).numbers;
  assert.deepEqual(found.map((n) => t.slice(n.index, n.end)), ['¥ 3,899', '31%', '１２']);
  assert.deepEqual(found.map((n) => [n.digits, n.places]), [[3899n, 0], [31n, 0], [12n, 0]]);
  assert.deepEqual(extractNumbers('-1.50').numbers.map((n) => [n.digits, n.places]), [[-150n, 2]]);
  assert.deepEqual(extractNumbers('').numbers, []);
  assert.deepEqual(extractNumbers(undefined).numbers, []);
});

test('sumNumbers: count, sum, mean, largest and smallest, exactly', () => {
  const r = sumNumbers('收入 1,234.5 元，支出 -300，结余 934.5');
  assert.deepEqual(pick(r, 'count', 'sum', 'mean', 'max', 'min', 'plain', 'value', 'meanExact'), { count: 3, sum: '1,869', mean: '623', max: '1,234.5', min: '-300', plain: '1869', value: 1869, meanExact: true });
  assert.deepEqual(pick(sumNumbers('0.1 0.2'), 'sum', 'mean', 'plain'), { sum: '0.3', mean: '0.15', plain: '0.3' }, 'decimal arithmetic, not binary');
  assert.deepEqual(pick(sumNumbers('1.50 和 2.50'), 'sum', 'plain', 'max'), { sum: '4', plain: '4', max: '2.5' });
  assert.deepEqual(pick(sumNumbers('9,007,199,254,740,993 和 2'), 'sum', 'plain'), { sum: '9,007,199,254,740,995', plain: '9007199254740995' }, 'beyond what a double can hold');
  assert.deepEqual(pick(sumNumbers('-5 和 5'), 'sum', 'mean', 'max', 'min'), { sum: '0', mean: '0', max: '5', min: '-5' });
  assert.deepEqual(pick(sumNumbers('-0.5 和 -0.25'), 'sum', 'max', 'min'), { sum: '-0.75', max: '-0.25', min: '-0.5' });
});

test('sumNumbers: the mean is rounded to two more places than the numbers have, and says when it was', () => {
  assert.deepEqual(pick(sumNumbers('1 2 2'), 'mean', 'meanExact'), { mean: '1.67', meanExact: false });
  assert.deepEqual(pick(sumNumbers('-1 -2 -2'), 'mean', 'meanExact'), { mean: '-1.67', meanExact: false });
  assert.deepEqual(pick(sumNumbers('1 2'), 'mean', 'meanExact'), { mean: '1.5', meanExact: true });
  assert.deepEqual(pick(sumNumbers('1 0 0 0 0 0 0 0'), 'mean', 'meanExact'), { mean: '0.13', meanExact: false }, '0.125: half goes away from zero');
  assert.deepEqual(pick(sumNumbers('-1 0 0 0 0 0 0 0'), 'mean', 'meanExact'), { mean: '-0.13', meanExact: false });
  assert.deepEqual(pick(sumNumbers('1.5 2.5 3'), 'mean', 'meanExact'), { mean: '2.333', meanExact: false });
});

test('sumNumbers: percentages are left out of a sum of plain numbers, and added up when there is nothing else', () => {
  const mixed = sumNumbers('增长 31%，收入 100，成本 60，千分之 5‰');
  assert.deepEqual(pick(mixed, 'count', 'sum', 'suffix', 'leftOut'), { count: 2, sum: '160', suffix: '', leftOut: { percent: 1, permille: 1 } });
  const all = sumNumbers('华东 31%，华北 12.5%，华南 -3%');
  assert.deepEqual(pick(all, 'count', 'sum', 'mean', 'max', 'min', 'suffix', 'plain', 'leftOut'), { count: 3, sum: '40.5', mean: '13.5', max: '31', min: '-3', suffix: '%', plain: '40.5%', leftOut: { percent: 0, permille: 0 } });
  assert.deepEqual(pick(sumNumbers('5‰ 和 3‰'), 'count', 'sum', 'suffix', 'plain'), { count: 2, sum: '8', suffix: '‰', plain: '8‰' });
  assert.deepEqual(pick(sumNumbers('30% 和 5‰'), 'count', 'suffix', 'leftOut'), { count: 1, suffix: '%', leftOut: { percent: 0, permille: 1 } });
});

test('sumNumbers: a unit all the numbers share is shown; different units are named, not converted', () => {
  assert.deepEqual(pick(sumNumbers('1,902万元 加 3,899万元'), 'sum', 'prefix', 'suffix', 'mixed'), { sum: '5,801', prefix: '', suffix: '万元', mixed: [] });
  assert.deepEqual(pick(sumNumbers('1,902万元 加 300万'), 'sum', 'suffix', 'mixed'), { sum: '2,202', suffix: '万', mixed: [] });
  assert.deepEqual(pick(sumNumbers('1,902万元 加 500元'), 'sum', 'suffix', 'mixed'), { sum: '2,402', suffix: '', mixed: ['万元', '元'] });
  assert.deepEqual(pick(sumNumbers('3 亿和 5000'), 'suffix', 'mixed'), { suffix: '', mixed: ['亿', '不带单位'] });
  assert.deepEqual(pick(sumNumbers('¥ 3,899 和 ￥1,000'), 'sum', 'prefix', 'mixed'), { sum: '4,899', prefix: '¥', mixed: [] });
  assert.deepEqual(pick(sumNumbers('USD 100 和 US$20'), 'sum', 'prefix'), { sum: '120', prefix: 'USD ' });
  assert.deepEqual(pick(sumNumbers('¥3,899 和 $2,899'), 'prefix', 'mixed'), { prefix: '', mixed: ['¥', '$'] });
  assert.deepEqual(pick(sumNumbers('¥3,899 加运费 20'), 'sum', 'prefix', 'mixed'), { sum: '3,919', prefix: '', mixed: [] }, 'a number without a sign next to one with a sign is not a second currency');
  assert.deepEqual(pick(sumNumbers('30 元 和 12 元'), 'suffix', 'mixed'), { suffix: '元', mixed: [] });
});

test('sumNumbers: nothing to add', () => {
  const r = sumNumbers('会议 2026-11-13 12:30，电话 13800138000');
  assert.deepEqual(pick(r, 'count', 'sum', 'plain', 'dense'), { count: 0, sum: '0', plain: '0', dense: false });
  assert.deepEqual(r.skipped, { date: 1, time: 1, phone: 1, marker: 0, code: 0 });
  assert.equal(describeSum(r), '这段文字里没有可以相加的数（1 个日期、1 个时间、1 个电话号码不算）');
  assert.equal(describeSum(sumNumbers('没有数字')), '这段文字里没有可以相加的数');
});

test('sumNumbers: "mostly numbers" is at least half of what is written', () => {
  assert.equal(sumNumbers('12\n15\n18').dense, true);
  assert.equal(sumNumbers('苹果 12\n香蕉 15\n橘子 18').dense, true, '6 of 12 characters');
  assert.equal(sumNumbers('项目A 1,200.00\n项目B 3,400.00').dense, true);
  assert.equal(sumNumbers('今年的收入是 1,902 万元，比去年多了 300 万元，大家都很高兴。').dense, false);
  assert.equal(sumNumbers('会议 2026-11-13 12:30 开始，预算 5000 元，到场 12 人').dense, false);
  assert.equal(sumNumbers('12').dense, false, 'one number is nothing to add up');
});

test('describeSum: what was added and what was not', () => {
  assert.equal(describeSum(sumNumbers('12\n15\n18.5')), '3 个数，合计 45.5\n平均约 15.167，最大 18.5，最小 12');
  assert.equal(describeSum(sumNumbers('1,902万元 加 3,899万元')), '2 个数，合计 5,801 万元\n平均 2,900.5 万元，最大 3,899 万元，最小 1,902 万元');
  assert.equal(describeSum(sumNumbers('¥ 3,899 和 ￥1,000')), '2 个数，合计 ¥4,899\n平均 ¥2,449.5，最大 ¥3,899，最小 ¥1,000');
  assert.equal(describeSum(sumNumbers('华东 31%，华北 12.5%，华南 -3%')), '3 个百分数，合计 40.5%\n平均 13.5%，最大 31%，最小 -3%');
  assert.equal(describeSum(sumNumbers('20k 和 30k')), '2 个数，合计 50k\n平均 25k，最大 30k，最小 20k');
  assert.equal(describeSum(sumNumbers('1,902万元 加 500元')), '2 个数，合计 2,402\n平均 1,201，最大 1,902，最小 500\n这些数的单位不一样（万元、元），是照写出来的数字直接相加的，没有换算');
  assert.equal(
    describeSum(sumNumbers('1. 会议 2026-11-13 12:30 开始，电话 13800138000\n2. 预算 5000 元，到场 12 人，比上次多 20%，见 Q3 报告')),
    '2 个数，合计 5,012\n平均 2,506，最大 5,000，最小 12\n另有 1 个百分数没有加进去；不算在内：1 个日期、1 个时间、1 个电话号码、2 个序号、1 个编号或名称里的数字',
  );
  assert.equal(describeSum(sumNumbers('100，3%，5‰，200')).split('\n')[2], '另有 1 个百分数和 1 个千分数没有加进去');
});

// ---------------------------------------------------------------- lines into one paragraph

test('joinLines: nothing between Chinese characters, one space between words', () => {
  assert.deepEqual(joinLines('这是第一行，\n接着第二行。'), { text: '这是第一行，接着第二行。', lines: 2, paragraphs: 1, mended: 0 });
  assert.equal(joinLines('The quick brown\nfox jumps over\r\nthe lazy dog.').text, 'The quick brown fox jumps over the lazy dog.');
  assert.equal(joinLines('我们用\nPython 写，\n效果很好').text, '我们用Python 写，效果很好', 'next to Chinese there was no space before, so none is made up');
  assert.equal(joinLines('in 2026\n3 things').text, 'in 2026 3 things');
  assert.equal(joinLines('  缩进的行  \n\t另一行\t').text, '缩进的行另一行', 'spaces at the ends of lines go');
  assert.equal(joinLines('He said\n“hello”\nand left').text, 'He said “hello” and left', 'quotation marks in English text are not Chinese');
  assert.equal(joinLines('日本語の\nテキスト').text, '日本語のテキスト');
  assert.equal(joinLines('𠮷\n野家').text, '𠮷野家', 'a character outside the basic plane');
  assert.equal(joinLines(`第一行${LINE_SEP}第二行`).text, '第一行第二行');
});

test('joinLines: a word hyphenated at the end of a line is put together again', () => {
  assert.deepEqual(joinLines('the fox was run-\nning away'), { text: 'the fox was running away', lines: 2, paragraphs: 1, mended: 1 });
  assert.equal(joinLines('a state-of-the-\nart design').text, 'a state-of-the-art design', 'the hyphen of a compound stays');
  assert.equal(joinLines('the Anglo-\nSaxon world').text, 'the Anglo-Saxon world', 'so does one before a capital letter');
  assert.equal(joinLines('from 2020-\n2025').text, 'from 2020-2025');
  assert.equal(joinLines('items -\nand more').text, 'items - and more', 'a dash standing alone is not a broken word');
  assert.equal(joinLines('inter-\nnational co-\noperation').mended, 2);
});

test('joinLines: empty lines go, and what the text had is reported', () => {
  assert.deepEqual(joinLines('第一段第一行\n第一段第二行\n\n\n第二段\n'), { text: '第一段第一行第一段第二行第二段', lines: 3, paragraphs: 2, mended: 0 });
  assert.deepEqual(joinLines('only one line'), { text: 'only one line', lines: 1, paragraphs: 1, mended: 0 });
  assert.deepEqual(joinLines(''), { text: '', lines: 0, paragraphs: 0, mended: 0 });
  // 2,000 lines of 100 characters in well under a second
  const long = Array.from({ length: 2000 }, (_x, i) => `line ${i} `.padEnd(99, 'x') + '-').join('\n');
  const started = performance.now();
  assert.equal(joinLines(long).lines, 2000);
  assert.ok(performance.now() - started < 500, 'joining is linear in the length of the text');
});

test('a very long selection of one thing over and over is still read in a moment', () => {
  // each of these once made a pattern go over the same characters again and again
  const N = 200_000;
  const started = performance.now();
  assert.equal(sumNumbers('a'.repeat(N)).count, 0, 'looking for a mail address');
  assert.equal(sumNumbers('7'.repeat(N)).count, 0, 'one number of 200,000 digits is an identity number at best');
  assert.equal(sumNumbers('1 '.repeat(N / 2)).count, N / 2);
  assert.equal(sumNumbers('1 '.repeat(N / 2)).sum, '100,000');
  assert.equal(countText('\n'.repeat(N)).lines, 0);
  assert.equal(countText('x' + ' '.repeat(N) + 'y').chars, N + 2);
  assert.equal(joinLines('ab-\n'.repeat(N / 4)).mended, N / 4 - 1);
  assert.ok(performance.now() - started < 3000, `${Math.round(performance.now() - started)} ms`);
});

// ---------------------------------------------------------------- characters read back from a PDF

// 一二人大 and 风马车 as a browser-made PDF gives them back: Kangxi radicals and their supplement.
const RADICAL_WORDS = cp(0x2f00, 0x2f06, 0x2f08, 0x2f24) + cp(0x2edb) + '险' + cp(0x2ee2, 0x2ecb);

test('unifyRadicals: radical code points become the ordinary characters they are drawn as', () => {
  assert.equal(unifyRadicals(RADICAL_WORDS), '一二人大风险马车');
  assert.deepEqual([...unifyRadicals(RADICAL_WORDS)].map((c) => c.codePointAt(0)), [0x4e00, 0x4e8c, 0x4eba, 0x5927, 0x98ce, 0x9669, 0x9a6c, 0x8f66]);
  assert.equal(unifyRadicals(cp(0x2e9f, 0x2ef3, 0x2ed4, 0x2edd, 0x2fd5)), '母龟门食龠');
  const ordinary = '一二人大风险马车，ＡＢＣ　１２３ ① ㎡ fi é';
  assert.equal(unifyRadicals(ordinary), ordinary, 'nothing else is touched: no full-width forms, no ligatures, no symbols');
  assert.equal(unifyRadicals(''), '');
  assert.equal(unifyRadicals(undefined), '');
  let changed = 0;
  for (let c = 0x2e80; c <= 0x2fdf; c++) {
    const out = unifyRadicals(cp(c));
    assert.equal([...out].length, 1, c.toString(16));
    if (out === cp(c)) continue;
    changed++;
    assert.ok(out.codePointAt(0) >= 0x3400, `U+${c.toString(16)} becomes an ordinary character, not another radical`);
    assert.match(out, /^\p{Script=Han}$/u);
    assert.equal(unifyRadicals(out), out);
  }
  assert.equal(changed, 214 + 89, 'all 214 Kangxi radicals, and the 89 others that share a glyph with a character');
  // counting does not depend on it: a radical is a Chinese character like its twin
  assert.deepEqual(pick(countText(RADICAL_WORDS), 'total', 'han', 'chars'), { total: 8, han: 8, chars: 8 });
});

// ---------------------------------------------------------------- the actions on selected text

test('text actions: when each is offered', () => {
  const ids = (ctx) => offered(text, ctx);
  assert.deepEqual(ids(textCtx('今天天气不错')), ['text.count', 'text.polish']);
  assert.deepEqual(ids(textCtx('今天天气不错', { model: false })), ['text.count']);
  assert.deepEqual(ids(textCtx('第一行\n第二行', { model: false })), ['text.count', 'text.oneline']);
  assert.deepEqual(ids(textCtx('第一行\n\n', { model: false })), ['text.count'], 'a line break at the end is nothing to join');
  assert.deepEqual(ids(textCtx('收入 100，支出 60', { model: false })), ['text.sum', 'text.count']);
  assert.deepEqual(ids(textCtx('收入 100，增长 20%', { model: false })), ['text.count'], 'one number and one percentage are nothing to add up');
  assert.deepEqual(ids(textCtx('2026-11-13 12:30 13800138000', { model: false })), ['text.count'], 'a date, a time and a telephone number are no numbers to add');
  assert.deepEqual(ids(textCtx('12 15', { model: true })), ['text.sum', 'text.count'], 'nothing to polish in bare numbers');
  assert.deepEqual(ids(textCtx('字'.repeat(79))), ['text.count', 'text.polish'], 'too short to have points');
  assert.deepEqual(ids(textCtx('字'.repeat(80))), ['text.count', 'text.polish', 'text.summary']);
  assert.deepEqual(ids(textCtx(' a ')), [], 'one character is not a selection');
  assert.deepEqual(ids(filesCtx(['/nowhere/a.txt', '/nowhere/b.txt'])), [], 'not for files');
});

test('text actions: next to the existing ones, the fourth button is 数字求和 where there is something to add, 字数统计 otherwise', () => {
  const all = [...basic, ...text, ...docs];
  const prose = '今天讨论了第三季度的数据，大家认为华东区最好。'.repeat(4);
  assert.deepEqual(offered(all, textCtx(prose)).slice(0, 4), ['text.typeset', 'text.explain', 'text.translate', 'text.count']);
  assert.deepEqual(offered(all, textCtx(prose)).slice(4), ['text.polish', 'text.summary']);
  const withNumbers = `${prose}\n收入 1,902 万元，成本 1,200 万元。`;
  assert.deepEqual(offered(all, textCtx(withNumbers)).slice(0, 4), ['text.typeset', 'text.explain', 'text.translate', 'text.sum']);
  assert.deepEqual(offered(all, textCtx(withNumbers)).slice(4), ['text.count', 'text.polish', 'text.summary', 'text.oneline']);
  assert.deepEqual(offered(all, textCtx(withNumbers, { model: false })), ['text.typeset', 'text.sum', 'text.count', 'text.oneline']);
});

test('text.sum moves to the front when the selection is mostly numbers, also through Office.offers', () => {
  const sum = action('text.sum');
  const column = '苹果 12\n香蕉 15\n橘子 18.5';
  const prose = '今年的收入是 1,902 万元，比去年多了 300 万元，大家都很高兴。';
  assert.equal(sum.rankFor(textCtx(column)), RANK_SUM_FIRST);
  assert.equal(sum.rankFor(textCtx(prose)), RANK_SUM);
  // `rank` answers for the selection applies() saw last
  assert.equal(sum.applies(textCtx(column)), true);
  assert.equal(sum.rank, RANK_SUM_FIRST);
  assert.equal(sum.applies(textCtx(prose)), true);
  assert.equal(sum.rank, RANK_SUM);
  assert.equal(sum.applies(textCtx(column)), true);
  assert.equal(sum.applies(filesCtx(['/nowhere/a.txt'])), false);
  assert.equal(sum.rank, RANK_SUM, 'and is back in its usual place after anything else');
  assert.ok(RANK_SUM_FIRST < 10 && RANK_SUM > 30 && RANK_SUM < action('text.count').rank);

  // the real sorting, with every set of actions in the app
  const office = new Office({ documentsDir: root, tools: {} });
  const ids = (t, has) => office.offers(office.context({ text: t }), { office: false, ...has }).map((o) => o.id);
  assert.deepEqual(ids(column).slice(0, 4), ['text.sum', 'text.typeset', 'text.explain', 'text.translate']);
  assert.deepEqual(ids(prose).slice(0, 4), ['text.typeset', 'text.explain', 'text.translate', 'text.sum']);
  assert.deepEqual(ids(column).slice(0, 4), ['text.sum', 'text.typeset', 'text.explain', 'text.translate'], 'whatever was looked at before');
  assert.deepEqual(ids('今天讨论了数据，大家认为华东区最好。').slice(0, 4), ['text.typeset', 'text.explain', 'text.translate', 'text.count']);
  assert.deepEqual(ids(column, { model: false }), ['text.sum', 'text.typeset', 'text.count', 'text.oneline']);
});

test('text.count tells the counts and writes nothing', async () => {
  const r = await action('text.count').run(textCtx("你好，world！这是 2026-11-13 的 Q3 报告 v2。\n\n第二段 don't stop，共 1,234.5 元。"), {});
  assert.deepEqual(r, { kind: 'info', message: '字数 24（中文按字算，英文和数字按词算）\n字符 61，不计空格 52\n汉字 12，英文单词 5，数字 2\n行 2（另有空行 1），段落 2' });
});

test('text.sum tells count, sum, mean, largest and smallest, and offers the sum to copy', async () => {
  const ctx = textCtx('1. 华东 ¥ 3,899\n2. 华北 ¥ 1,000.5\n3. 华南 ¥ -200\n更新于 2026-11-13');
  assert.equal(action('text.sum').applies(ctx), true);
  const r = await action('text.sum').run(ctx, {});
  assert.deepEqual(r, { kind: 'info', message: '3 个数，合计 ¥4,699.5\n平均 ¥1,566.5，最大 ¥3,899，最小 ¥-200\n不算在内：1 个日期、3 个序号', copy: '4699.5' });
  const percent = await action('text.sum').run(textCtx('31% 和 12.5%'), {});
  assert.equal(percent.copy, '43.5%');
});

test('text.oneline joins the lines for the clipboard and says what it did', async () => {
  const ctx = textCtx('这是从 PDF 里复制的，\n每一行都断开了。\n\nThe exam-\nple continues\nhere.');
  assert.equal(action('text.oneline').applies(ctx), true);
  assert.deepEqual(await action('text.oneline').run(ctx, {}), {
    kind: 'clipboard',
    text: '这是从 PDF 里复制的，每一行都断开了。The example continues here.',
    message: '把 5 行合并成了一段，原来的 2 段也连在了一起，接上了 1 个在行尾用连字符断开的单词',
  });
  assert.equal((await action('text.oneline').run(textCtx('a\nb'), {})).message, '把 2 行合并成了一段');
});

test('text.polish and text.summary hand the model a precise instruction and the text', async () => {
  const passage = '  这段话有错别子，表达也不太通顺的。  ';
  const polish = await action('text.polish').run(textCtx(passage), {});
  assert.deepEqual(Object.keys(polish), ['kind', 'question']);
  assert.equal(polish.kind, 'ask');
  const [instruction, , body] = polish.question.split('\n');
  assert.match(instruction, /润色/);
  assert.match(instruction, /错别字/);
  assert.match(instruction, /不改变原意/);
  assert.match(instruction, /保持原来的语言/);
  assert.match(instruction, /只输出润色后的文字/);
  assert.equal(body, passage.trim());
  assert.equal(polish.question, `${instruction}\n\n${passage.trim()}`);

  // selected in a PDF: the model gets ordinary characters
  assert.ok((await action('text.polish').run(textCtx(RADICAL_WORDS), {})).question.endsWith('\n\n一二人大风险马车'));

  const long = '第一句话。'.repeat(30);
  const summary = await action('text.summary').run(textCtx(long), {});
  assert.deepEqual(Object.keys(summary), ['kind', 'question']);
  assert.match(summary.question.split('\n')[0], /3 到 5 条简短的要点/);
  assert.match(summary.question.split('\n')[0], /用原文的语言/);
  assert.ok(summary.question.endsWith(`\n\n${long}`));
});

test('text.polish and text.summary give the model the first 6000 characters, and say so', async () => {
  assert.equal(MODEL_CHARS, 6000);
  const exact = '好'.repeat(MODEL_CHARS);
  for (const id of ['text.polish', 'text.summary']) {
    const whole = await action(id).run(textCtx(exact), {});
    assert.equal(whole.note, undefined, id);
    assert.ok(whole.question.endsWith(`\n\n${exact}`), id);
    assert.ok(!whole.question.includes('只是它开头'), id);
    // one character too many, and a character outside the basic plane right at the cut
    const cut = await action(id).run(textCtx('好'.repeat(MODEL_CHARS - 1) + '𠮷' + '尾巴'), {});
    assert.equal(cut.note, '只处理了前 6000 字', id);
    assert.match(cut.question.split('\n')[0], /下面只是它开头的 6000 字，后面的没有给你/, id);
    assert.equal(cut.question.split('\n\n')[1], '好'.repeat(MODEL_CHARS - 1) + '𠮷', id);
  }
});

// ---------------------------------------------------------------- the actions on files

test('file actions: when each is offered', async () => {
  const dir = freshDir();
  for (const n of ['a.docx', 'b.docx', 'n.md', 't.txt', 'p.pdf', 'i.png', 's.csv', 'o.pptx']) fs.writeFileSync(path.join(dir, n), 'x');
  const at = (...names) => names.map((n) => path.join(dir, n));
  const ids = (ctx) => offered(docs, ctx);
  assert.deepEqual(ids(filesCtx(at('a.docx'))), ['word.count', 'doc.summary', 'word.text', 'word.images']);
  assert.deepEqual(ids(filesCtx(at('a.docx'), { model: false })), ['word.count', 'word.text', 'word.images']);
  for (const n of ['n.md', 't.txt', 'p.pdf']) {
    assert.deepEqual(ids(filesCtx(at(n))), ['doc.summary'], n);
    assert.deepEqual(ids(filesCtx(at(n), { model: false })), [], n);
  }
  for (const n of ['i.png', 's.csv', 'o.pptx']) assert.deepEqual(ids(filesCtx(at(n))), [], n);
  assert.deepEqual(ids(filesCtx(at('a.docx', 'b.docx'))), ['files.zip', 'files.names'], 'two Word documents are files to pack, not a document to count');
  assert.deepEqual(ids(filesCtx(at('i.png', 's.csv', 'o.pptx', 'p.pdf'))), ['files.zip', 'files.names'], 'any kinds');
  assert.deepEqual(ids(textCtx('a.docx\nb.docx')), [], 'not for text');
});

test('file actions: a Word document keeps 转成 PDF, 一键排版, then 字数统计 and 做成 PPT; 总结要点 leads the rest', () => {
  const dir = freshDir();
  for (const n of ['a.docx', 't.txt', 'n.md', 'b.pdf', 'c.pdf']) fs.writeFileSync(path.join(dir, n), 'x');
  const at = (...names) => names.map((n) => path.join(dir, n));
  const all = [...basic, ...text, ...docs];
  assert.deepEqual(offered(all, filesCtx(at('a.docx'))), ['files.pdf', 'word.restyle', 'word.count', 'files.pptx', 'doc.summary', 'word.markdown', 'word.text', 'word.images']);
  assert.deepEqual(offered(all, filesCtx(at('t.txt'))), ['file.typeset', 'files.pdf', 'files.pptx', 'doc.summary']);
  assert.deepEqual(offered(all, filesCtx(at('n.md'))), ['files.pdf', 'files.pptx', 'doc.summary']);
  assert.deepEqual(offered(all, filesCtx(at('a.docx', 't.txt', 'b.pdf'))), ['files.pdf', 'files.pptx', 'files.zip', 'files.names']);
  // the real sorting, with every set of actions in the app
  const office = new Office({ documentsDir: root, tools: {} });
  const ids = office.offers(office.context({ files: at('a.docx') }), { office: false, model: true }).map((o) => o.id);
  assert.deepEqual(ids.slice(0, 4), ['files.pdf', 'word.restyle', 'word.count', 'files.pptx']);
});

test('sizeText and uniqueName', () => {
  assert.equal(sizeText(812), '812 字节');
  assert.equal(sizeText(3482), '3.4 KB');
  assert.equal(sizeText(120 * 1024), '120 KB');
  assert.equal(sizeText(2.5 * 1024 * 1024), '2.5 MB');
  const taken = new Set();
  assert.deepEqual(['a.txt', 'a.txt', 'A.TXT', 'a (2).txt', 'b', 'b', '.env', '.env', 'x.tar.gz', 'x.tar.gz'].map((n) => uniqueName(n, taken)), ['a.txt', 'a (2).txt', 'A (3).TXT', 'a (2) (2).txt', 'b', 'b (2)', '.env', '.env (2)', 'x.tar.gz', 'x.tar (2).gz']);
});

test('files.zip: one flat DEFLATE archive next to the files, same bytes, same-named files kept apart', async () => {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'north'));
  fs.mkdirSync(path.join(dir, 'south'));
  const files = [path.join(dir, 'north', '报告.txt'), path.join(dir, 'south', '报告.txt'), path.join(dir, 'south', '报告.TXT.bak.txt'), path.join(dir, 'noise.bin.png'), path.join(dir, 'empty.md')];
  fs.writeFileSync(files[0], '北区的报告。'.repeat(2000));
  fs.writeFileSync(files[1], 'The southern report. '.repeat(1500));
  fs.writeFileSync(files[2], 'x');
  fs.writeFileSync(files[3], crypto.randomBytes(40_000)); // does not compress
  fs.writeFileSync(files[4], '');
  const when = new Date(2024, 1, 29, 13, 45, 10); // local time, with a leap day for good measure
  fs.utimesSync(files[0], when, when);
  const before = files.map(sha);
  const sizes = files.map((f) => fs.statSync(f).size);
  const total = sizes.reduce((a, b) => a + b, 0);

  const ctx = filesCtx(files);
  const { env, log } = makeEnv(path.join(dir, 'north'));
  const r = await action('files.zip').run(ctx, env);
  assert.equal(r.kind, 'file');
  assert.equal(r.path, path.join(dir, 'north', '报告 等 5 个文件.zip'));
  assert.deepEqual(log.saved, ['报告 等 5 个文件.zip']);

  const buf = fs.readFileSync(r.path);
  const entries = zipEntries(buf);
  assert.deepEqual(entries.map((e) => e.name), ['报告.txt', '报告 (2).txt', '报告.TXT.bak.txt', 'noise.bin.png', 'empty.md'], 'flat, in the order selected');
  assert.deepEqual(entries.map((e) => e.method), [8, 8, 8, 8, 0], 'DEFLATE for every file that has something in it');
  entries.forEach((e, i) => {
    assert.equal(e.size, sizes[i], e.name);
    assert.ok(e.read().equals(fs.readFileSync(files[i])), `${e.name}: the bytes that zlib gets out are the bytes of the file`);
  });
  assert.ok(Math.abs(entries[0].modified - when) <= 2000, `the archive shows the file's own local time: ${entries[0].modified}`);
  // and JSZip agrees
  const zip = await JSZip.loadAsync(buf);
  assert.ok((await zip.file('报告 (2).txt').async('nodebuffer')).equals(fs.readFileSync(files[1])));

  assert.equal(r.message, `把 5 个文件打包成了一个 ZIP：${sizeText(total)} → ${sizeText(buf.length)}（小了 ${Math.round((1 - buf.length / total) * 100)}%）。有 1 个文件和别的文件重名，在包里的名字后面加了序号。原文件没有改动。`);
  assert.ok(buf.length < total / 2 && buf.length > 40_000, 'text shrinks, noise does not');
  assert.deepEqual(files.map(sha), before, 'the originals are untouched');
  assert.deepEqual(log.steps.slice(0, 5).map((s) => [s.done, s.total, s.name]), files.map((f, i) => [i, 5, path.basename(f)]));
  assert.deepEqual(log.steps.at(-1), { done: 5, total: 5, name: '' });

  // again: a second archive, the first is not written over
  const again = await action('files.zip').run(ctx, env);
  assert.equal(again.path, path.join(dir, 'north', '报告 等 5 个文件 (2).zip'));
  assert.ok(fs.readFileSync(r.path).equals(buf));
});

test('files.zip: what does not shrink is not said to have shrunk', async () => {
  const dir = freshDir();
  const files = [path.join(dir, 'a.png'), path.join(dir, 'b.png')];
  for (const f of files) fs.writeFileSync(f, crypto.randomBytes(5000));
  const r = await action('files.zip').run(filesCtx(files), makeEnv(dir).env);
  const size = fs.statSync(r.path).size;
  assert.ok(size > 10_000);
  assert.equal(r.message, `把 2 个文件打包成了一个 ZIP：9.8 KB → ${sizeText(size)}。原文件没有改动。`);
});

test('files.zip: a file that cannot be read is named and left out; none readable, too large or stopped writes nothing', async () => {
  const dir = freshDir();
  const files = ['a.txt', 'b.txt', 'gone.txt'].map((n) => path.join(dir, n));
  for (const f of files) fs.writeFileSync(f, `content of ${path.basename(f)}`);
  const ctx = filesCtx(files);
  fs.rmSync(files[2]);
  const { env } = makeEnv(dir);
  const r = await action('files.zip').run(ctx, env);
  assert.equal(path.basename(r.path), 'a 等 2 个文件.zip', 'named after what is in it');
  assert.deepEqual(zipEntries(fs.readFileSync(r.path)).map((e) => e.name), ['a.txt', 'b.txt']);
  assert.match(r.message, /^把 2 个文件打包成了一个 ZIP：/);
  assert.match(r.message, /没能读取、没有放进去：gone\.txt。/);
  fs.rmSync(r.path);

  fs.rmSync(files[0]);
  fs.rmSync(files[1]);
  await assert.rejects(action('files.zip').run(ctx, env), { message: '选中的文件一个也读不了' });
  assert.deepEqual(fs.readdirSync(dir), []);

  // a file that claims to be larger than the limit (sparse: it takes no room on the disk)
  fs.writeFileSync(files[0], 'small');
  fs.writeFileSync(files[1], '');
  fs.truncateSync(files[1], ZIP_LIMIT + 1);
  const large = filesCtx([files[0], files[1]]);
  await assert.rejects(action('files.zip').run(large, env), { message: '这 2 个文件一共 500.0 MB，超过了一次能打包的 500.0 MB' });
  fs.truncateSync(files[1], 10);

  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(action('files.zip').run(large, makeEnv(dir, {}, stopped.signal).env), { message: '已取消' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.txt', 'b.txt']);
});

test('files.names: the names, one per line, for the clipboard', async () => {
  const ctx = filesCtx(['/data/north/报告.docx', '/data/south/报告.docx', '/data/图 1.png']);
  assert.deepEqual(await action('files.names').run(ctx, {}), { kind: 'clipboard', text: '报告.docx\n报告.docx\n图 1.png', message: '复制了 3 个文件名，每行一个' });
});

test('docxText: paragraphs are lines, line breaks and tabs are kept, a table row is a line', async () => {
  const dir = freshDir();
  const file = await makeDocx(path.join(dir, 'known.docx'), KNOWN_BODY, { 'image1.png': PNG });
  let tree;
  await mammoth.convertToHtml({ path: file }, { transformDocument: (d) => ((tree = d), d) });
  assert.deepEqual(docxText(tree), { text: KNOWN_TEXT, paragraphs: 10, tables: 1, pictures: 1, numbered: 2 });
  assert.deepEqual(docxText(tree, { tables: 'cells' }), { text: KNOWN_TEXT.replace('指标\t数值\n收入\t1,902', '指标\n数值\n收入\n1,902'), paragraphs: 10, tables: 1, pictures: 1, numbered: 2 });
  // what mammoth's own plain text makes of the same document: the line break is lost
  assert.match((await mammoth.extractRawText({ path: file })).value, /Helloworld/);

  // a cell with two paragraphs and a line break stays one cell of its row; a table in a table
  const nested = await makeDocx(path.join(dir, 'nested.docx'), table([cell(para(run('甲')), para(run('乙') + lineBreak + run('丙'))), cell(table([cell(para(run('内 1'))), cell(para(run('内 2')))]), para(''))]) + para(''));
  await mammoth.convertToHtml({ path: nested }, { transformDocument: (d) => ((tree = d), d) });
  assert.deepEqual(docxText(tree), { text: '甲 乙 丙\t内 1 内 2', paragraphs: 4, tables: 2, pictures: 0, numbered: 0 });
});

test('word.count: the numbers of a known document, the body only', async () => {
  const dir = freshDir();
  const file = await makeDocx(path.join(dir, 'known.docx'), KNOWN_BODY, { 'image1.png': PNG });
  const before = sha(file);
  const { env, log } = makeEnv(dir);
  const r = await action('word.count').run(filesCtx([file]), env);
  // 字数: 22 Chinese characters, "，" and "。", four words (Hello, world, a, b), two numbers (100; 1,902)
  // 字符: 6 + 5 + 9 + 7 ("a", tab, "b 100") + 2 + 2 + 2 + 5 + 3 + 3 + 2; the tab and one space are spaces
  // 段落: title, Hello/world, a b 100, four cells, two numbered ones, 结束; not the empty one, not the picture
  assert.deepEqual(r, { kind: 'info', message: '字数 30（中文按字算，英文和数字按词算）\n字符 46，不计空格 44\n汉字 22，英文单词 4，数字 2\n段落 10\n表格 1，图片 1\n只算正文，页眉、页脚、脚注和批注不在内' });
  assert.deepEqual([log.saved, log.folders], [[], []], 'nothing is written');
  assert.equal(sha(file), before);
});

test('word.text: the text as a txt next to the document, and what was left behind', async () => {
  const dir = freshDir();
  const file = await makeDocx(path.join(dir, '年报.docx'), KNOWN_BODY, { 'image1.png': PNG });
  const before = sha(file);
  const { env } = makeEnv(dir);
  const r = await action('word.text').run(filesCtx([file]), env);
  assert.equal(r.kind, 'file');
  assert.equal(r.path, path.join(dir, '年报.txt'));
  assert.equal(fs.readFileSync(r.path, 'utf8'), KNOWN_TEXT + '\n');
  assert.equal(r.message, '导出了 10 段文字，共 44 个字符（不计空格）。1 个表格按行导出，同一行的格子之间用制表符隔开。有 2 段的自动编号或项目符号没有带过去。1 张图片没有带过去。字体和版式没有保留，页眉、页脚和脚注不在内。');
  assert.equal(sha(file), before);
  assert.equal((await action('word.text').run(filesCtx([file]), env)).path, path.join(dir, '年报 (2).txt'), 'never over a file');

  const plain = await makeDocx(path.join(dir, 'plain.docx'), para(run('只有一句话。')));
  assert.equal((await action('word.text').run(filesCtx([plain]), env)).message, '导出了 1 段文字，共 6 个字符（不计空格）。字体和版式没有保留，页眉、页脚和脚注不在内。');
});

test('word.images: every stored picture, byte for byte, under its own name in a new folder', async () => {
  const dir = freshDir();
  const jpeg = crypto.randomBytes(3000);
  const emf = crypto.randomBytes(700);
  const film = crypto.randomBytes(1200);
  // stored out of order, and more than nine of them would sort wrongly as text
  const media = { 'image10.jpeg': jpeg, 'image2.emf': emf, 'image1.png': PNG, 'media1.mp4': film };
  const file = await makeDocx(path.join(dir, '年报.docx'), para(picture('rIdM3')) + para(picture('rIdM1')) + para(run('两张图')), media);
  const before = sha(file);
  const { env, log } = makeEnv(dir);
  const r = await action('word.images').run(filesCtx([file]), env);
  assert.equal(r.kind, 'folder');
  assert.equal(r.path, path.join(dir, '年报 图片'));
  assert.deepEqual(fs.readdirSync(r.path).sort(), ['image1.png', 'image10.jpeg', 'image2.emf', 'media1.mp4']);
  for (const [name, bytes] of Object.entries(media)) assert.ok(fs.readFileSync(path.join(r.path, name)).equals(bytes), name);
  assert.equal(r.message, `导出了 3 张图片和 1 个不是图片的文件（文档里嵌的音视频等），共 ${sizeText(3000 + 700 + PNG.length + 1200)}：是文档里存的原件，没有重新压缩，文件名也是文档里的。其中 1 个是 EMF/WMF 矢量图，一般的看图软件打不开。`);
  assert.deepEqual(log.steps.map((s) => s.name), ['image1.png', 'image2.emf', 'image10.jpeg', 'media1.mp4', ''], 'in the order of their numbers');
  assert.equal(sha(file), before);
  assert.equal((await action('word.images').run(filesCtx([file]), env)).path, path.join(dir, '年报 图片 (2)'), 'a second folder, not the first again');

  const one = await makeDocx(path.join(dir, 'one.docx'), para(picture('rIdM1')), { 'image1.png': PNG });
  assert.equal((await action('word.images').run(filesCtx([one]), env)).message, `导出了 1 张图片，共 ${PNG.length} 字节：是文档里存的原件，没有重新压缩，文件名也是文档里的。`);
});

test('word.images: names from inside the document cannot leave the folder or collide', async () => {
  const dir = freshDir();
  const file = path.join(dir, 'odd.docx');
  const zip = await JSZip.loadAsync(fs.readFileSync(await makeDocx(file, para(run('x')))));
  zip.file('word/media/a:b?.png', Buffer.from('one'));
  zip.file('word/media/A_B_.PNG', Buffer.from('two'));
  zip.file('word/media/..\\..\\escape.png', Buffer.from('three'));
  zip.file('word/media/sub/deep.png', Buffer.from('four'));
  zip.file('word/embeddings/sheet.xlsx', Buffer.from('five'));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  const r = await action('word.images').run(filesCtx([file]), makeEnv(dir).env);
  const made = fs.readdirSync(r.path);
  assert.equal(made.length, 2, made.join(', '));
  assert.ok(made.every((n) => /^a_b_( \(2\))?\.png$/i.test(n)), `characters a file name cannot have are replaced: ${made.join(', ')}`);
  assert.equal(new Set(made.map((n) => n.toLowerCase())).size, 2, 'names that differ only in case are kept apart');
  assert.deepEqual(made.map((n) => fs.readFileSync(path.join(r.path, n), 'utf8')).sort(), ['one', 'two']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['odd 图片', 'odd.docx'], 'nothing outside the new folder');
  assert.match(r.message, /^导出了 2 张图片，共 6 字节/);
});

test('Word actions refuse what they cannot read, in plain words, and leave nothing behind', async () => {
  const dir = freshDir();
  const noPictures = await makeDocx(path.join(dir, 'text-only.docx'), para(run('没有图片的文档')));
  const empty = await makeDocx(path.join(dir, 'empty.docx'), para('') + para(''));
  const broken = path.join(dir, 'broken.docx');
  fs.writeFileSync(broken, 'this is not a Word document');
  const gone = path.join(dir, 'gone.docx');
  fs.writeFileSync(gone, 'x');
  const goneCtx = filesCtx([gone]);
  fs.rmSync(gone);
  const { env, log } = makeEnv(dir);
  const listing = fs.readdirSync(dir).sort();

  await assert.rejects(action('word.images').run(filesCtx([noPictures]), env), { message: '这个文档里没有图片' });
  await assert.rejects(action('word.text').run(filesCtx([empty]), env), { message: '这个文档的正文里没有文字' });
  assert.equal((await action('word.count').run(filesCtx([empty]), env)).message.split('\n')[0], '字数 0（中文按字算，英文和数字按词算）');
  for (const id of ['word.count', 'word.text', 'word.images']) {
    await assert.rejects(action(id).run(filesCtx([broken]), env), { message: '打不开这个 Word 文档：broken.docx（可能已损坏、设了打开密码，或者不是真正的 .docx）' }, id);
  }
  await assert.rejects(action('doc.summary').run(filesCtx([broken]), env), /打不开这个 Word 文档：broken\.docx/);
  await assert.rejects(action('word.count').run(goneCtx, env), { message: '读不了这个文件：gone.docx' });
  assert.deepEqual(fs.readdirSync(dir).sort(), listing);
  assert.deepEqual([log.saved, log.folders], [[], []]);

  // stopped while the pictures are being written: the half-made folder is taken away
  const two = await makeDocx(path.join(dir, 'two.docx'), para(run('x')), { 'image1.png': PNG, 'image2.png': PNG });
  const stop = new AbortController();
  const stopping = makeEnv(dir, {}, stop.signal);
  stopping.env.step = (done) => done === 0 && stop.abort(); // while the first of the two is written
  await assert.rejects(action('word.images').run(filesCtx([two]), stopping.env), { message: '已取消' });
  assert.deepEqual(fs.readdirSync(dir).sort(), [...listing, 'two.docx'].sort());
});

test('doc.summary: a short document goes to the model whole', async () => {
  const dir = freshDir();
  const txt = path.join(dir, '纪要.txt');
  fs.writeFileSync(txt, '会议纪要\r\n\r\n\r\n\r\n今天讨论了第三季度的数据。   \r\n大家认为华东区最好。\r\n');
  const r = await action('doc.summary').run(filesCtx([txt]), makeEnv(dir).env);
  assert.deepEqual(r, { kind: 'ask', question: '下面是文档《纪要.txt》的全部文字。用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；只输出要点，不要开场白。\n\n会议纪要\n\n今天讨论了第三季度的数据。\n大家认为华东区最好。' });

  const md = path.join(dir, 'notes.md');
  fs.writeFileSync(md, '# 发布计划\n\n- 十二月上线\n');
  assert.ok((await action('doc.summary').run(filesCtx([md]), makeEnv(dir).env)).question.endsWith('的全部文字。用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；只输出要点，不要开场白。\n\n# 发布计划\n\n- 十二月上线'));

  const docx = await makeDocx(path.join(dir, 'known.docx'), KNOWN_BODY, { 'image1.png': PNG });
  const word = await action('doc.summary').run(filesCtx([docx]), makeEnv(dir).env);
  assert.equal(word.note, undefined);
  assert.equal(word.question.slice(word.question.indexOf('\n\n') + 2), KNOWN_TEXT, 'a Word document as its text, tables row by row');

  // old Chinese text files are GB18030, and files from Windows may be UTF-16
  const gbk = path.join(dir, 'gbk.txt');
  fs.writeFileSync(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4])); // 中文
  assert.ok((await action('doc.summary').run(filesCtx([gbk]), makeEnv(dir).env)).question.endsWith('\n\n中文'));
  const utf16 = path.join(dir, 'utf16.txt');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('双字节', 'utf16le')]));
  assert.ok((await action('doc.summary').run(filesCtx([utf16]), makeEnv(dir).env)).question.endsWith('\n\n双字节'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['gbk.txt', 'known.docx', 'notes.md', 'utf16.txt', '纪要.txt'], 'nothing is written');
});

test('doc.summary: of a longer document the model gets the first 4000 characters, is told so first, and the result carries the note', async () => {
  assert.equal(SUMMARY_CHARS, 4000);
  const dir = freshDir();
  const exact = path.join(dir, 'exact.txt');
  fs.writeFileSync(exact, '字'.repeat(4000) + '\n\n');
  const whole = await action('doc.summary').run(filesCtx([exact]), makeEnv(dir).env);
  assert.equal(whole.note, undefined, 'exactly 4000 characters are all read');
  assert.ok(whole.question.endsWith('\n\n' + '字'.repeat(4000)));

  const longer = path.join(dir, 'longer.txt');
  fs.writeFileSync(longer, '字'.repeat(3999) + '𠮷' + '后面的内容');
  const cut = await action('doc.summary').run(filesCtx([longer]), makeEnv(dir).env);
  assert.deepEqual(Object.keys(cut), ['kind', 'question', 'note']);
  assert.equal(cut.note, '只读了前 4000 字');
  const [first, , body, ...rest] = cut.question.split('\n');
  assert.equal(first, '下面是文档《longer.txt》开头的 4000 字（文档更长，后面的内容没有给你）。只根据这一部分，用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；最后另起一行写上“（只读了前 4000 字）”。');
  assert.equal(body, '字'.repeat(3999) + '𠮷', 'cut between characters, not inside one');
  assert.deepEqual(rest, []);

  const docx = await makeDocx(path.join(dir, 'long.docx'), Array.from({ length: 300 }, (_x, i) => para(run(`第 ${i + 1} 段，这一段有二十个字左右的内容。`))).join(''));
  const word = await action('doc.summary').run(filesCtx([docx]), makeEnv(dir).env);
  assert.equal(word.note, '只读了前 4000 字');
  assert.equal([...word.question.slice(word.question.indexOf('\n\n') + 2)].length, 4000);
});

test('doc.summary: of a very large text file only the beginning is read', async () => {
  const dir = freshDir();
  const big = path.join(dir, 'big.log');
  // more than 256 KB of three-byte characters, so that the piece read ends inside a character
  const line = '日志的一行，写了又写。\n';
  fs.writeFileSync(big, line.repeat(12_000));
  assert.ok(fs.statSync(big).size > 256 * 1024 && (256 * 1024) % 3 !== 0);
  const r = await action('doc.summary').run(filesCtx([big]), makeEnv(dir).env);
  assert.equal(r.note, '只读了前 4000 字');
  const body = r.question.slice(r.question.indexOf('\n\n') + 2);
  assert.equal([...body].length, 4000);
  assert.ok(line.repeat(400).startsWith(body), 'decoded as UTF-8 although the piece ends in the middle of a character');

  const gbk = path.join(dir, 'big-gbk.txt');
  fs.writeFileSync(gbk, Buffer.concat(Array.from({ length: 90_000 }, () => Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))));
  const old = await action('doc.summary').run(filesCtx([gbk]), makeEnv(dir).env);
  assert.equal(old.question.slice(old.question.indexOf('\n\n') + 2), '中文'.repeat(2000));
});

test('doc.summary: a PDF is read page by page through the hidden page, only as far as needed, and closed', async () => {
  const dir = freshDir();
  const file = path.join(dir, '论文.pdf');
  fs.writeFileSync(file, '%PDF-1.7 stand-in');
  const calls = [];
  const pdfOf = (pages) => async (given) => {
    calls.push(`open ${path.basename(given)}`);
    return {
      pages: pages.length,
      text: async (n) => {
        calls.push(`text ${n}`);
        return pages[n - 1];
      },
      close: async () => calls.push('close'),
    };
  };
  const short = makeEnv(dir, { openPdf: pdfOf(['Title  \n\n\n\nFirst page.', '', `  Third page. ${RADICAL_WORDS}\n`]) });
  const whole = await action('doc.summary').run(filesCtx([file]), short.env);
  assert.deepEqual(whole, { kind: 'ask', question: '下面是文档《论文.pdf》的全部文字。用 3 到 5 条简短的要点总结，每条一行，用文档本身的语言；只输出要点，不要开场白。\n\nTitle\n\nFirst page.\nThird page. 一二人大风险马车' });
  assert.deepEqual(calls, ['open 论文.pdf', 'text 1', 'text 2', 'text 3', 'close']);
  assert.deepEqual(short.log.steps.map((s) => [s.done, s.total, s.name]), [[0, 3, '第 1 页'], [1, 3, '第 2 页'], [2, 3, '第 3 页']]);

  calls.length = 0;
  const pages = Array.from({ length: 40 }, (_x, i) => `Page ${i + 1}. ` + 'word '.repeat(600)); // about 3000 characters a page
  const long = await action('doc.summary').run(filesCtx([file]), makeEnv(dir, { openPdf: pdfOf(pages) }).env);
  assert.equal(long.note, '只读了前 4000 字');
  assert.match(long.question.split('\n')[0], /^下面是文档《论文\.pdf》开头的 4000 字（文档更长，后面的内容没有给你）。/);
  const body = long.question.slice(long.question.indexOf('\n\n') + 2);
  assert.ok(body.length <= 4000 && body.length > 3990 && body.startsWith('Page 1. word word') && body.includes('\nPage 2. word'));
  assert.deepEqual(calls, ['open 论文.pdf', 'text 1', 'text 2', 'text 3', 'close'], 'the other 37 pages are not read');

  calls.length = 0;
  await assert.rejects(action('doc.summary').run(filesCtx([file]), makeEnv(dir, { openPdf: pdfOf([]) }).env), { message: '这个 PDF 里没有页面' });
  assert.equal(calls.at(-1), 'close', 'closed also on a zero-page PDF');

  calls.length = 0;
  await assert.rejects(action('doc.summary').run(filesCtx([file]), makeEnv(dir, { openPdf: pdfOf(['', ' \n ']) }).env), { message: '这个 PDF 里没有可以提取的文字（可能是扫描件）' });
  assert.equal(calls.at(-1), 'close', 'closed also when it fails');
  await assert.rejects(action('doc.summary').run(filesCtx([file]), makeEnv(dir, { openPdf: async () => Promise.reject(new Error('打不开这个 PDF：坏了')) }).env), { message: '打不开这个 PDF：坏了' });

  const blank = path.join(dir, 'blank.txt');
  fs.writeFileSync(blank, ' \n\n ');
  await assert.rejects(action('doc.summary').run(filesCtx([blank]), makeEnv(dir).env), { message: '这个文档里没有文字' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['blank.txt', '论文.pdf']);
});

test('every action is described the way the panel needs it', () => {
  const all = [...text, ...docs];
  assert.deepEqual(all.map((a) => a.id).sort(), ['doc.summary', 'files.names', 'files.zip', 'text.count', 'text.oneline', 'text.polish', 'text.sum', 'text.summary', 'word.count', 'word.images', 'word.text']);
  for (const a of all) {
    assert.match(a.label, /^[一-鿿A-Z ]{2,8}$/, `${a.id}: a short Chinese label`);
    assert.ok(a.hint.length >= 6 && a.hint.length <= 40 && /[一-鿿]/.test(a.hint), `${a.id}: a hint in a few words`);
    assert.ok(Number.isFinite(a.rank), a.id);
    assert.equal(typeof a.applies, 'function', a.id);
    assert.equal(typeof a.run, 'function', a.id);
    assert.equal(a.applies({ kind: 'files', files: [], text: '', has: {} }), false, `${a.id}: nothing selected`);
    assert.equal(a.applies({ kind: 'text', files: [], text: '', has: {} }), false, `${a.id}: no text`);
  }
  const ids = [...basic, ...all].map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'no id is used twice');
});

test('scientific notation, hex literals, UUIDs and overflowing exponents in number stats and word counts', () => {
  const sci = sumNumbers('样本 1.5e3 元，补差 2.5E-4 元，再加 500 元，扣除 -2e2 元');
  assert.equal(sci.count, 4);
  assert.equal(sci.sum, '1,800.00025');
  assert.equal(sci.plain, '1800.00025');

  const tiny = sumNumbers('误差 2e-4 与 3e-4');
  assert.deepEqual(pick(tiny, 'count', 'sum', 'plain', 'mean'), { count: 2, sum: '0.0005', plain: '0.0005', mean: '0.00025' });

  // Huge exponents (or hex-like 550e8400), 0x hex codes and UUIDs are treated as codes, never torn or turned into Infinity.
  const noisy = sumNumbers('请求 550e8400-e29b-41d4-a716-446655440000 状态 0x1f 溢出 1e500 片段 550e8400 实付 120 和 80');
  assert.deepEqual(pick(noisy, 'count', 'sum', 'plain'), { count: 2, sum: '200', plain: '200' });
  assert.equal(noisy.skipped.code, 4);

  // Scientific notation is counted as numbers, not English words.
  const counted = countText('阈值 1.5e3 与 2E-4');
  assert.deepEqual(pick(counted, 'han', 'words', 'numbers'), { han: 3, words: 0, numbers: 2 });
});
