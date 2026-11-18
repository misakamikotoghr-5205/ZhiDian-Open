// "自动排版" for selected text: tidy up plain text the way a careful typist would, without
// changing a single word of it. Pure functions and fixed rules, no model involved, so the result
// is predictable and instant:
//
//   - lines broken in the middle of a sentence (text copied from a PDF) are joined again
//   - a space between Chinese and Latin letters or digits, none between Chinese characters
//   - Chinese punctuation in Chinese sentences (，。？！：；（）), full-width letters and
//     digits back to ordinary ones, runs of dots to an ellipsis
//   - stray spaces and piles of blank lines removed, list markers lined up
//
// Web addresses, e-mail addresses, file paths and `code` are left exactly as they are.

const CJK = '\\u2e80-\\u2fdf\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';
const CJK_PUNCT = '，。、；：？！…—（）《》〈〉「」『』【】〔〕“”‘’·～';
const re = (src, flags = 'g') => new RegExp(src, flags);

const HAS_CJK = re(`[${CJK}]`, '');
const LIST_MARK = /^\s*(?:[-*•·●○■□◆▪–—]|\d{1,3}[.、)）]|[（(]\d{1,3}[)）]|[一二三四五六七八九十]{1,3}[、.]|[（(][一二三四五六七八九十]{1,3}[)）]|[a-zA-Z][.)）]|#{1,6}\s|第[一二三四五六七八九十百\d]+[章节条款部分])/;
const SENTENCE_END = /[。！？!?…；;：:”’"'」』）)\]】.]\s*$/;

/** Text that must come through untouched is swapped for placeholders and put back at the end. */
function protect(text) {
  const kept = [];
  const stash = (m) => {
    kept.push(m);
    return `${kept.length - 1}`;
  };
  const out = text
    .replace(/`[^`\n]+`/g, stash)
    .replace(/\b(?:https?|ftp|file):\/\/[^\s　<>"'，。；！？、）】」』]+/gi, stash)
    .replace(/\bwww\.[^\s　<>"'，。；！？、）】」』]+/gi, stash)
    .replace(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, stash) // anchored: without the lookbehind this is quadratic on a long run of letters
    .replace(/(?:[A-Za-z]:\\|\\\\|~\/|\.{0,2}\/)[^\s\u3000\uE000，。；！？、）】」』,]*[^\s\u3000\uE000，。；！？、）】」』.,;:!?]/g, (m) => {
      // A path may contain Chinese, but Chinese right after the file extension is the sentence
      // going on: in "在 C:\a\b.docx里" the path ends at ".docx".
      const cut = /^(.*\.[A-Za-z0-9]{1,5})(?=[\u4e00-\u9fff])/.exec(m);
      return cut ? stash(cut[1]) + m.slice(cut[1].length) : stash(m);
    });
  return { out, restore: (s) => s.replace(/\uE000(\d+)\uE001/g, (_m, i) => kept[Number(i)]) };
}

/** Ａ-Ｚ, ａ-ｚ, ０-９ and the full-width space inside a line become their ordinary forms. */
function narrowAlnum(s) {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function fixPunctuation(line) {
  let s = line;
  // Runs of dots or of 。 are an ellipsis.
  s = s.replace(re(`([${CJK}])\\s*(?:\\.{3,}|。{2,}|…{1,})`), '$1……').replace(/…{3,}/g, '……');
  // Half-width punctuation that sits next to a Chinese character belongs to Chinese text.
  const half = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！' };
  s = s.replace(re(`([${CJK}${CJK_PUNCT}])\\s*([,;:?!]+)(?!\\d)`), (_m, a, run) => a + [...run].map((p) => half[p]).join(''));
  s = s.replace(re(`([,;:?!])\\s*(?=[${CJK}])`), (m, p, offset, whole) => (/[\dA-Za-z]/.test(whole[offset - 1] ?? '') && p === ':' ? m : half[p]));
  // A full stop after a Chinese character, when it ends something (not 3.14, not a.b).
  s = s.replace(re(`([${CJK}”’）》」』】])\\.(?=\\s|$|[${CJK}“‘（《「『【])`), '$1。');
  // In a line that is mostly Chinese, a full stop that ends it (or is followed by Chinese) is a
  // Chinese full stop whatever comes before it: "速度提升 50%." -> "速度提升 50%。"
  const cjkCount = (s.match(re(`[${CJK}]`)) ?? []).length;
  const latinCount = (s.match(/[A-Za-z]/g) ?? []).length;
  // (Not after a digit when text follows: "1.第一点" is a list number.)
  if (cjkCount >= latinCount) s = s.replace(/([^.\s])\.(?=\s*$)/, '$1。').replace(re(`([^.\\s\\d])\\.(?=[${CJK}“‘（《「『【])`), '$1。');
  // Brackets around Chinese text, or directly attached to it: 人工智能(AI)是 -> 人工智能（AI）是.
  s = s.replace(re(`\\(([^()\\n]*[${CJK}][^()\\n]*)\\)`), '（$1）');
  s = s.replace(re(`([${CJK}])\\(([^()\\n]{1,40})\\)`), '$1（$2）').replace(re(`\\(([^()\\n]{1,40})\\)(?=[${CJK}])`), '（$1）');
  // Straight double quotes around Chinese text, in pairs.
  s = s.replace(re(`"([^"\\n]*[${CJK}][^"\\n]*)"`), '“$1”');
  // The same mark twice in a row is a typing slip.
  s = s.replace(/([，。；：、！？])\1+/g, (m, p) => (p === '！' || p === '？' ? m.slice(0, 2) : p));
  return s;
}

function fixSpacing(line) {
  let s = line.replace(/[\t ]+/g, ' ');
  const lead = /^(\s*)/.exec(s)[1].replace(/　/g, ''); // drop hand-made first-line indents
  s = s.slice(/^(\s*)/.exec(s)[1].length).replace(/　/g, ' ');
  s = s.replace(/ {2,}/g, ' ');
  // No spaces between Chinese characters, or around Chinese punctuation.
  s = s.replace(re(`([${CJK}${CJK_PUNCT}]) +(?=[${CJK}${CJK_PUNCT}])`), '$1');
  s = s.replace(re(` +([${CJK_PUNCT.replace(/[（《〈「『【〔“‘]/g, '')}])`), '$1');
  s = s.replace(re(`([${CJK_PUNCT.replace(/[）》〉」』】〕”’]/g, '')}]) +`), '$1');
  // One space between Chinese and Latin letters or digits.
  s = s.replace(re(`([${CJK}])([A-Za-z0-9@#&$%\\[])`), '$1 $2');
  s = s.replace(re(`([A-Za-z0-9%\\]°])([${CJK}])`), '$1 $2');
  // ...but not inside a number with its unit sign: 50 % stays 50%, ￥ 30 stays ￥30.
  s = s.replace(/(\d) +(%|°)/g, '$1$2').replace(/([¥￥$€£]) +(\d)/g, '$1$2');
  // A space after English punctuation, none before it.
  s = s.replace(/ +([,.;:!?])(?=\s|$|[A-Za-z])/g, '$1').replace(/([A-Za-z][,;!?])(?=[A-Za-z])/g, '$1 ');
  return lead.replace(/[ \t]+$/, '') + s.replace(/\s+$/, '');
}

/** Join the lines of one paragraph that were only broken because the page was that wide. */
function unwrap(lines) {
  if (lines.length < 2) return lines;
  const width = (s) => [...s].reduce((n, ch) => n + (HAS_CJK.test(ch) || /[＀-￯　-〿]/.test(ch) ? 2 : 1), 0);
  const widest = Math.max(...lines.map(width));
  const out = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = out[out.length - 1];
    const cur = lines[i];
    // A line that nearly fills the width and does not end a sentence continues on the next
    // one, unless that one starts a list item or a heading.
    const full = width(prev) >= Math.max(24, widest * 0.72);
    if (full && !SENTENCE_END.test(prev) && !LIST_MARK.test(cur) && !LIST_MARK.test(prev.length < 12 ? prev : '')) {
      const a = prev.replace(/\s+$/, ''), b = cur.replace(/^\s+/, '');
      const hyphen = /[A-Za-z]-$/.test(a) && /^[a-z]/.test(b);
      const last = [...a].at(-1) ?? '', first = [...b][0] ?? '';
      const isCjk = (ch) => HAS_CJK.test(ch) || /\p{Script=Han}/u.test(ch);
      const glue = hyphen ? '' : isCjk(last) || isCjk(first) ? '' : ' ';
      out[out.length - 1] = (hyphen ? a.slice(0, -1) : a) + glue + b;
    } else {
      out.push(cur);
    }
  }
  return out;
}

function fixListMarker(line) {
  // "1.文字" and "1 、文字" become "1. 文字" / "1、文字"; a bullet gets exactly one space.
  return line
    .replace(/^(\s*)(\d{1,3})\s*([.)])\s*(?=\S)/, '$1$2$3 ')
    .replace(/^(\s*)(\d{1,3})\s*、\s*/, '$1$2、')
    .replace(/^(\s*)([-*•·●○■□◆▪])\s*(?=\S)/, (_m, lead, mark) => `${lead}${mark === '*' || mark === '-' ? mark : '•'} `);
}

/**
 * @param {string} input
 * @returns {{ text: string, changes: { joined: number, spacing: number, punctuation: number, blank: number } }}
 */
export function typeset(input) {
  const changes = { joined: 0, spacing: 0, punctuation: 0, blank: 0 };
  const { out: guarded, restore } = protect(String(input ?? '').replace(/\r\n?/g, '\n'));
  const rawLines = guarded.split('\n').map((l) => l.replace(/[ \t 　]+$/, ''));

  // Paragraphs are separated by blank lines; inside one, wrapped lines are joined.
  const paragraphs = [];
  let cur = [];
  let blanks = 0;
  for (const line of rawLines) {
    if (line.trim() === '') {
      if (cur.length) paragraphs.push(cur);
      cur = [];
      blanks++;
    } else {
      cur.push(line);
    }
  }
  if (cur.length) paragraphs.push(cur);

  const done = paragraphs.map((lines) => {
    const joined = unwrap(lines);
    changes.joined += lines.length - joined.length;
    return joined
      .map((line) => {
        const cjk = HAS_CJK.test(line);
        let s = narrowAlnum(line);
        const beforePunct = s;
        if (cjk) s = fixPunctuation(s);
        if (s !== beforePunct) changes.punctuation++;
        const beforeSpace = s;
        s = fixListMarker(fixSpacing(s));
        if (s !== beforeSpace) changes.spacing++;
        return s;
      })
      .join('\n');
  });
  changes.blank = Math.max(0, blanks - Math.max(0, paragraphs.length - 1));
  return { text: restore(done.join('\n\n')), changes };
}

/** One line for the person: what was done, in their words. */
export function describeTypeset(changes) {
  const parts = [];
  if (changes.joined) parts.push(`接上了 ${changes.joined} 处断行`);
  if (changes.punctuation) parts.push(`${changes.punctuation} 行标点`);
  if (changes.spacing) parts.push(`${changes.spacing} 行空格`);
  if (changes.blank) parts.push(`去掉 ${changes.blank} 个多余空行`);
  return parts.length ? `整理了${parts.join('、')}` : '这段文字本来就很整齐，没有需要改的地方';
}
