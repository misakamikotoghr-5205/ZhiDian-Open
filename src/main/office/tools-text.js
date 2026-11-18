// Office actions, set "text": quick things to do with a piece of selected text. Count it, add
// up the numbers in it, join its lines into one paragraph, and two jobs for the local model
// (polish it, list its main points). The shape of an action is described at the top of
// tools-basic.js; the counting and the reading of numbers are in core/text-stats.js.
import { countText, describeCount, describeSum, joinLines, sumNumbers, unifyRadicals } from '../../core/text-stats.js';

export const MODEL_CHARS = 6000; // as much of a selection as the model is given
export const RANK_SUM = 35; // behind 自动排版, 解释一下 and 翻译: the fourth button
export const RANK_SUM_FIRST = 5; // a selection that is mostly numbers: the first button

const hasText = (ctx) => ctx.kind === 'text' && ctx.text.trim().length >= 2;

// The numbers of the selection looked at last. Whether the sum is offered, where it ranks and
// the sum itself all need them, one right after the other, so they are read once.
let numbersFor = null;
let numbers = null;
function numbersOf(text) {
  if (numbersFor !== text) {
    numbers = sumNumbers(text);
    numbersFor = text;
  }
  return numbers;
}
let offeredFor = ''; // the selection text.sum was last asked about

/**
 * The selection as the model gets it: its first MODEL_CHARS characters, and whether that is
 * all. Text selected in a PDF may say 一, 人, 风 ... with look-alike radical characters: the
 * model gets the ordinary ones.
 */
function forModel(text) {
  const chars = [...unifyRadicals(text.trim())];
  return chars.length > MODEL_CHARS ? { text: chars.slice(0, MODEL_CHARS).join('').trim(), cut: true } : { text: chars.join(''), cut: false };
}
const CUT_FOR_MODEL = `（这段文字很长，下面只是它开头的 ${MODEL_CHARS} 字，后面的没有给你。）`;
const CUT_NOTE = `只处理了前 ${MODEL_CHARS} 字`;

export const actions = [
  {
    id: 'text.sum',
    label: '数字求和',
    hint: '把这段文字里的数加起来；日期、时间、电话号码和序号不算',
    // Office sorts the offers by `rank` right after it has asked applies(), and a rank cannot
    // see the selection: so this one answers for the selection applies() was asked about last.
    // rankFor(ctx) says the same without remembering anything.
    get rank() {
      return this.rankFor({ kind: 'text', text: offeredFor });
    },
    rankFor: (ctx) => (hasText(ctx) && numbersOf(ctx.text).dense ? RANK_SUM_FIRST : RANK_SUM),
    applies(ctx) {
      offeredFor = hasText(ctx) ? ctx.text : '';
      return offeredFor !== '' && numbersOf(offeredFor).count >= 2;
    },
    async run(ctx) {
      const r = numbersOf(ctx.text);
      return { kind: 'info', message: describeSum(r), copy: r.plain };
    },
  },
  {
    id: 'text.count',
    label: '字数统计',
    hint: '数出字数、字符、汉字、英文单词、数字、行和段落',
    rank: 40,
    applies: hasText,
    run: async (ctx) => ({ kind: 'info', message: describeCount(countText(ctx.text)) }),
  },
  {
    id: 'text.polish',
    label: '润色',
    hint: '让本地模型改正错别字和不通顺的地方，意思不变；完成后自动复制到剪贴板',
    rank: 44,
    autoCopy: true,
    applies: (ctx) => hasText(ctx) && Boolean(ctx.has?.model) && ctx.text.trim().length >= 4 && /\p{L}/u.test(ctx.text),
    async run(ctx) {
      const { text, cut } = forModel(ctx.text);
      const question = `润色下面这段文字：改正错别字、语病和不通顺的用词，让表达更清楚；不改变原意，不增删内容，保持原来的语言（中文还是中文，英文还是英文）和分段。只输出润色后的文字，不要解释。${cut ? CUT_FOR_MODEL : ''}\n\n${text}`;
      return { kind: 'ask', question, ...(cut ? { note: CUT_NOTE } : {}) };
    },
  },
  {
    id: 'text.summary',
    label: '总结要点',
    hint: '让本地模型列出 3 到 5 条要点',
    rank: 46,
    // A sentence or two has no points to list.
    applies: (ctx) => hasText(ctx) && Boolean(ctx.has?.model) && ctx.text.trim().length >= 80,
    async run(ctx) {
      const { text, cut } = forModel(ctx.text);
      const question = `用 3 到 5 条简短的要点总结下面这段文字，每条一行；用原文的语言（原文是中文就用中文，是英文就用英文）；只输出要点，不要开场白。${cut ? CUT_FOR_MODEL : ''}\n\n${text}`;
      return { kind: 'ask', question, ...(cut ? { note: CUT_NOTE } : {}) };
    },
  },
  {
    id: 'text.oneline',
    label: '合并成一段',
    hint: '把所有的行接成一段：中文之间不留空格，英文单词之间留一个',
    rank: 50,
    applies: (ctx) => ctx.kind === 'text' && /[\r\n]/.test(ctx.text.trim()),
    async run(ctx) {
      const r = joinLines(ctx.text);
      const notes = [r.paragraphs > 1 ? `原来的 ${r.paragraphs} 段也连在了一起` : '', r.mended ? `接上了 ${r.mended} 个在行尾用连字符断开的单词` : ''].filter(Boolean);
      // No full stop at the end: the panel adds its own sentence about pasting.
      return { kind: 'clipboard', text: r.text, message: `把 ${r.lines} 行合并成了一段${notes.length ? '，' + notes.join('，') : ''}` };
    },
  },
];
