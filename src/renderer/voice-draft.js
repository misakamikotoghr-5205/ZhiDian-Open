// Insert dictation without replacing any existing draft, including text edited while the
// transcription request was running. Textarea maxlength counts UTF-16 code units.
export function insertDictation(value, transcript, { at = value.length, maxLength = 2000 } = {}) {
  value = String(value ?? '');
  const text = String(transcript ?? '').trim();
  at = Math.max(0, Math.min(value.length, Number.isFinite(at) ? at : value.length));
  // Never insert into the middle of a surrogate pair.
  if (at > 0 && at < value.length && /[\uD800-\uDBFF]/.test(value[at - 1]) && /[\uDC00-\uDFFF]/.test(value[at])) at++;
  const before = value.slice(0, at), after = value.slice(at);
  const left = before && !/\s$/.test(before) ? '\n' : '';
  const right = after && !/^\s/.test(after) ? '\n' : '';
  const room = Math.max(0, maxLength - value.length - left.length - right.length);
  let addition = text.slice(0, room);
  if (/[\uD800-\uDBFF]$/.test(addition)) addition = addition.slice(0, -1);
  if (!addition) return { value, caret: at, inserted: '', truncated: Boolean(text) };
  const inserted = left + addition + right;
  return { value: before + inserted + after, caret: before.length + left.length + addition.length, inserted: addition, truncated: addition.length < text.length };
}
