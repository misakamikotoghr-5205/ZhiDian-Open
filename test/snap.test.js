import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapLadder, expand, seedPoint, uniformColor } from '../src/core/snap.js';
import { makeImage, fill, stroke, textBlock, approx } from './helpers.js';

function page() {
  // Light page with two bordered cards, each holding a paragraph of fake text.
  const img = makeImage(900, 600, [245, 245, 247]);
  const cardA = { x: 60, y: 80, w: 330, h: 150 };
  const cardB = { x: 450, y: 80, w: 330, h: 150 };
  for (const c of [cardA, cardB]) {
    fill(img, c.x, c.y, c.w, c.h, [255, 255, 255]);
    stroke(img, c.x, c.y, c.w, c.h, [210, 210, 215]);
  }
  const wordsA = textBlock(img, cardA.x + 20, cardA.y + 20, { lines: 3, wordsPerLine: 5 });
  const wordsB = textBlock(img, cardB.x + 20, cardB.y + 20, { lines: 2, wordsPerLine: 4 });
  return { img, cardA, cardB, wordsA, wordsB };
}

test('uniformColor detects flat and non-flat regions', () => {
  const img = makeImage(50, 50, [10, 20, 30]);
  assert.deepEqual(uniformColor(img, 0, 0, 49, 49, 6), [10, 20, 30]);
  fill(img, 25, 25, 1, 1, [200, 0, 0]);
  assert.equal(uniformColor(img, 0, 0, 49, 49, 6), null);
  assert.ok(uniformColor(img, 0, 0, 24, 24, 6));
});

test('smallest gap isolates a single word', () => {
  const { img, wordsA } = page();
  const w = wordsA[1][2];
  const { bands, ...b } = expand(img, w.x + 10, w.y + 6, 3);
  assert.ok(bands.t && bands.l);
  assert.ok(approx(b, w), `got ${JSON.stringify(b)} want ${JSON.stringify(w)}`);
});

test('ladder walks word, line, paragraph, card and ends with the screen', () => {
  const { img, cardA, wordsA } = page();
  const w = wordsA[1][2];
  const { boxes, defaultIndex } = snapLadder(img, w.x + 10, w.y + 6);
  const line = { x: wordsA[1][0].x, y: w.y, w: 5 * 40 + 4 * 5, h: 12 };
  const para = { x: wordsA[0][0].x, y: wordsA[0][0].y, w: line.w, h: 3 * 12 + 2 * 8 };
  assert.ok(boxes.some((b) => approx(b, w)), 'word level');
  assert.ok(boxes.some((b) => approx(b, line)), 'line level');
  assert.ok(boxes.some((b) => approx(b, para)), 'paragraph level');
  assert.ok(boxes.some((b) => approx(b, cardA)), `card level: ${JSON.stringify(boxes)}`);
  assert.equal(boxes.at(-1).kind, 'screen');
  // Boxes grow monotonically.
  for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].w * boxes[i].h >= boxes[i - 1].w * boxes[i - 1].h);
  // The default is bigger than one word.
  assert.ok(boxes[defaultIndex].w > w.w + 4);
});

test('a card stays separate from its neighbour', () => {
  const { img, cardB, wordsB } = page();
  const w = wordsB[0][0];
  const { boxes } = snapLadder(img, w.x + 5, w.y + 5);
  const card = boxes.find((b) => approx(b, cardB));
  assert.ok(card, JSON.stringify(boxes));
});

test('cursor on empty background grabs the nearest content', () => {
  const { img, wordsA } = page();
  const last = wordsA[2][4];
  // 30 px to the right of the last word of the last line, inside the card padding.
  const s = seedPoint(img, last.x + last.w + 30, last.y + 6);
  assert.equal(s.moved, true);
  assert.ok(s.x >= last.x && s.x <= last.x + last.w + 1, JSON.stringify(s));
  const { boxes } = snapLadder(img, last.x + last.w + 30, last.y + 6);
  assert.ok(boxes.some((b) => approx(b, last)));
});

test('nothing nearby falls back to a window centred on the cursor', () => {
  const img = makeImage(1200, 800, [20, 20, 24]);
  const { boxes } = snapLadder(img, 600, 400);
  assert.equal(boxes[0].kind, 'window');
  assert.equal(boxes[0].x + boxes[0].w / 2, 600);
  assert.equal(boxes.at(-1).kind, 'screen');
});

test('works on a dark theme with a borderless card', () => {
  const img = makeImage(800, 500, [18, 18, 22]);
  const card = { x: 100, y: 100, w: 300, h: 160 };
  fill(img, card.x, card.y, card.w, card.h, [34, 34, 40]);
  const words = textBlock(img, card.x + 24, card.y + 24, { color: [230, 230, 235] });
  const { boxes } = snapLadder(img, words[0][0].x + 4, words[0][0].y + 4);
  assert.ok(boxes.some((b) => approx(b, card)), JSON.stringify(boxes));
});

test('a photo-like region is captured whole', () => {
  const img = makeImage(700, 500, [255, 255, 255]);
  const photo = { x: 200, y: 120, w: 240, h: 180 };
  for (let y = 0; y < photo.h; y++) {
    for (let x = 0; x < photo.w; x++) {
      fill(img, photo.x + x, photo.y + y, 1, 1, [(x * 7 + y * 3) % 256, (x * 2 + y * 11) % 256, (x + y) % 256]);
    }
  }
  const { boxes } = snapLadder(img, photo.x + 100, photo.y + 90);
  assert.ok(approx(boxes[0], photo, 3), JSON.stringify(boxes[0]));
});

test('stays inside the image at the corners', () => {
  const { img } = page();
  for (const [x, y] of [[0, 0], [899, 599], [0, 599], [899, 0], [5000, -40]]) {
    const { boxes } = snapLadder(img, x, y);
    for (const b of boxes) {
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 900 && b.y + b.h <= 600, JSON.stringify(b));
    }
  }
});

test('runs fast enough to follow the mouse', () => {
  const { img, wordsA } = page();
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) snapLadder(img, wordsA[0][0].x + i, wordsA[0][0].y + 5);
  const per = (performance.now() - t0) / 40;
  assert.ok(per < 30, `snapLadder took ${per.toFixed(1)} ms`);
});

test('regions: a flat card is boxed exactly even when its neighbour is closer than its padding', async () => {
  const { regionBox } = await import('../src/core/snap.js');
  const img = makeImage(900, 500, [244, 245, 247]);
  const a = { x: 40, y: 60, w: 380, h: 220 }, b = { x: 440, y: 60, w: 380, h: 220 }; // 20 px apart, 30 px padding
  for (const c of [a, b]) {
    fill(img, c.x, c.y, c.w, c.h, [255, 255, 255]);
    stroke(img, c.x, c.y, c.w, c.h, [223, 226, 232]);
  }
  const words = textBlock(img, a.x + 30, a.y + 30, { lines: 2, wordsPerLine: 4 });
  const r = regionBox(img, a.x + 200, a.y + 150);
  assert.ok(approx(r, a, 1), JSON.stringify(r));
  // The ladder from a word inside the card contains the card, not the pair of cards.
  const { boxes, defaultIndex } = snapLadder(img, words[0][1].x + 6, words[0][1].y + 5);
  assert.ok(boxes.some((x) => approx(x, a, 1)), JSON.stringify(boxes));
  assert.ok(boxes[defaultIndex].w < a.w, 'pointing at text defaults to the text, not the card');
  // Empty space well inside the card defaults to the card itself.
  const empty = snapLadder(img, a.x + 300, a.y + 170);
  assert.ok(approx(empty.boxes[empty.defaultIndex], a, 1), JSON.stringify(empty.boxes[empty.defaultIndex]));
  // The page background is not a container.
  assert.equal(regionBox(img, 5, 5), null);
});
