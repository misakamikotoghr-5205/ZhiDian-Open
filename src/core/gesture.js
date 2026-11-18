// Optional "wiggle to summon": a quick left-right shake of the cursor. Pure and time-injected so
// it can be tested without a clock. Off by default because a shake that fires by accident is worse
// than a hotkey nobody has to discover.

export class WiggleDetector {
  constructor({ windowMs = 650, minReversals = 4, minSegment = 28, cooldownMs = 1500 } = {}) {
    this.o = { windowMs, minReversals, minSegment, cooldownMs };
    this.reset();
    this.lastFire = -Infinity;
  }

  reset() {
    this.lastX = null;
    this.dir = 0;
    this.segStart = 0;
    this.reversals = []; // timestamps
  }

  /** Feed a cursor sample. Returns true exactly once when a wiggle completes. */
  push(x, _y, t) {
    if (this.lastX === null) {
      this.lastX = x;
      this.segStart = x;
      return false;
    }
    const dx = x - this.lastX;
    this.lastX = x;
    if (dx === 0) return false;
    const dir = dx > 0 ? 1 : -1;
    if (this.dir === 0) {
      this.dir = dir;
    } else if (dir !== this.dir) {
      // Direction flipped: count it only if the stroke that just ended was long enough.
      const travelled = Math.abs(x - dx - this.segStart);
      if (travelled >= this.o.minSegment) this.reversals.push(t);
      else this.reversals.length = 0;
      this.dir = dir;
      this.segStart = x - dx;
    }
    while (this.reversals.length && t - this.reversals[0] > this.o.windowMs) this.reversals.shift();
    if (this.reversals.length >= this.o.minReversals && t - this.lastFire > this.o.cooldownMs) {
      this.lastFire = t;
      this.reversals.length = 0;
      return true;
    }
    return false;
  }
}
