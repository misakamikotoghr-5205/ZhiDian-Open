// Turn the line a model ends its answer with ({"ref": "@2", "point_2d": [x, y], "label": ...})
// into the tag the overlay understands.
import { groundingToPixels, parseGrounding } from './grounding.js';

/**
 * Coordinates are relative to the screenshot the model names, so the name decides where the mark
 * lands: it is used when it is one of the screenshots the model was actually shown this turn,
 * including one from the turn before. A name that fits nothing is ignored when there is only one
 * screenshot it could mean, and the pointer is dropped when there are several.
 *
 * @param {string} json                 the model's line
 * @param {object[]} targets            what an answer to this turn may point at
 * @param {Set<string>} visible         handles of every screenshot the model saw this turn
 * @param {(handle: string) => object|null} [resolve]  look up a referent by handle
 * @returns {string} a [[point ...]] tag, or '' when there is nothing sound to point at
 */
export function pointTag(json, targets, visible, resolve) {
  const named = /"ref"\s*:\s*"\s*(@\d+)/.exec(json)?.[1];
  let ref = null;
  if (named && visible.has(named)) ref = targets.find((r) => r.handle === named) ?? resolve?.(named) ?? null;
  if (!ref && (!named || visible.size <= 1 || targets.length === 1)) ref = targets[0] ?? null;
  if (!ref) return '';
  const px = groundingToPixels(parseGrounding(json), ref.imageSize, ref.imageSize);
  if (!px) return '';
  const label = String(px.label ?? '').replace(/[|\]\[\n]/g, ' ').trim().slice(0, 24);
  return `[[point ${ref.handle} ${px.x} ${px.y} | ${label}]]`;
}
