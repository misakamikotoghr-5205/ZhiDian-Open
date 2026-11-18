// The conversation window sent to the local model, and the one decision that goes with it:
// which screenshots have to be attached to the next question.
//
// A small model has a small context (4096 tokens here) and images are most of the cost, so only
// the recent part of a conversation is sent and older screenshots are replaced by a placeholder.
// That makes "has the model seen @1?" a question about this window, not about history: a
// screenshot that has dropped out of the window must be attached again, or the model answers
// about a picture it no longer has.
import { stripImages } from './prompt.js';

export class Thread {
  /** @param {{ maxMessages?: number }} [o] how many past messages (user + assistant) are sent */
  constructor({ maxMessages = 6 } = {}) {
    this.maxMessages = maxMessages;
    this.entries = []; // { message, handles }: handles are the screenshots attached to that message
    this.lastRefs = []; // what the most recent question with any referent was about
    this.generation = 0;
  }

  /** Forget the conversation. An answer still in flight for the old one must not be added. */
  reset() {
    this.entries = [];
    this.lastRefs = [];
    this.generation++;
  }

  /** Drop the history but stay in the same conversation (the context window overflowed). */
  clear() {
    this.entries = [];
  }

  get length() {
    return this.entries.length;
  }

  /**
   * Plan the next user turn.
   * @param {Array<{handle: string}>} refs  what this question names (empty for a follow-up)
   * @returns {{
   *   history: object[],   past messages to send, older screenshots replaced by a placeholder
   *   attach: object[],    referents whose screenshot must be sent with this turn
   *   known: object[],     referents named now whose screenshot is still in `history`
   *   targets: object[],   what an answer to this turn may point at
   *   visible: Set<string> handles of every screenshot the model will see this turn
   * }}
   */
  plan(refs = []) {
    const kept = this.entries.slice(-this.maxMessages);
    let lastWithImage = -1;
    kept.forEach((e, i) => {
      if (e.handles.length) lastWithImage = i;
    });
    // Screenshots stay in the last exchange and in the most recent turn that had any: enough to
    // compare "this" with "the one before", and an unchanged prefix for the server's cache.
    const keepFrom = Math.max(0, Math.min(lastWithImage < 0 ? kept.length : lastWithImage, kept.length - 2));
    const inWindow = new Set(kept.slice(keepFrom).flatMap((e) => e.handles));
    const history = [...stripImages(kept.slice(0, keepFrom).map((e) => e.message)), ...kept.slice(keepFrom).map((e) => e.message)];
    // A follow-up is about what was asked last.
    const targets = refs.length ? refs : this.lastRefs;
    const attach = targets.filter((r) => !inWindow.has(r.handle));
    const known = refs.filter((r) => inWindow.has(r.handle));
    const visible = new Set([...inWindow, ...attach.map((r) => r.handle)]);
    return { history, attach, known, targets, visible };
  }

  /**
   * Take over the conversation another model was having, as text. The new model has not been
   * shown any of its screenshots, so none count as seen: what the topic is about is attached to
   * its next turn, and counted as sent there.
   * @param {Thread} other
   * @param {{ dropLast?: boolean }} [o] leave out the last exchange: it is about to be asked again
   */
  adopt(other, { dropLast = false } = {}) {
    const entries = dropLast ? other.entries.slice(0, -2) : other.entries;
    this.entries = stripImages(entries.map((e) => e.message)).map((message) => ({ message, handles: [] }));
    this.lastRefs = other.lastRefs;
  }

  /** Record a finished exchange. `attached` are the referents whose screenshots were in `userMessage`. */
  commit(userMessage, answer, attached, targets) {
    this.entries.push({ message: userMessage, handles: attached.map((r) => r.handle) }, { message: { role: 'assistant', content: answer }, handles: [] });
    if (targets.length) this.lastRefs = targets;
  }
}
