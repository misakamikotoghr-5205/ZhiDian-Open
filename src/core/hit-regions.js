// Renderer rectangles are CSS pixels; the desktop cursor and content bounds are Electron
// DIPs. Windows display scaling is already handled by Electron, so only page zoom belongs here.
export function normalizeHitRegions(rects) {
  if (!Array.isArray(rects)) return [];
  return rects.filter((r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0)
    .slice(0, 40).map(({ x, y, w, h }) => ({ x, y, w, h }));
}

export function hitRegions(rects, cursor, origin, zoomFactor = 1) {
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const x = (cursor.x - origin.x) / zoom, y = (cursor.y - origin.y) / zoom;
  return { x, y, hit: rects.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h) };
}

/** Hover must allow activation, but never activate the overlay on its own. A focused input
 * keeps the keyboard even if the user moves the mouse outside its panel; a real outside click
 * goes through and gives focus back to the underlying application normally. */
export function overlayFocusable({ pointing, clickThrough, focused }) {
  return Boolean(pointing || !clickThrough || focused);
}
