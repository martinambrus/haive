/** The CWE id a security finding carries, normalized — and the one question the
 *  codebase actually asks of it.
 *
 *  Reviewers are prompted for `"cwe": "id or n/a"` and answer with whatever they
 *  like: `CWE-89`, `89`, `cwe_89`, `CWE-089`, `n/a`, or a sentence. It was stored
 *  verbatim and used only as a label, which was harmless while nothing branched on
 *  it. `isCredentialCwe` branches on it, so the spelling has to be settled first.
 *
 *  Deliberately NO CWE catalog. The official claude-security plugin ships the
 *  Simplified Mapping view (~30 KB) and derives a finding's category from it,
 *  which earns its place there because dedup runs across a component x category
 *  researcher matrix. Here 2-6 reviewers look at one diff, so category grouping
 *  would buy little against a standing obligation to track CWE releases.
 */

/** The CWE spelling every stored finding uses, or null when the reviewer named none.
 *
 *  Accepts what reviewers actually emit and refuses everything else: `n/a`, prose, and
 *  `CWE-0` all answer null, because a wrong id read as a real one is worse than no id.
 *  Mirrors the plugin's `finding.py:cwe_number`, minus its refusal-by-exception. */
export function normalizeCweId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const declared = raw.trim().toUpperCase().replace(/_/g, '-');
  const matched = /^(?:CWE-)?0*([1-9][0-9]{0,4})$/.exec(declared);
  return matched ? `CWE-${matched[1]}` : null;
}

/** Weaknesses whose finding quotes the credential itself.
 *
 *  CWE-798 (Use of Hard-coded Credentials) and the ids the plugin's Simplified
 *  Mapping rolls up to it, plus the cleartext-storage and cleartext-transmission
 *  families — for all of them the line a reviewer quotes as evidence IS the secret.
 */
const CREDENTIAL_CWES = new Set([
  256, 259, 260, 312, 313, 315, 316, 317, 318, 321, 522, 523, 526, 540, 549, 555, 615, 671, 798,
]);

/** Does a finding with this CWE quote a credential as its evidence?
 *
 *  The one thing the id is asked to decide. A finding's file, line and symbol locate
 *  the code perfectly well without the line's text, so for these the quoted snippet is
 *  dropped before the finding is persisted (see `_review-findings.ts`).
 */
export function isCredentialCwe(rawCweId: unknown): boolean {
  const normalized = normalizeCweId(rawCweId);
  return normalized !== null && CREDENTIAL_CWES.has(Number(normalized.slice(4)));
}
