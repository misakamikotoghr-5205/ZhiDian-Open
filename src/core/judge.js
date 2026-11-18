// Small, deliberately strict checks used by the self-test to decide whether an answer from the
// real model is right. They read the answer clause by clause, because a correct answer can
// mention the wrong option too ("A costs more than B, so B is cheaper").

/**
 * Which of two things does `text` say is the cheaper one?
 * @param {string} text
 * @param {RegExp} A  matches any way of naming the first (name, price, handle)
 * @param {RegExp} B  the same for the second
 * @returns {'A' | 'B' | null}  the verdict of the last clause that gives one
 */
export function whichIsCheaper(text, A, B) {
  // Split on punctuation, but not on the comma inside a number such as 4,299.
  const clauses = String(text ?? '').split(/[，。；;！!？?\n]|,(?!\d)|\.(?!\d)/).map((c) => c.trim()).filter(Boolean);
  let verdict = null;
  let lastNamed = null; // the one thing named most recently, for "the second one, @4, is cheaper"
  for (const c of clauses) {
    const a = A.exec(c), b = B.exec(c);
    if (a || b) lastNamed = a && b ? null : a ? 'A' : 'B';
    const cheap = /便宜|划算|更低|低于|实惠|省钱|cheaper|costs less|lower/i.test(c);
    const dear = /贵|更高|高于|more expensive|costs more|pricier|higher/i.test(c);
    if (cheap === dear) continue; // says neither, or both: no verdict from this clause
    // "X 比 Y 便宜" / "X is cheaper than Y": the comparison is about whichever comes first.
    const about = a && b ? (a.index < b.index ? 'A' : 'B') : lastNamed;
    if (about) verdict = cheap ? about : about === 'A' ? 'B' : 'A';
  }
  return verdict;
}
