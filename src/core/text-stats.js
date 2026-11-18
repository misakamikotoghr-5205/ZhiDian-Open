// Counting and adding up, for the quick actions on selected text and on documents: how many
// characters, Chinese characters, words and numbers a text has; which of the numbers written in
// it are quantities and what they add up to; and joining broken lines into one paragraph.
// Pure functions and fixed rules, no model involved: the same text always gives the same answer.

const LATIN = 'A-Za-z\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f';
const re = (src, flags = 'g') => new RegExp(src, flags);

/** 1234567 -> "1,234,567" */
export const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** ０-９ become 0-9; the string keeps its length. */
const narrowDigits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// ---------------------------------------------------------------- counting

const INVISIBLE = /[\u200b\u2060\ufeff\u00ad]/g; // zero-width space, word joiner, byte order mark, soft hyphen
const LINE_BREAK = /\r\n?|[\u2028\u2029\u0085\u000b\u000c]/g;
// A word: Latin letters, with digits, apostrophes and hyphens inside ("don't", "GPT-4", "Q3").
const WORD = re(`[${LATIN}][${LATIN}0-9]*(?:['’-][${LATIN}0-9]+)*`);
// A number: digits that are written together ("1,234.5", "2026-11-13", "12:30").
const DIGIT_RUN = /\d+(?:[.,:/-]\d+)*/g;
// Characters that are one "字" each: Chinese characters, kana, Chinese and full-width punctuation.
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3001-\u303f\uff01-\uff60\uffe0-\uffe6]/u;
// Punctuation that belongs to the Chinese or to the Latin text, whichever it stands in.
const LOOSE = /[“”‘’—…·]/;

let graphemes = null;

/** "字数" the way word processors count it: a Chinese character or mark is one, a word is one. */
function countUnits(s) {
  let total = 0;
  for (const run of s.match(/\S+/g) ?? []) {
    const chars = [...run];
    let inWord = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (WIDE.test(c)) {
        total++;
        inWord = false;
      } else if (LOOSE.test(c)) {
        if (inWord) continue; // “hello” is one word, quotes and all
        const next = chars[i + 1];
        total++;
        inWord = next !== undefined && !WIDE.test(next) && !LOOSE.test(next);
      } else if (!inWord) {
        total++;
        inWord = true;
      }
    }
  }
  return total;
}

/**
 * What a text holds.
 *   total         "字数": each Chinese character or Chinese punctuation mark counts one, each
 *                 word or number written in Latin letters or digits counts one
 *   chars         characters as a person sees them (an emoji or an accented letter is one),
 *                 spaces included, line breaks not
 *   charsNoSpace  the same without spaces and tabs
 *   han           Chinese characters (no punctuation)
 *   words         words in Latin letters
 *   numbers       numbers: digits written together are one ("1,234.5", "2026-11-13"); digits
 *                 inside a word ("Q3") belong to the word
 *   lines         lines that have something on them
 *   blankLines    empty lines between them
 *   paragraphs    blocks of lines separated by empty lines; in a text without empty lines every
 *                 line is a paragraph, as it is in a word processor
 * @param {string} text
 */
export function countText(text) {
  const s = String(text ?? '').replace(INVISIBLE, '').replace(LINE_BREAK, '\n');
  graphemes ??= new Intl.Segmenter('zh', { granularity: 'grapheme' });
  let chars = 0;
  let charsNoSpace = 0;
  for (const { segment } of graphemes.segment(s)) {
    if (segment === '\n') continue;
    chars++;
    if (/\S/.test(segment)) charsNoSpace++;
  }
  // The lines, without the empty ones before the first and after the last that has something.
  const all = s.split('\n').map((l) => l.trim());
  let first = 0;
  let last = all.length;
  while (first < last && !all[first]) first++;
  while (last > first && !all[last - 1]) last--;
  const rows = all.slice(first, last);
  const lines = rows.filter(Boolean).length;
  const blankLines = rows.length - lines;
  const blocks = rows.filter((l, i) => l && !rows[i - 1]).length;
  const narrow = narrowDigits(s);
  const withoutSci = narrow.replace(/(?<![A-Za-z_\d])\d+(?:\.\d+)?[eE][+-]?\d+(?![A-Za-z_\d])/g, '0');
  return {
    total: countUnits(s),
    chars,
    charsNoSpace,
    han: (s.match(/\p{Script=Han}/gu) ?? []).length,
    words: (withoutSci.match(WORD) ?? []).length,
    numbers: (withoutSci.replace(WORD, ' ').match(DIGIT_RUN) ?? []).length,
    lines,
    blankLines,
    paragraphs: blankLines ? blocks : lines,
  };
}

/**
 * The counts in a few lines. Every line starts with what it counts, so that it also reads
 * correctly where the lines are shown run together.
 * @param {ReturnType<typeof countText>} c
 * @param {{ lines?: boolean }} [o]  lines: false leaves the line count out (a Word document has
 *                                   no lines until it is laid out)
 */
export function describeCount(c, { lines = true } = {}) {
  const out = [
    `字数 ${grouped(c.total)}（中文按字算，英文和数字按词算）`,
    `字符 ${grouped(c.chars)}，不计空格 ${grouped(c.charsNoSpace)}`,
    `汉字 ${grouped(c.han)}，英文单词 ${grouped(c.words)}，数字 ${grouped(c.numbers)}`,
  ];
  if (lines) out.push(`行 ${grouped(c.lines)}${c.blankLines ? `（另有空行 ${grouped(c.blankLines)}）` : ''}，段落 ${grouped(c.paragraphs)}`);
  else out.push(`段落 ${grouped(c.paragraphs)}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- the numbers in a text

const MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const YEAR = '(?:19|20)\\d{2}';
const MONTH = '(?:0?[1-9]|1[0-2])';
const DAY = '(?:0?[1-9]|[12]\\d|3[01])';
const DAY_RANGE = `(?:\\s?[-–~至到]\\s?${DAY})?`; // 13-15日
const END = '[^\\s\\u3000<>"\'，。；！？、）】」』]';
// Not glued to more digits: "x,2026-11-13." is a date between punctuation, "1,2026" is not.
const ALONE_BEFORE = '(?<!\\d|\\d[.,])';
const ALONE_AFTER = '(?!\\d|[.,]\\d)';

// What is written with digits but is not a quantity. Each kind is taken out of the text in this
// order before the numbers are read; the name is the reason given to the person.
const NOT_QUANTITIES = [
  // web and mail addresses
  ['code', re(`\\b(?:https?|ftp|file)://${END}+`, 'gi')],
  ['code', re(`\\bwww\\.${END}+`, 'gi')],
  ['code', /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g], // from the start of the name only: no going over it again from every letter
  // 2026-11-13, 2026/11/13, 2026.11.13, 2026-11, 11/13/2026
  ['date', re(`${ALONE_BEFORE}${YEAR}([-/.])${MONTH}\\1${DAY}(?!\\d)`)],
  ['date', re(`${ALONE_BEFORE}${YEAR}[-/](?:0[1-9]|1[0-2])(?![\\d/-])`)],
  ['date', re(`(?<![\\d/])\\d{1,2}/\\d{1,2}/${YEAR}(?![\\d/])`)],
  // 2026年11月13日, 2026年11月, 2026年, 2020-2025年, 11月13日, 11月
  ['date', re(`${ALONE_BEFORE}(?:${YEAR}\\s?[-–~至到]\\s?)?${YEAR}\\s?年(?:\\s?${MONTH}\\s?月(?:\\s?${DAY}${DAY_RANGE}\\s?[日号])?)?`)],
  ['date', re(`${ALONE_BEFORE}${MONTH}\\s?月\\s?${DAY}${DAY_RANGE}\\s?[日号]`)],
  ['date', re(`${ALONE_BEFORE}${MONTH}\\s?月(?!\\d)`)],
  // Nov 13, 2026 / 13 November 2026 / November 2026
  ['date', re(`\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s?[-–]\\s?\\d{1,2})?(?:,?\\s+${YEAR})?\\b`)],
  ['date', re(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}(?:,?\\s+${YEAR})?(?![A-Za-z\\d])`)],
  ['date', re(`\\b${MONTHS},?\\s+${YEAR}\\b`)],
  // 12:30, 9:05:07
  ['time', /(?<![\d:.])(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?![\d:])/g],
  // mobile and landline numbers; a mobile-like run with a currency sign or a money unit is money
  ['phone', /(?<!\d|\d[.,]|[¥￥$€£]\s?)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d|[.,]\d|\s?(?:[元块万亿]|美元))/g],
  ['phone', /(?<![\d-])1[3-9]\d[-\s]\d{4}[-\s]\d{4}(?![\d-])/g],
  ['phone', /(?<![\d-])\(?0\d{2,3}\)?[-\s]\d{7,8}(?![\d-])/g],
  ['phone', /(?<![\d-])[48]00-\d{3,4}-\d{3,4}(?![\d-])/g],
  // version strings (1.2.3), hex literals, UUIDs, identity and card numbers
  ['code', /(?<!\d|\d\.)\d+(?:\.\d+){2,}(?!\d|\.\d)/g],
  ['code', /\b0[xX][0-9a-fA-F]+\b/g],
  ['code', /\b[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\b/g],
  ['code', re(`${ALONE_BEFORE}\\d{15,}[Xx]?${ALONE_AFTER}`)],
  // "1." "2、" "3)" "(4)" at the start of a line with something after it: list markers.
  // "1.5", "100、200" and a line that is only "3." are not.
  ['marker', /^[ \t\u3000]*(?:[(（]\d{1,3}[)）]|\d{1,3}(?:[.)）](?!\d)|、(?!\s*\d)))(?=[ \t\u3000]*\S)/gm],
];

const NUMBER = /([1-9]\d{0,2}(?:,\d{3})+(?!\d)|\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+)(?![A-Za-z0-9_]))?/g;
const MONEY_BEFORE = /(US\$|HK\$|NT\$|[¥￥$€£₩₹₽]|(?<![A-Za-z])(?:USD|RMB|CNY|EUR|GBP|JPY|HKD))\s{0,2}$/i;
// 万, 亿, k ... are kept as written, never multiplied in. 千克, 千米, kg, km are not thousands.
const UNIT_AFTER = /^\s?(万亿|千万|百万|万|亿|千(?![克米瓦卡帕赫升吨焦伏安])|[kKw](?![A-Za-z]))?(元|块钱|块|美元|美金|欧元|日元|英镑|港元|港币|人民币|韩元)?/;

const CURRENCY = { '￥': '¥', RMB: '¥', CNY: '¥', US$: 'USD' }; // the same money under different marks

/** Full-width digits and signs to their ordinary forms, one character for one. */
function narrowNumbers(text) {
  return narrowDigits(text.replace(/(?<=[０-９])，(?=[０-９]{3}(?![０-９]))/g, ','))
    .replace(/[％﹪]/g, '%')
    .replace(/[－−﹣]/g, '-')
    .replace(/＋/g, '+')
    .replace(/．/g, '.')
    .replace(/／/g, '/')
    .replace(/＄/g, '$')
    .replace(/(?<=\d)：(?=\d)/g, ':');
}

/**
 * The quantities written in a text.
 *
 * Read as numbers: 1,234.5, -3, +3, 负5, 50%, ¥ 3,899, 1,902万元 (as 1902: units are kept as
 * a label, never multiplied in), full-width digits. A hyphen between two things ("3-5",
 * "2020-2025") is not a minus sign.
 *
 * Not read as numbers, and counted in `skipped` by reason:
 *   date    2026-11-13, 2026年11月13日, 11月, Nov 13, 2026
 *   time    12:30
 *   phone   13800138000, 010-12345678
 *   marker  "1." "2、" "(3)" at the start of a line, 第3, No.5, #5, 1st
 *   code    digits that are part of a name (Q3, COVID-19, v2), 1.2.3, web addresses, long
 *           identity or card numbers
 *
 * @param {string} text
 * @returns {{ numbers: Array<{ index: number, end: number, raw: string, value: number, digits: bigint, places: number,
 *             rate: ''|'%'|'‰', unit: string, scale: string, currency: string }>,
 *             skipped: { date: number, time: number, phone: number, marker: number, code: number } }}
 *   digits and places are the exact value: digits / 10^places.
 */
export function extractNumbers(text) {
  const original = String(text ?? '');
  const skipped = { date: 0, time: 0, phone: 0, marker: 0, code: 0 };
  let s = narrowNumbers(original);
  for (const [why, pattern] of NOT_QUANTITIES) {
    s = s.replace(pattern, (m) => {
      if (/\d/.test(m)) skipped[why]++;
      return ' '.repeat(m.length);
    });
  }
  const numbers = [];
  for (const m of s.matchAll(NUMBER)) {
    const start = m.index;
    const end = start + m[0].length;
    let from = start;
    let sign = '';
    if (s[from - 1] === '-' || s[from - 1] === '+') sign = s[--from];
    const money = MONEY_BEFORE.exec(s.slice(Math.max(0, from - 6), from));
    if (money) {
      from -= money[0].length;
      if (!sign && (s[from - 1] === '-' || s[from - 1] === '+')) sign = s[--from];
    }
    if (!sign && s[from - 1] === '负') {
      sign = '-';
      from--;
    }
    const before = s[from - 1] ?? '';
    if (sign && /[0-9A-Za-z%‰)\]）】]/.test(before)) {
      // A hyphen between two things, not a sign: "3-5" is 3 and 5.
      sign = '';
      from++;
    }
    if (!money) {
      const lead = s.slice(Math.max(0, start - 5), start);
      // Part of a name: Q3, v2, COVID-19, x_1.
      if (/[A-Za-z_]-?$/.test(lead)) {
        skipped.code++;
        continue;
      }
      // An ordinal: 第3, No.5, #5.
      if (/(?:第\s?|#|№\s?|\bNo\.\s?)$/i.test(lead)) {
        skipped.marker++;
        continue;
      }
    }
    const after = s.slice(end, end + 6);
    if (/^(?:st|nd|rd|th)(?![A-Za-z])/i.test(after)) {
      skipped.marker++;
      continue;
    }
    let stop = end;
    let rate = '';
    let unit = '';
    let scale = '';
    const percent = /^\s?([%‰])/.exec(after);
    if (percent) {
      rate = percent[1];
      stop += percent[0].length;
    } else {
      const u = UNIT_AFTER.exec(after);
      if (u[1] || u[2]) {
        scale = u[1] ?? '';
        unit = scale + (u[2] ?? '');
        stop += u[0].length;
      }
    }
    const whole = m[1].replace(/,/g, '');
    const fraction = m[2] ?? '';
    const exp = m[3] !== undefined ? Number(m[3]) : 0;
    if (m[3] !== undefined && (!Number.isInteger(exp) || Math.abs(exp) > 30)) {
      skipped.code++;
      continue;
    }
    const negative = sign === '-';
    const shift = exp - fraction.length;
    const rawDigits = BigInt(whole + fraction) * (negative ? -1n : 1n);
    const digits = shift >= 0 ? rawDigits * 10n ** BigInt(shift) : rawDigits;
    const places = shift >= 0 ? 0 : -shift;
    numbers.push({
      index: from,
      end: stop,
      raw: original.slice(from, stop),
      value: Number(`${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}${m[3] !== undefined ? 'e' + exp : ''}`),
      digits,
      places,
      rate,
      unit,
      scale,
      currency: money ? CURRENCY[money[1].toUpperCase()] ?? money[1].toUpperCase() : '',
    });
  }
  return { numbers, skipped };
}

// Exact decimal arithmetic: 0.1 + 0.2 is 0.3 here.
const scaleTo = (n, places) => n.digits * 10n ** BigInt(places - n.places);
function decimalText(digits, places, group = true) {
  const negative = digits < 0n;
  const all = (negative ? -digits : digits).toString().padStart(places + 1, '0');
  const whole = places ? all.slice(0, -places) : all;
  const fraction = places ? all.slice(-places).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${group ? grouped(whole) : whole}${fraction ? '.' + fraction : ''}`;
}

/**
 * Add up the quantities of a text.
 *
 * Percentages are a different kind of number: they are left out when the text also has plain
 * numbers, and added up (as percentages) when it has nothing else.
 *
 * @returns {{
 *   count: number,            how many numbers were added
 *   sum: string, mean: string, max: string, min: string,   written out: "12,345.6"
 *   plain: string,            the sum without separators, for pasting: "12345.6" ("12.5%")
 *   value: number,            the sum as a number
 *   meanExact: boolean,       false when the mean had to be rounded
 *   prefix: string, suffix: string,   what all the numbers share: "¥", "万元", "%"
 *   mixed: string[],          the different units, when the numbers do not share one (they
 *                             are added as written, without conversion)
 *   leftOut: { percent: number, permille: number },   rates not added to plain numbers
 *   skipped: object,          see extractNumbers
 *   dense: boolean,           the text is mostly numbers
 *   used: object[]            the numbers that were added
 * }}
 */
export function sumNumbers(text) {
  const { numbers, skipped } = extractNumbers(text);
  const kinds = { '': [], '%': [], '‰': [] };
  for (const n of numbers) kinds[n.rate].push(n);
  const used = kinds[''].length ? kinds[''] : kinds['%'].length ? kinds['%'] : kinds['‰'];
  const rate = used[0]?.rate ?? '';
  const leftOut = { percent: rate === '%' ? 0 : kinds['%'].length, permille: rate === '‰' ? 0 : kinds['‰'].length };
  const empty = { count: 0, sum: '0', mean: '0', max: '0', min: '0', plain: '0', value: 0, meanExact: true, prefix: '', suffix: '', mixed: [], leftOut, skipped, dense: false, used };
  if (!used.length) return empty;

  const places = used.reduce((most, n) => Math.max(most, n.places), 0);
  const exact = used.map((n) => scaleTo(n, places));
  const total = exact.reduce((a, b) => a + b, 0n);
  const max = exact.reduce((a, b) => (b > a ? b : a));
  const min = exact.reduce((a, b) => (b < a ? b : a));
  // The mean, two more decimal places than the numbers have, rounded half away from zero.
  const meanPlaces = places + 2;
  const count = BigInt(used.length);
  const scaled = total * 100n;
  let mean = scaled / count;
  const rest = scaled % count;
  if ((rest < 0n ? -rest : rest) * 2n >= count) mean += scaled < 0n ? -1n : 1n;

  const same = (pick) => (used.every((n) => pick(n) === pick(used[0])) ? pick(used[0]) : null);
  const scales = [...new Set(used.map((n) => n.scale))];
  const currencies = [...new Set(used.map((n) => n.currency).filter(Boolean))];
  const mixed = [];
  if (scales.length > 1) mixed.push(...new Set(used.map((n) => n.unit || '不带单位')));
  if (currencies.length > 1) mixed.push(...currencies);
  const prefix = rate ? '' : same((n) => n.currency) ?? '';
  const suffix = rate || (same((n) => n.unit) ?? same((n) => n.scale) ?? '');

  const solid = (str) => str.replace(/\s/g, '').length;
  const covered = used.reduce((sum, n) => sum + solid(n.raw), 0);
  return {
    count: used.length,
    sum: decimalText(total, places),
    mean: decimalText(mean, meanPlaces),
    max: decimalText(max, places),
    min: decimalText(min, places),
    plain: decimalText(total, places, false) + rate,
    value: Number(decimalText(total, places, false)),
    meanExact: rest === 0n,
    prefix: /^[A-Z]{3}$/.test(prefix) ? prefix + ' ' : prefix,
    suffix,
    mixed,
    leftOut,
    skipped,
    dense: used.length >= 2 && covered * 2 >= solid(String(text ?? '')),
    used,
  };
}

/** What sumNumbers found, in a few lines: how many, the sum, mean, largest and smallest. */
export function describeSum(r) {
  const notes = [];
  const rates = [r.leftOut.percent ? `${r.leftOut.percent} 个百分数` : '', r.leftOut.permille ? `${r.leftOut.permille} 个千分数` : ''].filter(Boolean);
  const names = { date: '个日期', time: '个时间', phone: '个电话号码', marker: '个序号', code: '个编号或名称里的数字' };
  const skipped = Object.keys(names).filter((k) => r.skipped[k]).map((k) => `${r.skipped[k]} ${names[k]}`);
  if (!r.count) return `这段文字里没有可以相加的数${skipped.length ? `（${skipped.join('、')}不算）` : ''}`;
  const show = (x) => `${r.prefix}${x}${/^[%‰kKw]?$/.test(r.suffix) ? '' : ' '}${r.suffix}`;
  const out = [`${r.count} 个${r.suffix === '%' ? '百分数' : r.suffix === '‰' ? '千分数' : '数'}，合计 ${show(r.sum)}`, `平均${r.meanExact ? '' : '约'} ${show(r.mean)}，最大 ${show(r.max)}，最小 ${show(r.min)}`];
  if (r.mixed.length) notes.push(`这些数的单位不一样（${r.mixed.join('、')}），是照写出来的数字直接相加的，没有换算`);
  if (rates.length) notes.push(`另有 ${rates.join('和 ')}没有加进去`);
  if (skipped.length) notes.push(`不算在内：${skipped.join('、')}`);
  if (notes.length) out.push(notes.join('；'));
  return out.join('\n');
}

// ---------------------------------------------------------------- characters read back from a PDF

// A PDF stores which glyph is drawn, and a glyph that a font uses for two characters is read
// back as the one that comes first in Unicode. The usual Chinese fonts draw 一, 人, 大, 日, 风,
// 马 ... with the same glyph as the "radical" characters U+2E80 to U+2FDF, so the text of a PDF
// made by a browser says "⻛险" for "风险", which looks the same and is found by no search.
// The Kangxi radicals (U+2F00 to U+2FD5) have their ordinary character in Unicode itself
// (compatibility normalisation); for the others, these are the pairs that share a glyph in
// the Noto CJK fonts (read from the fonts' character maps): radical, then ordinary character.
const RADICAL_TWINS = new Map(
  '⺂乛 ⺃乚 ⺅亻 ⺇𠘨 ⺉刂 ⺋㔾 ⺍𭕄 ⺎兀 ⺏尣 ⺐尢 ⺒巳 ⺓幺 ⺔彑 ⺕彐 ⺖忄 ⺘扌 ⺙攵 ⺛旡 ⺞歺 ⺟母 ⺠民 ⺡氵 ⺣灬 ⺤爫 ⺦丬 ⺨犭 ⺩𤣩 ⺫罒 ⺭礻 ⺮𥫗 ⺯糹 ⺰纟 ⺱罓 ⺲罒 ⺳㓁 ⺹耂 ⺺肀 ⺽𦥑 ⺾艹 ⺿艹 ⻁虎 ⻂衤 ⻃覀 ⻄西 ⻅见 ⻆角 ⻇𧢲 ⻈讠 ⻉贝 ⻊𧾷 ⻋车 ⻌辶 ⻍辶 ⻎辶 ⻐钅 ⻑長 ⻒镸 ⻓长 ⻔门 ⻕𨸏 ⻖阝 ⻘青 ⻙韦 ⻚页 ⻛风 ⻜飞 ⻝食 ⻞𩙿 ⻟飠 ⻠饣 ⻡𩠐 ⻢马 ⻣骨 ⻤鬼 ⻥鱼 ⻦鸟 ⻧卤 ⻨麦 ⻩黄 ⻪黾 ⻫斉 ⻬齐 ⻭歯 ⻮齿 ⻯竜 ⻰龙 ⻱龜 ⻲亀 ⻳龟'
    .split(' ')
    .map((pair) => [...pair]),
);

/** Radical code points as the ordinary characters they are drawn as: "⻛险" becomes "风险". */
export function unifyRadicals(text) {
  return String(text ?? '').replace(/[\u2e80-\u2fdf]/g, (c) => RADICAL_TWINS.get(c) ?? c.normalize('NFKC'));
}

// ---------------------------------------------------------------- lines into one paragraph

// Text that is written without spaces between words.
const SOLID = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\uff00-\uffef]/u;
const BROKEN_WORD = re(`([${LATIN}][${LATIN}'’-]*)-$`, '');
const STARTS_LATIN = re(`^[${LATIN}]`, '');
const firstChar = (str) => String.fromCodePoint(str.codePointAt(0));
const lastChar = (str) => {
  const pair = str.length > 1 ? str.codePointAt(str.length - 2) : 0;
  return pair > 0xffff ? String.fromCodePoint(pair) : str.at(-1);
};

/**
 * Join all the lines of a text into one paragraph: nothing between Chinese characters, one
 * space between words, and a word that was hyphenated at the end of a line ("run-" / "ning")
 * put together again. A hyphen that belongs to the word stays ("state-of-the-" / "art",
 * "Anglo-" / "Saxon").
 * @returns {{ text: string, lines: number, paragraphs: number, mended: number }}
 *   lines and paragraphs: what the text had before; mended: hyphenated words put together
 */
export function joinLines(text) {
  const rows = String(text ?? '').replace(LINE_BREAK, '\n').split('\n').map((l) => l.trim());
  const lines = rows.filter(Boolean);
  const paragraphs = rows.filter((l, i) => l && !rows[i - 1]).length;
  const parts = [];
  let last = lines[0] ?? '';
  let mended = 0;
  for (const next of lines.slice(1)) {
    const tail = last.slice(-80);
    const broken = BROKEN_WORD.exec(tail);
    let glue = ' ';
    if (broken && /^\p{Ll}/u.test(next) && !broken[1].includes('-')) {
      last = last.slice(0, -1);
      glue = '';
      mended++;
    } else if (broken && STARTS_LATIN.test(next)) glue = '';
    else if (/\d[-–~]$/.test(tail) && /^\d/.test(next)) glue = ''; // "2020-" / "2025"
    else if (SOLID.test(lastChar(last)) || SOLID.test(firstChar(next))) glue = '';
    parts.push(last, glue);
    last = next;
  }
  parts.push(last);
  return { text: parts.join(''), lines: lines.length, paragraphs, mended };
}
