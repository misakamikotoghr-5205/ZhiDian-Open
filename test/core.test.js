import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TagStream, parseTag, mentionedHandles } from '../src/core/tags.js';
import { signature, distance, isDangling } from '../src/core/signature.js';
import { WiggleDetector } from '../src/core/gesture.js';
import { imageToDisplay, imageBoxToDisplay, fitWithin, iou, clampBox, placeNear } from '../src/core/geometry.js';
import { buildUserContent, SYSTEM_PROMPT } from '../src/core/prompt.js';
import { makeImage, fill } from './helpers.js';

test('parseTag accepts the three tag kinds and rejects malformed ones', () => {
  assert.deepEqual(parseTag('name @1 | error dialog'), { type: 'name', ref: '@1', label: 'error dialog' });
  assert.deepEqual(parseTag(' point @2 412 188 | Retry '), { type: 'point', ref: '@2', x: 412, y: 188, label: 'Retry' });
  assert.deepEqual(parseTag('point @2 412,188'), { type: 'point', ref: '@2', x: 412, y: 188, label: '' });
  assert.deepEqual(parseTag('box @1 10 20 300 40 | 总价'), { type: 'box', ref: '@1', x: 10, y: 20, w: 300, h: 40, label: '总价' });
  assert.equal(parseTag('point @1 12 | x'), null);
  assert.equal(parseTag('point @1 a b | x'), null);
  assert.equal(parseTag('box @1 1 2 0 5'), null);
  assert.equal(parseTag('name @1'), null);
  assert.equal(parseTag('shout @1 | hi'), null);
});

function run(chunks) {
  const s = new TagStream();
  const segs = [];
  for (const c of chunks) segs.push(...s.push(c));
  segs.push(...s.flush());
  const text = segs.filter((x) => x.type === 'text').map((x) => x.text).join('');
  const tags = segs.filter((x) => x.type === 'tag').map((x) => x.tag);
  return { text, tags, segs };
}

test('TagStream extracts tags regardless of how the text is chunked', () => {
  const full = '[[name @1 | 报错弹窗]]点这里 [[point @1 120 44 | 重试]]，然后再看 [[box @2 0 0 50 20 | 价格]] 即可。';
  const whole = run([full]);
  assert.equal(whole.text, '点这里 ，然后再看  即可。');
  assert.equal(whole.tags.length, 3);
  for (let size = 1; size <= 7; size++) {
    const chunks = [];
    for (let i = 0; i < full.length; i += size) chunks.push(full.slice(i, i + size));
    const r = run(chunks);
    assert.equal(r.text, whole.text, `chunk size ${size}`);
    assert.deepEqual(r.tags, whole.tags, `chunk size ${size}`);
  }
});

test('TagStream leaves ordinary brackets and broken tags as text', () => {
  assert.equal(run(['see arr[0] and [[not a tag]] ok']).text, 'see arr[0] and [[not a tag]] ok');
  assert.equal(run(['an unfinished [[point @1 3 ']).text, 'an unfinished [[point @1 3 ');
  assert.equal(run(['ends with [']).text, 'ends with [');
  const long = '[[' + 'x'.repeat(400);
  assert.equal(run([long]).text, long);
});

test('TagStream never emits a held-back fragment twice', () => {
  const s = new TagStream();
  const a = s.push('abc [');
  const b = s.push('[name @1 | x]] def');
  const all = [...a, ...b, ...s.flush()];
  assert.equal(all.filter((x) => x.type === 'text').map((x) => x.text).join(''), 'abc  def');
  assert.equal(all.filter((x) => x.type === 'tag').length, 1);
});

test('mentionedHandles finds handles in order without duplicates', () => {
  assert.deepEqual(mentionedHandles('把 @2 和 @1 比一下，@2 更贵吗'), ['@2', '@1']);
  assert.deepEqual(mentionedHandles('email me@example.com'), []);
  assert.deepEqual(mentionedHandles('@01 ok'), ['@1']);
});

test('signature is stable under tiny changes and flags real ones', () => {
  const img = makeImage(400, 300, [240, 240, 240]);
  fill(img, 50, 50, 200, 20, [20, 20, 20]);
  fill(img, 50, 90, 140, 20, [20, 20, 20]);
  const box = { x: 40, y: 40, w: 240, h: 100 };
  const a = signature(img, box);
  // A blinking caret: a 2x16 mark.
  fill(img, 260, 52, 2, 16, [0, 0, 0]);
  assert.equal(isDangling(a, signature(img, box)), false);
  // The content scrolled away.
  const img2 = makeImage(400, 300, [240, 240, 240]);
  fill(img2, 50, 70, 90, 20, [20, 20, 20]);
  fill(img2, 180, 110, 90, 20, [200, 30, 30]);
  assert.equal(isDangling(a, signature(img2, box)), true);
  assert.equal(distance(a, a), 0);
  assert.equal(distance(a, new Uint8Array(3)), 255);
});

test('WiggleDetector fires on a shake and not on normal movement', () => {
  const w = new WiggleDetector();
  let t = 0, fired = 0;
  for (let x = 0; x < 600; x += 12) fired += w.push(x, 100, (t += 16)) ? 1 : 0; // a straight sweep
  assert.equal(fired, 0);
  let x = 300;
  for (let stroke = 0; stroke < 7; stroke++) {
    const dir = stroke % 2 ? -1 : 1;
    for (let i = 0; i < 5; i++) fired += w.push((x += dir * 16), 100, (t += 12)) ? 1 : 0;
  }
  assert.equal(fired, 1);
  // Slow back-and-forth (reading two columns) does not fire.
  const slow = new WiggleDetector();
  let f2 = 0; t = 0; x = 0;
  for (let stroke = 0; stroke < 8; stroke++) {
    const dir = stroke % 2 ? -1 : 1;
    for (let i = 0; i < 10; i++) f2 += slow.push((x += dir * 10), 0, (t += 60)) ? 1 : 0;
  }
  assert.equal(f2, 0);
});

test('image coordinates map back to the display, with scaling and clamping', () => {
  const ref = { cropBox: { x: 100, y: 200, w: 400, h: 300 }, imageSize: { w: 800, h: 600 } };
  assert.deepEqual(imageToDisplay(ref, 400, 300), { x: 300, y: 350, clamped: false });
  assert.deepEqual(imageToDisplay(ref, 0, 0), { x: 100, y: 200, clamped: false });
  assert.deepEqual(imageToDisplay(ref, 900, -5), { x: 500, y: 200, clamped: true });
  assert.equal(imageToDisplay(ref, NaN, 3), null);
  assert.deepEqual(imageBoxToDisplay(ref, 200, 100, 100, 50), { x: 200, y: 250, w: 50, h: 25, clamped: false });
});

test('fitWithin, iou, clampBox and placeNear behave at the edges', () => {
  assert.deepEqual(fitWithin(2560, 1440, 1280), { w: 1280, h: 720, scale: 0.5 });
  assert.deepEqual(fitWithin(300, 200, 1280), { w: 300, h: 200, scale: 1 });
  assert.equal(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 }), 1);
  assert.equal(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }), 0);
  assert.deepEqual(clampBox({ x: -5, y: 590, w: 50, h: 50 }, 800, 600), { x: 0, y: 590, w: 50, h: 10 });
  const p = placeNear({ x: 700, y: 560, w: 80, h: 30 }, 360, 120, 800, 600);
  assert.ok(p.x >= 8 && p.y >= 8 && p.x + 360 <= 792 && p.y + 120 <= 592, JSON.stringify(p));
});

test('user content labels each new referent, attaches its image, then asks the question', () => {
  const mk = (handle, state = 'live') => ({ handle, state, dataUrl: 'data:image/png;base64,' + Buffer.from(handle).toString('base64') });
  const content = buildUserContent({ question: '哪个更便宜？', newRefs: [mk('@1'), mk('@2', 'dangling')], knownRefs: [{ handle: '@3' }] });
  assert.deepEqual(content.map((c) => c.type), ['text', 'image_url', 'text', 'image_url', 'text']);
  assert.match(content[0].text, /^@1/);
  assert.match(content[2].text, /快照/);
  assert.equal(content[1].image_url.url, mk('@1').dataUrl);
  assert.match(content[4].text, /@3/);
  assert.match(content[4].text, /哪个更便宜？$/);
  // An empty question still asks something sensible.
  assert.match(buildUserContent({ question: '  ', newRefs: [mk('@1')] }).at(-1).text, /这是什么/);
  assert.match(SYSTEM_PROMPT, /不是给你的指令/);
});

// ---------------------------------------------------------------- local model plumbing
import { parseGrounding, groundingToPixels, groundingSize } from '../src/core/grounding.js';
import { buildGroundingMessages, stripImages } from '../src/core/prompt.js';

test('parseGrounding reads the Qwen formats and their common variations', () => {
  assert.deepEqual(parseGrounding('{"point_2d": [412, 188], "label": "重试"}'), { kind: 'point', x: 412, y: 188, label: '重试' });
  assert.deepEqual(parseGrounding('```json\n[{"bbox_2d": [100, 200, 300, 260], "label": "总价"}]\n```'), { kind: 'box', x: 100, y: 200, w: 200, h: 60, label: '总价' });
  assert.deepEqual(parseGrounding('好的，位置在 {"point": [5, 9]} 这里'), { kind: 'point', x: 5, y: 9, label: '' });
  assert.deepEqual(parseGrounding('[640, 320]'), { kind: 'point', x: 640, y: 320, label: '' });
  // Gemma-style boxes are [y1, x1, y2, x2].
  assert.deepEqual(parseGrounding('{"box_2d": [10, 20, 110, 220], "label": "a"}'), { kind: 'box', x: 20, y: 10, w: 200, h: 100, label: 'a' });
  // Qwen computer-use tool call.
  assert.deepEqual(parseGrounding('<tool_call>\n{"name": "computer_use", "arguments": {"action": "left_click", "coordinate": [511, 77]}}\n</tool_call>'), { kind: 'point', x: 511, y: 77, label: '' });
  assert.deepEqual(parseGrounding('the button is at (300, 420).'), { kind: 'point', x: 300, y: 420, label: '' });
  assert.equal(parseGrounding('I cannot find it.'), null);
  assert.equal(parseGrounding(''), null);
  assert.equal(parseGrounding('{"point_2d": null, "label": "x"}'), null);
});

test('groundingToPixels maps the 0-1000 grid to the referent image and rejects nonsense', () => {
  const sent = { w: 1024, h: 1024 }, target = { w: 800, h: 400 };
  assert.deepEqual(groundingToPixels({ kind: 'point', x: 500, y: 250, label: 'a' }, sent, target), { kind: 'point', x: 400, y: 100, label: 'a' });
  assert.deepEqual(groundingToPixels({ kind: 'box', x: 100, y: 500, w: 200, h: 100, label: '' }, sent, target), { kind: 'box', x: 80, y: 200, w: 160, h: 40, label: '' });
  // Values above 1000 can only be pixels of the image the model saw.
  assert.deepEqual(groundingToPixels({ kind: 'point', x: 1010, y: 512, label: '' }, sent, target), { kind: 'point', x: 789, y: 200, label: '' });
  // Slightly outside is clamped, far outside is dropped.
  assert.deepEqual(groundingToPixels({ kind: 'point', x: -8, y: 1000, label: '' }, sent, target), { kind: 'point', x: 0, y: 400, label: '' });
  assert.equal(groundingToPixels({ kind: 'point', x: 5000, y: 100, label: '' }, sent, target), null);
  assert.equal(groundingToPixels(null, sent, target), null);
});

test('groundingSize enlarges small crops to about a megapixel in multiples of 32', () => {
  const a = groundingSize(640, 384);
  assert.equal(a.w % 32, 0);
  assert.equal(a.h % 32, 0);
  assert.ok(a.w * a.h > 900_000 && a.w * a.h < 1_250_000, JSON.stringify(a));
  const tiny = groundingSize(120, 40); // never more than 4x
  assert.ok(tiny.w <= 480 && tiny.h <= 160, JSON.stringify(tiny));
  const big = groundingSize(1024, 640); // already large: stays about the same
  assert.ok(big.w >= 1024 && big.w <= 1344, JSON.stringify(big));
  const wide = groundingSize(1024, 64);
  assert.ok(wide.w <= 1792 && wide.h >= 32, JSON.stringify(wide));
});

test('grounding prompt follows the language of the question and strips nothing it needs', () => {
  const zh = buildGroundingMessages({ question: '哪个更便宜？', answer: '@2 更便宜。', dataUrl: 'data:image/png;base64,AAAA' });
  assert.equal(zh[0].content[0].type, 'image_url');
  assert.match(zh[0].content[1].text, /point_2d/);
  assert.match(zh[0].content[1].text, /只输出 JSON/);
  const en = buildGroundingMessages({ question: 'which is cheaper?', answer: '@2 is cheaper.', dataUrl: 'data:image/png;base64,AAAA' });
  assert.match(en[0].content[1].text, /Output JSON only/);
  const stripped = stripImages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'q' }] }, { role: 'assistant', content: 'a' }]);
  assert.deepEqual(stripped[0].content.map((p) => p.type), ['text', 'text']);
  assert.equal(stripped[1].content, 'a');
});

// ---------------------------------------------------------------- one-pass replies
import { PointerReplyFilter, splitPointerReply } from '../src/core/pointer-reply.js';

function filterRun(full, size) {
  let shown = '';
  const f = new PointerReplyFilter((t) => (shown += t));
  for (let i = 0; i < full.length; i += size) f.push(full.slice(i, i + size));
  const end = f.finish(); // may release held-back text, so read `shown` afterwards
  return { shown, ...end };
}

test('PointerReplyFilter shows the answer as it streams and never the JSON line', () => {
  const json = '{"ref": "@2", "point_2d": [217, 602], "label": "¥ 3,899"}';
  const full = `@2 更便宜，便宜 400 元。\n两年保修的是 @1。\n${json}`;
  for (const size of [1, 2, 3, 5, 9, 200]) {
    const r = filterRun(full, size);
    assert.equal(r.shown, '@2 更便宜，便宜 400 元。\n两年保修的是 @1。', `chunk ${size}`);
    assert.equal(r.json, json);
    assert.equal(r.answer, r.shown);
  }
});

test('PointerReplyFilter releases everything when the model did not add a point', () => {
  for (const size of [1, 4, 50]) {
    assert.equal(filterRun('第一行。\n第二行。', size).shown, '第一行。\n第二行。');
    assert.equal(filterRun('code: {a: 1}\n{not json at all', size).shown, 'code: {a: 1}\n{not json at all');
    assert.equal(filterRun('答案。\n', size).shown, '答案。');
  }
  // A reply that is only the JSON line shows nothing and still yields the point.
  const only = filterRun('{"ref": "@1", "point_2d": [5, 9], "label": "x"}', 3);
  assert.equal(only.shown, '');
  assert.match(only.json, /point_2d/);
  assert.deepEqual(splitPointerReply('没有坐标。'), { answer: '没有坐标。', json: '' });
});

test('PointerReplyFilter keeps the JSON line hidden when a line break or spaces follow it', () => {
  const json = '{"ref": "@1", "point_2d": [500, 500], "label": "x"}';
  for (const tail of ['\n', '\r\n', '  \n\n', ' ']) {
    for (const size of [1, 3, 7, 200]) {
      const r = filterRun(`答案。\n${json}${tail}`, size);
      assert.equal(r.shown, '答案。', `tail ${JSON.stringify(tail)} chunk ${size}`);
      assert.equal(r.json, json);
    }
  }
  // A line that merely starts with a brace, followed by more answer, is released in full.
  assert.equal(filterRun('配置如下：\n{ "a": 1 }\n改成 2 即可。', 2).shown, '配置如下：\n{ "a": 1 }\n改成 2 即可。');
});

// ---------------------------------------------------------------- the conversation window
import { Thread } from '../src/core/thread.js';

const ref = (handle) => ({ handle });
const userTurn = (text, handles) => ({ role: 'user', content: [...handles.flatMap((h) => [{ type: 'text', text: `${h}：` }, { type: 'image_url', image_url: { url: `data:${h}` } }]), { type: 'text', text }] });
const imagesIn = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url').map((p) => p.image_url.url.slice(5));
/** Play one question against a Thread the way LocalBrain does; returns what would be sent. */
function playTurn(thread, text, refs = []) {
  const plan = thread.plan(refs);
  const message = userTurn(text, plan.attach.map((r) => r.handle));
  const images = imagesIn([...plan.history, message]);
  thread.commit(message, `answer to ${text}`, plan.attach, plan.targets);
  return { plan, images, attach: plan.attach.map((r) => r.handle), known: plan.known.map((r) => r.handle), targets: plan.targets.map((r) => r.handle) };
}

test('Thread: follow-ups never lose the screenshot they are about', () => {
  const t = new Thread();
  assert.deepEqual(playTurn(t, 'q1', [ref('@1')]).attach, ['@1']);
  // Follow-up after follow-up: the model must still be looking at @1 every time.
  for (let i = 2; i <= 9; i++) {
    const r = playTurn(t, `q${i}`);
    assert.deepEqual(r.images, ['@1'], `question ${i} is sent with the screenshot of @1`);
    assert.deepEqual(r.targets, ['@1'], `an answer to question ${i} may point at @1`);
  }
  // Somewhere along the way the first turn fell out of the window and @1 was attached again.
  assert.ok(t.entries.filter((e) => e.handles.includes('@1')).length >= 2);
});

test('Thread: a referent already in the window is mentioned, one that fell out is attached again', () => {
  const t = new Thread();
  playTurn(t, 'what is this', [ref('@1')]);
  const second = playTurn(t, 'and compared with this one?', [ref('@2')]);
  assert.deepEqual(second.attach, ['@2']);
  assert.deepEqual(second.images, ['@1', '@2'], 'the turn before keeps its screenshot, so the two can be compared');
  assert.ok(second.plan.visible.has('@1') && second.plan.visible.has('@2'));
  const third = playTurn(t, 'again about the first', [ref('@1')]);
  assert.deepEqual(third.attach, ['@1'], '@1 is no longer in the window (only the last exchange keeps images)');
  assert.deepEqual(third.images, ['@2', '@1']);
  const fourth = playTurn(t, 'and once more', [ref('@1')]);
  assert.deepEqual([fourth.attach, fourth.known], [[], ['@1']], 'still in the window: named in words, not sent twice');
});

test('Thread: clear keeps the topic, reset starts a new conversation', () => {
  const t = new Thread();
  playTurn(t, 'q1', [ref('@1')]);
  const gen = t.generation;
  t.clear(); // the context overflowed: history is gone, the topic is not
  assert.equal(t.generation, gen);
  assert.deepEqual(playTurn(t, 'q2').attach, ['@1'], 'the follow-up carries the screenshot again');
  t.reset();
  assert.notEqual(t.generation, gen);
  const fresh = playTurn(t, 'q3');
  assert.deepEqual([fresh.attach, fresh.targets, fresh.images], [[], [], []]);
});

// ---------------------------------------------------------------- judging real answers
import { whichIsCheaper } from '../src/core/judge.js';

test('whichIsCheaper reads the verdict, not just which names appear', () => {
  const A = /星河|4,?299|@3(?!\d)/, B = /山岚|3,?899|@4(?!\d)/;
  const says = (t) => whichIsCheaper(t, A, B);
  assert.equal(says('@4 山岚 15 全能本 更便宜。'), 'B');
  assert.equal(says('@3 的 ¥4,299 比 @4 的 ¥3,899 贵，所以 @4 更便宜'), 'B');
  assert.equal(says('山岚 15 比星河 14 便宜 400 元。'), 'B');
  assert.equal(says('星河 14 更贵，价格是 ¥4,299。'), 'B');
  assert.equal(says('¥4,299 比山岚便宜'), 'A');
  assert.equal(says('@3 星河 14 轻薄本更便宜。'), 'A');
  assert.equal(says('两款都是笔记本电脑。'), null);
  assert.equal(says('The second one, @4, is cheaper.'), 'B');
});
