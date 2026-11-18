import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitRegions, normalizeHitRegions, overlayFocusable } from '../src/core/hit-regions.js';

test('interactive regions reject invalid dimensions and retain valid negative monitor coordinates', () => {
  assert.deepEqual(normalizeHitRegions([
    { x: -10, y: 20, w: 120, h: 40 },
    { x: 0, y: NaN, w: 10, h: 10 }, { x: 0, y: 0, w: Infinity, h: 10 },
    { x: 0, y: 0, w: -1, h: 10 }, { x: 0, y: 0, w: 10, h: 0 }, null,
  ]), [{ x: -10, y: 20, w: 120, h: 40 }]);
});

test('hit testing maps desktop DIPs to CSS pixels using content origin and page zoom', () => {
  const rects = [{ x: 100, y: 200, w: 300, h: 100 }];
  const origin = { x: -1280, y: 100 };
  assert.deepEqual(hitRegions(rects, { x: -980, y: 475 }, origin, 1.5), { x: 200, y: 250, hit: true });
  assert.equal(hitRegions(rects, { x: -680, y: 475 }, origin, 1.5).hit, false, 'right edge belongs to the desktop');
  assert.equal(hitRegions(rects, { x: -980, y: 550 }, origin, 1.5).hit, false, 'bottom edge belongs to the desktop');
});

test('idle hover permits native activation without stealing existing keyboard focus', () => {
  assert.equal(overlayFocusable({ pointing: false, clickThrough: true, focused: false }), false);
  assert.equal(overlayFocusable({ pointing: false, clickThrough: false, focused: false }), true, 'panel can activate on a real click');
  assert.equal(overlayFocusable({ pointing: false, clickThrough: true, focused: true }), true, 'typing continues if the mouse leaves a focused input');
  assert.equal(overlayFocusable({ pointing: true, clickThrough: true, focused: false }), true);
});
