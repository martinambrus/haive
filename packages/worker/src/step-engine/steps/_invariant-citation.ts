/** Tell a reviewer to name the project rule a change breaks, not just the line that breaks it.
 *
 *  Haive already requires evidence FOR a defect — "CITE OR DROP. Every issue you file must
 *  carry the file:line that proves it" (07b), "Cite the line you actually read" (08c). That is
 *  a different axis from this one: those point at the offending CODE, this points at the
 *  documented RULE the code violates.
 *
 *  MEASURED across 8,774 public pull requests and 34,258 reviewer findings (2026-09): a hosted
 *  reviewer cites the repository's own invariants document at a rate that tracks the document's
 *  size — 1% of findings where the repo has none, 24% under 10 KB, 37% at 10 KB or more — and,
 *  holding PR size constant, repos carrying a large one receive 31% to 50% MORE findings per PR
 *  in every size band. The direction is consistent; the causation is not established, since a
 *  project that maintains such a document differs from one that does not in ways the corpus
 *  cannot control for. What the corpus does establish is that the document is READ, which is
 *  what makes asking for the citation worth the prompt space.
 *
 *  Haive generates exactly such a document during onboarding (the knowledge base under
 *  `KB_DIR`), so on an onboarded repository this instruction has something to point at. On one
 *  without, the final paragraph is what keeps it from doing harm.
 *
 *  Appended AFTER the persona at every site, for the reason `dimensionScopeOverride` documents:
 *  an on-disk `.claude/agents/<id>.md` OUTRANKS the inline persona and its bytes are hashed
 *  against a reference render, so editing the inline copy alone changes nothing for an
 *  onboarded repo and editing the file would read as drift and be reverted.
 *
 *  Deliberately NOT applied to 08d's adversaries. They are attack roles hunting for a way to
 *  break the change, not dimension scorers arguing a defect against a stated contract; the
 *  evidence here is about the latter and does not extend to the former.
 */
export const INVARIANT_CITATION = [
  "GROUND FINDINGS IN THE PROJECT'S OWN RULES. This is IN ADDITION to the file:line of the",
  'offending code, never a replacement for it.',
  '',
  'Many projects state their invariants in their own documentation - AGENTS.md, CLAUDE.md, a',
  'knowledge base, an architecture or contributing guide. When the change breaks a rule one of',
  'those documents states, cite it: name the file and the line range that says so (for example',
  '`AGENTS.md:L120-L134`) and quote the clause you are relying on.',
  '',
  'A finding that names the violated rule is actionable without argument. One that asserts a',
  'convention from memory is an opinion the author can decline, however right it is.',
  '',
  'NEVER INVENT A CITATION. If no document in this repository states the rule, say so plainly',
  'and argue the finding on its own merits. A fabricated reference is worse than none: it sends',
  'the reader to a line that does not support the claim, and it discredits every finding beside',
  'it.',
].join('\n');
